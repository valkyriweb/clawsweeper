import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { automationPolicyBlockReason, repositoryProfileFor } from "../repository-profiles.js";
import type { LooseRecord } from "./json-types.js";
import { repoRoot } from "./paths.js";
import { parseReviewReport, reportEligibilityBlockers } from "./issue-implementation-report.js";

export function isDraftIssueJob(fm: LooseRecord): boolean {
  if (fm.draft_only !== undefined) return true;
  try {
    return repositoryProfileFor(String(fm.repo)).automationPolicy === "draft_pr_only";
  } catch {
    return false;
  }
}

export function draftVerificationPaths(repo: string, number: number) {
  const slug = repo.toLowerCase().replaceAll("/", "-");
  return {
    report: `records/${slug}/items/${number}.md`,
    audit: `results/verify-reproduction/${slug}/${number}.md`,
  };
}

export function verificationDigest(markdown: string): string {
  return createHash("sha256").update(markdown).digest("hex");
}

// Jobs and evidence come from the trusted state checkout, never event payloads or model output.
export function draftIssueJobBlockReason(fm: LooseRecord, root = repoRoot()): string | null {
  const policy = automationPolicyBlockReason(fm.repo, "draft_issue_implementation");
  if (policy) return policy;
  if (
    fm.source !== "issue_implementation" ||
    fm.job_intent !== "implement_issue" ||
    fm.trigger_source !== "review_reproducible_bug" ||
    fm.draft_only !== true ||
    fm.strict_bug_only !== true ||
    fm.mode !== "autonomous"
  ) {
    return "draft issue implementation requires exact source, intent, strict verification and draft_only=true";
  }
  const refs = fm.candidates;
  if (!Array.isArray(refs) || refs.length !== 1 || !/^#[1-9][0-9]*$/.test(String(refs[0]))) {
    return "draft issue implementation requires one source issue";
  }
  const number = Number(String(refs[0]).slice(1));
  const slug = String(fm.repo).toLowerCase().replaceAll("/", "-");
  const cluster = `issue-${slug}-${number}`;
  if (
    fm.cluster_id !== cluster ||
    fm.target_branch !== `clawsweeper/${cluster}` ||
    JSON.stringify(fm.canonical) !== JSON.stringify(refs) ||
    JSON.stringify(fm.cluster_refs) !== JSON.stringify(refs)
  ) {
    return "draft issue implementation requires the scoped issue repair branch and references";
  }
  if (
    !Array.isArray(fm.allowed_actions) ||
    fm.allowed_actions.length !== 2 ||
    !fm.allowed_actions.includes("fix") ||
    !fm.allowed_actions.includes("raise_pr") ||
    fm.allow_fix_pr !== true ||
    fm.allow_merge !== false ||
    fm.allow_instant_close !== false ||
    fm.allow_unmerged_fix_close !== false ||
    fm.allow_post_merge_close !== false ||
    (fm.required_pr_labels ?? []).length !== 0
  ) {
    return "draft issue implementation permits only fix and draft PR creation; no ancillary mutations";
  }
  const files = draftVerificationPaths(String(fm.repo), number);
  if (fm.clawsweeper_report_path !== files.report || fm.reproduction_verified !== true) {
    return "draft issue implementation requires completed reproduction verification";
  }
  try {
    const report = fs.readFileSync(path.join(root, files.report), "utf8");
    const audit = fs.readFileSync(path.join(root, files.audit), "utf8");
    const review = parseReviewReport(report);
    const verification = parseReviewReport(audit).frontmatter;
    const blockers = reportEligibilityBlockers({
      targetRepo: String(fm.repo),
      report: review,
      lane: "reproduced",
      effectiveStatus: "reproduced",
    });
    if (
      blockers.length > 0 ||
      review.frontmatter.number !== String(number) ||
      verificationDigest(report) !== fm.verification_report_sha256 ||
      verificationDigest(audit) !== fm.verification_audit_sha256 ||
      (verification.repo ?? "").toLowerCase() !== String(fm.repo).toLowerCase() ||
      verification.number !== String(number) ||
      verification.report_path !== files.report ||
      verification.status !== "reproduced" ||
      verification.verified !== "true"
    ) {
      return "draft issue implementation verification evidence is mismatched or incomplete";
    }
  } catch {
    return "draft issue implementation verification evidence is missing";
  }
  return null;
}

export function assertDraftIssueExecution(fm: LooseRecord) {
  const denial = draftIssueJobBlockReason(fm);
  if (denial) throw new Error(denial);
  if (process.env.CLAWSWEEPER_ALLOW_DRAFT_ISSUE_IMPLEMENTATION !== "1") {
    throw new Error("CLAWSWEEPER_ALLOW_DRAFT_ISSUE_IMPLEMENTATION must be 1");
  }
}
