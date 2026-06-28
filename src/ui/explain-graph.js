// The Pipeline result view: draw the `EXPLAIN PIPELINE graph = 1` DOT output as
// an SVG boxes-and-arrows graph. Both the inline pane and the fullscreen overlay
// use the SAME interaction model (attachPanZoom): drag to pan (grab cursor),
// wheel to pan, ⌘/Ctrl+wheel to zoom at the cursor, double-click to fit. Graph
// math (parse + layout) is pure in src/core/dot.js + dot-layout.js (dagre seam)
// and the viewBox algebra in src/core/panzoom.js; this module only does SVG + DOM.

import { h, s, withDocument } from './dom.js';
import { Icon } from './icons.js';
import { parseDot } from '../core/dot.js';
import { dagreLayout, schemaLayout } from '../core/dot-layout.js';
import { buildCardModel, cardSize, CARD } from '../core/schema-cards.js';
import { qualifyIdent } from '../core/format.js';
import { fitBox, fitWidthBox, zoomBox, panBox, viewBoxStr } from '../core/panzoom.js';
import { straightEdgePoints, incidentEdges, dragDeltaToSvg, applyPositions, recordPosition, createMoveHistory } from '../core/graph-layout.js';
import { flashToast } from './toast.js';
import { clearSchemaSelection } from './schema-detail.js';

const ZOOM_STEP = 1.2; // per zoom-button press
const WHEEL_ZOOM_STEP = 1.04; // per ⌘/Ctrl+wheel notch — gentle, so trackpad/wheel zoom isn't jumpy

/** A centred message shown in place of a graph (no nodes / nothing to draw). */
const placeholder = (msg) => h('div', { class: 'placeholder' }, h('div', null, msg));

/**
 * Empty-state copy when there's genuinely nothing to draw. A whole-DB graph now
 * keeps its tables as standalone nodes even with no relationships, so this is only
 * reached for a focused table with no neighbours, or a database with no objects.
 */
function schemaEmptyMessage(graph) {
  const f = (graph && graph.focus) || {};
  if (f.kind === 'table') return f.db + '.' + f.table + ' has no data-flow relationships.';
  return f.db ? 'No objects in ' + f.db + '.' : 'Nothing to draw.';
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
  // fitWidth: frame the graph to fill the container's WIDTH and let the height
  // overflow (pan/scroll down) — used by the schema full view, which can be tall.
  const fitWidth = !!opts.fitWidth;
  // refitOnResize: re-fit when the window resizes. Set for the standalone schema
  // tab + the fullscreen overlays (whose container tracks the viewport); left off
  // for the small inline result pane, which re-renders often and shouldn't reset
  // a user's pan/zoom on every layout change.
  const refitOnResize = !!opts.refitOnResize;
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', '100%');
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  // Smallest viewBox (most zoomed-in). Cap at an absolute pixel floor so a very
  // wide graph can still be zoomed to a legible node, not just to width/8.
  const minW = Math.min(dims.width / 8, 600);
  const maxW = dims.width * 3;
  const computeFit = () => {
    if (fitWidth) { const r = container.getBoundingClientRect(); return fitWidthBox(dims.width, dims.height, r.width, r.height); }
    return fitBox(dims.width, dims.height);
  };
  let vb = computeFit();
  const apply = () => svg.setAttribute('viewBox', viewBoxStr(vb));
  const fit = () => { vb = computeFit(); apply(); };
  const toSvg = (cx, cy) => {
    const r = container.getBoundingClientRect();
    return { x: vb.x + ((cx - r.left) / r.width) * vb.w, y: vb.y + ((cy - r.top) / r.height) * vb.h };
  };
  const zoomAt = (factor, cx, cy) => { const p = toSvg(cx, cy); vb = zoomBox(vb, factor, p.x, p.y, minW, maxW); apply(); };
  // Pan by pixel deltas (drag grabs the content; wheel scrolls the viewport — the
  // caller passes the appropriate sign).
  const panBy = (dxPx, dyPx) => {
    const { dx, dy } = dragDeltaToSvg(dxPx, dyPx, vb, container.getBoundingClientRect());
    vb = panBox(vb, dx, dy);
    apply();
  };
  const centre = () => { const r = container.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; };

  container.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) zoomAt(e.deltaY < 0 ? WHEEL_ZOOM_STEP : 1 / WHEEL_ZOOM_STEP, e.clientX, e.clientY);
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
  // Refit on window resize so the viewBox aspect keeps matching the container —
  // otherwise preserveAspectRatio letterboxes and drag/pan stop tracking the
  // pointer (notably when the standalone schema tab is resized). The listener
  // removes itself once the container leaves the DOM (overlay/tab closed); a
  // detached document (defaultView null) never gets one in the first place.
  const win = container.ownerDocument.defaultView;
  if (win && refitOnResize) {
    const onResize = () => { if (container.isConnected) fit(); else win.removeEventListener('resize', onResize); };
    win.addEventListener('resize', onResize);
  }

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
  g.edges.forEach((e, i) => {
    const d = 'M' + e.points.map((p) => p.x + ' ' + p.y).join(' L');
    // data-eidx/from/to let the schema-graph move handler find and re-route the
    // edges incident to a dragged node (harmless attrs for the pipeline graph).
    svg.appendChild(s('path', { class: edgeClass(e), d, 'marker-end': 'url(#eg-arrow)', 'data-eidx': i, 'data-from': e.from, 'data-to': e.to }));
    const lbl = edgeLabel && edgeLabel(e);
    if (lbl) {
      // A straightened (2-point) edge has no real mid-vertex, so points[len/2]
      // would land on the target endpoint — use the segment midpoint instead.
      // data-lbl-eidx lets the move handler reposition the label with its edge.
      const pts = e.points;
      const mid = pts.length === 2
        ? { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 }
        : pts[Math.floor(pts.length / 2)];
      svg.appendChild(s('text', { class: 'eg-edge-label', x: mid.x, y: mid.y - 3, 'text-anchor': 'middle', 'data-lbl-eidx': i }, lbl));
    }
  });
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
      const fire = (e) => { e.stopPropagation(); opts.onNode(n, e); };
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
  return renderGraphSvg(schemaLayout(dagre, graph || { nodes: [], edges: [] }), {
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
  const g = s('g', { class: 'eg-card', 'data-node-id': n.id });
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
    g.addEventListener('click', (e) => { e.stopPropagation(); onNode(n, e); });
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
  const laid = schemaLayout(dagre, { nodes: sized, edges: g.edges || [] });
  // Overlay any manually-moved positions remembered for this result, then
  // straighten the edges touching a moved node so they still connect on first draw.
  const positions = g.savedPositions;
  if (positions) {
    applyPositions(laid.nodes, positions);
    const byId = new Map(laid.nodes.map((n) => [n.id, n]));
    for (const e of laid.edges) {
      if (positions[e.from] || positions[e.to]) e.points = straightEdgePoints(byId.get(e.from), byId.get(e.to));
    }
  }
  // Remember each card's drawn origin so a live drag can translate its <g> by a delta.
  for (const n of laid.nodes) { n.x0 = n.x; n.y0 = n.y; }
  const built = renderRichGraphSvg(laid, {
    cardById,
    nodeClass: (n) => 'eg-node eg-node--' + (n.kind || 'table') + (n.external ? ' eg-node--ext' : ''),
    edgeClass: (e) => 'eg-edge eg-edge--' + (e.kind || 'feeds'),
    edgeLabel: (e) => e.kind,
    onNode,
  });
  return { ...built, nodes: laid.nodes, edges: laid.edges };
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
  ['dictionary', 'Dictionary'], ['distributed', 'Distributed'],
  ['buffer', 'Buffer'], ['merge', 'Merge'], ['external', 'External'],
];
function schemaLegend() {
  return h('div', { class: 'schema-graph-legend' },
    ...NODE_LEGEND.map(([k, label]) =>
      h('span', { class: 'sg-leg' }, h('i', { class: 'sg-swatch sg-swatch--' + k }), label)));
}

/**
 * Open a pipeline graph in a fullscreen overlay (drag-pan, ⌘/Ctrl+wheel zoom,
 * fit/zoom buttons; Esc / ✕ / backdrop close). `build()` returns
 * `{svg,width,height,nodeCount}`. Reuses the same panel/zoom chrome as the schema
 * view (buildGraphPanel + zoomControls + the right-aligned actions cluster).
 */
function openGraphFullscreen(app, title, build) {
  const doc = (app && app.document) || document;
  return withDocument(doc, () => {
    const built = build();
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
    let backdrop;
    function close() { backdrop.remove(); doc.removeEventListener('keydown', onKey, true); }
    const { panel, bar, canvas } = buildGraphPanel(title);
    const actions = h('div', { class: 'graph-overlay-actions' });
    if (!built.nodeCount) {
      canvas.appendChild(placeholder('Nothing to display.'));
    } else {
      canvas.appendChild(built.svg);
      const pz = attachPanZoom(canvas, built.svg, built, { refitOnResize: true });
      actions.appendChild(zoomControls(pz));
    }
    actions.appendChild(h('button', { class: 'graph-overlay-close', title: 'Close (Esc)', onclick: close }, Icon.close()));
    bar.appendChild(actions);
    backdrop = h('div', { class: 'graph-overlay', onclick: close }, panel);
    doc.body.appendChild(backdrop);
    doc.addEventListener('keydown', onKey, true);
    return backdrop;
  });
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

// In the full schema view, clicking an object opens the detail pane (full columns
// / keys / partitions / DDL) instead of inserting SHOW CREATE, and rings the
// clicked card. External (ext:) leaves have no detail; a ⌘/Ctrl-click is reserved
// for dragging the node, so it doesn't open the pane.
// `targetDoc` is this view's own document (the tab or the overlay's host), threaded
// so a node click always opens the pane in the view it came from — even when
// several full views are open at once (no shared single-slot document).
const schemaDetailClick = (app, targetDoc) => (n, e) => {
  if (!n.id || n.id.startsWith('ext:')) return;
  if (e.metaKey || e.ctrlKey) return;
  app.actions.openNodeDetail(n, targetDoc);
};

// The shared chrome for the full schema view: a title bar + an (empty) canvas,
// inside a panel. Reused by the new browser tab and the in-app overlay fallback;
// `.graph-overlay-panel` is also the mount point the detail pane looks for.
function buildGraphPanel(title) {
  const bar = h('div', { class: 'graph-overlay-bar' }, h('span', { class: 'graph-overlay-title' }, title));
  // tabindex makes the canvas focusable so the view receives ⌘/Ctrl + key events
  // (cursor mode, undo/redo) without first clicking — vital for the new tab.
  const canvas = h('div', { class: 'graph-overlay-canvas', tabindex: '-1' });
  const panel = h('div', { class: 'graph-overlay-panel', onclick: (e) => e.stopPropagation() }, bar, canvas);
  return { panel, bar, canvas };
}

// Zoom-out / zoom-in / fit buttons wired to an attachPanZoom controller.
function zoomControls(pz) {
  return h('div', { class: 'graph-overlay-zoom' },
    h('button', { class: 'res-act', title: 'Zoom out', onclick: pz.zoomOut }, Icon.minus()),
    h('button', { class: 'res-act', title: 'Zoom in', onclick: pz.zoomIn }, Icon.plus()),
    h('button', { class: 'res-act', title: 'Fit to screen', onclick: pz.fit }, 'Fit'));
}

// Copy the theme/density data-attributes onto the child tab's <html> so its
// CSS custom properties resolve to the same colours as the main window.
function mirrorTheme(src, dst) {
  for (const attr of ['data-theme', 'data-density']) {
    const v = src.documentElement.getAttribute(attr);
    if (v != null) dst.documentElement.setAttribute(attr, v);
  }
}

// Headline title for a focus: "default" (whole-DB) or "default.events" (table).
function focusLabel(focus) {
  const f = focus || {};
  return f.table ? f.db + '.' + f.table : (f.db || '');
}

// Day/night switcher for the view's own document — mirrors the main window's
// toggle (sun while dark → click for light; moon while light → click for dark).
// `onToggle` is the app's real toggleTheme: passed only when the view IS the main
// document (overlay fallback) so app.state/the saved pref/the header button stay
// in sync; in a separate tab it's omitted and the flip is local + ephemeral. The
// icon is rebuilt inside withDocument(doc) so it's created in the view's own realm.
function themeToggle(doc, onToggle) {
  const icon = () => (doc.documentElement.getAttribute('data-theme') === 'light' ? Icon.moon() : Icon.sun());
  const btn = h('button', { class: 'res-act', title: 'Toggle theme' }, icon());
  btn.addEventListener('click', () => {
    if (onToggle) onToggle(); // overlay: app's toggle flips data-theme + state + pref + header icon
    else doc.documentElement.setAttribute('data-theme', doc.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light');
    withDocument(doc, () => btn.replaceChildren(icon()));
  });
  return btn;
}

// Truncation banner text (null when the lineage wasn't soft-capped). Only called
// from render() with a populated graph (the nodeCount > 0 branch), so graph.nodes
// is always present here.
function schemaNote(graph) {
  return graph.truncated ? 'Data flow truncated — showing ' + graph.nodes.length + ' objects' : null;
}

// ⌘/Ctrl drives a hand cursor (.modkey) and gates node dragging: a ⌘/Ctrl+drag
// on a card moves it (capture phase, pre-empting the pan handler) and straightens
// only the edges incident to it; a plain drag falls through to pan. Pure geometry
// lives in core/graph-layout.js; this only mutates the DOM + records positions.
function attachSchemaInteractions(canvas, svg, built, targetDoc, positions, onChange = () => {}) {
  const nodes = built.nodes;
  const edges = built.edges;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const cardById = new Map();
  svg.querySelectorAll('g.eg-card[data-node-id]').forEach((g) => cardById.set(g.getAttribute('data-node-id'), g));
  const pathByIdx = new Map();
  svg.querySelectorAll('path[data-eidx]').forEach((p) => pathByIdx.set(+p.getAttribute('data-eidx'), p));
  const labelByIdx = new Map();
  svg.querySelectorAll('text[data-lbl-eidx]').forEach((t) => labelByIdx.set(+t.getAttribute('data-lbl-eidx'), t));
  // Each node's incident-edge indices are fixed for the view's lifetime, so map
  // them once here rather than rescanning every edge on every drag-move frame.
  const incidentById = new Map();
  nodes.forEach((n) => incidentById.set(n.id, incidentEdges(edges, n.id)));
  const getVb = () => { const a = svg.getAttribute('viewBox').split(' ').map(Number); return { x: a[0], y: a[1], w: a[2], h: a[3] }; };
  const history = createMoveHistory();

  // Move a node to an absolute position: translate its card, re-route only its
  // incident edges (and their labels), grow the layout bounds, and update the
  // persisted map. Shared by live drag + undo/redo.
  const placeAt = (id, x, y) => {
    const node = byId.get(id);
    node.x = x; node.y = y;
    cardById.get(id).setAttribute('transform', 'translate(' + (x - node.x0) + ' ' + (y - node.y0) + ')');
    // Grow the layout bounds (same object attachPanZoom fits) so Fit/double-click
    // can still frame a node dragged past dagre's original extent.
    if (x + node.w > built.width) built.width = x + node.w;
    if (y + node.h > built.height) built.height = y + node.h;
    for (const i of incidentById.get(id)) { // every node id is mapped above
      const ed = edges[i];
      const pts = straightEdgePoints(byId.get(ed.from), byId.get(ed.to));
      pathByIdx.get(i).setAttribute('d', 'M' + pts.map((p) => p.x + ' ' + p.y).join(' L'));
      // Keep the relationship label on the re-routed edge's midpoint, not stranded.
      const lbl = labelByIdx.get(i);
      if (lbl) { lbl.setAttribute('x', (pts[0].x + pts[1].x) / 2); lbl.setAttribute('y', (pts[0].y + pts[1].y) / 2 - 3); }
    }
    if (positions) recordPosition(positions, id, x, y);
  };

  // undo()/redo() are shared by the keyboard shortcuts and the headline buttons;
  // each notifies onChange so the buttons can refresh their enabled state.
  const doUndo = () => { const op = history.undo(); if (op) placeAt(op.id, op.from.x, op.from.y); onChange(); };
  const doRedo = () => { const op = history.redo(); if (op) placeAt(op.id, op.to.x, op.to.y); onChange(); };
  const onKeyDown = (e) => {
    if (!(e.metaKey || e.ctrlKey)) return;
    canvas.classList.add('modkey');
    const k = e.key.toLowerCase();
    if (k === 'z') { e.preventDefault(); if (e.shiftKey) doRedo(); else doUndo(); } // ⌘Z undo, ⌘⇧Z redo
    else if (k === 'y') { e.preventDefault(); doRedo(); } // ⌘Y redo (Windows-style)
  };
  const onKeyUp = (e) => { if (!(e.metaKey || e.ctrlKey)) canvas.classList.remove('modkey'); };
  // If the window loses focus mid-press the modifier keyup may never arrive, which
  // would leave the grab/move cursor (.modkey) latched on — clear it on blur.
  const onBlur = () => canvas.classList.remove('modkey');
  const win = targetDoc.defaultView;
  const onDown = (e) => {
    const g = e.target.closest('[data-node-id]');
    if (!(e.metaKey || e.ctrlKey)) {
      // Plain press on a card: swallow it so the canvas doesn't pan (a clean click
      // still opens the detail pane). Plain press on empty canvas falls through to pan.
      if (g) e.stopPropagation();
      return;
    }
    if (!g) return; // ⌘/Ctrl on empty canvas → let the pan handler grab it
    const node = byId.get(g.getAttribute('data-node-id'));
    if (!node) return;
    e.preventDefault(); e.stopPropagation();
    canvas.classList.add('grabbing');
    const start = { x: node.x, y: node.y }; // for the undo record
    // The container box is stable for the drag, so read it once; the viewBox is
    // re-read each move (a ⌘/wheel zoom mid-drag changes it) so deltas stay scaled.
    const rect = canvas.getBoundingClientRect();
    let last = { x: e.clientX, y: e.clientY };
    const onMove = (ev) => {
      if (ev.buttons === 0) return onUp(); // button released off-window → end the drag
      const { dx, dy } = dragDeltaToSvg(ev.clientX - last.x, ev.clientY - last.y, getVb(), rect);
      last = { x: ev.clientX, y: ev.clientY };
      placeAt(node.id, node.x + dx, node.y + dy);
    };
    const onUp = () => {
      targetDoc.removeEventListener('mousemove', onMove);
      targetDoc.removeEventListener('mouseup', onUp);
      canvas.classList.remove('grabbing');
      // Record one undoable op per drag that actually moved the node.
      if (node.x !== start.x || node.y !== start.y) { history.record({ id: node.id, from: start, to: { x: node.x, y: node.y } }); onChange(); }
    };
    targetDoc.addEventListener('mousemove', onMove);
    targetDoc.addEventListener('mouseup', onUp);
  };
  targetDoc.addEventListener('keydown', onKeyDown);
  targetDoc.addEventListener('keyup', onKeyUp);
  canvas.addEventListener('mousedown', onDown, true);
  if (win) win.addEventListener('blur', onBlur);
  return {
    undo: doUndo,
    redo: doRedo,
    canUndo: () => history.canUndo(),
    canRedo: () => history.canRedo(),
    // Teardown: the overlay path attaches keydown/keyup/blur to the persistent main
    // document/window, so closing must remove them (the tab path drops them with its doc).
    teardown: () => {
      targetDoc.removeEventListener('keydown', onKeyDown);
      targetDoc.removeEventListener('keyup', onKeyUp);
      canvas.removeEventListener('mousedown', onDown, true);
      if (win) win.removeEventListener('blur', onBlur);
    },
  };
}

// A controller over an already-open surface (new tab or overlay). `render(graph)`
// draws the rich-card graph into `targetDoc`'s canvas (replacing the Loading…
// placeholder) and wires pan/zoom + the drag/cursor model; `fail(msg)` shows an
// error in the canvas and toasts the main window.
function makeController(app, targetDoc, mainDoc, canvas, bar, closeBtn) {
  let teardown = null;
  let destroyed = false;
  return {
    render(graph) {
      if (destroyed) return; // the view was closed before the lineage finished loading
      withDocument(targetDoc, () => {
        canvas.textContent = '';
        bar.querySelector('.graph-overlay-title').textContent = 'Schema: ' + focusLabel(graph.focus);
        // Name the browser tab "Schema:<db>" (only a real tab — never clobber the
        // main app's title when this is the in-app overlay fallback).
        if (targetDoc !== mainDoc) targetDoc.title = 'Schema:' + focusLabel(graph.focus);
        const built = buildRichSchemaSvg(graph, app.Dagre, schemaDetailClick(app, targetDoc));
        // Right-aligned action cluster: theme switcher + (zoom controls) + (close).
        // In the overlay (targetDoc === mainDoc) the toggle routes through app's own
        // toggleTheme so state/pref/header stay in sync; a real tab flips locally.
        const actions = h('div', { class: 'graph-overlay-actions' },
          themeToggle(targetDoc, targetDoc === mainDoc ? app.toggleTheme : null));
        if (!built.nodeCount) {
          canvas.appendChild(placeholder(schemaEmptyMessage(graph)));
        } else {
          canvas.classList.add('schema-canvas');
          canvas.appendChild(built.svg);
          const pz = attachPanZoom(canvas, built.svg, built, { fitWidth: true, refitOnResize: true });
          let undoBtn, redoBtn;
          const refresh = () => { undoBtn.disabled = !controls.canUndo(); redoBtn.disabled = !controls.canRedo(); };
          const controls = attachSchemaInteractions(canvas, built.svg, built, targetDoc, graph.savedPositions, refresh);
          teardown = controls.teardown;
          undoBtn = h('button', { class: 'res-act', title: 'Undo move (⌘Z)', onclick: controls.undo }, Icon.undo());
          redoBtn = h('button', { class: 'res-act', title: 'Redo move (⌘⇧Z)', onclick: controls.redo }, Icon.redo());
          refresh(); // start disabled (no history yet)
          bar.appendChild(schemaLegend()); // colour key lives in the headline, not over the canvas
          const note = schemaNote(graph);
          if (note) bar.appendChild(h('span', { class: 'graph-overlay-note' }, note));
          actions.appendChild(h('div', { class: 'graph-overlay-zoom' }, undoBtn, redoBtn));
          actions.appendChild(zoomControls(pz));
        }
        if (closeBtn) actions.appendChild(closeBtn);
        bar.appendChild(actions);
        canvas.focus({ preventScroll: true }); // focus for ⌘/Ctrl key events — but never scroll the header off
      });
    },
    fail(msg) {
      if (destroyed) return;
      withDocument(targetDoc, () => { canvas.textContent = ''; canvas.appendChild(placeholder(msg)); });
      flashToast(msg, { document: mainDoc });
    },
    destroy() { destroyed = true; if (teardown) teardown(); },
  };
}

// Drive a same-origin about:blank tab from the opener: copy the page CSS + theme,
// mount the panel, and keep the detail pane targeting the child document. The
// opener keeps the token + ch-client, so click-to-detail still fetches live.
function openInTab(app, win, childDoc, mainDoc) {
  return withDocument(childDoc, () => {
    childDoc.head.appendChild(h('style', null, app.stylesText || ''));
    mirrorTheme(mainDoc, childDoc);
    childDoc.title = 'Schema'; // render() refines this to "Schema:<db>"
    const { panel, bar, canvas } = buildGraphPanel('Schema');
    canvas.appendChild(placeholder('Loading…'));
    // No close button — the browser tab's own close serves that.
    childDoc.body.className = 'schema-tab';
    childDoc.body.appendChild(panel);
    win.focus(); // bring the new tab to the front + give it window focus for key events
    // Esc closes the open detail pane (the browser tab's own close handles the rest).
    childDoc.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      const pane = childDoc.querySelector('.schema-detail');
      if (pane) { e.stopPropagation(); pane.remove(); clearSchemaSelection(childDoc); }
    }, true);
    return makeController(app, childDoc, mainDoc, canvas, bar, null);
  });
}

// In-app modal overlay — the fallback when a real tab can't be opened (pop-up
// blocked, window.open null, or COOP severing the opener). Esc / ✕ / backdrop close.
function openInOverlay(app, mainDoc) {
  return withDocument(mainDoc, () => {
    let ctrl;
    // Esc closes the open detail pane first; a second Esc closes the whole overlay.
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      const pane = mainDoc.querySelector('.schema-detail');
      if (pane) { pane.remove(); clearSchemaSelection(mainDoc); } else close();
    };
    let backdrop;
    // close() also tears down the interaction listeners attached to the main
    // document (they would otherwise leak — the overlay's host doc outlives it).
    function close() { backdrop.remove(); mainDoc.removeEventListener('keydown', onKey, true); ctrl.destroy(); }
    const { panel, bar, canvas } = buildGraphPanel('Schema');
    canvas.appendChild(placeholder('Loading…'));
    const closeBtn = h('button', { class: 'graph-overlay-close', title: 'Close (Esc)', onclick: close }, Icon.close());
    backdrop = h('div', { class: 'graph-overlay', onclick: close }, panel);
    mainDoc.body.appendChild(backdrop);
    mainDoc.addEventListener('keydown', onKey, true);
    ctrl = makeController(app, mainDoc, mainDoc, canvas, bar, closeBtn);
    return ctrl;
  });
}

/**
 * Open the full schema-lineage view and return a `{ render, fail }` controller.
 * Tries a real browser tab first (kept live by the opener); on any failure —
 * pop-up blocked, null window, or COOP-severed document — falls back to the
 * in-app overlay. The window is opened synchronously so it survives the click
 * gesture; the caller fetches lineage, then calls render()/fail().
 */
export function openSchemaView(app) {
  const mainDoc = app.document || document;
  try {
    const win = app.openWindow('', '_blank');
    if (win && win.document) return openInTab(app, win, win.document, mainDoc);
  } catch (e) { /* pop-up blocked or cross-origin document — fall back to overlay */ }
  return openInOverlay(app, mainDoc);
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
