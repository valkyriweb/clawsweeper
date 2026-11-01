#!/usr/bin/env node
import { createHash } from "node:crypto";
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { issueTriageIntakeBlockReason, repositoryProfileFor } from "../repository-profiles.js";
import { repairLoopPauseLabels } from "./comment-router-core.js";
import { ghJson, ghPagedWorkflowRuns, ghSpawn } from "./github-cli.js";
import { asJsonObject, type JsonObject, type JsonValue } from "./json-types.js";
import { parseArgs } from "./lib.js";
import { ACTIVE_WORKFLOW_STATUSES, normalizeWorkflowRun } from "./live-worker-capacity.js";
import { normalizeGithubActivity, type GithubActivity } from "./notify-github-activity.js";
import { stringOrNull } from "./openclaw-hook.js";
import { currentProjectRepo } from "./project-repo.js";
import { sleepMs } from "./timing.js";

/**
 * Connects normalized external issue activity to the existing exact-item review
 * (the `clawsweeper_repair_item` receiver in sweep.yml). The profile flag
 * `issue_triage_intake` is the only authority; issue text is data and never
 * widens it. Holds are read from live labels, so a stale event cannot restart
 * held work. Queueing, capacity and review remain owned by sweep.yml.
 */

export const ISSUE_TRIAGE_ACTIONS: ReadonlySet<string> = new Set(["opened", "reopened"]);
export const TRIAGE_WORKFLOW = "sweep.yml";
// GitHub's workflow-run listing can lag a just-created run by 30s or more (runs
// 40026807584, 40034183676 and 40034204116 gave up after 30s while the review run
// already existed). Poll quickly first, then back off, for about two minutes.
export const VISIBLE_POLL_DELAYS_MS: readonly number[] = [
  5000, 5000, 5000, 10000, 10000, 15000, 15000, 20000, 20000, 20000,
];
// Never triage events that ClawSweeper's own bot caused; that would loop.
const OWN_AUTOMATION_ACTOR = /clawsweeper(\[bot\])?$/i;

export type TriageAdmission =
  | {
      admit: true;
      reason: string;
      targetRepo: string;
      itemNumber: number;
      sourceAction: string;
      idempotencyKey: string;
    }
  | { admit: false; reason: string };

export function admitIssueTriageActivity(activity: GithubActivity | null): TriageAdmission {
  if (!activity) return skip("not a normalizable GitHub activity");
  if (activity.type !== "issues") return skip(`${activity.type} is not an issue event`);
  const action = activity.action ?? "";
  if (!ISSUE_TRIAGE_ACTIONS.has(action)) {
    return skip(`issues.${action || "none"} does not start triage`);
  }
  const { kind, number, state } = activity.subject;
  if (kind !== "issue" || number === null) return skip("subject is not a numbered issue");
  if (state !== "open") return skip(`issue state is ${state ?? "unknown"}`);
  if (activity.actor && OWN_AUTOMATION_ACTOR.test(activity.actor)) {
    return skip("event was caused by ClawSweeper automation");
  }
  const blocked = issueTriageIntakeBlockReason(activity.repo);
  if (blocked) return skip(blocked);
  const idempotencyKey = stableIssueTriageEventKey(activity);
  if (!idempotencyKey) return skip("issue event has no stable replay identity");
  return {
    admit: true,
    reason: `issues.${action} admitted by profile issue_triage_intake`,
    targetRepo: repositoryProfileFor(activity.repo).targetRepo,
    itemNumber: number,
    sourceAction: action,
    idempotencyKey,
  };
}

/** The normalized identity must come from a stable delivery or issue-event value. */
export function stableIssueTriageEventKey(activity: GithubActivity): string | null {
  if (activity.type !== "issues") return null;
  const payload = activity.payload;
  const issue = asJsonObject(payload.issue);
  const hasStableSource = [
    payload.idempotencyKey,
    payload.idempotency_key,
    payload.delivery_id,
    payload.updated_at,
    issue.updated_at,
  ].some((value) => Boolean(stringOrNull(value)));
  const hasConcurrencySeed = [payload.delivery_id, payload.updated_at, issue.updated_at].some(
    (value) => Boolean(stringOrNull(value)),
  );
  return hasStableSource && hasConcurrencySeed && isSafeIdempotencyKey(activity.idempotencyKey)
    ? activity.idempotencyKey
    : null;
}

function isSafeIdempotencyKey(value: string): boolean {
  if (value.length === 0 || value.length > 512 || value.trim() !== value) return false;
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

export function triageReceiptId(idempotencyKey: string): string {
  if (!isSafeIdempotencyKey(idempotencyKey)) {
    throw new Error("issue event idempotency key is missing or unsafe");
  }
  return createHash("sha256").update(idempotencyKey, "utf8").digest("hex");
}

/** Block reason from the live issue, or null when triage may proceed. */
export function liveIssueTriageBlock(issue: JsonValue): string | null {
  const record = asJsonObject(issue);
  if (record.pull_request) return "item is a pull request";
  if (record.state !== "open") return `live issue state is ${record.state ?? "unknown"}`;
  if (record.locked === true) return "live issue is locked";
  const labels = Array.isArray(record.labels)
    ? record.labels.map((label: JsonValue) => String(asJsonObject(label).name ?? label))
    : [];
  const held = repairLoopPauseLabels(labels);
  return held.length > 0 ? `held by label ${held.join(", ")}` : null;
}

export function eventReviewRunTitle(
  targetRepo: string,
  itemNumber: number,
  receiptId?: string,
): string {
  const base = `Review event item ${targetRepo}#${itemNumber}`;
  if (receiptId === undefined) return base;
  if (!/^[a-f0-9]{64}$/.test(receiptId)) throw new Error("invalid issue event receipt id");
  return `${base} [r:${receiptId}]`;
}

export type TriageDispatchDeps = {
  readIssue: (targetRepo: string, itemNumber: number) => JsonValue;
  /** All currently API-visible workflow-run pages, used for replay detection. */
  listWorkflowRuns: () => JsonValue[];
  /** Recent run page only, used to confirm a just-sent dispatch cheaply. */
  listRecentWorkflowRuns: () => JsonValue[];
  dispatch: (
    targetRepo: string,
    itemNumber: number,
    sourceAction: string,
    idempotencyKey: string,
    receiptId: string,
  ) => void;
  sleep?: (milliseconds: number) => void;
};

export type TriageDispatchResult = {
  status: "dispatched" | "unconfirmed" | "skipped";
  reason: string;
};

export function dispatchIssueTriage(
  input: {
    targetRepo: string;
    itemNumber: number;
    sourceAction: string;
    idempotencyKey: string;
  },
  deps: TriageDispatchDeps,
): TriageDispatchResult {
  const { targetRepo, itemNumber, sourceAction, idempotencyKey } = input;
  if (!isSafeIdempotencyKey(idempotencyKey)) {
    return { status: "skipped", reason: "issue event has no safe replay identity" };
  }
  const receiptId = triageReceiptId(idempotencyKey);
  const recheck = issueTriageIntakeBlockReason(targetRepo);
  if (recheck) return { status: "skipped", reason: recheck };
  const liveBlock = liveIssueTriageBlock(deps.readIssue(targetRepo, itemNumber));
  if (liveBlock) return { status: "skipped", reason: liveBlock };
  const prior = matchingEventReview(deps.listWorkflowRuns(), targetRepo, itemNumber, receiptId);
  if (prior) return { status: "skipped", reason: `event receipt already exists (${prior})` };

  deps.dispatch(targetRepo, itemNumber, sourceAction, idempotencyKey, receiptId);
  // Confirm only against the newest page. The full-history scan above is needed
  // for old receipts; repeating it during polling would multiply API cost.
  const sleep = deps.sleep ?? sleepMs;
  for (const delayMs of VISIBLE_POLL_DELAYS_MS) {
    sleep(delayMs);
    if (matchingEventReview(deps.listRecentWorkflowRuns(), targetRepo, itemNumber, receiptId)) {
      return { status: "dispatched", reason: "exact-item receipt dispatched and observed" };
    }
  }
  return {
    status: "unconfirmed",
    reason: "dispatch sent but receipt run is not visible; a replay may retry if history lags",
  };
}

function matchingEventReview(
  runs: JsonValue[],
  targetRepo: string,
  itemNumber: number,
  receiptId: string,
): string | null {
  const expected = eventReviewRunTitle(targetRepo, itemNumber, receiptId).toLowerCase();
  for (const value of runs) {
    const raw = asJsonObject(value);
    const normalized = normalizeWorkflowRun(raw, String(raw.status ?? ""));
    if (stringOrNull(normalized.displayTitle)?.toLowerCase() !== expected) continue;
    if (!workflowRunCountsAsReceipt(normalized.status, normalized.conclusion)) continue;
    return String(normalized.url ?? normalized.databaseId ?? "unknown run");
  }
  return null;
}

function workflowRunCountsAsReceipt(statusValue: JsonValue, conclusionValue: JsonValue): boolean {
  const status = stringOrNull(statusValue)?.toLowerCase() ?? null;
  const conclusion = stringOrNull(conclusionValue)?.toLowerCase() ?? null;
  if (status && ACTIVE_WORKFLOW_STATUSES.includes(status)) return true;
  if (status !== "completed") {
    throw new Error(`workflow run receipt has an unknown status: ${status ?? "missing"}`);
  }
  if (conclusion === "success" || conclusion === "neutral") return true;
  if (
    conclusion === "failure" ||
    conclusion === "cancelled" ||
    conclusion === "timed_out" ||
    conclusion === "startup_failure" ||
    conclusion === "skipped" ||
    conclusion === "action_required" ||
    conclusion === "stale"
  ) {
    return false;
  }
  throw new Error(`workflow run receipt has an unknown conclusion: ${conclusion ?? "missing"}`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = String(args._[0] ?? "");
  if (command === "admit") admit(args);
  else if (command === "dispatch") dispatch(args);
  else die(`unknown command: ${command || "(none)"} (expected admit or dispatch)`);
}

function admit(args: JsonObject) {
  const eventPath = stringArg(args, "input") || process.env.GITHUB_EVENT_PATH || "";
  const admission: TriageAdmission =
    eventPath && fs.existsSync(eventPath)
      ? admitIssueTriageActivity(
          normalizeGithubActivity({
            eventName: "repository_dispatch",
            payload: JSON.parse(fs.readFileSync(eventPath, "utf8")),
          }),
        )
      : skip("GitHub event payload missing");
  writeStepOutputs(
    admission.admit
      ? {
          admit: "true",
          target_repo: admission.targetRepo,
          item_number: String(admission.itemNumber),
          source_action: admission.sourceAction,
          idempotency_key: admission.idempotencyKey,
        }
      : { admit: "false" },
  );
  console.log(JSON.stringify(admission));
}

function dispatch(args: JsonObject) {
  const targetRepo = stringArg(args, "target-repo");
  const itemNumber = Number(stringArg(args, "item-number"));
  const sourceAction = stringArg(args, "source-action");
  const idempotencyKey = stringArg(args, "idempotency-key");
  if (!Number.isInteger(itemNumber) || itemNumber <= 0) die(`invalid item number: ${itemNumber}`);
  if (!ISSUE_TRIAGE_ACTIONS.has(sourceAction)) die(`invalid source action: ${sourceAction}`);
  if (!isSafeIdempotencyKey(idempotencyKey)) die("stable issue event idempotency key is required");
  const engineRepo = currentProjectRepo();
  // GH_TOKEN (target read token) reads the issue; the engine dispatch token lists
  // and dispatches engine workflows. They are never interchanged.
  const dispatchEnv = { GH_TOKEN: process.env.CLAWSWEEPER_DISPATCH_TOKEN?.trim() ?? "" };
  if (!dispatchEnv.GH_TOKEN) die("CLAWSWEEPER_DISPATCH_TOKEN is required");
  const workflowRunsPath = `repos/${engineRepo}/actions/workflows/${encodeURIComponent(TRIAGE_WORKFLOW)}/runs`;
  const result = dispatchIssueTriage(
    { targetRepo, itemNumber, sourceAction, idempotencyKey },
    {
      readIssue: (repo, number) => ghJson(["api", `repos/${repo}/issues/${number}`]),
      listWorkflowRuns: () => ghPagedWorkflowRuns(workflowRunsPath, { env: dispatchEnv }),
      listRecentWorkflowRuns: () => {
        const runs = ghJson<JsonValue>(
          ["api", `${workflowRunsPath}?per_page=100`, "--jq", ".workflow_runs"],
          { env: dispatchEnv },
        );
        if (!Array.isArray(runs)) throw new Error("recent workflow run response is not an array");
        return runs;
      },
      dispatch: (repo, number, action, key, receiptId) => {
        const response = ghSpawn(
          ["api", `repos/${engineRepo}/dispatches`, "--method", "POST", "--input", "-"],
          {
            env: dispatchEnv,
            input: JSON.stringify({
              event_type: "clawsweeper_repair_item",
              client_payload: {
                target_repo: repo,
                item_number: String(number),
                item_kind: "issue",
                source_event: "issues",
                source_action: action,
                idempotency_key: key,
                idempotency_receipt: receiptId,
              },
            }),
          },
        );
        if (response.status !== 0) {
          die(`dispatch failed: ${(response.stderr || response.stdout).trim()}`);
        }
      },
    },
  );
  console.log(JSON.stringify(result));
  // An unobserved dispatch must be visible in the run, not reported as success.
  if (result.status === "unconfirmed") process.exitCode = 1;
}

function skip(reason: string): TriageAdmission {
  return { admit: false, reason };
}

function stringArg(args: JsonObject, key: string): string {
  return String(args[key] ?? "");
}

function writeStepOutputs(values: Record<string, string>) {
  const output = process.env.GITHUB_OUTPUT;
  if (!output) return;
  fs.appendFileSync(
    output,
    `${Object.entries(values)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n")}\n`,
  );
}

function die(message: string): never {
  console.error(message);
  process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
