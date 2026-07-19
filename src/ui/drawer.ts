// Shared right-side drawer chrome (#60, deferred from #101/#166's `.cd-*`
// scaffold in results.ts). This module owns exactly the NON-modal part of
// that scaffold: the panel/head/close-button DOM and the bounded horizontal
// resize handle. Modality — the backdrop, its click-outside close, Escape/
// stacking order — is composed by each caller (results.ts's openCellDetail /
// openRowsViewer keep that themselves) so a persistent, non-modal consumer
// (a docs pane, #313) can reuse the same chrome without inheriting a
// backdrop or focus trap it doesn't want.

import { h, withDocument } from './dom.js';
import { Icon } from './icons.js';
import { startDrag, clampDrawerWidth } from './splitters.js';
import type { PreferenceKey } from '../application/app-preferences.js';

/** `buildDrawerChrome`'s options — `classPrefix` defaults to `'cd'` (the
 *  existing cell-detail/rows-viewer prefix), so the two current callers keep
 *  byte-identical `.cd-panel`/`.cd-head`/`.cd-title`/`.cd-close` output. A
 *  different consumer (e.g. a docs pane) passes its own prefix to get its own
 *  classes instead of inheriting `.cd-*`'s CSS. */
export interface DrawerChromeOptions {
  classPrefix?: string;
  /** Children of the head's title element (before the close button). */
  title: unknown[];
  onClose: () => void;
}

/** The chrome `buildDrawerChrome` hands back: `panel` has `head` appended
 *  already — the caller appends its own body/content afterward (append order
 *  is all that matters for the existing DOM shape, not whether the body was
 *  passed to the constructor or appended later). */
export interface DrawerChrome {
  panel: HTMLElement;
  head: HTMLElement;
}

/**
 * Build the right-side drawer's non-modal chrome: `<div class="{p}-panel">`
 * containing `<div class="{p}-head">` (a `{p}-title` div holding `title`'s
 * children, then a `{p}-close` button wired to `onClose`). No backdrop, no
 * Escape/focus handling — the caller composes those (or doesn't, for a
 * persistent pane).
 */
export function buildDrawerChrome(doc: Document, opts: DrawerChromeOptions): DrawerChrome {
  const p = opts.classPrefix || 'cd';
  return withDocument(doc, () => {
    const head = h('div', { class: `${p}-head` },
      h('div', { class: `${p}-title` }, ...opts.title),
      h('button', { class: `${p}-close`, title: 'Close (Esc)', onclick: opts.onClose }, Icon.close()));
    const panel = h('div', { class: `${p}-panel` }, head);
    return { panel, head };
  });
}

/** The narrow app surface `attachDrawerResize` needs: the persisted drawer
 *  width (read on open, written mid-drag) and the preference-save seam —
 *  matches `ResultsApp`'s `state`/`prefs` members structurally, so results.ts
 *  passes its `ResultsApp` straight through. */
export interface DrawerResizeApp {
  state: { cellDrawerPx: number };
  prefs: { save(name: PreferenceKey, value: unknown): void };
}

/**
 * Wire the left-edge drag handle that resizes a drawer panel (#101), via
 * splitters.js's drag controller (the 'drawer' axis alongside 'col'/
 * 'sideRow'/'row'). Sets the initial width from the persisted `cellDrawerPx`
 * pref, clamped to the current viewport, and appends the handle to `panel`.
 *
 * A resize drag that ends with the mouse over a modal caller's backdrop no
 * longer needs a dedicated swallow-listener here: a caller using
 * `attachBackdropClose` (dom.js, #110) tracks where `mousedown` actually
 * landed, and this handle is a panel descendant, so that drag's trailing
 * click — wherever it targets — never closes the drawer.
 *
 * Returns `cancelDrag()`: the drawer's own close (Escape / backdrop click /
 * ✕, or — for a non-modal caller — whatever else it wires) can fire while the
 * mouse button is still down mid-drag — without this, the abandoned drag's
 * `mousemove`/`mouseup` listeners would linger on `win` after the panel is
 * gone, so a later unrelated mouseup would still persist a stale
 * `cellDrawerPx`. The caller's close must call this before removing the
 * panel. A no-op if no drag is in progress.
 */
export function attachDrawerResize(app: DrawerResizeApp, panel: HTMLElement, doc: Document): () => void {
  // doc.defaultView is null for a detached document not yet attached to a real
  // browsing context (e.g. tests' document.implementation.createHTMLDocument());
  // a real detached tab (window.open()) always has one. Fall back to the
  // ambient window rather than crash on the (harmless) synthetic-doc case.
  const win = doc.defaultView || window;
  panel.style.width = clampDrawerWidth(app.state.cellDrawerPx, win.innerWidth) + 'px';
  let cancelActive: (() => void) | null = null;
  const handle = h('div', {
    class: 'cd-resize-h',
    title: 'Drag to resize',
    onmousedown: (ev: MouseEvent) => {
      const startPx = app.state.cellDrawerPx;
      const stopDrag = startDrag(
        // `as Element`: this handler is only ever reached via a real
        // `mousedown` dispatched on `handle` itself (the listener target),
        // so `currentTarget` is always that element, never null — the DOM
        // lib's own `EventTarget | null` is just wider than the true contract.
        { preventDefault: () => ev.preventDefault(), currentTarget: ev.currentTarget as Element },
        'drawer',
        {
          win,
          state: app.state,
          rectFor: () => ({ width: win.innerWidth }),
          apply: (_axis, value) => { panel.style.width = value + 'px'; },
          save: (name, value) => app.prefs.save(name as PreferenceKey, value),
        },
      );
      cancelActive = () => { stopDrag(); app.state.cellDrawerPx = startPx; cancelActive = null; };
    },
  });
  panel.appendChild(handle);
  return () => { if (cancelActive) cancelActive(); };
}
