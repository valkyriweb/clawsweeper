# ClawSweeper PR webhook Worker

Receives `pull_request` webhooks for the `valkyriweb-clawsweeper` GitHub App
(id 3711554) and starts `pr-review-check.yml` for opted-in repositories.
`pr-review-poll.yml` runs hourly as the fallback.

- Endpoint: `POST /github/webhook` on `clawsweeper-pr-webhook` (workers.dev,
  Bermont Cloudflare account).
- Verifies `X-Hub-Signature-256` with `GITHUB_WEBHOOK_SECRET` (constant-time).
- Dispatches only `opened`, `synchronize`, `reopened`, `ready_for_review` on
  non-draft PRs whose repository has `pr_review_check: true` and
  `github_app_credential_route: "valkyriweb"`. Everything else gets `202`.
- Mints an installation token for `valkyriweb/clawsweeper` only, with
  `{ actions: write }` only, and calls `workflow_dispatch` with `target_repo`
  and `pr_number`. The engine re-reads the head SHA and re-checks opt-in.
- Returns `502` if GitHub refuses, so the delivery shows as failed and can be
  redelivered. Payloads, tokens and secrets are never logged.

## Opt-in list

`config/target-repositories.json` is the only source. The Worker bundles it at
deploy time, so after changing `pr_review_check` on a target, redeploy:

```sh
pnpm dlx wrangler@4.90.0 deploy --config dashboard/pr-webhook/wrangler.toml
```

Until the redeploy, the hourly poll covers newly opted-in repositories, and the
engine rejects repositories that have opted out.

## Secrets

```sh
agent-op-env exec -- op document get nkputrdq5tqzvhpzaxcyjf35d4 --vault 6764nqkhfjgo54iev2l5n333xe \
  | pnpm dlx wrangler@4.90.0 secret put GITHUB_APP_PRIVATE_KEY --config dashboard/pr-webhook/wrangler.toml
agent-op-env exec -- op read "op://Personal Agent Secrets/ClawSweeper PR webhook secret/password" \
  | pnpm dlx wrangler@4.90.0 secret put GITHUB_WEBHOOK_SECRET --config dashboard/pr-webhook/wrangler.toml
```

The webhook secret must equal the one set on the GitHub App's webhook settings.
