import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const workflowsDir = join(import.meta.dirname, "../.github/workflows");

type Job = { workflow: string; job: string; steps: string[] };

function workflowJobs(): Job[] {
  const jobs: Job[] = [];
  for (const workflow of readdirSync(workflowsDir)) {
    if (!workflow.endsWith(".yml")) continue;
    const lines = readFileSync(join(workflowsDir, workflow), "utf8").split("\n");
    let inJobs = false;
    let current: Job | undefined;
    for (const line of lines) {
      if (/^\S/.test(line)) inJobs = line.startsWith("jobs:");
      if (!inJobs) continue;
      const jobHeader = /^ {2}([\w-]+):\s*$/.exec(line);
      if (jobHeader) {
        current = { workflow, job: jobHeader[1]!, steps: [] };
        jobs.push(current);
      } else if (current && line.startsWith("      - ")) {
        current.steps.push(line);
      } else if (current && current.steps.length > 0 && line.startsWith("       ")) {
        current.steps[current.steps.length - 1] += `\n${line}`;
      }
    }
  }
  return jobs;
}

const downloadsRuntimeDist = (step: string) =>
  /actions\/download-artifact/.test(step) && /name: clawsweeper-runtime-dist\b/.test(step);
const installsDependencies = (step: string) =>
  /uses: \S*\.github\/actions\/setup-pnpm\b/.test(step) || /\bpnpm install\b/.test(step);
// dist imports third-party packages such as effect, so these need node_modules.
const runsDistCode = (step: string) =>
  /uses: \S*\.github\/actions\/create-target-token\b/.test(step) ||
  /\bnode (\S*\/)?dist\//.test(step);

test("jobs install dependencies before running dist code", () => {
  const jobs = workflowJobs();
  assert.ok(
    jobs.some(({ steps }) => steps.some(downloadsRuntimeDist)),
    "expected at least one job to download clawsweeper-runtime-dist",
  );
  for (const { workflow, job, steps } of jobs) {
    const firstRun = steps.findIndex(runsDistCode);
    if (firstRun === -1) continue;
    const firstInstall = steps.findIndex(installsDependencies);
    assert.ok(
      firstInstall !== -1 && firstInstall < firstRun,
      `${workflow} job ${job} runs dist code before installing dependencies`,
    );
  }
});
