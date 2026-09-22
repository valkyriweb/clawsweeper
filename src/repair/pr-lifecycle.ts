import { matchesGlob } from "node:path";
import { Either, Schema, flow } from "effect";
import type { LooseRecord } from "./json-types.js";

export const TECHNICAL_LABELS = [
  "agent:review-requested",
  "agent:reviewing",
  "agent:fix-requested",
  "agent:fixing",
  "agent:review-passed",
] as const;
export type TechnicalState = (typeof TECHNICAL_LABELS)[number] | "clawsweeper:human-review";
export type ReviewVerdict = "pass" | "fail" | "incomplete";
export type ReviewClassification = "actionable" | "advisory" | "environment" | "unknown";
export interface LifecycleEvent {
  target_repo: string;
  item_number: number;
  head_sha: string;
  source_run_id: string;
  source_run_attempt: number;
  phase: "started" | "completed";
  comment_id?: string;
}
const MARKER = /<!-- pi-pr-review-lifecycle:(\{[^\n]*\}) -->/g;
export const REVIEW_CHECK_NAME = "pi-pr-review/verdict";

const PositiveInteger = Schema.Number.pipe(Schema.filter((n) => Number.isSafeInteger(n) && n > 0));
const DecimalId = Schema.String.pipe(Schema.pattern(/^[1-9]\d*$/));
const Sha = Schema.String.pipe(Schema.pattern(/^[a-f0-9]{40}$/));
const identityFields = {
  target_repo: Schema.String.pipe(Schema.pattern(/^[\w.-]+\/[\w.-]+$/)),
  item_number: PositiveInteger,
  head_sha: Sha,
  source_run_id: DecimalId,
  source_run_attempt: PositiveInteger,
};
const LifecycleEventSchema = Schema.Union(
  Schema.Struct({
    ...identityFields,
    phase: Schema.Literal("started"),
    comment_id: Schema.optionalWith(Schema.String, { exact: true }),
  }),
  Schema.Struct({ ...identityFields, phase: Schema.Literal("completed"), comment_id: DecimalId }),
);
export const parseLifecycleEvent = flow(
  Schema.decodeUnknownEither(LifecycleEventSchema),
  Either.getOrThrowWith(
    () =>
      new Error(
        "invalid Pi lifecycle identity; require repo, PR, full head SHA, run, attempt, phase and completion comment",
      ),
  ),
);
const MarkerSchema = Schema.Struct({
  ...identityFields,
  version: Schema.Literal(1),
  source_run_id: Schema.Union(DecimalId, PositiveInteger),
  verdict: Schema.Literal("pass", "fail", "incomplete"),
});

const RunPullRefSchema = Schema.Struct({
  ref: Schema.String.pipe(Schema.minLength(1)),
  sha: Sha,
  repo: Schema.Struct({
    id: PositiveInteger,
    name: Schema.String.pipe(Schema.minLength(1)),
    url: Schema.String.pipe(Schema.minLength(1)),
  }),
});
/** Exactly one association: absent, malformed, extra or conflicting entries decode to Left. */
const RunPullRequestsSchema = Schema.Tuple(
  Schema.Struct({ number: PositiveInteger, base: RunPullRefSchema, head: RunPullRefSchema }),
);

/**
 * Native `pull_request_target` runs report the candidate head SHA rather than the base SHA.
 * Such a run is trusted only through GitHub's own run→PR association binding this PR, this
 * repository on both sides, the PR's current `main` base SHA and the reviewed candidate head.
 */
function runBindsReviewedCandidateHead(run: LooseRecord, pull: LooseRecord, event: LifecycleEvent) {
  const decoded = Schema.decodeUnknownEither(RunPullRequestsSchema)(run.pull_requests);
  if (Either.isLeft(decoded)) return false;
  const [association] = decoded.right;
  const repoUrl = `https://api.github.com/repos/${event.target_repo}`;
  const repoName = event.target_repo.split("/")[1];
  return (
    run.head_sha === event.head_sha &&
    association.number === event.item_number &&
    association.base.ref === "main" &&
    association.base.sha === pull.base?.sha &&
    association.head.sha === event.head_sha &&
    [association.base.repo, association.head.repo].every(
      (repo) =>
        repo.url === repoUrl && repo.name === repoName && repo.id === association.base.repo.id,
    )
  );
}

function sameIdentity(value: LooseRecord, event: LifecycleEvent) {
  return (
    value.version === 1 &&
    value.target_repo === event.target_repo &&
    value.item_number === event.item_number &&
    value.head_sha === event.head_sha &&
    String(value.source_run_id) === event.source_run_id &&
    value.source_run_attempt === event.source_run_attempt
  );
}

export function validateLifecycleEvidence({
  event: input,
  targetRepo,
  pull,
  run,
  artifact,
  comment,
  checks = [],
  trustedAuthors,
}: {
  event: unknown;
  targetRepo: string;
  pull: LooseRecord;
  run: LooseRecord;
  artifact?: LooseRecord;
  comment?: LooseRecord;
  checks?: LooseRecord[];
  trustedAuthors: Set<string>;
}): LifecycleEvent & { verdict?: ReviewVerdict; reviewText: string } {
  const event = parseLifecycleEvent(input);
  if (
    event.target_repo !== targetRepo ||
    pull.number !== event.item_number ||
    pull.state !== "open"
  )
    throw new Error("Pi lifecycle requires matching open PR");
  if (pull.head?.sha !== event.head_sha) throw new Error("Pi lifecycle targets stale PR head SHA");
  if (
    pull.base?.ref !== "main" ||
    pull.base?.repo?.full_name !== targetRepo ||
    !Schema.is(Sha)(pull.base?.sha) ||
    (run.head_sha !== pull.base.sha && !runBindsReviewedCandidateHead(run, pull, event))
  ) {
    throw new Error(
      "Pi lifecycle requires trusted current main base workflow, by base-SHA run or run-owned PR association; merge current main into PR branch and push after base drift",
    );
  }
  if (
    String(run.id) !== event.source_run_id ||
    run.run_attempt !== event.source_run_attempt ||
    run.repository?.full_name !== targetRepo ||
    run.path !== ".github/workflows/pi-pr-review.yml" ||
    run.event !== "pull_request_target" ||
    !["in_progress", "completed"].includes(run.status)
  ) {
    throw new Error("Pi lifecycle source run/workflow/event is not trusted");
  }
  const boundArtifact = artifact && sameIdentity(artifact, event) && artifact.phase === event.phase;
  if (!boundArtifact)
    throw new Error(
      "source run is not bound to reviewed PR head; require matching run-owned lifecycle artifact",
    );
  if (event.phase === "started") return { ...event, reviewText: "" };
  if (
    !comment ||
    String(comment.id) !== event.comment_id ||
    comment.issue_url !==
      `https://api.github.com/repos/${targetRepo}/issues/${event.item_number}` ||
    !trustedAuthors.has(String(comment.user?.login ?? "").toLowerCase()) ||
    comment.created_at !== comment.updated_at ||
    !(Date.parse(comment.created_at) >= Date.parse(run.run_started_at))
  )
    throw new Error(
      "Pi lifecycle completion comment is untrusted, edited or belongs to another run/PR",
    );
  const body = String(comment.body ?? "");
  if (body.length > 30000) throw new Error("Pi lifecycle review exceeds bounded evidence size");
  const markers = [...body.matchAll(MARKER)];
  if (markers.length !== 1) throw new Error("Pi lifecycle requires exactly one structured marker");
  const decodedMarker = Schema.decodeUnknownEither(MarkerSchema)(JSON.parse(markers[0]![1]!));
  if (Either.isLeft(decodedMarker))
    throw new Error("Pi lifecycle marker identity or verdict mismatch");
  const marker = decodedMarker.right;
  if (!sameIdentity(marker, event))
    throw new Error("Pi lifecycle marker identity or verdict mismatch");
  if (
    artifact &&
    (artifact.verdict !== marker.verdict || String(artifact.comment_id) !== event.comment_id)
  )
    throw new Error("Pi lifecycle artifact/comment mismatch");
  const conclusion = { pass: "success", fail: "failure", incomplete: "failure" }[marker.verdict];
  if (
    !checks.some(
      (check) =>
        check.name === REVIEW_CHECK_NAME &&
        check.head_sha === event.head_sha &&
        check.app?.slug === "github-actions" &&
        check.status === "completed" &&
        check.conclusion === conclusion &&
        check.external_id === `pi-pr-review:${event.source_run_id}:${event.source_run_attempt}` &&
        check.details_url ===
          `https://github.com/${targetRepo}/actions/runs/${event.source_run_id}/attempts/${event.source_run_attempt}`,
    )
  )
    throw new Error("Pi lifecycle verdict has no matching SHA/run-bound technical check");
  const reviewText = body.replace(MARKER, "").trim();
  if (reviewText.length > 24000)
    throw new Error("Pi lifecycle review evidence exceeds 24000 characters; require human review");
  return { ...event, verdict: marker.verdict, reviewText };
}

export function assertLifecycleRepairTarget(
  pull: LooseRecord,
  expectedSha: string,
  expectedNumber: number,
) {
  const labels = (pull.labels ?? []).map((label: LooseRecord | string) =>
    Schema.is(Schema.String)(label) ? label : label.name,
  );
  if (
    !/^[a-f0-9]{40}$/.test(expectedSha) ||
    !Number.isSafeInteger(expectedNumber) ||
    expectedNumber <= 0 ||
    pull.number !== expectedNumber ||
    pull.state !== "open" ||
    pull.head?.sha !== expectedSha ||
    labels.includes("clawsweeper:human-review") ||
    !labels.includes("clawsweeper:autofix")
  ) {
    throw new Error("lifecycle repair target changed or lost authorization; refusing repair/push");
  }
}

export function lifecycleDecision({
  phase,
  verdict,
  authorized,
  sensitive,
  paused,
  classification,
}: {
  phase: "started" | "completed";
  verdict?: ReviewVerdict;
  authorized: boolean;
  sensitive: boolean;
  paused: boolean;
  classification?: ReviewClassification;
}): TechnicalState {
  if (paused || sensitive) return "clawsweeper:human-review";
  if (phase === "started") return "agent:reviewing";
  if (verdict === "pass") return "agent:review-passed";
  if (verdict === "fail" && authorized && classification === "actionable")
    return "agent:fix-requested";
  return "clawsweeper:human-review";
}

export function technicalLabelTransition(labels: string[], state: TechnicalState) {
  return {
    add: state,
    remove: labels.filter(
      (label) => TECHNICAL_LABELS.some((technical) => technical === label) && label !== state,
    ),
  };
}

export function lifecycleSensitiveFiles(files: unknown[]): boolean {
  if (!Array.isArray(files) || files.length === 0) return true;
  return files.some((file) =>
    filePaths(file).some(
      (name) =>
        !safePath(name) ||
        /(^|\/)(\.github|\.agents|\.claude|\.pi|docker|services|plugins|infra|k3s|config|state)(\/|$)|(^|\/)(AGENTS\.md|CLAUDE\.md|SKILL\.md|TOOLS\.md|CONTEXT\.md|Dockerfile[^/]*|\.env(?:\..*)?|[^/]*\.(?:pem|key))$|(^|\/)(auth|security|secrets?|credentials)(\/|\.)/i.test(
          name,
        ),
    ),
  );
}

const FileRecordSchema = Schema.Struct({
  path: Schema.optional(Schema.NullOr(Schema.String)),
  filename: Schema.optional(Schema.String),
  previous_filename: Schema.optional(Schema.String),
  status: Schema.optional(
    Schema.Literal("added", "removed", "modified", "renamed", "copied", "changed", "unchanged"),
  ),
}).pipe(
  Schema.filter(
    (file) =>
      !["renamed", "copied"].includes(file.status ?? "") || file.previous_filename !== undefined,
  ),
);
const filePaths = flow(
  Schema.decodeUnknownEither(Schema.Union(Schema.String, FileRecordSchema)),
  Either.match({
    onLeft: () => [""],
    onRight: (file): string[] =>
      Schema.is(Schema.String)(file)
        ? [file]
        : [
            file.path ?? file.filename ?? "",
            ...(file.path !== undefined && file.path !== null && file.filename !== undefined
              ? [file.filename]
              : []),
            ...(file.previous_filename === undefined ? [] : [file.previous_filename]),
          ],
  }),
);
const safePath = Schema.is(
  Schema.String.pipe(
    Schema.filter(
      (name) =>
        name.length > 0 &&
        !name.startsWith("/") &&
        !name.includes("..") &&
        !name.includes(String.fromCharCode(92)),
    ),
  ),
);

export function repairPathsAllowed(
  files: unknown[],
  patterns: readonly string[] | undefined,
): boolean {
  return (
    Boolean(patterns?.length) &&
    !lifecycleSensitiveFiles(files) &&
    files.every((file) =>
      filePaths(file).every(
        (name) => safePath(name) && patterns!.some((pattern) => matchesGlob(name, pattern)),
      ),
    )
  );
}

export function lifecycleReplayReason(command: LooseRecord, entries: LooseRecord[]): string | null {
  const prior = entries.filter(
    (entry) =>
      entry.repo === command.repo &&
      entry.issue_number === command.issue_number &&
      entry.automation_source === "pi_review_lifecycle" &&
      ["executed", "waiting"].includes(entry.status),
  );
  if (
    !Schema.is(DecimalId)(command.source_run_id) ||
    prior.some((entry) => !Schema.is(DecimalId)(entry.source_run_id))
  )
    return "invalid Pi review run identity in replay ledger; human review required";
  if (
    prior.some(
      (entry) =>
        BigInt(entry.source_run_id) > BigInt(command.source_run_id) ||
        (String(entry.source_run_id) === String(command.source_run_id) &&
          (entry.source_run_attempt > command.source_run_attempt ||
            (entry.source_run_attempt === command.source_run_attempt &&
              entry.lifecycle_phase === "completed" &&
              command.lifecycle_phase === "started"))),
    )
  )
    return "newer or completed Pi review already owns this PR";
  return null;
}
