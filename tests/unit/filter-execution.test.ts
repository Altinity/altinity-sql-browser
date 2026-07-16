import { describe, expect, it } from 'vitest';
import {
  FILTER_RESULT_BYTE_CAP, FILTER_TOP_LEVEL_ROW_LIMIT, filterExecution, filterSqlDiagnostics,
} from '../../src/core/filter-execution.js';

describe('Filter execution', () => {
  it('owns a lossless, read-only, bounded structured transport', () => {
    const out = filterExecution('SELECT [1] AS id', { params: { custom: 1 } });
    expect(out).toMatchObject({ owned: true, format: 'Filter', rowLimit: FILTER_TOP_LEVEL_ROW_LIMIT, error: null, diagnostics: [] });
    expect(out.params).toMatchObject({ readonly: 2, max_result_bytes: FILTER_RESULT_BYTE_CAP, custom: 1,
      output_format_json_named_tuples_as_objects: 1, output_format_json_quote_64bit_integers: 1,
      output_format_json_quote_decimals: 1, output_format_json_quote_64bit_floats: 1 });
  });
  it('reports every static SQL contract failure', () => {
    expect(filterSqlDiagnostics('')).toMatchObject([{ code: 'filter-sql-empty' }]);
    expect(filterSqlDiagnostics('SELECT 1; SELECT 2').map((d) => d.code)).toContain('filter-sql-statement-count');
    expect(filterSqlDiagnostics('CREATE TABLE t (x Int8)').map((d) => d.code)).toContain('filter-sql-not-row-returning');
    expect(filterSqlDiagnostics('SELECT {x:String}').map((d) => d.code)).toContain('filter-source-parameters');
    expect(filterSqlDiagnostics('SELECT 1 /*[ WHERE x={x:String} ]*/').map((d) => d.code)).toContain('filter-source-parameters');
    expect(filterSqlDiagnostics('SELECT 1 FORMAT JSON').map((d) => d.code)).toContain('filter-owned-format');
    expect(filterExecution('SELECT 1 FORMAT JSON').error).toContain('FORMAT');
  });
});
