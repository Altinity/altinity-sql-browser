// Pure Graphviz-DOT parsing for the Pipeline view (`EXPLAIN PIPELINE graph = 1`
// returns DOT). No DOM, no globals. The graph *layout* lives in
// src/core/dot-layout.js (dagre seam); the SVG drawing in src/ui/explain-graph.js.
// Kept deliberately small: a lenient regex parse (we only need nodes + edges).

const DOT_KEYWORDS = new Set(['node', 'edge', 'graph', 'subgraph', 'digraph']);

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
  const nodeRe = /([A-Za-z_][\w]*)\s*\[\s*label\s*=\s*"((?:[^"\\]|\\.)*)"/g;
  let m;
  while ((m = nodeRe.exec(body))) {
    const id = m[1];
    if (seen.has(id) || DOT_KEYWORDS.has(id)) continue;
    seen.add(id);
    nodes.push({ id, label: unescapeDot(m[2]) });
  }

  // Scan edges with quoted labels blanked out, so a `->` (or an id) inside a
  // processor label — e.g. a lambda `x -> x + 1` — can't be mistaken for a
  // data-flow edge. Only edges between already-declared processors are kept
  // (ClickHouse always declares its nodes), which also rules out phantom nodes.
  const edges = [];
  const edgeBody = body.replace(/"(?:[^"\\]|\\.)*"/g, '""');
  const edgeRe = /([A-Za-z_][\w]*)\s*->\s*([A-Za-z_][\w]*)/g;
  while ((m = edgeRe.exec(edgeBody))) {
    if (seen.has(m[1]) && seen.has(m[2])) edges.push({ from: m[1], to: m[2] });
  }
  return { nodes, edges };
}
