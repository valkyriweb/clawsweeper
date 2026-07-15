import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  artifactItemNumbers,
  automationLimit,
  commentSyncBatchOutput,
  commitReviewRefForTarget,
  countActions,
  countCommandActions,
  countRequeueRequired,
  legacyTargetAuthFor,
  mergeApplyReports,
  planOutputFields,
  plannedItemNumberCsv,
  proposedItemNumbers,
  targetAuthFor,
  writeCommentSyncCursor,
} from "../../dist/repair/workflow-utils.js";
import { AUTOMATION_LIMITS, WORKER_CONFIG, workerLimit } from "../../dist/repair/limits.js";

test("commitReviewRefForTarget returns the per-target override or the main default", () => {
  // paperclip ships from its bermont production overlay, not main.
  assert.equal(commitReviewRefForTarget("valkyriweb/paperclip"), "refs/heads/bermont");
  // A target with no override falls back to the shared main default.
  assert.equal(commitReviewRefForTarget("valkyriweb/pi-mono"), "refs/heads/main");
});

test("commit-review-ref CLI resolves the target via --target-repo, as the workflow invokes it", () => {
  // commit-review.yml calls `workflow -- commit-review-ref --target-repo "$TARGET_REPO"`.
  // A positional arg parses to no target and exits non-zero, which is exactly the
  // failure that broke paperclip's commit-review gate after the per-target ref shipped.
  const output = execFileSync(
    process.execPath,
    ["dist/repair/workflow-utils.js", "commit-review-ref", "--target-repo", "valkyriweb/paperclip"],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  assert.equal(output, "refs/heads/bermont");

  assert.throws(
    () =>
      execFileSync(
        process.execPath,
        ["dist/repair/workflow-utils.js", "commit-review-ref", "valkyriweb/paperclip"],
        { cwd: process.cwd(), encoding: "utf8", stdio: "pipe" },
      ),
    /--target-repo is required/,
  );
});

test("target auth resolves explicit routes and denies review-only mutation before minting", () => {
  assert.deepEqual(targetAuthFor({ targetRepo: "bermont-digital/multica", accessMode: "mutate" }), {
    target_repo: "bermont-digital/multica",
    target_repo_owner: "bermont-digital",
    target_repo_name: "multica",
    credential_route: "valkyriweb",
    automation_policy: "full",
    access_mode: "mutate",
  });
  assert.deepEqual(targetAuthFor({ targetRepo: "valkyriweb/clawsweeper", accessMode: "read" }), {
    target_repo: "valkyriweb/clawsweeper",
    target_repo_owner: "valkyriweb",
    target_repo_name: "clawsweeper",
    credential_route: "valkyriweb",
    automation_policy: "full",
    access_mode: "read",
  });
  assert.equal(
    targetAuthFor({ targetRepo: "bermont-digital/sale-sight-plugin", accessMode: "comment" })
      .credential_route,
    "bermont-digital",
  );
  assert.throws(
    () => targetAuthFor({ targetRepo: "bermont-digital/smilerite", accessMode: "mutate" }),
    /review_only.*denies target token access-mode=mutate/,
  );
  assert.throws(
    () => targetAuthFor({ targetRepo: "unknown-org/unknown-repo", accessMode: "read" }),
    /Unsupported target repo/,
  );
});

test("legacy target auth permits only configured Valkyriweb routes", () => {
  assert.equal(legacyTargetAuthFor("bermont-digital/multica"), "bermont-digital/multica");
  for (const targetRepo of ["bermont-digital/sale-sight-plugin", "bermont-digital/smilerite"]) {
    assert.throws(
      () => legacyTargetAuthFor(targetRepo),
      /github_app_credential_route=bermont-digital.*legacy Valkyriweb target token/,
    );
  }
  assert.throws(
    () => legacyTargetAuthFor("unknown-org/unknown-repo"),
    /Unsupported target repo/,
  );
});

test("target-auth CLI emits the route and policy consumed by the facade", () => {
  const output = execFileSync(
    process.execPath,
    [
      "dist/repair/workflow-utils.js",
      "target-auth",
      "--target-repo",
      "bermont-digital/sale-sight-plugin",
      "--access-mode",
      "comment",
    ],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  assert.match(output, /^credential_route=bermont-digital$/m);
  assert.match(output, /^automation_policy=review_only$/m);
  assert.match(output, /^access_mode=comment$/m);
  assert.throws(
    () =>
      execFileSync(
        process.execPath,
        [
          "dist/repair/workflow-utils.js",
          "target-auth",
          "--target-repo",
          "bermont-digital/smilerite",
          "--access-mode",
          "mutate",
        ],
        { cwd: process.cwd(), encoding: "utf8", stdio: "pipe" },
      ),
    /review_only.*denies target token access-mode=mutate/,
  );
  assert.equal(
    execFileSync(
      process.execPath,
      ["dist/repair/workflow-utils.js", "legacy-target-auth", "--target-repo", "bermont-digital/multica"],
      { cwd: process.cwd(), encoding: "utf8" },
    ),
    "bermont-digital/multica",
  );
  assert.throws(
    () =>
      execFileSync(
        process.execPath,
        [
          "dist/repair/workflow-utils.js",
          "legacy-target-auth",
          "--target-repo",
          "bermont-digital/sale-sight-plugin",
        ],
        { cwd: process.cwd(), encoding: "utf8", stdio: "pipe" },
      ),
    /github_app_credential_route=bermont-digital/,
  );
});

test("target-token facade contains only static credential branches", () => {
  const action = fs.readFileSync(".github/actions/create-target-token/action.yml", "utf8");
  for (const route of ["valkyriweb", "bermont-digital"]) {
    for (const mode of ["read", "comment", "mutate"]) {
      assert.match(
        action,
        new RegExp(
          `Create ${route === "valkyriweb" ? "Valkyriweb" : "Bermont Digital"} ${mode} token`,
        ),
      );
    }
  }
  assert.match(action, /target-auth/);
  assert.doesNotMatch(action, /secrets\[/);
  assert.doesNotMatch(action, /\$\{\{\s*format\(/);
});

test("manual sweep routes every target token through the facade and keeps control tokens Valkyriweb", () => {
  const workflow = fs.readFileSync(".github/workflows/sweep.yml", "utf8");
  const targetTokenSites =
    workflow.match(/uses: (?:\.\/)?(?:clawsweeper\/)?\.github\/actions\/create-target-token/g) ??
    [];
  assert.equal(targetTokenSites.length, 7);
  assert.match(
    workflow,
    /target_repo:\n\s+description: "Repository to sweep \(explicit configured profile required\)"\n\s+required: true/,
  );
  assert.doesNotMatch(workflow, /^\s+repository_dispatch:\s*$/m);
  assert.doesNotMatch(workflow, /^\s+schedule:\s*$/m);
  assert.match(workflow, /repositories: clawsweeper-state/);
  assert.match(workflow, /repositories: my-pi/);
  assert.match(workflow, /BERMONT_DIGITAL_CLAWSWEEPER_APP_PRIVATE_KEY/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(
    workflow,
    /CLAWSWEEPER_PROOF_INSPECTION_TOKEN: \$\{\{ steps\.target-read-token\.outputs\.token \}\}/,
  );
});

test("every active legacy target-token mint has a preceding route guard", () => {
  const targetMintSites: Array<{ workflow: string; tokenStep: string }> = [
    { workflow: "commit-review.yml", tokenStep: "Create target read token" },
    { workflow: "commit-review.yml", tokenStep: "Create target checks token" },
    { workflow: "repair-cluster-worker.yml", tokenStep: "Create GitHub App token" },
    { workflow: "repair-comment-router.yml", tokenStep: "Create GitHub App token" },
    { workflow: "repair-commit-finding-intake.yml", tokenStep: "Create GitHub App token" },
    { workflow: "repair-issue-implementation-intake.yml", tokenStep: "Create GitHub App token" },
    { workflow: "verify-reproduction.yml", tokenStep: "Create GitHub App token" },
  ];

  for (const { workflow, tokenStep } of targetMintSites) {
    const source = fs.readFileSync(path.join(".github/workflows", workflow), "utf8");
    const tokenStepIndexes = [...source.matchAll(new RegExp(`- name: ${tokenStep}`, "g"))].map(
      (match) => match.index ?? -1,
    );
    assert.ok(tokenStepIndexes.length > 0, `${workflow} must retain its enumerated target mint`);
    for (const tokenStepIndex of tokenStepIndexes) {
      const precedingSource = source.slice(0, tokenStepIndex);
      const jobStepsIndex = precedingSource.lastIndexOf("\n    steps:");
      const guardIndex = precedingSource.lastIndexOf("- name: Authorize legacy target token");
      assert.ok(
        guardIndex > jobStepsIndex,
        `${workflow} target mint needs a same-job legacy route guard`,
      );
      assert.match(
        precedingSource.slice(guardIndex, tokenStepIndex),
        /legacy-target-auth --target-repo "\$TARGET_REPO"/,
        `${workflow} guard must validate the resolved target repo`,
      );
    }
  }
});

test("workflow utilities expose automation limits", () => {
  assert.equal(
    automationLimit("review_shards.normal_default"),
    AUTOMATION_LIMITS.review_shards.normal_default,
  );
  assert.equal(
    automationLimit("repair_live_runs.default"),
    AUTOMATION_LIMITS.repair_live_runs.default,
  );
  assert.throws(() => automationLimit("missing.default"), /unknown automation limit/);
});

test("workflow utilities accept positional automation limit CLI paths", () => {
  const output = execFileSync(
    process.execPath,
    ["dist/repair/workflow-utils.js", "limit", "review_shards.normal_default"],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  assert.equal(output, String(AUTOMATION_LIMITS.review_shards.normal_default));
});

test("worker scheduler lets background lanes yield to active work", () => {
  const quietBackgroundCapacity =
    WORKER_CONFIG.workers.max -
    WORKER_CONFIG.workers.reserve_for_interactive -
    WORKER_CONFIG.workers.expansion_reserve;
  assert.equal(
    workerLimit("normal_review"),
    Math.min(AUTOMATION_LIMITS.review_shards.normal_default, quietBackgroundCapacity),
  );
  assert.equal(workerLimit("normal_review", { activeCritical: 21, activeBackground: 13 }), 1);
  assert.equal(workerLimit("commit_review"), AUTOMATION_LIMITS.commit_review.page_size_default);
  assert.equal(workerLimit("commit_review", { activeCritical: 49 }), 1);
  assert.equal(workerLimit("repair"), AUTOMATION_LIMITS.repair_live_runs.default);
  assert.equal(
    workerLimit("docs_maintenance"),
    AUTOMATION_LIMITS.repair_live_runs.docs_maintenance_default,
  );
});

test("workflow utilities derive artifact item numbers and action counts", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-workflow-"));
  write(path.join(root, "artifacts/shard-a/openclaw-openclaw-42.md"), "report\n");
  write(path.join(root, "artifacts/shard-b/7.md"), "report\n");
  write(
    path.join(root, "apply-report.json"),
    JSON.stringify([{ action: "closed" }, { action: "review_comment_synced" }]),
  );

  assert.deepEqual(artifactItemNumbers(path.join(root, "artifacts")), [7, 42]);
  assert.equal(countActions(path.join(root, "apply-report.json"), ""), 2);
  assert.equal(countActions(path.join(root, "apply-report.json"), "closed"), 1);
});

test("workflow utilities count nested command actions by status", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-workflow-"));
  const report = path.join(root, "comment-router-latest.json");
  write(
    report,
    JSON.stringify({
      commands: [
        {
          actions: [
            { action: "dispatch_repair", status: "waiting" },
            { action: "dispatch_repair", status: "executed" },
          ],
        },
        {
          actions: [{ action: "dispatch_clawsweeper", status: "waiting" }],
        },
      ],
    }),
  );

  assert.equal(countCommandActions(report, "dispatch_repair"), 2);
  assert.equal(countCommandActions(report, "dispatch_repair", "waiting"), 1);
  assert.equal(countCommandActions(report, "dispatch_clawsweeper", "waiting"), 1);
});

test("workflow utilities count repair results that require requeue", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-workflow-"));
  write(
    path.join(root, "runs/a/result.json"),
    JSON.stringify({
      actions: [
        { action: "repair_contributor_branch", status: "blocked", requeue_required: true },
        { action: "automerge_repair_outcome_comment", status: "updated" },
      ],
    }),
  );
  write(
    path.join(root, "runs/b/result.json"),
    JSON.stringify({ actions: [{ action: "repair_contributor_branch", status: "pushed" }] }),
  );

  assert.equal(countRequeueRequired(path.join(root, "runs")), 1);
});

test("workflow utilities merge checkpoint reports in numeric order", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-workflow-"));
  const reports = path.join(root, "reports");
  write(path.join(reports, "apply-report-10.json"), JSON.stringify([{ action: "tenth" }]));
  write(path.join(reports, "apply-report-2.json"), JSON.stringify([{ action: "second" }]));

  const output = path.join(root, "combined.json");
  mergeApplyReports(reports, output);

  assert.deepEqual(JSON.parse(fs.readFileSync(output, "utf8")), [
    { action: "second" },
    { action: "tenth" },
  ]);
});

test("workflow utilities expose planned item numbers for recovery dispatches", () => {
  assert.equal(
    plannedItemNumberCsv({
      candidates: [{ number: 42 }, { number: "7" }, { number: 0 }, { title: "missing" }],
    }),
    "42,7",
  );
});

test("workflow utilities expose review capacity telemetry from plans", () => {
  assert.deepEqual(
    planOutputFields(
      {
        capacity: 300,
        candidates: [{ number: 42 }, { number: 43 }],
        matrix: [{ shard: 0, item_numbers: "42,43" }],
        activeCodexTarget: 1,
        dueBacklog: 17,
        oldestUnreviewedAt: "2026-01-01T00:00:00Z",
        capacityReason: "under capacity: due backlog below planned capacity",
        reviewProvider: "pi",
        reviewPolicy: { model: "claude-opus-4-8" },
      },
      { batchSize: 3, shardCount: 100 },
    ),
    {
      matrix: JSON.stringify([{ shard: 0, item_numbers: "42,43" }]),
      planned_count: "2",
      planned_capacity: "300",
      planned_item_numbers: "42,43",
      planned_shards: "1",
      active_codex_target: "1",
      review_model: "claude-opus-4-8",
      review_provider: "pi",
      due_backlog: "17",
      oldest_unreviewed_at: "2026-01-01T00:00:00Z",
      capacity_reason: "under capacity: due backlog below planned capacity",
    },
  );
});

test("workflow utilities select eligible proposed close records", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-workflow-"));
  const oldDate = "2024-01-01T00:00:00Z";
  write(
    path.join(root, "records/openclaw-openclaw/items/openclaw-openclaw-5.md"),
    [
      "---",
      "repository: openclaw/openclaw",
      "type: issue",
      "decision: close",
      "confidence: high",
      "action_taken: proposed_close",
      "close_reason: implemented_on_main",
      `item_created_at: ${oldDate}`,
      "---",
      "",
    ].join("\n"),
  );
  write(
    path.join(root, "records/openclaw-openclaw/items/openclaw-openclaw-9.md"),
    [
      "---",
      "repository: openclaw/openclaw",
      "type: pull_request",
      "decision: close",
      "confidence: high",
      "action_taken: proposed_close",
      "close_reason: stale_insufficient_info",
      `item_created_at: ${oldDate}`,
      "---",
      "",
    ].join("\n"),
  );
  write(
    path.join(root, "records/openclaw-openclaw/items/openclaw-openclaw-12.md"),
    [
      "---",
      "repository: openclaw/openclaw",
      "type: pull_request",
      "decision: close",
      "confidence: high",
      "action_taken: proposed_close",
      "close_reason: mostly_implemented_on_main",
      `item_created_at: ${oldDate}`,
      "---",
      "",
    ].join("\n"),
  );
  write(
    path.join(root, "records/openclaw-openclaw/items/openclaw-openclaw-13.md"),
    [
      "---",
      "repository: openclaw/openclaw",
      "type: issue",
      "decision: close",
      "confidence: high",
      "action_taken: proposed_close",
      "close_reason: mostly_implemented_on_main",
      `item_created_at: ${oldDate}`,
      "---",
      "",
    ].join("\n"),
  );
  write(
    path.join(root, "records/openclaw-openclaw/items/openclaw-openclaw-14.md"),
    [
      "---",
      "repository: openclaw/openclaw",
      "type: pull_request",
      "decision: close",
      "confidence: high",
      "action_taken: proposed_close",
      "close_reason: mostly_implemented_on_main",
      `item_created_at: ${new Date().toISOString()}`,
      "---",
      "",
    ].join("\n"),
  );

  const selected = withCwd(root, () =>
    proposedItemNumbers({
      targetRepo: "openclaw/openclaw",
      applyKind: "all",
      applyCloseReasons: "all",
      staleMinAgeDays: 60,
      minAgeDays: 0,
      minAgeMinutes: null,
    }),
  );

  assert.deepEqual(selected, [5, 12]);
});

test("workflow utilities re-elect skipped_changed_since_review records once a fresh review supersedes the skip", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-workflow-skip-"));
  const oldDate = "2024-01-01T00:00:00Z";
  const baseFrontMatter = (number, overrides) => {
    const fields = {
      repository: "openclaw/openclaw",
      type: "issue",
      decision: "close",
      confidence: "high",
      action_taken: "skipped_changed_since_review",
      close_reason: "implemented_on_main",
      item_created_at: oldDate,
      ...overrides,
    };
    const lines = ["---"];
    for (const [key, value] of Object.entries(fields)) lines.push(`${key}: ${value}`);
    lines.push("---", "");
    write(
      path.join(root, `records/openclaw-openclaw/items/openclaw-openclaw-${number}.md`),
      lines.join("\n"),
    );
  };

  // #20: fresh review (21:00) AFTER the apply skip (20:00) — should be re-eligible.
  baseFrontMatter(20, {
    reviewed_at: "2026-05-15T21:00:00Z",
    apply_checked_at: "2026-05-15T20:00:00Z",
  });
  // #21: skip is newer than review — stays skipped, stays invisible.
  baseFrontMatter(21, {
    reviewed_at: "2026-05-15T20:00:00Z",
    apply_checked_at: "2026-05-15T21:00:00Z",
  });
  // #22: skip with no apply_checked_at recorded but a review_at present — trust the review.
  baseFrontMatter(22, {
    reviewed_at: "2026-05-15T21:00:00Z",
  });
  // #23: no reviewed_at at all — cannot supersede, stays invisible.
  baseFrontMatter(23, {
    apply_checked_at: "2026-05-15T20:00:00Z",
  });

  const selected = withCwd(root, () =>
    proposedItemNumbers({
      targetRepo: "openclaw/openclaw",
      applyKind: "all",
      applyCloseReasons: "all",
      staleMinAgeDays: 60,
      minAgeDays: 0,
      minAgeMinutes: null,
    }),
  );

  assert.deepEqual(selected, [20, 22]);
});

test("workflow utilities select cursor-based PR comment sync batches", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-workflow-"));
  const cursorPath = path.join(root, "results/comment-sync-cursors/openclaw-openclaw.json");
  writeCommentSyncRecord(root, 10, "pull_request", "kept_open");
  writeCommentSyncRecord(root, 20, "pull_request", "proposed_close");
  writeCommentSyncRecord(root, 30, "pull_request", "kept_open");
  writeCommentSyncRecord(root, 40, "issue", "kept_open");
  writeCommentSyncRecord(root, 50, "pull_request", "reviewed");

  assert.deepEqual(
    withCwd(root, () =>
      commentSyncBatchOutput({
        targetRepo: "openclaw/openclaw",
        applyKind: "pull_request",
        batchSize: 2,
        cursorPath,
      }),
    ),
    {
      item_numbers: "10,20",
      count: "2",
      cursor: "0",
      next_cursor: "20",
      wrapped: "false",
    },
  );

  writeCommentSyncCursor(cursorPath, 20, "openclaw/openclaw");

  assert.deepEqual(
    withCwd(root, () =>
      commentSyncBatchOutput({
        targetRepo: "openclaw/openclaw",
        applyKind: "pull_request",
        batchSize: 2,
        cursorPath,
      }),
    ),
    {
      item_numbers: "30",
      count: "1",
      cursor: "20",
      next_cursor: "30",
      wrapped: "false",
    },
  );

  writeCommentSyncCursor(cursorPath, 99, "openclaw/openclaw");

  assert.deepEqual(
    withCwd(root, () =>
      commentSyncBatchOutput({
        targetRepo: "openclaw/openclaw",
        applyKind: "pull_request",
        batchSize: 2,
        cursorPath,
      }),
    ),
    {
      item_numbers: "10,20",
      count: "2",
      cursor: "99",
      next_cursor: "20",
      wrapped: "true",
    },
  );
});

function withCwd(cwd, callback) {
  const previous = process.cwd();
  process.chdir(cwd);
  try {
    return callback();
  } finally {
    process.chdir(previous);
  }
}

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function writeCommentSyncRecord(root, number, type, actionTaken) {
  write(
    path.join(root, `records/openclaw-openclaw/items/openclaw-openclaw-${number}.md`),
    [
      "---",
      "repository: openclaw/openclaw",
      `type: ${type}`,
      "review_status: complete",
      "item_snapshot_hash: abc123",
      `action_taken: ${actionTaken}`,
      "---",
      "",
    ].join("\n"),
  );
}
