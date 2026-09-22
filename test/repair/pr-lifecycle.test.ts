import assert from "node:assert/strict";
import test from "node:test";
import {
  assertLifecycleRepairTarget,
  validateLifecycleEvidence,
  lifecycleDecision,
  technicalLabelTransition,
  repairPathsAllowed,
  lifecycleReplayReason,
} from "../../dist/repair/pr-lifecycle.js";

const sha = "a".repeat(40);
const base = "b".repeat(40);
const event = {
  target_repo: "valkyriweb/example",
  item_number: 2,
  head_sha: sha,
  source_run_id: "42",
  source_run_attempt: 1,
  phase: "completed",
  comment_id: "9",
};
const marker = {
  version: 1,
  target_repo: event.target_repo,
  item_number: 2,
  head_sha: sha,
  source_run_id: "42",
  source_run_attempt: 1,
  verdict: "fail",
};
function evidence() {
  return {
    event,
    targetRepo: event.target_repo,
    pull: {
      number: 2,
      state: "open",
      labels: [{ name: "clawsweeper:autofix" }],
      base: { ref: "main", sha: base, repo: { full_name: event.target_repo } },
      head: { sha, ref: "fix", repo: { full_name: event.target_repo } },
    },
    run: {
      id: 42,
      run_attempt: 1,
      repository: { full_name: event.target_repo },
      path: ".github/workflows/pi-pr-review.yml",
      event: "pull_request_target",
      status: "in_progress",
      head_sha: base,
      head_branch: "main",
      pull_requests: [],
      run_started_at: "2026-09-22T00:00:00Z",
    },
    artifact: { ...marker, phase: "completed", comment_id: 9 },
    comment: {
      id: 9,
      issue_url: `https://api.github.com/repos/${event.target_repo}/issues/2`,
      user: { login: "github-actions[bot]" },
      created_at: "2026-09-22T00:01:00Z",
      updated_at: "2026-09-22T00:01:00Z",
      body: `<!-- pi-pr-review-lifecycle:${JSON.stringify(marker)} -->\nFix the broken documentation link.`,
    },
    checks: [
      {
        name: "pi-pr-review/verdict",
        head_sha: sha,
        status: "completed",
        conclusion: "failure",
        details_url: `https://github.com/${event.target_repo}/actions/runs/42/attempts/1`,
        external_id: "pi-pr-review:42:1",
        app: { slug: "github-actions" },
      },
    ],
    trustedAuthors: new Set(["github-actions[bot]"]),
  };
}

test("schema boundaries reject malformed identities and file paths", () => {
  for (const input of [
    null,
    [],
    { ...event, comment_id: 9 },
    { ...event, phase: "other" },
    { ...event, item_number: "2" },
    { ...event, source_run_attempt: Number.MAX_SAFE_INTEGER + 1 },
  ]) {
    assert.throws(
      () => validateLifecycleEvidence({ ...evidence(), event: input }),
      /invalid Pi lifecycle identity/,
    );
  }
  for (const file of [
    null,
    [],
    { filename: 42 },
    { filename: "docs/a.md", previous_filename: null },
    { filename: "docs/a.md", status: "renamed" },
    { filename: "docs/a.md", previous_filename: ".github/a.yml", status: "renamed" },
  ]) {
    assert.equal(repairPathsAllowed([file], ["docs/**"]), false);
  }
});
test("trusted main target run binds empty PR arrays through immutable artifact", () => {
  assert.equal(validateLifecycleEvidence(evidence()).verdict, "fail");
  const bad = evidence();
  bad.artifact.head_sha = "c".repeat(40);
  assert.throws(() => validateLifecycleEvidence(bad), /artifact/);
});
test("untrusted, stale, closed, altered marker, wrong workflow/base/check fail closed", () => {
  for (const mutate of [
    (e) => {
      e.comment.user.login = "attacker";
    },
    (e) => {
      e.pull.head.sha = "c".repeat(40);
    },
    (e) => {
      e.pull.state = "closed";
    },
    (e) => {
      e.pull.base.ref = "untrusted";
    },
    (e) => {
      e.run.head_sha = sha;
    },
    (e) => {
      e.run.path = ".github/workflows/other.yml";
    },
    (e) => {
      e.run.event = "pull_request";
    },
    (e) => {
      e.run.event = "workflow_dispatch";
    },
    (e) => {
      e.checks[0].conclusion = "success";
    },
    (e) => {
      e.comment.body += e.comment.body;
    },
    (e) => {
      e.comment.updated_at = "2026-09-22T00:02:00Z";
    },
    (e) => {
      e.comment.body += "x".repeat(25000);
    },
  ]) {
    const e = evidence();
    mutate(e);
    assert.throws(() => validateLifecycleEvidence(e));
  }
});
test("technical state cannot authorize repair or override failed check", () => {
  const decision = {
    phase: "completed",
    verdict: "fail",
    authorized: true,
    sensitive: false,
    paused: false,
    classification: "actionable",
  } as const;
  assert.equal(lifecycleDecision(decision), "agent:fix-requested");
  for (const classification of ["advisory", "environment", "unknown"] as const)
    assert.equal(lifecycleDecision({ ...decision, classification }), "clawsweeper:human-review");
  for (const override of [{ authorized: false }, { sensitive: true }, { paused: true }])
    assert.equal(lifecycleDecision({ ...decision, ...override }), "clawsweeper:human-review");
  assert.equal(lifecycleDecision({ ...decision, verdict: "pass" }), "agent:review-passed");
  assert.equal(lifecycleDecision({ ...decision, phase: "started" }), "agent:reviewing");
  assert.equal(
    lifecycleDecision({ ...decision, verdict: "incomplete" }),
    "clawsweeper:human-review",
  );
});
test("scope accepts only explicit docs allowlist including both rename paths", () => {
  const patterns = ["docs/**/*.md"];
  assert.equal(
    repairPathsAllowed([{ filename: "docs/runbook.md", status: "modified" }], patterns),
    true,
  );
  for (const files of [
    [],
    [{}],
    [null],
    [{ filename: 7 }],
    ["src/index.ts"],
    [".github/x.md"],
    ["docs/../runtime.md"],
    [{ filename: "docs/new.md", previous_filename: "services/runtime.ts" }],
    ["docs/AGENTS.md"],
    ["docs/config/key.md"],
  ]) {
    assert.equal(repairPathsAllowed(files, patterns), false, JSON.stringify(files));
  }
  assert.equal(repairPathsAllowed(["docs/runbook.md"], undefined), false);
});
test("completed events dominate delayed starts and older attempts/runs", () => {
  const command = {
    repo: event.target_repo,
    issue_number: 2,
    automation_source: "pi_review_lifecycle",
    source_run_id: "42",
    source_run_attempt: 2,
    lifecycle_phase: "completed",
    status: "executed",
  };
  assert.ok(lifecycleReplayReason({ ...command, lifecycle_phase: "started" }, [command]));
  assert.ok(lifecycleReplayReason({ ...command, source_run_attempt: 1 }, [command]));
  assert.ok(lifecycleReplayReason({ ...command, source_run_id: "41" }, [command]));
  assert.equal(lifecycleReplayReason({ ...command, source_run_id: "43" }, [command]), null);
});
test("malformed native replay identities block only their PR without throwing", () => {
  const command = {
    repo: event.target_repo,
    issue_number: 2,
    automation_source: "pi_review_lifecycle",
    source_run_id: "42",
    source_run_attempt: 2,
    lifecycle_phase: "completed",
    status: "executed",
  };
  for (const source_run_id of [null, undefined, "not-a-run", {}, 42]) {
    const prior = { ...command, source_run_id };
    assert.match(lifecycleReplayReason(command, [prior]) ?? "", /invalid.*identity/);
    assert.equal(lifecycleReplayReason(command, [{ ...prior, repo: "other/repo" }]), null);
  }
});
test("every supplied path alias must remain within the repair scope", () => {
  for (const filename of ["src/evil.ts", ".github/workflows/evil.yml", "../evil.md"]) {
    assert.equal(repairPathsAllowed([{ path: "docs/a.md", filename }], ["docs/**/*.md"]), false);
  }
  assert.equal(
    repairPathsAllowed([{ path: "docs/a.md", filename: "docs/b.md" }], ["docs/**/*.md"]),
    true,
  );
});
test("worker rechecks exact SHA, PR, open state, opt-in and human stop", () => {
  assert.doesNotThrow(() => assertLifecycleRepairTarget(evidence().pull, sha, 2));
  for (const override of [
    { state: "closed" },
    { number: 3 },
    { head: { sha: base } },
    { labels: [] },
    { labels: [{ name: "clawsweeper:autofix" }, { name: "clawsweeper:human-review" }] },
  ])
    assert.throws(() => assertLifecycleRepairTarget({ ...evidence().pull, ...override }, sha, 2));
});
test("label transition clears technical states only and preserves authorization and human stop", () => {
  const transition = technicalLabelTransition(
    ["clawsweeper:autofix", "clawsweeper:human-review", "agent:review-passed", "agent:fixing"],
    "agent:review-requested",
  );
  assert.deepEqual(transition, {
    add: "agent:review-requested",
    remove: ["agent:review-passed", "agent:fixing"],
  });
});
