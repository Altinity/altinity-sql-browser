// #487 phase 3 — the left navigation's resize/mode-changing separator. A
// STANDALONE module today: it will replace `splitters.ts`'s `'col'` axis in a
// later step, but nothing here is wired into the app shell yet, and nothing in
// `splitters.ts` is touched by this change.
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
  leftNavigationSeparatorAria, normalizeLeftNavigationLayout, resolveLeftNavigationDrag,
  resolveLeftNavigationKey,
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
    const proposedLayout = resolveLeftNavigationDrag(session!.proposed, clientX);
    session = advanceLeftNavigationResize(session!, proposedLayout, deps.getMaxNavigationTotalPx());
    deps.applyEffectiveLayout(session.effective);
    applyAria(session.effective);
  }

  function onMouseMove(ev: LeftNavSeparatorPointerEvent): void {
    advanceTo(ev.clientX);
  }

  /** Stop listening for the mouse half of a drag and commit whatever the
   *  session currently holds — used by mouseup (after one final `advanceTo`)
   *  AND by blur/visibilitychange (with no final coordinate — commit the
   *  session's CURRENT state as-is, never a rollback to session start). */
  function endDrag(): void {
    if (!session) return;
    el.classList.remove('dragging');
    win.removeEventListener('mousemove', onMouseMove);
    win.removeEventListener('mouseup', onMouseUp);
    const finished = session;
    session = null;
    commitSession(finished);
  }

  function onMouseUp(ev: LeftNavSeparatorPointerEvent): void {
    // The LAST coordinate before committing — never whatever the last
    // mousemove happened to leave (that can differ from the release point).
    advanceTo(ev.clientX);
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
    win.addEventListener('mousemove', onMouseMove);
    win.addEventListener('mouseup', onMouseUp);
  }

  // No coordinate to read on either event — happy-dom cannot fake
  // `document.visibilityState` regardless, so both simply stop-and-commit
  // whatever the session already holds. A no-op when no drag is active.
  function onBlur(): void { endDrag(); }
  function onVisibilityChange(): void { endDrag(); }

  function onKeyDown(ev: KeyboardEvent): void {
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
  }

  return { dispose };
}
