import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const repoRoot = process.cwd();

test("run-worker uses Pi medium model for docs maintenance", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-run-worker-pi-"));
  const fakeBin = path.join(tmp, "bin");
  const targetCheckout = path.join(tmp, "target-core");
  const argsFile = path.join(tmp, "pi-args.json");
  const stdinFile = path.join(tmp, "pi-stdin.txt");
  const jobPath = path.join(tmp, "run-worker-docs-pi.md");

  fs.mkdirSync(fakeBin, { recursive: true });
  fs.mkdirSync(targetCheckout, { recursive: true });
  fs.writeFileSync(
    path.join(fakeBin, "pi"),
    [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      "const stdin = fs.readFileSync(0, 'utf8');",
      "fs.writeFileSync(process.env.FAKE_PI_ARGS_FILE, JSON.stringify(process.argv.slice(2)));",
      "fs.writeFileSync(process.env.FAKE_PI_STDIN_FILE, stdin);",
      "const result = {",
      "  status: 'planned', repo: 'clip-sa/core-wholesale', cluster_id: 'run-worker-docs-pi', mode: 'autonomous',",
      "  summary: 'fake pi result', actions: [], needs_human: [], canonical: null, canonical_issue: null, canonical_pr: null, fix_artifact: null,",
      "};",
      "process.stdout.write(JSON.stringify(result));",
    ].join("\n"),
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(fakeBin, "codex"),
    [
      "#!/usr/bin/env node",
      "process.stderr.write('repair worker must not invoke codex\\n');",
      "process.exit(1);",
    ].join("\n"),
    { mode: 0o755 },
  );
  fs.writeFileSync(
    jobPath,
    [
      "---",
      "repo: CLIP-SA/core-wholesale",
      "cluster_id: run-worker-docs-pi",
      "mode: autonomous",
      "job_intent: docs_maintenance",
      "source: docs_maintenance",
      `target_checkout: ${targetCheckout}`,
      "allowed_actions:",
      "  - comment",
      "  - fix",
      "  - raise_pr",
      "candidates:",
      '  - "#42"',
      "---",
      "Docs prompt.",
      "",
    ].join("\n"),
  );

  try {
    execFileSync(process.execPath, ["dist/repair/run-worker.js", jobPath, "--mode", "autonomous"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        CLAWSWEEPER_ALLOW_EXECUTE: "1",
        FAKE_PI_ARGS_FILE: argsFile,
        FAKE_PI_STDIN_FILE: stdinFile,
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`,
      },
      stdio: "pipe",
      encoding: "utf8",
    });

    const args = JSON.parse(fs.readFileSync(argsFile, "utf8"));
    assert.equal(args[args.indexOf("--model") + 1], "medium");
    const stdin = fs.readFileSync(stdinFile, "utf8");
    assert.match(stdin, /cheap\/fast explore subagents/);
    assert.doesNotMatch(stdin, /max_turns/);
    const [runDir] = fs.globSync(
      path.join(repoRoot, ".clawsweeper-repair/runs/run-worker-docs-pi-autonomous-*"),
    );
    assert.ok(runDir);
    assert.ok(fs.existsSync(path.join(runDir, "pi.stdout.log")));
    const result = JSON.parse(fs.readFileSync(path.join(runDir, "result.json"), "utf8"));
    assert.equal(result.summary, "fake pi result");
  } finally {
    for (const runDir of fs.globSync(
      path.join(repoRoot, ".clawsweeper-repair/runs/run-worker-docs-pi-autonomous-*"),
    )) {
      fs.rmSync(runDir, { recursive: true, force: true });
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("run-worker starts Pi in the target checkout when one is available", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-run-worker-"));
  const fakeBin = path.join(tmp, "bin");
  const targetCheckout = path.join(tmp, "target-openclaw");
  const cwdFile = path.join(tmp, "pi-cwd.txt");
  const argsFile = path.join(tmp, "pi-args.json");
  const stdinFile = path.join(tmp, "pi-stdin.txt");
  const jobPath = path.join(tmp, "run-worker-target-checkout.md");

  fs.mkdirSync(fakeBin, { recursive: true });
  fs.mkdirSync(targetCheckout, { recursive: true });
  fs.writeFileSync(path.join(targetCheckout, "target-marker.txt"), "target\n");
  fs.writeFileSync(
    path.join(fakeBin, "gh"),
    [
      "#!/usr/bin/env node",
      "const args = process.argv.slice(2);",
      "if (args[0] === 'api' && args[1] === 'repos/openclaw/openclaw/branches/main') {",
      "  process.stdout.write(JSON.stringify({ commit: { sha: '1111111111111111111111111111111111111111' } }));",
      "  process.exit(0);",
      "}",
      "process.stderr.write(`unexpected gh args: ${args.join(' ')}\\n`);",
      "process.exit(1);",
    ].join("\n"),
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(fakeBin, "pi"),
    [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      "const stdin = fs.readFileSync(0, 'utf8');",
      "fs.writeFileSync(process.env.FAKE_PI_CWD_FILE, process.cwd());",
      "fs.writeFileSync(process.env.FAKE_PI_ARGS_FILE, JSON.stringify(process.argv.slice(2)));",
      "fs.writeFileSync(process.env.FAKE_PI_STDIN_FILE, stdin);",
      "const result = {",
      "  status: 'planned',",
      "  repo: 'openclaw/openclaw',",
      "  cluster_id: 'clawsweeper-run-worker-target-checkout',",
      "  mode: 'plan',",
      "  summary: 'fake pi result',",
      "  actions: [],",
      "  needs_human: [],",
      "  canonical: null,",
      "  canonical_issue: null,",
      "  canonical_pr: null,",
      "  merge_preflight: [],",
      "  fix_artifact: null,",
      "};",
      "process.stdout.write(JSON.stringify(result));",
    ].join("\n"),
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(fakeBin, "codex"),
    [
      "#!/usr/bin/env node",
      "process.stderr.write('repair worker must not invoke codex\\n');",
      "process.exit(1);",
    ].join("\n"),
    { mode: 0o755 },
  );

  fs.writeFileSync(
    jobPath,
    [
      "---",
      "repo: openclaw/openclaw",
      "cluster_id: clawsweeper-run-worker-target-checkout",
      "mode: plan",
      "allowed_actions:",
      "  - fix",
      "source: clawsweeper_commit",
      "commit_sha: 1111111111111111111111111111111111111111",
      "security_policy: central_security_only",
      "security_sensitive: false",
      "---",
      "Plan only.",
      "",
    ].join("\n"),
  );

  try {
    execFileSync(process.execPath, ["dist/repair/run-worker.js", jobPath, "--mode", "plan"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        CLAWSWEEPER_TARGET_CHECKOUT: targetCheckout,
        FAKE_PI_CWD_FILE: cwdFile,
        FAKE_PI_ARGS_FILE: argsFile,
        FAKE_PI_STDIN_FILE: stdinFile,
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`,
      },
      stdio: "pipe",
    });

    assert.equal(fs.readFileSync(cwdFile, "utf8"), fs.realpathSync(targetCheckout));
    const args = JSON.parse(fs.readFileSync(argsFile, "utf8"));
    assert.equal(args[args.indexOf("--model") + 1], "medium");
    assert.equal(args.includes("--cd"), false);
    assert.match(fs.readFileSync(stdinFile, "utf8"), /cluster-plan\.json/);
  } finally {
    for (const runDir of fs.globSync(
      path.join(repoRoot, ".clawsweeper-repair/runs/run-worker-target-checkout-plan-*"),
    )) {
      fs.rmSync(runDir, { recursive: true, force: true });
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
