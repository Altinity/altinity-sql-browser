// The standalone read-only Dashboard page (#149 D1–D3, #166). Render module
// over the `app` controller: it builds a header + a grid of tiles, one per
// favorited Library query (a snapshot taken when the tab opens — Refresh
// re-runs the data, it does not re-scan the Library). Favorites are
// PARTITIONED BEFORE EXECUTION (#166): a text panel renders immediately with
// zero queries; everything else streams its SQL read-only through the shared
// `app.exec.executeRead` seam (#193/#276 — full streaming transport, server-side row cap,
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
//
// #276 Phase 3b: the tile/filter execution runtime (wave generations,
// per-slot cancellation, the 6-way pool, filter-source waves) is extracted
// into `DashboardSession` (`./dashboard/dashboard-session.ts`), constructed
// here and driven through an injected `DashboardSessionHooks` bag. This
// module stays the shell: it owns every DOM write (tile/KPI-source/filter-bar
// state transitions), lazy slot/grid construction, and the `App`-typed glue
// the session must never see (issue #276 rule 1 — the session never touches
// `App`; `build/check-boundaries.mjs` keeps `src/ui/dashboard/**` off
// `src/ui/workbench/**`/`src/editor/**`).

import { h } from './dom.js';
import { Icon as IconUntyped } from './icons.js';
import { renderResolvedPanel } from './panels.js';
import { schemaKey as schemaKeyUntyped } from '../core/chart-data.js';
import { resolvePanel } from '../core/panel-cfg.js';
import type { Column } from '../core/panel-cfg.js';
import {
  DASH_TILE_ROW_CAP, DASH_TABLE_DISPLAY_CAP,
  activeDashboardView, dashboardViewSelection, partitionKpiBands,
} from '../core/dashboard.js';
import {
  formatBytes as formatBytesUntyped, formatRows as formatRowsUntyped,
} from '../core/format.js';
import { queryDescription, queryFavorite, queryName, queryPanel } from '../core/saved-query.js';
import { explicitPanel, isKpiPanel } from '../core/panel-execution.js';
import { effectiveDashboardRole } from '../core/result-choice.js';
import { KEYS } from '../state.js';
import { buildFilterBar as buildFilterBarUntyped } from './filter-bar.js';
import type { FieldControl, PreparedFieldState, ValidationMode } from '../core/param-pipeline.js';
import type { FilterDiagnostic } from '../core/dashboard-filters.js';
import {
  buildKpiBand, buildKpiSourceSlot, setKpiSourceLoading, setKpiSourceUnfilled, applyKpiSourceResult,
  refreshBandWarnings,
} from './dashboard-kpi-band.js';
import { createDashboardSession } from './dashboard/dashboard-session.js';
import type {
  DashboardSession, DashboardSessionDeps, DashboardSessionHooks, TileDomHooks, KpiSourceDomHooks,
  TileSlot, DashSlot, TileResultMeta, FavoriteSourceResult,
} from './dashboard/dashboard-session.js';
import type { SavedQueryV2 } from '../generated/json-schema.types.js';
import type { App } from './app.types.js';

// ── Typed wrappers over still-untyped .js dependencies ──────────────────────
// Each const/overload pins exactly the signature this module relies on,
// verified against the wrapped function body; the runtime module stays `.js`
// until its own leaf-up conversion (ADR-0002) — same convention as panels.ts /
// state.ts / core/panel-execution.ts. (dom.ts and diagnostics.ts are already
// typed — see their own `h<K extends keyof HTMLElementTagNameMap>` overload
// and `diagnostic()` factory, imported directly above.)

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

// format.js is unconverted — formatRows/formatBytes render '—' for
// null/NaN and compact human-readable text otherwise.
const formatRows: (n: number | null | undefined) => string = formatRowsUntyped;
const formatBytes: (n: number | null | undefined) => string = formatBytesUntyped;

// chart-data.js is unconverted — the same wrapper panels.ts pins for schemaKey.
const schemaKey: (columns: Column[] | null | undefined) => string = schemaKeyUntyped;

// filter-bar.js is unconverted — buildFilterBar(app, params, onCommit,
// getField, options) builds one field per `fieldControls` entry, reading the
// shared varValues/filterActive state off `app`; `curatedFields` entries are
// consumed structurally inside it, so the bag stays unknown-valued here.
// Returns `{ el, dispose }` (#276 Phase 3b filter-bar dispose seam): `dispose`
// clears every field's pending debounce timer — the caller must dispose the
// previous bar before building a new one, and on teardown.
const buildFilterBar: (
  app: App,
  params: FieldControl[],
  onCommit: (name: string) => void,
  getField: (name: string, mode: ValidationMode) => PreparedFieldState,
  options?: { curatedFields?: Record<string, unknown>; document?: Document; ariaLabel?: string },
) => { el: HTMLElement; dispose(): void } = buildFilterBarUntyped;

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
type SegOption = [value: string, label: string, title?: string];
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

function destroySlotChart(slot: TileSlot): void {
  if (slot.destroy) { slot.destroy(); slot.destroy = null; }
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

// Streamed row progress (#193 design req 4): shared by both the tile and
// KPI-source hook bags — both slot kinds carry the same `loadLabel` field, the
// live text node `setSlotLoading`/`setKpiSourceLoading` parked on the slot.
function setSlotProgress(slot: { loadLabel: HTMLElement | null }, text: string): void {
  if (slot.loadLabel) slot.loadLabel.textContent = text;
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
      class: 'dash-back', href: app.conn.basePath || '/sql', title: 'Back to SQL Browser',
      'aria-label': 'Back to SQL Browser',
    }, Icon.arrow(), h('span', { class: 'dash-back-label' }, 'SQL Browser')),
    h('div', { class: 'dash-title' }, state.libraryName.value),
    favChip,
    skipNote,
    h('div', { class: 'dash-spacer', style: { flex: '1' } }),
    h('span', { class: 'dash-chip dash-src', title: app.conn.host() },
      h('span', { class: 'dash-dot' }), app.conn.host()),
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
      app.prefs.save('dashLayout', sel.dashLayout);
    }
    if (sel.dashCols != null && sel.dashCols !== state.dashCols) {
      state.dashCols = sel.dashCols;
      app.prefs.save('dashCols', sel.dashCols);
    }
    apply();
  }, 'Dashboard layout');
  const layoutWrap = h('div', { class: 'dash-layout-wrap' },
    h('span', { class: 'dash-seg-label' }, 'Layout'), layoutSeg.el);

  const filterHost = h('div', { class: 'dash-filter-host' });
  const filterDiagnosticsHost = h('div', { class: 'dash-filter-diagnostics' });

  // The route session this render drives — constructed below, once its hooks
  // are wired. `renderFilterBar`/`renderFilterDiagnostics` close over it (only
  // ever CALLED once construction below has completed, so the forward
  // reference is safe — the same shell↔session wiring pattern
  // `WorkbenchSession`'s `attachShell` uses).
  let session!: DashboardSession;

  // Rebuild the filter bar with the current curated-field bundle, disposing
  // the previous bar's pending debounce timers first (#276 Phase 3b filter-bar
  // dispose seam — closes the orphan-timer gap a bare rebuild used to leave).
  // `disposeCurrentFilterBar` is also handed to the session as its
  // `disposeFilterBar` hook (destroy()'s own teardown) — the SAME function,
  // not a second closure, so its one line of teardown logic isn't duplicated.
  let filterBarDispose: (() => void) | null = null;
  const disposeCurrentFilterBar = (): void => { filterBarDispose?.(); };
  const renderFilterBar = (curatedFields: Record<string, unknown>): void => {
    disposeCurrentFilterBar();
    const bar = buildFilterBar(app, session.controls, (name) => session.runAffected(name), session.getFilterField, { curatedFields });
    filterHost.replaceChildren(bar.el);
    filterBarDispose = bar.dispose;
  };

  const renderFilterDiagnostics = (diagnostics: FilterDiagnostic[]): void => {
    filterDiagnosticsHost.replaceChildren(...diagnostics.map((item) => {
      // `as`: `sourceId` reaches FilterDiagnostic only through its open index
      // signature (`unknown`), but every 'filter-query-failed' diagnostic is
      // minted in the session's runFilterSource with `sourceId: query.id` (a
      // string).
      const retry = item.code === 'filter-query-failed' && item.sourceId
        ? h('button', { type: 'button', onclick: () => session.retryFilter(item.sourceId as string) }, 'Retry')
        : null;
      return h('div', { class: `dash-config-diagnostic is-${item.severity}` }, item.message, retry);
    }));
  };

  // Build the grid's slot array once, lazily, on the first successful wave
  // (#276 Phase 3b: lazy slot/DOM construction stays shell-side — the session
  // only reserves/aborts generations on whatever slots it's handed). An
  // ordinary tile appends its own card; a KPI band builds one full-width
  // container and gives each of its member favorites a stable source slot
  // inside its shared stream, in favorite order. The returned array stays flat
  // over panelFavorites (the index space the session's planWave/tileId/
  // runAffected all key off), regardless of which favorites share a band.
  const ensureSlotsBuilt = (): DashSlot[] => {
    const built = new Array<DashSlot>(panelFavorites.length);
    for (const item of layoutItems) {
      if (item.kind === 'tile') {
        const q = panelFavorites[item.index];
        const slot = buildTileSlot(q);
        built[item.index] = slot;
        grid.appendChild(slot.card);
      } else {
        const band = buildKpiBand();
        for (const i of item.indices) {
          // `explicit` is cached on the slot once, here (structural build
          // time), so the session's dispatch reads `slot.explicit` on every
          // later wave instead of re-deriving it from `q` on every
          // Refresh/filter run. `!`: partitionKpiBands only groups indices
          // whose favorite passed isKpiPanel(explicitPanel(q)) above — the
          // explicit panel is present.
          built[i] = buildKpiSourceSlot(band, explicitPanel(panelFavorites[i])!, queryName(panelFavorites[i]));
        }
        grid.appendChild(band.el);
      }
    }
    return built;
  };

  const tileHooks: TileDomHooks = {
    setUnfilled: setSlotUnfilled,
    setLoading: setSlotLoading,
    onProgress: setSlotProgress,
    applyResult: (q, slot, r) => applyTileResult(app, q, slot, r),
    renderText: (q, slot) => renderTextSlot(app, q, slot),
  };
  const kpiHooks: KpiSourceDomHooks = {
    setUnfilled: setKpiSourceUnfilled,
    setLoading: setKpiSourceLoading,
    onProgress: setSlotProgress,
    applyResult: (explicit, slot, r) => applyKpiSourceResult(app, explicit, slot, r),
    refreshBandWarnings,
  };

  const hooks: DashboardSessionHooks = {
    tile: tileHooks,
    kpi: kpiHooks,
    ensureSlotsBuilt,
    renderFilterBar,
    renderFilterDiagnostics,
    updateSkipNote: (skipped) => {
      if (skipped) {
        skipNote.style.display = '';
        skipNote.textContent = skipped + ' not shown';
        skipNote.title = skipped + ' empty favorite(s) with no panel to render.';
      } else {
        skipNote.style.display = 'none';
      }
    },
    disposeFilterBar: disposeCurrentFilterBar,
    onAuthFailed: () => { app.conn.chCtx.onSignedOut(); },
    onRunAllStart: () => { refreshBtn.disabled = true; },
    onRunAllSettled: () => {
      updated.textContent = 'Updated ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      refreshBtn.disabled = false;
    },
  };

  // Seed from the persisted last-known curated-filter bundle (#234) so a
  // curated field paints as the combobox immediately instead of flashing
  // plain text for one frame before the first Filter wave resolves; the live
  // wave (inside the session) replaces it thereafter.
  const filterCuratedSeed: Record<string, unknown> = state.filterCurated || {};
  const deps: DashboardSessionDeps = {
    exec: app.exec,
    ensureFreshToken: () => app.conn.ensureFreshToken(),
    now: () => app.now(),
    wallNow: () => app.wallNow(),
    recordBoundParams: (bp) => app.params.recordBoundParams(bp),
    varValues: () => app.state.varValues,
    filterActive: () => app.state.filterActive,
    filterCuratedSeed,
    persistFilterCurated: (fields) => {
      state.filterCurated = fields;
      app.saveJSON(KEYS.filterCurated, fields);
    },
    persistFilterActive: (active) => {
      state.filterActive = active;
      app.params.saveFilterActive();
    },
    hooks,
  };
  session = createDashboardSession(deps, { panelFavorites, filterFavorites });

  renderFilterBar(filterCuratedSeed);
  // The toolbar is flex-start (default), so layoutWrap + filterBar pack left as
  // the issue specifies — no trailing spacer needed now the right-aligned
  // Columns control is gone (#184).
  const toolbar = h('div', {
    class: 'dash-toolbar' + (session.controls.length ? ' has-filters' : ''),
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

  refreshBtn.onclick = session.runAll;
  return session.runAll();
}
