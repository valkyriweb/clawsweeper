import assert from "node:assert/strict";
import test from "node:test";

import {
  HUMAN_REVIEW_LABEL,
  repairPauseLabel,
  validateAutonomousFixScope,
} from "../../dist/repair/execute-fix-validation.js";

function broadBranchRepairArtifact() {
  return {
    repair_strategy: "repair_contributor_branch",
    pr_title: "feat(file-transfer): refresh canonical node policy repair branch",
    summary:
      "Repair existing canonical PR by rebasing it onto current main and resolving stale branch fallout.",
    pr_body: "Refresh a broad existing contributor branch without expanding the requested scope.",
    affected_surfaces: [
      "extensions/file-transfer plugin",
      "Gateway node.invoke plugin policy seam",
      "Agent nodes-tool redirect messaging",
      "Plugin SDK/registry contract exports",
      "Docs, changelog, and labeler entries for the bundled plugin",
    ],
    likely_files: [
      "src/agents/tools/nodes-tool-commands.ts",
      "src/agents/tools/nodes-tool.test.ts",
      "extensions/file-transfer/src/shared/node-invoke-policy.ts",
      "extensions/file-transfer/src/shared/node-invoke-policy.test.ts",
      "extensions/file-transfer/src/tools/dir-fetch-tool.ts",
      "extensions/file-transfer/src/tools/dir-fetch-tool.test.ts",
      "src/gateway/node-invoke-plugin-policy.ts",
      "src/gateway/node-invoke-plugin-policy.test.ts",
    ],
    source_prs: [
      "https://github.com/openclaw/openclaw/pull/74742",
      "https://github.com/openclaw/openclaw/pull/74134",
    ],
  };
}

function validate(job, fixArtifact = broadBranchRepairArtifact()) {
  return validateAutonomousFixScope({
    job,
    fixArtifact,
    allowBroadFixArtifacts: false,
    maxAutonomousFixFiles: 3,
    maxAutonomousFixSurfaces: 3,
  });
}

test("autonomous scope validation blocks broad untrusted repair artifacts", () => {
  const block = validate({
    frontmatter: {
      source: "manual",
      allow_fix_pr: true,
      allowed_actions: ["fix", "raise_pr"],
      target_branch: "clawsweeper/example",
    },
  });

  assert.match(block.reason, /too broad for autonomous execution/);
});

test("autonomous scope validation allows trusted adopted PR branch refreshes", () => {
  const block = validate({
    frontmatter: {
      source: "pr_automerge",
      allow_fix_pr: true,
      allowed_actions: ["fix", "raise_pr"],
      target_branch: "clawsweeper/automerge-openclaw-openclaw-74134",
    },
  });

  assert.equal(block, null);
});

test("autonomous scope validation still blocks adopted repairs outside ClawSweeper branches", () => {
  const block = validate({
    frontmatter: {
      source: "pr_automerge",
      allow_fix_pr: true,
      allowed_actions: ["fix", "raise_pr"],
      target_branch: "contributor/file-transfer",
    },
  });

  assert.match(block.reason, /too broad for autonomous execution/);
});

test("docs maintenance scope validation allows only configured owned docs", () => {
  const docsArtifact = {
    ...broadBranchRepairArtifact(),
    repair_strategy: "repair_contributor_branch",
    pr_title: "docs: update Core Wholesale API docs",
    summary: "Update mapped docs for a Core Wholesale API PR.",
    pr_body: "Docs-only follow-up for source PR.",
    affected_surfaces: ["docs"],
    likely_files: ["README.md", "docs/api/orders.md", ".env.example"],
    source_prs: ["https://github.com/CLIP-SA/core-wholesale/pull/42"],
  };

  assert.equal(
    validate(
      {
        frontmatter: {
          repo: "CLIP-SA/core-wholesale",
          job_intent: "docs_maintenance",
          allowed_actions: ["fix", "raise_pr"],
        },
      },
      docsArtifact,
    ),
    null,
  );

  const block = validate(
    {
      frontmatter: {
        repo: "CLIP-SA/core-wholesale",
        job_intent: "docs_maintenance",
        allowed_actions: ["fix", "raise_pr"],
      },
    },
    { ...docsArtifact, likely_files: ["src/api/orders.ts", "docs/api/orders.md"] },
  );

  assert.match(block.reason, /outside configured owned docs/);
  assert.match(block.evidence.join("\n"), /src\/api\/orders\.ts/);

  const globBlock = validate(
    {
      frontmatter: {
        repo: "CLIP-SA/core-wholesale",
        job_intent: "docs_maintenance",
        allowed_actions: ["fix", "raise_pr"],
      },
    },
    { ...docsArtifact, likely_files: ["docs/**/*.md"] },
  );

  assert.match(globBlock.reason, /outside configured owned docs/);
  assert.match(globBlock.evidence.join("\n"), /docs\/\*\*\/\*\.md/);
});

test("repair pause labels block live branch mutation", () => {
  assert.equal(repairPauseLabel(["bug", HUMAN_REVIEW_LABEL]), HUMAN_REVIEW_LABEL);
  assert.equal(
    repairPauseLabel([{ name: "Bug" }, { name: "ClawSweeper:Human-Review" }]),
    HUMAN_REVIEW_LABEL,
  );
  assert.equal(repairPauseLabel(["clawsweeper:automerge"]), null);
});
