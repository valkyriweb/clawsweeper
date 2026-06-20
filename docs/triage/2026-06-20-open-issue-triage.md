# Open-issue triage — 2026-06-20

Triage of the full ClawSweeper open-issue backlog (12 issues) against current `main`
(`09a253f0ef`), before changing anything. Verdict per issue is one of
`still-real` | `partially-fixed` | `stale/already-fixed`, each with file:line or
commit-SHA evidence. Goal source: `docs/goals/goal-2026-06-20T08-30-58Z-...md`
(review-pipeline reliability, triage-first).

Several review-reliability issues filed in May were silently addressed by later
work (watchdog, max-tokens retry, related-item body cap) without the issues being
closed — the triage below proves which.

## Verdict table

| # | Title (short) | Verdict | Evidence | Action |
|---|---|---|---|---|
| 75 | codex review hangs ~600s silently on small diffs | **stale/already-fixed** | `runCodexWithStartupWatchdog` spawns codex via `spawn()` (not `spawnSync`) with startup+total timers → SIGTERM/SIGKILL → `ETIMEDOUT` classified `"startup watchdog fired after Nms"` (`src/clawsweeper.ts:5600-5870`); codex stdout/stderr persisted as artifacts; tests `test/clawsweeper.test.ts:3672` ("startup watchdog aborts when Codex never emits initial output") + `:4942`. Commit `89842b52c9`. Live: recent sweep reviews all `completed/success` (2026-06-17), no 600s hangs. | **Close** |
| 54 | runClaude hardcodes max_tokens=8192, truncates reviews | **stale/already-fixed** | Cap is now `DEFAULT_CLAUDE_REVIEW_MAX_TOKENS=16384` with retry at `32768` (`src/clawsweeper.ts:4717-4750`); retry on `stop_reason=max_tokens` (`:4950-5050`); truncation-vs-config classifier (`:4386-4392`). Tests `test/clawsweeper.test.ts:5067/5134/5191`. Commit `49ed9c180d` (PR #55). | **Close** |
| 28 | reviewer Claude path hits max_tokens on related-items bloat | **stale/already-fixed** | Lever 1 (trim related-items): `RELATED_ITEM_BODY_LIMIT=2000` defined `src/clawsweeper.ts:2044` (comment explicitly cites #28), wired into related-item context `:2266` & `:2274`. Lever 3 (output-budget): max_tokens retry from #54/PR #55. Acute symptom (70k-char prompt → max_tokens) addressed by smaller context + retry. Lever 2 (secondary-reviewer fallback) not implemented but not required for the fix. | **Close** (note lever 2 as optional future work) |
| 22 | CI failed: intake/validation non-Node + mixed-case targets | **stale/already-fixed** | Landed via PR #21, commit `4ee60b800e` (confirmed ancestor of `main`): composer/php/vendor-bin allowlist `src/repair/validation-command-utils.ts:91-99`; case-insensitive repo match `src/repair/issue-implementation-intake.ts:346-349`; tests in `test/repair/target-validation.test.ts:175-213` + `test/repair/issue-implementation-intake.test.ts:282-291`. | **Close** |
| 68 | verdict sticky-update fails on fork installs (allowlist) | **still-real** | `PATCHABLE_REVIEW_COMMENT_AUTHORS` is a hardcoded set + env override only (`src/clawsweeper.ts:8231`); `canPatchReviewComment` (`:8247`) rejects fork App bot logins like `valkyriweb-clawsweeper[bot]`, so `upsertReviewComment` (`:8303`) POSTs a new verdict each run. Env-var workaround `CLAWSWEEPER_COMMENT_AUTHOR_LOGIN` merged (PR #71, `0fe396e832`) but the issue's preferred option-1 auto-derive is NOT done. | **Fix** (recognize clawsweeper App-family bot) |
| 67 | add `--bare` to runClaudeCode args | **still-real** | `runClaudeCode` arg array (`src/clawsweeper.ts:5180-5193`) has no `--bare`; SessionEnd hooks still run on CI runners. | **Fix** |
| 14 | trim long bot-comment histories from review prompt | **still-real** | No `trimBotCommentHistory` helper anywhere in `src/`; ClawSweeper's own prior review comments are not trimmed from the prompt body. `maintainer`-tagged (auto-close skip). | **Fix** |
| 15 | Anthropic-via-claude-bridge review path (slice A tracker) | **partially-fixed** (tracker) | Slices 2-6 implemented on main: `runReview` dispatcher (`src/clawsweeper.ts:4677-4696`), `runClaude` (`:4847+`), prompt `prompts/review-item-claude.md`, context collector `populateClaudeEvidence`, sweep.yml `review_provider` routing. Slice 1 (bridge deploy = infra) + slice 7 (live A/B sampler) deferred. `maintainer`-tagged. | **Keep open** (tracker) |
| 94 | add pi-harness review provider to commit-review lane | **still-real** | `commit-review.yml` `review` job is codex-only (only `setup-codex`; "Review commit" hardcodes `--codex-model gpt-5.5 --codex-reasoning-effort high --codex-sandbox danger-full-access`); `src/commit-sweeper.ts` review command surfaces only `--codex-*` flags (~`reviewCommand` L329-366). Enhancement; secondary. | **Keep open** (defer) |
| 34 | verify-reproduction: pick PHP version from composer.json | **still-real** | `verify-reproduction.yml:135` hardcodes `php-version: "8.3"`; `repair-cluster-worker.yml` has no setup-php step. Enhancement; secondary. | **Keep open** (defer) |
| 33 | verify-reproduction: PHP version mismatch misclassified | **still-real** | `ENV_FAILURE_PATTERNS` (`src/repair/verify-reproduction.ts:54-78`) has no PHP-version / platform-requirement pattern, so a Composer PHP-mismatch is classified `reproduced` not `blocked`. Bug; secondary. | **Keep open** (fix if quick) |
| 17 | runner mac-mini Node 25.9.0 cannot load icu4c@78 | **still-real** (infra-only) | No clawsweeper code involved; mac-mini runner Homebrew Node/ICU mismatch breaks npm-based validation. | **Keep open** (infra) |

## Summary

- **12 open** at triage time.
- **stale/already-fixed → close (4):** #75, #54, #28, #22.
- **confirmed still-real review-reliability → fix via merged PR (3):** #68, #67, #14.
- **partially-fixed tracker → keep open (1):** #15.
- **still-real secondary/infra → keep open w/ next-action (4):** #94, #34, #33, #17.

Expected backlog after this goal's closes: 12 − 4 = **8 open** (further −3 as the
#68/#67/#14 fixes merge → **5 open**: #15, #94, #34, #33, #17).

## Next-action notes (issues left open)

- **#15** — implementation slices 1-6 complete; remaining work is slice 7 (live A/B
  sampler) + confirming the bridge deploy. Tracker, `maintainer`. No code change due.
- **#94** — enhancement: give the commit-review lane the same `review_provider`
  routing the sweep lane has (provider abstraction in `commit-sweeper.ts review` +
  conditional `setup-pi`/`setup-claude-code` in `commit-review.yml`). Parked.
- **#34** — enhancement: replace `php-version: "8.3"` in `verify-reproduction.yml`
  with `php-version: highest` (or parse `require.php` from target composer.json).
- **#33** — bug: extend `ENV_FAILURE_PATTERNS` with a `php_version_too_low` /
  platform-requirement pattern + regression test. Quick; candidate for a fix PR.
- **#17** — infra: `brew reinstall node` on the mac-mini runner so it links current
  icu4c; schedule a single-runner maintenance window. No clawsweeper code.
