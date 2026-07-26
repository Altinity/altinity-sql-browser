// #447 phase 2: the Dashboard variable OPTION SQL contract — local validation,
// the one-request `UNION ALL` compiler, and the positional response reader.
//
// The compiled SQL is asserted as literal text (the repo convention — no
// snapshots), because the shape is the contract: branch order, the nested
// subquery, the per-branch LIMIT and the escaped tag are each load-bearing and a
// silent change to any of them is a runtime bug the type checker cannot see.

import { describe, it, expect } from 'vitest';
import {
  VARIABLE_OPTION_BYTE_CAP, VARIABLE_OPTION_CAP,
  compileVariableOptionBatch, isOptionColumnType, normalizeOptionSql,
  optionBatchVariables, optionSqlDiagnostics, readVariableOptionBatch,
  validateOptionColumns,
} from '../../src/core/variable-options.js';
import type { DashboardVariable } from '../../src/core/dashboard-variables.js';

/** A bindable (active) variable carrying option SQL, unless overridden. */
const variable = (over: Partial<DashboardVariable> & { name: string }): DashboardVariable => ({
  status: 'active',
  types: ['String'],
  type: 'String',
  declarations: [{ name: over.name, type: 'String', tileId: 't1', queryId: 'q1' }],
  sql: null,
  diagnostic: null,
  ...over,
});

const codes = (sql?: string | null): string[] => optionSqlDiagnostics(sql).map((d) => d.code);

describe('normalizeOptionSql', () => {
  it('strips trailing whitespace, semicolons and comments so the text can be embedded', () => {
    expect(normalizeOptionSql('SELECT 1, 2  ')).toBe('SELECT 1, 2');
    expect(normalizeOptionSql('SELECT 1, 2;')).toBe('SELECT 1, 2');
    // A regex for `/;\s*$/` misses both of these, and each one breaks the whole
    // generated batch rather than just its own branch.
    expect(normalizeOptionSql('SELECT 1, 2;;')).toBe('SELECT 1, 2');
    expect(normalizeOptionSql('SELECT 1, 2; -- note')).toBe('SELECT 1, 2');
    expect(normalizeOptionSql('SELECT 1, 2 -- note')).toBe('SELECT 1, 2');
  });

  it('leaves an unterminated block comment in place rather than repairing it', () => {
    // Stripping it would turn knowably-malformed SQL into something that runs.
    expect(normalizeOptionSql('SELECT 1, 2 /* open')).toBe('SELECT 1, 2 /* open');
  });

  it('never touches a semicolon inside a string literal', () => {
    expect(normalizeOptionSql("SELECT 'a;b', 'l'")).toBe("SELECT 'a;b', 'l'");
  });
});

describe('optionSqlDiagnostics', () => {
  it('accepts a two-column read query', () => {
    expect(codes('SELECT toString(id), name FROM countries ORDER BY name')).toEqual([]);
  });

  it('accepts WITH … SELECT', () => {
    expect(codes('WITH c AS (SELECT 1 AS id) SELECT toString(id), toString(id) FROM c')).toEqual([]);
  });

  it('reports blank SQL', () => {
    expect(codes('')).toEqual(['variable-option-sql-empty']);
    expect(codes('   \n  ')).toEqual(['variable-option-sql-empty']);
    expect(codes(null)).toEqual(['variable-option-sql-empty']);
    // Comment-only SQL normalizes away to nothing at all.
    expect(codes('-- just a note')).toEqual(['variable-option-sql-empty']);
  });

  it('rejects multiple statements', () => {
    expect(codes('SELECT 1, 2; SELECT 3, 4')).toEqual(['variable-option-statement-count']);
  });

  it('rejects a non-SELECT statement, including the row-returning ones that cannot nest', () => {
    // `isRowReturning` admits all of these; a subquery does not, so admitting
    // them here would move the failure into the combined batch and take every
    // other variable down with it.
    expect(codes('SHOW TABLES')).toEqual(['variable-option-not-select']);
    expect(codes('DESCRIBE TABLE t')).toEqual(['variable-option-not-select']);
    expect(codes('EXPLAIN SELECT 1')).toEqual(['variable-option-not-select']);
    expect(codes('INSERT INTO t VALUES (1)')).toEqual(['variable-option-not-select']);
  });

  it('rejects non-embeddable output clauses', () => {
    expect(codes('SELECT a, b FROM t FORMAT JSON')).toEqual(['variable-option-format']);
    expect(codes("SELECT a, b FROM t INTO OUTFILE 'x.tsv'")).toEqual(['variable-option-outfile']);
  });

  it('rejects any {name:Type} placeholder with the no-cascading message', () => {
    const found = optionSqlDiagnostics('SELECT toString(id), name FROM cities WHERE country = {country:String}');
    expect(found.map((d) => d.code)).toEqual(['variable-option-parameterized']);
    expect(found[0].message).toBe('Variable option queries cannot reference Dashboard variables yet.');
  });

  it('finds a placeholder hidden inside an optional block', () => {
    // #165 blocks read as comments to a raw lexical scan. Phase 1 hit the mirror
    // image of this bug in inference; without scanning the analysis view the
    // no-cascading rule passes here and the block is then embedded as a literal
    // comment, silently dropping its content from what runs.
    expect(codes('SELECT toString(id), name FROM cities /*[ WHERE c = {country:String} ]*/'))
      .toEqual(['variable-option-parameterized']);
  });

  it('ignores a placeholder-looking string literal', () => {
    expect(codes("SELECT '{country:String}', 'label'")).toEqual([]);
  });

  it('reports every finding at once rather than stopping at the first', () => {
    expect(codes('SHOW TABLES FORMAT JSON')).toEqual([
      'variable-option-not-select', 'variable-option-format',
    ]);
  });
});

describe('optionBatchVariables', () => {
  it('keeps active, configured, locally-acceptable variables in inference order', () => {
    const picked = optionBatchVariables([
      variable({ name: 'country', sql: 'SELECT a, b FROM c' }),
      variable({ name: 'city', sql: 'SELECT a, b FROM d' }),
    ]);
    expect(picked.map((v) => v.name)).toEqual(['country', 'city']);
  });

  it('excludes an unconfigured variable', () => {
    expect(optionBatchVariables([variable({ name: 'country', sql: null })])).toEqual([]);
  });

  it('excludes conflicted and orphaned variables even when configured', () => {
    const excluded = optionBatchVariables([
      variable({ name: 'conflicted', status: 'conflicted', type: null, types: ['String', 'UInt64'], sql: 'SELECT a, b FROM c' }),
      variable({ name: 'orphan', status: 'orphaned', declarations: [], sql: 'SELECT a, b FROM c' }),
    ]);
    expect(excluded).toEqual([]);
  });

  it('excludes a variable whose option SQL is locally rejected', () => {
    expect(optionBatchVariables([variable({ name: 'bad', sql: 'SELECT a, b FROM t; SELECT 1, 2' })])).toEqual([]);
  });
});

describe('compileVariableOptionBatch', () => {
  it('issues no request when nothing is configured', () => {
    expect(compileVariableOptionBatch([])).toBeNull();
    expect(compileVariableOptionBatch([variable({ name: 'country', sql: null })])).toBeNull();
  });

  it('compiles two variables into one deterministic UNION ALL request', () => {
    const batch = compileVariableOptionBatch([
      variable({ name: 'country', sql: 'SELECT toString(country_id), country_name\nFROM countries' }),
      variable({ name: 'city', sql: 'SELECT toString(city_id), city_name FROM cities' }),
    ]);
    expect(batch).not.toBeNull();
    expect(batch!.sql).toBe(
      "SELECT 'country' AS __variable_name, * FROM (\n"
      + 'SELECT toString(country_id), country_name\nFROM countries\n'
      + ') LIMIT 1001\n'
      + 'UNION ALL\n'
      + "SELECT 'city' AS __variable_name, * FROM (\n"
      + 'SELECT toString(city_id), city_name FROM cities\n'
      + ') LIMIT 1001',
    );
    expect(batch!.branches.map((b) => b.name)).toEqual(['country', 'city']);
  });

  it('compiles a single variable without a UNION ALL', () => {
    const batch = compileVariableOptionBatch([variable({ name: 'env', sql: 'SELECT environment, environment FROM environments' })]);
    expect(batch!.sql).toBe(
      "SELECT 'env' AS __variable_name, * FROM (\n"
      + 'SELECT environment, environment FROM environments\n'
      + ') LIMIT 1001',
    );
    expect(batch!.sql).not.toContain('UNION ALL');
  });

  it('follows Variables order, not alphabetical order', () => {
    const batch = compileVariableOptionBatch([
      variable({ name: 'zone', sql: 'SELECT a, b FROM z' }),
      variable({ name: 'area', sql: 'SELECT a, b FROM y' }),
    ]);
    expect(batch!.branches.map((b) => b.name)).toEqual(['zone', 'area']);
    expect(batch!.sql.indexOf("'zone'")).toBeLessThan(batch!.sql.indexOf("'area'"));
  });

  it('escapes the branch tag as a SQL literal', () => {
    // A variable name is user-authored text and is never interpolated raw.
    const batch = compileVariableOptionBatch([variable({ name: "it's", sql: 'SELECT a, b FROM t' })]);
    expect(batch!.sql).toContain("SELECT 'it''s' AS __variable_name");
  });

  it('closes the subquery on its own line so a trailing comment cannot swallow the template', () => {
    const batch = compileVariableOptionBatch([
      variable({ name: 'a', sql: 'SELECT a, b FROM t -- note' }),
      variable({ name: 'b', sql: 'SELECT a, b FROM u' }),
    ]);
    // The comment is stripped by normalization, and the `)` would still be safe
    // if it were not: it never shares a line with user text.
    expect(batch!.sql).toContain('SELECT a, b FROM t\n) LIMIT 1001\nUNION ALL');
  });

  it('nests user SQL verbatim, including its own ORDER BY and LIMIT', () => {
    const batch = compileVariableOptionBatch([
      variable({ name: 'top', sql: 'SELECT a, b FROM t ORDER BY b LIMIT 5' }),
    ]);
    expect(batch!.sql).toContain('SELECT a, b FROM t ORDER BY b LIMIT 5\n) LIMIT 1001');
  });

  it('sizes the transport cap to the sum of the branch limits', () => {
    // A single shared `CAP + 1` would let the first variable consume the whole
    // client-side budget, leaving every later variable looking empty.
    const one = compileVariableOptionBatch([variable({ name: 'a', sql: 'SELECT a, b FROM t' })]);
    const two = compileVariableOptionBatch([
      variable({ name: 'a', sql: 'SELECT a, b FROM t' }),
      variable({ name: 'b', sql: 'SELECT a, b FROM u' }),
    ]);
    expect(one!.rowLimit).toBe(VARIABLE_OPTION_CAP + 2);
    expect(two!.rowLimit).toBe(2 * (VARIABLE_OPTION_CAP + 1) + 1);
  });

  it('bounds each branch at one more than the cap, so truncation is detectable', () => {
    const batch = compileVariableOptionBatch([variable({ name: 'a', sql: 'SELECT a, b FROM t' })]);
    expect(batch!.sql).toContain(`LIMIT ${VARIABLE_OPTION_CAP + 1}`);
  });

  it('keeps the byte cap available to the caller', () => {
    expect(VARIABLE_OPTION_BYTE_CAP).toBe(10_000_000);
  });
});

describe('isOptionColumnType', () => {
  it('accepts String and the wrappers transparent to value handling', () => {
    expect(isOptionColumnType('String')).toBe(true);
    expect(isOptionColumnType('LowCardinality(String)')).toBe(true);
    expect(isOptionColumnType('FixedString(4)')).toBe(true);
  });

  it('rejects Nullable, because a null cell arrives as a literal marker string', () => {
    expect(isOptionColumnType('Nullable(String)')).toBe(false);
    expect(isOptionColumnType('LowCardinality(Nullable(String))')).toBe(false);
  });

  it('rejects every other type', () => {
    expect(isOptionColumnType('UInt64')).toBe(false);
    expect(isOptionColumnType('Date')).toBe(false);
    expect(isOptionColumnType('Array(String)')).toBe(false);
    expect(isOptionColumnType('')).toBe(false);
    expect(isOptionColumnType(null)).toBe(false);
    expect(isOptionColumnType('Tuple(')).toBe(false);
  });
});

describe('validateOptionColumns', () => {
  it('accepts exactly two String columns', () => {
    expect(validateOptionColumns([
      { name: 'v', type: 'String' }, { name: 'l', type: 'LowCardinality(String)' },
    ])).toBeNull();
  });

  it('rejects the wrong column count, naming it', () => {
    expect(validateOptionColumns([{ name: 'v', type: 'String' }])!.code)
      .toBe('variable-option-column-count');
    expect(validateOptionColumns([])!.message).toContain('this returns 0');
    expect(validateOptionColumns([
      { name: 'a', type: 'String' }, { name: 'b', type: 'String' }, { name: 'c', type: 'String' },
    ])!.message).toContain('this returns 3');
  });

  it('rejects a non-String column, naming every offending type', () => {
    const found = validateOptionColumns([
      { name: 'v', type: 'UInt64' }, { name: 'l', type: 'Nullable(String)' },
    ])!;
    expect(found.code).toBe('variable-option-column-type');
    expect(found.message).toContain('UInt64 and Nullable(String)');
  });
});

describe('readVariableOptionBatch', () => {
  const cols = [
    { name: '__variable_name', type: 'String' },
    { name: 'v', type: 'String' },
    { name: 'l', type: 'String' },
  ];

  it('partitions rows by exact, case-sensitive variable name', () => {
    const read = readVariableOptionBatch({
      columns: cols,
      rows: [
        ['country', 'de', 'Germany'],
        ['city', 'ber', 'Berlin'],
        ['country', 'fr', 'France'],
        ['Country', 'xx', 'Other case'],
      ],
    }, ['country', 'city', 'Country']);
    expect(read.error).toBeNull();
    expect(read.byName.get('country')).toEqual([
      { value: 'de', label: 'Germany' }, { value: 'fr', label: 'France' },
    ]);
    expect(read.byName.get('city')).toEqual([{ value: 'ber', label: 'Berlin' }]);
    expect(read.byName.get('Country')).toEqual([{ value: 'xx', label: 'Other case' }]);
  });

  it('reads by position, so a value is never confused with its label', () => {
    // The reason the batch runs under the Compact format: with name-keyed rows a
    // duplicate output-column name collapses on parse, and `UNION ALL` names come
    // from the first branch alone.
    const read = readVariableOptionBatch({ columns: cols, rows: [['c', '7', 'seven']] }, ['c']);
    expect(read.byName.get('c')).toEqual([{ value: '7', label: 'seven' }]);
  });

  it('gives a requested variable that returned nothing an empty list, not a failure', () => {
    const read = readVariableOptionBatch({ columns: cols, rows: [['a', 'x', 'X']] }, ['a', 'b']);
    expect(read.error).toBeNull();
    expect(read.byName.get('b')).toEqual([]);
  });

  it('ignores a name the batch never asked for', () => {
    const read = readVariableOptionBatch({ columns: cols, rows: [['ghost', 'x', 'X']] }, ['a']);
    expect(read.byName.has('ghost')).toBe(false);
    expect(read.byName.get('a')).toEqual([]);
  });

  it('collapses duplicate values to the first row, keeping its label and order', () => {
    const read = readVariableOptionBatch({
      columns: cols,
      rows: [['a', 'x', 'First'], ['a', 'y', 'Why'], ['a', 'x', 'Second']],
    }, ['a']);
    expect(read.byName.get('a')).toEqual([
      { value: 'x', label: 'First' }, { value: 'y', label: 'Why' },
    ]);
  });

  it('drops a blank-valued option, which would be indistinguishable from unset', () => {
    const read = readVariableOptionBatch({
      columns: cols, rows: [['a', '', 'All'], ['a', 'x', 'X']],
    }, ['a']);
    expect(read.byName.get('a')).toEqual([{ value: 'x', label: 'X' }]);
  });

  it('renders a null cell as empty text rather than throwing', () => {
    const read = readVariableOptionBatch({
      columns: cols, rows: [['a', 'x', null], [null, 'y', 'Y']],
    }, ['a']);
    expect(read.byName.get('a')).toEqual([{ value: 'x', label: '' }]);
  });

  it('caps each variable independently and reports which were truncated', () => {
    const rows: unknown[][] = [];
    for (let i = 0; i < VARIABLE_OPTION_CAP + 5; i++) rows.push(['big', `v${i}`, `L${i}`]);
    rows.push(['small', 'only', 'Only']);
    const read = readVariableOptionBatch({ columns: cols, rows }, ['big', 'small']);
    expect(read.byName.get('big')).toHaveLength(VARIABLE_OPTION_CAP);
    // The whole point of a per-variable cap: a large list does not starve the
    // variables that follow it.
    expect(read.byName.get('small')).toEqual([{ value: 'only', label: 'Only' }]);
    expect([...read.truncated]).toEqual(['big']);
  });

  it('reports a batch-level failure when the response is not three columns', () => {
    const read = readVariableOptionBatch({
      columns: [{ name: '__variable_name', type: 'String' }, { name: 'v', type: 'String' }],
      rows: [['a', 'x']],
    }, ['a']);
    expect(read.error!.code).toBe('variable-option-batch-shape');
    expect(read.error!.message).toContain('Test');
    expect(read.byName.get('a')).toEqual([]);
  });

  it('treats an absent columns/rows response as a batch-level failure', () => {
    expect(readVariableOptionBatch({}, ['a']).error!.code).toBe('variable-option-batch-shape');
  });

  it('handles a three-column response with no rows', () => {
    const read = readVariableOptionBatch({ columns: cols }, ['a']);
    expect(read.error).toBeNull();
    expect(read.byName.get('a')).toEqual([]);
  });
});
