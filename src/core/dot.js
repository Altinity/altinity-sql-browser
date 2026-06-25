// Pure Graphviz-DOT parsing + layered-DAG layout for the Pipeline view
// (`EXPLAIN PIPELINE graph = 1` returns DOT). No DOM, no globals — the SVG
// drawing lives in src/ui/explain-graph.js. Kept deliberately small: a lenient
// regex parse (we only need nodes + edges) and a Sugiyama-lite left→right layout.

const DOT_KEYWORDS = new Set(['node', 'edge', 'graph', 'subgraph', 'digraph']);

// Layout constants (px). Tuned for ClickHouse pipeline graphs (short labels).
const NODE_H = 30;
const V_GAP = 16;
const H_GAP = 64;
const CHAR_W = 7;
const PAD_X = 18;
const MIN_W = 64;
const MARGIN = 12;

function unescapeDot(s) {
  // Labels may carry escaped quotes and `\n` line breaks; collapse to one line.
  return String(s).replace(/\\n/g, ' ').replace(/\\(.)/g, '$1').trim();
}

/**
 * Parse a DOT digraph into `{ nodes:[{id,label}], edges:[{from,to}] }`. Lenient:
 * scans from the first `digraph`, pulls `id [label="…"]` declarations (including
 * inside subgraph clusters) and `a -> b` edges, and ignores everything else
 * (attributes, ranks, stray format headers). Endpoints referenced only by an
 * edge get a node whose label is its id. Pure.
 */
export function parseDot(text) {
  const src = String(text || '');
  const at = src.indexOf('digraph');
  const body = at >= 0 ? src.slice(at) : src;

  const nodes = [];
  const seen = new Set();
  const add = (id, label) => {
    if (seen.has(id) || DOT_KEYWORDS.has(id)) return;
    seen.add(id);
    nodes.push({ id, label });
  };

  const nodeRe = /([A-Za-z_][\w]*)\s*\[\s*label\s*=\s*"((?:[^"\\]|\\.)*)"/g;
  let m;
  while ((m = nodeRe.exec(body))) add(m[1], unescapeDot(m[2]));

  const edges = [];
  const edgeRe = /([A-Za-z_][\w]*)\s*->\s*([A-Za-z_][\w]*)/g;
  while ((m = edgeRe.exec(body))) {
    if (DOT_KEYWORDS.has(m[1]) || DOT_KEYWORDS.has(m[2])) continue;
    edges.push({ from: m[1], to: m[2] });
    add(m[1], m[1]);
    add(m[2], m[2]);
  }
  return { nodes, edges };
}

/**
 * Lay a parsed graph out left→right by layer. Returns positioned nodes
 * (`{id,label,x,y,w,h}`), edges as 2-point polylines (`{from,to,points}`), and
 * the overall `width`/`height` for the SVG viewBox. Longest-path layering
 * (Kahn topo; cycle-safe — leftover nodes stay in layer 0), uniform column
 * widths, vertically centred columns. Pure.
 */
export function layoutGraph(graph) {
  const nodes = (graph.nodes || []).map((n) => ({ ...n }));
  if (!nodes.length) return { nodes: [], edges: [], width: 0, height: 0 };
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const edges = (graph.edges || []).filter((e) => byId.has(e.from) && byId.has(e.to));

  // Longest-path layering via Kahn topological order.
  const succ = new Map(nodes.map((n) => [n.id, []]));
  const indeg = new Map(nodes.map((n) => [n.id, 0]));
  for (const e of edges) {
    succ.get(e.from).push(e.to);
    indeg.set(e.to, indeg.get(e.to) + 1);
  }
  const layer = new Map(nodes.map((n) => [n.id, 0]));
  const queue = nodes.filter((n) => indeg.get(n.id) === 0).map((n) => n.id);
  while (queue.length) {
    const u = queue.shift();
    for (const v of succ.get(u)) {
      if (layer.get(u) + 1 > layer.get(v)) layer.set(v, layer.get(u) + 1);
      indeg.set(v, indeg.get(v) - 1);
      if (indeg.get(v) === 0) queue.push(v);
    }
  }

  // Group node ids by layer (in discovery order). Longest-path layering yields
  // contiguous layers 0..max, each non-empty, so a fixed-length array is safe.
  const maxLayer = Math.max(...nodes.map((n) => layer.get(n.id)));
  const layers = Array.from({ length: maxLayer + 1 }, () => []);
  for (const n of nodes) layers[layer.get(n.id)].push(n.id);

  // Node sizes, then uniform width per column and column x positions.
  for (const n of nodes) {
    n.w = Math.max(MIN_W, n.label.length * CHAR_W + PAD_X);
    n.h = NODE_H;
  }
  const layerX = [];
  let x = MARGIN;
  let maxColH = 0;
  for (let L = 0; L < layers.length; L++) {
    const col = layers[L];
    const colW = col.reduce((mx, id) => Math.max(mx, byId.get(id).w), MIN_W);
    for (const id of col) byId.get(id).w = colW;
    layerX[L] = x;
    x += colW + H_GAP;
    const colH = col.length * NODE_H + Math.max(0, col.length - 1) * V_GAP;
    if (colH > maxColH) maxColH = colH;
  }

  // Vertically centre each column within the tallest column.
  for (let L = 0; L < layers.length; L++) {
    const col = layers[L];
    const colH = col.length * NODE_H + Math.max(0, col.length - 1) * V_GAP;
    let y = MARGIN + (maxColH - colH) / 2;
    for (const id of col) {
      const n = byId.get(id);
      n.x = layerX[L];
      n.y = y;
      y += NODE_H + V_GAP;
    }
  }

  const laidEdges = edges.map((e) => {
    const a = byId.get(e.from);
    const b = byId.get(e.to);
    return {
      from: e.from,
      to: e.to,
      points: [
        { x: a.x + a.w, y: a.y + a.h / 2 },
        { x: b.x, y: b.y + b.h / 2 },
      ],
    };
  });

  return {
    nodes,
    edges: laidEdges,
    width: x - H_GAP + MARGIN,
    height: maxColH + MARGIN * 2,
  };
}
