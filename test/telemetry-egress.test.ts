import assert from "node:assert/strict";
import test from "node:test";

import {
  type FetchLike,
  canaryOtlpBody,
  classifyStatus,
  probeTarget,
  resolveEgressTargets,
} from "../scripts/check-telemetry-egress.ts";

test("classifyStatus treats 5xx as DOWN and everything below 500 as reachable", () => {
  // Reachable / serving (a 401 is an auth gate on a healthy ingest endpoint).
  for (const status of [200, 202, 204, 301, 400, 401, 404, 429]) {
    assert.equal(classifyStatus(status).ok, true, `expected ${status} reachable`);
  }
  // The incident surface: Opik 502, SigNoz 504, plus 500/503.
  for (const status of [500, 502, 503, 504]) {
    const result = classifyStatus(status);
    assert.equal(result.ok, false, `expected ${status} DOWN`);
    assert.equal(result.detail, `http_${status}`);
  }
});

test("resolveEgressTargets combines the OTLP endpoint with the extra target list", () => {
  const targets = resolveEgressTargets({
    CLAWSWEEPER_USAGE_OTLP_ENDPOINT: "http://127.0.0.1:4318/v1/traces",
    CLAWSWEEPER_USAGE_EGRESS_TARGETS:
      "opik=https://opik.example/api/v1/private/otel/v1/traces, https://otel.example/v1/traces",
  } as NodeJS.ProcessEnv);

  assert.deepEqual(targets, [
    { name: "collector", url: "http://127.0.0.1:4318/v1/traces" },
    { name: "opik", url: "https://opik.example/api/v1/private/otel/v1/traces" },
    { name: "otel.example", url: "https://otel.example/v1/traces" },
  ]);
});

test("resolveEgressTargets de-duplicates by URL and returns empty when unconfigured", () => {
  assert.deepEqual(resolveEgressTargets({} as NodeJS.ProcessEnv), []);

  const deduped = resolveEgressTargets({
    CLAWSWEEPER_USAGE_OTLP_ENDPOINT: "http://c/v1/traces",
    CLAWSWEEPER_USAGE_EGRESS_TARGETS: "dup=http://c/v1/traces",
  } as NodeJS.ProcessEnv);
  assert.equal(deduped.length, 1);
  assert.equal(deduped[0]?.name, "collector");
});

test("canaryOtlpBody emits one valid span with a 32-char trace id", () => {
  const payload = JSON.parse(canaryOtlpBody({} as NodeJS.ProcessEnv));
  const span = payload.resourceSpans[0].scopeSpans[0].spans[0];
  assert.equal(payload.resourceSpans.length, 1);
  assert.equal(span.name, "clawsweeper.telemetry.egress_canary");
  assert.match(span.traceId, /^[0-9a-f]{32}$/);
  assert.match(span.spanId, /^[0-9a-f]{16}$/);
});

test("probeTarget reports ok for a 200 and a 401, DOWN for a 502", async () => {
  const status =
    (code: number): FetchLike =>
    () =>
      Promise.resolve({ status: code });
  const target = { name: "opik", url: "https://opik.example/v1/traces" };

  assert.equal((await probeTarget(target, { fetchImpl: status(200) })).ok, true);
  assert.equal((await probeTarget(target, { fetchImpl: status(401) })).ok, true);

  const down = await probeTarget(target, { fetchImpl: status(502) });
  assert.equal(down.ok, false);
  assert.equal(down.detail, "http_502");
});

test("probeTarget classifies timeouts and transport errors as DOWN", async () => {
  const target = { name: "signoz", url: "https://otel.example/v1/traces" };

  const timeoutFetch: FetchLike = () => {
    const error = new Error("timed out");
    error.name = "TimeoutError";
    return Promise.reject(error);
  };
  const timedOut = await probeTarget(target, { fetchImpl: timeoutFetch });
  assert.equal(timedOut.ok, false);
  assert.equal(timedOut.detail, "timeout");

  const refusedFetch: FetchLike = () => {
    const error = Object.assign(new Error("refused"), { code: "ECONNREFUSED" });
    return Promise.reject(error);
  };
  const refused = await probeTarget(target, { fetchImpl: refusedFetch });
  assert.equal(refused.ok, false);
  assert.equal(refused.detail, "error:ECONNREFUSED");
});
