# Bermont App engine-pull runbook

> Supersedes the former target-dispatcher/credential-transfer rollout.

## Operating model

`bermont-clawsweeper` is installed only where it can mint narrowly scoped tokens
for `bermont-digital/*`, while its client ID and private key remain **only** in
`valkyriweb/clawsweeper` Actions configuration:

- `BERMONT_DIGITAL_CLAWSWEEPER_APP_CLIENT_ID`
- `BERMONT_DIGITAL_CLAWSWEEPER_APP_PRIVATE_KEY`

The profile field `github_app_credential_route: "bermont-digital"` selects the
static Bermont adapter in `.github/actions/create-target-token`. It never falls
back to the Valkyriweb App. Missing selected credentials fail during token mint.

Do **not** install the Bermont App on `valkyriweb/*`. Do **not** add either
Bermont credential to SaleSight, Smilerite, Multica, or any other target repo.
Do **not** add a target dispatcher or enable `repository_dispatch`.

## Manual canary order

1. Keep `bermont-digital/multica` on its verified existing `full` policy; only
   its credential route changes to `bermont-digital`.
2. Run one exact-item manual SaleSight review from the shared engine. It is
   `review_only`: the facade permits read/comment tokens and rejects mutate
   token requests before minting.
3. Observe the review/comment result.
4. Run one exact-item manual Smilerite review under the same policy.

Never run both production canaries together. Smilerite production deployment
means any finding or mutation decision remains human-owned.

## Rollback

Disable the manual run or remove the Bermont target from the App installation.
Do not migrate credentials to a target repository and do not add a fallback App
credential. Keep the target profile route explicit so an accidental run fails
closed instead of minting from the wrong authority.
