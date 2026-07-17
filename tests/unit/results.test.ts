import { describe, it, expect, vi } from 'vitest';
import {
  renderResults, renderJson, renderTable, openCellDetail, openRowsViewer, expandDataPane,
} from '../../src/ui/results.js';
import type {
  QueryResult, ScriptResult, ScriptExportResult, ScriptEntry, ScriptExportEntry,
} from '../../src/ui/results.js';
import { makeApp } from '../helpers/fake-app.js';
import type { FakeChart } from '../helpers/fake-app.js';
import { newResult as newResultUntyped } from '../../src/core/stream.js';
import { formatRows } from '../../src/core/format.js';
import { queryPanel } from '../../src/core/saved-query.js';
import type { AppState, ResultSort } from '../../src/state.js';
import type { App } from '../../src/ui/app.types.js';

// tests/helpers/fake-app.js's `makeApp()` is a long-standing untyped test
// double implementing exactly the members results.ts's own narrow `ResultsApp`
// contract reads — no cast needed on either side (results.ts's own doc
// comment on `ResultsApp`), so every `app`/`appWithResult(...)` fixture below
// is used as-is, typed by inference from `makeApp()`'s real return shape.
type FakeApp = ReturnType<typeof makeApp>;

// QueryTab.result (state.ts) holds this as an opaque `Record<string, unknown>`
// (only results.ts knows the concrete shape, via its own `Result` union) — the
// index signature lets a real QueryResult/ScriptResult/ScriptExportResult
// fixture assign straight into `tab.result` without a further cast, same
// convention panels.test.ts established for its own StreamResult wrapper.
type Indexed<T> = T & Record<string, unknown>;

// core/stream.ts's own `newResult` returns a plain `StreamResult` (no index
// signature, and none of results.ts's own extra QueryResult fields) — every
// fixture below assigns those extra fields (`.source`, `.explainView`, …) and
// needs to flow straight into `tab.result`, so this thin wrapper casts once
// (same convention panels.test.ts established for its own StreamResult wrapper).
const newResult = (fmt: string, rowLimit = 0): Indexed<QueryResult> => newResultUntyped(fmt, rowLimit) as Indexed<QueryResult>;

const qs = <T extends Element = HTMLElement>(root: ParentNode, selector: string): T => root.querySelector(selector) as T;
const qsa = <T extends Element = HTMLElement>(root: ParentNode, selector: string): T[] =>
  [...root.querySelectorAll(selector)] as T[];

// `!`: every call site's element comes from a `querySelector`/`find`/array-index
// expression the surrounding test already asserts (or is about to assert) is
// present — a genuinely missing element still throws here, exactly as a plain
// `.dispatchEvent` on `undefined` always has.
const click = (el: Element | null | undefined): boolean => el!.dispatchEvent(new Event('click', { bubbles: true }));
// A genuine backdrop click: mousedown and click both land on `el` itself
// (#110's attachBackdropClose gates close() on where mousedown landed).
const backdropClick = (el: Element | null | undefined): void => {
  el!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  el!.dispatchEvent(new Event('click', { bubbles: true }));
};

// The only state fields any call site below overrides — spelled out rather
// than a generic by-name reflection loop, so every write stays genuinely typed
// (no `Record<string, unknown>` cast of `AppState` itself, which lacks an
// index signature).
interface StateOverride {
  running?: boolean;
  resultView?: 'table' | 'json' | 'panel' | 'filter';
  resultSort?: ResultSort;
  resultRowLimit?: number;
  exporting?: boolean;
}

// `makeApp()`'s own generic `overrides` (fake-app.ts) keeps a passed mock's
// precise call-site type (e.g. a real `runReadInto` 2-arg spy) directly
// readable off the returned fixture — `.mock.calls[...]` reads below rely on
// that.
type RunReadIntoResult = Parameters<App['runReadInto']>[0];
type RunReadIntoOpts = Parameters<App['runReadInto']>[1];

function appWithResult(result: Record<string, unknown> | null, over: StateOverride = {}): FakeApp {
  const app = makeApp();
  app.activeTab().result = result;
  // Signal-aware assign: resultView/running/exporting are signals — write
  // through .value; resultSort/resultRowLimit are plain fields.
  if (over.running !== undefined) app.state.running.value = over.running;
  if (over.resultView !== undefined) app.state.resultView.value = over.resultView;
  if (over.resultSort !== undefined) app.state.resultSort = over.resultSort;
  if (over.resultRowLimit !== undefined) app.state.resultRowLimit = over.resultRowLimit;
  if (over.exporting !== undefined) app.state.exporting.value = over.exporting;
  return app;
}

function tableResult(): Indexed<QueryResult> {
  const r: Indexed<QueryResult> = newResult('Table');
  r.columns = [{ name: 'n', type: 'UInt64' }, { name: 's', type: 'String' }];
  r.rows = [['2', 'b'], ['1', null]];
  r.progress = { rows: 2, bytes: 100, elapsed_ns: 5e6 };
  // #185: the captured source (no params here → detached view is a snapshot
  // with no filter row; the interactive-rerun cases build their own with params).
  r.source = { sql: 'SELECT n, s FROM t', tabId: 't1', rowLimit: 0, title: 'My data', description: '' };
  return r;
}

describe('renderResults states', () => {
  it('no-ops without a region', () => {
    const app = makeApp();
    // `as`: fake-app.js's `dom.resultsRegion` is a real HTMLDivElement in the
    // fixture literal (never null in practice) — this test exercises the
    // defensive `if (!region) return;` guard renderResults itself keeps.
    (app.dom as { resultsRegion: HTMLDivElement | null }).resultsRegion = null;
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
    expect(qs(region, '.stream-strip .fill')).not.toBeNull(); // pct>0 → determinate
    expect(region.textContent).toContain('Starting query…');
    expect(region.textContent).not.toMatch(/null/i); // regression: no "Loading/Streaming null"
    // live counters (rows/bytes) + Cancel in the toolbar
    expect(region.textContent).toContain('10 rows');
    const cancel = qs(region, '.cancel-act');
    expect(cancel).not.toBeNull();
    click(cancel);
    expect(app.actions.cancel).toHaveBeenCalled();
  });
  it('streaming-blank with no result object uses an indeterminate sweep', () => {
    const app = appWithResult(null, { running: true });
    renderResults(app);
    expect(qs(app.dom.resultsRegion, '.stream-strip .sweep')).not.toBeNull();
    expect(app.dom.resultsRegion.textContent).toContain('Starting query…');
  });
  it('renders an error', () => {
    const r = newResult('Table');
    r.error = 'DB::Exception: boom';
    renderResults(appWithResult(r));
    // toolbar present + error body
    const app = appWithResult(r);
    renderResults(app);
    expect(qs(app.dom.resultsRegion, '.results-error').textContent).toContain('boom');
  });
  it('renders raw text + a single raw view tab', () => {
    const r = newResult('TSV');
    r.rawText = 'a\tb\n1\t2';
    const app = appWithResult(r);
    renderResults(app);
    expect(qs(app.dom.resultsRegion, '.raw-text-view').textContent).toContain('a\tb');
    expect(qsa(app.dom.resultsRegion, '.result-view-tab')).toHaveLength(1);
  });
  it('raw JSON view uses the json icon label', () => {
    const r = newResult('JSON');
    r.rawText = '{"x":1}';
    const app = appWithResult(r);
    renderResults(app);
    expect(qs(app.dom.resultsRegion, '.result-view-tab').textContent).toContain('JSON');
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
    expect(qsa(app.dom.resultsRegion, '.res-table tbody tr')).toHaveLength(2);
    expect(qs(app.dom.resultsRegion, '.stream-strip')).not.toBeNull();
  });
  it('a cancelled result shows the "Cancelled · partial" badge with Copy/Export', () => {
    const r = tableResult();
    r.cancelled = true;
    const app = appWithResult(r, { resultView: 'table' });
    renderResults(app);
    const region = app.dom.resultsRegion;
    expect(qs(region, '.cancelled-badge').textContent).toContain('Cancelled · partial');
    expect([...qsa(region, '.res-act')].some((b) => /Copy/.test(b.textContent))).toBe(true);
  });
  it('json view', () => {
    const app = appWithResult(tableResult(), { resultView: 'json' });
    renderResults(app);
    expect(qs(app.dom.resultsRegion, '.json-view').textContent).toContain('"n": "2"');
  });
  it('panel view renders its picker in the toolbar + auto preview', () => {
    const app = appWithResult(tableResult(), { resultView: 'panel' });
    renderResults(app);
    const region = app.dom.resultsRegion;
    expect(qs(region, '.panel-view')).not.toBeNull();
    expect(qs(region, '.result-panel-select')).not.toBeNull();
    expect(qs(region, '.panel-config')).toBeNull(); // no redundant full-width picker row
    expect(qs(region, '.chart-view canvas')).not.toBeNull();   // autoPanel picked a chart
    expect(queryPanel(app.activeTab())).toBeUndefined(); // preview never writes the tab spec
  });
  it('panel view with no result shows the run hint (query-backed types need a Run)', () => {
    const app = appWithResult(null, { resultView: 'panel' });
    renderResults(app);
    expect(app.dom.resultsRegion.textContent).toContain('Run the query');
  });
  it('clicking a view tab switches the view', () => {
    const app = appWithResult(tableResult(), { resultView: 'table' });
    renderResults(app);
    const jsonTab = [...qsa(app.dom.resultsRegion, '.result-view-tab')].find((b) => b.textContent!.includes('JSON'));
    click(jsonTab);
    expect(app.state.resultView.value).toBe('json');
  });
  it('renders the Filter preview in the results area when the view is filter', () => {
    const app = appWithResult(tableResult(), { resultView: 'filter' });
    app.activeTab().filterPreview = {
      status: 'success',
      normalized: {
        helpers: [{ name: 'kind', options: [{ value: 'a', label: 'Alpha' }], totalOptions: 1, sourceType: 'Array(String)', truncated: false }],
        diagnostics: [],
      },
    };
    renderResults(app);
    // The drawer shows the filter preview (its own container), not the raw
    // result table — reached via the panel picker / run(), no dedicated tab.
    expect(qs(app.dom.resultsRegion, '.filter-preview')).toBeTruthy();
    expect(app.dom.resultsRegion.textContent).toContain('kind');
    expect([...qsa(app.dom.resultsRegion, '.result-view-tab')].map((b) => b.textContent)
      .some((t) => t.includes('Filter'))).toBe(false); // no Filter view tab
  });
});

describe('renderTable', () => {
  it('sorts ascending then toggles to descending via header click', () => {
    const app = appWithResult(tableResult());
    renderResults(app);
    const th = qsa(app.dom.resultsRegion, '.res-table th')[1]; // column 'n'
    click(th);
    expect(app.state.resultSort).toEqual({ col: 0, dir: 'asc' });
    const th2 = qsa(app.dom.resultsRegion, '.res-table th')[1];
    click(th2);
    expect(app.state.resultSort.dir).toBe('desc');
    const th3 = qsa(app.dom.resultsRegion, '.res-table th')[1];
    click(th3); // desc → asc
    expect(app.state.resultSort.dir).toBe('asc');
  });
  it('renders the active sort indicator and numeric cell class', () => {
    const app = appWithResult(tableResult(), { resultSort: { col: 0, dir: 'asc' } });
    const el = renderTable(app, app.activeTab().result as Indexed<QueryResult>);
    expect(qs(el, '.h-sort')).not.toBeNull();
    expect(qs(el, 'td.num')).not.toBeNull();
  });
  it('a header click re-sorts and re-renders the live pane (used by the EXPLAIN estimate table)', () => {
    const app = appWithResult(tableResult());
    const el = renderTable(app, app.activeTab().result as Indexed<QueryResult>);
    document.body.appendChild(el);
    click(qsa(el, '.res-table th')[1]); // column 'n' → setSort + rerender(renderResults)
    expect(app.state.resultSort).toEqual({ col: 0, dir: 'asc' });
    el.remove();
  });
  it('the Expand + Copy buttons in the footer are present, Copy fires its action', () => {
    const app = appWithResult(tableResult());
    renderResults(app);
    const acts = [...qsa(app.dom.resultsRegion, '.res-act')];
    expect(acts.map((b) => b.textContent)).toEqual(['Expand', 'Copy']);
    click(acts[1]);
    expect(app.actions.copyResult).toHaveBeenCalled();
    click(acts[0]); // Expand opens the detached Data pane (overlay fallback here)
    expect(qs(document, '.graph-overlay .data-pane-body')).not.toBeNull();
    // Close for real (Escape) so the pane's own keydown listener detaches too.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(qs(document, '.graph-overlay')).toBeNull();
  });
  it('no Copy button on an error result', () => {
    const r = newResult('Table');
    r.error = 'boom';
    const app = appWithResult(r);
    renderResults(app);
    expect(qsa(app.dom.resultsRegion, '.res-act')).toHaveLength(0);
  });
  it('no Expand button for raw text output (Copy still shows)', () => {
    const r = newResult('TSV');
    r.rawText = 'a\tb\n1\t2';
    const app = appWithResult(r);
    renderResults(app);
    const acts = [...qsa(app.dom.resultsRegion, '.res-act')];
    expect(acts.map((b) => b.textContent)).toEqual(['Copy']);
  });
  it('no Expand button for a 0-row result (Copy still shows)', () => {
    const r = tableResult();
    r.rows = [];
    const app = appWithResult(r);
    renderResults(app);
    const acts = [...qsa(app.dom.resultsRegion, '.res-act')];
    expect(acts.map((b) => b.textContent)).toEqual(['Copy']);
  });
  it('header shows column names only, with the type as a hover tooltip', () => {
    const el = renderTable(appWithResult(tableResult()), tableResult());
    const ths = qsa(el, 'thead th');
    expect(qs(ths[1], '.h-name').textContent).toBe('n');
    expect(qs(el, '.h-type')).toBeNull();
    expect(ths[1].textContent).not.toContain('UInt64'); // type not rendered inline
    expect(ths[1].getAttribute('title')).toBe('UInt64'); // exposed on hover
    expect(ths[2].getAttribute('title')).toBe('String');
  });
  it('data cells truncate (.cell-val) and open the detail drawer on click', () => {
    const app = appWithResult(tableResult());
    const el = renderTable(app, app.activeTab().result as Indexed<QueryResult>);
    const cell = qs(el, 'tbody td.cell');
    expect(qs(cell, '.cell-val')).not.toBeNull();
    click(cell);
    expect(qs(app.document, '.cd-backdrop')).not.toBeNull();
    qs(app.document, '.cd-backdrop').remove(); // cleanup
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
  it('renders the row-limit selector reflecting the current limit; changing it re-runs', () => {
    const app = appWithResult(tableResult(), { resultRowLimit: 1000 });
    renderResults(app);
    const sel = qs<HTMLSelectElement>(app.dom.resultsRegion, '.row-limit-select');
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
    expect(qs(app.dom.resultsRegion, '.row-limit-select')).toBeNull();
  });
  it('marks the Pipeline tab + graph Expand buttons so mobile CSS can hide them (#126)', () => {
    // Pipeline EXPLAIN view: exactly one tab carries the pipeline marker class,
    // and the pipeline "Expand" (fullscreen) button carries its own.
    const r = newResult('Table');
    r.explainView = 'pipeline';
    r.rawText = 'digraph{}';
    const app = appWithResult(r);
    renderResults(app);
    const region = app.dom.resultsRegion;
    expect(qsa(region, '.result-view-tab--pipeline')).toHaveLength(1);
    expect(qs(region, '.result-view-tab--pipeline').textContent).toContain('Pipeline');
    expect(qs(region, '.res-act--pipeline-expand')).not.toBeNull();
    // A schema-lineage result exposes its own Expand marker.
    const sg = newResult('Table');
    sg.schemaGraph = { focus: { kind: 'db', db: 'd' }, nodes: [{ id: 'd.t', label: 'd.t' }], edges: [] };
    const app2 = appWithResult(sg);
    renderResults(app2);
    expect(qs(app2.dom.resultsRegion, '.res-act--graph-expand')).not.toBeNull();
  });
  it('shows a "first N (capped)" badge when the result is capped, none otherwise', () => {
    const r = tableResult();
    r.rowLimit = 500;
    r.capped = true;
    const app = appWithResult(r);
    renderResults(app);
    const badge = qs(app.dom.resultsRegion, '.capped-badge');
    expect(badge.textContent).toBe('first 500 (capped)');
    // uncapped result → no badge
    renderResults(appWithResult(tableResult()));
    const app2 = appWithResult(tableResult());
    renderResults(app2);
    expect(qs(app2.dom.resultsRegion, '.capped-badge')).toBeNull();
  });
  it('renders rows up to the result row limit (display cap follows it)', () => {
    const r = newResult('Table', 10000);
    r.columns = [{ name: 'n', type: 'UInt64' }];
    r.rows = Array.from({ length: 6000 }, (_, i) => [String(i)]);
    const el = renderTable(makeApp(), r);
    expect(qsa(el, 'tbody tr')).toHaveLength(6000); // 6000 < 10000 → all shown
    expect(el.textContent).not.toContain('more rows truncated');
  });
});

// The grid mechanics (colResizeWidth math, the splitter model, renderGrid,
// renderGridView) are specced in grid-render.test.js (#167); these cover only
// the main table's WIRING: state lands in app.state.resultSort / r.colWidths
// and survives the renderResults repaint.
describe('column resize', () => {
  it('puts a resize handle on each data column; the handle does not sort', () => {
    const app = appWithResult(tableResult());
    renderResults(app);
    const handles = qsa(app.dom.resultsRegion, '.res-table th .col-resize-h');
    expect(handles).toHaveLength(2); // one per data column, none on the '#' column
    const before = { ...app.state.resultSort };
    handles[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(app.state.resultSort).toEqual(before); // stopPropagation → no sort
  });

  it('first drag freezes the layout (measures every column) and switches to fixed', () => {
    const app = appWithResult(tableResult());
    renderResults(app);
    const r = app.activeTab().result as Indexed<QueryResult>; // colWidths empty → freeze path
    const region = app.dom.resultsRegion;
    const handle = qsa(region, '.res-table th .col-resize-h')[0];
    handle.dispatchEvent(new MouseEvent('mousedown', { clientX: 200, bubbles: true }));
    const table = qs(region, '.res-table');
    expect(table.classList.contains('fixed')).toBe(true);
    expect(Object.keys(r.colWidths!).sort()).toEqual(['0', '1', 'idx']); // every column measured
    handle.ownerDocument.defaultView!.dispatchEvent(new MouseEvent('mouseup', {}));
  });

  it('reapplies stored widths on re-render (survives sort / streaming)', () => {
    const r = tableResult();
    r.colWidths = { idx: 36, 0: 90, 1: 70 };
    const app = appWithResult(r);
    renderResults(app);
    const table = qs(app.dom.resultsRegion, '.res-table');
    expect(table.classList.contains('fixed')).toBe(true);
    const cells = qsa(table, 'thead th');
    expect(cells[1].style.width).toBe('90px');
    expect(cells[2].style.width).toBe('70px');
    expect(table.style.width).toBe('196px'); // 36 + 90 + 70
  });
});

describe('openCellDetail', () => {
  it('text value → pretty <pre>, no toggle; closes via ✕', () => {
    const app = makeApp();
    openCellDetail(app, 'col', 'String', '{"a":1}');
    const bd = qs(document, '.cd-backdrop');
    expect(bd).not.toBeNull();
    expect(qs(bd, '.cd-name').textContent).toBe('col');
    expect(qs(bd, '.cd-type').textContent).toBe('String');
    expect(qs(bd, '.cd-pre').textContent).toBe('{\n  "a": 1\n}');
    expect(qs(bd, '.cd-toggle')).toBeNull();
    click(qs(bd, '.cd-close'));
    expect(qs(document, '.cd-backdrop')).toBeNull();
  });
  it('null value + no type → empty pre, no type chip', () => {
    openCellDetail(makeApp(), 'c', '', null);
    const bd = qs(document, '.cd-backdrop');
    expect(qs(bd, '.cd-type')).toBeNull();
    expect(qs(bd, '.cd-pre').textContent).toBe('');
    bd.remove();
  });
  it('HTML value → Rendered (sandboxed iframe srcdoc) ↔ Source toggle', () => {
    openCellDetail(makeApp(), 'html', 'String', '<b>hi</b>');
    const bd = qs(document, '.cd-backdrop');
    expect([...qsa(bd, '.cd-seg')].map((s) => s.textContent)).toEqual(['Rendered', 'Source']);
    const frame = qs(bd, 'iframe.cd-frame');
    expect(frame.getAttribute('sandbox')).toBe('');
    expect(frame.getAttribute('srcdoc')).toBe('<b>hi</b>');
    click(qsa(bd, '.cd-seg')[1]); // → Source
    expect(qs(bd, 'iframe')).toBeNull();
    expect(qs(bd, '.cd-pre').textContent).toBe('<b>hi</b>');
    click(qsa(bd, '.cd-seg')[0]); // → Rendered again
    expect(qs(bd, 'iframe.cd-frame')).not.toBeNull();
    bd.remove();
  });
  it('Escape closes; backdrop click closes; panel click does not', () => {
    const app = makeApp();
    openCellDetail(app, 'c', 'String', 'x');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(qs(document, '.cd-backdrop')).toBeNull();
    openCellDetail(app, 'c', 'String', 'x');
    backdropClick(qs(document, '.cd-backdrop'));
    expect(qs(document, '.cd-backdrop')).toBeNull();
    openCellDetail(app, 'c', 'String', 'x');
    backdropClick(qs(document, '.cd-panel')); // mousedown+click inside the panel → stays open
    expect(qs(document, '.cd-backdrop')).not.toBeNull();
    qs(document, '.cd-backdrop').remove();
  });
  it('a gesture starting inside the panel and ending (mouseup/click) on the backdrop does not close it (#110)', () => {
    const app = makeApp();
    openCellDetail(app, 'c', 'String', 'a selectable value');
    const backdrop = qs(document, '.cd-backdrop');
    const pre = qs(backdrop, '.cd-pre');
    pre.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); // drag starts inside the panel
    // The click that follows targets the backdrop directly — the nearest
    // common ancestor of the mousedown (inside .cd-pre) and mouseup targets.
    backdrop.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(qs(document, '.cd-backdrop')).not.toBeNull();
    backdropClick(backdrop); // a later, genuine backdrop click still closes it
    expect(qs(document, '.cd-backdrop')).toBeNull();
  });
  it('builds in a given targetDoc instead of the main document (detached-tab safe)', () => {
    const childDoc = document.implementation.createHTMLDocument('');
    openCellDetail(makeApp(), 'c', 'String', 'x', childDoc);
    expect(qs(document, '.cd-backdrop')).toBeNull(); // not in the main document
    const bd = qs(childDoc, '.cd-backdrop');
    expect(bd).not.toBeNull();
    expect(qs(bd, '.cd-name').textContent).toBe('c');
    // the Rendered/Source toggle (a later callback) also lands in the same doc
    openCellDetail(makeApp(), 'html', 'String', '<b>hi</b>', childDoc);
    const bd2 = [...qsa(childDoc, '.cd-backdrop')].at(-1)!;
    click(qsa(bd2, '.cd-seg')[1]); // → Source
    expect(qs(bd2, '.cd-pre').ownerDocument).toBe(childDoc);
  });
});

describe('cell-detail drawer resize (#101)', () => {
  it('sets the initial width from the persisted cellDrawerPx pref, and shows a handle', () => {
    const app = makeApp();
    app.state.cellDrawerPx = 640;
    openCellDetail(app, 'c', 'String', 'x');
    const panel = qs(document, '.cd-panel');
    expect(panel.style.width).toBe('640px');
    expect(qs(panel, '.cd-resize-h')).not.toBeNull();
    panel.closest('.cd-backdrop')!.remove();
  });
  it('clamps the initial width to [320, 92vw] (window.innerWidth = 1024 under happy-dom)', () => {
    const tooNarrow = makeApp();
    tooNarrow.state.cellDrawerPx = 100;
    openCellDetail(tooNarrow, 'c', 'String', 'x');
    expect(qs(document, '.cd-panel').style.width).toBe('320px');
    qs(document, '.cd-backdrop').remove();

    const tooWide = makeApp();
    tooWide.state.cellDrawerPx = 5000;
    openCellDetail(tooWide, 'c', 'String', 'x');
    expect(qs(document, '.cd-panel').style.width).toBe(1024 * 0.92 + 'px');
    qs(document, '.cd-backdrop').remove();
  });
  it('dragging the handle resizes the panel and persists the width on mouseup', () => {
    const app = makeApp();
    openCellDetail(app, 'c', 'String', 'x');
    const panel = qs(document, '.cd-panel');
    const handle = qs(panel, '.cd-resize-h');
    handle.dispatchEvent(new MouseEvent('mousedown', { clientX: 700, bubbles: true }));
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 500 })); // 1024-500
    expect(panel.style.width).toBe('524px');
    window.dispatchEvent(new MouseEvent('mouseup', {}));
    expect(app.state.cellDrawerPx).toBe(524);
    expect(app.savePref).toHaveBeenCalledWith('cellDrawerPx', 524);
    qs(document, '.cd-backdrop').remove();
  });
  it('clamps mid-drag width to [320, 92vw]', () => {
    const app = makeApp();
    openCellDetail(app, 'c', 'String', 'x');
    const panel = qs(document, '.cd-panel');
    const handle = qs(panel, '.cd-resize-h');
    handle.dispatchEvent(new MouseEvent('mousedown', { clientX: 700, bubbles: true }));
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 2000 })); // 1024-2000 < 0 → floor
    expect(panel.style.width).toBe('320px');
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: -2000 })); // way over → 92vw cap
    expect(panel.style.width).toBe(1024 * 0.92 + 'px');
    window.dispatchEvent(new MouseEvent('mouseup', {}));
    qs(document, '.cd-backdrop').remove();
  });
  it('finishing a resize drag with the mouse over the backdrop does not close the drawer; a later genuine click still does', () => {
    const app = makeApp();
    openCellDetail(app, 'c', 'String', 'x');
    const backdrop = qs(document, '.cd-backdrop');
    const handle = qs(backdrop, '.cd-resize-h');
    handle.dispatchEvent(new MouseEvent('mousedown', { clientX: 700, bubbles: true }));
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 500 }));
    window.dispatchEvent(new MouseEvent('mouseup', {}));
    // The browser follows a drag's mouseup with a `click` targeting the nearest
    // common ancestor of the mousedown/mouseup targets — here, since mouseup
    // landed outside `.cd-panel`, that's the backdrop itself. attachBackdropClose
    // (#110) gates close() on the mousedown target (the handle, inside the
    // panel), so this click alone does not close it.
    backdrop.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(qs(document, '.cd-backdrop')).not.toBeNull(); // stays open
    backdropClick(backdrop); // a later, genuine backdrop click still closes it
    expect(qs(document, '.cd-backdrop')).toBeNull();
  });
  it('closing the drawer mid-drag (Escape, mouse still down) cancels the drag: reverts the width, and does not leak listeners that swallow a later click or persist a stale width on a later mouseup', () => {
    const app = makeApp();
    app.state.cellDrawerPx = 560;
    openCellDetail(app, 'c', 'String', 'x');
    const handle = qs(document, '.cd-resize-h');
    handle.dispatchEvent(new MouseEvent('mousedown', { clientX: 700, bubbles: true }));
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 500 })); // mid-drag, no mouseup yet
    expect(app.state.cellDrawerPx).toBe(524);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); // closes while still dragging
    expect(qs(document, '.cd-backdrop')).toBeNull();
    expect(app.state.cellDrawerPx).toBe(560); // reverted — the abandoned drag never committed

    // The drag's own mousemove/mouseup listeners must have been torn down by
    // the cancel, not just left to resolve later.
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 100 }));
    window.dispatchEvent(new MouseEvent('mouseup', {}));
    expect(app.state.cellDrawerPx).toBe(560); // a stray mouseup doesn't resurrect + persist the drag
    expect(app.savePref).not.toHaveBeenCalledWith('cellDrawerPx', expect.anything());

    openCellDetail(app, 'c2', 'String', 'y'); // an unrelated, later click must work normally
    const backdrop2 = qs(document, '.cd-backdrop');
    backdropClick(backdrop2);
    expect(qs(document, '.cd-backdrop')).toBeNull();
  });
});

describe('expandDataPane', () => {
  // A window/fetch-tab stub only ever needs the few members real code reads
  // (document/close/focus/addEventListener) — never the real `Window`
  // interface's hundred-odd other members, so widening the PARAMETER to
  // `object` (assignable both ways) makes the cast a genuine single-level
  // one, not an `unknown` bridge (same convention as app.test.ts's `asWindow`).
  const asWindow = (v: object): Window => v as Window;
  const makeWin = () => {
    const childDoc = document.implementation.createHTMLDocument('');
    const ls: Record<string, () => void> = {};
    return {
      document: childDoc, closed: false,
      close: vi.fn(), focus: vi.fn(),
      addEventListener: (t: string, fn: () => void) => { ls[t] = fn; },
      fire: (t: string) => ls[t] && ls[t](),
    };
  };

  it('overlay fallback: shows the row count, a sortable/copyable grid snapshot, and Copy calls copySnapshot', () => {
    const app = makeApp();
    const r = tableResult();
    expandDataPane(app, r);
    const overlay = qs(document, '.graph-overlay');
    expect(overlay).not.toBeNull();
    expect(qs(overlay, '.data-pane-body')).not.toBeNull();
    expect(overlay.textContent).toContain('2 rows');
    expect(qsa(overlay, '.res-table tbody tr')).toHaveLength(2);
    const copyBtn = [...qsa(overlay, '.res-act')].find((b) => b.textContent!.includes('Copy'));
    click(copyBtn);
    expect(app.actions.copySnapshot).toHaveBeenCalledWith(r, document);
    // sort is local to the snapshot: clicking a header re-sorts just this grid
    const th = qsa(overlay, '.res-table thead th')[1]; // column 'n'
    click(th);
    const firstRowFirstCell = qs(overlay, '.res-table tbody tr td.cell');
    expect(firstRowFirstCell.textContent).toBe('1'); // ascending on 'n' → '1' before '2'
  });

  it('clicking a cell in the overlay snapshot opens the cell-detail drawer in the same document', () => {
    const app = makeApp();
    expandDataPane(app, tableResult());
    const overlay = qs(document, '.graph-overlay');
    click(qsa(overlay, '.res-table tbody td.cell')[0]);
    expect(qs(document, '.cd-backdrop')).not.toBeNull();
  });

  it('real tab: builds the grid + toolbar in the child document, Copy targets that document', () => {
    const win = makeWin();
    const app = makeApp({ openWindow: () => asWindow(win) });
    const r = tableResult();
    expandDataPane(app, r);
    expect(qs(win.document, '.data-pane-body')).not.toBeNull();
    expect(qsa(win.document, '.res-table tbody tr')).toHaveLength(2);
    const copyBtn = [...qsa(win.document, '.res-act')].find((b) => b.textContent!.includes('Copy'));
    click(copyBtn);
    expect(app.actions.copySnapshot).toHaveBeenCalledWith(r, win.document);
    // a cell click inside the tab opens the drawer in the TAB's document, not the main one
    click(qsa(win.document, '.res-table tbody td.cell')[0]);
    expect(qs(win.document, '.cd-backdrop')).not.toBeNull();
    expect(qs(document, '.cd-backdrop')).toBeNull();
  });

  it('does not repaint when the main app renders a new result: no signal/effect wiring ties the two together', () => {
    const app = makeApp();
    const r1 = tableResult();
    expandDataPane(app, r1);
    const overlay = qs(document, '.graph-overlay');
    expect(qsa(overlay, '.res-table tbody tr')).toHaveLength(2);
    // the main app moves on to a brand-new result (a fresh query run) — the
    // already-open snapshot has no subscription to react to it.
    app.activeTab().result = tableResult();
    renderResults(app);
    expect(qsa(document, '.graph-overlay')).toHaveLength(1); // still just the one snapshot
    expect(qsa(overlay, '.res-table tbody tr')).toHaveLength(2); // unchanged
  });

  it('overlay: ✕ sits last in the title bar, closes on Escape (or backdrop), but not while a cell drawer is open', () => {
    const app = makeApp();
    expandDataPane(app, tableResult());
    const overlay = qs(document, '.graph-overlay');
    const barChildren = [...qs(overlay, '.graph-overlay-bar').children];
    expect(barChildren.at(-1)!.className).toBe('graph-overlay-close');
    click(qsa(overlay, '.res-table tbody td.cell')[0]); // opens a cell drawer
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(qs(document, '.cd-backdrop')).toBeNull(); // Escape closed the drawer first
    expect(document.body.contains(overlay)).toBe(true); // pane itself still open
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); // second Escape
    expect(document.body.contains(overlay)).toBe(false);
  });

  it('real tab: no ✕ button, and Escape is a no-op (browser tab-close serves that)', () => {
    const win = makeWin();
    const app = makeApp({ openWindow: () => asWindow(win) });
    expandDataPane(app, tableResult());
    expect(qs(win.document, '.graph-overlay-close')).toBeNull();
    win.document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(win.document.body.contains(qs(win.document, '.data-pane-body'))).toBe(true);
  });

  it('has the full Table/JSON/Chart switcher, same as the inline pane, scoped locally', () => {
    const app = makeApp();
    const r = chartResult();
    expandDataPane(app, r);
    const overlay = qs(document, '.graph-overlay');
    const tabLabels = () => [...qsa(overlay, '.result-view-tab')].map((b) => b.textContent);
    expect(tabLabels()).toEqual(['Table', 'JSON', 'Panel']);
    expect(qs(overlay, '.result-view-tab.active').textContent).toBe('Table');

    // JSON
    click([...qsa(overlay, '.result-view-tab')].find((b) => b.textContent === 'JSON'));
    expect(qs(overlay, '.json-view')).not.toBeNull();
    expect(qs(overlay, '.result-view-tab.active').textContent).toBe('JSON');
    expect(qs(overlay, '.res-table')).toBeNull(); // grid torn down

    // Panel (read-only render of the source tab's resolved panel — #166 v1)
    click([...qsa(overlay, '.result-view-tab')].find((b) => b.textContent === 'Panel'));
    expect(qs(overlay, '.chart-view canvas')).not.toBeNull();
    expect(qs(overlay, '.result-view-tab.active').textContent).toBe('Panel');

    // switching away destroys the chart instance (no leaked canvas/observers)
    const chartBefore = qs(overlay, 'canvas');
    click([...qsa(overlay, '.result-view-tab')].find((b) => b.textContent === 'Table'));
    expect(qs(overlay, 'canvas')).toBeNull();
    expect(qs(overlay, '.res-table')).not.toBeNull();
    expect(chartBefore).not.toBeNull(); // sanity: we did have a canvas to lose
  });

  it('the snapshot panel is render-only: no config bar, and the shared app.chart slot stays free', () => {
    const app = makeApp();
    const r = chartResult();
    expandDataPane(app, r);
    const overlay = qs(document, '.graph-overlay');
    click([...qsa(overlay, '.result-view-tab')].find((b) => b.textContent === 'Panel'));
    expect(qs(overlay, '.chart-view canvas')).not.toBeNull();
    expect(qs(overlay, '.chart-config')).toBeNull(); // readonly — no editor (v1 scope)
    expect(qs(overlay, '.panel-config')).toBeNull();
    expect(queryPanel(app.activeTab())).toBeUndefined(); // the live tab's own config is untouched
    expect(app.chart).toBeUndefined(); // the snapshot's chart never occupies the shared app.chart slot
  });
  it("the snapshot honours the source tab's saved panel type (a table panel renders the grid)", () => {
    const app = makeApp();
    // `!`: a fresh tab's specParsed always starts as a real (non-null) parsed draft.
    app.activeTab().specParsed!.panel = { cfg: { type: 'table' } };
    expandDataPane(app, chartResult());
    const overlay = qs(document, '.graph-overlay');
    click([...qsa(overlay, '.result-view-tab')].find((b) => b.textContent === 'Panel'));
    expect(qs(overlay, '.res-table')).not.toBeNull(); // grid, not the auto chart
    expect(qs(overlay, 'canvas')).toBeNull();
  });

  it('running a new query in the main tab does not blank the snapshot\'s Panel view', () => {
    const app = makeApp();
    const r = chartResult();
    expandDataPane(app, r);
    const overlay = qs(document, '.graph-overlay');
    app.state.running.value = true; // a different, unrelated query starts in the main window
    click([...qsa(overlay, '.result-view-tab')].find((b) => b.textContent === 'Panel'));
    expect(qs(overlay, '.chart-view canvas')).not.toBeNull(); // not the "renders when complete" placeholder
    expect(overlay.textContent).not.toContain('renders when the query completes');
  });

  it('closing the overlay while on Panel view destroys the chart instance (teardown)', () => {
    const app = makeApp();
    const instances: FakeChart[] = [];
    const RealChart = app.Chart;
    class TrackingChart extends RealChart {
      constructor(...args: ConstructorParameters<typeof RealChart>) { super(...args); instances.push(this); }
    }
    app.Chart = TrackingChart;
    const r = chartResult();
    expandDataPane(app, r);
    const overlay = qs(document, '.graph-overlay');
    click([...qsa(overlay, '.result-view-tab')].find((b) => b.textContent === 'Panel'));
    expect(instances).toHaveLength(1);
    expect(instances[0].destroyed).toBe(false);
    qs(overlay, '.graph-overlay-close').dispatchEvent(new Event('click', { bubbles: true }));
    expect(qs(document, '.graph-overlay')).toBeNull();
    expect(instances[0].destroyed).toBe(true);
  });

  // ── interactive detached view (#185) ──────────────────────────────────────
  const tick = () => new Promise((r) => setTimeout(r));
  // A result whose captured source declares one required `{level:String}` param.
  const paramResult = () => {
    const r = tableResult();
    r.source = {
      sql: 'SELECT n, s FROM t WHERE s = {level:String}',
      tabId: 't1', rowLimit: 100, title: 'Filtered', description: 'warnings only',
    };
    return r;
  };
  const refreshBtn = (root: ParentNode) =>
    [...qsa<HTMLButtonElement>(root, '.res-act')].find((b) => b.textContent!.includes('Refresh'));

  it('renders the captured title as a heading + description, and sets the tab title', () => {
    const win = makeWin();
    const app = makeApp({ openWindow: () => asWindow(win) });
    expandDataPane(app, paramResult());
    const h2 = qs(win.document, 'h2.detached-title');
    expect(h2.textContent).toBe('Filtered');
    expect(h2.getAttribute('title')).toBe('Filtered');
    expect(qs(win.document, '.detached-desc').textContent).toBe('warnings only');
    expect(win.document.title).toBe('Filtered'); // browser tab title matches
  });

  it('omits the filter row (and description) when the source has no params / empty description', () => {
    const app = makeApp();
    expandDataPane(app, tableResult()); // plain SELECT, description ''
    const overlay = qs(document, '.graph-overlay');
    expect(qs(overlay, '.detached-filter-row')).toBeNull();
    expect(qs(overlay, '.detached-desc')).toBeNull();
    expect(qs(overlay, 'h2.detached-title').textContent).toBe('My data');
  });

  it('renders the shared filter row for a parameterized source and issues NO query on open', () => {
    const app = makeApp();
    expandDataPane(app, paramResult());
    const overlay = qs(document, '.graph-overlay');
    const row = qs(overlay, '.detached-filter-row');
    expect(row).not.toBeNull();
    expect(qs(row, '.dash-filters[aria-label="Query filters"]')).not.toBeNull();
    expect(qsa(row, '.var-field')).toHaveLength(1);
    expect(app.runReadInto).not.toHaveBeenCalled(); // open = snapshot, no request
  });

  it('Refresh re-runs via the shared read seam (params + no session), replaces the result, records recents', async () => {
    const runReadInto = vi.fn(async (result: RunReadIntoResult, opts: RunReadIntoOpts = {} as RunReadIntoOpts) => {
      result.columns = [{ name: 'n', type: 'UInt64' }];
      result.rows = [[(opts.params as Record<string, unknown>).param_level]];
      opts.onChunk!(undefined); // a streamed chunk → progress-only status, no repaint (#198)
      return result;
    });
    const app = makeApp({ runReadInto });
    app.state.varValues.level = 'Warning';
    expandDataPane(app, paramResult());
    const overlay = qs(document, '.graph-overlay');
    click(refreshBtn(overlay));
    await tick();
    expect(app.runReadInto).toHaveBeenCalledTimes(1);
    const [, opts = {} as RunReadIntoOpts] = app.runReadInto.mock.calls[0];
    expect(opts.sql).toBe('SELECT n, s FROM t WHERE s = {level:String}');
    expect(opts.rowLimit).toBe(100);
    expect(opts.params).toEqual({ param_level: 'Warning' }); // no session_id — plain SELECT
    expect(app.recordBoundParams).toHaveBeenCalledTimes(1);
    // the detached grid now shows the refreshed result, and global state is untouched
    expect(qs(overlay, '.res-table tbody td.cell').textContent).toBe('Warning');
    expect(app.state.running.value).toBe(false);
    // Copy now targets the refreshed result, not the expand-time snapshot
    click([...qsa(overlay, '.res-act')].find((b) => b.textContent!.includes('Copy')));
    expect(app.actions.copySnapshot.mock.calls.at(-1)![0].rows).toEqual([['Warning']]);
  });

  it('Refresh gives an explicit KPI panel ownership of transport and the two-row guard', async () => {
    const runReadInto = vi.fn(async (result: RunReadIntoResult, _opts: RunReadIntoOpts = {} as RunReadIntoOpts) => result);
    const app = makeApp({ runReadInto });
    app.activeTab().specParsed!.panel = { cfg: { type: 'kpi' } };
    app.state.varValues.level = 'Warning';
    expandDataPane(app, paramResult());
    const overlay = qs(document, '.graph-overlay');
    click(refreshBtn(overlay));
    await tick();

    const [, opts = {} as RunReadIntoOpts] = app.runReadInto.mock.calls[0];
    expect(opts.format).toBe('KPI');
    expect(opts.rowLimit).toBe(2);
    expect(opts.params).toEqual({
      param_level: 'Warning',
      output_format_json_named_tuples_as_objects: 1,
      output_format_json_quote_decimals: 1,
    });
  });

  it('Refresh blocks authored FORMAT when an explicit KPI panel owns transport', async () => {
    const runReadInto = vi.fn(async (result: RunReadIntoResult) => result);
    const app = makeApp({ runReadInto });
    app.activeTab().specParsed!.panel = { cfg: { type: 'kpi' } };
    const result = paramResult();
    result.source!.sql += ' FORMAT CSV';
    app.state.varValues.level = 'Warning';
    expandDataPane(app, result);
    const overlay = qs(document, '.graph-overlay');
    click(refreshBtn(overlay));
    await tick();

    expect(app.runReadInto).not.toHaveBeenCalled();
    expect(qs(overlay, '.detached-status').textContent)
      .toBe('KPI panel owns the result format. Remove FORMAT CSV from the SQL.');
  });

  it('blocks the rerun and keeps the previous result + a status when a required value is missing', async () => {
    const app = makeApp(); // default no-op runReadInto
    expandDataPane(app, paramResult()); // level unset → missing
    const overlay = qs(document, '.graph-overlay');
    click(refreshBtn(overlay));
    await tick();
    expect(app.runReadInto).not.toHaveBeenCalled();
    expect(qs(overlay, '.detached-status').textContent).toContain('Enter a value for: level');
    expect(qsa(overlay, '.res-table tbody tr')).toHaveLength(2); // previous snapshot intact
  });

  it('discards a stale response: a newer rerun wins even if it resolves first', async () => {
    const resolvers: (() => void)[] = [];
    const runReadInto = vi.fn((result: RunReadIntoResult, opts: RunReadIntoOpts = {} as RunReadIntoOpts) => new Promise<RunReadIntoResult>((res) => {
      resolvers.push(() => {
        result.columns = [{ name: 'n', type: 'String' }];
        result.rows = [[(opts.params as Record<string, unknown>).param_level]];
        res(result);
      });
    }));
    const app = makeApp({ runReadInto });
    app.state.varValues.level = 'A';
    expandDataPane(app, paramResult());
    const overlay = qs(document, '.graph-overlay');
    click(refreshBtn(overlay)); // run 1 (A), pending
    await tick();
    app.state.varValues.level = 'B';
    click(refreshBtn(overlay)); // run 2 (B), pending — supersedes run 1
    await tick();
    resolvers[1](); await tick(); // newer resolves first → current = B
    resolvers[0](); await tick(); // older resolves late → discarded by the generation guard
    expect(qs(overlay, '.res-table tbody td.cell').textContent).toBe('B');
    expect(app.recordBoundParams).toHaveBeenCalledTimes(1); // only the winning run recorded
  });

  it('closing the view aborts the in-flight detached request', async () => {
    let signal: AbortSignal | undefined;
    const runReadInto = vi.fn((_result: RunReadIntoResult, opts: RunReadIntoOpts = {} as RunReadIntoOpts) => {
      signal = opts.signal;
      return new Promise<QueryResult>(() => {});
    });
    const app = makeApp({ runReadInto });
    app.state.varValues.level = 'A';
    expandDataPane(app, paramResult());
    const overlay = qs(document, '.graph-overlay');
    click(refreshBtn(overlay));
    await tick();
    expect(signal!.aborted).toBe(false);
    backdropClick(overlay); // close the overlay
    expect(signal!.aborted).toBe(true);
  });

  it('threads the originating tab session when the source depended on one', async () => {
    const runReadInto = vi.fn(async (result: RunReadIntoResult, _opts: RunReadIntoOpts = {} as RunReadIntoOpts) => result);
    const app = makeApp({ runReadInto });
    app.activeTab().chSession = 'sess-abc'; // e.g. the source used a temp table / SET
    app.state.varValues.level = 'X';
    expandDataPane(app, paramResult());
    const overlay = qs(document, '.graph-overlay');
    click(refreshBtn(overlay));
    await tick();
    const [, opts = {} as RunReadIntoOpts] = app.runReadInto.mock.calls[0];
    expect((opts.params as Record<string, unknown>).session_id).toBe('sess-abc');
  });

  it('shows a status and does not run when the token cannot be refreshed', async () => {
    const app = makeApp({
      ensureFreshToken: vi.fn(async () => false),
      runReadInto: vi.fn(async (result: QueryResult) => result),
    });
    app.state.varValues.level = 'X';
    expandDataPane(app, paramResult());
    const overlay = qs(document, '.graph-overlay');
    click(refreshBtn(overlay));
    await tick();
    expect(app.runReadInto).not.toHaveBeenCalled();
    expect(qs(overlay, '.detached-status').textContent).toBe('Not signed in');
    expect(refreshBtn(overlay)!.disabled).toBe(false); // re-enabled after the blocked attempt
  });

  it('shows a status and keeps the previous result when the rerun errors', async () => {
    const app = makeApp({
      runReadInto: vi.fn(async (result: QueryResult) => { result.error = 'Boom'; return result; }),
    });
    app.state.varValues.level = 'X';
    expandDataPane(app, paramResult());
    const overlay = qs(document, '.graph-overlay');
    click(refreshBtn(overlay));
    await tick();
    expect(qs(overlay, '.detached-status').textContent).toBe('Boom');
    expect(qsa(overlay, '.res-table tbody tr')).toHaveLength(2); // previous result preserved
    expect(app.recordBoundParams).not.toHaveBeenCalled(); // errors never record recents
    expect(refreshBtn(overlay)!.disabled).toBe(false); // re-enabled after the error
  });

  it('re-enables Refresh when a blocked rerun supersedes an in-flight run', async () => {
    const app = makeApp({ runReadInto: vi.fn((): Promise<RunReadIntoResult> => new Promise(() => {})) }); // never resolves
    app.state.varValues.level = 'A';
    expandDataPane(app, paramResult());
    const overlay = qs(document, '.graph-overlay');
    click(refreshBtn(overlay)); // run 1 → in-flight, Refresh disabled
    await tick();
    expect(refreshBtn(overlay)!.disabled).toBe(true);
    // blank the field and commit (input arms the debounce, blur fires it): a
    // blocked rerun supersedes (and aborts) run 1 — Refresh must re-enable.
    const input = qs<HTMLInputElement>(overlay, '.detached-filter-row .var-field input');
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('blur', { bubbles: true }));
    await tick();
    expect(refreshBtn(overlay)!.disabled).toBe(false);
    expect(qs(overlay, '.detached-status').textContent).toContain('Enter a value for: level');
  });

  // ── commit-on-success streaming policy (#198) ──────────────────────────────
  // A controllable runReadInto: captures the in-flight result + onChunk so a
  // test can emit chunks and resolve on its own schedule. `chunk(patch)` merges
  // into the result then fires onChunk; `finish(patch)` merges then resolves.
  // The (possibly partial-`progress`) patch a test can push into an in-flight
  // run — the exact shape every `chunk`/`finish` call site below builds.
  interface ResultPatch {
    columns?: QueryResult['columns'];
    rows?: QueryResult['rows'];
    progress?: Partial<QueryResult['progress']>;
    cancelled?: boolean;
  }
  interface DeferredRun {
    result: QueryResult;
    chunk: (patch?: ResultPatch) => void;
    finish: (patch?: ResultPatch) => void;
  }
  interface DeferredRunController {
    fn: (result: QueryResult, opts: RunReadIntoOpts) => Promise<QueryResult>;
    runs: DeferredRun[];
    last?: DeferredRun;
  }
  const deferredRun = (): DeferredRunController => {
    // `!`: `fn` is assigned unconditionally on the very next line, before any
    // caller can observe the placeholder.
    const ctl = { runs: [] as DeferredRun[] } as DeferredRunController;
    ctl.fn = vi.fn((result: QueryResult, opts: RunReadIntoOpts) => new Promise<QueryResult>((resolve) => {
      const run: DeferredRun = {
        result,
        chunk: (patch = {}) => { Object.assign(result, patch); opts.onChunk!(undefined); },
        finish: (patch = {}) => { Object.assign(result, patch); resolve(result); },
      };
      ctl.runs.push(run);
      ctl.last = run;
    }));
    return ctl;
  };
  // A chart-shaped result whose captured source declares a `{region:String}`
  // param, so the detached view renders the filter row + Refresh AND its Panel
  // view auto-resolves to a chart.
  const chartParamResult = (): Indexed<QueryResult> => {
    const r = chartResult();
    r.source = { ...r.source!, sql: 'SELECT carrier, region, flights, delay FROM flights WHERE region = {region:String}', rowLimit: 100 };
    return r;
  };

  it('keeps the previous committed result visible during streaming and never flashes "Query returned 0 rows."', async () => {
    const run = deferredRun();
    const app = makeApp({ runReadInto: run.fn });
    app.state.varValues.level = 'Warning';
    expandDataPane(app, paramResult());
    const overlay = qs(document, '.graph-overlay');
    click(refreshBtn(overlay));
    await tick();
    expect(refreshBtn(overlay)!.disabled).toBe(true);
    expect(qs(overlay, '.detached-status').textContent).toBe('Running…');
    // metadata-only chunk: columns present, zero rows — must NOT flash "0 rows".
    run.last!.chunk({ columns: [{ name: 'n', type: 'UInt64' }], rows: [], progress: { rows: 0, bytes: 0, elapsed_ns: 0 } });
    expect(overlay.textContent).not.toContain('Query returned 0 rows.');
    expect(qsa(overlay, '.res-table tbody tr')).toHaveLength(2); // previous result intact
    expect(qs(overlay, '.detached-status').textContent).toBe('Running…');
    // a data chunk carrying a progress counter → status reports rows read.
    run.last!.chunk({ rows: [['x']], progress: { rows: 12400, bytes: 0, elapsed_ns: 0 } });
    expect(qsa(overlay, '.res-table tbody tr')).toHaveLength(2); // STILL the previous result
    expect(qs(overlay, '.stat .v').textContent).toBe('2 rows'); // committed count unchanged while streaming
    expect(qs(overlay, '.detached-status').textContent).toBe(`Running… ${formatRows(12400)} rows read`);
    // resolve → commit exactly once.
    run.last!.finish();
    await tick();
    expect(qsa(overlay, '.res-table tbody tr')).toHaveLength(1); // the new result is now committed
    expect(qs(overlay, '.detached-status').textContent).toBe('');
    expect(refreshBtn(overlay)!.disabled).toBe(false);
  });

  it('commits exactly once on success: before completion Copy/recents target the OLD result, after they target the NEW', async () => {
    const run = deferredRun();
    const app = makeApp({ runReadInto: run.fn });
    app.state.varValues.level = 'Warning';
    expandDataPane(app, paramResult());
    const overlay = qs(document, '.graph-overlay');
    click(refreshBtn(overlay));
    await tick();
    // in-flight rows exist, but nothing is committed yet.
    run.last!.chunk({ columns: [{ name: 'n', type: 'UInt64' }], rows: [['NEW']], progress: { rows: 1, bytes: 0, elapsed_ns: 0 } });
    expect(qs(overlay, '.res-table tbody td.cell').textContent).toBe('2'); // still the old snapshot
    expect(app.recordBoundParams).not.toHaveBeenCalled();
    click([...qsa(overlay, '.res-act')].find((b) => b.textContent!.includes('Copy')));
    expect(app.actions.copySnapshot.mock.calls.at(-1)![0].rows).toEqual([['2', 'b'], ['1', null]]); // Copy = OLD result
    // resolve → commit.
    run.last!.finish();
    await tick();
    expect(qs(overlay, '.res-table tbody td.cell').textContent).toBe('NEW');
    expect(app.recordBoundParams).toHaveBeenCalledTimes(1); // recents recorded exactly once, on success
    click([...qsa(overlay, '.res-act')].find((b) => b.textContent!.includes('Copy')));
    expect(app.actions.copySnapshot.mock.calls.at(-1)![0].rows).toEqual([['NEW']]); // Copy = NEW result
  });

  it('Panel: streaming chunks do not churn the chart; a successful one-row commit switches once to KPI', async () => {
    const run = deferredRun();
    const app = makeApp({ runReadInto: run.fn });
    const instances: FakeChart[] = [];
    const RealChart = app.Chart;
    class TrackingChart extends RealChart {
      constructor(...a: ConstructorParameters<typeof RealChart>) { super(...a); instances.push(this); }
    }
    app.Chart = TrackingChart;
    app.state.varValues.region = 'E';
    expandDataPane(app, chartParamResult());
    const overlay = qs(document, '.graph-overlay');
    click([...qsa(overlay, '.result-view-tab')].find((b) => b.textContent === 'Panel'));
    expect(instances).toHaveLength(1); // the committed snapshot's chart
    const chart0 = instances[0];
    expect(chart0.destroyed).toBe(false);
    // Refresh → stream several chunks WITHOUT resolving.
    click(refreshBtn(overlay));
    await tick();
    run.last!.chunk({ progress: { rows: 100, bytes: 0, elapsed_ns: 0 } });
    run.last!.chunk({ progress: { rows: 200, bytes: 0, elapsed_ns: 0 } });
    expect(chart0.destroyed).toBe(false); // not churned by chunks
    expect(instances).toHaveLength(1); // no per-chunk chart rebuild
    // resolve successfully → one destroy; the eligible one-row result becomes KPI.
    run.last!.finish({ columns: chartResult().columns, rows: [['B6', 'E', '30', '1.1']] });
    await tick();
    expect(chart0.destroyed).toBe(true);
    expect(instances).toHaveLength(1);
    expect(qs(overlay, '.kpi-card')).not.toBeNull();
  });

  it('a current-generation cancelled result never replaces the committed result and records nothing', async () => {
    const run = deferredRun();
    const app = makeApp({ runReadInto: run.fn });
    app.state.varValues.level = 'Warning';
    expandDataPane(app, paramResult());
    const overlay = qs(document, '.graph-overlay');
    click(refreshBtn(overlay));
    await tick();
    run.last!.chunk({ columns: [{ name: 'n', type: 'UInt64' }], rows: [['NEW']], progress: { rows: 1, bytes: 0, elapsed_ns: 0 } });
    run.last!.finish({ cancelled: true });
    await tick();
    expect(qsa(overlay, '.res-table tbody tr')).toHaveLength(2); // previous result kept
    expect(qs(overlay, '.res-table tbody td.cell').textContent).toBe('2');
    expect(app.recordBoundParams).not.toHaveBeenCalled();
    expect(qs(overlay, '.detached-status').textContent).toBe(''); // cancel clears the status
    expect(refreshBtn(overlay)!.disabled).toBe(false);
  });

  it('a late chunk from a superseded run does not update the status; only the newest run controls it', async () => {
    const run = deferredRun();
    const app = makeApp({ runReadInto: run.fn });
    app.state.varValues.level = 'A';
    expandDataPane(app, paramResult());
    const overlay = qs(document, '.graph-overlay');
    click(refreshBtn(overlay)); // run 1
    await tick();
    const run1 = run.last!;
    app.state.varValues.level = 'B';
    click(refreshBtn(overlay)); // run 2 supersedes (aborts run 1)
    await tick();
    const run2 = run.last!;
    run1.chunk({ progress: { rows: 99999 } }); // a late chunk from the superseded run
    expect(qs(overlay, '.detached-status').textContent).toBe('Running…'); // NOT run 1's count
    run2.chunk({ progress: { rows: 5 } }); // the current run drives the status
    expect(qs(overlay, '.detached-status').textContent).toBe(`Running… ${formatRows(5)} rows read`);
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
  r.source = { sql: 'SELECT carrier, region, flights, delay FROM flights', tabId: 't1', rowLimit: 0, title: 'Flights', description: '' };
  return r;
}

describe('EXPLAIN views', () => {
  function explainResult(view: string, over: Partial<QueryResult> = {}): Indexed<QueryResult> {
    const r = newResult(view === 'estimate' ? 'Table' : 'TabSeparatedRaw');
    r.explainView = view;
    return Object.assign(r, over);
  }

  it('toolbar shows the five EXPLAIN tabs with the active one marked', () => {
    const app = appWithResult(explainResult('pipeline', { rawText: 'digraph { n1 [label="A"]; }' }));
    renderResults(app);
    const tabs = [...qsa(app.dom.resultsRegion, '.result-view-tab')];
    expect(tabs.map((t) => t.textContent)).toEqual(['Explain', 'Indexes', 'Projections', 'Pipeline', 'Estimate']);
    expect(tabs.find((t) => t.classList.contains('active'))!.textContent).toBe('Pipeline');
  });

  it('clicking a tab calls setExplainView (re-runs the derived query)', () => {
    const app = appWithResult(explainResult('explain', { rawText: 'plan text' }));
    renderResults(app);
    const tabs = [...qsa(app.dom.resultsRegion, '.result-view-tab')];
    click(tabs[3]); // Pipeline
    expect(app.actions.setExplainView).toHaveBeenCalledWith('pipeline');
  });

  it('renders Explain/Indexes/Projections as monospace text', () => {
    const app = appWithResult(explainResult('explain', { rawText: 'Expression\n  ReadFromTable' }));
    renderResults(app);
    const view = qs(app.dom.resultsRegion, '.raw-text-view');
    expect(view).not.toBeNull();
    expect(view.textContent).toBe('Expression\n  ReadFromTable');
  });

  it('renders Pipeline as the SVG graph', () => {
    const app = appWithResult(explainResult('pipeline', { rawText: 'digraph { n1 [label="A"]; n2 [label="B"]; n1 -> n2; }' }));
    renderResults(app);
    expect(qs(app.dom.resultsRegion, '.explain-graph-view svg.explain-graph')).not.toBeNull();
  });

  it('renders Estimate as a structured table, with a placeholder when empty', () => {
    const r = explainResult('estimate');
    r.columns = [{ name: 'rows', type: 'UInt64' }];
    r.rows = [['42']];
    const app = appWithResult(r);
    renderResults(app);
    expect(qs(app.dom.resultsRegion, 'table.res-table')).not.toBeNull();

    const empty = appWithResult(explainResult('estimate', { columns: [], rows: [] }));
    renderResults(empty);
    expect(qs(empty.dom.resultsRegion, 'table.res-table')).toBeNull();
    expect(empty.dom.resultsRegion.textContent).toMatch(/No rows to estimate/);
  });

  it('keeps the EXPLAIN tabs visible when a view errors', () => {
    const app = appWithResult(explainResult('indexes', { error: 'DB::Exception: boom' }));
    renderResults(app);
    expect(qsa(app.dom.resultsRegion, '.result-view-tab')).toHaveLength(5);
    expect(qs(app.dom.resultsRegion, '.results-error').textContent).toContain('boom');
  });

  it('shows an Expand button for the Pipeline view that opens the fullscreen overlay', () => {
    const app = appWithResult(explainResult('pipeline', { rawText: 'digraph { n1 [label="A"]; }' }));
    renderResults(app);
    const expand = [...qsa(app.dom.resultsRegion, '.res-act')].find((b) => /Expand/.test(b.textContent));
    expect(expand).toBeTruthy();
    click(expand);
    const overlay = qs(document.body, '.graph-overlay');
    expect(overlay).not.toBeNull();
    backdropClick(overlay); // backdrop click closes + cleans up
    expect(qs(document.body, '.graph-overlay')).toBeNull();
  });

  it('has no Expand button for non-pipeline explain views', () => {
    const app = appWithResult(explainResult('explain', { rawText: 'plan text' }));
    renderResults(app);
    expect([...qsa(app.dom.resultsRegion, '.res-act')].some((b) => /Expand/.test(b.textContent))).toBe(false);
  });
});

describe('schema lineage result', () => {
  function graphResult(): Indexed<QueryResult> {
    const r = newResult('Table');
    r.schemaGraph = {
      focus: { kind: 'db', db: 'lin' },
      nodes: [{ id: 'lin.a', label: 'a', kind: 'table' }, { id: 'lin.mv', label: 'mv', kind: 'mv' }],
      edges: [{ from: 'lin.a', to: 'lin.mv', kind: 'feeds' }],
      tableCount: 2, // Phase A resolved (#124) — no longer `loading`
    };
    return r;
  }
  it('renders the schema graph (svg + legend) and a Schema toolbar with Expand', () => {
    const app = appWithResult(graphResult());
    renderResults(app);
    const region = app.dom.resultsRegion;
    expect(qs(region, 'svg.explain-graph')).not.toBeNull();
    expect(qs(region, '.schema-graph-legend')).not.toBeNull();
    expect(qs(region, '.res-graph-title').textContent).toBe('Schema · lin');
    // no Table/JSON/Chart tabs in this mode
    expect(qs(region, '.result-view-tab')).toBeNull();
    const expand = [...qsa(region, '.res-act')].find((b) => /Expand/.test(b.textContent));
    expect(expand).toBeTruthy();
    click(expand);
    // Expand now fires the async action that lazily loads the rich-card dataset and
    // opens the overlay (the overlay itself is covered in explain-graph.test.js).
    expect(app.actions.expandSchemaGraph).toHaveBeenCalledWith({ kind: 'db', db: 'lin' });
  });
  it('titles a table-focus graph with the qualified name', () => {
    const r = graphResult();
    // `!`: graphResult() always sets `schemaGraph` above.
    r.schemaGraph!.focus = { kind: 'table', db: 'lin', table: 'events' };
    const app = appWithResult(r);
    renderResults(app);
    expect(qs(app.dom.resultsRegion, '.res-graph-title').textContent).toBe('Schema · lin.events');
  });
  it('shows a loading placeholder (and no graph/Expand) while the lineage loads', () => {
    const r = newResult('Table');
    r.schemaGraph = { focus: { kind: 'db', db: 'lin' }, loading: true, nodes: [], edges: [] };
    const app = appWithResult(r);
    renderResults(app);
    const region = app.dom.resultsRegion;
    expect(qs(region, '.placeholder.starting').textContent).toMatch(/Loading data flow/);
    expect(qs(region, 'svg.explain-graph')).toBeNull();
    expect(qs(region, '.res-graph-title').textContent).toBe('Schema · lin');
    expect([...qsa(region, '.res-act')].find((b) => /Expand/.test(b.textContent))).toBeFalsy();
  });
  it('a DB with no objects shows the message and no Expand button', () => {
    const r = newResult('Table');
    r.schemaGraph = { focus: { kind: 'db', db: 'target_all' }, nodes: [], edges: [], tableCount: 0 };
    const app = appWithResult(r);
    renderResults(app);
    const region = app.dom.resultsRegion;
    expect(qs(region, 'svg.explain-graph')).toBeNull();
    expect(qs(region, '.placeholder').textContent).toMatch(/No objects in target_all/);
    expect([...qsa(region, '.res-act')].find((b) => /Expand/.test(b.textContent))).toBeFalsy();
  });

  // #124 — progressive draw + cancellation.
  it('the pre-Phase-A loading placeholder has a working Cancel button', () => {
    const r = newResult('Table');
    r.schemaGraph = { focus: { kind: 'db', db: 'lin' }, loading: true, nodes: [], edges: [] };
    const app = appWithResult(r);
    renderResults(app);
    const region = app.dom.resultsRegion;
    const btn = qs(region, '.placeholder.starting .exp-cancel');
    expect(btn).not.toBeNull();
    click(btn);
    expect(app.actions.cancelSchemaGraph).toHaveBeenCalledWith({ clearResult: true });
  });
  it('draws the graph once Phase A resolves even while Phase B is still loading, with a progress readout + Cancel in the toolbar', () => {
    const r = newResult('Table');
    r.schemaGraph = {
      focus: { kind: 'db', db: 'lin' },
      nodes: [{ id: 'lin.a', label: 'a', kind: 'table' }],
      edges: [],
      tableCount: 1,
      loading: true,
      progress: { done: 1, total: 3 },
    };
    const app = appWithResult(r);
    renderResults(app);
    const region = app.dom.resultsRegion;
    // Phase A already drew the graph, not the placeholder.
    expect(qs(region, 'svg.explain-graph')).not.toBeNull();
    expect(qs(region, '.placeholder.starting')).toBeNull();
    expect(region.textContent).toMatch(/resolving 1\/3 view sources/);
    const cancel = [...qsa(region, '.res-act')].find((b) => /Cancel/.test(b.textContent));
    expect(cancel).toBeTruthy();
    click(cancel);
    expect(app.actions.cancelSchemaGraph).toHaveBeenCalledWith({ clearResult: true });
    // no Expand while still loading
    expect([...qsa(region, '.res-act')].find((b) => /Expand/.test(b.textContent))).toBeFalsy();
  });
  it('shows a partial badge for a cancelled-but-kept Phase-A graph, and no Cancel/progress once not loading', () => {
    const r = graphResult();
    // `!`: graphResult() always sets `schemaGraph`.
    r.schemaGraph!.partial = true;
    const app = appWithResult(r);
    renderResults(app);
    const region = app.dom.resultsRegion;
    expect(qs(region, '.cancelled-badge')).not.toBeNull();
    expect([...qsa(region, '.res-act')].find((b) => /Cancel/.test(b.textContent))).toBeFalsy();
    // still loaded (not loading) → Expand is back
    expect([...qsa(region, '.res-act')].find((b) => /Expand/.test(b.textContent))).toBeTruthy();
  });
});

describe('multiquery script grid (#83)', () => {
  const scriptResult = (over: Partial<ScriptResult> = {}): Indexed<ScriptResult> => ({
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
    expect(qs(region, '.script-grid')).not.toBeNull();
    expect(qs(region, '.res-graph-title').textContent).toContain('4 statements');
    const cells = [...qsa(region, '.script-cell')];
    expect(cells[0].textContent).toBe('OK');
    expect(cells[1].textContent).toContain('1'); // preview
    expect(cells[1].textContent).toContain('2 rows');
    expect(cells[2].textContent).toBe('(0 rows)');
    expect(cells[3].textContent).toContain('boom');
    // SQL is collapsed to one line, full text on the title attribute
    const sqlCell = qs(region, 'tbody td.script-sql');
    expect(qs(sqlCell, '.cell-val').textContent).toBe('CREATE TABLE t (a Int8)');
  });

  it('the script grid resize handles swallow clicks (no row-open / header side effects)', () => {
    const app = appWithResult(scriptResult());
    renderResults(app);
    const handle = qs(app.dom.resultsRegion, '.script-grid .col-resize-h');
    handle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(qs(document, '.cd-backdrop')).toBeNull(); // nothing opened
  });

  it('flags a truncated SELECT in its row meta', () => {
    const app = appWithResult(scriptResult({
      script: [{ sql: 'SELECT * FROM big', status: 'rows', columns: [{ name: 'a', type: 'Int' }], rows: [['x']], truncated: true, preview: 'x' }],
    }));
    renderResults(app);
    expect(qs(app.dom.resultsRegion, '.script-cell.rows').textContent).toContain('first 100');
  });

  it('clicking a SELECT row opens the rows pane; Escape and backdrop close it', () => {
    const app = appWithResult(scriptResult());
    renderResults(app);
    click(qs(app.dom.resultsRegion, '.script-cell.rows'));
    let backdrop = qs(document, '.cd-backdrop');
    expect(backdrop).not.toBeNull();
    expect(qsa(backdrop, 'tbody tr')).toHaveLength(2); // both rows
    expect(qs(backdrop, '.cd-type').textContent).toContain('2 rows');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(qs(document, '.cd-backdrop')).toBeNull();
    // reopen + close via backdrop click
    click(qs(app.dom.resultsRegion, '.script-cell.rows'));
    backdrop = qs(document, '.cd-backdrop');
    backdropClick(backdrop);
    expect(qs(document, '.cd-backdrop')).toBeNull();
  });

  it('openRowsViewer renders NULL cells empty and flags a truncated count', () => {
    const app = makeApp();
    openRowsViewer(app, { columns: [{ name: 'x', type: 'String' }, { name: 'y', type: 'String' }], rows: [['a', null]], truncated: true });
    const backdrop = qs(document, '.cd-backdrop');
    expect(qs(backdrop, '.cd-type').textContent).toContain('1+ row');
    const cells = [...qsa(backdrop, 'tbody td')];
    expect(cells[cells.length - 1].textContent).toBe(''); // null → empty
    backdrop.remove();
  });

  it('openRowsViewer gets the same resizable drawer as openCellDetail (#101)', () => {
    const app = makeApp();
    app.state.cellDrawerPx = 700;
    openRowsViewer(app, { columns: [{ name: 'x', type: 'String' }], rows: [['a']] });
    const panel = qs(document, '.cd-panel');
    expect(panel.style.width).toBe('700px');
    const handle = qs(panel, '.cd-resize-h');
    expect(handle).not.toBeNull();
    handle.dispatchEvent(new MouseEvent('mousedown', { clientX: 700, bubbles: true }));
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 500 })); // 1024-500
    expect(panel.style.width).toBe('524px');
    window.dispatchEvent(new MouseEvent('mouseup', {}));
    expect(app.state.cellDrawerPx).toBe(524);
    qs(document, '.cd-backdrop').remove();
  });

  it('the rows pane is the shared grid: sortable headers + clickable cells', () => {
    const app = makeApp();
    openRowsViewer(app, { columns: [{ name: 'n', type: 'UInt64' }], rows: [['2'], ['1'], ['3']] });
    let backdrop = qs(document, '.cd-backdrop');
    // a data column header sorts the pane in place (local sort state)
    const colHeader = [...qsa(backdrop, 'thead th')].find((th) => th.textContent!.includes('n'));
    click(colHeader);
    backdrop = qs(document, '.cd-backdrop');
    const firstCell = qs(backdrop, 'tbody tr td.cell .cell-val');
    expect(firstCell.textContent).toBe('1'); // ascending now
    // clicking a cell opens the (stacked) cell-detail drawer
    click(qs(backdrop, 'tbody td.cell'));
    expect(qsa(document, '.cd-backdrop').length).toBe(2);
    qsa(document, '.cd-backdrop').forEach((b) => b.remove());
  });

  it('Escape closes only the topmost stacked drawer (cell first, then the rows pane)', () => {
    const app = makeApp();
    openRowsViewer(app, { columns: [{ name: 'n', type: 'String' }], rows: [['x']] });
    click(qs(document, '.cd-backdrop tbody td.cell')); // opens a stacked cell drawer
    expect(qsa(document, '.cd-backdrop')).toHaveLength(2);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(qsa(document, '.cd-backdrop')).toHaveLength(1); // only the cell drawer closed
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(qsa(document, '.cd-backdrop')).toHaveLength(0); // now the rows pane
  });

  it('toolbar shows live elapsed + Cancel while running, with a running footer', () => {
    const app = appWithResult(scriptResult(), { running: true });
    renderResults(app);
    const region = app.dom.resultsRegion;
    const cancel = qs(region, '.cancel-act');
    expect(cancel).not.toBeNull();
    expect(qs(region, '.script-running')).not.toBeNull();
    click(cancel);
    expect(app.actions.cancel).toHaveBeenCalled();
  });

  it('toolbar shows total elapsed + a cancelled badge when a script was aborted', () => {
    const app = appWithResult(scriptResult({ cancelled: true }));
    renderResults(app);
    const region = app.dom.resultsRegion;
    expect(qs(region, '.cancelled-badge')).not.toBeNull();
    expect(region.textContent).toContain('12 ms');
    expect(qs(region, '.script-running')).toBeNull();
  });

  it('handles a single-statement script label without an "s"', () => {
    const app = appWithResult(scriptResult({ script: [{ sql: 'SELECT 1', status: 'ok' }] }));
    renderResults(app);
    expect(qs(app.dom.resultsRegion, '.res-graph-title').textContent).toContain('1 statement');
  });

  it('shows each statement’s own execution time in a third column', () => {
    const app = appWithResult(scriptResult());
    renderResults(app);
    const region = app.dom.resultsRegion;
    expect([...qsa(region, 'thead th')].map((th) => th.textContent!.trim())).toEqual(['Statement', 'Result', 'Time']);
    expect([...qsa(region, 'tbody td.script-time')].map((td) => td.textContent)).toEqual(['3 ms', '7 ms', '1 ms', '2 ms']);
  });

  it('leaves the Time cell blank when a statement has no recorded ms', () => {
    const app = appWithResult(scriptResult({ script: [{ sql: 'SELECT 1', status: 'ok' }] }));
    renderResults(app);
    expect(qs(app.dom.resultsRegion, 'tbody td.script-time').textContent).toBe('');
  });

  it('columns are drag-resizable: 3 handles, keyed by plain index (no idx col), splitter model', () => {
    const r = scriptResult({ colWidths: { 0: 200, 1: 400, 2: 100 } }); // pre-seeded pair math
    const app = appWithResult(r);
    renderResults(app);
    const region = app.dom.resultsRegion;
    const handles = qsa(region, '.script-grid th .col-resize-h');
    expect(handles).toHaveLength(3); // Statement, Result, Time
    const win = handles[0].ownerDocument.defaultView!;
    handles[0].dispatchEvent(new MouseEvent('mousedown', { clientX: 100, bubbles: true })); // col 0, neighbor col 1
    win.dispatchEvent(new MouseEvent('mousemove', { clientX: 150 })); // +50
    expect(r.colWidths![0]).toBe(250);
    expect(r.colWidths![1]).toBe(350); // neighbor shrank by 50; pair sum stays 600
    expect(r.colWidths![2]).toBe(100); // untouched
    win.dispatchEvent(new MouseEvent('mouseup', {}));
  });

  it('first drag on the script grid freezes every column (keys 0/1/2, no idx)', () => {
    const app = appWithResult(scriptResult()); // no colWidths → freeze path
    renderResults(app);
    const r = app.activeTab().result as Indexed<ScriptResult>;
    const region = app.dom.resultsRegion;
    qs(region, '.script-grid th .col-resize-h').dispatchEvent(new MouseEvent('mousedown', { clientX: 100, bubbles: true }));
    expect(qs(region, '.res-table').classList.contains('fixed')).toBe(true);
    expect(Object.keys(r.colWidths!).sort()).toEqual(['0', '1', '2']);
    region.ownerDocument.defaultView!.dispatchEvent(new MouseEvent('mouseup', {}));
  });

  it('reapplies stored script-grid widths on re-render', () => {
    const app = appWithResult(scriptResult({ colWidths: { 0: 120, 1: 300, 2: 60 } }));
    renderResults(app);
    const cells = qsa(app.dom.resultsRegion, '.script-grid thead th');
    expect(cells[0].style.width).toBe('120px');
    expect(cells[2].style.width).toBe('60px');
  });
});

describe('script-export log pane (#99)', () => {
  const scriptExportResult = (over: Partial<ScriptExportResult> = {}): Indexed<ScriptExportResult> => ({
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
    expect(qs(region, '.script-export-grid')).not.toBeNull();
    expect([...qsa(region, 'thead th')].map((th) => th.textContent!.trim()))
      .toEqual(['#', 'Statement', 'Type', 'Status', 'File', 'Bytes', 'Time']);
    const rows = [...qsa(region, 'tbody tr')];
    expect(rows).toHaveLength(3);
    expect(qs(rows[0], '.se-num').textContent).toBe('1');
    expect(qs(rows[0], '.se-sql .cell-val').textContent).toBe('CREATE TABLE t (a Int8)');
    expect(qs(rows[0], '.se-type').textContent).toBe('effect');
    expect(qs(rows[0], '.se-status-cell').textContent).toBe('ok');
    expect(qs(rows[0], '.se-file').textContent).toBe('');
    expect(qs(rows[0], '.se-bytes').textContent).toBe(''); // effect statements never show bytes
    expect(qs(rows[0], '.se-time').textContent).toBe('5 ms');
  });

  it('shows the file name and formatted bytes for a row-returning statement', () => {
    const app = appWithResult(scriptExportResult());
    renderResults(app);
    const rows = [...qsa(app.dom.resultsRegion, 'tbody tr')];
    expect(qs(rows[1], '.se-file').textContent).toBe('002-t.tsv');
    expect(qs(rows[1], '.se-bytes').textContent).toBe('1.0 KB');
  });

  it('shows a live now()-startedAt time for the active row (no ms recorded yet)', () => {
    const app = appWithResult(scriptExportResult(), { running: false });
    app.now = () => 250;
    renderResults(app);
    const rows = [...qsa(app.dom.resultsRegion, 'tbody tr')];
    expect(qs(rows[1], '.se-time').textContent).toBe('250 ms');
  });

  it('leaves the Time cell blank for a pending/skipped row with no ms and no startedAt', () => {
    const app = appWithResult(scriptExportResult({
      scriptExport: [{ i: 0, sql: 'SELECT 1', type: 'rows', status: 'skipped', file: null, bytes: 0, startedAt: null, ms: 0, error: null }],
    }));
    renderResults(app);
    expect(qs(app.dom.resultsRegion, 'tbody td.se-time').textContent).toBe('');
  });

  it('shows the inline error message on a failed row (including the mid-stream "incomplete" note)', () => {
    const app = appWithResult(scriptExportResult());
    renderResults(app);
    const rows = [...qsa(app.dom.resultsRegion, 'tbody tr')];
    expect(qs(rows[2], '.se-status-cell').classList.contains('failed')).toBe(true);
    expect(qs(rows[2], '.se-error').textContent).toContain('File may be incomplete');
  });

  it('toolbar shows the title, live elapsed + Cancel while exporting; Cancel calls cancelExportScript', () => {
    const app = appWithResult(scriptExportResult(), { exporting: true });
    app.now = () => 999;
    renderResults(app);
    const region = app.dom.resultsRegion;
    expect(qs(region, '.res-graph-title').textContent).toContain('3 statements');
    expect(qs(region, '.stat.live').textContent).toContain('999 ms');
    const cancel = qs(region, '.cancel-act');
    expect(cancel).not.toBeNull();
    click(cancel);
    expect(app.actions.cancelExportScript).toHaveBeenCalled();
  });

  it('toolbar shows the total elapsed (no Cancel) once exporting finishes', () => {
    const app = appWithResult(scriptExportResult(), { exporting: false });
    renderResults(app);
    const region = app.dom.resultsRegion;
    expect(qs(region, '.cancel-act')).toBeNull();
    expect(region.textContent).toContain('42 ms');
  });

  it('shows a cancelled badge when a statement was cancelled', () => {
    const app = appWithResult(scriptExportResult({
      scriptExport: [{ i: 0, sql: 'SELECT 1', type: 'rows', status: 'cancelled', file: null, bytes: 0, startedAt: 0, ms: 1, error: null }],
    }), { exporting: false });
    renderResults(app);
    expect(qs(app.dom.resultsRegion, '.cancelled-badge')).not.toBeNull();
  });

  it('handles a single-statement label without an "s"', () => {
    const app = appWithResult(scriptExportResult({
      scriptExport: [{ i: 0, sql: 'SELECT 1', type: 'rows', status: 'ok', file: '001-select-1.tsv', bytes: 10, startedAt: 0, ms: 1, error: null }],
    }));
    renderResults(app);
    expect(qs(app.dom.resultsRegion, '.res-graph-title').textContent).toContain('1 statement');
    expect(qs(app.dom.resultsRegion, '.res-graph-title').textContent).not.toContain('1 statements');
  });

  it('columns are drag-resizable, keyed by plain index (7 handles, freeze-on-first-drag)', () => {
    const r = scriptExportResult(); // no colWidths → freeze path
    const app = appWithResult(r);
    renderResults(app);
    const region = app.dom.resultsRegion;
    const handles = qsa(region, '.script-export-grid th .col-resize-h');
    expect(handles).toHaveLength(7);
    const win = handles[0].ownerDocument.defaultView!;
    handles[0].dispatchEvent(new MouseEvent('mousedown', { clientX: 100, bubbles: true }));
    expect(qs(region, '.script-export-grid .res-table').classList.contains('fixed')).toBe(true);
    expect(Object.keys(r.colWidths!).sort()).toEqual(['0', '1', '2', '3', '4', '5', '6']);
    win.dispatchEvent(new MouseEvent('mousemove', { clientX: 110 }));
    win.dispatchEvent(new MouseEvent('mouseup', {}));
    // clicking the handle itself (not dragging) must not also trigger a column sort/toggle.
    click(handles[1]);
  });

  it('reapplies stored script-export-grid widths on re-render', () => {
    const app = appWithResult(scriptExportResult({ colWidths: { 0: 40, 1: 200, 2: 60, 3: 60, 4: 100, 5: 60, 6: 60 } }));
    renderResults(app);
    const cells = qsa(app.dom.resultsRegion, '.script-export-grid thead th');
    expect(cells[0].style.width).toBe('40px');
    expect(cells[6].style.width).toBe('60px');
  });
});
