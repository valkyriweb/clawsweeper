import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const workflow = readFileSync(
  new URL("../../.github/workflows/repair-cluster-worker.yml", import.meta.url),
  "utf8",
);

for (const job of ["cluster", "execute"]) {
  test(`${job} checkout retains worker scripts after a sparse router checkout`, () => {
    const block = workflow.split(`\n  ${job}:\n`)[1]?.split(/\n  [a-z][a-z-]+:\n/)[0];
    assert.ok(block);
    const checkout = block.split("- uses: actions/checkout@v5\n")[1]?.split("\n      - ")[0];
    assert.ok(checkout);
    const root = mkdtempSync(join(tmpdir(), "worker-checkout-"));
    const git = (...args: string[]) =>
      execFileSync("git", args, {
        cwd: root,
        env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
        timeout: 10_000,
        stdio: "pipe",
      });
    try {
      git("init", "--quiet");
      mkdirSync(join(root, "scripts"));
      writeFileSync(join(root, "scripts/hydrate-state.ts"), "fixture\n");
      writeFileSync(join(root, "scripts/restore-repair-job.sh"), "fixture\n");
      git("add", ".");
      git(
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "-qm",
        "fixture",
      );
      // actions/checkout non-cone mode writes repository-local sparse settings.
      git("config", "--local", "core.sparseCheckout", "true");
      writeFileSync(join(root, ".git/info/sparse-checkout"), "scripts/hydrate-state.ts\n");
      git("read-tree", "-mu", "HEAD");
      assert.equal(existsSync(join(root, "scripts/restore-repair-job.sh")), false);

      if (/sparse-checkout: \|\n\s+\/\*\n/.test(checkout)) {
        assert.match(checkout, /sparse-checkout-cone-mode: false/);
        writeFileSync(join(root, ".git/info/sparse-checkout"), "/*\n", { flag: "a" });
      } else {
        // checkout's full-tree path: disabling creates config.worktree overrides;
        // removing the extension exposes the old repository-local true value.
        git("sparse-checkout", "disable");
        git("config", "--local", "--unset-all", "extensions.worktreeConfig");
      }
      git("checkout", "--force", "HEAD");
      assert.equal(existsSync(join(root, "scripts/restore-repair-job.sh")), true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
