import assert from "node:assert/strict";
import { createHmac, generateKeyPairSync } from "node:crypto";
import test from "node:test";

import {
  buildActivity,
  planRouterDispatch,
  webhookDispatchRepos,
} from "../dashboard/pr-webhook/router.ts";
import { handle } from "../dashboard/pr-webhook/worker.ts";

const SECRET = "test-webhook-secret";
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const env = { GITHUB_WEBHOOK_SECRET: SECRET, GITHUB_APP_PRIVATE_KEY: PEM };
const CENTAUR = "Detoil/centaur";
const OPTED = new Map([["detoil/centaur", CENTAUR]]);
const SHA = "b".repeat(40);

const repository = { full_name: CENTAUR };
const human = { login: "lukeseeber" };
const issue = {
  number: 12,
  title: "Bug",
  html_url: "https://github.com/Detoil/centaur/issues/12",
  state: "open",
  updated_at: "2026-11-26T10:00:00Z",
};
const pullRequest = {
  number: 34,
  title: "Feature",
  html_url: "https://github.com/Detoil/centaur/pull/34",
  state: "open",
  draft: false,
  merged: false,
  head: { sha: SHA },
};

// SAFETY: test-only view of payloads whose exact shape each test asserts.
function payloadOf(dispatch: { client_payload: unknown }): any {
  return dispatch.client_payload;
}

function plan(event: string, payload: unknown, delivery: string | null = "delivery-1") {
  return planRouterDispatch(event, payload, delivery, OPTED);
}

function routed(event: string, payload: unknown) {
  const decision = plan(event, payload);
  assert.equal(decision.route, true, JSON.stringify(decision));
  if (decision.route !== true) throw new Error("not routed");
  return decision;
}

function skipped(event: string, payload: unknown): string {
  const decision = plan(event, payload);
  assert.equal(decision.route, false);
  return decision.route === false ? decision.reason : "";
}

test("webhookDispatchRepos keeps only webhook_dispatch targets on the valkyriweb route", () => {
  const repos = webhookDispatchRepos({
    repositories: [
      { target_repo: CENTAUR, webhook_dispatch: true, github_app_credential_route: "valkyriweb" },
      { target_repo: "a/off", webhook_dispatch: false, github_app_credential_route: "valkyriweb" },
      { target_repo: "a/unset", github_app_credential_route: "valkyriweb" },
      {
        target_repo: "bermont-digital/x",
        webhook_dispatch: true,
        github_app_credential_route: "bermont-digital",
      },
    ],
  });
  assert.deepEqual([...repos.entries()], [["detoil/centaur", CENTAUR]]);
});

test("issues events send github_activity and clawsweeper_item like the target workflow", () => {
  const decision = routed("issues", { action: "opened", issue, repository, sender: human });
  assert.equal(decision.debounce, false);
  assert.equal(decision.comment, undefined);
  assert.deepEqual(decision.dispatches, [
    {
      event_type: "github_activity",
      client_payload: {
        activity: {
          type: "issues",
          repo: CENTAUR,
          action: "opened",
          actor: "lukeseeber",
          subject: {
            kind: "issue",
            number: 12,
            title: "Bug",
            url: issue.html_url,
            state: "open",
          },
          delivery_id: issue.updated_at,
        },
      },
    },
    {
      event_type: "clawsweeper_item",
      client_payload: {
        target_repo: CENTAUR,
        item_number: 12,
        item_kind: "issue",
        source_event: "issues",
        source_action: "opened",
        supersedes_in_progress: false,
      },
    },
  ]);
  const edited = routed("issues", { action: "edited", issue, repository, sender: human });
  assert.equal(payloadOf(edited.dispatches[1]).supersedes_in_progress, true);
  assert.equal(skipped("issues", { action: "closed", issue, repository }), "action ignored");
});

test("pull_request is forwarded as pull_request_target with supersede flags", () => {
  const decision = routed("pull_request", {
    action: "synchronize",
    pull_request: pullRequest,
    repository,
    sender: human,
  });
  const [activity, item] = decision.dispatches;
  assert.equal(payloadOf(activity).activity.type, "pull_request_target");
  assert.deepEqual(payloadOf(activity).activity.subject, {
    kind: "pull_request",
    number: 34,
    title: "Feature",
    url: pullRequest.html_url,
    state: "open",
  });
  assert.equal(payloadOf(activity).activity.delivery_id, SHA);
  assert.deepEqual(payloadOf(item), {
    target_repo: CENTAUR,
    item_number: 34,
    item_kind: "pull_request",
    source_event: "pull_request_target",
    source_action: "synchronize",
    supersedes_in_progress: true,
  });
  const merged = routed("pull_request", {
    action: "edited",
    pull_request: { ...pullRequest, state: "closed", merged: true },
    repository,
    sender: human,
  });
  assert.equal(payloadOf(merged.dispatches[0]).activity.subject.state, "merged");
  assert.equal(
    skipped("pull_request", { action: "closed", pull_request: pullRequest, repository }),
    "action ignored",
  );
});

test("label events are debounced and bot label events are dropped", () => {
  const labeled = routed("pull_request", {
    action: "labeled",
    pull_request: pullRequest,
    repository,
    sender: human,
  });
  assert.equal(labeled.debounce, true);
  assert.equal(
    skipped("issues", {
      action: "unlabeled",
      issue,
      repository,
      sender: { login: "valkyriweb-clawsweeper[bot]" },
    }),
    "bot label ignored",
  );
  // A bot's non-label event still goes through, as in the workflow.
  routed("issues", {
    action: "opened",
    issue,
    repository,
    sender: { login: "dependabot[bot]" },
  });
});

test("pull_request_review and review comments send github_activity only", () => {
  const review = routed("pull_request_review", {
    action: "submitted",
    pull_request: pullRequest,
    review: {
      id: 501,
      state: "approved",
      html_url: "https://github.com/r/501",
      body: "Looks\n\n good",
    },
    repository,
    sender: human,
  });
  assert.equal(review.dispatches.length, 1);
  const activity = payloadOf(review.dispatches[0]).activity;
  assert.equal(activity.type, "pull_request_review");
  assert.deepEqual(activity.review, {
    id: 501,
    state: "approved",
    url: "https://github.com/r/501",
    body_excerpt: "Looks good",
  });
  assert.equal(activity.delivery_id, 501);

  const reviewComment = routed("pull_request_review_comment", {
    action: "created",
    pull_request: pullRequest,
    comment: {
      id: 601,
      path: "src/a.ts",
      line: null,
      original_line: 9,
      html_url: "https://github.com/c/601",
      body: "nit",
    },
    repository,
    sender: human,
  });
  assert.equal(reviewComment.dispatches.length, 1);
  const rc = payloadOf(reviewComment.dispatches[0]).activity;
  assert.deepEqual(rc.review_comment, {
    id: 601,
    path: "src/a.ts",
    line: 9,
    url: "https://github.com/c/601",
    body_excerpt: "nit",
  });
  assert.deepEqual(rc.comment, { id: 601, url: "https://github.com/c/601", body_excerpt: "nit" });
  assert.equal(
    skipped("pull_request_review", {
      action: "deleted",
      pull_request: pullRequest,
      repository,
    }),
    "action ignored",
  );
});

test("issue_comment requires a trusted author and a command to start the comment router", () => {
  const comment = (body: string, association = "MEMBER") => ({
    action: "created",
    issue: { ...issue, pull_request: { url: "x" } },
    comment: {
      id: 701,
      body,
      author_association: association,
      html_url: "https://github.com/c/701",
    },
    repository,
    sender: human,
  });
  const command = routed("issue_comment", comment("please @clawsweeper review"));
  assert.equal(command.dispatches.length, 1);
  assert.equal(payloadOf(command.dispatches[0]).activity.subject.kind, "pull_request");
  assert.deepEqual(command.comment, {
    itemNumber: 12,
    commentId: 701,
    sourceAction: "created",
    trusted: true,
  });
  assert.ok(routed("issue_comment", comment("text\n/review now")).comment);
  assert.ok(routed("issue_comment", comment("@Valkyriweb-ClawSweeper[bot] go")).comment);
  assert.ok(routed("issue_comment", comment("@clawsweeper, please")).comment);
  assert.equal(routed("issue_comment", comment("@clawsweeper-helper go")).comment, undefined);
  const chatter = routed("issue_comment", comment("thanks, looks fine"));
  assert.equal(chatter.comment, undefined);
  assert.equal(chatter.dispatches.length, 1);
  assert.equal(routed("issue_comment", comment("x/review")).comment, undefined);
  for (const association of ["CONTRIBUTOR", "NONE", "FIRST_TIME_CONTRIBUTOR"]) {
    assert.equal(
      skipped("issue_comment", comment("@clawsweeper go", association)),
      "comment author not trusted",
    );
  }
  assert.equal(
    skipped("issue_comment", { ...comment("@clawsweeper"), action: "deleted" }),
    "action ignored",
  );
});

test("push to main sends github_activity and clawsweeper_commit_review; other refs are ignored", () => {
  const push = {
    ref: "refs/heads/main",
    before: "a".repeat(40),
    after: SHA,
    compare: "https://github.com/Detoil/centaur/compare/a...b",
    deleted: false,
    head_commit: { id: SHA, message: "feat: x", url: "https://github.com/commit/b" },
    repository,
    sender: human,
  };
  const decision = routed("push", push);
  assert.deepEqual(decision.dispatches, [
    {
      event_type: "github_activity",
      client_payload: {
        activity: {
          type: "push",
          repo: CENTAUR,
          action: "",
          actor: "lukeseeber",
          subject: {
            kind: "push",
            title: "feat: x",
            url: "https://github.com/commit/b",
            state: "refs/heads/main",
          },
          push: {
            before: push.before,
            after: SHA,
            ref: "refs/heads/main",
            compare: push.compare,
            head_commit: SHA,
          },
          delivery_id: SHA,
        },
      },
    },
    {
      event_type: "clawsweeper_commit_review",
      client_payload: {
        target_repo: CENTAUR,
        before_sha: push.before,
        after_sha: SHA,
        ref: "refs/heads/main",
        enabled: true,
        create_checks: false,
      },
    },
  ]);
  const deleted = routed("push", { ...push, deleted: true, head_commit: null });
  assert.deepEqual(
    deleted.dispatches.map((dispatch) => dispatch.event_type),
    ["github_activity"],
  );
  assert.equal(skipped("push", { ...push, ref: "refs/heads/feature" }), "branch ignored");
});

test("unlisted repositories and other events are never routed", () => {
  assert.equal(
    skipped("issues", {
      action: "opened",
      issue,
      repository: { full_name: "valkyriweb/lue-kube" },
    }),
    "repository not opted in",
  );
  assert.equal(skipped("check_run", { action: "completed", repository }), "event ignored");
  assert.equal(skipped("issues", null), "bad payload");
});

test("buildActivity truncates excerpts to 1200 codepoints and drops nulls", () => {
  const activity = buildActivity(
    { comment: { id: 1, body: `${"\u{1F99E}".repeat(1300)}`, html_url: null } },
    CENTAUR,
    "issue_comment",
    "created",
    "x",
    null,
  );
  const excerpt = (activity.comment as { body_excerpt: string }).body_excerpt;
  assert.equal(Array.from(excerpt).length, 1200);
  assert.equal("url" in (activity.comment as object), false);
  assert.deepEqual(activity.subject, { kind: "issue_comment" });
});

type Call = { url: string; method: string; auth: string; body?: any };

function fakeGithub(options: { failDispatch?: boolean; reactionStatus?: number } = {}) {
  const calls: Call[] = [];
  return {
    calls,
    fetch: async (url: string, init: RequestInit = {}) => {
      const headers = new Headers(init.headers);
      calls.push({
        url,
        method: init.method ?? "GET",
        auth: headers.get("authorization") ?? "",
        body: init.body ? JSON.parse(String(init.body)) : undefined,
      });
      if (url.endsWith("/repos/valkyriweb/clawsweeper/installation")) {
        return Response.json({ id: 42 });
      }
      if (url.endsWith("/repos/Detoil/centaur/installation")) return Response.json({ id: 77 });
      if (url.endsWith("/access_tokens")) {
        return Response.json(
          { token: url.includes("/42/") ? "ghs_engine" : "ghs_target" },
          { status: 201 },
        );
      }
      if (url.endsWith("/repos/valkyriweb/clawsweeper/dispatches")) {
        return new Response(null, { status: options.failDispatch ? 403 : 204 });
      }
      if (url.endsWith("/reactions")) {
        return Response.json({}, { status: options.reactionStatus ?? 201 });
      }
      if (url.endsWith("/issues/12/comments")) return Response.json({ id: 9001 }, { status: 201 });
      return new Response("unexpected", { status: 500 });
    },
  };
}

function request(event: string, payload: unknown): Request {
  const body = JSON.stringify(payload);
  return new Request("https://example.workers.dev/github/webhook", {
    method: "POST",
    headers: {
      "x-github-event": event,
      "x-github-delivery": "delivery-1",
      "x-hub-signature-256": `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`,
    },
    body,
  });
}

test("handle mints a contents:write engine token and sends each dispatch", async () => {
  const github = fakeGithub();
  const response = await handle(
    request("issues", { action: "opened", issue, repository, sender: human }),
    env,
    github.fetch,
    { webhookDispatch: OPTED },
  );
  assert.equal(response.status, 202);
  const tokenCalls = github.calls.filter((call) => call.url.endsWith("/access_tokens"));
  assert.deepEqual(
    tokenCalls.map((call) => call.body),
    [{ repositories: ["clawsweeper"], permissions: { contents: "write" } }],
  );
  const dispatches = github.calls.filter((call) => call.url.endsWith("/clawsweeper/dispatches"));
  assert.deepEqual(
    dispatches.map((call) => [call.auth, call.body.event_type]),
    [
      ["token ghs_engine", "github_activity"],
      ["token ghs_engine", "clawsweeper_item"],
    ],
  );
});

test("handle acknowledges a command comment on the target, then dispatches the comment router", async () => {
  const github = fakeGithub({ reactionStatus: 422 });
  const response = await handle(
    request("issue_comment", {
      action: "created",
      issue,
      comment: { id: 701, body: "/clawsweeper", author_association: "OWNER" },
      repository,
      sender: human,
    }),
    env,
    github.fetch,
    { webhookDispatch: OPTED },
  );
  assert.equal(response.status, 202);
  const targetToken = github.calls.find((call) =>
    call.url.endsWith("/installations/77/access_tokens"),
  );
  assert.deepEqual(targetToken?.body, {
    repositories: ["centaur"],
    permissions: { issues: "write", pull_requests: "read" },
  });
  const reaction = github.calls.find((call) => call.url.endsWith("/comments/701/reactions"));
  assert.equal(reaction?.auth, "token ghs_target");
  assert.deepEqual(reaction?.body, { content: "eyes" });
  const status = github.calls.find((call) => call.url.endsWith("/issues/12/comments"));
  assert.match(status?.body.body, /^<!-- valkyriweb-clawsweeper-command-ack:701 -->/);
  const last = github.calls.at(-1);
  assert.equal(last?.auth, "token ghs_engine");
  assert.deepEqual(last?.body, {
    event_type: "clawsweeper_comment",
    client_payload: {
      target_repo: CENTAUR,
      item_number: 12,
      comment_id: 701,
      source_event: "issue_comment",
      source_action: "created",
      max_comments: "1",
      status_comment_id: 9001,
    },
  });
});

test("handle defers label events by the debounce and replies 202 first", async () => {
  const github = fakeGithub();
  const pending: Promise<unknown>[] = [];
  const slept: number[] = [];
  const response = await handle(
    request("issues", { action: "labeled", issue, repository, sender: human }),
    env,
    github.fetch,
    {
      webhookDispatch: OPTED,
      waitUntil: (promise) => pending.push(promise),
      sleep: async (ms) => {
        slept.push(ms);
      },
    },
  );
  assert.equal(response.status, 202);
  assert.equal(pending.length, 1);
  await Promise.all(pending);
  assert.deepEqual(slept, [20_000]);
  assert.equal(github.calls.filter((call) => call.url.endsWith("/dispatches")).length, 2);
});

test("handle returns 502 when the engine refuses a dispatch, and 202 for unlisted repos", async () => {
  const failing = fakeGithub({ failDispatch: true });
  const response = await handle(
    request("issues", { action: "opened", issue, repository, sender: human }),
    env,
    failing.fetch,
    { webhookDispatch: OPTED },
  );
  assert.equal(response.status, 502);
  assert.equal(await response.text(), "dispatch failed\n");

  const quiet = fakeGithub();
  const ignored = await handle(
    request("issues", { action: "opened", issue, repository, sender: human }),
    env,
    quiet.fetch,
    { webhookDispatch: new Map() },
  );
  assert.equal(ignored.status, 202);
  assert.equal(quiet.calls.length, 0);
});
