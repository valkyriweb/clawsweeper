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

const nativeRepo = "valkyriweb/openclaw-claude";
const nativeHead = "4be6681797f76bf90fc6c6c46d775558be03a782";
const nativeBase = "d86700c784447c1308c4ecab45d27de3c8582216";
const nativeRepoRef = {
  id: 1170633596,
  name: "openclaw-claude",
  url: "https://api.github.com/repos/valkyriweb/openclaw-claude",
};
const nativeEvent = {
  target_repo: nativeRepo,
  item_number: 305,
  head_sha: nativeHead,
  source_run_id: "35787205991",
  source_run_attempt: 1,
  phase: "completed",
  comment_id: "11",
};
const nativeMarker = {
  version: 1,
  target_repo: nativeRepo,
  item_number: 305,
  head_sha: nativeHead,
  source_run_id: "35787205991",
  source_run_attempt: 1,
  verdict: "pass",
};
/** Real `pull_request_target` REST shape: run head SHA is the candidate, bound by GitHub's own PR association. */
function nativeEvidence() {
  return structuredClone({
    event: nativeEvent,
    targetRepo: nativeRepo,
    pull: {
      number: 305,
      state: "open",
      labels: [{ name: "clawsweeper:autofix" }],
      base: { ref: "main", sha: nativeBase, repo: { full_name: nativeRepo } },
      head: {
        ref: "test/pr-review-lifecycle-pilot",
        sha: nativeHead,
        repo: { full_name: nativeRepo },
      },
    },
    run: {
      id: 35787205991,
      run_attempt: 1,
      repository: { full_name: nativeRepo },
      path: ".github/workflows/pi-pr-review.yml",
      event: "pull_request_target",
      status: "completed",
      head_sha: nativeHead,
      head_branch: "test/pr-review-lifecycle-pilot",
      pull_requests: [
        {
          number: 305,
          base: { ref: "main", sha: nativeBase, repo: nativeRepoRef },
          head: { ref: "test/pr-review-lifecycle-pilot", sha: nativeHead, repo: nativeRepoRef },
        },
      ],
      run_started_at: "2026-09-22T00:00:00Z",
    },
    artifact: { ...nativeMarker, phase: "completed", comment_id: 11 },
    comment: {
      id: 11,
      issue_url: `https://api.github.com/repos/${nativeRepo}/issues/305`,
      user: { login: "github-actions[bot]" },
      created_at: "2026-09-22T00:01:00Z",
      updated_at: "2026-09-22T00:01:00Z",
      body: `<!-- pi-pr-review-lifecycle:${JSON.stringify(nativeMarker)} -->\nDocumentation reads correctly.`,
    },
    checks: [
      {
        name: "pi-pr-review/verdict",
        head_sha: nativeHead,
        status: "completed",
        conclusion: "success",
        details_url: `https://github.com/${nativeRepo}/actions/runs/35787205991/attempts/1`,
        external_id: "pi-pr-review:35787205991:1",
        app: { slug: "github-actions" },
      },
    ],
    trustedAuthors: new Set(["github-actions[bot]"]),
  });
}
function canonicalCheckEvidence() {
  const e = nativeEvidence();
  const sourceRun = "35837369370";
  e.event.source_run_id = sourceRun;
  e.artifact.source_run_id = sourceRun;
  e.run.id = Number(sourceRun);
  e.comment.body = `<!-- pi-pr-review-lifecycle:${JSON.stringify({ ...nativeMarker, source_run_id: sourceRun })} -->\nDocumentation reads correctly.`;
  return {
    ...e,
    run: {
      ...e.run,
      check_suite_id: 97035588087,
      check_suite_url: `https://api.github.com/repos/${nativeRepo}/check-suites/97035588087`,
    },
    checks: [
      {
        ...e.checks[0],
        id: 107104231406,
        check_suite: { id: 97035588087 },
        details_url: `https://github.com/${nativeRepo}/runs/107104231406`,
        html_url: `https://github.com/${nativeRepo}/runs/107104231406`,
        external_id: `pi-pr-review:${sourceRun}:1`,
      },
    ],
  };
}

test("native canonical check URLs bind the check suite to the source run", () => {
  assert.equal(validateLifecycleEvidence(canonicalCheckEvidence()).verdict, "pass");
  assert.equal(validateLifecycleEvidence(evidence()).verdict, "fail");
});

test("native check binding rejects absent, malformed and conflicting numeric IDs", () => {
  for (const invalid of [
    undefined,
    null,
    "97035588087",
    0,
    -1,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
    NaN,
    Infinity,
  ]) {
    for (const field of ["run suite", "check suite", "check ID"]) {
      const e = canonicalCheckEvidence();
      if (field === "run suite") e.run.check_suite_id = invalid;
      if (field === "check suite") e.checks[0].check_suite.id = invalid;
      if (field === "check ID") e.checks[0].id = invalid;
      assert.throws(() => validateLifecycleEvidence(e), /technical check/, `${field}: ${invalid}`);
    }
  }
  for (const mutate of [
    (e) => {
      e.checks[0].check_suite = undefined;
    },
    (e) => {
      e.checks[0].check_suite = null;
    },
    (e) => {
      e.checks[0].check_suite = {};
    },
    (e) => {
      e.checks[0].check_suite.id += 1;
    },
    (e) => {
      e.run.check_suite_id += 1;
    },
    (e) => {
      e.checks[0].id += 1;
    },
  ]) {
    const e = canonicalCheckEvidence();
    mutate(e);
    assert.throws(() => validateLifecycleEvidence(e), /technical check/);
  }
});

test("native binding requires exact repository-owned canonical URLs", () => {
  for (const field of ["details_url", "html_url"]) {
    for (const url of [
      undefined,
      null,
      "",
      `https://github.com/attacker/openclaw-claude/runs/107104231406`,
      `https://github.com/${nativeRepo}/runs/107104231407`,
      `https://github.com/${nativeRepo}/runs/107104231406/`,
      `https://github.com/${nativeRepo}/runs/107104231406?x=1`,
      `https://github.com/${nativeRepo}/actions/runs/35837369370`,
    ]) {
      const e = canonicalCheckEvidence();
      e.checks[0][field] = url;
      assert.throws(() => validateLifecycleEvidence(e), /technical check/);
    }
  }
  for (const url of [
    undefined,
    null,
    "",
    `https://api.github.com/repos/attacker/openclaw-claude/check-suites/97035588087`,
    `https://api.github.com/repos/${nativeRepo}/check-suites/97035588088`,
  ]) {
    const e = canonicalCheckEvidence();
    e.run.check_suite_url = url;
    assert.throws(() => validateLifecycleEvidence(e), /technical check/);
  }
});

test("native URL compatibility does not bypass existing check identity guards", () => {
  for (const changes of [
    { name: "other" },
    { head_sha: base },
    { app: { slug: "other" } },
    { status: "in_progress" },
    { conclusion: "failure" },
    { external_id: undefined },
    { external_id: "pi-pr-review:35837369371:1" },
    { external_id: "pi-pr-review:35837369370:2" },
  ]) {
    const e = canonicalCheckEvidence();
    Object.assign(e.checks[0], changes);
    assert.throws(() => validateLifecycleEvidence(e), /technical check/);
  }
  const e = canonicalCheckEvidence();
  e.run.run_attempt = 2;
  assert.throws(() => validateLifecycleEvidence(e), /source run/);
});

const foreignRepoRef = {
  id: 987654321,
  name: "openclaw-claude",
  url: "https://api.github.com/repos/attacker/openclaw-claude",
};

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
test("native candidate-head run passes only through its own GitHub PR association", () => {
  assert.equal(validateLifecycleEvidence(nativeEvidence()).verdict, "pass");
  const legacy = nativeEvidence();
  legacy.run.head_sha = nativeBase;
  legacy.run.pull_requests = [];
  assert.equal(validateLifecycleEvidence(legacy).verdict, "pass");
});
test("absent, malformed, stale, foreign or conflicting run associations fail closed", () => {
  const association = () => nativeEvidence().run.pull_requests[0];
  for (const pull_requests of [
    [],
    undefined,
    null,
    "305",
    [{}],
    [{ ...association(), number: 306 }],
    [{ ...association(), number: "305" }],
    [{ ...association(), base: { ...association().base, ref: "release" } }],
    [{ ...association(), base: { ...association().base, sha: "c".repeat(40) } }],
    [{ ...association(), base: { ...association().base, sha: nativeBase.slice(0, 7) } }],
    [{ ...association(), base: { ...association().base, repo: foreignRepoRef } }],
    [{ ...association(), base: { ...association().base, repo: undefined } }],
    [{ ...association(), head: { ...association().head, sha: "c".repeat(40) } }],
    [{ ...association(), head: { ...association().head, repo: foreignRepoRef } }],
    [
      {
        ...association(),
        head: { ...association().head, repo: { ...nativeRepoRef, id: nativeRepoRef.id + 1 } },
      },
    ],
    [association(), { ...association(), number: 306 }],
    [association(), association()],
  ]) {
    const e = nativeEvidence();
    e.run.pull_requests = pull_requests;
    assert.throws(
      () => validateLifecycleEvidence(e),
      /trusted current main base/,
      JSON.stringify(pull_requests ?? null),
    );
  }
});
test("candidate-head binding keeps every run, head and base guard", () => {
  for (const mutate of [
    (e) => {
      e.run.event = "pull_request";
    },
    (e) => {
      e.run.event = "workflow_dispatch";
    },
    (e) => {
      e.run.path = ".github/workflows/other.yml";
    },
    (e) => {
      e.run.repository.full_name = "attacker/openclaw-claude";
    },
    (e) => {
      e.run.head_sha = "c".repeat(40);
    },
    (e) => {
      e.pull.base.sha = "c".repeat(40);
    },
    (e) => {
      e.pull.base.ref = "release";
    },
    (e) => {
      e.pull.head.sha = "c".repeat(40);
    },
    (e) => {
      e.pull.state = "closed";
    },
    (e) => {
      e.artifact.head_sha = "c".repeat(40);
    },
    (e) => {
      e.comment.user.login = "attacker";
    },
    (e) => {
      e.checks[0].head_sha = nativeBase;
    },
    (e) => {
      e.checks[0].conclusion = "failure";
    },
  ]) {
    const e = nativeEvidence();
    mutate(e);
    assert.throws(() => validateLifecycleEvidence(e));
  }
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
