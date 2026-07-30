// #577 state S2 (Preact treatment) — the ONE seam between Preact-rendered
// elements and pre-built, imperatively-owned DOM.
//
// The evaluation's own architecture constraint is "do not allow vanilla code
// and Preact to mutate the same subtree". This module is how that constraint is
// kept enforceable rather than aspirational: an element is either PREACT-OWNED
// (Preact renders its children and no one else touches them) or ADOPTED (it is
// rendered with ZERO Preact children and its children come from here). There is
// no third case, and every adopted element in the shell goes through `adopt`.
//
// Verified against Preact 10 before this arm was built (the assumption spike
// #577's plan calls for): an element Preact renders with no vnode children is
// left alone by the child diff across re-renders and only removed as a whole on
// unmount, so appending foreign nodes to it is safe. That is the property the
// whole component/island boundary rests on, so it is asserted in this module's
// own test rather than trusted.
//
// Why a ref callback and not a layout effect: the shell's public contract
// (`AppShellHandle`) hands `queryHost`/`dashboardHost`/`authHost` back to
// `ui/app.ts`'s `ensureShell`, which uses them on the very next line. Preact's
// first `render()` is synchronous and populates refs before it returns, so a
// ref is the only hook that is guaranteed to have run by then — a `useEffect`
// would not be, and a `useLayoutEffect` only is by accident of ordering.

/** The pre-built nodes an adopted element hosts. `null`/`undefined` entries are
 *  skipped so a caller can pass a conditional node without a branch of its
 *  own. */
export type AdoptableNode = Node | null | undefined;

/**
 * Build a Preact `ref` callback that appends `nodes` into the element it is
 * attached to, in order, exactly once.
 *
 * Idempotent by construction: a node already parented by this element is
 * skipped, so the ref firing again on a re-render (or a component remounting
 * around the same nodes) never reorders or duplicates anything. Nodes are NOT
 * removed when the ref is called with `null` (Preact's unmount signal) — the
 * adopted nodes outlive the element that hosted them, which is the entire point
 * of a persistent host (`ui/nav-sections.ts`'s four section hosts survive every
 * navigation mode change precisely because nothing destroys them).
 */
export function adopt(...nodes: AdoptableNode[]): (el: Element | null) => void {
  return (el) => {
    if (el === null) return;
    for (const node of nodes) {
      if (node == null) continue;
      if (node.parentNode === el) continue;
      el.appendChild(node);
    }
  };
}

/**
 * The same contract for a single node whose identity can CHANGE between
 * renders — the chevron glyph, whose SVG is a different element in the folded
 * and unfolded states.
 *
 * `adopt` cannot express this: it would append the new glyph beside the old
 * one. This replaces the element's children instead, and only when the node
 * actually differs from what is already there, so a re-render that resolves to
 * the same node is still a no-op (no detach/reattach, no lost focus).
 */
export function adoptOne(node: AdoptableNode): (el: Element | null) => void {
  return (el) => {
    if (el === null || node == null) return;
    if (el.firstChild === node && el.childNodes.length === 1) return;
    el.replaceChildren(node);
  };
}
