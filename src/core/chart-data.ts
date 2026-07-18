// Pure helpers for the chart result view. Everything here is DOM-free and
// library-agnostic up to the final `chartJsConfig`, which assembles a plain
// Chart.js config *object* (no canvas, no globals) — so the whole role/axis/
// pivot/scale layer is unit-testable at 100% and the DOM glue in
// `ui/results.js` stays a thin wrapper around `new Chart(canvas, config)`.

import { isNumericType, formatRows } from './format.js';
import { hasFieldValueFormat, resolveFieldConfig } from './field-config.js';
import type { FieldPresentation } from './field-config.js';
import type {
  AreaChartStyle, BarChartStyle, FieldConfig, LineChartStyle, PieChartStyle,
} from '../generated/json-schema.types.js';
import type { Column } from './panel-cfg.js';

// The five chart-family visualization types, in config-bar order (Bar =
// horizontal, Column = vertical) — the same literal set panel-cfg.js's
// `ChartFamilyCfg['type']` derives from the generated schema branches.
export type ChartFamilyType = 'hbar' | 'bar' | 'line' | 'area' | 'pie';

/** A column-classification role — see `chartRole`'s doc comment below. */
export type ChartRole = 'time' | 'ordinal' | 'measure' | 'category';

/** A chart style object — whichever chart-family shape (`BarChartStyle` etc.)
 *  the owning cfg's `type` implies; every branch is all-optional with an
 *  index signature, so a style authored for one family degrades harmlessly
 *  when read against another's spec (`normalizeChartStyle` drops what it
 *  doesn't recognize). */
export type ChartStyle = BarChartStyle | LineChartStyle | AreaChartStyle | PieChartStyle;

/**
 * The chart-family config shape this module reads/writes throughout: column
 * INDEX roles (`x`, `y`, `series`) plus the renderer-independent `style`.
 * Mirrors the generated schema's `ChartCfg` base (`x`/`y`/`series` are the
 * same `ResultColumnIndex` shape), with `y` relaxed to optional — several
 * helpers here (`chartFieldOptions`, `cloneChartCfg`, `normalizeChartCfg`)
 * tolerate a config still missing its Y selection mid-edit.
 */
export interface ChartConfig {
  type: ChartFamilyType;
  x: number;
  y?: number[];
  series?: number | null;
  style?: ChartStyle;
  [k: string]: unknown;
}

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
export const CHART_ROW_CAPS: Record<string, number> = { pie: 30, hbar: 500, bar: 1000, line: 5000, area: 5000 };

/** The row cap for a chart type, falling back to 500 (the old flat cap) for an unmapped type. */
export function chartRowCap(type?: unknown): number {
  const key = typeof type === 'string' ? type : '';
  return CHART_ROW_CAPS[key] ?? 500;
}

/** Strip `Nullable(...)` / `LowCardinality(...)` wrappers down to the base type. */
export function chartStripType(type?: string | null): string {
  let p = String(type || '');
  let m: RegExpExecArray | null;
  while ((m = /^(?:Nullable|LowCardinality)\((.*)\)$/.exec(p))) p = m[1];
  return p;
}

/**
 * Classify a column for charting from its ClickHouse type (and, for numbers,
 * its name): 'time' | 'ordinal' | 'measure' | 'category'.
 */
export function chartRole(col?: Column | null): ChartRole {
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
export function autoChart(columns?: Column[] | null): ChartConfig | null {
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
  const type: ChartFamilyType = x.role === 'time' ? 'line' : x.role === 'category' ? 'hbar' : 'bar';
  return { type, x: x.i, y: [measures[0]], series: null };
}

/** A stable signature of the result schema; chart config is re-derived when it changes. */
export function schemaKey(columns?: Column[] | null): string {
  return (columns || []).map((c) => c.name + ':' + c.type).join('|');
}

/** One config-bar chart-type option. */
export interface ChartTypeOption {
  value: ChartFamilyType;
  label: string;
}

/** The chart types offered in the config bar (Bar = horizontal, Column = vertical). */
export const CHART_TYPES: ChartTypeOption[] = [
  { value: 'hbar', label: 'Bar' },
  { value: 'bar', label: 'Column' },
  { value: 'line', label: 'Line' },
  { value: 'area', label: 'Area' },
  { value: 'pie', label: 'Pie' },
];

// The varying style fields a cartesian (Line/Area/Bar/Column) preset sets,
// before the shared scale/legend/grid/axes presentation fields are folded in.
interface CartesianStyleFields {
  curve?: string;
  points?: string;
  stack?: string;
  mode?: string;
  density?: string;
  [k: string]: unknown;
}

const cartesianStyle = (
  fields: CartesianStyleFields,
  scale: string,
  legend = 'auto',
  grid = 'auto',
  axes = 'show',
): CartesianStyleFields & { scale: string; legend: string; grid: string; axes: string } => (
  { ...fields, scale, legend, grid, axes }
);

/** One Style-selector preset entry — `style` matches whichever chart-family
 *  shape (`BarChartStyle` etc.) the owning `CHART_STYLE_PRESETS` bucket implies. */
export interface ChartStylePresetEntry {
  value: string;
  label: string;
  style: ChartStyle;
}

const LINE_STYLE_PRESETS: ChartStylePresetEntry[] = [
  { value: 'clean', label: 'Clean', style: cartesianStyle({ curve: 'linear', points: 'auto' }, 'data') },
  { value: 'smooth', label: 'Smooth', style: cartesianStyle({ curve: 'smooth', points: 'auto' }, 'data') },
  { value: 'stepped', label: 'Stepped', style: cartesianStyle({ curve: 'stepped', points: 'auto' }, 'data') },
  { value: 'points', label: 'Points', style: cartesianStyle({ curve: 'linear', points: 'show' }, 'data') },
  { value: 'zero', label: 'Zero-based', style: cartesianStyle({ curve: 'linear', points: 'auto' }, 'zero') },
  { value: 'minimal', label: 'Minimal', style: cartesianStyle({ curve: 'linear', points: 'hide' }, 'data', 'hide', 'hide') },
  { value: 'sparkline', label: 'Sparkline', style: cartesianStyle({ curve: 'linear', points: 'hide' }, 'data', 'hide', 'hide', 'hide') },
];

const AREA_STYLE_PRESETS: ChartStylePresetEntry[] = [
  ...LINE_STYLE_PRESETS.slice(0, 4).map((preset) => ({
    ...preset, style: { ...preset.style, stack: 'overlay' } as ChartStyle,
  })),
  { value: 'stacked', label: 'Stacked', style: cartesianStyle({ curve: 'linear', points: 'auto', stack: 'stacked' }, 'data') },
  ...LINE_STYLE_PRESETS.slice(4).map((preset) => ({
    ...preset, style: { ...preset.style, stack: 'overlay' } as ChartStyle,
  })),
];

const BAR_STYLE_PRESETS: ChartStylePresetEntry[] = [
  { value: 'grouped', label: 'Grouped', style: cartesianStyle({ mode: 'grouped', density: 'normal' }, 'zero') },
  { value: 'stacked', label: 'Stacked', style: cartesianStyle({ mode: 'stacked', density: 'normal' }, 'zero') },
  { value: 'compact', label: 'Compact', style: cartesianStyle({ mode: 'grouped', density: 'compact' }, 'zero') },
  { value: 'joined', label: 'Joined', style: cartesianStyle({ mode: 'grouped', density: 'joined' }, 'zero') },
  { value: 'minimal', label: 'Minimal', style: cartesianStyle({ mode: 'grouped', density: 'compact' }, 'zero', 'hide', 'hide') },
  { value: 'data', label: 'Data range', style: cartesianStyle({ mode: 'grouped', density: 'normal' }, 'data') },
];

const PIE_STYLE_PRESETS: ChartStylePresetEntry[] = [
  { value: 'pie', label: 'Pie', style: { shape: 'pie', legend: 'show', frame: 'normal' } },
  { value: 'donut', label: 'Donut', style: { shape: 'donut', legend: 'show', frame: 'normal' } },
  { value: 'compact', label: 'Compact', style: { shape: 'donut', legend: 'hide', frame: 'compact' } },
];

/** Complete Style-selector presets by chart type (`hbar` is the Bar label). */
export const CHART_STYLE_PRESETS: Record<string, ChartStylePresetEntry[]> = {
  hbar: BAR_STYLE_PRESETS,
  bar: BAR_STYLE_PRESETS,
  line: LINE_STYLE_PRESETS,
  area: AREA_STYLE_PRESETS,
  pie: PIE_STYLE_PRESETS,
};

export function chartStylePresets(type: string): ChartStylePresetEntry[] {
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

// One style field's accepted-value Set + its default.
type StyleFieldSpec = [Set<string>, string];

// The single source of truth for a chart type's style surface: which fields it
// owns, the set of accepted values, and the default — in the canonical field
// order. `normalizeChartStyle` (fill defaults + drop unsupported values) and
// `chartStylePreset` (flag an unsupported value as Custom) both read this one
// table, so the accepted-value set and the field list can't drift between the
// two the way parallel per-type branches would. The value Sets stay aligned
// with the schema enums (`schemas/query-spec-v1.schema.json`) and the preset
// tables above by the round-trip tests in tests/unit/chart-data.test.js.
const CHART_STYLE_SPEC: Record<string, Record<string, StyleFieldSpec>> = {
  hbar: { mode: [CHART_BAR_MODES, 'grouped'], density: [CHART_BAR_DENSITIES, 'normal'], scale: [CHART_SCALES, 'zero'], legend: [CHART_VISIBILITY, 'auto'], grid: [CHART_VISIBILITY, 'auto'], axes: [CHART_AXES, 'show'] },
  bar: { mode: [CHART_BAR_MODES, 'grouped'], density: [CHART_BAR_DENSITIES, 'normal'], scale: [CHART_SCALES, 'zero'], legend: [CHART_VISIBILITY, 'auto'], grid: [CHART_VISIBILITY, 'auto'], axes: [CHART_AXES, 'show'] },
  line: { curve: [CHART_CURVES, 'linear'], points: [CHART_POINTS, 'auto'], scale: [CHART_SCALES, 'data'], legend: [CHART_VISIBILITY, 'auto'], grid: [CHART_VISIBILITY, 'auto'], axes: [CHART_AXES, 'show'] },
  area: { curve: [CHART_CURVES, 'linear'], points: [CHART_POINTS, 'auto'], stack: [CHART_STACKS, 'overlay'], scale: [CHART_SCALES, 'data'], legend: [CHART_VISIBILITY, 'auto'], grid: [CHART_VISIBILITY, 'auto'], axes: [CHART_AXES, 'show'] },
  pie: { shape: [CHART_PIE_SHAPES, 'pie'], legend: [CHART_VISIBILITY, 'show'], frame: [CHART_FRAMES, 'normal'] },
};

/** Resolve renderer-independent, type-specific style without mutating imported data. */
export function normalizeChartStyle(style: unknown, type = 'line'): Record<string, string> {
  const value: Record<string, unknown> = style && typeof style === 'object' && !Array.isArray(style)
    ? style as Record<string, unknown> : {};
  const spec = CHART_STYLE_SPEC[type] || CHART_STYLE_SPEC.line;
  const out: Record<string, string> = {};
  for (const [field, [supported, fallback]] of Object.entries(spec)) {
    const v = value[field];
    out[field] = typeof v === 'string' && supported.has(v) ? v : fallback;
  }
  return out;
}

/** Match every preset-owned field exactly; unusual advanced combinations stay Custom. */
export function chartStylePreset(style: unknown, type: string): string {
  const styleSource: Record<string, unknown> = style && typeof style === 'object' && !Array.isArray(style)
    ? style as Record<string, unknown> : {};
  const spec = CHART_STYLE_SPEC[type] || {};
  if (Object.entries(spec).some(([field, [supported]]) => {
    const v = styleSource[field];
    return field in styleSource && !(typeof v === 'string' && supported.has(v));
  })) return 'custom';
  const normalizedStyle = normalizeChartStyle(style, type);
  const matched = chartStylePresets(type).find((preset) => (
    Object.keys(preset.style).every((field) => normalizedStyle[field] === preset.style[field])
  ));
  return matched ? matched.value : 'custom';
}

/** Apply one UI preset while retaining unknown and dormant extensions. */
export function applyChartStylePreset(style: unknown, preset: string, type: string): Record<string, unknown> {
  const styleBase: Record<string, unknown> = style && typeof style === 'object' && !Array.isArray(style)
    ? style as Record<string, unknown> : {};
  const presets = chartStylePresets(type);
  const picked = presets.find((item) => item.value === preset) || presets[0];
  return picked ? { ...styleBase, ...picked.style } : { ...styleBase };
}

/** Deterministic marker density rule over the final rendered labels/datasets. */
export function shouldShowChartPoints(labels?: unknown[] | null, datasets?: unknown[] | null): boolean {
  return (labels || []).length <= 60 && (datasets || []).length <= 4;
}

const CHART_TYPE_SET: Set<ChartFamilyType> = new Set(CHART_TYPES.map((t) => t.value));

/**
 * Deep-clone a chart config (`y` is an array) so a config restored from a saved
 * query / share link never shares a reference with its source — editing the
 * restored chart must not mutate the saved entry. null → null.
 */
export function cloneChartCfg(cfg: ChartConfig | null | undefined): ChartConfig | null {
  if (!cfg) return null;
  const out: ChartConfig = { ...cfg, y: [...(cfg.y || [])], series: cfg.series ?? null };
  if (cfg.style && typeof cfg.style === 'object') {
    out.style = JSON.parse(JSON.stringify(cfg.style));
  }
  return out;
}

// The loosely-shaped ingress a (possibly untrusted) saved/hand-edited chart
// cfg is read through before its type/indices are proven — same convention
// as panel-cfg.js's own `(cfg as { type?: unknown }).type` ingress casts.
interface RawChartCfgLike {
  type?: unknown;
  x?: unknown;
  y?: unknown;
  series?: unknown;
  [k: string]: unknown;
}

/**
 * Is a (possibly untrusted) chart config structurally valid for `columns`?
 * Restored configs come from saved JSON / a URL hash a user can hand-edit, so
 * before `chartJsConfig` dereferences `cfg.x` / `cfg.y[i]` / `cfg.series` as
 * column indices we confirm the type is known and every index is in range —
 * otherwise the caller falls back to `autoChart`.
 */
export function chartCfgValid(cfg: unknown, columns?: Column[] | null): boolean {
  if (!cfg || typeof cfg !== 'object') return false;
  const c = cfg as RawChartCfgLike;
  const n = (columns || []).length;
  // Ingress: `i` may be any saved/hand-edited value; the numeric/range checks
  // below are exactly the runtime proof needed before it's used as an index.
  const idxOk = (i: unknown): boolean => typeof i === 'number' && Number.isInteger(i) && i >= 0 && i < n;
  if (!(typeof c.type === 'string' && CHART_TYPE_SET.has(c.type as ChartFamilyType))) return false;
  if (!idxOk(c.x)) return false;
  if (!Array.isArray(c.y) || c.y.length === 0 || !c.y.every(idxOk)) return false;
  if (c.series != null && !idxOk(c.series)) return false;
  return true;
}

/** One `<select>`-ready `{value, label}` option. */
export interface ChartFieldOption {
  value: string;
  label: string;
}

/** `chartFieldOptions`' return: the config-bar's option lists + visibility flags. */
export interface ChartFieldOptionsResult {
  typeOptions: ChartTypeOption[];
  xOptions: ChartFieldOption[];
  yOptions: ChartFieldOption[];
  seriesOptions: ChartFieldOption[];
  showSeries: boolean;
  showMulti: boolean;
  multiActive: boolean;
  allMeasures: number[];
}

/**
 * Derive the config-bar option lists + visibility flags for the current config.
 * Pure so the glue just maps these to <select> elements. `cfg.y` is an array of
 * column indices; `cfg.series` is an index or null.
 */
export function chartFieldOptions(columns: Column[], cfg: ChartConfig): ChartFieldOptionsResult {
  const opt = (i: number): ChartFieldOption => ({ value: String(i), label: columns[i].name });
  const roleOf = (i: number): ChartRole => chartRole(columns[i]);
  // Y is pickable from any number (measures + ordinal buckets); but the
  // "All measures" bulk toggle plots only true measures, never the X column —
  // so it can't end up charting an ordinal axis against itself.
  const numericIdx = columns.map((c, i) => i).filter((i) => roleOf(i) === 'measure' || roleOf(i) === 'ordinal');
  const catIdx = columns.map((c, i) => i).filter((i) => roleOf(i) !== 'measure');
  const allMeasures = columns.map((c, i) => i).filter((i) => roleOf(i) === 'measure' && i !== cfg.x);
  const seriesOptions: ChartFieldOption[] = [{ value: '', label: 'None' }, ...catIdx.filter((i) => i !== cfg.x).map(opt)];
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
export function chartNumFmt(v: unknown): string {
  if (typeof v !== 'number' || !isFinite(v)) return String(v);
  const a = Math.abs(v);
  if (a >= 1e6) return (v / 1e6).toFixed(1) + 'M';
  if (a >= 1e3) return (v / 1e3).toFixed(1) + 'K';
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
}

/** The partial presentation metadata `formatChartValue` reads (a subset of
 *  `FieldPresentation` — direct/test callers may supply just these fields). */
export interface ChartValuePresentation {
  noValue?: string;
  decimals?: number | null;
  unit?: string;
  [k: string]: unknown;
}

/** Format one measure value from resolved field metadata, without scaling it. */
export function formatChartValue(value: unknown, presentation: ChartValuePresentation = {}): string {
  if (value == null || value === '') return presentation.noValue ?? '—';
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return presentation.noValue ?? '—';
  const normalized = Object.is(numeric, -0) ? 0 : numeric;
  const decimals = presentation.decimals;
  const exactDecimals = typeof decimals === 'number' && Number.isInteger(decimals) && decimals >= 0 && decimals <= 20;
  const rendered = exactDecimals
    ? normalized.toFixed(decimals)
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
export function chartLabel(v: unknown): string {
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
export function normalizeChartCfg<T extends ChartConfig | null | undefined>(cfg: T): T {
  if (!cfg) return cfg;
  if (cfg.series != null && cfg.series === cfg.x) cfg.series = null;
  if (cfg.type === 'pie') {
    cfg.series = null;
    if (Array.isArray(cfg.y) && cfg.y.length > 1) cfg.y = [cfg.y[0]];
  }
  return cfg;
}

/** A small categorical palette anchored on the brand accent. */
export function chartPalette(accent: string): string[] {
  return [accent, '#22C55E', '#E0B341', '#EC4899', '#14B8A6', '#A78BFA', '#F97316'];
}

const COLOR_FALLBACK: Record<string, string> = {
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

/** The resolved theme tokens `chartColors` returns — real color strings a
 *  canvas 2D context can use directly (never a CSS var reference). */
export interface ChartColors {
  accent: string;
  fg: string;
  fgMute: string;
  fgFaint: string;
  num: string;
  border: string;
  borderFaint: string;
  bgModal: string;
  mono: string;
  palette: string[];
}

/**
 * Resolve the theme tokens charts need into real color strings (canvas can't use
 * CSS vars). `read(name)` returns the computed value or ''; missing tokens fall
 * back to the dark-theme defaults so a chart always has usable colors.
 */
export function chartColors(read?: ((name: string) => unknown) | null): ChartColors {
  const get = (name: string): string => {
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

/** One resolved, visible chart measure — a Y column index paired with its
 *  resolved presentation metadata. */
export interface ChartMeasure {
  index: number;
  presentation: FieldPresentation;
  authoredValueFormat: boolean;
}

/** Resolve the selected, visible measures without altering the saved cfg. */
export function visibleChartMeasures(columns: Column[], cfg: ChartConfig, fieldConfig?: FieldConfig): ChartMeasure[] {
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

/** The browser-side aggregation identity a chart grouped its fetched rows on:
 *  raw `X` alone (`'x'`), or raw `(X, Series)` when a group-by is set. */
export type ChartGroupKey = 'x' | 'x+series';

/**
 * Typed, explicit metadata about the browser-side transform `buildChartData`
 * applied — how many rows/categories were fetched vs. displayed, and whether
 * the visible chart combined duplicate aggregation cells. It describes only
 * what the chart did; it makes no claim about whether the SQL pre-aggregated.
 */
export interface ChartDataMeta {
  /** `rows.length` — every fetched row, before the category cap. */
  totalRows: number;
  /** Unique raw X values across the full fetched result. */
  totalCategories: number;
  /** Retained (displayed) X categories — `min(totalCategories, cap)`. */
  shownCategories: number;
  /** `shownCategories < totalCategories`. */
  categoriesTruncated: boolean;
  /** At least two fetched rows mapped to the same *displayed* aggregation
   *  cell (X without Series, `(X, Series)` with Series). A duplicate that
   *  occurs only in an omitted category never sets this. */
  duplicateCellsSummed: boolean;
  /** The aggregation identity — `'x'` when `cfg.series == null`, else `'x+series'`. */
  groupKey: ChartGroupKey;
}

/** `buildChartData`'s library-agnostic result: labels + one dataset per
 *  measure or series value, plus explicit transform metadata. */
export interface ChartDataResult {
  labels: string[];
  datasets: { label: string; data: (number | null)[] }[];
  meta: ChartDataMeta;
}

/**
 * Transform the *full* fetched `rows` + columns into a library-agnostic
 * { labels, datasets:[{label, data}], meta } per the encoding in `cfg`.
 *
 * The row cap (`chartRowCap(cfg.type)`) limits the number of X *categories*,
 * never the raw rows aggregated: pass 1 discovers unique raw X keys in
 * first-seen order and retains the first `cap` of them; pass 2 aggregates
 * every fetched row whose X is one of the retained categories, so a row that
 * appears after the cap-th input row still contributes to its displayed
 * category. Categories are neither value-ranked, sorted, nor folded into an
 * `Other` bucket. Grouping identity is the *raw* X cell value (`String(...)`);
 * `chartLabel` is applied only to the final tick text.
 * - group-by (cfg.series set): one dataset per series value *encountered in a
 *   displayed category*, aligned to the retained X categories, missing → null;
 * - otherwise: one dataset per visible measure in `cfg.y`.
 * The measure is SUM-aggregated per cell, so multiple rows sharing a cell
 * combine rather than the last one silently winning. `meta.duplicateCellsSummed`
 * records whether that happened for a *displayed* cell.
 * `measures` defaults to `visibleChartMeasures(...)` but the caller
 * (`chartJsConfig`) passes the value it already resolved so a single render
 * doesn't resolve field metadata twice; direct/test callers may omit it.
 */
export function buildChartData(
  columns: Column[],
  rows: unknown[][],
  cfg: ChartConfig,
  fieldConfig: FieldConfig = {},
  measures: ChartMeasure[] = visibleChartMeasures(columns, cfg, fieldConfig),
): ChartDataResult {
  const num = (v: unknown): number | null => {
    if (v == null || v === '') return null;
    const parsed = Number(v);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const add = (map: Map<string, number>, key: string, value: unknown): void => {
    const parsed = num(value);
    if (parsed != null) map.set(key, (map.get(key) || 0) + parsed);
  };

  // Pass 1: discover unique raw X categories in first-seen order across the
  // full fetched result, then retain the first `cap` for display.
  const allCats: string[] = [];
  const seenCat = new Set<string>();
  for (const row of rows) {
    const xk = String(row[cfg.x]);
    if (!seenCat.has(xk)) { seenCat.add(xk); allCats.push(xk); }
  }
  const cats = allCats.slice(0, chartRowCap(cfg.type)); // displayed, first-seen order
  const displayed = new Set(cats);
  const groupKey: ChartGroupKey = cfg.series != null ? 'x+series' : 'x';
  const meta = (duplicateCellsSummed: boolean): ChartDataMeta => ({
    totalRows: rows.length,
    totalCategories: allCats.length,
    shownCategories: cats.length,
    categoriesTruncated: cats.length < allCats.length,
    duplicateCellsSummed,
    groupKey,
  });

  // Pass 2: aggregate only rows whose X belongs to a displayed category.
  if (cfg.series != null) {
    const yi = measures[0]?.index;
    if (yi == null) return { labels: [], datasets: [], meta: meta(false) };
    const groups = new Map<string, Map<string, number>>(); // seriesValue -> Map(xKey -> summed y)
    const seenCells = new Map<string, Set<string>>(); // seriesValue -> Set(xKey) already seen
    let dup = false;
    for (const row of rows) {
      const xk = String(row[cfg.x]);
      if (!displayed.has(xk)) continue;
      const sk = String(row[cfg.series]);
      let cellSet = seenCells.get(sk);
      if (!cellSet) { cellSet = new Set(); seenCells.set(sk, cellSet); }
      if (cellSet.has(xk)) dup = true; else cellSet.add(xk);
      if (!groups.has(sk)) groups.set(sk, new Map());
      add(groups.get(sk)!, xk, row[yi]);
    }
    const datasets = [...groups.entries()].map(([name, byCat]) => ({
      label: name,
      data: cats.map((xk) => byCat.has(xk) ? byCat.get(xk)! : null),
    }));
    return { labels: cats.map(chartLabel), datasets, meta: meta(dup) };
  }

  const sums: Map<string, number>[] = measures.map(() => new Map()); // per measure: xKey -> summed y
  const seenX = new Set<string>();
  let dup = false;
  for (const row of rows) {
    const xk = String(row[cfg.x]);
    if (!displayed.has(xk)) continue;
    if (seenX.has(xk)) dup = true; else seenX.add(xk);
    measures.forEach(({ index }, mi) => add(sums[mi], xk, row[index]));
  }
  const datasets = measures.map(({ presentation }, mi) => ({
    label: presentation.displayName,
    data: cats.map((xk) => sums[mi].has(xk) ? sums[mi].get(xk)! : null),
  }));
  return { labels: cats.map(chartLabel), datasets, meta: meta(dup) };
}

/**
 * The user-facing disclosure of the browser-side transform, or `null` when the
 * chart displays every fetched category and summed no duplicate cell. Describes
 * only what the chart did — never whether the SQL was pre-aggregated. Truncation
 * and duplicate summing are independent facts, joined with `; ` when both hold.
 */
export function chartDataNote(meta: ChartDataMeta): string | null {
  const clauses: string[] = [];
  if (meta.categoriesTruncated) {
    clauses.push('first ' + formatRows(meta.shownCategories) + ' of ' + formatRows(meta.totalCategories) + ' categories');
  }
  if (meta.duplicateCellsSummed) {
    clauses.push(meta.groupKey === 'x+series'
      ? 'duplicate X/series rows summed in the browser'
      : 'duplicate X rows summed in the browser');
  }
  return clauses.length ? clauses.join('; ') : null;
}

const withAlpha = (hex: string, frac: number): string => {
  // #RRGGBB → rgba(...) at `frac` opacity. Non-hex passes through unchanged.
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${frac})`;
};

/** `chartJsConfig`'s optional third argument. */
export interface ChartJsConfigOptions {
  fieldConfig?: FieldConfig;
  hideGrid?: boolean;
  measures?: ChartMeasure[];
  /** A pre-aggregated `buildChartData` result — the renderer computes it once
   *  (it needs `.meta` for the disclosure note) and threads it here so a single
   *  render aggregates the fetched rows exactly once. Omitted by direct/test
   *  callers, which fall back to aggregating inline. */
  data?: ChartDataResult;
}

/** One Chart.js dataset — the fields this module sets, plus whatever
 *  Chart.js-specific styling keys ride along (index signature). */
export interface ChartJsDataset {
  label: string;
  data: (number | null)[];
  [k: string]: unknown;
}

/** The `{labels, datasets}` half of a Chart.js config. */
export interface ChartJsData {
  labels: string[];
  datasets: ChartJsDataset[];
}

// The shape of a Chart.js tooltip/legend callback's `context` argument, pared
// to the fields this module reads. `dataset`/`raw`/`formattedValue` are
// omitted by `afterLabel`'s own tests (it never touches them), so they stay
// optional even though a real Chart.js callback always supplies them.
interface TooltipContext {
  datasetIndex: number;
  dataset?: { label?: string; [k: string]: unknown };
  label?: string;
  raw?: unknown;
  formattedValue?: string;
}

// A resolved Chart.js cartesian axis — the fields this module ever sets.
interface ChartJsAxis {
  display: boolean;
  grid: { color: string; drawBorder: boolean; display: boolean };
  ticks: {
    color: string; font: Record<string, unknown>; callback?: (v: number | string) => string;
    autoSkip?: boolean; maxRotation?: number; minRotation?: number;
  };
  beginAtZero?: boolean;
  stacked?: boolean;
}

/** `chartJsConfig`'s complete return: a plain object Chart.js draws directly. */
export interface ChartJsConfigResult {
  type: 'bar' | 'line' | 'pie';
  data: ChartJsData;
  options: {
    responsive: boolean;
    maintainAspectRatio: boolean;
    animation: { duration: number };
    plugins: {
      legend: {
        display: boolean;
        position: 'right' | 'top';
        align: string;
        labels: Record<string, unknown>;
      };
      tooltip: {
        backgroundColor: string;
        borderColor: string;
        borderWidth: number;
        titleColor: string;
        bodyColor: string;
        titleFont: Record<string, unknown>;
        bodyFont: Record<string, unknown>;
        callbacks: {
          label: (context: TooltipContext) => string;
          afterLabel: (context: TooltipContext) => string;
        };
      };
    };
    indexAxis?: 'x' | 'y';
    scales?: { x: ChartJsAxis; y: ChartJsAxis };
    cutout?: number | string;
    layout?: Record<string, unknown>;
  };
}

/**
 * Build a complete Chart.js config object (type + data + themed options) from a
 * result and the user's `cfg`. Pure: returns a plain object (Chart.js draws it).
 * `colors` is a resolved token bundle from `chartColors`. `opts.hideGrid`
 * supplies the surface default for `style.grid:'auto'` (dashboard tiles draw
 * on the panel background where a light gridline reads as noise — #149);
 * explicit `show`/`hide` style values override it. `opts.measures` (optional)
 * is a pre-resolved `visibleChartMeasures` array — the caller passes it to
 * avoid re-resolving field metadata it already computed.
 */
export function chartJsConfig(
  columns: Column[],
  rows: unknown[][],
  cfg: ChartConfig,
  colors: ChartColors,
  opts: ChartJsConfigOptions = {},
): ChartJsConfigResult {
  const fieldConfig = opts.fieldConfig || {};
  // Resolve field metadata once per render: the caller (chart-render) may pass
  // the measures it already computed for its empty-state guard, and we hand the
  // same array to buildChartData so a single config build resolves the metadata
  // once instead of three times (#254 review finding).
  const measures = opts.measures ?? visibleChartMeasures(columns, cfg, fieldConfig);
  // `opts.data` (when the renderer already aggregated for its note) avoids a
  // second full aggregation per render; direct/test callers fall back inline.
  const { labels, datasets } = opts.data ?? buildChartData(columns, rows, cfg, fieldConfig, measures);
  const pal = colors.palette;
  const horizontal = cfg.type === 'hbar';
  const isPie = cfg.type === 'pie';
  const isArea = cfg.type === 'area';
  const isLine = cfg.type === 'line' || isArea;
  const chartType: 'bar' | 'line' | 'pie' = horizontal || cfg.type === 'bar' ? 'bar' : isLine ? 'line' : 'pie';
  const style = normalizeChartStyle(cfg.style, cfg.type);
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

  const styled: ChartJsDataset[] = datasets.map((ds, i) => {
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
  const gridVisible = !isPie && (style.grid === 'show'
    || (style.grid === 'auto' && !opts.hideGrid));
  const grid = { color: colors.borderFaint, drawBorder: false, display: gridVisible };
  const ticks = { color: colors.fgMute, font: { family: colors.mono, size: 10 } };
  const valueTicks: { color: string; font: Record<string, unknown>; callback: (v: number | string) => string } = {
    ...ticks, callback: (v: number | string) => chartNumFmt(typeof v === 'number' ? v : Number(v)),
  };
  const compatible = measures.length > 0 && measures.every(({ presentation }) => (
    presentation.unit === measures[0].presentation.unit
    && presentation.decimals === measures[0].presentation.decimals
  ));
  if (compatible) {
    const shared = measures[0].presentation;
    valueTicks.callback = (v: number | string) => Number.isInteger(shared.decimals)
      ? formatChartValue(v, shared)
      : chartNumFmt(typeof v === 'number' ? v : Number(v)) + shared.unit;
  }

  const tooltipMeasure = (context: TooltipContext): ChartMeasure | undefined => (
    cfg.series != null ? measures[0] : measures[context.datasetIndex]
  );

  const options: ChartJsConfigResult['options'] = {
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: 300 },
    plugins: {
      legend: {
        display: style.legend === 'show'
          || (style.legend === 'auto' && (multi || isPie)),
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
          label: (context: TooltipContext): string => {
            const measure = tooltipMeasure(context);
            // `!`: Chart.js always supplies `dataset` on a real tooltip
            // context — the original .js read `.label` bare (a missing
            // dataset should crash loudly, not render "undefined:").
            const label = isPie ? context.label : context.dataset!.label;
            const value = measure?.authoredValueFormat
              ? formatChartValue(context.raw, measure.presentation)
              : context.formattedValue ?? formatChartValue(context.raw, measure?.presentation);
            return `${label}: ${value}`;
          },
          afterLabel: (context: TooltipContext): string => tooltipMeasure(context)?.presentation.description || '',
        },
      },
    },
  };

  if (isPie) {
    options.cutout = style.shape === 'donut' ? '60%' : 0;
    if (style.frame === 'compact') options.layout = { padding: 0, autoPadding: false };
  }

  if (!isPie) {
    // The value axis carries humanized number ticks; the category axis carries
    // the X labels. indexAxis:'y' flips them for the horizontal-bar default.
    options.indexAxis = horizontal ? 'y' : 'x';
    const axesVisible = style.axes === 'show';
    const valueAxis: ChartJsAxis = {
      display: axesVisible,
      grid,
      ticks: valueTicks,
      beginAtZero: style.scale === 'zero'
        || (style.scale === 'auto' && (horizontal || cfg.type === 'bar')),
    };
    // Line/area charts plot every distinct row as its own category tick (no
    // Chart.js time scale — #309), which at a few hundred rows is unreadable
    // rotated at Chart.js's default up-to-50°. Force horizontal labels and let
    // autoSkip drop enough of them to fit instead.
    const catTicks = isLine ? { ...ticks, autoSkip: true, maxRotation: 0, minRotation: 0 } : ticks;
    const catAxis: ChartJsAxis = { display: axesVisible, grid: { ...grid, display: false }, ticks: catTicks };
    options.scales = horizontal ? { x: valueAxis, y: catAxis } : { x: catAxis, y: valueAxis };
    const barsStacked = (horizontal || cfg.type === 'bar') && style.mode === 'stacked';
    const areaStacked = isArea && style.stack === 'stacked';
    options.scales.x.stacked = barsStacked;
    options.scales.y.stacked = barsStacked || areaStacked;
  }

  return { type: chartType, data: { labels, datasets: styled }, options };
}
