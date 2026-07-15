#!/usr/bin/env node
import type { JsonValue, LooseRecord } from "./json-types.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { deterministicAutomergeResult } from "./deterministic-automerge-result.js";
import {
  assertAllowedOwner,
  makeRunDir,
  parseArgs,
  parseJob,
  renderPrompt,
  repoRoot,
  validateJob,
} from "./lib.js";
import { repairJobIntentForFrontmatter } from "./job-intent.js";
import { automationPolicyBlockReason } from "../repository-profiles.js";
import {
  appendUsageEventJsonl,
  buildUsageTelemetryEvent,
  type UsageStatus,
} from "../usage-telemetry.js";

const args = parseArgs(process.argv.slice(2));
const jobPath = args._[0];
const mode = args.mode ?? "plan";
const dryRun = Boolean(args["dry-run"] || process.env.CLAWSWEEPER_DRY_RUN === "1");
const piModel = args.model ?? process.env.CLAWSWEEPER_MODEL ?? process.env.PI_MODEL ?? "medium";
const workerTimeoutMs = Number(
  process.env.CLAWSWEEPER_WORKER_TIMEOUT_MS ??
    process.env.CLAWSWEEPER_CODEX_TIMEOUT_MS ??
    30 * 60 * 1000,
);
const resultRepairAttempts = Math.max(
  0,
  Number(process.env.CLAWSWEEPER_RESULT_REPAIR_ATTEMPTS ?? 1),
);
const resultRepairTimeoutMs = Number(
  process.env.CLAWSWEEPER_RESULT_REPAIR_TIMEOUT_MS ?? 10 * 60 * 1000,
);
const workerStdioMaxBuffer =
  Math.max(
    1,
    Number(
      process.env.CLAWSWEEPER_WORKER_STDIO_MAX_BUFFER_MB ??
        process.env.CLAWSWEEPER_CODEX_STDIO_MAX_BUFFER_MB ??
        128,
    ),
  ) *
  1024 *
  1024;
const workerHeartbeatMs = Math.max(
  10_000,
  Number(
    process.env.CLAWSWEEPER_WORKER_HEARTBEAT_MS ??
      process.env.CLAWSWEEPER_CODEX_HEARTBEAT_MS ??
      60_000,
  ),
);

if (!jobPath) {
  console.error(
    "usage: node scripts/run-worker.ts <job.md> --mode plan|execute|autonomous [--dry-run]",
  );
  process.exit(2);
}
if (!["plan", "execute", "autonomous"].includes(mode)) {
  console.error("mode must be plan, execute, or autonomous");
  process.exit(2);
}

const job = parseJob(jobPath);
const docsMaintenanceJob = repairJobIntentForFrontmatter(job.frontmatter) === "docs_maintenance";
const effectiveWorkerTimeoutMs = workerTimeoutMs;
const errors = validateJob(job);
if (errors.length > 0) {
  console.error(errors.join("\n"));
  process.exit(1);
}

assertAllowedOwner(job.frontmatter.repo, process.env.CLAWSWEEPER_ALLOWED_OWNER);

if ((mode === "execute" || mode === "autonomous") && !dryRun) {
  const policyBlock = automationPolicyBlockReason(job.frontmatter.repo, "repair");
  if (policyBlock) throw new Error(`refusing ${mode}: ${policyBlock}`);
  if (job.frontmatter.mode !== mode) {
    throw new Error(`refusing ${mode}: job frontmatter mode is not ${mode}`);
  }
  if (process.env.CLAWSWEEPER_ALLOW_EXECUTE !== "1") {
    throw new Error(`refusing ${mode}: CLAWSWEEPER_ALLOW_EXECUTE must be 1`);
  }
}

const runDir = makeRunDir(job, mode);
const promptPath = path.join(runDir, "prompt.md");
const resultPath = path.join(runDir, "result.json");
const transcriptPath = path.join(runDir, "pi.stdout.log");
const usageEventsPath = path.join(runDir, "usage-events.jsonl");
const promptContext: Record<string, string> = {};
const targetCheckout = dryRun ? "" : prepareTargetCheckout(job);
if (targetCheckout) {
  process.env.CLAWSWEEPER_TARGET_CHECKOUT = targetCheckout;
  promptContext.targetCheckout = targetCheckout;
}

if (!dryRun && !docsMaintenanceJob) {
  const plannerArgs = [
    path.join(repoRoot(), "dist/repair/plan-cluster.js"),
    jobPath,
    "--run-dir",
    runDir,
  ];
  const planner = spawnSync(process.execPath, plannerArgs, {
    cwd: repoRoot(),
    encoding: "utf8",
    env: process.env,
  });
  if (planner.status !== 0) {
    console.error(planner.stderr || planner.stdout);
    process.exit(planner.status ?? 1);
  }
  promptContext.clusterPlanPath = path.join(runDir, "cluster-plan.json");
  promptContext.fixArtifactPath = path.join(runDir, "fix-artifact.json");
  const deterministicResult = readDeterministicResultIfAvailable({
    job,
    mode,
    clusterPlanPath: promptContext.clusterPlanPath,
  });
  if (deterministicResult) {
    fs.writeFileSync(resultPath, `${JSON.stringify(deterministicResult, null, 2)}\n`);
    console.log(`result: ${path.relative(repoRoot(), resultPath)}`);
    process.exit(0);
  }
} else if (mode === "autonomous" && !docsMaintenanceJob) {
  const plannerArgs = [
    path.join(repoRoot(), "dist/repair/plan-cluster.js"),
    jobPath,
    "--run-dir",
    runDir,
    "--offline",
  ];
  const planner = spawnSync(process.execPath, plannerArgs, {
    cwd: repoRoot(),
    encoding: "utf8",
    env: process.env,
  });
  if (planner.status !== 0) {
    console.error(planner.stderr || planner.stdout);
    process.exit(planner.status ?? 1);
  }
  promptContext.clusterPlanPath = path.join(runDir, "cluster-plan.json");
  promptContext.fixArtifactPath = path.join(runDir, "fix-artifact.json");
}

const prompt = renderPrompt(job, mode, promptContext);

fs.writeFileSync(promptPath, prompt);

if (dryRun) {
  const dryResult = {
    status: "planned",
    repo: job.frontmatter.repo,
    cluster_id: job.frontmatter.cluster_id,
    mode,
    summary: `dry run only; prompt rendered but ${workerLabel()} was not invoked`,
    actions: [],
    prompt_path: path.relative(repoRoot(), promptPath),
  };
  fs.writeFileSync(resultPath, `${JSON.stringify(dryResult, null, 2)}\n`);
  console.log(JSON.stringify(dryResult, null, 2));
  process.exit(0);
}

const child = await runPi({
  input: prompt,
  outputPath: resultPath,
  transcriptPath,
  stderrPath: path.join(runDir, "pi.stderr.log"),
  timeoutMs: effectiveWorkerTimeoutMs,
});
emitWorkerUsage({
  phase: "primary",
  transcriptPath,
  stderrPath: path.join(runDir, "pi.stderr.log"),
  timeoutMs: effectiveWorkerTimeoutMs,
  result: child,
  status: workerUsageStatus(child, resultPath, "success"),
});

if ((child.error as JsonValue)?.code === "ETIMEDOUT") {
  writeBlockedResult(`${workerLabel()} worker timed out after ${effectiveWorkerTimeoutMs}ms`);
  console.error(`${workerLabel()} worker timed out after ${effectiveWorkerTimeoutMs}ms`);
  process.exit(0);
}

if (child.error) {
  const detail = child.error.message || String(child.error);
  writeBlockedResult(`${workerLabel()} worker failed: ${detail}`);
  console.error(detail);
  process.exit(0);
}

if (child.status !== 0) {
  const detail = child.stderr || child.stdout || `${workerLabel()} worker exited ${child.status}`;
  writeBlockedResult(detail.trim());
  console.error(detail);
  process.exit(0);
}

if (!fs.existsSync(resultPath)) {
  writeBlockedResult(
    `${workerLabel()} worker completed without a structured result.json artifact.`,
  );
}
await repairResultIfNeeded();

console.log(`result: ${path.relative(repoRoot(), resultPath)}`);

function readDeterministicResultIfAvailable({
  job,
  mode,
  clusterPlanPath,
}: LooseRecord): LooseRecord | null {
  if (process.env.CLAWSWEEPER_DETERMINISTIC_AUTOMERGE_REPAIRS === "0") return null;
  if (!fs.existsSync(String(clusterPlanPath))) return null;
  const clusterPlan = JSON.parse(fs.readFileSync(String(clusterPlanPath), "utf8"));
  return deterministicAutomergeResult({ job, mode, clusterPlan });
}

function runPi({
  input,
  outputPath,
  transcriptPath: piTranscriptPath,
  stderrPath,
  timeoutMs,
}: LooseRecord) {
  const piPrompt = [
    String(input ?? ""),
    "",
    "Pi worker constraints:",
    "- Use cheap/fast explore subagents for repository and docs reading whenever broader context is needed; keep the main worker on the medium model for final judgment.",
    "- Return only JSON matching schema/repair/codex-result.schema.json; no Markdown fences, no prose outside JSON.",
  ].join("\n");
  const piArgs = [
    "--print",
    "--no-session",
    "--source",
    "child-agent",
    "--model",
    piModel,
    "--thinking",
    "medium",
    "--tools",
    "read,grep,Glob,ls,Agent",
    "--mode",
    "text",
  ];

  return spawnWorkerWithHeartbeat({
    command: "pi",
    args: piArgs,
    cwd: piWorkspaceRoot(),
    input: piPrompt,
    transcriptPath: piTranscriptPath,
    stderrPath,
    timeoutMs: Number(timeoutMs),
    outputPath,
    stdoutToOutputPath: true,
  });
}

function workerUsageStatus(
  result: LooseRecord,
  outputPath: string,
  successStatus: UsageStatus,
): UsageStatus {
  const errorCode = (result.error as LooseRecord | undefined)?.code;
  if (errorCode === "ETIMEDOUT") return "timeout";
  if (errorCode === "ENOBUFS") return "buffer_exceeded";
  if (result.error) return "failed";
  if (result.status !== 0) return "failed";
  if (!fs.existsSync(outputPath)) return "missing_result";
  return successStatus;
}

function emitWorkerUsage({
  phase,
  transcriptPath: workerTranscriptPath,
  stderrPath,
  timeoutMs,
  result,
  status,
}: LooseRecord & { status: UsageStatus }) {
  try {
    appendUsageEventJsonl(
      usageEventsPath,
      buildUsageTelemetryEvent({
        workflow: "repair-worker",
        mode,
        phase: String(phase ?? "primary"),
        provider: "pi",
        target_repo: stringValue(job.frontmatter.repo),
        cluster_id: stringValue(job.frontmatter.cluster_id),
        job_path: job.relativePath,
        model: workerModel(),
        reasoning_effort: "medium",
        sandbox: "read-only",
        timeout_ms: Number(timeoutMs),
        elapsed_ms: Number(result.elapsedMs ?? 0),
        transcript_path: path.relative(runDir, String(workerTranscriptPath)),
        ...(fs.existsSync(String(stderrPath))
          ? { stderr_path: path.relative(runDir, String(stderrPath)) }
          : {}),
        status,
        tokens: null,
      }),
    );
  } catch {
    // Telemetry must never change the repair worker outcome.
  }
}

function spawnWorkerWithHeartbeat({
  command,
  args: commandArgs,
  cwd,
  input,
  transcriptPath: workerTranscriptPath,
  stderrPath,
  timeoutMs,
  outputPath,
  stdoutToOutputPath = false,
}: LooseRecord): Promise<LooseRecord> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let timeoutError: Error | null = null;
    let bufferError: Error | null = null;

    const child = spawn(String(command), commandArgs, {
      cwd,
      env: workerEnv(),
      stdio: ["pipe", "pipe", "pipe"],
    });

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    const heartbeat = setInterval(() => {
      const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
      console.log(
        `[clawsweeper repair] ${new Date().toISOString()} ${workerLabel()} worker still running (${elapsedSeconds}s elapsed)`,
      );
    }, workerHeartbeatMs);
    const timeout = setTimeout(() => {
      timeoutError = new Error(`${workerLabel()} worker timed out after ${timeoutMs}ms`);
      (timeoutError as LooseRecord).code = "ETIMEDOUT";
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!settled) child.kill("SIGKILL");
      }, 5_000).unref();
    }, timeoutMs);

    const finish = (result: LooseRecord) => {
      if (settled) return;
      settled = true;
      clearInterval(heartbeat);
      clearTimeout(timeout);
      fs.writeFileSync(workerTranscriptPath, stdout);
      if (stdoutToOutputPath && !fs.existsSync(String(outputPath))) {
        const extracted = extractJsonObject(stdout);
        if (extracted) fs.writeFileSync(String(outputPath), `${extracted}\n`);
      }
      if (stderr) fs.writeFileSync(stderrPath, stderr);
      resolve({ ...result, elapsedMs: Date.now() - startedAt });
    };

    const append = (stream: "stdout" | "stderr", chunk: JsonValue) => {
      const text = String(chunk ?? "");
      const bytes = Buffer.byteLength(text);
      if (stream === "stdout") {
        stdout += text;
        stdoutBytes += bytes;
      } else {
        stderr += text;
        stderrBytes += bytes;
      }
      if (stdoutBytes + stderrBytes > workerStdioMaxBuffer && !bufferError) {
        bufferError = new Error(`${workerLabel()} output exceeded ${workerStdioMaxBuffer} bytes`);
        (bufferError as LooseRecord).code = "ENOBUFS";
        child.kill("SIGTERM");
      }
    };

    child.stdout.on("data", (chunk) => append("stdout", chunk));
    child.stderr.on("data", (chunk) => append("stderr", chunk));
    child.on("error", (error) => {
      finish({ status: null, stdout, stderr, error });
    });
    child.on("close", (status, signal) => {
      finish({
        status,
        signal,
        stdout,
        stderr,
        error: timeoutError ?? bufferError ?? undefined,
      });
    });

    child.stdin.end(input);
  });
}

function piWorkspaceRoot(): string {
  return targetCheckout || repoRoot();
}

async function repairResultIfNeeded() {
  for (let attempt = 1; attempt <= resultRepairAttempts; attempt += 1) {
    const review = reviewResult();
    if (review.status === 0) return;
    fs.writeFileSync(
      path.join(runDir, `review-results-failed-${attempt}.json`),
      review.stdout || review.stderr || "",
    );
    if (!fs.existsSync(resultPath)) return;

    const beforePath = path.join(runDir, `result.before-repair-${attempt}.json`);
    fs.copyFileSync(resultPath, beforePath);
    const repairPrompt = [
      "You are repairing a ClawSweeper Repair structured JSON result that failed deterministic validation.",
      "",
      "Do not mutate GitHub. Do not change the job scope. Return a complete replacement JSON result only.",
      "Fix the validation failures with the narrowest safe changes. If a PR closeout comment is missing contributor credit, update that action comment to explicitly preserve credit, including wording such as `credit`, `attribution`, `thanks @user`, or `source PR`, and keep the canonical/fix links intact.",
      "If a validator failure reveals that an action is not safely repairable from the provided artifacts, downgrade only that action to a non-mutating `keep_related`, `keep_independent`, blocked fix-first action, or `needs_human` with exact evidence.",
      "",
      "## Validator output",
      "```json",
      (review.stdout || review.stderr || "").trim(),
      "```",
      "",
      "## Current result JSON",
      "```json",
      fs.readFileSync(beforePath, "utf8").trim(),
      "```",
      "",
      "## Original worker prompt",
      "```md",
      prompt,
      "```",
    ].join("\n");

    const repairTranscriptPath = path.join(runDir, `pi-repair-${attempt}.stdout.log`);
    const repairStderrPath = path.join(runDir, `pi-repair-${attempt}.stderr.log`);
    const repair = await runPi({
      input: repairPrompt,
      outputPath: resultPath,
      transcriptPath: repairTranscriptPath,
      stderrPath: repairStderrPath,
      timeoutMs: resultRepairTimeoutMs,
    });
    emitWorkerUsage({
      phase: "result_repair",
      transcriptPath: repairTranscriptPath,
      stderrPath: repairStderrPath,
      timeoutMs: resultRepairTimeoutMs,
      result: repair,
      status: workerUsageStatus(repair, resultPath, "result_repair"),
    });
    if ((repair.error as JsonValue)?.code === "ETIMEDOUT") {
      console.error(`${workerLabel()} result repair timed out after ${resultRepairTimeoutMs}ms`);
      return;
    }
    if (repair.status !== 0) {
      console.error(
        repair.stderr || repair.stdout || `${workerLabel()} result repair exited ${repair.status}`,
      );
      return;
    }
  }
}

function reviewResult() {
  return spawnSync(
    process.execPath,
    [path.join(repoRoot(), "dist/repair/review-results.js"), runDir],
    {
      cwd: repoRoot(),
      encoding: "utf8",
      env: process.env,
    },
  );
}

function workerEnv() {
  return process.env;
}

function workerLabel(): string {
  return "Pi";
}

function workerModel(): string {
  return piModel;
}

function extractJsonObject(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    JSON.parse(trimmed);
    return trimmed;
  } catch {
    // Pi should return JSON only, but tolerate accidental surrounding logs/prose.
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  const candidate = trimmed.slice(start, end + 1);
  try {
    JSON.parse(candidate);
    return candidate;
  } catch {
    return null;
  }
}

function prepareTargetCheckout(job: LooseRecord): string {
  const explicit = stringValue(job.frontmatter.target_checkout);
  if (explicit) return explicit;

  const fromEnv = stringValue(process.env.CLAWSWEEPER_TARGET_CHECKOUT);
  if (fromEnv) return fromEnv;

  const targetRepo = String(job.frontmatter.repo ?? "");
  if (process.env.GITHUB_REPOSITORY === targetRepo) return repoRoot();

  const targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-target-"));
  const targetDir = path.join(targetRoot, targetRepo.replace(/[^A-Za-z0-9_.-]+/g, "-"));
  runCommand("gh", ["repo", "clone", targetRepo, targetDir, "--", "--depth=1"]);
  return targetDir;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function runCommand(command: string, commandArgs: string[]) {
  const result = spawnSync(command, commandArgs, {
    cwd: repoRoot(),
    encoding: "utf8",
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${commandArgs.join(" ")} failed: ${result.stderr || result.stdout}`,
    );
  }
}

function writeBlockedResult(summary: LooseRecord) {
  if (fs.existsSync(resultPath)) return;
  const result = {
    status: "blocked",
    repo: job.frontmatter.repo,
    cluster_id: job.frontmatter.cluster_id,
    mode,
    summary,
    actions: [],
    needs_human: [summary],
    canonical: null,
    canonical_issue: null,
    canonical_pr: null,
    fix_artifact: null,
  };
  fs.writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`);
}
