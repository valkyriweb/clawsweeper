import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

for (const flag of ["--item-number", "--item-numbers"]) {
  for (const kind of ["issue", "pull_request"]) {
    test(`exact ${kind} review with ${flag} succeeds when the target closes during setup`, (t) => {
      const root = mkdtempSync(join(tmpdir(), "clawsweeper-review-selection-"));
      t.after(() => rmSync(root, { recursive: true, force: true }));
      const gh = join(root, "gh.cjs");
      const git = join(root, "git.cjs");
      const calls = join(root, "gh-calls.jsonl");
      const state = join(root, "state");
      const artifacts = join(root, "artifacts");
      writeFileSync(state, "open");
      writeFileSync(
        gh,
        `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + "\\n");
if (args[0] === "release" && args[1] === "view") {
  process.stdout.write("null");
} else if (args[0] === "api" && args[1] === "repos/valkyriweb/clawsweeper") {
  process.stdout.write(JSON.stringify({default_branch: "main"}));
} else if (args[0] === "api" && args[1] === "repos/valkyriweb/clawsweeper/branches/main") {
  process.stdout.write(JSON.stringify({sha: "a".repeat(40)}));
} else if (args[0] === "api" && args[1] === "repos/valkyriweb/clawsweeper/issues/42") {
  process.stdout.write(JSON.stringify({
    number: 42, title: "Exact review target",
    html_url: "https://github.com/valkyriweb/clawsweeper/issues/42",
    created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-25T00:00:00Z",
    state: fs.readFileSync(${JSON.stringify(state)}, "utf8"),
    user: {login: "contributor"}, author_association: "CONTRIBUTOR", labels: [],
    pull_request: ${kind === "pull_request" ? "{}" : "null"}
  }));
} else {
  throw new Error("Unexpected GitHub call: " + JSON.stringify(args));
}
`,
      );
      writeFileSync(
        git,
        `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "fetch") process.exit(0);
if (args[0] !== "rev-parse" || args[1] !== "origin/main") {
  throw new Error("Unexpected git call: " + JSON.stringify(args));
}
process.stdout.write("a".repeat(40));
`,
      );
      chmodSync(gh, 0o755);
      chmodSync(git, 0o755);
      const run = (command: string) =>
        spawnSync(
          process.execPath,
          [
            resolve("dist/clawsweeper.js"),
            command,
            "--target-repo",
            "valkyriweb/clawsweeper",
            flag,
            "42",
            "--target-dir",
            root,
            "--items-dir",
            join(root, "items"),
            "--artifact-dir",
            artifacts,
          ],
          {
            encoding: "utf8",
            env: { ...process.env, GH_BIN: gh, GH_BIN_ARGS: "[]", GIT_BIN: git },
          },
        );

      const plan = run("plan");
      assert.equal(plan.status, 0, plan.stderr);
      assert.deepEqual(JSON.parse(plan.stdout).matrix, [{ shard: 0, item_numbers: "42" }]);
      writeFileSync(state, "closed");
      const review = run("review");
      assert.equal(review.status, 0, review.stderr);
      assert.match(review.stderr, /complete reviewed=0/);
      assert.deepEqual(JSON.parse(readFileSync(join(artifacts, "selection.json"), "utf8")), {
        shardIndex: 0,
        shardCount: 1,
        scannedPages: 0,
        candidates: [],
        reviewPolicy: JSON.parse(plan.stdout).reviewPolicy,
      });
      assert.deepEqual(readdirSync(artifacts), ["selection.json"]);
      const githubCalls: string[][] = readFileSync(calls, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.equal(
        githubCalls.filter((args) => args[1] === "repos/valkyriweb/clawsweeper/issues/42").length,
        2,
      );
    });
  }
}
