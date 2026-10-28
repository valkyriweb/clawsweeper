// Enforce per-file line/branch/function coverage from an lcov file.
// Usage: node scripts/check-file-coverage.mjs <lcov> <file> <minPercent>
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const [lcovPath, file, minArg] = process.argv.slice(2);
const min = Number(minArg);
const target = resolve(file);
const record = readFileSync(lcovPath, "utf8")
  .split("end_of_record")
  .find((r) => r.split("\n").some((l) => l.startsWith("SF:") && resolve(l.slice(3)) === target));
if (!record) {
  console.error(`coverage: no lcov record for ${file}`);
  process.exit(1);
}
const num = (k) => Number(record.match(new RegExp(`^${k}:(\\d+)`, "m"))?.[1] ?? 0);
let failed = false;
for (const [name, found, hit] of [["lines", "LF", "LH"], ["branches", "BRF", "BRH"], ["functions", "FNF", "FNH"]]) {
  const pct = num(found) === 0 ? 100 : (num(hit) / num(found)) * 100;
  const ok = pct >= min;
  failed ||= !ok;
  console.log(`${ok ? "ok" : "FAIL"} ${file} ${name} ${pct.toFixed(2)}% (min ${min}%)`);
}
process.exit(failed ? 1 : 0);
