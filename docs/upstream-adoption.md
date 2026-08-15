# Upstream adoption policy (openclaw/clawsweeper)

## The constraint

`valkyriweb/clawsweeper` is **not a fork of** `openclaw/clawsweeper` in git terms — the two
repositories have no common ancestor:

```bash
git merge-base main upstream/main   # empty: unrelated histories
# fork root:     ffdb598496  perf: route automerge repairs directly to codex
# upstream root: 002649357e  feat: scaffold clawsweeper
```

Consequences:

- "N behind / M ahead" counts against `upstream/main` are meaningless.
- A merge requires `--allow-unrelated-histories` and lands as a single ~1,300-file collision.
  **A full upstream sync is mechanically wrong**, not merely risky.
- `.github/workflows/upstream-sync.yml` uses plain `git merge --no-ff` and calls
  `git merge --abort` on conflict while exiting 0 — it has failed silently since PR #44.

**Adaptation is the only supported route.** Diff a shared filename, take the behaviour, keep the
fork's types and call sites.

## Comparison surface (measured 2026-08)

| Set | Count |
|---|---|
| Files only upstream has | 983 |
| Files only the fork has | 144 |
| Shared filenames | 221 |
| **Shared and differing** | **172** |

Every one of the 172 has fork commits touching it — there are zero clean takes.

## Never take

- `config/target-repositories.json` — the fleet config.
- `.github/workflows/sweep.yml` — runner labels, lue-kube wiring, `GH_BIN` selection.
- `dashboard/wrangler.toml` — fork Cloudflare account, custom domain, `CLAWSWEEPER_APP_ID`.
- `dashboard/worker.ts` and the rest of `dashboard/` — the fork runs dashboard v2
  (Effect + Convex + Google OAuth, deployed out-of-band to `clawsweeper.myhorizon.co.za`);
  upstream's `worker.ts` is a different product (`exact-review-*` queue) sharing a filename.
- `CHANGELOG.md`, `pnpm-lock.yaml` — pure conflict / regenerate.

Note: a workflow living under `.github/workflows/_disabled/` does **not** mean the code is dead.
The dashboard is disabled in CI and deployed anyway. Confirm liveness before using that inference.

## Adopted so far

| PR | Surface | Shape |
|---|---|---|
| #205 | `src/repair/target-validation.ts` | external-base validation classifier |
| #207 | `src/repair/validation-command-utils.ts` | package-manager built-in command classification |

## Assessed and rejected as unbounded

Upstream advanced the repair cluster behind new infrastructure modules the fork does not have,
so these are not file-level adoptions:

| File | Blocking upstream-only dependency |
|---|---|
| `src/repair/update-command-status.ts` | `command-action-ledger.ts`, `command-ack-convergence.ts` |
| `src/repair/publish-main.ts` | `canonical-record-baseline.ts`, `record-tuple.ts` |
| `src/repair/apply-result.ts` | `apply-locks.ts` |
| `prompts/review-item.md` | 151 -> 1034 line rewrite; would clobber the fork's change-tier calibration (#167, #168), repair routing, and release-provenance gates, and cannot be unit-tested |

Adopting any of these means porting the dependency first, as its own reviewed change.

## Procedure for the next adoption

1. `git fetch upstream`, then `git diff --numstat origin/main upstream/main -- <file>`.
2. Check upstream's imports for modules absent from the fork. If any exist, stop — it is not bounded.
3. Port behaviour into the fork's existing types; do not replace the file.
4. Add tests under `test/repair/` that fail without the change.
5. Baseline `pnpm run test:repair` on `main` before claiming a pass — some local failures are
   environmental (`fetch.prune=true`, missing Pi CLI). Compare, do not read absolutely.
6. One surface per PR. Never combine an adoption with a `sweep.yml` or targets change: if the
   cluster breaks, attribution becomes impossible.
