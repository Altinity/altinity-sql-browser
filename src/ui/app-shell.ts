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
import { effect, untracked } from '@preact/signals-core';
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
  clampLeftNavigationToMaximumTotal, effectiveLeftNavigationLayout, isLeftNavigationSection,
  LEFT_CENTRE_MIN_PX,
} from '../core/left-nav-layout.js';
import type { LeftNavigationLayout, LeftNavigationSection } from '../core/left-nav-layout.js';
import { readLeftNavigationLayout, toggleFocusedSection } from '../application/left-nav.js';
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

  // #487 phase 3 step 4 — Escape closes a focused drawer and returns focus to
  // the rail launcher that opened it. Attached ONCE, directly on `sidebar`
  // (the drawer container), and relies entirely on bubbling from whatever
  // descendant currently has focus — this is not keyboard ownership, it only
  // ever reacts to a keydown that already landed inside `.sidebar`.
  sidebar.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    // Something nested already claimed this Escape — the search box (when its
    // own filter is non-empty, `saved-history.ts`) or a saved-row edit form's
    // own Escape-to-cancel handler. Respect that claim: do not also close the
    // drawer on the same keystroke.
    if (e.defaultPrevented) return;
    // Escape is only this handler's concern while a focused drawer is
    // actually showing — in 'wide'/'rail' mode there is nothing to close.
    if (sidebar.dataset.navMode !== 'drawer') return;
    const section = state.leftNavSection.value;
    // The mode/section coherence invariant (`core/left-nav-layout.ts`)
    // guarantees `section` is non-null whenever `navMode === 'drawer'` — this
    // guard is defensive only, never expected to trip.
    if (section === null) return;
    // A second activation of the already-open section CLOSES it
    // (`resolveRailActivation`'s toggle semantics) — exactly what this
    // handler wants.
    toggleFocusedSection(app, section);
    e.preventDefault();
    leftRail.focusSection(section);
  });

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

  // #487 phase 3 step 4 — the ONE piece of state this presentation function
  // needs beyond `layout` itself: which section was focused on the PREVIOUS
  // call, read before this call's own `layout.focusedSection` overwrites it.
  // That is what lets a rail/drawer → wide transition (the resize separator
  // converting past the wide threshold, or the `End`/bare-rail-`ArrowRight`
  // keyboard restore) know which section's wide-mode tab to hand focus back
  // to — Escape's drawer→rail close (this file's `sidebar` keydown listener,
  // below) is a SEPARATE trigger and never reaches 'wide' here. Starting at
  // `null` spuriously "restores" nothing on the very first call: if that
  // first layout is already 'wide', `focusedSection` is `null` by the
  // mode/section coherence invariant (`core/left-nav-layout.ts`) regardless of
  // what this variable holds, so the restore branch below cannot fire either
  // way.
  //
  // #487 phase-3 review, bug 4 — this bookkeeping (both the restoration
  // side-effect and the assignment at the end of the function) is read/written
  // ONLY while `leftNavSeparator.isSessionActive()` is false. A non-monotone
  // drag calls this function once per intermediate frame — e.g. Library drawer
  // → past the wide threshold → back past the fold threshold to bare rail —
  // and updating `previousFocusedSection` on every one of those frames
  // corrupts it: the first frame (crossing to wide) would clear it to `null`,
  // so the second frame (crossing back to rail) could no longer restore focus
  // even where it should, and the reverse sequence (drawer → momentarily bare
  // rail → back to wide) could just as easily clobber it to `null` right
  // before the wide transition that actually needed it. So while a gesture is
  // in progress this variable stays FROZEN at whatever it was before the
  // gesture began, and the eventual committed transition — the only call that
  // happens once `isSessionActive()` is false again, whether that is the
  // pointer session's own `endDrag()`/`commitSession` call or a keyboard
  // commit (see below) — is judged against where the gesture started, not
  // against any intermediate frame's value.
  //
  // The keyboard path never sets this guard's condition to true in the first
  // place: `left-nav-separator.ts`'s `onKeyDown` keeps its own session in a
  // LOCAL `keySession` variable and commits synchronously within one keydown,
  // never assigning to the module-level `session` `isSessionActive()` reads —
  // so a keyboard commit's call into this function always sees
  // `isSessionActive() === false`, and this bookkeeping fires for it exactly
  // as it did before this fix.
  let previousFocusedSection: LeftNavigationSection | null = null;

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
    const priorFocusedSection = previousFocusedSection;
    const navMode: 'wide' | 'rail' | 'drawer' = layout.mode === 'wide'
      ? 'wide'
      : layout.focusedSection === null ? 'rail' : 'drawer';
    // #487 phase-3 review, second pass — captured BEFORE any hidden-state
    // mutation below touches `.sidebar`, `leftRail.el` or `data-mobile-view`'s
    // CSS: once an ancestor goes `display: none`/`[hidden]`, the focused
    // descendant is still momentarily reported as `document.activeElement`
    // (verified against a real Chromium instance), but the browser drops it to
    // `<body>` on its own by the next microtask unless something explicitly
    // moves it first. `focusedInSidebar` is the one fact every restoration
    // branch below needs and none of them could previously get right for a
    // WIDE sidebar: `focusedSection` is null throughout 'wide' by construction
    // (`core/left-nav-layout.ts`'s own mode/section coherence invariant), so
    // `priorFocusedSection` can never name which of the two simultaneously
    // visible sections actually held focus — only the DOM itself knows that.
    const activeBeforeEl = doc.activeElement;
    const focusedInSidebar = activeBeforeEl instanceof Element && sidebar.contains(activeBeforeEl);
    // `untracked`: this function is itself called from the "preferred-state
    // effect" below (subscribed only to `leftNavMode`/`leftNavSection`/
    // `isMobile`) — a PLAIN read of `state.mobileView.value` here would
    // silently widen that effect's own reactive dependencies to include
    // `mobileView` too (signals track every `.value` read during an effect's
    // run, at any call depth), making every bottom-nav tap ALSO re-run the
    // whole preferred-state derivation redundantly and race the dedicated
    // `mobileView` effect below for which one actually performs the rescue.
    // Reading it untracked keeps this function's own reactive footprint
    // exactly what it was before this fix: still the CURRENT value, just not
    // a new subscription.
    const currentMobileView = untracked(() => state.mobileView.value);
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

    // The separator's OWN aria-valuenow/valuemax/valuetext describe exactly
    // this layout, but its own internal ARIA effect only re-runs on a
    // `leftNavMode`/`leftNavSection` signal change — never on a width-only
    // change, since `sidebarPx`/`leftNavDrawerPx` are plain fields with no
    // signal to key an effect off. Every trigger of THIS function (the
    // mount-time paint, the preferred-state effect, the width observer, and
    // the separator's own gesture callback) can change the rendered width
    // without changing either signal, so this call is what keeps the
    // separator's ARIA from going stale between gestures. Harmless to call
    // during the separator's own active session too — it just redundantly
    // re-applies the same values `advanceTo`/`commitSession` already set.
    leftNavSeparator.refreshAria(layout);

    // #487 phase 3 step 4 — converting a focused drawer to the wide sidebar
    // (a resize-separator drag past the wide threshold, or the `End`/
    // bare-rail-`ArrowRight` keyboard restore) hands focus to the section's
    // OWN wide-mode tab, so keyboard/AT users land somewhere meaningful
    // rather than on whatever the drawer's last-focused element happened to
    // be (now hidden). Resolved by a LIVE `querySelector` at the moment of
    // the transition, never a cached reference: `renderUpperRoleTabs`/
    // `renderLowerTabs` both `.replaceChildren(...)` on every repaint, so an
    // element captured earlier can go stale.
    //
    // #487 phase-3 review, major issue 3 — `!state.isMobile.value` guards
    // this branch: `navMode` is 'wide' on EVERY mobile call too
    // (`effectiveLeftNavigationLayout` forces it), so without this guard a
    // mobile crossing straight out of an open drawer read as "converted to
    // wide" and called `.focus()` on a desktop tab button the mobile layout
    // hides entirely — stealing focus for a control the user cannot even see.
    //
    // #487 phase-3 review, major issue 4 — the `else if` restores focus to
    // the rail launcher on a committed drawer-to-BARE-RAIL transition, which
    // had no restoration at all before this fix. Scoped to
    // `focusedInSidebar`, not every rail arrival: a POINTER drag's
    // `mousedown` calls `preventDefault()` (this module's own
    // `onMouseDown`... i.e. `left-nav-separator.ts`'s), so focus is never
    // moved onto the separator and can be left stranded inside the
    // now-hidden drawer content — exactly the case that needs rescuing. A
    // KEYBOARD fold (Home, or ArrowLeft crossing the fold boundary) requires
    // the separator itself to already hold focus to receive that keydown at
    // all, so `focusedInSidebar` is false there and this leaves the
    // separator's own, already-correct focus alone — redirecting it would
    // break the very next ArrowRight/End from reaching the control that
    // handles it.
    //
    // #487 phase-3 review, second pass, major issue — a WIDE sidebar folding
    // straight to bare rail (a drag that never opened a focused drawer, or a
    // non-monotone gesture that only passed through 'drawer' mid-session)
    // used to hit this branch's old `priorFocusedSection !== null` guard,
    // which is permanently false coming out of 'wide' (see `focusedInSidebar`
    // above) — so the focused control was silently dropped with nothing
    // rescuing it. `priorFocusedSection` still wins when it IS known (a
    // genuinely focused drawer folding to rail), matching every existing
    // drawer -> rail case exactly; the DOM lookup is only the fallback for
    // the wide case that has no such tracked section to fall back on.
    if (!leftNavSeparator.isSessionActive()) {
      if (!state.isMobile.value && navMode === 'wide' && priorFocusedSection !== null) {
        const pane = NAV_SECTION_META[priorFocusedSection].pane;
        const tabsRow = pane === 'upper' ? app.dom.upperRoleTabs : app.dom.savedTabsRow;
        const tabButton = tabsRow?.querySelector<HTMLElement>('[data-section="' + priorFocusedSection + '"]');
        tabButton?.focus();
      } else if (navMode === 'rail' && focusedInSidebar) {
        if (priorFocusedSection !== null) {
          leftRail.focusSection(priorFocusedSection);
        } else {
          const activeSection = (activeBeforeEl as Element).closest<HTMLElement>('[data-section]')?.dataset.section;
          if (isLeftNavigationSection(activeSection)) leftRail.focusSection(activeSection);
        }
      } else if (
        state.isMobile.value
        && (currentMobileView === 'editor' || currentMobileView === 'results')
        && focusedInSidebar
      ) {
        // #487 phase-3 review, second pass, major issue — entering mobile
        // Editor/Results hides `.sidebar` via CSS alone
        // (`.main-row[data-mobile-view="editor"/"results"] .sidebar {
        // display: none }` in styles.css), independently of `navMode` (mobile
        // forces 'wide' regardless of which mobile view is showing, which is
        // exactly why the branch above is guarded off by `!state.isMobile.value`
        // — it must not steal focus onto a desktop tab the mobile layout hides
        // entirely). Nothing was rescuing the focused sidebar control here
        // before this fix; the mobile view's own bottom-nav button is the one
        // stable, always-visible landing spot. Tables is deliberately excluded:
        // its sidebar stays visible (`.main-row[data-mobile-view="tables"]
        // .sidebar { display: flex }`), so there is nothing to rescue there.
        app.dom.mobileNav?.querySelector<HTMLElement>('[data-view="' + currentMobileView + '"]')?.focus();
      }
      previousFocusedSection = layout.focusedSection;
    }
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

  // #487 phase-3 review, major issue 2 — `application/left-nav.ts`'s
  // `openFocusedSection`/`toggleFocusedSection` call this FIRST, before their
  // own write: an active pointer resize session keeps its own uncommitted
  // layout snapshot, so a semantic command (Escape, a rail click, a reveal
  // action) that writes `state` directly while a drag is still live left the
  // drag's eventual mouseup/blur commit free to fire from that stale
  // snapshot and silently overwrite (or resurrect) exactly what the command
  // just did. A no-op when no session is active, which is the common case —
  // this is not gated behind every call site remembering to preempt; it is a
  // property of the one seam every caller already goes through.
  app.preemptActiveResize = () => {
    if (!leftNavSeparator.isSessionActive()) return;
    leftNavSeparator.cancelActiveSession();
    applyEffectiveLeftNavigationLayout(deriveLeftNavigationLayout());
  };

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
  //
  // Deliberately NOT gated behind `leftNavSeparator.isSessionActive()`, unlike
  // the width observer below: `isMobile` flipping to true mid-drag is a real
  // transition this effect must still force back to wide — a session cannot
  // stay in a desktop drawer/rail presentation once the viewport is mobile.
  //
  // #487 phase-3 review, bugs 1 and 2 — an `isMobile` crossing (in EITHER
  // direction) also needs two side effects BEFORE this call derives/paints,
  // handled by tracking the previous `isMobile` value in `previousIsMobile`,
  // a closure variable declared just above this effect:
  //
  // 1. (bug 2) `leftNavSeparator.cancelActiveSession()` — an active drag has
  //    no way to notice `isMobile` changed under it, so without this its very
  //    next `mousemove` would repaint the now-stale desktop layout right back
  //    over the mobile-wide presentation this effect just forced — and if the
  //    eventual commit happens to reproduce the same `mode`/`focusedSection`
  //    as before the drag, no signal changes, so nothing would ever
  //    re-correct it. Cancelling (never committing) is safe here because
  //    nothing has been written to `state` by an in-progress session — see
  //    `cancelActiveSession`'s own doc comment.
  // 2. (bug 1) `state.leftNavSection.value = null` — `leftNavSection` is
  //    session-only (never persisted) and mobile never touches it, so a
  //    section focused on desktop can go stale across a mobile round-trip:
  //    the mobile-visible wide switcher writes `sidePanel`/`upperRole`
  //    directly (never `leftNavSection`), so returning to desktop could
  //    otherwise show a drawer whose TITLE still names whatever was focused
  //    before the trip while its CONTENT already reflects whatever the
  //    mobile switcher picked. Clearing it on every crossing means a return
  //    from mobile always shows a bare rail instead — matching the existing
  //    precedent that `leftNavSection` "need not reopen automatically" (it
  //    already does not survive a reload).
  //
  // Writing `state.leftNavSection.value` from inside an effect that also
  // reads it schedules this effect to run again immediately — that second run
  // is a harmless no-op (`mobile === previousIsMobile` by then), the same
  // "harmless double-paint" tolerance this file's own `refreshAria` comment
  // already documents elsewhere.
  let previousIsMobile = state.isMobile.value;
  disposers.push(effect(() => {
    state.leftNavMode.value;
    state.leftNavSection.value;
    const mobile = state.isMobile.value;
    if (mobile !== previousIsMobile) {
      previousIsMobile = mobile;
      leftNavSeparator.cancelActiveSession();
      state.leftNavSection.value = null;
    }
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
  //
  // Skipped entirely while the separator itself has an active session: this
  // callback derives from `readLeftNavigationLayout(state)` — the last
  // COMMITTED preference — which is stale for exactly as long as a gesture is
  // in progress (a drag paints intermediate positions via its own
  // `applyEffectiveLayout` callback without writing to `state` until it
  // commits). Repainting from that stale state here would visibly snap the
  // sidebar away from the pointer on a mid-drag window resize, then snap back
  // on the next mousemove. The separator's own gesture is authoritative during
  // that window; when it ends, `commitSession` already repaints the final,
  // correctly-clamped state through the same `applyEffectiveLayout` callback.
  const disposeWidthObserver = observeElementWidth?.(mainRow, (widthPx) => {
    if (!(widthPx > 0) || !Number.isFinite(widthPx)) return; // defensive: a detached/not-yet-laid-out element can report 0.
    if (leftNavSeparator.isSessionActive()) return;
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
  //
  // #487 phase-3 review, second pass, major issue — this is a SEPARATE trigger
  // from `applyEffectiveLeftNavigationLayout`'s own isMobile-crossing rescue
  // above: tapping the bottom nav from Tables straight to Editor/Results (no
  // `isMobile`/`leftNavMode`/`leftNavSection` change at all) hides `.sidebar`
  // via the exact same CSS rule but never runs that function, so a control
  // focused in Tables would be dropped the same way. Focus is captured BEFORE
  // the attribute write flips the CSS (same ordering reason as that rescue).
  disposers.push(effect(() => {
    const view = state.mobileView.value;
    const activeBeforeEl = doc.activeElement;
    const hidingSidebar = state.isMobile.value && (view === 'editor' || view === 'results')
      && activeBeforeEl instanceof Element && sidebar.contains(activeBeforeEl);
    mainRow.dataset.mobileView = view;
    if (hidingSidebar) {
      const navButton = app.dom.mobileNav?.querySelector<HTMLElement>('[data-view="' + view + '"]');
      navButton?.focus();
    }
  }));
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
      // #487 phase-3 review, second pass, major issue — a mobile Dashboard
      // hides `.sidebar` via `.main-row[data-surface="dashboard"] .sidebar {
      // display: none }` (styles.css), a THIRD trigger entirely outside
      // `applyEffectiveLeftNavigationLayout`/the mobileView effect above. Same
      // rescue shape: capture before the attribute write, land on the one
      // bottom-nav button #471 keeps visible on this surface (Editor — the
      // Dashboard's only route back to the Workbench).
      const activeBeforeEl = doc.activeElement;
      const hidingSidebarForDashboard = state.isMobile.value && kind === 'dashboard'
        && activeBeforeEl instanceof Element && sidebar.contains(activeBeforeEl);
      queryHost.hidden = kind !== 'query';
      dashboardHost.hidden = kind !== 'dashboard';
      mainRow.dataset.surface = kind;
      if (hidingSidebarForDashboard) app.dom.mobileNav?.querySelector<HTMLElement>('[data-view="editor"]')?.focus();
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
