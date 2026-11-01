import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const repository = "valkyriweb/clawsweeper";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "transferred-issue-"));
  const log = join(root, "gh.log");
  mkdirSync(join(root, "bin"));
  mkdirSync(join(root, "items"));
  writeFileSync(
    join(root, "bin", "gh"),
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.TEST_GH_LOG, JSON.stringify(args) + "\\n");
const endpoint = args[1];
if (endpoint === "repos/${repository}/issues/321") {
  if (process.env.TEST_STATE === "404") {
    console.error("gh: Not Found (HTTP 404)"); process.exit(1);
  }
  if (process.env.TEST_STATE === "503") {
    console.error("gh: Service Unavailable (HTTP 503)"); process.exit(1);
  }
  console.log(JSON.stringify({
    number: Number(process.env.TEST_NUMBER || 321),
    html_url: process.env.TEST_URL,
    title: "Transferred issue",
    state: "open",
    created_at: "2026-05-01T00:00:00Z",
    updated_at: "2026-05-01T00:00:00Z",
    user: {login:"reporter"}, labels: []
  }));
} else if (endpoint === "repos/${repository}") {
  if (process.env.TEST_REPO_HIDDEN === "1") {
    console.error("gh: Not Found (HTTP 404)"); process.exit(1);
  }
  console.log(JSON.stringify({default_branch:"main"}));
} else if (endpoint === "repos/${repository}/commits/main") {
  console.log(JSON.stringify({sha:"baseline"}));
} else {
  console.error("Unexpected context read or mutation: " + JSON.stringify(args));
  process.exit(1);
}
`,
    { mode: 0o755 },
  );
  return {
    root,
    run(script: string, args: string[], extraEnv: Record<string, string> = {}) {
      return spawnSync(process.execPath, [resolve(script), ...args], {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${join(root, "bin")}:${process.env.PATH}`,
          TEST_GH_LOG: log,
          TEST_URL: "https://github.com/example/destination/issues/321",
          TARGET_REPO: repository,
          ITEM_NUMBER: "321",
          ...extraEnv,
        },
      });
    },
    calls: () =>
      readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
  };
}

for (const number of [321, 1756]) {
  test(`exact planning retires a transferred issue with destination number ${number}`, () => {
    const f = fixture();
    try {
      const result = f.run(
        "dist/clawsweeper.js",
        [
          "plan",
          "--target-repo",
          repository,
          "--item-numbers",
          "321",
          "--items-dir",
          join(f.root, "items"),
        ],
        {
          TEST_NUMBER: String(number),
          TEST_URL: `https://github.com/example/destination/issues/${number}`,
        },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout).candidates, []);
      assert.equal(
        f.calls().some((args: string[]) => args.join(" ").includes("/comments")),
        false,
      );
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });
}

test("apply archives a transferred record without context reads or mutations", () => {
  const f = fixture();
  try {
    writeFileSync(
      join(f.root, "items", "321.md"),
      `---
repository: ${repository}
number: 321
type: issue
title: Transferred issue
review_status: complete
local_checkout_access: verified
decision: keep_open
action_taken: kept_open
item_snapshot_hash: reviewed-snapshot
---
`,
    );
    const result = f.run("dist/clawsweeper.js", [
      "apply-decisions",
      "--target-repo",
      repository,
      "--items-dir",
      join(f.root, "items"),
      "--closed-dir",
      join(f.root, "closed"),
      "--plans-dir",
      join(f.root, "plans"),
      "--report-path",
      join(f.root, "report.json"),
      "--skip-dashboard",
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(join(f.root, "items", "321.md")), false);
    assert.equal(existsSync(join(f.root, "closed", "321.md")), true);
    assert.deepEqual(
      f.calls().map((args: string[]) => args[1]),
      [`repos/${repository}/issues/321`, `repos/${repository}`],
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("publication stops before state or artifact writes for a transferred item", () => {
  const f = fixture();
  try {
    const initialized = spawnSync("git", ["init", "--quiet", f.root], { encoding: "utf8" });
    assert.equal(initialized.status, 0, initialized.stderr);
    const artifactWrite = join(f.root, "artifact-write");
    writeFileSync(
      join(f.root, "bin", "pnpm"),
      `#!/usr/bin/env node
require("node:fs").writeFileSync(${JSON.stringify(artifactWrite)}, "attempted");
console.error("Unexpected artifact application for transferred item");
process.exit(1);
`,
      { mode: 0o755 },
    );
    const result = f.run("dist/repair/publish-event-result.js", [], {
      CLAWSWEEPER_STATE_DIR: f.root,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Skipping publication/);
    assert.equal(existsSync(artifactWrite), false);
    assert.deepEqual(
      f.calls().map((args: string[]) => args[1]),
      [`repos/${repository}/issues/321`],
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

for (const entry of [
  {
    name: "same identity",
    env: { TEST_URL: `https://github.com/Valkyriweb/ClawSweeper/issues/321` },
    state: "open",
  },
  { name: "same-number transfer", env: {}, state: "missing" },
  { name: "deleted item in readable repository", env: { TEST_STATE: "404" }, state: "missing" },
  { name: "hidden repository", env: { TEST_STATE: "404", TEST_REPO_HIDDEN: "1" } },
  { name: "transient API failure", env: { TEST_STATE: "503" } },
  { name: "invalid identity", env: { TEST_URL: "not a URL" } },
]) {
  test(`workflow live check handles ${entry.name}`, () => {
    const f = fixture();
    try {
      const result = f.run("dist/repair/workflow-utils.js", ["exact-review-live-item"], entry.env);
      if (entry.state) {
        assert.equal(result.status, 0, result.stderr);
        assert.equal(JSON.parse(result.stdout).state, entry.state);
      } else {
        assert.notEqual(result.status, 0);
        assert.equal(result.stdout, "");
      }
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });
}
