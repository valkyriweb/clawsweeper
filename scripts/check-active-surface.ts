#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const activeRoots: string[] = [
  ".github/workflows",
  "config",
  "src",
  "test",
  "docs",
  "prompts",
  "schema",
  "instructions",
  "scripts",
  "AGENTS.md",
  "README.md",
  "package.json",
  "tsconfig.json",
  "tsconfig.repair.json",
];

const ignoredDirs = new Set<string>([
  ".git",
  "dist",
  "node_modules",
  "records",
  ".clawsweeper-repair",
]);
const textExtensions = new Set<string>([
  ".cjs",
  ".d.ts",
  ".json",
  ".js",
  ".mjs",
  ".md",
  ".ts",
  ".tsx",
  ".txt",
  ".yaml",
  ".yml",
]);

export const retiredPatterns: { label: string; pattern: RegExp }[] = [
  { label: "Clownfish product name", pattern: /\bclownfish\b/i },
  { label: "ProjectClownfish name", pattern: /\bProjectClownFish\b|\bProjectClownfish\b/i },
  { label: "old Clownfish env prefix", pattern: /\bCLAWSWEEPER_CLOWNFISH\b/ },
  { label: "old repair env prefix", pattern: /\bCLAWSWEEPER_REPAIR_/ },
  { label: "retired OpenClaw token", pattern: /\bOPENCLAW_GH_TOKEN\b/ },
  { label: "retired ClawSweeper token", pattern: /\bCLAWSWEEPER_GH_TOKEN\b/ },
  { label: "retired ClawSweeper read token", pattern: /\bCLAWSWEEPER_READ_GH_TOKEN\b/ },
  { label: "retired repair Codex token", pattern: /\bCLAWSWEEPER_CODEX_GH_TOKEN\b/ },
  { label: "retired review token", pattern: /\bCLAWSWEEPER_REVIEW_GH_TOKEN\b/ },
  { label: "unsupported gh run list workflow flag", pattern: /\bgh run list\b.*--workflow\b/ },
];

export type Finding = {
  file: string;
  line: number;
  column: number;
  label: string;
  match: string;
};

export function findRetiredInText(
  text: string,
  file: string,
  patterns: { label: string; pattern: RegExp }[] = retiredPatterns,
): Finding[] {
  const out: Finding[] = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    for (const retired of patterns) {
      const match = retired.pattern.exec(line);
      if (!match) continue;
      out.push({
        file,
        line: index + 1,
        column: match.index + 1,
        label: retired.label,
        match: match[0],
      });
    }
  });
  return out;
}

function scan(absolute: string, rootDir: string, findings: Finding[]): void {
  const stat = fs.statSync(absolute);
  const name = path.basename(absolute);
  if (stat.isDirectory()) {
    if (ignoredDirs.has(name)) return;
    for (const child of fs.readdirSync(absolute))
      scan(path.join(absolute, child), rootDir, findings);
    return;
  }
  if (!stat.isFile() || !isTextFile(absolute)) return;
  const relative = path.relative(rootDir, absolute);
  const canonicalRelative = relative.split(path.sep).join("/");
  if (canonicalRelative === "scripts/check-active-surface.ts") return;
  const text = fs.readFileSync(absolute, "utf8");
  findings.push(...findRetiredInText(text, canonicalRelative));
}

export function collectActiveSurfaceFindings(rootDir: string = process.cwd()): Finding[] {
  const findings: Finding[] = [];
  for (const entry of activeRoots) {
    const absolute = path.join(rootDir, entry);
    if (!fs.existsSync(absolute)) continue;
    scan(absolute, rootDir, findings);
  }
  return findings;
}

export function isTextFile(file: string): boolean {
  const basename = path.basename(file);
  if (basename === "package.json") return true;
  if (basename.startsWith("tsconfig") && basename.endsWith(".json")) return true;
  return textExtensions.has(path.extname(file));
}

const isMain = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (isMain) {
  const findings = collectActiveSurfaceFindings();
  if (findings.length > 0) {
    console.error("Active-surface guard failed:");
    for (const finding of findings) {
      console.error(
        `- ${finding.file}:${finding.line}:${finding.column} ${finding.label}: ${finding.match}`,
      );
    }
    process.exit(1);
  }
}
