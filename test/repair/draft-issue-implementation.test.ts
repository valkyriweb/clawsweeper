import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  repositoryProfileFor,
  REPOSITORY_PROFILES,
  automationPolicyBlockReason,
  resolveAutomationCapabilities,
  validateTargetRepositoryConfig,
} from "../../dist/repository-profiles.js";
import { parseJob, validateJob } from "../../dist/repair/lib.js";
import { renderIssueImplementationJob } from "../../dist/repair/comment-router-core.js";
import {
  draftIssueJobBlockReason,
  draftVerificationPaths,
  verificationDigest,
} from "../../dist/repair/draft-issue-implementation.js";
import { targetAuthFor, legacyTargetAuthFor } from "../../dist/repair/workflow-utils.js";
import { publishDraftIssuePr } from "../../dist/repair/draft-issue-publish.js";

// Seam: trusted job/evidence files and deterministic GitHub CLI publication boundary.
test("draft-only policy and opt-in stay off in every production profile", () => {
  for (const profile of REPOSITORY_PROFILES) {
    assert.notEqual(profile.automationPolicy, "draft_pr_only");
    assert.notEqual(profile.draftIssueImplementation, true);
    assert.notEqual(profile.issueTriageIntake, true);
    assert.ok(automationPolicyBlockReason(profile.targetRepo, "draft_issue_implementation"));
  }
  for (const policy of [undefined, "unknown", "review_only", "draft_pr_only"]) {
    const caps = resolveAutomationCapabilities(policy);
    for (const key of [
      "repair",
      "branchPush",
      "pullRequest",
      "merge",
      "close",
      "labels",
      "draftIssueImplementation",
    ])
      assert.equal(caps[key], false);
  }
  assert.equal(resolveAutomationCapabilities("full").repair, true);
  const config = JSON.parse(fs.readFileSync("config/target-repositories.json", "utf8"));
  config.repositories[0].automation_policy = "draft_pr_only";
  config.repositories[0].draft_issue_implementation = true;
  assert.equal(
    validateTargetRepositoryConfig(config).repositories[0].draftIssueImplementation,
    true,
  );
  for (const value of ["true", 1, null]) {
    config.repositories[0].draft_issue_implementation = value;
    assert.throws(() => validateTargetRepositoryConfig(config), /must be a boolean/);
  }
});

test("draft job and token authorization require exact intent, verified evidence, profile, activation and owner", () => {
  const repo = "valkyriweb/clawrouter";
  const number = 900000005;
  const profile = repositoryProfileFor(repo);
  const original = { ...profile };
  const env = { ...process.env };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "draft-issue-job-"));
  const files = draftVerificationPaths(repo, number);
  const report = `---\nrepository: ${repo}\nnumber: ${number}\nreview_status: complete\ntype: issue\nstate_at_review: open\ndecision: keep_open\nclose_reason: none\nconfidence: high\nwork_candidate: queue_fix_pr\nwork_confidence: high\nitem_category: bug\nreproduction_status: reproduced\nreproduction_confidence: high\nsecurity_review_status: cleared\nwork_validation: ["pnpm test"]\n---\n\n## Repair Work Prompt\n\nFix the reproduced bug.\n`;
  const audit = `---\nrepo: ${repo}\nnumber: ${number}\nreport_path: ${files.report}\nstatus: reproduced\nverified: true\n---\n`;
  for (const [file, content] of [
    [files.report, report],
    [files.audit, audit],
  ]) {
    assert.equal(fs.existsSync(file), false, "do not overwrite foreign evidence");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  const jobPath = path.join(tmp, "job.md");
  try {
    profile.automationPolicy = "draft_pr_only";
    profile.draftIssueImplementation = true;
    const text = renderIssueImplementationJob({
      repo,
      issueNumber: number,
      strictBugOnly: true,
      draftOnly: true,
      triggerSource: "review_reproducible_bug",
      reviewReportPath: files.report,
      verificationReportSha256: verificationDigest(report),
      verificationAuditSha256: verificationDigest(audit),
      allowAutomerge: true,
    });
    fs.writeFileSync(jobPath, text);
    const job = parseJob(jobPath);
    assert.deepEqual(validateJob(job), []);
    assert.equal(draftIssueJobBlockReason(job.frontmatter), null);
    assert.deepEqual(job.frontmatter.allowed_actions, ["fix", "raise_pr"]);
    assert.equal(job.frontmatter.allow_merge, false);
    assert.equal(job.frontmatter.required_pr_labels, undefined);
    for (const capability of ["repair", "branch_push", "pull_request", "merge", "close", "label"])
      assert.ok(automationPolicyBlockReason(repo, capability));
    for (const [key, value] of Object.entries({
      source: "pr_automerge",
      draft_only: false,
      strict_bug_only: false,
      job_intent: "repair_cluster",
      trigger_source: "comment",
      mode: "execute",
      reproduction_verified: false,
      verification_audit_sha256: "",
      verification_report_sha256: "",
      target_branch: "main",
      allow_merge: true,
      allowed_actions: ["fix", "raise_pr", "comment"],
      candidates: ["#123"],
      required_pr_labels: ["bug"],
    })) {
      assert.ok(draftIssueJobBlockReason({ ...job.frontmatter, [key]: value }), key);
    }
    for (const key of [
      "source",
      "draft_only",
      "strict_bug_only",
      "reproduction_verified",
      "verification_audit_sha256",
    ]) {
      const fm = { ...job.frontmatter };
      delete fm[key];
      assert.ok(draftIssueJobBlockReason(fm), `missing ${key}`);
    }
    const token = () =>
      targetAuthFor({ targetRepo: repo, accessMode: "draft_issue_implementation", jobPath });
    delete process.env.CLAWSWEEPER_ALLOW_DRAFT_ISSUE_IMPLEMENTATION;
    process.env.CLAWSWEEPER_ALLOW_EXECUTE = "1";
    process.env.CLAWSWEEPER_ALLOW_FIX_PR = "1";
    assert.throws(token, /ALLOW_DRAFT_ISSUE_IMPLEMENTATION/);
    process.env.CLAWSWEEPER_ALLOW_DRAFT_ISSUE_IMPLEMENTATION = "1";
    process.env.CLAWSWEEPER_ALLOWED_OWNER = "bermont-digital";
    assert.throws(token, /repo owner/);
    process.env.CLAWSWEEPER_ALLOWED_OWNER = "VALKYRIWEB";
    assert.equal(token().access_mode, "draft_issue_implementation");
    assert.throws(
      () => targetAuthFor({ targetRepo: repo, accessMode: "draft_issue_implementation" }),
      /job-path/,
    );
    for (const mode of ["mutate", "comment"])
      assert.throws(() => targetAuthFor({ targetRepo: repo, accessMode: mode }), /denies/);
    assert.throws(() => legacyTargetAuthFor(repo), /exact-job/);
    profile.draftIssueImplementation = false;
    assert.throws(token, /denies/);
    profile.draftIssueImplementation = true;
    profile.automationPolicy = "review_only";
    assert.throws(token, /review_only/);
    profile.automationPolicy = "full";
    assert.throws(token, /denies/);
    profile.automationPolicy = "draft_pr_only";
    profile.githubAppCredentialRoute = "bermont-digital";
    assert.throws(token, /denies/);
    profile.githubAppCredentialRoute = "valkyriweb";
    const foreign = repositoryProfileFor("bermont-digital/smilerite");
    const saved = { ...foreign };
    try {
      foreign.automationPolicy = "draft_pr_only";
      foreign.draftIssueImplementation = true;
      assert.ok(automationPolicyBlockReason(foreign.targetRepo, "draft_issue_implementation"));
    } finally {
      Object.assign(foreign, saved);
    }
    fs.writeFileSync(files.audit, audit.replace("status: reproduced", "status: blocked"));
    assert.ok(draftIssueJobBlockReason(job.frontmatter));
    fs.writeFileSync(files.audit, audit);
    for (const [from, to] of [
      ["review_status: complete", "review_status: pending"],
      ["type: issue", "type: pull_request"],
      ["security_review_status: cleared", "security_review_status: needs_attention"],
    ]) {
      const invalid = report.replace(from, to);
      fs.writeFileSync(files.report, invalid);
      assert.ok(
        draftIssueJobBlockReason({
          ...job.frontmatter,
          verification_report_sha256: verificationDigest(invalid),
        }),
      );
    }
    fs.writeFileSync(files.report, report);
    fs.unlinkSync(files.audit);
    assert.ok(draftIssueJobBlockReason(job.frontmatter));
  } finally {
    Object.assign(profile, original);
    delete profile.draftIssueImplementation;
    process.env = env;
    for (const file of [files.report, files.audit]) fs.rmSync(file, { force: true });
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("mocked publication only creates a draft and reads back its state; ready or closed PRs fail closed", () => {
  const options = {
    repo: "valkyriweb/clawrouter",
    branch: "clawsweeper/issue-valkyriweb-clawrouter-123",
    base: "main",
    title: "Fix",
    bodyFile: "/tmp/body.md",
    cwd: "/tmp",
    timeoutMs: 1000,
  };
  const url = "https://github.com/valkyriweb/clawrouter/pull/456";
  const pull = {
    url,
    isDraft: true,
    state: "OPEN",
    headRefName: options.branch,
    headRepositoryOwner: { login: "valkyriweb" },
  };
  const calls: string[][] = [];
  let created = false;
  const run = (command: string, args: string[]) => {
    calls.push([command, ...args]);
    if (args[1] === "list") return JSON.stringify(created ? [pull] : []);
    assert.equal(command, "gh");
    assert.equal(args[1], "create");
    assert.ok(args.includes("--draft"));
    created = true;
    return url;
  };
  assert.equal(publishDraftIssuePr(options, run), url);
  assert.deepEqual(
    calls.map((args) => args.slice(0, 3)),
    [
      ["gh", "pr", "list"],
      ["gh", "pr", "create"],
      ["gh", "pr", "list"],
    ],
  );
  for (const bad of [
    { ...pull, isDraft: false },
    { ...pull, state: "CLOSED" },
    { ...pull, headRefName: "main" },
  ]) {
    const denied: string[][] = [];
    assert.throws(
      () =>
        publishDraftIssuePr(options, (command, args) => {
          denied.push([command, ...args]);
          return JSON.stringify([bad]);
        }),
      /refuses/,
    );
    assert.equal(denied.length, 1);
  }
});
