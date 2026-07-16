// Pure resolution for saved panel field metadata. Renderers consume a safe,
// cloned presentation object while the authored Spec remains untouched and
// retains unknown forward-compatible fields.

import { cloneJson, isPlainObject } from './saved-query.js';

const validDecimals = (value) => Number.isInteger(value) && value >= 0 && value <= 20;
const pick = (column, defaults, key, valid, fallback) => (
  valid(column[key]) ? column[key] : valid(defaults[key]) ? defaults[key] : fallback
);

/** Whether authored metadata intentionally replaces Chart.js value text. */
export function hasFieldValueFormat(fieldConfig, columnName) {
  const config = isPlainObject(fieldConfig) ? fieldConfig : {};
  const defaults = isPlainObject(config.defaults) ? config.defaults : {};
  const columns = isPlainObject(config.columns) ? config.columns : {};
  const column = isPlainObject(columns[columnName]) ? columns[columnName] : {};
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
export function resolveFieldConfig(fieldConfig, columnName) {
  const config = isPlainObject(fieldConfig) ? fieldConfig : {};
  const defaults = isPlainObject(config.defaults) ? cloneJson(config.defaults) : {};
  const columns = isPlainObject(config.columns) ? config.columns : {};
  const column = isPlainObject(columns[columnName]) ? cloneJson(columns[columnName]) : {};
  const presentation = { ...defaults, ...column };

  if (isPlainObject(defaults.delta) || isPlainObject(column.delta)) {
    presentation.delta = {
      ...(isPlainObject(defaults.delta) ? defaults.delta : {}),
      ...(isPlainObject(column.delta) ? column.delta : {}),
    };
  }

  presentation.displayName = pick(column, defaults, 'displayName', (v) => typeof v === 'string', columnName);
  presentation.description = pick(column, defaults, 'description', (v) => typeof v === 'string', null);
  presentation.unit = pick(column, defaults, 'unit', (v) => typeof v === 'string', '');
  presentation.decimals = pick(column, defaults, 'decimals', validDecimals, null);
  presentation.color = pick(column, defaults, 'color', (v) => typeof v === 'string' && v.length > 0, null);
  presentation.noValue = pick(column, defaults, 'noValue', (v) => typeof v === 'string', '—');
  presentation.hidden = pick(column, defaults, 'hidden', (v) => typeof v === 'boolean', false);
  return presentation;
}
