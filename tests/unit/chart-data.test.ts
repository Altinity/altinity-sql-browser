import { describe, it, expect } from 'vitest';
import {
  chartStripType, chartRole, autoChart, schemaKey, CHART_TYPES, chartFieldOptions,
  chartNumFmt, chartLabel, chartPalette, chartColors, buildChartData, chartJsConfig,
  cloneChartCfg, chartCfgValid, normalizeChartCfg, chartRowCap,
  normalizeChartStyle, chartStylePresets, chartStylePreset,
  applyChartStylePreset, shouldShowChartPoints, formatChartValue, visibleChartMeasures,
  CHART_STYLE_PRESETS, chartDataNote,
} from '../../src/core/chart-data.js';
import type { ChartConfig, ChartFamilyType, ChartMeasure, ChartStyle, ChartDataMeta } from '../../src/core/chart-data.js';
import type { Column } from '../../src/core/panel-cfg.js';

// A chart cfg literal, typed loosely enough for this suite's fixtures (many
// omit `y`/`style`, or use a non-family `type` string to exercise fallback
// behavior) — cast at each call site, same convention as `Column` below.
type ChartConfigFixture = { type: string; x: number; y?: number[]; series?: number | null; style?: unknown };
const cc = (cfg: ChartConfigFixture): ChartConfig => cfg as ChartConfig;

describe('chartStripType', () => {
  it('strips Nullable/LowCardinality, including nested', () => {
    expect(chartStripType('String')).toBe('String');
    expect(chartStripType('Nullable(UInt64)')).toBe('UInt64');
    expect(chartStripType('LowCardinality(Nullable(String))')).toBe('String');
  });
  it('coerces nullish to empty string', () => {
    expect(chartStripType(null)).toBe('');
    expect(chartStripType(undefined)).toBe('');
  });
});

describe('chartRole', () => {
  it('classifies temporal, measure, ordinal and category', () => {
    expect(chartRole({ name: 'ts', type: 'DateTime' })).toBe('time');
    expect(chartRole({ name: 'd', type: 'Date' })).toBe('time');
    expect(chartRole({ name: 'flights', type: 'UInt64' })).toBe('measure');
    expect(chartRole({ name: 'Year', type: 'UInt16' })).toBe('ordinal');
    expect(chartRole({ name: 'months', type: 'UInt16' })).toBe('ordinal'); // plural bucket
    expect(chartRole({ name: 'carrier', type: 'LowCardinality(String)' })).toBe('category');
  });
  it('treats a numeric column with no name as a measure, and a missing col as category', () => {
    expect(chartRole({ type: 'Float64' } as Column)).toBe('measure');
    expect(chartRole(undefined)).toBe('category');
  });
  it('does not misclassify a measure merely prefixed with a bucket word', () => {
    // anchored regex: a real measure named like a bucket stays a measure
    expect(chartRole({ name: 'monthly_revenue', type: 'Float64' })).toBe('measure');
    expect(chartRole({ name: 'minutes_watched', type: 'UInt64' })).toBe('measure');
    expect(chartRole({ name: 'dayrate', type: 'Float64' })).toBe('measure');
  });
});

describe('autoChart', () => {
  it('returns null when there is no measure (or no columns)', () => {
    expect(autoChart(null)).toBeNull();
    expect(autoChart([])).toBeNull();
    expect(autoChart([{ name: 'a', type: 'String' }, { name: 'b', type: 'String' }])).toBeNull();
  });
  it('temporal X → line', () => {
    expect(autoChart([{ name: 'd', type: 'Date' }, { name: 'n', type: 'UInt64' }]))
      .toEqual({ type: 'line', x: 0, y: [1], series: null });
  });
  it('categorical X → horizontal bar', () => {
    expect(autoChart([{ name: 'c', type: 'String' }, { name: 'n', type: 'UInt64' }]))
      .toEqual({ type: 'hbar', x: 0, y: [1], series: null });
  });
  it('ordinal X → vertical column', () => {
    expect(autoChart([{ name: 'month', type: 'UInt8' }, { name: 'n', type: 'UInt64' }]))
      .toEqual({ type: 'bar', x: 0, y: [1], series: null });
  });
  it('all-measure result falls back to col 0 as X (bar)', () => {
    expect(autoChart([{ name: 'a', type: 'UInt64' }, { name: 'b', type: 'Float64' }]))
      .toEqual({ type: 'bar', x: 0, y: [0], series: null });
  });
  it('charts a sole numeric measure even when its name is prefixed with a bucket word', () => {
    // regression: `monthly_total` must not be misread as an ordinal axis → null
    expect(autoChart([{ name: 'carrier', type: 'String' }, { name: 'monthly_total', type: 'Float64' }]))
      .toEqual({ type: 'hbar', x: 0, y: [1], series: null });
  });
});

describe('schemaKey', () => {
  it('signs the schema and is empty for none', () => {
    expect(schemaKey(null)).toBe('');
    expect(schemaKey([{ name: 'a', type: 'String' }, { name: 'b', type: 'UInt8' }]))
      .toBe('a:String|b:UInt8');
  });
});

describe('chartFieldOptions', () => {
  const cols = [
    { name: 'carrier', type: 'String' },
    { name: 'region', type: 'LowCardinality(String)' },
    { name: 'flights', type: 'UInt64' },
    { name: 'delay', type: 'Float64' },
  ];
  it('builds X/Y/Series options and visibility flags (non-pie, single Y)', () => {
    const f = chartFieldOptions(cols, { type: 'hbar', x: 0, y: [2], series: null });
    expect(f.typeOptions).toBe(CHART_TYPES);
    expect(f.xOptions.map((o) => o.label)).toEqual(['carrier', 'region', 'flights', 'delay']);
    expect(f.yOptions.map((o) => o.label)).toEqual(['flights', 'delay']);
    // series = category-ish columns except the current X (carrier), plus None
    expect(f.seriesOptions.map((o) => o.label)).toEqual(['None', 'region']);
    expect(f.showSeries).toBe(true);
    expect(f.showMulti).toBe(true);
    expect(f.multiActive).toBe(false);
    expect(f.allMeasures).toEqual([2, 3]);
  });
  it('hides multi-toggle when a group-by series is set; reports multiActive for multi-Y', () => {
    const f = chartFieldOptions(cols, { type: 'bar', x: 0, y: [2, 3], series: 1 });
    expect(f.showMulti).toBe(false); // series set
    expect(f.multiActive).toBe(true);
  });
  it('hides series + multi for pie', () => {
    const f = chartFieldOptions(cols, { type: 'pie', x: 0, y: [2], series: null });
    expect(f.showSeries).toBe(false);
    expect(f.showMulti).toBe(false);
  });
  it('handles a config with no y array (defaults multiActive false)', () => {
    const f = chartFieldOptions(cols, { type: 'hbar', x: 0, series: null });
    expect(f.multiActive).toBe(false);
  });
  it('"All measures" excludes ordinal buckets and the current X column', () => {
    const c = [{ name: 'year', type: 'UInt16' }, { name: 'requests', type: 'UInt64' }, { name: 'users', type: 'UInt64' }];
    // year is an ordinal X; it stays pickable as Y but is not an "All measures" target.
    const onYear = chartFieldOptions(c, { type: 'bar', x: 0, y: [1], series: null });
    expect(onYear.yOptions.map((o) => o.label)).toEqual(['year', 'requests', 'users']);
    expect(onYear.allMeasures).toEqual([1, 2]);
    // when X is itself a measure, it's excluded from allMeasures (and the toggle hides at <2 left).
    const onMeasure = chartFieldOptions(c, { type: 'bar', x: 1, y: [2], series: null });
    expect(onMeasure.allMeasures).toEqual([2]);
    expect(onMeasure.showMulti).toBe(false);
  });
});

describe('chartNumFmt', () => {
  it('humanizes numbers and passes through non-finite/non-numbers', () => {
    expect(chartNumFmt(2_500_000)).toBe('2.5M');
    expect(chartNumFmt(1500)).toBe('1.5K');
    expect(chartNumFmt(42)).toBe('42');
    expect(chartNumFmt(3.14159)).toBe('3.14');
    expect(chartNumFmt(-1_000_000)).toBe('-1.0M');
    expect(chartNumFmt(NaN)).toBe('NaN');
    expect(chartNumFmt('x')).toBe('x');
  });
});

describe('chartLabel', () => {
  it('keeps date-only for a Date or midnight DateTime', () => {
    expect(chartLabel('2026-06-21')).toBe('2026-06-21');
    expect(chartLabel('2026-06-21 00:00:00')).toBe('2026-06-21'); // day-level aggregation
  });
  it('keeps date + HH:MM for an intraday timestamp (so same-day buckets stay distinct)', () => {
    expect(chartLabel('2026-06-21 12:30:45')).toBe('2026-06-21 12:30');
    expect(chartLabel('2026-06-21T09:05:00')).toBe('2026-06-21 09:05'); // ISO 'T' separator
  });
  it('stringifies non-date values', () => {
    expect(chartLabel('B6')).toBe('B6');
    expect(chartLabel(7)).toBe('7');
  });
});

describe('normalizeChartCfg', () => {
  it('null → null', () => {
    expect(normalizeChartCfg(null)).toBeNull();
  });
  it('clears a series that equals the X column', () => {
    expect(normalizeChartCfg({ type: 'bar', x: 2, y: [1], series: 2 }))
      .toEqual({ type: 'bar', x: 2, y: [1], series: null });
  });
  it('leaves a distinct series untouched', () => {
    expect(normalizeChartCfg({ type: 'bar', x: 0, y: [1], series: 2 }))
      .toEqual({ type: 'bar', x: 0, y: [1], series: 2 });
  });
  it('forces pie to a single measure and no series', () => {
    expect(normalizeChartCfg({ type: 'pie', x: 0, y: [1, 2], series: 3 }))
      .toEqual({ type: 'pie', x: 0, y: [1], series: null });
  });
  it('tolerates a pie with a missing/short y array', () => {
    expect(normalizeChartCfg({ type: 'pie', x: 0, y: [1], series: null }))
      .toEqual({ type: 'pie', x: 0, y: [1], series: null });
    expect(normalizeChartCfg({ type: 'pie', x: 0, series: 2 }))
      .toEqual({ type: 'pie', x: 0, series: null });
  });
});

describe('chartPalette', () => {
  it('anchors on the accent', () => {
    const p = chartPalette('#FF6B35');
    expect(p[0]).toBe('#FF6B35');
    expect(p.length).toBeGreaterThan(3);
  });
});

describe('chartColors', () => {
  it('falls back to dark-theme defaults when the reader is missing or blank', () => {
    const c = chartColors(null);
    expect(c.accent).toBe('#0079AD');
    expect(c.border).toBe('#1F1F26');
    expect(c.palette[0]).toBe('#0079AD');
  });
  it('uses resolved values when present, trimming whitespace', () => {
    const c = chartColors((name) => (name === '--accent' ? '  #fff  ' : ''));
    expect(c.accent).toBe('#fff');
    expect(c.fg).toBe('#E6E6E8'); // blank → fallback
  });
  it('resolves a real --mono font stack (canvas can\'t use var(--mono))', () => {
    expect(chartColors(null).mono).toContain('monospace'); // fallback stack
    expect(chartColors((name) => (name === '--mono' ? 'Courier' : '')).mono).toBe('Courier');
  });
});

describe('chartRowCap', () => {
  it('returns the per-type cap, falling back to the bar/column default for unknown types', () => {
    expect(chartRowCap('pie')).toBe(30);
    expect(chartRowCap('hbar')).toBe(500);
    expect(chartRowCap('bar')).toBe(1000);
    expect(chartRowCap('line')).toBe(5000);
    expect(chartRowCap('area')).toBe(5000);
    expect(chartRowCap('bogus')).toBe(500);
    expect(chartRowCap(undefined)).toBe(500);
  });
});

describe('chart style', () => {
  it('normalizes missing/non-object style to complete type-specific defaults', () => {
    for (const value of [undefined, null, [], 'nope', {}]) {
      expect(normalizeChartStyle(value, 'line')).toEqual({
        curve: 'linear', points: 'auto', scale: 'data', legend: 'auto', grid: 'auto', axes: 'show',
      });
      expect(normalizeChartStyle(value, 'area')).toEqual({
        curve: 'linear', points: 'auto', stack: 'overlay', scale: 'data', legend: 'auto', grid: 'auto', axes: 'show',
      });
      expect(normalizeChartStyle(value, 'bar')).toEqual({
        mode: 'grouped', density: 'normal', scale: 'zero', legend: 'auto', grid: 'auto', axes: 'show',
      });
      expect(normalizeChartStyle(value, 'pie')).toEqual({ shape: 'pie', legend: 'show', frame: 'normal' });
    }
  });
  it.each([
    ['line', 'curve', ['linear', 'smooth', 'stepped']],
    ['line', 'points', ['auto', 'show', 'hide']],
    ['area', 'stack', ['overlay', 'stacked']],
    ['bar', 'mode', ['grouped', 'stacked']],
    ['hbar', 'density', ['normal', 'compact', 'joined']],
    ['pie', 'shape', ['pie', 'donut']],
  ])('accepts every supported %s %s value', (type, field, values) => {
    for (const value of values) expect(normalizeChartStyle({ [field]: value }, type)[field]).toBe(value);
  });
  it.each([
    ['scale', ['auto', 'zero', 'data']],
    ['legend', ['auto', 'show', 'hide']],
    ['grid', ['auto', 'show', 'hide']],
    ['axes', ['show', 'hide']],
  ])('accepts every supported presentation %s value', (field, values) => {
    for (const value of values) expect(normalizeChartStyle({ [field]: value }, 'line')[field]).toBe(value);
  });
  it('falls back to the line surface for an unknown/missing chart type', () => {
    const lineDefaults = { curve: 'linear', points: 'auto', scale: 'data', legend: 'auto', grid: 'auto', axes: 'show' };
    expect(normalizeChartStyle({}, 'mystery')).toEqual(lineDefaults);
    expect(normalizeChartStyle({})).toEqual(lineDefaults); // default type argument
  });
  it('accepts Pie frame values and independently defaults invalid fields without mutation', () => {
    expect(normalizeChartStyle({ frame: 'compact' }, 'pie').frame).toBe('compact');
    const style = {
      curve: 'banana', points: 'hide', stack: 'future', scale: 'near', legend: 'show', grid: false, axes: 'gone', future: true,
    };
    expect(normalizeChartStyle(style, 'area')).toEqual({
      curve: 'linear', points: 'hide', stack: 'overlay', scale: 'data', legend: 'show', grid: 'auto', axes: 'show',
    });
    expect(normalizeChartStyle({ legend: false, frame: 'wide' }, 'pie')).toEqual({ shape: 'pie', legend: 'show', frame: 'normal' });
    expect(style).toEqual({
      curve: 'banana', points: 'hide', stack: 'future', scale: 'near', legend: 'show', grid: false, axes: 'gone', future: true,
    });
  });
  it('matches every exact type-specific preset and defaults omitted values', () => {
    for (const type of ['hbar', 'bar', 'line', 'area', 'pie']) {
      for (const preset of chartStylePresets(type)) {
        expect(chartStylePreset(preset.style, type)).toBe(preset.value);
      }
    }
    expect(chartStylePreset(undefined, 'area')).toBe('clean');
    expect(chartStylePreset({ future: true }, 'line')).toBe('clean');
    expect(chartStylePresets('future')).toEqual([]);
  });
  it('returns Custom for unmatched or unsupported relevant values while ignoring dormant fields', () => {
    expect(chartStylePreset({ mode: 'stacked', density: 'joined' }, 'bar')).toBe('custom');
    expect(chartStylePreset({
      curve: 'smooth', points: 'hide', stack: 'stacked', scale: 'data', legend: 'show', grid: 'hide', axes: 'show',
    }, 'area')).toBe('custom');
    expect(chartStylePreset({ shape: 'donut', legend: 'hide', frame: 'normal' }, 'pie')).toBe('custom');
    expect(chartStylePreset({ curve: 'future', mode: 'stacked' }, 'line')).toBe('custom');
    expect(chartStylePreset({ curve: 'linear', mode: 'future' }, 'line')).toBe('clean');
    expect(chartStylePreset({ scale: 'future' }, 'line')).toBe('custom');
  });
  it('applies presets in one object while preserving unknown/dormant fields and source', () => {
    const style = { curve: 'banana', mode: 'stacked', frame: 'compact', future: { keep: true } };
    const applied = applyChartStylePreset(style, 'sparkline', 'area');
    expect(applied).toEqual({
      curve: 'linear', points: 'hide', stack: 'overlay', scale: 'data', legend: 'hide', grid: 'hide', axes: 'hide',
      mode: 'stacked', frame: 'compact', future: { keep: true },
    });
    expect(style).toEqual({ curve: 'banana', mode: 'stacked', frame: 'compact', future: { keep: true } });
    expect(applyChartStylePreset(null, 'missing', 'pie')).toEqual({ shape: 'pie', legend: 'show', frame: 'normal' });
    expect(applyChartStylePreset({ future: 1 }, 'x', 'future')).toEqual({ future: 1 });
  });
  it('shows automatic markers only at or below both final-data thresholds', () => {
    expect(shouldShowChartPoints(Array(60), Array(4))).toBe(true);
    expect(shouldShowChartPoints(Array(61), Array(4))).toBe(false);
    expect(shouldShowChartPoints(Array(60), Array(5))).toBe(false);
    expect(shouldShowChartPoints()).toBe(true);
  });
});

describe('buildChartData', () => {
  const cols = [
    { name: 'carrier', type: 'String' },
    { name: 'flights', type: 'UInt64' },
    { name: 'delay', type: 'Float64' },
    { name: 'region', type: 'String' },
  ];
  it('single series per measure, preserving nullish/garbage values as gaps', () => {
    const rows = [['B6', '10', '5.5', 'E'], ['AA', null, 'x', 'W'], ['DL', '', '2', 'W']];
    const out = buildChartData(cols, rows, { type: 'hbar', x: 0, y: [1, 2], series: null });
    expect(out.labels).toEqual(['B6', 'AA', 'DL']);
    expect(out.datasets).toEqual([
      { label: 'flights', data: [10, null, null] },
      { label: 'delay', data: [5.5, null, 2] },
    ]);
  });
  it('group-by pivots into one aligned dataset per series value, missing → null', () => {
    const rows = [
      ['B6', '10', '1', 'E'],
      ['AA', '20', '1', 'W'],
      ['B6', '30', '1', 'W'], // second region for B6
    ];
    const out = buildChartData(cols, rows, { type: 'bar', x: 0, y: [1], series: 3 });
    expect(out.labels).toEqual(['B6', 'AA']); // first-seen X order, deduped
    expect(out.datasets).toEqual([
      { label: 'E', data: [10, null] }, // E has only B6
      { label: 'W', data: [30, 20] }, // W has B6(30) and AA(20)
    ]);
  });
  it('reuses a caller-supplied measures array verbatim (threaded from chartJsConfig)', () => {
    // A pre-resolved measures array selects `delay` (index 2) with a custom
    // label; buildChartData must plot it directly rather than re-resolving from
    // cfg.y/fieldConfig — the single-resolution path chartJsConfig relies on.
    const rows = [['B6', '10', '5.5', 'E']];
    const measures = [{ index: 2, presentation: { displayName: 'Avg delay' }, authoredValueFormat: false }] as ChartMeasure[];
    const out = buildChartData(cols, rows, { type: 'bar', x: 0, y: [1], series: null }, {}, measures);
    expect(out.datasets).toEqual([{ label: 'Avg delay', data: [5.5] }]);
  });
  it('caps at the row cap for the config type', () => {
    const bigCols = [{ name: 'c', type: 'String' }, { name: 'n', type: 'UInt64' }];
    const big = Array.from({ length: 600 }, (_, i) => ['c' + i, String(i)]);
    const hbar = buildChartData(bigCols, big, { type: 'hbar', x: 0, y: [1], series: null });
    expect(hbar.labels).toHaveLength(500); // hbar cap
    const pie = buildChartData(bigCols, big, { type: 'pie', x: 0, y: [1], series: null });
    expect(pie.labels).toHaveLength(30); // pie's much tighter legibility cap
    const line = buildChartData(bigCols, big, { type: 'line', x: 0, y: [1], series: null });
    expect(line.labels).toHaveLength(600); // line cap (5000) exceeds the row count — no truncation
  });
  it('aggregates (sums) rows sharing an X bucket — single-series path', () => {
    // two rows for the same carrier are summed, not last-write-wins
    const rows = [['B6', '10', '1', 'E'], ['B6', '30', '4', 'W'], ['AA', '20', '2', 'W']];
    const out = buildChartData(cols, rows, { type: 'bar', x: 0, y: [1, 2], series: null });
    expect(out.labels).toEqual(['B6', 'AA']); // deduped
    expect(out.datasets).toEqual([
      { label: 'flights', data: [40, 20] }, // B6: 10+30
      { label: 'delay', data: [5, 2] },     // B6: 1+4
    ]);
  });
  it('aggregates (sums) rows sharing an (X, series) cell — group-by path', () => {
    const rows = [['B6', '10', '1', 'W'], ['B6', '30', '1', 'W']]; // same carrier+region
    const out = buildChartData(cols, rows, { type: 'bar', x: 0, y: [1], series: 3 });
    expect(out.labels).toEqual(['B6']);
    expect(out.datasets).toEqual([{ label: 'W', data: [40] }]); // 10+30, not last-wins(30)
  });
  it('groups on the raw X value so two times on the same day stay distinct', () => {
    const c = [{ name: 'ts', type: 'DateTime' }, { name: 'n', type: 'UInt64' }];
    const rows = [['2026-06-15 09:00:00', '1'], ['2026-06-15 17:00:00', '2']];
    const out = buildChartData(c, rows, { type: 'line', x: 0, y: [1], series: null });
    expect(out.labels).toEqual(['2026-06-15 09:00', '2026-06-15 17:00']); // distinct intraday ticks
    expect(out.datasets[0].data).toEqual([1, 2]); // and the two points survive (no merge)
  });
  it('applies display names and hidden state without mutating cfg.y or fieldConfig', () => {
    const cfg = cc({ type: 'line', x: 0, y: [1, 2], series: null });
    const fieldConfig = { defaults: { unit: '%' }, columns: {
      flights: { displayName: 'Flights' }, delay: { hidden: true },
    } };
    const out = buildChartData(cols, [['B6', 10, 2, 'E']], cfg, fieldConfig);
    expect(out.datasets).toEqual([{ label: 'Flights', data: [10] }]);
    expect(visibleChartMeasures(cols, cfg, fieldConfig).map((item) => item.index)).toEqual([1]);
    expect(cfg.y).toEqual([1, 2]);
    expect(fieldConfig.columns.delay.hidden).toBe(true);
  });
  it('keeps Series values as dataset labels while using the selected measure visibility', () => {
    const cfg = cc({ type: 'line', x: 0, y: [1], series: 3 });
    const fields = { columns: { flights: { displayName: 'Flight count' } } };
    expect(buildChartData(cols, [['B6', 10, 2, 'East']], cfg, fields).datasets[0].label).toBe('East');
    // A hidden measure leaves the series path with no plottable Y — labels and
    // datasets are empty, but the metadata still reflects the discovered category.
    const emptyMeta: ChartDataMeta = {
      totalRows: 1, totalCategories: 1, shownCategories: 1,
      categoriesTruncated: false, duplicateCellsSummed: false, groupKey: 'x+series',
    };
    expect(buildChartData(cols, [['B6', 10, 2, 'East']], cfg, { columns: { flights: { hidden: true } } }))
      .toEqual({ labels: [], datasets: [], meta: emptyMeta });
    expect(buildChartData(cols, [['B6', 10, 2, 'East']], cc({
      type: 'line', x: 0, y: [1, 2], series: 3,
    }), { columns: { flights: { hidden: true } } })).toEqual({ labels: [], datasets: [], meta: emptyMeta });
  });

  // --- #111: the cap limits X categories (not raw rows), and typed metadata ---
  const capCols = [{ name: 'k', type: 'String' }, { name: 'v', type: 'UInt64' }];
  it('a row after the old raw-row boundary still contributes to its displayed category', () => {
    // Pie's cap is 30. Fill 30 distinct categories with one row each, then place
    // a SECOND row for the first category ('k0') far past the 30-row boundary.
    const rows: unknown[][] = Array.from({ length: 30 }, (_, i) => ['k' + i, '1']);
    for (let i = 0; i < 40; i++) rows.push(['filler' + i, '1']); // never displayed (cap already hit)
    rows.push(['k0', '100']); // late row for an early, displayed category
    const out = buildChartData(capCols, rows, { type: 'pie', x: 0, y: [1], series: null });
    expect(out.labels[0]).toBe('k0');
    expect(out.datasets[0].data[0]).toBe(101); // 1 + 100, not truncated away
    expect(out.meta.totalCategories).toBe(70); // 30 real + 40 filler
    expect(out.meta.shownCategories).toBe(30);
  });
  it('retains the first `cap` X categories in first-seen order', () => {
    const rows: unknown[][] = Array.from({ length: 35 }, (_, i) => ['k' + i, '1']);
    const out = buildChartData(capCols, rows, { type: 'pie', x: 0, y: [1], series: null });
    expect(out.labels).toEqual(Array.from({ length: 30 }, (_, i) => 'k' + i)); // first-seen, first 30
  });
  it('omits post-cap categories from labels and datasets', () => {
    const rows: unknown[][] = Array.from({ length: 32 }, (_, i) => ['k' + i, '1']);
    const out = buildChartData(capCols, rows, { type: 'pie', x: 0, y: [1], series: null });
    expect(out.labels).not.toContain('k30');
    expect(out.labels).not.toContain('k31');
    expect(out.datasets[0].data).toHaveLength(30);
  });
  it('metadata: truncation only (unique cells, more categories than the cap)', () => {
    const rows: unknown[][] = Array.from({ length: 35 }, (_, i) => ['k' + i, '1']);
    const { meta } = buildChartData(capCols, rows, { type: 'pie', x: 0, y: [1], series: null });
    expect(meta).toEqual({
      totalRows: 35, totalCategories: 35, shownCategories: 30,
      categoriesTruncated: true, duplicateCellsSummed: false, groupKey: 'x',
    });
  });
  it('metadata: duplicate only (a repeated displayed X, category count at/below the cap)', () => {
    const rows: unknown[][] = [['a', '1'], ['b', '2'], ['a', '3']];
    const { meta } = buildChartData(capCols, rows, { type: 'pie', x: 0, y: [1], series: null });
    expect(meta.categoriesTruncated).toBe(false);
    expect(meta.duplicateCellsSummed).toBe(true);
    expect(meta.totalCategories).toBe(2);
  });
  it('metadata: both truncation and a duplicate displayed cell', () => {
    const rows: unknown[][] = Array.from({ length: 35 }, (_, i) => ['k' + i, '1']);
    rows.push(['k0', '9']); // duplicate of a displayed category
    const { meta } = buildChartData(capCols, rows, { type: 'pie', x: 0, y: [1], series: null });
    expect(meta.categoriesTruncated).toBe(true);
    expect(meta.duplicateCellsSummed).toBe(true);
  });
  it('unique multi-series cells (repeated X, distinct Series) are not summing', () => {
    const rows = [
      ['Jan', 'EU', '1'], ['Jan', 'US', '2'],
      ['Feb', 'EU', '3'], ['Feb', 'US', '4'],
    ];
    const c = [{ name: 'month', type: 'String' }, { name: 'region', type: 'String' }, { name: 'rev', type: 'UInt64' }];
    const { meta } = buildChartData(c, rows, { type: 'bar', x: 0, y: [2], series: 1 });
    expect(meta.groupKey).toBe('x+series');
    expect(meta.duplicateCellsSummed).toBe(false);
  });
  it('a repeated (X, Series) cell is summed and flagged', () => {
    const rows = [['Jan', 'EU', '1'], ['Jan', 'EU', '5']]; // same (month, region)
    const c = [{ name: 'month', type: 'String' }, { name: 'region', type: 'String' }, { name: 'rev', type: 'UInt64' }];
    const out = buildChartData(c, rows, { type: 'bar', x: 0, y: [2], series: 1 });
    expect(out.datasets).toEqual([{ label: 'EU', data: [6] }]); // 1 + 5
    expect(out.meta.duplicateCellsSummed).toBe(true);
  });
  it('a duplicate confined to an omitted category does not flag the visible chart', () => {
    // 30 unique displayed categories, then a duplicated pair in a 31st (omitted) one.
    const rows: unknown[][] = Array.from({ length: 30 }, (_, i) => ['k' + i, '1']);
    rows.push(['zz', '1'], ['zz', '2']); // 'zz' is category #31 → omitted by pie's cap
    const { meta } = buildChartData(capCols, rows, { type: 'pie', x: 0, y: [1], series: null });
    expect(meta.categoriesTruncated).toBe(true);
    expect(meta.duplicateCellsSummed).toBe(false); // the duplicate is never displayed
  });
  it('a Series present only in omitted categories produces no all-null dataset', () => {
    // 'US' appears only in the omitted category 'z'; it must not become a dataset.
    const rows: unknown[][] = [];
    for (let i = 0; i < 30; i++) rows.push(['k' + i, 'EU', '1']);
    rows.push(['z', 'US', '9']); // category #31 → omitted
    const c = [{ name: 'k', type: 'String' }, { name: 'region', type: 'String' }, { name: 'v', type: 'UInt64' }];
    const out = buildChartData(c, rows, { type: 'pie', x: 0, y: [2], series: 1 });
    expect(out.datasets.map((d) => d.label)).toEqual(['EU']); // no 'US' dataset
    expect(out.datasets.every((d) => d.data.some((v) => v != null))).toBe(true);
  });
});

describe('chartDataNote', () => {
  const base: ChartDataMeta = {
    totalRows: 10, totalCategories: 5, shownCategories: 5,
    categoriesTruncated: false, duplicateCellsSummed: false, groupKey: 'x',
  };
  it('returns null when neither condition holds', () => {
    expect(chartDataNote(base)).toBeNull();
  });
  it('truncation only → "first N of M categories"', () => {
    expect(chartDataNote({ ...base, shownCategories: 30, totalCategories: 600, categoriesTruncated: true }))
      .toBe('first 30 of 600 categories');
  });
  it('duplicate X only → browser-summed X note', () => {
    expect(chartDataNote({ ...base, duplicateCellsSummed: true }))
      .toBe('duplicate X rows summed in the browser');
  });
  it('duplicate X/series only → browser-summed X/series note', () => {
    expect(chartDataNote({ ...base, groupKey: 'x+series', duplicateCellsSummed: true }))
      .toBe('duplicate X/series rows summed in the browser');
  });
  it('both conditions → two clauses joined with "; "', () => {
    expect(chartDataNote({
      ...base, shownCategories: 30, totalCategories: 600, categoriesTruncated: true, duplicateCellsSummed: true,
    })).toBe('first 30 of 600 categories; duplicate X rows summed in the browser');
  });
  it('both conditions with Series → the X/series clause', () => {
    expect(chartDataNote({
      ...base, groupKey: 'x+series', shownCategories: 30, totalCategories: 600,
      categoriesTruncated: true, duplicateCellsSummed: true,
    })).toBe('first 30 of 600 categories; duplicate X/series rows summed in the browser');
  });
});

describe('formatChartValue', () => {
  it('uses exact decimals and authored units, with a safe non-finite fallback', () => {
    const presentation = { decimals: 1, unit: '%', noValue: 'n/a' };
    expect(formatChartValue(68.234, presentation)).toBe('68.2%');
    expect(formatChartValue(0, presentation)).toBe('0.0%');
    expect(formatChartValue(null, presentation)).toBe('n/a');
    expect(formatChartValue(Infinity, presentation)).toBe('n/a');
    expect(formatChartValue('nope', presentation)).toBe('n/a');
    expect(formatChartValue(-0, presentation)).toBe('0.0%');
    expect(formatChartValue(1048576, { decimals: 0, unit: ' B' })).toBe('1048576 B');
    expect(formatChartValue(1.25, { decimals: 99, unit: 'x' })).toBe('1.25x');
  });
});

describe('chartJsConfig', () => {
  const cols = [{ name: 'carrier', type: 'String' }, { name: 'flights', type: 'UInt64' }, { name: 'delay', type: 'Float64' }];
  const rows = [['B6', '2026-01-01', '5'], ['AA', '20', '6']];
  const colors = chartColors(null);

  it('horizontal bar maps to type bar with indexAxis y and flipped scales', () => {
    const cfg = chartJsConfig(cols, rows, { type: 'hbar', x: 0, y: [1], series: null }, colors);
    expect(cfg.type).toBe('bar');
    expect(cfg.options.indexAxis).toBe('y');
    expect(cfg.options.scales!.x.beginAtZero).toBe(true); // value axis on x
    expect(cfg.options.scales!.y.grid.display).toBe(false); // category axis
    expect(cfg.data.datasets[0].backgroundColor).toBe(colors.palette[0]);
  });
  it('uses a precomputed opts.data verbatim instead of re-aggregating (#111 single-pass)', () => {
    // A sentinel data result unrelated to `rows`: chartJsConfig must draw it as-is,
    // proving the renderer's one aggregation is reused, not recomputed here.
    const data = {
      labels: ['only'], datasets: [{ label: 'precomputed', data: [42] }],
      meta: {
        totalRows: 2, totalCategories: 1, shownCategories: 1,
        categoriesTruncated: false, duplicateCellsSummed: false, groupKey: 'x' as const,
      },
    };
    const cfg = chartJsConfig(cols, rows, { type: 'bar', x: 0, y: [1], series: null }, colors, { data });
    expect(cfg.data.labels).toEqual(['only']);
    expect(cfg.data.datasets[0].label).toBe('precomputed');
    expect(cfg.data.datasets[0].data).toEqual([42]);
  });
  it('shows value-axis gridlines by default, hides them with opts.hideGrid (#149)', () => {
    const shown = chartJsConfig(cols, rows, { type: 'bar', x: 0, y: [1], series: null }, colors);
    expect(shown.options.scales!.y.grid.display).toBe(true);
    const hidden = chartJsConfig(cols, rows, { type: 'bar', x: 0, y: [1], series: null }, colors, { hideGrid: true });
    expect(hidden.options.scales!.y.grid.display).toBe(false);
    // the horizontal-bar value axis (x) is hidden too, not just the category axis
    const hbar = chartJsConfig(cols, rows, { type: 'hbar', x: 0, y: [1], series: null }, colors, { hideGrid: true });
    expect(hbar.options.scales!.x.grid.display).toBe(false);
  });
  it('vertical column keeps indexAxis x', () => {
    const cfg = chartJsConfig(cols, rows, { type: 'bar', x: 0, y: [1], series: null }, colors);
    expect(cfg.type).toBe('bar');
    expect(cfg.options.indexAxis).toBe('x');
    expect(cfg.options.scales!.y.beginAtZero).toBe(true);
  });
  it('value-axis ticks humanize via callback (number and coercible string)', () => {
    const cfg = chartJsConfig(cols, rows, { type: 'bar', x: 0, y: [1], series: null }, colors);
    const cb = cfg.options.scales!.y.ticks.callback!;
    expect(cb(2_000_000)).toBe('2.0M');
    expect(cb('1500')).toBe('1.5K');
  });
  it('retains Chart.js legacy tooltip value formatting when fieldConfig has no value format', () => {
    const cfg = chartJsConfig(cols, rows, { type: 'bar', x: 0, y: [1], series: null }, colors);
    expect(cfg.options.plugins.tooltip.callbacks.label({
      datasetIndex: 0, dataset: cfg.data.datasets[0], raw: 1500, formattedValue: '1,500',
    })).toBe('flights: 1,500');
  });
  it('does not change valid tooltip formatting when only noValue is authored', () => {
    const cfg = chartJsConfig(cols, rows, { type: 'bar', x: 0, y: [1], series: null }, colors, {
      fieldConfig: { columns: { flights: { noValue: 'n/a' } } },
    });
    expect(cfg.options.plugins.tooltip.callbacks.label({
      datasetIndex: 0, dataset: cfg.data.datasets[0], raw: 1500, formattedValue: '1,500',
    })).toBe('flights: 1,500');
  });
  it('reuses opts.measures instead of re-resolving field metadata', () => {
    // chart-render resolves visibleChartMeasures once for its empty-state guard
    // and threads it in; chartJsConfig must honor that array (label proves it is
    // used, not recomputed from fieldConfig).
    const measures = [{
      index: 1, authoredValueFormat: false,
      presentation: { displayName: 'Flights!', unit: '', decimals: null, description: null, hidden: false },
    }] as ChartMeasure[];
    const out = chartJsConfig(cols, rows, { type: 'bar', x: 0, y: [1], series: null }, colors, { measures });
    expect(out.data.datasets[0].label).toBe('Flights!');
  });
  it('line is not filled; area fills with an alpha-blended hex', () => {
    const line = chartJsConfig(cols, rows, { type: 'line', x: 0, y: [1], series: null }, colors);
    expect(line.type).toBe('line');
    expect(line.data.datasets[0].fill).toBe(false);
    const area = chartJsConfig(cols, rows, { type: 'area', x: 0, y: [1], series: null }, colors);
    expect(area.data.datasets[0].fill).toBe(true);
    expect(area.data.datasets[0].backgroundColor).toMatch(/^rgba\(/);
  });
  it('maps linear/smooth/stepped curves and visible/hidden interactive points', () => {
    const linear = chartJsConfig(cols, rows, {
      type: 'line', x: 0, y: [1], series: null, style: { curve: 'linear', points: 'show' },
    }, colors).data.datasets[0];
    expect(linear).toMatchObject({
      tension: 0, stepped: false, cubicInterpolationMode: 'default',
      pointRadius: 2, pointHoverRadius: 4, pointHitRadius: 8, borderWidth: 1.5, fill: false,
    });
    const smooth = chartJsConfig(cols, rows, {
      type: 'area', x: 0, y: [1], series: null, style: { curve: 'smooth', points: 'hide' },
    }, colors).data.datasets[0];
    expect(smooth).toMatchObject({
      tension: 0, stepped: false, cubicInterpolationMode: 'monotone',
      pointRadius: 0, pointHoverRadius: 3, pointHitRadius: 8, fill: true,
    });
    const stepped = chartJsConfig(cols, rows, {
      type: 'line', x: 0, y: [1], series: null, style: { curve: 'stepped', points: 'show' },
    }, colors).data.datasets[0];
    expect(stepped).toMatchObject({ tension: 0, stepped: 'after', pointRadius: 2 });
  });
  it('maps grouped/stacked Bar and Column plus compact/joined density exactly', () => {
    const config = (type: ChartFamilyType, style: ChartStyle) => chartJsConfig(cols, rows, {
      type, x: 0, y: [1, 2], series: null, style,
    }, colors);
    const grouped = config('hbar', { mode: 'grouped', density: 'normal', scale: 'zero' });
    expect(grouped.options.indexAxis).toBe('y');
    expect(grouped.options.scales!).toMatchObject({ x: { stacked: false }, y: { stacked: false } });
    expect(grouped.data.datasets[0]).not.toHaveProperty('categoryPercentage');
    const stacked = config('bar', { mode: 'stacked', density: 'normal', scale: 'zero' });
    expect(stacked.options.indexAxis).toBe('x');
    expect(stacked.options.scales!).toMatchObject({ x: { stacked: true }, y: { stacked: true } });
    const compact = config('bar', { density: 'compact', scale: 'zero' }).data.datasets[0];
    expect(compact).toMatchObject({ categoryPercentage: 0.9, barPercentage: 0.95, borderRadius: 2 });
    const joined = config('bar', { density: 'joined', scale: 'zero' }).data.datasets[0];
    expect(joined).toMatchObject({ categoryPercentage: 1, barPercentage: 1, borderRadius: 0 });
  });
  it('maps additive stacked Area without changing dataset values', () => {
    const cfg = chartJsConfig(cols, rows, {
      type: 'area', x: 0, y: [1, 2], series: null,
      style: { curve: 'smooth', points: 'hide', stack: 'stacked', scale: 'data' },
    }, colors);
    expect(cfg.data.datasets.map((dataset) => dataset.stack)).toEqual(['chart', 'chart']);
    expect(cfg.options.scales!).toMatchObject({ x: { stacked: false }, y: { stacked: true, beginAtZero: false } });
    expect(cfg.data.datasets.map((dataset) => dataset.data)).toEqual([[null, 20], [5, 6]]);
    const overlay = chartJsConfig(cols, rows, {
      type: 'area', x: 0, y: [1], series: null, style: { stack: 'overlay' },
    }, colors);
    expect(overlay.data.datasets[0]).not.toHaveProperty('stack');
    expect(overlay.options.scales!.y.stacked).toBe(false);
  });
  it('maps Line/Area scale, legend, grid, and axes independently', () => {
    const config = (style: ChartStyle, opts?: { hideGrid?: boolean }) => chartJsConfig(cols, rows, {
      type: 'line', x: 0, y: [1, 2], series: null, style,
    }, colors, opts);

    expect(config({ scale: 'zero' }).options.scales!.y.beginAtZero).toBe(true);
    expect(config({ scale: 'data' }).options.scales!.y.beginAtZero).toBe(false);
    expect(config({ scale: 'auto' }).options.scales!.y.beginAtZero).toBe(false);
    expect(config({ legend: 'show' }).options.plugins.legend.display).toBe(true);
    expect(config({ legend: 'hide' }).options.plugins.legend.display).toBe(false);
    expect(config({ legend: 'auto' }).options.plugins.legend.display).toBe(true);
    expect(chartJsConfig(cols, rows, {
      type: 'area', x: 0, y: [1], series: null, style: { legend: 'auto' },
    }, colors).options.plugins.legend.display).toBe(false);
    expect(config({ grid: 'show' }, { hideGrid: true }).options.scales!.y.grid.display).toBe(true);
    expect(config({ grid: 'hide' }).options.scales!.y.grid.display).toBe(false);
    expect(config({ grid: 'auto' }).options.scales!.y.grid.display).toBe(true);
    expect(config({ grid: 'auto' }, { hideGrid: true }).options.scales!.y.grid.display).toBe(false);
    expect(config({ axes: 'hide' }).options.scales!).toMatchObject({ x: { display: false }, y: { display: false } });
    expect(config({ axes: 'show' }).options.scales!).toMatchObject({ x: { display: true }, y: { display: true } });
  });
  it.each([
    ['line', false],
    ['area', false],
    ['hbar', true],
    ['bar', true],
  ] as [ChartFamilyType, boolean][])('resolves explicit auto scale for %s to its chart-family default', (type, expected) => {
    const config = chartJsConfig(cols, rows, {
      type, x: 0, y: [1], series: null, style: { scale: 'auto' },
    }, colors);
    const valueAxis = type === 'hbar' ? config.options.scales!.x : config.options.scales!.y;
    expect(valueAxis.beginAtZero).toBe(expected);
  });
  it('keeps Sparkline interaction and data while hiding presentation chrome', () => {
    const preset = CHART_STYLE_PRESETS.line.find((item) => item.value === 'sparkline')!;
    const cfg = chartJsConfig(cols, rows, {
      type: 'line', x: 0, y: [1], series: null, style: preset.style,
    }, colors, { hideGrid: false });
    expect(cfg.data.labels).toHaveLength(2);
    expect(cfg.data.datasets[0]).toMatchObject({
      pointRadius: 0, pointHoverRadius: 3, pointHitRadius: 8,
    });
    expect(cfg.options.plugins.legend.display).toBe(false);
    expect(cfg.options.plugins.tooltip).toBeDefined();
    expect(cfg.options.responsive).toBe(true);
    expect(cfg.options.scales!).toMatchObject({
      x: { display: false, grid: { display: false } },
      y: { display: false, grid: { display: false } },
    });
  });
  it('uses final aggregated/pivoted chart density for automatic points', () => {
    const manyRawRows = Array.from({ length: 100 }, (_, i) => ['same', String(i), '1']);
    const aggregated = chartJsConfig(cols, manyRawRows, {
      type: 'line', x: 0, y: [1], series: null,
    }, colors);
    expect(aggregated.data.labels).toHaveLength(1);
    expect(aggregated.data.datasets[0].pointRadius).toBe(2); // raw rows do not decide density

    const seriesCols = [{ name: 'x', type: 'String' }, { name: 'y', type: 'UInt64' }, { name: 's', type: 'String' }];
    const pivoted = chartJsConfig(seriesCols, ['a', 'b', 'c', 'd', 'e'].map((s) => ['x', 1, s]), {
      type: 'line', x: 0, y: [1], series: 2,
    }, colors);
    expect(pivoted.data.datasets).toHaveLength(5);
    expect(pivoted.data.datasets.every((dataset) => dataset.pointRadius === 0)).toBe(true);
  });
  it('changes automatic markers deterministically across the final label threshold', () => {
    const make = (count: number) => Array.from({ length: count }, (_, i) => ['x' + i, i, 0]);
    const cfg = cc({ type: 'line', x: 0, y: [1], series: null });
    expect(chartJsConfig(cols, make(60), cfg, colors).data.datasets[0].pointRadius).toBe(2);
    expect(chartJsConfig(cols, make(61), cfg, colors).data.datasets[0].pointRadius).toBe(0);
  });
  it('area leaves a non-hex accent color untouched (withAlpha passthrough)', () => {
    const c = { ...colors, palette: ['rgb(1,2,3)', '#22C55E'] };
    const area = chartJsConfig(cols, rows, { type: 'area', x: 0, y: [1], series: null }, c);
    expect(area.data.datasets[0].backgroundColor).toBe('rgb(1,2,3)');
  });
  it('maps Pie, Donut, and Compact Pie without scales or disabled tooltips', () => {
    const cfg = chartJsConfig(cols, rows, { type: 'pie', x: 0, y: [1], series: null }, colors);
    expect(cfg.type).toBe('pie');
    expect(cfg.options.cutout).toBe(0);
    expect(cfg.options.scales).toBeUndefined();
    expect(Array.isArray(cfg.data.datasets[0].backgroundColor)).toBe(true);
    expect(cfg.options.plugins.legend.display).toBe(true);
    expect(cfg.options.plugins.legend.position).toBe('right');
    const donut = chartJsConfig(cols, rows, {
      type: 'pie', x: 0, y: [1], series: null,
      style: { shape: 'donut', legend: 'show', frame: 'normal', scale: 'zero', axes: 'hide' },
    }, colors);
    expect(donut.options.cutout).toBe('60%');
    expect(donut.options.layout).toBeUndefined();
    const compact = chartJsConfig(cols, rows, {
      type: 'pie', x: 0, y: [1], series: null,
      style: { shape: 'donut', legend: 'hide', frame: 'compact' },
    }, colors);
    expect(compact.options).toMatchObject({ cutout: '60%', layout: { padding: 0, autoPadding: false } });
    expect(compact.options.plugins.legend.display).toBe(false);
    expect(compact.options.plugins.tooltip).toBeDefined();
  });
  it('multi-series shows a top legend', () => {
    const cfg = chartJsConfig(cols, rows, { type: 'bar', x: 0, y: [1, 2], series: null }, colors);
    expect(cfg.data.datasets).toHaveLength(2);
    expect(cfg.options.plugins.legend.display).toBe(true);
    expect(cfg.options.plugins.legend.position).toBe('top');
  });
  it('formats labels, field-specific tooltips, descriptions, and a compatible shared axis', () => {
    const fieldConfig = { defaults: { unit: '%', decimals: 1, noValue: 'n/a' }, columns: {
      flights: { displayName: 'Flights', description: 'Completed flights.' },
      delay: { displayName: 'Delay' },
    } };
    const cfg = chartJsConfig(cols, rows, { type: 'line', x: 0, y: [1, 2], series: null }, colors, { fieldConfig });
    expect(cfg.data.datasets.map((dataset) => dataset.label)).toEqual(['Flights', 'Delay']);
    expect(cfg.options.scales!.y.ticks.callback!(68.234)).toBe('68.2%');
    const callbacks = cfg.options.plugins.tooltip.callbacks;
    expect(callbacks.label({ datasetIndex: 0, dataset: cfg.data.datasets[0], raw: 68.234 })).toBe('Flights: 68.2%');
    expect(callbacks.label({ datasetIndex: 1, dataset: cfg.data.datasets[1], raw: 6.25 })).toBe('Delay: 6.3%');
    expect(callbacks.afterLabel({ datasetIndex: 0 })).toBe('Completed flights.');
    expect(callbacks.afterLabel({ datasetIndex: 1 })).toBe('');
  });
  it('keeps the generic axis for incompatible measures while tooltips stay field-specific', () => {
    const fieldConfig = { columns: {
      flights: { unit: ' B', decimals: 0 }, delay: { unit: '%', decimals: 1 },
    } };
    const cfg = chartJsConfig(cols, rows, { type: 'bar', x: 0, y: [1, 2], series: null }, colors, { fieldConfig });
    expect(cfg.options.scales!.y.ticks.callback!(1500)).toBe('1.5K');
    const cb = cfg.options.plugins.tooltip.callbacks.label;
    expect(cb({ datasetIndex: 0, dataset: cfg.data.datasets[0], raw: 1048576 })).toBe('flights: 1048576 B');
    expect(cb({ datasetIndex: 1, dataset: cfg.data.datasets[1], raw: 2.25 })).toBe('delay: 2.3%');
  });
  it('uses Series identity in labels and the measure metadata in tooltips', () => {
    const pivotCols = [...cols, { name: 'region', type: 'String' }];
    const cfg = chartJsConfig(pivotCols, [['B6', 10, 2, 'East']], {
      type: 'line', x: 0, y: [1], series: 3,
    }, colors, { fieldConfig: { columns: { flights: { displayName: 'Flight count', unit: ' trips', decimals: 0 } } } });
    expect(cfg.data.datasets[0].label).toBe('East');
    expect(cfg.options.plugins.tooltip.callbacks.label({ datasetIndex: 0, dataset: cfg.data.datasets[0], raw: 10 }))
      .toBe('East: 10 trips');
  });
  it('uses category identity for pie tooltip labels', () => {
    const cfg = chartJsConfig(cols, rows, { type: 'pie', x: 0, y: [1], series: null }, colors, {
      fieldConfig: { columns: { flights: { unit: ' trips', decimals: 0 } } },
    });
    expect(cfg.options.plugins.tooltip.callbacks.label({ datasetIndex: 0, dataset: cfg.data.datasets[0], label: 'B6', raw: 4 }))
      .toBe('B6: 4 trips');
  });
});

describe('cloneChartCfg', () => {
  it('copies known/unknown fields and deep-copies y + complete presentation objects', () => {
    const src = {
      type: 'bar', x: 0, y: [1, 2], series: 3,
      style: { mode: 'stacked', density: 'compact', scale: 'zero', legend: 'show', future: { x: 1 } },
      future: true,
    };
    const c = cloneChartCfg(cc(src))!;
    expect(c).toEqual(src);
    expect(c).not.toBe(src);
    expect(c.y).not.toBe(src.y);
    expect(c.style).not.toBe(src.style);
    expect((c.style as { future: unknown }).future).not.toBe(src.style.future);
  });
  it('null → null and defaults a missing y/series', () => {
    expect(cloneChartCfg(null)).toBeNull();
    expect(cloneChartCfg({ type: 'pie', x: 0 })).toEqual({ type: 'pie', x: 0, y: [], series: null });
  });
});

describe('chartCfgValid', () => {
  const cols = [{ name: 'a', type: 'String' }, { name: 'b', type: 'UInt64' }];
  it('accepts a well-formed config (series null or in range)', () => {
    expect(chartCfgValid({ type: 'bar', x: 0, y: [1], series: null }, cols)).toBe(true);
    expect(chartCfgValid({ type: 'pie', x: 0, y: [1], series: 0 }, cols)).toBe(true);
  });
  it('rejects non-objects, unknown types, and out-of-range indices', () => {
    expect(chartCfgValid(null, cols)).toBe(false);
    expect(chartCfgValid('x', cols)).toBe(false);
    expect(chartCfgValid({ type: 'donut', x: 0, y: [1], series: null }, cols)).toBe(false);
    expect(chartCfgValid({ type: 'bar', x: 9, y: [1], series: null }, cols)).toBe(false);
    expect(chartCfgValid({ type: 'bar', x: 0, y: [], series: null }, cols)).toBe(false);
    expect(chartCfgValid({ type: 'bar', x: 0, y: [9], series: null }, cols)).toBe(false);
    expect(chartCfgValid({ type: 'bar', x: 0, y: 'nope', series: null }, cols)).toBe(false);
    expect(chartCfgValid({ type: 'bar', x: 0, y: [1], series: 9 }, cols)).toBe(false);
  });
  it('treats missing columns as zero-length (nothing in range)', () => {
    expect(chartCfgValid({ type: 'bar', x: 0, y: [0], series: null })).toBe(false);
  });
});
