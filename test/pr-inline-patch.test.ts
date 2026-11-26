import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildInlinePatch } from "../dist/pr-inline-patch.js";

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

function fixture(headContent: string): { dir: string; base: string; head: string } {
  const dir = mkdtempSync(join(tmpdir(), "inline-patch-"));
  git(dir, "init", "-q");
  writeFileSync(join(dir, "CONTRIBUTING.md"), "# Contributing\n\nOld rule.\n");
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "base");
  const base = git(dir, "rev-parse", "HEAD");
  writeFileSync(join(dir, "CONTRIBUTING.md"), headContent);
  writeFileSync(join(dir, "NEW.md"), "brand new\n");
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "head");
  return { dir, base, head: git(dir, "rev-parse", "HEAD") };
}

test("inline patch includes the full diff and base versions of modified files", () => {
  const { dir, base, head } = fixture("# Contributing\n\nNew rule from the PR.\n");
  try {
    const result = buildInlinePatch({ targetDir: dir, baseSha: base, sha: head });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.match(result.markdown, /\+New rule from the PR\./);
    assert.match(result.markdown, /-Old rule\./);
    assert.match(result.markdown, /\+brand new/);
    assert.match(result.markdown, /### CONTRIBUTING\.md\n\n````\n# Contributing\n\nOld rule\./);
    assert.doesNotMatch(result.markdown, /### NEW\.md/);
    assert.match(result.markdown, /do not run commands/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("inline patch fails closed when the diff exceeds the cap", () => {
  const { dir, base, head } = fixture(`${"x".repeat(5000)}\n`);
  try {
    const result = buildInlinePatch({ targetDir: dir, baseSha: base, sha: head, maxBytes: 1000 });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.ok(result.bytes > 1000);
    assert.match(result.detail, /^PR too large for automatic review/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("base files that would break the cap are omitted, not fatal", () => {
  const { dir, base, head } = fixture("# Contributing\n\nTiny.\n");
  try {
    const patchOnly = buildInlinePatch({ targetDir: dir, baseSha: base, sha: head });
    assert.equal(patchOnly.ok, true);
    if (!patchOnly.ok) return;
    const diffBytes = Buffer.byteLength(git(dir, "diff", `${base}..${head}`), "utf8");
    const result = buildInlinePatch({
      targetDir: dir,
      baseSha: base,
      sha: head,
      maxBytes: diffBytes + 5,
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.match(result.markdown, /1 base file\(s\) omitted/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
