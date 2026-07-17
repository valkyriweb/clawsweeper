import assert from "node:assert/strict";
import { test } from "node:test";

import { summariseTierDrift, type TierRecord } from "../scripts/review-tier-drift.ts";

function pr(reviewTier: string, overallTier = "B"): TierRecord {
  return { kind: "pull_request", reviewTier, overallTier };
}

test("summariseTierDrift counts only PR records and normalises tiers", () => {
  const summary = summariseTierDrift([
    pr("routine"),
    pr("important"),
    pr("critical"),
    pr("bogus"), // unknown tier normalises to not_applicable
    { kind: "issue", reviewTier: "critical", overallTier: "NA" }, // ignored: not a PR
  ]);

  assert.equal(summary.totalPrs, 4);
  assert.deepEqual(summary.distribution, {
    routine: 1,
    important: 1,
    critical: 1,
    not_applicable: 1,
  });
  assert.equal(summary.shares.critical, 0.25);
});

test("summariseTierDrift warns when critical dominates classified PRs", () => {
  const summary = summariseTierDrift([
    pr("critical"),
    pr("critical"),
    pr("critical"),
    pr("important"),
  ]);

  // 3/4 classified PRs are critical -> classify-up drift warning.
  assert.equal(summary.warnings.length, 1);
  assert.match(summary.warnings[0], /classify-up drift toward critical/);
});

test("summariseTierDrift warns when reviewTier is mostly unrecorded", () => {
  const summary = summariseTierDrift([pr("not_applicable"), pr("not_applicable"), pr("routine")]);

  assert.ok(
    summary.warnings.some((warning) => /may not be recording reviewTier/.test(warning)),
    "expected an unrecorded-tier warning",
  );
});

test("summariseTierDrift stays quiet on a healthy distribution", () => {
  const summary = summariseTierDrift([
    pr("routine"),
    pr("routine"),
    pr("important"),
    pr("important"),
    pr("critical"),
  ]);

  assert.deepEqual(summary.warnings, []);
  assert.equal(summary.ratingByTier.routine.B, 2);
});
