// #577 state S2 (Preact treatment) — the left navigation's presentation as
// DERIVED STATE rather than as a paint function.
//
// WHAT THIS REPLACES. The vanilla shell (S0/S1's `ui/app-shell.ts`) owns a
// ~100-line `applyEffectiveLeftNavigationLayout` that four separate triggers
// call — the mount-time paint, the preferred-state effect, the injected width
// observer, and the resize separator's own gesture callback — each of which
// then writes the same dozen `hidden`/`dataset`/`style`/ARIA properties by
// hand. Nothing in that design makes it impossible for a fifth trigger to paint
// a different table, and #487's own review history is largely the record of
// triggers being discovered one at a time.
//
// Here the same four triggers all resolve to ONE `computed`, and the
// presentation is whatever a component renders from it. The triggers stop being
// paint sites and become signal writes:
//
//   mount-time paint     -> nothing; the first render reads `layout`
//   preferred-state      -> already signals (`leftNavMode`/`leftNavSection`/`isMobile`)
//   width observer       -> writes `maxNavTotalPx`
//   separator gesture    -> writes `dragLayout`
//
// THE ONE HOLE, STATED PLAINLY. `state.sidebarPx` and `state.leftNavDrawerPx`
// are plain numbers, not signals (`application/left-nav.ts`'s own
// `LeftNavStateSlice` documents that split, and `state.ts` is domain this
// evaluation preserves verbatim). A commit that changes ONLY a width therefore
// changes nothing a `computed` can observe, so `widthRevision` exists purely to
// invalidate the derivation for that case. It is a real cost of the reactive
// model — reported as one, not hidden: the vanilla arm needs no equivalent
// because it repaints unconditionally.
//
// `dragLayout` is the other half of the same idea. A pointer/keyboard resize
// paints intermediate positions WITHOUT writing `state` (the drag is not
// committed until mouseup), which the vanilla arm expresses as a callback the
// separator invokes and a `isSessionActive()` guard every other trigger has to
// remember to consult. As a signal it is simply an override: while a gesture is
// live, `layout` is the gesture's own clamped layout, and every other trigger
// is naturally ignored because it feeds the branch that is not taken. The guard
// stops being a rule callers must obey and becomes the shape of the data.

import { computed, signal } from '@preact/signals';
import type { ReadonlySignal, Signal } from '@preact/signals-core';
import {
  clampLeftNavigationToMaximumTotal, effectiveLeftNavigationLayout,
} from '../../core/left-nav-layout.js';
import type { LeftNavigationLayout } from '../../core/left-nav-layout.js';
import { readLeftNavigationLayout } from '../../application/left-nav.js';
import type { LeftNavStateSlice } from '../../application/left-nav.js';

/** How `.main-row`/`.sidebar` present the left navigation. Identical vocabulary
 *  to the vanilla arm's `data-nav-mode`, so the two arms' rendered DOM is
 *  comparable attribute-for-attribute. */
export type NavMode = 'wide' | 'rail' | 'drawer';

/** The state this model reads. `isMobile` is the viewport class the mobile
 *  projection forces 'wide' from; the rest is `application/left-nav.ts`'s own
 *  slice, reused rather than re-declared. */
export interface ShellLayoutState extends LeftNavStateSlice {
  readonly isMobile: Signal<boolean>;
}

export interface ShellLayoutModel {
  /**
   * Bumped by the injected width-observer seam when `.main-row`'s own width
   * changes.
   *
   * It carries NO value. An earlier draft made the budget itself a signal the
   * observer wrote, which quietly changed the contract: the vanilla arm
   * measures `.main-row` LIVE on every derivation (`getMaxNavigationTotalPx`),
   * so it stays correctly clamped even when no observer was injected at all,
   * whereas a signal-valued budget stays `Infinity` until something writes it.
   * A real-browser e2e caught it — a viewport-clamped 420px preference rendered
   * at its full 420 instead of the clamped 313. The measurement stayed live and
   * this became a pure invalidation token.
   */
  readonly viewportEpoch: Signal<number>;
  /**
   * The in-progress gesture's own clamped layout, or `null` between gestures.
   * Non-null IS "a resize session is active" — the vanilla arm's
   * `isSessionActive()` guard, expressed as data.
   */
  readonly dragLayout: Signal<LeftNavigationLayout | null>;
  /** Bumped whenever a committed width changes without changing either signal
   *  the derivation reads. See this module's header. */
  readonly widthRevision: Signal<number>;
  /** The effective layout to render: the live gesture's, or the committed
   *  preference projected for the viewport class and clamped to the budget. */
  readonly layout: ReadonlySignal<LeftNavigationLayout>;
  /** `layout`'s presentation, the one value the whole shell renders from. */
  readonly navMode: ReadonlySignal<NavMode>;
  /** Invalidate the derivation after a width-only commit. */
  bumpWidthRevision(): void;
  /** Invalidate the derivation after the shell's own width changed. */
  bumpViewportEpoch(): void;
}

/** `createShellLayout`'s dependencies. */
export interface ShellLayoutDeps {
  state: ShellLayoutState;
  /**
   * The navigation's live pixel budget — `.main-row`'s current width minus the
   * separator's own footprint minus the centre surface's documented minimum.
   * Read FRESH on every derivation, never cached, exactly as the vanilla arm
   * reads it: the mount-time paint, the preferred-state derivation, the
   * separator's own session and the width observer must all see one
   * measurement. Returns a non-finite or negative number before the row is laid
   * out, which `clampLeftNavigationToMaximumTotal` already treats as "no
   * additional constraint".
   */
  measureMaxNavigationTotalPx(): number;
}

/**
 * The mode/section pair's presentation, as one value.
 *
 * `wide` shows both panes and no rail; `rail` shows the rail alone; `drawer`
 * shows the rail plus a single-section panel. The coherence invariant in
 * `core/left-nav-layout.ts` guarantees `focusedSection` is null throughout
 * 'wide', so this is total without a fourth case.
 */
export function navModeFor(layout: LeftNavigationLayout): NavMode {
  if (layout.mode === 'wide') return 'wide';
  return layout.focusedSection === null ? 'rail' : 'drawer';
}

/**
 * Build the derived-layout model for one shell mount.
 *
 * Every reader is a `computed`, so a component that renders `layout` or
 * `navMode` subscribes to exactly the inputs that actually reach it and to
 * nothing else — the vanilla arm had to reach for `untracked()` to stop its own
 * preferred-state effect from accidentally widening its dependencies to
 * `mobileView` (`app-shell.ts`'s own comment on that fix runs 12 lines), a
 * failure mode a derivation with no side effects does not have.
 */
export function createShellLayout(deps: ShellLayoutDeps): ShellLayoutModel {
  const { state, measureMaxNavigationTotalPx } = deps;
  const viewportEpoch = signal(0);
  const dragLayout = signal<LeftNavigationLayout | null>(null);
  const widthRevision = signal(0);

  const layout = computed<LeftNavigationLayout>(() => {
    const dragging = dragLayout.value;
    // A live gesture already clamped itself against the same budget on every
    // step it took (`advanceLeftNavigationResize`), so re-clamping here would
    // at best be redundant and at worst fight the gesture with a budget read at
    // a different instant.
    if (dragging !== null) return dragging;
    // Both tokens are read purely to subscribe: neither carries a value, and
    // the budget below is measured live.
    widthRevision.value;
    viewportEpoch.value;
    return clampLeftNavigationToMaximumTotal(
      effectiveLeftNavigationLayout(readLeftNavigationLayout(state), state.isMobile.value),
      measureMaxNavigationTotalPx(),
    );
  });

  return {
    viewportEpoch,
    dragLayout,
    widthRevision,
    layout,
    navMode: computed(() => navModeFor(layout.value)),
    bumpWidthRevision: () => { widthRevision.value += 1; },
    bumpViewportEpoch: () => { viewportEpoch.value += 1; },
  };
}
