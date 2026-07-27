// DashboardViewerSession (#286 / #280 "Phase 4: viewer and flow layout"). The
// standalone, read-only Dashboard runtime: it takes an immutable
// DashboardDocumentV2 snapshot plus the workspace's saved queries and runs the
// Dashboard end-to-end — resolving each panel tile's presentation (through the
// ONE shared `presentation-resolver`), running the tile wave with bounded
// concurrency, per-tile cancellation, and stale-wave
// protection, and publishing everything through one `state` signal a renderer
// subscribes to. It owns runtime-only state (variable values/activation, tile
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
// #447: a Dashboard has no persisted filter definitions. Its VARIABLES are
// inferred from the `{name:Type}` placeholders in the queries its panel tiles
// own (`core/dashboard-variables.ts`), matched by exact case-sensitive name, so
// a variable's `id` IS its name and so is its `parameter`. There is no filter
// id, label, option-source query, or explicit target list anywhere — a
// variable's value is direct scalar input, always already known, so there is no
// filter/source wave for a panel to wait for and every runnable tile runs in
// ONE batch. #459 renamed the surviving runtime shape to match what it now
// models: `VariableRuntime`/`ViewerVariableState`/`setVariable`/`applyVariables`/…
// (the curated-filter names it kept through #447 described a model that no
// longer exists). Only the persisted `asb:dashFilters` key keeps its historical
// name — see `KEYS.dashFilters` in `state.ts`.

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
import { bindableVariables, inferDashboardVariables } from '../../core/dashboard-variables.js';
import type { DashboardVariable } from '../../core/dashboard-variables.js';
import {
  VARIABLE_OPTION_BYTE_CAP, VARIABLE_OPTION_CAP,
  compileVariableOptionBatch, optionSqlDiagnostics, readVariableOptionBatch,
} from '../../core/variable-options.js';
import type { VariableOption } from '../../core/variable-options.js';
import { reconcileSelection } from '../../core/variable-selection.js';
import { multiSelectElementType } from '../../core/param-type.js';
import { resolveAuthoredTimeRangeGroups, resolveTimeRangeGroups } from '../../core/time-range.js';
import type { DashboardTimeRangeGroup } from '../../core/time-range.js';
import type { Diagnostic } from '../../core/diagnostics.js';
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
  DashboardDocumentV2, DashboardTileV1, Panel, SavedQueryV2,
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
  /** Dashboard-local description override, then the saved-query description. */
  description: string;
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

/** A variable control's status.
 *
 *  A DIRECT-INPUT variable (no option SQL) has nothing to load and nothing to
 *  fail, so it is always `'idle'`. A CONFIGURED variable moves
 *  `'loading'` → `'ready'` as the refresh's one option batch runs, or to
 *  `'error'` when that batch fails (#447 phase 2). */
export type ViewerVariableStatus = 'idle' | 'loading' | 'ready' | 'error';

/** One option a configured variable's control offers. Structurally the shared
 *  `VariableOption` (core/variable-options.types.ts) — aliased rather than
 *  redeclared so the viewer, the pure compiler/reader and the shared variable bar
 *  all name one shape. */
export type ViewerVariableOption = VariableOption;

/** One Dashboard VARIABLE's runtime state (#447). `id`, `parameter` and `label`
 *  are all the variable's exact, case-sensitive name — it has no other
 *  identity, and there is no separate authored label. */
export interface ViewerVariableState {
  id: string;
  parameter: string;
  label: string;
  active: boolean;
  value: unknown;
  status: ViewerVariableStatus;
  /** True when this variable has Dashboard-local option SQL AT ALL — so it
   *  renders a single-select rather than a direct input. Published SEPARATELY
   *  from `options` because it is known at construction while `options` only
   *  arrives with the first batch: without it a control would have to start as a
   *  text box and change type once the query landed.
   *
   *  Deliberately NOT "…and the SQL is valid". A configured variable whose SQL is
   *  locally unacceptable stays a select and reports `optionsError`, because
   *  degrading it to a direct-input text box would be indistinguishable from a
   *  variable nobody ever configured — the user would see their option SQL
   *  silently ignored with nothing anywhere saying why. #447 phase 2. */
  configured: boolean;
  /** Why this variable's control cannot offer options: its own option SQL is
   *  locally unacceptable, or the batch it belongs to failed. `null` when it is
   *  fine (and always, for a direct-input variable). Distinct from
   *  `DashboardViewState.optionDiagnostics`, which is the BATCH-level report. */
  optionsError: string | null;
  /** The options the last successful batch returned for this variable, or `null`
   *  before one has (and always, for a direct-input variable). An EMPTY array is
   *  a real answer — the option query returned no rows. */
  options: ViewerVariableOption[] | null;
  /** Bumped only when this variable's option CONTENT actually changes, so a
   *  consumer can tell a genuine refresh from an unchanged republish. */
  optionsRev: number;
  /** The server cut this variable's option branch off at the cap, so the list is
   *  a PREFIX and a committed value may legitimately live past its end.
   *
   *  Published rather than kept private because "incomplete" has to reach the
   *  CONTROL, not just this layer: the session declining to prune an off-list
   *  value is undone if the control's own Apply then canonicalizes it away
   *  against the same partial list. Both ends need the same fact. */
  optionsTruncated: boolean;
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

/** The five presentation styles exposed by the Dashboard header. This is a
 * runtime choice: View mode can select any style without changing the shared
 * document, while Edit mode maps the same values to authoring commands. */
export type DashboardStyle = 'grafana-grid' | 'full' | 'report' | 'columns-2' | 'columns-3';

export interface DashboardViewState {
  /** Search-matched tiles only, in their unchanged saved order. */
  tiles: ViewerTileState[];
  totalTileCount: number;
  visibleTileCount: number;
  tileSearch: string;
  /** Variable names that are not in the UNSET state (`value: ''`, inactive) —
   *  #447 removed persisted defaults, so "resettable" now means "has anything
   *  to clear". */
  resettableVariableIds: string[];
  variableStates: ViewerVariableState[];
  /** #447: every INFERRED variable, in inference order — including the
   *  `conflicted` and `orphaned` ones, which render a diagnostic row in the
   *  Variables subtree but never get a runtime and never execute.
   *  `variableStates` above is exactly the `bindableVariables` subset of this
   *  list. */
  variables: DashboardVariable[];
  layout: DashboardLayoutView;
  /** The effective header style, including any session-local View-mode choice. */
  style: DashboardStyle;
  /** Count of ACTIVE variables (not non-empty stored values, #188). */
  activeVariableCount: number;
  running: boolean;
  updatedAt: number | null;
  /** #437: wall-clock ms (`deps.wallNow()`) of the last `refresh()` wave that
   *  left every tile IT ran out of `error` status — distinct from `updatedAt`
   *  (a monotonic `deps.now()` value used only to detect that SOME wave
   *  finished, never suitable to format as a real time — see the #437 review).
   *  A wave that ends with a tile in `error` status never advances this, so
   *  the UI keeps showing the last known-good time rather than silently
   *  overwriting it with "now". `null` before any wave has ever succeeded. */
  lastSuccessWallMs: number | null;
  /** Outcome of the MOST RECENTLY COMPLETED `refresh()` wave, independent of
   *  `lastSuccessWallMs` — `'failure'` when that wave left any tile it ran in
   *  `error` status. `null` before the first wave completes. */
  lastRefreshOutcome: 'success' | 'failure' | null;
  /** Presentation/structural diagnostics that make a tile invalid. */
  diagnostics: WorkspaceDiagnostic[];
  /** BATCH-level option-query diagnostics (#447 phase 2). A variable's own
   *  problems (a type conflict, an orphaned configuration) are published on
   *  `variables[].diagnostic` instead; this array carries only what went wrong
   *  with the ONE compiled option request — which, per the issue, is a
   *  batch-level failure rather than a per-variable one: a single malformed
   *  branch makes the whole `UNION ALL` unrunnable, so every option-backed
   *  control goes unavailable together and running ONE variable's SQL on its own
   *  — in its main-editor tab (#457) — is the path to finding out which branch is
   *  at fault. Empty when the batch succeeded, or when there was nothing to run. */
  optionDiagnostics: Diagnostic[];
  /** Persistent saved-query time-range resolution diagnostics. */
  timeRangeDiagnostics: WorkspaceDiagnostic[];
  /** #335: the ONE wall-clock snapshot (`deps.wallNow()`) the latest execution
   *  wave resolved its relative tokens against — `null` before the first wave.
   *  Every wave that reruns tiles (`refresh`, `refreshTile`, and
   *  `commitAndRerun` -> `runAffectedWave`) captures a single snapshot
   *  at entry and threads it through every `prepareBatch`
   *  in that wave, so a relative token (`now`, `-1d`, …) borne by
   *  two tiles run in one wave still resolves to the
   *  exact same instant. The time-range control's closed-trigger label
   *  re-resolves against this value on each change — no ticking timers. */
  waveWallNowMs: number | null;
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
  document: DashboardDocumentV2;
  /** The workspace saved queries a tile resolves against — and, since #447,
   *  the SOURCE OF TRUTH for this Dashboard's variables: their `{name:Type}`
   *  placeholders are what `inferDashboardVariables` reads. */
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
  /** #303: persisted per-variable seed, keyed by the VARIABLE NAME (#447 — it
   *  used to be keyed by the filter definition's id, which no longer exists) —
   *  the shell reads this from the isolated `asb:dashFilters` store (never this
   *  layer; this session stays storage-free) and passes it in so a variable's
   *  initial runtime value/active reflects the last COMMITTED state instead of
   *  always starting unset. A variable with no entry here (absent/empty map, or
   *  no key for its name) starts UNSET (`value: ''`, `active: false`); an entry
   *  whose `value` is nullish falls back to that same unset value. */
  initialVariables?: Record<string, { value: unknown; active: boolean }>;
}

export interface DashboardViewerSession {
  readonly state: ReadonlySignal<DashboardViewState>;
  /** The `{name:Type}` field controls the variable bar renders (structure only). */
  readonly controls: FieldControl[];
  /** #335: the resolved time-range groups (pairs of scalar date-like variables,
   *  identified by variable NAME since #447) — computed ONCE at construction and
   *  never recomputed across the session; empty when no pair resolves. */
  readonly timeRangeGroups: DashboardTimeRangeGroup[];
  /** One field's prepared #170 validation state against the variable bar's DRAFT
   *  values/active (in-progress typing) — for the shared invalid-field affordance. */
  getVariableField(
    name: string, mode: ValidationMode, values: Record<string, unknown>, active: Record<string, boolean>,
  ): PreparedFieldState;
  /** Run the whole Dashboard once (token preflight → one tile wave). */
  start(): Promise<void>;
  /** Re-run every tile. */
  refresh(): Promise<void>;
  /** Re-run one tile with the current variable values. */
  refreshTile(tileId: string): Promise<void>;
  /** Set one variable's value (activates it) and run the one affected-panel wave. */
  setVariable(variableId: string, value: unknown): Promise<void>;
  /** Set one variable's value AND activation explicitly (the variable bar's
   *  commit, which owns activation for optional fields), then run the one
   *  affected-panel wave. */
  applyVariable(variableId: string, value: unknown, active: boolean): Promise<void>;
  /** #335: commit MULTIPLE variables atomically (the time-range control's
   *  From/To pair, and #334's drag-to-select) in ONE execution wave over the
   *  union of every changed variable's resolved targets. Every `variableId`
   *  must resolve, uniquely; the complete proposed batch is
   *  validated through the shared execution pipeline before either value is
   *  mutated. Returns a diagnostic failure for an invalid batch. A call in
   *  which nothing actually changes publishes nothing and runs no wave. */
  applyVariables(entries: Array<{ variableId: string; value: string; active: boolean }>): Promise<ApplyVariablesResult>;
  /** Deactivate one variable WITHOUT discarding its value (reactivation
   *  restores it); one affected-panel wave (#188 clear-one). */
  clearVariable(variableId: string): Promise<void>;
  /** Reset every variable to UNSET, coalesced into ONE affected-panel wave
   *  (#188 clear-all). */
  clearAllVariables(): Promise<void>;
  /** Reset only the named variables to UNSET (#447 — there are no persisted
   *  defaults to restore any more). */
  resetVariables(variableIds: readonly string[]): Promise<void>;
  /** Set the transient presentation-only tile search. */
  setTileSearch(query: string): void;
  /** Abort one tile's in-flight request. */
  cancelTile(tileId: string): void;
  /** Adopt a layout/order-edited document (reorder, span/height, preset) WITHOUT
   *  re-running any tile: existing tile results are preserved by tile ID and the
   *  flow model is recomputed. The tile SET must be unchanged (a membership
   *  change rebuilds the session). */
  syncDocument(next: DashboardDocumentV2): void;
  /** #321 "Full view": set the TRANSIENT grafana-grid render-mode override
   *  ('tiles' = today's packed multi-tile-per-row grid, 'full' = every tile
   *  full-width, one per row). Runtime-only — never persisted, never a
   *  document mutation, never a commit/revision bump; it just republishes the
   *  current document through the new mode. Survives every other command
   *  (add/remove/reorder/height/syncDocument) since it lives outside
   *  `documentRef` entirely. A fresh session (reload/new viewer) always starts
   *  at 'tiles'. */
  setGridRenderMode(mode: GridRenderMode): void;
  /** Select a complete session-local Dashboard style. Unlike `syncDocument`,
   * this never changes the source document or re-runs tile queries. */
  setDashboardStyle(style: DashboardStyle): void;
  /** Cancel all work and turn every later entry point into a no-op. */
  destroy(): void;
}

export type ApplyVariablesResult =
  | { ok: true; changed: boolean }
  | { ok: false; error: string };

// ── Per-tile / per-variable runtime records (never published directly) ──────────

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

/** One per BINDABLE (inferred, type-consistent) Dashboard VARIABLE (#447). The
 *  field name `def` is deliberately unchanged so callers do not churn, but it
 *  is no longer a persisted definition — just the variable's identity, in which
 *  `id` and `parameter` are BOTH the exact variable name. */
interface VariableRuntime {
  def: { id: string; parameter: string };
  state: ViewerVariableState;
  /** Whether this variable binds a SELECTION (`Array(scalar T)` with a running
   *  option batch) rather than one scalar. Decided once, at construction, from
   *  the same pure predicate the bar renders its control on. Session-internal:
   *  the published `ViewerVariableState` carries no such flag, because a consumer
   *  can read the shape off `value` itself. */
  multiple: boolean;
}

/** The compiled option batch for this session, or `null` when no variable is
 *  configured (in which case NO options request is ever issued). Fixed for the
 *  session, exactly like `variables`: the tile set and the saved queries cannot
 *  change without rebuilding the session, and option SQL lives on the document,
 *  whose variable configs `syncDocument` never adopts. */
interface OptionBatchPlan {
  sql: string;
  names: string[];
  rowLimit: number;
}

const cfgType = (panel: unknown): string | undefined =>
  (isObject(panel) && isObject(panel.cfg) && typeof panel.cfg.type === 'string' ? panel.cfg.type : undefined);

const toValueString = (value: unknown): string =>
  (typeof value === 'string' ? value : value == null ? '' : String(value));

/** The UNSET value every variable starts at (#447): there are no persisted
 *  defaults, so "no value yet" is the empty string, exactly like a cleared
 *  control. This is the ONE unset form, for a multi-select variable too — see
 *  `commitValue`. */
const UNSET_VALUE = '';

/**
 * The committed form of a proposed value.
 *
 * A multi-select variable's value is a real `string[]` end to end — the typed
 * serializer builds the ClickHouse literal from it (`param-serialize.ts`), so
 * escaping, big integers and empty-string elements are all already handled. Two
 * rules are applied here, at the one place every write funnels through:
 *
 *   - an EMPTY selection reduces to `UNSET_VALUE`. `param-pipeline`'s
 *     `emptyValue()` treats a present `[]` as a genuine value, so binding one
 *     would make every panel run `… IN []` — returning nothing while LOOKING
 *     filtered — where a Dashboard variable's unset contract is that its panels
 *     wait. This deliberately narrows #189, which could express an "active empty
 *     array"; under the inferred-variable model there are no defaults and no
 *     dormant values, so no control can author one;
 *   - a non-empty array is COPIED, so a caller's array can never be mutated out
 *     from under committed state.
 */
const commitValue = (value: unknown): unknown =>
  (Array.isArray(value) ? (value.length ? value.slice() : UNSET_VALUE) : value);

/** Whether a proposed value counts as active: a selection by its length, a
 *  scalar by being non-empty. */
const valueImpliesActive = (value: unknown): boolean =>
  (Array.isArray(value) ? value.length > 0 : value != null && value !== '');

/** Local copy of `effectiveFilterActive` (state.ts is off-limits to this
 *  layer): a param with an explicit activation entry uses it; otherwise a
 *  non-empty value counts as active.
 *
 *  The value-derived pass is only ever a fallback for a name with NO entry in
 *  the `active` map, and `activeMap()` supplies one for every variable — so the
 *  array case cannot arise here in production and is deliberately not branched
 *  on. `commitValue` has already reduced an empty selection to `''` anyway. */
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
  let documentRef: DashboardDocumentV2 = deps.document;
  let destroyed = false;
  // #321 "Full view": a TRANSIENT runtime render-mode override, entirely
  // outside `documentRef` — never read/written by any command, never
  // persisted. A fresh session always starts at 'tiles'.
  let gridRenderMode: GridRenderMode = 'tiles';
  // View mode may preview any header style without authoring a layout. `null`
  // means render the document's authored style (plus the legacy Full override).
  let dashboardStyleOverride: DashboardStyle | null = null;
  let tileSearch = '';
  // #335: the single wall-clock snapshot the LATEST execution wave resolved its
  // relative tokens against (published as `state.waveWallNowMs`). `null` until
  // the first wave; every wave entry point (`refresh`/`runAffectedWave`/the
  // `commitAndRerun` commit chain) captures ONE `deps.wallNow()` at
  // entry, sets this, and threads that same instant into every `prepareBatch`/
  // option-batch resolution it runs.
  let waveWallNowMs: number | null = null;
  // #437: the freshness control's own state — see `DashboardViewState` above.
  // Set only by `recordRefreshOutcome`, called from `refresh()` right before
  // its completion publish.
  let lastSuccessWallMs: number | null = null;
  let lastRefreshOutcome: 'success' | 'failure' | null = null;

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
    // #476 — TRIM before the fallback, so a whitespace-only authored title
    // behaves exactly like an absent one. `dashboardTileV1.title` carries no
    // `minLength`, so `"   "` is a schema-legal document; left truthy it won the
    // chain unfiltered and composed blank accessible names ("Open, — , in
    // Workbench") and a blank `.dash-tile-name` heading. This is the ONE place
    // the viewer resolves a tile's display title, so trimming here settles it for
    // every consumer of `state.title` (`tileLabels`, the parameter-analysis
    // labels, and all of `ui/dashboard.ts`'s composed names alike).
    const authored = typeof tile.title === 'string' ? tile.title.trim() : '';
    const title = authored || (query ? queryName(query) : tile.queryId) || tile.id;
    // Same TRIM-before-fallback as the title above, for the same reason: the
    // tile description has no `minLength` either, so a whitespace-only
    // authored value is schema-legal, and left untrimmed it wins the chain
    // and masks `query.spec.description` with blank text instead of falling
    // through to it.
    const authoredDescription = typeof tile.description === 'string' ? tile.description.trim() : '';
    const description = authoredDescription
      || (typeof query?.spec?.description === 'string' ? query.spec.description : '');
    const state: ViewerTileState = {
      tileId: tile.id, queryId: tile.queryId, title, description, isKpi, panel,
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
  // `runnableTiles()` (below) and `applyVariables`'s scoped re-analysis derive it
  // from this ONE predicate and can never drift apart.
  const isRunnableTileRuntime = (runtime: TileRuntime): boolean =>
    !!runtime.query && !runtime.isText && !runtime.presentationError;

  // Parameter analysis over the tile SQL — fixed for the session (structure
  // only). Text tiles and missing-query tiles contribute empty SQL, so a name
  // only a TEXT panel declares has no execution target at all (its variable is
  // still inferred and still rendered — see `timeRangeAnalysis` below, which
  // deliberately keeps every panel family).
  const analysis: ParameterAnalysis = analyzeParameterizedSources(tiles.map((runtime) => ({
    id: runtime.tile.id, label: runtime.state.title, kind: 'tile',
    sql: runtime.query && !runtime.isText ? runtime.query.sql : '', bindPolicy: 'row-returning',
  })));
  const controls: FieldControl[] = fieldControls(analysis);

  // Every tile id the document declares — the membership universe the
  // time-range resolution treats as "executable" (range membership spans every
  // panel family, including ones this viewer never runs).
  const knownTileIds = new Set(tiles.map((runtime) => runtime.tile.id));

  // #447: this Dashboard's variables, INFERRED from the `{name:Type}`
  // placeholders in the queries its panel tiles own — never read from the
  // document, which no longer stores filter definitions at all. Session-fixed,
  // exactly like `controls` and `timeRangeGroups`: the tile SET and the saved
  // queries cannot change without rebuilding the session, and `syncDocument`
  // only ever adopts layout/order edits.
  const variables: DashboardVariable[] = inferDashboardVariables({
    tiles: tiles.map((runtime) => ({ id: runtime.tile.id, queryId: runtime.tile.queryId })),
    queries,
    variableConfigs: documentRef.variableConfigs,
    tileLabels: Object.fromEntries(tiles.map((runtime) => [runtime.tile.id, runtime.state.title])),
  });

  // One runtime record per BINDABLE variable (`status === 'active'`), in
  // inference order. A CONFLICTED or ORPHANED variable is still published on
  // `state.variables` (it renders a diagnostic row) but gets no runtime and can
  // never execute: the panels that declare a conflicted name then have no value
  // to bind and gate `unfilled`, while every panel that does not declare it
  // runs exactly as before.
  const bindable: DashboardVariable[] = bindableVariables(variables);
  // A never-persisted time-range bound seeds to a real "-1d" → "now" range
  // rather than empty: most panel queries declare `from`/`to` as REQUIRED
  // (never behind an optional `/*[ … ]*/` block), so an empty seed blocked
  // every one of that pair's panels on first load until the user set a range
  // by hand. This is the same pure name/type gate `resolveAuthoredTimeRangeGroups`
  // applies below for the authoritative, tile-scoped groups — run early and
  // without a document's authored pairing metadata, which is not needed just
  // to pick a sensible default. A variable outside every resolvable pair is
  // untouched below and still starts genuinely unset.
  const defaultTimeRangeRole = new Map<string, 'from' | 'to'>();
  for (const group of resolveTimeRangeGroups({ variables: bindable, analysis, executableTileIds: knownTileIds })) {
    defaultTimeRangeRole.set(group.fromVariableId, 'from');
    defaultTimeRangeRole.set(group.toVariableId, 'to');
  }
  // #447 phase 2: the ONE compiled option request for every CONFIGURED variable
  // (inferred, type-consistent, non-orphaned, with locally-acceptable option SQL
  // — `optionBatchVariables`' rule, applied inside the compiler). `null` when
  // nothing qualifies, which is how "execute no options request when no valid
  // configured variables exist" is enforced: there is simply no plan to run.
  const compiled = compileVariableOptionBatch(variables);
  const optionBatch: OptionBatchPlan | null = compiled === null ? null : {
    sql: compiled.sql,
    names: compiled.branches.map((branch) => branch.name),
    rowLimit: compiled.rowLimit,
  };
  // The names actually IN the batch — the ones a response can fill.
  const batchedNames = new Set(optionBatch === null ? [] : optionBatch.names);
  // Every variable that carries option SQL, whether or not that SQL can run, and
  // the reason when it cannot. A configured-but-broken variable must still render
  // as a select reporting its problem: the alternative (falling back to a plain
  // text box) is indistinguishable from never having been configured, which is
  // how stored option SQL ends up silently ignored. Local rejection is decided by
  // the SAME pure service the batch and the editor's Test use, so the three can
  // never disagree about what is acceptable.
  const localOptionErrors = new Map<string, string>();
  for (const variable of bindable) {
    if (variable.sql === null || batchedNames.has(variable.name)) continue;
    const issues = optionSqlDiagnostics(variable.sql);
    localOptionErrors.set(variable.name, issues.length
      ? issues.map((issue) => issue.message).join(' ')
      // Reached when the SQL itself is fine but the variable's TYPE cannot be
      // option-backed — a `Tuple`/`Map`/`Nested`/nested-`Array` variable someone
      // configured anyway. Its control is the plain input plus the
      // no-inferred-control marker, so this message is the record that its stored
      // SQL is deliberately not running rather than silently ignored.
      //
      // Before the `Array(scalar T)` multi-select was restored this branch also
      // caught every well-formed `Array(T)` configuration, and was commented as
      // unreachable — which was wrong, and set `status: 'error'` on a variable
      // whose select simply never rendered. Admitting those into the batch is
      // what made the comment true of the remaining containers only.
      : 'This variable’s option SQL cannot be used: its type has no option list.');
  }
  const configuredNames = new Set([...batchedNames, ...localOptionErrors.keys()]);
  const variableRuntimes: VariableRuntime[] = bindable.map((variable) => {
    const name = variable.name;
    // #303: a persisted seed for this VARIABLE NAME overrides the unset start
    // (untouched when `initialVariables` is absent/empty, or has no entry for this
    // name). A seed whose `value` is nullish falls back to the unset value.
    const seed = deps.initialVariables ? deps.initialVariables[name] : undefined;
    const configured = configuredNames.has(name);
    const localError = localOptionErrors.get(name) ?? null;
    // Whether this variable binds a SELECTION rather than one scalar — fixed
    // here, at construction, like every other control decision, and from the
    // same pure predicate `fieldControlKind` renders the multi-select on, so the
    // session and the bar can never disagree about a variable's shape.
    const multiple = batchedNames.has(name) && multiSelectElementType(variable.type ?? '') !== null;
    // A variable with NO persisted seed at all that is also a resolved
    // time-range bound gets a running "-1d"/"now" default instead of unset —
    // see `defaultTimeRangeRole` above. Any already-persisted seed (even a
    // cleared, inactive one) is the user's real committed state and is never
    // overridden.
    const freshTimeRangeValue = seed === undefined ? defaultTimeRangeRole.get(name) === 'from' ? '-1d'
      : defaultTimeRangeRole.get(name) === 'to' ? 'now' : null : null;
    // The store is untrusted, and a variable's type or its option SQL can change
    // under an already-persisted value. A seed of the WRONG SHAPE for what this
    // variable now binds would reach `serializeParamValue` as a `structural`
    // error and block every panel that declares it, so it degrades to unset
    // (or the fresh time-range default) instead of being carried forward.
    const seeded = seed !== undefined && Array.isArray(seed.value) === multiple
      ? (seed.value ?? UNSET_VALUE) : (freshTimeRangeValue ?? UNSET_VALUE);
    const state: ViewerVariableState = {
      id: name, parameter: name, label: name,
      // A selection carries its own activation: an array seed that survived the
      // shape check is active iff it has elements. `commitValue` has already
      // reduced an empty one to `''`, so this can never leave an `Array(T)`
      // parameter active with a scalar `''` bound. A fresh time-range default
      // is committed, not a draft, so it starts active too — otherwise the
      // compound control would show "Not set" while the query underneath it
      // already runs with a real range.
      active: multiple ? valueImpliesActive(seeded)
        : (seed !== undefined && !!seed.active) || freshTimeRangeValue !== null,
      value: commitValue(seeded),
      // A batched variable is 'loading' from the very first publish: its control
      // exists but cannot offer a choice until the batch returns. One whose SQL
      // was rejected locally is already in its terminal state — no request will
      // ever be made for it.
      status: localError !== null ? 'error' : configured ? 'loading' : 'idle',
      configured,
      optionsError: localError,
      options: null,
      optionsRev: 0,
      optionsTruncated: false,
    };
    return { def: { id: name, parameter: name }, state, multiple };
  });
  const variableById = new Map<string, VariableRuntime>(variableRuntimes.map((variable) => [variable.def.id, variable]));

  /** One variable's resolved target tile set: every tile whose SQL declares
   *  that exact name (`requiredIn`/`optionalIn` from a parameter analysis).
   *  #447 removed explicit target lists — this IS the binding. `sourceAnalysis`
   *  selects WHICH analysis to read: the execution `analysis` (text tiles
   *  blanked) for the affected-panel planner, or the wider `timeRangeAnalysis`
   *  (every panel family) for time-range group membership. */
  function resolveVariableTargets(
    def: { parameter: string }, sourceAnalysis: ParameterAnalysis = analysis,
  ): Set<string> {
    const field = sourceAnalysis.fields[def.parameter];
    return field ? new Set(field.requiredIn.concat(field.optionalIn)) : new Set();
  }

  // The affected-panel planner (`reserveAffected`/`runAffectedWave`) consults
  // this for every committed parameter — one entry per variable, resolved once.
  // Variable names are unique by construction, so no union step is needed.
  const targetsByParameter = new Map<string, Set<string>>(
    variableRuntimes.map((variable) => [variable.def.parameter, resolveVariableTargets(variable.def)]),
  );

  /** The union of the target tiles of every named parameter this session
   *  actually has a variable for. Iterating `targetsByParameter` (rather than
   *  looking each name up) keeps "a name with no variable contributes nothing"
   *  an exercised filter step instead of an unreachable fallback branch. */
  const affectedTileIds = (parameters: readonly string[]): Set<string> => {
    const wanted = new Set(parameters);
    const ids = new Set<string>();
    for (const [parameter, targets] of targetsByParameter) {
      if (!wanted.has(parameter)) continue;
      for (const id of targets) ids.add(id);
    }
    return ids;
  };

  // #334/#335: resolve authored saved-query time-range metadata ONCE, here. The
  // pair identities are VARIABLE NAMES since #447 (a variable's name is its only
  // identity). Only BINDABLE variables are candidates — a conflicted one has no
  // agreed type and an orphan has no declaration, so neither could join a group
  // anyway, and neither has a runtime to commit a bound into.
  //
  // Membership semantics include every panel family, even panels that do not
  // execute in the current viewer. Analyze their saved SQL for parameter
  // contracts without adding them to the execution planner.
  const timeRangeAnalysis = analyzeParameterizedSources(tiles.map((runtime) => ({
    id: runtime.tile.id, label: runtime.state.title, kind: 'time-range-tile',
    sql: runtime.query?.sql ?? '', bindPolicy: 'row-returning',
  })));
  const variableTargetTileIds = new Map<string, ReadonlySet<string>>(
    variableRuntimes.map((variable) => [variable.def.id, resolveVariableTargets(variable.def, timeRangeAnalysis)]),
  );
  const authoredTimeRanges = resolveAuthoredTimeRangeGroups({
    variables: bindable,
    analysis: timeRangeAnalysis,
    executableTileIds: knownTileIds,
    variableTargetTileIds,
    tiles: tiles.map((runtime) => ({ id: runtime.tile.id, queryId: runtime.tile.queryId })),
    queries,
  });
  const timeRangeGroups = authoredTimeRanges.groups;
  const tileIndexById = new Map(tiles.map((runtime, index) => [runtime.tile.id, index] as const));
  const timeRangeDiagnostics: WorkspaceDiagnostic[] = authoredTimeRanges.diagnostics.map((item) => ({
    // `!`: every diagnostic's `tileId` originates from the same `tiles` list.
    path: ['dashboard', 'tiles', tileIndexById.get(item.tileId)!, 'queryId'],
    severity: 'error', code: item.code, message: item.message, resource: item.tileId,
  }));

  // #447 phase 2: the BATCH-level option diagnostics — see
  // `DashboardViewState.optionDiagnostics`. Replaced wholesale by each options
  // wave (never appended to), so a failure never outlives the wave that hit it.
  // Starts as one shared empty array so a Dashboard with no configured variable
  // never allocates.
  const NO_OPTION_DIAGNOSTICS: Diagnostic[] = [];
  /** Shared empty return for every `runOptionBatch` path that reconciles
   *  nothing — the common case, so it never allocates. */
  const NO_RECONCILED: string[] = [];
  let optionDiagnostics: Diagnostic[] = NO_OPTION_DIAGNOSTICS;
  // Stale-wave guard for the options request, reserved BEFORE the token preflight
  // can yield — exactly like a tile's generation. Without that ordering a
  // superseded wave could still be the last one to publish its rows.
  let optionsGen = 0;

  // `unknown`, not `string`: a multi-select variable's committed value is a real
  // `string[]` and must reach `serializeParamValue` as one — stringifying it here
  // would hand the pipeline `"a,b"`, which binds as a single scalar. Everything
  // downstream (`prepareBatch`, `prepareParameterizedBatch`) is already
  // `unknown`-typed, so only this coercion had to go.
  const rawValues = (): Record<string, unknown> =>
    Object.fromEntries(variableRuntimes.map((variable) => [
      variable.def.parameter,
      Array.isArray(variable.state.value) ? variable.state.value.slice() : toValueString(variable.state.value),
    ]));
  const activeMap = (): Record<string, boolean> =>
    Object.fromEntries(variableRuntimes.map((variable) => [variable.def.parameter, variable.state.active]));

  // Prepare a batch, optionally against a caller's DRAFT values/active (the
  // variable bar's in-progress typing) rather than the committed variable state —
  // so live #170 validation can run without mutating committed state.
  const prepareBatch = (
    mode: ValidationMode = 'execute',
    values: Record<string, unknown> = rawValues(),
    active: Record<string, boolean> = activeMap(),
    // #335: the wave's shared wall-clock snapshot — every relative token in this
    // batch resolves against it. Defaults to a FRESH `deps.wallNow()` so the
    // keystroke-time `getVariableField` path (which passes no snapshot) keeps
    // resolving previews against live wall-now; each execution-wave caller
    // passes its own single snapshot instead.
    wallNowMs: number = deps.wallNow(),
  ) => prepareParameterizedBatch(analysis, {
    values, active: effectiveActive(values, active), wallNowMs, validationMode: mode,
  });

  /** One field's prepared #170 state against the caller's draft values/active
   *  (the variable bar reads this on every keystroke for the invalid affordance). */
  const getVariableField = (
    name: string, mode: ValidationMode, values: Record<string, unknown>, active: Record<string, boolean>,
  ) => prepareBatch(mode, values, active).fields[name];

  // ── State signal ────────────────────────────────────────────────────────
  const stateSignal: Signal<DashboardViewState> = signal(buildState(false, null));

  function buildState(running: boolean, updatedAt: number | null): DashboardViewState {
    const mobile = !!deps.isMobile?.();
    const normalizeSearch = (value: string): string =>
      value.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
    const normalizedSearch = normalizeSearch(tileSearch);
    const visibleRuntimes = normalizedSearch
      ? tiles.filter((runtime) =>
        normalizeSearch(runtime.state.title).includes(normalizedSearch)
        || normalizeSearch(runtime.state.description).includes(normalizedSearch))
      : tiles;
    const visible = visibleRuntimes.map((runtime) => ({ id: runtime.tile.id, isKpi: runtime.isKpi }));
    // #291: route to whichever engine the CURRENT document's layout resolves
    // to (`resolveLayoutPluginSync` — the same sync helper the application
    // layer's other non-awaitable call sites use, since this runs on every
    // publish and cannot await the async registry). An unsupported/foreign
    // primary with a valid flow@1 fallback still resolves to the flow plugin
    // here, exactly as before #291 (`computeFlowLayout`'s own fallback
    // handling, untouched) — flow behavior stays bit-identical.
    const selectedStyle: DashboardStyle = dashboardStyleOverride
      ?? (documentRef.layout.type === 'grafana-grid'
        ? (gridRenderMode === 'full' ? 'full' : 'grafana-grid')
        : (documentRef.layout.preset as DashboardStyle));
    const layoutDocument = dashboardStyleOverride === null
      ? documentRef.layout
      : selectedStyle === 'grafana-grid' || selectedStyle === 'full'
        ? (documentRef.layout.type === 'grafana-grid'
          ? documentRef.layout
          : { type: 'grafana-grid', version: 1, items: {} })
        : {
          type: 'flow', version: 1, preset: selectedStyle,
          items: documentRef.layout.type === 'flow' ? documentRef.layout.items : {},
        };
    const renderMode: GridRenderMode = selectedStyle === 'full' ? 'full' : 'tiles';
    const plugin = resolveLayoutPluginSync(layoutDocument);
    const layout: DashboardLayoutView = plugin.type === 'grafana-grid'
      ? {
        engine: 'grafana-grid',
        grid: computeGrafanaGridLayout({
          tiles: visible, layout: layoutDocument, containerWidth: deps.containerWidth?.(), renderMode,
        }),
        renderMode,
      }
      : { engine: 'flow', ...computeFlowLayout({ tiles: visible, layout: layoutDocument, mobile }) };
    return {
      tiles: visibleRuntimes.map((runtime) => ({ ...runtime.state })),
      totalTileCount: tiles.length,
      visibleTileCount: visibleRuntimes.length,
      tileSearch,
      // #447: "resettable" is simply "not unset" — there are no persisted
      // defaults to compare against any more.
      resettableVariableIds: variableRuntimes
        .filter((variable) => variable.state.active || variable.state.value !== UNSET_VALUE)
        .map((variable) => variable.def.id),
      variableStates: variableRuntimes.map((variable) => ({ ...variable.state })),
      variables,
      layout,
      style: selectedStyle,
      activeVariableCount: variableRuntimes.filter((variable) => variable.state.active).length,
      running, updatedAt, lastSuccessWallMs, lastRefreshOutcome, diagnostics: presentationDiagnostics,
      optionDiagnostics,
      timeRangeDiagnostics,
      waveWallNowMs,
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

  async function runTile(runtime: TileRuntime, source: PreparedSource, generation: number): Promise<void> {
    if (runtime.gen !== generation) return;
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

  // ── The option batch ──────────────────────────────────────────────────────

  /** Apply one variable's fresh option list, bumping `optionsRev` only when the
   *  CONTENT actually changed — so a consumer can distinguish a real refresh from
   *  an unchanged republish (a same-length list with different members included,
   *  which a bare length or emptiness check would miss).
   *
   *  Returns this variable's parameter name when reconciling its committed
   *  SELECTION against the fresh list actually changed the bound SET; the caller
   *  collects those names and runs ONE wave over their union. `null` otherwise —
   *  including for every scalar variable, whose off-list committed value is
   *  deliberately kept and shown verbatim (`variable-option-field.ts`'s documented
   *  leniency): a value that is still bound into panels is not something an
   *  option refresh gets to silently drop. */
  function applyOptions(variable: VariableRuntime, options: VariableOption[], incomplete: boolean): string | null {
    const previous = variable.state.options;
    const changed = previous === null
      || previous.length !== options.length
      || options.some((option, i) => previous[i].value !== option.value || previous[i].label !== option.label);
    variable.state.options = options;
    variable.state.status = 'ready';
    variable.state.optionsError = null;
    variable.state.optionsTruncated = incomplete;
    if (changed) variable.state.optionsRev += 1;
    if (!Array.isArray(variable.state.value)) return null;
    // A list the server cut off at the cap is not evidence that anything was
    // removed: a selected value could simply live past row 1,000. Pruning against
    // it would silently delete a valid selection, re-run the panels, and persist
    // the shortened array. The single-select already keeps an off-list committed
    // value and shows it verbatim; a selection gets the same benefit of the doubt.
    // The truncation WARNING still publishes, so the incompleteness is not hidden.
    if (incomplete) return null;
    const reconciled = reconcileSelection(variable.state.value, options);
    // `reconcileSelection` never reorders, so a no-wave outcome means there is
    // nothing to adopt: the committed value already IS the reconciled one.
    if (!reconciled.waveNeeded) return null;
    // A selected value is gone from the list. Never auto-select a replacement:
    // `reconcileSelection` only ever filters what was already committed.
    variable.state.value = commitValue(reconciled.value);
    if (reconciled.deactivate) variable.state.active = false;
    return variable.def.parameter;
  }

  /**
   * Run the ONE compiled option request for this refresh and partition its rows
   * back onto the configured variables.
   *
   * A no-op when nothing is configured — there is no plan, so no request is
   * issued at all. Never re-run by a value commit: option SQL may not reference
   * `{name:Type}` parameters in this issue, so no selection can change what any
   * option query returns (which is precisely what keeps this a single request
   * instead of a dependency graph).
   *
   * A failure is BATCH-level by design: every option-backed control goes
   * unavailable together and one diagnostic is published for the Dashboard. There
   * is deliberately no automatic fall-back to N separate per-variable queries —
   * opening ONE variable in its own main-editor tab and running it there (#457)
   * is the diagnostic path.
   */
  async function runOptionBatch(generation: number): Promise<string[]> {
    if (optionBatch === null) return NO_RECONCILED;
    const result = newResult('Table', optionBatch.rowLimit);
    await deps.exec.executeRead(result, {
      sql: optionBatch.sql,
      format: 'Table',
      rowLimit: optionBatch.rowLimit,
      params: { readonly: 2, max_result_bytes: VARIABLE_OPTION_BYTE_CAP },
    });
    if (optionsGen !== generation || destroyed) return NO_RECONCILED; // superseded
    const failure = result.error != null || result.cancelled
      ? (result.error || 'Cancelled')
      : null;
    if (failure !== null) {
      // Names the diagnostic path, exactly as the shape failure does: the combined
      // query cannot say WHICH branch broke it, so the user has to be told where
      // to look rather than left with a raw server error.
      markOptionsFailed(`Variable options could not be loaded: ${failure} `
        + '— use Test in a variable’s editor to find the option SQL at fault.');
      return NO_RECONCILED;
    }
    const read = readVariableOptionBatch(
      { columns: result.columns, rows: result.rows }, optionBatch.names,
    );
    if (read.error !== null) {
      markOptionsFailed(read.error.message, read.error.code);
      return NO_RECONCILED;
    }
    // A variable whose list was cut off at the cap is reported once, as a warning
    // rather than an error: the options it DID return are usable, and the only
    // honest alternative to saying so is letting a truncated list look complete.
    optionDiagnostics = read.truncated.size === 0 ? NO_OPTION_DIAGNOSTICS : [{
      severity: 'warning',
      code: 'variable-options-truncated',
      message: `Only the first ${VARIABLE_OPTION_CAP.toLocaleString()} options are shown for `
        + `${[...read.truncated].join(', ')}. Narrow the option SQL to see the rest.`,
    }];
    const reconciled: string[] = [];
    for (const variable of variableRuntimes) {
      const options = read.byName.get(variable.def.id);
      if (options === undefined) continue; // not in this batch
      const name = applyOptions(variable, options, read.truncated.has(variable.def.id));
      if (name !== null) reconciled.push(name);
    }
    // Publish as soon as the options land. Without this they would be invisible
    // until the caller's own post-wave publish — i.e. until the SLOWEST tile
    // finished, which inverts the whole point of running the two concurrently.
    publish();
    // The names are RETURNED, never re-run here: launching a wave while the tile
    // pool is still in flight would supersede tiles mid-refresh and make the
    // outcome classifier judge tiles that are already re-running. The single
    // caller (`refresh`) runs ONE coalesced wave over the union once both halves
    // have settled — which is what makes "at most one reconciled wave" structural
    // rather than a flag someone has to remember to check.
    return reconciled;
  }

  /** Publish a batch-level options failure: one Dashboard diagnostic, and every
   *  configured variable's control marked unavailable. Their committed VALUES are
   *  deliberately untouched — a restored selection (#303) is still bound into
   *  every panel that declares the name, and discarding it because a list failed
   *  to load would silently change what the panels show. */
  function markOptionsFailed(message: string, code = 'variable-options-batch-failed'): void {
    optionDiagnostics = [{ severity: 'error', code, message }];
    // Only the variables this batch was actually running for. One whose SQL was
    // rejected locally keeps its OWN, more specific reason — overwriting it with
    // the batch's message would replace "your SQL declares a parameter" with
    // "the combined query failed", which is both vaguer and untrue for it.
    for (const variable of variableRuntimes) {
      if (batchedNames.has(variable.def.id)) {
        variable.state.status = 'error';
        variable.state.optionsError = message;
      }
    }
    // Same reason as the success path: a failure the user cannot see until every
    // tile finishes is a failure they will read as a hang.
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
  // presentation error — the ONE `isRunnableTileRuntime` predicate, shared with
  // `applyVariables`'s scoped re-analysis.
  const runnableTiles = (): TileRuntime[] => tiles.filter(isRunnableTileRuntime);

  /** #437: classify a just-finished `refresh()` wave from the tiles it
   *  actually ran to completion, and — only on success — advance the
   *  wall-clock time the freshness control shows. A wave that leaves any of
   *  those tiles in `error` status is a `'failure'`: it still completes
   *  (`updatedAt` advances via the caller's own `publish`, unblocking the next
   *  refresh) but must never overwrite the last known-good time. Skipped
   *  entirely once destroyed — there is no UI left to reflect it. */
  function recordRefreshOutcome(ranTiles: TileRuntime[], waveMs: number): void {
    if (destroyed) return;
    const failed = ranTiles.some((runtime) => runtime.state.status === 'error');
    lastRefreshOutcome = failed ? 'failure' : 'success';
    if (!failed) lastSuccessWallMs = waveMs;
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
    // #335: ONE wall-clock snapshot for the WHOLE refresh — every tile in it
    // resolves its relative tokens against this single instant.
    const waveMs = deps.wallNow();
    waveWallNowMs = waveMs;
    markTextAndErrorTiles();
    const runnable = runnableTiles();
    // Reserve every runnable tile's generation up front (stale-wave guard).
    const generations = new Map<string, number>(runnable.map((runtime) => [runtime.tile.id, supersede(runtime)]));
    // #447 phase 2: reserve the options generation HERE, synchronously with the
    // tile reservations and before any await can yield, so a superseded wave can
    // never be the last one to publish its option rows.
    const optionsGeneration = ++optionsGen;
    publish(true);
    // #447: there is no filter/source wave for a panel to wait for any more (a
    // variable's value is direct input, or a selection the user has already made
    // from a list that cannot depend on any other variable) — the pre-wave
    // "affected vs unaffected" split #235 needed is gone with it and every
    // runnable tile runs in ONE batch against the committed values.
    const batch = sourcesById(prepareBatch('execute', undefined, undefined, waveMs).sources);
    // The option batch runs CONCURRENTLY with the tiles, not before them: option
    // SQL cannot reference a variable, so no tile's parameters depend on what it
    // returns, and gating the whole grid behind one extra round trip would delay
    // every panel for a list nothing is waiting on. Both are inside the `running`
    // window, so the refresh control stays busy until the options have landed too.
    const [reconciled] = await Promise.all([
      runOptionBatch(optionsGeneration),
      runPool(runnable, VIEWER_TILE_CONCURRENCY,
        (runtime) => runTile(runtime, batch.get(runtime.tile.id)!, generations.get(runtime.tile.id)!)),
    ]);
    // #437: classified from the TILES only. An options failure has its own
    // published diagnostic and must not overwrite the last known-good tile
    // timestamp — the panels did refresh successfully.
    recordRefreshOutcome(runnable, waveMs);
    // A refresh that dropped a selected value from some multi-select variable
    // re-runs the panels that declare it — ONE coalesced wave over the union of
    // every reconciled name, because `commitAndRerun` reserves generations across
    // all of their targets before issuing a single `runAffectedWave` (the same
    // coalescing clear-all uses). Runs only after both halves above have settled.
    if (reconciled.length && !destroyed) await commitAndRerun(reconciled);
    publish(false, destroyed ? null : deps.now());
  }

  const start = refresh;

  async function refreshTile(tileId: string): Promise<void> {
    const runtime = tiles.find((entry) => entry.tile.id === tileId);
    if (!runtime || !runtime.query || runtime.isText || runtime.presentationError) return;
    if (!(await preflight())) return;
    // A single-tile refresh is a wave of one: it must publish its snapshot
    // like every other wave, or the tile's re-resolved relative bounds drift
    // from the closed time-range trigger label until the next full wave.
    const waveMs = deps.wallNow();
    waveWallNowMs = waveMs;
    const generation = supersede(runtime);
    const prepared = sourcesById(prepareBatch('execute', undefined, undefined, waveMs).sources);
    await runTile(runtime, prepared.get(tileId)!, generation);
  }

  // Re-run only the tiles some committed variable feeds into.
  function reserveAffected(
    parameters: string[], reservations: Map<string, number> = new Map(),
  ): Map<string, number> {
    const affectedIds = affectedTileIds(parameters);
    for (const runtime of runnableTiles()) {
      if (affectedIds.has(runtime.tile.id) && !reservations.has(runtime.tile.id)) {
        reservations.set(runtime.tile.id, supersede(runtime));
        if (runtime.state.status === 'loading') runtime.state.status = 'idle';
      }
    }
    return reservations;
  }

  async function runAffectedWave(
    parameters: string[], waveMs: number,
    reservations: Map<string, number> = new Map(),
  ): Promise<void> {
    // `preflight()` is the destroyed guard on this path too — it returns false
    // once the session is torn down, so no generation is reserved and no
    // request is issued after `destroy()`.
    if (!(await preflight())) { publish(); return; }
    // Consult each committed variable's RESOLVED targets (`targetsByParameter`,
    // built once at construction from `resolveVariableTargets`) rather than
    // blindly rerunning every tile that merely declares the name — the two must
    // agree, so both derive from the ONE `affectedTileIds` fold.
    reserveAffected(parameters, reservations);
    const actualIds = affectedTileIds(parameters);
    const targets = runnableTiles().filter((runtime) => actualIds.has(runtime.tile.id));
    // #335: publish this wave's shared snapshot and resolve the batch's
    // relative tokens against it.
    waveWallNowMs = waveMs;
    const prepared = sourcesById(prepareBatch('execute', undefined, undefined, waveMs).sources);
    publish();
    await runPool(targets, VIEWER_TILE_CONCURRENCY,
      (runtime) => runTile(runtime, prepared.get(runtime.tile.id)!, reservations.get(runtime.tile.id)!));
  }

  // After committing a value (these four are commit paths only — never
  // in-progress typing), run ONE affected-panel wave over the committed
  // variable(s). #447 removed the shared Filter sources this used to have to
  // rerun and await first, so a commit is now exactly one wave.
  async function commitAndRerun(
    changed: string[], reservations: Map<string, number> = reserveAffected(changed),
  ): Promise<void> {
    // #335: ONE wall-clock snapshot for the whole commit — published as
    // `waveWallNowMs` and threaded into the wave's prepared batch.
    const waveMs = deps.wallNow();
    waveWallNowMs = waveMs;
    await runAffectedWave(changed, waveMs, reservations);
  }

  async function setVariable(variableId: string, value: unknown): Promise<void> {
    if (destroyed) return;
    const variable = variableById.get(variableId);
    if (!variable) return;
    // A non-empty value counts as a value, so it activates — by length for a
    // selection, by emptiness for a scalar.
    variable.state.value = commitValue(value);
    variable.state.active = valueImpliesActive(value);
    publish();
    await commitAndRerun([variable.def.parameter]);
  }

  async function applyVariable(variableId: string, value: unknown, active: boolean): Promise<void> {
    if (destroyed) return;
    const variable = variableById.get(variableId);
    if (!variable) return;
    // The variable bar owns activation for optional fields, so value and active
    // are set independently (unlike setVariable's value-implies-active).
    variable.state.value = commitValue(value);
    variable.state.active = active;
    publish();
    await commitAndRerun([variable.def.parameter]);
  }

  async function applyVariables(
    entries: Array<{ variableId: string; value: string; active: boolean }>,
  ): Promise<ApplyVariablesResult> {
    if (destroyed) return { ok: false, error: 'Dashboard is no longer active.' };
    // Resolve EVERY id up front, all-or-nothing: an unknown OR duplicate id
    // aborts the whole call before any mutation (atomicity — matches
    // `applyVariable`'s unknown-id no-op, extended across the batch so a partial
    // time-range commit can never leave one bound applied and the other not).
    // #447: a variable's id IS its parameter name, so ONE `seen` set is both the
    // duplicate-id and the duplicate-parameter guard.
    const resolved: { variable: VariableRuntime; value: string; active: boolean }[] = [];
    const seen = new Set<string>();
    for (const entry of entries) {
      const variable = variableById.get(entry.variableId);
      if (!variable || seen.has(entry.variableId)) {
        return { ok: false, error: 'The variable batch contains an unknown or duplicate variable.' };
      }
      seen.add(entry.variableId);
      resolved.push({ variable, value: entry.value, active: entry.active });
    }
    // Validate the complete proposed state before mutating either variable. We
    // intentionally inspect only fields in this batch: an unrelated optional
    // variable may still be empty and must not veto an otherwise valid range.
    const proposedValues: Record<string, unknown> = rawValues();
    const proposedActive = activeMap();
    for (const { variable, value, active } of resolved) {
      proposedValues[variable.def.parameter] = value;
      proposedActive[variable.def.parameter] = active;
    }
    const validationWallMs = deps.wallNow();
    for (const { variable, active } of resolved) {
      if (!active) continue;
      const targetIds = resolveVariableTargets(variable.def);
      const scopedAnalysis = analyzeParameterizedSources(tiles
        .filter((runtime) => targetIds.has(runtime.tile.id) && isRunnableTileRuntime(runtime))
        .map((runtime) => ({
          id: runtime.tile.id, label: runtime.state.title, kind: 'tile',
          sql: runtime.query!.sql, bindPolicy: 'row-returning' as const,
        })));
      const proposal = prepareParameterizedBatch(scopedAnalysis, {
        values: proposedValues, active: proposedActive, wallNowMs: validationWallMs, validationMode: 'execute',
      });
      const field = proposal.fields[variable.def.parameter];
      if (!field || field.state !== 'ok') {
        return { ok: false, error: field?.reason || `${variable.def.parameter} is not a valid variable value.` };
      }
    }

    // Mutate every resolved entry (the variable bar owns activation, like
    // `applyVariable`), collecting the changed variable names via the same
    // scalar value + active comparison `resetVariables` uses.
    const changed: string[] = [];
    for (const { variable, value, active } of resolved) {
      if (variable.state.active !== active || variable.state.value !== value) changed.push(variable.def.parameter);
      variable.state.value = value;
      variable.state.active = active;
    }
    // Nothing actually differs from the committed state → no publish, no wave
    // (an identical-pair Apply is a true no-op, never a spurious rerun).
    if (!changed.length) return { ok: true, changed: false };
    // Reserve generations synchronously with the atomic state commit, before
    // token preflight or a dependent option query can yield. This is
    // the stale-result boundary for the whole batch.
    const reservations = reserveAffected(changed);
    publish();
    await commitAndRerun(changed, reservations);
    return { ok: true, changed: true };
  }

  async function clearVariable(variableId: string): Promise<void> {
    if (destroyed) return;
    const variable = variableById.get(variableId);
    if (!variable) return;
    // Deactivate but keep the value so reactivation restores it.
    variable.state.active = false;
    publish();
    await commitAndRerun([variable.def.parameter]);
  }

  async function clearAllVariables(): Promise<void> {
    await resetVariables(variableRuntimes.map((variable) => variable.def.id));
  }

  /** #447: reset the named variables to UNSET — `value: ''`, `active: false`.
   *  There are no persisted `defaultValue`/`defaultActive` to restore any more,
   *  so this is the same terminal state a fresh, unseeded session starts in. */
  async function resetVariables(variableIds: readonly string[]): Promise<void> {
    if (destroyed) return;
    const ids = new Set(variableIds);
    const changed: string[] = [];
    for (const variable of variableRuntimes) {
      if (!ids.has(variable.def.id)) continue;
      if (variable.state.active || variable.state.value !== UNSET_VALUE) changed.push(variable.def.parameter);
      variable.state.active = false;
      variable.state.value = UNSET_VALUE;
    }
    if (!changed.length) return;
    publish();
    // Coalesce every reset into ONE affected-panel wave (#188 clear-all).
    await commitAndRerun(changed);
  }

  function setTileSearch(query: string): void {
    if (destroyed || tileSearch === query) return;
    tileSearch = query;
    publish();
  }

  function cancelTile(tileId: string): void {
    const runtime = tiles.find((entry) => entry.tile.id === tileId);
    if (!runtime) return;
    runtime.gen++;
    if (runtime.abortController) { runtime.abortController.abort(); runtime.abortController = null; }
    if (runtime.state.status === 'loading') { runtime.state.status = 'idle'; publish(); }
  }

  function syncDocument(next: DashboardDocumentV2): void {
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

  function setDashboardStyle(style: DashboardStyle): void {
    if (destroyed || dashboardStyleOverride === style) return;
    dashboardStyleOverride = style;
    publish();
  }

  function destroy(): void {
    destroyed = true;
    // Supersede any in-flight options request too, so its response can never
    // publish onto a torn-down session.
    optionsGen++;
    for (const runtime of tiles) {
      runtime.gen++;
      if (runtime.abortController) {
        runtime.abortController.abort();
        runtime.abortController = null;
      }
    }
  }

  return {
    state: stateSignal as ReadonlySignal<DashboardViewState>,
    controls, timeRangeGroups, getVariableField,
    start, refresh, refreshTile, setVariable, applyVariable, applyVariables, clearVariable, clearAllVariables, resetVariables,
    setTileSearch, cancelTile, syncDocument, setGridRenderMode, setDashboardStyle, destroy,
  };
}
