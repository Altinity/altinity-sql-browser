// #577 state S2 (Preact treatment) — the application frame as rendered output.
//
// This is the component half of what S0/S1 build imperatively in
// `ui/app-shell.ts`. Everything `applyEffectiveLeftNavigationLayout` used to
// write by hand — `data-nav-mode` on two elements, the sidebar's width, five
// `hidden` toggles, the drawer title's text, `aria-labelledby`, and the
// one-pane-fills-the-column height override — is an expression here.
//
// TWO RULES THIS FILE IS BUILT AROUND. Both are load-bearing; violating either
// is a defect, not a style choice.
//
// 1. AN ELEMENT IS PREACT-OWNED OR ADOPTED, NEVER BOTH. Every element whose
//    children are written by an existing vanilla renderer (`renderSchema`,
//    `renderLowerTabs`, `renderUpperRoleTabs`, `updateBanner`,
//    `setMobileBadge`, the announce seams) is rendered here with ZERO Preact
//    children and handed back through a ref. Preact owns its identity and its
//    attributes; the vanilla renderer owns its children. Nothing writes both.
//
// 2. `layout`/`navMode` ARE READ BY LEAVES ONLY. A pointer resize writes the
//    layout signal on every native `mousemove`, and `@preact/signals` re-runs
//    every component that READ that signal during its own render. Measured on
//    this codebase over 200 simulated drag frames:
//
//        layout read by a leaf  ->  root 1 re-run,   rail 1 re-run
//        layout read by the root -> root 201 re-runs, rail 201 re-runs
//
//    So `Shell` must never touch `ctx.layout.layout` or `ctx.layout.navMode`,
//    and `MainRow` may read only `navMode` (which changes on a threshold
//    crossing, not per frame) — the per-frame width read belongs to `Sidebar`
//    alone. This is a genuine NEW obligation the imperative arm does not have:
//    there, "where you read state" has no performance consequence at all.

import { h as ph, Fragment } from 'preact';
import type { ComponentChildren } from 'preact';
import { useLayoutEffect } from 'preact/hooks';
import { NAV_SECTION_META } from '../nav-sections.js';
import { LEFT_NAV_SECTIONS } from '../../core/left-nav-layout.js';
import { InspectorView } from './right-inspector-view.js';
import type { ShellContext } from './shell-context.types.js';

/** The stable DOM ids the rail's four launchers address via `aria-controls`,
 *  and the focused drawer's own title via `aria-labelledby`. */
export const LEFT_NAV_DRAWER_ID = 'left-nav-drawer';
export const LEFT_NAV_TITLE_ID = 'left-nav-title';

/**
 * The compact icon rail. Four launchers, one per section in rail order, built
 * from the SAME registry the wide sidebar's switchers read, so a rail tooltip
 * can never disagree with a wide switcher's label for the same section.
 *
 * S1 needed one `effect()` per button to keep `aria-expanded` current (four
 * effects, four disposers, all four re-running on every change because signals
 * offer no per-effect diffing). Here it is an expression, and the rail's own
 * `dispose()` disappears with them.
 */
export function LeftRail(props: { ctx: ShellContext }): ComponentChildren {
  const { ctx } = props;
  const focused = ctx.state.leftNavSection.value;
  return ph('nav', {
    class: 'left-rail',
    'aria-label': 'Navigation rail',
    hidden: ctx.layout.navMode.value === 'wide',
    ref: ctx.refs.setLeftRail,
  }, ...LEFT_NAV_SECTIONS.map((section) => ph('button', {
    type: 'button',
    class: 'left-rail-btn',
    'data-section': section,
    title: NAV_SECTION_META[section].label,
    'aria-label': NAV_SECTION_META[section].accessibleLabel,
    'aria-controls': LEFT_NAV_DRAWER_ID,
    'aria-expanded': focused === section ? 'true' : 'false',
    // Explicit `.focus()`, not left to native click-focus: WebKit does not
    // focus a clicked button (a long-standing engine difference), so without
    // this Safari drops focus to `<body>` when a rail click closes the drawer.
    onClick: () => { ctx.onRailActivate(section); },
    // `Icon.*()` returns a detached SVG element, which a vDOM cannot embed —
    // the ref-mounter ADR-0001's own Preact spike already identified as a
    // required seam. Hoisted in the host so the ref identity is stable across
    // the 200-odd re-renders a single drag produces.
    ref: ctx.refs.railIcon(section),
  })));
}

/**
 * `.sidebar` — the element that is RE-PRESENTED, never moved or rebuilt. The
 * same node renders as the wide two-pane sidebar or as the rail's focused
 * drawer depending on `navMode`, which is what keeps every one of the four
 * section hosts at its exact DOM identity across a mode change.
 *
 * This is the ONLY component that reads the per-frame width (see rule 2).
 */
export function Sidebar(props: { ctx: ShellContext }): ComponentChildren {
  const { ctx } = props;
  const layout = ctx.layout.layout.value;
  const navMode = ctx.layout.navMode.value;
  const focused = layout.focusedSection;
  const upperFocused = navMode === 'drawer' && (focused === 'databases' || focused === 'dashboards');
  const lowerFocused = navMode === 'drawer' && (focused === 'library' || focused === 'history');
  // The rail's own width never resizes, so only 'wide' and 'drawer' have a
  // meaningful pixel width; 'rail' hides `.sidebar` entirely, so this is a
  // harmless non-stale filler rather than a leftover from the previous mode.
  const widthPx = navMode === 'drawer' ? layout.drawerWidthPx : layout.wideWidthPx;
  // A drawer showing ONLY the upper pane must fill the sidebar's whole height —
  // its height is otherwise the wide two-pane split percentage, which would
  // leave the bottom of the drawer empty once the lower pane collapses.
  const upperStyle = upperFocused
    ? { flex: '1', height: 'auto', flexShrink: '0', minHeight: '0' }
    : { flex: '', height: ctx.sideSplitPct.value + '%', flexShrink: '0', minHeight: '0' };
  // No redundant switcher inside a drawer already showing exactly one section,
  // and no resize handle between two panes when only one is visible.
  const hideWideOnlyChrome = navMode !== 'wide';

  return ph('div', {
    class: 'sidebar',
    id: LEFT_NAV_DRAWER_ID,
    'data-nav-mode': navMode,
    'data-mobile-tab': ctx.state.mobileTab.value,
    // Only the focused drawer has one single-purpose heading to label itself
    // with — pointing `aria-labelledby` at a hidden title in either other mode
    // would be a stale reference, not a helpful one.
    'aria-labelledby': navMode === 'drawer' ? LEFT_NAV_TITLE_ID : null,
    hidden: navMode === 'rail',
    style: { width: widthPx + 'px' },
    onKeyDown: ctx.onSidebarKeyDown,
    ref: ctx.refs.setSidebar,
  },
  ph('div', {
    class: 'left-nav-title', id: LEFT_NAV_TITLE_ID, hidden: navMode !== 'drawer',
    ref: ctx.refs.setLeftNavTitle,
  }, navMode === 'drawer' && focused ? NAV_SECTION_META[focused].label : ''),
  // Mobile Tables view: a segmented control at the top of the sidebar. CSS
  // hides it above the breakpoint; below it, `data-mobile-tab` above drives
  // both the active-button style and which pane shows — no JS effect needed.
  // Each button's ENTIRE content (icon + label) is adopted as one pre-built
  // pair rather than mixing an adopted icon with a Preact label — that would
  // put two owners on one element's children and would append the icon after
  // the label. Adopting both keeps the rendered DOM byte-identical to S0/S1's.
  ph('div', { class: 'mobile-segmented', ref: ctx.refs.setMobileSegmented },
    ph('button', { class: 'mseg-btn', 'data-seg': 'schema', onClick: () => { ctx.onMobileTab('schema'); }, ref: ctx.refs.segContent('schema') }),
    ph('button', { class: 'mseg-btn', 'data-seg': 'library', onClick: () => { ctx.onMobileTab('library'); }, ref: ctx.refs.segContent('library') })),
  // Both panes are ADOPTED: their children are the section registry's four
  // persistent hosts plus the two vanilla-repainted switcher rows. Zero Preact
  // children here is what makes rule 1 checkable.
  ph('div', {
    class: 'side-pane schema-pane', hidden: !(navMode === 'wide' || upperFocused),
    style: upperStyle, ref: ctx.refs.adoptUpperPane,
  }),
  ph('div', {
    class: 'row-resize side-split', hidden: hideWideOnlyChrome,
    onMouseDown: ctx.onSideSplitDown, ref: ctx.refs.setSideSplit,
  }),
  ph('div', {
    class: 'side-pane saved-pane', hidden: !(navMode === 'wide' || lowerFocused),
    style: { flex: '1', minHeight: '0' }, ref: ctx.refs.adoptLowerPane,
  }));
}

/** The bottom-tab nav. `data-mobile-view` on `.main-row` (not a class here)
 *  drives the active state, exactly as in S0/S1. */
export function MobileNav(props: { ctx: ShellContext }): ComponentChildren {
  const { ctx } = props;
  // `.mnav-ic` adopts its icon — and, for Results, the live badge element,
  // whose TEXT is written by a workbench-owned effect through
  // `app.dom.mobileBadge`. Both are pre-built in the host, so `.mnav-ic` has
  // zero Preact children and the badge keeps exactly one writer.
  const button = (view: 'tables' | 'editor' | 'results', label: string): ComponentChildren => ph('button', {
    class: 'mobile-nav-btn', 'data-view': view, onClick: () => { ctx.onMobileView(view); },
  }, ph('span', { class: 'mnav-ic', ref: ctx.refs.navIcon(view) }),
  ph('span', { class: 'mnav-label' }, label));
  return ph('div', { class: 'mobile-nav', ref: ctx.refs.setMobileNav },
    button('tables', 'Tables'),
    button('editor', 'Editor'),
    button('results', 'Results'));
}

/**
 * `.main-row`. Reads `navMode` (which changes on a threshold crossing, not per
 * drag frame) and the two other presentation attributes; never the width.
 */
export function MainRow(props: { ctx: ShellContext }): ComponentChildren {
  const { ctx } = props;
  const navMode = ctx.layout.navMode.value;
  return ph('div', {
    class: 'main-row',
    'data-nav-mode': navMode,
    'data-mobile-view': ctx.state.mobileView.value,
    'data-surface': ctx.surface.value,
    ref: ctx.refs.setMainRow,
  },
  // The rail is the FIRST child — the compact presentation reads left-to-right
  // as rail, then whatever `.sidebar` is currently presenting, then the work
  // surfaces, then the inspector.
  ph(LeftRail, { ctx }),
  ph(Sidebar, { ctx }),
  // The separator: Preact renders the element and never touches it again.
  // `mountLeftNavSeparator` is the sole writer of its role/tabindex/ARIA and of
  // its `.dragging` class — verified safe because Preact does not rewrite a
  // prop whose value has not changed.
  ph('div', { class: 'col-resize', ref: ctx.refs.setSideHandle }),
  ph('div', { class: 'query-host', hidden: ctx.surface.value !== 'query', ref: ctx.refs.setQueryHost }),
  ph('div', { class: 'dashboard-host', hidden: ctx.surface.value !== 'dashboard', ref: ctx.refs.setDashboardHost }),
  ph(InspectorView, { model: ctx.inspector }));
}

/**
 * The shell root.
 *
 * Deliberately reads NO layout signal (rule 2). Its own layout effect is where
 * focus settles: it runs after the diff is applied and before the browser
 * paints, which is the "destination exists, user has not seen the wrong thing
 * yet" window #577's focus contract asks for.
 */
export function Shell(props: { ctx: ShellContext }): ComponentChildren {
  const { ctx } = props;
  // Subscribing to the transition inputs (NOT to `layout`) is what schedules
  // this effect at the right moments: a mode/section change, a mobile panel
  // change, a surface swap, a viewport-class crossing.
  const navMode = ctx.layout.navMode.value;
  const section = ctx.state.leftNavSection.value;
  const mobileView = ctx.state.mobileView.value;
  const surface = ctx.surface.value;
  const isMobile = ctx.state.isMobile.value;
  useLayoutEffect(() => {
    ctx.settleFocus();
  }, [navMode, section, mobileView, surface, isMobile]);

  // A Fragment, never a wrapper element: `.main-row` and `.mobile-nav` must
  // stay SIBLINGS for the mobile CSS, which selects the nav's active state
  // through `.main-row[data-mobile-view="…"] ~ .mobile-nav` (styles.css:3339).
  // One extra div here would silently break every mobile active state.
  return ph(Fragment, null,
    ph('div', { class: 'app-header-slot', ref: ctx.refs.setHeaderSlot }),
    // Stable host for in-shell authentication controls: sits immediately below
    // the header and starts hidden, so lifecycle wiring can reveal it without
    // replacing either work surface.
    ph('div', {
      class: 'auth-host', hidden: true, role: 'region',
      'aria-label': 'Authentication required', ref: ctx.refs.setAuthHost,
    }),
    // `updateBanner` (app.ts) owns this element's children AND its
    // `style.display`; Preact sets only its class. Its first run happens at
    // mount through the schemaError effect, which is what hides it initially —
    // S0/S1 needed an inline `display: none` for the same reason.
    ph('div', { class: 'auth-banner', ref: ctx.refs.setBanner }),
    ph(MainRow, { ctx }),
    // A visually-hidden live region both shell edges announce through.
    ph('div', { class: 'sr-only', role: 'status', 'aria-live': 'polite', ref: ctx.refs.setLeftNavStatus }),
    ph(MobileNav, { ctx }));
}
