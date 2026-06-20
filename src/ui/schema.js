// The schema tree: databases → tables → columns, with a text filter and
// lazy per-table column loading. Renders into app.dom.schemaList.

import { h } from './dom.js';
import { Icon } from './icons.js';
import { formatRows } from '../core/format.js';
import { IDENT_MIME } from './editor.js';

// Make a tree row a drag source carrying `text` as the schema identifier, so it
// can be dropped onto the editor (see editor.js drop handler). Click behavior is
// unaffected — drag is a separate gesture.
const dragProps = (text) => ({
  draggable: 'true',
  ondragstart: (e) => e.dataTransfer.setData(IDENT_MIME, text),
});

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
        db.expanded = !db.expanded;
        renderSchema(app);
      },
      ondblclick: (e) => { e.stopPropagation(); app.actions.insertAtCursor(db.db); },
      ...dragProps(db.db),
    },
      h('span', { class: 'chev' }, db.expanded ? Icon.chevDown() : Icon.chev()),
      h('span', { class: 'icon' }, Icon.database()),
      h('span', { class: 'label' }, db.db),
      h('span', { class: 'meta' }, String(db.tables.length)),
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
        ...dragProps(key),
        onclick: (e) => {
          if (e.shiftKey) { app.actions.insertCreate(key); return; }
          if (state.expandedTables.has(key)) state.expandedTables.delete(key);
          else state.expandedTables.add(key);
          if (state.expandedTables.has(key) && tb.columns == null) app.actions.loadColumns(db.db, tb.name, tb);
          else renderSchema(app);
        },
        ondblclick: (e) => { e.stopPropagation(); app.actions.insertTopLine('SELECT * FROM ' + key + ' LIMIT 100'); },
      },
        h('span', { class: 'chev' }, isOpen ? Icon.chevDown() : Icon.chev()),
        h('span', { class: 'icon', style: { color: 'var(--accent)' } }, Icon.table()),
        h('span', { class: 'label' }, tb.name),
        h('span', { class: 'meta' }, formatRows(tb.total_rows)),
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
          onclick: (e) => { e.stopPropagation(); if (e.shiftKey) app.actions.insertAtCursor(c.name + '::' + c.type); },
          ondblclick: (e) => { e.stopPropagation(); app.actions.insertAtCursor(c.name); },
          ...dragProps(c.name),
        },
          h('span', { class: 'chev' }),
          h('span', { class: 'icon', style: { color: 'var(--fg-faint)' } }, Icon.col()),
          h('span', { class: 'label' }, c.name),
          h('span', { class: 'meta' }, c.type),
        ));
      }
    }
  }
}
