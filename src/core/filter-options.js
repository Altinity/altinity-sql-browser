import {
  arrayElement, isSupportedOptionScalar, mapTypes, namedTupleMembers, parseClickHouseType,
} from './clickhouse-type.js';
import { FILTER_HELPER_CAP, FILTER_OPTION_CAP } from './filter-execution.js';
import { diagnostic as diag } from './diagnostics.js';
const scalar = (value) => (
  value !== null && value !== undefined && !Array.isArray(value) && typeof value !== 'object'
    ? String(value)
    : null
);

function finalizeOptions(name, entries, totalOptions, optionCap, diagnostics, sort) {
  const seen = new Set();
  const options = [];
  for (const entry of entries.slice(0, optionCap)) {
    if (seen.has(entry.value)) {
      diagnostics.push(diag('info', 'filter-duplicate-option', `Filter helper "${name}" contains a duplicate value.`, { helperName: name, optionIndex: entry.index }));
      continue;
    }
    seen.add(entry.value);
    options.push({ value: entry.value, label: entry.label });
  }
  if (sort) options.sort((a, b) => a.label.localeCompare(b.label) || a.value.localeCompare(b.value));
  const truncated = totalOptions > optionCap;
  if (truncated) diagnostics.push(diag('warning', 'filter-options-truncated', `Filter helper "${name}" is limited to ${optionCap.toLocaleString()} options.`, { helperName: name }));
  return { options, totalOptions, truncated };
}

function arrayHelper(name, type, value, optionCap, diagnostics) {
  const element = arrayElement(type);
  if (!element || !Array.isArray(value)) return null;
  const members = namedTupleMembers(element);
  if (members) {
    const valueMember = members.find((member) => member.name === 'value');
    const labelMember = members.find((member) => member.name === 'label');
    if (!valueMember) {
      diagnostics.push(diag('error', 'filter-missing-option-value', `Filter helper "${name}" tuple requires a value member.`, { helperName: name }));
      return false;
    }
    if (!labelMember) {
      diagnostics.push(diag('error', 'filter-missing-option-label', `Filter helper "${name}" tuple requires a label member.`, { helperName: name }));
      return false;
    }
    if (!isSupportedOptionScalar(valueMember.type) || !isSupportedOptionScalar(labelMember.type)) {
      diagnostics.push(diag('error', 'filter-option-type', `Filter helper "${name}" tuple members must use supported scalar types.`, { helperName: name }));
      return false;
    }
    const entries = [];
    for (let index = 0; index < value.length; index++) {
      const item = value[index];
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        diagnostics.push(diag('error', 'filter-invalid-option-tuple', `Filter helper "${name}" option ${index + 1} is not a named tuple object.`, { helperName: name, optionIndex: index }));
        return false;
      }
      const optionValue = scalar(item.value);
      const label = scalar(item.label);
      if (item.value == null || item.label == null) {
        diagnostics.push(diag('error', 'filter-null-option', `Filter helper "${name}" option ${index + 1} contains NULL.`, { helperName: name, optionIndex: index }));
        return false;
      }
      if (optionValue == null || label == null) {
        diagnostics.push(diag('error', 'filter-option-type', `Filter helper "${name}" option ${index + 1} is not scalar.`, { helperName: name, optionIndex: index }));
        return false;
      }
      entries.push({ value: optionValue, label, index });
    }
    return { shape: 'tuple-array', ...finalizeOptions(name, entries, value.length, optionCap, diagnostics, false) };
  }
  if (!isSupportedOptionScalar(element)) {
    diagnostics.push(diag('error', 'filter-unsupported-helper-type', `Filter helper "${name}" has an unsupported Array element type.`, { helperName: name }));
    return false;
  }
  const entries = [];
  for (let index = 0; index < value.length; index++) {
    const item = value[index];
    if (item == null) {
      diagnostics.push(diag('error', 'filter-null-option', `Filter helper "${name}" option ${index + 1} is NULL.`, { helperName: name, optionIndex: index }));
      return false;
    }
    const normalized = scalar(item);
    if (normalized == null) {
      diagnostics.push(diag('error', 'filter-option-type', `Filter helper "${name}" option ${index + 1} is not scalar.`, { helperName: name, optionIndex: index }));
      return false;
    }
    entries.push({ value: normalized, label: normalized, index });
  }
  return { shape: 'array', ...finalizeOptions(name, entries, value.length, optionCap, diagnostics, false) };
}

function mapHelper(name, type, value, optionCap, diagnostics) {
  const types = mapTypes(type);
  if (!types) return null;
  if (!isSupportedOptionScalar(types[0]) || !isSupportedOptionScalar(types[1])) {
    diagnostics.push(diag('error', 'filter-unsupported-helper-type', `Filter helper "${name}" has unsupported Map key or value types.`, { helperName: name }));
    return false;
  }
  const pairs = Array.isArray(value)
    ? value
    : value && typeof value === 'object' ? Object.entries(value) : null;
  if (!pairs) {
    diagnostics.push(diag('error', 'filter-option-type', `Filter helper "${name}" did not return a structured Map.`, { helperName: name }));
    return false;
  }
  const entries = [];
  for (let index = 0; index < pairs.length; index++) {
    const pair = pairs[index];
    if (!Array.isArray(pair) || pair.length < 2 || pair[0] == null || pair[1] == null) {
      diagnostics.push(diag('error', 'filter-null-option', `Filter helper "${name}" Map entry ${index + 1} is invalid or NULL.`, { helperName: name, optionIndex: index }));
      return false;
    }
    const optionValue = scalar(pair[0]);
    const label = scalar(pair[1]);
    if (optionValue == null || label == null) {
      diagnostics.push(diag('error', 'filter-option-type', `Filter helper "${name}" Map entry ${index + 1} is not scalar.`, { helperName: name, optionIndex: index }));
      return false;
    }
    entries.push({ value: optionValue, label, index });
  }
  return { shape: 'map', ...finalizeOptions(name, entries, pairs.length, optionCap, diagnostics, true) };
}

export function readFilterOptions({
  columns = [], row, rowCount = row == null ? 0 : 1,
  optionCap = FILTER_OPTION_CAP, helperCap = FILTER_HELPER_CAP,
} = {}) {
  const diagnostics = [];
  const helpers = [];
  if (rowCount !== 1) {
    diagnostics.push(diag('error', 'filter-row-count', `Filter result must contain exactly one row; received ${rowCount}.`));
    return { helpers, diagnostics };
  }
  const names = new Set();
  for (const column of columns) {
    if (names.has(column.name)) {
      diagnostics.push(diag('error', 'filter-duplicate-helper-name', `Filter result contains duplicate helper name "${column.name}".`, { helperName: column.name }));
      return { helpers, diagnostics };
    }
    names.add(column.name);
  }
  if (columns.length > helperCap) {
    diagnostics.push(diag('error', 'filter-helper-cap', `Filter result exceeds the ${helperCap} helper limit.`));
    return { helpers, diagnostics };
  }
  for (let columnIndex = 0; columnIndex < columns.length; columnIndex++) {
    const column = columns[columnIndex];
    const name = String(column.name);
    const type = parseClickHouseType(column.type);
    const value = Array.isArray(row) ? row[columnIndex] : row?.[name];
    if (!type) {
      diagnostics.push(diag('error', 'filter-unsupported-helper-type', `Filter helper "${name}" has a malformed ClickHouse type.`, { helperName: name }));
      continue;
    }
    const normalized = arrayHelper(name, type, value, optionCap, diagnostics)
      ?? mapHelper(name, type, value, optionCap, diagnostics);
    if (!normalized) {
      if (normalized === null) diagnostics.push(diag('error', 'filter-unsupported-helper-type', `Filter helper "${name}" must be an Array or Map.`, { helperName: name }));
      continue;
    }
    helpers.push({
      name, columnIndex, sourceType: column.type, shape: normalized.shape,
      options: normalized.options, totalOptions: normalized.totalOptions, truncated: normalized.truncated,
    });
  }
  if (!helpers.length) diagnostics.push(diag('error', 'filter-no-valid-helpers', 'Filter result contains no valid option helpers.'));
  return { helpers, diagnostics };
}
