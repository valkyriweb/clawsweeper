import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";
import test from "node:test";

const root = join(import.meta.dirname, "..");
const workflowsDir = join(root, ".github/workflows");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

// Every src/ file that src/repair reaches through relative imports, outside src/repair itself.
function repairDependencies(): string[] {
  const seen = new Set<string>();
  const queue = sourceFiles(join(root, "src/repair"));
  const outside = new Set<string>();
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(/(?:from|import)\s*\(?\s*"(\.{1,2}\/[^"]+)\.js"/g)) {
      const target = normalize(join(dirname(file), `${match[1]}.ts`));
      const rel = relative(root, target).replaceAll("\\", "/");
      if (!rel.startsWith("src/repair/")) outside.add(rel);
      queue.push(target);
    }
  }
  return [...outside].sort();
}

function sparseListsWithRepair(): Array<{ workflow: string; paths: string[] }> {
  const lists: Array<{ workflow: string; paths: string[] }> = [];
  for (const name of readdirSync(workflowsDir)) {
    if (!name.endsWith(".yml")) continue;
    const lines = readFileSync(join(workflowsDir, name), "utf8").split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      const header = /^(\s*)sparse-checkout: \|\s*$/.exec(lines[i]!);
      if (!header) continue;
      const paths: string[] = [];
      for (let j = i + 1; j < lines.length; j += 1) {
        const line = lines[j]!;
        const indent = /^(\s*)/.exec(line)![1]!.length;
        if (line.trim() === "" || indent <= header[1]!.length) break;
        paths.push(line.trim());
      }
      if (paths.includes("src/repair")) lists.push({ workflow: name, paths });
    }
  }
  return lists;
}

test("sparse checkouts that build src/repair include every imported src file", () => {
  const dependencies = repairDependencies();
  const lists = sparseListsWithRepair();
  assert.ok(lists.length > 0, "expected at least one sparse checkout of src/repair");
  for (const { workflow, paths } of lists) {
    const missing = dependencies.filter((file) => !paths.includes(file));
    assert.deepEqual(missing, [], `${workflow} sparse checkout is missing repair imports`);
  }
});
