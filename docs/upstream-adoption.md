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
| #256 | `src/repair/collect-codex-debug.ts`, `src/codex-env.ts` | debug artifact credential redaction from the reverted upstream #521 branch (internal-model redaction left out) |
| #296, #297, #298 | `.github/actions`, workflows, `sweep.yml` | upstream #2064: untrusted `${{ }}` expressions passed through step `env:`; guard test now covers every workflow and action |
| #299 | `.github/actions`, workflows | upstream #2078 (Node 24.22.1 only) and #2063 (state token narrowed to contents, no default `actions: write`) |
| #300 | `test/review-command-workflow.test.ts` | upstream #2066: coverage only, the fork already handles targets closing during setup |
| #301 | `src/clawsweeper.ts`, `src/github-item-identity.ts`, `sweep.yml` exact-event job | upstream #2056: transferred or verified-missing items retire the old identity |
| #302 (open) | `src/hidden-payload-security.ts`, close validation | upstream #2061: concealed shell payloads keep items open; awaiting Luke's OK because auto-close is live |

## Last upstream review (October 2026)

| Marker | Commit | Meaning |
|---|---|---|
| B | `77bb944273` (upstream #2042, 16 Oct) | previous reviewed upstream point |
| U | `400517640b` (upstream #2085) | upstream head reviewed this round |
| L | `7725e4c50e` (#301) | fork `main` after the merged ports; the new base for the next review is B = `400517640b` |

The 35 upstream commits in `B..U`:

| Commit | Upstream | Class | Note |
|---|---|---|---|
| `892e2aabc3` | #2044 | reject | Worker / Durable Object review queue |
| `cb5eaa3cf2` | #2045 | reject | Worker / Durable Object review queue |
| `61b23c298e` | #2046 | reject | Worker / Durable Object review queue |
| `959b5ad440` | #2047 | reject | Worker / Durable Object review queue |
| `eec651ce5b` | #2048 | reject | Worker / Durable Object review queue |
| `90e43f4daa` | #2049 | reject | Worker / Durable Object review queue |
| `7bcab824b1` | #1966 | defer | review content filtering; depends on upstream prompt split |
| `fb06a964d8` | #1978 | reject | local reviewer packaging |
| `a0dff4a7f2` | #2052 | reject | R2 storage |
| `b7149f1d7a` | #2053 | reject | R2 canonical records |
| `96e800e740` | #1983 | reject | local package qualification |
| `2000d96fed` | #2054 | defer | review verification; depends on upstream canonical envelope |
| `042c9ee516` | #2055 | defer | review prompt policy; see the `prompts/review-item.md` row above |
| `7375420f28` | #1991 | reject | Worker / Durable Object queue transitions |
| `385ed215fa` | #2056 | adapt | #301 |
| `ac1ad31650` | #2039 | defer | full re-review on every target-branch commit; cost decision |
| `cd064607a2` | #2059 | reject | R2 canonical verification |
| `ea6d72efc0` | #2060 | reject | macOS / Xcode package CI |
| `32a17b44a5` | #2066 | equivalent | #300 adds coverage only |
| `8779343ff7` | #2061 | adapt | #302, open |
| `25edd06c5f` | #2062 | reject | OIDC / Worker-owned dispatchers |
| `442acabe35` | #2068 | reject | R2 canonical migration |
| `5af774151f` | #2063 | adapt | #299, state token only; target tokens already scoped |
| `e21c3b97dd` | #2064 | adapt | #296, #297, #298 |
| `a8ed845bfd` | #2069 | reject | upstream dashboard |
| `f76cd14bee` | #2070 | reject | local packaging |
| `d9a200ae55` | #2072 | reject | package CI |
| `b79b76cc0c` | #2071 | defer | 39 files; every owning apply and coverage-proof module is absent here, so it is not bounded |
| `15b24d4aef` | n/a | defer | maintainer-approval labeling; depends on upstream label routing |
| `33d59f896e` | #2078 | adapt | #299 takes Node 24.22.1; pnpm 12 is deferred |
| `8a91685d41` | #2080 | reject | R2 canonical migration |
| `6a5ea50e2b` | #2081 | reject | release packaging |
| `6fddcc8f7e` | #2082 | reject | upstream dashboard |
| `f2a7da47a5` | #2084 | reject | upstream release notes |
| `400517640b` | #2085 | reject | R2 canonical provenance |

Totals: 6 adopted (5 adapt, 1 equivalent) across 7 fork PRs, 23 reject, 6 defer.

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
