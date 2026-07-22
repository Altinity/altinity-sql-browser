// Minimal hyperscript helper. `h(tag, props, ...children)` builds a DOM node;
// `s(tag, ...)` is the same in the SVG namespace. Both support function
// components (h only), style objects, class/className, raw html, on* event
// listeners, boolean/null skipping, and nested/array children.

const SVG_NS = 'http://www.w3.org/2000/svg' as const;

// Ambient target document. Normally null → the global `document` (the served
// page). `withDocument(doc, fn)` redirects element creation at `doc` for the
// duration of `fn`, so the same builders can populate a second window (the
// schema graph's new browser tab) without a document parameter on every call.
let DOC: Document | null = null;
const D = (): Document => DOC || document;
// Realm-agnostic "is this a DOM node?" — `instanceof Node` is false for a node
// from another window (e.g. the schema tab), so we duck-type on nodeType.
const isNode = (c: unknown): c is Node =>
  c != null && typeof c === 'object' && typeof (c as { nodeType?: unknown }).nodeType === 'number';
export function withDocument<T>(doc: Document, fn: () => T): T {
  const prev = DOC;
  DOC = doc;
  try { return fn(); } finally { DOC = prev; }
}

/** The attribute/prop bag `h`/`s` accept — `null` (or omitted) means "no
 *  props". */
export type ElProps = Record<string, unknown> | null;

// Shared prop/children application — the only difference between h and s is
// which document factory creates the element.
function apply<T extends Element & ElementCSSInlineStyle>(el: T, props: ElProps | undefined, children: unknown[]): T {
  if (props) {
    for (const k in props) {
      const v = props[k];
      if (v == null || v === false) continue;
      if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'class' || k === 'className') el.setAttribute('class', String(v));
      else if (k === 'html') el.innerHTML = String(v);
      else if (k.startsWith('on') && typeof v === 'function') {
        el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
      } else el.setAttribute(k, v === true ? '' : String(v));
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

/** A function component: `h(Component, props, ...children)` invokes it
 *  directly as `Component(props, children)` instead of building an element. */
type FunctionComponent<T extends Node = HTMLElement> = (props: Record<string, unknown>, children: unknown[]) => T;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K, props?: ElProps, ...children: unknown[]
): HTMLElementTagNameMap[K];
export function h<T extends Node>(tag: FunctionComponent<T>, props?: ElProps, ...children: unknown[]): T;
export function h(tag: string, props?: ElProps, ...children: unknown[]): HTMLElement;
export function h(
  tag: string | FunctionComponent, props?: ElProps, ...children: unknown[]
): HTMLElement | Node {
  if (typeof tag === 'function') return tag(props || {}, children);
  return apply(D().createElement(tag), props, children);
}

// Build an element in the SVG namespace (same prop rules as h()).
export function s(tag: string, props?: ElProps, ...children: unknown[]): SVGElement {
  return apply(D().createElementNS(SVG_NS, tag), props, children);
}

/** A DOMRect-like anchor rectangle — only the edges `fixedAnchor` reads. */
export interface AnchorRect {
  bottom: number;
  left?: number;
  right?: number;
}

/** `fixedAnchor`'s options bag. */
export interface FixedAnchorOptions {
  gap?: number;
  min?: number;
  viewportW?: number;
  /** Panel width for the left-align right-edge CLAMP (#335). Only consulted
   *  alongside `viewportW`; when both are given the anchor stays left-aligned
   *  under the trigger but its left inset is lowered so `left + panelW` never
   *  crosses `viewportW - min`. `panelW` alone (no `viewportW`) is ignored. */
  panelW?: number;
}

// Place a fixed-position popover anchored under a button. Returns
// `{ top, left }`, or `{ top, right }` when `viewportW` is given WITHOUT
// `panelW` (right-align to the anchor's right edge). With BOTH `viewportW` and
// `panelW` it left-aligns but clamps the left inset so a `panelW`-wide panel
// stays inside the viewport's right edge (#335). `gap` is the px below the
// anchor; `min` floors the side inset. Pure arithmetic on a DOMRect-like — the
// single recipe for the File menu, the Save popover, the user menu, and the
// dashboard filter popovers.
export function fixedAnchor(
  rect: AnchorRect, opts: FixedAnchorOptions = {},
): { top: number; left: number } | { top: number; right: number } {
  const gap = opts.gap != null ? opts.gap : 6;
  const min = opts.min != null ? opts.min : 8;
  const top = rect.bottom + gap;
  if (opts.viewportW != null && opts.panelW == null) {
    return { top, right: Math.max(min, opts.viewportW - rect.right!) };
  }
  let left = Math.max(min, rect.left!);
  if (opts.viewportW != null && opts.panelW != null) {
    // Furthest-right inset that still fits the panel with a `min` gutter.
    const maxLeft = Math.max(min, opts.viewportW - opts.panelW - min);
    left = Math.min(left, maxLeft);
  }
  return { top, left };
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
export function attachBackdropClose(backdrop: HTMLElement, close: () => void): () => void {
  let downOnBackdrop = false;
  const onDown = (e: MouseEvent): void => { downOnBackdrop = e.target === backdrop; };
  const onClick = (): void => {
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
