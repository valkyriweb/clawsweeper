#!/usr/bin/env node
// Read-only drift audit for the Z/L `reviewTier` recorded on ClawSweeper review
// records. Reports how PR reviews distribute across routine/important/critical
// so maintainers can catch classify-up drift (escalate-only + "classify up when
// ambiguous" quietly pushing every PR toward critical) without any model calls.
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
};

export const DEFAULT_THRESHOLDS: TierDriftThresholds = {
  criticalShareWarn: 0.5,
  notApplicableShareWarn: 0.5,
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

export function summariseTierDrift(
  records: TierRecord[],
  thresholds: TierDriftThresholds = DEFAULT_THRESHOLDS,
): TierDriftSummary {
  const prs = records.filter((record) => record.kind === "pull_request");
  const distribution = Object.fromEntries(REVIEW_TIERS.map((tier) => [tier, 0])) as Record<
    ReviewTier,
    number
  >;
  const ratingByTier = Object.fromEntries(REVIEW_TIERS.map((tier) => [tier, {}])) as Record<
    ReviewTier,
    Record<string, number>
  >;

  for (const record of prs) {
    const tier = normaliseTier(record.reviewTier);
    distribution[tier] += 1;
    const rating = record.overallTier || "unknown";
    ratingByTier[tier][rating] = (ratingByTier[tier][rating] ?? 0) + 1;
  }

  const totalPrs = prs.length;
  const shares = Object.fromEntries(
    REVIEW_TIERS.map((tier) => [tier, totalPrs ? distribution[tier] / totalPrs : 0]),
  ) as Record<ReviewTier, number>;

  const warnings: string[] = [];
  const classified = totalPrs - distribution.not_applicable;
  if (classified > 0) {
    const criticalShare = distribution.critical / classified;
    if (criticalShare >= thresholds.criticalShareWarn) {
      warnings.push(
        `critical is ${pct(criticalShare)} of classified PRs (>= ${pct(thresholds.criticalShareWarn)} threshold) — possible classify-up drift toward critical`,
      );
    }
  }
  if (totalPrs > 0 && shares.not_applicable >= thresholds.notApplicableShareWarn) {
    warnings.push(
      `not_applicable is ${pct(shares.not_applicable)} of PR reviews — the reviewer may not be recording reviewTier (check prompt/schema wiring)`,
    );
  }

  return { totalPrs, distribution, shares, ratingByTier, warnings };
}

function pct(value: number): string {
  return `${(value * 100).toFixed(0)}%`;
}

function frontMatterValue(markdown: string, key: string): string | undefined {
  const match = markdown.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return undefined;
  for (const line of match[1].split("\n")) {
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

function renderSummary(summary: TierDriftSummary): string {
  const lines: string[] = [];
  lines.push(`ClawSweeper reviewTier drift — ${summary.totalPrs} PR review record(s)`);
  lines.push("");
  for (const tier of REVIEW_TIERS) {
    lines.push(
      `  ${tier.padEnd(15)} ${String(summary.distribution[tier]).padStart(5)}  ${pct(summary.shares[tier]).padStart(4)}`,
    );
  }
  if (summary.warnings.length) {
    lines.push("");
    lines.push("Warnings:");
    for (const warning of summary.warnings) lines.push(`  ⚠️  ${warning}`);
  } else if (summary.totalPrs > 0) {
    lines.push("");
    lines.push("No drift warnings.");
  }
  return lines.join("\n");
}

function main(argv: string[]): void {
  const asJson = argv.includes("--json");
  const recordsArg = argv.find((arg) => arg.startsWith("--records="))?.slice("--records=".length);
  const positional = argv.find((arg) => !arg.startsWith("-"));
  const recordsDir = recordsArg ?? positional ?? "records";

  if (!fs.existsSync(recordsDir)) {
    process.stderr.write(
      `records directory not found: ${recordsDir}\n` +
        `usage: review-tier-drift [--records=<dir>] [--json]\n` +
        `point it at a ClawSweeper state checkout's records/ directory\n`,
    );
    process.exitCode = 1;
    return;
  }

  const summary = summariseTierDrift(loadRecords(recordsDir));
  process.stdout.write((asJson ? JSON.stringify(summary, null, 2) : renderSummary(summary)) + "\n");
  if (summary.warnings.length) process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2));
}
