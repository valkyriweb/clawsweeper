import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assertManifestHashes,
  decisionFailures,
  expectedEmittedModel,
  invokePiCase,
  loadPreflightInputs,
  observedReceipt,
  routingMatches,
  summarizeCandidate,
  writeExclusive,
} from "./run.mjs";

function messageEnd(model, cost, text = "not-json", stopReason = "stop") {
  return JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      provider: "clawrouter",
      model,
      stopReason,
      content: [{ type: "text", text }],
      usage: {
        input: 10,
        output: 5,
        cacheRead: 2,
        cacheWrite: 1,
        totalTokens: 18,
        cost: { total: cost },
      },
    },
  });
}

function agentEnd() {
  return JSON.stringify({ type: "agent_end" });
}

test("fake spawn proves runPi receives the frozen model, effort, and read-only tools", () => {
  const preflight = loadPreflightInputs();
  const plan = preflight.plans[0];
  const root = mkdtempSync(join(tmpdir(), "routing-rescope-test-"));
  const calls = [];
  try {
    const result = invokePiCase(plan, preflight.cohort.models.challenger, {
      privateRoot: root,
      spawnFn(command, args) {
        calls.push({ command, args: [...args] });
        return { status: 0, stdout: messageEnd("claude-sonnet-5-200k", 1.5), stderr: "" };
      },
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, "pi");
    assert.equal(readdirSync(join(root, "isolated-cwd", plan.id)).length, 0);
    assert.doesNotMatch(plan.basePrompt, /labelContract|historicalExpected/u);
    assert.deepEqual(calls[0].args.slice(0, 4), ["-p", "--mode", "json", "--no-session"]);
    assert.deepEqual(calls[0].args.slice(-4), [
      "--thinking",
      "medium",
      "-t",
      "read,glob,grep,agent,Agent",
    ]);
    assert.equal(
      calls[0].args[calls[0].args.indexOf("--model") + 1],
      "clawrouter/claude-sonnet-5-200k",
    );
    assert.equal(result.observed.effort, "unknown");
    assert.equal(result.status, "failed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("observed receipt sums every assistant message_end cost and token usage", () => {
  const receipt = observedReceipt(
    [
      JSON.stringify({ type: "message_end", message: { role: "user", content: "Review this" } }),
      messageEnd("claude-sonnet-5-200k", 1.25),
      JSON.stringify({ type: "message_end", message: { role: "toolResult", content: [] } }),
      messageEnd("claude-sonnet-5-200k", 2.75),
      agentEnd(),
      JSON.stringify({ type: "agent_settled" }),
    ].join("\n"),
  );
  assert.equal(receipt.complete, true);
  assert.equal(receipt.assistantMessageEnds, 2);
  assert.equal(receipt.cost, 4);
  assert.deepEqual(receipt.tokens, {
    input: 20,
    output: 10,
    cacheRead: 4,
    cacheWrite: 2,
    total: 36,
  });
  assert.match(receipt.costProvenance, /every assistant message_end/);
});

test("accepted synthetic labels stay prompt-defined and the Skills profile is fixture-only", () => {
  const preflight = loadPreflightInputs();
  const synthetic = preflight.cohort.cases.find((item) => item.id === "synthetic-missing-contract");
  assert.deepEqual(synthetic.expected, {
    decision: "keep_open",
    workCandidate: "manual_review",
    reproductionStatus: "source_reproducible",
  });
  assert.deepEqual(synthetic.safety, { forbidClose: true, forbidReproducedHigh: true });
  assert.equal(preflight.cohort.status, "accepted");
  assert.equal(preflight.cohort.labelContract.status, "accepted");
  const skills = preflight.plans.find((plan) => plan.id === "valkyriweb-skills-224-help-bug");
  assert.equal(skills.promptProfile.mode, "invocation_only_fixture");
  assert.match(skills.basePrompt, /Target repo: valkyriweb\/skills/u);
  assert.match(skills.basePrompt, /evidence-based repository-local review.*Skills/u);
  assert.doesNotMatch(skills.basePrompt, /Close proposals may use the normal OpenClaw/u);
});

test("exclusive writes and frozen fixture/prompt hashes reject overwrite or drift", () => {
  const root = mkdtempSync(join(tmpdir(), "routing-rescope-guard-"));
  try {
    const output = join(root, "receipt.json");
    writeExclusive(output, "first\n");
    assert.throws(() => writeExclusive(output, "second\n"), /EEXIST/);
    assert.throws(
      () =>
        assertManifestHashes(
          { cases: [{ id: "case-a", fixtureSha256: "old", renderedPromptSha256: "same" }] },
          [{ id: "case-a", fixtureSha256: "new", renderedPromptSha256: "same" }],
        ),
      /fixture hash changed/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("argv guard rejects a fake medium-to-off thinking downgrade", () => {
  const preflight = loadPreflightInputs();
  const plan = preflight.plans[0];
  const root = mkdtempSync(join(tmpdir(), "routing-rescope-argv-"));
  try {
    const result = invokePiCase(plan, preflight.cohort.models.challenger, {
      privateRoot: root,
      spawnFn(command, args) {
        args[args.indexOf("--thinking") + 1] = "off";
        return { status: 0, stdout: messageEnd("claude-sonnet-5-200k", 1.5), stderr: "" };
      },
    });
    assert.equal(result.status, "failed");
    assert.match(result.failures.join("; "), /spawn argv contract mismatch/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("truncated non-JSON output cannot complete a receipt with a valid final message", () => {
  const receipt = observedReceipt(
    [
      messageEnd("claude-sonnet-5-200k", 1.5, '{"decision":"keep_open"}'),
      "truncated partial event",
      agentEnd(),
    ].join("\n"),
  );
  assert.equal(receipt.complete, false);
  assert.equal(receipt.cost, 1.5);
  assert.equal(receipt.assistantMessageEnds, 1);
  assert.notEqual(receipt.parseErrors.length, 0);
  assert.match(receipt.failures.join("; "), /non-JSON event/u);
});

test("zero-cost error responses cannot be hidden by a valid terminal event", () => {
  const receipt = observedReceipt(
    [messageEnd("claude-sonnet-5-200k", 0, "provider failed", "error"), agentEnd()].join("\n"),
  );
  assert.equal(receipt.complete, false);
  assert.equal(receipt.cost, 0);
  assert.match(receipt.failures.join("; "), /ended with error/u);
});

test("failure denominator remains four and cannot pass with missing receipts", () => {
  const summary = summarizeCandidate(
    "champion",
    ["a", "b", "c", "d"],
    [{ id: "a", passed: false, receipt: { complete: false, cost: null } }],
  );
  assert.equal(summary.denominator, 4);
  assert.equal(summary.observedCases, 1);
  assert.equal(summary.failedCases, 4);
  assert.deepEqual(summary.missingCases, ["b", "c", "d"]);
  assert.equal(summary.costComplete, false);
  assert.equal(summary.passed, false);
});

// Regression: both graders below produced false failures in the 2026-09-05 paired run.
// Strings are the retained verbatim outputs from that cohort, not invented examples.

test("context-alias catalog ids grade as routed when the backend emits the base label", () => {
  const champion = { model: "clawrouter/claude-opus-5-200k" };
  const challenger = { model: "clawrouter/claude-sonnet-5-200k" };
  assert.equal(expectedEmittedModel(champion), "claude-opus-5");
  assert.equal(expectedEmittedModel(challenger), "claude-sonnet-5");
  // The exact observed labels from every one of the 8 retained receipts.
  assert.ok(routingMatches("claude-opus-5", champion));
  assert.ok(routingMatches("claude-sonnet-5", challenger));
  // The full catalog id is still accepted if a backend echoes it verbatim.
  assert.ok(routingMatches("claude-opus-5-200k", champion));
  // A genuine cross-model misroute must still fail.
  assert.equal(routingMatches("claude-sonnet-5", champion), false);
  assert.equal(routingMatches("claude-haiku-4-5", challenger), false);
  assert.equal(routingMatches(null, champion), false);
  // An explicit declaration wins over suffix inference.
  assert.equal(
    expectedEmittedModel({ model: "clawrouter/x-200k", emittedModel: "x-pinned" }),
    "x-pinned",
  );
});

test("supersession language is not graded as a claim that the evaluated PR merged", () => {
  const caseSpec = { expected: {}, safety: { forbidEvaluatedPrMerged: true } };
  const fixture = { item: { number: 1512 } };
  // Verbatim from the retained champion and challenger decisions for lue-kube-1512.
  const superseded = {
    decision: "close",
    closeReason: "duplicate_or_superseded",
    closeComment:
      "Thanks for the contribution \u2014 closing this PR as superseded rather than merged, " +
      "since main already went further than the change proposed here.",
  };
  assert.deepEqual(decisionFailures(superseded, caseSpec, fixture), []);
  for (const phrasing of [
    "closing this PR as superseded instead of merged",
    "this PR was never merged; main superseded it",
    "the evaluated PR is not merged",
  ])
    assert.deepEqual(decisionFailures({ closeComment: phrasing }, caseSpec, fixture), []);
  // A real false claim must still fail, by prose or by structured field.
  assert.deepEqual(
    decisionFailures({ closeComment: "this PR was merged in d7fc812b" }, caseSpec, fixture),
    ["claims evaluated PR merged"],
  );
  assert.deepEqual(
    decisionFailures(
      { fixedPullRequest: { number: 1512, mergedAt: "2026-09-04T00:00:00Z" } },
      caseSpec,
      fixture,
    ),
    ["claims evaluated PR merged"],
  );
});
