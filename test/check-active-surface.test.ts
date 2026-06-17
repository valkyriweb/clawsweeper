import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  collectActiveSurfaceFindings,
  findRetiredInText,
  isTextFile,
  retiredPatterns,
} from "../scripts/check-active-surface.ts";

// `test/` is one of the guard's active roots, so the literal retired tokens must
// never appear contiguously in this file (or the guard would flag its own test).
// Every sample is assembled at runtime from individually-inert fragments, and
// expected labels are read from the imported registry rather than written here.
const CW = "CLAWSWEEPER_";
const GHT = "GH" + "_TOKEN";

const samples: { text: string; match: string }[] = [
  { text: "clown" + "fish", match: "clown" + "fish" },
  { text: "Project" + "Clown" + "Fish", match: "Project" + "Clown" + "Fish" },
  { text: CW + "CLOWN" + "FISH", match: CW + "CLOWN" + "FISH" },
  { text: CW + "REPAIR" + "_OLD", match: CW + "REPAIR" + "_" },
  { text: "OPEN" + "CLAW_" + GHT, match: "OPEN" + "CLAW_" + GHT },
  { text: CW + GHT, match: CW + GHT },
  { text: CW + "READ_" + GHT, match: CW + "READ_" + GHT },
  { text: CW + "CODEX_" + GHT, match: CW + "CODEX_" + GHT },
  { text: CW + "REVIEW_" + GHT, match: CW + "REVIEW_" + GHT },
  { text: "gh run " + "list " + "--workflow ci.yml", match: "gh run " + "list " + "--workflow" },
];

test("findRetiredInText extracts the registry label, matched text, and 1-based position", () => {
  for (const sample of samples) {
    const findings = findRetiredInText(sample.text, "example.ts");
    const finding = findings.find((f) => f.match === sample.match);
    assert.ok(
      finding,
      `expected a finding matching ${JSON.stringify(sample.match)}, got ${JSON.stringify(findings)}`,
    );
    assert.equal(finding.file, "example.ts");
    assert.equal(finding.line, 1);
    assert.equal(finding.column, 1);
    const expected = retiredPatterns.find((p) => p.pattern.test(sample.text));
    assert.ok(expected, `no registry pattern matched ${JSON.stringify(sample.text)}`);
    assert.equal(finding.label, expected.label);
  }
});

test("findRetiredInText reports 1-based line and column for a deeper match", () => {
  const text = ["clean first line", "  " + "clown" + "fish trailing"].join("\n");
  const findings = findRetiredInText(text, "x.md");
  assert.equal(findings.length, 1);
  assert.equal(findings[0].line, 2);
  assert.equal(findings[0].column, 3);
});

test("findRetiredInText returns no findings for clean text", () => {
  assert.deepEqual(findRetiredInText("const x = 1;\nexport default x;\n", "x.ts"), []);
});

test("findRetiredInText flags multiple distinct retired patterns on one line", () => {
  const labels = findRetiredInText("clown" + "fish near " + CW + GHT, "x.ts").map((f) => f.label);
  assert.equal(labels.length, 2);
  assert.notEqual(labels[0], labels[1]);
});

test("isTextFile recognizes text candidates and rejects non-text", () => {
  assert.equal(isTextFile("package.json"), true);
  assert.equal(isTextFile("dir/tsconfig.repair.json"), true);
  assert.equal(isTextFile("a/b/foo.ts"), true);
  assert.equal(isTextFile("readme.md"), true);
  assert.equal(isTextFile("ci.yml"), true);
  assert.equal(isTextFile("pnpm-lock.yaml"), true);
  assert.equal(isTextFile("logo.png"), false);
  assert.equal(isTextFile("Makefile"), false);
  assert.equal(isTextFile("bundle.lock"), false);
});

test("retiredPatterns registry is exported, non-empty, and well-formed", () => {
  assert.ok(retiredPatterns.length >= 10);
  for (const entry of retiredPatterns) {
    assert.equal(typeof entry.label, "string");
    assert.ok(entry.pattern instanceof RegExp);
  }
});

test("collectActiveSurfaceFindings walks active roots and flags planted retired tokens", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cas-"));
  try {
    fs.mkdirSync(path.join(dir, "src"), { recursive: true });
    fs.writeFileSync(path.join(dir, "src", "clean.ts"), "export const ok = 1;\n");
    fs.writeFileSync(
      path.join(dir, "src", "bad.ts"),
      "const t = " + JSON.stringify(CW + GHT) + ";\n",
    );
    const findings = collectActiveSurfaceFindings(dir);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].file, "src/bad.ts");
    assert.equal(findings[0].match, CW + GHT);
    assert.equal(findings[0].line, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
