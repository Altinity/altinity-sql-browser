// #276 Phase 3b DashboardSession — route-scoped owner of the dashboard tile/
// filter execution runtime (wave generations, per-slot cancellation, the
// 6-way pool), extracted from `src/ui/dashboard.ts` so it is constructible
// without the `App` object (issue rule 1) and unit-testable with plain fakes,
// mirroring `src/ui/workbench/workbench-session.ts`'s own extraction
// (#276 Phase 3a). `destroy()` cancels ALL in-flight work (tile, KPI-source,
// and Filter-source requests), disposes the filter bar, and turns every
// later entry point (`runAll`/`runAffected`/`retryFilter`) into a no-op —
// so an orphaned filter-bar debounce timer firing after teardown can never
// issue a request or trigger a sign-out. Safe when idle or never run. Like
// `workbench-session.ts`'s destroy(), it has NO production caller yet (the
// dashboard is its own tab; today its lifetime is the tab's) — Phase 5's
// route shells wire real teardown; behavior is proven by the unit tests per
// the issue's acceptance criteria.
//
// Depends on `QueryExecutionService` + a narrow deps/hooks bag — never the
// `App` controller, never `src/ui/workbench/**` or `src/editor/**` (the
// route-session boundary `build/check-boundaries.mjs` enforces for
// `src/ui/dashboard/**`). Every DOM write stays in the shell
// (`src/ui/dashboard.ts`) behind the injected `DashboardSessionHooks` — this
// module only ever touches a slot's plain bookkeeping fields (`gen`,
// `abortController`, `status`, `destroy`) and pure `src/core/**` logic.
//
// Slots (`TileSlot`/`KpiSourceSlot`) carry their route's OWN DOM nodes for
// now — the session holds the array (so it can reserve generations / abort
// requests / tear down charts on `destroy()`), but building a slot's DOM and
// appending it to the grid stays a shell responsibility
// (`hooks.ensureSlotsBuilt()`). Splitting session-state from shell-DOM further
// (a slot that carries no DOM at all) is deferred to Phase 5 — deliberate,
// not an oversight.

import { formatRows, detectSqlFormat } from '../../core/format.js';
import { DASH_TILE_ROW_CAP, DASH_TILE_BYTE_CAP } from '../../core/dashboard.js';
import {
  analyzeParameterizedSources, prepareParameterizedBatch, mergedSourceArgs, mergedSourceSql, fieldControls,
} from '../../core/param-pipeline.js';
import type {
  FieldControl, PreparedFieldState, PreparedSource, ValidationMode, BoundParamSnapshot, ParameterAnalysis,
} from '../../core/param-pipeline.js';
import { hasOptionalBlocks } from '../../core/optional-blocks.js';
import { effectiveFilterActive } from '../../state.js';
import { queryName } from '../../core/saved-query.js';
import { explicitPanel, isKpiPanel, panelExecution } from '../../core/panel-execution.js';
import { filterExecution } from '../../core/filter-execution.js';
import { readFilterOptions } from '../../core/filter-options.js';
import { mergeDashboardFilterHelpers } from '../../core/dashboard-filters.js';
import type { FilterDiagnostic, FilterProvider, MergeDashboardFilterHelpersResult } from '../../core/dashboard-filters.js';
import { diagnostic } from '../../core/diagnostics.js';
import { newResult } from '../../core/stream.js';
import type { StreamResult } from '../../core/stream.js';
import type { Column } from '../../core/panel-cfg.js';
import type { KpiSourceSlot, KpiBand } from '../dashboard-kpi-band.js';
import type { Panel, SavedQueryV2 } from '../../generated/json-schema.types.js';
import type { QueryExecutionService } from '../../application/query-execution-service.js';

// ── Slot & outcome contracts (moved verbatim from dashboard.ts, #276) ───────

/** One fetched tile result's footer metadata (dashboard.ts's `tileFooter` /
 *  `applyTileResult` render it). */
export interface TileResultMeta {
  rows: number;
  ms: number;
  bytes: number;
  truncated: boolean;
}

/** A settled dashboard source outcome, as `runFavoriteSource` hands it to a
 *  hook's `applyResult`: either the error-only gate/rejection object (a
 *  per-source serialization/config error, an owned-FORMAT rejection) or the
 *  full fetched shape (`dashboardTileResult`). */
export interface FavoriteSourceResult {
  error?: string | null;
  cancelled?: boolean;
  columns?: Column[];
  rows?: unknown[][];
  meta?: TileResultMeta;
}

/** Slot-persistent table-tile state (#166): the result-schema key this slot's
 *  grid state was built for, plus whatever sort/width state the panel
 *  registry parks on it (dashboard.ts/panels.ts's `state` holder contract). */
export type TilePanelState = { key: string; [k: string]: unknown };

/** One ordinary favorite's stable tile slot (dashboard.ts's `buildTileSlot`) —
 *  the `kind:'tile'` counterpart of `KpiSourceSlot`, so `runPlan`'s dispatch
 *  is one discriminated union. `card`/`body`/`foot`/`loadLabel` are the
 *  shell's own DOM nodes (Phase 3b keeps a slot's DOM inline — see the module
 *  doc above); the session only ever reads/writes `gen`/`abortController`/
 *  `status`/`destroy`. */
export interface TileSlot {
  kind: 'tile';
  card: HTMLElement;
  body: HTMLElement;
  foot: HTMLElement;
  gen: number;
  status: 'panel' | 'unfilled' | 'error' | 'skip' | null;
  destroy: (() => void) | null;
  panelState: TilePanelState | null;
  abortController: AbortController | null;
  loadLabel: HTMLElement | null;
}

/** Any dashboard grid slot — an ordinary tile or a KPI band source (#240),
 *  discriminated on `kind`. */
export type DashSlot = TileSlot | KpiSourceSlot;

/** The stale-wave guard fields every slot kind (tile, KPI source, Filter
 *  source) shares — `supersedeSlot`'s whole contract (#193/#237). */
export interface SupersedableSlot {
  gen: number;
  abortController: AbortController | null;
}

/** One Filter-role query's in-memory slot (#237): the same generation/abort
 *  guard the tile slots use, plus the last provider it produced so a retry
 *  can re-merge every source's current contribution. */
export interface FilterSlot extends SupersedableSlot {
  status: 'idle' | 'loading' | 'error' | 'success';
  lastProvider: FilterProvider | null;
}

/** The per-consumer half of `runFavoriteSource` (#240): which explicit panel
 *  owns transport, the client row cap, whether the shared `detectSqlFormat`
 *  cross-check applies, and the state-transition hooks. Generic over the slot
 *  kind so an ordinary tile's hooks can never be paired with a KPI source
 *  slot (or vice versa). `setLoading`/`onProgress`/`setUnfilled`/`applyResult`
 *  are all DOM writes — they stay shell-owned (`hooks.tile`/`hooks.kpi` in
 *  `DashboardSessionHooks`); this generic interface is just the per-call
 *  wiring `runSlotTile`/`runKpiSourceTile` build around them. */
interface FavoriteSourceHooks<S extends DashSlot> {
  explicit: Panel | null;
  rowCap: number;
  checkFormat: boolean;
  setUnfilled: (slot: S, names: string[]) => void;
  /** Shell writes `slot.loadLabel` and shows the loading chrome; the session
   *  never reads the return value (only `dashboard.ts`'s own `setSlotLoading`/
   *  `setKpiSourceLoading` still return the label node, for their own
   *  progress-hook wiring). */
  setLoading: (slot: S) => void;
  /** Streamed row-count progress (#193 design req 4): the shell writes
   *  `slot.loadLabel.textContent = text` — the session never touches DOM. */
  onProgress: (slot: S, text: string) => void;
  applyResult: (slot: S, r: FavoriteSourceResult) => void;
}

/** One entry of a wave's execution plan (`planWave`): the favorite, its
 *  stable slot, its prepared source from the wave's batch, and the generation
 *  reserved for it at wave creation (#193 design req 3). NOTE: `runAll` first
 *  plans against an EMPTY wave (`planWave(indices, [])`) purely to reserve
 *  every slot's generation before the filter wave runs, then swaps the real
 *  `src` in once the post-filter `prepareWave()` resolves — a temporarily
 *  `undefined` `src` on a planned entry is intentional there, not a bug. */
interface PlannedSource {
  index: number;
  q: SavedQueryV2;
  slot: DashSlot;
  src: PreparedSource;
  generation: number;
}

// At most this many tile queries run at once, so a large favorites list
// doesn't fire a thundering herd of concurrent reads at ClickHouse.
export const TILE_CONCURRENCY = 6;

/** True for a text panel — the no-query partition (#166). Exported for
 *  direct unit testing (the shell's former uses were absorbed into this
 *  session with the structural-analysis and text-slot render dispatch). */
export function isTextFav(q: SavedQueryV2): boolean {
  const p = explicitPanel(q);
  // `!`: explicitPanel only ever returns a panel whose `cfg` passed its own
  // plain-object check — the schema marks `cfg` optional only for forward
  // compatibility.
  return !!p && p.cfg!.type === 'text';
}

/**
 * Adapt a streamed `result` (from `exec.executeRead`) to the tile result shape
 * `applyTileResult`/`tileFooter` expect (#193). `ms` is wall-clock (start→
 * finish, like run()'s finally), `bytes` is the streamed progress byte count,
 * and `truncated` reflects the client-side cap (`result.capped` — set once a
 * row past `DASH_TILE_ROW_CAP` arrives).
 */
function dashboardTileResult(result: StreamResult, startedAt: number, finishedAt: number): FavoriteSourceResult {
  return {
    columns: result.columns,
    rows: result.rows,
    error: result.error,
    cancelled: result.cancelled,
    meta: {
      rows: result.rows.length,
      ms: Math.round(finishedAt - startedAt),
      bytes: result.progress.bytes,
      truncated: result.capped,
    },
  };
}

/**
 * Bounded-concurrency map that preserves append order. Workers grab the next
 * index in turn; each `worker` call is awaited in order, so callers that mark
 * a slot (e.g. "loading") synchronously before this runs see slots update in
 * favorite order regardless of which query returns first. Returns the
 * per-item results in index order.
 */
export async function runPool<T, R>(items: T[], limit: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const run = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => run()));
  return results;
}

// Reserve the next generation for a slot AND abort its in-flight streamed
// request, atomically, at WAVE CREATION time (#193 design req 3). A queued
// Refresh worker only reaches its request when a pool slot frees up; reserving
// the generation up front (not when the worker starts) closes the stale-wave
// race where a slower older wave's worker finally runs a tile and supersedes a
// newer affected wave with older values. Returns the reserved generation; the
// worker re-checks `slot.gen === generation` before issuing and after streaming.
export function supersedeSlot(slot: SupersedableSlot): number {
  const generation = ++slot.gen;
  if (slot.abortController) slot.abortController.abort();
  slot.abortController = null;
  return generation;
}

// ── Construction contracts ──────────────────────────────────────────────────

/** The favorites this route's session runs — built inside `renderDashboard`
 *  from `state.savedQueries.filter(queryFavorite)` partitioned by
 *  `effectiveDashboardRole` exactly as before (#276 Phase 3b rule: the session
 *  receives this input, it never reads `state.savedQueries` itself). */
export interface DashboardRuntimeInput {
  panelFavorites: SavedQueryV2[];
  filterFavorites: SavedQueryV2[];
}

/** An ordinary tile's DOM hooks — every state transition a tile slot can
 *  reach, all shell-owned (dashboard.ts). */
export interface TileDomHooks {
  setUnfilled(slot: TileSlot, names: string[]): void;
  setLoading(slot: TileSlot): void;
  onProgress(slot: TileSlot, text: string): void;
  applyResult(q: SavedQueryV2, slot: TileSlot, r: FavoriteSourceResult): void;
  /** The #166 zero-query text partition — rendered synchronously, never
   *  through `runFavoriteSource`. */
  renderText(q: SavedQueryV2, slot: TileSlot): void;
}

/** A KPI band source's DOM hooks (#240), mirroring `TileDomHooks` — plus
 *  `refreshBandWarnings`, called once per touched band after a wave marks its
 *  members loading (never once per member — see dashboard.ts's `runPlan`). */
export interface KpiSourceDomHooks {
  setUnfilled(slot: KpiSourceSlot, names: string[]): void;
  setLoading(slot: KpiSourceSlot): void;
  onProgress(slot: KpiSourceSlot, text: string): void;
  applyResult(explicit: Panel, slot: KpiSourceSlot, r: FavoriteSourceResult): void;
  refreshBandWarnings(band: KpiBand): void;
}

/** Every DOM/render callback the session invokes — the shell owns all of it;
 *  the session owns only wave orchestration (generations, pool concurrency,
 *  abort, param prep, persistence). */
export interface DashboardSessionHooks {
  tile: TileDomHooks;
  kpi: KpiSourceDomHooks;
  /** Build (once, lazily on the first successful wave) this render's slot
   *  array in layout order, appending each slot's card/band into the grid —
   *  dashboard.ts's `buildTileSlot`/`buildKpiBand`/`buildKpiSourceSlot` stay
   *  entirely shell-side (#276 Phase 3b: lazy slot/DOM construction is a shell
   *  responsibility). Called at most once per session. */
  ensureSlotsBuilt(): DashSlot[];
  /** Rebuild the filter bar (disposing the previous one) with the current
   *  curated-field bundle. */
  renderFilterBar(curatedFields: Record<string, unknown>): void;
  renderFilterDiagnostics(diagnostics: FilterDiagnostic[]): void;
  /** The live "N not shown" header note — `skipped` is the current count. */
  updateSkipNote(skipped: number): void;
  /** Tears down the live filter bar's pending debounce timers (the filter-bar
   *  dispose seam, #276 Phase 3b) — called by `destroy()`. */
  disposeFilterBar(): void;
  /** Fired once per wave when the auth preflight fails (retryFilter/
   *  runAffected/runAll) — the shell wires this to `chCtx.onSignedOut()`. */
  onAuthFailed(): void;
  /** `runAll`'s own shell bits: disable the Refresh button up front... */
  onRunAllStart(): void;
  /** ...and, in the `finally`, re-enable it + stamp the "Updated HH:MM" text. */
  onRunAllSettled(): void;
}

export interface DashboardSessionDeps {
  exec: Pick<QueryExecutionService, 'executeRead'>;
  ensureFreshToken(): Promise<boolean>;
  /** Perf clock — matches `app.now()` (wall-clock `ms` in tile footers). */
  now(): number;
  /** Wall clock — one snapshot per prepared wave (the #173 F6 invariant). */
  wallNow(): number;
  recordBoundParams(boundParams: BoundParamSnapshot[]): void;
  /** Live accessors onto `app.state` — a plain object reference read fresh on
   *  every call (filter-bar.ts mutates it in place on every keystroke), not a
   *  snapshot. Mirrors `WorkbenchSession`'s narrow state-slice precedent. */
  varValues(): Record<string, string>;
  filterActive(): Record<string, boolean>;
  /** The persisted last-known curated-field bundle (#234) to seed from, so a
   *  curated field paints as the combobox immediately instead of flashing
   *  plain text for one frame before the first Filter wave resolves. */
  filterCuratedSeed: Record<string, unknown>;
  persistFilterCurated(fields: Record<string, unknown>): void;
  /** Called only when the merge actually changed an activation (mirrors the
   *  original `if (merged.changed.length)` guard). */
  persistFilterActive(active: Record<string, boolean>): void;
  hooks: DashboardSessionHooks;
}

export interface DashboardSession {
  /** The field controls the filter bar renders — computed once from the
   *  input's `panelFavorites` (structure only; no query has run yet). */
  readonly controls: FieldControl[];
  /** The filter bar's per-keystroke field-state read (#170): 'input' while
   *  typing, 'execute' on blur/Enter/curated pick. */
  getFilterField(name: string, mode: ValidationMode): PreparedFieldState;
  runAll(): Promise<void>;
  runAffected(name: string): Promise<void[] | undefined>;
  retryFilter(sourceId: string): Promise<void>;
  /** Bumps every slot's generation, aborts every live AbortController
   *  (tile/KPI-source/Filter-source), tears down each tile slot's live chart,
   *  and disposes the filter bar. Safe when idle or never run; no hook fires
   *  for a request already in flight at the time of the call. */
  destroy(): void;
}

export function createDashboardSession(deps: DashboardSessionDeps, input: DashboardRuntimeInput): DashboardSession {
  const { hooks } = deps;
  const { panelFavorites, filterFavorites } = input;

  // One stable slot per favorite (favorite order), built lazily on the first
  // successful run (hooks.ensureSlotsBuilt) and reused for the session's
  // lifetime — a filter edit or Refresh updates a slot's contents/visibility
  // in place rather than inserting/removing grid children.
  let slots: DashSlot[] = [];
  // Flipped once by destroy(): every later entry point becomes a no-op, so an
  // orphaned filter-bar debounce timer firing post-teardown can never issue a
  // request or trigger the auth-failed path.
  let destroyed = false;

  // Filter sources reuse the SAME generation/abort guard tile slots use
  // (supersedeSlot / `slot.gen`, #237). `gen` is reserved at wave-creation
  // time (see runFilterWave), so a queued worker from an older wave sees
  // `slot.gen !== generation` and discards itself.
  const filterSlots = new Map<string, FilterSlot>(filterFavorites.map((query): [string, FilterSlot] => [query.id, {
    gen: 0, abortController: null, status: 'idle', lastProvider: null,
  }]));

  // The favorites snapshot is fixed for this session, so the parameter
  // analysis (#173 phase 1 — structure only) runs once; each wave (runAll /
  // a filter's runAffected) prepares it against the current varValues with
  // one wall-clock read, and every tile gate + fetch of that wave reads the
  // same batch.
  const tileId = (i: number): string => 'tile:' + (panelFavorites[i].id || i);
  const analysis: ParameterAnalysis = analyzeParameterizedSources(panelFavorites.map((q, i) => ({
    id: tileId(i), label: queryName(q), kind: 'tile', sql: isTextFav(q) ? '' : q.sql, bindPolicy: 'row-returning',
  })));
  const controls = fieldControls(analysis);

  // Seed from the persisted last-known bundle (#234); the live wave replaces
  // it below (applyFilterProviders).
  let curatedFields: Record<string, unknown> = deps.filterCuratedSeed || {};

  const prepareBatch = (validationMode: ValidationMode = 'execute') => prepareParameterizedBatch(analysis, {
    values: Object.fromEntries(Object.entries(deps.varValues()).map(([name, value]): [string, string] => [
      name, curatedFields?.[name] && !deps.filterActive()[name] ? '' : value,
    ])),
    active: effectiveFilterActive(deps.varValues(), deps.filterActive()),
    wallNowMs: deps.wallNow(), validationMode,
  });
  const prepareWave = () => prepareBatch('execute').sources;
  const getFilterField = (name: string, mode: ValidationMode): PreparedFieldState => prepareBatch(mode).fields[name];

  // ── Tile / KPI-source execution (shared core, #240) ───────────────────────

  // Run (or re-run) one favorite's source into its slot, gated by its prepared
  // source from the wave's batch (#173): unfilled OR invalid (#170) values
  // show the placeholder (never issuing a request), a per-source error shows
  // an error card (blocking only this source), otherwise stream the SQL
  // read-only through `deps.exec.executeRead` and classify ONCE on completion.
  // `onSettled()` fires after every transition so the caller can recompute the
  // live "N not shown" count. `generation` was reserved (and any prior
  // in-flight request aborted) by `supersedeSlot` at WAVE CREATION (#193
  // design req 3), not here.
  async function runFavoriteSource<S extends DashSlot>(
    q: SavedQueryV2, slot: S, onSettled: () => void,
    src: PreparedSource, generation: number, favHooks: FavoriteSourceHooks<S>,
  ): Promise<void> {
    if (slot.gen !== generation) return; // a newer wave already superseded this queued source
    if (src.missing.length || src.invalid.length) {
      favHooks.setUnfilled(slot, src.missing.concat(src.invalid));
      onSettled();
      return;
    }
    if (src.errors.length) {
      favHooks.applyResult(slot, { error: src.errors[0] });
      onSettled();
      return;
    }
    // The wire text is the wave's materialized execution view (#165) — only
    // when the favorite actually is a template; block-free SQL keeps its
    // exact bytes.
    const execSql = hasOptionalBlocks(q.sql) ? mergedSourceSql(src, q.sql) : q.sql;
    const execution = panelExecution(favHooks.explicit, execSql, {
      format: 'Table', rowLimit: DASH_TILE_ROW_CAP + 1,
      params: { readonly: 2, max_result_bytes: DASH_TILE_BYTE_CAP, ...mergedSourceArgs(src) },
    });
    // #193 design req 5: the shared seam streams the structured
    // JSONStringsEachRowWithProgress format, so an explicit `FORMAT` clause
    // would silently corrupt the tile. Reject it with a clear error instead.
    if (execution.error || (favHooks.checkFormat && detectSqlFormat(execSql))) {
      favHooks.applyResult(slot, {
        error: execution.error || 'Dashboard panels require structured streaming results. Remove the explicit FORMAT clause.',
      });
      onSettled();
      return;
    }
    favHooks.setLoading(slot);
    const ac = new AbortController();
    slot.abortController = ac;
    const startedAt = deps.now();
    // Client row limit = CAP (newResult trims + flags `capped`); server cap =
    // CAP + 1 (the sentinel one past the client limit).
    // `!`: format is always concrete here — the defaults above pin 'Table' and
    // panelExecution's owned KPI arm overrides it with 'KPI'.
    const result = newResult(execution.format!, favHooks.rowCap);
    await deps.exec.executeRead(result, {
      sql: execSql,
      format: execution.format,
      rowLimit: execution.rowLimit,
      params: execution.params,
      signal: ac.signal,
      // Progress-only repaint (#193 design req 4): update the loading
      // placeholder's row count as rows stream, never classify/render
      // mid-stream. Stale-generation guard FIRST: a superseded request can
      // emit one last buffered chunk after abort() but before the reader
      // observes it — the shell's `slot.loadLabel` is live (a newer wave's
      // setLoading reassigns it), so without this guard a stale chunk would
      // corrupt the NEW generation's label. (The pre-#276 code was immune by
      // closing over the request-local label node; the guard restores that.)
      onChunk: () => {
        if (slot.gen !== generation) return;
        favHooks.onProgress(slot, 'Loading… ' + formatRows(result.progress.rows) + ' rows');
      },
    });
    // Superseded mid-stream or otherwise stale → discard silently: never
    // render a partial/aborted result, never record recents.
    if (slot.gen !== generation) return;
    slot.abortController = null;
    const r = dashboardTileResult(result, startedAt, deps.now());
    favHooks.applyResult(slot, r);
    // #171: this source completed (current generation) — record its bound
    // params on success only.
    if (r.error == null) deps.recordBoundParams(src.statements.flatMap((s) => s.boundParams));
    onSettled();
  }

  // `q` here is never an explicit KPI favorite — those run through
  // runKpiSourceTile instead (#240).
  function runSlotTile(
    q: SavedQueryV2, slot: TileSlot, onSettled: () => void, src: PreparedSource, generation: number,
  ): Promise<void> {
    return runFavoriteSource(q, slot, onSettled, src, generation, {
      explicit: explicitPanel(q), rowCap: DASH_TILE_ROW_CAP, checkFormat: true,
      setUnfilled: hooks.tile.setUnfilled,
      setLoading: hooks.tile.setLoading,
      onProgress: hooks.tile.onProgress,
      applyResult: (s, r) => hooks.tile.applyResult(q, s, r),
    });
  }

  // The KPI-source counterpart of runSlotTile (#240), sharing its gating/
  // generation/abort discipline exactly via runFavoriteSource.
  function runKpiSourceTile(
    q: SavedQueryV2, explicit: Panel, slot: KpiSourceSlot,
    onSettled: () => void, src: PreparedSource, generation: number,
  ): Promise<void> {
    return runFavoriteSource(q, slot, onSettled, src, generation, {
      explicit, rowCap: 2, checkFormat: false,
      setUnfilled: hooks.kpi.setUnfilled,
      setLoading: hooks.kpi.setLoading,
      onProgress: hooks.kpi.onProgress,
      applyResult: (s, r) => hooks.kpi.applyResult(explicit, s, r),
    });
  }

  // Build the wave's execution plan for a set of query-backed favorites: one
  // `{ q, slot, src, generation }` per tile, reserving each slot's generation
  // (and aborting any in-flight request) synchronously HERE, at wave creation
  // (#193 design req 3).
  function planWave(indices: number[], wave: PreparedSource[]): PlannedSource[] {
    return indices
      .filter((i) => !isTextFav(panelFavorites[i]))
      .map((i) => ({ index: i, q: panelFavorites[i], slot: slots[i], src: wave[i], generation: supersedeSlot(slots[i]) }));
  }

  async function runPlan(plan: PlannedSource[]): Promise<void[]> {
    // Mark every planned slot loading up front — before the 6-way pool
    // starts — so tiles beyond TILE_CONCURRENCY's window don't linger on
    // stale content while queued. setKpiSourceLoading does NOT refresh its
    // band's shared warning area itself (that would be one O(band size) DOM
    // rebuild PER member) — collect every band this plan touches and refresh
    // each exactly once after marking the whole batch.
    const touchedBands = new Set<KpiBand>();
    plan.forEach(({ slot }) => {
      if (slot.kind === 'kpi-source') { hooks.kpi.setLoading(slot); touchedBands.add(slot.band); }
      else hooks.tile.setLoading(slot);
    });
    touchedBands.forEach((band) => hooks.kpi.refreshBandWarnings(band));
    return runPool(plan, TILE_CONCURRENCY,
      ({ q, slot, src, generation }) => (slot.kind === 'kpi-source'
        ? runKpiSourceTile(q, slot.explicit, slot, updateSkipNote, src, generation)
        : runSlotTile(q, slot, updateSkipNote, src, generation)));
  }

  function updateSkipNote(): void {
    const skipped = slots.filter((s) => s.status === 'skip').length;
    hooks.updateSkipNote(skipped);
  }

  // ── Filter sources (#237) ──────────────────────────────────────────────────

  async function runFilterSource(query: SavedQueryV2, slot: FilterSlot, generation: number): Promise<FilterProvider | null> {
    const execution = filterExecution(query.sql);
    if (execution.error) {
      const provider: FilterProvider = {
        sourceId: query.id, sourceName: queryName(query), helpers: [], diagnostics: execution.diagnostics,
      };
      if (slot.gen !== generation) return null;
      slot.status = 'error';
      slot.lastProvider = provider;
      return provider;
    }
    if (slot.gen !== generation) return null;
    slot.status = 'loading';
    const result = newResult(execution.format, execution.rowLimit);
    const ac = new AbortController();
    slot.abortController = ac;
    await deps.exec.executeRead(result, {
      sql: query.sql, format: execution.format, rowLimit: execution.rowLimit,
      params: execution.params, signal: ac.signal,
    });
    if (slot.gen !== generation) return null;
    slot.abortController = null;
    let provider: FilterProvider;
    if (result.error || result.cancelled) {
      provider = {
        sourceId: query.id, sourceName: queryName(query), helpers: [], diagnostics: [diagnostic(
          'error', 'filter-query-failed',
          `${queryName(query)}: ${result.error || 'Filter query was cancelled.'}`, { sourceId: query.id },
        )],
      };
      slot.status = 'error';
    } else {
      const normalized = readFilterOptions({
        columns: result.columns, row: result.rows[0], rowCount: result.rows.length,
      });
      provider = { sourceId: query.id, sourceName: queryName(query), ...normalized };
      slot.status = normalized.helpers.length ? 'success' : 'error';
    }
    slot.lastProvider = provider;
    return provider;
  }

  function applyFilterProviders(providers: (FilterProvider | null)[]): MergeDashboardFilterHelpersResult {
    const merged = mergeDashboardFilterHelpers({
      // A provider is only ever null here (a superseded run), never any
      // other falsy value.
      providers: providers.filter((provider): provider is FilterProvider => provider !== null), controls,
      values: deps.varValues(), active: effectiveFilterActive(deps.varValues(), deps.filterActive()),
    });
    curatedFields = merged.fields;
    deps.persistFilterCurated(merged.fields);
    if (merged.changed.length) deps.persistFilterActive(merged.active);
    hooks.renderFilterBar(curatedFields);
    hooks.renderFilterDiagnostics(merged.diagnostics);
    return merged;
  }

  async function runFilterWave(): Promise<MergeDashboardFilterHelpersResult> {
    const plan = filterFavorites.map((query) => {
      // `!`: filterSlots is keyed from this exact filterFavorites list above.
      const slot = filterSlots.get(query.id)!;
      return { query, slot, generation: supersedeSlot(slot) };
    });
    const providers = await runPool(plan, TILE_CONCURRENCY,
      ({ query, slot, generation }) => runFilterSource(query, slot, generation));
    return applyFilterProviders(providers);
  }

  async function retryFilter(sourceId: string): Promise<void> {
    if (destroyed) return;
    const query = filterFavorites.find((item) => item.id === sourceId);
    const slot = filterSlots.get(sourceId);
    if (!query || !slot) return;
    // Re-check destroyed after the await (see runAll).
    if (!(await deps.ensureFreshToken())) { if (!destroyed) hooks.onAuthFailed(); return; }
    if (destroyed) return;
    await runFilterSource(query, slot, supersedeSlot(slot));
    // `!`: same filterSlots key invariant as runFilterWave above.
    const merged = applyFilterProviders(filterFavorites.map((item) => filterSlots.get(item.id)!.lastProvider));
    for (const name of merged.changed) await runAffected(name);
  }

  // ── Waves: runAffected / runAll ────────────────────────────────────────────

  // Re-run only the favorites whose SQL references `name` (a filter field's
  // debounced/committed edit) — not the whole grid. A no-op before the first
  // successful run (slots not built yet).
  async function runAffected(name: string): Promise<void[] | undefined> {
    if (destroyed || !slots.length) return undefined;
    // Match full Refresh: ONE token preflight before the wave (#193 design
    // req 2). Re-check destroyed after the await (see runAll).
    if (!(await deps.ensureFreshToken())) { if (!destroyed) hooks.onAuthFailed(); return undefined; }
    if (destroyed) return undefined;
    const f = analysis.fields[name]; // the filter bar only renders analyzed params
    const affected = new Set(f.requiredIn.concat(f.optionalIn));
    const wave = prepareWave();
    const targets = panelFavorites.map((_q, i) => i).filter((i) => affected.has(tileId(i)));
    // Same 6-way pool as full Refresh (#193 design req 7).
    return runPlan(planWave(targets, wave));
  }

  async function runAll(): Promise<void> {
    if (destroyed) return;
    // Resolve (and refresh) the auth token ONCE up front. Re-check destroyed
    // AFTER the await: destroy() during the preflight must stop the wave
    // before any generation is reserved or hook fires.
    if (!(await deps.ensureFreshToken())) { if (!destroyed) hooks.onAuthFailed(); return; }
    if (destroyed) return;
    hooks.onRunAllStart();
    if (!slots.length) slots = hooks.ensureSlotsBuilt();
    // Partition before execution (#166): text panels render right here —
    // synchronously, before any tile query is issued.
    slots.forEach((s, i) => { if (isTextFav(panelFavorites[i])) hooks.tile.renderText(panelFavorites[i], s as TileSlot); });
    // One prepared batch (and one wall-clock read) for the whole refresh wave;
    // reserve every query-backed slot's generation NOW (planWave), before the
    // pool starts.
    const reservedPlan = planWave(panelFavorites.map((_q, i) => i), []);
    try {
      await runFilterWave();
      const wave = prepareWave();
      await runPlan(reservedPlan.map((item) => ({ ...item, src: wave[item.index] })));
    } finally {
      hooks.onRunAllSettled();
    }
  }

  // ── destroy() ────────────────────────────────────────────────────────────

  function destroy(): void {
    destroyed = true;
    for (const slot of slots) {
      slot.gen++;
      if (slot.abortController) { slot.abortController.abort(); slot.abortController = null; }
      if (slot.kind === 'tile' && slot.destroy) { slot.destroy(); slot.destroy = null; }
    }
    for (const slot of filterSlots.values()) {
      slot.gen++;
      if (slot.abortController) { slot.abortController.abort(); slot.abortController = null; }
    }
    hooks.disposeFilterBar();
  }

  return { controls, getFilterField, runAll, runAffected, retryFilter, destroy };
}
