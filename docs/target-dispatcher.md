# Target dispatchers — superseded for engine-pull

The shared `valkyriweb/clawsweeper` engine keeps broad intake manual-only.
Scheduled target sweeps and the broad `clawsweeper_item` event remain disabled.
Its repository-dispatch receiver accepts only `clawsweeper_repair_item`. Explicit
autofix/repair routes and profile-gated issue triage may emit this exact-item event;
the intake flag does not bypass the receiver's normal `automation_policy` gates.

Do not add or generate a target-side ClawSweeper dispatcher for
`bermont-digital/*`. In particular, SaleSight and Smilerite must not contain a
Valkyriweb credential or a Bermont App private key. Their canaries run manually
from the shared private engine after the `bermont-digital` profile route mints a
scoped target token.

Personal/Valkyriweb targets may use a narrow dispatcher for the authorized
`clawsweeper_repair_item` contract. That exception is not compatible with
Bermont target dispatch and must not be used to transfer a credential to a
business repository.

For target onboarding, use [target-repositories.md](target-repositories.md): add
an explicit `github_app_credential_route`, preserve `review_only` for production
canaries, and perform one manual exact-item review at a time.
