import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { runPi } from "../../dist/clawsweeper.js";
const [model, output] = process.argv.slice(2);
if (!model || !output) throw new Error("usage: node evals/sweep-routing/run.mjs <model> <output.json>");
const fixture = JSON.parse(readFileSync("evals/sweep-routing/frozen-sanitized-issue.json", "utf8"));
const labels = JSON.parse(readFileSync("evals/sweep-routing/labels.json", "utf8"));
const startedAt = new Date().toISOString(), began = Date.now(); let result;
try { result = { status: "success", decision: runPi({ ...fixture, model, openclawDir: resolve("."), reasoningEffort: "none", sandboxMode: "read-only", serviceTier: "default", timeoutMs: 300000, workDir: resolve(".eval-work", model.replaceAll("/", "-")) }) }; }
catch (error) { result = { status: "failed", error: error instanceof Error ? error.message : String(error) }; }
const labelMatch = result.status === "success" && Object.entries(labels.expected).every(([key, value]) => result.decision[key] === value);
mkdirSync(resolve(output, ".."), { recursive: true });
writeFileSync(output, JSON.stringify({ requested: { provider: "pi", model, effort: "none" }, startedAt, wallMs: Date.now()-began, fixture: "frozen-sanitized-issue.json", labelMatch, ...result }, null, 2)+"\n");
if (!labelMatch) process.exitCode = 1;
