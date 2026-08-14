import { repositoryProfileFor } from "../repository-profiles.js";
import { AUTOFIX_LABEL } from "./comment-router-core.js";

export interface PostRepairReviewLabelTransition {
  addArgs: string[];
  removeArgs: string[];
  removedLabel: string;
  addedLabel: string;
}

export function hasAutofixAuthorization(pull: unknown): boolean {
  if (!pull || typeof pull !== "object" || Array.isArray(pull)) return false;
  const labels = (pull as { labels?: unknown }).labels;
  if (!Array.isArray(labels)) return false;
  return labels.some((label) => {
    if (typeof label === "string") return label === AUTOFIX_LABEL;
    if (!label || typeof label !== "object" || Array.isArray(label)) return false;
    return (label as { name?: unknown }).name === AUTOFIX_LABEL;
  });
}

/**
 * Build the target-specific state handoff performed after a successful repair
 * push. The push triggers the target review workflow; this label records which
 * lane owns the new head and need not emit a separate label event.
 */
export function postRepairReviewLabelTransition(
  repo: string,
  pullNumber: number,
): PostRepairReviewLabelTransition | null {
  if (!Number.isSafeInteger(pullNumber) || pullNumber <= 0) {
    throw new Error("post-repair review label transition requires a positive integer PR number");
  }
  const addedLabel = repositoryProfileFor(repo).postRepairReviewLabel;
  if (!addedLabel) return null;
  const target = ["issue", "edit", String(pullNumber), "--repo", repo];
  return {
    addArgs: [...target, "--add-label", addedLabel],
    removeArgs: [...target, "--remove-label", AUTOFIX_LABEL],
    removedLabel: AUTOFIX_LABEL,
    addedLabel,
  };
}
