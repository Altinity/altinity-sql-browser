// Pure helpers for the chart result view. Everything here is DOM-free and
// library-agnostic up to the final `chartJsConfig`, which assembles a plain
// Chart.js config *object* (no canvas, no globals) — so the whole role/axis/
// pivot/scale layer is unit-testable at 100% and the DOM glue in
// `ui/results.js` stays a thin wrapper around `new Chart(canvas, config)`.

import { isNumericType } from './format.js';
import { hasFieldValueFormat, resolveFieldConfig } from './field-config.js';

const TIME_RE = /^(Date|DateTime)/;
// Numeric columns whose *name is exactly* a calendar bucket (year, month, …)
// are ordinal, not free measures — a `GROUP BY toYear(...) AS year` is an X
// axis. Anchored at both ends (optional plural) so a real measure like
// `monthly_revenue` / `minutes_watched` / `dayrate` stays a measure rather
// than being misclassified by a mere prefix and dropped from autoChart.
const ORDINAL_RE = /^(year|quarter|month|week|day|dayofweek|dow|hour|minute)s?$/i;

// Plots past this get unreadable, so each chart type shows only its first N
// rows (the table stays full) — the readable ceiling differs by shape: pie
// legibility caps out around 20-30 slices regardless of monitor width; bar/
// column are bound by minimum bar+gap width for legible category ticks;
// line/area are point-density bound, so a wide canvas can plot thousands of
// points before individual ones blur together. Exported so the renderer can
// surface the truncation to the user.
export const CHART_ROW_CAPS = { pie: 30, hbar: 500, bar: 1000, line: 5000, area: 5000 };

/** The row cap for a chart type, falling back to 500 (the old flat cap) for an unmapped type. */
export function chartRowCap(type) {
  return CHART_ROW_CAPS[type] ?? 500;
}

/** Strip `Nullable(...)` / `LowCardinality(...)` wrappers down to the base type. */
export function chartStripType(type) {
  let p = String(type || '');
  let m;
  while ((m = /^(?:Nullable|LowCardinality)\((.*)\)$/.exec(p))) p = m[1];
  return p;
}

/**
 * Classify a column for charting from its ClickHouse type (and, for numbers,
 * its name): 'time' | 'ordinal' | 'measure' | 'category'.
 */
export function chartRole(col) {
  const t = chartStripType(col && col.type);
  if (TIME_RE.test(t)) return 'time';
  // Wrappers already stripped, so reuse the table's numeric test on the base type.
  if (isNumericType(t)) return ORDINAL_RE.test((col && col.name) || '') ? 'ordinal' : 'measure';
  return 'category';
}

/**
 * Default chart config from column roles, or null when nothing is plottable
 * (no numeric measure). Temporal X → line, categorical X → horizontal bar,
 * ordinal X → vertical column. The config bar lets the user override the rest.
 * Returns { type, x, y:[idx], series:null }.
 */
export function autoChart(columns) {
  const cols = columns || [];
  const roles = cols.map((c, i) => ({ i, role: chartRole(c) }));
  const measures = roles.filter((r) => r.role === 'measure').map((r) => r.i);
  if (!measures.length) return null;
  // A measure exists ⇒ roles is non-empty ⇒ the `|| roles[0]` fallback always
  // resolves, so x is guaranteed defined here.
  const x = roles.find((r) => r.role === 'time')
    || roles.find((r) => r.role === 'ordinal')
    || roles.find((r) => r.role === 'category')
    || roles[0];
  const type = x.role === 'time' ? 'line' : x.role === 'category' ? 'hbar' : 'bar';
  return { type, x: x.i, y: [measures[0]], series: null };
}

/** A stable signature of the result schema; chart config is re-derived when it changes. */
export function schemaKey(columns) {
  return (columns || []).map((c) => c.name + ':' + c.type).join('|');
}

/** The chart types offered in the config bar (Bar = horizontal, Column = vertical). */
export const CHART_TYPES = [
  { value: 'hbar', label: 'Bar' },
  { value: 'bar', label: 'Column' },
  { value: 'line', label: 'Line' },
  { value: 'area', label: 'Area' },
  { value: 'pie', label: 'Pie' },
];

const display = (scale, legend = 'auto', grid = 'auto', axes = 'show') => ({ scale, legend, grid, axes });

const LINE_STYLE_PRESETS = [
  { value: 'clean', label: 'Clean', style: { curve: 'linear', points: 'auto' }, display: display('data') },
  { value: 'smooth', label: 'Smooth', style: { curve: 'smooth', points: 'auto' }, display: display('data') },
  { value: 'stepped', label: 'Stepped', style: { curve: 'stepped', points: 'auto' }, display: display('data') },
  { value: 'points', label: 'Points', style: { curve: 'linear', points: 'show' }, display: display('data') },
  { value: 'zero', label: 'Zero-based', style: { curve: 'linear', points: 'auto' }, display: display('zero') },
  { value: 'minimal', label: 'Minimal', style: { curve: 'linear', points: 'hide' }, display: display('data', 'hide', 'hide') },
  { value: 'sparkline', label: 'Sparkline', style: { curve: 'linear', points: 'hide' }, display: display('data', 'hide', 'hide', 'hide') },
];

const AREA_STYLE_PRESETS = [
  ...LINE_STYLE_PRESETS.slice(0, 4).map((preset) => ({
    ...preset, style: { ...preset.style, stack: 'overlay' }, display: { ...preset.display },
  })),
  { value: 'stacked', label: 'Stacked', style: { curve: 'linear', points: 'auto', stack: 'stacked' }, display: display('data') },
  ...LINE_STYLE_PRESETS.slice(4).map((preset) => ({
    ...preset, style: { ...preset.style, stack: 'overlay' }, display: { ...preset.display },
  })),
];

const BAR_STYLE_PRESETS = [
  { value: 'grouped', label: 'Grouped', style: { mode: 'grouped', density: 'normal' }, display: display('zero') },
  { value: 'stacked', label: 'Stacked', style: { mode: 'stacked', density: 'normal' }, display: display('zero') },
  { value: 'compact', label: 'Compact', style: { mode: 'grouped', density: 'compact' }, display: display('zero') },
  { value: 'joined', label: 'Joined', style: { mode: 'grouped', density: 'joined' }, display: display('zero') },
  { value: 'minimal', label: 'Minimal', style: { mode: 'grouped', density: 'compact' }, display: display('zero', 'hide', 'hide') },
  { value: 'data', label: 'Data range', style: { mode: 'grouped', density: 'normal' }, display: display('data') },
];

const PIE_STYLE_PRESETS = [
  { value: 'pie', label: 'Pie', style: { shape: 'pie' }, display: { legend: 'show', frame: 'normal' } },
  { value: 'donut', label: 'Donut', style: { shape: 'donut' }, display: { legend: 'show', frame: 'normal' } },
  { value: 'compact', label: 'Compact', style: { shape: 'donut' }, display: { legend: 'hide', frame: 'compact' } },
];

/** Complete Style-selector presets by chart type (`hbar` is the Bar label). */
export const CHART_STYLE_PRESETS = {
  hbar: BAR_STYLE_PRESETS,
  bar: BAR_STYLE_PRESETS,
  line: LINE_STYLE_PRESETS,
  area: AREA_STYLE_PRESETS,
  pie: PIE_STYLE_PRESETS,
};

export function chartStylePresets(type) {
  return CHART_STYLE_PRESETS[type] || [];
}

const CHART_CURVES = new Set(['linear', 'smooth', 'stepped']);
const CHART_POINTS = new Set(['auto', 'show', 'hide']);
const CHART_STACKS = new Set(['overlay', 'stacked']);
const CHART_BAR_MODES = new Set(['grouped', 'stacked']);
const CHART_BAR_DENSITIES = new Set(['normal', 'compact', 'joined']);
const CHART_PIE_SHAPES = new Set(['pie', 'donut']);
const CHART_SCALES = new Set(['auto', 'zero', 'data']);
const CHART_VISIBILITY = new Set(['auto', 'show', 'hide']);
const CHART_AXES = new Set(['show', 'hide']);
const CHART_FRAMES = new Set(['normal', 'compact']);
const CHART_STYLE_FIELDS = {
  hbar: { mode: CHART_BAR_MODES, density: CHART_BAR_DENSITIES },
  bar: { mode: CHART_BAR_MODES, density: CHART_BAR_DENSITIES },
  line: { curve: CHART_CURVES, points: CHART_POINTS },
  area: { curve: CHART_CURVES, points: CHART_POINTS, stack: CHART_STACKS },
  pie: { shape: CHART_PIE_SHAPES },
};
const CHART_DISPLAY_FIELDS = {
  hbar: { scale: CHART_SCALES, legend: CHART_VISIBILITY, grid: CHART_VISIBILITY, axes: CHART_AXES },
  bar: { scale: CHART_SCALES, legend: CHART_VISIBILITY, grid: CHART_VISIBILITY, axes: CHART_AXES },
  line: { scale: CHART_SCALES, legend: CHART_VISIBILITY, grid: CHART_VISIBILITY, axes: CHART_AXES },
  area: { scale: CHART_SCALES, legend: CHART_VISIBILITY, grid: CHART_VISIBILITY, axes: CHART_AXES },
  pie: { legend: CHART_VISIBILITY, frame: CHART_FRAMES },
};

/** Resolve renderer-independent, type-specific style without mutating imported data. */
export function normalizeChartStyle(style, type = 'line') {
  const value = style && typeof style === 'object' && !Array.isArray(style) ? style : {};
  if (type === 'hbar' || type === 'bar') return {
    mode: CHART_BAR_MODES.has(value.mode) ? value.mode : 'grouped',
    density: CHART_BAR_DENSITIES.has(value.density) ? value.density : 'normal',
  };
  if (type === 'pie') return { shape: CHART_PIE_SHAPES.has(value.shape) ? value.shape : 'pie' };
  return {
    curve: CHART_CURVES.has(value.curve) ? value.curve : 'linear',
    points: CHART_POINTS.has(value.points) ? value.points : 'auto',
    ...(type === 'area' ? { stack: CHART_STACKS.has(value.stack) ? value.stack : 'overlay' } : {}),
  };
}

/** Resolve renderer-independent display chrome relevant to the current type. */
export function normalizeChartDisplay(value, type = 'line') {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  if (type === 'pie') return {
    legend: CHART_VISIBILITY.has(source.legend) ? source.legend : 'show',
    frame: CHART_FRAMES.has(source.frame) ? source.frame : 'normal',
  };
  return {
    scale: CHART_SCALES.has(source.scale) ? source.scale : type === 'hbar' || type === 'bar' ? 'zero' : 'data',
    legend: CHART_VISIBILITY.has(source.legend) ? source.legend : 'auto',
    grid: CHART_VISIBILITY.has(source.grid) ? source.grid : 'auto',
    axes: CHART_AXES.has(source.axes) ? source.axes : 'show',
  };
}

/** Match every preset-owned field exactly; unusual advanced combinations stay Custom. */
export function chartStylePreset(style, displayValue, type) {
  const styleSource = style && typeof style === 'object' && !Array.isArray(style) ? style : {};
  const displaySource = displayValue && typeof displayValue === 'object' && !Array.isArray(displayValue) ? displayValue : {};
  if (Object.entries(CHART_STYLE_FIELDS[type] || {})
    .some(([field, supported]) => field in styleSource && !supported.has(styleSource[field]))) return 'custom';
  if (Object.entries(CHART_DISPLAY_FIELDS[type] || {})
    .some(([field, supported]) => field in displaySource && !supported.has(displaySource[field]))) return 'custom';
  const normalizedStyle = normalizeChartStyle(style, type);
  const normalizedDisplay = normalizeChartDisplay(displayValue, type);
  const matched = chartStylePresets(type).find((preset) => (
    Object.keys(preset.style).every((field) => normalizedStyle[field] === preset.style[field])
      && Object.keys(preset.display).every((field) => normalizedDisplay[field] === preset.display[field])
  ));
  return matched ? matched.value : 'custom';
}

/** Apply one UI preset while retaining unknown and dormant extensions. */
export function applyChartStylePreset(style, displayValue, preset, type) {
  const styleBase = style && typeof style === 'object' && !Array.isArray(style) ? style : {};
  const displayBase = displayValue && typeof displayValue === 'object' && !Array.isArray(displayValue) ? displayValue : {};
  const presets = chartStylePresets(type);
  const picked = presets.find((item) => item.value === preset) || presets[0];
  return picked
    ? { style: { ...styleBase, ...picked.style }, display: { ...displayBase, ...picked.display } }
    : { style: { ...styleBase }, display: { ...displayBase } };
}

/** Deterministic marker density rule over the final rendered labels/datasets. */
export function shouldShowChartPoints(labels, datasets) {
  return (labels || []).length <= 60 && (datasets || []).length <= 4;
}

const CHART_TYPE_SET = new Set(CHART_TYPES.map((t) => t.value));

/**
 * Deep-clone a chart config (`y` is an array) so a config restored from a saved
 * query / share link never shares a reference with its source — editing the
 * restored chart must not mutate the saved entry. null → null.
 */
export function cloneChartCfg(cfg) {
  if (!cfg) return null;
  const out = { ...cfg, y: [...(cfg.y || [])], series: cfg.series ?? null };
  if (cfg.style && typeof cfg.style === 'object') {
    out.style = JSON.parse(JSON.stringify(cfg.style));
  }
  if (cfg.display && typeof cfg.display === 'object') {
    out.display = JSON.parse(JSON.stringify(cfg.display));
  }
  return out;
}

/**
 * Is a (possibly untrusted) chart config structurally valid for `columns`?
 * Restored configs come from saved JSON / a URL hash a user can hand-edit, so
 * before `chartJsConfig` dereferences `cfg.x` / `cfg.y[i]` / `cfg.series` as
 * column indices we confirm the type is known and every index is in range —
 * otherwise the caller falls back to `autoChart`.
 */
export function chartCfgValid(cfg, columns) {
  if (!cfg || typeof cfg !== 'object') return false;
  const n = (columns || []).length;
  const idxOk = (i) => Number.isInteger(i) && i >= 0 && i < n;
  if (!CHART_TYPE_SET.has(cfg.type)) return false;
  if (!idxOk(cfg.x)) return false;
  if (!Array.isArray(cfg.y) || cfg.y.length === 0 || !cfg.y.every(idxOk)) return false;
  if (cfg.series != null && !idxOk(cfg.series)) return false;
  return true;
}

/**
 * Derive the config-bar option lists + visibility flags for the current config.
 * Pure so the glue just maps these to <select> elements. `cfg.y` is an array of
 * column indices; `cfg.series` is an index or null.
 */
export function chartFieldOptions(columns, cfg) {
  const opt = (i) => ({ value: String(i), label: columns[i].name });
  const roleOf = (i) => chartRole(columns[i]);
  // Y is pickable from any number (measures + ordinal buckets); but the
  // "All measures" bulk toggle plots only true measures, never the X column —
  // so it can't end up charting an ordinal axis against itself.
  const numericIdx = columns.map((c, i) => i).filter((i) => roleOf(i) === 'measure' || roleOf(i) === 'ordinal');
  const catIdx = columns.map((c, i) => i).filter((i) => roleOf(i) !== 'measure');
  const allMeasures = columns.map((c, i) => i).filter((i) => roleOf(i) === 'measure' && i !== cfg.x);
  const seriesOptions = [{ value: '', label: 'None' }, ...catIdx.filter((i) => i !== cfg.x).map(opt)];
  const isPie = cfg.type === 'pie';
  return {
    typeOptions: CHART_TYPES,
    xOptions: columns.map((c, i) => opt(i)),
    yOptions: numericIdx.map(opt),
    seriesOptions,
    showSeries: !isPie && seriesOptions.length > 1,
    showMulti: !isPie && allMeasures.length > 1 && cfg.series == null,
    multiActive: (cfg.y || []).length > 1,
    allMeasures,
  };
}

/**
 * Humanize a numeric axis tick/value (M/K suffixes, 2dp). Deliberately separate
 * from format.js:formatRows — axis values can be fractional and carry one
 * decimal of suffix precision, whereas formatRows targets integer row counts.
 * Same magnitude can therefore read slightly differently on an axis vs a count.
 */
export function chartNumFmt(v) {
  if (typeof v !== 'number' || !isFinite(v)) return String(v);
  const a = Math.abs(v);
  if (a >= 1e6) return (v / 1e6).toFixed(1) + 'M';
  if (a >= 1e3) return (v / 1e3).toFixed(1) + 'K';
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
}

/** Format one measure value from resolved field metadata, without scaling it. */
export function formatChartValue(value, presentation = {}) {
  if (value == null || value === '') return presentation.noValue ?? '—';
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return presentation.noValue ?? '—';
  const normalized = Object.is(numeric, -0) ? 0 : numeric;
  const exactDecimals = Number.isInteger(presentation.decimals)
    && presentation.decimals >= 0 && presentation.decimals <= 20;
  const rendered = exactDecimals
    ? normalized.toFixed(presentation.decimals)
    : String(normalized);
  return rendered + (typeof presentation.unit === 'string' ? presentation.unit : '');
}

/**
 * Format an X label. A date-like value is trimmed to a readable tick: just the
 * date (YYYY-MM-DD) for a Date or a midnight DateTime (day-level aggregations),
 * and date + HH:MM when it carries an actual intraday time, so two timestamps on
 * the same day don't collapse to the same tick. Anything else stringifies.
 * Display only — `buildChartData` groups on the raw cell value regardless.
 */
export function chartLabel(v) {
  const sv = String(v);
  const m = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}))?/.exec(sv);
  if (!m) return sv;
  return m[1] && m[2] && m[2] !== '00:00' ? `${m[1]} ${m[2]}` : m[1];
}

/**
 * Fold a config's cross-field invariants so a hand-edited share link / imported
 * saved query, or a live X change, can't produce a degenerate chart:
 *  - a series equal to the X column would pivot a column against itself → clear it;
 *  - a pie is single-measure with no group-by → drop series + extra measures.
 * Mutates and returns `cfg` (null → null). Index ranges are still policed by
 * `chartCfgValid`; this only enforces relationships between valid indices.
 */
export function normalizeChartCfg(cfg) {
  if (!cfg) return cfg;
  // #256 briefly stored display fields inside `style`. Fold those values into
  // the canonical object on read without deleting the original extensions.
  if (cfg.style && typeof cfg.style === 'object' && !Array.isArray(cfg.style)) {
    const legacyFields = ['scale', 'legend', 'grid', 'axes'];
    const legacy = Object.fromEntries(legacyFields
      .filter((field) => cfg.style[field] !== undefined)
      .map((field) => [field, cfg.style[field]]));
    if (Object.keys(legacy).length) cfg.display = { ...legacy, ...(cfg.display || {}) };
  }
  if (cfg.series != null && cfg.series === cfg.x) cfg.series = null;
  if (cfg.type === 'pie') {
    cfg.series = null;
    if (Array.isArray(cfg.y) && cfg.y.length > 1) cfg.y = [cfg.y[0]];
  }
  return cfg;
}

/** A small categorical palette anchored on the brand accent. */
export function chartPalette(accent) {
  return [accent, '#22C55E', '#E0B341', '#EC4899', '#14B8A6', '#A78BFA', '#F97316'];
}

const COLOR_FALLBACK = {
  '--accent': '#0079AD',
  '--fg': '#E6E6E8',
  '--fg-mute': '#A0A0A8',
  '--fg-faint': '#6B6B74',
  '--num': '#92E1D8',
  '--border': '#1F1F26',
  '--border-faint': '#1A1A20',
  '--bg-modal': '#1A1A20',
  // A canvas 2D context can't resolve `var(--mono)`, so the font family must be
  // a real stack too (mirrors styles.css --mono); otherwise Chart.js text falls
  // back to the UA default sans-serif.
  '--mono': "'JetBrains Mono', 'SF Mono', ui-monospace, Menlo, monospace",
};

/**
 * Resolve the theme tokens charts need into real color strings (canvas can't use
 * CSS vars). `read(name)` returns the computed value or ''; missing tokens fall
 * back to the dark-theme defaults so a chart always has usable colors.
 */
export function chartColors(read) {
  const get = (name) => {
    const v = (read && read(name)) || '';
    return String(v).trim() || COLOR_FALLBACK[name];
  };
  const accent = get('--accent');
  return {
    accent,
    fg: get('--fg'),
    fgMute: get('--fg-mute'),
    fgFaint: get('--fg-faint'),
    num: get('--num'),
    border: get('--border'),
    borderFaint: get('--border-faint'),
    bgModal: get('--bg-modal'),
    mono: get('--mono'),
    palette: chartPalette(accent),
  };
}

/** Resolve the selected, visible measures without altering the saved cfg. */
export function visibleChartMeasures(columns, cfg, fieldConfig) {
  // Series pivoting has always consumed only cfg.y[0]. Preserve that identity
  // for hand-authored multi-measure+Series configs instead of promoting a
  // later visible measure when the producing field is hidden.
  const selected = cfg.series != null ? (cfg.y || []).slice(0, 1) : (cfg.y || []);
  return selected.map((index) => {
    const columnName = columns[index].name;
    const authoredValueFormat = hasFieldValueFormat(fieldConfig, columnName);
    return { index, presentation: resolveFieldConfig(fieldConfig, columnName), authoredValueFormat };
  }).filter((measure) => !measure.presentation.hidden);
}

/**
 * Transform `rows` (capped) + columns into a library-agnostic
 * { labels, datasets:[{label, data}] } per the encoding in `cfg`. Rows are
 * grouped on the *raw* X cell value (first-seen order) and the measure is
 * SUM-aggregated per cell, so multiple rows sharing an X bucket combine rather
 * than the last one silently winning. `chartLabel` is applied only to the
 * final tick text, never to the grouping identity.
 * - group-by (cfg.series set): one dataset per series value, aligned to the
 *   union of X categories, missing cell → null.
 * - otherwise: one dataset per visible measure in `cfg.y`.
 */
export function buildChartData(columns, rows, cfg, fieldConfig = {}) {
  const slice = rows.slice(0, chartRowCap(cfg.type));
  const measures = visibleChartMeasures(columns, cfg, fieldConfig);
  const num = (v) => {
    if (v == null || v === '') return null;
    const parsed = Number(v);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const add = (map, key, value) => {
    const parsed = num(value);
    if (parsed != null) map.set(key, (map.get(key) || 0) + parsed);
  };
  const cats = []; // raw X keys, first-seen order
  const seen = new Set();
  const noteCat = (xk) => { if (!seen.has(xk)) { seen.add(xk); cats.push(xk); } };

  if (cfg.series != null) {
    const yi = measures[0]?.index;
    if (yi == null) return { labels: [], datasets: [] };
    const groups = new Map(); // seriesValue -> Map(xKey -> summed y)
    for (const row of slice) {
      const xk = String(row[cfg.x]);
      noteCat(xk);
      const sk = String(row[cfg.series]);
      if (!groups.has(sk)) groups.set(sk, new Map());
      const byCat = groups.get(sk);
      add(byCat, xk, row[yi]);
    }
    const datasets = [...groups.entries()].map(([name, byCat]) => ({
      label: name,
      data: cats.map((xk) => byCat.has(xk) ? byCat.get(xk) : null),
    }));
    return { labels: cats.map(chartLabel), datasets };
  }

  const sums = measures.map(() => new Map()); // per measure: xKey -> summed y
  for (const row of slice) {
    const xk = String(row[cfg.x]);
    noteCat(xk);
    measures.forEach(({ index }, mi) => add(sums[mi], xk, row[index]));
  }
  const datasets = measures.map(({ presentation }, mi) => ({
    label: presentation.displayName,
    data: cats.map((xk) => sums[mi].has(xk) ? sums[mi].get(xk) : null),
  }));
  return { labels: cats.map(chartLabel), datasets };
}

const withAlpha = (hex, frac) => {
  // #RRGGBB → rgba(...) at `frac` opacity. Non-hex passes through unchanged.
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${frac})`;
};

/**
 * Build a complete Chart.js config object (type + data + themed options) from a
 * result and the user's `cfg`. Pure: returns a plain object (Chart.js draws it).
 * `colors` is a resolved token bundle from `chartColors`. `opts.hideGrid`
 * supplies the surface default for `display.grid:'auto'` (dashboard tiles draw
 * on the panel background where a light gridline reads as noise — #149);
 * explicit `show`/`hide` display values override it.
 */
export function chartJsConfig(columns, rows, cfg, colors, opts = {}) {
  const fieldConfig = opts.fieldConfig || {};
  const measures = visibleChartMeasures(columns, cfg, fieldConfig);
  const { labels, datasets } = buildChartData(columns, rows, cfg, fieldConfig);
  const pal = colors.palette;
  const horizontal = cfg.type === 'hbar';
  const isPie = cfg.type === 'pie';
  const isArea = cfg.type === 'area';
  const isLine = cfg.type === 'line' || isArea;
  const chartType = horizontal || cfg.type === 'bar' ? 'bar' : isLine ? 'line' : 'pie';
  const style = normalizeChartStyle(cfg.style, cfg.type);
  const chartDisplay = normalizeChartDisplay(cfg.display, cfg.type);
  const pointsVisible = style.points === 'show'
    || (style.points === 'auto' && shouldShowChartPoints(labels, datasets));
  const curveStyle = style.curve === 'smooth'
    ? { tension: 0, stepped: false, cubicInterpolationMode: 'monotone' }
    : style.curve === 'stepped'
      ? { tension: 0, stepped: 'after' }
      : { tension: 0, stepped: false, cubicInterpolationMode: 'default' };
  const pointStyle = pointsVisible
    ? { pointRadius: 2, pointHoverRadius: 4, pointHitRadius: 8 }
    : { pointRadius: 0, pointHoverRadius: 3, pointHitRadius: 8 };

  const styled = datasets.map((ds, i) => {
    const color = pal[i % pal.length];
    if (isPie) {
      return { ...ds, backgroundColor: ds.data.map((_, j) => pal[j % pal.length]), borderColor: colors.bgModal, borderWidth: 1.5 };
    }
    if (isLine) {
      return {
        ...ds, borderColor: color, backgroundColor: isArea ? withAlpha(color, 0.14) : color,
        fill: isArea, borderWidth: 1.5,
        ...(isArea && style.stack === 'stacked' ? { stack: 'chart' } : {}),
        ...curveStyle, ...pointStyle,
      };
    }
    const density = style.density === 'compact'
      ? { categoryPercentage: 0.9, barPercentage: 0.95 }
      : style.density === 'joined'
        ? { categoryPercentage: 1, barPercentage: 1, borderRadius: 0 }
        : {};
    return { ...ds, backgroundColor: color, borderRadius: 2, borderWidth: 0, ...density };
  });

  const multi = datasets.length > 1;
  const gridVisible = !isPie && (chartDisplay.grid === 'show'
    || (chartDisplay.grid === 'auto' && !opts.hideGrid));
  const grid = { color: colors.borderFaint, drawBorder: false, display: gridVisible };
  const ticks = { color: colors.fgMute, font: { family: colors.mono, size: 10 } };
  const valueTicks = { ...ticks, callback: (v) => chartNumFmt(typeof v === 'number' ? v : Number(v)) };
  const compatible = measures.length > 0 && measures.every(({ presentation }) => (
    presentation.unit === measures[0].presentation.unit
    && presentation.decimals === measures[0].presentation.decimals
  ));
  if (compatible) {
    const shared = measures[0].presentation;
    valueTicks.callback = (v) => Number.isInteger(shared.decimals)
      ? formatChartValue(v, shared)
      : chartNumFmt(typeof v === 'number' ? v : Number(v)) + shared.unit;
  }

  const tooltipMeasure = (context) => cfg.series != null ? measures[0] : measures[context.datasetIndex];

  const options = {
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: 300 },
    plugins: {
      legend: {
        display: chartDisplay.legend === 'show'
          || (chartDisplay.legend === 'auto' && (multi || isPie)),
        position: isPie ? 'right' : 'top',
        align: 'start',
        labels: { color: colors.fgMute, boxWidth: 10, boxHeight: 10, font: { family: colors.mono, size: 11 } },
      },
      tooltip: {
        backgroundColor: colors.bgModal,
        borderColor: colors.border,
        borderWidth: 1,
        titleColor: colors.fg,
        bodyColor: colors.fg,
        titleFont: { family: colors.mono },
        bodyFont: { family: colors.mono },
        callbacks: {
          label: (context) => {
            const measure = tooltipMeasure(context);
            const label = isPie ? context.label : context.dataset.label;
            const value = measure?.authoredValueFormat
              ? formatChartValue(context.raw, measure.presentation)
              : context.formattedValue ?? formatChartValue(context.raw, measure?.presentation);
            return `${label}: ${value}`;
          },
          afterLabel: (context) => tooltipMeasure(context)?.presentation.description || '',
        },
      },
    },
  };

  if (isPie) {
    options.cutout = style.shape === 'donut' ? '60%' : 0;
    if (chartDisplay.frame === 'compact') options.layout = { padding: 0, autoPadding: false };
  }

  if (!isPie) {
    // The value axis carries humanized number ticks; the category axis carries
    // the X labels. indexAxis:'y' flips them for the horizontal-bar default.
    options.indexAxis = horizontal ? 'y' : 'x';
    const axesVisible = chartDisplay.axes === 'show';
    const valueAxis = {
      display: axesVisible,
      grid,
      ticks: valueTicks,
      beginAtZero: chartDisplay.scale === 'zero',
    };
    const catAxis = { display: axesVisible, grid: { ...grid, display: false }, ticks };
    options.scales = horizontal ? { x: valueAxis, y: catAxis } : { x: catAxis, y: valueAxis };
    const barsStacked = (horizontal || cfg.type === 'bar') && style.mode === 'stacked';
    const areaStacked = isArea && style.stack === 'stacked';
    options.scales.x.stacked = barsStacked;
    options.scales.y.stacked = barsStacked || areaStacked;
  }

  return { type: chartType, data: { labels, datasets: styled }, options };
}
