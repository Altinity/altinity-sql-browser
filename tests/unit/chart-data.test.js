import { describe, it, expect } from 'vitest';
import {
  chartStripType, chartRole, autoChart, schemaKey, CHART_TYPES, chartFieldOptions,
  chartNumFmt, chartLabel, chartPalette, chartColors, buildChartData, chartJsConfig,
  cloneChartCfg, chartCfgValid, normalizeChartCfg, unzoomChartEvent, chartRowCap,
} from '../../src/core/chart-data.js';

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
    expect(chartRole({ type: 'Float64' })).toBe('measure');
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

describe('buildChartData', () => {
  const cols = [
    { name: 'carrier', type: 'String' },
    { name: 'flights', type: 'UInt64' },
    { name: 'delay', type: 'Float64' },
    { name: 'region', type: 'String' },
  ];
  it('single series per measure, coercing nullish/garbage to 0', () => {
    const rows = [['B6', '10', '5.5', 'E'], ['AA', null, 'x', 'W'], ['DL', '', '2', 'W']];
    const out = buildChartData(cols, rows, { type: 'hbar', x: 0, y: [1, 2], series: null });
    expect(out.labels).toEqual(['B6', 'AA', 'DL']);
    expect(out.datasets).toEqual([
      { label: 'flights', data: [10, 0, 0] },
      { label: 'delay', data: [5.5, 0, 2] },
    ]);
  });
  it('group-by pivots into one aligned dataset per series value, missing → 0', () => {
    const rows = [
      ['B6', '10', '1', 'E'],
      ['AA', '20', '1', 'W'],
      ['B6', '30', '1', 'W'], // second region for B6
    ];
    const out = buildChartData(cols, rows, { type: 'bar', x: 0, y: [1], series: 3 });
    expect(out.labels).toEqual(['B6', 'AA']); // first-seen X order, deduped
    expect(out.datasets).toEqual([
      { label: 'E', data: [10, 0] }, // E has only B6
      { label: 'W', data: [30, 20] }, // W has B6(30) and AA(20)
    ]);
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
});

describe('chartJsConfig', () => {
  const cols = [{ name: 'carrier', type: 'String' }, { name: 'flights', type: 'UInt64' }, { name: 'delay', type: 'Float64' }];
  const rows = [['B6', '2026-01-01', '5'], ['AA', '20', '6']];
  const colors = chartColors(null);

  it('horizontal bar maps to type bar with indexAxis y and flipped scales', () => {
    const cfg = chartJsConfig(cols, rows, { type: 'hbar', x: 0, y: [1], series: null }, colors);
    expect(cfg.type).toBe('bar');
    expect(cfg.options.indexAxis).toBe('y');
    expect(cfg.options.scales.x.beginAtZero).toBe(true); // value axis on x
    expect(cfg.options.scales.y.grid.display).toBe(false); // category axis
    expect(cfg.data.datasets[0].backgroundColor).toBe(colors.palette[0]);
  });
  it('shows value-axis gridlines by default, hides them with opts.hideGrid (#149)', () => {
    const shown = chartJsConfig(cols, rows, { type: 'bar', x: 0, y: [1], series: null }, colors);
    expect(shown.options.scales.y.grid.display).toBe(true);
    const hidden = chartJsConfig(cols, rows, { type: 'bar', x: 0, y: [1], series: null }, colors, { hideGrid: true });
    expect(hidden.options.scales.y.grid.display).toBe(false);
    // the horizontal-bar value axis (x) is hidden too, not just the category axis
    const hbar = chartJsConfig(cols, rows, { type: 'hbar', x: 0, y: [1], series: null }, colors, { hideGrid: true });
    expect(hbar.options.scales.x.grid.display).toBe(false);
  });
  it('vertical column keeps indexAxis x', () => {
    const cfg = chartJsConfig(cols, rows, { type: 'bar', x: 0, y: [1], series: null }, colors);
    expect(cfg.type).toBe('bar');
    expect(cfg.options.indexAxis).toBe('x');
    expect(cfg.options.scales.y.beginAtZero).toBe(true);
  });
  it('value-axis ticks humanize via callback (number and coercible string)', () => {
    const cfg = chartJsConfig(cols, rows, { type: 'bar', x: 0, y: [1], series: null }, colors);
    const cb = cfg.options.scales.y.ticks.callback;
    expect(cb(2_000_000)).toBe('2.0M');
    expect(cb('1500')).toBe('1.5K');
  });
  it('line is not filled; area fills with an alpha-blended hex', () => {
    const line = chartJsConfig(cols, rows, { type: 'line', x: 0, y: [1], series: null }, colors);
    expect(line.type).toBe('line');
    expect(line.data.datasets[0].fill).toBe(false);
    const area = chartJsConfig(cols, rows, { type: 'area', x: 0, y: [1], series: null }, colors);
    expect(area.data.datasets[0].fill).toBe(true);
    expect(area.data.datasets[0].backgroundColor).toMatch(/^rgba\(/);
  });
  it('area leaves a non-hex accent color untouched (withAlpha passthrough)', () => {
    const c = { ...colors, palette: ['rgb(1,2,3)', '#22C55E'] };
    const area = chartJsConfig(cols, rows, { type: 'area', x: 0, y: [1], series: null }, c);
    expect(area.data.datasets[0].backgroundColor).toBe('rgb(1,2,3)');
  });
  it('pie has no scales, per-slice colors, and a right-positioned legend', () => {
    const cfg = chartJsConfig(cols, rows, { type: 'pie', x: 0, y: [1], series: null }, colors);
    expect(cfg.type).toBe('pie');
    expect(cfg.options.scales).toBeUndefined();
    expect(Array.isArray(cfg.data.datasets[0].backgroundColor)).toBe(true);
    expect(cfg.options.plugins.legend.display).toBe(true);
    expect(cfg.options.plugins.legend.position).toBe('right');
  });
  it('multi-series shows a top legend', () => {
    const cfg = chartJsConfig(cols, rows, { type: 'bar', x: 0, y: [1, 2], series: null }, colors);
    expect(cfg.data.datasets).toHaveLength(2);
    expect(cfg.options.plugins.legend.display).toBe(true);
    expect(cfg.options.plugins.legend.position).toBe('top');
  });
});

describe('cloneChartCfg', () => {
  it('deep-copies cfg so y is not shared with the source', () => {
    const src = { type: 'bar', x: 0, y: [1, 2], series: 3 };
    const c = cloneChartCfg(src);
    expect(c).toEqual(src);
    expect(c).not.toBe(src);
    expect(c.y).not.toBe(src.y);
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

describe('unzoomChartEvent', () => {
  it('divides zoomed pointer coords back to chart space under CSS zoom', () => {
    const e = { x: 120, y: 60, offsetX: 120, offsetY: 60 };
    expect(unzoomChartEvent(e, 1.2)).toBe(e); // mutates and returns the same object
    expect(e.x).toBeCloseTo(100);
    expect(e.y).toBeCloseTo(50);
    expect(e.offsetX).toBeCloseTo(100); // offsetX/Y kept in sync with x/y
    expect(e.offsetY).toBeCloseTo(50);
  });
  it('is a no-op at scale 1 (unzoomed) or a missing/zero scale', () => {
    const e = { x: 120, y: 60 };
    expect(unzoomChartEvent(e, 1).x).toBe(120);
    expect(unzoomChartEvent(e, 0).x).toBe(120); // 0 → falsy → untouched
    expect(unzoomChartEvent(e, undefined).x).toBe(120);
  });
  it('ignores events without numeric coordinates (resize/attach, null)', () => {
    expect(unzoomChartEvent(null, 1.2)).toBeNull();
    const e = { type: 'resize' };
    expect(unzoomChartEvent(e, 1.2)).toBe(e);
    expect(e.x).toBeUndefined();
    const partial = { x: 10 }; // y missing → not a pointer position
    expect(unzoomChartEvent(partial, 1.2).x).toBe(10);
  });
});
