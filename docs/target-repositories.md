# Target Repositories

Read when enabling ClawSweeper for another OpenClaw repository, changing
`config/target-repositories.json`, or debugging `Unsupported target repo`
failures.

ClawSweeper has two target-repository paths:

- configured dashboard targets in `config/target-repositories.json`
- a conservative generic fallback for exact event/manual reviews of
  `openclaw/*` repositories

Every configured target and the fallback must declare both `automation_policy` and
`github_app_credential_route` (`valkyriweb` or `bermont-digital`). The loader rejects a
missing or unknown route before any target token can be minted. Routes are never inferred
from the repository owner.

- `full` allows configured repair, branch/PR lifecycle, merge, and close actions.
- `review_only` allows reviews, proposal comments, artifacts, and state reports,
  but denies repair jobs, branch pushes, PR creation or reopening, merges,
  automerge, and issue/PR closure.

The loader rejects missing or unknown policy values. Mutation executors also
resolve the policy independently and fail closed for missing or unsupported
targets, so prompts and workflow inputs cannot grant automation.

A target may set `post_repair_review_label` to hand a successfully pushed repair
back to its native review lane. The branch push itself triggers the target's
review workflow; the label records lane ownership and need not emit a separate
event. After the push, ClawSweeper adds and verifies that configured review
label before removing `clawsweeper:autofix`.
Metadata failures are reported without turning an already-pushed repair into a
replacement PR; the autofix label is retained whenever the review handoff could
not be verified. The field is optional; targets without it retain the normal
ClawSweeper review loop.

A target may set `issue_triage_intake` to `true` (boolean, default off) so new or
reopened issues start the existing exact-item review. The intake workflow admits
only `issues.opened` and `issues.reopened` for an open issue, then carries the
normalized `activity.idempotencyKey` to the existing `clawsweeper_repair_item` receiver.
A bounded `updated_at` or `delivery_id` is required for intake serialization. The
normalized key also uses a stable source key when supplied; without a stable seed,
intake fails closed.
The sweep run name stores a SHA-256 receipt derived from that key. The existing
`sweep.yml` Actions run history owns replay detection: intake reads all API-visible
workflow-run pages without status/event filters, verifies each advertised `total_count`,
and retries one inconsistent scan before failing closed. Active runs and successful or
neutral completions suppress a duplicate. Failed, cancelled, timed-out, or skipped
runs can be retried with the same event identity. GitHub documents a 1,000-result cap
for filtered workflow-run searches (including filters such as `event`, `status`, and
`created`); this request omits those filters. Run retention, deletion, and API visibility
can still remove receipts, so this is best-effort replay detection, not cross-process
fencing or a second store.

Intake serialization uses repository, issue number, action, and the raw stable seed
that feeds the normalized idempotency key. If the sender omits that key, `updated_at`
or `delivery_id` provides the bounded seed. The sender must include the issue number
and one of these fields; intake fails closed without them. Duplicate deliveries share
a group, while a distinct reopen event gets a new group. The shared per-item
`sweep.yml` group no longer cancels a running review for any exact-item
`repository_dispatch`, including authorized repair dispatches. GitHub still keeps one
pending run per group, so a newer pending downstream event can replace an older one.

The flag is separate from `automation_policy` and does not make downstream work
read-only. `sweep.yml` publishes event results, routes authorized commands, and may
apply eligible closes. `review_only` blocks repair, close, merge, and label mutations;
`full` remains subject to per-target close rules and action gates. Issue text cannot
set the intake flag or widen those gates. Before dispatch, the workflow reads the live
issue and skips closed, locked, pull-request, or held items. A held item resumes only
through the existing explicit command path in the comment router. No shipped profile
enables intake; use the safe-ramp checks before enabling any target.

A target may set `skip_comment_router_schedule` to `true` to stay on the
allowlist while scheduled comment-router fan-out skips it. The workflow
jq already honors that flag. Use it when App token mint for one repo
poisons the rest of the schedule. Manual `workflow_dispatch` and
`repository_dispatch` for that repo still run. Restore the flag after
the App install on that target is healthy.

`openclaw/openclaw` remains a built-in profile because it has broader
auto-close policy. Other configured targets default to safer repo-local rules:
issues are review/comment-only, and PRs may auto-close only when the same
change is certainly already implemented on `main`.

## Generic OpenClaw Fallback

The fallback lets a newly installed OpenClaw repo dispatch to ClawSweeper
without a TypeScript change. It is intentionally narrow:

- owner must be `openclaw`
- repo name must match `allow_repo_name_pattern`
- denied repositories are rejected
- issues cannot be auto-closed
- PRs can auto-close only for `implemented_on_main` or age-gated
  `mostly_implemented_on_main`
- scheduled dashboard/backfill rows are not added automatically

This is enough for event-driven review after the target repo has the dispatcher
workflow and GitHub App installation. It is not a blanket scheduled rollout.

## Add One Repository

1. Add an explicit profile including `github_app_credential_route`.
2. Keep the corresponding App credential only in this engine repository. Never add an
   engine private key to a target repository.
3. Use a manual `workflow_dispatch` exact-item canary from this engine, then confirm the
   target item receives one durable review comment.
4. For `bermont-digital/*`, keep target dispatchers and `repository_dispatch` disabled;
   run SaleSight first and Smilerite second from the shared private engine.

For a repo that should appear in the README dashboard or scheduled queues, add
it to `config/target-repositories.json` with an explicit prompt note,
`automation_policy`, and close-policy block. Start production targets at
`review_only`; promote to `full` only after the mutation paths and credentials
have a documented, tested rollout. `apply_close_rules` narrows ordinary close
reasons under `full`; it never overrides `review_only`.

## Add Many Repositories

Batch rollout should be incremental:

- configure the App only in the engine and add one route-explicit profile at a time
- leave schedules and target dispatchers off
- verify a manual exact-item review/comment canary on one issue or PR per repo
- add config entries for repos that should show in the dashboard
- enable scheduled backfill/apply only after repo-specific safety rules exist

If a target dispatch reaches ClawSweeper but receiver token creation fails, the
App is usually not installed on that target repo. If the target workflow skips
before dispatch, the target repo usually cannot access
`CLAWSWEEPER_APP_PRIVATE_KEY`.

## Review provider

ClawSweeper supports four review providers. The active provider is resolved
per run by `resolveReviewProvider()` (see `src/clawsweeper.ts`) with this
precedence:

1. `profile.review_provider` (per-target override in
   `config/target-repositories.json`)
2. `vars.CLAWSWEEPER_REVIEW_PROVIDER` (repo variable, fleet-wide default)
3. compiled fallback (`codex`)

| id | how it talks to the model | runner prereqs |
|---|---|---|
| `codex` | spawns the OpenAI Codex CLI (`codex exec --output-schema ...`) | `setup-codex` action; ChatGPT subscription JWT at `~/.codex/auth.json` |
| `claude-bridge` | curl POST to `pi-claude-bridge` (`127.0.0.1:9100`) | bridge running on the runner |
| `claude-code` | spawns Anthropic's Claude Code CLI (`claude -p --output-format json --json-schema ...`) | `setup-claude-code` action; `~/.claude/credentials.json` or macOS keychain entry on self-hosted |
| `pi` | spawns the pi-mono-fork coding-agent CLI (`pi -p --mode json --no-session`) | `setup-pi` action; pi binary on PATH; `~/.pi/` initialised |

The `claude-code` and `pi` providers were added alongside the existing two to
enable per-item provider routing (latency / cost). All providers share the
same `Decision` schema (`schema/clawsweeper-decision.schema.json`), so
downstream observability and telemetry do not have to branch on which one ran.

Pi has no `--json-schema` enforcement — the schema is inlined in the prompt
and the response is post-validated with the same Zod parser the other
providers use. Expect a higher `schema_invalid` rate than codex / claude-code,
so reach for `pi` on items where speed matters more than strict structure.
