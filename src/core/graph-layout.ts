// Pure geometry + state helpers for the interactive schema graph: convert a
// pixel drag into svg-user-unit deltas, re-route an edge as a straight line
// clipped to its two node boxes, find a node's incident edges, and apply/record
// manually-moved node positions. No DOM, no globals — the DOM wiring (mousedown
// tracking, attribute writes) lives in src/ui/explain-graph.js.

import type { ViewBox } from './panzoom.js';

/** A node's rectangle (top-left `x`/`y`, size `w`/`h`) — the geometry every
 *  laid-out node (`dot-layout.js`'s `LayoutOutputNode`) carries, which is all
 *  this module's geometry helpers need. */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A point in svg user units. */
export interface Point {
  x: number;
  y: number;
}

/** Centre point of a node box (top-left x/y, w/h). */
export function nodeCenter(n: Box): Point {
  return { x: n.x + n.w / 2, y: n.y + n.h / 2 };
}

// Where the ray from `node`'s centre toward `toward` crosses `node`'s rectangle
// border — so an edge endpoint lands on the box edge, not buried at the centre.
function clipToBox(node: Box, toward: Point): Point {
  const cx = node.x + node.w / 2;
  const cy = node.y + node.h / 2;
  const dx = toward.x - cx;
  const dy = toward.y - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy }; // coincident centres
  let s = Infinity;
  if (dx !== 0) s = Math.min(s, (node.w / 2) / Math.abs(dx));
  if (dy !== 0) s = Math.min(s, (node.h / 2) / Math.abs(dy));
  return { x: cx + dx * s, y: cy + dy * s };
}

/**
 * Two-point polyline for an edge `from → to`, each endpoint clipped to its
 * node's rectangle border. Replaces dagre's routed bend points when a node is
 * moved (decision: straighten only the incident edges).
 */
export function straightEdgePoints(from: Box, to: Box): [Point, Point] {
  return [clipToBox(from, nodeCenter(to)), clipToBox(to, nodeCenter(from))];
}

/** An edge's endpoints — the minimal shape `incidentEdges` needs (a laid-out
 *  edge, `dot-layout.js`'s `LayoutOutputEdge`, carries this plus more). */
export interface EdgeEndpoints {
  from: string;
  to: string;
}

/** Indices of the edges incident to `nodeId` (touching it as source or target). */
export function incidentEdges(edges: EdgeEndpoints[], nodeId: string): number[] {
  const out: number[] = [];
  edges.forEach((e, i) => { if (e.from === nodeId || e.to === nodeId) out.push(i); });
  return out;
}

/** The pixel-sized rectangle `dragDeltaToSvg` scales against — only
 *  `width`/`height` are read (a real `DOMRect` satisfies this too). */
export interface PixelRect {
  width: number;
  height: number;
}

/**
 * Convert a pixel drag delta to svg user units for the current viewBox `vb`
 * ({x,y,w,h}) shown in a container of pixel size `rect`. Mirrors the pan algebra
 * in attachPanZoom (svgΔ = pxΔ · vb.w/rect.width).
 */
export function dragDeltaToSvg(dxPx: number, dyPx: number, vb: ViewBox, rect: PixelRect): { dx: number; dy: number } {
  return { dx: dxPx * (vb.w / (rect.width || 1)), dy: dyPx * (vb.h / (rect.height || 1)) };
}

/** The minimal shape `applyPositions` needs from a laid-out node: an id plus
 *  the mutable `x`/`y` it overlays a saved position onto. */
export interface PositionableNode {
  id: string;
  x: number;
  y: number;
}

/** A remembered `{id: {x,y}}` position map, as `recordPosition` builds it. */
export type PositionMap = Record<string, Point>;

/**
 * Overlay remembered `{id: {x,y}}` positions onto laid-out nodes in place (a
 * node with no saved position keeps its dagre coordinates). Returns the array.
 */
export function applyPositions<T extends PositionableNode>(nodes: T[], positions: PositionMap | null | undefined): T[] {
  if (!positions) return nodes;
  for (const n of nodes) {
    const p = positions[n.id];
    if (p) { n.x = p.x; n.y = p.y; }
  }
  return nodes;
}

/** Remember a node's moved position (mutates + returns the per-result map). */
export function recordPosition(positions: PositionMap, id: string, x: number, y: number): PositionMap {
  positions[id] = { x, y };
  return positions;
}

/** One recorded node-move operation — see `createMoveHistory` below. */
export interface MoveOp {
  id: string;
  from: Point;
  to: Point;
}

/** `createMoveHistory`'s return shape — a linear undo/redo stack of `MoveOp`s. */
export interface MoveHistory {
  record(op: MoveOp): void;
  undo(): MoveOp | null;
  redo(): MoveOp | null;
  canUndo(): boolean;
  canRedo(): boolean;
}

/**
 * A linear undo/redo history of node-move operations. Each op is
 * `{ id, from:{x,y}, to:{x,y} }`. record() pushes an op and clears the redo
 * branch (standard linear-history semantics). undo()/redo() return the op to
 * apply — the caller moves the node to op.from on undo, op.to on redo — or null
 * when the respective stack is empty. No DOM; the UI does the repositioning.
 */
export function createMoveHistory(): MoveHistory {
  const past: MoveOp[] = [];
  const future: MoveOp[] = [];
  return {
    record(op) { past.push(op); future.length = 0; },
    // `!`: each preceding length check guarantees pop() finds an element.
    undo() { if (!past.length) return null; const op = past.pop()!; future.push(op); return op; },
    redo() { if (!future.length) return null; const op = future.pop()!; past.push(op); return op; },
    canUndo() { return past.length > 0; },
    canRedo() { return future.length > 0; },
  };
}
