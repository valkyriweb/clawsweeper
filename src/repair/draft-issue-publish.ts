import { runCommand, type CommandRunOptions } from "./command-runner.js";

type Run = (command: string, args: string[], options?: CommandRunOptions) => string;
type DraftTarget = { repo: string; branch: string; cwd: string; timeoutMs: number };

export function existingDraftIssuePr(target: DraftTarget, run: Run = runCommand): string {
  const pulls = JSON.parse(
    run(
      "gh",
      [
        "pr",
        "list",
        "--repo",
        target.repo,
        "--head",
        target.branch,
        "--state",
        "all",
        "--json",
        "url,isDraft,state,headRefName,headRepositoryOwner",
      ],
      target,
    ),
  );
  if (!Array.isArray(pulls)) throw new Error("invalid draft PR lookup");
  if (pulls.length === 0) return "";
  const pull = pulls[0];
  if (
    pulls.length !== 1 ||
    pull.isDraft !== true ||
    pull.state !== "OPEN" ||
    pull.headRefName !== target.branch ||
    pull.headRepositoryOwner?.login?.toLowerCase() !== target.repo.split("/")[0]?.toLowerCase()
  ) {
    throw new Error("draft-only publication refuses non-draft, closed or mismatched PRs");
  }
  return String(pull.url);
}

export function publishDraftIssuePr(
  options: DraftTarget & {
    base: string;
    title: string;
    bodyFile: string;
  },
  run: Run = runCommand,
): string {
  const existing = existingDraftIssuePr(options, run);
  const url =
    existing ||
    run(
      "gh",
      [
        "pr",
        "create",
        "--draft",
        "--repo",
        options.repo,
        "--base",
        options.base,
        "--head",
        options.branch,
        "--title",
        options.title,
        "--body-file",
        options.bodyFile,
      ],
      options,
    ).trim();
  const verified = existingDraftIssuePr(options, run);
  if (!verified || verified !== url) throw new Error("draft PR creation readback did not match");
  return verified;
}
