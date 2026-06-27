// Pure geometry + state helpers for the interactive schema graph: convert a
// pixel drag into svg-user-unit deltas, re-route an edge as a straight line
// clipped to its two node boxes, find a node's incident edges, and apply/record
// manually-moved node positions. No DOM, no globals — the DOM wiring (mousedown
// tracking, attribute writes) lives in src/ui/explain-graph.js.

/** Centre point of a node box (top-left x/y, w/h). */
export function nodeCenter(n) {
  return { x: n.x + n.w / 2, y: n.y + n.h / 2 };
}

// Where the ray from `node`'s centre toward `toward` crosses `node`'s rectangle
// border — so an edge endpoint lands on the box edge, not buried at the centre.
function clipToBox(node, toward) {
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
export function straightEdgePoints(from, to) {
  return [clipToBox(from, nodeCenter(to)), clipToBox(to, nodeCenter(from))];
}

/** Indices of the edges incident to `nodeId` (touching it as source or target). */
export function incidentEdges(edges, nodeId) {
  const out = [];
  edges.forEach((e, i) => { if (e.from === nodeId || e.to === nodeId) out.push(i); });
  return out;
}

/**
 * Convert a pixel drag delta to svg user units for the current viewBox `vb`
 * ({x,y,w,h}) shown in a container of pixel size `rect`. Mirrors the pan algebra
 * in attachPanZoom (svgΔ = pxΔ · vb.w/rect.width).
 */
export function dragDeltaToSvg(dxPx, dyPx, vb, rect) {
  return { dx: dxPx * (vb.w / (rect.width || 1)), dy: dyPx * (vb.h / (rect.height || 1)) };
}

/**
 * Overlay remembered `{id: {x,y}}` positions onto laid-out nodes in place (a
 * node with no saved position keeps its dagre coordinates). Returns the array.
 */
export function applyPositions(nodes, positions) {
  if (!positions) return nodes;
  for (const n of nodes) {
    const p = positions[n.id];
    if (p) { n.x = p.x; n.y = p.y; }
  }
  return nodes;
}

/** Remember a node's moved position (mutates + returns the per-result map). */
export function recordPosition(positions, id, x, y) {
  positions[id] = { x, y };
  return positions;
}

/**
 * A linear undo/redo history of node-move operations. Each op is
 * `{ id, from:{x,y}, to:{x,y} }`. record() pushes an op and clears the redo
 * branch (standard linear-history semantics). undo()/redo() return the op to
 * apply — the caller moves the node to op.from on undo, op.to on redo — or null
 * when the respective stack is empty. No DOM; the UI does the repositioning.
 */
export function createMoveHistory() {
  const past = [];
  const future = [];
  return {
    record(op) { past.push(op); future.length = 0; },
    undo() { if (!past.length) return null; const op = past.pop(); future.push(op); return op; },
    redo() { if (!future.length) return null; const op = future.pop(); past.push(op); return op; },
    canUndo() { return past.length > 0; },
    canRedo() { return future.length > 0; },
  };
}
