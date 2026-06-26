// The Pipeline result view: draw the `EXPLAIN PIPELINE graph = 1` DOT output as
// an SVG boxes-and-arrows graph. Both the inline pane and the fullscreen overlay
// use the SAME interaction model (attachPanZoom): drag to pan (grab cursor),
// wheel to pan, ⌘/Ctrl+wheel to zoom at the cursor, double-click to fit. Graph
// math (parse + layout) is pure in src/core/dot.js + dot-layout.js (dagre seam)
// and the viewBox algebra in src/core/panzoom.js; this module only does SVG + DOM.

import { h, s } from './dom.js';
import { Icon } from './icons.js';
import { parseDot } from '../core/dot.js';
import { dagreLayout } from '../core/dot-layout.js';
import { buildCardModel, cardSize, CARD } from '../core/schema-cards.js';
import { qualifyIdent } from '../core/format.js';
import { fitBox, zoomBox, panBox, viewBoxStr } from '../core/panzoom.js';

const ZOOM_STEP = 1.2; // per wheel notch / button press

/** A centred message shown in place of a graph (no nodes / nothing to draw). */
const placeholder = (msg) => h('div', { class: 'placeholder' }, h('div', null, msg));

/**
 * Empty-state copy for a schema graph that has no relationships to draw — explains
 * WHY (so a relationless DB doesn't look like a failure) and what to try instead.
 */
function schemaEmptyMessage(graph) {
  const f = (graph && graph.focus) || {};
  if (f.kind === 'table') return f.db + '.' + f.table + ' has no lineage relationships.';
  const n = graph && graph.tableCount;
  return 'No object relationships in ' + f.db
    + (n ? ' — its ' + n + ' table' + (n === 1 ? '' : 's') + " aren't linked by a view, materialized view, dictionary, or Distributed/Buffer/Merge engine." : '.');
}

/**
 * Wire pan/zoom onto a container holding the graph `svg` (sized to fill it). The
 * viewBox starts fitted to the `dims` graph. Returns `{ fit, zoomIn, zoomOut }`
 * for external controls (the overlay buttons). Shared by the inline pane and the
 * fullscreen overlay so both behave identically.
 */
function attachPanZoom(container, svg, dims, opts = {}) {
  // When modifierPan is set, drag-to-pan requires ⌘/Ctrl held — so a plain click
  // selects a node (schema graph) instead of grabbing the canvas. The cursor then
  // stays default (see .schema-graph-view CSS) rather than the grab hand.
  const modifierPan = !!opts.modifierPan;
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', '100%');
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  // Smallest viewBox (most zoomed-in). Cap at an absolute pixel floor so a very
  // wide graph can still be zoomed to a legible node, not just to width/8.
  const minW = Math.min(dims.width / 8, 600);
  const maxW = dims.width * 3;
  let vb = fitBox(dims.width, dims.height);
  const apply = () => svg.setAttribute('viewBox', viewBoxStr(vb));
  const fit = () => { vb = fitBox(dims.width, dims.height); apply(); };
  const toSvg = (cx, cy) => {
    const r = container.getBoundingClientRect();
    return { x: vb.x + ((cx - r.left) / r.width) * vb.w, y: vb.y + ((cy - r.top) / r.height) * vb.h };
  };
  const zoomAt = (factor, cx, cy) => { const p = toSvg(cx, cy); vb = zoomBox(vb, factor, p.x, p.y, minW, maxW); apply(); };
  // Pan by pixel deltas (drag grabs the content; wheel scrolls the viewport — the
  // caller passes the appropriate sign).
  const panBy = (dxPx, dyPx) => {
    const r = container.getBoundingClientRect();
    vb = panBox(vb, dxPx * (vb.w / r.width), dyPx * (vb.h / r.height));
    apply();
  };
  const centre = () => { const r = container.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; };

  container.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) zoomAt(e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP, e.clientX, e.clientY);
    else panBy(-e.deltaX, -e.deltaY);
  });
  let drag = null;
  container.addEventListener('mousedown', (e) => {
    if (modifierPan && !(e.metaKey || e.ctrlKey)) return; // plain drag → let the click through
    drag = { x: e.clientX, y: e.clientY };
    container.classList.add('grabbing');
  });
  container.addEventListener('mousemove', (e) => {
    if (!drag) return;
    panBy(e.clientX - drag.x, e.clientY - drag.y);
    drag = { x: e.clientX, y: e.clientY };
  });
  const end = () => { drag = null; container.classList.remove('grabbing'); };
  container.addEventListener('mouseup', end);
  container.addEventListener('mouseleave', end);
  container.addEventListener('dblclick', fit);

  apply();
  return { fit, zoomIn: () => { const c = centre(); zoomAt(ZOOM_STEP, c.x, c.y); }, zoomOut: () => { const c = centre(); zoomAt(1 / ZOOM_STEP, c.x, c.y); } };
}

/**
 * Draw a laid-out graph (`{nodes,edges,width,height}` from dagreLayout) as SVG.
 * `opts.nodeClass(n)` / `opts.edgeClass(e)` pick CSS classes (kind colouring),
 * `opts.edgeLabel(e)` an optional mid-edge label, `opts.onNode(n)` a click handler.
 * Returns `{ svg, width, height, nodeCount }`. DOT-agnostic — reused by both the
 * pipeline graph (DOT) and the schema graph (system.* rows).
 */
// Build the <svg> shell + arrowhead <defs> + routed edges (with optional
// mid-edge labels). Node drawing is the caller's job — plain labelled boxes
// (renderGraphSvg) or rich cards (renderRichGraphSvg) — so the edge/marker code
// lives in one place. Empty-graph safe: returns a bare <svg> with no defs.
function graphSvgWithEdges(g, edgeClass, edgeLabel) {
  const svg = s('svg', { class: 'explain-graph', viewBox: `0 0 ${g.width} ${g.height}` });
  if (!g.nodes.length) return svg;
  svg.appendChild(s('defs', null,
    s('marker', {
      id: 'eg-arrow', viewBox: '0 0 10 10', refX: '9', refY: '5',
      markerWidth: '7', markerHeight: '7', orient: 'auto-start-reverse',
    }, s('path', { class: 'eg-arrowhead', d: 'M0 0L10 5L0 10z' }))));
  for (const e of g.edges) {
    const d = 'M' + e.points.map((p) => p.x + ' ' + p.y).join(' L');
    svg.appendChild(s('path', { class: edgeClass(e), d, 'marker-end': 'url(#eg-arrow)' }));
    const lbl = edgeLabel && edgeLabel(e);
    if (lbl) {
      const mid = e.points[Math.floor(e.points.length / 2)];
      svg.appendChild(s('text', { class: 'eg-edge-label', x: mid.x, y: mid.y - 3, 'text-anchor': 'middle' }, lbl));
    }
  }
  return svg;
}

function renderGraphSvg(g, opts = {}) {
  const nodeClass = opts.nodeClass || (() => 'eg-node');
  const svg = graphSvgWithEdges(g, opts.edgeClass || (() => 'eg-edge'), opts.edgeLabel);
  if (!g.nodes.length) return { svg, width: g.width, height: g.height, nodeCount: 0 };
  for (const n of g.nodes) {
    const rect = s('rect', { class: nodeClass(n), x: n.x, y: n.y, width: n.w, height: n.h, rx: '4' });
    const text = s('text', {
      class: 'eg-label', x: n.x + n.w / 2, y: n.y + n.h / 2,
      'text-anchor': 'middle', 'dominant-baseline': 'central',
    }, n.label);
    if (opts.onNode) {
      rect.setAttribute('cursor', 'pointer'); text.setAttribute('cursor', 'pointer');
      const fire = (e) => { e.stopPropagation(); opts.onNode(n); };
      rect.addEventListener('click', fire); text.addEventListener('click', fire);
    }
    svg.appendChild(rect); svg.appendChild(text);
  }
  return { svg, width: g.width, height: g.height, nodeCount: g.nodes.length };
}

/** Build the pipeline SVG from a DOT document (kind-agnostic boxes). */
export function buildPipelineSvg(rawText, dagre) {
  return renderGraphSvg(dagreLayout(dagre, parseDot(rawText || '')));
}

/** Build the schema-lineage SVG from a `{nodes,edges}` graph (kind-coloured). */
export function buildSchemaSvg(graph, dagre, onNode) {
  return renderGraphSvg(dagreLayout(dagre, graph || { nodes: [], edges: [] }), {
    nodeClass: (n) => 'eg-node eg-node--' + (n.kind || 'table'),
    edgeClass: (e) => 'eg-edge eg-edge--' + (e.kind || 'feeds'),
    edgeLabel: (e) => e.kind,
    onNode,
  });
}

// Draw one node as a rich card: a kind-coloured background rect with a title +
// engine/rows/bytes summary header, then a row per column (with key-role badges),
// an overflow row, and a skip-index row — all placed at the deterministic offsets
// cardSize() used to size the node, so no DOM measurement is needed. `model` is
// always supplied by renderRichGraphSvg (a header-only model for a card-less node).
function renderCardNode(n, model, nodeClass, onNode) {
  const g = s('g', { class: 'eg-card' });
  const rect = s('rect', { class: nodeClass(n), x: n.x, y: n.y, width: n.w, height: n.h, rx: '5' });
  g.appendChild(rect);
  const left = n.x + CARD.PAD_X;
  g.appendChild(s('text', { class: 'eg-card-title', x: left, y: n.y + CARD.TITLE_Y }, model.title));
  g.appendChild(s('text', { class: 'eg-card-header', x: left, y: n.y + CARD.SUMMARY_Y }, model.summary));
  const divY = n.y + CARD.HEADER_H;
  g.appendChild(s('line', { class: 'eg-card-divider', x1: n.x, y1: divY, x2: n.x + n.w, y2: divY }));
  let row = 0;
  const rowY = () => divY + row * CARD.ROW_H + CARD.ROW_BASELINE;
  for (const c of model.cols) {
    const t = s('text', { class: 'eg-col', x: left, y: rowY() },
      s('tspan', { class: 'eg-col-name' }, c.name),
      s('tspan', { class: 'eg-col-type', dx: '6' }, c.type));
    for (const role of c.roles) t.appendChild(s('tspan', { class: 'eg-badge eg-badge--' + role.toLowerCase(), dx: '6' }, role));
    g.appendChild(t);
    row++;
  }
  if (model.overflow) { g.appendChild(s('text', { class: 'eg-col eg-col-more', x: left, y: rowY() }, '+' + model.overflow + ' more')); row++; }
  if (model.skipLine) g.appendChild(s('text', { class: 'eg-skipidx', x: left, y: rowY() }, model.skipLine));
  if (onNode) {
    rect.setAttribute('cursor', 'pointer');
    g.addEventListener('click', (e) => { e.stopPropagation(); onNode(n); });
  }
  return g;
}

// Like renderGraphSvg, but draws each node as a rich card (looked up by id in
// `opts.cardById`) instead of a single labelled box, reusing the same edge/marker
// scaffold. `opts` always carries cardById/nodeClass/edgeClass/edgeLabel (onNode optional).
function renderRichGraphSvg(g, opts) {
  const svg = graphSvgWithEdges(g, opts.edgeClass, opts.edgeLabel);
  if (!g.nodes.length) return { svg, width: g.width, height: g.height, nodeCount: 0 };
  for (const n of g.nodes) svg.appendChild(renderCardNode(n, opts.cardById.get(n.id), opts.nodeClass, opts.onNode));
  return { svg, width: g.width, height: g.height, nodeCount: g.nodes.length };
}

/**
 * Build the rich schema-lineage SVG: size each node from its `.card` model (the
 * model is attached by buildCardGraph; a node without one degrades to a header-only
 * card), lay out with dagre (honoring the card w/h), then draw cards. Used by the
 * fullscreen overlay; the inline pane keeps the compact buildSchemaSvg.
 */
export function buildRichSchemaSvg(graph, dagre, onNode) {
  const g = graph || { nodes: [], edges: [] };
  const cardById = new Map();
  const sized = (g.nodes || []).map((n) => {
    const model = n.card || buildCardModel(n);
    cardById.set(n.id, model);
    const { w, h } = cardSize(model);
    return { ...n, w, h };
  });
  // `external` rides through dagreLayout (like kind/db/name), so the node class can
  // read it off the laid node — no side-channel needed.
  const laid = dagreLayout(dagre, { nodes: sized, edges: g.edges || [] });
  return renderRichGraphSvg(laid, {
    cardById,
    nodeClass: (n) => 'eg-node eg-node--' + (n.kind || 'table') + (n.external ? ' eg-node--ext' : ''),
    edgeClass: (e) => 'eg-edge eg-edge--' + (e.kind || 'feeds'),
    edgeLabel: (e) => e.kind,
    onNode,
  });
}

/**
 * Render `r.rawText` as the inline pipeline graph: fitted to the pane, with the
 * shared drag/wheel pan-zoom. Falls back to a placeholder when the DOT has no
 * nodes. The fullscreen overlay (openPipelineFullscreen) adds zoom buttons.
 */
export function renderExplainGraph(app, r) {
  const built = buildPipelineSvg(r.rawText || '', app.Dagre);
  if (!built.nodeCount) return placeholder('No pipeline graph to display.');
  const view = h('div', { class: 'explain-graph-view', tabindex: '0' }, built.svg);
  attachPanZoom(view, built.svg, built);
  return view;
}

// The schema-graph kinds + their legend labels (also drive the .eg-node--<kind>
// and .eg-edge--<kind> CSS colours).
const NODE_LEGEND = [
  ['table', 'Table'], ['view', 'View'], ['mv', 'Materialized View'],
  ['dictionary', 'Dictionary'], ['distributed', 'Distributed'], ['external', 'External'],
];
function schemaLegend() {
  return h('div', { class: 'schema-graph-legend' },
    ...NODE_LEGEND.map(([k, label]) =>
      h('span', { class: 'sg-leg' }, h('i', { class: 'sg-swatch sg-swatch--' + k }), label)));
}

/**
 * Open a graph in a fullscreen overlay (drag-pan, ⌘/Ctrl+wheel zoom, fit/zoom
 * buttons; Esc / ✕ / backdrop close). `build()` returns `{svg,width,height,nodeCount}`
 * — shared by the pipeline and schema graphs. `extra` is an optional overlay node
 * (e.g. the schema legend); `note` an optional banner shown in the bar (e.g. a
 * truncation warning).
 */
function openGraphFullscreen(app, title, build, extra, emptyMsg, note) {
  const doc = (app && app.document) || document;
  const built = build();
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  let backdrop;
  function close() { backdrop.remove(); doc.removeEventListener('keydown', onKey, true); }

  const bar = h('div', { class: 'graph-overlay-bar' }, h('span', { class: 'graph-overlay-title' }, title));
  if (note) bar.appendChild(h('span', { class: 'graph-overlay-note' }, note));
  const canvas = h('div', { class: 'graph-overlay-canvas' });
  if (!built.nodeCount) {
    canvas.appendChild(placeholder(emptyMsg || 'Nothing to display.'));
  } else {
    canvas.appendChild(built.svg);
    if (extra) canvas.appendChild(extra);
    const pz = attachPanZoom(canvas, built.svg, built);
    bar.appendChild(h('div', { class: 'graph-overlay-zoom' },
      h('button', { class: 'res-act', title: 'Zoom out', onclick: pz.zoomOut }, Icon.minus()),
      h('button', { class: 'res-act', title: 'Zoom in', onclick: pz.zoomIn }, Icon.plus()),
      h('button', { class: 'res-act', title: 'Fit to screen', onclick: pz.fit }, 'Fit')));
  }
  bar.appendChild(h('button', { class: 'graph-overlay-close', title: 'Close (Esc)', onclick: close }, Icon.close()));
  const panel = h('div', { class: 'graph-overlay-panel', onclick: (e) => e.stopPropagation() }, bar, canvas);
  backdrop = h('div', { class: 'graph-overlay', onclick: close }, panel);
  doc.body.appendChild(backdrop);
  doc.addEventListener('keydown', onKey, true);
  return backdrop;
}

/** Fullscreen pipeline graph (DOT). */
export function openPipelineFullscreen(app, rawText) {
  return openGraphFullscreen(app, 'Pipeline', () => buildPipelineSvg(rawText || '', app && app.Dagre));
}

// Clicking an object runs SHOW CREATE for it, dropping the (formatted) DDL into
// the editor — the same action as a shift-click in the schema tree. The node
// carries `db`/`name` separately (from buildSchemaGraph via dagreLayout), so each
// part is quoted independently — non-bare names (`…snappy.parquet`) stay valid SQL
// without re-splitting the id. External dictionary-source leaves have no DDL.
const schemaClick = (app) => (n) => {
  if (!n.id || n.id.startsWith('ext:')) return;
  app.actions.insertCreate(qualifyIdent(n.db, n.name));
};

// In the fullscreen graph, clicking an object opens the detail pane (full columns /
// keys / partitions / DDL) instead of inserting SHOW CREATE — the pane carries its
// own "Insert SHOW CREATE" button. External (ext:) leaves have no detail to show.
const schemaDetailClick = (app) => (n) => {
  if (!n.id || n.id.startsWith('ext:')) return;
  app.actions.openNodeDetail(n);
};

/** Fullscreen schema-lineage graph — rich cards + click-a-node detail pane. */
export function openSchemaFullscreen(app, graph) {
  const note = graph && graph.truncated
    ? 'Lineage truncated — showing ' + (((graph.nodes && graph.nodes.length) || 0)) + ' objects'
    : null;
  return openGraphFullscreen(app, 'Schema', () => buildRichSchemaSvg(graph, app && app.Dagre, schemaDetailClick(app)), schemaLegend(), schemaEmptyMessage(graph), note);
}

/**
 * Render `r.schemaGraph` as the inline schema-lineage graph (kind-coloured boxes,
 * relationship-coloured edges, legend, click-a-node to expand). Same pan/zoom as
 * the pipeline view.
 */
export function renderSchemaGraph(app, r) {
  const built = buildSchemaSvg(r.schemaGraph, app.Dagre, schemaClick(app));
  // No connected objects → explain why instead of drawing nothing / a wide strip.
  if (!built.nodeCount) return placeholder(schemaEmptyMessage(r.schemaGraph));
  const view = h('div', { class: 'explain-graph-view schema-graph-view', tabindex: '0' }, built.svg, schemaLegend());
  attachPanZoom(view, built.svg, built, { modifierPan: true });
  return view;
}
