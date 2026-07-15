# Target dispatchers — superseded for engine-pull

The shared `valkyriweb/clawsweeper` engine is **manual-only**. Its `sweep.yml`
accepts `workflow_dispatch` only: `repository_dispatch` receivers and scheduled
target sweeps are disabled.

Do not add or generate a target-side ClawSweeper dispatcher for
`bermont-digital/*`. In particular, SaleSight and Smilerite must not contain a
Valkyriweb credential or a Bermont App private key. Their canaries run manually
from the shared private engine after the `bermont-digital` profile route mints a
scoped target token.

Personal/Valkyriweb dispatcher material may be retained only as historical
reference for a separately enabled deployment. It is not compatible with this
engine-pull configuration and must not be used to enable Bermont target dispatch
or transfer a credential to a business repository.

For target onboarding, use [target-repositories.md](target-repositories.md): add
an explicit `github_app_credential_route`, preserve `review_only` for production
canaries, and perform one manual exact-item review at a time.
