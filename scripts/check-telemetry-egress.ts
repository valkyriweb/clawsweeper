#!/usr/bin/env node
/**
 * Telemetry egress guard.
 *
 * Background (2026-06-16 incident): ClawSweeper usage spans are POSTed to a local
 * OTLP collector, which fans them out to Opik + SigNoz. The collector returns 2xx
 * the instant it accepts a span, so the runner-side emitter (`emitUsageEventOtlpHttp`)
 * sees success even when both backends are down and every span is silently dropped
 * downstream. The blackout lasted ~1.5 days with zero signal because nothing probes
 * the backends.
 *
 * This guard probes each configured egress target end-to-end and classifies the
 * result: a 5xx, a connection error, or a timeout means the backend is DOWN; a
 * 2xx/3xx/4xx means it is reachable and serving (an OTLP endpoint that requires
 * auth answers an unauthenticated canary with 401 — healthy for a reachability
 * probe). Exits non-zero when any target is DOWN so the scheduled workflow fails
 * and the existing OpenClaw notify pipeline pages.
 */
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";

import { otlpTracesEndpoint } from "../src/usage-telemetry.ts";

export type EgressTarget = { name: string; url: string };

export type ProbeResult = {
  name: string;
  url: string;
  ok: boolean;
  detail: string;
  ms: number;
};

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<{ status: number }>;

/**
 * Classify a backend HTTP status. `>= 500` is the failure surface seen in the
 * incident (Opik 502, SigNoz 504); everything below 500 means the backend was
 * reached and answered (including a 401 auth gate), which is healthy here.
 */
export function classifyStatus(status: number): { ok: boolean; detail: string } {
  return status >= 500
    ? { ok: false, detail: `http_${status}` }
    : { ok: true, detail: `http_${status}` };
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/**
 * Resolve egress targets from the environment: the primary OTLP endpoint (same
 * precedence the emitter uses) plus an optional `CLAWSWEEPER_USAGE_EGRESS_TARGETS`
 * list of `name=url` (or bare `url`) entries for the downstream backends. Targets
 * are de-duplicated by URL.
 */
export function resolveEgressTargets(env: NodeJS.ProcessEnv = process.env): EgressTarget[] {
  const targets: EgressTarget[] = [];
  const collector = otlpTracesEndpoint(env);
  if (collector) targets.push({ name: "collector", url: collector });

  for (const part of String(env.CLAWSWEEPER_USAGE_EGRESS_TARGETS ?? "").split(",")) {
    const entry = part.trim();
    if (!entry) continue;
    const sep = entry.indexOf("=");
    if (sep > 0) {
      targets.push({ name: entry.slice(0, sep).trim(), url: entry.slice(sep + 1).trim() });
    } else {
      targets.push({ name: hostnameOf(entry), url: entry });
    }
  }

  const seen = new Set<string>();
  const unique: EgressTarget[] = [];
  for (const target of targets) {
    if (seen.has(target.url)) continue;
    seen.add(target.url);
    unique.push(target);
  }
  return unique;
}

/**
 * A minimal but *valid* OTLP/HTTP trace payload. An empty `resourceSpans` array
 * can be rejected with 4xx/5xx by a healthy backend (Opik 500s on empty), so send
 * one real, clearly-tagged canary span.
 */
export function canaryOtlpBody(env: NodeJS.ProcessEnv = process.env): string {
  const now = Date.now();
  const endTimeUnixNano = `${BigInt(now) * 1_000_000n}`;
  const startTimeUnixNano = `${BigInt(now - 1) * 1_000_000n}`;
  return JSON.stringify({
    resourceSpans: [
      {
        resource: {
          attributes: [
            {
              key: "service.name",
              value: { stringValue: env.CLAWSWEEPER_USAGE_SERVICE_NAME || "clawsweeper-runner" },
            },
            { key: "telemetry.source", value: { stringValue: "clawsweeper-usage" } },
          ],
        },
        scopeSpans: [
          {
            scope: { name: "clawsweeper.egress-canary", version: "1" },
            spans: [
              {
                traceId: randomBytes(16).toString("hex"),
                spanId: randomBytes(8).toString("hex"),
                name: "clawsweeper.telemetry.egress_canary",
                kind: 1,
                startTimeUnixNano,
                endTimeUnixNano,
                attributes: [{ key: "clawsweeper.canary", value: { boolValue: true } }],
                status: { code: 1 },
              },
            ],
          },
        ],
      },
    ],
  });
}

/** Probe a single target. Network errors and timeouts are classified DOWN. */
export async function probeTarget(
  target: EgressTarget,
  options: { fetchImpl?: FetchLike; timeoutMs?: number; body?: string } = {},
): Promise<ProbeResult> {
  const fetchImpl: FetchLike = options.fetchImpl ?? ((url, init) => fetch(url, init));
  const timeoutMs = options.timeoutMs ?? 8000;
  const body = options.body ?? canaryOtlpBody();
  const started = Date.now();
  try {
    const response = await fetchImpl(target.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const { ok, detail } = classifyStatus(response.status);
    return { name: target.name, url: target.url, ok, detail, ms: Date.now() - started };
  } catch (error) {
    const errorName = error instanceof Error ? error.name : "";
    const timedOut = errorName === "TimeoutError" || errorName === "AbortError";
    const code = (error as { code?: string } | undefined)?.code;
    return {
      name: target.name,
      url: target.url,
      ok: false,
      detail: timedOut ? "timeout" : `error:${code ?? errorName ?? "fetch_failed"}`,
      ms: Date.now() - started,
    };
  }
}

async function main(): Promise<void> {
  const env = process.env;
  const targets = resolveEgressTargets(env);
  if (targets.length === 0) {
    console.log(
      "telemetry-egress: no targets configured " +
        "(set CLAWSWEEPER_USAGE_OTLP_ENDPOINT and/or CLAWSWEEPER_USAGE_EGRESS_TARGETS); nothing to check.",
    );
    return;
  }

  const timeoutMs = Number(env.CLAWSWEEPER_USAGE_EGRESS_TIMEOUT_MS || "8000");
  const results = await Promise.all(targets.map((target) => probeTarget(target, { timeoutMs })));

  let down = 0;
  for (const result of results) {
    if (!result.ok) down += 1;
    const mark = result.ok ? "ok  " : "DOWN";
    console.log(
      `${mark}  ${result.name.padEnd(12)} ${result.detail.padEnd(14)} ${result.ms}ms  ${result.url}`,
    );
  }

  if (down > 0) {
    console.error(
      `telemetry-egress: ${down}/${results.length} target(s) DOWN — usage spans are being dropped on egress.`,
    );
    process.exitCode = 1;
    return;
  }
  console.log(`telemetry-egress: all ${results.length} target(s) reachable.`);
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  await main();
}
