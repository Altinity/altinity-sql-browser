// The results pane: a view switcher (Table | JSON | Chart, or a single Raw
// view for TSV/JSON output) plus the renderers. Heavy logic (sorting, axis
// selection) lives in core/ and is reused here.

import { h, s } from './dom.js';
import { Icon } from './icons.js';
import { formatRows, formatBytes, isNumericType } from '../core/format.js';
import { looksLikeHtml, prettyValue } from '../core/cell.js';
import { sortRows } from '../core/sort.js';
import { pickChartAxes, chartSeries } from '../core/chart-data.js';

const VIS_CAP = 5000;
const MIN_COL = 48; // px floor for a resized column

/**
 * New width (px) for a column dragged by `dx` client px. `scale` converts client
 * px → CSS px under the page `zoom` (computed per element); 0/NaN falls back to
 * 1. Clamped to MIN_COL. Pure — exported for tests.
 */
export function colResizeWidth(startW, dx, scale) {
  return Math.max(MIN_COL, Math.round(startW + dx / (scale || 1)));
}

/**
 * Pin every column of `table` to the px widths in `r.colWidths` (key 'idx' for
 * the row-number column, then 0-based data-column indices) and switch it to
 * fixed layout so columns honor those widths exactly (and the wrap scrolls).
 */
function applyFixedWidths(table, r) {
  table.classList.add('fixed');
  const cells = table.querySelectorAll('thead th');
  let total = 0;
  for (let k = 0; k < cells.length; k++) {
    const w = r.colWidths[k === 0 ? 'idx' : k - 1];
    cells[k].style.width = w + 'px';
    total += w;
  }
  table.style.width = total + 'px';
  table.style.minWidth = '0';
}

/** Begin dragging the right edge of header `th` (a data column) to resize it. */
function startColumnResize(r, th, ev) {
  ev.preventDefault();
  ev.stopPropagation(); // don't let the handle's mousedown reach the sort header
  const table = th.closest('table');
  const cells = table.querySelectorAll('thead th');
  const colIndex = [].indexOf.call(cells, th) - 1; // 'idx' is cell 0
  // First resize: freeze every column at its current rendered width, then fix.
  if (!Object.keys(r.colWidths).length) {
    for (let k = 0; k < cells.length; k++) {
      r.colWidths[k === 0 ? 'idx' : k - 1] = cells[k].offsetWidth;
    }
  }
  applyFixedWidths(table, r);
  const win = th.ownerDocument.defaultView;
  const scale = th.getBoundingClientRect().width / th.offsetWidth;
  const startX = ev.clientX;
  const startW = r.colWidths[colIndex];
  const onMove = (m) => {
    r.colWidths[colIndex] = colResizeWidth(startW, m.clientX - startX, scale);
    applyFixedWidths(table, r);
  };
  const onUp = () => {
    win.removeEventListener('mousemove', onMove);
    win.removeEventListener('mouseup', onUp);
  };
  win.addEventListener('mousemove', onMove);
  win.addEventListener('mouseup', onUp);
}

export function renderResults(app) {
  const region = app.dom.resultsRegion;
  if (!region) return;
  const tab = app.activeTab();
  const r = tab.result;
  const body = h('div', { class: 'results' });
  body.appendChild(buildToolbar(app, r));

  const inner = h('div', { class: 'res-body' });
  // While running, pin a streaming strip to the top of the body: a determinate
  // fill at read/total when known, else an indeterminate sweep.
  if (app.state.running) inner.appendChild(streamStrip(r));
  const streamingBlank = app.state.running && (!r || (r.rows.length === 0 && r.rawText == null));
  if (streamingBlank) {
    inner.appendChild(h('div', { class: 'placeholder starting' },
      h('span', { class: 'spin' }, Icon.spinner()),
      h('div', null, 'Starting query…')));
  } else if (!r) {
    inner.appendChild(h('div', { class: 'empty-results' },
      h('div', { class: 'chip' }, Icon.play()),
      h('div', null, 'Press ', h('kbd', null, '⌘↵'), ' to run query')));
  } else if (r.error) {
    inner.appendChild(h('div', { class: 'results-error' }, r.error));
  } else if (r.rawText != null) {
    inner.appendChild(h('div', { class: 'raw-text-view', tabindex: '0' }, r.rawText));
  } else if (r.rows.length === 0) {
    inner.appendChild(h('div', { class: 'placeholder' }, h('div', null, 'Query returned 0 rows.')));
  } else if (app.state.resultView === 'json') {
    inner.appendChild(renderJson(r));
  } else if (app.state.resultView === 'chart') {
    inner.appendChild(renderChart(r));
  } else {
    inner.appendChild(renderTable(app, r));
  }
  body.appendChild(inner);
  region.replaceChildren(body);
}

// 2px progress strip atop the results body while a query streams.
function streamStrip(r) {
  return h('div', { class: 'stream-strip' },
    r && r.pct > 0
      ? h('i', { class: 'fill', style: { width: r.pct + '%' } })
      : h('i', { class: 'sweep' }));
}

function buildToolbar(app, r) {
  const isRaw = r && r.rawText != null;
  const toolbar = h('div', { class: 'res-toolbar' });
  const tabs = h('div', { class: 'result-view-tabs' });
  const views = isRaw
    ? [{ id: 'raw', label: r.rawFormat, icon: r.rawFormat === 'JSON' ? Icon.json() : Icon.table2() }]
    : [
        { id: 'table', label: 'Table', icon: Icon.table2() },
        { id: 'json', label: 'JSON', icon: Icon.json() },
        { id: 'chart', label: 'Chart', icon: Icon.chart() },
      ];
  for (const v of views) {
    const isActive = app.state.resultView === v.id || (isRaw && v.id === 'raw');
    tabs.appendChild(h('button', {
      class: 'result-view-tab' + (isActive ? ' active' : ''),
      onclick: () => { app.state.resultView = v.id; renderResults(app); },
    }, v.icon, h('span', null, v.label)));
  }
  toolbar.appendChild(tabs);
  toolbar.appendChild(h('div', { style: { flex: '1' } }));
  if (app.state.running) {
    // Live counters (accent, mono) + Cancel — replaces the static stats while
    // streaming. The ms element is updated in place by app.tickElapsed().
    app.dom.runElapsedEl = h('span', { class: 'v' }, app.elapsedMs().toFixed(0) + ' ms');
    toolbar.appendChild(h('div', { class: 'stat live' }, h('span', { class: 'ic spin' }, Icon.spinner()), app.dom.runElapsedEl));
    toolbar.appendChild(h('div', { class: 'stat live' }, h('span', { class: 'ic' }, Icon.rows()),
      h('span', { class: 'v' }, formatRows(r ? r.progress.rows : 0) + ' rows')));
    toolbar.appendChild(h('div', { class: 'stat live' }, h('span', { class: 'ic' }, Icon.bytes()),
      h('span', { class: 'v' }, formatBytes(r ? r.progress.bytes : 0))));
    toolbar.appendChild(h('button', {
      class: 'res-act cancel-act', title: 'Cancel query (Esc)',
      onclick: () => app.actions.cancel(),
    }, Icon.close(), h('span', null, 'Cancel'), h('kbd', null, 'Esc')));
  } else if (r) {
    if (r.cancelled) {
      toolbar.appendChild(h('span', { class: 'cancelled-badge' }, 'Cancelled · partial'));
    }
    const ms = (r.progress.elapsed_ns / 1e6).toFixed(0);
    toolbar.appendChild(h('div', { class: 'stat' }, h('span', { class: 'ic' }, Icon.clock()), h('span', { class: 'v' }, ms + ' ms')));
    toolbar.appendChild(h('div', { class: 'stat' }, h('span', { class: 'ic' }, Icon.rows()),
      h('span', { class: 'v' }, (r.rawText != null ? '—' : r.rows.length) + ' rows')));
    toolbar.appendChild(h('div', { class: 'stat', title: r.progress.rows + ' rows scanned' },
      h('span', { class: 'ic' }, Icon.bytes()), h('span', { class: 'v' }, formatBytes(r.progress.bytes))));
    if (!r.error) {
      toolbar.appendChild(h('button', {
        class: 'res-act', title: 'Copy results to clipboard',
        onclick: () => app.actions.copyResult(),
      }, Icon.copy(), h('span', null, 'Copy')));
      toolbar.appendChild(h('button', {
        class: 'res-act', title: 'Download results as a file',
        onclick: () => app.actions.exportResult(),
      }, Icon.download(), h('span', null, 'Export')));
    }
  }
  return toolbar;
}

export function renderJson(r) {
  const arr = r.rows.slice(0, VIS_CAP).map((row) => {
    const o = {};
    r.columns.forEach((c, i) => { o[c.name] = row[i]; });
    return o;
  });
  return h('div', { class: 'json-view', tabindex: '0' }, JSON.stringify(arr, null, 2));
}

export function renderTable(app, r) {
  const { col, dir } = app.state.resultSort;
  const rows = sortRows(r.rows, col, dir);
  r.colWidths = r.colWidths || {}; // persists across re-renders (sort/streaming)
  const wrap = h('div', { class: 'res-table-wrap' });
  const table = document.createElement('table');
  table.className = 'res-table';

  const trh = document.createElement('tr');
  trh.appendChild(h('th', { style: { textAlign: 'center', color: 'var(--fg-faint)', minWidth: '36px' } }, '#'));
  r.columns.forEach((c, i) => {
    const isSort = col === i;
    const th = h('th', {
      title: c.type || '', // type exposed on hover, not shown inline
      onclick: () => {
        if (isSort) app.state.resultSort.dir = dir === 'asc' ? 'desc' : 'asc';
        else { app.state.resultSort.col = i; app.state.resultSort.dir = 'asc'; }
        renderResults(app);
      },
    }, h('div', { class: 'h-inner' },
      h('span', { class: 'h-name' }, c.name),
      h('span', { style: { flex: '1' } }),
      isSort ? h('span', { class: 'h-sort' }, dir === 'asc' ? Icon.sortAsc() : Icon.sortDesc()) : null),
      // drag the right edge to resize; swallow the click so it doesn't sort.
      h('span', {
        class: 'col-resize-h',
        title: 'Drag to resize column',
        onmousedown: (e) => startColumnResize(r, th, e),
        onclick: (e) => e.stopPropagation(),
      }));
    trh.appendChild(th);
  });
  const thead = document.createElement('thead');
  thead.appendChild(trh);
  table.appendChild(thead);
  if (Object.keys(r.colWidths).length) applyFixedWidths(table, r);

  const tbody = document.createElement('tbody');
  rows.slice(0, VIS_CAP).forEach((row, ri) => {
    const tr = document.createElement('tr');
    tr.appendChild(h('td', { class: 'idx' }, String(ri + 1)));
    row.forEach((v, ci) => {
      const isNum = isNumericType(r.columns[ci].type);
      const text = v == null ? '' : String(v);
      // Truncate in-cell (CSS max-width + ellipsis); click opens the full value
      // in a side drawer so one fat column (e.g. HTML blobs) can't dominate.
      tr.appendChild(h('td', {
        class: 'cell' + (isNum ? ' num' : ''),
        title: text.length > 100 ? text.slice(0, 100) + '…' : text,
        onclick: () => openCellDetail(app, r.columns[ci].name, r.columns[ci].type, v),
      }, h('div', { class: 'cell-val' }, text)));
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  wrap.appendChild(table);
  if (rows.length > VIS_CAP) {
    wrap.appendChild(h('div', {
      style: { padding: '10px 14px', fontSize: '11px', color: 'var(--fg-faint)', fontFamily: 'var(--mono)', borderTop: '1px solid var(--border)' },
    }, '… + ' + (rows.length - VIS_CAP) + ' more rows truncated for display.'));
  }
  return wrap;
}

/**
 * Open a right-side drawer with one cell's full value: pretty-printed (JSON is
 * reindented), and for HTML a Rendered (sandboxed iframe) ↔ Source toggle.
 * Escape or a backdrop/✕ click closes it. Exported for tests.
 */
export function openCellDetail(app, name, type, value) {
  const doc = app.document || document;
  const text = value == null ? '' : String(value);
  let backdrop;
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  function close() {
    if (backdrop) backdrop.remove();
    doc.removeEventListener('keydown', onKey, true);
  }

  const body = h('div', { class: 'cd-body' });
  const showSource = () => body.replaceChildren(h('pre', { class: 'cd-pre' }, prettyValue(text)));

  const head = h('div', { class: 'cd-head' },
    h('div', { class: 'cd-title' },
      h('span', { class: 'cd-name' }, name),
      type ? h('span', { class: 'cd-type' }, type) : null),
    h('button', { class: 'cd-close', title: 'Close (Esc)', onclick: close }, Icon.close()));

  const panel = h('div', { class: 'cd-panel', onclick: (e) => e.stopPropagation() }, head);

  if (looksLikeHtml(text)) {
    const seg = h('div', { class: 'cd-toggle' });
    const setMode = (mode) => {
      seg.replaceChildren(
        h('button', { class: 'cd-seg' + (mode === 'rendered' ? ' on' : ''), onclick: () => setMode('rendered') }, 'Rendered'),
        h('button', { class: 'cd-seg' + (mode === 'source' ? ' on' : ''), onclick: () => setMode('source') }, 'Source'));
      if (mode === 'rendered') {
        const frame = h('iframe', { class: 'cd-frame', sandbox: '' });
        frame.setAttribute('srcdoc', text);
        body.replaceChildren(frame);
      } else {
        showSource();
      }
    };
    panel.append(seg, body);
    setMode('rendered');
  } else {
    panel.appendChild(body);
    showSource();
  }

  backdrop = h('div', { class: 'cd-backdrop', onclick: close }, panel);
  doc.body.appendChild(backdrop);
  doc.addEventListener('keydown', onKey, true);
  return backdrop;
}

export function renderChart(r) {
  const { xIdx, yIdx, ok } = pickChartAxes(r.columns);
  if (!ok) return h('div', { class: 'placeholder' }, h('div', null, 'No numeric columns to chart.'));
  const { labels, values, max } = chartSeries(r.rows, xIdx, yIdx);

  const wrap = h('div', { class: 'chart-view' });
  wrap.appendChild(h('div', { class: 'chart-controls' },
    h('span', null, 'X: ', h('strong', { style: { color: 'var(--fg)' } }, r.columns[xIdx].name)),
    h('span', null, 'Y: ', h('strong', { style: { color: 'var(--fg)' } }, r.columns[yIdx].name)),
    h('span', { style: { color: 'var(--fg-faint)' } }, '(showing first ' + values.length + ' rows)')));

  const W = 600, H = 280, P = { l: 50, r: 12, t: 10, b: 36 };
  const innerW = W - P.l - P.r, innerH = H - P.t - P.b;
  const step = innerW / Math.max(values.length, 1);
  const barW = step * 0.7;

  const svg = s('svg', {
    viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'xMidYMid meet',
    style: { width: '100%', height: '100%' },
  });

  const line = (x1, y1, x2, y2) => s('line', { x1, y1, x2, y2, stroke: 'currentColor', opacity: '0.25' });
  const text = (x, y, anchor, str) =>
    s('text', { x, y, 'text-anchor': anchor, 'font-size': '10', fill: 'currentColor', opacity: '0.6' }, str);

  svg.appendChild(line(P.l, P.t + innerH, P.l + innerW, P.t + innerH));
  svg.appendChild(text(P.l - 6, P.t + 10, 'end', formatRows(max)));
  svg.appendChild(text(P.l - 6, P.t + innerH + 4, 'end', '0'));

  values.forEach((v, i) => {
    const x = P.l + i * step + (step - barW) / 2;
    const hgt = max > 0 ? (v / max) * innerH : 0;
    svg.appendChild(s('rect', {
      x, y: P.t + innerH - hgt, width: barW, height: hgt, fill: 'var(--accent)', rx: '1.5',
    }, s('title', null, labels[i] + ': ' + v)));
  });

  const every = Math.max(1, Math.ceil(labels.length / 12));
  labels.forEach((lab, i) => {
    if (i % every !== 0) return;
    const short = lab.length > 12 ? lab.slice(0, 11) + '…' : lab;
    svg.appendChild(text(P.l + i * step + step / 2, P.t + innerH + 16, 'middle', short));
  });

  const area = h('div', { class: 'chart-area' });
  area.appendChild(svg);
  wrap.appendChild(area);
  return wrap;
}
