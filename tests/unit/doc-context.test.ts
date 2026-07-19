import { describe, it, expect } from 'vitest';
import {
  resolveDocTarget, lookupFunctionEntry, docTargetForMatch,
} from '../../src/core/doc-context.js';
import type { CompletionFunctionEntry } from '../../src/core/completions.js';

const FUNCTIONS: Record<string, CompletionFunctionEntry> = {
  count: { kind: 'agg', sig: 'count()', ret: 'UInt64', desc: '' },
  toDateTime: { kind: 'fn', sig: 'toDateTime(x)', ret: 'DateTime', desc: '' },
  CAST: { kind: 'cast', sig: 'CAST(x, T)', ret: '', desc: '' },
};

describe('lookupFunctionEntry', () => {
  it('matches exact case first', () => {
    expect(lookupFunctionEntry(FUNCTIONS, 'toDateTime')).toEqual({ key: 'toDateTime', entry: FUNCTIONS.toDateTime });
  });

  it('falls back to lowercase, then UPPERCASE', () => {
    expect(lookupFunctionEntry(FUNCTIONS, 'COUNT')).toEqual({ key: 'count', entry: FUNCTIONS.count });
    expect(lookupFunctionEntry(FUNCTIONS, 'cast')).toEqual({ key: 'CAST', entry: FUNCTIONS.CAST });
  });


  it('returns undefined for an unknown word', () => {
    expect(lookupFunctionEntry(FUNCTIONS, 'nope')).toBeUndefined();
  });

  it('never resolves off Object.prototype (own properties only)', () => {
    expect(lookupFunctionEntry(FUNCTIONS, 'constructor')).toBeUndefined();
    expect(lookupFunctionEntry(FUNCTIONS, 'toString')).toBeUndefined();
    expect(lookupFunctionEntry(FUNCTIONS, 'hasOwnProperty')).toBeUndefined();
  });
});

describe('docTargetForMatch', () => {
  it('maps an aggregate entry to kind aggregate-function', () => {
    expect(docTargetForMatch({ key: 'count', entry: FUNCTIONS.count })).toEqual({ kind: 'aggregate-function', name: 'count' });
  });

  it('maps fn/cast entries to kind function', () => {
    expect(docTargetForMatch({ key: 'toDateTime', entry: FUNCTIONS.toDateTime })).toEqual({ kind: 'function', name: 'toDateTime' });
    expect(docTargetForMatch({ key: 'CAST', entry: FUNCTIONS.CAST })).toEqual({ kind: 'function', name: 'CAST' });
  });

  it('an entry with no kind at all defaults to function', () => {
    expect(docTargetForMatch({ key: 'bare', entry: {} })).toEqual({ kind: 'function', name: 'bare' });
  });
});

describe('resolveDocTarget', () => {
  it('resolves a known function at a caret inside the word', () => {
    expect(resolveDocTarget('select toDateTime(x)', 10, FUNCTIONS)).toEqual({ kind: 'function', name: 'toDateTime' });
  });

  it('resolves a known aggregate case-insensitively', () => {
    expect(resolveDocTarget('SELECT COUNT(*)', 9, FUNCTIONS)).toEqual({ kind: 'aggregate-function', name: 'count' });
  });

  it('returns null for an unknown identifier', () => {
    expect(resolveDocTarget('select mystery(x)', 10, FUNCTIONS)).toBeNull();
  });

  it('returns null when the caret is on whitespace (no word there)', () => {
    expect(resolveDocTarget('a b', 1, FUNCTIONS)).toBeNull();
  });

  it('returns null when the caret sits between two punctuation characters (no word there)', () => {
    expect(resolveDocTarget('count(*)', 6, FUNCTIONS)).toBeNull(); // between '(' and '*'
  });

  it('returns null on an empty document', () => {
    expect(resolveDocTarget('', 0, FUNCTIONS)).toBeNull();
  });

  it('resolves at position 0 (start of the word/document)', () => {
    expect(resolveDocTarget('count(*)', 0, FUNCTIONS)).toEqual({ kind: 'aggregate-function', name: 'count' });
  });

  it('resolves at the exact end of the word (caret right after the last char)', () => {
    expect(resolveDocTarget('count', 5, FUNCTIONS)).toEqual({ kind: 'aggregate-function', name: 'count' });
  });

  it('resolves at the exact end of the whole text', () => {
    const text = 'select toDateTime';
    expect(resolveDocTarget(text, text.length, FUNCTIONS)).toEqual({ kind: 'function', name: 'toDateTime' });
  });
});

// A caret comfortably inside `needle`'s Nth (0-based) occurrence in `text` —
// avoids off-by-one hand-counting across the #314 fixtures below.
function caretIn(text: string, needle: string, occurrence = 0): number {
  let pos = -1;
  for (let i = 0; i <= occurrence; i++) {
    pos = text.indexOf(needle, pos + 1);
    if (pos < 0) throw new Error(`occurrence ${i} of ${JSON.stringify(needle)} not found`);
  }
  return pos + 1; // one char in — never on the exact boundary
}

describe('resolveDocTarget — #314 structured contexts', () => {
  describe('FORMAT clause', () => {
    it('resolves the format name, FORMAT-then-SETTINGS order', () => {
      const sql = 'INSERT INTO t FORMAT JSONEachRow SETTINGS x = 1';
      expect(resolveDocTarget(sql, caretIn(sql, 'JSONEachRow'), FUNCTIONS)).toEqual({ kind: 'format', name: 'JSONEachRow' });
    });

    it('resolves the format name, SETTINGS-then-FORMAT order', () => {
      const sql = 'INSERT INTO t SETTINGS x = 1 FORMAT CSV';
      expect(resolveDocTarget(sql, caretIn(sql, 'CSV'), FUNCTIONS)).toEqual({ kind: 'format', name: 'CSV' });
    });

    it('validates against a supplied known-format list, case-insensitively', () => {
      const sql = 'INSERT INTO t FORMAT csv';
      expect(resolveDocTarget(sql, caretIn(sql, 'csv'), FUNCTIONS, { formats: ['CSV'] }))
        .toEqual({ kind: 'format', name: 'csv' });
    });

    it('rejects a FORMAT-position word absent from a supplied known-format list', () => {
      const sql = 'INSERT INTO t FORMAT Bogus';
      expect(resolveDocTarget(sql, caretIn(sql, 'Bogus'), FUNCTIONS, { formats: ['CSV'] })).toBeNull();
    });

    it('never confuses the format() table function for the FORMAT clause', () => {
      const sql = 'SELECT format(x)';
      expect(resolveDocTarget(sql, caretIn(sql, 'x'), FUNCTIONS)).toBeNull(); // 'x' arg, not preceded by FORMAT
    });

    it('never confuses formatDateTime() near a real FORMAT keyword', () => {
      const sql = "SELECT formatDateTime(now(), '%Y') FORMAT CSV";
      // caret on formatDateTime itself falls through to the Phase 1 function
      // lookup (unknown here), never matches as a 'format' target.
      expect(resolveDocTarget(sql, caretIn(sql, 'formatDateTime'), FUNCTIONS)).toBeNull();
    });

    it('formatDateTime resolves as a function when known, never as a format target', () => {
      const withFormatFn: Record<string, CompletionFunctionEntry> = { ...FUNCTIONS, formatDateTime: { kind: 'fn', sig: 'formatDateTime(x, fmt)', ret: 'String', desc: '' } };
      const sql = "SELECT formatDateTime(now(), '%Y') FORMAT CSV";
      expect(resolveDocTarget(sql, caretIn(sql, 'formatDateTime'), withFormatFn)).toEqual({ kind: 'function', name: 'formatDateTime' });
    });

    it('ranks above a same-named known function', () => {
      const withCsvFn: Record<string, CompletionFunctionEntry> = { ...FUNCTIONS, toDateTime2: { kind: 'fn', sig: '', ret: '', desc: '' } };
      const sql = 'SELECT toDateTime2(x) FORMAT toDateTime2';
      expect(resolveDocTarget(sql, caretIn(sql, 'toDateTime2', 1), withCsvFn)).toEqual({ kind: 'format', name: 'toDateTime2' });
    });
  });

  describe('ENGINE = Name', () => {
    it('resolves a table engine', () => {
      const sql = 'CREATE TABLE t (id UInt32) ENGINE = MergeTree';
      expect(resolveDocTarget(sql, caretIn(sql, 'MergeTree'), FUNCTIONS)).toEqual({ kind: 'table-engine', name: 'MergeTree' });
    });

    it('resolves a parameterized table engine\'s name (caret on the name)', () => {
      const sql = "CREATE TABLE t (id UInt32) ENGINE = ReplicatedMergeTree('/path', 'r')";
      expect(resolveDocTarget(sql, caretIn(sql, 'ReplicatedMergeTree'), FUNCTIONS)).toEqual({ kind: 'table-engine', name: 'ReplicatedMergeTree' });
    });

    it('does NOT resolve the parameterized engine\'s own argument as an engine target', () => {
      const sql = 'CREATE TABLE t (id UInt32) ENGINE = Buffer(bar)';
      expect(resolveDocTarget(sql, caretIn(sql, 'bar'), FUNCTIONS)).toBeNull();
    });

    it('resolves a database engine for CREATE DATABASE', () => {
      const sql = 'CREATE DATABASE db ENGINE = Atomic';
      expect(resolveDocTarget(sql, caretIn(sql, 'Atomic'), FUNCTIONS)).toEqual({ kind: 'database-engine', name: 'Atomic' });
    });

    it('resolves a database engine for ATTACH DATABASE', () => {
      const sql = 'ATTACH DATABASE db ENGINE = Ordinary';
      expect(resolveDocTarget(sql, caretIn(sql, 'Ordinary'), FUNCTIONS)).toEqual({ kind: 'database-engine', name: 'Ordinary' });
    });

    it('never resolves ENGINE = written inside a comment', () => {
      const sql = '-- ENGINE = Foo\nSELECT 1';
      expect(resolveDocTarget(sql, caretIn(sql, 'Foo'), FUNCTIONS)).toBeNull();
    });

    it('ranks above a same-named known function', () => {
      const sql = 'CREATE TABLE t (id UInt32) ENGINE = toDateTime';
      expect(resolveDocTarget(sql, caretIn(sql, 'toDateTime'), FUNCTIONS)).toEqual({ kind: 'table-engine', name: 'toDateTime' });
    });

    it('a table ENGINE with no column-list parens at all still resolves (isDatabaseDDL scans to statement end)', () => {
      const sql = 'CREATE TABLE t ENGINE = Memory';
      expect(resolveDocTarget(sql, caretIn(sql, 'Memory'), FUNCTIONS)).toEqual({ kind: 'table-engine', name: 'Memory' });
    });

    it('a leading line comment does not hide CREATE DATABASE (statement head skips comments)', () => {
      const sql = '-- create the db\nCREATE DATABASE db ENGINE = Atomic';
      expect(resolveDocTarget(sql, caretIn(sql, 'Atomic'), FUNCTIONS)).toEqual({ kind: 'database-engine', name: 'Atomic' });
    });

    it('a leading block comment does not hide CREATE TABLE (column types still resolve)', () => {
      const sql = '/* header */ CREATE TABLE t (id UInt32) ENGINE = MergeTree';
      expect(resolveDocTarget(sql, caretIn(sql, 'UInt32'), FUNCTIONS)).toEqual({ kind: 'data-type', name: 'UInt32' });
      expect(resolveDocTarget(sql, caretIn(sql, 'MergeTree'), FUNCTIONS)).toEqual({ kind: 'table-engine', name: 'MergeTree' });
    });
  });

  describe('data-type positions', () => {
    it('CAST(expr AS Type) resolves the type', () => {
      const sql = 'SELECT CAST(x AS UInt32)';
      expect(resolveDocTarget(sql, caretIn(sql, 'UInt32'), FUNCTIONS)).toEqual({ kind: 'data-type', name: 'UInt32' });
    });

    it('CAST with whitespace/newlines around AS still resolves', () => {
      const sql = 'SELECT CAST(\n  x\n  AS\n  UInt32\n)';
      expect(resolveDocTarget(sql, caretIn(sql, 'UInt32'), FUNCTIONS)).toEqual({ kind: 'data-type', name: 'UInt32' });
    });

    it('nested types resolve the innermost token under the caret', () => {
      const sql = 'SELECT CAST(x AS Array(Tuple(String, UInt64)))';
      expect(resolveDocTarget(sql, caretIn(sql, 'UInt64'), FUNCTIONS)).toEqual({ kind: 'data-type', name: 'UInt64' });
      expect(resolveDocTarget(sql, caretIn(sql, 'String'), FUNCTIONS)).toEqual({ kind: 'data-type', name: 'String' });
      expect(resolveDocTarget(sql, caretIn(sql, 'Array'), FUNCTIONS)).toEqual({ kind: 'data-type', name: 'Array' });
    });

    it('never resolves the CAST expr side (before AS) as a type', () => {
      const sql = 'SELECT CAST(toDateTime AS UInt32)';
      expect(resolveDocTarget(sql, caretIn(sql, 'toDateTime'), FUNCTIONS)).toEqual({ kind: 'function', name: 'toDateTime' });
    });

    it('a malformed/unterminated CAST never resolves a type target', () => {
      const sql = 'SELECT CAST(x AS UInt32';
      expect(resolveDocTarget(sql, caretIn(sql, 'UInt32'), FUNCTIONS)).toBeNull();
    });

    it('nested CAST resolves the inner type', () => {
      const sql = 'SELECT CAST(CAST(y AS Int32) AS String)';
      expect(resolveDocTarget(sql, caretIn(sql, 'Int32'), FUNCTIONS)).toEqual({ kind: 'data-type', name: 'Int32' });
      expect(resolveDocTarget(sql, caretIn(sql, 'String'), FUNCTIONS)).toEqual({ kind: 'data-type', name: 'String' });
    });

    it('x::Type resolves the type', () => {
      const sql = 'SELECT x::Int32 FROM t';
      expect(resolveDocTarget(sql, caretIn(sql, 'Int32'), FUNCTIONS)).toEqual({ kind: 'data-type', name: 'Int32' });
    });

    it('x::Type stops at a following clause keyword, not swallowing it', () => {
      const sql = 'SELECT x::Int32 FROM t';
      expect(resolveDocTarget(sql, caretIn(sql, 'FROM'), FUNCTIONS)).toBeNull();
    });

    it('a "::" inside a string literal is not a cast operator', () => {
      const sql = "SELECT '::Int32'";
      expect(resolveDocTarget(sql, caretIn(sql, 'Int32'), FUNCTIONS)).toBeNull();
    });

    it('{name:Type} query parameter resolves the type', () => {
      const sql = 'SELECT {p:UInt32}';
      expect(resolveDocTarget(sql, caretIn(sql, 'UInt32'), FUNCTIONS)).toEqual({ kind: 'data-type', name: 'UInt32' });
    });

    it('{name:Type} resolves a nested inner type too', () => {
      const sql = 'SELECT {p:Array(String)}';
      expect(resolveDocTarget(sql, caretIn(sql, 'String'), FUNCTIONS)).toEqual({ kind: 'data-type', name: 'String' });
    });

    it('column definitions inside a CREATE TABLE column list resolve the type', () => {
      const sql = 'CREATE TABLE t (id UInt32, name String) ENGINE = MergeTree';
      expect(resolveDocTarget(sql, caretIn(sql, 'UInt32'), FUNCTIONS)).toEqual({ kind: 'data-type', name: 'UInt32' });
      expect(resolveDocTarget(sql, caretIn(sql, 'String'), FUNCTIONS)).toEqual({ kind: 'data-type', name: 'String' });
    });

    it('a column NAME is never mistaken for its own type', () => {
      const sql = 'CREATE TABLE t (id UInt32) ENGINE = MergeTree';
      expect(resolveDocTarget(sql, caretIn(sql, 'id'), FUNCTIONS)).toBeNull();
    });

    it('nested column types resolve the innermost token', () => {
      const sql = 'CREATE TABLE t (id Nullable(DateTime64(3))) ENGINE = MergeTree';
      expect(resolveDocTarget(sql, caretIn(sql, 'DateTime64'), FUNCTIONS)).toEqual({ kind: 'data-type', name: 'DateTime64' });
    });

    it('a column modifier keyword (DEFAULT) after the type is excluded from the type region', () => {
      const sql = 'CREATE TABLE t (id UInt32 DEFAULT 0) ENGINE = Memory';
      expect(resolveDocTarget(sql, caretIn(sql, 'DEFAULT'), FUNCTIONS)).toBeNull();
    });

    it('resolves within the statement containing the caret in a multi-statement document', () => {
      const sql = 'CREATE TABLE t (id UInt32) ENGINE = Log; CREATE TABLE u (id UInt32) ENGINE = Memory';
      expect(resolveDocTarget(sql, caretIn(sql, 'Memory'), FUNCTIONS)).toEqual({ kind: 'table-engine', name: 'Memory' });
      expect(resolveDocTarget(sql, caretIn(sql, 'Log'), FUNCTIONS)).toEqual({ kind: 'table-engine', name: 'Log' });
    });

    it('ranks above a same-named known function', () => {
      const sql = 'SELECT CAST(x AS toDateTime)';
      expect(resolveDocTarget(sql, caretIn(sql, 'toDateTime'), FUNCTIONS)).toEqual({ kind: 'data-type', name: 'toDateTime' });
    });

    it('x::Type reaching the end of the document with no trailing keyword still resolves', () => {
      const sql = 'SELECT x::Int32';
      expect(resolveDocTarget(sql, caretIn(sql, 'Int32'), FUNCTIONS)).toEqual({ kind: 'data-type', name: 'Int32' });
    });

    it('a bare "::" with nothing after it is not a cast (no type token to resolve)', () => {
      const sql = 'SELECT x::';
      expect(resolveDocTarget(sql, sql.length, FUNCTIONS)).toBeNull();
    });

    it('"::" followed by a non-word (a number) is not a cast', () => {
      const sql = 'SELECT x::5';
      expect(resolveDocTarget(sql, caretIn(sql, '5'), FUNCTIONS)).toBeNull();
    });

    it('a stray unmatched closing paren is tolerated (paren depth never goes negative)', () => {
      const sql = ') CAST(x AS UInt32)';
      expect(resolveDocTarget(sql, caretIn(sql, 'UInt32'), FUNCTIONS)).toEqual({ kind: 'data-type', name: 'UInt32' });
    });

    it('a quoted-identifier column name is recognized (its type still resolves)', () => {
      const sql = 'CREATE TABLE t (`my col` UInt32) ENGINE = Memory';
      expect(resolveDocTarget(sql, caretIn(sql, 'UInt32'), FUNCTIONS)).toEqual({ kind: 'data-type', name: 'UInt32' });
    });

    it('an INDEX entry in the column list is skipped (not treated as a column type)', () => {
      const sql = 'CREATE TABLE t (id UInt32, INDEX idx id TYPE minmax) ENGINE = Memory';
      expect(resolveDocTarget(sql, caretIn(sql, 'minmax'), FUNCTIONS)).toBeNull();
    });

    it('a TABLE statement with no column-list parens at all never resolves a column type (caret away from ENGINE)', () => {
      const sql = 'CREATE TABLE t ENGINE = Memory';
      expect(resolveDocTarget(sql, caretIn(sql, 't'), FUNCTIONS)).toBeNull();
    });
  });
});
