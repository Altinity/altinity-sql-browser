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
import { fitBox, zoomBox, panBox, viewBoxStr } from '../core/panzoom.js';

const ZOOM_STEP = 1.2; // per wheel notch / button press

/**
 * Wire pan/zoom onto a container holding the graph `svg` (sized to fill it). The
 * viewBox starts fitted to the `dims` graph. Returns `{ fit, zoomIn, zoomOut }`
 * for external controls (the overlay buttons). Shared by the inline pane and the
 * fullscreen overlay so both behave identically.
 */
function attachPanZoom(container, svg, dims) {
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', '100%');
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  const minW = dims.width / 8;
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
  container.addEventListener('mousedown', (e) => { drag = { x: e.clientX, y: e.clientY }; container.classList.add('grabbing'); });
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
 * Build the pipeline SVG from a DOT document, laying it out with the injected
 * dagre engine. Returns the `<svg>` element plus the graph's intrinsic size and
 * node count (0 → caller shows a placeholder).
 */
export function buildPipelineSvg(rawText, dagre) {
  const g = dagreLayout(dagre, parseDot(rawText || ''));
  const svg = s('svg', { class: 'explain-graph', viewBox: `0 0 ${g.width} ${g.height}` });
  if (!g.nodes.length) return { svg, width: g.width, height: g.height, nodeCount: 0 };
  // A single reusable arrowhead marker.
  svg.appendChild(s('defs', null,
    s('marker', {
      id: 'eg-arrow', viewBox: '0 0 10 10', refX: '9', refY: '5',
      markerWidth: '7', markerHeight: '7', orient: 'auto-start-reverse',
    }, s('path', { class: 'eg-arrowhead', d: 'M0 0L10 5L0 10z' }))));
  for (const e of g.edges) {
    const d = 'M' + e.points.map((p) => p.x + ' ' + p.y).join(' L');
    svg.appendChild(s('path', { class: 'eg-edge', d, 'marker-end': 'url(#eg-arrow)' }));
  }
  for (const n of g.nodes) {
    svg.appendChild(s('rect', { class: 'eg-node', x: n.x, y: n.y, width: n.w, height: n.h, rx: '4' }));
    svg.appendChild(s('text', {
      class: 'eg-label', x: n.x + n.w / 2, y: n.y + n.h / 2,
      'text-anchor': 'middle', 'dominant-baseline': 'central',
    }, n.label));
  }
  return { svg, width: g.width, height: g.height, nodeCount: g.nodes.length };
}

/**
 * Render `r.rawText` as the inline pipeline graph: fitted to the pane, with the
 * shared drag/wheel pan-zoom. Falls back to a placeholder when the DOT has no
 * nodes. The fullscreen overlay (openPipelineFullscreen) adds zoom buttons.
 */
export function renderExplainGraph(app, r) {
  const built = buildPipelineSvg(r.rawText || '', app.Dagre);
  if (!built.nodeCount) {
    return h('div', { class: 'placeholder' }, h('div', null, 'No pipeline graph to display.'));
  }
  const view = h('div', { class: 'explain-graph-view', tabindex: '0' }, built.svg);
  attachPanZoom(view, built.svg, built);
  return view;
}

/**
 * Open the pipeline graph in a fullscreen overlay with wheel-zoom (around the
 * cursor), drag-pan, and fit/zoom buttons. Esc / ✕ / backdrop close it.
 */
export function openPipelineFullscreen(app, rawText) {
  const doc = (app && app.document) || document;
  const built = buildPipelineSvg(rawText || '', app && app.Dagre);

  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  let backdrop;
  // `close` only fires from listeners attached after `backdrop` is assigned.
  function close() {
    backdrop.remove();
    doc.removeEventListener('keydown', onKey, true);
  }

  const bar = h('div', { class: 'graph-overlay-bar' },
    h('span', { class: 'graph-overlay-title' }, 'Pipeline'));
  const canvas = h('div', { class: 'graph-overlay-canvas' });

  if (!built.nodeCount) {
    canvas.appendChild(h('div', { class: 'placeholder' }, h('div', null, 'No pipeline graph to display.')));
  } else {
    canvas.appendChild(built.svg);
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
