import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const build = fileURLToPath(new URL("../scripts/build-docs-site.mjs", import.meta.url));

test("built docs keep anchors, links, tables and code without trusting raw markup", () => {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-docs-"));
  try {
    mkdirSync(join(root, "docs/repair"), { recursive: true });
    writeFileSync(
      join(root, "docs/repair/README.md"),
      [
        "# Repair",
        "",
        "## Use \u0060plan\u0060 & check",
        "",
        "[Start](../scheduler.md#setup) and [bad](javascript:bad)",
        "",
        '<img src="/private" onerror="bad()">',
        "",
        "### Results",
        "",
        "| Status | Count |",
        "| --- | ---: |",
        "| Good | 1 |",
        "",
        "~~~sh",
        "printf '<b>sample</b>'",
        "~~~",
      ].join("\n"),
    );
    execFileSync(process.execPath, [build], { cwd: root });
    const html = readFileSync(join(root, "dist/docs-site/repair/index.html"), "utf8");
    const article = html.slice(html.indexOf('<article class="doc">'), html.indexOf("</article>"));
    assert.doesNotMatch(article, /href="javascript:|<img|onerror=/);
    assert.match(article, /<h2 id="use-plan-check">/);
    assert.match(html, /<a class="toc-l2" href="#use-plan-check">Use plan &amp; check<\/a>/);
    assert.match(article, /href="\.\.\/scheduler\.html#setup"/);
    assert.match(article, /<table[\s>]/);
    assert.match(article, /<td[^>]*>1<\/td>/);
    assert.match(article, /<pre[^>]*><code[^>]*class="language-sh"/);
    assert.match(article, /&lt;b&gt;sample&lt;\/b&gt;/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
