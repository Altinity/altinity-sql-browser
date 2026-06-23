// Pure find/replace matching for the in-editor search panel (#23). No DOM.

/**
 * All matches of `query` in `value`, in order, as [{start, end}]. Plain mode
 * escapes the query (optionally fenced by `\b` word boundaries); regex mode
 * compiles it directly. Case-insensitive unless `caseSensitive`. An empty query
 * or an invalid regex yields [] (the panel surfaces the error separately). A
 * zero-width match advances by one so the scan can't loop forever, and the
 * total is capped so a pathological pattern can't hang the keystroke path.
 */
export function findMatches(value, query, opts = {}) {
  if (!query) return [];
  const { caseSensitive = false, regex = false, wholeWord = false } = opts;
  let re;
  try {
    if (regex) {
      re = new RegExp(query, caseSensitive ? 'g' : 'gi');
    } else {
      let pat = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (wholeWord) pat = '\\b' + pat + '\\b';
      re = new RegExp(pat, caseSensitive ? 'g' : 'gi');
    }
  } catch {
    return [];
  }
  const matches = [];
  let m;
  let guard = 0;
  while ((m = re.exec(value)) !== null) {
    if (m.index === re.lastIndex) re.lastIndex++; // zero-width guard
    matches.push({ start: m.index, end: m.index + m[0].length });
    if (++guard > 10000) break;
  }
  return matches;
}

/** Whether `query` is usable (only meaningful in regex mode). */
export function validRegex(query, regex) {
  if (!regex || !query) return true;
  try { new RegExp(query); return true; } catch { return false; }
}
