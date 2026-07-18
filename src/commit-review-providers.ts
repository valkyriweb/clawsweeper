// Provider-neutral transport layer for `commit-sweeper review`.
//
// Each runner takes a pre-built prompt string plus transport primitives and
// returns raw provider output (markdown) or a failure detail. Report policy
// (front-matter validation, provenance stamping, timestamp normalization,
// failure-report formatting) stays in commit-sweeper.ts so there is a single
// owner of the commit-report shape.
//
// The codex runner reproduces the previous inlined `runCodex` byte-for-byte
// (same command, args, env, stdin, buffer, timeout) behind an injectable
// SpawnFn seam. Pi and Claude Code mirror the sweep transports in
// clawsweeper.ts (runPi ~L5506, runClaudeCode ~L5299) but send the plain
// commit-review prompt (no JSON-schema wrapper) and take the terminal
// assistant text / envelope `.result` as free-form markdown.
import {
  REVIEW_MAX_TOTAL_MS,
  codexStartupTimeoutMs,
  reviewInactivityTimeoutMs,
  reviewMaxTotalMs,
  runCliWithActivityWatchdog,
} from "./cli-activity-watchdog.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { safeOutputTail } from "./clawsweeper-text.js";
import { codexEnv } from "./codex-env.js";
import {
  appendUsageEventJsonl,
  buildUsageTelemetryEvent,
  parseClaudeTokenUsageFromMessage,
  parseCodexTokenUsageFromJsonl,
  parsePiTokenUsageFromJsonl,
  type UsageStatus,
  type UsageTokens,
} from "./usage-telemetry.js";

export type CommitReviewProvider = "codex" | "pi" | "claude-code";

export const COMMIT_REVIEW_PROVIDERS: readonly CommitReviewProvider[] = [
  "codex",
  "pi",
  "claude-code",
];

export function isCommitReviewProvider(value: string): value is CommitReviewProvider {
  return (COMMIT_REVIEW_PROVIDERS as readonly string[]).includes(value);
}

// Spawn seam shared by all commit-review providers. Tests inject a fake
// matching this shape so they never touch real binaries. Mirrors the sweep
// lane's `SpawnFn`: the default routes the child through the shared streaming
// activity-watchdog (runCliWithActivityWatchdog) so a slow-but-active review
// runs to completion and only a genuinely stalled (idle) one is killed —
// inactivity/startup/backstop parity with sweep (closes the D6 gap).
export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    input?: string;
    encoding: "utf8";
    maxBuffer?: number;
    timeout?: number;
  },
) => {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error & { code?: string };
};

const defaultSpawn: SpawnFn = (command, args, options) => {
  const base =
    typeof options.timeout === "number" && options.timeout > 0
      ? options.timeout
      : REVIEW_MAX_TOTAL_MS;
  const result = runCliWithActivityWatchdog({
    command,
    args: [...args],
    cwd: options.cwd ?? process.cwd(),
    env: options.env ?? process.env,
    input: options.input ?? "",
    inactivityMs: reviewInactivityTimeoutMs(),
    maxTotalMs: reviewMaxTotalMs(base),
    startupTimeoutMs: codexStartupTimeoutMs(),
  });
  const normalized: ReturnType<SpawnFn> = {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
  if (result.error) normalized.error = result.error;
  return normalized;
};

export type CommitReviewRunResult =
  | { ok: true; markdown: string }
  | { ok: false; detail: string; timeout: boolean };

interface CodexTransportOptions {
  prompt: string;
  cwd: string;
  targetRepo: string;
  sha: string;
  model: string;
  reasoningEffort: string;
  sandboxMode: string;
  serviceTier: string;
  timeoutMs: number;
  workDir: string;
}

interface CliTransportOptions {
  prompt: string;
  cwd: string;
  targetRepo: string;
  sha: string;
  model: string;
  sandboxMode: string;
  timeoutMs: number;
  workDir: string;
}

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

const COMMIT_REVIEW_MAX_BUFFER = 128 * 1024 * 1024;

function commitReviewEnv(): NodeJS.ProcessEnv {
  return codexEnv({ ghToken: process.env.COMMIT_SWEEPER_TARGET_GH_TOKEN });
}

interface UsageInputs {
  provider: CommitReviewProvider;
  workDir: string;
  usageEventsPath: string;
  outputPath: string;
  targetRepo: string;
  sha: string;
  model: string;
  reasoningEffort?: string;
  serviceTier?: string;
  sandbox: string;
  timeoutMs: number;
}

function emitCommitUsage(
  inputs: UsageInputs,
  status: UsageStatus,
  elapsedMs: number,
  tokens: UsageTokens | null,
): void {
  try {
    appendUsageEventJsonl(
      inputs.usageEventsPath,
      buildUsageTelemetryEvent({
        workflow: "commit-review",
        mode: "commit-review",
        phase: "commit-review",
        provider: inputs.provider,
        target_repo: inputs.targetRepo,
        commit_sha: inputs.sha,
        model: inputs.model,
        ...(inputs.reasoningEffort ? { reasoning_effort: inputs.reasoningEffort } : {}),
        ...(inputs.serviceTier ? { service_tier: inputs.serviceTier } : {}),
        sandbox: inputs.sandbox,
        timeout_ms: inputs.timeoutMs,
        elapsed_ms: elapsedMs,
        output_path: relative(inputs.workDir, inputs.outputPath),
        status,
        tokens,
      }),
    );
  } catch {
    // Telemetry must never change the commit review outcome.
  }
}

// Codex commit-review transport — reproduces the previous inlined runCodex.
export function runCommitReviewCodex(
  options: CodexTransportOptions,
  spawnFn: SpawnFn = defaultSpawn,
): CommitReviewRunResult {
  ensureDir(options.workDir);
  const promptPath = join(options.workDir, `${options.sha}.prompt.md`);
  const outputPath = join(options.workDir, `${options.sha}.md`);
  const usageEventsPath = join(options.workDir, "usage-events.jsonl");
  writeFileSync(promptPath, options.prompt, "utf8");

  const codexConfig = [
    `model_reasoning_effort="${options.reasoningEffort}"`,
    'forced_login_method="chatgpt"',
    'approval_policy="never"',
  ];
  if (options.serviceTier) codexConfig.splice(1, 0, `service_tier="${options.serviceTier}"`);

  const startedAt = Date.now();
  const result = spawnFn(
    "codex",
    [
      "exec",
      "-m",
      options.model,
      ...codexConfig.flatMap((config) => ["-c", config]),
      "-C",
      options.cwd,
      "--output-last-message",
      outputPath,
      "--json",
      "--sandbox",
      options.sandboxMode,
      "-",
    ],
    {
      cwd: options.cwd,
      encoding: "utf8",
      env: commitReviewEnv(),
      input: options.prompt,
      maxBuffer: COMMIT_REVIEW_MAX_BUFFER,
      timeout: options.timeoutMs,
    },
  );
  const elapsedMs = Date.now() - startedAt;
  const tokens = parseCodexTokenUsageFromJsonl(result.stdout ?? "")?.tokens ?? null;
  const usage: UsageInputs = {
    provider: "codex",
    workDir: options.workDir,
    usageEventsPath,
    outputPath,
    targetRepo: options.targetRepo,
    sha: options.sha,
    model: options.model,
    reasoningEffort: options.reasoningEffort,
    serviceTier: options.serviceTier,
    sandbox: options.sandboxMode,
    timeoutMs: options.timeoutMs,
  };

  if (result.error || result.status !== 0 || !existsSync(outputPath)) {
    const timeout = Boolean(result.error && result.error.code === "ETIMEDOUT");
    const detail =
      result.error instanceof Error
        ? `${result.error.message}\n${safeOutputTail(result.stderr) || safeOutputTail(result.stdout)}`
        : `exit ${result.status ?? "unknown"}\n${
            safeOutputTail(result.stderr) || safeOutputTail(result.stdout) || "No output."
          }`;
    emitCommitUsage(
      usage,
      timeout ? "timeout" : result.error || result.status !== 0 ? "failed" : "missing_result",
      elapsedMs,
      tokens,
    );
    return { ok: false, detail: detail.trim(), timeout };
  }
  emitCommitUsage(usage, "success", elapsedMs, tokens);
  return { ok: true, markdown: readFileSync(outputPath, "utf8") };
}

// Pi commit-review transport — mirrors clawsweeper.ts runPi's transport
// (`pi -p --mode json --no-session [--model] [-t …]`) but sends the plain
// commit-review prompt (no JSON-schema wrapper) and returns the terminal
// assistant text as free-form markdown.
export function runCommitReviewPi(
  options: CliTransportOptions,
  spawnFn: SpawnFn = defaultSpawn,
): CommitReviewRunResult {
  ensureDir(options.workDir);
  const promptPath = join(options.workDir, `${options.sha}.pi-prompt.md`);
  const responsePath = join(options.workDir, `${options.sha}.pi-response.txt`);
  const usageEventsPath = join(options.workDir, "usage-events.jsonl");
  writeFileSync(promptPath, options.prompt, "utf8");

  const args: string[] = ["-p", "--mode", "json", "--no-session"];
  if (options.model.length > 0) args.push("--model", options.model);
  if (options.sandboxMode === "read-only") args.push("-t", "read,glob,grep,agent,Agent");

  const startedAt = Date.now();
  const result = spawnFn("pi", args, {
    cwd: options.cwd,
    encoding: "utf8",
    env: commitReviewEnv(),
    input: options.prompt,
    maxBuffer: COMMIT_REVIEW_MAX_BUFFER,
    timeout: options.timeoutMs,
  });
  const elapsedMs = Date.now() - startedAt;
  const stdout = result.stdout ?? "";
  const tokens = parsePiTokenUsageFromJsonl(stdout);
  try {
    writeFileSync(responsePath, stdout, "utf8");
  } catch {
    // Best-effort debug artifact.
  }
  const usage: UsageInputs = {
    provider: "pi",
    workDir: options.workDir,
    usageEventsPath,
    outputPath: responsePath,
    targetRepo: options.targetRepo,
    sha: options.sha,
    model: options.model,
    sandbox: options.sandboxMode,
    timeoutMs: options.timeoutMs,
  };

  if (result.error) {
    const timeout = result.error.code === "ETIMEDOUT";
    emitCommitUsage(usage, timeout ? "timeout" : "failed", elapsedMs, tokens);
    return {
      ok: false,
      timeout,
      detail: `${result.error.message}\n${
        safeOutputTail(result.stderr) || safeOutputTail(stdout) || "No output."
      }`.trim(),
    };
  }
  if (result.status !== 0) {
    emitCommitUsage(usage, "failed", elapsedMs, tokens);
    return {
      ok: false,
      timeout: false,
      detail: `exit ${result.status ?? "unknown"}\n${
        safeOutputTail(result.stderr) || safeOutputTail(stdout) || "No output."
      }`.trim(),
    };
  }

  const text = extractCommitAssistantText(stdout);
  if (text.trim().length === 0) {
    emitCommitUsage(usage, "missing_result", elapsedMs, tokens);
    return { ok: false, timeout: false, detail: "pi provider produced no assistant text." };
  }
  emitCommitUsage(usage, "success", elapsedMs, tokens);
  return { ok: true, markdown: text };
}

// Claude Code commit-review transport — mirrors clawsweeper.ts runClaudeCode
// but drops `--json-schema` so `envelope.result` is the free-form markdown
// report rather than a JSON-encoded Decision.
export function runCommitReviewClaudeCode(
  options: CliTransportOptions,
  spawnFn: SpawnFn = defaultSpawn,
): CommitReviewRunResult {
  ensureDir(options.workDir);
  const promptPath = join(options.workDir, `${options.sha}.claude-code-prompt.md`);
  const responsePath = join(options.workDir, `${options.sha}.claude-code-response.json`);
  const usageEventsPath = join(options.workDir, "usage-events.jsonl");
  writeFileSync(promptPath, options.prompt, "utf8");

  const args: string[] = ["-p", "--bare", "--output-format", "json", "--add-dir", options.cwd];
  if (options.model.length > 0) args.push("--model", options.model);
  if (options.sandboxMode === "read-only") args.push("--allowedTools", "Read Glob Grep");
  else args.push("--dangerously-skip-permissions");

  const startedAt = Date.now();
  const result = spawnFn("claude", args, {
    cwd: options.cwd,
    encoding: "utf8",
    env: commitReviewEnv(),
    input: options.prompt,
    maxBuffer: COMMIT_REVIEW_MAX_BUFFER,
    timeout: options.timeoutMs,
  });
  const elapsedMs = Date.now() - startedAt;
  const stdout = result.stdout ?? "";
  try {
    writeFileSync(responsePath, stdout, "utf8");
  } catch {
    // Best-effort debug artifact.
  }
  const usage: UsageInputs = {
    provider: "claude-code",
    workDir: options.workDir,
    usageEventsPath,
    outputPath: responsePath,
    targetRepo: options.targetRepo,
    sha: options.sha,
    model: options.model,
    sandbox: options.sandboxMode,
    timeoutMs: options.timeoutMs,
  };

  if (result.error) {
    const timeout = result.error.code === "ETIMEDOUT";
    emitCommitUsage(usage, timeout ? "timeout" : "failed", elapsedMs, null);
    return {
      ok: false,
      timeout,
      detail: `${result.error.message}\n${
        safeOutputTail(result.stderr) || safeOutputTail(stdout) || "No output."
      }`.trim(),
    };
  }
  if (result.status !== 0) {
    emitCommitUsage(usage, "failed", elapsedMs, null);
    return {
      ok: false,
      timeout: false,
      detail: `exit ${result.status ?? "unknown"}\n${
        safeOutputTail(result.stderr) || safeOutputTail(stdout) || "No output."
      }`.trim(),
    };
  }

  let envelope: { is_error?: boolean; result?: unknown; error?: string };
  try {
    envelope = JSON.parse(stdout.trim()) as typeof envelope;
  } catch (error) {
    emitCommitUsage(usage, "schema_invalid", elapsedMs, null);
    return {
      ok: false,
      timeout: false,
      detail: `non-JSON envelope (${
        error instanceof Error ? error.message : JSON.stringify(error)
      }): ${safeOutputTail(stdout)}`,
    };
  }
  const tokens = parseClaudeTokenUsageFromMessage(envelope);
  if (envelope.is_error === true) {
    emitCommitUsage(usage, "failed", elapsedMs, tokens);
    return { ok: false, timeout: false, detail: envelope.error ?? "unknown CLI error" };
  }
  const inner = envelope.result;
  if (typeof inner !== "string" || inner.trim().length === 0) {
    emitCommitUsage(usage, "missing_result", elapsedMs, tokens);
    return { ok: false, timeout: false, detail: "claude envelope.result missing or empty." };
  }
  emitCommitUsage(usage, "success", elapsedMs, tokens);
  return { ok: true, markdown: inner };
}

// --- Pi `--mode json` assistant-text extraction ---------------------------
// Local copy of clawsweeper.ts extractPiAssistantText + piAssistantTerminalText
// + assistantTextFromPiObject (~L5666–L5726). Duplicated (not imported) to keep
// commit-sweeper's runtime free of the 11k-line sweep module. Keep in sync if
// Pi's `--mode json` envelope shape changes.
export function extractCommitAssistantText(stdout: string): string {
  const single = tryParseJsonObject(stdout);
  if (single !== undefined) {
    const terminalText = piAssistantTerminalText(single);
    if (terminalText !== null) return terminalText;
    if (typeof single === "object" && single !== null && !("type" in single)) {
      return assistantTextFromPiObject(single) ?? stdout;
    }
    return stdout;
  }
  const lines = stdout.split(/\r?\n/u).filter((line) => line.trim().length > 0);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (line === undefined) continue;
    const parsed = tryParseJsonObject(line);
    if (parsed === undefined) continue;
    const text = piAssistantTerminalText(parsed);
    if (text !== null && text.length > 0) return text;
  }
  return stdout;
}

function piAssistantTerminalText(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (record["type"] === "assistant") return assistantTextFromPiObject(record);
  if (record["type"] !== "message_end" && record["type"] !== "turn_end") return null;
  const message = record["message"];
  if (typeof message !== "object" || message === null) return null;
  if ((message as Record<string, unknown>)["role"] !== "assistant") return null;
  return assistantTextFromPiObject(message);
}

function assistantTextFromPiObject(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  for (const key of ["text", "content", "result", "message"]) {
    const inner = record[key];
    if (typeof inner === "string") return inner;
  }
  if (typeof record["message"] === "object" && record["message"] !== null) {
    const nested = assistantTextFromPiObject(record["message"]);
    if (nested !== null && nested.length > 0) return nested;
  }
  if (Array.isArray(record["content"])) {
    const joined = (record["content"] as unknown[])
      .map((part) => {
        if (typeof part === "string") return part;
        if (typeof part === "object" && part !== null) {
          const partRecord = part as Record<string, unknown>;
          if (typeof partRecord["text"] === "string") return partRecord["text"];
        }
        return "";
      })
      .filter((piece) => piece.length > 0)
      .join("");
    if (joined.length > 0) return joined;
  }
  return null;
}

function tryParseJsonObject(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}
