// Pure geometry helpers for the dashboard's tile pointer-drag reorder. No
// DOM, no globals — the DOM wrapper (ui/dashboard.ts, a later slice) captures
// each tile's viewport rect once per drag and calls these over that captured
// data. happy-dom's `elementFromPoint` always returns null, so hit-testing
// during a drag MUST be pure over captured rects rather than a live DOM query.

/** px the pointer must travel from pointerdown before a modifier-drag counts
 *  as a move (below this = a click, not a drag). */
export const TILE_MOVE_THRESHOLD_PX = 4;

/** True once the pointer has moved past the move threshold from its start point. */
export function movedPastThreshold(dx: number, dy: number, threshold = TILE_MOVE_THRESHOLD_PX): boolean {
  return Math.hypot(dx, dy) >= threshold;
}

/** A captured tile rectangle in viewport coordinates. */
export interface TileRect {
  tileId: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * Resolve the tile whose captured rect contains (x,y). Returns its tileId, or
 * null when the point is inside no rect. First containing rect wins (rects
 * are captured in DOM/array order).
 */
export function hitTestTile(rects: TileRect[], x: number, y: number): string | null {
  for (const r of rects) {
    if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return r.tileId;
  }
  return null;
}
