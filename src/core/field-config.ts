// Pure resolution for saved panel field metadata. Renderers consume a safe,
// cloned presentation object while the authored Spec remains untouched and
// retains unknown forward-compatible fields.

import { cloneJson, isPlainObject } from './saved-query.js';
import type { DeltaPresentation } from '../generated/json-schema.types.js';

/** The resolved, cloned presentation metadata `resolveFieldConfig` returns —
 *  known fields typed, unknown renderer/forward-compatible extensions (incl.
 *  `future`-style fields seen in tests) retained via the index signature. */
export interface FieldPresentation {
  [key: string]: unknown;
  displayName: string;
  description: string | null;
  unit: string;
  decimals: number | null;
  color: string | null;
  noValue: string;
  hidden: boolean;
  delta?: DeltaPresentation;
}

function validDecimals(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 20;
}

function pick<T>(
  column: Record<string, unknown>,
  defaults: Record<string, unknown>,
  key: string,
  valid: (v: unknown) => v is T,
  fallback: T,
): T {
  const c = column[key];
  if (valid(c)) return c;
  const d = defaults[key];
  if (valid(d)) return d;
  return fallback;
}

/** Whether authored metadata intentionally replaces Chart.js value text. */
export function hasFieldValueFormat(fieldConfig: unknown, columnName: string): boolean {
  const config: Record<string, unknown> = isPlainObject(fieldConfig) ? fieldConfig : {};
  const defaults: Record<string, unknown> = isPlainObject(config.defaults) ? config.defaults : {};
  const columnsField = config.columns;
  const columns: Record<string, unknown> = isPlainObject(columnsField) ? columnsField : {};
  const rawColumn = columns[columnName];
  const column: Record<string, unknown> = isPlainObject(rawColumn) ? rawColumn : {};
  return [defaults, column].some((layer) => (
    (typeof layer.unit === 'string' && layer.unit !== '')
    || validDecimals(layer.decimals)
  ));
}

/**
 * Resolve exact-name field metadata with column → defaults → renderer fallback
 * precedence. The returned value is detached from `fieldConfig`; invalid known
 * values are replaced safely, while unknown extensions remain available.
 */
export function resolveFieldConfig(fieldConfig: unknown, columnName: string): FieldPresentation {
  const config: Record<string, unknown> = isPlainObject(fieldConfig) ? fieldConfig : {};
  const defaults: Record<string, unknown> = isPlainObject(config.defaults) ? cloneJson(config.defaults) : {};
  const columnsField = config.columns;
  const columns: Record<string, unknown> = isPlainObject(columnsField) ? columnsField : {};
  const rawColumn = columns[columnName];
  const column: Record<string, unknown> = isPlainObject(rawColumn) ? cloneJson(rawColumn) : {};
  const presentation = { ...defaults, ...column } as FieldPresentation;

  const defaultsDelta = defaults.delta;
  const columnDelta = column.delta;
  if (isPlainObject(defaultsDelta) || isPlainObject(columnDelta)) {
    presentation.delta = {
      ...(isPlainObject(defaultsDelta) ? defaultsDelta : {}),
      ...(isPlainObject(columnDelta) ? columnDelta : {}),
    } as DeltaPresentation;
  }

  presentation.displayName = pick(column, defaults, 'displayName', (v): v is string => typeof v === 'string', columnName);
  presentation.description = pick(column, defaults, 'description', (v): v is string => typeof v === 'string', null);
  presentation.unit = pick(column, defaults, 'unit', (v): v is string => typeof v === 'string', '');
  presentation.decimals = pick(column, defaults, 'decimals', validDecimals, null);
  presentation.color = pick(column, defaults, 'color', (v): v is string => typeof v === 'string' && v.length > 0, null);
  presentation.noValue = pick(column, defaults, 'noValue', (v): v is string => typeof v === 'string', '—');
  presentation.hidden = pick(column, defaults, 'hidden', (v): v is boolean => typeof v === 'boolean', false);
  return presentation;
}
