// #577 state S2 — the one object `shell-view.ts`'s components read.
//
// Type-only (ADR-0002 phase 0), so it is excluded from coverage and erased by
// esbuild. It exists so the view is a pure function of a context the host
// builds, rather than reaching for module-level state — which is what lets the
// whole component tree be rendered in a test against a plain fixture.

import type { Signal } from '@preact/signals-core';
import type { AppState } from '../../state.js';
import type { LeftNavigationSection } from '../../core/left-nav-layout.js';
import type { ShellLayoutModel } from './shell-layout.js';
import type { InspectorModel } from './right-inspector-view.js';

/** Which main work surface owns the right-hand work area. */
export type SurfaceHostKind = 'query' | 'dashboard';

/** A Preact ref callback. */
export type ElementRef = (el: HTMLElement | null) => void;

/**
 * Every ref the view attaches. All are HOISTED — built once by the host and
 * reused for the life of the shell — because a drag re-renders `Sidebar` on
 * every `mousemove`, and a ref whose function identity changed on each render
 * would make Preact detach and reattach it 200 times per gesture.
 */
export interface ShellRefs {
  setMainRow: ElementRef;
  setSidebar: ElementRef;
  setSideHandle: ElementRef;
  setSideSplit: ElementRef;
  setLeftRail: ElementRef;
  setLeftNavTitle: ElementRef;
  setLeftNavStatus: ElementRef;
  setMobileSegmented: ElementRef;
  setMobileNav: ElementRef;
  setHeaderSlot: ElementRef;
  setAuthHost: ElementRef;
  setBanner: ElementRef;
  setQueryHost: ElementRef;
  setDashboardHost: ElementRef;
  /** The upper pane adopts the role-tab row plus the registry's two upper
   *  section hosts; the lower pane adopts its tab row plus the other two. */
  adoptUpperPane: ElementRef;
  adoptLowerPane: ElementRef;
  /** Per-section / per-button content, pre-built vanilla so the rendered DOM
   *  stays byte-identical to S0/S1's (icon first, then label). */
  railIcon(section: LeftNavigationSection): ElementRef;
  segContent(segment: 'schema' | 'library'): ElementRef;
  navIcon(view: 'tables' | 'editor' | 'results'): ElementRef;
}

export interface ShellContext {
  state: AppState;
  layout: ShellLayoutModel;
  /** Which host is exposed. A signal, so `showHost` is a state write and the
   *  two `hidden` toggles plus `.main-row[data-surface]` are rendered. */
  surface: Signal<SurfaceHostKind>;
  /** The upper pane's height percentage. A signal rather than a direct
   *  `style.height` write, because the pane is Preact-owned and the sideRow
   *  drag must not reach into it. */
  sideSplitPct: Signal<number>;
  inspector: InspectorModel;
  refs: ShellRefs;
  onRailActivate(section: LeftNavigationSection): void;
  onSidebarKeyDown(ev: KeyboardEvent): void;
  onMobileTab(tab: 'schema' | 'library'): void;
  onMobileView(view: 'tables' | 'editor' | 'results'): void;
  onSideSplitDown(ev: MouseEvent): void;
  /** Called from `Shell`'s layout effect, after the destination is rendered. */
  settleFocus(): void;
}
