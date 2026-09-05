#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  buildClaudeReviewPromptForTest,
  reviewDecisionSchemaText,
  runPi,
} from "../../dist/clawsweeper.js";
import {
  ACTION_PROVIDERS,
  DEFAULT_ACTION_CONFIG,
  PROVIDER_MODELS,
  REASONING_EFFORTS,
} from "../../dist/model-registry.js";
import {
  REPOSITORY_PROFILES,
  normalizeRepo,
  repositoryProfileFor,
} from "../../dist/repository-profiles.js";

export const EVAL_DIR = resolve(dirname(fileURLToPath(import.meta.url)));
export const ROOT = resolve(EVAL_DIR, "../..");
export const COHORT_PATH = join(EVAL_DIR, "cohort.json");
export const DEFAULT_MODEL_CATALOG = "/tmp/forge-rescope-models.txt";
export const DEFAULT_PRIVATE_ROOT = join(tmpdir(), "clawsweeper-routing-rescope");
const SCHEMA_SEPARATOR =
  "\n\n---\nRespond with ONLY a single JSON object matching this JSON Schema. No prose, no markdown fences, no commentary.\n\nSchema:\n";
const REQUIRED_CASE_COUNT = 4;
const CANDIDATE_NAMES = ["champion", "challenger"];
const NATIVE_PROFILE_REPOS = new Set(
  REPOSITORY_PROFILES.map((profile) => normalizeRepo(profile.targetRepo)),
);
const FIXTURE_PROFILES = new Map();
const ALLOWED_EXPECTED = new Map([
  ["decision", new Set(["close", "keep_open"])],
  [
    "closeReason",
    new Set([
      "implemented_on_main",
      "mostly_implemented_on_main",
      "cannot_reproduce",
      "clawhub",
      "duplicate_or_superseded",
      "not_actionable_in_repo",
      "incoherent",
      "stale_insufficient_info",
      "none",
    ]),
  ],
  ["confidence", new Set(["high", "medium", "low"])],
  [
    "itemCategory",
    new Set([
      "bug",
      "regression",
      "feature",
      "skill",
      "docs",
      "cleanup",
      "support",
      "admin",
      "security",
      "unclear",
    ]),
  ],
  [
    "reproductionStatus",
    new Set(["reproduced", "source_reproducible", "not_reproduced", "unclear", "not_applicable"]),
  ],
  ["reproductionConfidence", new Set(["high", "medium", "low"])],
  ["workCandidate", new Set(["none", "manual_review", "queue_fix_pr"])],
  ["fixedSha", null],
]);

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function readJson(path) {
  const raw = readFileSync(path, "utf8");
  return { raw, value: JSON.parse(raw) };
}

export function writeExclusive(path, value, mode = 0o600) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const fd = openSync(path, "wx", mode);
  try {
    writeFileSync(fd, value, "utf8");
  } finally {
    closeSync(fd);
  }
}

function gitHead() {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" });
  if (result.status !== 0)
    throw new Error(`cannot resolve source HEAD: ${(result.stderr ?? "").trim()}`);
  return result.stdout.trim();
}

function parseCatalog(raw) {
  const rows = [];
  for (const line of raw.split(/\r?\n/u)) {
    const match = /^\s*(\S+)\s+(\S+)\s+/.exec(line);
    if (!match || match[1] === "provider") continue;
    rows.push({ provider: match[1], model: match[2] });
  }
  return rows;
}

function catalogContains(rows, requestedModel) {
  const slash = requestedModel.indexOf("/");
  if (slash <= 0) return false;
  const provider = requestedModel.slice(0, slash);
  const model = requestedModel.slice(slash + 1);
  return rows.some((row) => row.provider === provider && row.model === model);
}

function modelId(requestedModel) {
  const slash = requestedModel.indexOf("/");
  return slash < 0 ? requestedModel : requestedModel.slice(slash + 1);
}

function thinkingArg(effort) {
  return effort === "none" ? "off" : effort;
}

function expectedSpawnArgs(candidate) {
  const config = candidate;
  return [
    "-p",
    "--mode",
    "json",
    "--no-session",
    "--model",
    config.model,
    "--thinking",
    thinkingArg(config.effort),
    "-t",
    "read,glob,grep,agent,Agent",
  ];
}

export function normalizeToolSurface(args) {
  const toolFlag = args.indexOf("-t");
  return toolFlag < 0 ? [] : args.slice(toolFlag, toolFlag + 2);
}

function validateCaseLabels(caseSpec) {
  if (!caseSpec.expected || typeof caseSpec.expected !== "object") {
    throw new Error(`${caseSpec.id}: expected semantic labels are required`);
  }
  for (const [key, value] of Object.entries(caseSpec.expected)) {
    const allowed = ALLOWED_EXPECTED.get(key);
    if (!allowed && key !== "fixedSha")
      throw new Error(`${caseSpec.id}: unsupported expected label ${key}`);
    if (key === "fixedSha" && (typeof value !== "string" || value.length === 0))
      throw new Error(`${caseSpec.id}: invalid expected fixedSha`);
    if (allowed && !allowed.has(value))
      throw new Error(`${caseSpec.id}: invalid expected ${key}=${value}`);
  }
  const safety = caseSpec.safety;
  if (!safety || typeof safety !== "object")
    throw new Error(`${caseSpec.id}: safety contract is required`);
  for (const key of Object.keys(safety)) {
    if (
      ![
        "forbidClose",
        "forbidDuplicate",
        "forbidReproducedHigh",
        "forbidEvaluatedPrMerged",
        "requireEvidenceText",
        "requireCloseReason",
        "requireFixedSha",
        "allowReproducedHigh",
        "forbidReproductionStatus",
      ].includes(key)
    ) {
      throw new Error(`${caseSpec.id}: unsupported safety rule ${key}`);
    }
  }
  if (safety.allowReproducedHigh && safety.forbidReproducedHigh) {
    throw new Error(`${caseSpec.id}: contradictory reproduced/high safety rules`);
  }
  if (
    caseSpec.expected.decision === "keep_open" &&
    caseSpec.expected.closeReason &&
    caseSpec.expected.closeReason !== "none"
  ) {
    throw new Error(`${caseSpec.id}: keep_open cases must use closeReason=none`);
  }
  if (caseSpec.expected.decision === "close" && caseSpec.expected.closeReason === "none") {
    throw new Error(`${caseSpec.id}: close cases need a close reason`);
  }
  if (
    caseSpec.expected.reproductionStatus === "reproduced" &&
    caseSpec.expected.reproductionConfidence !== "high"
  ) {
    throw new Error(`${caseSpec.id}: reproduced requires high reproduction confidence`);
  }
}

function validateFixture(caseSpec, fixture) {
  if (!fixture.item || !fixture.context || !fixture.git)
    throw new Error(`${caseSpec.id}: fixture needs item, context, and git`);
  if (!fixture.item.repo || !/^[-A-Za-z0-9_.]+\/[-A-Za-z0-9_.]+$/u.test(fixture.item.repo)) {
    throw new Error(`${caseSpec.id}: invalid fixture repository`);
  }
  if (!fixture.provenance?.sourceArtifact || !fixture.provenance?.sourceArtifactSha256) {
    throw new Error(`${caseSpec.id}: fixture provenance is required`);
  }
  if (caseSpec.id === "valkyriweb-skills-224-help-bug") {
    const correction = fixture.provenance.repositoryCorrection;
    if (
      fixture.item.repo !== "valkyriweb/skills" ||
      correction?.from !== "lue-labs/skills" ||
      correction?.to !== "valkyriweb/skills"
    ) {
      throw new Error(`${caseSpec.id}: corrected repository/provenance contract is missing`);
    }
  }
}

function registerFixtureProfile(caseSpec, targetRepo) {
  const profile = caseSpec.profile;
  if (!profile || profile.kind !== "fixture_only") {
    throw new Error(
      `${caseSpec.id}: invocation-only fixture profile is required for ${targetRepo}`,
    );
  }
  if (normalizeRepo(profile.targetRepo) !== normalizeRepo(targetRepo)) {
    throw new Error(`${caseSpec.id}: fixture profile target does not match ${targetRepo}`);
  }
  if (profile.slug !== "valkyriweb-skills" || profile.targetRepo !== "valkyriweb/skills") {
    throw new Error(`${caseSpec.id}: invalid Skills fixture profile identity`);
  }
  if (
    typeof profile.promptNote !== "string" ||
    !/evidence-based.*repository-local.*Skills/iu.test(profile.promptNote)
  ) {
    throw new Error(`${caseSpec.id}: Skills fixture profile prompt note is not explicit`);
  }
  if (profile.automationPolicy !== "review_only") {
    throw new Error(`${caseSpec.id}: fixture profile must be review_only`);
  }
  if (
    !Array.isArray(profile.applyCloseRules?.issue) ||
    !Array.isArray(profile.applyCloseRules?.pull_request) ||
    profile.applyCloseRules.issue.length !== 0 ||
    profile.applyCloseRules.pull_request.length !== 0
  ) {
    throw new Error(`${caseSpec.id}: fixture profile must have empty issue/PR close allowances`);
  }
  const normalized = normalizeRepo(targetRepo);
  if (NATIVE_PROFILE_REPOS.has(normalized)) {
    throw new Error(`${caseSpec.id}: fixture profile cannot override a native configured profile`);
  }
  const existing = REPOSITORY_PROFILES.find(
    (candidate) => normalizeRepo(candidate.targetRepo) === normalized,
  );
  if (existing) {
    if (
      FIXTURE_PROFILES.get(normalized) !== existing ||
      canonical(existing) !== canonical(profile)
    ) {
      throw new Error(`${caseSpec.id}: fixture profile conflicts with an existing profile`);
    }
    return existing;
  }
  REPOSITORY_PROFILES.push(profile);
  FIXTURE_PROFILES.set(normalized, profile);
  return profile;
}

function resolvePromptProfile(caseSpec, targetRepo) {
  const normalized = normalizeRepo(targetRepo);
  if (NATIVE_PROFILE_REPOS.has(normalized)) {
    if (caseSpec.profile)
      throw new Error(
        `${caseSpec.id}: fixture profile is not allowed for a native configured repo`,
      );
    return {
      mode: "target",
      targetRepo,
      profileRepo: targetRepo,
      profile: repositoryProfileFor(targetRepo),
    };
  }
  const profile = registerFixtureProfile(caseSpec, targetRepo);
  return {
    mode: "invocation_only_fixture",
    targetRepo,
    profileRepo: targetRepo,
    profile,
    reason: caseSpec.profile.enrollmentLimitation,
  };
}

function wrapPrompt(basePrompt) {
  return `${basePrompt}${SCHEMA_SEPARATOR}${reviewDecisionSchemaText()}`;
}

function buildPlan(caseSpec, fixturePath) {
  const { raw: fixtureRaw, value: fixture } = readJson(fixturePath);
  validateFixture(caseSpec, fixture);
  validateCaseLabels(caseSpec);
  const promptProfile = resolvePromptProfile(caseSpec, fixture.item.repo);
  const basePrompt = buildClaudeReviewPromptForTest(fixture.item, fixture.context, fixture.git);
  const renderedPrompt = wrapPrompt(basePrompt);
  if (!renderedPrompt.includes(`- Target repo: ${fixture.item.repo}`)) {
    throw new Error(`${caseSpec.id}: rendered prompt lost the target repository`);
  }
  return {
    id: caseSpec.id,
    caseSpec,
    fixture,
    fixtureSha256: sha256(fixtureRaw),
    basePrompt,
    renderedPromptSha256: sha256(renderedPrompt),
    renderedPromptChars: renderedPrompt.length,
    promptProfile: {
      mode: promptProfile.mode,
      targetRepo: promptProfile.targetRepo,
      profileRepo: promptProfile.profileRepo,
      reason: promptProfile.reason ?? null,
    },
  };
}

export function loadPreflightInputs({ catalogPath = DEFAULT_MODEL_CATALOG } = {}) {
  const cohortFile = readJson(COHORT_PATH);
  const cohort = cohortFile.value;
  const errors = [];
  if (cohort.schemaVersion !== 3) errors.push(`unsupported cohort schema ${cohort.schemaVersion}`);
  if (cohort.status !== "awaiting_parent_label_acceptance" && cohort.status !== "accepted")
    errors.push(`unsupported cohort status ${cohort.status}`);
  if (cohort.labelContract?.status !== "accepted")
    errors.push("label contract pending independent parent acceptance");
  if (!Array.isArray(cohort.cases) || cohort.cases.length !== REQUIRED_CASE_COUNT)
    errors.push(`cohort must contain exactly ${REQUIRED_CASE_COUNT} cases`);
  if (!cohort.models?.champion || !cohort.models?.challenger)
    errors.push("champion and challenger model configs are required");
  if (!existsSync(catalogPath)) errors.push(`model catalog not found: ${catalogPath}`);

  let catalogRaw = "";
  let catalogRows = [];
  if (existsSync(catalogPath)) {
    catalogRaw = readFileSync(catalogPath, "utf8");
    catalogRows = parseCatalog(catalogRaw);
  }
  const expectedChampion = DEFAULT_ACTION_CONFIG["sweep-review"];
  const champion = cohort.models?.champion;
  if (
    champion &&
    (champion.provider !== expectedChampion.provider ||
      champion.model !== expectedChampion.model ||
      champion.effort !== expectedChampion.effort)
  ) {
    errors.push("champion does not match DEFAULT_ACTION_CONFIG sweep-review");
  }
  for (const [name, config] of Object.entries(cohort.models ?? {})) {
    if (!CANDIDATE_NAMES.includes(name)) errors.push(`unknown candidate ${name}`);
    if (
      !config ||
      config.provider !== "pi" ||
      !ACTION_PROVIDERS["sweep-review"].includes(config.provider)
    )
      errors.push(`${name}: only supported pi sweep-review routing is allowed`);
    if (config && !PROVIDER_MODELS.pi.includes(config.model))
      errors.push(`${name}: model is not in the pi registry`);
    if (config && !REASONING_EFFORTS.includes(config.effort))
      errors.push(`${name}: unsupported effort ${config.effort}`);
    if (config && !catalogContains(catalogRows, config.model))
      errors.push(`${name}: model is absent from the live catalog`);
  }
  if (cohort.execution?.timeoutMs !== 300000) errors.push("per-case timeout must remain 300000ms");
  if (cohort.execution?.sandboxMode !== "read-only" || cohort.execution?.serviceTier !== "default")
    errors.push("execution sandbox/service tier drifted");
  let schemaSha256 = null;
  try {
    const schemaText = reviewDecisionSchemaText();
    const schema = JSON.parse(schemaText);
    if (!Array.isArray(schema.required) || !schema.required.includes("decision"))
      errors.push("decision schema is incomplete");
    schemaSha256 = sha256(schemaText);
  } catch (error) {
    errors.push(`decision schema invalid: ${error.message}`);
  }

  if (!existsSync(join(ROOT, "dist", "clawsweeper.js")))
    errors.push("dist/clawsweeper.js is required for the actual runPi adapter");
  const plans = [];
  for (const caseSpec of cohort.cases ?? []) {
    try {
      if (!caseSpec.id || !caseSpec.fixture) throw new Error("case id and fixture are required");
      const fixturePath = resolve(EVAL_DIR, caseSpec.fixture);
      if (!fixturePath.startsWith(`${EVAL_DIR}/`))
        throw new Error("fixture must remain inside the eval directory");
      plans.push(buildPlan(caseSpec, fixturePath));
    } catch (error) {
      errors.push(error.message);
    }
  }
  const ids = plans.map((plan) => plan.id);
  if (new Set(ids).size !== ids.length || ids.length !== REQUIRED_CASE_COUNT)
    errors.push("all four case plans must be present and unique");
  return {
    cohortFile,
    cohort,
    catalogPath: resolve(catalogPath),
    catalogRaw,
    catalogSha256: catalogRaw ? sha256(catalogRaw) : null,
    catalogRows,
    schemaSha256,
    sourceHead: gitHead(),
    runnerSha256: sha256(readFileSync(fileURLToPath(import.meta.url))),
    adapterSha256: existsSync(join(ROOT, "dist", "clawsweeper.js"))
      ? sha256(readFileSync(join(ROOT, "dist", "clawsweeper.js")))
      : null,
    cohortSha256: sha256(cohortFile.raw),
    plans,
    errors,
    ready: errors.length === 0,
  };
}

function publicPreflight(preflight, mode) {
  return {
    mode,
    ready: preflight.ready,
    sourceHead: preflight.sourceHead,
    cohortSha256: preflight.cohortSha256,
    catalogSha256: preflight.catalogSha256,
    runnerSha256: preflight.runnerSha256,
    adapterSha256: preflight.adapterSha256,
    schemaSha256: preflight.schemaSha256,
    errors: preflight.errors,
    candidates: Object.fromEntries(
      CANDIDATE_NAMES.map((name) => [name, preflight.cohort.models[name]]),
    ),
    cases: preflight.plans.map((plan) => ({
      id: plan.id,
      targetRepo: plan.fixture.item.repo,
      fixtureSha256: plan.fixtureSha256,
      renderedPromptSha256: plan.renderedPromptSha256,
      promptChars: plan.renderedPromptChars,
      promptProfile: plan.promptProfile,
    })),
    plannedInvocations: preflight.plans.length * CANDIDATE_NAMES.length,
  };
}

function manifestPayload(preflight) {
  const payload = {
    schemaVersion: 1,
    cohort: {
      path: "evals/sweep-routing-rescope/cohort.json",
      sha256: preflight.cohortSha256,
      labels: preflight.cohort.cases.map((item) => ({
        id: item.id,
        expected: item.expected,
        safety: item.safety,
      })),
      labelsSha256: sha256(
        canonical(
          preflight.cohort.cases.map((item) => ({
            id: item.id,
            expected: item.expected,
            safety: item.safety,
          })),
        ),
      ),
    },
    source: { head: preflight.sourceHead },
    runner: { path: "evals/sweep-routing-rescope/run.mjs", sha256: preflight.runnerSha256 },
    adapter: { path: "dist/clawsweeper.js", sha256: preflight.adapterSha256 },
    schemaSha256: preflight.schemaSha256,
    modelCatalog: { path: preflight.catalogPath, sha256: preflight.catalogSha256 },
    models: preflight.cohort.models,
    execution: preflight.cohort.execution,
    cases: preflight.plans.map((plan) => ({
      id: plan.id,
      fixture: plan.caseSpec.fixture,
      fixtureSha256: plan.fixtureSha256,
      targetRepo: plan.fixture.item.repo,
      promptProfile: plan.promptProfile,
      renderedPromptSha256: plan.renderedPromptSha256,
      renderedPromptChars: plan.renderedPromptChars,
    })),
  };
  return { ...payload, manifestSha256: sha256(canonical(payload)) };
}

export function assertManifestHashes(manifest, plans) {
  for (const plan of plans) {
    const frozen = manifest.cases.find((item) => item.id === plan.id);
    if (!frozen) throw new Error(`manifest is missing case ${plan.id}`);
    if (frozen.fixtureSha256 !== plan.fixtureSha256)
      throw new Error(`${plan.id}: fixture hash changed after freeze`);
    if (frozen.renderedPromptSha256 !== plan.renderedPromptSha256)
      throw new Error(`${plan.id}: rendered prompt hash changed after freeze`);
  }
}

function verifyManifestSelfHash(manifest) {
  const { manifestSha256, ...payload } = manifest;
  if (manifestSha256 !== sha256(canonical(payload)))
    throw new Error("manifest self-hash is invalid");
}

function validateManifest(manifestPath, catalogPath) {
  const manifest = readJson(manifestPath).value;
  verifyManifestSelfHash(manifest);
  const preflight = loadPreflightInputs({ catalogPath });
  if (!preflight.ready)
    throw new Error(`current preflight is not ready: ${preflight.errors.join("; ")}`);
  const current = manifestPayload(preflight);
  if (manifest.cohort.sha256 !== current.cohort.sha256)
    throw new Error("cohort bytes changed after freeze");
  if (manifest.cohort.labelsSha256 !== current.cohort.labelsSha256)
    throw new Error("labels changed after freeze");
  if (manifest.source.head !== current.source.head)
    throw new Error("source HEAD changed after freeze");
  if (manifest.runner.sha256 !== current.runner.sha256)
    throw new Error("runner changed after freeze");
  if (manifest.adapter.sha256 !== current.adapter.sha256)
    throw new Error("dist runPi adapter changed after freeze");
  if (manifest.schemaSha256 !== current.schemaSha256)
    throw new Error("decision schema changed after freeze");
  if (manifest.modelCatalog.sha256 !== current.modelCatalog.sha256)
    throw new Error("model catalog changed after freeze");
  if (canonical(manifest.models) !== canonical(current.models))
    throw new Error("model/effort config changed after freeze");
  assertManifestHashes(manifest, preflight.plans);
  return { manifest, preflight };
}

function compactDecision(decision) {
  if (!decision) return null;
  return Object.fromEntries(
    [
      "decision",
      "closeReason",
      "confidence",
      "itemCategory",
      "reproductionStatus",
      "reproductionConfidence",
      "workCandidate",
      "fixedSha",
    ]
      .filter((key) => decision[key] !== undefined)
      .map((key) => [key, decision[key]]),
  );
}

function safeError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    kind: error?.code === "ETIMEDOUT" ? "timeout" : "runPi_failure",
    sha256: sha256(message),
  };
}

function usageNumber(value, label, failures, required = false) {
  if (value === undefined && !required) return 0;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    failures.push(`invalid ${label}`);
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

export function observedReceipt(raw) {
  const messages = [];
  const parseErrors = [];
  const failures = [];
  let lastEventType = null;
  let sawAgentEnd = false;
  let messageEndCount = 0;
  for (const [lineNumber, line] of raw.split(/\r?\n/u).entries()) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      parseErrors.push(`line ${lineNumber + 1}: non-JSON event`);
      continue;
    }
    if (!event || typeof event !== "object" || Array.isArray(event)) {
      failures.push(`line ${lineNumber + 1}: malformed event`);
      lastEventType = null;
      continue;
    }
    lastEventType = event.type ?? null;
    if (event.type === "agent_start") sawAgentEnd = false;
    if (event.type === "agent_end") sawAgentEnd = true;
    if (event.type !== "message_end") continue;
    messageEndCount += 1;
    if (!event.message || typeof event.message !== "object" || Array.isArray(event.message)) {
      failures.push(`message_end ${messageEndCount} is missing its message`);
      continue;
    }
    if (event.message.role === "user" || event.message.role === "toolResult") continue;
    if (event.message.role !== "assistant") {
      failures.push(`message_end ${messageEndCount} has an unknown role`);
      continue;
    }
    messages.push(event.message);
  }
  failures.push(...parseErrors);
  if (!sawAgentEnd || !["agent_end", "agent_settled"].includes(lastEventType))
    failures.push("missing terminal agent_end");
  let totalCost = 0;
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  const observed = [];
  for (const [index, message] of messages.entries()) {
    if (typeof message.provider !== "string" || typeof message.model !== "string")
      failures.push(`assistant message ${index + 1} lacks model/provider provenance`);
    const stopReason = message.stopReason ?? message.stop_reason;
    if (stopReason === "error" || stopReason === "aborted" || message.errorMessage)
      failures.push(`assistant message ${index + 1} ended with ${stopReason ?? "error"}`);
    const usage = message.usage;
    if (!usage || typeof usage !== "object")
      failures.push(`assistant message ${index + 1} lacks usage`);
    const cost = usage?.cost?.total;
    if (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0)
      failures.push(`assistant message ${index + 1} lacks finite nonnegative cost`);
    else if (Number.isFinite(totalCost + cost)) totalCost += cost;
    else failures.push("total cost is not finite");
    const input = usageNumber(usage?.input, `message ${index + 1} input`, failures, true);
    const output = usageNumber(usage?.output, `message ${index + 1} output`, failures, true);
    const cacheRead = usageNumber(usage?.cacheRead, `message ${index + 1} cacheRead`, failures);
    const cacheWrite = usageNumber(usage?.cacheWrite, `message ${index + 1} cacheWrite`, failures);
    const total =
      usage?.totalTokens === undefined
        ? input + output + cacheRead + cacheWrite
        : usageNumber(usage.totalTokens, `message ${index + 1} totalTokens`, failures);
    totals.input += input;
    totals.output += output;
    totals.cacheRead += cacheRead;
    totals.cacheWrite += cacheWrite;
    totals.total += total;
    observed.push({ provider: message.provider ?? null, model: message.model ?? null });
  }
  if (messages.length === 0) failures.push("no assistant message_end");
  if (totalCost <= 0 || !Number.isFinite(totalCost))
    failures.push("total cost is not finite and positive");
  return {
    complete: failures.length === 0,
    assistantMessageEnds: messages.length,
    parseErrors,
    observed,
    terminal: observed.at(-1) ?? null,
    tokens: totals,
    cost: Number.isFinite(totalCost) ? totalCost : null,
    costProvenance: "sum of every assistant message_end.message.usage.cost.total",
    failures,
  };
}

function decisionFailures(decision, caseSpec, fixture) {
  const failures = [];
  for (const [key, value] of Object.entries(caseSpec.expected))
    if (decision?.[key] !== value) failures.push(`expected ${key}=${value}`);
  const safety = caseSpec.safety;
  if (safety.forbidClose && decision?.decision === "close") failures.push("unsafe close");
  if (safety.forbidDuplicate && decision?.closeReason === "duplicate_or_superseded")
    failures.push("false duplicate");
  if (
    safety.forbidReproducedHigh &&
    decision?.reproductionStatus === "reproduced" &&
    decision?.reproductionConfidence === "high"
  )
    failures.push("unsupported reproduced/high claim");
  if (safety.forbidReproductionStatus?.includes(decision?.reproductionStatus))
    failures.push(`forbidden reproduction status ${decision.reproductionStatus}`);
  if (safety.requireEvidenceText && !JSON.stringify(decision).includes(safety.requireEvidenceText))
    failures.push(`missing evidence text ${safety.requireEvidenceText}`);
  if (safety.requireCloseReason && decision?.closeReason !== safety.requireCloseReason)
    failures.push(`required close reason ${safety.requireCloseReason}`);
  if (safety.requireFixedSha && decision?.fixedSha !== safety.requireFixedSha)
    failures.push(`required fixedSha ${safety.requireFixedSha}`);
  if (safety.forbidEvaluatedPrMerged) {
    const fixedPull = decision?.fixedPullRequest;
    if (fixedPull?.number === fixture.item.number && fixedPull.mergedAt)
      failures.push("claims evaluated PR merged");
    const text = JSON.stringify(decision);
    if (
      /(?:this|the evaluated|reviewed)\s+PR\s+[^.]{0,80}\bmerged\b/i.test(text) &&
      !/\bnot\s+merged\b/i.test(text)
    )
      failures.push("claims evaluated PR merged");
  }
  return failures;
}

function liveSpawn(command, args, options) {
  const result = spawnSync(command, [...args], {
    cwd: options.cwd,
    env: options.env,
    input: options.input,
    encoding: "utf8",
    maxBuffer: options.maxBuffer,
    timeout: options.timeout,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    ...(result.error ? { error: result.error } : {}),
  };
}

export function invokePiCase(plan, candidate, { privateRoot, spawnFn = liveSpawn } = {}) {
  const config = candidate;
  const workDir = join(privateRoot, "work", plan.id);
  const openclawDir = join(privateRoot, "isolated-cwd", plan.id);
  mkdirSync(workDir, { recursive: true, mode: 0o700 });
  mkdirSync(openclawDir, { recursive: true, mode: 0o700 });
  mkdirSync(join(privateRoot, "errors"), { recursive: true, mode: 0o700 });
  const captured = [];
  const recordingSpawn = (command, args, options) => {
    const result = spawnFn(command, args, options);
    captured.push({ command, args: [...args] });
    return result;
  };
  let decision = null;
  let error = null;
  let status = "success";
  try {
    decision = runPi({
      ...plan.fixture,
      model: config.model,
      openclawDir,
      reasoningEffort: config.effort,
      sandboxMode: "read-only",
      serviceTier: "default",
      timeoutMs: 300000,
      workDir,
      prompt: plan.basePrompt,
      spawnFn: recordingSpawn,
    });
  } catch (cause) {
    status = "failed";
    error = safeError(cause);
    writeFileSync(
      join(privateRoot, "errors", `${plan.id}.json`),
      JSON.stringify({ message: cause instanceof Error ? cause.message : String(cause) }),
      { encoding: "utf8", mode: 0o600 },
    );
  }
  const promptPath = join(workDir, `${plan.fixture.item.number}.pi-prompt.md`);
  const responsePath = join(workDir, `${plan.fixture.item.number}.pi-response.txt`);
  const promptRaw = existsSync(promptPath) ? readFileSync(promptPath, "utf8") : "";
  const responseRaw = existsSync(responsePath) ? readFileSync(responsePath, "utf8") : "";
  const receipt = observedReceipt(responseRaw);
  const failures =
    status === "success" ? decisionFailures(decision, plan.caseSpec, plan.fixture) : ["run failed"];
  if (!receipt.complete) failures.push("incomplete observed receipt", ...receipt.failures);
  if (promptRaw && sha256(promptRaw) !== plan.renderedPromptSha256)
    failures.push("rendered prompt hash mismatch");
  if (!promptRaw) failures.push("missing rendered prompt");
  if (captured.length !== 1) failures.push(`expected one invocation, observed ${captured.length}`);
  const argv = captured[0]?.args ?? null;
  const expectedArgs = expectedSpawnArgs(config);
  if (
    captured[0] &&
    (captured[0].command !== "pi" ||
      captured[0].args.length !== expectedArgs.length ||
      captured[0].args.some((arg, index) => arg !== expectedArgs[index]))
  )
    failures.push("spawn argv contract mismatch");
  const expectedObserved = { provider: "clawrouter", model: modelId(config.model) };
  if (
    receipt.observed.some(
      (entry) =>
        entry.provider !== expectedObserved.provider || entry.model !== expectedObserved.model,
    )
  )
    failures.push("routing mismatch");
  return {
    id: plan.id,
    status,
    error,
    failures: [...new Set(failures)],
    passed: failures.length === 0,
    fixtureSha256: plan.fixtureSha256,
    promptSha256: promptRaw ? sha256(promptRaw) : null,
    rawResponseSha256: responseRaw ? sha256(responseRaw) : null,
    requested: config,
    spawn: captured[0]
      ? {
          command: captured[0].command,
          argv: captured[0].args,
          requestedEffort: config.effort,
          argvEffort: captured[0].args[captured[0].args.indexOf("--thinking") + 1] ?? null,
        }
      : null,
    observed: {
      labels: receipt.observed,
      effort: "unknown",
      effortProvenance:
        "runPi argv proves the request only; Pi message_end does not prove backend effort",
    },
    receipt: {
      complete: receipt.complete,
      assistantMessageEnds: receipt.assistantMessageEnds,
      tokens: receipt.tokens,
      cost: receipt.cost,
      costProvenance: receipt.costProvenance,
      terminal: receipt.terminal,
      parseErrors: receipt.parseErrors,
      receiptFailures: receipt.failures,
    },
    decision: compactDecision(decision),
    toolFingerprint: argv ? normalizeToolSurface(argv) : null,
  };
}

export function summarizeCandidate(name, caseIds, results) {
  const byId = new Map(results.map((result) => [result.id, result]));
  const missing = caseIds.filter((id) => !byId.has(id));
  const duplicate = results.length - byId.size;
  const ordered = caseIds.map((id) => byId.get(id)).filter(Boolean);
  const costs = ordered
    .map((result) => result.receipt.cost)
    .filter((cost) => typeof cost === "number" && Number.isFinite(cost) && cost > 0);
  const completeCosts =
    missing.length === 0 &&
    duplicate === 0 &&
    ordered.every((result) => result.receipt.complete && result.receipt.cost > 0);
  const totalCost = completeCosts ? costs.reduce((sum, cost) => sum + cost, 0) : null;
  return {
    name,
    denominator: caseIds.length,
    observedCases: results.length,
    failedCases: ordered.filter((result) => !result.passed).length + missing.length,
    missingCases: missing,
    duplicateResults: duplicate,
    allCasesPresent: missing.length === 0 && duplicate === 0,
    totalCost,
    costComplete:
      completeCosts && typeof totalCost === "number" && Number.isFinite(totalCost) && totalCost > 0,
    passed:
      missing.length === 0 &&
      duplicate === 0 &&
      ordered.length === caseIds.length &&
      ordered.every(
        (result) => result.passed && result.receipt?.complete === true && !result.error,
      ),
  };
}

function buildReport(manifest, preflight, resultsByCandidate) {
  const caseIds = preflight.plans.map((plan) => plan.id);
  const candidates = Object.fromEntries(
    CANDIDATE_NAMES.map((name) => [
      name,
      {
        ...summarizeCandidate(name, caseIds, resultsByCandidate[name]),
        results: resultsByCandidate[name],
      },
    ]),
  );
  const championCost = candidates.champion.totalCost;
  const challengerCost = candidates.challenger.totalCost;
  const costGate = {
    strictChallengerCheaper:
      typeof championCost === "number" &&
      typeof challengerCost === "number" &&
      challengerCost < championCost,
    championCost,
    challengerCost,
    rule: "challenger total cost must be strictly less than champion total cost; no percentage threshold",
  };
  return {
    schemaVersion: 1,
    manifestSha256: manifest.manifestSha256,
    status: "complete",
    passed:
      candidates.champion.passed &&
      candidates.challenger.passed &&
      costGate.strictChallengerCheaper,
    denominator: {
      casesPerCandidate: caseIds.length,
      totalExpectedInvocations: caseIds.length * CANDIDATE_NAMES.length,
      candidates: CANDIDATE_NAMES,
    },
    candidates,
    costGate,
  };
}

function reserveOutput(outputRoot, manifest, caseIds) {
  if (existsSync(outputRoot))
    throw new Error(`output path already exists; refusing rerun/overwrite: ${outputRoot}`);
  mkdirSync(outputRoot, { recursive: false, mode: 0o700 });
  mkdirSync(join(outputRoot, "receipts", "champion"), { recursive: true, mode: 0o700 });
  mkdirSync(join(outputRoot, "receipts", "challenger"), { recursive: true, mode: 0o700 });
  const paths = [
    "manifest.json",
    "report.json",
    ...CANDIDATE_NAMES.flatMap((candidate) =>
      caseIds.map((id) => `receipts/${candidate}/${id}.json`),
    ),
  ];
  writeExclusive(
    join(outputRoot, "reservations.json"),
    JSON.stringify({ immutable: true, paths }, null, 2) + "\n",
  );
  writeExclusive(join(outputRoot, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
}

function execute(manifestPath, outputRoot, catalogPath, privateRoot) {
  const { manifest, preflight } = validateManifest(manifestPath, catalogPath);
  if (existsSync(outputRoot))
    throw new Error(`output path already exists; refusing rerun/overwrite: ${outputRoot}`);
  if (existsSync(privateRoot))
    throw new Error(`private raw path already exists; refusing rerun/overwrite: ${privateRoot}`);
  mkdirSync(privateRoot, { recursive: true, mode: 0o700 });
  mkdirSync(join(privateRoot, "errors"), { recursive: true, mode: 0o700 });
  reserveOutput(
    outputRoot,
    manifest,
    preflight.plans.map((plan) => plan.id),
  );
  const resultsByCandidate = { champion: [], challenger: [] };
  for (const candidateName of CANDIDATE_NAMES) {
    for (const plan of preflight.plans) {
      const result = invokePiCase(plan, manifest.models[candidateName], {
        privateRoot: join(privateRoot, candidateName),
      });
      resultsByCandidate[candidateName].push(result);
      writeExclusive(
        join(outputRoot, "receipts", candidateName, `${plan.id}.json`),
        JSON.stringify(result, null, 2) + "\n",
      );
    }
  }
  const report = buildReport(manifest, preflight, resultsByCandidate);
  writeExclusive(join(outputRoot, "report.json"), JSON.stringify(report, null, 2) + "\n");
  return report;
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function requiredFlag(flags, name) {
  if (!flags[name]) throw new Error(`missing --${name}`);
  return flags[name];
}

function parseFlags(argv) {
  const flags = {};
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) throw new Error(`unexpected argument ${arg}`);
    const name = arg.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`missing value for --${name}`);
    flags[name] = value;
    index += 1;
  }
  return flags;
}

export function main(argv = process.argv.slice(2)) {
  const command = argv[0] ?? "dry-run";
  const flags = parseFlags(argv);
  const catalogPath = flags.models ?? DEFAULT_MODEL_CATALOG;
  try {
    if (command === "dry-run" || command === "preflight") {
      const preflight = loadPreflightInputs({ catalogPath });
      print(publicPreflight(preflight, command));
      if (!preflight.ready) process.exitCode = 2;
      return;
    }
    if (command === "freeze") {
      const preflight = loadPreflightInputs({ catalogPath });
      if (!preflight.ready) throw new Error(`cannot freeze: ${preflight.errors.join("; ")}`);
      const manifestPath = resolve(requiredFlag(flags, "manifest"));
      if (existsSync(manifestPath))
        throw new Error(`manifest path already exists; refusing overwrite: ${manifestPath}`);
      const manifest = manifestPayload(preflight);
      writeExclusive(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
      print({
        frozen: true,
        manifestPath,
        manifestSha256: manifest.manifestSha256,
        cases: manifest.cases.length,
      });
      return;
    }
    if (command === "execute") {
      const manifestPath = resolve(requiredFlag(flags, "manifest"));
      const outputRoot = resolve(requiredFlag(flags, "output"));
      const privateRoot = resolve(
        flags["raw-root"] ?? join(DEFAULT_PRIVATE_ROOT, sha256(readFileSync(manifestPath))),
      );
      const report = execute(manifestPath, outputRoot, catalogPath, privateRoot);
      print({
        reportPath: join(outputRoot, "report.json"),
        passed: report.passed,
        manifestSha256: report.manifestSha256,
      });
      if (!report.passed) process.exitCode = 1;
      return;
    }
    if (command === "report") {
      const outputRoot = resolve(requiredFlag(flags, "output"));
      print(readJson(join(outputRoot, "report.json")).value);
      return;
    }
    throw new Error(
      `unknown command ${command}; expected dry-run, preflight, freeze, execute, or report`,
    );
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) main();
