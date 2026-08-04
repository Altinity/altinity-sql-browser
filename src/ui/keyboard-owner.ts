// #588 W2 (phase 4, decompose the `createApp` composition root): the
// keyboard-owner release/acquire adapter every menu/chooser primitive wires
// into `onKeyboardOwnerChange` — hoisted out of three near-identical private
// copies (`file-menu.ts`, `library-assign-menu.ts`, `dashboard.ts`) into one
// shared function. Verified byte-identical bodies before unifying (see the
// worker report for this phase): each held `let release: (() => void) | null
// = null;` and the exact same `(owner) => { release?.(); release = owner ?
// app.acquireKeyboardOwner(owner.kind) : null; }` — only the three copies'
// parameter TYPE varied (`Pick<App, 'acquireKeyboardOwner'>` in two,
// `Pick<DashboardApp, 'acquireKeyboardOwner'>` in the third), and
// `DashboardApp['acquireKeyboardOwner']` is already declared as
// `App['acquireKeyboardOwner']` verbatim (`dashboard.ts`), so the narrow
// structural parameter below accepts all three real call sites unchanged.

import type { KeyboardOwner, KeyboardOwnerRelease } from './app.types.js';

/** The narrow `app`-shaped seam this adapter reads — any object exposing
 *  `acquireKeyboardOwner` with `App`'s exact signature (an `App`, a
 *  `DashboardApp`, or a test fake) satisfies it structurally. */
export interface KeyboardOwnerHost {
  acquireKeyboardOwner(kind: KeyboardOwner['kind']): KeyboardOwnerRelease;
}

/**
 * Build a menu/popover's `onKeyboardOwnerChange` adapter bound to `app`:
 * acquires ownership of the given `kind` on open, releases the PREVIOUS
 * acquisition (if any) before acquiring the new one on an owner swap, and
 * releases on close (`owner === null`). Each call returns a fresh, private
 * `release` closure — never shared across menus — so releasing one menu's
 * ownership can never clobber another's.
 */
export function keyboardOwnerChannel(
  app: KeyboardOwnerHost,
): (owner: KeyboardOwner | null) => void {
  let release: (() => void) | null = null;
  return (owner) => {
    release?.();
    release = owner ? app.acquireKeyboardOwner(owner.kind) : null;
  };
}
