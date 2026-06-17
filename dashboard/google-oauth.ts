import type { AuthConfigEnabled } from "./config.ts";
import { isAllowedEmail } from "./config.ts";
import type { DashboardUser } from "./session.ts";

export class GoogleOAuthError extends Error {
  readonly _tag = "GoogleOAuthError";
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "GoogleOAuthError";
    this.status = status;
  }
}

type GoogleTokenResponse = {
  access_token?: string;
  token_type?: string;
  expires_in?: number;
  id_token?: string;
  error?: string;
  error_description?: string;
};

type GoogleUserinfoResponse = {
  email?: string;
  email_verified?: boolean;
  name?: string;
  picture?: string;
  error?: string;
  error_description?: string;
};

export function googleAuthUrl(config: AuthConfigEnabled, state: string): string {
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", config.googleClientId);
  url.searchParams.set("redirect_uri", config.googleRedirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email");
  url.searchParams.set("state", state);
  url.searchParams.set("prompt", "select_account");
  return url.toString();
}

export async function exchangeGoogleCode(
  config: AuthConfigEnabled,
  code: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const body = new URLSearchParams();
  body.set("grant_type", "authorization_code");
  body.set("code", code);
  body.set("client_id", config.googleClientId);
  body.set("client_secret", config.googleClientSecret);
  body.set("redirect_uri", config.googleRedirectUri);

  const response = await fetchImpl("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const payload = (await response.json().catch(() => ({}))) as GoogleTokenResponse;
  if (!response.ok || !payload.access_token) {
    throw new GoogleOAuthError(
      payload.error_description ||
        payload.error ||
        `Google token exchange failed (${response.status})`,
      502,
    );
  }
  return payload.access_token;
}

export async function fetchGoogleUser(
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DashboardUser> {
  const response = await fetchImpl("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  const payload = (await response.json().catch(() => ({}))) as GoogleUserinfoResponse;
  if (!response.ok || !payload.email) {
    throw new GoogleOAuthError(
      payload.error_description || payload.error || `Google userinfo failed (${response.status})`,
      502,
    );
  }
  if (payload.email_verified === false) {
    throw new GoogleOAuthError("Google email is not verified", 403);
  }
  return {
    email: payload.email,
    name: payload.name,
    picture: payload.picture,
  };
}

export function requireAllowedGoogleUser(
  user: DashboardUser,
  config: AuthConfigEnabled,
): DashboardUser {
  if (!isAllowedEmail(user.email, config.allowedEmails)) {
    throw new GoogleOAuthError("Google account is not allowed for this dashboard", 403);
  }
  return user;
}
