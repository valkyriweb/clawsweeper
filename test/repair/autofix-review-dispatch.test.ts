import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const sweepWorkflow = readFileSync(".github/workflows/sweep.yml", "utf8");
const commentRouter = readFileSync("src/repair/comment-router.ts", "utf8");
const fixExecutor = readFileSync("src/repair/execute-fix-artifact.ts", "utf8");
const repairWorker = readFileSync(".github/workflows/repair-cluster-worker.yml", "utf8");

test("the sweep receiver enables only explicitly authorized repair-item dispatches", () => {
  assert.match(sweepWorkflow, /repository_dispatch:\n\s+types: \[clawsweeper_repair_item\]/);
  assert.doesNotMatch(sweepWorkflow, /types: \[clawsweeper_item\]/);
});

test("repair-item payloads cross into shell only through environment variables", () => {
  const block =
    sweepWorkflow.match(
      /- name: Resolve event payload[\s\S]*?- name: Create target read token/,
    )?.[0] ?? "";
  assert.match(block, /EVENT_TARGET_REPO: \$\{\{ github\.event\.client_payload\.target_repo/);
  assert.match(block, /target_repo="\$EVENT_TARGET_REPO"/);
  assert.doesNotMatch(block, /target_repo="\$\{\{ github\.event\.client_payload/);
});

test("repair-loop re-reviews use the authorized repair-item event", () => {
  assert.match(commentRouter, /event_type: "clawsweeper_repair_item"/);
  assert.match(fixExecutor, /event_type: "clawsweeper_repair_item"/);
  assert.match(fixExecutor, /CLAWSWEEPER_REVIEW_REPO \?\? currentProjectRepo\(\)/);
  assert.match(fixExecutor, /CLAWSWEEPER_REVIEW_TOKEN/);
  assert.match(fixExecutor, /env: reviewDispatchEnv\(\)/);
  assert.match(repairWorker, /id: engine-token/);
  assert.match(repairWorker, /CLAWSWEEPER_REVIEW_REPO: \$\{\{ github\.repository \}\}/);
  assert.match(
    repairWorker,
    /CLAWSWEEPER_REVIEW_TOKEN: \$\{\{ steps\.engine-token\.outputs\.token \}\}/,
  );
});
