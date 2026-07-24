import { describe, it, expect } from 'vitest';
import { analyzeParameterizedSources } from '../../src/core/param-pipeline.js';
import type { ParameterAnalysis } from '../../src/core/param-pipeline.js';
import type { FilterSelectionFilterDef } from '../../src/core/filter-selection.js';
import { parseParamType } from '../../src/core/param-type.js';
import {
  inferTimeRangePairs,
  resolveTimeRangeGroups,
  resolveAuthoredTimeRangeGroups,
  validateTimeRangeDraft,
  chartScaleTimeToInstant,
  formatChartTimeLabel,
  formatChartTimeRange,
  formatTimeRangeDisplayValue,
  instantToChartScaleTime,
  pushRecentRange,
} from '../../src/core/time-range.js';
import type { TimeRangeRecent } from '../../src/core/time-range.js';

// Same fixture convention as tests/unit/filter-selection.test.ts: round-trip
// through the real `analyzeParameterizedSources` rather than a hand-crafted
// `ParameterAnalysis`.
const analysisFor = (sources: { id: string; sql: string }[]): ParameterAnalysis =>
  analyzeParameterizedSources(sources.map((s) => ({ id: s.id, kind: 'tab', sql: s.sql, bindPolicy: 'row-returning' })));

type TRFilterDef = FilterSelectionFilterDef & { sourceQueryId?: string | null };

describe('chart time-range formatting', () => {
  it('normalizes reverse selection and formats each declared wire type without shifting Date days', () => {
    const a = Date.UTC(2026, 6, 21, 12, 30, 45, 123);
    const b = Date.UTC(2026, 6, 22, 13, 31, 46, 987);
    expect(formatChartTimeRange({ fromMs: b, toMs: a, fromType: 'Date', toType: 'DateTime64(3)' })).toEqual({
      ok: true,
      from: '2026-07-21',
      to: String(Date.UTC(2026, 6, 22, 13, 31, 46, 987) / 1000),
      fromLabel: '2026-07-21',
      toLabel: '2026-07-22 13:31:46.987',
    });
    expect(formatChartTimeLabel(a, 'DateTime')).toBe('2026-07-21 12:30:45');
  });

  it('rejects non-finite selections', () => {
    expect(formatChartTimeRange({ fromMs: NaN, toMs: 1, fromType: 'DateTime', toType: 'DateTime' }))
      .toEqual({ ok: false, error: 'The selected time range is invalid.' });
  });

  it('accepts already-parsed types for range values and labels', () => {
    const parsed = parseParamType('DateTime');
    const ms = Date.UTC(2026, 0, 2, 3, 4, 5);
    expect(formatChartTimeRange({ fromMs: ms, toMs: ms, fromType: parsed, toType: parsed })).toMatchObject({ ok: true });
    expect(formatChartTimeLabel(ms, parsed)).toBe('2026-01-02 03:04:05');
  });

  it('projects epoch wire values to readable editor text without changing other tokens', () => {
    expect(formatTimeRangeDisplayValue('1784750189', 'DateTime')).toBe('2026-07-22 19:56:29');
    expect(formatTimeRangeDisplayValue('1784750189.123456', 'DateTime64(6)')).toBe('2026-07-22 19:56:29.123000');
    expect(formatTimeRangeDisplayValue('-1d', 'DateTime')).toBe('-1d');
    expect(formatTimeRangeDisplayValue('2026-07-22 19:56:29', 'DateTime')).toBe('2026-07-22 19:56:29');
    expect(formatTimeRangeDisplayValue('1784750189', 'Date')).toBe('1784750189');
  });

  it('preserves Chart.js epoch coordinates through an explicit column timezone', () => {
    const chartMs = Date.UTC(2026, 0, 2, 3, 4, 5, 123);
    const type = "DateTime64(3, 'America/Los_Angeles')";
    expect(chartScaleTimeToInstant(chartMs, type)).toBe(chartMs);
    expect(instantToChartScaleTime(chartMs, type)).toBe(chartMs);
  });

  it('fails closed for invalid explicit chart timezones and non-finite values', () => {
    expect(chartScaleTimeToInstant(0, "DateTime('Not/A_Zone')")).toBeNull();
    expect(instantToChartScaleTime(0, "DateTime('Not/A_Zone')")).toBeNull();
    expect(chartScaleTimeToInstant(NaN, 'DateTime')).toBeNull();
    expect(instantToChartScaleTime(Infinity, 'DateTime')).toBeNull();
  });
});

describe('authored time-range metadata defensive shapes', () => {
  it('infers legacy metadata-absent tiles on load but honors an explicit empty opt-out', () => {
    const filters: TRFilterDef[] = [{ id: 'from', parameter: 'from' }, { id: 'to', parameter: 'to' }];
    const result = resolveAuthoredTimeRangeGroups({
      filters,
      analysis: analysisFor([
        { id: 'legacy', sql: 'SELECT {from:DateTime}, {to:DateTime}' },
        { id: 'opted-out', sql: 'SELECT {from:DateTime}, {to:DateTime}' },
      ]),
      executableTileIds: new Set(['legacy', 'opted-out']),
      filterTargetTileIds: new Map([
        ['from', new Set(['legacy', 'opted-out'])],
        ['to', new Set(['legacy', 'opted-out'])],
      ]),
      tiles: [{ id: 'legacy', queryId: 'legacy-query' }, { id: 'opted-out', queryId: 'opted-query' }],
      queries: [{ id: 'legacy-query', spec: {} }, { id: 'opted-query', spec: { timeRanges: [] } }],
    });
    expect(result.groups).toEqual([
      expect.objectContaining({ fromFilterId: 'from', toFilterId: 'to', tileIds: ['legacy'] }),
    ]);
    expect(result.diagnostics).toEqual([]);
  });

  it('fails closed when one legacy tile has more than one recognized pair', () => {
    const filters: TRFilterDef[] = [
      { id: 'from', parameter: 'from' }, { id: 'to', parameter: 'to' },
      { id: 'start', parameter: 'start' }, { id: 'end', parameter: 'end' },
    ];
    const ids = new Set(['tile']);
    const result = resolveAuthoredTimeRangeGroups({
      filters,
      analysis: analysisFor([{
        id: 'tile', sql: 'SELECT {from:DateTime}, {to:DateTime}, {start:DateTime}, {end:DateTime}',
      }]),
      executableTileIds: ids,
      filterTargetTileIds: new Map(filters.map((filter) => [filter.id, ids])),
      tiles: [{ id: 'tile', queryId: 'legacy-query' }],
      queries: [{ id: 'legacy-query', spec: {} }],
    });
    expect(result).toEqual({ groups: [], diagnostics: [] });
  });

  it('treats an own undefined timeRanges value as malformed authored metadata, never as legacy omission', () => {
    const filters: TRFilterDef[] = [{ id: 'from', parameter: 'from' }, { id: 'to', parameter: 'to' }];
    const result = resolveAuthoredTimeRangeGroups({
      filters,
      analysis: analysisFor([{ id: 'tile', sql: 'SELECT {from:DateTime}, {to:DateTime}' }]),
      executableTileIds: new Set(['tile']),
      filterTargetTileIds: new Map([['from', new Set(['tile'])], ['to', new Set(['tile'])]]),
      tiles: [{ id: 'tile', queryId: 'query' }],
      queries: [{ id: 'query', spec: { timeRanges: undefined } }],
    });
    expect(result.groups).toEqual([]);
    expect(result.diagnostics).toEqual([expect.objectContaining({ code: 'time-range-contract-invalid' })]);
  });

  it('ignores malformed extension values before filter resolution', () => {
    const base = {
      filters: [] as TRFilterDef[], analysis: analysisFor([]), executableTileIds: new Set<string>(),
      filterTargetTileIds: new Map<string, ReadonlySet<string>>(),
    };
    const result = resolveAuthoredTimeRangeGroups({
      ...base,
      tiles: [
        { id: 'a', queryId: 'qa' }, { id: 'b', queryId: 'qb' }, { id: 'c', queryId: 'qc' },
        { id: 'd', queryId: 'qd' }, { id: 'e', queryId: 'qe' },
      ],
      queries: [
        { id: 'qa', spec: { timeRanges: [null] } },
        { id: 'qb', spec: { timeRanges: [{ from: 1, to: 'to' }] } },
        { id: 'qc', spec: { timeRanges: 'bad' } },
        { id: 'qd', spec: { timeRanges: [{ from: 'x', to: 'x' }] } },
        { id: 'qe', spec: { timeRanges: [{ from: 'x', to: 'y' }, { from: 'a', to: 'b' }] } },
      ],
    });
    expect(result.groups).toEqual([]);
    expect(result.diagnostics).toHaveLength(5);
    expect(result.diagnostics.every((item) => item.code === 'time-range-contract-invalid')).toBe(true);
  });

  it('diagnoses authored pairs whose declarations use unsupported date/time forms', () => {
    const filters: TRFilterDef[] = [{ id: 'from', parameter: 'from' }, { id: 'to', parameter: 'to' }];
    const result = resolveAuthoredTimeRangeGroups({
      filters,
      analysis: analysisFor([{ id: 'tile', sql: 'SELECT {from:DateTime(3)}, {to:DateTime}' }]),
      executableTileIds: new Set(['tile']),
      filterTargetTileIds: new Map([['from', new Set(['tile'])], ['to', new Set(['tile'])]]),
      tiles: [{ id: 'tile', queryId: 'query' }],
      queries: [{ id: 'query', spec: { timeRanges: [{ from: 'from', to: 'to' }] } }],
    });
    expect(result.groups).toEqual([]);
    expect(result.diagnostics).toEqual([expect.objectContaining({ code: 'time-range-contract-invalid' })]);
  });
});

describe('inferTimeRangePairs', () => {
  it('recognizes from/to (case-insensitive)', () => {
    const pairs = inferTimeRangePairs([{ id: 'f1', parameter: 'From' }, { id: 'f2', parameter: 'TO' }]);
    expect(pairs).toEqual([{ fromFilterId: 'f1', toFilterId: 'f2' }]);
  });
  it('recognizes from_time/to_time, start/end, start_time/end_time', () => {
    expect(inferTimeRangePairs([{ id: 'a', parameter: 'from_time' }, { id: 'b', parameter: 'to_time' }]))
      .toEqual([{ fromFilterId: 'a', toFilterId: 'b' }]);
    expect(inferTimeRangePairs([{ id: 'a', parameter: 'start' }, { id: 'b', parameter: 'end' }]))
      .toEqual([{ fromFilterId: 'a', toFilterId: 'b' }]);
    expect(inferTimeRangePairs([{ id: 'a', parameter: 'start_time' }, { id: 'b', parameter: 'end_time' }]))
      .toEqual([{ fromFilterId: 'a', toFilterId: 'b' }]);
  });
  it('never recognizes start/stop', () => {
    expect(inferTimeRangePairs([{ id: 'a', parameter: 'start' }, { id: 'b', parameter: 'stop' }])).toEqual([]);
  });
  it('a filter with a non-null sourceQueryId (curated) is never a candidate', () => {
    const pairs = inferTimeRangePairs([
      { id: 'a', parameter: 'from', sourceQueryId: 'q1' },
      { id: 'b', parameter: 'to' },
    ]);
    expect(pairs).toEqual([]);
  });
  it('a null sourceQueryId is NOT curated — still eligible', () => {
    const pairs = inferTimeRangePairs([
      { id: 'a', parameter: 'from', sourceQueryId: null },
      { id: 'b', parameter: 'to' },
    ]);
    expect(pairs).toEqual([{ fromFilterId: 'a', toFilterId: 'b' }]);
  });
  it('a parameter name borne by more than one filter def is unusable — no pair forms at all', () => {
    const pairs = inferTimeRangePairs([
      { id: 'f1', parameter: 'from' },
      { id: 'f2', parameter: 'from' },
      { id: 'f3', parameter: 'to' },
    ]);
    expect(pairs).toEqual([]);
  });
  it('multiple independent groups: rows are emitted in NAME_PAIR_TABLE order regardless of input array order', () => {
    const pairs = inferTimeRangePairs([
      { id: 'se-start', parameter: 'start' },
      { id: 'se-end', parameter: 'end' },
      { id: 'ft-to', parameter: 'to' },
      { id: 'ft-from', parameter: 'from' },
    ]);
    expect(pairs).toEqual([
      { fromFilterId: 'ft-from', toFilterId: 'ft-to' },
      { fromFilterId: 'se-start', toFilterId: 'se-end' },
    ]);
  });
  it('ambiguity: a filter id used across two would-be pairs drops BOTH pairs (defensive general rule)', () => {
    // Contrived (a filter def with a reused/duplicated id is a data-integrity
    // bug upstream), but exercises the general "at most one emitted pair per
    // filter id" rule directly: 'shared' appears once as a `from`-role match
    // and once as an `end`-role match, so both candidate pairs involving it
    // are dropped.
    const pairs = inferTimeRangePairs([
      { id: 'shared', parameter: 'from' },
      { id: 'other1', parameter: 'to' },
      { id: 'other2', parameter: 'start' },
      { id: 'shared', parameter: 'end' },
    ]);
    expect(pairs).toEqual([]);
  });
  it('no filters at all → no pairs', () => {
    expect(inferTimeRangePairs([])).toEqual([]);
  });
});

describe('resolveTimeRangeGroups — contract gating', () => {
  it('both bounds scalar + date-like across their executable consumers → one group', () => {
    const filters: TRFilterDef[] = [
      { id: 'f-from', parameter: 'from' },
      { id: 'f-to', parameter: 'to' },
    ];
    const analysis = analysisFor([
      { id: 'a', sql: 'SELECT * FROM t WHERE ts >= {from:DateTime} AND ts < {to:DateTime}' },
    ]);
    const groups = resolveTimeRangeGroups({ filters, analysis, executableTileIds: new Set(['a']) });
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      key: 'f-from\u0000f-to',
      fromFilterId: 'f-from',
      toFilterId: 'f-to',
      fromParameter: 'from',
      toParameter: 'to',
    });
    expect(groups[0].fromType.base).toBe('DateTime');
    expect(groups[0].toType.base).toBe('DateTime');
  });

  it('a non-date-like consumer type → no group', () => {
    const filters: TRFilterDef[] = [{ id: 'f-from', parameter: 'from' }, { id: 'f-to', parameter: 'to' }];
    const analysis = analysisFor([{ id: 'a', sql: 'SELECT * FROM t WHERE x = {from:String} AND y = {to:DateTime}' }]);
    expect(resolveTimeRangeGroups({ filters, analysis, executableTileIds: new Set(['a']) })).toEqual([]);
  });

  it('an Array(...) contract (arity: multiple) → no group', () => {
    const filters: TRFilterDef[] = [{ id: 'f-from', parameter: 'from' }, { id: 'f-to', parameter: 'to' }];
    const analysis = analysisFor([
      { id: 'a', sql: 'SELECT * FROM t WHERE ts IN {from:Array(DateTime)} AND ts2 = {to:DateTime}' },
    ]);
    expect(resolveTimeRangeGroups({ filters, analysis, executableTileIds: new Set(['a']) })).toEqual([]);
  });

  it('any resolution diagnostics (e.g. conflicting consumer types) → no group', () => {
    const filters: TRFilterDef[] = [{ id: 'f-from', parameter: 'from' }, { id: 'f-to', parameter: 'to' }];
    const analysis = analysisFor([
      { id: 'a', sql: 'SELECT * FROM t WHERE ts = {from:DateTime} AND te = {to:DateTime}' },
      { id: 'b', sql: 'SELECT * FROM u WHERE ts = {from:String}' },
    ]);
    // Both 'a' and 'b' are executable, so `from`'s consumers conflict
    // (DateTime vs String) — resolveFilterSelection surfaces a diagnostic,
    // and the group must not form even though `to` alone would qualify.
    expect(resolveTimeRangeGroups({ filters, analysis, executableTileIds: new Set(['a', 'b']) })).toEqual([]);
  });

  it('a curated (sourceQueryId-backed) filter never becomes a candidate pair, so no group forms', () => {
    const filters: TRFilterDef[] = [
      { id: 'f-from', parameter: 'from', sourceQueryId: 'saved-query-1' },
      { id: 'f-to', parameter: 'to' },
    ];
    const analysis = analysisFor([{ id: 'a', sql: 'SELECT * FROM t WHERE ts >= {from:DateTime} AND ts < {to:DateTime}' }]);
    expect(resolveTimeRangeGroups({ filters, analysis, executableTileIds: new Set(['a']) })).toEqual([]);
  });

  it('multiple independent groups resolve together, in pair-table order', () => {
    const filters: TRFilterDef[] = [
      { id: 'se-start', parameter: 'start' },
      { id: 'se-end', parameter: 'end' },
      { id: 'ft-from', parameter: 'from' },
      { id: 'ft-to', parameter: 'to' },
    ];
    const analysis = analysisFor([
      {
        id: 'a',
        sql: 'SELECT * FROM t WHERE s >= {start:Date} AND s < {end:Date} AND f >= {from:DateTime} AND f < {to:DateTime}',
      },
    ]);
    const groups = resolveTimeRangeGroups({ filters, analysis, executableTileIds: new Set(['a']) });
    expect(groups.map((g) => g.key)).toEqual(['ft-from\u0000ft-to', 'se-start\u0000se-end']);
  });

  it('key stability: recomputing over the same input yields an identical key', () => {
    const filters: TRFilterDef[] = [{ id: 'f-from', parameter: 'from' }, { id: 'f-to', parameter: 'to' }];
    const analysis = analysisFor([{ id: 'a', sql: 'SELECT * FROM t WHERE ts >= {from:DateTime} AND ts < {to:DateTime}' }]);
    const g1 = resolveTimeRangeGroups({ filters, analysis, executableTileIds: new Set(['a']) });
    const g2 = resolveTimeRangeGroups({ filters, analysis, executableTileIds: new Set(['a']) });
    expect(g1[0].key).toBe(g2[0].key);
    expect(g1[0].key).toBe('f-from\u0000f-to');
  });

  it('an explicit `pairs` seam (e.g. a future #334 resolution) is used verbatim instead of inference', () => {
    const filters: TRFilterDef[] = [
      { id: 'weird-from', parameter: 'not_from_at_all' },
      { id: 'weird-to', parameter: 'not_to_at_all' },
    ];
    const analysis = analysisFor([
      { id: 'a', sql: 'SELECT * FROM t WHERE ts >= {not_from_at_all:DateTime} AND ts < {not_to_at_all:DateTime}' },
    ]);
    const groups = resolveTimeRangeGroups({
      filters,
      analysis,
      executableTileIds: new Set(['a']),
      pairs: [{ fromFilterId: 'weird-from', toFilterId: 'weird-to' }],
    });
    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe('weird-from\u0000weird-to');
  });

  it('a pair referencing a filter id absent from `filters` is skipped rather than throwing', () => {
    const filters: TRFilterDef[] = [{ id: 'f-from', parameter: 'from' }, { id: 'f-to', parameter: 'to' }];
    const analysis = analysisFor([{ id: 'a', sql: 'SELECT * FROM t WHERE ts >= {from:DateTime} AND ts < {to:DateTime}' }]);
    const groups = resolveTimeRangeGroups({
      filters,
      analysis,
      executableTileIds: new Set(['a']),
      pairs: [
        { fromFilterId: 'missing-from', toFilterId: 'f-to' },
        { fromFilterId: 'f-from', toFilterId: 'missing-to' },
      ],
    });
    expect(groups).toEqual([]);
  });

  it('an empty filters/pairs list resolves to no groups', () => {
    const analysis = analysisFor([]);
    expect(resolveTimeRangeGroups({ filters: [], analysis, executableTileIds: new Set() })).toEqual([]);
  });

  it('skips an explicit pair whose filters have no executable consumer contract', () => {
    const filters: TRFilterDef[] = [{ id: 'f-from', parameter: 'from' }, { id: 'f-to', parameter: 'to' }];
    expect(resolveTimeRangeGroups({
      filters,
      analysis: analysisFor([]),
      executableTileIds: new Set(),
      pairs: [{ fromFilterId: 'f-from', toFilterId: 'f-to' }],
    })).toEqual([]);
  });
});

describe('validateTimeRangeDraft', () => {
  const NOW = Date.UTC(2026, 6, 21, 12, 0, 0, 0); // 2026-07-21 12:00:00 UTC

  it('relative token forms resolve both bounds against ONE shared nowMs', () => {
    const r = validateTimeRangeDraft({ fromText: '-1h', toText: '+1h', fromType: 'DateTime', toType: 'DateTime', nowMs: NOW });
    expect(r.from).toEqual({ ok: true, display: '2026-07-21 11:00:00', instantMs: NOW - 3600000, error: null, matchedRelative: true });
    expect(r.to).toEqual({ ok: true, display: '2026-07-21 13:00:00', instantMs: NOW + 3600000, error: null, matchedRelative: true });
    expect(r.rangeOk).toBe(true);
    expect(r.rangeError).toBeNull();
    expect(r.applyEnabled).toBe(true);
  });

  it('absolute forms per type: Date, DateTime, DateTime64 fractional, and the "T" variant', () => {
    const dateResult = validateTimeRangeDraft({ fromText: '2026-07-11', toText: '2026-07-12', fromType: 'Date', toType: 'Date', nowMs: NOW });
    expect(dateResult.from).toEqual({ ok: true, display: '2026-07-11', instantMs: Date.UTC(2026, 6, 11), error: null, matchedRelative: false });
    expect(dateResult.to.instantMs).toBe(Date.UTC(2026, 6, 12));

    const dtResult = validateTimeRangeDraft({
      fromText: '2026-07-11 09:00:00', toText: '2026-07-11T10:00:00',
      fromType: 'DateTime', toType: 'DateTime', nowMs: NOW,
    });
    expect(dtResult.from.instantMs).toBe(Date.UTC(2026, 6, 11, 9, 0, 0));
    expect(dtResult.to.instantMs).toBe(Date.UTC(2026, 6, 11, 10, 0, 0));
    expect(dtResult.rangeOk).toBe(true);

    const dt64Result = validateTimeRangeDraft({
      fromText: '2026-07-11 09:00:00.123', toText: '2026-07-11 09:00:00.500',
      fromType: 'DateTime64(3)', toType: 'DateTime64(3)', nowMs: NOW,
    });
    expect(dt64Result.from.instantMs).toBe(Date.UTC(2026, 6, 11, 9, 0, 0, 123));
    expect(dt64Result.to.instantMs).toBe(Date.UTC(2026, 6, 11, 9, 0, 0, 500));
  });

  it('bare epoch digits are accepted for DateTime/DateTime64', () => {
    const r = validateTimeRangeDraft({ fromText: '1783772625', toText: '1783772625123', fromType: 'DateTime', toType: 'DateTime64(3)', nowMs: NOW });
    expect(r.from).toEqual({ ok: true, display: expect.any(String), instantMs: 1783772625000, error: null, matchedRelative: false });
    expect(r.to.instantMs).toBe(1783772625123);
  });

  it('accepts fractional epoch seconds emitted for DateTime64', () => {
    const r = validateTimeRangeDraft({
      fromText: '1784750189.123456', toText: '1784750190.987654321',
      fromType: 'DateTime64(6)', toType: 'DateTime64(9)', nowMs: NOW,
    });
    expect(r.from).toMatchObject({ ok: true, instantMs: 1784750189123, display: '2026-07-22 19:56:29.123000' });
    expect(r.to).toMatchObject({ ok: true, instantMs: 1784750190987, display: '2026-07-22 19:56:30.987000000' });
  });

  it('invalid calendar dates are rejected', () => {
    const r = validateTimeRangeDraft({ fromText: '2026-02-30', toText: 'now', fromType: 'Date', toType: 'DateTime', nowMs: NOW });
    expect(r.from.ok).toBe(false);
    expect(r.from.error).toMatch(/not a valid calendar date/);
    expect(r.from.display).toBeNull();
    expect(r.from.instantMs).toBeNull();
    expect(r.rangeOk).toBe(false);
    expect(r.rangeError).toBeNull(); // only one bound resolved — no from>to comparison to make
    expect(r.applyEnabled).toBe(false);
  });

  it('garbage text is rejected', () => {
    const r = validateTimeRangeDraft({ fromText: 'garbage', toText: 'now', fromType: 'DateTime', toType: 'DateTime', nowMs: NOW });
    expect(r.from.ok).toBe(false);
    expect(r.from.error).toBeTruthy();
    expect(r.applyEnabled).toBe(false);
  });

  it('a near-miss relative expression surfaces the grammar error, not a silent absolute-parse attempt', () => {
    const r = validateTimeRangeDraft({ fromText: 'now/q', toText: 'now', fromType: 'DateTime', toType: 'DateTime', nowMs: NOW });
    expect(r.from.ok).toBe(false);
    expect(r.from.error).toMatch(/Not a valid relative time expression/);
  });

  it('empty/whitespace-only text is rejected as required, before either parser runs', () => {
    const empty = validateTimeRangeDraft({ fromText: '', toText: 'now', fromType: 'DateTime', toType: 'DateTime', nowMs: NOW });
    expect(empty.from).toEqual({ ok: false, display: null, instantMs: null, error: 'A value is required.', matchedRelative: false });
    const whitespace = validateTimeRangeDraft({ fromText: '   ', toText: 'now', fromType: 'DateTime', toType: 'DateTime', nowMs: NOW });
    expect(whitespace.from.ok).toBe(false);
    expect(whitespace.from.error).toBe('A value is required.');
  });

  it('from > to at resolved instants is rejected even when both bounds parse fine', () => {
    const r = validateTimeRangeDraft({ fromText: 'now', toText: '-1h', fromType: 'DateTime', toType: 'DateTime', nowMs: NOW });
    expect(r.from.ok).toBe(true);
    expect(r.to.ok).toBe(true);
    expect(r.rangeOk).toBe(false);
    expect(r.rangeError).toMatch(/must not be after/);
    expect(r.applyEnabled).toBe(false);
  });

  it('equal resolved instants are explicitly permitted', () => {
    const r = validateTimeRangeDraft({ fromText: 'now', toText: 'now', fromType: 'DateTime', toType: 'DateTime', nowMs: NOW });
    expect(r.from.instantMs).toBe(r.to.instantMs);
    expect(r.rangeOk).toBe(true);
    expect(r.rangeError).toBeNull();
    expect(r.applyEnabled).toBe(true);
  });

  it('accepts a ParsedParamType object directly for fromType/toType, not just a raw string', () => {
    const r = validateTimeRangeDraft({
      fromText: 'now', toText: 'now',
      fromType: { base: 'DateTime' } as never, toType: { base: 'DateTime' } as never,
      nowMs: NOW,
    });
    expect(r.applyEnabled).toBe(true);
  });
});

describe('pushRecentRange', () => {
  it('pushes onto an empty list', () => {
    expect(pushRecentRange([], { from: '-1d', to: 'now' })).toEqual([{ from: '-1d', to: 'now' }]);
  });
  it('unshifts newest-first ahead of existing entries', () => {
    const list: TimeRangeRecent[] = [{ from: '-7d', to: 'now' }];
    expect(pushRecentRange(list, { from: '-1d', to: 'now' })).toEqual([
      { from: '-1d', to: 'now' },
      { from: '-7d', to: 'now' },
    ]);
  });
  it('dedupes by EXACT token-pair equality — a repeat pair moves to the front rather than duplicating', () => {
    const list: TimeRangeRecent[] = [{ from: '-1d', to: 'now' }, { from: '-7d', to: 'now' }];
    expect(pushRecentRange(list, { from: '-1d', to: 'now' })).toEqual([
      { from: '-1d', to: 'now' },
      { from: '-7d', to: 'now' },
    ]);
  });
  it('a pair sharing one bound but not the other is NOT deduped (exact-pair equality only)', () => {
    const list: TimeRangeRecent[] = [{ from: '-1d', to: 'now' }];
    expect(pushRecentRange(list, { from: '-1d', to: '-1h' })).toEqual([
      { from: '-1d', to: '-1h' },
      { from: '-1d', to: 'now' },
    ]);
  });
  it('caps at 6 entries, dropping the oldest', () => {
    const list: TimeRangeRecent[] = Array.from({ length: 6 }, (_, i) => ({ from: `-${i}d`, to: 'now' }));
    const result = pushRecentRange(list, { from: '-100d', to: 'now' });
    expect(result).toHaveLength(6);
    expect(result[0]).toEqual({ from: '-100d', to: 'now' });
    expect(result).not.toContainEqual({ from: '-5d', to: 'now' }); // the oldest was dropped
  });
  it('is immutable — never mutates the input list', () => {
    const list: TimeRangeRecent[] = [{ from: '-1d', to: 'now' }];
    const snapshot = [...list];
    pushRecentRange(list, { from: '-7d', to: 'now' });
    expect(list).toEqual(snapshot);
  });
});
