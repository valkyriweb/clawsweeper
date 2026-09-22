import assert from "node:assert/strict";
import test from "node:test";
import { classifyReviewText } from "../../dist/repair/pr-lifecycle-classifier.js";
const env = { CLAWROUTER_API_KEY: "fixture", CLAWROUTER_BASE_URL: "https://fixture.test/v1" };
const jev = (choice = "actionable", confidence = 0.01) => ({
  model: "jev-1.13.0",
  answers: { route: { type: "choice", choice, confidence } },
});
const fallback = (classification = "actionable") => ({
  model: "claude-sonnet-5",
  content: [{ type: "text", text: JSON.stringify({ classification }) }],
});
test("Jev native choice routes without invented confidence threshold", async () => {
  const calls = [];
  const result = await classifyReviewText("Fix broken docs link", {
    env,
    fetch: async (url, options) => {
      calls.push([url, JSON.parse(options.body)]);
      return Response.json(jev());
    },
  });
  assert.equal(result.source, "jev");
  assert.equal(result.attempts, 1);
  assert.equal(result.classification, "actionable");
  assert.equal(calls[0][0], "https://fixture.test/v1/native/typesafe/v1/systemone");
  assert.equal(calls[0][1].questions.route.type, "choice");
});
test("unknown, malformed and API failure each trigger exactly one native Messages fallback", async () => {
  for (const first of [jev("unknown"), {}, null]) {
    const calls = [];
    const result = await classifyReviewText("Fix broken docs link", {
      env,
      fetch: async (url, options) => {
        calls.push([url, JSON.parse(options.body)]);
        return calls.length === 1
          ? first
            ? Response.json(first)
            : new Response("denied", { status: 403 })
          : Response.json(fallback());
      },
    });
    assert.equal(result.source, "fallback");
    assert.equal(calls.length, 2);
    assert.equal(result.attempts, 2);
    assert.equal(calls[1][0], "https://fixture.test/v1/messages");
    assert.equal(calls[1][1].max_tokens, 256);
    assert.ok(result.diagnostics.length);
  }
});
test("schema boundaries reject malformed typed answers and non-exact fallback routes", async () => {
  for (const first of [
    null,
    [],
    jev("invalid"),
    jev("actionable", "1"),
    jev("actionable", -1),
    jev("actionable", 1.1),
  ]) {
    let calls = 0;
    const result = await classifyReviewText("review", {
      env,
      fetch: async () => Response.json(++calls === 1 ? first : fallback()),
    });
    assert.equal(result.source, "fallback");
    assert.equal(calls, 2);
  }
  for (const route of [
    null,
    [],
    {},
    { classification: "actionable", extra: true },
    { classification: 1 },
  ]) {
    let calls = 0;
    const result = await classifyReviewText("review", {
      env,
      fetch: async () =>
        Response.json(
          ++calls === 1
            ? jev("unknown")
            : { content: [{ type: "text", text: JSON.stringify(route) }] },
        ),
    });
    assert.equal(result.source, "unresolved");
    assert.equal(calls, 2);
    assert.match(result.diagnostics[1], /route schema|invalid route/);
  }
});
test("both classifier failures and oversized evidence fail closed", async () => {
  let calls = 0;
  const request = async () => {
    calls++;
    return Response.json({});
  };
  assert.equal(
    (await classifyReviewText("review", { env, fetch: request })).classification,
    "unknown",
  );
  assert.equal(calls, 2);
  assert.equal((await classifyReviewText("x".repeat(24001), { env, fetch: request })).attempts, 0);
  assert.equal(calls, 2);
});
