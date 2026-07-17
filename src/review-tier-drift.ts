// Pure drift-audit logic for the Z/L `reviewTier` recorded on ClawSweeper review
// records. Kept dependency-free so both the CLI (scripts/review-tier-drift.ts)
// and the post-sweep notifier (src/repair/notify-tier-drift.ts) share one
// source of truth. No model calls, no network.
import fs from "node:fs";
import path from "node:path";

export const REVIEW_TIERS = ["routine", "important", "critical", "not_applicable"] as const;
export type ReviewTier = (typeof REVIEW_TIERS)[number];

export type TierRecord = {
  kind: string;
  reviewTier: string;
  overallTier: string;
};

export type TierDriftThresholds = {
  criticalShareWarn: number;
  notApplicableShareWarn: number;
  // Suppress the critical-share warning until at least this many classified PRs
  // exist, so a single critical review can't false-alarm at 100%.
  minClassifiedForCriticalWarn: number;
};

export const DEFAULT_THRESHOLDS: TierDriftThresholds = {
  criticalShareWarn: 0.5,
  notApplicableShareWarn: 0.5,
  minClassifiedForCriticalWarn: 8,
};

export type TierDriftSummary = {
  totalPrs: number;
  distribution: Record<ReviewTier, number>;
  shares: Record<ReviewTier, number>;
  ratingByTier: Record<ReviewTier, Record<string, number>>;
  warnings: string[];
};

function normaliseTier(value: string): ReviewTier {
  return (REVIEW_TIERS as readonly string[]).includes(value)
    ? (value as ReviewTier)
    : "not_applicable";
}

export function pct(value: number): string {
  return `${(value * 100).toFixed(0)}%`;
}

export function summariseTierDrift(
  records: TierRecord[],
  thresholds: TierDriftThresholds = DEFAULT_THRESHOLDS,
): TierDriftSummary {
  const prs = records.filter((record) => record.kind === "pull_request");
  const distribution: Record<ReviewTier, number> = {
    routine: 0,
    important: 0,
    critical: 0,
    not_applicable: 0,
  };
  const ratingByTier: Record<ReviewTier, Record<string, number>> = {
    routine: {},
    important: {},
    critical: {},
    not_applicable: {},
  };

  for (const record of prs) {
    const tier = normaliseTier(record.reviewTier);
    distribution[tier] += 1;
    const rating = record.overallTier || "unknown";
    const ratings = ratingByTier[tier];
    ratings[rating] = (ratings[rating] ?? 0) + 1;
  }

  const totalPrs = prs.length;
  const shares: Record<ReviewTier, number> = {
    routine: totalPrs ? distribution.routine / totalPrs : 0,
    important: totalPrs ? distribution.important / totalPrs : 0,
    critical: totalPrs ? distribution.critical / totalPrs : 0,
    not_applicable: totalPrs ? distribution.not_applicable / totalPrs : 0,
  };

  const warnings: string[] = [];
  const classified = totalPrs - distribution.not_applicable;
  if (classified >= thresholds.minClassifiedForCriticalWarn) {
    const criticalShare = distribution.critical / classified;
    if (criticalShare >= thresholds.criticalShareWarn) {
      warnings.push(
        `critical is ${pct(criticalShare)} of ${classified} classified PRs (>= ${pct(thresholds.criticalShareWarn)} threshold) — possible classify-up drift toward critical`,
      );
    }
  }
  if (totalPrs > 0 && shares.not_applicable >= thresholds.notApplicableShareWarn) {
    warnings.push(
      `not_applicable is ${pct(shares.not_applicable)} of ${totalPrs} PR reviews — the reviewer may not be recording reviewTier (check prompt/schema wiring)`,
    );
  }

  return { totalPrs, distribution, shares, ratingByTier, warnings };
}

function frontMatterValue(markdown: string, key: string): string | undefined {
  const match = markdown.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return undefined;
  for (const line of (match[1] ?? "").split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    if (line.slice(0, idx).trim() === key) return line.slice(idx + 1).trim();
  }
  return undefined;
}

function walkMarkdown(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkMarkdown(full));
    else if (entry.isFile() && entry.name.endsWith(".md")) out.push(full);
  }
  return out;
}

export function loadRecords(recordsDir: string): TierRecord[] {
  return walkMarkdown(recordsDir).map((file) => {
    const markdown = fs.readFileSync(file, "utf8");
    return {
      kind: frontMatterValue(markdown, "type") ?? "unknown",
      reviewTier: frontMatterValue(markdown, "review_tier") ?? "not_applicable",
      overallTier: frontMatterValue(markdown, "pr_rating_overall_tier") ?? "unknown",
    };
  });
}
