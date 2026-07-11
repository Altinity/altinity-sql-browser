// Pure logic for the Dashboard view (#149). No DOM, no globals.
//
// A dashboard is "the favorited subset of the Library, rendered together" — no
// new schema. This module holds the route helpers, the ClickHouse `FORMAT JSON`
// → array-rows transform the chart layer expects, and the per-tile
// classification (chart vs skip). KPI tiles (single-row) and non-chartable
// favorites are skipped in D1 (KPIs arrive in D2); the render layer counts them
// for the header's "N not shown" note.

import { autoChart, chartCfgValid, cloneChartCfg, normalizeChartCfg } from './chart-data.js';
import { withTrailingFormat } from './format.js';

/**
 * True on the standalone dashboard route (a path ending in `/dashboard`,
 * trailing slash ok). Matches on the `/dashboard` suffix rather than a pinned
 * `/sql/dashboard` so it stays consistent with `configBase` (which strips the
 * same suffix) and survives the SPA being mounted somewhere other than `/sql`.
 * The server only serves the artifact at its SPA routes, so nothing unexpected
 * reaches this predicate.
 */
export function isDashboardRoute(pathname) {
  return /\/dashboard\/?$/.test(pathname || '');
}

/**
 * The SPA base path for config.json / OAuth resolution, independent of the
 * dashboard sub-route: `/sql/dashboard` → `/sql` so `loadConfigDoc` fetches
 * `/sql/config.json` (not the non-existent `/sql/dashboard/config.json`).
 */
export function configBase(pathname) {
  return (pathname || '').replace(/\/dashboard\/?$/, '');
}

/**
 * Dashboard layout modes (#149 D2): `arrange` = uniform multi-column grid
 * (default), `report` = single full-width scrolling column with taller tiles.
 * Persisted per browser (`asb:dashLayout`).
 */
export const DASH_LAYOUTS = ['arrange', 'report'];

/** Snap a persisted layout to a known mode, defaulting to `arrange`. Pure. */
export function normalizeDashLayout(v) {
  return DASH_LAYOUTS.includes(v) ? v : 'arrange';
}

/** Column-count options for Arrange mode (persisted `asb:dashCols`). */
export const DASH_COLS = [2, 3];

/** Snap a persisted column count to 2 or 3, defaulting to 3. Pure. */
export function normalizeDashCols(n) {
  return DASH_COLS.includes(n) ? n : 3;
}

/**
 * A favorite's SQL prepared for a one-shot tile fetch: `FORMAT JSON` appended
 * unless the query already ends in its own trailing `FORMAT` clause (which we
 * leave intact; a non-JSON format just errors the tile gracefully rather than
 * being silently doubled). Delegates to `withTrailingFormat`, which strips a
 * trailing `;`/comments and reuses `detectSqlFormat` (handling ClickHouse's
 * `FORMAT x SETTINGS y` ordering). Empty input → '' (no favorite is empty).
 */
export function dashboardTileSql(sql) {
  return withTrailingFormat(sql, 'JSON').sql;
}

/**
 * Transform a ClickHouse `FORMAT JSON` response into the shape the chart layer
 * wants: `columns` = `meta` ([{name,type}]), `rows` = array-of-arrays (row[i]
 * by column position), plus a small footer meta ({rows, ms, bytes}).
 */
export function parseJsonResult(json) {
  const columns = json.meta || [];
  const data = json.data || [];
  const rows = data.map((o) => columns.map((c) => o[c.name]));
  const stats = json.statistics || {};
  return {
    columns,
    rows,
    meta: {
      rows: json.rows != null ? json.rows : rows.length,
      ms: stats.elapsed != null ? Math.round(stats.elapsed * 1000) : null,
      bytes: stats.bytes_read != null ? stats.bytes_read : null,
    },
  };
}

// (The filter bar's field discovery moved to the parameter pipeline in #165:
// `fieldControls(analysis)` in param-pipeline.js replaces the old
// `dashboardParams(favorites)` union — the analysis view also sees params
// confined to optional blocks, which readStatementParams never could.)

/**
 * Classify a favorite's result into a dashboard tile. In D1:
 *   - 0 rows            → skip (empty)
 *   - exactly 1 row     → skip (a KPI — rendered in D2)
 *   - saved chart cfg valid for these columns → chart with that cfg
 *   - else autoChart    → chart, or skip when nothing is plottable
 * `savedChart` is the favorite's persisted `{cfg, key}` (or undefined). The
 * returned cfg is a normalized clone — never an alias of the saved entry.
 */
export function classifyTile(columns, rows, savedChart) {
  if (rows.length === 0) return { kind: 'skip', reason: 'empty' };
  if (rows.length === 1) return { kind: 'skip', reason: 'kpi' };
  const saved = savedChart && savedChart.cfg;
  const cfg = chartCfgValid(saved, columns)
    ? normalizeChartCfg(cloneChartCfg(saved))
    : autoChart(columns);
  if (!cfg) return { kind: 'skip', reason: 'nonChartable' };
  return { kind: 'chart', cfg };
}
