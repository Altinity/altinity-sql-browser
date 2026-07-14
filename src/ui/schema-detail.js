// The node detail pane for the fullscreen schema graph: a resizable strip docked
// at the bottom of the overlay panel, showing a clicked object's full columns
// (with key-role flags, comments + compression), its data-skipping indexes
// (#179), per-partition part/row/byte sums, the table's own comment (next to the
// kind badge), and its DDL. Pure DOM
// over the app controller; the data is fetched by app.actions.openNodeDetail
// (ch.loadTableDetail). Opening the pane also rings the clicked card in the
// graph so it's clear which object the pane describes.

import { h, s, withDocument, zoomScale } from './dom.js';
import { Icon } from './icons.js';
import { loadingPlaceholder } from './placeholder.js';
import { clamp, formatRows, formatBytes, formatCompressionRatio, qualifyIdent, truncate } from '../core/format.js';
import { columnRoles } from '../core/schema-cards.js';
import { compactType } from '../core/type-display.js';

const MIN_H = 90; // smallest pane height; max is panel height - this margin
const TOP_MARGIN = 100;
const MAX_HEAD_COMMENT = 120; // table's own comment, next to the kind badge — the header row has ~1.5x the room MAX_COL_COMMENT does
const MAX_COL_COMMENT = 80; // per-column comment — 2x the original 40, more room to read without opening DDL
const MAX_COL_TYPE = 48; // a column's type cell (#177) — an unbounded Enum/Tuple declaration compacts; the full type stays in the cell title
const MAX_COL_CODEC = 40; // a CODEC(...) chain can get long the same way; full text stays in the cell title
// Data-skipping index cells (#179): the drawer shows EVERY index (never a capped
// subset), but each field can be long — cap the width per cell (JS truncate +
// full value in `title`, same idiom as the column cells) so a long index name,
// expression, or parameterised type can't force the drawer wider. Expression +
// Type get the most room; Name is medium.
const MAX_IDX_NAME = 28;
const MAX_IDX_EXPR = 48;
const MAX_IDX_TYPE = 48;
const detailDragStops = new WeakMap();

// A capped `<td>` — always rendered (even empty) so every row in the columns
// table keeps the same cell count. The full text always lands in `title`
// (native hover tooltip) so truncation never actually loses information.
const cappedCell = (text, max, cls) => {
  const t = (text || '').trim();
  return t ? h('td', { class: cls || null, title: t }, truncate(t, max)) : h('td');
};
const commentCell = (text) => cappedCell(text, MAX_COL_COMMENT, 'schema-detail-comment');
// A long CODEC(Delta, ZSTD(...)) chain is the same class of layout hazard (#177).
const codecCell = (text) => cappedCell(text, MAX_COL_CODEC);

// The type cell: compact display form (#177), full declared type in the native
// hover tooltip so compaction never actually loses information.
const typeCell = (type) => h('td', { title: type }, compactType(type, MAX_COL_TYPE));

// The table's own comment, next to the kind badge in the pane header — omitted
// entirely (not just empty) when there is none, so the flex row's gap doesn't
// reserve space for nothing.
const headComment = (text) => {
  const t = (text || '').trim();
  return t ? h('span', { class: 'schema-detail-comment', title: t }, truncate(t, MAX_HEAD_COMMENT)) : null;
};

/**
 * Mount (or replace) the detail pane for `node` inside the live fullscreen overlay,
 * populated from `detail` ({ columns, indexes, partitions, ddl }). Returns the pane
 * element, or null when no overlay is open. The ✕ button and Esc both close just the pane
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
  if (prior) closeDetailPane(prior); // re-opening for another node replaces the pane

  return withDocument(doc, () => {
    const pane = buildDetailPane(node, detail, panel);
    markSelected(doc, node.id); // ring the clicked card so the selection is visible
    return pane;
  });
}

// Remove a detail pane through its drag lifecycle so closing/replacing the pane
// mid-drag cannot leave a highlighted detached handle or document listeners.
export function closeDetailPane(pane) {
  detailDragStops.get(pane)?.();
  pane.remove();
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
  const ident = qualifyIdent(node.db, node.name);
  // `columns === 'loading'` is the sentinel openNodeDetail mounts before the
  // ch.loadTableDetail fetch resolves — the same shape the schema tree uses for
  // a table's lazy column load.
  const loading = detail.columns === 'loading';

  let body;
  if (loading) {
    body = loadingPlaceholder('Loading table…');
  } else {
    const cols = detail.columns || [];
    const indexes = detail.indexes || [];
    const parts = detail.partitions || [];

    const colsTable = h('table', { class: 'schema-detail-cols' },
      h('thead', null, h('tr', null,
        h('th', null, 'column'), h('th', null, 'type'), h('th', null, 'codec'), h('th', null, 'comment'),
        h('th', { class: 'num' }, 'compressed'), h('th', { class: 'num', title: '% of the uncompressed size remaining on disk' }, 'size %'), h('th', null, 'key'))),
      h('tbody', null, ...cols.map((c) => h('tr', null,
        h('td', null, c.name), typeCell(c.type), codecCell(c.codec), commentCell(c.comment),
        h('td', { class: 'num' }, formatBytes(c.compressed)),
        h('td', { class: 'num' }, formatCompressionRatio(c.compressed, c.uncompressed)),
        h('td', { class: 'schema-detail-roles' }, columnRoles(c).join(' '))))));

    // Data-skipping indexes (#179): the whole list, one single-line row each,
    // long Name/Expression/Type capped with a full-value hover title. `type_full`
    // is preferred over `type` so a parameterised index (bloom_filter(0.01),
    // tokenbf_v1(…)) stays distinguishable; it falls back to `type` when absent.
    // Omitted entirely when the table carries no skipping indexes.
    const idxSection = indexes.length
      ? h('div', null,
        h('h4', null, 'Data-skipping indexes (' + indexes.length + ')'),
        h('table', { class: 'schema-detail-cols' },
          h('thead', null, h('tr', null,
            h('th', null, 'name'), h('th', null, 'expression'), h('th', null, 'type'),
            h('th', { class: 'num' }, 'granularity'), h('th', { class: 'num' }, 'compressed'))),
          h('tbody', null, ...indexes.map((ix) => h('tr', null,
            cappedCell(ix.name, MAX_IDX_NAME),
            cappedCell(ix.expr, MAX_IDX_EXPR),
            cappedCell(ix.type_full || ix.type, MAX_IDX_TYPE),
            h('td', { class: 'num' }, ix.granularity != null ? String(ix.granularity) : ''),
            h('td', { class: 'num' }, formatBytes(ix.compressed)))))))
      : null;

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

    body = h('div', null,
      h('h4', null, 'Columns (' + cols.length + ')'),
      colsTable,
      idxSection,
      partsSection,
      detail.ddl ? h('h4', null, 'DDL') : null,
      detail.ddl ? h('pre', { class: 'schema-detail-ddl' }, detail.ddl) : null);
  }

  const handle = h('div', { class: 'schema-detail-handle', title: 'Drag to resize' });
  const pane = h('div', { class: 'schema-detail' },
    handle,
    h('button', { class: 'schema-detail-close', title: 'Close', onclick: () => { closeDetailPane(pane); clearSchemaSelection(doc); } }, Icon.close()),
    h('div', { class: 'schema-detail-body' },
      h('div', { class: 'schema-detail-head' },
        h('b', null, ident), h('span', { class: 'schema-detail-kind' }, node.kind || 'table'),
        headComment(detail.comment)),
      body));
  panel.appendChild(pane);

  // Drag the handle to resize. Mouseup or any pane-close/replacement path runs
  // the same stop function, so no highlight or document listener outlives it.
  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    handle.classList.add('dragging');
    // The panel is the fixed full-screen overlay — its box is stable for the drag,
    // so measure once here rather than reflowing on every mousemove.
    const r = panel.getBoundingClientRect();
    // Bridge html{zoom}: r/clientY are post-zoom px but flexBasis is layout px, so
    // divide the drag delta (and the panel-height bound) by the zoom factor — else
    // the pane grows --zoom× faster than the cursor and the handle drifts away.
    const scale = zoomScale(pane);
    const onMove = (ev) => { pane.style.flexBasis = clamp((r.bottom - ev.clientY) / scale, MIN_H, r.height / scale - TOP_MARGIN) + 'px'; };
    const stop = () => {
      handle.classList.remove('dragging');
      doc.removeEventListener('mousemove', onMove);
      doc.removeEventListener('mouseup', stop);
      detailDragStops.delete(pane);
    };
    detailDragStops.set(pane, stop);
    doc.addEventListener('mousemove', onMove);
    doc.addEventListener('mouseup', stop);
  });
  return pane;
}
