/**
 * Deterministic policy for passing clean, low-risk pull requests.
 *
 * A small change is considered reversible as a single Git revert when it
 * touches at most three files and changes at most 40 lines. This policy fails
 * closed when the file list is incomplete or the repository has no explicit
 * full-automation policy.
 */
export interface LowRiskPullRequestVerdictInput {
  headSha: string;
  reviewComplete: boolean;
  reviewFindings: number;
  overallCorrectness: string;
  automationPolicy: string;
  sensitiveRepository: boolean;
  filePaths: readonly string[];
  filesTruncated: boolean;
  additions: number;
  deletions: number;
}

const MAX_SMALL_CHANGE_FILES = 3;
const MAX_SMALL_CHANGE_LINES = 40;

const DEPENDENCY_FILE_PATTERNS = [
  /(^|\/)(package\.json|pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?)$/i,
  /(^|\/)(go\.mod|go\.sum|cargo\.toml|cargo\.lock|composer\.json|composer\.lock|gemfile|gemfile\.lock|poetry\.lock|uv\.lock|requirements[^/]*\.txt)$/i,
  /(^|\/)(pyproject\.toml|pipfile|pipfile\.lock|gradle\.lockfile)$/i,
];

const SENSITIVE_PATH_TOKEN =
  /(^|[\\/_.-])(auth|authn|authz|authentication|authorization|authoriz(?:e|ed|ing)|security|secret|secrets|credential|credentials|infra|infrastructure|migration|migrations|terraform|kubernetes|k8s|deploy|deployment)(?=$|[\\/_.-])/i;

function isBlockedPath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/").replace(/^\.\//, "");
  return (
    !normalized ||
    normalized.startsWith("/") ||
    normalized.split("/").some((part) => part === "..") ||
    SENSITIVE_PATH_TOKEN.test(normalized) ||
    /(^|\/)\.env(?:\.|$)/i.test(normalized) ||
    /\.(pem|key|p12|pfx)$/i.test(normalized)
  );
}

function isDocumentationPath(path: string): boolean {
  return (
    /(^|\/)(docs?|documentation)(\/|$)/i.test(path) ||
    /(^|\/)(readme|changelog|contributing|license)(\.[^/]+)?$/i.test(path) ||
    /\.(md|mdx|rst|adoc|txt)$/i.test(path)
  );
}

function isTestPath(path: string): boolean {
  return (
    /(^|\/)(__tests__|tests?|specs?)(\/|$)/i.test(path) ||
    /\.(test|spec)\.[^/]+$/i.test(path) ||
    /\.snap$/i.test(path)
  );
}

function isCiPath(path: string): boolean {
  return (
    /^\.github\/(workflows|actions)\//i.test(path) ||
    /^\.(circleci|buildkite)\//i.test(path) ||
    /^\.gitlab\/ci\//i.test(path) ||
    /(^|\/)(\.travis\.yml|azure-pipelines\.yml|jenkinsfile)$/i.test(path)
  );
}

function onlyLowRiskFileTypes(filePaths: readonly string[]): boolean {
  return filePaths.every((path) => {
    const normalized = path.replaceAll("\\", "/").replace(/^\.\//, "");
    if (isBlockedPath(normalized)) return false;
    return (
      isDocumentationPath(normalized) ||
      isTestPath(normalized) ||
      isCiPath(normalized) ||
      DEPENDENCY_FILE_PATTERNS.some((pattern) => pattern.test(normalized))
    );
  });
}

export function shouldPassLowRiskPullRequest(input: LowRiskPullRequestVerdictInput): boolean {
  if (
    !input.headSha.trim() ||
    input.headSha === "unknown" ||
    !input.reviewComplete ||
    input.reviewFindings !== 0 ||
    input.overallCorrectness !== "patch is correct" ||
    input.automationPolicy !== "full" ||
    input.sensitiveRepository ||
    input.filesTruncated ||
    input.filePaths.length === 0 ||
    input.filePaths.some(isBlockedPath)
  ) {
    return false;
  }

  if (onlyLowRiskFileTypes(input.filePaths)) return true;

  const lineCount = input.additions + input.deletions;
  return (
    input.filePaths.length <= MAX_SMALL_CHANGE_FILES &&
    Number.isSafeInteger(input.additions) &&
    Number.isSafeInteger(input.deletions) &&
    input.additions >= 0 &&
    input.deletions >= 0 &&
    lineCount <= MAX_SMALL_CHANGE_LINES
  );
}
