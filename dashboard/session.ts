import type { AuthConfigEnabled } from "./config.ts";

export type DashboardUser = {
  email: string;
  name?: string;
  picture?: string;
};

type SessionPayload = DashboardUser & {
  exp: number;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function getCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [rawName, ...rawValue] = part.trim().split("=");
    if (rawName === name) return rawValue.join("=") || "";
  }
  return null;
}

export async function createSessionCookie(
  config: AuthConfigEnabled,
  user: DashboardUser,
  nowMs = Date.now(),
): Promise<string> {
  const payload: SessionPayload = {
    email: user.email,
    name: user.name,
    picture: user.picture,
    exp: Math.floor(nowMs / 1000) + config.sessionTtlSeconds,
  };
  const token = await signJson(config.sessionSecret, payload);
  return serializeCookie(config.sessionCookieName, token, {
    httpOnly: true,
    maxAge: config.sessionTtlSeconds,
  });
}

export async function readSession(
  request: Request,
  config: AuthConfigEnabled,
  nowMs = Date.now(),
): Promise<DashboardUser | null> {
  const token = getCookie(request, config.sessionCookieName);
  if (!token) return null;
  const payload = await verifyJson<SessionPayload>(config.sessionSecret, token);
  if (!payload) return null;
  if (!payload.email || typeof payload.exp !== "number") return null;
  if (payload.exp <= Math.floor(nowMs / 1000)) return null;
  return {
    email: payload.email,
    name: payload.name,
    picture: payload.picture,
  };
}

export function clearSessionCookie(config: AuthConfigEnabled): string {
  return serializeCookie(config.sessionCookieName, "", {
    httpOnly: true,
    maxAge: 0,
  });
}

export function createStateCookie(config: AuthConfigEnabled, state: string): string {
  return serializeCookie(config.stateCookieName, state, {
    httpOnly: true,
    maxAge: 10 * 60,
  });
}

export function clearStateCookie(config: AuthConfigEnabled): string {
  return serializeCookie(config.stateCookieName, "", {
    httpOnly: true,
    maxAge: 0,
  });
}

export function validateStateCookie(
  request: Request,
  config: AuthConfigEnabled,
  state: string | null,
): boolean {
  if (!state) return false;
  const cookieState = getCookie(request, config.stateCookieName);
  if (!cookieState) return false;
  return timingSafeEqual(cookieState, state);
}

export function randomState(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

export function serializeCookie(
  name: string,
  value: string,
  options: { httpOnly?: boolean; maxAge?: number } = {},
): string {
  const parts = [`${name}=${value}`];
  parts.push("Path=/");
  parts.push("Secure");
  parts.push("SameSite=Lax");
  if (options.httpOnly) parts.push("HttpOnly");
  if (options.maxAge !== undefined)
    parts.push(`Max-Age=${Math.max(0, Math.floor(options.maxAge))}`);
  return parts.join("; ");
}

async function signJson(secret: string, payload: unknown): Promise<string> {
  const encodedPayload = base64UrlEncode(encoder.encode(JSON.stringify(payload)));
  const signature = await hmac(secret, encodedPayload);
  return `${encodedPayload}.${signature}`;
}

async function verifyJson<T>(secret: string, token: string): Promise<T | null> {
  const [encodedPayload, signature, extra] = token.split(".");
  if (!encodedPayload || !signature || extra !== undefined) return null;
  const expected = await hmac(secret, encodedPayload);
  if (!timingSafeEqual(expected, signature)) return null;
  try {
    return JSON.parse(decoder.decode(base64UrlDecode(encodedPayload))) as T;
  } catch {
    return null;
  }
}

async function hmac(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(value));
  return base64UrlEncode(new Uint8Array(signature));
}

function timingSafeEqual(a: string, b: string): boolean {
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  let mismatch = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i += 1) {
    mismatch |= (left[i] ?? 0) ^ (right[i] ?? 0);
  }
  return mismatch === 0;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(value: string): Uint8Array {
  const padded = value
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
