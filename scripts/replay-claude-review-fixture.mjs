#!/usr/bin/env node
// Replay the saved scar issue-08 Claude structured-review payload through
// runClaude (scar: agent-scripts/SCARS/issue-08-llm-output-token-cap-structured-review.md).
//
// The stub bridge behaves like the model in the scar: finishing the
// submit_decision call needs ~9.9K output tokens, so any request with
// max_tokens below that gets the saved truncated response
// (stop_reason=max_tokens, output_tokens=8191). Larger caps get the saved
// complete response.
//
//   node scripts/replay-claude-review-fixture.mjs after      # shipped ladder (16384 -> 32768)
//   node scripts/replay-claude-review-fixture.mjs exhausted  # every rung truncates
//   DIST=/old/dist node scripts/replay-claude-review-fixture.mjs before
//       # pre-#55 build (hardcoded max_tokens: 8192, no retry, no receipt)
//
// Prints one receipt line: requests, decision, confidence, truncated,
// stop_reason, output_tokens, max_tokens, attempts.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dist = process.env.DIST ?? join(here, "..", "dist");
const mod = await import(pathToFileURL(join(dist, "clawsweeper.js")).href);
const fixturesDir = join(here, "..", "test", "fixtures");
const truncatedBody = readFileSync(
  join(fixturesDir, "claude-review-truncated-max-tokens.json"),
  "utf8",
);
const completeBody = readFileSync(join(fixturesDir, "claude-review-complete-retry.json"), "utf8");

const mode = process.argv[2] ?? "after";
let needed = JSON.parse(completeBody).usage.output_tokens;
if (mode === "exhausted") needed = Number.MAX_SAFE_INTEGER;
else if (mode !== "after" && mode !== "before") {
  console.error("usage: replay-claude-review-fixture.mjs after|exhausted|before");
  process.exit(2);
}
delete process.env.CLAWSWEEPER_CLAUDE_REVIEW_MAX_TOKENS;
delete process.env.CLAWSWEEPER_CLAUDE_REVIEW_RETRY_MAX_TOKENS;

const requests = [];
let receipt;
const workDir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "claude-replay-"));
let decision;
let failure = "";
try {
  decision = mod.runClaude({
    item: { number: 12, repo: "valkyriweb/openclaw-claude" },
    context: {},
    git: {},
    model: "claude-sonnet-4-5-20250929",
    openclawDir: workDir,
    reasoningEffort: "low",
    sandboxMode: "read-only",
    serviceTier: "default",
    timeoutMs: 60_000,
    workDir,
    prompt: "Replay prompt (fixture).",
    bridgeUrl: "http://127.0.0.1:9100",
    postFn: ({ body }) => {
      requests.push(body.max_tokens);
      return { status: 200, body: body.max_tokens < needed ? truncatedBody : completeBody };
    },
    onOutputReceipt: (value) => {
      receipt = value;
    },
  });
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
  decision = mod.codexFailureDecision("claude-bridge", null, failure);
}
// Pre-receipt builds (the "before" baseline) do not export the receipt mapper.
const runtime =
  "reviewRuntimeFromOutputReceipt" in mod ? mod.reviewRuntimeFromOutputReceipt(receipt) : {};
const field = (value) => (value === undefined ? "absent" : String(value));
console.log(
  [
    `mode=${mode}`,
    `requests=${requests.join(",")}`,
    `decision=${decision.decision}`,
    `confidence=${decision.confidence}`,
    `truncated=${field(runtime.outputTruncated)}`,
    `stop_reason=${field(runtime.outputStopReason)}`,
    `output_tokens=${field(runtime.outputTokens)}`,
    `max_tokens=${field(runtime.outputMaxTokens)}`,
    `attempts=${field(runtime.outputAttempts)}`,
    `summary=${JSON.stringify(decision.summary)}`,
  ].join(" "),
);
if (failure) console.log(`failure=${JSON.stringify(failure)}`);
