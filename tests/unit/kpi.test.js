import { describe, expect, it } from 'vitest';
import { formatKpiValue, isKpiNumericType, kpiDeltaState, parseKpiTupleType, readKpiFields, resolveKpiPresentation } from '../../src/core/kpi.js';

describe('KPI ClickHouse types', () => {
  it('recognizes numeric families and nullable wrappers only', () => {
    for (const type of ['Int8', 'UInt256', 'Float32', 'Float64', 'BFloat16', 'Decimal(20, 4)', 'Decimal128(2)', 'Nullable(Nullable(UInt64))']) expect(isKpiNumericType(type), type).toBe(true);
    for (const type of ['', 'String', 'Array(UInt8)', 'DateTime', 'Tuple(UInt8, UInt8)']) expect(isKpiNumericType(type), type).toBe(false);
  });
  // #238 — KPI numeric detection is unchanged: LowCardinality is transparent
  // for the value type here exactly as Nullable already was.
  it('LowCardinality (and LowCardinality(Nullable(...))) unwrap the same as Nullable', () => {
    for (const type of ['LowCardinality(UInt64)', 'LowCardinality(Nullable(Float64))', 'Nullable(LowCardinality(Decimal(10, 2)))']) {
      expect(isKpiNumericType(type), type).toBe(true);
    }
  });
  it('parses named tuples with nested types and rejects positional tuples', () => {
    expect(parseKpiTupleType('Tuple(value Decimal(10, 2), delta Nullable(Float64), extra Array(UInt8))')).toEqual([
      { name: 'value', type: 'Decimal(10, 2)' }, { name: 'delta', type: 'Nullable(Float64)' }, { name: 'extra', type: 'Array(UInt8)' },
    ]);
    expect(parseKpiTupleType('Nullable(Tuple(`value` UInt64, "delta" Int8))')).toEqual([{ name: 'value', type: 'UInt64' }, { name: 'delta', type: 'Int8' }]);
    expect(parseKpiTupleType('Tuple(UInt64, Float64)')).toBeNull();
    expect(parseKpiTupleType('String')).toBeNull();
    expect(parseKpiTupleType('Tuple()')).toBeNull();
  });
});

describe('KPI presentation and formatting', () => {
  it('clones defaults and overrides while merging delta independently', () => {
    const fieldConfig = { defaults: { decimals: 1, noValue: 'n/a', future: { x: 1 }, delta: { unit: ' pp', positiveIsGood: true } }, columns: { score: { displayName: 'Score', unit: '%', future: { y: 2 }, delta: { decimals: 2 } } } };
    const out = resolveKpiPresentation({ fieldConfig, columnName: 'score' });
    expect(out).toEqual({
      decimals: 1, noValue: 'n/a', displayName: 'Score', description: null,
      unit: '%', color: null, hidden: false, future: { y: 2 },
      delta: { unit: ' pp', positiveIsGood: true, decimals: 2 },
    });
    out.future.y = 9;
    expect(fieldConfig.columns.score.future.y).toBe(2);
    expect(resolveKpiPresentation({ fieldConfig: null, columnName: 'x' })).toEqual({
      displayName: 'x', description: null, unit: '', decimals: null,
      color: null, noValue: '—', hidden: false, delta: {},
    });
  });
  it('formats compact integers, decimals, units, null, negative zero, and invalid values', () => {
    expect(formatKpiValue({ value: 999, clickhouseType: 'UInt64' })).toBe('999');
    expect(formatKpiValue({ value: 1500, clickhouseType: 'UInt64' })).toBe('1.5K');
    expect(formatKpiValue({ value: 20_000, clickhouseType: 'Int64' })).toBe('20K');
    expect(formatKpiValue({ value: 999_500, clickhouseType: 'UInt64' })).toBe('1M');
    expect(formatKpiValue({ value: 999_999_999, clickhouseType: 'UInt64' })).toBe('1B');
    expect(formatKpiValue({ value: 1_500_000, clickhouseType: 'UInt64' })).toBe('1.5M');
    expect(formatKpiValue({ value: 2_000_000_000, clickhouseType: 'UInt64' })).toBe('2B');
    expect(formatKpiValue({ value: '12.40', clickhouseType: 'Decimal(10,2)' })).toBe('12.4');
    expect(formatKpiValue({ value: '9007199254740993', clickhouseType: 'UInt64', presentation: { decimals: 0 } })).toBe('9007199254740993');
    expect(formatKpiValue({ value: '-9007199254740993', clickhouseType: 'Int64', presentation: { decimals: 2 } })).toBe('-9007199254740993.00');
    expect(formatKpiValue({ value: '9007199254740993.255', clickhouseType: 'Decimal(30,3)', presentation: { decimals: 2 } })).toBe('9007199254740993.26');
    expect(formatKpiValue({ value: 12.345, clickhouseType: 'Float64', presentation: { decimals: 2, unit: '%' } })).toBe('12.35%');
    expect(formatKpiValue({ value: -0, clickhouseType: 'Float64' })).toBe('0');
    expect(formatKpiValue({ value: -0.001, clickhouseType: 'Float64' })).toBe('0');
    expect(formatKpiValue({ value: -0.001, clickhouseType: 'Float64', presentation: { decimals: 2 } })).toBe('0.00');
    expect(formatKpiValue({ value: '-0.001', clickhouseType: 'Decimal(8,3)', presentation: { decimals: 2 } })).toBe('0.00');
    expect(formatKpiValue({ value: null, clickhouseType: 'UInt64', presentation: { noValue: 'None' } })).toBe('None');
    expect(formatKpiValue({ value: Infinity, clickhouseType: 'Float64' })).toBe('—');
    expect(formatKpiValue({ value: 'nope', clickhouseType: 'Float64' })).toBe('—');
    expect(formatKpiValue({ value: false, clickhouseType: 'UInt8' })).toBe('—');
    expect(formatKpiValue({ value: 5n, clickhouseType: 'UInt64' })).toBe('5');
  });
  it('derives delta direction and good/bad/neutral semantics', () => {
    const item = (delta, config = {}) => ({ delta, presentation: { delta: config } });
    expect(kpiDeltaState(item(2, { positiveIsGood: true }))).toEqual({ value: 2, direction: 'up', semantic: 'good' });
    expect(kpiDeltaState(item(-2, { positiveIsGood: true }))).toEqual({ value: -2, direction: 'down', semantic: 'bad' });
    expect(kpiDeltaState(item(2, { positiveIsGood: false })).semantic).toBe('bad');
    expect(kpiDeltaState(item(0, { positiveIsGood: false })).semantic).toBe('neutral');
    expect(kpiDeltaState(item(2)).semantic).toBe('neutral');
    expect(kpiDeltaState(item('-9007199254740993'))).toEqual({ value: '-9007199254740993', direction: 'down', semantic: 'neutral' });
    expect(kpiDeltaState(item(null))).toBeNull();
    expect(kpiDeltaState(item('bad'))).toBeNull();
    expect(kpiDeltaState(item(2, { show: false }))).toBeNull();
  });
});

describe('readKpiFields', () => {
  it('handles row counts before reading fields', () => {
    expect(readKpiFields({ rowCount: 0 }).diagnostics[0]).toMatchObject({ code: 'kpi-no-data', severity: 'info' });
    expect(readKpiFields({ rowCount: 3 }).diagnostics[0]).toMatchObject({ code: 'kpi-row-count', message: 'Expected 1 row, got 3' });
    expect(readKpiFields().diagnostics[0].code).toBe('kpi-no-data');
  });
  it('reads scalar and tuple cards in result order with metadata', () => {
    const columns = [{ name: 'users', type: 'UInt64' }, { name: 'availability', type: 'Tuple(delta Nullable(Float64), value Decimal(6,2), ignored String)' }, { name: 'region', type: 'String' }];
    const fieldConfig = { defaults: { decimals: 1, delta: { unit: ' pp' } }, columns: { users: { displayName: 'Active users' }, availability: { unit: '%' }, stale: { hidden: true } } };
    const out = readKpiFields({ columns, row: [42, { value: '99.95', delta: null, ignored: 'x' }, 'EU'], rowCount: 1, fieldConfig, serverVersion: '26.3' });
    expect(out.items.map((item) => [item.columnName, item.kind, item.value, item.delta])).toEqual([['users', 'scalar', 42, null], ['availability', 'tuple', '99.95', null]]);
    expect(out.items[0].presentation.displayName).toBe('Active users');
    expect(out.items[1].presentation.delta.unit).toBe(' pp');
    expect(out.diagnostics.map((d) => d.code)).toEqual(['kpi-missing-field-metadata-target', 'kpi-unsupported-field']);
  });
  it('skips hidden and invalid tuple fields with stable diagnostics', () => {
    const columns = [{ name: 'hidden', type: 'UInt64' }, { name: 'missing', type: 'Tuple(delta Float64)' }, { name: 'bad_value', type: 'Tuple(value String)' }, { name: 'bad_delta', type: 'Tuple(value UInt64, delta String)' }, { name: 'positional', type: 'Tuple(UInt64, Float64)' }];
    const out = readKpiFields({ columns, row: [1, { delta: 1 }, { value: 'x' }, { value: 7, delta: 'x' }, [1, 2]], rowCount: 1, fieldConfig: { columns: { hidden: { hidden: true } } } });
    expect(out.items).toHaveLength(1);
    expect(out.items[0]).toMatchObject({ columnName: 'bad_delta', value: 7, delta: null });
    expect(out.diagnostics.map((d) => d.code)).toEqual(['kpi-missing-tuple-value', 'kpi-nonnumeric-tuple-value', 'kpi-nonnumeric-delta', 'kpi-unsupported-field']);
  });
  it('reports no eligible fields and supports object-shaped rows', () => {
    const none = readKpiFields({ columns: [{ name: 's', type: 'String' }], row: { s: 'x' }, rowCount: 1 });
    expect(none.items).toEqual([]);
    expect(none.diagnostics.at(-1).code).toBe('kpi-no-eligible-fields');
    const object = readKpiFields({ columns: [{ name: 'n', type: 'Nullable(Int32)' }], row: { n: null }, rowCount: 1 });
    expect(object.items[0].value).toBeNull();
    const tupleString = readKpiFields({ columns: [{ name: 't', type: 'Tuple(value UInt64)' }], row: ['(42)'], rowCount: 1, serverVersion: '24.3' });
    expect(tupleString.items).toEqual([]);
    expect(tupleString.diagnostics.map((item) => item.code)).toEqual(['kpi-server-named-tuple-unsupported', 'kpi-no-eligible-fields']);
    expect(tupleString.diagnostics[0].message).toContain('ClickHouse 24.3');
  });
});
