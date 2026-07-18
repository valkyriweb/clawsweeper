# Spec: Provider-switchable commit-review lane (registry-driven)

Status: PROPOSED (planning only — no repo changes made)
Date: 2026-07-18
Repo: openclaw/clawsweeper (wd: `/Users/luke/Projects/personal/github-triage/clawsweeper`)

---

## 1. Problem statement, scope, non-goals

### Problem
The commit-review lane is hard-wired to codex:

- `src/commit-sweeper.ts` — the `review` subcommand builds a codex-only invocation:
  `runCodex()` constructs `const codexConfig = [...]` and calls
  `spawnSync("codex", ["exec", "-m", model, …, "--output-last-message", outputPath, "--json", "--sandbox", …, "-"])` (~L304–L330).
  `reviewCommand()` parses only codex-shaped args: `codex_model`, `codex_reasoning_effort`,
  `codex_sandbox`, `codex_service_tier`, `codex_timeout_ms` (~L416–L421).
- `.github/workflows/commit-review.yml` — the "Review commit" step (~L478–L505,
  `working-directory: clawsweeper`) runs only `setup-codex`, resolves the model via
  `pnpm run --silent workflow -- action-model --action commit-review --fallback gpt-5.6-terra`,
  applies the `clawrouter/<slug>` prefix in bash when `CLAWSWEEPER_CODEX_AUTH_MODE=clawrouter`,
  and invokes `node dist/commit-sweeper.js review --codex-model … --codex-reasoning-effort …`.

Meanwhile the model registry (`src/model-registry.ts`) already stores and validates a
`provider` per action (`ACTION_PROVIDERS["commit-review"] = [codex, pi, claude-bridge, claude-code]`,
`resolveActionConfig` → `{provider, model, effort}`), but **nothing consumes `provider` at
runtime**. There is no `actionProvider()` resolver and no `action-provider` CLI case in
`src/repair/workflow-utils.ts` (verified: cases are `review-provider` (sweep, target-repo keyed),
`review-model`, `codex-reasoning-effort`, `action-model`, `models …`).

Goal: an operator runs `clawsweeper models set commit-review --provider pi --model claude-opus-4-8`
and the next commit-review run actually executes on pi — with codex remaining the untouched
default while `CLAWSWEEPER_MODELS` is unset.

### Scope
- Provider resolution for the commit-review lane: registry → default (`codex`).
- Runtime execution of commit reviews on `pi` and `claude-code` in addition to `codex`.
- `commit-review.yml` wiring: routing step, conditional provider setup, provider-branched invocation.
- Tests proving all of the above without live provider calls.

### Non-goals (explicit)
- **repair-worker and issue-implementation stay codex-only** (`ACTION_PROVIDERS` already enforces this).
- **sweep-review stays pi/opus and LOCKED** — no changes to `clawsweeper.ts`'s provider routing,
  `reviewProviderForTarget`, `CLAWSWEEPER_REVIEW_PROVIDER` semantics, or `sweep.yml`.
- No change to the commit report contract (YAML front matter + markdown body) or to downstream
  consumers (`publish-check`, `dispatch-findings`, records archive).
- No async rewrite; the lane stays synchronous (`spawnSync` architecture).
- claude-bridge support for commit-review: **proposed OUT of v1 scope** (see Unresolved Decision D2).

---

## 2. Runtime design — the crux

### The mismatch that shapes everything
The sweep lane's providers are **not** drop-in reusable for commit-review, because their output
contract is different:

- Sweep runners (`src/clawsweeper.ts`): `runReview()` dispatcher (~L4831–L4846) routes to
  `runCodex` (~L5891), `runClaude` (~L5001), `runClaudeCode` (~L5299), `runPi` (~L5506). Every
  one returns a **`Decision`** — structured JSON validated by `parseDecision` against
  `reviewDecisionSchemaText()`. Their prompts are built from `Item`/`ItemContext`/`GitInfo` via
  `buildReviewPrompt(...)` with per-provider templates (`REVIEW_ITEM_CLAUDE_PROMPT_PATH`, L803).
  `runPi` even wraps the prompt with "Respond with ONLY a single JSON object matching this
  JSON Schema" (~L5527–L5530).
- Commit-review (`src/commit-sweeper.ts`): the model produces a **free-form Markdown report with
  YAML front matter** (prompt: `prompts/review-commit.md` + commit metadata + diff summary), which
  is written to `records/<slug>/commits/<sha>.md` and parsed downstream by `splitFrontMatter`
  (publish-check, dispatch-findings, reports).

So the reusable part of the sweep lane is the **transport** (how to spawn `pi`/`claude` and get
text back), not the **contract** (Decision schema, Item-shaped prompts, parseDecision).

### Options compared

**Option A — extract the whole provider-execution layer out of `clawsweeper.ts`**
(runCodex/runClaude/runClaudeCode/runPi + `SpawnFn` seam + Decision + prompt selection into a
shared module imported by both entry points).

- Pros: one provider layer, one watchdog, one telemetry path; long-term cleanest.
- Cons: `clawsweeper.ts` is 11,265 lines and load-bearing for the locked sweep lane. The runners
  are entangled with `Item`/`ItemContext`/`GitInfo`, `buildReviewPrompt`, `parseDecision`,
  module-level caches (`reviewClaudePromptTemplateCache`, `reviewDecisionSchemaCache`,
  L1340/L4364–L4370), `normalizeRepo`/`targetRepo`/`REPORT_REPO` globals, and sweep-specific
  telemetry fields. Extraction churns hundreds of lines in the file the sweep lane depends on,
  and the Decision contract is useless to commit-review anyway. High regression risk for a lane
  we are explicitly forbidden to destabilize. **Rejected for v1.**

**Option B — commit-sweeper imports the exported runners from `clawsweeper.ts` and adapts
commit-review to the `Decision` contract.**

- Pros: zero extraction.
- Cons: (1) The runners demand `Item`/`ItemContext`/`GitInfo` — commit-review has none of these
  (and sweep's `runCodex` is not even exported; only `runReview`, `runClaude`, `runClaudeCode`,
  `runPi`, `runCodexForTest` are). (2) Forcing commit reviews into `Decision` shape would rewrite
  the entire report contract (front matter → publish-check → dispatch-findings → records), a far
  larger blast radius than the runtime change itself. (3) Importing `dist/clawsweeper.js` from
  `commit-sweeper.js` drags the whole 11k-line module (plus module-load work like the schema
  parse near L11235) into the commit lane's runtime. **Rejected.**

**Option C (RECOMMENDED) — commit-review-local, text-mode provider runners; share only the
low-level seams that are already shared or trivially shareable.**

New small module `src/commit-review-providers.ts` (imported only by `commit-sweeper.ts`):

- `type CommitReviewProvider = "codex" | "pi" | "claude-code"` (subset of `ReviewProvider`).
- `SpawnFn` type — same shape as `clawsweeper.ts` L5247–L5263 (a pure type; duplicating is
  zero-risk, or lift the type into a tiny `src/spawn-seam.ts` shared by both — types-only
  extraction, no behavior moved).
- `runCommitReviewCodex(opts)` — move the existing `runCodex` body from `commit-sweeper.ts`
  essentially unchanged (spawnSync codex exec … `--output-last-message`), now taking `spawnFn`.
- `runCommitReviewPi(opts)` — mirrors `runPi`'s **transport** (flag shapes from
  `clawsweeper.ts` ~L5543–L5549: `pi -p --mode json --no-session [--model <m>]`, prompt on
  stdin, `codexEnv({ghToken: …})`, `maxBuffer: 128MiB`, `timeout`), but instead of demanding a
  JSON Decision, the commit prompt asks for the Markdown report and we extract the final
  assistant text from the JSONL event stream. Token usage via `parsePiTokenUsageFromJsonl`
  (already exported from `src/usage-telemetry.ts`, L260).
- `runCommitReviewClaudeCode(opts)` — mirrors `runClaudeCode`'s transport
  (`claude -p --output-format json`, **without** `--json-schema`): envelope
  `{type:"result", is_error, result}` where `result` is the markdown text.
- All three: prompt string in → markdown report string out; on spawn error / nonzero exit /
  timeout they return a structured failure so `reviewCommand` can keep using the existing
  `failureReport()` (make its wording provider-labeled: "Codex/Pi/Claude Code").
- `reviewCommand` gains `--provider` (default `codex`), generic `--model` / `--timeout-ms` /
  `--sandbox`, keeping `--codex-model` etc. as back-compat aliases so today's workflow
  invocation is bit-for-bit unchanged.

Sharing note: the pi assistant-text extractor (`extractPiAssistantText`, `clawsweeper.ts`
L5666, **private**) and the streaming activity watchdog (`runCliWithActivityWatchdog`, L5761,
**private**) live inside `clawsweeper.ts`. v1 does **not** extract them:
- assistant-text extraction: implement a small local equivalent in the new module (the JSONL
  event walk is ~30 lines; reference impl also exists in `clawpatch/src/provider.ts` per the
  comments at L5505). Alternatively `export` the existing function from `clawsweeper.ts` — a
  1-line diff — but that makes commit-sweeper import the 11k-line module; prefer the local copy.
- watchdog: commit-review's codex path already uses a plain `spawnSync` **total** timeout
  (30 min). Keep that semantics for pi/claude-code in v1; watchdog parity is PR-5 (optional).

**Skeptical review of Option C (failure modes I'm signing up for):**
- *Duplication drift*: the pi/claude CLI flag shapes now exist in two places. If `runPi` changes
  flags (e.g. tool allowlist, `--no-session`), commit-review can silently diverge. Mitigation:
  header comments cross-referencing `clawsweeper.ts` line anchors both ways (the codebase already
  uses this convention, e.g. L4470–L4472), plus a follow-up extraction PR once behavior is proven.
- *Free-form output is weaker than schema-enforced output*: pi has no provider-level markdown
  enforcement; expect a higher malformed-front-matter rate than codex (`runPi`'s own comment
  warns of higher `schema_invalid` rates even WITH schema wrapping). Mitigation: keep
  `ensureCommitReportTimestamps` + `stripMarkdownFence`, add a front-matter sanity check that
  downgrades a malformed report to `failureReport` (fail-closed to `check_conclusion: neutral`)
  rather than publishing garbage, and canary before any default flip.
- *No inactivity watchdog*: a stalled pi process burns the full 30-min timeout instead of being
  killed at idle. Acceptable for a per-commit matrix job; noted as PR-5.
- *If commit-review and item-review prompts are ever meant to converge*, Option C entrenches
  divergence. They serve different contracts today (report vs Decision), so I accept this.

---

## 3. Registry consumption: `actionProvider()` + `action-provider` CLI

In `src/repair/workflow-utils.ts` (mirroring `actionModel`, L254–L260):

```ts
// Resolve the provider for an action: registry override wins, else the
// caller-supplied fallback (if valid), else the built-in per-action default.
// Prod-inert: with CLAWSWEEPER_MODELS unset this returns DEFAULT_ACTION_CONFIG[action].provider.
export function actionProvider(action: ModelAction, fallback: string): ReviewProvider {
  const override = parseModelRegistry(process.env.CLAWSWEEPER_MODELS)[action]?.provider;
  if (override) return override;
  const trimmed = fallback.trim();
  if (trimmed) {
    if (!(trimmed in PROVIDER_MODELS)) throw new Error(`unknown provider fallback: ${trimmed}`);
    if (!ACTION_PROVIDERS[action].includes(trimmed as ReviewProvider)) {
      throw new Error(`"${action}" does not support provider "${trimmed}"`);
    }
    return trimmed as ReviewProvider;
  }
  return DEFAULT_ACTION_CONFIG[action].provider;
}
```

CLI case (next to `action-model`, ~L105):

```ts
case "action-provider":
  process.stdout.write(
    actionProvider(requireModelAction(requiredString("action")), optionalString("fallback")),
  );
  break;
```

**Precedence for commit-review — DELIBERATE DEVIATION, needs ratification (Decision D1):**
the task brief proposed `registry → CLAWSWEEPER_REVIEW_PROVIDER → default`. This spec recommends
**registry → default (codex), with NO `CLAWSWEEPER_REVIEW_PROVIDER` in the chain**, because that
repo variable is currently set to `pi` in production — it is the mechanism of the sweep-review
pi/opus lock (see `DEFAULT_ACTION_CONFIG` comment: "reflects the CLAWSWEEPER_REVIEW_PROVIDER=pi
lock", and `reviewProviderForTarget` in workflow-utils.ts ~L228–L234). Including it would flip
commit-review to pi **the moment the code ships**, violating the prod-inert requirement. If an
env fallback is wanted anyway, mint a NEW variable (e.g. `CLAWSWEEPER_COMMIT_REVIEW_PROVIDER`).
The workflow simply calls `action-provider --action commit-review` with no fallback.

Model/effort resolution stays exactly as today: `action-model --action commit-review --fallback
gpt-5.6-terra` (bare slug; caller applies `clawrouter/` prefix — codex only) and
`codex-reasoning-effort --action commit-review` (codex only; `EFFORT_PROVIDERS` = `{codex}`,
effort is advisory/ignored for pi & claude-code).

Cross-provider model guard: `PROVIDER_MODELS` already prevents a registry state like
`provider=pi, model=gpt-5.6-terra` at write time (`validateActionPatch` re-validates the merged
entry in `applyRegistrySet`). One residual hole to close in PR-1 tests: a provider-only patch
over the default codex model — `validateActionPatch` validates `model` only if present, so
`{provider:"pi"}` with no stored model resolves at runtime to the codex default `gpt-5.6-terra`,
which is invalid for pi. Mitigation: when provider changes and no model is stored, either
hard-error in `models set` or auto-resolve to `PROVIDER_MODELS[provider][0]`. **Verify current
behavior of `applyRegistrySet({provider:"pi"})` in PR-1 and add the guard there (Decision D3).**

---

## 4. Workflow changes — `.github/workflows/commit-review.yml`

Pattern source: `sweep.yml` `review-routing` step (~L274–L283) + conditional setup steps
(~L306–L327). Changes, all inside the `review` job:

1. **Routing step** (after `setup-pnpm` (~L442), before `setup-codex` (~L447) — it needs pnpm):

```yaml
- id: commit-routing
  working-directory: clawsweeper
  env:
    CLAWSWEEPER_MODELS: ${{ vars.CLAWSWEEPER_MODELS || '' }}
  run: |
    set -euo pipefail
    echo "review_provider=$(pnpm run --silent workflow -- action-provider --action commit-review)" >> "$GITHUB_OUTPUT"
    echo "review_model=$(pnpm run --silent workflow -- action-model --action commit-review --fallback gpt-5.6-terra)" >> "$GITHUB_OUTPUT"
    echo "codex_effort=$(pnpm run --silent workflow -- codex-reasoning-effort --action commit-review)" >> "$GITHUB_OUTPUT"
```

2. **Provider setups**: keep `setup-codex` unconditional (sweep.yml's stated rationale: cheap
   when warm, helper steps use the codex CLI regardless). Add, adapted from sweep.yml L306–L327:

```yaml
- if: ${{ steps.commit-routing.outputs.review_provider == 'claude-code' }}
  uses: ./clawsweeper/.github/actions/setup-claude-code
  with: { …copy sweep.yml's inputs verbatim — verify, truncated in planning read… }

- if: ${{ steps.commit-routing.outputs.review_provider == 'pi' }}
  name: Create Pi package token
  id: pi-package-token
  uses: actions/create-github-app-token@1b10c78c7865c340bc4f6099eb2f838309f1e8c3 # v3.1.1
  with:
    client-id: ${{ env.CLAWSWEEPER_APP_CLIENT_ID }}
    private-key: ${{ secrets.CLAWSWEEPER_APP_PRIVATE_KEY }}
    owner: valkyriweb
    repositories: my-pi
    permission-contents: read

- if: ${{ steps.commit-routing.outputs.review_provider == 'pi' }}
  uses: ./clawsweeper/.github/actions/setup-pi
  with:
    token: ${{ steps.pi-package-token.outputs.token }}
```

   NOTE path prefix: commit-review.yml uses `./clawsweeper/.github/actions/...` (repo checked out
   under `clawsweeper/`), unlike sweep.yml's `./.github/actions/...` — keep the commit-review form.

3. **"Review commit" step** (~L478–L505) becomes provider-branched bash:

```bash
PROVIDER="${{ steps.commit-routing.outputs.review_provider }}"
MODEL_BARE="${{ steps.commit-routing.outputs.review_model }}"
EFFORT="${{ steps.commit-routing.outputs.codex_effort }}"
if [ "$PROVIDER" = "codex" ]; then
  # clawrouter prefix is a codex-only addressing scheme (fail-closed namespace).
  if [ "$CLAWSWEEPER_CODEX_AUTH_MODE" = "clawrouter" ] && [ "${MODEL_BARE#clawrouter/}" = "$MODEL_BARE" ]; then
    MODEL="clawrouter/${MODEL_BARE}"
  else
    MODEL="$MODEL_BARE"
  fi
  node dist/commit-sweeper.js review <common args> --provider codex --model "$MODEL" \
    --codex-reasoning-effort "$EFFORT" --codex-sandbox danger-full-access --timeout-ms 1800000
else
  # pi / claude-code: bare Anthropic slug; no codex effort, no clawrouter prefix.
  node dist/commit-sweeper.js review <common args> --provider "$PROVIDER" --model "$MODEL_BARE" \
    --timeout-ms 1800000
fi
```

   Common args unchanged: `--target-repo/--target-dir/--commit-sha/--report-dir/--artifact-mode/--work-dir`.
   Env unchanged: `GH_TOKEN`, `COMMIT_SWEEPER_TARGET_GH_TOKEN`, `COMMIT_SWEEPER_ADDITIONAL_PROMPT`,
   `CLAWSWEEPER_MODELS`, `CLAWSWEEPER_CODEX_AUTH_MODE`.

4. Downstream steps (`publish-check`, artifact uploads, `dispatch-findings` in the publish job)
   are report-driven and need no changes; usage-events upload already globs `**/usage-events.jsonl`.

**Verify before implementing** (workflow unknowns):
- `runs-on` of commit-review's `review` job vs sweep's review job — pi/claude-code auth
  (bridge availability, credentials in `setup-pi`/`setup-claude-code`) is proven on the sweep
  runner pool; confirm commit-review runs on the same pool.
- Exact `with:` inputs for `setup-claude-code` in sweep.yml (copy verbatim).
- Which GH token env should feed `codexEnv` for the pi child in the commit lane
  (sweep's `runPi` uses `CLAWSWEEPER_PROOF_INSPECTION_TOKEN`; commit lane has
  `COMMIT_SWEEPER_TARGET_GH_TOKEN`).

---

## 5. Ordered PR breakdown (each shippable, prod-inert, gated)

Gates for every PR: `pnpm run build:all`, `pnpm run test:unit` (top-level `test/*.test.ts`),
`pnpm run test:repair` (4 known local-only git-fixture failures OK; must pass in CI),
`lint:src` + `lint:repair`, `format:check` (oxfmt — it also formats `.github/workflows`, so PR-3
must be oxfmt-clean). `exactOptionalPropertyTypes: true` — build patch objects conditionally
(the registry code already models this; follow it). Tests import from `dist/`, so new runtime
seams must be exported and built.

### PR-1 — Registry: `actionProvider` resolver + `action-provider` CLI + coherence guard
- **Goal**: expose the stored provider to workflows; close the provider-flip-without-model hole;
  (per D2) narrow `ACTION_PROVIDERS["commit-review"]` to `["codex","pi","claude-code"]`.
- **Files**: `src/repair/workflow-utils.ts` (resolver + CLI case), `src/model-registry.ts`
  (ACTION_PROVIDERS narrow + coherence rule in `applyRegistrySet`),
  `test/model-registry.test.ts`, `test/repair/workflow-utils.test.ts`.
- **Tests**: resolver precedence (registry set/unset/invalid JSON/valid + invalid fallback);
  `action-provider` CLI stdout; `applyRegistrySet` provider-only patch behavior;
  claude-bridge rejected for commit-review.
- **Risk**: low. Narrowing ACTION_PROVIDERS could invalidate an existing stored registry entry —
  today `CLAWSWEEPER_MODELS` is unset or commit-review=codex, so inert; note in PR body.
- **Acceptance**: registry unset → `workflow -- action-provider --action commit-review` prints
  `codex`; with `{"commit-review":{"provider":"pi","model":"claude-opus-4-8"}}` prints `pi`;
  gates green.
- **Effort**: S (~0.5d). **This is the smallest first real slice and unblocks PR-2/PR-3.**

### PR-2 — Runtime: provider-neutral `commit-sweeper review` (pi + claude-code text-mode runners)
- **Goal**: `--provider pi|claude-code|codex` executes end-to-end behind an injectable spawn seam;
  default `codex` path byte-identical to today.
- **Files**: new `src/commit-review-providers.ts`; `src/commit-sweeper.ts` (arg surface:
  `--provider`, `--model`, `--timeout-ms`, `--sandbox` with `--codex-*` back-compat aliases;
  provider-labeled `failureReport`; telemetry `provider` field + pi token parsing via
  `parsePiTokenUsageFromJsonl`); exported test seam (e.g. `runCommitReviewForTest`, mirroring
  `runCodexForTest`, `clawsweeper.ts` L5210); commit-sweeper test extensions.
- **Tests**: fake `SpawnFn` fixtures — pi JSONL stream with assistant markdown, claude-code
  `{type:"result"}` envelope, nonzero exit, ETIMEDOUT, empty output, fenced markdown; assert
  exact spawn command+args per provider (locks the CLI contract); written report front matter
  round-trips through `splitFrontMatter`; `--codex-model` alias still works; usage-events rows
  carry `provider` and pi tokens; malformed front matter → `failureReport` (fail-closed).
- **Risk**: medium — malformed non-codex reports; alias/arg regressions (both test-covered).
- **Acceptance**: no `--provider` → identical codex spawn args as today (asserted via seam);
  pi/claude-code fixtures yield valid reports; gates green. Prod-inert: workflow still passes
  codex-only args until PR-3.
- **Effort**: M/L (~1.5–2d; fixtures dominate).

### PR-3 — Workflow: commit-review.yml routing + conditional setups + branched invocation
- **Goal**: §4 wiring; behavior identical while registry is unset (routing prints codex,
  conditional steps skip, codex branch reproduces today's command incl. clawrouter prefix).
- **Files**: `.github/workflows/commit-review.yml` only.
- **Tests/evidence**: actionlint (if available) + `format:check`; side-by-side diff of the
  rendered codex-branch command vs the current step; one real `workflow_dispatch` run with
  registry unset (must be codex, green, artifacts identical in shape).
- **Risk**: medium — YAML/step-ordering mistakes (routing needs pnpm), wrong action path prefix.
- **Acceptance**: registry-unset dispatch run green on codex; conditional steps skipped.
- **Effort**: M (~0.5–1d + one live dispatch).

### PR-4 — Canary + runbook (ops; docs-only)
- **Goal**: prove the flip. In a low-traffic window: `clawsweeper models set commit-review
  --provider pi --model claude-opus-4-8` (or sonnet for cost), trigger commit-review on a known
  commit, inspect: logs (setup-pi ran, pi invoked), report artifact front matter, published
  check, dispatch-findings behavior; then revert (`--provider codex --model gpt-5.6-terra` or
  clear the entry).
- **Files**: runbook doc only (verify where the repo keeps runbooks).
- **Risk**: low — revert is a variable write; next run is codex again.
- **Acceptance = validation evidence list in §7.** **Effort**: S (~0.5d window).

### PR-5 (optional, later) — Watchdog & extraction parity
- **Goal**: extract `runCliWithActivityWatchdog` (+ knobs like `reviewInactivityTimeoutMs`,
  `clawsweeper.ts` L4628/L5761) into a shared module used by both lanes; optionally converge the
  pi assistant-text extractor. Only after PR-4 proves behavior; pure refactor with sweep-lane
  regression tests. This is the deferred Option-A risk — keep isolated and revertable.
- **Effort**: M (~1d).

---

## 6. Proposed tracker (do not create yet)

**Milestone**: `commit-review: provider switchability`

**Tracker issue title**:
`[tracker] Commit-review lane: registry-driven provider switch (codex ⇄ pi/claude-code)`

**Tracker body (draft)**:
> **Spec**: (link committed spec / this document).
> **Why**: the model registry (`CLAWSWEEPER_MODELS`) stores a validated `provider` per action but
> nothing consumes it at runtime; commit-review is hard-coded to codex in `src/commit-sweeper.ts`
> and `.github/workflows/commit-review.yml`. Operators should be able to flip commit-review's
> provider with `clawsweeper models set commit-review --provider … --model …` — no deploy.
> **Approach**: text-mode provider runners local to the commit lane (Option C in the spec) — no
> extraction from `clawsweeper.ts`, no change to the Decision contract or the commit-report
> contract; sweep-review stays pi/opus LOCKED; repair-worker/issue-implementation stay codex-only.
> **Prod-inert invariant**: every child PR leaves behavior unchanged while `CLAWSWEEPER_MODELS`
> is unset; commit-review does NOT read `CLAWSWEEPER_REVIEW_PROVIDER` (that variable is the
> sweep-review pi lock and is `pi` in prod — Decision D1 in the spec).
> **Ordered children**: 1→5 below, each gated on build:all / test:unit / test:repair /
> lint:src+lint:repair / format:check.
> **Rollback**: `models set commit-review --provider codex` or clear the registry entry.

**Ordered child issues**:
1. `commit-review provider 1/5: actionProvider resolver + action-provider CLI + registry coherence guard`
2. `commit-review provider 2/5: provider-neutral commit-sweeper review (pi + claude-code text-mode runners, spawn seam)`
3. `commit-review provider 3/5: commit-review.yml routing step, conditional setup-pi/setup-claude-code, branched invocation`
4. `commit-review provider 4/5: canary flip runbook + evidence (pi window, revert)`
5. `commit-review provider 5/5 (optional): shared activity-watchdog extraction for CLI providers`

---

## 7. Test strategy, validation evidence, risks, rollback

### Unit tests (no live providers)
- **Resolvers** (PR-1): env-driven tests in `test/repair/workflow-utils.test.ts` /
  `test/model-registry.test.ts` — set/unset `CLAWSWEEPER_MODELS`, assert `actionProvider` output
  and `action-provider` CLI stdout; invalid provider/action fail-closed.
- **Runtime branch** (PR-2): the `SpawnFn` seam is the proof mechanism (same pattern as sweep:
  `spawnFn` injection on `runClaudeCode`/`runPi`; `runCodexForTest` at `clawsweeper.ts` L5210).
  Fixtures: pi `--mode json` JSONL, claude `-p --output-format json` envelope. Assert exact spawn
  command+args per provider, report bytes, front-matter round-trip via `splitFrontMatter`,
  failure paths → `failureReport` with `check_conclusion: neutral`/`timed_out`, telemetry rows.
- **Workflow** (PR-3): oxfmt/actionlint + rendered-command diff; no yml unit harness exists.

### Validation evidence required to call this done
1. CI-green gates on all child PRs.
2. Post-PR-3 registry-unset dispatch run: codex path, routing step logs `review_provider=codex`,
   conditional steps skipped, report + check identical in shape to a pre-change run.
3. Canary run with registry=pi: logs show setup-pi + `pi -p …`; artifact report has valid front
   matter; check published on target commit; `usage-events.jsonl` row with `provider: "pi"` and
   token counts; findings dispatch (or its dry-run) behaves.
4. Revert evidence: registry cleared → next run back on codex.

### Top risks
1. **Accidental prod flip via `CLAWSWEEPER_REVIEW_PROVIDER`** (=`pi` in prod, sweep lock).
   Mitigation: commit-review's chain is registry → codex default only (D1).
2. **Report-contract drift on non-codex providers** — malformed front matter poisons
   publish-check / dispatch-findings / records. Mitigation: fail-closed front-matter validation →
   `failureReport`, fixture tests, canary before any durable flip.
3. **Transport duplication drift** (pi/claude flag shapes copied from `clawsweeper.ts`).
   Mitigation: cross-referencing comments, spawn-args assertion tests, optional PR-5 convergence.
4. Runner/auth gap: pi/claude-code credentials proven only on the sweep job's runner pool —
   verify commit-review's `runs-on` before PR-3.

### Rollback
- Operator-level: `clawsweeper models set commit-review --provider codex --model gpt-5.6-terra`
  (or clear the variable) — next run is codex; zero deploy.
- Code-level: PRs independently revertable in reverse order; reverting PR-3 alone restores the
  exact current workflow even if PR-2 stays.

---

## 8. Unresolved decisions (need explicit ratification)

- **D1 — Fallback chain**: task brief said registry → `CLAWSWEEPER_REVIEW_PROVIDER` → default;
  this spec recommends dropping the env var (it is `pi` in prod as the sweep lock and would flip
  commit-review on ship). Confirm, or mint `CLAWSWEEPER_COMMIT_REVIEW_PROVIDER` instead.
- **D2 — claude-bridge for commit-review**: `ACTION_PROVIDERS` allows it, but `runClaude` is
  Decision/tool-use-coupled; text-mode bridge support is real extra work. Recommend narrowing
  `ACTION_PROVIDERS["commit-review"]` to `[codex, pi, claude-code]` in PR-1 (fail-closed at
  `models set` time). Alternative: keep listed, hard-error at runtime.
- **D3 — provider-flip model coherence**: guard for registry `provider` set with no `model`
  (default model is codex-only). Verify `applyRegistrySet({provider:"pi"})`; pick "require model
  with provider change" vs "auto-resolve to `PROVIDER_MODELS[provider][0]`".
- **D4 — pi invocation details**: `--mode json` + local assistant-text extraction (recommended —
  keeps token telemetry) vs plain text mode; tool allowlist for the commit lane (sweep read-only
  set `read,glob,grep,agent,Agent` vs commit-review's `danger-full-access` codex posture); which
  GH token env feeds `codexEnv` for the pi child.
- **D5 — front-matter provenance**: stamp `review_provider` / `review_model` into commit report
  front matter (audit value; `splitFrontMatter` consumers appear tolerant of extra keys — verify).
  Recommend yes, in PR-2, via the prompt template + post-write stamping like
  `ensureCommitReportTimestamps`.
- **D6 — watchdog parity timing**: plain total-timeout in v1 (recommended) vs extracting
  `runCliWithActivityWatchdog` up front.
- **Verify list (facts not confirmed in this planning pass)**: commit-review `review` job
  `runs-on` vs sweep's; `setup-claude-code` `with:` inputs in sweep.yml; `applyRegistrySet`
  provider-only behavior; runbook location for PR-4.
