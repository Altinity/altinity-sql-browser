// #487 phase 3 — the left navigation's resize/mode-changing separator. Wired
// into `ui/app-shell.ts` (`mountLeftNavSeparator` is mounted onto the shell's
// `.col-resize` handle, and `applyEffectiveLeftNavigationLayout` is the
// `applyEffectiveLayout` callback every session paints through) — it replaced
// `splitters.ts`'s `'col'` axis outright, which no longer exists.
//
// Deliberately mirrors `splitters.ts`'s existing MOUSE-event drag model
// (mousedown/mousemove/mouseup on an injected `window`-shaped seam) rather than
// switching to Pointer Events — one drag primitive for the whole app, not two.
//
// Every pixel decision routes through `core/left-nav-layout.ts`'s pure
// reducers via a `LeftNavigationResizeSession` (`beginLeftNavigationResize`/
// `advanceLeftNavigationResize`/`commitLeftNavigationResize`): this module's own
// job is strictly pointer/keyboard mechanics, session bookkeeping, and ARIA —
// never the resize arithmetic itself, and never painting the sidebar (that is
// `deps.applyEffectiveLayout`, a callback a later app-shell step implements).

import { batch, effect } from '@preact/signals-core';
import {
  advanceLeftNavigationResize, beginLeftNavigationResize, commitLeftNavigationResize,
  leftNavigationSeparatorAria, leftNavigationWidthPx, normalizeLeftNavigationLayout,
  resolveLeftNavigationDrag, resolveLeftNavigationKey,
} from '../core/left-nav-layout.js';
import type {
  LeftNavigationLayout, LeftNavigationResizeSession, LeftNavigationSeparatorAria,
} from '../core/left-nav-layout.js';
import { readLeftNavigationLayout } from '../application/left-nav.js';
import type { LeftNavStateSlice } from '../application/left-nav.js';
import { NAV_SECTION_META } from './nav-sections.js';

/** The one field `mousedown`/`mousemove`/`mouseup` read — a plain `{clientX}`
 *  fixture satisfies it, exactly like `splitters.ts`'s own `DragPoint`. */
export interface LeftNavSeparatorPointerEvent {
  clientX: number;
}

/** The `window`-shaped mouse/blur seam — a real `Window` satisfies this
 *  directly (mirroring `splitters.ts`'s `DragWindow`, widened to also carry
 *  `blur`, which takes no event payload worth reading). */
export interface LeftNavSeparatorWindow {
  addEventListener(type: string, listener: (ev: LeftNavSeparatorPointerEvent) => void): void;
  removeEventListener(type: string, listener: (ev: LeftNavSeparatorPointerEvent) => void): void;
}

/** The `document`-shaped `visibilitychange` seam — deliberately NOT read for
 *  `document.visibilityState` (happy-dom cannot fake it): the event firing at
 *  all, regardless of direction, is treated as "stop and commit now". */
export interface LeftNavSeparatorTarget {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

/** The narrowed persistence seam — this module only ever names these three
 *  keys, the same narrowing precedent `application/left-nav.ts`'s own
 *  `LeftNavApp.prefs` sets for `'sidePanel'`. */
export interface LeftNavSeparatorPrefs {
  save(name: 'leftNavMode' | 'sidebarPx' | 'leftNavDrawerPx', value: unknown): void;
}

export interface LeftNavSeparatorDeps {
  /** The separator DOM element — `role`/`aria-*`/`tabindex` are applied to
   *  THIS element, and mousedown/keydown listen on it directly. */
  el: HTMLElement;
  /** Mouse-move/up/blur seam. Defaults to the real `window`. */
  win?: LeftNavSeparatorWindow;
  /** `visibilitychange` seam. Defaults to the real `document` — deliberately
   *  a SEPARATE seam from `win`, since visibility fires on the document. */
  target?: LeftNavSeparatorTarget;
  /** The same `LeftNavStateSlice` `application/left-nav.ts` reads/writes —
   *  reused rather than re-declared, so this module calls the real
   *  `readLeftNavigationLayout(state)` rather than re-implementing the same
   *  projection. */
  state: LeftNavStateSlice;
  prefs: LeftNavSeparatorPrefs;
  /** The live navigation width budget (shell width minus the centre surface's
   *  minimum minus the separator's own width) — a caller's job, not this
   *  module's; it only ever asks for a number when it needs one. */
  getMaxNavigationTotalPx(): number;
  /** The ONE DOM-painting seam: apply a proposed layout's pixels to the
   *  sidebar. This module never touches sidebar DOM itself. */
  applyEffectiveLayout(layout: LeftNavigationLayout): void;
  /** Optional status-announcement seam — a no-op when omitted. Called only on
   *  a semantic mode (or drawer open/closed) change, never on a plain width
   *  change within the same mode. */
  announce?(message: string): void;
}

export interface LeftNavSeparatorHandle {
  /** Remove every listener this module registered (mousedown/keydown on `el`;
   *  blur on `win`; visibilitychange on `target`; and, if a drag happens to be
   *  in progress, the drag-only mousemove/mouseup on `win` too) and stop the
   *  ARIA-refresh effect. Safe to call once; idempotent-safe to call again
   *  (every underlying `removeEventListener` is a no-op for an
   *  already-removed listener). */
  dispose(): void;
  /**
   * Re-apply this separator's own ARIA attributes (`aria-valuemin/max/now`,
   * `aria-valuetext`) from `layout`, without waiting for a
   * `leftNavMode`/`leftNavSection` signal change. The module's own
   * `disposeAriaEffect` above only re-runs on THOSE two signals — a WIDTH-only
   * change (a mount-time paint clamped by the live shell width, or a plain
   * window resize re-deriving the same mode at a different pixel budget) never
   * touches either signal, so nothing would otherwise tell this separator its
   * own advertised width just went stale. `app-shell.ts`'s
   * `applyEffectiveLeftNavigationLayout` calls this on every one of its own
   * invocations (mount, the preferred-state effect, the width observer) so the
   * separator's ARIA is never more stale than the sidebar it describes. Safe
   * to call during this separator's OWN active gesture too — it just
   * redundantly re-applies the same values `advanceTo`/`commitSession` already
   * did, mirroring the "harmless double-paint" tolerance already established
   * elsewhere in this phase.
   */
  refreshAria(layout: LeftNavigationLayout): void;
  /**
   * True while a pointer drag or a keyboard-resize is in progress (the
   * module-level `session` below is non-null). `app-shell.ts` reads this to
   * decide whether a trigger OTHER than this separator's own gesture (the
   * `ResizeObserver` callback) is safe to repaint from — repainting from the
   * committed preference mid-gesture would visibly fight the gesture's own
   * in-progress, not-yet-committed paint.
   */
  isSessionActive(): boolean;
  /**
   * Abandon an in-progress pointer-drag session without committing it — no
   * `state`/pref write, no repaint. Used by `app-shell.ts` when `isMobile`
   * changes mid-gesture (#487 phase-3 review, bug 2): a drag active across
   * that exact crossing has no way to notice the viewport just left desktop
   * under it, so its very next `mousemove` would otherwise repaint the
   * now-stale desktop layout right back over the mobile-wide presentation the
   * isMobile transition just forced. Nothing has been written to `state` by an
   * in-progress session (only `commitSession` writes), so simply detaching the
   * drag listeners and dropping the session is a clean no-op from `state`'s own
   * perspective — unlike `endDrag`, this never calls `commitSession`.
   *
   * A no-op when no pointer session is active. The keyboard-resize path
   * (`onKeyDown`) never needs this: it keeps its own session in a LOCAL
   * `keySession` variable and commits synchronously within one keydown, so the
   * module-level `session` this method reads is never set by a keyboard
   * operation in the first place.
   */
  cancelActiveSession(): void;
}

/** Describe the OCCUPIED-width quantity `aria-valuenow` reports, in words —
 *  mode-aware, but always naming the SAME total `aria-valuenow` carries (never
 *  a per-mode panel width; see this module's own header comment for the
 *  earlier design round that got this wrong). */
function describeOccupiedWidth(layout: LeftNavigationLayout): string {
  if (layout.mode === 'wide') return 'Wide sidebar';
  if (layout.focusedSection === null) return 'Rail only';
  return `Rail with ${NAV_SECTION_META[layout.focusedSection].label} drawer`;
}

function ariaValueText(layout: LeftNavigationLayout, aria: LeftNavigationSeparatorAria): string {
  if (layout.mode === 'rail' && layout.focusedSection !== null) {
    return `${describeOccupiedWidth(layout)}, ${aria.valueNow} pixels total`;
  }
  return `${describeOccupiedWidth(layout)}, ${aria.valueNow} pixels`;
}

/**
 * Mount the separator: apply its static ARIA/DOM attributes once, wire mouse,
 * keyboard, blur and visibilitychange handling, and return a `dispose()`.
 */
export function mountLeftNavSeparator(deps: LeftNavSeparatorDeps): LeftNavSeparatorHandle {
  const { el, state } = deps;
  const win: LeftNavSeparatorWindow = deps.win || window;
  const target: LeftNavSeparatorTarget = deps.target || document;

  el.setAttribute('role', 'separator');
  el.setAttribute('aria-orientation', 'vertical');
  el.setAttribute('tabindex', '0');

  // The in-progress drag/keyboard-resize session, or null between gestures.
  let session: LeftNavigationResizeSession | null = null;
  // #487 phase-3 review, blocker 1 — a pointer drag's own grab point, recorded
  // at `mousedown` and read only by `advanceTo` below. `dragGripOffsetPx` is
  // the distance from the navigation's CURRENT occupied edge (where the
  // handle is actually rendered right now — `leftNavigationWidthPx` of the
  // session's own `effective` layout at begin time, never a DOM measurement)
  // to wherever inside the handle the pointer actually grabbed: `clientX`
  // alone is not the navigation's total width unless the grab happened to
  // land exactly on the handle's left edge, and nothing forces that. Without
  // subtracting it, a drag started mid-handle (or the handle's rendered
  // position sitting somewhere the raw preference doesn't, e.g. viewport-
  // clamped) reads every subsequent `clientX` as if it WERE the edge, and can
  // report a proposal that differs from the true preference even when the
  // pointer never moved from where it landed. `dragMoved` (set only by a real
  // `mousemove`) plus `dragStartClientX` are what let `onMouseUp` recognize a
  // pure click-and-release and skip advancing the session at all, rather than
  // treating the release coordinate as a brand-new raw proposal — see
  // `onMouseUp`'s own comment.
  let dragGripOffsetPx = 0;
  let dragStartClientX = 0;
  let dragMoved = false;

  function applyAria(layout: LeftNavigationLayout): void {
    const normalized = normalizeLeftNavigationLayout(layout);
    const aria = leftNavigationSeparatorAria(normalized, deps.getMaxNavigationTotalPx());
    el.setAttribute('aria-valuemin', String(aria.valueMin));
    el.setAttribute('aria-valuemax', String(aria.valueMax));
    el.setAttribute('aria-valuenow', String(aria.valueNow));
    el.setAttribute('aria-valuetext', ariaValueText(normalized, aria));
  }

  // `writeLeftNavigationLayout` (`application/left-nav.ts`) is module-private
  // there (only ever the other half of THAT module's own single batched
  // write), so this mirrors its four-field write rather than importing it.
  // All four fields, including `leftNavSection`: a committed session's `mode`
  // and `focusedSection` always travel together (the layout's own coherence
  // invariant — see `core/left-nav-layout.ts`), so writing three of the four
  // could leave `state` holding an incoherent pair (e.g. `mode: 'wide'` with a
  // stale non-null `leftNavSection` from before the gesture converted rail to
  // wide). Only the PERSISTENCE call below is narrowed to three keys —
  // `leftNavSection` has no preference key at all (`focusedSection` is
  // session-only, per #487), so nothing here ever calls `prefs.save` for it.
  // Batched so the reactive ARIA effect below observes one coherent write, not
  // an intermediate mode/width mismatch mid-assignment.
  function writeLayout(layout: LeftNavigationLayout): void {
    batch(() => {
      state.leftNavMode.value = layout.mode;
      state.sidebarPx = layout.wideWidthPx;
      state.leftNavDrawerPx = layout.drawerWidthPx;
      state.leftNavSection.value = layout.focusedSection;
    });
  }

  function announceIfChanged(before: LeftNavigationLayout, after: LeftNavigationLayout): void {
    const modeChanged = before.mode !== after.mode;
    const openChanged = (before.focusedSection !== null) !== (after.focusedSection !== null);
    if (!modeChanged && !openChanged) return; // a plain width change — no chatter.
    deps.announce?.(`Left navigation: ${describeOccupiedWidth(after)}`);
  }

  function commitSession(finished: LeftNavigationResizeSession): void {
    const committed = commitLeftNavigationResize(finished);
    // Paint with the session's own final, viewport-clamped `effective` layout —
    // never `committed`, which can legitimately hold a larger, un-clamped
    // "honest preference" (the restore-while-clamped case below) that would
    // overflow the viewport if painted directly. For a pointer drag this is a
    // harmless repaint of the identical layout `advanceTo` already applied
    // (`onMouseUp` calls `advanceTo` immediately before `endDrag`/
    // `commitSession`); for the keyboard path (`onKeyDown`) this is the ONLY
    // place a keyboard-driven resize ever reaches the DOM at all.
    deps.applyEffectiveLayout(finished.effective);
    writeLayout(committed);
    deps.prefs.save('leftNavMode', committed.mode);
    deps.prefs.save('sidebarPx', committed.wideWidthPx);
    deps.prefs.save('leftNavDrawerPx', committed.drawerWidthPx);
    applyAria(committed);
    announceIfChanged(finished.preferredAtStart, committed);
  }

  // One reactive effect keeps ARIA current whenever `mode`/`focusedSection`
  // change for ANY reason — including a rail click elsewhere in the shell
  // (`left-rail.ts`'s `toggleFocusedSection`) that this module never
  // initiated. Runs once immediately (the mount-time paint), then on every
  // dependency change. `sidebarPx`/`leftNavDrawerPx` are plain fields, not
  // signals, so a WIDTH-only change from THIS module's own gestures relies on
  // `commitSession`'s own `applyAria(committed)` call above, not this effect.
  const disposeAriaEffect = effect(() => {
    state.leftNavMode.value;
    state.leftNavSection.value;
    applyAria(readLeftNavigationLayout(state));
  });

  /**
   * Advance the in-progress session to `clientX`. The shell-left offset is 0
   * today (phase 1's note in `core/left-nav-layout.ts`) — a future left
   * gutter would subtract it from `clientX` here, once, in this one place.
   */
  function advanceTo(clientX: number): void {
    // `!`: `onMouseMove`/`onMouseUp` are only ever listening on `win` while a
    // session is active — attached in `onMouseDown`, detached in `endDrag` —
    // so `advanceTo` is never reached with `session` null.
    //
    // `dragGripOffsetPx` (#487 phase-3 review, blocker 1): the pointer's own
    // `clientX` is the grab point, not the navigation edge — subtracting the
    // grip offset recovers the edge regardless of where in the handle the
    // drag started, so the panel's edge tracks under the SAME point the
    // pointer grabbed rather than snapping to wherever the raw coordinate
    // happens to sit.
    const totalPx = clientX - dragGripOffsetPx;
    const proposedLayout = resolveLeftNavigationDrag(session!.proposed, totalPx);
    session = advanceLeftNavigationResize(session!, proposedLayout, deps.getMaxNavigationTotalPx());
    deps.applyEffectiveLayout(session.effective);
    applyAria(session.effective);
  }

  function onMouseMove(ev: LeftNavSeparatorPointerEvent): void {
    dragMoved = true;
    advanceTo(ev.clientX);
  }

  /** The shared "stop listening for the mouse half of a drag" steps —
   *  factored out so both `endDrag()` and `cancelActiveSession()` (#487
   *  phase-3 review, bug 2) can detach without duplicating the three lines. */
  function detachDragListeners(): void {
    el.classList.remove('dragging');
    win.removeEventListener('mousemove', onMouseMove);
    win.removeEventListener('mouseup', onMouseUp);
  }

  /** Stop listening for the mouse half of a drag and commit whatever the
   *  session currently holds — used by mouseup (after one final `advanceTo`)
   *  AND by blur/visibilitychange (with no final coordinate — commit the
   *  session's CURRENT state as-is, never a rollback to session start).
   *
   *  Re-clamps against the CURRENT budget immediately before committing
   *  (#487 phase-3 review, bug 3): `onMouseUp` already re-clamps via its own
   *  `advanceTo(ev.clientX)` call just above this one, so for that path this
   *  is a harmless redundant re-clamp against the identical, already-current
   *  budget. For `onBlur`/`onVisibilityChange` — which call `endDrag()`
   *  directly, with no fresh clamp first — this is the first real clamp
   *  against whatever the budget is NOW, rather than committing a session
   *  whose `effective`/`proposed` can still reflect a budget measured before
   *  the window shrank while the drag was in progress (and the width
   *  observer's own repaint was skipped because `isSessionActive()` was
   *  true). Passing `session.proposed` back in as the raw proposal leaves the
   *  raw proposal itself untouched — only `effective` is refreshed. */
  function endDrag(): void {
    if (!session) return;
    detachDragListeners();
    const reclamped = advanceLeftNavigationResize(session, session.proposed, deps.getMaxNavigationTotalPx());
    session = null;
    commitSession(reclamped);
  }

  /** See `LeftNavSeparatorHandle.cancelActiveSession`'s own doc comment. */
  function cancelActiveSession(): void {
    if (!session) return;
    detachDragListeners();
    session = null;
  }

  function onMouseUp(ev: LeftNavSeparatorPointerEvent): void {
    // #487 phase-3 review, blocker 1 — a pure click-and-release, with no
    // genuine movement anywhere between `mousedown` and this event, must
    // preserve `preferredAtStart` untouched: `session.proposed` is still
    // exactly the preference `beginLeftNavigationResize` captured, and
    // `endDrag`'s own reclamp-and-commit below already leaves an unchanged
    // `proposed` alone (`commitLeftNavigationResize` only ever writes a
    // band's width when the raw proposal actually differs from the start).
    // Calling `advanceTo` here regardless — as before this fix — would treat
    // the release coordinate as a brand-new raw proposal even though the user
    // asked for no change, silently overwriting the stored preference with
    // whatever pixel the handle happened to be rendered at (a viewport clamp
    // makes this arbitrarily far from the real preference). `dragMoved` is
    // set by any real `mousemove`; the `clientX` comparison also catches a
    // release at a different point with no intervening `mousemove` at all
    // (unusual, but not impossible for a synthetic or coalesced event).
    if (dragMoved || ev.clientX !== dragStartClientX) {
      // The LAST coordinate before committing — never whatever the last
      // mousemove happened to leave (that can differ from the release point).
      advanceTo(ev.clientX);
    }
    endDrag();
  }

  // `el` is always a real DOM element (never an injected fake, unlike
  // `win`/`target`), so its own listeners are typed against the real DOM
  // event types directly — no cast needed, and a plain fixture is never
  // dispatched through it in tests either.
  function onMouseDown(ev: MouseEvent): void {
    ev.preventDefault();
    el.classList.add('dragging');
    session = beginLeftNavigationResize(readLeftNavigationLayout(state), deps.getMaxNavigationTotalPx());
    // The grip offset is measured against the session's own `effective`
    // layout — the CURRENT rendered occupied width — never a DOM measurement:
    // `leftNavigationWidthPx` is the same pure derivation `app-shell.ts`'s
    // paint already used to get the sidebar to this pixel in the first place,
    // so this needs no `getBoundingClientRect()` seam of its own and stays
    // exact regardless of a viewport clamp.
    dragGripOffsetPx = ev.clientX - leftNavigationWidthPx(session.effective);
    dragStartClientX = ev.clientX;
    dragMoved = false;
    win.addEventListener('mousemove', onMouseMove);
    win.addEventListener('mouseup', onMouseUp);
  }

  // No coordinate to read on either event — happy-dom cannot fake
  // `document.visibilityState` regardless, so both simply stop-and-commit
  // whatever the session already holds. A no-op when no drag is active.
  function onBlur(): void { endDrag(); }
  function onVisibilityChange(): void { endDrag(); }

  function onKeyDown(ev: KeyboardEvent): void {
    // A pointer session is authoritative while it is in progress (reachable:
    // Tab-focus the separator, then mousedown it too — focus survives a
    // mousedown on an already-focused element — and press an arrow while the
    // button is still held). Building and committing a SECOND, keyboard-only
    // session here would leave the original pointer session still installed,
    // ready to overwrite this keydown's outcome on its own eventual
    // mouseup/blur. The simpler, less surprising policy is to ignore keyboard
    // input entirely until the pointer gesture ends, rather than merging or
    // cancelling one session in favour of the other. No `preventDefault()`
    // either — this is "not handled right now", not "handled and consumed",
    // mirroring `resolveLeftNavigationKey`'s own null-return convention for a
    // key this module does not act on.
    if (session) return;
    const layout = readLeftNavigationLayout(state);
    const resolved = resolveLeftNavigationKey(layout, ev);
    if (resolved === null) return; // not one of ours — no preventDefault, no session.
    ev.preventDefault();
    // A single keydown is its own complete session: begin → one advance →
    // commit, immediately, through the exact same machinery a drag uses.
    const keySession = advanceLeftNavigationResize(
      beginLeftNavigationResize(layout, deps.getMaxNavigationTotalPx()),
      resolved,
      deps.getMaxNavigationTotalPx(),
    );
    commitSession(keySession);
  }

  el.addEventListener('mousedown', onMouseDown);
  el.addEventListener('keydown', onKeyDown);
  win.addEventListener('blur', onBlur);
  target.addEventListener('visibilitychange', onVisibilityChange);

  function dispose(): void {
    disposeAriaEffect();
    el.removeEventListener('mousedown', onMouseDown);
    el.removeEventListener('keydown', onKeyDown);
    win.removeEventListener('blur', onBlur);
    target.removeEventListener('visibilitychange', onVisibilityChange);
    // Defensive: harmless no-op if a drag isn't in progress, but guarantees no
    // lingering mousemove/mouseup handler if dispose() runs mid-drag.
    win.removeEventListener('mousemove', onMouseMove);
    win.removeEventListener('mouseup', onMouseUp);
    // Leave no half-finished gesture behind regardless of what called
    // dispose() mid-drag: the shell's own teardown path typically replaces
    // this DOM shortly afterward anyway, but this module's own contract
    // should not depend on that — a caller that inspects `el` or a would-be
    // `isSessionActive()` after dispose() should see a clean state, not a
    // dangling `.dragging` class or a session nothing will ever commit.
    el.classList.remove('dragging');
    session = null;
  }

  return {
    dispose, refreshAria: applyAria, isSessionActive: () => session !== null, cancelActiveSession,
  };
}
