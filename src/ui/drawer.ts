// Shared right-side drawer chrome (#60, deferred from #101/#166's `.cd-*`
// scaffold in results.ts).
//
// #586 REWRITE: this module used to describe (and enforce) a deliberate
// three-independent-surface split — the cell-detail drawer, the rows viewer,
// and the Reference/docs pane each owned their OWN modality (backdrop,
// Escape, stacking order) and their OWN persisted resize width
// (`cellDrawerPx` vs `docPanePx`), composing only this file's NON-modal
// chrome (the panel/head/close-button DOM) in common. #586 replaced all three
// independent overlays with one shell-owned docked `inspectorHost`
// (app-shell.ts) — every surface's lifecycle (open/close/Escape/focus) now
// runs through the shared `surface-lifecycle.ts` primitive, and "which one
// occupies the shared dock" is `inspector-host.ts`'s job. This module keeps
// owning only what's still genuinely shared: `buildDrawerChrome` (the
// panel/head/close-button DOM, still built by every docked surface) and
// `attachDrawerResize` — which now survives ONLY for the one surface that
// still isn't docked: a cell-detail drawer opened inside a real detached
// browser tab (results.ts's Data Pane), which has no shell/`inspectorHost` of
// its own to be resized by app-shell.ts's shared handle. Every docked
// surface's OWN resize handle and its former per-surface `stateKey`/`axis`
// indirection (this module used to expose `{ stateKey: 'cellDrawerPx' |
// 'docPanePx' }`) are gone — the shared dock has exactly one width
// (`rightInspectorPx`, state.ts), owned by app-shell.ts's own resize handle,
// and this file's surviving consumer resizes against that SAME preference.

import { h, withDocument } from './dom.js';
import { Icon } from './icons.js';
import { startDrag, clampDrawerWidth } from './splitters.js';
import type { SplitterAxis } from './splitters.js';
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

/** The narrow app surface `attachDrawerResize` needs: the persisted
 *  right-inspector width (read on open, written mid-drag) and the
 *  preference-save seam — matches `ResultsApp`'s `state`/`prefs` members
 *  structurally, so results.ts passes its `ResultsApp` straight through. */
export interface DrawerResizeApp {
  state: { rightInspectorPx?: number };
  prefs: { save(name: PreferenceKey, value: unknown): void };
}

/**
 * Wire the left-edge drag handle that resizes a drawer panel (#101), via
 * splitters.ts's drag controller (the `'rightInspector'` axis alongside
 * 'col'/'sideRow'/'row'). Sets the initial width from the persisted
 * `rightInspectorPx` pref, clamped to the current viewport, and appends the
 * handle to `panel`.
 *
 * #586: every DOCKED surface (cell detail, rows viewer, Reference) now
 * resizes via app-shell.ts's own shared handle on `inspectorHost` instead —
 * this function survives only for the one surface that isn't docked: a
 * cell-detail drawer opened inside a real detached browser tab (results.ts's
 * Data Pane), which has no shell of its own for a shared handle to belong to.
 * It resizes against the SAME `rightInspectorPx` preference the dock uses
 * (there is only one right-inspector width now, not a per-surface one).
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
 * gone, so a later unrelated mouseup would still persist a stale width. The
 * caller's close must call this before removing the panel. A no-op if no
 * drag is in progress.
 */
export function attachDrawerResize(app: DrawerResizeApp, panel: HTMLElement, doc: Document): () => void {
  // doc.defaultView is null for a detached document not yet attached to a real
  // browsing context (e.g. tests' document.implementation.createHTMLDocument());
  // a real detached tab (window.open()) always has one. Fall back to the
  // ambient window rather than crash on the (harmless) synthetic-doc case.
  const win = doc.defaultView || window;
  // `!`: the real AppState (state.ts) always has rightInspectorPx — every
  // production caller resolves to a real number.
  panel.style.width = clampDrawerWidth(app.state.rightInspectorPx!, win.innerWidth) + 'px';
  let cancelActive: (() => void) | null = null;
  const axis: SplitterAxis = 'rightInspector';
  const handle = h('div', {
    class: 'cd-resize-h',
    title: 'Drag to resize',
    onmousedown: (ev: MouseEvent) => {
      const startPx = app.state.rightInspectorPx!;
      const stopDrag = startDrag(
        // `as Element`: this handler is only ever reached via a real
        // `mousedown` dispatched on `handle` itself (the listener target),
        // so `currentTarget` is always that element, never null — the DOM
        // lib's own `EventTarget | null` is just wider than the true contract.
        { preventDefault: () => ev.preventDefault(), currentTarget: ev.currentTarget as Element },
        axis,
        {
          win,
          state: app.state,
          rectFor: () => ({ width: win.innerWidth }),
          apply: (_axis, value) => { panel.style.width = value + 'px'; },
          save: (name, value) => app.prefs.save(name as PreferenceKey, value),
        },
      );
      cancelActive = () => { stopDrag(); app.state.rightInspectorPx = startPx; cancelActive = null; };
    },
  });
  panel.appendChild(handle);
  return () => { if (cancelActive) cancelActive(); };
}
