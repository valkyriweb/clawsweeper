import assert from "node:assert/strict";
import { test } from "node:test";

import {
  mergeRiskAdvisoryFromFrontMatter,
  mergeRiskAdvisoryPublicDetails,
  parseMergeRiskAdvisory,
  renderMergeRiskAdvisoryFrontMatter,
  renderMergeRiskAdvisoryReportSection,
} from "../src/merge-risk-advisory.ts";

type V = "low" | "medium" | "high" | "not_applicable";
function advisory(a: V, i: V, v: V, r: V, e: V) {
  const dim = (verdict: V) => ({ verdict, reason: `because ${verdict}` });
  return {
    alignment: dim(a),
    impact: dim(i),
    verification: dim(v),
    rollback: dim(r),
    errorDetection: dim(e),
  };
}

test("merge-risk advisory uses the rubric weights and bands", () => {
  // Weights: alignment 1, impact 2, verification 2, rollback 1.5, error detection 1.
  assert.deepEqual(
    [
      parseMergeRiskAdvisory(advisory("low", "high", "medium", "high", "medium")),
      parseMergeRiskAdvisory(advisory("low", "medium", "medium", "low", "low")),
      parseMergeRiskAdvisory(advisory("low", "medium", "low", "low", "medium")),
    ].map((entry) => [entry?.score, entry?.band]),
    [
      [2.33, "high"],
      [1.53, "medium"],
      [1.4, "low"],
    ],
  );
});

test("merge-risk advisory treats not_applicable as a pass", () => {
  const entry = parseMergeRiskAdvisory(advisory("low", "low", "low", "low", "not_applicable"));
  assert.equal(entry?.score, 1);
  assert.equal(entry?.band, "low");
});

test("merge-risk advisory parsing never throws on bad input", () => {
  for (const value of [
    undefined,
    null,
    "high",
    [],
    {},
    { ...advisory("low", "low", "low", "low", "low"), impact: { verdict: "huge" } },
    advisory(
      "not_applicable",
      "not_applicable",
      "not_applicable",
      "not_applicable",
      "not_applicable",
    ),
  ]) {
    assert.equal(parseMergeRiskAdvisory(value), null);
  }
});

test("merge-risk advisory front matter round-trips the score", () => {
  const entry = parseMergeRiskAdvisory(advisory("low", "high", "medium", "medium", "medium"));
  const frontMatter = renderMergeRiskAdvisoryFrontMatter(entry);
  assert.match(frontMatter, /^merge_risk_advisory_score: 2\.13$/m);
  assert.match(frontMatter, /^merge_risk_advisory_band: medium$/m);
  const verdicts = /^merge_risk_advisory_verdicts: (.+)$/m.exec(frontMatter)?.[1];
  assert.equal(mergeRiskAdvisoryFromFrontMatter(verdicts)?.score, 2.13);
  assert.equal(
    renderMergeRiskAdvisoryFrontMatter(null),
    "merge_risk_advisory_score: none\nmerge_risk_advisory_band: none",
  );
});

test("merge-risk advisory renders as advisory only", () => {
  const entry = parseMergeRiskAdvisory(advisory("low", "high", "medium", "high", "medium"));
  const section = renderMergeRiskAdvisoryReportSection(entry);
  assert.match(section, /Merge risk \(advisory\): high \(2\.33\)/);
  assert.match(section, /never changes the review verdict/);
  assert.equal(renderMergeRiskAdvisoryReportSection(null), "_Not scored._");
  assert.deepEqual(mergeRiskAdvisoryPublicDetails("none", "none"), []);
  assert.match(mergeRiskAdvisoryPublicDetails("high", "2.33").join("\n"), /advisory\): high/);
});
