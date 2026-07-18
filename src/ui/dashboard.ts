// The read-only Dashboard page (#149 / #240 / #280 / #286). Phase 4 of #280
// FLIPS Dashboard membership reads off `spec.favorite` and onto
// `dashboard.tiles[]`: this module resolves the current `StoredWorkspaceV1`
// (via `app.loadDashboardWorkspace()` — the phase-2 repository, migrating the
// legacy favorites/layout keys once when no aggregate exists), constructs a
// standalone `DashboardViewerSession` over that document + the workspace
// queries, and renders the DOM from the session's `state` signal. The heavy
// runtime — presentation resolution, the filter/tile execution waves (with
// #235 parallelism), bounded concurrency, per-tile cancellation, and the
// normative `flow@1` layout math — all live in the session and its pure
// dependencies; this module is the render/interaction shell over them.
//
// The filter bar is the SHARED `buildFilterBar` (the same rich field family the
// Workbench var-strip and detached view use — relative-time presets, recents,
// enum + curated comboboxes), driven over the viewer's filter model: a draft
// value/active bag the bar mutates, `session.getFilterField` for live #170
// validation, and `session.applyFilter` on commit (which owns activation).
// Recents come from the real app (a cross-surface concern) through the shim —
// the viewer never touches global AppState (check-boundaries keeps it that way).
//
// Tile reordering is pointer DRAG ONLY (owner override, #286 final scope — the
// per-tile keyboard Move controls and the in-tile span/height buttons were
// removed; span/height are tuned in the Spec editor). A drag persists the new
// `dashboard.tiles[]` order through the `move-tile` authoring command. The
// layout preset switcher drives `change-layout`. The `spec.favorite` dual-WRITE
// stays until GA (the Workbench star); only the READ is flipped here.
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
import type { ValidationMode } from '../core/param-pipeline.js';
import { queryDashboardRole } from '../dashboard/model/workspace-semantics.js';
import { renderKpiCards, KPI_STREAM_ARIA } from './kpi-panel.js';
import { buildFilterBar, filterClearAllButton, filterActiveCount } from './filter-bar.js';
import type { FilterBarApp } from './filter-bar.js';
import { createDashboardViewerSession } from '../dashboard/application/dashboard-viewer-session.js';
import type {
  DashboardViewerSession, DashboardViewState, ViewerTileState, ViewerFilterState,
} from '../dashboard/application/dashboard-viewer-session.js';
import { defaultLayoutRegistry } from '../dashboard/layouts/layout-registry.js';
import { flowLayoutPlugin } from '../dashboard/layouts/flow-layout.js';
import { applyCommand } from '../dashboard/application/dashboard-commands.js';
import { createQueryResolver } from '../dashboard/application/dashboard-query-resolver.js';
import type {
  DashboardDocumentV1, DashboardFilterDefinitionV1, FlowPresetV1, SavedQueryV2, StoredWorkspaceV1,
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
  params: Pick<WorkbenchParameterSession, 'recordBoundParams' | 'clearVarRecent'>;
  workspace: Pick<WorkspaceRepository, 'commit'>;
  loadDashboardWorkspace(): Promise<StoredWorkspaceV1 | null>;
}

const valueString = (value: unknown): string =>
  (typeof value === 'string' ? value : value == null ? '' : String(value));

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

  // ── Filter bar (shared buildFilterBar, viewer-backed) ─────────────────────
  const filterHost = h('div', { class: 'dash-filter-host' });
  const filterCountNode = h('span', { class: 'dash-filter-count-host' });
  const clearAllNode = h('span', { class: 'dash-filter-clear-all-host' });
  // The draft value/active bag the shared filter bar reads + mutates; re-seeded
  // from committed filter state on each (re)build. Recents come from the real
  // app — the viewer never touches AppState.
  const draftValues: Record<string, string> = {};
  const draftActive: Record<string, boolean> = {};
  const filterBarApp: FilterBarApp = {
    document: doc,
    state: { varValues: draftValues, filterActive: draftActive, varRecent: state.varRecent },
    params: {
      saveVarValues: () => {},
      saveFilterActive: () => {},
      clearVarRecent: (name: string) => app.params.clearVarRecent(name),
    },
    wallNow: () => app.wallNow(),
  };
  let filterBarDispose: (() => void) | null = null;

  function rebuildFilterBar(sview: DashboardViewState): void {
    filterBarDispose?.();
    const idByParam = new Map<string, string>();
    const curatedFields: Record<string, { options: ViewerFilterState['options'] }> = {};
    for (const f of sview.filters) {
      draftValues[f.parameter] = valueString(f.value);
      draftActive[f.parameter] = f.active;
      idByParam.set(f.parameter, f.id);
      if (f.options && f.options.length) curatedFields[f.parameter] = { options: f.options };
    }
    const onCommit = (name: string): void => {
      const id = idByParam.get(name);
      if (id) session.applyFilter(id, draftValues[name] ?? '', !!draftActive[name]);
    };
    const getField = (name: string, mode: ValidationMode) => session.getFilterField(name, mode, draftValues, draftActive);
    const bar = buildFilterBar(filterBarApp, session.controls, onCommit, getField, { curatedFields, document: doc });
    filterHost.replaceChildren(bar.el, clearAllNode, filterCountNode);
    filterBarDispose = bar.dispose;
  }

  const filterDiagnosticsHost = h('div', { class: 'dash-filter-diagnostics' });
  const grid = h('div', { class: 'dash-grid' });
  const empty = h('div', { class: 'dash-empty', style: { display: currentDoc.tiles.length ? 'none' : '' } },
    'No tiles yet — star a query in the Library to add it to the dashboard.');

  // ── Structural commands (reorder via drag, preset) ────────────────────────
  // move-tile / update-placement / change-layout are the phase-3 authoring
  // commands; the dashboard UI drives only move-tile (drag) and change-layout
  // (preset) — span/height (update-placement) is tuned in the Spec editor.
  function runCommand(command: Parameters<typeof applyCommand>[1]): void {
    const applied = applyCommand(currentDoc, command, {
      resolver: createQueryResolver(queries), genTileId: () => 'tile', plugin: flowLayoutPlugin,
    });
    // A UI-driven command (drag move-tile, preset change-layout) is always
    // valid; a rejected candidate is simply ignored (no draft change).
    if (applied.ok) {
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
  }

  // ── Tile DOM ──────────────────────────────────────────────────────────────
  const tileEls = new Map<string, TileEl>();
  let dragTileId: string | null = null;

  function ensureTileEl(ts: ViewerTileState): TileEl {
    const existing = tileEls.get(ts.tileId);
    if (existing) return existing;
    const head = h('div', { class: 'dash-tile-head' }, h('span', { class: 'dash-tile-name', title: ts.title }, ts.title));
    const body = h('div', { class: 'dash-tile-body' });
    const foot = h('div', { class: 'dash-tile-foot' });
    const card = h('div', { class: 'dash-tile', draggable: 'true' }, head, body, foot);
    // Pointer drag is the sole reorder mechanism (#286 owner override): a drop
    // persists the new dashboard.tiles[] order through the move-tile command.
    card.addEventListener('dragstart', () => { dragTileId = ts.tileId; });
    card.addEventListener('dragover', (event) => event.preventDefault());
    card.addEventListener('drop', (event) => {
      event.preventDefault();
      if (dragTileId && dragTileId !== ts.tileId) {
        runCommand({ type: 'move-tile', tileId: dragTileId, toIndex: currentDoc.tiles.map((t) => t.id).indexOf(ts.tileId) });
      }
      dragTileId = null;
    });
    const tileEl: TileEl = { card, body, foot, panelState: null, destroy: null, paintedRows: null };
    tileEls.set(ts.tileId, tileEl);
    return tileEl;
  }

  function destroyChart(tileEl: TileEl): void { if (tileEl.destroy) { tileEl.destroy(); tileEl.destroy = null; } }

  // Paint an ordinary (non-KPI) tile's result once per new result. Only ever
  // called for a 'ready' tile, so columns/rows/meta/panel are all present.
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
    // preset, or mobile flip) — moving stable tile cards, so charts are never
    // thrashed.
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
  let barSig = '';
  effect(() => {
    const sview = session.state.value;
    const mobileNow = state.isMobile.value; // tracked so a breakpoint flip re-runs the effect
    // A breakpoint flip after the last publish needs a fresh flow model —
    // republish through the viewer (recomputes it with the new mobile flag).
    if (mobileNow !== lastMobile && mobileNow !== sview.layout.mobile) { lastMobile = mobileNow; session.syncDocument(currentDoc); return; }
    lastMobile = mobileNow;
    // Rebuild the shared filter bar only when its field structure changes
    // (activation, committed value, or curated options arriving) — not on tile
    // progress ticks — so in-progress typing is not disturbed mid-wave.
    const sig = JSON.stringify(sview.filters.map((f) => [f.id, f.active, valueString(f.value), !!(f.options && f.options.length)]));
    if (sig !== barSig) { barSig = sig; rebuildFilterBar(sview); }
    clearAllNode.replaceChildren(filterClearAllButton({ active: sview.activeFilterCount > 0, onClearAll: () => session.clearAllFilters() }));
    filterCountNode.replaceChildren(filterActiveCount(sview.activeFilterCount));
    tileCountLabel.textContent = sview.tiles.length + (sview.tiles.length === 1 ? ' tile' : ' tiles');
    empty.style.display = sview.tiles.length ? 'none' : '';
    // Genuine dashboard-config diagnostics only (a tile whose presentation
    // could not resolve, etc.). Per-filter "required/invalid" badges were
    // dropped as noise (owner decision) — an unfilled required filter simply
    // leaves its target tiles in their normal unfilled state.
    filterDiagnosticsHost.replaceChildren(
      ...sview.diagnostics.map((d) => h('div', { class: 'dash-config-diagnostic is-error' }, d.message)),
    );
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
    filterDiagnosticsHost, empty, grid));

  await session.start();
}
