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
// (renderSchema/renderLowerTabs/renderLibrarySection/renderLibraryTitle all
// still take the full `App`), and the `app.dom` reset + population other
// modules read `app.dom.*` off of directly.

import { h } from './dom.js';
import { Icon } from './icons.js';
import { MOBILE_BREAKPOINT_PX } from '../state.js';
import type { AppState as State } from '../state.js';
import { effect } from '@preact/signals-core';
import { renderSchema } from './schema.js';
import { buildSidebarUpper, renderUpperRoleTabs } from './sidebar-upper.js';
import { buildNavSectionRegistry, sectionForSidePanelKey, NAV_SECTION_META } from './nav-sections.js';
import type { NavSectionPane } from './nav-sections.js';
import { renderDashboardTree, cancelDashboardTreeClicks } from './dashboard-tree.js';
import { renderLowerTabs, renderLibrarySection, renderHistorySection } from './saved-history.js';
import { renderLibraryTitle } from './file-menu.js';
import { applyConnectionStatus } from './app-header.js';
import type { DragCtx, DragRect, DragStartEvent } from './splitters.js';
import { startDrag } from './splitters.js';
import { buildLeftRail } from './left-rail.js';
import { mountLeftNavSeparator } from './left-nav-separator.js';
import {
  clampLeftNavigationToMaximumTotal, effectiveLeftNavigationLayout, LEFT_CENTRE_MIN_PX,
} from '../core/left-nav-layout.js';
import type { LeftNavigationLayout } from '../core/left-nav-layout.js';
import { readLeftNavigationLayout } from '../application/left-nav.js';
import type { App } from './app.types.js';
import type { SchemaCatalogService } from '../application/schema-catalog-service.js';
import type { AppPreferences, PreferenceKey } from '../application/app-preferences.js';

/** #487 phase 3 — the stable DOM ids the rail's four launchers address via
 *  `aria-controls`, and the focused drawer's own title via `aria-labelledby`.
 *  Defined once here since this module is the sole place that builds both the
 *  sidebar/drawer element and the rail that points at it. */
const LEFT_NAV_DRAWER_ID = 'left-nav-drawer';
const LEFT_NAV_TITLE_ID = 'left-nav-title';
/** `.col-resize { width: 7px; }` in styles.css — the resize separator's own
 *  width, which the navigation's total pixel budget must also exclude
 *  (`getMaxNavigationTotalPx` below). */
const LEFT_NAV_SEPARATOR_WIDTH_PX = 7;

/** `mountAppShell`'s dependency bag. See this file's header comment for the
 *  `app` field's rationale — every other field is read directly by this
 *  shell's own logic, never through `app.*`. */
export interface AppShellDeps {
  /** Kept ONLY for: the render-module pass-through (renderSchema/
   *  renderLowerTabs/renderLibrarySection/renderLibraryTitle), and the
   *  `app.dom` reset + population (other modules read `app.dom.*`
   *  directly — see the header comment). */
  app: App;
  root: Element | null;
  document: Document;
  state: State;
  catalog: Pick<SchemaCatalogService, 'loadSchema' | 'loadReference'>;
  prefs: Pick<AppPreferences, 'save'>;
  matchMedia: ((query: string) => MediaQueryList) | null;
  /**
   * #487 phase 3 — an injected shell-width observer seam, mirroring the
   * `matchMedia` seam above: a raw `ResizeObserver` construction here would add
   * an untestable branch under this file's 100/95/90/100 coverage floor. When
   * provided, called ONCE with `.main-row` and a callback that re-derives and
   * re-applies the effective left-navigation layout whenever the row's own
   * content width changes — keeping the centre-content minimum honored across
   * a plain browser-window resize, not only a separator drag. Returns a
   * disposer this shell's own `dispose()` calls.
   *
   * Omitted (the default in every test and any caller that doesn't pass one):
   * no live-resize reclamping runs, nothing throws, and the rest of the shell
   * works normally — the same "feature simply doesn't run" contract
   * `matchMedia: null` already has here.
   */
  observeElementWidth?: (element: Element, callback: (widthPx: number) => void) => () => void;
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
  dispose(): void;
}

/** Build the persistent frame (header slot, sidebar, mobile nav) and mount
 *  it. Ported byte-identically from `mountWorkbenchShell`'s former body
 *  (#276 Phase 5 → this split) — every ordering comment below is original. */
export function mountAppShell(deps: AppShellDeps): AppShellHandle {
  const {
    app, root, document: doc, state, catalog, prefs, matchMedia, updateBanner,
    startDrag: doStartDrag, observeElementWidth,
  } = deps;
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
  // #426: the upper pane hosts TWO sections. The Databases content is built here
  // exactly as before and handed to the section host, which only ever toggles
  // `hidden` — so schema search text/focus, expansion, lazily-loaded columns and
  // scroll all survive a trip through the Dashboards section by construction.
  //
  // #487 phase 2: both panes are now composed out of the SAME registry, which owns
  // all four sections' persistent hosts, their labels and their icons. This shell
  // no longer builds the lower pane's search/list elements, and it does not name
  // which sections belong to which pane — it asks the registry, which is the only
  // way the claim stays true when phase 3 adds a third container. Phase 3's rail
  // and focused drawer address exactly the same four hosts, which is what makes a
  // mode change a MOVE of live DOM rather than a rebuild.
  const registry = buildNavSectionRegistry(app, buildSidebarUpper(app, [
    h('div', { class: 'schema-search' }, h('div', { class: 'search-wrap' }, Icon.search(), app.dom.schemaSearchInput)),
    app.dom.schemaList,
  ]));
  // `entries` is in rail order, so each pane's hosts come out in the order its
  // switcher presents them (Databases | Dashboards above, Library | History below).
  const hostsIn = (pane: NavSectionPane): HTMLElement[] =>
    registry.entries.filter((entry) => entry.pane === pane).map((entry) => entry.host);
  const schemaPane = h('div', { class: 'side-pane schema-pane', style: { height: state.sideSplitPct + '%', flexShrink: '0', minHeight: '0' } },
    app.dom.upperRoleTabs!, ...hostsIn('upper'));

  app.dom.savedTabsRow = h('div', { class: 'side-tabs' });
  const savedPane = h('div', { class: 'side-pane saved-pane', style: { flex: '1', minHeight: '0' } },
    app.dom.savedTabsRow, ...hostsIn('lower'));

  // #487 phase 3: `.sidebar` is RE-PRESENTED, never moved or duplicated — the
  // same element renders as the wide two-pane sidebar OR the rail's focused
  // drawer depending on `data-nav-mode` (`applyEffectiveLeftNavigationLayout`
  // below is the sole writer of that attribute and everything it implies). The
  // stable `id` is what the rail's four launchers address via
  // `aria-controls` — `buildLeftRail`'s `drawerElementId` below must name this
  // exact string.
  const sidebar = h('div', { class: 'sidebar', id: LEFT_NAV_DRAWER_ID, style: { width: state.sidebarPx + 'px' } });
  // The focused drawer's own heading — shown ONLY in drawer mode (one section,
  // one name), so `.sidebar`'s `aria-labelledby` only ever points at it while
  // drawer mode is active (see `applyEffectiveLeftNavigationLayout`).
  const leftNavTitle = app.dom.leftNavTitle = h('div', { class: 'left-nav-title', id: LEFT_NAV_TITLE_ID, hidden: true });
  // Only 'sideRow' (schema/saved split) ever runs through this ctx — the
  // editor/results 'row' splitter is workbench-shell's own, over elements this
  // shell has no business touching (a Dashboard-only surface may one day mount
  // here with neither `editorRegion` nor `resultsRegion` present at all). The
  // wide sidebar's OWN width used to be this ctx's 'col' axis (with its own
  // `rectFor` branch, unused for 'col'); #487 phase 3 moved that gesture
  // entirely to `left-nav-separator.ts`, which this shell mounts onto
  // `sideHandle` below instead of wiring it through `startDrag` — so `rectFor`
  // no longer needs to branch on `axis` at all, it only ever measures the
  // sidebar for the one axis this ctx still serves.
  const rectFor = (): DragRect => sidebar.getBoundingClientRect();
  const dragCtx: DragCtx = {
    state,
    rectFor,
    apply: (_axis, value) => { schemaPane.style.height = value + '%'; },
    save: (name, value) => prefs.save(name as PreferenceKey, value),
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
  app.dom.mobileSegmented = h('div', { class: 'mobile-segmented' },
    h('button', { class: 'mseg-btn', 'data-seg': 'schema', onclick: () => { state.mobileTab.value = 'schema'; } }, Icon.database(), h('span', null, 'Explore')),
    h('button', { class: 'mseg-btn', 'data-seg': 'library', onclick: () => { state.mobileTab.value = 'library'; } }, Icon.layers(), h('span', null, 'Library')));
  sidebar.append(leftNavTitle, app.dom.mobileSegmented, schemaPane, app.dom.sideSplit, savedPane);
  // #487 phase 3: the element keeps its `.col-resize` class (`tests/e2e/
  // dashboard-mobile.spec.js`'s display-state assertion and the mobile CSS's
  // `display: none !important` rule both key off it) but no longer wires
  // `startDrag`'s bare 'col' clamp — `mountLeftNavSeparator` below attaches its
  // own mousedown/keydown listeners directly onto this element instead.
  const sideHandle = h('div', { class: 'col-resize' });
  app.dom.leftNavSeparator = sideHandle;

  // #487 phase 3 — the compact icon rail, built from the SAME section registry
  // the wide sidebar's two panes read (`registry.entry`), so a rail tooltip can
  // never disagree with a wide switcher's label for the same section.
  const leftRail = buildLeftRail({
    app,
    registry,
    state: { leftNavSection: state.leftNavSection },
    drawerElementId: LEFT_NAV_DRAWER_ID,
  });
  app.dom.leftRail = leftRail.el;

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
  // The rail is the FIRST child — #487 phase 3's compact presentation reads
  // left-to-right as rail, then whatever `.sidebar` is currently presenting.
  const mainRow = h('div', { class: 'main-row' }, leftRail.el, sidebar, sideHandle, queryHost, dashboardHost);

  // #487 phase 3 — the navigation's live pixel budget: `.main-row`'s own
  // current width, minus the resize separator's own footprint, minus the
  // centre work surface's documented minimum (`LEFT_CENTRE_MIN_PX`). Read
  // fresh on every call (never cached), so the mount-time call, the
  // preferred-state effect, the separator's own session, and the width
  // observer below all derive from the SAME live measurement.
  const getMaxNavigationTotalPx = (): number =>
    mainRow.getBoundingClientRect().width - LEFT_NAV_SEPARATOR_WIDTH_PX - LEFT_CENTRE_MIN_PX;

  // #487 phase 3 — the SOLE writer of every left-navigation presentation
  // attribute. `data-nav-mode` ('wide' | 'rail' | 'drawer') is derived from
  // `layout.mode`/`layout.focusedSection` and written onto BOTH `.main-row`
  // and `.sidebar` — `.sidebar` itself is re-presented, never moved or
  // rebuilt, so every one of the four section hosts phase 2 built keeps its
  // exact DOM identity across a mode change. Every `hidden`/text toggle below
  // is set UNCONDITIONALLY (never left to CSS alone), because happy-dom
  // computes no CSS and this is the one seam `app-shell.test.ts` can assert
  // the whole table against as real DOM property writes.
  function applyEffectiveLeftNavigationLayout(layout: LeftNavigationLayout): void {
    const navMode: 'wide' | 'rail' | 'drawer' = layout.mode === 'wide'
      ? 'wide'
      : layout.focusedSection === null ? 'rail' : 'drawer';
    mainRow.dataset.navMode = navMode;
    sidebar.dataset.navMode = navMode;
    // The rail's own width never resizes, so only 'wide' (the whole nav) and
    // 'drawer' (the panel beside the rail) have a meaningful pixel width here;
    // 'rail' mode hides `.sidebar` entirely, so `wideWidthPx` is a harmless,
    // non-stale filler rather than an untouched leftover from whatever mode
    // came before it.
    sidebar.style.width = (navMode === 'drawer' ? layout.drawerWidthPx : layout.wideWidthPx) + 'px';

    leftRail.el.hidden = navMode === 'wide';
    sidebar.hidden = navMode === 'rail';

    const focused = layout.focusedSection;
    leftNavTitle.hidden = navMode !== 'drawer';
    leftNavTitle.textContent = navMode === 'drawer' && focused ? NAV_SECTION_META[focused].label : '';
    // Only the focused drawer has one single-purpose heading to label itself
    // with — the wide sidebar shows two panes (each already labelled by its
    // own switcher) and a bare rail shows nothing at all, so pointing
    // `aria-labelledby` at a hidden title in either of those would be a stale
    // reference, not a helpful one. Omitting the attribute there is the
    // deliberate choice.
    if (navMode === 'drawer') sidebar.setAttribute('aria-labelledby', LEFT_NAV_TITLE_ID);
    else sidebar.removeAttribute('aria-labelledby');

    const upperFocused = navMode === 'drawer' && (focused === 'databases' || focused === 'dashboards');
    const lowerFocused = navMode === 'drawer' && (focused === 'library' || focused === 'history');
    schemaPane.hidden = !(navMode === 'wide' || upperFocused);
    savedPane.hidden = !(navMode === 'wide' || lowerFocused);
    // A drawer showing ONLY the upper pane must fill the sidebar's whole
    // height — its inline height is otherwise the wide two-pane split
    // percentage, which would leave the bottom of the drawer empty once
    // `savedPane` collapses to `hidden` (the same one-pane-fills-the-column
    // fix the mobile segmented control already applies via CSS, at
    // `.sidebar[data-mobile-tab="schema"] .schema-pane` in styles.css — this
    // is the same override, applied inline for the desktop drawer case).
    if (upperFocused) {
      schemaPane.style.flex = '1';
      schemaPane.style.height = 'auto';
    } else {
      schemaPane.style.flex = '';
      schemaPane.style.height = state.sideSplitPct + '%';
    }

    // No redundant switcher inside a drawer already showing exactly one
    // section, and no resize handle between two panes when only one is
    // visible — hidden in both 'rail' (where `.sidebar` itself is hidden, so
    // this is moot) and 'drawer'.
    const hideWideOnlyChrome = navMode !== 'wide';
    app.dom.upperRoleTabs!.hidden = hideWideOnlyChrome;
    app.dom.savedTabsRow!.hidden = hideWideOnlyChrome;
    app.dom.sideSplit!.hidden = hideWideOnlyChrome;
  }

  // #487 phase 3 — the ONE derivation path every trigger below funnels
  // through: read the persisted/session preference, project it for the
  // current viewport class (mobile forces 'wide'/no-drawer), then clamp it to
  // whatever the live shell width currently allows.
  const deriveLeftNavigationLayout = (): LeftNavigationLayout => clampLeftNavigationToMaximumTotal(
    effectiveLeftNavigationLayout(readLeftNavigationLayout(state), state.isMobile.value),
    getMaxNavigationTotalPx(),
  );

  // #487 phase 3 — a visually-hidden `role="status"` live region for the
  // separator's mode/drawer-open-or-closed announcements (mouse drags and
  // keyboard operations alike go through this one seam).
  const leftNavStatus = app.dom.leftNavStatus = h('div', {
    class: 'sr-only', role: 'status', 'aria-live': 'polite',
  });

  // #487 phase 3 — the resize/mode-changing separator. It owns pointer/
  // keyboard mechanics and session bookkeeping; every pixel decision still
  // routes through `core/left-nav-layout.ts`'s reducers, and every paint routes
  // back through `applyEffectiveLeftNavigationLayout` above (already correctly
  // clamped by the separator's own session — never re-clamped here).
  const leftNavSeparator = mountLeftNavSeparator({
    el: sideHandle,
    state,
    prefs: { save: (name, value) => prefs.save(name as PreferenceKey, value) },
    getMaxNavigationTotalPx,
    applyEffectiveLayout: applyEffectiveLeftNavigationLayout,
    announce: (message) => { leftNavStatus.textContent = message; },
  });

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

  root!.replaceChildren(headerSlot, authHost, app.dom.banner, mainRow, leftNavStatus, app.dom.mobileNav);

  const disposers: (() => void)[] = [];
  // #487 phase 3 — the "preferred-state effect": the sole reactive trigger for
  // `applyEffectiveLeftNavigationLayout` outside the separator's own drag/
  // keyboard sessions and the width observer below. Subscribes to the two
  // SIGNALS a mode/section transition writes (`sidebarPx`/`leftNavDrawerPx`
  // are plain fields with no signal to key an effect off — a width-only change
  // relies on whichever caller already painted it directly) plus `isMobile`,
  // so crossing the mobile breakpoint in either direction re-derives the
  // effective layout too. Registered here (post-mount, mirroring every other
  // effect in this file), it also runs once immediately for the initial paint
  // — no separate explicit mount-time call needed.
  disposers.push(effect(() => {
    state.leftNavMode.value;
    state.leftNavSection.value;
    state.isMobile.value;
    applyEffectiveLeftNavigationLayout(deriveLeftNavigationLayout());
  }));
  // #487 phase 3 — the shell-width observer (an injected seam; see
  // `AppShellDeps.observeElementWidth`'s own doc comment). A live
  // browser-window resize with NO active separator session still has to keep
  // the centre-content minimum honored, and this is the only trigger that
  // notices one: the separator's own session re-clamps on every step it takes,
  // but takes none while the pointer/keyboard is idle. Both derive from the
  // exact same `getMaxNavigationTotalPx()` reading the live `.main-row` width,
  // so an observer firing mid-drag is naturally consistent with the
  // separator's own concurrent calls rather than fighting them — there is only
  // ONE derivation path, called from four triggers, never four different ones.
  const disposeWidthObserver = observeElementWidth?.(mainRow, (widthPx) => {
    if (!(widthPx > 0) || !Number.isFinite(widthPx)) return; // defensive: a detached/not-yet-laid-out element can report 0.
    applyEffectiveLeftNavigationLayout(deriveLeftNavigationLayout());
  }) || null;
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
  // #426: the upper role tabs. Both counts are reactive — the Databases count
  // tracks the schema load (and is omitted while it is pending or failed), and the
  // Dashboards count tracks the committed collection through the tree's explicit
  // invalidation signal, since `currentWorkspace` is not itself a signal.
  disposers.push(effect(() => {
    state.upperRole.value;
    state.schema.value;
    state.schemaError.value;
    state.dashboardTreeRevision.value;
    renderUpperRoleTabs(app);
  }));
  // #426: expose exactly one upper section host, and repaint the Dashboard tree.
  // Kept separate from the tab effect so a schema load does not rebuild the tree.
  disposers.push(effect(() => {
    registry.showSection(state.upperRole.value);
  }));
  // #487 phase 2: the same rule for the lower pane, which until now had no
  // exposure step at all — its two sections shared one search/list pair that the
  // repaint below simply overwrote. Subscribed to `sidePanel` ALONE (unlike the
  // repaint effect, which also tracks the projection revision): a Dashboard
  // mutation changes which rows the Library shows, never which section is
  // exposed.
  disposers.push(effect(() => {
    registry.showSection(sectionForSidePanelKey(state.sidePanel.value));
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
  // Reactive repaint of the lower tab row: re-runs when the active panel changes
  // (Library ↔ History) or the Library count might have (projection revision).
  // #487 phase 3 split this from the content repaint below, mirroring the upper
  // pane's own split (`renderUpperRoleTabs` vs `renderSchema`) — switching which
  // section is exposed repaints only the tab row's active class/count, never
  // either section's content.
  disposers.push(effect(() => {
    state.sidePanel.value;
    state.dashboardTreeRevision.value;
    renderLowerTabs(app);
  }));
  // Reactive repaint of Library's own content: re-runs on the projection
  // revision alone, regardless of which lower section is exposed (#487 phase 3)
  // — mirroring `renderSchema`, which does not subscribe to `upperRole` either.
  // Data-driven repaints of ROW-level state (favorite/rename/delete) still call
  // the full `renderSavedHistory` facade directly.
  //
  // #427 added the projection revision. Library membership is now a function of
  // `dashboards[]` — a query is in the Library exactly while no Dashboard member
  // references it — so a committed Dashboard change can move a query in or out of
  // this list without `savedQueries` changing at all. It is the same one signal
  // the Dashboard tree subscribes to, bumped from the single projection funnel.
  //
  // Deliberately no matching reactive effect for History's own content:
  // `state.history` is a plain array, not a signal, so History has never been
  // signal-driven — it stays current via direct calls at its mutation sites
  // (`app.recordHistory`, the script-run history path, and the facade above).
  disposers.push(effect(() => {
    state.dashboardTreeRevision.value;
    renderLibrarySection(app);
  }));
  // History's OWN initial paint: unlike Library, History has no signal to key a
  // reactive effect off (see the comment above), so it cannot pick up its first
  // paint by registering one. Without this direct, one-time call the History
  // host would stay the empty div `nav-sections.ts` built it as until the first
  // history-recording event — reintroducing, for History specifically, the exact
  // "section that wasn't active at mount never got painted" bug this phase
  // fixes for Library via the effect above. Not an effect itself (no signal
  // read, so it never re-runs) — every subsequent History repaint still comes
  // from its own mutation sites or the full `renderSavedHistory` facade.
  renderHistorySection(app);
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
    dispose: () => {
      // #426: a deferred single-click must not fire against a tree that is being
      // torn down (sign-out, a surface teardown) — the arbiter's timer outlives
      // this DOM otherwise.
      cancelDashboardTreeClicks(app);
      for (const dispose of disposers) dispose();
      mq?.removeEventListener('change', onMobileChange);
      // #487 phase 3 — the rail's per-button effects, the separator's own
      // listeners + ARIA effect, and (when provided) the injected width
      // observer all outlive `disposers` above unless stopped here too.
      leftRail.dispose();
      leftNavSeparator.dispose();
      disposeWidthObserver?.();
    },
  };
}
