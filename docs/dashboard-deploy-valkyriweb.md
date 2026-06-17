# Deploying the ClawSweeper dashboard for valkyriweb

Fork-specific runbook for getting `dashboard/worker.ts` live on Luke's Cloudflare account. Read once, then rerun in ~10 minutes.

Upstream's `dashboard.openclaw.ai` deployment belongs to OpenClaw and we can't push to it. We deploy our own worker at `clawsweeper.myhorizon.co.za` (or any subdomain you control) on Luke's Cloudflare account `f6a544e0beaf9e2de3f959d1e5a11611`.

## Prerequisites

- `pnpm` install completed at the repo root (`pnpm install`)
- `valkyriweb-clawsweeper` GitHub App's private key (PEM) — likely in 1Password
- The App must have **Variables: Read and write** repository permission so the runner-lane buttons work. Check at `gh api /apps/valkyriweb-clawsweeper --jq '.permissions.actions_variables'` — must say `"write"`. If not, add it at <https://github.com/settings/apps/valkyriweb-clawsweeper/permissions> and accept the new permission on the installation.
- The current App installation ID for `valkyriweb` is `132284017`.

## Step 1 — strip the openclaw.ai custom domain

`dashboard/wrangler.toml` ships with an OpenClaw-owned custom domain. Replace the `[[routes]]` block. Two options:

**Option A — workers.dev only (fastest, ugly URL).** Delete the `[[routes]]` block entirely. The worker becomes accessible at `https://clawsweeper-status.<your-subdomain>.workers.dev` (subdomain is the one Cloudflare assigned your account; visible via `pnpm dlx wrangler@4.90.0 whoami`).

**Option B — your own custom domain.** Pick a hostname on a zone you own (`clawsweeper.myhorizon.co.za`, `claws.bermont.digital`, whatever). Update the pattern:

```toml
[[routes]]
pattern = "clawsweeper.myhorizon.co.za"
custom_domain = true
```

Custom domains require the zone to already exist in Cloudflare DNS — they don't need a pre-existing DNS record (`custom_domain = true` will create one).

## Step 2 — Cloudflare auth

```bash
pnpm dlx wrangler@4.90.0 login
# Browser opens, click "Allow"
pnpm dlx wrangler@4.90.0 whoami
# Should show account id f6a544e0beaf9e2de3f959d1e5a11611 and workers.dev subdomain luke-f6a
```

## Step 3 — KV namespace for STATUS_STORE (recommended)

The worker degrades to `caches.default` if no KV is bound, which means snapshots vanish on worker restart. For a real dashboard you want a KV namespace:

```bash
# Create the KV namespace
pnpm dlx wrangler@4.90.0 kv namespace create STATUS_STORE \
  --config dashboard/wrangler.toml
# Output gives you an `id = "..."` line — copy it
```

Append to `dashboard/wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "STATUS_STORE"
id = "PASTE_THE_ID_HERE"
```

Commit this — KV namespace IDs are not secrets.

## Step 4 — set secrets

Three secrets, all via `wrangler secret put` (never commit these). Each command prompts for the value; paste and hit enter.

```bash
# GitHub App private key. Paste the full PEM block including BEGIN/END lines.
# Literal \n sequences are normalized to newlines by the worker if needed.
pnpm dlx wrangler@4.90.0 secret put CLAWSWEEPER_APP_PRIVATE_KEY \
  --config dashboard/wrangler.toml

# Installation ID for the App on valkyriweb/clawsweeper.
# Current valkyriweb installation ID: 132284017
pnpm dlx wrangler@4.90.0 secret put CLAWSWEEPER_APP_INSTALLATION_ID \
  --config dashboard/wrangler.toml

# Auth token for the /api/events ingest endpoint.
# Generate one: openssl rand -hex 32
pnpm dlx wrangler@4.90.0 secret put INGEST_TOKEN \
  --config dashboard/wrangler.toml
```

`CLAWSWEEPER_APP_ID` (`3711554`) and `CLAWSWEEPER_APP_CLIENT_ID` (`Iv23lirdjmVqYd1gwY26`) are already in `[vars]` of `wrangler.toml`; the numeric App ID is preferred as the GitHub JWT issuer.

**Fourth secret (required for the runner-lane kill-switch)** — the dashboard admin token is separate from the ingest token. `POST /api/runner-mode` (the runner-lane buttons) requires `DASHBOARD_ADMIN_TOKEN` and does **not** fall back to `INGEST_TOKEN` (that token is distributed to every telemetry emitter, so it must not grant runner control). Generate one: `openssl rand -hex 32`.

```bash
pnpm dlx wrangler@4.90.0 secret put DASHBOARD_ADMIN_TOKEN \
  --config dashboard/wrangler.toml
```

If `DASHBOARD_ADMIN_TOKEN` is unset, `POST /api/runner-mode` returns 401 unless Google OAuth session auth is enabled and the browser has a valid dashboard session.

### Optional — Google OAuth dashboard gate

The dashboard can be gated with Google OAuth so Luke signs in with an allowed Google account instead of pasting the admin token into the browser. This is disabled unless `DASHBOARD_AUTH_ENABLED` is set.

Google Console setup:

1. Use the same Google Cloud project/client style as Horizon (`~/Projects/work/horizon-bermont` uses Laravel Socialite), or create a dedicated OAuth client named `ClawSweeper Dashboard`.
2. Add the exact authorized redirect URI:
   `https://clawsweeper.myhorizon.co.za/auth/google/callback`.
3. Use scopes `openid email` (the `gcloud iam oauth-clients` path supports these for this dashboard use case).

Non-secret Worker vars (commit in `dashboard/wrangler.toml` or set via Wrangler env if preferred):

```toml
DASHBOARD_AUTH_ENABLED = "1"
GOOGLE_CLIENT_ID = "<google-oauth-client-id>"
GOOGLE_REDIRECT_URI = "https://clawsweeper.myhorizon.co.za/auth/google/callback"
CLAW_SWEEPER_ALLOWED_EMAILS = "luke@bermont.digital,blacklotussa@gmail.com"
DASHBOARD_SESSION_TTL_HOURS = "12"
```

Secrets:

```bash
pnpm dlx wrangler@4.90.0 secret put GOOGLE_CLIENT_SECRET \
  --config dashboard/wrangler.toml

openssl rand -hex 32 | pnpm dlx wrangler@4.90.0 secret put DASHBOARD_SESSION_SECRET \
  --config dashboard/wrangler.toml
```

When OAuth is enabled, dashboard pages and status JSON require a signed session cookie. `POST /api/runner-mode` accepts either a valid dashboard session or the legacy `DASHBOARD_ADMIN_TOKEN` bearer token.

## Step 5 — build and deploy

```bash
pnpm run build:dashboard
pnpm run dashboard:deploy
# tail of output shows the live URL
```

If you went with workers.dev only, the URL is `https://clawsweeper-status.<subdomain>.workers.dev`. If custom domain, the pattern from step 1.

## Step 6 — verify

```bash
# Public health check — should return JSON with fleet/pipeline data
curl -s https://YOUR_URL/api/status | jq '.fleet'

# Runner config in the snapshot
curl -s https://YOUR_URL/api/status | jq '.fleet.runner_config, .fleet.runners'

# Browser: open YOUR_URL — should see ClawSweeper Live page with Runner Lane card
```

First load may take 5–10s while it warms the GitHub API cache. Subsequent loads are <1s (cached via `CACHE_TTL_SECONDS = "20"`).

## Step 7 — wire the runner-lane buttons (smoke test)

On the live page, the Runner Lane card shows four buttons (`paused`, `mac-mini`, `macbook`, `both`). Click `both`.

- With Google OAuth enabled and a valid session: no token prompt; the session cookie authorizes the change.
- Without Google OAuth: the browser prompts for `DASHBOARD_ADMIN_TOKEN`; the ingest token is rejected.

On success:

```bash
# Confirm the variable flipped
gh variable list --repo valkyriweb/clawsweeper | grep CLAWSWEEPER_RUNNER_LABELS
```

Should now read `["self-hosted","macOS","ARM64"]`. If you get a 403, the App is missing `Variables: write` — see prereqs. If you get a 401, either sign in with an allowed Google account or paste the `DASHBOARD_ADMIN_TOKEN` fallback.

## Step 8 (optional) — feed live event data

The dashboard derives most of its display from the GitHub API directly, so it works out of the box. To get the "Recent Activity" feed populated with actual sweeper progress, the repair workers need to `POST /api/events` with `Authorization: Bearer ${INGEST_TOKEN}`.

That's a separate plumbing change in the sweep workflow / repair scripts — not required for the dashboard to function. Park it until you actually want the event stream.

## Reference

- Env vars the worker reads: `CACHE_TTL_SECONDS`, `STALE_CACHE_TTL_SECONDS`, `CLAWSWEEPER_REPO`, `TARGET_REPOS`, `WORKER_BUDGET`, `INCLUDE_CI_STATUS`, `TRIAGE_TARGET_REPOS`, `PR_PROOF_TARGET_REPOS`, `TRIAGE_ITEMS_PER_VIEW`, `PR_PROOF_ITEMS_PER_VIEW`, `CLAWSWEEPER_BOT_LOGINS`, `STORE_CACHE_TTL_SECONDS`, `CI_STATUS_TTL_SECONDS`, `DASHBOARD_AUTH_ENABLED`, `GOOGLE_CLIENT_ID`, `GOOGLE_REDIRECT_URI`, `CLAW_SWEEPER_ALLOWED_EMAILS`, `DASHBOARD_SESSION_TTL_HOURS`, `CONVEX_URL`
- Secrets: `CLAWSWEEPER_APP_PRIVATE_KEY`, `CLAWSWEEPER_APP_INSTALLATION_ID`, `INGEST_TOKEN` (ingest only), `DASHBOARD_ADMIN_TOKEN` (legacy `/api/runner-mode` fallback), `GOOGLE_CLIENT_SECRET`, `DASHBOARD_SESSION_SECRET`, or fallback `GITHUB_TOKEN` (PAT instead of App auth)
- Bindings: `STATUS_STORE` (KV namespace)
- Deploy commands: `pnpm run dashboard:deploy`, `pnpm run dashboard:dev` (local), `pnpm run dashboard:smoke`
