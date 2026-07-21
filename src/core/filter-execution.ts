import { detectSqlFormat as _detectSqlFormat } from './format.js';
import {
  analyzeParameterizedSources, prepareParameterizedBatch, mergedSourceArgs, mergedSourceSql,
} from './param-pipeline.js';
import type { ParameterAnalysis, BoundParamSnapshot } from './param-pipeline.js';
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

/** The owned, lossless, bounded transport params every Filter-role query runs
 *  under — `max_result_bytes` plus the four JSON `output_format` flags that
 *  make the numeric/decimal round-trip lossless over JSON. Shared by
 *  `filterExecution` and `prepareFilterSource` so the caps are defined once;
 *  `overrides` layers on top (a caller-supplied extra/overriding param, same
 *  as `FilterExecutionDefaults.params`). Pure. */
function filterOwnedParams(overrides: Record<string, string | number> = {}): Record<string, string | number> {
  return {
    max_result_bytes: FILTER_RESULT_BYTE_CAP,
    output_format_json_named_tuples_as_objects: 1,
    output_format_json_quote_64bit_integers: 1,
    output_format_json_quote_decimals: 1,
    output_format_json_quote_64bit_floats: 1,
    ...overrides,
  };
}

export function filterExecution(sql?: string | null, defaults: FilterExecutionDefaults = {}): FilterExecutionPlan {
  const diagnostics = filterSqlDiagnostics(sql);
  return {
    owned: true,
    format: 'Filter',
    rowLimit: FILTER_TOP_LEVEL_ROW_LIMIT,
    params: filterOwnedParams(defaults.params),
    diagnostics,
    error: diagnostics.length ? diagnostics[0].message : null,
  };
}

// #360: a Filter-role source may now declare its OWN `{name:Type}` parameters
// (previously banned outright by the `filter-source-parameters` diagnostic
// removed above) — as long as every one of them is backed by ANOTHER source's
// own control (a workbench tab param, a dashboard-level filter), never by a
// second Filter source: a Filter depending on a Filter would need to re-run
// in a strict dependency order this app has no scheduler for (the single-
// layer cascading rule). `analyzeFilterSource` wraps the shared
// `param-pipeline.js` analysis phase for exactly one Filter source and folds
// that rule in as a diagnostic alongside the structural ones
// (`filterSqlDiagnostics`).

/** `analyzeFilterSource`'s return shape: the analyzed pipeline source (kept,
 *  not re-derived, by `prepareFilterSource`), the parameter names this
 *  source's SQL depends on, and every static reason it can't run. */
export interface FilterSourceAnalysis {
  sql: string;
  analysis: ParameterAnalysis;
  dependsOn: string[];
  diagnostics: FilterSqlDiagnostic[];
}

/**
 * Analyze one Filter source's SQL: the structural contract
 * (`filterSqlDiagnostics`) plus the shared parameter pipeline's analysis of
 * its own declared `{name:Type}` params (#360). `dependsOn` is every
 * parameter name this source's SQL declares — required outside any block or
 * confined to an optional block — in first-appearance order.
 * `opts.sourceBackedParams` is the set of names backed by ANOTHER Filter
 * source in the same dashboard; depending on any of them is the one
 * cascading violation this dashboard model disallows, and each becomes its
 * own `filter-source-cascading` diagnostic naming `opts.label` and the
 * offending parameter. `analysis.diagnostics` (the shared pipeline's own
 * cross-declaration type-conflict findings, e.g. `{x:UInt8}` vs `{x:String}`
 * in the same source) are folded in too, each as its own
 * `filter-source-param-type-conflict` diagnostic (#360) —
 * without this, a type-conflicted source would classify `runnable` in
 * `prepareFilterSource` and get sent. Pure.
 */
export function analyzeFilterSource(
  sql: string | null | undefined,
  opts: { sourceBackedParams?: Iterable<string>; label?: string } = {},
): FilterSourceAnalysis {
  const text = String(sql || '');
  const structural = filterSqlDiagnostics(text);
  const analysis = analyzeParameterizedSources([
    { id: 'filter', label: opts.label, kind: 'filter', sql: text, bindPolicy: 'row-returning' },
  ]);
  const dependsOn = Object.keys(analysis.fields).filter((name) => {
    const f = analysis.fields[name];
    return f.requiredIn.includes('filter') || f.optionalIn.includes('filter');
  });
  const backed = new Set(opts.sourceBackedParams || []);
  const cascading: FilterSqlDiagnostic[] = [];
  for (const name of dependsOn) {
    if (backed.has(name)) {
      cascading.push(diagnostic(
        'filter-source-cascading',
        `Filter source "${opts.label || 'source'}" depends on source-backed parameter "${name}". Cascading Filter sources are not supported.`,
      ));
    }
  }
  const typeConflicts = analysis.diagnostics.map((d) =>
    diagnostic('filter-source-param-type-conflict', d.message));
  return { sql: text, analysis, dependsOn, diagnostics: [...structural, ...cascading, ...typeConflicts] };
}

/** The three states `prepareFilterSource` classifies a Filter source into:
 *  `'error'` (a structural/cascading diagnostic, an invalid committed value,
 *  or a source-level template error), `'waiting'` (a required param has no
 *  value yet — a normal mid-fill state, not an error), or `'runnable'`. */
export type FilterSourceReadiness = 'runnable' | 'waiting' | 'error';

/** `prepareFilterSource`'s return shape: everything a caller needs to either
 *  show a banner/spinner or actually send the request. */
export interface FilterSourcePreparation {
  readiness: FilterSourceReadiness;
  diagnostics: FilterSqlDiagnostic[];
  dependsOn: string[];
  missing: string[];
  invalid: string[];
  errors: string[];
  error: string | null;
  execSql: string;
  params: Record<string, string | number>;
  format: 'Filter';
  rowLimit: number;
  boundParams: BoundParamSnapshot[];
}

/**
 * Prepare one already-analyzed Filter source against concrete `values`
 * (#360): wraps `prepareParameterizedBatch` (always `validationMode:
 * 'execute'` — a Filter source runs as soon as it's ready; there's no
 * separate blur/Enter commit step) and folds the result together with
 * `analyzed.diagnostics` into one readiness verdict, the owned transport
 * `params` (`filterOwnedParams()`'s caps ∪ the bound `param_<name>` args —
 * the same helper `filterExecution` builds its own `params` from, called
 * directly here rather than through `filterExecution` so this doesn't re-run
 * `filterSqlDiagnostics`, already computed by `analyzeFilterSource`), and
 * the materialized `execSql` to send. Takes the pre-analyzed source so a
 * caller re-running this every value edit derives `dependsOn` (and re-scans
 * the SQL) exactly once per SQL edit, not once per value edit. Pure.
 */
export function prepareFilterSource(
  analyzed: FilterSourceAnalysis,
  opts: { values?: Record<string, unknown>; active?: Record<string, boolean>; wallNowMs?: number } = {},
): FilterSourcePreparation {
  const prepared = prepareParameterizedBatch(analyzed.analysis, {
    values: opts.values,
    active: opts.active,
    wallNowMs: opts.wallNowMs,
    validationMode: 'execute',
  });
  // `analyzed.analysis` was built from exactly one source (`analyzeFilterSource`
  // above) — `prepareParameterizedBatch` preserves that 1:1 source cardinality,
  // so `sources[0]` always exists.
  const src = prepared.sources[0];
  const diagnostics = analyzed.diagnostics;
  const readiness: FilterSourceReadiness = diagnostics.length || src.invalid.length || src.errors.length
    ? 'error'
    : src.missing.length
      ? 'waiting'
      : 'runnable';
  const params = { ...filterOwnedParams(), ...mergedSourceArgs(src) };
  const error = diagnostics.length
    ? diagnostics[0].message
    : src.invalid.length
      ? `Invalid value for: ${src.invalid.join(', ')}`
      : src.errors.length
        ? src.errors[0]
        : null;
  return {
    readiness,
    diagnostics,
    dependsOn: analyzed.dependsOn,
    missing: src.missing.slice(),
    invalid: src.invalid.slice(),
    errors: src.errors.slice(),
    error,
    execSql: mergedSourceSql(src, analyzed.sql),
    params,
    format: 'Filter',
    rowLimit: FILTER_TOP_LEVEL_ROW_LIMIT,
    boundParams: src.statements.flatMap((s) => s.boundParams),
  };
}
