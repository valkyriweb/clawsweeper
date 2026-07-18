import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  COMMIT_REVIEW_PROVIDERS,
  extractCommitAssistantText,
  isCommitReviewProvider,
  runCommitReviewClaudeCode,
  runCommitReviewCodex,
  runCommitReviewPi,
  type SpawnFn,
} from "../dist/commit-review-providers.js";

const tmpPrefix = join(tmpdir(), "commit-review-providers-test-");
const SHA = "0123456789abcdef0123456789abcdef01234567";

interface Captured {
  command: string;
  args: readonly string[];
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    input?: string;
    encoding: "utf8";
    maxBuffer?: number;
    timeout?: number;
  };
}

function withWorkDir<T>(fn: (workDir: string) => T): T {
  const workDir = mkdtempSync(tmpPrefix);
  try {
    return fn(workDir);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

function lastUsageEvent(workDir: string): Record<string, unknown> {
  const raw = readFileSync(join(workDir, "usage-events.jsonl"), "utf8").trim();
  const lines = raw.split("\n").filter((line) => line.length > 0);
  const last = lines.at(-1);
  assert.ok(last, "expected a usage event");
  return JSON.parse(last) as Record<string, unknown>;
}

const baseCodexOptions = (workDir: string) => ({
  prompt: "REVIEW THIS COMMIT",
  cwd: "/repo/checkout",
  targetRepo: "owner/repo",
  sha: SHA,
  model: "gpt-5.6-terra",
  reasoningEffort: "high",
  sandboxMode: "danger-full-access",
  serviceTier: "",
  timeoutMs: 1_800_000,
  workDir,
});

const baseCliOptions = (workDir: string) => ({
  prompt: "REVIEW THIS COMMIT",
  cwd: "/repo/checkout",
  targetRepo: "owner/repo",
  sha: SHA,
  model: "claude-opus-4-8",
  sandboxMode: "read-only",
  timeoutMs: 900_000,
  workDir,
});

test("provider guard accepts exactly codex, pi, claude-code", () => {
  assert.deepEqual([...COMMIT_REVIEW_PROVIDERS], ["codex", "pi", "claude-code"]);
  assert.ok(isCommitReviewProvider("codex"));
  assert.ok(isCommitReviewProvider("pi"));
  assert.ok(isCommitReviewProvider("claude-code"));
  assert.ok(!isCommitReviewProvider("claude-bridge"));
  assert.ok(!isCommitReviewProvider(""));
});

test("codex runner spawns the exact command, args, and stdin (parity guard)", () => {
  withWorkDir((workDir) => {
    let captured: Captured | undefined;
    const spawn: SpawnFn = (command, args, options) => {
      captured = { command, args, options };
      const outputPath = args[args.indexOf("--output-last-message") + 1] ?? "";
      writeFileSync(outputPath, "# Report\n\nok\n");
      return { status: 0, stdout: "", stderr: "" };
    };
    const result = runCommitReviewCodex(baseCodexOptions(workDir), spawn);

    assert.ok(captured);
    assert.equal(captured.command, "codex");
    assert.deepEqual(
      [...captured.args],
      [
        "exec",
        "-m",
        "gpt-5.6-terra",
        "-c",
        'model_reasoning_effort="high"',
        "-c",
        'forced_login_method="chatgpt"',
        "-c",
        'approval_policy="never"',
        "-C",
        "/repo/checkout",
        "--output-last-message",
        join(workDir, `${SHA}.md`),
        "--json",
        "--sandbox",
        "danger-full-access",
        "-",
      ],
    );
    assert.equal(captured.options.cwd, "/repo/checkout");
    assert.equal(captured.options.input, "REVIEW THIS COMMIT");
    assert.equal(captured.options.maxBuffer, 128 * 1024 * 1024);
    assert.equal(captured.options.timeout, 1_800_000);
    assert.equal(captured.options.encoding, "utf8");
    assert.ok(result.ok);
    assert.equal(result.ok && result.markdown, "# Report\n\nok\n");
    assert.equal(lastUsageEvent(workDir).status, "success");
  });
});

test("codex runner inserts service_tier immediately after reasoning effort", () => {
  withWorkDir((workDir) => {
    let captured: readonly string[] = [];
    const spawn: SpawnFn = (_command, args, _options) => {
      captured = args;
      writeFileSync(args[args.indexOf("--output-last-message") + 1] ?? "", "# ok\n");
      return { status: 0, stdout: "", stderr: "" };
    };
    runCommitReviewCodex({ ...baseCodexOptions(workDir), serviceTier: "flex" }, spawn);
    const configs = captured.filter((_value, index) => captured[index - 1] === "-c");
    assert.deepEqual(configs, [
      'model_reasoning_effort="high"',
      'service_tier="flex"',
      'forced_login_method="chatgpt"',
      'approval_policy="never"',
    ]);
  });
});

test("codex runner reports a failure detail on nonzero exit with no output file", () => {
  withWorkDir((workDir) => {
    const spawn: SpawnFn = () => ({ status: 1, stdout: "", stderr: "boom" });
    const result = runCommitReviewCodex(baseCodexOptions(workDir), spawn);
    assert.ok(!result.ok);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.timeout, false);
      assert.match(result.detail, /exit 1/);
    }
    assert.equal(lastUsageEvent(workDir).status, "failed");
  });
});

test("codex runner flags timeouts via ETIMEDOUT", () => {
  withWorkDir((workDir) => {
    const spawn: SpawnFn = () => ({
      status: null,
      stdout: "",
      stderr: "",
      error: Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }),
    });
    const result = runCommitReviewCodex(baseCodexOptions(workDir), spawn);
    assert.ok(!result.ok);
    if (!result.ok) assert.equal(result.timeout, true);
    assert.equal(lastUsageEvent(workDir).status, "timeout");
  });
});

test("pi runner extracts the terminal assistant markdown from a --mode json stream", () => {
  withWorkDir((workDir) => {
    let captured: readonly string[] = [];
    const report = "---\nsha: abc\nresult: nothing_found\n---\n\n# Report\n\nLooks fine.\n";
    const stdout = [
      JSON.stringify({ type: "message_start" }),
      JSON.stringify({ type: "assistant", text: report }),
      JSON.stringify({ type: "turn_end", message: { role: "assistant", text: report } }),
    ].join("\n");
    const spawn: SpawnFn = (_command, args, _options) => {
      captured = args;
      return { status: 0, stdout, stderr: "" };
    };
    const result = runCommitReviewPi(baseCliOptions(workDir), spawn);
    assert.deepEqual(
      [...captured],
      [
        "-p",
        "--mode",
        "json",
        "--no-session",
        "--model",
        "claude-opus-4-8",
        "-t",
        "read,glob,grep,agent,Agent",
      ],
    );
    assert.ok(result.ok);
    assert.equal(result.ok && result.markdown, report);
    const event = lastUsageEvent(workDir);
    assert.equal(event.status, "success");
    assert.equal(event.provider, "pi");
  });
});

test("pi runner omits --model and tool restriction when unset / not read-only", () => {
  withWorkDir((workDir) => {
    let captured: readonly string[] = [];
    const spawn: SpawnFn = (_command, args, _options) => {
      captured = args;
      return {
        status: 0,
        stdout: JSON.stringify({ type: "assistant", text: "# ok\n" }),
        stderr: "",
      };
    };
    runCommitReviewPi(
      { ...baseCliOptions(workDir), model: "", sandboxMode: "danger-full-access" },
      spawn,
    );
    assert.deepEqual([...captured], ["-p", "--mode", "json", "--no-session"]);
  });
});

test("pi runner fails closed when the stream carries no assistant text", () => {
  withWorkDir((workDir) => {
    const spawn: SpawnFn = () => ({ status: 0, stdout: "   \n  \n", stderr: "" });
    const result = runCommitReviewPi(baseCliOptions(workDir), spawn);
    assert.ok(!result.ok);
    assert.equal(lastUsageEvent(workDir).status, "missing_result");
  });
});

test("claude-code runner sends --output-format json without a schema and takes envelope.result", () => {
  withWorkDir((workDir) => {
    let captured: readonly string[] = [];
    const report = "---\nsha: abc\nresult: nothing_found\n---\n\n# Report\n";
    const spawn: SpawnFn = (_command, args, _options) => {
      captured = args;
      return {
        status: 0,
        stdout: JSON.stringify({ type: "result", is_error: false, result: report }),
        stderr: "",
      };
    };
    const result = runCommitReviewClaudeCode(baseCliOptions(workDir), spawn);
    assert.ok(captured.includes("--output-format"));
    assert.ok(captured.includes("json"));
    assert.ok(!captured.includes("--json-schema"));
    assert.ok(captured.includes("--allowedTools"));
    assert.ok(!captured.includes("--dangerously-skip-permissions"));
    assert.ok(result.ok);
    assert.equal(result.ok && result.markdown, report);
    const event = lastUsageEvent(workDir);
    assert.equal(event.status, "success");
    assert.equal(event.provider, "claude-code");
  });
});

test("claude-code runner uses skip-permissions when not read-only", () => {
  withWorkDir((workDir) => {
    let captured: readonly string[] = [];
    const spawn: SpawnFn = (_command, args, _options) => {
      captured = args;
      return {
        status: 0,
        stdout: JSON.stringify({ type: "result", is_error: false, result: "---\nsha: a\n---\n" }),
        stderr: "",
      };
    };
    runCommitReviewClaudeCode(
      { ...baseCliOptions(workDir), sandboxMode: "workspace-write" },
      spawn,
    );
    assert.ok(captured.includes("--dangerously-skip-permissions"));
    assert.ok(!captured.includes("--allowedTools"));
  });
});

test("claude-code runner fails closed on an error envelope", () => {
  withWorkDir((workDir) => {
    const spawn: SpawnFn = () => ({
      status: 0,
      stdout: JSON.stringify({ type: "result", is_error: true, error: "model refused" }),
      stderr: "",
    });
    const result = runCommitReviewClaudeCode(baseCliOptions(workDir), spawn);
    assert.ok(!result.ok);
    if (!result.ok) assert.match(result.detail, /model refused/);
    assert.equal(lastUsageEvent(workDir).status, "failed");
  });
});

test("claude-code runner fails closed on a non-JSON envelope", () => {
  withWorkDir((workDir) => {
    const spawn: SpawnFn = () => ({ status: 0, stdout: "not json at all", stderr: "" });
    const result = runCommitReviewClaudeCode(baseCliOptions(workDir), spawn);
    assert.ok(!result.ok);
    assert.equal(lastUsageEvent(workDir).status, "schema_invalid");
  });
});

test("extractCommitAssistantText scans JSONL bottom-up for the terminal assistant text", () => {
  const text = "# Report body";
  const stdout = [
    JSON.stringify({ type: "assistant", text: "intermediate" }),
    JSON.stringify({ type: "message_end", message: { role: "assistant", content: text } }),
  ].join("\n");
  assert.equal(extractCommitAssistantText(stdout), text);
});
