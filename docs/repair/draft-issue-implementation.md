# Verified issue draft proposals

Read when changing issue implementation, repair authorization, target tokens, or worker workflows.

`draft_pr_only` is a separate opt-in policy. It does not weaken `review_only` or enable generic repair capabilities. Every shipped profile remains unchanged; none opts in.

## Admission

The existing issue implementation intake accepts an explicit `draft_only: true` request only after a completed strict review and successful reproduction verification. It reads the canonical report and verification audit from the trusted state checkout. It does not accept an issue-open/reopen event as verification. No event-to-verification bridge is included.

The target must have both `automation_policy: draft_pr_only` and `draft_issue_implementation: true`. This capability is limited to configured `valkyriweb` targets using the Valkyriweb credential route. The existing `CLAWSWEEPER_ALLOWED_OWNER` check still applies. Runtime execution also requires the separate `CLAWSWEEPER_ALLOW_DRAFT_ISSUE_IMPLEMENTATION=1` variable. Global execute/fix flags cannot grant this capability. These are code contracts, **not instructions to enable production**.

Intake produces the existing issue implementation job, with:

- exact `source: issue_implementation`, `job_intent: implement_issue`, and `trigger_source: review_reproducible_bug`;
- `draft_only: true`, `strict_bug_only: true`, and `reproduction_verified: true`;
- one source issue and its exact `clawsweeper/issue-<repo-slug>-<number>` branch;
- SHA-256 digests binding the canonical report and successful verification audit;
- only `fix` and `raise_pr` actions, with merge/close disabled and no required labels.

Job validation, dispatch, worker execution, token authorization, and the terminal executor check this contract. Missing or changed evidence fails closed. Evidence and job files are trusted operational state, not model output; the digests bind a snapshot, not a cryptographic attestation or a freshness guarantee. The editor must still reproduce on current main.

## Mutation boundary

| Surface | Draft lane |
|---|---|
| Generic repair, branch_push, pull_request | Denied |
| Scoped issue repair branch | Non-force push through the exact-job executor |
| PR creation | `gh pr create --draft`, followed by draft-state readback |
| Existing PR | Only an open draft on the same scoped branch; otherwise stop |
| Comments, labels, issue writes, close, merge, ready-for-review | Denied |
| Post-flight, automerge, requeue, engine dispatch token | Skipped |

The executor rechecks existing PR state before each push. A human can concurrently change a PR after a check; GitHub provides no atomic conditional branch-push/draft-state operation. This lane never calls a ready transition. It does not force-push resumed branches; a non-fast-forward update must stop for human handling.

The existing target-token facade authorizes the exact job **before** minting its write token. Intake and planning receive read-only target tokens. Draft publication receives only `contents: write`, `pull_requests: write`, and `issues: read`, scoped to one configured repository. GitHub does not offer draft-only or branch-only installation-token permissions; deterministic executor checks enforce those narrower boundaries. No actions, workflows, checks, administration, or issue-write scope is requested.

The draft write token stays out of ordinary subprocess environments. Only the validated branch push and draft PR creation receive it. Models and target validation receive no GitHub tokens. Worker state checkouts use read-only tokens without persisted credentials. State and package credentials remain on their existing Valkyriweb routes.

## Verification and operations

Deterministic tests cover default-off profiles, policy regressions, exact job/evidence/owner gating, token ordering and permissions, denied workflow steps, and mocked draft PR publication. They do not prove a live user outcome. No live issue, dispatch, worker, profile, App-permission, or owner-variable change is part of this implementation. ClawRouter #344 remains an agent-origin candidate, not external-arrival evidence.

No new controller, queue, daemon, watcher, or persistent local load is introduced. The lane reuses the current intake, state, worker, and executor. Tests/builds use the single allocated Forge slot. Installation cleanup is removal of this isolated worktree after landing; no global installation is required.

Captain owns machinery approval and merge. Profile opt-in, intake enablement, activation, and any App or owner changes require separate approval.
