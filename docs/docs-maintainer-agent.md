# Docs Maintainer Agent

## Status

Draft design. Source of truth lives in ClawSweeper as a reusable GitHub maintenance lane. Core Wholesale should be the first adopter via target-repository config, not a bespoke implementation.

## Goal

Keep configured repository documentation current with pull-request changes by running an autonomous docs-maintenance agent that can update docs directly when safe, then leave a concise audit comment only when it made changes.

This is a docs-maintenance lane, not a general writing-polish bot.

## Non-goals for v1

- No scheduled/default-branch sweeps. Add weekly drift sweeps after PR behavior is trusted.
- No semantic search or vector/RAG dependency.
- No merge authority.
- No broad, unconfigured doc rewrites.
- No security-sensitive issue/PR handling outside the existing ClawSweeper security boundary.

## Prior art notes

- Dosu's Claude Code docs-drift pattern feeds PR metadata, code diff, docs, and a docs map into the agent; it uses bot-loop skips, skip labels, max-turn limits, concurrency, and prompt-injection delimiters. It does not require semantic search.
- GitHub Copilot coding agent runs in an ephemeral Actions-backed environment, creates branch/PR work with visible logs, and expects human oversight.
- GitHub Agentic Workflows points toward repository-maintenance agents as Actions-like primitives with sandboxing, safe outputs, validation, and human-in-the-loop review.

References:

- https://dosu.dev/blog/how-to-catch-documentation-drift-claude-code-github-actions
- https://docs.github.com/copilot/concepts/agents/coding-agent/about-coding-agent
- https://github.blog/changelog/2026-06-11-github-agentic-workflows-is-now-in-public-preview/

## v1 behavior

### Trigger

Run on pull-request events for configured target repositories.

The precheck must run before any expensive model call. It decides whether the docs maintainer should run from:

- PR title/body/labels/author association.
- Changed files and diff stats.
- Code/config/deploy/API/env/docs path patterns.
- Target repository docs-maintainer config.
- A docs map that links code areas to owned documentation.

Skip silently when the precheck says docs maintenance is irrelevant.

### Inputs to the agent

- PR metadata: number, title, body, author, labels, base/head refs.
- Diff: changed file list plus relevant hunks.
- Existing configured docs.
- Docs map.
- Repository instructions relevant to docs maintenance.
- Explicit untrusted-input delimiters for PR body, comments, and patch text.

### Docs ownership config

Each target repository can define docs-maintainer config. Provide sensible defaults so adoption is cheap.

Suggested shape:

```json
{
  "docsMaintainer": {
    "enabled": true,
    "ownedDocs": [
      "README.md",
      "docs/**/*.md",
      ".env.example"
    ],
    "docsMap": [
      {
        "code": ["src/api/**", "app/Http/Controllers/**", "routes/**"],
        "docs": ["docs/api.md", "README.md"]
      },
      {
        "code": ["config/**", ".github/workflows/**", "docker/**"],
        "docs": ["docs/deployment.md", ".env.example"]
      }
    ],
    "skipLabels": ["skip-docs-check", "docs-not-needed"],
    "maxTurns": 15,
    "mode": "autofix"
  }
}
```

Defaults should include common docs and config surfaces, but target repos can narrow the owned docs list to reduce noise.

### Editing policy

The agent may improve docs, but only inside configured owned docs and only when the PR creates a plausible docs obligation.

Allowed:

- Update stale setup, env, command, deployment, API, routing, config, integration, and operational docs.
- Add missing docs for newly introduced externally visible behavior.
- Improve nearby structure/wording when doing so makes the docs easier to use.

Disallowed:

- Drive-by rewrites unrelated to the PR.
- Product/roadmap claims not evidenced by the PR or docs map.
- ADR edits unless explicitly configured for that repo.
- Secret values, private tokens, customer data, or exploit details.
- Public-facing messaging changes unless that doc is explicitly owned.

### Mutation policy

Permission-aware autofix:

1. If the PR head branch is in an allowed same-org repository and branch protection permits it, push docs commits to the PR branch.
2. If direct push is unsafe or unavailable, open a companion docs PR against the same base branch.
3. If neither mutation path is allowed, post a patch comment only when the docs obligation is high confidence.

Never merge. Never approve its own work. Never bypass maintainer review.

### PR UX

- If no docs work is needed: no comment.
- If docs were changed: leave one concise comment with:
  - docs files changed;
  - why they changed;
  - whether it pushed to the PR branch or opened a companion PR;
  - anything intentionally skipped.
- If blocked from mutating: leave a concise patch/comment only when high confidence.

### Loop and safety controls

- Skip bot-authored PRs from ClawSweeper/docs-maintainer/GitHub Actions unless explicitly commanded.
- Respect skip labels.
- One in-flight docs-maintainer run per PR.
- Max model turns and timeout per run.
- Deterministic code owns auth, repo allowlists, push/PR/comment mutations, worker caps, and final status.
- Model output must be applied through safe patch/commit code, not arbitrary shell mutation.
- Route security-sensitive items through the existing ClawSweeper security boundary.

## ClawSweeper integration shape

Add a new job intent:

- `docs_maintenance`

Worker lane:

- `docs_maintenance` with its own capacity cap and cost budget.

Suggested stages:

1. `docs-maintainer:precheck`
   - Fetch PR metadata/diff.
   - Load target docs-maintainer config.
   - Decide skip/run and identify candidate docs.
2. `docs-maintainer:create-job`
   - Write a durable job with PR metadata, candidate docs, docs map, and mutation mode.
3. `docs-maintainer:worker`
   - Run the agent in a bounded workspace.
   - Produce a patch and summary.
4. `docs-maintainer:apply`
   - Deterministically apply allowed docs changes.
   - Push branch / open companion PR / post patch comment.
5. `docs-maintainer:publish`
   - Post concise summary only if changes or high-confidence blockage occurred.
   - Write ledger state for dashboard/audit.

## Core Wholesale first-adopter config

Core Wholesale should enable this after the generic lane exists.

Initial docs surfaces:

- `README.md`
- `CHANGELOG.md` if the repo uses it for notable behavior changes
- `docs/**/*.md`
- `.env.example`
- `NextJS-Frontend/AGENTS.md` and frontend docs only for frontend-specific changes
- deployment notes should point to the infra source of truth in `bermont-kube`, not duplicate cluster manifests

Initial code-to-docs map should cover:

- Next.js frontend app/routes/components -> frontend docs and README usage notes
- WordPress/Woo API endpoints -> API/setup docs
- OpenClaw/Cory config references -> OpenClaw docs/runbooks
- Docker/CI/env/config changes -> setup/deployment/env docs
- IQ Retail/Core AI integration docs once those surfaces exist

## Acceptance criteria

- A PR that changes only tests with no docs obligation is skipped silently.
- A PR that adds an env var updates `.env.example` and the relevant setup docs.
- A PR that changes an API route updates the mapped API docs.
- A bot-authored docs-maintainer PR does not recursively trigger more docs-maintainer work.
- A forked or unpushable PR gets a companion PR or patch comment instead of a failed push.
- The agent leaves no comment when it does no work.
- Every mutation is attributable in logs and durable ClawSweeper state.

## Later phases

- Weekly scheduled docs-drift sweeps on default branch.
- Manual trigger via label/comment.
- Dashboard panel for docs-maintainer activity and skipped/prechecked PRs.
- Optional stronger checks for exported API/schema changes.
- Optional semantic search/RAG only if diff+docs-map misses real drift in practice.
