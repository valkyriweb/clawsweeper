#!/usr/bin/env node
// Files one deduped `factory-failure` issue per (repo, workflow) for failed
// factory runs, and comments on the open issue for later failures.
//
// Scheduled poll, not workflow_run: it runs as one step inside the existing
// 30-minute `repair self-heal failed clusters` job on GitHub-hosted
// ubuntu-latest, so it adds no job per run and no self-hosted runner time.
// workflow_run cannot see other repositories anyway, so lue-kube's Land Queue
// is read with its own read-only App token. A source whose token is missing or
// lacks access is reported and skipped, never treated as a failure.
//
// No auto-fix, no log excerpts. valkyriweb/clawsweeper is public, so run
// titles (which can name private repos, PRs or commits) are never copied into
// the issue; workflow, job and step names pass through the shared
// redactSecrets helper and are rendered as inline code.
import { pathToFileURL } from "node:url";
import { redactSecrets } from "./collect-codex-debug.js";
import { ghText } from "./github-cli.js";
import { parseArgs } from "./lib.js";

export const FACTORY_FAILURE_LABEL = "factory-failure";
export const FAILED_CONCLUSIONS: ReadonlySet<string> = new Set([
  "failure",
  "timed_out",
  "startup_failure",
]);
const MAX_RUNS_PER_UPDATE = 10;
const MAX_RUN_PAGES = 5;

export type FactorySource = {
  repo: string;
  /** Workflow files (basename) to watch; empty means every workflow in the repo. */
  workflowFiles: string[];
  /** Workflow files that already have their own alert issue. */
  skipWorkflowFiles: string[];
  /** Run events that are developer PR checks rather than factory runs. */
  skipEvents: string[];
  /** Env var holding a token with actions:read on the repo. */
  tokenEnv: string;
};

export const DEFAULT_SOURCES: FactorySource[] = [
  {
    repo: "valkyriweb/clawsweeper",
    workflowFiles: [],
    // repair-comment-router.yml keeps its own sticky "comment router failing" issue.
    skipWorkflowFiles: ["repair-comment-router.yml"],
    skipEvents: ["pull_request", "pull_request_target", "merge_group"],
    tokenEnv: "GH_TOKEN",
  },
  {
    repo: "valkyriweb/lue-kube",
    workflowFiles: ["land-queue.yml"],
    skipWorkflowFiles: [],
    skipEvents: [],
    tokenEnv: "FACTORY_FAILURE_LUE_KUBE_TOKEN",
  },
];

export type WorkflowRunInput = {
  id?: unknown;
  run_attempt?: unknown;
  name?: unknown;
  path?: unknown;
  event?: unknown;
  status?: unknown;
  conclusion?: unknown;
  html_url?: unknown;
  head_sha?: unknown;
  head_branch?: unknown;
  updated_at?: unknown;
};

export type FailedRun = {
  repo: string;
  workflowFile: string;
  workflowName: string;
  runId: number;
  runAttempt: number;
  url: string;
  headSha: string;
  headBranch: string;
  event: string;
  conclusion: string;
  completedAt: string;
  failingJob?: string;
  failingStep?: string;
};

export type ExistingIssue = {
  number: number;
  state: string;
  body: string;
  comments: string[];
};

export type FactoryFailurePlan = {
  creates: { key: string; title: string; body: string; runs: FailedRun[] }[];
  comments: { key: string; issueNumber: number; body: string; runs: FailedRun[] }[];
  alreadyReported: number;
};

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function workflowFileOf(path: string): string {
  const clean = path.split("@")[0] ?? "";
  return clean.split("/").pop() ?? clean;
}

export function toFailedRun(repo: string, run: WorkflowRunInput, source: FactorySource) {
  if (str(run.status) !== "completed") return null;
  const conclusion = str(run.conclusion);
  // Cancelled runs are normally superseded runs, so they never count.
  if (!FAILED_CONCLUSIONS.has(conclusion)) return null;
  const workflowFile = workflowFileOf(str(run.path));
  if (!workflowFile) return null;
  if (source.workflowFiles.length > 0 && !source.workflowFiles.includes(workflowFile)) return null;
  if (source.skipWorkflowFiles.includes(workflowFile)) return null;
  const event = str(run.event);
  if (source.skipEvents.includes(event)) return null;
  const runId = Number(run.id);
  if (!Number.isSafeInteger(runId) || runId <= 0) return null;
  const attempt = Number(run.run_attempt);
  return {
    repo,
    workflowFile,
    workflowName: str(run.name) || workflowFile,
    runId,
    runAttempt: Number.isSafeInteger(attempt) && attempt > 0 ? attempt : 1,
    url: str(run.html_url),
    headSha: str(run.head_sha),
    headBranch: str(run.head_branch),
    event,
    conclusion,
    completedAt: str(run.updated_at),
  } satisfies FailedRun;
}

export function dedupeKey(repo: string, workflowFile: string): string {
  return `${repo.toLowerCase()}:${workflowFile}`;
}

export function issueMarker(key: string): string {
  return `<!-- factory-failure:${key} -->`;
}

export function runMarker(run: Pick<FailedRun, "repo" | "runId" | "runAttempt">): string {
  return `<!-- factory-failure-run:${run.repo.toLowerCase()}:${run.runId}:${run.runAttempt} -->`;
}

export function formatSast(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "unknown time";
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Johannesburg",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")} SAST`;
}

/** Redacted, single-line, mention-safe inline code. */
export function safeInline(value: string, max = 120): string {
  const flat = redactSecrets(value)
    .replace(/\p{Cc}+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  const clipped = flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
  if (!clipped) return "`-`";
  return `\`${clipped.replace(/`/g, "'")}\``;
}

function safeUrl(url: string): string {
  return /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/actions\/runs\/\d+/.test(url) ? url : "";
}

export function renderRunLine(run: FailedRun): string {
  const url = safeUrl(run.url);
  const link = url ? `[run ${run.runId}](${url})` : `run ${run.runId}`;
  const attempt = run.runAttempt > 1 ? ` attempt ${run.runAttempt}` : "";
  const sha = /^[0-9a-f]{7,40}$/i.test(run.headSha) ? `\`${run.headSha.slice(0, 12)}\`` : "`-`";
  const job = run.failingJob ? safeInline(run.failingJob) : "`unknown`";
  const step = run.failingStep ? ` step ${safeInline(run.failingStep)}` : "";
  return `- ${formatSast(run.completedAt)}: ${link}${attempt} ${run.conclusion}, head ${sha}, event \`${run.event || "-"}\`, failing job ${job}${step} ${runMarker(run)}`;
}

export function renderIssueTitle(run: FailedRun): string {
  const name = safeInline(run.workflowName, 80).slice(1, -1);
  return `Factory failure: ${name} (${run.repo})`;
}

function renderRunList(runs: FailedRun[]): string {
  const shown = runs.slice(0, MAX_RUNS_PER_UPDATE);
  const lines = shown.map(renderRunLine);
  if (runs.length > shown.length) {
    lines.push(`- ${runs.length - shown.length} more failed runs not listed here.`);
  }
  return lines.join("\n");
}

export function renderIssueBody(key: string, runs: FailedRun[]): string {
  const first = runs[0]!;
  return [
    issueMarker(key),
    `The \`${first.workflowFile}\` workflow in \`${first.repo}\` failed. This issue collects`,
    "every failed run of that workflow until it is closed. Cancelled runs are ignored.",
    "",
    "Failed runs:",
    renderRunList(runs),
    "",
    "No automatic fix is attempted. Close this issue once the workflow is healthy;",
    "the next failure after that opens a fresh issue.",
  ].join("\n");
}

export function renderComment(runs: FailedRun[]): string {
  return [`More failed runs:`, renderRunList(runs)].join("\n");
}

export function planFactoryFailureUpdates(
  failedRuns: FailedRun[],
  issues: ExistingIssue[],
): FactoryFailurePlan {
  const reported = new Set<string>();
  const openByKey = new Map<string, number>();
  for (const issue of issues) {
    const texts = [issue.body, ...issue.comments];
    for (const text of texts) {
      for (const match of text.matchAll(/<!-- factory-failure-run:[^>]+ -->/g)) {
        reported.add(match[0]);
      }
    }
    const keyMatch = /<!-- factory-failure:([^>\s]+) -->/.exec(issue.body);
    if (keyMatch?.[1] && issue.state === "open" && !openByKey.has(keyMatch[1])) {
      openByKey.set(keyMatch[1], issue.number);
    }
  }
  const byKey = new Map<string, FailedRun[]>();
  let alreadyReported = 0;
  const seen = new Set<string>();
  for (const run of failedRuns) {
    const marker = runMarker(run);
    if (reported.has(marker)) {
      alreadyReported += 1;
      continue;
    }
    if (seen.has(marker)) continue;
    seen.add(marker);
    const key = dedupeKey(run.repo, run.workflowFile);
    byKey.set(key, [...(byKey.get(key) ?? []), run]);
  }
  const plan: FactoryFailurePlan = { creates: [], comments: [], alreadyReported };
  for (const [key, runs] of byKey) {
    runs.sort((a, b) => a.completedAt.localeCompare(b.completedAt) || a.runId - b.runId);
    const issueNumber = openByKey.get(key);
    if (issueNumber !== undefined) {
      plan.comments.push({ key, issueNumber, body: renderComment(runs), runs });
    } else {
      plan.creates.push({
        key,
        title: renderIssueTitle(runs[0]!),
        body: renderIssueBody(key, runs),
        runs,
      });
    }
  }
  return plan;
}

export type GhApi = (args: string[], token: string, input?: string) => unknown;

const defaultGhApi: GhApi = (args, token, input) => {
  const text = ghText(["api", ...args], {
    env: { GH_TOKEN: token },
    ...(input === undefined ? {} : { input }),
  });
  return text ? JSON.parse(text) : null;
};

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function listFailedRuns(
  gh: GhApi,
  source: FactorySource,
  token: string,
  sinceIso: string,
): FailedRun[] {
  // Filter server-side by conclusion: a few small calls instead of paging
  // through every completed run (most are skipped intake runs).
  const out = new Map<string, FailedRun>();
  const created = encodeURIComponent(`>=${sinceIso}`);
  for (const conclusion of FAILED_CONCLUSIONS) {
    for (let page = 1; page <= MAX_RUN_PAGES; page += 1) {
      const response = asRecord(
        gh(
          [
            `repos/${source.repo}/actions/runs?status=${conclusion}&per_page=100&page=${page}&created=${created}`,
          ],
          token,
        ),
      );
      const runs = asArray(response.workflow_runs);
      for (const run of runs) {
        const failed = toFailedRun(source.repo, asRecord(run) as WorkflowRunInput, source);
        if (failed) out.set(runMarker(failed), failed);
      }
      if (runs.length < 100) break;
    }
  }
  return [...out.values()];
}

export function attachFailingJob(gh: GhApi, run: FailedRun, token: string): FailedRun {
  try {
    const response = asRecord(
      gh(
        [
          `repos/${run.repo}/actions/runs/${run.runId}/attempts/${run.runAttempt}/jobs?per_page=100`,
        ],
        token,
      ),
    );
    const jobs = asArray(response.jobs).map(asRecord);
    const job = jobs.find((entry) => FAILED_CONCLUSIONS.has(str(entry.conclusion)));
    if (!job) return run;
    const step = asArray(job.steps)
      .map(asRecord)
      .find((entry) => FAILED_CONCLUSIONS.has(str(entry.conclusion)));
    const failingStep = step ? str(step.name) : "";
    return {
      ...run,
      failingJob: str(job.name),
      ...(failingStep ? { failingStep } : {}),
    };
  } catch {
    return run;
  }
}

export function loadFactoryIssues(
  gh: GhApi,
  issueRepo: string,
  token: string,
  sinceIso: string,
): ExistingIssue[] {
  // Every open issue (however old) owns its dedupe key; closed issues only
  // matter while their run markers can still fall inside the lookback window.
  const label = `labels=${FACTORY_FAILURE_LABEL}&per_page=100&sort=updated&direction=desc`;
  const since = encodeURIComponent(sinceIso);
  const open = asArray(gh([`repos/${issueRepo}/issues?${label}&state=open`], token));
  const closed = asArray(
    gh([`repos/${issueRepo}/issues?${label}&state=closed&since=${since}`], token),
  );
  const seen = new Set<number>();
  return [...open, ...closed]
    .map(asRecord)
    .filter((issue) => !issue.pull_request)
    .filter((issue) => {
      const number = Number(issue.number);
      if (seen.has(number)) return false;
      seen.add(number);
      return true;
    })
    .map((issue) => {
      const number = Number(issue.number);
      const comments =
        Number(issue.comments) > 0
          ? asArray(
              gh(
                [`repos/${issueRepo}/issues/${number}/comments?per_page=100&since=${since}`],
                token,
              ),
            ).map((comment) => str(asRecord(comment).body))
          : [];
      return { number, state: str(issue.state), body: str(issue.body), comments };
    });
}

export function ensureLabel(gh: GhApi, issueRepo: string, token: string) {
  try {
    gh([`repos/${issueRepo}/labels/${FACTORY_FAILURE_LABEL}`], token);
  } catch {
    gh(
      ["-X", "POST", `repos/${issueRepo}/labels`, "--input", "-"],
      token,
      JSON.stringify({
        name: FACTORY_FAILURE_LABEL,
        color: "b60205",
        description: "A ClawSweeper or Land Queue factory run failed",
      }),
    );
  }
}

export type ScanOptions = {
  issueRepo: string;
  sources: FactorySource[];
  lookbackHours: number;
  dryRun: boolean;
  now: Date;
  env: Record<string, string | undefined>;
  gh?: GhApi;
};

export function scanFactoryFailures(options: ScanOptions) {
  const gh = options.gh ?? defaultGhApi;
  const issueToken = options.env.GH_TOKEN ?? "";
  if (!issueToken) throw new Error("GH_TOKEN for the issue repository is required");
  const sinceIso = new Date(
    options.now.getTime() - options.lookbackHours * 3600 * 1000,
  ).toISOString();
  const sourceNotes: { repo: string; status: string; failed?: number }[] = [];
  const failed: { run: FailedRun; token: string }[] = [];
  for (const source of options.sources) {
    const token = options.env[source.tokenEnv] ?? "";
    if (!token) {
      sourceNotes.push({ repo: source.repo, status: `skipped: ${source.tokenEnv} not set` });
      continue;
    }
    try {
      const runs = listFailedRuns(gh, source, token, sinceIso);
      for (const run of runs) failed.push({ run, token });
      sourceNotes.push({ repo: source.repo, status: "scanned", failed: runs.length });
    } catch {
      // Never echo the error text: it can carry request details.
      sourceNotes.push({ repo: source.repo, status: "skipped: run list not readable with token" });
    }
  }
  // Closed issues touched recently still suppress already-reported runs.
  const issueSince = new Date(
    options.now.getTime() - (options.lookbackHours + 24) * 3600 * 1000,
  ).toISOString();
  const issues = loadFactoryIssues(gh, options.issueRepo, issueToken, issueSince);
  const preliminary = planFactoryFailureUpdates(
    failed.map((entry) => entry.run),
    issues,
  );
  const pending = new Set(
    [...preliminary.creates, ...preliminary.comments].flatMap((update) =>
      update.runs.map(runMarker),
    ),
  );
  const enriched = failed
    .filter((entry) => pending.has(runMarker(entry.run)))
    .map((entry) => attachFailingJob(gh, entry.run, entry.token));
  const plan = planFactoryFailureUpdates(enriched, issues);
  plan.alreadyReported = preliminary.alreadyReported;
  const actions: string[] = [];
  if (!options.dryRun && (plan.creates.length > 0 || plan.comments.length > 0)) {
    if (plan.creates.length > 0) ensureLabel(gh, options.issueRepo, issueToken);
    for (const create of plan.creates) {
      const created = asRecord(
        gh(
          ["-X", "POST", `repos/${options.issueRepo}/issues`, "--input", "-"],
          issueToken,
          JSON.stringify({
            title: create.title,
            body: create.body,
            labels: [FACTORY_FAILURE_LABEL],
          }),
        ),
      );
      actions.push(`created #${String(created.number)} for ${create.key}`);
    }
    for (const comment of plan.comments) {
      gh(
        [
          "-X",
          "POST",
          `repos/${options.issueRepo}/issues/${comment.issueNumber}/comments`,
          "--input",
          "-",
        ],
        issueToken,
        JSON.stringify({ body: comment.body }),
      );
      actions.push(`commented on #${comment.issueNumber} for ${comment.key}`);
    }
  }
  return {
    status: options.dryRun ? "dry_run" : "applied",
    since: sinceIso,
    sources: sourceNotes,
    already_reported: plan.alreadyReported,
    creates: plan.creates.map((create) => ({ key: create.key, runs: create.runs.length })),
    comments: plan.comments.map((comment) => ({
      key: comment.key,
      issue: comment.issueNumber,
      runs: comment.runs.length,
    })),
    actions,
  };
}

function isMain() {
  const entry = process.argv[1];
  return Boolean(entry && import.meta.url === pathToFileURL(entry).href);
}

if (isMain()) {
  const args = parseArgs(process.argv.slice(2));
  const lookback = Number(args["lookback-hours"] ?? 3);
  if (!Number.isFinite(lookback) || lookback <= 0 || lookback > 72) {
    throw new Error("--lookback-hours must be between 0 and 72");
  }
  const result = scanFactoryFailures({
    issueRepo:
      typeof args["issue-repo"] === "string" ? args["issue-repo"] : "valkyriweb/clawsweeper",
    sources: DEFAULT_SOURCES,
    lookbackHours: lookback,
    dryRun: Boolean(args["dry-run"]),
    now: new Date(),
    env: process.env,
  });
  console.log(JSON.stringify(result, null, 2));
}
