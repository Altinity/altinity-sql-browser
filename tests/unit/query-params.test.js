import { describe, it, expect } from 'vitest';
import {
  detectParams,
  readStatementParams,
  paramArgs,
  unfilledParams,
  missingValues,
} from '../../src/core/query-params.js';

describe('detectParams', () => {
  it('returns [] for empty / nullish input', () => {
    expect(detectParams('')).toEqual([]);
    expect(detectParams(null)).toEqual([]);
    expect(detectParams(undefined)).toEqual([]);
    expect(detectParams('SELECT 1')).toEqual([]);
  });

  it('detects a single {name:Type} placeholder', () => {
    expect(detectParams('SELECT {id:UInt32}')).toEqual([{ name: 'id', type: 'UInt32' }]);
  });

  it('detects several placeholders in first-appearance order', () => {
    expect(detectParams('SELECT {database:String}, {table:String}')).toEqual([
      { name: 'database', type: 'String' },
      { name: 'table', type: 'String' },
    ]);
  });

  it('dedupes by name, keeping the first type seen', () => {
    expect(detectParams('SELECT {x:String} WHERE a = {x:UInt8}')).toEqual([
      { name: 'x', type: 'String' },
    ]);
  });

  it('handles nested-paren types (Array / Map / Tuple / Decimal)', () => {
    expect(detectParams('SELECT {a:Array(String)}, {m:Map(String, UInt8)}, {d:Decimal(10, 2)}')).toEqual([
      { name: 'a', type: 'Array(String)' },
      { name: 'm', type: 'Map(String, UInt8)' },
      { name: 'd', type: 'Decimal(10, 2)' },
    ]);
  });

  it('tolerates whitespace around name / colon / type', () => {
    expect(detectParams('SELECT { id : UInt32 }')).toEqual([{ name: 'id', type: 'UInt32' }]);
  });

  it('accepts an underscore-led identifier', () => {
    expect(detectParams('SELECT {_p:String}')).toEqual([{ name: '_p', type: 'String' }]);
  });

  it('ignores placeholders inside single-quoted string literals', () => {
    expect(detectParams("SELECT '{x:String}'")).toEqual([]);
  });

  it('honors backslash and doubled-quote escapes inside strings', () => {
    expect(detectParams("SELECT '\\'{x:String}', 'it''s {y:UInt8}'")).toEqual([]);
    // a real param after a string with escapes is still found
    expect(detectParams("SELECT 'a''b', {z:UInt8}")).toEqual([{ name: 'z', type: 'UInt8' }]);
  });

  it('ignores placeholders inside double-quoted and backtick identifiers', () => {
    expect(detectParams('SELECT "{x:String}", `{y:UInt8}`')).toEqual([]);
  });

  it('ignores placeholders inside -- and # line comments', () => {
    expect(detectParams('SELECT 1 -- {x:String}\n, {y:UInt8}')).toEqual([{ name: 'y', type: 'UInt8' }]);
    expect(detectParams('SELECT 1 # {x:String}\n, {y:UInt8}')).toEqual([{ name: 'y', type: 'UInt8' }]);
  });

  it('ignores placeholders inside a line comment that runs to EOF', () => {
    expect(detectParams('SELECT 1 -- {x:String}')).toEqual([]);
  });

  it('ignores placeholders inside /* */ block comments', () => {
    expect(detectParams('SELECT /* {x:String} */ {y:UInt8}')).toEqual([{ name: 'y', type: 'UInt8' }]);
  });

  it('tolerates an unterminated block comment (runs to EOF)', () => {
    expect(detectParams('SELECT 1 /* {x:String}')).toEqual([]);
  });

  it('tolerates an unterminated string (runs to EOF)', () => {
    expect(detectParams("SELECT '{x:String}")).toEqual([]);
  });

  it('does not treat a map literal {key:value} as a parameter', () => {
    expect(detectParams('SELECT {1:2}')).toEqual([]);
    expect(detectParams("SELECT {'k':'v'}")).toEqual([]);
  });

  it('does not treat the {{name}} composable macro (#39) as a parameter', () => {
    expect(detectParams('SELECT {{cte}}')).toEqual([]);
  });

  it('skips a brace with no closing } (runs to EOF)', () => {
    expect(detectParams('SELECT {x:String')).toEqual([]);
  });

  it('skips a {} with no colon', () => {
    expect(detectParams('SELECT {cluster}')).toEqual([]);
  });

  it('keeps a `}` inside a quoted portion of the type (#139)', () => {
    // The `'}'` is a string literal inside the Enum type — it must not close the
    // placeholder early. Before the shared span-scanner this yielded a truncated
    // type of `Enum8('`.
    expect(detectParams("SELECT {e:Enum8('}' = 1, 'ok' = 2)}")).toEqual([
      { name: 'e', type: "Enum8('}' = 1, 'ok' = 2)" },
    ]);
  });

  it('keeps a `{` inside a quoted portion of the type (#139)', () => {
    // A `{` inside a literal is passthrough, so it does not read as a nested
    // brace that would bail out of the placeholder.
    expect(detectParams("SELECT {e:Enum8('{' = 1)}")).toEqual([
      { name: 'e', type: "Enum8('{' = 1)" },
    ]);
  });
});

describe('readStatementParams', () => {
  it('collects params from a bare SELECT', () => {
    expect(readStatementParams('SELECT {database:String}, {table:String}')).toEqual([
      { name: 'database', type: 'String' },
      { name: 'table', type: 'String' },
    ]);
  });

  it('collects params from a WITH … SELECT (the issue example)', () => {
    const sql = 'WITH {database:String} AS p_database, {table:String} AS p_table SELECT 1';
    expect(readStatementParams(sql)).toEqual([
      { name: 'database', type: 'String' },
      { name: 'table', type: 'String' },
    ]);
  });

  it('collects params from EXPLAIN of a read', () => {
    expect(readStatementParams('EXPLAIN SELECT {x:UInt8}')).toEqual([{ name: 'x', type: 'UInt8' }]);
  });

  it('omits params that appear only in a CREATE VIEW definition', () => {
    expect(readStatementParams('CREATE VIEW v AS SELECT {x:String}')).toEqual([]);
  });

  it('omits params from INSERT / DDL statements', () => {
    expect(readStatementParams('INSERT INTO t SELECT {x:String}')).toEqual([]);
  });

  it('unions read-statement params across a script, unique by name', () => {
    const sql = 'CREATE VIEW v AS SELECT {v:String}; SELECT {a:UInt8}; SELECT {a:UInt8}, {b:String}';
    expect(readStatementParams(sql)).toEqual([
      { name: 'a', type: 'UInt8' },
      { name: 'b', type: 'String' },
    ]);
  });
});

describe('paramArgs', () => {
  it('builds param_<name> args for a read statement', () => {
    expect(paramArgs('SELECT {database:String}, {table:String}', { database: 'default', table: 'events' }))
      .toEqual({ param_database: 'default', param_table: 'events' });
  });

  it('returns {} for a non-row-returning statement (view / DDL preserved)', () => {
    expect(paramArgs('CREATE VIEW v AS SELECT {x:String}', { x: 'default' })).toEqual({});
    expect(paramArgs('INSERT INTO t SELECT {x:String}', { x: 'default' })).toEqual({});
  });

  it('skips absent and empty values', () => {
    expect(paramArgs('SELECT {a:String}, {b:String}, {c:String}', { a: 'x', b: '' })).toEqual({ param_a: 'x' });
    expect(paramArgs('SELECT {a:String}', null)).toEqual({});
  });

  it('keeps a "0" value (falsy but present)', () => {
    expect(paramArgs('SELECT {n:UInt8}', { n: '0' })).toEqual({ param_n: '0' });
  });
});

describe('missingValues', () => {
  it('lists the names in an already-detected list with no value', () => {
    const params = [{ name: 'a', type: 'String' }, { name: 'b', type: 'String' }];
    expect(missingValues(params, { a: 'x' })).toEqual(['b']);
    expect(missingValues(params, { a: 'x', b: '' })).toEqual(['b']);
    expect(missingValues(params, { a: 'x', b: 'y' })).toEqual([]);
    expect(missingValues(params, null)).toEqual(['a', 'b']);
    expect(missingValues([], { a: 'x' })).toEqual([]);
  });
});

describe('unfilledParams', () => {
  it('lists read-statement params with no value', () => {
    expect(unfilledParams('SELECT {a:String}, {b:String}', { a: 'x' })).toEqual(['b']);
  });

  it('treats an empty-string value as unfilled', () => {
    expect(unfilledParams('SELECT {a:String}', { a: '' })).toEqual(['a']);
  });

  it('is empty when every param is filled', () => {
    expect(unfilledParams('SELECT {a:String}', { a: 'x' })).toEqual([]);
  });

  it('is empty when the query has no params', () => {
    expect(unfilledParams('SELECT 1', {})).toEqual([]);
    expect(unfilledParams('SELECT {x:String}', null)).toEqual(['x']);
  });

  it('ignores params confined to a VIEW definition', () => {
    expect(unfilledParams('CREATE VIEW v AS SELECT {x:String}', {})).toEqual([]);
  });
});
