# Plan 006: Unify the control plane — one typed config surface, per-repo enable, and dashboard visibility

> **Executor instructions**: This is a **phased** plan. Ship **Phase A** as a
> complete, verified change first; Phases B and C are separate commits/PRs that
> build on it. Run every verification command. If a "STOP conditions" item
> occurs, stop and report. Update `plans/README.md` after each phase.
>
> **Drift check (run first)**: `git diff --stat 8547e9c8e9..HEAD -- src/ dashboard/ config/`
> If the control-related files below changed since this plan was written,
> re-confirm the "Current state" facts before proceeding.

## Status

- **Priority**: P2
- **Effort**: L (phased: A = M, B = M, C = M)
- **Risk**: MED (touches gating logic; Phase A is behavior-preserving, B/C add capability)
- **Depends on**: Plan 002 (Phase C reuses the dashboard admin token)
- **Category**: direction
- **Planned at**: commit `8547e9c8e9`, 2026-06-16

## Why this matters

ClawSweeper's "is this allowed to run / mutate?" controls are spread across many GitHub **repo variables** read ad-hoc throughout the code, plus a dashboard that can only do a global runner pause + device-pool switch. There is **no single source of truth** for the control plane and **no per-repo enable/disable** (a repo is "on" simply by being present in `config/target-repositories.json`). That makes it hard to answer "what is currently gated?" and impossible to pause one repo without editing the targets list. This plan creates a typed config surface (Phase A), adds a per-repo enable flag sourced from state, not the main branch (Phase B), and surfaces the gate states in the dashboard (Phase C). It directly serves the operability/safety goal of having a clear, unified kill-switch.

## Current state

- **Mutation/gate vars** (read ad-hoc as `process.env.*` across the codebase) — the control surface to centralize:
  - `CLAWSWEEPER_ALLOW_EXECUTE`, `CLAWSWEEPER_ALLOW_FIX_PR`, `CLAWSWEEPER_ALLOW_AUTOMERGE`, `CLAWSWEEPER_ALLOW_MERGE`, `COMMENT_ROUTER_EXECUTE`, `COMMIT_FINDINGS_ENABLED`.
  - Runner controls: `CLAWSWEEPER_RUNNER_LABELS`, `CLAWSWEEPER_REVIEW_RUNNER`.
  - (Enumerate the full set in Step A1 — do not assume this list is exhaustive.)
- **Per-repo config**: `config/target-repositories.json` is a list of target repos with profiles; **presence = enabled**. There is no `enabled` field. The planner reads it via `repositoryProfileFor()` / the profile schema in `src/repository-profiles.ts`; the per-repo planning loop is in `src/clawsweeper.ts` (around the `repositoryProfileFor` call sites).
- **State repo**: per-run mutable state lives in the separate `clawsweeper-state` repo (and `records/`), NOT in the main branch — this matters because the sweeper's scoped token should not push control state to `main`.
- **Dashboard**: `dashboard/worker.ts` already mutates a repo variable through `upsertGithubVariable` (used by `setRunnerMode`) and reads runner config via `runnerConfigSnapshot`. After Plan 002, control writes require `DASHBOARD_ADMIN_TOKEN`.

## Commands you will need

| Purpose       | Command                  | Expected   |
|---------------|--------------------------|------------|
| Build all     | `pnpm run build:all`     | exit 0     |
| Lint          | `pnpm run lint`          | exit 0     |
| Unit tests    | `pnpm run test:unit`     | all pass   |
| Repair tests  | `pnpm run test:repair`   | all pass   |
| Full gate     | `pnpm check`             | exit 0     |

## Scope

**Phase A (in scope)**: a new `src/repair/control-config.ts` (typed reader + validation for the gate vars) and the call sites that currently read those specific vars.
**Phase B (in scope)**: `src/repository-profiles.ts` (optional `enabled` field), the planner loop in `src/clawsweeper.ts`, and the state-loading path; the per-repo enabled set is read from **state**, not `config/target-repositories.json` on `main`.
**Phase C (in scope)**: `dashboard/worker.ts` (a read-only `/api/control` snapshot; optionally a master mutation-gate write guarded by the admin token).

**Out of scope (all phases)**:
- Writing control state to the `main` branch of the target or sweeper repo.
- Changing what the gates *do* when off (Phase A preserves current semantics exactly).
- The runner-mode endpoint's existing behavior (only read it for the snapshot).

## Git workflow

- Branches: `advisor/006a-control-config`, `advisor/006b-per-repo-enable`, `advisor/006c-dashboard-control` (one per phase).
- Conventional Commits; example: `feat(control): typed control-plane config surface`.
- Do NOT push, open PRs, or deploy unless the operator instructed it.

## Phase A — typed control-plane config (ship this first)

### Step A1: Enumerate the control vars

`grep -rn "CLAWSWEEPER_ALLOW\|COMMENT_ROUTER_EXECUTE\|COMMIT_FINDINGS_ENABLED\|CLAWSWEEPER_RUNNER\|CLAWSWEEPER_REVIEW_RUNNER" src/ dashboard/ .github/workflows/`. Record every read site and the truthiness convention each uses (e.g. `=== "1"`, `=== "true"`, presence). They may differ — note inconsistencies; Phase A standardizes them behind one parser **without changing each var's current effective value**.

### Step A2: Create `src/repair/control-config.ts`

A pure module exporting a typed reader, e.g.:

```ts
export type ControlGates = {
  allowExecute: boolean;
  allowFixPr: boolean;
  allowAutomerge: boolean;
  allowMerge: boolean;
  commentRouterExecute: boolean;
  commitFindingsEnabled: boolean;
};

export function readControlGates(env: NodeJS.ProcessEnv = process.env): ControlGates { /* ... */ }

// Match each var's CURRENT truthiness rule exactly (from Step A1). If they
// differ, preserve per-var behavior; do not silently normalize a var that
// today treats "true" as on into one that requires "1".
export function isEnabledFlag(value: string | undefined): boolean { /* the dominant convention */ }
```

### Step A3: Route the gate read-sites through it

Replace each ad-hoc `process.env.CLAWSWEEPER_ALLOW_*` (etc.) read found in A1 with `readControlGates(...)`/the typed accessor. **Behavior must be identical** — this is a refactor.

### Step A4: Characterize it

Create `test/repair/control-config.test.ts` (import from `../../dist/repair/control-config.js`; run via `pnpm run test:repair`). Assert each gate's on/off parsing for the exact strings the current code accepts, including the empty/undefined default (which must match today's default-off/default-on behavior per var).

**Verify (Phase A)**: `pnpm run test:repair` → all pass; `pnpm check` → exit 0. Confirm no gate's effective default changed (the tests encode this).

## Phase B — per-repo enable/disable (sourced from state)

### Step B1: Add an optional `enabled` to the repo profile

In `src/repository-profiles.ts`, add an **optional** `enabled?: boolean` to the profile type/schema (default: `true` when absent, so existing configs are unchanged).

### Step B2: Source the disabled-set from state, not `main`

Decide and document where the per-repo enabled/disabled set is read from: the `clawsweeper-state` repo (or a `records/`-side file) — **never** a write to `config/target-repositories.json` on `main` (the scoped token shouldn't push control changes to the main branch). Load it where profiles are resolved.

### Step B3: Honor it in the planner

In the `src/clawsweeper.ts` planning loop (the `repositoryProfileFor()` call sites), **skip** a repo whose resolved state is disabled, with a logged reason. Default (no entry) = enabled.

**Verify (Phase B)**: add a test asserting a disabled repo is skipped and an absent entry stays enabled; `pnpm check` → exit 0.

## Phase C — dashboard visibility (+ optional master switch)

### Step C1: Read-only control snapshot

Add a `GET /api/control` route to `dashboard/worker.ts` returning the current gate states (`readControlGates` equivalent computed from the repo variables it can read via `githubJson`), the runner mode (`runnerConfigSnapshot`), and the per-repo enabled set. No auth needed for read **only if** existing read endpoints are unauthenticated — match the file's convention for `GET` snapshots.

### Step C2 (optional): master mutation-gate write

If you add a write to flip a gate variable, it MUST reuse the Plan 002 admin-token guard (`DASHBOARD_ADMIN_TOKEN` + `timingSafeEqualStr`) and `upsertGithubVariable`. Surface it as one master "mutations on/off" switch before per-gate controls.

**Verify (Phase C)**: `pnpm run build:dashboard`, `pnpm run lint:dashboard`, `pnpm run test:unit` → all pass; extend `test/dashboard-worker.test.ts` for the new route.

## Done criteria

Phase A (minimum shippable):
- [ ] `src/repair/control-config.ts` exists; all gate read-sites from Step A1 route through it
- [ ] `test/repair/control-config.test.ts` pins each gate's current parsing (incl. defaults)
- [ ] `pnpm check` exits 0; no gate's effective behavior changed
- [ ] `plans/README.md` row updated (note which phases landed)

Phases B and C each: their verify steps pass; `pnpm check` exits 0; tests added; README updated.

## STOP conditions

- Step A1 reveals gate vars with **conflicting** truthiness conventions and standardizing them would change a var's effective default — preserve per-var behavior and note it; if you can't preserve it, STOP.
- Phase B: the only available place to persist per-repo state appears to be the `main` branch of a repo — STOP and ask the operator (this violates the token-scope boundary).
- Phase C: existing `GET` snapshot endpoints require auth and it's unclear which token — match the convention or STOP.
- Any phase's verification fails twice after a reasonable fix.

## Maintenance notes

- This is the operator-facing kill-switch foundation. Keep the typed `control-config.ts` the single source of truth — new gates go through it, not fresh `process.env` reads.
- Per-repo state lives in `clawsweeper-state`/`records`, never `main`, to respect the scoped-token boundary.
- Phase C's writes inherit Plan 002's admin-token boundary — do not reintroduce the ingest-token fallback.
- Future: unify per-runtime (`CLAWSWEEPER_RUNNER_LABELS` vs `CLAWSWEEPER_REVIEW_RUNNER`) and per-device controls into the same snapshot for a complete one-surface view.
