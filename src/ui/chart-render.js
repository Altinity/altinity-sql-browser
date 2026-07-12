// The chart renderer, extracted from results.js (#166 prep): the per-view
// config derivation (chartCfgFor), the Type/X/Y/Series config bar, and the
// Chart.js instantiation with the zoom/cross-realm fixes. This module never
// imports results.js — repaint scope (`rerender`) and instance ownership
// (`setChart`) are caller seams, so panels.js (the registry) and results.js
// can both consume it without a cycle.

import { h, zoomScale } from './dom.js';
import { Icon } from './icons.js';
import { formatRows } from '../core/format.js';
import { autoChart, schemaKey, chartFieldOptions, chartColors, chartJsConfig, chartCfgValid, normalizeChartCfg, unzoomChartEvent, chartRowCap } from '../core/chart-data.js';

/**
 * Per-tab chart config: derive defaults via autoChart the first time (or when
 * the result schema changes), then keep the user's overrides. A config restored
 * from a saved query / share link carries the schema key it was built for, so
 * when the re-run result matches that schema the restored config sticks. Returns
 * null when the result has nothing chartable.
 */
function chartCfgFor(tab, columns) {
  const key = schemaKey(columns);
  if (tab.panelKey !== key) {
    tab.panelKey = key;
    tab.panelCfg = autoChart(columns);
  } else if (tab.panelCfg && !chartCfgValid(tab.panelCfg, columns)) {
    // Key matches but the config doesn't fit (a hand-edited share link or a
    // corrupted import) — fall back to a safe default rather than crash.
    tab.panelCfg = autoChart(columns);
  }
  // Fold cross-field invariants on whatever we ended up with (a restored config
  // can be in-range yet self-contradictory, e.g. a multi-measure pie).
  return normalizeChartCfg(tab.panelCfg);
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

/**
 * `opts.tab` holds the per-view chart config (`panelKey`/`panelCfg`) — the
 * active tab for the main results pane, or a caller-owned local object for a
 * detached snapshot (so switching chart fields there never touches the live
 * tab's own config). `opts.rerender` repaints after a config change — required
 * whenever the config bar renders (`controls !== false`): this module must not
 * default it to results.js's repaint, or the import cycle this extraction
 * breaks would come right back. `opts.setChart` receives the new Chart.js
 * instance to store/destroy (the shared `app.chart` slot by default — a
 * detached view must use its own slot instead, or closing one view's chart
 * would tear down another's). `opts.running` overrides the run-state gate — a
 * detached snapshot's `r` is always already-complete, independent of whatever
 * the live tab is doing. `opts.controls === false` omits the Type/X/Y config
 * bar (read-only tiles). `opts.hideGrid` suppresses the value-axis gridlines
 * (dashboard tiles — #149).
 */
export function renderChart(app, r, opts = {}) {
  const tab = opts.tab || app.activeTab();
  const rerender = opts.rerender;
  const setChart = opts.setChart || ((c) => { app.chart = c; });
  const running = opts.running !== undefined ? opts.running : app.state.running.value;
  // Gate on run state BEFORE deriving the config: while a query streams its
  // columns can be empty (pre-meta), and letting chartCfgFor see that empty
  // schema would clobber a restored saved/shared config with autoChart(null).
  if (running) return chartEmpty(Icon.spinner(), 'Chart renders when the query completes.');
  const cfg = chartCfgFor(tab, r.columns);
  if (!cfg) return chartEmpty(Icon.chart(), 'These results aren’t chartable — add a numeric column to plot them.');

  // `opts.controls === false` omits the interactive Type/X/Y config bar entirely
  // (the read-only dashboard tile — #149): the chart draws, but no field controls
  // are built, rather than building them and hiding them with CSS.
  let bar = null;
  if (opts.controls !== false) {
    const f = chartFieldOptions(r.columns, cfg);

    // Each handler mutates the shared cfg (= tab.panelCfg) and re-renders;
    // chartCfgFor folds the cross-field invariants (pie → single measure,
    // series ≠ X) on the way back in, so the handlers don't normalize themselves.
    bar = h('div', { class: 'chart-config' });
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
    // The chart plots at most cap points for the current type; say so when the
    // result is bigger (the table still shows everything) — no silent
    // truncation. Recomputed on every rerender (the Type select's onChange),
    // so switching type re-slices and updates the note in lockstep.
    const cap = chartRowCap(cfg.type);
    if (r.rows.length > cap) {
      bar.appendChild(h('span', { class: 'chart-cap-note' },
        'first ' + cap + ' of ' + formatRows(r.rows.length) + ' rows'));
    }
  }

  const canvas = h('canvas', null); // via h() so it lands in the right document (detached-tab safe)
  // Plot in result (query) order — independent of the table's sort, which is a
  // global, cross-tab setting; applying it here would reorder the X axis (a
  // time series would zig-zag) and change which rows the type's row cap keeps,
  // contradicting the "first N rows" note. It would also sort up to the display
  // cap's rows just to discard all but the first `cap`.
  const chart = installChartZoomFix(
    new app.Chart(canvas, chartJsConfig(r.columns, r.rows, cfg, chartColors(app.cssVar), { hideGrid: opts.hideGrid })),
    canvas);
  setChart(chart);
  // Chart.js's own responsive sizing reads layout through APIs (getComputedStyle,
  // ResizeObserver) bound to the window the Chart.js module itself runs in —
  // always the MAIN window, even when `canvas` belongs to a detached tab's own
  // document. Cross-realm, those calls see an unlaid-out/foreign element: the
  // canvas never gets a real size (stays 0×0), and even after an explicit
  // resize, its bars/points never get laid out (Chart.js's resize-triggered
  // relayout is debounced and gated on the same wrong-realm attachment check).
  // Force one explicit resize + a `'resize'`-mode update off the canvas's own
  // geometry (plain DOM methods — realm-agnostic) once it's actually in the
  // live tree; the caller inserts the returned view synchronously right after
  // this call returns, so a rAF on the canvas's *own* window (not the bare
  // global, which would resolve to the main window's) runs after that insertion.
  canvas.ownerDocument.defaultView.requestAnimationFrame(() => {
    // offsetWidth/Height are already pre-html{zoom} CSS px (unlike
    // getBoundingClientRect, see zoomScale's doc comment) — exactly what
    // chart.resize() wants, no zoom-bridging division needed.
    const wrap = canvas.parentElement;
    if (wrap && wrap.offsetWidth > 0 && wrap.offsetHeight > 0) { chart.resize(wrap.offsetWidth, wrap.offsetHeight); chart.update('resize'); }
  });

  return h('div', { class: 'chart-view' }, bar, h('div', { class: 'chart-canvas-wrap' }, canvas));
}
