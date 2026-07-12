// Pure logic for the Dashboard view (#149). No DOM, no globals.
//
// A dashboard is "the favorited subset of the Library, rendered together" — no
// new schema. This module holds the route helpers, the ClickHouse `FORMAT JSON`
// → array-rows transform the panel layer expects, and the tile result caps.
// (Per-tile classification moved to core/panel-cfg.js's autoPanel/resolvePanel
// in #166 — the panel union replaced classifyTile's chart-vs-skip ladder.)

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
 * Rows kept per dashboard tile (#149 D9). Preserves the 5000-point line/area
 * chart cap (`CHART_ROW_CAPS` in `src/core/chart-data.js`) — a fetch cap below
 * it would silently regress charts. `queryDashboardTile` requests
 * `max_result_rows = cap + 1` (the `+1` is the truncation sentinel) and
 * `parseJsonResult` trims to this bound client-side, which is the guarantee.
 */
export const DASH_TILE_ROW_CAP = 5000;

/**
 * Best-effort `max_result_bytes` guard for a tile fetch (#149 D9) — bounds
 * wide rows (e.g. huge log messages) that a row cap alone would let through.
 * Best-effort only: under `readonly=2` a query-level `SETTINGS` clause can
 * still override it, so it is not a security/resource boundary.
 */
export const DASH_TILE_BYTE_CAP = 50_000_000;

/**
 * Rows rendered by a tile's grid/logs views (#149 D9): display is bounded
 * tighter than the fetch (up to `DASH_TILE_ROW_CAP` rows are kept for
 * client-side sort/charting), with a "+N more rows truncated for display"
 * footer beyond this.
 */
export const DASH_TABLE_DISPLAY_CAP = 1000;

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
 * by column position), plus a small footer meta ({rows, ms, bytes, truncated}).
 *
 * `cap` (optional, #149 D9) is the guaranteed client-side row bound: when more
 * than `cap` data rows arrive, `rows` is sliced to `cap` and `meta.truncated`
 * is true. The server-side `max_result_rows = cap + 1` sentinel plus
 * `result_overflow_mode:'break'` (see `queryDashboardTile`) overshoots at
 * block boundaries, so the response's own `json.rows` is neither the full
 * result count nor the displayed count — it is deliberately not exposed.
 * `meta.rows` is the rows *shown* (`rows.length` after the trim); without a
 * cap it is simply the row count, with `meta.truncated` false.
 */
export function parseJsonResult(json, cap) {
  const columns = json.meta || [];
  const data = json.data || [];
  const truncated = cap != null && data.length > cap;
  const rows = (truncated ? data.slice(0, cap) : data)
    .map((o) => columns.map((c) => o[c.name]));
  const stats = json.statistics || {};
  return {
    columns,
    rows,
    meta: {
      rows: rows.length,
      ms: stats.elapsed != null ? Math.round(stats.elapsed * 1000) : null,
      bytes: stats.bytes_read != null ? stats.bytes_read : null,
      truncated,
    },
  };
}

// (The filter bar's field discovery moved to the parameter pipeline in #165:
// `fieldControls(analysis)` in param-pipeline.js replaces the old
// `dashboardParams(favorites)` union — the analysis view also sees params
// confined to optional blocks, which readStatementParams never could.)
