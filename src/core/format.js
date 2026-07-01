// Pure formatting + small string helpers. No DOM, no globals — trivially
// unit-testable and shared across the UI layer.

/** Clamp `v` into the inclusive range [lo, hi]. */
export function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Human-readable row count: 0..999 verbatim, then K/M/B with one decimal of
 * precision for the low end of each band. Returns '—' for null/NaN.
 */
export function formatRows(n) {
  if (n == null || Number.isNaN(Number(n))) return '—';
  n = Number(n);
  if (n < 1000) return String(n);
  if (n < 1e6) return (n / 1e3).toFixed(n < 1e4 ? 1 : 0) + 'K';
  if (n < 1e9) return (n / 1e6).toFixed(n < 1e7 ? 1 : 0) + 'M';
  return (n / 1e9).toFixed(n < 1e10 ? 1 : 0) + 'B';
}

/** Human-readable byte count (B/KB/MB/GB/TB). Returns '—' for null/NaN. */
export function formatBytes(n) {
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
export function timeAgo(ts, now = Date.now()) {
  const s = (now - ts) / 1000;
  if (s < 60) return Math.floor(s) + 's ago';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}

/** Quote + escape a string as a ClickHouse SQL string literal. */
export function sqlString(s) {
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
export function quoteIdent(name) {
  const s = String(name);
  if (BARE_IDENT.test(s)) return s;
  return '`' + s.replace(/\\/g, '\\\\').replace(/`/g, '\\`') + '`';
}

/**
 * Join already-separate identifier parts into a dotted reference, quoting each
 * part as needed: `qualifyIdent('db', 'a.b')` → `` db.`a.b` ``. Empty/nullish
 * parts are dropped (so a bare table name qualifies to just itself).
 */
export function qualifyIdent(...parts) {
  return parts.filter((p) => p != null && p !== '').map(quoteIdent).join('.');
}

/**
 * Inverse of `quoteIdent` for a single part: strip the surrounding backticks and
 * unescape `` \` `` / `\\` when `part` is backtick-quoted; bare names pass through.
 */
export function unquoteIdent(part) {
  const s = String(part);
  return s[0] === '`' ? s.slice(1, -1).replace(/\\(.)/g, '$1') : s;
}

/**
 * Terminate `sql` so a programmatic full-replace (Format / Insert DDL) leaves the
 * caret on empty space rather than at the end of the last token. The editor's
 * autocomplete needs ≥1 word char immediately before the caret, so without this
 * a freshly-formatted query pops an irrelevant dropdown on its trailing word.
 * Appends a single newline only when the text doesn't already end in whitespace
 * or ';'. Pure.
 */
export function withStatementBreak(sql) {
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
export function detectSqlFormat(sql) {
  const m = /\bFORMAT\s+([A-Za-z][A-Za-z0-9]*)\b(?:\s+SETTINGS\b[\s\S]*)?\s*;?\s*$/i.exec(String(sql || ''));
  return m ? m[1] : null;
}

/**
 * Resolve an editor query for a full (uncapped) export. If it already ends in
 * a `FORMAT <name>` clause (detectSqlFormat), the SQL is kept as-is and that
 * format is reported; otherwise `FORMAT TabSeparatedWithNames` is appended. A
 * trailing `;` is peeled either way (FORMAT must be the last clause). Empty
 * input → `{ sql: '', format: 'TabSeparatedWithNames' }` — the caller no-ops
 * on an empty `sql`. Pure.
 */
export function prepareExportSql(sql) {
  const s = String(sql || '').trim().replace(/;+\s*$/, '').trim();
  if (!s) return { sql: '', format: 'TabSeparatedWithNames' };
  const fmt = detectSqlFormat(s);
  return fmt
    ? { sql: s, format: fmt }
    : { sql: s + '\nFORMAT TabSeparatedWithNames', format: 'TabSeparatedWithNames' };
}

const SCHEMA_MUTATING_RE = /^(CREATE|DROP|ALTER|RENAME|TRUNCATE|ATTACH|DETACH|EXCHANGE)\b/i;

/**
 * True when `sql`'s first statement is a DDL keyword that can change the set
 * of databases/tables/columns (CREATE/DROP/ALTER/RENAME/TRUNCATE/ATTACH/
 * DETACH/EXCHANGE) — used to trigger a schema-tree reload after a run. Leading
 * whitespace/comments are skipped. Pure.
 */
export function isSchemaMutatingSql(sql) {
  const s = String(sql || '').replace(/^(\s|--[^\n]*\n|\/\*[\s\S]*?\*\/)+/, '').trim();
  return SCHEMA_MUTATING_RE.test(s);
}

/**
 * Derive a short display name for a saved query: "Query · <table>" when a
 * FROM clause is present, else the first 48 chars of the collapsed SQL.
 */
export function inferQueryName(sql) {
  const s = String(sql).replace(/\s+/g, ' ').trim();
  const m = /\bFROM\s+([A-Za-z_][\w.`"]*)/i.exec(s);
  if (m) return 'Query · ' + m[1].replace(/[`"]/g, '');
  return s.length > 48 ? s.slice(0, 45) + '…' : s;
}

/**
 * Wrap a query's SQL as a parenthesized subquery for dropping into the editor.
 * Strips what can't live inside `()` — a trailing `;` and a trailing `FORMAT
 * <name>` clause (FORMAT must be a statement's last clause) — then brackets it on
 * its own lines. Empty/whitespace input → '' (caller inserts nothing). Pure.
 */
export function toSubquery(sql) {
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
export function isNumericType(type) {
  return /^(U?Int|Float|Decimal)/.test(type || '');
}

/**
 * Short form of a ClickHouse version for the header: the first three
 * dot-segments (e.g. '26.3.10.20001.altinityantalya' → '26.3.10'). The full
 * string is shown on hover. Empty/short inputs pass through unchanged.
 */
export function shortVersion(v) {
  const parts = String(v || '').split('.');
  return parts.length > 3 ? parts.slice(0, 3).join('.') : String(v || '');
}

/**
 * True when `v` (a ClickHouse version string) is >= 26.3, the release that
 * added EXPLAIN's `pretty`/`compact` settings. Malformed/empty input → false.
 */
export function supportsExplainPretty(v) {
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
export function userShortName(email) {
  const s = String(email || '');
  const at = s.indexOf('@');
  return at > 0 ? s.slice(0, at) : s;
}
