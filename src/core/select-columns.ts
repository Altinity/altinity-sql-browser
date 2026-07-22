// Pure, dependency-free extraction of the CONFIDENTLY-named top-level output
// columns of the FIRST/outermost SELECT of a SQL string (#189/#364). Used to
// auto-bind a favorited `filter`-role saved query to a Dashboard filter by
// matching an output column NAME to a parameter name (see
// `ui/dashboard.ts#synthesizeImplicitFilters`). It is deliberately conservative:
// it never guesses a name for an unaliased expression, never leaks an `AS` from
// inside a subquery/function, and never throws on malformed SQL — it returns
// only the names it can confidently derive (possibly `[]`).
//
// This is a lexical, not a semantic, parser: it walks the string once, tracking
// paren depth and string/quote state, so keywords and commas that live inside
// strings, backticks, or nested parentheses are never mistaken for structure.
// Word-boundary matching (whole runs of identifier chars) keeps
// `fromUnixTimestamp(...)` or a column named with an embedded keyword from being
// read as a clause keyword.

const IDENT = /[\w$]/;
const IDENT_HEAD = /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/;

// Top-level clause keywords that terminate the projection list when there is no
// FROM (or before it). Word-boundary matched, case-insensitive.
const CLAUSE = new Set(['FROM', 'WHERE', 'GROUP', 'ORDER', 'HAVING', 'LIMIT', 'SETTINGS', 'UNION']);

interface TopWord { word: string; end: number; }

/** Single lexical pass: collect the uppercase text + end index of every
 *  identifier-run AND the index of every comma that sits at paren depth 0 and
 *  outside any '…'/"…"/`…` quote. Depth->0 / in-quote tokens are never
 *  recorded, so callers see only top-level structure. */
function scanTopLevel(s: string): { words: TopWord[]; commas: number[] } {
  const words: TopWord[] = [];
  const commas: number[] = [];
  let depth = 0;
  let quote = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s[i];
    if (quote) {
      if (c === quote) quote = '';
      i++;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; i++; continue; }
    if (c === '(') { depth++; i++; continue; }
    if (c === ')') { depth--; i++; continue; }
    if (c === ',') { if (depth === 0) commas.push(i); i++; continue; }
    if (IDENT.test(c)) {
      let j = i;
      while (j < n && IDENT.test(s[j])) j++;
      if (depth === 0) words.push({ word: s.slice(i, j).toUpperCase(), end: j });
      i = j;
      continue;
    }
    i++;
  }
  return { words, commas };
}

/** The identifier token starting at/after `pos` in `s`: a backticked/double-
 *  quoted name (returned unquoted) or a bare identifier run. `null` when none
 *  (end of string, an unclosed quote, an empty quoted name, or a non-identifier
 *  such as a number). */
function identifierAt(s: string, pos: number): string | null {
  let i = pos;
  while (i < s.length && /\s/.test(s[i])) i++;
  if (i >= s.length) return null;
  const c = s[i];
  if (c === '`' || c === '"') {
    const close = s.indexOf(c, i + 1);
    if (close < 0) return null;
    return s.slice(i + 1, close) || null;
  }
  const m = /^[A-Za-z_$][\w$]*/.exec(s.slice(i));
  return m ? m[0] : null;
}

/** A whole projection item that is nothing but a bare identifier: a dotted word
 *  (last segment taken) or a backticked/double-quoted identifier (unquoted).
 *  `null` for an expression, `*`, `t.*`, a number, etc. */
function bareIdentifier(item: string): string | null {
  let m = /^`([^`]*)`$/.exec(item);
  if (m) return m[1] || null;
  m = /^"([^"]*)"$/.exec(item);
  if (m) return m[1] || null;
  if (IDENT_HEAD.test(item)) {
    const segs = item.split('.');
    return segs[segs.length - 1];
  }
  return null;
}

/** The confidently-derived output name of one projection item, or `null`. */
function deriveName(item: string): string | null {
  if (!item) return null;
  const { words } = scanTopLevel(item);
  let asEnd = -1;
  for (const w of words) if (w.word === 'AS') asEnd = w.end;
  if (asEnd >= 0) return identifierAt(item, asEnd);
  return bareIdentifier(item);
}

/** The confidently-named top-level output columns of the first/outermost SELECT
 *  in `sql`, in order. Unaliased expressions, `*`, and anything ambiguous
 *  contribute no name. Never throws — returns `[]` (or a partial list) on
 *  malformed input. */
export function selectOutputColumns(sql: string | null | undefined): string[] {
  if (!sql) return [];
  const scan = scanTopLevel(sql);
  const selIdx = scan.words.findIndex((w) => w.word === 'SELECT');
  if (selIdx < 0) return [];
  const selectEnd = scan.words[selIdx].end;
  let projEnd = sql.length;
  for (let k = selIdx + 1; k < scan.words.length; k++) {
    if (CLAUSE.has(scan.words[k].word)) { projEnd = scan.words[k].end - scan.words[k].word.length; break; }
  }
  const projection = sql.slice(selectEnd, projEnd).replace(/^\s*distinct\b/i, '');
  const names: string[] = [];
  const { commas } = scanTopLevel(projection);
  let start = 0;
  const bounds = [...commas, projection.length];
  for (const idx of bounds) {
    const name = deriveName(projection.slice(start, idx).trim());
    if (name) names.push(name);
    start = idx + 1;
  }
  return names;
}
