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
import { h, fixedAnchor } from './dom.js';
import { Icon as IconUntyped } from './icons.js';
import { renderResolvedPanel } from './panels.js';
import { resolvePanel } from '../core/panel-cfg.js';
import type { Column } from '../core/panel-cfg.js';
import type { ImageResultPayload } from '../core/png.js';
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
  DEFAULT_GRID_HEIGHT_UNITS, GRAFANA_GRID_MAX_COLUMNS, GRID_GAP_PX, contentBoxWidth, gridHeightUnitsToPx,
  snapGridHeight, snapGridSpan,
} from '../dashboard/layouts/grafana-grid-layout.js';
import type { GrafanaGridLayoutModel } from '../dashboard/layouts/grafana-grid-layout.js';
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
}

const valueString = (value: unknown): string =>
  (typeof value === 'string' ? value : value == null ? '' : String(value));

/** #291 review F4 / #318: `renderDashboard` can run more than once against the
 *  SAME window — `app.reloadDashboardRoute()` (app.ts) re-invokes it in place
 *  after an import-commit while already on `/dashboard` (file-menu.ts's Import
 *  flow). Module-level so a later call can fully tear down the PRIOR call's
 *  live state before installing its own: the resize listener (#291's own
 *  fix), the signals `effect()` (its own `dispose` — a second live effect
 *  would double-publish/double-paint over the new render's DOM), the
 *  `DashboardViewerSession` (in-flight requests, generations — `session.
 *  destroy()`), and every retained per-tile renderer (Chart.js instances,
 *  #307 image blob URLs — `destroyChart`). Without this, a repeated render
 *  leaks all of the above, each still closing over its own render's now-stale
 *  `session`/`currentDoc`/`containerWidthPx`. */
let installedDashboardDisposer: (() => void) | null = null;

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
  /** The last image identity `paintPanel` painted (#307) — `rows` for an
   *  Image tile is always an empty array (a query result never streams
   *  `{row}` lines), so the `rows`-reference repaint gate below can't tell
   *  a fresh Image result from an unchanged one on its own; this is checked
   *  alongside it. */
  paintedImage: ImageResultPayload | null;
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

/** #302 — the standalone Dashboard header's own "File" menu: a keyboard- and
 *  screen-reader-accessible dropdown owning Dashboard-scoped operations. Edit
 *  mode offers Export / Import / Open for viewing; a read-only (detached) view
 *  offers Export only (import + re-preview are edit-context operations). Every
 *  item delegates to an `app.actions.*` seam (dashboard.ts never reaches into
 *  app.ts). Esc/outside-click close and restore focus; arrows move between
 *  items. */
function buildDashboardFileMenu(app: DashboardApp, readOnly: boolean): HTMLElement {
  const doc = app.document;
  const btn = h('button', {
    class: 'dash-btn dash-file-btn', 'aria-haspopup': 'menu', 'aria-expanded': 'false',
    title: 'File — dashboard import/export', 'aria-label': 'Dashboard File menu',
  }, h('span', null, 'File'), Icon.arrow()) as HTMLButtonElement;
  let menu: HTMLElement | null = null;
  let overlay: HTMLElement | null = null;

  const close = (): void => {
    doc.removeEventListener('keydown', onKey, true);
    menu?.remove(); overlay?.remove();
    menu = null; overlay = null;
    btn.setAttribute('aria-expanded', 'false');
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') { e.preventDefault(); close(); btn.focus(); return; }
    if (!menu) return;
    const items = Array.from(menu.querySelectorAll<HTMLButtonElement>('.dash-fm-item'));
    const at = items.indexOf(doc.activeElement as HTMLButtonElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); items[(at + 1) % items.length]?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); items[(at - 1 + items.length) % items.length]?.focus(); }
  };

  const item = (label: string, onClick: () => void): HTMLButtonElement => h('button', {
    class: 'fm-item dash-fm-item', role: 'menuitem',
    onclick: () => { close(); onClick(); },
  }, h('span', { class: 'fm-label' }, label)) as HTMLButtonElement;

  const open = (): void => {
    overlay = h('div', { class: 'fm-overlay', onclick: close });
    const items = [item('Export Dashboard…', () => app.actions.exportDashboard())];
    if (!readOnly) {
      items.push(
        item('Import Dashboard…', () => app.actions.importDashboard()),
        item('Open for viewing…', () => app.actions.openDashboardForViewing()),
      );
    }
    menu = h('div', { class: 'file-menu dash-file-menu', role: 'menu' }, ...items);
    doc.body.appendChild(overlay);
    doc.body.appendChild(menu);
    const r = btn.getBoundingClientRect();
    const a = fixedAnchor(r) as { top: number; left: number };
    menu.style.position = 'fixed';
    menu.style.top = a.top + 'px';
    menu.style.left = a.left + 'px';
    btn.setAttribute('aria-expanded', 'true');
    doc.addEventListener('keydown', onKey, true);
    items[0].focus();
  };

  btn.onclick = () => { if (menu) { close(); btn.focus(); } else open(); };
  return btn;
}

/** Render the dashboard into `app.root`. */
export async function renderDashboard(app: DashboardApp): Promise<void> {
  const { document: doc, state } = app;
  doc.documentElement.setAttribute('data-theme', state.theme);
  doc.documentElement.setAttribute('data-density', state.density);
  app.dom = {};

  // #291 review F4 / #318: tear down a PRIOR renderDashboard call's live state
  // on this window before this call builds its own (see
  // `installedDashboardDisposer`'s own doc comment above).
  if (installedDashboardDisposer) {
    installedDashboardDisposer();
    installedDashboardDisposer = null;
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
      layout: { type: 'flow', version: 1, preset: 'full-width', items: {} }, filters: [], tiles: [],
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
  // 2026-07-18 owner override: moved off the filter toolbar and into the top
  // header row (right after the tile-count chip) so the toolbar's whole width
  // is available for filters; a compact select needs far less room than the
  // four-button segmented control it replaces.
  const layoutSelect = buildLayoutSelect([
    ['full-width', 'Full width', 'One tile per row using all available width'],
    ['report', 'Report', 'One centered, taller tile per row'],
    ['columns-2', '2 columns', 'Arrange tiles in two columns'],
    ['columns-3', '3 columns', 'Arrange tiles in three columns'],
    ['grafana-grid', 'Grafana grid', 'A dense, rowless tile grid (Grafana-style)'],
  ], () => (currentDoc.layout.type === 'grafana-grid'
    ? 'grafana-grid'
    : typeof currentDoc.layout.preset === 'string' ? currentDoc.layout.preset : 'full-width'),
  (value) => {
    // #291: picking "Grafana grid" switches ENGINE — change-layout seeds/
    // derives grid placements from the current flow layout and snapshots it
    // as the fallback (Wave 2's own contract; the UI never manages the
    // fallback itself). Picking a flow preset while grid is active restores
    // that fallback (bare `{type:'flow',version:1,preset}` — grid carries no
    // flow `items`/`preset` shape to spread). Picking a flow preset while
    // flow is ALREADY active keeps the existing spread of `currentDoc.layout`
    // (preserving per-tile `items`) — only `preset` changes.
    if (value === 'grafana-grid') {
      runCommand({ type: 'change-layout', layout: { type: 'grafana-grid', version: 1 } as DashboardLayoutDocumentV1 });
    } else if (currentDoc.layout.type === 'grafana-grid') {
      runCommand({ type: 'change-layout', layout: { type: 'flow', version: 1, preset: value as FlowPresetV1 } });
    } else {
      runCommand({ type: 'change-layout', layout: { ...currentDoc.layout, preset: value as FlowPresetV1 } });
    }
  },
  'Dashboard layout');
  const layoutWrap = h('div', { class: 'dash-layout-wrap' }, layoutSelect.el);

  // #302: the Dashboard page's own resource-scoped File menu (import/export +
  // open-for-viewing). #288: a read-only (detached view) tab hides the layout
  // switcher — layout editing is an edit-mode-only affordance.
  const fileMenuBtn = buildDashboardFileMenu(app, readOnly);
  const header = h('div', { class: 'dash-header' },
    h('a', {
      class: 'dash-back', href: app.conn.basePath || '/sql', title: 'Back to SQL Browser', 'aria-label': 'Back to SQL Browser',
    }, Icon.arrow(), h('span', { class: 'dash-back-label' }, 'SQL Browser')),
    h('div', { class: 'dash-title' }, currentDoc.title || state.libraryName.value),
    tileCount, readOnly ? null : layoutWrap,
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
  let dragTileId: string | null = null;
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
  const gridPlacementByTile = new Map<string, { span: number; heightUnits: number; colStart: number }>();
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
  function wireGridResize(tileId: string, handle: HTMLElement, card: HTMLElement): void {
    handle.addEventListener('pointerdown', (event: Event) => {
      if (activeEngine !== 'grafana-grid') return;
      const start = event as PointerEvent;
      start.preventDefault();
      start.stopPropagation(); // never let the resize handle start a card drag
      const columns = Math.max(1, currentGridColumns);
      const placement = gridPlacementByTile.get(tileId);
      const colStart = placement ? placement.colStart : 0;
      // The columns actually available at this tile's pinned start — the
      // clamp ceiling for both the live preview and the persisted span.
      const maxSpan = Math.max(1, columns - colStart);
      let curSpan = Math.min(placement ? placement.span : columns, maxSpan);
      let curHeight = placement ? placement.heightUnits : DEFAULT_GRID_HEIGHT_UNITS;
      card.style.gridColumn = `${colStart + 1} / span ${curSpan}`;
      const rect = card.getBoundingClientRect();
      const colWidthPx = (measuredGridWidth() - GRID_GAP_PX * (columns - 1)) / columns;
      card.classList.add('dash-gg-resizing');
      const win = doc.defaultView || window;
      const move = (ev: PointerEvent): void => {
        const span = snapGridSpan(ev.clientX - rect.left, colWidthPx, GRID_GAP_PX, maxSpan);
        const height = snapGridHeight(ev.clientY - rect.top);
        if (span !== curSpan) { curSpan = span; card.style.gridColumn = `${colStart + 1} / span ${curSpan}`; }
        if (height !== curHeight) { curHeight = height; setGridHeightPx(card, height); }
      };
      const up = (): void => {
        card.classList.remove('dash-gg-resizing');
        win.removeEventListener('pointermove', move as EventListener);
        win.removeEventListener('pointerup', up);
        runCommand({ type: 'update-placement', tileId, placement: { span: curSpan, height: curHeight } });
      };
      win.addEventListener('pointermove', move as EventListener);
      win.addEventListener('pointerup', up);
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
    const grip = !readOnly ? h('span', { class: 'dash-gg-grip', title: 'Drag to reorder', 'aria-hidden': 'true' }) : null;
    const delBtn = !readOnly ? h('button', {
      class: 'dash-gg-del', title: 'Remove tile', 'aria-label': 'Remove ' + ts.title + ' from the dashboard',
      onclick: () => { if (activeEngine === 'grafana-grid') runCommand({ type: 'remove-tile', tileId: ts.tileId }); },
    }, Icon.trash()) : null;
    const head = h('div', { class: 'dash-tile-head' }, grip, h('span', { class: 'dash-tile-name', title: ts.title }, ts.title), delBtn);
    const body = h('div', { class: 'dash-tile-body' });
    const foot = h('div', { class: 'dash-tile-foot' });
    const resizeHandle = !readOnly ? h('div', { class: 'dash-gg-resize', title: 'Resize' }) : null;
    // #316: a static, per-load mode class (view mode never toggles mid-session
    // — `readOnly` is resolved once above, before any tile is built) — CSS
    // scopes the frameless-KPI-in-view-mode treatment to
    // `.dash-gg-grid .dash-gg-tile.is-kpi.is-view` (styles.css), so it never
    // touches a non-KPI tile or a flow-rendered card (flow never adds
    // `.dash-gg-tile`/`.is-kpi` — its own KPI tiles render inside the band).
    const card = h('div', { class: 'dash-tile' + (readOnly ? ' is-view' : ''), draggable: String(!readOnly) }, head, body, foot, resizeHandle);
    // Pointer drag is the sole reorder mechanism (#286 owner override, reused
    // verbatim for grafana-grid@1 tiles by #291 — same move-tile command, no
    // engine branching needed): a drop persists the new dashboard.tiles[]
    // order. A read-only (detached view) dashboard is not reorderable (#288).
    if (!readOnly) {
      card.addEventListener('dragstart', () => { dragTileId = ts.tileId; });
      card.addEventListener('dragover', (event) => event.preventDefault());
      card.addEventListener('drop', (event) => {
        event.preventDefault();
        if (dragTileId && dragTileId !== ts.tileId) {
          runCommand({ type: 'move-tile', tileId: dragTileId, toIndex: currentDoc.tiles.map((t) => t.id).indexOf(ts.tileId) });
        }
        dragTileId = null;
      });
    }
    if (resizeHandle) wireGridResize(ts.tileId, resizeHandle, card);
    const tileEl: TileEl = { card, body, foot, panelState: null, destroy: null, paintedRows: null, paintedImage: null };
    tileEls.set(ts.tileId, tileEl);
    return tileEl;
  }

  function destroyChart(tileEl: TileEl): void { if (tileEl.destroy) { tileEl.destroy(); tileEl.destroy = null; } }

  // #318: a tile removed from the document (remove-tile, or a syncDocument
  // whose new tile set drops one) stops appearing in `sview.tiles` — the
  // session itself drops the runtime record (`syncDocument`) — but its
  // `tileEls` entry, and any live chart/image renderer it holds, were never
  // cleaned up: `reconcileGrid`/`reconcileGrafanaGrid` only ever ADD/update
  // cards for tiles that are still present, so a stale entry just sat in the
  // map forever (leaking a Chart.js instance or, since #307, an image blob
  // URL). Called once per publish, before either engine reconciles, so both
  // paths share the same prune regardless of which is active.
  function pruneRemovedTiles(sview: DashboardViewState): void {
    if (!tileEls.size) return;
    const liveIds = new Set(sview.tiles.map((t) => t.tileId));
    for (const [tileId, tileEl] of tileEls) {
      if (liveIds.has(tileId)) continue;
      destroyChart(tileEl);
      tileEl.card.remove();
      tileEls.delete(tileId);
      gridPlacementByTile.delete(tileId);
    }
  }

  // Paint an ordinary (non-KPI) tile's result once per new result. Only ever
  // called for a 'ready' tile, so columns/rows/meta/panel are all present.
  function paintPanel(ts: ViewerTileState, tileEl: TileEl): void {
    // The rows-reference gate alone can't detect a fresh Image result (its
    // `rows` is always an empty array — see `paintedImage`'s doc comment), so
    // an Image tile is also gated on `ts.image` identity; this ALSO means a
    // tile-body resize (CSS-only fit, no `syncDocument`/re-run) never repaints
    // an Image tile, since neither identity changes.
    if (ts.rows === tileEl.paintedRows && ts.image === tileEl.paintedImage) return;
    destroyChart(tileEl); // also revokes the previously painted Image's object URL (#307)
    const panel = (ts.panel || {}) as Record<string, unknown>;
    const columns = ts.columns as Column[];
    const rows = ts.rows as unknown[][];
    const resolved = resolvePanel(panel as Parameters<typeof resolvePanel>[0], {
      columns, rows, fieldConfig: panel.fieldConfig as never, serverVersion: state.serverVersion,
    });
    tileEl.card.classList.toggle('is-kpi', resolved.cfg.type === 'kpi');
    const key = JSON.stringify(columns.map((c) => c.name + ':' + c.type));
    if (!tileEl.panelState || tileEl.panelState.key !== key) tileEl.panelState = { key };
    const result = { columns, rows, image: ts.image } as Parameters<typeof renderResolvedPanel>[2];
    const out = renderResolvedPanel(app as unknown as App, resolved, result, {
      surface: 'dashboard', state: tileEl.panelState, rerender: () => paintForce(ts, tileEl),
      readonly: true, cap: DASH_TABLE_DISPLAY_CAP, onCell: () => {}, title: ts.title,
    });
    tileEl.destroy = out.destroy || null;
    tileEl.body.replaceChildren(out.node);
    tileEl.foot.replaceChildren(...tileFooter(ts.meta as NonNullable<ViewerTileState['meta']>));
    tileEl.paintedRows = ts.rows;
    tileEl.paintedImage = ts.image;
  }

  // A local re-paint (header-click sort) — force even when the rows/image ref
  // is unchanged (the sort mutated the panel state, not the data).
  function paintForce(ts: ViewerTileState, tileEl: TileEl): void {
    tileEl.paintedRows = null;
    tileEl.paintedImage = null;
    paintPanel(ts, tileEl);
  }

  // The ordinary (non-KPI) tile body: painted result, or an error/unfilled/
  // loading state card — shared by BOTH engines' reconciliation (flow's
  // `reconcileTile` skips a KPI tile entirely — it renders inside the KPI
  // band instead; grid's `reconcileGridTile` renders a KPI tile's cards
  // inline via `renderKpiInto` instead of calling this).
  function paintTileBody(ts: ViewerTileState, tileEl: TileEl): void {
    if (ts.status === 'ready') { paintPanel(ts, tileEl); return; }
    destroyChart(tileEl);
    tileEl.paintedRows = null;
    tileEl.paintedImage = null;
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
      grid.classList.remove('dash-gg-grid');
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
    grid.classList.remove('is-report', 'is-wide'); // flow-only preset modifiers
    grid.classList.add('dash-gg-grid');
    grid.style.gridTemplateColumns = `repeat(${gridModel.columns}, 1fr)`;
    const cards: HTMLElement[] = [];
    for (const t of gridModel.tiles) {
      const tileEl = tileEls.get(t.tileId);
      if (!tileEl) continue;
      gridPlacementByTile.set(t.tileId, { span: t.span, heightUnits: t.heightUnits, colStart: t.colStart });
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
  // `is-report`/`is-wide` on a grid switch) instead of a coincidental sig
  // match silently skipping that cleanup.
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
  const disposeEffect = effect(() => {
    const sview = session.state.value;
    pruneRemovedTiles(sview);
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
  // #291 review F4 / #318: unlike a repeatedly-opened modal (e.g. the EXPLAIN
  // graph overlay), the Dashboard page is normally a single full-page
  // navigation — BUT `renderDashboard` can still run again against this SAME
  // window in place (`app.reloadDashboardRoute()`, app.ts, re-invoked from
  // file-menu.ts's Import flow while already on `/dashboard`). This module
  // never disconnects/observes page teardown, so everything this render
  // installed/started is torn down at the START of the NEXT `renderDashboard`
  // call instead (see `installedDashboardDisposer`'s doc comment above)
  // rather than relying on the page itself never rendering twice.
  const gridWin = doc.defaultView;
  let removeGridResizeListener: (() => void) | null = null;
  if (gridWin) {
    const onGridResize = (): void => {
      if (activeEngine !== 'grafana-grid') return;
      const prevWidth = containerWidthPx;
      measureGridWidth();
      if (containerWidthPx !== prevWidth) session.syncDocument(currentDoc);
    };
    gridWin.addEventListener('resize', onGridResize);
    removeGridResizeListener = () => gridWin.removeEventListener('resize', onGridResize);
  }

  // #318: the ONE disposer for everything this render started — found and run
  // by the NEXT same-window `renderDashboard` call (above), so re-entry never
  // leaks the previous call's effect, session, tile renderers, or listener.
  installedDashboardDisposer = () => {
    disposeEffect();
    session.destroy();
    for (const tileEl of tileEls.values()) destroyChart(tileEl);
    removeGridResizeListener?.();
  };

  await session.start();
}
