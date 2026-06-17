import { test } from "node:test";
import assert from "node:assert/strict";

import { commentMatchesExisting } from "../../dist/repair/comment-match.js";

test("commentMatchesExisting: undefined or empty comment body never matches", () => {
  assert.equal(commentMatchesExisting(undefined, "marker", "body"), false);
  assert.equal(commentMatchesExisting("", "marker", "body"), false);
  // Bug-fix assertion: an empty marker must NOT turn this into a match-everything
  // predicate (the original inline helper did `body.includes("")` -> always true).
  assert.equal(commentMatchesExisting(undefined, "", "body"), false);
  assert.equal(commentMatchesExisting("", "", "body"), false);
});

test("commentMatchesExisting: non-empty marker contained in the comment matches", () => {
  assert.equal(
    commentMatchesExisting("some text <!-- cw:abc --> more", "<!-- cw:abc -->", "different body"),
    true,
  );
});

test("commentMatchesExisting: marker present but absent from comment, bodies differ -> no match", () => {
  assert.equal(commentMatchesExisting("unrelated comment", "<!-- cw:abc -->", "the body"), false);
});

test("commentMatchesExisting: empty marker falls back to exact body equality", () => {
  assert.equal(commentMatchesExisting("identical body", "", "identical body"), true);
  assert.equal(commentMatchesExisting("a different comment", "", "identical body"), false);
});

test("commentMatchesExisting: exact body match wins even with a non-empty, absent marker", () => {
  assert.equal(commentMatchesExisting("exact body", "<!-- cw:missing -->", "exact body"), true);
});
