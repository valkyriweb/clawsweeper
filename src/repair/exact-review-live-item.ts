import { assertGitHubItemIdentity, GitHubItemMovedError } from "../github-item-identity.js";
import { ghErrorText, ghJsonWithRetry } from "./github-cli.js";

export function exactReviewLiveItemState(repository: string, number: number) {
  if (!repository || !Number.isSafeInteger(number) || number < 1) {
    throw new Error("An exact live-item check requires a repository and positive item number");
  }
  let issue: { number?: unknown; html_url?: unknown; state?: string; locked?: boolean };
  try {
    issue = ghJsonWithRetry(["api", `repos/${repository}/issues/${number}`]);
  } catch (error) {
    if (!/HTTP 404|Not Found/i.test(ghErrorText(error))) throw error;
    // A hidden repository also returns 404. Prove access before retiring an item.
    ghJsonWithRetry(["api", `repos/${repository}`]);
    return { state: "missing", locked: false };
  }
  try {
    assertGitHubItemIdentity(issue, repository, number);
  } catch (error) {
    if (!(error instanceof GitHubItemMovedError)) throw error;
    console.error(`${error.message} Completing the old identity without review or mutation.`);
    return { state: "missing", locked: false };
  }
  return { state: issue.state, locked: issue.locked === true };
}
