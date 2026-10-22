// Advisory merge-risk score for pull request reviews.
//
// The rubric is adapted from the `merge-risk` skill in warpdotdev/common-skills
// (MIT, Copyright (c) 2026 Denver Technologies, Inc.; full notice in
// prompts/third-party/merge-risk-LICENSE.md), which credits the `pr` skill in
// mattpocock/skills. It was copied in by hand; no skills installer is used.
//
// ADVISORY ONLY. Nothing in this module may feed `decision`, `closeReason`,
// labels, automerge, repair dispatch, or required checks. It renders a
// separate report section, a collapsed public note, and front-matter fields so
// the score can be compared with real outcomes later.

export const MERGE_RISK_ADVISORY_DIMENSIONS = [
  { key: "alignment", label: "Alignment", weight: 1 },
  { key: "impact", label: "Impact", weight: 2 },
  { key: "verification", label: "Verification", weight: 2 },
  { key: "rollback", label: "Rollback cost", weight: 1.5 },
  { key: "errorDetection", label: "Error detection", weight: 1 },
] as const;

export type MergeRiskAdvisoryDimension = (typeof MERGE_RISK_ADVISORY_DIMENSIONS)[number]["key"];
export type MergeRiskAdvisoryVerdict = "low" | "medium" | "high" | "not_applicable";
export type MergeRiskAdvisoryBand = "low" | "medium" | "high";

export interface MergeRiskAdvisory {
  dimensions: Record<
    MergeRiskAdvisoryDimension,
    { verdict: MergeRiskAdvisoryVerdict; reason: string }
  >;
  score: number;
  band: MergeRiskAdvisoryBand;
}

const VERDICT_POINTS: Record<MergeRiskAdvisoryVerdict, number> = {
  low: 1,
  medium: 2,
  high: 3,
  // The rubric scores "N/A" like a pass.
  not_applicable: 1,
};
const VERDICTS = new Set<string>(Object.keys(VERDICT_POINTS));

export function mergeRiskAdvisoryScore(
  verdicts: Record<MergeRiskAdvisoryDimension, MergeRiskAdvisoryVerdict>,
): number {
  let total = 0;
  let weights = 0;
  for (const dimension of MERGE_RISK_ADVISORY_DIMENSIONS) {
    total += VERDICT_POINTS[verdicts[dimension.key]] * dimension.weight;
    weights += dimension.weight;
  }
  return Math.round((total / weights) * 100) / 100;
}

export function mergeRiskAdvisoryBand(score: number): MergeRiskAdvisoryBand {
  if (score >= 2.25) return "high";
  if (score >= 1.5) return "medium";
  return "low";
}

/** Raw model output for one dimension. Values are checked again at runtime. */
export interface MergeRiskAdvisoryDimensionInput {
  verdict?: string;
  reason?: string;
}
export type MergeRiskAdvisoryInput =
  | Partial<Record<MergeRiskAdvisoryDimension, MergeRiskAdvisoryDimensionInput | null | undefined>>
  | null
  | undefined;

type DimensionResult = { verdict: MergeRiskAdvisoryVerdict; reason: string };

function isVerdict(value: string | undefined): value is MergeRiskAdvisoryVerdict {
  return VERDICTS.has(value ?? "");
}

function parseDimension(
  input: MergeRiskAdvisoryDimensionInput | null | undefined,
): DimensionResult | null {
  const verdict = input?.verdict;
  if (!isVerdict(verdict)) return null;
  const reason = input?.reason;
  return { verdict, reason: reason ? String(reason).trim() : "" };
}

/**
 * Tolerant parser. A missing, malformed, or all-`not_applicable` advisory
 * returns null and never throws, so it can never fail or change a review.
 */
export function parseMergeRiskAdvisory(input: MergeRiskAdvisoryInput): MergeRiskAdvisory | null {
  if (!input || Array.isArray(input)) return null;
  const alignment = parseDimension(input.alignment);
  const impact = parseDimension(input.impact);
  const verification = parseDimension(input.verification);
  const rollback = parseDimension(input.rollback);
  const errorDetection = parseDimension(input.errorDetection);
  if (!alignment || !impact || !verification || !rollback || !errorDetection) return null;
  const dimensions = { alignment, impact, verification, rollback, errorDetection };
  const results = [alignment, impact, verification, rollback, errorDetection];
  if (results.every((entry) => entry.verdict === "not_applicable")) return null;
  const score = mergeRiskAdvisoryScore({
    alignment: alignment.verdict,
    impact: impact.verdict,
    verification: verification.verdict,
    rollback: rollback.verdict,
    errorDetection: errorDetection.verdict,
  });
  return { dimensions, score, band: mergeRiskAdvisoryBand(score) };
}

/** Rebuild an advisory from the `merge_risk_advisory_verdicts` front-matter value. */
export function mergeRiskAdvisoryFromFrontMatter(
  value: string | undefined,
): MergeRiskAdvisory | null {
  if (!value || value === "none") return null;
  const verdicts = new Map(
    value.split(",").map((pair) => {
      const [key = "", verdict = ""] = pair.split("=").map((part) => part.trim());
      return [key, { verdict }];
    }),
  );
  return parseMergeRiskAdvisory({
    alignment: verdicts.get("alignment"),
    impact: verdicts.get("impact"),
    verification: verdicts.get("verification"),
    rollback: verdicts.get("rollback"),
    errorDetection: verdicts.get("errorDetection"),
  });
}

/** Front-matter lines for the review record (score log for outcome comparison). */
export function renderMergeRiskAdvisoryFrontMatter(
  advisory: MergeRiskAdvisory | null | undefined,
): string {
  if (!advisory) {
    return ["merge_risk_advisory_score: none", "merge_risk_advisory_band: none"].join("\n");
  }
  const verdicts = MERGE_RISK_ADVISORY_DIMENSIONS.map(
    ({ key }) => `${key}=${advisory.dimensions[key].verdict}`,
  ).join(",");
  return [
    `merge_risk_advisory_score: ${advisory.score.toFixed(2)}`,
    `merge_risk_advisory_band: ${advisory.band}`,
    `merge_risk_advisory_verdicts: ${verdicts}`,
  ].join("\n");
}

const VERDICT_ICON: Record<MergeRiskAdvisoryVerdict, string> = {
  low: "✅",
  medium: "👀",
  high: "⚠️",
  not_applicable: "✅",
};

function dimensionLines(advisory: MergeRiskAdvisory): string[] {
  return MERGE_RISK_ADVISORY_DIMENSIONS.map(({ key, label }) => {
    const { verdict, reason } = advisory.dimensions[key];
    const why = reason ? ` ${reason}` : "";
    return `- **${label}:** ${VERDICT_ICON[verdict]} ${verdict.replace("_", " ")}.${why}`;
  });
}

export const MERGE_RISK_ADVISORY_NOTE =
  "Advisory only: this score never changes the review verdict, labels, automerge, or required checks.";

/** Report section body (the heading is added by the caller). */
export function renderMergeRiskAdvisoryReportSection(
  advisory: MergeRiskAdvisory | null | undefined,
): string {
  if (!advisory) return "_Not scored._";
  return [
    `Merge risk (advisory): ${advisory.band} (${advisory.score.toFixed(2)})`,
    "",
    ...dimensionLines(advisory),
    "",
    MERGE_RISK_ADVISORY_NOTE,
  ].join("\n");
}

/** Lines for the collapsed "Review details" block of the public comment. */
export function mergeRiskAdvisoryPublicDetails(
  band: string | undefined,
  score: string | undefined,
): string[] {
  if (!band || band === "none" || !score || score === "none") return [];
  return ["", `Merge risk (advisory): ${band} (${score}). ${MERGE_RISK_ADVISORY_NOTE}`];
}
