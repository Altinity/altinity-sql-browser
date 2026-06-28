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
export function dagreLayout(dagre, graph, opts = {}) {
  const nodes = graph.nodes || [];
  if (!nodes.length) return { nodes: [], edges: [], width: 0, height: 0 };
  const ids = new Set(nodes.map((n) => n.id));
  // Keep edges between declared processors; drop self-loops (a Resize feedback
  // would just loop onto its own box).
  const edges = (graph.edges || []).filter((e) => ids.has(e.from) && ids.has(e.to) && e.from !== e.to);

  // Schema views opt into `isolatedLast`: lay out only the connected nodes with
  // dagre and pack the edge-less "single" tables into a grid *below* the lineage,
  // so a whole-DB graph reads as "relationships first, loose tables after" rather
  // than dagre ranking the orphans across the top. Other callers (the pipeline
  // graph) keep every node in the dagre pass.
  const connected = new Set();
  for (const e of edges) { connected.add(e.from); connected.add(e.to); }
  const singles = opts.isolatedLast ? nodes.filter((n) => !connected.has(n.id)) : [];
  const ranked = opts.isolatedLast ? nodes.filter((n) => connected.has(n.id)) : nodes;

  // Honor a node's explicit size when it carries one (the rich schema cards
  // pre-compute w/h from their content via cardSize); otherwise fall back to the
  // label-based width + fixed height (pipeline + inline schema boxes).
  const sizeOf = (n) => ({ width: n.w != null ? n.w : nodeWidth(n.label), height: n.h != null ? n.h : NODE_H });
  // `kind`/`db`/`name`/`external` (node) and `label` (edge) pass through for the
  // schema graph's colouring, external-dimming + click-to-SHOW-CREATE (so the UI
  // need not re-split the id or keep a side-channel for these).
  const carry = (n) => ({ id: n.id, label: n.label, kind: n.kind, db: n.db, name: n.name, external: n.external });

  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'TB', nodesep: NODESEP, ranksep: RANKSEP, marginx: MARGIN, marginy: MARGIN });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of ranked) g.setNode(n.id, sizeOf(n));
  for (const e of edges) g.setEdge(e.from, e.to);
  if (ranked.length) dagre.layout(g);

  const outNodes = ranked.map((n) => {
    const dn = g.node(n.id);
    return { ...carry(n), x: dn.x - dn.width / 2, y: dn.y - dn.height / 2, w: dn.width, h: dn.height };
  });
  const outEdges = edges.map((e) => ({
    from: e.from, to: e.to, kind: e.kind, label: e.label,
    points: g.edge(e.from, e.to).points.map((p) => ({ x: p.x, y: p.y })),
  }));
  const gg = g.graph();
  let width = ranked.length ? gg.width : 0;
  let height = ranked.length ? gg.height : 0;

  // Grid-pack the singles beneath the connected layout: a roughly-square block of
  // uniform cells (widest/tallest single), left-aligned at the margin, sitting one
  // ranksep below the lineage (or at the top when there's no lineage at all).
  if (singles.length) {
    const cells = singles.map(sizeOf);
    const colW = Math.max(...cells.map((c) => c.width));
    const rowH = Math.max(...cells.map((c) => c.height));
    const cols = Math.max(1, Math.ceil(Math.sqrt(singles.length)));
    const top = height ? height + RANKSEP : MARGIN;
    singles.forEach((n, i) => {
      const col = i % cols, row = Math.floor(i / cols);
      outNodes.push({ ...carry(n), x: MARGIN + col * (colW + NODESEP), y: top + row * (rowH + NODESEP), w: cells[i].width, h: cells[i].height });
    });
    const usedCols = Math.min(cols, singles.length);
    const rows = Math.ceil(singles.length / cols);
    width = Math.max(width, MARGIN * 2 + usedCols * colW + (usedCols - 1) * NODESEP);
    height = top + rows * rowH + (rows - 1) * NODESEP + MARGIN;
  }
  return { nodes: outNodes, edges: outEdges, width, height };
}
