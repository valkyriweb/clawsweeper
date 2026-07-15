import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type RepositoryItemKind = "issue" | "pull_request";
export type RepositoryCloseReason =
  | "implemented_on_main"
  | "mostly_implemented_on_main"
  | "cannot_reproduce"
  | "clawhub"
  | "duplicate_or_superseded"
  | "not_actionable_in_repo"
  | "incoherent"
  | "stale_insufficient_info"
  | "none";

export type ReviewProvider = "codex" | "claude-bridge" | "claude-code" | "pi";

export type ReviewProviderModels = Record<ReviewProvider, string>;

/** Per-target authorization for automation that can change a target repository. */
export type AutomationPolicy = "full" | "review_only";
export type AutomationCapability =
  | "repair"
  | "branch_push"
  | "pull_request"
  | "merge"
  | "close"
  | "label";

export interface AutomationCapabilities {
  review: true;
  proposals: true;
  repair: boolean;
  branchPush: boolean;
  pullRequest: boolean;
  merge: boolean;
  close: boolean;
  labels: boolean;
}

export type DocsMaintainerMode = "autofix" | "precheck";

export interface DocsMaintainerMapEntry {
  code: readonly string[];
  docs: readonly string[];
}

export interface DocsMaintainerConfig {
  enabled: boolean;
  ownedDocs: readonly string[];
  docsMap: readonly DocsMaintainerMapEntry[];
  skipLabels: readonly string[];
  mode: DocsMaintainerMode;
}

export interface RepositoryProfile {
  targetRepo: string;
  slug: string;
  displayName: string;
  checkoutDir: string;
  docsUrl?: string;
  communityUrl?: string;
  promptNote: string;
  applyCloseRules: Partial<Record<RepositoryItemKind, readonly RepositoryCloseReason[]>>;
  automationPolicy: AutomationPolicy;
  docsMaintainer: DocsMaintainerConfig;
  // Optional per-target override of the review provider. Highest-precedence
  // input to `resolveReviewProvider()`; lets one repo opt out of (or back
  // into) the global default without touching the workflow or the repo var.
  reviewProvider?: ReviewProvider;
  // Per-target opt-in for reviewing maintainer-authored (OWNER/MEMBER/
  // COLLABORATOR) items. Default false preserves upstream behaviour, which
  // skipped these in the planner to avoid the bot closing maintainer-filed
  // issues. Closure safety now lives in `applyCloseRules` (per-reason
  // per-target), so personal/ops repos can safely opt in here to get triage
  // on their own items. `CLAWSWEEPER_INCLUDE_MAINTAINER_AUTHORED=true` is a
  // fleet-wide override.
  includeMaintainerAuthored?: boolean;
  // Per-target git ref whose pushes commit-review accepts. Most repos ship from
  // `main`, so the absent default is `DEFAULT_COMMIT_REVIEW_REF`. Production
  // overlays that deploy from a non-default branch (e.g. paperclip's `bermont`)
  // set this so commit-review runs on the branch that actually ships instead of
  // being rejected at the branch gate. Full ref form: `refs/heads/<branch>`.
  commitReviewRef?: string;
}

interface TargetRepositoryConfig {
  schemaVersion: 2;
  repositories: readonly ConfiguredRepositoryProfile[];
  reviewRouting: ReviewRoutingConfig;
  openclawFallback?: OpenClawFallbackConfig;
}

interface ReviewRoutingConfig {
  models: ReviewProviderModels;
}

interface ConfiguredRepositoryProfile {
  targetRepo: string;
  displayName: string;
  checkoutDir: string;
  docsUrl?: string;
  communityUrl?: string;
  promptNote: string;
  applyCloseRules: Partial<Record<RepositoryItemKind, readonly RepositoryCloseReason[]>>;
  automationPolicy: AutomationPolicy;
  docsMaintainer: DocsMaintainerConfig;
  reviewProvider?: ReviewProvider;
  includeMaintainerAuthored?: boolean;
  commitReviewRef?: string;
}

// Branch whose pushes commit-review accepts when a target sets no explicit
// `commitReviewRef`. Single source of truth shared by the profile loader and
// the workflow CLI (`commit-review-ref`) so the YAML and TS agree on the default.
export const DEFAULT_COMMIT_REVIEW_REF = "refs/heads/main";

// Exported so clawsweeper.ts can use a single source of truth for the
// supported provider id set (validation in `resolveReviewProvider`).
export const REVIEW_PROVIDER_SET: ReadonlySet<ReviewProvider> = new Set([
  "codex",
  "claude-bridge",
  "claude-code",
  "pi",
]);

const DEFAULT_REVIEW_PROVIDER_MODELS: ReviewProviderModels = {
  codex: "gpt-5.5",
  "claude-bridge": "claude-opus-4-8",
  "claude-code": "claude-opus-4-8",
  pi: "claude-opus-4-8",
};

interface OpenClawFallbackConfig {
  owner: string;
  denyRepositories: readonly string[];
  allowRepoNamePattern: RegExp;
  promptNote: string;
  applyCloseRules: Partial<Record<RepositoryItemKind, readonly RepositoryCloseReason[]>>;
  automationPolicy: AutomationPolicy;
}

const OPENCLAW_CLOSE_REASONS: readonly RepositoryCloseReason[] = [
  "implemented_on_main",
  "mostly_implemented_on_main",
  "cannot_reproduce",
  "clawhub",
  "duplicate_or_superseded",
  "not_actionable_in_repo",
  "incoherent",
  "stale_insufficient_info",
];

const ALL_CLOSE_REASONS: readonly RepositoryCloseReason[] = [...OPENCLAW_CLOSE_REASONS, "none"];
const CLOSE_REASON_SET = new Set<RepositoryCloseReason>(ALL_CLOSE_REASONS);
const ITEM_KIND_SET = new Set<RepositoryItemKind>(["issue", "pull_request"]);
const DOCS_MAINTAINER_MODE_SET = new Set<DocsMaintainerMode>(["autofix", "precheck"]);
const AUTOMATION_POLICY_SET: ReadonlySet<AutomationPolicy> = new Set(["full", "review_only"]);

const FULL_AUTOMATION_CAPABILITIES: AutomationCapabilities = Object.freeze({
  review: true,
  proposals: true,
  repair: true,
  branchPush: true,
  pullRequest: true,
  merge: true,
  close: true,
  labels: true,
});

const REVIEW_ONLY_AUTOMATION_CAPABILITIES: AutomationCapabilities = Object.freeze({
  review: true,
  proposals: true,
  repair: false,
  branchPush: false,
  pullRequest: false,
  merge: false,
  close: false,
  labels: false,
});

export const DEFAULT_DOCS_MAINTAINER_CONFIG: DocsMaintainerConfig = {
  enabled: false,
  ownedDocs: ["README.md", "CHANGELOG.md", "docs/**/*.md", ".env.example"],
  docsMap: [
    {
      code: [
        ".env*",
        "config/**",
        ".github/workflows/**",
        "docker/**",
        "Dockerfile*",
        "compose*.yml",
        "k8s/**",
        "helm/**",
      ],
      docs: ["README.md", "docs/**/*.md", ".env.example"],
    },
    {
      code: ["routes/**", "src/api/**", "app/api/**", "pages/api/**", "server/routes/**"],
      docs: ["README.md", "docs/**/*.md"],
    },
  ],
  skipLabels: ["skip-docs-check", "docs-not-needed"],
  mode: "autofix",
};

export const DEFAULT_TARGET_REPO = "openclaw/openclaw";

const CORE_OPENCLAW_PROFILE: RepositoryProfile = {
  targetRepo: DEFAULT_TARGET_REPO,
  slug: "openclaw-openclaw",
  displayName: "OpenClaw",
  checkoutDir: "openclaw",
  docsUrl: "https://docs.openclaw.ai",
  communityUrl: "https://clawhub.ai/",
  promptNote:
    "Use the OpenClaw source tree, docs, changelog, and current main branch. Close proposals may use the normal OpenClaw stale/duplicate/not-in-repo/implemented-on-main policy when evidence is strong.",
  applyCloseRules: {
    issue: OPENCLAW_CLOSE_REASONS,
    pull_request: OPENCLAW_CLOSE_REASONS.filter((reason) => reason !== "stale_insufficient_info"),
  },
  automationPolicy: "full",
  docsMaintainer: DEFAULT_DOCS_MAINTAINER_CONFIG,
};

const TARGET_REPOSITORY_CONFIG = readTargetRepositoryConfig();

export const REPOSITORY_PROFILES: RepositoryProfile[] = [
  CORE_OPENCLAW_PROFILE,
  ...TARGET_REPOSITORY_CONFIG.repositories.map(configuredRepositoryProfile),
];

export function repositoryProfileFor(targetRepo: string): RepositoryProfile {
  const normalized = normalizeRepo(targetRepo);
  const profile = REPOSITORY_PROFILES.find(
    (candidate) => normalizeRepo(candidate.targetRepo) === normalized,
  );
  if (profile) return profile;

  const fallback = fallbackRepositoryProfile(normalized);
  if (fallback) return fallback;

  throw new Error(
    `Unsupported target repo: ${targetRepo}. Known repos: ${REPOSITORY_PROFILES.map((candidate) => candidate.targetRepo).join(", ")}. Generic fallback: ${fallbackDescription()}`,
  );
}

export function repositoryProfileForSlug(slug: string): RepositoryProfile | undefined {
  return REPOSITORY_PROFILES.find((candidate) => candidate.slug === slug);
}

export function normalizeRepo(targetRepo: string): string {
  return targetRepo.trim().toLowerCase();
}

const TARGET_REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/**
 * Resolve an explicitly-provided target repo, or throw. There is intentionally NO
 * fallback default: a missing target must fail fast rather than silently sweeping a
 * guessed repo (a silent "openclaw/openclaw" default caused a production 404).
 */
export function requireTargetRepo(value: unknown): string {
  const repo = typeof value === "string" ? value.trim() : "";
  if (!TARGET_REPO_PATTERN.test(repo)) {
    throw new Error(
      `No target repository specified. Pass --repo/--target-repo <owner/name> or set CLAWSWEEPER_TARGET_REPO. ` +
        `Got: ${repo ? JSON.stringify(repo) : "(empty)"}.`,
    );
  }
  return repo;
}

/**
 * Resolve target mutation capabilities without making a permissive guess.
 * Missing or unknown values are review-only, so every caller fails closed.
 */
export function resolveAutomationCapabilities(policy: unknown): AutomationCapabilities {
  return policy === "full" ? FULL_AUTOMATION_CAPABILITIES : REVIEW_ONLY_AUTOMATION_CAPABILITIES;
}

/** Return a denial instead of throwing so terminal executors can report it. */
export function automationPolicyBlockReason(
  targetRepo: unknown,
  capability: AutomationCapability,
): string | null {
  const requested = typeof targetRepo === "string" ? targetRepo.trim() : "";
  if (!TARGET_REPO_PATTERN.test(requested)) {
    return `automation policy denies ${capability}: target repository is missing or invalid`;
  }
  let profile: RepositoryProfile;
  try {
    profile = repositoryProfileFor(requested);
  } catch {
    return `automation policy denies ${capability}: unsupported target repository ${requested}`;
  }
  const capabilities = resolveAutomationCapabilities(profile.automationPolicy);
  const allowed =
    capability === "branch_push"
      ? capabilities.branchPush
      : capability === "pull_request"
        ? capabilities.pullRequest
        : capability === "label"
          ? capabilities.labels
          : capabilities[capability];
  if (allowed) return null;
  return `${profile.targetRepo} automation_policy=${profile.automationPolicy} denies ${capability}`;
}

export function isAutoCloseAllowed(
  profile: RepositoryProfile,
  kind: RepositoryItemKind,
  reason: RepositoryCloseReason,
): boolean {
  return (
    resolveAutomationCapabilities(profile.automationPolicy).close &&
    Boolean(profile.applyCloseRules[kind]?.includes(reason))
  );
}

function configuredRepositoryProfile(profile: ConfiguredRepositoryProfile): RepositoryProfile {
  const targetRepo = normalizeRepo(profile.targetRepo);
  const result: RepositoryProfile = {
    targetRepo,
    slug: slugForRepo(targetRepo),
    displayName: profile.displayName,
    checkoutDir: profile.checkoutDir,
    promptNote: profile.promptNote,
    applyCloseRules: profile.applyCloseRules,
    automationPolicy: profile.automationPolicy,
    docsMaintainer: profile.docsMaintainer,
  };
  if (profile.docsUrl) result.docsUrl = profile.docsUrl;
  if (profile.communityUrl) result.communityUrl = profile.communityUrl;
  if (profile.reviewProvider) result.reviewProvider = profile.reviewProvider;
  if (profile.includeMaintainerAuthored !== undefined) {
    result.includeMaintainerAuthored = profile.includeMaintainerAuthored;
  }
  if (profile.commitReviewRef) result.commitReviewRef = profile.commitReviewRef;
  return result;
}

function fallbackRepositoryProfile(normalizedTargetRepo: string): RepositoryProfile | undefined {
  const fallback = TARGET_REPOSITORY_CONFIG.openclawFallback;
  if (!fallback) return undefined;

  const [owner, repoName] = normalizedTargetRepo.split("/");
  if (!owner || !repoName || owner !== fallback.owner) return undefined;
  if (fallback.denyRepositories.includes(normalizedTargetRepo)) return undefined;
  if (!fallback.allowRepoNamePattern.test(repoName)) return undefined;

  return {
    targetRepo: normalizedTargetRepo,
    slug: slugForRepo(normalizedTargetRepo),
    displayName: repoName,
    checkoutDir: repoName,
    promptNote: fallback.promptNote
      .replaceAll("{target_repo}", normalizedTargetRepo)
      .replaceAll("{repo_name}", repoName),
    applyCloseRules: fallback.applyCloseRules,
    automationPolicy: fallback.automationPolicy,
    docsMaintainer: DEFAULT_DOCS_MAINTAINER_CONFIG,
  };
}

function fallbackDescription(): string {
  const fallback = TARGET_REPOSITORY_CONFIG.openclawFallback;
  if (!fallback) return "disabled";
  const denied =
    fallback.denyRepositories.length === 0 ? "" : ` except ${fallback.denyRepositories.join(", ")}`;
  return `${fallback.owner}/*${denied}`;
}

function slugForRepo(targetRepo: string): string {
  return targetRepo.replace(/[^A-Za-z0-9_.-]+/g, "-");
}

function readTargetRepositoryConfig(
  filePath = join(repoRoot(), "config", "target-repositories.json"),
): TargetRepositoryConfig {
  if (!existsSync(filePath)) {
    return { schemaVersion: 2, repositories: [], reviewRouting: defaultReviewRoutingConfig() };
  }
  const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
  return validateTargetRepositoryConfig(parsed);
}

export function reviewModelForProvider(provider: ReviewProvider): string {
  return TARGET_REPOSITORY_CONFIG.reviewRouting.models[provider];
}

export function resolveRepositoryReviewProvider(opts: {
  explicit?: string | undefined;
  env?: string | undefined;
  fallback?: ReviewProvider;
}): ReviewProvider {
  const fallback = opts.fallback ?? "codex";
  const sources: Array<{ label: string; value: string | undefined }> = [
    { label: "profile.reviewProvider", value: opts.explicit },
    { label: "CLAWSWEEPER_REVIEW_PROVIDER", value: opts.env },
  ];
  for (const { label, value } of sources) {
    if (value === undefined || value === null) continue;
    const trimmed = String(value).trim();
    if (trimmed === "") continue;
    if (!REVIEW_PROVIDER_SET.has(trimmed as ReviewProvider)) {
      throw new Error(
        `${label} has unsupported review provider: ${trimmed} (expected one of: ${[...REVIEW_PROVIDER_SET].join(", ")})`,
      );
    }
    return trimmed as ReviewProvider;
  }
  return fallback;
}

export function validateTargetRepositoryConfig(value: unknown): TargetRepositoryConfig {
  const config = record(value, "target repository config");
  const schemaVersion = numberValue(config.schema_version, "schema_version");
  if (schemaVersion !== 2)
    throw new Error(`Unsupported target repository config schema: ${schemaVersion}`);
  const repositories = arrayValue(config.repositories, "repositories").map((entry, index) =>
    validateConfiguredRepositoryProfile(entry, `repositories[${index}]`),
  );
  const result: TargetRepositoryConfig = {
    schemaVersion: 2,
    repositories,
    reviewRouting: validateReviewRoutingConfig(config.review_routing),
  };
  if (config.openclaw_fallback !== undefined) {
    result.openclawFallback = validateOpenClawFallbackConfig(config.openclaw_fallback);
  }
  return result;
}

function validateReviewRoutingConfig(value: unknown): ReviewRoutingConfig {
  if (value === undefined) return defaultReviewRoutingConfig();
  const routing = record(value, "review_routing");
  const modelsRecord = record(routing.models, "review_routing.models");
  const models = { ...DEFAULT_REVIEW_PROVIDER_MODELS };
  for (const provider of REVIEW_PROVIDER_SET) {
    if (modelsRecord[provider] !== undefined) {
      models[provider] = stringValue(modelsRecord[provider], `review_routing.models.${provider}`);
    }
  }
  return { models };
}

function defaultReviewRoutingConfig(): ReviewRoutingConfig {
  return { models: { ...DEFAULT_REVIEW_PROVIDER_MODELS } };
}

function validateConfiguredRepositoryProfile(
  value: unknown,
  label: string,
): ConfiguredRepositoryProfile {
  const profile = record(value, label);
  const result: ConfiguredRepositoryProfile = {
    targetRepo: repoValue(profile.target_repo, `${label}.target_repo`),
    displayName: stringValue(profile.display_name, `${label}.display_name`),
    checkoutDir: pathSegmentValue(profile.checkout_dir, `${label}.checkout_dir`),
    promptNote: stringValue(profile.prompt_note, `${label}.prompt_note`),
    applyCloseRules: closeRulesValue(profile.apply_close_rules, `${label}.apply_close_rules`),
    automationPolicy: automationPolicyValue(
      profile.automation_policy,
      `${label}.automation_policy`,
    ),
    docsMaintainer: docsMaintainerConfigValue(
      profile.docs_maintainer ?? profile.docsMaintainer,
      `${label}.docs_maintainer`,
    ),
  };
  if (profile.docs_url !== undefined) {
    result.docsUrl = stringValue(profile.docs_url, `${label}.docs_url`);
  }
  if (profile.community_url !== undefined) {
    result.communityUrl = stringValue(profile.community_url, `${label}.community_url`);
  }
  if (profile.review_provider !== undefined) {
    const provider = stringValue(profile.review_provider, `${label}.review_provider`);
    if (!REVIEW_PROVIDER_SET.has(provider as ReviewProvider)) {
      throw new Error(
        `${label}.review_provider must be one of: ${[...REVIEW_PROVIDER_SET].join(", ")} (got ${provider})`,
      );
    }
    result.reviewProvider = provider as ReviewProvider;
  }
  if (profile.include_maintainer_authored !== undefined) {
    if (typeof profile.include_maintainer_authored !== "boolean") {
      throw new Error(`${label}.include_maintainer_authored must be a boolean`);
    }
    result.includeMaintainerAuthored = profile.include_maintainer_authored;
  }
  if (profile.commit_review_ref !== undefined) {
    result.commitReviewRef = branchRefValue(
      profile.commit_review_ref,
      `${label}.commit_review_ref`,
    );
  }
  return result;
}

function validateOpenClawFallbackConfig(value: unknown): OpenClawFallbackConfig {
  const fallback = record(value, "openclaw_fallback");
  const pattern = stringValue(
    fallback.allow_repo_name_pattern,
    "openclaw_fallback.allow_repo_name_pattern",
  );
  return {
    owner: stringValue(fallback.owner, "openclaw_fallback.owner").toLowerCase(),
    denyRepositories: arrayValue(
      fallback.deny_repositories,
      "openclaw_fallback.deny_repositories",
    ).map((entry, index) =>
      normalizeRepo(repoValue(entry, `openclaw_fallback.deny_repositories[${index}]`)),
    ),
    allowRepoNamePattern: new RegExp(pattern),
    promptNote: stringValue(fallback.prompt_note, "openclaw_fallback.prompt_note"),
    applyCloseRules: closeRulesValue(
      fallback.apply_close_rules,
      "openclaw_fallback.apply_close_rules",
    ),
    automationPolicy: automationPolicyValue(
      fallback.automation_policy,
      "openclaw_fallback.automation_policy",
    ),
  };
}

function automationPolicyValue(value: unknown, label: string): AutomationPolicy {
  const policy = stringValue(value, label);
  if (!AUTOMATION_POLICY_SET.has(policy as AutomationPolicy)) {
    throw new Error(`${label} must be one of: ${[...AUTOMATION_POLICY_SET].join(", ")}`);
  }
  return policy as AutomationPolicy;
}

function docsMaintainerConfigValue(value: unknown, label: string): DocsMaintainerConfig {
  if (value === undefined) return DEFAULT_DOCS_MAINTAINER_CONFIG;
  const config = record(value, label);
  const result: DocsMaintainerConfig = {
    ...DEFAULT_DOCS_MAINTAINER_CONFIG,
    docsMap: DEFAULT_DOCS_MAINTAINER_CONFIG.docsMap.map((entry) => ({
      code: [...entry.code],
      docs: [...entry.docs],
    })),
  };
  if (config.enabled !== undefined) {
    if (typeof config.enabled !== "boolean") throw new Error(`${label}.enabled must be a boolean`);
    result.enabled = config.enabled;
  }
  if (config.owned_docs !== undefined || config.ownedDocs !== undefined) {
    result.ownedDocs = globListValue(config.owned_docs ?? config.ownedDocs, `${label}.owned_docs`);
  }
  if (config.docs_map !== undefined || config.docsMap !== undefined) {
    result.docsMap = arrayValue(config.docs_map ?? config.docsMap, `${label}.docs_map`).map(
      (entry, index) => docsMaintainerMapEntryValue(entry, `${label}.docs_map[${index}]`),
    );
  }
  if (config.skip_labels !== undefined || config.skipLabels !== undefined) {
    result.skipLabels = arrayValue(
      config.skip_labels ?? config.skipLabels,
      `${label}.skip_labels`,
    ).map((entry, index) => stringValue(entry, `${label}.skip_labels[${index}]`));
  }
  if (config.mode !== undefined) {
    const mode = stringValue(config.mode, `${label}.mode`);
    if (!DOCS_MAINTAINER_MODE_SET.has(mode as DocsMaintainerMode)) {
      throw new Error(`${label}.mode must be one of: ${[...DOCS_MAINTAINER_MODE_SET].join(", ")}`);
    }
    result.mode = mode as DocsMaintainerMode;
  }
  return result;
}

function docsMaintainerMapEntryValue(value: unknown, label: string): DocsMaintainerMapEntry {
  const entry = record(value, label);
  return {
    code: globListValue(entry.code, `${label}.code`),
    docs: globListValue(entry.docs, `${label}.docs`),
  };
}

function globListValue(value: unknown, label: string): readonly string[] {
  return arrayValue(value, label).map((entry, index) => safeGlobValue(entry, `${label}[${index}]`));
}

function safeGlobValue(value: unknown, label: string): string {
  const glob = stringValue(value, label).trim();
  if (
    glob.startsWith("/") ||
    glob.includes("..") ||
    hasControlCharacter(glob) ||
    /^(?:~|[A-Za-z]:)/.test(glob)
  ) {
    throw new Error(`${label} must be a repo-relative safe glob`);
  }
  return glob;
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) < 32) return true;
  }
  return false;
}

function closeRulesValue(
  value: unknown,
  label: string,
): Partial<Record<RepositoryItemKind, readonly RepositoryCloseReason[]>> {
  const rules = record(value, label);
  const result: Partial<Record<RepositoryItemKind, RepositoryCloseReason[]>> = {};
  for (const [kind, reasons] of Object.entries(rules)) {
    if (!ITEM_KIND_SET.has(kind as RepositoryItemKind)) {
      throw new Error(`${label}.${kind} has unsupported item kind`);
    }
    result[kind as RepositoryItemKind] = arrayValue(reasons, `${label}.${kind}`).map(
      (reason, index) => closeReasonValue(reason, `${label}.${kind}[${index}]`),
    );
  }
  return result;
}

function closeReasonValue(value: unknown, label: string): RepositoryCloseReason {
  const reason = stringValue(value, label) as RepositoryCloseReason;
  if (!CLOSE_REASON_SET.has(reason))
    throw new Error(`${label} has unsupported close reason: ${reason}`);
  return reason;
}

function repoValue(value: unknown, label: string): string {
  const repo = normalizeRepo(stringValue(value, label));
  if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(repo)) throw new Error(`${label} must be owner/repo`);
  return repo;
}

function branchRefValue(value: unknown, label: string): string {
  const ref = stringValue(value, label);
  const prefix = "refs/heads/";
  if (!ref.startsWith(prefix)) throw new Error(`${label} must be a refs/heads/<branch> ref`);
  // The stripped branch flows into `git fetch origin "$BRANCH"` in the workflow.
  // Beyond shell-safe characters, reject names Git treats specially or as an
  // option (leading `-` → `--upload-pack` confusion), and enforce the subset of
  // git-check-ref-format rules that matter here so a bad config value fails
  // closed at load time rather than at the fetch.
  const branch = ref.slice(prefix.length);
  const safe =
    branch !== "HEAD" &&
    !branch.startsWith("-") &&
    !branch.startsWith("/") &&
    !branch.endsWith("/") &&
    !branch.endsWith(".") &&
    !branch.includes("//") &&
    !branch.includes("..") &&
    /^[A-Za-z0-9._/-]+$/.test(branch) &&
    branch.split("/").every((part) => part && !part.startsWith(".") && !part.endsWith(".lock"));
  if (!safe) throw new Error(`${label} must be a safe refs/heads/<branch> ref`);
  return ref;
}

function pathSegmentValue(value: unknown, label: string): string {
  const segment = stringValue(value, label);
  if (!/^[A-Za-z0-9_.-]+$/.test(segment)) throw new Error(`${label} must be a safe path segment`);
  return segment;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "")
    throw new Error(`${label} must be a string`);
  return value;
}

function numberValue(value: unknown, label: string): number {
  if (typeof value !== "number") throw new Error(`${label} must be a number`);
  return value;
}

function arrayValue(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function repoRoot(): string {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}
