export class GitHubItemMovedError extends Error {
  constructor(repository: string, number: number, actual: string) {
    super(`GitHub moved ${repository}#${number} to ${actual}.`);
    this.name = "GitHubItemMovedError";
  }
}

export function assertGitHubItemIdentity(
  value: { number?: unknown; html_url?: unknown },
  repository: string,
  number: number,
): void {
  let url: URL | undefined;
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Parse GitHub's wire identity here; reject non-string URLs before URL coercion.
  if (typeof value.html_url === "string") {
    try {
      url = new URL(value.html_url);
    } catch {
      // Invalid URLs fail the identity check below.
    }
  }
  const match = url && /^\/([^/]+)\/([^/]+)\/(?:issues|pull)\/([1-9]\d*)$/.exec(url.pathname);
  if (!match || !Number.isSafeInteger(value.number) || Number(match[3]) !== value.number) {
    throw new Error(`GitHub returned an invalid item identity for ${repository}#${number}.`);
  }
  const actualRepository = `${match[1]}/${match[2]}`;
  if (actualRepository.toLowerCase() !== repository.toLowerCase() || value.number !== number) {
    throw new GitHubItemMovedError(repository, number, `${actualRepository}#${value.number}`);
  }
}
