import type { LooseRecord } from "./json-types.js";

// Pure, deterministic policy gates for merge/close actions, extracted from
// apply-result.ts so they can be unit-tested without importing the
// self-executing applier. Behavior must stay byte-identical to the originals.

export function validateClosePolicy({ job, actionName }: LooseRecord) {
  if (!job.frontmatter.allowed_actions.includes("close")) return "job does not allow close";
  if (!job.frontmatter.allowed_actions.includes("comment"))
    return "job does not allow close comments";
  if ((job.frontmatter.blocked_actions ?? []).includes("close"))
    return "close is blocked by job frontmatter";
  if ((job.frontmatter.blocked_actions ?? []).includes("comment"))
    return "comment is blocked by job frontmatter";
  if (
    !["close_low_signal", "post_merge_close"].includes(actionName) &&
    job.frontmatter.allow_instant_close !== true
  ) {
    return "instant close requires allow_instant_close: true";
  }
  return "";
}

export function validateMergePolicy({ job, action }: LooseRecord) {
  if (!job.frontmatter.allowed_actions.includes("merge")) return "job does not allow merge";
  if ((job.frontmatter.blocked_actions ?? []).includes("merge"))
    return "merge is blocked by job frontmatter";
  if (job.frontmatter.allow_merge !== true) return "merge requires allow_merge: true";
  if (!["merge_candidate", "merge_canonical"].includes(String(action.action ?? ""))) {
    return "unsupported merge action";
  }
  return "";
}
