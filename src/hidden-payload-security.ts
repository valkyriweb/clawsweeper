import MarkdownIt from "markdown-it";

const markdown = new MarkdownIt("commonmark", { html: true });
const PAYLOAD_SUMMARY =
  "Concealed shell payload in the item or discussion requires human security moderation; do not execute it.";

export function hiddenPayloadSecurityReview(sources: readonly string[]) {
  for (const source of sources) {
    if (!source.includes("<!--")) continue;
    const tokens = markdown.parse(source.slice(0, 131_072), {});
    const html = tokens
      .flatMap((token) => [token, ...(token.children ?? [])])
      .filter((token) => token.type === "html_block" || token.type === "html_inline");
    for (const token of html) {
      for (const match of token.content.matchAll(/<!--[\s\S]*?(?:-->|$)/g)) {
        const hidden = match[0];
        // False positives only keep items open. Tool-free loaders remain out of scope.
        const network = /\b(?:curl|wget|nc|ncat|netcat)\b|\/dev\/(?:tcp|udp)\//i.test(hidden);
        const environment = /\b(?:env|printenv)\b|\/proc\/(?:self|\d+)\/environ/i.test(hidden);
        if (!network && !(environment && /\bbase64\b/i.test(hidden))) continue;
        return {
          status: "needs_attention" as const,
          summary: PAYLOAD_SUMMARY,
          concerns: [
            {
              title: "Moderate concealed shell payload",
              body: PAYLOAD_SUMMARY,
              severity: "high" as const,
              confidenceScore: 0.99,
              file: null,
              line: null,
            },
          ],
        };
      }
    }
  }
  return undefined;
}
