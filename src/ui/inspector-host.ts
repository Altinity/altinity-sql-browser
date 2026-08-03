// The shared docked right-inspector slot (#586): `app-shell.ts`'s `mainRow`
// mounts exactly ONE `inspectorHost` per shell, a layout sibling of
// `queryHost`/`dashboardHost` — replacing three independent `position: fixed`
// body-mounted overlays (the cell-detail drawer, the rows viewer, and the
// Reference documentation pane, results.ts/doc-pane.ts) that each used to
// manage their own visibility.
//
// Because there is exactly one physical host, only one of {cell, rows,
// reference} can occupy it at a time: `showInInspector` force-closes
// whatever currently occupies it before mounting new content. Occupancy is
// tracked per HOST ELEMENT (a `WeakMap<HTMLElement, …>`, not one bare module
// global) — a real app only ever mounts one shell/host, but this keeps a
// second shell instance (a second `App`/document, as several fixtures build
// side by side in tests) from cross-talking through module state, the same
// reason `doc-pane.ts`'s own pane registry is a `WeakMap<Document, …>` rather
// than a single slot. This is a deliberate, narrower primitive than #488's
// future tool registry: it knows nothing about tool identity, tabs, or
// preserving inactive-tool state across a switch — opening a new occupant
// DESTROYS whatever was there (via that occupant's own `SurfaceLifecycle`
// close()). #488 layers tool selection/persistence on top of this; #586 owes
// only the shared dock.

/** The narrow app surface this module reads — the two shell-owned nodes
 *  `app-shell.ts` mounts as `mainRow` siblings. Optional (matching
 *  `AppDom`'s own convention for every render-target field — `results.ts`'s
 *  `resultsRegion` is the same shape): a real shell always sets both
 *  synchronously at mount, before any surface can call into this module, but
 *  the type never assumes it. */
export interface InspectorHostApp {
  dom: {
    inspectorHost?: HTMLElement;
    inspectorResize?: HTMLElement;
  };
}

/** The current occupant's own close(), keyed by `inspectorHost` — the same
 *  "force-close the previous one before a new one opens" pattern
 *  `dialog-shell.ts`'s module-local `openHandle` uses for modal dialogs,
 *  scoped per host so independent shells never interfere. */
const currentClose = new WeakMap<HTMLElement, () => void>();

/** True while some content currently occupies `app`'s inspector. */
export function isInspectorOpen(app: InspectorHostApp): boolean {
  return !!app.dom.inspectorHost && currentClose.has(app.dom.inspectorHost);
}

/** Force-close whatever currently occupies `app`'s inspector. A no-op when
 *  the inspector is already folded (nothing to close) or the shell hasn't
 *  mounted a host at all. The occupant's own `SurfaceLifecycle`-backed
 *  `close()` runs, which in turn calls `releaseInspector` below to actually
 *  fold the host — this function never touches the DOM itself. */
export function closeInspector(app: InspectorHostApp): void {
  if (!app.dom.inspectorHost) return;
  currentClose.get(app.dom.inspectorHost)?.();
}

/**
 * Mount `content` into the inspector, unfolding it — force-closing any
 * current occupant first. `close` is the new occupant's own lifecycle
 * `close()`, recorded so a LATER occupant can force this one out via
 * `closeInspector`/a fresh `showInInspector` call. Returns whether it
 * actually mounted — `false` when no shell has mounted a host (never true
 * once a real app is running). A caller that registers its own "is this
 * surface open" bookkeeping (doc-pane.ts's `panes` map) MUST check this
 * before registering: recording an occupant that never actually mounted
 * would leave that bookkeeping permanently stuck reporting "open" for a
 * surface nothing ever showed.
 */
export function showInInspector(app: InspectorHostApp, content: Element, close: () => void): boolean {
  const { inspectorHost, inspectorResize } = app.dom;
  if (!inspectorHost || !inspectorResize) return false;
  closeInspector(app);
  inspectorHost.replaceChildren(content);
  inspectorHost.hidden = false;
  inspectorResize.hidden = false;
  currentClose.set(inspectorHost, close);
  return true;
}

/**
 * The occupant's own teardown (its `SurfaceLifecycle`'s `onClose`) calls this
 * exactly once to actually fold the host — clears its content and re-hides
 * both nodes, consuming no layout width (mirrors `showHost`'s `hidden`
 * pattern, app-shell.ts). Only ever reachable while the caller IS the current
 * occupant: `showInInspector` always runs `closeInspector` (which runs this,
 * via the outgoing occupant's own idempotent `close()`) BEFORE mounting the
 * new content, so a fresh occupant's `hidden = false` always lands after —
 * never clobbered by — an outgoing occupant's teardown.
 */
export function releaseInspector(app: InspectorHostApp): void {
  const { inspectorHost, inspectorResize } = app.dom;
  if (!inspectorHost) return;
  currentClose.delete(inspectorHost);
  inspectorHost.hidden = true;
  if (inspectorResize) inspectorResize.hidden = true;
  inspectorHost.replaceChildren();
}
