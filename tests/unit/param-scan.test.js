import { describe, it, expect } from 'vitest';
import { scanParamDeclarations, scanParamOccurrences } from '../../src/core/param-scan.js';
import { detectParams } from '../../src/core/query-params.js';

describe('scanParamDeclarations', () => {
  it('returns [] for empty / nullish input and paramless SQL', () => {
    expect(scanParamDeclarations('')).toEqual([]);
    expect(scanParamDeclarations(null)).toEqual([]);
    expect(scanParamDeclarations(undefined)).toEqual([]);
    expect(scanParamDeclarations('SELECT 1')).toEqual([]);
  });

  it('returns every occurrence, in appearance order, without dedup', () => {
    expect(scanParamDeclarations('SELECT {x:String} WHERE a = {x:String} AND b = {y:UInt8}')).toEqual([
      { name: 'x', type: 'String' },
      { name: 'x', type: 'String' },
      { name: 'y', type: 'UInt8' },
    ]);
  });

  it('keeps duplicate declarations with differing types (conflict detection input)', () => {
    expect(scanParamDeclarations('SELECT {id:UInt64}; SELECT {id:String}')).toEqual([
      { name: 'id', type: 'UInt64' },
      { name: 'id', type: 'String' },
    ]);
  });

  it('tolerates whitespace and nested-paren types', () => {
    expect(scanParamDeclarations('SELECT { m : Map(String, UInt8) }')).toEqual([
      { name: 'm', type: 'Map(String, UInt8)' },
    ]);
  });

  it('skips placeholders inside literals and comments', () => {
    expect(scanParamDeclarations("SELECT '{x:String}', \"{y:UInt8}\", `{z:UInt8}`")).toEqual([]);
    expect(scanParamDeclarations('SELECT 1 -- {x:String}\n /* {y:UInt8} */ # {z:UInt8}')).toEqual([]);
  });

  it('keeps a quoted `}` / `{` inside the type (#139) and skips the {{macro}} (#39)', () => {
    expect(scanParamDeclarations("SELECT {e:Enum8('}' = 1, 'ok' = 2)}, {{cte}}")).toEqual([
      { name: 'e', type: "Enum8('}' = 1, 'ok' = 2)" },
    ]);
    expect(scanParamDeclarations("SELECT {e:Enum8('{' = 1)}")).toEqual([
      { name: 'e', type: "Enum8('{' = 1)" },
    ]);
  });

  it('skips a brace with no closing }, a colon-less {}, and map literals', () => {
    expect(scanParamDeclarations('SELECT {x:String')).toEqual([]);
    expect(scanParamDeclarations('SELECT {cluster}')).toEqual([]);
    expect(scanParamDeclarations("SELECT {1:2}, {'k':'v'}")).toEqual([]);
  });
});

// #172 v2's paramComparisonColumns builds on this position data.
describe('scanParamOccurrences', () => {
  it('adds start/end char offsets of the whole {…} span, otherwise matching scanParamDeclarations', () => {
    const sql = 'SELECT {x:String} WHERE a = {y:UInt8}';
    const occs = scanParamOccurrences(sql);
    expect(occs).toEqual([
      { name: 'x', type: 'String', start: sql.indexOf('{x:String}'), end: sql.indexOf('{x:String}') + '{x:String}'.length },
      { name: 'y', type: 'UInt8', start: sql.indexOf('{y:UInt8}'), end: sql.indexOf('{y:UInt8}') + '{y:UInt8}'.length },
    ]);
    for (const o of occs) {
      expect(sql.slice(o.start, o.end)).toBe(`{${o.name}:${o.type}}`);
    }
    expect(scanParamDeclarations(sql)).toEqual(occs.map(({ name, type }) => ({ name, type })));
  });

  it('returns [] for empty / paramless SQL, same as the wrapper', () => {
    expect(scanParamOccurrences('')).toEqual([]);
    expect(scanParamOccurrences('SELECT 1')).toEqual([]);
  });
});

describe('detectParams wrapper equivalence', () => {
  it('detectParams is exactly scanParamDeclarations, first-wins deduped by name', () => {
    const samples = [
      'SELECT {x:String} WHERE a = {x:UInt8}',
      'SELECT {database:String}, {table:String}',
      'SELECT {a:Array(String)}, {m:Map(String, UInt8)}, {d:Decimal(10, 2)}',
      "SELECT '{x:String}', {z:UInt8}",
      'SELECT 1',
    ];
    for (const sql of samples) {
      const seen = new Set();
      const expected = scanParamDeclarations(sql).filter((p) => !seen.has(p.name) && seen.add(p.name));
      expect(detectParams(sql)).toEqual(expected);
    }
    // first type wins on a duplicate name
    expect(detectParams('SELECT {x:String} WHERE a = {x:UInt8}')).toEqual([{ name: 'x', type: 'String' }]);
  });
});
