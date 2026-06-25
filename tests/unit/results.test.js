import { describe, it, expect } from 'vitest';
import { renderResults, renderJson, renderTable, renderChart, colResizeWidth, openCellDetail, installChartZoomFix } from '../../src/ui/results.js';
import { makeApp } from '../helpers/fake-app.js';
import { newResult } from '../../src/core/stream.js';
import { schemaKey } from '../../src/core/chart-data.js';

const click = (el) => el.dispatchEvent(new Event('click', { bubbles: true }));

function appWithResult(result, over = {}) {
  const app = makeApp();
  app.activeTab().result = result;
  Object.assign(app.state, over);
  return app;
}

function tableResult() {
  const r = newResult('Table');
  r.columns = [{ name: 'n', type: 'UInt64' }, { name: 's', type: 'String' }];
  r.rows = [['2', 'b'], ['1', null]];
  r.progress = { rows: 2, bytes: 100, elapsed_ns: 5e6 };
  return r;
}

describe('renderResults states', () => {
  it('no-ops without a region', () => {
    const app = makeApp();
    app.dom.resultsRegion = null;
    expect(() => renderResults(app)).not.toThrow();
  });
  it('empty prompt when no result', () => {
    const app = appWithResult(null);
    renderResults(app);
    expect(app.dom.resultsRegion.textContent).toContain('to run query');
  });
  it('streaming-blank shows "Starting query…", a determinate strip, live counters + Cancel, and no "null"', () => {
    const r = newResult('Table');
    r.pct = 40;
    r.progress = { rows: 10, bytes: 50, elapsed_ns: 0 };
    const app = appWithResult(r, { running: true });
    renderResults(app);
    const region = app.dom.resultsRegion;
    expect(region.querySelector('.stream-strip .fill')).not.toBeNull(); // pct>0 → determinate
    expect(region.textContent).toContain('Starting query…');
    expect(region.textContent).not.toMatch(/null/i); // regression: no "Loading/Streaming null"
    // live counters (rows/bytes) + Cancel in the toolbar
    expect(region.textContent).toContain('10 rows');
    const cancel = region.querySelector('.cancel-act');
    expect(cancel).not.toBeNull();
    click(cancel);
    expect(app.actions.cancel).toHaveBeenCalled();
  });
  it('streaming-blank with no result object uses an indeterminate sweep', () => {
    const app = appWithResult(null, { running: true });
    renderResults(app);
    expect(app.dom.resultsRegion.querySelector('.stream-strip .sweep')).not.toBeNull();
    expect(app.dom.resultsRegion.textContent).toContain('Starting query…');
  });
  it('renders an error', () => {
    const r = newResult('Table');
    r.error = 'DB::Exception: boom';
    renderResults(appWithResult(r));
    // toolbar present + error body
    const app = appWithResult(r);
    renderResults(app);
    expect(app.dom.resultsRegion.querySelector('.results-error').textContent).toContain('boom');
  });
  it('renders raw text + a single raw view tab', () => {
    const r = newResult('TSV');
    r.rawText = 'a\tb\n1\t2';
    const app = appWithResult(r);
    renderResults(app);
    expect(app.dom.resultsRegion.querySelector('.raw-text-view').textContent).toContain('a\tb');
    expect(app.dom.resultsRegion.querySelectorAll('.result-view-tab')).toHaveLength(1);
  });
  it('raw JSON view uses the json icon label', () => {
    const r = newResult('JSON');
    r.rawText = '{"x":1}';
    const app = appWithResult(r);
    renderResults(app);
    expect(app.dom.resultsRegion.querySelector('.result-view-tab').textContent).toContain('JSON');
  });
  it('reports 0 rows', () => {
    const r = newResult('Table');
    renderResults(appWithResult(r));
    const app = appWithResult(r);
    renderResults(app);
    expect(app.dom.resultsRegion.textContent).toContain('Query returned 0 rows.');
  });
  it('table view (default) renders partial rows + streaming strip while running', () => {
    const app = appWithResult(tableResult(), { running: true, resultView: 'table' });
    renderResults(app);
    expect(app.dom.resultsRegion.querySelectorAll('.res-table tbody tr')).toHaveLength(2);
    expect(app.dom.resultsRegion.querySelector('.stream-strip')).not.toBeNull();
  });
  it('a cancelled result shows the "Cancelled · partial" badge with Copy/Export', () => {
    const r = tableResult();
    r.cancelled = true;
    const app = appWithResult(r, { resultView: 'table' });
    renderResults(app);
    const region = app.dom.resultsRegion;
    expect(region.querySelector('.cancelled-badge').textContent).toContain('Cancelled · partial');
    expect([...region.querySelectorAll('.res-act')].some((b) => /Copy/.test(b.textContent))).toBe(true);
  });
  it('json view', () => {
    const app = appWithResult(tableResult(), { resultView: 'json' });
    renderResults(app);
    expect(app.dom.resultsRegion.querySelector('.json-view').textContent).toContain('"n": "2"');
  });
  it('chart view', () => {
    const app = appWithResult(tableResult(), { resultView: 'chart' });
    renderResults(app);
    expect(app.dom.resultsRegion.querySelector('.chart-view')).not.toBeNull();
  });
  it('clicking a view tab switches the view', () => {
    const app = appWithResult(tableResult(), { resultView: 'table' });
    renderResults(app);
    const jsonTab = [...app.dom.resultsRegion.querySelectorAll('.result-view-tab')].find((b) => b.textContent.includes('JSON'));
    click(jsonTab);
    expect(app.state.resultView).toBe('json');
  });
});

describe('renderTable', () => {
  it('sorts ascending then toggles to descending via header click', () => {
    const app = appWithResult(tableResult());
    renderResults(app);
    const th = app.dom.resultsRegion.querySelectorAll('.res-table th')[1]; // column 'n'
    click(th);
    expect(app.state.resultSort).toEqual({ col: 0, dir: 'asc' });
    const th2 = app.dom.resultsRegion.querySelectorAll('.res-table th')[1];
    click(th2);
    expect(app.state.resultSort.dir).toBe('desc');
    const th3 = app.dom.resultsRegion.querySelectorAll('.res-table th')[1];
    click(th3); // desc → asc
    expect(app.state.resultSort.dir).toBe('asc');
  });
  it('renders the active sort indicator and numeric cell class', () => {
    const app = appWithResult(tableResult(), { resultSort: { col: 0, dir: 'asc' } });
    const el = renderTable(app, app.activeTab().result);
    expect(el.querySelector('.h-sort')).not.toBeNull();
    expect(el.querySelector('td.num')).not.toBeNull();
  });
  it('Copy and Export buttons in the footer fire their actions', () => {
    const app = appWithResult(tableResult());
    renderResults(app);
    const acts = [...app.dom.resultsRegion.querySelectorAll('.res-act')];
    expect(acts.map((b) => b.textContent)).toEqual(['Copy', 'Export']);
    click(acts[0]);
    expect(app.actions.copyResult).toHaveBeenCalled();
    click(acts[1]);
    expect(app.actions.exportResult).toHaveBeenCalled();
  });
  it('no Copy/Export buttons on an error result', () => {
    const r = newResult('Table');
    r.error = 'boom';
    const app = appWithResult(r);
    renderResults(app);
    expect(app.dom.resultsRegion.querySelectorAll('.res-act')).toHaveLength(0);
  });
  it('header shows column names only, with the type as a hover tooltip', () => {
    const el = renderTable(appWithResult(tableResult()), tableResult());
    const ths = el.querySelectorAll('thead th');
    expect(ths[1].querySelector('.h-name').textContent).toBe('n');
    expect(el.querySelector('.h-type')).toBeNull();
    expect(ths[1].textContent).not.toContain('UInt64'); // type not rendered inline
    expect(ths[1].getAttribute('title')).toBe('UInt64'); // exposed on hover
    expect(ths[2].getAttribute('title')).toBe('String');
  });
  it('data cells truncate (.cell-val) and open the detail drawer on click', () => {
    const app = appWithResult(tableResult());
    const el = renderTable(app, app.activeTab().result);
    const cell = el.querySelector('tbody td.cell');
    expect(cell.querySelector('.cell-val')).not.toBeNull();
    click(cell);
    expect(app.document.querySelector('.cd-backdrop')).not.toBeNull();
    app.document.querySelector('.cd-backdrop').remove(); // cleanup
  });
  it('truncates very large result sets', () => {
    const r = newResult('Table');
    r.columns = [{ name: 'n', type: 'UInt64' }];
    r.rows = Array.from({ length: 5001 }, (_, i) => [String(i)]);
    const el = renderTable(makeApp(), r);
    expect(el.textContent).toContain('more rows truncated');
  });
});

describe('column resize', () => {
  it('colResizeWidth converts client px via scale and clamps to the floor', () => {
    expect(colResizeWidth(100, 50, 1)).toBe(150);
    expect(colResizeWidth(100, -90, 1)).toBe(48);    // floored at MIN_COL
    expect(colResizeWidth(100, 120, 1.2)).toBe(200); // zoom: 100 + 120/1.2
    expect(colResizeWidth(100, 0, 0)).toBe(100);     // scale 0 → /1
    expect(colResizeWidth(100, 0, NaN)).toBe(100);   // NaN → /1
  });

  it('puts a resize handle on each data column; the handle does not sort', () => {
    const app = appWithResult(tableResult());
    renderResults(app);
    const handles = app.dom.resultsRegion.querySelectorAll('.res-table th .col-resize-h');
    expect(handles).toHaveLength(2); // one per data column, none on the '#' column
    const before = { ...app.state.resultSort };
    handles[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(app.state.resultSort).toEqual(before); // stopPropagation → no sort
  });

  it('dragging a handle fixes the layout and updates widths; re-drag reuses them', () => {
    const app = appWithResult(tableResult());
    renderResults(app);
    const r = app.activeTab().result;
    const region = app.dom.resultsRegion;
    let handle = region.querySelectorAll('.res-table th .col-resize-h')[0];
    const win = handle.ownerDocument.defaultView;
    // first drag: colWidths empty → measure all columns, switch to fixed layout
    handle.dispatchEvent(new MouseEvent('mousedown', { clientX: 200, bubbles: true }));
    const table = region.querySelector('.res-table');
    expect(table.classList.contains('fixed')).toBe(true);
    expect(Object.keys(r.colWidths)).toContain('idx');
    win.dispatchEvent(new MouseEvent('mousemove', { clientX: 320 }));
    expect(r.colWidths[0]).toBe(120); // startW 0 + 120/1 (scale NaN→1 in jsdom)
    win.dispatchEvent(new MouseEvent('mouseup', {}));
    win.dispatchEvent(new MouseEvent('mousemove', { clientX: 999 }));
    expect(r.colWidths[0]).toBe(120); // listeners removed on mouseup

    // second drag on column 1: colWidths already populated → measure skipped
    handle = region.querySelectorAll('.res-table th .col-resize-h')[1];
    handle.dispatchEvent(new MouseEvent('mousedown', { clientX: 100, bubbles: true }));
    win.dispatchEvent(new MouseEvent('mousemove', { clientX: 180 }));
    expect(r.colWidths[1]).toBe(80);
    win.dispatchEvent(new MouseEvent('mouseup', {}));
  });

  it('reapplies stored widths on re-render (survives sort / streaming)', () => {
    const r = tableResult();
    r.colWidths = { idx: 36, 0: 90, 1: 70 };
    const app = appWithResult(r);
    renderResults(app);
    const table = app.dom.resultsRegion.querySelector('.res-table');
    expect(table.classList.contains('fixed')).toBe(true);
    const cells = table.querySelectorAll('thead th');
    expect(cells[1].style.width).toBe('90px');
    expect(cells[2].style.width).toBe('70px');
    expect(table.style.width).toBe('196px'); // 36 + 90 + 70
  });
});

describe('openCellDetail', () => {
  it('text value → pretty <pre>, no toggle; closes via ✕', () => {
    const app = makeApp();
    openCellDetail(app, 'col', 'String', '{"a":1}');
    const bd = document.querySelector('.cd-backdrop');
    expect(bd).not.toBeNull();
    expect(bd.querySelector('.cd-name').textContent).toBe('col');
    expect(bd.querySelector('.cd-type').textContent).toBe('String');
    expect(bd.querySelector('.cd-pre').textContent).toBe('{\n  "a": 1\n}');
    expect(bd.querySelector('.cd-toggle')).toBeNull();
    click(bd.querySelector('.cd-close'));
    expect(document.querySelector('.cd-backdrop')).toBeNull();
  });
  it('null value + no type → empty pre, no type chip', () => {
    openCellDetail(makeApp(), 'c', '', null);
    const bd = document.querySelector('.cd-backdrop');
    expect(bd.querySelector('.cd-type')).toBeNull();
    expect(bd.querySelector('.cd-pre').textContent).toBe('');
    bd.remove();
  });
  it('HTML value → Rendered (sandboxed iframe srcdoc) ↔ Source toggle', () => {
    openCellDetail(makeApp(), 'html', 'String', '<b>hi</b>');
    const bd = document.querySelector('.cd-backdrop');
    expect([...bd.querySelectorAll('.cd-seg')].map((s) => s.textContent)).toEqual(['Rendered', 'Source']);
    const frame = bd.querySelector('iframe.cd-frame');
    expect(frame.getAttribute('sandbox')).toBe('');
    expect(frame.getAttribute('srcdoc')).toBe('<b>hi</b>');
    click(bd.querySelectorAll('.cd-seg')[1]); // → Source
    expect(bd.querySelector('iframe')).toBeNull();
    expect(bd.querySelector('.cd-pre').textContent).toBe('<b>hi</b>');
    click(bd.querySelectorAll('.cd-seg')[0]); // → Rendered again
    expect(bd.querySelector('iframe.cd-frame')).not.toBeNull();
    bd.remove();
  });
  it('Escape closes; backdrop click closes; panel click does not', () => {
    const app = makeApp();
    openCellDetail(app, 'c', 'String', 'x');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(document.querySelector('.cd-backdrop')).toBeNull();
    openCellDetail(app, 'c', 'String', 'x');
    click(document.querySelector('.cd-backdrop'));
    expect(document.querySelector('.cd-backdrop')).toBeNull();
    openCellDetail(app, 'c', 'String', 'x');
    click(document.querySelector('.cd-panel')); // stopPropagation → stays open
    expect(document.querySelector('.cd-backdrop')).not.toBeNull();
    document.querySelector('.cd-backdrop').remove();
  });
});

describe('renderJson', () => {
  it('builds an array of row objects capped at the cap', () => {
    const r = tableResult();
    const el = renderJson(r);
    const parsed = JSON.parse(el.textContent);
    expect(parsed[0]).toEqual({ n: '2', s: 'b' });
  });
});

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

describe('renderChart', () => {
  it('shows a not-chartable hint when no measure exists', () => {
    const r = newResult('Table');
    r.columns = [{ name: 'a', type: 'String' }];
    r.rows = [['x']];
    const app = appWithResult(r, { resultView: 'chart' });
    expect(renderChart(app, r).textContent).toContain('aren’t chartable');
  });
  it('shows a "renders when complete" hint while the query is still running', () => {
    const app = appWithResult(tableResult(), { resultView: 'chart', running: true });
    expect(renderChart(app, app.activeTab().result).textContent).toContain('renders when the query completes');
  });
  it('builds a config bar and instantiates Chart.js on a canvas (categorical → hbar default)', () => {
    const app = appWithResult(tableResult(), { resultView: 'chart' });
    renderResults(app);
    const view = app.dom.resultsRegion.querySelector('.chart-view');
    expect(view.querySelector('canvas')).not.toBeNull();
    expect(app.chart).not.toBeNull();
    expect(app.chart.config.type).toBe('bar'); // hbar maps to bar + indexAxis y
    expect(app.chart.config.options.indexAxis).toBe('y');
    expect(app.activeTab().chartCfg).toMatchObject({ type: 'hbar', x: 1, y: [0] });
  });
  it('keeps a restored chart config when its schema key matches the result (saved/shared restore)', () => {
    const r = chartResult();
    const app = appWithResult(r, { resultView: 'chart' });
    const tab = app.activeTab();
    tab.chartKey = schemaKey(r.columns);
    tab.chartCfg = { type: 'pie', x: 0, y: [2], series: null }; // a deliberate non-default
    renderResults(app);
    expect(app.activeTab().chartCfg).toEqual({ type: 'pie', x: 0, y: [2], series: null }); // not re-derived
    expect(app.chart.config.type).toBe('pie');
  });
  it('falls back to autoChart when a restored config does not fit the schema (hand-edited link)', () => {
    const r = chartResult();
    const app = appWithResult(r, { resultView: 'chart' });
    const tab = app.activeTab();
    tab.chartKey = schemaKey(r.columns);
    tab.chartCfg = { type: 'bar', x: 99, y: [1], series: null }; // x out of range
    renderResults(app);
    expect(app.activeTab().chartCfg.x).toBeLessThan(r.columns.length); // guard re-derived a safe default
    expect(app.chart).not.toBeNull();
  });
  it('Type select switches renderer; non-pie keeps series, pie resets it to single-measure', () => {
    const app = appWithResult(chartResult(), { resultView: 'chart' });
    renderResults(app);
    // group-by first so we can prove pie clears it
    change(fieldSel(app.dom.resultsRegion, 'Series'), '1');
    expect(app.activeTab().chartCfg.series).toBe(1);
    change(fieldSel(app.dom.resultsRegion, 'Type'), 'line'); // non-pie branch
    expect(app.activeTab().chartCfg.type).toBe('line');
    change(fieldSel(app.dom.resultsRegion, 'Type'), 'pie'); // pie branch resets series
    expect(app.activeTab().chartCfg).toMatchObject({ type: 'pie', series: null });
    expect(fieldSel(app.dom.resultsRegion, 'Type')).not.toBeNull();
    expect([...app.dom.resultsRegion.querySelectorAll('.chart-field-label')].map((s) => s.textContent))
      .not.toContain('Series'); // series control hidden for pie
  });
  it('X and Y selects update the per-tab config', () => {
    const app = appWithResult(chartResult(), { resultView: 'chart' });
    renderResults(app);
    change(fieldSel(app.dom.resultsRegion, 'X'), '1');
    expect(app.activeTab().chartCfg.x).toBe(1);
    change(fieldSel(app.dom.resultsRegion, 'Y'), '3');
    expect(app.activeTab().chartCfg.y).toEqual([3]);
  });
  it('"All measures" toggles between single and multi-series', () => {
    const app = appWithResult(chartResult(), { resultView: 'chart' });
    renderResults(app);
    const btn = () => [...app.dom.resultsRegion.querySelectorAll('.chart-toggle')][0];
    expect(btn().textContent).toBe('All measures');
    click(btn());
    expect(app.activeTab().chartCfg.y).toEqual([2, 3]);
    expect(app.chart.config.data.datasets).toHaveLength(2);
    expect(btn().textContent).toBe('Single series');
    click(btn());
    expect(app.activeTab().chartCfg.y).toEqual([2]);
  });
  it('Series select sets and clears a group-by dimension', () => {
    const app = appWithResult(chartResult(), { resultView: 'chart' });
    renderResults(app);
    change(fieldSel(app.dom.resultsRegion, 'Series'), '1');
    expect(app.activeTab().chartCfg.series).toBe(1);
    change(fieldSel(app.dom.resultsRegion, 'Series'), '');
    expect(app.activeTab().chartCfg.series).toBeNull();
  });
  it('notes the row cap when the result is larger than the chart shows', () => {
    const r = newResult('Table');
    r.columns = [{ name: 'k', type: 'String' }, { name: 'v', type: 'UInt64' }];
    r.rows = Array.from({ length: 600 }, (_, i) => ['k' + i, String(i)]);
    r.progress = { rows: 600, bytes: 100, elapsed_ns: 5e6 };
    const app = appWithResult(r, { resultView: 'chart' });
    renderResults(app);
    const note = app.dom.resultsRegion.querySelector('.chart-cap-note');
    expect(note).not.toBeNull();
    expect(note.textContent).toContain('first 500 of');
    // a small result shows no cap note
    const small = appWithResult(tableResult(), { resultView: 'chart' });
    renderResults(small);
    expect(small.dom.resultsRegion.querySelector('.chart-cap-note')).toBeNull();
  });
  it('destroys the previous Chart instance on re-render, and re-derives config on a new schema', () => {
    const app = appWithResult(chartResult(), { resultView: 'chart' });
    renderResults(app);
    const first = app.chart;
    const cfg = app.activeTab().chartCfg;
    renderResults(app); // stable schema → keep config, swap chart instance
    expect(first.destroyed).toBe(true);
    expect(app.chart).not.toBe(first);
    expect(app.activeTab().chartCfg).toBe(cfg);
    app.activeTab().result = tableResult(); // different schema → re-derive
    renderResults(app);
    expect(app.activeTab().chartCfg).not.toBe(cfg);
  });
  it('does not re-derive (clobber) a restored config while the query is still running', () => {
    // running + rows already streamed: the run-state guard must fire BEFORE
    // chartCfgFor, so a still-settling result can't stamp a new key / autoChart
    // over the restored saved/shared config.
    const app = appWithResult(chartResult(), { resultView: 'chart', running: true });
    const tab = app.activeTab();
    const restored = { type: 'pie', x: 0, y: [2], series: null };
    tab.chartCfg = restored;
    tab.chartKey = 'STALE_KEY'; // deliberately != schemaKey(result.columns)
    renderResults(app);
    expect(app.dom.resultsRegion.textContent).toContain('renders when the query completes');
    expect(tab.chartCfg).toBe(restored); // untouched — chartCfgFor never ran
    expect(tab.chartKey).toBe('STALE_KEY');
  });
  it('normalizes a restored, self-contradictory pie config (multi-measure + series) on render', () => {
    const r = chartResult();
    const app = appWithResult(r, { resultView: 'chart' });
    const tab = app.activeTab();
    tab.chartKey = schemaKey(r.columns); // in-range but invalid combination
    tab.chartCfg = { type: 'pie', x: 0, y: [2, 3], series: 1 };
    renderResults(app);
    expect(app.activeTab().chartCfg).toEqual({ type: 'pie', x: 0, y: [2], series: null });
    expect(app.chart.config.data.datasets).toHaveLength(1); // single pie dataset
  });
  it('clears the series when the X column is changed to equal it', () => {
    const app = appWithResult(chartResult(), { resultView: 'chart' });
    renderResults(app);
    change(fieldSel(app.dom.resultsRegion, 'Series'), '1'); // series = region(1)
    expect(app.activeTab().chartCfg.series).toBe(1);
    change(fieldSel(app.dom.resultsRegion, 'X'), '1'); // X now equals series → series cleared
    expect(app.activeTab().chartCfg.x).toBe(1);
    expect(app.activeTab().chartCfg.series).toBeNull();
  });
});

describe('installChartZoomFix', () => {
  it('undoes the page CSS zoom on pointer events before Chart.js hit-tests them', () => {
    const app = appWithResult(tableResult(), { resultView: 'chart' });
    renderResults(app);
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

describe('EXPLAIN views', () => {
  function explainResult(view, over = {}) {
    const r = newResult(view === 'estimate' ? 'Table' : 'TabSeparatedRaw');
    r.explainView = view;
    return Object.assign(r, over);
  }

  it('toolbar shows the five EXPLAIN tabs with the active one marked', () => {
    const app = appWithResult(explainResult('pipeline', { rawText: 'digraph { n1 [label="A"]; }' }));
    renderResults(app);
    const tabs = [...app.dom.resultsRegion.querySelectorAll('.result-view-tab')];
    expect(tabs.map((t) => t.textContent)).toEqual(['Explain', 'Indexes', 'Projections', 'Pipeline', 'Estimate']);
    expect(tabs.find((t) => t.classList.contains('active')).textContent).toBe('Pipeline');
  });

  it('clicking a tab calls setExplainView (re-runs the derived query)', () => {
    const app = appWithResult(explainResult('explain', { rawText: 'plan text' }));
    renderResults(app);
    const tabs = [...app.dom.resultsRegion.querySelectorAll('.result-view-tab')];
    click(tabs[3]); // Pipeline
    expect(app.actions.setExplainView).toHaveBeenCalledWith('pipeline');
  });

  it('renders Explain/Indexes/Projections as monospace text', () => {
    const app = appWithResult(explainResult('explain', { rawText: 'Expression\n  ReadFromTable' }));
    renderResults(app);
    const view = app.dom.resultsRegion.querySelector('.raw-text-view');
    expect(view).not.toBeNull();
    expect(view.textContent).toBe('Expression\n  ReadFromTable');
  });

  it('renders Pipeline as the SVG graph', () => {
    const app = appWithResult(explainResult('pipeline', { rawText: 'digraph { n1 [label="A"]; n2 [label="B"]; n1 -> n2; }' }));
    renderResults(app);
    expect(app.dom.resultsRegion.querySelector('.explain-graph-view svg.explain-graph')).not.toBeNull();
  });

  it('renders Estimate as a structured table, with a placeholder when empty', () => {
    const r = explainResult('estimate');
    r.columns = [{ name: 'rows', type: 'UInt64' }];
    r.rows = [['42']];
    const app = appWithResult(r);
    renderResults(app);
    expect(app.dom.resultsRegion.querySelector('table.res-table')).not.toBeNull();

    const empty = appWithResult(explainResult('estimate', { columns: [], rows: [] }));
    renderResults(empty);
    expect(empty.dom.resultsRegion.querySelector('table.res-table')).toBeNull();
    expect(empty.dom.resultsRegion.textContent).toMatch(/No rows to estimate/);
  });

  it('keeps the EXPLAIN tabs visible when a view errors', () => {
    const app = appWithResult(explainResult('indexes', { error: 'DB::Exception: boom' }));
    renderResults(app);
    expect(app.dom.resultsRegion.querySelectorAll('.result-view-tab')).toHaveLength(5);
    expect(app.dom.resultsRegion.querySelector('.results-error').textContent).toContain('boom');
  });

  it('shows an Expand button for the Pipeline view that opens the fullscreen overlay', () => {
    const app = appWithResult(explainResult('pipeline', { rawText: 'digraph { n1 [label="A"]; }' }));
    renderResults(app);
    const expand = [...app.dom.resultsRegion.querySelectorAll('.res-act')].find((b) => /Expand/.test(b.textContent));
    expect(expand).toBeTruthy();
    click(expand);
    const overlay = document.body.querySelector('.graph-overlay');
    expect(overlay).not.toBeNull();
    overlay.dispatchEvent(new Event('click', { bubbles: true })); // backdrop click closes + cleans up
    expect(document.body.querySelector('.graph-overlay')).toBeNull();
  });

  it('has no Expand button for non-pipeline explain views', () => {
    const app = appWithResult(explainResult('explain', { rawText: 'plan text' }));
    renderResults(app);
    expect([...app.dom.resultsRegion.querySelectorAll('.res-act')].some((b) => /Expand/.test(b.textContent))).toBe(false);
  });
});

describe('schema lineage result', () => {
  function graphResult() {
    const r = newResult('Table');
    r.schemaGraph = {
      focus: { kind: 'db', db: 'lin' },
      nodes: [{ id: 'lin.a', label: 'a', kind: 'table' }, { id: 'lin.mv', label: 'mv', kind: 'mv' }],
      edges: [{ from: 'lin.a', to: 'lin.mv', kind: 'feeds' }],
    };
    return r;
  }
  it('renders the schema graph (svg + legend) and a Schema toolbar with Expand', () => {
    const app = appWithResult(graphResult());
    renderResults(app);
    const region = app.dom.resultsRegion;
    expect(region.querySelector('svg.explain-graph')).not.toBeNull();
    expect(region.querySelector('.schema-graph-legend')).not.toBeNull();
    expect(region.querySelector('.res-graph-title').textContent).toBe('Schema · lin');
    // no Table/JSON/Chart tabs in this mode
    expect(region.querySelector('.result-view-tab')).toBeNull();
    const expand = [...region.querySelectorAll('.res-act')].find((b) => /Expand/.test(b.textContent));
    expect(expand).toBeTruthy();
    click(expand);
    const overlay = document.body.querySelector('.graph-overlay');
    expect(overlay).not.toBeNull();
    overlay.dispatchEvent(new Event('click', { bubbles: true })); // backdrop close + cleanup
  });
  it('titles a table-focus graph with the qualified name', () => {
    const r = graphResult();
    r.schemaGraph.focus = { kind: 'table', db: 'lin', table: 'events' };
    const app = appWithResult(r);
    renderResults(app);
    expect(app.dom.resultsRegion.querySelector('.res-graph-title').textContent).toBe('Schema · lin.events');
  });
  it('shows a loading placeholder (and no graph/Expand) while the lineage loads', () => {
    const r = newResult('Table');
    r.schemaGraph = { focus: { kind: 'db', db: 'lin' }, loading: true, nodes: [], edges: [] };
    const app = appWithResult(r);
    renderResults(app);
    const region = app.dom.resultsRegion;
    expect(region.querySelector('.placeholder.starting').textContent).toMatch(/Loading lineage/);
    expect(region.querySelector('svg.explain-graph')).toBeNull();
    expect(region.querySelector('.res-graph-title').textContent).toBe('Schema · lin');
    expect([...region.querySelectorAll('.res-act')].find((b) => /Expand/.test(b.textContent))).toBeFalsy();
  });
});
