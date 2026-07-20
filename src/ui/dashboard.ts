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
import { openMenu } from './menu.js';
import type { MenuHandle, MenuRow } from './menu.js';
import { renderResolvedPanel } from './panels.js';
import { openCellDetail } from './results.js';
import type { ResultsApp } from './results.js';
import { movedPastThreshold, hitTestTile, resolveOverlapInsertIndex, flipDelta } from '../core/tile-reorder.js';
import type { TileRect } from '../core/tile-reorder.js';
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
import { buildFilterBar } from './filter-bar.js';
import type { FilterBarApp } from './filter-bar.js';
import { createDashboardViewerSession } from '../dashboard/application/dashboard-viewer-session.js';
import type {
  DashboardViewerSession, DashboardViewState, ViewerTileState, ViewerFilterState,
} from '../dashboard/application/dashboard-viewer-session.js';
import { defaultLayoutRegistry, resolveLayoutPluginSync } from '../dashboard/layouts/layout-registry.js';
import type { FlowLayoutModel } from '../dashboard/layouts/flow-layout.js';
import {
  DEFAULT_GRID_HEIGHT_UNITS, GRAFANA_GRID_MAX_COLUMNS, GRID_GAP_PX, contentBoxWidth, deriveFlowFallback,
  gridHeightUnitsToPx, snapGridHeight, snapGridSpan,
} from '../dashboard/layouts/grafana-grid-layout.js';
import type { GrafanaGridLayoutModel, GridRenderMode } from '../dashboard/layouts/grafana-grid-layout.js';
import { applyCommand } from '../dashboard/application/dashboard-commands.js';
import { createQueryResolver } from '../dashboard/application/dashboard-query-resolver.js';
import { resolveDashboardMode } from '../dashboard/application/session-bundle.js';
import {
  readDashboardFilterBag, writeDashboardFilterBag, filterBagSignature,
} from '../dashboard/model/dashboard-filter-store.js';
import type { DashboardFilterBag } from '../dashboard/model/dashboard-filter-store.js';
import { loadJSON } from '../core/storage.js';
import { KEYS } from '../state.js';
import type {
  DashboardDocumentV1, DashboardFilterDefinitionV1, DashboardLayoutDocumentV1, FlowPresetV1,
  SavedQueryV2, StoredWorkspaceV1,
} from '../generated/json-schema.types.js';
import type { App, AppDom, ActionsRegistry } from './app.types.js';
import type { DashboardOpenSource } from '../dashboard/application/dashboard-open-source.js';
import type { DetachedViewsStore } from '../workspace/detached-views-store.types.js';
import type { AppState } from '../state.js';
import type { ConnectionSession } from '../application/connection-session.js';
import type { QueryExecutionService } from '../application/query-execution-service.js';
import type { WorkbenchParameterSession } from '../application/workbench-parameter-session.js';
import type { WorkspaceRepository } from '../workspace/workspace-repository.js';
import type { AppPreferences } from '../application/app-preferences.js';

// icons.js is unconverted — the six icons this module appends, pinned to the
// one honest shape (same wrapper the pre-#286 module used).
const Icon: {
  star(filled?: boolean): SVGElement;
  spinner(): SVGElement;
  refresh(): SVGElement;
  sun(): SVGElement;
  moon(): SVGElement;
  arrow(): SVGElement;
  trash(): SVGElement;
  chevDown(): SVGElement;
  download(): SVGElement;
  upload(): SVGElement;
  eye(): SVGElement;
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
  // #288 Phase 6 — viewer routing (ADR-0003): the parsed open-source of this
  // tab, the detached-views lookup, the one-time-handoff consumer, and the
  // projection of the resolved workspace onto app.state (so the File menu's
  // export/import act on THIS dashboard).
  dashboardOpenSource: DashboardOpenSource | null;
  detachedViews: Pick<DetachedViewsStore, 'get'>;
  consumeDashboardHandoff(): Promise<StoredWorkspaceV1 | null>;
  applyCommittedWorkspace(workspace: StoredWorkspaceV1): void;
  // #302 — the Dashboard page's own File-menu operations.
  actions: Pick<ActionsRegistry, 'exportDashboard' | 'importDashboard' | 'openDashboardForViewing'>;
  /** #303: persists the isolated per-dashboard filter store (`KEYS.dashFilters`). */
  saveJSON(key: string, value: unknown): void;
  /** #332: the shared cell-detail drawer's own resize persist (`openCellDetail`
   *  → `attachDrawerResize` reads `state.cellDrawerPx` + `prefs.save`). Declared
   *  here rather than relying purely on the `as ResultsApp` cast so a future
   *  narrower caller gets a compile-time signal, not a runtime crash. */
  prefs: Pick<AppPreferences, 'save'>;
}

const valueString = (value: unknown): string =>
  (typeof value === 'string' ? value : value == null ? '' : String(value));

/** #291 review F4: `renderDashboard` can run more than once against the SAME
 *  window — `app.reloadDashboardRoute()` (app.ts) re-invokes it in place after
 *  an import-commit while already on `/dashboard` (file-menu.ts's Import
 *  flow). Module-level so a later call can find and remove the PRIOR call's
 *  resize listener before installing its own; without this, repeated renders
 *  stack listeners that all still close over their own render's now-stale
 *  `session`/`currentDoc`/`containerWidthPx`. */
let installedGridResizeListener: { win: Window; handler: () => void } | null = null;
// #332: the window-level ⌘/Ctrl-held cursor-affordance listeners (mirrors the
// grid-resize listener's teardown model — removed at the START of the next
// renderDashboard call, since this module never observes page teardown).
let installedModifierListeners:
  | { win: Window; onKeyDown: (e: KeyboardEvent) => void; onKeyUp: (e: KeyboardEvent) => void; onBlur: () => void }
  | null = null;

/**
 * Build the flow preset switcher as a compact `<select>` (2026-07-18 owner
 * override — was a `.dash-seg` segmented button group; restyled to match the
 * Workbench's panel-type picker, `renderPanelTypePicker` in panels.ts, so the
 * dashboard reuses the same "shared `.result-panel-select` chrome" convention
 * rather than its own). `options` are `[value,label,title?]`; `sync()` (called
 * on construction and after every layout change) reflects the current preset.
 */
type LayoutOption = [value: string, label: string, title?: string];
function buildLayoutSelect(
  options: LayoutOption[], getActive: () => string, onPick: (value: string) => void, ariaLabel: string,
): { el: HTMLSelectElement; sync: () => void } {
  const el = h('select', {
    class: 'result-panel-select dash-layout-select', 'aria-label': ariaLabel, title: ariaLabel,
    onchange: (e: Event) => onPick((e.target as HTMLSelectElement).value),
  }) as HTMLSelectElement;
  for (const [value, label, title] of options) {
    const opt = h('option', { value }, label) as HTMLOptionElement;
    if (title) opt.title = title;
    el.appendChild(opt);
  }
  const sync = (): void => { el.value = getActive(); };
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
  /** #321: the grid resize handle, when built (grafana-grid + edit mode) — its
   *  accessible label toggles between 'Resize' (tiles) and 'Resize tile
   *  height' (full view, vertical-only) as the render mode changes. */
  resizeHandle: HTMLElement | null;
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

/** #288 — the read-only viewer's not-found state: a `current-workspace` route
 *  whose workspace/dashboard ids no longer resolve (the workspace was replaced,
 *  or the detached view was evicted), or a spent/expired one-time handoff token.
 *  Renders a message + a link back and executes nothing. */
function renderDashboardNotFound(app: DashboardApp): void {
  const back = h('a', { class: 'dash-back', href: app.conn.basePath || '/sql' },
    Icon.arrow(), h('span', { class: 'dash-back-label' }, 'SQL Browser'));
  // `!`: the dashboard renders only into a mounted page.
  app.root!.replaceChildren(h('div', { class: 'dash-page dash-notfound' },
    h('div', { class: 'dash-empty' },
      h('h2', { class: 'dash-notfound-title' }, 'Dashboard unavailable'),
      h('p', null,
        'This dashboard link is no longer available — the workspace may have been '
        + 'replaced, or a one-time preview link was already used or has expired.'),
      back)));
}

/** #302/#331 — the standalone Dashboard header's own "File" menu: a keyboard-
 *  and screen-reader-accessible dropdown owning Dashboard-scoped operations,
 *  built on the shared `openMenu` primitive (menu.ts) — the same structure +
 *  interaction grammar (icons, `.fm-section` headings, Esc/outside-click
 *  close + focus-restore, ArrowUp/ArrowDown roving focus) as the Workbench
 *  File menu, with Dashboard-specific CONTENTS:
 *    EXPORT   ⭳ Export Dashboard…   .json
 *    IMPORT   ⭱ Import Dashboard…
 *    OPEN     ◇ Open for viewing…
 *  Edit mode offers all three sections; a read-only (detached) view offers
 *  EXPORT only (import + re-preview are edit-context operations). Every item
 *  delegates to an `app.actions.*` seam (dashboard.ts never reaches into
 *  app.ts). The trigger uses the shared downward-chevron treatment
 *  (`Icon.chevDown()`, matching the Workbench File button) rather than a
 *  right-pointing arrow, which would misread as navigation. The trigger owns
 *  its own open/close TOGGLE (unlike the Workbench menu, which only ever
 *  opens) — clicking it again while open closes the menu and restores focus,
 *  tracked here via the returned `MenuHandle` rather than a second
 *  `openMenu` call. */
function buildDashboardFileMenu(app: DashboardApp, readOnly: boolean): HTMLElement {
  const doc = app.document;
  const btn = h('button', {
    class: 'dash-btn dash-file-btn', 'aria-haspopup': 'menu', 'aria-expanded': 'false',
    title: 'File — dashboard import/export', 'aria-label': 'Dashboard File menu',
  }, h('span', null, 'File'), Icon.chevDown()) as HTMLButtonElement;

  let handle: MenuHandle | null = null;

  const open = (): void => {
    const rows: MenuRow[] = [
      { kind: 'section', label: 'Export' },
      {
        kind: 'item', icon: Icon.download(), label: 'Export Dashboard…', meta: '.json', extraClass: 'dash-fm-item',
        onClick: () => app.actions.exportDashboard(),
      },
    ];
    if (!readOnly) {
      rows.push(
        { kind: 'section', label: 'Import' },
        {
          kind: 'item', icon: Icon.upload(), label: 'Import Dashboard…', extraClass: 'dash-fm-item',
          onClick: () => app.actions.importDashboard(),
        },
        { kind: 'section', label: 'Open' },
        {
          kind: 'item', icon: Icon.eye(), label: 'Open for viewing…', extraClass: 'dash-fm-item',
          onClick: () => app.actions.openDashboardForViewing(),
        },
      );
    }
    handle = openMenu({
      document: doc, trigger: btn, rows, menuClass: 'dash-file-menu',
      onClose: () => { handle = null; },
    });
  };

  btn.onclick = () => { if (handle) { handle.close(); btn.focus(); } else open(); };
  return btn;
}

/** Render the dashboard into `app.root`. */
export async function renderDashboard(app: DashboardApp): Promise<void> {
  const { document: doc, state } = app;
  doc.documentElement.setAttribute('data-theme', state.theme);
  doc.documentElement.setAttribute('data-density', state.density);
  app.dom = {};

  // #291 review F4: remove any grid resize listener a PRIOR renderDashboard
  // call installed on this window before this call installs its own (see
  // `installedGridResizeListener`'s own doc comment above).
  if (installedGridResizeListener) {
    installedGridResizeListener.win.removeEventListener('resize', installedGridResizeListener.handler);
    installedGridResizeListener = null;
  }
  if (installedModifierListeners) {
    const m = installedModifierListeners;
    m.win.removeEventListener('keydown', m.onKeyDown);
    m.win.removeEventListener('keyup', m.onKeyUp);
    m.win.removeEventListener('blur', m.onBlur);
    installedModifierListeners = null;
  }

  // #288 Phase 6: resolve WHICH dashboard this tab shows and in which MODE from
  // the parsed open-source (ADR-0003). `current-workspace` (?ws=&dash=) verifies
  // both ids against the shared primary store (edit) or the persistent detached
  // store (view); `session-bundle` (?st=) atomically consumes the one-time
  // handoff into a detached view. A bare /dashboard open is the legacy editable
  // current-workspace path. A resolution failure shows not-found — never a
  // different dashboard.
  const source = app.dashboardOpenSource;
  let workspace: StoredWorkspaceV1 | null;
  let readOnly = false;
  if (source && source.kind === 'session-bundle') {
    workspace = await app.consumeDashboardHandoff();
    if (!workspace) { renderDashboardNotFound(app); return; }
    readOnly = true;
  } else if (source && source.kind === 'current-workspace') {
    const primary = await app.loadDashboardWorkspace();
    const detached = await app.detachedViews.get(source.workspaceId);
    const resolved = resolveDashboardMode(source, primary, detached);
    if (resolved.mode === 'not-found') { renderDashboardNotFound(app); return; }
    workspace = resolved.workspace;
    readOnly = resolved.mode === 'view';
  } else {
    workspace = await app.loadDashboardWorkspace();
  }
  // Project the resolved workspace onto app.state so the Dashboard File menu's
  // export/import (which read app.state) operate on THIS dashboard, not the
  // tab's stale legacy-boot state.
  if (workspace) app.applyCommittedWorkspace(workspace);

  const queries: SavedQueryV2[] = workspace ? workspace.queries : state.savedQueries;
  const queryById = new Map<string, SavedQueryV2>();
  for (const query of queries) if (!queryById.has(query.id)) queryById.set(query.id, query);

  // The live document — layout/order edits replace it; membership is read from
  // `dashboard.tiles[]` (NOT `savedQueries.filter(queryFavorite)`).
  let currentDoc: DashboardDocumentV1 = workspace && workspace.dashboard
    ? workspace.dashboard
    : {
      documentVersion: 1, id: 'empty', title: state.libraryName.value, revision: 1,
      layout: {
        type: 'grafana-grid', version: 1, items: {},
        fallback: deriveFlowFallback({ type: 'grafana-grid', version: 1, items: {} }, []),
      },
      filters: [], tiles: [],
    };
  let committedRevision = currentDoc.revision;

  // Merge explicit + synthesized implicit filters for the viewer.
  const viewerDoc: DashboardDocumentV1 = {
    ...currentDoc, filters: [...(currentDoc.filters || []), ...synthesizeImplicitFilters(currentDoc, queryById)],
  };

  // #303: seed each filter's initial value/active from the isolated
  // per-dashboard store (never the Workbench's asb:varValues/asb:filterActive
  // keys) — restores committed filter state across a reload. `initialBag` is
  // ALSO the baseline the persist effect below compares against, so the very
  // first publish (which merely echoes this seed) does not immediately write
  // defaults back over it.
  const initialBag: DashboardFilterBag = readDashboardFilterBag(loadJSON(KEYS.dashFilters, {}), currentDoc.id);

  // #291: the grafana-grid engine's own responsive effective-columns clamp
  // (12/6/4/2) needs a measured container width, unlike flow's coarser
  // `isMobile` binary flip — `containerWidthPx` is set once the grid host is
  // mounted (below, near `app.root!.replaceChildren`) and kept live by a
  // resize listener; it stays `undefined` (→ the widest desktop breakpoint)
  // for a flow-only Dashboard, a pre-mount publish, or a non-measurable
  // (happy-dom) environment.
  let containerWidthPx: number | undefined;
  const session: DashboardViewerSession = createDashboardViewerSession({
    document: viewerDoc,
    queries,
    exec: app.exec,
    connection: { ensureFreshToken: () => app.conn.ensureFreshToken() },
    registry: defaultLayoutRegistry,
    now: () => app.now(),
    wallNow: () => app.wallNow(),
    isMobile: () => state.isMobile.value,
    containerWidth: () => containerWidthPx,
    onAuthFailed: () => app.conn.chCtx.onSignedOut(),
    recordBoundParams: (bp) => app.params.recordBoundParams(bp),
    initialFilters: initialBag,
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

  // ── Preset switcher (change-layout command) ───────────────────────────────
  // #321: the local mirror of the viewer session's TRANSIENT grid render-mode
  // override ('tiles'|'full') — read by `getActive`/`onPick` below (built
  // synchronously, before the first publish) and kept current by the render
  // effect (Part D) whenever `sview.layout.renderMode` changes.
  let gridRenderMode: GridRenderMode = 'tiles';
  // 2026-07-18 owner override: moved off the filter toolbar and into the top
  // header row (right after the tile-count chip) so the toolbar's whole width
  // is available for filters; a compact select needs far less room than the
  // four-button segmented control it replaces.
  // #321: "Full view" is a TRANSIENT runtime render-mode override over the
  // grafana-grid engine (never persisted) — it sits alongside "Grid Tiles" in
  // the editable selector. A read-only (detached) view gets a REDUCED
  // selector with only those two entries — layout editing (the flow presets,
  // and the flow<->grid engine switch) stays an edit-mode-only affordance,
  // but the render-mode toggle is harmless to expose read-only since it never
  // persists anything.
  const EDITABLE_LAYOUT_OPTIONS: LayoutOption[] = [
    ['grafana-grid', 'Grid Tiles', 'A responsive tile grid using authored spans and heights'],
    ['full', 'Full view', 'Temporary full-width view — tile widths are not saved'],
    ['report', 'Report', 'One centered, taller tile per row'],
    ['columns-2', '2 columns', 'Arrange tiles in two columns'],
    ['columns-3', '3 columns', 'Arrange tiles in three columns'],
  ];
  const READONLY_LAYOUT_OPTIONS: LayoutOption[] = [
    ['grafana-grid', 'Grid Tiles', 'A responsive tile grid using authored spans and heights'],
    ['full', 'Full view', 'Temporary full-width view — tile widths are not saved'],
  ];
  const getActiveLayoutOption = (): string => (currentDoc.layout.type === 'grafana-grid'
    ? (gridRenderMode === 'full' ? 'full' : 'grafana-grid')
    : typeof currentDoc.layout.preset === 'string' ? currentDoc.layout.preset : 'report');
  const layoutSelect = buildLayoutSelect(
    readOnly ? READONLY_LAYOUT_OPTIONS : EDITABLE_LAYOUT_OPTIONS,
    getActiveLayoutOption,
    (value) => {
      // #321 read-only: the reduced selector offers ONLY 'grafana-grid'/'full'
      // — either choice is ONLY ever the transient render-mode override, NEVER
      // a command / persistence.
      if (readOnly) {
        session.setGridRenderMode(value === 'full' ? 'full' : 'tiles');
        layoutSelect.sync();
        return;
      }
      if (value === 'grafana-grid') {
        // Full view -> Grid Tiles: clear the transient override in place (no
        // command). Flow -> Grid Tiles: the existing persisted engine switch.
        // Already grid+tiles: no-op.
        if (gridRenderMode === 'full') session.setGridRenderMode('tiles');
        else if (currentDoc.layout.type !== 'grafana-grid') {
          runCommand({ type: 'change-layout', layout: { type: 'grafana-grid', version: 1 } as DashboardLayoutDocumentV1 });
        }
        layoutSelect.sync();
        return;
      }
      if (value === 'full') {
        // Grid already active: only the transient override changes. Flow
        // active: persist the ONE flow->grid conversion, THEN apply the
        // override (still transient) — the conversion is the only persisted
        // change; the full-view override itself never is.
        if (currentDoc.layout.type !== 'grafana-grid') {
          runCommand({ type: 'change-layout', layout: { type: 'grafana-grid', version: 1 } as DashboardLayoutDocumentV1 });
        }
        session.setGridRenderMode('full');
        layoutSelect.sync();
        return;
      }
      // A flow preset: clear any transient full-view override first (#321 —
      // picking a flow preset always lands on 'tiles' semantics), then apply
      // the existing persisted flow preset/engine-switch logic unchanged.
      if (gridRenderMode === 'full') session.setGridRenderMode('tiles');
      if (currentDoc.layout.type === 'grafana-grid') {
        runCommand({ type: 'change-layout', layout: { type: 'flow', version: 1, preset: value as FlowPresetV1 } });
      } else {
        runCommand({ type: 'change-layout', layout: { ...currentDoc.layout, preset: value as FlowPresetV1 } });
      }
      layoutSelect.sync();
    },
    'Dashboard style',
  );
  const layoutWrap = h('div', { class: 'dash-layout-wrap' }, layoutSelect.el);
  // #321 BLOCKER fix: the reduced read-only selector (Grid Tiles / Full view)
  // is a grafana-grid-only render-mode toggle — expose it read-only ONLY when
  // the persisted doc is grafana-grid. A read-only FLOW doc (report/columns-2/
  // columns-3 — any pre-#321 shared doc) must hide the selector entirely: no
  // engine switch is possible read-only, so this is decided once at build
  // time from the static `currentDoc.layout.type`. Editable mode is unchanged
  // (always the full selector).
  const showLayoutSelect = !readOnly || currentDoc.layout.type === 'grafana-grid';

  // #302: the Dashboard page's own resource-scoped File menu (import/export +
  // open-for-viewing).
  const fileMenuBtn = buildDashboardFileMenu(app, readOnly);
  const header = h('div', { class: 'dash-header' },
    h('a', {
      class: 'dash-back', href: app.conn.basePath || '/sql', title: 'Back to SQL Browser', 'aria-label': 'Back to SQL Browser',
    }, Icon.arrow(), h('span', { class: 'dash-back-label' }, 'SQL Browser')),
    h('div', { class: 'dash-title' }, currentDoc.title || state.libraryName.value),
    tileCount, showLayoutSelect ? layoutWrap : null,
    h('div', { class: 'dash-spacer', style: { flex: '1' } }),
    h('span', { class: 'dash-chip dash-src', title: app.conn.host() }, h('span', { class: 'dash-dot' }), app.conn.host()),
    updated, fileMenuBtn, themeBtn, refreshBtn);

  // ── Filter bar (shared buildFilterBar, viewer-backed) ─────────────────────
  // #294: the field region scrolls horizontally in its own viewport
  // (`.dash-filter-host`) so it never wraps the toolbar onto a second row.
  // No visible Clear-all control (reverses the #286/#293 decision) — no
  // visible "N active" count either (2026-07-18 owner override, reverses
  // #294's own retained-count acceptance criterion) — `session.clearAllFilters()`
  // stays a tested application-level operation with no UI trigger.
  const filterHost = h('div', { class: 'dash-filter-host' });
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
    filterHost.replaceChildren(bar.el);
    filterBarDispose = bar.dispose;
  }

  const filterDiagnosticsHost = h('div', { class: 'dash-filter-diagnostics' });
  const grid = h('div', { class: 'dash-grid' });
  const empty = h('div', { class: 'dash-empty', style: { display: currentDoc.tiles.length ? 'none' : '' } },
    'No tiles yet — star a query in the Queries panel to add it to the dashboard.');

  // #291 review F2: `grid.clientWidth` INCLUDES the host's own horizontal
  // padding (`.dash-grid`'s `padding: 18px 20px 40px`, styles.css), but CSS
  // grid TRACKS occupy the CONTENT box — reading `clientWidth` directly
  // misclassifies the responsive breakpoint tier near a boundary and skews
  // the resize column-width math by the same amount. The ONE shared reader
  // both the breakpoint measurement (`measureGridWidth`, below) and the
  // resize pointer math (`wireGridResize`, below) use, over the pure,
  // 100%-covered `contentBoxWidth` (grafana-grid-layout.ts) — `getComputedStyle`
  // itself returns an empty string with no stylesheet loaded (happy-dom), so
  // this thin wrapper is exercised by the real-browser e2e suite instead;
  // `contentBoxWidth`'s own non-finite-padding guard keeps it behaving exactly
  // like the un-padded `clientWidth` in that environment (the pre-fix reading).
  function measuredGridWidth(): number {
    const view = doc.defaultView || window;
    const cs = view.getComputedStyle(grid);
    return contentBoxWidth(grid.clientWidth, parseFloat(cs.paddingLeft), parseFloat(cs.paddingRight));
  }

  // ── Structural commands (reorder via drag, preset) ────────────────────────
  // move-tile / update-placement / change-layout are the phase-3 authoring
  // commands; the dashboard UI drives only move-tile (drag) and change-layout
  // (preset) — span/height (update-placement) is tuned in the Spec editor.
  function runCommand(command: Parameters<typeof applyCommand>[1]): void {
    // #291: validate/seed against whichever engine is ACTIVE before the
    // command applies (`resolveLayoutPluginSync` — grid: span 1..12, flow:
    // span 1..3). A `change-layout` engine switch is normalized through the
    // RESULTING document's own engine, so a post-switch grid document is
    // pruned by the grid plugin (its own `items`), not flow's (which would
    // only ever see its own fallback surface).
    const activePlugin = resolveLayoutPluginSync(currentDoc.layout);
    const applied = applyCommand(currentDoc, command, {
      resolver: createQueryResolver(queries), genTileId: () => 'tile', plugin: activePlugin,
    });
    // A UI-driven command (drag move-tile, preset change-layout, grid
    // resize/delete) is always valid; a rejected candidate is simply ignored
    // (no draft change).
    if (applied.ok) {
      const resultPlugin = resolveLayoutPluginSync(applied.dashboard.layout);
      const normalized = resultPlugin.normalize(applied.dashboard);
      currentDoc = normalized;
      layoutSelect.sync();
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
  // #332: the origin card of a just-completed move whose synthesized click must
  // be swallowed once (see wireTileDrag). Module-to-gesture, not per-card.
  let clickSuppressCard: HTMLElement | null = null;
  // #332: at most one tile-drag gesture at a time — a second pointerdown while
  // one is armed is ignored, so two live listener sets can't cross-contaminate.
  let gestureActive = false;
  // #291: which engine is active as of the last publish — read by the grid-
  // only delete/resize handlers (built once per tile in `ensureTileEl`, below,
  // and cached across engine switches) so a cached card's grid chrome stays
  // visually hidden AND inert while flow is active, instead of a per-switch
  // DOM rebuild. `null` before the first publish (never actually read then —
  // no pointer/click interaction can precede it).
  let activeEngine: 'flow' | 'grafana-grid' | null = null;
  // The tile's LAST rendered grid placement (span/height/colStart) — read at
  // the start of a corner-drag so the drag continues from the actual
  // rendered values, not a stale/default guess. `colStart` (#291 review F3)
  // is what lets the drag PIN the tile's column position for the gesture's
  // duration — see `wireGridResize` below.
  const gridPlacementByTile =
    new Map<string, { span: number; heightUnits: number; colStart: number; persistedSpan: number }>();
  // The grafana-grid engine's last-rendered effective column count — read at
  // the start of a corner-drag for the column-width math; a safe desktop
  // default before the first grid publish (never read before one, same
  // reasoning as `activeEngine` above).
  let currentGridColumns = GRAFANA_GRID_MAX_COLUMNS;

  // #291 height-units follow-up: height is a direct inline px style (from
  // numeric row units, `gridHeightUnitsToPx`), NOT a `.dash-gg-h-*` class —
  // there is no fixed tier vocabulary left to enumerate as CSS classes once
  // height is a 1..16 numeric range.
  function setGridHeightPx(card: HTMLElement, heightUnits: number): void {
    card.style.height = gridHeightUnitsToPx(heightUnits) + 'px';
  }

  // #321: the resize handle's accessible label/title reflects the CURRENT
  // render mode ('tiles' = two-dimensional resize, 'full' = vertical-only) —
  // the cursor affordance is pure CSS (`.dash-gg-grid.is-full .dash-gg-resize`,
  // styles.css), so only the label needs a per-tile DOM update when the mode
  // flips (Part D, the render effect).
  function resizeHandleLabel(full: boolean): string {
    return full ? 'Resize tile height' : 'Resize';
  }
  function applyResizeHandleMode(tileEl: TileEl, full: boolean): void {
    if (!tileEl.resizeHandle) return;
    const label = resizeHandleLabel(full);
    tileEl.resizeHandle.title = label;
    tileEl.resizeHandle.setAttribute('aria-label', label);
  }

  // #291 corner-drag resize (Workbench edit mode + grafana-grid engine only):
  // pointer math stays a THIN adapter over the pure `snapGridSpan`/
  // `snapGridHeight` (grafana-grid-layout.ts, rule 5) — live preview via
  // inline style/class during the drag, one `update-placement` dispatch on
  // pointerup. A no-op while flow is active (`activeEngine` guard) even
  // though the handle DOM always exists once built (CSS hides it under the
  // ancestor `.dash-gg-grid` scope; this is the interaction-level backstop).
  //
  // #291 review F3 (pin-during-drag): the tile is PINNED to an explicit
  // `grid-column: ${colStart+1} / span N` for the whole gesture, rather than
  // just `span N` (which lets the browser's own auto-placement re-decide the
  // tile's position on every span change). Without the pin, growing the span
  // mid-drag could make the tile SELF-WRAP to a new row via auto-placement —
  // after which `rect` (captured once at pointerdown) no longer describes the
  // tile's actual position, so every subsequent snap — including the FINAL
  // persisted one at pointerup — was measured against a stale rect. Pinning
  // means the tile can never move mid-drag, so `rect` stays valid throughout.
  // The tradeoff: an explicit start means a span that overflows the columns
  // remaining at THIS start would demand phantom implicit tracks (the same
  // overflow failure mode as F1) instead of wrapping — so both the live
  // preview and the persisted span are clamped to `columns - colStart` for
  // the gesture. Widening further than that needs a second drag after the
  // next repack (deterministic beats a jumpy mid-drag reflow).
  // #321 Full view (vertical-only resize): while `gridRenderMode === 'full'`
  // every tile renders at the full effective column count (its EFFECTIVE
  // `span`, in `gridPlacementByTile`) — horizontal pointer movement is
  // ignored entirely (no `grid-column` re-pin: the card IS full width, there
  // is no sub-span to preview), and the pointerup dispatch re-sends the
  // tile's UNCHANGED `persistedSpan` (the authored span `gridPlacementByTile`
  // also carries — never the overridden full-width `span`) alongside the new
  // height, so a Full-view resize can only ever change height.
  function wireGridResize(tileId: string, handle: HTMLElement, card: HTMLElement): void {
    handle.addEventListener('pointerdown', (event: Event) => {
      if (activeEngine !== 'grafana-grid') return;
      const start = event as PointerEvent;
      start.preventDefault();
      start.stopPropagation(); // never let the resize handle start a card drag
      const full = gridRenderMode === 'full';
      const columns = Math.max(1, currentGridColumns);
      const placement = gridPlacementByTile.get(tileId);
      const colStart = placement ? placement.colStart : 0;
      const persistedSpan = placement ? placement.persistedSpan : columns;
      // The columns actually available at this tile's pinned start — the
      // clamp ceiling for both the live preview and the persisted span
      // (tiles mode only — full view never touches span).
      const maxSpan = Math.max(1, columns - colStart);
      let curSpan = Math.min(placement ? placement.span : columns, maxSpan);
      let curHeight = placement ? placement.heightUnits : DEFAULT_GRID_HEIGHT_UNITS;
      if (!full) card.style.gridColumn = `${colStart + 1} / span ${curSpan}`;
      const rect = card.getBoundingClientRect();
      const colWidthPx = (measuredGridWidth() - GRID_GAP_PX * (columns - 1)) / columns;
      card.classList.add('dash-gg-resizing');
      const win = doc.defaultView || window;
      const move = (ev: PointerEvent): void => {
        if (!full) {
          const span = snapGridSpan(ev.clientX - rect.left, colWidthPx, GRID_GAP_PX, maxSpan);
          if (span !== curSpan) { curSpan = span; card.style.gridColumn = `${colStart + 1} / span ${curSpan}`; }
        }
        const height = snapGridHeight(ev.clientY - rect.top);
        if (height !== curHeight) { curHeight = height; setGridHeightPx(card, height); }
      };
      const up = (): void => {
        card.classList.remove('dash-gg-resizing');
        win.removeEventListener('pointermove', move as EventListener);
        win.removeEventListener('pointerup', up);
        runCommand({ type: 'update-placement', tileId, placement: { span: full ? persistedSpan : curSpan, height: curHeight } });
      };
      win.addEventListener('pointermove', move as EventListener);
      win.addEventListener('pointerup', up);
    });
  }

  // #332 tile reorder — pointer drag, NOT native HTML5 drag (a plain body drag
  // must select text, never reorder). A drag STARTS from the top-left grip with
  // no modifier, OR from anywhere on the body with ⌘/Ctrl held (the schema-graph
  // modifier model). On the grafana-grid engine the dragged tile lifts and
  // follows the pointer while the siblings reflow live to open a gap; the move
  // commits only when the dragged tile overlaps a destination slot by ≥2/3 of
  // its own area (`resolveOverlapInsertIndex`, core/tile-reorder.ts) else it
  // snaps back. The flow engine keeps the simpler point-hit-test path (its KPI
  // tiles render detached in a band, with no coherent grid slot to reflow into).
  // A completed move dispatches the same atomic `move-tile` command exactly once;
  // a cancelled move (pointercancel / window blur / Escape) leaves the document,
  // revision, and fallback untouched. Read-only never wires it.
  const prefersReducedMotion = (): boolean =>
    (doc.defaultView || window).matchMedia('(prefers-reduced-motion: reduce)').matches;
  function wireTileDrag(tileId: string, card: HTMLElement): void {
    // A completed move synthesizes a `click` on the origin card only when the
    // release lands back on it (a cross-tile release fires no native click —
    // different down/up targets). This capture-phase guard swallows that one
    // click so a table cell / log field / link under it is not activated.
    card.addEventListener('click', (event) => {
      if (clickSuppressCard === card) { event.stopPropagation(); event.preventDefault(); clickSuppressCard = null; }
    }, true);
    card.addEventListener('pointerdown', (event) => {
      const pe = event as PointerEvent;
      if (pe.button !== 0) return; // primary button only
      // The resize handle (own stopPropagation) and delete button own their own
      // gestures — never start a move from them.
      const target = pe.target as Element;
      if (target.closest('.dash-gg-resize, .dash-gg-del')) return;
      clickSuppressCard = null; // a fresh gesture never inherits a stale suppress
      // Start ONLY from the grip (no modifier), or from the body with ⌘/Ctrl.
      // A plain body press does neither → left alone for text selection.
      const fromGrip = !!target.closest('.dash-gg-grip');
      if (!fromGrip && !(pe.metaKey || pe.ctrlKey)) return;
      if (gestureActive) return; // one drag at a time — ignore a second concurrent pointer
      pe.preventDefault(); // suppress the text selection this press would otherwise start
      gestureActive = true;
      // Live reflow (float + placeholder + FLIP) is grafana-grid only; flow uses
      // the point-hit-test path. `activeEngine` is stable for the gesture.
      const liveReflow = activeEngine === 'grafana-grid';
      const startX = pe.clientX;
      const startY = pe.clientY;
      let moving = false;
      let rects: TileRect[] = [];
      let dropId: string | null = null;               // flow path: outlined hover target
      let placeholder: HTMLElement | null = null;      // grid path: holds the dragged tile's slot
      let savedHeight = '';                            // grid path: the card's grid height inline style
      let lastReflowId: string | null = null;          // grid path: last resolved insertion slot
      const touched = new Set<HTMLElement>();           // grid path: siblings carrying a FLIP transform
      const win = doc.defaultView || window;
      const gridTiles = (): HTMLElement[] =>
        [...grid.children].filter((c): c is HTMLElement => c instanceof HTMLElement && c.classList.contains('dash-gg-tile'));
      const setDrop = (id: string | null): void => {
        if (id === dropId) return;
        if (dropId) tileEls.get(dropId)!.card.classList.remove('dash-drop-target');
        dropId = id;
        if (id && id !== tileId) tileEls.get(id)!.card.classList.add('dash-drop-target');
      };
      // Move the placeholder so the dragged tile PREVIEWS at the exact final
      // index the commit will splice it to. `move-tile` does splice(from,1) then
      // splice(toIndex,0,moved), so `moved` lands AT index `toIndex` (= the
      // overlapped tile's index) — "the dragged tile takes the slot it overlaps".
      // Among the other cards (currentDoc order minus the dragged one), that is
      // insertion position `targetIndex`; sibs[targetIndex] is the card that
      // follows the gap (undefined → append, i.e. dropping onto the last slot).
      // A null / own-slot resolve returns the gap to the dragged tile's home.
      const reflowTo = (id: string | null): void => {
        if (id === lastReflowId) return;
        lastReflowId = id;
        const sibs = gridTiles().filter((c) => c !== card);
        let ref: Element | null;
        if (id && id !== tileId) {
          const targetIndex = currentDoc.tiles.findIndex((t) => t.id === id);
          ref = sibs[targetIndex] ?? null; // null → append to the grid (last slot)
        } else {
          ref = card; // snap-back preview: gap returns to the dragged tile's home slot
        }
        const first = sibs.map((c) => c.getBoundingClientRect());
        grid.insertBefore(placeholder!, ref);
        const animate = !prefersReducedMotion();
        sibs.forEach((c, i) => {
          const { dx, dy } = flipDelta(first[i], c.getBoundingClientRect());
          c.style.transition = 'none';
          c.style.transform = 'translate(' + dx + 'px,' + dy + 'px)';
          touched.add(c);
        });
        void grid.offsetWidth; // flush the inverted transforms before playing them back to 0
        touched.forEach((c) => { c.style.transition = animate ? 'transform 160ms ease' : ''; c.style.transform = ''; });
      };
      const beginMove = (): void => {
        moving = true;
        if (!liveReflow) card.classList.add('dash-moving'); // flow: dim in place (grid path floats instead)
        grid.classList.add('dash-reordering'); // user-select:none + grabbing, only now
        // Capture every grid-placed tile's home rect once, in canonical order —
        // overlap/hit-testing always measures against these home positions, so a
        // live sibling shift never feeds back into the decision.
        rects = currentDoc.tiles.flatMap((t) => {
          const c = tileEls.get(t.id)!.card;
          // A flow-engine KPI tile renders inside the band, so its card is never
          // placed in the grid; an unplaced card's {0,0,0,0} rect could spuriously
          // match. `grid.contains` is environment-independent (unlike isConnected).
          if (!grid.contains(c)) return [];
          const r = c.getBoundingClientRect();
          return [{ tileId: t.id, left: r.left, top: r.top, right: r.right, bottom: r.bottom }];
        });
        if (liveReflow) {
          // Insert a same-size placeholder in the card's slot, then lift the card
          // to a fixed follower. The card stays a grid child (position:fixed pulls
          // it out of flow in place — simpler cleanup than reparenting).
          const r0 = card.getBoundingClientRect();
          savedHeight = card.style.height;
          placeholder = h('div', { class: 'dash-tile-placeholder' });
          placeholder.style.gridColumn = card.style.gridColumn;
          placeholder.style.height = card.style.height;
          grid.insertBefore(placeholder, card);
          card.classList.add('dash-floating');
          card.style.position = 'fixed';
          card.style.left = r0.left + 'px';
          card.style.top = r0.top + 'px';
          card.style.width = r0.width + 'px';
          card.style.height = r0.height + 'px';
          card.style.zIndex = '40';
        }
      };
      const restoreDrag = (): void => {
        // Deterministic, synchronous DOM restore — never rely on the signature-
        // gated reconcile (a snap-back leaves currentDoc unchanged, so the next
        // publish would early-return without rebuilding the DOM the drag mutated).
        if (placeholder) { placeholder.remove(); placeholder = null; }
        card.classList.remove('dash-floating');
        card.style.position = card.style.left = card.style.top = card.style.width = card.style.zIndex = card.style.transform = '';
        card.style.height = savedHeight; // restore the grid height inline style (not clear it)
        touched.forEach((c) => { c.style.transition = ''; c.style.transform = ''; });
        touched.clear();
        lastGridSig = ''; // defense-in-depth: force a full grid rebuild on the next publish
      };
      const onMove = (ev: PointerEvent): void => {
        if (!moving) {
          if (!movedPastThreshold(ev.clientX - startX, ev.clientY - startY)) return;
          beginMove();
        }
        if (liveReflow) {
          card.style.transform = 'translate(' + (ev.clientX - startX) + 'px,' + (ev.clientY - startY) + 'px)';
          const floating = card.getBoundingClientRect();
          reflowTo(resolveOverlapInsertIndex(floating, rects));
        } else {
          setDrop(hitTestTile(rects, ev.clientX, ev.clientY));
        }
      };
      const cleanup = (): void => {
        win.removeEventListener('pointermove', onMove as EventListener);
        win.removeEventListener('pointerup', onUp as EventListener);
        win.removeEventListener('pointercancel', onCancel as EventListener);
        win.removeEventListener('blur', onCancel);
        doc.removeEventListener('keydown', onKey, true);
        if (moving) { if (liveReflow) restoreDrag(); else setDrop(null); }
        card.classList.remove('dash-moving');
        grid.classList.remove('dash-reordering');
        gestureActive = false;
      };
      const onUp = (ev: PointerEvent): void => {
        const wasMoving = moving;
        const targetId = !wasMoving ? null
          : liveReflow ? resolveOverlapInsertIndex(card.getBoundingClientRect(), rects)
            : hitTestTile(rects, ev.clientX, ev.clientY);
        cleanup();
        if (!wasMoving) return; // never crossed the threshold: leave the click alone
        // A completed drag that releases back over its origin card synthesizes a
        // real click on it (same down/up target) — swallow it so no cell/link/
        // preview fires. A cross-tile release fires no origin click (harmless).
        clickSuppressCard = card;
        if (targetId && targetId !== tileId) {
          runCommand({ type: 'move-tile', tileId, toIndex: currentDoc.tiles.map((t) => t.id).indexOf(targetId) });
        }
      };
      const onCancel = (): void => cleanup(); // pointercancel / window blur — cancel, never dispatch
      const onKey = (ev: KeyboardEvent): void => { if (ev.key === 'Escape') cleanup(); };
      win.addEventListener('pointermove', onMove as EventListener);
      win.addEventListener('pointerup', onUp as EventListener);
      win.addEventListener('pointercancel', onCancel as EventListener);
      win.addEventListener('blur', onCancel);
      doc.addEventListener('keydown', onKey, true);
    });
  }

  // #332: a Dashboard Text (Markdown) tile is click/keyboard-openable into the
  // SAME shared cell-detail drawer (the full Markdown, resizable, over the doc
  // viewer) — useful when the authored content overflows the tile. A drag-select
  // inside the tile, or a click on an inner link, never opens it. Wired on the
  // freshly-rendered `.md-view` each paint (so listeners never stack), in edit
  // and read-only modes alike. `title`/`content` come from the resolved tile.
  function wireTextPreview(node: HTMLElement, title: string, content: string): void {
    node.setAttribute('role', 'button');
    node.setAttribute('tabindex', '0');
    node.setAttribute('aria-label', title + ' — open Markdown preview');
    node.classList.add('dash-text-preview');
    const open = (): void => { openCellDetail(app as unknown as ResultsApp, title, 'Markdown', content, doc); };
    node.addEventListener('click', (e) => {
      if ((e.target as Element).closest('a, button, input, textarea, select')) return; // let inner links/controls act
      const sel = doc.getSelection();
      if (sel && !sel.isCollapsed && String(sel)) return; // a selection gesture, not a click
      open();
    });
    node.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
    });
  }

  function ensureTileEl(ts: ViewerTileState): TileEl {
    const existing = tileEls.get(ts.tileId);
    if (existing) return existing;
    // Grip (drag affordance) + delete are edit-mode-only (`!readOnly`, a
    // static per-load condition like the drag wiring below); both are
    // grafana-grid-only in PRACTICE, but built unconditionally once per tile
    // and gated visually (CSS, ancestor `.dash-gg-grid` scope) + at the
    // interaction level (`activeEngine` check on delete's click) so a cached
    // card carries no leftover interactive affordance while flow is active.
    // The grip is a pointer-only drag affordance (no keyboard reorder — a #332
    // non-goal), so it stays aria-hidden; the tile carries its own accessible
    // name. Dragging it starts a move with no modifier; the body needs ⌘/Ctrl.
    const grip = !readOnly ? h('span', { class: 'dash-gg-grip', title: 'Drag to move (or ⌘/Ctrl-drag the tile)', 'aria-hidden': 'true' }) : null;
    const delBtn = !readOnly ? h('button', {
      class: 'dash-gg-del', title: 'Remove tile', 'aria-label': 'Remove ' + ts.title + ' from the dashboard',
      onclick: () => { if (activeEngine === 'grafana-grid') runCommand({ type: 'remove-tile', tileId: ts.tileId }); },
    }, Icon.trash()) : null;
    const head = h('div', { class: 'dash-tile-head' }, grip, h('span', { class: 'dash-tile-name', title: ts.title }, ts.title), delBtn);
    const body = h('div', { class: 'dash-tile-body' });
    const foot = h('div', { class: 'dash-tile-foot' });
    const resizeHandle = !readOnly
      ? h('div', { class: 'dash-gg-resize', title: 'Resize', 'aria-label': 'Resize' })
      : null;
    // #316: a static, per-load mode class (view mode never toggles mid-session
    // — `readOnly` is resolved once above, before any tile is built) — CSS
    // scopes the frameless-KPI-in-view-mode treatment to
    // `.dash-gg-grid .dash-gg-tile.is-kpi.is-view` (styles.css), so it never
    // touches a non-KPI tile or a flow-rendered card (flow never adds
    // `.dash-gg-tile`/`.is-kpi` — its own KPI tiles render inside the band).
    // #332: no native `draggable` — a plain drag must select text, not start a
    // tile move. Reorder is Command/Ctrl-drag via pointer events (wireTileDrag),
    // the same modifier-gated model as the schema graph (#55). Reused verbatim
    // for grafana-grid@1 tiles (#291 — same move-tile command, no engine
    // branching). A read-only (detached view) dashboard never wires it (#288).
    const card = h('div', { class: 'dash-tile' + (readOnly ? ' is-view' : '') }, head, body, foot, resizeHandle);
    if (!readOnly) wireTileDrag(ts.tileId, card);
    if (resizeHandle) wireGridResize(ts.tileId, resizeHandle, card);
    const tileEl: TileEl = { card, body, foot, panelState: null, destroy: null, paintedRows: null, resizeHandle };
    if (resizeHandle) applyResizeHandleMode(tileEl, gridRenderMode === 'full');
    tileEls.set(ts.tileId, tileEl);
    return tileEl;
  }

  function destroyChart(tileEl: TileEl): void { if (tileEl.destroy) { tileEl.destroy(); tileEl.destroy = null; } }

  // Paint an ordinary (non-KPI) tile's result once per new result. Only ever
  // called for a 'ready' tile, so columns/rows/meta/panel are all present.
  function paintPanel(ts: ViewerTileState, tileEl: TileEl): void {
    // #331: reasserted BEFORE the unchanged-rows early return below — a
    // republish that repaints a DIFFERENT tile (e.g. a sibling's query
    // finishing) still runs this function for every ready tile with the
    // SAME `ts.rows` reference this tile painted last time, which would
    // otherwise skip past the meta check entirely and leave whatever
    // `reconcileGridTile`'s unconditional `foot.hidden = ts.isKpi` (#316)
    // last wrote in place — stale-visible for a metaless tile once any
    // other tile's data arrives.
    tileEl.foot.hidden = !ts.meta;
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
      readonly: true, cap: DASH_TABLE_DISPLAY_CAP,
      // #332: table cells and logs fields open the SAME shared Workbench
      // cell-detail drawer, in THIS dashboard's document. openCellDetail is
      // already document-agnostic (results.ts) — no Workbench-tab coupling.
      onCell: (name, type, value) => openCellDetail(app as unknown as ResultsApp, name, type, value, doc),
    });
    tileEl.destroy = out.destroy || null;
    tileEl.body.replaceChildren(out.node);
    // #332: a Text (Markdown) tile opens the shared preview drawer on click /
    // Enter-Space. Wired on the fresh node each paint (out.node is the `.md-view`
    // renderPanelMarkdown returns; recreated per paint, so no listener stacking).
    if (resolved.cfg.type === 'text') {
      wireTextPreview(out.node as HTMLElement, ts.title, String((resolved.cfg as { content?: unknown }).content ?? ''));
    }
    // #329: a 'ready' tile can legitimately carry no result meta (`ts.meta`
    // is `… | null`, only set after a query executes — a Text panel renders
    // static content and never does), so the footer is rendered only when
    // there IS meta. The previous `as NonNullable` cast lied and threw
    // `Cannot read properties of null (reading 'rows')` in `tileFooter`,
    // which — reached inside the grafana-grid reconcile loop BEFORE the host
    // gets `dash-gg-grid` — aborted the entire Grid Tiles render (#321 made
    // that the default engine). The flow renderer shares this path and had
    // the same latent crash.
    tileEl.foot.replaceChildren(...(ts.meta ? tileFooter(ts.meta) : []));
    tileEl.paintedRows = ts.rows;
  }

  // A local re-paint (header-click sort) — force even when the rows ref is
  // unchanged (the sort mutated the panel state, not the data).
  function paintForce(ts: ViewerTileState, tileEl: TileEl): void { tileEl.paintedRows = null; paintPanel(ts, tileEl); }

  // The ordinary (non-KPI) tile body: painted result, or an error/unfilled/
  // loading state card — shared by BOTH engines' reconciliation (flow's
  // `reconcileTile` skips a KPI tile entirely — it renders inside the KPI
  // band instead; grid's `reconcileGridTile` renders a KPI tile's cards
  // inline via `renderKpiInto` instead of calling this).
  function paintTileBody(ts: ViewerTileState, tileEl: TileEl): void {
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

  function reconcileTile(ts: ViewerTileState): void {
    const tileEl = ensureTileEl(ts);
    if (ts.isKpi) return; // KPI tiles are rendered inside their band, not as a card (flow only)
    paintTileBody(ts, tileEl);
  }

  // A KPI state card's role, per the #316 pinned owner decision: a genuine
  // query failure (execution error, or a blocking post-execution diagnostic
  // whose severity is 'error' — e.g. the wrong row count, or no eligible KPI
  // field) is `alert`; a zero-row result ('kpi-no-data', severity 'info' —
  // kpi.js) is expected/quiet, like loading or an unfilled parameter, so it
  // gets `status`.
  function kpiStateRole(kind: 'loading' | 'unfilled' | 'error' | 'zero-data'): 'status' | 'alert' {
    return kind === 'error' ? 'alert' : 'status';
  }

  // Render one KPI tile's cards (or its non-ready state) into `host`. On 'ready'
  // the viewer guarantees columns/rows (no defensive fallback). Every state
  // card carries the tile/query title in its accessible name (#316) — the
  // frameless view-mode tile has no visible header, so the state card is the
  // only surface that can announce which tile is loading/blocked/failed.
  function renderKpiInto(host: HTMLElement, ts: ViewerTileState): void {
    if (ts.status !== 'ready') {
      const kind = ts.status === 'error' ? 'error' : ts.status === 'unfilled' ? 'unfilled' : 'loading';
      const message = ts.status === 'error' ? (ts.error || 'Error')
        : ts.status === 'unfilled' ? 'Enter a value for: ' + ts.unfilled.join(', ') : 'Loading…';
      host.replaceChildren(h('div', {
        class: 'dash-kpi-state-card', role: kpiStateRole(kind), 'aria-label': `${ts.title}: ${message}`,
      }, message));
      return;
    }
    const panel = (ts.panel || {}) as Record<string, unknown>;
    const resolved = resolvePanel(panel as Parameters<typeof resolvePanel>[0], {
      columns: ts.columns as Column[], rows: ts.rows as unknown[][],
      fieldConfig: panel.fieldConfig as never,
      serverVersion: state.serverVersion,
    });
    const { cards, errors } = renderKpiCards(resolved.kpi);
    host.replaceChildren(...(errors.length ? errors.map((e) => h('div', {
      class: 'dash-kpi-state-card', role: kpiStateRole(e.code === 'kpi-no-data' ? 'zero-data' : 'error'),
      'aria-label': `${ts.title}: ${e.message}`,
    }, e.message)) : cards));
  }

  // ── Grid reconciliation from the flow model ───────────────────────────────
  let lastLayoutSig = '';
  function reconcileGrid(sview: DashboardViewState, layout: FlowLayoutModel): void {
    const byId = new Map(sview.tiles.map((t) => [t.tileId, t]));
    for (const ts of sview.tiles) reconcileTile(ts);
    const sig = JSON.stringify({
      m: layout.mobile, c: layout.columns, p: layout.preset,
      rows: layout.rows.map((r) => ({ k: r.kind, t: r.tiles.map((t) => [t.tileId, t.span]) })),
    });
    // Rebuild the row STRUCTURE only when the flow model changes (a reorder,
    // preset, or mobile flip) — moving stable tile cards, so charts are never
    // thrashed.
    if (sig !== lastLayoutSig) {
      lastLayoutSig = sig;
      // #291: undo any grafana-grid-only chrome a cached card picked up the
      // last time the grid engine was active (that reconciliation is gated
      // off entirely while flow renders, so it can't clean up after itself).
      grid.classList.remove('dash-gg-grid', 'is-full'); // #321: is-full is grid-engine-only chrome
      grid.classList.toggle('is-report', layout.preset === 'report');
      grid.style.gridTemplateColumns = '';
      grid.replaceChildren(...layout.rows.map((row) => {
        if (row.kind === 'kpi-band') {
          const stream = h('div', { class: 'dash-kpi-stream', ...KPI_STREAM_ARIA });
          for (const member of row.tiles) stream.appendChild(h('div', { class: 'dash-kpi-member', 'data-tile': member.tileId }));
          return h('div', { class: 'dash-row dash-kpi-band' }, stream);
        }
        const rowEl = h('div', { class: 'dash-row', style: { display: 'grid', gridTemplateColumns: `repeat(${row.columns}, minmax(0, 1fr))`, gap: '12px' } });
        for (const t of row.tiles) {
          const tileEl = tileEls.get(t.tileId);
          if (tileEl) {
            tileEl.card.classList.remove('dash-gg-tile');
            tileEl.card.style.height = ''; // #291 height-units: undo the grid engine's inline px height
            tileEl.card.style.gridColumn = `span ${t.span}`;
            rowEl.appendChild(tileEl.card);
          }
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

  // ── Grid reconciliation from the grafana-grid@1 model (#291) ─────────────
  // Rowless: a SINGLE CSS grid host, every tile (KPI or not) placed by
  // `grid-column: span N` + a direct inline px `height` (#291 height-units
  // follow-up — numeric row units, not a fixed tier class) — no row wrappers,
  // no KPI band. Tile CONTENT reuses the exact same resolvePanel/renderResolvedPanel/
  // renderKpiCards paths as flow (`reconcileGridTile` below); only the DOM
  // placement differs.
  function reconcileGridTile(ts: ViewerTileState): void {
    const tileEl = ensureTileEl(ts);
    // #316: the generic `.dash-tile-foot` (built once per tile, ensureTileEl)
    // is never populated for a KPI tile — `paintPanel`/`paintTileBody` (the
    // only other writers) never run on this branch — so its border/reserved
    // height must be suppressed at the DOM level (`hidden`, backed by a
    // styles.css `[hidden]` override strong enough to beat `.dash-tile-foot`'s
    // own `display: flex`). Toggled BOTH ways on every reconcile (not just set
    // once) so a tile whose `isKpi`/panel type flips leaves no stale hidden
    // footer behind on a non-KPI tile, or a stale visible one on a KPI tile.
    tileEl.foot.hidden = ts.isKpi;
    // The `.is-kpi` frame class and the group role/name live HERE — not in
    // `reconcileGrafanaGrid`'s structural loop — because that loop is
    // short-circuited by the grid signature (columns/span/height only), while
    // this function runs on every publish. Today `isKpi` is fixed per session
    // (tile runtimes are built once — dashboard-viewer-session.ts; a real Spec
    // change recreates session + tile DOM), so the placement is equivalent —
    // but only THIS placement stays correct if tile runtimes ever become
    // live-updatable (#287/#288 direction), and it keeps every KPI-gated
    // mutation (footer, class, role) in one spot. The card is the named group
    // a frameless view-mode KPI tile relies on for its accessible name (the
    // visual header is `display: none` in view mode, styles.css). Set in edit
    // mode too (harmless — the visible header shows the same title) rather
    // than branching on `readOnly`.
    tileEl.card.classList.toggle('is-kpi', ts.isKpi);
    if (ts.isKpi) {
      tileEl.card.setAttribute('role', 'group');
      // (`ts.title` is never empty — the session falls back through query
      // name → queryId → tile id when the tile has no explicit title.)
      tileEl.card.setAttribute('aria-label', ts.title);
    } else {
      tileEl.card.removeAttribute('role');
      tileEl.card.removeAttribute('aria-label');
    }
    if (ts.isKpi) { tileEl.foot.replaceChildren(); renderKpiInto(tileEl.body, ts); return; }
    paintTileBody(ts, tileEl);
  }

  let lastGridSig = '';
  function reconcileGrafanaGrid(sview: DashboardViewState, gridModel: GrafanaGridLayoutModel): void {
    const byId = new Map(sview.tiles.map((t) => [t.tileId, t]));
    for (const t of gridModel.tiles) {
      const ts = byId.get(t.tileId);
      if (ts) reconcileGridTile(ts);
    }
    currentGridColumns = gridModel.columns;
    const sig = JSON.stringify({ c: gridModel.columns, tiles: gridModel.tiles.map((t) => [t.tileId, t.span, t.heightUnits]) });
    // Rebuild the host STRUCTURE only when the grid model changes (a reorder,
    // resize, delete, responsive clamp, or membership change) — moving stable
    // tile cards, so charts/KPI content are never thrashed mid-drag.
    if (sig === lastGridSig) return;
    lastGridSig = sig;
    grid.classList.remove('is-report'); // flow-only preset modifier
    grid.classList.add('dash-gg-grid');
    grid.style.gridTemplateColumns = `repeat(${gridModel.columns}, 1fr)`;
    const cards: HTMLElement[] = [];
    for (const t of gridModel.tiles) {
      const tileEl = tileEls.get(t.tileId);
      if (!tileEl) continue;
      // #321: `persistedSpan` is the authored (never render-mode-overridden)
      // span — the ONLY value a Full-view resize re-persists on pointerup.
      gridPlacementByTile.set(t.tileId, {
        span: t.span, heightUnits: t.heightUnits, colStart: t.colStart, persistedSpan: t.persistedSpan,
      });
      tileEl.card.classList.add('dash-gg-tile');
      // (`is-kpi` + the group role/name are maintained by `reconcileGridTile`,
      // which runs on EVERY pass — this loop is signature-gated and would miss
      // a panel-type flip with unchanged placement.)
      tileEl.card.style.gridColumn = `span ${t.span}`;
      setGridHeightPx(tileEl.card, t.heightUnits);
      cards.push(tileEl.card);
    }
    grid.replaceChildren(...cards);
  }

  // ── Effect: reconcile on every publish (and on the mobile-breakpoint flip) ─
  let lastMobile = state.isMobile.value;
  // #291: the ENGINE rendered by the last reconciliation — a switch resets
  // both engines' own change-detection signature caches so the next publish
  // always rebuilds the host structure (clearing the OTHER engine's leftover
  // chrome: `dash-gg-grid`/`dash-gg-tile`/height classes on a flow switch, or
  // `is-report` on a grid switch) instead of a coincidental sig match
  // silently skipping that cleanup.
  let lastEngineRendered: 'flow' | 'grafana-grid' | null = null;
  let barSig = '';
  // #303: the committed-filter bag for a published view, built exactly the way
  // the persist step below and the seed just under it both need it.
  const persistBagOf = (filters: readonly ViewerFilterState[]): DashboardFilterBag => {
    const bag: DashboardFilterBag = {};
    for (const f of filters) bag[f.id] = { value: valueString(f.value), active: f.active };
    return bag;
  };
  // #303: a SEPARATE signature from `barSig` above — that one also flips when
  // curated options arrive (no committed value/active change), which would
  // otherwise trigger a redundant write. Seeded from the session's OWN initial
  // filter state (post-`initialFilters` seeding + defaults), not the raw stored
  // `initialBag`, so the very first publish — which merely echoes that state —
  // never writes: an empty/partial store would otherwise differ from the
  // default-filled published bag and persist defaults on first open, freezing
  // them against later Spec-editor changes to a filter's default.
  let lastFilterPersistSig = filterBagSignature(persistBagOf(session.state.value.filters));
  effect(() => {
    const sview = session.state.value;
    const mobileNow = state.isMobile.value; // tracked so a breakpoint flip re-runs the effect
    // A breakpoint flip after the last publish needs a fresh flow model —
    // republish through the viewer (recomputes it with the new mobile flag).
    // grafana-grid has no `mobile` concept of its own (its responsive
    // behavior is the `containerWidth`-driven effective-columns clamp below).
    if (sview.layout.engine === 'flow' && mobileNow !== lastMobile && mobileNow !== sview.layout.mobile) {
      lastMobile = mobileNow;
      session.syncDocument(currentDoc);
      return;
    }
    lastMobile = mobileNow;
    // Rebuild the shared filter bar only when its field structure changes
    // (activation, committed value, or curated options arriving) — not on tile
    // progress ticks — so in-progress typing is not disturbed mid-wave.
    const sig = JSON.stringify(sview.filters.map((f) => [f.id, f.active, valueString(f.value), !!(f.options && f.options.length)]));
    if (sig !== barSig) { barSig = sig; rebuildFilterBar(sview); }
    // #303: persist committed filter value/active into the isolated per-dashboard
    // store — isolated from the Workbench's asb:varValues/asb:filterActive keys.
    const filterBag = persistBagOf(sview.filters);
    const persistSig = filterBagSignature(filterBag);
    if (persistSig !== lastFilterPersistSig) {
      lastFilterPersistSig = persistSig;
      app.saveJSON(KEYS.dashFilters, writeDashboardFilterBag(loadJSON(KEYS.dashFilters, {}), currentDoc.id, filterBag));
    }
    tileCountLabel.textContent = sview.tiles.length + (sview.tiles.length === 1 ? ' tile' : ' tiles');
    empty.style.display = sview.tiles.length ? 'none' : '';
    // Genuine dashboard-config diagnostics only (a tile whose presentation
    // could not resolve, etc.). Per-filter "required/invalid" badges were
    // dropped as noise (owner decision) — an unfilled required filter simply
    // leaves its target tiles in their normal unfilled state.
    filterDiagnosticsHost.replaceChildren(
      ...sview.diagnostics.map((d) => h('div', { class: 'dash-config-diagnostic is-error' }, d.message)),
    );
    if (sview.layout.engine !== lastEngineRendered) { lastLayoutSig = ''; lastGridSig = ''; lastEngineRendered = sview.layout.engine; }
    activeEngine = sview.layout.engine;
    // #321: keep the local render-mode mirror current from the published
    // grafana-grid layout view — the ONLY place this session-owned, transient
    // state is read back into the UI. A change re-syncs the selector, flips
    // the grid host's `is-full` class (the CSS vertical-resize-cursor hook),
    // and updates every built resize handle's accessible label.
    if (sview.layout.engine === 'grafana-grid' && sview.layout.renderMode !== gridRenderMode) {
      gridRenderMode = sview.layout.renderMode;
      layoutSelect.sync();
      grid.classList.toggle('is-full', gridRenderMode === 'full');
      for (const tileEl of tileEls.values()) applyResizeHandleMode(tileEl, gridRenderMode === 'full');
    }
    if (sview.layout.engine === 'grafana-grid') reconcileGrafanaGrid(sview, sview.layout.grid);
    else reconcileGrid(sview, sview.layout);
    refreshBtn.disabled = sview.running;
    if (!sview.running && sview.updatedAt != null) {
      updated.textContent = 'Updated ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
  });

  const toolbar = h('div', { class: 'dash-toolbar' + (session.state.value.filters.length ? ' has-filters' : '') }, filterHost);

  // `!`: the dashboard renders only into a mounted page.
  app.root!.replaceChildren(h('div', { class: 'dash-page' },
    h('div', { class: 'dash-topbar' }, header, toolbar),
    filterDiagnosticsHost, empty, grid));

  // #291: measure the grid host's real width now that it is mounted — BEFORE
  // `session.start()`'s first publish — so the initial grafana-grid render
  // already reflects the actual container instead of the pre-mount default
  // (12 columns). A resize re-measures and forces a fresh publish (mirroring
  // how a mobile-breakpoint flip already forces one for flow, above) only
  // while the grid engine is active; flow's own responsive behavior stays the
  // untouched `state.isMobile` signal flip. `clientWidth` is always 0 under
  // happy-dom (no real layout engine) — `measuredGridWidth` then leaves
  // `containerWidthPx` `undefined`, which resolves to the widest (12-column)
  // breakpoint, exactly the useful non-DOM default `effectiveGridColumns`
  // itself documents.
  function measureGridWidth(): void {
    const w = measuredGridWidth();
    containerWidthPx = w > 0 ? w : undefined;
  }
  measureGridWidth();
  // #291 review F4: unlike a repeatedly-opened modal (e.g. the EXPLAIN graph
  // overlay), the Dashboard page is normally a single full-page navigation —
  // BUT `renderDashboard` can still run again against this SAME window
  // in place (`app.reloadDashboardRoute()`, app.ts, re-invoked from
  // file-menu.ts's Import flow while already on `/dashboard`). This module
  // never disconnects/observes page teardown, so the listener installed here
  // is removed at the START of the NEXT `renderDashboard` call instead (see
  // `installedGridResizeListener` above) rather than relying on the page
  // itself never rendering twice.
  const gridWin = doc.defaultView;
  if (gridWin) {
    const onGridResize = (): void => {
      if (activeEngine !== 'grafana-grid') return;
      const prevWidth = containerWidthPx;
      measureGridWidth();
      if (containerWidthPx !== prevWidth) session.syncDocument(currentDoc);
    };
    gridWin.addEventListener('resize', onGridResize);
    installedGridResizeListener = { win: gridWin, handler: onGridResize };
  }

  // #332: while ⌘/Ctrl is held the grid shows the grab affordance over its
  // tiles (CSS `.dash-grid.modkey`), the same cursor cue the schema graph uses.
  // Edit mode only — a read-only view is never reorderable, so it never leaks
  // the affordance. Torn down at the next renderDashboard (see top of fn).
  if (gridWin && !readOnly) {
    const onKeyDown = (e: KeyboardEvent): void => { if (e.metaKey || e.ctrlKey) grid.classList.add('modkey'); };
    const onKeyUp = (e: KeyboardEvent): void => { if (!(e.metaKey || e.ctrlKey)) grid.classList.remove('modkey'); };
    const onBlur = (): void => grid.classList.remove('modkey');
    gridWin.addEventListener('keydown', onKeyDown);
    gridWin.addEventListener('keyup', onKeyUp);
    gridWin.addEventListener('blur', onBlur);
    installedModifierListeners = { win: gridWin, onKeyDown, onKeyUp, onBlur };
  }

  await session.start();
}
