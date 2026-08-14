import assert from "node:assert/strict";
import test from "node:test";

import {
  isPackageManagerNonScriptCommand,
  packageScriptRequirement,
  parseAllowedValidationCommand,
  pnpmCommandStart,
} from "../../dist/repair/validation-command-utils.js";

test("pnpm built-in commands are not treated as required package scripts", () => {
  for (const command of [
    "pnpm install",
    "pnpm dedupe",
    "pnpm audit",
    "pnpm why react",
    "pnpm outdated",
    "pnpm store prune",
    "pnpm licenses list",
    "pnpm exec tsc",
    "pnpm dlx tsx foo.ts",
    "pnpm rebuild",
    "pnpm publish",
    "pnpm update",
    "pnpm pkg get name",
  ]) {
    assert.equal(
      packageScriptRequirement(command.split(" ")),
      null,
      `expected no script requirement for ${command}`,
    );
  }
});

test("pnpm aliases resolve to their canonical command or script", () => {
  assert.equal(packageScriptRequirement(["pnpm", "i"]), null);
  assert.equal(packageScriptRequirement(["pnpm", "up"]), null);
  assert.equal(packageScriptRequirement(["pnpm", "ls"]), null);
  assert.deepEqual(packageScriptRequirement(["pnpm", "t"]), {
    name: "test",
    command: "pnpm test",
  });
});

test("real package scripts are still reported", () => {
  assert.deepEqual(packageScriptRequirement(["pnpm", "check"]), {
    name: "check",
    command: "pnpm check",
  });
  assert.deepEqual(packageScriptRequirement(["pnpm", "run", "check"]), {
    name: "check",
    command: "pnpm check",
  });
  assert.deepEqual(packageScriptRequirement(["pnpm", "-s", "test", "test/a.test.ts"]), {
    name: "test",
    command: "pnpm test",
  });
  assert.deepEqual(packageScriptRequirement(["npm", "run", "validate"]), {
    name: "validate",
    command: "npm run validate",
  });
});

test("pnpm run never falls back to built-in classification", () => {
  assert.deepEqual(packageScriptRequirement(["pnpm", "run", "install"]), {
    name: "install",
    command: "pnpm install",
  });
  assert.equal(packageScriptRequirement(["pnpm", "run"]), null);
});

test("global options are skipped before the subcommand", () => {
  assert.equal(pnpmCommandStart(["pnpm", "-r", "--filter", "web", "check"]), 4);
  assert.equal(pnpmCommandStart(["pnpm", "--loglevel=debug", "check"]), 2);
  assert.equal(pnpmCommandStart(["pnpm", "check"]), 1);
  assert.deepEqual(packageScriptRequirement(["pnpm", "-r", "--filter", "web", "check"]), {
    name: "check",
    command: "pnpm check",
  });
  assert.deepEqual(packageScriptRequirement(["pnpm", "--dir", "packages/api", "test"]), {
    name: "test",
    command: "pnpm test",
  });
  assert.equal(packageScriptRequirement(["pnpm", "-w", "install"]), null);
});

test("env-prefixed commands keep their classification", () => {
  const parts = parseAllowedValidationCommand("env CI=1 pnpm install");
  assert.equal(packageScriptRequirement(parts), null);
  assert.deepEqual(packageScriptRequirement(parseAllowedValidationCommand("CI=1 pnpm check")), {
    name: "check",
    command: "pnpm check",
  });
});

test("non-script classification helper covers npm and pnpm built-ins", () => {
  assert.equal(isPackageManagerNonScriptCommand("ci"), true);
  assert.equal(isPackageManagerNonScriptCommand("workspaces"), true);
  assert.equal(isPackageManagerNonScriptCommand("check"), false);
  assert.equal(isPackageManagerNonScriptCommand("test"), false);
});
