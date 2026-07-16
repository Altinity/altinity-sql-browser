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

// dagre (@dagrejs/dagre) is injected — the same seam pattern as app.Chart, and
// the app.Dagre seam itself is typed `unknown` (env.types.ts) since it's opaque
// at that boundary. `DagreGraphInstance` describes exactly the calls THIS
// module makes on a dagre graph object — the same "typed wrapper over an
// untyped injected dependency" convention param-scan.ts uses for the
// unconverted sql-spans.js. It names the actual RUNTIME shape (verified live
// by this module's own tests against the real library), including the x/y
// `layout()` adds by mutating each node's label in place — a mutation dagre's
// own generic `Graph<GraphLabel,NodeLabel,EdgeLabel>` class can't express (its
// declared type parameters would have to vary per-call to describe it, which
// makes the real class structurally uncheckable against any one fixed
// interface). So `DagreModule` only requires a graph CONSTRUCTABLE and
// LAYOUT-ABLE as `unknown`, and the one cast below — right after
// construction — asserts the richer, test-verified `DagreGraphInstance` shape
// for everything this module actually reads off it.
interface DagreNodeInfo { x: number; y: number; width: number; height: number; }
interface DagreEdgeInfo { points: { x: number; y: number }[]; }
interface DagreGraphInstance {
  setGraph(opts: { rankdir: string; nodesep: number; ranksep: number; marginx: number; marginy: number }): void;
  setDefaultEdgeLabel(fn: () => Record<string, never>): void;
  setNode(id: string, size: { width: number; height: number }): void;
  setEdge(from: string, to: string): void;
  node(id: string): DagreNodeInfo;
  edge(from: string, to: string): DagreEdgeInfo;
  graph(): { width: number; height: number };
}
interface DagreModule {
  graphlib: { Graph: new () => unknown };
  layout(g: unknown): void;
}

/**
 * One input node to `dagreLayout`/`schemaLayout`: a bare pipeline processor
 * (`{id,label}`, from `dot.js`'s `parseDot`) or a richer schema-graph node
 * carrying the extra fields the schema view colours/labels by (`kind`/`db`/
 * `name`/`external`/`comment`) and/or a pre-computed card size (`w`/`h`, from
 * `schema-cards.js`'s `cardSize`).
 */
export interface LayoutInputNode {
  id: string;
  label: string;
  kind?: string;
  db?: string;
  name?: string;
  external?: boolean;
  comment?: string;
  w?: number;
  h?: number;
}

/** One input edge — a bare data-flow edge, or a schema-lineage edge carrying
 *  a `kind`/`label` for the SVG drawer. */
export interface LayoutInputEdge {
  from: string;
  to: string;
  kind?: string;
  label?: string;
}

/** The graph `dagreLayout`/`schemaLayout` accept — the same shape `dot.js`'s
 *  `parseDot` returns, generalized with the optional schema-graph fields
 *  above. */
export interface LayoutInputGraph {
  nodes?: LayoutInputNode[];
  edges?: LayoutInputEdge[];
}

/** A laid-out node: the carried input fields plus its box (`x`/`y` top-left,
 *  `w`/`h`). */
export interface LayoutOutputNode {
  id: string;
  label: string;
  kind?: string;
  db?: string;
  name?: string;
  external?: boolean;
  comment?: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A laid-out edge: its endpoints, carried `kind`/`label`, and the routed
 *  polyline (dagre's bend points, or a straightened override — see
 *  `graph-layout.js`). */
export interface LayoutOutputEdge {
  from: string;
  to: string;
  kind?: string;
  label?: string;
  points: { x: number; y: number }[];
}

/** `dagreLayout`/`schemaLayout`'s return shape — what the SVG drawer
 *  (`src/ui/explain-graph.js`) consumes. */
export interface LayoutResult {
  nodes: LayoutOutputNode[];
  edges: LayoutOutputEdge[];
  width: number;
  height: number;
}

/** Box width for a node label (monospace estimate, floored at MIN_W). */
export function nodeWidth(label: unknown): number {
  return Math.max(MIN_W, String(label).length * CHAR_W + PAD_X);
}

// Box size for a node: honor an explicit w/h when it carries one (the rich schema
// cards pre-compute w/h from their content via cardSize); otherwise fall back to
// the label-based width + fixed height (pipeline + inline schema boxes).
const sizeOf = (n: LayoutInputNode): { width: number; height: number } =>
  ({ width: n.w != null ? n.w : nodeWidth(n.label), height: n.h != null ? n.h : NODE_H });
// `kind`/`db`/`name`/`external`/`comment` (node) and `label` (edge) pass through
// for the schema graph's colouring, external-dimming, click-to-SHOW-CREATE, and
// hover-tooltip comment (so the UI need not re-split the id or keep a
// side-channel for these).
const carry = (n: LayoutInputNode) => ({ id: n.id, label: n.label, kind: n.kind, db: n.db, name: n.name, external: n.external, comment: n.comment });

/**
 * Lay out a graph with dagre. Generic (pipeline + schema lineage): every node is
 * ranked top→bottom and edges routed. Returns `{ nodes, edges, width, height }`
 * with node x/y as top-left.
 * @param dagre  the injected dagre module (`{ graphlib, layout }`)
 * @param graph  parsed `{ nodes:[{id,label}], edges:[{from,to}] }`
 */
export function dagreLayout(dagre: DagreModule, graph: LayoutInputGraph): LayoutResult {
  const nodes = graph.nodes || [];
  if (!nodes.length) return { nodes: [], edges: [], width: 0, height: 0 };
  const ids = new Set(nodes.map((n) => n.id));
  // Keep edges between declared processors; drop self-loops (a Resize feedback
  // would just loop onto its own box).
  const edges = (graph.edges || []).filter((e) => ids.has(e.from) && ids.has(e.to) && e.from !== e.to);

  // `as`: see the DagreModule/DagreGraphInstance comment above.
  const g = new dagre.graphlib.Graph() as DagreGraphInstance;
  g.setGraph({ rankdir: 'TB', nodesep: NODESEP, ranksep: RANKSEP, marginx: MARGIN, marginy: MARGIN });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of nodes) g.setNode(n.id, sizeOf(n));
  for (const e of edges) g.setEdge(e.from, e.to);
  dagre.layout(g);

  const outNodes: LayoutOutputNode[] = nodes.map((n) => {
    const dn = g.node(n.id);
    return { ...carry(n), x: dn.x - dn.width / 2, y: dn.y - dn.height / 2, w: dn.width, h: dn.height };
  });
  const outEdges: LayoutOutputEdge[] = edges.map((e) => ({
    from: e.from, to: e.to, kind: e.kind, label: e.label,
    points: g.edge(e.from, e.to).points.map((p) => ({ x: p.x, y: p.y })),
  }));
  const gg = g.graph();
  return { nodes: outNodes, edges: outEdges, width: gg.width, height: gg.height };
}

/**
 * Schema-graph layout: dagre the connected lineage, then grid-pack the edge-less
 * "single" tables *below* it — so a whole-DB graph reads as "relationships first,
 * loose tables after" rather than dagre ranking the orphans across the top. The
 * grid is a roughly-square block of uniform cells (widest/tallest single),
 * left-aligned at the margin, one ranksep below the lineage (or at the top when
 * there is no lineage at all). Same `{ nodes, edges, width, height }` shape.
 */
export function schemaLayout(dagre: DagreModule, graph: LayoutInputGraph): LayoutResult {
  const nodes = graph.nodes || [];
  if (!nodes.length) return { nodes: [], edges: [], width: 0, height: 0 };
  const ids = new Set(nodes.map((n) => n.id));
  const edges = (graph.edges || []).filter((e) => ids.has(e.from) && ids.has(e.to) && e.from !== e.to);
  const connected = new Set<string>();
  for (const e of edges) { connected.add(e.from); connected.add(e.to); }
  const singles = nodes.filter((n) => !connected.has(n.id));
  if (!singles.length) return dagreLayout(dagre, graph); // no orphans → plain dagre

  // Lay the lineage out with dagre (connected nodes only, so the orphans don't
  // reserve a rank-0 row across the top), then append the grid beneath it.
  const base = dagreLayout(dagre, { nodes: nodes.filter((n) => connected.has(n.id)), edges });
  const cells = singles.map(sizeOf);
  const colW = Math.max(...cells.map((c) => c.width));
  const rowH = Math.max(...cells.map((c) => c.height));
  const cols = Math.max(1, Math.ceil(Math.sqrt(singles.length)));
  const top = base.height ? base.height + RANKSEP : MARGIN;
  const gridded: LayoutOutputNode[] = singles.map((n, i) => ({
    ...carry(n),
    x: MARGIN + (i % cols) * (colW + NODESEP),
    y: top + Math.floor(i / cols) * (rowH + NODESEP),
    w: cells[i].width, h: cells[i].height,
  }));
  const rows = Math.ceil(singles.length / cols);
  return {
    nodes: [...base.nodes, ...gridded],
    edges: base.edges,
    width: Math.max(base.width, MARGIN * 2 + cols * colW + (cols - 1) * NODESEP),
    height: top + rows * rowH + (rows - 1) * NODESEP + MARGIN,
  };
}
