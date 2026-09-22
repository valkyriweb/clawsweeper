import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { assertRepairPublishScope } from "../../dist/repair/repair-publish-guard.js";
import { postRepairReviewLabelTransition } from "../../dist/repair/review-label-transition.js";

test("executor publication gate inspects real committed output and both rename paths", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "repair-publish-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8", timeout: 10000 });
  git("init", "--initial-branch=main");
  git("config", "user.name", "fixture");
  git("config", "user.email", "fixture@example.invalid");
  fs.mkdirSync(path.join(dir, "services"));
  fs.writeFileSync(path.join(dir, "services/runtime.ts"), "runtime\n");
  git("add", ".");
  git("-c", "commit.gpgsign=false", "commit", "-m", "base");
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  fs.mkdirSync(path.join(dir, "docs"));
  fs.writeFileSync(path.join(dir, "docs/guide.md"), "guide\n");
  git("add", ".");
  git("-c", "commit.gpgsign=false", "commit", "-m", "docs repair");
  assert.doesNotThrow(() => assertRepairPublishScope(dir, "main", ["docs/**/*.md"]));
  git("mv", "services/runtime.ts", "docs/runtime.md");
  git("-c", "commit.gpgsign=false", "commit", "-m", "unsafe rename");
  assert.throws(() => assertRepairPublishScope(dir, "main", ["docs/**/*.md"]), /refusing push/);
  assert.doesNotThrow(
    () => assertRepairPublishScope(dir, "main", undefined),
    "unscoped repositories retain existing capabilities",
  );
});
test("pilot repair handoff removes competing technical labels without consuming opt-in", () => {
  const transition = postRepairReviewLabelTransition("valkyriweb/openclaw-claude", 2);
  assert.equal(transition.addedLabel, "agent:review-requested");
  assert.ok(transition.removedLabel.split(",").includes("agent:fixing"));
  assert.ok(!transition.removedLabel.includes("clawsweeper:autofix"));
  assert.ok(!transition.removeArgs.includes("clawsweeper:automerge"));
});
