// GitHub App webhook receiver for per-PR agent-review.
//
// GitHub sends `pull_request` events for the valkyriweb-clawsweeper App here.
// For an opted-in repository (config/target-repositories.json:
// `pr_review_check: true` and route `valkyriweb`), the Worker starts
// pr-review-check.yml in valkyriweb/clawsweeper with only the repository and
// PR number. The engine re-reads the head SHA and re-checks opt-in itself, so a
// forged or stale event can at most start a review of an open opted-in PR.
// pr-review-poll.yml stays as an hourly fallback for missed deliveries.
//
// The opt-in list is bundled from config/target-repositories.json at deploy
// time: after changing `pr_review_check`, redeploy this Worker
// (see README.md next to this file). Until then the hourly poll covers it.
//
// Nothing here logs payloads, tokens or secrets.

import targetConfig from "../../config/target-repositories.json" with { type: "json" };

export interface Env {
  GITHUB_WEBHOOK_SECRET: string;
  GITHUB_APP_PRIVATE_KEY: string;
  GITHUB_APP_ID?: string;
}

export const APP_ID = "3711554";
export const ENGINE_OWNER = "valkyriweb";
export const ENGINE_REPO = "clawsweeper";
export const REVIEW_WORKFLOW = "pr-review-check.yml";
export const ENGINE_REF = "main";
const GITHUB_API = "https://api.github.com";
const ACCEPTED_ACTIONS = new Set(["opened", "synchronize", "reopened", "ready_for_review"]);
const MAX_BODY_BYTES = 5 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 8000;

type TargetEntry = {
  target_repo?: string;
  pr_review_check?: boolean;
  github_app_credential_route?: string;
};

export function optedInRepos(config: { repositories?: TargetEntry[] }): Map<string, string> {
  const repos = new Map<string, string>();
  for (const entry of config.repositories ?? []) {
    if (
      entry.pr_review_check === true &&
      entry.github_app_credential_route === "valkyriweb" &&
      typeof entry.target_repo === "string"
    ) {
      repos.set(entry.target_repo.toLowerCase(), entry.target_repo);
    }
  }
  return repos;
}

const OPTED_IN = optedInRepos(targetConfig as { repositories?: TargetEntry[] });

export async function verifySignature(
  secret: string,
  body: Uint8Array<ArrayBuffer>,
  header: string | null,
): Promise<boolean> {
  if (!secret || !header || !header.startsWith("sha256=")) return false;
  const given = header.slice("sha256=".length);
  if (!/^[0-9a-f]{64}$/.test(given)) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, body));
  const expected = Array.from(mac, (byte) => byte.toString(16).padStart(2, "0")).join("");
  let diff = 0;
  for (let index = 0; index < 64; index += 1) {
    diff |= expected.charCodeAt(index) ^ given.charCodeAt(index);
  }
  return diff === 0;
}

export type Decision =
  | { dispatch: true; targetRepo: string; prNumber: number }
  | { dispatch: false; reason: string };

export function decide(
  event: string | null,
  payload: unknown,
  optedIn: Map<string, string> = OPTED_IN,
): Decision {
  if (event !== "pull_request") return { dispatch: false, reason: "event ignored" };
  if (!payload || typeof payload !== "object") return { dispatch: false, reason: "bad payload" };
  const body = payload as {
    action?: unknown;
    pull_request?: { number?: unknown; draft?: unknown; state?: unknown };
    repository?: { full_name?: unknown };
  };
  if (typeof body.action !== "string" || !ACCEPTED_ACTIONS.has(body.action)) {
    return { dispatch: false, reason: "action ignored" };
  }
  const pr = body.pull_request;
  if (!pr || pr.draft !== false) return { dispatch: false, reason: "draft ignored" };
  if (pr.state !== undefined && pr.state !== "open") {
    return { dispatch: false, reason: "closed ignored" };
  }
  const prNumber = pr.number;
  if (typeof prNumber !== "number" || !Number.isInteger(prNumber) || prNumber < 1) {
    return { dispatch: false, reason: "bad payload" };
  }
  const fullName = body.repository?.full_name;
  if (typeof fullName !== "string") return { dispatch: false, reason: "bad payload" };
  const targetRepo = optedIn.get(fullName.toLowerCase());
  if (!targetRepo) return { dispatch: false, reason: "repository not opted in" };
  return { dispatch: true, targetRepo, prNumber };
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export async function dispatchReview(
  env: Env,
  targetRepo: string,
  prNumber: number,
  fetchImpl: FetchLike = fetch,
): Promise<void> {
  const jwt = await signAppJwt(env.GITHUB_APP_ID || APP_ID, env.GITHUB_APP_PRIVATE_KEY);
  const installation = await githubJson(
    fetchImpl,
    `/repos/${ENGINE_OWNER}/${ENGINE_REPO}/installation`,
    `Bearer ${jwt}`,
  );
  const installationId = Number((installation as { id?: unknown }).id);
  if (!Number.isInteger(installationId) || installationId < 1) {
    throw new Error("installation lookup returned no id");
  }
  const tokenResponse = await githubJson(
    fetchImpl,
    `/app/installations/${installationId}/access_tokens`,
    `Bearer ${jwt}`,
    { repositories: [ENGINE_REPO], permissions: { actions: "write" } },
  );
  const token = (tokenResponse as { token?: unknown }).token;
  if (typeof token !== "string" || !token) throw new Error("token response had no token");
  await githubJson(
    fetchImpl,
    `/repos/${ENGINE_OWNER}/${ENGINE_REPO}/actions/workflows/${REVIEW_WORKFLOW}/dispatches`,
    `token ${token}`,
    { ref: ENGINE_REF, inputs: { target_repo: targetRepo, pr_number: String(prNumber) } },
  );
}

async function githubJson(
  fetchImpl: FetchLike,
  path: string,
  authorization: string,
  body?: unknown,
): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetchImpl(`${GITHUB_API}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        accept: "application/vnd.github+json",
        authorization,
        "user-agent": "clawsweeper-pr-webhook",
        "x-github-api-version": "2022-11-28",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`GitHub ${path.split("/")[1]} ${response.status}`);
    return response.status === 204 ? {} : await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

export async function handle(
  request: Request,
  env: Env,
  fetchImpl: FetchLike = fetch,
): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname !== "/github/webhook") return text(404, "not found");
  if (request.method !== "POST") return text(405, "method not allowed");
  const length = Number(request.headers.get("content-length") || "0");
  if (length > MAX_BODY_BYTES) return text(413, "too large");
  const body = new Uint8Array(await request.arrayBuffer());
  if (body.byteLength > MAX_BODY_BYTES) return text(413, "too large");
  if (
    !(await verifySignature(
      env.GITHUB_WEBHOOK_SECRET,
      body,
      request.headers.get("x-hub-signature-256"),
    ))
  ) {
    return text(401, "bad signature");
  }
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return text(400, "bad json");
  }
  const decision = decide(request.headers.get("x-github-event"), payload);
  if (decision.dispatch === false) return text(202, decision.reason);
  try {
    await dispatchReview(env, decision.targetRepo, decision.prNumber, fetchImpl);
  } catch (error) {
    // Message carries only the API path segment and status, never tokens.
    console.error(`dispatch failed: ${error instanceof Error ? error.message : "unknown"}`);
    return text(502, "dispatch failed");
  }
  return text(202, `review started for ${decision.targetRepo}#${decision.prNumber}`);
}

function text(status: number, message: string): Response {
  return new Response(`${message}\n`, { status, headers: { "content-type": "text/plain" } });
}

export async function signAppJwt(appId: string, privateKeyPem: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64Url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId }));
  const input = `${header}.${claims}`;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToPkcs8(privateKeyPem.replace(/\\n/g, "\n")),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(input),
  );
  return `${input}.${base64Url(new Uint8Array(signature))}`;
}

function pemToPkcs8(pem: string): Uint8Array<ArrayBuffer> {
  const pkcs8 = pemBody(pem, "PRIVATE KEY");
  if (pkcs8) return pkcs8;
  const pkcs1 = pemBody(pem, "RSA PRIVATE KEY");
  if (!pkcs1) throw new Error("GitHub App private key must be PEM encoded");
  // Wrap PKCS#1 RSAPrivateKey in a PKCS#8 PrivateKeyInfo.
  const version = new Uint8Array([0x02, 0x01, 0x00]);
  const algorithm = new Uint8Array([
    0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
  ]);
  return der(0x30, concat(version, algorithm, der(0x04, pkcs1)));
}

function pemBody(pem: string, label: string): Uint8Array<ArrayBuffer> | null {
  const match = pem.match(
    new RegExp(`-----BEGIN ${label}-----([\\s\\S]+?)-----END ${label}-----`, "m"),
  );
  if (!match) return null;
  return Uint8Array.from(atob(match[1].replace(/\s+/g, "")), (char) => char.charCodeAt(0));
}

function der(tag: number, value: Uint8Array): Uint8Array<ArrayBuffer> {
  let length: Uint8Array;
  if (value.length < 0x80) {
    length = new Uint8Array([value.length]);
  } else {
    const bytes: number[] = [];
    for (let rest = value.length; rest > 0; rest >>= 8) bytes.unshift(rest & 0xff);
    length = new Uint8Array([0x80 | bytes.length, ...bytes]);
  }
  return concat(new Uint8Array([tag]), length, value);
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function base64Url(value: string | Uint8Array): string {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handle(request, env);
  },
};
