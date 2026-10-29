export type GitRunner = (args: string[]) => string;

type Warn = (message: string) => void;

const defaultWarn: Warn = (message) => console.error(message);

/**
 * Find the target repository's default branch name.
 *
 * Order: origin/HEAD (set by git clone), then the branch the checkout is on
 * when origin has a matching ref (actions/checkout without a ref checks out
 * the default branch), then "main".
 */
export function resolveDefaultBranch(git: GitRunner): string {
  try {
    const head = git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]).trim();
    if (head.startsWith("origin/") && head.length > "origin/".length) {
      return head.slice("origin/".length);
    }
  } catch {
    // origin/HEAD is not set; try the checked-out branch next.
  }
  try {
    const current = git(["rev-parse", "--abbrev-ref", "HEAD"]).trim();
    if (current && current !== "HEAD") {
      git(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${current}`]);
      return current;
    }
  } catch {
    // No matching remote ref; fall back to main.
  }
  return "main";
}

/**
 * Resolve the target's default branch head for the review checkout.
 *
 * The review workflow checks the target out with fetch-depth 0 and
 * persist-credentials false, so the default branch ref is already present but
 * a later unauthenticated fetch fails on private repositories. The refresh
 * fetch is therefore best-effort: local runs still get a fresh ref, and CI
 * falls back to the ref the checkout already wrote.
 */
export function resolveMainSha(git: GitRunner, warn: Warn = defaultWarn): string {
  const branch = resolveDefaultBranch(git);
  try {
    git(["fetch", "origin", branch, "--depth=50"]);
  } catch (error) {
    const reason = error instanceof Error ? error.message.split("\n")[0] : String(error);
    warn(`[review] could not refresh origin/${branch}, using existing ref: ${reason}`);
  }
  return git(["rev-parse", `origin/${branch}`]);
}
