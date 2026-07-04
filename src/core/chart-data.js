// Pure helpers for the chart result view. Everything here is DOM-free and
// library-agnostic up to the final `chartJsConfig`, which assembles a plain
// Chart.js config *object* (no canvas, no globals) — so the whole role/axis/
// pivot/scale layer is unit-testable at 100% and the DOM glue in
// `ui/results.js` stays a thin wrapper around `new Chart(canvas, config)`.

import { isNumericType } from './format.js';

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

const CHART_TYPE_SET = new Set(CHART_TYPES.map((t) => t.value));

/**
 * Deep-clone a chart config (`y` is an array) so a config restored from a saved
 * query / share link never shares a reference with its source — editing the
 * restored chart must not mutate the saved entry. null → null.
 */
export function cloneChartCfg(cfg) {
  return cfg ? { type: cfg.type, x: cfg.x, y: [...(cfg.y || [])], series: cfg.series ?? null } : null;
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

/**
 * Transform `rows` (capped) + columns into a library-agnostic
 * { labels, datasets:[{label, data}] } per the encoding in `cfg`. Rows are
 * grouped on the *raw* X cell value (first-seen order) and the measure is
 * SUM-aggregated per cell, so multiple rows sharing an X bucket combine rather
 * than the last one silently winning. `chartLabel` is applied only to the
 * final tick text, never to the grouping identity.
 * - group-by (cfg.series set): one dataset per series value, aligned to the
 *   union of X categories, missing cell → 0.
 * - otherwise: one dataset per measure in `cfg.y`.
 */
export function buildChartData(columns, rows, cfg) {
  const slice = rows.slice(0, chartRowCap(cfg.type));
  const num = (v) => (v == null || v === '' ? 0 : Number(v) || 0);
  const cats = []; // raw X keys, first-seen order
  const seen = new Set();
  const noteCat = (xk) => { if (!seen.has(xk)) { seen.add(xk); cats.push(xk); } };

  if (cfg.series != null) {
    const yi = cfg.y[0];
    const groups = new Map(); // seriesValue -> Map(xKey -> summed y)
    for (const row of slice) {
      const xk = String(row[cfg.x]);
      noteCat(xk);
      const sk = String(row[cfg.series]);
      if (!groups.has(sk)) groups.set(sk, new Map());
      const byCat = groups.get(sk);
      byCat.set(xk, (byCat.get(xk) || 0) + num(row[yi]));
    }
    const datasets = [...groups.entries()].map(([name, byCat]) => ({
      label: name,
      data: cats.map((xk) => byCat.get(xk) || 0),
    }));
    return { labels: cats.map(chartLabel), datasets };
  }

  const sums = cfg.y.map(() => new Map()); // per measure: xKey -> summed y
  for (const row of slice) {
    const xk = String(row[cfg.x]);
    noteCat(xk);
    cfg.y.forEach((yi, mi) => sums[mi].set(xk, (sums[mi].get(xk) || 0) + num(row[yi])));
  }
  const datasets = cfg.y.map((yi, mi) => ({
    label: columns[yi].name,
    data: cats.map((xk) => sums[mi].get(xk) || 0),
  }));
  return { labels: cats.map(chartLabel), datasets };
}

/**
 * Correct a Chart.js pointer event for the page's CSS `zoom`. Chart.js resolves
 * pointer hits from the event's `offsetX/offsetY`, which the browser reports in
 * *zoomed* pixels, whereas the chart draws in an unzoomed coordinate system — so
 * under `html { zoom: S }` every hover lands S× too far along the axis (long bars
 * read past their end; short bars near the origin never register, and the tooltip
 * caret drifts right). Dividing the resolved x/y by the live zoom scale realigns
 * them, fixing bar/column/pie alike. No-op when S is 1 (unzoomed) or the event
 * carries no numeric coordinates. Mutates and returns `e` (the normalized event
 * object Chart.js hands to its controller). Pure: no DOM access — the caller
 * supplies `scale` (from `zoomScale(canvas)`).
 */
export function unzoomChartEvent(e, scale) {
  if (e && typeof e.x === 'number' && typeof e.y === 'number' && scale && scale !== 1) {
    e.x /= scale;
    e.y /= scale;
    e.offsetX = e.x;
    e.offsetY = e.y;
  }
  return e;
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
 * suppresses the value-axis gridlines (dashboard tiles draw on the panel
 * background where a light gridline reads as noise — #149; the tick labels
 * stay), keeping the chart body clean like the design's tiles.
 */
export function chartJsConfig(columns, rows, cfg, colors, opts = {}) {
  const { labels, datasets } = buildChartData(columns, rows, cfg);
  const pal = colors.palette;
  const horizontal = cfg.type === 'hbar';
  const isPie = cfg.type === 'pie';
  const isArea = cfg.type === 'area';
  const isLine = cfg.type === 'line' || isArea;
  const chartType = horizontal || cfg.type === 'bar' ? 'bar' : isLine ? 'line' : 'pie';

  const styled = datasets.map((ds, i) => {
    const color = pal[i % pal.length];
    if (isPie) {
      return { ...ds, backgroundColor: ds.data.map((_, j) => pal[j % pal.length]), borderColor: colors.bgModal, borderWidth: 1.5 };
    }
    if (isLine) {
      return { ...ds, borderColor: color, backgroundColor: isArea ? withAlpha(color, 0.14) : color, fill: isArea, tension: 0.25, pointRadius: 2, borderWidth: 2 };
    }
    return { ...ds, backgroundColor: color, borderRadius: 2, borderWidth: 0 };
  });

  const multi = datasets.length > 1;
  const grid = { color: colors.borderFaint, drawBorder: false, display: !opts.hideGrid };
  const ticks = { color: colors.fgMute, font: { family: colors.mono, size: 10 } };
  const valueTicks = { ...ticks, callback: (v) => chartNumFmt(typeof v === 'number' ? v : Number(v)) };

  const options = {
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: 300 },
    plugins: {
      legend: {
        display: multi || isPie,
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
      },
    },
  };

  if (!isPie) {
    // The value axis carries humanized number ticks; the category axis carries
    // the X labels. indexAxis:'y' flips them for the horizontal-bar default.
    options.indexAxis = horizontal ? 'y' : 'x';
    const valueAxis = { grid, ticks: valueTicks, beginAtZero: true };
    const catAxis = { grid: { ...grid, display: false }, ticks };
    options.scales = horizontal ? { x: valueAxis, y: catAxis } : { x: catAxis, y: valueAxis };
  }

  return { type: chartType, data: { labels, datasets: styled }, options };
}
