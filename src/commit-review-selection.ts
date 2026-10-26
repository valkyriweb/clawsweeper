import { runText } from "./command.js";

export interface SyncMergeFilterResult {
  commits: string[];
  skippedMerges: string[];
  skippedUpstreamCommits: string[];
}

export type GitRunner = (args: string[]) => string;

const FIELD = "\x1f";

export function gitRunnerFor(targetDir: string): GitRunner {
  return (args) => runText("git", args, { cwd: targetDir });
}

interface CommitLine {
  sha: string;
  parents: string[];
  subject: string;
}

function parseCommitLines(raw: string): CommitLine[] {
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [sha = "", parentList = "", ...subjectParts] = line.split(FIELD);
      return {
        sha,
        parents: parentList.split(/\s+/).filter(Boolean),
        subject: subjectParts.join(FIELD),
      };
    });
}

const LOG_FORMAT = `--format=%H${FIELD}%P${FIELD}%s`;

// Drop upstream-sync merges from a commit-review range. A commit is a sync merge
// when it has two or more parents and its subject matches `pattern`. The merge
// itself is dropped, and so is every commit it brought in through a non-first
// parent (reachable from that parent but not from the first parent), with one
// exception: fork work on a sync branch. When the merged parent's own
// first-parent line contains another sync merge (a sync PR branch that merged
// upstream, then fixed conflicts), that line is fork-authored: its commits stay
// in the review and only the inner merge and its upstream side are dropped. A
// merged parent with no sync merge on its first-parent line is treated as
// upstream itself (for example `automation/upstream-sync`, which points straight
// at upstream/master), so all of it is dropped.
// Everything else in the range keeps its original order, including fork commits
// pushed alongside the sync and ordinary PR merges with their branch commits.
// No pattern means the feature is off and git is never called.
export function filterUpstreamSyncMerges(
  commits: readonly string[],
  pattern: string | undefined,
  git: GitRunner,
): SyncMergeFilterResult {
  if (!pattern || commits.length === 0) {
    return { commits: [...commits], skippedMerges: [], skippedUpstreamCommits: [] };
  }
  const matcher = new RegExp(pattern);
  const isSyncMerge = (commit: CommitLine) =>
    commit.parents.length >= 2 && matcher.test(commit.subject);
  const dropped = new Set<string>();
  const keptForkFixups = new Set<string>();
  const merges = new Set<string>();
  for (const commit of parseCommitLines(
    git(["log", "--no-walk=unsorted", LOG_FORMAT, ...commits]),
  )) {
    if (!isSyncMerge(commit)) continue;
    merges.add(commit.sha);
    const [firstParent, ...mergedParents] = commit.parents;
    for (const parent of mergedParents) {
      const branchLine = parseCommitLines(
        git(["log", "--first-parent", LOG_FORMAT, parent, `^${firstParent}`]),
      );
      if (branchLine.some(isSyncMerge)) {
        for (const line of branchLine) if (!isSyncMerge(line)) keptForkFixups.add(line.sha);
      }
      for (const sha of git(["rev-list", parent, `^${firstParent}`]).split("\n")) {
        if (sha) dropped.add(sha);
      }
    }
  }
  const kept: string[] = [];
  const skippedMerges: string[] = [];
  const skippedUpstreamCommits: string[] = [];
  for (const sha of commits) {
    if (merges.has(sha)) skippedMerges.push(sha);
    else if (dropped.has(sha) && !keptForkFixups.has(sha)) skippedUpstreamCommits.push(sha);
    else kept.push(sha);
  }
  return { commits: kept, skippedMerges, skippedUpstreamCommits };
}
