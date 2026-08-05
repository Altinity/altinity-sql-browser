// The live Dashboard surface (#149 / #240 / #280 / #286 / #407). Phase 4 of #280
// FLIPS Dashboard membership reads off `spec.favorite` and onto
// `dashboard.tiles[]`: this module resolves the current `StoredWorkspaceV5`
// from `app.currentWorkspace`, constructs a `DashboardViewerSession` over that
// document + the workspace
// queries, and renders the DOM from the session's `state` signal. The heavy
// runtime — presentation resolution, the variable/tile execution waves (with
// #235 parallelism), bounded concurrency, per-tile cancellation, and the
// normative `flow@1` layout math — all live in the session and its pure
// dependencies; this module is the render/interaction shell over them.
//
// The variable bar is the SHARED `buildVariableBar` (the same rich field family the
// Workbench var-strip and detached view use — relative-time presets, recents,
// enum + curated comboboxes), driven over the viewer's variable model: a draft
// value/active bag the bar mutates, `session.getVariableField` for live #170
// validation, and `session.applyVariable` on commit (which owns activation).
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
import { isQuerylessPanel, resolvePanel } from '../core/panel-cfg.js';
import type { Column } from '../core/panel-cfg.js';
import { DASH_TILE_ROW_CAP, DASH_TABLE_DISPLAY_CAP } from '../core/dashboard.js';
import {
  formatBytes as formatBytesUntyped, formatRows as formatRowsUntyped,
} from '../core/format.js';
import { analyzeParameterizedSources, fieldControls } from '../core/param-pipeline.js';
import type { ValidationMode } from '../core/param-pipeline.js';
import { queryFavorite } from '../core/saved-query.js';
import { selectOutputColumns } from '../core/select-columns.js';
import { renderKpiCards, KPI_STREAM_ARIA } from './kpi-panel.js';
import { buildVariableBar, VARIABLE_DEBOUNCE_MS } from './variable-bar.js';
import type { VariableFieldSpec, VariableOptionsUpdate } from './variable-bar.js';
import type { VariableBarApp, VariableBarHandle } from './variable-bar.js';
import { pushRecentRange } from '../core/time-range.js';
import { formatChartTimeLabel, formatChartTimeRange } from '../core/time-range.js';
import type { DashboardTimeRangeGroup, TimeRangeRecent } from '../core/time-range.js';
import { chartColors } from '../core/chart-data.js';
import { createDashboardChartInteractionController } from './dashboard-chart-interaction.js';
import type { DashboardChartInteractionController } from './dashboard-chart-interaction.js';
import { createTileGestureController } from './dashboard-tile-gestures.js';
import type { TileGestureController } from './dashboard-tile-gestures.js';
import { createDashboardViewerSession } from '../dashboard/application/dashboard-viewer-session.js';
import type {
  DashboardViewerSession, DashboardViewState, DashboardStyle, ViewerTileState,
  ViewerVariableOption,
} from '../dashboard/application/dashboard-viewer-session.js';
import { defaultLayoutRegistry, resolveLayoutPluginSync } from '../dashboard/layouts/layout-registry.js';
import type { FlowLayoutModel } from '../dashboard/layouts/flow-layout.js';
import {
  DEFAULT_GRID_HEIGHT_UNITS, GRAFANA_GRID_MAX_COLUMNS,
  contentBoxWidth, gridHeightUnitsToPx, gridPlacementAt, stylePlacementAt,
} from '../dashboard/layouts/grafana-grid-layout.js';
import type { GrafanaGridLayoutModel, GridRenderMode } from '../dashboard/layouts/grafana-grid-layout.js';
import { applyCommand } from '../dashboard/application/dashboard-commands.js';
import type { DashboardCommand } from '../dashboard/application/dashboard-commands.js';
import {
  seedRepaintMemo, valueString,
  planRepublishFlow, planBarRebuild, planOptionsPush, planLabelRefresh, planPersist, planStructuralRebuild,
} from '../dashboard/application/dashboard-repaint-plan.js';
import type { RepaintMemo } from '../dashboard/application/dashboard-repaint-plan.js';
import { canWidenPanel, nextPanelPlacement, widenLabel } from '../dashboard/application/panel-widen.js';
import { panelTileActions } from '../dashboard/application/panel-tile-actions.js';
import type { PanelTileAction, PanelTileActionKind } from '../dashboard/application/panel-tile-actions.js';
import { panelRemovalRefusal } from '../dashboard/application/dashboard-removal.js';
import { commitPanelRemoval, dashboardDeleteMessage } from '../application/dashboard-delete.js';
import { openConfirmMenu } from './confirm-menu.js';
import {
  commitPanelDuplication, panelDuplicateMessage,
} from '../application/dashboard-panel-duplicate.js';
import { DEFAULT_DASHBOARD_TITLE } from '../dashboard/application/empty-dashboard.js';
import { createDashboard, dashboardCreateMessage } from '../application/dashboard-create.js';
import {
  findDashboard, replaceDashboard, resolveCompatibilityDashboard,
} from '../workspace/workspace-dashboards.js';
import { openNameDialog } from './dialog-shell.js';
import type {
  DashboardFocusTarget, DashboardSurfaceMode,
} from '../application/main-surface.js';
import { withPendingFocus } from '../application/main-surface.js';
import type { DashboardFocusOutcome } from './shortcuts.js';
import { createQueryResolver } from '../dashboard/application/dashboard-query-resolver.js';
import {
  readDashboardVariableBag, writeDashboardVariableBag,
} from '../dashboard/model/dashboard-variable-store.js';
import type { DashboardVariableBag } from '../dashboard/model/dashboard-variable-store.js';
import { loadJSON } from '../core/storage.js';
import { KEYS } from '../state.js';
import type {
  DashboardDocumentV2, DashboardFilterDefinitionV1, DashboardLayoutDocumentV1, FlowPresetV1,
  Panel, SavedQueryV2, StoredWorkspaceV5,
} from '../generated/json-schema.types.js';
import type { App, AppDom, ActionsRegistry } from './app.types.js';
import type { SqlRoute } from '../core/sql-route.js';
import type { AppState } from '../state.js';
import type { ConnectionSession } from '../application/connection-session.js';
import type { QueryExecutionService } from '../application/query-execution-service.js';
import type { AuthenticatedExecutionScope } from '../application/authenticated-execution-scope.js';
import type { WorkbenchParameterSession } from '../application/workbench-parameter-session.js';
import type { WorkspaceCommitResult, WorkspaceRepository } from '../workspace/workspace-repository.js';
import type { AppPreferences } from '../application/app-preferences.js';
import { keyboardOwnerChannel } from './keyboard-owner.js';

// icons.js is unconverted — the icons this module appends, pinned to the
// one honest shape (same wrapper the pre-#286 module used).
const Icon: {
  star(filled?: boolean): SVGElement;
  spinner(): SVGElement;
  refresh(): SVGElement;
  sun(): SVGElement;
  moon(): SVGElement;
  trash(): SVGElement;
  chevDown(): SVGElement;
  copy(): SVGElement;
  arrowsWide(): SVGElement;
  expand(): SVGElement;
  more(): SVGElement;
  download(): SVGElement;
  upload(): SVGElement;
  search(): SVGElement;
} = IconUntyped;

const formatRows: (n: number | null | undefined) => string = formatRowsUntyped;
const formatBytes: (n: number | null | undefined) => string = formatBytesUntyped;

/**
 * Everything the application shell hands this surface for ONE render (#425).
 * Nothing here is re-derived from the route or from collection position: the
 * shell owns the hosts and the selection, this module owns the rendering.
 */
export interface DashboardRenderTarget {
  /** The main-surface host to render into — NOT `app.root`. The Query surface
   *  stays mounted in its own sibling host. */
  host: Element;
  /** The selected Dashboard's stable id, or `null` for the legacy entry point
   *  against a workspace with no Dashboard yet (→ "Create dashboard"). */
  dashboardId: string | null;
  mode: DashboardSurfaceMode;
  /** Where to land navigation focus once this Dashboard's DOM exists. */
  focus: DashboardFocusTarget | null;
  /** #471: the scroll offset this render owes the page — a Dashboard returned to
   *  through history restores where the user left it, not the top. `null` for every
   *  ordinary render (open, mode switch, repaint), which starts at the top. */
  scrollTop: number | null;
  /** Install this surface's header into the shell's shared header slot. */
  setHeader(header: Element): void;
}

/** The narrow `app` surface this render module reads (not the full App —
 *  matches the convention results.ts/variable-bar.ts established). */
export interface DashboardApp {
  document: Document;
  state: AppState;
  cssVar(name: string): string;
  dom: AppDom;
  root: Element | null;
  toggleTheme(): void;
  conn: Pick<ConnectionSession, 'basePath' | 'host' | 'email' | 'ensureFreshToken' | 'chCtx'>;
  exec: Pick<QueryExecutionService, 'executeRead'>;
  /** Server work belongs to the disposable authenticated epoch; the Dashboard
   * stays mounted when this becomes unavailable. */
  executionScope?(): AuthenticatedExecutionScope | null;
  requireAuthenticatedExecution?(): AuthenticatedExecutionScope | null;
  now(): number;
  wallNow(): number;
  params: Pick<WorkbenchParameterSession, 'recordBoundParams' | 'clearVarRecent'>;
  workspace: Pick<WorkspaceRepository, 'commit'>;
  currentWorkspace: StoredWorkspaceV5 | null;
  sqlRoute: SqlRoute;
  /** #425 — the selected-Dashboard session state this render projects, and the
   *  navigation API its own View/Edit control transitions through. (#471's per-tile
   *  expand action does not go through it: opening a document is not a surface
   *  transition the Dashboard performs — see `openPanelQuery` below.) */
  mainSurface: App['mainSurface'];
  openDashboard: App['openDashboard'];
  showDashboardSurface: App['showDashboardSurface'];
  /** #471: a tile's own expand action, by the tile's `queryId` — the
   *  Dashboard-owned copy's stable id, which is what makes the opened tab, and
   *  every later Save from it, target this Dashboard's document. This surface does
   *  not need `showQuerySurface`: leaving a Dashboard used to be a generic
   *  toolbar act and is now always a document-opening one, which switches the
   *  surface itself.
   *
   *  #535 widened it from `openSavedQuery` to `openPanelQuery`: the action now also
   *  RUNS the query and reveals this panel's Dashboards-tree row, and neither of
   *  those is derivable from a bare `queryId` — the tree row is addressed by
   *  Dashboard id plus tile id. */
  openPanelQuery: App['openPanelQuery'];
  navigateSqlRoute(route: SqlRoute, method: 'push' | 'replace'): Promise<void>;
  surfaceCommands: App['surfaceCommands'];
  keyboardOwner: App['keyboardOwner'];
  acquireKeyboardOwner: App['acquireKeyboardOwner'];
  resetShortcutChord: App['resetShortcutChord'];
  renderDashboard(): void;
  captureSurfaceGeneration(): number;
  isSurfaceGenerationCurrent(generation: number): boolean;
  refreshCurrentSurfaceAfterStale(generation: number, committed?: boolean): boolean;
  applyCommittedWorkspace(workspace: StoredWorkspaceV5): void;
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
  // #452 removed this surface's File-menu operations: the one shared File menu
  // owns them, and this surface supplies only context.
  actions: Pick<ActionsRegistry, 'openShortcuts' | 'openUserMenu'>;
  genId(): string;
  /** #303: persists the isolated per-dashboard variable store (`KEYS.dashFilters`). */
  saveJSON(key: string, value: unknown): void;
  /** #332: satisfies `ResultsApp`'s `prefs` member for the `as ResultsApp`
   *  cast `openCellDetail` is called through below. #586: the docked
   *  cell-detail path this surface always takes no longer calls
   *  `attachDrawerResize` (resize is shell-owned now, app-shell.ts), so
   *  `prefs.save` isn't actually exercised via that call anymore — kept here
   *  so a future narrower caller still gets a compile-time signal, not a
   *  runtime crash, rather than removing the field outright. */
  prefs: Pick<AppPreferences, 'save'>;
}

/** #291 review F4: `renderDashboard` can run more than once against the SAME
 *  window — `app.reloadDashboardRoute()` (app.ts) re-invokes it in place after
 *  an import-commit while already on `/dashboard` (file-menu.ts's Import
 *  flow). Module-level so a later call can find and remove the PRIOR call's
 *  resize listener before installing its own; without this, repeated renders
 *  stack listeners that all still close over their own render's now-stale
 *  `session`/`currentDoc`/`containerWidthPx`. */
let installedGridResizeListener: { win: Window; handler: () => void } | null = null;
// #589 wave 2: the ⌘/Ctrl modifier-cue listeners and the in-flight-gesture
// cancel hook (an in-flight move/resize owns window/document listeners and
// pointer capture; a new route render must cancel it before replacing the
// page so no stale gesture can commit into the newly-rendered Dashboard) both
// used to be separate module-level teardown slots here. Both now live inside
// `createTileGestureController` (dashboard-tile-gestures.ts), which owns that
// state internally — this is the one handle `disposeDashboardSurface` needs to
// tear the whole thing down, mirroring the grid-resize listener's own
// removed-at-the-START-of-the-next-`renderDashboard`-call teardown model
// (this module never observes page teardown).
let installedTileGestures: TileGestureController | null = null;
let installedDashboardChartInteraction: DashboardChartInteractionController | null = null;
let installedDashboardCleanup: (() => void) | null = null;
// #425: the shell-owned host this surface last rendered into. The host itself
// OUTLIVES the surface (it is a permanent sibling of the query host), so
// teardown has to empty it explicitly — otherwise a disposed Dashboard's DOM
// would linger behind the Query surface, still answering `.dash-page` queries
// with a page whose viewer session is already destroyed.
let installedDashboardHost: Element | null = null;
// #425: the pending clear for a navigation highlight. Module-level for the same
// reason the listeners above are: a later render (or surface teardown) must be
// able to retire the PRIOR render's highlight — including its document listeners
// — rather than leave it to fire against a detached node.
let installedNavHighlightClear: (() => void) | null = null;
/** How long a navigation highlight lasts absent any user interaction. */
const NAV_HIGHLIGHT_MS = 2000;

/** Tear down every resource owned by the currently mounted Dashboard surface. */
export function disposeDashboardSurface(): void {
  if (installedGridResizeListener) {
    installedGridResizeListener.win.removeEventListener('resize', installedGridResizeListener.handler);
    installedGridResizeListener = null;
  }
  installedTileGestures?.dispose();
  installedTileGestures = null;
  installedDashboardCleanup?.();
  installedDashboardCleanup = null;
  installedNavHighlightClear?.();
  installedNavHighlightClear = null;
  installedDashboardHost?.replaceChildren();
  installedDashboardHost = null;
}

/**
 * The mounted Dashboard's live scroll offset, or `null` when none is mounted (#471).
 *
 * `.dash-page` is the scroll host — the grid scrolls under a sticky topbar, so the
 * document itself never scrolls and `window.scrollY` would always read 0. Read at the
 * moment the surface is left, because opening a tile's query disposes this DOM: the
 * offset has to be recorded onto the history entry before it is gone.
 */
export function dashboardScrollTop(): number | null {
  const page = installedDashboardHost?.querySelector('.dash-page');
  return page ? page.scrollTop : null;
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
      menuClass: 'dash-style-menu',
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
  /** Stable title/subtitle nodes whose presentation changes with the selected
   *  Dashboard style without rebuilding the cached tile. */
  headingName: HTMLElement;
  headingDescription: HTMLElement | null;
  body: HTMLElement;
  foot: HTMLElement;
  panelState: { key: string;[k: string]: unknown } | null;
  destroy: (() => void) | null;
  paintedRows: unknown[][] | null;
  /** #321: the grid resize handle, when built (grafana-grid + edit mode) — its
   *  accessible label toggles between 'Resize' (tiles) and 'Resize tile
   *  height' (full view, vertical-only) as the render mode changes. */
  resizeHandle: HTMLElement | null;
  /** #535: the widen button, when built (edit mode) — hidden for the
   *  single-column styles and relabelled from the tile's current width on every
   *  publish (`applyWidenMode`). */
  widenBtn: HTMLElement | null;
  /** The `⋯` trigger, when built (edit mode). Held so the flow KPI band variant
   *  can MOVE this exact node into each repainted card rather than build a new
   *  one — see `attachFlowKpiActions`. */
  menuBtn: HTMLButtonElement | null;
  /** A flow KPI band member's own overlay controls, built lazily on its first
   *  band attach and moved into every later repaint of its card. `null` for a
   *  tile that never renders inside a band, which is every non-KPI tile and
   *  every KPI tile while the grid engine is active. */
  kpiActions: { openBtn: HTMLButtonElement | null; menuBtn: HTMLButtonElement | null } | null;
}

/** #407 — an explicit workspace route that no longer resolves. */
function renderDashboardNotFound(app: DashboardApp, target: DashboardRenderTarget): void {
  // #425: install this surface's own header too. Without it the PREVIOUS surface's
  // header stays above a "Workspace not found" work area, reading as a
  // Dashboard-scoped error rather than the page-level one it is.
  target.setHeader(buildAppHeader(app as App, {
    // #452: this surface EXISTS because no workspace aggregate resolved, so it
    // says so directly rather than leaving the menu to infer it from a route
    // status that can still read 'ready' here.
    fileMenu: {
      surface: 'dashboard', mode: target.mode, dashboardId: null, workspaceMissing: true,
    },
    workspaceTitleEditable: false,
  }));
  installedDashboardHost = target.host;
  target.host.replaceChildren(h('div', { class: 'dash-page dash-notfound' },
    h('div', { class: 'dash-empty' },
      h('h2', { class: 'dash-notfound-title' }, 'Workspace not found'),
      h('p', null, 'This workspace no longer exists on this browser.'))));
}

/**
 * Append one empty Dashboard — named through the same prompt File ▸ New
 * dashboard… uses — and open it (#429 phase 3/#481).
 *
 * Both the mint/append transform and the report are `createDashboard` /
 * `dashboardCreateMessage` (`application/dashboard-create.ts`), shared with
 * the File menu since #495 review 3: this path used to call
 * `app.mutateWorkspace` directly and say NOTHING when the commit was
 * rejected, so a storage or validation failure looked exactly like a dialog
 * that had done its job. What stays here is the placeholder's own reveal
 * policy — select the new Dashboard in whichever mode this surface is
 * already showing.
 */
async function doCreateDashboardFromPlaceholder(
  app: DashboardApp, name: string, target: DashboardRenderTarget, surfaceGeneration: number,
): Promise<void> {
  const outcome = await createDashboard({
    mutateWorkspace: app.mutateWorkspace,
    genId: app.genId,
    // This surface only renders once a workspace is projected, so the
    // fallback is the projection itself; `null` (no workspace at all) aborts
    // exactly as the pre-#495 transform's own `!latest` guard did.
    baseline: () => app.currentWorkspace,
  }, name);
  if (!app.refreshCurrentSurfaceAfterStale(surfaceGeneration, outcome.ok)) return;
  const message = dashboardCreateMessage(outcome);
  if (message !== null) flashToast(message, { document: app.document });
  // #425: SELECT what we just created rather than re-rendering an unselected
  // surface. Without this the session would keep reporting Query mode while a
  // Dashboard is on screen — harmless today (every consumer falls back to the
  // compatibility entry) but a lie that #426's tree would render as "nothing
  // selected".
  if (outcome.ok) app.openDashboard({ dashboardId: outcome.data!, mode: target.mode });
}

function renderMissingDashboard(
  app: DashboardApp, target: DashboardRenderTarget, readOnly: boolean, surfaceGeneration: number,
): void {
  let createBtn: HTMLButtonElement;
  const body = readOnly
    ? h('div', { class: 'dash-empty' },
      h('h2', null, 'This workspace has no dashboard'))
    : h('div', { class: 'dash-empty' },
      h('h2', null, 'Create a dashboard for this workspace'),
      createBtn = h('button', {
        class: 'dash-btn dash-create',
        onclick: () => {
          openNameDialog(app, {
            title: 'New dashboard',
            label: 'Dashboard name',
            initial: DEFAULT_DASHBOARD_TITLE,
            confirmLabel: 'Create dashboard',
            returnFocusTo: createBtn,
            onConfirm: (name) => { void doCreateDashboardFromPlaceholder(app, name, target, surfaceGeneration); },
          });
        },
      }, 'Create dashboard') as HTMLButtonElement);
  target.setHeader(buildAppHeader(app as App, {
    // #452: no document resolved, so there is no exact Dashboard to act on.
    // #463 makes that harmless — the File menu's Dashboard commands are
    // workspace operations now: New and Import append, and Export resolves an
    // exact target from the workspace's own ids or asks through a chooser.
    fileMenu: { surface: 'dashboard', mode: target.mode, dashboardId: null },
    workspaceTitleEditable: !readOnly,
  }));
  installedDashboardHost = target.host;
  target.host.replaceChildren(h('div', { class: 'dash-page' },
    h('div', { class: 'dash-topbar' },
      h('div', { class: 'dash-toolbar dash-toolbar-primary' },
        h('span', { class: 'dash-toolbar-spacer' }),
        buildDashboardModeSwitch(app, target.mode))),
    body));
}

/** #425/#437: View/Edit — the other Dashboard-owned control the compact primary
 *  toolbar carries. Switching retains the same Dashboard id (the main-surface API
 *  keeps it — writing a route here would re-resolve the collection's first
 *  entry). */
function buildDashboardModeSwitch(app: DashboardApp, mode: DashboardSurfaceMode): HTMLElement {
  // #425: switching View/Edit retains the SELECTED Dashboard — the main-surface
  // API keeps the id and re-opens the same document in the other mode, instead of
  // writing a route that would re-resolve the collection's first entry. The active
  // mode comes from the render target, not the route, so the control reflects what
  // is actually on screen.
  const button = (label: 'View' | 'Edit', value: DashboardSurfaceMode): HTMLButtonElement =>
    routeButton(label, mode === value, () => { app.showDashboardSurface(value); });
  return h('div', {
    class: 'editor-mode-switch dashboard-mode-switch',
    role: 'group', 'aria-label': 'Dashboard mode',
  }, button('View', 'view'), button('Edit', 'edit'));
}

/** Render the selected Dashboard into the main-surface host the application
 *  shell owns (#425). Everything this surface needs to know about WHICH
 *  Dashboard, in which mode, with which navigation focus, arrives here — it is
 *  never re-derived from the route or from collection position. */
export async function renderDashboard(
  app: DashboardApp, target: DashboardRenderTarget,
): Promise<void> {
  const { document: doc, state } = app;
  const surfaceGeneration = app.captureSurfaceGeneration();
  doc.documentElement.setAttribute('data-theme', state.theme);
  doc.documentElement.setAttribute('data-density', state.density);
  // #425: NO `app.dom = {}` reset here. The Query surface stays mounted behind
  // this one and its DOM refs live in that same shared bag — resetting it would
  // strand every workbench reference (and the sidebar's) while the elements are
  // still in the document. The shell owns the one reset, at its own mount.

  // #291 review F4: remove any grid resize listener a PRIOR renderDashboard
  // call installed on this window before this call installs its own (see
  // `installedGridResizeListener`'s own doc comment above).
  disposeDashboardSurface();
  app.surfaceCommands = null;

  const workspace = app.currentWorkspace;
  const readOnly = target.mode === 'view';
  if (!workspace) { renderDashboardNotFound(app, target); return; }
  app.onWorkspaceExternallyChanged = () => {
    if (app.sqlRoute.surface === 'dashboard') app.renderDashboard();
  };
  // #424/#425: the ONE place this surface resolves the document it renders. The
  // selected id arrives on `target`; only a legacy entry point that has not been
  // converted yet (an empty collection, so nothing to select) falls back to the
  // compatibility Dashboard. The id is pinned for the whole render so every
  // commit below is addressed BY ID rather than by array position — a concurrent
  // write that reorders or replaces the collection is then detected instead of
  // silently retargeting.
  const selected = target.dashboardId === null
    ? resolveCompatibilityDashboard(workspace).dashboard
    : findDashboard(workspace, target.dashboardId);
  if (!selected) {
    renderMissingDashboard(app, target, readOnly, surfaceGeneration);
    return;
  }
  const selectedDashboardId = selected.id;

  const queries: SavedQueryV2[] = workspace.queries;
  const queryById = new Map<string, SavedQueryV2>();
  for (const query of queries) if (!queryById.has(query.id)) queryById.set(query.id, query);

  // The live document — layout/order edits replace it; membership is read from
  // `dashboard.tiles[]` (NOT `savedQueries.filter(queryFavorite)`).
  let currentDoc: DashboardDocumentV2 = selected;
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
  let committedWorkspace: StoredWorkspaceV5 | null = workspace;
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

  // No pre-processing of the document's variables for the viewer.
  // #447: the document needs no pre-processing before the session sees it. This
  // used to synthesize a filter definition per undeclared `{name:Type}` panel
  // parameter, and to attach an option source by matching a filter-role query's
  // OUTPUT COLUMN name — both are gone. The session infers its variables from the
  // panel SQL itself, and option SQL is authored per variable on the document.
  const viewerDoc: DashboardDocumentV2 = currentDoc;

  // #303: seed each variable's initial value/active from the isolated
  // per-dashboard store (never the Workbench's asb:varValues/asb:filterActive
  // keys) — restores committed variable state across a reload. `initialBag` is
  // ALSO the baseline the persist effect below compares against, so the very
  // first publish (which merely echoes this seed) does not immediately write
  // defaults back over it.
  const initialBag: DashboardVariableBag = readDashboardVariableBag(loadJSON(KEYS.dashFilters, {}), currentDoc.id);

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
    executionScope: () => app.requireAuthenticatedExecution?.() ?? app.executionScope?.() ?? null,
    mintQueryId: () => app.genId(),
    registry: defaultLayoutRegistry,
    now: () => app.now(),
    wallNow: () => app.wallNow(),
    isMobile: () => state.isMobile.value,
    containerWidth: () => containerWidthPx,
    onAuthFailed: () => app.conn.chCtx.onSignedOut(),
    recordBoundParams: (bp) => app.params.recordBoundParams(bp),
    initialVariables: initialBag,
  });
  let trackedSessionTileIds = new Set(viewerDoc.tiles.map((tile) => tile.id));
  const syncSessionDocument = (next: DashboardDocumentV2): void => {
    session.syncDocument(next);
    trackedSessionTileIds = new Set(next.tiles.map((tile) => tile.id));
  };

  // ── Header chrome ───────────────────────────────────────────────────────
  const tileCountLabel = h('span');
  const tileCount = h('span', { class: 'dash-chip dash-tile-count' }, tileCountLabel);
  // #437: one compact freshness control replaces the separate "Updated HH:MM"
  // label + "Refresh" text button — `updated` shows the bare time, the icon-only
  // button carries the same information in its tooltip/aria-label (kept current
  // by the render effect below).
  const updated = h('span', { class: 'dash-updated' });
  const refreshBtn = h('button', {
    class: 'editor-mode-btn dash-refresh', type: 'button',
    title: 'Refresh dashboard', 'aria-label': 'Refresh dashboard',
  }, Icon.refresh()) as HTMLButtonElement;
  const refreshControl = h('div', { class: 'editor-mode-switch dash-refresh-wrap' }, refreshBtn);
  const freshness = h('div', { class: 'dash-freshness' }, updated, refreshControl);
  refreshBtn.onclick = () => session.refresh();
  // ── Preset switcher (change-layout command) ───────────────────────────────
  // #321: the local mirror of the viewer session's TRANSIENT grid render-mode
  // override ('tiles'|'full') — read by `getActive`/`onPick` below (built
  // synchronously, before the first publish) and kept current by the render
  // effect (Part D) whenever `sview.layout.renderMode` changes.
  let gridRenderMode: GridRenderMode = 'tiles';
  let currentDashboardStyle: DashboardStyle = currentDoc.layout.preset as DashboardStyle;
  // 2026-07-18 owner override: moved off the variable toolbar and into the top
  // header row (right after File) so the toolbar's whole width is available
  // for variables; its File-style menu keeps the active layout visible without
  // a second header label.
  // Current documents author Grid, Full, or Report independently. View mode
  // uses the same menu as a non-mutating preview; edit mode persists a base
  // style. The 2/3-column entries are session previews in either mode.
  const EDITABLE_LAYOUT_OPTIONS: LayoutOption[] = [
    ['grid', 'Grid', 'A responsive tile grid using authored spans and heights', 'G'],
    ['full', 'Full', 'One full-width tile per row with independent saved heights', 'F'],
    ['report', 'Report', 'One centered, taller tile per row', 'R'],
    ['columns-2', '2 columns', 'Temporary two-column preview at a fixed height', '2'],
    ['columns-3', '3 columns', 'Temporary three-column preview at a fixed height', '3'],
  ];
  let layoutMenu: { el: HTMLButtonElement; sync: () => void };
  const selectLayout = (value: DashboardStyle): void => {
    if (readOnly || value === 'columns-2' || value === 'columns-3') {
      session.setDashboardStyle(value);
      layoutMenu.sync();
      return;
    }
    if (currentDoc.layout.type === 'grafana-grid'
      && currentDoc.layout.version === 2
      && currentDoc.layout.preset === value) {
      session.setDashboardStyle(value);
      layoutMenu.sync();
      return;
    }
    runCommand({
      type: 'change-layout',
      layout: {
        type: 'grafana-grid', version: 2, preset: value,
      } as DashboardLayoutDocumentV1,
    });
    layoutMenu.sync();
  };
  layoutMenu = buildLayoutMenu(
    doc, keyboardOwnerChannel(app),
    EDITABLE_LAYOUT_OPTIONS,
    () => session.state.value.style,
    selectLayout,
    'Dashboard style',
  );
  // The global shortcut reaches this route-local port only while its renderer
  // generation is current. It is cleared by both Dashboard cleanup and every
  // application surface transition.
  //
  // #426: installed HERE, synchronously, rather than after the `await
  // session.start()` below — the tree makes member navigation a normal operation,
  // and a click that lands while the opening wave is still running must still
  // reach a live port. Tile cards already exist at this point (the viewer session
  // seeds its state with every tile at construction), so tile focus works
  // immediately; only a curated filter has to wait, which `waveSettled` below
  // reports as `pending`.
  const commandPort = {
    surface: 'dashboard' as const,
    generation: surfaceGeneration,
    refresh: () => session.refresh(),
    setDashboardStyle: selectLayout,
    focusMember: (member: DashboardFocusTarget): DashboardFocusOutcome => {
      // A VARIABLE's control is REPLACED by the opening wave's first publish
      // (see the deferred delivery at the end of this render), so a node focused
      // now would be detached moments later. Report `pending` and let the caller
      // take the normal render transition, which delivers variable focus at the
      // deterministic point the node is stable.
      if (member.kind === 'variable' && !waveSettled) return 'pending';
      return deliverFocus(member, { respectUserInteraction: false });
    },
  };
  app.surfaceCommands = commandPort;
  // Flipped once the opening wave resolves — see `focusMember` above.
  let waveSettled = false;
  const layoutWrap = h('div', { class: 'dash-layout-wrap' }, layoutMenu.el);

  // #452: Dashboard renders the same File menu as every other surface — View
  // disables the mutating rows rather than dropping them. #425: the header goes
  // into the SHELL's slot (the shell owns the frame now), not into this
  // surface's own DOM.
  target.setHeader(buildAppHeader(app as App, {
    // #452: the EXACT document this render resolved — `selectedDashboardId`,
    // never `target.dashboardId`. The render target's requested id can be `null`
    // while a real Dashboard is on screen (the route and `mainSurface` legitimately
    // disagree, and the compatibility selector then resolves one), and a visible
    // Dashboard must never report "No dashboard" to the File menu.
    fileMenu: { surface: 'dashboard', mode: target.mode, dashboardId: selectedDashboardId },
    workspaceTitleEditable: !readOnly,
  }));

  let tileSearchTimer: ReturnType<typeof setTimeout> | null = null;
  const commitTileSearch = (input: HTMLInputElement): void => {
    if (tileSearchTimer != null) clearTimeout(tileSearchTimer);
    tileSearchTimer = null;
    session.setTileSearch(input.value);
  };
  const tileSearchInput = h('input', {
    class: 'dash-tile-search', type: 'search', placeholder: 'Search',
    'aria-label': 'Search dashboard tiles',
    oninput: (event: Event) => {
      const input = event.target as HTMLInputElement;
      if (tileSearchTimer != null) clearTimeout(tileSearchTimer);
      tileSearchTimer = setTimeout(() => commitTileSearch(input), VARIABLE_DEBOUNCE_MS);
    },
    onblur: (event: Event) => commitTileSearch(event.target as HTMLInputElement),
    onkeydown: (event: KeyboardEvent) => {
      if (event.key === 'Enter') commitTileSearch(event.target as HTMLInputElement);
    },
  }) as HTMLInputElement;
  const tileSearch = h('label', { class: 'dash-tile-search-wrap' },
    Icon.search(), tileSearchInput);
  const timeVariableHost = h('div', {
    class: 'dash-time-variable-host dash-variables',
    role: 'group', 'aria-label': 'Dashboard time variables',
  });
  const ordinaryVariableHost = h('div', {
    class: 'dash-variable-host dash-variables',
    role: 'group', 'aria-label': 'Dashboard variables',
  });
  const ordinaryTimeIds = new Set(session.timeRangeGroups.flatMap((group) =>
    [group.fromVariableId, group.toVariableId]));
  const ordinaryVariableIds = session.state.value.variableStates
    .filter((variable) => !ordinaryTimeIds.has(variable.id)).map((variable) => variable.id);
  const clearVariablesBtn = h('button', {
    class: 'dash-clear-variables', type: 'button', disabled: true,
    onclick: () => { void session.resetVariables(ordinaryVariableIds); },
  }, 'Clear all') as HTMLButtonElement;

  // ── Variable bar (shared buildVariableBar, viewer-backed) ─────────────────────
  // The compound time controls mount in the primary row; ordinary controls
  // mount in the second scrolling row beside selective Clear all.
  // #189: a PERSISTENT sr-only announcer, a SIBLING of `ordinaryVariableHost` (never a
  // child — `ordinaryVariableHost.replaceChildren` below only ever replaces the bar's
  // own root) so it survives the very rebuild that fires it: when a rebuild
  // disposes an outgoing bar that had a multiselect popover open, the dispose
  // silently Cancels that popover (see multi-select-field.ts), and this is
  // the only trace of that left for an assistive-tech user.
  const variableRefreshLiveEl = h('div', { class: 'sr-only', 'aria-live': 'polite' });
  // The draft value/active bag the shared variable bar reads + mutates; re-seeded
  // from committed variable state on each (re)build. Recents come from the real
  // app — the viewer never touches AppState.
  const draftValues: Record<string, string> = {};
  const draftActive: Record<string, boolean> = {};
  const variableBarApp: VariableBarApp = {
    document: doc,
    // #478: aliases the local draft maps above — an in-memory-only activation
    // map, never persisted, so `saveActive` is a no-op adapter (there is
    // nothing to save; unlike detached Data, this Dashboard draft has no
    // Workbench-persisted counterpart to route to).
    state: { varValues: draftValues, activeByName: draftActive },
    // #478: a live read at call time, not a copied `state.varRecent` data
    // property — `state.varRecent` (the real `AppState` field) is REPLACED
    // wholesale by `clearVarRecent`/`recordBoundParams`, never mutated in
    // place, so a snapshot taken here at adapter-construction time would go
    // stale the moment either fires while this bar is still mounted.
    getVarRecent: () => state.varRecent,
    params: {
      saveVarValues: () => {},
      saveActive: () => {},
      clearVarRecent: (name: string) => app.params.clearVarRecent(name),
    },
    wallNow: () => app.wallNow(),
  };
  // #189: the retained bar itself (not just its `dispose`) — `hasOpenMultiSelect`
  // is read off it right before a rebuild disposes it (see below).
  let currentVariableBar: VariableBarHandle | null = null;
  // Maintainer merge-gate fix (#189): each parameter's `optionsRev` as of the
  // CURRENTLY-RETAINED bar's own build — compared, below, against the
  // incoming view's `optionsRev` for whichever parameter had an open (or
  // just-closed) multiselect popover, so the refresh announcement fires only
  // when that parameter's options actually changed content, never merely
  // because a rebuild happened to run while (or right after) its popover was
  // up. Replaced wholesale after every rebuild (never merged) — a variable that
  // disappears from `sview.variableStates` simply drops out.
  // #335: shell-owned, session-lifetime per-group "Recently used" ranges,
  // keyed by `group.key`. NOT persisted in v1 (owner decision) and naturally
  // discarded when this `renderDashboard` call's session is torn down or the
  // dashboard switches (a fresh render builds a fresh map). Each successful,
  // changing commit pushes the OUTGOING committed pair (see `onApplyTimeRange`
  // in `rebuildVariableBar`).
  const timeRangeRecents = new Map<string, TimeRangeRecent[]>();
  const timeRangeApplyGeneration = new Map<string, number>();
  const groupByTileId = new Map(session.timeRangeGroups.flatMap((group) => group.tileIds.map((tileId) => [tileId, group] as const)));

  const applyTimeRange = async (
    group: DashboardTimeRangeGroup, from: string, to: string,
  ): Promise<void> => {
    const generation = (timeRangeApplyGeneration.get(group.key) ?? 0) + 1;
    timeRangeApplyGeneration.set(group.key, generation);
    const variableById = new Map(session.state.value.variableStates.map((variable) => [variable.id, variable] as const));
    const fromF = variableById.get(group.fromVariableId);
    const toF = variableById.get(group.toVariableId);
    const outFrom = fromF ? valueString(fromF.value) : '';
    const outTo = toF ? valueString(toF.value) : '';
    const wasActive = !!(fromF?.active && toF?.active);
    const result = await session.applyVariables([
      { variableId: group.fromVariableId, value: from, active: true },
      { variableId: group.toVariableId, value: to, active: true },
    ]);
    if (!app.isSurfaceGenerationCurrent(surfaceGeneration)) return;
    if (timeRangeApplyGeneration.get(group.key) !== generation) return;
    /* v8 ignore next 3 -- the mounted controls and chart formatter prevalidate;
       retained for a stale/destroyed-session race so failure is announced. */
    if (!result.ok) {
      variableRefreshLiveEl.textContent = `Time range was not changed: ${result.error}`;
      return;
    }
    if (result.changed && wasActive && outFrom !== '' && outTo !== '' && (outFrom !== from || outTo !== to)) {
      timeRangeRecents.set(group.key,
        pushRecentRange(timeRangeRecents.get(group.key) ?? [], { from: outFrom, to: outTo }));
    }
    variableRefreshLiveEl.textContent = `Time range applied: ${from} → ${to}`;
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

  function rebuildVariableBar(sview: DashboardViewState): void {
    // #189-F2b, GENERALIZED (#335): ask the OUTGOING bar WHICH control's
    // popover is open (if any) BEFORE disposing it — disposing while open is
    // that control's own silent Cancel (multi-select-field.ts /
    // time-range-field.ts), so this is the only chance to notice it, tell an
    // assistive-tech user their popover just closed out from under them (the
    // shared `variableRefreshLiveEl`, never torn down by the rebuild), and move
    // focus to that SAME control's trigger on the freshly-built bar below
    // (never left stranded at `<body>` — F2 review finding). The key is a
    // parameter name for a multiselect field, `group:…` for a time-range one.
    const openPopoverKey = currentVariableBar?.openPopoverKey() ?? null;
    // Maintainer merge-gate fix (#189): an ordinary Apply already closed its
    // OWN popover before its commit callback reached the session — by the
    // time that commit's synchronous `publish()` gets here, `openPopoverKey`
    // above already reads `null` for it. `focusedFieldKey` still finds it
    // (focus sits on that control's about-to-be-detached trigger), so focus
    // restoration below has a signal to work with even when there was no open
    // popover to speak of — never used for the ANNOUNCE decision (only a
    // genuinely open popover's cancellation is ever worth announcing).
    const focusedFieldKey = currentVariableBar?.focusedFieldKey() ?? null;
    const restoreFocusKey = openPopoverKey ?? focusedFieldKey;
    currentVariableBar?.dispose();
    const idByParam = new Map<string, string>();
    // #447 phase 2: a variable renders either a direct input for its declared
    // type, or — when it carries Dashboard-local option SQL — a strict
    // single-select over whatever the refresh's ONE compiled option batch
    // returned for it. `configured` (not the presence of `options`) decides
    // which: it is known from the first publish, so a select never starts life
    // as a text box and changes type once the query lands. `null` options mean
    // direct input; `[]` means option-backed with nothing to offer yet.
    const variables: Record<string, VariableFieldSpec> = {};
    for (const f of sview.variableStates) {
      // An `Array(scalar T)` variable's committed value is a real `string[]`.
      // It must NOT be flattened into the shared scalar draft bag — `String()`
      // would turn `['a','b']` into `"a,b"`, a value nothing can round-trip —
      // so it travels on the spec instead and its draft slot stays unset. That
      // bag is `Record<string, string>` precisely so the Workbench var-strip,
      // which shares its shape, can never be handed an array.
      const selection = Array.isArray(f.value) ? f.value.filter((v): v is string => typeof v === 'string') : null;
      draftValues[f.parameter] = selection === null ? valueString(f.value) : '';
      draftActive[f.parameter] = f.active;
      idByParam.set(f.parameter, f.id);
      variables[f.parameter] = {
        options: f.configured ? (f.options ?? []) : null,
        // The variable's OWN reason, not the Dashboard-wide banner: a variable
        // whose option SQL was rejected locally has a specific problem, and the
        // batch failure is only its reason when it was actually in that batch.
        optionsError: f.optionsError,
        // The batch has not answered for this variable yet. `renderDashboard`
        // mounts the whole surface BEFORE awaiting `session.start()`, so a
        // configured variable is interactive for the entire option request —
        // long enough to open a multi-select and Apply against a list that has
        // not arrived, which would clear a restored selection.
        loading: f.status === 'loading',
        // The list is a PREFIX: a committed value may be valid and simply live
        // past the cap. The session already declines to prune one; the control
        // must decline too, or its own Apply undoes that one layer up.
        optionsIncomplete: f.optionsTruncated,
        ...(selection === null ? {} : { selection }),
      };
    }
    const onCommit = (name: string): void => {
      const id = idByParam.get(name);
      if (id) session.applyVariable(id, draftValues[name] ?? '', !!draftActive[name]);
    };
    // A select commits its value AND activation together, with no debounce — a
    // pick (or the × clearing back to unset) is a complete, deliberate action.
    const onCommitVariable = (name: string, value: string, active: boolean): void => {
      const id = idByParam.get(name);
      if (id) void session.applyVariable(id, value, active);
    };
    // The multi-select's Apply. Same "complete, deliberate action" semantics as
    // the single-select above; the only difference is that the value is a real
    // array, which `applyVariable` already accepts (`value: unknown`) and the
    // session reduces to unset when it is empty.
    const onCommitVariableSelection = (name: string, values: string[], active: boolean): void => {
      const id = idByParam.get(name);
      if (id) void session.applyVariable(id, values, active);
    };
    const getField = (name: string, mode: ValidationMode) => session.getVariableField(name, mode, draftValues, draftActive);
    // #335: assemble the time-range option — one entry per resolved group,
    // reading each bound's committed value/active straight off `sview.variableStates`
    // (the from/to variables stay in the view regardless of presentation, so a
    // time-range commit still flips `barSig` below and rebuilds this bar). The
    // pair's two individual fields are suppressed by parameter name inside
    // `buildVariableBar`. `waveNowMs` is this wave's shared `now` snapshot.
    const variableById = new Map(sview.variableStates.map((f) => [f.id, f] as const));
    const timeRange = session.timeRangeGroups.flatMap((group) => {
      const fromF = variableById.get(group.fromVariableId);
      const toF = variableById.get(group.toVariableId);
      return [{
        group,
        // timeRangeGroups is resolved from this same variable collection.
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
    const bar = buildVariableBar(
      variableBarApp, session.controls, onCommit, getField,
      { document: doc, timeRange, onApplyTimeRange, variables, onCommitVariable,
        onCommitVariableSelection,
        onKeyboardOwnerChange: keyboardOwnerChannel(app) },
    );
    timeVariableHost.replaceChildren(bar.timeEl);
    ordinaryVariableHost.replaceChildren(bar.ordinaryEl);
    currentVariableBar = bar;
    // #447 removed the "Filter options were refreshed" announcement. It fired
    // when an OPEN popover's option list changed content between two builds,
    // which only a running option-source query could cause; a direct-input
    // variable has no option list to refresh.
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

  const variableDiagnosticsHost = h('div', { class: 'dash-variable-diagnostics' });
  const grid = h('div', { class: 'dash-grid' });
  const empty = h('div', { class: 'dash-empty', style: { display: currentDoc.tiles.length ? 'none' : '' } },
    // #427: the star no longer adds a panel, so this must not tell the user to
    // use it. #428 built the route this now names first — dragging a Library
    // query onto this Dashboard (or its Panels group) in the sidebar tree, which
    // is the discoverable one. Editing the Spec still works and stays named as
    // the fallback.
    'No panels yet — drag a query here from the Library, or edit this dashboard’s Spec.');
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
  function ctxFor(baseDoc: DashboardDocumentV2, queriesForResolver: SavedQueryV2[]) {
    return {
      // The Dashboard UI never dispatches add-query commands; retain the
      // required context seam without an unreachable local lambda.
      resolver: createQueryResolver(queriesForResolver), genTileId: String.prototype.toString.bind('tile'),
      plugin: resolveLayoutPluginSync(baseDoc.layout),
    };
  }

  /**
   * Apply one route command.
   *
   * #537 removed the `remove-tile` arm this used to carry. The tile head was the
   * only UI dispatcher of that command, and it now commits panel removal as a
   * two-resource workspace write (`removeTile`) rather than a layout command — so
   * the membership follow-up (`removeTileMembership`, target scrubbing,
   * `spec.favorite` mirroring) happens inside `removeDashboardPanel` instead. The
   * command itself survives in `dashboard-commands.ts` as model vocabulary with
   * its own coverage; nothing in the UI sends it.
   */
  function applyRouteCommand(
    baseDoc: DashboardDocumentV2, command: DashboardCommand, queriesForResolver: SavedQueryV2[],
  ) {
    const applied = applyCommand(baseDoc, command, ctxFor(baseDoc, queriesForResolver));
    return applied.ok ? { ...applied, queries: queriesForResolver } : applied;
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
    if (applied.ok) {
      const normalized = resolveLayoutPluginSync(applied.dashboard.layout).normalize(applied.dashboard);
      // Apply OPTIMISTICALLY first so a drag/resize preview stays instant — the
      // commit below either confirms this (this command's own commit round-
      // trips its own edit) or a rebase corrects it once resolutions land.
      currentDoc = normalized;
      layoutMenu.sync();
      syncSessionDocument(normalized);

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
      let observed: StoredWorkspaceV5 | null | undefined;
      void app.mutateWorkspace((latest) => {
        observed = latest;
        // ONE guard, exactly the pre-#424 `!latest || !latest.dashboard` shape:
        // either nothing is committed, or (#424) THIS route's PINNED Dashboard is
        // gone from committed truth — deleted, or replaced by an import while
        // this command sat in the queue. Either way the command no longer
        // applies: abort rather than retarget whichever Dashboard now happens to
        // sit in the compatibility slot.
        const base = latest && findDashboard(latest, selectedDashboardId);
        if (!base) return null;
        // `base` is truthy only when `latest` was, so the aggregate exists here.
        const committed = latest as StoredWorkspaceV5;
        const reapplied = applyRouteCommand(base, command, committed.queries);
        if (!reapplied.ok) return null;
        const committedDoc = resolveLayoutPluginSync(reapplied.dashboard.layout).normalize(reapplied.dashboard);
        // Replaces exactly this one entry, addressed by its stable id; every
        // other stored Dashboard is carried through untouched, revisions
        // included. `null` means the id became AMBIGUOUS (a duplicate reached
        // committed truth) — never silently overwrite one of two matches.
        const next = replaceDashboard(committed, selectedDashboardId, {
          ...committedDoc, revision: base.revision + 1,
        });
        if (!next) return null;
        return { candidate: { ...next, queries: reapplied.queries } };
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
    // A tile menu is mounted on the BODY and anchored to a trigger inside a card
    // this rebuild is about to discard, so it would survive its own tile —
    // hovering over nothing, with every row acting on a tile id the replacement
    // render may not even have. A surface TRANSITION is already covered
    // (`closeOpenMenus` runs from the app shell); an in-place rebuild is not.
    openTileMenu?.close();
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
  function settleCommand(result: WorkspaceCommitResult | null, observed: StoredWorkspaceV5 | null | undefined): void {
    // FIFO queue — every resolution arrives in dispatch order, so this
    // command is always the head.
    pendingCommands.shift();
    if (result && result.ok) {
      committedWorkspace = result.workspace;
      committedRevision = findDashboard(result.workspace, selectedDashboardId)?.revision ?? committedRevision + 1;
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
        committedRevision = (observed && findDashboard(observed, selectedDashboardId)?.revision)
          ?? committedRevision;
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
    let rebased: DashboardDocumentV2 | null = committedWorkspace
      ? findDashboard(committedWorkspace, selectedDashboardId) : null;
    // #424: the pinned Dashboard vanished from committed truth (an Import
    // Dashboard replaced the compatibility slot with a different document while
    // this command was in flight). The rendered document no longer exists, so
    // rebuild the whole route from the projection instead of leaving a phantom
    // Dashboard on screen.
    if (!rebased) {
      needsRebuild = true;
      rebuildRouteFromCommitted();
      return;
    }
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
    syncSessionDocument(rebased);
    layoutMenu.sync();
  }

  // ── Restored scroll offset (#471) ─────────────────────────────────────────
  // The offset a history entry owes this render (see `dashboardScrollTop`), applied
  // after mount and again after every publish until it TAKES.
  //
  // A scroll offset cannot be set against a page that is not yet tall enough: at
  // mount the grid host is empty — tiles are appended by the first publish, and
  // grafana-grid's per-tile px heights are applied there too — so a single
  // post-mount write clamped silently to 0. happy-dom cannot see that at all; it
  // reports back whatever was assigned.
  //
  // Self-limiting: it stops on the first write that sticks, so ordinary later
  // publishes (a refresh wave, a Search, a layout switch) never yank a page the user
  // has since scrolled. A Dashboard that no longer reaches that offset keeps clamping
  // to its own maximum, which is the closest honest answer.
  //
  // Declared HERE, above the publish effect, rather than beside the mount that
  // supplies `scrollHost`: `effect()` runs its body immediately on creation, so a
  // `let` declared after it would be in its temporal dead zone on that first run and
  // abort the whole render.
  let owedScrollTop = target.scrollTop;
  let scrollHost: HTMLElement | null = null;
  const applyOwedScroll = (): void => {
    if (owedScrollTop === null || owedScrollTop <= 0 || scrollHost === null) return;
    scrollHost.scrollTop = owedScrollTop;
    if (scrollHost.scrollTop > 0) owedScrollTop = null;
  };

  // ── Tile DOM ──────────────────────────────────────────────────────────────
  const tileEls = new Map<string, TileEl>();
  // Flow KPI tiles do not render their cached `.dash-tile` card. Their
  // `.dash-kpi-member` host is the structural/movement surface instead.
  const flowKpiHosts = new Map<string, HTMLElement>();
  // #589 wave 2: the click-suppress flag (#332/#471), the drag-armed flag
  // (renamed `dragActive` in its new home — it never implied controller-wide
  // mutual exclusion, only "one drag at a time"), and the ⌘/Ctrl modifier-held
  // flag below all now live inside `createTileGestureController`
  // (dashboard-tile-gestures.ts), which `gestures` (constructed below) owns.
  // #291: which engine is active as of the last publish — read by the grid-
  // only resize handler (built once per tile in `ensureTileEl`, below, and
  // cached across engine switches) so a cached card's grid chrome stays
  // visually hidden AND inert while flow is active, instead of a per-switch
  // DOM rebuild, and by the tile menu to tell a flow KPI BAND member (which has
  // no width of its own) from a grid KPI card. `null` before the first publish
  // (never actually read then — no pointer/click interaction can precede it).
  let activeEngine: 'flow' | 'grafana-grid' | null = null;
  // At most one tile menu open at a time, which `openMenu`'s own viewport overlay
  // already guarantees: a press on a second tile's trigger hits `.fm-overlay`
  // first and never reaches the button. Held so the trigger can TOGGLE, and so a
  // route rebuild can close a menu whose tile is about to be replaced.
  let openTileMenu: MenuHandle | null = null;
  const tileMenuKeyboard = keyboardOwnerChannel(app);
  // The tile ids the last publish rendered, in render order — the successor a
  // removal hands its focus to comes from here (`neighbourTileId`). Empty until the
  // first publish, which is also the earliest a removal can be triggered.
  let publishedTileIds: string[] = [];
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

  // #321: the resize handle's accessible label/title reflects the CURRENT
  // render mode ('tiles' = two-dimensional resize, 'full' = vertical-only) —
  // the cursor affordance is pure CSS (`.dash-gg-grid.is-full .dash-gg-resize`,
  // styles.css), so only the label needs a per-tile DOM update when the mode
  // flips (Part D, the render effect).
  function resizeHandleLabel(full: boolean): string {
    return full ? 'Resize tile height' : 'Resize';
  }
  /** True for the fixed-width authored styles (#535): Full and Report are both
   *  one tile per row at a width the author cannot change. Two presentation
   *  decisions follow from that and now read this ONE predicate rather than
   *  re-listing the pair: the resize handle is vertical-only (below), and the
   *  tile head has room for a description subtitle (`applyTileHeaderStyle`).
   *
   *  The resize label needs it because the render-mode mirror (`gridRenderMode`)
   *  cannot answer the question — it is `'tiles'` for Report, so a Dashboard
   *  that OPENS in Report saw neither a mode flip nor a style change on its
   *  first publish and kept the generic "Resize" label (#549 review). */
  const isFixedWidthStyle = (style: DashboardStyle): boolean => style === 'full' || style === 'report';
  function applyResizeHandleMode(tileEl: TileEl, full: boolean): void {
    if (!tileEl.resizeHandle) return;
    tileEl.resizeHandle.hidden = currentDashboardStyle === 'columns-2'
      || currentDashboardStyle === 'columns-3';
    const label = resizeHandleLabel(full);
    tileEl.resizeHandle.title = label;
    tileEl.resizeHandle.setAttribute('aria-label', label);
  }

  /**
   * #535 — the style the widen button is currently stepping through, or `null` when
   * there is nothing to step: a single-column style (`report`, `full`), or a flow
   * layout collapsed to one column by the mobile breakpoint (which would let a press
   * persist a width the viewport cannot show).
   *
   * Kept as state rather than re-derived per click because the layout menu changes
   * it without rebuilding a single tile — every tile's button reads this one value.
   * `null` until the first publish, which is also when the first tile is built.
   */
  let widenStyle: DashboardStyle | null = null;
  // The selected style also controls whether the saved-query description is a
  // visible subtitle or a tooltip on the name. Like `widenStyle`, this mirror
  // is updated before reconciliation so a tile first built during that publish
  // arrives with the right header presentation.
  let tileHeaderStyle: DashboardStyle = session.state.value.style;

  /** Full and Report have enough horizontal room for a description subtitle.
   *  The denser Grid Tiles and 2/3-column styles keep only the name visible and
   *  expose the description itself as that name's native hover tooltip. */
  function applyTileHeaderStyle(ts: ViewerTileState, tileEl: TileEl): void {
    const expanded = isFixedWidthStyle(tileHeaderStyle);
    if (expanded) tileEl.headingName.title = ts.title;
    else if (ts.description) tileEl.headingName.title = ts.description;
    else tileEl.headingName.removeAttribute('title');
    if (tileEl.headingDescription) tileEl.headingDescription.hidden = !expanded;
  }

  /**
   * `sview.style` is the ONE value that already folds authored style, legacy
   * engine state, and temporary preview together, so this is a single read
   * rather than a re-derivation that could disagree with what is on screen.
   *
   * Mobile is the one thing it does not fold in: `style` stays `'columns-2'` on a
   * phone while the preview renderer forces every effective span to 1. A press
   * there would have no visible effect at all — and
   * `@media (hover: none)` means the button is permanently visible on that
   * viewport, so it would be an inviting no-op. The grid needs no such guard: its
   * narrow behaviour is a responsive clamp over the authored span, and authoring
   * over the clamp is already the documented rule there (see `wireGridResize`).
   */
  function widenStyleFor(sview: DashboardViewState): DashboardStyle | null {
    if (
      (sview.style === 'columns-2' || sview.style === 'columns-3')
      && (sview.layout.engine === 'flow'
        ? sview.layout.mobile
        : sview.layout.grid.columns === 1)
    ) return null;
    return canWidenPanel(sview.style) ? sview.style : null;
  }

  /**
   * One tile's PERSISTED placement, read through the ACTIVE engine — never the
   * rendered effective span, which a Full-view or mobile render overrides;
   * widening from an override would silently rewrite the authored width (#321).
   *
   * Reading flow's placements off `currentDoc.layout.items` directly is safe HERE
   * only because widen never runs for a document whose primary engine is
   * unsupported: `sview.style` for such a document resolves to its (undefined)
   * `layout.preset`, `canWidenPanel` refuses that, and the button is hidden. The
   * `duplicate-tile` command, which CAN reach such a document, goes through the
   * plugin-aware reader instead.
   */
  function storedPlacement(tileId: string): unknown {
    if (widenStyle === 'columns-2' || widenStyle === 'columns-3') {
      const rendered = gridPlacementByTile.get(tileId);
      return rendered ? { span: rendered.span, height: DEFAULT_GRID_HEIGHT_UNITS } : undefined;
    }
    return currentDoc.layout.version === 2
      ? stylePlacementAt(currentDoc.layout, tileId, 'grid')
      : gridPlacementAt(currentDoc.layout, tileId);
  }

  /** Show/hide and re-label one tile's widen button for the current style and the
   *  tile's current width. Called on every publish, because a widen changes the
   *  label the NEXT press needs ("Widen to 12 columns" → "Shrink to 1 column"). */
  function applyWidenMode(ts: ViewerTileState, tileEl: TileEl): void {
    const btn = tileEl.widenBtn;
    if (!btn) return;
    const style = widenStyle;
    btn.hidden = style === null;
    if (style === null) return;
    const label = widenLabel({ style, placement: storedPlacement(ts.tileId) });
    btn.title = label;
    btn.setAttribute('aria-label', label + ': ' + ts.title);
  }

  // #589 wave 2: `wireGridResize`/`wireTileDrag` (and the private
  // `prefersReducedMotion` helper they shared) now live inside
  // `createTileGestureController` (dashboard-tile-gestures.ts) — this module
  // only constructs the controller (`gestures`, below `gridStructureInvalidationRev`)
  // and calls `gestures.wireGridResize`/`gestures.wireTileDrag` from the same
  // tile-build call sites the pre-extraction functions were called from.

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

  /**
   * #471 — the tile's own expand action, or `null` when this tile has no query
   * document to open.
   *
   * Deliberately NOT `!readOnly`-gated the way the grip and delete button are:
   * inspecting the query behind a tile is a View-mode act first, and the issue
   * requires the action in both modes. Built once per tile, like the heading.
   *
   * The tile's `queryId` IS the stable document origin this action needs. #427 made
   * every panel tile reference a dedicated saved-query copy that exactly one member
   * owns, so handing that id to `openPanelQuery` re-selects the tab already open on
   * the SAME copy (`loadIntoNewTab` dedups on `savedId`, never on the displayed
   * name) and every later Save from that tab keeps targeting this Dashboard's copy
   * rather than a same-named Library query. Two Dashboards holding same-named
   * copies are two ids, therefore two tabs.
   *
   * #535 — the tile ids travel with it now: the action also runs the query and
   * reveals this panel's Dashboards-tree row, and a tree row is addressed by
   * Dashboard id plus tile id, never by query id. `selectedDashboardId` is
   * non-null for every render that builds a tile (the "Create dashboard" state has
   * no tiles), so it is asserted rather than re-checked per button.
   *
   * `null` — never a disabled-and-silent button, and never a button pointing at
   * some other tile's document — when there is nothing to open: a `text` panel is
   * queryless by capability (`isQuerylessPanel`, the same shared predicate Save and
   * share use), and an unresolvable `queryId` belongs to a tile that is already
   * rendering its own missing-query error.
   */
  function tileOpenAction(ts: ViewerTileState): HTMLButtonElement | null {
    if (!queryById.has(ts.queryId) || isQuerylessPanel(ts.panel as Panel | null)) return null;
    return h('button', {
      class: 'dash-tile-open', type: 'button', title: 'Open in Workbench and run',
      'aria-label': 'Open ' + ts.title + ' in Workbench and run',
      onclick: () => {
        app.openPanelQuery({
          dashboardId: selectedDashboardId as string, tileId: ts.tileId, queryId: ts.queryId,
        });
      },
    }, Icon.expand());
  }

  /**
   * The tile's `⋯` overflow trigger (edit mode only).
   *
   * #535 put duplicate, widen and expand in the head beside the grip and the
   * delete button, which made FIVE controls compete with the tile title for one
   * flex row — and a tile one grid column wide has no row to compete for. Four of
   * them live in this menu now; widen keeps an inline button as well, because it
   * is the size adjustment users make constantly (#535) and it is the one the CSS
   * container query can withdraw when the tile really is too narrow.
   *
   * View mode has no trigger at all: it carries exactly one action (expand), and a
   * one-row menu is strictly worse than the button it would hide. `readOnly` is
   * resolved once per render and never toggles mid-session, so this is a
   * build-time branch like the grip's.
   *
   * Reintroducing a `⋯` is a partial reversal of #494, which removed one from
   * every Dashboards-TREE row in favour of direct controls. That argument was
   * about a two-control row in a fixed-width side pane; this is a five-control
   * head on a card that can render under 100px wide.
   */
  function tileMenuAction(ts: ViewerTileState): HTMLButtonElement {
    const trigger = h('button', {
      class: 'dash-tile-menu', type: 'button', title: 'Panel actions',
      // Names the TILE, like every other tile control: a screen-reader user meets
      // these in sequence, and three buttons all called "Panel actions" name none
      // of them.
      'aria-label': 'Panel actions: ' + ts.title,
      onclick: () => {
        // The style picker's toggle idiom: `openMenu` itself only ever opens, so
        // an explicit open/close press has to be tracked by the caller.
        if (openTileMenu) { openTileMenu.close(); trigger.focus(); return; }
        showTileMenu(ts, trigger);
      },
    }) as HTMLButtonElement;
    trigger.appendChild(Icon.more());
    return trigger;
  }

  /** The glyph per action kind — the same four #535 chose for the head buttons. */
  const TILE_ACTION_ICON: Record<PanelTileActionKind, () => Node> = {
    duplicate: Icon.copy, widen: Icon.arrowsWide, open: Icon.expand, remove: Icon.trash,
  };

  /**
   * Build and open one tile's action menu.
   *
   * Every input is read at CLICK time, never at tile-build time — the same rule
   * `tileWidenAction` already states for `widenStyle`. The layout menu changes the
   * active style without rebuilding a single tile, the workspace moves under the
   * route between publishes, and the removal's availability depends on committed
   * ownership; a menu composed once at construction would be a lie one press
   * later.
   */
  function showTileMenu(ts: ViewerTileState, trigger: HTMLButtonElement): void {
    const actions = panelTileActions({
      title: ts.title,
      dashboardTitle: currentDoc.title,
      widenStyle,
      includeWiden: currentDashboardStyle !== 'full' && currentDashboardStyle !== 'report',
      placement: storedPlacement(ts.tileId),
      kpiBandMember: ts.isKpi && activeEngine === 'flow',
      queryResolves: queryById.has(ts.queryId),
      queryless: isQuerylessPanel(ts.panel as Panel | null),
      removalRefusal: panelRemovalRefusal({
        workspace: app.currentWorkspace as StoredWorkspaceV5,
        dashboardId: selectedDashboardId as string,
        tileId: ts.tileId,
        queryId: ts.queryId,
      }),
    });
    const rows: MenuRow[] = [];
    for (const action of actions) {
      // The destructive row is separated and last: the one control whose position
      // must not shift as the labels above it change.
      if (action.destructive) rows.push({ kind: 'sep' });
      rows.push({
        kind: 'item',
        icon: TILE_ACTION_ICON[action.kind](),
        label: action.label,
        reason: action.unavailable,
        disabled: action.unavailable !== null,
        ...(action.destructive ? { extraClass: 'dash-tile-menu-danger' } : {}),
        onClick: () => { runTileAction(action, ts, trigger); },
      });
    }
    // The head reveals its controls with `opacity`, and this menu mounts on the
    // BODY and takes focus with it — so the tile loses `:focus-within` and the
    // trigger would fade out from under its own open menu. `aria-expanded` (set by
    // `openMenu` for the popup's whole lifetime) is the CSS hook that holds it
    // visible; a grid KPI tile additionally needs the class below, because its
    // whole head is `opacity: 0` and ancestor opacity COMPOSITES — a child's own
    // `opacity: 1` cannot win against it.
    const head = trigger.closest('.dash-tile-head');
    head?.classList.add('is-menu-open');
    openTileMenu = openMenu({
      document: doc,
      trigger,
      rows,
      menuClass: 'dash-tile-actions',
      ariaLabel: 'Panel actions: ' + ts.title,
      onClose: () => {
        openTileMenu = null;
        head?.classList.remove('is-menu-open');
      },
      onKeyboardOwnerChange: tileMenuKeyboard,
    });
  }

  /**
   * The `⋯` trigger a tile is CURRENTLY showing, or `null`.
   *
   * A tile can own two: the one in its cached head, and — for a flow KPI band
   * member, whose head is never inserted into the DOM at all — the one moved into
   * its band card. `flowKpiHosts` is the same map the reconciler and
   * `tileFocusTarget` already use to answer exactly this question, so which one is
   * live is read from that rather than probed for with `isConnected` (which also
   * answers "no" for every control on an unmounted surface, making it a different
   * question than the one being asked).
   */
  function liveTileMenuBtn(tileId: string): HTMLButtonElement | null {
    const tileEl = tileEls.get(tileId);
    const band = flowKpiHosts.has(tileId) ? tileEl?.kpiActions?.menuBtn : null;
    return band ?? tileEl?.menuBtn ?? null;
  }

  /** Run one chosen row.
   *
   *  Only ever reached for an AVAILABLE action: `openMenu` renders an unavailable
   *  row with `aria-disabled` and NO click handler (#452's announced-but-inert
   *  pattern), so unavailability is enforced one layer up rather than re-checked
   *  here — a second guard would be a branch nothing can execute. The widen press
   *  still re-reads its style at click time, because that one can go stale between
   *  the menu opening and the row being chosen. */
  function runTileAction(
    action: PanelTileAction, ts: ViewerTileState, trigger: HTMLButtonElement,
  ): void {
    if (action.kind === 'duplicate') { void duplicateTile(ts.tileId); return; }
    if (action.kind === 'widen') { widenTile(ts.tileId); return; }
    if (action.kind === 'open') {
      app.openPanelQuery({
        dashboardId: selectedDashboardId as string, tileId: ts.tileId, queryId: ts.queryId,
      });
      return;
    }
    // `openMenu` closed this menu BEFORE calling us and cleared its
    // `aria-expanded`, so a second `openMenu` on the same trigger is a fresh
    // open rather than a stacked one.
    openConfirmMenu({
      document: doc,
      trigger,
      question: action.confirm as string,
      confirmLabel: 'Remove tile',
      menuClass: 'dash-tile-confirm',
      goClass: 'dash-tile-confirm-go',
      cancelClass: 'dash-tile-confirm-cancel',
      ariaLabel: 'Confirm removing ' + ts.title,
      onKeyboardOwnerChange: tileMenuKeyboard,
      // A resolver, not this element: the confirmation can sit open across an
      // unrelated repaint, and a flow KPI band member's card is replaced on
      // every publish. Resolve the tile's CURRENT trigger instead.
      returnFocusTo: () => liveTileMenuBtn(ts.tileId),
      onConfirm: () => { void removeTile(ts); },
    });
  }

  /**
   * #537 — remove one panel from its tile head, atomically.
   *
   * The tile head used to dispatch the document-only `remove-tile` command, which
   * takes the tile out of `dashboard.tiles[]` and deliberately leaves
   * `workspace.queries` alone. Since #427 made every panel tile the SOLE OWNER of
   * a dedicated saved-query copy, that left the copy with zero owners — which is
   * exactly what makes a query a Library query — so a deleted panel reappeared in
   * Library as an apparently standalone entry. This is the same confirmed,
   * ownership-proven, two-resource path the Dashboards tree already uses.
   *
   * It also has no engine gate. The old delete button was inert unless
   * `activeEngine === 'grafana-grid'` and CSS-hidden outside `.dash-gg-grid`, so
   * Report and the two column presets had no delete at all, and a flow KPI band
   * member had none under any style. Membership removal has no layout semantics
   * of its own, so the menu row is simply always there.
   *
   * Like duplication (#535) this does NOT go through `runCommand`: it is a
   * two-resource workspace write, and the route rebuild that
   * `onWorkspaceExternallyChanged({queriesChanged: true})` triggers IS the
   * feedback. Same known cost as duplication — that rebuild re-runs every tile's
   * query.
   */
  async function removeTile(ts: ViewerTileState): Promise<void> {
    // Resolved BEFORE the commit, from the tiles as currently PAINTED: afterwards
    // this tile is gone and the order it stood in cannot be reconstructed.
    const successorId = neighbourTileId(ts.tileId);
    const outcome = await commitPanelRemoval({
      mutateWorkspace: app.mutateWorkspace,
      // The successor focus is OWED to the rebuild rather than delivered when
      // this promise resolves: the hook fires (only on success) inside the
      // commit, and the `queriesChanged` rebuild it triggers replaces every
      // tile card — so a focus call made afterwards would aim at a node already
      // on its way out, and `deliverFocus` would correctly report `pending` and
      // do nothing. Setting it here, in the hook, means the surface owes the
      // delivery to the one render where the successor actually exists.
      onWorkspaceExternallyChanged: (info) => {
        if (successorId !== null) {
          app.mainSurface = withPendingFocus(app.mainSurface, { kind: 'tile', id: successorId });
        }
        app.onWorkspaceExternallyChanged(info);
      },
    }, {
      dashboardId: selectedDashboardId as string, tileId: ts.tileId, queryId: ts.queryId,
    });
    const message = dashboardDeleteMessage(outcome);
    if (message !== null) {
      flashToast(message, { document: doc });
      // A refusal changed nothing, so the control the user pressed is still
      // there — and the confirmation's own restore already aimed at it, so this
      // only matters when the menu closed some other way.
      liveTileMenuBtn(ts.tileId)?.focus();
      return;
    }
    // With no tiles left there is no successor to owe a delivery to, and the tile
    // search is the route's always-present landing control — the grid's analogue
    // of the tree's own `dashboardSearchInput` fallback.
    if (successorId === null) tileSearchInput.focus();
  }

  /** The tile that should hold focus once `tileId` is gone: the next one published,
   *  or the previous one when it was last. `null` when it was the only one.
   *
   *  Read from `publishedTileIds` rather than from `tileEls` (a write-only cache that
   *  also holds cards the Dashboard's own tile search has filtered out) and never
   *  from DOM connectivity — "next" has to mean next in what the user is looking at,
   *  and a predicate over `isConnected` would answer differently depending on
   *  whether the surface happens to be mounted. */
  function neighbourTileId(tileId: string): string | null {
    // A tile whose own menu the user just used was on screen, so `indexOf` cannot
    // answer -1 here; that case is tolerated in the same expression rather than
    // given an early return no test could execute (it would pick the first tile,
    // which is a real one).
    const at = publishedTileIds.indexOf(tileId);
    return publishedTileIds[at + 1] ?? publishedTileIds[at - 1] ?? null;
  }

  /** Commit one duplication and report a refusal. Nothing is done on success: the
   *  route rebuild the commit triggers is the feedback. */
  async function duplicateTile(tileId: string): Promise<void> {
    const outcome = await commitPanelDuplication({
      mutateWorkspace: app.mutateWorkspace,
      onWorkspaceExternallyChanged: app.onWorkspaceExternallyChanged,
      genId: app.genId,
    }, { dashboardId: selectedDashboardId as string, tileId });
    const message = panelDuplicateMessage(outcome);
    if (message !== null) flashToast(message, { document: doc });
  }

  /**
   * #535 — the tile's widen action (edit mode only).
   *
   * Built unconditionally for an editable tile and then HIDDEN per style, the same
   * build-once-gate-later shape the grip and delete button use: the layout menu
   * changes the active style without rebuilding a single tile, so a style-dependent
   * button that only existed for the style at build time would be stale one press
   * later. `applyWidenMode` is what keeps it honest — see it for the gate itself.
   */
  function tileWidenAction(ts: ViewerTileState): HTMLButtonElement | null {
    if (readOnly) return null;
    return h('button', {
      class: 'dash-tile-widen', type: 'button', 'aria-label': 'Widen ' + ts.title,
      onclick: () => { widenTile(ts.tileId); },
    }, Icon.arrowsWide());
  }

  /** One widen press, from either the inline button or the menu row.
   *
   *  The style is re-read at CLICK time and the press refuses when there is none:
   *  a button hidden by `hidden` or by the container query is still clickable
   *  through a script or a stale accessibility tree, and the menu row for a
   *  single-column layout is disabled rather than absent. */
  function widenTile(tileId: string): void {
    const style = widenStyle;
    if (style === null) return;
    if (style === 'columns-2' || style === 'columns-3') {
      session.widenTemporaryTile(tileId);
      return;
    }
    runCommand({
      type: 'update-placement',
      tileId,
      style: 'grid',
      placement: nextPanelPlacement({ style, placement: storedPlacement(tileId) }),
    });
  }

  function ensureTileEl(ts: ViewerTileState): TileEl {
    const existing = tileEls.get(ts.tileId);
    if (existing) return existing;
    // The grip is edit-mode-only (`!readOnly`, a static per-load condition like
    // the drag wiring below) and grafana-grid-only in PRACTICE, but built
    // unconditionally once per tile and gated visually (CSS, ancestor
    // `.dash-gg-grid` scope) so a cached card carries no leftover affordance
    // while flow is active. It is a pointer-only drag affordance (no keyboard
    // reorder — a #332 non-goal), so it stays aria-hidden; the tile carries its
    // own accessible name. Dragging it starts a move with no modifier; the body
    // needs ⌘/Ctrl.
    const grip = !readOnly && !ts.isKpi
      ? h('span', { class: 'dash-gg-grip', title: 'Drag to move (or Command/Ctrl-drag the tile)', 'aria-hidden': 'true' })
      : null;
    // Two trailing controls at most, and they are mode-exclusive: Edit gets the
    // inline widen plus the `⋯` that holds duplicate/widen/expand/remove; View
    // gets #471's direct expand and no menu, because View has exactly one action
    // and a one-row menu is worse than the button it would hide.
    const openBtn = readOnly ? tileOpenAction(ts) : null;
    const widenBtn = tileWidenAction(ts);
    const menuBtn = readOnly ? null : tileMenuAction(ts);
    const headingName = h('span', { class: 'dash-tile-name', title: ts.title }, ts.title);
    const headingDescription = ts.description ? h('span', {
      class: 'dash-tile-desc', title: ts.description,
    }, ts.description) : null;
    const heading = h('div', { class: 'dash-tile-heading' }, headingName, headingDescription);
    const head = h('div', { class: 'dash-tile-head' }, grip, heading, widenBtn, openBtn, menuBtn);
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
    if (!readOnly) gestures.wireTileDrag(ts.tileId, card);
    if (resizeHandle) gestures.wireGridResize(ts.tileId, resizeHandle, card);
    const tileEl: TileEl = {
      card, headingName, headingDescription, body, foot,
      panelState: null, destroy: null, paintedRows: null, resizeHandle, widenBtn,
      menuBtn, kpiActions: null,
    };
    if (resizeHandle) applyResizeHandleMode(tileEl, isFixedWidthStyle(currentDashboardStyle));
    // A tile built mid-session (a duplicate, an import) has to arrive already
    // gated: the effect below only re-labels tiles it can find in `tileEls`, and
    // this one is added to that map on the next line.
    applyWidenMode(ts, tileEl);
    applyTileHeaderStyle(ts, tileEl);
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
          variableRefreshLiveEl.textContent = `Time range was not changed: ${formatted.error}`;
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
    host.replaceChildren(...kpiContent(ts));
  }

  /**
   * #471/#535/#544 — give a FLOW band member the tile actions its head cannot
   * carry.
   *
   * Flow-only, and called right after `renderKpiInto` repaints the member: the GRID
   * engine renders a KPI tile as a real card whose head carries these already, so
   * doing this there would give one tile two of each.
   *
   * ONE control, matching the head's own mode split: Edit gets the `⋯` (which is
   * where a band member's delete finally comes from — it had none under any flow
   * preset, because its `.dash-tile` card is never inserted into the DOM and its
   * head is therefore unreachable), View gets the direct expand. The menu's Widen
   * row is present but unavailable: a KPI band is a full-width flex stream that
   * ignores span entirely (`computeFlowLayout`), so there is no width to step.
   *
   * They are anchored INSIDE the first card rather than on the member host, because
   * `.dash-kpi-member` is `display: contents` and generates no box at all — an
   * absolutely-positioned child of it resolves against the page instead, which put
   * the button up in the Dashboard toolbar. That is the same reason the
   * `.is-nav-target` ring and the `.dash-drop-target` outline already reach through
   * to `> *`. Anchoring inside a card also leaves the drag geometry untouched:
   * `surfaceRect`/`hitRects` still read the member's card children, and the button
   * lives inside one of those boxes rather than beside them.
   *
   * The nodes are built ONCE per tile and MOVED into each repainted card, never
   * rebuilt with it. `renderKpiInto` replaces the card on every publish — including
   * every auto-refresh wave — and `openMenu` keys its one-menu-per-trigger registry
   * on the trigger ELEMENT while holding `aria-expanded` on it, so a rebuilt
   * trigger would strand an open menu over a dead node, with focus-restore aimed at
   * it and its CSS reveal hook lost. `appendChild` on an already-parented node
   * moves it, so the identity survives every repaint.
   *
   * They are the band member's OWN nodes rather than the head's: on a switch to the
   * grid engine this KPI tile becomes a real card and `renderKpiInto` writes into
   * `tileEl.body`, which would destroy anything borrowed out of the head.
   *
   * One per TILE, so it goes on the first card of a multi-field KPI — and on a
   * state card too, because a loading or failed tile is still query-backed, and
   * looking at (or copying) its query is exactly what a broken tile calls for.
   */
  function attachFlowKpiActions(host: HTMLElement, ts: ViewerTileState): void {
    const anchor = host.firstElementChild;
    const tileEl = tileEls.get(ts.tileId);
    // Built on the first attach only, and only for a tile that actually renders
    // inside a band. An anchor-less host has no reachable render path, so it is
    // tolerated in the same expression rather than given an early return no test
    // could execute.
    if (anchor && tileEl && !tileEl.kpiActions) {
      tileEl.kpiActions = {
        openBtn: readOnly ? tileOpenAction(ts) : null,
        menuBtn: readOnly ? null : tileMenuAction(ts),
      };
    }
    const actions = anchor ? tileEl?.kpiActions : null;
    if (actions?.openBtn) anchor!.appendChild(actions.openBtn);
    if (actions?.menuBtn) anchor!.appendChild(actions.menuBtn);
  }

  /** The KPI cards, or the one state card standing in for them (#316). */
  function kpiContent(ts: ViewerTileState): HTMLElement[] {
    if (ts.status !== 'ready') {
      const kind = ts.status === 'error' ? 'error' : ts.status === 'unfilled' ? 'unfilled' : 'loading';
      const message = ts.status === 'error' ? (ts.error || 'Error')
        : ts.status === 'unfilled' ? 'Enter a value for: ' + ts.unfilled.join(', ') : 'Loading…';
      return [h('div', {
        class: 'dash-kpi-state-card', role: kpiStateRole(kind), 'aria-label': `${ts.title}: ${message}`,
      }, message)];
    }
    const panel = (ts.panel || {}) as Record<string, unknown>;
    const resolved = resolvePanel(panel as Parameters<typeof resolvePanel>[0], {
      columns: ts.columns as Column[], rows: ts.rows as unknown[][],
      fieldConfig: panel.fieldConfig as never,
      serverVersion: state.serverVersion,
    });
    const { cards, errors } = renderKpiCards(resolved.kpi);
    return errors.length ? errors.map((e) => h('div', {
      class: 'dash-kpi-state-card', role: kpiStateRole(e.code === 'kpi-no-data' ? 'zero-data' : 'error'),
      'aria-label': `${ts.title}: ${e.message}`,
    }, e.message)) : cards;
  }

  // ── Grid reconciliation from the flow model ───────────────────────────────
  // #589 wave 1: the rebuild DECISION and the structural signature both come
  // from `planStructuralRebuild` now (`rebuild`/`structuralSig` below) — this
  // function only commits `memo.layoutSig` at the exact point the
  // pre-extraction code committed its own private `let`, immediately before
  // performing the same rebuild.
  function reconcileGrid(sview: DashboardViewState, layout: FlowLayoutModel, rebuild: boolean, structuralSig: string): void {
    const byId = new Map(sview.tiles.map((t) => [t.tileId, t]));
    for (const ts of sview.tiles) reconcileTile(ts);
    // Rebuild the row STRUCTURE only when the flow model changes (a reorder,
    // preset, or mobile flip) — moving stable tile cards, so charts are never
    // thrashed.
    if (rebuild) {
      memo.layoutSig = structuralSig;
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
            // #471's action is attached by `attachFlowKpiOpenAction` after the
            // content paint below, not here: this host is `display: contents`, so the
            // button has to live inside a CARD, and the cards do not exist yet.
            flowKpiHosts.set(member.tileId, host);
            if (!readOnly) gestures.wireTileDrag(member.tileId, host);
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
    // without a structural rebuild. #471's action is re-attached with it, because
    // that repaint replaces the very card it is anchored inside.
    for (const host of grid.querySelectorAll('.dash-kpi-member')) {
      const ts = byId.get((host as HTMLElement).dataset.tile || '');
      if (ts) { renderKpiInto(host as HTMLElement, ts); attachFlowKpiActions(host as HTMLElement, ts); }
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
      // (`ts.title` is never blank — the session trims the authored title (#476)
      // and falls back through query name → queryId → tile id when the tile has
      // no explicit title, or only whitespace for one.)
      tileEl.card.setAttribute('aria-label', ts.title);
    } else {
      tileEl.card.removeAttribute('role');
      tileEl.card.removeAttribute('aria-label');
    }
    if (ts.isKpi) { tileEl.foot.replaceChildren(); renderKpiInto(tileEl.body, ts); return; }
    paintTileBody(ts, tileEl);
  }

  // #589 wave 1: same shift as `reconcileGrid` above — the rebuild decision
  // (including the grid-structure-invalidation-revision force) and the
  // structural signature both come from `planStructuralRebuild`; this function
  // only commits `memo.gridSig` at the point the pre-extraction code
  // committed its own private `let`.
  function reconcileGrafanaGrid(
    sview: DashboardViewState, gridModel: GrafanaGridLayoutModel, rebuild: boolean, structuralSig: string,
    consumedGridInvalidationRev: number,
  ): void {
    const byId = new Map(sview.tiles.map((t) => [t.tileId, t]));
    for (const t of gridModel.tiles) {
      const ts = byId.get(t.tileId);
      if (ts) reconcileGridTile(ts);
    }
    currentGridColumns = gridModel.columns;
    // Rebuild the host STRUCTURE only when the grid model changes (a reorder,
    // resize, delete, responsive clamp, or membership change) — moving stable
    // tile cards, so charts/KPI content are never thrashed mid-drag.
    if (!rebuild) return;
    memo.gridSig = structuralSig;
    memo.consumedGridInvalidationRev = consumedGridInvalidationRev;
    grid.classList.toggle('is-report', gridModel.style === 'report');
    grid.classList.toggle('is-full', gridModel.style === 'full');
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
      if (gridModel.style === 'report') {
        tileEl.card.style.gridColumn = '1 / -1';
        tileEl.card.style.width = '75%';
        tileEl.card.style.marginInline = 'auto';
      } else {
        tileEl.card.style.gridColumn = `span ${t.span}`;
        tileEl.card.style.width = '';
        tileEl.card.style.marginInline = '';
      }
      tileEl.card.style.height = t.previewHeightPx === undefined
        ? gridHeightUnitsToPx(t.heightUnits) + 'px' : t.previewHeightPx + 'px';
      cards.push(tileEl.card);
    }
    grid.replaceChildren(...cards);
  }

  // ── Effect: reconcile on every publish (and on the mobile-breakpoint flip) ─
  // #589 wave 1: the decision logic that used to live in this callback as a
  // pile of private `let`s now lives in the pure `dashboard-repaint-plan.ts`
  // module — this effect's only job is to ask it what to do, one decision at
  // a time, and commit each returned signature at the exact point the
  // pre-extraction code committed its own `let`, interleaved with the real
  // side effect it guards. Deliberately never batch-assigned up front: if a
  // side effect throws, only the memo fields whose side effects actually ran
  // must have advanced (preserves the pre-extraction partial-failure
  // semantics).
  // #589 pass 2 (ChatGPT review finding 1): this effect calls the six
  // granular `plan*` functions (`planRepublishFlow`/`planBarRebuild`/
  // `planOptionsPush`/`planLabelRefresh`/`planPersist`/`planStructuralRebuild`)
  // ONE AT A TIME, in this exact order, applying each decision's side effect
  // immediately before computing the next — NEVER the batched
  // `dashboardRepaintPlan` (which computes every decision before returning
  // and would let a throw computing, say, the persist decision suppress the
  // bar-rebuild/options-push/label-refresh side effects that a batched call
  // had already decided but not yet applied). `dashboardRepaintPlan` remains
  // exported for direct unit testing only — see its module doc.
  // #589 wave 2: declared here, ABOVE the controller construction just below
  // (which needs it in scope for `invalidateGridStructure`'s closure) and
  // above the effect (whose first synchronous run reads it via the `plan*`
  // calls below) — same ordering constraint wave 1 already established for
  // `memo`/the effect: nothing here reads it before the effect runs, but
  // keeping the declaration textually first is the least surprising order
  // for both readers.
  let gridStructureInvalidationRev = 0;
  // #589 wave 2: constructed here, BEFORE the effect — `ensureTileEl` (used by
  // both `reconcileGrid`/`reconcileGrafanaGrid`, called from the effect's
  // first synchronous run) calls `gestures.wireTileDrag`/
  // `gestures.wireGridResize`, so the controller must already exist by then.
  const gestures: TileGestureController = createTileGestureController({
    document: doc,
    grid,
    runCommand,
    activeEngine: () => activeEngine,
    currentStyle: () => currentDashboardStyle,
    gridColumns: () => currentGridColumns,
    gridPlacement: (tileId) => gridPlacementByTile.get(tileId),
    measuredGridWidth,
    tileOrder: () => currentDoc.tiles.map((t) => t.id),
    // LIVE on every call (not just at gesture start) — re-reads `activeEngine`
    // fresh each time, exactly as the pre-extraction `renderedSurface` closure
    // did. See dashboard-tile-gestures.ts's module doc comment for why this is
    // deliberately a DIFFERENT read discipline than `activeEngine` above.
    renderedSurface: (id) => {
      const flowHost = activeEngine === 'flow' ? flowKpiHosts.get(id) : undefined;
      return flowHost ?? tileEls.get(id)!.card;
    },
    scrollHost: () => app.root!.querySelector('.dash-page') as HTMLElement | null,
    invalidateGridStructure: () => { gridStructureInvalidationRev += 1; },
  });
  installedTileGestures = gestures;
  const memo: RepaintMemo = seedRepaintMemo({ mobileNow: state.isMobile.value, view: session.state.value });
  const disposeDashboardEffect = effect(() => {
    const sview = session.state.value;
    const mobileNow = state.isMobile.value; // tracked so a breakpoint flip re-runs the effect
    // #589 ChatGPT review: commit `memo.mobile` FIRST, unconditionally, as the
    // literal first statement of this effect body (right after reading
    // `sview`/`mobileNow`) — matching pre-extraction exactly (`lastMobile =
    // mobileNow` was the absolute first statement in BOTH branches there,
    // before `barSig`/`optionsSig`/the persist bag were ever computed).
    // `priorMobile` is captured before the commit and handed to
    // `planRepublishFlow` in place of the (now-already-advanced)
    // `memo.mobile`, so its OWN comparison still sees the value mobile held
    // BEFORE this publish — exactly what it read when the commit happened
    // later. This way a throw anywhere later in this effect (e.g.
    // `dashboardPersistBag`'s `String()` over a pathological variable value,
    // inside `planPersist`) can never leave `memo.mobile` stale, the same
    // class of partial-failure bug already fixed for engine switches.
    const priorMobile = memo.mobile;
    memo.mobile = mobileNow;
    // Snapshotted once here — the exact value this publish's `plan*` calls
    // see — and threaded through to `reconcileGrafanaGrid`'s own commit
    // below, rather than that commit re-reading the live module-level
    // `gridStructureInvalidationRev` a second time. Nothing bumps the counter
    // synchronously mid-effect today, so the two reads are always equal in
    // practice, but committing the CONSUMED input (not whatever the live
    // counter happens to hold by the time the reconciler runs) is the
    // defensively-correct value regardless.
    const consumedGridInvalidationRev = gridStructureInvalidationRev;
    // A breakpoint flip after the last publish needs a fresh flow model —
    // republish through the viewer (recomputes it with the new mobile flag).
    // grafana-grid has no `mobile` concept of its own (its responsive
    // behavior is the `containerWidth`-driven effective-columns clamp below).
    if (planRepublishFlow({ mobile: priorMobile }, sview, mobileNow).republishFlow) {
      syncSessionDocument(currentDoc);
      return;
    }
    // #589 pass 2 (finding 1): each decision below is computed and APPLIED
    // immediately, before the next decision is even computed — never all
    // computed up front — so a throw computing a LATER decision (most
    // plausibly `planPersist`, see its doc comment) can never prevent an
    // EARLIER decision's side effect, already decided, from running. This
    // is the exact interleaving order the pre-extraction code used.

    // Rebuild the shared variable bar only on a STRUCTURAL change (activation or
    // committed value) — not on a bare status flip, not on tile progress ticks,
    // and (#447 phase 2) NOT when an option list arrives. `status` and
    // `optionsRev` are both deliberately EXCLUDED: they are updated in the
    // existing DOM in place, never by a rebuild. That preserves the invariant
    // that an unchanged republish never disturbs in-progress typing.
    const { rebuildBar, barSig } = planBarRebuild(memo, sview);
    if (rebuildBar) {
      memo.barSig = barSig;
      rebuildVariableBar(sview);
    }
    // #447 phase 2: push fresh option rows (and the batch's unavailable state)
    // into the selects the CURRENT bar already built. A rebuild above has just
    // taken the newest options along with it, so this only runs when the bar
    // survived — and only when option content or the batch verdict actually
    // moved, so an unchanged republish touches nothing.
    const { pushOptions, optionsSig } = planOptionsPush(memo, sview, rebuildBar);
    if (pushOptions) {
      const states: Record<string, VariableOptionsUpdate> = {};
      for (const f of sview.variableStates) {
        if (!f.configured) continue;
        states[f.parameter] = {
          options: f.options ?? [], error: f.optionsError, incomplete: f.optionsTruncated,
        };
      }
      currentVariableBar?.setVariableOptions(states);
    }
    memo.optionsSig = optionsSig;
    // #335: per-wave time-range label refresh. A rebuild above already
    // rebuilt every time-range control against this wave's `now` (assembled
    // into its `waveNowMs`); only a NON-rebuild publish whose wave `now`
    // advanced needs the closed labels re-resolved in place — a committed
    // relative range (`-1d` → `now`) moves per wave without any bar rebuild.
    const { refreshTimeRangeLabels, labelWaveNowMs } = planLabelRefresh(memo, sview, rebuildBar);
    if (refreshTimeRangeLabels) {
      currentVariableBar?.refreshTimeRangeLabels(sview.waveWallNowMs!);
    }
    memo.labelWaveNowMs = labelWaveNowMs;
    // #303: persist committed variable value/active into the isolated per-dashboard
    // store — isolated from the Workbench's asb:varValues/asb:filterActive keys.
    const { persistVars, persistBag, persistSig } = planPersist(memo, sview);
    if (persistVars) {
      memo.persistSig = persistSig;
      app.saveJSON(KEYS.dashFilters, writeDashboardVariableBag(loadJSON(KEYS.dashFilters, {}), currentDoc.id, persistBag));
    }
    tileCountLabel.textContent = sview.tileSearch.trim()
      ? `${sview.visibleTileCount} of ${sview.totalTileCount} tiles`
      : `${sview.totalTileCount} ${sview.totalTileCount === 1 ? 'tile' : 'tiles'}`;
    const noMatch = !!sview.tileSearch.trim() && sview.visibleTileCount === 0 && sview.totalTileCount > 0;
    empty.style.display = sview.totalTileCount === 0 ? '' : 'none';
    searchEmpty.style.display = noMatch ? '' : 'none';
    clearVariablesBtn.disabled = !sview.resettableVariableIds.some((id) => ordinaryVariableIds.includes(id));
    // Genuine dashboard-config diagnostics only (a tile whose presentation
    // could not resolve, etc.). Per-variable "required/invalid" badges were
    // dropped as noise (owner decision) — an unfilled required variable simply
    // leaves its target tiles in their normal unfilled state.
    variableDiagnosticsHost.replaceChildren(
      ...sview.diagnostics.map((d) => h('div', { class: 'dash-config-diagnostic is-error' }, d.message)),
      ...sview.timeRangeDiagnostics.map((d) => h('div', { class: 'dash-config-diagnostic is-error' }, d.message)),
      // #447 phase 2: the option batch's own failure. Rendered in the
      // variable-control area, as the issue requires — one banner for the
      // whole Dashboard, because a single malformed branch makes the combined
      // `UNION ALL` unrunnable and takes every option-backed control with it.
      // Severity-mapped like the others so it never reads as unstyled text.
      ...sview.optionDiagnostics.map((d) => h('div', {
        class: 'dash-config-diagnostic is-' + (d.severity ?? 'error'),
      }, d.message)),
    );
    // #291: on an engine switch, both structural sigs are reset here,
    // unconditionally, BEFORE the reconciler call below — matching the
    // pre-extraction code exactly. This is not redundant with the reconciler
    // committing `memo.layoutSig`/`memo.gridSig` itself at the point it
    // performs the rebuild: if the reconciler's own tile-processing loop
    // throws before reaching that commit, this eager reset is what's already
    // left `''` in the memo, so the NEXT publish's sig-mismatch check still
    // forces the rebuild it owes — independent of whether `engineSwitched`
    // has already been consumed by this (throwing) publish. Computed last,
    // right before it's applied, same as every other decision above (#589
    // pass 2 finding 1) — `planStructuralRebuild` doesn't own `memo`
    // mutation, so it can't perform this reset itself; only the caller can.
    const { engineSwitched, rebuildStructure, structuralSig } = planStructuralRebuild(memo, sview, consumedGridInvalidationRev);
    if (engineSwitched) { memo.layoutSig = ''; memo.gridSig = ''; memo.engineRendered = sview.layout.engine; }
    activeEngine = sview.layout.engine;
    // #535: the widen button's gate AND its label, resynced on every publish. Not
    // folded into the render-mode branch below (which only fires on a grid
    // tiles/full flip): a flow PRESET switch changes the gate without touching the
    // render mode, and a widen changes the label with neither of them moving.
    // Tiles this publish has not built yet are gated in `ensureTileEl` instead.
    widenStyle = widenStyleFor(sview);
    publishedTileIds = sview.tiles.map((ts) => ts.tileId);
    tileHeaderStyle = sview.style;
    for (const ts of sview.tiles) {
      const tileEl = tileEls.get(ts.tileId);
      if (tileEl) {
        applyWidenMode(ts, tileEl);
        applyTileHeaderStyle(ts, tileEl);
      }
    }
    // Keep the local render-mode mirror current from the published session
    // layout. View mode can now project flow styles too, so leaving a Full
    // grid must also clear the grid host's vertical-only resize affordance.
    const nextGridRenderMode = sview.style === 'full' ? 'full' : 'tiles';
    if (nextGridRenderMode !== gridRenderMode || currentDashboardStyle !== sview.style) {
      gridRenderMode = nextGridRenderMode;
      currentDashboardStyle = sview.style;
      layoutMenu.sync();
      grid.classList.toggle('is-full', gridRenderMode === 'full');
      for (const tileEl of tileEls.values()) {
        applyResizeHandleMode(tileEl, isFixedWidthStyle(sview.style));
      }
    }
    if (sview.layout.engine === 'grafana-grid') {
      reconcileGrafanaGrid(sview, sview.layout.grid, rebuildStructure, structuralSig, consumedGridInvalidationRev);
    } else {
      reconcileGrid(sview, sview.layout, rebuildStructure, structuralSig);
    }
    // #471: the tiles this publish just placed are what finally make the page tall
    // enough to hold a restored offset.
    applyOwedScroll();
    // #437: the freshness control's icon-only refresh swaps in the spinner
    // while running, and its tooltip/aria-label carry the last-updated time
    // the visible `.dash-updated` span shows — `aria-busy` covers the running
    // state for assistive tech. `sview.lastSuccessWallMs` (a real
    // `deps.wallNow()` value, only ever advanced by `refresh()` itself — see
    // the session) is stable across every OTHER publish (Search, layout
    // switch, a document sync), so formatting it directly here — rather than
    // reading `new Date()` at whatever moment this effect happens to run — is
    // what keeps the label from silently advancing on an unrelated publish
    // (#437 review). A wave that leaves a tile in `error` status never moves
    // `lastSuccessWallMs` forward, so a failure shows the label the LAST good
    // run left behind, not a fabricated new one.
    refreshBtn.disabled = sview.running;
    refreshBtn.setAttribute('aria-busy', sview.running ? 'true' : 'false');
    refreshBtn.replaceChildren(sview.running ? h('span', { class: 'spin' }, Icon.spinner()) : Icon.refresh());
    if (!sview.running) {
      const failed = sview.lastRefreshOutcome === 'failure';
      freshness.classList.toggle('is-error', failed);
      const time = sview.lastSuccessWallMs != null
        ? new Date(sview.lastSuccessWallMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        : null;
      updated.textContent = failed ? 'Refresh failed' : (time ?? '');
      const label = failed
        ? (time != null ? `Refresh failed. Last successfully updated at ${time}` : 'Refresh dashboard. Refresh failed.')
        : (time != null ? `Refresh dashboard. Last updated at ${time}` : 'Refresh dashboard');
      refreshBtn.title = label;
      refreshBtn.setAttribute('aria-label', label);
    }
  });

  // #437: one compact toolbar row — style/count/search/time variables, then the
  // freshness control, then View/Edit last. The separate #425 surface row (a
  // Back-to-query button plus a title) is gone.
  // #471: so is the generic Back-to-query control #426 had put back here. It named
  // no document — it was ordinary back-navigation occupying primary toolbar space —
  // and leaving a Dashboard is now either a per-tile act (`Open in Workbench`,
  // which says WHICH query it opens) or ordinary history/tree navigation. The
  // phone route #426 was protecting moved to the bottom nav, which no longer hides
  // itself on this surface (app-shell.ts + the `[data-surface="dashboard"]` mobile
  // rules): a Dashboard with no tiles at all would otherwise be a dead end.
  const primaryToolbar = h('div', { class: 'dash-toolbar dash-toolbar-primary' },
    layoutWrap,
    tileCount,
    tileSearch,
    timeVariableHost,
    h('span', { class: 'dash-toolbar-spacer' }),
    freshness,
    buildDashboardModeSwitch(app, target.mode));
  const hasOrdinaryVariables = ordinaryVariableIds.length > 0;
  const variableToolbar = h('div', {
    class: 'dash-toolbar dash-toolbar-variables',
    style: hasOrdinaryVariables ? undefined : { display: 'none' },
  }, ordinaryVariableHost, clearVariablesBtn);

  installedDashboardHost = target.host;
  const page = h('div', { class: 'dash-page' },
    h('div', { class: 'dash-topbar' },
      primaryToolbar, variableToolbar, variableRefreshLiveEl),
    variableDiagnosticsHost, empty, searchEmpty, grid);
  target.host.replaceChildren(page);
  scrollHost = page;
  applyOwedScroll();

  // Own every route-scoped resource in one teardown. An in-place Dashboard
  // rebuild must not leave Chart.js observers, signal effects, popovers, or
  // viewer requests attached to the replaced page.
  installedDashboardCleanup = () => {
    if (app.surfaceCommands === commandPort) app.surfaceCommands = null;
    currentVariableBar?.dispose();
    currentVariableBar = null;
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
  // the affordance. Torn down at the next renderDashboard (`disposeDashboardSurface`
  // → `gestures.dispose()`, see top of fn). #589 wave 2: the listeners
  // themselves now live inside `createTileGestureController`
  // (dashboard-tile-gestures.ts) — it derives its own window from
  // `deps.document.defaultView` and no-ops if that is null, the same fallback
  // `gridWin` gated on here before this extraction.
  if (!readOnly) gestures.installModifierCue();

  // #425 — deliver the navigation focus target at the deterministic point where
  // the node it names actually exists and is stable. Both are straight-line
  // sequencing off real completion signals, never a timeout.
  //
  // Arm the "user got there first" signal for the deferred (variable) delivery
  // below, before the wave starts. Capture phase, so a click that a control's own
  // handler stops still counts.
  let userInteracted = false;
  if (target.focus) {
    const noteInteraction = (): void => { userInteracted = true; };
    doc.addEventListener('pointerdown', noteInteraction, true);
    doc.addEventListener('keydown', noteInteraction, true);
    const previousCleanup = installedDashboardCleanup;
    installedDashboardCleanup = () => {
      doc.removeEventListener('pointerdown', noteInteraction, true);
      doc.removeEventListener('keydown', noteInteraction, true);
      previousCleanup?.();
    };
  }

  // A TILE card exists already: the viewer session seeds its state with every
  // tile at construction, so the render effect built each card synchronously
  // above, and the host is now in the document (without which `focus()` is a
  // silent no-op). The first publish only repaints tile BODIES, so focus on the
  // card — never on an inner heading, which is replaced on every publish —
  // survives it.
  if (target.focus?.kind === 'tile') applyNavigationFocus(target.focus);

  await session.start();
  // #426: from here on a variable's control is stable, so the command port
  // can deliver variable focus in place instead of reporting `pending`.
  waveSettled = true;

  // A VARIABLE field is not stable across that first publish: it changes the
  // bar's signature (committed values, active flags), and a rebuild replaces the
  // whole control — so focus set before `start()` would be dropped onto the
  // detached node. The resolved wave is this control's own render-complete signal.
  if (target.focus?.kind === 'variable') applyNavigationFocus(target.focus);

  // The RENDER-TIME delivery: one shot, and it defers to the user (see
  // `respectUserInteraction` below). Called only from the two narrowed call sites
  // above, so `focus` is never null here — no redundant guard.
  function applyNavigationFocus(focus: DashboardFocusTarget): void {
    // Non-destructive: the Dashboard is already open and stays open.
    if (deliverFocus(focus, { respectUserInteraction: true }) !== 'missing') return;
    flashToast(focus.kind === 'tile'
      ? 'That panel is no longer on this dashboard.'
      : 'That variable is no longer on this dashboard.', { document: doc });
  }

  /**
   * The ONE focus-delivery body, shared by the render-time one-shot above and the
   * command port's in-place navigation (#426) — so the tabindex/scroll/focus/
   * highlight sequence cannot drift into two copies that disagree.
   *
   * `respectUserInteraction` is the difference between them. The render-time
   * delivery must yield to a user who got there first: variable focus lands after
   * the opening wave resolves, which can take seconds — long enough to Tab into
   * another variable and start typing, and the variable bar's own rebuild already
   * restores focus to whatever field that was. Yanking it away mid-keystroke is
   * worse than not navigating at all. An in-place request IS the user's own click,
   * so it must NOT be suppressed by that flag — which the click itself just set.
   */
  function deliverFocus(
    focus: DashboardFocusTarget, { respectUserInteraction }: { respectUserInteraction: boolean },
  ): DashboardFocusOutcome {
    // Opening another Dashboard, returning to the Query surface, a workspace
    // switch, or sign-out all advance the renderer generation — a focus request
    // that belonged to a superseded render must not steal focus from the one now
    // on screen.
    if (!app.isSurfaceGenerationCurrent(surfaceGeneration)) return 'pending';
    if (respectUserInteraction && userInteracted) return 'ok';
    const node = focus.kind === 'tile' ? tileFocusTarget(focus.id) : variableFocusTarget(focus.id);
    if (!node) return 'missing';
    // #426: the member IS on this Dashboard, but its node is not in the document —
    // `tileEls` is a write-only cache, and the layout reconcilers rebuild the grid
    // from the SEARCH-FILTERED tile set, so a panel excluded by the Dashboard's own
    // tile search leaves a detached card behind. Focusing it would silently do
    // nothing at all while still reporting success. `pending` instead: the caller's
    // render transition rebuilds the surface (which resets that per-session search)
    // and delivers the focus for real.
    if (!node.isConnected) return 'pending';
    // A tile card and a variable field are both non-interactive containers, so
    // they need a programmatic-focus target; `-1` keeps them out of the Tab
    // order, leaving normal keyboard navigation untouched.
    if (!node.hasAttribute('tabindex')) node.setAttribute('tabindex', '-1');
    node.scrollIntoView({ block: 'nearest' });
    node.focus();
    highlightNavigationTarget(node);
    return 'ok';
  }

  /** Resolve a tile by its Dashboard-local TILE id — never the saved-query id it
   *  renders. A flow KPI band member has its own host element; every other tile
   *  is its cached card. */
  function tileFocusTarget(tileId: string): HTMLElement | null {
    return flowKpiHosts.get(tileId) ?? tileEls.get(tileId)?.card ?? null;
  }

  /** Resolve a variable by its exact NAME, within the selected Dashboard only.
   *  A variable's name IS its parameter, so there is no definition to look up
   *  first — the name goes straight to the built control. */
  function variableFocusTarget(variableName: string): HTMLElement | null {
    return currentVariableBar?.fieldElement(variableName) ?? null;
  }

  /** A temporary navigation highlight, IN ADDITION to the normal focus ring.
   *  Cleared after a bounded interval or on the next user interaction, whichever
   *  comes first, so it never lingers as permanent chrome. */
  function highlightNavigationTarget(node: HTMLElement): void {
    node.classList.add('is-nav-target');
    // `clear` runs at most once: it removes the timer AND both listeners that
    // could call it, and drops the module reference `disposeDashboardSurface`
    // would call it through — so no re-entrance guard is reachable.
    const clear = (): void => {
      node.classList.remove('is-nav-target');
      clearTimeout(timer);
      doc.removeEventListener('pointerdown', clear, true);
      doc.removeEventListener('keydown', clear, true);
      // Drop the module's reference too, so a cleared highlight stops retaining
      // this tile's whole subtree until the next render.
      if (installedNavHighlightClear === clear) installedNavHighlightClear = null;
    };
    const timer = setTimeout(clear, NAV_HIGHLIGHT_MS);
    doc.addEventListener('pointerdown', clear, true);
    doc.addEventListener('keydown', clear, true);
    // At most one highlight is live at a time: `disposeDashboardSurface` (which
    // every render calls first) already retired any prior render's.
    installedNavHighlightClear = clear;
  }
}
