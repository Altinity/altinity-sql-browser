// The live Dashboard surface (#149 / #240 / #280 / #286 / #407). Phase 4 of #280
// FLIPS Dashboard membership reads off `spec.favorite` and onto
// `dashboard.tiles[]`: this module resolves the current `StoredWorkspaceV2`
// from `app.currentWorkspace`, constructs a `DashboardViewerSession` over that
// document + the workspace
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
import { buildAppHeader, routeButton } from './app-header.js';
import { openMenu } from './menu.js';
import type { MenuHandle, MenuRow } from './menu.js';
import { flashToast } from './toast.js';
import { renderResolvedPanel } from './panels.js';
import { openCellDetail } from './results.js';
import type { ResultsApp } from './results.js';
import { movedPastThreshold, hitTestTile, resolveOverlapInsertIndex, flipDelta } from '../core/tile-reorder.js';
import type { TileRect } from '../core/tile-reorder.js';
import { createDragAutoScroll } from '../core/dashboard-autoscroll.js';
import type { DragAutoScrollController, DragAutoScrollTarget, FrameScheduler } from '../core/dashboard-autoscroll.js';
import { resolvePanel } from '../core/panel-cfg.js';
import type { Column } from '../core/panel-cfg.js';
import { DASH_TILE_ROW_CAP, DASH_TABLE_DISPLAY_CAP } from '../core/dashboard.js';
import {
  formatBytes as formatBytesUntyped, formatRows as formatRowsUntyped,
} from '../core/format.js';
import { analyzeParameterizedSources, fieldControls } from '../core/param-pipeline.js';
import type { ValidationMode } from '../core/param-pipeline.js';
import { queryDashboardRole } from '../dashboard/model/workspace-semantics.js';
import { queryFavorite } from '../core/saved-query.js';
import { selectOutputColumns } from '../core/select-columns.js';
import { renderKpiCards, KPI_STREAM_ARIA } from './kpi-panel.js';
import { buildFilterBar, FILTER_DEBOUNCE_MS } from './filter-bar.js';
import type { FilterBarApp, FilterBarHandle } from './filter-bar.js';
import { pushRecentRange } from '../core/time-range.js';
import { formatChartTimeLabel, formatChartTimeRange } from '../core/time-range.js';
import type { DashboardTimeRangeGroup, TimeRangeRecent } from '../core/time-range.js';
import { chartColors } from '../core/chart-data.js';
import { createDashboardChartInteractionController } from './dashboard-chart-interaction.js';
import type { DashboardChartInteractionController } from './dashboard-chart-interaction.js';
import { createDashboardViewerSession } from '../dashboard/application/dashboard-viewer-session.js';
import type {
  DashboardViewerSession, DashboardViewState, DashboardStyle, ViewerTileState, ViewerFilterState,
} from '../dashboard/application/dashboard-viewer-session.js';
import { defaultLayoutRegistry, resolveLayoutPluginSync } from '../dashboard/layouts/layout-registry.js';
import type { FlowLayoutModel } from '../dashboard/layouts/flow-layout.js';
import {
  DEFAULT_GRID_HEIGHT_UNITS, GRAFANA_GRID_MAX_COLUMNS, GRID_GAP_PX, GRID_HEIGHT_UNIT_MAX, GRID_HEIGHT_UNIT_MIN,
  contentBoxWidth, deriveFlowFallback,
  gridHeightUnitsToPx, snapGridHeight, snapGridSpan,
} from '../dashboard/layouts/grafana-grid-layout.js';
import type { GrafanaGridLayoutModel, GridRenderMode } from '../dashboard/layouts/grafana-grid-layout.js';
import { applyCommand } from '../dashboard/application/dashboard-commands.js';
import type { DashboardCommand } from '../dashboard/application/dashboard-commands.js';
import { removeTileMembership } from '../dashboard/application/tile-membership.js';
import { createEmptyDashboard } from '../dashboard/application/empty-dashboard.js';
import { createQueryResolver } from '../dashboard/application/dashboard-query-resolver.js';
import {
  readDashboardFilterBag, writeDashboardFilterBag, filterBagSignature,
} from '../dashboard/model/dashboard-filter-store.js';
import type { DashboardFilterBag } from '../dashboard/model/dashboard-filter-store.js';
import { loadJSON } from '../core/storage.js';
import { KEYS } from '../state.js';
import type {
  DashboardDocumentV1, DashboardFilterDefinitionV1, DashboardLayoutDocumentV1, FlowPresetV1,
  SavedQueryV2, StoredWorkspaceV2,
} from '../generated/json-schema.types.js';
import type { App, AppDom, ActionsRegistry } from './app.types.js';
import type { SqlRoute } from '../core/sql-route.js';
import type { AppState } from '../state.js';
import type { ConnectionSession } from '../application/connection-session.js';
import type { QueryExecutionService } from '../application/query-execution-service.js';
import type { WorkbenchParameterSession } from '../application/workbench-parameter-session.js';
import type { WorkspaceCommitResult, WorkspaceRepository } from '../workspace/workspace-repository.js';
import type { AppPreferences } from '../application/app-preferences.js';

// icons.js is unconverted — the six icons this module appends, pinned to the
// one honest shape (same wrapper the pre-#286 module used).
const Icon: {
  star(filled?: boolean): SVGElement;
  spinner(): SVGElement;
  refresh(): SVGElement;
  sun(): SVGElement;
  moon(): SVGElement;
  trash(): SVGElement;
  chevDown(): SVGElement;
  download(): SVGElement;
  upload(): SVGElement;
  search(): SVGElement;
} = IconUntyped;

const formatRows: (n: number | null | undefined) => string = formatRowsUntyped;
const formatBytes: (n: number | null | undefined) => string = formatBytesUntyped;

/** The narrow `app` surface this render module reads (not the full App —
 *  matches the convention results.ts/filter-bar.ts established). */
export interface DashboardApp {
  document: Document;
  state: AppState;
  cssVar(name: string): string;
  dom: AppDom;
  root: Element | null;
  toggleTheme(): void;
  conn: Pick<ConnectionSession, 'basePath' | 'host' | 'email' | 'ensureFreshToken' | 'chCtx'>;
  exec: Pick<QueryExecutionService, 'executeRead'>;
  now(): number;
  wallNow(): number;
  params: Pick<WorkbenchParameterSession, 'recordBoundParams' | 'clearVarRecent'>;
  workspace: Pick<WorkspaceRepository, 'commit'>;
  currentWorkspace: StoredWorkspaceV2 | null;
  sqlRoute: SqlRoute;
  navigateSqlRoute(route: SqlRoute, method: 'push' | 'replace'): Promise<void>;
  surfaceCommands: App['surfaceCommands'];
  keyboardOwner: App['keyboardOwner'];
  acquireKeyboardOwner: App['acquireKeyboardOwner'];
  resetShortcutChord: App['resetShortcutChord'];
  renderDashboard(): void;
  captureSurfaceGeneration(): number;
  isSurfaceGenerationCurrent(generation: number): boolean;
  refreshCurrentSurfaceAfterStale(generation: number, committed?: boolean): boolean;
  applyCommittedWorkspace(workspace: StoredWorkspaceV2): void;
  // #341/#344: every editable Dashboard command commits through
  // `mutateWorkspace` — the same serialized-queue-plus-read-at-dequeue seam
  // saved-query mutations use, so a rapid sequence of drag/resize/preset/
  // delete commands can't interleave, and a Dashboard commit's candidate is
  // always built from whatever the LATEST committed workspace is (any
  // producer's), never a route-local snapshot that another producer's
  // in-flight commit could make stale.
  mutateWorkspace: App['mutateWorkspace'];
  // #343 step 6: the route/surface refresh hook — `renderDashboard` overrides it
  // (per render) so an external workspace change rebuilds this viewer session from
  // committed truth. Fires only AFTER the app-level refresh projected a real change.
  onWorkspaceExternallyChanged: App['onWorkspaceExternallyChanged'];
  // #302 — the Dashboard page's own File-menu operations.
  actions: Pick<ActionsRegistry, 'exportDashboard' | 'importDashboard' | 'openShortcuts' | 'openUserMenu'>;
  genId(): string;
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

/** #189: an array-safe stand-in for `valueString`, used ONLY by the filter-bar
 *  rebuild signature below — an array JSON-encodes (so a committed
 *  `['a','b']` is distinct from the joined string `"a,b"`, which
 *  `valueString`'s `String()` fallback would otherwise collapse it to);
 *  every other value keeps `valueString`'s own coercion, unchanged. */
const sigValue = (value: unknown): string => (Array.isArray(value) ? JSON.stringify(value) : valueString(value));

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
// An in-flight move owns window/document listeners and pointer capture. A new
// route render must cancel it before replacing the page so no stale gesture can
// commit into the newly-rendered Dashboard.
let installedGestureCancel: (() => void) | null = null;
let installedDashboardChartInteraction: DashboardChartInteractionController | null = null;
let installedDashboardCleanup: (() => void) | null = null;

/** Tear down every resource owned by the currently mounted Dashboard surface. */
function keyboardOwnerChannel(app: Pick<DashboardApp, 'acquireKeyboardOwner'>): (owner: App['keyboardOwner']) => void {
  let release: (() => void) | null = null;
  return (owner) => {
    release?.();
    release = owner ? app.acquireKeyboardOwner(owner.kind) : null;
  };
}

export function disposeDashboardSurface(): void {
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
  if (installedGestureCancel) installedGestureCancel();
  installedDashboardCleanup?.();
  installedDashboardCleanup = null;
}

/** Build the Dashboard style picker with the same trigger and dropdown
 * vocabulary as File. The trigger shows only the active style; `sync()`
 * reflects session changes without adding a second header label. */
type LayoutOption = [value: DashboardStyle, label: string, title: string, shortcut: string];
function dashboardStyleKeyCaps(shortcut: string): HTMLElement {
  const key = shortcut.toUpperCase();
  return h('kbd', { class: 'dash-style-key' }, `G + ${key}`);
}
function buildLayoutMenu(
  doc: Document, onKeyboardOwnerChange: (owner: App['keyboardOwner']) => void,
  options: LayoutOption[], getActive: () => string, onPick: (value: DashboardStyle) => void, ariaLabel: string,
): { el: HTMLButtonElement; sync: () => void } {
  const label = h('span');
  const el = h('button', {
    class: 'hd-file-btn dash-style-btn', 'aria-haspopup': 'menu', 'aria-expanded': 'false',
    title: ariaLabel,
  }, label, Icon.chevDown()) as HTMLButtonElement;
  let handle: MenuHandle | null = null;
  const sync = (): void => {
    const active = getActive();
    const option = options.find(([value]) => value === active);
    label.textContent = option?.[1] ?? active;
    el.value = active;
    el.dataset.value = active;
    el.setAttribute('aria-label', `${ariaLabel}: ${label.textContent}`);
  };
  const open = (): void => {
    const active = getActive();
    handle = openMenu({
      document: doc,
      trigger: el,
      menuClass: 'dash-file-menu dash-style-menu',
      rows: options.map(([value, optionLabel, _title, shortcut]) => ({
        kind: 'item',
        label: optionLabel,
        trailing: dashboardStyleKeyCaps(shortcut),
        extraClass: 'dash-style-item',
        onClick: () => onPick(value),
      })),
      onClose: () => { handle = null; },
      onKeyboardOwnerChange,
    });
  };
  el.onclick = () => { if (handle) { handle.close(); el.focus(); } else open(); };
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
 *
 *  #189/#364 (Bug 3): when a favorited `filter`-role saved query outputs a
 *  column whose name equals the parameter, the synthesized filter also gets
 *  that query's `sourceQueryId`, so its option list attaches automatically (the
 *  field becomes a curated combobox instead of a plain text box). A parameter
 *  produced by EXACTLY ONE favorited filter source binds; zero or more than one
 *  (ambiguous) leaves the filter plain — ambiguity degrades gracefully, never
 *  guesses.
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
  // column name -> the favorited filter-role source ids that output it.
  const columnSources = new Map<string, Set<string>>();
  for (const source of queryById.values()) {
    if (queryDashboardRole(source) !== 'filter' || !queryFavorite(source)) continue;
    for (const column of selectOutputColumns(source.sql)) {
      let ids = columnSources.get(column);
      if (!ids) { ids = new Set(); columnSources.set(column, ids); }
      ids.add(source.id);
    }
  }
  const out: DashboardFilterDefinitionV1[] = [];
  for (const control of fieldControls(analysis)) {
    if (declared.has(control.name)) continue;
    const def: DashboardFilterDefinitionV1 = { id: control.name, parameter: control.name };
    const ids = columnSources.get(control.name);
    if (ids && ids.size === 1) def.sourceQueryId = [...ids][0];
    out.push(def);
  }
  return out;
}

/** #407 — an explicit workspace route that no longer resolves. */
function renderDashboardNotFound(app: DashboardApp): void {
  // `!`: the dashboard renders only into a mounted page.
  app.root!.replaceChildren(h('div', { class: 'dash-page dash-notfound' },
    h('div', { class: 'dash-empty' },
      h('h2', { class: 'dash-notfound-title' }, 'Workspace not found'),
      h('p', null, 'This workspace no longer exists on this browser.'))));
}

function renderMissingDashboard(
  app: DashboardApp, readOnly: boolean, surfaceGeneration: number,
): void {
  const body = readOnly
    ? h('div', { class: 'dash-empty' },
      h('h2', null, 'This workspace has no dashboard'))
    : h('div', { class: 'dash-empty' },
      h('h2', null, 'Create a dashboard for this workspace'),
      h('button', {
        class: 'dash-btn dash-create',
        onclick: async () => {
          const outcome = await app.mutateWorkspace((latest) => {
            if (!latest || latest.dashboard) return null;
            return { candidate: { ...latest, dashboard: createEmptyDashboard(app.genId()) } };
          });
          if (!app.refreshCurrentSurfaceAfterStale(surfaceGeneration, outcome.ok)) return;
          if (outcome.ok) app.renderDashboard();
        },
      }, 'Create dashboard'));
  app.root!.replaceChildren(h('div', { class: 'dash-page' },
    h('div', { class: 'dash-topbar' },
      buildAppHeader(app as App, {
        fileButton: buildDashboardFileMenu(app, readOnly),
        workspaceTitleEditable: !readOnly,
      }),
      h('div', { class: 'dash-toolbar dash-toolbar-primary' },
        h('span', { class: 'dash-toolbar-spacer' }),
        buildDashboardModeSwitch(app))),
    body));
}

function buildDashboardModeSwitch(app: DashboardApp): HTMLElement {
  const route = app.sqlRoute as Extract<SqlRoute, { surface: 'dashboard' }>;
  const routeKey = app.currentWorkspace?.key ?? route.workspaceKey;
  const button = (label: 'View' | 'Edit', mode: 'view' | 'edit'): HTMLButtonElement =>
    routeButton(label, route.mode === mode, () => {
      void app.navigateSqlRoute({ surface: 'dashboard', workspaceKey: routeKey, mode }, 'replace');
    });
  return h('div', {
    class: 'editor-mode-switch dashboard-mode-switch',
    role: 'group', 'aria-label': 'Dashboard mode',
  }, button('View', 'view'), button('Edit', 'edit'));
}

/** #302/#331 — the standalone Dashboard header's own "File" menu: a keyboard-
 *  and screen-reader-accessible dropdown owning Dashboard-scoped operations,
 *  built on the shared `openMenu` primitive (menu.ts) — the same structure +
 *  interaction grammar (icons, `.fm-section` headings, Esc/outside-click
 *  close + focus-restore, ArrowUp/ArrowDown roving focus) as the Workbench
 *  File menu, with Dashboard-specific CONTENTS:
 *    EXPORT   ⭳ Export Dashboard…   .json
 *    IMPORT   ⭱ Import Dashboard…
 *  The unified live workspace makes Export safe in both modes; read-only view
 *  omits only the mutating Import row, while retaining the same File word and
 *  header position as Workbench. Every item delegates to an `app.actions.*`
 *  seam (dashboard.ts never reaches into app.ts). The trigger uses the shared downward-chevron
 *  treatment (`Icon.chevDown()`, matching the Workbench File button) rather
 *  than a right-pointing arrow, which would misread as navigation. The
 *  trigger owns its own open/close TOGGLE (unlike the Workbench menu, which
 *  only ever opens) — clicking it again while open closes the menu and
 *  restores focus, tracked here via the returned `MenuHandle` rather than a
 *  second `openMenu` call. */
function buildDashboardFileMenu(app: DashboardApp, readOnly = false): HTMLButtonElement {
  const doc = app.document;
  const btn = h('button', {
    class: 'hd-file-btn dash-file-btn', 'aria-haspopup': 'menu', 'aria-expanded': 'false',
    title: 'File — dashboard import/export', 'aria-label': 'Dashboard File menu',
  }, h('span', null, 'File'), Icon.chevDown()) as HTMLButtonElement;

  let handle: MenuHandle | null = null;
  const onKeyboardOwnerChange = keyboardOwnerChannel(app);

  const open = (): void => {
    const rows: MenuRow[] = [
      { kind: 'section', label: 'Export' },
      {
        kind: 'item', icon: Icon.download(), label: 'Export Dashboard…', meta: '.json', extraClass: 'dash-fm-item',
        onClick: () => app.actions.exportDashboard(),
      },
      ...(!readOnly ? [
        { kind: 'section' as const, label: 'Import' },
        {
          kind: 'item' as const, icon: Icon.upload(), label: 'Import Dashboard…', extraClass: 'dash-fm-item',
          onClick: () => app.actions.importDashboard(),
        },
      ] : []),
    ];
    handle = openMenu({
      document: doc, trigger: btn, rows, menuClass: 'dash-file-menu',
      onClose: () => { handle = null; },
      onKeyboardOwnerChange,
    });
  };

  btn.onclick = () => { if (handle) { handle.close(); btn.focus(); } else open(); };
  return btn;
}

/** Render the dashboard into `app.root`. */
export async function renderDashboard(app: DashboardApp): Promise<void> {
  const { document: doc, state } = app;
  const surfaceGeneration = app.captureSurfaceGeneration();
  doc.documentElement.setAttribute('data-theme', state.theme);
  doc.documentElement.setAttribute('data-density', state.density);
  app.dom = {};

  // #291 review F4: remove any grid resize listener a PRIOR renderDashboard
  // call installed on this window before this call installs its own (see
  // `installedGridResizeListener`'s own doc comment above).
  disposeDashboardSurface();
  app.surfaceCommands = null;

  const workspace = app.currentWorkspace;
  const readOnly = app.sqlRoute.surface === 'dashboard' && app.sqlRoute.mode === 'view';
  if (!workspace) { renderDashboardNotFound(app); return; }
  app.onWorkspaceExternallyChanged = () => {
    if (app.sqlRoute.surface === 'dashboard') app.renderDashboard();
  };
  if (!workspace.dashboard) {
    renderMissingDashboard(app, readOnly, surfaceGeneration);
    return;
  }

  const queries: SavedQueryV2[] = workspace.queries;
  const queryById = new Map<string, SavedQueryV2>();
  for (const query of queries) if (!queryById.has(query.id)) queryById.set(query.id, query);

  // The live document — layout/order edits replace it; membership is read from
  // `dashboard.tiles[]` (NOT `savedQueries.filter(queryFavorite)`).
  let currentDoc: DashboardDocumentV1 = workspace.dashboard;
  let committedRevision = currentDoc.revision;
  // #341/#344 review fix: `committedWorkspace` is now ONLY a render/rollback
  // CACHE of the last commit this route observed — never the baseline a
  // command's candidate is built from. A route-local baseline goes stale the
  // moment ANY other producer (a saved-query star/delete from the drawer, a
  // File-menu import/rename) commits through the shared queue while a
  // Dashboard commit is pending: the next Dashboard command would otherwise
  // rebuild its candidate from this stale snapshot and silently reverse that
  // other producer's mutation. `null` when no persisted aggregate exists yet
  // (legacy/empty) — commands then stay optimistic-only, same as before #341.
  let committedWorkspace: StoredWorkspaceV2 | null = workspace;
  // #344 review fix: queued command DESCRIPTORS (dispatch order), not
  // pre-built document snapshots. A snapshot-based queue (the pre-#344
  // `latestOptimistic` scheme) still lost updates: command B's optimistic doc
  // is built by applying B on top of A's optimistic doc, so if A's commit
  // FAILS after B has already published, A's rollback was skipped (gate
  // failed for A) and B's later successful commit persisted a document that
  // structurally CONTAINED A's rejected edit. Re-applying each descriptor
  // against COMMITTED truth at dequeue time (never the optimistic doc it was
  // dispatched against) is what makes a failed/aborted command's effect
  // disappear from every commit that resolves after it.
  let pendingCommands: DashboardCommand[] = [];
  // #350: set when a rebase RESTORES membership `syncDocument` cannot apply
  // (see `settleCommand`) — the route rebuilds once the queue drains.
  let needsRebuild = false;

  // Merge explicit + synthesized implicit filters for the viewer.
  const withImplicitFilters = (d: DashboardDocumentV1): DashboardDocumentV1 => (
    { ...d, filters: [...(d.filters || []), ...synthesizeImplicitFilters(d, queryById)] }
  );
  const viewerDoc: DashboardDocumentV1 = withImplicitFilters(currentDoc);

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
  let trackedSessionTileIds = new Set(viewerDoc.tiles.map((tile) => tile.id));
  const syncSessionDocument = (next: DashboardDocumentV1): void => {
    session.syncDocument(next);
    trackedSessionTileIds = new Set(next.tiles.map((tile) => tile.id));
  };

  // ── Header chrome ───────────────────────────────────────────────────────
  const tileCountLabel = h('span');
  const tileCount = h('span', { class: 'dash-chip dash-tile-count' }, tileCountLabel);
  const updated = h('span', { class: 'dash-updated' });
  const refreshBtn = h('button', {
    class: 'editor-mode-btn dash-refresh', title: 'Re-run all tiles', 'aria-label': 'Refresh dashboard',
  }, 'Refresh');
  const refreshControl = h('div', { class: 'editor-mode-switch dash-refresh-wrap' }, refreshBtn);
  refreshBtn.onclick = () => session.refresh();
  // ── Preset switcher (change-layout command) ───────────────────────────────
  // #321: the local mirror of the viewer session's TRANSIENT grid render-mode
  // override ('tiles'|'full') — read by `getActive`/`onPick` below (built
  // synchronously, before the first publish) and kept current by the render
  // effect (Part D) whenever `sview.layout.renderMode` changes.
  let gridRenderMode: GridRenderMode = 'tiles';
  // 2026-07-18 owner override: moved off the filter toolbar and into the top
  // header row (right after File) so the toolbar's whole width is available
  // for filters; its File-style menu keeps the active layout visible without
  // a second header label.
  // #321: "Full view" is a TRANSIENT runtime render-mode override over the
  // grafana-grid engine (never persisted) — it sits alongside "Grid Tiles" in
  // the editable menu. A read-only view gets a REDUCED
  // menu with only those two entries — layout editing (the flow presets,
  // and the flow<->grid engine switch) stays an edit-mode-only affordance,
  // but the render-mode toggle is harmless to expose read-only since it never
  // persists anything.
  const EDITABLE_LAYOUT_OPTIONS: LayoutOption[] = [
    ['grafana-grid', 'Grid Tiles', 'A responsive tile grid using authored spans and heights', 'G'],
    ['full', 'Full view', 'Temporary full-width view — tile widths are not saved', 'F'],
    ['report', 'Report', 'One centered, taller tile per row', 'R'],
    ['columns-2', '2 columns', 'Arrange tiles in two columns', '2'],
    ['columns-3', '3 columns', 'Arrange tiles in three columns', '3'],
  ];
  const getActiveLayoutOption = (): string => (currentDoc.layout.type === 'grafana-grid'
    ? (gridRenderMode === 'full' ? 'full' : 'grafana-grid')
    : typeof currentDoc.layout.preset === 'string' ? currentDoc.layout.preset : 'report');
  let layoutMenu: { el: HTMLButtonElement; sync: () => void };
  const selectLayout = (value: DashboardStyle): void => {
      if (readOnly) {
        session.setDashboardStyle(value as DashboardStyle);
        layoutMenu.sync();
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
        layoutMenu.sync();
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
        layoutMenu.sync();
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
      layoutMenu.sync();
  };
  layoutMenu = buildLayoutMenu(
    doc, keyboardOwnerChannel(app),
    EDITABLE_LAYOUT_OPTIONS,
    () => readOnly ? session.state.value.style : getActiveLayoutOption(),
    selectLayout,
    'Dashboard style',
  );
  // The global shortcut reaches this route-local port only while its renderer
  // generation is current. It is cleared by both Dashboard cleanup and every
  // application surface transition.
  const commandPort = {
    surface: 'dashboard' as const,
    generation: surfaceGeneration,
    refresh: () => session.refresh(),
    setDashboardStyle: selectLayout,
  };
  app.surfaceCommands = commandPort;
  const layoutWrap = h('div', { class: 'dash-layout-wrap' }, layoutMenu.el);

  // Dashboard keeps the shared header's File word and placement. View exposes
  // the safe Export row only; edit additionally exposes Import.
  const header = buildAppHeader(app as App, {
    fileButton: buildDashboardFileMenu(app, readOnly),
    workspaceTitleEditable: !readOnly,
  });

  const dashboardModeSwitch = buildDashboardModeSwitch(app);

  let tileSearchTimer: ReturnType<typeof setTimeout> | null = null;
  const commitTileSearch = (input: HTMLInputElement): void => {
    if (tileSearchTimer != null) clearTimeout(tileSearchTimer);
    tileSearchTimer = null;
    session.setTileSearch(input.value);
  };
  const tileSearchInput = h('input', {
    class: 'dash-tile-search', type: 'search', placeholder: 'Search tiles',
    'aria-label': 'Search dashboard tiles',
    oninput: (event: Event) => {
      const input = event.target as HTMLInputElement;
      if (tileSearchTimer != null) clearTimeout(tileSearchTimer);
      tileSearchTimer = setTimeout(() => commitTileSearch(input), FILTER_DEBOUNCE_MS);
    },
    onblur: (event: Event) => commitTileSearch(event.target as HTMLInputElement),
    onkeydown: (event: KeyboardEvent) => {
      if (event.key === 'Enter') commitTileSearch(event.target as HTMLInputElement);
    },
  }) as HTMLInputElement;
  const tileSearch = h('label', { class: 'dash-tile-search-wrap' },
    Icon.search(), tileSearchInput);
  const timeFilterHost = h('div', {
    class: 'dash-time-filter-host dash-filters',
    role: 'group', 'aria-label': 'Dashboard time filters',
  });
  const ordinaryFilterHost = h('div', {
    class: 'dash-filter-host dash-filters',
    role: 'group', 'aria-label': 'Dashboard filters',
  });
  const ordinaryTimeIds = new Set(session.timeRangeGroups.flatMap((group) =>
    [group.fromFilterId, group.toFilterId]));
  const ordinaryFilterIds = session.state.value.filters
    .filter((filter) => !ordinaryTimeIds.has(filter.id)).map((filter) => filter.id);
  const clearFiltersBtn = h('button', {
    class: 'dash-clear-filters', type: 'button', disabled: true,
    onclick: () => { void session.resetFilters(ordinaryFilterIds); },
  }, 'Clear all') as HTMLButtonElement;

  // ── Filter bar (shared buildFilterBar, viewer-backed) ─────────────────────
  // The compound time controls mount in the primary row; ordinary controls
  // mount in the second scrolling row beside selective Clear all.
  // #189: a PERSISTENT sr-only announcer, a SIBLING of `filterHost` (never a
  // child — `filterHost.replaceChildren` below only ever replaces the bar's
  // own root) so it survives the very rebuild that fires it: when a rebuild
  // disposes an outgoing bar that had a multiselect popover open, the dispose
  // silently Cancels that popover (see multi-select-field.ts), and this is
  // the only trace of that left for an assistive-tech user.
  const filterRefreshLiveEl = h('div', { class: 'sr-only', 'aria-live': 'polite' });
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
  // #189: the retained bar itself (not just its `dispose`) — `hasOpenMultiSelect`
  // is read off it right before a rebuild disposes it (see below).
  let currentFilterBar: FilterBarHandle | null = null;
  // #360: the retained bar's `updateStatus` — a status-only publish (below,
  // the `barSig`/status-signal split) calls this directly instead of tearing
  // down and rebuilding the whole bar.
  let filterBarUpdateStatus: FilterBarHandle['updateStatus'] | null = null;
  // Maintainer merge-gate fix (#189): each parameter's `optionsRev` as of the
  // CURRENTLY-RETAINED bar's own build — compared, below, against the
  // incoming view's `optionsRev` for whichever parameter had an open (or
  // just-closed) multiselect popover, so the refresh announcement fires only
  // when that parameter's options actually changed content, never merely
  // because a rebuild happened to run while (or right after) its popover was
  // up. Replaced wholesale after every rebuild (never merged) — a filter that
  // disappears from `sview.filters` simply drops out.
  let lastBuiltOptionsRev = new Map<string, number>();
  // #335: shell-owned, session-lifetime per-group "Recently used" ranges,
  // keyed by `group.key`. NOT persisted in v1 (owner decision) and naturally
  // discarded when this `renderDashboard` call's session is torn down or the
  // dashboard switches (a fresh render builds a fresh map). Each successful,
  // changing commit pushes the OUTGOING committed pair (see `onApplyTimeRange`
  // in `rebuildFilterBar`).
  const timeRangeRecents = new Map<string, TimeRangeRecent[]>();
  const timeRangeApplyGeneration = new Map<string, number>();
  const groupByTileId = new Map(session.timeRangeGroups.flatMap((group) => group.tileIds.map((tileId) => [tileId, group] as const)));

  const applyTimeRange = async (
    group: DashboardTimeRangeGroup, from: string, to: string,
  ): Promise<void> => {
    const generation = (timeRangeApplyGeneration.get(group.key) ?? 0) + 1;
    timeRangeApplyGeneration.set(group.key, generation);
    const filterById = new Map(session.state.value.filters.map((filter) => [filter.id, filter] as const));
    const fromF = filterById.get(group.fromFilterId);
    const toF = filterById.get(group.toFilterId);
    const outFrom = fromF ? valueString(fromF.value) : '';
    const outTo = toF ? valueString(toF.value) : '';
    const wasActive = !!(fromF?.active && toF?.active);
    const result = await session.applyFilters([
      { filterId: group.fromFilterId, value: from, active: true },
      { filterId: group.toFilterId, value: to, active: true },
    ]);
    if (!app.isSurfaceGenerationCurrent(surfaceGeneration)) return;
    if (timeRangeApplyGeneration.get(group.key) !== generation) return;
    /* v8 ignore next 3 -- the mounted controls and chart formatter prevalidate;
       retained for a stale/destroyed-session race so failure is announced. */
    if (!result.ok) {
      filterRefreshLiveEl.textContent = `Time range was not changed: ${result.error}`;
      return;
    }
    if (result.changed && wasActive && outFrom !== '' && outTo !== '' && (outFrom !== from || outTo !== to)) {
      timeRangeRecents.set(group.key,
        pushRecentRange(timeRangeRecents.get(group.key) ?? [], { from: outFrom, to: outTo }));
    }
    filterRefreshLiveEl.textContent = `Time range applied: ${from} → ${to}`;
  };

  const chartInteraction = createDashboardChartInteractionController({
    document: doc,
    formatLabel: formatChartTimeLabel,
    colors: () => {
      const colors = chartColors(app.cssVar);
      return {
        // Amber deliberately stays distinct from the blue chart palette and
        // selection band in both themes.
        crosshair: app.cssVar('--warn-fg').trim() || '#D97706',
        selectionFill: 'rgba(0, 121, 173, 0.18)', selectionStroke: colors.accent,
        labelBackground: colors.bgModal, labelText: colors.fg,
      };
    },
  });
  installedDashboardChartInteraction = chartInteraction;

  function rebuildFilterBar(sview: DashboardViewState): void {
    // #189-F2b, GENERALIZED (#335): ask the OUTGOING bar WHICH control's
    // popover is open (if any) BEFORE disposing it — disposing while open is
    // that control's own silent Cancel (multi-select-field.ts /
    // time-range-field.ts), so this is the only chance to notice it, tell an
    // assistive-tech user their popover just closed out from under them (the
    // shared `filterRefreshLiveEl`, never torn down by the rebuild), and move
    // focus to that SAME control's trigger on the freshly-built bar below
    // (never left stranded at `<body>` — F2 review finding). The key is a
    // parameter name for a multiselect field, `group:…` for a time-range one.
    const openPopoverKey = currentFilterBar?.openPopoverKey() ?? null;
    // Maintainer merge-gate fix (#189): an ordinary Apply already closed its
    // OWN popover before its commit callback reached the session — by the
    // time that commit's synchronous `publish()` gets here, `openPopoverKey`
    // above already reads `null` for it. `focusedFieldKey` still finds it
    // (focus sits on that control's about-to-be-detached trigger), so focus
    // restoration below has a signal to work with even when there was no open
    // popover to speak of — never used for the ANNOUNCE decision (only a
    // genuinely open popover's cancellation is ever worth announcing).
    const focusedFieldKey = currentFilterBar?.focusedFieldKey() ?? null;
    const restoreFocusKey = openPopoverKey ?? focusedFieldKey;
    currentFilterBar?.dispose();
    const idByParam = new Map<string, string>();
    // #360: curation is gated on TOPOLOGY (`sourceId != null`, set once at
    // construction from the filter definition's `sourceQueryId`), never on
    // the transient `status` — status is execution state, not topology. A
    // source-backed filter starts `status: 'idle'` before its source has even
    // run, so gating curation on status instead would render it as a bare,
    // enabled plain-text control until the source settled. A plain
    // (non-source-backed) filter has no `sourceId` and is never gated into
    // this path.
    const curatedFields: Record<string, {
      options: NonNullable<ViewerFilterState['options']>;
      status: ViewerFilterState['status'];
      stale?: boolean;
      waitingFor?: string[];
      selection?: ViewerFilterState['selection'];
      value?: unknown;
      active?: boolean;
    }> = {};
    for (const f of sview.filters) {
      // #189: the draft bag (`app.state.varValues`, `Record<string,string>`)
      // cannot hold an array — a MULTISELECT filter never reads it at all
      // (stays `''`); a single-select-on-Array-contract filter seeds it with
      // the committed array's FIRST element, for display only (its own
      // commit bypasses the draft bag entirely — see filter-bar.ts's
      // `onApplyCurated`/`wrapsArray`). Every other filter keeps the
      // pre-#189 `valueString(f.value)` seed unchanged.
      if (f.selection?.mode === 'multiple') {
        draftValues[f.parameter] = '';
      } else if (f.selection?.mode === 'single' && f.selection.array) {
        const arr = Array.isArray(f.value) ? f.value as string[] : [];
        draftValues[f.parameter] = arr.length ? arr[0] : '';
      } else {
        draftValues[f.parameter] = valueString(f.value);
      }
      draftActive[f.parameter] = f.active;
      idByParam.set(f.parameter, f.id);
      if (f.sourceId != null) {
        curatedFields[f.parameter] = {
          options: f.options ?? [], status: f.status, stale: f.stale, waitingFor: f.waitingFor,
          selection: f.selection, value: f.value, active: f.active,
        };
      }
    }
    const onCommit = (name: string): void => {
      const id = idByParam.get(name);
      if (id) session.applyFilter(id, draftValues[name] ?? '', !!draftActive[name]);
    };
    // #189: the array-committing seam (multiselect Apply, single-on-array
    // pick/clear) — bypasses the scalar draft bag entirely, straight to
    // `session.applyFilter` with the already-built array value/active.
    const onApplyCurated = (name: string, next: string[], active: boolean): void => {
      const id = idByParam.get(name);
      if (id) session.applyFilter(id, next, active);
    };
    const getField = (name: string, mode: ValidationMode) => session.getFilterField(name, mode, draftValues, draftActive);
    // #335: assemble the time-range option — one entry per resolved group,
    // reading each bound's committed value/active straight off `sview.filters`
    // (the from/to filters stay in the view regardless of presentation, so a
    // time-range commit still flips `barSig` below and rebuilds this bar). The
    // pair's two individual fields are suppressed by parameter name inside
    // `buildFilterBar`. `waveNowMs` is this wave's shared `now` snapshot.
    const filterById = new Map(sview.filters.map((f) => [f.id, f] as const));
    const timeRange = session.timeRangeGroups.flatMap((group) => {
      const fromF = filterById.get(group.fromFilterId);
      const toF = filterById.get(group.toFilterId);
      return [{
        group,
        // timeRangeGroups is resolved from this same filter collection.
        fromValue: valueString(fromF!.value),
        toValue: valueString(toF!.value),
        active: fromF!.active && toF!.active,
        waveNowMs: sview.waveWallNowMs,
        recents: (): readonly TimeRangeRecent[] => timeRangeRecents.get(group.key) ?? [],
      }];
    });
    // #335: a time-range Apply (or immediate recents pick) commits BOTH bounds
    // atomically through the session's batch API (one execution wave over the
    // union of the pair's resolved targets), pushes the OUTGOING committed pair
    // onto this group's recents, and announces the new range.
    const onApplyTimeRange = (group: DashboardTimeRangeGroup, from: string, to: string): void => {
      void applyTimeRange(group, from, to);
    };
    const bar = buildFilterBar(
      filterBarApp, session.controls, onCommit, getField,
      { curatedFields, document: doc, onApplyCurated, timeRange, onApplyTimeRange,
        onKeyboardOwnerChange: keyboardOwnerChannel(app) },
    );
    timeFilterHost.replaceChildren(bar.timeEl);
    ordinaryFilterHost.replaceChildren(bar.ordinaryEl);
    currentFilterBar = bar;
    filterBarUpdateStatus = bar.updateStatus;
    // Maintainer merge-gate fix (#189): announce the refresh ONLY when the
    // open param's options actually changed content between the OUTGOING
    // bar's own last build (`lastBuiltOptionsRev`) and this incoming view —
    // a rebuild triggered by a plain value/active commit (this field's own
    // Apply, already closed by the time it gets here, or any OTHER field's
    // commit) never bumps `optionsRev`, so it never announces, even on the
    // rare chance this param's popover was still genuinely open when some
    // unrelated commit forced the whole bar to rebuild.
    if (openPopoverKey) {
      const prevRev = lastBuiltOptionsRev.get(openPopoverKey);
      const nextRev = sview.filters.find((f) => f.parameter === openPopoverKey)?.optionsRev;
      if (nextRev !== undefined && nextRev !== prevRev) {
        filterRefreshLiveEl.textContent = 'Filter options were refreshed';
      }
    }
    lastBuiltOptionsRev = new Map(sview.filters.map((f) => [f.parameter, f.optionsRev]));
    // #189-F2b, GENERALIZED (#335): land focus on the NEW bar's corresponding
    // trigger for whichever control key the OUTGOING bar had open, or (absent
    // that) had focus on its trigger (an Apply that already closed its own
    // popover before reaching here) — a no-op if that key is no longer a
    // popover-bearing control on the fresh bar (e.g. its topology changed) or
    // there was no such control at all (a plain field mid-typing elsewhere is
    // never disturbed), which simply leaves focus wherever it already was
    // rather than throwing. Works uniformly for multiselect (`param`) and
    // time-range (`group:…`) keys.
    if (restoreFocusKey) bar.focusFieldTrigger(restoreFocusKey);
  }

  const filterDiagnosticsHost = h('div', { class: 'dash-filter-diagnostics' });
  const grid = h('div', { class: 'dash-grid' });
  const empty = h('div', { class: 'dash-empty', style: { display: currentDoc.tiles.length ? 'none' : '' } },
    'No tiles yet — star a query in the Queries panel to add it to the dashboard.');
  const searchEmpty = h('div', { class: 'dash-empty dash-search-empty', style: { display: 'none' } },
    h('h2', null, 'No tiles match'),
    h('p', null, 'Try a different title or description.'),
    h('button', {
      class: 'dash-btn',
      onclick: () => {
        if (tileSearchTimer != null) clearTimeout(tileSearchTimer);
        tileSearchTimer = null;
        tileSearchInput.value = '';
        session.setTileSearch('');
        tileSearchInput.focus();
      },
    }, 'Clear search'));

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

  // #344 review fix: build the ApplyCommandContext against a SPECIFIC document
  // snapshot (never the route-level `queries` closure directly) — used both
  // for the optimistic apply against `currentDoc` and, at commit/rebase time,
  // against committed truth (`latest`/`committedWorkspace`), whose `queries`
  // may have moved on since this route was opened (another producer's saved-
  // query CRUD op committed through the same shared queue).
  function ctxFor(baseDoc: DashboardDocumentV1, queriesForResolver: SavedQueryV2[]) {
    return {
      // The Dashboard UI never dispatches add-query commands; retain the
      // required context seam without an unreachable local lambda.
      resolver: createQueryResolver(queriesForResolver), genTileId: String.prototype.toString.bind('tile'),
      plugin: resolveLayoutPluginSync(baseDoc.layout),
    };
  }

  /** Apply a route command plus its workspace-level membership semantics. A
   * raw remove-tile is first command-validated, then replaced by the shared
   * transform that also cleans targets and synchronizes spec.favorite. */
  function applyRouteCommand(
    baseDoc: DashboardDocumentV1, command: DashboardCommand, queriesForResolver: SavedQueryV2[],
  ) {
    const applied = applyCommand(baseDoc, command, ctxFor(baseDoc, queriesForResolver));
    if (!applied.ok) return applied;
    if (command.type !== 'remove-tile') return { ...applied, queries: queriesForResolver };
    const membership = removeTileMembership(baseDoc, queriesForResolver, command.tileId);
    return membership
      ? { ...applied, dashboard: membership.dashboard, queries: membership.queries }
      : { ...applied, queries: queriesForResolver };
  }

  // ── Structural commands (reorder via drag, preset) ────────────────────────
  // move-tile / update-placement / change-layout are the phase-3 authoring
  // commands; the dashboard UI drives only move-tile (drag) and change-layout
  // (preset) — span/height (update-placement) is tuned in the Spec editor.
  //
  // #344 review fix: the queue holds COMMAND DESCRIPTORS (`pendingCommands`),
  // never pre-built document snapshots. The pre-#344 scheme built each
  // command's optimistic doc by applying it on top of the PRIOR command's own
  // optimistic doc, so a fast command B's whole document structurally
  // contained a slower command A's edit — if A's commit then FAILED after B
  // had already published, A's rollback was skipped (B was the newer "latest
  // optimistic" marker) and B's later successful commit persisted A's
  // rejected edit anyway. Re-applying each descriptor against COMMITTED truth
  // at DEQUEUE time (`app.mutateWorkspace`), and rebasing every still-pending
  // descriptor onto committed truth after every resolution, means a rejected
  // or invalidated command can never survive inside a later commit — its
  // absence, not its optimistic doc, is what every later command builds from.
  function runCommand(command: DashboardCommand): void {
    // #291: validate/seed against whichever engine is ACTIVE before the
    // command applies (`resolveLayoutPluginSync` — grid: span 1..12, flow:
    // span 1..3). A `change-layout` engine switch is normalized through the
    // RESULTING document's own engine, so a post-switch grid document is
    // pruned by the grid plugin (its own `items`), not flow's (which would
    // only ever see its own fallback surface).
    const applied = applyRouteCommand(currentDoc, command, queries);
    // A UI-driven command (drag move-tile, preset change-layout, grid
    // resize/delete) is always valid; a rejected candidate is simply ignored
    // (no draft change).
    if (!applied.ok) return;
    const normalized = resolveLayoutPluginSync(applied.dashboard.layout).normalize(applied.dashboard);
    // Apply OPTIMISTICALLY first so a drag/resize preview stays instant — the
    // commit below either confirms this (this command's own commit round-
    // trips its own edit) or a rebase corrects it once resolutions land.
    currentDoc = normalized;
    layoutMenu.sync();
    syncSessionDocument(withImplicitFilters(normalized));

    pendingCommands.push(command);

    // `app.mutateWorkspace` reads the latest COMMITTED aggregate at DEQUEUE
    // time and re-applies THIS descriptor to it — never to the (possibly
    // already-stale) optimistic doc it was dispatched against — so the
    // persisted revision is always base+1 over whatever the truth actually is
    // by the time this op runs, regardless of who else committed meanwhile.
    // #344 review 2: what the transform SAW as committed truth at dequeue
    // time. A failure/abort must refresh the route cache from this before
    // rebasing — the null-abort case exists precisely BECAUSE committed truth
    // moved past the route cache, so rebasing from the stale cache would
    // re-publish a document containing what the concurrent commit removed.
    // Stays `undefined` when the queued op rejected before the transform ran.
    let observed: StoredWorkspaceV2 | null | undefined;
    void app.mutateWorkspace((latest) => {
      observed = latest;
      if (!latest || !latest.dashboard) return null;
      const base = latest.dashboard;
      const reapplied = applyRouteCommand(base, command, latest.queries);
      if (!reapplied.ok) return null;
      const committedDoc = resolveLayoutPluginSync(reapplied.dashboard.layout).normalize(reapplied.dashboard);
      return {
        candidate: {
          storageVersion: 2, id: latest.id, key: latest.key, name: latest.name, queries: reapplied.queries,
          dashboard: { ...committedDoc, revision: base.revision + 1 },
        },
      };
    }).then((outcome) => {
      if (!app.refreshCurrentSurfaceAfterStale(surfaceGeneration, outcome.ok)) return;
      // #343: adapt the shared outcome back to this route's descriptor-based
      // settle contract — `null` on a transform abort (this command no longer
      // applies), the commit result otherwise. Projection already happened in
      // `mutateWorkspace` on success.
      const result: WorkspaceCommitResult | null = outcome.ok
        ? { ok: true, workspace: outcome.workspace, dashboardRevision: outcome.dashboardRevision }
        : outcome.aborted ? null : { ok: false, diagnostics: outcome.diagnostics };
      settleCommand(result, observed);
    }, () => {
      if (!app.refreshCurrentSurfaceAfterStale(surfaceGeneration)) return;
      // The queued op itself REJECTED (blocked/quota/private-mode storage —
      // the active-ID load/store threw, distinct from an `ok:false` commit).
      // Without this handler the rejection is unhandled and, worse, this
      // command would stay in `pendingCommands` forever, corrupting every
      // future rebase.
      settleCommand({ ok: false, diagnostics: [] }, observed);
    });
  }

  // #350/#343 step 6: rebuild the WHOLE route from committed truth — a fresh
  // `renderDashboard` reads the newly projected `app.currentWorkspace` (both
  // Dashboard document and query collection), repairing what `session.syncDocument`
  // cannot: a membership-RESTORING rebase (a tile record the session already
  // dropped can't be reinstated), and an external query-only change (a tile's
  // query SQL/Spec moved while the Dashboard document stayed byte-identical).
  // Two callers funnel through here — settleCommand's membership-restore path and
  // the external-workspace-change hook — so they can never double-render:
  //  • deferred while commands are still pending (a resolution handler from THIS
  //    render must not survive into the rebuilt one); the last settleCommand
  //    re-checks `needsRebuild` and calls back once the queue drains;
  //  • `rebuilding` makes it idempotent for THIS render — duplicate cross-tab
  //    pokes (or a settle after the hook already triggered) coalesce into the one
  //    rebuild the fresh render supersedes.
  // It only ever RE-READS committed truth; it never commits.
  let rebuilding = false;
  function rebuildRouteFromCommitted(): void {
    if (rebuilding || pendingCommands.length > 0) return;
    if (!app.isSurfaceGenerationCurrent(surfaceGeneration)) return;
    rebuilding = true;
    session.destroy();
    // Route the replacement through the app-owned wrapper so this renderer is
    // invalidated before the replacement captures its own generation.
    app.renderDashboard();
  }

  // #343 step 6: react to an external workspace change the app-level cross-tab
  // refresh has ALREADY projected onto `app.state` and `app.currentWorkspace`.
  // Both edit and live view rebuild from the same committed workspace.
  // `needsRebuild` coalesces with the settleCommand path; `rebuildRouteFrom
  // Committed` defers while commands are pending and never commits. `info` is
  // unused: the hook fires only on a real change and the full rebuild re-reads
  // everything, so a query-only change rebuilds even a byte-identical document.
  app.onWorkspaceExternallyChanged = () => {
    if (app.sqlRoute.surface !== 'dashboard') return;
    needsRebuild = true;
    rebuildRouteFromCommitted();
  };

  // One command's resolution — success, `ok:false`, transform null-abort, or
  // storage rejection (mapped to `ok:false` by the caller) — always: drop the
  // head descriptor, refresh committed truth, toast failure, rebase.
  function settleCommand(result: WorkspaceCommitResult | null, observed: StoredWorkspaceV2 | null | undefined): void {
    // FIFO queue — every resolution arrives in dispatch order, so this
    // command is always the head.
    pendingCommands.shift();
    if (result && result.ok) {
      committedWorkspace = result.workspace;
      committedRevision = result.workspace.dashboard ? result.workspace.dashboard.revision : committedRevision + 1;
      // #343 §2: `app.mutateWorkspace` already projected committed truth onto
      // `app.state` (exactly once). The route only refreshes its own caches.
    } else {
      // #344 review 2: refresh the route cache from the DEQUEUE-TIME truth
      // the transform observed — the truth that rejected/invalidated this
      // command — so the rebase below never re-publishes a stale document
      // (a tile a concurrent producer removed staying visible). `undefined`
      // means the op rejected before the active-ID load resolved: nothing
      // fresher was observed, keep the current cache.
      if (observed !== undefined) {
        committedWorkspace = observed;
        committedRevision = observed?.dashboard ? observed.dashboard.revision : committedRevision;
        if (observed) app.applyCommittedWorkspace(observed);
      }
      if (result) {
        // Rejected against committed truth at commit time (a real validation
        // failure — schema/aggregate-level) or a storage rejection.
        flashToast('✕ ' + (result.diagnostics[0]?.message ?? 'Could not save dashboard'), { document: doc });
      } else {
        // `null`: the transform aborted — this command no longer applies to
        // committed truth (e.g. a concurrent commit already removed the tile
        // it targeted). Quieter toast: this isn't a save failure, it's a
        // stale edit being dropped.
        flashToast('Change no longer applies — undone', { document: doc });
      }
    }
    // Rebase UNCONDITIONALLY: recompute the rendered document by replaying
    // every STILL-pending descriptor on top of (the now possibly-advanced)
    // committed truth. Even a pure success with nothing pending must
    // re-publish — the committed doc can differ from the published
    // optimistic one whenever a foreign producer's commit landed between
    // dispatch and dequeue (this command was re-applied to THAT base, e.g.
    // a saved-query delete whose resolver pruned a tile), and after every
    // resolution the rendered doc must equal committed truth exactly.
    let rebased: DashboardDocumentV1 | null = committedWorkspace ? committedWorkspace.dashboard : null;
    if (!rebased) return;
    const rebaseQueries = committedWorkspace!.queries;
    for (const pending of pendingCommands) {
      const r = applyRouteCommand(rebased, pending, rebaseQueries);
      // A replay that no longer applies is simply skipped here — its own
      // queued `mutateWorkspace` call will independently null-abort and
      // toast when its turn comes.
      if (r.ok) rebased = resolveLayoutPluginSync(r.dashboard.layout).normalize(r.dashboard);
    }
    currentDoc = rebased;
    // #350: `syncDocument` can apply reorders and REMOVALS (it drops the
    // runtime record of any tile absent from the synced doc) but can never
    // REINSTATE a tile whose record it already dropped — e.g. a remove-tile
    // whose commit failed and rolled back, or dequeue-time truth restoring a
    // tile this route optimistically dropped. A membership-RESTORING rebase
    // therefore rebuilds the whole route from the current workspace projection
    // — deferred until the queue is idle
    // so no in-flight resolution handler from THIS render survives into the
    // rebuilt one.
    if (rebased.tiles.some((t) => !trackedSessionTileIds.has(t.id))) needsRebuild = true;
    if (needsRebuild) { rebuildRouteFromCommitted(); return; }
    syncSessionDocument(withImplicitFilters(rebased));
    layoutMenu.sync();
  }

  // ── Tile DOM ──────────────────────────────────────────────────────────────
  const tileEls = new Map<string, TileEl>();
  // Flow KPI tiles do not render their cached `.dash-tile` card. Their
  // `.dash-kpi-member` host is the structural/movement surface instead.
  const flowKpiHosts = new Map<string, HTMLElement>();
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
  // Retained from the window keyboard stream because WebKit may omit a held
  // Control key from a subsequent pointer event.
  let reorderModifierHeld = false;
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
      if (start.button !== 0) return;
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
      const savedGridColumn = card.style.gridColumn;
      const savedHeight = card.style.height;
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
      const cleanup = (commit: boolean): void => {
        card.classList.remove('dash-gg-resizing');
        win.removeEventListener('pointermove', move as EventListener);
        win.removeEventListener('pointerup', up as EventListener);
        win.removeEventListener('pointercancel', cancel as EventListener);
        win.removeEventListener('blur', cancel);
        doc.removeEventListener('keydown', onKey, true);
        handle.removeEventListener('lostpointercapture', cancel as EventListener);
        if (installedGestureCancel === cancel) installedGestureCancel = null;
        if (typeof handle.hasPointerCapture === 'function' && handle.hasPointerCapture(start.pointerId)) {
          handle.releasePointerCapture(start.pointerId);
        }
        if (!commit) {
          card.style.gridColumn = savedGridColumn;
          card.style.height = savedHeight;
          return;
        }
        runCommand({ type: 'update-placement', tileId, placement: { span: full ? persistedSpan : curSpan, height: curHeight } });
      };
      const up = (): void => cleanup(true);
      const cancel = (): void => cleanup(false);
      const onKey = (ev: KeyboardEvent): void => { if (ev.key === 'Escape') cancel(); };
      win.addEventListener('pointermove', move as EventListener);
      win.addEventListener('pointerup', up as EventListener);
      win.addEventListener('pointercancel', cancel as EventListener);
      win.addEventListener('blur', cancel);
      doc.addEventListener('keydown', onKey, true);
      handle.addEventListener('lostpointercapture', cancel as EventListener);
      if (typeof handle.setPointerCapture === 'function') handle.setPointerCapture(start.pointerId);
      installedGestureCancel = cancel;
    });
    handle.addEventListener('keydown', (event: Event) => {
      if (activeEngine !== 'grafana-grid') return;
      const key = event as KeyboardEvent;
      const placement = gridPlacementByTile.get(tileId)!;
      const full = gridRenderMode === 'full';
      let span = placement.persistedSpan;
      let height = placement.heightUnits;
      if (key.key === 'ArrowUp') height = Math.max(GRID_HEIGHT_UNIT_MIN, height - 1);
      else if (key.key === 'ArrowDown') height = Math.min(GRID_HEIGHT_UNIT_MAX, height + 1);
      // Keyboard span edits tune the authored placement, not the responsive
      // effective span. A saved 12-column tile rendered in a 4-column narrow
      // grid therefore moves 12→11 on ArrowLeft and stays 12 on ArrowRight;
      // it never jumps to the visible clamp (3/4) and loses desktop intent.
      else if (!full && key.key === 'ArrowLeft') span = Math.max(1, placement.persistedSpan - 1);
      else if (!full && key.key === 'ArrowRight') span = Math.min(GRAFANA_GRID_MAX_COLUMNS, placement.persistedSpan + 1);
      else return;
      key.preventDefault();
      if (span === placement.persistedSpan && height === placement.heightUnits) return;
      runCommand({ type: 'update-placement', tileId, placement: { span, height } });
    });
  }

  // #332 tile reorder — pointer drag, NOT native HTML5 drag (a plain body drag
  // must select text, never reorder). A drag STARTS from the top-left grip with
  // no modifier, OR from anywhere on the body with ⌘/Ctrl held (the schema-graph
  // modifier model). On the grafana-grid engine the dragged tile lifts and
  // follows the pointer while the siblings reflow live to open a gap; the move
  // commits to whichever slot the dragged tile overlaps most
  // (`resolveOverlapInsertIndex`, core/tile-reorder.ts, max-overlap — no area
  // threshold, so a short tile like a KPI still resolves correctly against a
  // taller neighbor); it snaps back when it still overlaps its own origin
  // slot most, or overlaps nothing. The flow engine keeps the simpler
  // point-hit-test path (its KPI tiles render detached in a band, with no
  // coherent grid slot to reflow into).
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
    const onPointerDown: EventListener = (event) => {
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
      // WebKit can leave `ctrlKey` false on pointer events synthesized while
      // Control is held. Its modifier-state query remains authoritative, so
      // use both representations for the cross-browser body-drag shortcut.
      const hasReorderModifier = (input: PointerEvent): boolean => reorderModifierHeld || input.metaKey || input.ctrlKey
        || input.getModifierState?.('Meta') || input.getModifierState?.('Control');
      const modified = hasReorderModifier(pe);
      if (!fromGrip && !modified) return;
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
      let savedDisplay = '';                           // both paths: the card's inline display, restored after the float
      let lastReflowId: string | null = null;          // grid path: last resolved insertion slot
      const touched = new Set<HTMLElement>();           // grid path: siblings carrying a FLIP transform
      const win = doc.defaultView || window;
      const renderedSurface = (id: string): HTMLElement => {
        const flowHost = activeEngine === 'flow' ? flowKpiHosts.get(id) : undefined;
        return flowHost ?? tileEls.get(id)!.card;
      };
      const surfaceRect = (surface: HTMLElement): DOMRect => {
        const own = surface.getBoundingClientRect();
        if (!surface.classList.contains('dash-kpi-member')) return own;
        const childRects = [...surface.children].map((child) => child.getBoundingClientRect());
        const left = Math.min(...childRects.map((r) => r.left));
        const top = Math.min(...childRects.map((r) => r.top));
        const right = Math.max(...childRects.map((r) => r.right));
        const bottom = Math.max(...childRects.map((r) => r.bottom));
        return new DOMRect(left, top, right - left, bottom - top);
      };
      const hitRects = (tileId2: string, surface: HTMLElement): TileRect[] => {
        const nodes = surface.classList.contains('dash-kpi-member') ? [...surface.children] : [surface];
        return nodes.map((node) => {
          const r = node.getBoundingClientRect();
          return { tileId: tileId2, left: r.left, top: r.top, right: r.right, bottom: r.bottom };
        });
      };
      // #338: edge auto-scroll while a move is active. `wireTileDrag` runs
      // BEFORE `.dash-page` is inserted (app.root!.replaceChildren happens
      // once, later, at the end of renderDashboard), so the scroll host and
      // its sticky topbar are resolved here, at pointerdown runtime, when the
      // page IS mounted. A `scrollEl === null` (e.g. a test fixture with no
      // `.dash-page`) degrades cleanly: `autoScroll` stays null and
      // `currentRects()` always returns the unadjusted home rects.
      const scrollEl = app.root!.querySelector('.dash-page') as HTMLElement | null;
      const topbar = scrollEl?.querySelector('.dash-topbar') as HTMLElement | null;
      let scrollTop0 = 0;
      let autoScroll: DragAutoScrollController | null = null;
      let lastPointerX = startX;
      let lastPointerY = startY;
      // Candidate HOME rects, shifted by however far the page has scrolled
      // since `beginMove` captured them — the floating dragged card is
      // position:fixed (viewport-anchored), so it never needs this
      // adjustment; only the STATIONARY siblings' captured rects go stale as
      // the page scrolls under them.
      const currentRects = (): TileRect[] => {
        const dy = (scrollEl ? scrollEl.scrollTop : 0) - scrollTop0;
        if (dy === 0) return rects;
        return rects.map((r) => ({ ...r, top: r.top - dy, bottom: r.bottom - dy }));
      };
      const gridTiles = (): HTMLElement[] =>
        [...grid.children].filter((c): c is HTMLElement => c instanceof HTMLElement && c.classList.contains('dash-gg-tile'));
      const setDrop = (id: string | null): void => {
        if (id === dropId) return;
        if (dropId) renderedSurface(dropId).classList.remove('dash-drop-target');
        dropId = id;
        if (id && id !== tileId) renderedSurface(id).classList.add('dash-drop-target');
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
      // #338: the single resolution body shared by a real pointermove AND an
      // auto-scroll animation frame (which has no new pointer event of its
      // own — the pointer is stationary while tiles scroll underneath it).
      // `px`/`py` are the LATEST known pointer coords; `currentRects()` folds
      // in however far the page has scrolled since `beginMove`.
      const resolveFromPointer = (px: number, py: number): void => {
        if (liveReflow) {
          const floating = card.getBoundingClientRect();
          reflowTo(resolveOverlapInsertIndex(floating, currentRects()));
        } else {
          setDrop(hitTestTile(currentRects(), px, py));
        }
      };
      const beginMove = (): void => {
        moving = true;
        grid.classList.add('dash-reordering'); // user-select:none + grabbing, only now
        scrollTop0 = scrollEl ? scrollEl.scrollTop : 0;
        // Capture every grid-placed tile's home rect once, in canonical order —
        // overlap/hit-testing always measures against these home positions, so a
        // live sibling shift never feeds back into the decision.
        rects = currentDoc.tiles.flatMap((t) => {
          const c = renderedSurface(t.id);
          // Every rendered movement surface is attached to this grid: ordinary
          // cards directly, KPI members through their band/stream ancestors.
          return hitRects(t.id, c);
        });
        // Capture the card's HOME rect and inline styles BEFORE inserting the
        // grid placeholder: `grid.insertBefore(placeholder, card)` displaces
        // the card into the NEXT grid cell, so reading getBoundingClientRect()
        // after it would capture the shifted (wrong-column) left and the
        // floated tile would sit a column off from the cursor horizontally
        // (real-browser only — happy-dom ignores grid placement).
        const r0 = surfaceRect(card);
        savedHeight = card.style.height;
        savedDisplay = card.style.display;
        if (liveReflow) {
          // Insert a same-size placeholder in the card's slot so the grid can
          // FLIP-reflow into the gap; the flow path has no slot grid, so no
          // placeholder there — the remaining flow tiles simply reflow to
          // close the gap while the dragged tile floats above them.
          placeholder = h('div', { class: 'dash-tile-placeholder' });
          placeholder.style.gridColumn = card.style.gridColumn;
          placeholder.style.height = card.style.height;
          grid.insertBefore(placeholder, card);
        }
        // Lift the card to a fixed follower — BOTH engines float, so the
        // dragged tile stays under the cursor even while #338 auto-scroll
        // moves the page underneath it (a flow tile left position:static
        // would otherwise scroll off-screen with the rest of the content).
        // The card stays a DOM child of its container (position:fixed pulls
        // it out of flow in place — simpler cleanup than reparenting).
        // Defensive: a KPI-band card's WRAPPER is display:contents, not the
        // card itself, but if some path ever leaves the card's own computed
        // display as 'contents' it can't be position:fixed meaningfully —
        // force a real box for the duration of the drag.
        if (win.getComputedStyle(card).display === 'contents') {
          // A flow KPI query may own several KPI cards. Preserve the stream's
          // row/wrap geometry inside the temporary physical wrapper.
          card.style.display = card.classList.contains('dash-kpi-member') ? 'flex' : 'block';
        }
        card.classList.add('dash-floating');
        card.style.position = 'fixed';
        card.style.left = r0.left + 'px';
        card.style.top = r0.top + 'px';
        card.style.width = r0.width + 'px';
        card.style.height = r0.height + 'px';
        card.style.zIndex = '40';
        // #338: while the drag is active, the pointer nearing the top/bottom
        // edge of the visible `.dash-page` viewport auto-scrolls it — both
        // engines (a grid live-reflow AND a flow reorder can both need more
        // room than the viewport shows). No scroll host (e.g. a fixture with
        // no `.dash-page`) → no auto-scroll, everything else is unaffected.
        if (scrollEl) {
          const el = scrollEl;
          const target: DragAutoScrollTarget = {
            visibleTop: () => el.getBoundingClientRect().top + (topbar ? topbar.offsetHeight : 0),
            visibleBottom: () => el.getBoundingClientRect().bottom,
            scrollBy: (dy: number): number => {
              const before = el.scrollTop;
              const max = Math.max(0, el.scrollHeight - el.clientHeight);
              el.scrollTop = Math.max(0, Math.min(max, before + dy));
              return el.scrollTop - before;
            },
            canScrollUp: () => el.scrollTop > 0,
            canScrollDown: () => el.scrollTop < Math.max(0, el.scrollHeight - el.clientHeight),
          };
          const scheduler: FrameScheduler = {
            request: (cb) => win.requestAnimationFrame(cb),
            cancel: (h2) => win.cancelAnimationFrame(h2),
          };
          autoScroll = createDragAutoScroll(target, scheduler, {
            reducedMotion: prefersReducedMotion(),
            onScrollFrame: () => resolveFromPointer(lastPointerX, lastPointerY),
          });
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
        card.style.display = savedDisplay; // restore the card's own display (only forced when computed 'contents')
        touched.forEach((c) => { c.style.transition = ''; c.style.transform = ''; });
        touched.clear();
        lastGridSig = ''; // defense-in-depth: force a full grid rebuild on the next publish
      };
      const onMove = (ev: PointerEvent): void => {
        if (!moving) {
          if (!movedPastThreshold(ev.clientX - startX, ev.clientY - startY)) return;
          beginMove();
        }
        lastPointerX = ev.clientX;
        lastPointerY = ev.clientY;
        card.style.transform = 'translate(' + (ev.clientX - startX) + 'px,' + (ev.clientY - startY) + 'px)'; // both engines float and follow the cursor
        resolveFromPointer(ev.clientX, ev.clientY);
        // Latest pointer Y (viewport coords — unaffected by scroll, the card
        // is position:fixed) drives the edge-proximity check every move, on
        // top of whatever a running auto-scroll frame already applied.
        autoScroll?.setPointerY(ev.clientY);
      };
      const cleanup = (): void => {
        win.removeEventListener('pointermove', onMove as EventListener);
        win.removeEventListener('pointerup', onUp as EventListener);
        win.removeEventListener('pointercancel', onCancel as EventListener);
        win.removeEventListener('blur', onCancel);
        doc.removeEventListener('keydown', onKey, true);
        card.removeEventListener('lostpointercapture', onCancel as EventListener);
        autoScroll?.stop();
        autoScroll = null;
        if (moving) { restoreDrag(); setDrop(null); }
        grid.classList.remove('dash-reordering');
        gestureActive = false;
        if (installedGestureCancel === cleanup) installedGestureCancel = null;
        if (typeof card.hasPointerCapture === 'function' && card.hasPointerCapture(pe.pointerId)) {
          card.releasePointerCapture(pe.pointerId);
        }
      };
      const onUp = (ev: PointerEvent): void => {
        const wasMoving = moving;
        const targetId = !wasMoving ? null
          : liveReflow ? resolveOverlapInsertIndex(card.getBoundingClientRect(), currentRects())
            : hitTestTile(currentRects(), ev.clientX, ev.clientY);
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
      card.addEventListener('lostpointercapture', onCancel as EventListener);
      if (typeof card.setPointerCapture === 'function') card.setPointerCapture(pe.pointerId);
      installedGestureCancel = cleanup;
    };
    card.addEventListener('pointerdown', onPointerDown);
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
    const grip = !readOnly && !ts.isKpi
      ? h('span', { class: 'dash-gg-grip', title: 'Drag to move (or Command/Ctrl-drag the tile)', 'aria-hidden': 'true' })
      : null;
    const delBtn = !readOnly ? h('button', {
      class: 'dash-gg-del', title: 'Remove tile', 'aria-label': 'Remove ' + ts.title + ' from the dashboard',
      onclick: () => { if (activeEngine === 'grafana-grid') runCommand({ type: 'remove-tile', tileId: ts.tileId }); },
    }, Icon.trash()) : null;
    const heading = h('div', { class: 'dash-tile-heading' },
      h('span', { class: 'dash-tile-name', title: ts.title }, ts.title),
      ts.description ? h('span', {
        class: 'dash-tile-desc', title: ts.description,
      }, ts.description) : null);
    const head = h('div', { class: 'dash-tile-head' }, grip, heading, delBtn);
    const body = h('div', { class: 'dash-tile-body' });
    const foot = h('div', { class: 'dash-tile-foot' });
    const resizeHandle = !readOnly
      ? h('button', { class: 'dash-gg-resize', type: 'button', title: 'Resize', 'aria-label': 'Resize' })
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
    // branching). A read-only dashboard never wires it (#288/#407).
    const card = h('div', {
      class: 'dash-tile' + (readOnly ? ' is-view' : ''),
      title: !readOnly && ts.isKpi ? 'Command/Ctrl-drag to move' : undefined,
    }, head, body, foot, resizeHandle);
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
    const timeRangeGroup = groupByTileId.get(ts.tileId);
    const xIndex = (resolved.cfg as { x?: unknown }).x;
    const xType = Number.isInteger(xIndex) ? columns[Number(xIndex)]?.type ?? 'DateTime' : 'DateTime';
    const chartPlugins = timeRangeGroup ? [chartInteraction.pluginFor({
      group: timeRangeGroup,
      tileId: ts.tileId,
      crosshairHost: tileEl.body,
      xType,
      onSelect: (fromMs, toMs) => {
        const formatted = formatChartTimeRange({
          fromMs, toMs, fromType: timeRangeGroup.fromType, toType: timeRangeGroup.toType,
        });
        /* v8 ignore next 3 -- controller invokes onSelect only with finite
           scale values; retained as a defensive contract boundary. */
        if (!formatted.ok) {
          filterRefreshLiveEl.textContent = `Time range was not changed: ${formatted.error}`;
          return;
        }
        void applyTimeRange(timeRangeGroup, formatted.from, formatted.to);
      },
    })] : undefined;
    const out = renderResolvedPanel(app as unknown as App, resolved, result, {
      surface: 'dashboard', state: tileEl.panelState, rerender: () => paintForce(ts, tileEl),
      readonly: true, cap: DASH_TABLE_DISPLAY_CAP,
      // #332: table cells and logs fields open the SAME shared Workbench
      // cell-detail drawer, in THIS dashboard's document. openCellDetail is
      // already document-agnostic (results.ts) — no Workbench-tab coupling.
      onCell: (name, type, value) => openCellDetail(app as unknown as ResultsApp, name, type, value, doc),
      chartPlugins,
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
      flowKpiHosts.clear();
      grid.replaceChildren(...layout.rows.map((row) => {
        if (row.kind === 'kpi-band') {
          const stream = h('div', { class: 'dash-kpi-stream', ...KPI_STREAM_ARIA });
          for (const member of row.tiles) {
            const ts = byId.get(member.tileId)!;
            const host = h('div', {
              class: 'dash-kpi-member', 'data-tile': member.tileId, role: 'group',
              'aria-label': ts.title,
              title: !readOnly ? 'Command/Ctrl-drag to move' : undefined,
            });
            flowKpiHosts.set(member.tileId, host);
            if (!readOnly) wireTileDrag(member.tileId, host);
            stream.appendChild(host);
          }
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
      // The grid model and tileEls are reconciled from the same session view.
      const tileEl = tileEls.get(t.tileId)!;
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
  // #360: a SEPARATE signature from `barSig` — status/stale/waitingFor never
  // participate in `barSig` (see the effect below), so a status-only change
  // is detected here instead and applied to the EXISTING bar via
  // `filterBarUpdateStatus` (no rebuild).
  let statusSig = '';
  // #335: the wave `now` the time-range controls' closed labels were last
  // resolved against — a NON-rebuild publish whose wave `now` advanced
  // re-resolves those labels in place (a live relative range, no timers),
  // without disturbing anything else. Tracked separately from `barSig` so a
  // tile-progress tick (same wave `now`) never churns the labels. Seeded from
  // the session's initial state (`null` before the first wave).
  let lastLabelWaveNowMs: number | null = session.state.value.waveWallNowMs;
  const statusSigOf = (filters: readonly ViewerFilterState[]): string =>
    JSON.stringify(filters.map((f) => [f.parameter, f.status, !!f.stale, f.waitingFor ?? null]));
  const statesByParam = (filters: readonly ViewerFilterState[]): Record<string, {
    status: ViewerFilterState['status']; stale?: boolean; waitingFor?: string[];
  }> => Object.fromEntries(filters.map((f) => [f.parameter, { status: f.status, stale: f.stale, waitingFor: f.waitingFor }]));
  // #303: the committed-filter bag for a published view, built exactly the way
  // the persist step below and the seed just under it both need it.
  // #189: a committed multiselect/single-on-array value is a REAL string
  // array — persisted as one (`DashboardFilterEntry.value: string | string[]`),
  // never coerced through `valueString`'s `String()` fallback (which would
  // turn `['a','b']` into the literal text `"a,b"`, indistinguishable from an
  // actual scalar `"a,b"` value on the next load). Non-string elements are
  // dropped defensively, the same posture `dashboard-filter-store.ts`'s own
  // `coerceValue` takes when READING this same persisted shape back.
  const persistBagOf = (filters: readonly ViewerFilterState[]): DashboardFilterBag => {
    const bag: DashboardFilterBag = {};
    for (const f of filters) {
      bag[f.id] = {
        value: Array.isArray(f.value)
          ? (f.value as unknown[]).filter((v): v is string => typeof v === 'string')
          : valueString(f.value),
        active: f.active,
      };
    }
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
  const disposeDashboardEffect = effect(() => {
    const sview = session.state.value;
    const mobileNow = state.isMobile.value; // tracked so a breakpoint flip re-runs the effect
    // A breakpoint flip after the last publish needs a fresh flow model —
    // republish through the viewer (recomputes it with the new mobile flag).
    // grafana-grid has no `mobile` concept of its own (its responsive
    // behavior is the `containerWidth`-driven effective-columns clamp below).
    if (sview.layout.engine === 'flow' && mobileNow !== lastMobile && mobileNow !== sview.layout.mobile) {
      lastMobile = mobileNow;
      syncSessionDocument(currentDoc);
      return;
    }
    lastMobile = mobileNow;
    // Rebuild the shared filter bar only on a STRUCTURAL change (activation,
    // committed value, curated option CONTENT arriving/changing via
    // `optionsRev`, or a filter gaining/losing its source topology) — not on
    // a bare status flip and not on tile progress ticks — so in-progress
    // typing is never disturbed mid-wave. `status`/`stale`/`waitingFor` are
    // deliberately EXCLUDED from this signature (#360): `rebuildFilterBar`
    // gates curation on topology (`sourceId != null`), not status, so a pure
    // status change only needs its OWN existing curated DOM updated in place
    // — see `statusSig` below — never a rebuild. This also preserves #359's
    // own invariant that an unchanged republish never disturbs in-progress
    // typing.
    const sig = JSON.stringify(sview.filters.map((f) =>
      [f.id, f.active, sigValue(f.value), f.optionsRev, f.sourceId != null]));
    const newStatusSig = statusSigOf(sview.filters);
    let rebuilt = false;
    if (sig !== barSig) {
      barSig = sig;
      rebuildFilterBar(sview);
      rebuilt = true;
      // A fresh rebuild already applies the CURRENT status to every curated
      // field (buildFilterBar applies it at build time) — refresh the stored
      // status signature too, so this same publish doesn't ALSO fire a
      // redundant `updateStatus` immediately after.
      statusSig = newStatusSig;
    } else if (newStatusSig !== statusSig) {
      statusSig = newStatusSig;
      filterBarUpdateStatus?.(statesByParam(sview.filters));
    }
    // #335: per-wave time-range label refresh. A rebuild (`sig` change) already
    // rebuilt every time-range control against this wave's `now` (assembled
    // into its `waveNowMs`); only a NON-rebuild publish whose wave `now`
    // advanced needs the closed labels re-resolved in place — a committed
    // relative range (`-1d` → `now`) moves per wave without any bar rebuild.
    if (!rebuilt && sview.waveWallNowMs != null && sview.waveWallNowMs !== lastLabelWaveNowMs) {
      currentFilterBar?.refreshTimeRangeLabels(sview.waveWallNowMs);
    }
    lastLabelWaveNowMs = sview.waveWallNowMs;
    // #303: persist committed filter value/active into the isolated per-dashboard
    // store — isolated from the Workbench's asb:varValues/asb:filterActive keys.
    const filterBag = persistBagOf(sview.filters);
    const persistSig = filterBagSignature(filterBag);
    if (persistSig !== lastFilterPersistSig) {
      lastFilterPersistSig = persistSig;
      app.saveJSON(KEYS.dashFilters, writeDashboardFilterBag(loadJSON(KEYS.dashFilters, {}), currentDoc.id, filterBag));
    }
    tileCountLabel.textContent = sview.tileSearch.trim()
      ? `${sview.visibleTileCount} of ${sview.totalTileCount} tiles`
      : `${sview.totalTileCount} ${sview.totalTileCount === 1 ? 'tile' : 'tiles'}`;
    const noMatch = !!sview.tileSearch.trim() && sview.visibleTileCount === 0 && sview.totalTileCount > 0;
    empty.style.display = sview.totalTileCount === 0 ? '' : 'none';
    searchEmpty.style.display = noMatch ? '' : 'none';
    clearFiltersBtn.disabled = !sview.resettableFilterIds.some((id) => ordinaryFilterIds.includes(id));
    // Genuine dashboard-config diagnostics only (a tile whose presentation
    // could not resolve, etc.). Per-filter "required/invalid" badges were
    // dropped as noise (owner decision) — an unfilled required filter simply
    // leaves its target tiles in their normal unfilled state.
    filterDiagnosticsHost.replaceChildren(
      ...sview.diagnostics.map((d) => h('div', { class: 'dash-config-diagnostic is-error' }, d.message)),
      ...sview.timeRangeDiagnostics.map((d) => h('div', { class: 'dash-config-diagnostic is-error' }, d.message)),
      // #359: the shared-source filter wave's own merge diagnostics
      // (info/warning/error), separate from the presentation diagnostics
      // above — each severity maps directly to its `is-*` class.
      ...sview.filterDiagnostics.map((d) => h('div', { class: 'dash-config-diagnostic is-' + d.severity }, d.message)),
    );
    if (sview.layout.engine !== lastEngineRendered) { lastLayoutSig = ''; lastGridSig = ''; lastEngineRendered = sview.layout.engine; }
    activeEngine = sview.layout.engine;
    // Keep the local render-mode mirror current from the published session
    // layout. View mode can now project flow styles too, so leaving a Full
    // grid must also clear the grid host's vertical-only resize affordance.
    const nextGridRenderMode = sview.layout.engine === 'grafana-grid' ? sview.layout.renderMode : 'tiles';
    if (nextGridRenderMode !== gridRenderMode) {
      gridRenderMode = nextGridRenderMode;
      layoutMenu.sync();
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

  const primaryToolbar = h('div', { class: 'dash-toolbar dash-toolbar-primary' },
    layoutWrap,
    tileCount,
    tileSearch,
    timeFilterHost,
    h('span', { class: 'dash-toolbar-spacer' }),
    updated,
    refreshControl,
    dashboardModeSwitch);
  const hasOrdinaryFilters = ordinaryFilterIds.length > 0;
  const filterToolbar = h('div', {
    class: 'dash-toolbar dash-toolbar-filters',
    style: hasOrdinaryFilters ? undefined : { display: 'none' },
  }, ordinaryFilterHost, clearFiltersBtn);

  // `!`: the dashboard renders only into a mounted page.
  app.root!.replaceChildren(h('div', { class: 'dash-page' },
    h('div', { class: 'dash-topbar' }, header, primaryToolbar, filterToolbar, filterRefreshLiveEl),
    filterDiagnosticsHost, empty, searchEmpty, grid));

  // Own every route-scoped resource in one teardown. An in-place Dashboard
  // rebuild must not leave Chart.js observers, signal effects, popovers, or
  // viewer requests attached to the replaced page.
  installedDashboardCleanup = () => {
    if (app.surfaceCommands === commandPort) app.surfaceCommands = null;
    currentFilterBar?.dispose();
    currentFilterBar = null;
    if (tileSearchTimer != null) clearTimeout(tileSearchTimer);
    tileSearchTimer = null;
    disposeDashboardEffect();
    for (const tileEl of tileEls.values()) destroyChart(tileEl);
    chartInteraction.destroy();
    if (installedDashboardChartInteraction === chartInteraction) installedDashboardChartInteraction = null;
    session.destroy();
  };

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
      if (containerWidthPx !== prevWidth) syncSessionDocument(currentDoc);
    };
    gridWin.addEventListener('resize', onGridResize);
    installedGridResizeListener = { win: gridWin, handler: onGridResize };
  }

  // #332: while ⌘/Ctrl is held the grid shows the grab affordance over its
  // tiles (CSS `.dash-grid.modkey`), the same cursor cue the schema graph uses.
  // Edit mode only — a read-only view is never reorderable, so it never leaks
  // the affordance. Torn down at the next renderDashboard (see top of fn).
  if (gridWin && !readOnly) {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.metaKey || e.ctrlKey || e.key === 'Meta' || e.key === 'Control') {
        reorderModifierHeld = true;
        grid.classList.add('modkey');
      }
    };
    const onKeyUp = (e: KeyboardEvent): void => {
      reorderModifierHeld = e.metaKey || e.ctrlKey;
      if (!reorderModifierHeld) grid.classList.remove('modkey');
    };
    const onBlur = (): void => { reorderModifierHeld = false; grid.classList.remove('modkey'); };
    gridWin.addEventListener('keydown', onKeyDown);
    gridWin.addEventListener('keyup', onKeyUp);
    gridWin.addEventListener('blur', onBlur);
    installedModifierListeners = { win: gridWin, onKeyDown, onKeyUp, onBlur };
  }

  await session.start();
}
