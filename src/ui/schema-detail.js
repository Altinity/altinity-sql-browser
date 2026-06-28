// The node detail pane for the fullscreen schema graph: a resizable strip docked
// at the bottom of the overlay panel, showing a clicked object's full columns
// (with key-role flags + compression sizes), per-partition part/row/byte sums, and
// its DDL. Pure DOM over the app controller; the data is fetched by
// app.actions.openNodeDetail (ch.loadTableDetail). Opening the pane also rings the
// clicked card in the graph so it's clear which object the pane describes.

import { h, s, withDocument, zoomScale } from './dom.js';
import { Icon } from './icons.js';
import { clamp, formatRows, formatBytes, qualifyIdent } from '../core/format.js';
import { columnRoles } from '../core/schema-cards.js';

const MIN_H = 90; // smallest pane height; max is panel height - this margin
const TOP_MARGIN = 100;

/**
 * Mount (or replace) the detail pane for `node` inside the live fullscreen overlay,
 * populated from `detail` ({ columns, partitions, ddl }). Returns the pane element,
 * or null when no overlay is open. The ✕ button and Esc both close just the pane
 * and clear the card's selection ring (Esc is wired in explain-graph.js via the
 * exported clearSchemaSelection); a further Esc / backdrop click closes the view.
 */
export function openDetailPane(app, node, detail, targetDoc) {
  // `targetDoc` is the view's own document (a schema tab, or the overlay's host);
  // fall back to the main document. Both host a .graph-overlay-panel.
  const doc = targetDoc || (app && app.document) || document;
  const panel = doc.querySelector('.graph-overlay-panel');
  if (!panel) return null; // view already closed
  const prior = panel.querySelector('.schema-detail');
  if (prior) prior.remove(); // re-opening for another node replaces the pane

  return withDocument(doc, () => {
    const pane = buildDetailPane(node, detail, panel);
    markSelected(doc, node.id); // ring the clicked card so the selection is visible
    return pane;
  });
}

// Find a graph card by node id (a plain scan avoids escaping ids with dots/colons
// for an attribute selector). Only the rich full-view cards carry data-node-id.
function findCard(doc, nodeId) {
  return [...doc.querySelectorAll('.eg-card[data-node-id]')].find((g) => g.getAttribute('data-node-id') === nodeId) || null;
}

// Clear the selection highlight in `doc`: drop the marker class and its ring rect
// from the selected card (the ring is always a child of that card). Exported so the
// graph's other pane-close paths — Esc in the schema tab / in-app overlay, in
// explain-graph.js — clear it too, not only the pane's own ✕ button.
export function clearSchemaSelection(doc) {
  doc.querySelectorAll('.eg-card--selected').forEach((g) => {
    g.classList.remove('eg-card--selected');
    const ring = g.querySelector('.eg-card-ring');
    if (ring) ring.remove();
  });
}

// Mark `nodeId`'s card as selected: an accent ring drawn just outside its box (a
// "double border" alongside the card's own kind-coloured stroke) plus a class the
// CSS keys off. Replaces any prior selection. No-op when the card isn't drawn
// (e.g. the pane opened over a view without that card, or in a test harness).
function markSelected(doc, nodeId) {
  clearSchemaSelection(doc);
  const card = findCard(doc, nodeId);
  if (!card) return;
  card.classList.add('eg-card--selected');
  const rect = card.querySelector('rect');
  if (!rect) return;
  const x = parseFloat(rect.getAttribute('x')) - 3;
  const y = parseFloat(rect.getAttribute('y')) - 3;
  const width = parseFloat(rect.getAttribute('width')) + 6;
  const height = parseFloat(rect.getAttribute('height')) + 6;
  // Behind the card content so the title/columns stay legible over the ring.
  card.insertBefore(s('rect', { class: 'eg-card-ring', x, y, width, height, rx: '7' }), card.firstChild);
}

// Build + mount the pane (created in the active document via withDocument).
function buildDetailPane(node, detail, panel) {
  const doc = panel.ownerDocument;
  const cols = detail.columns || [];
  const parts = detail.partitions || [];
  const ident = qualifyIdent(node.db, node.name);

  const colsTable = h('table', { class: 'schema-detail-cols' },
    h('thead', null, h('tr', null,
      h('th', null, 'column'), h('th', null, 'type'), h('th', null, 'codec'),
      h('th', { class: 'num' }, 'compressed'), h('th', { class: 'num' }, 'uncompressed'), h('th', null, 'key'))),
    h('tbody', null, ...cols.map((c) => h('tr', null,
      h('td', null, c.name), h('td', null, c.type), h('td', null, c.codec || ''),
      h('td', { class: 'num' }, formatBytes(c.compressed)),
      h('td', { class: 'num' }, formatBytes(c.uncompressed)),
      h('td', { class: 'schema-detail-roles' }, columnRoles(c).join(' '))))));

  const partsSection = parts.length
    ? h('div', null,
      h('h4', null, 'Partitions (' + parts.length + ')'),
      h('table', { class: 'schema-detail-cols' },
        h('thead', null, h('tr', null,
          h('th', null, 'partition'), h('th', { class: 'num' }, 'parts'),
          h('th', { class: 'num' }, 'rows'), h('th', { class: 'num' }, 'bytes'))),
        h('tbody', null, ...parts.map((p) => h('tr', null,
          h('td', null, p.partition), h('td', { class: 'num' }, formatRows(p.parts)),
          h('td', { class: 'num' }, formatRows(p.rows)), h('td', { class: 'num' }, formatBytes(p.bytes)))))))
    : null;

  const handle = h('div', { class: 'schema-detail-handle', title: 'Drag to resize' });
  const pane = h('div', { class: 'schema-detail' },
    handle,
    h('button', { class: 'schema-detail-close', title: 'Close', onclick: () => { pane.remove(); clearSchemaSelection(doc); } }, Icon.close()),
    h('div', { class: 'schema-detail-body' },
      h('div', { class: 'schema-detail-head' },
        h('b', null, ident), h('span', { class: 'schema-detail-kind' }, node.kind || 'table')),
      h('h4', null, 'Columns (' + cols.length + ')'),
      colsTable,
      partsSection,
      detail.ddl ? h('h4', null, 'DDL') : null,
      detail.ddl ? h('pre', { class: 'schema-detail-ddl' }, detail.ddl) : null));
  panel.appendChild(pane);

  // Drag the handle to resize. Listeners are added on mousedown and removed on
  // mouseup, so nothing persists on the document between drags (or after close).
  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    // The panel is the fixed full-screen overlay — its box is stable for the drag,
    // so measure once here rather than reflowing on every mousemove.
    const r = panel.getBoundingClientRect();
    // Bridge html{zoom}: r/clientY are post-zoom px but flexBasis is layout px, so
    // divide the drag delta (and the panel-height bound) by the zoom factor — else
    // the pane grows --zoom× faster than the cursor and the handle drifts away.
    const scale = zoomScale(pane);
    const onMove = (ev) => { pane.style.flexBasis = clamp((r.bottom - ev.clientY) / scale, MIN_H, r.height / scale - TOP_MARGIN) + 'px'; };
    const onUp = () => { doc.removeEventListener('mousemove', onMove); doc.removeEventListener('mouseup', onUp); };
    doc.addEventListener('mousemove', onMove);
    doc.addEventListener('mouseup', onUp);
  });
  return pane;
}
