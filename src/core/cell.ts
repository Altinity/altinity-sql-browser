// Pure helpers for the cell-detail drawer. No DOM, no globals.

/** Heuristic: does the string look like an HTML/XML fragment worth rendering? */
export function looksLikeHtml(s: unknown): boolean {
  const str = String(s || '');
  return /<([a-z!][\s\S]*?)>/i.test(str) && /<\/[a-z]+\s*>|\/>/i.test(str);
}

/**
 * Heuristic: does the string carry a clear block-level Markdown signal worth a
 * rendered preview? Conservative on purpose — a false negative just leaves the
 * value showing as plain source. Checked only AFTER `looksLikeHtml` (HTML wins,
 * since an HTML fragment can incidentally contain `-`/`>` lines). Detects ATX
 * headings, list items (bullet or ordered), blockquotes, fenced code, thematic
 * breaks, and inline links; deliberately ignores lone `*`/`_` emphasis (too
 * ambiguous with ordinary prose/identifiers).
 */
export function looksLikeMarkdown(s: unknown): boolean {
  const str = String(s ?? '');
  if (!str.trim()) return false;
  return (
    /^\s{0,3}#{1,6}\s+\S/m.test(str)                 // # heading
    || /^\s{0,3}(?:[-*+]|\d{1,9}[.)])\s+\S/m.test(str) // - / 1. list item
    || /^\s{0,3}>\s/m.test(str)                       // > blockquote
    || /(?:^|\n)\s{0,3}(?:```|~~~)/.test(str)          // ``` fenced code
    || /^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/m.test(str) // --- thematic break
    || /\[[^\]\n]+\]\([^)\n]+\)/.test(str)             // [text](url) link
  );
}

/**
 * Pretty-print a cell value for the detail view: valid JSON is reindented;
 * anything else is returned as-is (coerced to string, null/undefined → '').
 */
export function prettyValue(s: unknown): string {
  if (s == null) return '';
  const str = String(s);
  const t = str.trim();
  if (t && (t[0] === '{' || t[0] === '[')) {
    try {
      return JSON.stringify(JSON.parse(t), null, 2);
    } catch {
      /* not JSON — fall through */
    }
  }
  return str;
}
