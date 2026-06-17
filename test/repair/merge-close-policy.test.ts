import { test } from "node:test";
import assert from "node:assert/strict";
import { validateClosePolicy, validateMergePolicy } from "../../dist/repair/merge-close-policy.js";

// Characterization tests: these pin the CURRENT behavior of the merge/close
// safety gates so a later refactor cannot silently weaken them.

test("validateMergePolicy: allows a well-formed merge_candidate", () => {
  assert.equal(
    validateMergePolicy({
      job: { frontmatter: { allowed_actions: ["merge"], allow_merge: true } },
      action: { action: "merge_candidate" },
    }),
    "",
  );
});

test("validateMergePolicy: allows merge_canonical", () => {
  assert.equal(
    validateMergePolicy({
      job: { frontmatter: { allowed_actions: ["merge"], allow_merge: true } },
      action: { action: "merge_canonical" },
    }),
    "",
  );
});

test("validateMergePolicy: blocks when merge not in allowed_actions", () => {
  assert.equal(
    validateMergePolicy({
      job: { frontmatter: { allowed_actions: ["comment"], allow_merge: true } },
      action: { action: "merge_candidate" },
    }),
    "job does not allow merge",
  );
});

test("validateMergePolicy: blocks when merge is in blocked_actions", () => {
  assert.equal(
    validateMergePolicy({
      job: {
        frontmatter: { allowed_actions: ["merge"], blocked_actions: ["merge"], allow_merge: true },
      },
      action: { action: "merge_candidate" },
    }),
    "merge is blocked by job frontmatter",
  );
});

test("validateMergePolicy: blocks when allow_merge is not true", () => {
  assert.equal(
    validateMergePolicy({
      job: { frontmatter: { allowed_actions: ["merge"] } },
      action: { action: "merge_candidate" },
    }),
    "merge requires allow_merge: true",
  );
});

test("validateMergePolicy: blocks an unsupported merge action", () => {
  assert.equal(
    validateMergePolicy({
      job: { frontmatter: { allowed_actions: ["merge"], allow_merge: true } },
      action: { action: "comment" },
    }),
    "unsupported merge action",
  );
});

test("validateClosePolicy: allows a permitted low-signal close", () => {
  assert.equal(
    validateClosePolicy({
      job: { frontmatter: { allowed_actions: ["close", "comment"] } },
      actionName: "close_low_signal",
    }),
    "",
  );
});

test("validateClosePolicy: blocks when close not allowed", () => {
  assert.equal(
    validateClosePolicy({
      job: { frontmatter: { allowed_actions: ["comment"] } },
      actionName: "close_low_signal",
    }),
    "job does not allow close",
  );
});

test("validateClosePolicy: blocks when comment not allowed", () => {
  assert.equal(
    validateClosePolicy({
      job: { frontmatter: { allowed_actions: ["close"] } },
      actionName: "close_low_signal",
    }),
    "job does not allow close comments",
  );
});

test("validateClosePolicy: blocks when close is in blocked_actions", () => {
  assert.equal(
    validateClosePolicy({
      job: { frontmatter: { allowed_actions: ["close", "comment"], blocked_actions: ["close"] } },
      actionName: "close_low_signal",
    }),
    "close is blocked by job frontmatter",
  );
});

test("validateClosePolicy: blocks when comment is in blocked_actions", () => {
  assert.equal(
    validateClosePolicy({
      job: { frontmatter: { allowed_actions: ["close", "comment"], blocked_actions: ["comment"] } },
      actionName: "close_low_signal",
    }),
    "comment is blocked by job frontmatter",
  );
});

test("validateClosePolicy: instant close requires allow_instant_close for other actions", () => {
  assert.equal(
    validateClosePolicy({
      job: { frontmatter: { allowed_actions: ["close", "comment"] } },
      actionName: "manual_close",
    }),
    "instant close requires allow_instant_close: true",
  );
});

test("validateClosePolicy: instant close allowed when allow_instant_close is true", () => {
  assert.equal(
    validateClosePolicy({
      job: { frontmatter: { allowed_actions: ["close", "comment"], allow_instant_close: true } },
      actionName: "manual_close",
    }),
    "",
  );
});
