import assert from "node:assert/strict";
import test from "node:test";

import { shouldPassLowRiskPullRequest } from "../src/review-verdict-policy.ts";

const cleanReview = {
  headSha: "abc123def456",
  reviewComplete: true,
  reviewFindings: 0,
  overallCorrectness: "patch is correct",
  automationPolicy: "full",
  sensitiveRepository: false,
  filesTruncated: false,
  additions: 0,
  deletions: 0,
} as const;

test("clean dependency, documentation, test, and CI changes are two-way-door passes", () => {
  for (const filePath of [
    "package.json",
    "pnpm-lock.yaml",
    "docs/usage.md",
    "test/review-verdict-policy.test.ts",
    ".github/workflows/ci.yml",
  ]) {
    assert.equal(
      shouldPassLowRiskPullRequest({ ...cleanReview, filePaths: [filePath] }),
      true,
      filePath,
    );
  }
});

test("small ordinary code changes pass only within the reversible size limit", () => {
  assert.equal(
    shouldPassLowRiskPullRequest({
      ...cleanReview,
      filePaths: ["src/formatting.ts", "src/formatting.test.ts"],
      additions: 20,
      deletions: 20,
    }),
    true,
  );
  assert.equal(
    shouldPassLowRiskPullRequest({
      ...cleanReview,
      filePaths: ["src/formatting.ts"],
      additions: 21,
      deletions: 20,
    }),
    false,
  );
});

test("findings, incomplete evidence, and restricted repositories never pass", () => {
  for (const overrides of [
    { headSha: "unknown" },
    { reviewFindings: 1 },
    { reviewComplete: false },
    { overallCorrectness: "not a patch" },
    { automationPolicy: "review_only" },
    { sensitiveRepository: true },
    { filesTruncated: true },
  ]) {
    assert.equal(
      shouldPassLowRiskPullRequest({
        ...cleanReview,
        ...overrides,
        filePaths: ["docs/readme.md"],
      }),
      false,
      JSON.stringify(overrides),
    );
  }
});

test("auth, secrets, infrastructure, and migration paths always require a human", () => {
  for (const filePath of [
    "src/auth/login.ts",
    "config/client-secret.json",
    "infra/terraform/main.tf",
    "db/migrations/001-add-column.sql",
    ".env.production",
    "certs/service.pem",
  ]) {
    assert.equal(
      shouldPassLowRiskPullRequest({
        ...cleanReview,
        filePaths: [filePath],
        additions: 1,
        deletions: 0,
      }),
      false,
      filePath,
    );
  }
});

test("missing file data and oversized changes fail closed", () => {
  assert.equal(shouldPassLowRiskPullRequest({ ...cleanReview, filePaths: [] }), false);
  assert.equal(
    shouldPassLowRiskPullRequest({
      ...cleanReview,
      filePaths: ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"],
      additions: 1,
      deletions: 0,
    }),
    false,
  );
  assert.equal(
    shouldPassLowRiskPullRequest({
      ...cleanReview,
      filePaths: ["src/a.ts"],
      additions: 41,
      deletions: 0,
    }),
    false,
  );
  assert.equal(
    shouldPassLowRiskPullRequest({
      ...cleanReview,
      filePaths: ["src/a.ts"],
      additions: -1,
      deletions: 0,
    }),
    false,
  );
});
