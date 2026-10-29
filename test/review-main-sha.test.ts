import assert from "node:assert/strict";
import test from "node:test";

import { resolveMainSha } from "../src/review-main-sha.ts";

test("uses the existing origin/main when the refresh fetch fails on a private repo", () => {
  const warnings: string[] = [];
  const sha = resolveMainSha(
    (args) => {
      if (args[0] === "fetch") {
        throw new Error(
          "fatal: could not read Username for 'https://github.com': No such device or address",
        );
      }
      assert.deepEqual(args, ["rev-parse", "origin/main"]);
      return "abc123";
    },
    (message) => warnings.push(message),
  );
  assert.equal(sha, "abc123");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /could not read Username/);
});

test("refreshes origin/main before resolving it when the fetch works", () => {
  const calls: string[] = [];
  const sha = resolveMainSha((args) => {
    calls.push(args[0]);
    return args[0] === "rev-parse" ? "def456" : "";
  });
  assert.equal(sha, "def456");
  assert.deepEqual(calls, ["fetch", "rev-parse"]);
});

test("still fails when origin/main does not exist", () => {
  assert.throws(() =>
    resolveMainSha(
      () => {
        throw new Error("unknown revision");
      },
      () => {},
    ),
  );
});
