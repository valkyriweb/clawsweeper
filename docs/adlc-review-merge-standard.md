# Forge ADLC review-and-merge standard (phase 1 design and rollout)

Status: design plus draft PRs. Nothing is enabled. No auto-merge, no branch protection or required-check change, no merges. Owner: Forge. Commissioned by Captain for Luke, 16 Oct 2026.

Sources: "How the Claude Code team does code review" (claude.dev, 15 Oct 2026) and Cindy Sridharan's per-principle pre-commit reviewer swarm (dedicated reviewers, one principle each: clarity, abstraction, dependency structure, API breakage, regression, test coherence, perf, security, edge cases). Existing parts reused: the ClawSweeper fork (valkyriweb/clawsweeper: PR review, repair lane, commit review, config/target-repositories.json), the forge-digest skill, the 8 Oct PR-flow approvals, the clawsweeper#264 dry-run pattern, and the horizon push-to-main proposal.

## Goal and guardrail

Spend the least human time per change without raising reverts or incidents. Human time is measured as human approvals per PR (median, p95), human comments, and time a PR waits on a person. Revert and incident rates are the guardrail: if they rise, a repo goes back to human approval.

## Requirement map

| Requirement | Existing component | Smallest addition (phase 1) |
|---|---|---|
| Pre-PR evidence: test, build, screenshot | forge-digest "show output" rule, repo validation commands in `prompt_note` | AGENTS.md "Before you open a PR" block: paste commands run and their output; UI changes attach a screenshot; PR body sections Testing, Risk, How to revert |
| Fresh-context diff review, one principle per reviewer | Herdr panes on the M2 Max with ClawRouter models | Pre-commit swarm skill: N fresh-context subagents, each given only the diff, AGENTS.md, REVIEW.md and one principle. Starts with 5: correctness/edge cases, API breakage/regression, test coherence, security, simplicity. Lives in the agent skills repo, not in CI |
| Short AGENTS.md, owner-written REVIEW.md | Centaur already has AGENTS.md and docs/forge/REVIEW_STANDARDS.md | REVIEW.md template per repo, marked owner-to-write. Forge never writes the standards |
| Repeated findings fixed at the source | Slop Sweeper (lint rules, source fixes), oxlint anti-slop config | Noise report lists any bug class seen 3+ times in 14 days; it goes to Slop Sweeper as a lint rule or source fix ticket, or to the owner as a REVIEW.md line |
| Parallel bug reviewers, majority consensus, tags | ClawSweeper PR review (review providers codex, claude-bridge, pi) | `filterConsensusFindings`: groups findings by bug class, keeps classes a strict majority of reviewers found, drops style/diagnostics/cleanup, tags Important, Nit or Pre-existing |
| Security review blocks | ClawSweeper review prompt plus `prompt_note` security lines | Any consensus finding with category security is `blocking: true` |
| Every thread fixed or resolved with a reason | ClawSweeper PR review comments, repair lane fixes | Outcome per finding: fixed, wrong, intentional, not_important, open. Open blocking findings or unresolved threads make a PR ineligible |
| Risk tier from the change, not the author | review-tier-drift (routine/important/critical) | `classifyRiskTier(files, labels)`: low (docs, copy, `risk:flagged-additive`), medium (ordinary code), human_required (auth, billing, CI workflows and actions, CODEOWNERS, infra, deploy, secrets, owner-listed globs). Author is not an input |
| Bot approvals never count, dismissed on new commits | none | `countHumanApprovals`: ignores bots, counts only approvals on the current head SHA. Turning on GitHub's "dismiss stale approvals" is a branch protection change and waits for Luke |
| Max 3 rounds, then diff-only, no repeats, whole class | none (one CLI PR elsewhere ran 50+ rounds) | `planReviewRound`: rounds 1 to 3 full, then diff-only, round 4 asks the author to step back; already-posted classes are suppressed; one comment per class lists every location |
| Merge queue or re-check against main, staging first, one-step revert | forge-digest merge procedure (`recheck.sh`, `--match-head-commit`, wait for main CI), Centaur `pr-<n>` Alchemy stage, `gh pr revert` | Phase 1 keeps the forge-digest procedure as the re-check. A GitHub merge queue is a required-check change and waits for Luke. Every PR body states how to revert |
| Reverts and incidents become a nightly eval | `evals/` folder, forge-digest dry-run logs | Eval set: each past revert or incident PR with its fix, confirmed by the owner. Phase 2 adds a nightly run scoring recall and false positives; every reviewer prompt or model change is rescored |
| Track reviewer noise | review-tier-drift notifier | `summariseNoise`: noise rate = (wrong + not_important) / answered findings, per repo and per reviewer |
| Nightly sweep of existing code | ClawSweeper commit review and nightly sweeps | Phase 2: one nightly pass per adopted repo, findings tagged Pre-existing, routed to the repair lane, capped at 5 per night |
| Circuit breaker | none | `evaluateCircuitBreaker`, thresholds below |
| Weekly fleet summary for Luke | forge-digest week rollup | One Monday 09:00 SAST section: per repo tier mix, would-auto-merge count, human approvals per PR, rounds-to-pass, noise rate, reverts, incidents, breaker state |

Everything new in ClawSweeper sits behind a per-repo `review_standard` block. Missing block means mode `off`. Phase 1 accepts only `off` and `dry_run`; any other mode fails config validation, so live auto-merge cannot be switched on by accident.

## Risk tiers

| Tier | What | Human approvals | Phase 1 behaviour |
|---|---|---|---|
| Low | Docs, copy, i18n, additive changes labelled `risk:flagged-additive` | 0 once CI, consensus review and security review are green | Reported as "would auto-merge" only |
| Medium | Ordinary code changes | 1 human, on the head SHA | Unchanged from today |
| Human required | Auth, billing, CI workflows and actions, CODEOWNERS, infra, deploy, Dockerfiles, secrets, `.env*`, owner-listed paths | Always at least 1 human; owners can require 2 | Unchanged from today |

Whoever directed the agent is accountable for the change. A second-opinion step can raise a tier but never lower it.

## Circuit breaker

Window 14 days per repo. Trips when either:
- auto-merged PRs in the window are 10 or more and the revert rate is above 5 percent, or
- more than 1 incident traced to an auto-merged change in the window.

When tripped, the repo drops to "every PR needs 1 human" at once and stays there until 14 clean days pass and Luke says go. Forge tells Captain the same day; Luke sees it in the weekly summary unless it involves prod.

## Rollout (crawl, walk, run)

Order: Centaur (Detoil/centaur), then Vera, Core Catering, Tales, lue-kube. One repo at a time, each step only with Luke's go relayed and confirmed.

**Crawl (phase 1, 2 weeks per repo, dry-run).** Merge the ClawSweeper draft once approved. The adopted repo runs consensus review and tier classification in `dry_run`: labels and report only, no merges, no approvals. Owner writes REVIEW.md. Exit when, over 2 weeks: at least 20 PRs classified; the owner agrees with the tier on at least 95 percent of a 20-PR sample, with zero human_required changes classified low; noise rate at most 25 percent; median rounds-to-pass at most 2; eval recall on the revert set at least 70 percent.

**Walk (phase 2, 4 weeks).** Needs Luke's explicit OK and a branch protection change done by a human: dismiss stale approvals, require resolved threads, and either a merge queue or the forge-digest re-check as a required step. Low-tier PRs auto-merge through the forge-digest procedure. Nightly eval and nightly code sweep go live. Exit when: revert rate does not rise against the crawl baseline; zero incidents from auto-merged PRs; human approvals per PR median falls; breaker never tripped, or tripped once and recovered.

**Run (phase 3).** Next repo in the order starts at crawl. Owners may widen low tier with evidence (for example flagged UI changes). lue-kube stays human_required for anything under its manifests whatever the tier says.

## Rollback

- Config: set `review_standard.mode` to `off`, or remove the block, in one config PR. Behaviour returns to today's at the next sweep.
- Code: `gh pr revert <n> -R valkyriweb/clawsweeper` on the pipeline PR. It is additive and wired only through config, so reverting has no data migration.
- A bad auto-merge: `gh pr revert` on the target repo, then the breaker counts it.
- Repo docs: AGENTS.md and REVIEW.md changes revert with one `gh pr revert`.

## Phase 1 status

- Draft PR (a) in valkyriweb/clawsweeper: `src/review-standard.ts` (tier classifier, human approval counter, consensus filter with tags, round cap with repeat suppression, noise summary, circuit breaker, would-auto-merge dry-run check), config parsing for `review_standard` (default off, live rejected), tests, and the Centaur allowlist entry (review_only, issue closes dry-run, review_standard dry_run). Not wired into the live review path yet; that wiring is the next draft once this one is reviewed.
- Draft PR (b) in Detoil/centaur: AGENTS.md pre-PR evidence block, REVIEW.md template marked owner-to-write that points at the existing docs/forge/REVIEW_STANDARDS.md, and an opt-in file. No workflow files touched; the Centaur PM agent's open PRs touch none of these files.

## Open decisions for Luke

1. Whether the ClawSweeper GitHub App (valkyriweb route) gets installed on the Detoil org. Without it, Centaur reviews cannot post.
2. The breaker thresholds above (5 percent reverts, more than 1 incident, 14 days).
3. Who writes REVIEW.md for Centaur (default: Luke).
