// The schema tree: databases → tables → columns, with a text filter and
// lazy per-table column loading. Renders into app.dom.schemaList.

import { h } from './dom.js';
import { Icon } from './icons.js';
import { formatRows } from '../core/format.js';
import { IDENT_MIME, SCHEMA_GRAPH_MIME } from './editor.js';

// Make a tree row a drag source carrying `text` as the schema identifier, so it
// can be dropped onto the editor (see editor.js drop handler). Click behavior is
// unaffected — drag is a separate gesture.
const dragProps = (text) => ({
  draggable: 'true',
  ondragstart: (e) => e.dataTransfer.setData(IDENT_MIME, text),
});

// Database/table rows carry BOTH the identifier (for an editor drop) and a
// schema-graph payload (for a results-pane drop → lineage graph).
const lineageDrag = (ident, payload) => ({
  draggable: 'true',
  ondragstart: (e) => {
    e.dataTransfer.setData(IDENT_MIME, ident);
    e.dataTransfer.setData(SCHEMA_GRAPH_MIME, JSON.stringify(payload));
  },
});

// The four spans every tree row shares: chevron, icon, label, meta. `expanded`
// null → an empty chevron (column rows); true/false → the open/closed chevron.
const treeRow = (icon, label, meta, { expanded, iconColor } = {}) => [
  h('span', { class: 'chev' }, expanded == null ? null : (expanded ? Icon.chevDown() : Icon.chev())),
  h('span', { class: 'icon', style: iconColor ? { color: iconColor } : null }, icon),
  h('span', { class: 'label' }, label),
  h('span', { class: 'meta' }, meta),
];

// Distinguish single- from double-click WITHOUT the native `dblclick` event.
// Every row's single-click handler re-renders the tree (replaceChildren), which
// swaps the row node between a double-click's two clicks — and Firefox refuses to
// fire `dblclick` across that node swap (Chrome tolerates it), so the schema
// double-clicks silently did nothing in Firefox. Instead we record the last
// click on `app` (per instance → tests stay isolated) and treat a quick repeat
// on the same row as the double. Single click stays instant; the double runs in
// addition to that first click's expand.
const DBLCLICK_MS = 300;
function isDoubleClick(app, key) {
  const now = Date.now();
  const last = app._schemaClick;
  const dbl = !!last && last.key === key && now - last.at < DBLCLICK_MS;
  app._schemaClick = dbl ? null : { key, at: now };
  return dbl;
}

export function renderSchema(app) {
  const list = app.dom.schemaList;
  if (!list) return;
  list.replaceChildren();
  const state = app.state;

  if (state.schemaError) {
    list.appendChild(h('div', { class: 'schema-empty', style: { color: 'var(--error-fg)' } },
      'Schema load failed: ' + state.schemaError));
    return;
  }
  if (!state.schema) {
    list.appendChild(h('div', { class: 'schema-empty' }, 'Loading schema…'));
    return;
  }
  if (state.schema.length === 0) {
    list.appendChild(h('div', { class: 'schema-empty' }, 'No databases.'));
    return;
  }

  const filter = state.schemaFilter.trim().toLowerCase();
  const matches = (s) => !filter || s.toLowerCase().includes(filter);

  for (const db of state.schema) {
    list.appendChild(h('div', {
      class: 'tree-row bold',
      title: 'Click to expand · double-click to insert · shift-click for SHOW CREATE',
      onclick: (e) => {
        if (e.shiftKey) { app.actions.insertCreate('DATABASE ' + db.db); return; }
        if (isDoubleClick(app, 'db:' + db.db)) { app.actions.insertAtCursor(db.db); return; }
        db.expanded = !db.expanded;
        renderSchema(app);
      },
      ...lineageDrag(db.db, { kind: 'db', db: db.db }),
    },
      ...treeRow(Icon.database(), db.db, String(db.tables.length), { expanded: db.expanded }),
    ));
    if (!db.expanded) continue;

    for (const tb of db.tables) {
      const tableMatch = matches(tb.name);
      const colsHave = Array.isArray(tb.columns) ? tb.columns : [];
      const visibleCols = filter ? colsHave.filter((c) => matches(c.name)) : colsHave;
      if (filter && !tableMatch && visibleCols.length === 0 && tb.columns !== 'loading') continue;
      const key = db.db + '.' + tb.name;
      const isOpen = state.expandedTables.has(key);
      const tbComment = (tb.comment || '').trim();
      const title = tbComment
        ? tbComment + ' · ' + formatRows(tb.total_rows) + ' rows'
        : 'Click to expand · double-click for SELECT * · shift-click for SHOW CREATE';

      list.appendChild(h('div', {
        class: 'tree-row' + (filter && tableMatch ? ' match' : ''),
        style: { paddingLeft: '24px' },
        title,
        ...lineageDrag(key, { kind: 'table', db: db.db, table: tb.name }),
        onclick: (e) => {
          if (e.shiftKey) { app.actions.insertCreate(key); return; }
          if (isDoubleClick(app, 'tb:' + key)) { app.actions.replaceEditor('SELECT * FROM ' + key + ' LIMIT 100'); return; }
          if (state.expandedTables.has(key)) state.expandedTables.delete(key);
          else state.expandedTables.add(key);
          if (state.expandedTables.has(key) && tb.columns == null) app.actions.loadColumns(db.db, tb.name, tb);
          else renderSchema(app);
        },
      },
        ...treeRow(Icon.table(), tb.name, formatRows(tb.total_rows), { expanded: isOpen, iconColor: 'var(--accent)' }),
      ));

      if (!isOpen && !(filter && visibleCols.length > 0)) continue;
      if (tb.columns === 'loading') {
        list.appendChild(h('div', {
          class: 'tree-row small',
          style: { paddingLeft: '38px', color: 'var(--fg-faint)', fontStyle: 'italic' },
        }, 'loading columns…'));
        continue;
      }
      for (const c of visibleCols) {
        list.appendChild(h('div', {
          class: 'tree-row small mono' + (filter && matches(c.name) ? ' match' : ''),
          style: { paddingLeft: '38px' },
          title: (c.comment && c.comment.trim())
            || ('Double-click or drag to insert ' + c.name + ' · shift-click for ' + c.name + '::' + c.type),
          onclick: (e) => {
            e.stopPropagation();
            if (e.shiftKey) { app.actions.insertAtCursor(c.name + '::' + c.type); return; }
            if (isDoubleClick(app, 'col:' + key + '.' + c.name)) app.actions.insertAtCursor(c.name);
          },
          ...dragProps(c.name),
        },
          ...treeRow(Icon.col(), c.name, c.type, { expanded: null, iconColor: 'var(--fg-faint)' }),
        ));
      }
    }
  }
}
