import { describe, it, expect, vi } from 'vitest';
import {
  BIND_POLICIES,
  analysisView,
  executionView,
  resolveRelativeValue,
  validateParamValue,
  analyzeParameterizedSources,
  prepareParameterizedBatch,
  mergedSourceArgs,
} from '../../src/core/param-pipeline.js';
import { paramArgs } from '../../src/core/query-params.js';

const src = (id, sql, over = {}) => ({ id, label: id, kind: 'tab', sql, ...over });

describe('stage seams (identity/unknown passes until #165/#169/#170)', () => {
  it('analysisView / executionView are identity', () => {
    expect(analysisView('SELECT 1')).toBe('SELECT 1');
    expect(executionView('SELECT 1', { a: true })).toBe('SELECT 1');
  });
  it('resolveRelativeValue is identity; validateParamValue returns unknown', () => {
    expect(resolveRelativeValue('-1h', { base: 'DateTime' }, 123)).toBe('-1h');
    expect(validateParamValue('x', { base: 'String' }, 'execute')).toBe('unknown');
  });
  it('exports the two bind policies', () => {
    expect(BIND_POLICIES).toEqual(['row-returning', 'all']);
  });
});

describe('analyzeParameterizedSources', () => {
  it('is empty for no sources', () => {
    expect(analyzeParameterizedSources([])).toEqual({ fields: {}, sources: [], sourceErrors: {}, diagnostics: [] });
    expect(analyzeParameterizedSources(undefined).sources).toEqual([]);
  });

  it('records ALL declarations per field (occurrences, source, statement, type, bound)', () => {
    const a = analyzeParameterizedSources([
      src('A', 'SELECT {x:String} WHERE b = {x:String}; CREATE VIEW v AS SELECT {x:String}'),
    ]);
    expect(a.fields.x.declarations).toEqual([
      { source: 'A', statement: 0, type: 'String', bound: true },
      { source: 'A', statement: 0, type: 'String', bound: true },
      { source: 'A', statement: 1, type: 'String', bound: false },
    ]);
    expect(a.fields.x.requiredIn).toEqual(['A']); // deduped per source
  });

  it('requiredness is per-source: required where bound, absent where only in DDL', () => {
    const a = analyzeParameterizedSources([
      src('tile:1', 'SELECT {year:UInt16}'),
      src('tile:2', 'CREATE VIEW v AS SELECT {year:UInt16}'),
      src('tile:3', 'SELECT 1'),
    ]);
    expect(a.fields.year.requiredIn).toEqual(['tile:1']);
    expect(a.fields.year.optionalIn).toEqual([]); // #165 fills this in
    expect(a.fields.year.requiredAnywhere).toBe(true);
    expect(a.fields.year.optionalAnywhere).toBe(false);
  });

  it('a field declared only in unbound statements is not requiredAnywhere', () => {
    const a = analyzeParameterizedSources([src('A', 'CREATE VIEW v AS SELECT {x:String}')]);
    expect(a.fields.x.requiredAnywhere).toBe(false);
    expect(a.fields.x.requiredIn).toEqual([]);
  });

  it("bindPolicy 'all' binds DDL/INSERT-class statements; 'row-returning' is the default (#134)", () => {
    const sql = 'INSERT INTO t SELECT {x:String}';
    const rr = analyzeParameterizedSources([src('A', sql)]);
    expect(rr.sources[0].bindPolicy).toBe('row-returning');
    expect(rr.sources[0].statements[0].bind).toBe(false);
    const all = analyzeParameterizedSources([src('B', sql, { bindPolicy: 'all' })]);
    expect(all.sources[0].statements[0].bind).toBe(true);
    expect(all.fields.x.requiredIn).toEqual(['B']);
  });

  it('an unknown bindPolicy is a per-source config error', () => {
    const a = analyzeParameterizedSources([src('A', 'SELECT 1', { bindPolicy: 'sometimes' })]);
    expect(a.sourceErrors.A).toEqual(['unknown bindPolicy "sometimes"']);
    expect(a.sources[0].errors).toEqual(['unknown bindPolicy "sometimes"']);
  });

  it('detects type conflicts across sources via the all-occurrences scan (global diagnostic)', () => {
    const a = analyzeParameterizedSources([
      src('A', 'SELECT {id:UInt64}'),
      src('B', 'SELECT {id:String}'),
    ]);
    expect(a.fields.id.conflict).toEqual({ types: ['UInt64', 'String'] });
    expect(a.diagnostics).toEqual([{
      kind: 'type-conflict',
      name: 'id',
      types: ['UInt64', 'String'],
      message: '{id} is declared with conflicting types: UInt64 vs String',
    }]);
  });

  it('detects the intra-source duplicate-declaration conflict detectParams (first-wins) would hide', () => {
    const a = analyzeParameterizedSources([src('A', 'SELECT {x:String} WHERE a = {x:UInt8}')]);
    expect(a.diagnostics[0]).toMatchObject({ kind: 'type-conflict', name: 'x' });
  });

  it('runs the analysis materialization seam so inactive-block params stay discoverable (#165)', () => {
    // A stand-in #165 analysisView: reveal the /*[ … ]*/ optional block.
    const stages = { analysisView: (sql) => sql.replace('/*[', '').replace(']*/', '') };
    const a = analyzeParameterizedSources(
      [src('A', 'SELECT * FROM t /*[ WHERE a = {a:String} ]*/')], stages);
    expect(a.fields.a).toBeDefined();
    expect(a.fields.a.requiredIn).toEqual(['A']);
  });
});

describe('prepareParameterizedBatch — per-source verdicts', () => {
  it('builds per-statement args and boundParams; unbound statements pass through verbatim', () => {
    const a = analyzeParameterizedSources([
      src('A', 'CREATE VIEW v AS SELECT {x:String}; SELECT {id:UInt32}'),
    ]);
    const p = prepareParameterizedBatch(a, { values: { id: '5', x: 'unused' } });
    const [ddl, sel] = p.sources[0].statements;
    expect(ddl).toEqual({ sql: 'CREATE VIEW v AS SELECT {x:String}', args: {}, boundParams: [] });
    expect(sel.args).toEqual({ param_id: '5' });
    expect(sel.boundParams).toEqual([{
      name: 'id', declaredType: 'UInt32', rawValue: '5', resolvedValue: '5', serializedValue: '5',
    }]);
    expect(p.sources[0].runnable).toBe(true);
  });

  it('fixes #155: a multi-statement source binds per statement, not on the leading keyword', () => {
    // Old paramArgs over the whole blob saw SET first → no substitution at all.
    const sql = 'SET x = 1; SELECT {year:UInt16}';
    expect(paramArgs(sql, { year: '2024' })).toEqual({}); // the pre-pipeline behavior it replaces
    const a = analyzeParameterizedSources([src('T', sql)]);
    const p = prepareParameterizedBatch(a, { values: { year: '2024' } });
    expect(p.sources[0].statements[0].args).toEqual({}); // SET stays verbatim (row-returning policy)
    expect(p.sources[0].statements[1].args).toEqual({ param_year: '2024' });
    expect(mergedSourceArgs(p.sources[0])).toEqual({ param_year: '2024' });
  });

  it('gates per source: one missing/errored source never blocks its siblings', () => {
    const a = analyzeParameterizedSources([
      src('ok', 'SELECT 1'),
      src('needs', 'SELECT {year:UInt16}'),
      src('broken', 'SELECT {db:String}'),
    ]);
    const p = prepareParameterizedBatch(a, { values: { db: ['not', 'scalar'] }, validationMode: 'execute' });
    const [ok, needs, broken] = p.sources;
    expect(ok.runnable).toBe(true);
    expect(needs).toMatchObject({ runnable: false, missing: ['year'], invalid: [], errors: [] });
    expect(broken.runnable).toBe(false);
    expect(broken.missing).toEqual([]);
    expect(broken.errors[0]).toContain('{db}'); // structural: array value, scalar declaration
    expect(ok.statements[0].args).toEqual({});
  });

  it('a source-config error (bad bindPolicy) flows into the prepared source and kills runnable', () => {
    const a = analyzeParameterizedSources([src('A', 'SELECT 1', { bindPolicy: 'nope' })]);
    const p = prepareParameterizedBatch(a, {});
    expect(p.sources[0].errors).toEqual(['unknown bindPolicy "nope"']);
    expect(p.sources[0].runnable).toBe(false);
  });

  it('an empty source (no statements) is not runnable', () => {
    const a = analyzeParameterizedSources([src('A', '-- nothing runnable')]);
    const p = prepareParameterizedBatch(a, {});
    expect(p.sources[0].statements).toEqual([]);
    expect(p.sources[0].runnable).toBe(false);
  });

  it('missing params are collected once per source, in appearance order', () => {
    const a = analyzeParameterizedSources([src('A', 'SELECT {b:String}; SELECT {b:String}, {a:UInt8}')]);
    const p = prepareParameterizedBatch(a, { values: {} });
    expect(p.sources[0].missing).toEqual(['b', 'a']);
    expect(p.fields.b.state).toBe('missing');
  });

  it('serializes per statement by the LOCAL declaration (String-then-Array(UInt64) case)', () => {
    const a = analyzeParameterizedSources([
      src('A', 'SELECT {id:Array(UInt64)}; SELECT {id:Array(String)}'),
    ]);
    const p = prepareParameterizedBatch(a, { values: { id: ['1', '2'] } });
    // a global "first type wins" could not produce both of these correctly
    expect(p.sources[0].statements[0].args).toEqual({ param_id: '[1,2]' });
    expect(p.sources[0].statements[1].args).toEqual({ param_id: "['1','2']" });
    expect(p.diagnostics[0].kind).toBe('type-conflict'); // still globally diagnosed
    expect(p.sources[0].runnable).toBe(true); // both shapes are structurally compatible
  });

  it('a structurally incompatible stored value blocks only the affected source; legacy strings flow', () => {
    const a = analyzeParameterizedSources([
      src('arr', 'SELECT {v:Array(String)}'),
      src('scal', 'SELECT {v:String}'),
    ]);
    const p = prepareParameterizedBatch(a, { values: { v: ['a'] } });
    expect(p.sources[0].runnable).toBe(true);
    expect(p.sources[0].statements[0].args).toEqual({ param_v: "['a']" });
    expect(p.sources[1].runnable).toBe(false);
    expect(p.sources[1].errors[0]).toMatch(/array value/);
    // same field, legacy scalar string: both sources run, byte-identical passthrough
    const p2 = prepareParameterizedBatch(a, { values: { v: 'plain' } });
    expect(p2.sources.map((s) => s.runnable)).toEqual([true, true]);
    expect(p2.sources[1].statements[0].args).toEqual({ param_v: 'plain' });
  });

  it('one param_<name> arg per statement: the first local declaration wins within the statement', () => {
    const a = analyzeParameterizedSources([src('A', 'SELECT {x:Array(UInt64)}, {x:Array(String)}')]);
    const p = prepareParameterizedBatch(a, { values: { x: ['7'] } });
    expect(p.sources[0].statements[0].args).toEqual({ param_x: '[7]' });
    expect(p.sources[0].statements[0].boundParams).toHaveLength(1);
  });

  it('boundParams are immutable snapshots — later value edits cannot change them', () => {
    const a = analyzeParameterizedSources([src('A', 'SELECT {xs:Array(String)}, {s:String}')]);
    const values = { xs: ['a'], s: 'live' };
    const p = prepareParameterizedBatch(a, { values });
    const [snap, scalarSnap] = p.sources[0].statements[0].boundParams;
    values.xs.push('EDITED'); // the user keeps typing after the request went out (#171)
    values.s = 'EDITED';
    expect(snap.rawValue).toEqual(['a']);
    expect(snap.serializedValue).toBe("['a']");
    expect(scalarSnap.rawValue).toBe('live');
    expect(Object.isFrozen(snap)).toBe(true);
    expect(Object.isFrozen(snap.rawValue)).toBe(true);
    expect(Object.isFrozen(p.sources[0].statements[0])).toBe(true);
    expect(Object.isFrozen(p.sources[0].statements[0].boundParams)).toBe(true);
  });

  it('threads one wallNowMs into the resolve stage (#169 seam) for every bound param', () => {
    const resolveRelativeValue = vi.fn((raw) => raw + ':resolved');
    const a = analyzeParameterizedSources([src('A', 'SELECT {a:String}; SELECT {b:String}')]);
    const p = prepareParameterizedBatch(a, {
      values: { a: '1', b: '2' },
      wallNowMs: 1751200000000,
      stages: { resolveRelativeValue },
    });
    expect(resolveRelativeValue).toHaveBeenCalledTimes(2);
    for (const call of resolveRelativeValue.mock.calls) expect(call[2]).toBe(1751200000000);
    const snap = p.sources[0].statements[0].boundParams[0];
    expect(snap).toMatchObject({ rawValue: '1', resolvedValue: '1:resolved', serializedValue: '1:resolved' });
  });

  it('execution view (#165 seam) drops inactive blocks: their params are not bound, not missing', () => {
    const stages = {
      analysisView: (sql) => sql.replace('/*[', '').replace(']*/', ''),
      executionView: (sql, active) => (active.a
        ? sql.replace('/*[', '').replace(']*/', '')
        : sql.replace(/\/\*\[[\s\S]*\]\*\//, '')),
    };
    const a = analyzeParameterizedSources([src('A', 'SELECT * FROM t /*[ WHERE a = {a:String} ]*/')], stages);
    expect(a.fields.a.requiredIn).toEqual(['A']); // discoverable in the analysis view
    const off = prepareParameterizedBatch(a, { values: {}, active: {}, stages });
    expect(off.sources[0].missing).toEqual([]); // dropped from the execution view → not required
    expect(off.sources[0].runnable).toBe(true);
    expect(off.sources[0].statements[0].sql).toBe('SELECT * FROM t ');
    expect(off.fields.a.state).toBe('inactive');
    const on = prepareParameterizedBatch(a, { values: { a: 'x' }, active: { a: true }, stages });
    expect(on.sources[0].statements[0].args).toEqual({ param_a: 'x' });
    expect(on.fields.a.state).toBe('ok');
  });

  it("validationMode: 'input' keeps incomplete display-only; 'execute' hardens it to invalid", () => {
    const stages = { validateParamValue: () => 'incomplete' };
    const a = analyzeParameterizedSources([src('A', 'SELECT {d:DateTime}')]);
    const lenient = prepareParameterizedBatch(a, { values: { d: '2024-' }, validationMode: 'input', stages });
    expect(lenient.fields.d.state).toBe('incomplete');
    expect(lenient.sources[0].invalid).toEqual([]);
    expect(lenient.sources[0].runnable).toBe(true); // display-only while typing
    expect(lenient.sources[0].statements[0].args).toEqual({}); // but no arg is sent for it
    const strict = prepareParameterizedBatch(a, { values: { d: '2024-' }, validationMode: 'execute', stages });
    expect(strict.fields.d.state).toBe('invalid');
    expect(strict.sources[0].invalid).toEqual(['d']);
    expect(strict.sources[0].runnable).toBe(false);
  });

  it('an invalid verdict gates its sources and carries the validator reason into the field state', () => {
    const stages = {
      validateParamValue: (v) => (v === 'bad' ? { state: 'invalid', reason: 'not a date' } : 'ok'),
    };
    const a = analyzeParameterizedSources([
      src('A', 'SELECT {d:Date}; SELECT {d:Date}'), // invalid twice in one source → deduped
      src('B', 'SELECT {e:Date}'),
    ]);
    const p = prepareParameterizedBatch(a, { values: { d: 'bad', e: 'fine' }, stages });
    expect(p.sources[0]).toMatchObject({ invalid: ['d'], runnable: false });
    expect(p.sources[1].runnable).toBe(true);
    expect(p.fields.d).toEqual({ state: 'invalid', reason: 'not a date' });
    expect(p.fields.e).toEqual({ state: 'ok' });
  });

  it('field states: missing / inactive (empty, unrequired) / inactive (filled, unbound) / ok', () => {
    const a = analyzeParameterizedSources([
      src('A', 'SELECT {req:String}; CREATE VIEW v AS SELECT {ddlOnly:String}, {ddlFilled:String}'),
    ]);
    const p = prepareParameterizedBatch(a, { values: { ddlFilled: 'x' } });
    expect(p.fields.req.state).toBe('missing');
    expect(p.fields.ddlOnly.state).toBe('inactive');
    expect(p.fields.ddlFilled.state).toBe('inactive');
    const filled = prepareParameterizedBatch(a, { values: { req: 'v' } });
    expect(filled.fields.req.state).toBe('ok');
  });

  it('defaults: no opts at all behaves as empty values in input mode', () => {
    const a = analyzeParameterizedSources([src('A', 'SELECT {x:String}')]);
    const p = prepareParameterizedBatch(a);
    expect(p.sources[0].missing).toEqual(['x']);
    expect(p.fields.x.state).toBe('missing');
  });

  it('diagnostics are copied, not aliased, from the analysis', () => {
    const a = analyzeParameterizedSources([src('A', 'SELECT {id:UInt64}'), src('B', 'SELECT {id:String}')]);
    const p = prepareParameterizedBatch(a, { values: { id: '1' } });
    expect(p.diagnostics).toEqual(a.diagnostics);
    expect(p.diagnostics).not.toBe(a.diagnostics);
  });
});

describe('integration parity + regression sweep', () => {
  it('workbench-shaped and dashboard-shaped sources produce identical args for identical SQL', () => {
    const sql = 'SELECT {year:UInt16}, {region:String} FROM sales';
    const values = { year: '2024', region: 'us' };
    const bench = prepareParameterizedBatch(
      analyzeParameterizedSources([{ id: 'tab', label: 'editor tab', kind: 'tab', sql, bindPolicy: 'row-returning' }]),
      { values, validationMode: 'execute' });
    const dash = prepareParameterizedBatch(
      analyzeParameterizedSources([{ id: 'tile:0', label: 'Revenue', kind: 'tile', sql, bindPolicy: 'row-returning' }]),
      { values, validationMode: 'execute' });
    expect(mergedSourceArgs(bench.sources[0])).toEqual(mergedSourceArgs(dash.sources[0]));
  });

  it('scalar-string behavior is byte-identical to paramArgs for single-statement SQL', () => {
    const cases = [
      ['SELECT {database:String}, {table:String}', { database: 'default', table: 'events' }],
      ['SELECT {n:UInt8}', { n: '0' }],
      ['SELECT {a:String}, {b:String}, {c:String}', { a: 'x', b: '' }],
      ['CREATE VIEW v AS SELECT {x:String}', { x: 'default' }],
      ['INSERT INTO t SELECT {x:String}', { x: 'default' }],
      ["SELECT {s:String}", { s: "o'brien \\ [1,2]" }],
      ['SELECT {big:UInt64}', { big: '18446744073709551615' }],
      ['SELECT 1', {}],
    ];
    for (const [sql, values] of cases) {
      const p = prepareParameterizedBatch(analyzeParameterizedSources([src('A', sql)]), { values });
      expect(mergedSourceArgs(p.sources[0])).toEqual(paramArgs(sql, values));
    }
  });

  it('mergedSourceArgs unions statement args (last statement wins a collision)', () => {
    const a = analyzeParameterizedSources([src('A', 'SELECT {a:Array(UInt64)}; SELECT {a:Array(String)}, {b:String}')]);
    const p = prepareParameterizedBatch(a, { values: { a: ['1'], b: 'x' } });
    expect(mergedSourceArgs(p.sources[0])).toEqual({ param_a: "['1']", param_b: 'x' });
  });
});
