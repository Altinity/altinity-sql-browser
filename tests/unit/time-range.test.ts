import { describe, it, expect } from 'vitest';
import { analyzeParameterizedSources } from '../../src/core/param-pipeline.js';
import type { ParameterAnalysis } from '../../src/core/param-pipeline.js';
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
import type { TimeRangeRecent, TimeRangeVariable } from '../../src/core/time-range.js';

// Same fixture convention as tests/unit/filter-selection.test.ts: round-trip
// through the real `analyzeParameterizedSources` rather than a hand-crafted
// `ParameterAnalysis`.
const analysisFor = (sources: { id: string; sql: string }[]): ParameterAnalysis =>
  analyzeParameterizedSources(sources.map((s) => ({ id: s.id, kind: 'tab', sql: s.sql, bindPolicy: 'row-returning' })));

// #447: a time-range bound is an inferred VARIABLE — its exact name is its only
// identity, its type comes from the panel declarations that agree on it, and only
// a direct-input variable (no option SQL) is a candidate.
const variable = (name: string, type: string | null = 'DateTime', sql: string | null = null): TimeRangeVariable =>
  ({ name, type, sql });

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
    const result = resolveAuthoredTimeRangeGroups({
      variables: [variable('from'), variable('to')],
      analysis: analysisFor([
        { id: 'legacy', sql: 'SELECT {from:DateTime}, {to:DateTime}' },
        { id: 'opted-out', sql: 'SELECT {from:DateTime}, {to:DateTime}' },
      ]),
      executableTileIds: new Set(['legacy', 'opted-out']),
      variableTargetTileIds: new Map([
        ['from', new Set(['legacy', 'opted-out'])],
        ['to', new Set(['legacy', 'opted-out'])],
      ]),
      tiles: [{ id: 'legacy', queryId: 'legacy-query' }, { id: 'opted-out', queryId: 'opted-query' }],
      queries: [{ id: 'legacy-query', spec: {} }, { id: 'opted-query', spec: { timeRanges: [] } }],
    });
    expect(result.groups).toEqual([
      expect.objectContaining({ fromVariableId: 'from', toVariableId: 'to', tileIds: ['legacy'] }),
    ]);
    expect(result.diagnostics).toEqual([]);
  });

  it('fails closed when one legacy tile has more than one recognized pair', () => {
    const variables = [variable('from'), variable('to'), variable('start'), variable('end')];
    const ids = new Set(['tile']);
    const result = resolveAuthoredTimeRangeGroups({
      variables,
      analysis: analysisFor([{
        id: 'tile', sql: 'SELECT {from:DateTime}, {to:DateTime}, {start:DateTime}, {end:DateTime}',
      }]),
      executableTileIds: ids,
      variableTargetTileIds: new Map(variables.map((v) => [v.name, ids])),
      tiles: [{ id: 'tile', queryId: 'legacy-query' }],
      queries: [{ id: 'legacy-query', spec: {} }],
    });
    expect(result).toEqual({ groups: [], diagnostics: [] });
  });

  it('treats an own undefined timeRanges value as malformed authored metadata, never as legacy omission', () => {
    const result = resolveAuthoredTimeRangeGroups({
      variables: [variable('from'), variable('to')],
      analysis: analysisFor([{ id: 'tile', sql: 'SELECT {from:DateTime}, {to:DateTime}' }]),
      executableTileIds: new Set(['tile']),
      variableTargetTileIds: new Map([['from', new Set(['tile'])], ['to', new Set(['tile'])]]),
      tiles: [{ id: 'tile', queryId: 'query' }],
      queries: [{ id: 'query', spec: { timeRanges: undefined } }],
    });
    expect(result.groups).toEqual([]);
    expect(result.diagnostics).toEqual([expect.objectContaining({ code: 'time-range-contract-invalid' })]);
  });

  it('ignores malformed extension values before variable resolution', () => {
    const base = {
      variables: [] as TimeRangeVariable[], analysis: analysisFor([]), executableTileIds: new Set<string>(),
      variableTargetTileIds: new Map<string, ReadonlySet<string>>(),
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

  it('resolves authored metadata to one group carrying every tile that declares the pair', () => {
    const result = resolveAuthoredTimeRangeGroups({
      variables: [variable('from'), variable('to')],
      analysis: analysisFor([
        { id: 'chart', sql: 'SELECT * FROM t WHERE ts >= {from:DateTime} AND ts < {to:DateTime}' },
        { id: 'table', sql: 'SELECT * FROM u WHERE ts >= {from:DateTime} AND ts < {to:DateTime}' },
      ]),
      executableTileIds: new Set(['chart', 'table']),
      variableTargetTileIds: new Map([
        ['from', new Set(['chart', 'table'])],
        ['to', new Set(['chart', 'table'])],
      ]),
      tiles: [{ id: 'chart', queryId: 'q' }, { id: 'table', queryId: 'q' }],
      queries: [{ id: 'q', spec: { timeRanges: [{ from: 'from', to: 'to' }] } }],
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.groups).toEqual([
      expect.objectContaining({ fromVariableId: 'from', toVariableId: 'to', tileIds: ['chart', 'table'] }),
    ]);
  });

  it('diagnoses authored metadata naming a parameter no variable of this tile carries', () => {
    const result = resolveAuthoredTimeRangeGroups({
      variables: [variable('from'), variable('to')],
      analysis: analysisFor([{ id: 'tile', sql: 'SELECT * FROM t WHERE ts >= {from:DateTime} AND ts < {to:DateTime}' }]),
      executableTileIds: new Set(['tile']),
      variableTargetTileIds: new Map([['from', new Set(['tile'])], ['to', new Set(['tile'])]]),
      tiles: [{ id: 'tile', queryId: 'q' }],
      queries: [{ id: 'q', spec: { timeRanges: [{ from: 'from', to: 'nope' }] } }],
    });
    expect(result.groups).toEqual([]);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: 'time-range-variable-unresolved' }),
    ]);
  });

  it('diagnoses authored pairs whose declarations use unsupported date/time forms', () => {
    const result = resolveAuthoredTimeRangeGroups({
      variables: [variable('from', 'DateTime(3)'), variable('to')],
      analysis: analysisFor([{ id: 'tile', sql: 'SELECT {from:DateTime(3)}, {to:DateTime}' }]),
      executableTileIds: new Set(['tile']),
      variableTargetTileIds: new Map([['from', new Set(['tile'])], ['to', new Set(['tile'])]]),
      tiles: [{ id: 'tile', queryId: 'query' }],
      queries: [{ id: 'query', spec: { timeRanges: [{ from: 'from', to: 'to' }] } }],
    });
    expect(result.groups).toEqual([]);
    expect(result.diagnostics).toEqual([expect.objectContaining({ code: 'time-range-contract-invalid' })]);
  });
});

describe('inferTimeRangePairs', () => {
  it('recognizes from/to (case-insensitive)', () => {
    expect(inferTimeRangePairs([variable('From'), variable('TO')]))
      .toEqual([{ fromVariableId: 'From', toVariableId: 'TO' }]);
  });
  it('recognizes from_time/to_time, start/end, start_time/end_time', () => {
    expect(inferTimeRangePairs([variable('from_time'), variable('to_time')]))
      .toEqual([{ fromVariableId: 'from_time', toVariableId: 'to_time' }]);
    expect(inferTimeRangePairs([variable('start'), variable('end')]))
      .toEqual([{ fromVariableId: 'start', toVariableId: 'end' }]);
    expect(inferTimeRangePairs([variable('start_time'), variable('end_time')]))
      .toEqual([{ fromVariableId: 'start_time', toVariableId: 'end_time' }]);
  });
  it('never recognizes start/stop', () => {
    expect(inferTimeRangePairs([variable('start'), variable('stop')])).toEqual([]);
  });
  it('a variable carrying option SQL is never a candidate', () => {
    expect(inferTimeRangePairs([variable('from', 'DateTime', 'SELECT v, l'), variable('to')])).toEqual([]);
  });
  it('a variable with null option SQL is a direct input — still eligible', () => {
    expect(inferTimeRangePairs([variable('from', 'DateTime', null), variable('to')]))
      .toEqual([{ fromVariableId: 'from', toVariableId: 'to' }]);
  });
  it('two variables differing only in CASE both match one entry, so no pair forms', () => {
    // Variable names are exact and case-SENSITIVE, while this table matches
    // case-INSENSITIVELY. `From` and `from` are therefore two real, distinct
    // variables that both claim the same entry — neither can be preferred, so the
    // entry is dropped rather than guessed at.
    expect(inferTimeRangePairs([variable('From'), variable('from'), variable('to')])).toEqual([]);
  });
  it('multiple independent groups: rows are emitted in NAME_PAIR_TABLE order regardless of input array order', () => {
    expect(inferTimeRangePairs([variable('start'), variable('end'), variable('to'), variable('from')]))
      .toEqual([
        { fromVariableId: 'from', toVariableId: 'to' },
        { fromVariableId: 'start', toVariableId: 'end' },
      ]);
  });
  it('no variables at all → no pairs', () => {
    expect(inferTimeRangePairs([])).toEqual([]);
  });
});

describe('resolveTimeRangeGroups — contract gating', () => {
  it('both bounds date-like with an executable consumer → one group', () => {
    const variables = [variable('from'), variable('to')];
    const analysis = analysisFor([
      { id: 'a', sql: 'SELECT * FROM t WHERE ts >= {from:DateTime} AND ts < {to:DateTime}' },
    ]);
    const groups = resolveTimeRangeGroups({ variables, analysis, executableTileIds: new Set(['a']) });
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      key: 'from\u0000to',
      fromVariableId: 'from',
      toVariableId: 'to',
      fromParameter: 'from',
      toParameter: 'to',
    });
    expect(groups[0].fromType.base).toBe('DateTime');
    expect(groups[0].toType.base).toBe('DateTime');
  });

  it('a non-date-like declared type → no group', () => {
    const variables = [variable('from', 'String'), variable('to')];
    const analysis = analysisFor([{ id: 'a', sql: 'SELECT * FROM t WHERE x = {from:String} AND y = {to:DateTime}' }]);
    expect(resolveTimeRangeGroups({ variables, analysis, executableTileIds: new Set(['a']) })).toEqual([]);
  });

  it('a CONFLICTED bound (no agreed type) → no group, even though the other bound qualifies', () => {
    // Two panels declaring `from` with different types make it a conflicted
    // variable, whose agreed `type` is null. It can carry no contract, so the
    // pair must not form.
    const variables = [variable('from', null), variable('to')];
    const analysis = analysisFor([
      { id: 'a', sql: 'SELECT * FROM t WHERE ts = {from:DateTime} AND te = {to:DateTime}' },
      { id: 'b', sql: 'SELECT * FROM u WHERE ts = {from:String}' },
    ]);
    expect(resolveTimeRangeGroups({ variables, analysis, executableTileIds: new Set(['a', 'b']) })).toEqual([]);
  });

  it('a variable with option SQL never becomes a candidate pair, so no group forms', () => {
    const variables = [variable('from', 'DateTime', 'SELECT v, l'), variable('to')];
    const analysis = analysisFor([{ id: 'a', sql: 'SELECT * FROM t WHERE ts >= {from:DateTime} AND ts < {to:DateTime}' }]);
    expect(resolveTimeRangeGroups({ variables, analysis, executableTileIds: new Set(['a']) })).toEqual([]);
  });

  it('multiple independent groups resolve together, in pair-table order', () => {
    const variables = [
      variable('start', 'Date'), variable('end', 'Date'), variable('from'), variable('to'),
    ];
    const analysis = analysisFor([
      {
        id: 'a',
        sql: 'SELECT * FROM t WHERE s >= {start:Date} AND s < {end:Date} AND f >= {from:DateTime} AND f < {to:DateTime}',
      },
    ]);
    const groups = resolveTimeRangeGroups({ variables, analysis, executableTileIds: new Set(['a']) });
    expect(groups.map((g) => g.key)).toEqual(['from\u0000to', 'start\u0000end']);
  });

  it('key stability: recomputing over the same input yields an identical key', () => {
    const variables = [variable('from'), variable('to')];
    const analysis = analysisFor([{ id: 'a', sql: 'SELECT * FROM t WHERE ts >= {from:DateTime} AND ts < {to:DateTime}' }]);
    const g1 = resolveTimeRangeGroups({ variables, analysis, executableTileIds: new Set(['a']) });
    const g2 = resolveTimeRangeGroups({ variables, analysis, executableTileIds: new Set(['a']) });
    expect(g1[0].key).toBe(g2[0].key);
    expect(g1[0].key).toBe('from\u0000to');
  });

  it('an explicit `pairs` seam (#334 metadata resolution) is used verbatim instead of inference', () => {
    const variables = [variable('not_from_at_all'), variable('not_to_at_all')];
    const analysis = analysisFor([
      { id: 'a', sql: 'SELECT * FROM t WHERE ts >= {not_from_at_all:DateTime} AND ts < {not_to_at_all:DateTime}' },
    ]);
    const groups = resolveTimeRangeGroups({
      variables,
      analysis,
      executableTileIds: new Set(['a']),
      pairs: [{ fromVariableId: 'not_from_at_all', toVariableId: 'not_to_at_all' }],
    });
    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe('not_from_at_all\u0000not_to_at_all');
  });

  it('a pair naming a variable absent from `variables` is skipped rather than throwing', () => {
    const variables = [variable('from'), variable('to')];
    const analysis = analysisFor([{ id: 'a', sql: 'SELECT * FROM t WHERE ts >= {from:DateTime} AND ts < {to:DateTime}' }]);
    const groups = resolveTimeRangeGroups({
      variables,
      analysis,
      executableTileIds: new Set(['a']),
      pairs: [
        { fromVariableId: 'missing-from', toVariableId: 'to' },
        { fromVariableId: 'from', toVariableId: 'missing-to' },
      ],
    });
    expect(groups).toEqual([]);
  });

  it('an empty variables/pairs list resolves to no groups', () => {
    expect(resolveTimeRangeGroups({ variables: [], analysis: analysisFor([]), executableTileIds: new Set() }))
      .toEqual([]);
  });

  it('skips an explicit pair whose variables no executable tile declares', () => {
    expect(resolveTimeRangeGroups({
      variables: [variable('from'), variable('to')],
      analysis: analysisFor([]),
      executableTileIds: new Set(),
      pairs: [{ fromVariableId: 'from', toVariableId: 'to' }],
    })).toEqual([]);
  });

  it('skips a pair declared ONLY by a non-executable tile', () => {
    const variables = [variable('from'), variable('to')];
    const analysis = analysisFor([
      { id: 'text-tile', sql: 'SELECT * FROM t WHERE ts >= {from:DateTime} AND ts < {to:DateTime}' },
    ]);
    expect(resolveTimeRangeGroups({ variables, analysis, executableTileIds: new Set(['other']) })).toEqual([]);
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
