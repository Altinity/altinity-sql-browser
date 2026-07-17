import { detectSqlFormat as _detectSqlFormat } from './format.js';
import { analysisView } from './param-pipeline.js';
import { scanParamDeclarations } from './param-scan.js';
import { isRowReturning as _isRowReturning, splitStatements as _splitStatements } from './sql-split.js';
import { diagnostic as makeDiagnostic } from './diagnostics.js';
import type { Diagnostic } from './diagnostics.js';

// `format.js` / `sql-split.js` are unconverted (checkJs:false) — thin typed
// wrappers over the exact call signatures this file relies on, verified
// against the wrapped function bodies (same convention `param-type.ts` uses
// for `clickhouse-type.js`).
const detectSqlFormat = _detectSqlFormat as (sql: string) => string | null;
const isRowReturning = _isRowReturning as (stmt: string) => boolean;
const splitStatements = _splitStatements as (sql: string) => string[];

/** This module's own diagnostic shape: `diagnostic()` below always anchors at
 *  `severity: 'error'` and the Spec's `dashboard.role` path (#236) — narrower
 *  than `diagnostics.ts`'s general `{severity, code, message, ...extra}`
 *  factory, since every Filter-SQL contract failure really is one of these. */
export interface FilterSqlDiagnostic extends Diagnostic {
  severity: 'error';
  path: string[];
}

export const FILTER_TOP_LEVEL_ROW_LIMIT = 2;
export const FILTER_OPTION_CAP = 1000;
export const FILTER_HELPER_CAP = 50;
export const FILTER_RESULT_BYTE_CAP = 10_000_000;

// Filter-SQL diagnostics are always errors anchored at the Spec's dashboard.role
// path — the narrow shape over the shared factory (#236). `as`: `diagnostic()`'s
// return type is the general `Diagnostic` (severity widened to all three
// values, `path` only known via the index signature) — this call site is the
// one place that knows the literal `'error'` severity and a real `string[]`
// path always come out, so the narrowing is pinned here once.
const diagnostic = (code: string, message: string): FilterSqlDiagnostic =>
  makeDiagnostic('error', code, message, { path: ['dashboard', 'role'] }) as FilterSqlDiagnostic;

export function filterSqlDiagnostics(sql?: string | null): FilterSqlDiagnostic[] {
  const text = String(sql || '');
  if (!text.trim()) return [diagnostic('filter-sql-empty', 'Filter SQL must not be empty.')];
  const statements = splitStatements(text);
  const out: FilterSqlDiagnostic[] = [];
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

/** `filterExecution`'s caller-supplied defaults — today just extra/overriding
 *  ClickHouse HTTP `params`. */
export interface FilterExecutionDefaults {
  params?: Record<string, string | number>;
}

/** `filterExecution`'s return shape: the owned, lossless, bounded structured
 *  transport a Filter-role query runs under. */
export interface FilterExecutionPlan {
  owned: true;
  format: 'Filter';
  rowLimit: number;
  params: Record<string, string | number>;
  diagnostics: FilterSqlDiagnostic[];
  error: string | null;
}

export function filterExecution(sql?: string | null, defaults: FilterExecutionDefaults = {}): FilterExecutionPlan {
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
