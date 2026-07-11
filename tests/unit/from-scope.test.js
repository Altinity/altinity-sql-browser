import { describe, it, expect } from 'vitest';
import { fromScopeAt, pendingColumnLoads, resolveComparisonColumnType } from '../../src/core/from-scope.js';

// Caret at the end of the text unless a position is given — from-scope reads the
// whole statement, so the caret only selects which statement (not which clause).
const scope = (sql, pos = sql.length) => fromScopeAt(sql, pos);

describe('fromScopeAt — table references', () => {
  it('db.table', () => {
    expect(scope('SELECT * FROM db.tbl')).toEqual([{ db: 'db', table: 'tbl', alias: null }]);
  });
  it('bare table, no alias', () => {
    expect(scope('SELECT * FROM events')).toEqual([{ db: null, table: 'events', alias: null }]);
  });
  it('table alias (implicit)', () => {
    expect(scope('SELECT e.id FROM events e')).toEqual([{ db: null, table: 'events', alias: 'e' }]);
  });
  it('table AS alias (explicit)', () => {
    expect(scope('SELECT 1 FROM events AS e')).toEqual([{ db: null, table: 'events', alias: 'e' }]);
  });
  it('db.table AS alias', () => {
    expect(scope('SELECT 1 FROM db.events AS e')).toEqual([{ db: 'db', table: 'events', alias: 'e' }]);
  });
  it('comma-joined tables with mixed aliases', () => {
    expect(scope('SELECT * FROM a, b c')).toEqual([
      { db: null, table: 'a', alias: null },
      { db: null, table: 'b', alias: 'c' },
    ]);
  });
  it('explicit JOIN', () => {
    expect(scope('SELECT * FROM a JOIN b ON a.x = b.y')).toEqual([
      { db: null, table: 'a', alias: null },
      { db: null, table: 'b', alias: null },
    ]);
  });
  it('LEFT JOIN with aliases (multi-table scope, #84 acceptance)', () => {
    expect(scope('SELECT * FROM events e LEFT JOIN users u ON e.uid = u.id')).toEqual([
      { db: null, table: 'events', alias: 'e' },
      { db: null, table: 'users', alias: 'u' },
    ]);
  });
  it('a FINAL modifier is not read as an alias', () => {
    expect(scope('SELECT * FROM t FINAL')).toEqual([{ db: null, table: 't', alias: null }]);
  });
  it('backtick-quoted db/table/alias are unquoted', () => {
    expect(scope('SELECT * FROM `my db`.`my tbl` `al`')).toEqual([
      { db: 'my db', table: 'my tbl', alias: 'al' },
    ]);
  });
});

describe('fromScopeAt — things it must NOT scope (v1 non-goals)', () => {
  it('ARRAY JOIN unnests a column, not a table', () => {
    expect(scope('SELECT * FROM t ARRAY JOIN arr')).toEqual([{ db: null, table: 't', alias: null }]);
  });
  it('a table function (FROM numbers(10) n) is skipped', () => {
    expect(scope('SELECT * FROM numbers(10) n')).toEqual([]);
  });
  it('a derived subquery contributes its real base table, not the derived alias', () => {
    // Non-goal: subquery-output scoping. The inner base table is captured; the
    // outer alias `x` is not treated as a table.
    expect(scope('SELECT * FROM (SELECT * FROM raw) x')).toEqual([
      { db: null, table: 'raw', alias: null },
    ]);
  });
  it('USING is not read as an alias', () => {
    expect(scope('SELECT * FROM a JOIN b USING (id)')).toEqual([
      { db: null, table: 'a', alias: null },
      { db: null, table: 'b', alias: null },
    ]);
  });
});

describe('fromScopeAt — strings/comments never fool the parse', () => {
  it('a FROM inside a line comment is ignored', () => {
    expect(scope('SELECT * FROM real -- FROM fake\nWHERE x')).toEqual([
      { db: null, table: 'real', alias: null },
    ]);
  });
  it('a FROM inside a block comment is ignored', () => {
    expect(scope('SELECT * /* FROM fake */ FROM real')).toEqual([
      { db: null, table: 'real', alias: null },
    ]);
  });
  it('a FROM inside a string literal is ignored', () => {
    expect(scope("SELECT 'FROM x' FROM t")).toEqual([{ db: null, table: 't', alias: null }]);
  });
});

describe('fromScopeAt — statement selection', () => {
  const two = 'SELECT * FROM a;\nSELECT * FROM b';
  it('caret in the first statement scopes to its FROM', () => {
    expect(fromScopeAt(two, 10)).toEqual([{ db: null, table: 'a', alias: null }]);
  });
  it('caret in the second statement scopes to its FROM', () => {
    expect(fromScopeAt(two, two.length)).toEqual([{ db: null, table: 'b', alias: null }]);
  });
  it('a ; inside a string does not split statements', () => {
    expect(scope("SELECT ';' FROM t")).toEqual([{ db: null, table: 't', alias: null }]);
  });
});

describe('fromScopeAt — edges', () => {
  it('no FROM → empty', () => {
    expect(scope('SELECT 1 + 2')).toEqual([]);
  });
  it('empty / null text → empty', () => {
    expect(fromScopeAt('', 0)).toEqual([]);
    expect(fromScopeAt(null, 5)).toEqual([]);
  });
  it('a caret past the end clamps to the last statement', () => {
    expect(fromScopeAt('SELECT * FROM t', 999)).toEqual([{ db: null, table: 't', alias: null }]);
  });
  it('a negative caret clamps to the start', () => {
    expect(fromScopeAt('SELECT * FROM t', -5)).toEqual([{ db: null, table: 't', alias: null }]);
  });
  it('duplicate refs (self-comma) are deduped', () => {
    expect(scope('SELECT * FROM a, a')).toEqual([{ db: null, table: 'a', alias: null }]);
  });
  it('FROM at end of input with no table', () => {
    expect(scope('SELECT * FROM ')).toEqual([]);
  });
});

describe('pendingColumnLoads', () => {
  const schema = [
    { db: 'app', tables: [
      { name: 'events', columns: null },            // needs load
      { name: 'users', columns: [{ name: 'id' }] }, // already loaded
      { name: 'busy', columns: 'loading' },         // in flight
      { name: 'nocols' },                           // columns key absent → needs load
    ] },
    { db: 'other', tables: [{ name: 'events', columns: null }] },
    { db: 'nolist' },                               // db.tables undefined
  ];

  it('returns unqualified matches across every db that has the table (null columns)', () => {
    expect(pendingColumnLoads([{ db: null, table: 'events' }], schema)).toEqual([
      { db: 'app', table: 'events' },
      { db: 'other', table: 'events' },
    ]);
  });
  it('honours a db qualifier', () => {
    expect(pendingColumnLoads([{ db: 'app', table: 'events' }], schema)).toEqual([
      { db: 'app', table: 'events' },
    ]);
  });
  it('skips already-loaded (array) and in-flight (loading) columns', () => {
    expect(pendingColumnLoads([{ db: 'app', table: 'users' }], schema)).toEqual([]);
    expect(pendingColumnLoads([{ db: 'app', table: 'busy' }], schema)).toEqual([]);
  });
  it('treats a missing columns key as needing a load', () => {
    expect(pendingColumnLoads([{ db: 'app', table: 'nocols' }], schema)).toEqual([
      { db: 'app', table: 'nocols' },
    ]);
  });
  it('unknown table / null schema / null scope → empty', () => {
    expect(pendingColumnLoads([{ db: 'app', table: 'nope' }], schema)).toEqual([]);
    expect(pendingColumnLoads([{ table: 'events' }], null)).toEqual([]);
    expect(pendingColumnLoads(null, schema)).toEqual([]);
  });
  it('skips refs without a table name', () => {
    expect(pendingColumnLoads([{ db: null, table: null }], schema)).toEqual([]);
  });
  it('dedupes repeated refs to one load per db+table', () => {
    expect(pendingColumnLoads([{ table: 'events' }, { table: 'events' }], schema)).toEqual([
      { db: 'app', table: 'events' },
      { db: 'other', table: 'events' },
    ]);
  });
});

// #172 v2: resolving a paramComparisonColumns syntactic ref against the FROM
// scope + the loaded schema cache — the last step before the schema-cache
// enum suggestion can show up.
describe('resolveComparisonColumnType', () => {
  const ENUM_STATUS = "Enum8('active' = 1, 'deleted' = 2)";
  const schemaWith = (columns) => [
    { db: 'app', tables: [{ name: 'events', columns }] },
  ];

  it('resolves an unqualified column in a single-table statement', () => {
    const sql = 'SELECT * FROM events WHERE status = {s:String}';
    const schema = schemaWith([{ name: 'status', type: ENUM_STATUS }]);
    expect(resolveComparisonColumnType(sql, sql.length, { qualifier: null, column: 'status' }, schema)).toBe(ENUM_STATUS);
  });

  it('resolves an aliased/qualified column via its FROM alias', () => {
    const sql = 'SELECT * FROM events e WHERE e.status = {s:String}';
    const schema = schemaWith([{ name: 'status', type: ENUM_STATUS }]);
    expect(resolveComparisonColumnType(sql, sql.length, { qualifier: 'e', column: 'status' }, schema)).toBe(ENUM_STATUS);
  });

  it('resolves a qualifier that is the bare table name (no alias used)', () => {
    const sql = 'SELECT * FROM events WHERE events.status = {s:String}';
    const schema = schemaWith([{ name: 'status', type: ENUM_STATUS }]);
    expect(resolveComparisonColumnType(sql, sql.length, { qualifier: 'events', column: 'status' }, schema)).toBe(ENUM_STATUS);
  });

  it('unqualified + more than one table in scope (JOIN) is ambiguous → null', () => {
    const sql = 'SELECT * FROM events e JOIN other o ON 1=1 WHERE status = {s:String}';
    const schema = schemaWith([{ name: 'status', type: ENUM_STATUS }]);
    expect(resolveComparisonColumnType(sql, sql.length, { qualifier: null, column: 'status' }, schema)).toBeNull();
  });

  it('a qualifier that matches no in-scope alias/table → null', () => {
    const sql = 'SELECT * FROM events e WHERE x.status = {s:String}';
    const schema = schemaWith([{ name: 'status', type: ENUM_STATUS }]);
    expect(resolveComparisonColumnType(sql, sql.length, { qualifier: 'x', column: 'status' }, schema)).toBeNull();
  });

  it('a column not yet loaded (columns null/loading) → null', () => {
    const sql = 'SELECT * FROM events WHERE status = {s:String}';
    expect(resolveComparisonColumnType(sql, sql.length, { qualifier: null, column: 'status' }, schemaWith(null))).toBeNull();
    expect(resolveComparisonColumnType(sql, sql.length, { qualifier: null, column: 'status' }, schemaWith('loading'))).toBeNull();
  });

  it('a column that does not exist on the resolved table → null', () => {
    const sql = 'SELECT * FROM events WHERE nope = {s:String}';
    const schema = schemaWith([{ name: 'status', type: ENUM_STATUS }]);
    expect(resolveComparisonColumnType(sql, sql.length, { qualifier: null, column: 'nope' }, schema)).toBeNull();
  });

  it('an unqualified column resolves across every same-named db table when they agree', () => {
    const sql = 'SELECT * FROM events WHERE status = {s:String}';
    const schema = [
      { db: 'app', tables: [{ name: 'events', columns: [{ name: 'status', type: ENUM_STATUS }] }] },
      { db: 'other', tables: [{ name: 'events', columns: [{ name: 'status', type: ENUM_STATUS }] }] },
    ];
    expect(resolveComparisonColumnType(sql, sql.length, { qualifier: null, column: 'status' }, schema)).toBe(ENUM_STATUS);
  });

  it('conflicting types for the same unqualified column across dbs → null (not guessed at)', () => {
    const sql = 'SELECT * FROM events WHERE status = {s:String}';
    const schema = [
      { db: 'app', tables: [{ name: 'events', columns: [{ name: 'status', type: ENUM_STATUS }] }] },
      { db: 'other', tables: [{ name: 'events', columns: [{ name: 'status', type: 'String' }] }] },
    ];
    expect(resolveComparisonColumnType(sql, sql.length, { qualifier: null, column: 'status' }, schema)).toBeNull();
  });

  it('an empty scope (no FROM at all) → null', () => {
    expect(resolveComparisonColumnType('SELECT {s:String}', 5, { qualifier: null, column: 'status' }, schemaWith([{ name: 'status', type: ENUM_STATUS }]))).toBeNull();
  });

  it('a null/undefined schema resolves to null without throwing', () => {
    const sql = 'SELECT * FROM events WHERE status = {s:String}';
    expect(resolveComparisonColumnType(sql, sql.length, { qualifier: null, column: 'status' }, null)).toBeNull();
    expect(resolveComparisonColumnType(sql, sql.length, { qualifier: null, column: 'status' }, undefined)).toBeNull();
  });

  it('a db-qualified FROM (candidate.db set) only matches the schema entry with that db', () => {
    const sql = 'SELECT * FROM app.events e WHERE e.status = {s:String}';
    const schema = [
      { db: 'app', tables: [{ name: 'events', columns: [{ name: 'status', type: ENUM_STATUS }] }] },
      { db: 'other', tables: [{ name: 'events', columns: [{ name: 'status', type: 'String' }] }] },
    ];
    expect(resolveComparisonColumnType(sql, sql.length, { qualifier: 'e', column: 'status' }, schema)).toBe(ENUM_STATUS);
  });

  it('a schema entry with no tables list at all is tolerated (skipped, not thrown on)', () => {
    const sql = 'SELECT * FROM events WHERE status = {s:String}';
    const schema = [
      { db: 'nolist' },
      { db: 'app', tables: [{ name: 'events', columns: [{ name: 'status', type: ENUM_STATUS }] }] },
    ];
    expect(resolveComparisonColumnType(sql, sql.length, { qualifier: null, column: 'status' }, schema)).toBe(ENUM_STATUS);
  });

  // Review F3: multi-ref refs (same column name, different qualifier text —
  // param-comparison.js now defers those instead of calling CONFLICT on raw
  // qualifier inequality) match only when every ref resolves to the SAME table.
  describe('multi-ref (refs) resolved-identity comparison (review F3)', () => {
    const refsFor = (sql, quals) => ({
      qualifier: quals[0], column: 'status', pos: sql.indexOf('{s:'),
      refs: quals.map((q, i) => ({
        qualifier: q, column: 'status',
        pos: i === 0 ? sql.indexOf('{s:') : sql.lastIndexOf('{s:'),
      })),
    });

    it('alias-qualified + unqualified refs to the same single-table column match', () => {
      const sql = 'SELECT * FROM events e WHERE e.status = {s:String} OR status = {s:String}';
      const schema = schemaWith([{ name: 'status', type: ENUM_STATUS }]);
      expect(resolveComparisonColumnType(sql, sql.indexOf('{s:'), refsFor(sql, ['e', null]), schema)).toBe(ENUM_STATUS);
    });

    it('refs resolving to the two sides of a JOIN (genuinely different tables) → null', () => {
      const sql = 'SELECT * FROM events x JOIN other y ON 1=1 WHERE x.status = {s:String} OR y.status = {s:String}';
      const schema = [
        { db: 'app', tables: [
          { name: 'events', columns: [{ name: 'status', type: ENUM_STATUS }] },
          { name: 'other', columns: [{ name: 'status', type: ENUM_STATUS }] },
        ] },
      ];
      expect(resolveComparisonColumnType(sql, sql.indexOf('{s:'), refsFor(sql, ['x', 'y']), schema)).toBeNull();
    });

    it('one unresolvable ref (ambiguous unqualified in a JOIN) nulls the whole match — conservative', () => {
      const sql = 'SELECT * FROM events e JOIN other o ON 1=1 WHERE e.status = {s:String} OR status = {s:String}';
      const schema = [
        { db: 'app', tables: [
          { name: 'events', columns: [{ name: 'status', type: ENUM_STATUS }] },
          { name: 'other', columns: [] },
        ] },
      ];
      expect(resolveComparisonColumnType(sql, sql.indexOf('{s:'), refsFor(sql, ['e', null]), schema)).toBeNull();
    });
  });
});
