# Frozen sweep-routing eval

`cohort.json` fixes four sanitized snapshot cases before a run: missing contract,
Skills #224 help failure, lue-kube #1512 supersession, and ClawRouter #195's
non-duplicate diagnostic. It is snapshot evidence, not a live-production check.

The runner calls the production `runPi` transport. It stores raw Pi JSONL only
under untracked `.eval-work/`, then writes hashed, sanitized receipts. A receipt
uses the terminal assistant `message_end.message.model/provider`; usage-event
telemetry is not routing evidence. `runPi` does not pass `--thinking`, therefore
requested `none` is recorded separately and actual effort is `unknown`.

```sh
pnpm run build
node evals/sweep-routing/run.mjs clawrouter/claude-opus-5 evals/sweep-routing/results/opus-5-final.json
node evals/sweep-routing/run.mjs clawrouter/gpt-5.6-terra-200k evals/sweep-routing/results/terra-200k-final.json
```

Each model runs exactly once per fixture with a 300s per-call limit. A routing
mismatch, incomplete receipt, parse failure, unsafe close, fabricated
reproduction, or label mismatch is a failed promotion. The prior Sonnet failure
is historical evidence only and is not rerun.
