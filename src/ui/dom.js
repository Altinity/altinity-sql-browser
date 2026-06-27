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
// Falls back to 1 when the element isn't laid out (offsetWidth 0 → NaN).
export function zoomScale(el) {
  return (el.getBoundingClientRect().width / el.offsetWidth) || 1;
}
