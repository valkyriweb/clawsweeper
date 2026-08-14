export type PackageScriptRequirement = {
  command: string;
  name: string;
};

// Package-manager subcommands that are never package scripts. Adapted from
// upstream clawsweeper's command classifier: without this list pnpm built-ins
// (`pnpm dedupe`, `pnpm audit`, `pnpm why`, ...) fall through pnpm's implicit
// script fallback and get reported as a missing validation script.
const PACKAGE_MANAGER_NON_SCRIPT_COMMANDS: ReadonlySet<string> = new Set([
  "access",
  "add",
  "approve-builds",
  "audit",
  "bin",
  "cache",
  "ci",
  "completion",
  "config",
  "create",
  "dedupe",
  "deploy",
  "deprecate",
  "diff",
  "dist-tag",
  "dlx",
  "doctor",
  "env",
  "exec",
  "explore",
  "fetch",
  "find-dupes",
  "fund",
  "get",
  "help",
  "hook",
  "ignored-builds",
  "import",
  "init",
  "install",
  "install-test",
  "licenses",
  "link",
  "list",
  "login",
  "logout",
  "ls",
  "org",
  "outdated",
  "owner",
  "pack",
  "patch",
  "patch-commit",
  "patch-remove",
  "ping",
  "pkg",
  "prefix",
  "profile",
  "prune",
  "publish",
  "query",
  "rebuild",
  "remove",
  "repo",
  "root",
  "search",
  "self-update",
  "set",
  "setup",
  "star",
  "store",
  "team",
  "token",
  "uninstall",
  "unlink",
  "unpublish",
  "unstar",
  "update",
  "version",
  "view",
  "whoami",
  "why",
  "workspace",
  "workspaces",
]);

// pnpm short aliases that resolve to non-script built-ins.
const PNPM_COMMAND_ALIASES: ReadonlyMap<string, string> = new Map([
  ["adduser", "login"],
  ["c", "config"],
  ["clean-install", "ci"],
  ["dislink", "unlink"],
  ["dist-tags", "dist-tag"],
  ["find", "search"],
  ["i", "install"],
  ["ic", "ci"],
  ["info", "view"],
  ["install-clean", "ci"],
  ["it", "install-test"],
  ["la", "list"],
  ["ll", "list"],
  ["ln", "link"],
  ["ls", "list"],
  ["owners", "owner"],
  ["rb", "rebuild"],
  ["rm", "remove"],
  ["t", "test"],
  ["tst", "test"],
  ["un", "uninstall"],
  ["up", "update"],
  ["upgrade", "update"],
]);

const PNPM_BOOLEAN_GLOBAL_OPTIONS: ReadonlySet<string> = new Set([
  "-r",
  "-s",
  "-w",
  "--fail-if-no-match",
  "--ignore-scripts",
  "--offline",
  "--prefer-offline",
  "--recursive",
  "--silent",
  "--workspace-root",
]);

const PNPM_VALUE_GLOBAL_OPTIONS: ReadonlySet<string> = new Set([
  "-C",
  "-F",
  "--dir",
  "--filter",
  "--loglevel",
  "--reporter",
]);

export function resolvePnpmCommandAlias(command: unknown): string {
  const name = String(command ?? "");
  return PNPM_COMMAND_ALIASES.get(name) ?? name;
}

export function isPackageManagerNonScriptCommand(command: unknown): boolean {
  return PACKAGE_MANAGER_NON_SCRIPT_COMMANDS.has(resolvePnpmCommandAlias(command));
}

/**
 * Index of the pnpm subcommand/script within `parts`, skipping pnpm global
 * options (`-s`, `-r`, `--filter <x>`, `--dir <x>`, `--loglevel=debug`, ...).
 */
export function pnpmCommandStart(parts: readonly string[]): number {
  let index = 1;
  while (index < parts.length) {
    const token = String(parts[index] ?? "");
    if (PNPM_BOOLEAN_GLOBAL_OPTIONS.has(token)) {
      index += 1;
      continue;
    }
    if (PNPM_VALUE_GLOBAL_OPTIONS.has(token)) {
      index += 2;
      continue;
    }
    if (token.startsWith("--") && token.includes("=")) {
      index += 1;
      continue;
    }
    break;
  }
  return index;
}

export function packageScriptRequirement(
  parts: readonly string[],
): PackageScriptRequirement | null {
  const commandParts = stripEnvPrefix(parts);
  if (commandParts[0] === "npm" && commandParts[1] === "run" && commandParts[2]) {
    return { name: commandParts[2], command: commandParts.slice(0, 3).join(" ") };
  }
  if (commandParts[0] !== "pnpm") return null;
  const index = pnpmCommandStart(commandParts);
  // `pnpm run <script>` is explicit: never classify it as a built-in.
  if (commandParts[index] === "run") {
    const explicit = commandParts[index + 1];
    if (!explicit) return null;
    return { name: explicit, command: ["pnpm", explicit].join(" ") };
  }
  const script = resolvePnpmCommandAlias(commandParts[index]);
  if (!script || isPackageManagerNonScriptCommand(script)) return null;
  return { name: script, command: ["pnpm", script].join(" ") };
}

export function isExpensivePnpmValidation(
  parts: readonly string[],
  commandStart: number,
  allowExpensiveValidation: boolean,
): boolean {
  if (allowExpensiveValidation) return false;
  const script = String(parts[commandStart] ?? "");
  if (script === "check" || script === "test:all") return true;
  if (script === "openclaw" && parts[commandStart + 1] === "qa") return true;
  if (script === "test" || script === "test:serial") {
    return !parts.slice(commandStart + 1).some(looksLikePathArgument);
  }
  return /^(?:test:(?:e2e|live|docker|install:e2e|parallels)(?::|$)|qa:e2e$|android:test:integration$)/.test(
    script,
  );
}

export function looksLikePathArgument(value: unknown): boolean {
  const text = String(value ?? "");
  return (
    !text.startsWith("-") &&
    (text.includes("/") || /\.(?:[cm]?[jt]sx?|json|md|yml|yaml)$/.test(text))
  );
}

export function isTestFile(value: unknown): boolean {
  return /(?:^|\/)[^/]*(?:test|spec|e2e)\.[cm]?[jt]sx?$/.test(String(value));
}

export function uniqueStrings(values: Iterable<unknown>): string[] {
  return [...new Set([...values].filter(Boolean).map(String))];
}

export function parseAllowedValidationCommand(command: unknown): string[] {
  const text = String(command ?? "").trim();
  if (!text) throw new Error("empty validation command");
  const safetyText = text.replace(
    /\$\{[A-Z_][A-Z0-9_]*(?::-[A-Za-z0-9_./:-]+)?\}/g,
    "SHELL_DEFAULT",
  );
  if (/[`$;&|<>()[\]{}*?~]/.test(safetyText)) {
    throw new Error(`unsafe validation command: ${text}`);
  }
  const parts = normalizeEnvInvocation(text.split(/\s+/));
  const executable = validationExecutable(parts);
  if (!executable || !isAllowedValidationExecutable(executable)) {
    throw new Error(`unsupported validation command: ${text}`);
  }
  return parts;
}

export function stripEnvPrefix(parts: readonly string[]): string[] {
  let index = parts[0] === "env" ? 1 : 0;
  while (index < parts.length && isEnvAssignment(parts[index])) index += 1;
  return parts.slice(index);
}

function validationExecutable(parts: readonly string[]) {
  const commandParts = stripEnvPrefix(parts);
  const strippedCount = parts.length - commandParts.length - (parts[0] === "env" ? 1 : 0);
  if (parts[0] === "env" && strippedCount === 0) return "";
  return commandParts[0] ?? "";
}

function isAllowedValidationExecutable(executable: string) {
  // `composer` and `php` cover Laravel / Symfony / generic PHP validation
  // commands (`composer install`, `composer test`, `php artisan test`).
  // `vendor/bin/<binary>` matches PHP test runners installed by Composer
  // (`vendor/bin/phpunit`, `vendor/bin/pest`). The existing shell-metachar
  // guard above still blocks dangerous invocations of any of these.
  return (
    ["pnpm", "npm", "node", "git", "composer", "php"].includes(executable) ||
    executable === "scripts/run-opengrep.sh" ||
    executable === "./scripts/run-opengrep.sh" ||
    /^(?:\.\/)?vendor\/bin\/[A-Za-z0-9_.-]+$/.test(executable)
  );
}

function isEnvAssignment(value: unknown) {
  return /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(String(value ?? ""));
}

function normalizeEnvInvocation(parts: readonly string[]): string[] {
  if (parts[0] === "env" || !isEnvAssignment(parts[0])) return [...parts];
  return ["env", ...parts];
}
