// The persistent application frame (#425 follow-up prep) — the header slot,
// the sidebar (schema + saved/library panes and their splitters), and the
// mobile bottom-nav, plus the reactive effects that repaint them and the
// catalog bootstrap-load tail. Split out of `ui/workbench/workbench-shell.ts`'s
// former `mountWorkbenchShell` body so a later commit can keep this frame
// mounted while swapping only the workbench column for a Dashboard host —
// `queryHost`/`dashboardHost` below are the two swappable slots. Every line
// is moved byte-identically (ported originally from `app.ts`'s own
// `renderApp` — #276 Phase 5); see the individual comments for their
// original rationale, carried over unchanged.
//
// This module does NOT build the header itself: `ui/app.ts`'s `renderApp`
// calls `buildAppHeader(app)` and hands the result to `setHeader()` AFTER
// both this shell and the workbench shell are mounted. That means the
// `app.dom = {}` reset below still happens exactly once, before any header
// exists (satisfying every other module that reaches into `app.dom.*`
// directly) — but it also means the `libraryName`/`libraryDirty` effect
// below can observe a null `app.dom.libraryTitle` on its
// first, registration-time run, well before `setHeader` ever populates them.
// `renderLibraryTitle` (file-menu.ts) is already
// null-safe for exactly this reason; the effect re-runs (and paints for
// real) on the next `libraryName`/`libraryDirty` change, by which point
// `setHeader` has long since run.
//
// `deps.app` is kept for the same reasons `mountWorkbenchShell` keeps it
// (see that module's own header comment): the render-module pass-through
// (renderSchema/renderSavedHistory/renderLibraryTitle all
// still take the full `App`), and the `app.dom` reset + population other
// modules read `app.dom.*` off of directly.

import { h } from './dom.js';
import { Icon } from './icons.js';
import { MOBILE_BREAKPOINT_PX } from '../state.js';
import type { AppState as State } from '../state.js';
import { effect } from '@preact/signals-core';
import { renderSchema } from './schema.js';
import { buildSidebarUpper, databasesPanelDef, dashboardsPanelDef } from './sidebar-upper.js';
import { renderDashboardTree, cancelDashboardTreeClicks } from './dashboard-tree.js';
import { libraryPanelDef, historyPanelDef } from './saved-history.js';
import { buildSidePanelRegistry, renderSidePanelTabs, MOBILE_PANES } from './side-panel-registry.js';
import type { SidePanelRegistry } from './side-panel-registry.js';
import { sidePanelKeyFor, lowerIdForKey } from '../core/side-panels.js';
import type { SidePanelId, UpperPanelId, LowerPanelId } from '../core/side-panels.js';
import { renderLibraryTitle } from './file-menu.js';
import { applyConnectionStatus } from './app-header.js';
import type { DragCtx, DragRect, DragStartEvent, SplitterAxis } from './splitters.js';
import { startDrag, clampDockedInspectorWidth } from './splitters.js';
import type { App } from './app.types.js';
import type { SchemaCatalogService } from '../application/schema-catalog-service.js';
import type { AppPreferences, PreferenceKey } from '../application/app-preferences.js';

/** `mountAppShell`'s dependency bag. See this file's header comment for the
 *  `app` field's rationale — every other field is read directly by this
 *  shell's own logic, never through `app.*`. */
export interface AppShellDeps {
  /** Kept ONLY for: the render-module pass-through (renderSchema/
   *  renderSavedHistory/renderLibraryTitle), and the
   *  `app.dom` reset + population (other modules read `app.dom.*`
   *  directly — see the header comment). */
  app: App;
  root: Element | null;
  document: Document;
  state: State;
  catalog: Pick<SchemaCatalogService, 'loadSchema' | 'loadReference'>;
  prefs: Pick<AppPreferences, 'save'>;
  matchMedia: ((query: string) => MediaQueryList) | null;
  updateBanner(): void;
  startDrag: typeof startDrag;
}

/** Which main work surface owns the right-hand work area. */
export type SurfaceHostKind = 'query' | 'dashboard';

/** `mountAppShell`'s return value — the two swappable hosts, the header slot's
 *  setter, and the visibility switch between them. */
export interface AppShellHandle {
  /** Replace the header slot's content (each surface builds its own header). */
  setHeader(header: Element): void;
  /**
   * Stable host for in-shell authentication controls. It sits immediately
   * below the header and starts hidden, so lifecycle wiring can reveal it
   * without replacing either work surface.
   */
  authHost: HTMLElement;
  /** Host the workbench column (SQL editor + result/data drawer) mounts into. */
  queryHost: HTMLElement;
  /** Host a Dashboard mounts into. */
  dashboardHost: HTMLElement;
  /**
   * Expose exactly one host (#425). The hidden one keeps its DOM and its state —
   * that is what preserves editor contents, selection, scroll, the active tab,
   * the result view, and the result-drawer size across a Dashboard round trip —
   * but contributes no layout, so a Dashboard genuinely owns the whole
   * right-hand work area and no invisible result drawer consumes space.
   *
   * Also mirrored onto `.main-row[data-surface]` for the mobile rules, which drop
   * the sidebar for a full-bleed Dashboard and reduce the bottom nav to its Editor
   * entry — #471's route back, now that the Dashboard toolbar carries no generic
   * one.
   */
  showHost(kind: SurfaceHostKind): void;
  /** #587 — the side-panel registry (Databases/Dashboards/Library/History).
   *  Reachable via `app.shell?.sidePanels` from anywhere `app` is held —
   *  `saved-history.ts`'s `renderSavedHistory` compatibility export and the
   *  workbench's clean-run hook both address panels only through this. */
  sidePanels: SidePanelRegistry;
  dispose(): void;
}

/** The two fixed-width `.main-row` resize handles (`.col-resize` and
 *  `.inspector-resize`, styles.css) — reserved alongside the sidebar's own
 *  tracked width when dock-aware-clamping the right-inspector (#586 finding
 *  2a). A literal, not a measured rect: `getBoundingClientRect` returns all
 *  zeros under happy-dom (no real layout engine), so this mirrors the
 *  existing convention of tracking `sidebarPx` as a plain JS number rather
 *  than reading it back off the DOM — exact under both happy-dom and a real
 *  browser, unlike a rect measurement would be. */
const HANDLE_PX = 7;

/** Build the persistent frame (header slot, sidebar, mobile nav) and mount
 *  it. Ported byte-identically from `mountWorkbenchShell`'s former body
 *  (#276 Phase 5 → this split) — every ordering comment below is original. */
export function mountAppShell(deps: AppShellDeps): AppShellHandle {
  const {
    app, root, document: doc, state, catalog, prefs, matchMedia, updateBanner,
    startDrag: doStartDrag,
  } = deps;
  const win = doc.defaultView || window;
  doc.documentElement.setAttribute('data-theme', state.theme);
  doc.documentElement.setAttribute('data-density', state.density);

  app.dom = {};
  // The header itself is built by the caller (`ui/app.ts`'s `renderApp`) and
  // spliced in via `setHeader()` below — this slot is the stable mount point
  // so the header can be replaced without rebuilding the sidebar around it.
  const headerSlot = h('div', { class: 'app-header-slot' });
  const authHost = app.dom.authHost = h('div', {
    class: 'auth-host',
    hidden: true,
    role: 'region',
    'aria-label': 'Authentication required',
  });

  app.dom.schemaSearchInput = h('input', {
    type: 'text', placeholder: 'Search tables, columns…',
    oninput: (e: Event) => { state.schemaFilter.value = (e.target as HTMLInputElement).value; },
  });
  app.dom.schemaList = h('div', { class: 'schema-list' });
  // #426: the upper pane now hosts TWO roles. The Databases content is built here
  // exactly as before and handed to the role host, which only ever toggles
  // `hidden` — so schema search text/focus, expansion, lazily-loaded columns and
  // scroll all survive a trip through the Dashboards role by construction.
  const upper = buildSidebarUpper(app, [
    h('div', { class: 'schema-search' }, h('div', { class: 'search-wrap' }, Icon.search(), app.dom.schemaSearchInput)),
    app.dom.schemaList,
  ]);
  // #587 — the ONE registry: all four panels (Databases/Dashboards over the
  // upper pane's existing hosts; Library/History over fresh persistent hosts
  // this call builds). Adding a fifth panel means adding one more def here
  // plus that panel's own module — never touching this file's composition
  // below, `app-preferences.ts`, `state.ts`, or `workbench-session.ts`.
  const registry = buildSidePanelRegistry([
    databasesPanelDef(app, upper.databasesHost),
    dashboardsPanelDef(app, upper.dashboardsHost),
    libraryPanelDef(app),
    historyPanelDef(app),
  ]);
  app.dom.upperRoleTabs = h('div', { class: 'side-tabs upper-role-tabs' });
  const schemaPane = h('div', { class: 'side-pane schema-pane', style: { height: state.sideSplitPct + '%', flexShrink: '0', minHeight: '0' } },
    app.dom.upperRoleTabs, upper.databasesHost, upper.dashboardsHost);

  // The lower pane's tab row is a plain local element now (#587 — no AppDom
  // field: nothing outside this closure needs to address it by name; the
  // registry's own hosts are what `app.shell.sidePanels` exposes instead).
  const lowerTabsRow = h('div', { class: 'side-tabs' });
  const lowerHosts = registry.entries.filter((entry) => entry.pane === 'lower').map((entry) => entry.host);
  const savedPane = h('div', { class: 'side-pane saved-pane', style: { flex: '1', minHeight: '0' } }, lowerTabsRow, ...lowerHosts);

  const sidebar = h('div', { class: 'sidebar', style: { width: state.sidebarPx + 'px' } });
  // #586 — the docked right-inspector's own resize handle runs through this
  // SAME ctx now (a third axis alongside 'col'/'sideRow'), sized against the
  // live viewport width exactly like the former per-surface drawer handles
  // (drawer.ts's attachDrawerResize) were — only shell-owned now, one handle
  // for the one shared dock instead of one handle per surface.
  const rectFor = (axis: SplitterAxis): DragRect => {
    if (axis === 'sideRow') return sidebar.getBoundingClientRect();
    if (axis === 'rightInspector') {
      return {
        width: win.innerWidth,
        // #586 finding 2a: the dock-aware ceiling needs everything ELSE
        // `.main-row` gives space to before the inspector/centre split what
        // is left — `state.sidebarPx` (not a `getBoundingClientRect`
        // measurement: the sidebar's own width is already tracked exactly as
        // this same number, and a rect read returns all zeros under
        // happy-dom, see `HANDLE_PX`'s own comment) plus both fixed-width
        // resize handles.
        reservedPx: state.sidebarPx + HANDLE_PX * 2,
      };
    }
    return {};
  };
  const dragCtx: DragCtx = {
    state,
    rectFor,
    apply: (axis, value) => {
      if (axis === 'col') sidebar.style.width = value + 'px';
      else if (axis === 'rightInspector') inspectorHost.style.width = value + 'px';
      else schemaPane.style.height = value + '%';
    },
    save: (name, value) => {
      // #586 finding 1: a drag that ends NORMALLY (mouseup → splitters.ts's
      // own `onUp` → here) must retire the shell's cancel handle too — not
      // just an explicit mid-drag cancel — or a later `releaseInspector`
      // call on the next ordinary close (there is no drag in progress at
      // that point) would wrongly revert the width this same mouseup just
      // persisted. `cancelInspectorDrag` is declared further down (read here
      // only once this callback actually runs, well after that point).
      if (name === 'rightInspectorPx') cancelInspectorDrag = null;
      prefs.save(name as PreferenceKey, value);
    },
  };
  app.dom.sideSplit = h('div', { class: 'row-resize side-split', onmousedown: (e: DragStartEvent) => doStartDrag(e, 'sideRow', dragCtx) });
  // Mobile Tables view (#126): a segmented control at the top of the sidebar. CSS
  // hides it above the breakpoint; below it, it swaps which pane shows (the
  // sidebar's data-mobile-tab drives both the active-button style and the pane
  // visibility — no JS effect needed for the active state).
  //
  // #426 relabels the upper segment "Explore": that pane now hosts BOTH the
  // Databases and Dashboards roles, so "Schema" would name only half of what it
  // shows. The internal `data-seg`/`data-mobile-tab` values and the `.schema-pane`
  // selectors they key are deliberately unchanged — this is a label change, not a
  // restructuring of the mobile CSS (touch behaviour stays out of scope per #426).
  //
  // #587: driven from `MOBILE_PANES` (side-panel-registry.ts) — a SEPARATE
  // small table from the panel manifest, because this control picks a PANE
  // (which of the two persists to `mobileTab`, session-only), never a
  // specific panel; each segment's icon is the registry's OWN icon for that
  // pane's first panel, so it can never disagree with the desktop tab row.
  // Exact same labels/icons/`data-seg` values as before this phase — no
  // behaviour or visual change intended.
  app.dom.mobileSegmented = h('div', { class: 'mobile-segmented' },
    ...MOBILE_PANES.map((seg) => h('button', {
      class: 'mseg-btn', 'data-seg': seg.seg,
      onclick: () => { state.mobileTab.value = seg.seg; },
    }, registry.entries.find((entry) => entry.pane === seg.pane)!.icon(), h('span', null, seg.label))));
  sidebar.append(app.dom.mobileSegmented, schemaPane, app.dom.sideSplit, savedPane);
  const sideHandle = h('div', { class: 'col-resize', onmousedown: (e: DragStartEvent) => doStartDrag(e, 'col', dragCtx) });

  app.dom.banner = h('div', { class: 'auth-banner', style: { display: 'none' } });
  // The workbench column's mount point (#425 follow-up prep). Its sizing lives
  // in styles.css alongside `.dashboard-host` (static layout, not state-driven
  // like `sidebar.style.width`), including the `[hidden]` override a
  // `display: flex` class rule needs to actually hide.
  const queryHost = h('div', { class: 'query-host' });
  // The Dashboard host (#425) — a SIBLING of `queryHost`, so switching surfaces
  // toggles which of the two is exposed without rebuilding the sidebar (or the
  // query surface's own state) around them.
  const dashboardHost = h('div', { class: 'dashboard-host', hidden: true });
  // #586 — the docked right-inspector slot: a shell-owned layout SIBLING of
  // queryHost/dashboardHost (never a `position: fixed` overlay), replacing
  // three independent body-mounted overlays (the cell-detail drawer, the
  // rows viewer, the Reference pane). Content mounts here via
  // `inspector-host.ts`'s `showInInspector`/`releaseInspector` — this shell
  // owns only the host, the resize handle, and the fold (`hidden`) state;
  // which surface currently occupies it is that module's job, not this
  // one's. Starts folded (`hidden`) — nothing occupies it until a surface
  // opens. `inspectorResize` sits between the centre surface and the host,
  // like `sideHandle` does for the sidebar, driving the `'rightInspector'`
  // splitter axis against the SAME `rightInspectorPx` preference every
  // docked surface shares now (state.ts).
  // clampDockedInspectorWidth (not the raw persisted value, and not just
  // `clampDrawerWidth`'s flat 92vw): a monitor-to-monitor move, a resized
  // sidebar, or the DEFAULT preference itself can all leave `rightInspectorPx`
  // wider than this window can safely dock without starving `.query-host`/
  // `.dashboard-host` (#586 finding 2a) — the old per-surface drawers only
  // ever re-clamped against the live viewport at open time (attachDrawerResize),
  // never against dock siblings, because they had none. `inspectorDisplayWidth`
  // below is recomputed here at construction, again on every unfold
  // (`reclampInspectorWidth`, exposed via `app.dom` for `inspector-host.ts`'s
  // `showInInspector` to call — #586 finding 2b), and on a live window resize
  // (below) — it only ever writes the DOM style, never `state.rightInspectorPx`
  // itself, so the user's PERSISTED preference survives a trip through a
  // narrow viewport and back unchanged.
  const inspectorDisplayWidth = (): number => clampDockedInspectorWidth(
    state.rightInspectorPx, win.innerWidth, state.sidebarPx + HANDLE_PX * 2,
  );
  const inspectorHost = app.dom.inspectorHost = h('div', {
    class: 'inspector-host', hidden: true,
    style: { width: inspectorDisplayWidth() + 'px' },
  });
  // #586 finding 1: keep the drag's own cancel handle — `startDrag`
  // (splitters.ts) returns one for exactly this — so a surface that closes
  // mid-drag (Escape, sign-out, a surface switch, or a fresh occupant
  // replacing this one; every path funnels through `inspector-host.ts`'s
  // `releaseInspector`) can stop the live `window` mousemove/mouseup
  // listeners before they keep mutating a now-hidden host and a `mouseup`
  // persists an abandoned width. Mirrors `drawer.ts`'s `attachDrawerResize`/
  // `cancelActive` for the one surface that isn't docked, including
  // reverting the pre-drag width on cancel.
  let cancelInspectorDrag: (() => void) | null = null;
  const inspectorResize = app.dom.inspectorResize = h('div', {
    class: 'inspector-resize', hidden: true,
    onmousedown: (e: DragStartEvent) => {
      const startPx = state.rightInspectorPx;
      const stopDrag = doStartDrag(e, 'rightInspector', dragCtx);
      cancelInspectorDrag = () => {
        stopDrag();
        state.rightInspectorPx = startPx;
        cancelInspectorDrag = null;
      };
    },
  });
  // Stable wrapper (the `let` above is reassigned to `null` once a drag ends
  // normally) — this is the reference `app.dom.cancelInspectorDrag` keeps.
  const cancelActiveInspectorDrag = (): void => { cancelInspectorDrag?.(); };
  app.dom.cancelInspectorDrag = cancelActiveInspectorDrag;
  const reclampInspectorWidth = (): void => { inspectorHost.style.width = inspectorDisplayWidth() + 'px'; };
  app.dom.reclampInspectorWidth = reclampInspectorWidth;
  const mainRow = h('div', { class: 'main-row' }, sidebar, sideHandle, queryHost, dashboardHost, inspectorResize, inspectorHost);

  // Mobile bottom-tab nav (#126): one full-screen panel at a time. CSS hides it
  // above the breakpoint; below it, `mainRow[data-mobile-view]` (set by the
  // effect below) picks which of sidebar / editor / results fills the screen.
  // The Results tab carries a live badge (row count, or ● while a query streams).
  // `mobileBadge` crosses shells deliberately: this element is app-shell-owned,
  // but its text is written by a workbench-owned effect (`attachShell`'s
  // `setMobileBadge`, over in workbench-shell.ts) — the mobile nav and the
  // query results it summarizes are both singletons of the same render pass,
  // so the badge stays here rather than duplicating the mobile-nav markup.
  app.dom.mobileBadge = h('span', { class: 'mnav-badge' });
  const navBtn = (view: string, icon: SVGElement, label: string, extra?: HTMLElement): HTMLButtonElement => h('button', {
    class: 'mobile-nav-btn', 'data-view': view, onclick: () => {
      // #471: on the Dashboard surface this bar is a route OUT, not a panel
      // switcher — #425 hid it here precisely because its three values say nothing
      // about a Dashboard. #471 removed the Dashboard toolbar's generic
      // Back-to-query button, and a per-tile action cannot rescue a Dashboard with
      // no tiles, so the phone's route back lives here now: the CSS below leaves
      // only Editor visible on this surface, and pressing it returns to the
      // Workbench before selecting the panel — the same order
      // `openSavedQuery`/`openVariableTab` use.
      if (app.mainSurface.kind === 'dashboard') app.showQuerySurface();
      state.mobileView.value = view as 'tables' | 'editor' | 'results';
    },
  }, h('span', { class: 'mnav-ic' }, icon, extra || null), h('span', { class: 'mnav-label' }, label));
  app.dom.mobileNav = h('div', { class: 'mobile-nav' },
    navBtn('tables', Icon.database(), 'Tables'),
    navBtn('editor', Icon.code(), 'Editor'),
    navBtn('results', Icon.table2(), 'Results', app.dom.mobileBadge));

  root!.replaceChildren(headerSlot, authHost, app.dom.banner, mainRow, app.dom.mobileNav);

  // #586 finding 2b: a live viewport resize re-clamps the docked host's
  // DISPLAYED width too, not only a fold→unfold trip — otherwise an open
  // inspector on a shrinking window keeps whatever width it had, which can
  // starve the centre surface exactly like the unclamped case this whole
  // fix addresses. Harmless (and cheap: it's a single style write) to run
  // while folded as well, since the next unfold would recompute it anyway.
  const onWindowResize = (): void => { reclampInspectorWidth(); };
  win.addEventListener('resize', onWindowResize);

  const disposers: (() => void)[] = [];
  // Reactive repaint of the schema tree — replaces the scattered renderSchema()
  // calls: re-runs on schema load, load error, filter text, or expand/collapse.
  // Registered here (post-mount) so app.dom.schemaList already exists; the effect
  // also runs once now for the initial paint.
  disposers.push(effect(() => {
    state.schema.value;
    state.schemaError.value;
    state.schemaFilter.value;
    state.expanded.value;
    // Crossing the mobile breakpoint (#126) adds/removes each row's drag source
    // and hover title, so repaint the tree when isMobile flips.
    state.isMobile.value;
    renderSchema(app);
  }));
  // #426/#587: the upper pane's tab row — now the SAME generic renderer the
  // lower pane uses, reading label/icon/count straight from the registry
  // entries rather than a second hard-coded table. Both counts are reactive —
  // the Databases count tracks the schema load (and is omitted while it is
  // pending or failed), and the Dashboards count tracks the committed
  // collection through the tree's explicit invalidation signal, since
  // `currentWorkspace` is not itself a signal — both live inside each entry's
  // own `tabAdornment()` (sidebar-upper.ts), read here only through the
  // generic renderer. Also exposes exactly one role host via the registry's
  // pane-scoped `showPanel` (replacing #426's own `upper.showRole`).
  const upperEntries = registry.entries.filter((entry) => entry.pane === 'upper');
  const selectUpperPanel = (id: SidePanelId): void => { state.upperRole.value = id as UpperPanelId; };
  disposers.push(effect(() => {
    state.upperRole.value;
    state.schema.value;
    state.schemaError.value;
    state.dashboardTreeRevision.value;
    renderSidePanelTabs(app.dom.upperRoleTabs!, upperEntries, state.upperRole.value, selectUpperPanel);
    registry.showPanel(state.upperRole.value);
  }));
  disposers.push(effect(() => {
    // The ONE reactive input the tree has: every trigger #426 lists (workspace
    // projection or switch, a committed mutation, selected Dashboard/mode/member
    // navigation, an external refresh) bumps this. Expansion/search/scroll are
    // deliberately NOT reactive — the tree repaints itself directly for those.
    state.dashboardTreeRevision.value;
    state.upperRole.value;
    renderDashboardTree(app);
  }));
  // The schema/auth-failure banner reflects schemaError (a separate surface).
  disposers.push(effect(() => {
    state.schemaError.value;
    updateBanner();
  }));
  // Reactive repaint of the lower pane's tab row + active panel — re-runs when
  // the active panel changes (Library ↔ History) or the Library count might
  // have (see below). Data-driven repaints (savedQueries/history mutations)
  // still call the `renderSavedHistory` compatibility export directly until
  // those slices are signals too — it delegates to `refreshLowerPane` below
  // too (not the registry's own bare `refreshActiveSidePanels`), because the
  // Library tab's live count must repaint alongside the list on exactly the
  // same events (a star/delete/rename doesn't bump any signal this effect
  // depends on).
  //
  // #427 added the projection revision. Library membership is now a function of
  // `dashboards[]` — a query is in the Library exactly while no Dashboard member
  // references it — so a committed Dashboard change can move a query in or out of
  // this list without `savedQueries` changing at all. It is the same one signal
  // the Dashboard tree subscribes to, bumped from the single projection funnel.
  const lowerEntries = registry.entries.filter((entry) => entry.pane === 'lower');
  const selectLowerPanel = (id: SidePanelId): void => {
    const key = sidePanelKeyFor(id as LowerPanelId);
    prefs.save('sidePanel', key);
    state.sidePanel.value = key;
  };
  const refreshLowerPane = (): void => {
    const activeId = lowerIdForKey(state.sidePanel.value);
    renderSidePanelTabs(lowerTabsRow, lowerEntries, activeId, selectLowerPanel);
    registry.showPanel(activeId);
  };
  disposers.push(effect(() => {
    state.sidePanel.value;
    state.dashboardTreeRevision.value;
    refreshLowerPane();
  }));
  // Reactive repaint of the header library title (name + unsaved-changes dot):
  // re-runs when the name or dirty flag changes. The edit-mode toggle is driven
  // separately (editingLibrary is not a signal — file-menu.js renders it directly).
  disposers.push(effect(() => {
    state.libraryName.value;
    state.libraryDirty.value;
    renderLibraryTitle(app);
  }));
  // ConnectionSession is the single authority for the status chip. This
  // effect intentionally registers before the caller builds the header; its
  // first no-op subscribes to the signal, and setHeader below performs the
  // initial paint once the chip exists.
  disposers.push(effect(() => {
    app.conn.connection.value;
    applyConnectionStatus(app);
  }));
  // Mobile mode (#126): mirror the viewport width into `isMobile` (drives the
  // schema tree's drag/hover affordances, the results drop target, and the
  // auto-navigation in the action wrappers) via the injected matchMedia seam.
  // When the platform has no matchMedia the app stays in desktop JS mode — the
  // mobile CSS still applies, just without JS branching.
  const mq = matchMedia && matchMedia('(max-width: ' + MOBILE_BREAKPOINT_PX + 'px)');
  const onMobileChange = (e: MediaQueryListEvent): void => { state.isMobile.value = e.matches; };
  if (mq) {
    state.isMobile.value = mq.matches;
    mq.addEventListener('change', onMobileChange);
  }
  // Bottom-nav view switching: reflect the active mobile panel + Tables segmented
  // choice onto data-attributes the mobile CSS keys off (a no-op above the
  // breakpoint). Each runs once now for the initial paint.
  disposers.push(effect(() => { mainRow.dataset.mobileView = state.mobileView.value; }));
  disposers.push(effect(() => { sidebar.dataset.mobileTab = state.mobileTab.value; }));
  catalog.loadSchema();
  catalog.loadReference();

  return {
    setHeader: (header: Element) => {
      headerSlot.replaceChildren(header);
      applyConnectionStatus(app);
    },
    authHost,
    queryHost,
    dashboardHost,
    showHost: (kind) => {
      queryHost.hidden = kind !== 'query';
      dashboardHost.hidden = kind !== 'dashboard';
      mainRow.dataset.surface = kind;
    },
    // `refreshActiveSidePanels` is NOT the registry's own bare method here —
    // it wraps `refreshLowerPane` (declared above, alongside this file's own
    // lower-pane effect) so the compatibility `renderSavedHistory(app)` seam
    // (17 call sites, none of which bump a signal this shell's effects watch)
    // also repaints the Library tab's live count, not just the active body.
    sidePanels: { ...registry, refreshActiveSidePanels: refreshLowerPane },
    dispose: () => {
      // #426: a deferred single-click must not fire against a tree that is being
      // torn down (sign-out, a surface teardown) — the arbiter's timer outlives
      // this DOM otherwise.
      cancelDashboardTreeClicks(app);
      // #586 finding 1: a shell teardown mid-drag must stop the live
      // 'rightInspector' listeners too, same as `releaseInspector` does —
      // this handle can outlive `releaseInspector` ever running (e.g. the
      // whole shell tearing down around an open, still-being-dragged
      // inspector).
      cancelActiveInspectorDrag();
      win.removeEventListener('resize', onWindowResize);
      for (const dispose of disposers) dispose();
      mq?.removeEventListener('change', onMobileChange);
      // #587 — tear every panel down once (each panel's own `dispose`; none of
      // the four today does more than close over nothing, but a future panel
      // might own a real resource).
      registry.dispose();
    },
  };
}
