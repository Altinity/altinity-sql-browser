// The results pane: a view switcher (Table | JSON | Chart, or a single Raw
// view for TSV/JSON output) plus the renderers. Heavy logic (sorting, axis
// selection) lives in core/ and is reused here.

import { h, zoomScale, withDocument, attachBackdropClose } from './dom.js';
import { Icon } from './icons.js';
import { loadingPlaceholder } from './placeholder.js';
import { formatRows, formatBytes, isNumericType } from '../core/format.js';
import { looksLikeHtml, prettyValue } from '../core/cell.js';
import { sortRows } from '../core/sort.js';
import { autoChart, schemaKey, chartFieldOptions, chartColors, chartJsConfig, chartCfgValid, normalizeChartCfg, unzoomChartEvent, chartRowCap } from '../core/chart-data.js';
import { EXPLAIN_VIEWS } from '../core/explain.js';
import { SELECT_ROW_CAP } from '../core/script-result.js';
import { RESULT_ROW_LIMIT_OPTIONS } from '../state.js';
import { renderExplainGraph, openPipelineFullscreen, renderSchemaGraph } from './explain-graph.js';
import { openInDetachedTab } from './detached-view.js';
import { startDrag, clampDrawerWidth } from './splitters.js';

// View id → tab glyph for the EXPLAIN view strip (kept here so core/explain.js
// stays DOM-free). Pipeline reuses the node-graph share glyph.
const EXPLAIN_ICONS = {
  explain: Icon.plan, indexes: Icon.key, projections: Icon.layers,
  pipeline: Icon.share, estimate: Icon.rows,
};

const VIS_CAP = 5000; // fallback display cap for results that carry no row limit (raw / EXPLAIN)
const MIN_COL = 48; // px floor for a resized column

/**
 * How many rows to render: follow the result's own row cap when set (so a 10000
 * limit renders 10000), else the fixed fallback. The server cap already trims a
 * normal SELECT to its limit, so this just keeps the renderers from re-capping
 * a large-but-allowed result. Pure — exported for tests.
 */
export function visCap(r) {
  return r.rowLimit > 0 ? r.rowLimit : VIS_CAP;
}

/**
 * New width (px) for a column dragged by `dx` client px. `scale` converts client
 * px → CSS px under the page `zoom` (computed per element); 0/NaN falls back to
 * 1. Clamped to MIN_COL. Pure — exported for tests.
 */
export function colResizeWidth(startW, dx, scale) {
  return Math.max(MIN_COL, Math.round(startW + dx / (scale || 1)));
}

// Map a header cell index to its `r.colWidths` key. The data grid's first cell is
// the row-number column ('idx'); its data columns are then 0-based. The script
// grid has no row-number column, so every cell keys by its own index.
const IDX_KEY = (k) => (k === 0 ? 'idx' : k - 1);
const PLAIN_KEY = (k) => k;

/**
 * Pin every column of `table` to the px widths in `widths` (keyed via
 * `keyOf(cellIndex)`) and switch it to fixed layout so columns honor those widths
 * exactly (and the wrap scrolls). Shared by the data grid and the script grid.
 */
function applyFixedWidths(table, widths, keyOf) {
  table.classList.add('fixed');
  const cells = table.querySelectorAll('thead th');
  let total = 0;
  for (let k = 0; k < cells.length; k++) {
    const w = widths[keyOf(k)];
    cells[k].style.width = w + 'px';
    total += w;
  }
  table.style.width = total + 'px';
  table.style.minWidth = '0';
}

/**
 * Begin dragging the right edge of header `th` to resize its column. `keyOf` maps
 * a cell index to its `r.colWidths` key (see IDX_KEY / PLAIN_KEY).
 *
 * Splitter model: the drag moves the *border* between this column and its right
 * neighbor — the column grows and the neighbor shrinks by the same amount, so the
 * table's total width (and every other column) stays put. Dragging the last
 * column's edge has no neighbor to take from, so it grows the table (scroll).
 */
function startColumnResize(widths, th, ev, keyOf) {
  ev.preventDefault();
  ev.stopPropagation(); // don't let the handle's mousedown reach the sort header
  const table = th.closest('table');
  const cells = table.querySelectorAll('thead th');
  const cellIdx = [].indexOf.call(cells, th);
  const colIndex = keyOf(cellIdx);
  const nextKey = cellIdx + 1 < cells.length ? keyOf(cellIdx + 1) : null;
  // First resize: freeze every column at its current rendered width, then fix.
  if (!Object.keys(widths).length) {
    for (let k = 0; k < cells.length; k++) {
      widths[keyOf(k)] = cells[k].offsetWidth;
    }
  }
  applyFixedWidths(table, widths, keyOf);
  const win = th.ownerDocument.defaultView;
  const scale = zoomScale(th);
  const startX = ev.clientX;
  const startW = widths[colIndex];
  const pairW = nextKey != null ? startW + widths[nextKey] : 0; // combined width of the pair
  const onMove = (m) => {
    let w = colResizeWidth(startW, m.clientX - startX, scale);
    if (nextKey != null) {
      // Keep the pair's combined width constant; both stay ≥ MIN_COL (a pair
      // narrower than 2·MIN_COL can't satisfy both — the floor wins over total).
      w = Math.max(MIN_COL, Math.min(w, pairW - MIN_COL));
      widths[nextKey] = Math.max(MIN_COL, pairW - w);
    }
    widths[colIndex] = w;
    applyFixedWidths(table, widths, keyOf);
  };
  const onUp = () => {
    win.removeEventListener('mousemove', onMove);
    win.removeEventListener('mouseup', onUp);
  };
  win.addEventListener('mousemove', onMove);
  win.addEventListener('mouseup', onUp);
}

export function renderResults(app) {
  const region = app.dom.resultsRegion;
  if (!region) return;
  // Tear down any live Chart.js instance before the DOM is rebuilt, so a view
  // switch / re-render can't leak its canvas observers (renderChart re-creates).
  if (app.chart) { app.chart.destroy(); app.chart = null; }
  const tab = app.activeTab();
  const r = tab.result;
  const body = h('div', { class: 'results' });
  body.appendChild(buildToolbar(app, r));

  const inner = h('div', { class: 'res-body' });
  // While running, pin a streaming strip to the top of the body: a determinate
  // fill at read/total when known, else an indeterminate sweep.
  if (app.state.running.value) inner.appendChild(streamStrip(r));
  // Multiquery script: a per-statement summary grid. Handled before the
  // single-result chain below (a script result has no `rows`/`rawText`).
  if (r && r.script) {
    inner.appendChild(renderScriptGrid(app, r));
    body.appendChild(inner);
    region.replaceChildren(body);
    return;
  }
  // Script export (issue #99): a per-statement log — metadata only, never the
  // exported rows. Same early-return shape as the r.script branch above.
  if (r && r.scriptExport) {
    inner.appendChild(renderScriptExportGrid(app, r));
    body.appendChild(inner);
    region.replaceChildren(body);
    return;
  }
  const streamingBlank = app.state.running.value && (!r || (r.rows.length === 0 && r.rawText == null));
  if (streamingBlank) {
    inner.appendChild(loadingPlaceholder('Starting query…'));
  } else if (!r) {
    inner.appendChild(h('div', { class: 'empty-results' },
      h('div', { class: 'chip' }, Icon.play()),
      h('div', null, 'Press ', h('kbd', null, '⌘↵'), ' to run query')));
  } else if (r.error) {
    inner.appendChild(h('div', { class: 'results-error' }, r.error));
  } else if (r.schemaGraph) {
    inner.appendChild(r.schemaGraph.loading
      ? loadingPlaceholder('Loading data flow…')
      : renderSchemaGraph(app, r));
  } else if (r.explainView) {
    inner.appendChild(renderExplainView(app, r));
  } else if (r.rawText != null) {
    inner.appendChild(h('div', { class: 'raw-text-view', tabindex: '0' }, r.rawText));
  } else if (r.rows.length === 0) {
    inner.appendChild(h('div', { class: 'placeholder' }, h('div', null, 'Query returned 0 rows.')));
  } else if (app.state.resultView.value === 'json') {
    inner.appendChild(renderJson(r));
  } else if (app.state.resultView.value === 'chart') {
    inner.appendChild(renderChart(app, r));
  } else {
    inner.appendChild(renderTable(app, r));
  }
  body.appendChild(inner);
  region.replaceChildren(body);
}

// Render the active EXPLAIN view: monospace text (Explain/Indexes/Projections),
// a real table (Estimate, streamed structured), or the SVG pipeline graph.
function renderExplainView(app, r) {
  const desc = EXPLAIN_VIEWS.find((v) => v.id === r.explainView);
  const kind = desc ? desc.kind : 'text';
  if (kind === 'graph') return renderExplainGraph(app, r);
  if (kind === 'table') {
    return r.rows.length
      ? renderTable(app, r)
      : h('div', { class: 'placeholder' }, h('div', null, 'No rows to estimate for this query (only MergeTree reads that scan parts produce an estimate).'));
  }
  return h('div', { class: 'raw-text-view', tabindex: '0' }, r.rawText || '');
}

// 2px progress strip atop the results body while a query streams.
function streamStrip(r) {
  return h('div', { class: 'stream-strip' },
    r && r.pct > 0
      ? h('i', { class: 'fill', style: { width: r.pct + '%' } })
      : h('i', { class: 'sweep' }));
}

// The multiquery summary grid: one row per executed statement. Col 1 is the
// collapsed statement text (full text on hover); Col 2 is the outcome — OK for an
// effectful statement (DDL/INSERT), the first-row preview for a SELECT (click to
// open all rows in a side pane), or the error for the failing statement (the last
// row, since the run stops on first failure); Col 3 is that statement's own
// execution time (the toolbar still shows the script total). Columns are
// drag-resizable like the data grid (initial 25 / 65 / 10 from CSS).
function renderScriptGrid(app, r) {
  r.colWidths = r.colWidths || {}; // persists drag-resized widths across re-renders
  const wrap = h('div', { class: 'res-table-wrap script-grid' });
  const table = document.createElement('table');
  table.className = 'res-table';
  const thead = document.createElement('thead');
  const trh = document.createElement('tr');
  for (const [cls, label] of [['script-sql', 'Statement'], ['script-res', 'Result'], ['script-time', 'Time']]) {
    const th = h('th', { class: cls }, h('span', { class: 'h-name' }, label),
      h('span', {
        class: 'col-resize-h',
        title: 'Drag to resize column',
        onmousedown: (e) => startColumnResize(r.colWidths, th, e, PLAIN_KEY),
        onclick: (e) => e.stopPropagation(),
      }));
    trh.appendChild(th);
  }
  thead.appendChild(trh);
  table.appendChild(thead);
  if (Object.keys(r.colWidths).length) applyFixedWidths(table, r.colWidths, PLAIN_KEY);
  const tbody = document.createElement('tbody');
  r.script.forEach((e) => {
    const tr = document.createElement('tr');
    tr.appendChild(h('td', { class: 'script-sql', title: e.sql || '' },
      h('div', { class: 'cell-val' }, (e.sql || '').replace(/\s+/g, ' ').trim())));
    tr.appendChild(scriptOutcomeCell(app, e));
    tr.appendChild(h('td', { class: 'script-time' }, e.ms != null ? e.ms.toFixed(0) + ' ms' : ''));
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  wrap.appendChild(table);
  if (app.state.running.value) {
    wrap.appendChild(h('div', { class: 'script-running' },
      h('span', { class: 'spin' }, Icon.spinner()), h('span', null, 'Running…')));
  }
  return wrap;
}

// The script-export log pane (issue #99): one row per statement, metadata
// only — never the exported rows (that's the memory guarantee). Columns: #,
// Statement, Type, Status, File, Bytes, Time. Drag-resizable like the other
// grids; a fresh set of column keys (7, plain-indexed) since it's a different
// shape from the run script grid.
function renderScriptExportGrid(app, r) {
  r.colWidths = r.colWidths || {};
  const wrap = h('div', { class: 'res-table-wrap script-export-grid' });
  const table = document.createElement('table');
  table.className = 'res-table';
  const thead = document.createElement('thead');
  const trh = document.createElement('tr');
  const cols = [
    ['se-num', '#'], ['se-sql', 'Statement'], ['se-type', 'Type'], ['se-status', 'Status'],
    ['se-file', 'File'], ['se-bytes', 'Bytes'], ['se-time', 'Time'],
  ];
  for (const [cls, label] of cols) {
    const th = h('th', { class: cls }, h('span', { class: 'h-name' }, label),
      h('span', {
        class: 'col-resize-h',
        title: 'Drag to resize column',
        onmousedown: (e) => startColumnResize(r.colWidths, th, e, PLAIN_KEY),
        onclick: (e) => e.stopPropagation(),
      }));
    trh.appendChild(th);
  }
  thead.appendChild(trh);
  table.appendChild(thead);
  if (Object.keys(r.colWidths).length) applyFixedWidths(table, r.colWidths, PLAIN_KEY);
  const tbody = document.createElement('tbody');
  r.scriptExport.forEach((e) => {
    const tr = document.createElement('tr');
    tr.appendChild(h('td', { class: 'se-num' }, String(e.i + 1)));
    tr.appendChild(h('td', { class: 'se-sql', title: e.sql || '' },
      h('div', { class: 'cell-val' }, (e.sql || '').replace(/\s+/g, ' ').trim())));
    tr.appendChild(h('td', { class: 'se-type' }, e.type));
    tr.appendChild(scriptExportStatusCell(e));
    tr.appendChild(h('td', { class: 'se-file' }, e.file || ''));
    tr.appendChild(h('td', { class: 'se-bytes' }, e.type === 'rows' ? formatBytes(e.bytes) : ''));
    tr.appendChild(h('td', { class: 'se-time' }, scriptExportTime(app, e)));
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  wrap.appendChild(table);
  return wrap;
}

// Status cell: a colored word, plus the error message inline for a failed row
// (including the "File may be incomplete…" mid-stream note).
function scriptExportStatusCell(e) {
  const cell = h('td', { class: 'script-cell se-status-cell ' + e.status }, e.status);
  if (e.status === 'failed' && e.error) cell.appendChild(h('div', { class: 'se-error' }, e.error));
  return cell;
}

// A live now()-startedAt readout for the active row (ticked by exportScript's
// 200ms interval — see app.js); e.ms once a statement is done; blank while
// still pending/skipped (ms defaults to 0, so status — not e.ms — is the gate).
function scriptExportTime(app, e) {
  if (e.status === 'running' || e.status === 'exporting') return (app.now() - e.startedAt).toFixed(0) + ' ms';
  if (e.status === 'pending' || e.status === 'skipped') return '';
  return e.ms.toFixed(0) + ' ms';
}

// Column 2 of one script row, by outcome.
function scriptOutcomeCell(app, e) {
  if (e.status === 'error') return h('td', { class: 'script-cell err' }, e.error || 'Error');
  if (e.status === 'ok') return h('td', { class: 'script-cell ok' }, 'OK');
  // status === 'rows'
  if (!e.rows || !e.rows.length) return h('td', { class: 'script-cell' }, '(0 rows)');
  const n = e.rows.length;
  const meta = '(' + n + ' row' + (n === 1 ? '' : 's') + (e.truncated ? ', first ' + SELECT_ROW_CAP : '') + ')';
  return h('td', {
    class: 'script-cell rows', title: 'Click to view all rows',
    onclick: () => openRowsViewer(app, e),
  }, h('span', { class: 'script-preview' }, e.preview || ''), h('span', { class: 'script-meta' }, meta));
}

/**
 * Open a right-side pane with the full rows of one script SELECT, using the same
 * sortable + resizable grid as the main results table (renderGrid). Sort state and
 * column widths are local to this pane; clicking a cell opens its value (the same
 * cell-detail drawer, stacked). Reuses the .cd-* drawer scaffold (a shared Drawer
 * primitive is deferred to #60). Escape / backdrop / ✕ closes. Exported for tests.
 */
export function openRowsViewer(app, entry) {
  const doc = app.document;
  let backdrop;
  let cancelDrawerDrag = () => {};
  let detachBackdrop;
  const onKey = (ev) => { if (ev.key === 'Escape' && isTopDrawer(doc, backdrop)) close(); };
  function close() {
    cancelDrawerDrag();
    detachBackdrop();
    if (backdrop) backdrop.remove();
    doc.removeEventListener('keydown', onKey, true);
  }
  const n = entry.rows.length;
  const head = h('div', { class: 'cd-head' },
    h('div', { class: 'cd-title' },
      h('span', { class: 'cd-name' }, 'Result rows'),
      h('span', { class: 'cd-type' }, n + (entry.truncated ? '+' : '') + ' row' + (n === 1 ? '' : 's'))),
    h('button', { class: 'cd-close', title: 'Close (Esc)', onclick: close }, Icon.close()));
  // Local sort + width state (persist for the lifetime of this open via the entry).
  const sort = entry.viewerSort || (entry.viewerSort = { col: null, dir: 'asc' });
  const widths = entry.viewerWidths || (entry.viewerWidths = {});
  const body = h('div', { class: 'cd-body' });
  const paint = () => body.replaceChildren(renderGrid({
    columns: entry.columns || [],
    rows: entry.rows,
    sort,
    onSort: (col, dir) => { sort.col = col; sort.dir = dir; paint(); },
    widths,
    onCell: (name, type, value) => openCellDetail(app, name, type, value),
  }));
  paint();
  const panel = h('div', { class: 'cd-panel' }, head, body);
  cancelDrawerDrag = attachDrawerResize(app, panel, doc);
  backdrop = h('div', { class: 'cd-backdrop' }, panel);
  detachBackdrop = attachBackdropClose(backdrop, close);
  doc.body.appendChild(backdrop);
  doc.addEventListener('keydown', onKey, true);
  return backdrop;
}

/**
 * A <select> capping how many rows a normal query fetches (the global, persisted
 * preference). Changing it re-runs the current query with the new server-side
 * cap, so a higher limit genuinely fetches more. The caller hides it for EXPLAIN
 * views (small output a cap would truncate oddly).
 */
function rowLimitSelect(app) {
  const sel = h('select', {
    class: 'row-limit-select',
    title: 'Max rows to fetch — changing re-runs the query',
    onchange: (e) => app.actions.setResultRowLimit(Number(e.target.value)),
  });
  for (const n of RESULT_ROW_LIMIT_OPTIONS) {
    sel.appendChild(h('option', { value: String(n) }, String(n)));
  }
  // Reflect the current limit by value (set after the options are attached so the
  // <select> resolves the selection correctly).
  sel.value = String(app.state.resultRowLimit);
  return h('label', { class: 'row-limit' }, h('span', { class: 'row-limit-label' }, 'Rows'), sel);
}

function buildToolbar(app, r) {
  const toolbar = h('div', { class: 'res-toolbar' });
  if (r && r.script) {
    // Script view: a title (N statements) + live elapsed / Cancel while running,
    // else the total elapsed. No view-switcher / copy / export (each statement
    // owns its own preview + rows pane).
    const n = r.script.length;
    toolbar.appendChild(h('div', { class: 'result-view-tabs' },
      h('span', { class: 'res-graph-title' }, 'Script · ' + n + ' statement' + (n === 1 ? '' : 's'))));
    toolbar.appendChild(h('div', { style: { flex: '1' } }));
    if (app.state.running.value) {
      app.dom.runElapsedEl = h('span', { class: 'v' }, app.elapsedMs().toFixed(0) + ' ms');
      toolbar.appendChild(h('div', { class: 'stat live' }, h('span', { class: 'ic spin' }, Icon.spinner()), app.dom.runElapsedEl));
      toolbar.appendChild(h('button', {
        class: 'res-act cancel-act', title: 'Cancel script (Esc)',
        onclick: () => app.actions.cancel(),
      }, Icon.close(), h('span', null, 'Cancel'), h('kbd', null, 'Esc')));
    } else {
      if (r.cancelled) toolbar.appendChild(h('span', { class: 'cancelled-badge' }, 'Cancelled · partial'));
      toolbar.appendChild(h('div', { class: 'stat' }, h('span', { class: 'ic' }, Icon.clock()),
        h('span', { class: 'v' }, (r.elapsedMs || 0).toFixed(0) + ' ms')));
    }
    return toolbar;
  }
  if (r && r.scriptExport) {
    // Script-export view: a title (N statements) + live elapsed / Cancel while
    // exporting, else the total elapsed. Same "no view tabs / row-limit / Copy /
    // Export" shape as the r.script branch — each statement owns its own file.
    const n = r.scriptExport.length;
    toolbar.appendChild(h('div', { class: 'result-view-tabs' },
      h('span', { class: 'res-graph-title' }, 'Export script · ' + n + ' statement' + (n === 1 ? '' : 's'))));
    toolbar.appendChild(h('div', { style: { flex: '1' } }));
    if (app.state.exporting.value) {
      toolbar.appendChild(h('div', { class: 'stat live' }, h('span', { class: 'ic spin' }, Icon.spinner()),
        h('span', { class: 'v' }, (app.now() - r.startedAt).toFixed(0) + ' ms')));
      toolbar.appendChild(h('button', {
        class: 'res-act cancel-act', title: 'Cancel export',
        onclick: () => app.actions.cancelExportScript(),
      }, Icon.close(), h('span', null, 'Cancel')));
    } else {
      if (r.scriptExport.some((e) => e.status === 'cancelled')) {
        toolbar.appendChild(h('span', { class: 'cancelled-badge' }, 'Cancelled · partial'));
      }
      toolbar.appendChild(h('div', { class: 'stat' }, h('span', { class: 'ic' }, Icon.clock()),
        h('span', { class: 'v' }, (r.elapsedMs || 0).toFixed(0) + ' ms')));
    }
    return toolbar;
  }
  if (r && r.schemaGraph) {
    // Schema-lineage view: a title + Expand (fullscreen); no view-switcher / stats.
    const f = r.schemaGraph.focus || {};
    const title = f.kind === 'table' ? f.db + '.' + f.table : f.db;
    toolbar.appendChild(h('div', { class: 'result-view-tabs' }, h('span', { class: 'res-graph-title' }, 'Schema · ' + title)));
    toolbar.appendChild(h('div', { style: { flex: '1' } }));
    // Expand is meaningless until the graph has loaded, or when there's nothing
    // to draw (no connected objects → the pane shows a message, not a graph).
    if (!r.schemaGraph.loading && r.schemaGraph.nodes.length) {
      toolbar.appendChild(h('button', {
        class: 'res-act', title: 'Open the graph fullscreen with rich cards (pan & zoom)',
        onclick: () => app.actions.expandSchemaGraph(r.schemaGraph.focus),
      }, Icon.expand(), h('span', null, 'Expand')));
    }
    return toolbar;
  }
  let tabs;
  if (r && r.explainView) {
    // The five EXPLAIN views — clicking re-runs the derived query (editor SQL is
    // never touched). Stays visible on error so a failing view can be switched.
    tabs = h('div', { class: 'result-view-tabs' });
    for (const v of EXPLAIN_VIEWS) {
      const icon = EXPLAIN_ICONS[v.id];
      tabs.appendChild(h('button', {
        class: 'result-view-tab' + (r.explainView === v.id ? ' active' : ''),
        onclick: () => app.actions.setExplainView(v.id),
      }, icon ? icon() : null, h('span', null, v.label)));
    }
  } else if (r && r.rawText != null) {
    // A single, always-active tab naming the raw format (TSV/JSON) — nothing to switch to.
    tabs = h('div', { class: 'result-view-tabs' },
      h('button', { class: 'result-view-tab active' },
        r.rawFormat === 'JSON' ? Icon.json() : Icon.table2(), h('span', null, r.rawFormat)));
  } else {
    tabs = viewSwitcherTabs(app.state.resultView.value, (id) => { app.state.resultView.value = id; });
  }
  toolbar.appendChild(tabs);
  // Row-cap selector after the view tabs, for normal result queries only —
  // EXPLAIN views are exempt (small output a cap would truncate oddly).
  if (!(r && r.explainView)) toolbar.appendChild(rowLimitSelect(app));
  toolbar.appendChild(h('div', { style: { flex: '1' } }));
  // EXPLAIN views suppress the ms/rows/bytes stats — they're not meaningful for a
  // plan and the freed space lets the five tabs breathe.
  const showStats = !(r && r.explainView);
  if (app.state.running.value) {
    // Live counters (accent, mono) + Cancel — replaces the static stats while
    // streaming. The ms element is updated in place by app.tickElapsed().
    if (showStats) {
      app.dom.runElapsedEl = h('span', { class: 'v' }, app.elapsedMs().toFixed(0) + ' ms');
      toolbar.appendChild(h('div', { class: 'stat live' }, h('span', { class: 'ic spin' }, Icon.spinner()), app.dom.runElapsedEl));
      toolbar.appendChild(h('div', { class: 'stat live' }, h('span', { class: 'ic' }, Icon.rows()),
        h('span', { class: 'v' }, formatRows(r ? r.progress.rows : 0) + ' rows')));
      toolbar.appendChild(h('div', { class: 'stat live' }, h('span', { class: 'ic' }, Icon.bytes()),
        h('span', { class: 'v' }, formatBytes(r ? r.progress.bytes : 0))));
    }
    toolbar.appendChild(h('button', {
      class: 'res-act cancel-act', title: 'Cancel query (Esc)',
      onclick: () => app.actions.cancel(),
    }, Icon.close(), h('span', null, 'Cancel'), h('kbd', null, 'Esc')));
  } else if (r) {
    if (r.cancelled) {
      toolbar.appendChild(h('span', { class: 'cancelled-badge' }, 'Cancelled · partial'));
    }
    if (showStats) {
      const ms = (r.progress.elapsed_ns / 1e6).toFixed(0);
      toolbar.appendChild(h('div', { class: 'stat' }, h('span', { class: 'ic' }, Icon.clock()), h('span', { class: 'v' }, ms + ' ms')));
      toolbar.appendChild(h('div', { class: 'stat' }, h('span', { class: 'ic' }, Icon.rows()),
        h('span', { class: 'v' }, (r.rawText != null ? '—' : r.rows.length) + ' rows')));
      toolbar.appendChild(h('div', { class: 'stat', title: r.progress.rows + ' rows scanned' },
        h('span', { class: 'ic' }, Icon.bytes()), h('span', { class: 'v' }, formatBytes(r.progress.bytes))));
      // The result hit the row cap: say so (the fetch stopped at the limit, more
      // rows exist). Only the streaming path sets `capped`; raw output can't.
      if (r.capped) {
        toolbar.appendChild(h('span', {
          class: 'capped-badge', title: 'Fetch stopped at the row limit — raise it to see more',
        }, 'first ' + r.rowLimit + ' (capped)'));
      }
    }
    if (r.explainView === 'pipeline' && r.rawText && !r.error) {
      toolbar.appendChild(h('button', {
        class: 'res-act', title: 'Open the graph fullscreen (pan & zoom)',
        onclick: () => openPipelineFullscreen(app, r.rawText),
      }, Icon.expand(), h('span', null, 'Expand')));
    }
    if (!r.error) {
      // Expand is meaningful only for a real grid — not raw text output (no
      // columns model) and not an empty result (nothing to show).
      if (r.rawText == null && r.rows.length > 0) {
        toolbar.appendChild(h('button', {
          class: 'res-act', title: 'Open a snapshot of this grid in a new tab (sort, resize, copy)',
          onclick: () => expandDataPane(app, r),
        }, Icon.expand(), h('span', null, 'Expand')));
      }
      toolbar.appendChild(h('button', {
        class: 'res-act', title: 'Copy results to clipboard',
        onclick: () => app.actions.copyResult(),
      }, Icon.copy(), h('span', null, 'Copy')));
    }
  }
  return toolbar;
}

/**
 * The Table/JSON/Chart tabs — shared by the main results toolbar and the
 * detached Data Pane, each with its own view-state slot. `current` is the
 * active view id; `onSelect(id)` switches it. Icons are built fresh on every
 * call (never cached/shared across the two consumers' documents — an Icon
 * element inserted into a second document would just move out of the first).
 */
function viewSwitcherTabs(current, onSelect) {
  const tabs = h('div', { class: 'result-view-tabs' });
  for (const v of [
    { id: 'table', label: 'Table', icon: Icon.table2() },
    { id: 'json', label: 'JSON', icon: Icon.json() },
    { id: 'chart', label: 'Chart', icon: Icon.chart() },
  ]) {
    tabs.appendChild(h('button', {
      class: 'result-view-tab' + (current === v.id ? ' active' : ''),
      onclick: () => onSelect(v.id),
    }, v.icon, h('span', null, v.label)));
  }
  return tabs;
}

export function renderJson(r) {
  const arr = r.rows.slice(0, visCap(r)).map((row) => {
    const o = {};
    r.columns.forEach((c, i) => { o[c.name] = row[i]; });
    return o;
  });
  return h('div', { class: 'json-view', tabindex: '0' }, JSON.stringify(arr, null, 2));
}

/**
 * Shared sortable + resizable data grid (the one table view, reused by the main
 * results table and the script-row side pane). Caller supplies the data plus the
 * state seams so the same DOM/interaction code drives both:
 *   { columns, rows, sort:{col,dir}, onSort(col,dir), widths, onCell(name,type,value) }
 * `widths` is a colWidths object mutated in place (drag-resize); `onSort` re-renders
 * for the caller (global results effect, or the drawer's local repaint). `cap` is
 * the display row cap (the main table passes the selectable result-row limit; the
 * rows pane leaves the default).
 */
export function renderGrid({ columns, rows: rawRows, sort, onSort, widths, onCell, cap = VIS_CAP }) {
  const { col, dir } = sort;
  const rows = sortRows(rawRows, col, dir);
  const wrap = h('div', { class: 'res-table-wrap' });
  const table = h('table', { class: 'res-table' });

  const trh = h('tr', null);
  trh.appendChild(h('th', { style: { textAlign: 'center', color: 'var(--fg-faint)', minWidth: '36px' } }, '#'));
  columns.forEach((c, i) => {
    const isSort = col === i;
    const th = h('th', {
      title: c.type || '', // type exposed on hover, not shown inline
      onclick: () => onSort(i, isSort && dir === 'asc' ? 'desc' : 'asc'),
    }, h('div', { class: 'h-inner' },
      h('span', { class: 'h-name' }, c.name),
      h('span', { style: { flex: '1' } }),
      isSort ? h('span', { class: 'h-sort' }, dir === 'asc' ? Icon.sortAsc() : Icon.sortDesc()) : null),
      // drag the right edge to resize; swallow the click so it doesn't sort.
      h('span', {
        class: 'col-resize-h',
        title: 'Drag to resize column',
        onmousedown: (e) => startColumnResize(widths, th, e, IDX_KEY),
        onclick: (e) => e.stopPropagation(),
      }));
    trh.appendChild(th);
  });
  const thead = h('thead', null);
  thead.appendChild(trh);
  table.appendChild(thead);
  if (Object.keys(widths).length) applyFixedWidths(table, widths, IDX_KEY);

  const tbody = h('tbody', null);
  rows.slice(0, cap).forEach((row, ri) => {
    const tr = h('tr', null);
    tr.appendChild(h('td', { class: 'idx' }, String(ri + 1)));
    row.forEach((v, ci) => {
      const isNum = isNumericType(columns[ci].type);
      const text = v == null ? '' : String(v);
      // Truncate in-cell (CSS max-width + ellipsis); click opens the full value
      // in a side drawer so one fat column (e.g. HTML blobs) can't dominate.
      tr.appendChild(h('td', {
        class: 'cell' + (isNum ? ' num' : ''),
        title: text.length > 100 ? text.slice(0, 100) + '…' : text,
        onclick: () => onCell(columns[ci].name, columns[ci].type, v),
      }, h('div', { class: 'cell-val' }, text)));
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  wrap.appendChild(table);
  if (rows.length > cap) {
    wrap.appendChild(h('div', {
      style: { padding: '10px 14px', fontSize: '11px', color: 'var(--fg-faint)', fontFamily: 'var(--mono)', borderTop: '1px solid var(--border)' },
    }, '… + ' + (rows.length - cap) + ' more rows truncated for display.'));
  }
  return wrap;
}

// The main results table: renderGrid wired to the global sort state + result.
export function renderTable(app, r) {
  r.colWidths = r.colWidths || {}; // persists across re-renders (sort/streaming)
  return renderGrid({
    columns: r.columns,
    rows: r.rows,
    sort: app.state.resultSort,
    onSort: (col, dir) => { app.state.resultSort = { col, dir }; renderResults(app); },
    widths: r.colWidths,
    onCell: (name, type, value) => openCellDetail(app, name, type, value),
    cap: visCap(r), // honor the selectable result-row limit (#86)
  });
}

/**
 * Expand the current grid into a detached view (a real tab, else the in-app
 * overlay) — a frozen snapshot of `r`: it does not update if the user runs a
 * new query afterward (live-sync would need cross-document reactivity — a
 * BroadcastChannel/postMessage bridge — real additional scope, not built
 * speculatively here). The full Table/JSON/Chart switcher is available, same
 * as the inline results pane, but the active view/sort/column-widths/chart
 * config are all local to this snapshot — switching here never touches the
 * live tab's own view state, and the chart config is its own independent
 * holder (never `app.activeTab()`'s). Copy copies exactly what's shown (the
 * table view's rows — Chart/JSON have no separate copy target, same as the
 * main pane). No row-limit selector (there is nothing to re-fetch for a
 * frozen snapshot) and no Export (that's a separate re-run of the live query
 * to disk, in app.js's editor toolbar — unrelated to this rendered grid).
 * Exported for tests.
 */
export function expandDataPane(app, r) {
  const mainDoc = app.document;
  return openInDetachedTab(app, {
    title: 'Data',
    mode: 'grid',
    mount: ({ doc, bar, body, close, closeBtn }) => {
      const isTab = doc !== mainDoc;
      if (closeBtn) bar.appendChild(closeBtn); // title bar, top-right — same slot schema/pipeline use
      const view = { current: 'table' };
      const chartTab = {}; // local chartKey/chartCfg holder — independent of the live tab's own chart config
      const sort = { col: null, dir: 'asc' };
      const widths = {};
      let chartInstance = null;

      const inner = h('div', { class: 'res-body' });
      const paint = () => withDocument(doc, () => {
        // Always destroy the previous chart before rebuilding — same reasoning
        // as renderResults' own destroy-before-rebuild (a view switch or a
        // chart-config change re-creates it; nothing may leak its canvas/observers).
        if (chartInstance) { chartInstance.destroy(); chartInstance = null; }
        if (view.current === 'json') {
          inner.replaceChildren(renderJson(r));
        } else if (view.current === 'chart') {
          inner.replaceChildren(renderChart(app, r, {
            tab: chartTab,
            rerender: paint,
            setChart: (c) => { chartInstance = c; },
            running: false, // a snapshot's own data is always already complete
          }));
        } else {
          inner.replaceChildren(renderGrid({
            columns: r.columns,
            rows: r.rows,
            sort,
            onSort: (c, d) => { sort.col = c; sort.dir = d; paint(); },
            widths,
            onCell: (name, type, value) => openCellDetail(app, name, type, value, doc),
            cap: visCap(r),
          }));
        }
      });

      let tabsEl = viewSwitcherTabs(view.current, selectView);
      function selectView(id) {
        view.current = id;
        const next = viewSwitcherTabs(id, selectView);
        tabsEl.replaceWith(next);
        tabsEl = next;
        paint();
      }
      paint();

      const toolbar = h('div', { class: 'res-toolbar' },
        tabsEl,
        h('div', { class: 'stat' }, h('span', { class: 'ic' }, Icon.rows()), h('span', { class: 'v' }, r.rows.length + ' rows')),
        h('div', { style: { flex: '1' } }),
        h('button', {
          class: 'res-act', title: 'Copy results to clipboard',
          onclick: () => app.actions.copySnapshot(r, doc),
        }, Icon.copy(), h('span', null, 'Copy')));
      body.appendChild(h('div', { class: 'results data-pane-view' }, toolbar, inner));
      if (isTab) return null; // no JS-driven close in a real tab (browser tab-close serves that)
      // Esc closes an open cell-detail drawer first (its own listener, keyed
      // off isTopDrawer, handles that); a second Esc — no drawer left — closes
      // the pane, matching the schema/pipeline overlays' Escape convention.
      const onKey = (e) => {
        if (e.key !== 'Escape' || doc.querySelector('.cd-backdrop')) return;
        e.stopPropagation();
        close();
      };
      doc.addEventListener('keydown', onKey, true);
      return () => {
        doc.removeEventListener('keydown', onKey, true);
        if (chartInstance) { chartInstance.destroy(); chartInstance = null; }
      };
    },
  });
}

/**
 * Open a right-side drawer with one cell's full value: pretty-printed (JSON is
 * reindented), and for HTML a Rendered (sandboxed iframe) ↔ Source toggle.
 * Escape or a backdrop/✕ click closes it. Exported for tests.
 */
// Only the topmost drawer responds to Escape, so dismissing a stacked cell drawer
// returns to the rows pane underneath instead of closing both at once. (The
// current backdrop is always in the DOM when its handler fires.)
function isTopDrawer(doc, el) {
  const all = doc.querySelectorAll('.cd-backdrop');
  return all[all.length - 1] === el;
}

/**
 * Wire the left-edge drag handle that resizes the cell-detail / rows-viewer
 * drawer (#101), shared by openCellDetail and openRowsViewer via splitters.js's
 * drag controller (a 'drawer' axis alongside 'col'/'sideRow'/'row'). Sets the
 * initial width from the persisted `cellDrawerPx` pref, clamped to the current
 * viewport, and appends the handle to `panel`.
 *
 * A resize drag that ends with the mouse over `.cd-backdrop` no longer needs a
 * dedicated swallow-listener here: `attachBackdropClose` (#110) tracks where
 * `mousedown` actually landed, and this handle is a `.cd-panel` descendant, so
 * that drag's trailing click — wherever it targets — never closes the drawer.
 *
 * Returns `cancelDrag()`: the drawer's own `close()` (Escape / backdrop click /
 * ✕) can fire while the mouse button is still down mid-drag — without this,
 * the abandoned drag's `mousemove`/`mouseup` listeners would linger on `win`
 * after the panel is gone, so a later unrelated mouseup would still persist a
 * stale `cellDrawerPx`. `close()` must call it before removing the backdrop.
 * A no-op if no drag is in progress.
 */
function attachDrawerResize(app, panel, doc) {
  // doc.defaultView is null for a detached document not yet attached to a real
  // browsing context (e.g. tests' document.implementation.createHTMLDocument());
  // a real detached tab (window.open()) always has one. Fall back to the
  // ambient window rather than crash on the (harmless) synthetic-doc case.
  const win = doc.defaultView || window;
  panel.style.width = clampDrawerWidth(app.state.cellDrawerPx, win.innerWidth) + 'px';
  let cancelActive = null;
  const handle = h('div', {
    class: 'cd-resize-h',
    title: 'Drag to resize',
    onmousedown: (ev) => {
      const startPx = app.state.cellDrawerPx;
      const stopDrag = startDrag(ev, 'drawer', {
        win,
        state: app.state,
        rectFor: () => ({ width: win.innerWidth }),
        scale: () => zoomScale(panel),
        apply: (_axis, value) => { panel.style.width = value + 'px'; },
        save: (name, value) => app.savePref(name, value),
      });
      cancelActive = () => { stopDrag(); app.state.cellDrawerPx = startPx; cancelActive = null; };
    },
  });
  panel.appendChild(handle);
  return () => { if (cancelActive) cancelActive(); };
}

export function openCellDetail(app, name, type, value, targetDoc) {
  const doc = targetDoc || app.document;
  const text = value == null ? '' : String(value);
  let backdrop;
  let cancelDrawerDrag = () => {};
  let detachBackdrop;
  const onKey = (e) => { if (e.key === 'Escape' && isTopDrawer(doc, backdrop)) close(); };
  function close() {
    cancelDrawerDrag();
    detachBackdrop();
    if (backdrop) backdrop.remove();
    doc.removeEventListener('keydown', onKey, true);
  }

  // withDocument(doc, ...) so every element (including the ones built later,
  // from the Rendered/Source toggle click) lands in the right realm — vital
  // when this drawer is opened from inside a detached tab (results.js's
  // Data Pane), where the ambient doc from the mount()-time call has long
  // since unwound by the time the user clicks anything.
  return withDocument(doc, () => {
    const body = h('div', { class: 'cd-body' });
    const showSource = () => body.replaceChildren(h('pre', { class: 'cd-pre' }, prettyValue(text)));

    const head = h('div', { class: 'cd-head' },
      h('div', { class: 'cd-title' },
        h('span', { class: 'cd-name' }, name),
        type ? h('span', { class: 'cd-type' }, type) : null),
      h('button', { class: 'cd-close', title: 'Close (Esc)', onclick: close }, Icon.close()));

    const panel = h('div', { class: 'cd-panel' }, head);
    cancelDrawerDrag = attachDrawerResize(app, panel, doc);

    if (looksLikeHtml(text)) {
      const seg = h('div', { class: 'cd-toggle' });
      const setMode = (mode) => withDocument(doc, () => {
        seg.replaceChildren(
          h('button', { class: 'cd-seg' + (mode === 'rendered' ? ' on' : ''), onclick: () => setMode('rendered') }, 'Rendered'),
          h('button', { class: 'cd-seg' + (mode === 'source' ? ' on' : ''), onclick: () => setMode('source') }, 'Source'));
        if (mode === 'rendered') {
          const frame = h('iframe', { class: 'cd-frame', sandbox: '' });
          frame.setAttribute('srcdoc', text);
          body.replaceChildren(frame);
        } else {
          showSource();
        }
      });
      panel.append(seg, body);
      setMode('rendered');
    } else {
      panel.appendChild(body);
      showSource();
    }

    backdrop = h('div', { class: 'cd-backdrop' }, panel);
    detachBackdrop = attachBackdropClose(backdrop, close);
    doc.body.appendChild(backdrop);
    doc.addEventListener('keydown', onKey, true);
    return backdrop;
  });
}

/**
 * Per-tab chart config: derive defaults via autoChart the first time (or when
 * the result schema changes), then keep the user's overrides. A config restored
 * from a saved query / share link carries the schema key it was built for, so
 * when the re-run result matches that schema the restored config sticks. Returns
 * null when the result has nothing chartable.
 */
function chartCfgFor(tab, columns) {
  const key = schemaKey(columns);
  if (tab.chartKey !== key) {
    tab.chartKey = key;
    tab.chartCfg = autoChart(columns);
  } else if (tab.chartCfg && !chartCfgValid(tab.chartCfg, columns)) {
    // Key matches but the config doesn't fit (a hand-edited share link or a
    // corrupted import) — fall back to a safe default rather than crash.
    tab.chartCfg = autoChart(columns);
  }
  // Fold cross-field invariants on whatever we ended up with (a restored config
  // can be in-range yet self-contradictory, e.g. a multi-measure pie).
  return normalizeChartCfg(tab.chartCfg);
}

/** A labelled <select> for the config bar. */
function chartSelect(label, value, options, onChange) {
  const sel = h('select', { class: 'chart-select', onchange: (e) => onChange(e.target.value) });
  for (const o of options) {
    const opt = h('option', { value: o.value }, o.label);
    if (o.value === value) opt.selected = true;
    sel.appendChild(opt);
  }
  return h('label', { class: 'chart-field' }, h('span', { class: 'chart-field-label' }, label), sel);
}

function chartEmpty(icon, msg) {
  return h('div', { class: 'chart-empty' }, h('div', { class: 'chip' }, icon), h('div', null, msg));
}

/**
 * Make a Chart.js instance hover-correct under the page's CSS `zoom`. Chart.js
 * feeds every pointer event through the controller's single `_eventHandler`
 * entry point (a late-bound `this._eventHandler` lookup, so overriding the
 * instance property intercepts it) *before* it computes hit-testing / in-area —
 * so we divide the zoomed pointer coords back to chart space there (see
 * `unzoomChartEvent`). `zoomScale(canvas)` reads the live factor each event, so
 * it tracks theme/zoom changes and is a no-op (scale 1) when unzoomed. Returns
 * the chart. Exported for tests.
 */
export function installChartZoomFix(chart, canvas) {
  const onEvent = chart && chart._eventHandler;
  if (typeof onEvent !== 'function') return chart;
  chart._eventHandler = (e, replay) => onEvent.call(chart, unzoomChartEvent(e, zoomScale(canvas)), replay);
  return chart;
}

/**
 * `opts.tab` holds the per-view chart config (`chartKey`/`chartCfg`) — the
 * active tab for the main results pane, or a caller-owned local object for a
 * detached snapshot (so switching chart fields there never touches the live
 * tab's own config). `opts.rerender` repaints after a config change (the
 * whole results pane by default; a caller's own local repaint otherwise).
 * `opts.setChart` receives the new Chart.js instance to store/destroy (the
 * shared `app.chart` slot by default — a detached view must use its own
 * slot instead, or closing one view's chart would tear down another's).
 * `opts.running` overrides the run-state gate — a detached snapshot's `r` is
 * always already-complete, independent of whatever the live tab is doing.
 */
export function renderChart(app, r, opts = {}) {
  const tab = opts.tab || app.activeTab();
  const rerender = opts.rerender || (() => renderResults(app));
  const setChart = opts.setChart || ((c) => { app.chart = c; });
  const running = opts.running !== undefined ? opts.running : app.state.running.value;
  // Gate on run state BEFORE deriving the config: while a query streams its
  // columns can be empty (pre-meta), and letting chartCfgFor see that empty
  // schema would clobber a restored saved/shared config with autoChart(null).
  if (running) return chartEmpty(Icon.spinner(), 'Chart renders when the query completes.');
  const cfg = chartCfgFor(tab, r.columns);
  if (!cfg) return chartEmpty(Icon.chart(), 'These results aren’t chartable — add a numeric column to plot them.');

  const f = chartFieldOptions(r.columns, cfg);

  // Each handler mutates the shared cfg (= tab.chartCfg) and re-renders;
  // chartCfgFor folds the cross-field invariants (pie → single measure,
  // series ≠ X) on the way back in, so the handlers don't normalize themselves.
  const bar = h('div', { class: 'chart-config' });
  bar.appendChild(chartSelect('Type', cfg.type, f.typeOptions, (v) => { cfg.type = v; rerender(); }));
  bar.appendChild(chartSelect('X', String(cfg.x), f.xOptions, (v) => { cfg.x = Number(v); rerender(); }));
  bar.appendChild(chartSelect('Y', String(cfg.y[0]), f.yOptions, (v) => { cfg.y = [Number(v)]; rerender(); }));
  if (f.showMulti) {
    bar.appendChild(h('button', {
      class: 'chart-toggle', title: 'Plot every numeric column as its own series',
      onclick: () => { cfg.y = f.multiActive ? [cfg.y[0]] : f.allMeasures; rerender(); },
    }, f.multiActive ? 'Single series' : 'All measures'));
  }
  if (f.showSeries) {
    bar.appendChild(chartSelect('Series', String(cfg.series ?? ''), f.seriesOptions, (v) => {
      cfg.series = v === '' ? null : Number(v);
      rerender();
    }));
  }
  // The chart plots at most cap points for the current type; say so when the
  // result is bigger (the table still shows everything) — no silent
  // truncation. Recomputed on every rerender (the Type select's onChange),
  // so switching type re-slices and updates the note in lockstep.
  const cap = chartRowCap(cfg.type);
  if (r.rows.length > cap) {
    bar.appendChild(h('span', { class: 'chart-cap-note' },
      'first ' + cap + ' of ' + formatRows(r.rows.length) + ' rows'));
  }

  const canvas = h('canvas', null); // via h() so it lands in the right document (detached-tab safe)
  // Plot in result (query) order — independent of the table's sort, which is a
  // global, cross-tab setting; applying it here would reorder the X axis (a
  // time series would zig-zag) and change which rows the type's row cap keeps,
  // contradicting the "first N rows" note. It would also sort up to VIS_CAP
  // rows just to discard all but the first `cap`.
  const chart = installChartZoomFix(
    new app.Chart(canvas, chartJsConfig(r.columns, r.rows, cfg, chartColors(app.cssVar))),
    canvas);
  setChart(chart);
  // Chart.js's own responsive sizing reads layout through APIs (getComputedStyle,
  // ResizeObserver) bound to the window the Chart.js module itself runs in —
  // always the MAIN window, even when `canvas` belongs to a detached tab's own
  // document. Cross-realm, those calls see an unlaid-out/foreign element: the
  // canvas never gets a real size (stays 0×0), and even after an explicit
  // resize, its bars/points never get laid out (Chart.js's resize-triggered
  // relayout is debounced and gated on the same wrong-realm attachment check).
  // Force one explicit resize + a `'resize'`-mode update off the canvas's own
  // geometry (plain DOM methods — realm-agnostic) once it's actually in the
  // live tree; the caller inserts the returned view synchronously right after
  // this call returns, so a rAF on the canvas's *own* window (not the bare
  // global, which would resolve to the main window's) runs after that insertion.
  canvas.ownerDocument.defaultView.requestAnimationFrame(() => {
    // offsetWidth/Height are already pre-html{zoom} CSS px (unlike
    // getBoundingClientRect, see zoomScale's doc comment) — exactly what
    // chart.resize() wants, no zoom-bridging division needed.
    const wrap = canvas.parentElement;
    if (wrap && wrap.offsetWidth > 0 && wrap.offsetHeight > 0) { chart.resize(wrap.offsetWidth, wrap.offsetHeight); chart.update('resize'); }
  });

  return h('div', { class: 'chart-view' }, bar, h('div', { class: 'chart-canvas-wrap' }, canvas));
}
