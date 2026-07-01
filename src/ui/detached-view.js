// The detached-view primitive: open a caller-defined view either in a real
// browser tab (kept live by the opener) or, on any failure — pop-up blocked,
// null window, or a COOP-severed document — an in-app `.graph-overlay`
// backdrop. Shared by the schema graph, the EXPLAIN pipeline graph, and the
// Data Pane (results.js), replacing what used to be schema-only
// openInTab/openInOverlay. `mode` is informational only: it picks the
// content-mount's CSS class ('graph-overlay-canvas' vs 'data-pane-body') so
// each caller's own CSS still applies.

import { h, withDocument } from './dom.js';
import { Icon } from './icons.js';

// Copy the theme/density data-attributes onto the child tab's <html> so its
// CSS custom properties resolve to the same colours as the main window. Also
// carry the opener's measured --vp-zoom (the per-engine viewport-unit divisor,
// #70) so the tab's fullscreen panel sizes correctly; if the opener never
// measured it, the tab keeps the CSS default (--vp-zoom: var(--zoom)).
function mirrorTheme(src, dst) {
  for (const attr of ['data-theme', 'data-density']) {
    const v = src.documentElement.getAttribute(attr);
    if (v != null) dst.documentElement.setAttribute(attr, v);
  }
  const vp = src.documentElement.style.getPropertyValue('--vp-zoom');
  if (vp) dst.documentElement.style.setProperty('--vp-zoom', vp);
}

// The shared chrome: a title bar + an (empty) content mount, inside a panel.
// Reused by the new browser tab and the in-app overlay fallback.
function buildPanel(mode, title) {
  const bar = h('div', { class: 'graph-overlay-bar' }, h('span', { class: 'graph-overlay-title' }, title));
  const body = h('div', { class: mode === 'grid' ? 'data-pane-body' : 'graph-overlay-canvas', tabindex: '-1' });
  const panel = h('div', { class: 'graph-overlay-panel', onclick: (e) => e.stopPropagation() }, bar, body);
  return { panel, bar, body };
}

// Drive a same-origin about:blank tab from the opener: copy the page CSS +
// theme, mount the panel, and hand control to `mount()`. `closeBtn` is always
// null here — no close button; the browser tab's own close serves that. A
// real tab-close (or the window otherwise going away) still runs mount()'s
// teardown + `onClose` via `pagehide`, so any resources it holds elsewhere
// (e.g. state accounting) don't leak past the tab's lifetime.
function openAsTab(app, win, childDoc, mainDoc, title, mode, mount, onClose) {
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
    let teardown = null;
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
function openAsOverlay(app, mainDoc, title, mode, mount, onClose) {
  return withDocument(mainDoc, () => {
    const { panel, bar, body } = buildPanel(mode, title);
    let teardown = null;
    let closed = false;
    let backdrop;
    const close = () => {
      if (closed) return;
      closed = true;
      backdrop.remove();
      if (teardown) teardown();
      onClose();
    };
    backdrop = h('div', { class: 'graph-overlay', onclick: close }, panel);
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
export function openInDetachedTab(app, { title, mode, mount }) {
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
  let win = null;
  let childDoc = null;
  try {
    win = app.openWindow('', '_blank');
    childDoc = win && win.document;
  } catch (e) { win = null; }
  if (win && childDoc) return openAsTab(app, win, childDoc, mainDoc, title, mode, mount, onClose);
  return openAsOverlay(app, mainDoc, title, mode, mount, onClose);
}
