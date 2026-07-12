// The dashboard's logs tile view (#149 D9): a compact, scroll-only reading
// surface for log-shaped results. Deliberately inert next to renderGrid —
// no sorting, no column resize; rows render in query order. Row shaping /
// level classification is pure in core/logs.js; this is the thin DOM wrapper.

import { h } from './dom.js';
import { truncationFooter } from './grid-render.js';
import { logRowDisplay } from '../core/logs.js';

/**
 * Render a `.dash-logs` element: one `div.log-row.log-<levelClass>` per row
 * (first `cap` rows, query order verbatim) holding `span.log-time`,
 * `span.log-level` (omitted entirely when the shape has no level column),
 * `span.log-msg`, and a trailing dimmed `span.log-extras` of key=value pairs
 * (omitted when a row has none). When `rows.length > cap`, appends the same
 * in-body "+N more rows truncated for display" footer as renderGrid.
 */
export function renderLogs({ columns, rows, shape, cap }) {
  const box = h('div', { class: 'dash-logs' });
  rows.slice(0, cap).forEach((row) => {
    const d = logRowDisplay(columns, row, shape);
    box.appendChild(h('div', { class: 'log-row' + (d.levelClass ? ' log-' + d.levelClass : '') },
      h('span', { class: 'log-time' }, d.time),
      shape.level == null ? null : h('span', { class: 'log-level' }, d.level),
      h('span', { class: 'log-msg' }, d.msg),
      d.extras.length
        ? h('span', { class: 'log-extras' }, d.extras.map((e) => e.name + '=' + e.value).join(' '))
        : null));
  });
  if (rows.length > cap) box.appendChild(truncationFooter(rows.length - cap));
  return box;
}
