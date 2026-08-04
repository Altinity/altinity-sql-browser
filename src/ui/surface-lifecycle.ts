// The shared open/close/Escape/focus-restore primitive (#586), extracted from
// SIX near-duplicate lifecycles that had each grown their own slightly
// different Escape rule and focus-restore step: the cell-detail drawer and
// rows viewer (results.ts), the Reference documentation pane (doc-pane.ts),
// the detached-view overlay fallback (detached-view.ts), and the two BEST
// implementations in the codebase — dialog-shell.ts and popover.ts — reused
// by neither. This module owns exactly that shared slice: idempotent
// teardown, an explicit `escapePolicy`, optional keyboard-owner acquisition,
// and `returnFocusTo`'s element-or-resolver contract (borrowed verbatim from
// dialog-shell.ts's own doc comment — a resolver is called AT close time so
// it can hand back whatever is on screen now, rather than a possibly-detached
// element captured at open time).
//
// Deliberately DOES NOT own: DOM construction (buildDrawerChrome/dialog
// cards/panels are each caller's own job), backdrop/scrim, a Tab trap, or
// which physical host a surface's content mounts into (`inspector-host.ts`
// owns "one thing occupies the shared dock at a time" — a separate, smaller
// concern layered on top of this one).

/** Which Escape presses this surface reacts to. `'always'` closes
 *  unconditionally (the cell-detail drawer / rows viewer, now that the docked
 *  model has room for only one occupant at a time — there is no longer a
 *  "topmost of several stacked" case to scope against). `'focus-inside'`
 *  closes only while focus is inside `panel` (the Reference pane's existing
 *  behavior — Escape must not ALSO fire the global cancel-running-query
 *  shortcut when focus is elsewhere on the page). `'none'` installs no
 *  Escape handling at all — the caller owns Escape entirely (e.g. a future
 *  surface that must consume Escape for something other than closing). */
export type EscapePolicy = 'always' | 'focus-inside' | 'none';

export interface SurfaceLifecycleOptions {
  /** The realm to install the capture-phase Escape listener on, and to read
   *  `activeElement` from for `'focus-inside'`. */
  document: Document;
  escapePolicy: EscapePolicy;
  /** Containment check target for `'focus-inside'` — ignored by the other two
   *  policies (never read when `escapePolicy !== 'focus-inside'`). */
  panel: Element;
  /** Acquire the shared modal keyboard-owner slot on open, release it on
   *  close. Omit for a non-modal surface (Reference) that shares the
   *  keyboard freely with the editor/results underneath it. */
  acquireKeyboardOwner?: (kind: 'modal') => () => void;
  /** Where focus goes on close — an element, a resolver called AT close time
   *  (see this module's header comment), or `null` for nothing to restore. */
  returnFocusTo: HTMLElement | (() => HTMLElement | null) | null;
  /** Runs on every close path, exactly once, AFTER focus has been restored. */
  onClose?: () => void;
}

export interface SurfaceLifecycleHandle {
  /** Idempotent — every dismissal path (Escape, a caller's own ✕ button, a
   *  force-close from a new occupant replacing this one) funnels here, and a
   *  second call is a harmless no-op that never re-fires `onClose`. */
  close(): void;
  /** Whether this surface is still open (false once `close()` has run). */
  isOpen(): boolean;
}

/**
 * Open one surface's shared lifecycle: install (unless `escapePolicy ===
 * 'none'`) a capture-phase Escape listener obeying `escapePolicy`, optionally
 * acquire the modal keyboard-owner slot, and return a `close()` that tears
 * both down, restores focus per `returnFocusTo`, and runs `onClose` — all
 * exactly once no matter how many times `close()` is called.
 */
export function openSurfaceLifecycle(opts: SurfaceLifecycleOptions): SurfaceLifecycleHandle {
  const doc = opts.document;
  const release = opts.acquireKeyboardOwner ? opts.acquireKeyboardOwner('modal') : null;
  let open = true;

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape') return;
    if (opts.escapePolicy === 'focus-inside' && !opts.panel.contains(doc.activeElement)) return;
    // Both preventDefault (so shortcuts.ts's `if (e.defaultPrevented) return
    // null` guard skips its own Escape handling — e.g. cancelling a running
    // query) AND stopPropagation: a capture-phase handler that only calls
    // preventDefault still lets the SAME event reach every bubble-phase
    // `document` listener afterward (only real browsers enforce this —
    // happy-dom's unit tests never caught it, only a real Chromium/WebKit
    // e2e run did). A non-modal surface (Reference) must consume the event
    // outright, not merely mark it handled and let it keep propagating.
    e.preventDefault();
    e.stopPropagation();
    close();
  };

  function close(): void {
    if (!open) return;
    open = false;
    if (opts.escapePolicy !== 'none') doc.removeEventListener('keydown', onKeyDown, true);
    release?.();
    const restore = typeof opts.returnFocusTo === 'function' ? opts.returnFocusTo() : opts.returnFocusTo;
    restore?.focus();
    opts.onClose?.();
  }

  if (opts.escapePolicy !== 'none') doc.addEventListener('keydown', onKeyDown, true);

  return { close, isOpen: () => open };
}
