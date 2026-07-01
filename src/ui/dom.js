// Minimal hyperscript helper. `h(tag, props, ...children)` builds a DOM node;
// `s(tag, ...)` is the same in the SVG namespace. Both support function
// components (h only), style objects, class/className, raw html, on* event
// listeners, boolean/null skipping, and nested/array children.

const SVG_NS = 'http://www.w3.org/2000/svg';

// Ambient target document. Normally null → the global `document` (the served
// page). `withDocument(doc, fn)` redirects element creation at `doc` for the
// duration of `fn`, so the same builders can populate a second window (the
// schema graph's new browser tab) without a document parameter on every call.
let DOC = null;
const D = () => DOC || document;
// Realm-agnostic "is this a DOM node?" — `instanceof Node` is false for a node
// from another window (e.g. the schema tab), so we duck-type on nodeType.
const isNode = (c) => c != null && typeof c === 'object' && typeof c.nodeType === 'number';
export function withDocument(doc, fn) {
  const prev = DOC;
  DOC = doc;
  try { return fn(); } finally { DOC = prev; }
}

// Shared prop/children application — the only difference between h and s is
// which document factory creates the element.
function apply(el, props, children) {
  if (props) {
    for (const k in props) {
      const v = props[k];
      if (v == null || v === false) continue;
      if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'class' || k === 'className') el.setAttribute('class', v);
      else if (k === 'html') el.innerHTML = v;
      else if (k.startsWith('on') && typeof v === 'function') {
        el.addEventListener(k.slice(2).toLowerCase(), v);
      } else el.setAttribute(k, v === true ? '' : v);
    }
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    // Duck-type on nodeType rather than `instanceof Node`: when building into
    // another document (the schema tab via withDocument), child elements belong
    // to that window's realm and fail the opener's `instanceof Node`, so they'd
    // be stringified to "[object HTMLDivElement]". nodeType is realm-agnostic.
    el.appendChild(isNode(c) ? c : D().createTextNode(String(c)));
  }
  return el;
}

export function h(tag, props, ...children) {
  if (typeof tag === 'function') return tag(props || {}, children);
  return apply(D().createElement(tag), props, children);
}

// Build an element in the SVG namespace (same prop rules as h()).
export function s(tag, props, ...children) {
  return apply(D().createElementNS(SVG_NS, tag), props, children);
}

// The page's CSS `zoom` factor as seen by `el`: getBoundingClientRect() is in
// post-zoom px while layout (offsetWidth) is pre-zoom CSS px, so their ratio is
// the zoom. The single source of truth for bridging `html{zoom}` when mapping
// between client coords and CSS px (editor popovers, results column-resize).
// `zoom` is a page-global html{} property, so the element measured is immaterial
// — pass any laid-out element near the work; the ratio is the same everywhere.
// Falls back to 1 for any non-positive/non-finite ratio — an unlaid-out element
// gives 0/0 → NaN, and offsetWidth 0 with a non-zero rect gives Infinity; both
// (and a degenerate 0-width) must read as "no zoom", not blow up a divisor.
export function zoomScale(el) {
  const s = el.getBoundingClientRect().width / el.offsetWidth;
  return Number.isFinite(s) && s > 0 ? s : 1;
}

// Place a fixed-position popover anchored under a button, bridging `html{zoom}`:
// getBoundingClientRect coords are post-zoom px but a fixed element's top/left/right
// are re-scaled by zoom on paint, so divide by `scale` (from zoomScale). Returns
// `{ top, left }`, or `{ top, right }` when `viewportW` is given (right-align to
// the anchor's right edge). `gap` is the px below the anchor; `min` floors the
// side inset. Pure arithmetic on a DOMRect-like — the single recipe for the File
// menu, the Save popover and the user menu.
export function fixedAnchor(rect, scale, opts = {}) {
  const gap = opts.gap != null ? opts.gap : 6;
  const min = opts.min != null ? opts.min : 8;
  const top = rect.bottom / scale + gap;
  return opts.viewportW != null
    ? { top, right: Math.max(min, (opts.viewportW - rect.right) / scale) }
    : { top, left: Math.max(min, rect.left / scale) };
}

// Wire a modal backdrop's close-on-click without the false positive from a
// gesture that starts inside the panel/card and ends over the backdrop (#110)
// — e.g. dragging a text selection past the panel's edge before releasing. A
// browser's `click` fires on the nearest common ancestor of the `mousedown`
// and `mouseup` targets, not the `mousedown` target, so that drag's `click`
// targets the backdrop directly even though the panel was never in its
// propagation path (the panel's own stopPropagation, if any, never runs).
// Track where `mousedown` actually landed instead: `close()` only fires when
// that mousedown's target was the backdrop itself, i.e. outside the panel.
// The mousedown listener is capturing on `backdrop` itself (not bubbling):
// capture visits `backdrop` on the way down to the real target, before any
// descendant's own stopPropagation can run, so an intervening stopPropagation
// inside the panel still can't hide the real mousedown target.
// Returns `detach()` — callers must invoke it from their own close().
export function attachBackdropClose(backdrop, close) {
  let downOnBackdrop = false;
  const onDown = (e) => { downOnBackdrop = e.target === backdrop; };
  const onClick = () => {
    const shouldClose = downOnBackdrop;
    downOnBackdrop = false; // consume — a later click with no mousedown must not reuse it
    if (shouldClose) close();
  };
  backdrop.addEventListener('mousedown', onDown, true);
  backdrop.addEventListener('click', onClick);
  return () => {
    backdrop.removeEventListener('mousedown', onDown, true);
    backdrop.removeEventListener('click', onClick);
  };
}
