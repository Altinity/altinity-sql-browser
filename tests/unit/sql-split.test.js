import { describe, it, expect } from 'vitest';
import { splitStatements, leadingKeyword, isRowReturning, isAutoRunnable } from '../../src/core/sql-split.js';

describe('splitStatements', () => {
  it('returns [] for empty / nullish input', () => {
    expect(splitStatements('')).toEqual([]);
    expect(splitStatements(null)).toEqual([]);
    expect(splitStatements(undefined)).toEqual([]);
    expect(splitStatements('   \n  ')).toEqual([]);
  });

  it('returns a single trimmed statement (no semicolon)', () => {
    expect(splitStatements('  SELECT 1  ')).toEqual(['SELECT 1']);
  });

  it('treats a single statement with a trailing ; as one element', () => {
    expect(splitStatements('SELECT 1;')).toEqual(['SELECT 1']);
    expect(splitStatements('SELECT 1 ;  ')).toEqual(['SELECT 1']);
  });

  it('splits a multi-statement script in order', () => {
    expect(splitStatements('CREATE TABLE t (a Int); INSERT INTO t VALUES (1); SELECT * FROM t'))
      .toEqual(['CREATE TABLE t (a Int)', 'INSERT INTO t VALUES (1)', 'SELECT * FROM t']);
  });

  it('does not split on a ; inside a single-quoted string', () => {
    expect(splitStatements("SELECT 'a;b'; SELECT 2"))
      .toEqual(["SELECT 'a;b'", 'SELECT 2']);
  });

  it('handles backslash-escaped quotes inside a string', () => {
    expect(splitStatements("SELECT 'it\\'s; fine'; SELECT 2"))
      .toEqual(["SELECT 'it\\'s; fine'", 'SELECT 2']);
  });

  it('handles doubled-quote escapes inside a string', () => {
    expect(splitStatements("SELECT 'it''s; fine'; SELECT 2"))
      .toEqual(["SELECT 'it''s; fine'", 'SELECT 2']);
  });

  it('handles an escaped backslash at the end of a string', () => {
    expect(splitStatements("SELECT 'a\\\\'; SELECT 2"))
      .toEqual(["SELECT 'a\\\\'", 'SELECT 2']);
  });

  it('ignores ; inside double-quoted and backtick identifiers', () => {
    expect(splitStatements('SELECT "a;b", `c;d`; SELECT 2'))
      .toEqual(['SELECT "a;b", `c;d`', 'SELECT 2']);
  });

  it('leaves an unterminated string as one trailing statement', () => {
    expect(splitStatements("SELECT 'oops")).toEqual(["SELECT 'oops"]);
  });

  it('ignores ; inside -- line comments', () => {
    expect(splitStatements('SELECT 1 -- a;b\n; SELECT 2'))
      .toEqual(['SELECT 1 -- a;b', 'SELECT 2']);
  });

  it('ignores ; inside # line comments', () => {
    expect(splitStatements('SELECT 1 # a;b\n; SELECT 2'))
      .toEqual(['SELECT 1 # a;b', 'SELECT 2']);
  });

  it('ignores ; inside /* */ block comments', () => {
    expect(splitStatements('SELECT 1 /* a;b */; SELECT 2'))
      .toEqual(['SELECT 1 /* a;b */', 'SELECT 2']);
  });

  it('tolerates an unterminated block comment', () => {
    expect(splitStatements('SELECT 1; /* trailing')).toEqual(['SELECT 1']);
  });

  it('handles a realistically-commented script (-- , #, /* */ all supported)', () => {
    const sql = '-- setup\nCREATE TABLE t (a Int8); /* seed */ INSERT INTO t VALUES (1); # check\nSELECT * FROM t -- trailing';
    expect(splitStatements(sql)).toEqual([
      '-- setup\nCREATE TABLE t (a Int8)',
      '/* seed */ INSERT INTO t VALUES (1)',
      '# check\nSELECT * FROM t -- trailing',
    ]);
    expect(isAutoRunnable(sql)).toBe(false); // CREATE/INSERT present → don't auto-run
  });

  it('drops comment-only and whitespace-only fragments but keeps comments attached to code', () => {
    // The leading comment belongs to the statement that follows it (harmless to
    // send); the bare `;` and the trailing comment-only fragment are dropped.
    expect(splitStatements('-- just a note\nSELECT 1; \n ; /* end */'))
      .toEqual(['-- just a note\nSELECT 1']);
  });
});

describe('leadingKeyword', () => {
  it('returns the uppercased first keyword', () => {
    expect(leadingKeyword('select 1')).toBe('SELECT');
    expect(leadingKeyword('  Insert into t ...')).toBe('INSERT');
  });
  it('skips leading whitespace and comments of every kind', () => {
    expect(leadingKeyword('  \n -- note\n # bang\n /* block */ SELECT 1')).toBe('SELECT');
  });
  it('skips leading parentheses so a parenthesized SELECT is recognized', () => {
    expect(leadingKeyword('((SELECT 1) UNION ALL (SELECT 2))')).toBe('SELECT');
    expect(leadingKeyword('/* c */ ( select 1 )')).toBe('SELECT');
  });
  it('returns "" when there is no leading keyword', () => {
    expect(leadingKeyword('')).toBe('');
    expect(leadingKeyword('-- only a comment')).toBe('');
    expect(leadingKeyword('42 + 1')).toBe('');
  });
});

describe('isRowReturning', () => {
  it('is true for row-bearing statements', () => {
    for (const s of ['SELECT 1', 'with x as (select 1) select * from x',
      'SHOW TABLES', 'DESC t', 'DESCRIBE t', 'EXISTS TABLE t', 'VALUES (1)', 'EXPLAIN SELECT 1',
      '(SELECT 1) UNION ALL (SELECT 2)']) {
      expect(isRowReturning(s)).toBe(true);
    }
  });
  it('is false for effectful statements', () => {
    for (const s of ['CREATE TABLE t (a Int)', 'INSERT INTO t VALUES (1)',
      'DROP TABLE t', 'ALTER TABLE t ADD COLUMN b Int', '-- comment only', '']) {
      expect(isRowReturning(s)).toBe(false);
    }
  });
});

describe('isAutoRunnable', () => {
  it('is true when every statement is row-returning (one or many)', () => {
    expect(isAutoRunnable('SELECT 1')).toBe(true);
    expect(isAutoRunnable('SELECT 1; SHOW TABLES; WITH x AS (SELECT 1) SELECT * FROM x')).toBe(true);
  });
  it('is false when any statement is effectful', () => {
    expect(isAutoRunnable('CREATE TABLE t (a Int)')).toBe(false);
    expect(isAutoRunnable('DROP TABLE t')).toBe(false);
    expect(isAutoRunnable('SELECT 1; INSERT INTO t VALUES (1)')).toBe(false);
  });
  it('is false for empty / comment-only input', () => {
    expect(isAutoRunnable('')).toBe(false);
    expect(isAutoRunnable('  -- just a note  ')).toBe(false);
  });
});
