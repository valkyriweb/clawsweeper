import assert from "node:assert/strict";
import test from "node:test";

import { resolveDefaultBranch, resolveMainSha, type GitRunner } from "../src/review-main-sha.ts";

type Responses = Record<string, string | Error>;

function fakeGit(responses: Responses, calls: string[] = []): GitRunner {
  return (args) => {
    const key = args.join(" ");
    calls.push(key);
    const response = responses[key];
    if (response === undefined) throw new Error(`unexpected git ${key}`);
    if (response instanceof Error) throw response;
    return response;
  };
}

const noOriginHead = new Error("fatal: ref refs/remotes/origin/HEAD is not a symbolic ref");

test("uses origin/HEAD when it points at main", () => {
  const git = fakeGit({ "symbolic-ref --short refs/remotes/origin/HEAD": "origin/main" });
  assert.equal(resolveDefaultBranch(git), "main");
});

test("uses origin/HEAD when it points at master", () => {
  const git = fakeGit({ "symbolic-ref --short refs/remotes/origin/HEAD": "origin/master" });
  assert.equal(resolveDefaultBranch(git), "master");
});

test("falls back to the checked-out default branch when origin/HEAD is missing", () => {
  const git = fakeGit({
    "symbolic-ref --short refs/remotes/origin/HEAD": noOriginHead,
    "rev-parse --abbrev-ref HEAD": "master",
    "rev-parse --verify --quiet refs/remotes/origin/master": "abc",
  });
  assert.equal(resolveDefaultBranch(git), "master");
});

test("falls back to main when nothing else identifies the branch", () => {
  const git = fakeGit({
    "symbolic-ref --short refs/remotes/origin/HEAD": noOriginHead,
    "rev-parse --abbrev-ref HEAD": "HEAD",
  });
  assert.equal(resolveDefaultBranch(git), "main");
});

test("resolves origin/master for a master-default repo when the refresh fetch fails", () => {
  const warnings: string[] = [];
  const calls: string[] = [];
  const git = fakeGit(
    {
      "symbolic-ref --short refs/remotes/origin/HEAD": noOriginHead,
      "rev-parse --abbrev-ref HEAD": "master",
      "rev-parse --verify --quiet refs/remotes/origin/master": "abc",
      "fetch origin master --depth=50": new Error(
        "fatal: could not read Username for 'https://github.com': No such device or address",
      ),
      "rev-parse origin/master": "abc123",
    },
    calls,
  );
  assert.equal(
    resolveMainSha(git, (message) => warnings.push(message)),
    "abc123",
  );
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /origin\/master.*could not read Username/);
  assert.ok(!calls.some((call) => call.includes("origin/main")));
});

test("refreshes origin/main before resolving it when the fetch works", () => {
  const calls: string[] = [];
  const git = fakeGit(
    {
      "symbolic-ref --short refs/remotes/origin/HEAD": "origin/main",
      "fetch origin main --depth=50": "",
      "rev-parse origin/main": "def456",
    },
    calls,
  );
  assert.equal(resolveMainSha(git), "def456");
  assert.deepEqual(calls.slice(1), ["fetch origin main --depth=50", "rev-parse origin/main"]);
});

test("still fails when the default branch ref does not exist", () => {
  const git = fakeGit({
    "symbolic-ref --short refs/remotes/origin/HEAD": "origin/main",
    "fetch origin main --depth=50": new Error("no network"),
    "rev-parse origin/main": new Error("unknown revision"),
  });
  assert.throws(() => resolveMainSha(git, () => {}));
});
