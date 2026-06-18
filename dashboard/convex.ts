import { Effect } from "effect";

import { parseConvexConfig, type DashboardEnv } from "./config.ts";

type ConvexMutationPath = "statusSnapshots:record" | "events:record" | "runnerModeAudit:record";
type ConvexQueryPath = "history:snapshots" | "history:events";
type JsonObject = Record<string, unknown>;

type ConvexApiResponse = {
  status?: string;
  value?: unknown;
  errorMessage?: string;
};

export type ConvexRunnerModeAudit = {
  changedAt: string;
  email: string;
  source: string;
  fromMode: string | null;
  mode: string;
  labels: string[];
  reviewRunner: string | null;
  sourceIp: string | null;
};

class ConvexWriteError extends Error {
  readonly _tag = "ConvexWriteError";

  constructor(path: ConvexMutationPath, cause: unknown) {
    super(
      `Convex mutation ${path} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = "ConvexWriteError";
  }
}

export function recordStatusSnapshot(env: DashboardEnv, snapshot: JsonObject): Promise<void> {
  return writeConvexMutation(env, "statusSnapshots:record", {
    generatedAt: stringFrom(snapshot.generated_at, new Date().toISOString()),
    schemaVersion: numberFrom(snapshot.schema_version, 1),
    source: snapshot.source ?? null,
    fleet: snapshot.fleet ?? null,
    pipeline: snapshot.pipeline ?? [],
    recent: snapshot.recent ?? null,
    diagnostics: snapshot.diagnostics ?? null,
  });
}

export function recordEvent(env: DashboardEnv, body: JsonObject, event: JsonObject): Promise<void> {
  const itemNumber = numberOrNull(body.item_number ?? body.itemNumber ?? body.number);
  const repository = stringOrNull(body.repository ?? event.repository);
  const eventType = stringFrom(event.event_type ?? body.event_type, "status.event");

  return writeConvexMutation(env, "events:record", {
    receivedAt: stringFrom(event.received_at, new Date().toISOString()),
    eventType,
    repository,
    itemNumber,
    mode: stringFrom(event.mode ?? body.mode, "unknown"),
    stage: stringFrom(event.stage ?? body.stage, "unknown"),
    status: stringFrom(event.status ?? body.status, "unknown"),
    title: stringOrNull(event.title ?? body.title),
    itemUrl: stringOrNull(event.item_url ?? body.item_url ?? body.itemUrl),
    runUrl: stringOrNull(event.run_url ?? body.run_url ?? body.runUrl),
    payload: body,
    idempotencyKey: eventIdempotencyKey(body, event, eventType, repository, itemNumber),
  });
}

export function recordRunnerModeAudit(
  env: DashboardEnv,
  audit: ConvexRunnerModeAudit,
): Promise<void> {
  return writeConvexMutation(env, "runnerModeAudit:record", audit);
}

export async function readConvexHistory(
  env: DashboardEnv,
  path: ConvexQueryPath,
  args: JsonObject,
): Promise<unknown> {
  const config = parseConvexConfig(env);
  if (!config.enabled || !config.url || !config.key) return null;
  return postConvexQuery(config.url, config.key, config.authScheme, path, args);
}

function writeConvexMutation(
  env: DashboardEnv,
  path: ConvexMutationPath,
  args: JsonObject,
): Promise<void> {
  const config = parseConvexConfig(env);
  if (!config.enabled || !config.url || !config.key) return Promise.resolve();

  return Effect.runPromise(
    Effect.tryPromise({
      try: async () => {
        await postConvexMutation(config.url, config.key, config.authScheme, path, args);
      },
      catch: (cause) => new ConvexWriteError(path, cause),
    }).pipe(Effect.catchAll(() => Effect.succeed(undefined))),
  );
}

async function postConvexMutation(
  url: string,
  key: string,
  authScheme: "convex" | "bearer",
  path: ConvexMutationPath,
  args: JsonObject,
): Promise<void> {
  const response = await fetch(convexMutationEndpoint(url), {
    method: "POST",
    headers: {
      authorization: `${authScheme === "convex" ? "Convex" : "Bearer"} ${key}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ path, args, format: "json" }),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const result = (await response.json().catch(() => null)) as ConvexApiResponse | null;
  if (result?.status !== "success") throw new Error(result?.errorMessage || "unknown error");
}

async function postConvexQuery(
  url: string,
  key: string,
  authScheme: "convex" | "bearer",
  path: ConvexQueryPath,
  args: JsonObject,
): Promise<unknown> {
  const response = await fetch(convexApiEndpoint(url, "query"), {
    method: "POST",
    headers: {
      authorization: `${authScheme === "convex" ? "Convex" : "Bearer"} ${key}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ path, args, format: "json" }),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const result = (await response.json().catch(() => null)) as ConvexApiResponse | null;
  if (result?.status !== "success") throw new Error(result?.errorMessage || "unknown error");
  return result.value ?? null;
}

function eventIdempotencyKey(
  body: JsonObject,
  event: JsonObject,
  eventType: string,
  repository: string | null,
  itemNumber: number | null,
): string {
  const explicit = stringOrNull(body.idempotency_key ?? body.idempotencyKey);
  if (explicit) return explicit;

  const source = stringOrNull(body.source ?? body.event_source ?? body.eventSource) ?? "ingest";
  const externalId =
    stringOrNull(
      body.external_id ??
        body.externalId ??
        body.delivery_id ??
        body.deliveryId ??
        body.run_id ??
        body.runId ??
        body.workflow_run_id ??
        body.workflowRunId ??
        body.check_run_id ??
        body.checkRunId ??
        body.item_url ??
        body.itemUrl ??
        body.run_url ??
        body.runUrl,
    ) ?? stringFrom(event.id, crypto.randomUUID());

  return [source, eventType, repository ?? "none", itemNumber ?? "none", externalId].join(":");
}

function convexMutationEndpoint(url: string): string {
  return convexApiEndpoint(url, "mutation");
}

function convexApiEndpoint(url: string, kind: "mutation" | "query"): string {
  const trimmed = trimTrailingSlash(url);
  if (trimmed.endsWith("/api/mutation") || trimmed.endsWith("/api/query")) {
    return trimmed.replace(/\/api\/(mutation|query)$/, `/api/${kind}`);
  }
  return `${trimmed}/api/${kind}`;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function stringFrom(value: unknown, fallback: string): string {
  return stringOrNull(value) ?? fallback;
}

function stringOrNull(value: unknown): string | null {
  const text = String(value ?? "").trim();
  return text || null;
}

function numberFrom(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function numberOrNull(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
