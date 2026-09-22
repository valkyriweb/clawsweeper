import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { automergeJobPath, renderAutomergeJob } from "../../dist/repair/comment-router-core.js";
import { appendLedger, readLedger, writeLedger } from "../../dist/repair/comment-router-utils.js";
import { lifecycleReplayReason } from "../../dist/repair/pr-lifecycle.js";
const root = path.resolve(import.meta.dirname, "../..");
const repo = "valkyriweb/openclaw-claude",
  sha = "a".repeat(40),
  base = "b".repeat(40);
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lifecycle-router-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.cpSync(path.join(root, "dist"), path.join(dir, "dist"), { recursive: true });
  fs.cpSync(path.join(root, "config"), path.join(dir, "config"), { recursive: true });
  fs.symlinkSync(path.join(root, "node_modules"), path.join(dir, "node_modules"));
  fs.writeFileSync(path.join(dir, "package.json"), '{"type":"module"}');
  fs.mkdirSync(path.join(dir, "bin"));
  const state = {
    repo,
    sha,
    base,
    phase: "completed",
    verdict: "fail",
    run: "42",
    labels: ["clawsweeper:autofix"],
    files: [{ filename: "docs/guide.md" }],
    classification: "actionable",
    calls: [],
    fetches: [],
  };
  fs.writeFileSync(
    path.join(dir, "preload.mjs"),
    `import fs from 'node:fs';globalThis.fetch=async(url,options)=>{const file=process.env.FIXTURE;const s=JSON.parse(fs.readFileSync(file));s.fetches.push(url);fs.writeFileSync(file,JSON.stringify(s));return Response.json(s.classifierFailure?{}:url.endsWith('/messages')?{model:'claude-sonnet-5',content:[{type:'text',text:JSON.stringify({classification:s.classification})}]}:{model:'jev-1.13.0',answers:{route:{type:'choice',choice:s.fallback?'unknown':s.classification,confidence:0.5}}});};`,
  );
  fs.writeFileSync(
    path.join(dir, "bin/gh"),
    `#!/usr/bin/env node
import fs from 'node:fs';import path from 'node:path';const file=process.env.FIXTURE,s=JSON.parse(fs.readFileSync(file)),a=process.argv.slice(2);s.calls.push(a);
const save=()=>{const tmp=file+'.'+process.pid;fs.writeFileSync(tmp,JSON.stringify(s));fs.renameSync(tmp,file);},out=x=>console.log(JSON.stringify(x)),paged=x=>out(a.includes('--slurp')?[x]:x);save();
const identity={version:1,target_repo:s.repo,item_number:2,head_sha:s.sha,source_run_id:s.run,source_run_attempt:1};
if(a[0]==='run'&&a[1]==='download'){fs.writeFileSync(path.join(a[a.indexOf('--dir')+1],'lifecycle.json'),JSON.stringify({...identity,phase:s.phase,verdict:s.verdict,comment_id:9}));}
else if(a[0]==='run'&&a[1]==='list')out([]);
else if(a[0]==='label')out({});
else if(a[0]==='workflow'&&a[1]==='run')console.log('https://github.com/valkyriweb/clawsweeper/actions/runs/123');
else if(a[0]==='issue'&&a[1]==='edit'){for(let i=0;i<a.length;i++){if(a[i]==='--add-label')s.labels.push(a[++i]);else if(a[i]==='--remove-label'){const removed=a[++i].split(',');s.labels=s.labels.filter(x=>!removed.includes(x));}}s.labels=[...new Set(s.labels)];save();out({});}
else if(a[0]==='pr'&&a[1]==='view'){const fresh=a[a.indexOf('--json')+1]==='state,headRefOid,labels,files';out({state:s.closed?'CLOSED':'OPEN',headRefOid:fresh&&s.moved?'c'.repeat(40):s.sha,headRefName:'docs-fix',author:{login:'owner'},baseRefName:'main',title:'Docs repair',body:'',labels:(fresh&&s.revoked?[]:s.labels).map(name=>({name})),files:s.files,commits:[],statusCheckRollup:[],url:'https://github.com/'+s.repo+'/pull/2'});}
else if(a[0]==='api'){
 const p=a.find(x=>x.startsWith('repos/'))||a[1];
 if(p==='user')out({login:'clawsweeper[bot]'});
 else if(p.includes('/actions/runs/')&&p.includes('/attempts/'))out({id:Number(s.run),run_attempt:1,repository:{full_name:s.repo},path:'.github/workflows/pi-pr-review.yml',event:s.sourceEvent||'pull_request_target',status:'completed',head_sha:s.base,run_started_at:'2026-09-22T00:00:00Z'});
 else if(p.includes('/artifacts'))out({artifacts:[{name:'pi-pr-review-lifecycle-'+s.phase+'-1',size_in_bytes:100}]});
 else if(p.includes('/pulls?state=open'))out([{number:2,state:'open',head:{sha:s.sha}}]);
 else if(p.endsWith('/pulls/2'))out({number:2,state:s.closed?'closed':'open',head:{sha:s.sha},base:{ref:'main',sha:s.base,repo:{full_name:s.repo}}});
 else if(p.includes('/pulls/2/files'))paged(s.files);
 else if(p.includes('/issues/comments/'))out({id:9,issue_url:'https://api.github.com/repos/'+s.repo+'/issues/2',user:{login:'github-actions[bot]'},created_at:'2026-09-22T00:01:00Z',updated_at:'2026-09-22T00:01:00Z',body:'<!-- pi-pr-review-lifecycle:'+JSON.stringify({...identity,verdict:s.verdict})+' -->\\nFix broken docs link.'});
 else if(p.includes('/check-runs'))out({check_runs:[{name:'pi-pr-review/verdict',head_sha:s.sha,app:{slug:'github-actions'},status:'completed',conclusion:s.verdict==='pass'?'success':'failure',external_id:'pi-pr-review:'+s.run+':1',details_url:'https://github.com/'+s.repo+'/actions/runs/'+s.run+'/attempts/1'}]});
 else if(p.endsWith('/issues/2'))out({number:2,state:'open',pull_request:{url:'fixture'},labels:s.labels.map(name=>({name}))});
 else if(p.includes('/comments')&&a.includes('--method'))out({id:10});
 else if(p.includes('/issues/2/comments'))paged([{id:9,user:{login:'github-actions[bot]'},body:'<!-- pi-pr-review-lifecycle:'+JSON.stringify({...identity,verdict:s.verdict})+' -->\\nFix broken docs link.'}]);
 else if(p.includes('/comments'))paged([]);
 else if(p.includes('/actions/'))out(a.includes('--jq')?[]:{workflow_runs:[],runners:[]});
 else {console.error('UNHANDLED '+JSON.stringify(a));process.exit(1);}
}else{console.error('UNHANDLED '+JSON.stringify(a));process.exit(1);}
`,
  );
  fs.chmodSync(path.join(dir, "bin/gh"), 0o755);
  const job = path.join(dir, automergeJobPath(repo, 2));
  fs.mkdirSync(path.dirname(job), { recursive: true });
  fs.writeFileSync(
    job,
    renderAutomergeJob({
      repo,
      issueNumber: 2,
      title: "Docs repair",
      repairMode: "autofix",
      author: "owner",
      authorId: 1,
      commentUrl: "https://github.com/fixture",
    }),
  );
  function run(overrides = {}) {
    Object.assign(state, overrides);
    state.calls = [];
    state.fetches = [];
    fs.writeFileSync(path.join(dir, "fixture.json"), JSON.stringify(state));
    fs.writeFileSync(
      path.join(dir, "event.json"),
      JSON.stringify({
        action: "clawsweeper_review_lifecycle",
        client_payload: {
          target_repo: repo,
          item_number: 2,
          head_sha: state.sha,
          source_run_id: state.run,
          source_run_attempt: 1,
          phase: state.phase,
          comment_id: "9",
        },
      }),
    );
    const eventArgs = state.lifecycleOnly
      ? []
      : ["--lifecycle-event", path.join(dir, "event.json")];
    const child = spawnSync(
      process.execPath,
      [
        "--import",
        path.join(dir, "preload.mjs"),
        path.join(dir, "dist/repair/comment-router.js"),
        "--repo",
        repo,
        ...eventArgs,
        "--execute",
      ],
      {
        cwd: dir,
        encoding: "utf8",
        timeout: 20000,
        env: {
          ...process.env,
          PATH: `${dir}/bin:${process.env.PATH}`,
          FIXTURE: path.join(dir, "fixture.json"),
          CLAWROUTER_API_KEY: "fixture",
          CLAWSWEEPER_TRUSTED_BOTS: "clawsweeper[bot]",
          CLAWSWEEPER_COMMENT_ROUTER_MAX_LIVE_WORKERS: "100",
          CLAWSWEEPER_LIFECYCLE_EVENT: "",
          CLAWSWEEPER_LIFECYCLE_ONLY: state.lifecycleOnly ? "true" : "false",
        },
      },
    );
    Object.assign(state, JSON.parse(fs.readFileSync(path.join(dir, "fixture.json"), "utf8")));
    assert.equal(child.status, 0, child.stderr || child.error?.message || child.stdout);
    return JSON.parse(child.stdout).commands[0];
  }
  return { dir, state, run };
}
test("router executes review -> repair -> new head pass and ignores replay", (t) => {
  const f = fixture(t);
  assert.equal(f.run({ phase: "started" }).lifecycle_state, "agent:reviewing");
  const repaired = f.run({ phase: "completed" });
  assert.equal(repaired.lifecycle_state, "agent:fixing");
  assert.ok(
    f.state.calls.some(
      (a) =>
        a[0] === "workflow" &&
        a.includes(`expected_head_sha=${sha}`) &&
        a.includes("expected_pr_number=2"),
    ),
  );
  assert.equal(f.run().status, "skipped");
  assert.equal(f.run({ phase: "started" }).status, "skipped");
  assert.equal(f.state.fetches.length, 0);
  assert.equal(
    f.run({ phase: "completed", run: "43", sha: "c".repeat(40), verdict: "pass" }).lifecycle_state,
    "agent:review-passed",
  );
  assert.ok(f.state.labels.includes("clawsweeper:autofix"));
  assert.equal(f.state.labels.includes("agent:fixing"), false);
});
test("router guards revoke/moved heads and unsafe or unauthorized scopes before dispatch", (t) => {
  for (const scenario of [
    { revoked: true },
    { moved: true },
    { labels: [] },
    { files: [{ filename: "services/runtime.ts" }] },
    { classifierFailure: true },
    { labels: ["clawsweeper:autofix", "clawsweeper:human-review"] },
    { labels: ["clawsweeper:automerge"] },
  ]) {
    const f = fixture(t);
    const result = f.run(scenario);
    assert.ok(
      ["clawsweeper:human-review", undefined].includes(result.lifecycle_state) ||
        result.status === "skipped",
    );
    assert.equal(
      f.state.calls.some((a) => a[0] === "workflow"),
      false,
    );
    if (scenario.labels || scenario.files) assert.equal(f.state.fetches.length, 0);
  }
});
test("router applies existing repair cap and records native fallback audit", (t) => {
  const capped = fixture(t);
  fs.mkdirSync(path.join(capped.dir, "results"), { recursive: true });
  fs.writeFileSync(
    path.join(capped.dir, "results/comment-router.json"),
    JSON.stringify({
      commands: Array.from({ length: 2 }, (_, i) => ({
        idempotency_key: `prior-${i}`,
        repo,
        issue_number: 2,
        intent: "clawsweeper_auto_repair",
        status: "executed",
        target: { head_sha: sha },
      })),
    }),
  );
  assert.equal(capped.run().lifecycle_state, "clawsweeper:human-review");
  assert.equal(
    capped.state.calls.some((a) => a[0] === "workflow"),
    false,
  );
  assert.equal(capped.state.fetches.length, 0);
  const notice = capped.state.calls.find(
    (a) => a[0] === "api" && a.includes("POST") && a.some((x) => x.endsWith("/comments")),
  );
  assert.ok(notice);
  const body = JSON.parse(fs.readFileSync(notice[notice.indexOf("--input") + 1], "utf8")).body;
  assert.match(body, /Owner: @valkyriweb/);
  assert.match(body, /clawsweeper-pi-human:/);
  assert.match(body, /2 total time/);
  assert.equal(capped.run().status, "skipped");
  assert.equal(
    capped.state.calls.some((a) => a.includes("POST")),
    false,
  );
  const fallback = fixture(t);
  assert.equal(fallback.run({ fallback: true }).classification.source, "fallback");
  assert.equal(fallback.state.fetches.length, 2);
  const saved = readLedger(path.join(fallback.dir, "results/comment-router.json")).commands[0];
  assert.equal(saved.classification.attempts, 2);
  assert.equal(saved.source_run_id, "42");
});
test("router rejects closed and untrusted runs and non-opted-in repositories without mutation", (t) => {
  for (const overrides of [{ closed: true }, { sourceEvent: "pull_request" }]) {
    const f = fixture(t);
    assert.throws(() => f.run(overrides));
    assert.equal(
      f.state.calls.some((a) => ["workflow", "label", "issue"].includes(a[0])),
      false,
    );
  }
  const f = fixture(t),
    configPath = path.join(f.dir, "config/target-repositories.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  config.repositories.find((p) => p.target_repo === repo).pi_review_lifecycle = false;
  fs.writeFileSync(configPath, JSON.stringify(config));
  assert.equal(f.run().status, "skipped");
  assert.equal(f.state.fetches.length, 0);
  assert.equal(
    f.state.calls.some((a) => ["workflow", "label", "issue"].includes(a[0])),
    false,
  );
});
test("scheduled discovery recovers a missing first delivery and publishes before one dispatch", (t) => {
  const f = fixture(t);
  fs.unlinkSync(path.join(f.dir, automergeJobPath(repo, 2)));
  const waiting = f.run({ lifecycleOnly: true });
  assert.equal(waiting.status, "waiting");
  assert.equal(waiting.lifecycle_state, "agent:fix-requested");
  assert.equal(
    f.state.calls.some((a) => a[0] === "workflow"),
    false,
  );
  for (const args of [
    ["init", "-q"],
    ["add", "jobs", "results"],
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-qm",
      "publish recovery job and receipt",
    ],
  ]) {
    const result = spawnSync("git", args, { cwd: f.dir, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  }
  assert.equal(f.run().lifecycle_state, "agent:fixing");
  assert.equal(f.state.calls.filter((a) => a[0] === "workflow").length, 1);
  f.run();
  assert.equal(
    f.state.calls.some((a) => a[0] === "workflow"),
    false,
  );
  assert.equal(
    readLedger(path.join(f.dir, "results/comment-router.json")).lifecycle_discovery_pages[repo],
    1,
  );
});
test("scheduled discovery replaces a terminal old-head pass after both new notifications are missed", (t) => {
  const f = fixture(t);
  assert.equal(f.run({ verdict: "pass" }).lifecycle_state, "agent:review-passed");
  assert.equal(
    f.run({ lifecycleOnly: true, sha: "c".repeat(40), run: "43", verdict: "fail" }).lifecycle_state,
    "agent:fixing",
  );
  assert.equal(f.state.labels.includes("agent:review-passed"), false);
  assert.equal(f.state.calls.filter((a) => a[0] === "workflow").length, 1);
});

test("ledger roundtrip preserves audit and replay ordering", (t) => {
  const f = fixture(t),
    ledger = { commands: [] };
  const entry = {
    repo,
    issue_number: 2,
    idempotency_key: "fixture",
    status: "executed",
    automation_source: "pi_review_lifecycle",
    source_run_id: "42",
    source_run_attempt: 2,
    lifecycle_phase: "completed",
    lifecycle_state: "agent:fixing",
    expected_head_sha: sha,
    reason: "actionable",
    classification: {
      source: "fallback",
      model: "claude-sonnet-5",
      attempts: 2,
      classification: "actionable",
      diagnostics: ["Jev unresolved"],
    },
  };
  appendLedger(ledger, [entry]);
  const file = path.join(f.dir, "ledger.json");
  writeLedger(file, ledger);
  const saved = readLedger(file).commands[0];
  for (const key of [
    "lifecycle_state",
    "lifecycle_phase",
    "source_run_id",
    "source_run_attempt",
    "expected_head_sha",
    "reason",
    "classification",
  ])
    assert.deepEqual(saved[key], entry[key]);
  assert.ok(lifecycleReplayReason({ ...entry, lifecycle_phase: "started" }, [saved]));
  assert.equal(
    appendLedger(ledger, [
      { ...entry, status: "skipped", reason: "Pi lifecycle event already processed in ledger" },
    ]),
    false,
  );
  assert.equal(ledger.commands[0].status, "executed");
  const waiting = {
    ...entry,
    comment_version_key: "waiting-fixture",
    idempotency_key: "waiting-fixture",
    status: "waiting",
    lifecycle_state: "agent:fix-requested",
  };
  assert.equal(appendLedger(ledger, [waiting]), true);
  assert.equal(
    ledger.commands.find((c) => c.idempotency_key === "waiting-fixture").status,
    "waiting",
  );
});
