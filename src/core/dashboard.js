// Pure logic for the Dashboard view (#149). No DOM, no globals.
//
// A dashboard is "the favorited subset of the Library, rendered together" — no
// new schema. This module holds the route helpers and the tile result caps.
// (Per-tile classification moved to core/panel-cfg.js's autoPanel/resolvePanel
// in #166 — the panel union replaced classifyTile's chart-vs-skip ladder. The
// tiles stream through the shared `app.runReadInto` seam as of #193, so the
// former `FORMAT JSON` → array-rows transform and its SQL prep were retired.)

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
 * Dashboard layout modes (#149 D2, #184): `arrange` = uniform multi-column grid
 * (default, column count from `dashCols`), `report` = single centered column
 * (1100px) with taller tiles, `wide` = one tile per row filling the full
 * available dashboard width (#184, Grafana-style). Persisted per browser
 * (`asb:dashLayout`); `wide` extends the key rather than migrating it, so
 * existing arrange/report selections stay valid. The four *effective* views the
 * UI exposes are derived by `activeDashboardView` below (wide, report, and
 * arrange split into its 2- and 3-column cases).
 */
export const DASH_LAYOUTS = ['arrange', 'report', 'wide'];

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
 * The four-way layout switcher's active value (#184), derived from the two
 * persisted keys so a single control can drive them: `wide` and `report` map
 * straight through; `arrange` splits into `columns-2`/`columns-3` by `dashCols`.
 * Pure — the UI's segmented control reads this to mark exactly one button
 * active, and `dashboardViewSelection` is its inverse (view → state changes).
 */
export function activeDashboardView(state) {
  if (state.dashLayout === 'wide') return 'wide';
  if (state.dashLayout === 'report') return 'report';
  return state.dashCols === 2 ? 'columns-2' : 'columns-3';
}

/**
 * Inverse of `activeDashboardView` (#184): the `{dashLayout, dashCols?}` a
 * picked switcher value implies. `dashCols` is present only for the column
 * views (the caller persists just the keys that actually changed, so choosing a
 * column count never rewrites `dashLayout` when it is already `arrange`, and
 * vice-versa). An unrecognized view falls back to the default `columns-3`.
 */
export function dashboardViewSelection(view) {
  if (view === 'wide') return { dashLayout: 'wide' };
  if (view === 'report') return { dashLayout: 'report' };
  if (view === 'columns-2') return { dashLayout: 'arrange', dashCols: 2 };
  return { dashLayout: 'arrange', dashCols: 3 };
}

/**
 * Rows kept per dashboard tile (#149 D9). Preserves the 5000-point line/area
 * chart cap (`CHART_ROW_CAPS` in `src/core/chart-data.js`) — a fetch cap below
 * it would silently regress charts. The tile streams with server
 * `max_result_rows = cap + 1` (the `+1` is the truncation sentinel) while the
 * client result's `newResult('Table', cap)` trims to `cap` and flags `capped`
 * on the overshoot — the client-side trim is the guarantee (#193).
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

// (The tiles' SQL prep + `FORMAT JSON` → array-rows transform — the former
// `dashboardTileSql` / `parseJsonResult` — were retired in #193 when the tiles
// moved onto the shared streaming `app.runReadInto` seam. The client row bound
// is now `newResult('Table', DASH_TILE_ROW_CAP)`'s trim + `capped` flag, and
// the tile result shape is pinned by `dashboardTileResult` in src/ui/dashboard.js.)

// (The filter bar's field discovery moved to the parameter pipeline in #165:
// `fieldControls(analysis)` in param-pipeline.js replaces the old
// `dashboardParams(favorites)` union — the analysis view also sees params
// confined to optional blocks, which readStatementParams never could.)
