// Remotely-configurable model + reasoning-effort registry.
//
// A single GitHub repository variable, `CLAWSWEEPER_MODELS`, holds action-keyed
// JSON that overrides the per-action model / provider / reasoning-effort used by
// ClawSweeper lanes. When the variable is unset (or an action/field is absent),
// the built-in `DEFAULT_ACTION_CONFIG` is used, so production behaviour is
// unchanged until an operator opts in via `clawsweeper models set`.
//
// This module is intentionally free of I/O: it parses, validates, resolves, and
// merges. The CLI (`src/repair/workflow-utils.ts`) owns reading `process.env`
// and writing the variable through `gh`.

import type { ReviewProvider } from "./repository-profiles.js";

/** Lanes whose model/effort can be steered from the registry. */
export type ModelAction =
  | "sweep-review"
  | "commit-review"
  | "repair-worker"
  | "issue-implementation";

export const MODEL_ACTIONS: readonly ModelAction[] = [
  "sweep-review",
  "commit-review",
  "repair-worker",
  "issue-implementation",
];

const MODEL_ACTION_SET = new Set<ModelAction>(MODEL_ACTIONS);

/** Codex reasoning-effort levels (advisory for non-codex providers). */
export type ReasoningEffort = "none" | "low" | "medium" | "high";

export const REASONING_EFFORTS: readonly ReasoningEffort[] = ["none", "low", "medium", "high"];

const REASONING_EFFORT_SET = new Set<ReasoningEffort>(REASONING_EFFORTS);

/** Models allowed per review provider. `codex` is served today; the anthropic
 * family (opus/sonnet) is reachable through `pi` / `claude-bridge` /
 * `claude-code`. Deprecated entries stay listed so existing config validates but
 * are flagged by the catalog. */
export const PROVIDER_MODELS: Readonly<Record<ReviewProvider, readonly string[]>> = {
  codex: ["gpt-5.6-terra", "gpt-5.5"],
  // Keep historic unqualified aliases parseable while steering new configuration
  // to catalog-qualified ClawRouter ids.
  pi: [
    "claude-opus-4-8",
    "claude-sonnet-4-6",
    "clawrouter/claude-opus-5",
    "clawrouter/gpt-5.6-terra-200k",
  ],
  "claude-bridge": ["claude-opus-4-8", "claude-sonnet-4-6"],
  "claude-code": ["claude-opus-4-8", "claude-sonnet-4-6"],
};

/** Models that are retired: still valid to parse, surfaced as deprecated. */
export const DEPRECATED_MODELS: ReadonlySet<string> = new Set(["gpt-5.5"]);

/** Reasoning effort is a codex-only knob; other providers ignore it. */
export const EFFORT_PROVIDERS: ReadonlySet<ReviewProvider> = new Set(["codex"]);

/** Providers each action is allowed to select. Worker and issue-implementation
 * lanes are codex-only (subscription-auth codex today). */
export const ACTION_PROVIDERS: Readonly<Record<ModelAction, readonly ReviewProvider[]>> = {
  "sweep-review": ["codex", "pi", "claude-bridge", "claude-code"],
  // claude-bridge intentionally excluded for commit-review: its runtime path is
  // Decision/tool-use-coupled and not wired for the free-form commit-report contract.
  "commit-review": ["codex", "pi", "claude-code"],
  "repair-worker": ["codex"],
  "issue-implementation": ["codex"],
};

/** Fully-resolved config for a single action. */
export interface ResolvedActionConfig {
  readonly provider: ReviewProvider;
  readonly model: string;
  readonly effort: ReasoningEffort;
}

/** A partial override loaded from the registry variable. */
export interface ActionConfigPatch {
  readonly provider?: ReviewProvider;
  readonly model?: string;
  readonly effort?: ReasoningEffort;
}

export type ModelRegistry = Partial<Record<ModelAction, ActionConfigPatch>>;

/** Production defaults — the live behaviour when the registry variable is unset.
 * `sweep-review` reflects the `CLAWSWEEPER_REVIEW_PROVIDER=pi` lock (opus). */
export const DEFAULT_ACTION_CONFIG: Readonly<Record<ModelAction, ResolvedActionConfig>> = {
  "sweep-review": { provider: "pi", model: "clawrouter/claude-opus-5", effort: "none" },
  "commit-review": { provider: "codex", model: "gpt-5.6-terra", effort: "high" },
  "repair-worker": { provider: "codex", model: "gpt-5.6-terra", effort: "high" },
  "issue-implementation": { provider: "codex", model: "gpt-5.6-terra", effort: "high" },
};

export function isModelAction(value: unknown): value is ModelAction {
  return typeof value === "string" && MODEL_ACTION_SET.has(value as ModelAction);
}

function isReviewProvider(value: unknown): value is ReviewProvider {
  return typeof value === "string" && value in PROVIDER_MODELS;
}

function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === "string" && REASONING_EFFORT_SET.has(value as ReasoningEffort);
}

/** Validate a single action patch against the catalog. Throws on any unknown
 * action, provider, model, or effort so bad config fails closed at write time. */
export function validateActionPatch(action: ModelAction, raw: unknown): ActionConfigPatch {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`registry entry for "${action}" must be an object`);
  }
  const entry = raw as Record<string, unknown>;
  const patch: { provider?: ReviewProvider; model?: string; effort?: ReasoningEffort } = {};

  if (entry.provider !== undefined) {
    if (!isReviewProvider(entry.provider)) {
      throw new Error(
        `"${action}".provider is not a known provider: ${JSON.stringify(entry.provider)}`,
      );
    }
    if (!ACTION_PROVIDERS[action].includes(entry.provider)) {
      throw new Error(
        `"${action}" does not support provider "${entry.provider}" (allowed: ${ACTION_PROVIDERS[action].join(", ")})`,
      );
    }
    patch.provider = entry.provider;
  }

  if (entry.model !== undefined) {
    if (typeof entry.model !== "string" || entry.model.trim() === "") {
      throw new Error(`"${action}".model must be a non-empty string`);
    }
    const provider = patch.provider ?? DEFAULT_ACTION_CONFIG[action].provider;
    if (!PROVIDER_MODELS[provider].includes(entry.model)) {
      throw new Error(
        `"${action}" model "${entry.model}" is not allowed for provider "${provider}" (allowed: ${PROVIDER_MODELS[provider].join(", ")})`,
      );
    }
    patch.model = entry.model;
  }

  // Coherence guard: a provider-only entry (no explicit model) resolves the model
  // to the action's built-in default; reject if that default is not valid for the
  // chosen provider (e.g. `{provider:"pi"}` would otherwise resolve to a codex model).
  if (patch.provider !== undefined && patch.model === undefined) {
    const defaultModel = DEFAULT_ACTION_CONFIG[action].model;
    if (!PROVIDER_MODELS[patch.provider].includes(defaultModel)) {
      throw new Error(
        `"${action}" provider "${patch.provider}" requires an explicit model (default "${defaultModel}" is not valid for it; allowed: ${PROVIDER_MODELS[patch.provider].join(", ")})`,
      );
    }
  }

  if (entry.effort !== undefined) {
    if (!isReasoningEffort(entry.effort)) {
      throw new Error(
        `"${action}".effort must be one of: ${REASONING_EFFORTS.join(", ")} (got ${JSON.stringify(entry.effort)})`,
      );
    }
    patch.effort = entry.effort;
  }

  return patch;
}

/** Parse and validate the raw `CLAWSWEEPER_MODELS` JSON string. An empty/unset
 * value yields an empty registry (all defaults). */
export function parseModelRegistry(json: string | undefined | null): ModelRegistry {
  if (json === undefined || json === null || json.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new Error(`CLAWSWEEPER_MODELS is not valid JSON: ${(error as Error).message}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("CLAWSWEEPER_MODELS must be a JSON object keyed by action");
  }
  const registry: ModelRegistry = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!isModelAction(key)) {
      throw new Error(
        `CLAWSWEEPER_MODELS has unknown action "${key}" (allowed: ${MODEL_ACTIONS.join(", ")})`,
      );
    }
    registry[key] = validateActionPatch(key, value);
  }
  return registry;
}

/** Resolve one action's effective config: registry override merged over the
 * built-in default, field by field. */
export function resolveActionConfig(
  action: ModelAction,
  registry: ModelRegistry,
): ResolvedActionConfig {
  const base = DEFAULT_ACTION_CONFIG[action];
  const patch = registry[action];
  if (!patch) return base;
  return {
    provider: patch.provider ?? base.provider,
    model: patch.model ?? base.model,
    effort: patch.effort ?? base.effort,
  };
}

/** Resolve every action from the given registry. */
export function resolveAllActions(
  registry: ModelRegistry,
): Record<ModelAction, ResolvedActionConfig> {
  const out = {} as Record<ModelAction, ResolvedActionConfig>;
  for (const action of MODEL_ACTIONS) out[action] = resolveActionConfig(action, registry);
  return out;
}

/** Merge a patch into the current registry JSON and return the canonical JSON to
 * persist plus the resolved config. Used by `clawsweeper models set`. */
export function applyRegistrySet(
  currentJson: string | undefined | null,
  action: ModelAction,
  patch: ActionConfigPatch,
): { json: string; resolved: ResolvedActionConfig } {
  const registry = parseModelRegistry(currentJson);
  const merged: ActionConfigPatch = { ...registry[action], ...stripUndefined(patch) };
  // Re-validate the merged entry as a whole (e.g. new model vs existing provider).
  registry[action] = validateActionPatch(action, merged);
  return {
    json: serializeRegistry(registry),
    resolved: resolveActionConfig(action, registry),
  };
}

function stripUndefined(patch: ActionConfigPatch): ActionConfigPatch {
  const out: { provider?: ReviewProvider; model?: string; effort?: ReasoningEffort } = {};
  if (patch.provider !== undefined) out.provider = patch.provider;
  if (patch.model !== undefined) out.model = patch.model;
  if (patch.effort !== undefined) out.effort = patch.effort;
  return out;
}

/** Deterministic JSON: actions in canonical order, fields provider→model→effort. */
export function serializeRegistry(registry: ModelRegistry): string {
  const ordered: Record<string, ActionConfigPatch> = {};
  for (const action of MODEL_ACTIONS) {
    const patch = registry[action];
    if (!patch) continue;
    const entry: Record<string, string> = {};
    if (patch.provider !== undefined) entry.provider = patch.provider;
    if (patch.model !== undefined) entry.model = patch.model;
    if (patch.effort !== undefined) entry.effort = patch.effort;
    if (Object.keys(entry).length > 0) ordered[action] = entry;
  }
  return JSON.stringify(ordered, null, 2);
}

/** Resolve a managed model for an action: explicit value wins (e.g. a manual
 * `--model` input), then the registry override, then a legacy env fallback, then
 * the built-in per-action default. Preserves current behaviour when the registry
 * variable is unset. */
export function managedModel(
  action: ModelAction,
  explicit: string | undefined,
  legacyEnv: string | undefined,
): string {
  if (explicit && explicit.trim()) return explicit.trim();
  const override = parseModelRegistry(process.env.CLAWSWEEPER_MODELS)[action]?.model;
  if (override) return override;
  if (legacyEnv && legacyEnv.trim()) return legacyEnv.trim();
  return DEFAULT_ACTION_CONFIG[action].model;
}

export interface CatalogRow {
  readonly provider: ReviewProvider;
  readonly model: string;
  readonly deprecated: boolean;
  readonly supportsEffort: boolean;
}

/** Flatten the catalog to rows for `clawsweeper models catalog`. */
export function modelCatalogRows(): CatalogRow[] {
  const rows: CatalogRow[] = [];
  for (const provider of Object.keys(PROVIDER_MODELS) as ReviewProvider[]) {
    for (const model of PROVIDER_MODELS[provider]) {
      rows.push({
        provider,
        model,
        deprecated: DEPRECATED_MODELS.has(model),
        supportsEffort: EFFORT_PROVIDERS.has(provider),
      });
    }
  }
  return rows;
}
