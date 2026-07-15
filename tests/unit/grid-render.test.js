import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderGrid, renderGridView, colResizeWidth, resizeHandle, reapplyWidths, PLAIN_KEY, GRID_VIS_CAP, visCap, truncationFooter } from '../../src/ui/grid-render.js';
import { h } from '../../src/ui/dom.js';

const click = (el) => el.dispatchEvent(new Event('click', { bubbles: true }));

const COLS = [{ name: 'n', type: 'UInt64' }, { name: 's', type: 'String' }];
const ROWS = [['2', 'b'], ['1', null]];
const noSort = () => ({ col: null, dir: 'asc' });
const gridArgs = (over = {}) => ({
  columns: COLS, rows: ROWS, sort: noSort(), onSort: vi.fn(), widths: {}, onCell: vi.fn(), ...over,
});

afterEach(() => { document.body.replaceChildren(); });

describe('visCap', () => {
  it('follows the result row limit, else the 5000 fallback', () => {
    expect(visCap({ rowLimit: 10000 })).toBe(10000);
    expect(visCap({ rowLimit: 0 })).toBe(5000);
  });
});

describe('truncationFooter', () => {
  it('renders the shared "+N more rows" note', () => {
    expect(truncationFooter(42).textContent).toBe('… + 42 more rows truncated for display.');
  });
});

describe('colResizeWidth', () => {
  it('converts client px via scale and clamps to the floor', () => {
    expect(colResizeWidth(100, 50, 1)).toBe(150);
    expect(colResizeWidth(100, -90, 1)).toBe(48);    // floored at MIN_COL
    expect(colResizeWidth(100, 120, 1.2)).toBe(200); // zoom: 100 + 120/1.2
    expect(colResizeWidth(100, 0, 0)).toBe(100);     // scale 0 → /1
    expect(colResizeWidth(100, 0, NaN)).toBe(100);   // NaN → /1
  });
});

describe('renderGrid', () => {
  it('renders headers (type on hover only), a row-number column, numeric cells, and empty NULLs', () => {
    const el = renderGrid(gridArgs());
    const ths = el.querySelectorAll('thead th');
    expect(ths[0].textContent).toBe('#');
    expect(ths[1].querySelector('.h-name').textContent).toBe('n');
    expect(ths[1].textContent).not.toContain('UInt64'); // type not rendered inline
    expect(ths[1].getAttribute('title')).toBe('UInt64'); // exposed on hover
    expect(el.querySelector('td.idx').textContent).toBe('1');
    expect(el.querySelector('td.num')).not.toBeNull(); // UInt64 column
    const cells = el.querySelectorAll('tbody tr')[1].querySelectorAll('td.cell');
    expect(cells[1].textContent).toBe(''); // null renders empty
  });
  it('renders an object-shaped cell value (named tuple as object) as JSON, not "[object Object]"', () => {
    const el = renderGrid(gridArgs({
      columns: [{ name: 'db', type: 'Array(Tuple(value String, label String))' }],
      rows: [[[{ value: 'a', label: 'A' }]]],
    }));
    expect(el.querySelector('td.cell').textContent).toBe('[{"value":"a","label":"A"}]');
  });
  it('a column without a type gets an empty hover title and no num class', () => {
    const el = renderGrid(gridArgs({ columns: [{ name: 'x' }], rows: [['a']] }));
    expect(el.querySelectorAll('thead th')[1].getAttribute('title')).toBe('');
    expect(el.querySelector('td.num')).toBeNull();
  });
  it('sorts rows by the sort state and marks the active header (asc and desc icons)', () => {
    const asc = renderGrid(gridArgs({ sort: { col: 0, dir: 'asc' } }));
    expect(asc.querySelector('tbody td.cell').textContent).toBe('1');
    expect(asc.querySelector('.h-sort')).not.toBeNull();
    const desc = renderGrid(gridArgs({ sort: { col: 0, dir: 'desc' } }));
    expect(desc.querySelector('tbody td.cell').textContent).toBe('2');
    expect(desc.querySelector('.h-sort')).not.toBeNull();
  });
  it('header click reports asc for a new column, and toggles asc → desc → asc on the active one', () => {
    const onSort = vi.fn();
    click(renderGrid(gridArgs({ onSort })).querySelectorAll('thead th')[1]);
    expect(onSort).toHaveBeenLastCalledWith(0, 'asc');
    click(renderGrid(gridArgs({ onSort, sort: { col: 0, dir: 'asc' } })).querySelectorAll('thead th')[1]);
    expect(onSort).toHaveBeenLastCalledWith(0, 'desc');
    click(renderGrid(gridArgs({ onSort, sort: { col: 0, dir: 'desc' } })).querySelectorAll('thead th')[1]);
    expect(onSort).toHaveBeenLastCalledWith(0, 'asc');
    expect(onSort).toHaveBeenCalledTimes(3);
  });
  it('cell click forwards name/type/value to onCell', () => {
    const onCell = vi.fn();
    click(renderGrid(gridArgs({ onCell })).querySelector('tbody td.cell'));
    expect(onCell).toHaveBeenCalledWith('n', 'UInt64', '2');
  });
  it('omitting onCell leaves cell clicks inert (no throw)', () => {
    const el = renderGrid(gridArgs({ onCell: undefined }));
    expect(() => click(el.querySelector('tbody td.cell'))).not.toThrow();
  });
  it('caps displayed rows (default 5000, or an explicit cap) with a truncation note', () => {
    const many = Array.from({ length: GRID_VIS_CAP + 1 }, (_, i) => [String(i)]);
    const el = renderGrid(gridArgs({ columns: [{ name: 'n', type: 'UInt64' }], rows: many }));
    expect(el.querySelectorAll('tbody tr')).toHaveLength(GRID_VIS_CAP);
    expect(el.textContent).toContain('+ 1 more rows truncated');
    const capped = renderGrid(gridArgs({ cap: 1 }));
    expect(capped.querySelectorAll('tbody tr')).toHaveLength(1);
    expect(capped.textContent).toContain('+ 1 more rows truncated');
  });
  it('reapplies stored widths (fixed layout) on render', () => {
    const el = renderGrid(gridArgs({ widths: { idx: 36, 0: 90, 1: 70 } }));
    const table = el.querySelector('.res-table');
    expect(table.classList.contains('fixed')).toBe(true);
    const cells = table.querySelectorAll('thead th');
    expect(cells[1].style.width).toBe('90px');
    expect(cells[2].style.width).toBe('70px');
    expect(table.style.width).toBe('196px'); // 36 + 90 + 70
  });
});

describe('column resize', () => {
  const mountGrid = (widths, over = {}) => {
    const el = renderGrid(gridArgs({ widths, ...over }));
    document.body.appendChild(el);
    return el;
  };
  it('puts a resize handle on each data column; the handle click does not sort', () => {
    const onSort = vi.fn();
    const el = mountGrid({}, { onSort });
    const handles = el.querySelectorAll('th .col-resize-h');
    expect(handles).toHaveLength(2); // one per data column, none on the '#' column
    handles[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onSort).not.toHaveBeenCalled(); // stopPropagation → no sort
  });
  it('first drag freezes the layout (measures every column) and switches to fixed', () => {
    const widths = {};
    const el = mountGrid(widths);
    const handle = el.querySelectorAll('th .col-resize-h')[0];
    handle.dispatchEvent(new MouseEvent('mousedown', { clientX: 200, bubbles: true }));
    expect(el.querySelector('.res-table').classList.contains('fixed')).toBe(true);
    expect(Object.keys(widths).sort()).toEqual(['0', '1', 'idx']); // every column measured
    window.dispatchEvent(new MouseEvent('mouseup', {}));
  });
  it('splitter model: dragging a border grows the column and shrinks its neighbor (total constant)', () => {
    const widths = { idx: 36, 0: 100, 1: 100 }; // pre-seeded so the pair math is meaningful
    const el = mountGrid(widths);
    const handle = el.querySelectorAll('th .col-resize-h')[0]; // col 0, neighbor col 1
    handle.dispatchEvent(new MouseEvent('mousedown', { clientX: 100, bubbles: true }));
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 130 })); // +30
    expect(widths[0]).toBe(130);
    expect(widths[1]).toBe(70); // neighbor gave up 30 — pair sum stays 200
    // drag past the neighbor's floor: neighbor clamps at MIN_COL (48), column caps
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 999 }));
    expect(widths[1]).toBe(48);
    expect(widths[0]).toBe(152); // 200 - 48
    window.dispatchEvent(new MouseEvent('mouseup', {}));
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 0 }));
    expect(widths[0]).toBe(152); // listeners removed on mouseup
  });
  it('dragging the last column has no neighbor, so it grows the table', () => {
    const widths = { idx: 36, 0: 100, 1: 100 };
    const el = mountGrid(widths);
    const handle = el.querySelectorAll('th .col-resize-h')[1]; // last data column
    handle.dispatchEvent(new MouseEvent('mousedown', { clientX: 100, bubbles: true }));
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 150 })); // +50
    expect(widths[1]).toBe(150);
    expect(widths[0]).toBe(100); // unchanged — no redistribution
    window.dispatchEvent(new MouseEvent('mouseup', {}));
  });
  it('resizeHandle + reapplyWidths drive a script-grid-shaped table (PLAIN_KEY: no row-number column)', () => {
    // A script-grid-shaped table: headers key by their own index.
    const widths = { 0: 50, 1: 60 };
    const ths = [
      h('th', null, 'a', resizeHandle(widths, PLAIN_KEY)),
      h('th', null, 'b', resizeHandle(widths, PLAIN_KEY)),
    ];
    const table = h('table', null, h('thead', null, h('tr', null, ths)));
    document.body.appendChild(table);
    reapplyWidths(table, widths, PLAIN_KEY);
    expect(table.classList.contains('fixed')).toBe(true);
    expect(ths[0].style.width).toBe('50px');
    expect(table.style.width).toBe('110px');
    ths[0].querySelector('.col-resize-h').dispatchEvent(new MouseEvent('mousedown', { clientX: 100, bubbles: true }));
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 110 })); // +10
    expect(widths[0]).toBe(60);
    expect(widths[1]).toBe(50); // splitter model holds for PLAIN_KEY too
    window.dispatchEvent(new MouseEvent('mouseup', {}));
  });
  it('reapplyWidths is a no-op until a first resize populates widths', () => {
    const table = h('table', null, h('thead', null, h('tr', null, h('th', null, 'a'))));
    reapplyWidths(table, {}, PLAIN_KEY);
    expect(table.classList.contains('fixed')).toBe(false);
  });
});

describe('renderGridView (the state-wiring adapter)', () => {
  it('a sort click calls setSort exactly once with {col, dir}, then rerender', () => {
    const calls = [];
    const el = renderGridView({
      columns: COLS, rows: ROWS,
      sort: noSort(),
      setSort: (next) => calls.push(['setSort', next]),
      widths: {},
      rerender: () => calls.push(['rerender']),
      onCell: vi.fn(),
    });
    click(el.querySelectorAll('thead th')[1]);
    expect(calls).toEqual([['setSort', { col: 0, dir: 'asc' }], ['rerender']]); // once each, state before repaint
  });
  it('toggle values from the grid reach setSort (asc → desc on the active column)', () => {
    const setSort = vi.fn();
    const el = renderGridView({
      columns: COLS, rows: ROWS,
      sort: { col: 1, dir: 'asc' },
      setSort, widths: {}, rerender: vi.fn(), onCell: vi.fn(),
    });
    click(el.querySelectorAll('thead th')[2]); // the active column
    expect(setSort).toHaveBeenCalledWith({ col: 1, dir: 'desc' });
  });
  it('forwards the same widths object (drag mutations land in the caller holder) and onCell/cap unchanged', () => {
    const widths = {};
    const onCell = vi.fn();
    const el = renderGridView({
      columns: COLS, rows: ROWS, sort: noSort(),
      setSort: vi.fn(), widths, rerender: vi.fn(), onCell, cap: 1,
    });
    document.body.appendChild(el);
    expect(el.querySelectorAll('tbody tr')).toHaveLength(1); // cap forwarded
    expect(el.textContent).toContain('+ 1 more rows truncated');
    click(el.querySelector('tbody td.cell'));
    expect(onCell).toHaveBeenCalledWith('n', 'UInt64', '2'); // onCell forwarded
    el.querySelector('th .col-resize-h').dispatchEvent(new MouseEvent('mousedown', { clientX: 100, bubbles: true }));
    expect(Object.keys(widths).sort()).toEqual(['0', '1', 'idx']); // the caller's own object was mutated
    window.dispatchEvent(new MouseEvent('mouseup', {}));
  });
  it('omitting cap falls back to the grid default', () => {
    const many = Array.from({ length: GRID_VIS_CAP + 1 }, (_, i) => [String(i)]);
    const el = renderGridView({
      columns: [{ name: 'n', type: 'UInt64' }], rows: many, sort: noSort(),
      setSort: vi.fn(), widths: {}, rerender: vi.fn(), onCell: vi.fn(),
    });
    expect(el.querySelectorAll('tbody tr')).toHaveLength(GRID_VIS_CAP);
  });
});
