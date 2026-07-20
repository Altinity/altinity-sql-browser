// DashboardViewerSession (#286 / #280 "Phase 4: viewer and flow layout"). The
// standalone, read-only Dashboard runtime: it takes an immutable
// DashboardDocumentV1 snapshot plus the workspace's saved queries and runs the
// Dashboard end-to-end — resolving each panel tile's presentation (through the
// ONE shared `presentation-resolver`), running the filter wave and the tile
// wave with bounded concurrency, per-tile cancellation, and stale-wave
// protection, and publishing everything through one `state` signal a renderer
// subscribes to. It owns runtime-only state (filter values/activation, tile
// results/errors/progress, the resolved flow layout) and NOTHING persisted.
//
// It depends only on narrow injected interfaces — a query executor, a
// connection (token preflight), a layout registry, and (by import, since they
// are pure) the flow layout math + the shared presentation resolver. It must
// NOT reach into the Workbench UI, the full `App`, global `AppState`, the
// editor adapters, `src/application/**`, or `src/net/**`; `build/
// check-boundaries.mjs`'s `src/dashboard/**` and `src/dashboard/application`
// rules enforce that at compile time (issue #286 dependency-boundary tests).
//
// #235 resolution lives in the execution planner here: panels whose declared
// params cannot be affected by any filter SOURCE query run in PARALLEL with the
// filter wave; panels a source-backed filter targets wait for the wave and see
// the correct blanked/active values on the first pass. The overlap is computed
// from the explicit DashboardFilterDefinitionV1 `parameter`/`targets` contract.

import { signal } from '@preact/signals-core';
import type { ReadonlySignal, Signal } from '@preact/signals-core';
import {
  analyzeParameterizedSources, prepareParameterizedBatch, mergedSourceArgs, mergedSourceSql, fieldControls,
} from '../../core/param-pipeline.js';
import type {
  FieldControl, ParameterAnalysis, PreparedSource, PreparedFieldState, ValidationMode, BoundParamSnapshot,
} from '../../core/param-pipeline.js';
import { hasOptionalBlocks } from '../../core/optional-blocks.js';
import { detectSqlFormat } from '../../core/format.js';
import { DASH_TILE_ROW_CAP, DASH_TILE_BYTE_CAP } from '../../core/dashboard.js';
import { queryName } from '../../core/saved-query.js';
import { panelExecution } from '../../core/panel-execution.js';
import { filterExecution } from '../../core/filter-execution.js';
import { readFilterOptions } from '../../core/filter-options.js';
import { mergeDashboardFilterHelpers } from '../../core/dashboard-filters.js';
import type { FilterProvider, FilterHelperOption, MergeDashboardFilterHelpersResult } from '../../core/dashboard-filters.js';
import { diagnostic as coreDiagnostic } from '../../core/diagnostics.js';
import { newResult } from '../../core/stream.js';
import type { StreamResult } from '../../core/stream.js';
import type { Column } from '../../core/panel-cfg.js';
import { resolvePresentation, resolveDashboardPresentations } from '../model/presentation-resolver.js';
import { diagnostic as wsDiagnostic } from '../model/workspace-diagnostics.js';
import type { WorkspaceDiagnostic } from '../model/workspace-diagnostics.js';
import { computeFlowLayout } from '../layouts/flow-layout.js';
import type { FlowLayoutModel } from '../layouts/flow-layout.js';
import { computeGrafanaGridLayout } from '../layouts/grafana-grid-layout.js';
import type { GrafanaGridLayoutModel, GridRenderMode } from '../layouts/grafana-grid-layout.js';
import { resolveLayoutPluginSync } from '../layouts/layout-registry.js';
import type { DashboardLayoutRegistry } from '../layouts/layout-registry.js';
import type {
  DashboardDocumentV1, DashboardTileV1, DashboardFilterDefinitionV1, Panel, SavedQueryV2,
} from '../../generated/json-schema.types.js';

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/** Bounded concurrency across a wave (a large Dashboard must not fire a
 *  thundering herd). Same cap the #276 phase-3b runtime used. */
export const VIEWER_TILE_CONCURRENCY = 6;

// ── State published to a renderer ─────────────────────────────────────────────

export type ViewerTileStatus = 'idle' | 'loading' | 'unfilled' | 'error' | 'ready';

/** One tile's runtime state (read-only view for the renderer). */
export interface ViewerTileState {
  tileId: string;
  queryId: string;
  title: string;
  status: ViewerTileStatus;
  isKpi: boolean;
  /** The resolved effective panel (base + variant + override), or null when the
   *  presentation could not resolve (then `status` is 'error'). */
  panel: Record<string, unknown> | null;
  columns: Column[] | null;
  rows: unknown[][] | null;
  meta: { rows: number; ms: number; bytes: number; truncated: boolean } | null;
  error: string | null;
  /** Param names still needing a value (status 'unfilled'). */
  unfilled: string[];
  /** Streamed row count while loading. */
  progressRows: number;
}

export type ViewerFilterStatus = 'idle' | 'loading' | 'error' | 'success';

/** One Dashboard filter's runtime state. */
export interface ViewerFilterState {
  id: string;
  parameter: string;
  label: string;
  active: boolean;
  value: unknown;
  status: ViewerFilterStatus;
  /** Curated options from the filter's source query, when it has one. */
  options: FilterHelperOption[] | null;
}

/** The Dashboard's per-render layout view (#291) — a discriminated union over
 *  the active layout ENGINE (`resolveLayoutPluginSync`, layout-registry.ts):
 *  `flow` keeps every `FlowLayoutModel` field verbatim (bit-identical to the
 *  pre-#291 shape) with an `engine` tag added; `grafana-grid` nests its own
 *  render model under `grid` instead of spreading it, so the two engines'
 *  same-named fields (both have `columns`) never collide on one object. */
export type DashboardLayoutView =
  | (FlowLayoutModel & { engine: 'flow' })
  | { engine: 'grafana-grid'; grid: GrafanaGridLayoutModel; renderMode: GridRenderMode };

export interface DashboardViewState {
  tiles: ViewerTileState[];
  filters: ViewerFilterState[];
  layout: DashboardLayoutView;
  /** Count of ACTIVE filter DEFINITIONS (not non-empty stored values, #188). */
  activeFilterCount: number;
  running: boolean;
  updatedAt: number | null;
  /** Presentation/structural diagnostics that make a tile invalid. */
  diagnostics: WorkspaceDiagnostic[];
}

// ── Narrow injected dependencies (no App / AppState / net imports) ────────────

/** The minimal streamed read the viewer needs — structurally the
 *  `QueryExecutionService.executeRead` seam, declared locally so the viewer
 *  never imports `src/application/**` (boundary rule). */
export interface ViewerReadRequest {
  sql: string;
  format?: string;
  rowLimit?: number;
  params?: Record<string, unknown>;
  signal?: AbortSignal;
  onChunk?: () => void;
}
export interface ViewerExecutor {
  // The real `QueryExecutionService.executeRead` returns the (mutated) result;
  // the viewer only reads the `result` it passed in, so the return is ignored.
  executeRead(result: StreamResult, request: ViewerReadRequest): Promise<unknown>;
}

/** The connection preflight seam (mirrors `ConnectionSession.ensureFreshToken`),
 *  declared locally for the same boundary reason. */
export interface ViewerConnection {
  ensureFreshToken(): Promise<boolean>;
}

export interface DashboardViewerDeps {
  /** The immutable Dashboard snapshot this session views. */
  document: DashboardDocumentV1;
  /** The workspace saved queries a tile/filter resolves against. */
  queries: readonly SavedQueryV2[];
  exec: ViewerExecutor;
  connection: ViewerConnection;
  /** Resolves the active layout plugin + fallback. Defaults to none — the
   *  viewer computes the flow model directly from the document either way; the
   *  registry is used only to fail closed when the layout cannot load. */
  registry?: DashboardLayoutRegistry;
  /** Perf clock (tile footer ms). */
  now(): number;
  /** Wall clock (one snapshot per prepared wave). */
  wallNow(): number;
  /** True at/below the mobile breakpoint — normalizes the flow to one column. */
  isMobile?(): boolean;
  /** Rendering container width in px, for the grafana-grid engine's own
   *  responsive effective-columns clamp (12/6/4/2 at the 1160/720/470
   *  breakpoints, `effectiveGridColumns`) — flow's responsive behavior stays
   *  the coarser `isMobile` binary flip above, unaffected by this. Absent or
   *  non-finite (not yet measured, or a non-DOM consumer) renders at the
   *  widest desktop breakpoint (12). */
  containerWidth?(): number | undefined;
  /** Fired when the token preflight fails (the shell wires sign-out). */
  onAuthFailed?(): void;
  /** #171 bound-param recording on a successful tile. */
  recordBoundParams?(boundParams: BoundParamSnapshot[]): void;
  /** #303: persisted per-filter seed, keyed by filter `def.id` — the shell
   *  reads this from the isolated `asb:dashFilters` store (never this layer;
   *  this session stays storage-free) and passes it in so a filter's initial
   *  runtime value/active reflects the last COMMITTED state instead of always
   *  resetting to `def.defaultValue`/`defaultActive`. A filter with no entry
   *  here (absent/empty map, or no key for its `def.id`) is unaffected — its
   *  initial state is exactly the pre-#303 default-derived behavior. */
  initialFilters?: Record<string, { value: unknown; active: boolean }>;
}

export interface DashboardViewerSession {
  readonly state: ReadonlySignal<DashboardViewState>;
  /** The `{name:Type}` field controls the filter bar renders (structure only). */
  readonly controls: FieldControl[];
  /** One field's prepared #170 validation state against the filter bar's DRAFT
   *  values/active (in-progress typing) — for the shared invalid-field affordance. */
  getFilterField(
    name: string, mode: ValidationMode, values: Record<string, unknown>, active: Record<string, boolean>,
  ): PreparedFieldState;
  /** Run the whole Dashboard once (token preflight → filter wave + tile waves). */
  start(): Promise<void>;
  /** Re-run every tile and the filter wave. */
  refresh(): Promise<void>;
  /** Re-run one tile with the current filter values. */
  refreshTile(tileId: string): Promise<void>;
  /** Set one filter's value (activates it) and run the one affected-panel wave. */
  setFilter(filterId: string, value: unknown): Promise<void>;
  /** Set one filter's value AND activation explicitly (the filter bar's commit,
   *  which owns activation for optional/curated fields), then run the one
   *  affected-panel wave. */
  applyFilter(filterId: string, value: unknown, active: boolean): Promise<void>;
  /** Deactivate one filter WITHOUT discarding its value (reactivation restores
   *  it); one affected-panel wave (#188 clear-one). */
  clearFilter(filterId: string): Promise<void>;
  /** Reset every filter to its `defaultActive`/`defaultValue`, coalesced into
   *  ONE affected-panel wave (#188 clear-all). */
  clearAllFilters(): Promise<void>;
  /** Abort one tile's in-flight request. */
  cancelTile(tileId: string): void;
  /** Adopt a layout/order-edited document (reorder, span/height, preset) WITHOUT
   *  re-running any tile: existing tile results are preserved by tile ID and the
   *  flow model is recomputed. The tile SET must be unchanged (a membership
   *  change rebuilds the session). */
  syncDocument(next: DashboardDocumentV1): void;
  /** #321 "Full view": set the TRANSIENT grafana-grid render-mode override
   *  ('tiles' = today's packed multi-tile-per-row grid, 'full' = every tile
   *  full-width, one per row). Runtime-only — never persisted, never a
   *  document mutation, never a commit/revision bump; it just republishes the
   *  current document through the new mode. Survives every other command
   *  (add/remove/reorder/height/syncDocument) since it lives outside
   *  `documentRef` entirely. A fresh session (reload/new viewer) always starts
   *  at 'tiles'. */
  setGridRenderMode(mode: GridRenderMode): void;
  /** Cancel all work and turn every later entry point into a no-op. */
  destroy(): void;
}

// ── Per-tile / per-filter runtime records (never published directly) ──────────

interface TileRuntime {
  tile: DashboardTileV1;
  query: SavedQueryV2 | undefined;
  panel: Record<string, unknown> | null;
  explicit: Panel | null;
  isKpi: boolean;
  isText: boolean;
  presentationError: WorkspaceDiagnostic | null;
  gen: number;
  abortController: AbortController | null;
  state: ViewerTileState;
}

interface FilterRuntime {
  def: DashboardFilterDefinitionV1;
  source: SavedQueryV2 | undefined;
  gen: number;
  abortController: AbortController | null;
  provider: FilterProvider | null;
  state: ViewerFilterState;
}

const cfgType = (panel: unknown): string | undefined =>
  (isObject(panel) && isObject(panel.cfg) && typeof panel.cfg.type === 'string' ? panel.cfg.type : undefined);

const toValueString = (value: unknown): string =>
  (typeof value === 'string' ? value : value == null ? '' : String(value));

/** Local copy of `effectiveFilterActive` (state.ts is off-limits to this
 *  layer): a param with an explicit activation entry uses it; otherwise a
 *  non-empty value counts as active. */
function effectiveActive(
  values: Record<string, unknown>, active: Record<string, boolean>,
): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const [name, value] of Object.entries(values)) out[name] = value != null && value !== '';
  for (const [name, on] of Object.entries(active)) out[name] = !!on;
  return out;
}

/** Bounded-concurrency map preserving append order (results by index). */
async function runPool<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const run = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) || 0 }, () => run()));
  return results;
}

/** Reserve the next generation for a runtime record and abort any in-flight
 *  request (stale-wave guard). Returns the reserved generation. */
function supersede(record: { gen: number; abortController: AbortController | null }): number {
  const generation = ++record.gen;
  if (record.abortController) record.abortController.abort();
  record.abortController = null;
  return generation;
}

/** Build a `DashboardViewerSession`. */
export function createDashboardViewerSession(deps: DashboardViewerDeps): DashboardViewerSession {
  const { queries } = deps;
  const registry = deps.registry;
  // The active document — layout/order edits (`syncDocument`) replace it without
  // re-running tiles; the initial tile SET is fixed for the session's analysis.
  let documentRef: DashboardDocumentV1 = deps.document;
  let destroyed = false;
  // #321 "Full view": a TRANSIENT runtime render-mode override, entirely
  // outside `documentRef` — never read/written by any command, never
  // persisted. A fresh session always starts at 'tiles'.
  let gridRenderMode: GridRenderMode = 'tiles';

  const queryById = new Map<string, SavedQueryV2>();
  for (const query of queries) {
    if (isObject(query) && typeof query.id === 'string' && !queryById.has(query.id)) queryById.set(query.id, query);
  }

  // Structural presentation validation (the SAME shared resolver) — reported
  // up front so an invalid tile presentation is visible without executing.
  const presentationDiagnostics = resolveDashboardPresentations({
    dashboard: documentRef, queries, path: ['dashboard'],
  });

  function buildTileRuntime(tile: DashboardTileV1): TileRuntime {
    const query = typeof tile.queryId === 'string' ? queryById.get(tile.queryId) : undefined;
    let panel: Record<string, unknown> | null = null;
    let presentationError: WorkspaceDiagnostic | null = null;
    if (!query) {
      presentationError = wsDiagnostic(['tiles'], 'dashboard-tile-query-missing',
        `No saved query ${JSON.stringify(tile.queryId)} for tile ${JSON.stringify(tile.id)}`, tile.id);
    } else {
      const resolved = resolvePresentation({ query, tile });
      if (resolved.ok) panel = resolved.panel;
      else presentationError = resolved.diagnostics[0];
    }
    const type = cfgType(panel);
    const isKpi = type === 'kpi';
    const isText = type === 'text';
    const explicit: Panel | null = isObject(panel) && isObject(panel.cfg) ? (panel as unknown as Panel) : null;
    const title = (typeof tile.title === 'string' && tile.title) || (query ? queryName(query) : tile.queryId) || tile.id;
    const state: ViewerTileState = {
      tileId: tile.id, queryId: tile.queryId, title, isKpi, panel,
      status: presentationError ? 'error' : 'idle',
      columns: null, rows: null, meta: null,
      error: presentationError ? presentationError.message : null,
      unfilled: [], progressRows: 0,
    };
    return { tile, query, panel, explicit, isKpi, isText, presentationError, gen: 0, abortController: null, state };
  }

  // One runtime record per tile, in semantic (dashboard.tiles) order.
  const tiles: TileRuntime[] = (Array.isArray(documentRef.tiles) ? documentRef.tiles : []).map(buildTileRuntime);

  // Filter runtime records, in filter order.
  const filters: FilterRuntime[] = (Array.isArray(documentRef.filters) ? documentRef.filters : []).map((def) => {
    const source = typeof def.sourceQueryId === 'string' ? queryById.get(def.sourceQueryId) : undefined;
    const defaultValue = def.defaultValue ?? '';
    const defaultActive = def.defaultActive ?? (def.defaultValue != null && def.defaultValue !== '');
    // #303: a persisted seed for this filter's id overrides the pure-default
    // init above (untouched when `initialFilters` is absent/empty, or has no
    // entry for `def.id`).
    const seed = deps.initialFilters ? deps.initialFilters[def.id] : undefined;
    const value = seed !== undefined ? (seed.value ?? defaultValue) : defaultValue;
    const active = seed !== undefined ? !!seed.active : defaultActive;
    const state: ViewerFilterState = {
      id: def.id, parameter: def.parameter, label: def.label || def.parameter,
      active, value, status: 'idle', options: null,
    };
    return { def, source, gen: 0, abortController: null, provider: null, state };
  });
  const filterById = new Map<string, FilterRuntime>(filters.map((filter) => [filter.def.id, filter]));

  // Parameter analysis over the tile SQL — fixed for the session (structure
  // only). Text tiles and missing-query tiles contribute empty SQL.
  const analysis: ParameterAnalysis = analyzeParameterizedSources(tiles.map((runtime) => ({
    id: runtime.tile.id, label: runtime.state.title, kind: 'tile',
    sql: runtime.query && !runtime.isText ? runtime.query.sql : '', bindPolicy: 'row-returning',
  })));
  const controls: FieldControl[] = fieldControls(analysis);

  // #235 overlap: the set of tile IDs a SOURCE-backed filter targets. A filter
  // with `targets` names them explicitly; an absent `targets` means every
  // panel tile whose query declares the filter's parameter. Only source-backed
  // filters gate — a plain value filter's value is already known.
  const affectedByFilterWave = new Set<string>();
  for (const filter of filters) {
    if (!filter.def.sourceQueryId) continue;
    const explicitTargets = Array.isArray(filter.def.targets) ? filter.def.targets : null;
    if (explicitTargets) {
      for (const id of explicitTargets) affectedByFilterWave.add(id);
      continue;
    }
    const field = analysis.fields[filter.def.parameter];
    if (!field) continue;
    for (const sourceId of field.requiredIn.concat(field.optionalIn)) affectedByFilterWave.add(sourceId);
  }

  // Curated option bundles from the last filter wave (param name → field).
  let curated: MergeDashboardFilterHelpersResult['fields'] = {};

  const rawValues = (): Record<string, unknown> =>
    Object.fromEntries(filters.map((filter) => [filter.def.parameter, toValueString(filter.state.value)]));
  const activeMap = (): Record<string, boolean> =>
    Object.fromEntries(filters.map((filter) => [filter.def.parameter, filter.state.active]));

  // Prepare a batch, optionally against a caller's DRAFT values/active (the
  // filter bar's in-progress typing) rather than the committed filter state —
  // so live #170 validation can run without mutating committed state.
  const prepareBatch = (
    mode: ValidationMode = 'execute',
    values: Record<string, unknown> = rawValues(),
    active: Record<string, boolean> = activeMap(),
  ) => prepareParameterizedBatch(analysis, {
    values: Object.fromEntries(Object.entries(values).map(([name, value]) =>
      [name, curated[name] && !active[name] ? '' : value])),
    active: effectiveActive(values, active),
    wallNowMs: deps.wallNow(), validationMode: mode,
  });

  /** One field's prepared #170 state against the caller's draft values/active
   *  (the filter bar reads this on every keystroke for the invalid affordance). */
  const getFilterField = (
    name: string, mode: ValidationMode, values: Record<string, unknown>, active: Record<string, boolean>,
  ) => prepareBatch(mode, values, active).fields[name];

  // ── State signal ────────────────────────────────────────────────────────
  const stateSignal: Signal<DashboardViewState> = signal(buildState(false, null));

  function buildState(running: boolean, updatedAt: number | null): DashboardViewState {
    const mobile = !!deps.isMobile?.();
    const visible = tiles.map((runtime) => ({ id: runtime.tile.id, isKpi: runtime.isKpi }));
    // #291: route to whichever engine the CURRENT document's layout resolves
    // to (`resolveLayoutPluginSync` — the same sync helper the application
    // layer's other non-awaitable call sites use, since this runs on every
    // publish and cannot await the async registry). An unsupported/foreign
    // primary with a valid flow@1 fallback still resolves to the flow plugin
    // here, exactly as before #291 (`computeFlowLayout`'s own fallback
    // handling, untouched) — flow behavior stays bit-identical.
    const plugin = resolveLayoutPluginSync(documentRef.layout);
    const layout: DashboardLayoutView = plugin.type === 'grafana-grid'
      ? {
        engine: 'grafana-grid',
        grid: computeGrafanaGridLayout({
          tiles: visible, layout: documentRef.layout, containerWidth: deps.containerWidth?.(), renderMode: gridRenderMode,
        }),
        renderMode: gridRenderMode,
      }
      : { engine: 'flow', ...computeFlowLayout({ tiles: visible, layout: documentRef.layout, mobile }) };
    return {
      tiles: tiles.map((runtime) => ({ ...runtime.state })),
      filters: filters.map((filter) => ({ ...filter.state })),
      layout,
      activeFilterCount: filters.filter((filter) => filter.state.active).length,
      running, updatedAt, diagnostics: presentationDiagnostics,
    };
  }

  function publish(running?: boolean, updatedAt?: number | null): void {
    const previous = stateSignal.value;
    stateSignal.value = buildState(
      running ?? previous.running,
      updatedAt === undefined ? previous.updatedAt : updatedAt,
    );
  }

  // ── Tile execution ────────────────────────────────────────────────────────

  function tileResultMeta(result: StreamResult, startedAt: number, finishedAt: number) {
    return {
      rows: result.rows.length, ms: Math.round(finishedAt - startedAt),
      bytes: result.progress.bytes, truncated: result.capped,
    };
  }

  async function runTile(runtime: TileRuntime, source: PreparedSource | undefined, generation: number): Promise<void> {
    if (runtime.gen !== generation || !source) return;
    if (source.missing.length || source.invalid.length) {
      runtime.state.status = 'unfilled';
      runtime.state.unfilled = source.missing.concat(source.invalid);
      publish();
      return;
    }
    if (source.errors.length) {
      runtime.state.status = 'error';
      runtime.state.error = source.errors[0];
      publish();
      return;
    }
    // `!`: runtime.query is present for every runnable (non-error) tile.
    const querySql = runtime.query!.sql;
    const execSql = hasOptionalBlocks(querySql) ? mergedSourceSql(source, querySql) : querySql;
    const execution = panelExecution(runtime.explicit, execSql, {
      format: 'Table', rowLimit: DASH_TILE_ROW_CAP + 1,
      params: { readonly: 2, max_result_bytes: DASH_TILE_BYTE_CAP, ...mergedSourceArgs(source) },
    });
    const checkFormat = !runtime.isKpi;
    if (execution.error || (checkFormat && detectSqlFormat(execSql))) {
      runtime.state.status = 'error';
      runtime.state.error = execution.error
        || 'Dashboard panels require structured streaming results. Remove the explicit FORMAT clause.';
      publish();
      return;
    }
    runtime.state.status = 'loading';
    runtime.state.progressRows = 0;
    publish();
    const controller = new AbortController();
    runtime.abortController = controller;
    const startedAt = deps.now();
    const rowCap = runtime.isKpi ? 2 : DASH_TILE_ROW_CAP;
    // `!`: panelExecution always resolves a concrete format ('Table' default or 'KPI').
    const result = newResult(execution.format!, rowCap);
    await deps.exec.executeRead(result, {
      sql: execSql, format: execution.format, rowLimit: execution.rowLimit,
      params: execution.params, signal: controller.signal,
      onChunk: () => {
        if (runtime.gen !== generation) return;
        runtime.state.progressRows = result.progress.rows;
        publish();
      },
    });
    if (runtime.gen !== generation) return; // superseded mid-stream
    runtime.abortController = null;
    if (result.error != null || result.cancelled) {
      runtime.state.status = 'error';
      runtime.state.error = result.error || 'Cancelled';
      publish();
      return;
    }
    runtime.state.status = 'ready';
    runtime.state.error = null;
    runtime.state.unfilled = [];
    runtime.state.columns = result.columns as unknown as Column[];
    runtime.state.rows = result.rows;
    runtime.state.meta = tileResultMeta(result, startedAt, deps.now());
    deps.recordBoundParams?.(source.statements.flatMap((statement) => statement.boundParams));
    publish();
  }

  function markTextAndErrorTiles(): void {
    for (const runtime of tiles) {
      if (runtime.presentationError) { runtime.state.status = 'error'; continue; }
      if (runtime.isText) {
        runtime.state.status = 'ready';
        runtime.state.columns = [];
        runtime.state.rows = [];
      }
    }
  }

  // A tile is runnable when it has a query and is neither a text panel nor a
  // presentation error.
  const runnableTiles = (): TileRuntime[] =>
    tiles.filter((runtime) => runtime.query && !runtime.isText && !runtime.presentationError);

  // ── Filter wave ─────────────────────────────────────────────────────────

  async function runFilterSource(filter: FilterRuntime, generation: number): Promise<FilterProvider | null> {
    // `!`: only called for filters whose source query is present.
    const query = filter.source!;
    const execution = filterExecution(query.sql);
    if (execution.error) {
      const provider: FilterProvider = {
        sourceId: filter.def.id, sourceName: queryName(query), helpers: [], diagnostics: execution.diagnostics,
      };
      if (filter.gen !== generation) return null;
      filter.state.status = 'error';
      filter.provider = provider;
      return provider;
    }
    if (filter.gen !== generation) return null;
    filter.state.status = 'loading';
    const result = newResult(execution.format, execution.rowLimit);
    const controller = new AbortController();
    filter.abortController = controller;
    await deps.exec.executeRead(result, {
      sql: query.sql, format: execution.format, rowLimit: execution.rowLimit,
      params: execution.params, signal: controller.signal,
    });
    if (filter.gen !== generation) return null;
    filter.abortController = null;
    let provider: FilterProvider;
    if (result.error || result.cancelled) {
      provider = {
        sourceId: filter.def.id, sourceName: queryName(query), helpers: [],
        diagnostics: [coreDiagnostic('error', 'filter-query-failed',
          `${queryName(query)}: ${result.error || 'Filter query was cancelled.'}`, { sourceId: filter.def.id })],
      };
      filter.state.status = 'error';
    } else {
      const normalized = readFilterOptions({
        columns: result.columns, row: result.rows[0], rowCount: result.rows.length,
      });
      provider = { sourceId: filter.def.id, sourceName: queryName(query), ...normalized };
      filter.state.status = normalized.helpers.length ? 'success' : 'error';
    }
    filter.provider = provider;
    return provider;
  }

  function applyFilterProviders(providers: (FilterProvider | null)[]): void {
    const merged = mergeDashboardFilterHelpers({
      providers: providers.filter((provider): provider is FilterProvider => provider !== null),
      controls, values: rawValues(), active: effectiveActive(rawValues(), activeMap()),
    });
    curated = merged.fields;
    // Publish curated options onto each filter whose parameter got a field.
    for (const filter of filters) {
      const field = merged.fields[filter.def.parameter];
      filter.state.options = field ? field.options : filter.state.options;
    }
  }

  async function runFilterWave(): Promise<void> {
    const sourced = filters.filter((filter) => filter.source);
    const plan = sourced.map((filter) => ({ filter, generation: supersede(filter) }));
    const providers = await runPool(plan, VIEWER_TILE_CONCURRENCY,
      ({ filter, generation }) => runFilterSource(filter, generation));
    applyFilterProviders(providers);
  }


  // ── Waves ─────────────────────────────────────────────────────────────────

  async function preflight(): Promise<boolean> {
    if (destroyed) return false;
    if (!(await deps.connection.ensureFreshToken())) {
      if (!destroyed) deps.onAuthFailed?.();
      return false;
    }
    return !destroyed;
  }

  function sourcesById(prepared: PreparedSource[]): Map<string, PreparedSource> {
    return new Map(analysis.sources.map((source, index) => [source.id, prepared[index]]));
  }

  async function refresh(): Promise<void> {
    if (!(await preflight())) return;
    markTextAndErrorTiles();
    const runnable = runnableTiles();
    // Reserve every runnable tile's generation up front (stale-wave guard).
    const generations = new Map<string, number>(runnable.map((runtime) => [runtime.tile.id, supersede(runtime)]));
    const unaffected = runnable.filter((runtime) => !affectedByFilterWave.has(runtime.tile.id));
    const affected = runnable.filter((runtime) => affectedByFilterWave.has(runtime.tile.id));
    publish(true);
    // #235: launch the unaffected tiles NOW (with current values) in parallel
    // with the filter wave — they never wait for a source query.
    const firstBatch = sourcesById(prepareBatch('execute').sources);
    const unaffectedWave = runPool(unaffected, VIEWER_TILE_CONCURRENCY,
      (runtime) => runTile(runtime, firstBatch.get(runtime.tile.id), generations.get(runtime.tile.id)!));
    const filterWave = runFilterWave();
    await filterWave;
    if (destroyed) { await unaffectedWave; return; }
    // Affected tiles run AFTER the filter wave, with the merged/blanked values.
    const secondBatch = sourcesById(prepareBatch('execute').sources);
    const affectedWave = runPool(affected, VIEWER_TILE_CONCURRENCY,
      (runtime) => runTile(runtime, secondBatch.get(runtime.tile.id), generations.get(runtime.tile.id)!));
    await Promise.all([unaffectedWave, affectedWave]);
    publish(false, destroyed ? null : deps.now());
  }

  const start = refresh;

  async function refreshTile(tileId: string): Promise<void> {
    const runtime = tiles.find((entry) => entry.tile.id === tileId);
    if (!runtime || !runtime.query || runtime.isText || runtime.presentationError) return;
    if (!(await preflight())) return;
    const generation = supersede(runtime);
    const prepared = sourcesById(prepareBatch('execute').sources);
    await runTile(runtime, prepared.get(tileId), generation);
  }

  // Re-run only the tiles some active filter parameter feeds into.
  async function runAffectedWave(parameters: string[]): Promise<void> {
    if (!(await preflight())) return;
    const affectedIds = new Set<string>();
    for (const parameter of parameters) {
      const field = analysis.fields[parameter];
      if (!field) continue;
      for (const sourceId of field.requiredIn.concat(field.optionalIn)) affectedIds.add(sourceId);
    }
    const targets = runnableTiles().filter((runtime) => affectedIds.has(runtime.tile.id));
    const generations = new Map<string, number>(targets.map((runtime) => [runtime.tile.id, supersede(runtime)]));
    const prepared = sourcesById(prepareBatch('execute').sources);
    publish();
    await runPool(targets, VIEWER_TILE_CONCURRENCY,
      (runtime) => runTile(runtime, prepared.get(runtime.tile.id), generations.get(runtime.tile.id)!));
  }

  async function setFilter(filterId: string, value: unknown): Promise<void> {
    if (destroyed) return;
    const filter = filterById.get(filterId);
    if (!filter) return;
    filter.state.value = value;
    filter.state.active = value != null && value !== '';
    publish();
    await runAffectedWave([filter.def.parameter]);
  }

  async function applyFilter(filterId: string, value: unknown, active: boolean): Promise<void> {
    if (destroyed) return;
    const filter = filterById.get(filterId);
    if (!filter) return;
    // The filter bar owns activation for optional/curated fields, so value and
    // active are set independently (unlike setFilter's value-implies-active).
    filter.state.value = value;
    filter.state.active = active;
    publish();
    await runAffectedWave([filter.def.parameter]);
  }

  async function clearFilter(filterId: string): Promise<void> {
    if (destroyed) return;
    const filter = filterById.get(filterId);
    if (!filter) return;
    // Deactivate but keep the value so reactivation restores it.
    filter.state.active = false;
    publish();
    await runAffectedWave([filter.def.parameter]);
  }

  async function clearAllFilters(): Promise<void> {
    if (destroyed) return;
    const changed: string[] = [];
    for (const filter of filters) {
      const nextActive = filter.def.defaultActive ?? false;
      const nextValue = filter.def.defaultValue ?? '';
      if (filter.state.active !== nextActive || filter.state.value !== nextValue) changed.push(filter.def.parameter);
      filter.state.active = nextActive;
      filter.state.value = nextValue;
    }
    publish();
    // Coalesce every reset into ONE affected-panel wave (#188 clear-all).
    if (changed.length) await runAffectedWave(changed);
  }

  function cancelTile(tileId: string): void {
    const runtime = tiles.find((entry) => entry.tile.id === tileId);
    if (!runtime) return;
    runtime.gen++;
    if (runtime.abortController) { runtime.abortController.abort(); runtime.abortController = null; }
    if (runtime.state.status === 'loading') { runtime.state.status = 'idle'; publish(); }
  }

  function syncDocument(next: DashboardDocumentV1): void {
    if (destroyed) return;
    documentRef = next;
    // Reorder the runtime records to the new tile order, preserving each tile's
    // results by ID; unknown IDs are dropped (defensive — a membership change
    // should rebuild the session, not sync).
    const byId = new Map(tiles.map((runtime) => [runtime.tile.id, runtime]));
    const reordered: TileRuntime[] = [];
    for (const tile of Array.isArray(next.tiles) ? next.tiles : []) {
      const runtime = byId.get(tile.id);
      if (runtime) { runtime.tile = tile; reordered.push(runtime); }
    }
    tiles.length = 0;
    tiles.push(...reordered);
    publish();
  }

  function setGridRenderMode(mode: GridRenderMode): void {
    if (destroyed || gridRenderMode === mode) return;
    gridRenderMode = mode;
    publish();
  }

  function destroy(): void {
    destroyed = true;
    for (const runtime of tiles) {
      runtime.gen++;
      if (runtime.abortController) { runtime.abortController.abort(); runtime.abortController = null; }
    }
    for (const filter of filters) {
      filter.gen++;
      if (filter.abortController) { filter.abortController.abort(); filter.abortController = null; }
    }
  }

  return {
    state: stateSignal as ReadonlySignal<DashboardViewState>,
    controls, getFilterField,
    start, refresh, refreshTile, setFilter, applyFilter, clearFilter, clearAllFilters, cancelTile, syncDocument,
    setGridRenderMode, destroy,
  };
}
