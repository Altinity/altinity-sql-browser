import { describe, it, expect, vi } from 'vitest';
import { renderSchema } from '../../src/ui/schema.js';
import { IDENT_MIME, SCHEMA_GRAPH_MIME, COLUMN_TYPE_MIME } from '../../src/ui/dnd-mime.js';
import { makeApp } from '../helpers/fake-app.js';

const rows = (app) => [...app.dom.schemaList.querySelectorAll('.tree-row')];
// Column rows only ('.tree-row.small'), found by their name label text.
const colRow = (app, name) => [...app.dom.schemaList.querySelectorAll('.tree-row.small')]
  .find((r) => r.querySelector('.label').textContent === name);
const click = (el) => el.dispatchEvent(new Event('click', { bubbles: true }));
const shiftClick = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
// A double-click is two quick clicks on the same row — the app detects it itself
// rather than via the native `dblclick` event (which Firefox drops when the row
// re-renders between clicks). Clicking the same captured node twice works even
// though the first click detaches it: the listener + per-app state still fire.
const dblclick = (el) => { click(el); click(el); };
// Expand state is a Set-valued signal keyed 'db:'+name / 'tb:'+db.table; seed it
// additively so a table expand keeps its parent db open.
const setExpanded = (app, ...keys) => { app.state.expanded.value = new Set([...app.state.expanded.value, ...keys]); };
// Fire a dragstart with a stub dataTransfer and return all setData payloads by MIME.
const dragstart = (el) => {
  const e = new Event('dragstart', { bubbles: true });
  const by = {};
  e.dataTransfer = { setData: (mime, value) => { by[mime] = value; } };
  el.dispatchEvent(e);
  by.mime = Object.keys(by)[0]; by.value = by[by.mime]; // back-compat for single-MIME rows
  return by;
};

function withSchema() {
  const app = makeApp();
  app.state.schema.value = [
    {
      db: 'db1',
      tables: [
        { name: 'orders', total_rows: '1000', total_bytes: '2000', comment: 'the orders', columns: null },
        { name: 'events', total_rows: '5', total_bytes: '9', comment: '', columns: null },
      ],
    },
    { db: 'db2', tables: [{ name: 't', total_rows: '1', total_bytes: '1', comment: '', columns: null }] },
  ];
  app.state.expanded.value = new Set(['db:db1']); // db1 open, db2 collapsed
  return app;
}

describe('renderSchema states', () => {
  it('no-ops without a list mount', () => {
    const app = makeApp();
    app.dom.schemaList = null;
    expect(() => renderSchema(app)).not.toThrow();
  });
  it('shows the schema error', () => {
    const app = makeApp();
    app.state.schemaError.value = 'bad';
    renderSchema(app);
    expect(app.dom.schemaList.textContent).toContain('Schema load failed: bad');
  });
  it('shows a loading state when schema is null', () => {
    const app = makeApp();
    renderSchema(app);
    expect(app.dom.schemaList.textContent).toContain('Loading schema…');
  });
  it('shows "No databases." for an empty schema', () => {
    const app = makeApp();
    app.state.schema.value = [];
    renderSchema(app);
    expect(app.dom.schemaList.textContent).toContain('No databases.');
  });
});

describe('renderSchema tree', () => {
  it('renders dbs (expanded shows tables; collapsed hides them)', () => {
    const app = withSchema();
    renderSchema(app);
    const labels = rows(app).map((r) => r.querySelector('.label').textContent);
    expect(labels).toContain('db1');
    expect(labels).toContain('orders');
    expect(labels).toContain('db2');
    expect(labels).not.toContain('t'); // db2 collapsed
  });
  it('shows the db comment as hover text when present, else the default + drag hint', () => {
    const app = withSchema();
    app.state.schema.value[1].comment = 'second database';
    renderSchema(app);
    const db1Row = rows(app).find((r) => r.querySelector('.label').textContent === 'db1');
    const db2Row = rows(app).find((r) => r.querySelector('.label').textContent === 'db2');
    expect(db1Row.title).toBe('Click to expand · double-click to insert · shift-click for SHOW CREATE · drag to Data for Schema');
    expect(db2Row.title).toBe('second database');
  });
  it('appends a drag hint to the no-comment table hover text', () => {
    const app = withSchema();
    renderSchema(app);
    const ordersRow = rows(app).find((r) => r.querySelector('.label').textContent === 'orders');
    const eventsRow = rows(app).find((r) => r.querySelector('.label').textContent === 'events');
    expect(ordersRow.title).toBe('the orders · 1.0K rows'); // has a comment, unchanged
    expect(eventsRow.title).toBe('Click to expand · double-click SELECT * in new tab · shift-click SHOW CREATE in new tab · drag to insert name');
  });
  it('clicking a db toggles expansion', () => {
    const app = withSchema();
    renderSchema(app);
    const db2Row = rows(app).find((r) => r.querySelector('.label').textContent === 'db2');
    click(db2Row);
    expect(app.state.expanded.value.has('db:db2')).toBe(true);
  });
  it('clicking a closed db also draws its schema graph (collapsed → expanded only, #124)', () => {
    const app = withSchema();
    renderSchema(app);
    const db2Row = rows(app).find((r) => r.querySelector('.label').textContent === 'db2'); // starts collapsed
    click(db2Row);
    expect(app.actions.showSchemaGraph).toHaveBeenCalledWith({ kind: 'db', db: 'db2' });
  });
  it('collapsing an open db does not re-draw/re-fetch the schema graph', () => {
    const app = withSchema();
    renderSchema(app);
    const db1Row = rows(app).find((r) => r.querySelector('.label').textContent === 'db1'); // starts open
    click(db1Row); // collapse
    expect(app.state.expanded.value.has('db:db1')).toBe(false);
    expect(app.actions.showSchemaGraph).not.toHaveBeenCalled();
  });
  it('shift-clicking a closed db inserts DDL without drawing the schema graph', () => {
    const app = withSchema();
    renderSchema(app);
    const db2Row = rows(app).find((r) => r.querySelector('.label').textContent === 'db2'); // closed
    shiftClick(db2Row);
    expect(app.actions.showSchemaGraph).not.toHaveBeenCalled();
  });
  it('double-clicking an already-open db just re-inserts the name (no re-draw)', () => {
    const app = withSchema();
    renderSchema(app);
    const db1Row = rows(app).find((r) => r.querySelector('.label').textContent === 'db1'); // open
    dblclick(db1Row); // 1st click: collapses (open → closed, no graph); 2nd: the double, inserts the name
    expect(app.actions.insertAtCursor).toHaveBeenCalledWith('db1');
    expect(app.actions.showSchemaGraph).not.toHaveBeenCalled();
  });
  it('the chevron rotates to the down/open orientation on expand and back on collapse', () => {
    vi.useFakeTimers();
    try {
      const app = withSchema();
      renderSchema(app);
      let db2Row = rows(app).find((r) => r.querySelector('.label').textContent === 'db2');
      expect(db2Row.querySelector('.chev').style.transform).toBe('rotate(-90deg)'); // starts collapsed
      click(db2Row); // expand
      expect(db2Row.querySelector('.chev').style.transform).toBe('rotate(0deg)');
      // The real app re-renders the tree via an effect on `state.expanded` before
      // any further click can occur; simulate that here so the next click's
      // handler closes over the post-expand state, same as in production. Also
      // clear the double-click window (300ms) so the second click isn't read as
      // the second half of a double-click on the same row (see DBLCLICK_MS).
      renderSchema(app);
      vi.advanceTimersByTime(400);
      db2Row = rows(app).find((r) => r.querySelector('.label').textContent === 'db2');
      click(db2Row); // collapse
      expect(db2Row.querySelector('.chev').style.transform).toBe('rotate(-90deg)');
    } finally {
      vi.useRealTimers();
    }
  });
  it('shift-clicking a db inserts its formatted DDL without expanding', () => {
    const app = withSchema();
    renderSchema(app);
    const db2Row = rows(app).find((r) => r.querySelector('.label').textContent === 'db2');
    shiftClick(db2Row);
    expect(app.actions.insertCreate).toHaveBeenCalledWith('DATABASE db2');
    expect(app.state.expanded.value.has('db:db2')).toBe(false);
  });
  it('double-clicking a db inserts its name', () => {
    const app = withSchema();
    renderSchema(app);
    const db1Row = rows(app).find((r) => r.querySelector('.label').textContent === 'db1');
    dblclick(db1Row);
    expect(app.actions.insertAtCursor).toHaveBeenCalledWith('db1');
  });
  it('expanding a table with no columns triggers loadColumns', () => {
    const app = withSchema();
    renderSchema(app);
    const ordersRow = rows(app).find((r) => r.querySelector('.label').textContent === 'orders');
    expect(ordersRow.querySelector('.chev').style.transform).toBe('rotate(-90deg)'); // starts collapsed
    click(ordersRow);
    expect(app.state.expanded.value.has('tb:db1.orders')).toBe(true);
    expect(app.actions.loadColumns).toHaveBeenCalledWith('db1', 'orders');
    expect(ordersRow.querySelector('.chev').style.transform).toBe('rotate(0deg)');
  });
  it('collapsing an already-loaded table just re-renders', () => {
    const app = withSchema();
    app.state.schema.value[0].tables[0].columns = [{ name: 'id', type: 'UInt64', comment: '' }];
    setExpanded(app, 'tb:db1.orders');
    renderSchema(app);
    const ordersRow = rows(app).find((r) => r.querySelector('.label').textContent === 'orders');
    click(ordersRow); // collapse
    expect(app.state.expanded.value.has('tb:db1.orders')).toBe(false);
  });
  it('double-clicking a table opens a SELECT * in a new tab, not the active editor', () => {
    const app = withSchema();
    renderSchema(app);
    const ordersRow = rows(app).find((r) => r.querySelector('.label').textContent === 'orders');
    dblclick(ordersRow);
    expect(app.actions.loadIntoNewTab).toHaveBeenCalledWith('db1.orders', 'SELECT * FROM db1.orders LIMIT 100');
    expect(app.actions.replaceEditor).not.toHaveBeenCalled();
  });
  it('shift-clicking a table opens its formatted DDL in a new tab, without expanding', () => {
    const app = withSchema();
    renderSchema(app);
    const eventsRow = rows(app).find((r) => r.querySelector('.label').textContent === 'events');
    shiftClick(eventsRow);
    expect(app.actions.openCreateInNewTab).toHaveBeenCalledWith('db1.events', 'db1.events');
    expect(app.actions.insertCreate).not.toHaveBeenCalled();
    expect(app.state.expanded.value.has('tb:db1.events')).toBe(false);
    expect(app.actions.loadColumns).not.toHaveBeenCalled();
  });
  it('shows a loading row while columns load', () => {
    const app = withSchema();
    app.state.schema.value[0].tables[0].columns = 'loading';
    setExpanded(app, 'tb:db1.orders');
    renderSchema(app);
    expect(app.dom.schemaList.textContent).toContain('loading columns…');
  });
  it('columns: a plain click inserts nothing, a quick repeat (double-click) inserts the name', () => {
    const app = withSchema();
    app.state.schema.value[0].tables[0].columns = [
      { name: 'id', type: 'UInt64', comment: 'pk' },     // comment → title branch
      { name: 'ts', type: 'DateTime', comment: '' },     // no comment → default title branch
    ];
    setExpanded(app, 'tb:db1.orders');
    renderSchema(app);
    const colRow = [...app.dom.schemaList.querySelectorAll('.tree-row.small')]
      .find((r) => r.querySelector('.label').textContent === 'id');
    click(colRow);
    expect(app.actions.insertAtCursor).not.toHaveBeenCalled(); // first click does nothing
    click(colRow); // quick repeat → double-click
    expect(app.actions.insertAtCursor).toHaveBeenCalledWith('id');
  });
  it('columns: shift-click inserts name::type', () => {
    const app = withSchema();
    app.state.schema.value[0].tables[0].columns = [{ name: 'id', type: 'UInt64', comment: 'pk' }];
    setExpanded(app, 'tb:db1.orders');
    renderSchema(app);
    const colRow = [...app.dom.schemaList.querySelectorAll('.tree-row.small')]
      .find((r) => r.querySelector('.label').textContent === 'id');
    shiftClick(colRow);
    expect(app.actions.insertAtCursor).toHaveBeenCalledWith('id::UInt64');
  });
  it('columns: compacts an unbounded type in the row meta, full type leads the hover title (#177)', () => {
    const app = withSchema();
    const enumType = "Enum8('started' = 1, 'running' = 2, 'done' = 3, 'failed' = 4)";
    app.state.schema.value[0].tables[0].columns = [
      { name: 'state', type: enumType, comment: 'job state' },
      { name: 'id', type: 'UInt64', comment: '' },
    ];
    setExpanded(app, 'tb:db1.orders');
    renderSchema(app);
    const row = (name) => [...app.dom.schemaList.querySelectorAll('.tree-row.small')]
      .find((r) => r.querySelector('.label').textContent === name);
    // never partial member text in the row — a semantic summary instead
    expect(row('state').querySelector('.meta').textContent).toBe('Enum8(4 values)');
    expect(row('state').title).toBe(enumType + '\njob state');
    // a short type renders raw; its title still leads with the type
    expect(row('id').querySelector('.meta').textContent).toBe('UInt64');
    expect(row('id').title).toBe('UInt64\nDouble-click or drag to insert id · shift-click for id::type');
  });
  it('columns: a type-less column row renders an empty meta and a hint-only title', () => {
    const app = withSchema();
    app.state.schema.value[0].tables[0].columns = [{ name: 'odd', comment: '' }];
    setExpanded(app, 'tb:db1.orders');
    renderSchema(app);
    const row = [...app.dom.schemaList.querySelectorAll('.tree-row.small')]
      .find((r) => r.querySelector('.label').textContent === 'odd');
    expect(row.querySelector('.meta').textContent).toBe('');
    expect(row.title).toBe('Double-click or drag to insert odd · shift-click for odd::type'); // no 'undefined' leader
  });
  it('two quick clicks on different rows are two single clicks, not a double', () => {
    const app = withSchema();
    renderSchema(app);
    const db1Row = rows(app).find((r) => r.querySelector('.label').textContent === 'db1');
    const db2Row = rows(app).find((r) => r.querySelector('.label').textContent === 'db2');
    click(db1Row); // single: collapses db1
    click(db2Row); // different row → single: expands db2 (not an insert)
    expect(app.actions.insertAtCursor).not.toHaveBeenCalled();
    expect(app.state.expanded.value.has('db:db2')).toBe(true);
  });
  it('a slow second click on the same row is a single click, not a double (window expired)', () => {
    vi.useFakeTimers();
    try {
      const app = withSchema();
      renderSchema(app);
      let db2Row = rows(app).find((r) => r.querySelector('.label').textContent === 'db2');
      click(db2Row); // expand db2
      expect(app.state.expanded.value.has('db:db2')).toBe(true);
      vi.advanceTimersByTime(400); // past DBLCLICK_MS (300ms)
      db2Row = rows(app).find((r) => r.querySelector('.label').textContent === 'db2');
      click(db2Row); // expired → single → collapses db2, not an insert
      expect(app.actions.insertAtCursor).not.toHaveBeenCalled();
      expect(app.state.expanded.value.has('db:db2')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('renderSchema drag sources', () => {
  it('dragging a db carries the identifier and a schema-graph payload', () => {
    const app = withSchema();
    renderSchema(app);
    const dbRow = rows(app).find((r) => r.querySelector('.label').textContent === 'db1');
    const d = dragstart(dbRow);
    expect(d[IDENT_MIME]).toBe('db1');
    expect(JSON.parse(d[SCHEMA_GRAPH_MIME])).toEqual({ kind: 'db', db: 'db1' });
  });
  it('dragging a table carries the qualified identifier and a schema-graph payload', () => {
    const app = withSchema();
    renderSchema(app);
    const ordersRow = rows(app).find((r) => r.querySelector('.label').textContent === 'orders');
    const d = dragstart(ordersRow);
    expect(d[IDENT_MIME]).toBe('db1.orders');
    expect(JSON.parse(d[SCHEMA_GRAPH_MIME])).toEqual({ kind: 'table', db: 'db1', table: 'orders' });
  });
  it('dragging the column row itself (not a child span) carries no payload', () => {
    const app = withSchema();
    app.state.schema.value[0].tables[0].columns = [{ name: 'id', type: 'UInt64', comment: '' }];
    setExpanded(app, 'tb:db1.orders');
    renderSchema(app);
    const row = colRow(app, 'id');
    const d = dragstart(row);
    expect(d[IDENT_MIME]).toBeUndefined();
    expect(d[COLUMN_TYPE_MIME]).toBeUndefined();
    expect(d[SCHEMA_GRAPH_MIME]).toBeUndefined();
  });
  it('dragging the column icon or the row\'s padding (not a labeled span) carries no payload', () => {
    const app = withSchema();
    app.state.schema.value[0].tables[0].columns = [{ name: 'id', type: 'UInt64', comment: '' }];
    setExpanded(app, 'tb:db1.orders');
    renderSchema(app);
    const icon = colRow(app, 'id').querySelector('.icon');
    const d = dragstart(icon);
    expect(d[IDENT_MIME]).toBeUndefined();
    expect(d[COLUMN_TYPE_MIME]).toBeUndefined();
  });
  it('dragging the name label emits only the SQL-safe quoted identifier', () => {
    const app = withSchema();
    app.state.schema.value[0].tables[0].columns = [{ name: 'id', type: 'UInt64', comment: '' }];
    setExpanded(app, 'tb:db1.orders');
    renderSchema(app);
    const label = colRow(app, 'id').querySelector('.label');
    const d = dragstart(label);
    expect(d[IDENT_MIME]).toBe('id');
    expect(d[COLUMN_TYPE_MIME]).toBeUndefined();
    expect(d[SCHEMA_GRAPH_MIME]).toBeUndefined();
  });
  it('dragging a non-bare name emits the correctly quoted identifier', () => {
    const app = withSchema();
    app.state.schema.value[0].tables[0].columns = [{ name: 'odd col', type: 'String', comment: '' }];
    setExpanded(app, 'tb:db1.orders');
    renderSchema(app);
    const label = colRow(app, 'odd col').querySelector('.label');
    expect(dragstart(label)[IDENT_MIME]).toBe('`odd col`');
  });
  it('dragging the type meta emits only the full type', () => {
    const app = withSchema();
    app.state.schema.value[0].tables[0].columns = [{ name: 'id', type: 'UInt64', comment: '' }];
    setExpanded(app, 'tb:db1.orders');
    renderSchema(app);
    const meta = colRow(app, 'id').querySelector('.meta');
    const d = dragstart(meta);
    expect(d[COLUMN_TYPE_MIME]).toBe('UInt64');
    expect(d[IDENT_MIME]).toBeUndefined();
  });
  it('a compact Enum summary drags the complete original declaration, byte-for-byte', () => {
    const app = withSchema();
    const enumType = "Enum16('Close' = -11, 'Error' = -1, 'Watch' = 0, 'Create' = 1, 'Remove' = 2)";
    app.state.schema.value[0].tables[0].columns = [{ name: 'operation', type: enumType, comment: '' }];
    setExpanded(app, 'tb:db1.orders');
    renderSchema(app);
    const row = colRow(app, 'operation');
    // the visible meta is the compacted summary, never the drag payload
    expect(row.querySelector('.meta').textContent).toBe('Enum16(5 values)');
    expect(dragstart(row.querySelector('.meta'))[COLUMN_TYPE_MIME]).toBe(enumType);
  });
  it('a nested/parameterized type is emitted byte-for-byte, not reconstructed', () => {
    const app = withSchema();
    const nested = 'LowCardinality(Nullable(String))';
    app.state.schema.value[0].tables[0].columns = [
      { name: 'a', type: nested, comment: '' },
      { name: 'b', type: 'Decimal(38, 9)', comment: '' },
      { name: 'c', type: "Tuple(`x` Int32, `y str` String)", comment: '' },
    ];
    setExpanded(app, 'tb:db1.orders');
    renderSchema(app);
    expect(dragstart(colRow(app, 'a').querySelector('.meta'))[COLUMN_TYPE_MIME]).toBe(nested);
    expect(dragstart(colRow(app, 'b').querySelector('.meta'))[COLUMN_TYPE_MIME]).toBe('Decimal(38, 9)');
    expect(dragstart(colRow(app, 'c').querySelector('.meta'))[COLUMN_TYPE_MIME]).toBe("Tuple(`x` Int32, `y str` String)");
  });
  it('a type-less column has a draggable name but a non-draggable, empty type meta', () => {
    const app = withSchema();
    app.state.schema.value[0].tables[0].columns = [{ name: 'odd', comment: '' }];
    setExpanded(app, 'tb:db1.orders');
    renderSchema(app);
    const row = colRow(app, 'odd');
    expect(row.querySelector('.label').getAttribute('draggable')).toBe('true');
    expect(row.querySelector('.meta').getAttribute('draggable')).toBeNull();
    expect(row.querySelector('.meta').getAttribute('title')).toBeNull();
    const d = dragstart(row.querySelector('.meta'));
    expect(d[COLUMN_TYPE_MIME]).toBeUndefined();
  });
  it('name/type dragstart does not invoke the column click/double-click insertion path', () => {
    const app = withSchema();
    app.state.schema.value[0].tables[0].columns = [{ name: 'id', type: 'UInt64', comment: '' }];
    setExpanded(app, 'tb:db1.orders');
    renderSchema(app);
    const row = colRow(app, 'id');
    dragstart(row.querySelector('.label'));
    dragstart(row.querySelector('.meta'));
    expect(app.actions.insertAtCursor).not.toHaveBeenCalled();
  });
  it('name and type spans expose distinct tooltips', () => {
    const app = withSchema();
    app.state.schema.value[0].tables[0].columns = [{ name: 'id', type: 'UInt64', comment: '' }];
    setExpanded(app, 'tb:db1.orders');
    renderSchema(app);
    const row = colRow(app, 'id');
    expect(row.querySelector('.label').getAttribute('title')).toBe('Drag to insert column name');
    expect(row.querySelector('.meta').getAttribute('title')).toBe('Drag to insert full column type');
  });
});

describe('renderSchema in mobile mode (#126)', () => {
  // Below the breakpoint, a row's drag source and hover `title` are both
  // pointer-only, so neither is rendered — only the tap-native click behaviour.
  function mobileSchema(withCols) {
    const app = withSchema();
    if (withCols) {
      app.state.schema.value[0].tables[0].columns = [{ name: 'id', type: 'UInt64', comment: 'pk' }];
      setExpanded(app, 'tb:db1.orders');
    }
    app.state.isMobile.value = true;
    renderSchema(app);
    return app;
  }
  it('drops draggable + title on db, table and column rows', () => {
    const app = mobileSchema(true);
    const dbRow = rows(app).find((r) => r.querySelector('.label').textContent === 'db1');
    const ordersRow = rows(app).find((r) => r.querySelector('.label').textContent === 'orders');
    const row = colRow(app, 'id');
    for (const r of [dbRow, ordersRow, row]) {
      expect(r.getAttribute('draggable')).toBeNull();
      expect(r.getAttribute('title')).toBeNull();
    }
  });
  it('the column name and type spans have no draggable attribute or tooltip in mobile mode', () => {
    const app = mobileSchema(true);
    const row = colRow(app, 'id');
    expect(row.querySelector('.label').getAttribute('draggable')).toBeNull();
    expect(row.querySelector('.label').getAttribute('title')).toBeNull();
    expect(row.querySelector('.meta').getAttribute('draggable')).toBeNull();
    expect(row.querySelector('.meta').getAttribute('title')).toBeNull();
  });
  it('a dragstart carries no payload when mobile (no drag source wired)', () => {
    const app = mobileSchema(false);
    const dbRow = rows(app).find((r) => r.querySelector('.label').textContent === 'db1');
    const d = dragstart(dbRow);
    expect(d[IDENT_MIME]).toBeUndefined();
    expect(d[SCHEMA_GRAPH_MIME]).toBeUndefined();
  });
  it('a synthetic dragstart from either column child span emits no payload in mobile mode', () => {
    const app = mobileSchema(true);
    const row = colRow(app, 'id');
    const d1 = dragstart(row.querySelector('.label'));
    const d2 = dragstart(row.querySelector('.meta'));
    expect(d1[IDENT_MIME]).toBeUndefined();
    expect(d2[COLUMN_TYPE_MIME]).toBeUndefined();
  });
  it('tap (click) still expands + draws the graph — the core loop is intact', () => {
    const app = mobileSchema(false);
    const db2Row = rows(app).find((r) => r.querySelector('.label').textContent === 'db2');
    click(db2Row);
    expect(app.state.expanded.value.has('db:db2')).toBe(true);
    expect(app.actions.showSchemaGraph).toHaveBeenCalledWith({ kind: 'db', db: 'db2' });
  });
});

describe('renderSchema with non-bare object names (backtick quoting)', () => {
  const PARQUET = 'part-00000-70041866.snappy.parquet';
  function withParquet() {
    const app = makeApp();
    app.state.schema.value = [{
      db: 'target_all',
      tables: [{ name: PARQUET, total_rows: '1', total_bytes: '1', comment: '', columns: null }],
    }];
    app.state.expanded.value = new Set(['db:target_all']);
    return app;
  }
  const tbRow = (app) => rows(app).find((r) => r.querySelector('.label').textContent === PARQUET);

  it('double-click → SELECT * quotes the dotted/dashed table name, display name stays unquoted', () => {
    const app = withParquet();
    renderSchema(app);
    dblclick(tbRow(app));
    expect(app.actions.loadIntoNewTab).toHaveBeenCalledWith(
      'target_all.' + PARQUET,
      'SELECT * FROM target_all.`' + PARQUET + '` LIMIT 100',
    );
  });
  it('shift-click → SHOW CREATE target is backtick-quoted, tab name stays unquoted', () => {
    const app = withParquet();
    renderSchema(app);
    shiftClick(tbRow(app));
    expect(app.actions.openCreateInNewTab).toHaveBeenCalledWith(
      'target_all.`' + PARQUET + '`',
      'target_all.' + PARQUET,
    );
  });
  it('drag carries the quoted identifier (but the graph payload keeps raw names)', () => {
    const app = withParquet();
    renderSchema(app);
    const d = dragstart(tbRow(app));
    expect(d[IDENT_MIME]).toBe('target_all.`' + PARQUET + '`');
    expect(JSON.parse(d[SCHEMA_GRAPH_MIME])).toEqual({ kind: 'table', db: 'target_all', table: PARQUET });
  });
  it('a column with special chars is quoted on insert', () => {
    const app = withParquet();
    app.state.schema.value[0].tables[0].columns = [{ name: 'odd col', type: 'String', comment: '' }];
    setExpanded(app, 'tb:target_all.' + PARQUET);
    renderSchema(app);
    const row = colRow(app, 'odd col');
    expect(dragstart(row.querySelector('.label'))[IDENT_MIME]).toBe('`odd col`');
    shiftClick(row);
    expect(app.actions.insertAtCursor).toHaveBeenCalledWith('`odd col`::String');
  });
  it('double-click on a table name with a space: tab name is unquoted, SQL is quoted', () => {
    const app = makeApp();
    app.state.schema.value = [{
      db: 'analytics',
      tables: [{ name: 'daily events', total_rows: '1', total_bytes: '1', comment: '', columns: null }],
    }];
    app.state.expanded.value = new Set(['db:analytics']);
    renderSchema(app);
    const row = rows(app).find((r) => r.querySelector('.label').textContent === 'daily events');
    dblclick(row);
    expect(app.actions.loadIntoNewTab).toHaveBeenCalledWith(
      'analytics.daily events',
      'SELECT * FROM analytics.`daily events` LIMIT 100',
    );
  });
});

describe('renderSchema filter', () => {
  it('keeps matching tables and drops non-matching ones', () => {
    const app = withSchema();
    app.state.schemaFilter.value = 'order';
    renderSchema(app);
    const labels = rows(app).map((r) => r.querySelector('.label').textContent);
    expect(labels).toContain('orders');
    expect(labels).not.toContain('events');
  });
  it('reveals a table when one of its columns matches the filter', () => {
    const app = withSchema();
    app.state.schema.value[0].tables[1].columns = [{ name: 'user_id', type: 'UInt64', comment: '' }];
    app.state.schemaFilter.value = 'user_id';
    renderSchema(app);
    expect(app.dom.schemaList.textContent).toContain('user_id');
  });
});

// #208 — hierarchical, cascading search: a match at any level pulls in its
// ancestors for context and, for a db/table match, its descendants. Fixture
// mirrors the issue's own example tree, all persisted-collapsed by default.
function withSearchSchema() {
  const app = makeApp();
  app.state.schema.value = [
    {
      db: 'analytics',
      tables: [
        {
          name: 'events', total_rows: '10', total_bytes: '20', comment: '',
          columns: [
            { name: 'event_time', type: 'DateTime', comment: '' },
            { name: 'event_name', type: 'String', comment: '' },
            { name: 'user_id', type: 'UInt64', comment: '' },
          ],
        },
        {
          name: 'users', total_rows: '2', total_bytes: '4', comment: '',
          columns: [
            { name: 'id', type: 'UInt64', comment: '' },
            { name: 'email', type: 'String', comment: '' },
          ],
        },
      ],
    },
    {
      db: 'system',
      tables: [
        {
          name: 'query_log', total_rows: '5', total_bytes: '9', comment: '',
          columns: [
            { name: 'event_time', type: 'DateTime', comment: '' },
            { name: 'query', type: 'String', comment: '' },
          ],
        },
      ],
    },
  ];
  app.state.expanded.value = new Set(); // everything persisted-collapsed
  return app;
}
const colRowsNamed = (app, name) => [...app.dom.schemaList.querySelectorAll('.tree-row.small')]
  .filter((r) => r.querySelector('.label').textContent === name);

describe('renderSchema search cascade (#208)', () => {
  it('database match: shows the whole matching database, hides the other, columns stay collapsed, expanded state untouched', () => {
    const app = withSearchSchema();
    const before = new Set(app.state.expanded.value);
    app.state.schemaFilter.value = 'analytics';
    renderSchema(app);
    const labels = rows(app).map((r) => r.querySelector('.label').textContent);
    expect(labels).toEqual(expect.arrayContaining(['analytics', 'events', 'users']));
    expect(labels).not.toContain('system');
    expect(labels).not.toContain('query_log');
    expect(labels).not.toContain('event_time');
    expect(labels).not.toContain('id');
    const dbRow = rows(app).find((r) => r.querySelector('.label').textContent === 'analytics');
    expect(dbRow.classList.contains('match')).toBe(true);
    expect(dbRow.querySelector('.chev').style.transform).toBe('rotate(0deg)');
    const eventsRow = rows(app).find((r) => r.querySelector('.label').textContent === 'events');
    expect(eventsRow.classList.contains('match')).toBe(false);
    expect(app.state.expanded.value).toEqual(before);
  });

  it('table match: shows the parent db, matching table, and all its loaded columns; hides sibling tables', () => {
    const app = withSearchSchema();
    app.state.schemaFilter.value = 'events';
    renderSchema(app);
    const labels = rows(app).map((r) => r.querySelector('.label').textContent);
    expect(labels).toContain('analytics');
    expect(labels).toContain('events');
    expect(labels).not.toContain('users');
    expect(labels).not.toContain('system');
    expect(labels).toContain('event_time');
    expect(labels).toContain('event_name');
    expect(labels).toContain('user_id');
    const tblRow = rows(app).find((r) => r.querySelector('.label').textContent === 'events');
    expect(tblRow.classList.contains('match')).toBe(true);
    expect(tblRow.querySelector('.chev').style.transform).toBe('rotate(0deg)');
    expect(app.state.expanded.value.size).toBe(0); // persisted expansion untouched
  });

  it('column match: shows every matching column and its db/table ancestors, hides everything else', () => {
    const app = withSearchSchema();
    app.state.schemaFilter.value = 'event_time';
    renderSchema(app);
    const labels = rows(app).map((r) => r.querySelector('.label').textContent);
    expect(labels).toEqual(expect.arrayContaining(['analytics', 'events', 'system', 'query_log']));
    expect(labels).not.toContain('users');
    expect(labels).not.toContain('event_name');
    expect(labels).not.toContain('user_id');
    expect(labels).not.toContain('query');
    const eventTimeRows = colRowsNamed(app, 'event_time');
    expect(eventTimeRows.length).toBe(2); // one under events, one under query_log
    for (const r of eventTimeRows) expect(r.classList.contains('match')).toBe(true);
    const eventsRow = rows(app).find((r) => r.querySelector('.label').textContent === 'events');
    expect(eventsRow.classList.contains('match')).toBe(false); // ancestor context only, not a direct match
    expect(app.state.expanded.value.size).toBe(0);
  });

  it('database match with one persistently expanded table: expanded table\'s columns still show; collapsed sibling does not reveal columns solely from the db match', () => {
    const app = withSearchSchema();
    setExpanded(app, 'tb:analytics.events');
    app.state.schemaFilter.value = 'analytics';
    renderSchema(app);
    const labels = rows(app).map((r) => r.querySelector('.label').textContent);
    expect(labels).toContain('events');
    expect(labels).toContain('users');
    expect(labels).toContain('event_time');
    expect(labels).toContain('event_name');
    expect(labels).toContain('user_id');
    expect(labels).not.toContain('id');
    expect(labels).not.toContain('email');
  });

  it('overlapping direct matches: a term matching both a table and a column favors the table match (shows every loaded column)', () => {
    const app = withSearchSchema();
    app.state.schemaFilter.value = 'query';
    renderSchema(app);
    const labels = rows(app).map((r) => r.querySelector('.label').textContent);
    expect(labels).toContain('query_log');
    expect(labels).toContain('event_time'); // shown via the table match, not because 'event_time' itself matches 'query'
    expect(labels).toContain('query');
    expect(labels).not.toContain('analytics');
  });

  it('a directly matching table with columns not yet loaded shows no columns and triggers no load', () => {
    const app = withSearchSchema();
    app.state.schema.value[0].tables[0].columns = null; // events
    app.state.schemaFilter.value = 'events';
    renderSchema(app);
    const labels = rows(app).map((r) => r.querySelector('.label').textContent);
    expect(labels).toContain('analytics');
    expect(labels).toContain('events');
    expect(labels).not.toContain('event_time');
    expect(app.actions.loadColumns).not.toHaveBeenCalled();
  });

  it('a directly matching table whose columns are loading shows the loading row', () => {
    const app = withSearchSchema();
    app.state.schema.value[0].tables[0].columns = 'loading'; // events
    app.state.schemaFilter.value = 'events';
    renderSchema(app);
    expect(app.dom.schemaList.textContent).toContain('loading columns…');
  });

  it('after the cache is replaced and repainted, a table match shows all columns and a column match shows only the matches', () => {
    const app = withSearchSchema();
    app.state.schema.value[0].tables[0].columns = null; // events
    app.state.schemaFilter.value = 'events';
    renderSchema(app); // no columns cached yet
    expect(rows(app).map((r) => r.querySelector('.label').textContent)).not.toContain('event_time');

    app.state.schema.value[0].tables[0].columns = [
      { name: 'event_time', type: 'DateTime', comment: '' },
      { name: 'event_name', type: 'String', comment: '' },
      { name: 'user_id', type: 'UInt64', comment: '' },
    ];
    renderSchema(app);
    let labels = rows(app).map((r) => r.querySelector('.label').textContent);
    expect(labels).toContain('event_time');
    expect(labels).toContain('user_id');

    app.state.schemaFilter.value = 'event_time';
    renderSchema(app);
    labels = rows(app).map((r) => r.querySelector('.label').textContent);
    expect(labels).toContain('event_time');
    expect(labels).not.toContain('user_id');
  });

  it('clearing the filter restores the exact pre-search expansion-driven tree', () => {
    const app = withSearchSchema();
    setExpanded(app, 'db:analytics');
    renderSchema(app);
    const before = rows(app).map((r) => r.querySelector('.label').textContent);
    app.state.schemaFilter.value = 'events';
    renderSchema(app);
    app.state.schemaFilter.value = '';
    renderSchema(app);
    const after = rows(app).map((r) => r.querySelector('.label').textContent);
    expect(after).toEqual(before);
  });

  it('a non-matching filter renders exactly one empty-search message and no database rows', () => {
    const app = withSearchSchema();
    app.state.schemaFilter.value = 'nope-nothing-matches';
    renderSchema(app);
    expect(app.dom.schemaList.textContent).toBe('No matching databases, tables, or columns.');
    expect(rows(app).length).toBe(0);
  });

  it('matching is case-insensitive and trims surrounding whitespace', () => {
    const app = withSearchSchema();
    app.state.schemaFilter.value = '  ANALYTICS  ';
    renderSchema(app);
    const labels = rows(app).map((r) => r.querySelector('.label').textContent);
    expect(labels).toContain('analytics');
  });

  it('regression: a row click during an active search still updates persisted expansion', () => {
    const app = withSearchSchema();
    app.state.schemaFilter.value = 'analytics';
    renderSchema(app);
    const usersRow = rows(app).find((r) => r.querySelector('.label').textContent === 'users');
    click(usersRow);
    expect(app.state.expanded.value.has('tb:analytics.users')).toBe(true);
  });

  // Clicking a row that a search cascade already forces open ends at the same
  // *final* chevron rotation with or without the flip animation running (the
  // reset-then-restore both land back on "open"), so asserting on the final
  // `.style.transform` can't tell a fixed skip apart from the original flash
  // bug. Spy on the `.chev`'s `offsetHeight` getter instead — flipChevron only
  // reads it to force the reflow that makes the animation's "from" state
  // commit — so whether that read happens is a direct proxy for whether the
  // (needless, flash-causing) animation ran at all.
  it('clicking a db row shown open only via a search match skips the chevron flip (no flash), but still updates persisted state', () => {
    const app = withSearchSchema();
    app.state.schemaFilter.value = 'analytics';
    renderSchema(app);
    const dbRow = rows(app).find((r) => r.querySelector('.label').textContent === 'analytics');
    const chev = dbRow.querySelector('.chev');
    let reflowRead = false;
    Object.defineProperty(chev, 'offsetHeight', { get: () => { reflowRead = true; return 0; } });
    click(dbRow);
    expect(reflowRead).toBe(false);
    expect(app.state.expanded.value.has('db:analytics')).toBe(true);
  });

  it('clicking a table row shown open only via its own search match skips the flip; one shown only via its db\'s match still animates', () => {
    const app = withSearchSchema();
    app.state.schemaFilter.value = 'events'; // direct table-name match
    renderSchema(app);
    const eventsRow = rows(app).find((r) => r.querySelector('.label').textContent === 'events');
    const eventsChev = eventsRow.querySelector('.chev');
    let eventsReflow = false;
    Object.defineProperty(eventsChev, 'offsetHeight', { get: () => { eventsReflow = true; return 0; } });
    click(eventsRow);
    expect(eventsReflow).toBe(false);

    app.state.schemaFilter.value = 'analytics'; // 'users' included only via the db match
    renderSchema(app);
    const usersRow = rows(app).find((r) => r.querySelector('.label').textContent === 'users');
    const usersChev = usersRow.querySelector('.chev');
    let usersReflow = false;
    Object.defineProperty(usersChev, 'offsetHeight', { get: () => { usersReflow = true; return 0; } });
    click(usersRow);
    expect(usersReflow).toBe(true); // not cascade-forced by its own match — flips normally
  });

  it('regression: drag still works on a table row revealed only by its db match', () => {
    const app = withSearchSchema();
    app.state.schemaFilter.value = 'analytics';
    renderSchema(app);
    const eventsRow = rows(app).find((r) => r.querySelector('.label').textContent === 'events');
    const d = dragstart(eventsRow);
    expect(d[IDENT_MIME]).toBe('analytics.events');
  });

  it('regression: mobile mode still drops draggable/title on rows revealed only by search', () => {
    const app = withSearchSchema();
    app.state.isMobile.value = true;
    app.state.schemaFilter.value = 'analytics';
    renderSchema(app);
    const eventsRow = rows(app).find((r) => r.querySelector('.label').textContent === 'events');
    expect(eventsRow.getAttribute('draggable')).toBeNull();
    expect(eventsRow.getAttribute('title')).toBeNull();
  });
});
