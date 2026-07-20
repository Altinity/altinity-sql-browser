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

/**
 * Resolve which tile's slot the dragged rect now occupies, for the grafana-grid
 * live-reflow drag: MAX-OVERLAP — the candidate (in canonical
 * `dashboard.tiles[]` order) whose captured HOME rect the dragged rect
 * overlaps by the GREATEST area wins. Overlap is always measured against the
 * tiles' home positions (captured once at drag-start), so a live sibling
 * shift never feeds back into the decision. A tie is broken by canonical
 * order (the first candidate to reach that overlap amount keeps it — strict
 * `>` required to beat it). The dragged tile's own home rect is among the
 * candidates, so a tile still mostly over its origin resolves to its own id
 * (the caller reads that as "stay / snap back"). Returns null only when the
 * dragged rect overlaps NO candidate (dropped in empty space).
 *
 * This replaces the earlier "commits once it covers ≥2/3 of the destination
 * slot's area" threshold (#332): a short tile (e.g. a 403×120 KPI) can never
 * cover 2/3 of a taller 403×296 slot's area, so under that rule it always
 * snapped back. Max-overlap has no such floor — whichever slot it overlaps
 * most, wins — so it resolves correctly regardless of the dragged tile's
 * aspect ratio.
 *
 * A degenerate candidate rect (zero/negative area, e.g. happy-dom's unstubbed
 * {0,0,0,0}) contributes an overlap of 0 and so can never win — no explicit
 * skip needed.
 */
export function resolveOverlapInsertIndex(dragged: Rect, candidates: TileRect[]): string | null {
  let bestId: string | null = null;
  let bestOverlap = 0;
  for (const c of candidates) {
    const w = Math.min(dragged.right, c.right) - Math.max(dragged.left, c.left);
    const h = Math.min(dragged.bottom, c.bottom) - Math.max(dragged.top, c.top);
    const overlap = Math.max(0, w) * Math.max(0, h);
    if (overlap > bestOverlap) { bestOverlap = overlap; bestId = c.tileId; }
  }
  return bestId;
}

/** The FLIP delta (First-minus-Last) that pre-positions an element at its old
 *  spot so a transition animates it to its new one. Pure arithmetic so the DOM
 *  wrapper stays thin and the numbers are directly assertable. */
export function flipDelta(before: Rect, after: Rect): { dx: number; dy: number } {
  return { dx: before.left - after.left, dy: before.top - after.top };
}
