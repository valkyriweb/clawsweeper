// Webhook event router: the App-webhook equivalent of a target repository's
// .github/workflows/clawsweeper-dispatch.yml (Detoil/centaur, valkyriweb/lue-kube).
//
// For a target with `webhook_dispatch: true` and route `valkyriweb`, this turns
// one GitHub webhook delivery into the same `repository_dispatch` events, with
// the same client_payload shapes and the same filters, that the target workflow
// sends. The engine's routers therefore handle them unchanged, and the target
// needs no workflow and no copy of the App private key.
//
// Pure planning only; worker.ts mints tokens and performs the calls.

export const WEBHOOK_DISPATCH_EVENTS: Record<string, ReadonlySet<string> | null> = {
  issues: new Set(["opened", "reopened", "edited", "labeled", "unlabeled"]),
  issue_comment: new Set(["created", "edited"]),
  push: null,
  // The target workflow listens on pull_request_target; the App receives the
  // same payload as `pull_request`. The engine sees `pull_request_target`.
  pull_request: new Set([
    "opened",
    "reopened",
    "synchronize",
    "ready_for_review",
    "edited",
    "labeled",
    "unlabeled",
  ]),
  pull_request_review: new Set(["submitted", "edited", "dismissed"]),
  pull_request_review_comment: new Set(["created", "edited"]),
};

const TRUSTED_COMMENT_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
const SUPERSEDING_ACTIONS = new Set(["edited", "synchronize", "ready_for_review"]);
const LABEL_ACTIONS = new Set(["labeled", "unlabeled"]);
const COMMIT_REVIEW_REF = "refs/heads/main";
// Like the workflow's grep, but a mention must end the username, so
// `@clawsweeper-helper` does not match.
const COMMAND_PATTERN =
  /(^|\s)@(clawsweeper|valkyriweb-clawsweeper|openclaw-clawsweeper)(\[bot\])?(?![\w-])|(^|\s)\/(clawsweeper|review|automerge|autoclose)\b/im;
export const DEBOUNCE_MS = 20_000;

export type EngineDispatch = {
  event_type: string;
  client_payload: Record<string, unknown>;
};

export type CommentCommand = {
  itemNumber: number;
  commentId: number;
  sourceAction: string;
  trusted: boolean;
};

export type RouterPlan = {
  route: true;
  targetRepo: string;
  // Matches the workflow's 20 s sleep before label/unlabel dispatches.
  debounce: boolean;
  // Sent in order, before the comment command.
  dispatches: EngineDispatch[];
  // issue_comment carrying a ClawSweeper command: acknowledge on the target,
  // then send clawsweeper_comment.
  comment?: CommentCommand;
};

export type RouterDecision = RouterPlan | { route: false; reason: string };

type TargetEntry = {
  target_repo?: string;
  webhook_dispatch?: boolean;
  github_app_credential_route?: string;
};

export function webhookDispatchRepos(config: {
  repositories?: TargetEntry[];
}): Map<string, string> {
  const repos = new Map<string, string>();
  for (const entry of config.repositories ?? []) {
    if (
      entry.webhook_dispatch === true &&
      entry.github_app_credential_route === "valkyriweb" &&
      typeof entry.target_repo === "string"
    ) {
      repos.set(entry.target_repo.toLowerCase(), entry.target_repo);
    }
  }
  return repos;
}

type Payload = Record<string, any>;

export function planRouterDispatch(
  event: string | null,
  payload: unknown,
  deliveryId: string | null,
  optedIn: Map<string, string>,
): RouterDecision {
  if (!event || !Object.hasOwn(WEBHOOK_DISPATCH_EVENTS, event)) {
    return { route: false, reason: "event ignored" };
  }
  if (!payload || typeof payload !== "object") return { route: false, reason: "bad payload" };
  const body = payload as Payload;
  const fullName = body.repository?.full_name;
  if (typeof fullName !== "string") return { route: false, reason: "bad payload" };
  const targetRepo = optedIn.get(fullName.toLowerCase());
  if (!targetRepo) return { route: false, reason: "repository not opted in" };

  const action = typeof body.action === "string" ? body.action : "";
  const allowedActions = WEBHOOK_DISPATCH_EVENTS[event];
  if (allowedActions && !allowedActions.has(action)) {
    return { route: false, reason: "action ignored" };
  }
  if (event === "push" && body.ref !== COMMIT_REVIEW_REF) {
    return { route: false, reason: "branch ignored" };
  }
  const actor = typeof body.sender?.login === "string" ? body.sender.login : "";
  if (event === "issue_comment") {
    if (!TRUSTED_COMMENT_ASSOCIATIONS.has(body.comment?.author_association)) {
      return { route: false, reason: "comment author not trusted" };
    }
  } else if (actor.endsWith("[bot]") && LABEL_ACTIONS.has(action)) {
    return { route: false, reason: "bot label ignored" };
  }

  const sourceEvent = event === "pull_request" ? "pull_request_target" : event;
  const dispatches: EngineDispatch[] = [
    {
      event_type: "github_activity",
      client_payload: {
        activity: buildActivity(body, targetRepo, sourceEvent, action, actor, deliveryId),
      },
    },
  ];

  if (event === "issues" || event === "pull_request") {
    const itemNumber = event === "issues" ? body.issue?.number : body.pull_request?.number;
    if (!isPositiveInteger(itemNumber)) return { route: false, reason: "bad payload" };
    dispatches.push({
      event_type: "clawsweeper_item",
      client_payload: {
        target_repo: targetRepo,
        item_number: itemNumber,
        item_kind: event === "pull_request" ? "pull_request" : "issue",
        source_event: sourceEvent,
        source_action: action,
        supersedes_in_progress: SUPERSEDING_ACTIONS.has(action),
      },
    });
  }

  if (event === "push" && body.deleted !== true) {
    dispatches.push({
      event_type: "clawsweeper_commit_review",
      client_payload: {
        target_repo: targetRepo,
        before_sha: String(body.before ?? ""),
        after_sha: String(body.after ?? ""),
        ref: COMMIT_REVIEW_REF,
        enabled: true,
        // The workflow reads vars.CLAWSWEEPER_COMMIT_REVIEW_CREATE_CHECKS,
        // which no webhook_dispatch target sets.
        create_checks: false,
      },
    });
  }

  let comment: CommentCommand | undefined;
  if (event === "issue_comment" && COMMAND_PATTERN.test(String(body.comment?.body ?? ""))) {
    const itemNumber = body.issue?.number;
    const commentId = body.comment?.id;
    if (!isPositiveInteger(itemNumber) || !isPositiveInteger(commentId)) {
      return { route: false, reason: "bad payload" };
    }
    comment = {
      itemNumber,
      commentId,
      sourceAction: action,
      trusted: TRUSTED_COMMENT_ASSOCIATIONS.has(body.comment.author_association),
    };
  }

  return {
    route: true,
    targetRepo,
    debounce: LABEL_ACTIONS.has(action),
    dispatches,
    ...(comment ? { comment } : {}),
  };
}

export function commentDispatch(
  targetRepo: string,
  command: CommentCommand,
  statusCommentId: number | null,
): EngineDispatch {
  return {
    event_type: "clawsweeper_comment",
    client_payload: {
      target_repo: targetRepo,
      item_number: command.itemNumber,
      comment_id: command.commentId,
      source_event: "issue_comment",
      source_action: command.sourceAction,
      max_comments: "1",
      ...(statusCommentId ? { status_comment_id: statusCommentId } : {}),
    },
  };
}

export function statusCommentBody(commentId: number): string {
  return [
    `<!-- valkyriweb-clawsweeper-command-ack:${commentId} -->`,
    "\u{1F99E}\u{1F440}",
    "ClawSweeper picked this up.",
    "",
    "Command router queued. I will update this comment with the next step.",
  ].join("\n");
}

// Mirrors the workflow's jq activity builder, including `del(.. | nulls)`.
export function buildActivity(
  body: Payload,
  targetRepo: string,
  eventName: string,
  action: string,
  actor: string,
  deliveryId: string | null,
): Record<string, unknown> {
  const pr = body.pull_request;
  const issue = body.issue;
  let subject: Record<string, unknown>;
  if (truthy(pr)) {
    subject = {
      kind: "pull_request",
      number: pr.number,
      title: pr.title,
      url: pr.html_url,
      state: pr.merged === true ? "merged" : pr.state,
    };
  } else if (truthy(issue)) {
    subject = {
      kind: truthy(issue.pull_request) ? "pull_request" : "issue",
      number: issue.number,
      title: issue.title,
      url: issue.html_url,
      state: issue.state,
    };
  } else if (eventName === "push") {
    subject = {
      kind: "push",
      title: alt(body.head_commit?.message, body.after, "push"),
      url: alt(body.head_commit?.url, body.compare),
      state: body.ref,
    };
  } else {
    subject = { kind: eventName };
  }
  const comment = body.comment;
  const review = body.review;
  const activity = {
    type: eventName,
    repo: targetRepo,
    action,
    actor,
    subject,
    comment: truthy(comment)
      ? { id: comment.id, url: comment.html_url, body_excerpt: bodyExcerpt(comment.body) }
      : null,
    review: truthy(review)
      ? {
          id: review.id,
          state: review.state,
          url: review.html_url,
          body_excerpt: bodyExcerpt(review.body),
        }
      : null,
    review_comment:
      truthy(comment) && eventName === "pull_request_review_comment"
        ? {
            id: comment.id,
            path: comment.path,
            line: alt(comment.line, comment.original_line),
            url: comment.html_url,
            body_excerpt: bodyExcerpt(comment.body),
          }
        : null,
    push:
      eventName === "push"
        ? {
            before: body.before,
            after: body.after,
            ref: body.ref,
            compare: body.compare,
            head_commit: body.head_commit?.id,
          }
        : null,
    delivery_id: alt(
      comment?.id,
      review?.id,
      pr?.head?.sha,
      issue?.updated_at,
      body.after,
      deliveryId,
    ),
  };
  return stripNulls(activity) as Record<string, unknown>;
}

function bodyExcerpt(value: unknown): string | null {
  const text = value ?? "";
  if (typeof text !== "string") return null;
  // jq slices by codepoint.
  return Array.from(text.replace(/\s+/g, " ")).slice(0, 1200).join("");
}

// jq's `a // b`: the first value that is neither null nor false.
function alt(...values: unknown[]): unknown {
  for (const value of values) if (truthy(value)) return value;
  return null;
}

function truthy(value: unknown): boolean {
  return value !== null && value !== undefined && value !== false;
}

function stripNulls(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.filter((item) => item !== null && item !== undefined).map(stripNulls);
  }
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (item !== null && item !== undefined) output[key] = stripNulls(item);
    }
    return output;
  }
  return value;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}
