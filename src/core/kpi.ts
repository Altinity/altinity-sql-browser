// Pure KPI result normalization and display formatting. SQL owns every runtime
// value; the saved-query Presentation Spec contributes display metadata only.

import { isPlainObject } from './saved-query.js';
import { namedTupleMembers, parseClickHouseType, unwrapValueTransparentWrappers } from './clickhouse-type.js';
import { resolveFieldConfig } from './field-config.js';
import type { FieldPresentation } from './field-config.js';
import type { DeltaPresentation, FieldConfig } from '../generated/json-schema.types.js';

const NUMERIC = /^(?:U?Int(?:8|16|32|64|128|256)|Float(?:32|64)|BFloat16|Decimal(?:32|64|128|256)?\s*\()/;

export function isKpiNumericType(type?: string | null): boolean {
  const parsed = parseClickHouseType(type);
  if (!parsed) return false;
  // `!`: unwrapValueTransparentWrappers only ever returns null for a falsy
  // input node (see clickhouse-type.ts) — `parsed` is truthy here, so the
  // unwrap always resolves to a real TypeNode.
  return NUMERIC.test(unwrapValueTransparentWrappers(parsed)!.raw);
}

/** One member of a `Tuple(name Type, …)` KPI value, as `readKpiFields` reads it. */
export interface KpiTupleMember {
  name: string;
  type: string;
}

export function parseKpiTupleType(type?: string | null): KpiTupleMember[] | null {
  const parsed = parseClickHouseType(type);
  const members = parsed ? namedTupleMembers(parsed) : null;
  return members ? members.map((member) => ({ name: member.name, type: member.type.raw })) : null;
}

export function resolveKpiPresentation(
  { fieldConfig, columnName }: { fieldConfig: unknown; columnName: string },
): FieldPresentation {
  const presentation = resolveFieldConfig(fieldConfig, columnName);
  const delta = isPlainObject(presentation.delta) ? presentation.delta : {};
  // `as`: `isPlainObject`'s predicate narrows to a bare `Record<string,
  // unknown>`, which structurally satisfies `DeltaPresentation` (itself just
  // named optional fields plus an `unknown`-valued index signature) but isn't
  // proven to TS field-by-field — the single cast documents that overlap.
  presentation.delta = delta as DeltaPresentation;
  return presentation;
}

function numericValue(value: unknown): number | null {
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function trimFixed(value: number, places: number): string {
  return value.toFixed(places).replace(/(?:\.0+|(\.\d*?)0+)$/, '$1');
}

function decimalString(value: unknown, places: number, trim: boolean): string | null {
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

function compactInteger(value: unknown): string {
  const integer = typeof value === 'bigint' ? value : BigInt(String(value).trim());
  const negative = integer < 0n;
  const absolute = negative ? -integer : integer;
  if (absolute < 1000n) return String(integer);
  const bands: [bigint, string][] = [[1_000_000_000n, 'B'], [1_000_000n, 'M'], [1000n, 'K']];
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

/** The presentation fields `formatKpiValue` itself reads — a subset of the
 *  full `FieldPresentation` (real callers pass the whole thing; the extra
 *  fields just ride along unread). No index signature: kpi-panel.ts's own
 *  narrower local presentation type must keep satisfying this parameter
 *  without also declaring one. */
interface KpiValuePresentation {
  decimals?: number | null;
  unit?: string;
  noValue?: string;
}

/** `formatKpiValue`'s rendering split into its two visual pieces (#316) — the
 *  digits/no-value text and the unit suffix — so kpi-panel.ts's `.kpi-value`
 *  can wrap each in its own `<span>` (keeping them visually glued together
 *  via CSS) without duplicating any of the numeric-formatting logic below.
 *  `formatKpiValue` itself is exactly `rendered + unit` concatenated, so every
 *  existing caller that only wants the flat string keeps the identical
 *  output. */
export function formatKpiValueParts(
  { value, clickhouseType, presentation = {} }:
  { value: unknown; clickhouseType?: string | null; presentation?: KpiValuePresentation },
): { rendered: string; unit: string } {
  const unit = typeof presentation.unit === 'string' ? presentation.unit : '';
  if (value == null) return { rendered: presentation.noValue ?? '—', unit: '' };
  const parsedType = parseClickHouseType(clickhouseType);
  // `!`: see isKpiNumericType above — a truthy `parsedType` always unwraps to
  // a real TypeNode.
  const type = parsedType ? unwrapValueTransparentWrappers(parsedType)!.raw : String(clickhouseType || '');
  const explicit = Number.isInteger(presentation.decimals) ? (presentation.decimals as number) : null;
  let rendered: string;
  const integerString = /^(?:U?Int)/.test(type) && (typeof value === 'bigint' || /^[+-]?\d+$/.test(String(value).trim()));
  const exactDecimal = typeof value === 'string' && /^[+-]?\d+(?:\.\d*)?$/.test(value.trim());
  // `!` (both calls below): `decimalString` only returns null when its
  // `/^([+-]?)(\d+)(?:\.(\d*))?$/` regex fails to match — `integerString`
  // (bigint stringifies the same digits-only shape) and `exactDecimal` are
  // each already a proof that `String(value).trim()` matches that same shape,
  // so the call can never actually return null on either branch.
  if (integerString && explicit != null) rendered = decimalString(value, explicit, false)!;
  else if (integerString) rendered = compactInteger(value);
  else if (exactDecimal) rendered = decimalString(value, explicit ?? 2, explicit == null)!;
  else {
    const number = numericValue(value);
    if (number == null) return { rendered: presentation.noValue ?? '—', unit: '' };
    const fixed = explicit != null ? number.toFixed(explicit) : trimFixed(number, 2);
    rendered = /^-0(?:\.0+)?$/.test(fixed) ? fixed.slice(1) : fixed;
  }
  return { rendered, unit };
}

export function formatKpiValue(
  args: { value: unknown; clickhouseType?: string | null; presentation?: KpiValuePresentation },
): string {
  const { rendered, unit } = formatKpiValueParts(args);
  return rendered + unit;
}

/** One diagnostic as `readKpiFields`/kpi-panel.js's `renderKpiCards` produce it. */
export interface KpiDiagnostic {
  severity: 'info' | 'warning' | 'error';
  code: string;
  message: string;
  columnName?: string;
}

const diagnostic = (
  severity: KpiDiagnostic['severity'], code: string, message: string, columnName?: string,
): KpiDiagnostic => ({
  severity, code, message, ...(columnName == null ? {} : { columnName }),
});

/** A ClickHouse result column as `readKpiFields` reads it. */
export interface KpiColumn {
  name: string;
  type: string;
  [k: string]: unknown;
}

/** One `{name:Type}` runtime row as ClickHouse's structured streaming formats
 *  return it: positional (an array, indexed by `columnIndex`) or keyed (an
 *  object, indexed by `column.name`) — `readKpiFields` accepts either. */
export type KpiRow = unknown[] | Record<string, unknown> | null;

/** One eligible KPI field `readKpiFields` read out of the row. */
export interface KpiItem {
  columnName: string;
  columnIndex: number;
  sourceType: string;
  kind: 'scalar' | 'tuple';
  value: unknown;
  valueType: string;
  delta: unknown;
  deltaType: string | null;
  presentation: FieldPresentation;
}

/** `readKpiFields`'s result: the eligible fields plus every diagnostic raised
 *  while reading them. */
export interface KpiReadout {
  items: KpiItem[];
  diagnostics: KpiDiagnostic[];
}

export function readKpiFields(
  { columns = [], row, rowCount = row ? 1 : 0, fieldConfig = {}, serverVersion }:
  {
    columns?: KpiColumn[]; row?: KpiRow; rowCount?: number;
    fieldConfig?: FieldConfig; serverVersion?: string | null;
  } = {},
): KpiReadout {
  if (rowCount === 0) return { items: [], diagnostics: [diagnostic('info', 'kpi-no-data', 'No data')] };
  if (rowCount !== 1) return { items: [], diagnostics: [diagnostic('error', 'kpi-row-count', `Expected 1 row, got ${rowCount}`)] };
  const diagnostics: KpiDiagnostic[] = [];
  const items: KpiItem[] = [];
  const names = new Set(columns.map((column) => column.name));
  const metadataColumns = isPlainObject(fieldConfig) && isPlainObject(fieldConfig.columns) ? fieldConfig.columns : {};
  for (const name of Object.keys(metadataColumns)) {
    if (!names.has(name)) diagnostics.push(diagnostic('warning', 'kpi-missing-field-metadata-target', `Field metadata targets missing column ${name}`, name));
  }
  columns.forEach((column, columnIndex) => {
    const presentation = resolveKpiPresentation({ fieldConfig, columnName: column.name });
    if (presentation.hidden === true) return;
    const value: unknown = Array.isArray(row) ? row[columnIndex] : row?.[column.name];
    const members = parseKpiTupleType(column.type);
    if (members) {
      if (value != null && !isPlainObject(value)) {
        const suffix = serverVersion ? ` by ClickHouse ${serverVersion}` : '';
        diagnostics.push(diagnostic('warning', 'kpi-server-named-tuple-unsupported', `Column ${column.name} was not returned as a named tuple object${suffix}`, column.name));
        return;
      }
      // `as`: the guard above returned already for a non-null, non-plain-object
      // value, so `value` is now either nullish or a plain tuple object.
      const tupleValue = value as Record<string, unknown> | null | undefined;
      const valueMember = members.find((member) => member.name === 'value');
      const deltaMember = members.find((member) => member.name === 'delta');
      if (!valueMember) { diagnostics.push(diagnostic('warning', 'kpi-missing-tuple-value', `Column ${column.name} has no value tuple member`, column.name)); return; }
      if (!isKpiNumericType(valueMember.type)) { diagnostics.push(diagnostic('warning', 'kpi-nonnumeric-tuple-value', `Column ${column.name} has non-numeric value type ${valueMember.type}`, column.name)); return; }
      let delta: unknown = null; let deltaType: string | null = null;
      if (deltaMember && !isKpiNumericType(deltaMember.type)) diagnostics.push(diagnostic('warning', 'kpi-nonnumeric-delta', `Column ${column.name} has non-numeric delta type ${deltaMember.type}`, column.name));
      else if (deltaMember) { delta = tupleValue?.delta ?? null; deltaType = deltaMember.type; }
      items.push({
        columnName: column.name, columnIndex, sourceType: column.type, kind: 'tuple',
        value: tupleValue?.value ?? null, valueType: valueMember.type, delta, deltaType, presentation,
      });
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

/** The minimal shape `kpiDeltaState` reads — real callers pass a full `KpiItem`.
 *  Deliberately narrower than `DeltaPresentation` (no index signature): a
 *  caller's own local presentation type (e.g. kpi-panel.ts's, which mirrors
 *  only the fields it reads) must keep satisfying this without also
 *  declaring one. */
interface KpiDeltaSource {
  delta: unknown;
  presentation: { delta?: { show?: boolean; positiveIsGood?: boolean } };
}

/** `kpiDeltaState`'s verdict: the raw delta value, its direction, and whether
 *  that direction reads as good/bad/neutral given the field's `positiveIsGood`. */
export interface KpiDeltaState {
  value: unknown;
  direction: 'up' | 'down' | 'flat';
  semantic: 'good' | 'bad' | 'neutral';
}

export function kpiDeltaState(item: KpiDeltaSource): KpiDeltaState | null {
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
