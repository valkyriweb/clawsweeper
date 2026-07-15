# ClawSweeper GitHub App ownership boundary

Read before installing, transferring, rotating, or retiring a ClawSweeper
GitHub App.

## Decision — 2026-07-15

**Do not transfer `bermont-clawsweeper`.** Ownership transfer was rejected after
inventory showed that the App is owned by `valkyriweb`, installed across all
141 personal repositories, and still has active personal consumers. A transfer
would couple the business boundary to personal automation and could remove or
invalidate the existing installation.

The durable architecture uses isolated Apps:

| Scope | App owner | App | Credential |
|---|---|---|---|
| `valkyriweb/*` | `valkyriweb` | `valkyriweb-clawsweeper` | dedicated Personal-vault item and App-specific repository secret |
| `bermont-digital/*` | `bermont-digital` | a new business-owned App, preferably `bermont-digital-clawsweeper` | separate Bermont Digital-vault item and App-specific repository secret |

The shared engine remains `valkyriweb/clawsweeper`. App ownership controls the
target repository boundary; engine target profiles control behavior.

## Non-negotiable boundaries

- Never reuse one private-key secret with two App client IDs.
- Never rotate a generic repository secret during an App identity cutover.
- Pre-stage a new App-specific secret, merge the reviewed dispatcher, prove the
  target run and engine run, then consider legacy cleanup.
- App ownership must match the target owner. Do not install a personal App on
  Bermont repositories or a business App across personal repositories.
- Missing or unknown engine target policy fails closed.
- SaleSight and Smilerite stay `review_only`: no repair, push, PR lifecycle,
  merge/automerge, close, or lifecycle-label mutation.
- One production target at a time with a verified rollback checkpoint.

## Rejected App baseline

`bermont-clawsweeper` at the decision point:

- App ID: `3750062`
- owner: `valkyriweb`
- installation ID: `133263271`
- installed account: `valkyriweb`
- repository selection: `all` (141 repositories)
- credential item: `GitHub App — bermont-clawsweeper` in the Bermont Digital
  1Password vault

The old App and generic keys remain rollback assets until inventory proves zero
active consumers. Do not transfer, rotate, uninstall, or revoke them before
that proof.

## Personal-consumer migration

For each active `valkyriweb/*` consumer:

1. Rename the target workflow to
   `.github/workflows/clawsweeper-dispatch.yml`.
2. Use the `valkyriweb-clawsweeper` client ID.
3. Reference `VALKYRIWEB_CLAWSWEEPER_APP_PRIVATE_KEY`, sourced from the Personal
   1Password item for that App.
4. Preserve target runner labels, event payloads, engine destination, and
   fail-inert behavior.
5. Restrict issue-comment commands to repository-trusted actors; organization
   membership alone is not write permission.
6. Pre-stage the dedicated secret while preserving the generic Bermont key.
7. Merge one consumer, then prove:
   - target `ClawSweeper Dispatch` succeeds;
   - the exact target/item reaches a successful engine run;
   - no forbidden mutation occurs;
   - any workflow still using the generic Bermont key remains healthy.
8. Roll back the workflow/client ID with the retained old key if either side
   fails.

Historical/non-root workflow copies are not active consumers, but operative
runbooks and templates must not instruct future operators to recreate the old
cross-owner setup.

## Create the Bermont-owned App

Create a new private GitHub App under `bermont-digital`; do not repurpose or
transfer App ID `3750062`.

1. Capture the intended name, owner, callback/webhook settings, permissions, and
   selected-repository installation policy before creation.
2. Grant only permissions required by the review-only dispatcher and engine.
3. Store its client ID, App ID, private key, and installation IDs in a new
   Bermont Digital 1Password item. Never copy credential values into a repo,
   ticket, log, or command output.
4. Install it with **Only select repositories** and select SaleSight first.
5. Use a business-App-specific repository secret name; do not overwrite
   `CLAWSWEEPER_APP_PRIVATE_KEY` or the Valkyriweb secret.
6. Verify the installation API resolves only the intended repository before
   activating a dispatcher.

Stop if GitHub proposes changing an existing installation, regenerating another
App's credentials, or transferring ownership.

## Bermont canary order

### SaleSight

1. Confirm `bermont-digital/sale-sight-plugin` has an explicit `review_only`
   engine profile.
2. Add the neutral dispatcher through a reviewed PR using the new Bermont App
   client ID and dedicated secret.
3. Install/select SaleSight only and pre-stage its secret.
4. Trigger one harmless exact-item canary.
5. Require successful target and engine runs plus evidence that repair, push,
   PR lifecycle, merge, close, and lifecycle-label paths stayed blocked.

### Smilerite

Only after SaleSight passes:

1. Add the dispatcher through a reviewed PR. Remember every Smilerite `main`
   merge deploys production.
2. Add Smilerite to the selected-repository installation and set its dedicated
   secret.
3. Run the same exact-item `review_only` canary and inspect production health.

Never activate both targets in one step.

## Retirement gate for `bermont-clawsweeper`

Retire the old App only after all of the following are evidenced from current
default branches and live repository settings:

- zero root workflow consumers of its client ID;
- zero workflows requiring its private key, including non-ClawSweeper jobs;
- zero repository secrets retained solely for rollback;
- replacement dispatchers and engine canaries are healthy;
- operative docs/templates contain no old onboarding commands.

Then remove installations/secrets one repository at a time, re-inventory after
each change, and only finally revoke/delete the old App. Any ambiguous consumer
blocks retirement.
