// The detached-view primitive: open a caller-defined view either in a real
// browser tab (kept live by the opener) or, on any failure — pop-up blocked,
// null window, or a COOP-severed document — an in-app `.graph-overlay`
// backdrop. Shared by the schema graph, the EXPLAIN pipeline graph, and the
// Data Pane (results.js), replacing what used to be schema-only
// openInTab/openInOverlay. `mode` is informational only: it picks the
// content-mount's CSS class ('graph-overlay-canvas' vs 'data-pane-body') so
// each caller's own CSS still applies.

import { h, withDocument, attachBackdropClose } from './dom.js';
import { Icon } from './icons.js';
import type { Signal } from '@preact/signals-core';

/** The window-like object `app.openWindow()` returns — a real `Window` in
 *  production. Accessing `.document` may legitimately throw (COOP severing
 *  the opener), which is handled by the caller's own try/catch. */
export interface DetachedWindowLike {
  document: Document | null;
  focus(): void;
  addEventListener(type: string, listener: () => void): void;
}

/** The minimal `app` surface this module reads — deliberately a small,
 *  partial contract: `openInDetachedTab` is also called with `null` or an
 *  app missing `document`/`state` (see the tests), so every field but
 *  `openWindow` is optional here. */
export interface DetachedViewApp {
  document?: Document;
  stylesText?: string;
  faviconHref?: string;
  state?: { detachedView?: Signal<number> };
  openWindow(url: string, target: string): DetachedWindowLike | null;
}

/** The content-mount CSS class switch — the two current callers (EXPLAIN/
 *  schema graphs vs. the Data Pane grid). */
export type DetachedViewMode = 'grid' | 'graph';

/** What `mount()` is called with — see `openInDetachedTab`'s doc comment for
 *  the full contract of each field. */
export interface MountCtx {
  doc: Document;
  bar: HTMLElement;
  body: HTMLElement;
  close: () => void;
  closeBtn: HTMLElement | null;
}

/** `mount()` may optionally return a teardown fn, invoked once from `close()`. */
export type MountFn = (ctx: MountCtx) => void | (() => void);

/** `openInDetachedTab`'s options bag. */
export interface OpenInDetachedTabOpts {
  title: string;
  mode: DetachedViewMode;
  mount: MountFn;
}

/** What every `openInDetachedTab` call returns. */
export interface DetachedView {
  close: () => void;
}

// Copy the theme/density data-attributes onto the child tab's <html> so its
// CSS custom properties resolve to the same colours as the main window.
function mirrorTheme(src: Document, dst: Document): void {
  for (const attr of ['data-theme', 'data-density']) {
    const v = src.documentElement.getAttribute(attr);
    if (v != null) dst.documentElement.setAttribute(attr, v);
  }
}

// The shared chrome: a title bar + an (empty) content mount, inside a panel.
// Reused by the new browser tab and the in-app overlay fallback.
function buildPanel(mode: DetachedViewMode, title: string): { panel: HTMLElement; bar: HTMLElement; body: HTMLElement } {
  const bar = h('div', { class: 'graph-overlay-bar' }, h('span', { class: 'graph-overlay-title' }, title));
  const body = h('div', { class: mode === 'grid' ? 'data-pane-body' : 'graph-overlay-canvas', tabindex: '-1' });
  const panel = h('div', { class: 'graph-overlay-panel' }, bar, body);
  return { panel, bar, body };
}

// Drive a same-origin about:blank tab from the opener: copy the page CSS +
// theme, mount the panel, and hand control to `mount()`. `closeBtn` is always
// null here — no close button; the browser tab's own close serves that. A
// real tab-close (or the window otherwise going away) still runs mount()'s
// teardown + `onClose` via `pagehide`, so any resources it holds elsewhere
// (e.g. state accounting) don't leak past the tab's lifetime.
function openAsTab(
  app: DetachedViewApp | null, win: DetachedWindowLike, childDoc: Document, mainDoc: Document,
  title: string, mode: DetachedViewMode, mount: MountFn, onClose: () => void,
): DetachedView {
  return withDocument(childDoc, () => {
    childDoc.head.appendChild(h('style', null, (app && app.stylesText) || ''));
    // about:blank ships no favicon either — mirror the opener's so the new tab
    // doesn't show the browser's generic default icon.
    const favicon = app && app.faviconHref;
    if (favicon) childDoc.head.appendChild(h('link', { rel: 'icon', href: favicon }));
    mirrorTheme(mainDoc, childDoc);
    childDoc.title = title;
    const { panel, bar, body } = buildPanel(mode, title);
    childDoc.body.className = 'detached-tab';
    childDoc.body.appendChild(panel);
    win.focus(); // bring the new tab to the front + give it window focus for key events
    let teardown: (() => void) | null = null;
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      if (teardown) teardown();
      onClose();
    };
    const ret = mount({ doc: childDoc, bar, body, close, closeBtn: null });
    if (typeof ret === 'function') teardown = ret;
    win.addEventListener('pagehide', close);
    return { close };
  });
}

// In-app modal overlay — the fallback when a real tab can't be opened.
// Backdrop-click closes here; Esc/✕ placement is mount()'s job (see
// `closeBtn` below) since only the caller knows when its own action cluster
// (built synchronously in mount(), or later/asynchronously, as the schema
// graph's render() does) is finalized — the primitive builds the ✕ button
// and wires it to `close`, but leaves WHERE to place it to the caller so it
// can land wherever the caller's own trailing actions cluster ends up.
function openAsOverlay(
  app: DetachedViewApp | null, mainDoc: Document, title: string, mode: DetachedViewMode,
  mount: MountFn, onClose: () => void,
): DetachedView {
  return withDocument(mainDoc, () => {
    const { panel, bar, body } = buildPanel(mode, title);
    let teardown: (() => void) | null = null;
    let closed = false;
    let backdrop: HTMLElement;
    let detachBackdrop: () => void;
    const close = () => {
      if (closed) return;
      closed = true;
      detachBackdrop();
      backdrop.remove();
      if (teardown) teardown();
      onClose();
    };
    backdrop = h('div', { class: 'graph-overlay' }, panel);
    detachBackdrop = attachBackdropClose(backdrop, close);
    const closeBtn = h('button', { class: 'graph-overlay-close', title: 'Close (Esc)', onclick: close }, Icon.close());
    const ret = mount({ doc: mainDoc, bar, body, close, closeBtn });
    if (typeof ret === 'function') teardown = ret;
    mainDoc.body.appendChild(backdrop);
    return { close };
  });
}

/**
 * Open a detached view: a real browser tab when possible (opened
 * synchronously so it survives the click gesture), falling back to the
 * in-app overlay on any failure — popup blocked, a null/windowless
 * `openWindow` result, or a COOP-severed document. `mount({ doc, bar, body,
 * close, closeBtn })` is called once, synchronously, to build the view's
 * content:
 *   - doc:      the document to build into (the tab's, or mainDoc in the
 *               overlay fallback) — pass to withDocument()/h() so elements
 *               land in the right realm, including from a later callback (a
 *               click handler), since the ambient doc set here doesn't
 *               persist past this synchronous call.
 *   - bar:      the title-bar element — append extra buttons/actions here.
 *   - body:     the empty content mount (classed by `mode`).
 *   - close:    tears the view down — browser-tab-close, Esc, ✕, and
 *               backdrop-click (overlay only) all funnel through it. Esc/
 *               nested-UI priority is entirely mount()'s responsibility; the
 *               primitive installs no default Escape handling.
 *   - closeBtn: the ✕ button, pre-wired to `close` — append it wherever your
 *               own trailing actions cluster ends up (last, so it stays the
 *               rightmost action). `null` in a real tab (no close affordance
 *               — the browser tab's own close serves that).
 * mount() may return a teardown fn, invoked once from close().
 * Tracks `app.state.detachedView` (a count, not a bool, so several views can
 * be open at once) while any view opened through here is live.
 */
export function openInDetachedTab(app: DetachedViewApp | null, { title, mode, mount }: OpenInDetachedTabOpts): DetachedView {
  const mainDoc = (app && app.document) || document;
  const dv = app && app.state && app.state.detachedView;
  if (dv) dv.value++;
  const onClose = () => { if (dv) dv.value--; };
  // Only the window-open + cross-realm .document access can legitimately
  // fail here (popup blocked, null app, COOP severing the opener) — mount()
  // itself runs outside this try so a bug in a caller's content-building code
  // surfaces as a real error instead of being swallowed and misread as a
  // blocked popup (which would leave a broken, orphaned tab open *and* mount
  // a duplicate fallback overlay on top of it).
  let win: DetachedWindowLike | null = null;
  let childDoc: Document | null = null;
  try {
    // `!`: a null `app` legitimately throws here (TypeError) — caught below,
    // same as a real popup-blocked/COOP failure — so this is not a runtime
    // fallback, just a type-level acknowledgment of that throw path.
    win = app!.openWindow('', '_blank');
    childDoc = win && win.document;
  } catch (e) { win = null; }
  if (win && childDoc) return openAsTab(app, win, childDoc, mainDoc, title, mode, mount, onClose);
  return openAsOverlay(app, mainDoc, title, mode, mount, onClose);
}
