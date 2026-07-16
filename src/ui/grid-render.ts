// The shared sortable + resizable data grid: the stateless renderer
// (renderGrid), the column-resize primitives it and the script grids share,
// and the thin state-wiring adapter (renderGridView) that every grid consumer
// uses so sort-update + repaint isn't hand-rolled per surface (#167). This
// module owns no state and never imports from results.js — sort/width
// holders, repaint scope, and cell-detail handling are all caller seams.

import { h } from './dom.js';
import { Icon } from './icons.js';
import { isNumericType, truncate } from '../core/format.js';
import { sortRows } from '../core/sort.js';
import type { ResultSort } from '../state.js';

export const GRID_VIS_CAP = 5000; // fallback display cap for results that carry no row limit (raw / EXPLAIN)
const MIN_COL = 48; // px floor for a resized column

/** A grid column descriptor — `type` is optional because the script grids
 *  (results.js's side pane) can carry columns with no ClickHouse type at all. */
export interface GridColumn {
  name: string;
  type?: string;
}

/** A `widths` holder key: 'idx' for the data grid's row-number column, else a
 *  0-based data-column index (IDX_KEY), or the cell's own index unchanged
 *  (PLAIN_KEY, script grids with no row-number column). */
export type WidthKey = string | number;
export type KeyOf = (cellIndex: number) => WidthKey;
/** A colWidths holder, mutated in place by drag-resize. */
export type Widths = Record<string, number>;

/**
 * How many rows to render: follow the result's own row cap when set (so a 10000
 * limit renders 10000), else the grid's fixed fallback. The server cap already
 * trims a normal SELECT to its limit, so this just keeps the renderers from
 * re-capping a large-but-allowed result. Pure — exported for tests.
 */
export function visCap(r: { rowLimit: number }): number {
  return r.rowLimit > 0 ? r.rowLimit : GRID_VIS_CAP;
}

/**
 * In-body "+N more rows truncated for display" footer, shared by every capped
 * row view (renderGrid here, the dashboard's logs view) so the wording and
 * styling can't drift between adjacent surfaces.
 */
export function truncationFooter(hidden: number): HTMLDivElement {
  return h('div', {
    style: { padding: '10px 14px', fontSize: '11px', color: 'var(--fg-faint)', fontFamily: 'var(--mono)', borderTop: '1px solid var(--border)' },
  }, '… + ' + hidden + ' more rows truncated for display.');
}

/**
 * New width (px) for a column dragged by `dx` native client px. Clamped to
 * MIN_COL. Pure — exported for tests.
 */
export function colResizeWidth(startW: number, dx: number): number {
  return Math.max(MIN_COL, Math.round(startW + dx));
}

// Map a header cell index to its `widths` key. The data grid's first cell is
// the row-number column ('idx'); its data columns are then 0-based. The script
// grids have no row-number column, so every cell keys by its own index.
const IDX_KEY: KeyOf = (k) => (k === 0 ? 'idx' : k - 1);
export const PLAIN_KEY: KeyOf = (k) => k;

/**
 * Pin every column of `table` to the px widths in `widths` (keyed via
 * `keyOf(cellIndex)`) and switch it to fixed layout so columns honor those widths
 * exactly (and the wrap scrolls). Shared by the data grid and the script grids.
 */
function applyFixedWidths(table: HTMLTableElement, widths: Widths, keyOf: KeyOf): void {
  table.classList.add('fixed');
  const cells = table.querySelectorAll<HTMLTableCellElement>('thead th');
  let total = 0;
  for (let k = 0; k < cells.length; k++) {
    const w = widths[keyOf(k)];
    cells[k].style.width = w + 'px';
    total += w;
  }
  table.style.width = total + 'px';
  table.style.minWidth = '0';
}

/**
 * Begin dragging the right edge of header `th` to resize its column. `keyOf` maps
 * a cell index to its `widths` key (see IDX_KEY / PLAIN_KEY).
 *
 * Splitter model: the drag moves the *border* between this column and its right
 * neighbor — the column grows and the neighbor shrinks by the same amount, so the
 * table's total width (and every other column) stays put. Dragging the last
 * column's edge has no neighbor to take from, so it grows the table (scroll).
 */
function startColumnResize(widths: Widths, th: HTMLTableCellElement, ev: MouseEvent, keyOf: KeyOf): void {
  ev.preventDefault();
  ev.stopPropagation(); // don't let the handle's mousedown reach the sort header
  // `!`: startColumnResize is only ever reached from a resize handle appended
  // inside a `<th>` inside a `<table>` (resizeHandle/renderGrid below).
  const table = th.closest('table')!;
  const cells = table.querySelectorAll<HTMLTableCellElement>('thead th');
  const cellIdx = Array.from(cells).indexOf(th);
  const colIndex = keyOf(cellIdx);
  const nextKey = cellIdx + 1 < cells.length ? keyOf(cellIdx + 1) : null;
  // First resize: freeze every column at its current rendered width, then fix.
  if (!Object.keys(widths).length) {
    for (let k = 0; k < cells.length; k++) {
      widths[keyOf(k)] = cells[k].offsetWidth;
    }
  }
  applyFixedWidths(table, widths, keyOf);
  // `!`: a `<th>` built and appended by this module always has a live
  // ownerDocument attached to a window (the main document, or the detached
  // schema/data-pane tab's own document — never a bare, window-less document).
  const win = th.ownerDocument.defaultView!;
  const startX = ev.clientX;
  const startW = widths[colIndex];
  const pairW = nextKey != null ? startW + widths[nextKey] : 0; // combined width of the pair
  const onMove = (m: MouseEvent): void => {
    let w = colResizeWidth(startW, m.clientX - startX);
    if (nextKey != null) {
      // Keep the pair's combined width constant; both stay ≥ MIN_COL (a pair
      // narrower than 2·MIN_COL can't satisfy both — the floor wins over total).
      w = Math.max(MIN_COL, Math.min(w, pairW - MIN_COL));
      widths[nextKey] = Math.max(MIN_COL, pairW - w);
    }
    widths[colIndex] = w;
    applyFixedWidths(table, widths, keyOf);
  };
  const onUp = (): void => {
    win.removeEventListener('mousemove', onMove);
    win.removeEventListener('mouseup', onUp);
  };
  win.addEventListener('mousemove', onMove);
  win.addEventListener('mouseup', onUp);
}

/**
 * The drag handle for one column header: mousedown starts the resize, and the
 * trailing click is swallowed so it never reaches the header's own handlers
 * (sort, in the data grid). The one resize-wiring block every grid shares —
 * the data grid appends it per header below; the script grids in results.js
 * append it with PLAIN_KEY.
 */
export function resizeHandle(widths: Widths, keyOf: KeyOf): HTMLSpanElement {
  return h('span', {
    class: 'col-resize-h',
    title: 'Drag to resize column',
    onmousedown: (e: MouseEvent) => startColumnResize(widths, (e.currentTarget as HTMLElement).closest('th')!, e, keyOf),
    onclick: (e: Event) => e.stopPropagation(),
  });
}

/**
 * Re-pin previously drag-resized columns on a fresh render: a no-op until the
 * first resize populates `widths` (auto layout), fixed layout after.
 */
export function reapplyWidths(table: HTMLTableElement, widths: Widths, keyOf: KeyOf): void {
  if (Object.keys(widths).length) applyFixedWidths(table, widths, keyOf);
}

/** `renderGrid`'s argument bag. */
export interface RenderGridArgs {
  columns: GridColumn[];
  rows: unknown[][];
  sort: ResultSort;
  onSort: (col: number, dir: 'asc' | 'desc') => void;
  widths: Widths;
  onCell?: (name: string, type: string, value: unknown) => void;
  cap?: number;
}

/**
 * Shared sortable + resizable data grid (the one table view, reused by the main
 * results table, the script-row side pane, and the detached Data pane). Caller
 * supplies the data plus the state seams so the same DOM/interaction code drives
 * all of them:
 *   { columns, rows, sort:{col,dir}, onSort(col,dir), widths, onCell(name,type,value) }
 * `widths` is a colWidths object mutated in place (drag-resize); `onSort` re-renders
 * for the caller (global results effect, or a local repaint). `cap` is the display
 * row cap (the main table passes the selectable result-row limit; the rows pane
 * leaves the default). Stateless: renders exactly its inputs, owns no holders.
 */
export function renderGrid({ columns, rows: rawRows, sort, onSort, widths, onCell, cap = GRID_VIS_CAP }: RenderGridArgs): HTMLElement {
  const { col, dir } = sort;
  const rows = sortRows(rawRows, col, dir);
  const wrap = h('div', { class: 'res-table-wrap' });
  const table = h('table', { class: 'res-table' });

  const trh = h('tr', null);
  trh.appendChild(h('th', { style: { textAlign: 'center', color: 'var(--fg-faint)', minWidth: '36px' } }, '#'));
  columns.forEach((c, i) => {
    const isSort = col === i;
    const th = h('th', {
      title: c.type || '', // type exposed on hover, not shown inline
      onclick: () => onSort(i, isSort && dir === 'asc' ? 'desc' : 'asc'),
    }, h('div', { class: 'h-inner' },
      h('span', { class: 'h-name' }, c.name),
      h('span', { style: { flex: '1' } }),
      isSort ? h('span', { class: 'h-sort' }, dir === 'asc' ? Icon.sortAsc() : Icon.sortDesc()) : null),
      resizeHandle(widths, IDX_KEY));
    trh.appendChild(th);
  });
  const thead = h('thead', null);
  thead.appendChild(trh);
  table.appendChild(thead);
  reapplyWidths(table, widths, IDX_KEY);

  const tbody = h('tbody', null);
  rows.slice(0, cap).forEach((row, ri) => {
    const tr = h('tr', null);
    tr.appendChild(h('td', { class: 'idx' }, String(ri + 1)));
    row.forEach((v, ci) => {
      const isNum = isNumericType(columns[ci].type);
      // Named tuples/maps can arrive as plain objects (e.g. a Filter or KPI
      // query's owned execution profile requests
      // output_format_json_named_tuples_as_objects) — String(v) on those would
      // read as "[object Object]" instead of the value (same fix as logs.js).
      const text = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
      // Truncate in-cell (CSS max-width + ellipsis); click opens the full value
      // in a side drawer so one fat column (e.g. HTML blobs) can't dominate.
      // `onCell` is optional: a consumer with no cell-detail surface omits it
      // and cell clicks are inert rather than a TypeError.
      tr.appendChild(h('td', {
        class: 'cell' + (isNum ? ' num' : ''),
        title: truncate(text, 100),
        // `as`: onCell's contract (this module's + panels.ts's wrapper) always
        // carries a real column type; the only column that can omit `type` is
        // a hand-built test fixture that never wires a click handler.
        onclick: () => onCell && onCell(columns[ci].name, columns[ci].type as string, v),
      }, h('div', { class: 'cell-val' }, text)));
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  wrap.appendChild(table);
  if (rows.length > cap) wrap.appendChild(truncationFooter(rows.length - cap));
  return wrap;
}

/** `renderGridView`'s argument bag — the one grid state-wiring adapter's
 *  contract (also pinned, structurally, by panels.ts's own local wrapper type
 *  over this export). */
export interface RenderGridViewArgs {
  columns: GridColumn[];
  rows: unknown[][];
  sort: ResultSort;
  setSort: (next: ResultSort) => void;
  widths: Widths;
  rerender: () => void;
  onCell?: (name: string, type: string, value: unknown) => void;
  cap?: number;
}

/**
 * The one grid state-wiring adapter (#167): renderGrid plus the sort-update →
 * repaint choreography every consumer used to hand-roll. The caller still owns
 * everything stateful — where `sort`/`widths` live and for how long (`setSort`
 * writes back to the caller's holder), and what a repaint means (`rerender` is
 * the caller's scope: whole results region, drawer body, or detached-pane
 * view). `widths` passes through by reference so drag-resize mutations land in
 * the caller's holder unchanged. No network, no app actions, no policy.
 */
export function renderGridView({ columns, rows, sort, setSort, widths, rerender, onCell, cap }: RenderGridViewArgs): HTMLElement {
  return renderGrid({
    columns,
    rows,
    sort,
    onSort: (col, dir) => { setSort({ col, dir }); rerender(); },
    widths,
    onCell,
    cap,
  });
}
