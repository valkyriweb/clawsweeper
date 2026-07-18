// Shared streaming activity-watchdog for CLI review providers.
//
// Wraps a child CLI (codex / claude-code / pi) in a Node supervisor subprocess
// that streams stdout/stderr and enforces three independent timers:
//   - startup: no output at all within the startup grace → kill;
//   - inactivity: no output for this long after it started streaming → kill
//     (the primary stall detector — a slow-but-active review runs as long as it
//     keeps emitting, only a genuinely silent/wedged one is killed, fast);
//   - backstop: absolute cap even for a review that keeps emitting forever.
//
// A timeout maps the result to an ETIMEDOUT Error so callers' timeout detection
// (isCodexTimeoutError et al.) keeps working. Extracted from clawsweeper.ts so
// both the sweep-review lane and the commit-review providers share one
// implementation.

import { spawnSync } from "node:child_process";

export interface CliWatchdogResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error & { code?: string };
}

export const CODEX_STARTUP_TIMEOUT_MS = 60_000;
// Inactivity (idle) watchdog: kill a review subprocess that emits NO stdout or
// stderr for this long. This is the primary stall detector — a slow-but-active
// review runs as long as it keeps streaming, and only a genuinely silent
// (wedged) review is killed, fast. Override: CLAWSWEEPER_REVIEW_INACTIVITY_MS.
export const REVIEW_INACTIVITY_TIMEOUT_MS = 120_000;
// Absolute backstop: kill even a continuously-emitting review after this long.
// A pure inactivity timer can't catch a runaway that keeps printing, so this is
// the guardrail against an endless emit loop. Deliberately generous (45m) so it
// almost never fires for a legitimate long review; inactivity is what should
// normally trip first. Override: CLAWSWEEPER_REVIEW_MAX_TOTAL_MS.
export const REVIEW_MAX_TOTAL_MS = 2_700_000;

export function codexStartupTimeoutMs(): number {
  const raw = process.env.CLAWSWEEPER_CODEX_STARTUP_TIMEOUT_MS;
  if (!raw) return CODEX_STARTUP_TIMEOUT_MS;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : CODEX_STARTUP_TIMEOUT_MS;
}

export function reviewInactivityTimeoutMs(): number {
  const raw = process.env.CLAWSWEEPER_REVIEW_INACTIVITY_MS;
  if (!raw) return REVIEW_INACTIVITY_TIMEOUT_MS;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : REVIEW_INACTIVITY_TIMEOUT_MS;
}

// Absolute backstop in ms. An explicit CLAWSWEEPER_REVIEW_MAX_TOTAL_MS override
// wins; otherwise default to the generous REVIEW_MAX_TOTAL_MS but never below the
// caller's configured per-item budget, so a deliberately long --codex-timeout-ms
// still raises (never lowers) the backstop.
export function reviewMaxTotalMs(baseTimeoutMs: number): number {
  const raw = process.env.CLAWSWEEPER_REVIEW_MAX_TOTAL_MS;
  if (raw) {
    const value = Number.parseInt(raw, 10);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return Math.max(baseTimeoutMs, REVIEW_MAX_TOTAL_MS);
}

export function runCliWithActivityWatchdog(options: {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  input: string;
  inactivityMs: number;
  maxTotalMs: number;
  startupTimeoutMs: number;
}): CliWatchdogResult {
  const helper = String.raw`
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const request = JSON.parse(fs.readFileSync(0, "utf8"));
let stdout = "";
let stderr = "";
let settled = false;
let child;
function killChild(signal) {
  if (!child || child.killed) return;
  try {
    if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    try { child.kill(signal); } catch {}
  }
}
let inactivityTimer = null;
function finish(code) {
  if (settled) return;
  settled = true;
  clearTimeout(startupTimer);
  clearTimeout(backstopTimer);
  if (inactivityTimer) clearTimeout(inactivityTimer);
  process.exitCode = code;
}
let sawOutput = false;
function noteActivity() {
  if (!sawOutput) {
    sawOutput = true;
    clearTimeout(startupTimer);
  }
  if (inactivityTimer) clearTimeout(inactivityTimer);
  inactivityTimer = setTimeout(() => {
    stderr += "\n[clawsweeper] " + request.command + " inactivity timeout after " + request.inactivityMs + "ms with no stdout/stderr output\n";
    process.stderr.write("\n[clawsweeper] " + request.command + " inactivity timeout after " + request.inactivityMs + "ms with no stdout/stderr output\n");
    killChild("SIGTERM");
    setTimeout(() => killChild("SIGKILL"), 5000).unref();
    finish(124);
  }, request.inactivityMs);
  inactivityTimer.unref();
}
const startupTimer = setTimeout(() => {
  stderr += "\n[clawsweeper] " + request.command + " startup timeout after " + request.startupTimeoutMs + "ms with no stdout/stderr output\n";
  process.stderr.write("\n[clawsweeper] " + request.command + " startup timeout after " + request.startupTimeoutMs + "ms with no stdout/stderr output\n");
  killChild("SIGTERM");
  setTimeout(() => killChild("SIGKILL"), 5000).unref();
  finish(124);
}, request.startupTimeoutMs);
startupTimer.unref();
const backstopTimer = setTimeout(() => {
  stderr += "\n[clawsweeper] " + request.command + " backstop timeout after " + request.maxTotalMs + "ms\n";
  process.stderr.write("\n[clawsweeper] " + request.command + " backstop timeout after " + request.maxTotalMs + "ms\n");
  killChild("SIGTERM");
  setTimeout(() => killChild("SIGKILL"), 5000).unref();
  finish(124);
}, request.maxTotalMs);
backstopTimer.unref();
try {
  child = spawn(request.command, request.args, {
    cwd: request.cwd,
    env: request.env,
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
} catch (error) {
  stderr += String(error && error.message ? error.message : error);
  process.stderr.write(stderr);
  finish(127);
}
child.stdout.on("data", (chunk) => {
  const text = chunk.toString("utf8");
  stdout += text;
  process.stdout.write(text);
  noteActivity();
});
child.stderr.on("data", (chunk) => {
  const text = chunk.toString("utf8");
  stderr += text;
  process.stderr.write(text);
  noteActivity();
});
child.on("error", (error) => {
  stderr += String(error && error.message ? error.message : error);
  process.stderr.write(stderr);
  finish(127);
});
child.on("close", (code, signal) => {
  if (settled) return;
  if (signal) stderr += "\n[clawsweeper] " + request.command + " exited via signal " + signal + "\n";
  finish(code == null ? 1 : code);
});
child.stdin.end(request.input);
`;
  const startedAt = Date.now();
  const result = spawnSync(process.execPath, ["-e", helper], {
    cwd: options.cwd,
    encoding: "utf8",
    input: JSON.stringify(options),
    maxBuffer: 128 * 1024 * 1024,
    timeout: options.maxTotalMs + 10_000,
  });
  const normalized: CliWatchdogResult = {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
  if (result.error) normalized.error = result.error as Error & { code?: string };
  if (
    normalized.status === 124 &&
    /\[clawsweeper\] \w+ (startup|inactivity|backstop) timeout/i.test(normalized.stderr)
  ) {
    normalized.error = Object.assign(
      new Error(`spawnSync ${options.command} ETIMEDOUT after ${Date.now() - startedAt}ms`),
      { code: "ETIMEDOUT" },
    );
  }
  return normalized;
}
