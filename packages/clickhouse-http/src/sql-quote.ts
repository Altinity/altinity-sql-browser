// Issue #630 Phase 5 — ClickHouse SQL string-literal/identifier quoting,
// moved verbatim from SQL Browser's `src/core/format.ts` into
// `@altinity/clickhouse-http`, alongside the generic type grammar. This is
// the ONE quoting implementation: `format.ts` no longer declares
// `sqlString`/`quoteIdent`/`qualifyIdent`/`BARE_IDENT` at all, and every real
// consumer (SQL Browser `src/**`, and this package's own
// `client.ts::killQuery`) imports from here (directly, or through this
// package's public "." export).

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
