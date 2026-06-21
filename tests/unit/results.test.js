import { describe, it, expect } from 'vitest';
import { renderResults, renderJson, renderTable, renderChart, colResizeWidth, openCellDetail } from '../../src/ui/results.js';
import { makeApp } from '../helpers/fake-app.js';
import { newResult } from '../../src/core/stream.js';

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
  it('streaming-blank with a partial result shows progress', () => {
    const r = newResult('Table');
    r.pct = 40;
    r.progress = { rows: 10, bytes: 50, elapsed_ns: 0 };
    const app = appWithResult(r, { running: true });
    renderResults(app);
    expect(app.dom.resultsRegion.querySelector('.progress-bar')).not.toBeNull();
    expect(app.dom.resultsRegion.textContent).toContain('Streaming results…');
  });
  it('streaming-blank with no result object', () => {
    const app = appWithResult(null, { running: true });
    renderResults(app);
    expect(app.dom.resultsRegion.querySelector('.progress-bar')).not.toBeNull();
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
  it('table view (default) renders rows + progress bar while running', () => {
    const app = appWithResult(tableResult(), { running: true, resultView: 'table' });
    renderResults(app);
    expect(app.dom.resultsRegion.querySelectorAll('.res-table tbody tr')).toHaveLength(2);
    expect(app.dom.resultsRegion.querySelector('.progress-bar')).not.toBeNull();
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

describe('renderChart', () => {
  it('says so when no numeric column exists', () => {
    const r = newResult('Table');
    r.columns = [{ name: 'a', type: 'String' }];
    r.rows = [['x']];
    expect(renderChart(r).textContent).toContain('No numeric columns to chart.');
  });
  it('draws bars for numeric data', () => {
    const r = tableResult();
    const el = renderChart(r);
    expect(el.querySelectorAll('rect').length).toBeGreaterThan(0);
    expect(el.querySelector('.chart-controls').textContent).toContain('X:');
  });
  it('handles an all-zero series (max 0)', () => {
    const r = newResult('Table');
    r.columns = [{ name: 'k', type: 'String' }, { name: 'v', type: 'UInt64' }];
    r.rows = [['a', '0'], ['b', '0']];
    const el = renderChart(r);
    expect(el.querySelectorAll('rect')).toHaveLength(2);
  });
  it('samples + truncates long x labels for wide series', () => {
    const r = newResult('Table');
    r.columns = [{ name: 'k', type: 'String' }, { name: 'v', type: 'UInt64' }];
    r.rows = Array.from({ length: 30 }, (_, i) => ['a_very_long_label_' + i, String(i)]);
    const el = renderChart(r);
    // fewer text labels than rows (sampled every Nth) — y-axis adds 2 texts
    expect(el.querySelectorAll('text').length).toBeLessThan(30);
    // long labels are truncated with an ellipsis
    expect([...el.querySelectorAll('text')].some((t) => t.textContent.endsWith('…'))).toBe(true);
  });
});
