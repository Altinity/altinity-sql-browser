// Pure KPI result normalization and display formatting. SQL owns every runtime
// value; the saved-query Presentation Spec contributes display metadata only.

import { cloneJson, isPlainObject } from './saved-query.js';
import { namedTupleMembers, parseClickHouseType, unwrapNullable } from './clickhouse-type.js';

const NUMERIC = /^(?:U?Int(?:8|16|32|64|128|256)|Float(?:32|64)|BFloat16|Decimal(?:32|64|128|256)?\s*\()/;

export function isKpiNumericType(type) {
  const parsed = parseClickHouseType(type);
  return !!parsed && NUMERIC.test(unwrapNullable(parsed).raw);
}

export function parseKpiTupleType(type) {
  const parsed = parseClickHouseType(type);
  const members = parsed && namedTupleMembers(parsed);
  return members ? members.map((member) => ({ name: member.name, type: member.type.raw })) : null;
}

export function resolveKpiPresentation({ fieldConfig, columnName }) {
  const config = isPlainObject(fieldConfig) ? fieldConfig : {};
  const defaults = isPlainObject(config.defaults) ? cloneJson(config.defaults) : {};
  const columns = isPlainObject(config.columns) ? config.columns : {};
  const column = isPlainObject(columns[columnName]) ? cloneJson(columns[columnName]) : {};
  const delta = {
    ...(isPlainObject(defaults.delta) ? defaults.delta : {}),
    ...(isPlainObject(column.delta) ? column.delta : {}),
  };
  const presentation = { ...defaults, ...column, delta };
  presentation.displayName = typeof presentation.displayName === 'string' ? presentation.displayName : columnName;
  presentation.noValue = typeof presentation.noValue === 'string' ? presentation.noValue : '—';
  return presentation;
}

function numericValue(value) {
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function trimFixed(value, places) {
  return value.toFixed(places).replace(/(?:\.0+|(\.\d*?)0+)$/, '$1');
}

function decimalString(value, places, trim) {
  const match = /^([+-]?)(\d+)(?:\.(\d*))?$/.exec(String(value).trim());
  if (!match) return null;
  const fraction = match[3] || '';
  const kept = fraction.padEnd(places + 1, '0');
  const digits = match[2] + kept.slice(0, places);
  let scaled = BigInt(digits || '0');
  if (kept[places] >= '5') scaled += 1n;
  const base = 10n ** BigInt(places);
  const whole = scaled / base;
  const remainder = places ? String(scaled % base).padStart(places, '0') : '';
  const sign = match[1] === '-' && scaled !== 0n ? '-' : '';
  const rendered = sign + whole + (places ? '.' + remainder : '');
  return trim ? rendered.replace(/(?:\.0+|(\.\d*?)0+)$/, '$1') : rendered;
}

function compactInteger(value) {
  const integer = typeof value === 'bigint' ? value : BigInt(String(value).trim());
  const negative = integer < 0n;
  const absolute = negative ? -integer : integer;
  if (absolute < 1000n) return String(integer);
  const bands = [[1_000_000_000n, 'B'], [1_000_000n, 'M'], [1000n, 'K']];
  let bandIndex = bands.findIndex(([limit]) => absolute >= limit);
  let [size, suffix] = bands[bandIndex];
  let places = absolute < size * 10n ? 1 : 0;
  let scale = places ? 10n : 1n;
  let rounded = (absolute * scale + size / 2n) / size;
  if (rounded >= 1000n * scale && bandIndex > 0) {
    [size, suffix] = bands[--bandIndex];
    places = absolute < size * 10n ? 1 : 0;
    scale = places ? 10n : 1n;
    rounded = (absolute * scale + size / 2n) / size;
  }
  const whole = rounded / scale;
  const fraction = places && rounded % scale ? '.' + (rounded % scale) : '';
  return (negative ? '-' : '') + whole + fraction + suffix;
}

export function formatKpiValue({ value, clickhouseType, presentation = {} }) {
  if (value == null) return presentation.noValue ?? '—';
  const parsedType = parseClickHouseType(clickhouseType);
  const type = parsedType ? unwrapNullable(parsedType).raw : String(clickhouseType || '');
  const explicit = Number.isInteger(presentation.decimals) ? presentation.decimals : null;
  let rendered;
  const integerString = /^(?:U?Int)/.test(type) && (typeof value === 'bigint' || /^[+-]?\d+$/.test(String(value).trim()));
  const exactDecimal = typeof value === 'string' && /^[+-]?\d+(?:\.\d*)?$/.test(value.trim());
  if (integerString && explicit != null) rendered = decimalString(value, explicit, false);
  else if (integerString) rendered = compactInteger(value);
  else if (exactDecimal) rendered = decimalString(value, explicit ?? 2, explicit == null);
  else {
    const number = numericValue(value);
    if (number == null) return presentation.noValue ?? '—';
    const fixed = explicit != null ? number.toFixed(explicit) : trimFixed(number, 2);
    rendered = /^-0(?:\.0+)?$/.test(fixed) ? fixed.slice(1) : fixed;
  }
  return rendered + (typeof presentation.unit === 'string' ? presentation.unit : '');
}

const diagnostic = (severity, code, message, columnName) => ({
  severity, code, message, ...(columnName == null ? {} : { columnName }),
});

export function readKpiFields({ columns = [], row, rowCount = row ? 1 : 0, fieldConfig = {}, serverVersion } = {}) {
  if (rowCount === 0) return { items: [], diagnostics: [diagnostic('info', 'kpi-no-data', 'No data')] };
  if (rowCount !== 1) return { items: [], diagnostics: [diagnostic('error', 'kpi-row-count', `Expected 1 row, got ${rowCount}`)] };
  const diagnostics = [];
  const items = [];
  const names = new Set(columns.map((column) => column.name));
  const metadataColumns = isPlainObject(fieldConfig) && isPlainObject(fieldConfig.columns) ? fieldConfig.columns : {};
  for (const name of Object.keys(metadataColumns)) {
    if (!names.has(name)) diagnostics.push(diagnostic('warning', 'kpi-missing-field-metadata-target', `Field metadata targets missing column ${name}`, name));
  }
  columns.forEach((column, columnIndex) => {
    const presentation = resolveKpiPresentation({ fieldConfig, columnName: column.name });
    if (presentation.hidden === true) return;
    const value = Array.isArray(row) ? row[columnIndex] : row?.[column.name];
    const members = parseKpiTupleType(column.type);
    if (members) {
      if (value != null && !isPlainObject(value)) {
        const suffix = serverVersion ? ` by ClickHouse ${serverVersion}` : '';
        diagnostics.push(diagnostic('warning', 'kpi-server-named-tuple-unsupported', `Column ${column.name} was not returned as a named tuple object${suffix}`, column.name));
        return;
      }
      const valueMember = members.find((member) => member.name === 'value');
      const deltaMember = members.find((member) => member.name === 'delta');
      if (!valueMember) { diagnostics.push(diagnostic('warning', 'kpi-missing-tuple-value', `Column ${column.name} has no value tuple member`, column.name)); return; }
      if (!isKpiNumericType(valueMember.type)) { diagnostics.push(diagnostic('warning', 'kpi-nonnumeric-tuple-value', `Column ${column.name} has non-numeric value type ${valueMember.type}`, column.name)); return; }
      let delta = null; let deltaType = null;
      if (deltaMember && !isKpiNumericType(deltaMember.type)) diagnostics.push(diagnostic('warning', 'kpi-nonnumeric-delta', `Column ${column.name} has non-numeric delta type ${deltaMember.type}`, column.name));
      else if (deltaMember) { delta = value?.delta ?? null; deltaType = deltaMember.type; }
      items.push({ columnName: column.name, columnIndex, sourceType: column.type, kind: 'tuple', value: value?.value ?? null, valueType: valueMember.type, delta, deltaType, presentation });
      return;
    }
    if (!isKpiNumericType(column.type)) {
      diagnostics.push(diagnostic('warning', 'kpi-unsupported-field', `Column ${column.name} has unsupported KPI type ${column.type}`, column.name));
      return;
    }
    items.push({ columnName: column.name, columnIndex, sourceType: column.type, kind: 'scalar', value, valueType: column.type, delta: null, deltaType: null, presentation });
  });
  if (!items.length) diagnostics.push(diagnostic('error', 'kpi-no-eligible-fields', 'No eligible KPI fields in this result'));
  return { items, diagnostics };
}

export function kpiDeltaState(item) {
  if (item.delta == null || item.presentation.delta?.show === false) return null;
  const numeric = numericValue(item.delta);
  if (numeric == null) return null;
  const direction = numeric > 0 ? 'up' : numeric < 0 ? 'down' : 'flat';
  const positiveIsGood = item.presentation.delta?.positiveIsGood;
  const semantic = positiveIsGood == null || direction === 'flat'
    ? 'neutral'
    : (numeric > 0) === positiveIsGood ? 'good' : 'bad';
  return { value: item.delta, direction, semantic };
}
