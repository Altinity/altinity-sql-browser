import { describe, it, expect, vi } from 'vitest';
import { renderResults, renderJson, renderTable, renderChart, colResizeWidth, openCellDetail, openRowsViewer, installChartZoomFix, visCap, expandDataPane } from '../../src/ui/results.js';
import { makeApp } from '../helpers/fake-app.js';
import { newResult } from '../../src/core/stream.js';
import { schemaKey, chartRowCap } from '../../src/core/chart-data.js';

const click = (el) => el.dispatchEvent(new Event('click', { bubbles: true }));
// A genuine backdrop click: mousedown and click both land on `el` itself
// (#110's attachBackdropClose gates close() on where mousedown landed).
const backdropClick = (el) => {
  el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  el.dispatchEvent(new Event('click', { bubbles: true }));
};

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
  it('the Expand + Copy buttons in the footer are present, Copy fires its action', () => {
    const app = appWithResult(tableResult());
    renderResults(app);
    const acts = [...app.dom.resultsRegion.querySelectorAll('.res-act')];
    expect(acts.map((b) => b.textContent)).toEqual(['Expand', 'Copy']);
    click(acts[1]);
    expect(app.actions.copyResult).toHaveBeenCalled();
  });
  it('no Copy button on an error result', () => {
    const r = newResult('Table');
    r.error = 'boom';
    const app = appWithResult(r);
    renderResults(app);
    expect(app.dom.resultsRegion.querySelectorAll('.res-act')).toHaveLength(0);
  });
  it('no Expand button for raw text output (Copy still shows)', () => {
    const r = newResult('TSV');
    r.rawText = 'a\tb\n1\t2';
    const app = appWithResult(r);
    renderResults(app);
    const acts = [...app.dom.resultsRegion.querySelectorAll('.res-act')];
    expect(acts.map((b) => b.textContent)).toEqual(['Copy']);
  });
  it('no Expand button for a 0-row result (Copy still shows)', () => {
    const r = tableResult();
    r.rows = [];
    const app = appWithResult(r);
    renderResults(app);
    const acts = [...app.dom.resultsRegion.querySelectorAll('.res-act')];
    expect(acts.map((b) => b.textContent)).toEqual(['Copy']);
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
    backdropClick(document.querySelector('.cd-backdrop'));
    expect(document.querySelector('.cd-backdrop')).toBeNull();
    openCellDetail(app, 'c', 'String', 'x');
    backdropClick(document.querySelector('.cd-panel')); // mousedown+click inside the panel → stays open
    expect(document.querySelector('.cd-backdrop')).not.toBeNull();
    document.querySelector('.cd-backdrop').remove();
  });
  it('a gesture starting inside the panel and ending (mouseup/click) on the backdrop does not close it (#110)', () => {
    const app = makeApp();
    openCellDetail(app, 'c', 'String', 'a selectable value');
    const backdrop = document.querySelector('.cd-backdrop');
    const pre = backdrop.querySelector('.cd-pre');
    pre.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); // drag starts inside the panel
    // The click that follows targets the backdrop directly — the nearest
    // common ancestor of the mousedown (inside .cd-pre) and mouseup targets.
    backdrop.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(document.querySelector('.cd-backdrop')).not.toBeNull();
    backdropClick(backdrop); // a later, genuine backdrop click still closes it
    expect(document.querySelector('.cd-backdrop')).toBeNull();
  });
  it('builds in a given targetDoc instead of the main document (detached-tab safe)', () => {
    const childDoc = document.implementation.createHTMLDocument('');
    openCellDetail(makeApp(), 'c', 'String', 'x', childDoc);
    expect(document.querySelector('.cd-backdrop')).toBeNull(); // not in the main document
    const bd = childDoc.querySelector('.cd-backdrop');
    expect(bd).not.toBeNull();
    expect(bd.querySelector('.cd-name').textContent).toBe('c');
    // the Rendered/Source toggle (a later callback) also lands in the same doc
    openCellDetail(makeApp(), 'html', 'String', '<b>hi</b>', childDoc);
    const bd2 = [...childDoc.querySelectorAll('.cd-backdrop')].at(-1);
    click(bd2.querySelectorAll('.cd-seg')[1]); // → Source
    expect(bd2.querySelector('.cd-pre').ownerDocument).toBe(childDoc);
  });
});

describe('cell-detail drawer resize (#101)', () => {
  it('sets the initial width from the persisted cellDrawerPx pref, and shows a handle', () => {
    const app = makeApp();
    app.state.cellDrawerPx = 640;
    openCellDetail(app, 'c', 'String', 'x');
    const panel = document.querySelector('.cd-panel');
    expect(panel.style.width).toBe('640px');
    expect(panel.querySelector('.cd-resize-h')).not.toBeNull();
    panel.closest('.cd-backdrop').remove();
  });
  it('clamps the initial width to [320, 92vw] (window.innerWidth = 1024 under happy-dom)', () => {
    const tooNarrow = makeApp();
    tooNarrow.state.cellDrawerPx = 100;
    openCellDetail(tooNarrow, 'c', 'String', 'x');
    expect(document.querySelector('.cd-panel').style.width).toBe('320px');
    document.querySelector('.cd-backdrop').remove();

    const tooWide = makeApp();
    tooWide.state.cellDrawerPx = 5000;
    openCellDetail(tooWide, 'c', 'String', 'x');
    expect(document.querySelector('.cd-panel').style.width).toBe(1024 * 0.92 + 'px');
    document.querySelector('.cd-backdrop').remove();
  });
  it('dragging the handle resizes the panel and persists the width on mouseup', () => {
    const app = makeApp();
    openCellDetail(app, 'c', 'String', 'x');
    const panel = document.querySelector('.cd-panel');
    const handle = panel.querySelector('.cd-resize-h');
    handle.dispatchEvent(new MouseEvent('mousedown', { clientX: 700, bubbles: true }));
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 500 })); // 1024-500
    expect(panel.style.width).toBe('524px');
    window.dispatchEvent(new MouseEvent('mouseup', {}));
    expect(app.state.cellDrawerPx).toBe(524);
    expect(app.savePref).toHaveBeenCalledWith('cellDrawerPx', 524);
    document.querySelector('.cd-backdrop').remove();
  });
  it('clamps mid-drag width to [320, 92vw]', () => {
    const app = makeApp();
    openCellDetail(app, 'c', 'String', 'x');
    const panel = document.querySelector('.cd-panel');
    const handle = panel.querySelector('.cd-resize-h');
    handle.dispatchEvent(new MouseEvent('mousedown', { clientX: 700, bubbles: true }));
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 2000 })); // 1024-2000 < 0 → floor
    expect(panel.style.width).toBe('320px');
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: -2000 })); // way over → 92vw cap
    expect(panel.style.width).toBe(1024 * 0.92 + 'px');
    window.dispatchEvent(new MouseEvent('mouseup', {}));
    document.querySelector('.cd-backdrop').remove();
  });
  it('finishing a resize drag with the mouse over the backdrop does not close the drawer; a later genuine click still does', () => {
    const app = makeApp();
    openCellDetail(app, 'c', 'String', 'x');
    const backdrop = document.querySelector('.cd-backdrop');
    const handle = backdrop.querySelector('.cd-resize-h');
    handle.dispatchEvent(new MouseEvent('mousedown', { clientX: 700, bubbles: true }));
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 500 }));
    window.dispatchEvent(new MouseEvent('mouseup', {}));
    // The browser follows a drag's mouseup with a `click` targeting the nearest
    // common ancestor of the mousedown/mouseup targets — here, since mouseup
    // landed outside `.cd-panel`, that's the backdrop itself. attachBackdropClose
    // (#110) gates close() on the mousedown target (the handle, inside the
    // panel), so this click alone does not close it.
    backdrop.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(document.querySelector('.cd-backdrop')).not.toBeNull(); // stays open
    backdropClick(backdrop); // a later, genuine backdrop click still closes it
    expect(document.querySelector('.cd-backdrop')).toBeNull();
  });
  it('closing the drawer mid-drag (Escape, mouse still down) cancels the drag: reverts the width, and does not leak listeners that swallow a later click or persist a stale width on a later mouseup', () => {
    const app = makeApp();
    app.state.cellDrawerPx = 560;
    openCellDetail(app, 'c', 'String', 'x');
    const handle = document.querySelector('.cd-resize-h');
    handle.dispatchEvent(new MouseEvent('mousedown', { clientX: 700, bubbles: true }));
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 500 })); // mid-drag, no mouseup yet
    expect(app.state.cellDrawerPx).toBe(524);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); // closes while still dragging
    expect(document.querySelector('.cd-backdrop')).toBeNull();
    expect(app.state.cellDrawerPx).toBe(560); // reverted — the abandoned drag never committed

    // The drag's own mousemove/mouseup listeners must have been torn down by
    // the cancel, not just left to resolve later.
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 100 }));
    window.dispatchEvent(new MouseEvent('mouseup', {}));
    expect(app.state.cellDrawerPx).toBe(560); // a stray mouseup doesn't resurrect + persist the drag
    expect(app.savePref).not.toHaveBeenCalledWith('cellDrawerPx', expect.anything());

    openCellDetail(app, 'c2', 'String', 'y'); // an unrelated, later click must work normally
    const backdrop2 = document.querySelector('.cd-backdrop');
    backdropClick(backdrop2);
    expect(document.querySelector('.cd-backdrop')).toBeNull();
  });
});

describe('expandDataPane', () => {
  const makeWin = () => {
    const childDoc = document.implementation.createHTMLDocument('');
    const ls = {};
    return {
      document: childDoc, closed: false,
      close: vi.fn(), focus: vi.fn(),
      addEventListener: (t, fn) => { ls[t] = fn; },
      fire: (t) => ls[t] && ls[t](),
    };
  };

  it('overlay fallback: shows the row count, a sortable/copyable grid snapshot, and Copy calls copySnapshot', () => {
    const app = makeApp();
    const r = tableResult();
    expandDataPane(app, r);
    const overlay = document.querySelector('.graph-overlay');
    expect(overlay).not.toBeNull();
    expect(overlay.querySelector('.data-pane-body')).not.toBeNull();
    expect(overlay.textContent).toContain('2 rows');
    expect(overlay.querySelectorAll('.res-table tbody tr')).toHaveLength(2);
    const copyBtn = [...overlay.querySelectorAll('.res-act')].find((b) => b.textContent.includes('Copy'));
    click(copyBtn);
    expect(app.actions.copySnapshot).toHaveBeenCalledWith(r, document);
    // sort is local to the snapshot: clicking a header re-sorts just this grid
    const th = overlay.querySelectorAll('.res-table thead th')[1]; // column 'n'
    click(th);
    const firstRowFirstCell = overlay.querySelector('.res-table tbody tr td.cell');
    expect(firstRowFirstCell.textContent).toBe('1'); // ascending on 'n' → '1' before '2'
  });

  it('clicking a cell in the overlay snapshot opens the cell-detail drawer in the same document', () => {
    const app = makeApp();
    expandDataPane(app, tableResult());
    const overlay = document.querySelector('.graph-overlay');
    click(overlay.querySelectorAll('.res-table tbody td.cell')[0]);
    expect(document.querySelector('.cd-backdrop')).not.toBeNull();
  });

  it('real tab: builds the grid + toolbar in the child document, Copy targets that document', () => {
    const win = makeWin();
    const app = makeApp({ openWindow: () => win });
    const r = tableResult();
    expandDataPane(app, r);
    expect(win.document.querySelector('.data-pane-body')).not.toBeNull();
    expect(win.document.querySelectorAll('.res-table tbody tr')).toHaveLength(2);
    const copyBtn = [...win.document.querySelectorAll('.res-act')].find((b) => b.textContent.includes('Copy'));
    click(copyBtn);
    expect(app.actions.copySnapshot).toHaveBeenCalledWith(r, win.document);
    // a cell click inside the tab opens the drawer in the TAB's document, not the main one
    click(win.document.querySelectorAll('.res-table tbody td.cell')[0]);
    expect(win.document.querySelector('.cd-backdrop')).not.toBeNull();
    expect(document.querySelector('.cd-backdrop')).toBeNull();
  });

  it('does not repaint when the main app renders a new result: no signal/effect wiring ties the two together', () => {
    const app = makeApp();
    const r1 = tableResult();
    expandDataPane(app, r1);
    const overlay = document.querySelector('.graph-overlay');
    expect(overlay.querySelectorAll('.res-table tbody tr')).toHaveLength(2);
    // the main app moves on to a brand-new result (a fresh query run) — the
    // already-open snapshot has no subscription to react to it.
    app.activeTab().result = tableResult();
    renderResults(app);
    expect(document.querySelectorAll('.graph-overlay')).toHaveLength(1); // still just the one snapshot
    expect(overlay.querySelectorAll('.res-table tbody tr')).toHaveLength(2); // unchanged
  });

  it('overlay: ✕ sits last in the title bar, closes on Escape (or backdrop), but not while a cell drawer is open', () => {
    const app = makeApp();
    expandDataPane(app, tableResult());
    const overlay = document.querySelector('.graph-overlay');
    const barChildren = [...overlay.querySelector('.graph-overlay-bar').children];
    expect(barChildren.at(-1).className).toBe('graph-overlay-close');
    click(overlay.querySelectorAll('.res-table tbody td.cell')[0]); // opens a cell drawer
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(document.querySelector('.cd-backdrop')).toBeNull(); // Escape closed the drawer first
    expect(document.body.contains(overlay)).toBe(true); // pane itself still open
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); // second Escape
    expect(document.body.contains(overlay)).toBe(false);
  });

  it('real tab: no ✕ button, and Escape is a no-op (browser tab-close serves that)', () => {
    const win = makeWin();
    const app = makeApp({ openWindow: () => win });
    expandDataPane(app, tableResult());
    expect(win.document.querySelector('.graph-overlay-close')).toBeNull();
    win.document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(win.document.body.contains(win.document.querySelector('.data-pane-body'))).toBe(true);
  });

  it('has the full Table/JSON/Chart switcher, same as the inline pane, scoped locally', () => {
    const app = makeApp();
    const r = chartResult();
    expandDataPane(app, r);
    const overlay = document.querySelector('.graph-overlay');
    const tabLabels = () => [...overlay.querySelectorAll('.result-view-tab')].map((b) => b.textContent);
    expect(tabLabels()).toEqual(['Table', 'JSON', 'Chart']);
    expect(overlay.querySelector('.result-view-tab.active').textContent).toBe('Table');

    // JSON
    click([...overlay.querySelectorAll('.result-view-tab')].find((b) => b.textContent === 'JSON'));
    expect(overlay.querySelector('.json-view')).not.toBeNull();
    expect(overlay.querySelector('.result-view-tab.active').textContent).toBe('JSON');
    expect(overlay.querySelector('.res-table')).toBeNull(); // grid torn down

    // Chart
    click([...overlay.querySelectorAll('.result-view-tab')].find((b) => b.textContent === 'Chart'));
    expect(overlay.querySelector('.chart-view canvas')).not.toBeNull();
    expect(overlay.querySelector('.result-view-tab.active').textContent).toBe('Chart');

    // switching away destroys the chart instance (no leaked canvas/observers)
    const chartBefore = overlay.querySelector('canvas');
    click([...overlay.querySelectorAll('.result-view-tab')].find((b) => b.textContent === 'Table'));
    expect(overlay.querySelector('canvas')).toBeNull();
    expect(overlay.querySelector('.res-table')).not.toBeNull();
    expect(chartBefore).not.toBeNull(); // sanity: we did have a canvas to lose
  });

  it("the snapshot's chart config is local — switching it never touches the live tab's own chartCfg/chartKey", () => {
    const app = makeApp();
    const r = chartResult();
    expandDataPane(app, r);
    const overlay = document.querySelector('.graph-overlay');
    click([...overlay.querySelectorAll('.result-view-tab')].find((b) => b.textContent === 'Chart'));
    const typeSelect = overlay.querySelector('.chart-config select');
    typeSelect.value = 'pie';
    typeSelect.dispatchEvent(new Event('change', { bubbles: true }));
    expect(overlay.querySelector('.chart-view canvas')).not.toBeNull(); // re-rendered locally, no throw
    expect(app.activeTab().chartCfg).toBeNull(); // the live tab's own config is untouched
    expect(app.chart).toBeNull(); // the snapshot's chart never occupies the shared app.chart slot
  });

  it('running a new query in the main tab does not blank the snapshot\'s Chart view', () => {
    const app = makeApp();
    const r = chartResult();
    expandDataPane(app, r);
    const overlay = document.querySelector('.graph-overlay');
    app.state.running.value = true; // a different, unrelated query starts in the main window
    click([...overlay.querySelectorAll('.result-view-tab')].find((b) => b.textContent === 'Chart'));
    expect(overlay.querySelector('.chart-view canvas')).not.toBeNull(); // not the "renders when complete" placeholder
    expect(overlay.textContent).not.toContain('renders when the query completes');
  });

  it('closing the overlay while on Chart view destroys the chart instance (teardown)', () => {
    const app = makeApp();
    const instances = [];
    const RealChart = app.Chart;
    app.Chart = class extends RealChart { constructor(...args) { super(...args); instances.push(this); } };
    const r = chartResult();
    expandDataPane(app, r);
    const overlay = document.querySelector('.graph-overlay');
    click([...overlay.querySelectorAll('.result-view-tab')].find((b) => b.textContent === 'Chart'));
    expect(instances).toHaveLength(1);
    expect(instances[0].destroyed).toBe(false);
    overlay.querySelector('.graph-overlay-close').dispatchEvent(new Event('click', { bubbles: true }));
    expect(document.querySelector('.graph-overlay')).toBeNull();
    expect(instances[0].destroyed).toBe(true);
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
  it('switching chart type re-slices to the new type\'s cap and updates the note', () => {
    const r = newResult('Table');
    r.columns = [{ name: 'k', type: 'String' }, { name: 'v', type: 'UInt64' }];
    r.rows = Array.from({ length: 600 }, (_, i) => ['k' + i, String(i)]);
    r.progress = { rows: 600, bytes: 100, elapsed_ns: 5e6 };
    const app = appWithResult(r, { resultView: 'chart' });
    renderResults(app);
    // default (hbar, autoChart's categorical pick) cap is 500 < 600 rows
    expect(app.activeTab().chartCfg.type).toBe('hbar');
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
  it("forces an explicit resize + 'resize'-mode update once attached, working around Chart.js's cross-window responsive sizing", async () => {
    const app = appWithResult(chartResult(), { resultView: 'chart' });
    renderResults(app);
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
    renderResults(app);
    const chart = app.chart;
    await new Promise((resolve) => window.requestAnimationFrame(resolve)); // offsetWidth/Height are 0 in happy-dom by default
    expect(chart.lastResize).toBeUndefined();
    expect(chart.lastUpdateMode).toBeUndefined();
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
    backdropClick(overlay); // backdrop click closes + cleans up
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
    backdropClick(backdrop);
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

  it('openRowsViewer gets the same resizable drawer as openCellDetail (#101)', () => {
    const app = makeApp();
    app.state.cellDrawerPx = 700;
    openRowsViewer(app, { columns: [{ name: 'x', type: 'String' }], rows: [['a']] });
    const panel = document.querySelector('.cd-panel');
    expect(panel.style.width).toBe('700px');
    const handle = panel.querySelector('.cd-resize-h');
    expect(handle).not.toBeNull();
    handle.dispatchEvent(new MouseEvent('mousedown', { clientX: 700, bubbles: true }));
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 500 })); // 1024-500
    expect(panel.style.width).toBe('524px');
    window.dispatchEvent(new MouseEvent('mouseup', {}));
    expect(app.state.cellDrawerPx).toBe(524);
    document.querySelector('.cd-backdrop').remove();
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

describe('script-export log pane (#99)', () => {
  const scriptExportResult = (over = {}) => ({
    elapsedMs: 42,
    startedAt: 0,
    scriptExport: [
      { i: 0, sql: 'CREATE TABLE t (a Int8)', type: 'effect', status: 'ok', file: null, bytes: 0, startedAt: 0, ms: 5, error: null },
      { i: 1, sql: 'SELECT * FROM t', type: 'rows', status: 'exporting', file: '002-t.tsv', bytes: 1024, startedAt: 0, ms: null, error: null },
      {
        i: 2, sql: 'SELECT 2', type: 'rows', status: 'failed', file: '003-select-2.tsv', bytes: 0, startedAt: 0, ms: 3,
        error: 'File may be incomplete; server failed after streaming started. boom',
      },
    ],
    ...over,
  });

  it('renders the column headers and one row per statement with #, type, status, file, bytes, time', () => {
    const app = appWithResult(scriptExportResult());
    renderResults(app);
    const region = app.dom.resultsRegion;
    expect(region.querySelector('.script-export-grid')).not.toBeNull();
    expect([...region.querySelectorAll('thead th')].map((th) => th.textContent.trim()))
      .toEqual(['#', 'Statement', 'Type', 'Status', 'File', 'Bytes', 'Time']);
    const rows = [...region.querySelectorAll('tbody tr')];
    expect(rows).toHaveLength(3);
    expect(rows[0].querySelector('.se-num').textContent).toBe('1');
    expect(rows[0].querySelector('.se-sql .cell-val').textContent).toBe('CREATE TABLE t (a Int8)');
    expect(rows[0].querySelector('.se-type').textContent).toBe('effect');
    expect(rows[0].querySelector('.se-status-cell').textContent).toBe('ok');
    expect(rows[0].querySelector('.se-file').textContent).toBe('');
    expect(rows[0].querySelector('.se-bytes').textContent).toBe(''); // effect statements never show bytes
    expect(rows[0].querySelector('.se-time').textContent).toBe('5 ms');
  });

  it('shows the file name and formatted bytes for a row-returning statement', () => {
    const app = appWithResult(scriptExportResult());
    renderResults(app);
    const rows = [...app.dom.resultsRegion.querySelectorAll('tbody tr')];
    expect(rows[1].querySelector('.se-file').textContent).toBe('002-t.tsv');
    expect(rows[1].querySelector('.se-bytes').textContent).toBe('1.0 KB');
  });

  it('shows a live now()-startedAt time for the active row (no ms recorded yet)', () => {
    const app = appWithResult(scriptExportResult(), { running: false });
    app.now = () => 250;
    renderResults(app);
    const rows = [...app.dom.resultsRegion.querySelectorAll('tbody tr')];
    expect(rows[1].querySelector('.se-time').textContent).toBe('250 ms');
  });

  it('leaves the Time cell blank for a pending/skipped row with no ms and no startedAt', () => {
    const app = appWithResult(scriptExportResult({
      scriptExport: [{ i: 0, sql: 'SELECT 1', type: 'rows', status: 'skipped', file: null, bytes: 0, startedAt: null, ms: 0, error: null }],
    }));
    renderResults(app);
    expect(app.dom.resultsRegion.querySelector('tbody td.se-time').textContent).toBe('');
  });

  it('shows the inline error message on a failed row (including the mid-stream "incomplete" note)', () => {
    const app = appWithResult(scriptExportResult());
    renderResults(app);
    const rows = [...app.dom.resultsRegion.querySelectorAll('tbody tr')];
    expect(rows[2].querySelector('.se-status-cell').classList.contains('failed')).toBe(true);
    expect(rows[2].querySelector('.se-error').textContent).toContain('File may be incomplete');
  });

  it('toolbar shows the title, live elapsed + Cancel while exporting; Cancel calls cancelExportScript', () => {
    const app = appWithResult(scriptExportResult(), { exporting: true });
    app.now = () => 999;
    renderResults(app);
    const region = app.dom.resultsRegion;
    expect(region.querySelector('.res-graph-title').textContent).toContain('3 statements');
    expect(region.querySelector('.stat.live').textContent).toContain('999 ms');
    const cancel = region.querySelector('.cancel-act');
    expect(cancel).not.toBeNull();
    click(cancel);
    expect(app.actions.cancelExportScript).toHaveBeenCalled();
  });

  it('toolbar shows the total elapsed (no Cancel) once exporting finishes', () => {
    const app = appWithResult(scriptExportResult(), { exporting: false });
    renderResults(app);
    const region = app.dom.resultsRegion;
    expect(region.querySelector('.cancel-act')).toBeNull();
    expect(region.textContent).toContain('42 ms');
  });

  it('shows a cancelled badge when a statement was cancelled', () => {
    const app = appWithResult(scriptExportResult({
      scriptExport: [{ i: 0, sql: 'SELECT 1', type: 'rows', status: 'cancelled', file: null, bytes: 0, startedAt: 0, ms: 1, error: null }],
    }), { exporting: false });
    renderResults(app);
    expect(app.dom.resultsRegion.querySelector('.cancelled-badge')).not.toBeNull();
  });

  it('handles a single-statement label without an "s"', () => {
    const app = appWithResult(scriptExportResult({
      scriptExport: [{ i: 0, sql: 'SELECT 1', type: 'rows', status: 'ok', file: '001-select-1.tsv', bytes: 10, startedAt: 0, ms: 1, error: null }],
    }));
    renderResults(app);
    expect(app.dom.resultsRegion.querySelector('.res-graph-title').textContent).toContain('1 statement');
    expect(app.dom.resultsRegion.querySelector('.res-graph-title').textContent).not.toContain('1 statements');
  });

  it('columns are drag-resizable, keyed by plain index (7 handles, freeze-on-first-drag)', () => {
    const r = scriptExportResult(); // no colWidths → freeze path
    const app = appWithResult(r);
    renderResults(app);
    const region = app.dom.resultsRegion;
    const handles = region.querySelectorAll('.script-export-grid th .col-resize-h');
    expect(handles).toHaveLength(7);
    const win = handles[0].ownerDocument.defaultView;
    handles[0].dispatchEvent(new MouseEvent('mousedown', { clientX: 100, bubbles: true }));
    expect(region.querySelector('.script-export-grid .res-table').classList.contains('fixed')).toBe(true);
    expect(Object.keys(r.colWidths).sort()).toEqual(['0', '1', '2', '3', '4', '5', '6']);
    win.dispatchEvent(new MouseEvent('mousemove', { clientX: 110 }));
    win.dispatchEvent(new MouseEvent('mouseup', {}));
    // clicking the handle itself (not dragging) must not also trigger a column sort/toggle.
    click(handles[1]);
  });

  it('reapplies stored script-export-grid widths on re-render', () => {
    const app = appWithResult(scriptExportResult({ colWidths: { 0: 40, 1: 200, 2: 60, 3: 60, 4: 100, 5: 60, 6: 60 } }));
    renderResults(app);
    const cells = app.dom.resultsRegion.querySelectorAll('.script-export-grid thead th');
    expect(cells[0].style.width).toBe('40px');
    expect(cells[6].style.width).toBe('60px');
  });
});
