// Pure logic for the Dashboard view (#149). No DOM, no globals.
//
// A dashboard is "the favorited subset of the Library, rendered together" — no
// new schema. This module holds the route helpers, the ClickHouse `FORMAT JSON`
// → array-rows transform the chart layer expects, and the per-tile
// classification (chart vs skip). KPI tiles (single-row) and non-chartable
// favorites are skipped in D1 (KPIs arrive in D2); the render layer counts them
// for the header's "N not shown" note.

import { autoChart, chartCfgValid, cloneChartCfg, normalizeChartCfg } from './chart-data.js';
import { detectSqlFormat } from './format.js';

/** True on the standalone dashboard route (`/sql/dashboard`, trailing slash ok). */
export function isDashboardRoute(pathname) {
  return /\/sql\/dashboard\/?$/.test(pathname || '');
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
 * A favorite's SQL prepared for a one-shot tile fetch: strip a trailing `;` and
 * append `FORMAT JSON` — unless the query already ends in its own trailing
 * `FORMAT` clause (which we leave intact; a non-JSON format just errors the tile
 * gracefully rather than being silently doubled). Trailing-FORMAT detection
 * reuses `detectSqlFormat`, which correctly handles ClickHouse's
 * `FORMAT x SETTINGS y` ordering.
 */
export function dashboardTileSql(sql) {
  const trimmed = String(sql || '').replace(/;\s*$/, '').trimEnd();
  return detectSqlFormat(trimmed) ? trimmed : trimmed + '\nFORMAT JSON';
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
