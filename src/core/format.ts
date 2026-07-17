// Pure formatting + small string helpers. No DOM, no globals — trivially
// unit-testable and shared across the UI layer.

import { scanSpans } from './sql-spans.js';
import { leadingKeyword } from './sql-split.js';

/** Clamp `v` into the inclusive range [lo, hi]. */
export function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Human-readable row count: 0..999 verbatim, then K/M/B with one decimal of
 * precision for the low end of each band. Returns '—' for null/NaN.
 */
export function formatRows(n: number | null | undefined): string {
  if (n == null || Number.isNaN(Number(n))) return '—';
  n = Number(n);
  if (n < 1000) return String(n);
  if (n < 1e6) return (n / 1e3).toFixed(n < 1e4 ? 1 : 0) + 'K';
  if (n < 1e9) return (n / 1e6).toFixed(n < 1e7 ? 1 : 0) + 'M';
  return (n / 1e9).toFixed(n < 1e10 ? 1 : 0) + 'B';
}

/**
 * Truncate `str` to `max` chars, replacing the cut-off tail with a single '…'
 * (so the result is exactly `max` chars long when truncated, for any `max >= 1`
 * — `max <= 0` collapses to just '…', never a string longer than the input
 * would need). Short strings pass through unchanged.
 */
export function truncate(str: unknown, max: number): string {
  const s = String(str == null ? '' : str);
  return s.length > max ? s.slice(0, Math.max(0, max - 1)) + '…' : s;
}

/**
 * How much of a column's on-disk footprint compression left behind:
 * `(compressed/uncompressed) * 100`, rounded to the nearest integer and
 * suffixed '%' — e.g. a column compressed to a quarter of its raw size reads
 * '25%'. Returns '—' when `uncompressed` is 0/null/NaN (nothing to divide by
 * — e.g. an empty table) or `compressed` isn't a number.
 */
export function formatCompressionRatio(compressed: unknown, uncompressed: unknown): string {
  const c = Number(compressed);
  const u = Number(uncompressed);
  if (!u || compressed == null || Number.isNaN(c)) return '—';
  return Math.round((c / u) * 100) + '%';
}

/** Human-readable byte count (B/KB/MB/GB/TB). Returns '—' for null/NaN. */
export function formatBytes(n: number | null | undefined): string {
  if (n == null || Number.isNaN(Number(n))) return '—';
  n = Number(n);
  if (n < 1024) return n + ' B';
  if (n < 1024 ** 2) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 ** 3) return (n / 1024 ** 2).toFixed(1) + ' MB';
  if (n < 1024 ** 4) return (n / 1024 ** 3).toFixed(2) + ' GB';
  return (n / 1024 ** 4).toFixed(2) + ' TB';
}

/**
 * Relative time label ("12s ago", "3m ago", "5h ago", "2d ago").
 * `now` is injectable for deterministic tests.
 */
export function timeAgo(ts: number, now: number = Date.now()): string {
  const s = (now - ts) / 1000;
  if (s < 60) return Math.floor(s) + 's ago';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}

/** Quote + escape a string as a ClickHouse SQL string literal. */
export function sqlString(s: unknown): string {
  // Escape the backslash first (CH honors backslash escapes in string literals,
  // so a trailing `\` would otherwise escape the closing quote and break out),
  // then double the single quote.
  return "'" + String(s).replace(/\\/g, '\\\\').replace(/'/g, "''") + "'";
}

// A bare (unquoted) ClickHouse identifier: a letter/underscore then word chars.
// Anything else (dashes, dots, spaces — e.g. a `…snappy.parquet` table) MUST be
// backtick-quoted or it's a syntax error.
const BARE_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Quote `name` as a ClickHouse identifier when it isn't a bare identifier:
 * backticks, with `\` and `` ` `` backslash-escaped (CH's identifier escaping).
 * Bare identifiers pass through unquoted so ordinary SQL stays readable.
 */
export function quoteIdent(name: unknown): string {
  const s = String(name);
  if (BARE_IDENT.test(s)) return s;
  return '`' + s.replace(/\\/g, '\\\\').replace(/`/g, '\\`') + '`';
}

/**
 * Join already-separate identifier parts into a dotted reference, quoting each
 * part as needed: `qualifyIdent('db', 'a.b')` → `` db.`a.b` ``. Empty/nullish
 * parts are dropped (so a bare table name qualifies to just itself).
 */
export function qualifyIdent(...parts: unknown[]): string {
  return parts.filter((p) => p != null && p !== '').map(quoteIdent).join('.');
}

/**
 * Terminate `sql` so a programmatic full-replace (Format / Insert DDL) leaves the
 * caret on empty space rather than at the end of the last token. The editor's
 * autocomplete needs ≥1 word char immediately before the caret, so without this
 * a freshly-formatted query pops an irrelevant dropdown on its trailing word.
 * Appends a single newline only when the text doesn't already end in whitespace
 * or ';'. Pure.
 */
export function withStatementBreak(sql?: string | null): string {
  const s = String(sql || '');
  return s === '' || /[\s;]$/.test(s) ? s : s + '\n';
}

/**
 * The trailing `FORMAT <Name>` clause of a query, or null. FORMAT and SETTINGS
 * are ClickHouse's two clauses that may trail a query in *either* order (its
 * parser explicitly allows `FORMAT x SETTINGS y` and `SETTINGS y FORMAT x`), so
 * a FORMAT immediately followed by a SETTINGS clause still counts as trailing.
 * Lets the results panel switch to raw passthrough when the user picks an
 * output format from their own SQL (e.g. `… FORMAT Pretty` / `FORMAT CSV`, with
 * or without a following `SETTINGS …`). Pure.
 */
export function detectSqlFormat(sql?: string | null): string | null {
  const text = String(sql || '');
  const words: string[] = [];
  let depth = 0;
  for (const span of scanSpans(text)) {
    if (span.kind !== 'code') continue;
    const code = text.slice(span.start, span.end);
    for (let i = 0; i < code.length;) {
      const ch = code[i];
      if (ch === '(') { depth++; i++; continue; }
      if (ch === ')') { depth = Math.max(0, depth - 1); i++; continue; }
      if (depth === 0 && /[A-Za-z_]/.test(ch)) {
        let end = i + 1;
        while (end < code.length && /[A-Za-z0-9_]/.test(code[end])) end++;
        words.push(code.slice(i, end)); i = end; continue;
      }
      i++;
    }
  }
  for (let i = words.length - 2; i >= 0; i--) {
    if (words[i].toUpperCase() !== 'FORMAT') continue;
    const rest = words.slice(i + 2);
    if (rest.length === 0 || rest[0].toUpperCase() === 'SETTINGS') return words[i + 1];
  }
  return null;
}

/**
 * Strip a trailing run of trivia from `sql`: whitespace, **closed** comment
 * spans (`--` / `#` / `//` / nested `/* *​/`, in any order, including comments
 * that follow a `;`), and statement-terminating `;` in code — using one
 * `scanSpans()` pass and a backward walk over the spans (#182), never a
 * repeated full-string rescan. An **unterminated** block comment is left in
 * place: stripping it could silently turn malformed SQL into a valid query.
 * Semicolons and comment characters inside strings/identifiers/heredocs are
 * never inspected, because the scanner already made those spans opaque. Pure.
 */
function stripTrailingTrivia(text: string): string {
  const spans = [...scanSpans(text)];
  let end = text.length;
  for (let si = spans.length - 1; si >= 0;) {
    const sp = spans[si];
    if (sp.start >= end) { si -= 1; continue; }
    if (sp.kind === 'comment') {
      if (!sp.closed) break;      // never strip an unterminated comment
      end = sp.start; si -= 1; continue;
    }
    if (sp.kind === 'code') {
      let e = Math.min(sp.end, end);
      for (;;) {
        while (e > sp.start && /\s/.test(text[e - 1])) e -= 1;
        if (e > sp.start && text[e - 1] === ';') { e -= 1; continue; }
        break;
      }
      if (e > sp.start) { end = e; break; } // real code remains
      end = sp.start; si -= 1; continue;    // span was only whitespace/`;`
    }
    break; // a string / quoted-ident is real content — stop
  }
  return text.slice(0, end);
}

/** `withTrailingFormat`'s result: the (possibly comment/`;`-trimmed and
 *  FORMAT-completed) SQL, and the format it will run/export under. */
export interface TrailingFormatResult {
  sql: string;
  format: string;
}

/**
 * Peel a trailing `;` and any trailing **closed** SQL comments (line
 * `-- …` / `# …` / `// …`, nested block `/* … *​/`, incl. after a `;`) from
 * `sql`, then resolve its output format: if what remains already ends in a
 * `FORMAT <name>` clause (detectSqlFormat) that format is kept and reported;
 * otherwise `fallbackFormat` is appended. Comments are peeled *before* the
 * check so a `… FORMAT JSON // note` isn't mis-read as unformatted (which would
 * double the FORMAT) and so an appended clause lands after real SQL rather than
 * after a line comment that would swallow it. An unterminated trailing block
 * comment is *not* stripped (see `stripTrailingTrivia`). Empty input → `{ sql:
 * '', format: fallbackFormat }` (nothing is appended to an empty query). Pure —
 * shared by the export prep and the dashboard tile fetch so this edge handling
 * lives in one place.
 */
export function withTrailingFormat(sql: string | null | undefined, fallbackFormat: string): TrailingFormatResult {
  const s = stripTrailingTrivia(String(sql || '')).replace(/^\s+/, '');
  const fmt = detectSqlFormat(s);
  if (fmt) return { sql: s, format: fmt };
  return { sql: s ? s + '\nFORMAT ' + fallbackFormat : s, format: fallbackFormat };
}

/**
 * Resolve an editor query for a full (uncapped) export: its own trailing
 * `FORMAT`, or `FORMAT TabSeparatedWithNames`. See `withTrailingFormat`. Empty
 * input → `{ sql: '', format: 'TabSeparatedWithNames' }` — the caller no-ops on
 * an empty `sql`. Pure.
 */
export function prepareExportSql(sql: string | null | undefined): TrailingFormatResult {
  return withTrailingFormat(sql, 'TabSeparatedWithNames');
}

const SCHEMA_MUTATING = new Set([
  'CREATE', 'DROP', 'ALTER', 'RENAME', 'TRUNCATE', 'ATTACH', 'DETACH', 'EXCHANGE',
]);

/**
 * True when `sql`'s first statement is a DDL keyword that can change the set
 * of databases/tables/columns (CREATE/DROP/ALTER/RENAME/TRUNCATE/ATTACH/
 * DETACH/EXCHANGE) — used to trigger a schema-tree reload after a run. Leading
 * whitespace and every supported closed comment form (`--` / `#` / `//` /
 * nested block) are skipped through the shared `leadingKeyword()` helper (#182),
 * so DDL after any of them still refreshes the schema, while an invalid `#x`
 * (not a comment) correctly does not. Pure.
 */
export function isSchemaMutatingSql(sql?: string | null): boolean {
  return SCHEMA_MUTATING.has(leadingKeyword(sql));
}

/**
 * Derive a short display name for a saved query: "Query · <table>" when a
 * FROM clause is present, else the first 48 chars of the collapsed SQL.
 */
export function inferQueryName(sql: string): string {
  const s = String(sql).replace(/\s+/g, ' ').trim();
  const m = /\bFROM\s+([A-Za-z_][\w.`"]*)/i.exec(s);
  if (m) return 'Query · ' + m[1].replace(/[`"]/g, '');
  return truncate(s, 48);
}

/**
 * Wrap a query's SQL as a parenthesized subquery for dropping into the editor.
 * Strips what can't live inside `()` — a trailing `;` and a trailing `FORMAT
 * <name>` clause (FORMAT must be a statement's last clause) — then brackets it on
 * its own lines. Empty/whitespace input → '' (caller inserts nothing). Pure.
 */
export function toSubquery(sql?: string | null): string {
  let s = String(sql || '').trim();
  // Peel trailing `;` and `FORMAT <name>` clauses (either order, repeated) — both
  // are invalid inside a subquery. A trailing comment after FORMAT is left as-is
  // (rare; degrades to a visible SQL error rather than silently dropping a note).
  let prev;
  do {
    prev = s;
    s = s.replace(/;+\s*$/, '').replace(/\bFORMAT\s+[A-Za-z][A-Za-z0-9]*\s*$/i, '').trim();
  } while (s !== prev);
  return s ? '(\n' + s + '\n)' : '';
}

/** True for ClickHouse numeric column types (Int/UInt/Float/Decimal). */
export function isNumericType(type?: string | null): boolean {
  return /^(U?Int|Float|Decimal)/.test(type || '');
}

/**
 * Short form of a ClickHouse version for the header: the first three
 * dot-segments (e.g. '26.3.10.20001.altinityantalya' → '26.3.10'). The full
 * string is shown on hover. Empty/short inputs pass through unchanged.
 */
export function shortVersion(v?: string | null): string {
  const parts = String(v || '').split('.');
  return parts.length > 3 ? parts.slice(0, 3).join('.') : String(v || '');
}

/**
 * True when `v` (a ClickHouse version string) is >= 26.3, the release that
 * added EXPLAIN's `pretty`/`compact` settings. Malformed/empty input → false.
 */
export function supportsExplainPretty(v?: string | null): boolean {
  const m = /^(\d+)\.(\d+)/.exec(String(v || ''));
  if (!m) return false;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  return major > 26 || (major === 26 && minor >= 3);
}

/**
 * Short display name for the header user control: the local-part of an email
 * (before '@'). Falls back to the whole string when there's no '@', and '' for
 * empty/nullish input.
 */
export function userShortName(email?: string | null): string {
  const s = String(email || '');
  const at = s.indexOf('@');
  return at > 0 ? s.slice(0, at) : s;
}
