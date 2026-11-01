import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const script = resolve("scripts/revert-rehearsal.sh");
const isolatedGitEnv = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "fixture",
  GIT_AUTHOR_EMAIL: "fixture@invalid",
  GIT_COMMITTER_NAME: "fixture",
  GIT_COMMITTER_EMAIL: "fixture@invalid",
};

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "revert-rehearsal-test-"));
  const repo = join(root, "repo");
  mkdirSync(repo);
  const env = { ...process.env, ...isolatedGitEnv };
  const git = (...args: string[]) => {
    const result = spawnSync("git", args, { cwd: repo, encoding: "utf8", env });
    assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
    return result.stdout.trim();
  };
  git("init", "--quiet", "--initial-branch=main");
  writeFileSync(join(repo, "README.md"), "base\n");
  writeFileSync(join(repo, "tool.sh"), "echo tool\n");
  writeFileSync(join(repo, "old.txt"), "to be renamed\n");
  git("add", ".");
  git("commit", "--quiet", "-m", "base");
  return {
    root,
    repo,
    git,
    run(args: string[], extraEnv: Record<string, string> = {}) {
      const summary = join(root, "summary.md");
      writeFileSync(summary, "");
      return spawnSync("bash", [script, ...args], {
        cwd: repo,
        encoding: "utf8",
        env: { ...env, GITHUB_STEP_SUMMARY: summary, ...extraEnv },
      });
    },
  };
}

test("passes for a change with binary, symlink, mode, gitlink and rename edits", () => {
  const f = fixture();
  try {
    const base = f.git("rev-parse", "HEAD");
    f.git("checkout", "--quiet", "-b", "feature");
    writeFileSync(join(f.repo, "README.md"), "base\nfeature line\n");
    writeFileSync(join(f.repo, "blob.bin"), Buffer.from([0, 1, 2, 255, 0, 10]));
    symlinkSync("README.md", join(f.repo, "link"));
    chmodSync(join(f.repo, "tool.sh"), 0o755);
    f.git("mv", "old.txt", "new.txt");
    f.git("add", "-A");
    f.git("update-index", "--add", "--cacheinfo", `160000,${base},vendor/sub`);
    f.git("commit", "--quiet", "-m", "feature");
    const head = f.git("rev-parse", "HEAD");

    const result = f.run([base, head]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /## revert-rehearsal: PASS/);
    assert.match(
      result.stdout,
      new RegExp(`Base tree \\| \`${f.git("rev-parse", "main^{tree}")}\``),
    );
    assert.match(result.stdout, /Revert restored the base tree exactly\./);
    assert.match(result.stdout, /git revert <merge sha>/);
    assert.equal(f.git("branch", "--list", "revert-rehearsal/*"), "");
    assert.equal(
      f
        .git("worktree", "list", "--porcelain")
        .split("\n")
        .filter((l) => l.startsWith("worktree ")).length,
      1,
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("passes and says so when the head adds nothing to the base", () => {
  const f = fixture();
  try {
    const base = f.git("rev-parse", "HEAD");
    const result = f.run([base, base]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /## revert-rehearsal: PASS/);
    assert.match(result.stdout, /Empty diff/);
    assert.match(result.stdout, /Squash sha \(rehearsal\) \| `none`/);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("fails with the conflicting path when the head does not squash onto the base", () => {
  const f = fixture();
  try {
    f.git("checkout", "--quiet", "-b", "feature");
    writeFileSync(join(f.repo, "README.md"), "feature\n");
    f.git("commit", "--quiet", "-am", "feature");
    f.git("checkout", "--quiet", "main");
    writeFileSync(join(f.repo, "README.md"), "main moved\n");
    f.git("commit", "--quiet", "-am", "main");

    const result = f.run(["main", "feature"]);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /## revert-rehearsal: FAIL/);
    assert.match(result.stdout, /Conflicting paths: README\.md/);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

// Reverting the tip commit always restores its parent's tree in plain git, so a
// mismatch only comes from tooling around git. This shim models that tooling:
// after a successful revert it amends a stray file into the revert commit.
test("fails when the revert commit does not restore the base tree", () => {
  const f = fixture();
  try {
    const base = f.git("rev-parse", "HEAD");
    f.git("checkout", "--quiet", "-b", "feature");
    writeFileSync(join(f.repo, "README.md"), "feature\n");
    f.git("commit", "--quiet", "-am", "feature");
    const head = f.git("rev-parse", "HEAD");

    const realGit = spawnSync("bash", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
    const bin = join(f.root, "bin");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "git"),
      `#!/usr/bin/env bash
"$REAL_GIT" "$@" || exit
dir=.; prev=; is_revert=
for arg in "$@"; do
  [ "$prev" = -C ] && dir="$arg"
  [ "$arg" = revert ] && is_revert=1
  prev="$arg"
done
if [ -n "$is_revert" ]; then
  echo stray >"$dir/stray.txt"
  "$REAL_GIT" -C "$dir" add stray.txt
  "$REAL_GIT" -C "$dir" commit --quiet --amend --no-edit
fi
`,
      { mode: 0o755 },
    );

    const result = f.run([base, head], { PATH: `${bin}:${process.env.PATH}`, REAL_GIT: realGit });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /## revert-rehearsal: FAIL/);
    assert.match(result.stdout, /Paths that differ: stray\.txt/);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("repository hooks cannot change the rehearsal commits", () => {
  const f = fixture();
  try {
    const base = f.git("rev-parse", "HEAD");
    f.git("checkout", "--quiet", "-b", "feature");
    writeFileSync(join(f.repo, "README.md"), "feature\n");
    f.git("commit", "--quiet", "-am", "feature");
    const head = f.git("rev-parse", "HEAD");
    writeFileSync(
      join(f.repo, ".git", "hooks", "post-commit"),
      `#!/usr/bin/env bash
[ -e hook.txt ] || { echo hook >hook.txt && git add hook.txt && git commit --quiet --amend --no-edit; }
`,
      { mode: 0o755 },
    );

    const result = f.run([base, head]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /## revert-rehearsal: PASS/);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("names the missing commit when a sha is not in the checkout", () => {
  const f = fixture();
  try {
    const result = f.run(["0".repeat(40), "HEAD"]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /base commit 0{40} is not in this checkout/);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
