import { escapeRegExp } from "./text-utils.js";

export type ReviewReport = {
  frontmatter: Record<string, string>;
  body: string;
};

export function parseReviewReport(markdown: string): ReviewReport {
  const match = markdown.match(/^---\n([\s\S]*?)\n---\n?/);
  const frontmatter: Record<string, string> = {};
  if (match) {
    for (const line of (match[1] ?? "").split(/\r?\n/)) {
      const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
      if (!kv) continue;
      frontmatter[kv[1] ?? ""] = stripQuotes(kv[2] ?? "");
    }
  }
  return { frontmatter, body: match ? markdown.slice(match[0].length) : markdown };
}

export function reportEligibilityBlockers({
  targetRepo,
  report,
  lane,
  effectiveStatus,
  auditReason = "",
}: {
  targetRepo: string;
  report: ReviewReport;
  lane: "reproduced" | "verifiable";
  effectiveStatus: string;
  auditReason?: string;
}): string[] {
  const fm = report.frontmatter;
  const blockers: string[] = [];
  // Case-insensitive repo comparison: reviewers/renderers normalize the
  // `repository` frontmatter field to lowercase (`clip-sa/core-ai`) but the
  // workflow input may carry the canonical mixed-case form (`CLIP-SA/core-ai`).
  if ((fm.repository ?? "").toLowerCase() !== targetRepo.toLowerCase())
    blockers.push(`report repository is ${fm.repository || "unknown"}`);
  if (fm.type !== "issue") blockers.push(`report type is ${fm.type || "unknown"}`);
  if (fm.state_at_review !== "open") blockers.push("item was not open at review");
  if (fm.review_status !== "complete")
    blockers.push(`review status is ${fm.review_status || "unknown"}`);
  if (fm.decision !== "keep_open") blockers.push(`decision is ${fm.decision || "unknown"}`);
  if (fm.close_reason !== "none") blockers.push(`close reason is ${fm.close_reason || "unknown"}`);
  if (fm.confidence !== "high") blockers.push(`review confidence is ${fm.confidence || "unknown"}`);
  if (fm.work_candidate !== "queue_fix_pr")
    blockers.push(`work candidate is ${fm.work_candidate || "unknown"}`);
  if (fm.work_confidence !== "high")
    blockers.push(`work confidence is ${fm.work_confidence || "unknown"}`);
  if (!isEligibleIssueImplementationCategory(fm.item_category))
    blockers.push(`item category is ${fm.item_category || "unknown"}`);
  const acceptedReproStatus = lane === "verifiable" ? "source_reproducible" : "reproduced";
  if (effectiveStatus === "blocked") {
    blockers.push(
      `verify-reproduction marked the item environment-blocked${
        auditReason ? `: ${auditReason}` : ""
      }`,
    );
  } else if (effectiveStatus !== acceptedReproStatus) {
    blockers.push(`reproduction status is ${effectiveStatus || "unknown"}`);
  }
  if (fm.reproduction_confidence !== "high")
    blockers.push(`reproduction confidence is ${fm.reproduction_confidence || "unknown"}`);
  if (fm.requires_new_feature === "true") blockers.push("requires a new feature");
  if (fm.requires_new_config_option === "true") blockers.push("requires a new config option");
  if (fm.requires_product_decision === "true") blockers.push("requires a product decision");
  if (frontMatterStringArray(fm.labels).some(isProtectedLabel))
    blockers.push("protected label present");
  // Trust the reviewer's schema-validated `securityReview.status` verdict
  // (promoted to `security_review_status` frontmatter by the renderer) over
  // a regex scan of the narrative prose. Fail-closed when the field is
  // missing or unknown so legacy reports must be re-reviewed before they
  // re-enter intake.
  const securityVerdict = fm.security_review_status;
  if (securityVerdict !== "cleared" && securityVerdict !== "not_applicable") {
    blockers.push(
      securityVerdict
        ? `security review verdict is ${securityVerdict}`
        : "missing security review verdict",
    );
  }
  if (!section(report.body, "Repair Work Prompt").trim())
    blockers.push("missing repair work prompt");
  if (frontMatterStringArray(fm.work_validation).length === 0)
    blockers.push("missing validation commands");
  if (
    frontMatterStringArray(fm.work_cluster_refs).some((ref) =>
      blocksIssueImplementationPr(ref, targetRepo),
    )
  )
    blockers.push("work cluster references a PR");

  return blockers;
}

function isEligibleIssueImplementationCategory(category: string | undefined) {
  // `regression` is included alongside `bug` so reviewer-tagged regressions
  // (e.g. CI-break/generated-file-drift issues) can flow through the strict
  // implementation lane. Fork divergence from upstream openclaw/clawsweeper,
  // which restricts this lane to `bug` only.
  return new Set(["bug", "regression", "docs"]).has(
    String(category ?? "")
      .trim()
      .toLowerCase(),
  );
}

export function section(markdown: string, heading: string) {
  const match = markdown.match(
    new RegExp(`(?:^|\\n)## ${escapeRegExp(heading)}\\n\\n([\\s\\S]*?)(?=\\n## |\\n?$)`, "i"),
  );
  return match?.[1]?.trim() ?? "";
}

export function frontMatterStringArray(value: string | undefined): string[] {
  if (!value || value === "none") return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed))
      return parsed.filter((entry): entry is string => typeof entry === "string");
  } catch {
    // Legacy comma-separated reports.
  }
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function isProtectedLabel(label: string): boolean {
  return ["security", "beta-blocker", "release-blocker", "maintainer"].includes(
    label.trim().toLowerCase(),
  );
}

export function blocksIssueImplementationPr(ref: string, targetRepo: string): boolean {
  const text = ref.trim();
  if (/^pr[#:\s-]*\d+$/i.test(text)) return true;
  const pullUrl = text.match(/github\.com\/([^/\s]+\/[^/\s]+)\/pull\/\d+/i);
  if (!pullUrl) return false;
  return pullUrl[1]?.toLowerCase() === targetRepo.toLowerCase();
}

export function stripQuotes(value: string) {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}
