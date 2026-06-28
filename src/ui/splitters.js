// Draggable panel splitters. `dragValue` is the pure geometry; `startDrag`
// wires window mouse events and persists the result. Both are injectable
// (window + persistence) for testing.

import { clamp } from '../core/format.js';

/**
 * Compute the new size for a drag. `axis` is 'col' (sidebar px), 'sideRow'
 * (sidebar vertical %), or 'row' (editor/results %). `rect` is the bounding
 * rect of the container being split (unused for 'col'). `scale` is the page
 * `html{zoom}` factor: `clientX` is post-zoom px but the sidebar width is set in
 * layout px, so 'col' divides by it or the handle drifts from the cursor. The
 * '%'-based axes derive from a (clientY-top)/(height) ratio where zoom cancels,
 * so they ignore `scale`.
 */
export function dragValue(axis, ev, rect, scale = 1) {
  if (axis === 'col') return clamp(ev.clientX / scale, 180, 420);
  const pct = clamp(((ev.clientY - rect.top) / (rect.bottom - rect.top)) * 100,
    axis === 'sideRow' ? 25 : 15, 85);
  return pct;
}

/**
 * Begin a splitter drag.
 * @param ev      the mousedown event (currentTarget = the handle)
 * @param axis    'col' | 'sideRow' | 'row'
 * @param ctx     { win, state, save, rectFor(axis), apply(axis, value) }
 */
export function startDrag(ev, axis, ctx) {
  ev.preventDefault();
  const handle = ev.currentTarget;
  const win = ctx.win || window;
  handle.classList.add('dragging');
  // Page zoom is constant for the drag's lifetime, so measure it once here rather
  // than reflowing (getBoundingClientRect/offsetWidth) on every mousemove.
  const scale = ctx.scale ? ctx.scale(axis) : 1;
  const onMove = (move) => {
    const value = dragValue(axis, move, ctx.rectFor(axis), scale);
    if (axis === 'col') ctx.state.sidebarPx = value;
    else if (axis === 'sideRow') ctx.state.sideSplitPct = value;
    else ctx.state.editorPct = value;
    ctx.apply(axis, value);
  };
  const onUp = () => {
    handle.classList.remove('dragging');
    win.removeEventListener('mousemove', onMove);
    win.removeEventListener('mouseup', onUp);
    if (axis === 'col') ctx.save('sidebarPx', ctx.state.sidebarPx);
    else if (axis === 'sideRow') ctx.save('sideSplitPct', ctx.state.sideSplitPct);
    else ctx.save('editorPct', ctx.state.editorPct);
  };
  win.addEventListener('mousemove', onMove);
  win.addEventListener('mouseup', onUp);
}
