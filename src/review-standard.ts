// ADLC review-and-merge standard, phase 1 (crawl). Pure, dependency-free logic:
// risk-tier classification from the change, majority-consensus finding filter,
// review round cap with repeat suppression, reviewer noise accounting and a
// per-repo circuit breaker. Nothing here calls GitHub or a model, and nothing
// here merges. Callers gate every use on `ReviewStandardConfig.mode`, which
// defaults to "off"; phase 1 only allows "off" and "dry_run".
import { Schema } from "effect";

/** Raw JSON value read from config/target-repositories.json. */
export type ConfigInput = Parameters<ReturnType<typeof Schema.decodeUnknownSync>>[0];

export const REVIEW_STANDARD_MODES = ["off", "dry_run"] as const;
export type ReviewStandardMode = (typeof REVIEW_STANDARD_MODES)[number];

export type RiskTier = "low" | "medium" | "human_required";

export interface ReviewStandardConfig {
  mode: ReviewStandardMode;
  /** Extra owner-listed sensitive globs that always need a human. */
  humanRequiredPaths: readonly string[];
  /** Label that marks a change as additive behind a feature flag. */
  flaggedAdditiveLabel: string;
  reviewerCount: number;
  maxFullRounds: number;
}

export const DEFAULT_REVIEW_STANDARD: ReviewStandardConfig = {
  mode: "off",
  humanRequiredPaths: [],
  flaggedAdditiveLabel: "risk:flagged-additive",
  reviewerCount: 3,
  maxFullRounds: 3,
};

// Paths that always need a human, whatever the tier says: auth, billing,
// CI workflows, infra and secrets.
export const ALWAYS_HUMAN_PATTERNS: readonly RegExp[] = [
  /(^|\/)\.github\/workflows\//,
  /(^|\/)\.github\/actions\//,
  /(^|\/)CODEOWNERS$/,
  /(^|\/)(auth|authn|authz|oauth|session|sessions|permissions?)(\/|\.|-|_)/i,
  /(^|\/)(billing|payments?|invoices?|stripe|subscriptions?)(\/|\.|-|_)/i,
  /(^|\/)(secrets?|sealed-?secrets?|credentials?)(\/|\.|-|_)/i,
  /\.(pem|key|p12)$/,
  /(^|\/)\.env(\.|$)/,
  /(^|\/)(deploy|infra|terraform|k8s|kubernetes|helm|charts|manifests)\//i,
  /(^|\/)(alchemy\.run\.ts|Dockerfile[^/]*|docker-compose[^/]*)$/,
];

const LOW_RISK_PATTERNS: readonly RegExp[] = [
  /\.(md|mdx|txt|rst)$/i,
  /(^|\/)docs\//,
  /(^|\/)(locales?|i18n|copy)\//i,
];

export interface ChangeSummary {
  files: readonly string[];
  labels?: readonly string[];
}

export interface RiskDecision {
  tier: RiskTier;
  humanApprovalsRequired: number;
  reasons: string[];
}

export function globToRegExp(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i] ?? "";
    if (ch === "*" && glob[i + 1] === "*") {
      out += ".*";
      i += 1;
      if (glob[i + 1] === "/") i += 1;
    } else if (ch === "*") {
      out += "[^/]*";
    } else if (ch === "?") {
      out += "[^/]";
    } else {
      out += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${out}$`);
}

/** The tier comes from the change only. The author is deliberately not an input. */
export function classifyRiskTier(
  change: ChangeSummary,
  config: ReviewStandardConfig = DEFAULT_REVIEW_STANDARD,
): RiskDecision {
  const reasons: string[] = [];
  const ownerGlobs = config.humanRequiredPaths.map(globToRegExp);
  for (const file of change.files) {
    if (ALWAYS_HUMAN_PATTERNS.some((re) => re.test(file))) {
      reasons.push(`always-human path: ${file}`);
    } else if (ownerGlobs.some((re) => re.test(file))) {
      reasons.push(`owner-listed sensitive path: ${file}`);
    }
  }
  if (reasons.length > 0) return { tier: "human_required", humanApprovalsRequired: 1, reasons };
  if (change.files.length === 0) {
    return { tier: "medium", humanApprovalsRequired: 1, reasons: ["empty change list"] };
  }
  if (change.files.every((file) => LOW_RISK_PATTERNS.some((re) => re.test(file)))) {
    return { tier: "low", humanApprovalsRequired: 0, reasons: ["docs or copy only"] };
  }
  if (change.labels?.includes(config.flaggedAdditiveLabel)) {
    return {
      tier: "low",
      humanApprovalsRequired: 0,
      reasons: [`labelled ${config.flaggedAdditiveLabel}`],
    };
  }
  return { tier: "medium", humanApprovalsRequired: 1, reasons: ["ordinary code change"] };
}

export interface Approval {
  login: string;
  isBot: boolean;
  commitSha: string;
}

/** Bot approvals never count, and an approval only covers the commit it was given on. */
export function countHumanApprovals(approvals: readonly Approval[], headSha: string): number {
  const people = new Set<string>();
  for (const approval of approvals) {
    if (approval.isBot || approval.login.endsWith("[bot]")) continue;
    if (approval.commitSha !== headSha) continue;
    people.add(approval.login.toLowerCase());
  }
  return people.size;
}

export type FindingTag = "important" | "nit" | "pre_existing";

export interface RawFinding {
  reviewer: string;
  /** Stable key for the class of bug, e.g. "unchecked-null-return". */
  bugClass: string;
  path: string;
  line?: number;
  severity: "important" | "nit";
  /** True when the code existed before this PR. */
  preExisting: boolean;
  category?: "bug" | "security" | "style" | "diagnostics" | "cleanup";
  summary: string;
}

export interface FindingLocation {
  path: string;
  line?: number;
}

export interface ConsensusFinding {
  bugClass: string;
  tag: FindingTag;
  blocking: boolean;
  locations: FindingLocation[];
  votes: number;
  reviewers: number;
  summary: string;
}

const DROPPED_CATEGORIES = new Set(["style", "diagnostics", "cleanup"]);

/**
 * Groups raw findings by bug class, so one comment names the whole class with
 * every location, and keeps only classes a strict majority of reviewers found.
 * Style, diagnostics and cleanup findings are dropped. Security findings block.
 */
export function filterConsensusFindings(
  findings: readonly RawFinding[],
  reviewerCount: number,
): ConsensusFinding[] {
  const groups = new Map<string, RawFinding[]>();
  for (const finding of findings) {
    if (finding.category && DROPPED_CATEGORIES.has(finding.category)) continue;
    const key = finding.bugClass.trim().toLowerCase();
    const list = groups.get(key) ?? [];
    list.push(finding);
    groups.set(key, list);
  }
  const needed = Math.floor(reviewerCount / 2) + 1;
  const result: ConsensusFinding[] = [];
  for (const [bugClass, list] of groups) {
    const votes = new Set(list.map((f) => f.reviewer)).size;
    if (votes < needed) continue;
    const importantVotes = list.filter((f) => f.severity === "important").length;
    const preExistingVotes = list.filter((f) => f.preExisting).length;
    const tag: FindingTag =
      preExistingVotes * 2 > list.length
        ? "pre_existing"
        : importantVotes * 2 > list.length
          ? "important"
          : "nit";
    const security = list.some((f) => f.category === "security");
    const seen = new Set<string>();
    const locations: FindingLocation[] = [];
    for (const f of list) {
      const loc = `${f.path}:${f.line ?? ""}`;
      if (seen.has(loc)) continue;
      seen.add(loc);
      locations.push(f.line === undefined ? { path: f.path } : { path: f.path, line: f.line });
    }
    result.push({
      bugClass,
      tag,
      blocking: security || tag === "important",
      locations,
      votes,
      reviewers: reviewerCount,
      summary: list[0]?.summary ?? bugClass,
    });
  }
  const order: Record<FindingTag, number> = { important: 0, nit: 1, pre_existing: 2 };
  return result.sort((a, b) => order[a.tag] - order[b.tag] || b.votes - a.votes);
}

export interface RoundPlan {
  round: number;
  scope: "full" | "diff_only";
  askAuthorToReconsider: boolean;
  findings: ConsensusFinding[];
  suppressedRepeats: number;
}

/** Round cap: full review up to maxFullRounds, then diff-only, and never repeat a posted class. */
export function planReviewRound(
  round: number,
  findings: readonly ConsensusFinding[],
  alreadyPostedClasses: ReadonlySet<string>,
  config: ReviewStandardConfig = DEFAULT_REVIEW_STANDARD,
): RoundPlan {
  const fresh = findings.filter((f) => !alreadyPostedClasses.has(f.bugClass));
  return {
    round,
    scope: round > config.maxFullRounds ? "diff_only" : "full",
    askAuthorToReconsider: round === config.maxFullRounds + 1,
    findings: fresh,
    suppressedRepeats: findings.length - fresh.length,
  };
}

export type FindingOutcome = "fixed" | "wrong" | "intentional" | "not_important" | "open";

export interface NoiseSummary {
  total: number;
  outcomes: Record<FindingOutcome, number>;
  /** Share of answered findings the author said were wrong or did not matter. */
  noiseRate: number;
}

export function summariseNoise(outcomes: readonly FindingOutcome[]): NoiseSummary {
  const counts: Record<FindingOutcome, number> = {
    fixed: 0,
    wrong: 0,
    intentional: 0,
    not_important: 0,
    open: 0,
  };
  for (const outcome of outcomes) counts[outcome] += 1;
  const answered = outcomes.length - counts.open;
  const noisy = counts.wrong + counts.not_important;
  return { total: outcomes.length, outcomes: counts, noiseRate: answered ? noisy / answered : 0 };
}

export interface BreakerThresholds {
  windowDays: number;
  minMerges: number;
  maxRevertRate: number;
  maxIncidents: number;
}

export const DEFAULT_BREAKER: BreakerThresholds = {
  windowDays: 14,
  minMerges: 10,
  maxRevertRate: 0.05,
  maxIncidents: 1,
};

export interface BreakerInput {
  autoMerged: number;
  reverted: number;
  incidents: number;
}

export interface BreakerDecision {
  tripped: boolean;
  revertRate: number;
  reason: string;
}

/** Trips when the revert rate or incident count over the window rises past the threshold. */
export function evaluateCircuitBreaker(
  input: BreakerInput,
  thresholds: BreakerThresholds = DEFAULT_BREAKER,
): BreakerDecision {
  const revertRate = input.autoMerged ? input.reverted / input.autoMerged : 0;
  if (input.incidents > thresholds.maxIncidents) {
    return {
      tripped: true,
      revertRate,
      reason: `${input.incidents} incidents in ${thresholds.windowDays}d`,
    };
  }
  if (input.autoMerged >= thresholds.minMerges && revertRate > thresholds.maxRevertRate) {
    return {
      tripped: true,
      revertRate,
      reason: `revert rate ${(revertRate * 100).toFixed(1)}% over ${thresholds.windowDays}d`,
    };
  }
  return { tripped: false, revertRate, reason: "within thresholds" };
}

export interface AutoMergeVerdict {
  eligible: boolean;
  reason: string;
}

/** Whether a PR could merge without a human. Phase 1 never acts on this; it only reports. */
export function wouldAutoMerge(input: {
  config: ReviewStandardConfig;
  risk: RiskDecision;
  ciGreen: boolean;
  openBlockingFindings: number;
  unresolvedThreads: number;
  breakerTripped: boolean;
}): AutoMergeVerdict {
  if (input.config.mode === "off") return { eligible: false, reason: "review standard off" };
  if (input.risk.tier !== "low") return { eligible: false, reason: `tier ${input.risk.tier}` };
  if (input.breakerTripped) return { eligible: false, reason: "circuit breaker tripped" };
  if (!input.ciGreen) return { eligible: false, reason: "CI not green" };
  if (input.openBlockingFindings > 0) return { eligible: false, reason: "open blocking findings" };
  if (input.unresolvedThreads > 0) return { eligible: false, reason: "unresolved threads" };
  return { eligible: true, reason: "dry run: would auto-merge" };
}

const ReviewStandardInput = Schema.Struct({
  mode: Schema.optional(Schema.Literal(...REVIEW_STANDARD_MODES)),
  human_required_paths: Schema.optional(Schema.Array(Schema.NonEmptyString)),
  flagged_additive_label: Schema.optional(Schema.NonEmptyString),
  reviewer_count: Schema.optional(Schema.Int.pipe(Schema.between(1, 7))),
  max_full_rounds: Schema.optional(Schema.Int.pipe(Schema.between(1, 5))),
});

/** Parses the `review_standard` profile block at the config I/O boundary. */
export function parseReviewStandardConfig(input: ConfigInput, label: string): ReviewStandardConfig {
  if (input === undefined) return { ...DEFAULT_REVIEW_STANDARD };
  let raw: typeof ReviewStandardInput.Type;
  try {
    raw = Schema.decodeUnknownSync(ReviewStandardInput, { onExcessProperty: "error" })(input);
  } catch (cause) {
    throw new Error(
      `${label} is invalid: mode must be one of: ${REVIEW_STANDARD_MODES.join(", ")}; reviewer_count 1 to 7; max_full_rounds 1 to 5`,
      { cause },
    );
  }
  return {
    mode: raw.mode ?? DEFAULT_REVIEW_STANDARD.mode,
    humanRequiredPaths: raw.human_required_paths ?? [],
    flaggedAdditiveLabel:
      raw.flagged_additive_label ?? DEFAULT_REVIEW_STANDARD.flaggedAdditiveLabel,
    reviewerCount: raw.reviewer_count ?? DEFAULT_REVIEW_STANDARD.reviewerCount,
    maxFullRounds: raw.max_full_rounds ?? DEFAULT_REVIEW_STANDARD.maxFullRounds,
  };
}
