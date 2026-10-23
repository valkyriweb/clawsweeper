import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { type AddressInfo, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import { publishCheckFromReport } from "../dist/commit-checks.js";

// Hermetic check-run publishing: a local emulate GitHub server (no network,
// no real token) stands in for api.github.com, and a tiny `gh api` shim
// forwards the calls publishCheckFromReport makes.
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const token = "gho_clawsweeper_emulate_test";
const owner = "example-org";
const repo = "target";
const checkName = "ClawSweeper commit review";
let baseUrl = "";
let headSha = "";
let workDir = "";
let emulator: ReturnType<typeof spawn> | undefined;

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      // SAFETY: a TCP server listening on 127.0.0.1 always reports an AddressInfo.
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

async function github(path: string): Promise<any> {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { authorization: `token ${token}` },
  });
  assert.equal(response.ok, true, `${path} -> HTTP ${response.status}`);
  return await response.json();
}

function writeReport(name: string, frontMatter: string, body: string): string {
  const path = join(workDir, `${name}.md`);
  writeFileSync(path, `---\n${frontMatter}\n---\n# Report\n\n${body}\n`, "utf8");
  return path;
}

function publish(reportPath: string): void {
  publishCheckFromReport({
    targetRepo: `${owner}/${repo}`,
    reportRepo: "example-org/clawsweeper-state",
    reportPath,
    reportRelativePath: "records/example.md",
    sha: headSha,
    checkName,
  });
}

before(async () => {
  workDir = mkdtempSync(join(tmpdir(), "clawsweeper-emulate-"));
  const seedPath = join(workDir, "seed.json");
  writeFileSync(
    seedPath,
    JSON.stringify({
      tokens: { [token]: { login: "clawsweeper-bot", scopes: ["repo"] } },
      github: {
        users: [{ login: "clawsweeper-bot" }],
        orgs: [{ login: owner, members: [{ login: "clawsweeper-bot", role: "admin" }] }],
        repos: [{ owner, name: repo, auto_init: true }],
      },
    }),
  );
  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  emulator = spawn(
    process.execPath,
    [
      join(repoRoot, "node_modules/emulate/dist/index.js"),
      "start",
      "--service",
      "github",
      "--port",
      String(port),
      "--seed",
      seedPath,
    ],
    { stdio: "ignore" },
  );
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/repos/${owner}/${repo}/commits/main`, {
        headers: { authorization: `token ${token}` },
      });
      if (response.ok) {
        // SAFETY: GET /repos/:owner/:repo/commits/:ref returns a commit object with a sha.
        headSha = ((await response.json()) as { sha: string }).sha;
        break;
      }
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.match(headSha, /^[0-9a-f]{40}$/, "emulator did not start");
  process.env.GH_BIN = process.execPath;
  process.env.GH_BIN_ARGS = JSON.stringify([join(repoRoot, "test/fixtures/gh-emulate.mjs")]);
  process.env.EMULATE_GITHUB_URL = baseUrl;
  process.env.EMULATE_GITHUB_TOKEN = token;
});

after(() => {
  emulator?.kill();
  rmSync(workDir, { recursive: true, force: true });
  delete process.env.GH_BIN;
  delete process.env.GH_BIN_ARGS;
  delete process.env.EMULATE_GITHUB_URL;
  delete process.env.EMULATE_GITHUB_TOKEN;
});

test("publishCheckFromReport creates one check run, then updates it in place", async () => {
  publish(
    writeReport("first", "result: findings\nhighest_severity: high", "A high-severity finding."),
  );
  const runsPath = `/repos/${owner}/${repo}/commits/${headSha}/check-runs?filter=all&check_name=${encodeURIComponent(checkName)}`;
  let runs = await github(runsPath);
  assert.equal(runs.total_count, 1);
  assert.equal(runs.check_runs[0].conclusion, "failure");
  assert.equal(runs.check_runs[0].output.title, "Commit review: findings");
  assert.equal(
    runs.check_runs[0].details_url,
    "https://github.com/example-org/clawsweeper-state/blob/main/records/example.md",
  );

  publish(writeReport("second", "result: nothing_found", "Nothing found."));
  runs = await github(runsPath);
  assert.equal(runs.total_count, 1, "re-publishing must PATCH, not create a duplicate");
  assert.equal(runs.check_runs[0].conclusion, "success");
  assert.equal(runs.check_runs[0].output.title, "Commit review: nothing found");
});

test("publishCheckFromReport surfaces GitHub errors for an unknown commit", () => {
  const reportPath = writeReport("third", "result: nothing_found", "Nothing found.");
  assert.throws(() =>
    publishCheckFromReport({
      targetRepo: `${owner}/missing-repo`,
      reportRepo: "example-org/clawsweeper-state",
      reportPath,
      reportRelativePath: "records/example.md",
      sha: headSha,
      checkName,
    }),
  );
});
