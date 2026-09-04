import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_ACTION_CONFIG,
  MODEL_ACTIONS,
  applyRegistrySet,
  isModelAction,
  managedModel,
  modelCatalogRows,
  parseModelRegistry,
  resolveActionConfig,
  resolveAllActions,
  serializeRegistry,
} from "../dist/model-registry.js";

test("unset registry resolves to production defaults", () => {
  const registry = parseModelRegistry(undefined);
  assert.deepEqual(registry, {});
  for (const action of MODEL_ACTIONS) {
    assert.deepEqual(resolveActionConfig(action, registry), DEFAULT_ACTION_CONFIG[action]);
  }
  // Empty string behaves like unset.
  assert.deepEqual(parseModelRegistry(""), {});
  assert.deepEqual(parseModelRegistry("   "), {});
});

test("defaults reflect the intended balance", () => {
  assert.deepEqual(DEFAULT_ACTION_CONFIG["sweep-review"], {
    provider: "pi",
    model: "clawrouter/claude-opus-5",
    effort: "none",
  });
  assert.equal(DEFAULT_ACTION_CONFIG["commit-review"].model, "gpt-5.6-terra");
  assert.equal(DEFAULT_ACTION_CONFIG["repair-worker"].model, "gpt-5.6-terra");
  assert.equal(DEFAULT_ACTION_CONFIG["issue-implementation"].model, "gpt-5.6-terra");
});

test("partial overrides merge field-by-field over defaults", () => {
  const registry = parseModelRegistry(JSON.stringify({ "commit-review": { effort: "medium" } }));
  const resolved = resolveActionConfig("commit-review", registry);
  assert.deepEqual(resolved, { provider: "codex", model: "gpt-5.6-terra", effort: "medium" });
  // Other actions untouched.
  assert.deepEqual(
    resolveActionConfig("sweep-review", registry),
    DEFAULT_ACTION_CONFIG["sweep-review"],
  );
});

test("full override replaces every field", () => {
  const registry = parseModelRegistry(
    JSON.stringify({
      "sweep-review": { provider: "pi", model: "clawrouter/claude-opus-5", effort: "low" },
    }),
  );
  assert.deepEqual(resolveActionConfig("sweep-review", registry), {
    provider: "pi",
    model: "clawrouter/claude-opus-5",
    effort: "low",
  });
});

test("resolveAllActions covers every action", () => {
  const resolved = resolveAllActions(parseModelRegistry(undefined));
  assert.deepEqual(Object.keys(resolved).sort(), [...MODEL_ACTIONS].sort());
});

test("rejects unknown action, provider, model, and effort", () => {
  assert.throws(() => parseModelRegistry(JSON.stringify({ nope: {} })), /unknown action/);
  assert.throws(
    () => parseModelRegistry(JSON.stringify({ "commit-review": { provider: "bogus" } })),
    /not a known provider/,
  );
  assert.throws(
    () => parseModelRegistry(JSON.stringify({ "commit-review": { model: "gpt-9" } })),
    /not allowed for provider/,
  );
  assert.throws(
    () => parseModelRegistry(JSON.stringify({ "commit-review": { effort: "ludicrous" } })),
    /effort must be one of/,
  );
});

test("rejects provider an action does not support", () => {
  assert.throws(
    () => parseModelRegistry(JSON.stringify({ "repair-worker": { provider: "pi" } })),
    /does not support provider/,
  );
});

test("rejects model that does not belong to the chosen provider", () => {
  assert.throws(
    () =>
      parseModelRegistry(
        JSON.stringify({ "sweep-review": { provider: "pi", model: "gpt-5.6-terra" } }),
      ),
    /not allowed for provider/,
  );
});

test("malformed JSON and non-object roots fail closed", () => {
  assert.throws(() => parseModelRegistry("{not json"), /not valid JSON/);
  assert.throws(() => parseModelRegistry("[]"), /keyed by action/);
  assert.throws(() => parseModelRegistry("42"), /keyed by action/);
});

test("applyRegistrySet merges onto existing config and returns canonical JSON", () => {
  const current = JSON.stringify({
    "commit-review": { provider: "codex", model: "gpt-5.6-terra" },
  });
  const { json, resolved } = applyRegistrySet(current, "commit-review", { effort: "low" });
  assert.deepEqual(resolved, { provider: "codex", model: "gpt-5.6-terra", effort: "low" });
  const reparsed = parseModelRegistry(json);
  assert.deepEqual(reparsed["commit-review"], {
    provider: "codex",
    model: "gpt-5.6-terra",
    effort: "low",
  });
});

test("applyRegistrySet on empty registry seeds one action", () => {
  const { json } = applyRegistrySet(undefined, "issue-implementation", { effort: "medium" });
  assert.deepEqual(JSON.parse(json), { "issue-implementation": { effort: "medium" } });
});

test("applyRegistrySet validates the merged entry as a whole", () => {
  // Existing provider pi + new model gpt-5.6-terra is invalid together.
  const current = JSON.stringify({ "sweep-review": { provider: "pi" } });
  assert.throws(
    () => applyRegistrySet(current, "sweep-review", { model: "gpt-5.6-terra" }),
    /not allowed for provider/,
  );
});

test("serializeRegistry emits canonical action order and field order", () => {
  const json = serializeRegistry({
    "issue-implementation": { effort: "high" },
    "sweep-review": { effort: "none", model: "clawrouter/claude-opus-5", provider: "pi" },
  });
  const keys = Object.keys(JSON.parse(json));
  assert.deepEqual(keys, ["sweep-review", "issue-implementation"]);
  assert.deepEqual(Object.keys(JSON.parse(json)["sweep-review"]), ["provider", "model", "effort"]);
});

test("catalog lists codex + anthropic models and flags deprecated/effort", () => {
  const rows = modelCatalogRows();
  const terra = rows.find((row) => row.model === "gpt-5.6-terra");
  const legacy = rows.find((row) => row.model === "gpt-5.5");
  const opus = rows.find((row) => row.provider === "pi" && row.model === "clawrouter/claude-opus-5");
  assert.ok(terra && terra.provider === "codex" && terra.supportsEffort && !terra.deprecated);
  assert.ok(legacy && legacy.deprecated);
  assert.ok(opus && !opus.supportsEffort);
});

test("isModelAction guards the action union", () => {
  assert.ok(isModelAction("sweep-review"));
  assert.ok(!isModelAction("sweep"));
  assert.ok(!isModelAction(42));
});

test("managedModel precedence: explicit -> override -> legacyEnv -> default", () => {
  const prior = process.env.CLAWSWEEPER_MODELS;
  try {
    delete process.env.CLAWSWEEPER_MODELS;
    // Default when nothing supplied.
    assert.equal(managedModel("repair-worker", undefined, undefined), "gpt-5.6-terra");
    // Legacy env used when no explicit/override.
    assert.equal(managedModel("repair-worker", undefined, "gpt-5.5"), "gpt-5.5");
    // Explicit wins over legacy env.
    assert.equal(managedModel("repair-worker", "gpt-5.6-terra", "gpt-5.5"), "gpt-5.6-terra");
    // Whitespace-only explicit/env is ignored.
    assert.equal(managedModel("repair-worker", "  ", "  "), "gpt-5.6-terra");
    // Registry override beats legacy env but loses to explicit.
    process.env.CLAWSWEEPER_MODELS = JSON.stringify({
      "repair-worker": { model: "gpt-5.5" },
    });
    assert.equal(managedModel("repair-worker", undefined, "gpt-5.6-terra"), "gpt-5.5");
    assert.equal(managedModel("repair-worker", "opus-explicit", "gpt-5.6-terra"), "opus-explicit");
  } finally {
    if (prior === undefined) delete process.env.CLAWSWEEPER_MODELS;
    else process.env.CLAWSWEEPER_MODELS = prior;
  }
});

test("commit-review rejects claude-bridge (narrowed ACTION_PROVIDERS)", () => {
  assert.throws(
    () =>
      applyRegistrySet(undefined, "commit-review", {
        provider: "claude-bridge",
        model: "clawrouter/claude-opus-5",
      }),
    /does not support provider "claude-bridge"/,
  );
});

test("provider-only entry over an empty slot is rejected when the default model is incompatible", () => {
  // {provider:"pi"} with no model would resolve to the codex default model.
  assert.throws(
    () => applyRegistrySet(undefined, "commit-review", { provider: "pi" }),
    /requires an explicit model/,
  );
  // provider + a valid model for that provider is accepted.
  const { resolved } = applyRegistrySet(undefined, "commit-review", {
    provider: "pi",
    model: "clawrouter/claude-opus-5",
  });
  assert.equal(resolved.provider, "pi");
  assert.equal(resolved.model, "clawrouter/claude-opus-5");
});
