#!/usr/bin/env node
// Read-only CLI for the Z/L `reviewTier` drift audit. Point it at a ClawSweeper
// state checkout's records/ to see how PR reviews distribute across
// routine/important/critical and catch classify-up drift — no model calls.
// Core logic lives in ../src/review-tier-drift.ts (shared with the notifier).
import fs from "node:fs";

import {
  loadRecords,
  pct,
  REVIEW_TIERS,
  summariseTierDrift,
  type TierDriftSummary,
} from "../src/review-tier-drift.ts";

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
