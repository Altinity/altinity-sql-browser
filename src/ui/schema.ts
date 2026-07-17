// The schema tree: databases → tables → columns, with a text filter and
// lazy per-table column loading. Renders into app.dom.schemaList.

import { batch } from '@preact/signals-core';
import { h } from './dom.js';
import { Icon } from './icons.js';
import { formatRows, quoteIdent, qualifyIdent } from '../core/format.js';
import { compactType, INLINE_TYPE_MAX } from '../core/type-display.js';
import { IDENT_MIME, SCHEMA_GRAPH_MIME, COLUMN_TYPE_MIME } from './dnd-mime.js';
import type { AppState } from '../state.js';
import type { AppDom, ActionsRegistry } from './app.types.js';

// ── The app slice this module reads ─────────────────────────────────────────
// The narrow slice of the real `app` controller this module reads — not the
// full ~50-member `App` contract (app.types.ts). A real `App` satisfies this
// directly, and so does tests/helpers/fake-app.js's minimal `makeApp()`
// fixture — no cast needed on either side (same convention as tabs.ts's
// `TabsApp`).
export interface SchemaApp {
  dom: Pick<AppDom, 'schemaList'>;
  state: AppState;
  // `ActionsRegistry.showSchemaGraph`'s `SchemaFocus` now carries `kind?`
  // directly (#267 fixed the contract — every real showSchemaGraph payload,
  // including this module's own `{kind, db}` sends below, has always carried
  // it), so the local widening this module previously needed is gone.
  actions: Pick<ActionsRegistry, 'insertCreate' | 'insertAtCursor' | 'loadIntoNewTab' | 'loadColumns' | 'openCreateInNewTab' | 'showSchemaGraph'>;
  /** Same-row double-click tracking (see `isDoubleClick` below) — own,
   *  module-private mutable state stashed on the app instance (per instance →
   *  tests stay isolated) rather than a dedicated signal. */
  _schemaClick?: { key: string; at: number } | null;
}

// ── The schema-tree cache shape (`app.state.schema.value`) ──────────────────
// `state.ts` keeps `schema: Signal<unknown[] | null>` deliberately loose (the
// shape is decided by ch-client.ts's `loadSchema`/`loadColumns`, still .js);
// this pins exactly the fields this tree reads/writes. Mirrors
// core/from-scope.ts's own (looser) `SchemaDb`/`SchemaTable`/`SchemaColumn` —
// the completion cache's view of the same signal.

/** One column loaded for an expanded table (a system.columns row, as cached
 *  by ch-client.js's loadColumns — still .js). */
interface SchemaColumnEntry {
  name: string;
  type?: string;
  comment?: string;
  [k: string]: unknown;
}

/** One table entry as cached in `app.state.schema`: ch-client.ts's
 *  `loadSchema()` seeds `columns: null`; `loadColumns()` (app.js) sets it to
 *  `'loading'` mid-fetch, then a real array once resolved. */
interface SchemaTableEntry {
  name: string;
  total_rows: number | string;
  comment: string;
  columns: SchemaColumnEntry[] | 'loading' | null;
}

/** One database group, as `app.state.schema.value` holds it. */
interface SchemaDbEntry {
  db: string;
  comment: string;
  tables: SchemaTableEntry[];
}

// Copy-on-write expand toggle: returns a new Set with `key` added or removed, so
// assigning it to the `expanded` signal triggers the repaint effect (signals
// react to reference changes, never in-place Set mutation).
const toggleKey = (set: Set<string>, key: string): Set<string> => {
  const next = new Set(set);
  if (!next.delete(key)) next.add(key);
  return next;
};

// A drag source carrying exactly one MIME payload — used by the column
// name/type child spans (#186), each an independent drag target within one
// row. `stopPropagation` keeps an ancestor row from also contributing a
// payload for the same gesture (db/table rows use `lineageDrag` below
// instead, since they carry more than one MIME on the row itself).
const dragTextProps = (mime: string, text: string): { draggable: string; ondragstart: (e: DragEvent) => void } => ({
  draggable: 'true',
  ondragstart: (e: DragEvent) => {
    e.stopPropagation();
    e.dataTransfer!.setData(mime, text);
    e.dataTransfer!.effectAllowed = 'copy';
  },
});

// Database/table rows carry BOTH the identifier (for an editor drop) and a
// schema-graph payload (for a results-pane drop → lineage graph).
const lineageDrag = (
  ident: string, payload: Record<string, unknown>,
): { draggable: string; ondragstart: (e: DragEvent) => void } => ({
  draggable: 'true',
  ondragstart: (e: DragEvent) => {
    e.dataTransfer!.setData(IDENT_MIME, ident);
    e.dataTransfer!.setData(SCHEMA_GRAPH_MIME, JSON.stringify(payload));
  },
});

// formatRows takes `number | null | undefined`; a total_rows value carried as
// a numeric string (some JSON shapes) is coerced the same way the old bare
// arithmetic-free pass-through effectively was — this never changes which
// values are accepted, only satisfies the stricter parameter type. `Number()`
// on an already-numeric value is a no-op, so this needs no branch.
const numberish = (v: number | string): number => Number(v);

const OPEN_ROTATE = 'rotate(0deg)';
const CLOSED_ROTATE = 'rotate(-90deg)';

// Merge a base class ('label'/'meta') with an optional extra-props object that
// may itself carry a `class` (e.g. the column drag classes) — keeping the base
// class rather than letting the spread silently replace it.
const spanProps = (base: string, extra?: Record<string, unknown>): Record<string, unknown> => {
  if (!extra) return { class: base };
  const { class: extraClass, ...rest } = extra;
  return { class: extraClass ? base + ' ' + String(extraClass) : base, ...rest };
};

/** `treeRow`'s options bag. */
interface TreeRowOpts {
  expanded?: boolean | null;
  iconColor?: string;
  labelProps?: Record<string, unknown>;
  metaProps?: Record<string, unknown>;
}

// The four spans every tree row shares: chevron, icon, label, meta. `expanded`
// null → an empty chevron (column rows); true/false → the same down-pointing
// chevron rotated open/closed (matches the login screen's Advanced disclosure —
// one icon, no icon-swap flash — rather than swapping between two glyphs).
// `labelProps`/`metaProps` let a caller (column rows, #186) turn either span
// into its own independent drag target without every row duplicating this
// structure — db/table callers pass neither and get the plain spans as before.
const treeRow = (
  icon: Node, label: string, meta: string,
  { expanded, iconColor, labelProps, metaProps }: TreeRowOpts = {},
): HTMLSpanElement[] => [
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
function flipChevron(list: HTMLElement, key: string, wasOpen: boolean): void {
  const row = (Array.from(list.children) as HTMLElement[]).find((el) => el.dataset.key === key)!;
  const chev = row.querySelector<HTMLElement>('.chev')!;
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
function isDoubleClick(app: SchemaApp, key: string): boolean {
  const now = Date.now();
  const last = app._schemaClick;
  const dbl = !!last && last.key === key && now - last.at < DBLCLICK_MS;
  app._schemaClick = dbl ? null : { key, at: now };
  return dbl;
}

export function renderSchema(app: SchemaApp): void {
  const list = app.dom.schemaList;
  if (!list) return;
  list.replaceChildren();
  const state = app.state;
  const schemaError = state.schemaError.value;
  const schema = state.schema.value as SchemaDbEntry[] | null;

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
  const dragAttrs = (props: Record<string, unknown>): Record<string, unknown> => (mobile ? {} : props);
  const hoverTitle = (text: string): Record<string, unknown> => (mobile ? {} : { title: text });

  const filter = state.schemaFilter.value.trim().toLowerCase();
  const matches = (s: string): boolean => !filter || s.toLowerCase().includes(filter);

  // Search cascades through the db → table → column hierarchy (#208): a
  // direct match at one level pulls in its ancestors for context and, for a
  // database/table match, reveals its descendants — see the issue for the
  // exact precedence. This is a pure presentation-time projection over the
  // existing cache: it never writes `state.expanded` (persisted expand/
  // collapse is untouched and comes back exactly when the filter clears) and
  // never triggers column loading — a directly-matching table whose columns
  // aren't cached yet just renders with none until the user expands it.
  let anyDbShown = false;

  for (const db of schema) {
    const qdb = quoteIdent(db.db); // SQL-safe db name (reused by the 3 emit sites)
    const dbKey = 'db:' + db.db;
    const dbOpen = state.expanded.value.has(dbKey);
    const dbMatch = matches(db.db);

    const tableInfos = db.tables.map((tb) => {
      const tableMatch = matches(tb.name);
      const loadedColumns = Array.isArray(tb.columns) ? tb.columns : [];
      // Only scan a table's cached columns once a search is actually active —
      // otherwise every table in every database would pay this on every
      // no-filter repaint for a result nothing downstream uses.
      const matchingColumns = filter ? loadedColumns.filter((c) => matches(c.name)) : [];
      const includeTable = !filter || dbMatch || tableMatch || matchingColumns.length > 0;
      return { tb, tableMatch, loadedColumns, matchingColumns, includeTable };
    });
    const includedTables = tableInfos.filter((t) => t.includeTable);

    if (filter && !dbMatch && includedTables.length === 0) continue;
    anyDbShown = true;

    // An included db is shown open whenever a search is active — the guard
    // above already guarantees `dbMatch || includedTables.length > 0` holds
    // for any db that reaches this line while `filter` is set, so toggling
    // `dbOpen` can never change this db row's visual open/closed state
    // during a search (only its persisted expansion, for when the filter
    // clears) — see the flipChevron skip below.
    const dbShownOpen = dbOpen || !!filter;

    list.appendChild(h('div', {
      class: 'tree-row bold' + (filter && dbMatch ? ' match' : ''),
      'data-key': dbKey,
      ...hoverTitle(db.comment || 'Click to expand · double-click to insert · shift-click for SHOW CREATE · drag to Data for Schema'),
      onclick: (e: MouseEvent) => {
        if (e.shiftKey) { app.actions.insertCreate('DATABASE ' + qdb); return; }
        if (isDoubleClick(app, dbKey)) { app.actions.insertAtCursor(qdb); return; }
        state.expanded.value = toggleKey(state.expanded.value, dbKey);
        // A search-active db is always shown open (see dbShownOpen above), so
        // toggling persisted expansion here never actually changes what's on
        // screen — animating the chevron would just flash it shut and back
        // open for no visible reason.
        if (!filter) flipChevron(list, dbKey, dbOpen);
        // Only the collapsed → expanded transition also draws the schema graph
        // (issue #124) — collapsing an open db must not re-fetch/re-draw/steal
        // focus back to the drawer, and re-clicking an already-open db is a no-op
        // above (dbOpen unchanged), so this only fires on a genuine expand.
        if (!dbOpen) app.actions.showSchemaGraph({ kind: 'db', db: db.db });
      },
      ...dragAttrs(lineageDrag(qdb, { kind: 'db', db: db.db })),
    },
      ...treeRow(Icon.database(), db.db, String(db.tables.length), { expanded: dbShownOpen }),
    ));
    if (!dbShownOpen) continue;

    for (const { tb, tableMatch, loadedColumns, matchingColumns } of includedTables) {
      const key = db.db + '.' + tb.name; // internal identity (Sets, dbl-click tracking)
      const tbKey = 'tb:' + key;
      const qname = qualifyIdent(db.db, tb.name); // SQL-safe qualified name
      const isOpen = state.expanded.value.has(tbKey);
      const tbComment = (tb.comment || '').trim();
      const title = tbComment
        ? tbComment + ' · ' + formatRows(numberish(tb.total_rows)) + ' rows'
        : 'Click to expand · double-click SELECT * in new tab · shift-click SHOW CREATE in new tab · drag to insert name';
      // Unlike the db case above, this table's own forcing term isn't always
      // true just because a search is active — a table only included via its
      // parent db's match (no direct match of its own) still toggles normally.
      const tableCascadeForced = !!(filter && (tableMatch || matchingColumns.length > 0));
      const tableShownOpen = isOpen || tableCascadeForced;

      list.appendChild(h('div', {
        class: 'tree-row' + (filter && tableMatch ? ' match' : ''),
        style: { paddingLeft: '24px' },
        'data-key': tbKey,
        ...hoverTitle(title),
        ...dragAttrs(lineageDrag(qname, { kind: 'table', db: db.db, table: tb.name })),
        onclick: (e: MouseEvent) => {
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
          // Same reasoning as the db row's flip guard above: when this
          // table's own match forces it open, toggling isOpen never changes
          // what's rendered, so there's nothing to animate.
          if (!tableCascadeForced) flipChevron(list, tbKey, isOpen);
        },
      },
        ...treeRow(Icon.table(), tb.name, formatRows(numberish(tb.total_rows)), { expanded: tableShownOpen, iconColor: 'var(--accent)' }),
      ));

      if (!tableShownOpen) continue;
      if (tb.columns === 'loading') {
        list.appendChild(h('div', {
          class: 'tree-row small',
          style: { paddingLeft: '38px', color: 'var(--fg-faint)', fontStyle: 'italic' },
        }, 'loading columns…'));
        continue;
      }

      // Every case shows every loaded column EXCEPT a column-only match
      // (own name doesn't match, but one or more columns do) — that one case
      // narrows to just the matches; everything else (no filter, a direct
      // table match, or a table shown only via its db's match) shows all.
      const visibleColumns = filter && !tableMatch && matchingColumns.length > 0
        ? matchingColumns
        : loadedColumns;

      for (const c of visibleColumns) {
        list.appendChild(h('div', {
          class: 'tree-row small mono' + (filter && matches(c.name) ? ' match' : ''),
          style: { paddingLeft: '38px' },
          // The full type leads the hover title — the rendered meta may be a
          // compacted summary (#177) — followed by the comment or usage hints.
          ...hoverTitle((c.type ? c.type + '\n' : '') + ((c.comment && c.comment.trim())
            || ('Double-click or drag to insert ' + c.name + ' · shift-click for ' + c.name + '::type'))),
          onclick: (e: MouseEvent) => {
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

  if (filter && !anyDbShown) {
    list.appendChild(h('div', { class: 'schema-empty' }, 'No matching databases, tables, or columns.'));
  }
}
