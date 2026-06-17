# Plan 002: Separate the dashboard admin token from the ingest token, with constant-time auth

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If a
> "STOP conditions" item occurs, stop and report — do not improvise. The
> "OPERATOR / DEPLOY" section is **not** for you to run; it is for the human
> operator. When done, update this plan's row in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 8547e9c8e9..HEAD -- dashboard/worker.ts test/dashboard-worker.test.ts`
> If either file changed since this plan was written, compare the "Current
> state" excerpts to the live code before proceeding; on a mismatch, STOP.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: MED (changes an auth path; coordinate the deploy)
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `8547e9c8e9`, 2026-06-16

## Why this matters

`setRunnerMode` in the dashboard Worker is the **runner kill-switch**: it rewrites the `CLAWSWEEPER_RUNNER_LABELS` GitHub repo variable, which can pause or redirect the entire CI runner fleet. It currently authorizes with `env.DASHBOARD_ADMIN_TOKEN || env.INGEST_TOKEN`. The **ingest token is widely distributed** — every telemetry emitter holds it (the mac-mini OTEL collector, CI workflows that POST usage events). So anyone holding the low-sensitivity ingest token can also pause/redirect all runners: a privilege escalation across a trust boundary. This plan gives the control endpoints their own dedicated secret (fail-closed if unset) and replaces the non-constant-time string comparison with a Worker-safe constant-time check.

## Current state

- `dashboard/worker.ts` is a **Cloudflare Worker** (compiled via `tsconfig.dashboard.json`, libs include `DOM`/`WebWorker`). **Node's `crypto.timingSafeEqual` is NOT available** here — you must use Web Crypto (`crypto.subtle`).
- `dashboard/worker.ts:366-383` — `setRunnerMode`:
  ```js
  async function setRunnerMode(request, env, ctx) {
    const token = bearerToken(request);
    const adminToken = env.DASHBOARD_ADMIN_TOKEN || env.INGEST_TOKEN;
    if (!adminToken || token !== adminToken) return json({ error: "unauthorized" }, 401);
    // ... parses mode, then upsertGithubVariable(...) for each RUNNER_VARIABLES name
  }
  ```
- `dashboard/worker.ts:385-401` — `ingestEvent`:
  ```js
  async function ingestEvent(request, env) {
    const token = bearerToken(request);
    if (!env.INGEST_TOKEN || token !== env.INGEST_TOKEN) return json({ error: "unauthorized" }, 401);
    // ...
  }
  ```
- `bearerToken(request)` is a helper in the same file that extracts the `Authorization: Bearer …` token. Locate it with: `grep -n "function bearerToken" dashboard/worker.ts`. Confirm it returns the raw token string (or null).
- `dashboard/worker.ts` already has a test: `test/dashboard-worker.test.ts` (runs under `pnpm run test:unit`). Read it before Step 4 to learn how it builds a `Request` and a mock `env`.
- Worker secrets are configured with `wrangler secret put <NAME> --config dashboard/wrangler.toml`; deploy is `pnpm run dashboard:deploy`.

## Commands you will need

| Purpose           | Command                                   | Expected on success |
|-------------------|-------------------------------------------|---------------------|
| Build dashboard   | `pnpm run build:dashboard`                | exit 0              |
| Lint dashboard    | `pnpm run lint:dashboard`                 | exit 0              |
| Worker test       | `node --test test/dashboard-worker.test.ts` | all pass          |
| Unit tests        | `pnpm run test:unit`                      | all pass            |
| Format check      | `pnpm run format:check`                   | exit 0              |

## Scope

**In scope**:
- `dashboard/worker.ts` (auth blocks + a new helper)
- `test/dashboard-worker.test.ts` (extend)

**Out of scope**:
- Any non-auth behavior of the Worker (snapshots, triage, GitHub client).
- `dashboard/wrangler.toml` and any deploy/secret action — that is the operator's job (see OPERATOR / DEPLOY).
- The `ingestEvent` token *source* (it correctly stays `INGEST_TOKEN`); only its comparison changes.

## Git workflow

- Branch: `advisor/002-dashboard-admin-token-separation`
- Conventional Commits; example: `fix(dashboard): require dedicated admin token for runner controls`
- Do NOT push, open a PR, or deploy unless the operator instructed it.

## Steps

### Step 1: Add a Worker-safe constant-time comparison helper

Add near `bearerToken` in `dashboard/worker.ts`:

```ts
async function timingSafeEqualStr(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const va = new Uint8Array(ha);
  const vb = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < va.length; i += 1) diff |= (va[i] ?? 0) ^ (vb[i] ?? 0);
  return diff === 0;
}
```

Hashing to fixed-length digests before the XOR compare removes the length- and prefix-timing signal that a raw `===`/`!==` on the secret would leak.

### Step 2: Lock `setRunnerMode` to a dedicated admin token (remove the ingest fallback)

Replace its auth block with:

```ts
const adminToken = env.DASHBOARD_ADMIN_TOKEN;
if (!adminToken || !token || !(await timingSafeEqualStr(token, adminToken))) {
  return json({ error: "unauthorized" }, 401);
}
```

The `|| env.INGEST_TOKEN` fallback is **removed**. If `DASHBOARD_ADMIN_TOKEN` is unset, control fails closed (401).

### Step 3: Make `ingestEvent` constant-time (keep its own token)

```ts
if (!env.INGEST_TOKEN || !token || !(await timingSafeEqualStr(token, env.INGEST_TOKEN))) {
  return json({ error: "unauthorized" }, 401);
}
```

### Step 4: Audit for any other endpoint using the same fallback

Run `grep -n "DASHBOARD_ADMIN_TOKEN\|INGEST_TOKEN" dashboard/worker.ts` and `grep -n "!== .*[Tt]oken" dashboard/worker.ts`. For every **mutating/control** endpoint that authorizes with the admin-or-ingest fallback or a non-constant-time compare, apply the Step 2 pattern (dedicated admin token + `timingSafeEqualStr`). List each one you changed in the commit body. If you find a control endpoint whose lockdown could break a documented integration, **STOP** and report it instead of changing it.

**Verify (steps 1–4)**: `pnpm run build:dashboard` → exit 0; `pnpm run lint:dashboard` → exit 0.

## Test plan

Extend `test/dashboard-worker.test.ts` (match its existing structure for building a `Request` + mock `env`). Add cases:

1. `setRunnerMode` returns **401** when `DASHBOARD_ADMIN_TOKEN` is unset **even if** the request bearer matches `INGEST_TOKEN` (proves the fallback is gone).
2. `setRunnerMode` returns 401 on a wrong token, and succeeds (`ok: true`) with the correct `DASHBOARD_ADMIN_TOKEN`.
3. `ingestEvent` still returns 401 on wrong token and succeeds with the correct `INGEST_TOKEN`.
4. `timingSafeEqualStr("abc","abc")` is `true`; `timingSafeEqualStr("abc","abd")` and `("abc","abcd")` are `false`.

**Verify**: `node --test test/dashboard-worker.test.ts` → all pass, including the new cases; then `pnpm run test:unit` → all pass.

## Done criteria

- [ ] `grep -n "DASHBOARD_ADMIN_TOKEN || env.INGEST_TOKEN" dashboard/worker.ts` → **no matches**
- [ ] `setRunnerMode` and `ingestEvent` (and any other control endpoint found in Step 4) use `timingSafeEqualStr`
- [ ] `pnpm run build:dashboard` exits 0
- [ ] `pnpm run lint:dashboard` exits 0
- [ ] `pnpm run test:unit` exits 0; the four new test cases exist and pass
- [ ] `git status` shows only `dashboard/worker.ts` and `test/dashboard-worker.test.ts` modified
- [ ] `plans/README.md` status row updated

## STOP conditions

- The auth blocks at `worker.ts:366-401` don't match the "Current state" excerpts (drift).
- `test/dashboard-worker.test.ts` has no way to inject token env values and the pattern isn't clear after reading it — report rather than guess.
- Step 4 finds a control endpoint whose lockdown would break a documented integration.
- A verification fails twice after a reasonable fix attempt.

## OPERATOR / DEPLOY (human only — do NOT automate)

This change is **not safe to deploy** until the admin secret exists and the UI sends it:

1. Create a NEW strong random secret, distinct from `INGEST_TOKEN`:
   `pnpm dlx wrangler@4.90.0 secret put DASHBOARD_ADMIN_TOKEN --config dashboard/wrangler.toml`
2. Update whatever drives the dashboard "Runner Lane" control to send `Authorization: Bearer <DASHBOARD_ADMIN_TOKEN>` when calling `POST /api/runner-mode` (find the UI fetch in `dashboard/worker.ts`; if it currently uses the ingest token, switch it to the admin token).
3. Deploy: `pnpm run dashboard:deploy`.
4. If you deploy **before** setting the secret, the runner-mode button returns 401 (fail-closed by design) until the secret + UI are updated.
5. Recommended: rotate `INGEST_TOKEN` afterward if it was ever distributed as the admin token.

## Maintenance notes

- Reviewer must confirm **no** control path still accepts the ingest token, and that the compare is constant-time.
- Any new control/mutation endpoint added later must use `DASHBOARD_ADMIN_TOKEN` + `timingSafeEqualStr`, never the ingest token.
- This is the auth foundation Plan 006 (unified control plane) builds on — keep the admin-token boundary intact there.
