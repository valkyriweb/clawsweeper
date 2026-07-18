# Commit-review provider canary runbook

How to flip the **commit-review** lane from codex to an alternate provider
(`pi` / `claude-code`) via the model registry, validate it on a live commit,
and revert — with zero deploy. This is the operational half of program #181
(spec `plans/009-commit-review-provider-switch.md`).

The switch is registry-driven: a single `CLAWSWEEPER_MODELS` repo variable on
`valkyriweb/clawsweeper` holds an action-keyed override map. commit-review
resolves `registry → codex default`; it does **not** read
`CLAWSWEEPER_REVIEW_PROVIDER` (that variable is the sweep-review pi lock).

> **Balance note.** The steady-state balance keeps commit-review on
> `codex / gpt-5.6-terra`. A pi/opus canary temporarily consumes opus quota and
> deviates from that balance — run it in a low-traffic window and revert
> promptly. Use `--model claude-sonnet-4-6` instead of opus if cost-sensitive.

All commands run from the `clawsweeper/` checkout with `gh` authenticated
against `valkyriweb/clawsweeper`. `models set` / `models get` default to
`--repo valkyriweb/clawsweeper`.

## 1. Precheck — capture the current state

```bash
# Full current registry (all actions) — save for the revert diff.
gh variable get CLAWSWEEPER_MODELS --repo valkyriweb/clawsweeper > /tmp/cw-models.before.json || echo "(unset)"

# Resolved commit-review config today (expect provider=codex, model=gpt-5.6-terra).
pnpm run --silent workflow -- models get --action commit-review

# Confirm the sweep-review pi lock and repair/issue lanes are what you expect
# (the canary must not perturb them; `models set` merges, so they stay put).
pnpm run --silent workflow -- models get --action sweep-review
```

## 2. Dry-run the flip

`models set` **merges** into the existing map (other actions are preserved).
Preview the exact JSON that would be written before touching the live variable:

```bash
pnpm run --silent workflow -- models set \
  --action commit-review --provider pi --model claude-opus-4-8 --dry-run
```

Confirm the printed JSON keeps every other action's entry intact and only
changes `commit-review`.

## 3. Flip to pi

```bash
pnpm run --silent workflow -- models set \
  --action commit-review --provider pi --model claude-opus-4-8
# → set commit-review: provider=pi model=claude-opus-4-8 effort=<unchanged>

# Re-resolve to confirm.
pnpm run --silent workflow -- models get --action commit-review   # provider=pi
```

## 4. Trigger a commit-review on a known commit

Pick a recent, already-reviewed commit on `main` (low blast radius) and dispatch:

```bash
SHA=$(git rev-parse origin/main)
gh workflow run commit-review.yml --repo valkyriweb/clawsweeper \
  -f target_repo=valkyriweb/clawsweeper -f commit_sha="$SHA" -f create_checks=true

# Watch it (grab the newest run id, then watch).
gh run list --repo valkyriweb/clawsweeper -L 5
gh run watch <run-id> --repo valkyriweb/clawsweeper
```

## 5. Evidence checklist

Collect all of these before reverting:

- [ ] **Routing** — the `commit-routing` step log shows `review_provider=pi`.
- [ ] **Conditional setup** — `setup-pi` (and the Pi package token step) ran;
      `setup-claude-code` skipped.
- [ ] **Invocation** — the `Review commit` step invoked `pi -p --mode json …`
      (not `codex exec`).
- [ ] **Artifact** — the `commit-review-<sha>` artifact's report has valid front
      matter with `review_provider: pi` and `review_model: claude-opus-4-8`
      (D5 provenance stamp), and a real body (not a fail-closed failure report).
- [ ] **Check** — the published GitHub Check on the target commit reflects the
      report conclusion.
- [ ] **Telemetry** — the `commit-review-usage-<sha>` artifact's
      `usage-events.jsonl` has a row with `provider: "pi"` and non-null `tokens`.
- [ ] **Findings dispatch** — the `publish` job dispatched findings to the repair
      lane as usual (provider-agnostic; should be unchanged).

## 6. Revert to codex

```bash
pnpm run --silent workflow -- models set \
  --action commit-review --provider codex --model gpt-5.6-terra

pnpm run --silent workflow -- models get --action commit-review   # provider=codex
```

Trigger one more commit-review (step 4) and confirm the `commit-routing` log
shows `review_provider=codex`, `setup-pi` skips, and the invocation is
`codex exec` again.

## 7. Rollback / emergency

Fastest revert to built-in defaults — clear the whole commit-review entry (or
the entire variable). commit-review is prod-inert with the registry unset:

```bash
# Restore the pre-canary registry captured in step 1:
gh variable set CLAWSWEEPER_MODELS --repo valkyriweb/clawsweeper \
  --body "$(cat /tmp/cw-models.before.json)"

# …or, to drop overrides entirely (all lanes fall back to built-in defaults):
gh variable delete CLAWSWEEPER_MODELS --repo valkyriweb/clawsweeper
```

No deploy is required for any of the above — the next workflow run resolves the
new registry state.
