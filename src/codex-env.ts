export type CodexEnvOptions = {
  ghToken?: string | undefined;
};

export function codexEnv(options: CodexEnvOptions = {}): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const ghToken = options.ghToken?.trim();
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  delete env.COMMIT_SWEEPER_TARGET_GH_TOKEN;
  delete env.CLAWSWEEPER_PROOF_INSPECTION_TOKEN;
  delete env.CLAWSWEEPER_APP_ID;
  delete env.CLAWSWEEPER_APP_PRIVATE_KEY;
  delete env.BERMONT_DIGITAL_CLAWSWEEPER_APP_PRIVATE_KEY;
  delete env.OPENAI_API_KEY;
  delete env.CODEX_API_KEY;
  delete env.OPIK_API_KEY;
  if (ghToken) env.GH_TOKEN = ghToken;
  env.GIT_OPTIONAL_LOCKS = "0";
  return env;
}

// Env names whose values must never appear in retained Codex debug artifacts.
const CODEX_SENSITIVE_ENV_NAME =
  /(?:^|_)(?:TOKEN|KEY|SECRET|PASSWORD|CREDENTIALS?|PRIVATE)(?:_|$)/i;
const CODEX_EXPLICIT_SENSITIVE_ENV = new Set([
  "ACTIONS_CACHE_URL",
  "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
  "ACTIONS_ID_TOKEN_REQUEST_URL",
  "ACTIONS_RESULTS_URL",
  "ACTIONS_RUNTIME_TOKEN",
  "ACTIONS_RUNTIME_URL",
  "GITHUB_ACTIONS_RUNTIME_TOKEN",
]);

export function codexSensitiveEnvValues(env: NodeJS.ProcessEnv = process.env): string[] {
  return [
    ...new Set(
      Object.entries(env)
        .filter(
          ([name]) => CODEX_EXPLICIT_SENSITIVE_ENV.has(name) || CODEX_SENSITIVE_ENV_NAME.test(name),
        )
        .map(([, value]) => String(value ?? "").trim())
        .filter((value) => value.length >= 6),
    ),
  ].sort((left, right) => right.length - left.length);
}
