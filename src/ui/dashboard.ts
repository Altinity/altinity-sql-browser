// The standalone read-only Dashboard page (#149 D1–D3, #166). Render module
// over the `app` controller: it builds a header + a grid of tiles, one per
// favorited Library query (a snapshot taken when the tab opens — Refresh
// re-runs the data, it does not re-scan the Library). Favorites are
// PARTITIONED BEFORE EXECUTION (#166): a text panel renders immediately with
// zero queries; everything else streams its SQL read-only through the shared
// `app.runReadInto` seam (#193 — full streaming transport, server-side row cap,
// bounded client memory, and real per-tile AbortController cancellation, the
// same path the workbench run() and the detached Data view use) and renders
// through the shared panel registry (panels.js) — an explicit saved
// `panel` wins (and never vanishes: zero-row explicit panels show an honest
// "0 rows" state), an unconfigured result goes through the autoPanel
// heuristic; eligible one-row results become KPI tiles and only unconfigured
// empty results are skipped and counted in a header note. A global filter bar drives
// the same `{name:Type}` mechanism the SQL Browser workbench uses, fanning it
// out across every favorite instead of one query at a time. Per-tile overrides
// and export arrive in later phases (D7–D8).

import { h as hUntyped } from './dom.js';
import { Icon as IconUntyped } from './icons.js';
import { renderResolvedPanel } from './panels.js';
import { schemaKey as schemaKeyUntyped } from '../core/chart-data.js';
import { resolvePanel } from '../core/panel-cfg.js';
import type { Column } from '../core/panel-cfg.js';
import {
  DASH_TILE_ROW_CAP, DASH_TILE_BYTE_CAP, DASH_TABLE_DISPLAY_CAP,
  activeDashboardView, dashboardViewSelection, partitionKpiBands,
} from '../core/dashboard.js';
import {
  formatBytes as formatBytesUntyped, formatRows as formatRowsUntyped,
  detectSqlFormat as detectSqlFormatUntyped,
} from '../core/format.js';
import { newResult as newResultUntyped } from '../core/stream.js';
import {
  analyzeParameterizedSources, prepareParameterizedBatch, mergedSourceArgs, mergedSourceSql, fieldControls,
} from '../core/param-pipeline.js';
import type { FieldControl, PreparedFieldState, PreparedSource, ValidationMode } from '../core/param-pipeline.js';
import { hasOptionalBlocks } from '../core/optional-blocks.js';
import { effectiveFilterActive, KEYS } from '../state.js';
import { buildFilterBar as buildFilterBarUntyped } from './filter-bar.js';
import { queryDescription, queryFavorite, queryName, queryPanel } from '../core/saved-query.js';
import { explicitPanel, isKpiPanel, panelExecution } from '../core/panel-execution.js';
import { effectiveDashboardRole } from '../core/result-choice.js';
import { filterExecution } from '../core/filter-execution.js';
import { readFilterOptions as readFilterOptionsUntyped } from '../core/filter-options.js';
import { mergeDashboardFilterHelpers } from '../core/dashboard-filters.js';
import type {
  FilterDiagnostic, FilterHelper, FilterProvider, MergeDashboardFilterHelpersResult,
} from '../core/dashboard-filters.js';
import { diagnostic as diagnosticUntyped } from '../core/diagnostics.js';
import {
  buildKpiBand, buildKpiSourceSlot, setKpiSourceLoading, setKpiSourceUnfilled, applyKpiSourceResult,
  refreshBandWarnings,
} from './dashboard-kpi-band.js';
import type { KpiBand, KpiSourceSlot } from './dashboard-kpi-band.js';
import type { Panel, SavedQueryV2 } from '../generated/json-schema.types.js';
import type { App } from './app.types.js';

// ── Typed wrappers over still-untyped .js dependencies ──────────────────────
// Each const/overload pins exactly the signature this module relies on,
// verified against the wrapped function body; the runtime module stays `.js`
// until its own leaf-up conversion (ADR-0002) — same convention as panels.ts /
// state.ts / core/panel-execution.ts.

type ElProps = Record<string, unknown> | null;

/** dom.js's `h` supports far more (SVG documents, function components, style
 *  objects, ...) than this render module needs; the TagNameMap overload keeps
 *  e.g. `h('button', ...)` typed as HTMLButtonElement (so `.disabled` needs no
 *  cast at each call site) while every other/dynamic tag still returns a
 *  plain HTMLElement — the same overload pair panels.ts pins. */
function h<K extends keyof HTMLElementTagNameMap>(
  tag: K, props: ElProps, ...children: unknown[]
): HTMLElementTagNameMap[K];
function h(tag: string, props: ElProps, ...children: unknown[]): HTMLElement;
function h(tag: string, props: ElProps, ...children: unknown[]): HTMLElement {
  // `as`: dom.js is unconverted — its inferred signature is looser than the
  // overloads above promise; the runtime always creates exactly the
  // requested tag (document.createElement(tag)).
  return hUntyped(tag, props, ...children) as HTMLElement;
}

// icons.js is unconverted JS built on the untyped `s()` SVG hyperscript —
// this module only ever appends the returned nodes as h() children or via
// appendChild, so the six icons it uses are pinned to that one honest shape.
const Icon: {
  star(filled?: boolean): SVGElement;
  spinner(): SVGElement;
  refresh(): SVGElement;
  sun(): SVGElement;
  moon(): SVGElement;
  arrow(): SVGElement;
} = IconUntyped;

// format.js is unconverted — detectSqlFormat returns either the authored
// FORMAT keyword text or `null` (the same wrapper cast panel-execution.ts
// applies to this same export); formatRows/formatBytes render '—' for
// null/NaN and compact human-readable text otherwise.
const detectSqlFormat = detectSqlFormatUntyped as (sql: string) => string | null;
const formatRows: (n: number | null | undefined) => string = formatRowsUntyped;
const formatBytes: (n: number | null | undefined) => string = formatBytesUntyped;

// chart-data.js is unconverted — the same wrapper panels.ts pins for schemaKey.
const schemaKey: (columns: Column[] | null | undefined) => string = schemaKeyUntyped;

/** The mutable streamed-result accumulator `newResult` (stream.js,
 *  unconverted) returns and `app.runReadInto` fills, narrowed to the fields
 *  this module reads — verified against the wrapped body. A type alias (not
 *  an interface) so it keeps TS's implicit index signature and stays
 *  assignable to `runReadInto`'s `Record<string, unknown>` result param. */
type StreamResult = {
  columns: Column[];
  rows: unknown[][];
  rawFormat: string;
  progress: { rows: number; bytes: number; elapsed_ns: number };
  error: string | null;
  cancelled: boolean;
  rowLimit: number;
  capped: boolean;
};
const newResult: (fmt: string, rowLimit?: number) => StreamResult = newResultUntyped;

// filter-bar.js is unconverted — buildFilterBar(app, params, onCommit,
// getField, options) builds one field per `fieldControls` entry, reading the
// shared varValues/filterActive state off `app`; `curatedFields` entries are
// consumed structurally inside it, so the bag stays unknown-valued here.
const buildFilterBar: (
  app: App,
  params: FieldControl[],
  onCommit: (name: string) => void,
  getField: (name: string, mode: ValidationMode) => PreparedFieldState,
  options?: { curatedFields?: Record<string, unknown>; document?: Document; ariaLabel?: string },
) => HTMLElement = buildFilterBarUntyped;

// filter-options.js is unconverted — readFilterOptions normalizes one Filter
// result row into helper columns + diagnostics, the exact shapes
// dashboard-filters.ts declares for the same pipeline.
const readFilterOptions = readFilterOptionsUntyped as (args: {
  columns?: Column[]; row?: unknown; rowCount?: number;
}) => { helpers: FilterHelper[]; diagnostics: FilterDiagnostic[] };

// diagnostics.js's shared `{severity, code, message, ...extra}` factory
// (unconverted) — the same wrapper shape dashboard-filters.ts pins for the
// same function.
const diagnostic = diagnosticUntyped as (
  severity: 'error' | 'warning' | 'info',
  code: string,
  message: string,
  extra?: Record<string, unknown>,
) => FilterDiagnostic;

/** Structurally identical alias view of filter-execution.ts's
 *  `FilterSqlDiagnostic`. That declaration is an interface, which TS never
 *  grants an implicit index signature, so its arrays can't assign into
 *  FilterProvider's indexed `FilterDiagnostic[]` even though every member
 *  matches — this alias DOES get the implicit index signature, bridging the
 *  two .ts contracts without a cast. */
type FilterSqlDiagnosticView = { severity: 'error'; code: string; message: string; path: string[] };

// ── Slot & outcome contracts ─────────────────────────────────────────────────

/** One fetched tile result's footer metadata (see `tileFooter` /
 *  `dashboardTileResult`). */
interface TileResultMeta {
  rows: number;
  ms: number;
  bytes: number;
  truncated: boolean;
}

/** A settled dashboard source outcome, as `runFavoriteSource` hands it to a
 *  hook's `applyResult`: either the error-only gate/rejection object (a
 *  per-source serialization/config error, an owned-FORMAT rejection) or
 *  `dashboardTileResult`'s full fetched shape. A type alias (implicit index
 *  signature) so it also flows into the KPI band's structurally matching
 *  result parameter. */
type FavoriteSourceResult = {
  error?: string | null;
  cancelled?: boolean;
  columns?: Column[];
  rows?: unknown[][];
  meta?: TileResultMeta;
};

/** Slot-persistent table-tile state (#166): the result-schema key this slot's
 *  grid state was built for, plus whatever sort/width state the panel
 *  registry parks on it (panels.ts's `state` holder contract). */
type TilePanelState = { key: string; [k: string]: unknown };

/** One ordinary favorite's stable tile slot (`buildTileSlot`) — the
 *  `kind:'tile'` counterpart of dashboard-kpi-band.ts's `KpiSourceSlot`, so
 *  `runPlan`'s dispatch is one discriminated union. Lifecycle fields mirror
 *  that slot exactly: `gen` + `abortController` are the stale-wave guard,
 *  `destroy` tears down the live panel instance (PanelRenderResult.destroy),
 *  `loadLabel` is the streaming placeholder's live text node. */
interface TileSlot {
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
type DashSlot = TileSlot | KpiSourceSlot;

/** The stale-wave guard fields every slot kind (tile, KPI source, Filter
 *  source) shares — `supersedeSlot`'s whole contract (#193/#237). */
interface SupersedableSlot {
  gen: number;
  abortController: AbortController | null;
}

/** One Filter-role query's in-memory slot (#237): the same generation/abort
 *  guard the tile slots use, plus the last provider it produced so a retry
 *  can re-merge every source's current contribution. */
interface FilterSlot extends SupersedableSlot {
  status: 'idle' | 'loading' | 'error' | 'success';
  lastProvider: FilterProvider | null;
}

/** The per-consumer half of `runFavoriteSource` (#240): which explicit panel
 *  owns transport, the client row cap, whether the shared `detectSqlFormat`
 *  cross-check applies, and the three state-transition renderers. Generic
 *  over the slot kind so an ordinary tile's hooks can never be paired with a
 *  KPI source slot (or vice versa) — the handlers are function-typed (not
 *  method shorthand) to keep the slot parameter contravariant under
 *  strictFunctionTypes. `setLoading` returns only the loading label's live
 *  text node: streamed progress (#193 design req 4) may update that text and
 *  nothing else — a progress callback can never render/classify a result. */
interface FavoriteSourceHooks<S extends DashSlot> {
  explicit: Panel | null;
  rowCap: number;
  checkFormat: boolean;
  setUnfilled: (slot: S, names: string[]) => void;
  setLoading: (slot: S) => HTMLElement;
  applyResult: (slot: S, r: FavoriteSourceResult) => void;
}

/** One entry of a wave's execution plan (`planWave`): the favorite, its
 *  stable slot, its prepared source from the wave's batch, and the generation
 *  reserved for it at wave creation (#193 design req 3). `src` comes from the
 *  wave's `PreparedBatch.sources` by index — runAll temporarily plans against
 *  an empty wave and swaps the real `src` in after the filter wave resolves. */
interface PlannedSource {
  index: number;
  q: SavedQueryV2;
  slot: DashSlot;
  src: PreparedSource;
  generation: number;
}

// At most this many tile queries run at once, so a large favorites list doesn't
// fire a thundering herd of concurrent reads at ClickHouse (saturating the
// browser's per-host pool and the cluster) on open and on every Refresh.
const TILE_CONCURRENCY = 6;

/** One layout-switcher option: `[value, label, title?]` (the optional `title`
 *  becomes the button's hover tooltip). */
type SegOption = [value: string, label: string, title?: string];

/**
 * Build a segmented control (the four-way `Full width | Report | 2 columns |
 * 3 columns` layout switcher, #184): a row of buttons of which exactly one
 * reads active. `options` are `[value, label, title?]` triples (the optional
 * `title` becomes the button's hover tooltip); `ariaLabel` names the group for
 * assistive tech. `getActive` returns the currently-selected value; `onPick(
 * value)` fires on a click. Returns `{ el, sync }` — `sync()` repaints the
 * active button (and its `aria-pressed`) from `getActive()`, so a pick and the
 * shared `apply()` stay in agreement.
 */
function buildSeg(
  cls: string,
  options: SegOption[],
  getActive: () => string,
  onPick: (value: string) => void,
  ariaLabel: string,
): { el: HTMLElement; sync: () => void } {
  // `h` skips nullish attribute values, so an option's absent `title` (or a
  // missing `ariaLabel`) simply isn't set — no explicit guard needed here.
  const btns = options.map(([, label, title]) =>
    h('button', { class: 'dash-seg-btn', type: 'button', title }, label));
  const sync = () => btns.forEach((b, i) => {
    const on = options[i][0] === getActive();
    b.classList.toggle('is-active', on);
    b.setAttribute('aria-pressed', String(on));
  });
  btns.forEach((b, i) => { b.onclick = () => onPick(options[i][0]); });
  const el = h('div', { class: 'dash-seg ' + cls, role: 'group', 'aria-label': ariaLabel }, ...btns);
  sync();
  return { el, sync };
}

/**
 * Build a tile's footer meta row (rows · ms · bytes). On the streaming seam
 * (#193) `ms` is wall-clock (like run()'s finally) and `bytes` is the progress
 * byte count — both always present — so the row is unconditional. A
 * fetch-truncated result (#149 D9: the client trimmed it to DASH_TILE_ROW_CAP)
 * gets an honest note — client-side sort and chart aggregation only cover that
 * fetched prefix, not the full underlying result.
 */
function tileFooter(meta: TileResultMeta): HTMLElement[] {
  const parts = [
    h('span', null, formatRows(meta.rows) + ' rows'),
    h('span', null, meta.ms + ' ms'),
    h('span', null, formatBytes(meta.bytes) + ' scanned'),
  ];
  if (meta.truncated) {
    parts.push(h('span', null,
      'first ' + DASH_TILE_ROW_CAP.toLocaleString() + ' rows fetched — sorting/charts cover this prefix only'));
  }
  return parts;
}

/**
 * Adapt a streamed `result` (from `app.runReadInto`) to the tile result shape
 * `applyTileResult`/`tileFooter` expect (#193). `ms` is wall-clock (start→finish,
 * like run()'s finally), `bytes` is the streamed progress byte count, and
 * `truncated` reflects the client-side cap (`result.capped` — set once a row
 * past `DASH_TILE_ROW_CAP` arrives). Only a successful, non-cancelled,
 * current-generation result is ever applied (see runSlotTile).
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
 * index in turn; each `worker` appends its card synchronously before its first
 * await, so cards land in favorite order regardless of which query returns
 * first. Returns the per-item results in index order.
 */
async function runPool<T, R>(items: T[], limit: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
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

// One favorite's tile card, built once per dashboard load (favorite order) and
// never removed/re-appended: a filter change can flip a tile between
// skip ⇄ unfilled ⇄ chart repeatedly, and removing/re-inserting DOM nodes would
// both reorder the grid and orphan the "same" tile's identity. Every later
// state transition (`setSlotLoading`/`setSlotUnfilled`/`applyTileResult`)
// updates this same slot's contents/visibility in place instead. `gen` is a
// per-tile monotonically increasing generation counter guarding against
// out-of-order responses (edit A, then B, before A's request returns — B's
// response must win — and a queued Refresh worker that a newer wave has already
// superseded); `abortController` cancels this slot's in-flight streamed request
// when a newer wave supersedes it (#193); `destroy` tears down the slot's live
// panel instance (a chart's Chart.js object, via the registry's renderPanel
// contract) before it's replaced; `panelState` is the slot-persistent table-tile
// state (#166 — sort + column widths, keyed by result schema); `loadLabel` is
// the loading placeholder's live row-count text node (streamed progress, #193).
// An EXPLICIT KPI favorite never reaches this builder — it's routed to a KPI
// band slot instead (#240, see partitionKpiBands) — so `is-kpi` here only ever
// toggles on later for an AUTO-DETECTED one-row result (applyTileResult).
function buildTileSlot(q: SavedQueryV2): TileSlot {
  const body = h('div', { class: 'dash-tile-body' });
  const foot = h('div', { class: 'dash-tile-foot' });
  const name = queryName(q);
  const description = queryDescription(q);
  // Header: the favorite's name, plus its saved description as a subtitle when it
  // has one (single line, ellipsized) — mirrors the design mockup's tile header.
  const head = h('div', { class: 'dash-tile-head' },
    h('span', { class: 'dash-tile-name', title: name }, name));
  if (description) head.appendChild(h('div', { class: 'dash-tile-desc', title: description }, description));
  const card = h('div', { class: 'dash-tile' }, head, body, foot);
  return {
    kind: 'tile', card, body, foot, gen: 0, status: null, destroy: null, panelState: null,
    abortController: null, loadLabel: null,
  };
}

// Reserve the next generation for a slot AND abort its in-flight streamed
// request, atomically, at WAVE CREATION time (#193 design req 3). A queued
// Refresh worker only reaches its request when a pool slot frees up; reserving
// the generation up front (not when the worker starts) closes the stale-wave
// race where a slower older wave's worker finally runs a tile and supersedes a
// newer affected wave with older values. Returns the reserved generation; the
// worker re-checks `slot.gen === generation` before issuing and after streaming.
function supersedeSlot(slot: SupersedableSlot): number {
  const generation = ++slot.gen;
  if (slot.abortController) slot.abortController.abort();
  slot.abortController = null;
  return generation;
}

function destroySlotChart(slot: TileSlot): void {
  if (slot.destroy) { slot.destroy(); slot.destroy = null; }
}

/** True for a text panel — the no-query partition (#166). */
function isTextFav(q: SavedQueryV2): boolean {
  const p = explicitPanel(q);
  // `!`: explicitPanel only ever returns a panel whose `cfg` passed its own
  // plain-object check (panel-execution.ts) — the schema marks `cfg` optional
  // only for forward compatibility.
  return !!p && p.cfg!.type === 'text';
}

// Render a text favorite's tile: immediately, with zero queries — the #166
// partition runs this before any auth/SQL work.
function renderTextSlot(app: App, q: SavedQueryV2, slot: TileSlot): void {
  destroySlotChart(slot);
  slot.status = 'panel';
  slot.card.style.display = '';
  const { node } = renderResolvedPanel(app, resolvePanel(queryPanel(q), []), null,
    { surface: 'dashboard', state: {}, rerender: () => {}, readonly: true });
  slot.body.replaceChildren(node);
  slot.foot.replaceChildren();
}

function setSlotLoading(slot: TileSlot): HTMLElement {
  destroySlotChart(slot);
  slot.card.style.display = '';
  // Return the label node so streamed progress (onChunk, #193) can update just
  // its text — "Loading… N rows" — without rebuilding the tile or classifying
  // yet. Panel classification + rendering happen ONCE, after completion (never
  // per chunk, which would thrash Chart.js and flash partial data).
  const label = h('span', null, 'Loading…');
  slot.loadLabel = label;
  slot.body.replaceChildren(h('div', { class: 'dash-tile-load' }, Icon.spinner(), label));
  slot.foot.replaceChildren();
  return label;
}

// A tile whose SQL still has an empty/absent, or invalid (#170), {name:Type}
// value never issues a request — it shows this placeholder instead (reusing
// the card's header/footer chrome so it doesn't look broken), and stays
// visible: unlike a classifyTile `skip`, one filter value away it becomes
// chartable, so it is NOT counted in the header's "N not shown" note.
function setSlotUnfilled(slot: TileSlot, names: string[]): void {
  destroySlotChart(slot);
  slot.status = 'unfilled';
  slot.card.style.display = '';
  slot.body.replaceChildren(h('div', { class: 'dash-tile-unfilled' }, 'Enter a value for: ' + names.join(', ')));
  slot.foot.replaceChildren();
}

function applyTileResult(app: App, q: SavedQueryV2, slot: TileSlot, r: FavoriteSourceResult): void {
  destroySlotChart(slot);
  if (r.error != null) {
    slot.status = 'error';
    slot.card.style.display = '';
    slot.body.replaceChildren(h('div', { class: 'dash-tile-error' }, r.error));
    slot.foot.replaceChildren();
    return;
  }
  const savedPanel = queryPanel(q);
  const explicit = explicitPanel(q);
  // `!` (on rows/meta below): a non-error outcome is always dashboardTileResult's
  // full fetched shape — runFavoriteSource's only other applyResult payloads
  // are error-only, and those returned above.
  // Unconfigured empty results remain skipped. An EXPLICIT panel never vanishes —
  // a zero-row one renders an honest "0 rows" state instead (visible, and
  // excluded from the header's skip tally).
  if (!explicit && r.rows!.length === 0) {
    slot.status = 'skip';
    slot.card.style.display = 'none';
    // Clear the previous panel's DOM (its live instance is already torn down
    // by destroySlotChart above) so a tile that flips panel → skip on a later
    // refresh/filter change doesn't leave a dead canvas hidden in the DOM.
    slot.body.replaceChildren();
    slot.foot.replaceChildren();
    return;
  }
  slot.status = 'panel';
  slot.card.style.display = '';
  // `explicit` here is never an explicit KPI panel — those are routed to a KPI
  // band slot (#240) and never reach applyTileResult — so an explicit zero-row
  // result is always a non-KPI panel's honest "0 rows" state.
  if (explicit && r.rows!.length === 0) {
    slot.body.replaceChildren(h('div', { class: 'dash-tile-empty' }, '0 rows'));
    slot.foot.replaceChildren(...tileFooter(r.meta!));
    return;
  }
  // The one shared resolution (#166/#254): queryPanel retains fieldConfig even
  // when cfg is absent, so auto-derived Dashboard panels receive the same
  // presentation metadata as the workbench. `explicit` remains separate above
  // because only cfg-bearing panels own zero-row and transport semantics.
  const resolved = resolvePanel(savedPanel, {
    columns: r.columns,
    rows: r.rows,
    fieldConfig: savedPanel?.fieldConfig,
    serverVersion: app.state.serverVersion,
  });
  slot.card.classList.toggle('is-kpi', resolved.cfg.type === 'kpi');
  // Grid state persists across refreshes/filter edits on the stable slot,
  // keyed by result schema — a schema change resets it, a re-run keeps it.
  const key = schemaKey(r.columns);
  if (!slot.panelState || slot.panelState.key !== key) slot.panelState = { key };
  // `as`: panels.ts's (unexported) PanelResult also declares `error`/`rawText`,
  // which no dashboard-dispatched arm reads (table/logs/chart consume
  // columns/rows only; kpi/text ignore the result) — the dashboard has always
  // passed exactly this two-field shape. Reported as a panels.ts contract gap.
  const res = { columns: r.columns, rows: r.rows } as Parameters<typeof renderResolvedPanel>[2];
  const paint = () => {
    destroySlotChart(slot);
    const out = renderResolvedPanel(app, resolved, res, {
      surface: 'dashboard',
      // `!`: assigned right above (and only ever replaced, never nulled back).
      state: slot.panelState!,
      rerender: paint, // header-click sorts re-paint locally — NO re-query
      readonly: true,
      cap: DASH_TABLE_DISPLAY_CAP,
      onCell: () => {},
    });
    slot.destroy = out.destroy || null;
    slot.body.replaceChildren(out.node);
  };
  paint();
  slot.foot.replaceChildren(...tileFooter(r.meta!));
}

// Run (or re-run) one favorite's source into its slot, gated by its prepared
// source from the wave's batch (#173): unfilled OR invalid (#170) `{name:Type}`
// values show the placeholder (never issuing a request — an invalid value left
// to reach the server would either error confusingly or, for Int/UInt, silently
// wrap; see param-validate.js), a per-source error (e.g. a value that can't
// serialize for this tile's declaration) shows an error card — blocking only
// this source, never its siblings — otherwise stream the SQL read-only through
// the shared `app.runReadInto` seam (#193) and classify ONCE on completion.
// `onSettled()` fires after every transition (unfilled, errored or fetched) so
// the caller can recompute the live "N not shown" count.
//
// Shared by an ordinary tile (`runSlotTile`) and an explicit KPI band source
// (`runKpiSourceTile`, #240) — the two differ only in which state-transition
// functions render each outcome, the client row cap, and whether an authored
// `FORMAT` needs the extra `detectSqlFormat` cross-check (a KPI's authored-
// FORMAT rejection is entirely `panelExecution`'s own); `hooks` supplies that
// difference so the streaming/gating/generation/abort discipline itself is
// written once (CLAUDE.md: extract a shared primitive on the second consumer
// of a pattern rather than copy it).
//
// `generation` was reserved (and any prior in-flight request aborted) by
// `supersedeSlot` at WAVE CREATION (#193 design req 3), not here: a queued
// Refresh worker whose slot a newer wave has already re-reserved discards itself
// up front without issuing, and a supersede mid-stream aborts this request and
// makes the post-await guard drop it — so a stale wave can never overwrite a
// newer one, even under the 6-way pool's queueing.
async function runFavoriteSource<S extends DashSlot>(
  app: App, q: SavedQueryV2, slot: S, onSettled: () => void,
  src: PreparedSource, generation: number, hooks: FavoriteSourceHooks<S>,
): Promise<void> {
  if (slot.gen !== generation) return; // a newer wave already superseded this queued source
  if (src.missing.length || src.invalid.length) {
    hooks.setUnfilled(slot, src.missing.concat(src.invalid));
    onSettled();
    return;
  }
  if (src.errors.length) {
    hooks.applyResult(slot, { error: src.errors[0] });
    onSettled();
    return;
  }
  // The wire text is the wave's materialized execution view (#165) — only when
  // the favorite actually is a template; block-free SQL keeps its exact bytes.
  const execSql = hasOptionalBlocks(q.sql) ? mergedSourceSql(src, q.sql) : q.sql;
  const execution = panelExecution(hooks.explicit, execSql, {
    format: 'Table', rowLimit: DASH_TILE_ROW_CAP + 1,
    params: { readonly: 2, max_result_bytes: DASH_TILE_BYTE_CAP, ...mergedSourceArgs(src) },
  });
  // #193 design req 5: the shared seam streams the structured
  // JSONStringsEachRowWithProgress format, so an explicit `FORMAT` clause would
  // silently corrupt the tile (an empty successful-looking result, or ignored
  // lines). Reject it with a clear error rather than mis-parse.
  if (execution.error || (hooks.checkFormat && detectSqlFormat(execSql))) {
    hooks.applyResult(slot, {
      error: execution.error || 'Dashboard panels require structured streaming results. Remove the explicit FORMAT clause.',
    });
    onSettled();
    return;
  }
  const label = hooks.setLoading(slot);
  const ac = new AbortController();
  slot.abortController = ac;
  const startedAt = app.now();
  // Client row limit = CAP (newResult trims + flags `capped`); server cap =
  // CAP + 1 (the sentinel one past the client limit), so an exactly-CAP result
  // is NOT marked truncated and a >CAP result is trimmed AND flagged (#193 req 1).
  // `!`: format is always concrete here — the defaults above pin 'Table' and
  // panelExecution's owned KPI arm overrides it with 'KPI'.
  const result = newResult(execution.format!, hooks.rowCap);
  await app.runReadInto(result, {
    sql: execSql,
    format: execution.format,
    rowLimit: execution.rowLimit,
    // readonly:2 rejects writes server-side (a favorite containing an INSERT/DDL
    // is guarded, not executed); max_result_bytes bounds wide rows; param_<name>
    // are the wave's prepared filter args (#173).
    params: execution.params,
    signal: ac.signal,
    // Progress-only repaint (#193 design req 4): update the loading placeholder's
    // row count as rows stream, never classify/render mid-stream. Updates the
    // label captured for THIS request, so a superseded wave's late chunk can only
    // touch its own (already-replaced) node.
    onChunk: () => { label.textContent = 'Loading… ' + formatRows(result.progress.rows) + ' rows'; },
  });
  // Superseded mid-stream (a newer wave bumped the generation and aborted this
  // request via supersedeSlot) or otherwise stale → discard silently: never
  // render a partial/aborted result, never record recents.
  if (slot.gen !== generation) return;
  slot.abortController = null;
  const r = dashboardTileResult(result, startedAt, app.now());
  hooks.applyResult(slot, r);
  // #171: this source completed (current generation) — record its bound params
  // on success only (the exact wave's boundParams snapshot, so a param confined
  // to an inactive optional block — never in `src.statements[*].boundParams` —
  // is never recorded). An errored source records nothing.
  if (r.error == null) app.recordBoundParams(src.statements.flatMap((s) => s.boundParams));
  onSettled();
}

// `q` here is never an explicit KPI favorite — those run through
// runKpiSourceTile instead (#240) — so `explicitPanel(q)` (if non-null) is
// never `isKpiPanel`.
function runSlotTile(
  app: App, q: SavedQueryV2, slot: TileSlot, onSettled: () => void, src: PreparedSource, generation: number,
): Promise<void> {
  return runFavoriteSource(app, q, slot, onSettled, src, generation, {
    explicit: explicitPanel(q), rowCap: DASH_TILE_ROW_CAP, checkFormat: true,
    setUnfilled: setSlotUnfilled,
    setLoading: setSlotLoading,
    applyResult: (s, r) => applyTileResult(app, q, s, r),
  });
}

// The KPI-source counterpart of runSlotTile (#240), sharing its gating/
// generation/abort discipline exactly via runFavoriteSource. `explicit` is
// always `cfg.type === 'kpi'` here (the caller only dispatches here for a
// `kind:'kpi-source'` slot, which partitionKpiBands only ever builds from an
// explicit KPI favorite) — so panelExecution always takes its KPI branch
// (owned typed transport, two-row sentinel) and the authored-FORMAT rejection
// is entirely panelExecution's own (no detectSqlFormat cross-check needed,
// unlike the ordinary-tile path).
function runKpiSourceTile(
  app: App, q: SavedQueryV2, explicit: Panel, slot: KpiSourceSlot,
  onSettled: () => void, src: PreparedSource, generation: number,
): Promise<void> {
  return runFavoriteSource(app, q, slot, onSettled, src, generation, {
    explicit, rowCap: 2, checkFormat: false,
    setUnfilled: setKpiSourceUnfilled,
    setLoading: setKpiSourceLoading,
    applyResult: (s, r) => applyKpiSourceResult(app, explicit, s, r),
  });
}

/** Render the dashboard into `app.root`. */
export function renderDashboard(app: App): Promise<void> {
  const { document: doc, state } = app;
  doc.documentElement.setAttribute('data-theme', state.theme);
  doc.documentElement.setAttribute('data-density', state.density);
  app.dom = {};

  const favorites = state.savedQueries.filter(queryFavorite);
  const panelFavorites: SavedQueryV2[] = [];
  const filterFavorites: SavedQueryV2[] = [];
  const roleDiagnostics: { severity: 'warning' | 'error'; message: string }[] = [];
  for (const query of favorites) {
    const role = effectiveDashboardRole(query.spec);
    if (role === 'panel') panelFavorites.push(query);
    else if (role === 'filter') filterFavorites.push(query);
    else if (role === 'setup') roleDiagnostics.push({ severity: 'warning', message: `${queryName(query)} uses Setup, which is not implemented yet.` });
    else roleDiagnostics.push({ severity: 'error', message: `${queryName(query)} has unknown Dashboard role "${role}".` });
  }

  // KPI bands are built structurally, from the saved config alone, before any
  // query executes (#240): an EXPLICIT `panel.cfg.type==='kpi'` favorite joins
  // a band; an auto-detected one-row KPI result (no saved panel) never does —
  // that distinction lives entirely in `explicitPanel`/`isKpiPanel`, never in a
  // fetched result, so it can't drift with what a query happens to return.
  const layoutItems = partitionKpiBands(panelFavorites.map((q) => isKpiPanel(explicitPanel(q))));

  // The favorites snapshot is fixed for this render, so the parameter analysis
  // (#173 phase 1 — structure only) runs once; each wave (runAll / a filter's
  // runAffected) prepares it against the current varValues with one wall-clock
  // read, and every tile gate + fetch of that wave reads the same batch.
  const tileId = (i: number): string => 'tile:' + (panelFavorites[i].id || i);
  const analysis = analyzeParameterizedSources(panelFavorites.map((q, i) => ({
    id: tileId(i), label: queryName(q), kind: 'tile', sql: isTextFav(q) ? '' : q.sql, bindPolicy: 'row-returning',
  })));
  const prepareBatch = (validationMode: ValidationMode = 'execute') => prepareParameterizedBatch(analysis, {
    values: Object.fromEntries(Object.entries(app.state.varValues).map(([name, value]): [string, string] => [
      name, curatedFields?.[name] && !app.state.filterActive[name] ? '' : value,
    ])),
    active: effectiveFilterActive(app.state.varValues, app.state.filterActive),
    wallNowMs: app.wallNow(), validationMode,
  });
  const prepareWave = () => prepareBatch('execute').sources;
  // The filter bar's per-keystroke field-state read (#170): 'input' while
  // typing (neutral on a plausible prefix), 'execute' on blur/Enter (hardens).
  const getFilterField = (name: string, mode: ValidationMode) => prepareBatch(mode).fields[name];

  const favChip = h('span', { class: 'dash-chip dash-fav' },
    Icon.star(true),
    h('span', null, favorites.length + (favorites.length === 1 ? ' favorite' : ' favorites')));
  const skipNote = h('span', { class: 'dash-skip', style: { display: 'none' } });
  const updated = h('span', { class: 'dash-updated' });
  const refreshBtn = h('button', {
    class: 'dash-btn dash-refresh', title: 'Re-run all tiles', 'aria-label': 'Refresh dashboard',
  }, Icon.refresh(), h('span', { class: 'dash-refresh-label' }, 'Refresh'));
  // Theme toggle, mirroring the workbench header: reuse app.toggleTheme (persists
  // the pref + flips data-theme), and register the button as app.dom.themeBtn so
  // that helper repaints its icon on toggle.
  const themeBtn = h('button', {
    class: 'dash-icobtn', title: 'Toggle theme', 'aria-label': 'Toggle theme', onclick: () => app.toggleTheme(),
  });
  themeBtn.appendChild(state.theme === 'dark' ? Icon.sun() : Icon.moon());
  app.dom.themeBtn = themeBtn;

  const header = h('div', { class: 'dash-header' },
    h('a', {
      class: 'dash-back', href: app.basePath || '/sql', title: 'Back to SQL Browser',
      'aria-label': 'Back to SQL Browser',
    }, Icon.arrow(), h('span', { class: 'dash-back-label' }, 'SQL Browser')),
    h('div', { class: 'dash-title' }, state.libraryName.value),
    favChip,
    skipNote,
    h('div', { class: 'dash-spacer', style: { flex: '1' } }),
    h('span', { class: 'dash-chip dash-src', title: app.host() },
      h('span', { class: 'dash-dot' }), app.host()),
    updated,
    themeBtn,
    refreshBtn);

  const grid = h('div', { class: 'dash-grid' });
  const empty = h('div', { class: 'dash-empty', style: { display: favorites.length ? 'none' : '' } },
    'No favorites yet — star a query in the Library to add it to the dashboard.');

  // Layout toolbar (#149 D2, #184) + global filter bar (#149 D3). One four-way
  // segmented control — Full width | Report | 2 columns | 3 columns — replaces
  // the old Arrange|Report + separate Columns pair (#184): every effective view
  // is one click away and the two persisted keys (dashLayout/dashCols) are
  // driven together through activeDashboardView / dashboardViewSelection. It is
  // presentation-only: `apply()` toggles the grid's mutually-exclusive shape
  // classes and the tiles' Chart.js instances resize themselves via their
  // ResizeObserver — no tile re-query. Only the keys that actually change are
  // persisted (asb:dashLayout/dashCols) so the choice survives reloads and
  // Refresh. The filter bar sits immediately after the switcher; it is entirely
  // absent (no row, no spacing) when no favorite references a `{name:Type}`.
  const apply = () => {
    grid.classList.toggle('is-wide', state.dashLayout === 'wide');
    grid.classList.toggle('is-report', state.dashLayout === 'report');
    grid.style.setProperty('--dash-cols', String(state.dashCols));
    layoutSeg.sync();
  };
  const layoutSeg = buildSeg('dash-seg-layout', [
    ['wide', 'Full width', 'One tile per row using all available width'],
    ['report', 'Report', 'One centered, taller tile per row'],
    ['columns-2', '2 columns', 'Arrange tiles in two columns'],
    ['columns-3', '3 columns', 'Arrange tiles in three columns'],
  ], () => activeDashboardView(state), (view) => {
    if (view === activeDashboardView(state)) return;
    const sel = dashboardViewSelection(view);
    if (sel.dashLayout !== state.dashLayout) {
      // `!`: dashboardViewSelection always returns a concrete dashLayout — the
      // optionality belongs to its persisted-state-shaped return interface,
      // not this value (a core/dashboard.ts return-type gap, reported).
      state.dashLayout = sel.dashLayout!;
      app.savePref('dashLayout', sel.dashLayout);
    }
    if (sel.dashCols != null && sel.dashCols !== state.dashCols) {
      state.dashCols = sel.dashCols;
      app.savePref('dashCols', sel.dashCols);
    }
    apply();
  }, 'Dashboard layout');
  const layoutWrap = h('div', { class: 'dash-layout-wrap' },
    h('span', { class: 'dash-seg-label' }, 'Layout'), layoutSeg.el);
  const controls = fieldControls(analysis);
  // Seed from the persisted last-known bundle (#234) so a curated field paints
  // as the combobox immediately instead of flashing plain text for one frame
  // before the first Filter wave resolves; the live wave replaces it below.
  let curatedFields: Record<string, unknown> = state.filterCurated || {};
  const filterHost = h('div', { class: 'dash-filter-host' });
  const filterDiagnosticsHost = h('div', { class: 'dash-filter-diagnostics' });
  const renderFilterBar = () => filterHost.replaceChildren(buildFilterBar(
    app, controls, (name) => runAffected(name), getFilterField, { curatedFields },
  ));
  renderFilterBar();
  // The toolbar is flex-start (default), so layoutWrap + filterBar pack left as
  // the issue specifies — no trailing spacer needed now the right-aligned
  // Columns control is gone (#184).
  const toolbar = h('div', {
    class: 'dash-toolbar' + (controls.length ? ' has-filters' : ''),
  }, layoutWrap, filterHost);
  apply();

  // #root is a fixed, overflow:hidden flex column (the workbench layout), so the
  // dashboard needs its own scroll container — otherwise a tall grid clips with
  // no vertical scroll. The header + toolbar share one sticky top bar inside it.
  // `!`: the dashboard renders only into a mounted page — main.js/openDashboard
  // always hand createApp a real root element.
  app.root!.replaceChildren(h('div', { class: 'dash-page' },
    h('div', { class: 'dash-topbar' }, header, toolbar),
    ...roleDiagnostics.map((item) => h('div', { class: `dash-config-diagnostic is-${item.severity}` }, item.message)),
    filterDiagnosticsHost, empty, grid));

  // One stable slot per favorite (favorite order), built lazily on the first
  // successful run (below) and reused for the tab's lifetime — a filter edit
  // or Refresh updates a slot's contents/visibility in place rather than
  // inserting/removing grid children (see buildTileSlot).
  let slots: DashSlot[] = [];
  // Filter sources reuse the SAME generation/abort guard tile slots use
  // (supersedeSlot / `slot.gen`, #237) — a second consumer of the stale-wave
  // pattern gets the existing primitive, not a re-implementation. `gen` is
  // reserved at wave-creation time (see runFilterWave), so a queued worker from
  // an older wave sees `slot.gen !== generation` and discards itself.
  const filterSlots = new Map<string, FilterSlot>(filterFavorites.map((query): [string, FilterSlot] => [query.id, {
    gen: 0, abortController: null, status: 'idle', lastProvider: null,
  }]));

  async function runFilterSource(query: SavedQueryV2, slot: FilterSlot, generation: number): Promise<FilterProvider | null> {
    const execution = filterExecution(query.sql);
    if (execution.error) {
      // The alias view (see FilterSqlDiagnosticView above) lets the plan's
      // interface-typed diagnostics assign into the provider's FilterDiagnostic[].
      const diagnostics: FilterSqlDiagnosticView[] = execution.diagnostics;
      const provider: FilterProvider = {
        sourceId: query.id, sourceName: queryName(query), helpers: [], diagnostics,
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
    await app.runReadInto(result, {
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

  const renderFilterDiagnostics = (diagnostics: FilterDiagnostic[]) => {
    filterDiagnosticsHost.replaceChildren(...diagnostics.map((item) => {
      // `as`: `sourceId` reaches FilterDiagnostic only through its open index
      // signature (`unknown`), but every 'filter-query-failed' diagnostic is
      // minted in runFilterSource above with `sourceId: query.id` (a string).
      const retry = item.code === 'filter-query-failed' && item.sourceId
        ? h('button', { type: 'button', onclick: () => retryFilter(item.sourceId as string) }, 'Retry')
        : null;
      return h('div', { class: `dash-config-diagnostic is-${item.severity}` }, item.message, retry);
    }));
  };

  const applyFilterProviders = (providers: (FilterProvider | null)[]): MergeDashboardFilterHelpersResult => {
    const merged = mergeDashboardFilterHelpers({
      // The predicate is `filter(Boolean)` made narrowable: a provider is only
      // ever null here (a superseded run), never any other falsy value.
      providers: providers.filter((provider): provider is FilterProvider => provider !== null), controls,
      values: state.varValues, active: effectiveFilterActive(state.varValues, state.filterActive),
    });
    curatedFields = merged.fields;
    // Persist the live bundle so the next dashboard load can seed it (#234).
    state.filterCurated = merged.fields;
    app.saveJSON(KEYS.filterCurated, merged.fields);
    if (merged.changed.length) {
      state.filterActive = merged.active;
      app.saveFilterActive();
    }
    renderFilterBar();
    renderFilterDiagnostics(merged.diagnostics);
    return merged;
  };

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
    const query = filterFavorites.find((item) => item.id === sourceId);
    const slot = filterSlots.get(sourceId);
    if (!query || !slot) return;
    if (!(await app.ensureFreshToken())) { app.chCtx.onSignedOut(); return; }
    await runFilterSource(query, slot, supersedeSlot(slot));
    // `!`: same filterSlots key invariant as runFilterWave above.
    const merged = applyFilterProviders(filterFavorites.map((item) => filterSlots.get(item.id)!.lastProvider));
    for (const name of merged.changed) await runAffected(name);
  }

  const updateSkipNote = () => {
    const skipped = slots.filter((s) => s.status === 'skip').length;
    if (skipped) {
      skipNote.style.display = '';
      skipNote.textContent = skipped + ' not shown';
      skipNote.title = skipped + ' empty favorite(s) with no panel to render.';
    } else {
      skipNote.style.display = 'none';
    }
  };

  // Build the wave's execution plan for a set of query-backed favorites: one
  // `{ q, slot, src, generation }` per tile, reserving each slot's generation
  // (and aborting any in-flight request) synchronously HERE, at wave creation
  // (#193 design req 3). Reserving up front — not when a pool worker starts —
  // closes the stale-wave race: a queued older worker sees `slot.gen !==
  // generation` and discards itself instead of superseding a newer wave.
  const planWave = (indices: number[], wave: PreparedSource[]): PlannedSource[] => indices
    .filter((i) => !isTextFav(panelFavorites[i]))
    .map((i) => ({ index: i, q: panelFavorites[i], slot: slots[i], src: wave[i], generation: supersedeSlot(slots[i]) }));

  const runPlan = (plan: PlannedSource[]): Promise<void[]> => {
    // Mark every planned slot loading up front — before the 6-way pool starts —
    // so tiles beyond TILE_CONCURRENCY's window don't linger on stale content
    // while queued. Applies to BOTH full Refresh and targeted affected waves
    // (#193); runSlotTile/runKpiSourceTile re-mark their own slot loading when
    // their worker starts (capturing the progress label), so filled tiles/cards
    // simply repaint identically. Dispatch is by `slot.kind` (#240): an explicit
    // KPI favorite's slot always came from buildKpiSourceSlot, never buildTileSlot.
    // setKpiSourceLoading does NOT refresh its band's shared warning area itself
    // (that would be one O(band size) DOM rebuild PER member, back to back,
    // synchronously, with only the last ever visible) — collect every band this
    // plan touches and refresh each exactly once after marking the whole batch.
    const touchedBands = new Set<KpiBand>();
    plan.forEach(({ slot }) => {
      if (slot.kind === 'kpi-source') { setKpiSourceLoading(slot); touchedBands.add(slot.band); }
      else setSlotLoading(slot);
    });
    touchedBands.forEach(refreshBandWarnings);
    return runPool(plan, TILE_CONCURRENCY,
      ({ q, slot, src, generation }) => (slot.kind === 'kpi-source'
        ? runKpiSourceTile(app, q, slot.explicit, slot, updateSkipNote, src, generation)
        : runSlotTile(app, q, slot, updateSkipNote, src, generation)));
  };

  // Re-run only the favorites whose SQL references `name` (a filter field's
  // debounced/committed edit, #149 D3) — not the whole grid. Affected-source
  // detection comes from the analysis (#173): `optionalIn` keeps a tile
  // affected even while the param's optional blocks are inactive (#165), so an
  // activation flip re-runs it exactly like a value change. A no-op before
  // the first successful run (slots not built yet).
  async function runAffected(name: string): Promise<void[] | undefined> {
    if (!slots.length) return undefined;
    // Match full Refresh: ONE token preflight before the wave (#193 design
    // req 2). `runReadInto` leaves token freshness to the caller, so without
    // this each affected tile would independently race a rotating-token refresh
    // through authedFetch; a failed preflight issues no requests and drives
    // sign-out exactly once, exactly like Refresh.
    if (!(await app.ensureFreshToken())) { app.chCtx.onSignedOut(); return undefined; }
    const f = analysis.fields[name]; // the filter bar only renders analyzed params
    const affected = new Set(f.requiredIn.concat(f.optionalIn));
    const wave = prepareWave();
    const targets = panelFavorites.map((q, i) => i).filter((i) => affected.has(tileId(i)));
    // Same 6-way pool as full Refresh (#193 design req 7): a wide filter change
    // is bounded to TILE_CONCURRENCY concurrent reads, not an unbounded fan-out.
    return runPlan(planWave(targets, wave));
  }

  const runAll = async (): Promise<void> => {
    // Resolve (and refresh) the auth token ONCE up front. This both avoids N
    // tiles racing an expired-token refresh and lets a lost session redirect to
    // login exactly once — rather than each tile firing onSignedOut in parallel.
    if (!(await app.ensureFreshToken())) { app.chCtx.onSignedOut(); return; }
    refreshBtn.disabled = true;
    if (!slots.length) {
      // Build the grid from the structural layout items (#240): an ordinary
      // tile appends its own card; a KPI band builds one full-width container
      // and gives each of its member favorites a stable source slot inside its
      // shared stream, in favorite order. `slots` stays flat over panelFavorites
      // (the index space planWave/tileId/runAffected all key off), regardless
      // of which favorites share a band.
      slots = new Array<DashSlot>(panelFavorites.length);
      for (const item of layoutItems) {
        if (item.kind === 'tile') {
          const q = panelFavorites[item.index];
          const slot = buildTileSlot(q);
          slots[item.index] = slot;
          grid.appendChild(slot.card);
        } else {
          const band = buildKpiBand();
          for (const i of item.indices) {
            // `explicit` is cached on the slot once, here (structural build
            // time), so runPlan's dispatch reads `slot.explicit` on every later
            // wave instead of re-deriving it from `q` on every Refresh/filter run.
            // `!`: partitionKpiBands only groups indices whose favorite passed
            // isKpiPanel(explicitPanel(q)) above — the explicit panel is present.
            slots[i] = buildKpiSourceSlot(band, explicitPanel(panelFavorites[i])!, queryName(panelFavorites[i]));
          }
          grid.appendChild(band.el);
        }
      }
    }
    // Partition before execution (#166): text panels render right here —
    // synchronously, before any tile query is issued — and they never join
    // the wave below (zero queries for a text favorite).
    // `as`: a text favorite is never an explicit KPI (its cfg.type is 'text'),
    // so partitionKpiBands always made its slot an ordinary tile above.
    slots.forEach((s, i) => { if (isTextFav(panelFavorites[i])) renderTextSlot(app, panelFavorites[i], s as TileSlot); });
    // One prepared batch (and one wall-clock read) for the whole refresh wave;
    // reserve every query-backed slot's generation NOW (planWave), before the
    // pool starts, so a queued worker from an older Refresh discards itself.
    // runPlan marks every planned slot loading up front (queued tiles included).
    const reservedPlan = planWave(panelFavorites.map((q, i) => i), []);
    // try/finally so the button always re-enables and the timestamp always
    // updates — even if a tile render unexpectedly throws (runSlotTile itself
    // is total, so this is belt-and-suspenders against the pool rejecting).
    try {
      await runFilterWave();
      const wave = prepareWave();
      await runPlan(reservedPlan.map((item) => ({ ...item, src: wave[item.index] })));
    } finally {
      updated.textContent = 'Updated ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      refreshBtn.disabled = false;
    }
  };
  refreshBtn.onclick = runAll;
  return runAll();
}
