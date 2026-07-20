// The results pane: a view switcher (Table | JSON | Panel, or a single Raw
// view for TSV/JSON output) plus the renderers. Heavy logic (sorting, axis
// selection, the panel-cfg union) lives in core/ and is reused here; the
// panel registry + drawer tab live in panels.js (#166).

import { h, withDocument, attachBackdropClose } from './dom.js';
import { Icon } from './icons.js';
import { loadingPlaceholder } from './placeholder.js';
import { formatRows, formatBytes } from '../core/format.js';
import { looksLikeHtml, looksLikeMarkdown, prettyValue } from '../core/cell.js';
import { parseDocMarkdown, defaultDocLinkPolicy } from '../core/doc-markdown.js';
import { renderDocMarkdown } from './doc-markdown-view.js';
import { renderPanelView, renderPanelTypePicker, renderResolvedPanel } from './panels.js';
import { renderGridView, resizeHandle, reapplyWidths, PLAIN_KEY, visCap } from './grid-render.js';
import { EXPLAIN_VIEWS } from '../core/explain.js';
import { SELECT_ROW_CAP } from '../core/script-result.js';
import type { ScriptEntry } from '../core/script-result.js';
import { resolvePanel } from '../core/panel-cfg.js';
import { RESULT_ROW_LIMIT_OPTIONS, tabPanel, effectiveFilterActive } from '../state.js';
import type { AppState, QueryTab as Tab, ResultSort } from '../state.js';
import {
  analyzeParameterizedSources, prepareParameterizedBatch, mergedSourceArgs, mergedSourceSql, fieldControls,
} from '../core/param-pipeline.js';
import type { ParameterAnalysis, PreparedFieldState, ValidationMode } from '../core/param-pipeline.js';
import { newResult } from '../core/stream.js';
import type { StreamResult } from '../core/stream.js';
import { renderExplainGraph, openPipelineFullscreen, renderSchemaGraph } from './explain-graph.js';
import type { DetachedGraphApp, SchemaLineageGraph } from './explain-graph.js';
import { openInDetachedTab } from './detached-view.js';
import type { DetachedView, DetachedViewApp, DetachedWindowLike, MountCtx } from './detached-view.js';
import { buildFilterBar } from './filter-bar.js';
import type { FilterBarApp } from './filter-bar.js';
import { buildDrawerChrome, attachDrawerResize } from './drawer.js';
import { panelExecution } from '../core/panel-execution.js';
import { renderFilterPreview } from './filter-preview.js';
import type { AppDom, App } from './app.types.js';
import type { PanelResolution } from '../core/panel-cfg.js';
import type { ResultSource } from '../core/query-source.js';
import type { SchemaGraphFocus } from '../core/schema-graph.js';
import type { QueryExecutionService } from '../application/query-execution-service.js';
import type { ConnectionSession } from '../application/connection-session.js';
import type { WorkbenchParameterSession } from '../application/workbench-parameter-session.js';
import type { AppPreferences, PreferenceKey } from '../application/app-preferences.js';

// ── The Result contract (#267) ──────────────────────────────────────────────
// `QueryTab.result` (state.ts) is deliberately opaque there
// (`Record<string, unknown> | null`) — this module is the one place that
// knows and owns the concrete shape a run actually produces. A run's result is
// exactly one of three bespoke JS object shapes (app.js's run()/runScript()/
// exportScript()), never a single closed discriminated union with a shared
// tag field — so `Result` below is a plain union of those three shapes, and
// every dispatch in this file narrows it with an `in` check (equivalent, for
// these fields, to the original untyped `r.script`/`r.scriptExport` truthy
// checks: each field, when the object carries it at all, is always a
// non-empty-meaningful value — an array or object — so presence and
// truthiness agree).

// ScriptEntry moved to core/script-result.ts (#276 Phase 1) — re-exported
// below so every existing importer of ScriptEntry-from-results keeps
// compiling unchanged; this module keeps using the name internally via the
// `import type` above.
export type { ScriptEntry };

/** A multiquery script run's `tab.result` shape (#83): one row per executed
 *  statement, replacing the ordinary StreamResult-based shape wholesale. */
export interface ScriptResult {
  script: ScriptEntry[];
  elapsedMs?: number;
  cancelled?: boolean;
  /** Drag-resized column widths for the script grid, persisted across re-renders. */
  colWidths?: Record<string, number>;
}

/** One statement's export outcome in a script-export run (#99) — metadata
 *  only, never the exported rows. */
export interface ScriptExportEntry {
  i: number;
  sql?: string;
  type: string;
  status: string;
  file: string | null;
  bytes: number;
  startedAt: number | null;
  ms: number | null;
  error: string | null;
}

/** A script-export run's `tab.result` shape (#99), replacing the ordinary
 *  StreamResult-based shape wholesale, same as `ScriptResult`. */
export interface ScriptExportResult {
  scriptExport: ScriptExportEntry[];
  startedAt: number;
  elapsedMs?: number;
  colWidths?: Record<string, number>;
}

/** Progressive-load schema-lineage state (#124): the compact drawn shape
 *  explain-graph.ts itself reads (`SchemaLineageGraph`) plus the Phase A/B
 *  resolution bookkeeping only app.js/results.js track — `tableCount` (Phase A
 *  resolved once known), `loading` (Phase B — per-view/MV EXPLAIN AST — still
 *  in flight), its `progress`, and `partial` (a cancelled-but-kept Phase-A
 *  graph). */
export interface ResultSchemaGraph extends SchemaLineageGraph {
  tableCount?: number;
  loading?: boolean;
  progress?: { done: number; total: number };
  partial?: boolean;
}

/** The ordinary streamed query result: `core/stream.ts`'s `StreamResult` plus
 *  the fields app.js/results.js attach after the fact — the active EXPLAIN
 *  view id, the schema-lineage graph (#124), the captured #185 detached-view
 *  source, drag-resized column widths, and the Panel drawer's own grid
 *  sort/width holder (#166). */
export interface QueryResult extends StreamResult {
  explainView?: string;
  schemaGraph?: ResultSchemaGraph;
  source?: ResultSource;
  colWidths?: Record<string, number>;
  panelState?: Record<string, unknown>;
}

/** `QueryTab.result`'s real shape — the canonical contract this module owns
 *  (see the module doc above). */
export type Result = ScriptResult | ScriptExportResult | QueryResult;

// ── The narrow `app` surface this module reads directly ────────────────────
// Not the full ~50-member `App` contract (app.types.ts) — tests/helpers/
// fake-app.js's long-standing `makeApp()` stub (and panels.test.ts's own
// further-narrowed fixture) satisfy this directly, matching the convention
// filter-bar.ts/filter-preview.ts/explain-graph.ts already established for
// their own narrow app surfaces. The three calls into panels.ts's registry
// (which wants the literal `App`, since it's also Dashboard's shared
// registry) cast at that one seam (`app as App`) — the real production
// caller (main.js's createApp()) always supplies the genuine full App; a
// render-path test exercising just this module's own logic never reaches the
// OTHER panel arms' extra fields.
export interface ResultsAppActions {
  rerenderTabs(): void;
  cancel(): void;
  cancelExportScript(): void;
  cancelSchemaGraph(opts?: { clearResult?: boolean }): void;
  expandSchemaGraph(focus?: SchemaGraphFocus): unknown;
  setExplainView(id: string): unknown;
  setResultRowLimit(n: number): unknown;
  copyResult(): void;
  copySnapshot(result: unknown, doc?: Document): void;
  /** Never called by this module directly — forwarded to explain-graph.ts's
   *  node-click handlers (renderExplainGraph/renderSchemaGraph) when the
   *  inline pipeline/schema graph is drawn. */
  insertCreate?(target: string): unknown;
  openNodeDetail?(node: unknown, targetDoc?: Document): unknown;
}

export interface ResultsApp {
  dom: AppDom;
  document: Document;
  chart?: { destroy(): void } | null;
  state: AppState;
  activeTab(): Tab;
  actions: ResultsAppActions;
  now(): number;
  elapsedMs(): number;
  wallNow(): number;
  conn: Pick<ConnectionSession, 'ensureFreshToken'>;
  /** The shared request/stream/normalize service (#276 Phase 1) — this module
   *  only ever needs `executeRead` (the detached Data view's own re-run). */
  exec: Pick<QueryExecutionService, 'executeRead'>;
  /** #276 Phase 5: no flat `App` delegates for the params-group members this
   *  module (and, via the `as FilterBarApp` cast below, filter-bar.ts) needs —
   *  `app.params.*` directly. */
  params: Pick<WorkbenchParameterSession, 'recordBoundParams' | 'saveVarValues' | 'saveFilterActive' | 'clearVarRecent'>;
  /** #276 Phase 5: no flat `App.savePref` delegate — `app.prefs.save(name,
   *  value)` directly (the cell-detail drawer's own resize persist). */
  prefs: Pick<AppPreferences, 'save'>;
  updateSaveBtn(): void;
  updateEditorModeUi?(): void;
  openWindow?(url: string, target: string): DetachedWindowLike | null;
}

/** The Chart.js instance shape a readonly panel's `setChart` ever receives —
 *  matches panels.ts's own (unexported) `PanelChartInstance`. */
interface PanelChartInstance { destroy(): void }

/** The Panel drawer tab's caller seams (#166): the repaint scope, the cell
 *  drawer, the tab-dirty wiring, and the display cap — matches panels.ts's
 *  own (unexported) `PanelHooks`. */
interface PanelHooks {
  rerender: () => void;
  onCell: (name: string, type: string, value: unknown) => void;
  cap?: number;
  markDirty: () => void;
}

// View id → tab glyph for the EXPLAIN view strip (kept here so core/explain.js
// stays DOM-free). Pipeline reuses the node-graph share glyph.
const EXPLAIN_ICONS: Record<string, () => SVGElement> = {
  explain: Icon.plan, indexes: Icon.key, projections: Icon.layers,
  pipeline: Icon.share, estimate: Icon.rows,
};

export function renderResults(app: ResultsApp): void {
  const region = app.dom.resultsRegion;
  if (!region) return;
  // Tear down any live Chart.js instance before the DOM is rebuilt, so a view
  // switch / re-render can't leak its canvas observers (renderChart re-creates).
  if (app.chart) { app.chart.destroy(); app.chart = null; }
  const tab = app.activeTab();
  // Ingress: QueryTab.result is deliberately opaque at the state-contract
  // boundary (`Record<string, unknown> | null`, state.ts) — this module is
  // the one place that knows the concrete Result union (see above).
  const r = tab.result as Result | null;
  // `table` remains a valid persisted/dashboard panel arm, but it has no
  // separate workbench choice: use the ordinary Table view instead of showing
  // two Tables or a Panel selector with an unavailable value. Normalize before
  // building the toolbar so its active state is correct on the first paint.
  if (app.state.resultView.value === 'panel' && tabPanel(tab)?.cfg?.type === 'table') {
    app.state.resultView.value = 'table';
  }
  const body = h('div', { class: 'results' });
  body.appendChild(buildToolbar(app, r));

  const inner = h('div', { class: 'res-body' });
  // While running, pin a streaming strip to the top of the body: a determinate
  // fill at read/total when known, else an indeterminate sweep.
  if (app.state.running.value) inner.appendChild(streamStrip(r));
  // Multiquery script: a per-statement summary grid. Handled before the
  // single-result chain below (a script result has no `rows`/`rawText`).
  if (r && 'script' in r) {
    inner.appendChild(renderScriptGrid(app, r));
    body.appendChild(inner);
    region.replaceChildren(body);
    return;
  }
  // Script export (issue #99): a per-statement log — metadata only, never the
  // exported rows. Same early-return shape as the r.script branch above.
  if (r && 'scriptExport' in r) {
    inner.appendChild(renderScriptExportGrid(app, r));
    body.appendChild(inner);
    region.replaceChildren(body);
    return;
  }
  // Beyond this point `r` is narrowed to `QueryResult | null`.
  const view = app.state.resultView.value;
  const streamingBlank = app.state.running.value && (!r || (r.rows.length === 0 && r.rawText == null));
  if (streamingBlank && view !== 'filter') {
    inner.appendChild(loadingPlaceholder('Starting query…'));
  } else if (!r && view !== 'panel' && view !== 'filter') {
    // The Panel tab renders even with no result at all (#166): a text panel
    // needs none, and query-backed types show their own empty-preview hint.
    inner.appendChild(h('div', { class: 'empty-results' },
      h('div', { class: 'chip' }, Icon.play()),
      h('div', null, 'Press ', h('kbd', null, '⌘↵'), ' to run query')));
  } else if (view === 'filter') {
    inner.appendChild(renderFilterPreview(app));
  } else if (r && r.error) {
    inner.appendChild(h('div', { class: 'results-error' }, r.error));
  } else if (r && r.schemaGraph) {
    // Progressive draw (#124): once Phase A resolves (tableCount known) the
    // real graph draws even while Phase B (per-view/MV EXPLAIN AST) is still
    // loading — only the pre-Phase-A window (nothing known yet, always still
    // loading by construction) shows the cancellable placeholder.
    inner.appendChild(r.schemaGraph.tableCount != null
      ? renderSchemaGraph(app, r)
      : loadingPlaceholder('Loading data flow…', () => app.actions.cancelSchemaGraph({ clearResult: true })));
  } else if (r && r.explainView) {
    inner.appendChild(renderExplainView(app, r));
  } else if (r && r.rawText != null) {
    inner.appendChild(h('div', { class: 'raw-text-view', tabindex: '0' }, r.rawText));
  } else {
    // The Table/JSON/Panel dispatch, shared with the detached Data view (#185).
    // The live pane's Panel view is editable (the drawer + type picker); its
    // table/grid state is the global resultSort + the result's own colWidths.
    inner.appendChild(renderResultView({
      app: app as App,
      view,
      result: r,
      sort: app.state.resultSort,
      setSort: (next) => { app.state.resultSort = next; },
      widths: r ? (r.colWidths = r.colWidths || {}) : undefined,
      rerender: () => renderResults(app),
      onCell: (name, type, value) => openCellDetail(app, name, type, value),
      cap: r ? visCap(r) : undefined,
      panel: { mode: 'edit', hooks: panelHooks(app, r) },
    }));
  }
  body.appendChild(inner);
  region.replaceChildren(body);
}
// The Panel drawer tab's caller seams (#166): the repaint scope, the cell
// drawer, the tab-dirty wiring (a panel-cfg edit dirties exactly like a SQL
// edit — same UI writes as the independent editor callbacks), and the display cap.
// Supplied from here (not imported by panels.js) so panels.js never imports
// results.js back.
function panelHooks(app: ResultsApp, r: QueryResult | null): PanelHooks {
  return {
    rerender: () => renderResults(app),
    onCell: (name, type, value) => openCellDetail(app, name, type, value),
    cap: r ? visCap(r) : undefined,
    markDirty: () => {
      app.actions.rerenderTabs();
      app.updateSaveBtn();
      app.updateEditorModeUi?.();
    },
  };
}

// Render the active EXPLAIN view: monospace text (Explain/Indexes/Projections),
// a real table (Estimate, streamed structured), or the SVG pipeline graph.
function renderExplainView(app: ResultsApp, r: QueryResult): HTMLElement {
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

// 2px progress strip atop the results body while a query streams. `r` may
// still be a script/script-export result here (called before that narrowing
// in renderResults) — neither carries `pct` at all, so the `in` check reads
// identically to the original's `r && r.pct > 0` truthy check for every shape.
function streamStrip(r: Result | null): HTMLDivElement {
  return h('div', { class: 'stream-strip' },
    r && 'pct' in r && r.pct > 0
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
function renderScriptGrid(app: ResultsApp, r: ScriptResult): HTMLDivElement {
  r.colWidths = r.colWidths || {}; // persists drag-resized widths across re-renders
  const wrap = h('div', { class: 'res-table-wrap script-grid' });
  const table = document.createElement('table');
  table.className = 'res-table';
  const thead = document.createElement('thead');
  const trh = document.createElement('tr');
  for (const [cls, label] of [['script-sql', 'Statement'], ['script-res', 'Result'], ['script-time', 'Time']]) {
    trh.appendChild(h('th', { class: cls }, h('span', { class: 'h-name' }, label),
      resizeHandle(r.colWidths, PLAIN_KEY)));
  }
  thead.appendChild(trh);
  table.appendChild(thead);
  reapplyWidths(table, r.colWidths, PLAIN_KEY);
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
function renderScriptExportGrid(app: ResultsApp, r: ScriptExportResult): HTMLDivElement {
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
    trh.appendChild(h('th', { class: cls }, h('span', { class: 'h-name' }, label),
      resizeHandle(r.colWidths, PLAIN_KEY)));
  }
  thead.appendChild(trh);
  table.appendChild(thead);
  reapplyWidths(table, r.colWidths, PLAIN_KEY);
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
function scriptExportStatusCell(e: ScriptExportEntry): HTMLTableCellElement {
  const cell = h('td', { class: 'script-cell se-status-cell ' + e.status }, e.status);
  if (e.status === 'failed' && e.error) cell.appendChild(h('div', { class: 'se-error' }, e.error));
  return cell;
}

// A live now()-startedAt readout for the active row (ticked by exportScript's
// 200ms interval — see app.js); e.ms once a statement is done; blank while
// still pending/skipped (ms defaults to 0, so status — not e.ms — is the gate).
function scriptExportTime(app: ResultsApp, e: ScriptExportEntry): string {
  // `!`: 'running'/'exporting' only ever reach here with startedAt already set
  // (app.js sets it when the statement starts, before either status can hold).
  if (e.status === 'running' || e.status === 'exporting') return (app.now() - e.startedAt!).toFixed(0) + ' ms';
  if (e.status === 'pending' || e.status === 'skipped') return '';
  // `!`: every other status ('ok'/'failed'/'cancelled') is only ever reached
  // once the statement has finished, always with a recorded ms.
  return e.ms!.toFixed(0) + ' ms';
}

// Column 2 of one script row, by outcome.
function scriptOutcomeCell(app: ResultsApp, e: ScriptEntry): HTMLTableCellElement {
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

/** The rows-bearing shape openRowsViewer needs — the 'rows' variant of a
 *  `ScriptEntry` (scriptOutcomeCell only wires the click handler once
 *  `e.rows.length` is confirmed truthy) or a standalone fixture (tests call
 *  this directly). `columns`/`truncated` default when absent, matching the
 *  pre-existing `entry.columns || []` fallback below. */
export interface RowsViewerEntry {
  columns?: { name: string; type: string }[];
  rows: unknown[][];
  truncated?: boolean;
  viewerSort?: ResultSort;
  viewerWidths?: Record<string, number>;
}

/**
 * Open a right-side pane with the full rows of one script SELECT, using the same
 * sortable + resizable grid as the main results table (renderGridView). Sort state and
 * column widths are local to this pane; clicking a cell opens its value (the same
 * cell-detail drawer, stacked). Reuses the .cd-* drawer scaffold (a shared Drawer
 * primitive is deferred to #60). Escape / backdrop / ✕ closes. Exported for tests.
 */
export function openRowsViewer(app: ResultsApp, entry: RowsViewerEntry): HTMLElement {
  const doc = app.document;
  let backdrop: HTMLElement;
  let cancelDrawerDrag: () => void; // assigned by attachDrawerResize below, before close() can possibly fire
  let detachBackdrop: () => void;
  const onKey = (ev: KeyboardEvent): void => { if (ev.key === 'Escape' && isTopDrawer(doc, backdrop)) close(); };
  function close(): void {
    cancelDrawerDrag();
    detachBackdrop();
    if (backdrop) backdrop.remove();
    doc.removeEventListener('keydown', onKey, true);
  }
  const n = entry.rows.length;
  const { panel } = buildDrawerChrome(doc, {
    title: [
      h('span', { class: 'cd-name' }, 'Result rows'),
      h('span', { class: 'cd-type' }, n + (entry.truncated ? '+' : '') + ' row' + (n === 1 ? '' : 's')),
    ],
    onClose: close,
  });
  // Local sort + width state (persist for the lifetime of this open via the entry).
  entry.viewerSort = entry.viewerSort || { col: null, dir: 'asc' };
  const widths = entry.viewerWidths || (entry.viewerWidths = {});
  const body = h('div', { class: 'cd-body' });
  const paint = (): void => body.replaceChildren(renderGridView({
    columns: entry.columns || [],
    rows: entry.rows,
    // `!`: just assigned above, unconditionally, before this closure can run.
    sort: entry.viewerSort!,
    setSort: (next) => { entry.viewerSort = next; },
    widths,
    rerender: paint,
    onCell: (name, type, value) => openCellDetail(app, name, type, value),
  }));
  paint();
  panel.appendChild(body);
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
function rowLimitSelect(app: ResultsApp): HTMLLabelElement {
  const sel = h('select', {
    class: 'row-limit-select',
    title: 'Max rows to fetch — changing re-runs the query',
    onchange: (e: Event) => app.actions.setResultRowLimit(Number((e.target as HTMLSelectElement).value)),
  });
  for (const n of RESULT_ROW_LIMIT_OPTIONS) {
    sel.appendChild(h('option', { value: String(n) }, String(n)));
  }
  // Reflect the current limit by value (set after the options are attached so the
  // <select> resolves the selection correctly).
  sel.value = String(app.state.resultRowLimit);
  return h('label', { class: 'row-limit' }, h('span', { class: 'row-limit-label' }, 'Rows'), sel);
}

function buildToolbar(app: ResultsApp, r: Result | null): HTMLDivElement {
  const toolbar = h('div', { class: 'res-toolbar' });
  if (r && 'script' in r) {
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
  if (r && 'scriptExport' in r) {
    // Script-export view: a title (N statements) + live elapsed / Cancel while
    // exporting, else the total elapsed. Same "no view tabs / row-limit / Copy /
    // Export" shape as the r.script branch above — each statement owns its own file.
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
    const sg = r.schemaGraph;
    const f = sg.focus || {};
    const title = f.kind === 'table' ? f.db + '.' + f.table : f.db;
    toolbar.appendChild(h('div', { class: 'result-view-tabs' }, h('span', { class: 'res-graph-title' }, 'Schema · ' + title)));
    if (sg.partial) toolbar.appendChild(h('span', { class: 'cancelled-badge' }, 'Cancelled · view/MV sources may be incomplete'));
    toolbar.appendChild(h('div', { style: { flex: '1' } }));
    if (sg.loading && sg.tableCount != null) {
      // Phase A has already drawn the graph into the body; Phase B (per-view/MV
      // EXPLAIN AST) is still resolving — a live progress readout + Cancel, same
      // shape as the run-in-progress stat/cancel block below. Pre-Phase-A (no
      // graph in the body yet) the loading placeholder carries its own Cancel
      // instead, so this doesn't duplicate it.
      if (sg.progress) {
        toolbar.appendChild(h('div', { class: 'stat live' }, h('span', { class: 'ic spin' }, Icon.spinner()),
          h('span', { class: 'v' }, 'resolving ' + sg.progress.done + '/' + sg.progress.total + ' view sources…')));
      }
      toolbar.appendChild(h('button', {
        class: 'res-act cancel-act', title: 'Cancel schema graph',
        onclick: () => app.actions.cancelSchemaGraph({ clearResult: true }),
      }, Icon.close(), h('span', null, 'Cancel')));
      // `!`: a non-loading schemaGraph always carries its nodes array (every
      // construction site sets it) — the original .js read `.length` bare.
    } else if (!sg.loading && sg.nodes!.length) {
      // Expand is meaningless when there's nothing to draw (no connected
      // objects → the pane shows a message, not a graph).
      toolbar.appendChild(h('button', {
        // `res-act--graph-expand`: fullscreen is pan/zoom-only (no pinch), so CSS
        // hides it in mobile mode (#126) — the inline drawer graph stays usable.
        class: 'res-act res-act--graph-expand', title: 'Open the graph fullscreen with rich cards (pan & zoom)',
        onclick: () => app.actions.expandSchemaGraph(sg.focus),
      }, Icon.expand(), h('span', null, 'Expand')));
    }
    return toolbar;
  }
  let tabs: HTMLDivElement;
  if (r && r.explainView) {
    // The five EXPLAIN views — clicking re-runs the derived query (editor SQL is
    // never touched). Stays visible on error so a failing view can be switched.
    tabs = h('div', { class: 'result-view-tabs' });
    for (const v of EXPLAIN_VIEWS) {
      const icon = EXPLAIN_ICONS[v.id];
      tabs.appendChild(h('button', {
        // The pipeline view is the only graph-based EXPLAIN (pan/zoom, no pinch);
        // its marker class lets CSS hide just this tab in mobile mode (#126),
        // leaving the four text/table views available.
        class: 'result-view-tab' + (r.explainView === v.id ? ' active' : '') + (v.id === 'pipeline' ? ' result-view-tab--pipeline' : ''),
        onclick: () => app.actions.setExplainView(v.id),
      }, icon ? icon() : null, h('span', null, v.label)));
    }
  } else if (r && r.rawText != null) {
    // A single, always-active tab naming the raw format (TSV/JSON) — nothing to switch to.
    tabs = h('div', { class: 'result-view-tabs' },
      h('button', { class: 'result-view-tab active' },
        r.rawFormat === 'JSON' ? Icon.json() : Icon.table2(), h('span', null, r.rawFormat)));
  } else {
    tabs = viewSwitcherTabs(app.state.resultView.value, (id) => { app.state.resultView.value = id as 'table' | 'json' | 'panel' | 'filter'; }, false);
    tabs.appendChild(renderPanelTypePicker(app as App, r, panelHooks(app, r)));
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
        // Marker class → CSS hides fullscreen (pan/zoom-only) in mobile mode (#126).
        class: 'res-act res-act--pipeline-expand', title: 'Open the graph fullscreen (pan & zoom)',
        onclick: () => openPipelineFullscreen(app as DetachedGraphApp, r.rawText),
      }, Icon.expand(), h('span', null, 'Expand')));
    }
    if (!r.error) {
      // Expand is meaningful only for a real grid — not raw text output (no
      // columns model) and not an empty result (nothing to show) — and needs
      // the captured `source` (#185) to open an interactive, re-runnable
      // detached view. `source` is captured on exactly this class of result
      // (fmt 'Table', rows > 0), so the gate stays in lockstep.
      if (r.rawText == null && r.rows.length > 0 && r.source) {
        toolbar.appendChild(h('button', {
          class: 'res-act', title: 'Open this query in a new tab — change its filters and re-run',
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
 * The Table/JSON tabs, plus the legacy/read-only Panel button when requested
 * by the detached Data Pane. `current` is the
 * active view id; `onSelect(id)` switches it. Icons are built fresh on every
 * call (never cached/shared across the two consumers' documents — an Icon
 * element inserted into a second document would just move out of the first).
 */
function viewSwitcherTabs(current: string, onSelect: (id: string) => void, includePanel = true): HTMLDivElement {
  const tabs = h('div', { class: 'result-view-tabs' });
  const views = [
    { id: 'table', label: 'Table', icon: Icon.table2() },
    { id: 'json', label: 'JSON', icon: Icon.json() },
  ];
  if (includePanel) views.push({ id: 'panel', label: 'Panel', icon: Icon.chart() });
  for (const v of views) {
    tabs.appendChild(h('button', {
      class: 'result-view-tab' + (current === v.id ? ' active' : ''),
      onclick: () => onSelect(v.id),
    }, v.icon, h('span', null, v.label)));
  }
  return tabs;
}

export function renderJson(r: QueryResult): HTMLDivElement {
  const arr = r.rows.slice(0, visCap(r)).map((row) => {
    const o: Record<string, unknown> = {};
    r.columns.forEach((c, i) => { o[c.name] = row[i]; });
    return o;
  });
  return h('div', { class: 'json-view', tabindex: '0' }, JSON.stringify(arr, null, 2));
}

// The main results table: the shared grid wired to the global sort state + result.
export function renderTable(app: ResultsApp, r: QueryResult): HTMLElement {
  r.colWidths = r.colWidths || {}; // persists across re-renders (sort/streaming)
  return renderGridView({
    columns: r.columns,
    rows: r.rows,
    sort: app.state.resultSort,
    setSort: (next) => { app.state.resultSort = next; },
    widths: r.colWidths,
    rerender: () => renderResults(app),
    onCell: (name, type, value) => openCellDetail(app, name, type, value),
    cap: visCap(r), // honor the selectable result-row limit (#86)
  });
}

/** The discriminated `panel` argument `renderResultView` accepts — 'edit' is
 *  the workbench Panel drawer tab's own hooks (#166); 'readonly' is a
 *  render-only panel from a pre-resolved (cloned) cfg, used by the detached
 *  Data Pane's local grid/chart state. */
export type RenderResultViewPanelArgs =
  | { mode: 'edit'; hooks: PanelHooks }
  | {
      mode: 'readonly';
      resolved: PanelResolution;
      state: Record<string, unknown>;
      setChart: (chart: PanelChartInstance) => void;
    };

/** `renderResultView`'s argument bag. `app` is the literal `App` (panels.ts's
 *  registry needs it) — callers (both narrowly `ResultsApp`-typed) cast at
 *  this one boundary. */
export interface RenderResultViewArgs {
  app: App;
  view: string;
  result: QueryResult | null;
  sort: ResultSort;
  setSort: (next: ResultSort) => void;
  widths: Record<string, number> | undefined;
  rerender: () => void;
  onCell: (name: string, type: string, value: unknown) => void;
  cap: number | undefined;
  panel: RenderResultViewPanelArgs;
}

/**
 * Render the body node for the current Table/JSON/Panel view of a structured
 * result — the ONE dispatch shared by the live results pane (renderResults) and
 * the detached Data view (expandDataPane), so the two never drift into parallel
 * copies (#185). Table/JSON are identical across surfaces; the Panel view
 * differs by surface, selected via `panel.mode`:
 *   - `'edit'`     — the workbench Panel drawer (type picker + config), via
 *                    renderPanelView(app, r, panel.hooks);
 *   - `'readonly'` — a render-only panel from a pre-resolved (cloned) cfg, via
 *                    renderResolvedPanel with `readonly: true` — the detached
 *                    surface, whose `panel.state`/`panel.setChart` own the grid
 *                    state + chart instance.
 * `sort`/`setSort`/`widths`/`rerender`/`onCell`/`cap` are injected so each
 * surface supplies its own state (the live pane's global `resultSort` +
 * `colWidths`; the detached view's local holders) and its own cell-drawer
 * document realm via `onCell`. Panel always renders (a text panel needs no
 * rows); Table/JSON show the "0 rows" placeholder for an empty result. Callers
 * handle the no-result-at-all case (only the Panel view renders with a null
 * result). Exported for tests.
 */
export function renderResultView({ app, view, result, sort, setSort, widths, rerender, onCell, cap, panel }: RenderResultViewArgs): HTMLElement {
  const r = result;
  if (view === 'panel') {
    if (panel.mode === 'readonly') {
      const { node } = renderResolvedPanel(app, panel.resolved, r, {
        surface: 'workbench',
        state: panel.state,
        rerender,
        readonly: true, // render-only: no config bar, no editor
        cap,
        onCell,
        setChart: panel.setChart,
      });
      return node;
    }
    return renderPanelView(app, r, panel.hooks);
  }
  // `!`: every non-panel view is only ever reached with a real result —
  // renderResults gates the null+non-panel+non-filter case with its own
  // empty-prompt branch, and expandDataPane's `current` is never null (it
  // starts as the expand-time snapshot and only ever replaces itself with
  // another real StreamResult-shaped run).
  if (r!.rows.length === 0) {
    return h('div', { class: 'placeholder' }, h('div', null, 'Query returned 0 rows.'));
  }
  if (view === 'json') return renderJson(r!);
  return renderGridView({ columns: r!.columns, rows: r!.rows, sort, setSort, widths: widths!, rerender, onCell, cap });
}

/**
 * Expand the current grid into an interactive detached view — a real browser
 * tab, else the in-app overlay (#100/#185). Unlike the old frozen snapshot, the
 * detached view is a self-contained, re-runnable surface bound to the result's
 * captured `source` ({sql, tabId, rowLimit, title, description} — attached by
 * run() on a normal row-returning result): its Table/JSON/Panel switcher, sort,
 * column widths, and chart instance are local, but its `{name:Type}` filter row
 * reads/writes the SAME shared `state.varValues`/`filterActive` stores as the
 * SQL Browser and dashboards (a value entered anywhere is offered everywhere).
 * A committed filter (or the Refresh button) re-runs ONLY this detached query —
 * full streaming/cap/abort parity via the shared `app.exec.executeRead` seam, with
 * its own AbortController + generation guard so a newer/stale response can never
 * overwrite the current result and closing aborts in flight. The main workbench
 * tab's result/view/sort/panel/history and global running state are untouched.
 * The captured source SQL and originating session are used even after the
 * editor/active tab changes. Opening issues no request (the workbench snapshot
 * shows immediately); Copy always copies the current detached result. Exported
 * for tests.
 */
export function expandDataPane(app: ResultsApp, r: QueryResult): DetachedView {
  const mainDoc = app.document;
  // `!`: expandDataPane is only ever reached from buildToolbar's own Expand
  // button, gated on `r.source` being truthy — a caller invoking this directly
  // (tests) always builds a fixture carrying its own `.source` too.
  const source = r.source!;
  // Capture the originating tab's ClickHouse session AT EXPAND TIME (the active
  // tab is the source tab now) and reuse it for the life of this view, so a
  // source depending on session state (temp tables / SET) re-filters against
  // the same session — never re-reading app.activeTab() at refresh time, which
  // may have changed. A plain SELECT has no session and runs session-less.
  const sessionId = (app.activeTab() && app.activeTab().chSession) || null;
  // Render-only panel snapshot (#166): the source tab's panel cfg is cloned
  // once, at expand time (tabPanel clones), and re-resolved against the current
  // columns on every repaint — the detached view keeps no panel editor (v1
  // scope), and later edits in the live tab never leak in.
  const savedPanel = tabPanel(app.activeTab());
  // Analyze the captured source ONCE — its `{name:Type}` fields drive the
  // filter row; the SQL is fixed for the life of this view.
  const analysis: ParameterAnalysis = analyzeParameterizedSources([
    { id: 'detached', label: 'detached data', kind: 'tab', sql: source.sql, bindPolicy: 'row-returning' },
  ]);
  const fields = fieldControls(analysis);

  return openInDetachedTab(app as DetachedViewApp, {
    title: source.title, // browser-tab title + the primitive's bar title
    mode: 'grid',
    mount: ({ doc, bar, body, close, closeBtn }: MountCtx) => {
      const isTab = doc !== mainDoc;
      // Header: replace the primitive's plain title span with a real heading +
      // (optional) description — plain text only, full value in the title attr,
      // clamped by CSS. Close ✕ (overlay only) sits at the bar's trailing end.
      bar.classList.add('detached-bar');
      const header = h('div', { class: 'detached-head' },
        h('h2', { class: 'detached-title', title: source.title }, source.title));
      if (source.description) {
        header.appendChild(h('div', { class: 'detached-desc', title: source.description }, source.description));
      }
      const titleSpan = bar.querySelector('.graph-overlay-title');
      if (titleSpan) titleSpan.replaceWith(header); else bar.appendChild(header);
      if (closeBtn) bar.appendChild(closeBtn);

      // Detached-local view/render state (never the live tab's).
      const view = { current: 'table' };
      const panelState: Record<string, unknown> = {};
      let sort: ResultSort = { col: null, dir: 'asc' };
      const widths: Record<string, number> = {};
      let chartInstance: PanelChartInstance | null = null;
      let current: QueryResult = r; // the current result — starts as the expand-time snapshot
      // Concurrency: a fresh generation + AbortController per run; a stale or
      // post-close response is discarded, never painted.
      let gen = 0;
      let running = false;
      let ac: AbortController | null = null;
      let closed = false;
      let statEl: HTMLElement | null = null;
      let refreshBtn: HTMLButtonElement | null = null;
      let statusEl: HTMLElement | null = null;

      const inner = h('div', { class: 'res-body' });
      // Render `res` (defaults to the committed `current`) into the body.
      // Commit-on-success (#198): a rerun NEVER paints its in-flight result —
      // paint runs only on view changes, local sorting, the initial render, and
      // a successful current-generation commit. So the previous committed result
      // stays on screen through streaming (no metadata-only "0 rows" flash) and
      // the chart is not destroyed/recreated per chunk.
      const paint = (res: QueryResult = current): void => withDocument(doc, () => {
        // Destroy the previous chart before rebuilding — same reasoning as
        // renderResults' destroy-before-rebuild (nothing may leak its canvas).
        if (chartInstance) { chartInstance.destroy(); chartInstance = null; }
        inner.replaceChildren(renderResultView({
          app: app as App,
          view: view.current,
          result: res,
          sort,
          setSort: (next) => { sort = next; },
          widths,
          rerender: () => paint(res),
          onCell: (name, type, value) => openCellDetail(app, name, type, value, doc),
          cap: visCap(res),
          panel: {
            mode: 'readonly',
            resolved: resolvePanel(savedPanel, { columns: res.columns, rows: res.rows, fieldConfig: savedPanel?.fieldConfig, serverVersion: app.state.serverVersion }),
            state: panelState,
            setChart: (c) => { chartInstance = c; },
          },
        }));
        if (statEl) statEl.textContent = res.rows.length + ' rows' + (res.capped ? ' (capped)' : '');
      });

      let tabsEl = viewSwitcherTabs(view.current, selectView);
      function selectView(id: string): void {
        // Switching views is local and NEVER re-runs SQL.
        view.current = id;
        const next = viewSwitcherTabs(id, selectView);
        tabsEl.replaceWith(next);
        tabsEl = next;
        paint();
      }

      const setStatus = (t: string): void => { if (statusEl) statusEl.textContent = t; };

      // Settle this run's chrome (running flag + Refresh enabled + status). A
      // blocked or superseded-then-blocked run must reset these too, else the
      // Refresh button (disabled by the aborted in-flight run) stays stuck.
      const settle = (msg: string): void => { running = false; if (refreshBtn) refreshBtn.disabled = false; setStatus(msg); };

      // Re-run ONLY this detached query with the current shared filter values.
      async function rerun(): Promise<void> {
        if (closed) return;
        const myGen = ++gen;
        if (ac) ac.abort(); // supersede any in-flight detached request
        ac = new AbortController();
        const { signal } = ac;
        const batch = prepareParameterizedBatch(analysis, {
          values: app.state.varValues,
          active: effectiveFilterActive(app.state.varValues, app.state.filterActive),
          wallNowMs: app.wallNow(),
          validationMode: 'execute',
        });
        const src = batch.sources[0];
        const blockers = src.missing.concat(src.invalid);
        // A blocked run keeps the previous result visible + shows why (#173) —
        // and re-enables Refresh even if it just superseded an in-flight run.
        if (blockers.length) { settle('Enter a value for: ' + blockers.join(', ')); return; }
        if (src.errors.length) { settle(src.errors[0]); return; }
        running = true;
        setStatus('Running…');
        if (refreshBtn) refreshBtn.disabled = true;
        if (!(await app.conn.ensureFreshToken())) {
          if (myGen === gen && !closed) settle('Not signed in');
          return;
        }
        const execution = panelExecution(savedPanel, mergedSourceSql(src, source.sql), {
          format: 'Table', rowLimit: source.rowLimit,
          params: { ...(sessionId ? { session_id: sessionId } : {}), ...mergedSourceArgs(src) },
        });
        if (execution.error) { settle(execution.error); return; }
        // `!`: `defaults.format: 'Table'` is always supplied above, so
        // `execution.format` is always populated whether or not the KPI arm
        // ends up owning transport (it overrides to 'KPI' rather than clearing it).
        const result = newResult(execution.format!, execution.rowLimit);
        await app.exec.executeRead(result, {
          sql: mergedSourceSql(src, source.sql),
          format: execution.format,
          rowLimit: execution.rowLimit,
          // Native param_<name> bindings + the captured session (when any).
          params: execution.params,
          signal,
          // Progress-only streaming (#198): update the lightweight status text as
          // rows arrive, but NEVER paint the in-flight result and NEVER touch the
          // committed `current` / stat / view / chart — only the winning
          // completion below commits and repaints. A stale/closed chunk is dropped.
          onChunk: () => {
            if (myGen !== gen || closed) return;
            const rowsRead = Number(result.progress?.rows) || 0;
            setStatus(rowsRead > 0 ? `Running… ${formatRows(rowsRead)} rows read` : 'Running…');
          },
        });
        if (myGen !== gen || closed) return; // superseded or closed → discard silently
        // The in-flight result was never painted, so failure/cancel needs no
        // restore repaint — the committed `current` is still on screen (#198).
        if (result.cancelled) { settle(''); return; }
        if (result.error) { settle(result.error); return; }
        current = result;
        // #171: record the winning run's bound params via the shared recorder.
        app.params.recordBoundParams(src.statements.flatMap((s) => s.boundParams));
        settle('');
        paint();
      }

      const toolbar = h('div', { class: 'res-toolbar' },
        tabsEl,
        h('div', { class: 'stat' },
          h('span', { class: 'ic' }, Icon.rows()),
          (statEl = h('span', { class: 'v' }, current.rows.length + ' rows' + (current.capped ? ' (capped)' : '')))),
        h('div', { style: { flex: '1' } }),
        h('button', {
          class: 'res-act', title: 'Copy results to clipboard',
          onclick: () => app.actions.copySnapshot(current, doc),
        }, Icon.copy(), h('span', null, 'Copy')));

      const pane = h('div', { class: 'results data-pane-view' }, toolbar);
      // Filter row (#185): only when the source declares `{name:Type}` fields —
      // omitted entirely otherwise (no empty toolbar). Committing a field or
      // clicking Refresh re-runs only this detached query.
      let filterBarDispose: (() => void) | null = null;
      if (fields.length) {
        const getField = (name: string, mode: ValidationMode): PreparedFieldState => prepareParameterizedBatch(analysis, {
          values: app.state.varValues,
          active: effectiveFilterActive(app.state.varValues, app.state.filterActive),
          wallNowMs: app.wallNow(),
          validationMode: mode,
        }).fields[name];
        // A committed field re-runs only this detached query (rerun ignores the
        // param name buildFilterBar passes — a single source re-runs wholesale).
        const filterBar = buildFilterBar(app as FilterBarApp, fields, rerun, getField, { document: doc, ariaLabel: 'Query filters' });
        filterBarDispose = filterBar.dispose;
        refreshBtn = h('button', {
          class: 'res-act detached-refresh', title: 'Re-run this query with the current filter values',
          onclick: () => rerun(),
        }, Icon.play(), h('span', null, 'Refresh'));
        statusEl = h('div', { class: 'detached-status', role: 'status' });
        pane.appendChild(h('div', { class: 'detached-filter-row' }, filterBar.el, refreshBtn, statusEl));
      }
      pane.appendChild(inner);
      body.appendChild(pane);
      paint();

      // Esc closes an open cell-detail drawer first (its own listener, keyed
      // off isTopDrawer, handles that); a second Esc — no drawer left — closes
      // the pane (overlay only; a real tab closes via the browser).
      const onKey = (e: KeyboardEvent): void => {
        if (e.key !== 'Escape' || doc.querySelector('.cd-backdrop')) return;
        e.stopPropagation();
        close();
      };
      if (!isTab) doc.addEventListener('keydown', onKey, true);
      // Teardown (overlay close, or the primitive's pagehide in a real tab):
      // mark closed so a late response can't paint, abort any in-flight request,
      // and destroy the live chart instance.
      return () => {
        closed = true;
        if (ac) ac.abort();
        if (chartInstance) { chartInstance.destroy(); chartInstance = null; }
        filterBarDispose?.();
        if (!isTab) doc.removeEventListener('keydown', onKey, true);
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
function isTopDrawer(doc: Document, el: Element | undefined): boolean {
  const all = doc.querySelectorAll('.cd-backdrop');
  return all[all.length - 1] === el;
}

export function openCellDetail(app: ResultsApp, name: string, type: string, value: unknown, targetDoc?: Document): HTMLElement {
  const doc = targetDoc || app.document;
  const text = value == null ? '' : String(value);
  let backdrop: HTMLElement;
  let cancelDrawerDrag: () => void; // assigned by attachDrawerResize below, before close() can possibly fire
  let detachBackdrop: () => void;
  const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape' && isTopDrawer(doc, backdrop)) close(); };
  function close(): void {
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
    const showSource = (): void => body.replaceChildren(h('pre', { class: 'cd-pre' }, prettyValue(text)));

    const { panel } = buildDrawerChrome(doc, {
      title: [
        h('span', { class: 'cd-name' }, name),
        type ? h('span', { class: 'cd-type' }, type) : null,
      ],
      onClose: close,
    });
    cancelDrawerDrag = attachDrawerResize(app, panel, doc);

    // A Rendered ↔ Source toggle, defaulting to Rendered. `renderRendered`
    // builds the rendered node; Source is always the reindented `<pre>`. Shared
    // by the HTML (sandboxed iframe) and Markdown (#332: the doc-pane's
    // top-quality `renderDocMarkdown` viewer) previews.
    const mountToggle = (renderRendered: () => Node): void => {
      const seg = h('div', { class: 'cd-toggle' });
      const setMode = (mode: 'rendered' | 'source'): void => withDocument(doc, () => {
        seg.replaceChildren(
          h('button', { class: 'cd-seg' + (mode === 'rendered' ? ' on' : ''), onclick: () => setMode('rendered') }, 'Rendered'),
          h('button', { class: 'cd-seg' + (mode === 'source' ? ' on' : ''), onclick: () => setMode('source') }, 'Source'));
        if (mode === 'rendered') body.replaceChildren(renderRendered());
        else showSource();
      });
      panel.append(seg, body);
      setMode('rendered');
    };

    if (looksLikeHtml(text)) {
      mountToggle(() => {
        const frame = h('iframe', { class: 'cd-frame', sandbox: '' });
        frame.setAttribute('srcdoc', text);
        return frame;
      });
    } else if (looksLikeMarkdown(text)) {
      // No `codeViewer` seam → SQL-tagged fences fall back to a plain
      // `<pre><code>` (the cell drawer mounts no CM6), everything else renders
      // through the same bounded, fail-closed viewer the docs pane uses.
      mountToggle(() => renderDocMarkdown(doc, parseDocMarkdown(text, { linkPolicy: defaultDocLinkPolicy })));
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
