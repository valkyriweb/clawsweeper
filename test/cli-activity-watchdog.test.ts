import assert from "node:assert/strict";
import { delimiter, dirname } from "node:path";
import test from "node:test";
import {
  CODEX_STARTUP_TIMEOUT_MS,
  REVIEW_INACTIVITY_TIMEOUT_MS,
  REVIEW_MAX_TOTAL_MS,
  codexStartupTimeoutMs,
  reviewInactivityTimeoutMs,
  reviewMaxTotalMs,
  runCliWithActivityWatchdog,
} from "../dist/cli-activity-watchdog.js";

// Spawn a bare `node` (not process.execPath) so the watchdog's stderr message
// embeds a `\w+` command name — matching production, where the command is a
// bare binary like `codex`/`pi`/`claude` and the ETIMEDOUT mapping keys off it.
// Guarantee resolution by putting node's own dir first on PATH.
const watchdogEnv: NodeJS.ProcessEnv = {
  ...process.env,
  PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ""}`,
};

function run(
  script: string,
  timers: { startupTimeoutMs: number; inactivityMs: number; maxTotalMs: number },
) {
  return runCliWithActivityWatchdog({
    command: "node",
    args: ["-e", script],
    cwd: process.cwd(),
    env: watchdogEnv,
    input: "",
    ...timers,
  });
}

test("runs a command to completion and captures stdout + exit status", () => {
  const result = run("process.stdout.write('hello-watchdog')", {
    startupTimeoutMs: 5000,
    inactivityMs: 5000,
    maxTotalMs: 10000,
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /hello-watchdog/);
  assert.equal(result.error, undefined);
});

test("propagates a non-zero child exit status without a timeout error", () => {
  const result = run("process.stdout.write('x'); process.exit(3)", {
    startupTimeoutMs: 5000,
    inactivityMs: 5000,
    maxTotalMs: 10000,
  });
  assert.equal(result.status, 3);
  assert.equal(result.error, undefined);
});

test("kills a child that never emits output via the startup timeout", () => {
  const result = run("setInterval(() => {}, 1000)", {
    startupTimeoutMs: 500,
    inactivityMs: 5000,
    maxTotalMs: 10000,
  });
  assert.equal(result.status, 124);
  assert.equal(result.error?.code, "ETIMEDOUT");
  assert.match(result.stderr, /startup timeout after 500ms/);
  assert.doesNotMatch(result.stderr, /(inactivity|backstop) timeout/);
});

test("kills a child that emits then goes silent via the inactivity timeout", () => {
  const result = run("process.stdout.write('go'); setInterval(() => {}, 1000)", {
    startupTimeoutMs: 5000,
    inactivityMs: 500,
    maxTotalMs: 10000,
  });
  assert.equal(result.status, 124);
  assert.equal(result.error?.code, "ETIMEDOUT");
  assert.match(result.stdout, /go/);
  assert.match(result.stderr, /inactivity timeout after 500ms/);
  assert.doesNotMatch(result.stderr, /(startup|backstop) timeout/);
});

test("kills a continuously-emitting child via the absolute backstop", () => {
  // Heartbeat every 150ms (< the 1s inactivity window) so only the backstop
  // (600ms) can stop it — a pure inactivity timer never fires here.
  const result = run("setInterval(() => process.stdout.write('.'), 150)", {
    startupTimeoutMs: 5000,
    inactivityMs: 1000,
    maxTotalMs: 600,
  });
  assert.equal(result.status, 124);
  assert.equal(result.error?.code, "ETIMEDOUT");
  assert.match(result.stderr, /backstop timeout after 600ms/);
});

test("env-driven timeout helpers default to the shared constants and honor overrides", () => {
  const saved = {
    startup: process.env.CLAWSWEEPER_CODEX_STARTUP_TIMEOUT_MS,
    inactivity: process.env.CLAWSWEEPER_REVIEW_INACTIVITY_MS,
    maxTotal: process.env.CLAWSWEEPER_REVIEW_MAX_TOTAL_MS,
  };
  delete process.env.CLAWSWEEPER_CODEX_STARTUP_TIMEOUT_MS;
  delete process.env.CLAWSWEEPER_REVIEW_INACTIVITY_MS;
  delete process.env.CLAWSWEEPER_REVIEW_MAX_TOTAL_MS;
  try {
    assert.equal(codexStartupTimeoutMs(), CODEX_STARTUP_TIMEOUT_MS);
    assert.equal(reviewInactivityTimeoutMs(), REVIEW_INACTIVITY_TIMEOUT_MS);
    // Backstop never drops below the caller's configured budget.
    assert.equal(reviewMaxTotalMs(REVIEW_MAX_TOTAL_MS + 5000), REVIEW_MAX_TOTAL_MS + 5000);
    assert.equal(reviewMaxTotalMs(1000), REVIEW_MAX_TOTAL_MS);

    process.env.CLAWSWEEPER_CODEX_STARTUP_TIMEOUT_MS = "7000";
    process.env.CLAWSWEEPER_REVIEW_INACTIVITY_MS = "8000";
    process.env.CLAWSWEEPER_REVIEW_MAX_TOTAL_MS = "9000";
    assert.equal(codexStartupTimeoutMs(), 7000);
    assert.equal(reviewInactivityTimeoutMs(), 8000);
    assert.equal(reviewMaxTotalMs(1), 9000);
  } finally {
    for (const [key, value] of [
      ["CLAWSWEEPER_CODEX_STARTUP_TIMEOUT_MS", saved.startup],
      ["CLAWSWEEPER_REVIEW_INACTIVITY_MS", saved.inactivity],
      ["CLAWSWEEPER_REVIEW_MAX_TOTAL_MS", saved.maxTotal],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
