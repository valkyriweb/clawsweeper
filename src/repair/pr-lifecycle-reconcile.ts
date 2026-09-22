import type { LooseRecord } from "./json-types.js";
import { REVIEW_CHECK_NAME, type LifecycleEvent } from "./pr-lifecycle.js";

const NONTERMINAL = new Set([
  "agent:reviewing",
  "agent:fix-requested",
  "agent:fixing",
  "agent:review-requested",
]);
const STALLED_MS = 90 * 60 * 1000;

/** The existing scheduled router owns recovery; labels are never sufficient authority. */
function latestLifecycleEntries(entries: LooseRecord[]): Map<string, LooseRecord> {
  const latest = new Map<string, LooseRecord>();
  for (const entry of entries) {
    if (
      entry.automation_source !== "pi_review_lifecycle" ||
      !["executed", "waiting"].includes(entry.status) ||
      !/^\d+$/.test(String(entry.source_run_id))
    )
      continue;
    const key = `${entry.repo}:${entry.issue_number}`;
    const prior = latest.get(key);
    if (
      !prior ||
      BigInt(entry.source_run_id) > BigInt(prior.source_run_id) ||
      (String(entry.source_run_id) === String(prior.source_run_id) &&
        (entry.source_run_attempt > prior.source_run_attempt ||
          (entry.source_run_attempt === prior.source_run_attempt &&
            Date.parse(entry.processed_at) >= Date.parse(prior.processed_at))))
    )
      latest.set(key, entry);
  }
  return latest;
}

export function lifecycleReconciliationCandidates(entries: LooseRecord[]): LooseRecord[] {
  return [...latestLifecycleEntries(entries).values()]
    .filter((entry) => NONTERMINAL.has(entry.lifecycle_state))
    .slice(-20);
}

export const LIFECYCLE_DISCOVERY_PAGE_SIZE = 20;

export function lifecycleDiscoveryPage(ledger: LooseRecord, repo: string): number {
  const page = ledger.lifecycle_discovery_pages?.[repo];
  return Number.isSafeInteger(page) && page > 0 ? page : 1;
}

/** Open-PR discovery also covers missing first receipts and terminal old heads. */
export function lifecycleDiscoveryCandidates(
  pulls: LooseRecord[],
  entries: LooseRecord[],
  repo: string,
): LooseRecord[] {
  const latest = latestLifecycleEntries(entries);
  return pulls
    .filter((pull) => pull.state === "open" && !pull.merged)
    .map(
      (pull) =>
        latest.get(`${repo}:${pull.number}`) ?? {
          repo,
          issue_number: pull.number,
          automation_source: "pi_review_lifecycle",
          source_run_id: "0",
          source_run_attempt: 0,
          lifecycle_state: "agent:reviewing",
          expected_head_sha: null,
          status: "pending",
        },
    );
}

export interface LifecycleRecoveryPorts {
  pull(number: number): LooseRecord;
  checks(sha: string): LooseRecord[];
  run(id: string, attempt: number): LooseRecord;
  comments(number: number): LooseRecord[];
  intake(event: LifecycleEvent): LooseRecord;
}

export function reconcileLifecycleEntry(
  entry: LooseRecord,
  ports: LifecycleRecoveryPorts,
  now = Date.now(),
): LooseRecord | null {
  const pull = ports.pull(entry.issue_number);
  if (pull.state !== "open" || pull.merged || !/^[a-f0-9]{40}$/.test(pull.head?.sha ?? ""))
    return null;
  const checks = ports
    .checks(pull.head.sha)
    .filter(
      (check) =>
        check.name === REVIEW_CHECK_NAME &&
        check.app?.slug === "github-actions" &&
        check.head_sha === pull.head.sha &&
        /^pi-pr-review:[1-9]\d*:[1-9]\d*$/.test(check.external_id ?? ""),
    );
  checks.sort((a, b) => {
    const aa = a.external_id.split(":");
    const bb = b.external_id.split(":");
    return BigInt(aa[1]) === BigInt(bb[1])
      ? Number(bb[2]) - Number(aa[2])
      : BigInt(aa[1]) > BigInt(bb[1])
        ? -1
        : 1;
  });
  const check = checks[0];
  if (!check && entry.source_run_id === "0") return null;
  if (!check && pull.head.sha !== entry.expected_head_sha) {
    return incomplete(
      entry,
      pull.head.sha,
      "PR head changed without a current native review; request a new review",
    );
  }
  const [, runId, attempt] = check?.external_id.split(":") ?? [];
  const isNewReview =
    runId &&
    (BigInt(runId) > BigInt(entry.source_run_id) ||
      (runId === String(entry.source_run_id) && Number(attempt) > entry.source_run_attempt) ||
      pull.head.sha !== entry.expected_head_sha);
  if (!isNewReview && !NONTERMINAL.has(entry.lifecycle_state)) return null;
  // Waiting means the job was written but not dispatched. Replay verified completion
  // after publication; only an actually dispatched repair should wait for a new head.
  if (!isNewReview && entry.lifecycle_state !== "agent:reviewing" && entry.status !== "waiting") {
    return now - Date.parse(entry.processed_at) >= STALLED_MS
      ? incomplete(
          entry,
          pull.head.sha,
          "Repair did not reach a fresh review within 90 minutes; inspect worker and explicitly resume",
        )
      : null;
  }
  const identity: LifecycleEvent = {
    target_repo: entry.repo,
    item_number: entry.issue_number,
    head_sha: pull.head.sha,
    source_run_id: runId ?? String(entry.source_run_id),
    source_run_attempt: attempt ? Number(attempt) : entry.source_run_attempt,
    phase: "started",
  };
  const run = ports.run(identity.source_run_id, identity.source_run_attempt);
  if (run.status !== "completed") {
    if (isNewReview) return ports.intake(identity);
    return null;
  }
  // Comments are lookup hints only: intake verifies source artifact, author and SHA-bound check.
  const comment = ports.comments(entry.issue_number).find((candidate) => {
    const matches = [
      ...String(candidate.body ?? "").matchAll(/<!-- pi-pr-review-lifecycle:(\{[^\n]*\}) -->/g),
    ];
    if (matches.length !== 1) return false;
    try {
      const marker = JSON.parse(matches[0]![1]!);
      return (
        marker.target_repo === identity.target_repo &&
        marker.item_number === identity.item_number &&
        marker.head_sha === identity.head_sha &&
        String(marker.source_run_id) === identity.source_run_id &&
        marker.source_run_attempt === identity.source_run_attempt
      );
    } catch {
      return false;
    }
  });
  if (comment) {
    try {
      return ports.intake({ ...identity, phase: "completed", comment_id: String(comment.id) });
    } catch {
      /* A broken publication cannot authorize repair; validate its trusted start below. */
    }
  }
  // Validate the run-owned start before creating a recovery-only negative outcome.
  let verified: LooseRecord;
  try {
    verified = ports.intake(identity);
  } catch (error) {
    // The ledger already accepted this exact start. Expired artifacts/base drift may
    // prevent replay, but cannot turn its missing completion into a successful review.
    if (
      identity.source_run_id !== String(entry.source_run_id) ||
      identity.source_run_attempt !== entry.source_run_attempt ||
      identity.head_sha !== entry.expected_head_sha
    )
      throw error;
    verified = entry;
  }
  return incomplete(
    verified,
    pull.head.sha,
    `Review run ended (${run.conclusion ?? "unknown"}) without valid completion publication; inspect evidence and rerun the review`,
  );
}

function incomplete(entry: LooseRecord, headSha: string, reason: string): LooseRecord {
  const key = `pi-review:${entry.repo}:${entry.issue_number}:${headSha}:${entry.source_run_id}:${entry.source_run_attempt}:recovery`;
  return {
    ...entry,
    idempotency_key: key,
    comment_version_key: key,
    expected_head_sha: headSha,
    lifecycle_phase: "completed",
    lifecycle_review: { phase: "completed", verdict: "incomplete", reviewText: "" },
    lifecycle_state: undefined,
    status: "pending",
    actions: [],
    reconciliation_reason: reason,
  };
}
