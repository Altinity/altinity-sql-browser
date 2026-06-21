// Pure helpers for the cell-detail drawer. No DOM, no globals.

/** Heuristic: does the string look like an HTML/XML fragment worth rendering? */
export function looksLikeHtml(s) {
  const str = String(s || '');
  return /<([a-z!][\s\S]*?)>/i.test(str) && /<\/[a-z]+\s*>|\/>/i.test(str);
}

/**
 * Pretty-print a cell value for the detail view: valid JSON is reindented;
 * anything else is returned as-is (coerced to string, null/undefined → '').
 */
export function prettyValue(s) {
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
