import { describe, it, expect, vi } from 'vitest';
import { renderSchema } from '../../src/ui/schema.js';
import { IDENT_MIME, SCHEMA_GRAPH_MIME } from '../../src/ui/editor.js';
import { makeApp } from '../helpers/fake-app.js';

const rows = (app) => [...app.dom.schemaList.querySelectorAll('.tree-row')];
const click = (el) => el.dispatchEvent(new Event('click', { bubbles: true }));
const shiftClick = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
// A double-click is two quick clicks on the same row — the app detects it itself
// rather than via the native `dblclick` event (which Firefox drops when the row
// re-renders between clicks). Clicking the same captured node twice works even
// though the first click detaches it: the listener + per-app state still fire.
const dblclick = (el) => { click(el); click(el); };
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
  app.state.schema = [
    {
      db: 'db1',
      expanded: true,
      tables: [
        { name: 'orders', total_rows: '1000', total_bytes: '2000', comment: 'the orders', columns: null },
        { name: 'events', total_rows: '5', total_bytes: '9', comment: '', columns: null },
      ],
    },
    { db: 'db2', expanded: false, tables: [{ name: 't', total_rows: '1', total_bytes: '1', comment: '', columns: null }] },
  ];
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
    app.state.schemaError = 'bad';
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
    app.state.schema = [];
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
  it('clicking a db toggles expansion', () => {
    const app = withSchema();
    renderSchema(app);
    const db2Row = rows(app).find((r) => r.querySelector('.label').textContent === 'db2');
    click(db2Row);
    expect(app.state.schema[1].expanded).toBe(true);
  });
  it('shift-clicking a db inserts its formatted DDL without expanding', () => {
    const app = withSchema();
    renderSchema(app);
    const db2Row = rows(app).find((r) => r.querySelector('.label').textContent === 'db2');
    shiftClick(db2Row);
    expect(app.actions.insertCreate).toHaveBeenCalledWith('DATABASE db2');
    expect(app.state.schema[1].expanded).toBe(false);
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
    click(ordersRow);
    expect(app.state.expandedTables.has('db1.orders')).toBe(true);
    expect(app.actions.loadColumns).toHaveBeenCalledWith('db1', 'orders', expect.any(Object));
  });
  it('collapsing an already-loaded table just re-renders', () => {
    const app = withSchema();
    app.state.schema[0].tables[0].columns = [{ name: 'id', type: 'UInt64', comment: '' }];
    app.state.expandedTables.add('db1.orders');
    renderSchema(app);
    const ordersRow = rows(app).find((r) => r.querySelector('.label').textContent === 'orders');
    click(ordersRow); // collapse
    expect(app.state.expandedTables.has('db1.orders')).toBe(false);
  });
  it('double-clicking a table replaces the editor with a SELECT *', () => {
    const app = withSchema();
    renderSchema(app);
    const ordersRow = rows(app).find((r) => r.querySelector('.label').textContent === 'orders');
    dblclick(ordersRow);
    expect(app.actions.replaceEditor).toHaveBeenCalledWith('SELECT * FROM db1.orders LIMIT 100');
  });
  it('shift-clicking a table inserts its formatted DDL without expanding', () => {
    const app = withSchema();
    renderSchema(app);
    const eventsRow = rows(app).find((r) => r.querySelector('.label').textContent === 'events');
    shiftClick(eventsRow);
    expect(app.actions.insertCreate).toHaveBeenCalledWith('db1.events');
    expect(app.state.expandedTables.has('db1.events')).toBe(false);
    expect(app.actions.loadColumns).not.toHaveBeenCalled();
  });
  it('shows a loading row while columns load', () => {
    const app = withSchema();
    app.state.schema[0].tables[0].columns = 'loading';
    app.state.expandedTables.add('db1.orders');
    renderSchema(app);
    expect(app.dom.schemaList.textContent).toContain('loading columns…');
  });
  it('columns: a plain click inserts nothing, a quick repeat (double-click) inserts the name', () => {
    const app = withSchema();
    app.state.schema[0].tables[0].columns = [
      { name: 'id', type: 'UInt64', comment: 'pk' },     // comment → title branch
      { name: 'ts', type: 'DateTime', comment: '' },     // no comment → default title branch
    ];
    app.state.expandedTables.add('db1.orders');
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
    app.state.schema[0].tables[0].columns = [{ name: 'id', type: 'UInt64', comment: 'pk' }];
    app.state.expandedTables.add('db1.orders');
    renderSchema(app);
    const colRow = [...app.dom.schemaList.querySelectorAll('.tree-row.small')]
      .find((r) => r.querySelector('.label').textContent === 'id');
    shiftClick(colRow);
    expect(app.actions.insertAtCursor).toHaveBeenCalledWith('id::UInt64');
  });
  it('two quick clicks on different rows are two single clicks, not a double', () => {
    const app = withSchema();
    renderSchema(app);
    const db1Row = rows(app).find((r) => r.querySelector('.label').textContent === 'db1');
    const db2Row = rows(app).find((r) => r.querySelector('.label').textContent === 'db2');
    click(db1Row); // single: collapses db1
    click(db2Row); // different row → single: expands db2 (not an insert)
    expect(app.actions.insertAtCursor).not.toHaveBeenCalled();
    expect(app.state.schema[1].expanded).toBe(true);
  });
  it('a slow second click on the same row is a single click, not a double (window expired)', () => {
    vi.useFakeTimers();
    try {
      const app = withSchema();
      renderSchema(app);
      let db2Row = rows(app).find((r) => r.querySelector('.label').textContent === 'db2');
      click(db2Row); // expand db2
      expect(app.state.schema[1].expanded).toBe(true);
      vi.advanceTimersByTime(400); // past DBLCLICK_MS (300ms)
      db2Row = rows(app).find((r) => r.querySelector('.label').textContent === 'db2');
      click(db2Row); // expired → single → collapses db2, not an insert
      expect(app.actions.insertAtCursor).not.toHaveBeenCalled();
      expect(app.state.schema[1].expanded).toBe(false);
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
  it('dragging a column carries the bare column name', () => {
    const app = withSchema();
    app.state.schema[0].tables[0].columns = [{ name: 'id', type: 'UInt64', comment: '' }];
    app.state.expandedTables.add('db1.orders');
    renderSchema(app);
    const colRow = [...app.dom.schemaList.querySelectorAll('.tree-row.small')]
      .find((r) => r.querySelector('.label').textContent === 'id');
    const d = dragstart(colRow);
    expect(d[IDENT_MIME]).toBe('id');
    expect(d[SCHEMA_GRAPH_MIME]).toBeUndefined(); // columns aren't graph drag sources
  });
});

describe('renderSchema filter', () => {
  it('keeps matching tables and drops non-matching ones', () => {
    const app = withSchema();
    app.state.schemaFilter = 'order';
    renderSchema(app);
    const labels = rows(app).map((r) => r.querySelector('.label').textContent);
    expect(labels).toContain('orders');
    expect(labels).not.toContain('events');
  });
  it('reveals a table when one of its columns matches the filter', () => {
    const app = withSchema();
    app.state.schema[0].tables[1].columns = [{ name: 'user_id', type: 'UInt64', comment: '' }];
    app.state.schemaFilter = 'user_id';
    renderSchema(app);
    expect(app.dom.schemaList.textContent).toContain('user_id');
  });
});
