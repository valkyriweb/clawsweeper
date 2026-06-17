# Plan 007: Deflake the `runCodex` total-timeout test under parallel-build load

> **Executor instructions**: This is a surgical test-deflake plan. Preserve the behavior being asserted: once Codex emits initial output, the startup watchdog must be cancelled and the total timeout must be the timeout that fires. Do not weaken the test into "any timeout eventually happens."

## Status

- **Priority**: follow-up from CI flake
- **Effort**: S
- **Risk**: LOW (test-only)
- **Depends on**: none
- **Category**: test reliability
- **Planned at**: 2026-06-16 after intermittent `pnpm check` failure

## Why this matters

The test `runCodex allows a silent in-progress turn until the total timeout` uses a fake Codex process that prints `thread.started` and then stays silent. Under load, the child process can take long enough to start that the startup watchdog fires before the first output arrives. That makes the test flaky even though production behavior is correct.

The test must still prove the important invariant:

1. initial output is observed;
2. observing output cancels the startup watchdog;
3. a silent-but-started Codex run is killed by the **total** timeout, not the startup watchdog.

## Scope

**In scope**:
- `test/clawsweeper.test.ts` only.

**Out of scope**:
- Production watchdog logic in `src/clawsweeper.ts`.
- Provider behavior, timeout defaults, or CLI flags.

## Implementation

- Increase the startup timeout enough to cover slow process spawn on small/loaded CI runners.
- Increase the total timeout as needed, but keep `startup timeout < total timeout` so a regression in startup-watchdog cancellation would still fail the test before the total timeout fires.
- Update the stderr assertion to match the new total timeout.
- Keep the negative assertion that stderr does **not** contain `codex startup timeout`.

## Verification

| Command | Expected |
|---------|----------|
| `pnpm run build` | exit 0 |
| `node --test --test-name-pattern "runCodex allows a silent in-progress turn until the total timeout" test/clawsweeper.test.ts` | exactly that test passes |
| `pnpm check` | exit 0 |

## Done criteria

- [ ] The focused test passes repeatedly under local load.
- [ ] CI `pnpm check` passes.
- [ ] The test still fails if initial output no longer cancels the startup watchdog (startup timeout remains lower than total timeout).
