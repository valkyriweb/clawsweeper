export type GitRunner = (args: string[]) => string;

/**
 * Resolve origin/main for the target checkout.
 *
 * The review workflow checks the target out with fetch-depth 0 and
 * persist-credentials false, so origin/main is already present but a later
 * unauthenticated fetch fails on private repositories. The refresh fetch is
 * therefore best-effort: local runs still get a fresh origin/main, and CI
 * falls back to the ref the checkout already wrote.
 */
export function resolveMainSha(
  git: GitRunner,
  warn: (message: string) => void = (message) => console.error(message),
): string {
  try {
    git(["fetch", "origin", "main", "--depth=50"]);
  } catch (error) {
    const reason = error instanceof Error ? error.message.split("\n")[0] : String(error);
    warn(`[review] could not refresh origin/main, using existing ref: ${reason}`);
  }
  return git(["rev-parse", "origin/main"]);
}
