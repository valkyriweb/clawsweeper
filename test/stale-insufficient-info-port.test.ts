// Ported from openclaw/clawsweeper@77bb944 (stale-insufficient-info apply
// guard and reproduction label selection), adapted to this fork's layout.
import assert from "node:assert/strict";
import test from "node:test";

import {
  STALE_INSUFFICIENT_INFO_MIN_INACTIVE_DAYS,
  issueRecentHumanCommentBlockReasonFromComments,
  nextReproductionLabels,
  reproductionLabelsFor,
} from "../dist/clawsweeper.js";
import { isIssueCloseDryRun, repositoryProfileFor } from "../dist/repository-profiles.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const now = Date.parse("2026-10-16T00:00:00Z");
const daysAgo = (days: number) => new Date(now - days * DAY_MS).toISOString();

test("stale-insufficient-info guard blocks a recent non-bot comment", () => {
  assert.equal(
    issueRecentHumanCommentBlockReasonFromComments(
      [{ user: { type: "User" }, created_at: daysAgo(5) }],
      STALE_INSUFFICIENT_INFO_MIN_INACTIVE_DAYS,
      now,
    ),
    "issue has a non-bot comment within the last 60 days",
  );
});

test("stale-insufficient-info guard allows bot-only and old comment history", () => {
  assert.equal(
    issueRecentHumanCommentBlockReasonFromComments(
      [
        { user: { type: "Bot" }, created_at: daysAgo(1) },
        { user: { type: "User" }, created_at: daysAgo(90) },
      ],
      60,
      now,
    ),
    null,
  );
});

test("reproduction labels follow upstream selection", () => {
  assert.deepEqual(
    reproductionLabelsFor({ reproductionStatus: "unclear", reproductionConfidence: "low" }),
    ["clawsweeper:needs-info"],
  );
  assert.deepEqual(
    reproductionLabelsFor({
      reproductionStatus: "source_reproducible",
      reproductionConfidence: "medium",
    }),
    ["clawsweeper:needs-live-repro"],
  );
  assert.deepEqual(
    reproductionLabelsFor({ reproductionStatus: "reproduced", reproductionConfidence: "high" }),
    ["clawsweeper:current-main-repro"],
  );
  assert.deepEqual(
    reproductionLabelsFor({ reproductionStatus: "not_reproduced", reproductionConfidence: "high" }),
    ["clawsweeper:not-repro-on-main"],
  );
  assert.deepEqual(
    nextReproductionLabels(["bug", "clawsweeper:needs-info"], {
      reproductionStatus: "reproduced",
      reproductionConfidence: "high",
    }),
    ["bug", "clawsweeper:current-main-repro"],
  );
});

test("issue_close_dry_run defaults on and only covers issue repro reasons", () => {
  assert.equal(isIssueCloseDryRun({}, "issue", "stale_insufficient_info"), true);
  assert.equal(isIssueCloseDryRun({}, "issue", "cannot_reproduce"), true);
  assert.equal(isIssueCloseDryRun({}, "issue", "duplicate_or_superseded"), false);
  assert.equal(isIssueCloseDryRun({}, "pull_request", "cannot_reproduce"), false);
  assert.equal(
    isIssueCloseDryRun({ issueCloseDryRun: false }, "issue", "stale_insufficient_info"),
    false,
  );
  assert.equal(repositoryProfileFor("valkyriweb/lue-kube").issueCloseDryRun, true);
});
