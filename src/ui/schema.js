// The schema tree: databases → tables → columns, with a text filter and
// lazy per-table column loading. Renders into app.dom.schemaList.

import { batch } from '@preact/signals-core';
import { h } from './dom.js';
import { Icon } from './icons.js';
import { formatRows, quoteIdent, qualifyIdent } from '../core/format.js';
import { compactType, INLINE_TYPE_MAX } from '../core/type-display.js';
import { IDENT_MIME, SCHEMA_GRAPH_MIME, COLUMN_TYPE_MIME } from './dnd-mime.js';

// Copy-on-write expand toggle: returns a new Set with `key` added or removed, so
// assigning it to the `expanded` signal triggers the repaint effect (signals
// react to reference changes, never in-place Set mutation).
const toggleKey = (set, key) => {
  const next = new Set(set);
  if (!next.delete(key)) next.add(key);
  return next;
};

// A drag source carrying exactly one MIME payload — used by the column
// name/type child spans (#186), each an independent drag target within one
// row. `stopPropagation` keeps an ancestor row from also contributing a
// payload for the same gesture (db/table rows use `lineageDrag` below
// instead, since they carry more than one MIME on the row itself).
const dragTextProps = (mime, text) => ({
  draggable: 'true',
  ondragstart: (e) => {
    e.stopPropagation();
    e.dataTransfer.setData(mime, text);
    e.dataTransfer.effectAllowed = 'copy';
  },
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

const OPEN_ROTATE = 'rotate(0deg)';
const CLOSED_ROTATE = 'rotate(-90deg)';

// Merge a base class ('label'/'meta') with an optional extra-props object that
// may itself carry a `class` (e.g. the column drag classes) — keeping the base
// class rather than letting the spread silently replace it.
const spanProps = (base, extra) => {
  if (!extra) return { class: base };
  const { class: extraClass, ...rest } = extra;
  return { class: extraClass ? base + ' ' + extraClass : base, ...rest };
};

// The four spans every tree row shares: chevron, icon, label, meta. `expanded`
// null → an empty chevron (column rows); true/false → the same down-pointing
// chevron rotated open/closed (matches the login screen's Advanced disclosure —
// one icon, no icon-swap flash — rather than swapping between two glyphs).
// `labelProps`/`metaProps` let a caller (column rows, #186) turn either span
// into its own independent drag target without every row duplicating this
// structure — db/table callers pass neither and get the plain spans as before.
const treeRow = (icon, label, meta, { expanded, iconColor, labelProps, metaProps } = {}) => [
  h('span', {
    class: 'chev',
    style: expanded == null ? null : { transform: expanded ? OPEN_ROTATE : CLOSED_ROTATE },
  }, expanded == null ? null : Icon.chevDown()),
  h('span', { class: 'icon', style: iconColor ? { color: iconColor } : null }, icon),
  h('span', spanProps('label', labelProps), label),
  h('span', spanProps('meta', metaProps), meta),
];

// A row's DOM is fully rebuilt on every expand/collapse (renderSchema always
// `list.replaceChildren()`s — no per-row patching), so the rebuilt `.chev` span
// is born already at its target rotation and the `.tree-row .chev` CSS
// transition (styles.css) has no "from" state on that node to interpolate
// from. Restore it: after the re-render, flash the new node back to its
// pre-toggle rotation and force a layout read so the browser commits that
// paint before restoring the target rotation, giving the transition an actual
// two-frame change to animate across.
function flipChevron(list, key, wasOpen) {
  const row = Array.from(list.children).find((el) => el.dataset.key === key);
  const chev = row.querySelector('.chev');
  chev.style.transform = wasOpen ? OPEN_ROTATE : CLOSED_ROTATE;
  void chev.offsetHeight; // force layout so the "from" rotation actually commits
  chev.style.transform = wasOpen ? CLOSED_ROTATE : OPEN_ROTATE;
}

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
  const schemaError = state.schemaError.value;
  const schema = state.schema.value;

  if (schemaError) {
    list.appendChild(h('div', { class: 'schema-empty', style: { color: 'var(--error-fg)' } },
      'Schema load failed: ' + schemaError));
    return;
  }
  if (!schema) {
    list.appendChild(h('div', { class: 'schema-empty' }, 'Loading schema…'));
    return;
  }
  if (schema.length === 0) {
    list.appendChild(h('div', { class: 'schema-empty' }, 'No databases.'));
    return;
  }

  // Mobile (#126): a schema row's drag source and hover `title` are both
  // pointer-only — native HTML5 drag doesn't fire from a finger and native
  // tooltips don't reveal on tap — so below the breakpoint we render neither,
  // leaving only the tap-native click/double-tap behaviour. The schema effect
  // in app.js reads isMobile too, so crossing the breakpoint repaints the tree.
  const mobile = state.isMobile.value;
  const dragAttrs = (props) => (mobile ? {} : props);
  const hoverTitle = (text) => (mobile ? {} : { title: text });

  const filter = state.schemaFilter.value.trim().toLowerCase();
  const matches = (s) => !filter || s.toLowerCase().includes(filter);

  for (const db of schema) {
    const qdb = quoteIdent(db.db); // SQL-safe db name (reused by the 3 emit sites)
    const dbKey = 'db:' + db.db;
    const dbOpen = state.expanded.value.has(dbKey);
    list.appendChild(h('div', {
      class: 'tree-row bold',
      'data-key': dbKey,
      ...hoverTitle(db.comment || 'Click to expand · double-click to insert · shift-click for SHOW CREATE · drag to Data for Schema'),
      onclick: (e) => {
        if (e.shiftKey) { app.actions.insertCreate('DATABASE ' + qdb); return; }
        if (isDoubleClick(app, dbKey)) { app.actions.insertAtCursor(qdb); return; }
        state.expanded.value = toggleKey(state.expanded.value, dbKey);
        flipChevron(list, dbKey, dbOpen);
        // Only the collapsed → expanded transition also draws the schema graph
        // (issue #124) — collapsing an open db must not re-fetch/re-draw/steal
        // focus back to the drawer, and re-clicking an already-open db is a no-op
        // above (dbOpen unchanged), so this only fires on a genuine expand.
        if (!dbOpen) app.actions.showSchemaGraph({ kind: 'db', db: db.db });
      },
      ...dragAttrs(lineageDrag(qdb, { kind: 'db', db: db.db })),
    },
      ...treeRow(Icon.database(), db.db, String(db.tables.length), { expanded: dbOpen }),
    ));
    if (!dbOpen) continue;

    for (const tb of db.tables) {
      const tableMatch = matches(tb.name);
      const colsHave = Array.isArray(tb.columns) ? tb.columns : [];
      const visibleCols = filter ? colsHave.filter((c) => matches(c.name)) : colsHave;
      if (filter && !tableMatch && visibleCols.length === 0 && tb.columns !== 'loading') continue;
      const key = db.db + '.' + tb.name; // internal identity (Sets, dbl-click tracking)
      const tbKey = 'tb:' + key;
      const qname = qualifyIdent(db.db, tb.name); // SQL-safe qualified name
      const isOpen = state.expanded.value.has(tbKey);
      const tbComment = (tb.comment || '').trim();
      const title = tbComment
        ? tbComment + ' · ' + formatRows(tb.total_rows) + ' rows'
        : 'Click to expand · double-click SELECT * in new tab · shift-click SHOW CREATE in new tab · drag to insert name';

      list.appendChild(h('div', {
        class: 'tree-row' + (filter && tableMatch ? ' match' : ''),
        style: { paddingLeft: '24px' },
        'data-key': tbKey,
        ...hoverTitle(title),
        ...dragAttrs(lineageDrag(qname, { kind: 'table', db: db.db, table: tb.name })),
        onclick: (e) => {
          if (e.shiftKey) { app.actions.openCreateInNewTab(qname, key); return; }
          if (isDoubleClick(app, tbKey)) { app.actions.loadIntoNewTab(key, 'SELECT * FROM ' + qname + ' LIMIT 100'); return; }
          const willOpen = !state.expanded.value.has(tbKey);
          // Batch the expand + first column fetch so the row opens *with* its
          // spinner in one repaint (loadColumns' 'loading' write runs synchronously
          // before its await). Collapse / already-loaded is a single Set write.
          batch(() => {
            state.expanded.value = toggleKey(state.expanded.value, tbKey);
            if (willOpen && tb.columns == null) app.actions.loadColumns(db.db, tb.name);
          });
          flipChevron(list, tbKey, isOpen);
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
          // The full type leads the hover title — the rendered meta may be a
          // compacted summary (#177) — followed by the comment or usage hints.
          ...hoverTitle((c.type ? c.type + '\n' : '') + ((c.comment && c.comment.trim())
            || ('Double-click or drag to insert ' + c.name + ' · shift-click for ' + c.name + '::type'))),
          onclick: (e) => {
            e.stopPropagation();
            if (e.shiftKey) { app.actions.insertAtCursor(quoteIdent(c.name) + '::' + c.type); return; }
            if (isDoubleClick(app, 'col:' + key + '.' + c.name)) app.actions.insertAtCursor(quoteIdent(c.name));
          },
        },
          // Two independent drag targets (#186): the name always inserts the
          // quoted identifier; the type meta — only when a type is present —
          // inserts the FULL schema-provided type, never the compacted display
          // text. The row itself carries neither payload.
          ...treeRow(Icon.col(), c.name, compactType(c.type, INLINE_TYPE_MAX), {
            expanded: null,
            iconColor: 'var(--fg-faint)',
            labelProps: dragAttrs({
              class: 'schema-col-name-drag',
              title: 'Drag to insert column name',
              ...dragTextProps(IDENT_MIME, quoteIdent(c.name)),
            }),
            metaProps: c.type ? dragAttrs({
              class: 'schema-col-type-drag',
              title: 'Drag to insert full column type',
              ...dragTextProps(COLUMN_TYPE_MIME, c.type),
            }) : undefined,
          }),
        ));
      }
    }
  }
}
