import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const workflow = readFileSync(
  new URL("../../.github/workflows/repair-comment-router.yml", import.meta.url),
  "utf8",
);
test("classifier preflight is isolated from all router mutations", () => {
  const preflight = workflow
    .split("\n  classifier-preflight:\n")[1]
    ?.split("\n  route-comments:\n")[0];
  const router = workflow.split("\n  route-comments:\n")[1]?.split("\n  alert-on-failure:\n")[0];
  assert.ok(preflight);
  assert.ok(router);
  const condition =
    "github.event_name == 'workflow_dispatch' && inputs.lifecycle_only && !inputs.execute";
  assert.ok(preflight.includes("    if: ${{ " + condition + " }}"));
  assert.ok(
    workflow.includes(
      "  group: ${{ " +
        condition +
        " && format('repair-classifier-preflight-{0}', github.ref) || format('repair-comment-router-{0}',",
    ),
  );
  assert.ok(
    router.includes("    if: ${{ github.event_name != 'schedule' && !(" + condition + ") }}"),
  );
  assert.match(preflight, /    permissions:\n      contents: read\n    steps:/);
  assert.match(
    preflight,
    /uses: actions\/checkout@v5\n        with:\n          persist-credentials: false/,
  );
  assert.match(
    preflight,
    /uses: \.\/\.github\/actions\/setup-pnpm\n        with:\n          build-script: build:repair/,
  );
  assert.match(preflight, /timeout-minutes: 5/);
  assert.match(preflight, /classifyReviewText/);
  assert.ok(
    preflight.includes("result.source !== 'jev' || result.classification !== 'actionable'"),
  );
  assert.ok(
    preflight.includes(
      "fallback.source !== 'fallback' || fallback.classification !== 'actionable'",
    ),
  );
  assert.ok(preflight.includes("probe: 'forced-fallback'"));
  assert.doesNotMatch(
    preflight,
    /create-target-token|create-state-token|setup-state|repair:comment-router|repair:publish-main|GH_TOKEN/,
  );
  assert.doesNotMatch(router, /classifyReviewText|read-only preflight/);
  assert.match(router, /create-target-token/);
  assert.match(router, /repair:publish-main/);
});

test("classifier and router use the configured self-hosted pool, not worker runner inputs", () => {
  const selection =
    '    runs-on: ${{ fromJSON(vars.CLAWSWEEPER_RUNNER_LABELS || \'["self-hosted","lue-clawsweeper"]\') }}';
  for (const job of ["classifier-preflight", "route-comments"]) {
    const block = workflow.split(`\n  ${job}:\n`)[1]?.split(/\n  [a-z][a-z-]+:\n/)[0];
    assert.ok(block);
    assert.ok(block.includes(selection));
    assert.doesNotMatch(
      block,
      /runs-on: ubuntu-latest|runs-on:.*inputs\.(?:runner|execution_runner)/,
    );
  }
  for (const job of ["fan-out-scheduled-sweep", "alert-on-failure"]) {
    const block = workflow.split(`\n  ${job}:\n`)[1]?.split(/\n  [a-z][a-z-]+:\n/)[0];
    assert.ok(block?.includes("    runs-on: ubuntu-latest"));
  }
});

const bindings = {
  DISPATCH_TARGET_REPO: ["target_repo", "--repo"],
  DISPATCH_LOOKBACK_MINUTES: ["lookback_minutes", "--lookback-minutes"],
  DISPATCH_MAX_COMMENTS: ["max_comments", "--max-comments"],
  DISPATCH_ITEM_NUMBER: ["item_number", "--item-numbers"],
  DISPATCH_COMMENT_ID: ["comment_id", "--comment-ids"],
  DISPATCH_STATUS_COMMENT_ID: ["status_comment_id", "--status-comment-id"],
  DISPATCH_FORCE_REPROCESS: ["force_reprocess", "--force-reprocess"],
};

for (const name of ["Route ClawSweeper comments", "Retry waiting repair dispatches"]) {
  test(`${name} treats dispatch payload as data and preserves manual inputs`, () => {
    const step = workflow.split(`      - name: ${name}\n`)[1]?.split("\n      - ")[0];
    assert.ok(step);
    const script = step.split("        run: |\n")[1].replace(/^          /gm, "");
    assert.doesNotMatch(script, /\$\{\{[^}]*github\.event\.client_payload/);
    for (const [variable, [field]] of Object.entries(bindings)) {
      assert.match(
        workflow,
        new RegExp(
          `  ${variable}: \\$\\{\\{ github\\.event\\.client_payload\\.${field}(?: | \\|\\|)`,
        ),
      );
    }
    const dir = mkdtempSync(join(tmpdir(), "router-shell-"));
    try {
      const marker = join(dir, "injected");
      const payload = `"; touch '${marker}'; # $(touch '${marker}') \`touch '${marker}'\` 'quoted'\nnext line`;
      const env = {
        ...process.env,
        ROUTER_TARGET_REPO: "owner/manual",
        ROUTER_LOOKBACK_MINUTES: "180",
        ROUTER_SINCE: "2026-01-01T00:00:00Z",
        ROUTER_MAX_COMMENTS: "100",
        ROUTER_ITEM_NUMBERS: "42",
        ROUTER_COMMENT_IDS: "123",
        ROUTER_RUNNER: '["self-hosted","macOS"]',
        ROUTER_EXECUTION_RUNNER: '["self-hosted","macOS"]',
        ROUTER_FORCE_REPROCESS: "true",
        ...Object.fromEntries(Object.keys(bindings).map((key) => [key, payload])),
      };
      for (const event of ["repository_dispatch", "workflow_dispatch"]) {
        const rendered = script.replace(/\$\{\{\s*(.*?)\s*\}\}/g, (_, expression: string) => {
          if (expression === "github.event_name") return event;
          if (expression === "inputs.execute") return "true";
          if (expression === "steps.waiting-repair-dispatches.outputs.count") return "1";
          if (expression === "vars.CLAWSWEEPER_COMMENT_ROUTER_EXECUTE || '0'") return "0";
          throw new Error(`Unexpected shell interpolation: ${expression}`);
        });
        const result = spawnSync("bash", ["-c", `pnpm() { printf '%s\\0' "$@"; }\n${rendered}`], {
          env,
          encoding: "utf8",
        });
        assert.equal(result.status, 0, result.stderr);
        assert.equal(existsSync(marker), false, "payload executed a command");
        // The retry step prints a progress line before invoking pnpm.
        const args = result.stdout
          .slice(result.stdout.indexOf("run\0repair:comment-router\0"))
          .split("\0");
        assert.ok(args.includes("--execute"));
        if (event === "repository_dispatch") {
          for (const [, flag] of Object.values(bindings).slice(0, -1)) {
            assert.equal(args[args.indexOf(flag) + 1], payload);
          }
          assert.ok(!args.includes("--force-reprocess"));
          assert.ok(!args.includes("--since"));
        } else {
          for (const [flag, value] of [
            ["--repo", env.ROUTER_TARGET_REPO],
            ["--since", env.ROUTER_SINCE],
            ["--item-numbers", "42"],
            ["--comment-ids", "123"],
            ["--runner", env.ROUTER_RUNNER],
          ]) {
            assert.equal(args[args.indexOf(flag) + 1], value);
          }
          assert.ok(args.includes("--force-reprocess"));
          assert.ok(!args.includes("--status-comment-id"));
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
