/**
 * Job ads arrive as HTML. Turn them into readable plain text: paragraphs and
 * list items on their own lines, tags gone, entities decoded. Not a full HTML
 * parser; good enough for ad text.
 */

const NAMED: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—",
  hellip: "…", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", bull: "•", middot: "·",
  pound: "£", euro: "€", copy: "©", reg: "®", trade: "™",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? Number.parseInt(e.slice(2), 16) : Number.parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

export function htmlToText(html: string): string {
  // Some sources escape the HTML once more (Greenhouse: "&lt;p&gt;"). Undo that first.
  const src = /<[a-z!/]/i.test(html) ? html : decodeEntities(html);
  const text = src
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<br\b[^>]*>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<\/li>/gi, "")
    .replace(/<\/?(p|div|section|ul|ol|h[1-6]|tr|table|blockquote)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "");
  return decodeEntities(text)
    .replace(/[ \t\u00a0]+/g, " ")
    .split("\n")
    .map((l) => l.trim())
    .join("\n")
    // A list item that opens with a paragraph (<li><p>…) keeps its text on the bullet's line.
    .replace(/^-\n+/gm, "- ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
