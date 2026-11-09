---
name: verify-pr-automerge-gate
description: "Model-check the ClawSweeper PR automerge gate (comment router merge path, exact-head pass verdict, --match-head-commit, automerge shepherd) with TLA+/TLC. Use when a change touches executeAutomerge, validateAutomergeReadiness, classifyAutomergePass, reviewedHeadShaBlockReason, buildAutomergeMergeArgs, automerge-shepherd.ts, verdict markers, or the router/review workflow concurrency."
---

# Verify the PR automerge gate

## The property

**ClawSweeper merges a PR only when the current ClawSweeper verdict for the exact merged commit is pass.**

Harm if broken: ClawSweeper lands a commit that no pass covered, or lands it while its own review says the commit needs changes.

The model checks the property as two TLA+ invariants in `formal/pr-automerge-gate/PrAutomergeGate.tla`:

| Invariant                 | Plain words                                                    | State at sync commit         |
| ------------------------- | -------------------------------------------------------------- | ---------------------------- |
| `MergedCommitWasReviewed` | The merged commit is the commit the pass verdict reviewed.     | Holds                        |
| `NoMergeOverFailVerdict`  | No merge while a fail verdict for that same commit is current. | **Breaks: known finding F1** |

`NeverMerged` is a sanity rule that must break. It proves a merge is reachable, so the rules do not pass vacuously.

## Does my change touch the verified code?

Run the check when the diff touches any of these. Coverage at the sync commit:

| File                                                                         | Functions / lines                                                                                                                                                       | Model action                                                                                    |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `src/repair/comment-router.ts`                                               | `executeAutomerge`, `validateAutomergeReadiness`, `classifyAutomergePass`, the `MERGE_INTENTS` branch of the action loop, `listCandidateComments`                       | `RouterTakesPass`, `RouterClearsMerge`, `RouterBlocks`, `RouterWaitTimesOut`, `RouterMergeCall` |
| `src/repair/comment-router-core.ts`                                          | `reviewedHeadShaBlockReason`, `buildAutomergeMergeArgs`, `automergeTransientWaitConfig`, trusted verdict parsing (pass/approved/no-changes, needs-changes, needs-human) | guard constants, `RouterTakesPass`                                                              |
| `src/repair/automerge-shepherd.ts`                                           | `automergeShepherdReadiness`, `hasTrustedPassForHead`                                                                                                                   | another entry into `RouterTakesPass` (the shepherd only dispatches the router)                  |
| `src/repair/execute-fix-artifact.ts`                                         | `waitForAutomergeAfterBranchRepair`, `continueAutomergeAfterNoopRepair`, repair push                                                                                    | `NewHeadPushed`, router dispatch                                                                |
| `src/clawsweeper.ts`                                                         | `clawsweeper-verdict:*` marker emission in `reviewAutomationMarkersFromReport`                                                                                          | `ReviewPublishes`                                                                               |
| `.github/workflows/repair-comment-router.yml`, `.github/workflows/sweep.yml` | `concurrency:` groups                                                                                                                                                   | router and review lane run independently                                                        |

**Sync commit:** `d598b09bba6458e3285ddc5889f7b97c56c0bc20` (origin/main, 2026-11-09).

To see whether covered code changed since then:

```sh
git diff --stat d598b09bba6458e3285ddc5889f7b97c56c0bc20 -- src/repair/comment-router.ts src/repair/comment-router-core.ts src/repair/automerge-shepherd.ts src/repair/execute-fix-artifact.ts src/clawsweeper.ts .github/workflows/repair-comment-router.yml .github/workflows/sweep.yml
```

Move the sync commit forward only after you have read the changed covered code and confirmed that each model action still describes it.

## Run the check

```sh
formal/pr-automerge-gate/check.sh            # builds dist/repair, then runs TLC (~10 s)
formal/pr-automerge-gate/check.sh --no-build --out .artifacts/pr-automerge-gate
```

Needs Node 24+, pnpm, Java 11+ (`JAVA` overrides), and TLC 1.7.4. The script downloads `tla2tools.jar` once to `~/.cache/clawsweeper-formal/` and checks its SHA-256. Set `TLA2TOOLS` to use another copy.

How it works:

1. `derive-guards.mjs` reads the guards from the real code: it calls `buildAutomergeMergeArgs` and `reviewedHeadShaBlockReason` from `dist/`, and probes the bodies of `classifyAutomergePass`, `validateAutomergeReadiness` and `executeAutomerge` in `src/repair/comment-router.ts`.
2. It writes the TLC config with `StaleHeadBlocks`, `MatchHeadOnMerge` and `RecheckVerdictBeforeMerge` set from that code.
3. TLC checks every order of review edits, pushes, check results and router steps for one PR with up to 2 head commits.
4. The script compares the broken invariants with `expected-violations.txt`.

| Exit | Meaning                                                                                                               |
| ---- | --------------------------------------------------------------------------------------------------------------------- |
| 0    | Only the known findings break.                                                                                        |
| 1    | `NEW VIOLATION`: the change removed a guard. `NOW HOLDS`: a finding is fixed. `SANITY FAILED`: no merge is reachable. |
| 2    | Tooling problem (checksum, TLC did not finish, unknown argument).                                                     |

## Read a result

Read every TLC result with the `/statechart` skill, using `formal/pr-automerge-gate/view.mjs` as the view and the generated config from `--out`. It gives the shortest bug path in plain words and the chart. `formal/pr-automerge-gate/chart.mmd` is the chart at the sync commit.

Real bug or modeling error? Replay the path against the real code, one step per model action. `formal/pr-automerge-gate/replay-f1.test.mjs` shows the pattern: it runs the real `dist/repair/comment-router.js` with a stub `gh` that rewrites the review comment at a chosen call. If the replay does not reproduce the path, assume the model is wrong until you show otherwise.

Do not weaken an invariant or remove a guard from the model to make the check pass. A new violation is a finding. Report it with its path; do not patch product code unless asked.

## Update the model when a change is intended

1. Find the model action whose comment names the changed function.
2. Change the action so that each indivisible step in the code is one step in the model.
3. If the change adds or removes a guard, update the probe in `derive-guards.mjs` so the constant follows the code.
4. Prove the check can still fail: make a scratch break in the real code (for example, delete the `--match-head-commit` push in `buildAutomergeMergeArgs`), confirm `check.sh` exits 1 with `NEW VIOLATION: MergedCommitWasReviewed`, then revert the break.
5. Edit `expected-violations.txt` only when a finding is fixed and the replay agrees.
6. Move the sync commit above.

For drift after changes that skipped this check, use `/maintain-formal-verification-skill`.

## Known finding F1 (open at the sync commit)

**Rule:** `NoMergeOverFailVerdict`. ClawSweeper must not merge while its current review of that commit says fail.

**Path (6 steps):** checks finish green → review posts pass for commit H → router picks up the pass → review posts fail (needs-changes) for the same H → router sees green checks on H → router merges H.

**Why:** the router takes `expected_head_sha` from the pass marker when it lists comments. `executeAutomerge` and `validateAutomergeReadiness` then re-read only the PR view (head, checks, labels, mergeability). Neither re-reads the review verdict. The review lane (`sweep.yml`) and the router (`repair-comment-router.yml`) use different concurrency groups, so a `/clawsweeper re-review` or scheduled re-review can edit the verdict during the router's transient wait (default up to 10 minutes). `--match-head-commit` does not help: the commit did not move.

**Replay:** `replay-f1.test.mjs` FLIP variant. The comment flips to needs-changes before the router's `executeAutomerge` PR view; the router still calls `gh pr merge 2 ... --match-head-commit H`.

**Model experiment:** with `RecheckVerdictBeforeMerge = TRUE` the rule still breaks: the review can flip between the readiness check and the merge call. Shrinking the window does not close it.

## What the model leaves out

- One PR, up to 2 head commits, verdicts reduced to pass / fail (fail = needs-changes or needs-human).
- One durable review comment per PR (the review lane edits it in place). Separate older pass comments are not modeled.
- Pause labels (`clawsweeper:human-review`, `clawsweeper:autofix`), `CLAWSWEEPER_ALLOW_MERGE`, changelog and `reviewDecision` blocks are not modeled; they only remove merges.
- The router may re-take a pass after it dropped one; the real ledger suppresses some processed comment versions. This adds behaviours; it removes none.
- Not covered: Pi review lifecycle (`pr-lifecycle*.ts`, `review-label-transition.ts`), job-level `merge-close-policy.ts` used by `apply-result.ts`, `review-verdict-policy.ts` (what makes a verdict pass), `promote-stuck-jobs.ts`, `requeue-job.ts`, close paths, Convex `events.status` / `statusSnapshots`, and maintainer `/clawsweeper approve` merges.
