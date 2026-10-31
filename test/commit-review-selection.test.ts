import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { filterUpstreamSyncMerges, gitRunnerFor } from "../dist/commit-review-selection.js";
import {
  repositoryProfileFor,
  validateTargetRepositoryConfig,
} from "../dist/repository-profiles.js";

const PAPERCLIP_PATTERN =
  repositoryProfileFor("leo-labs-ai/paperclip").commitReviewSkipMergeSubjectPattern;

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: dir,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.invalid",
      GIT_CONFIG_NOSYSTEM: "1",
      HOME: dir,
    },
  }).trim();
}

function commitFile(dir: string, file: string, message: string): string {
  writeFileSync(join(dir, file), `${message}\n`);
  git(dir, "add", file);
  git(dir, "commit", "-q", "-m", message);
  return git(dir, "rev-parse", "HEAD");
}

function mergeNoFf(dir: string, message: string, branch: string): string {
  git(dir, "merge", "-q", "--no-ff", "-m", message, branch);
  return git(dir, "rev-parse", "HEAD");
}

// master: base -> fork1 -> #145 sync PR merge (sync branch: a fork log commit,
// inner upstream merge of u1..u3, then a fork fixup) -> fork2 -> #200 direct merge of the upstream tip
// (u4) -> #9 normal PR merge (feat1).
function syncFixture() {
  const dir = mkdtempSync(join(tmpdir(), "clawsweeper-sync-"));
  git(dir, "init", "-q", "-b", "master");
  const base = commitFile(dir, "base.ts", "base");
  git(dir, "checkout", "-q", "-b", "upstream");
  const upstream = [1, 2, 3].map((n) => commitFile(dir, `upstream${n}.ts`, `upstream ${n}`));
  git(dir, "checkout", "-q", "master");
  const fork1 = commitFile(dir, "fork1.ts", "fork 1");
  git(dir, "checkout", "-q", "-b", "sync/master-upstream-260916");
  const decisionLog = commitFile(dir, "sync-log.md", "docs: upstream sync decision log");
  const innerMerge = mergeNoFf(dir, "Merge upstream/master into fork master", "upstream");
  const fixup = commitFile(dir, "fixup.ts", "fix: resolve upstream sync fallout");
  git(dir, "checkout", "-q", "master");
  const syncMerge = mergeNoFf(
    dir,
    "Merge pull request #145 from lue-labs/sync/master-upstream-260916",
    "sync/master-upstream-260916",
  );
  const fork2 = commitFile(dir, "fork2.ts", "fork 2");
  git(dir, "checkout", "-q", "upstream");
  upstream.push(commitFile(dir, "upstream4.ts", "upstream 4"));
  git(dir, "checkout", "-q", "master");
  const tipMerge = mergeNoFf(
    dir,
    "Merge pull request #200 from leo-labs-ai/automation/upstream-sync",
    "upstream",
  );
  git(dir, "checkout", "-q", "-b", "feature/x");
  const feat1 = commitFile(dir, "feat1.ts", "feature 1");
  git(dir, "checkout", "-q", "master");
  const prMerge = mergeNoFf(dir, "Merge pull request #9 from valkyriweb/feature/x", "feature/x");
  const range = git(dir, "rev-list", "--reverse", `${base}..${prMerge}`).split("\n");
  const reviewed = range.filter((sha) =>
    [fork1, decisionLog, fixup, fork2, feat1, prMerge].includes(sha),
  );
  return {
    dir,
    upstream,
    fork1,
    innerMerge,
    fixup,
    syncMerge,
    fork2,
    tipMerge,
    feat1,
    prMerge,
    range,
    reviewed,
  };
}

test("upstream-sync merge push skips the merge and the upstream commits it brings in", () => {
  const fx = syncFixture();
  try {
    assert.equal(fx.range.length, 13);
    const result = filterUpstreamSyncMerges(fx.range, PAPERCLIP_PATTERN, gitRunnerFor(fx.dir));
    assert.deepEqual(
      [...result.skippedMerges].sort(),
      [fx.innerMerge, fx.syncMerge, fx.tipMerge].sort(),
    );
    assert.deepEqual([...result.skippedUpstreamCommits].sort(), [...fx.upstream].sort());
    // Fork commits (including the sync branch's own log and fixup), the normal PR merge
    // and its branch commit are still reviewed, in push order.
    assert.deepEqual(result.commits, fx.reviewed);
    assert.equal(result.commits.length, 6);
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test("a single-commit push of a sync merge selects nothing; a fork commit is still reviewed", () => {
  const fx = syncFixture();
  try {
    const runner = gitRunnerFor(fx.dir);
    assert.deepEqual(
      filterUpstreamSyncMerges([fx.syncMerge], PAPERCLIP_PATTERN, runner).commits,
      [],
    );
    assert.deepEqual(filterUpstreamSyncMerges([fx.fork2], PAPERCLIP_PATTERN, runner).commits, [
      fx.fork2,
    ]);
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test("repos without a skip pattern review every commit and never call git", () => {
  const shas = ["a".repeat(40), "b".repeat(40)];
  const noGit = () => {
    throw new Error("git must not run when the skip pattern is unset");
  };
  assert.equal(
    repositoryProfileFor("leo-labs-ai/pi-mono").commitReviewSkipMergeSubjectPattern,
    undefined,
  );
  assert.equal(
    repositoryProfileFor("openclaw/openclaw").commitReviewSkipMergeSubjectPattern,
    undefined,
  );
  assert.deepEqual(filterUpstreamSyncMerges(shas, undefined, noGit).commits, shas);
});

test("filter-sync-merges CLI filters for paperclip and passes other targets through", () => {
  const fx = syncFixture();
  try {
    const cli = (targetRepo: string) =>
      execFileSync(
        process.execPath,
        [
          "dist/commit-sweeper.js",
          "filter-sync-merges",
          "--target-repo",
          targetRepo,
          "--target-dir",
          fx.dir,
          "--commit-shas",
          fx.range.join("\n"),
        ],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      )
        .split("\n")
        .filter(Boolean);
    assert.deepEqual(cli("leo-labs-ai/paperclip"), fx.reviewed);
    assert.deepEqual(cli("leo-labs-ai/pi-mono"), fx.range);
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test("paperclip skip pattern matches real sync merge subjects but not fork PR merges", () => {
  assert.ok(PAPERCLIP_PATTERN);
  const matcher = new RegExp(PAPERCLIP_PATTERN);
  for (const subject of [
    "Merge pull request #145 from lue-labs/sync/master-upstream-260916",
    "Merge pull request #54 from valkyriweb/sync/master-upstream-20260705",
    "Merge pull request #200 from leo-labs-ai/automation/upstream-sync",
    "Merge upstream reconciliation 260830",
    "Merge upstream/master into fork master (422 new upstream commits)",
    "Merge remote-tracking branch 'upstream/master'",
    "Merge remote-tracking branch 'upstream/master' into sync/master-upstream-20260619",
  ]) {
    assert.match(subject, matcher);
  }
  for (const subject of [
    "Merge pull request #130 from valkyriweb/active-active/003-run-fencing",
    "Merge pull request #137 from lue-labs/fix/docker-build-llm-wiki-dist",
    "fix(sync): remove duplicate recovery import",
  ]) {
    assert.doesNotMatch(subject, matcher);
  }
});

test("commit_review_skip_merge_subject_pattern rejects non-strings and invalid regexes", () => {
  const config = JSON.parse(readFileSync("config/target-repositories.json", "utf8"));
  const notString = structuredClone(config);
  notString.repositories[0].commit_review_skip_merge_subject_pattern = true;
  assert.throws(
    () => validateTargetRepositoryConfig(notString),
    /commit_review_skip_merge_subject_pattern must be a string/,
  );
  const badRegex = structuredClone(config);
  badRegex.repositories[0].commit_review_skip_merge_subject_pattern = "^Merge (";
  assert.throws(
    () => validateTargetRepositoryConfig(badRegex),
    /commit_review_skip_merge_subject_pattern must be a valid regular expression/,
  );
});
