// #487 phase 1 — the desktop left navigation's layout decisions. Pure module, so
// every case here is a plain input/output assertion: no DOM, no fixture app.
//
// Two structural choices, both learned from a review that caught a real bug this
// file had already declared green:
//
// 1. The drag tests sweep a POINTER PATH and assert a property of the whole
//    sweep (mode-monotone, width-monotone), not just the transition frames. The
//    bug that slipped through was a 108px backwards snap on the single frame a
//    drawer converted to a wide sidebar — every per-frame assertion passed,
//    because each frame's output was individually defensible. Only the sequence
//    was wrong.
// 2. The "keyboard matches pointer" property drives the pointer side from the
//    module's OWN public `leftNavigationWidthPx`, never from a copy of the
//    private base formula. A property test that recomputes the implementation is
//    a tautology with respect to that implementation, and it hid a second latent
//    bug in the bare-rail base.

import { describe, it, expect } from 'vitest';
import {
  LEFT_DRAWER_DEFAULT_PX, LEFT_FOLD_THRESHOLD_PX, LEFT_NAV_LARGE_STEP_PX, LEFT_NAV_SECTIONS,
  LEFT_NAV_STEP_PX, LEFT_PANEL_MAX_PX, LEFT_PANEL_MIN_PX, LEFT_RAIL_PX, LEFT_WIDE_DEFAULT_PX,
  LEFT_WIDE_THRESHOLD_PX,
  clampDrawerWidthPx, clampWideWidthPx, decodeLeftNavigationMode, decodeStoredPx,
  effectiveLeftNavigationLayout, isLeftNavigationSection, leftNavigationLayoutIsCoherent,
  leftNavigationSeparatorAria, leftNavigationWidthPx, normalizeLeftNavigationLayout,
  resolveLeftNavigationDrag, resolveLeftNavigationKey, resolveRailActivation, resolveRailOpen,
} from '../../src/core/left-nav-layout.js';
import type { LeftNavigationLayout } from '../../src/core/left-nav-layout.js';

/** A wide layout at the documented default width. */
const wide = (over: Partial<LeftNavigationLayout> = {}): LeftNavigationLayout => ({
  mode: 'wide',
  wideWidthPx: LEFT_WIDE_DEFAULT_PX,
  drawerWidthPx: LEFT_DRAWER_DEFAULT_PX,
  focusedSection: null,
  ...over,
});

/** A rail layout; pass `focusedSection` to open its drawer. */
const rail = (over: Partial<LeftNavigationLayout> = {}): LeftNavigationLayout =>
  wide({ mode: 'rail', ...over });

/** Drive a pointer path through the reducer, returning the occupied width after
 *  each step — the sequence, which is what per-frame assertions cannot see. */
function sweep(from: LeftNavigationLayout, xs: readonly number[]): {
  widths: number[]; modes: LeftNavigationMode[]; final: LeftNavigationLayout;
} {
  let layout = from;
  const widths: number[] = [];
  const modes: LeftNavigationMode[] = [];
  for (const x of xs) {
    layout = resolveLeftNavigationDrag(layout, x);
    widths.push(leftNavigationWidthPx(layout));
    modes.push(layout.mode);
  }
  return { widths, modes, final: layout };
}

type LeftNavigationMode = LeftNavigationLayout['mode'];

const range = (lo: number, hi: number): number[] =>
  Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);

describe('constants (#487)', () => {
  it('uses the values the issue specifies, with the fold/wide pair ordered as hysteresis', () => {
    expect(LEFT_RAIL_PX).toBe(48);
    expect(LEFT_FOLD_THRESHOLD_PX).toBe(140);
    expect(LEFT_WIDE_THRESHOLD_PX).toBe(260);
    expect(LEFT_PANEL_MIN_PX).toBe(180);
    expect(LEFT_PANEL_MAX_PX).toBe(420);
    // The gap between the two thresholds IS the hysteresis. If these ever met,
    // one pointer pixel could oscillate the mode — the exact failure #487's
    // "must not flicker near a single threshold" names.
    expect(LEFT_FOLD_THRESHOLD_PX).toBeLessThan(LEFT_WIDE_THRESHOLD_PX);
    // The rail must be narrower than the width that folds into it, and the wide
    // range must sit above the fold threshold, or the dead zone inverts.
    expect(LEFT_RAIL_PX).toBeLessThan(LEFT_FOLD_THRESHOLD_PX);
    expect(LEFT_FOLD_THRESHOLD_PX).toBeLessThan(LEFT_PANEL_MIN_PX);
  });
  it('keeps both documented defaults inside their own band', () => {
    expect(LEFT_WIDE_DEFAULT_PX).toBeGreaterThanOrEqual(LEFT_PANEL_MIN_PX);
    expect(LEFT_WIDE_DEFAULT_PX).toBeLessThanOrEqual(LEFT_PANEL_MAX_PX);
    expect(LEFT_DRAWER_DEFAULT_PX).toBeGreaterThanOrEqual(LEFT_FOLD_THRESHOLD_PX);
    expect(LEFT_DRAWER_DEFAULT_PX).toBeLessThanOrEqual(LEFT_WIDE_THRESHOLD_PX);
    expect(LEFT_NAV_STEP_PX).toBeLessThan(LEFT_NAV_LARGE_STEP_PX);
  });
  it('lists the four sections in rail order', () => {
    expect(LEFT_NAV_SECTIONS).toEqual(['databases', 'dashboards', 'library', 'history']);
  });
});

describe('isLeftNavigationSection', () => {
  it('accepts exactly the four known sections', () => {
    for (const section of LEFT_NAV_SECTIONS) expect(isLeftNavigationSection(section)).toBe(true);
  });
  it("rejects 'saved' — the value AppState.sidePanel actually stores for Library", () => {
    // NOT a pre-#427 name: `asb:sidePanel` still persists 'saved', and
    // `ui/saved-history.ts` still compares against it. #427 renamed the LABEL to
    // "Library" and left the stored value alone. So this guard rejecting 'saved'
    // is correct AND is exactly why phase 2's registry has to own a
    // 'library' <-> 'saved' mapping.
    expect(isLeftNavigationSection('saved')).toBe(false);
    expect(isLeftNavigationSection('queries')).toBe(false);
  });
  it('rejects a near miss and every non-string', () => {
    expect(isLeftNavigationSection('Databases')).toBe(false);
    expect(isLeftNavigationSection('')).toBe(false);
    expect(isLeftNavigationSection(null)).toBe(false);
    expect(isLeftNavigationSection(undefined)).toBe(false);
    expect(isLeftNavigationSection(0)).toBe(false);
    expect(isLeftNavigationSection(['databases'])).toBe(false);
  });
});

describe('decodeLeftNavigationMode', () => {
  it('decodes a stored rail preference', () => {
    expect(decodeLeftNavigationMode('rail')).toBe('rail');
  });
  it('falls back to wide for a missing, obsolete or malformed value', () => {
    expect(decodeLeftNavigationMode('wide')).toBe('wide');
    expect(decodeLeftNavigationMode(undefined)).toBe('wide');
    expect(decodeLeftNavigationMode(null)).toBe('wide');
    expect(decodeLeftNavigationMode('')).toBe('wide');
    expect(decodeLeftNavigationMode('collapsed')).toBe('wide'); // an obsolete third mode
    expect(decodeLeftNavigationMode('RAIL')).toBe('wide');
    expect(decodeLeftNavigationMode(1)).toBe('wide');
  });
});

describe('clampWideWidthPx', () => {
  it('passes an in-range width through and clamps both bounds', () => {
    expect(clampWideWidthPx(300)).toBe(300);
    expect(clampWideWidthPx(LEFT_PANEL_MIN_PX)).toBe(LEFT_PANEL_MIN_PX);
    expect(clampWideWidthPx(LEFT_PANEL_MAX_PX)).toBe(LEFT_PANEL_MAX_PX);
    expect(clampWideWidthPx(10)).toBe(LEFT_PANEL_MIN_PX);
    expect(clampWideWidthPx(9999)).toBe(LEFT_PANEL_MAX_PX);
    expect(clampWideWidthPx(-1)).toBe(LEFT_PANEL_MIN_PX);
  });
  it('sends only NaN to the default, leaving the infinities on their bounds', () => {
    // The regression the guard exists for: `clamp(NaN, 180, 420)` is NaN, so the
    // bare clamp this replaced decoded a corrupt `asb:sidebarPx` to `width: NaNpx`.
    expect(clampWideWidthPx(NaN)).toBe(LEFT_WIDE_DEFAULT_PX);
    // ±Infinity has an unambiguous target, so it keeps the bare clamp's answer —
    // guarding it too would make -1 → 180 but -Infinity → 248, a discontinuity
    // for no reason, and would change this key's long-standing behaviour.
    expect(clampWideWidthPx(Infinity)).toBe(LEFT_PANEL_MAX_PX);
    expect(clampWideWidthPx(-Infinity)).toBe(LEFT_PANEL_MIN_PX);
  });
});

describe('clampDrawerWidthPx', () => {
  it('clamps to the drawer band, not the wide sidebar range', () => {
    expect(clampDrawerWidthPx(200)).toBe(200);
    expect(clampDrawerWidthPx(LEFT_FOLD_THRESHOLD_PX)).toBe(LEFT_FOLD_THRESHOLD_PX);
    expect(clampDrawerWidthPx(LEFT_WIDE_THRESHOLD_PX)).toBe(LEFT_WIDE_THRESHOLD_PX);
    expect(clampDrawerWidthPx(0)).toBe(LEFT_FOLD_THRESHOLD_PX);
    // Explicitly NOT the wide sidebar's bounds: a 400px drawer is impossible,
    // because a drag that far right converts to the wide sidebar instead.
    expect(clampDrawerWidthPx(400)).toBe(LEFT_WIDE_THRESHOLD_PX);
    expect(clampDrawerWidthPx(LEFT_PANEL_MIN_PX)).toBe(LEFT_PANEL_MIN_PX);
  });
  it('sends only NaN to the default', () => {
    expect(clampDrawerWidthPx(NaN)).toBe(LEFT_DRAWER_DEFAULT_PX);
    expect(clampDrawerWidthPx(Infinity)).toBe(LEFT_WIDE_THRESHOLD_PX);
    expect(clampDrawerWidthPx(-Infinity)).toBe(LEFT_FOLD_THRESHOLD_PX);
  });
});

describe('leftNavigationWidthPx', () => {
  it('is the sidebar width when wide', () => {
    expect(leftNavigationWidthPx(wide({ wideWidthPx: 300 }))).toBe(300);
  });
  it('is the bare rail width when rail with no drawer', () => {
    expect(leftNavigationWidthPx(rail())).toBe(LEFT_RAIL_PX);
  });
  it('is rail PLUS drawer when a drawer is open — the rail stays visible beside it', () => {
    expect(leftNavigationWidthPx(rail({ focusedSection: 'databases', drawerWidthPx: 200 })))
      .toBe(LEFT_RAIL_PX + 200);
  });
});

// The regression suite for the bug this file previously certified as green: a
// monotone pointer path must produce a monotone width response and at most one
// mode change. Each assertion is over the whole sweep.
describe('resolveLeftNavigationDrag — a monotone drag never reverses (#487 regression)', () => {
  it('never snaps backwards converting an open drawer to the wide sidebar', () => {
    // The original defect, exactly: at clientX 308 the drawer was at its 260
    // maximum (total 308); crossing at 309 installed the REMEMBERED 200 for one
    // frame before 310 jumped to 310. A 108px backwards snap mid-gesture.
    const { widths } = sweep(
      rail({ focusedSection: 'databases', drawerWidthPx: LEFT_WIDE_THRESHOLD_PX, wideWidthPx: 200 }),
      range(300, 320));
    for (let i = 1; i < widths.length; i++) expect(widths[i]).toBeGreaterThanOrEqual(widths[i - 1]);
    expect(widths.at(-1)).toBe(320);
  });

  it('is width-monotone and mode-monotone dragging right across every threshold', () => {
    const { widths, modes } = sweep(rail({ focusedSection: 'library', wideWidthPx: 200 }), range(40, 460));
    for (let i = 1; i < widths.length; i++) expect(widths[i]).toBeGreaterThanOrEqual(widths[i - 1]);
    // Exactly one rail → wide transition, and never back.
    expect(modes.indexOf('wide')).toBeGreaterThan(0);
    expect(modes.slice(modes.indexOf('wide')).every((m) => m === 'wide')).toBe(true);
  });

  it('is width-monotone and mode-monotone dragging left across every threshold', () => {
    const { widths, modes } = sweep(wide({ wideWidthPx: LEFT_PANEL_MAX_PX }), range(40, 460).reverse());
    for (let i = 1; i < widths.length; i++) expect(widths[i]).toBeLessThanOrEqual(widths[i - 1]);
    expect(modes.indexOf('rail')).toBeGreaterThan(0);
    expect(modes.slice(modes.indexOf('rail')).every((m) => m === 'rail')).toBe(true);
  });

  it('folds a wide sidebar to the rail without an intermediate clipped width', () => {
    // Swept from the 180 floor down, so every step is inside the dead zone or past
    // the fold — above 180 a narrowing drag is an ordinary resize, not this claim.
    const { widths } = sweep(wide({ wideWidthPx: 300 }), range(120, LEFT_PANEL_MIN_PX).reverse());
    // Only two widths ever appear: the 180 floor, and the rail. Nothing between —
    // that is "do not leave a partially clipped wide sidebar".
    expect(new Set(widths)).toEqual(new Set([LEFT_PANEL_MIN_PX, LEFT_RAIL_PX]));
  });

  it('keeps the drawer under the pointer through its whole band', () => {
    let layout: LeftNavigationLayout = rail({ focusedSection: 'history' });
    for (const x of range(LEFT_RAIL_PX + LEFT_FOLD_THRESHOLD_PX, LEFT_RAIL_PX + LEFT_WIDE_THRESHOLD_PX)) {
      layout = resolveLeftNavigationDrag(layout, x);
      expect(leftNavigationWidthPx(layout)).toBe(x);
    }
  });
});

describe('resolveLeftNavigationDrag — wide', () => {
  it('resizes within the wide range', () => {
    expect(resolveLeftNavigationDrag(wide(), 320)).toEqual(wide({ wideWidthPx: 320 }));
  });
  it('clamps to the ceiling instead of growing past it', () => {
    expect(resolveLeftNavigationDrag(wide(), 9999).wideWidthPx).toBe(LEFT_PANEL_MAX_PX);
  });
  it('sits at the 180 floor through the whole dead zone rather than clipping', () => {
    // #487: "do not leave a partially clipped wide sidebar". Between the fold
    // threshold and the floor the sidebar holds at 180 and the mode does not
    // change, so the user has to pull decisively past 140 to fold.
    for (const x of [LEFT_FOLD_THRESHOLD_PX, 150, 179]) {
      const next = resolveLeftNavigationDrag(wide({ wideWidthPx: 300 }), x);
      expect(next.mode).toBe('wide');
      expect(next.wideWidthPx).toBe(LEFT_PANEL_MIN_PX);
    }
  });
  it('commits rail once past the fold threshold, exactly once', () => {
    const next = resolveLeftNavigationDrag(wide({ wideWidthPx: 300 }), LEFT_FOLD_THRESHOLD_PX - 1);
    expect(next.mode).toBe('rail');
    expect(next.focusedSection).toBeNull();
    // Continuing to drag left is idempotent — it does not fold "twice", and it
    // does not keep rewriting the remembered width.
    expect(resolveLeftNavigationDrag(next, 0)).toEqual(next);
  });
  it('carries the remembered wide width through rail mode for End and for persistence', () => {
    const folded = resolveLeftNavigationDrag(wide({ wideWidthPx: 300 }), 10);
    expect(folded.wideWidthPx).toBe(300);
    // A DRAG back out follows the pointer rather than restoring 300 (see the
    // reducer's doc: a restored width would survive one frame); `End` is the
    // path that restores it, asserted in the keyboard block below.
    expect(resolveLeftNavigationDrag(folded, 400).wideWidthPx).toBe(400);
  });
  it('keeps the drawer width untouched while folding, ready for the first rail click', () => {
    expect(resolveLeftNavigationDrag(wide({ drawerWidthPx: 210 }), 10).drawerWidthPx).toBe(210);
  });
});

describe('resolveLeftNavigationDrag — rail', () => {
  it('does nothing for a bare rail below the wide threshold — the rail width IS the mode', () => {
    const layout = rail();
    // Same object back, so phase 3 can skip the repaint on identity.
    expect(resolveLeftNavigationDrag(layout, LEFT_WIDE_THRESHOLD_PX)).toBe(layout);
    expect(resolveLeftNavigationDrag(layout, 200)).toBe(layout);
    expect(resolveLeftNavigationDrag(layout, 0)).toBe(layout);
  });
  it('restores wide AT THE POINTER once past the wide threshold', () => {
    const next = resolveLeftNavigationDrag(rail({ wideWidthPx: 330 }), LEFT_WIDE_THRESHOLD_PX + 1);
    expect(next.mode).toBe('wide');
    // 261, not the remembered 330 — the panel edge stays under the finger.
    expect(next.wideWidthPx).toBe(LEFT_WIDE_THRESHOLD_PX + 1);
    expect(next.focusedSection).toBeNull();
  });
  it('does NOT restore wide at the threshold itself — hysteresis needs a decisive pull', () => {
    const layout = rail();
    expect(resolveLeftNavigationDrag(layout, LEFT_WIDE_THRESHOLD_PX)).toBe(layout);
  });
  it('resizes an open drawer inside its own band, measured beside the rail', () => {
    const next = resolveLeftNavigationDrag(rail({ focusedSection: 'dashboards' }), LEFT_RAIL_PX + 200);
    expect(next.mode).toBe('rail');
    expect(next.focusedSection).toBe('dashboards');
    expect(next.drawerWidthPx).toBe(200);
  });
  it('holds an open drawer at exactly the fold threshold, and folds one pixel below it', () => {
    // The closed lower edge of the drawer band: `clampDrawerWidthPx` claims 140 is
    // reachable, so the reducer's comparison must agree. A `<=` here would make
    // 140 unreachable while the clamp still advertised it.
    const open = resolveLeftNavigationDrag(
      rail({ focusedSection: 'history' }), LEFT_RAIL_PX + LEFT_FOLD_THRESHOLD_PX);
    expect(open.focusedSection).toBe('history');
    expect(open.drawerWidthPx).toBe(LEFT_FOLD_THRESHOLD_PX);
    const closed = resolveLeftNavigationDrag(
      rail({ focusedSection: 'history' }), LEFT_RAIL_PX + LEFT_FOLD_THRESHOLD_PX - 1);
    expect(closed.focusedSection).toBeNull();
  });
  it('holds an open drawer at exactly the wide threshold, and converts one pixel above it', () => {
    const open = resolveLeftNavigationDrag(
      rail({ focusedSection: 'history' }), LEFT_RAIL_PX + LEFT_WIDE_THRESHOLD_PX);
    expect(open.mode).toBe('rail');
    expect(open.drawerWidthPx).toBe(LEFT_WIDE_THRESHOLD_PX);
    const converted = resolveLeftNavigationDrag(
      rail({ focusedSection: 'history' }), LEFT_RAIL_PX + LEFT_WIDE_THRESHOLD_PX + 1);
    expect(converted.mode).toBe('wide');
  });
  it('folds an open drawer closed below the fold threshold, leaving the rail', () => {
    const next = resolveLeftNavigationDrag(
      rail({ focusedSection: 'history', drawerWidthPx: 220 }), LEFT_RAIL_PX + 100);
    expect(next.mode).toBe('rail');
    expect(next.focusedSection).toBeNull();
    // Width kept for the next open — closing is not a reset.
    expect(next.drawerWidthPx).toBe(220);
  });
  it('cannot oscillate across the two thresholds', () => {
    // A pointer parked in the sticky band, arriving from either side, keeps
    // whatever mode it already had.
    for (const x of [LEFT_FOLD_THRESHOLD_PX, 200, LEFT_WIDE_THRESHOLD_PX]) {
      expect(resolveLeftNavigationDrag(rail(), x).mode).toBe('rail');
      expect(resolveLeftNavigationDrag(wide(), x).mode).toBe('wide');
    }
  });
  it('heals a NaN proposal into a legal width rather than propagating it', () => {
    expect(resolveLeftNavigationDrag(wide(), NaN).wideWidthPx).toBe(LEFT_WIDE_DEFAULT_PX);
    expect(resolveLeftNavigationDrag(rail({ focusedSection: 'library' }), NaN).drawerWidthPx)
      .toBe(LEFT_DRAWER_DEFAULT_PX);
  });
});

describe('resolveLeftNavigationKey', () => {
  it('returns null for a key the separator does not own', () => {
    // Phase 3 must not swallow Tab, Escape or anything else global.
    for (const key of ['Tab', 'Escape', 'Enter', ' ', 'ArrowUp', 'ArrowDown', 'PageUp']) {
      expect(resolveLeftNavigationKey(wide(), { key })).toBeNull();
    }
  });
  it('returns null for a Ctrl/Meta/Alt chord on a key it otherwise owns', () => {
    // Ctrl+Home must not fold the navigation, and Alt+ArrowLeft is the browser's
    // Back on some platforms. Shift is the one modifier with a meaning here.
    for (const key of ['Home', 'End', 'ArrowLeft', 'ArrowRight']) {
      expect(resolveLeftNavigationKey(wide(), { key, ctrlKey: true })).toBeNull();
      expect(resolveLeftNavigationKey(wide(), { key, metaKey: true })).toBeNull();
      expect(resolveLeftNavigationKey(wide(), { key, altKey: true })).toBeNull();
    }
  });
  it('Home folds to rail from wide and is idempotent', () => {
    expect(resolveLeftNavigationKey(wide({ wideWidthPx: 300 }), { key: 'Home' }))
      .toEqual(rail({ wideWidthPx: 300 }));
    const bare = rail();
    expect(resolveLeftNavigationKey(bare, { key: 'Home' })).toBe(bare);
  });
  it('Home also closes an open focused drawer', () => {
    expect(resolveLeftNavigationKey(rail({ focusedSection: 'databases' }), { key: 'Home' }))
      .toEqual(rail());
  });
  it('End is the one path that restores the REMEMBERED wide width', () => {
    // The counterpart to the drag rule: a discrete restore has no pointer to
    // honour, so the memory is what it uses.
    expect(resolveLeftNavigationKey(rail({ wideWidthPx: 330, focusedSection: 'library' }), { key: 'End' }))
      .toEqual(wide({ wideWidthPx: 330 }));
    const already = wide();
    expect(resolveLeftNavigationKey(already, { key: 'End' })).toBe(already);
  });
  it('End re-clamps an invalid remembered width', () => {
    expect(resolveLeftNavigationKey(rail({ wideWidthPx: NaN }), { key: 'End' })!.wideWidthPx)
      .toBe(LEFT_WIDE_DEFAULT_PX);
  });
  it('arrows step the wide sidebar by the small and large steps', () => {
    const at = (over: Partial<LeftNavigationLayout>, key: string, shiftKey = false) =>
      resolveLeftNavigationKey(wide(over), { key, shiftKey })!.wideWidthPx;
    expect(at({ wideWidthPx: 300 }, 'ArrowRight')).toBe(300 + LEFT_NAV_STEP_PX);
    expect(at({ wideWidthPx: 300 }, 'ArrowLeft')).toBe(300 - LEFT_NAV_STEP_PX);
    expect(at({ wideWidthPx: 300 }, 'ArrowRight', true)).toBe(300 + LEFT_NAV_LARGE_STEP_PX);
    expect(at({ wideWidthPx: 300 }, 'ArrowLeft', true)).toBe(300 - LEFT_NAV_LARGE_STEP_PX);
  });
  it('steps the DRAWER width when a drawer is open, not the sidebar width', () => {
    const next = resolveLeftNavigationKey(
      rail({ focusedSection: 'history', drawerWidthPx: 200 }), { key: 'ArrowRight' })!;
    expect(next.drawerWidthPx).toBe(200 + LEFT_NAV_STEP_PX);
    expect(next.wideWidthPx).toBe(LEFT_WIDE_DEFAULT_PX);
  });
  it('can fold an open drawer closed with an arrow at its floor', () => {
    const next = resolveLeftNavigationKey(
      rail({ focusedSection: 'history', drawerWidthPx: LEFT_FOLD_THRESHOLD_PX }), { key: 'ArrowLeft' })!;
    expect(next.focusedSection).toBeNull();
  });
  it('leaves a bare rail on ONE rightward step, at the REMEMBERED width', () => {
    // A relative +16 from the rail's own 48px would propose 64, land in the sticky
    // band and do nothing forever, so the boundary step performs the restore
    // transition instead — and at the remembered width, like End. A fixed
    // threshold-plus-step base would hand back 276 and silently discard this 420.
    for (const wideWidthPx of [LEFT_PANEL_MIN_PX, 200, 244, LEFT_WIDE_DEFAULT_PX, LEFT_PANEL_MAX_PX]) {
      for (const shiftKey of [false, true]) {
        const out = resolveLeftNavigationKey(rail({ wideWidthPx }), { key: 'ArrowRight', shiftKey })!;
        expect(out.mode).toBe('wide');
        expect(out.wideWidthPx).toBe(wideWidthPx);
      }
    }
  });
  it('holds a bare rail on a leftward step — it is already as folded as it goes', () => {
    for (const shiftKey of [false, true]) {
      const stay = rail();
      expect(resolveLeftNavigationKey(stay, { key: 'ArrowLeft', shiftKey })).toBe(stay);
    }
  });
  it('matches pointer transitions INSIDE a band, for the same proposed total width', () => {
    // The property the design exists for: inside a band the keyboard IS the drag
    // reducer, so the resize arithmetic has one implementation. The pointer side is
    // driven from the module's PUBLIC occupied width, never from a copy of a private
    // base formula — recomputing the implementation here is what let a bare-rail
    // base bug survive a green suite.
    //
    // Band EDGES are deliberately excluded and asserted separately: there the
    // keyboard performs a semantic transition the pointer reaches by simply
    // travelling further, which no single shared proposal can express. A bare rail
    // and a 180px sidebar are the two such states.
    const cases: LeftNavigationLayout[] = [
      wide({ wideWidthPx: 300 }),
      wide({ wideWidthPx: LEFT_PANEL_MIN_PX + LEFT_NAV_LARGE_STEP_PX }),
      wide({ wideWidthPx: LEFT_PANEL_MAX_PX }),
      rail({ focusedSection: 'databases', drawerWidthPx: LEFT_FOLD_THRESHOLD_PX }),
      rail({ focusedSection: 'databases', drawerWidthPx: 200 }),
      rail({ focusedSection: 'databases', drawerWidthPx: LEFT_WIDE_THRESHOLD_PX }),
    ];
    for (const layout of cases) {
      for (const shiftKey of [false, true]) {
        const step = shiftKey ? LEFT_NAV_LARGE_STEP_PX : LEFT_NAV_STEP_PX;
        const base = leftNavigationWidthPx(layout);
        expect(resolveLeftNavigationKey(layout, { key: 'ArrowRight', shiftKey }))
          .toEqual(resolveLeftNavigationDrag(layout, base + step));
        expect(resolveLeftNavigationKey(layout, { key: 'ArrowLeft', shiftKey }))
          .toEqual(resolveLeftNavigationDrag(layout, base - step));
      }
    }
  });
  it('folds from the wide floor on a leftward step — the mirror of the bare-rail case', () => {
    // The dead end this replaces: at the 180 floor a −16 step proposes 164, which
    // clamps back to 180, so plain ArrowLeft did nothing FOREVER while
    // `aria-valuemin: 48` was advertised. Home and Shift+Arrow escaping is not a
    // defence — the W3C splitter pattern makes plain Left/Right the move keys.
    for (const shiftKey of [false, true]) {
      expect(resolveLeftNavigationKey(
        wide({ wideWidthPx: LEFT_PANEL_MIN_PX }), { key: 'ArrowLeft', shiftKey })!.mode).toBe('rail');
    }
  });
  it('holds at the wide ceiling on a rightward step — a real bound, not a dead zone', () => {
    // Nothing legal exists to the right of 420, so refusing to move is the correct
    // answer rather than a stranded control.
    expect(resolveLeftNavigationKey(wide({ wideWidthPx: LEFT_PANEL_MAX_PX }), { key: 'ArrowRight' }))
      .toEqual(wide({ wideWidthPx: LEFT_PANEL_MAX_PX }));
  });
  it('reaches the rail from any wide width by repeated plain ArrowLeft', () => {
    // The property the single-step tests could not express: a keyboard SEQUENCE
    // must be able to go where the equivalent pointer path goes. Eleven presses
    // from 300 used to sit at 180 forever while the pointer folded.
    for (const start of [LEFT_PANEL_MAX_PX, 300, 190, LEFT_PANEL_MIN_PX]) {
      let layout: LeftNavigationLayout = wide({ wideWidthPx: start });
      for (let i = 0; i < 40 && layout.mode === 'wide'; i++) {
        layout = resolveLeftNavigationKey(layout, { key: 'ArrowLeft' })!;
      }
      expect(layout.mode).toBe('rail');
    }
  });
  it('round-trips between rail and wide with plain arrows, in both directions', () => {
    // Reversibility of the MODE, which a stranded boundary silently broke. The width
    // does not round-trip, and should not: the intervening ArrowLefts really did
    // resize the sidebar down to its floor before folding, so 180 is the honest
    // remembered width on the way back.
    const start = rail({ wideWidthPx: 300 });
    expect(resolveLeftNavigationKey(start, { key: 'ArrowRight' })).toEqual(wide({ wideWidthPx: 300 }));
    let back: LeftNavigationLayout = wide({ wideWidthPx: 300 });
    for (let i = 0; i < 40 && back.mode === 'wide'; i++) {
      back = resolveLeftNavigationKey(back, { key: 'ArrowLeft' })!;
    }
    expect(back).toEqual(rail({ wideWidthPx: LEFT_PANEL_MIN_PX }));
    // And straight back out again, so neither end is a trap.
    expect(resolveLeftNavigationKey(back, { key: 'ArrowRight' })!.mode).toBe('wide');
  });
  it('normalizes an incoherent layout before acting on it', () => {
    const healed = resolveLeftNavigationKey(
      wide({ focusedSection: 'databases' }) as LeftNavigationLayout, { key: 'ArrowRight' })!;
    expect(healed.focusedSection).toBeNull();
    expect(resolveLeftNavigationKey(wide({ wideWidthPx: NaN }), { key: 'End' })!.wideWidthPx)
      .toBe(LEFT_WIDE_DEFAULT_PX);
  });
});

// #487 requires "a deterministic `openFocusedSection('dashboards')` seam" for
// #428's bounded drag-hover. A toggle cannot serve that: hover re-asserts intent
// repeatedly, so a toggle would flap the drawer open and shut on alternate
// notifications. Open and toggle are therefore separate operations.
describe('resolveRailOpen — the idempotent seam', () => {
  it('opens a section from a bare rail', () => {
    expect(resolveRailOpen(rail(), 'dashboards')).toEqual(rail({ focusedSection: 'dashboards' }));
  });
  it('is IDEMPOTENT — repeated opens leave the section open', () => {
    // The exact #428 failure mode this exists to prevent.
    let layout: LeftNavigationLayout = rail();
    for (let i = 0; i < 5; i++) layout = resolveRailOpen(layout, 'dashboards');
    expect(layout.focusedSection).toBe('dashboards');
    // …and returns by identity once already open, so a hover notification storm
    // cannot cause a repaint per event.
    expect(resolveRailOpen(layout, 'dashboards')).toBe(layout);
  });
  it('switches from another open section without closing first', () => {
    expect(resolveRailOpen(rail({ focusedSection: 'history' }), 'dashboards').focusedSection)
      .toBe('dashboards');
  });
  it('never closes a drawer, unlike the click toggle', () => {
    const open = rail({ focusedSection: 'dashboards' });
    expect(resolveRailOpen(open, 'dashboards').focusedSection).toBe('dashboards');
    expect(resolveRailActivation(open, 'dashboards').focusedSection).toBeNull();
  });
  it('is a no-op in wide mode, like the toggle', () => {
    const layout = wide();
    expect(resolveRailOpen(layout, 'dashboards')).toBe(layout);
  });
});

describe('normalizeLeftNavigationLayout', () => {
  it('returns a legal layout by identity', () => {
    for (const layout of [wide(), rail(), rail({ focusedSection: 'library' })]) {
      expect(normalizeLeftNavigationLayout(layout)).toBe(layout);
    }
  });
  it('drops a focused section that wide mode cannot render', () => {
    expect(normalizeLeftNavigationLayout(wide({ focusedSection: 'databases' })))
      .toEqual(wide());
  });
  it('heals a non-finite or out-of-band width', () => {
    expect(normalizeLeftNavigationLayout(wide({ wideWidthPx: NaN })).wideWidthPx)
      .toBe(LEFT_WIDE_DEFAULT_PX);
    expect(normalizeLeftNavigationLayout(wide({ wideWidthPx: 9999 })).wideWidthPx)
      .toBe(LEFT_PANEL_MAX_PX);
    expect(normalizeLeftNavigationLayout(wide({ drawerWidthPx: 9999 })).drawerWidthPx)
      .toBe(LEFT_WIDE_THRESHOLD_PX);
  });
  it('rejects an unknown mode and an unknown section', () => {
    expect(normalizeLeftNavigationLayout({ ...wide(), mode: 'collapsed' } as unknown as LeftNavigationLayout).mode)
      .toBe('wide');
    expect(normalizeLeftNavigationLayout(
      { ...rail(), focusedSection: 'saved' } as unknown as LeftNavigationLayout).focusedSection).toBeNull();
  });
  it('makes every reducer heal an incoherent seed rather than preserve it', () => {
    // Previously the invariant was only a PRECONDITION: a drag over an incoherent
    // layout carried the illegal mode/section pair straight through, and End handed
    // it back untouched. `state.ts` stores the two as independently writable
    // signals, so that pair is one stray assignment away.
    const bad = wide({ focusedSection: 'databases' });
    expect(leftNavigationLayoutIsCoherent(bad)).toBe(false);
    expect(resolveLeftNavigationDrag(bad, 300).focusedSection).toBeNull();
    expect(resolveLeftNavigationKey(bad, { key: 'End' })!.focusedSection).toBeNull();
    expect(resolveRailActivation(bad, 'databases').focusedSection).toBeNull();
    expect(resolveRailOpen(bad, 'databases').focusedSection).toBeNull();
    expect(effectiveLeftNavigationLayout(bad, false).focusedSection).toBeNull();
  });
  it('keeps a NaN width out of the ARIA value published to assistive technology', () => {
    expect(leftNavigationSeparatorAria(wide({ wideWidthPx: NaN })).valueNow)
      .toBe(LEFT_WIDE_DEFAULT_PX);
  });
  it('lifts a type-valid but illegal seed into its band before measuring', () => {
    // A 150px "wide" sidebar is type-valid and state-invalid. Normalizing on entry
    // means the sweep is measured from a legal 180 rather than reporting an occupied
    // width no mode can render.
    expect(normalizeLeftNavigationLayout(wide({ wideWidthPx: 150 })).wideWidthPx)
      .toBe(LEFT_PANEL_MIN_PX);
    // 149 is still above the fold threshold, so it resizes to the floor …
    expect(resolveLeftNavigationDrag(wide({ wideWidthPx: 150 }), 149))
      .toEqual(wide({ wideWidthPx: LEFT_PANEL_MIN_PX }));
    // … and only a proposal past the threshold folds.
    expect(resolveLeftNavigationDrag(wide({ wideWidthPx: 150 }), LEFT_FOLD_THRESHOLD_PX - 1).mode)
      .toBe('rail');
  });
});

describe('decodeStoredPx', () => {
  it('accepts a complete number, with surrounding whitespace', () => {
    expect(decodeStoredPx('300', 1)).toBe(300);
    expect(decodeStoredPx('  300  ', 1)).toBe(300);
    expect(decodeStoredPx('300.5', 1)).toBe(300.5);
    expect(decodeStoredPx('-5', 1)).toBe(-5);
  });
  it('rejects a numeric PREFIX, which parseInt would have accepted', () => {
    // The contract this fixes: `parseInt('12junk')` is 12 and `parseInt('200px')`
    // is 200, so a truncated write or a hand-edited CSS unit decoded to a
    // plausible-looking width while the docs promised the default.
    expect(decodeStoredPx('12junk', 248)).toBe(248);
    expect(decodeStoredPx('200px', 240)).toBe(240);
    expect(decodeStoredPx('1e', 248)).toBe(248);
  });
  it('rejects a stored infinity, empty string, whitespace and every non-string', () => {
    expect(decodeStoredPx('Infinity', 248)).toBe(248);
    expect(decodeStoredPx('-Infinity', 248)).toBe(248);
    expect(decodeStoredPx('NaN', 248)).toBe(248);
    expect(decodeStoredPx('', 248)).toBe(248);
    expect(decodeStoredPx('   ', 248)).toBe(248);
    expect(decodeStoredPx(null, 248)).toBe(248);
    expect(decodeStoredPx(undefined, 248)).toBe(248);
    expect(decodeStoredPx(300, 248)).toBe(248);
  });
});

// Documented, deliberately pinned, and phase 3's to change: the remembered wide
// width depends on which pointer samples the browser happened to deliver, because
// one field is doing duty as both the live drag width and the restore memory.
// Separating them needs a drag-session snapshot, which a pure reducer cannot take.
describe('restore memory is sampling-dependent (phase 3 obligation)', () => {
  it('remembers a different width for the same gesture depending on event cadence', () => {
    const seed = wide({ wideWidthPx: 300 });
    // One coarse sample straight past the fold keeps the pre-drag width …
    expect(resolveLeftNavigationDrag(seed, 139).wideWidthPx).toBe(300);
    // … while an intermediate sample inside the 140–179 dead zone rests the width
    // at the floor first, so the fold remembers 180 instead.
    expect(resolveLeftNavigationDrag(resolveLeftNavigationDrag(seed, 179), 139).wideWidthPx)
      .toBe(LEFT_PANEL_MIN_PX);
  });
});

describe('resolveRailActivation', () => {
  it('opens a section from a bare rail', () => {
    expect(resolveRailActivation(rail(), 'dashboards')).toEqual(rail({ focusedSection: 'dashboards' }));
  });
  it('closes the drawer when the ACTIVE section is activated again', () => {
    expect(resolveRailActivation(rail({ focusedSection: 'dashboards' }), 'dashboards')).toEqual(rail());
  });
  it('switches content in place without closing first', () => {
    const next = resolveRailActivation(rail({ focusedSection: 'dashboards' }), 'history');
    expect(next.focusedSection).toBe('history');
    expect(next.mode).toBe('rail');
  });
  it('preserves the remembered widths across every activation', () => {
    const layout = rail({ wideWidthPx: 330, drawerWidthPx: 210 });
    for (const section of LEFT_NAV_SECTIONS) {
      const next = resolveRailActivation(layout, section);
      expect(next.wideWidthPx).toBe(330);
      expect(next.drawerWidthPx).toBe(210);
    }
  });
  it('cannot open a drawer in wide mode — phase 3 must route to the pane switchers', () => {
    const layout = wide();
    for (const section of LEFT_NAV_SECTIONS) {
      expect(resolveRailActivation(layout, section)).toBe(layout);
    }
  });
});

// The invariant every reducer shares, asserted over their combined reachable
// space rather than re-derived per test: a focused drawer exists only in rail
// mode. `leftNavigationWidthPx` reads `drawerWidthPx` only in rail mode, so a
// 'wide' layout carrying a section would push the centre surface by a width that
// omits the open drawer.
describe('mode/focusedSection coherence', () => {
  it('holds across every reachable drag, key and activation from every seed', () => {
    const seeds: LeftNavigationLayout[] = [
      wide(), wide({ wideWidthPx: LEFT_PANEL_MAX_PX }), rail(),
      ...LEFT_NAV_SECTIONS.map((s) => rail({ focusedSection: s })),
    ];
    const keys = ['Home', 'End', 'ArrowLeft', 'ArrowRight'];
    for (const seed of seeds) {
      expect(leftNavigationLayoutIsCoherent(seed)).toBe(true);
      for (const x of [0, 100, 139, 140, 180, 200, 260, 261, 308, 309, 420, 999, NaN]) {
        expect(leftNavigationLayoutIsCoherent(resolveLeftNavigationDrag(seed, x))).toBe(true);
      }
      for (const key of keys) {
        for (const shiftKey of [false, true]) {
          const next = resolveLeftNavigationKey(seed, { key, shiftKey });
          if (next) expect(leftNavigationLayoutIsCoherent(next)).toBe(true);
        }
      }
      for (const section of LEFT_NAV_SECTIONS) {
        expect(leftNavigationLayoutIsCoherent(resolveRailActivation(seed, section))).toBe(true);
      }
    }
  });
  it('rejects the incoherent shape it exists to forbid', () => {
    // Guards the guard: if this predicate were vacuously true, the sweep above
    // would prove nothing.
    expect(leftNavigationLayoutIsCoherent(wide({ focusedSection: 'databases' }))).toBe(false);
  });
});

describe('effectiveLeftNavigationLayout', () => {
  it('returns the desktop layout untouched', () => {
    for (const layout of [wide(), rail(), rail({ focusedSection: 'library' })]) {
      expect(effectiveLeftNavigationLayout(layout, false)).toBe(layout);
    }
  });
  it('ignores rail mode and any open drawer below the mobile breakpoint', () => {
    // #487: "do not render the desktop rail or desktop focused drawer" on mobile.
    const effective = effectiveLeftNavigationLayout(
      rail({ focusedSection: 'dashboards', wideWidthPx: 330, drawerWidthPx: 210 }), true);
    expect(effective.mode).toBe('wide');
    expect(effective.focusedSection).toBeNull();
  });
  it('preserves the desktop preferences it is ignoring, for the next desktop session', () => {
    const stored = rail({ focusedSection: 'dashboards', wideWidthPx: 330, drawerWidthPx: 210 });
    const effective = effectiveLeftNavigationLayout(stored, true);
    // The projection carries both widths through …
    expect(effective.wideWidthPx).toBe(330);
    expect(effective.drawerWidthPx).toBe(210);
    // … and never writes back: the stored layout still says rail.
    expect(stored.mode).toBe('rail');
    expect(stored.focusedSection).toBe('dashboards');
  });
  it('returns an already-wide layout by identity even on mobile', () => {
    const layout = wide();
    expect(effectiveLeftNavigationLayout(layout, true)).toBe(layout);
  });
});

describe('leftNavigationSeparatorAria', () => {
  it('reports the rail floor, the wide ceiling and the live occupied width', () => {
    expect(leftNavigationSeparatorAria(wide({ wideWidthPx: 300 })))
      .toEqual({ valueMin: LEFT_RAIL_PX, valueMax: LEFT_PANEL_MAX_PX, valueNow: 300 });
    expect(leftNavigationSeparatorAria(rail()).valueNow).toBe(LEFT_RAIL_PX);
    expect(leftNavigationSeparatorAria(rail({ focusedSection: 'library', drawerWidthPx: 200 })).valueNow)
      .toBe(LEFT_RAIL_PX + 200);
  });
  it('keeps valueNow inside the advertised range in every mode', () => {
    for (const layout of [
      wide({ wideWidthPx: LEFT_PANEL_MIN_PX }), wide({ wideWidthPx: LEFT_PANEL_MAX_PX }), rail(),
      rail({ focusedSection: 'library', drawerWidthPx: LEFT_WIDE_THRESHOLD_PX }),
    ]) {
      const { valueMin, valueMax, valueNow } = leftNavigationSeparatorAria(layout);
      expect(valueNow).toBeGreaterThanOrEqual(valueMin);
      expect(valueNow).toBeLessThanOrEqual(valueMax);
    }
  });
});
