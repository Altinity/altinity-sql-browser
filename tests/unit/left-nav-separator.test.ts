// #487 phase 3 — the left navigation's resize/mode-changing separator
// (`src/ui/left-nav-separator.ts`). Follows `splitters.test.ts`'s fake-window
// drag-simulation pattern. Exercises: ARIA state (including the
// aria-valuetext-must-report-the-SAME-quantity-as-aria-valuenow regression),
// the pointer drag session (intermediate `applyEffectiveLayout` calls, the
// final committed state matching the REAL core reducers — not a mock of
// them), the restore-while-clamped preferred-width regression, mouseup's own
// final coordinate winning over the last mousemove, blur/visibilitychange
// terminating a drag without a rollback, keyboard parity, announce-on-
// semantic-change-only, and dispose() removing every listener.

import { describe, it, expect, vi } from 'vitest';
import { signal } from '@preact/signals-core';
import { mountLeftNavSeparator } from '../../src/ui/left-nav-separator.js';
import type {
  LeftNavSeparatorDeps, LeftNavSeparatorTarget, LeftNavSeparatorWindow,
} from '../../src/ui/left-nav-separator.js';
import {
  LEFT_DRAWER_DEFAULT_PX, LEFT_RAIL_PX, LEFT_WIDE_DEFAULT_PX,
} from '../../src/core/left-nav-layout.js';
import type { LeftNavigationSection } from '../../src/core/left-nav-layout.js';
import type { LeftNavStateSlice } from '../../src/application/left-nav.js';
import type { SidePanelKey } from '../../src/core/left-nav-layout.js';

const LARGE_BUDGET = 10_000; // effectively "no viewport constraint" (static [180,420] still applies).

/** Mirrors `left-nav.test.ts`'s own `makeState` — the real `LeftNavStateSlice`
 *  shape, so `readLeftNavigationLayout` (imported for real inside the module
 *  under test) needs no bridging. */
function makeState(over: Partial<{
  mode: 'wide' | 'rail';
  sidebarPx: number;
  leftNavDrawerPx: number;
  section: LeftNavigationSection | null;
  upperRole: 'databases' | 'dashboards';
  sidePanel: SidePanelKey;
}> = {}): LeftNavStateSlice {
  return {
    sidebarPx: over.sidebarPx ?? LEFT_WIDE_DEFAULT_PX,
    leftNavDrawerPx: over.leftNavDrawerPx ?? LEFT_DRAWER_DEFAULT_PX,
    leftNavMode: signal(over.mode ?? 'wide'),
    leftNavSection: signal(over.section ?? null),
    upperRole: signal(over.upperRole ?? 'databases'),
    sidePanel: signal(over.sidePanel ?? 'saved'),
  };
}

/** Fake `window`-shaped seam — single handler per event type (this module
 *  never registers two at once for the same type), mirroring
 *  `splitters.test.ts`'s own `fakeWin`. */
function fakeWin(): LeftNavSeparatorWindow & { _fire(t: string, ev?: { clientX: number }): void; _has(t: string): boolean } {
  const handlers: Record<string, (ev: { clientX: number }) => void> = {};
  return {
    addEventListener: (t: string, fn: (ev: { clientX: number }) => void) => { handlers[t] = fn; },
    removeEventListener: vi.fn((t: string) => { delete handlers[t]; }),
    _fire: (t: string, ev: { clientX: number } = { clientX: 0 }) => { handlers[t]?.(ev); },
    _has: (t: string) => !!handlers[t],
  };
}

/** Fake `document`-shaped seam for `visibilitychange`. */
function fakeTarget(): LeftNavSeparatorTarget & { _fire(t: string): void; _has(t: string): boolean } {
  const handlers: Record<string, () => void> = {};
  return {
    addEventListener: (t: string, fn: () => void) => { handlers[t] = fn; },
    removeEventListener: vi.fn((t: string) => { delete handlers[t]; }),
    _fire: (t: string) => { handlers[t]?.(); },
    _has: (t: string) => !!handlers[t],
  };
}

function makeDeps(state: LeftNavStateSlice, budget: number = LARGE_BUDGET) {
  const el = document.createElement('div');
  const win = fakeWin();
  const target = fakeTarget();
  const save = vi.fn();
  const applyEffectiveLayout = vi.fn();
  const announce = vi.fn();
  const getMaxNavigationTotalPx = vi.fn(() => budget);
  const deps: LeftNavSeparatorDeps = {
    el, win, target, state, prefs: { save }, getMaxNavigationTotalPx, applyEffectiveLayout, announce,
  };
  return { deps, el, win, target, save, applyEffectiveLayout, announce, getMaxNavigationTotalPx };
}

function mousedown(el: HTMLElement, clientX: number): void {
  el.dispatchEvent(new MouseEvent('mousedown', { clientX, cancelable: true }));
}
function keydown(el: HTMLElement, init: KeyboardEventInit): KeyboardEvent {
  const ev = new KeyboardEvent('keydown', { cancelable: true, ...init });
  el.dispatchEvent(ev);
  return ev;
}

describe('mountLeftNavSeparator — mount-time ARIA', () => {
  it('sets role/orientation/tabindex once at mount', () => {
    const { deps, el } = makeDeps(makeState());
    mountLeftNavSeparator(deps);
    expect(el.getAttribute('role')).toBe('separator');
    expect(el.getAttribute('aria-orientation')).toBe('vertical');
    expect(el.getAttribute('tabindex')).toBe('0');
  });

  it('wide mode: aria-valuenow/valuetext report the wide width', () => {
    const { deps, el } = makeDeps(makeState({ mode: 'wide', sidebarPx: 248 }));
    mountLeftNavSeparator(deps);
    expect(el.getAttribute('aria-valuemin')).toBe(String(LEFT_RAIL_PX));
    expect(el.getAttribute('aria-valuemax')).toBe('420');
    expect(el.getAttribute('aria-valuenow')).toBe('248');
    expect(el.getAttribute('aria-valuetext')).toBe('Wide sidebar, 248 pixels');
  });

  it('bare rail: aria-valuenow/valuetext report the rail width alone', () => {
    const { deps, el } = makeDeps(makeState({ mode: 'rail', section: null }));
    mountLeftNavSeparator(deps);
    expect(el.getAttribute('aria-valuenow')).toBe('48');
    expect(el.getAttribute('aria-valuetext')).toBe('Rail only, 48 pixels');
  });

  it('rail + open drawer: aria-valuenow/valuetext report rail+drawer TOTAL, not the panel alone', () => {
    const { deps, el } = makeDeps(makeState({ mode: 'rail', section: 'library', leftNavDrawerPx: 240 }));
    mountLeftNavSeparator(deps);
    // The documented regression: an earlier design reported the drawer's OWN
    // 240px panel width here, not the 288px total the rail ALSO occupies.
    expect(el.getAttribute('aria-valuenow')).toBe('288');
    expect(el.getAttribute('aria-valuetext')).toBe('Rail with Library drawer, 288 pixels total');
  });

  it('aria-valuetext always names the SAME number aria-valuenow carries, in every mode', () => {
    const cases: Array<Partial<{ mode: 'wide' | 'rail'; sidebarPx: number; section: LeftNavigationSection | null }>> = [
      { mode: 'wide', sidebarPx: 300 },
      { mode: 'rail', section: null },
      { mode: 'rail', section: 'history' },
    ];
    for (const over of cases) {
      const { deps, el } = makeDeps(makeState(over));
      mountLeftNavSeparator(deps);
      const now = el.getAttribute('aria-valuenow');
      const text = el.getAttribute('aria-valuetext')!;
      expect(text).toContain(`${now} pixel`);
    }
  });

  it('ARIA updates reactively when leftNavSection changes after mount (e.g. a rail click elsewhere)', () => {
    const state = makeState({ mode: 'rail', section: null });
    const { deps, el } = makeDeps(state);
    mountLeftNavSeparator(deps);
    expect(el.getAttribute('aria-valuenow')).toBe('48');
    state.leftNavSection.value = 'history';
    expect(el.getAttribute('aria-valuenow')).toBe('288');
    expect(el.getAttribute('aria-valuetext')).toBe('Rail with History drawer, 288 pixels total');
  });
});

describe('mountLeftNavSeparator — pointer drag', () => {
  it('mousedown→mousemove(s)→mouseup: applyEffectiveLayout runs each step; final state matches the real reducers', () => {
    const state = makeState({ mode: 'rail', section: null, sidebarPx: 248, leftNavDrawerPx: 240 });
    const { deps, el, win, save, applyEffectiveLayout, announce } = makeDeps(state);
    mountLeftNavSeparator(deps);

    mousedown(el, 0);
    expect(el.classList.contains('dragging')).toBe(true);

    win._fire('mousemove', { clientX: 300 }); // crosses the wide threshold from a bare rail
    win._fire('mousemove', { clientX: 350 });
    win._fire('mouseup', { clientX: 400 });

    expect(applyEffectiveLayout).toHaveBeenNthCalledWith(1,
      { mode: 'wide', wideWidthPx: 300, drawerWidthPx: 240, focusedSection: null });
    expect(applyEffectiveLayout).toHaveBeenNthCalledWith(2,
      { mode: 'wide', wideWidthPx: 350, drawerWidthPx: 240, focusedSection: null });
    expect(applyEffectiveLayout).toHaveBeenNthCalledWith(3,
      { mode: 'wide', wideWidthPx: 400, drawerWidthPx: 240, focusedSection: null });

    expect(el.classList.contains('dragging')).toBe(false);
    expect(state.leftNavMode.value).toBe('wide');
    expect(state.sidebarPx).toBe(400);
    expect(state.leftNavDrawerPx).toBe(240); // dormant band untouched
    expect(state.leftNavSection.value).toBeNull();
    expect(save).toHaveBeenCalledWith('leftNavMode', 'wide');
    expect(save).toHaveBeenCalledWith('sidebarPx', 400);
    expect(save).toHaveBeenCalledWith('leftNavDrawerPx', 240);
    expect(announce).toHaveBeenCalledWith('Left navigation: Wide sidebar'); // rail -> wide is a semantic change
    expect(win._has('mousemove')).toBe(false);
    expect(win._has('mouseup')).toBe(false);
  });

  it('mouseup uses ITS OWN final clientX, not the last mousemove\'s', () => {
    const state = makeState({ mode: 'wide', sidebarPx: 248 });
    const { deps, el, win } = makeDeps(state);
    mountLeftNavSeparator(deps);

    mousedown(el, 248);
    win._fire('mousemove', { clientX: 260 });
    win._fire('mouseup', { clientX: 350 }); // deliberately different from the last mousemove

    expect(state.sidebarPx).toBe(350);
  });

  it('a restore-while-clamped End keypress persists the FULL preferred width, not the viewport-clamped one', () => {
    // sidebarPx (420) is larger than the viewport can currently render (300) —
    // the exact scenario the core `LeftNavigationResizeSession` design fixed.
    const state = makeState({ mode: 'rail', section: null, sidebarPx: 420, leftNavDrawerPx: 240 });
    const { deps, el, save, applyEffectiveLayout } = makeDeps(state, 300);
    mountLeftNavSeparator(deps);

    keydown(el, { key: 'End' });

    expect(state.leftNavMode.value).toBe('wide');
    expect(state.sidebarPx).toBe(420); // full preferred value, not the clamped 300
    expect(save).toHaveBeenCalledWith('sidebarPx', 420);
    // The rendered ARIA reflects the viewport's actual current clamp.
    expect(el.getAttribute('aria-valuenow')).toBe('300');
    // And the ACTUAL PAINT must use the session's own viewport-clamped
    // `effective` layout (300), never the committed/persisted 420 — painting
    // 420 directly here would render a sidebar wider than the viewport can
    // hold, reintroducing a variant of the exact bug this session design
    // exists to prevent. This is the regression this fix is for: previously
    // `commitSession` never called `applyEffectiveLayout` at all on the
    // keyboard path, so nothing painted here whatsoever.
    expect(applyEffectiveLayout).toHaveBeenCalledWith(
      { mode: 'wide', wideWidthPx: 300, drawerWidthPx: 240, focusedSection: null });
  });

  it('a plain within-mode ArrowRight keypress paints the new width, not just state/ARIA', () => {
    // Before this fix, `commitSession` never called `applyEffectiveLayout` on
    // the keyboard path at all: a within-mode resize updated `state` and the
    // separator's own ARIA attributes but never repainted the sidebar.
    const state = makeState({ mode: 'wide', sidebarPx: 248, leftNavDrawerPx: 240 });
    const { deps, el, applyEffectiveLayout } = makeDeps(state);
    mountLeftNavSeparator(deps);

    keydown(el, { key: 'ArrowRight' });

    expect(state.sidebarPx).toBe(264);
    expect(applyEffectiveLayout).toHaveBeenCalledWith(
      { mode: 'wide', wideWidthPx: 264, drawerWidthPx: 240, focusedSection: null });
  });

  it('blur terminates an active drag: listeners removed, session committed AS-IS (no rollback)', () => {
    const state = makeState({ mode: 'wide', sidebarPx: 248 });
    const { deps, el, win } = makeDeps(state);
    mountLeftNavSeparator(deps);

    mousedown(el, 248);
    win._fire('mousemove', { clientX: 300 });
    win._fire('blur');

    expect(win._has('mousemove')).toBe(false);
    expect(win._has('mouseup')).toBe(false);
    expect(state.sidebarPx).toBe(300); // the mid-drag value, not the pre-drag 248
    expect(el.classList.contains('dragging')).toBe(false);
  });

  it('visibilitychange terminates an active drag the same way', () => {
    const state = makeState({ mode: 'wide', sidebarPx: 248 });
    const { deps, el, win, target } = makeDeps(state);
    mountLeftNavSeparator(deps);

    mousedown(el, 248);
    win._fire('mousemove', { clientX: 320 });
    target._fire('visibilitychange');

    expect(win._has('mousemove')).toBe(false);
    expect(win._has('mouseup')).toBe(false);
    expect(state.sidebarPx).toBe(320);
  });

  it('blur/visibilitychange are no-ops when no drag is in progress', () => {
    const state = makeState({ mode: 'wide', sidebarPx: 248 });
    const { deps, win, target, save } = makeDeps(state);
    mountLeftNavSeparator(deps);

    win._fire('blur');
    target._fire('visibilitychange');

    expect(save).not.toHaveBeenCalled();
    expect(state.sidebarPx).toBe(248);
  });
});

describe('mountLeftNavSeparator — keyboard', () => {
  it('ArrowRight/ArrowLeft step by LEFT_NAV_STEP_PX within wide mode (no announce — same mode)', () => {
    const state = makeState({ mode: 'wide', sidebarPx: 248 });
    const { deps, el, announce } = makeDeps(state);
    mountLeftNavSeparator(deps);

    const ev = keydown(el, { key: 'ArrowRight' });
    expect(state.sidebarPx).toBe(264);
    expect(ev.defaultPrevented).toBe(true);

    keydown(el, { key: 'ArrowLeft' });
    expect(state.sidebarPx).toBe(248);
    expect(announce).not.toHaveBeenCalled();
  });

  it('Shift+ArrowRight/Shift+ArrowLeft step by LEFT_NAV_LARGE_STEP_PX', () => {
    const state = makeState({ mode: 'wide', sidebarPx: 248 });
    const { deps, el } = makeDeps(state);
    mountLeftNavSeparator(deps);

    keydown(el, { key: 'ArrowRight', shiftKey: true });
    expect(state.sidebarPx).toBe(312);

    keydown(el, { key: 'ArrowLeft', shiftKey: true });
    expect(state.sidebarPx).toBe(248);
  });

  it('Home folds to a bare rail; End restores wide — both announce a semantic change', () => {
    const state = makeState({ mode: 'wide', sidebarPx: 248, leftNavDrawerPx: 240 });
    const { deps, el, announce, applyEffectiveLayout } = makeDeps(state);
    mountLeftNavSeparator(deps);

    keydown(el, { key: 'Home' });
    expect(state.leftNavMode.value).toBe('rail');
    expect(state.leftNavSection.value).toBeNull();
    expect(announce).toHaveBeenCalledWith('Left navigation: Rail only');
    // Every commit path — keyboard included — must actually paint, not just
    // update state/ARIA.
    expect(applyEffectiveLayout).toHaveBeenCalledWith(
      { mode: 'rail', wideWidthPx: 248, drawerWidthPx: 240, focusedSection: null });

    keydown(el, { key: 'End' });
    expect(state.leftNavMode.value).toBe('wide');
    expect(announce).toHaveBeenCalledWith('Left navigation: Wide sidebar');
    expect(applyEffectiveLayout).toHaveBeenCalledWith(
      { mode: 'wide', wideWidthPx: 248, drawerWidthPx: 240, focusedSection: null });
  });

  it('an unhandled key does nothing and does not call preventDefault', () => {
    const state = makeState({ mode: 'wide', sidebarPx: 248 });
    const { deps, el, save } = makeDeps(state);
    mountLeftNavSeparator(deps);

    const ev = keydown(el, { key: 'a' });
    expect(ev.defaultPrevented).toBe(false);
    expect(state.sidebarPx).toBe(248);
    expect(save).not.toHaveBeenCalled();
  });

  it('Ctrl/Meta/Alt chords are rejected, even for an otherwise-handled key', () => {
    const state = makeState({ mode: 'wide', sidebarPx: 248 });
    const { deps, el, save } = makeDeps(state);
    mountLeftNavSeparator(deps);

    for (const chord of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }]) {
      const ev = keydown(el, { key: 'ArrowLeft', ...chord });
      expect(ev.defaultPrevented).toBe(false);
    }
    expect(state.sidebarPx).toBe(248);
    expect(save).not.toHaveBeenCalled();
  });
});

describe('mountLeftNavSeparator — announce discipline', () => {
  it('does not announce on a plain width change within the same mode', () => {
    const state = makeState({ mode: 'wide', sidebarPx: 248 });
    const { deps, el, announce } = makeDeps(state);
    mountLeftNavSeparator(deps);
    keydown(el, { key: 'ArrowRight' });
    expect(announce).not.toHaveBeenCalled();
  });

  it('announces when the drawer open/closed state changes without a mode change', () => {
    const state = makeState({ mode: 'rail', section: 'library', leftNavDrawerPx: 200 });
    const { deps, el, announce } = makeDeps(state);
    mountLeftNavSeparator(deps);
    // Drag the drawer closed without leaving rail mode.
    mousedown(el, 0);
    (deps.win as ReturnType<typeof fakeWin>)._fire('mousemove', { clientX: LEFT_RAIL_PX - 20 });
    (deps.win as ReturnType<typeof fakeWin>)._fire('mouseup', { clientX: LEFT_RAIL_PX - 20 });
    expect(state.leftNavMode.value).toBe('rail');
    expect(state.leftNavSection.value).toBeNull();
    expect(announce).toHaveBeenCalledWith('Left navigation: Rail only');
  });

  it('is a safe no-op when announce is omitted', () => {
    const state = makeState({ mode: 'wide', sidebarPx: 248 });
    const el = document.createElement('div');
    const win = fakeWin();
    const target = fakeTarget();
    const deps: LeftNavSeparatorDeps = {
      el, win, target, state, prefs: { save: vi.fn() },
      getMaxNavigationTotalPx: () => LARGE_BUDGET, applyEffectiveLayout: vi.fn(),
    };
    mountLeftNavSeparator(deps);
    expect(() => keydown(el, { key: 'Home' })).not.toThrow();
  });
});

describe('mountLeftNavSeparator — default win/target', () => {
  it('defaults win to the real window and target to the real document when omitted', () => {
    const state = makeState({ mode: 'wide', sidebarPx: 248 });
    const el = document.createElement('div');
    const applyEffectiveLayout = vi.fn();
    const deps: LeftNavSeparatorDeps = {
      el, state, prefs: { save: vi.fn() }, getMaxNavigationTotalPx: () => LARGE_BUDGET, applyEffectiveLayout,
    };
    const handle = mountLeftNavSeparator(deps);

    mousedown(el, 248);
    expect(el.classList.contains('dragging')).toBe(true);
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 300 }));
    expect(applyEffectiveLayout).toHaveBeenCalledWith(
      { mode: 'wide', wideWidthPx: 300, drawerWidthPx: LEFT_DRAWER_DEFAULT_PX, focusedSection: null });
    window.dispatchEvent(new MouseEvent('mouseup', { clientX: 320 }));
    expect(el.classList.contains('dragging')).toBe(false);
    expect(state.sidebarPx).toBe(320);

    // The real `document` default also terminates a fresh drag on visibilitychange.
    mousedown(el, 320);
    expect(el.classList.contains('dragging')).toBe(true);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(el.classList.contains('dragging')).toBe(false);

    handle.dispose();
  });
});

describe('mountLeftNavSeparator — dispose', () => {
  it('removes blur/visibilitychange listeners when no drag is active', () => {
    const { deps, win, target } = makeDeps(makeState());
    const handle = mountLeftNavSeparator(deps);
    expect(win._has('blur')).toBe(true);
    expect(target._has('visibilitychange')).toBe(true);
    handle.dispose();
    expect(win._has('blur')).toBe(false);
    expect(target._has('visibilitychange')).toBe(false);
  });

  it('removes an in-progress drag\'s mousemove/mouseup listeners too, without committing', () => {
    const state = makeState({ mode: 'wide', sidebarPx: 248 });
    const { deps, el, win, save } = makeDeps(state);
    const handle = mountLeftNavSeparator(deps);

    mousedown(el, 248);
    win._fire('mousemove', { clientX: 300 });
    handle.dispose();

    expect(win._has('mousemove')).toBe(false);
    expect(win._has('mouseup')).toBe(false);
    expect(save).not.toHaveBeenCalled(); // disposed mid-drag — never committed
  });

  it('removes el\'s own mousedown/keydown listeners — a later gesture has no effect', () => {
    const state = makeState({ mode: 'wide', sidebarPx: 248 });
    const { deps, el, win, applyEffectiveLayout } = makeDeps(state);
    const handle = mountLeftNavSeparator(deps);
    handle.dispose();

    mousedown(el, 300);
    win._fire('mousemove', { clientX: 350 });
    expect(applyEffectiveLayout).not.toHaveBeenCalled();
    expect(el.classList.contains('dragging')).toBe(false);

    const ev = keydown(el, { key: 'Home' });
    expect(state.leftNavMode.value).toBe('wide'); // unchanged
    expect(ev.defaultPrevented).toBe(false); // handler no longer attached
  });

  it('stops the ARIA-refresh effect — a later signal write does not update the DOM', () => {
    const state = makeState({ mode: 'rail', section: null });
    const { deps, el } = makeDeps(state);
    const handle = mountLeftNavSeparator(deps);
    handle.dispose();
    state.leftNavSection.value = 'history';
    expect(el.getAttribute('aria-valuenow')).toBe('48'); // still the bare-rail value
  });
});
