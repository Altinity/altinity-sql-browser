// The node detail pane for the fullscreen schema graph: a resizable strip docked
// at the bottom of the overlay panel, showing a clicked object's full columns
// (with key-role flags + compression sizes), per-partition part/row/byte sums, and
// its DDL — plus an "Insert SHOW CREATE" action. Pure DOM over the app controller;
// the data is fetched by app.actions.openNodeDetail (ch.loadTableDetail).

import { h, withDocument } from './dom.js';
import { Icon } from './icons.js';
import { clamp, formatRows, formatBytes, qualifyIdent } from '../core/format.js';
import { columnRoles } from '../core/schema-cards.js';

const MIN_H = 90; // smallest pane height; max is panel height - this margin
const TOP_MARGIN = 100;

/**
 * Mount (or replace) the detail pane for `node` inside the live fullscreen overlay,
 * populated from `detail` ({ columns, partitions, ddl }). Returns the pane element,
 * or null when no overlay is open. The ✕ button closes just the pane; Esc closes
 * the whole overlay (which removes the pane with it).
 */
export function openDetailPane(app, node, detail, targetDoc) {
  // `targetDoc` is the view's own document (a schema tab, or the overlay's host);
  // fall back to the main document. Both host a .graph-overlay-panel.
  const doc = targetDoc || (app && app.document) || document;
  const panel = doc.querySelector('.graph-overlay-panel');
  if (!panel) return null; // view already closed
  const prior = panel.querySelector('.schema-detail');
  if (prior) prior.remove(); // re-opening for another node replaces the pane

  return withDocument(doc, () => buildDetailPane(app, node, detail, panel));
}

// Build + mount the pane (created in the active document via withDocument).
function buildDetailPane(app, node, detail, panel) {
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
    h('button', { class: 'schema-detail-close', title: 'Close', onclick: () => pane.remove() }, Icon.close()),
    h('div', { class: 'schema-detail-body' },
      h('div', { class: 'schema-detail-head' },
        h('b', null, ident), h('span', { class: 'schema-detail-kind' }, node.kind || 'table'),
        h('button', { class: 'res-act', onclick: () => app.actions.insertCreate(ident) }, 'Insert SHOW CREATE')),
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
    const onMove = (ev) => { pane.style.flexBasis = clamp(r.bottom - ev.clientY, MIN_H, r.height - TOP_MARGIN) + 'px'; };
    const onUp = () => { doc.removeEventListener('mousemove', onMove); doc.removeEventListener('mouseup', onUp); };
    doc.addEventListener('mousemove', onMove);
    doc.addEventListener('mouseup', onUp);
  });
  return pane;
}
