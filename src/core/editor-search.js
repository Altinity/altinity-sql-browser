// Pure find/replace matching for the in-editor search panel (#23). No DOM.

/**
 * All matches of `query` in `value`, in order, as [{start, end}]. Plain mode
 * escapes the query; regex mode compiles it directly. Whole-word fences the
 * pattern with `\b…\b` in BOTH modes (regex is wrapped in a non-capturing group
 * so the boundaries apply to the whole pattern). Case-insensitive unless
 * `caseSensitive`. An empty query or an invalid regex yields [] (the panel
 * surfaces the error separately). Zero-width matches (e.g. `a*`, `^`, `$`) are
 * skipped — they have no text to highlight or replace — while still advancing
 * the scan; the total is capped so a pathological pattern can't hang typing.
 */
export function findMatches(value, query, opts = {}) {
  if (!query) return [];
  const { caseSensitive = false, regex = false, wholeWord = false } = opts;
  let re;
  try {
    let pat = regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (wholeWord) pat = '\\b' + (regex ? '(?:' + pat + ')' : pat) + '\\b';
    re = new RegExp(pat, caseSensitive ? 'g' : 'gi');
  } catch {
    return [];
  }
  const matches = [];
  let m;
  let guard = 0;
  while ((m = re.exec(value)) !== null) {
    if (++guard > 10000) break;
    if (m.index === re.lastIndex) { re.lastIndex++; continue; } // skip zero-width, keep advancing
    matches.push({ start: m.index, end: m.index + m[0].length });
  }
  return matches;
}

/** Whether `query` is usable (only meaningful in regex mode). */
export function validRegex(query, regex) {
  if (!regex || !query) return true;
  try { new RegExp(query); return true; } catch { return false; }
}
