import { describe, it, expect } from 'vitest';
import { selectOutputColumns } from '../../src/core/select-columns.js';

describe('selectOutputColumns', () => {
  it('returns [] for empty / null / undefined input', () => {
    expect(selectOutputColumns('')).toEqual([]);
    expect(selectOutputColumns(null)).toEqual([]);
    expect(selectOutputColumns(undefined)).toEqual([]);
  });

  it('returns [] when there is no top-level SELECT', () => {
    expect(selectOutputColumns('UPDATE t SET x = 1')).toEqual([]);
    expect(selectOutputColumns('   -- just a comment')).toEqual([]);
  });

  it('takes bare identifiers and AS aliases in order', () => {
    expect(selectOutputColumns('SELECT a, b AS c FROM t')).toEqual(['a', 'c']);
  });

  it('handles the real fixture: nested-function projection with SETTINGS tail', () => {
    const sql = "SELECT arraySort(groupUniqArray(initial_user)) AS user1 FROM merge(system, "
      + "'^query_log') WHERE type = 'QueryFinish' SETTINGS enable_named_columns_in_function_tuple = 1";
    expect(selectOutputColumns(sql)).toEqual(['user1']);
  });

  it('does not split on commas nested inside parens', () => {
    expect(selectOutputColumns('SELECT foo(a, b) AS x, bar(c, d) AS y FROM t')).toEqual(['x', 'y']);
  });

  it('does not let an AS inside a subquery/function leak out', () => {
    // The inner `AS y` is at paren depth 1 and must be ignored; the whole item
    // is an unaliased expression, so it contributes no name.
    expect(selectOutputColumns('SELECT (SELECT x AS y FROM t) FROM z')).toEqual([]);
    // With an outer alias, only the outer alias is taken.
    expect(selectOutputColumns('SELECT (SELECT x AS y FROM t) AS outer_col FROM z')).toEqual(['outer_col']);
    // CAST(... AS Type) AS alias — inner AS ignored, outer alias taken.
    expect(selectOutputColumns('SELECT CAST(x AS Int32) AS n FROM t')).toEqual(['n']);
  });

  it('skips a leading DISTINCT', () => {
    expect(selectOutputColumns('SELECT DISTINCT a, b FROM t')).toEqual(['a', 'b']);
    // A column whose name merely STARTS with "distinct" is not stripped.
    expect(selectOutputColumns('SELECT distinctColumn FROM t')).toEqual(['distinctColumn']);
  });

  it('takes the last segment of a dotted identifier', () => {
    expect(selectOutputColumns('SELECT t.col, db.tbl.other FROM t')).toEqual(['col', 'other']);
  });

  it('unquotes backticked / double-quoted aliases and identifiers', () => {
    expect(selectOutputColumns('SELECT x AS `my col` FROM t')).toEqual(['my col']);
    expect(selectOutputColumns('SELECT x AS "dq name" FROM t')).toEqual(['dq name']);
    expect(selectOutputColumns('SELECT `bare ident` FROM t')).toEqual(['bare ident']);
    expect(selectOutputColumns('SELECT "dq ident" FROM t')).toEqual(['dq ident']);
  });

  it('skips *, t.*, and unaliased expressions', () => {
    expect(selectOutputColumns('SELECT * FROM t')).toEqual([]);
    expect(selectOutputColumns('SELECT t.* FROM t')).toEqual([]);
    expect(selectOutputColumns('SELECT count(*) FROM t')).toEqual([]);
    expect(selectOutputColumns('SELECT 1 + 2 FROM t')).toEqual([]);
    expect(selectOutputColumns('SELECT 42 FROM t')).toEqual([]);
    expect(selectOutputColumns('SELECT a, count(*), b FROM t')).toEqual(['a', 'b']);
  });

  it('works with no FROM and other terminating clauses', () => {
    expect(selectOutputColumns('SELECT 1 AS n')).toEqual(['n']);
    expect(selectOutputColumns('SELECT a, b')).toEqual(['a', 'b']);
    expect(selectOutputColumns('SELECT a AS x WHERE 1')).toEqual(['x']);
    expect(selectOutputColumns('SELECT a AS x GROUP BY a')).toEqual(['x']);
  });

  it('ignores commas / from / as that appear inside string literals', () => {
    expect(selectOutputColumns("SELECT 'a,b' AS c, 'from' AS d FROM t")).toEqual(['c', 'd']);
    expect(selectOutputColumns("SELECT 'x as y' AS only FROM t")).toEqual(['only']);
  });

  it('is case-insensitive for keywords', () => {
    expect(selectOutputColumns('select a as b from t')).toEqual(['b']);
    expect(selectOutputColumns('SeLeCt DiStInCt a FrOm t')).toEqual(['a']);
  });

  it('degrades gracefully on malformed input (never throws)', () => {
    // Empty projection between SELECT and FROM.
    expect(selectOutputColumns('SELECT    FROM t')).toEqual([]);
    // Trailing comma → an empty final item, skipped.
    expect(selectOutputColumns('SELECT a, FROM t')).toEqual(['a']);
    // AS with nothing after it.
    expect(selectOutputColumns('SELECT x AS')).toEqual([]);
    // AS followed by an unclosed backtick.
    expect(selectOutputColumns('SELECT x AS `nope FROM t')).toEqual([]);
    // AS followed by an empty backtick/double-quote pair.
    expect(selectOutputColumns('SELECT x AS `` FROM t')).toEqual([]);
    expect(selectOutputColumns('SELECT x AS "" FROM t')).toEqual([]);
    // AS followed by a non-identifier (a number).
    expect(selectOutputColumns('SELECT a AS 9 FROM t')).toEqual([]);
    // Bare empty backtick / double-quote items.
    expect(selectOutputColumns('SELECT `` FROM t')).toEqual([]);
    expect(selectOutputColumns('SELECT "" FROM t')).toEqual([]);
  });
});
