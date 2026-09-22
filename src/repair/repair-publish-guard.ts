import { runCommand } from "./command-runner.js";
import { repairPathsAllowed } from "./pr-lifecycle.js";

/** Check committed output, not the model's proposed likely_files. Renames retain both paths. */
export function assertRepairPublishScope(
  cwd: string,
  base: string,
  allowedPaths: readonly string[] | undefined,
): void {
  if (!allowedPaths) return;
  const changed = runCommand(
    "git",
    ["diff", "--name-only", "--no-renames", "-z", `origin/${base}...HEAD`, "--"],
    { cwd, timeoutMs: 20_000 },
  )
    .split("\0")
    .filter(Boolean);
  if (!repairPathsAllowed(changed, allowedPaths))
    throw new Error("refusing push outside repository repair_allowed_paths; human review required");
}
