import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  matchGlob,
  precheckDocsMaintainer,
  renderDocsMaintainerPrompt,
  writeDocsMaintainerJob,
} from "../../dist/repair/docs-maintainer.js";
import { repositoryProfileFor } from "../../dist/repository-profiles.js";

const coreWholesale = repositoryProfileFor("CLIP-SA/core-wholesale");

function input(overrides = {}) {
  return {
    repo: "clip-sa/core-wholesale",
    profile: coreWholesale,
    pr: {
      number: 42,
      url: "https://github.com/CLIP-SA/core-wholesale/pull/42",
      title: "Add IQ Retail API endpoint",
      body: "Adds a new external route.",
      authorLogin: "human-dev",
      authorType: "User",
      authorAssociation: "CONTRIBUTOR",
      labels: [],
      baseRef: "main",
      headRef: "feature/api",
      headRepo: "CLIP-SA/core-wholesale",
      headSha: "abc123",
      isDraft: false,
      ...overrides.pr,
    },
    files: overrides.files ?? [file("wordpress/includes/api/orders.php")],
  };
}

function file(path, patch = "@@ -1 +1 @@\n-old\n+new") {
  return { path, status: "modified", additions: 1, deletions: 1, patch };
}

test("docs maintainer glob matching supports repo-style double-star maps", () => {
  assert.equal(matchGlob("docs/**/*.md", "docs/api/orders.md"), true);
  assert.equal(matchGlob("docs/**/*.md", "docs/api.md"), true);
  assert.equal(matchGlob("NextJS-Frontend/app/**", "NextJS-Frontend/app/products/page.tsx"), true);
  assert.equal(matchGlob("NextJS-Frontend/app/**", "wordpress/app/products.php"), false);
});

test("docs maintainer silently skips tests-only PRs", () => {
  const decision = precheckDocsMaintainer(
    input({ files: [file("NextJS-Frontend/components/Button.test.tsx")] }),
  );

  assert.equal(decision.action, "skip");
  assert.equal(decision.reason, "tests_only");
  assert.equal(decision.silent, true);
  assert.deepEqual(decision.candidateDocs, []);
});

test("docs maintainer maps API and env changes to configured docs", () => {
  const decision = precheckDocsMaintainer(
    input({
      files: [file("wordpress/includes/api/orders.php"), file(".env.example")],
    }),
  );

  assert.equal(decision.action, "run");
  assert.equal(decision.reason, "mapped_docs_obligation");
  assert.equal(decision.confidence, "high");
  assert.match(decision.candidateDocs.join("\n"), /README\.md/);
  assert.match(decision.candidateDocs.join("\n"), /docs\/OPERATIONS\.md/);
  assert.match(decision.candidateDocs.join("\n"), /\.env\.example/);
  assert.equal(
    decision.candidateDocs.some((doc) => doc.includes("*")),
    false,
  );
});

test("docs maintainer skips bot-authored docs-maintainer PRs", () => {
  const decision = precheckDocsMaintainer(
    input({ pr: { authorLogin: "clawsweeper[bot]", authorType: "Bot" } }),
  );

  assert.equal(decision.action, "skip");
  assert.equal(decision.reason, "bot_authored_pr");
});

test("docs maintainer plans companion PR for fork heads", () => {
  const decision = precheckDocsMaintainer(
    input({ pr: { headRepo: "contributor/core-wholesale" } }),
  );

  assert.equal(decision.action, "run");
  assert.equal(decision.mutation.preferred, "companion_pr");
});

test("docs maintainer jobs let run-worker resolve target checkout", () => {
  const decision = precheckDocsMaintainer(input());
  const relative = writeDocsMaintainerJob(input(), decision);
  const absolute = path.join(process.cwd(), relative);

  try {
    const job = fs.readFileSync(absolute, "utf8");
    assert.match(job, /job_intent: docs_maintenance/);
    assert.doesNotMatch(job, /target_checkout:/);
    assert.doesNotMatch(job, /max_turns:|timeout_ms:/);
  } finally {
    fs.rmSync(absolute, { force: true });
    for (const dir of [path.dirname(absolute), path.dirname(path.dirname(absolute))]) {
      try {
        fs.rmdirSync(dir);
      } catch {
        // Directory already contained other jobs or does not exist.
      }
    }
  }
});

test("docs maintainer prompt separates trusted metadata from untrusted PR text", () => {
  const decision = precheckDocsMaintainer(input());
  const prompt = renderDocsMaintainerPrompt({
    repo: "clip-sa/core-wholesale",
    pr: input().pr,
    files: input().files,
    decision,
    docsMaintainer: coreWholesale.docsMaintainer,
    repoInstructions: coreWholesale.promptNote,
  });

  assert.match(prompt, /<untrusted_pr_body>/);
  assert.match(prompt, /<untrusted_diff>/);
  assert.match(prompt, /deterministic TypeScript owns auth/);
  assert.match(prompt, /No semantic search, no RAG/);
});
