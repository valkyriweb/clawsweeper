# Sweep-review routing eval

Run the actual `runPi` sweep-review transport against a frozen sanitized fixture.

```sh
pnpm run build
node evals/sweep-routing/run.mjs clawrouter/claude-opus-5 evals/sweep-routing/results/opus-5.json
node evals/sweep-routing/run.mjs clawrouter/claude-sonnet-5 evals/sweep-routing/results/sonnet-5.json
```

The saved run shows Opus 5 matched all labels; Sonnet 5 failed by claiming `reproduced/high` without a concrete expected behavior. The independent medium-tier judge (`clawrouter/gpt-5.6-terra`) agreed. Therefore Sonnet 5 is not promoted.

Revert the catalog-refresh fallback on transport/schema failure, unsafe close, or a label mismatch on the next contracted cohort. This fixture proves neither live topology nor cohort quality.
