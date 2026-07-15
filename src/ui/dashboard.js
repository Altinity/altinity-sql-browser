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

import { h } from './dom.js';
import { Icon } from './icons.js';
import { renderResolvedPanel } from './panels.js';
import { schemaKey } from '../core/chart-data.js';
import { resolvePanel, autoPanel } from '../core/panel-cfg.js';
import {
  DASH_TILE_ROW_CAP, DASH_TILE_BYTE_CAP, DASH_TABLE_DISPLAY_CAP,
  activeDashboardView, dashboardViewSelection,
} from '../core/dashboard.js';
import { formatBytes, formatRows, detectSqlFormat } from '../core/format.js';
import { newResult } from '../core/stream.js';
import {
  analyzeParameterizedSources, prepareParameterizedBatch, mergedSourceArgs, mergedSourceSql, fieldControls,
} from '../core/param-pipeline.js';
import { hasOptionalBlocks } from '../core/optional-blocks.js';
import { effectiveFilterActive, KEYS } from '../state.js';
import { buildFilterBar } from './filter-bar.js';
import { queryDescription, queryFavorite, queryName, queryPanel } from '../core/saved-query.js';
import { isKpiPanel, panelExecution } from '../core/panel-execution.js';
import { effectiveDashboardRole } from '../core/result-choice.js';
import { filterExecution } from '../core/filter-execution.js';
import { readFilterOptions } from '../core/filter-options.js';
import { mergeDashboardFilterHelpers } from '../core/dashboard-filters.js';
import { diagnostic } from '../core/diagnostics.js';

// At most this many tile queries run at once, so a large favorites list doesn't
// fire a thundering herd of concurrent reads at ClickHouse (saturating the
// browser's per-host pool and the cluster) on open and on every Refresh.
const TILE_CONCURRENCY = 6;

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
function buildSeg(cls, options, getActive, onPick, ariaLabel) {
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
function tileFooter(meta) {
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
function dashboardTileResult(result, startedAt, finishedAt) {
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
async function runPool(items, limit, worker) {
  const results = new Array(items.length);
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
function buildTileSlot(q) {
  const body = h('div', { class: 'dash-tile-body' });
  const foot = h('div', { class: 'dash-tile-foot' });
  const name = queryName(q);
  const description = queryDescription(q);
  // Header: the favorite's name, plus its saved description as a subtitle when it
  // has one (single line, ellipsized) — mirrors the design mockup's tile header.
  const head = h('div', { class: 'dash-tile-head' },
    h('span', { class: 'dash-tile-name', title: name }, name));
  if (description) head.appendChild(h('div', { class: 'dash-tile-desc', title: description }, description));
  const card = h('div', { class: `dash-tile${isKpiPanel(queryPanel(q)) ? ' is-kpi' : ''}` }, head, body, foot);
  return {
    card, body, foot, gen: 0, status: null, destroy: null, panelState: null,
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
function supersedeSlot(slot) {
  const generation = ++slot.gen;
  if (slot.abortController) slot.abortController.abort();
  slot.abortController = null;
  return generation;
}

function destroySlotChart(slot) {
  if (slot.destroy) { slot.destroy(); slot.destroy = null; }
}

/** The favorite's explicit, known-typed panel payload, or null. Unknown types
 *  stay non-null-ish only through resolvePanel's diagnostic fallback below. */
function explicitPanel(q) {
  const panel = queryPanel(q);
  return panel && panel.cfg && typeof panel.cfg === 'object' ? panel : null;
}

/** True for a text panel — the no-query partition (#166). */
function isTextFav(q) {
  const p = explicitPanel(q);
  return !!p && p.cfg.type === 'text';
}

// Render a text favorite's tile: immediately, with zero queries — the #166
// partition runs this before any auth/SQL work.
function renderTextSlot(app, q, slot) {
  destroySlotChart(slot);
  slot.status = 'panel';
  slot.card.style.display = '';
  const { node } = renderResolvedPanel(app, resolvePanel(queryPanel(q), []), null,
    { surface: 'dashboard', state: {}, rerender: () => {}, readonly: true });
  slot.body.replaceChildren(node);
  slot.foot.replaceChildren();
}

function setSlotLoading(slot) {
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
function setSlotUnfilled(slot, names) {
  destroySlotChart(slot);
  slot.status = 'unfilled';
  slot.card.style.display = '';
  slot.body.replaceChildren(h('div', { class: 'dash-tile-unfilled' }, 'Enter a value for: ' + names.join(', ')));
  slot.foot.replaceChildren();
}

function applyTileResult(app, q, slot, r) {
  destroySlotChart(slot);
  if (r.error != null) {
    slot.status = 'error';
    slot.card.style.display = '';
    slot.body.replaceChildren(h('div', { class: 'dash-tile-error' }, r.error));
    slot.foot.replaceChildren();
    return;
  }
  const explicit = explicitPanel(q);
  // Unconfigured empty results remain skipped. An EXPLICIT panel never vanishes —
  // a zero-row one renders an honest "0 rows" state instead (visible, and
  // excluded from the header's skip tally).
  if (!explicit && r.rows.length === 0) {
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
  if (explicit && r.rows.length === 0 && !isKpiPanel(explicit)) {
    slot.body.replaceChildren(h('div', { class: 'dash-tile-empty' }, '0 rows'));
    slot.foot.replaceChildren(...tileFooter(r.meta));
    return;
  }
  // The one shared resolution (#166): the saved panel wins (mismatches retain
  // the type and re-derive roles; impossible shapes fall back with a
  // diagnostic), an unconfigured result goes through the autoPanel ladder.
  const resolved = explicit
    ? resolvePanel(explicit, { columns: r.columns, rows: r.rows, fieldConfig: explicit.fieldConfig, serverVersion: app.state.serverVersion })
    : { ...autoPanel({ columns: r.columns, rows: r.rows, serverVersion: app.state.serverVersion }), rederived: false, fallback: false };
  slot.card.classList.toggle('is-kpi', resolved.cfg.type === 'kpi');
  // Grid state persists across refreshes/filter edits on the stable slot,
  // keyed by result schema — a schema change resets it, a re-run keeps it.
  const key = schemaKey(r.columns);
  if (!slot.panelState || slot.panelState.key !== key) slot.panelState = { key };
  const res = { columns: r.columns, rows: r.rows };
  const paint = () => {
    destroySlotChart(slot);
    const out = renderResolvedPanel(app, resolved, res, {
      surface: 'dashboard',
      state: slot.panelState,
      rerender: paint, // header-click sorts re-paint locally — NO re-query
      readonly: true,
      cap: DASH_TABLE_DISPLAY_CAP,
      onCell: () => {},
    });
    slot.destroy = out.destroy || null;
    slot.body.replaceChildren(out.node);
  };
  paint();
  slot.foot.replaceChildren(...tileFooter(r.meta));
}

// Run (or re-run) one favorite's tile into its slot, gated by its prepared
// source from the wave's batch (#173): unfilled OR invalid (#170) `{name:Type}`
// values show the placeholder (never issuing a request — an invalid value left
// to reach the server would either error confusingly or, for Int/UInt, silently
// wrap; see param-validate.js), a per-source error (e.g. a value that can't
// serialize for this tile's declaration) shows an error card — blocking only
// this tile, never its siblings — otherwise stream the SQL read-only through the
// shared `app.runReadInto` seam (#193) and classify ONCE on completion.
// `onSettled()` fires after every transition (unfilled, errored or fetched) so
// the caller can recompute the live "N not shown" count.
//
// `generation` was reserved (and any prior in-flight request aborted) by
// `supersedeSlot` at WAVE CREATION (#193 design req 3), not here: a queued
// Refresh worker whose slot a newer wave has already re-reserved discards itself
// up front without issuing, and a supersede mid-stream aborts this request and
// makes the post-await guard drop it — so a stale wave can never overwrite a
// newer one, even under the 6-way pool's queueing.
async function runSlotTile(app, q, slot, onSettled, src, generation) {
  if (slot.gen !== generation) return; // a newer wave already superseded this queued tile
  if (src.missing.length || src.invalid.length) {
    setSlotUnfilled(slot, src.missing.concat(src.invalid));
    onSettled();
    return;
  }
  if (src.errors.length) {
    applyTileResult(app, q, slot, { error: src.errors[0] });
    onSettled();
    return;
  }
  // The wire text is the wave's materialized execution view (#165) — only when
  // the favorite actually is a template; block-free SQL keeps its exact bytes.
  const execSql = hasOptionalBlocks(q.sql) ? mergedSourceSql(src, q.sql) : q.sql;
  // #193 design req 5: the shared seam streams the structured
  // JSONStringsEachRowWithProgress format, so an explicit `FORMAT` clause would
  // silently corrupt the tile (an empty successful-looking result, or ignored
  // lines). Reject it with a clear error rather than mis-parse.
  const explicit = explicitPanel(q);
  const execution = panelExecution(explicit, execSql, {
    format: 'Table', rowLimit: DASH_TILE_ROW_CAP + 1,
    params: { readonly: 2, max_result_bytes: DASH_TILE_BYTE_CAP, ...mergedSourceArgs(src) },
  });
  if (execution.error || (!isKpiPanel(explicit) && detectSqlFormat(execSql))) {
    applyTileResult(app, q, slot, {
      error: execution.error || 'Dashboard panels require structured streaming results. Remove the explicit FORMAT clause.',
    });
    onSettled();
    return;
  }
  const label = setSlotLoading(slot);
  const ac = new AbortController();
  slot.abortController = ac;
  const startedAt = app.now();
  // Client row limit = CAP (newResult trims + flags `capped`); server cap =
  // CAP + 1 (the sentinel one past the client limit), so an exactly-CAP result
  // is NOT marked truncated and a >CAP result is trimmed AND flagged (#193 req 1).
  const result = newResult(execution.format, isKpiPanel(explicit) ? 2 : DASH_TILE_ROW_CAP);
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
  applyTileResult(app, q, slot, r);
  // #171: this tile completed (current generation) — record its bound params on
  // success only (the exact wave's boundParams snapshot, so a param confined to
  // an inactive optional block — never in `src.statements[*].boundParams` — is
  // never recorded). An errored tile records nothing.
  if (r.error == null) app.recordBoundParams(src.statements.flatMap((s) => s.boundParams));
  onSettled();
}

/** Render the dashboard into `app.root`. */
export function renderDashboard(app) {
  const { document: doc, state } = app;
  doc.documentElement.setAttribute('data-theme', state.theme);
  doc.documentElement.setAttribute('data-density', state.density);
  app.dom = {};

  const favorites = state.savedQueries.filter(queryFavorite);
  const panelFavorites = [];
  const filterFavorites = [];
  const roleDiagnostics = [];
  for (const query of favorites) {
    const role = effectiveDashboardRole(query.spec);
    if (role === 'panel') panelFavorites.push(query);
    else if (role === 'filter') filterFavorites.push(query);
    else if (role === 'setup') roleDiagnostics.push({ severity: 'warning', message: `${queryName(query)} uses Setup, which is not implemented yet.` });
    else roleDiagnostics.push({ severity: 'error', message: `${queryName(query)} has unknown Dashboard role "${role}".` });
  }

  // The favorites snapshot is fixed for this render, so the parameter analysis
  // (#173 phase 1 — structure only) runs once; each wave (runAll / a filter's
  // runAffected) prepares it against the current varValues with one wall-clock
  // read, and every tile gate + fetch of that wave reads the same batch.
  const tileId = (i) => 'tile:' + (panelFavorites[i].id || i);
  const analysis = analyzeParameterizedSources(panelFavorites.map((q, i) => ({
    id: tileId(i), label: queryName(q), kind: 'tile', sql: isTextFav(q) ? '' : q.sql, bindPolicy: 'row-returning',
  })));
  const prepareBatch = (validationMode = 'execute') => prepareParameterizedBatch(analysis, {
    values: Object.fromEntries(Object.entries(app.state.varValues).map(([name, value]) => [
      name, curatedFields?.[name] && !app.state.filterActive[name] ? '' : value,
    ])),
    active: effectiveFilterActive(app.state.varValues, app.state.filterActive),
    wallNowMs: app.wallNow(), validationMode,
  });
  const prepareWave = () => prepareBatch('execute').sources;
  // The filter bar's per-keystroke field-state read (#170): 'input' while
  // typing (neutral on a plausible prefix), 'execute' on blur/Enter (hardens).
  const getFilterField = (name, mode) => prepareBatch(mode).fields[name];

  const favChip = h('span', { class: 'dash-chip dash-fav' },
    Icon.star(true),
    h('span', null, favorites.length + (favorites.length === 1 ? ' favorite' : ' favorites')));
  const skipNote = h('span', { class: 'dash-skip', style: { display: 'none' } });
  const updated = h('span', { class: 'dash-updated' });
  const refreshBtn = h('button', { class: 'dash-btn', title: 'Re-run all tiles' },
    Icon.refresh(), h('span', null, 'Refresh'));
  // Theme toggle, mirroring the workbench header: reuse app.toggleTheme (persists
  // the pref + flips data-theme), and register the button as app.dom.themeBtn so
  // that helper repaints its icon on toggle.
  const themeBtn = h('button', { class: 'dash-icobtn', title: 'Toggle theme', onclick: () => app.toggleTheme() });
  themeBtn.appendChild(state.theme === 'dark' ? Icon.sun() : Icon.moon());
  app.dom.themeBtn = themeBtn;

  const header = h('div', { class: 'dash-header' },
    h('a', { class: 'dash-back', href: app.basePath || '/sql', title: 'Back to SQL Browser' },
      Icon.arrow(), h('span', null, 'SQL Browser')),
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
      state.dashLayout = sel.dashLayout;
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
  let curatedFields = state.filterCurated || {};
  const filterHost = h('div', { class: 'dash-filter-host' });
  const filterDiagnosticsHost = h('div', { class: 'dash-filter-diagnostics' });
  const renderFilterBar = () => filterHost.replaceChildren(buildFilterBar(
    app, controls, (name) => runAffected(name), getFilterField, { curatedFields },
  ));
  renderFilterBar();
  // The toolbar is flex-start (default), so layoutWrap + filterBar pack left as
  // the issue specifies — no trailing spacer needed now the right-aligned
  // Columns control is gone (#184).
  const toolbar = h('div', { class: 'dash-toolbar' }, layoutWrap, filterHost);
  apply();

  // #root is a fixed, overflow:hidden flex column (the workbench layout), so the
  // dashboard needs its own scroll container — otherwise a tall grid clips with
  // no vertical scroll. The header + toolbar share one sticky top bar inside it.
  app.root.replaceChildren(h('div', { class: 'dash-page' },
    h('div', { class: 'dash-topbar' }, header, toolbar),
    ...roleDiagnostics.map((item) => h('div', { class: `dash-config-diagnostic is-${item.severity}` }, item.message)),
    filterDiagnosticsHost, empty, grid));

  // One stable slot per favorite (favorite order), built lazily on the first
  // successful run (below) and reused for the tab's lifetime — a filter edit
  // or Refresh updates a slot's contents/visibility in place rather than
  // inserting/removing grid children (see buildTileSlot).
  let slots = [];
  // Filter sources reuse the SAME generation/abort guard tile slots use
  // (supersedeSlot / `slot.gen`, #237) — a second consumer of the stale-wave
  // pattern gets the existing primitive, not a re-implementation. `gen` is
  // reserved at wave-creation time (see runFilterWave), so a queued worker from
  // an older wave sees `slot.gen !== generation` and discards itself.
  const filterSlots = new Map(filterFavorites.map((query) => [query.id, {
    gen: 0, abortController: null, status: 'idle', lastProvider: null,
  }]));

  async function runFilterSource(query, slot, generation) {
    const execution = filterExecution(query.sql);
    if (execution.error) {
      const provider = {
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
    await app.runReadInto(result, {
      sql: query.sql, format: execution.format, rowLimit: execution.rowLimit,
      params: execution.params, signal: ac.signal,
    });
    if (slot.gen !== generation) return null;
    slot.abortController = null;
    let provider;
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

  const renderFilterDiagnostics = (diagnostics) => {
    filterDiagnosticsHost.replaceChildren(...diagnostics.map((item) => {
      const retry = item.code === 'filter-query-failed' && item.sourceId
        ? h('button', { type: 'button', onclick: () => retryFilter(item.sourceId) }, 'Retry')
        : null;
      return h('div', { class: `dash-config-diagnostic is-${item.severity}` }, item.message, retry);
    }));
  };

  const applyFilterProviders = (providers) => {
    const merged = mergeDashboardFilterHelpers({
      providers: providers.filter(Boolean), controls,
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

  async function runFilterWave() {
    const plan = filterFavorites.map((query) => {
      const slot = filterSlots.get(query.id);
      return { query, slot, generation: supersedeSlot(slot) };
    });
    const providers = await runPool(plan, TILE_CONCURRENCY,
      ({ query, slot, generation }) => runFilterSource(query, slot, generation));
    return applyFilterProviders(providers);
  }

  async function retryFilter(sourceId) {
    const query = filterFavorites.find((item) => item.id === sourceId);
    const slot = filterSlots.get(sourceId);
    if (!query || !slot) return;
    if (!(await app.ensureFreshToken())) { app.chCtx.onSignedOut(); return; }
    await runFilterSource(query, slot, supersedeSlot(slot));
    const merged = applyFilterProviders(filterFavorites.map((item) => filterSlots.get(item.id).lastProvider));
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
  const planWave = (indices, wave) => indices
    .filter((i) => !isTextFav(panelFavorites[i]))
    .map((i) => ({ index: i, q: panelFavorites[i], slot: slots[i], src: wave[i], generation: supersedeSlot(slots[i]) }));

  const runPlan = (plan) => {
    // Mark every planned slot loading up front — before the 6-way pool starts —
    // so tiles beyond TILE_CONCURRENCY's window don't linger on stale content
    // while queued. Applies to BOTH full Refresh and targeted affected waves
    // (#193); runSlotTile re-marks its own slot loading when its worker starts
    // (capturing the progress label), so filled tiles simply repaint identically.
    plan.forEach(({ slot }) => setSlotLoading(slot));
    return runPool(plan, TILE_CONCURRENCY,
      ({ q, slot, src, generation }) => runSlotTile(app, q, slot, updateSkipNote, src, generation));
  };

  // Re-run only the favorites whose SQL references `name` (a filter field's
  // debounced/committed edit, #149 D3) — not the whole grid. Affected-source
  // detection comes from the analysis (#173): `optionalIn` keeps a tile
  // affected even while the param's optional blocks are inactive (#165), so an
  // activation flip re-runs it exactly like a value change. A no-op before
  // the first successful run (slots not built yet).
  async function runAffected(name) {
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

  const runAll = async () => {
    // Resolve (and refresh) the auth token ONCE up front. This both avoids N
    // tiles racing an expired-token refresh and lets a lost session redirect to
    // login exactly once — rather than each tile firing onSignedOut in parallel.
    if (!(await app.ensureFreshToken())) { app.chCtx.onSignedOut(); return; }
    refreshBtn.disabled = true;
    if (!slots.length) {
      slots = panelFavorites.map((q) => buildTileSlot(q));
      slots.forEach((s) => grid.appendChild(s.card));
    }
    // Partition before execution (#166): text panels render right here —
    // synchronously, before any tile query is issued — and they never join
    // the wave below (zero queries for a text favorite).
    slots.forEach((s, i) => { if (isTextFav(panelFavorites[i])) renderTextSlot(app, panelFavorites[i], s); });
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
