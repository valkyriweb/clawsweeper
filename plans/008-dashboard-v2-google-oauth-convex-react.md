# Plan 008: Dashboard v2 — Google OAuth, Convex, React/TanStack, Effect

> **Executor instructions**: Ship this in small, reviewable slices. Do not replace the current Worker dashboard in one PR. Keep the existing `dashboard/worker.ts` status API working while the v2 UI and Convex data plane come online behind a feature flag or separate route.

## Status

- **Priority**: high
- **Effort**: XL
- **Risk**: HIGH (auth, live dashboard, deploy/secrets)
- **Depends on**: current dashboard refresh bug fixed; Google OAuth redirect URI configured; Convex deployment created
- **Category**: product/dashboard architecture
- **Planned at**: 2026-06-17 with Fuse (`/tmp/clawsweeper-dashboard-v2-fuse.md`)

## Decision

Build a real ClawSweeper ops dashboard instead of extending the current inline HTML Worker page:

- **Frontend**: Vite + React + TanStack Router + TanStack Query.
- **Live state**: Convex for status snapshots, events, runner-mode audit, and live subscriptions.
- **Auth**: Google OAuth gated to Luke's allowed email(s), implemented in the ClawSweeper Worker.
- **Effect**: adopt incrementally at external boundaries: config parsing, Google OAuth/session, GitHub API, Convex writes/reads, retries/timeouts.

## Horizon OAuth reuse

The Laravel Horizon app at `~/Projects/work/horizon-bermont` uses Laravel Socialite:

- routes: `/auth/google` and `/auth/google/callback`
- env: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`
- controller: `app/Http/Controllers/Auth/GoogleController.php`
- behavior: stateless Google OAuth, create/link user, reject/suspend checks, app session

For ClawSweeper, reuse the **same Google Cloud project/client style** and, if acceptable in Google Console, the same OAuth client credentials **only after adding ClawSweeper's callback URI**:

- `https://clawsweeper.myhorizon.co.za/auth/google/callback`

Do **not** send users through Horizon's Laravel callback. The Worker needs its own callback and session cookie because the dashboard is served by Cloudflare Workers, not Laravel.

Prefer a dedicated OAuth client named something like `ClawSweeper Dashboard (myhorizon.co.za)` if the existing Horizon client is overloaded or its redirect list is too broad.

## Phase 0 — current bug + audit

1. Fix current dashboard stale-refresh behavior:
   - a successful `/api/status` JSON response is fresh data even when `diagnostics.errors` is non-empty;
   - render partial telemetry as a note, not as stale-cache fallback;
   - keep stale fallback only for fetch/HTTP/parse failures.
2. Confirm current Worker routes/config:
   - `/`, `/api/status`, `/api/events`, `/api/runner-mode`;
   - `dashboard/wrangler.toml` custom domain and account;
   - existing secrets: GitHub app credentials, `DASHBOARD_ADMIN_TOKEN`, ingest token.
3. Confirm Google OAuth values from 1Password / Horizon deployment without printing secrets.
4. Create Convex project/deployment and record env names only.

Exit: current dashboard no longer lies about live refresh; v2 route/deploy plan is documented.

## Phase 1 — Google OAuth session gate

Worker routes:

- `GET /login` — React/HTML login entry.
- `GET /auth/google` — start OAuth with generated `state`, nonce, PKCE if supported by chosen flow.
- `GET /auth/google/callback` — exchange code for tokens, verify Google identity, enforce allowlist, issue signed session cookie.
- `POST /logout` — clear session cookie.
- `GET /api/session` — return `{ authenticated, email, name, picture }`.

Security rules:

- fail closed in production when OAuth env/session secret is missing;
- allow only configured emails (e.g. `CLAW_SWEEPER_ALLOWED_EMAILS=luke@bermont.digital,...`);
- signed, `HttpOnly`, `Secure`, `SameSite=Lax` cookie;
- short session TTL (start with 12h or 24h), no localStorage token;
- keep read-only public dashboard only if explicitly desired. Default for v2: dashboard route requires login.

Effect boundaries:

- `DashboardConfig` parses env and fails closed;
- `GoogleOAuth` exchanges/validates tokens with typed failures;
- `SessionCookies` signs/verifies cookies with typed failures.

## Phase 2 — Convex data plane

Convex tables (append-only first):

- `statusSnapshots`
  - `generatedAt`, `source`, `fleet`, `pipeline`, `recent`, `diagnostics`, `schemaVersion`
  - indexes: `by_generated_at`
- `events`
  - `receivedAt`, `eventType`, `repository`, `itemNumber`, `mode`, `stage`, `status`, `title`, `itemUrl`, `runUrl`, `payload`, `idempotencyKey`
  - indexes: `by_received_at`, `by_repository_item`, `by_idempotency_key`
- `runnerModeAudit`
  - `changedAt`, `email`, `fromMode`, `toMode`, `labels`, `reviewRunner`, `sourceIp`
  - indexes: `by_changed_at`, `by_email`

Ingest strategy:

- Current Worker keeps computing `/api/status` initially.
- On successful status generation and `/api/events` ingest, Worker writes to Convex via a server-side API key.
- Use idempotency keys for events: `source:eventType:repository:itemNumber:externalId` where available.
- Keep writes non-blocking where safe (`ctx.waitUntil`) so dashboard reads are not slower than today.

Effect boundaries:

- `ConvexStatusStore` wraps writes/queries and classifies retryable/non-retryable failures.
- `GitHubStatusSource` keeps timeout/retry policy outside UI code.

## Phase 3 — React/TanStack dashboard

Routes:

- `/login`
- `/dashboard`
- `/dashboard/runs`
- `/dashboard/runs/$runId`
- `/dashboard/repos`
- `/dashboard/settings`

Data flow:

- Convex `useQuery` for live dashboard data.
- TanStack Query for non-live HTTP endpoints: `/api/session`, logout, runner-mode mutation fallback.
- Do not copy live query results into React state; derive projections with `useMemo`.

UI direction:

- dark ops cockpit;
- clear lane control with optimistic/pending/success/error states;
- partial telemetry banner with exact failing source (`GitHub runners 403`, etc.);
- no stale-cache lie;
- explicit last-updated, source, and schema-version details;
- keyboard-accessible controls and loading/empty/error states.

## Phase 4 — deploy and cutover

Build/deploy:

- add dashboard app files under `dashboard/app/` or `dashboard-ui/`;
- Vite builds static assets;
- Worker serves static assets and API routes;
- keep legacy page behind `/legacy` or feature flag until v2 is proven.

Required secrets/env:

- Google OAuth client id/secret
- OAuth callback URL: `https://clawsweeper.myhorizon.co.za/auth/google/callback`
- session signing secret
- allowed emails
- Convex deployment URL
- Convex server/write key
- existing GitHub app/admin/ingest secrets

Verification:

- unit tests for config fail-closed;
- unit tests for OAuth callback happy/error/unauthorized email;
- unit tests for session cookie sign/verify/expiry;
- Convex schema/query tests where practical;
- UI smoke with auth redirect and session endpoint;
- deploy smoke:
  - unauthenticated `/dashboard` redirects to login;
  - allowed Google login succeeds;
  - disallowed email fails;
  - dashboard live data renders;
  - runner-mode mutation audits to Convex and updates GitHub vars.

## Rollback

- Keep existing Worker API and legacy dashboard route until cutover is stable.
- Convex schema is additive-only at first; rollback Worker/UI without deleting data.
- If OAuth breaks, temporarily re-enable legacy `DASHBOARD_ADMIN_TOKEN` gate for `/api/runner-mode` while keeping dashboard read-only available.

## First implementation slice

PR 1:

- fix current stale-refresh bug;
- add this plan;
- no dependency churn.

PR 2:

- add OAuth/session config and tests, but keep legacy UI.

PR 3:

- add Convex schema + write-through for status/events/audit, behind env-gated no-op when Convex is unset.

PR 4:

- add React/TanStack shell reading `/api/status` first.

PR 5:

- switch shell to Convex live queries and cut over `/dashboard`.
