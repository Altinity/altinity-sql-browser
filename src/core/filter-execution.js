import { detectSqlFormat } from './format.js';
import { analysisView } from './param-pipeline.js';
import { scanParamDeclarations } from './param-scan.js';
import { isRowReturning, splitStatements } from './sql-split.js';
import { diagnostic as makeDiagnostic } from './diagnostics.js';

export const FILTER_TOP_LEVEL_ROW_LIMIT = 2;
export const FILTER_OPTION_CAP = 1000;
export const FILTER_HELPER_CAP = 50;
export const FILTER_RESULT_BYTE_CAP = 10_000_000;

// Filter-SQL diagnostics are always errors anchored at the Spec's dashboard.role
// path — the narrow shape over the shared factory (#236).
const diagnostic = (code, message) => makeDiagnostic('error', code, message, { path: ['dashboard', 'role'] });

export function filterSqlDiagnostics(sql) {
  const text = String(sql || '');
  if (!text.trim()) return [diagnostic('filter-sql-empty', 'Filter SQL must not be empty.')];
  const statements = splitStatements(text);
  const out = [];
  if (statements.length !== 1) {
    out.push(diagnostic('filter-sql-statement-count', 'Filter SQL must contain exactly one statement.'));
  } else if (!isRowReturning(statements[0])) {
    out.push(diagnostic('filter-sql-not-row-returning', 'Filter SQL must be a row-returning statement.'));
  }
  if (scanParamDeclarations(analysisView(text)).length) {
    out.push(diagnostic('filter-source-parameters', 'Filter SQL cannot declare query parameters.'));
  }
  if (detectSqlFormat(text)) {
    out.push(diagnostic('filter-owned-format', 'Filter SQL cannot include a trailing FORMAT clause.'));
  }
  return out;
}

export function filterExecution(sql, defaults = {}) {
  const diagnostics = filterSqlDiagnostics(sql);
  return {
    owned: true,
    format: 'Filter',
    rowLimit: FILTER_TOP_LEVEL_ROW_LIMIT,
    params: {
      readonly: 2,
      max_result_bytes: FILTER_RESULT_BYTE_CAP,
      output_format_json_named_tuples_as_objects: 1,
      output_format_json_quote_64bit_integers: 1,
      output_format_json_quote_decimals: 1,
      output_format_json_quote_64bit_floats: 1,
      ...(defaults.params || {}),
    },
    diagnostics,
    error: diagnostics.length ? diagnostics[0].message : null,
  };
}
