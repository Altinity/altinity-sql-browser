import { describe, it, expect, vi } from 'vitest';
import { renderChart, installChartZoomFix } from '../../src/ui/chart-render.js';
import { makeApp } from '../helpers/fake-app.js';
import { newResult } from '../../src/core/stream.js';
import { autoChart, chartCfgValid, schemaKey, chartRowCap } from '../../src/core/chart-data.js';

const click = (el) => el.dispatchEvent(new Event('click', { bubbles: true }));

function appWithResult(result, over = {}) {
  const app = makeApp();
  app.activeTab().result = result;
  // Signal-aware assign: resultView/running are signals — write through .value;
  // plain fields are set directly.
  for (const [k, v] of Object.entries(over)) {
    const cur = app.state[k];
    if (cur && typeof cur === 'object' && 'value' in cur) cur.value = v;
    else app.state[k] = v;
  }
  return app;
}

function tableResult() {
  const r = newResult('Table');
  r.columns = [{ name: 'n', type: 'UInt64' }, { name: 's', type: 'String' }];
  r.rows = [['2', 'b'], ['1', null]];
  r.progress = { rows: 2, bytes: 100, elapsed_ns: 5e6 };
  return r;
}

// A result with two measures + two category columns, for multi-series/group-by.
function chartResult() {
  const r = newResult('Table');
  r.columns = [
    { name: 'carrier', type: 'String' },
    { name: 'region', type: 'String' },
    { name: 'flights', type: 'UInt64' },
    { name: 'delay', type: 'Float64' },
  ];
  r.rows = [['B6', 'E', '10', '5.5'], ['AA', 'W', '20', '6.5']];
  r.progress = { rows: 2, bytes: 100, elapsed_ns: 5e6 };
  return r;
}
const fieldSel = (el, label) => [...el.querySelectorAll('.chart-field')]
  .find((f) => f.querySelector('.chart-field-label').textContent === label).querySelector('select');
const change = (sel, value) => { sel.value = value; sel.dispatchEvent(new Event('change', { bubbles: true })); };

// A minimal holder-mode paint loop standing in for the old results-pane chart
// view: destroy-before-rebuild via app.chart (the default setChart slot) and
// a rerender that repaints this same region — renderChart's own contract.
function paintChart(app) {
  const region = app.dom.resultsRegion;
  const paint = () => {
    if (app.chart) { app.chart.destroy(); app.chart = null; }
    const tab = app.activeTab();
    const key = schemaKey(tab.result.columns);
    if (tab.panelKey !== key || !chartCfgValid(tab.panelCfg, tab.result.columns)) {
      tab.panelCfg = autoChart(tab.result.columns);
      tab.panelKey = key;
    }
    region.replaceChildren(renderChart(app, tab.result, {
      cfg: tab.panelCfg,
      rerender: paint,
      onCfgChange: (cfg) => { tab.panelCfg = cfg; paint(); },
    }));
  };
  paint();
}

describe('renderChart', () => {
  it('shows a not-chartable hint when no measure exists', () => {
    const r = newResult('Table');
    r.columns = [{ name: 'a', type: 'String' }];
    r.rows = [['x']];
    const app = appWithResult(r, { resultView: 'chart' });
    expect(renderChart(app, r).textContent).toContain('aren’t chartable');
  });
  it('renders a caller-resolved cfg independently of run state (the panel caller owns the run gate)', () => {
    const app = appWithResult(tableResult(), { resultView: 'chart', running: true });
    const cfg = autoChart(app.activeTab().result.columns);
    expect(renderChart(app, app.activeTab().result, { cfg, controls: false }).querySelector('canvas')).not.toBeNull();
  });
  it('builds a config bar and instantiates Chart.js on a canvas (categorical → hbar default)', () => {
    const app = appWithResult(tableResult(), { resultView: 'chart' });
    paintChart(app);
    const view = app.dom.resultsRegion.querySelector('.chart-view');
    expect(view.querySelector('canvas')).not.toBeNull();
    expect(app.chart).not.toBeNull();
    expect(app.chart.config.type).toBe('bar'); // hbar maps to bar + indexAxis y
    expect(app.chart.config.options.indexAxis).toBe('y');
    expect(app.activeTab().panelCfg).toMatchObject({ type: 'hbar', x: 1, y: [0] });
  });
  it('keeps a restored chart config when its schema key matches the result (saved/shared restore)', () => {
    const r = chartResult();
    const app = appWithResult(r, { resultView: 'chart' });
    const tab = app.activeTab();
    tab.panelKey = schemaKey(r.columns);
    tab.panelCfg = { type: 'pie', x: 0, y: [2], series: null }; // a deliberate non-default
    paintChart(app);
    expect(app.activeTab().panelCfg).toEqual({ type: 'pie', x: 0, y: [2], series: null }); // not re-derived
    expect(app.chart.config.type).toBe('pie');
  });
  it('falls back to autoChart when a restored config does not fit the schema (hand-edited link)', () => {
    const r = chartResult();
    const app = appWithResult(r, { resultView: 'chart' });
    const tab = app.activeTab();
    tab.panelKey = schemaKey(r.columns);
    tab.panelCfg = { type: 'bar', x: 99, y: [1], series: null }; // x out of range
    paintChart(app);
    expect(app.activeTab().panelCfg.x).toBeLessThan(r.columns.length); // guard re-derived a safe default
    expect(app.chart).not.toBeNull();
  });
  it('Type select switches renderer; non-pie keeps series, pie resets it to single-measure', () => {
    const app = appWithResult(chartResult(), { resultView: 'chart' });
    paintChart(app);
    // group-by first so we can prove pie clears it
    change(fieldSel(app.dom.resultsRegion, 'Series'), '1');
    expect(app.activeTab().panelCfg.series).toBe(1);
    change(fieldSel(app.dom.resultsRegion, 'Type'), 'line'); // non-pie branch
    expect(app.activeTab().panelCfg.type).toBe('line');
    change(fieldSel(app.dom.resultsRegion, 'Type'), 'pie'); // pie branch resets series
    expect(app.activeTab().panelCfg).toMatchObject({ type: 'pie', series: null });
    expect(fieldSel(app.dom.resultsRegion, 'Type')).not.toBeNull();
    expect([...app.dom.resultsRegion.querySelectorAll('.chart-field-label')].map((s) => s.textContent))
      .not.toContain('Series'); // series control hidden for pie
  });
  it('X and Y selects update the per-tab config', () => {
    const app = appWithResult(chartResult(), { resultView: 'chart' });
    paintChart(app);
    change(fieldSel(app.dom.resultsRegion, 'X'), '1');
    expect(app.activeTab().panelCfg.x).toBe(1);
    change(fieldSel(app.dom.resultsRegion, 'Y'), '3');
    expect(app.activeTab().panelCfg.y).toEqual([3]);
  });
  it('uses the direct rerender seam when no onCfgChange owner is supplied', () => {
    const app = appWithResult(chartResult());
    const rerender = vi.fn();
    const cfg = autoChart(app.activeTab().result.columns);
    const el = renderChart(app, app.activeTab().result, { cfg, rerender });
    change(fieldSel(el, 'X'), '1');
    expect(cfg.x).toBe(1);
    expect(rerender).toHaveBeenCalledTimes(1);
  });
  it('"All measures" toggles between single and multi-series', () => {
    const app = appWithResult(chartResult(), { resultView: 'chart' });
    paintChart(app);
    const btn = () => [...app.dom.resultsRegion.querySelectorAll('.chart-toggle')][0];
    expect(btn().textContent).toBe('All measures');
    click(btn());
    expect(app.activeTab().panelCfg.y).toEqual([2, 3]);
    expect(app.chart.config.data.datasets).toHaveLength(2);
    expect(btn().textContent).toBe('Single series');
    click(btn());
    expect(app.activeTab().panelCfg.y).toEqual([2]);
  });
  it('Series select sets and clears a group-by dimension', () => {
    const app = appWithResult(chartResult(), { resultView: 'chart' });
    paintChart(app);
    change(fieldSel(app.dom.resultsRegion, 'Series'), '1');
    expect(app.activeTab().panelCfg.series).toBe(1);
    change(fieldSel(app.dom.resultsRegion, 'Series'), '');
    expect(app.activeTab().panelCfg.series).toBeNull();
  });
  it('notes the row cap when the result is larger than the chart shows', () => {
    const r = newResult('Table');
    r.columns = [{ name: 'k', type: 'String' }, { name: 'v', type: 'UInt64' }];
    r.rows = Array.from({ length: 600 }, (_, i) => ['k' + i, String(i)]);
    r.progress = { rows: 600, bytes: 100, elapsed_ns: 5e6 };
    const app = appWithResult(r, { resultView: 'chart' });
    paintChart(app);
    const note = app.dom.resultsRegion.querySelector('.chart-cap-note');
    expect(note).not.toBeNull();
    expect(note.textContent).toContain('first 500 of');
    // a small result shows no cap note
    const small = appWithResult(tableResult(), { resultView: 'chart' });
    paintChart(small);
    expect(small.dom.resultsRegion.querySelector('.chart-cap-note')).toBeNull();
  });
  it('switching chart type re-slices to the new type\'s cap and updates the note', () => {
    const r = newResult('Table');
    r.columns = [{ name: 'k', type: 'String' }, { name: 'v', type: 'UInt64' }];
    r.rows = Array.from({ length: 600 }, (_, i) => ['k' + i, String(i)]);
    r.progress = { rows: 600, bytes: 100, elapsed_ns: 5e6 };
    const app = appWithResult(r, { resultView: 'chart' });
    paintChart(app);
    // default (hbar, autoChart's categorical pick) cap is 500 < 600 rows
    expect(app.activeTab().panelCfg.type).toBe('hbar');
    expect(app.dom.resultsRegion.querySelector('.chart-cap-note').textContent)
      .toBe('first ' + chartRowCap('hbar') + ' of 600 rows');
    expect(app.chart.config.data.labels).toHaveLength(chartRowCap('hbar'));
    // switch to pie: a much tighter legibility cap — re-slices and the note shrinks with it
    change(fieldSel(app.dom.resultsRegion, 'Type'), 'pie');
    expect(app.dom.resultsRegion.querySelector('.chart-cap-note').textContent).toContain('first ' + chartRowCap('pie') + ' of');
    expect(app.chart.config.data.labels).toHaveLength(chartRowCap('pie'));
    // switch to line: its cap (5000) exceeds the row count — no truncation, no note at all
    change(fieldSel(app.dom.resultsRegion, 'Type'), 'line');
    expect(app.dom.resultsRegion.querySelector('.chart-cap-note')).toBeNull();
    expect(app.chart.config.data.labels).toHaveLength(600);
  });
  it('destroys the previous Chart instance on re-render, and re-derives config on a new schema', () => {
    const app = appWithResult(chartResult(), { resultView: 'chart' });
    paintChart(app);
    const first = app.chart;
    const cfg = app.activeTab().panelCfg;
    paintChart(app); // stable schema → keep config, swap chart instance
    expect(first.destroyed).toBe(true);
    expect(app.chart).not.toBe(first);
    expect(app.activeTab().panelCfg).toBe(cfg);
    app.activeTab().result = tableResult(); // different schema → re-derive
    paintChart(app);
    expect(app.activeTab().panelCfg).not.toBe(cfg);
  });
  it('does not mutate a caller-owned restored config while rendering', () => {
    const app = appWithResult(chartResult(), { resultView: 'chart', running: true });
    const restored = { type: 'pie', x: 0, y: [2], series: null };
    renderChart(app, app.activeTab().result, { cfg: restored, controls: false });
    expect(restored).toEqual({ type: 'pie', x: 0, y: [2], series: null });
  });
  it('normalizes a restored, self-contradictory pie config (multi-measure + series) on render', () => {
    const r = chartResult();
    const app = appWithResult(r, { resultView: 'chart' });
    const tab = app.activeTab();
    tab.panelKey = schemaKey(r.columns); // in-range but invalid combination
    tab.panelCfg = { type: 'pie', x: 0, y: [2, 3], series: 1 };
    paintChart(app);
    expect(app.activeTab().panelCfg).toEqual({ type: 'pie', x: 0, y: [2], series: null });
    expect(app.chart.config.data.datasets).toHaveLength(1); // single pie dataset
  });
  it('clears the series when the X column is changed to equal it', () => {
    const app = appWithResult(chartResult(), { resultView: 'chart' });
    paintChart(app);
    change(fieldSel(app.dom.resultsRegion, 'Series'), '1'); // series = region(1)
    expect(app.activeTab().panelCfg.series).toBe(1);
    change(fieldSel(app.dom.resultsRegion, 'X'), '1'); // X now equals series → series cleared
    expect(app.activeTab().panelCfg.x).toBe(1);
    expect(app.activeTab().panelCfg.series).toBeNull();
  });
  it("forces an explicit resize + 'resize'-mode update once attached, working around Chart.js's cross-window responsive sizing", async () => {
    const app = appWithResult(chartResult(), { resultView: 'chart' });
    paintChart(app);
    const canvas = app.dom.resultsRegion.querySelector('canvas');
    const wrap = canvas.parentElement;
    Object.defineProperty(wrap, 'offsetWidth', { value: 640, configurable: true });
    Object.defineProperty(wrap, 'offsetHeight', { value: 320, configurable: true });
    await new Promise((resolve) => window.requestAnimationFrame(resolve)); // let the scheduled rAF run
    expect(app.chart.lastResize).toEqual([640, 320]);
    expect(app.chart.lastUpdateMode).toBe('resize');
  });
  it('skips the forced resize when the container never gets a real size (e.g. torn down before the rAF fires)', async () => {
    const app = appWithResult(chartResult(), { resultView: 'chart' });
    paintChart(app);
    const chart = app.chart;
    await new Promise((resolve) => window.requestAnimationFrame(resolve)); // offsetWidth/Height are 0 in happy-dom by default
    expect(chart.lastResize).toBeUndefined();
    expect(chart.lastUpdateMode).toBeUndefined();
  });
});

describe('installChartZoomFix', () => {
  it('undoes the page CSS zoom on pointer events before Chart.js hit-tests them', () => {
    const app = appWithResult(tableResult(), { resultView: 'chart' });
    paintChart(app);
    const canvas = app.chart.canvas;
    // Simulate html{zoom:1.2}: rect (zoomed) is 1.2× the layout offsetWidth.
    canvas.getBoundingClientRect = () => ({ width: 120, height: 60, left: 0, top: 0, right: 120, bottom: 60 });
    Object.defineProperty(canvas, 'offsetWidth', { value: 100, configurable: true });
    app.chart._eventHandler({ x: 120, y: 60 }, false); // right edge in zoomed px
    expect(app.chart.lastEvent.x).toBeCloseTo(100); // mapped back into 0..100 chart space
    expect(app.chart.lastEvent.y).toBeCloseTo(50);
    expect(app.chart.lastReplay).toBe(false);
  });
  it('returns the instance untouched when it has no event handler (or is nullish)', () => {
    const chart = { config: {} }; // no _eventHandler
    expect(installChartZoomFix(chart, document.createElement('canvas'))).toBe(chart);
    expect(installChartZoomFix(null, null)).toBeNull();
  });
});
