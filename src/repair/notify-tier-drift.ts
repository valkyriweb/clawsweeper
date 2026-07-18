#!/usr/bin/env node
// Post-sweep watcher: audits the recorded Z/L `reviewTier` distribution and, only
// when a drift warning fires, posts to a dedicated Discord channel via the
// OpenClaw hook. Skips cleanly (never fails the run) when there is no drift, no
// records yet, or the drift channel/hook is not configured. No model calls.
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

import {
  loadRecords,
  pct,
  REVIEW_TIERS,
  summariseTierDrift,
  type TierDriftSummary,
} from "../review-tier-drift.js";
import {
  errorText,
  normalizeString,
  postOpenClawAgentHook,
  resolveOpenClawHookConfig,
} from "./openclaw-hook.js";

export type NotifyTierDriftRuntime = {
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  log?: (message: string) => void;
};

export type NotifyTierDriftResult = {
  status: "posted" | "skipped";
  reason: string;
  warnings: string[];
  hookRunId?: string | null;
};

function parseRecordsDir(argv: string[]): string {
  const flag = argv.find((arg) => arg.startsWith("--records="))?.slice("--records=".length);
  const positional = argv.find((arg) => !arg.startsWith("-"));
  return flag ?? positional ?? "records";
}

function driftSignature(summary: TierDriftSummary): string {
  const counts = REVIEW_TIERS.map((tier) => `${tier}:${summary.distribution[tier]}`).join(",");
  return createHash("sha256").update(counts).digest("hex").slice(0, 16);
}

export function formatDriftMessage(summary: TierDriftSummary): string {
  const distribution = REVIEW_TIERS.map(
    (tier) => `${tier} ${summary.distribution[tier]} (${pct(summary.shares[tier])})`,
  ).join(" · ");
  const warnings = summary.warnings.map((warning) => `• ${warning}`).join("\n");
  return [
    `⚠️ ClawSweeper reviewTier drift across ${summary.totalPrs} PR review(s)`,
    "",
    distribution,
    "",
    warnings,
    "",
    "Detail: `pnpm exec tsx scripts/review-tier-drift.ts --records=<state>/records`",
  ].join("\n");
}

export async function runNotifyTierDrift(
  argv: string[],
  runtime: NotifyTierDriftRuntime = {},
): Promise<NotifyTierDriftResult> {
  const env = runtime.env ?? process.env;
  const fetcher = runtime.fetch ?? fetch;
  const log = runtime.log ?? ((message: string) => process.stdout.write(`${message}\n`));
  const skip = (reason: string, warnings: string[] = []): NotifyTierDriftResult => {
    log(`skip: ${reason}`);
    return { status: "skipped", reason, warnings };
  };

  const recordsDir = parseRecordsDir(argv);
  let summary: TierDriftSummary;
  try {
    summary = summariseTierDrift(loadRecords(recordsDir));
  } catch (error) {
    return skip(`no records to audit at ${recordsDir}: ${errorText(error)}`);
  }

  if (summary.warnings.length === 0) {
    return skip(`no reviewTier drift across ${summary.totalPrs} PR review(s)`);
  }

  const driftTarget = normalizeString(env.CLAWSWEEPER_TIER_DRIFT_DISCORD_TARGET);
  if (!driftTarget) {
    return skip(
      "drift detected but CLAWSWEEPER_TIER_DRIFT_DISCORD_TARGET is unset",
      summary.warnings,
    );
  }

  // Route to the dedicated drift channel while reusing the shared hook resolution.
  const config = resolveOpenClawHookConfig({ ...env, CLAWSWEEPER_DISCORD_TARGET: driftTarget });
  if (!config) {
    return skip("drift detected but the OpenClaw hook is not configured", summary.warnings);
  }

  const result = await postOpenClawAgentHook({
    config,
    fetcher,
    post: {
      name: "ClawSweeper reviewTier drift",
      message: formatDriftMessage(summary),
      // Same distribution -> same key -> the hook dedupes repeat alerts.
      idempotencyKey: `clawsweeper-tier-drift-${driftSignature(summary)}`,
      deliver: true,
    },
  });
  log(`posted reviewTier drift alert to the drift channel (runId=${result.runId ?? "?"})`);
  return {
    status: "posted",
    reason: "drift notified",
    warnings: summary.warnings,
    hookRunId: result.runId,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runNotifyTierDrift(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`notify-tier-drift failed: ${errorText(error)}\n`);
    process.exitCode = 1;
  });
}
