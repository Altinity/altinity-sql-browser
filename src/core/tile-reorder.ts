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
 * are captured in DOM/array order). Used by the flow-engine drag path.
 */
export function hitTestTile(rects: TileRect[], x: number, y: number): string | null {
  for (const r of rects) {
    if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return r.tileId;
  }
  return null;
}

/** A minimal viewport rectangle (the dragged tile's live floating rect). */
export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Default fraction of the dragged tile's own area that must overlap a
 *  destination slot before a move commits (owner decision, #332 redesign). */
export const OVERLAP_COMMIT_RATIO = 2 / 3;

/**
 * Resolve which tile's slot the dragged rect now occupies, for the grafana-grid
 * live-reflow drag: the first candidate (in canonical `dashboard.tiles[]`
 * order) whose captured HOME rect overlaps `dragged` by at least `ratio` of the
 * DRAGGED rect's own area. Overlap is always measured against the tiles' home
 * positions (captured once at drag-start), so a live sibling shift never feeds
 * back into the decision. Returns that candidate's tileId — which may be the
 * dragged tile's own id when it still overlaps home (the caller reads that as
 * "stay / snap back") — or null when nothing clears the threshold.
 *
 * A degenerate dragged rect (zero/negative area, e.g. happy-dom's unstubbed
 * {0,0,0,0}) returns null: never divide by zero, never spuriously commit.
 */
export function resolveOverlapInsertIndex(
  dragged: Rect, candidates: TileRect[], ratio: number = OVERLAP_COMMIT_RATIO,
): string | null {
  const draggedArea = (dragged.right - dragged.left) * (dragged.bottom - dragged.top);
  if (draggedArea <= 0) return null;
  const need = ratio * draggedArea;
  for (const c of candidates) {
    const w = Math.min(dragged.right, c.right) - Math.max(dragged.left, c.left);
    const h = Math.min(dragged.bottom, c.bottom) - Math.max(dragged.top, c.top);
    const overlap = Math.max(0, w) * Math.max(0, h);
    if (overlap >= need) return c.tileId;
  }
  return null;
}

/** The FLIP delta (First-minus-Last) that pre-positions an element at its old
 *  spot so a transition animates it to its new one. Pure arithmetic so the DOM
 *  wrapper stays thin and the numbers are directly assertable. */
export function flipDelta(before: Rect, after: Rect): { dx: number; dy: number } {
  return { dx: before.left - after.left, dy: before.top - after.top };
}
