// Shared HTML helpers for normalization (Decision 6: store description_html for display
// + description_plain for classification/search).
//
// NOTE: these are basic, dependency-free implementations meant to be correct for the
// common cases (Greenhouse in particular returns `content` HTML-entity-encoded). If edge
// cases bite (obscure entities, malformed markup), consider a vetted library like `he`
// for entities and a real sanitizer for the display HTML — that's a dependency decision
// to make deliberately, not silently.

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

// Decode HTML entities (named + numeric decimal/hex) to their characters.
export function decodeHtmlEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body: string) => {
    if (body[0] === "#") {
      const codePoint =
        body[1] === "x" || body[1] === "X"
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10);
      return Number.isNaN(codePoint) ? match : String.fromCodePoint(codePoint);
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

// Convert HTML to plain text. Block-level tags become whitespace so adjacent items don't
// glue together (Decision 6 — "degree" + "Graduating" must not become "degreeGraduating"),
// then remaining tags are stripped and entities decoded.
export function htmlToPlain(html: string): string {
  const withBreaks = html
    .replace(/<\s*(br|\/p|\/li|\/div|\/h[1-6]|\/tr)\s*\/?>/gi, "\n")
    .replace(/<\s*(li|p|div|tr|h[1-6])\b[^>]*>/gi, "\n");
  const noTags = withBreaks.replace(/<[^>]+>/g, " ");
  return decodeHtmlEntities(noTags)
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*/g, "\n\n")
    .trim();
}
