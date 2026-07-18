import assert from "node:assert/strict";
import { test } from "node:test";

import { summariseTierDrift, type TierRecord } from "../src/review-tier-drift.ts";

function pr(reviewTier: string, overallTier = "B"): TierRecord {
  return { kind: "pull_request", reviewTier, overallTier };
}

function prs(reviewTier: string, count: number): TierRecord[] {
  return Array.from({ length: count }, () => pr(reviewTier));
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

test("summariseTierDrift warns when critical dominates a large-enough sample", () => {
  // 8 classified PRs, 7 critical -> above both the share and the min-sample floor.
  const summary = summariseTierDrift([...prs("critical", 7), pr("important")]);

  assert.equal(summary.warnings.length, 1);
  assert.match(summary.warnings[0], /classify-up drift toward critical/);
});

test("summariseTierDrift stays quiet below the min-sample floor", () => {
  // 4 classified PRs all critical is 100%, but too few to trust -> no warning yet.
  const summary = summariseTierDrift(prs("critical", 4));

  assert.deepEqual(summary.warnings, []);
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
    ...prs("routine", 4),
    ...prs("important", 4),
    ...prs("critical", 2),
  ]);

  assert.deepEqual(summary.warnings, []);
  assert.equal(summary.ratingByTier.routine.B, 4);
});
