import assert from "node:assert/strict";
import { createHmac, generateKeyPairSync } from "node:crypto";
import test from "node:test";

import { decide, handle, optedInRepos, verifySignature } from "../dashboard/pr-webhook/worker.ts";

const SECRET = "test-webhook-secret";
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const PKCS1_PEM = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
const env = { GITHUB_WEBHOOK_SECRET: SECRET, GITHUB_APP_PRIVATE_KEY: PEM };

function sign(body: string, secret = SECRET): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

function prPayload(overrides: Record<string, unknown> = {}) {
  return {
    action: "opened",
    pull_request: { number: 7, draft: false, state: "open", head: { sha: "a".repeat(40) } },
    repository: { full_name: "open-intelligence-south-africa/d90-hive" },
    ...overrides,
  };
}

function webhookRequest(body: string, headers: Record<string, string> = {}): Request {
  return new Request("https://example.workers.dev/github/webhook", {
    method: "POST",
    headers: { "x-github-event": "pull_request", "x-hub-signature-256": sign(body), ...headers },
    body,
  });
}

type Call = { url: string; method: string; auth: string; body?: unknown };

function fakeGithub(): {
  calls: Call[];
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
} {
  const calls: Call[] = [];
  return {
    calls,
    fetch: async (url, init = {}) => {
      const headers = new Headers(init.headers);
      calls.push({
        url,
        method: init.method ?? "GET",
        auth: headers.get("authorization") ?? "",
        body: init.body ? JSON.parse(String(init.body)) : undefined,
      });
      if (url.endsWith("/repos/valkyriweb/clawsweeper/installation")) {
        return Response.json({ id: 42 });
      }
      if (url.endsWith("/app/installations/42/access_tokens")) {
        return Response.json({ token: "ghs_fake" }, { status: 201 });
      }
      if (url.includes("/actions/workflows/pr-review-check.yml/dispatches")) {
        return new Response(null, { status: 204 });
      }
      return new Response("unexpected", { status: 500 });
    },
  };
}

test("verifySignature accepts the GitHub HMAC and rejects anything else", async () => {
  const body = '{"a":1}';
  const bytes = new TextEncoder().encode(body);
  assert.equal(await verifySignature(SECRET, bytes, sign(body)), true);
  assert.equal(await verifySignature(SECRET, bytes, sign(body, "other")), false);
  assert.equal(
    await verifySignature(SECRET, new TextEncoder().encode('{"a":2}'), sign(body)),
    false,
  );
  assert.equal(await verifySignature(SECRET, bytes, null), false);
  assert.equal(await verifySignature(SECRET, bytes, sign(body).replace("sha256=", "sha1=")), false);
  assert.equal(await verifySignature(SECRET, bytes, "sha256=zz"), false);
  assert.equal(await verifySignature("", bytes, sign(body, "")), false);
});

test("optedInRepos keeps only pr_review_check targets on the valkyriweb route", () => {
  const repos = optedInRepos({
    repositories: [
      { target_repo: "A/One", pr_review_check: true, github_app_credential_route: "valkyriweb" },
      { target_repo: "b/two", pr_review_check: true, github_app_credential_route: "bermont" },
      { target_repo: "c/three", github_app_credential_route: "valkyriweb" },
    ],
  });
  assert.deepEqual([...repos.entries()], [["a/one", "A/One"]]);
});

test("decide dispatches only non-draft opted-in PR open/push events", () => {
  assert.deepEqual(decide("pull_request", prPayload()), {
    dispatch: true,
    targetRepo: "open-intelligence-south-africa/d90-hive",
    prNumber: 7,
  });
  for (const action of ["synchronize", "reopened", "ready_for_review"]) {
    assert.equal(decide("pull_request", prPayload({ action })).dispatch, true, action);
  }
  for (const action of ["closed", "edited", "labeled", "converted_to_draft"]) {
    assert.equal(decide("pull_request", prPayload({ action })).dispatch, false, action);
  }
  assert.equal(decide("push", prPayload()).dispatch, false);
  assert.equal(decide("ping", { zen: "x" }).dispatch, false);
  assert.equal(
    decide("pull_request", prPayload({ pull_request: { number: 7, draft: true } })).dispatch,
    false,
  );
  assert.equal(
    decide("pull_request", prPayload({ repository: { full_name: "openclaw/openclaw" } })).dispatch,
    false,
  );
  assert.equal(
    decide("pull_request", prPayload({ pull_request: { number: "7", draft: false } })).dispatch,
    false,
  );
});

test("handle rejects bad signatures before parsing and ignores other events with 202", async () => {
  const github = fakeGithub();
  const body = JSON.stringify(prPayload());
  const bad = await handle(
    webhookRequest(body, { "x-hub-signature-256": sign(body, "wrong") }),
    env,
    github.fetch,
  );
  assert.equal(bad.status, 401);
  const ignored = await handle(
    webhookRequest(body, { "x-github-event": "issues" }),
    env,
    github.fetch,
  );
  assert.equal(ignored.status, 202);
  const notFound = await handle(new Request("https://example.workers.dev/"), env, github.fetch);
  assert.equal(notFound.status, 404);
  assert.equal(github.calls.length, 0);
});

test("handle mints an actions:write token for clawsweeper only and dispatches repo + PR", async () => {
  for (const pem of [PEM, PKCS1_PEM]) {
    const github = fakeGithub();
    const body = JSON.stringify(prPayload({ action: "synchronize" }));
    const response = await handle(
      webhookRequest(body),
      { ...env, GITHUB_APP_PRIVATE_KEY: pem },
      github.fetch,
    );
    assert.equal(response.status, 202);
    assert.equal(github.calls.length, 3);
    const [installation, token, dispatch] = github.calls;
    assert.match(installation.auth, /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    const claims = JSON.parse(
      Buffer.from(installation.auth.split(" ")[1].split(".")[1], "base64url").toString(),
    );
    assert.equal(claims.iss, "3711554");
    assert.equal(token.method, "POST");
    assert.deepEqual(token.body, {
      repositories: ["clawsweeper"],
      permissions: { actions: "write" },
    });
    assert.equal(
      dispatch.url,
      "https://api.github.com/repos/valkyriweb/clawsweeper/actions/workflows/pr-review-check.yml/dispatches",
    );
    assert.equal(dispatch.auth, "token ghs_fake");
    assert.deepEqual(dispatch.body, {
      ref: "main",
      inputs: { target_repo: "open-intelligence-south-africa/d90-hive", pr_number: "7" },
    });
  }
});

test("handle returns 502 without detail when GitHub refuses", async () => {
  const body = JSON.stringify(prPayload());
  const response = await handle(
    webhookRequest(body),
    env,
    async () => new Response("nope", { status: 403 }),
  );
  assert.equal(response.status, 502);
  assert.equal(await response.text(), "dispatch failed\n");
});
