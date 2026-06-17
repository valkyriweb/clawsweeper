# Plan 005: Extract the GitHub client/auth out of `dashboard/worker.ts` (first god-file split; establishes the recipe)

> [!CAUTION]
> **Deferred after STOP. Do not execute this plan as written.** Follow-up investigation found the GitHub client/auth cluster is not a pure move: `githubAuthToken` closes over module-scoped `githubAppTokenCache`, helpers are scattered through the Worker, and runner functions are interleaved with token-minting code. Treat this file as discovery context for a reviewed re-plan, not an approved implementation recipe.

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. This
> is a **mechanical move with no logic changes** — if you find yourself
> rewriting logic, STOP. If a "STOP conditions" item occurs, stop and report.
> When done, update this plan's row in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 8547e9c8e9..HEAD -- dashboard/worker.ts`
> If `worker.ts` changed since this plan was written, re-locate the cluster by
> the function names below before proceeding; on a structural mismatch, STOP.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED (touches the large Worker file; mitigated by "move only, no logic change" + existing test)
- **Depends on**: Plan 002 (it also edits `worker.ts` — land 002 first to avoid conflicts)
- **Category**: tech-debt
- **Planned at**: commit `8547e9c8e9`, 2026-06-16

## Why this matters

`dashboard/worker.ts` is 3722 LOC and mixes HTTP routing, triage snapshotting, and a complete GitHub REST/GraphQL client with **GitHub App token minting**. The token-minting code (`createGithubAppInstallationToken`, `githubAppCredentials`, …) is security-sensitive and buried in the middle of an enormous file, which makes it hard to review and easy to accidentally entangle with unrelated request handling. Extracting the cohesive GitHub client/auth cluster into its own module shrinks the god-file, isolates the credential code for focused review, and establishes a repeatable extraction recipe for the other three god-files (listed under Maintenance). This plan changes **no behavior** — it relocates code.

## Current state

- `dashboard/worker.ts` is a Cloudflare Worker bundled by wrangler; `tsconfig.dashboard.json` uses `noEmit: true` + `allowImportingTsExtensions: true`, so a new sibling `.ts` module imported with a `.ts` extension is bundled correctly.
- The cohesive **GitHub client/auth cluster** to extract (contiguous, roughly lines 1849–2090), by function name:
  - `githubJson(env, path)`
  - `githubWriteJson(env, path, options)`
  - `upsertGithubVariable(env, repo, name, value)`
  - `githubGraphql(env, query, variables)`
  - `hasGithubAuth(env)`
  - `githubAuthToken(env, access)`
  - `githubAppCredentials(env)`
  - `createGithubAppInstallationToken(env, credentials, repos, access)`
  - `githubAppInstallationId(appJwt, repo)`
  - `githubAppJson(path, appJwt, options)`
  - plus any **private** helper these call that is not used elsewhere (e.g. a base-URL constant, a JWT/signing helper, fetch wrappers). Use `grep` to confirm each helper's other callers before moving it.
- These functions take `env`/explicit params (not module-scoped closures), which is what makes the move tractable. **Verify this per function before moving** — if one closes over a module-level mutable, that's a STOP.
- Test: `test/dashboard-worker.test.ts` runs under `pnpm run test:unit` and imports from `../dashboard/worker.ts`. Keep `worker.ts`'s public surface (its `export default { fetch }` and any named exports the test uses) unchanged.

## Commands you will need

| Purpose         | Command                       | Expected   |
|-----------------|-------------------------------|------------|
| Build dashboard | `pnpm run build:dashboard`    | exit 0     |
| Lint dashboard  | `pnpm run lint:dashboard`     | exit 0     |
| Unit tests      | `pnpm run test:unit`          | all pass   |
| Full gate       | `pnpm check`                  | exit 0     |

## Scope

**In scope**:
- `dashboard/worker-github.ts` (create — the extracted cluster)
- `dashboard/worker.ts` (remove the moved functions; add an import)

**Out of scope**:
- Any **logic change** to the moved functions — relocation only.
- The auth/control endpoints from Plan 002 (`setRunnerMode`, `ingestEvent`, `timingSafeEqualStr`) — leave them in `worker.ts`.
- The other three god-files (deferred — see Maintenance).

## Git workflow

- Branch: `advisor/005-extract-worker-github-client`
- Conventional Commits; example: `refactor(dashboard): extract GitHub client/auth into worker-github.ts`
- Commit once, after the move builds + tests green.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Confirm the cluster is self-contained

For each function listed in "Current state", run `grep -n "<name>" dashboard/worker.ts` and confirm:
- It takes what it needs via parameters (no module-level closure it would lose by moving).
- Every helper it calls is either (a) also in the move set, or (b) still importable from `worker.ts`/another module.

If any function closes over a module-scoped mutable variable defined in `worker.ts`, **STOP** and report — that one needs a different approach.

### Step 2: Create `dashboard/worker-github.ts`

Move the cluster verbatim into the new file. `export` each function that `worker.ts` still references. Add any imports the moved code needs (e.g. types). Keep names identical.

### Step 3: Import back into `worker.ts`

Replace the removed definitions in `worker.ts` with a single import:

```ts
import {
  githubJson, githubWriteJson, upsertGithubVariable, githubGraphql,
  hasGithubAuth, githubAuthToken, createGithubAppInstallationToken,
  // ...everything worker.ts still calls
} from "./worker-github.ts";
```

(Use the `.ts` extension to match the dashboard config's `allowImportingTsExtensions`. Confirm against how other dashboard modules import siblings, if any exist.)

### Step 4: Verify nothing changed but the layout

**Verify**:
- `pnpm run build:dashboard` → exit 0
- `pnpm run lint:dashboard` → exit 0
- `pnpm run test:unit` → all pass (the existing `dashboard-worker.test.ts` must still pass unchanged)
- `pnpm check` → exit 0

## Test plan

No new tests — this is a behavior-preserving move; the existing `test/dashboard-worker.test.ts` is the regression guard. If it imported any of the moved functions directly, update its import path to `../dashboard/worker-github.ts` and keep the assertions identical.

## Done criteria

- [ ] `dashboard/worker-github.ts` exists and contains the GitHub client/auth cluster
- [ ] `dashboard/worker.ts` no longer defines those functions (`grep -n "function createGithubAppInstallationToken" dashboard/worker.ts` → no match; it's now in `worker-github.ts`)
- [ ] `worker.ts` line count dropped by roughly the size of the moved cluster (`wc -l dashboard/worker.ts`)
- [ ] `pnpm run build:dashboard`, `pnpm run lint:dashboard`, `pnpm run test:unit` all exit 0
- [ ] `pnpm check` exits 0
- [ ] `git diff` shows only moves (no logic edits) — a reviewer can diff the moved block against the original
- [ ] `plans/README.md` status row updated

## STOP conditions

- Any function in the cluster closes over a `worker.ts` module-scoped mutable (can't move cleanly).
- A moved function is also referenced by a non-dashboard module (it shouldn't be — these are Worker-only) — report it.
- The existing dashboard test fails after the move and the cause isn't an import-path update.
- You feel the need to change logic to make it compile — STOP; relocation should be pure.

## Maintenance notes

- **Repeatable recipe** (apply to the other god-files in separate plans, each gated by its own characterization tests — see Plan 003):
  - `src/repair/execute-fix-artifact.ts` (4228 LOC) → extract the **Codex-runner cluster** (`spawnCodexSyncWithHeartbeat`, `startCodexHeartbeat`/`stopCodexHeartbeat`, `runCodexReview`/`runCodexReviewFix`/`runCodexValidationFix`, `codex*SandboxConfigArgs`, `classifyCodexFailure`, `codexRetryDelayMs`, …) into `src/repair/codex-runner.ts`. Highest value (isolates the code-execution trust boundary), but highest risk — do it **only** after characterization tests exist for that file.
  - `src/repair/comment-router.ts` (3229 LOC) → extract the **classification cluster** (`classifyCommand`, `classifyAutoclose`, `classifyAutomergePass`, `classifyNeedsHuman`, …, lines ~342–1240) into `comment-router-classify.ts`. Pure decision logic, very testable; `comment-router-core.ts` is the existing precedent for this split.
- Do these one file per PR; never two god-files in one change.
- A reviewer should verify the diff is a pure move (no behavioral hunks).
