// Offline regrade of retained cohort outputs. Applies the current graders to receipts
// that already exist; makes no model calls and writes nothing. Used to separate grader
// defects from genuine model failures after the 2026-09-05 paired run.
//
//   ARCHIVE=/path/to/forge-rescope node evals/sweep-routing-rescope/regrade.mjs
//
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { COHORT_PATH, EVAL_DIR, decisionFailures, routingMatches } from "./run.mjs";

const ARCHIVE = process.env.ARCHIVE;
const report = JSON.parse(readFileSync(`${ARCHIVE}/results/report.json`, "utf8"));
const audit = JSON.parse(readFileSync(`${ARCHIVE}/decisions-audit.json`, "utf8"));
const cohort = JSON.parse(readFileSync(COHORT_PATH, "utf8"));
const caseById = Object.fromEntries(cohort.cases.map((c) => [c.id, c]));
const entries = Array.isArray(audit) ? audit : audit.decisions;
const fullDecision = (cand, id) =>
  entries.find((e) => e.candidate === cand && e.id === id)?.decision;

const summary = {};
for (const [name, cand] of Object.entries(report.candidates)) {
  const cfg = cohort.models[name];
  console.log(`\n=== ${name}  (${cfg.model}, $${cand.totalCost})`);
  let pass = 0;
  for (const res of cand.results) {
    const spec = caseById[res.id];
    const fixture = JSON.parse(readFileSync(join(EVAL_DIR, spec.fixture), "utf8"));
    const decision = fullDecision(name, res.id) ?? res.decision;
    const failures = [...decisionFailures(decision, spec, fixture)];
    const term = res.receipt.terminal;
    if (term && (term.provider !== "clawrouter" || !routingMatches(term.model, cfg)))
      failures.push("routing mismatch");
    if (!failures.length) pass++;
    console.log(`  ${failures.length ? "FAIL" : "PASS"}  ${res.id}`);
    console.log(`        was: ${JSON.stringify(res.failures)}`);
    console.log(`        now: ${JSON.stringify(failures)}`);
  }
  summary[name] = `${pass}/${cand.results.length}`;
  console.log(`  --> ${pass}/${cand.results.length} pass`);
}
console.log("\nSUMMARY", JSON.stringify(summary));
