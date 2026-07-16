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
  mergedSourceSql,
  fieldControls,
  fieldControlKind,
} from '../../src/core/param-pipeline.js';
import { paramArgs } from '../../src/core/query-params.js';

const src = (id, sql, over = {}) => ({ id, label: id, kind: 'tab', sql, ...over });

describe('stage functions (#165/#169/#170 real)', () => {
  it('analysisView / executionView are identity for SQL without optional blocks', () => {
    expect(analysisView('SELECT 1')).toBe('SELECT 1');
    expect(executionView('SELECT 1', { a: true })).toBe('SELECT 1');
  });
  it('analysisView strips markers keeping every block; executionView keeps only active blocks (#165)', () => {
    const sql = 'SELECT 1 /*[ AND a = {a:String} ]*/';
    expect(analysisView(sql)).toBe('SELECT 1  AND a = {a:String} ');
    expect(executionView(sql, {})).toBe('SELECT 1 ');
    expect(executionView(sql, { a: true })).toBe('SELECT 1  AND a = {a:String} ');
  });
  it('resolveRelativeValue (#169) resolves a relative expression against the given clock', () => {
    expect(resolveRelativeValue('-1h', { base: 'DateTime' }, 3600123)).toBe('0');
    // a near-miss comes back as the {error} sentinel, not a value
    expect(resolveRelativeValue('now/q', { base: 'DateTime' }, 123)).toEqual({ error: expect.any(String) });
    // non-date types and absolute values are untouched
    expect(resolveRelativeValue('-1h', { base: 'String' }, 123)).toBe('-1h');
    expect(resolveRelativeValue('2026-07-11', { base: 'Date' }, 123)).toBe('2026-07-11');
  });
  it('validateParamValue passes through an out-of-scope type', () => {
    expect(validateParamValue('x', { base: 'String' }, 'execute')).toBe('unknown');
  });
  it('validateParamValue (#170) adapts param-validate.js\'s {status,reason} into the stage contract', () => {
    // valid → 'valid' (falls through the caller's checks exactly like 'unknown'/'ok')
    expect(validateParamValue('255', { base: 'UInt8' }, 'execute')).toBe('valid');
    // invalid → {state, reason}
    expect(validateParamValue('256', { base: 'UInt8' }, 'execute'))
      .toEqual({ state: 'invalid', reason: 'Expected UInt8 from 0 to 255' });
    // incomplete → 'incomplete'
    expect(validateParamValue('-', { base: 'Int32' }, 'input')).toBe('incomplete');
  });
  it('exports the two bind policies', () => {
    expect(BIND_POLICIES).toEqual(['row-returning', 'all']);
  });
});

describe('#170 end-to-end: the real validator wired as the pipeline default (no stage override)', () => {
  it('a range-invalid Int/UInt value gates its source and carries a specific reason', () => {
    const a = analyzeParameterizedSources([src('A', 'SELECT {n:UInt8}')]);
    const p = prepareParameterizedBatch(a, { values: { n: '256' }, validationMode: 'input' });
    expect(p.sources[0]).toMatchObject({ invalid: ['n'], runnable: false });
    expect(p.fields.n).toEqual({ state: 'invalid', reason: 'Expected UInt8 from 0 to 255' });
  });
  it("an incomplete value ('input' mode) is display-only; the same value hardens to invalid under 'execute'", () => {
    const a = analyzeParameterizedSources([src('A', 'SELECT {n:Int32}')]);
    const lenient = prepareParameterizedBatch(a, { values: { n: '-' }, validationMode: 'input' });
    expect(lenient.fields.n.state).toBe('incomplete');
    expect(lenient.sources[0]).toMatchObject({ invalid: [], runnable: true });
    const strict = prepareParameterizedBatch(a, { values: { n: '-' }, validationMode: 'execute' });
    expect(strict.fields.n.state).toBe('invalid');
    // #170 review: a value hardened from 'incomplete' (rather than a
    // validator-rejected value) never got its own reason from
    // param-validate.js — the fallback keeps the tooltip from going blank.
    expect(strict.fields.n.reason).toBe('Incomplete value');
    expect(strict.sources[0]).toMatchObject({ invalid: ['n'], runnable: false });
  });
  it('a valid typed value runs normally, still serialized and bound', () => {
    const a = analyzeParameterizedSources([src('A', 'SELECT {n:UInt8}')]);
    const p = prepareParameterizedBatch(a, { values: { n: '42' }, validationMode: 'execute' });
    expect(p.fields.n).toEqual({ state: 'ok' });
    expect(p.sources[0]).toMatchObject({ runnable: true });
    expect(p.sources[0].statements[0].args).toEqual({ param_n: '42' });
  });
});

describe('#169 end-to-end: the real relative-time resolver wired as the pipeline default', () => {
  it('a relative expression resolves to a formatted literal and binds; the stored/raw value stays the expression', () => {
    const a = analyzeParameterizedSources([src('A', 'SELECT {from:DateTime}')]);
    const nowMs = 1751200000000; // fixed wave clock
    const p = prepareParameterizedBatch(a, { values: { from: '-1h' }, wallNowMs: nowMs, validationMode: 'execute' });
    expect(p.fields.from).toEqual({ state: 'ok' });
    expect(p.sources[0]).toMatchObject({ runnable: true });
    const expected = String(Math.round((nowMs - 3600000) / 1000));
    expect(p.sources[0].statements[0].args).toEqual({ param_from: expected });
    const snap = p.sources[0].statements[0].boundParams[0];
    expect(snap.rawValue).toBe('-1h'); // the expression, not the resolved instant (#169: it re-resolves every wave)
    expect(snap.resolvedValue).toBe(expected);
    expect(snap.serializedValue).toBe(expected);
  });
  it("a near-miss relative expression ('input' mode) is display-only incomplete, never gates — #170's exact timing model (review finding #2)", () => {
    const a = analyzeParameterizedSources([src('A', 'SELECT {from:DateTime}')]);
    const p = prepareParameterizedBatch(a, { values: { from: 'now/q' }, wallNowMs: 123, validationMode: 'input' });
    expect(p.sources[0]).toMatchObject({ invalid: [], runnable: true });
    expect(p.fields.from).toEqual({ state: 'incomplete' });
    expect(p.sources[0].statements[0].args).toEqual({});
  });
  it("the same near-miss hardens to invalid with the structured reason under 'execute' mode (blur/Enter/run)", () => {
    const a = analyzeParameterizedSources([src('A', 'SELECT {from:DateTime}')]);
    const p = prepareParameterizedBatch(a, { values: { from: 'now/q' }, wallNowMs: 123, validationMode: 'execute' });
    expect(p.sources[0]).toMatchObject({ invalid: ['from'], runnable: false });
    expect(p.fields.from.state).toBe('invalid');
    expect(p.fields.from.reason).toMatch(/Not a valid relative time expression/);
    expect(p.sources[0].statements[0].args).toEqual({});
  });
  it("ordinary keystrokes toward a valid expression ('-1', 'now-', 'now-1', 'now/') never gate in 'input' mode", () => {
    const a = analyzeParameterizedSources([src('A', 'SELECT {from:DateTime}')]);
    for (const prefix of ['-1', 'now-', 'now-1', 'now/']) {
      const p = prepareParameterizedBatch(a, { values: { from: prefix }, wallNowMs: 123, validationMode: 'input' });
      expect(p.fields.from.state).toBe('incomplete');
      expect(p.sources[0].runnable).toBe(true);
    }
  });
  it('an absolute value for a date-like type keeps working unchanged', () => {
    const a = analyzeParameterizedSources([src('A', 'SELECT {d:Date}')]);
    const p = prepareParameterizedBatch(a, { values: { d: '2026-07-11' }, wallNowMs: 123 });
    expect(p.fields.d).toEqual({ state: 'ok' });
    expect(p.sources[0].statements[0].args).toEqual({ param_d: '2026-07-11' });
  });
  it('non-date-typed variables are completely unaffected by a relative-looking value', () => {
    const a = analyzeParameterizedSources([src('A', 'SELECT {s:String}')]);
    const p = prepareParameterizedBatch(a, { values: { s: '-1h' }, wallNowMs: 123 });
    expect(p.fields.s).toEqual({ state: 'ok' });
    expect(p.sources[0].statements[0].args).toEqual({ param_s: '-1h' });
  });
  it('one pinned wallNowMs resolves the same relative value across every statement of the wave', () => {
    const a = analyzeParameterizedSources([src('A', 'SELECT {from:DateTime}; SELECT {from:DateTime}')]);
    const nowMs = 1751200000000;
    const p = prepareParameterizedBatch(a, { values: { from: '-1h' }, wallNowMs: nowMs });
    const expected = String(Math.round((nowMs - 3600000) / 1000));
    expect(p.sources[0].statements[0].args.param_from).toBe(expected);
    expect(p.sources[0].statements[1].args.param_from).toBe(expected);
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

  it('discovers inactive-block params on the analysis materialization (#165): optional, not required', () => {
    const a = analyzeParameterizedSources(
      [src('A', 'SELECT * FROM t /*[ WHERE a = {a:String} ]*/')]);
    expect(a.fields.a).toBeDefined();
    expect(a.fields.a.optionalIn).toEqual(['A']);
    expect(a.fields.a.requiredIn).toEqual([]);
    expect(a.fields.a.optionalAnywhere).toBe(true);
    expect(a.fields.a.requiredAnywhere).toBe(false);
  });

  it('an injected stages.analysisView still overrides the built-in materialization', () => {
    const stages = { analysisView: (sql) => sql.replace('{hidden}', '{a:String}') };
    const a = analyzeParameterizedSources([src('A', 'SELECT {hidden} FROM t')], stages);
    expect(a.fields.a.declarations).toHaveLength(1);
    expect(a.fields.a.optionalIn).toEqual(['A']); // not visible to the raw scan → optional
  });

  it('#165 requiredness: required in one source, optional in another; required wins within a source', () => {
    const a = analyzeParameterizedSources([
      src('req', 'SELECT * FROM t WHERE d = {d:String}'),
      src('opt', 'SELECT * FROM u WHERE 1 /*[ AND d = {d:String} ]*/'),
      src('both', 'SELECT {d:String} FROM v /*[ WHERE x = {d:String} ]*/'),
    ]);
    expect(a.fields.d.requiredIn).toEqual(['req', 'both']);
    expect(a.fields.d.optionalIn).toEqual(['opt']); // 'both': required outside a block wins
    expect(a.fields.d.requiredAnywhere).toBe(true);
    expect(a.fields.d.optionalAnywhere).toBe(true);
  });

  it('#165 cross-statement reconciliation: block-only in one statement, required in another → required', () => {
    const a = analyzeParameterizedSources([
      src('A', 'SELECT 1 /*[ WHERE d = {d:String} ]*/; SELECT {d:String}'),
    ]);
    expect(a.fields.d.requiredIn).toEqual(['A']);
    expect(a.fields.d.optionalIn).toEqual([]);
  });

  it('#165 rule 2: a non-row-returning statement is never materialized — its blocks stay comments', () => {
    const a = analyzeParameterizedSources([
      src('A', 'CREATE VIEW v AS SELECT 1 /*[ WHERE d = {d:String} ]*/'),
    ]);
    expect(a.fields.d).toBeUndefined(); // invisible: a plain comment in DDL
    expect(a.sources[0].errors).toEqual([]); // and never validated (rule 2)
  });

  it('#165 template errors are per-source errors', () => {
    const a = analyzeParameterizedSources([
      src('bad', 'SELECT 1 /*[ AND 1 = 1 ]*/'),
      src('ok', 'SELECT 1'),
    ]);
    expect(a.sources[0].errors[0]).toContain('at least one {name:Type} parameter');
    expect(a.sourceErrors.bad).toHaveLength(1);
    expect(a.sources[1].errors).toEqual([]);
  });

  it('#165 rule 4: a whole statement hidden inside a block is a clear error, not a silent drop', () => {
    const a = analyzeParameterizedSources([
      src('A', 'SELECT 1;\n/*[ SELECT {a:String} ]*/'),
    ]);
    expect(a.sources[0].errors).toEqual(['optional block: a block cannot wrap a whole statement']);
    expect(a.sources[0].statements).toHaveLength(1); // the visible statement still analyzed
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
    // #173 review finding, fixed under #170: a serialization failure must not
    // leave the FIELD's own rollup reading 'ok' — it never actually bound.
    expect(broken.invalid).toEqual([]); // per-source `invalid` stays the validator's alone
    expect(p.fields.db.state).toBe('invalid');
    expect(p.fields.db.reason).toBe(broken.errors[0]);
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

  it('execution view (#165) drops inactive blocks: their params are not bound, not missing', () => {
    const a = analyzeParameterizedSources([src('A', 'SELECT * FROM t /*[ WHERE a = {a:String} ]*/')]);
    expect(a.fields.a.optionalIn).toEqual(['A']); // discoverable in the analysis view
    const off = prepareParameterizedBatch(a, { values: {}, active: {} });
    expect(off.sources[0].missing).toEqual([]); // dropped from the execution view → not required
    expect(off.sources[0].runnable).toBe(true);
    expect(off.sources[0].statements[0].sql).toBe('SELECT * FROM t ');
    expect(off.sources[0].statements[0].boundParams).toEqual([]); // never bound
    expect(off.sources[0].statements[0].args).toEqual({});
    expect(off.fields.a.state).toBe('inactive');
    const on = prepareParameterizedBatch(a, { values: { a: 'x' }, active: { a: true } });
    expect(on.sources[0].statements[0].sql).toBe('SELECT * FROM t  WHERE a = {a:String} ');
    expect(on.sources[0].statements[0].args).toEqual({ param_a: 'x' });
    expect(on.fields.a.state).toBe('ok');
  });

  it('an injected stages.executionView still overrides the built-in materialization', () => {
    const stages = { executionView: (sql) => sql.replace('t', 'u') };
    const a = analyzeParameterizedSources([src('A', 'SELECT * FROM t')]);
    const p = prepareParameterizedBatch(a, { stages });
    expect(p.sources[0].statements[0].sql).toBe('SELECT * FROM u');
  });

  it('#165: active:false with a stale stored value → block omitted, the dormant value is inert', () => {
    const a = analyzeParameterizedSources([src('A', 'SELECT * FROM t /*[ WHERE a = {a:String} ]*/')]);
    const p = prepareParameterizedBatch(a, { values: { a: 'stale' }, active: { a: false } });
    expect(p.sources[0].statements[0].sql).toBe('SELECT * FROM t ');
    expect(p.sources[0].statements[0].args).toEqual({});
    expect(p.sources[0].runnable).toBe(true);
    expect(p.fields.a.state).toBe('inactive'); // value present but nowhere bound
  });

  it("#165: active:true with value:'' → block retained and the empty string binds", () => {
    const a = analyzeParameterizedSources([src('A', 'SELECT * FROM t /*[ WHERE a = {a:String} ]*/')]);
    const p = prepareParameterizedBatch(a, { values: { a: '' }, active: { a: true }, validationMode: 'execute' });
    expect(p.sources[0].statements[0].sql).toBe('SELECT * FROM t  WHERE a = {a:String} ');
    expect(p.sources[0].statements[0].args).toEqual({ param_a: '' }); // a real empty-string value
    expect(p.sources[0].missing).toEqual([]);
    expect(p.sources[0].runnable).toBe(true);
    expect(p.fields.a.state).toBe('ok');
    // …and an absent stored value under explicit activation binds '' too.
    const noValue = prepareParameterizedBatch(a, { values: {}, active: { a: true } });
    expect(noValue.sources[0].statements[0].boundParams[0]).toMatchObject({ rawValue: '', serializedValue: '' });
  });

  it('#165 review finding 2: activation never bypasses requiredness — required + blank + active still gates', () => {
    // The reviewer's exact repro: d is required (outside any block); a blank
    // value must gate as missing no matter what the shared active map says.
    const a = analyzeParameterizedSources([src('A', 'SELECT * FROM t WHERE d = {d:String}')]);
    const p = prepareParameterizedBatch(a, { values: { d: '' }, active: { d: true } });
    expect(p.sources[0].missing).toEqual(['d']);
    expect(p.sources[0].runnable).toBe(false);
    expect(p.sources[0].statements[0].args).toEqual({}); // never binds a silent ''
    expect(p.fields.d.state).toBe('missing');
  });

  it('#165 cross-source: active+blank gates the source where d is required; the block-confined source binds the empty string', () => {
    const a = analyzeParameterizedSources([
      src('A', 'SELECT * FROM t WHERE d = {d:String}'),
      src('B', 'SELECT * FROM u WHERE 1 /*[ AND d = {d:String} ]*/'),
    ]);
    const p = prepareParameterizedBatch(a, { values: { d: '' }, active: { d: true } });
    expect(p.sources[0]).toMatchObject({ missing: ['d'], runnable: false }); // required occurrence gates
    // B's occurrence is block-confined: active ⇒ block retained, '' binds there.
    expect(p.sources[1].statements[0].sql).toBe('SELECT * FROM u WHERE 1  AND d = {d:String} ');
    expect(p.sources[1].statements[0].args).toEqual({ param_d: '' });
    expect(p.sources[1].runnable).toBe(true);
    expect(p.fields.d.state).toBe('missing'); // the gated source wins the field state
  });

  it('#165: required-and-block-confined in the SAME statement — blank + active gates (required wins)', () => {
    const a = analyzeParameterizedSources([
      src('A', 'SELECT {d:String} FROM t /*[ WHERE x = {d:String} ]*/'),
    ]);
    const p = prepareParameterizedBatch(a, { values: {}, active: { d: true } });
    expect(p.sources[0].missing).toEqual(['d']);
    expect(p.sources[0].runnable).toBe(false);
    expect(p.fields.d.state).toBe('missing');
  });

  it('#165: a required (outside-block) param stays required — blank still gates', () => {
    const a = analyzeParameterizedSources([
      src('A', 'SELECT * FROM t WHERE tenant = {tenant:UInt64} /*[ AND d = {d:String} ]*/'),
    ]);
    const p = prepareParameterizedBatch(a, { values: {}, active: {} });
    expect(p.sources[0].missing).toEqual(['tenant']);
    expect(p.sources[0].runnable).toBe(false);
    expect(p.fields.tenant.state).toBe('missing');
    expect(p.fields.d.state).toBe('inactive');
    const filled = prepareParameterizedBatch(a, { values: { tenant: '7' }, active: {} });
    expect(filled.sources[0].statements[0].args).toEqual({ param_tenant: '7' }); // no param_d
    expect(filled.sources[0].runnable).toBe(true);
  });

  it('#165 first load: no values, no activation entries — optional params default inactive, nothing throws', () => {
    const a = analyzeParameterizedSources([src('A', 'SELECT 1 /*[ AND d = {d:String} ]*/')]);
    const p = prepareParameterizedBatch(a); // no opts at all
    expect(p.sources[0].runnable).toBe(true);
    expect(p.fields.d.state).toBe('inactive');
  });

  it('#165: a template error makes the source not runnable, sql passes through verbatim', () => {
    const sql = 'SELECT 1 /*[ broken';
    const a = analyzeParameterizedSources([src('A', sql)]);
    const p = prepareParameterizedBatch(a, { values: {}, active: {} });
    expect(p.sources[0].errors[0]).toContain('unbalanced');
    expect(p.sources[0].runnable).toBe(false);
    expect(p.sources[0].statements[0].sql).toBe(sql);
  });

  it('#165 regression: nested array literals (with and without params) are untouched end-to-end', () => {
    const a = analyzeParameterizedSources([
      src('plain', 'SELECT [[1, 2], [3, 4]]'),
      src('param', 'SELECT [[{a:UInt8}, 2], [3, 4]]'),
    ]);
    expect(a.sources[0].errors).toEqual([]);
    expect(a.fields.a.requiredIn).toEqual(['param']); // an ordinary required param
    const p = prepareParameterizedBatch(a, { values: { a: '9' }, active: {} });
    expect(p.sources[0].statements[0].sql).toBe('SELECT [[1, 2], [3, 4]]');
    expect(p.sources[1].statements[0].sql).toBe('SELECT [[{a:UInt8}, 2], [3, 4]]');
    expect(p.sources[1].statements[0].args).toEqual({ param_a: '9' });
    expect(p.sources.map((s) => s.runnable)).toEqual([true, true]);
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
    // A stage that returns the bare 'incomplete' string (no reason at all)
    // still gets the fallback reason once hardened (#170 review).
    expect(strict.fields.d.reason).toBe('Incomplete value');
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

  it('mergedSourceSql joins the materialized statements; falls back for an empty source', () => {
    const a = analyzeParameterizedSources([
      src('A', 'SET x = 1; SELECT 1 /*[ AND d = {d:String} ]*/'),
      src('B', '-- comments only'),
    ]);
    const p = prepareParameterizedBatch(a, { values: {}, active: {} });
    expect(mergedSourceSql(p.sources[0])).toBe('SET x = 1;\nSELECT 1 ');
    expect(mergedSourceSql(p.sources[1], 'FALLBACK')).toBe('FALLBACK');
    expect(mergedSourceSql(p.sources[1])).toBe('');
  });
});

describe('fieldControls (#165 — the variables strip / filter bar list)', () => {
  it('lists bound fields in first-appearance order with the optional flag', () => {
    const a = analyzeParameterizedSources([
      src('t1', 'SELECT {year:UInt16} FROM t /*[ WHERE d = {d:String} ]*/'),
      src('t2', 'SELECT {region:String} FROM u'),
    ]);
    expect(fieldControls(a)).toEqual([
      { name: 'year', type: 'UInt16', optional: false },
      { name: 'd', type: 'String', optional: true },
      { name: 'region', type: 'String', optional: false },
    ]);
  });
  it('excludes a param confined to DDL (never substituted → no input)', () => {
    const a = analyzeParameterizedSources([src('A', 'CREATE VIEW v AS SELECT {x:String}')]);
    expect(fieldControls(a)).toEqual([]);
  });
  it('a param required anywhere is not optional, even if block-only elsewhere', () => {
    const a = analyzeParameterizedSources([
      src('opt', 'SELECT 1 /*[ WHERE d = {d:String} ]*/'),
      src('req', 'SELECT {d:String}'),
    ]);
    expect(fieldControls(a)).toEqual([{ name: 'd', type: 'String', optional: false }]);
  });
  it('a type-conflicted field carries `conflict` (the distinct normalized types) — #173 acceptance, review F1', () => {
    // Across two statements of one source AND across two sources: both are
    // declarations of the same name, so both shapes surface the same conflict.
    const twoStatements = analyzeParameterizedSources([src('A', 'SELECT {id:UInt64}; SELECT {id:String}')]);
    expect(fieldControls(twoStatements)).toEqual([
      { name: 'id', type: 'UInt64', optional: false, conflict: ['UInt64', 'String'] },
    ]);
    const twoSources = analyzeParameterizedSources([
      src('A', 'SELECT {id:UInt64}'),
      src('B', 'SELECT {id:String}'),
    ]);
    expect(fieldControls(twoSources)[0].conflict).toEqual(['UInt64', 'String']);
    // Agreeing declarations never grow the key at all.
    const agree = analyzeParameterizedSources([src('A', 'SELECT {id:UInt64}; SELECT {id:UInt64}')]);
    expect('conflict' in fieldControls(agree)[0]).toBe(false);
  });
});

describe('fieldControlKind (shared control priority — review F1/F8)', () => {
  const ENUM = "Enum8('a' = 1, 'b' = 2)";
  it('declared Enum members win (v1), even when inferred options are also offered', () => {
    expect(fieldControlKind({ type: ENUM }, ['x'])).toEqual({ kind: 'enum', enumOptions: ['a', 'b'] });
  });
  it('inferred options (v2) apply when the declared type has none', () => {
    expect(fieldControlKind({ type: 'String' }, ['x', 'y'])).toEqual({ kind: 'enum', enumOptions: ['x', 'y'] });
  });
  it('date-like types get the date control; plain types the text control', () => {
    expect(fieldControlKind({ type: 'DateTime' })).toEqual({ kind: 'date', enumOptions: null });
    expect(fieldControlKind({ type: 'UInt8' })).toEqual({ kind: 'text', enumOptions: null });
  });
  it('a conflicted field ALWAYS degrades to text — enum members, inferred options, and date-likeness are all ignored (#173 acceptance)', () => {
    expect(fieldControlKind({ type: ENUM, conflict: [ENUM, 'String'] })).toEqual({ kind: 'text', enumOptions: null });
    expect(fieldControlKind({ type: 'String', conflict: ['String', 'UInt8'] }, ['x'])).toEqual({ kind: 'text', enumOptions: null });
    expect(fieldControlKind({ type: 'DateTime', conflict: ['DateTime', 'String'] })).toEqual({ kind: 'text', enumOptions: null });
  });
});
