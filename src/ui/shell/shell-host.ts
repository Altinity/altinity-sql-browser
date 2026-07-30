// #577 state S2 (Preact treatment) — `mountAppShell`, the composition root.
//
// Keeps the EXACT public seam S0/S1 expose (`AppShellDeps` in, `AppShellHandle`
// out), so `ui/app.ts`'s single call site changes only its import path. The
// comparison is then about rendering, not about re-plumbing the application.
//
// WHAT LIVES HERE AND WHY. Three kinds of thing that a component tree cannot
// own:
//
//  1. VANILLA-BUILT DOM whose children an existing renderer writes — the schema
//     search box and list, the section registry's four persistent hosts, both
//     switcher rows, the mobile badge, and the pre-built icon/label pairs. The
//     view adopts these; it never renders into them.
//  2. THE NINE SURVIVING EFFECTS, which are plain `effect()` calls in this
//     function body, never Preact hooks. They are order-dependent by design
//     (each comment below is carried over verbatim from the vanilla arm), and
//     hook scheduling is not the same tick as a bare effect.
//  3. THE IMPERATIVE ISLANDS — the resize separator and the sideRow splitter —
//     which stay exactly as they are, mounted onto elements Preact rendered.
//
// WHAT LEFT. The ~100-line `applyEffectiveLeftNavigationLayout` and its four
// call sites; the mount-time paint; the `preferred-state effect`; the
// `mobileView` and `mobileTab` data-attribute effects; the rail's four
// per-button ARIA effects and its `dispose()`; and the inspector's
// `renderActive()`. What ARRIVED to replace them is in this file and in
// `shell-layout.ts`, and the report counts both sides.

import { h as ph, options, render } from 'preact';
// NOT '@preact/signals-core': importing the PREACT bindings is what patches
// Preact's options hooks so a component reading `signal.value` in its render
// body re-renders on a write. With core alone the shell renders once and then
// never repaints — a defect no type check and no pure-signal test can catch,
// found only by rendering a real component. The bindings re-export the same
// primitives over the SAME single copy of signals-core (asserted in the
// size-report's per-package attribution), so this adds no second reactivity.
import { batch, effect, signal } from '@preact/signals';
import { h } from '../dom.js';
import { Icon } from '../icons.js';
import { MOBILE_BREAKPOINT_PX } from '../../state.js';
import type { AppState as State } from '../../state.js';
import { renderSchema } from '../schema.js';
import { buildSidebarUpper, renderUpperRoleTabs } from '../sidebar-upper.js';
import { buildNavSectionRegistry, sectionForSidePanelKey, NAV_SECTION_META } from '../nav-sections.js';
import type { NavSectionPane } from '../nav-sections.js';
import { renderDashboardTree, cancelDashboardTreeClicks } from '../dashboard-tree.js';
import { renderLowerTabs, renderLibrarySection, renderHistorySection } from '../saved-history.js';
import { renderLibraryTitle } from '../file-menu.js';
import { applyConnectionStatus } from '../app-header.js';
import type { DragCtx, DragRect, DragStartEvent } from '../splitters.js';
import { startDrag } from '../splitters.js';
import { mountLeftNavSeparator } from '../left-nav-separator.js';
import type { LeftNavSeparatorHandle } from '../left-nav-separator.js';
import {
  isLeftNavigationSection, LEFT_CENTRE_MIN_PX, LEFT_NAV_SECTIONS,
} from '../../core/left-nav-layout.js';
import type { LeftNavigationLayout, LeftNavigationSection } from '../../core/left-nav-layout.js';
import { toggleFocusedSection } from '../../application/left-nav.js';
import type { App } from '../app.types.js';
import type { SchemaCatalogService } from '../../application/schema-catalog-service.js';
import type { AppPreferences, PreferenceKey } from '../../application/app-preferences.js';
import { createShellLayout } from './shell-layout.js';
import { createFocusSettler } from './focus-settlement.js';
import { adopt } from './adopt.js';
import { createInspectorModel, RIGHT_INSPECTOR_TOOLS } from './right-inspector-view.js';
import { Shell } from './shell-view.js';
import type { ElementRef, ShellContext, ShellRefs, SurfaceHostKind } from './shell-context.types.js';

export type { SurfaceHostKind } from './shell-context.types.js';

/** `.col-resize { width: 7px; }` in styles.css — the separator's own width,
 *  which the navigation's pixel budget must exclude. */
const LEFT_NAV_SEPARATOR_WIDTH_PX = 7;

/** `mountAppShell`'s dependency bag — unchanged from the vanilla arm, field for
 *  field, so the two are drop-in comparable. */
export interface AppShellDeps {
  app: App;
  root: Element | null;
  document: Document;
  state: State;
  catalog: Pick<SchemaCatalogService, 'loadSchema' | 'loadReference'>;
  prefs: Pick<AppPreferences, 'save'>;
  matchMedia: ((query: string) => MediaQueryList) | null;
  /** An injected shell-width observer seam. When provided, called ONCE with
   *  `.main-row` and a callback that updates the navigation's pixel budget, so
   *  the centre-content minimum stays honored across a plain window resize and
   *  not only a separator drag. Omitted: no live reclamping runs and nothing
   *  throws, exactly as `matchMedia: null` behaves. */
  observeElementWidth?: (element: Element, callback: (widthPx: number) => void) => () => void;
  updateBanner(): void;
  startDrag: typeof startDrag;
}

/** Unchanged from the vanilla arm. */
export interface AppShellHandle {
  setHeader(header: Element): void;
  authHost: HTMLElement;
  queryHost: HTMLElement;
  dashboardHost: HTMLElement;
  showHost(kind: SurfaceHostKind): void;
  dispose(): void;
}

/**
 * Apply `write`'s state change and flush the resulting render SYNCHRONOUSLY.
 *
 * Preact enqueues renders on a microtask, so a state write does not paint
 * before the next statement runs. That is invisible almost everywhere — and
 * fatal at exactly one kind of boundary: code that REVEALS a subtree and then
 * immediately acts on it. `showHost('query')` followed by focusing the SQL
 * editor is precisely that shape, and it broke in a real browser (the editor
 * stayed `inactive` because its host was still `hidden` when `.focus()` ran)
 * while the entire 6,995-test unit suite stayed green.
 *
 * `options.debounceRendering` is Preact's own scheduling seam: swapping it for
 * a "run it now" implementation for the duration of the write, then restoring
 * whatever was there, turns one call site synchronous without making the whole
 * application synchronous (which would cost a full render per drag frame).
 *
 * This helper is a COST the component arm pays and the imperative arm does not:
 * there, revealing a host was a `hidden = false` assignment that had already
 * taken effect by the next line.
 */
function flushSync(write: () => void): void {
  const previous = options.debounceRendering;
  let queued: (() => void) | null = null;
  options.debounceRendering = (process) => { queued = process; };
  try {
    write();
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (queued !== null) (queued as () => void)();
  } finally {
    options.debounceRendering = previous;
  }
}

/** A hoisted ref that simply records the element.
 *
 *  `get()` asserts the element exists — true for every caller that runs after
 *  the first (synchronous) render. `peek()` is the honest accessor for the one
 *  caller that can run BEFORE it: the live budget measurement, which the layout
 *  derivation invokes during that very first render. */
function slot(): { ref: ElementRef; get(): HTMLElement; peek(): HTMLElement | null } {
  let el: HTMLElement | null = null;
  return { ref: (next) => { if (next !== null) el = next; }, get: () => el!, peek: () => el };
}

export function mountAppShell(deps: AppShellDeps): AppShellHandle {
  const {
    app, root, document: doc, state, catalog, prefs, matchMedia, updateBanner,
    startDrag: doStartDrag, observeElementWidth,
  } = deps;
  doc.documentElement.setAttribute('data-theme', state.theme);
  doc.documentElement.setAttribute('data-density', state.density);

  app.dom = {};

  // ---- vanilla-built DOM the view adopts -----------------------------------
  app.dom.schemaSearchInput = h('input', {
    type: 'text', placeholder: 'Search tables, columns…',
    oninput: (e: Event) => { state.schemaFilter.value = (e.target as HTMLInputElement).value; },
  });
  app.dom.schemaList = h('div', { class: 'schema-list' });
  // Both panes are composed out of the SAME registry, which owns all four
  // sections' persistent hosts, their labels and their icons — the only way the
  // "wide and focused presentations share and preserve all navigation state"
  // claim stays true when a third container (the drawer) addresses them too.
  const registry = buildNavSectionRegistry(app, buildSidebarUpper(app, [
    h('div', { class: 'schema-search' }, h('div', { class: 'search-wrap' }, Icon.search(), app.dom.schemaSearchInput)),
    app.dom.schemaList,
  ]));
  app.dom.savedTabsRow = h('div', { class: 'side-tabs' });
  app.dom.mobileBadge = h('span', { class: 'mnav-badge' });
  const hostsIn = (pane: NavSectionPane): HTMLElement[] =>
    registry.entries.filter((entry) => entry.pane === pane).map((entry) => entry.host);

  // ---- hoisted refs --------------------------------------------------------
  const mainRow = slot();
  const sidebar = slot();
  const sideHandle = slot();
  const leftRail = slot();
  const leftNavStatus = slot();
  const headerSlot = slot();
  const authHost = slot();
  const queryHost = slot();
  const dashboardHost = slot();

  // ---- derived state -------------------------------------------------------
  // The ONE live measurement, read fresh by every consumer — the derivation,
  // the separator's own session, and the width observer — so no two of them can
  // ever be clamping against different budgets. Defensive before the first
  // render: an unmeasured row means "no additional constraint", which is how
  // the reducer already treats a non-finite budget.
  const measureMaxNavigationTotalPx = (): number => {
    const row = mainRow.peek();
    if (row === null) return Number.POSITIVE_INFINITY;
    return row.getBoundingClientRect().width - LEFT_NAV_SEPARATOR_WIDTH_PX - LEFT_CENTRE_MIN_PX;
  };
  const layoutModel = createShellLayout({ state, measureMaxNavigationTotalPx });
  const surface = signal<SurfaceHostKind>('query');
  const sideSplitPct = signal(state.sideSplitPct);
  const settler = createFocusSettler(doc);
  const announce = (message: string): void => { leftNavStatus.get().textContent = message; };
  const inspector = createInspectorModel({
    app: { state, prefs: { save: (name, value) => prefs.save(name as PreferenceKey, value) } },
    document: doc,
    tools: RIGHT_INSPECTOR_TOOLS,
    announce,
  });

  const railIcons = new Map<LeftNavigationSection, ElementRef>(
    LEFT_NAV_SECTIONS.map((section) => [section, adopt(registry.entry(section).icon())]),
  );
  const segContents = new Map<'schema' | 'library', ElementRef>([
    ['schema', adopt(Icon.database(), h('span', null, 'Explore'))],
    ['library', adopt(Icon.layers(), h('span', null, 'Library'))],
  ]);
  const navIcons = new Map<'tables' | 'editor' | 'results', ElementRef>([
    ['tables', adopt(Icon.database())],
    ['editor', adopt(Icon.code())],
    ['results', adopt(Icon.table2(), app.dom.mobileBadge)],
  ]);

  const refs: ShellRefs = {
    setMainRow: mainRow.ref,
    setSidebar: sidebar.ref,
    setSideHandle: (el) => { sideHandle.ref(el); if (el) app.dom.leftNavSeparator = el; },
    setSideSplit: (el) => { if (el) app.dom.sideSplit = el; },
    setLeftRail: (el) => { leftRail.ref(el); if (el) app.dom.leftRail = el; },
    setLeftNavTitle: (el) => { if (el) app.dom.leftNavTitle = el; },
    setLeftNavStatus: (el) => { leftNavStatus.ref(el); if (el) app.dom.leftNavStatus = el; },
    setMobileSegmented: (el) => { if (el) app.dom.mobileSegmented = el; },
    setMobileNav: (el) => { if (el) app.dom.mobileNav = el; },
    setHeaderSlot: headerSlot.ref,
    setAuthHost: (el) => { authHost.ref(el); if (el) app.dom.authHost = el; },
    setBanner: (el) => { if (el) app.dom.banner = el; },
    setQueryHost: queryHost.ref,
    setDashboardHost: dashboardHost.ref,
    adoptUpperPane: adopt(app.dom.upperRoleTabs!, ...hostsIn('upper')),
    adoptLowerPane: adopt(app.dom.savedTabsRow, ...hostsIn('lower')),
    railIcon: (section) => railIcons.get(section)!,
    segContent: (segment) => segContents.get(segment)!,
    navIcon: (view) => navIcons.get(view)!,
  };

  // ---- the imperative islands, and the seam they paint through -------------
  let separator: LeftNavSeparatorHandle | null = null;

  /**
   * The separator's ONE painting seam. In the vanilla arm this was a callback
   * that wrote a dozen DOM properties; here it is a signal write.
   *
   * The commit branch is deferred to a microtask on purpose, and it is the one
   * genuinely awkward consequence of deriving layout from state:
   * `commitSession` paints (this call) BEFORE it writes `state`, so bumping the
   * revision synchronously would recompute the derivation against the OLD
   * widths and cache that. Leaving `dragLayout` holding the final layout across
   * the microtask means the rendered result is already correct; the deferred
   * pair then hands derivation back to the committed state with no visual
   * change. The vanilla arm needs no equivalent because it never derives — it
   * just paints what it was handed.
   */
  const applyEffectiveLayout = (layout: LeftNavigationLayout): void => {
    if (separator !== null && separator.isSessionActive()) {
      // An intermediate gesture frame: paint only. Focus work is deliberately
      // skipped here — restoring on a frame the user is still dragging through
      // is exactly what #577's contract forbids.
      layoutModel.dragLayout.value = layout;
      return;
    }
    // THE COMMIT. Focus must be captured and settled around this call, not left
    // to the view's own layout effect, and the reason is worth stating because
    // it is a genuine hazard of deriving presentation from state: `navMode`
    // reaches its final value DURING the drag (while capture is correctly gated
    // off), and does not change again at the moment the session ends — so the
    // effect keyed on `navMode` simply never re-runs for the commit, and a
    // pointer-drag fold to bare rail silently rescued nothing. A unit test
    // caught it only because it asserted the destination rather than the
    // mechanism.
    //
    // The vanilla arm has no equivalent hazard: its rescue lives inside the
    // paint function that EVERY trigger calls, so the commit is just another
    // call. Here the commit had to be re-attached by hand.
    settler.capture(sidebar.peek());
    flushSync(() => { layoutModel.dragLayout.value = layout; });
    settleFocus();
    // Deferred on purpose: `commitSession` paints (this call) BEFORE it writes
    // `state`, so bumping the revision synchronously would recompute the
    // derivation against the OLD widths and cache that. `dragLayout` holds the
    // final layout across the microtask, so the rendered result is already
    // correct; the deferred pair then hands derivation back to the committed
    // state with no visual change.
    queueMicrotask(() => {
      batch(() => {
        layoutModel.bumpWidthRevision();
        layoutModel.dragLayout.value = null;
      });
    });
  };

  // ---- focus settlement ----------------------------------------------------
  // The transition that is settling is judged against where it STARTED, so the
  // previous mode/section are tracked across renders — read before this
  // settlement overwrites them, exactly as the vanilla arm's
  // `previousFocusedSection` was, and frozen for the same reason while a
  // gesture is in progress (a non-monotone drag calls this once per
  // intermediate frame and would otherwise clobber the value the eventual
  // committed transition needs).
  let previousFocusedSection: LeftNavigationSection | null = null;

  const railButton = (section: LeftNavigationSection): HTMLElement | null =>
    leftRail.get().querySelector<HTMLElement>('[data-section="' + section + '"]');

  /**
   * Converting a focused drawer to the wide sidebar hands focus to the
   * section's OWN wide-mode tab, resolved by a LIVE query at the moment of the
   * transition — both switcher rows `replaceChildren` on every repaint, so a
   * cached element goes stale. Guarded off mobile, where `navMode` is 'wide' on
   * every call and the desktop tabs are hidden entirely.
   *
   * Deliberately NOT conditional on a captured focus intent, unlike every other
   * destination. The vanilla arm restores here whenever a focused section was
   * converted, regardless of where focus actually sat — and a real-browser e2e
   * proved that difference matters: a pointer drag drops the focused descendant
   * to `<body>` on an intermediate `mousemove` frame, well before any commit-time
   * code runs, so by settlement time there is no intent left to capture and an
   * intent-gated restore silently does nothing. Keeping the two arms' behaviour
   * identical here is what makes the S1→S2 comparison about architecture rather
   * than about a rescue one of them quietly dropped.
   */
  const wideRestoreTarget = (): HTMLElement | null => {
    const prior = previousFocusedSection;
    if (state.isMobile.peek() || layoutModel.navMode.peek() !== 'wide' || prior === null) return null;
    const row = NAV_SECTION_META[prior].pane === 'upper' ? app.dom.upperRoleTabs : app.dom.savedTabsRow;
    return row?.querySelector<HTMLElement>('[data-section="' + prior + '"]') || null;
  };

  const resolveDestination = (intent: Element): HTMLElement | null => {
    const navMode = layoutModel.navMode.peek();
    const mobile = state.isMobile.peek();
    const mobileView = state.mobileView.peek();
    const prior = previousFocusedSection;
    // A drawer or wide sidebar folding to bare rail. `prior` wins when known;
    // otherwise the captured element itself names the section it sat in, which
    // is the only way a WIDE sidebar (where `focusedSection` is null by the
    // coherence invariant) can be rescued at all.
    if (navMode === 'rail') {
      if (prior !== null) return railButton(prior);
      const section = intent.closest<HTMLElement>('[data-section]')?.dataset.section;
      return isLeftNavigationSection(section) ? railButton(section) : null;
    }
    // Entering mobile Editor/Results hides `.sidebar` via CSS alone,
    // independently of `navMode`. The view's own bottom-nav button is the one
    // stable, always-visible landing spot. Tables is excluded: its sidebar
    // stays visible, so there is nothing to rescue.
    if (mobile && (mobileView === 'editor' || mobileView === 'results')) {
      return app.dom.mobileNav?.querySelector<HTMLElement>('[data-view="' + mobileView + '"]') || null;
    }
    // A mobile Dashboard hides `.sidebar` too; Editor is the surface's only
    // route back to the Workbench, and the one nav button it keeps visible.
    if (mobile && surface.peek() === 'dashboard') {
      return app.dom.mobileNav?.querySelector<HTMLElement>('[data-view="editor"]') || null;
    }
    return null;
  };

  const settleFocus = (): void => {
    if (separator !== null && separator.isSessionActive()) return;
    const wideTarget = wideRestoreTarget();
    if (wideTarget !== null) {
      // This transition owns the outcome; drop any captured intent so a later
      // render cannot settle a stale one on top of it.
      settler.cancel();
      wideTarget.focus();
    } else {
      settler.settle(resolveDestination);
    }
    previousFocusedSection = layoutModel.layout.peek().focusedSection;
  };

  // ---- the context the view renders from -----------------------------------
  const ctx: ShellContext = {
    state,
    layout: layoutModel,
    surface,
    sideSplitPct,
    inspector,
    refs,
    onRailActivate: (section) => {
      // A rail click is a TOGGLE, not an idempotent open. The explicit
      // `.focus()` matters on WebKit, which does not focus a clicked button.
      toggleFocusedSection(app, section);
      railButton(section)?.focus();
    },
    onSidebarKeyDown: (e) => {
      if (e.key !== 'Escape') return;
      // Something nested already claimed this Escape — the search box, or a
      // saved-row edit form's own cancel. Respect that claim.
      if (e.defaultPrevented) return;
      // A focused drawer IS "rail mode with a section" (`navModeFor`), so
      // testing the section directly is both the mode check and the type
      // narrowing. The vanilla arm needed a SEPARATE defensive `section === null`
      // guard after its mode check, because its mode lived in a `data-nav-mode`
      // DOM attribute that could in principle disagree with state. Deriving the
      // mode from the layout makes that disagreement unrepresentable — so the
      // guard is not merely unnecessary here, it is unreachable, and keeping it
      // would be permanently dead code. One small, real win for the derived
      // model, and the only place in this arm where a whole guard disappears.
      const layout = layoutModel.layout.peek();
      const section = layout.focusedSection;
      if (layout.mode !== 'rail' || section === null) return;
      toggleFocusedSection(app, section);
      e.preventDefault();
      railButton(section)?.focus();
    },
    onMobileTab: (tab) => { state.mobileTab.value = tab; },
    onMobileView: (view) => {
      // On the Dashboard surface this bar is a route OUT, not a panel switcher:
      // return to the Workbench before selecting the panel, the same order
      // `openSavedQuery`/`openVariableTab` use.
      if (app.mainSurface.kind === 'dashboard') app.showQuerySurface();
      state.mobileView.value = view;
    },
    onSideSplitDown: (e) => { doStartDrag(e as unknown as DragStartEvent, 'sideRow', dragCtx); },
    settleFocus,
  };

  // Only 'sideRow' ever runs through this ctx — the editor/results splitter is
  // workbench-shell's own. `apply` writes a SIGNAL rather than the pane's
  // `style.height`, because the pane is Preact-owned and no vanilla code may
  // reach into it.
  const rectFor = (): DragRect => sidebar.get().getBoundingClientRect();
  const dragCtx: DragCtx = {
    state,
    rectFor,
    apply: (_axis, value) => { sideSplitPct.value = value; },
    save: (name, value) => prefs.save(name as PreferenceKey, value),
  };

  // ---- render --------------------------------------------------------------
  // Synchronous: every ref above is populated before this returns, which is
  // what lets the handle hand `queryHost` straight back to `ui/app.ts`.
  // Clear first, exactly as the vanilla arm's `root.replaceChildren(...)` did.
  // Preact appends into a container rather than owning it, so without this a
  // shell mounted after `renderLoginApp` (which writes the root directly) would
  // render the frame BESIDE the login UI instead of replacing it. `dispose()`
  // unmounts through Preact, so its own bookkeeping is always clean by here.
  root!.replaceChildren();
  render(ph(Shell, { ctx }), root!);

  separator = mountLeftNavSeparator({
    el: sideHandle.get(),
    state,
    prefs: { save: (name, value) => prefs.save(name as PreferenceKey, value) },
    getMaxNavigationTotalPx: measureMaxNavigationTotalPx,
    applyEffectiveLayout,
    announce,
  });
  const separatorHandle = separator;

  // An active pointer session keeps its own uncommitted layout, so a semantic
  // command that writes `state` directly while a drag is live would be silently
  // overwritten by that drag's eventual commit. Every caller of
  // `openFocusedSection`/`toggleFocusedSection` reaches this one choke point.
  app.preemptActiveResize = () => {
    if (!separatorHandle.isSessionActive()) return;
    separatorHandle.cancelActiveSession();
    batch(() => {
      layoutModel.dragLayout.value = null;
      layoutModel.bumpWidthRevision();
    });
  };

  // ---- effects -------------------------------------------------------------
  const disposers: (() => void)[] = [];

  // Focus intent is captured HERE, not at paint time: a bare effect runs
  // synchronously on the signal write, while Preact's re-render is scheduled —
  // so this observes the pre-transition DOM, which is the only moment
  // `document.activeElement` still names the element about to be hidden.
  // Preact offers no equivalent hook (`useLayoutEffect` cleanups run after the
  // diff), so ONE capture site replaces the vanilla arm's four inline ones.
  // Skipped mid-gesture: an intermediate drag frame must not overwrite the
  // intent the committed transition will settle.
  disposers.push(effect(() => {
    layoutModel.navMode.value;
    state.mobileView.value;
    state.isMobile.value;
    surface.value;
    if (separatorHandle.isSessionActive()) return;
    settler.capture(sidebar.get());
  }));

  // An `isMobile` crossing needs two side effects the derivation cannot express:
  // an active drag has no way to notice the viewport changed under it, and
  // `leftNavSection` is session-only, so a section focused on desktop would go
  // stale across a mobile round trip and return as a drawer whose title names
  // one section while its content shows another.
  let previousIsMobile = state.isMobile.value;
  disposers.push(effect(() => {
    const mobile = state.isMobile.value;
    if (mobile === previousIsMobile) return;
    previousIsMobile = mobile;
    separatorHandle.cancelActiveSession();
    batch(() => {
      layoutModel.dragLayout.value = null;
      state.leftNavSection.value = null;
    });
  }));

  // Two `hidden` writes the component model cannot reach: both switcher rows
  // are vanilla-owned foreign DOM (`renderUpperRoleTabs`/`renderLowerTabs`
  // `replaceChildren` them), so Preact may not put a prop on them. No
  // redundant switcher inside a drawer showing exactly one section.
  disposers.push(effect(() => {
    const hideWideOnlyChrome = layoutModel.navMode.value !== 'wide';
    app.dom.upperRoleTabs!.hidden = hideWideOnlyChrome;
    app.dom.savedTabsRow!.hidden = hideWideOnlyChrome;
  }));

  // The separator's own ARIA describes exactly this layout, and its internal
  // effect only re-runs on a mode/section change — never on a width-only one,
  // since the widths are plain fields. This keeps the two in step.
  disposers.push(effect(() => { separatorHandle.refreshAria(layoutModel.layout.value); }));

  // Reactive repaint of the schema tree: re-runs on schema load, load error,
  // filter text, or expand/collapse. Crossing the mobile breakpoint adds or
  // removes each row's drag source and hover title, so repaint on that too.
  disposers.push(effect(() => {
    state.schema.value;
    state.schemaError.value;
    state.schemaFilter.value;
    state.expanded.value;
    state.isMobile.value;
    renderSchema(app);
  }));
  // The upper role tabs. Both counts are reactive — the Databases count tracks
  // the schema load, the Dashboards count the committed collection.
  disposers.push(effect(() => {
    state.upperRole.value;
    state.schema.value;
    state.schemaError.value;
    state.dashboardTreeRevision.value;
    renderUpperRoleTabs(app);
  }));
  // Expose exactly one section per pane. Kept separate from the tab effect so a
  // schema load does not rebuild the tree.
  disposers.push(effect(() => { registry.showSection(state.upperRole.value); }));
  // Subscribed to `sidePanel` ALONE: a Dashboard mutation changes which rows
  // the Library shows, never which section is exposed.
  disposers.push(effect(() => { registry.showSection(sectionForSidePanelKey(state.sidePanel.value)); }));
  disposers.push(effect(() => {
    state.dashboardTreeRevision.value;
    state.upperRole.value;
    renderDashboardTree(app);
  }));
  disposers.push(effect(() => {
    state.schemaError.value;
    updateBanner();
  }));
  disposers.push(effect(() => {
    state.sidePanel.value;
    state.dashboardTreeRevision.value;
    renderLowerTabs(app);
  }));
  // Library membership is a function of `dashboards[]`, so a committed
  // Dashboard change can move a query in or out of this list without
  // `savedQueries` changing at all.
  disposers.push(effect(() => {
    state.dashboardTreeRevision.value;
    renderLibrarySection(app);
  }));
  // History has no signal to key an effect off (`state.history` is a plain
  // array), so it gets one direct initial paint and stays current via its own
  // mutation sites. Without this the host would stay empty until the first
  // history-recording event.
  renderHistorySection(app);
  disposers.push(effect(() => {
    state.libraryName.value;
    state.libraryDirty.value;
    renderLibraryTitle(app);
  }));
  // ConnectionSession is the single authority for the status chip. Registers
  // before the caller builds the header; `setHeader` performs the first real
  // paint once the chip exists.
  disposers.push(effect(() => {
    app.conn.connection.value;
    applyConnectionStatus(app);
  }));

  const mq = matchMedia && matchMedia('(max-width: ' + MOBILE_BREAKPOINT_PX + 'px)');
  const onMobileChange = (e: MediaQueryListEvent): void => { state.isMobile.value = e.matches; };
  if (mq) {
    state.isMobile.value = mq.matches;
    mq.addEventListener('change', onMobileChange);
  }

  // The shell-width observer. Unlike the vanilla arm this needs no
  // "skip while a gesture is active" guard: it updates the BUDGET, and the
  // gesture's own layout overrides the derivation for as long as it lasts.
  const disposeWidthObserver = observeElementWidth?.(mainRow.get(), (widthPx) => {
    if (!(widthPx > 0) || !Number.isFinite(widthPx)) return; // a detached element can report 0.
    layoutModel.bumpViewportEpoch();
  }) || null;

  catalog.loadSchema();
  catalog.loadReference();

  return {
    setHeader: (header: Element) => {
      headerSlot.get().replaceChildren(header);
      applyConnectionStatus(app);
    },
    authHost: authHost.get(),
    queryHost: queryHost.get(),
    dashboardHost: dashboardHost.get(),
    // Flushed synchronously: callers reveal a host and then act inside it
      // (`app.showQuerySurface()` immediately focuses the SQL editor), which a
      // microtask-deferred render breaks. See `flushSync`.
      showHost: (kind) => { flushSync(() => { surface.value = kind; }); },
    dispose: () => {
      // A deferred single-click must not fire against a tree being torn down —
      // the arbiter's timer outlives this DOM otherwise.
      cancelDashboardTreeClicks(app);
      for (const dispose of disposers) dispose();
      mq?.removeEventListener('change', onMobileChange);
      separatorHandle.dispose();
      inspector.dispose();
      disposeWidthObserver?.();
      // Unmount the component tree: this is what removes every listener Preact
      // attached, which in the vanilla arm was the rail's own `dispose()` plus
      // four per-button effects.
      render(null, root!);
    },
  };
}
