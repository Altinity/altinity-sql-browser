// Draggable panel splitters. `dragValue` is the pure geometry; `startDrag`
// wires window mouse events and persists the result. Both are injectable
// (window + persistence) for testing.

import { clamp } from '../core/format.js';

/**
 * Clamp a drawer width (px) to [320, 92% of the viewport width] — the
 * cell-detail / rows-viewer right-hand drawer's bounds (#101). Exported so a
 * caller can apply the same clamp when first opening the drawer, not just
 * mid-drag (the viewport may have shrunk since the width was last persisted).
 */
export function clampDrawerWidth(px, viewportWidth) {
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
export function dragValue(axis, ev, rect) {
  if (axis === 'col') return clamp(ev.clientX, 180, 420);
  if (axis === 'drawer') return clampDrawerWidth(rect.width - ev.clientX, rect.width);
  const pct = clamp(((ev.clientY - rect.top) / (rect.bottom - rect.top)) * 100,
    axis === 'sideRow' ? 25 : 15, 85);
  return pct;
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
export function startDrag(ev, axis, ctx) {
  ev.preventDefault();
  const handle = ev.currentTarget;
  const win = ctx.win || window;
  handle.classList.add('dragging');
  const onMove = (move) => {
    const value = dragValue(axis, move, ctx.rectFor(axis));
    if (axis === 'col') ctx.state.sidebarPx = value;
    else if (axis === 'sideRow') ctx.state.sideSplitPct = value;
    else if (axis === 'row') ctx.state.editorPct = value;
    else ctx.state.cellDrawerPx = value;
    ctx.apply(axis, value);
  };
  const stop = () => {
    handle.classList.remove('dragging');
    win.removeEventListener('mousemove', onMove);
    win.removeEventListener('mouseup', onUp);
  };
  const onUp = () => {
    stop();
    if (axis === 'col') ctx.save('sidebarPx', ctx.state.sidebarPx);
    else if (axis === 'sideRow') ctx.save('sideSplitPct', ctx.state.sideSplitPct);
    else if (axis === 'row') ctx.save('editorPct', ctx.state.editorPct);
    else ctx.save('cellDrawerPx', ctx.state.cellDrawerPx);
  };
  win.addEventListener('mousemove', onMove);
  win.addEventListener('mouseup', onUp);
  return stop;
}
