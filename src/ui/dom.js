// Minimal hyperscript helper. `h(tag, props, ...children)` builds a DOM node;
// `s(tag, ...)` is the same in the SVG namespace. Both support function
// components (h only), style objects, class/className, raw html, on* event
// listeners, boolean/null skipping, and nested/array children.

const SVG_NS = 'http://www.w3.org/2000/svg';

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
    el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function h(tag, props, ...children) {
  if (typeof tag === 'function') return tag(props || {}, children);
  return apply(document.createElement(tag), props, children);
}

// Build an element in the SVG namespace (same prop rules as h()).
export function s(tag, props, ...children) {
  return apply(document.createElementNS(SVG_NS, tag), props, children);
}
