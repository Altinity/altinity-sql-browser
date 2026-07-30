// #577 state S2 (Preact treatment) — `ui/shell/shell-layout.ts` replaces the
// vanilla arm's ~100-line `applyEffectiveLeftNavigationLayout` paint function
// with ONE `computed` derivation. What is pinned here is exactly the module's
// own header comment: the four triggers (mount, preferred-state, width
// observer, separator gesture) all resolve to the same `layout`/`navMode`
// signals, `dragLayout` is an override rather than a fourth reducer, and the
// one documented cost of the reactive model — a plain-field width write is
// invisible to a `computed` until `widthRevision` is bumped — is real and not
// papered over.
//
// This module composes `core/left-nav-layout.ts`'s reducers rather than
// reimplementing them, so most assertions below build the EXPECTED layout by
// calling those same reducers directly (`expectedLayout` below) instead of
// pinning a literal number. A hardcoded expectation would silently keep
// passing if a reducer's own behaviour changed underneath this module; calling
// the reducer is the only way a change there is guaranteed to show up here too.

import { describe, it, expect } from 'vitest';
import { effect, signal } from '@preact/signals-core';
import {
  createShellLayout, navModeFor,
} from '../../src/ui/shell/shell-layout.js';
import type { NavMode, ShellLayoutState } from '../../src/ui/shell/shell-layout.js';
import {
  clampLeftNavigationToMaximumTotal, effectiveLeftNavigationLayout,
  LEFT_DRAWER_DEFAULT_PX, LEFT_PANEL_MAX_PX, LEFT_WIDE_DEFAULT_PX,
} from '../../src/core/left-nav-layout.js';
import type { LeftNavigationLayout, LeftNavigationSection } from '../../src/core/left-nav-layout.js';
import { readLeftNavigationLayout } from '../../src/application/left-nav.js';
import type { SidePanelKey } from '../../src/core/left-nav-layout.js';

/** A fake `ShellLayoutState`, matching `left-nav.test.ts`'s own `makeState`
 *  idiom for the `LeftNavStateSlice` half — reused rather than reinvented —
 *  plus the one extra field this module reads that the controller slice does
 *  not: `isMobile`. Defaults to a rail, no-section, desktop state. */
function makeState(over: Partial<{
  mode: 'wide' | 'rail';
  sidebarPx: number;
  leftNavDrawerPx: number;
  section: LeftNavigationSection | null;
  upperRole: 'databases' | 'dashboards';
  sidePanel: SidePanelKey;
  isMobile: boolean;
}> = {}): ShellLayoutState {
  return {
    sidebarPx: over.sidebarPx ?? LEFT_WIDE_DEFAULT_PX,
    leftNavDrawerPx: over.leftNavDrawerPx ?? LEFT_DRAWER_DEFAULT_PX,
    leftNavMode: signal(over.mode ?? 'rail'),
    leftNavSection: signal(over.section ?? null),
    upperRole: signal(over.upperRole ?? 'databases'),
    sidePanel: signal(over.sidePanel ?? 'saved'),
    isMobile: signal(over.isMobile ?? false),
  };
}

/** The SAME derivation `createShellLayout`'s own `layout` computed performs,
 *  called directly against the reducers it composes. Every "re-derives" test
 *  below compares the model's live `layout.value` against a FRESH call to
 *  this, at the current `maxNavTotalPx`, so a mismatch can only mean this
 *  module diverged from its own documented composition — never a stale
 *  literal drifting out of sync with an unrelated reducer change. */
/** #577 S2 review fix — the budget stopped being a signal the caller writes and
 *  became a LIVE measurement plus an invalidation token, because a signal-valued
 *  budget stayed unconstrained whenever no width observer was injected (a real
 *  browser rendered a viewport-clamped 420px preference at its full 420). This
 *  box reproduces the real wiring: a mutable budget the injected measurement
 *  reads, and `bumpViewportEpoch()` to publish a change. */
function budgetBox(initial = Number.POSITIVE_INFINITY) {
  const box = { value: initial };
  return { box, measure: () => box.value };
}

function expectedLayout(state: ShellLayoutState, maxNavTotalPx: number): LeftNavigationLayout {
  return clampLeftNavigationToMaximumTotal(
    effectiveLeftNavigationLayout(readLeftNavigationLayout(state), state.isMobile.value),
    maxNavTotalPx,
  );
}

describe('navModeFor', () => {
  // These three cases are the whole of `NavMode`'s vocabulary — the module's
  // own doc comment says the coherence invariant in `core/left-nav-layout.ts`
  // makes this total without a fourth case, so there is nothing left to test
  // once wide/rail-bare/rail-focused are covered.

  it('is "wide" whenever mode is "wide", regardless of focusedSection', () => {
    // `navModeFor` itself performs no normalization — it only looks at
    // `layout.mode` — so this deliberately hands it a layout the real reducers
    // would never produce (a 'wide' mode paired with a non-null
    // focusedSection, which `normalizeLeftNavigationLayout` would heal) to
    // prove the "regardless of focusedSection" half of the rule is a property
    // of THIS function, not something it merely inherits by always being fed
    // an already-coherent layout.
    const bareWide: LeftNavigationLayout = {
      mode: 'wide', wideWidthPx: 300, drawerWidthPx: 200, focusedSection: null,
    };
    const incoherentWide: LeftNavigationLayout = { ...bareWide, focusedSection: 'library' };
    expect(navModeFor(bareWide)).toBe('wide');
    expect(navModeFor(incoherentWide)).toBe('wide');
  });

  it('is "rail" for mode "rail" with no focused section', () => {
    const layout: LeftNavigationLayout = {
      mode: 'rail', wideWidthPx: 300, drawerWidthPx: 200, focusedSection: null,
    };
    expect(navModeFor(layout)).toBe('rail');
  });

  it('is "drawer" for mode "rail" with a focused section', () => {
    const layout: LeftNavigationLayout = {
      mode: 'rail', wideWidthPx: 300, drawerWidthPx: 200, focusedSection: 'history',
    };
    expect(navModeFor(layout)).toBe('drawer');
  });
});

describe('createShellLayout — the initial derivation', () => {
  it('starts unconstrained: layout equals the reducer chain with no width shrink applied', () => {
    // `maxNavTotalPx` defaults to +Infinity — "not measured yet" — so the very
    // first frame must derive from the SAME two reducers a later width-bounded
    // frame uses, just with a budget that cannot possibly shrink anything.
    // Comparing against a literal object here would bless whatever
    // `effectiveLeftNavigationLayout`/`clampLeftNavigationToMaximumTotal`
    // happen to produce today; comparing against calling them directly means a
    // future change to either reducer is guaranteed to move this assertion too.
    const state = makeState({ mode: 'wide', sidebarPx: 300 });
    const budget = budgetBox();
    const model = createShellLayout({ state, measureMaxNavigationTotalPx: budget.measure });

    expect(budget.box.value).toBe(Number.POSITIVE_INFINITY);
    expect(model.layout.value).toEqual(expectedLayout(state, Number.POSITIVE_INFINITY));
    // Unconstrained means unshrunk — the wide width survives exactly as read.
    expect(model.layout.value.wideWidthPx).toBe(300);
  });
});

describe('createShellLayout — the live width budget', () => {
  it('writing a tighter budget re-derives and shrinks the wide width', () => {
    // 200 is comfortably below LEFT_PANEL_MAX_PX (420) and below the sidebar's
    // own 300px preference, so this budget provably clamps rather than merely
    // happening to equal the unclamped width.
    const state = makeState({ mode: 'wide', sidebarPx: 300 });
    const budget = budgetBox();
    const model = createShellLayout({ state, measureMaxNavigationTotalPx: budget.measure });

    budget.box.value = 200;
    model.bumpViewportEpoch();

    expect(model.layout.value).toEqual(expectedLayout(state, 200));
    expect(model.layout.value.wideWidthPx).toBe(200);
    expect(model.layout.value.wideWidthPx).toBeLessThan(300);
  });
});

describe('createShellLayout — isMobile', () => {
  it('flipping isMobile forces the mobile projection (wide, no focused section)', () => {
    // Start in rail mode with a drawer open — the shape mobile's projection
    // must override to the two-pane presentation, per
    // `effectiveLeftNavigationLayout`'s own contract.
    const state = makeState({ mode: 'rail', section: 'library' });
    const budget = budgetBox();
    const model = createShellLayout({ state, measureMaxNavigationTotalPx: budget.measure });
    expect(model.navMode.value).toBe('drawer');

    state.isMobile.value = true;

    expect(model.layout.value).toEqual(expectedLayout(state, budget.box.value));
    expect(model.layout.value.mode).toBe('wide');
    expect(model.layout.value.focusedSection).toBeNull();
    expect(model.navMode.value).toBe('wide');
  });
});

describe('createShellLayout — leftNavMode / leftNavSection', () => {
  it('changing leftNavSection alone re-derives the layout and navMode', () => {
    const state = makeState({ mode: 'rail', section: null });
    const budget = budgetBox();
    const model = createShellLayout({ state, measureMaxNavigationTotalPx: budget.measure });
    expect(model.navMode.value).toBe('rail');

    state.leftNavSection.value = 'library';

    expect(model.layout.value).toEqual(expectedLayout(state, budget.box.value));
    expect(model.layout.value.focusedSection).toBe('library');
    expect(model.navMode.value).toBe('drawer');
  });

  it('changing leftNavMode alone re-derives the layout and navMode', () => {
    const state = makeState({ mode: 'rail', section: null });
    const budget = budgetBox();
    const model = createShellLayout({ state, measureMaxNavigationTotalPx: budget.measure });
    expect(model.navMode.value).toBe('rail');

    state.leftNavMode.value = 'wide';

    expect(model.layout.value).toEqual(expectedLayout(state, budget.box.value));
    expect(model.layout.value.mode).toBe('wide');
    expect(model.navMode.value).toBe('wide');
  });
});

describe('createShellLayout — the width hole (documented, not hidden)', () => {
  // `state.sidebarPx`/`state.leftNavDrawerPx` are plain numbers, not signals —
  // `application/left-nav.ts`'s own `LeftNavStateSlice` says so, and the
  // module header here says a `computed` literally cannot see a write to one.
  // This is the single most load-bearing test in the file: it pins that real,
  // documented gap in the reactive model rather than letting a future change
  // quietly paper over it (which would also quietly invalidate the module's
  // own comment explaining why `widthRevision` exists at all).
  it('mutating sidebarPx alone does not change layout; bumpWidthRevision() then does', () => {
    const state = makeState({ mode: 'wide', sidebarPx: 300 });
    const budget = budgetBox();
    const model = createShellLayout({ state, measureMaxNavigationTotalPx: budget.measure });
    const before = model.layout.value;
    expect(before.wideWidthPx).toBe(300);

    // A plain field write — NOT a signal write. Nothing the `computed` reads
    // changed, so it must not recompute: same object, by identity.
    state.sidebarPx = 350;
    expect(model.layout.value).toBe(before);
    expect(model.layout.value.wideWidthPx).toBe(300);

    // Only now does the derivation catch up, because `widthRevision` is a
    // signal the computed DOES read.
    model.bumpWidthRevision();
    const after = model.layout.value;
    expect(after).not.toBe(before);
    expect(after.wideWidthPx).toBe(350);
    expect(after).toEqual(expectedLayout(state, budget.box.value));
  });
});

describe('createShellLayout — dragLayout overrides everything', () => {
  it('while dragLayout is set, layout returns exactly that object, NOT re-clamped', () => {
    const state = makeState({ mode: 'wide', sidebarPx: 300 });
    const budget = budgetBox();
    const model = createShellLayout({ state, measureMaxNavigationTotalPx: budget.measure });
    // A budget that WOULD shrink any ordinary wide layout, to prove the
    // override path skips `clampLeftNavigationToMaximumTotal` entirely rather
    // than merely producing a value that happens to look unclamped.
    budget.box.value = 100;
    model.bumpViewportEpoch();
    const gestureLayout: LeftNavigationLayout = {
      mode: 'wide', wideWidthPx: 399, drawerWidthPx: 200, focusedSection: null,
    };

    model.dragLayout.value = gestureLayout;

    expect(model.layout.value).toBe(gestureLayout);
    expect(model.layout.value.wideWidthPx).toBe(399);
    expect(model.navMode.value).toBe('wide');
  });

  it('setting dragLayout back to null returns to the committed derivation', () => {
    const state = makeState({ mode: 'wide', sidebarPx: 300 });
    const budget = budgetBox();
    const model = createShellLayout({ state, measureMaxNavigationTotalPx: budget.measure });
    model.dragLayout.value = {
      mode: 'wide', wideWidthPx: 399, drawerWidthPx: 200, focusedSection: null,
    };

    model.dragLayout.value = null;

    expect(model.layout.value).toEqual(expectedLayout(state, budget.box.value));
    expect(model.layout.value.wideWidthPx).toBe(300);
  });
});

describe('createShellLayout — layout and navMode are memoised computed signals', () => {
  it('reading layout twice with no input change returns the identical reference', () => {
    const state = makeState({ mode: 'wide', sidebarPx: 300 });
    const budget = budgetBox();
    const model = createShellLayout({ state, measureMaxNavigationTotalPx: budget.measure });

    const first = model.layout.value;
    const second = model.layout.value;

    expect(first).toBe(second);
  });

  it('reading navMode twice with no input change returns the identical value', () => {
    const state = makeState({ mode: 'rail', section: 'library' });
    const budget = budgetBox();
    const model = createShellLayout({ state, measureMaxNavigationTotalPx: budget.measure });

    const first = model.navMode.value;
    const second = model.navMode.value;

    expect(first).toBe(second);
  });

  it('an effect subscribed to navMode reruns exactly when its VALUE changes, not on every write', () => {
    const state = makeState({ mode: 'rail', section: null });
    const budget = budgetBox();
    const model = createShellLayout({ state, measureMaxNavigationTotalPx: budget.measure });
    const seen: NavMode[] = [];
    const dispose = effect(() => { seen.push(model.navMode.value); });
    seen.length = 0; // drop the install-time baseline run

    // A width-only commit: `layout` itself changes (a fresh object, per the
    // width-hole test above), but `mode`/`focusedSection` do not, so
    // `navMode`'s VALUE stays 'rail' and the effect must NOT rerun.
    model.bumpWidthRevision();
    expect(seen).toEqual([]);

    // A budget write with the same property: the layout recomputes, but
    // still-rail/still-unfocused means navMode's value is unchanged.
    budget.box.value = 200;
    model.bumpViewportEpoch();
    expect(seen).toEqual([]);

    // Now an actual navMode-changing input: rail -> drawer.
    state.leftNavSection.value = 'library';
    expect(seen).toEqual(['drawer']);

    // A drag override that also changes the presentation: drawer -> wide.
    model.dragLayout.value = {
      mode: 'wide', wideWidthPx: 300, drawerWidthPx: 200, focusedSection: null,
    };
    expect(seen).toEqual(['drawer', 'wide']);

    dispose();
  });
});
