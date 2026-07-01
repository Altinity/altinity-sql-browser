import { describe, it, expect } from 'vitest';
import {
  clamp, formatRows, formatBytes, timeAgo, sqlString, quoteIdent, qualifyIdent, inferQueryName, isNumericType, shortVersion, supportsExplainPretty, userShortName, withStatementBreak, detectSqlFormat, isSchemaMutatingSql, toSubquery, prepareExportSql,
} from '../../src/core/format.js';

describe('clamp', () => {
  it('clamps below, within, above', () => {
    expect(clamp(-5, 0, 10)).toBe(0);
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(99, 0, 10)).toBe(10);
  });
});

describe('formatRows', () => {
  it('handles null / NaN', () => {
    expect(formatRows(null)).toBe('—');
    expect(formatRows(undefined)).toBe('—');
    expect(formatRows('abc')).toBe('—');
  });
  it('formats each band', () => {
    expect(formatRows(0)).toBe('0');
    expect(formatRows(999)).toBe('999');
    expect(formatRows(1500)).toBe('1.5K');
    expect(formatRows(20000)).toBe('20K');
    expect(formatRows(1.5e6)).toBe('1.5M');
    expect(formatRows(2e7)).toBe('20M');
    expect(formatRows(1.5e9)).toBe('1.5B');
    expect(formatRows(2e10)).toBe('20B');
  });
});

describe('formatBytes', () => {
  it('handles null / NaN', () => {
    expect(formatBytes(null)).toBe('—');
    expect(formatBytes('x')).toBe('—');
  });
  it('formats each unit', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(5 * 1024 ** 2)).toBe('5.0 MB');
    expect(formatBytes(3 * 1024 ** 3)).toBe('3.00 GB');
    expect(formatBytes(2 * 1024 ** 4)).toBe('2.00 TB');
  });
});

describe('timeAgo', () => {
  const now = 1_000_000_000_000;
  it('renders seconds/minutes/hours/days', () => {
    expect(timeAgo(now - 5_000, now)).toBe('5s ago');
    expect(timeAgo(now - 120_000, now)).toBe('2m ago');
    expect(timeAgo(now - 3 * 3600_000, now)).toBe('3h ago');
    expect(timeAgo(now - 2 * 86400_000, now)).toBe('2d ago');
  });
  it('defaults now to Date.now()', () => {
    expect(timeAgo(Date.now())).toBe('0s ago');
  });
});

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
});

describe('withStatementBreak', () => {
  it('appends a newline so the caret clears the last token', () => {
    expect(withStatementBreak('SELECT 1')).toBe('SELECT 1\n');
    expect(withStatementBreak('SELECT a\nFROM t')).toBe('SELECT a\nFROM t\n');
  });
  it('leaves text already ending in whitespace or a semicolon untouched', () => {
    expect(withStatementBreak('SELECT 1\n')).toBe('SELECT 1\n');
    expect(withStatementBreak('SELECT 1 ')).toBe('SELECT 1 ');
    expect(withStatementBreak('SELECT 1;')).toBe('SELECT 1;');
  });
  it('coerces nullish/empty to empty string (no stray newline)', () => {
    expect(withStatementBreak('')).toBe('');
    expect(withStatementBreak(null)).toBe('');
    expect(withStatementBreak(undefined)).toBe('');
  });
});

describe('detectSqlFormat', () => {
  it('returns the trailing FORMAT clause name (case-insensitive keyword, allows ; and trailing ws)', () => {
    expect(detectSqlFormat('SELECT 1 FORMAT Pretty')).toBe('Pretty');
    expect(detectSqlFormat('SELECT * FROM t\nFORMAT JSONEachRow')).toBe('JSONEachRow');
    expect(detectSqlFormat('select 1 format CSV')).toBe('CSV');
    expect(detectSqlFormat('SELECT 1 FORMAT TabSeparatedWithNames ; ')).toBe('TabSeparatedWithNames');
  });
  it('still detects FORMAT when followed by a SETTINGS clause (CH allows either order)', () => {
    expect(detectSqlFormat('SELECT 1 FORMAT CSV SETTINGS max_threads=1')).toBe('CSV');
    expect(detectSqlFormat('SELECT 1 FORMAT CSV SETTINGS max_threads=1;')).toBe('CSV');
    expect(detectSqlFormat('SELECT 1 SETTINGS max_threads=1 FORMAT CSV')).toBe('CSV'); // the other order
  });
  it('returns null without a trailing FORMAT clause', () => {
    expect(detectSqlFormat('SELECT 1')).toBeNull();
    expect(detectSqlFormat("SELECT 'FORMAT JSON' AS x")).toBeNull(); // FORMAT not the trailing clause
    expect(detectSqlFormat('')).toBeNull();
    expect(detectSqlFormat(null)).toBeNull();
  });
});

describe('prepareExportSql', () => {
  it('appends FORMAT TabSeparatedWithNames when the query has no FORMAT clause', () => {
    expect(prepareExportSql('SELECT 1')).toEqual({ sql: 'SELECT 1\nFORMAT TabSeparatedWithNames', format: 'TabSeparatedWithNames' });
  });
  it('keeps an explicit FORMAT clause verbatim and reports it', () => {
    expect(prepareExportSql('SELECT 1 FORMAT JSON')).toEqual({ sql: 'SELECT 1 FORMAT JSON', format: 'JSON' });
    expect(prepareExportSql('SELECT 1 FORMAT Parquet')).toEqual({ sql: 'SELECT 1 FORMAT Parquet', format: 'Parquet' });
  });
  it('peels a trailing ; either way', () => {
    expect(prepareExportSql('SELECT 1;')).toEqual({ sql: 'SELECT 1\nFORMAT TabSeparatedWithNames', format: 'TabSeparatedWithNames' });
    expect(prepareExportSql('SELECT 1 FORMAT CSV ; ')).toEqual({ sql: 'SELECT 1 FORMAT CSV', format: 'CSV' });
  });
  it('empty/whitespace input → empty sql, default format', () => {
    expect(prepareExportSql('')).toEqual({ sql: '', format: 'TabSeparatedWithNames' });
    expect(prepareExportSql('   ')).toEqual({ sql: '', format: 'TabSeparatedWithNames' });
    expect(prepareExportSql(null)).toEqual({ sql: '', format: 'TabSeparatedWithNames' });
  });
});

describe('isSchemaMutatingSql', () => {
  it('is true for each schema-mutating DDL keyword, case-insensitively', () => {
    expect(isSchemaMutatingSql('CREATE DATABASE t3')).toBe(true);
    expect(isSchemaMutatingSql('create table t (id UInt32) engine=Memory')).toBe(true);
    expect(isSchemaMutatingSql('DROP TABLE t')).toBe(true);
    expect(isSchemaMutatingSql('ALTER TABLE t ADD COLUMN c UInt8')).toBe(true);
    expect(isSchemaMutatingSql('RENAME TABLE a TO b')).toBe(true);
    expect(isSchemaMutatingSql('TRUNCATE TABLE t')).toBe(true);
    expect(isSchemaMutatingSql('ATTACH TABLE t')).toBe(true);
    expect(isSchemaMutatingSql('DETACH TABLE t')).toBe(true);
    expect(isSchemaMutatingSql('EXCHANGE TABLES a AND b')).toBe(true);
  });
  it('skips leading whitespace and comments before the keyword', () => {
    expect(isSchemaMutatingSql('  \n CREATE DATABASE t3')).toBe(true);
    expect(isSchemaMutatingSql('-- a comment\nCREATE DATABASE t3')).toBe(true);
    expect(isSchemaMutatingSql('/* block */ DROP TABLE t')).toBe(true);
    expect(isSchemaMutatingSql('-- one\n/* two */\nALTER TABLE t ADD COLUMN c UInt8')).toBe(true);
  });
  it('is false for non-DDL statements and empty/null input', () => {
    expect(isSchemaMutatingSql('SELECT 1')).toBe(false);
    expect(isSchemaMutatingSql('INSERT INTO t VALUES (1)')).toBe(false);
    expect(isSchemaMutatingSql('-- DROP TABLE not really')).toBe(false);
    expect(isSchemaMutatingSql('')).toBe(false);
    expect(isSchemaMutatingSql(null)).toBe(false);
    expect(isSchemaMutatingSql(undefined)).toBe(false);
  });
});

describe('inferQueryName', () => {
  it('uses FROM table when present', () => {
    expect(inferQueryName('SELECT * FROM system.tables')).toBe('Query · system.tables');
    expect(inferQueryName('select a from db.t')).toBe('Query · db.t');
  });
  it('strips quote chars that follow an unquoted leading identifier', () => {
    // The matcher anchors on a letter/underscore, then strips backticks/quotes
    // from the captured tail.
    expect(inferQueryName('SELECT 1 FROM t`x`')).toBe('Query · tx');
  });
  it('falls back to short SQL', () => {
    expect(inferQueryName('SELECT 1')).toBe('SELECT 1');
  });
  it('truncates long SQL without FROM', () => {
    const long = 'SELECT ' + 'x'.repeat(80);
    const name = inferQueryName(long);
    expect(name.endsWith('…')).toBe(true);
    expect(name.length).toBe(46);
  });
});

describe('isNumericType', () => {
  it('detects numeric CH types', () => {
    expect(isNumericType('UInt64')).toBe(true);
    expect(isNumericType('Int32')).toBe(true);
    expect(isNumericType('Float64')).toBe(true);
    expect(isNumericType('Decimal(10,2)')).toBe(true);
    expect(isNumericType('String')).toBe(false);
    expect(isNumericType('')).toBe(false);
    expect(isNumericType(null)).toBe(false);
  });
});

describe('shortVersion', () => {
  it('keeps the first three dot-segments of a long version', () => {
    expect(shortVersion('26.3.10.20001.altinityantalya')).toBe('26.3.10');
  });
  it('passes through short versions and empty/nullish input', () => {
    expect(shortVersion('26.3.1')).toBe('26.3.1');
    expect(shortVersion('26.3')).toBe('26.3');
    expect(shortVersion('')).toBe('');
    expect(shortVersion(null)).toBe('');
  });
});

describe('supportsExplainPretty', () => {
  it('is true at and above 26.3', () => {
    expect(supportsExplainPretty('26.3.1')).toBe(true);
    expect(supportsExplainPretty('26.3')).toBe(true);
    expect(supportsExplainPretty('26.4.0')).toBe(true);
    expect(supportsExplainPretty('27.0.1')).toBe(true);
  });
  it('is false below 26.3, and for malformed/empty input', () => {
    expect(supportsExplainPretty('26.2.9')).toBe(false);
    expect(supportsExplainPretty('25.9')).toBe(false);
    expect(supportsExplainPretty('')).toBe(false);
    expect(supportsExplainPretty(null)).toBe(false);
    expect(supportsExplainPretty(undefined)).toBe(false);
    expect(supportsExplainPretty('not-a-version')).toBe(false);
  });
});

describe('userShortName', () => {
  it('returns the email local-part', () => {
    expect(userShortName('btyshkevich@altinity.com')).toBe('btyshkevich');
  });
  it('falls back to the whole string with no @, and "" for empty/nullish', () => {
    expect(userShortName('justname')).toBe('justname');
    expect(userShortName('@nolocal')).toBe('@nolocal'); // at index 0 → no split
    expect(userShortName('')).toBe('');
    expect(userShortName(null)).toBe('');
  });
});

describe('toSubquery', () => {
  it('wraps SQL in parentheses on their own lines', () => {
    expect(toSubquery('SELECT 1')).toBe('(\nSELECT 1\n)');
  });
  it('trims and strips a trailing semicolon', () => {
    expect(toSubquery('  SELECT 1 ;  ')).toBe('(\nSELECT 1\n)');
  });
  it('strips a trailing FORMAT clause (invalid inside a subquery)', () => {
    expect(toSubquery('SELECT 1 FORMAT JSON')).toBe('(\nSELECT 1\n)');
    expect(toSubquery('SELECT 1 FORMAT TabSeparated;')).toBe('(\nSELECT 1\n)');
    expect(toSubquery('SELECT 1 FORMAT Null')).toBe('(\nSELECT 1\n)');
  });
  it('peels FORMAT + repeated/spaced trailing semicolons in any order', () => {
    expect(toSubquery('SELECT 1 FORMAT JSON ;;')).toBe('(\nSELECT 1\n)');
    expect(toSubquery('SELECT 1 ;')).toBe('(\nSELECT 1\n)');
  });
  it('keeps a FORMAT that is not the trailing clause untouched', () => {
    expect(toSubquery("SELECT 'FORMAT JSON' AS x")).toBe("(\nSELECT 'FORMAT JSON' AS x\n)");
  });
  it('returns empty string for empty/whitespace input', () => {
    expect(toSubquery('')).toBe('');
    expect(toSubquery('   ')).toBe('');
    expect(toSubquery(null)).toBe('');
  });
});
