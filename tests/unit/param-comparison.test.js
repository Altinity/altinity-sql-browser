import { describe, it, expect } from 'vitest';
import { paramComparisonColumns } from '../../src/core/param-comparison.js';

const posOf = (sql, name) => sql.indexOf('{' + name + ':');

describe('paramComparisonColumns (#172 v2 heuristic)', () => {
  it('returns {} for SQL with no parameters at all', () => {
    expect(paramComparisonColumns('SELECT 1')).toEqual({});
  });

  it('returns {} for empty / nullish input', () => {
    expect(paramComparisonColumns('')).toEqual({});
    expect(paramComparisonColumns(null)).toEqual({});
    expect(paramComparisonColumns(undefined)).toEqual({});
  });

  it('a bare unqualified column compared via = (right side)', () => {
    const sql = 'SELECT * FROM events WHERE status = {s:String}';
    expect(paramComparisonColumns(sql)).toEqual({
      s: { qualifier: null, column: 'status', pos: posOf(sql, 's') },
    });
  });

  it('a bare unqualified column compared via = (param on the left)', () => {
    const sql = 'SELECT * FROM events WHERE {s:String} = status';
    expect(paramComparisonColumns(sql)).toEqual({
      s: { qualifier: null, column: 'status', pos: posOf(sql, 's') },
    });
  });

  it('a qualified/aliased column (alias.col)', () => {
    const sql = 'SELECT * FROM events e WHERE e.status = {s:String}';
    expect(paramComparisonColumns(sql)).toEqual({
      s: { qualifier: 'e', column: 'status', pos: posOf(sql, 's') },
    });
  });

  it('a qualified column, param on the left (table.col = {p} reversed)', () => {
    const sql = 'SELECT * FROM events e WHERE {s:String} = e.status';
    expect(paramComparisonColumns(sql)).toEqual({
      s: { qualifier: 'e', column: 'status', pos: posOf(sql, 's') },
    });
  });

  it('a backtick-quoted column name unquotes cleanly', () => {
    const sql = 'SELECT * FROM t WHERE `my col` = {s:String}';
    expect(paramComparisonColumns(sql)).toEqual({
      s: { qualifier: null, column: 'my col', pos: posOf(sql, 's') },
    });
  });

  it('multiple independent params each get their own match', () => {
    const sql = 'SELECT * FROM t WHERE a = {p1:String} AND b = {p2:String}';
    expect(paramComparisonColumns(sql)).toEqual({
      p1: { qualifier: null, column: 'a', pos: posOf(sql, 'p1') },
      p2: { qualifier: null, column: 'b', pos: posOf(sql, 'p2') },
    });
  });

  it('IN {p} yields no match (not a direct equality)', () => {
    const sql = 'SELECT * FROM t WHERE status IN {p:Array(String)}';
    expect(paramComparisonColumns(sql)).toEqual({});
  });

  it('BETWEEN {p1} AND {p2} yields no match', () => {
    const sql = 'SELECT * FROM t WHERE age BETWEEN {lo:UInt8} AND {hi:UInt8}';
    expect(paramComparisonColumns(sql)).toEqual({});
  });

  it('an expression around the column yields no match (a builtin-func call, e.g. lower(col) = {p})', () => {
    const sql = "SELECT * FROM t WHERE lower(status) = {p:String}";
    expect(paramComparisonColumns(sql)).toEqual({});
  });

  it('a non-builtin function call is also rejected, reversed ({p} = foo(col)) — the "followed by (" check itself, not just the func-keyword classification', () => {
    const sql = "SELECT * FROM t WHERE {p:String} = foo(status)";
    expect(paramComparisonColumns(sql)).toEqual({});
  });

  it('a qualified reference immediately followed by ( is also rejected (foo.col(x) = {p})', () => {
    const sql = "SELECT * FROM t WHERE {p:String} = foo.status(x)";
    expect(paramComparisonColumns(sql)).toEqual({});
  });

  it('!= and <= are not mistaken for = (per-char tokenization keeps them adjacent-distinct)', () => {
    expect(paramComparisonColumns('SELECT * FROM t WHERE status != {p:String}')).toEqual({});
    expect(paramComparisonColumns('SELECT * FROM t WHERE age <= {p:UInt8}')).toEqual({});
    expect(paramComparisonColumns('SELECT * FROM t WHERE age >= {p:UInt8}')).toEqual({});
  });

  it('the same param compared to the SAME column twice is not a conflict', () => {
    const sql = 'SELECT * FROM t WHERE status = {p:String} OR status = {p:String}';
    expect(paramComparisonColumns(sql)).toEqual({
      p: { qualifier: null, column: 'status', pos: posOf(sql, 'p') },
    });
  });

  it('the same param compared to two DIFFERENT columns yields no match', () => {
    const sql = 'SELECT * FROM t WHERE a = {p:String} OR b = {p:String}';
    expect(paramComparisonColumns(sql)).toEqual({});
  });

  it('a conflict, once recorded, is not un-recorded by a third occurrence matching either earlier column', () => {
    const sql = 'SELECT * FROM t WHERE a = {p:String} OR b = {p:String} OR a = {p:String}';
    expect(paramComparisonColumns(sql)).toEqual({});
  });

  it('the same column NAME under different qualifiers is NOT a syntactic conflict — every distinct ref is returned for resolved-identity comparison (review F3)', () => {
    // Two JOIN sides: both refs come back; from-scope.js's resolution (which
    // resolves x → a and y → b, different tables) is what yields "no match".
    const sql = 'SELECT * FROM a x JOIN b y ON 1=1 WHERE x.status = {p:String} OR y.status = {p:String}';
    expect(paramComparisonColumns(sql)).toEqual({
      p: {
        qualifier: 'x', column: 'status', pos: posOf(sql, 'p'),
        refs: [
          { qualifier: 'x', column: 'status', pos: sql.indexOf('{p:') },
          { qualifier: 'y', column: 'status', pos: sql.lastIndexOf('{p:') },
        ],
      },
    });
  });

  it('alias-qualified + unqualified refs to the same column both come back (single-ref shape preserved when they agree)', () => {
    const sql = 'SELECT * FROM events e WHERE e.status = {p:String} OR status = {p:String}';
    const out = paramComparisonColumns(sql);
    expect(out.p.refs).toEqual([
      { qualifier: 'e', column: 'status', pos: sql.indexOf('{p:') },
      { qualifier: null, column: 'status', pos: sql.lastIndexOf('{p:') },
    ]);
    // The top-level fields mirror the FIRST reference (back-compat shape).
    expect(out.p.qualifier).toBe('e');
    expect(out.p.column).toBe('status');
    expect(out.p.pos).toBe(sql.indexOf('{p:'));
  });

  it('repeated identical qualifier spellings dedupe — refs stays a single entry, so no `refs` field at all', () => {
    const sql = 'SELECT * FROM t WHERE e.status = {p:String} OR e.status = {p:String}';
    expect(paramComparisonColumns(sql)).toEqual({
      p: { qualifier: 'e', column: 'status', pos: posOf(sql, 'p') },
    });
  });

  it('a column-NAME conflict still wins over any accumulated qualifier variants', () => {
    const sql = 'SELECT * FROM t WHERE e.status = {p:String} OR status = {p:String} OR other = {p:String}';
    expect(paramComparisonColumns(sql)).toEqual({});
  });

  it("an Enum type's own internal = (member = code) is never mistaken for an outer comparison", () => {
    const sql = "SELECT * FROM t WHERE status = {s:Enum8('active' = 1, 'deleted' = 2)}";
    expect(paramComparisonColumns(sql)).toEqual({
      s: { qualifier: null, column: 'status', pos: posOf(sql, 's') },
    });
  });

  it('a param compared to a literal, not a column, yields no match ({p} = 5)', () => {
    expect(paramComparisonColumns('SELECT * FROM t WHERE {p:UInt8} = 5')).toEqual({});
  });

  it('a param with no comparison at all (just selected) yields no match', () => {
    expect(paramComparisonColumns('SELECT {p:String}')).toEqual({});
  });

  it('two statements: independent matches per param name, still requires overall consistency', () => {
    const sql = 'SELECT * FROM t WHERE a = {p:String}; SELECT * FROM t WHERE a = {p:String}';
    expect(paramComparisonColumns(sql)).toEqual({
      p: { qualifier: null, column: 'a', pos: posOf(sql, 'p') },
    });
  });
});
