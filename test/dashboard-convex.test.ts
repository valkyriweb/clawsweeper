import assert from "node:assert/strict";
import test from "node:test";

import {
  clearActionsWatchSetting,
  setClawsweeperEnabledSetting,
  type ConvexClawsweeperEnabledAudit,
  type ConvexRepoSettingsClearAudit,
} from "../dashboard/convex.ts";

const CONVEX_ENV = {
  CONVEX_INGEST_URL: "https://demo.convex.cloud/api/mutation",
  CONVEX_INGEST_TOKEN: "convex-ingest-token",
};

type ConvexCall = { path: string; args: Record<string, unknown> };

// Drive Convex writes through a mocked fetch that can simulate an old Convex
// deployment rejecting newly-added mutation args (deploy-skew), and capture
// every attempt so we can assert the modern-then-legacy retry behavior.
function mockConvex(reject: (call: ConvexCall, attempt: number) => boolean) {
  const calls: ConvexCall[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = JSON.parse(String(init?.body)) as ConvexCall;
    calls.push(call);
    if (reject(call, calls.length)) {
      return new Response(
        JSON.stringify({ status: "error", errorMessage: "Object contains extra field" }),
        { headers: { "content-type": "application/json" } },
      );
    }
    return new Response(JSON.stringify({ status: "success", value: null }), {
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { calls, restore: () => void (globalThis.fetch = originalFetch) };
}

function clawsweeperAudit(
  overrides: Partial<ConvexClawsweeperEnabledAudit> = {},
): ConvexClawsweeperEnabledAudit {
  return {
    repository: "valkyriweb/acpx",
    enabled: false,
    defaultEnabled: false,
    defaultActionsWatched: false,
    email: "luke@example.com",
    changedAt: new Date().toISOString(),
    sourceIp: null,
    source: "session",
    ...overrides,
  };
}

function clearAudit(
  overrides: Partial<ConvexRepoSettingsClearAudit> = {},
): ConvexRepoSettingsClearAudit {
  return {
    repository: "valkyriweb/acpx",
    defaultEnabled: false,
    defaultClawsweeperEnabled: false,
    email: "luke@example.com",
    changedAt: new Date().toISOString(),
    sourceIp: null,
    source: "session",
    ...overrides,
  };
}

test("setClawsweeperEnabledSetting sends modern args when Convex accepts them", async () => {
  const convex = mockConvex(() => false);
  try {
    await setClawsweeperEnabledSetting(CONVEX_ENV, clawsweeperAudit());
    assert.equal(convex.calls.length, 1);
    assert.equal(convex.calls[0].path, "repoSettings:setClawsweeperEnabled");
    assert.equal(convex.calls[0].args.defaultEnabled, false);
    assert.equal(convex.calls[0].args.defaultActionsWatched, false);
  } finally {
    convex.restore();
  }
});

test("setClawsweeperEnabledSetting retries without new args when old Convex rejects them", async () => {
  // Old Convex validators reject undeclared fields on the first (modern) attempt.
  const convex = mockConvex((_call, attempt) => attempt === 1);
  try {
    await setClawsweeperEnabledSetting(CONVEX_ENV, clawsweeperAudit());
    assert.equal(convex.calls.length, 2);
    // Legacy retry must drop the fields old Convex does not know about.
    assert.equal("defaultEnabled" in convex.calls[1].args, false);
    assert.equal("defaultActionsWatched" in convex.calls[1].args, false);
    assert.equal(convex.calls[1].args.enabled, false);
  } finally {
    convex.restore();
  }
});

test("clearActionsWatchSetting retries with legacy args for dynamic repos", async () => {
  const convex = mockConvex((_call, attempt) => attempt === 1);
  try {
    await clearActionsWatchSetting(CONVEX_ENV, clearAudit({ defaultClawsweeperEnabled: false }));
    assert.equal(convex.calls.length, 2);
    assert.equal("defaultClawsweeperEnabled" in convex.calls[1].args, false);
  } finally {
    convex.restore();
  }
});

test("clearActionsWatchSetting fails closed for static disable overrides under deploy skew", async () => {
  // A statically targeted repo with an explicit disable override must NOT fall
  // back to the legacy clearActionsWatch path: the old handler would delete the
  // override row and silently re-enable ClawSweeper. Fail closed instead.
  const convex = mockConvex(() => true);
  try {
    await assert.rejects(
      clearActionsWatchSetting(CONVEX_ENV, clearAudit({ defaultClawsweeperEnabled: true })),
    );
    // Only the modern attempt is made; no unsafe legacy retry.
    assert.equal(convex.calls.length, 1);
  } finally {
    convex.restore();
  }
});
