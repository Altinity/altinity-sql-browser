import { describe, it, expect, vi } from 'vitest';
import { renderChart } from '../../src/ui/chart-render.js';
import { makeApp } from '../helpers/fake-app.js';
import type { FakeChart } from '../helpers/fake-app.js';
import { newResult as newResultUntyped } from '../../src/core/stream.js';
import {
  autoChart, chartCfgValid, schemaKey, chartRowCap, CHART_STYLE_PRESETS, chartStylePresets,
} from '../../src/core/chart-data.js';
import type { ChartConfig } from '../../src/core/chart-data.js';
import type { App, Tab } from '../../src/ui/app.types.js';
import type { AppState } from '../../src/state.js';
import type { Column } from '../../src/core/panel-cfg.js';

// core/stream.js is plain JS; without an explicit return-type annotation TS
// infers the empty-array initializers of `columns`/`rows` as `never[]`, which
// then rejects every fixture's real rows below — same "typed wrapper over a
// still-untyped .js dependency" convention panels.test.ts documents for the
// same dependency.
interface StreamResult {
  columns: Column[];
  rows: unknown[][];
  rawText: string | null;
  rawFormat: string;
  progress: { rows: number; bytes: number; elapsed_ns: number };
  error: unknown;
  cancelled: boolean;
  pct: number;
  rowLimit: number;
  capped: boolean;
  [k: string]: unknown;
}
const newResult = (fmt: string, rowLimit = 0): StreamResult => newResultUntyped(fmt, rowLimit) as StreamResult;

const click = (el: Element) => el.dispatchEvent(new Event('click', { bubbles: true }));

type FakeApp = ReturnType<typeof makeApp>;

/** `paintChart`'s own throwaway per-tab chart-config holder — mirrors the
 *  pre-#166 caller shape (this module never derives/writes real tab state;
 *  see chart-render.ts's own header comment), so the test drives renderChart
 *  in isolation without going through the Panel registry (panels.ts) at all.
 *  A genuine subtype of `Tab`: the properties really are set on the object
 *  below, so casting the real `activeTab()` return to it is an ordinary
 *  single-step narrowing, not an `unknown` bridge. */
type TestTab = Tab & { panelCfg: ChartConfig | null; panelKey: string | null };

/** `renderChart` wants the full `App` contract (panels.ts's own wrapper pins
 *  it exactly that way); tests/helpers/fake-app.js's `makeApp()` is a
 *  long-standing untyped test double implementing only the handful of
 *  members this file's direct (registry-free) exercise of renderChart
 *  actually reads — not the whole ~50-member interface (fake-app.js isn't
 *  one of this change's files; see panels.test.ts for the same convention).
 *  `chart` widens fake-app.js's `null` "no chart yet" sentinel to
 *  `undefined` (App.chart's own shape for the same state) and `activeTab`
 *  to `TestTab` (above) — both genuine narrowings of what the fixture
 *  already holds, not a fiction. */
type TestApp = Omit<App, 'chart' | 'activeTab'> & { chart: FakeChart | undefined; activeTab(): TestTab };

/** Adapts one `makeApp()` fixture into `TestApp` by filling every `App`
 *  member the fixture doesn't provide with an inert stub (never read by the
 *  paths this file exercises — renderChart only ever touches
 *  app.Chart/app.cssVar/app.chart). `Object.assign` mutates the SAME
 *  reference (not a spread copy), so a later `app.chart = c` write inside
 *  renderChart is visible through the original `app` this file keeps
 *  asserting against. */
function asApp(app: FakeApp): TestApp {
  const patch = {
    chart: (app.chart ?? undefined) as FakeChart | undefined,
    token: null, refreshToken: null,
    CodeViewer: () => ({ setText: () => {}, setLanguage: () => {}, setWrap: () => {}, focus: () => {}, destroy: () => {} }),
    specValidators: { validate: () => [], register: () => () => {} } as App['specValidators'],
    specCompletionSources: [] as unknown[],
    openWindow: () => null, stylesText: '', faviconHref: '',
    chUsername: () => '', authMode: 'basic' as const, chAuth: 'basic' as const, basicUserClaim: 'sub',
    idpId: null, hostHint: '',
    setTokens: () => {}, loadConfig: async () => ({}), selectIdp: () => {}, ensureConfig: async () => null,
    receiveAuthHandoff: async () => false, canExport: () => false, canExportScript: () => false,
    showSaveFilePicker: null, showDirectoryPicker: null, isSecureContext: true, FileReader: globalThis.FileReader,
    editingLibrary: false, loadReference: async () => {}, refData: { functions: {}, keywordDocs: {} },
    completions: {}, rebuildCompletions: () => {}, docCache: new Map<string, string | Promise<string | null>>(),
    updateBanner: () => {}, tickElapsed: () => {}, setRunBtn: () => {}, renderVarStrip: () => {},
    setExportBtn: () => {}, specBlocked: () => false, evaluateSpecDraft: () => ({}),
    revealFirstSpecError: () => {}, registerSpecValidator: () => () => {}, openSavePopover: () => {},
    renderApp: () => {}, renderDashboard: () => {}, openDashboard: () => {}, recordHistory: () => {},
    actions: { ...app.actions, openUserMenu: () => {}, openDashboard: () => {} },
    chCtx: {
      ...app.chCtx, fetch, origin: '', authConfirmed: true,
      getToken: async () => null, refresh: async () => false, authHeader: () => '',
    },
  };
  return Object.assign(app, patch) as TestApp;
}

/** The historical `resultView` values this file's fixtures set — 'chart'
 *  predates #166 (superseded by the Panel registry's 'panel' view) and is
 *  never read by chart-render.ts itself; kept only so `appWithResult`'s
 *  setup reads the same as before conversion. */
type LegacyResultView = AppState['resultView']['value'] | 'chart';
interface StateOverride {
  resultView?: LegacyResultView;
  running?: boolean;
}

function appWithResult(result: StreamResult, over: StateOverride = {}): TestApp {
  const app = asApp(makeApp());
  app.activeTab().result = result;
  if (over.resultView !== undefined) app.state.resultView.value = over.resultView as AppState['resultView']['value'];
  if (over.running !== undefined) app.state.running.value = over.running;
  return app;
}

function tableResult(): StreamResult {
  const r = newResult('Table');
  r.columns = [{ name: 'n', type: 'UInt64' }, { name: 's', type: 'String' }];
  r.rows = [['2', 'b'], ['1', null]];
  r.progress = { rows: 2, bytes: 100, elapsed_ns: 5e6 };
  return r;
}

// A result with two measures + two category columns, for multi-series/group-by.
function chartResult(): StreamResult {
  const r = newResult('Table');
  r.columns = [
    { name: 'carrier', type: 'String' },
    { name: 'region', type: 'String' },
    { name: 'flights', type: 'UInt64' },
    { name: 'delay', type: 'Float64' },
  ];
  r.rows = [['B6', 'E', '10', '5.5'], ['AA', 'W', '20', '6.5']];
  r.progress = { rows: 2, bytes: 100, elapsed_ns: 5e6 };
  return r;
}
const fieldSel = (el: Element, label: string): HTMLSelectElement => [...el.querySelectorAll('.chart-field')]
  .find((f) => f.querySelector('.chart-field-label')!.textContent === label)!.querySelector('select')!;
const change = (sel: HTMLSelectElement, value: string) => { sel.value = value; sel.dispatchEvent(new Event('change', { bubbles: true })); };

// A minimal holder-mode paint loop standing in for the old results-pane chart
// view: destroy-before-rebuild via app.chart (the default setChart slot) and
// a rerender that repaints this same region — renderChart's own contract.
function paintChart(app: TestApp): void {
  const region = app.dom.resultsRegion!;
  const paint = () => {
    if (app.chart) { app.chart.destroy(); app.chart = undefined; }
    const tab = app.activeTab();
    const result = tab.result as StreamResult;
    const key = schemaKey(result.columns);
    if (tab.panelKey !== key || !chartCfgValid(tab.panelCfg, result.columns)) {
      tab.panelCfg = autoChart(result.columns);
      tab.panelKey = key;
    }
    region.replaceChildren(renderChart(app, result, {
      cfg: tab.panelCfg ?? undefined,
      rerender: paint,
      onCfgChange: (cfg) => { tab.panelCfg = cfg as ChartConfig; paint(); },
    }));
  };
  paint();
}

describe('renderChart', () => {
  it('shows a not-chartable hint when no measure exists', () => {
    const r = newResult('Table');
    r.columns = [{ name: 'a', type: 'String' }];
    r.rows = [['x']];
    const app = appWithResult(r, { resultView: 'chart' });
    expect(renderChart(app, r).textContent).toContain('aren’t chartable');
  });
  it('renders a caller-resolved cfg independently of run state (the panel caller owns the run gate)', () => {
    const app = appWithResult(tableResult(), { resultView: 'chart', running: true });
    const result = app.activeTab().result as StreamResult;
    const cfg = autoChart(result.columns);
    expect(renderChart(app, result, { cfg: cfg ?? undefined, controls: false }).querySelector('canvas')).not.toBeNull();
  });
  it('builds a config bar and instantiates Chart.js on a canvas (categorical → hbar default)', () => {
    const app = appWithResult(tableResult(), { resultView: 'chart' });
    paintChart(app);
    const view = app.dom.resultsRegion!.querySelector('.chart-view')!;
    expect(view.querySelector('canvas')).not.toBeNull();
    expect(app.chart).not.toBeNull();
    expect(app.chart!.config.type).toBe('bar'); // hbar maps to bar + indexAxis y
    expect(app.chart!.config.options.indexAxis).toBe('y');
    expect(app.activeTab().panelCfg).toMatchObject({ type: 'hbar', x: 1, y: [0] });
  });
  it('keeps a restored chart config when its schema key matches the result (saved/shared restore)', () => {
    const r = chartResult();
    const app = appWithResult(r, { resultView: 'chart' });
    const tab = app.activeTab();
    tab.panelKey = schemaKey(r.columns);
    tab.panelCfg = { type: 'pie', x: 0, y: [2], series: null }; // a deliberate non-default
    paintChart(app);
    expect(app.activeTab().panelCfg).toEqual({ type: 'pie', x: 0, y: [2], series: null }); // not re-derived
    expect(app.chart!.config.type).toBe('pie');
  });
  it('falls back to autoChart when a restored config does not fit the schema (hand-edited link)', () => {
    const r = chartResult();
    const app = appWithResult(r, { resultView: 'chart' });
    const tab = app.activeTab();
    tab.panelKey = schemaKey(r.columns);
    tab.panelCfg = { type: 'bar', x: 99, y: [1], series: null }; // x out of range
    paintChart(app);
    expect(app.activeTab().panelCfg!.x).toBeLessThan(r.columns.length); // guard re-derived a safe default
    expect(app.chart).not.toBeNull();
  });
  it('Type select switches renderer; non-pie keeps series, pie resets it to single-measure', () => {
    const app = appWithResult(chartResult(), { resultView: 'chart' });
    paintChart(app);
    // group-by first so we can prove pie clears it
    change(fieldSel(app.dom.resultsRegion!, 'Series'), '1');
    expect(app.activeTab().panelCfg!.series).toBe(1);
    change(fieldSel(app.dom.resultsRegion!, 'Type'), 'line'); // non-pie branch
    expect(app.activeTab().panelCfg!.type).toBe('line');
    change(fieldSel(app.dom.resultsRegion!, 'Type'), 'pie'); // pie branch resets series
    expect(app.activeTab().panelCfg).toMatchObject({ type: 'pie', series: null });
    expect(fieldSel(app.dom.resultsRegion!, 'Type')).not.toBeNull();
    expect([...app.dom.resultsRegion!.querySelectorAll('.chart-field-label')].map((s) => s.textContent))
      .not.toContain('Series'); // series control hidden for pie
  });
  it('shows one type-specific Style selector after Type and before X', () => {
    const app = appWithResult(chartResult(), { resultView: 'chart' });
    paintChart(app);
    expect([...app.dom.resultsRegion!.querySelectorAll('.chart-field-label')].map((el) => el.textContent).slice(0, 3))
      .toEqual(['Type', 'Style', 'X']);
    for (const type of ['hbar', 'bar', 'line', 'area', 'pie']) {
      change(fieldSel(app.dom.resultsRegion!, 'Type'), type);
      expect([...fieldSel(app.dom.resultsRegion!, 'Style').options].map((option) => option.textContent))
        .toEqual(chartStylePresets(type).map((preset) => preset.label));
    }
    expect([...fieldSel(app.dom.resultsRegion!, 'Style').options].map((option) => option.textContent))
      .toEqual(['Pie', 'Donut', 'Compact']);
  });
  it.each([
    ...Object.entries(CHART_STYLE_PRESETS).flatMap(([type, presets]) => (
      // Bar/Column share the same frozen contract; one application test per internal type is intentional.
      presets.map((preset) => [type, preset.value, preset.style])
    )),
  ])('writes the %s %s Style preset once and preserves extensions', (type, preset, expectedStyle) => {
    const app = appWithResult(chartResult());
    const sourceStyle = {
      ...(type === 'pie' ? { shape: 'future-shape' }
        : type === 'bar' || type === 'hbar' ? { mode: 'future-mode' }
          : { curve: 'future-curve' }),
      future: 1,
    };
    const cfg = { type, x: 0, y: [2], series: null, style: sourceStyle } as ChartConfig;
    const onCfgChange = vi.fn();
    const rerender = vi.fn();
    const el = renderChart(app, app.activeTab().result as StreamResult, { cfg, onCfgChange, rerender });
    const custom = fieldSel(el, 'Style').selectedOptions[0];
    expect(custom.value).toBe('custom');
    expect(custom.disabled).toBe(true);
    change(fieldSel(el, 'Style'), preset as string);
    expect(cfg.style).toEqual({ ...sourceStyle, ...(expectedStyle as object) });
    expect(onCfgChange).toHaveBeenCalledTimes(1);
    expect(onCfgChange).toHaveBeenCalledWith(cfg);
    expect(rerender).not.toHaveBeenCalled();
  });
  it('preserves complete dormant style while switching types', () => {
    const app = appWithResult(chartResult(), { resultView: 'chart' });
    const tab = app.activeTab();
    tab.panelCfg = {
      type: 'line', x: 0, y: [2], series: null,
      style: { curve: 'stepped', points: 'hide', mode: 'stacked', density: 'compact', shape: 'donut',
        scale: 'data', legend: 'hide', grid: 'hide', axes: 'show', frame: 'compact', future: true },
    };
    tab.panelKey = schemaKey((tab.result as StreamResult).columns);
    paintChart(app);
    expect(fieldSel(app.dom.resultsRegion!, 'Style').value).toBe('custom');
    const savedStyle = structuredClone(app.activeTab().panelCfg!.style);
    change(fieldSel(app.dom.resultsRegion!, 'Type'), 'bar');
    expect(app.activeTab().panelCfg!.style).toEqual(savedStyle);
    change(fieldSel(app.dom.resultsRegion!, 'Type'), 'line');
    expect(fieldSel(app.dom.resultsRegion!, 'Style').value).toBe('custom');
    expect(app.activeTab().panelCfg).toMatchObject({ style: savedStyle });
  });
  it('uses reduced canvas padding only for Compact Pie', () => {
    const app = appWithResult(chartResult());
    const result = app.activeTab().result as StreamResult;
    const compact = renderChart(app, result, {
      cfg: { type: 'pie', x: 0, y: [2], series: null, style: { frame: 'compact' } } as ChartConfig, rerender: vi.fn(),
    });
    expect(compact.querySelector('.chart-canvas-wrap')!.classList.contains('is-compact')).toBe(true);
    const normal = renderChart(app, result, {
      cfg: { type: 'pie', x: 0, y: [2], series: null, style: { frame: 'normal' } } as ChartConfig, rerender: vi.fn(),
    });
    expect(normal.querySelector('.chart-canvas-wrap')!.classList.contains('is-compact')).toBe(false);
    const dormant = renderChart(app, result, {
      cfg: { type: 'line', x: 0, y: [2], series: null, style: { frame: 'compact' } } as ChartConfig, rerender: vi.fn(),
    });
    expect(dormant.querySelector('.chart-canvas-wrap')!.classList.contains('is-compact')).toBe(false);
  });
  it('X and Y selects update the per-tab config', () => {
    const app = appWithResult(chartResult(), { resultView: 'chart' });
    paintChart(app);
    change(fieldSel(app.dom.resultsRegion!, 'X'), '1');
    expect(app.activeTab().panelCfg!.x).toBe(1);
    change(fieldSel(app.dom.resultsRegion!, 'Y'), '3');
    expect(app.activeTab().panelCfg!.y).toEqual([3]);
  });
  it('keeps filtered role selectors usable when imported values are unavailable', () => {
    const app = appWithResult(chartResult());
    const result = app.activeTab().result as StreamResult;
    const unavailableY = renderChart(app, result, {
      cfg: { type: 'line', x: 1, y: [0], series: null } as ChartConfig, rerender: vi.fn(),
    });
    expect(fieldSel(unavailableY, 'Y').value).toBe('2'); // first numeric column, never blank

    const unavailableSeries = renderChart(app, result, {
      cfg: { type: 'line', x: 1, y: [2], series: 3 } as ChartConfig, rerender: vi.fn(),
    });
    expect(fieldSel(unavailableSeries, 'Series').value).toBe(''); // explicit no-series fallback
  });
  it('uses the direct rerender seam when no onCfgChange owner is supplied', () => {
    const app = appWithResult(chartResult());
    const rerender = vi.fn();
    const result = app.activeTab().result as StreamResult;
    const cfg = autoChart(result.columns)!;
    const el = renderChart(app, result, { cfg, rerender });
    change(fieldSel(el, 'X'), '1');
    expect(cfg.x).toBe(1);
    expect(rerender).toHaveBeenCalledTimes(1);
  });
  it('"All measures" toggles between single and multi-series', () => {
    const app = appWithResult(chartResult(), { resultView: 'chart' });
    paintChart(app);
    const btn = () => [...app.dom.resultsRegion!.querySelectorAll('.chart-toggle')][0];
    expect(btn().textContent).toBe('All measures');
    click(btn());
    expect(app.activeTab().panelCfg!.y).toEqual([2, 3]);
    expect(app.chart!.config.data.datasets).toHaveLength(2);
    expect(btn().textContent).toBe('Single series');
    click(btn());
    expect(app.activeTab().panelCfg!.y).toEqual([2]);
  });
  it('Series select sets and clears a group-by dimension', () => {
    const app = appWithResult(chartResult(), { resultView: 'chart' });
    paintChart(app);
    change(fieldSel(app.dom.resultsRegion!, 'Series'), '1');
    expect(app.activeTab().panelCfg!.series).toBe(1);
    change(fieldSel(app.dom.resultsRegion!, 'Series'), '');
    expect(app.activeTab().panelCfg!.series).toBeNull();
  });
  it('notes the row cap when the result is larger than the chart shows', () => {
    const r = newResult('Table');
    r.columns = [{ name: 'k', type: 'String' }, { name: 'v', type: 'UInt64' }];
    r.rows = Array.from({ length: 600 }, (_, i) => ['k' + i, String(i)]);
    r.progress = { rows: 600, bytes: 100, elapsed_ns: 5e6 };
    const app = appWithResult(r, { resultView: 'chart' });
    paintChart(app);
    const note = app.dom.resultsRegion!.querySelector('.chart-cap-note');
    expect(note).not.toBeNull();
    expect(note!.textContent).toContain('first 500 of');
    // a small result shows no cap note
    const small = appWithResult(tableResult(), { resultView: 'chart' });
    paintChart(small);
    expect(small.dom.resultsRegion!.querySelector('.chart-cap-note')).toBeNull();
  });
  it('switching chart type re-slices to the new type\'s cap and updates the note', () => {
    const r = newResult('Table');
    r.columns = [{ name: 'k', type: 'String' }, { name: 'v', type: 'UInt64' }];
    r.rows = Array.from({ length: 600 }, (_, i) => ['k' + i, String(i)]);
    r.progress = { rows: 600, bytes: 100, elapsed_ns: 5e6 };
    const app = appWithResult(r, { resultView: 'chart' });
    paintChart(app);
    // default (hbar, autoChart's categorical pick) cap is 500 < 600 rows
    expect(app.activeTab().panelCfg!.type).toBe('hbar');
    expect(app.dom.resultsRegion!.querySelector('.chart-cap-note')!.textContent)
      .toBe('first ' + chartRowCap('hbar') + ' of 600 rows');
    expect(app.chart!.config.data.labels).toHaveLength(chartRowCap('hbar'));
    // switch to pie: a much tighter legibility cap — re-slices and the note shrinks with it
    change(fieldSel(app.dom.resultsRegion!, 'Type'), 'pie');
    expect(app.dom.resultsRegion!.querySelector('.chart-cap-note')!.textContent).toContain('first ' + chartRowCap('pie') + ' of');
    expect(app.chart!.config.data.labels).toHaveLength(chartRowCap('pie'));
    // switch to line: its cap (5000) exceeds the row count — no truncation, no note at all
    change(fieldSel(app.dom.resultsRegion!, 'Type'), 'line');
    expect(app.dom.resultsRegion!.querySelector('.chart-cap-note')).toBeNull();
    expect(app.chart!.config.data.labels).toHaveLength(600);
  });
  it('destroys the previous Chart instance on re-render, and re-derives config on a new schema', () => {
    const app = appWithResult(chartResult(), { resultView: 'chart' });
    paintChart(app);
    const first = app.chart;
    const cfg = app.activeTab().panelCfg;
    paintChart(app); // stable schema → keep config, swap chart instance
    expect(first!.destroyed).toBe(true);
    expect(app.chart).not.toBe(first);
    expect(app.activeTab().panelCfg).toBe(cfg);
    app.activeTab().result = tableResult(); // different schema → re-derive
    paintChart(app);
    expect(app.activeTab().panelCfg).not.toBe(cfg);
  });
  it('does not mutate a caller-owned restored config while rendering', () => {
    const app = appWithResult(chartResult(), { resultView: 'chart', running: true });
    const restored = { type: 'pie', x: 0, y: [2], series: null } as ChartConfig;
    renderChart(app, app.activeTab().result as StreamResult, { cfg: restored, controls: false });
    expect(restored).toEqual({ type: 'pie', x: 0, y: [2], series: null });
  });
  it('passes field metadata to Chart.js for display names and formatting', () => {
    const app = appWithResult(chartResult());
    const cfg = { type: 'line', x: 0, y: [2], series: null } as ChartConfig;
    renderChart(app, app.activeTab().result as StreamResult, {
      cfg, controls: false,
      fieldConfig: { columns: { flights: { displayName: 'Flights', unit: ' trips', decimals: 0 } } },
    });
    expect(app.chart!.config.data.datasets[0].label).toBe('Flights');
    expect(app.chart!.config.options.scales.y.ticks.callback(12)).toBe('12 trips');
  });
  it('keeps authoring controls but shows an empty state when every selected field is hidden', () => {
    const app = appWithResult(chartResult());
    const result = app.activeTab().result as StreamResult;
    const cfg = { type: 'line', x: 0, y: [2], series: null } as ChartConfig;
    const el = renderChart(app, result, {
      cfg, rerender: vi.fn(), fieldConfig: { columns: { flights: { hidden: true } } },
    });
    expect(el.textContent).toContain('All selected chart fields are hidden by panel.fieldConfig.');
    expect(fieldSel(el, 'Y').value).toBe('2');
    expect(el.querySelector('canvas')).toBeNull();
    expect(app.chart).toBeUndefined();
    expect(cfg.y).toEqual([2]);

    const readonly = renderChart(app, result, {
      cfg, controls: false, fieldConfig: { columns: { flights: { hidden: true } } },
    });
    expect(readonly.querySelector('.chart-config')).toBeNull();
    expect(readonly.textContent).toContain('All selected chart fields are hidden');
  });
  it('normalizes a restored, self-contradictory pie config (multi-measure + series) on render', () => {
    const r = chartResult();
    const app = appWithResult(r, { resultView: 'chart' });
    const tab = app.activeTab();
    tab.panelKey = schemaKey(r.columns); // in-range but invalid combination
    tab.panelCfg = { type: 'pie', x: 0, y: [2, 3], series: 1 };
    paintChart(app);
    expect(app.activeTab().panelCfg).toEqual({ type: 'pie', x: 0, y: [2], series: null });
    expect(app.chart!.config.data.datasets).toHaveLength(1); // single pie dataset
  });
  it('clears the series when the X column is changed to equal it', () => {
    const app = appWithResult(chartResult(), { resultView: 'chart' });
    paintChart(app);
    change(fieldSel(app.dom.resultsRegion!, 'Series'), '1'); // series = region(1)
    expect(app.activeTab().panelCfg!.series).toBe(1);
    change(fieldSel(app.dom.resultsRegion!, 'X'), '1'); // X now equals series → series cleared
    expect(app.activeTab().panelCfg!.x).toBe(1);
    expect(app.activeTab().panelCfg!.series).toBeNull();
  });
  it("forces an explicit resize + 'resize'-mode update once attached, working around Chart.js's cross-window responsive sizing", async () => {
    const app = appWithResult(chartResult(), { resultView: 'chart' });
    paintChart(app);
    const canvas = app.dom.resultsRegion!.querySelector('canvas')!;
    const wrap = canvas.parentElement!;
    Object.defineProperty(wrap, 'offsetWidth', { value: 640, configurable: true });
    Object.defineProperty(wrap, 'offsetHeight', { value: 320, configurable: true });
    await new Promise((resolve) => window.requestAnimationFrame(resolve)); // let the scheduled rAF run
    expect(app.chart!.lastResize).toEqual([640, 320]);
    expect(app.chart!.lastUpdateMode).toBe('resize');
  });
  it('skips the forced resize when the container never gets a real size (e.g. torn down before the rAF fires)', async () => {
    const app = appWithResult(chartResult(), { resultView: 'chart' });
    paintChart(app);
    const chart = app.chart;
    await new Promise((resolve) => window.requestAnimationFrame(resolve)); // offsetWidth/Height are 0 in happy-dom by default
    expect(chart!.lastResize).toBeUndefined();
    expect(chart!.lastUpdateMode).toBeUndefined();
  });
});
