import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

import { repositoryProfileFor } from "../../dist/repository-profiles.js";
import { legacyTargetAuthFor, targetAuthFor } from "../../dist/repair/workflow-utils.js";

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

// Evaluate the checked-in Actions conditions with real profile authorization; no token is minted.
function verificationSteps(targetRepo: string) {
  const workflow = fs.readFileSync(".github/workflows/verify-reproduction.yml", "utf8");
  const authorization = targetAuthFor({ targetRepo, accessMode: "read" });
  const selected = steps(workflow).filter((step) => {
    const condition = step.match(/^        if: (.+)$/m)?.[1];
    if (!condition) return true;
    return vm.runInNewContext(condition.replace(/^\$\{\{\s*|\s*\}\}$/g, ""), {
      steps: { target_auth: { outputs: authorization }, verify: { outputs: {} } },
      always: () => true,
    });
  });
  if (selected.some((step) => step.includes("legacy-target-auth"))) {
    legacyTargetAuthFor(targetRepo);
  }
  return selected.join("\n");
}

test("draft-only verification authorizes a read token and audit without issue publication", () => {
  const profile = repositoryProfileFor("valkyriweb/clawrouter");
  const original = profile.automationPolicy;
  try {
    profile.automationPolicy = "draft_pr_only";
    const selected = verificationSteps(profile.targetRepo);
    assert.match(selected, /uses: \.\/\.github\/actions\/create-target-token/);
    assert.match(selected, /access-mode: read/);
    assert.match(selected, /id: target_auth[\s\S]*target-auth[\s\S]*--access-mode read/);
    assert.match(
      selected,
      /token: \$\{\{ steps\.draft_read_token\.outputs\.token \|\| steps\.app_token\.outputs\.token \}\}/,
    );
    assert.doesNotMatch(selected, /permission-issues: write|legacy-target-auth/);
    assert.match(selected, /repair:verify-reproduction -- run/);
    assert.match(selected, /repair:publish-main --/);
    assert.doesNotMatch(selected, /gh issue comment/);
    assert.throws(() => legacyTargetAuthFor(profile.targetRepo), /exact-job/);
  } finally {
    profile.automationPolicy = original;
  }
});

test("verification preserves legacy permissions and issue publication for other modes", () => {
  const profile = repositoryProfileFor("valkyriweb/clawrouter");
  const original = profile.automationPolicy;
  try {
    for (const mode of ["review_only", "full"] as const) {
      profile.automationPolicy = mode;
      const selected = verificationSteps(profile.targetRepo);
      assert.match(selected, /legacy-target-auth/);
      assert.match(selected, /permission-contents: read/);
      assert.match(selected, /permission-issues: write/);
      assert.match(selected, /permission-pull-requests: read/);
      assert.match(selected, /permission-actions: read/);
      assert.doesNotMatch(selected, /uses: \.\/\.github\/actions\/create-target-token/);
      assert.match(selected, /repair:verify-reproduction -- run/);
      assert.match(selected, /repair:publish-main --/);
      assert.match(selected, /gh issue comment/);
    }
    assert.throws(() => verificationSteps("bermont-digital/smilerite"), /legacy Valkyriweb/);
    assert.throws(() => verificationSteps("unknown-org/unknown-repo"), /Unsupported target repo/);
  } finally {
    profile.automationPolicy = original;
  }
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
