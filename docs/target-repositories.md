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
