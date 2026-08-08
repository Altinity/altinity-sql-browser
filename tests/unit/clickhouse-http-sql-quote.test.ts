// Issue #630 Phase 5 — moved from tests/unit/format.test.ts: SQL Browser's
// one ClickHouse SQL-quoting implementation now lives in
// `@altinity/clickhouse-http` (`sql-quote.ts`), so its test corpus targets
// the package's public "." export directly. Every expected literal below is
// authored by hand, never derived from the production helper under test.
import { describe, it, expect } from 'vitest';
import { sqlString, quoteIdent, qualifyIdent } from '@altinity/clickhouse-http';

describe('sqlString', () => {
  it('quotes and doubles single quotes', () => {
    expect(sqlString('abc')).toBe("'abc'");
    expect(sqlString("a'b")).toBe("'a''b'");
    expect(sqlString(42)).toBe("'42'");
  });
  it('escapes backslashes so a trailing one cannot break out of the literal', () => {
    expect(sqlString('a\\b')).toBe("'a\\\\b'");
    expect(sqlString('x\\')).toBe("'x\\\\'");
    expect(sqlString("\\'")).toBe("'\\\\'''");
  });
  it('quotes an empty string', () => {
    expect(sqlString('')).toBe("''");
  });
  it('doubles repeated/adjacent single quotes', () => {
    expect(sqlString("''")).toBe("''''''");
    expect(sqlString("a''b")).toBe("'a''''b'");
  });
  it('doubles a trailing run of repeated backslashes', () => {
    expect(sqlString('a\\\\')).toBe("'a\\\\\\\\'");
    expect(sqlString('\\\\\\')).toBe("'\\\\\\\\\\\\'");
  });
  it('handles a mixed quote/backslash sequence in the order backslash-first, then quote', () => {
    expect(sqlString("\\'a\\'")).toBe("'\\\\''a\\\\'''");
  });
  it('coerces already-supported non-string values', () => {
    expect(sqlString(null)).toBe("'null'");
    expect(sqlString(undefined)).toBe("'undefined'");
    expect(sqlString(true)).toBe("'true'");
    expect(sqlString(0)).toBe("'0'");
  });
});

describe('quoteIdent', () => {
  it('leaves a bare identifier unquoted', () => {
    expect(quoteIdent('users')).toBe('users');
    expect(quoteIdent('_x9')).toBe('_x9');
  });
  it('backtick-quotes names with non-identifier chars', () => {
    expect(quoteIdent('part-00000-c000.snappy.parquet')).toBe('`part-00000-c000.snappy.parquet`');
    expect(quoteIdent('has space')).toBe('`has space`');
    expect(quoteIdent('9starts')).toBe('`9starts`'); // leading digit isn't bare
  });
  it('escapes backslashes and backticks inside the quotes', () => {
    expect(quoteIdent('a`b')).toBe('`a\\`b`');
    expect(quoteIdent('a\\b')).toBe('`a\\\\b`');
  });
  it('quotes an empty identifier (not a bare identifier — BARE_IDENT requires >=1 char)', () => {
    expect(quoteIdent('')).toBe('``');
  });
  it('escapes a backtick immediately adjacent to a backslash inside one identifier', () => {
    expect(quoteIdent('a\\`b')).toBe('`a\\\\\\`b`');
    expect(quoteIdent('`\\')).toBe('`\\`\\\\`');
  });
});

describe('qualifyIdent', () => {
  it('quotes each part and joins with a dot', () => {
    expect(qualifyIdent('db', 'tbl')).toBe('db.tbl');
    expect(qualifyIdent('target_all', 'part-0.snappy.parquet')).toBe('target_all.`part-0.snappy.parquet`');
  });
  it('drops empty/nullish parts (a bare name qualifies to itself)', () => {
    expect(qualifyIdent('', 'tbl')).toBe('tbl');
    expect(qualifyIdent(null, 'a-b')).toBe('`a-b`');
  });
  it('drops every empty/nullish part among several, keeping only the real ones in order', () => {
    expect(qualifyIdent(null, 'db', '', undefined, 'a-b')).toBe('db.`a-b`');
    expect(qualifyIdent(null, undefined, '')).toBe('');
  });
  it('qualifies multiple parts that each need a different quoting outcome', () => {
    // A bare part, a backtick-needing part, and a part needing backslash escaping.
    expect(qualifyIdent('db', 'has space', 'a`b')).toBe('db.`has space`.`a\\`b`');
  });
});
