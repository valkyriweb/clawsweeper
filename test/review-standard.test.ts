import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_REVIEW_STANDARD,
  classifyRiskTier,
  countHumanApprovals,
  evaluateCircuitBreaker,
  filterConsensusFindings,
  parseReviewStandardConfig,
  planReviewRound,
  summariseNoise,
  wouldAutoMerge,
  type RawFinding,
} from "../src/review-standard.ts";

test("risk tier comes from the change: docs low, code medium, sensitive paths human", () => {
  assert.equal(classifyRiskTier({ files: ["README.md", "docs/a.md"] }).tier, "low");
  assert.equal(classifyRiskTier({ files: ["src/a.ts"] }).tier, "medium");
  for (const file of [
    ".github/workflows/ci.yml",
    "src/auth/session.ts",
    "packages/billing/invoice.ts",
    "k8s/app.yaml",
    "config/secrets.json",
    ".env.production",
  ]) {
    assert.equal(classifyRiskTier({ files: ["README.md", file] }).tier, "human_required", file);
  }
});

test("flagged additive label lowers ordinary code to low, never a sensitive path", () => {
  const labels = ["risk:flagged-additive"];
  assert.equal(classifyRiskTier({ files: ["src/a.ts"], labels }).tier, "low");
  assert.equal(
    classifyRiskTier({ files: [".github/workflows/x.yml"], labels }).tier,
    "human_required",
  );
});

test("owner-listed globs force a human", () => {
  const config = { ...DEFAULT_REVIEW_STANDARD, humanRequiredPaths: ["packages/gateway/**"] };
  assert.equal(
    classifyRiskTier({ files: ["packages/gateway/src/x.ts"] }, config).tier,
    "human_required",
  );
});

test("bot approvals and approvals on old commits never count", () => {
  const n = countHumanApprovals(
    [
      { login: "luke", isBot: false, commitSha: "head" },
      { login: "LUKE", isBot: false, commitSha: "head" },
      { login: "clawsweeper[bot]", isBot: false, commitSha: "head" },
      { login: "forge", isBot: true, commitSha: "head" },
      { login: "theo", isBot: false, commitSha: "old" },
    ],
    "head",
  );
  assert.equal(n, 1);
});

function f(reviewer: string, bugClass: string, extra: Partial<RawFinding> = {}): RawFinding {
  return {
    reviewer,
    bugClass,
    path: "src/a.ts",
    line: 1,
    severity: "important",
    preExisting: false,
    summary: bugClass,
    ...extra,
  };
}

test("only majority findings survive, grouped by class with tags", () => {
  const out = filterConsensusFindings(
    [
      f("r1", "null-deref"),
      f("r2", "null-deref", { line: 9 }),
      f("r3", "lonely-claim"),
      f("r1", "old-race", { preExisting: true }),
      f("r2", "old-race", { preExisting: true }),
      f("r1", "naming", { category: "style" }),
      f("r2", "naming", { category: "style" }),
      f("r1", "tiny", { severity: "nit" }),
      f("r3", "tiny", { severity: "nit" }),
    ],
    3,
  );
  assert.deepEqual(
    out.map((x) => [x.bugClass, x.tag, x.blocking]),
    [
      ["null-deref", "important", true],
      ["tiny", "nit", false],
      ["old-race", "pre_existing", false],
    ],
  );
  assert.equal(out[0].locations.length, 2);
});

test("security findings block even when tagged nit", () => {
  const out = filterConsensusFindings(
    [
      f("r1", "ssrf", { severity: "nit", category: "security" }),
      f("r2", "ssrf", { severity: "nit" }),
    ],
    3,
  );
  assert.equal(out[0].blocking, true);
});

test("round cap switches to diff-only and suppresses repeats", () => {
  const findings = filterConsensusFindings(
    [f("r1", "a"), f("r2", "a"), f("r1", "b"), f("r2", "b")],
    3,
  );
  const r2 = planReviewRound(2, findings, new Set(["a"]));
  assert.equal(r2.scope, "full");
  assert.equal(r2.suppressedRepeats, 1);
  const r4 = planReviewRound(4, findings, new Set());
  assert.equal(r4.scope, "diff_only");
  assert.equal(r4.askAuthorToReconsider, true);
});

test("noise rate counts wrong and not-important over answered findings", () => {
  const s = summariseNoise(["fixed", "wrong", "not_important", "intentional", "open"]);
  assert.equal(s.noiseRate, 0.5);
});

test("circuit breaker trips on revert rate or incidents", () => {
  assert.equal(
    evaluateCircuitBreaker({ autoMerged: 20, reverted: 1, incidents: 0 }).tripped,
    false,
  );
  assert.equal(evaluateCircuitBreaker({ autoMerged: 20, reverted: 2, incidents: 0 }).tripped, true);
  assert.equal(evaluateCircuitBreaker({ autoMerged: 3, reverted: 2, incidents: 0 }).tripped, false);
  assert.equal(evaluateCircuitBreaker({ autoMerged: 3, reverted: 0, incidents: 2 }).tripped, true);
});

test("config defaults off and rejects live modes in phase 1", () => {
  assert.equal(parseReviewStandardConfig(undefined, "x").mode, "off");
  assert.equal(parseReviewStandardConfig({ mode: "dry_run" }, "x").mode, "dry_run");
  assert.throws(() => parseReviewStandardConfig({ mode: "live" }, "x"), /mode must be one of/);
  const risk = classifyRiskTier({ files: ["README.md"] });
  const base = {
    risk,
    ciGreen: true,
    openBlockingFindings: 0,
    unresolvedThreads: 0,
    breakerTripped: false,
  };
  assert.equal(wouldAutoMerge({ ...base, config: DEFAULT_REVIEW_STANDARD }).eligible, false);
  assert.equal(
    wouldAutoMerge({ ...base, config: { ...DEFAULT_REVIEW_STANDARD, mode: "dry_run" } }).eligible,
    true,
  );
});
