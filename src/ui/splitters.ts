// Draggable panel splitters. `dragValue` is the pure geometry; `startDrag`
// wires window mouse events and persists the result. Both are injectable
// (window + persistence) for testing.

import { clamp } from '../core/format.js';

// 'docPane' (#313): the persistent documentation pane's own bounded-resize
// axis — identical geometry to 'drawer' (right-edge anchored, same
// clampDrawerWidth bounds) but writes `docPanePx` instead of `cellDrawerPx`,
// so a docs-pane drag never clobbers (or reads) the cell-detail/rows-viewer
// drawer's own persisted width.
export type SplitterAxis = 'col' | 'sideRow' | 'row' | 'drawer' | 'docPane';

/** The subset of a real (or fake, in tests) pointer/mouse event `dragValue`/
 *  `startDrag` read — never the full DOM `MouseEvent`, so a plain test
 *  fixture satisfies it directly. */
export interface DragPoint {
  clientX: number;
  clientY: number;
}

/** The subset of a bounding-rect-like `dragValue` reads, by axis: 'sideRow'/
 *  'row' need `top`/`bottom`; 'drawer'/'docPane' need `width` (the viewport
 *  width); 'col' reads neither. */
export interface DragRect {
  top?: number;
  bottom?: number;
  width?: number;
}

/**
 * Clamp a drawer width (px) to [320, 92% of the viewport width] — the
 * cell-detail / rows-viewer right-hand drawer's bounds (#101). Exported so a
 * caller can apply the same clamp when first opening the drawer, not just
 * mid-drag (the viewport may have shrunk since the width was last persisted).
 */
export function clampDrawerWidth(px: number, viewportWidth: number): number {
  return clamp(px, 320, viewportWidth * 0.92);
}

/**
 * Compute the new size for a drag. `axis` is 'col' (sidebar px), 'sideRow'
 * (sidebar vertical %), 'row' (editor/results %), or 'drawer' (cell-detail /
 * rows-viewer right-hand drawer px, #101). `rect` is the bounding rect of the
 * container being split (unused for 'col'; `{ width }` — the viewport width —
 * for 'drawer'). 'drawer' is anchored to the *right* edge, so its width grows
 * as the cursor moves left: `viewportWidth - clientX`.
 */
export function dragValue(axis: SplitterAxis, ev: DragPoint, rect?: DragRect): number {
  if (axis === 'col') return clamp(ev.clientX, 180, 420);
  // `!`: every real caller (startDrag's onMove, via ctx.rectFor(axis)) supplies
  // `width` for 'drawer'/'docPane' and `top`/`bottom` for 'sideRow'/'row' —
  // the axis dispatch above is exactly the contract that guarantees the field
  // this branch reads is present.
  if (axis === 'drawer' || axis === 'docPane') return clampDrawerWidth(rect!.width! - ev.clientX, rect!.width!);
  const pct = clamp(((ev.clientY - rect!.top!) / (rect!.bottom! - rect!.top!)) * 100,
    axis === 'sideRow' ? 25 : 15, 85);
  return pct;
}

/** The mousedown event `startDrag` reads — only what it actually calls
 *  (`preventDefault()`) and reads (`currentTarget`, used as the drag handle
 *  for its `.dragging` class). */
export interface DragStartEvent {
  preventDefault(): void;
  currentTarget: Element;
}

type DragListener = (ev: DragPoint) => void;

/** The `window`-shaped seam `startDrag` reads/writes — a real `Window`
 *  satisfies this directly; tests inject a minimal fake. */
export interface DragWindow {
  addEventListener(type: string, listener: DragListener): void;
  removeEventListener(type: string, listener: DragListener): void;
}

/** The splitter-owning caller's persisted geometry (state.ts's AppState
 *  slice) — only the four fields a drag ever writes. */
export interface DragState {
  sidebarPx?: number;
  sideSplitPct?: number;
  editorPct?: number;
  cellDrawerPx?: number;
  /** The docs pane's own persisted width (#313) — a sibling of `cellDrawerPx`,
   *  never read/written by the 'drawer' axis. */
  docPanePx?: number;
}

/** `startDrag`'s injected context: the window seam, the caller's mutable
 *  geometry holder, its persistence + live-apply callbacks, and a rect
 *  resolver for the container being split. */
export interface DragCtx {
  win?: DragWindow;
  state: DragState;
  save(key: string, value: number): void;
  rectFor(axis: SplitterAxis): DragRect;
  apply(axis: SplitterAxis, value: number): void;
}

/**
 * Begin a splitter drag. Returns a `cancel()` that stops listening without
 * persisting — for a caller whose drag surface can be torn down mid-drag
 * (e.g. the cell-detail drawer closing via Escape while the mouse button is
 * still down, #101); the plain splitters (col/sideRow/row) don't need it and
 * ignore the return value.
 * @param ev      the mousedown event (currentTarget = the handle)
 * @param axis    'col' | 'sideRow' | 'row' | 'drawer'
 * @param ctx     { win, state, save, rectFor(axis), apply(axis, value) }
 */
export function startDrag(ev: DragStartEvent, axis: SplitterAxis, ctx: DragCtx): () => void {
  ev.preventDefault();
  const handle = ev.currentTarget;
  const win: DragWindow = ctx.win || window;
  handle.classList.add('dragging');
  const onMove = (move: DragPoint): void => {
    const value = dragValue(axis, move, ctx.rectFor(axis));
    if (axis === 'col') ctx.state.sidebarPx = value;
    else if (axis === 'sideRow') ctx.state.sideSplitPct = value;
    else if (axis === 'row') ctx.state.editorPct = value;
    else if (axis === 'docPane') ctx.state.docPanePx = value;
    else ctx.state.cellDrawerPx = value;
    ctx.apply(axis, value);
  };
  const stop = (): void => {
    handle.classList.remove('dragging');
    win.removeEventListener('mousemove', onMove);
    win.removeEventListener('mouseup', onUp);
  };
  const onUp = (): void => {
    stop();
    // `!`: onMove (above) just assigned this same axis's field before any
    // mouseup can fire — a drag always moves before it ends.
    if (axis === 'col') ctx.save('sidebarPx', ctx.state.sidebarPx!);
    else if (axis === 'sideRow') ctx.save('sideSplitPct', ctx.state.sideSplitPct!);
    else if (axis === 'row') ctx.save('editorPct', ctx.state.editorPct!);
    else if (axis === 'docPane') ctx.save('docPanePx', ctx.state.docPanePx!);
    else ctx.save('cellDrawerPx', ctx.state.cellDrawerPx!);
  };
  win.addEventListener('mousemove', onMove);
  win.addEventListener('mouseup', onUp);
  return stop;
}
