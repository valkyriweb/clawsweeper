import { readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { runText } from "./command.js";

type CheckConclusion = "success" | "failure" | "neutral" | "timed_out" | "cancelled";

export interface CommitReviewFrontMatter {
  [key: string]: string | string[] | undefined;
  sha?: string;
  repository?: string;
  author?: string;
  commit_authored_at?: string;
  commit_committed_at?: string;
  result?: string;
  confidence?: string;
  highest_severity?: string;
  check_conclusion?: string;
  reviewed_at?: string;
}

interface PublishCheckOptions {
  targetRepo: string;
  reportRepo: string;
  reportBaseUrl?: string;
  reportPath: string;
  reportRelativePath: string;
  sha: string;
  checkName: string;
  // Gate mode for the per-PR `agent-review` check: any result other than a
  // completed review (failed, inconclusive, timed out, unknown) concludes
  // `failure` so a broken review never passes a required check.
  failClosed?: boolean;
  rerunHint?: string;
  detailsUrl?: string;
}

export interface CheckRunUpdate {
  targetRepo: string;
  sha: string;
  checkName: string;
  status: "in_progress" | "completed";
  conclusion?: CheckConclusion;
  title: string;
  summary: string;
  text?: string;
  detailsUrl?: string;
  payloadPath: string;
}

function run(command: string, commandArgs: string[]): string {
  return runText(command, commandArgs);
}

export function splitFrontMatter(markdown: string): {
  frontMatter: CommitReviewFrontMatter;
  body: string;
} {
  const match = markdown.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) return { frontMatter: {}, body: markdown };
  const frontMatter: CommitReviewFrontMatter = {};
  for (const line of (match[1] ?? "").split("\n")) {
    const keyMatch = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!keyMatch) continue;
    const key = keyMatch[1] ?? "";
    let value = keyMatch[2] ?? "";
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      try {
        value = JSON.parse(value);
      } catch {
        value = value.slice(1, -1);
      }
    }
    frontMatter[key] = value;
  }
  return { frontMatter, body: markdown.slice(match[0].length) };
}

export function checkConclusionForFrontMatter(
  frontMatter: CommitReviewFrontMatter,
): CheckConclusion {
  if (frontMatter.check_conclusion) {
    const conclusion = frontMatter.check_conclusion;
    if (
      conclusion === "success" ||
      conclusion === "failure" ||
      conclusion === "neutral" ||
      conclusion === "timed_out"
    ) {
      return conclusion;
    }
  }
  if (frontMatter.result === "nothing_found") return "success";
  if (frontMatter.result === "skipped_non_code") return "success";
  if (frontMatter.result === "findings") {
    return frontMatter.highest_severity === "critical" || frontMatter.highest_severity === "high"
      ? "failure"
      : "neutral";
  }
  return "neutral";
}

export function failClosedConclusion(frontMatter: CommitReviewFrontMatter): CheckConclusion {
  if (frontMatter.result === "nothing_found" || frontMatter.result === "skipped_non_code") {
    return "success";
  }
  if (frontMatter.result === "findings") return checkConclusionForFrontMatter(frontMatter);
  return "failure";
}

function reportTitle(frontMatter: CommitReviewFrontMatter): string {
  const result = frontMatter.result ?? "inconclusive";
  if (result === "nothing_found") return "Commit review: nothing found";
  if (result === "findings") return "Commit review: findings";
  if (result === "failed") return "Commit review failed";
  return "Commit review inconclusive";
}

function reportSummary(markdown: string, frontMatter: CommitReviewFrontMatter): string {
  const { body } = splitFrontMatter(markdown);
  const summary = body
    .replace(/^# .+$/m, "")
    .trim()
    .slice(0, 6000);
  return summary || reportTitle(frontMatter);
}

function checkRunsForCommit(targetRepo: string, sha: string, name: string): { id?: number }[] {
  const encodedName = encodeURIComponent(name);
  try {
    const raw = run("gh", [
      "api",
      `repos/${targetRepo}/commits/${sha}/check-runs?check_name=${encodedName}`,
      "--jq",
      ".check_runs",
    ]);
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as { id?: number }[]) : [];
  } catch {
    return [];
  }
}

export function commitReportUrl(options: {
  reportRepo: string;
  reportBaseUrl?: string;
  reportRelativePath: string;
}): string {
  const base = options.reportBaseUrl || `https://github.com/${options.reportRepo}/blob/main`;
  return `${base.replace(/\/$/, "")}/${options.reportRelativePath}`;
}

export function upsertCheckRun(update: CheckRunUpdate): void {
  const payload: Record<string, unknown> = {
    name: update.checkName,
    head_sha: update.sha,
    status: update.status,
    output: {
      title: update.title,
      summary: update.summary,
      ...(update.text ? { text: update.text } : {}),
    },
  };
  if (update.detailsUrl) payload.details_url = update.detailsUrl;
  if (update.status === "completed") {
    payload.conclusion = update.conclusion ?? "failure";
    payload.completed_at = new Date().toISOString();
  } else {
    payload.started_at = new Date().toISOString();
  }
  writeFileSync(update.payloadPath, JSON.stringify(payload, null, 2), "utf8");
  const existing = checkRunsForCommit(update.targetRepo, update.sha, update.checkName).find(
    (checkRun) => checkRun.id,
  );
  if (existing?.id) {
    run("gh", [
      "api",
      `repos/${update.targetRepo}/check-runs/${existing.id}`,
      "--method",
      "PATCH",
      "--input",
      update.payloadPath,
    ]);
  } else {
    run("gh", [
      "api",
      `repos/${update.targetRepo}/check-runs`,
      "--method",
      "POST",
      "--input",
      update.payloadPath,
    ]);
  }
}

export function publishCheckFromReport(options: PublishCheckOptions): void {
  const markdown = readFileSync(options.reportPath, "utf8");
  const { frontMatter } = splitFrontMatter(markdown);
  const conclusion = options.failClosed
    ? failClosedConclusion(frontMatter)
    : checkConclusionForFrontMatter(frontMatter);
  const reportUrl = options.detailsUrl || commitReportUrl(options);
  const hint = conclusion === "failure" && options.rerunHint ? `\n\n${options.rerunHint}` : "";
  upsertCheckRun({
    targetRepo: options.targetRepo,
    sha: options.sha,
    checkName: options.checkName,
    status: "completed",
    conclusion,
    title: reportTitle(frontMatter),
    summary: `${reportSummary(markdown, frontMatter)}${hint}`.slice(0, 6500),
    text: `Report: ${reportUrl}`,
    detailsUrl: reportUrl,
    payloadPath: join(
      dirname(options.reportPath),
      `${basename(options.reportPath, ".md")}.check-run.json`,
    ),
  });
}
