import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  DEFAULT_SOURCES,
  type FactorySource,
  type FailedRun,
  type GhApi,
  dedupeKey,
  formatSast,
  issueMarker,
  planFactoryFailureUpdates,
  runMarker,
  safeInline,
  scanFactoryFailures,
  toFailedRun,
} from "../../dist/repair/factory-failure-issues.js";

const CLAWSWEEPER = DEFAULT_SOURCES[0]!;
const LUE_KUBE = DEFAULT_SOURCES[1]!;

function rawRun(overrides: Record<string, unknown> = {}) {
  const id = Number(overrides.id ?? 101);
  return {
    id,
    run_attempt: 1,
    name: "ClawSweeper",
    display_title: "Review event item leo-labs-ai/my-pi#1878",
    path: ".github/workflows/sweep.yml",
    event: "repository_dispatch",
    status: "completed",
    conclusion: "failure",
    html_url: `https://github.com/valkyriweb/clawsweeper/actions/runs/${id}`,
    head_sha: "eb96694061aabbccddeeff001122334455667788",
    head_branch: "main",
    updated_at: "2026-10-23T10:00:00Z",
    ...overrides,
  };
}

function failed(overrides: Record<string, unknown> = {}, source: FactorySource = CLAWSWEEPER) {
  const repo = source.repo;
  const run = toFailedRun(repo, rawRun(overrides), source);
  assert.ok(run);
  return run as FailedRun;
}

test("cancelled, successful and skipped runs never count as factory failures", () => {
  for (const conclusion of ["cancelled", "success", "skipped", "neutral", "action_required"]) {
    assert.equal(toFailedRun(CLAWSWEEPER.repo, rawRun({ conclusion }), CLAWSWEEPER), null);
  }
  assert.equal(toFailedRun(CLAWSWEEPER.repo, rawRun({ status: "in_progress" }), CLAWSWEEPER), null);
  for (const conclusion of ["failure", "timed_out", "startup_failure"]) {
    assert.ok(toFailedRun(CLAWSWEEPER.repo, rawRun({ conclusion }), CLAWSWEEPER));
  }
});

test("source filters skip PR checks, the router's own alert, and unwatched lue-kube workflows", () => {
  assert.equal(
    toFailedRun(
      CLAWSWEEPER.repo,
      rawRun({ path: ".github/workflows/ci.yml", event: "pull_request" }),
      CLAWSWEEPER,
    ),
    null,
  );
  assert.ok(
    toFailedRun(
      CLAWSWEEPER.repo,
      rawRun({ path: ".github/workflows/ci.yml", event: "push" }),
      CLAWSWEEPER,
    ),
  );
  assert.equal(
    toFailedRun(
      CLAWSWEEPER.repo,
      rawRun({ path: ".github/workflows/repair-comment-router.yml" }),
      CLAWSWEEPER,
    ),
    null,
  );
  assert.equal(
    toFailedRun(LUE_KUBE.repo, rawRun({ path: ".github/workflows/ci.yml" }), LUE_KUBE),
    null,
  );
  const land = toFailedRun(
    LUE_KUBE.repo,
    rawRun({ path: ".github/workflows/land-queue.yml@refs/heads/main", name: "Land Queue" }),
    LUE_KUBE,
  );
  assert.equal(land?.workflowFile, "land-queue.yml");
});

test("dedupe key is one per repo and workflow file", () => {
  assert.equal(
    dedupeKey("Valkyriweb/LUE-Kube", "land-queue.yml"),
    "valkyriweb/lue-kube:land-queue.yml",
  );
});

test("times render in SAST", () => {
  assert.equal(formatSast("2026-10-23T10:05:00Z"), "2026-10-23 12:05 SAST");
  assert.equal(formatSast("not a date"), "unknown time");
});

test("safeInline redacts tokens, flattens lines and blocks mentions and markdown escapes", () => {
  const token = `ghp_${"a".repeat(36)}`;
  const rendered = safeInline(`deploy @luke with GH_TOKEN=${token}\nnext \`line\``);
  assert.doesNotMatch(rendered, /ghp_a/);
  assert.match(rendered, /REDACTED/);
  assert.ok(rendered.startsWith("`") && rendered.endsWith("`"));
  assert.equal(rendered.slice(1, -1).includes("`"), false);
  assert.equal(rendered.includes("\n"), false);
});

test("a new failure opens one issue per workflow with run URL, head SHA, job and SAST time", () => {
  const runs = [
    {
      ...failed({ id: 1, updated_at: "2026-10-23T09:00:00Z" }),
      failingJob: "review",
      failingStep: "Run review",
    },
    failed({ id: 2, updated_at: "2026-10-23T09:30:00Z" }),
    failed({
      id: 3,
      path: ".github/workflows/commit-review.yml",
      name: "ClawSweeper Commit Review",
    }),
  ];
  const plan = planFactoryFailureUpdates(runs, []);
  assert.equal(plan.creates.length, 2);
  assert.equal(plan.comments.length, 0);
  const sweep = plan.creates.find((create) => create.key.endsWith(":sweep.yml"))!;
  assert.equal(sweep.runs.length, 2);
  assert.equal(sweep.title, "Factory failure: ClawSweeper (valkyriweb/clawsweeper)");
  assert.ok(sweep.body.startsWith(issueMarker("valkyriweb/clawsweeper:sweep.yml")));
  assert.match(sweep.body, /https:\/\/github\.com\/valkyriweb\/clawsweeper\/actions\/runs\/1\)/);
  assert.match(sweep.body, /`eb96694061aa`/);
  assert.match(sweep.body, /failing job `review` step `Run review`/);
  assert.match(sweep.body, /2026-10-23 11:00 SAST/);
  assert.ok(sweep.body.includes(runMarker(runs[0]!)));
  // Public issue repo: run titles can name private repos and are never copied.
  assert.doesNotMatch(sweep.body, /my-pi#1878/);
});

test("an open issue gets a comment and already reported runs are not repeated", () => {
  const key = "valkyriweb/clawsweeper:sweep.yml";
  const old = failed({ id: 10 });
  const fresh = failed({ id: 11 });
  const issues = [
    { number: 7, state: "open", body: `${issueMarker(key)}\n${runMarker(old)}`, comments: [] },
  ];
  const plan = planFactoryFailureUpdates([old, fresh, fresh], issues);
  assert.equal(plan.creates.length, 0);
  assert.equal(plan.alreadyReported, 1);
  assert.equal(plan.comments.length, 1);
  assert.equal(plan.comments[0]!.issueNumber, 7);
  assert.equal(plan.comments[0]!.runs.length, 1);
  assert.ok(plan.comments[0]!.body.includes(runMarker(fresh)));
});

test("a rerun attempt is a distinct failure, and a closed issue only suppresses its own runs", () => {
  const key = "valkyriweb/clawsweeper:sweep.yml";
  const first = failed({ id: 20, run_attempt: 1 });
  const retry = failed({ id: 20, run_attempt: 2 });
  const closed = [
    { number: 8, state: "closed", body: issueMarker(key), comments: [runMarker(first)] },
  ];
  const plan = planFactoryFailureUpdates([first, retry], closed);
  assert.equal(plan.alreadyReported, 1);
  assert.equal(plan.creates.length, 1);
  assert.deepEqual(
    plan.creates[0]!.runs.map((run) => run.runAttempt),
    [2],
  );
});

function fakeGh(routes: Record<string, unknown>) {
  const calls: { args: string[]; token: string; input?: string }[] = [];
  const gh: GhApi = (args, token, input) => {
    calls.push({ args, token, ...(input === undefined ? {} : { input }) });
    const path = args.find((arg) => arg.startsWith("repos/")) ?? "";
    const key = `${args[0] === "-X" ? args[1] : "GET"} ${path}`;
    for (const [prefix, value] of Object.entries(routes)) {
      const route = /^(GET|POST) /.test(prefix) ? prefix : `GET ${prefix}`;
      if (!key.startsWith(route)) continue;
      if (value instanceof Error) throw value;
      return value;
    }
    throw new Error(`unexpected gh call ${args.join(" ")}`);
  };
  return { gh, calls };
}

test("scan files the issue with the issue token, reads lue-kube with its own token, and skips cancelled runs", () => {
  const { gh, calls } = fakeGh({
    "repos/valkyriweb/clawsweeper/actions/runs?": {
      workflow_runs: [rawRun({ id: 31 }), rawRun({ id: 32, conclusion: "cancelled" })],
    },
    "repos/valkyriweb/lue-kube/actions/runs?": {
      workflow_runs: [
        rawRun({
          id: 41,
          path: ".github/workflows/land-queue.yml",
          name: "Land Queue",
          html_url: "https://github.com/valkyriweb/lue-kube/actions/runs/41",
        }),
      ],
    },
    "repos/valkyriweb/clawsweeper/actions/runs/31/attempts/1/jobs": {
      jobs: [
        { name: "plan", conclusion: "success", steps: [] },
        {
          name: "review (shard 1)",
          conclusion: "failure",
          steps: [{ name: "Review", conclusion: "failure" }],
        },
      ],
    },
    "repos/valkyriweb/lue-kube/actions/runs/41/attempts/1/jobs": {
      jobs: [{ name: "land", conclusion: "failure" }],
    },
    "repos/valkyriweb/clawsweeper/issues?": [],
    "repos/valkyriweb/clawsweeper/labels/factory-failure": { name: "factory-failure" },
    "POST repos/valkyriweb/clawsweeper/issues": { number: 300 },
  });
  const result = scanFactoryFailures({
    issueRepo: "valkyriweb/clawsweeper",
    sources: DEFAULT_SOURCES,
    lookbackHours: 3,
    dryRun: false,
    now: new Date("2026-10-23T12:00:00Z"),
    env: { GH_TOKEN: "issue-token", FACTORY_FAILURE_LUE_KUBE_TOKEN: "lue-token" },
    gh,
  });
  assert.equal(result.creates.length, 2);
  const luePaths = calls.filter((call) => call.args.some((arg) => arg.includes("lue-kube")));
  assert.ok(luePaths.length > 0);
  assert.ok(luePaths.every((call) => call.token === "lue-token"));
  const posts = calls.filter((call) => call.args[0] === "-X");
  assert.equal(posts.length, 2);
  assert.ok(posts.every((call) => call.token === "issue-token"));
  const bodies = posts.map((call) => JSON.parse(call.input ?? "{}"));
  assert.ok(bodies.every((body) => body.labels?.[0] === "factory-failure"));
  assert.ok(
    bodies.some((body) => /failing job `review \(shard 1\)` step `Review`/.test(body.body)),
  );
  assert.ok(bodies.every((body) => !String(body.body).includes("runs/32")));
});

test("missing or unauthorized lue-kube token is reported as skipped, not as a failure", () => {
  const { gh } = fakeGh({
    "repos/valkyriweb/clawsweeper/actions/runs?": { workflow_runs: [] },
    "repos/valkyriweb/lue-kube/actions/runs?": new Error("HTTP 403"),
    "repos/valkyriweb/clawsweeper/issues?": [],
  });
  const base = {
    issueRepo: "valkyriweb/clawsweeper",
    sources: DEFAULT_SOURCES,
    lookbackHours: 3,
    dryRun: false,
    now: new Date("2026-10-23T12:00:00Z"),
    gh,
  };
  const missing = scanFactoryFailures({ ...base, env: { GH_TOKEN: "issue-token" } });
  assert.match(missing.sources[1]!.status, /FACTORY_FAILURE_LUE_KUBE_TOKEN not set/);
  const denied = scanFactoryFailures({
    ...base,
    env: { GH_TOKEN: "issue-token", FACTORY_FAILURE_LUE_KUBE_TOKEN: "lue-token" },
  });
  assert.equal(denied.sources[1]!.status, "skipped: run list not readable with token");
  assert.doesNotMatch(JSON.stringify(denied), /403/);
});

test("dry run plans without writing", () => {
  const { gh, calls } = fakeGh({
    "repos/valkyriweb/clawsweeper/actions/runs?": { workflow_runs: [rawRun({ id: 51 })] },
    "repos/valkyriweb/clawsweeper/actions/runs/51/attempts/1/jobs": { jobs: [] },
    "repos/valkyriweb/clawsweeper/issues?": [],
  });
  const result = scanFactoryFailures({
    issueRepo: "valkyriweb/clawsweeper",
    sources: [CLAWSWEEPER],
    lookbackHours: 3,
    dryRun: true,
    now: new Date("2026-10-23T12:00:00Z"),
    env: { GH_TOKEN: "issue-token" },
    gh,
  });
  assert.equal(result.status, "dry_run");
  assert.equal(result.creates.length, 1);
  assert.equal(calls.filter((call) => call.args[0] === "-X").length, 0);
});

test("self-heal workflow runs the scan as a step with least-privilege tokens, not a new job", () => {
  const workflow = readFileSync(".github/workflows/repair-self-heal.yml", "utf8");
  assert.match(workflow, /repair:factory-failure-issues/);
  assert.match(workflow, /permission-issues: write/);
  assert.match(workflow, /FACTORY_FAILURE_LUE_KUBE_TOKEN/);
  assert.doesNotMatch(workflow, /workflow_run:/);
  assert.equal((workflow.match(/runs-on:/g) ?? []).length, 1);
});
