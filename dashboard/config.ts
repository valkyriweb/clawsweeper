import { Effect } from "effect";

export class DashboardConfigError extends Error {
  readonly _tag = "DashboardConfigError";

  constructor(message: string) {
    super(message);
    this.name = "DashboardConfigError";
  }
}

export type AuthConfigDisabled = {
  enabled: false;
};

export type AuthConfigEnabled = {
  enabled: true;
  googleClientId: string;
  googleClientSecret: string;
  googleRedirectUri: string;
  allowedEmails: readonly string[];
  sessionSecret: string;
  sessionTtlSeconds: number;
  sessionCookieName: string;
  stateCookieName: string;
};

export type AuthConfig = AuthConfigDisabled | AuthConfigEnabled;

export type DashboardConfig = {
  auth: AuthConfig;
  convex: {
    url: string | null;
  };
};

export type DashboardEnv = Record<string, unknown>;

export function loadDashboardConfig(
  env: DashboardEnv,
): Effect.Effect<DashboardConfig, DashboardConfigError> {
  return Effect.try({
    try: () => parseDashboardConfig(env),
    catch: (error) =>
      error instanceof DashboardConfigError
        ? error
        : new DashboardConfigError(error instanceof Error ? error.message : String(error)),
  });
}

export function parseDashboardConfig(env: DashboardEnv): DashboardConfig {
  const enabled = parseBooleanEnv(env.DASHBOARD_AUTH_ENABLED, "DASHBOARD_AUTH_ENABLED", false);
  const convexUrl = optionalString(env.CONVEX_URL);
  if (!enabled) {
    return {
      auth: { enabled: false },
      convex: { url: convexUrl },
    };
  }

  const allowedEmails = splitCsv(requiredString(env, "CLAW_SWEEPER_ALLOWED_EMAILS"));
  if (allowedEmails.length === 0) {
    throw new DashboardConfigError("CLAW_SWEEPER_ALLOWED_EMAILS must include at least one email");
  }

  const ttlHours = numberFromEnv(env.DASHBOARD_SESSION_TTL_HOURS, 12);
  if (!Number.isFinite(ttlHours) || ttlHours <= 0 || ttlHours > 168) {
    throw new DashboardConfigError("DASHBOARD_SESSION_TTL_HOURS must be between 0 and 168");
  }

  return {
    auth: {
      enabled: true,
      googleClientId: requiredString(env, "GOOGLE_CLIENT_ID"),
      googleClientSecret: requiredString(env, "GOOGLE_CLIENT_SECRET"),
      googleRedirectUri: requiredString(env, "GOOGLE_REDIRECT_URI"),
      allowedEmails,
      sessionSecret: requiredString(env, "DASHBOARD_SESSION_SECRET"),
      sessionTtlSeconds: Math.floor(ttlHours * 60 * 60),
      sessionCookieName: stringFromEnv(env.DASHBOARD_SESSION_COOKIE, "clawsweeper_session"),
      stateCookieName: stringFromEnv(env.DASHBOARD_OAUTH_STATE_COOKIE, "clawsweeper_oauth_state"),
    },
    convex: { url: convexUrl },
  };
}

export function isAllowedEmail(email: string, allowedEmails: readonly string[]): boolean {
  const normalized = email.trim().toLowerCase();
  return allowedEmails.some((allowed) => allowed.trim().toLowerCase() === normalized);
}

function requiredString(env: DashboardEnv, key: string): string {
  const value = optionalString(env[key]);
  if (!value) throw new DashboardConfigError(`${key} is required when dashboard auth is enabled`);
  return value;
}

function optionalString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function stringFromEnv(value: unknown, fallback: string): string {
  return optionalString(value) ?? fallback;
}

function splitCsv(value: string): readonly string[] {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function numberFromEnv(value: unknown, fallback: number): number {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "number") return value;
  if (typeof value === "string") return Number(value);
  return Number.NaN;
}

function parseBooleanEnv(value: unknown, key: string, fallback: boolean): boolean {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (value === 1) return true;
    if (value === 0) return false;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "off"].includes(normalized)) return false;
  }
  throw new DashboardConfigError(`${key} must be one of: 1, 0, true, false, yes, no, on, off`);
}
