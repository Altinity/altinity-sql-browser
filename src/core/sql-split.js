// Pure client-side SQL script splitter. ClickHouse's HTTP interface runs exactly
// one statement per request, so to run a `;`-separated script (DDL / INSERT /
// SELECT) we split it here and POST each statement in turn (the same model as
// `clickhouse-client --multiquery`). Splitting is purely lexical: it skips `;`
// inside '…' / "…" / `…` literals (honoring both `\'` backslash and `''` doubled
// escapes) and inside -- / # line comments and /* */ block comments. The literal
// /comment lexing lives in the shared scanner (sql-spans.js), used by both this
// splitter and query-params.js so the tokenizing rules can't diverge.
//
// Known limitation: `INSERT … FORMAT CSV\n<inline data>` whose inline data
// contains a `;` will mis-split — the splitter has no way to know where the
// format payload ends. Inline-data inserts should be run on their own.

import { scanSpans } from './sql-spans.js';

/**
 * Split `sql` into individual statements on top-level `;`. Literals and comments
 * are scanned so their `;` (and quote/comment characters) don't break a
 * statement. Each returned statement is trimmed; comment-only / whitespace-only
 * fragments are dropped. A single statement (± a trailing `;`) yields a
 * one-element list, so the caller can preserve today's single-query path. Pure.
 */
export function splitStatements(sql) {
  const text = String(sql || '');
  const out = [];
  let buf = '';
  let hasCode = false; // the current fragment holds runnable (non-comment) text
  const push = () => { if (hasCode) out.push(buf.trim()); buf = ''; hasCode = false; };
  for (const span of scanSpans(text)) {
    const chunk = text.slice(span.start, span.end);
    // Comments and literals are copied verbatim (a `;` inside them is not a
    // separator). A literal is runnable text (sets hasCode); a comment is not.
    if (span.kind === 'comment') { buf += chunk; continue; }
    if (span.kind === 'string') { buf += chunk; hasCode = true; continue; }
    // Code: split on top-level `;`; other non-whitespace marks the fragment
    // as runnable so a comment-only fragment is dropped.
    for (let k = 0; k < chunk.length; k++) {
      const c = chunk[k];
      if (c === ';') { push(); continue; }
      buf += c;
      if (!/\s/.test(c)) hasCode = true;
    }
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
