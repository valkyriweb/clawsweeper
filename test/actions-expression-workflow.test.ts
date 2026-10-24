import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

// Ported in spirit from upstream openclaw/clawsweeper#2064. Untrusted values
// (inputs, event fields, head_ref, step and job outputs) must reach shell
// scripts through `env:`, never as `${{ }}` text spliced into the script.
const UNTRUSTED_EXPRESSION =
  /\$\{\{[^}]*\b(?:inputs\b|github\.event[.[]|github\.head_ref\b|steps\b|needs\b)/;

type ScriptBlock = { line: number; text: string };

/** Collect `run:` scripts from a workflow or action file without a YAML dependency. */
function runScripts(source: string): ScriptBlock[] {
  const lines = source.split("\n");
  const blocks: ScriptBlock[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(\s*)(?:- )?run:\s*(.*)$/.exec(lines[index] ?? "");
    if (!match) continue;
    const keyIndent =
      (match[1] ?? "").length + (lines[index]?.trimStart().startsWith("- ") ? 2 : 0);
    const rest = (match[2] ?? "").trim();
    if (!/^[|>][+-]?$/.test(rest)) {
      blocks.push({ line: index + 1, text: rest });
      continue;
    }
    const body: string[] = [];
    let next = index + 1;
    while (next < lines.length) {
      const line = lines[next] ?? "";
      const indent = line.length - line.trimStart().length;
      if (line.trim() !== "" && indent <= keyIndent) break;
      body.push(line);
      next += 1;
    }
    blocks.push({ line: index + 1, text: body.join("\n") });
    index = next - 1;
  }
  return blocks;
}

function yamlFiles(root: string): string[] {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.ya?ml$/.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
}

test("runScripts finds inline and block scripts", () => {
  const blocks = runScripts(
    [
      "steps:",
      "  - run: echo one",
      "  - name: two",
      "    run: |",
      "      echo two",
      "      echo three",
      "    env:",
      "      A: b",
    ].join("\n"),
  );
  assert.deepEqual(
    blocks.map((block) => block.text.trim()),
    ["echo one", "echo two\n      echo three"],
  );
});

test("the untrusted-expression check catches spliced inputs and event fields", () => {
  assert.match('echo "${{ inputs.version }}"', UNTRUSTED_EXPRESSION);
  assert.match("echo ${{ inputs['auth-mode'] }}", UNTRUSTED_EXPRESSION);
  assert.match("echo ${{ github.event.issue.title }}", UNTRUSTED_EXPRESSION);
  assert.doesNotMatch('echo "${INPUTS_VERSION}"', UNTRUSTED_EXPRESSION);
  assert.doesNotMatch("echo ${{ runner.os }}", UNTRUSTED_EXPRESSION);
});

test("composite actions keep untrusted expressions out of scripts", () => {
  const offenders: string[] = [];
  for (const file of yamlFiles(".github/actions")) {
    for (const block of runScripts(readFileSync(file, "utf8"))) {
      if (UNTRUSTED_EXPRESSION.test(block.text)) offenders.push(`${file}:${block.line}`);
    }
  }
  assert.deepEqual(offenders, [], "pass these values through env: instead");
});
