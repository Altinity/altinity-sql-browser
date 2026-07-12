// Pure client-side SQL script splitter. ClickHouse's HTTP interface runs exactly
// one statement per request, so to run a `;`-separated script (DDL / INSERT /
// SELECT) we split it here and POST each statement in turn (the same model as
// `clickhouse-client --multiquery`). Splitting is purely lexical: it skips `;`
// inside '…' strings and heredocs, "…" / `…` quoted identifiers, and
// -- / # / // line comments and nested /* */ block comments — all classified by
// the shared scanner (sql-spans.js, #182), used by every string-based analyzer
// so the lexical rules can't diverge.
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
    // separator). A string/heredoc or a quoted identifier is runnable text
    // (sets hasCode); a comment is not. Treating quoted-ident like string keeps
    // ``SELECT `a;b` `` one statement (#182).
    if (span.kind === 'comment') { buf += chunk; continue; }
    if (span.kind === 'string' || span.kind === 'quoted-ident') { buf += chunk; hasCode = true; continue; }
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
 *  whitespace, closed -- / # / // / nested-block comments, and `(` (so a
 *  parenthesized `(SELECT …) UNION …` is still recognized as row-returning),
 *  using the shared scanner (#182). Comments may sit among the leading
 *  parentheses. Returns '' when the first real code construct is not an ASCII
 *  word — so `#x\nCREATE …` (`#x` is *not* a comment) yields '', never CREATE.
 *  Also the shared first-code-word helper behind `format.js::isSchemaMutatingSql`.
 *  Pure. */
export function leadingKeyword(stmt) {
  const s = String(stmt || '');
  for (const span of scanSpans(s)) {
    if (span.kind === 'comment') {
      if (span.closed) continue; // skip a closed leading comment of any form
      return ''; // an unterminated comment leads no runnable code
    }
    if (span.kind !== 'code') return ''; // a leading string/quoted-ident is not a keyword
    // Code span: skip leading whitespace and `(`, then read the first ASCII word.
    let k = span.start;
    while (k < span.end && (/\s/.test(s[k]) || s[k] === '(')) k += 1;
    if (k >= span.end) continue; // this code span was only whitespace/parens
    if (!/[A-Za-z]/.test(s[k])) return ''; // first real construct isn't a word
    let e = k;
    while (e < span.end && /[A-Za-z]/.test(s[e])) e += 1;
    return s.slice(k, e).toUpperCase();
  }
  return '';
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
