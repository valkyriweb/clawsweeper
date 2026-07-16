import assert from "node:assert/strict";
import test from "node:test";

import { extractPiJsonPayload } from "../dist/clawsweeper.js";

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
