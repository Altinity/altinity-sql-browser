// Saved-query time-range authoring inference (#334). Pure: SQL is analyzed
// through the shared parameter pipeline, and the supplied Spec is cloned only
// when one conservative pair can be materialized.

import { analyzeParameterizedSources } from './param-pipeline.js';
import type { ParameterAnalysis } from './param-pipeline.js';
import { cloneJson } from './saved-query.js';
import { isSupportedTimeRangeParamType } from './param-type.js';
import type { QuerySpecV1 } from '../generated/json-schema.types.js';

export const TIME_RANGE_NAME_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['from', 'to'],
  ['from_time', 'to_time'],
  ['start', 'end'],
  ['start_time', 'end_time'],
];

export interface QueryTimeRangeInferenceDiagnostic {
  path: (string | number)[];
  severity: 'warning';
  code: 'time-range-inference-ambiguous';
  message: string;
}

export interface QueryTimeRangeInferenceResult {
  spec: QuerySpecV1;
  inferred: boolean;
  diagnostics: QueryTimeRangeInferenceDiagnostic[];
}

export function hasSameTimeRangeParameter(spec: unknown): boolean {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return false;
  const ranges = (spec as { timeRanges?: unknown }).timeRanges;
  if (!Array.isArray(ranges) || ranges.length !== 1) return false;
  const pair = ranges[0];
  return !!pair && typeof pair === 'object' && !Array.isArray(pair)
    && typeof (pair as { from?: unknown }).from === 'string'
    && (pair as { from: string; to?: unknown }).from === (pair as { to?: unknown }).to;
}

export function analyzeQueryTimeRangeSql(sql: string): ParameterAnalysis {
  return analyzeParameterizedSources([{
    id: 'saved-query', kind: 'saved-query', sql, bindPolicy: 'row-returning',
  }]);
}

/** Infer one pair only when the property is absent. Candidate counting happens
 * before type gating: two recognized name pairs are ambiguous even if only one
 * later proves date-like, because choosing it would no longer be conservative. */
export function inferQueryTimeRange(
  spec: QuerySpecV1,
  analysis: ParameterAnalysis,
): QueryTimeRangeInferenceResult {
  if (Object.hasOwn(spec, 'timeRanges')) return { spec, inferred: false, diagnostics: [] };
  if (Object.keys(analysis.sourceErrors).length) return { spec, inferred: false, diagnostics: [] };

  const namesByFolded = new Map<string, string[]>();
  for (const name of Object.keys(analysis.fields)) {
    const key = name.toLowerCase();
    const names = namesByFolded.get(key) || [];
    names.push(name);
    namesByFolded.set(key, names);
  }
  const candidates = TIME_RANGE_NAME_PAIRS.flatMap(([fromKey, toKey]) => {
    const from = namesByFolded.get(fromKey) || [];
    const to = namesByFolded.get(toKey) || [];
    return from.length && to.length ? [{ from, to }] : [];
  });
  if (candidates.length === 0) return { spec, inferred: false, diagnostics: [] };
  if (candidates.length !== 1 || candidates[0].from.length !== 1 || candidates[0].to.length !== 1) {
    return {
      spec, inferred: false,
      diagnostics: [{
        path: ['timeRanges'], severity: 'warning', code: 'time-range-inference-ambiguous',
        message: 'Several recognized time-range parameter pairs exist. Author spec.timeRanges explicitly, or use [] to opt out.',
      }],
    };
  }

  const from = candidates[0].from[0];
  const to = candidates[0].to[0];
  const fields = [analysis.fields[from], analysis.fields[to]];
  const supported = fields.every((field) => !field.conflict && field.declarations.length > 0
    && field.declarations.every((declaration) => isSupportedTimeRangeParamType(declaration.type)));
  if (!supported) return { spec, inferred: false, diagnostics: [] };
  const next = cloneJson(spec);
  next.timeRanges = [{ from, to }];
  return { spec: next, inferred: true, diagnostics: [] };
}

export function materializeQueryTimeRange(spec: QuerySpecV1, sql: string): QueryTimeRangeInferenceResult {
  return inferQueryTimeRange(spec, analyzeQueryTimeRangeSql(sql));
}
