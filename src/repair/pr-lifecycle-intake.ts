import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { LooseRecord } from "./json-types.js";
import { ghJsonWithRetry, ghTextWithRetry } from "./github-cli.js";
import {
  parseLifecycleEvent,
  validateLifecycleEvidence,
  type LifecycleEvent,
} from "./pr-lifecycle.js";

/** Transport adapter for the existing router. Payloads carry identity, never authority. */
export function readLifecycleCommand(
  eventPath: string,
  targetRepo: string,
  trustedBots: Set<string>,
): LooseRecord {
  const envelope = JSON.parse(fs.readFileSync(eventPath, "utf8"));
  if (envelope.action !== "clawsweeper_review_lifecycle")
    throw new Error("unexpected lifecycle dispatch action");
  return readLifecycleCommandForEvent(
    parseLifecycleEvent(envelope.client_payload),
    targetRepo,
    trustedBots,
  );
}

export function readLifecycleCommandForEvent(
  input: LifecycleEvent,
  targetRepo: string,
  trustedBots: Set<string>,
): LooseRecord {
  const event = parseLifecycleEvent(input);
  if (event.target_repo !== targetRepo)
    throw new Error("lifecycle dispatch target does not match scoped token repository");
  const run = ghJsonWithRetry<LooseRecord>([
    "api",
    `repos/${targetRepo}/actions/runs/${event.source_run_id}/attempts/${event.source_run_attempt}`,
  ]);
  const pull = ghJsonWithRetry<LooseRecord>([
    "api",
    `repos/${targetRepo}/pulls/${event.item_number}`,
  ]);
  const artifactName = `pi-pr-review-lifecycle-${event.phase}-${event.source_run_attempt}`;
  const artifacts = ghJsonWithRetry<LooseRecord>([
    "api",
    `repos/${targetRepo}/actions/runs/${event.source_run_id}/artifacts?per_page=100`,
  ]);
  const matches = (artifacts.artifacts ?? []).filter(
    (item: LooseRecord) => item.name === artifactName && !item.expired,
  );
  if (matches.length !== 1 || matches[0].size_in_bytes > 1048576)
    throw new Error(
      "missing, ambiguous or oversized run-owned Pi lifecycle artifact; retry after upload",
    );
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-pi-lifecycle-"));
  let artifact: LooseRecord;
  try {
    ghTextWithRetry([
      "run",
      "download",
      event.source_run_id,
      "--repo",
      targetRepo,
      "--name",
      artifactName,
      "--dir",
      directory,
    ]);
    const file = path.join(directory, "lifecycle.json");
    if (fs.statSync(file).size > 32768)
      throw new Error("Pi lifecycle artifact identity exceeds 32KiB");
    artifact = JSON.parse(fs.readFileSync(file, "utf8"));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
  const comment =
    event.phase === "completed"
      ? ghJsonWithRetry<LooseRecord>([
          "api",
          `repos/${targetRepo}/issues/comments/${event.comment_id}`,
        ])
      : undefined;
  const checks =
    event.phase === "completed"
      ? ghJsonWithRetry<LooseRecord>([
          "api",
          `repos/${targetRepo}/commits/${event.head_sha}/check-runs?per_page=100`,
        ]).check_runs
      : [];
  const verified = validateLifecycleEvidence({
    event,
    targetRepo,
    run,
    pull,
    artifact,
    comment,
    checks,
    trustedAuthors: new Set([...trustedBots, "github-actions[bot]"]),
  });
  const key = `pi-review:${targetRepo}:${event.item_number}:${event.head_sha}:${event.source_run_id}:${event.source_run_attempt}:${event.phase}`;
  return {
    idempotency_key: key,
    comment_version_key: key,
    comment_id: event.comment_id ?? null,
    comment_url: comment?.html_url ?? run.html_url,
    repo: targetRepo,
    issue_number: event.item_number,
    author: comment?.user?.login ?? run.actor?.login,
    trusted_bot: true,
    automation_source: "pi_review_lifecycle",
    trigger: "trusted_bot",
    command: "pi review lifecycle",
    intent: "pi_review_lifecycle",
    expected_head_sha: event.head_sha,
    lifecycle_review: verified,
    source_run_id: event.source_run_id,
    source_run_attempt: event.source_run_attempt,
    lifecycle_phase: event.phase,
    comment_created_at: comment?.created_at ?? run.run_started_at,
    comment_updated_at: comment?.updated_at ?? run.run_started_at,
    status: "pending",
    actions: [],
  };
}
