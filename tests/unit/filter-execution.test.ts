import { describe, expect, it } from 'vitest';
import {
  FILTER_RESULT_BYTE_CAP, FILTER_TOP_LEVEL_ROW_LIMIT, filterExecution, filterSqlDiagnostics,
  analyzeFilterSource, prepareFilterSource,
} from '../../src/core/filter-execution.js';

describe('Filter execution', () => {
  it('owns a lossless, read-only, bounded structured transport', () => {
    const out = filterExecution('SELECT [1] AS id', { params: { custom: 1 } });
    expect(out).toMatchObject({ owned: true, format: 'Filter', rowLimit: FILTER_TOP_LEVEL_ROW_LIMIT, error: null, diagnostics: [] });
    expect(out.params).toMatchObject({ max_result_bytes: FILTER_RESULT_BYTE_CAP, custom: 1,
      output_format_json_named_tuples_as_objects: 1, output_format_json_quote_64bit_integers: 1,
      output_format_json_quote_decimals: 1, output_format_json_quote_64bit_floats: 1 });
    expect(out.params).not.toHaveProperty('readonly');
  });
  it('reports every static SQL contract failure', () => {
    expect(filterSqlDiagnostics('')).toMatchObject([{ code: 'filter-sql-empty' }]);
    expect(filterSqlDiagnostics('SELECT 1; SELECT 2').map((d) => d.code)).toContain('filter-sql-statement-count');
    expect(filterSqlDiagnostics('CREATE TABLE t (x Int8)').map((d) => d.code)).toContain('filter-sql-not-row-returning');
    expect(filterSqlDiagnostics('SELECT 1 FORMAT JSON').map((d) => d.code)).toContain('filter-owned-format');
    expect(filterExecution('SELECT 1 FORMAT JSON').error).toContain('FORMAT');
  });
  it('#360: Filter SQL may now declare its own query parameters — no filter-source-parameters diagnostic', () => {
    expect(filterSqlDiagnostics('SELECT {x:String}').map((d) => d.code)).not.toContain('filter-source-parameters');
    expect(filterSqlDiagnostics('SELECT 1 /*[ WHERE x={x:String} ]*/').map((d) => d.code)).not.toContain('filter-source-parameters');
  });
});

describe('analyzeFilterSource (#360)', () => {
  it('derives dependsOn from both required (outside every block) and block-confined optional params', () => {
    const a = analyzeFilterSource('SELECT 1 WHERE a = {a:String} /*[ AND b = {b:String} ]*/');
    expect(a.dependsOn).toEqual(['a', 'b']);
    expect(a.diagnostics).toEqual([]);
    expect(a.sql).toBe('SELECT 1 WHERE a = {a:String} /*[ AND b = {b:String} ]*/');
  });
  it('rejects a param backed by another Filter source (cascading) but not one that is unbacked', () => {
    const a = analyzeFilterSource('SELECT 1 WHERE a = {a:String} /*[ AND b = {b:String} ]*/', {
      sourceBackedParams: ['a'],
      label: 'MyFilter',
    });
    expect(a.diagnostics).toHaveLength(1);
    expect(a.diagnostics[0]).toMatchObject({ code: 'filter-source-cascading' });
    expect(a.diagnostics[0].message).toBe(
      'Filter source "MyFilter" depends on source-backed parameter "a". Cascading Filter sources are not supported.',
    );
  });
  it('defaults the label to "source" in the cascading message when omitted', () => {
    const a = analyzeFilterSource('SELECT 1 WHERE q = {q:String}', { sourceBackedParams: ['q'] });
    expect(a.diagnostics[0].message).toContain('Filter source "source" depends on source-backed parameter "q".');
  });
  it('structural diagnostics still fire alongside the pipeline analysis', () => {
    expect(analyzeFilterSource('').diagnostics.map((d) => d.code)).toContain('filter-sql-empty');
    expect(analyzeFilterSource('SELECT 1; SELECT 2').diagnostics.map((d) => d.code)).toContain('filter-sql-statement-count');
    expect(analyzeFilterSource('CREATE TABLE t (x Int8)').diagnostics.map((d) => d.code)).toContain('filter-sql-not-row-returning');
    expect(analyzeFilterSource('SELECT 1 FORMAT JSON').diagnostics.map((d) => d.code)).toContain('filter-owned-format');
  });
  it('has no dependsOn when the SQL declares no params', () => {
    expect(analyzeFilterSource('SELECT 1').dependsOn).toEqual([]);
    expect(analyzeFilterSource(null).dependsOn).toEqual([]);
  });
  it('excludes a param confined to a non-row-returning (unbound) statement from dependsOn', () => {
    // CREATE isn't row-returning, so this statement never binds — its
    // declaration is recorded (for cross-source type-conflict detection) but
    // never enters requiredIn/optionalIn for this source.
    const a = analyzeFilterSource('CREATE TABLE t (x Int8) COMMENT {z:String}');
    expect(a.dependsOn).toEqual([]);
  });
});

describe('prepareFilterSource (#360)', () => {
  it('runnable: materializes execSql, binds param_<name> args, snapshots boundParams, error is null', () => {
    const a = analyzeFilterSource('SELECT 1 WHERE n = {n:UInt8}');
    const p = prepareFilterSource(a, { values: { n: '42' } });
    expect(p.readiness).toBe('runnable');
    expect(p.error).toBeNull();
    expect(p.missing).toEqual([]);
    expect(p.invalid).toEqual([]);
    expect(p.errors).toEqual([]);
    expect(p.dependsOn).toEqual(['n']);
    expect(p.format).toBe('Filter');
    expect(p.rowLimit).toBe(FILTER_TOP_LEVEL_ROW_LIMIT);
    expect(p.execSql).toBe('SELECT 1 WHERE n = {n:UInt8}');
    expect(p.params).toMatchObject({ param_n: '42', max_result_bytes: FILTER_RESULT_BYTE_CAP });
    expect(p.params).not.toHaveProperty('readonly');
    expect(p.params).not.toHaveProperty('read_only');
    expect(p.boundParams).toHaveLength(1);
    expect(p.boundParams[0]).toMatchObject({ name: 'n', serializedValue: '42' });
  });
  it('waiting: a required param with an empty value gates as missing, no error, params still built', () => {
    const a = analyzeFilterSource('SELECT 1 WHERE d = {d:DateTime}');
    const p = prepareFilterSource(a, { values: {} });
    expect(p.readiness).toBe('waiting');
    expect(p.error).toBeNull();
    expect(p.missing).toEqual(['d']);
    expect(p.invalid).toEqual([]);
    expect(p.params).not.toHaveProperty('param_d');
    expect(p.params).toMatchObject({ max_result_bytes: FILTER_RESULT_BYTE_CAP });
  });
  it('error (invalid): a bad committed value under execute-mode validation gates and names the field', () => {
    const a = analyzeFilterSource('SELECT 1 WHERE n = {n:UInt8}');
    const p = prepareFilterSource(a, { values: { n: '256' } });
    expect(p.readiness).toBe('error');
    expect(p.invalid).toEqual(['n']);
    expect(p.error).toBe('Invalid value for: n');
  });
  it('error (diagnostics): a cascading violation surfaces as the reported error, ahead of runnable value state', () => {
    const a = analyzeFilterSource('SELECT 1 WHERE a = {a:String}', { sourceBackedParams: ['a'], label: 'F' });
    const p = prepareFilterSource(a, { values: { a: 'x' } });
    expect(p.readiness).toBe('error');
    expect(p.error).toBe(a.diagnostics[0].message);
  });
  it('error (source-level template error): a whole dropped block-only statement surfaces src.errors as the reported error', () => {
    // The second "statement" is entirely an optional block, so the splitter
    // drops it whole (comment-only) — analyzeParameterizedSources treats that
    // mismatch as a source-level template error distinct from any structural
    // Filter-SQL diagnostic or invalid/missing value.
    const a = analyzeFilterSource('SELECT 1; /*[ SELECT 2 WHERE {a:String} ]*/');
    expect(a.diagnostics).toEqual([]);
    const p = prepareFilterSource(a, { values: {} });
    expect(p.readiness).toBe('error');
    expect(p.errors).toEqual(['optional block: a block cannot wrap a whole statement']);
    expect(p.error).toBe('optional block: a block cannot wrap a whole statement');
  });
  it('defaults opts to {} when omitted (no values/active/wallNowMs)', () => {
    const a = analyzeFilterSource('SELECT 1');
    const p = prepareFilterSource(a);
    expect(p.readiness).toBe('runnable');
    expect(p.error).toBeNull();
  });
  it('resolves two relative params in one statement against a single pinned wallNowMs', () => {
    const a = analyzeFilterSource('SELECT 1 WHERE a >= {from:DateTime} AND a < {to:DateTime}');
    const nowMs = 1751200000000;
    const p = prepareFilterSource(a, { values: { from: '-1h', to: '-30m' }, wallNowMs: nowMs });
    const expectedFrom = String(Math.round((nowMs - 3600000) / 1000));
    const expectedTo = String(Math.round((nowMs - 1800000) / 1000));
    expect(p.readiness).toBe('runnable');
    expect(p.params).toMatchObject({ param_from: expectedFrom, param_to: expectedTo });
    const byName = Object.fromEntries(p.boundParams.map((b) => [b.name, b]));
    expect(byName.from.resolvedValue).toBe(expectedFrom);
    expect(byName.to.resolvedValue).toBe(expectedTo);
  });
});
