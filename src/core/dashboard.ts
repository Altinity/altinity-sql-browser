// Pure logic for the Dashboard view (#149). No DOM, no globals.
//
// A dashboard is "the favorited subset of the Library, rendered together" — no
// new schema. This module holds legacy layout preference helpers and tile caps.
// (Per-tile classification moved to core/panel-cfg.js's autoPanel/resolvePanel
// in #166 — the panel union replaced classifyTile's chart-vs-skip ladder. The
// tiles stream through the shared `app.exec.executeRead` seam as of #193/#276, so the
// former `FORMAT JSON` → array-rows transform and its SQL prep were retired.)

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
// moved onto the shared streaming `app.exec.executeRead` seam. The client row bound
// is now `newResult('Table', DASH_TILE_ROW_CAP)`'s trim + `capped` flag, and
// the tile result shape is pinned by `dashboardTileResult` in src/ui/dashboard.js.)

// (The variable bar's field discovery moved to the parameter pipeline in #165:
// `fieldControls(analysis)` in param-pipeline.js replaces the old
// `dashboardParams(favorites)` union — the analysis view also sees params
// confined to optional blocks, which readStatementParams never could.)

/** One partitioned Dashboard layout item — see `partitionKpiBands`. */
export type DashboardLayoutItem =
  | { kind: 'kpi-band'; indices: number[] }
  | { kind: 'tile'; index: number };

/**
 * Partition the ordered Panel-role favorites into Dashboard layout items
 * (#240): a maximal consecutive run of explicit KPI favorites becomes one
 * `{kind:'kpi-band', indices}` (a full-width shared card stream); every other
 * favorite is its own `{kind:'tile', index}`. `isKpiFlags[i]` is true only for
 * an EXPLICIT `panel.cfg.type === 'kpi'` favorite — an auto-detected one-row
 * result must never join a band, so the caller derives this from the saved
 * cfg, never from a query's executed result. Structural only (no query
 * results involved), so bands are fixed before any tile issues a request.
 */
export function partitionKpiBands(isKpiFlags: boolean[]): DashboardLayoutItem[] {
  const items: DashboardLayoutItem[] = [];
  let run: { kind: 'kpi-band'; indices: number[] } | null = null;
  isKpiFlags.forEach((isKpi, index) => {
    if (isKpi) {
      if (!run) { run = { kind: 'kpi-band', indices: [] }; items.push(run); }
      run.indices.push(index);
    } else {
      run = null;
      items.push({ kind: 'tile', index });
    }
  });
  return items;
}
