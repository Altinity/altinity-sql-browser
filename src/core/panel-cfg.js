// The panel-config union (#166). Pure logic — no DOM, no globals. A saved
// query's `panel: { cfg, key? }` names an explicit visualization:
//
//   cfg.type ∈ bar|hbar|line|area|pie   (chart family — exactly the chart-data
//                                        cfg shape: column indices + panel.key)
//            | table                     (no schema-bound fields)
//            | logs                      ({time?,msg?,level?} column NAMES)
//            | text                      ({content} — needs no result at all)
//
// Field policy (pinned in #166): unknown cfg fields are ignored by validation
// and *preserved* by clone/normalize — the additive forward-compatibility
// mechanism (a newer build's fields survive an older build's edit, and the
// `view:'table'`-with-latent-chart migration stashes the old chart roles as an
// extra `chart` field this arm never reads). Unknown *types* are preserved in
// storage too; rendering falls back via `resolvePanel` with a diagnostic.

import { autoChart, chartCfgValid, normalizeChartCfg, schemaKey, CHART_TYPES } from './chart-data.js';
import { detectLogsView, findTimeColumn, findMsgColumn, findLevelColumn } from './logs.js';

/** The chart-family type ids (share the chart-data cfg shape + `panel.key`). */
export const CHART_FAMILY = new Set(CHART_TYPES.map((t) => t.value));

/** Every v1 panel type id, in picker order (chart family first). */
export const PANEL_TYPE_IDS = [...CHART_FAMILY, 'table', 'logs', 'text'];

const KNOWN_TYPES = new Set(PANEL_TYPE_IDS);

/** True when `type` is one of the chart-family arms. */
export function isChartFamily(type) {
  return CHART_FAMILY.has(type);
}

/** True when `type` is any known v1 panel type. */
export function isKnownPanelType(type) {
  return KNOWN_TYPES.has(type);
}

// Panel types that need no query result at all — the one per-arm capability
// every layer keys the "no SQL required / no query issued" behavior on (save
// guard, share gate, dashboard partition, drawer preview). The filter arm
// (#160) and setup arm (#175) will join this set when they land.
const QUERYLESS_TYPES = new Set(['text']);

/** True when a panel payload's type renders without a query result (#166). */
export function isQuerylessPanel(panel) {
  return !!(panel && panel.cfg && QUERYLESS_TYPES.has(panel.cfg.type));
}

// Deep-clone a JSON-shaped value (cfgs live in localStorage/share links, so
// they are JSON by construction). Preserves unknown fields at every level —
// the ignore-and-preserve guarantee.
function plainClone(v) {
  if (Array.isArray(v)) return v.map(plainClone);
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, val] of Object.entries(v)) out[k] = plainClone(val);
    return out;
  }
  return v;
}

/**
 * Deep-clone a panel cfg so a restored config never aliases its saved source
 * (editing the live panel must not mutate the Library entry). Unknown fields
 * ride along untouched. null/undefined → null.
 */
export function clonePanelCfg(cfg) {
  return cfg && typeof cfg === 'object' ? plainClone(cfg) : null;
}

/**
 * Resolve a logs cfg's `{time, msg, level}` column NAMES against the result
 * columns (case-insensitive — matching detectLogsView's convention). Explicit
 * names are authoritative: if `time` or `msg` is present but doesn't resolve,
 * the lookup fails (returns null) — a failed name lookup IS the logs arm's
 * schema-mismatch signal (#166; there is no `key` for name-based roles).
 * Names the cfg omits fall back to convention detection for that role.
 * Returns the same `{time, msg, level|null, extras}` index shape renderLogs
 * consumes, or null when no usable time+msg pair resolves.
 */
export function resolveLogsShape(cfg, columns) {
  const cols = columns || [];
  const idxOf = (name) => cols.findIndex((c) => String(c.name).toLowerCase() === String(name).toLowerCase());
  // Per-role fallback: an omitted name uses that role's own convention scan —
  // an explicit `msg` may point at a column detection would never pick, while
  // the time column is still found by convention (and vice versa).
  const pick = (explicit, fallbackIdx) => {
    if (explicit == null || explicit === '') return fallbackIdx < 0 ? null : fallbackIdx;
    const i = idxOf(explicit);
    return i < 0 ? null : i;
  };
  const time = pick(cfg.time, findTimeColumn(cols));
  const msg = pick(cfg.msg, findMsgColumn(cols));
  if (time == null || msg == null) return null;
  // A dangling explicit level degrades to "no level column" (colors off) —
  // unlike time/msg it isn't load-bearing, so it shouldn't fail the panel.
  const level = pick(cfg.level, findLevelColumn(cols));
  const extras = cols.map((_, i) => i).filter((i) => i !== time && i !== msg && i !== level);
  return { time, msg, level, extras };
}

/**
 * Is `cfg` structurally valid *for this result's columns*? Per arm:
 * chart family → chart-data's index validation; logs → the name lookups
 * resolve; table → always (no schema-bound fields); text → always (needs no
 * result). Unknown/missing type → false (rendering falls back via
 * resolvePanel). Unknown extra fields are ignored, never a failure.
 */
export function panelCfgValid(cfg, columns) {
  if (!cfg || typeof cfg !== 'object') return false;
  if (isChartFamily(cfg.type)) return chartCfgValid(cfg, columns);
  if (cfg.type === 'logs') return resolveLogsShape(cfg, columns) != null;
  return cfg.type === 'table' || cfg.type === 'text';
}

/**
 * Fold an arm's cross-field invariants on a (cloned) cfg, preserving unknown
 * fields: chart family → normalizeChartCfg (pie single-measure, series ≠ X);
 * text → `content` coerced to a string. Mutates and returns `cfg` (null →
 * null), mirroring normalizeChartCfg's contract.
 */
export function normalizePanelCfg(cfg) {
  if (!cfg) return cfg;
  if (isChartFamily(cfg.type)) return normalizeChartCfg(cfg);
  if (cfg.type === 'text' && typeof cfg.content !== 'string') cfg.content = '';
  return cfg;
}

// Re-derive chart roles for an explicitly-kept chart type after a schema
// change: autoChart picks fresh axes, the saved type stays (that's the user's
// explicit intent), and normalize folds the type's invariants back in.
// Null when the new result has nothing plottable at all.
function rederiveChart(type, columns) {
  const cfg = autoChart(columns);
  if (!cfg) return null;
  cfg.type = type;
  return normalizeChartCfg(cfg);
}

/**
 * The unconfigured-result heuristic (#166) — replaces classifyTile's ladder
 * and D9's interim ranking. Ranks specific-before-generic: log-shaped →
 * `{type:'logs'}` (carrying the detected shape), chartable → autoChart's pick,
 * else `{type:'table'}`. `text` (and the later filter/setup arms) are never
 * auto-proposed — they exist only as explicit choices. Returns
 * `{ cfg, shape? }`; never null (table is the universal fallback).
 */
export function autoPanel(columns) {
  const shape = detectLogsView(columns);
  if (shape) return { cfg: { type: 'logs' }, shape };
  const chart = autoChart(columns);
  if (chart) return { cfg: chart };
  return { cfg: { type: 'table' } };
}

/**
 * Switch a panel's type (the Panel tab's picker, #166) — pure. Returns a NEW
 * `{cfg, key}` payload; never mutates the input. Role continuity rules:
 *  - same type → the payload passes through unchanged;
 *  - chart → chart: keep the configured axes, swap the type (normalized);
 *  - leaving the chart family: the chart roles are STASHED as `cfg.chart`
 *    ({type,x,y,series,key}) — an unknown field to the target arm, preserved
 *    by the ignore-and-preserve policy — so switching back is lossless (the
 *    same shape the `view:'table'` migration writes);
 *  - entering the chart family: consume the stash when present (its axes and
 *    schema key win, the picked type overrides), else derive roles via
 *    autoChart — a non-chartable result yields a bare `{type}` (invalid, so
 *    the preview shows the not-chartable hint rather than a broken chart);
 *  - text always (re)gains a string `content` ('' when absent).
 */
export function switchPanelType(payload, type, columns) {
  const cur = payload && payload.cfg ? payload : { cfg: null };
  const cfg = cur.cfg ? clonePanelCfg(cur.cfg) : {};
  if (cfg.type === type) return { cfg, key: cur.key ?? null };
  const wasChart = isChartFamily(cfg.type);
  const { type: _oldType, x, y, series, chart: stash, content, ...rest } = cfg;
  if (isChartFamily(type)) {
    const roles = wasChart
      ? { x, y, series: series ?? null, key: cur.key ?? null }
      : stash
        ? { x: stash.x, y: stash.y, series: stash.series ?? null, key: stash.key ?? null }
        : (() => { const a = autoChart(columns); return a ? { ...a, key: schemaKey(columns) } : null; })();
    if (!roles) return { cfg: { ...rest, type }, key: null };
    // The picked type wins LAST: an autoChart-derived `roles` carries its own
    // type pick, which must not override the user's.
    const { key, ...axes } = roles;
    return { cfg: normalizeChartCfg({ ...rest, ...axes, type }), key };
  }
  const next = { ...rest, type };
  if (wasChart) next.chart = { type: _oldType, x, y, series: series ?? null, key: cur.key ?? null };
  else if (stash) next.chart = stash; // keep an existing stash riding along
  if (type === 'text') next.content = typeof content === 'string' ? content : '';
  else if (typeof content === 'string') next.content = content; // preserved (unknown to other arms)
  return { cfg: next, key: null };
}

/**
 * Resolve a saved `panel: {cfg, key?}` against a result — the one mismatch
 * policy both surfaces share (#166): a schema change *retains the explicit
 * type and re-derives the roles within it* (chart: fresh axes for that chart
 * type; logs: convention defaults), flagged `rederived` so the UI can show a
 * small "roles re-detected" hint. Only when the explicit type is impossible
 * for this result shape (nothing plottable for a chart, no time+message for
 * logs, or an unknown type) does it fall back to `autoPanel`, with a
 * `diagnostic`. The returned cfg is always a normalized clone — never an
 * alias of the saved entry — with unknown fields preserved.
 *
 * Returns { cfg, shape?, rederived, fallback, diagnostic? }.
 */
export function resolvePanel(saved, columns) {
  const savedCfg = saved && saved.cfg && typeof saved.cfg === 'object' ? saved.cfg : null;
  const fallbackTo = (diagnostic) => ({ ...autoPanel(columns), rederived: false, fallback: true, diagnostic });
  if (!savedCfg) return { ...autoPanel(columns), rederived: false, fallback: false };
  const cfg = normalizePanelCfg(clonePanelCfg(savedCfg));
  if (isChartFamily(cfg.type)) {
    // An explicit key mismatch means the column positions no longer carry the
    // saved roles, even if every old index remains in range (columns may have
    // reordered). Retain the requested chart type but derive fresh axes.
    const keyMismatch = saved.key != null && saved.key !== schemaKey(columns);
    if (chartCfgValid(cfg, columns) && !keyMismatch) return { cfg, rederived: false, fallback: false };
    const red = rederiveChart(cfg.type, columns);
    if (red) return { cfg: { ...cfg, ...red, type: cfg.type }, rederived: true, fallback: false };
    return fallbackTo('Saved ' + cfg.type + ' chart has nothing to plot in this result.');
  }
  if (cfg.type === 'logs') {
    const explicit = resolveLogsShape(cfg, columns);
    if (explicit) return { cfg, shape: explicit, rederived: false, fallback: false };
    // A failed explicit-name lookup is the logs arm's mismatch signal: retain
    // the type and re-derive the roles by convention (the mismatch policy).
    const detected = detectLogsView(columns);
    if (detected) return { cfg, shape: detected, rederived: true, fallback: false };
    return fallbackTo('Saved logs panel: no time + message columns in this result.');
  }
  if (cfg.type === 'table' || cfg.type === 'text') {
    return { cfg, rederived: false, fallback: false };
  }
  return fallbackTo('Unknown panel type "' + String(cfg.type) + '" (saved by a newer build?).');
}
