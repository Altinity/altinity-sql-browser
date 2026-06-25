// The Pipeline result view: draw the `EXPLAIN PIPELINE graph = 1` DOT output as
// an SVG boxes-and-arrows graph, plus a fullscreen pan/zoom overlay for big
// plans. All graph math (parse + layout) is pure in src/core/dot.js and the
// viewBox algebra in src/core/panzoom.js; this module only does SVG + DOM.
// Zero runtime deps — built with the `s()`/`h()` hyperscript.

import { h, s } from './dom.js';
import { Icon } from './icons.js';
import { parseDot, layoutGraph } from '../core/dot.js';
import { fitBox, zoomBox, panBox, viewBoxStr } from '../core/panzoom.js';

const ZOOM_STEP = 1.2; // per wheel notch / button press

/**
 * Build the pipeline SVG from a DOT document. Returns the `<svg>` element plus
 * the graph's intrinsic size and node count (0 → caller shows a placeholder).
 */
export function buildPipelineSvg(rawText) {
  const g = layoutGraph(parseDot(rawText || ''));
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
 * Render `r.rawText` as the inline (scrollable) pipeline graph. Falls back to a
 * placeholder when the DOT has no nodes. The SVG is sized to its intrinsic px so
 * the pane scrolls; the fullscreen overlay (openPipelineFullscreen) is where
 * pan/zoom lives.
 */
export function renderExplainGraph(r) {
  const built = buildPipelineSvg(r.rawText || '');
  if (!built.nodeCount) {
    return h('div', { class: 'placeholder' }, h('div', null, 'No pipeline graph to display.'));
  }
  built.svg.setAttribute('width', built.width);
  built.svg.setAttribute('height', built.height);
  return h('div', { class: 'explain-graph-view', tabindex: '0' }, built.svg);
}

/**
 * Open the pipeline graph in a fullscreen overlay with wheel-zoom (around the
 * cursor), drag-pan, and fit/zoom buttons. Esc / ✕ / backdrop close it.
 */
export function openPipelineFullscreen(app, rawText) {
  const doc = (app && app.document) || document;
  const built = buildPipelineSvg(rawText || '');

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
    const svg = built.svg;
    svg.setAttribute('width', '100%');
    svg.setAttribute('height', '100%');
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    const minW = built.width / 8;
    const maxW = built.width * 3;
    let vb = fitBox(built.width, built.height);
    const apply = () => svg.setAttribute('viewBox', viewBoxStr(vb));
    apply();

    // Cursor px → svg-space coords, using the live canvas rect.
    const toSvg = (clientX, clientY) => {
      const rc = canvas.getBoundingClientRect();
      return {
        x: vb.x + ((clientX - rc.left) / rc.width) * vb.w,
        y: vb.y + ((clientY - rc.top) / rc.height) * vb.h,
      };
    };
    const zoomAt = (factor, clientX, clientY) => {
      const p = toSvg(clientX, clientY);
      vb = zoomBox(vb, factor, p.x, p.y, minW, maxW);
      apply();
    };
    const centre = () => {
      const rc = canvas.getBoundingClientRect();
      return { x: rc.left + rc.width / 2, y: rc.top + rc.height / 2 };
    };

    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      zoomAt(e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP, e.clientX, e.clientY);
    });

    let drag = null;
    canvas.addEventListener('mousedown', (e) => {
      drag = { x: e.clientX, y: e.clientY };
      canvas.classList.add('grabbing');
    });
    const onMove = (e) => {
      if (!drag) return;
      const rc = canvas.getBoundingClientRect();
      const scale = vb.w / rc.width;
      vb = panBox(vb, (e.clientX - drag.x) * scale, (e.clientY - drag.y) * scale);
      drag = { x: e.clientX, y: e.clientY };
      apply();
    };
    const onUp = () => { drag = null; canvas.classList.remove('grabbing'); };
    canvas.addEventListener('mousemove', onMove);
    canvas.addEventListener('mouseup', onUp);
    canvas.addEventListener('mouseleave', onUp);

    canvas.appendChild(svg);
    bar.appendChild(h('div', { class: 'graph-overlay-zoom' },
      h('button', { class: 'res-act', title: 'Zoom out', onclick: () => { const c = centre(); zoomAt(1 / ZOOM_STEP, c.x, c.y); } }, Icon.minus()),
      h('button', { class: 'res-act', title: 'Zoom in', onclick: () => { const c = centre(); zoomAt(ZOOM_STEP, c.x, c.y); } }, Icon.plus()),
      h('button', { class: 'res-act', title: 'Fit to screen', onclick: () => { vb = fitBox(built.width, built.height); apply(); } }, 'Fit')));
  }

  bar.appendChild(h('button', { class: 'graph-overlay-close', title: 'Close (Esc)', onclick: close }, Icon.close()));
  const panel = h('div', { class: 'graph-overlay-panel', onclick: (e) => e.stopPropagation() }, bar, canvas);
  backdrop = h('div', { class: 'graph-overlay', onclick: close }, panel);
  doc.body.appendChild(backdrop);
  doc.addEventListener('keydown', onKey, true);
  return backdrop;
}
