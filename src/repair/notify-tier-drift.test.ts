import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runNotifyTierDrift } from "./notify-tier-drift.js";

type HookCall = { to: unknown; channel: unknown; message: string; idempotencyKey: string };

function makeRecords(entries: { tier: string; kind?: string }[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-drift-"));
  const items = path.join(dir, "records", "acme_repo", "items");
  fs.mkdirSync(items, { recursive: true });
  entries.forEach((entry, index) => {
    fs.writeFileSync(
      path.join(items, `${index + 1}.md`),
      `---\ntype: ${entry.kind ?? "pull_request"}\nreview_tier: ${entry.tier}\npr_rating_overall_tier: B\n---\n\nbody\n`,
    );
  });
  return path.join(dir, "records");
}

function critical(count: number): { tier: string }[] {
  return Array.from({ length: count }, () => ({ tier: "critical" }));
}

function fakeFetch(calls: HookCall[]): typeof fetch {
  return (async (_input: string | URL | Request, init?: RequestInit) => {
    calls.push(JSON.parse(String(init?.body ?? "{}")) as HookCall);
    return new Response(JSON.stringify({ runId: "run-1" }), { status: 200 });
  }) as typeof fetch;
}

const HOOK_ENV = {
  CLAWSWEEPER_OPENCLAW_HOOK_URL: "https://hook.example/agent",
  CLAWSWEEPER_OPENCLAW_HOOK_TOKEN: "t0ken",
};

test("posts to the dedicated drift channel when drift is detected", async () => {
  const records = makeRecords([...critical(7), { tier: "important" }]);
  const calls: HookCall[] = [];
  const result = await runNotifyTierDrift([`--records=${records}`], {
    env: { ...HOOK_ENV, CLAWSWEEPER_TIER_DRIFT_DISCORD_TARGET: "#clawsweeper-drift" },
    fetch: fakeFetch(calls),
    log: () => {},
  });

  assert.equal(result.status, "posted");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.to, "#clawsweeper-drift");
  assert.equal(calls[0]?.channel, "discord");
  assert.match(calls[0]?.message ?? "", /reviewTier drift/);
  assert.match(calls[0]?.idempotencyKey ?? "", /^clawsweeper-tier-drift-[0-9a-f]{16}$/);
});

test("skips quietly when there is no drift", async () => {
  const records = makeRecords([{ tier: "routine" }, { tier: "important" }]);
  const calls: HookCall[] = [];
  const result = await runNotifyTierDrift([`--records=${records}`], {
    env: { ...HOOK_ENV, CLAWSWEEPER_TIER_DRIFT_DISCORD_TARGET: "#clawsweeper-drift" },
    fetch: fakeFetch(calls),
    log: () => {},
  });

  assert.equal(result.status, "skipped");
  assert.equal(calls.length, 0);
});

test("skips detected drift when the drift channel is unset", async () => {
  const records = makeRecords(critical(8));
  const calls: HookCall[] = [];
  const result = await runNotifyTierDrift([`--records=${records}`], {
    env: { ...HOOK_ENV },
    fetch: fakeFetch(calls),
    log: () => {},
  });

  assert.equal(result.status, "skipped");
  assert.match(result.reason, /CLAWSWEEPER_TIER_DRIFT_DISCORD_TARGET/);
  assert.equal(calls.length, 0);
});

test("skips detected drift when the OpenClaw hook is not configured", async () => {
  const records = makeRecords(critical(8));
  const calls: HookCall[] = [];
  const result = await runNotifyTierDrift([`--records=${records}`], {
    env: { CLAWSWEEPER_TIER_DRIFT_DISCORD_TARGET: "#clawsweeper-drift" },
    fetch: fakeFetch(calls),
    log: () => {},
  });

  assert.equal(result.status, "skipped");
  assert.equal(calls.length, 0);
});
