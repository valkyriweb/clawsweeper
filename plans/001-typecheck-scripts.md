# Plan 001: Add a type-check gate for `scripts/` so production guard scripts can't ship type errors

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan in
> `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 8547e9c8e9..HEAD -- package.json tsconfig.json tsconfig.repair.json tsconfig.dashboard.json scripts/`
> If `package.json` or the tsconfigs changed since this plan was written,
> compare the "Current state" excerpts against the live files before
> proceeding; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: dx
- **Planned at**: commit `8547e9c8e9`, 2026-06-16

## Why this matters

The files in `scripts/` run in production CI as native TypeScript (Node 24 type-stripping, no compile step). They include live operational guards — `scripts/check-telemetry-egress.ts`, `scripts/check-limits.ts`, `scripts/check-active-surface.ts` — that gate the pipeline. **No `tsconfig` includes `scripts/`**, and `lint:scripts` runs `oxlint` *without* `--type-aware`, so a wrong property access, bad import, or `undefined` flow in a guard script is invisible until it throws at runtime in CI. This plan adds a `noEmit` type-check over `scripts/` and wires it into the `check` gate, so type errors fail fast locally and in CI. (Extending the same gate to `test/` is deliberately deferred to keep this slice bounded and green — see Maintenance notes.)

## Current state

- `package.json` (the relevant lines):
  - `"lint:scripts": "oxlint scripts test --deny-warnings --report-unused-disable-directives -D correctness"` — note: **no `--tsconfig`, no `--type-aware`**.
  - `"check": "pnpm run check:active-surface && pnpm run check:limits && pnpm run build:all && pnpm run lint && pnpm run test:unit && pnpm run test:repair && pnpm run test:coverage:changed && pnpm run test:coverage && pnpm run format:check"` — there is **no `typecheck` step**.
  - `"format": "oxfmt --write src scripts test dashboard package.json tsconfig.json tsconfig.repair.json tsconfig.dashboard.json .oxfmtrc.json config schema .github/actions .github/workflows"` and the matching `"format:check": "oxfmt --check ... tsconfig.json tsconfig.repair.json tsconfig.dashboard.json ..."` — note the explicit per-file list of tsconfigs (a new tsconfig must be added here or oxfmt won't format-check it).
- The three existing tsconfigs and what they cover:
  - `tsconfig.json` → `"include": ["src/**/*.ts"]`, `"exclude": ["src/repair/**"]`
  - `tsconfig.repair.json` → `"include": ["src/usage-telemetry.ts", "src/repository-profiles.ts", "src/repair/**/*.ts"]`
  - `tsconfig.dashboard.json` → `"include": ["dashboard/**/*.ts"]`, and crucially uses `"noEmit": true` + `"allowImportingTsExtensions": true` (copy this pattern).
  - **None include `scripts/` or `test/`.**
- The TypeScript compiler is `tsgo` (the `@typescript/native-preview` dev dependency). Invoke as `pnpm exec tsgo -p <config>`.
- Scripts import sibling TypeScript with explicit `.ts` extensions, e.g. `scripts/check-telemetry-egress.ts` imports from `../src/usage-telemetry.ts`. That is why the new config needs `allowImportingTsExtensions: true`.

## Commands you will need

| Purpose            | Command                              | Expected on success      |
|--------------------|--------------------------------------|--------------------------|
| Install            | `pnpm install`                       | exit 0                   |
| Type-check scripts | `pnpm exec tsgo -p tsconfig.scripts.json` | exit 0, no errors    |
| Full gate          | `pnpm check`                         | exit 0                   |
| Format check       | `pnpm run format:check`              | exit 0                   |

## Scope

**In scope** (the only files you may modify):
- `tsconfig.scripts.json` (create)
- `package.json` (add one script; wire it into `check`; add the new tsconfig to the two oxfmt file lists)

**Out of scope** (do NOT touch):
- Any file under `src/`, `test/`, `dashboard/`, `.github/`.
- The three existing tsconfigs.
- Any runtime logic in `scripts/` — **except** a minimal type-only fix to a script if step 1 surfaces a small, clearly-correct type error (see step 1 bounds). Do not refactor.

## Git workflow

- Branch: `advisor/001-typecheck-scripts`
- Conventional Commits (repo style — see `git log --oneline`); example: `build(scripts): type-check scripts/ in the check gate`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Create `tsconfig.scripts.json` and see what it surfaces

Create `tsconfig.scripts.json`, modeled on `tsconfig.dashboard.json` but `strict` and scoped to scripts:

```json
{
  "compilerOptions": {
    "target": "ES2024",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2024"],
    "types": ["node"],
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "allowImportingTsExtensions": true
  },
  "include": ["scripts/**/*.ts"]
}
```

**Verify**: `pnpm exec tsgo -p tsconfig.scripts.json`

- **Exit 0** → go to Step 2.
- **Errors only inside `scripts/`, ≤ ~15, each trivially correct** (a missing null guard, a wrong import path, an obviously wrong property name) → fix them minimally inside `scripts/` and re-run until exit 0, then go to Step 2.
- Otherwise → **STOP** (see STOP conditions). Do not mass-rewrite.

### Step 2: Add the `typecheck:scripts` script

In `package.json` `scripts`, add (next to the other `check:*` scripts):

```json
"typecheck:scripts": "tsgo -p tsconfig.scripts.json",
```

### Step 3: Wire it into the `check` gate and the format lists

- In the `"check"` script, insert `pnpm run typecheck:scripts && ` immediately **after** `pnpm run build:all && ` (build first so any generated types exist, then type-check).
- Add `tsconfig.scripts.json` to **both** the `"format"` and `"format:check"` file lists (right after `tsconfig.dashboard.json`).

**Verify**:
- `pnpm run typecheck:scripts` → exit 0
- `pnpm run format:check` → exit 0
- `pnpm check` → exit 0

## Test plan

No unit tests — this is a tooling gate. The gate itself is the verification: `pnpm check` must pass with the new `typecheck:scripts` step present and green.

## Done criteria

- [ ] `tsconfig.scripts.json` exists with `"noEmit": true` and `"include": ["scripts/**/*.ts"]`
- [ ] `pnpm exec tsgo -p tsconfig.scripts.json` exits 0
- [ ] `package.json` `check` runs `typecheck:scripts` after `build:all`
- [ ] `pnpm check` exits 0
- [ ] `pnpm run format:check` exits 0
- [ ] `git status` shows only `tsconfig.scripts.json` and `package.json` modified (plus any minimal in-scope script fix from step 1)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report (do not improvise) if:
- Type errors appear in files **outside `scripts/`** (the config is pulling in `src` debt — report the list; do not "fix" src).
- More than ~15 errors surface, or any fix would require changing a script's runtime behavior, touching `src/`, or weakening `strict`.
- `pnpm exec tsgo` is not found or errors on the config itself (report the exact message).
- The `package.json` `check` or `format` strings don't match the "Current state" excerpts (drift).

## Maintenance notes

- **Deferred follow-up**: extend type-checking to `test/` (a `tsconfig.test.json` including `test/**/*.ts`, or widen this config). Deferred because `test/` imports both `src/` and `src/repair/` (which build under looser settings) and may surface more pre-existing debt — that deserves its own bounded plan.
- A reviewer should confirm CI actually runs `pnpm check` (see `.github/workflows/ci.yml`) so the new step runs in CI, not just locally.
- If `scripts/` later import from `src/repair/`, watch for stricter-vs-looser setting mismatches.
