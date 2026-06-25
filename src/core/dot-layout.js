// Lay out a parsed pipeline graph with dagre — a proven layered-graph engine
// (network-simplex ranking, crossing-minimization, Brandes–Köpf coordinate
// assignment, routed edge bend points). dagre is *injected* (the same seam
// pattern as app.Chart) so this module stays pure: no import of the library, no
// DOM, no globals. Returns the same shape the SVG drawer consumes:
//   { nodes:[{id,label,x,y,w,h}], edges:[{from,to,points}], width, height }
// with node x/y as top-left (dagre reports centres) and edge points as the
// routed polyline.

const NODE_H = 30;
const CHAR_W = 7;
const PAD_X = 18;
const MIN_W = 64;
const NODESEP = 26; // gap between processors in the same rank
const RANKSEP = 38; // gap between ranks (top→bottom)
const MARGIN = 12;

/** Box width for a node label (monospace estimate, floored at MIN_W). */
export function nodeWidth(label) {
  return Math.max(MIN_W, String(label).length * CHAR_W + PAD_X);
}

/**
 * @param dagre  the injected dagre module (`{ graphlib, layout }`)
 * @param graph  parsed `{ nodes:[{id,label}], edges:[{from,to}] }`
 */
export function dagreLayout(dagre, graph) {
  const nodes = graph.nodes || [];
  if (!nodes.length) return { nodes: [], edges: [], width: 0, height: 0 };
  const ids = new Set(nodes.map((n) => n.id));
  // Keep edges between declared processors; drop self-loops (a Resize feedback
  // would just loop onto its own box).
  const edges = (graph.edges || []).filter((e) => ids.has(e.from) && ids.has(e.to) && e.from !== e.to);

  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'TB', nodesep: NODESEP, ranksep: RANKSEP, marginx: MARGIN, marginy: MARGIN });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of nodes) g.setNode(n.id, { width: nodeWidth(n.label), height: NODE_H });
  for (const e of edges) g.setEdge(e.from, e.to);
  dagre.layout(g);

  const outNodes = nodes.map((n) => {
    const dn = g.node(n.id);
    // `kind` (node) / `label` (edge) pass through for the schema graph's colouring.
    return { id: n.id, label: n.label, kind: n.kind, x: dn.x - dn.width / 2, y: dn.y - dn.height / 2, w: dn.width, h: dn.height };
  });
  const outEdges = edges.map((e) => ({
    from: e.from, to: e.to, kind: e.kind, label: e.label,
    points: g.edge(e.from, e.to).points.map((p) => ({ x: p.x, y: p.y })),
  }));
  const gg = g.graph();
  return { nodes: outNodes, edges: outEdges, width: gg.width, height: gg.height };
}
