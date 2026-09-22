# Native Pi technical review lifecycle

The existing comment router and repair worker own this loop. Technical labels are not authorization to repair, merge, deploy, or promote an image. The docs pilot requires repository profile `pi_review_lifecycle: true`, `repair_allowed_paths: ["docs/**/*.md"]`, and explicit PR label `clawsweeper:autofix`. `clawsweeper:automerge` alone does not authorize Pi repairs. Existing non-Pi workflows retain their own policy.

## Trusted intake

`repository_dispatch` action `clawsweeper_review_lifecycle` carries identity only: `target_repo`, numeric `item_number`, full lowercase `head_sha`, string `source_run_id`, numeric `source_run_attempt`, `phase` (`started` or `completed`), and string `comment_id` for completion.

The receiver fetches the source run and PR from GitHub. Mutation requires the `.github/workflows/pi-pr-review.yml` producer running as `pull_request_target`, in the target repository, against the current `main` base SHA. Untrusted `pull_request` producers are rejected even when they upload convincing artifacts. The source run head SHA is the **base** SHA, not the candidate SHA; empty run PR arrays are supported through immutable artifacts.

Run-owned artifact names are `pi-pr-review-lifecycle-started-<attempt>` and `pi-pr-review-lifecycle-completed-<attempt>`. Their `lifecycle.json` binds version 1, repository, PR, candidate SHA, run, attempt and phase. Completion additionally binds verdict and comment ID. Numeric artifact comment IDs are normalized; dispatch comment IDs must be strings.

Completion requires an immutable trusted-bot comment containing exactly one `pi-pr-review-lifecycle` JSON marker matching that identity and verdict (`pass`, `fail`, `incomplete`). The technical check must be `pi-pr-review/verdict`, from GitHub Actions, on the candidate SHA, with external ID `pi-pr-review:<run>:<attempt>` and details URL `https://github.com/<repo>/actions/runs/<run>/attempts/<attempt>`. Pass requires success; fail and incomplete require failure.

## State and classification

- Started → `agent:reviewing`.
- Pass → `agent:review-passed`; this does not imply acceptance or shipping.
- Authorized, safe, actionable failure → `agent:fix-requested`, then `agent:fixing` after dispatch through the existing worker.
- Incomplete, external failure, ambiguous/advisory failure, exhausted budget, unsafe scope, or human stop → `clawsweeper:human-review`.
- Successful repair push → `agent:review-requested`, preserving autofix authorization. The native producer reviews the new head.

Code checks scope, opt-in, human stop and repair caps before invoking a model. REST file records include previous paths for renames. Missing/malformed paths, unknown statuses and sensitive runtime/control surfaces fail closed. The pilot has a maximum of two repairs per PR, additionally constrained by existing per-head and global limits. No new retry controller is introduced.

Classification uses Jev `typesafe/jev-1.13.0` through `/v1/native/typesafe/v1/systemone`. Explicit unknown, invalid schema or request failure permits one fallback through `/v1/messages`, default model `clawrouter/claude-sonnet-5-200k`. Confidence is recorded but has no invented threshold. Evidence over 24,000 characters is rejected, not truncated. Requests have 15-second deadlines and 32-KiB response limits. Unresolved fallback requires human review. These are technical judgments only; a model cannot grant authorization or turn an explicit failed review into a pass.

The existing ledger records state, phase, source run/attempt, expected SHA, classifier source/model/outcome/confidence/attempts/diagnostics and reason. Accepted lifecycle entries waiting for a job commit are persisted. Duplicate delivery does not replace an executed receipt; completed events dominate delayed starts, and older runs/attempts cannot take ownership back.

## Final mutation and recovery

The router re-fetches head, open state, opt-in, human stop and file scope before dispatch. Dispatch supplies the expected SHA and PR number to the existing worker. The worker checks those before contributor edits and each push, and validates the actual committed diff against the docs allowlist before publishing. Both sides of renamed paths are checked; model-provided `likely_files` is not sufficient evidence of output scope.

Human escalation posts one deterministic PR/head/run/attempt notice identifying @valkyriweb, the reason and recovery instructions. Resolve the cause, explicitly retain or regrant autofix, and remove the human-stop label before requesting new review. Removing labels does not reset the pilot repair budget.

**Base drift:** merge current main into the PR branch and push without rewriting history, triggering a new native review event. Rerunning the old Actions event alone cannot refresh its immutable base metadata.

The scheduled router handles opted-in native lifecycle recovery separately from the general comment sweep. A repository may retain `skip_comment_router_schedule: true` while lifecycle-only reconciliation remains enabled. Cancellation, stalled runs and missing completion delivery never synthesize a positive verdict. Each tick also checks one page of 20 open PRs, advancing a cursor in the existing ledger, so missing first notifications and new heads after an old pass are discoverable. A waiting repair receipt re-enters authoritative completion validation after job publication; a dispatched repair is left alone until a new review or the stall timeout. See `pr-lifecycle-reconcile.ts` for the recovery policy.

## Production preflight and improvement

Before enabling a producer, run `repair-comment-router.yml` on the candidate ref with `target_repo=valkyriweb/openclaw-claude`, `lifecycle_only=true`, and `execute=false`. This bounded, read-only probe uses the **actual Actions secret and runner**. It requires an actionable Jev result; a working fallback alone does not prove Jev access. Its dedicated contents-read job cannot enter the router's token-creation or ledger-publication steps. It neither repairs nor merges a PR.

Use the existing ledger and linked Actions runs to review repair success, escalation reasons, fallback frequency, attempts per outcome and elapsed time. Join provider usage records by the recorded model/run evidence when measuring cost; the ledger does not invent monetary estimates. Recurring failures should produce small tested changes to the existing owner, not another controller. Authorization and ship policy changes still require human approval. A technical pass, a merge, a deployment and production verification remain separate outcomes.

## Local verification

```sh
pnpm run build:repair
node --test test/repair/pr-lifecycle*.test.ts \
  test/repair/repair-publish-guard.test.ts \
  test/repair/review-label-transition.test.ts \
  test/repair/comment-router-utils.test.ts \
  test/repair/execute-fix-validation.test.ts \
  test/repair/execute-fix-artifact-source.test.ts
```

On 2026-09-22 this focused run passed 54 tests. It includes real router subprocesses with deterministic GitHub/model fixtures, ledger roundtrips, and the worker publication guard against real Git commits. It does not substitute for production App permissions, live Jev entitlement, an end-to-end hosted repair, or independent review. Those remain integration/pilot gates owned by the operator.
