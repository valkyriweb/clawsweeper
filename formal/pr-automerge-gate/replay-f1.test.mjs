// Replay of finding F1 (PrAutomergeGate.tla, NoMergeOverFailVerdict) against the
// real dist/repair/comment-router.js with a stub gh. Evidence, not a gate: it is
// not part of check.sh and not in pnpm test.
// Run: pnpm run build:repair && node --test formal/pr-automerge-gate/replay-f1.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root =
  process.env.REPO_DIR || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const repo = "valkyriweb/openclaw-claude";
const H = "a".repeat(40);
const marker = (verdict, sha = H) =>
  "<!-- clawsweeper-verdict:" + verdict + " item=2 sha=" + sha + " confidence=high -->";
const body = (verdict) => marker(verdict) + "\n**Summary**\n\nReview body for " + verdict + ".\n";

const GH_STUB = String.raw`#!/usr/bin/env node
import fs from 'node:fs';
const file = process.env.FIXTURE;
const a = process.argv.slice(2);
const load = () => JSON.parse(fs.readFileSync(file, 'utf8'));
const save = (s) => { const t = file + '.' + process.pid; fs.writeFileSync(t, JSON.stringify(s)); fs.renameSync(t, file); };
let s = load();
const idx = s.calls.length;
s.calls.push(a);
// ---- flip hook: before answering the Nth 'pr view' (1-based) rewrite the durable comment ----
const isPrView = a[0] === 'pr' && a[1] === 'view';
if (isPrView) s.prViews = (s.prViews || 0) + 1;
if (s.flip && !s.flipped) {
  const hit = s.flip.onPrView ? (isPrView && s.prViews === s.flip.onPrView)
            : s.flip.onCallIndex !== undefined ? idx === s.flip.onCallIndex : false;
  if (hit) {
    s.comment.body = s.flip.body;
    s.comment.updated_at = '2026-09-22T00:05:00Z';
    s.flipped = { atCallIndex: idx, argv: a };
  }
}
save(s);
const out = (x) => console.log(JSON.stringify(x));
const paged = (x) => out(a.includes('--slurp') ? [x] : x);
const c = () => ({ ...s.comment, issue_url: 'https://api.github.com/repos/' + s.repo + '/issues/2',
  html_url: 'https://github.com/' + s.repo + '/pull/2#issuecomment-' + s.comment.id,
  user: { login: 'clawsweeper[bot]', id: 77 }, author_association: 'NONE' });
const checks = [{ name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS', workflowName: 'CI' }];
if (a[0] === 'pr' && a[1] === 'view') {
  out({ state: 'OPEN', headRefOid: s.sha, headRefName: 'feature', author: { login: 'owner' }, baseRefName: 'main',
    title: 'Docs repair', body: '', labels: s.labels.map((name) => ({ name })), files: [{ path: 'docs/guide.md' }],
    commits: [], closingIssuesReferences: [], isDraft: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN',
    reviewDecision: null, statusCheckRollup: checks, mergeCommit: null, mergedAt: s.merged ? '2026-09-22T00:10:00Z' : null,
    url: 'https://github.com/' + s.repo + '/pull/2' });
} else if (a[0] === 'pr' && a[1] === 'merge') {
  s = load(); s.merged = true; save(s); console.log('merged');
} else if (a[0] === 'label' || (a[0] === 'issue' && a[1] === 'edit')) {
  out({});
} else if (a[0] === 'api') {
  const p = a.find((x) => x.startsWith('repos/')) || a[1];
  if (p === 'user') out({ login: 'clawsweeper[bot]' });
  else if (/\/issues\/comments\?since=/.test(p)) paged([c()]);
  else if (/\/issues\?state=open&labels=/.test(p)) paged(decodeURIComponent(p).includes('clawsweeper:automerge') ? [{ number: 2, pull_request: {} }] : []);
  else if (/\/issues\/2\/comments/.test(p) && a.includes('POST')) out({ id: 99 });
  else if (/\/issues\/2\/comments/.test(p)) paged([c()]);
  else if (/\/issues\/comments\/\d+/.test(p)) out(c());
  else if (/\/issues\/2$/.test(p)) out({ number: 2, state: 'open', pull_request: { url: 'x' }, labels: s.labels.map((name) => ({ name })), user: { login: 'owner' } });
  else if (/\/pulls\/2$/.test(p)) out({ number: 2, state: 'open', head: { sha: s.sha }, base: { ref: 'main' } });
  else if (/\/pulls\/2\/files/.test(p)) paged([{ filename: 'docs/guide.md' }]);
  else if (/\/pulls\?/.test(p)) paged([]);
  else if (/\/actions\//.test(p)) out(a.includes('--jq') ? [] : { workflow_runs: [], runners: [], total_count: 0 });
  else if (/\/collaborators\//.test(p)) out({ permission: 'none' });
  else { console.error('UNHANDLED ' + JSON.stringify(a)); process.exit(1); }
} else { console.error('UNHANDLED ' + JSON.stringify(a)); process.exit(1); }
`;

function fixture(t, over = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "replay-f1-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.cpSync(path.join(root, "dist"), path.join(dir, "dist"), { recursive: true });
  fs.cpSync(path.join(root, "config"), path.join(dir, "config"), { recursive: true });
  fs.symlinkSync(path.join(root, "node_modules"), path.join(dir, "node_modules"));
  fs.writeFileSync(path.join(dir, "package.json"), '{"type":"module"}');
  fs.mkdirSync(path.join(dir, "bin"));
  fs.writeFileSync(path.join(dir, "bin/gh"), GH_STUB.replace(/^\n/, ""));
  fs.chmodSync(path.join(dir, "bin/gh"), 0o755);
  const state = {
    repo,
    sha: H,
    labels: ["clawsweeper:automerge"],
    calls: [],
    merged: false,
    comment: {
      id: 5,
      body: body("pass"),
      created_at: "2026-09-22T00:01:00Z",
      updated_at: "2026-09-22T00:01:00Z",
    },
    ...over,
  };
  fs.writeFileSync(path.join(dir, "fixture.json"), JSON.stringify(state));
  const child = spawnSync(
    process.execPath,
    [
      path.join(dir, "dist/repair/comment-router.js"),
      "--repo",
      repo,
      "--execute",
      "--since",
      "2026-09-22T00:00:00Z",
    ],
    {
      cwd: dir,
      encoding: "utf8",
      timeout: 60000,
      env: {
        ...process.env,
        PATH: dir + "/bin:" + process.env.PATH,
        FIXTURE: path.join(dir, "fixture.json"),
        CLAWSWEEPER_ALLOW_MERGE: "1",
        CLAWSWEEPER_TRUSTED_BOTS: "clawsweeper[bot]",
        CLAWSWEEPER_COMMENT_MAX_LIVE_WORKERS: "100",
        CLAWSWEEPER_COMMENT_ROUTER_MAX_LIVE_WORKERS: "100",
        CLAWSWEEPER_AUTOMERGE_TRANSIENT_WAIT_MS: "1000",
        CLAWSWEEPER_AUTOMERGE_TRANSIENT_POLL_MS: "1000",
        GH_BIN: "",
        GITHUB_EVENT_PATH: "",
      },
    },
  );
  const final = JSON.parse(fs.readFileSync(path.join(dir, "fixture.json"), "utf8"));
  let report = null;
  try {
    report = JSON.parse(child.stdout);
  } catch {}
  const mergeCalls = final.calls.filter((x) => x[0] === "pr" && x[1] === "merge");
  const summary = final.calls.map((x, i) => i + ": " + x.join(" ").slice(0, 150));
  if (process.env.REPLAY_VERBOSE)
    console.log(
      "---",
      t.name,
      "\nstatus",
      child.status,
      "\n" + summary.join("\n"),
      "\nflipped",
      JSON.stringify(final.flipped),
      "\ncmd",
      JSON.stringify(report?.commands?.map((c) => [c.status, c.reason, c.intent, c.actions])),
      "\nstderr",
      child.stderr.slice(-600),
    );
  return { child, final, report, mergeCalls, summary };
}

test("CONTROL: comment stays pass -> router merges with --match-head-commit H", (t) => {
  const r = fixture(t);
  assert.equal(r.child.status, 0, r.child.stderr);
  assert.equal(r.mergeCalls.length, 1);
  assert.ok(r.mergeCalls[0].join(" ").includes("--match-head-commit " + H));
});

test("PRE-FLIPPED: comment already needs-changes before listing -> no merge", (t) => {
  const r = fixture(t, {
    comment: {
      id: 5,
      body: body("needs-changes"),
      created_at: "2026-09-22T00:01:00Z",
      updated_at: "2026-09-22T00:01:00Z",
    },
  });
  assert.equal(r.child.status, 0, r.child.stderr);
  assert.equal(r.mergeCalls.length, 0);
});

test("FLIP: comment flipped to needs-changes (same sha H) at 2nd pr view (inside executeAutomerge) -> observe merge", (t) => {
  const r = fixture(t, {
    flip: { onPrView: Number(process.env.FLIP_PRVIEW || 2), body: body("needs-changes") },
  });
  assert.equal(r.child.status, 0, r.child.stderr);
  assert.ok(r.final.flipped, "flip must have happened");
  // Observation test: records whether merge still happened; asserts only that it ran.
  console.log("FLIP merge argv tail: " + (r.mergeCalls[0] || []).slice(-2).join(" "));
  console.log(
    "FLIP result: mergeCalls=" +
      r.mergeCalls.length +
      " flippedAt=" +
      JSON.stringify(r.final.flipped),
  );
  console.log(r.summary.join("\n"));
});
