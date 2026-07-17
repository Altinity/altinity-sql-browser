// The read-only Dashboard page (#149 / #240 / #280 / #286). Phase 4 of #280
// FLIPS Dashboard membership reads off `spec.favorite` and onto
// `dashboard.tiles[]`: this module resolves the current `StoredWorkspaceV1`
// (via `app.loadDashboardWorkspace()` — the phase-2 repository, migrating the
// legacy favorites/layout keys once when no aggregate exists), constructs a
// standalone `DashboardViewerSession` over that document + the workspace
// queries, and renders the DOM from the session's `state` signal. The
// heavy runtime — presentation resolution, the filter/tile execution waves
// (with #235 parallelism), bounded concurrency, per-tile cancellation, and the
// normative `flow@1` layout math — all live in the session and its pure
// dependencies (each 100%-covered); this module is the render/interaction
// shell over them.
//
// Structural edits (reorder, span/height, layout preset) go through the
// phase-3 authoring commands (`applyCommand` — `move-tile`/`update-placement`/
// `change-layout`), are mirrored into the viewer with `syncDocument` (no
// re-execution), and best-effort persisted through the repository. Accessible
// keyboard controls are the first-class reorder/resize mechanism; pointer drag
// is an equivalent alternative. The `spec.favorite` dual-WRITE stays until GA
// (the star action in the Workbench); only the READ is flipped here.
//
// check-boundaries.mjs keeps this file off `src/ui/app.ts`; everything it needs
// is injected on the `app` controller.

import { effect } from '@preact/signals-core';
import { h } from './dom.js';
import { Icon as IconUntyped } from './icons.js';
import { renderResolvedPanel } from './panels.js';
import { resolvePanel } from '../core/panel-cfg.js';
import type { Column } from '../core/panel-cfg.js';
import { DASH_TILE_ROW_CAP, DASH_TABLE_DISPLAY_CAP } from '../core/dashboard.js';
import {
  formatBytes as formatBytesUntyped, formatRows as formatRowsUntyped,
} from '../core/format.js';
import { analyzeParameterizedSources, fieldControls } from '../core/param-pipeline.js';
import { queryDashboardRole } from '../dashboard/model/workspace-semantics.js';
import { renderKpiCards, KPI_STREAM_ARIA } from './kpi-panel.js';
import {
  filterClearButton, filterClearAllButton, filterActiveCount, filterBlockingBadge,
} from './filter-bar.js';
import { createDashboardViewerSession } from '../dashboard/application/dashboard-viewer-session.js';
import type {
  DashboardViewerSession, DashboardViewState, ViewerTileState, ViewerFilterState,
} from '../dashboard/application/dashboard-viewer-session.js';
import { defaultLayoutRegistry } from '../dashboard/layouts/layout-registry.js';
import { flowLayoutPlugin } from '../dashboard/layouts/flow-layout.js';
import { applyCommand } from '../dashboard/application/dashboard-commands.js';
import { createQueryResolver } from '../dashboard/application/dashboard-query-resolver.js';
import type {
  DashboardDocumentV1, DashboardFilterDefinitionV1, FlowPresetV1, FlowHeightV1,
  SavedQueryV2, StoredWorkspaceV1,
} from '../generated/json-schema.types.js';
import type { App, AppDom } from './app.types.js';
import type { AppState } from '../state.js';
import type { ConnectionSession } from '../application/connection-session.js';
import type { QueryExecutionService } from '../application/query-execution-service.js';
import type { WorkbenchParameterSession } from '../application/workbench-parameter-session.js';
import type { WorkspaceRepository } from '../workspace/workspace-repository.js';

// icons.js is unconverted — the six icons this module appends, pinned to the
// one honest shape (same wrapper the pre-#286 module used).
const Icon: {
  star(filled?: boolean): SVGElement;
  spinner(): SVGElement;
  refresh(): SVGElement;
  sun(): SVGElement;
  moon(): SVGElement;
  arrow(): SVGElement;
} = IconUntyped;

const formatRows: (n: number | null | undefined) => string = formatRowsUntyped;
const formatBytes: (n: number | null | undefined) => string = formatBytesUntyped;

/** The narrow `app` surface this render module reads (not the full App —
 *  matches the convention results.ts/filter-bar.ts established). */
export interface DashboardApp {
  document: Document;
  state: AppState;
  dom: AppDom;
  root: Element | null;
  toggleTheme(): void;
  conn: Pick<ConnectionSession, 'basePath' | 'host' | 'ensureFreshToken' | 'chCtx'>;
  exec: Pick<QueryExecutionService, 'executeRead'>;
  now(): number;
  wallNow(): number;
  params: Pick<WorkbenchParameterSession, 'recordBoundParams'>;
  workspace: Pick<WorkspaceRepository, 'commit'>;
  loadDashboardWorkspace(): Promise<StoredWorkspaceV1 | null>;
}

const FLOW_HEIGHTS: FlowHeightV1[] = ['compact', 'medium', 'large'];
const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/**
 * Build a segmented control (the flow preset switcher). `options` are
 * `[value,label,title?]`; exactly one reads active from `getActive()`;
 * `onPick(value)` fires on a click; `sync()` repaints the active button.
 */
type SegOption = [value: string, label: string, title?: string];
function buildSeg(
  cls: string, options: SegOption[], getActive: () => string, onPick: (value: string) => void, ariaLabel: string,
): { el: HTMLElement; sync: () => void } {
  const btns = options.map(([, label, title]) => h('button', { class: 'dash-seg-btn', type: 'button', title }, label));
  const sync = (): void => btns.forEach((b, i) => {
    const on = options[i][0] === getActive();
    b.classList.toggle('is-active', on);
    b.setAttribute('aria-pressed', String(on));
  });
  btns.forEach((b, i) => { b.onclick = () => onPick(options[i][0]); });
  const el = h('div', { class: 'dash-seg ' + cls, role: 'group', 'aria-label': ariaLabel }, ...btns);
  sync();
  return { el, sync };
}

/** A tile footer meta row (rows · ms · bytes), with a truncation note. */
function tileFooter(meta: NonNullable<ViewerTileState['meta']>): HTMLElement[] {
  const parts = [
    h('span', null, formatRows(meta.rows) + ' rows'),
    h('span', null, meta.ms + ' ms'),
    h('span', null, formatBytes(meta.bytes) + ' scanned'),
  ];
  if (meta.truncated) {
    parts.push(h('span', null,
      'first ' + DASH_TILE_ROW_CAP.toLocaleString() + ' rows fetched — sorting/charts cover this prefix only'));
  }
  return parts;
}

/** The stable per-tile DOM the reconciler reuses across state publishes (so a
 *  chart is painted once, not thrashed on every loading/progress tick). */
interface TileEl {
  card: HTMLElement;
  body: HTMLElement;
  foot: HTMLElement;
  moveEarlier: HTMLButtonElement;
  moveLater: HTMLButtonElement;
  spanSel: HTMLSelectElement;
  heightSel: HTMLSelectElement;
  panelState: { key: string;[k: string]: unknown } | null;
  destroy: (() => void) | null;
  paintedRows: unknown[][] | null;
}

/** Synthesize a filter definition per distinct `{name:Type}` panel-tile param
 *  that no explicit filter already targets — so a migrated Dashboard (whose
 *  persisted `filters` is empty) still surfaces its implicit param filters.
 *  Runtime-only; never persisted. */
function synthesizeImplicitFilters(
  doc: DashboardDocumentV1, queryById: Map<string, SavedQueryV2>,
): DashboardFilterDefinitionV1[] {
  const declared = new Set((doc.filters || []).map((f) => f.parameter));
  const panelSources = (doc.tiles || [])
    .map((tile) => queryById.get(tile.queryId))
    .filter((query): query is SavedQueryV2 => !!query && queryDashboardRole(query) === 'panel')
    .map((query, index) => ({ id: 't' + index, kind: 'tile', sql: query.sql, bindPolicy: 'row-returning' }));
  const analysis = analyzeParameterizedSources(panelSources);
  const out: DashboardFilterDefinitionV1[] = [];
  for (const control of fieldControls(analysis)) {
    if (!declared.has(control.name)) out.push({ id: control.name, parameter: control.name });
  }
  return out;
}

/** Render the dashboard into `app.root`. */
export async function renderDashboard(app: DashboardApp): Promise<void> {
  const { document: doc, state } = app;
  doc.documentElement.setAttribute('data-theme', state.theme);
  doc.documentElement.setAttribute('data-density', state.density);
  app.dom = {};

  const workspace = await app.loadDashboardWorkspace();
  const queries: SavedQueryV2[] = workspace ? workspace.queries : state.savedQueries;
  const queryById = new Map<string, SavedQueryV2>();
  for (const query of queries) if (!queryById.has(query.id)) queryById.set(query.id, query);

  // The live document — layout/order edits replace it; membership is read from
  // `dashboard.tiles[]` (NOT `savedQueries.filter(queryFavorite)`).
  let currentDoc: DashboardDocumentV1 = workspace && workspace.dashboard
    ? workspace.dashboard
    : {
      documentVersion: 1, id: 'empty', title: state.libraryName.value, revision: 1,
      layout: { type: 'flow', version: 1, preset: 'full-width', items: {} }, filters: [], tiles: [],
    };
  let committedRevision = currentDoc.revision;

  // Merge explicit + synthesized implicit filters for the viewer.
  const viewerDoc: DashboardDocumentV1 = {
    ...currentDoc, filters: [...(currentDoc.filters || []), ...synthesizeImplicitFilters(currentDoc, queryById)],
  };

  const session: DashboardViewerSession = createDashboardViewerSession({
    document: viewerDoc,
    queries,
    exec: app.exec,
    connection: { ensureFreshToken: () => app.conn.ensureFreshToken() },
    registry: defaultLayoutRegistry,
    now: () => app.now(),
    wallNow: () => app.wallNow(),
    isMobile: () => state.isMobile.value,
    onAuthFailed: () => app.conn.chCtx.onSignedOut(),
    recordBoundParams: (bp) => app.params.recordBoundParams(bp),
  });

  // ── Header chrome ───────────────────────────────────────────────────────
  const tileCountLabel = h('span');
  const tileCount = h('span', { class: 'dash-chip dash-fav' }, Icon.star(true), tileCountLabel);
  const updated = h('span', { class: 'dash-updated' });
  const refreshBtn = h('button', {
    class: 'dash-btn dash-refresh', title: 'Re-run all tiles', 'aria-label': 'Refresh dashboard',
  }, Icon.refresh(), h('span', { class: 'dash-refresh-label' }, 'Refresh'));
  refreshBtn.onclick = () => session.refresh();
  const themeBtn = h('button', {
    class: 'dash-icobtn', title: 'Toggle theme', 'aria-label': 'Toggle theme', onclick: () => app.toggleTheme(),
  });
  themeBtn.appendChild(state.theme === 'dark' ? Icon.sun() : Icon.moon());
  app.dom.themeBtn = themeBtn;

  const header = h('div', { class: 'dash-header' },
    h('a', {
      class: 'dash-back', href: app.conn.basePath || '/sql', title: 'Back to SQL Browser', 'aria-label': 'Back to SQL Browser',
    }, Icon.arrow(), h('span', { class: 'dash-back-label' }, 'SQL Browser')),
    h('div', { class: 'dash-title' }, currentDoc.title || state.libraryName.value),
    tileCount,
    h('div', { class: 'dash-spacer', style: { flex: '1' } }),
    h('span', { class: 'dash-chip dash-src', title: app.conn.host() }, h('span', { class: 'dash-dot' }), app.conn.host()),
    updated, themeBtn, refreshBtn);

  // ── Preset switcher (change-layout command) ───────────────────────────────
  const presetSeg = buildSeg('dash-seg-layout', [
    ['full-width', 'Full width', 'One tile per row using all available width'],
    ['report', 'Report', 'One centered, taller tile per row'],
    ['columns-2', '2 columns', 'Arrange tiles in two columns'],
    ['columns-3', '3 columns', 'Arrange tiles in three columns'],
  ], () => (typeof currentDoc.layout.preset === 'string' ? currentDoc.layout.preset : 'full-width'),
  (preset) => { runCommand({ type: 'change-layout', layout: { ...currentDoc.layout, preset: preset as FlowPresetV1 } }); },
  'Dashboard layout');
  const layoutWrap = h('div', { class: 'dash-layout-wrap' }, h('span', { class: 'dash-seg-label' }, 'Layout'), presetSeg.el);

  // ── Filter bar (viewer-driven) ────────────────────────────────────────────
  const filterHost = h('div', { class: 'dash-filter-host' });
  const filterCountNode = h('span', { class: 'dash-filter-count-host' });
  const clearAllNode = h('span', { class: 'dash-filter-clear-all-host' });
  const filterFields = new Map<string, { input: HTMLInputElement | HTMLSelectElement; badgeHost: HTMLElement }>();

  function buildFilterBar(initial: ViewerFilterState[]): void {
    filterFields.clear();
    const fields = initial.map((f) => {
      const badgeHost = h('span', { class: 'dash-filter-badge-host' });
      let input: HTMLInputElement | HTMLSelectElement;
      if (f.options && f.options.length) {
        const sel = h('select', { class: 'var-input' },
          h('option', { value: '' }, 'All'),
          ...f.options.map((o) => h('option', { value: o.value }, o.label)));
        sel.value = typeof f.value === 'string' ? f.value : '';
        sel.onchange = () => { session.setFilter(f.id, sel.value); };
        input = sel;
      } else {
        const inp = h('input', { class: 'var-input', type: 'text', 'aria-label': f.label });
        inp.value = typeof f.value === 'string' ? f.value : '';
        inp.onchange = () => { session.setFilter(f.id, inp.value); };
        inp.onkeydown = (event: KeyboardEvent) => { if (event.key === 'Enter') session.setFilter(f.id, inp.value); };
        input = inp;
      }
      const clear = filterClearButton({ label: f.label, onClear: () => session.clearFilter(f.id) });
      filterFields.set(f.id, { input, badgeHost });
      return h('label', { class: 'var-field' }, h('span', { class: 'var-name' }, f.label), input, clear, badgeHost);
    });
    filterHost.replaceChildren(...(fields.length ? [...fields, clearAllNode, filterCountNode] : []));
  }

  function updateFilterBar(sview: DashboardViewState): void {
    // A text field upgrades to a select once its filter-source options land.
    const needsRebuild = sview.filters.some((f) => {
      const field = filterFields.get(f.id);
      return !!field && !!f.options && f.options.length > 0 && field.input.tagName !== 'SELECT';
    });
    if (needsRebuild) buildFilterBar(sview.filters);
    for (const f of sview.filters) {
      const field = filterFields.get(f.id);
      if (field) field.badgeHost.replaceChildren(...(f.blocking ? [filterBlockingBadge(f.blocking)] : []));
    }
    clearAllNode.replaceChildren(filterClearAllButton({ active: sview.activeFilterCount > 0, onClearAll: () => session.clearAllFilters() }));
    filterCountNode.replaceChildren(filterActiveCount(sview.activeFilterCount));
  }

  const filterDiagnosticsHost = h('div', { class: 'dash-filter-diagnostics' });
  const liveRegion = h('div', {
    class: 'dash-live', role: 'status', 'aria-live': 'polite',
    style: { position: 'absolute', width: '1px', height: '1px', overflow: 'hidden' },
  });
  const grid = h('div', { class: 'dash-grid' });
  const empty = h('div', { class: 'dash-empty', style: { display: currentDoc.tiles.length ? 'none' : '' } },
    'No tiles yet — star a query in the Library to add it to the dashboard.');

  // ── Structural commands (reorder / resize / preset) ───────────────────────
  function runCommand(command: Parameters<typeof applyCommand>[1]): void {
    const applied = applyCommand(currentDoc, command, {
      resolver: createQueryResolver(queries), genTileId: () => 'tile', plugin: flowLayoutPlugin,
    });
    if (!applied.ok) return;
    const normalized = flowLayoutPlugin.normalize(applied.dashboard);
    currentDoc = normalized;
    presetSeg.sync();
    session.syncDocument({
      ...normalized, filters: [...(normalized.filters || []), ...synthesizeImplicitFilters(normalized, queryById)],
    });
    // Best-effort persistence (revision increments once per successful commit).
    if (workspace) {
      const candidate: StoredWorkspaceV1 = {
        storageVersion: 1, id: workspace.id, name: workspace.name, queries: workspace.queries,
        dashboard: { ...normalized, revision: committedRevision + 1 },
      };
      app.workspace.commit(candidate).then((result) => { if (result.ok) committedRevision += 1; });
    }
  }

  function currentPlacement(tileId: string): { span?: number; height?: string } {
    const items = isObject(currentDoc.layout.items) ? currentDoc.layout.items : {};
    const placement = items[tileId];
    return isObject(placement) ? placement as { span?: number; height?: string } : {};
  }

  function moveTile(tileId: string, delta: number): void {
    const order = currentDoc.tiles.map((t) => t.id);
    const index = order.indexOf(tileId);
    const toIndex = index + delta;
    if (index < 0 || toIndex < 0 || toIndex >= order.length) return;
    runCommand({ type: 'move-tile', tileId, toIndex });
    // Focus stays on the moved tile's control; announce the new position.
    const tileEl = tileEls.get(tileId);
    (delta < 0 ? tileEl?.moveEarlier : tileEl?.moveLater)?.focus();
    liveRegion.textContent = `Moved tile to position ${toIndex + 1} of ${order.length}`;
  }

  function setPlacement(tileId: string, patch: { span?: number; height?: string }): void {
    runCommand({ type: 'update-placement', tileId, placement: { ...currentPlacement(tileId), ...patch } });
  }

  // ── Tile DOM ──────────────────────────────────────────────────────────────
  const tileEls = new Map<string, TileEl>();
  let dragTileId: string | null = null;

  function ensureTileEl(ts: ViewerTileState): TileEl {
    const existing = tileEls.get(ts.tileId);
    if (existing) return existing;
    const titleEl = h('span', { class: 'dash-tile-name', title: ts.title }, ts.title);
    const moveEarlier = h('button', { type: 'button', class: 'dash-tile-move', title: 'Move earlier', 'aria-label': `Move ${ts.title} earlier`, onclick: () => moveTile(ts.tileId, -1) }, '‹');
    const moveLater = h('button', { type: 'button', class: 'dash-tile-move', title: 'Move later', 'aria-label': `Move ${ts.title} later`, onclick: () => moveTile(ts.tileId, 1) }, '›');
    const spanSel = h('select', { class: 'dash-tile-span', 'aria-label': `${ts.title} width` },
      ...[1, 2, 3].map((n) => h('option', { value: String(n) }, `${n}×`)));
    spanSel.onchange = () => setPlacement(ts.tileId, { span: Number(spanSel.value) });
    const heightSel = h('select', { class: 'dash-tile-height', 'aria-label': `${ts.title} height` },
      ...FLOW_HEIGHTS.map((height) => h('option', { value: height }, height)));
    heightSel.onchange = () => setPlacement(ts.tileId, { height: heightSel.value });
    const controls = h('div', { class: 'dash-tile-controls' }, moveEarlier, moveLater, spanSel, heightSel);
    const head = h('div', { class: 'dash-tile-head' }, titleEl, controls);
    const body = h('div', { class: 'dash-tile-body' });
    const foot = h('div', { class: 'dash-tile-foot' });
    const card = h('div', { class: 'dash-tile', draggable: 'true' }, head, body, foot);
    card.addEventListener('dragstart', () => { dragTileId = ts.tileId; });
    card.addEventListener('dragover', (event) => event.preventDefault());
    card.addEventListener('drop', (event) => {
      event.preventDefault();
      if (dragTileId && dragTileId !== ts.tileId) {
        runCommand({ type: 'move-tile', tileId: dragTileId, toIndex: currentDoc.tiles.map((t) => t.id).indexOf(ts.tileId) });
      }
      dragTileId = null;
    });
    const tileEl: TileEl = { card, body, foot, moveEarlier, moveLater, spanSel, heightSel, panelState: null, destroy: null, paintedRows: null };
    tileEls.set(ts.tileId, tileEl);
    return tileEl;
  }

  function destroyChart(tileEl: TileEl): void { if (tileEl.destroy) { tileEl.destroy(); tileEl.destroy = null; } }

  // Paint an ordinary (non-KPI) tile's result once per new result. Only ever
  // called for a 'ready' tile, so columns/rows/meta/panel are all present (no
  // defensive `|| []` — the viewer guarantees them on `ready`).
  function paintPanel(ts: ViewerTileState, tileEl: TileEl): void {
    if (ts.rows === tileEl.paintedRows) return;
    destroyChart(tileEl);
    const panel = (ts.panel || {}) as Record<string, unknown>;
    const columns = ts.columns as Column[];
    const rows = ts.rows as unknown[][];
    const resolved = resolvePanel(panel as Parameters<typeof resolvePanel>[0], {
      columns, rows, fieldConfig: panel.fieldConfig as never, serverVersion: state.serverVersion,
    });
    tileEl.card.classList.toggle('is-kpi', resolved.cfg.type === 'kpi');
    const key = JSON.stringify(columns.map((c) => c.name + ':' + c.type));
    if (!tileEl.panelState || tileEl.panelState.key !== key) tileEl.panelState = { key };
    const result = { columns, rows } as Parameters<typeof renderResolvedPanel>[2];
    const out = renderResolvedPanel(app as unknown as App, resolved, result, {
      surface: 'dashboard', state: tileEl.panelState, rerender: () => paintForce(ts, tileEl),
      readonly: true, cap: DASH_TABLE_DISPLAY_CAP, onCell: () => {},
    });
    tileEl.destroy = out.destroy || null;
    tileEl.body.replaceChildren(out.node);
    tileEl.foot.replaceChildren(...tileFooter(ts.meta as NonNullable<ViewerTileState['meta']>));
    tileEl.paintedRows = ts.rows;
  }

  // A local re-paint (header-click sort) — force even when the rows ref is
  // unchanged (the sort mutated the panel state, not the data).
  function paintForce(ts: ViewerTileState, tileEl: TileEl): void { tileEl.paintedRows = null; paintPanel(ts, tileEl); }

  function reconcileTile(ts: ViewerTileState): void {
    const tileEl = ensureTileEl(ts);
    const placement = currentPlacement(ts.tileId);
    tileEl.spanSel.value = String(placement.span ?? 1);
    tileEl.heightSel.value = String(placement.height ?? 'medium');
    tileEl.card.dataset.height = String(placement.height ?? 'medium');
    if (ts.isKpi) return; // KPI tiles are rendered inside their band, not as a card
    if (ts.status === 'ready') { paintPanel(ts, tileEl); return; }
    destroyChart(tileEl);
    tileEl.paintedRows = null;
    tileEl.foot.replaceChildren();
    if (ts.status === 'error') {
      tileEl.body.replaceChildren(h('div', { class: 'dash-tile-error' }, ts.error || 'Error'));
    } else if (ts.status === 'unfilled') {
      tileEl.body.replaceChildren(h('div', { class: 'dash-tile-unfilled' }, 'Enter a value for: ' + ts.unfilled.join(', ')));
    } else {
      const label = h('span', null, ts.progressRows ? 'Loading… ' + formatRows(ts.progressRows) + ' rows' : 'Loading…');
      tileEl.body.replaceChildren(h('div', { class: 'dash-tile-load' }, Icon.spinner(), label));
    }
  }

  // Render one KPI tile's cards (or its non-ready state) into `host`. On 'ready'
  // the viewer guarantees columns/rows (no defensive fallback).
  function renderKpiInto(host: HTMLElement, ts: ViewerTileState): void {
    if (ts.status !== 'ready') {
      host.replaceChildren(h('div', { class: 'dash-kpi-state-card' },
        ts.status === 'error' ? (ts.error || 'Error')
          : ts.status === 'unfilled' ? 'Enter a value for: ' + ts.unfilled.join(', ') : 'Loading…'));
      return;
    }
    const panel = (ts.panel || {}) as Record<string, unknown>;
    const resolved = resolvePanel(panel as Parameters<typeof resolvePanel>[0], {
      columns: ts.columns as Column[], rows: ts.rows as unknown[][],
      fieldConfig: panel.fieldConfig as never,
      serverVersion: state.serverVersion,
    });
    const { cards, errors } = renderKpiCards(resolved.kpi);
    host.replaceChildren(...(errors.length ? errors.map((e) => h('div', { class: 'dash-kpi-state-card' }, e.message)) : cards));
  }

  // ── Grid reconciliation from the flow model ───────────────────────────────
  let lastLayoutSig = '';
  function reconcileGrid(sview: DashboardViewState): void {
    const byId = new Map(sview.tiles.map((t) => [t.tileId, t]));
    for (const ts of sview.tiles) reconcileTile(ts);
    const sig = JSON.stringify({
      m: sview.layout.mobile, c: sview.layout.columns, p: sview.layout.preset,
      rows: sview.layout.rows.map((r) => ({ k: r.kind, t: r.tiles.map((t) => [t.tileId, t.span]) })),
    });
    // Rebuild the row STRUCTURE only when the flow model changes (a reorder,
    // resize, preset, or mobile flip) — moving stable tile cards, so charts are
    // never thrashed.
    if (sig !== lastLayoutSig) {
      lastLayoutSig = sig;
      grid.classList.toggle('is-report', sview.layout.preset === 'report');
      grid.replaceChildren(...sview.layout.rows.map((row) => {
        if (row.kind === 'kpi-band') {
          const stream = h('div', { class: 'dash-kpi-stream', ...KPI_STREAM_ARIA });
          for (const member of row.tiles) stream.appendChild(h('div', { class: 'dash-kpi-member', 'data-tile': member.tileId }));
          return h('div', { class: 'dash-row dash-kpi-band' }, stream);
        }
        const rowEl = h('div', { class: 'dash-row', style: { display: 'grid', gridTemplateColumns: `repeat(${row.columns}, minmax(0, 1fr))`, gap: '12px' } });
        for (const t of row.tiles) {
          const tileEl = tileEls.get(t.tileId);
          if (tileEl) { tileEl.card.style.gridColumn = `span ${t.span}`; rowEl.appendChild(tileEl.card); }
        }
        return rowEl;
      }));
    }
    // A KPI band member's CONTENT (cards / state) is refreshed on every publish
    // — cheap, KPI cards carry no charts — so a member reaching ready repaints
    // without a structural rebuild.
    for (const host of grid.querySelectorAll('.dash-kpi-member')) {
      const ts = byId.get((host as HTMLElement).dataset.tile || '');
      if (ts) renderKpiInto(host as HTMLElement, ts);
    }
  }

  // ── Effect: reconcile on every publish (and on the mobile-breakpoint flip) ─
  let lastMobile = state.isMobile.value;
  effect(() => {
    const sview = session.state.value;
    const mobileNow = state.isMobile.value; // tracked so a breakpoint flip re-runs the effect
    // A breakpoint flip after the last publish needs a fresh flow model —
    // republish through the viewer (recomputes it with the new mobile flag).
    if (mobileNow !== lastMobile && mobileNow !== sview.layout.mobile) { lastMobile = mobileNow; session.syncDocument(currentDoc); return; }
    lastMobile = mobileNow;
    if (filterFields.size === 0 && sview.filters.length) buildFilterBar(sview.filters);
    updateFilterBar(sview);
    tileCountLabel.textContent = sview.tiles.length + (sview.tiles.length === 1 ? ' tile' : ' tiles');
    empty.style.display = sview.tiles.length ? 'none' : '';
    filterDiagnosticsHost.replaceChildren(...sview.diagnostics.map((d) => h('div', { class: 'dash-config-diagnostic is-error' }, d.message)));
    reconcileGrid(sview);
    refreshBtn.disabled = sview.running;
    if (!sview.running && sview.updatedAt != null) {
      updated.textContent = 'Updated ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
  });

  const toolbar = h('div', { class: 'dash-toolbar' + (session.state.value.filters.length ? ' has-filters' : '') }, layoutWrap, filterHost);

  // `!`: the dashboard renders only into a mounted page.
  app.root!.replaceChildren(h('div', { class: 'dash-page' },
    h('div', { class: 'dash-topbar' }, header, toolbar),
    liveRegion, filterDiagnosticsHost, empty, grid));

  await session.start();
}
