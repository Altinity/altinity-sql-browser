import { describe, it, expect } from 'vitest';
import { renderResults, renderJson, renderTable, renderChart, colResizeWidth, openCellDetail, openRowsViewer, installChartZoomFix, visCap } from '../../src/ui/results.js';
import { makeApp } from '../helpers/fake-app.js';
import { newResult } from '../../src/core/stream.js';
import { schemaKey } from '../../src/core/chart-data.js';

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
    expect(app.state.resultView.value).toBe('json');
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

describe('result row cap', () => {
  it('visCap follows the result row limit, else the 5000 fallback', () => {
    expect(visCap({ rowLimit: 10000 })).toBe(10000);
    expect(visCap({ rowLimit: 0 })).toBe(5000);
  });
  it('renders the row-limit selector reflecting the current limit; changing it re-runs', () => {
    const app = appWithResult(tableResult(), { resultRowLimit: 1000 });
    renderResults(app);
    const sel = app.dom.resultsRegion.querySelector('.row-limit-select');
    expect(sel).not.toBeNull();
    expect(sel.value).toBe('1000');
    expect([...sel.options].map((o) => o.value)).toEqual(['100', '500', '1000', '5000', '10000']);
    sel.value = '5000';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    expect(app.actions.setResultRowLimit).toHaveBeenCalledWith(5000);
  });
  it('hides the row-limit selector for EXPLAIN views', () => {
    const r = newResult('Table');
    r.explainView = 'explain';
    r.rawText = 'plan';
    const app = appWithResult(r);
    renderResults(app);
    expect(app.dom.resultsRegion.querySelector('.row-limit-select')).toBeNull();
  });
  it('shows a "first N (capped)" badge when the result is capped, none otherwise', () => {
    const r = tableResult();
    r.rowLimit = 500;
    r.capped = true;
    const app = appWithResult(r);
    renderResults(app);
    const badge = app.dom.resultsRegion.querySelector('.capped-badge');
    expect(badge.textContent).toBe('first 500 (capped)');
    // uncapped result → no badge
    renderResults(appWithResult(tableResult()));
    const app2 = appWithResult(tableResult());
    renderResults(app2);
    expect(app2.dom.resultsRegion.querySelector('.capped-badge')).toBeNull();
  });
  it('renders rows up to the result row limit (display cap follows it)', () => {
    const r = newResult('Table', 10000);
    r.columns = [{ name: 'n', type: 'UInt64' }];
    r.rows = Array.from({ length: 6000 }, (_, i) => [String(i)]);
    const el = renderTable(makeApp(), r);
    expect(el.querySelectorAll('tbody tr')).toHaveLength(6000); // 6000 < 10000 → all shown
    expect(el.textContent).not.toContain('more rows truncated');
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

  it('first drag freezes the layout (measures every column) and switches to fixed', () => {
    const app = appWithResult(tableResult());
    renderResults(app);
    const r = app.activeTab().result; // colWidths empty → freeze path
    const region = app.dom.resultsRegion;
    const handle = region.querySelectorAll('.res-table th .col-resize-h')[0];
    handle.dispatchEvent(new MouseEvent('mousedown', { clientX: 200, bubbles: true }));
    const table = region.querySelector('.res-table');
    expect(table.classList.contains('fixed')).toBe(true);
    expect(Object.keys(r.colWidths).sort()).toEqual(['0', '1', 'idx']); // every column measured
    handle.ownerDocument.defaultView.dispatchEvent(new MouseEvent('mouseup', {}));
  });

  it('splitter model: dragging a border grows the column and shrinks its neighbor (total constant)', () => {
    const r = tableResult();
    r.colWidths = { idx: 36, 0: 100, 1: 100 }; // pre-seeded so the pair math is meaningful
    const app = appWithResult(r);
    renderResults(app);
    const region = app.dom.resultsRegion;
    const win = region.ownerDocument.defaultView;
    const handle = region.querySelectorAll('.res-table th .col-resize-h')[0]; // col 0, neighbor col 1
    handle.dispatchEvent(new MouseEvent('mousedown', { clientX: 100, bubbles: true }));
    win.dispatchEvent(new MouseEvent('mousemove', { clientX: 130 })); // +30
    expect(r.colWidths[0]).toBe(130);
    expect(r.colWidths[1]).toBe(70); // neighbor gave up 30 — pair sum stays 200
    // drag past the neighbor's floor: neighbor clamps at MIN_COL (48), column caps
    win.dispatchEvent(new MouseEvent('mousemove', { clientX: 999 }));
    expect(r.colWidths[1]).toBe(48);
    expect(r.colWidths[0]).toBe(152); // 200 - 48
    win.dispatchEvent(new MouseEvent('mouseup', {}));
    win.dispatchEvent(new MouseEvent('mousemove', { clientX: 0 }));
    expect(r.colWidths[0]).toBe(152); // listeners removed on mouseup
  });

  it('dragging the last column has no neighbor, so it grows the table', () => {
    const r = tableResult();
    r.colWidths = { idx: 36, 0: 100, 1: 100 };
    const app = appWithResult(r);
    renderResults(app);
    const region = app.dom.resultsRegion;
    const win = region.ownerDocument.defaultView;
    const handle = region.querySelectorAll('.res-table th .col-resize-h')[1]; // last data column
    handle.dispatchEvent(new MouseEvent('mousedown', { clientX: 100, bubbles: true }));
    win.dispatchEvent(new MouseEvent('mousemove', { clientX: 150 })); // +50
    expect(r.colWidths[1]).toBe(150);
    expect(r.colWidths[0]).toBe(100); // unchanged — no redistribution
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
    // Expand now fires the async action that lazily loads the rich-card dataset and
    // opens the overlay (the overlay itself is covered in explain-graph.test.js).
    expect(app.actions.expandSchemaGraph).toHaveBeenCalledWith({ kind: 'db', db: 'lin' });
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
    expect(region.querySelector('.placeholder.starting').textContent).toMatch(/Loading data flow/);
    expect(region.querySelector('svg.explain-graph')).toBeNull();
    expect(region.querySelector('.res-graph-title').textContent).toBe('Schema · lin');
    expect([...region.querySelectorAll('.res-act')].find((b) => /Expand/.test(b.textContent))).toBeFalsy();
  });
  it('a DB with no objects shows the message and no Expand button', () => {
    const r = newResult('Table');
    r.schemaGraph = { focus: { kind: 'db', db: 'target_all' }, nodes: [], edges: [] };
    const app = appWithResult(r);
    renderResults(app);
    const region = app.dom.resultsRegion;
    expect(region.querySelector('svg.explain-graph')).toBeNull();
    expect(region.querySelector('.placeholder').textContent).toMatch(/No objects in target_all/);
    expect([...region.querySelectorAll('.res-act')].find((b) => /Expand/.test(b.textContent))).toBeFalsy();
  });
});

describe('multiquery script grid (#83)', () => {
  const scriptResult = (over = {}) => ({
    elapsedMs: 12,
    script: [
      { sql: 'CREATE TABLE t (a Int8)', status: 'ok', ms: 3 },
      { sql: 'SELECT count() AS c\nFROM t', status: 'rows', columns: [{ name: 'c', type: 'UInt64' }], rows: [['1'], ['2']], truncated: false, preview: '1', ms: 7 },
      { sql: 'SELECT * FROM nope', status: 'rows', columns: [], rows: [], ms: 1 },
      { sql: 'BAD SQL', status: 'error', error: 'DB::Exception: boom', ms: 2 },
    ],
    ...over,
  });

  it('renders one row per statement with OK / preview / 0-rows / error outcomes', () => {
    const app = appWithResult(scriptResult());
    renderResults(app);
    const region = app.dom.resultsRegion;
    expect(region.querySelector('.script-grid')).not.toBeNull();
    expect(region.querySelector('.res-graph-title').textContent).toContain('4 statements');
    const cells = [...region.querySelectorAll('.script-cell')];
    expect(cells[0].textContent).toBe('OK');
    expect(cells[1].textContent).toContain('1'); // preview
    expect(cells[1].textContent).toContain('2 rows');
    expect(cells[2].textContent).toBe('(0 rows)');
    expect(cells[3].textContent).toContain('boom');
    // SQL is collapsed to one line, full text on the title attribute
    const sqlCell = region.querySelector('tbody td.script-sql');
    expect(sqlCell.querySelector('.cell-val').textContent).toBe('CREATE TABLE t (a Int8)');
  });

  it('flags a truncated SELECT in its row meta', () => {
    const app = appWithResult(scriptResult({
      script: [{ sql: 'SELECT * FROM big', status: 'rows', columns: [{ name: 'a', type: 'Int' }], rows: [['x']], truncated: true, preview: 'x' }],
    }));
    renderResults(app);
    expect(app.dom.resultsRegion.querySelector('.script-cell.rows').textContent).toContain('first 100');
  });

  it('clicking a SELECT row opens the rows pane; Escape and backdrop close it', () => {
    const app = appWithResult(scriptResult());
    renderResults(app);
    click(app.dom.resultsRegion.querySelector('.script-cell.rows'));
    let backdrop = document.querySelector('.cd-backdrop');
    expect(backdrop).not.toBeNull();
    expect(backdrop.querySelectorAll('tbody tr')).toHaveLength(2); // both rows
    expect(backdrop.querySelector('.cd-type').textContent).toContain('2 rows');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(document.querySelector('.cd-backdrop')).toBeNull();
    // reopen + close via backdrop click
    click(app.dom.resultsRegion.querySelector('.script-cell.rows'));
    backdrop = document.querySelector('.cd-backdrop');
    click(backdrop);
    expect(document.querySelector('.cd-backdrop')).toBeNull();
  });

  it('openRowsViewer renders NULL cells empty and flags a truncated count', () => {
    const app = makeApp();
    openRowsViewer(app, { columns: [{ name: 'x', type: 'String' }, { name: 'y', type: 'String' }], rows: [['a', null]], truncated: true });
    const backdrop = document.querySelector('.cd-backdrop');
    expect(backdrop.querySelector('.cd-type').textContent).toContain('1+ row');
    const cells = [...backdrop.querySelectorAll('tbody td')];
    expect(cells[cells.length - 1].textContent).toBe(''); // null → empty
    backdrop.remove();
  });

  it('the rows pane is the shared grid: sortable headers + clickable cells', () => {
    const app = makeApp();
    openRowsViewer(app, { columns: [{ name: 'n', type: 'UInt64' }], rows: [['2'], ['1'], ['3']] });
    let backdrop = document.querySelector('.cd-backdrop');
    // a data column header sorts the pane in place (local sort state)
    const colHeader = [...backdrop.querySelectorAll('thead th')].find((th) => th.textContent.includes('n'));
    click(colHeader);
    backdrop = document.querySelector('.cd-backdrop');
    const firstCell = backdrop.querySelector('tbody tr td.cell .cell-val');
    expect(firstCell.textContent).toBe('1'); // ascending now
    // clicking a cell opens the (stacked) cell-detail drawer
    click(backdrop.querySelector('tbody td.cell'));
    expect(document.querySelectorAll('.cd-backdrop').length).toBe(2);
    document.querySelectorAll('.cd-backdrop').forEach((b) => b.remove());
  });

  it('Escape closes only the topmost stacked drawer (cell first, then the rows pane)', () => {
    const app = makeApp();
    openRowsViewer(app, { columns: [{ name: 'n', type: 'String' }], rows: [['x']] });
    click(document.querySelector('.cd-backdrop tbody td.cell')); // opens a stacked cell drawer
    expect(document.querySelectorAll('.cd-backdrop')).toHaveLength(2);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(document.querySelectorAll('.cd-backdrop')).toHaveLength(1); // only the cell drawer closed
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(document.querySelectorAll('.cd-backdrop')).toHaveLength(0); // now the rows pane
  });

  it('toolbar shows live elapsed + Cancel while running, with a running footer', () => {
    const app = appWithResult(scriptResult(), { running: true });
    renderResults(app);
    const region = app.dom.resultsRegion;
    const cancel = region.querySelector('.cancel-act');
    expect(cancel).not.toBeNull();
    expect(region.querySelector('.script-running')).not.toBeNull();
    click(cancel);
    expect(app.actions.cancel).toHaveBeenCalled();
  });

  it('toolbar shows total elapsed + a cancelled badge when a script was aborted', () => {
    const app = appWithResult(scriptResult({ cancelled: true }));
    renderResults(app);
    const region = app.dom.resultsRegion;
    expect(region.querySelector('.cancelled-badge')).not.toBeNull();
    expect(region.textContent).toContain('12 ms');
    expect(region.querySelector('.script-running')).toBeNull();
  });

  it('handles a single-statement script label without an "s"', () => {
    const app = appWithResult(scriptResult({ script: [{ sql: 'SELECT 1', status: 'ok' }] }));
    renderResults(app);
    expect(app.dom.resultsRegion.querySelector('.res-graph-title').textContent).toContain('1 statement');
  });

  it('shows each statement’s own execution time in a third column', () => {
    const app = appWithResult(scriptResult());
    renderResults(app);
    const region = app.dom.resultsRegion;
    expect([...region.querySelectorAll('thead th')].map((th) => th.textContent.trim())).toEqual(['Statement', 'Result', 'Time']);
    expect([...region.querySelectorAll('tbody td.script-time')].map((td) => td.textContent)).toEqual(['3 ms', '7 ms', '1 ms', '2 ms']);
  });

  it('leaves the Time cell blank when a statement has no recorded ms', () => {
    const app = appWithResult(scriptResult({ script: [{ sql: 'SELECT 1', status: 'ok' }] }));
    renderResults(app);
    expect(app.dom.resultsRegion.querySelector('tbody td.script-time').textContent).toBe('');
  });

  it('columns are drag-resizable: 3 handles, keyed by plain index (no idx col), splitter model', () => {
    const r = scriptResult({ colWidths: { 0: 200, 1: 400, 2: 100 } }); // pre-seeded pair math
    const app = appWithResult(r);
    renderResults(app);
    const region = app.dom.resultsRegion;
    const handles = region.querySelectorAll('.script-grid th .col-resize-h');
    expect(handles).toHaveLength(3); // Statement, Result, Time
    const win = handles[0].ownerDocument.defaultView;
    handles[0].dispatchEvent(new MouseEvent('mousedown', { clientX: 100, bubbles: true })); // col 0, neighbor col 1
    win.dispatchEvent(new MouseEvent('mousemove', { clientX: 150 })); // +50
    expect(r.colWidths[0]).toBe(250);
    expect(r.colWidths[1]).toBe(350); // neighbor shrank by 50; pair sum stays 600
    expect(r.colWidths[2]).toBe(100); // untouched
    win.dispatchEvent(new MouseEvent('mouseup', {}));
  });

  it('first drag on the script grid freezes every column (keys 0/1/2, no idx)', () => {
    const app = appWithResult(scriptResult()); // no colWidths → freeze path
    renderResults(app);
    const r = app.activeTab().result;
    const region = app.dom.resultsRegion;
    region.querySelector('.script-grid th .col-resize-h').dispatchEvent(new MouseEvent('mousedown', { clientX: 100, bubbles: true }));
    expect(region.querySelector('.res-table').classList.contains('fixed')).toBe(true);
    expect(Object.keys(r.colWidths).sort()).toEqual(['0', '1', '2']);
    region.ownerDocument.defaultView.dispatchEvent(new MouseEvent('mouseup', {}));
  });

  it('reapplies stored script-grid widths on re-render', () => {
    const app = appWithResult(scriptResult({ colWidths: { 0: 120, 1: 300, 2: 60 } }));
    renderResults(app);
    const cells = app.dom.resultsRegion.querySelectorAll('.script-grid thead th');
    expect(cells[0].style.width).toBe('120px');
    expect(cells[2].style.width).toBe('60px');
  });
});
