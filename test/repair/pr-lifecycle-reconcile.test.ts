import assert from "node:assert/strict";
import test from "node:test";
import {
  lifecycleReconciliationCandidates,
  lifecycleDiscoveryCandidates,
  lifecycleDiscoveryPage,
  reconcileLifecycleEntry,
} from "../../dist/repair/pr-lifecycle-reconcile.js";

const now = Date.parse("2026-09-22T14:00:00Z");
const sha = "a".repeat(40);
const entry = {
  repo: "valkyriweb/openclaw-claude",
  issue_number: 1,
  source_run_id: "20",
  source_run_attempt: 1,
  lifecycle_phase: "started",
  lifecycle_state: "agent:reviewing",
  expected_head_sha: sha,
  status: "executed",
  automation_source: "pi_review_lifecycle",
  processed_at: "2026-09-22T13:45:00Z",
};
function fixture(overrides = {}) {
  return {
    pull: () => ({ state: "open", head: { sha } }),
    checks: () => [],
    run: () => ({ status: "completed", conclusion: "cancelled" }),
    comments: () => [],
    intake: (event) => ({
      ...entry,
      expected_head_sha: event.head_sha,
      source_run_id: event.source_run_id,
      source_run_attempt: event.source_run_attempt,
      lifecycle_phase: event.phase,
    }),
    ...overrides,
  };
}
test("selects only newest durable nonterminal state, never old reviewing after pass", () => {
  const passed = { ...entry, source_run_id: "21", lifecycle_state: "agent:review-passed" };
  assert.deepEqual(lifecycleReconciliationCandidates([passed, entry]), []);
  assert.deepEqual(lifecycleReconciliationCandidates([entry]), [entry]);
  assert.deepEqual(lifecycleReconciliationCandidates([{ ...entry, status: "skipped" }]), []);
});
test("discovery includes terminal and unseen open PRs and retains a validated cursor", () => {
  const passed = { ...entry, lifecycle_state: "agent:review-passed" };
  const candidates = lifecycleDiscoveryCandidates(
    [
      { number: 1, state: "open" },
      { number: 2, state: "open" },
      { number: 3, state: "closed" },
    ],
    [passed],
    entry.repo,
  );
  assert.equal(candidates.length, 2);
  assert.equal(candidates[0], passed);
  assert.equal(candidates[1].source_run_id, "0");
  assert.equal(reconcileLifecycleEntry(candidates[1], fixture(), now), null);
  assert.equal(lifecycleDiscoveryPage({}, entry.repo), 1);
  assert.equal(
    lifecycleDiscoveryPage({ lifecycle_discovery_pages: { [entry.repo]: 3 } }, entry.repo),
    3,
  );
  assert.equal(
    lifecycleDiscoveryPage({ lifecycle_discovery_pages: { [entry.repo]: -1 } }, entry.repo),
    1,
  );
  assert.equal(
    lifecycleDiscoveryPage({ lifecycle_discovery_pages: { [entry.repo]: "3" } }, entry.repo),
    1,
  );
});
test("receipt selection cannot conflate equal PR numbers from different repositories", () => {
  const other = { ...entry, repo: "other/repo", source_run_id: "21" };
  assert.equal(lifecycleReconciliationCandidates([entry, other]).length, 2);
});
test("an old-head pass without a new check becomes incomplete, never repair authority", () => {
  const result = reconcileLifecycleEntry(
    { ...entry, lifecycle_state: "agent:review-passed" },
    fixture({ pull: () => ({ state: "open", head: { sha: "c".repeat(40) } }) }),
    now,
  );
  assert.equal(result.lifecycle_review.verdict, "incomplete");
  assert.match(result.reconciliation_reason, /head changed/);
});

test("cancelled source becomes a recovery-only incomplete event", () => {
  const result = reconcileLifecycleEntry(entry, fixture(), now);
  assert.equal(result.lifecycle_review.verdict, "incomplete");
  assert.equal(result.lifecycle_phase, "completed");
  assert.match(result.reconciliation_reason, /cancelled/);
  assert.match(result.idempotency_key, /:recovery$/);
  assert.deepEqual(result.actions, []);
});
test("does not mutate closed PRs or interrupt a running source", () => {
  assert.equal(
    reconcileLifecycleEntry(entry, fixture({ pull: () => ({ state: "closed" }) }), now),
    null,
  );
  assert.equal(
    reconcileLifecycleEntry(entry, fixture({ run: () => ({ status: "in_progress" }) }), now),
    null,
  );
});
test("replays missed completion through the same authoritative intake", () => {
  const marker = {
    target_repo: entry.repo,
    item_number: 1,
    head_sha: sha,
    source_run_id: "20",
    source_run_attempt: 1,
  };
  let received;
  const result = reconcileLifecycleEntry(
    entry,
    fixture({
      comments: () => [
        { id: 99, body: `<!-- pi-pr-review-lifecycle:${JSON.stringify(marker)} -->` },
      ],
      intake: (event) => {
        received = event;
        return { verified: true };
      },
    }),
    now,
  );
  assert.deepEqual(result, { verified: true });
  assert.equal(received.comment_id, "99");
  assert.equal(received.phase, "completed");
});
test("new-head review starts are rediscovered while prior repair is fixing", () => {
  const newSha = "b".repeat(40);
  let received;
  reconcileLifecycleEntry(
    { ...entry, lifecycle_state: "agent:fixing" },
    fixture({
      pull: () => ({ state: "open", head: { sha: newSha } }),
      checks: () => [
        {
          name: "pi-pr-review/verdict",
          app: { slug: "github-actions" },
          head_sha: newSha,
          external_id: "pi-pr-review:21:1",
        },
      ],
      run: () => ({ status: "in_progress" }),
      intake: (event) => {
        received = event;
        return {};
      },
    }),
    now,
  );
  assert.equal(received.head_sha, newSha);
  assert.equal(received.source_run_id, "21");
  assert.equal(received.phase, "started");
});
test("normal fixing is left alone; stalled repair never becomes permission for another repair", () => {
  assert.equal(
    reconcileLifecycleEntry({ ...entry, lifecycle_state: "agent:fixing" }, fixture(), now),
    null,
  );
  const result = reconcileLifecycleEntry(
    { ...entry, lifecycle_state: "agent:fixing", processed_at: "2026-09-22T12:00:00Z" },
    fixture(),
    now,
  );
  assert.equal(result.lifecycle_review.verdict, "incomplete");
  assert.match(result.reconciliation_reason, /90 minutes/);
});
test("expired accepted-start evidence still permits only a negative recovery", () => {
  const result = reconcileLifecycleEntry(
    entry,
    fixture({
      intake: () => {
        throw new Error("expired artifact");
      },
    }),
    now,
  );
  assert.equal(result.lifecycle_review.verdict, "incomplete");
});
test("unavailable authority evidence leaves state untouched for retry", () => {
  assert.throws(
    () =>
      reconcileLifecycleEntry(
        entry,
        fixture({
          run: () => {
            throw new Error("source unavailable");
          },
        }),
        now,
      ),
    /source unavailable/,
  );
});
