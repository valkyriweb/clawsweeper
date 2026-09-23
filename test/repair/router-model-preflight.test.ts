import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";

const workflow = readFileSync(".github/workflows/repair-comment-router.yml", "utf8");
const router = workflow.slice(workflow.indexOf("  route-comments:"));

test("router validates the worker registry before credentials or dispatch", () => {
  assert.match(router, /env:\n\s+CLAWSWEEPER_MODELS: \$\{\{ vars.CLAWSWEEPER_MODELS \|\| '' \}\}/);
  const preflight = router.indexOf("pnpm run --silent workflow -- models list");
  assert.ok(preflight > 0);
  assert.ok(preflight < router.indexOf("- name: Create target token"));
  assert.ok(preflight < router.indexOf("- name: Route ClawSweeper comments"));
});

test("repair executor honors the configured Codex transport", () => {
  const worker = readFileSync(".github/workflows/repair-cluster-worker.yml", "utf8");
  const executor = worker.slice(worker.indexOf("    name: Execute and apply cluster actions"));
  assert.match(
    executor,
    /auth-mode: \$\{\{ vars.CLAWSWEEPER_CODEX_AUTH_MODE \|\| 'subscription' \}\}/,
  );
  assert.match(executor, /CLAWROUTER_API_KEY:.*vars.CLAWSWEEPER_CODEX_AUTH_MODE == 'clawrouter'/);
  assert.doesNotMatch(executor.slice(0, executor.indexOf("    steps:")), /CLAWROUTER_API_KEY/);
  assert.equal(executor.match(/CLAWROUTER_API_KEY:/g)?.length, 2);
});

test("registry preflight rejects drift without an authenticated GitHub client", () => {
  const result = spawnSync(process.execPath, ["dist/repair/workflow-utils.js", "models", "list"], {
    encoding: "utf8",
    timeout: 10_000,
    env: {
      ...process.env,
      GH_TOKEN: "",
      GITHUB_TOKEN: "",
      CLAWSWEEPER_MODELS: JSON.stringify({
        "commit-review": { provider: "codex", model: "not-a-model" },
      }),
    },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /not allowed for provider/);
});
