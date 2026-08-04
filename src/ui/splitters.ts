// Draggable panel splitters. `dragValue` is the pure geometry; `startDrag`
// wires window mouse events and persists the result. Both are injectable
// (window + persistence) for testing.

import { clamp } from '../core/format.js';

// 'rightInspector' (#586): the docked right-inspector's own bounded-resize
// axis — right-edge anchored, same clampDrawerWidth bounds the former
// 'drawer'/'docPane' axes each used. Those two collapsed into this ONE axis
// (writing the single `rightInspectorPx` preference) because #586 replaced
// three independent per-surface overlays (cell detail, rows viewer,
// Reference) with one shared, shell-owned dock — there is no longer a
// separate per-surface width to keep isolated.
export type SplitterAxis = 'col' | 'sideRow' | 'row' | 'rightInspector';

/** The subset of a real (or fake, in tests) pointer/mouse event `dragValue`/
 *  `startDrag` read — never the full DOM `MouseEvent`, so a plain test
 *  fixture satisfies it directly. */
export interface DragPoint {
  clientX: number;
  clientY: number;
}

/** The subset of a bounding-rect-like `dragValue` reads, by axis: 'sideRow'/
 *  'row' need `top`/`bottom`; 'rightInspector' needs `width` (the viewport
 *  width) and, for a genuinely DOCKED caller (#586 finding 2a), `reservedPx`;
 *  'col' reads neither. */
export interface DragRect {
  top?: number;
  bottom?: number;
  width?: number;
  /** 'rightInspector' only, and only for a docked caller (app-shell.ts) — the
   *  total px every OTHER `.main-row` child (the sidebar + both resize
   *  handles) currently claims, subtracted from `width` before reserving
   *  `CENTRE_MIN_PX` for the centre work surface. Omitted by a non-docked
   *  caller (drawer.ts's `attachDrawerResize`, resizing a cell-detail drawer
   *  opened in a real detached browser tab — there is no centre surface
   *  beside it to protect), which keeps `dragValue` on the plain
   *  `clampDrawerWidth` bound instead. */
  reservedPx?: number;
}

/**
 * Clamp a drawer width (px) to [320, 92% of the viewport width] — the
 * ORIGINAL, viewport-only bound (#101) predating the docked right-inspector.
 * #586 kept it for the two callers with no `.main-row` dock siblings to
 * protect: the shell's own construction-time default (app-shell.ts, corrected
 * immediately after mount — and on every unfold/resize thereafter — by its
 * `reclampInspectorWidth`) and `drawer.ts`'s `attachDrawerResize` (the one
 * surface, a cell-detail drawer opened in a real detached browser tab, that
 * IS the whole tab rather than a sibling of a centre work surface). A
 * genuinely docked caller wants `clampDockedInspectorWidth` instead (#586
 * finding 2a) — this plain viewport bound alone can claim nearly the whole
 * viewport and starve `.query-host`/`.dashboard-host` to nothing. Exported so
 * a caller can apply the same clamp when first opening a surface, not just
 * mid-drag (the viewport may have shrunk since the width was last
 * persisted) — app-shell.ts does exactly that on every unfold and viewport
 * resize (#586 finding 2b), not only at construction.
 */
export function clampDrawerWidth(px: number, viewportWidth: number): number {
  return clamp(px, 320, viewportWidth * 0.92);
}

/**
 * The smallest usable width (px) the centre work surface (`.query-host`/
 * `.dashboard-host`) is guaranteed to keep once the docked right-inspector is
 * open (#586 finding 2a) — the SAME 320px floor `clampDrawerWidth` already
 * gives the inspector itself, applied symmetrically to the other side of the
 * split: neither panel the docked layout creates may shrink below the
 * narrowest width this codebase already treats as "usable" for one.
 */
export const CENTRE_MIN_PX = 320;

/**
 * Clamp a drawer width (px) for the DOCKED right-inspector's real layout
 * position: a `flex: 0 0 auto` sibling inside `.main-row`, beside a
 * non-shrinking sidebar and two resize handles (#586) — NOT the
 * `position: fixed` overlay `clampDrawerWidth` was originally sized for.
 * `totalWidth` is the space `.main-row` has to divide between the sidebar,
 * both handles, the inspector, and the centre surface (in practice the
 * viewport width — nothing at the app-shell root narrows `.main-row` below
 * it); `reservedPx` is everything `.main-row` gives every OTHER child before
 * the inspector and the centre surface split what is left. The dock-aware
 * ceiling — `totalWidth - reservedPx - CENTRE_MIN_PX` — replaces
 * `clampDrawerWidth`'s flat `92vw` bound, which alone can claim nearly the
 * whole viewport and starve the centre surface to nothing (#586 finding 2a);
 * `Math.min` against that original 92vw bound keeps the inspector from
 * claiming more than that even on an otherwise roomy row. `clamp`'s own floor
 * (320) wins even when the computed ceiling falls below it (an extremely
 * narrow window) — that width is `styles.css`'s full-screen mobile override's
 * job (`.inspector-host` under `MOBILE_BREAKPOINT_PX`), not this function's.
 */
export function clampDockedInspectorWidth(px: number, totalWidth: number, reservedPx: number): number {
  const ceiling = Math.min(totalWidth * 0.92, totalWidth - reservedPx - CENTRE_MIN_PX);
  return clamp(px, 320, ceiling);
}

/**
 * Compute the new size for a drag. `axis` is 'col' (sidebar px), 'sideRow'
 * (sidebar vertical %), 'row' (editor/results %), or 'rightInspector' (the
 * docked right-inspector's px width, #101/#586). `rect` is the bounding rect
 * of the container being split (unused for 'col'; `{ width }` — the viewport
 * width — for 'rightInspector'). 'rightInspector' is anchored to the *right*
 * edge, so its width grows as the cursor moves left: `viewportWidth -
 * clientX`.
 */
export function dragValue(axis: SplitterAxis, ev: DragPoint, rect?: DragRect): number {
  if (axis === 'col') return clamp(ev.clientX, 180, 420);
  // `!`: every real caller (startDrag's onMove, via ctx.rectFor(axis)) supplies
  // `width` for 'rightInspector' and `top`/`bottom` for 'sideRow'/'row' — the
  // axis dispatch above is exactly the contract that guarantees the field
  // this branch reads is present.
  if (axis === 'rightInspector') {
    const raw = rect!.width! - ev.clientX;
    // A docked caller (app-shell.ts) always supplies `reservedPx` (even a
    // computed 0); a non-docked caller (drawer.ts) never does — that
    // presence/absence, not the axis itself, is what picks the dock-aware
    // ceiling over the plain viewport one (#586 finding 2a).
    return rect!.reservedPx !== undefined
      ? clampDockedInspectorWidth(raw, rect!.width!, rect!.reservedPx)
      : clampDrawerWidth(raw, rect!.width!);
  }
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
  /** The docked right-inspector's width (#586) — the single field the
   *  'rightInspector' axis reads/writes, replacing the former
   *  `cellDrawerPx`/`docPanePx` pair. */
  rightInspectorPx?: number;
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
 * (e.g. the docked right-inspector closing via Escape while the mouse button
 * is still down, #101); the plain splitters (col/sideRow/row) don't need it
 * and ignore the return value.
 * @param ev      the mousedown event (currentTarget = the handle)
 * @param axis    'col' | 'sideRow' | 'row' | 'rightInspector'
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
    else ctx.state.rightInspectorPx = value;
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
    else ctx.save('rightInspectorPx', ctx.state.rightInspectorPx!);
  };
  win.addEventListener('mousemove', onMove);
  win.addEventListener('mouseup', onUp);
  return stop;
}
