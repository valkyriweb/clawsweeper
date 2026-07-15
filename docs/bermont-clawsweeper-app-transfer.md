# Bermont ClawSweeper App ownership transfer

Read before transferring or installing the `bermont-clawsweeper` GitHub App.

## Why this is needed

The App intended for Bermont repositories is currently owned by the personal
`valkyriweb` account. GitHub therefore cannot install it on
`bermont-digital/*`. Transfer ownership to `bermont-digital`; do not make the
App public.

## Pre-transfer baseline — 2026-07-15

App identity:

- name/slug: `bermont-clawsweeper`
- App ID: `3750062`
- owner: `valkyriweb`
- App URL: <https://github.com/apps/bermont-clawsweeper>
- installation count: `1`
- installation ID: `133263271`
- installed account: `valkyriweb` (`User`)
- repository selection: `all`
- repositories visible to the installation token: `141`

Permissions:

- Actions: read
- Checks: write
- Contents: write
- Issues: write
- Metadata: read
- Pull requests: write

The current installation can potentially affect all 141 `valkyriweb`
repositories. Code search found these active root dispatcher consumers using
the Bermont App client ID:

- `valkyriweb/openclaw-claude/.github/workflows/bermont-clawsweeper-dispatch.yml`
- `valkyriweb/lue-kube/.github/workflows/bermont-clawsweeper-dispatch.yml`
- `valkyriweb/horizon-whatsapp/.github/workflows/bermont-clawsweeper-dispatch.yml`

Additional copies exist below non-root workflow/reference directories in
`valkyriweb/horizon` and `valkyriweb/openclaw`; GitHub does not execute those as
root repository workflows. `bermont-digital/sale-sight-plugin` already carries
the dispatcher but has no App installation or private-key secret.
`bermont-digital/smilerite` has neither yet.

Credentials are stored in the Bermont Digital 1Password vault item
`GitHub App — bermont-clawsweeper`. Never copy credential values into this
repository or a transfer ticket.

## Transfer procedure

1. Capture screenshots of the App's permissions and current installation page.
2. Open <https://github.com/settings/apps/bermont-clawsweeper>.
3. Under **Advanced → Transfer ownership**, choose `bermont-digital`.
4. Do not change permissions, rotate credentials, make the App public, or alter
   the existing `valkyriweb` installation during the transfer.
5. Stop if GitHub says the existing installation will be removed or if it asks
   to regenerate credentials.

## Immediate post-transfer checks

Before adding any Bermont target:

- App ID remains `3750062`.
- slug remains `bermont-clawsweeper`.
- owner is now `bermont-digital`.
- App permissions exactly match the baseline above.
- existing installation `133263271` still exists on `valkyriweb` with selection
  `all` and still reports 141 repositories.
- the three active `valkyriweb` dispatch workflows above can still mint tokens
  and dispatch successfully.
- the 1Password private key still authenticates as the same App.

If the existing installation changes or disappears, stop. Restore/repair the
`valkyriweb` installation before onboarding Bermont targets.

## Staged Bermont rollout

1. Install the transferred App on `bermont-digital` with **Only select
   repositories → `sale-sight-plugin`**.
2. Verify the installation API resolves only SaleSight.
3. Add `CLAWSWEEPER_APP_PRIVATE_KEY` to SaleSight from 1Password without printing
   or writing it to disk.
4. Trigger one exact-item review canary. Confirm review output appears and the
   `review_only` engine policy blocks repair, push, PR lifecycle, merge, close,
   and lifecycle-label mutations.
5. Observe one clean event cycle before changing Smilerite.
6. Add the SaleSight dispatcher to Smilerite through a reviewed PR, install the
   App for Smilerite, add its secret, and repeat the review-only canary.

Never activate both production targets in the same step. Smilerite deploys every
`main` merge, so its rollout starts only after SaleSight proves the transferred
App and review-only policy end to end.

## Rollback

- Remove the newly added Bermont repository from the App installation.
- Delete `CLAWSWEEPER_APP_PRIVATE_KEY` from that target repository.
- Leave the dispatcher checked in; without the secret it fails inert and does
  not fall back to a maintainer token.
- Do not rotate or revoke the App key unless compromise is suspected; doing so
  would break all existing consumers at once.
