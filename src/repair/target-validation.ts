import fs from "node:fs";
import path from "node:path";

import { runCommand as run } from "./command-runner.js";
import {
  ensureMergeBaseAvailable,
  gitChangedFiles,
  gitLsFiles,
  isAncestor,
} from "./git-repo-utils.js";
import { parsePullRequestUrl } from "./github-ref.js";
import type { JsonValue, LooseRecord } from "./json-types.js";
import { compactText } from "./text-utils.js";
import {
  isExpensivePnpmValidation,
  isTestFile,
  looksLikePathArgument,
  packageScriptRequirement,
  parseAllowedValidationCommand,
  pnpmCommandStart,
  stripEnvPrefix,
  uniqueStrings,
} from "./validation-command-utils.js";

const DEFAULT_BASE_BRANCH = "main";
const DEFAULT_TARGET_SETUP_TIMEOUT_MS = 2 * 60 * 1000;
const DEFAULT_TARGET_INSTALL_TIMEOUT_MS = 12 * 60 * 1000;
const DEFAULT_TARGET_VALIDATION_TIMEOUT_MS = 12 * 60 * 1000;

export type TargetValidationOptions = {
  additionalValidationCommands?: string[];
  allowExpensiveValidation: boolean;
  installTimeoutMs?: number;
  installTargetDeps: boolean;
  skipOpenClawChangedGate?: boolean;
  strictTargetValidation: boolean;
  targetRepo: string;
  setupTimeoutMs?: number;
  validationTimeoutMs?: number;
};

export type RepairDeltaValidationPlan = {
  commands: string[];
  options: TargetValidationOptions;
  scope: "changed-surface" | "repair-delta-docs";
  changed_files: string[];
  reason: string;
};

/**
 * Target package manager detected for toolchain bootstrap.
 *
 * `corepackSpec` is the full `pnpm@x.y.z` / `npm@x.y.z` string we pass to
 * `corepack prepare --activate`. Use `null` when the binary is part of the
 * default Node distribution (npm) and we don't want corepack to manage a
 * pinned version.
 */
export type TargetPackageManager = {
  kind: "pnpm" | "npm";
  corepackSpec: string | null;
};

/**
 * Decide which package manager `prepareTargetToolchain` should use for a
 * given target checkout. Detection order:
 *
 * 1. `package.json#packageManager` — explicit and authoritative.
 * 2. Lockfile presence: `pnpm-lock.yaml` → pnpm, `package-lock.json` → npm,
 *    `yarn.lock` → unsupported (we don't bootstrap yarn targets).
 * 3. Fallback: assume pnpm so existing OpenClaw/clawsweeper targets keep
 *    their current bootstrap behavior.
 *
 * Pure function — exported for unit tests.
 */
export function detectTargetPackageManager(cwd: string): TargetPackageManager {
  const declared = readDeclaredPackageManager(path.join(cwd, "package.json"));
  if (declared) {
    if (declared.startsWith("pnpm@")) return { kind: "pnpm", corepackSpec: declared };
    if (declared.startsWith("npm@")) return { kind: "npm", corepackSpec: declared };
    if (declared.startsWith("yarn@"))
      throw new Error(`unsupported target package manager: ${declared}`);
    throw new Error(`unrecognized target package manager: ${declared}`);
  }
  if (fs.existsSync(path.join(cwd, "pnpm-lock.yaml")))
    return { kind: "pnpm", corepackSpec: "pnpm@10.33.0" };
  if (fs.existsSync(path.join(cwd, "yarn.lock")))
    throw new Error("unsupported target package manager: yarn (no committed pnpm/npm lockfile)");
  if (fs.existsSync(path.join(cwd, "package-lock.json")))
    return { kind: "npm", corepackSpec: null };
  return { kind: "pnpm", corepackSpec: "pnpm@10.33.0" };
}

function readDeclaredPackageManager(packagePath: string): string | null {
  if (!fs.existsSync(packagePath)) return null;
  try {
    const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8"));
    return typeof pkg?.packageManager === "string" ? pkg.packageManager : null;
  } catch {
    return null;
  }
}

export function prepareTargetToolchain(cwd: string, options: TargetValidationOptions) {
  if (!options.installTargetDeps) return;
  if (!fs.existsSync(path.join(cwd, "package.json"))) return;

  const pm = detectTargetPackageManager(cwd);
  const validationEnv = targetValidationEnv();
  const setupTimeoutMs = targetValidationTimeoutMs(
    "CLAWSWEEPER_TARGET_SETUP_TIMEOUT_MS",
    options.setupTimeoutMs ?? DEFAULT_TARGET_SETUP_TIMEOUT_MS,
    options.setupTimeoutMs,
  );
  const installTimeoutMs = targetValidationTimeoutMs(
    "CLAWSWEEPER_TARGET_INSTALL_TIMEOUT_MS",
    options.installTimeoutMs ?? DEFAULT_TARGET_INSTALL_TIMEOUT_MS,
    options.installTimeoutMs,
  );
  run(
    "node",
    [
      "-e",
      "const major = Number(process.versions.node.split('.')[0]); if (major < 22) { console.error(`Node ${process.version} is too old for target validation`); process.exit(1); }",
    ],
    { cwd, env: validationEnv, timeoutMs: setupTimeoutMs },
  );
  if (pm.corepackSpec) {
    run("corepack", ["enable"], { cwd, env: validationEnv, timeoutMs: setupTimeoutMs });
    run("corepack", ["prepare", pm.corepackSpec, "--activate"], {
      cwd,
      env: validationEnv,
      timeoutMs: setupTimeoutMs,
    });
  }
  if (pm.kind === "pnpm") installWithPnpm(cwd, validationEnv, installTimeoutMs);
  else installWithNpm(cwd, validationEnv, installTimeoutMs);
}

function installWithPnpm(cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number) {
  // Targets without a committed `pnpm-lock.yaml` (e.g. forks that .gitignore
  // it) must install without `--frozen-lockfile` from the start; otherwise
  // pnpm fails with ERR_PNPM_NO_LOCKFILE before the retry path can help.
  const hasLockfile = fs.existsSync(path.join(cwd, "pnpm-lock.yaml"));
  const installArgs = [
    "install",
    hasLockfile ? "--frozen-lockfile" : "--no-frozen-lockfile",
    "--prefer-offline",
    "--config.engine-strict=false",
    "--config.enable-pre-post-scripts=true",
  ];
  try {
    run("pnpm", installArgs, { cwd, env, timeoutMs });
  } catch (error) {
    if (!hasLockfile || !/ERR_PNPM_OUTDATED_LOCKFILE/i.test(String(error.message))) throw error;
    run(
      "pnpm",
      installArgs.map((arg) => (arg === "--frozen-lockfile" ? "--no-frozen-lockfile" : arg)),
      {
        cwd,
        env,
        timeoutMs,
      },
    );
    restoreTargetLockfile(cwd);
  }
}

function installWithNpm(cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number) {
  const hasLockfile = fs.existsSync(path.join(cwd, "package-lock.json"));
  const installArgs = ["install", "--no-audit", "--no-fund", "--prefer-offline"];
  if (!hasLockfile) {
    run("npm", installArgs, { cwd, env, timeoutMs });
    return;
  }
  try {
    run("npm", ["ci", "--no-audit", "--no-fund", "--prefer-offline"], { cwd, env, timeoutMs });
  } catch (error) {
    // `npm ci` is strict — it exits EUSAGE when package.json and the
    // committed lockfile drift (e.g. an upstream merge bumped a dep but
    // didn't regenerate the lock). Targets in that state still install
    // cleanly under `npm install`. Mirror the pnpm OUTDATED_LOCKFILE
    // retry so we don't false-positive a verification error on a
    // lockfile-drift target.
    if (!/EUSAGE|out of sync|can only install/i.test(String(error.message))) throw error;
    run("npm", installArgs, { cwd, env, timeoutMs });
  }
}

export function runAllowedValidationCommands(
  commands: LooseRecord[],
  cwd: string,
  options: TargetValidationOptions,
  baseBranch: string = DEFAULT_BASE_BRANCH,
) {
  ensureMergeBaseAvailable({ targetDir: cwd, baseBranch });
  const validationEnv = targetValidationEnv();
  const validationTimeoutMs = targetValidationTimeoutMs(
    "CLAWSWEEPER_TARGET_VALIDATION_TIMEOUT_MS",
    options.validationTimeoutMs ?? DEFAULT_TARGET_VALIDATION_TIMEOUT_MS,
    options.validationTimeoutMs,
  );
  const executed: string[] = [];
  const attempts = new Map<string, number>();
  for (const command of requiredValidationCommands(commands, cwd, options)) {
    const resolvedCommands = resolveAllowedValidationCommands(command, cwd, baseBranch, options);
    for (const parts of resolvedCommands) {
      const executable = parts[0]!;
      const rendered = parts.join(" ");
      if (executed.includes(rendered)) continue;
      while (true) {
        try {
          run(executable, parts.slice(1), {
            cwd,
            env: validationEnv,
            timeoutMs: validationTimeoutMs,
          });
          executed.push(rendered);
          break;
        } catch (error) {
          const fallbackCommands = validationFallbackCommands({
            parts,
            error,
            cwd,
            baseBranch,
            options,
          });
          if (fallbackCommands.length > 0) {
            for (const fallbackParts of fallbackCommands) {
              const fallbackExecutable = fallbackParts[0]!;
              const fallbackRendered = fallbackParts.join(" ");
              if (executed.includes(fallbackRendered)) continue;
              run(fallbackExecutable, fallbackParts.slice(1), {
                cwd,
                env: validationEnv,
                timeoutMs: validationTimeoutMs,
              });
              executed.push(fallbackRendered);
            }
            break;
          }
          if (shouldRetryValidationCommand({ parts, error, attempts, options })) continue;
          throw new Error(
            `validation command failed (${parts.join(" ")}): ${compactText(error.message, 12000)}`,
          );
        }
      }
    }
  }
  return executed;
}

export function preflightTargetValidationPlan(
  { fixArtifact, targetDir, baseBranch = DEFAULT_BASE_BRANCH }: LooseRecord,
  options: TargetValidationOptions,
) {
  const scripts = readPackageScriptSet(targetDir);
  const availableScripts = [...scripts].sort();
  const resolved: string[] = [];
  const requiredScripts: LooseRecord[] = [];
  for (const command of requiredValidationCommands(
    fixArtifact.validation_commands ?? [],
    targetDir,
    options,
  )) {
    const resolvedCommands = resolveAllowedValidationCommands(
      command,
      targetDir,
      baseBranch,
      options,
    );
    for (const parts of resolvedCommands) {
      const rendered = parts.join(" ");
      if (!resolved.includes(rendered)) resolved.push(rendered);
      const script = packageScriptRequirement(parts);
      if (script) requiredScripts.push(script);
    }
  }

  const missing = requiredScripts.find((script: JsonValue) => !scripts.has(script.name));
  if (!missing) {
    return {
      status: "passed",
      resolved_commands: resolved,
      available_scripts: availableScripts,
    };
  }

  const sourcePr =
    (fixArtifact.source_prs ?? []).find(
      (source: JsonValue) => parsePullRequestUrl(source)?.repo === options.targetRepo,
    ) ?? null;
  return {
    status: "blocked",
    code: "validation_script_missing",
    required: missing.command,
    missing_script: missing.name,
    available_scripts: availableScripts,
    target_branch: fixArtifact.branch ?? fixArtifact.head_branch ?? null,
    source_pr: sourcePr,
    resolved_commands: resolved,
    reason: `validation_script_missing: required ${missing.command} is unavailable in target checkout`,
  };
}

export function requiredValidationCommands(
  commands: LooseRecord[] | undefined,
  cwd: string,
  options: TargetValidationOptions,
) {
  const out = [...(commands ?? []), ...(options.additionalValidationCommands ?? [])];
  if (!options.skipOpenClawChangedGate && requiresOpenClawChangedGate(cwd, options)) {
    out.push("pnpm check:changed");
  }
  return uniqueStrings(out);
}

export function repairDeltaValidationPlan(
  { fixArtifact, targetDir, sourceHead }: LooseRecord,
  options: TargetValidationOptions,
): RepairDeltaValidationPlan {
  const commands = fixArtifact.validation_commands ?? [];
  const changedSurface = {
    commands,
    options,
    scope: "changed-surface" as const,
    changed_files: [],
    reason: "validate the full changed surface against the target base branch",
  };
  if (options.targetRepo !== "openclaw/openclaw") return changedSurface;
  if (fixArtifact.repair_strategy !== "repair_contributor_branch") return changedSurface;
  const sourceRef = String(sourceHead ?? "");
  if (!/^[0-9a-f]{40}$/i.test(sourceRef)) return changedSurface;
  if (!isAncestor({ targetDir, ancestor: sourceRef, descendant: "HEAD" })) return changedSurface;

  const changedFiles = changedFilesSinceRef(targetDir, sourceRef);
  if (changedFiles.length === 0 || !changedFiles.every(isDocsOnlyRepairDeltaFile)) {
    return { ...changedSurface, changed_files: changedFiles };
  }

  return {
    commands: [`git diff --check ${sourceRef}..HEAD`],
    options: { ...options, skipOpenClawChangedGate: true },
    scope: "repair-delta-docs",
    changed_files: changedFiles,
    reason:
      "adopted PR repair changed only docs/changelog files since the source head; validate the repair delta and let PR checks gate the existing source diff",
  };
}

export function canSkipInternalCodexReviewForRepairDelta(plan: LooseRecord) {
  return String(plan?.scope ?? "") === "repair-delta-docs";
}

/**
 * A validation failure that reproduces identically at the pinned base and only
 * references files the repair delta never touched — i.e. the target repo was
 * already broken and the repair should not be blamed for it.
 */
export type ExternalBaseValidationBlocker = {
  paths: string[];
  reason: string;
};

/**
 * Classify a validation failure as pre-existing ("external base") rather than
 * repair-introduced.
 *
 * Requires the caller to supply `baseError`: the failure observed when the same
 * validation ran at `pinnedBaseRef`. Returns `null` whenever anything is
 * ambiguous — a different failure shape, no referenced tracked paths, or any
 * referenced path that the repair (or the base advance) actually changed.
 *
 * Adapted from openclaw/clawsweeper.
 */
export function classifyExternalBaseValidationFailure({
  targetDir,
  pinnedBaseRef,
  repairBaseRef,
  repairDeltaPaths,
  error,
  baseError,
}: {
  targetDir: string;
  pinnedBaseRef: string;
  repairBaseRef: string | null;
  repairDeltaPaths?: string[];
  error: unknown;
  baseError: unknown;
}): ExternalBaseValidationBlocker | null {
  if (!repairBaseRef || !baseError) return null;
  const trackedAtBase = new Set(
    splitGitLines(run("git", ["ls-tree", "-r", "--name-only", pinnedBaseRef], { cwd: targetDir })),
  );
  const referencedPaths = referencedTrackedPaths(String((error as Error)?.message ?? error), {
    targetDir,
    trackedAtBase,
  });
  if (referencedPaths.length === 0) return null;
  const baseReferencedPaths = referencedTrackedPaths(
    String((baseError as Error)?.message ?? baseError),
    { targetDir, trackedAtBase },
  );
  if (
    baseReferencedPaths.length !== referencedPaths.length ||
    referencedPaths.some((file) => !baseReferencedPaths.includes(file))
  ) {
    return null;
  }
  if (
    normalizedValidationFailure(String((error as Error)?.message ?? error), trackedAtBase) !==
    normalizedValidationFailure(String((baseError as Error)?.message ?? baseError), trackedAtBase)
  ) {
    return null;
  }

  const changedFromBase = new Set(
    splitGitLines(
      run("git", ["diff", "--name-only", `${pinnedBaseRef}..HEAD`], { cwd: targetDir }),
    ),
  );
  const repairDelta = new Set(
    repairDeltaPaths ??
      splitGitLines(
        run("git", ["diff", "--name-only", `${repairBaseRef}..HEAD`], { cwd: targetDir }),
      ),
  );
  if (referencedPaths.some((file) => changedFromBase.has(file) || repairDelta.has(file))) {
    return null;
  }

  return {
    paths: referencedPaths,
    reason: "validation failed only in base-identical files outside the repair delta",
  };
}

function referencedTrackedPaths(
  message: string,
  { targetDir, trackedAtBase }: { targetDir: string; trackedAtBase: ReadonlySet<string> },
) {
  const normalized = message.split(`${path.resolve(targetDir)}${path.sep}`).join("");
  const candidates = normalized.match(/[A-Za-z0-9_.@+-]+(?:\/[A-Za-z0-9_.@+-]+)*/g) ?? [];
  const paths: string[] = [];
  for (const rawCandidate of uniqueStrings(candidates)) {
    const candidate = rawCandidate.replace(/^\.\//, "");
    if (trackedAtBase.has(candidate)) {
      paths.push(candidate);
      continue;
    }
    for (const trackedPath of trackedAtBase) {
      if (candidate.endsWith(`/${trackedPath}`)) paths.push(trackedPath);
    }
  }
  return uniqueStrings(paths);
}

function normalizedValidationFailure(message: string, trackedAtBase: ReadonlySet<string>) {
  const ansiCsi = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, "g");
  let normalized = message.replace(ansiCsi, "").replace(/\r\n/g, "\n");
  const candidates = normalized.match(/\/?[A-Za-z0-9_.@+-]+(?:\/[A-Za-z0-9_.@+-]+)*/g) ?? [];
  for (const candidate of uniqueStrings(candidates).sort(
    (left, right) => right.length - left.length,
  )) {
    const withoutLeadingSlash = candidate.replace(/^\//, "");
    const trackedPath = trackedAtBase.has(withoutLeadingSlash)
      ? withoutLeadingSlash
      : [...trackedAtBase].find((tracked) => withoutLeadingSlash.endsWith(`/${tracked}`));
    if (trackedPath) normalized = normalized.split(candidate).join(trackedPath);
  }
  return normalized.trim();
}

function splitGitLines(value: string) {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function restoreTargetLockfile(cwd: string) {
  const lockfile = "pnpm-lock.yaml";
  if (!fs.existsSync(path.join(cwd, lockfile))) return;
  run("git", ["checkout", "--", lockfile], { cwd });
}

function validationFallbackCommands({ parts, error, cwd, baseBranch, options }: LooseRecord) {
  if (options.strictTargetValidation) return [];
  if (parts[0] !== "pnpm" || parts[1] !== "check:changed" || parts.length !== 2) return [];
  if (/no merge base/i.test(String(error?.message ?? ""))) {
    ensureMergeBaseAvailable({ targetDir: cwd, baseBranch });
    return [parts];
  }
  if (!isChangedGateStall(error)) return [];
  const changedTests = changedTestFiles(cwd, baseBranch);
  return [
    ["git", "diff", "--check", `origin/${baseBranch}...HEAD`],
    ...(changedTests.length > 0 ? [["pnpm", "test:serial", ...changedTests]] : []),
  ];
}

function isChangedGateStall(error: JsonValue) {
  return /no output for \d+ms|terminating stalled Vitest|stalled Vitest process/i.test(
    String(error?.message ?? ""),
  );
}

function shouldRetryValidationCommand({ parts, error, attempts, options }: LooseRecord) {
  if (options.strictTargetValidation) return false;
  if (parts[0] !== "pnpm" || parts[1] !== "check:changed" || parts.length !== 2) return false;
  if (isChangedGateStall(error)) return false;

  const configuredRetries = Number.parseInt(process.env.CLAWSWEEPER_VALIDATION_RETRIES ?? "1", 10);
  const maxRetries = Number.isFinite(configuredRetries) ? Math.max(0, configuredRetries) : 1;
  const rendered = parts.join(" ");
  const used = attempts.get(rendered) ?? 0;
  if (used >= maxRetries) return false;
  attempts.set(rendered, used + 1);
  return true;
}

function targetValidationEnv() {
  return {
    ...process.env,
    CI: process.env.CI ?? "true",
    OPENCLAW_LOCAL_CHECK: process.env.OPENCLAW_LOCAL_CHECK ?? "0",
  };
}

function targetValidationTimeoutMs(name: string, fallback: number, cap?: number) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  const timeout = Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  return cap ? Math.min(timeout, cap) : timeout;
}

function resolveAllowedValidationCommands(
  command: LooseRecord,
  cwd: string,
  baseBranch: string = DEFAULT_BASE_BRANCH,
  options: TargetValidationOptions,
) {
  const parts = parseAllowedValidationCommand(command);
  const commandParts = stripEnvPrefix(parts);
  const envPrefix = parts[0] === "env" ? parts.slice(0, parts.length - commandParts.length) : [];
  const scripts = readPackageScriptSet(cwd);
  if (
    !options.strictTargetValidation &&
    scripts.has("check:changed") &&
    commandParts[0] !== "git"
  ) {
    return [["pnpm", "check:changed"]];
  }
  if (commandParts[0] === "npm" && commandParts[1] === "run" && commandParts[2] === "validate") {
    if (!scripts.has("validate") && scripts.has("check:changed")) {
      return [["pnpm", "check:changed"]];
    }
  }
  if (commandParts[0] === "pnpm") {
    const commandStart = pnpmCommandStart(commandParts);
    const pnpmScript = commandParts[commandStart];
    if (isExpensivePnpmValidation(commandParts, commandStart, options.allowExpensiveValidation)) {
      return [["pnpm", "check:changed"]];
    }
    if (pnpmScript === "vitest" && commandParts[commandStart + 1] === "run") {
      return withEnvPrefix(
        envPrefix,
        normalizePathValidationCommand(
          ["pnpm", "test:serial", ...commandParts.slice(commandStart + 2)],
          cwd,
          baseBranch,
        ),
      );
    }
    if (pnpmScript === "test" || pnpmScript === "test:serial") {
      return withEnvPrefix(
        envPrefix,
        normalizePathValidationCommand(
          ["pnpm", pnpmScript, ...commandParts.slice(commandStart + 1)],
          cwd,
          baseBranch,
        ),
      );
    }
  }
  return [parts];
}

function withEnvPrefix(envPrefix: string[], commands: string[][]) {
  if (envPrefix.length === 0) return commands;
  return commands.map((command) => [...envPrefix, ...command]);
}

function normalizePathValidationCommand(
  parts: string[],
  cwd: string,
  baseBranch: string = DEFAULT_BASE_BRANCH,
) {
  const pathArgStart = 2;
  const pathArgs = parts.slice(pathArgStart).filter(looksLikePathArgument);
  if (pathArgs.length === 0) return [parts];

  const normalized: string[] = [];
  const missing: string[] = [];
  for (const arg of pathArgs) {
    const mapped = resolveRepoPathArgument(arg, cwd);
    if (mapped) normalized.push(mapped);
    else missing.push(arg);
  }

  if (missing.length === 0) {
    return [[...parts.slice(0, pathArgStart), ...uniqueStrings(normalized)]];
  }

  const changedTests = changedTestFiles(cwd, baseBranch);
  if (changedTests.length > 0) {
    return [["pnpm", "test:serial", ...changedTests]];
  }

  const scripts = readPackageScriptSet(cwd);
  if (scripts.has("check:changed")) {
    return [["pnpm", "check:changed"]];
  }

  return [[...parts.slice(0, pathArgStart), ...uniqueStrings(normalized)]];
}

function resolveRepoPathArgument(arg: JsonValue, cwd: string): string {
  const clean = String(arg ?? "").trim();
  if (!clean || clean.startsWith("-")) return clean;
  if (fs.existsSync(path.join(cwd, clean))) return clean;

  const candidates = candidateRepoPaths(clean, cwd).filter((candidate) =>
    fs.existsSync(path.join(cwd, candidate)),
  );
  return candidates[0] ?? "";
}

function candidateRepoPaths(filePath: string, cwd: string): string[] {
  const out: string[] = [];
  if (filePath.startsWith("src/web/")) {
    out.push(`extensions/whatsapp/src/${filePath.slice("src/web/".length)}`);
  }
  const basename = path.basename(filePath);
  if (basename) {
    const files = gitLsFiles(cwd);
    out.push(...files.filter((file) => path.basename(file) === basename));
  }
  return uniqueStrings(out);
}

function changedTestFiles(cwd: string, baseBranch: string = DEFAULT_BASE_BRANCH) {
  return gitChangedFiles(cwd, baseBranch).filter(
    (file) => isTestFile(file) && fs.existsSync(path.join(cwd, file)),
  );
}

function readPackageScriptSet(cwd: string) {
  const packagePath = path.join(cwd, "package.json");
  if (!fs.existsSync(packagePath)) return new Set<string>();
  try {
    const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8"));
    return new Set<string>(Object.keys(pkg.scripts ?? {}));
  } catch {
    return new Set<string>();
  }
}

function requiresOpenClawChangedGate(cwd: string, options: TargetValidationOptions) {
  return (
    options.targetRepo === "openclaw/openclaw" && readPackageScriptSet(cwd).has("check:changed")
  );
}

function changedFilesSinceRef(cwd: string, sourceRef: string) {
  const committed = run("git", ["diff", "--name-only", `${sourceRef}..HEAD`], { cwd })
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const uncommitted = run("git", ["status", "--porcelain"], { cwd })
    .split("\n")
    .map((line) => line.trim())
    .map((line) => line.replace(/^.. /, ""))
    .map((line) => line.split(" -> ").pop())
    .filter(Boolean);
  return uniqueStrings([...committed, ...uncommitted]);
}

function isDocsOnlyRepairDeltaFile(filePath: string) {
  const file = String(filePath ?? "").trim();
  if (!file) return false;
  if (file === "CHANGELOG.md") return true;
  if (file.startsWith("docs/")) return true;
  if (/^(?:README|CONTRIBUTING|SECURITY|SUPPORT|CODE_OF_CONDUCT)\.md$/i.test(file)) return true;
  return /\.(?:md|mdx|txt)$/i.test(file);
}
