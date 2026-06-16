# Plan 003: Pin the merge/close safety gates with characterization tests; stop silently swallowing label errors

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If a
> "STOP conditions" item occurs, stop and report — do not improvise. When done,
> update this plan's row in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 8547e9c8e9..HEAD -- src/repair/apply-result.ts`
> If `apply-result.ts` changed since this plan was written, compare the
> "Current state" excerpts to the live code before proceeding; on a mismatch, STOP.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW (adds tests + additive exports; one tiny behavior change in error logging)
- **Depends on**: none (but should land before Plan 005, which refactors these files)
- **Category**: tests
- **Planned at**: commit `8547e9c8e9`, 2026-06-16

## Why this matters

`src/repair/apply-result.ts` (1022 LOC) executes ClawSweeper's irreversible writes — it merges, comments on, and closes PRs/issues. The code *around* it is tested (execute-fix-*, automerge-*, security-boundary), but `apply-result.ts` itself has **no direct test file**. Its policy validators — `validateMergePolicy`, `validateClosePolicy` — are the deterministic gates that decide whether a merge or close is allowed; they are pure functions, currently unexported and uncovered. Characterizing them with tests pins the current safety behavior so a later refactor (Plan 005) cannot silently weaken a gate. This plan also fixes `ensureLabel`, whose `catch` block silently swallows *all* errors via a dead branch (it `return`s on every path), hiding real label-API failures.

## Current state

- `src/repair/apply-result.ts` — the applier; runs from a CLI entry guard, so importing it for tests does **not** auto-execute.
- Pure policy gates (currently **not exported**), as they exist today:
  - `validateMergePolicy({ job, action })` (~line 619): returns `""` if a merge is allowed, else a reason string. Checks `job.frontmatter.allowed_actions.includes("merge")`, `blocked_actions`, `allow_merge === true`, and that `action.action` is `merge_candidate`/`merge_canonical`.
  - `validateClosePolicy({ job, actionName })` (~line 550): returns `""` if close allowed, else a reason. Checks `allowed_actions` has `close` + `comment`, `blocked_actions`, and the `allow_instant_close` rule for actions other than `close_low_signal`/`post_merge_close`.
- `ensureLabel` (~line 630), the bug to fix:
  ```ts
  function ensureLabel(repo: string, name: string, color: JsonValue, description: JsonValue) {
    try {
      ghWithRetry(["label", "create", name, "--repo", repo, "--color", color, "--description", description], 2);
    } catch (error) {
      const detail = ghErrorText(error);
      if (!/already exists/i.test(detail)) return;   // <-- BUG: every branch just returns; real errors vanish
    }
  }
  ```
  `ensureLabel` is called by `labelForClawSweeperReview` **unguarded**, so it must remain best-effort (throwing here could abort a real repair over a cosmetic label). The fix is to keep it non-fatal but make real failures **visible**, and remove the misleading dead branch.
- **Test convention (important)**: tests under `test/repair/` import the **compiled** module from `../../dist/repair/<name>.js` and require a build first. Exemplar: `test/repair/git-publish.test.ts` imports `from "../../dist/repair/git-publish.js"`. Run them via `pnpm run test:repair` (which builds first) or `pnpm run build:repair && node --test test/repair/<file>.test.ts`.

## Commands you will need

| Purpose             | Command                                                          | Expected           |
|---------------------|-----------------------------------------------------------------|--------------------|
| Build repair        | `pnpm run build:repair`                                          | exit 0             |
| Repair tests        | `pnpm run test:repair`                                           | all pass           |
| Single new test     | `pnpm run build:repair && node --test test/repair/apply-result-policy.test.ts` | all pass |
| Lint repair         | `pnpm run lint:repair`                                           | exit 0             |
| Full gate           | `pnpm check`                                                     | exit 0             |

## Scope

**In scope**:
- `src/repair/apply-result.ts` — add `export` to `validateMergePolicy` and `validateClosePolicy`; fix `ensureLabel`.
- `test/repair/apply-result-policy.test.ts` (create).

**Out of scope**:
- Any behavior change to `validateMergePolicy`/`validateClosePolicy` — only add the `export` keyword. Characterize *current* behavior; do not "improve" it.
- The I/O-bound validators (`validateFixFirstClose`, `validateMergePreflight`) — they call `gh`/read reports and need seam extraction first. Listed as deferred follow-ups below; do NOT attempt them here.
- `finalize-open-prs.ts`, `post-flight.ts`, `commit-finding-intake.ts` — deferred follow-ups (same technique, separate plans).

## Git workflow

- Branch: `advisor/003-characterize-merge-close-gates`
- Conventional Commits; example: `test(repair): characterize merge/close policy gates`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Export the two pure policy validators

In `src/repair/apply-result.ts`, add the `export` keyword to `function validateMergePolicy(` and `function validateClosePolicy(`. Change nothing else about them.

**Verify**: `pnpm run build:repair` → exit 0.

### Step 2: Characterize them with a test matrix

Create `test/repair/apply-result-policy.test.ts`, importing `from "../../dist/repair/apply-result.js"`, modeled on the structure of `test/repair/fix-edit-policy.test.ts` (a sibling pure-policy test — read it for the assertion style). Cover, by constructing minimal `job`/`action` fixtures:

- `validateMergePolicy`:
  - allowed: `allowed_actions: ["merge"]`, `allow_merge: true`, `action.action: "merge_candidate"` → returns `""`.
  - blocked: missing `"merge"` in `allowed_actions` → returns the "job does not allow merge" reason.
  - blocked: `blocked_actions: ["merge"]` → its reason.
  - blocked: `allow_merge` not `true` → its reason.
  - blocked: unsupported `action.action` (e.g. `"comment"`) → "unsupported merge action".
- `validateClosePolicy`:
  - allowed: `allowed_actions: ["close","comment"]`, `actionName: "close_low_signal"` → `""`.
  - blocked: missing `close` / missing `comment` → respective reasons.
  - blocked: `blocked_actions` includes `close` / `comment` → respective reasons.
  - the `allow_instant_close` rule: `actionName` not in `["close_low_signal","post_merge_close"]` and `allow_instant_close !== true` → "instant close requires allow_instant_close: true"; and allowed when `allow_instant_close: true`.

Assert the **current** return values (run the function to discover the exact reason strings if unsure — these tests lock in today's behavior).

**Verify**: `pnpm run build:repair && node --test test/repair/apply-result-policy.test.ts` → all pass.

### Step 3: Fix `ensureLabel`'s silent swallow (BUG-2)

Replace the `catch` body so benign "already exists" stays silent, real errors are logged, and nothing throws:

```ts
} catch (error) {
  const detail = ghErrorText(error);
  if (/already exists/i.test(detail)) return; // benign: label already present
  console.warn(`ensureLabel: could not create label "${name}" in ${repo}: ${detail}`);
  // best-effort: a cosmetic label must not abort the repair
}
```

If `apply-result.ts` already imports a logger/`logProgress` helper, use that instead of `console.warn` to match the file's convention; otherwise `console.warn` is fine.

**Verify**: `pnpm run build:repair` → exit 0; `pnpm run lint:repair` → exit 0.

### Step 4: Full gate

**Verify**: `pnpm check` → exit 0.

## Test plan

- New file `test/repair/apply-result-policy.test.ts` with the matrix in Step 2 (≥10 assertions across the two validators).
- `ensureLabel` is not unit-tested here (it does `gh` I/O and isn't exported; mocking `gh` is out of scope). Its change is non-fatal and behavior-preserving except for added logging — covered by review. State this in the PR.
- Pattern to copy: `test/repair/fix-edit-policy.test.ts`.

## Done criteria

- [ ] `validateMergePolicy` and `validateClosePolicy` are exported (`grep -n "export function validateMergePolicy\|export function validateClosePolicy" src/repair/apply-result.ts` → 2 matches)
- [ ] `test/repair/apply-result-policy.test.ts` exists and passes
- [ ] `ensureLabel` no longer has the `if (!/already exists/i.test(detail)) return;` dead branch (`grep -n "if (!/already exists/i.test(detail)) return" src/repair/apply-result.ts` → no matches)
- [ ] `pnpm run test:repair` exits 0
- [ ] `pnpm check` exits 0
- [ ] `git status` shows only `src/repair/apply-result.ts` and the new test file modified
- [ ] `plans/README.md` status row updated

## STOP conditions

- The functions/excerpts at the cited lines don't match "Current state" (drift) — re-locate by name; if the logic differs materially, STOP.
- Exporting `validateMergePolicy`/`validateClosePolicy` causes a name collision or a lint error you can't resolve trivially — report it.
- A new test reveals one of the validators does **not** behave as described here — do NOT change the validator; report the discrepancy (the audit may be stale, or there's a real latent bug worth a separate decision).

## Maintenance notes

- **Deferred follow-up plans** (same technique — export the pure decision core, then characterize):
  - `validateFixFirstClose` and `validateMergePreflight` in `apply-result.ts` — these mix policy with `gh`/report I/O; extract the pure decision into a helper first, then test.
  - Characterization suites for `finalize-open-prs.ts`, `post-flight.ts`, `commit-finding-intake.ts` (the other untested mutation appliers).
- A reviewer should confirm the tests assert *current* behavior (regression pins), not aspirational behavior.
- These tests are the safety net Plan 005 relies on before extracting modules from these files.
