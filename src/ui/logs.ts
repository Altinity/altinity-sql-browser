// The dashboard's logs tile view (#149 D9): a compact, scroll-only reading
// surface for log-shaped results. Deliberately inert next to renderGrid —
// no sorting, no column resize; rows render in query order. Row shaping /
// level classification is pure in core/logs.js; this is the thin DOM wrapper.
// #332: when the caller (the dashboard) supplies `onCell`, each field becomes
// a clickable/keyboard-reachable cell-detail target that opens the drawer
// with the field's raw (untruncated) value — absent, the tile stays as inert
// as before.

import { h } from './dom.js';
import { truncationFooter } from './grid-render.js';
import { logRowDisplay } from '../core/logs.js';
import type { LogColumn, LogsShape, LogField } from '../core/logs.js';

/** `renderLogs`'s argument bag. `onCell` is the dashboard's `openCellDetail`
 *  (see ui/results.js's hooks) — when omitted, fields render as plain,
 *  non-interactive spans (today's behavior). */
export interface RenderLogsArgs {
  columns: LogColumn[];
  rows: unknown[][];
  shape: LogsShape;
  cap: number;
  onCell?: (name: string, type: string, value: unknown) => void;
}

/**
 * Build one clickable log field: a `span.<cls> log-cell` with `field.display`
 * text, `role="button"`/`tabindex="0"`, and a `title`/`aria-label` that
 * includes the source column name (`"<name>: <display>"`) so the accessible
 * name always identifies which field was activated. `onclick` first checks
 * for an active (non-collapsed, non-empty) text selection — a drag-select
 * over the row must not also fire a cell-detail open — then calls
 * `onCell(name, type, raw)` with the RAW (untruncated) value, never the
 * display string. `onkeydown` treats Enter/Space as activation (preventing
 * the Space's default scroll), any other key is a no-op.
 */
function logCell(field: LogField, cls: string, onCell: (name: string, type: string, value: unknown) => void): HTMLElement {
  return h('span', {
    class: cls + ' log-cell',
    role: 'button',
    tabindex: '0',
    title: field.name + ': ' + field.display,
    'aria-label': field.name + ': ' + field.display,
    onclick: (e: MouseEvent) => {
      const el = e.currentTarget as HTMLElement;
      const sel = el.ownerDocument.getSelection();
      if (sel && !sel.isCollapsed && String(sel)) return;
      onCell(field.name, field.type, field.raw);
    },
    onkeydown: (e: KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onCell(field.name, field.type, field.raw);
      }
    },
  }, field.display);
}

/**
 * Render a `.dash-logs` element: one `div.log-row.log-<levelClass>` per row
 * (first `cap` rows, query order verbatim) holding a time field, an optional
 * level field (omitted entirely when the shape has no level column), a
 * message field, and a trailing `span.log-extras` (omitted when a row has
 * none). Without `onCell`, each field is a plain text span and extras render
 * as one dimmed `span.log-extras` of `name=display` pairs joined by ' ' —
 * unchanged from before #332. With `onCell`, every field (time/level/msg,
 * and each extra individually) becomes an interactive `logCell` target inside
 * `span.log-extras` (extras are not folded into one string, so each
 * source-backed extra stays independently clickable). When `rows.length >
 * cap`, appends the same in-body "+N more rows truncated for display" footer
 * as renderGrid.
 */
export function renderLogs({ columns, rows, shape, cap, onCell }: RenderLogsArgs): HTMLDivElement {
  const box = h('div', { class: 'dash-logs' });
  rows.slice(0, cap).forEach((row) => {
    const d = logRowDisplay(columns, row, shape);
    let extrasNode: HTMLElement | null = null;
    if (d.extras.length) {
      extrasNode = onCell
        ? h('span', { class: 'log-extras' }, ...d.extras.flatMap((e, i) => i === 0
          ? [logCell(e, 'log-extra', onCell)]
          : [' ', logCell(e, 'log-extra', onCell)]))
        : h('span', { class: 'log-extras' }, d.extras.map((e) => e.name + '=' + e.display).join(' '));
    }
    box.appendChild(h('div', { class: 'log-row' + (d.levelClass ? ' log-' + d.levelClass : '') },
      onCell ? logCell(d.time, 'log-time', onCell) : h('span', { class: 'log-time' }, d.time.display),
      shape.level == null ? null : (onCell ? logCell(d.level as LogField, 'log-level', onCell) : h('span', { class: 'log-level' }, (d.level as LogField).display)),
      onCell ? logCell(d.msg, 'log-msg', onCell) : h('span', { class: 'log-msg' }, d.msg.display),
      extrasNode));
  });
  if (rows.length > cap) box.appendChild(truncationFooter(rows.length - cap));
  return box;
}
