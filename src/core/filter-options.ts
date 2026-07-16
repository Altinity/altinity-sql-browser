import {
  arrayElement as _arrayElement, isSupportedOptionScalar as _isSupportedOptionScalar,
  mapTypes as _mapTypes, namedTupleMembers as _namedTupleMembers,
  parseClickHouseType as _parseClickHouseType,
} from './clickhouse-type.js';
import { FILTER_HELPER_CAP, FILTER_OPTION_CAP } from './filter-execution.js';
import { diagnostic as diag } from './diagnostics.js';
import type { Diagnostic } from './diagnostics.js';
import type { Column } from './panel-cfg.js';

// The shared AST node shape `clickhouse-type.js` parses ClickHouse type
// expressions into, narrowed to exactly the fields this file reads — the
// same pinned-shape convention `param-type.ts` uses for this same
// unconverted module (checkJs:false), verified against the wrapped bodies.
interface LiteralArg {
  kind: 'string' | 'number';
  value: string;
  raw: string;
}
type TypeArg = TypeNode | LiteralArg;
interface TypeNode {
  kind: 'type';
  name: string;
  raw: string;
  args: TypeArg[];
  members: { name: string; type: TypeNode }[] | null;
  enumMembers?: { name: string; code: number }[];
}
const arrayElement = _arrayElement as (node: TypeNode) => TypeArg | null;
const isSupportedOptionScalar = _isSupportedOptionScalar as (node: TypeArg) => boolean;
const mapTypes = _mapTypes as (node: TypeNode) => [TypeArg, TypeArg] | null;
const namedTupleMembers = _namedTupleMembers as (node: TypeArg) => { name: string; type: TypeNode }[] | null;
const parseClickHouseType = _parseClickHouseType as (input: string) => TypeNode | null;

/** Narrows `unknown` to `unknown[]` (unlike the built-in `Array.isArray`,
 *  whose declared predicate is `arg is any[]`) so downstream element access
 *  stays typed rather than silently widening to `any`. */
function isArrayValue(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

/** Narrows `unknown` to a non-null, non-array plain-shaped object — the same
 *  "not a NULL/array/scalar" test the reject branches below spell out, just
 *  phrased as the affirmative guard so the narrowed type carries forward. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** One option a Filter helper column offers — the value bound into the
 *  consuming Panel's param and its display label. */
export interface FilterHelperOptionValue {
  value: string;
  label: string;
}

const scalar = (value: unknown): string | null => (
  value !== null && value !== undefined && !Array.isArray(value) && typeof value !== 'object'
    ? String(value)
    : null
);

// One entry on the way to `finalizeOptions` — the option's value/label plus
// its original index (for duplicate/error diagnostics).
interface OptionEntry {
  value: string;
  label: string;
  index: number;
}

interface FinalizeResult {
  options: FilterHelperOptionValue[];
  totalOptions: number;
  truncated: boolean;
}

function finalizeOptions(
  name: string, entries: OptionEntry[], totalOptions: number, optionCap: number,
  diagnostics: Diagnostic[], sort: boolean,
): FinalizeResult {
  const seen = new Set<string>();
  const options: FilterHelperOptionValue[] = [];
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

// One normalized helper's shape as `arrayHelper`/`mapHelper` report it —
// `null` when the value/type shape doesn't apply to that helper at all
// (readFilterOptions tries the other one), `false` when it does apply but
// failed validation (a diagnostic was already pushed).
interface HelperNormalized extends FinalizeResult {
  shape: 'array' | 'tuple-array' | 'map';
}
type HelperResult = HelperNormalized | null | false;

function arrayHelper(
  name: string, type: TypeNode, value: unknown, optionCap: number, diagnostics: Diagnostic[],
): HelperResult {
  const element = arrayElement(type);
  if (!element || !isArrayValue(value)) return null;
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
    const entries: OptionEntry[] = [];
    for (let index = 0; index < value.length; index++) {
      const item = value[index];
      if (!isRecord(item)) {
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
  const entries: OptionEntry[] = [];
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

function mapHelper(
  name: string, type: TypeNode, value: unknown, optionCap: number, diagnostics: Diagnostic[],
): HelperResult {
  const types = mapTypes(type);
  if (!types) return null;
  if (!isSupportedOptionScalar(types[0]) || !isSupportedOptionScalar(types[1])) {
    diagnostics.push(diag('error', 'filter-unsupported-helper-type', `Filter helper "${name}" has unsupported Map key or value types.`, { helperName: name }));
    return false;
  }
  const pairs: unknown[] | null = isArrayValue(value)
    ? value
    : value && typeof value === 'object' ? Object.entries(value) : null;
  if (!pairs) {
    diagnostics.push(diag('error', 'filter-option-type', `Filter helper "${name}" did not return a structured Map.`, { helperName: name }));
    return false;
  }
  const entries: OptionEntry[] = [];
  for (let index = 0; index < pairs.length; index++) {
    const pair = pairs[index];
    if (!isArrayValue(pair) || pair.length < 2 || pair[0] == null || pair[1] == null) {
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

/** `readFilterOptions`'s options bag. */
export interface ReadFilterOptionsInput {
  columns?: Column[];
  row?: unknown;
  rowCount?: number;
  optionCap?: number;
  helperCap?: number;
}

/** One normalized Filter helper column, as `dashboard-filters.js`'s
 *  `FilterHelper` reads it. */
export interface FilterOptionHelper {
  name: string;
  columnIndex: number;
  sourceType: string;
  shape: 'array' | 'tuple-array' | 'map';
  options: FilterHelperOptionValue[];
  totalOptions: number;
  truncated: boolean;
  [key: string]: unknown;
}

/** `readFilterOptions`'s return shape. */
export interface ReadFilterOptionsResult {
  helpers: FilterOptionHelper[];
  diagnostics: Diagnostic[];
}

export function readFilterOptions({
  columns = [], row, rowCount = row == null ? 0 : 1,
  optionCap = FILTER_OPTION_CAP, helperCap = FILTER_HELPER_CAP,
}: ReadFilterOptionsInput = {}): ReadFilterOptionsResult {
  const diagnostics: Diagnostic[] = [];
  const helpers: FilterOptionHelper[] = [];
  if (rowCount !== 1) {
    diagnostics.push(diag('error', 'filter-row-count', `Filter result must contain exactly one row; received ${rowCount}.`));
    return { helpers, diagnostics };
  }
  const names = new Set<string>();
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
    const value = isArrayValue(row) ? row[columnIndex] : isRecord(row) ? row[name] : undefined;
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
