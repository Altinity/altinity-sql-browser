// The Pipeline result view: draw the `EXPLAIN PIPELINE graph = 1` DOT output as
// an SVG boxes-and-arrows graph. All graph math (parse + layout) is pure and
// lives in src/core/dot.js; this module only turns positioned nodes/edges into
// SVG. Zero runtime deps — built with the `s()` SVG hyperscript.

import { h, s } from './dom.js';
import { parseDot, layoutGraph } from '../core/dot.js';

/**
 * Render `r.rawText` (a Graphviz DOT document) as a scrollable SVG pipeline
 * graph. Falls back to a placeholder when the DOT has no nodes.
 */
export function renderExplainGraph(r) {
  const g = layoutGraph(parseDot(r.rawText || ''));
  if (!g.nodes.length) {
    return h('div', { class: 'placeholder' }, h('div', null, 'No pipeline graph to display.'));
  }

  const svg = s('svg', {
    class: 'explain-graph', width: g.width, height: g.height,
    viewBox: `0 0 ${g.width} ${g.height}`,
  });
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

  return h('div', { class: 'explain-graph-view', tabindex: '0' }, svg);
}
