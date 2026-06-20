import { describe, it, expect } from 'vitest';
import { renderSchema } from '../../src/ui/schema.js';
import { IDENT_MIME } from '../../src/ui/editor.js';
import { makeApp } from '../helpers/fake-app.js';

const rows = (app) => [...app.dom.schemaList.querySelectorAll('.tree-row')];
const click = (el) => el.dispatchEvent(new Event('click', { bubbles: true }));
const shiftClick = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
const dblclick = (el) => el.dispatchEvent(new Event('dblclick', { bubbles: true }));
// Fire a dragstart with a stub dataTransfer and return what setData captured.
const dragstart = (el) => {
  const e = new Event('dragstart', { bubbles: true });
  let captured = null;
  e.dataTransfer = { setData: (mime, value) => { captured = { mime, value }; } };
  el.dispatchEvent(e);
  return captured;
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
  it('double-clicking a table inserts a SELECT * as a top line', () => {
    const app = withSchema();
    renderSchema(app);
    const ordersRow = rows(app).find((r) => r.querySelector('.label').textContent === 'orders');
    dblclick(ordersRow);
    expect(app.actions.insertTopLine).toHaveBeenCalledWith('SELECT * FROM db1.orders LIMIT 100');
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
  it('columns: plain click inserts nothing; double-click inserts name; shift-click inserts ::type', () => {
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
    expect(app.actions.insertAtCursor).not.toHaveBeenCalled(); // single click does nothing
    dblclick(colRow);
    expect(app.actions.insertAtCursor).toHaveBeenCalledWith('id');
    shiftClick(colRow);
    expect(app.actions.insertAtCursor).toHaveBeenCalledWith('id::UInt64');
  });
});

describe('renderSchema drag sources', () => {
  it('dragging a db carries the bare database name', () => {
    const app = withSchema();
    renderSchema(app);
    const dbRow = rows(app).find((r) => r.querySelector('.label').textContent === 'db1');
    expect(dragstart(dbRow)).toEqual({ mime: IDENT_MIME, value: 'db1' });
  });
  it('dragging a table carries the qualified name', () => {
    const app = withSchema();
    renderSchema(app);
    const ordersRow = rows(app).find((r) => r.querySelector('.label').textContent === 'orders');
    expect(dragstart(ordersRow)).toEqual({ mime: IDENT_MIME, value: 'db1.orders' });
  });
  it('dragging a column carries the bare column name', () => {
    const app = withSchema();
    app.state.schema[0].tables[0].columns = [{ name: 'id', type: 'UInt64', comment: '' }];
    app.state.expandedTables.add('db1.orders');
    renderSchema(app);
    const colRow = [...app.dom.schemaList.querySelectorAll('.tree-row.small')]
      .find((r) => r.querySelector('.label').textContent === 'id');
    expect(dragstart(colRow)).toEqual({ mime: IDENT_MIME, value: 'id' });
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
