// The chart renderer, extracted from results.js (#166 prep): the Type/X/Y/
// Series config bar and the Chart.js instantiation with the cross-realm
// resize fix. This module never imports results.js — repaint scope (`rerender`)
// and instance ownership (`setChart`) are caller seams, so panels.js (the
// registry, its only production caller) consumes it without a cycle. Config
// derivation lives in core/panel-cfg.js (resolvePanel/autoPanel) — render
// never derives into or writes tab state (#166's dirty pin).

import { h } from './dom.js';
import { Icon } from './icons.js';
import { formatRows } from '../core/format.js';
import {
  chartFieldOptions, chartColors, chartJsConfig, chartCfgValid, normalizeChartCfg, chartRowCap,
  chartStylePresets, chartStylePreset, applyChartStylePreset, normalizeChartStyle, visibleChartMeasures,
} from '../core/chart-data.js';
import type { ChartConfig, ChartFamilyType, ChartFieldOption, ChartStyle } from '../core/chart-data.js';
import type { Column } from '../core/panel-cfg.js';
import type { FieldConfig, PanelCfg } from '../generated/json-schema.types.js';
import type { App } from './app.types.js';

/** One `<select>` option (config bar + Style picker) — a superset of
 *  chart-data.ts's own `ChartFieldOption`/`ChartTypeOption`/
 *  `ChartStylePresetEntry` (each assignable here; extra fields like a
 *  preset's `style` are simply unread), plus the synthetic disabled "Custom"
 *  placeholder this module builds itself. */
interface ChartSelectOption {
  value: string | number;
  label: string;
  disabled?: boolean;
}

/** A labelled <select> for the config bar (shared with the Panel tab's
 * pickers — one builder, one look). Exported for panels.js. */
export function chartSelect(
  label: string, value: string | number, options: ChartSelectOption[], onChange: (value: string) => void,
): HTMLLabelElement {
  const sel = h('select', { class: 'chart-select', onchange: (e: Event) => onChange((e.target as HTMLSelectElement).value) });
  for (const o of options) {
    const opt = h('option', { value: o.value, disabled: o.disabled }, o.label);
    sel.appendChild(opt);
  }
  const selected = options.some((option) => String(option.value) === String(value));
  if (selected) sel.value = String(value);
  return h('label', { class: 'chart-field' }, h('span', { class: 'chart-field-label' }, label), sel);
}

/** The chart/panel empty-state chip + message. Exported for panels.js. */
export function chartEmpty(icon: Element, msg: string): HTMLDivElement {
  return h('div', { class: 'chart-empty' }, h('div', { class: 'chip' }, icon), h('div', null, msg));
}

/** The Chart.js instance shape this module ever touches: built via
 *  `new app.Chart(canvas, config)`, then resized/updated once attached — the
 *  narrow structural contract CLAUDE.md rule 5 asks for (never chart.js's own
 *  .d.ts import). `app.chart` (app.types.ts) only pins `.destroy()`; this is
 *  a strict superset, so it's still assignable wherever that narrower shape
 *  is expected. */
export interface ChartInstance {
  destroy(): void;
  resize(width: number, height: number): void;
  update(mode: string): void;
}

/** The Chart.js constructor seam (`app.Chart`, injected — CLAUDE.md rule 5).
 *  `app.Chart` itself is typed `unknown` (app.types.ts) since every consumer
 *  narrows it to exactly what it calls. */
interface ChartConstructor {
  new (canvas: HTMLCanvasElement, config: unknown): ChartInstance;
}

/** `renderChart`'s options bag — pinned, field-for-field, by panels.ts's own
 *  local `RenderChartOpts` wrapper type over this export; keep the two in
 *  lockstep by hand if either changes. */
export interface RenderChartOpts {
  cfg?: PanelCfg;
  rerender?: () => void;
  onCfgChange?: (cfg: PanelCfg) => void;
  typeControl?: boolean;
  setChart?: (chart: ChartInstance) => void;
  controls?: boolean;
  fieldConfig?: FieldConfig;
  hideGrid?: boolean;
}

/**
 * `opts.cfg` (required) is a ready, caller-owned config — resolvePanel's
 * clone; render never writes anything back (#166's dirty pin), and
 * `opts.onCfgChange(cfg)` fires on every config-bar edit so the caller can
 * write the edited clone back explicitly (the caller's rerender then
 * repaints — the handlers do NOT rerender themselves when onCfgChange is
 * supplied, avoiding a double repaint). `opts.rerender` repaints after a
 * config change — required whenever the config bar renders
 * (`controls !== false`): this module must not default it to results.js's
 * repaint, or the import cycle this extraction breaks would come right back.
 * `opts.setChart` receives the new Chart.js instance to store/destroy (the
 * shared `app.chart` slot by default — an isolated surface must use its own
 * slot instead, or closing one view's chart would tear down another's).
 * `opts.controls === false` omits the Type/X/Y config bar (read-only tiles);
 * `opts.typeControl === false` omits just the Type select (the Panel tab's
 * picker owns type). `opts.hideGrid` supplies the value-grid default for
 * `style.grid:'auto'` (dashboard tiles — #149). `opts.fieldConfig` is the saved panel metadata;
 * the pure chart layer resolves it without reading application state.
 */
export function renderChart(
  app: App, r: { columns: Column[]; rows: unknown[][] }, opts: RenderChartOpts = {},
): HTMLElement {
  const rerender = opts.rerender;
  const setChart = opts.setChart || ((c: ChartInstance) => { app.chart = c; });
  // With an onCfgChange the caller owns the repaint (writeBack → rerender);
  // without one the handlers repaint directly. Never both.
  const changed: (cfg: ChartConfig) => void = opts.onCfgChange
    ? (cfg) => opts.onCfgChange!(cfg)
    // `!`: `changed` is only ever invoked from a config-bar handler, which
    // only exists (below) when `opts.controls !== false` — the same
    // contract that requires the caller to supply `rerender` in that case.
    : () => rerender!();
  // `as`: chart-data.ts's `chartCfgValid` is a plain boolean predicate (not a
  // `cfg is ChartConfig` type guard) — its own contract (index range +
  // known-type checks against `r.columns`) is exactly the runtime proof that
  // `opts.cfg` (the wider `PanelCfg` union) is safe to treat as a `ChartConfig`
  // here; `normalizeChartCfg` mutates `y`/`series` in place and returns the
  // same object.
  const cfg = chartCfgValid(opts.cfg, r.columns) ? normalizeChartCfg(opts.cfg as ChartConfig) : null;
  if (!cfg) return chartEmpty(Icon.chart(), 'These results aren’t chartable — add a numeric column to plot them.');

  // `opts.controls === false` omits the interactive Type/X/Y config bar entirely
  // (the read-only dashboard tile — #149): the chart draws, but no field controls
  // are built, rather than building them and hiding them with CSS.
  let bar: HTMLDivElement | null = null;
  if (opts.controls !== false) {
    const f = chartFieldOptions(r.columns, cfg);

    // Each handler mutates the caller's cfg clone and reports it via
    // `changed`; normalizeChartCfg folds the cross-field invariants (pie →
    // single measure, series ≠ X) on the next render, so the handlers don't
    // normalize themselves.
    bar = h('div', { class: 'chart-config' });
    // The Panel drawer tab (#166) renders its own all-types picker above this
    // bar, so it suppresses the chart-family Type select (`typeControl:false`)
    // rather than showing two competing type controls.
    if (opts.typeControl !== false) {
      // `as`: only a `typeOptions` value (always a ChartFamilyType) is ever
      // selectable here.
      bar.appendChild(chartSelect('Type', cfg.type, f.typeOptions, (v) => { cfg.type = v as ChartFamilyType; changed(cfg); }));
    }
    const presets = chartStylePresets(cfg.type);
    if (presets.length) {
      const preset = chartStylePreset(cfg.style, cfg.type);
      const styleOptions: ChartSelectOption[] = preset === 'custom'
        ? [...presets, { value: 'custom', label: 'Custom', disabled: true }]
        : presets;
      bar.appendChild(chartSelect('Style', preset, styleOptions, (v) => {
        // `as`: applyChartStylePreset returns a plain, renderer-independent
        // style bag (every ChartStyle branch is all-optional + an index
        // signature — see chart-data.ts's own ChartStyle doc comment); this
        // module never narrows it further than "whatever the current cfg.type
        // accepts", the same contract normalizeChartStyle/chartStylePreset apply.
        cfg.style = applyChartStylePreset(cfg.style, v, cfg.type) as ChartStyle;
        changed(cfg);
      }));
    }
    // `!`: chartCfgValid required a non-empty `y` array for `cfg` to reach here.
    bar.appendChild(chartSelect('X', String(cfg.x), f.xOptions, (v) => { cfg.x = Number(v); changed(cfg); }));
    bar.appendChild(chartSelect('Y', String(cfg.y![0]), f.yOptions, (v) => { cfg.y = [Number(v)]; changed(cfg); }));
    if (f.showMulti) {
      bar.appendChild(h('button', {
        class: 'chart-toggle', title: 'Plot every numeric column as its own series',
        onclick: () => { cfg.y = f.multiActive ? [cfg.y![0]] : f.allMeasures; changed(cfg); },
      }, f.multiActive ? 'Single series' : 'All measures'));
    }
    if (f.showSeries) {
      bar.appendChild(chartSelect('Series', String(cfg.series ?? ''), f.seriesOptions, (v) => {
        cfg.series = v === '' ? null : Number(v);
        changed(cfg);
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

  // Resolve the visible measures once and reuse them for the chart config
  // below (threaded through `chartJsConfig`), rather than re-resolving field
  // metadata for the empty-state guard and again inside the renderer.
  const measures = visibleChartMeasures(r.columns, cfg, opts.fieldConfig);
  if (measures.length === 0) {
    return h('div', { class: 'chart-view' }, bar,
      chartEmpty(Icon.chart(), 'All selected chart fields are hidden by panel.fieldConfig.'));
  }

  const canvas = h('canvas', null); // via h() so it lands in the right document (detached-tab safe)
  // Plot in result (query) order — independent of the table's sort, which is a
  // global, cross-tab setting; applying it here would reorder the X axis (a
  // time series would zig-zag) and change which rows the type's row cap keeps,
  // contradicting the "first N rows" note. It would also sort up to the display
  // cap's rows just to discard all but the first `cap`.
  const ChartCtor = app.Chart as ChartConstructor;
  const chart = new ChartCtor(canvas, chartJsConfig(r.columns, r.rows, cfg, chartColors(app.cssVar), {
    fieldConfig: opts.fieldConfig,
    hideGrid: opts.hideGrid,
    measures,
  }));
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
  // `!`: a canvas built via h() always has a live ownerDocument/defaultView.
  canvas.ownerDocument.defaultView!.requestAnimationFrame(() => {
    const wrap = canvas.parentElement;
    if (wrap && wrap.offsetWidth > 0 && wrap.offsetHeight > 0) { chart.resize(wrap.offsetWidth, wrap.offsetHeight); chart.update('resize'); }
  });

  const compactFrame = cfg.type === 'pie' && normalizeChartStyle(cfg.style, cfg.type).frame === 'compact';
  return h('div', { class: 'chart-view' }, bar,
    h('div', { class: 'chart-canvas-wrap' + (compactFrame ? ' is-compact' : '') }, canvas));
}
