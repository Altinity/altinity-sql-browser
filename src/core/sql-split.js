// Pure client-side SQL script splitter. ClickHouse's HTTP interface runs exactly
// one statement per request, so to run a `;`-separated script (DDL / INSERT /
// SELECT) we split it here and POST each statement in turn (the same model as
// `clickhouse-client --multiquery`). Splitting is purely lexical: it skips `;`
// inside '…' / "…" / `…` literals (honoring both `\'` backslash and `''` doubled
// escapes) and inside -- / # line comments and /* */ block comments.
//
// Known limitation: `INSERT … FORMAT CSV\n<inline data>` whose inline data
// contains a `;` will mis-split — the splitter has no way to know where the
// format payload ends. Inline-data inserts should be run on their own.

/**
 * Split `sql` into individual statements on top-level `;`. Literals and comments
 * are scanned so their `;` (and quote/comment characters) don't break a
 * statement. Each returned statement is trimmed; comment-only / whitespace-only
 * fragments are dropped. A single statement (± a trailing `;`) yields a
 * one-element list, so the caller can preserve today's single-query path. Pure.
 */
export function splitStatements(sql) {
  const text = String(sql || '');
  const n = text.length;
  const out = [];
  let buf = '';
  let hasCode = false; // the current fragment holds runnable (non-comment) text
  let i = 0;
  const push = () => { if (hasCode) out.push(buf.trim()); buf = ''; hasCode = false; };
  while (i < n) {
    const c = text[i];
    const c2 = text[i + 1];
    // -- and # line comments: copy verbatim to end of line (not code).
    if ((c === '-' && c2 === '-') || c === '#') {
      let j = i;
      while (j < n && text[j] !== '\n') j++;
      buf += text.slice(i, j);
      i = j;
      continue;
    }
    // /* */ block comment (non-nesting, matching ClickHouse): copy verbatim.
    if (c === '/' && c2 === '*') {
      let j = i + 2;
      while (j < n && !(text[j] === '*' && text[j + 1] === '/')) j++;
      j = Math.min(n, j + 2); // include the closing */ (or run to EOF if unterminated)
      buf += text.slice(i, j);
      i = j;
      continue;
    }
    // '…' string, "…" / `…` quoted identifier. Backslash escapes the next char;
    // a doubled quote (`''`) is an escaped quote, not a terminator.
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      buf += c;
      let j = i + 1;
      while (j < n) {
        const d = text[j];
        if (d === '\\') { buf += text.slice(j, j + 2); j += 2; continue; }
        if (d === quote) {
          if (text[j + 1] === quote) { buf += d + quote; j += 2; continue; }
          buf += d; j += 1; break;
        }
        buf += d; j += 1;
      }
      i = j;
      hasCode = true;
      continue;
    }
    if (c === ';') { push(); i += 1; continue; }
    buf += c;
    if (!/\s/.test(c)) hasCode = true;
    i += 1;
  }
  push();
  return out;
}

// Statement keywords whose result is a row set (so script mode fetches them with
// a row-bearing format and shows a result preview). Everything else (CREATE /
// INSERT / ALTER / DROP / …) is run for effect and reported as OK.
const ROW_RETURNING = new Set([
  'SELECT', 'WITH', 'SHOW', 'DESC', 'DESCRIBE', 'EXISTS', 'VALUES', 'EXPLAIN',
]);

/** The first SQL keyword of `stmt`, uppercased, after skipping leading
 *  whitespace, -- / # / block comments, and `(` (so a parenthesized
 *  `(SELECT …) UNION …` is still recognized as row-returning). '' when none. Pure. */
export function leadingKeyword(stmt) {
  let s = String(stmt || '');
  for (;;) {
    const before = s;
    s = s.replace(/^\s+/, '')
      .replace(/^--[^\n]*/, '')
      .replace(/^#[^\n]*/, '')
      .replace(/^\/\*[\s\S]*?\*\//, '')
      .replace(/^\(+/, '');
    if (s === before) break;
  }
  const m = /^([A-Za-z]+)/.exec(s);
  return m ? m[1].toUpperCase() : '';
}

/** True when `stmt` is a row-returning statement (SELECT/WITH/SHOW/…). Pure. */
export function isRowReturning(stmt) {
  return ROW_RETURNING.has(leadingKeyword(stmt));
}

/**
 * True when `sql` is safe to auto-run on open (e.g. clicking a saved query): it
 * has at least one statement and **every** statement is row-returning. An
 * effectful statement (CREATE/ALTER/DROP/INSERT/…) anywhere makes it false, so
 * opening such a query loads it into the editor without executing it. Pure.
 */
export function isAutoRunnable(sql) {
  const stmts = splitStatements(sql);
  return stmts.length > 0 && stmts.every(isRowReturning);
}
