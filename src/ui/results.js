// The results pane: a view switcher (Table | JSON | Chart, or a single Raw
// view for TSV/JSON output) plus the renderers. Heavy logic (sorting, axis
// selection) lives in core/ and is reused here.

import { h, zoomScale } from './dom.js';
import { Icon } from './icons.js';
import { formatRows, formatBytes, isNumericType } from '../core/format.js';
import { looksLikeHtml, prettyValue } from '../core/cell.js';
import { sortRows } from '../core/sort.js';
import { autoChart, schemaKey, chartFieldOptions, chartColors, chartJsConfig, chartCfgValid, normalizeChartCfg, unzoomChartEvent, CHART_ROW_CAP } from '../core/chart-data.js';
import { EXPLAIN_VIEWS } from '../core/explain.js';
import { renderExplainGraph, openPipelineFullscreen, renderSchemaGraph } from './explain-graph.js';

// View id → tab glyph for the EXPLAIN view strip (kept here so core/explain.js
// stays DOM-free). Pipeline reuses the node-graph share glyph.
const EXPLAIN_ICONS = {
  explain: Icon.plan, indexes: Icon.key, projections: Icon.layers,
  pipeline: Icon.share, estimate: Icon.rows,
};

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
  const scale = zoomScale(th);
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
  // Tear down any live Chart.js instance before the DOM is rebuilt, so a view
  // switch / re-render can't leak its canvas observers (renderChart re-creates).
  if (app.chart) { app.chart.destroy(); app.chart = null; }
  const tab = app.activeTab();
  const r = tab.result;
  const body = h('div', { class: 'results' });
  body.appendChild(buildToolbar(app, r));

  const inner = h('div', { class: 'res-body' });
  // While running, pin a streaming strip to the top of the body: a determinate
  // fill at read/total when known, else an indeterminate sweep.
  if (app.state.running.value) inner.appendChild(streamStrip(r));
  const streamingBlank = app.state.running.value && (!r || (r.rows.length === 0 && r.rawText == null));
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
  } else if (r.schemaGraph) {
    inner.appendChild(r.schemaGraph.loading
      ? h('div', { class: 'placeholder starting' },
        h('span', { class: 'spin' }, Icon.spinner()),
        h('div', null, 'Loading data flow…'))
      : renderSchemaGraph(app, r));
  } else if (r.explainView) {
    inner.appendChild(renderExplainView(app, r));
  } else if (r.rawText != null) {
    inner.appendChild(h('div', { class: 'raw-text-view', tabindex: '0' }, r.rawText));
  } else if (r.rows.length === 0) {
    inner.appendChild(h('div', { class: 'placeholder' }, h('div', null, 'Query returned 0 rows.')));
  } else if (app.state.resultView.value === 'json') {
    inner.appendChild(renderJson(r));
  } else if (app.state.resultView.value === 'chart') {
    inner.appendChild(renderChart(app, r));
  } else {
    inner.appendChild(renderTable(app, r));
  }
  body.appendChild(inner);
  region.replaceChildren(body);
}

// Render the active EXPLAIN view: monospace text (Explain/Indexes/Projections),
// a real table (Estimate, streamed structured), or the SVG pipeline graph.
function renderExplainView(app, r) {
  const desc = EXPLAIN_VIEWS.find((v) => v.id === r.explainView);
  const kind = desc ? desc.kind : 'text';
  if (kind === 'graph') return renderExplainGraph(app, r);
  if (kind === 'table') {
    return r.rows.length
      ? renderTable(app, r)
      : h('div', { class: 'placeholder' }, h('div', null, 'No rows to estimate for this query (only MergeTree reads that scan parts produce an estimate).'));
  }
  return h('div', { class: 'raw-text-view', tabindex: '0' }, r.rawText || '');
}

// 2px progress strip atop the results body while a query streams.
function streamStrip(r) {
  return h('div', { class: 'stream-strip' },
    r && r.pct > 0
      ? h('i', { class: 'fill', style: { width: r.pct + '%' } })
      : h('i', { class: 'sweep' }));
}

function buildToolbar(app, r) {
  const toolbar = h('div', { class: 'res-toolbar' });
  if (r && r.schemaGraph) {
    // Schema-lineage view: a title + Expand (fullscreen); no view-switcher / stats.
    const f = r.schemaGraph.focus || {};
    const title = f.kind === 'table' ? f.db + '.' + f.table : f.db;
    toolbar.appendChild(h('div', { class: 'result-view-tabs' }, h('span', { class: 'res-graph-title' }, 'Schema · ' + title)));
    toolbar.appendChild(h('div', { style: { flex: '1' } }));
    // Expand is meaningless until the graph has loaded, or when there's nothing
    // to draw (no connected objects → the pane shows a message, not a graph).
    if (!r.schemaGraph.loading && r.schemaGraph.nodes.length) {
      toolbar.appendChild(h('button', {
        class: 'res-act', title: 'Open the graph fullscreen with rich cards (pan & zoom)',
        onclick: () => app.actions.expandSchemaGraph(r.schemaGraph.focus),
      }, Icon.expand(), h('span', null, 'Expand')));
    }
    return toolbar;
  }
  const tabs = h('div', { class: 'result-view-tabs' });
  if (r && r.explainView) {
    // The five EXPLAIN views — clicking re-runs the derived query (editor SQL is
    // never touched). Stays visible on error so a failing view can be switched.
    for (const v of EXPLAIN_VIEWS) {
      const icon = EXPLAIN_ICONS[v.id];
      tabs.appendChild(h('button', {
        class: 'result-view-tab' + (r.explainView === v.id ? ' active' : ''),
        onclick: () => app.actions.setExplainView(v.id),
      }, icon ? icon() : null, h('span', null, v.label)));
    }
  } else {
    const isRaw = r && r.rawText != null;
    const views = isRaw
      ? [{ id: 'raw', label: r.rawFormat, icon: r.rawFormat === 'JSON' ? Icon.json() : Icon.table2() }]
      : [
          { id: 'table', label: 'Table', icon: Icon.table2() },
          { id: 'json', label: 'JSON', icon: Icon.json() },
          { id: 'chart', label: 'Chart', icon: Icon.chart() },
        ];
    for (const v of views) {
      const isActive = app.state.resultView.value === v.id || (isRaw && v.id === 'raw');
      tabs.appendChild(h('button', {
        class: 'result-view-tab' + (isActive ? ' active' : ''),
        onclick: () => { app.state.resultView.value = v.id; },
      }, v.icon, h('span', null, v.label)));
    }
  }
  toolbar.appendChild(tabs);
  toolbar.appendChild(h('div', { style: { flex: '1' } }));
  // EXPLAIN views suppress the ms/rows/bytes stats — they're not meaningful for a
  // plan and the freed space lets the five tabs breathe.
  const showStats = !(r && r.explainView);
  if (app.state.running.value) {
    // Live counters (accent, mono) + Cancel — replaces the static stats while
    // streaming. The ms element is updated in place by app.tickElapsed().
    if (showStats) {
      app.dom.runElapsedEl = h('span', { class: 'v' }, app.elapsedMs().toFixed(0) + ' ms');
      toolbar.appendChild(h('div', { class: 'stat live' }, h('span', { class: 'ic spin' }, Icon.spinner()), app.dom.runElapsedEl));
      toolbar.appendChild(h('div', { class: 'stat live' }, h('span', { class: 'ic' }, Icon.rows()),
        h('span', { class: 'v' }, formatRows(r ? r.progress.rows : 0) + ' rows')));
      toolbar.appendChild(h('div', { class: 'stat live' }, h('span', { class: 'ic' }, Icon.bytes()),
        h('span', { class: 'v' }, formatBytes(r ? r.progress.bytes : 0))));
    }
    toolbar.appendChild(h('button', {
      class: 'res-act cancel-act', title: 'Cancel query (Esc)',
      onclick: () => app.actions.cancel(),
    }, Icon.close(), h('span', null, 'Cancel'), h('kbd', null, 'Esc')));
  } else if (r) {
    if (r.cancelled) {
      toolbar.appendChild(h('span', { class: 'cancelled-badge' }, 'Cancelled · partial'));
    }
    if (showStats) {
      const ms = (r.progress.elapsed_ns / 1e6).toFixed(0);
      toolbar.appendChild(h('div', { class: 'stat' }, h('span', { class: 'ic' }, Icon.clock()), h('span', { class: 'v' }, ms + ' ms')));
      toolbar.appendChild(h('div', { class: 'stat' }, h('span', { class: 'ic' }, Icon.rows()),
        h('span', { class: 'v' }, (r.rawText != null ? '—' : r.rows.length) + ' rows')));
      toolbar.appendChild(h('div', { class: 'stat', title: r.progress.rows + ' rows scanned' },
        h('span', { class: 'ic' }, Icon.bytes()), h('span', { class: 'v' }, formatBytes(r.progress.bytes))));
    }
    if (r.explainView === 'pipeline' && r.rawText && !r.error) {
      toolbar.appendChild(h('button', {
        class: 'res-act', title: 'Open the graph fullscreen (pan & zoom)',
        onclick: () => openPipelineFullscreen(app, r.rawText),
      }, Icon.expand(), h('span', null, 'Expand')));
    }
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

/**
 * Per-tab chart config: derive defaults via autoChart the first time (or when
 * the result schema changes), then keep the user's overrides. A config restored
 * from a saved query / share link carries the schema key it was built for, so
 * when the re-run result matches that schema the restored config sticks. Returns
 * null when the result has nothing chartable.
 */
function chartCfgFor(tab, columns) {
  const key = schemaKey(columns);
  if (tab.chartKey !== key) {
    tab.chartKey = key;
    tab.chartCfg = autoChart(columns);
  } else if (tab.chartCfg && !chartCfgValid(tab.chartCfg, columns)) {
    // Key matches but the config doesn't fit (a hand-edited share link or a
    // corrupted import) — fall back to a safe default rather than crash.
    tab.chartCfg = autoChart(columns);
  }
  // Fold cross-field invariants on whatever we ended up with (a restored config
  // can be in-range yet self-contradictory, e.g. a multi-measure pie).
  return normalizeChartCfg(tab.chartCfg);
}

/** A labelled <select> for the config bar. */
function chartSelect(label, value, options, onChange) {
  const sel = h('select', { class: 'chart-select', onchange: (e) => onChange(e.target.value) });
  for (const o of options) {
    const opt = h('option', { value: o.value }, o.label);
    if (o.value === value) opt.selected = true;
    sel.appendChild(opt);
  }
  return h('label', { class: 'chart-field' }, h('span', { class: 'chart-field-label' }, label), sel);
}

function chartEmpty(icon, msg) {
  return h('div', { class: 'chart-empty' }, h('div', { class: 'chip' }, icon), h('div', null, msg));
}

/**
 * Make a Chart.js instance hover-correct under the page's CSS `zoom`. Chart.js
 * feeds every pointer event through the controller's single `_eventHandler`
 * entry point (a late-bound `this._eventHandler` lookup, so overriding the
 * instance property intercepts it) *before* it computes hit-testing / in-area —
 * so we divide the zoomed pointer coords back to chart space there (see
 * `unzoomChartEvent`). `zoomScale(canvas)` reads the live factor each event, so
 * it tracks theme/zoom changes and is a no-op (scale 1) when unzoomed. Returns
 * the chart. Exported for tests.
 */
export function installChartZoomFix(chart, canvas) {
  const onEvent = chart && chart._eventHandler;
  if (typeof onEvent !== 'function') return chart;
  chart._eventHandler = (e, replay) => onEvent.call(chart, unzoomChartEvent(e, zoomScale(canvas)), replay);
  return chart;
}

export function renderChart(app, r) {
  const tab = app.activeTab();
  // Gate on run state BEFORE deriving the config: while a query streams its
  // columns can be empty (pre-meta), and letting chartCfgFor see that empty
  // schema would clobber a restored saved/shared config with autoChart(null).
  if (app.state.running.value) return chartEmpty(Icon.spinner(), 'Chart renders when the query completes.');
  const cfg = chartCfgFor(tab, r.columns);
  if (!cfg) return chartEmpty(Icon.chart(), 'These results aren’t chartable — add a numeric column to plot them.');

  const f = chartFieldOptions(r.columns, cfg);
  const rerender = () => renderResults(app);

  // Each handler mutates the shared cfg (= tab.chartCfg) and re-renders;
  // chartCfgFor folds the cross-field invariants (pie → single measure,
  // series ≠ X) on the way back in, so the handlers don't normalize themselves.
  const bar = h('div', { class: 'chart-config' });
  bar.appendChild(chartSelect('Type', cfg.type, f.typeOptions, (v) => { cfg.type = v; rerender(); }));
  bar.appendChild(chartSelect('X', String(cfg.x), f.xOptions, (v) => { cfg.x = Number(v); rerender(); }));
  bar.appendChild(chartSelect('Y', String(cfg.y[0]), f.yOptions, (v) => { cfg.y = [Number(v)]; rerender(); }));
  if (f.showMulti) {
    bar.appendChild(h('button', {
      class: 'chart-toggle', title: 'Plot every numeric column as its own series',
      onclick: () => { cfg.y = f.multiActive ? [cfg.y[0]] : f.allMeasures; rerender(); },
    }, f.multiActive ? 'Single series' : 'All measures'));
  }
  if (f.showSeries) {
    bar.appendChild(chartSelect('Series', String(cfg.series ?? ''), f.seriesOptions, (v) => {
      cfg.series = v === '' ? null : Number(v);
      rerender();
    }));
  }
  // The chart plots at most CHART_ROW_CAP points; say so when the result is
  // bigger (the table still shows everything) — no silent truncation.
  if (r.rows.length > CHART_ROW_CAP) {
    bar.appendChild(h('span', { class: 'chart-cap-note' },
      'first ' + CHART_ROW_CAP + ' of ' + formatRows(r.rows.length) + ' rows'));
  }

  const canvas = document.createElement('canvas');
  // Plot in result (query) order — independent of the table's sort, which is a
  // global, cross-tab setting; applying it here would reorder the X axis (a
  // time series would zig-zag) and change which rows the CHART_ROW_CAP keeps,
  // contradicting the "first N rows" note. It would also sort up to VIS_CAP
  // rows just to discard all but the first CHART_ROW_CAP.
  app.chart = installChartZoomFix(
    new app.Chart(canvas, chartJsConfig(r.columns, r.rows, cfg, chartColors(app.cssVar))),
    canvas);

  return h('div', { class: 'chart-view' }, bar, h('div', { class: 'chart-canvas-wrap' }, canvas));
}
