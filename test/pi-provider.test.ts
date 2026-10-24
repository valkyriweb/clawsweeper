import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { extractPiJsonPayload, piStderrHead, pruneSchemaExtraKeys } from "../dist/clawsweeper.js";

function messageEnd(text: string): string {
  return JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
    },
  });
}

test("extracts JSON from a nested Pi message_end envelope", () => {
  assert.deepEqual(extractPiJsonPayload(messageEnd('{"decision":"keep_open"}')), {
    decision: "keep_open",
  });
});

test("extracts JSON from a nested Pi turn_end envelope", () => {
  const stdout = JSON.stringify({
    type: "turn_end",
    message: { role: "assistant", content: [{ type: "text", text: '{"decision":"keep_open"}' }] },
  });

  assert.deepEqual(extractPiJsonPayload(stdout), { decision: "keep_open" });
});

test("extracts JSON from a legacy Pi assistant event", () => {
  const stdout = JSON.stringify({ type: "assistant", text: '{"decision":"keep_open"}' });

  assert.deepEqual(extractPiJsonPayload(stdout), { decision: "keep_open" });
});

test("extracts JSON from a direct text envelope", () => {
  assert.deepEqual(extractPiJsonPayload(JSON.stringify({ text: '{"decision":"keep_open"}' })), {
    decision: "keep_open",
  });
});

test("extracts the final fenced JSON block after assistant prose", () => {
  const stdout = messageEnd(
    'Review complete.\n\n```json\n{"decision":"keep_open","confidence":"high"}\n```',
  );

  assert.deepEqual(extractPiJsonPayload(stdout), {
    decision: "keep_open",
    confidence: "high",
  });
});

test("extracts an unfenced JSON object suffix after assistant prose", () => {
  const stdout = messageEnd(
    'I have enough evidence.\n{"decision":"keep_open","workCandidate":"manual_review"}',
  );

  assert.deepEqual(extractPiJsonPayload(stdout), {
    decision: "keep_open",
    workCandidate: "manual_review",
  });
});

test("rejects malformed assistant output", () => {
  assert.throws(
    () => extractPiJsonPayload(messageEnd("Review complete, but no structured decision followed.")),
    /pi provider returned non-JSON payload/u,
  );
});

test("does not salvage a nested object from malformed outer JSON", () => {
  const stdout = messageEnd(
    'Review complete.\n{"decision":"invalid","debug":{"decision":"keep_open"}',
  );

  assert.throws(() => extractPiJsonPayload(stdout), /pi provider returned non-JSON payload/u);
});

test("ignores later non-assistant JSONL events", () => {
  const stdout = [
    messageEnd("Review complete, but malformed."),
    JSON.stringify({ type: "entry_appended", content: '{"decision":"keep_open"}' }),
  ].join("\n");

  assert.throws(() => extractPiJsonPayload(stdout), /pi provider returned non-JSON payload/u);
});

test("piStderrHead redacts before truncating and caps the length", () => {
  const token = `ghs_${"a".repeat(36)}`;
  assert.equal(piStderrHead(`  auth failed ${token}\n`, 20), "auth failed [REDACTE");
  assert.equal(piStderrHead("x".repeat(500)).length, 300);
  assert.equal(piStderrHead(""), "");
});

test("pruneSchemaExtraKeys drops keys the schema forbids and keeps the rest", () => {
  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      proof: {
        type: "object",
        additionalProperties: false,
        properties: { status: { type: "string" }, summary: { type: "string" } },
      },
      concerns: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: { title: { type: "string" } },
        },
      },
      open: { type: "object", properties: { known: { type: "string" } } },
    },
  };
  const dropped: string[] = [];
  const pruned = pruneSchemaExtraKeys(
    {
      proof: { status: "needed", summary: "s", summary_note: "extra" },
      concerns: [{ title: "a", severity: "x" }, { title: "b" }],
      open: { known: "k", other: 1 },
      stray: true,
    },
    schema,
    "decision",
    dropped,
  );
  assert.deepEqual(pruned, {
    proof: { status: "needed", summary: "s" },
    concerns: [{ title: "a" }, { title: "b" }],
    open: { known: "k", other: 1 },
  });
  assert.deepEqual(dropped, [
    "decision.proof.summary_note",
    "decision.concerns[0].severity",
    "decision.stray",
  ]);
});

test("pruneSchemaExtraKeys removes the stray telegramVisibleProof key seen from Pi", () => {
  const schemaUrl = new URL("../schema/clawsweeper-decision.schema.json", import.meta.url);
  const schema = JSON.parse(readFileSync(schemaUrl, "utf8"));
  const dropped: string[] = [];
  const pruned = pruneSchemaExtraKeys(
    { telegramVisibleProof: { status: "not_needed", summary: "s", summary_note: "n" } },
    schema,
    "decision",
    dropped,
  ) as { telegramVisibleProof: Record<string, unknown> };
  assert.deepEqual(pruned.telegramVisibleProof, { status: "not_needed", summary: "s" });
  assert.deepEqual(dropped, ["decision.telegramVisibleProof.summary_note"]);
});
