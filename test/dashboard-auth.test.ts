import assert from "node:assert/strict";
import test from "node:test";

import { googleAuthUrl, requireAllowedGoogleUser } from "../dashboard/google-oauth.ts";
import worker from "../dashboard/worker.ts";
import { parseDashboardConfig } from "../dashboard/config.ts";
import { createSessionCookie, readSession } from "../dashboard/session.ts";

const AUTH_ENV = {
  DASHBOARD_AUTH_ENABLED: "1",
  GOOGLE_CLIENT_ID: "google-client-id",
  GOOGLE_CLIENT_SECRET: "google-client-secret",
  GOOGLE_REDIRECT_URI: "https://clawsweeper.myhorizon.co.za/auth/google/callback",
  CLAW_SWEEPER_ALLOWED_EMAILS: "luke@bermont.digital, blacklotussa@gmail.com",
  DASHBOARD_SESSION_SECRET: "test-session-secret-that-is-long-enough",
  DASHBOARD_SESSION_TTL_HOURS: "12",
};

test("parseDashboardConfig leaves auth disabled by default", () => {
  const config = parseDashboardConfig({});

  assert.deepEqual(config.auth, { enabled: false });
  assert.deepEqual(config.convex, { url: null, key: null, authScheme: "convex", enabled: false });
});

test("parseDashboardConfig enables Convex direct or bridge writes only with URL and key", () => {
  assert.deepEqual(parseDashboardConfig({ CONVEX_URL: "https://demo.convex.cloud" }).convex, {
    url: "https://demo.convex.cloud",
    key: null,
    authScheme: "convex",
    enabled: false,
  });
  assert.deepEqual(
    parseDashboardConfig({
      CONVEX_URL: "https://demo.convex.cloud",
      CONVEX_WRITE_KEY: "write-key",
    }).convex,
    { url: "https://demo.convex.cloud", key: "write-key", authScheme: "convex", enabled: true },
  );
  assert.deepEqual(
    parseDashboardConfig({
      CONVEX_INGEST_URL: "https://clawsweeper-convex-ingest.myhorizon.co.za/api/mutation",
      CONVEX_INGEST_TOKEN: "ingest-token",
    }).convex,
    {
      url: "https://clawsweeper-convex-ingest.myhorizon.co.za/api/mutation",
      key: "ingest-token",
      authScheme: "bearer",
      enabled: true,
    },
  );
});

test("parseDashboardConfig fails closed when auth is enabled without secrets", () => {
  assert.throws(
    () => parseDashboardConfig({ DASHBOARD_AUTH_ENABLED: "1" }),
    /required when dashboard auth is enabled/,
  );
});

test("parseDashboardConfig rejects malformed auth enabled values", () => {
  assert.throws(
    () => parseDashboardConfig({ DASHBOARD_AUTH_ENABLED: "enabled" }),
    /DASHBOARD_AUTH_ENABLED must be one of/,
  );
});

test("parseDashboardConfig loads Google auth settings and allowed emails", () => {
  const config = parseDashboardConfig(AUTH_ENV);

  assert.equal(config.auth.enabled, true);
  assert.deepEqual(config.auth.allowedEmails, ["luke@bermont.digital", "blacklotussa@gmail.com"]);
  assert.equal(config.auth.sessionTtlSeconds, 12 * 60 * 60);
});

test("session cookie round-trips, expires, and rejects tampering", async () => {
  const config = parseDashboardConfig(AUTH_ENV).auth;
  assert.equal(config.enabled, true);
  const now = Date.parse("2026-06-17T11:00:00Z");
  const cookie = await createSessionCookie(
    config,
    { email: "luke@bermont.digital", name: "Luke" },
    now,
  );

  const valid = await readSession(
    new Request("https://example.test/", { headers: { cookie } }),
    config,
    now,
  );
  assert.deepEqual(valid, { email: "luke@bermont.digital", name: "Luke", picture: undefined });

  const expired = await readSession(
    new Request("https://example.test/", { headers: { cookie } }),
    config,
    now + 13 * 60 * 60 * 1000,
  );
  assert.equal(expired, null);

  const [sessionPair] = cookie.split(";");
  const tampered = sessionPair.replace(/.$/, sessionPair.endsWith("x") ? "y" : "x");
  assert.equal(
    await readSession(
      new Request("https://example.test/", { headers: { cookie: tampered } }),
      config,
      now,
    ),
    null,
  );
});

test("googleAuthUrl uses the ClawSweeper callback and email scope", () => {
  const config = parseDashboardConfig(AUTH_ENV).auth;
  assert.equal(config.enabled, true);

  const url = new URL(googleAuthUrl(config, "state-123"));

  assert.equal(url.origin + url.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  assert.equal(url.searchParams.get("client_id"), "google-client-id");
  assert.equal(
    url.searchParams.get("redirect_uri"),
    "https://clawsweeper.myhorizon.co.za/auth/google/callback",
  );
  assert.equal(url.searchParams.get("state"), "state-123");
  assert.match(url.searchParams.get("scope") || "", /openid/);
  assert.match(url.searchParams.get("scope") || "", /email/);
  assert.doesNotMatch(url.searchParams.get("scope") || "", /profile/);
});

test("requireAllowedGoogleUser accepts configured emails case-insensitively", () => {
  const config = parseDashboardConfig(AUTH_ENV).auth;
  assert.equal(config.enabled, true);

  assert.deepEqual(requireAllowedGoogleUser({ email: "Luke@Bermont.Digital" }, config), {
    email: "Luke@Bermont.Digital",
  });
  assert.throws(
    () => requireAllowedGoogleUser({ email: "not-luke@example.com" }, config),
    /not allowed/,
  );
});

test("Worker session endpoint reports disabled auth without requiring config", async () => {
  const response = await worker.fetch(new Request("https://example.test/api/session"), {});
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { authenticated: false, authEnabled: false });
});

test("Worker redirects dashboard requests to login when auth is enabled", async () => {
  const response = await worker.fetch(new Request("https://example.test/"), AUTH_ENV);

  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "https://example.test/login?returnTo=%2F");
});

test("Worker protects status JSON when auth is enabled", async () => {
  const response = await worker.fetch(new Request("https://example.test/api/status"), AUTH_ENV);

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "unauthorized" });
});

test("Worker starts Google OAuth with an HttpOnly state cookie", async () => {
  const response = await worker.fetch(
    new Request("https://example.test/auth/google?returnTo=/triage"),
    AUTH_ENV,
  );

  assert.equal(response.status, 302);
  const location = new URL(response.headers.get("location") || "");
  assert.equal(location.origin + location.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  assert.equal(location.searchParams.get("redirect_uri"), AUTH_ENV.GOOGLE_REDIRECT_URI);
  assert.ok(location.searchParams.get("state"));
  assert.match(response.headers.get("set-cookie") || "", /clawsweeper_oauth_state=/);
  assert.match(response.headers.get("set-cookie") || "", /HttpOnly/);
});

test("Worker completes Google callback for an allowed email and sets a session", async () => {
  const start = await worker.fetch(
    new Request("https://example.test/auth/google?returnTo=/triage"),
    AUTH_ENV,
  );
  const location = new URL(start.headers.get("location") || "");
  const state = location.searchParams.get("state");
  const stateCookie = start.headers.get("set-cookie") || "";
  assert.ok(state);
  assert.match(stateCookie, /clawsweeper_oauth_state=/);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "https://oauth2.googleapis.com/token") {
      return new Response(JSON.stringify({ access_token: "google-access-token" }), { status: 200 });
    }
    if (url === "https://openidconnect.googleapis.com/v1/userinfo") {
      return new Response(
        JSON.stringify({ email: "luke@bermont.digital", email_verified: true, name: "Luke" }),
        { status: 200 },
      );
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;
  try {
    const callback = await worker.fetch(
      new Request(`https://example.test/auth/google/callback?code=abc&state=${state}`, {
        headers: { cookie: stateCookie },
      }),
      AUTH_ENV,
    );

    assert.equal(callback.status, 302);
    assert.equal(callback.headers.get("location"), "https://example.test/triage");
    const callbackCookie = callback.headers.get("set-cookie") || "";
    assert.match(callbackCookie, /clawsweeper_session=/);
    assert.match(callbackCookie, /clawsweeper_oauth_state=;/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Worker authorizes runner-mode with a signed dashboard session", async () => {
  const config = parseDashboardConfig(AUTH_ENV).auth;
  assert.equal(config.enabled, true);
  const cookie = await createSessionCookie(config, { email: "luke@bermont.digital" });
  const writes: Array<{ name: string; value: string }> = [];
  const waitUntilPromises: Promise<unknown>[] = [];
  const env = {
    ...AUTH_ENV,
    CLAWSWEEPER_REPO: "valkyriweb/clawsweeper",
    GITHUB_TOKEN: "gh-token",
    STATUS_STORE: {
      async delete() {},
      async put() {},
    },
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "PATCH" || init?.method === "POST") {
      writes.push(JSON.parse(String(init.body)) as { name: string; value: string });
    }
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  try {
    const response = await worker.fetch(
      new Request("https://example.test/api/runner-mode", {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ mode: "both" }),
      }),
      env,
      {
        waitUntil(promise: Promise<unknown>) {
          waitUntilPromises.push(promise);
        },
      },
    );

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.mode, "both");
    await Promise.all(waitUntilPromises);
    assert.equal(writes.length, 2);
    assert.ok(writes.every((write) => write.value === '["self-hosted","macOS","ARM64"]'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("runner-mode response survives Convex audit write failures and sends session actor details", async () => {
  const config = parseDashboardConfig(AUTH_ENV).auth;
  assert.equal(config.enabled, true);
  const cookie = await createSessionCookie(config, { email: "luke@bermont.digital" });
  const convexWrites: Array<{ path: string; args: Record<string, unknown> }> = [];
  const waitUntilPromises: Promise<unknown>[] = [];
  const env = {
    ...AUTH_ENV,
    CLAWSWEEPER_REPO: "valkyriweb/clawsweeper",
    GITHUB_TOKEN: "gh-token",
    CONVEX_INGEST_URL: "https://demo.convex.cloud/api/mutation",
    CONVEX_INGEST_TOKEN: "convex-ingest-token",
    STATUS_STORE: {
      async get(key: string) {
        if (key === "runner-mode") return JSON.stringify({ mode: "macbook" });
        return null;
      },
      async delete() {},
      async put() {},
    },
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname === "demo.convex.cloud") {
      convexWrites.push(
        JSON.parse(String(init?.body)) as { path: string; args: Record<string, unknown> },
      );
      return new Response(JSON.stringify({ status: "error", errorMessage: "boom" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    }
    if (
      url.hostname === "api.github.com" &&
      (init?.method === "PATCH" || init?.method === "POST")
    ) {
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
  try {
    const response = await worker.fetch(
      new Request("https://example.test/api/runner-mode", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie,
          "cf-connecting-ip": "203.0.113.10",
        },
        body: JSON.stringify({ mode: "both" }),
      }),
      env,
      {
        waitUntil(promise: Promise<unknown>) {
          waitUntilPromises.push(promise);
        },
      },
    );

    assert.equal(response.status, 200);
    await Promise.all(waitUntilPromises);
    assert.equal(convexWrites.length, 1);
    assert.equal(convexWrites[0].path, "runnerModeAudit:record");
    assert.equal(convexWrites[0].args.mode, "both");
    assert.deepEqual(convexWrites[0].args.labels, ["self-hosted", "macOS", "ARM64"]);
    assert.equal(convexWrites[0].args.email, "luke@bermont.digital");
    assert.equal(convexWrites[0].args.source, "session");
    assert.equal(convexWrites[0].args.fromMode, "macbook");
    assert.equal(convexWrites[0].args.sourceIp, "203.0.113.10");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
