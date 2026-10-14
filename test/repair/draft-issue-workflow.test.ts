import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

// Seam: checked-in Actions orchestration contract, without minting any real tokens.
function steps(source: string) {
  return source.split(/(?=^      - (?:name:|uses:))/m);
}

test("draft target mint is scoped and follows exact-job authorization", () => {
  const action = fs.readFileSync(".github/actions/create-target-token/action.yml", "utf8");
  const draft = action.slice(
    action.indexOf("    - name: Create Valkyriweb draft"),
    action.indexOf("    - name: Create Valkyriweb comment"),
  );
  assert.match(draft, /access_mode == 'draft_issue_implementation'/);
  assert.match(draft, /permission-contents: write/);
  assert.match(draft, /permission-pull-requests: write/);
  assert.match(draft, /permission-issues: read/);
  assert.doesNotMatch(draft, /permission-(actions|workflows|checks|administration):/);
  assert.match(draft, /repositories: \$\{\{ steps.resolve.outputs.target_repo_name \}\}/);
  assert.ok(action.indexOf("target-auth") < action.indexOf("id: valkyriweb-draft"));
  assert.match(action, /--job-path "\$JOB_PATH"/);
});

test("draft worker cannot mint broad target or engine tokens or run ancillary mutation steps", () => {
  const source = fs.readFileSync(".github/workflows/repair-cluster-worker.yml", "utf8");
  const jobs = source.split(/^  execute:/m);
  assert.equal(jobs.length, 2);
  for (const job of jobs) {
    assert.ok(job.indexOf("repair-job-auth --job-path") < job.indexOf("id: app_token"));
    assert.match(job, /read-only: "true"/);
    assert.match(job, /persist-credentials: "false"/);
    assert.match(job, /persist-credentials: false/);
    const broad = steps(job).find((step) => step.includes("id: app_token"));
    assert.match(broad ?? "", /job_auth.outputs.draft_only == 'false'/);
  }
  for (const name of [
    "Create engine dispatch token",
    "Apply safe closure actions",
    "Post-flight finalize fix PRs",
    "Apply post-flight closeouts",
    "Tag ClawSweeper targets",
    "Detect repair requeue requests",
    "Requeue source-head repair races",
  ]) {
    const step = steps(source).find((step) => step.includes(`- name: ${name}\n`));
    assert.ok(step, name);
    assert.match(step, /job_auth.outputs.draft_only == 'false'/, name);
  }
  assert.match(jobs[0], /access-mode: read/);
  assert.match(jobs[1], /access-mode: draft_issue_implementation/);
  const stateAction = fs.readFileSync(".github/actions/create-state-token/action.yml", "utf8");
  assert.match(stateAction, /permission-actions:.*inputs.read-only != 'true' && 'write' \|\| ''/);
  assert.match(
    stateAction,
    /permission-contents:.*inputs.read-only == 'true' && 'read' \|\| 'write'/,
  );
});

test("intake only reads the target and requires explicit draft intent; no issue-event bridge", () => {
  const intake = fs.readFileSync(
    ".github/workflows/repair-issue-implementation-intake.yml",
    "utf8",
  );
  assert.match(intake, /draft_only:[\s\S]*default: false/);
  assert.match(intake, /--draft-only "\$DRAFT_ONLY"/);
  assert.match(intake, /access-mode: read/);
  assert.doesNotMatch(intake, /permission-(issues|contents|pull-requests|workflows): write/);
  assert.doesNotMatch(intake, /legacy-target-auth/);
  assert.match(intake, /types: \[clawsweeper_issue_implementation\]/);
  assert.doesNotMatch(intake, /issues.opened|issues.reopened|github_activity/);
});
