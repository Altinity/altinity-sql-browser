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
import { analyzeFilterSource, prepareFilterSource } from '../../core/filter-execution.js';
import type { FilterSourceAnalysis } from '../../core/filter-execution.js';
import { readFilterOptions } from '../../core/filter-options.js';
import { resolveFilterSelection, sameSelection } from '../../core/filter-selection.js';
import type { FilterSelectionFilterDef } from '../../core/filter-selection.js';
import { mergeDashboardFilterHelpers } from '../../core/dashboard-filters.js';
import type {
  FilterProvider, FilterHelperOption, FilterDiagnostic, MergeDashboardFilterHelpersResult,
} from '../../core/dashboard-filters.js';
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

/** A filter's own transport/curation status — derived per DEFINITION (not per
 *  source runtime) after the shared source's merge:
 *  - `idle`/`loading` mirror the source's transport state directly.
 *  - `ready` — the merge produced a curated field for this filter's parameter.
 *  - `missing-helper` — the source succeeded but never returned this column
 *    (no merge/source diagnostic names it either).
 *  - `helper-error` — the source succeeded but a merge/source diagnostic
 *    names this exact parameter as the failing helper (duplicate provider,
 *    invalid option, unused, …).
 *  - `source-error` — the shared source query itself failed (missing query,
 *    invalid SQL, transport/exec error).
 *  - `waiting` (#360) — the shared source has a runnable query but one of its
 *    OWN `{name:Type}` parameters (fed by another, root Dashboard filter) has
 *    no value yet. Not an error — a normal mid-fill state.
 *  A plain filter (no `sourceQueryId`) never leaves `idle`. */
export type ViewerFilterStatus =
  'idle' | 'loading' | 'waiting' | 'ready' | 'missing-helper' | 'helper-error' | 'source-error';

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
  /** Bumped whenever `options`' VALUE CONTENT changes (including a clear to
   *  `null`) — never on an unchanged re-publish. The UI folds this into its
   *  filter-bar rebuild signature so a same-length-but-different option set
   *  (or a null->non-null->null cycle) still triggers a rebuild (#359). */
  optionsRev: number;
  /** #360: true while this filter's shared source is mid-flight (`loading`)
   *  or genuinely blocked pending a dependency (`waiting`) — the currently
   *  published `options` should not be trusted as a fresh, actionable answer.
   *  False for every settled terminal status (`ready`, and every error
   *  status). Optional so no other consumer of this shape breaks. */
  stale?: boolean;
  /** #360: when `status` is `'waiting'`, the missing dependency parameter
   *  names (from `FilterSourcePreparation.missing`) the filter-bar UI/
   *  diagnostics can name. Absent otherwise. */
  waitingFor?: string[];
  /** #360: the shared `FilterSourceRuntime.id` this filter is a
   *  consumer of, set once at construction from the filter DEFINITION's
   *  `sourceQueryId` — undefined for a plain root filter (no source at all).
   *  This is TOPOLOGY, not transport state (unlike `status`/`stale`, it never
   *  changes across a session), so a later UI wave can pick the curated
   *  renderer for a source-backed filter by construction rather than by
   *  inferring it from a transient status value. */
  sourceId?: string;
  /** #189: the agreed searchable-multiselect contract for a SOURCE-BACKED
   *  filter, set once at construction from `resolveFilterSelection`
   *  (`core/filter-selection.ts`) — present iff that resolution's
   *  diagnostics were empty (a curated helper is actually offered); absent
   *  otherwise (including for every plain root filter, which never gets a
   *  contract at all) — the plain string-input fallback then applies, same
   *  as a filter with no source. `mode` is the EFFECTIVE selection mode
   *  (`selection.mode` table); `array` mirrors the agreed contract's own
   *  arity, independent of `mode` (a scalar contract with `selection.mode:
   *  "single"`-on-Array still reports `array: true` here — see the mode
   *  table). TOPOLOGY, not transport state — like `sourceId`, it never
   *  changes across a session. */
  selection?: { mode: 'single' | 'multiple'; array: boolean };
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
  /** Every diagnostic the LAST filter wave's shared-source merge produced
   *  (info/warning/error, #359) — published as-is, never deduped (a shared
   *  source now runs exactly once per wave, so its diagnostics already
   *  appear once by construction). Reset to `[]` at the start of each wave;
   *  a pre-wave publish (session construction) also reads `[]`. */
  filterDiagnostics: FilterDiagnostic[];
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

/** One per Dashboard filter DEFINITION. Carries no transport state of its own
 *  (#359) — `sourceId` (when it resolves) points at the shared
 *  `FilterSourceRuntime` that actually runs the query; a plain filter (no
 *  `sourceQueryId`) has no `sourceId` and is never a consumer of any source. */
interface FilterRuntime {
  def: DashboardFilterDefinitionV1;
  sourceId?: string;
  state: ViewerFilterState;
}

/** One per UNIQUE `sourceQueryId` (#359) — N filter definitions sharing the
 *  same source query share exactly ONE of these, so the source SQL executes
 *  once per wave no matter how many filters/parameters it feeds. `status` is
 *  the TRANSPORT status only (idle/loading/ready/error) — never a per-filter
 *  curation outcome; per-consumer `ViewerFilterStatus` is derived from this
 *  plus the merge result in `applyFilterProviders`. `query` is `undefined`
 *  when `sourceQueryId` does not resolve against `queryById` — that still
 *  gets a runtime (so every consumer sees a visible `source-error`), it just
 *  never executes. `provider` is the source's LAST-KNOWN normalized
 *  contribution — `runFilterSource` updates it only for the current
 *  generation, and `applyFilterProviders` merges the COMPLETE set from every
 *  source runtime (not just the sources a wave re-ran). That is the
 *  source-runtime boundary #360 needs: a selective wave that reruns only the
 *  Filter sources a changed root parameter feeds can retain and re-merge every
 *  unaffected source's helpers instead of clearing them or rerunning all. */
interface FilterSourceRuntime {
  id: string;
  query: SavedQueryV2 | undefined;
  consumers: FilterRuntime[];
  gen: number;
  abortController: AbortController | null;
  status: 'idle' | 'waiting' | 'loading' | 'ready' | 'error';
  provider: FilterProvider | null;
  /** #360: this source's own static analysis (structural + cascading
   *  diagnostics, and the root parameter names — `dependsOn` — its OWN
   *  `{name:Type}` declarations depend on). Computed once at construction
   *  from the source's SQL; `prepareFilterSource` re-prepares it against
   *  concrete committed values every wave without re-scanning the SQL. */
  analyzed: FilterSourceAnalysis;
  /** #360: the last-known missing dependency parameter names (from
   *  `FilterSourcePreparation.missing`) while `status === 'waiting'` — read
   *  by `applyFilterProviders` to publish each consumer's `waitingFor`. */
  missing: string[];
}

const cfgType = (panel: unknown): string | undefined =>
  (isObject(panel) && isObject(panel.cfg) && typeof panel.cfg.type === 'string' ? panel.cfg.type : undefined);

const toValueString = (value: unknown): string =>
  (typeof value === 'string' ? value : value == null ? '' : String(value));

/** #189: array-safe replacement for `toValueString` at every seam that feeds
 *  `prepareParameterizedBatch`/`prepareFilterSource` (`rawValues`,
 *  `committedRootValues`) — a committed multiselect value is a REAL string
 *  array, and the pipeline/serializer already understand `Array(...)`-typed
 *  params, so it must reach them un-stringified. A non-empty array passes
 *  through as a DEFENSIVE COPY (never the live array a caller might still
 *  hold); an EMPTY array reads as "no value" — same as `''` — for every
 *  missing/inactive/readiness purpose downstream, exactly like a blank text
 *  filter. Every other shape keeps `toValueString`'s existing coercion,
 *  unchanged. */
const toParamValue = (value: unknown): unknown =>
  (Array.isArray(value) ? (value.length ? value.slice() : '') : toValueString(value));

/** #189: defensive array copy for every seat that STORES a filter's raw
 *  committed value (`filter.state.value`, an `initialFilters` seed, a
 *  `def.defaultValue`) — never `toParamValue`'s job, which additionally
 *  coerces non-array shapes to a string for the execution pipeline. Runtime
 *  state must never alias an array a caller (the document, the persisted
 *  seed, `setFilter`/`applyFilter`'s own caller) still holds a reference to. */
const copyValue = (value: unknown): unknown => (Array.isArray(value) ? value.slice() : value);

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

  // A tile is EXECUTABLE/runnable when it has a query and is neither a text
  // panel nor a presentation error — structural, fixed for the session, so
  // both `runnableTiles()` (below) and the #189 selection-contract resolver
  // (which needs the id SET, not the records) derive it from this ONE
  // predicate and can never drift apart.
  const isRunnableTileRuntime = (runtime: TileRuntime): boolean =>
    !!runtime.query && !runtime.isText && !runtime.presentationError;
  const executableTileIds = new Set(tiles.filter(isRunnableTileRuntime).map((runtime) => runtime.tile.id));

  // Filter runtime records, in filter order.
  const filters: FilterRuntime[] = (Array.isArray(documentRef.filters) ? documentRef.filters : []).map((def) => {
    const defaultValue = copyValue(def.defaultValue ?? '');
    const defaultActive = def.defaultActive ?? (def.defaultValue != null && def.defaultValue !== '');
    // #303: a persisted seed for this filter's id overrides the pure-default
    // init above (untouched when `initialFilters` is absent/empty, or has no
    // entry for `def.id`). #189: `copyValue` defends against aliasing the
    // caller's own seed/document array (a persisted multiselect value, or a
    // `defaultValue` array literal on the document).
    const seed = deps.initialFilters ? deps.initialFilters[def.id] : undefined;
    const value = copyValue(seed !== undefined ? (seed.value ?? defaultValue) : defaultValue);
    const active = seed !== undefined ? !!seed.active : defaultActive;
    const sourceId = typeof def.sourceQueryId === 'string' ? def.sourceQueryId : undefined;
    const state: ViewerFilterState = {
      id: def.id, parameter: def.parameter, label: def.label || def.parameter,
      active, value, status: 'idle', options: null, optionsRev: 0, sourceId,
    };
    return { def, sourceId, state };
  });
  const filterById = new Map<string, FilterRuntime>(filters.map((filter) => [filter.def.id, filter]));

  // #360: parameters BACKED BY a Filter source (every filter definition that
  // has a `sourceQueryId`) — a shared source's OWN `{name:Type}` declarations
  // may never depend on one of these (a Filter depending on a Filter would
  // need a strict dependency order this app has no scheduler for); passed to
  // `analyzeFilterSource` below so that cascading dependency becomes its own
  // `filter-source-cascading` diagnostic per source, at construction time.
  const sourceBackedParams = new Set(
    filters.filter((filter) => filter.sourceId).map((filter) => filter.def.parameter),
  );

  // One `FilterSourceRuntime` per UNIQUE `sourceQueryId` (#359 — the bug this
  // refactor fixes: N definitions sharing a source used to run it N times,
  // each provider keyed by the wrong id, so the merge rejected every helper
  // as a duplicate). A missing query still gets a runtime (`query: undefined`)
  // so every consumer sees a visible `source-error` rather than being
  // silently skipped.
  const filterSources = new Map<string, FilterSourceRuntime>();
  for (const filter of filters) {
    if (!filter.sourceId) continue;
    let source = filterSources.get(filter.sourceId);
    if (!source) {
      const sourceQuery = queryById.get(filter.sourceId);
      source = {
        id: filter.sourceId, query: sourceQuery,
        consumers: [], gen: 0, abortController: null, status: 'idle', provider: null,
        analyzed: analyzeFilterSource(sourceQuery?.sql, {
          sourceBackedParams, label: sourceQuery ? queryName(sourceQuery) : filter.sourceId,
        }),
        missing: [],
      };
      filterSources.set(filter.sourceId, source);
    }
    source.consumers.push(filter);
  }

  // Parameter analysis over the tile SQL — fixed for the session (structure
  // only). Text tiles and missing-query tiles contribute empty SQL.
  const analysis: ParameterAnalysis = analyzeParameterizedSources(tiles.map((runtime) => ({
    id: runtime.tile.id, label: runtime.state.title, kind: 'tile',
    sql: runtime.query && !runtime.isText ? runtime.query.sql : '', bindPolicy: 'row-returning',
  })));
  const controls: FieldControl[] = fieldControls(analysis);

  // Every tile id the document actually declares — `resolveFilterTargets`
  // (#189) validates a filter's explicit `def.targets` against this set
  // (dropping unknown ids defensively) rather than trusting authored config.
  const knownTileIds = new Set(tiles.map((runtime) => runtime.tile.id));

  /** #189: one filter DEFINITION's own resolved target tile set — explicit
   *  `def.targets` (validated against `knownTileIds`) when present, else
   *  every tile whose SQL declares `def.parameter` (`requiredIn`/`optionalIn`
   *  from the tile parameter `analysis`). The ONE shared resolution both
   *  `affectedByFilterWave` (#235's source-backed-only pre-wave
   *  classification, below) and `targetsByParameter` (the general #189
   *  affected-panel planner `runAffectedWave` consults) derive from, so the
   *  two "explicit targets else declared" computations can never drift
   *  apart. An explicit `targets: []` (present but empty) deliberately
   *  resolves to affecting NOTHING — it does not fall back to the declared
   *  set — preserving the pre-#189 `affectedByFilterWave` behavior exactly. */
  function resolveFilterTargets(def: DashboardFilterDefinitionV1): Set<string> {
    if (Array.isArray(def.targets)) return new Set(def.targets.filter((id) => knownTileIds.has(id)));
    const field = analysis.fields[def.parameter];
    return field ? new Set(field.requiredIn.concat(field.optionalIn)) : new Set();
  }

  // #189: the general affected-panel planner `runAffectedWave` consults for
  // EVERY committed parameter (root or source-backed) — every filter
  // definition's own resolved targets, unioned per PARAMETER (two filter
  // definitions sharing one parameter union their target sets, since
  // committing that parameter must satisfy both).
  const targetsByParameter = new Map<string, Set<string>>();
  for (const filter of filters) {
    const set = targetsByParameter.get(filter.def.parameter) || new Set<string>();
    for (const id of resolveFilterTargets(filter.def)) set.add(id);
    targetsByParameter.set(filter.def.parameter, set);
  }

  // #189: `resolveFilterSelection`'s own documented contract (see its return
  // type's doc comment) is strict — the curated helper is exposed IFF
  // `diagnostics` is empty, full stop. Issue #189's fallback list is explicit
  // that "targets that do not declare the parameter" and "target-less or
  // non-executable configurations where no consumer contract can be
  // resolved" (i.e. `filter-selection-target-missing-declaration`,
  // `filter-selection-target-not-executable`, `filter-selection-no-consumers`)
  // are must-fall-back cases, not benign ones: "do not execute or expose the
  // query-backed helper as authoritative; render the ordinary parameter
  // string input; show a visible diagnostic; leave unrelated filters and
  // panels functional." So there is no carve-out here — EVERY non-empty
  // `diagnostics` result (whatever the code) falls a filter all the way back
  // to the plain string-input path: no `selection` contract is published, no
  // `sourceId` is kept, and the filter is dropped from its source's
  // `consumers` so the shared source query is never executed on its behalf
  // (matching #189's "do not execute... the query-backed helper").

  // #189: resolve every SOURCE-BACKED filter's searchable-multiselect
  // contract once, at construction (structural — never revisited). A filter
  // whose resolution surfaces ANY diagnostic falls all the way back to the
  // plain string-input filter: it is stripped from `state.sourceId` (the
  // UI's own curation gate) and from its `FilterSourceRuntime`'s `consumers`
  // — its helper must never execute. `staticFilterDiagnostics` is emitted
  // ALONGSIDE (never instead of) the per-wave `filterDiagnostics` — see
  // `buildState`'s doc comment for why these need to be two separate arrays.
  //
  // Review finding (major): `resolveFilterSelection` above only agrees over
  // this filter's own resolved TARGETS (explicit `def.targets`, else the
  // tiles declaring the parameter) — it never looks at a tile OUTSIDE that
  // scope (a Filter source is never a consumer at all — see
  // `gatherExecutableConsumers`'s doc comment in `core/filter-selection.ts`
  // for the single shared "executable consumer" definition and the #360
  // cascading rule behind it). But the per-wave merge
  // (`mergeDashboardFilterHelpers`, `core/dashboard-filters.ts`) rejects a
  // curated field on `control.conflict` from `fieldControls(analysis)` —
  // computed DASHBOARD-WIDE, over every tile's declaration of the parameter,
  // not just this filter's targets. So a filter whose resolution agreed
  // (e.g. every explicit target declares `Array(String)`) can still publish
  // a `selection` contract and keep its source consumer, only for EVERY
  // wave's merge to permanently reject the curated field as
  // `filter-target-type-conflict` (a non-targeted or presentation-error tile
  // declares a conflicting `String`) — a stuck hybrid: a published
  // multiselect contract with a permanently-dead curated field, never
  // reverting to the plain string input. `resolveFilterSelection`'s own
  // target-scoped agreement is deliberately narrowed FURTHER here by this
  // dashboard-wide gate, for consistency with `mergeDashboardFilterHelpers`'
  // field-level conflict rejection: one behavior (fall back, all the way),
  // never a hybrid state depending on which layer looks first.
  const controlsByName = new Map(controls.map((control): [string, FieldControl] => [control.name, control]));
  const staticFilterDiagnostics: FilterDiagnostic[] = [];
  for (const filter of filters) {
    if (!filter.sourceId) continue; // plain root filter — no contract, untouched
    const source = filterSources.get(filter.sourceId)!; // built above for every sourceId-bearing filter
    // A Filter source is NEVER an executable consumer of its own filter's
    // parameter (#360's single-layer cascading rule already forbids any
    // Filter source from depending on a SOURCE-BACKED parameter — this
    // filter's own parameter always qualifies, since it has a `sourceId` —
    // so a source that structurally declared it would already carry its own
    // `filter-source-cascading` diagnostic and never run). See
    // `gatherExecutableConsumers`'s doc comment in `core/filter-selection.ts`
    // for the one shared "executable consumer" definition this resolution
    // (and the semantic validator's own construction-time re-check) both use.
    const filterSelectionDef: FilterSelectionFilterDef = {
      id: filter.def.id, parameter: filter.def.parameter,
      targets: Array.isArray(filter.def.targets) ? filter.def.targets : undefined,
      selection: filter.def.selection,
    };
    const resolution = resolveFilterSelection(filterSelectionDef, analysis, executableTileIds);
    // The same signal `mergeDashboardFilterHelpers` gates `control.conflict`
    // on (`fieldControls(analysis)`, dashboard-wide) — checked here too, even
    // when `resolution` itself agreed, so this filter can never publish a
    // contract the merge layer would reject on every wave forever (see the
    // doc comment above this loop).
    const dashboardControl = controlsByName.get(filter.def.parameter);
    const dashboardConflict = dashboardControl?.conflict?.length ? dashboardControl.conflict : null;
    if (resolution.diagnostics.length || dashboardConflict) {
      for (const d of resolution.diagnostics) staticFilterDiagnostics.push(d as FilterDiagnostic);
      if (dashboardConflict) {
        staticFilterDiagnostics.push(coreDiagnostic('error', 'filter-selection-dashboard-type-conflict',
          `Filter "${filter.def.id}" parameter {${filter.def.parameter}} has a dashboard-wide type conflict across ` +
          `Panel declarations: ${dashboardConflict.join(' vs ')}. Declarations OUTSIDE this filter's own targets ` +
          `still count for the shared curated-field layer (mergeDashboardFilterHelpers), which rejects a ` +
          `dashboard-wide conflict regardless of which tiles this filter targets.`,
          { filterId: filter.def.id, parameter: filter.def.parameter, types: dashboardConflict }));
      }
      filter.state.sourceId = undefined;
      source.consumers = source.consumers.filter((consumer) => consumer !== filter);
    } else {
      filter.state.selection = { mode: resolution.mode!, array: resolution.contract!.array };
    }
  }
  // A `FilterSourceRuntime` left with zero consumers (every filter that
  // named it fell back to the string-input path above) must never execute —
  // both `runFilterWave` (every KNOWN source) and `runFilterSourceWave` (the
  // `dependsOn`-filtered selective rerun) iterate `filterSources.values()`,
  // so removing it here is the one place that guarantees it forever, rather
  // than re-deriving a "has consumers" gate at every call site.
  for (const [id, source] of filterSources) {
    if (source.consumers.length === 0) filterSources.delete(id);
  }

  // #235 overlap: the set of tile IDs a SOURCE-backed filter targets. Only
  // source-backed filters gate — a plain value filter's value is already
  // known, so tiles it feeds never need to wait for the filter/source wave.
  //
  // Review finding (minor): this MUST be computed AFTER the #189
  // resolution/fallback loop above, gated on the POST-resolution
  // `filter.state.sourceId` — not the structural `filter.def.sourceQueryId`.
  // A filter whose resolution fell back (dropped from `state.sourceId` and
  // from its source's `consumers`, possibly deleting the source runtime
  // entirely just above) has nothing left to defer against: its target tiles
  // must not be needlessly classified "affected" and deferred behind a
  // filter/source wave that either never runs the source at all, or runs it
  // for other, still-healthy consumers only. Gating on the stale
  // `def.sourceQueryId` instead would defer those tiles forever for no
  // reason. `targetsByParameter` (above) stays keyed on every filter
  // definition regardless of resolution outcome — it feeds the general
  // affected-panel planner (`runAffectedWave`), which is orthogonal to this
  // pre-wave overlap classification.
  const affectedByFilterWave = new Set<string>();
  for (const filter of filters) {
    if (!filter.state.sourceId) continue;
    for (const id of resolveFilterTargets(filter.def)) affectedByFilterWave.add(id);
  }

  // Curated option bundles from the last filter wave (param name → field).
  let curated: MergeDashboardFilterHelpersResult['fields'] = {};
  // The last filter wave's merge diagnostics (#359) — a closure var like
  // `curated`, reset to `[]` at the START of `runFilterWave` and set (as-is,
  // no dedupe) in `applyFilterProviders`. `buildState` reads it on every
  // publish, so tile-progress publishes mid-wave carry the PREVIOUS wave's
  // diagnostics and a pre-wave publish (construction) sees `[]`. #189's
  // `staticFilterDiagnostics` (construction-time constants) are concatenated
  // in ON TOP of this at every publish (`buildState`) — never reset,
  // never touched by a wave — so a filter's selection-resolution failure
  // stays visible forever, through every refresh/commit.
  let filterDiagnostics: FilterDiagnostic[] = [];

  const rawValues = (): Record<string, unknown> =>
    Object.fromEntries(filters.map((filter) => [filter.def.parameter, toParamValue(filter.state.value)]));
  const activeMap = (): Record<string, boolean> =>
    Object.fromEntries(filters.map((filter) => [filter.def.parameter, filter.state.active]));

  // #360: the committed values of every ROOT filter (no `sourceQueryId`) — the
  // only filters whose values a shared Filter source's own `{name:Type}`
  // declarations can depend on. An INACTIVE root's value is deliberately
  // blanked (never its retained-but-inactive raw value): `clearFilter` keeps
  // the typed value and only flips `active` to false, so without blanking
  // here the pipeline's own missing-check would see a non-empty stale value
  // and never gate the dependent source to `waiting`.
  const committedRootValues = (): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const filter of filters) {
      if (filter.sourceId) continue;
      out[filter.def.parameter] = filter.state.active ? toParamValue(filter.state.value) : '';
    }
    return out;
  };

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
      // #189: construction-time selection-resolution diagnostics are PERSISTENT
      // (never reset by a wave) — concatenated ahead of the per-wave
      // `filterDiagnostics` on every publish, rather than merged into that
      // mutable array, so nothing a wave does can ever drop them.
      filterDiagnostics: [...staticFilterDiagnostics, ...filterDiagnostics],
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
  // presentation error — `isRunnableTileRuntime`, the same predicate
  // `executableTileIds` (#189) is built from.
  const runnableTiles = (): TileRuntime[] => tiles.filter(isRunnableTileRuntime);

  // ── Filter wave ─────────────────────────────────────────────────────────

  /** Serializes an options list to a comparable signature — `null` and `[]`
   *  are DISTINCT signatures (a clear must still bump `optionsRev` when the
   *  prior state had real options), so this is not just `JSON.stringify`. */
  function optionsSignature(options: FilterHelperOption[] | null): string {
    return options === null ? 'null' : JSON.stringify(options.map((option) => [option.value, option.label]));
  }

  /** Replace one consumer's curated options, bumping `optionsRev` ONLY when
   *  the VALUE CONTENT actually changed (#359) — a same-content republish (or
   *  an already-null filter staying null) leaves `optionsRev` untouched so
   *  the UI's filter-bar rebuild signature doesn't churn on every wave. */
  function setConsumerOptions(consumer: FilterRuntime, options: FilterHelperOption[] | null): void {
    if (optionsSignature(options) !== optionsSignature(consumer.state.options)) consumer.state.optionsRev++;
    consumer.state.options = options;
  }

  /** Runs ONE shared source's query (was per-filter — #359's fix: N filter
   *  definitions sharing a `sourceQueryId` now execute it exactly once per
   *  wave). #360: the source may now declare its OWN `{name:Type}` params
   *  (fed by root Dashboard filters) — `prepareFilterSource` (over the
   *  source's construction-time `analyzed` analysis) classifies it
   *  `'runnable'` | `'waiting'` | `'error'` against the wave's committed root
   *  values BEFORE any request is sent. Sets the TRANSPORT terminal
   *  (`ready`/`waiting`/`error`) and STORES the normalized `FilterProvider` on
   *  `source.provider` — but ONLY for the current generation: every stale-gen
   *  guard bails BEFORE the status/provider write, so a superseded run leaves
   *  the last-known provider intact (returns `null`). Per-consumer curation
   *  status is derived afterward in `applyFilterProviders`, which merges the
   *  COMPLETE provider set from all source runtimes (the #360 boundary —
   *  retained providers survive a selective wave). `waveMs` is the ONE wall
   *  clock reading the whole wave shares (`runFilterWave`/
   *  `runFilterSourceWave` each capture it exactly once, before building their
   *  plan) — never read again per-source here. */
  async function runFilterSource(
    source: FilterSourceRuntime, generation: number, waveMs: number,
  ): Promise<FilterProvider | null> {
    if (!source.query) {
      // REUSE the static-validation code `filter-source-missing`
      // (workspace-semantics.ts) — this is the RUNTIME analog: the source
      // query id simply does not resolve against this session's queries.
      const provider: FilterProvider = {
        sourceId: source.id, sourceName: '', helpers: [],
        diagnostics: [coreDiagnostic('error', 'filter-source-missing',
          `Filter references unknown source query ${JSON.stringify(source.id)}`, { sourceId: source.id })],
      };
      if (source.gen !== generation) return null;
      source.status = 'error';
      source.provider = provider;
      return provider;
    }
    const query = source.query;
    const prep = prepareFilterSource(source.analyzed, {
      values: committedRootValues(),
      active: effectiveActive(committedRootValues(), activeMap()),
      wallNowMs: waveMs,
    });
    if (prep.readiness === 'error') {
      // A structural/cascading diagnostic (`analyzed.diagnostics`) always
      // wins as the reported reason when present; otherwise this is purely an
      // invalid-committed-value verdict from `prepareParameterizedBatch` with
      // no diagnostic of its own — synthesize one from `prep.error` so the
      // provider's `diagnostics` is never empty for an `'error'` readiness.
      const provider: FilterProvider = {
        sourceId: source.id, sourceName: queryName(query), helpers: [],
        diagnostics: prep.diagnostics.length
          ? prep.diagnostics
          : [coreDiagnostic('error', 'filter-source-invalid', prep.error || 'Filter source is invalid.', { sourceId: source.id })],
      };
      if (source.gen !== generation) return null;
      source.status = 'error';
      source.provider = provider;
      return provider;
    }
    if (prep.readiness === 'waiting') {
      // Blocked on a missing dependency — a normal mid-fill state, not an
      // error: no request, no error diagnostic. `applyFilterProviders` reads
      // `source.missing` to publish each consumer's `waitingFor`.
      if (source.gen !== generation) return null;
      source.status = 'waiting';
      source.missing = prep.missing.slice();
      source.provider = null;
      return null;
    }
    if (source.gen !== generation) return null;
    const result = newResult(prep.format, prep.rowLimit);
    const controller = new AbortController();
    source.abortController = controller;
    await deps.exec.executeRead(result, {
      sql: prep.execSql, format: prep.format, rowLimit: prep.rowLimit,
      params: prep.params, signal: controller.signal,
    });
    if (source.gen !== generation) return null;
    source.abortController = null;
    let provider: FilterProvider;
    if (result.error || result.cancelled) {
      provider = {
        sourceId: source.id, sourceName: queryName(query), helpers: [],
        diagnostics: [coreDiagnostic('error', 'filter-query-failed',
          `${queryName(query)}: ${result.error || 'Filter query was cancelled.'}`, { sourceId: source.id })],
      };
      source.status = 'error';
    } else {
      const normalized = readFilterOptions({
        columns: result.columns, row: result.rows[0], rowCount: result.rows.length,
      });
      provider = { sourceId: source.id, sourceName: queryName(query), ...normalized };
      source.status = normalized.helpers.length ? 'ready' : 'error';
      // #171 bound-param recording, for parity with `runTile` (~:614) — the
      // shared source may itself now bind real params (#360).
      deps.recordBoundParams?.(prep.boundParams);
    }
    source.provider = provider;
    return provider;
  }

  /** #360: the terminal result of one source-wave pass — either every source
   *  in the plan settled at ITS OWN reserved generation and the merge ran
   *  (`'applied'`, carrying `merged.changed` as `flipped`), or the plan was
   *  stale (superseded by a later wave that reserved a fresh generation on
   *  one of the SAME sources) and nothing was published (`'superseded'`) — a
   *  superseded wave must not go on to launch its own panel wave in
   *  `commitAndRerun`. `runFilterWave` ignores the return either way (a full
   *  refresh has no further phase to gate). */
  type SourceWaveResult = { status: 'applied'; flipped: string[] } | { status: 'superseded' };

  /** Terminal, SYNCHRONOUS step of the filter wave (#359): merges every
   *  collected provider exactly ONCE, then for every consumer of every
   *  source derives its `ViewerFilterStatus`, replaces its curated options
   *  (or clears them), publishes the merge's diagnostics as-is, and
   *  reconciles `merged.changed` — all before this function returns, so the
   *  affected-tile wave `refresh()` runs next sees the reconciled `active`
   *  (the PRECONDITION from plan review: this must NOT be deferred to a
   *  microtask). Returns a `SourceWaveResult`: `{status:'applied', flipped}`
   *  with the deactivated (flipped) parameter names — `merged.changed` — so a
   *  selective (#360) caller can fold them into the SAME affected-panel wave
   *  as the parameter that triggered the rerun; or `{status:'superseded'}`
   *  when this plan was stale (see the stale-wave guard immediately below). */
  function applyFilterProviders(plan: { source: FilterSourceRuntime; generation: number }[]): SourceWaveResult {
    // Stale-wave guard (#359 "a stale generation cannot publish options or
    // activation changes"): a superseded (or destroyed) wave's own source
    // results were already discarded in `runFilterSource` (returned `null`),
    // but this terminal step iterates EVERY source unconditionally — so
    // without this check a stale wave would still clobber every consumer's
    // options/status and blank `filterDiagnostics` over the fresher wave's
    // already-correct state. Source generations move all-at-once (every
    // `runFilterWave`/`destroy` bumps them together), so any mismatch means
    // this whole wave is stale and must publish nothing.
    if (plan.some(({ source, generation }) => source.gen !== generation)) return { status: 'superseded' };
    // Merge the COMPLETE set of source providers — not just the ones a wave
    // re-ran — so retained (last-known) providers survive a future selective
    // wave (#360). A source that has never produced one contributes nothing.
    const merged = mergeDashboardFilterHelpers({
      providers: [...filterSources.values()]
        .map((source) => source.provider)
        .filter((provider): provider is FilterProvider => provider !== null),
      controls, values: rawValues(), active: effectiveActive(rawValues(), activeMap()),
    });
    curated = merged.fields;
    // Published as-is (never deduped — a shared source runs once per wave), plus
    // one per-consumer `filter-helper-missing` for the otherwise-silent case
    // where a source succeeds but omits a consumer's column (finding: the UI
    // renders diagnostics, not per-filter status, so a bare `missing-helper`
    // left an unexplained empty control).
    const diagnostics: FilterDiagnostic[] = [...merged.diagnostics];
    // #360: a source NOT in THIS plan (a cross-source race) that is still
    // `loading` (a different, possibly-overlapping selective wave is
    // running it right now) or settled `waiting` on its own dependency must
    // not have its consumers re-derived here — its own wave's
    // `applyFilterProviders` call owns that. Every source that IS in this
    // plan, or a settled non-plan source (`ready`/`error`/`idle`), derives
    // normally — only the per-consumer status/options assignment is skipped
    // for a mid-flight non-plan source; the merge above still ran over the
    // complete provider set.
    const planIds = new Set(plan.map(({ source }) => source.id));
    for (const source of filterSources.values()) {
      if (!planIds.has(source.id) && (source.status === 'loading' || source.status === 'waiting')) continue;
      for (const consumer of source.consumers) {
        if (source.status === 'error') {
          setConsumerOptions(consumer, null);
          consumer.state.status = 'source-error';
          consumer.state.stale = false;
          consumer.state.waitingFor = undefined;
          continue;
        }
        if (source.status === 'waiting') {
          setConsumerOptions(consumer, null);
          consumer.state.status = 'waiting';
          consumer.state.stale = true;
          consumer.state.waitingFor = source.missing.slice();
          continue;
        }
        const field = merged.fields[consumer.def.parameter];
        if (field) {
          setConsumerOptions(consumer, field.options);
          consumer.state.status = 'ready';
          consumer.state.stale = false;
          consumer.state.waitingFor = undefined;
          continue;
        }
        // The source succeeded but this consumer's parameter never got a
        // curated field — either a merge/source diagnostic explicitly names
        // it (helper-error: duplicate provider, unused, invalid option, …)
        // or the source simply never returned that column (missing-helper).
        // Simple helperName match only — no code enumeration, no sourceId key.
        const namedByDiagnostic = merged.diagnostics.some((diag) => diag.helperName === consumer.def.parameter);
        setConsumerOptions(consumer, null);
        consumer.state.stale = false;
        consumer.state.waitingFor = undefined;
        if (namedByDiagnostic) {
          consumer.state.status = 'helper-error';
        } else {
          consumer.state.status = 'missing-helper';
          diagnostics.push(coreDiagnostic('warning', 'filter-helper-missing',
            `Filter source ${JSON.stringify(source.query ? queryName(source.query) : source.id)} returned no "${consumer.def.parameter}" option column.`,
            { sourceId: source.id, helperName: consumer.def.parameter }));
        }
      }
    }
    filterDiagnostics = diagnostics;
    // Reconcile: a value no longer among its curated options is deactivated
    // (value KEPT — matches clearFilter's reactivation semantics). `changed`
    // only ever names source-backed parameters, whose tiles are already in
    // `affectedByFilterWave` — no separate union step is needed for the FULL
    // wave; a selective (#360) caller still folds `changed` into its own
    // affected-panel wave via the returned array below.
    //
    // #189: a scalar reconciliation only EVER pushes a name onto `changed`
    // alongside deactivating it — `merged.active[parameter]` is always
    // `false` there, so reading it (rather than hardcoding `false`) is
    // behaviorally identical for scalars. An ARRAY reconciliation's PARTIAL
    // narrowing (some, not all, selected values survive) also pushes onto
    // `changed` — to join the affected-panel wave — while the filter STAYS
    // active with its narrowed value; hardcoding `false` here would
    // incorrectly deactivate it, so this reads the merge's own decided
    // `active` state instead.
    for (const parameter of merged.changed) {
      for (const filter of filters) if (filter.def.parameter === parameter) filter.state.active = merged.active[parameter];
    }
    // #189: an array-typed (multiselect) filter's reconciled value — reordered
    // to the fresh canonical option order, or narrowed to the surviving
    // subset — comes back via `merged.values` (`mergeDashboardFilterHelpers`
    // owns the reconciliation DECISION; this just applies its result). Guarded
    // on the CURRENT value already being an array before ever reading
    // `merged.values`, so a scalar filter's committed value (a string/number)
    // is never touched here — `mergeDashboardFilterHelpers`'s scalar
    // reconciliation branch never rewrites `values` at all, only `active`.
    for (const filter of filters) {
      if (!Array.isArray(filter.state.value)) continue;
      const updated = merged.values[filter.def.parameter];
      if (Array.isArray(updated)) filter.state.value = updated;
    }
    return { status: 'applied', flipped: merged.changed };
  }

  /** The executor shared by `runFilterWave` (every known source, a full
   *  refresh) and `runFilterSourceWave` (only the sources a just-committed
   *  root parameter affects, #360) — avoiding duplicating the same five
   *  steps: supersede each source into a plan, flip loading/
   *  stale on the source AND every consumer, decide whether to clear
   *  consumer options, `publish()` once, run the plan through the bounded
   *  pool, then merge terminally via `applyFilterProviders`. The two callers
   *  differ only in `opts`:
   *  - `clearOptions` — a FULL refresh deliberately KEEPS the current options
   *    through the loading window: clearing them would flip a non-empty
   *    filter bar to empty on every refresh, churn the UI's rebuild
   *    signature, and destroy in-progress typing (the #359 no-flicker
   *    invariant). A SELECTIVE rerun clears them via `setConsumerOptions`
   *    (so `optionsRev` bumps too) because a committed dependency change
   *    means the OLD options are no longer known-current for the new inputs
   *    and must not keep rendering as if they were — `applyFilterProviders`
   *    repopulates them from the fresh merge once this wave settles, so the
   *    clear is transient.
   *  - `resetDiagnostics` — a FULL refresh blanks `filterDiagnostics`
   *    immediately: every source is being re-run, so any previously-published
   *    diagnostic could be stale for the whole loading window. A SELECTIVE
   *    rerun leaves the prior wave's diagnostics in place through its own
   *    loading window (only a few sources are affected; the untouched
   *    sources' diagnostics are still valid) — either way,
   *    `applyFilterProviders` unconditionally overwrites `filterDiagnostics`
   *    from the COMPLETE merge once THIS plan settles.
   *  `waveMs` is the one wall-clock reading the whole wave shares (captured
   *  once by the caller before building this plan, mirroring the tile wave's
   *  own `deps.wallNow()` capture in `refresh()`) — every source in the plan
   *  resolves any relative `{name:DateTime}` dependency against the exact
   *  same instant, never a per-source read. */
  async function executeFilterSourcePlan(
    sources: FilterSourceRuntime[],
    opts: { clearOptions: boolean; resetDiagnostics: boolean; waveMs: number },
  ): Promise<SourceWaveResult> {
    if (opts.resetDiagnostics) filterDiagnostics = [];
    const plan = sources.map((source) => ({ source, generation: supersede(source) }));
    for (const { source } of plan) {
      // Loading is set here (and only here) — NEVER in the terminal step.
      source.status = 'loading';
      for (const consumer of source.consumers) {
        consumer.state.status = 'loading';
        consumer.state.stale = true;
        if (opts.clearOptions) setConsumerOptions(consumer, null);
      }
    }
    publish();
    // Each source stores its own provider on `source.provider`; the terminal
    // merge reads the complete set, so the pool's returns are awaited only for
    // sequencing, not collected.
    await runPool(plan, VIEWER_TILE_CONCURRENCY,
      ({ source, generation }) => runFilterSource(source, generation, opts.waveMs));
    return applyFilterProviders(plan);
  }

  async function runFilterWave(): Promise<SourceWaveResult> {
    // One wall-clock reading for the WHOLE wave (mirrors the tile wave's own
    // `deps.wallNow()` capture in `refresh()`).
    const waveMs = deps.wallNow();
    // Full refresh: every known source, keep options through loading (#359
    // no-flicker invariant), reset diagnostics immediately (see
    // `executeFilterSourcePlan`'s doc comment for the "why"). Unlike a
    // stand-alone call, THIS caller (`refresh()`) has a later phase that
    // depends on the result: its own affected-panel wave runs AFTER this
    // settles, using the merged/reconciled values. A `{status:'superseded'}`
    // here means a concurrent SELECTIVE commit reserved a fresher generation
    // on one of these sources and is now the source-of-truth for them —
    // `refresh()` must skip its own affected-panel wave in that case (see its
    // caller, just below) rather than run it against source data that
    // predates that commit's own update, and defer to that commit's own
    // `runAffectedWave` instead.
    return executeFilterSourcePlan([...filterSources.values()],
      { clearOptions: false, resetDiagnostics: true, waveMs });
  }

  /** #360: rerun only the shared Filter sources whose OWN `{name:Type}`
   *  declarations depend on one of `changedParams` (a root filter's just-
   *  committed parameter names) — a source with no such dependency is never
   *  superseded/rerun. Returns `{status:'applied', flipped:[]}` when no
   *  source is affected (nothing ran, so nothing can be stale); otherwise
   *  delegates to `executeFilterSourcePlan`, whose `SourceWaveResult` the
   *  caller (`commitAndRerun`) uses to fold the flipped parameter names into
   *  ONE combined affected-panel wave alongside `changedParams`, or to skip
   *  that wave entirely when this plan was superseded. */
  async function runFilterSourceWave(changedParams: string[]): Promise<SourceWaveResult> {
    // Entered only from `commitAndRerun`'s affected path, which preflights ONCE
    // for the whole commit (source wave + affected-panel wave) — avoiding a
    // double `ensureFreshToken()`/`onAuthFailed` on a stale token — so this wave
    // never preflights itself. (`runAffectedWave` keeps its own `preflighted`
    // flag because it is ALSO reached directly on the no-affected-source fast
    // path, where nothing has preflighted yet.)
    const waveMs = deps.wallNow();
    const affected = [...filterSources.values()].filter((source) =>
      source.analyzed.dependsOn.some((name) => changedParams.includes(name)));
    if (affected.length === 0) return { status: 'applied', flipped: [] };
    // Selective rerun: clear stale-for-new-inputs options, but keep the prior
    // wave's diagnostics until THIS wave's own merge settles.
    return executeFilterSourcePlan(affected, { clearOptions: true, resetDiagnostics: false, waveMs });
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
    const filterResult = await runFilterWave();
    if (destroyed) { await unaffectedWave; return; }
    if (filterResult.status === 'superseded') {
      // A concurrent selective commit superseded this refresh's Filter wave
      // and is now the source-of-truth; IT will run the affected panels
      // after it settles + reconciles (`commitAndRerun` -> `runAffectedWave`).
      // Running them here would execute panels before the current source
      // updates/reconciliation are applied — the exact ordering this session
      // must never allow — and would NOT be preempted by tile generations:
      // the selective commit reserves its OWN tile generations only after
      // its source wave settles (inside its own `runAffectedWave`), so during
      // this window these tiles' generations are still whatever `refresh()`
      // reserved up front and would run un-preempted. `refresh()`'s own work
      // is done either way — the unaffected tiles already ran/are running,
      // and the affected side is delegated to the superseding commit.
      await unaffectedWave;
      publish(false, destroyed ? null : deps.now());
      return;
    }
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
  async function runAffectedWave(parameters: string[], preflighted = false): Promise<void> {
    // Unconditional destroyed guard: the `preflighted: true` fast path (from
    // `commitAndRerun`'s affected branch) skips `preflight()` entirely below
    // — and `preflight()` was the ONLY place on this path that
    // checked `destroyed` — so without this a `destroy()` firing between the
    // source wave settling and this wave starting could still reserve tile
    // generations and issue requests after teardown.
    if (destroyed) return;
    if (!preflighted && !(await preflight())) return;
    // #189: consult each parameter's RESOLVED targets (explicit `def.targets`
    // else declared-in tiles, `targetsByParameter` — built once at
    // construction, over EVERY filter definition, from the same
    // `resolveFilterTargets` `affectedByFilterWave` uses) rather than blindly
    // rerunning every tile that merely declares the parameter name. Every
    // parameter this function is ever called with belongs to some existing
    // filter definition (it always originates from a committed `filter.def.
    // parameter` or a reconciliation's `merged.changed`, itself gated on
    // that same filter set being active) — so `targetsByParameter` always has
    // an entry, possibly an EMPTY one (an explicit `targets: []` affecting
    // nothing); the `?? []` is a cheap defensive guard only, never expected
    // to be exercised.
    const affectedIds = new Set<string>();
    for (const parameter of parameters) {
      for (const id of targetsByParameter.get(parameter) ?? []) affectedIds.add(id);
    }
    const targets = runnableTiles().filter((runtime) => affectedIds.has(runtime.tile.id));
    const generations = new Map<string, number>(targets.map((runtime) => [runtime.tile.id, supersede(runtime)]));
    const prepared = sourcesById(prepareBatch('execute').sources);
    publish();
    await runPool(targets, VIEWER_TILE_CONCURRENCY,
      (runtime) => runTile(runtime, prepared.get(runtime.tile.id), generations.get(runtime.tile.id)!));
  }

  // #360: after committing a value (these four are commit paths only — never
  // in-progress typing), rerun any shared Filter source that depends on the
  // just-committed root parameter(s), then run ONE combined affected-panel
  // wave over both the committed parameter(s) and any names the source wave
  // itself deactivated (`result.flipped`). A synchronous pre-check skips
  // `runFilterSourceWave` entirely when nothing depends on `changed` —
  // behaviorally identical to awaiting it, since an unaffected wave always
  // resolves to `{status:'applied', flipped:[]}` with no side effect. The
  // fast (no-affected-source) path lets `runAffectedWave` self-preflight as
  // usual; the affected path preflights ONCE here for the whole commit and
  // passes `preflighted: true` into both waves so a stale token only fails
  // `ensureFreshToken()` once.
  //
  // The affected-panel wave runs only if the source wave was neither
  // superseded nor destroyed: a superseded result changed nothing
  // (`applyFilterProviders`'s own stale-wave guard already discarded it), and
  // `destroy()` bumps every source generation too, so a source wave racing a
  // `destroy()` is caught by the same check.
  async function commitAndRerun(changed: string[]): Promise<void> {
    const hasAffectedSource = [...filterSources.values()]
      .some((source) => source.analyzed.dependsOn.some((name) => changed.includes(name)));
    if (!hasAffectedSource) { await runAffectedWave(changed); return; }
    if (!(await preflight())) return;
    const result = await runFilterSourceWave(changed);
    // A `'superseded'` result means `applyFilterProviders` returned BEFORE
    // merging anything (its own stale-wave guard, `applyFilterProviders`'s
    // doc comment) — no consumer state changed, so there is nothing new to
    // `publish()`; the wave that superseded this one owns publishing the
    // eventual settled state.
    if (destroyed || result.status === 'superseded') return;
    await runAffectedWave([...new Set([...changed, ...result.flipped])], true);
  }

  async function setFilter(filterId: string, value: unknown): Promise<void> {
    if (destroyed) return;
    const filter = filterById.get(filterId);
    if (!filter) return;
    // #189: `copyValue` defends against aliasing the caller's own array;
    // a non-empty array counts as a value (active) the same way any
    // non-empty/non-null scalar does — an EMPTY array reads like `''`.
    const stored = copyValue(value);
    filter.state.value = stored;
    filter.state.active = Array.isArray(stored) ? stored.length > 0 : stored != null && stored !== '';
    publish();
    await commitAndRerun([filter.def.parameter]);
  }

  async function applyFilter(filterId: string, value: unknown, active: boolean): Promise<void> {
    if (destroyed) return;
    const filter = filterById.get(filterId);
    if (!filter) return;
    // The filter bar owns activation for optional/curated fields, so value and
    // active are set independently (unlike setFilter's value-implies-active).
    // #189: `copyValue` defends against aliasing the caller's own array.
    filter.state.value = copyValue(value);
    filter.state.active = active;
    publish();
    await commitAndRerun([filter.def.parameter]);
  }

  async function clearFilter(filterId: string): Promise<void> {
    if (destroyed) return;
    const filter = filterById.get(filterId);
    if (!filter) return;
    // Deactivate but keep the value so reactivation restores it.
    filter.state.active = false;
    publish();
    await commitAndRerun([filter.def.parameter]);
  }

  async function clearAllFilters(): Promise<void> {
    if (destroyed) return;
    const changed: string[] = [];
    for (const filter of filters) {
      const nextActive = filter.def.defaultActive ?? false;
      // #189: `copyValue` defends the default against aliasing (a
      // `defaultValue` array literal on the document); `sameSelection`
      // (filter-selection.ts) compares STRUCTURALLY so an array value/default
      // never falls through the old `!==` reference check into a spurious
      // "changed" on every reset.
      const nextValue = copyValue(filter.def.defaultValue ?? '');
      if (filter.state.active !== nextActive || !sameSelection(filter.state.value, nextValue)) {
        changed.push(filter.def.parameter);
      }
      filter.state.active = nextActive;
      filter.state.value = nextValue;
    }
    publish();
    // Coalesce every reset into ONE affected-panel wave (#188 clear-all).
    if (changed.length) await commitAndRerun(changed);
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
    for (const source of filterSources.values()) {
      source.gen++;
      if (source.abortController) { source.abortController.abort(); source.abortController = null; }
    }
  }

  return {
    state: stateSignal as ReadonlySignal<DashboardViewState>,
    controls, getFilterField,
    start, refresh, refreshTile, setFilter, applyFilter, clearFilter, clearAllFilters, cancelTile, syncDocument,
    setGridRenderMode, destroy,
  };
}
