import { describe, expect, it } from 'vitest';
import { readFilterOptions } from '../../src/core/filter-options.js';

const read = (columns, row, extra = {}) => readFilterOptions({ columns, row, rowCount: 1, ...extra });

describe('Filter option reader', () => {
  it('normalizes scalar arrays losslessly, preserves order, and first-wins duplicates', () => {
    const out = read([{ name: 'id', type: 'Array(UInt64)' }], [['9007199254740993', '', '9007199254740993']]);
    expect(out.helpers[0]).toMatchObject({ name: 'id', shape: 'array', totalOptions: 3, truncated: false,
      options: [{ value: '9007199254740993', label: '9007199254740993' }, { value: '', label: '' }] });
    expect(out.diagnostics.map((d) => d.code)).toEqual(['filter-duplicate-option']);
  });
  it('normalizes named tuple arrays in source order and ignores extra members', () => {
    const columns = [{ name: 'origin', type: 'Array(Tuple(label String, extra UInt8, value String))' }];
    const out = read(columns, [[{ value: 'ATL', label: 'Atlanta', extra: 1 }, { value: 'JFK', label: 'New York' }]]);
    expect(out.helpers[0]).toMatchObject({ shape: 'tuple-array', options: [{ value: 'ATL', label: 'Atlanta' }, { value: 'JFK', label: 'New York' }] });
  });
  it('normalizes Maps and sorts by label then value', () => {
    const out = read([{ name: 'year', type: 'Map(UInt16, String)' }], [{ 2024: 'Same', 2023: 'Same', 2022: 'Earlier' }]);
    expect(out.helpers[0].options).toEqual([
      { value: '2022', label: 'Earlier' }, { value: '2023', label: 'Same' }, { value: '2024', label: 'Same' },
    ]);
  });
  it('normalizes the two #160-documented value/label shapes (named tuple array, and Map)', () => {
    // Array(Tuple(value, label)) — e.g.
    //   arraySort(x -> x.label, groupUniqArray((Origin AS value, OriginCityName AS label)))
    // (emitted as {value,label} objects via output_format_json_named_tuples_as_objects).
    const tuple = read([{ name: 'origin', type: 'Array(Tuple(value String, label String))' }],
      [[{ value: 'ATL', label: 'Atlanta' }, { value: 'JFK', label: 'New York' }]]);
    expect(tuple.helpers[0]).toMatchObject({ shape: 'tuple-array',
      options: [{ value: 'ATL', label: 'Atlanta' }, { value: 'JFK', label: 'New York' }] });
    // Map(K, V) — e.g. mapFromArrays(groupArray(Origin), groupArray(OriginCityName)).
    const map = read([{ name: 'origin', type: 'Map(String, String)' }], [{ ATL: 'Atlanta', JFK: 'New York' }]);
    expect(map.helpers[0]).toMatchObject({ shape: 'map',
      options: [{ value: 'ATL', label: 'Atlanta' }, { value: 'JFK', label: 'New York' }] });
    // The query-log-explorer `user` filter: value = the full user that binds to
    // {user:String}, label = the name before '@' for display.
    const users = read([{ name: 'user', type: 'Array(Tuple(value String, label String))' }],
      [[{ value: 'btyshkevich@altinity.com', label: 'btyshkevich' }, { value: 'default', label: 'default' }]]);
    expect(users.helpers[0].options).toEqual([
      { value: 'btyshkevich@altinity.com', label: 'btyshkevich' }, { value: 'default', label: 'default' }]);
  });
  it('enforces the result envelope before helper parsing', () => {
    expect(readFilterOptions({ rowCount: 0 }).diagnostics[0].code).toBe('filter-row-count');
    expect(readFilterOptions({ rowCount: 2 }).diagnostics[0].code).toBe('filter-row-count');
    expect(read([{ name: 'x', type: 'Array(String)' }, { name: 'x', type: 'Array(String)' }], [[], []]).diagnostics[0].code).toBe('filter-duplicate-helper-name');
    const capped = read(Array.from({ length: 3 }, (_, i) => ({ name: String(i), type: 'Array(String)' })), [[], [], []], { helperCap: 2 });
    expect(capped.diagnostics[0].code).toBe('filter-helper-cap');
  });
  it('keeps valid siblings when another helper is malformed', () => {
    const out = read([
      { name: 'good', type: 'Array(String)' }, { name: 'bad', type: 'String' }, { name: 'also', type: 'Map(String, String)' },
    ], [['a'], 'x', { z: 'Zed' }]);
    expect(out.helpers.map((h) => h.name)).toEqual(['good', 'also']);
    expect(out.diagnostics.map((d) => d.code)).toContain('filter-unsupported-helper-type');
    expect(out.diagnostics.map((d) => d.code)).not.toContain('filter-no-valid-helpers');
  });
  it('rejects NULL, unsupported values, positional/missing tuple members, and empty invalid sources', () => {
    expect(read([{ name: 'x', type: 'Array(String)' }], [[null]]).diagnostics.map((d) => d.code)).toContain('filter-null-option');
    expect(read([{ name: 'x', type: 'Array(String)' }], [[{}]]).diagnostics.map((d) => d.code)).toContain('filter-option-type');
    expect(read([{ name: 'x', type: 'Array(Tuple(String, String))' }], [[['a', 'A']]]).diagnostics.map((d) => d.code)).toContain('filter-unsupported-helper-type');
    expect(read([{ name: 'x', type: 'Array(Tuple(value String))' }], [[{ value: 'a' }]]).diagnostics.map((d) => d.code)).toContain('filter-missing-option-label');
    expect(read([{ name: 'x', type: 'Array(Tuple(label String))' }], [[{ label: 'A' }]]).diagnostics.map((d) => d.code)).toContain('filter-missing-option-value');
    expect(read([], []).diagnostics.at(-1).code).toBe('filter-no-valid-helpers');
  });
  it('rejects malformed tuple option declarations and runtime members', () => {
    expect(read([{ name: 'x', type: 'Array(Tuple(value Array(String), label String))' }], [[]]).diagnostics[0].code).toBe('filter-option-type');
    expect(read([{ name: 'x', type: 'Array(Tuple(value String, label String))' }], [['not-an-object']]).diagnostics[0].code).toBe('filter-invalid-option-tuple');
    expect(read([{ name: 'x', type: 'Array(Tuple(value String, label String))' }], [[{ value: null, label: 'N' }]]).diagnostics[0].code).toBe('filter-null-option');
    expect(read([{ name: 'x', type: 'Array(Tuple(value String, label String))' }], [[{ value: {}, label: 'N' }]]).diagnostics[0].code).toBe('filter-option-type');
    expect(read([{ name: 'x', type: 'Array(Array(String))' }], [[['nested']]]).diagnostics[0].code).toBe('filter-unsupported-helper-type');
  });
  it('rejects malformed Map declarations and runtime pairs', () => {
    expect(read([{ name: 'x', type: 'Map(Array(String), String)' }], [{}]).diagnostics[0].code).toBe('filter-unsupported-helper-type');
    expect(read([{ name: 'x', type: 'Map(String, String)' }], ['bad']).diagnostics[0].code).toBe('filter-option-type');
    expect(read([{ name: 'x', type: 'Map(String, String)' }], [[['only-key']]]).diagnostics[0].code).toBe('filter-null-option');
    expect(read([{ name: 'x', type: 'Map(String, String)' }], [[[null, 'label']]]).diagnostics[0].code).toBe('filter-null-option');
    expect(read([{ name: 'x', type: 'Map(String, String)' }], [[['key', {}]]]).diagnostics[0].code).toBe('filter-option-type');
    expect(read([{ name: 'x', type: 'Map(String, String)' }], [[['b', 'Same'], ['a', 'Same']]]).helpers[0].options).toEqual([
      { value: 'a', label: 'Same' }, { value: 'b', label: 'Same' },
    ]);
  });
  it('reports malformed ClickHouse type syntax without discarding healthy siblings', () => {
    const out = read([{ name: 'bad', type: 'Array(' }, { name: 'good', type: 'Array(String)' }], [[], ['ok']]);
    expect(out.helpers.map((h) => h.name)).toEqual(['good']);
    expect(out.diagnostics[0].code).toBe('filter-unsupported-helper-type');
  });
  it('retains empty helpers and reports truncation', () => {
    expect(read([{ name: 'x', type: 'Array(String)' }], [[]]).helpers[0].options).toEqual([]);
    const out = read([{ name: 'x', type: 'Array(String)' }], [['a', 'b', 'c']], { optionCap: 2 });
    expect(out.helpers[0]).toMatchObject({ totalOptions: 3, truncated: true, options: [{ value: 'a', label: 'a' }, { value: 'b', label: 'b' }] });
    expect(out.diagnostics.at(-1).code).toBe('filter-options-truncated');
  });
});
