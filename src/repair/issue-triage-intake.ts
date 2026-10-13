#!/usr/bin/env node
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { issueTriageIntakeBlockReason, repositoryProfileFor } from "../repository-profiles.js";
import { repairLoopPauseLabels } from "./comment-router-core.js";
import { ghJson, ghSpawn } from "./github-cli.js";
import { asJsonObject, type JsonObject, type JsonValue } from "./json-types.js";
import { parseArgs } from "./lib.js";
import {
  ACTIVE_WORKFLOW_STATUSES,
  listActiveWorkflowRuns,
  normalizeWorkflowRun,
} from "./live-worker-capacity.js";
import { normalizeGithubActivity, type GithubActivity } from "./notify-github-activity.js";
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
const VISIBLE_POLL_ATTEMPTS = 6;
const VISIBLE_POLL_MS = 5000;
// Never triage events that ClawSweeper's own bot caused; that would loop.
const OWN_AUTOMATION_ACTOR = /clawsweeper(\[bot\])?$/i;

export type TriageAdmission =
  | { admit: true; reason: string; targetRepo: string; itemNumber: number; sourceAction: string }
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
  return {
    admit: true,
    reason: `issues.${action} admitted by profile issue_triage_intake`,
    targetRepo: repositoryProfileFor(activity.repo).targetRepo,
    itemNumber: number,
    sourceAction: action,
  };
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

export function eventReviewRunTitle(targetRepo: string, itemNumber: number): string {
  return `Review event item ${targetRepo}#${itemNumber}`;
}

export type TriageDispatchDeps = {
  readIssue: (targetRepo: string, itemNumber: number) => JsonValue;
  listActiveRuns: () => JsonValue[];
  /** Recently finished event reviews; lets a replayed `opened` event see prior triage. */
  listCompletedRuns?: () => JsonValue[];
  dispatch: (targetRepo: string, itemNumber: number, sourceAction: string) => void;
  sleep?: (milliseconds: number) => void;
};

export type TriageDispatchResult = {
  status: "dispatched" | "unconfirmed" | "skipped";
  reason: string;
};

export function dispatchIssueTriage(
  input: { targetRepo: string; itemNumber: number; sourceAction: string },
  deps: TriageDispatchDeps,
): TriageDispatchResult {
  const { targetRepo, itemNumber, sourceAction } = input;
  const recheck = issueTriageIntakeBlockReason(targetRepo);
  if (recheck) return { status: "skipped", reason: recheck };
  const liveBlock = liveIssueTriageBlock(deps.readIssue(targetRepo, itemNumber));
  if (liveBlock) return { status: "skipped", reason: liveBlock };
  const active = activeEventReview(deps.listActiveRuns(), targetRepo, itemNumber);
  if (active) {
    return { status: "skipped", reason: `event review already active (${active})` };
  }
  // `opened` happens once per issue, so a finished review for it means this event
  // is a replay. `reopened` can legitimately repeat, so only active runs dedupe it.
  if (sourceAction === "opened" && deps.listCompletedRuns) {
    const done = activeEventReview(deps.listCompletedRuns(), targetRepo, itemNumber);
    if (done) return { status: "skipped", reason: `event review already ran (${done})` };
  }
  deps.dispatch(targetRepo, itemNumber, sourceAction);
  // The next serialized intake must see this run, or it would dispatch again and
  // sweep.yml would cancel the first review.
  const sleep = deps.sleep ?? sleepMs;
  for (let attempt = 0; attempt < VISIBLE_POLL_ATTEMPTS; attempt += 1) {
    if (activeEventReview(deps.listActiveRuns(), targetRepo, itemNumber)) {
      return { status: "dispatched", reason: "exact-item review dispatched and observed" };
    }
    sleep(VISIBLE_POLL_MS);
  }
  return {
    status: "unconfirmed",
    reason: "dispatch sent but no event review run became visible; a replay may dispatch again",
  };
}

function activeEventReview(runs: JsonValue[], targetRepo: string, itemNumber: number) {
  const expected = eventReviewRunTitle(targetRepo, itemNumber).toLowerCase();
  const match = runs.find(
    (run: JsonValue) => String(run.displayTitle ?? "").toLowerCase() === expected,
  );
  return match ? String(match.url ?? match.databaseId ?? "unknown run") : null;
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
        }
      : { admit: "false" },
  );
  console.log(JSON.stringify(admission));
}

function dispatch(args: JsonObject) {
  const targetRepo = stringArg(args, "target-repo");
  const itemNumber = Number(stringArg(args, "item-number"));
  const sourceAction = stringArg(args, "source-action");
  if (!Number.isInteger(itemNumber) || itemNumber <= 0) die(`invalid item number: ${itemNumber}`);
  if (!ISSUE_TRIAGE_ACTIONS.has(sourceAction)) die(`invalid source action: ${sourceAction}`);
  const engineRepo = currentProjectRepo();
  // GH_TOKEN (target read token) reads the issue; the engine dispatch token lists
  // and dispatches engine workflows. They are never interchanged.
  const dispatchEnv = { GH_TOKEN: process.env.CLAWSWEEPER_DISPATCH_TOKEN?.trim() ?? "" };
  if (!dispatchEnv.GH_TOKEN) die("CLAWSWEEPER_DISPATCH_TOKEN is required");
  const result = dispatchIssueTriage(
    { targetRepo, itemNumber, sourceAction },
    {
      readIssue: (repo, number) => ghJson(["api", `repos/${repo}/issues/${number}`]),
      listCompletedRuns: () =>
        normalizeCompletedRuns(fetchRuns(engineRepo, dispatchEnv, ["completed"])),
      listActiveRuns: () =>
        listActiveWorkflowRuns({
          repo: engineRepo,
          workflow: TRIAGE_WORKFLOW,
          runNamePrefix: "Review event item ",
          fetchWorkflowRuns: () => fetchRuns(engineRepo, dispatchEnv, ACTIVE_WORKFLOW_STATUSES),
        }),
      dispatch: (repo, number, action) => {
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

/**
 * Raw REST `.workflow_runs` use snake_case (display_title, html_url, id). Normalize
 * them exactly as listActiveWorkflowRuns does so completed and active runs match
 * on the same fields. Only the most recent 100 completed runs are visible.
 */
export function normalizeCompletedRuns(runs: JsonValue[]): JsonValue[] {
  return runs.map((run: JsonValue) => normalizeWorkflowRun(asJsonObject(run), "completed"));
}

function fetchRuns(
  engineRepo: string,
  env: NodeJS.ProcessEnv,
  statuses: readonly string[],
): JsonValue[] {
  return statuses.flatMap((status) => {
    const runs = ghJson(
      [
        "api",
        "--method",
        "GET",
        `repos/${engineRepo}/actions/workflows/${TRIAGE_WORKFLOW}/runs?per_page=100&status=${status}`,
        "--jq",
        ".workflow_runs",
      ],
      { env },
    );
    return Array.isArray(runs) ? runs : [];
  });
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
