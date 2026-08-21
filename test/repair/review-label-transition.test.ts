import assert from "node:assert/strict";
import test from "node:test";

import {
  hasAutofixAuthorization,
  postRepairReviewLabelTransition,
} from "../../dist/repair/review-label-transition.js";

test("my-pi repair pushes hand the PR back to agentic review", () => {
  assert.deepEqual(postRepairReviewLabelTransition("lue-labs/my-pi", 1477), {
    addArgs: ["issue", "edit", "1477", "--repo", "lue-labs/my-pi", "--add-label", "agentic-review"],
    removeArgs: [
      "issue",
      "edit",
      "1477",
      "--repo",
      "lue-labs/my-pi",
      "--remove-label",
      "clawsweeper:autofix",
    ],
    removedLabel: "clawsweeper:autofix",
    addedLabel: "agentic-review",
  });
});

test("only autofix-authorized repairs enter the native review handoff", () => {
  assert.equal(hasAutofixAuthorization({ labels: [{ name: "clawsweeper:autofix" }] }), true);
  assert.equal(hasAutofixAuthorization({ labels: [{ name: "clawsweeper:automerge" }] }), false);
  assert.equal(hasAutofixAuthorization({ labels: [] }), false);
});

test("targets without a configured review handoff keep the existing repair flow", () => {
  assert.equal(postRepairReviewLabelTransition("valkyriweb/clawsweeper", 202), null);
});

test("repair review label transitions reject invalid pull request numbers", () => {
  assert.throws(() => postRepairReviewLabelTransition("lue-labs/my-pi", 0), /positive integer/);
});
