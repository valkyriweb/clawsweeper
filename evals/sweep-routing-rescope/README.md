# Sweep-routing rescope cohort

Bounded source-only harness for the one approved paired routing cohort. It calls the production `dist/clawsweeper.js` `runPi` adapter; it does not replace provider calls. The four frozen snapshots cover the missing expected-behavior contract, the demonstrated `sweep.sh --help` defect, a superseded PR without claiming the evaluated PR merged, and a unique diagnostic PR that must not be called a duplicate.

The Skills fixture is intentionally new and corrects `lue-labs/skills` to `valkyriweb/skills`. Its explicit source/correction provenance is in the fixture and cohort. Because `valkyriweb/skills` is not enrolled in production profiles, the cohort carries a hash-frozen, invocation-only `review_only` Skills profile in `cohort.json`; the runner appends only that fixture profile in-process and renders the native prompt builder on the actual item. This is not production support and never edits `config/target-repositories.json`.

## Accepted label contract

The parent accepted the original prompt-defined labels before any output exists. The synthetic fixture has a clear `foo()` source path, so `source_reproducible` remains valid even though the snapshot has no expected-output contract or established current-main failing path. Its active contract is only `keep_open`, `manual_review`, and `source_reproducible`, with `forbidClose` and `forbidReproducedHigh`; it adds no category, confidence, or close-reason gate and does not forbid `source_reproducible`. The rejected conservative relabel is retained as rationale history in `cohort.json`.

## Commands

All commands are model-call-free except `execute`. Use the saved live catalog:

```sh
node evals/sweep-routing-rescope/run.mjs dry-run --models /tmp/forge-rescope-models.txt
node evals/sweep-routing-rescope/run.mjs preflight --models /tmp/forge-rescope-models.txt
node evals/sweep-routing-rescope/run.mjs freeze \
  --models /tmp/forge-rescope-models.txt \
  --manifest /tmp/forge-rescope/manifest.json
node evals/sweep-routing-rescope/run.mjs execute \
  --models /tmp/forge-rescope-models.txt \
  --manifest /tmp/forge-rescope/manifest.json \
  --output /tmp/forge-rescope/results
node evals/sweep-routing-rescope/run.mjs report --output /tmp/forge-rescope/results
```

`execute` reserves the manifest, every receipt path, and the report before the first call. Existing output/private paths fail closed, so reruns cannot overwrite or silently repeat a case. Raw prompts/responses/errors remain under private `/tmp` storage; published receipts contain compact decisions, route/effort provenance, usage/cost sums, and SHA-256 hashes only. The isolated Pi cwd is empty and contains no labels, results, or repository instructions. This is not a filesystem sandbox: read tools can accept absolute paths. Independent trace review must check that candidates did not retrieve labels or results before any qualification claim.

Each candidate gets exactly one invocation per case with a 300000ms timeout, `read-only` tools, identical frozen prompt evidence, and the same effective tools. `--thinking` records the requested effort (`off` for `none`, `medium` for `medium`); observed backend effort remains `unknown`. Preflight resolves both models against the saved live catalog and registry, validates the decision schema, profiles, fixtures, labels, prompts, and config before spending. Both candidates must pass every case with complete receipts whose per-message costs are finite and nonnegative and whose aggregate cost is finite and positive; the challenger total must be strictly cheaper than the champion. There is no arbitrary percentage or token cap gate.

The deterministic fake-spawn contracts run in `pnpm run test:unit` and the normal check pipeline, without model calls. Run them alone with:

```sh
node --test evals/sweep-routing-rescope/run.test.mjs
```

Historical failed-cohort artifact hashes are retained in `cohort.json`; old artifacts are not modified or rerun.
