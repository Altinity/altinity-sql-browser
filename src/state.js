// Application state: a plain object plus pure operations over it. Persistence
// is injected as a `save(key, value)` function (defaulting to storage.js), so
// every operation is unit-testable with a spy and no real localStorage.

import { clamp } from './core/format.js';
import { mergeSaved } from './core/saved-io.js';
import { cloneChartCfg } from './core/chart-data.js';
import { normalizeDashLayout, normalizeDashCols } from './core/dashboard.js';
import { loadJSON, saveJSON, loadStr, saveStr } from './core/storage.js';
import { emptyRecentMap } from './core/recent-values.js';
import { signal } from '@preact/signals-core';

/** A tab's chart state as a persistable payload `{ cfg, key }`, or null. */
export function tabChart(tab) {
  return tab && tab.chartCfg ? { cfg: cloneChartCfg(tab.chartCfg), key: tab.chartKey ?? null } : null;
}

/** Result views a saved query can remember (a raw FORMAT-clause view is transient). */
export const SAVED_VIEWS = new Set(['table', 'json', 'chart']);

export const KEYS = {
  theme: 'asb:theme',
  sidebarPx: 'asb:sidebarPx',
  editorPct: 'asb:editorPct',
  sideSplitPct: 'asb:sideSplitPct',
  cellDrawerPx: 'asb:cellDrawerPx',
  sidePanel: 'asb:sidePanel',
  saved: 'asb:saved',
  history: 'asb:history',
  libraryName: 'asb:libraryName',
  resultRowLimit: 'asb:resultRowLimit',
  varValues: 'asb:varValues',
  filterActive: 'asb:filterActive',
  dashLayout: 'asb:dashLayout',
  dashCols: 'asb:dashCols',
  varRecent: 'asb:varRecent',
  varRecentDisabled: 'asb:varRecentDisabled',
};

/** Row-limit options for the result cap selector (shared between state + UI). */
export const RESULT_ROW_LIMIT_OPTIONS = [100, 500, 1000, 5000, 10000];

/** Default row cap when none is persisted (or a stored value is unrecognized). */
export const DEFAULT_RESULT_ROW_LIMIT = 500;

/** Snap a row-limit to a known option, falling back to the default. Pure. */
export function normalizeRowLimit(n) {
  return RESULT_ROW_LIMIT_OPTIONS.includes(n) ? n : DEFAULT_RESULT_ROW_LIMIT;
}

/** Default name for a fresh / unnamed saved-query library. */
export const DEFAULT_LIBRARY_NAME = 'SQL Library';

/**
 * Viewport width (px) at/below which the shell drops into best-effort mobile
 * mode (#126) — a single value, not a range, so the CSS/JS branching stays
 * unambiguous. The matching CSS lives in a `@media (max-width: 768px)` block in
 * styles.css; keep the two literals in sync. app.js wires an injected
 * `matchMedia('(max-width: <this>px)')` listener that drives `isMobile`.
 */
export const MOBILE_BREAKPOINT_PX = 768;

/** A blank query tab. `chartCfg`/`chartKey` hold the per-tab chart config and
 * the schema signature it was derived for (re-derived when the schema changes). */
export function newTabObj(id) {
  return { id, name: 'Untitled', sql: '', dirty: false, result: null, savedId: null, chartCfg: null, chartKey: null };
}

/**
 * Build the initial state, reading persisted prefs through `read` (an object
 * with loadJSON/loadStr, defaulting to storage.js over localStorage).
 */
export function createState(read = { loadJSON, loadStr }) {
  const num = (key, dflt, lo, hi) => clamp(parseFloat(read.loadStr(key, String(dflt))), lo, hi);
  return {
    nextTabId: 2,
    theme: read.loadStr(KEYS.theme, 'light'),
    density: 'comfortable',
    // Global cap on how many rows a normal SELECT fetches (server-side
    // max_result_rows + a client-side guard; see runQuery / applyStreamLine).
    // One persisted preference, default 500; a non-option stored value snaps
    // back to the default so the selector always reflects a real choice.
    resultRowLimit: normalizeRowLimit(parseInt(read.loadStr(KEYS.resultRowLimit, '500'), 10)),
    // Dashboard layout prefs (#149 D2), persisted per browser. Plain (non-signal)
    // like theme/density — the standalone dashboard page reads them at build time
    // and mutates + re-saves on the Arrange/Report + column-count controls.
    dashLayout: normalizeDashLayout(read.loadStr(KEYS.dashLayout, 'arrange')),
    dashCols: normalizeDashCols(parseInt(read.loadStr(KEYS.dashCols, '3'), 10)),
    sidebarPx: clamp(parseInt(read.loadStr(KEYS.sidebarPx, '248'), 10), 180, 420),
    editorPct: num(KEYS.editorPct, 45, 15, 85),
    sideSplitPct: num(KEYS.sideSplitPct, 58, 25, 85),
    // Cell-detail / rows-viewer drawer width (issue #101). The 92vw upper
    // bound depends on the live viewport, not this load-time default, so only
    // the floor is enforced here — clampDrawerWidth (splitters.js) applies the
    // full [320, 92vw] clamp whenever the drawer is opened or resized.
    cellDrawerPx: clamp(parseInt(read.loadStr(KEYS.cellDrawerPx, '560'), 10), 320, Infinity),
    // Reactive (signals): mutating these drives repaints via effects in
    // createApp — no manual refresh() list to keep in sync. Read/write through
    // `.value`. tabs/activeTabId drive renderTabs + the editor + the save button;
    // the results pane + Run button react to resultView/running (below).
    tabs: signal([newTabObj('t1')]),
    activeTabId: signal('t1'),
    // Schema panel (signals): the tree repaints via an effect in createApp that
    // reads these (no manual renderSchema list). `schema` is the db→table array;
    // each `tb.columns` is a lazily-loaded completion cache replaced by reference
    // (see loadColumns) — never mutated in place. `expanded` is a Set of expand
    // keys ('db:'+name / 'tb:'+db.table) replaced copy-on-write. Read/write via
    // `.value`. (The 'db:'/'tb:' prefixes mirror the dbl-click tracker's keys in
    // schema.js — a separate store, not shared state.)
    schema: signal(null),
    schemaError: signal(null),
    schemaFilter: signal(''),
    expanded: signal(new Set()),
    // The last schemaError text the user dismissed from the auth banner
    // (updateBanner, in app.js) — re-shown only if a *different* error occurs.
    // Session-only, never persisted.
    bannerDismissedFor: signal(null),
    serverVersion: null,
    // Run state (signals): `running` flips the Run button + results pane via
    // effects; `resultView` is the active Table/JSON/Chart tab. Via `.value`.
    running: signal(false),
    abortController: null,
    // In-flight schema-lineage fetch (issue #124's inline drawer graph) — its own
    // AbortController, separate from `abortController` (run/script) and the
    // export controllers, since a graph fetch isn't gated by `running` and a
    // second click/drag must be able to supersede an in-flight one.
    schemaGraphAbortController: null,
    resultView: signal('table'),
    // True while a streaming Export (issue #87) is in flight — separate from
    // `running` (the grid run) so an export and a grid run never clobber each
    // other's button/cancel state.
    exporting: signal(false),
    // Count of currently-open detached views (issue #100) — a schema/pipeline
    // graph or Data Pane grid, each opened either as a real browser tab or an
    // in-app overlay fallback. A count (not a bool) so several can be open at
    // once without one's close() clobbering the others' "is anything open"
    // signal. Via `.value`.
    detachedView: signal(0),
    // True while the editor has a non-empty (non-whitespace) text selection, so
    // ⌘+Enter / Run target just that text. Drives the Run button's
    // "Run" ↔ "Run selection" label (an effect in createApp). Via `.value`.
    hasSelection: signal(false),
    // `forceExplain` is set by the Explain button to put an ordinary query into
    // EXPLAIN-view mode; a normal Run clears it (session-only). The active view is
    // derived per-run from the typed statement / clicked tab, not stored here.
    forceExplain: false,
    resultSort: { col: null, dir: 'asc' },
    // Entered values for `{name:Type}` query parameters (#134), keyed by variable
    // name and shared across every tab/query, so a value typed once is reused
    // wherever the same variable appears. Persisted (asb:varValues) so it also
    // survives reloads. A plain object, mutated in place + re-saved by app.js.
    varValues: read.loadJSON(KEYS.varValues, {}),
    // Explicit filter activation for optional SQL blocks (#165), keyed by
    // param name and shared/persisted exactly like varValues (its own key;
    // never carried in share links — varValues aren't either). true ⇒ the
    // param's optional blocks are included; false ⇒ omitted, whatever dormant
    // value varValues still holds. Text controls keep it in sync with the
    // value (blank ⇒ false, typed ⇒ true); a name with no entry derives its
    // activation from the stored value (effectiveFilterActive below), so
    // pre-#165 persisted values keep working on first load.
    filterActive: read.loadJSON(KEYS.filterActive, {}),
    // Per-variable MRU recent-value history (#171): recorded from a
    // successful statement's `boundParams` (#173's immutable snapshots) —
    // never from a keystroke — keyed by variable name and shared/persisted
    // exactly like varValues (its own key; never carried in share links).
    // See core/recent-values.js for the shape and its pure ops.
    varRecent: read.loadJSON(KEYS.varRecent, emptyRecentMap()),
    // Disable-history preference (#171, "settings"): when true, new values
    // stop being recorded but existing history is retained until explicitly
    // cleared (Clear all recent values / per-field Clear recent).
    varRecentDisabled: read.loadJSON(KEYS.varRecentDisabled, false),
    sidePanel: signal(read.loadStr(KEYS.sidePanel, 'saved')),
    savedQueries: read.loadJSON(KEYS.saved, []),
    // Which saved row (if any) is showing its inline edit form (saved-history.js).
    // Session-only, never persisted.
    editingSavedId: signal(null),
    history: read.loadJSON(KEYS.history, []),
    // The saved-query collection treated as a named document ("the Library").
    // Signals: the header title (name + unsaved-changes dot) repaints via an
    // effect that reads these. `libraryName` is persisted; `libraryDirty`
    // (unsaved changes since the last file Save/Replace/New) is session-only and
    // resets on reload. Read/write via `.value`.
    libraryName: signal(read.loadStr(KEYS.libraryName, DEFAULT_LIBRARY_NAME)),
    libraryDirty: signal(false),
    // Transient search text for the Library/History side panel (session-only,
    // cleared on a tab switch); never persisted.
    libraryFilter: '',
    // Whether the keyboard-shortcuts modal is open (shortcuts.js). Session-only;
    // a signal for consistency with the rest of the state (no reactive reader
    // today — shortcuts.js drives its own mount/unmount).
    shortcutsOpen: signal(false),
    // Best-effort mobile mode (#126). `isMobile` mirrors the viewport width
    // against MOBILE_BREAKPOINT_PX — set once and on `change` by app.js's
    // injected matchMedia listener. Read by the schema tree (to drop
    // touch-useless drag/hover affordances) and the results drop target.
    // `mobileView` is the bottom-tab-nav's active full-screen panel and
    // `mobileTab` the Tables view's Schema|Library segmented choice (a separate
    // axis from `sidePanel`, which still drives the saved-pane's own
    // Library/History sub-tabs). All session-only, never persisted; a no-op
    // above the breakpoint (the CSS only reads them there). Via `.value`.
    isMobile: signal(false),
    mobileView: signal('editor'),
    mobileTab: signal('schema'),
  };
}

/** The currently-active tab object (falls back to the first tab). */
export function activeTab(state) {
  return state.tabs.value.find((t) => t.id === state.activeTabId.value) || state.tabs.value[0];
}

/**
 * The effective optional-block activation map (#165) the parameter pipeline
 * consumes: an explicit `filterActive` entry wins; a param with no entry
 * derives activation from its stored value (non-empty ⇒ active), so persisted
 * pre-#165 varValues keep working on first load — and a first load with
 * neither entry defaults to inactive without throwing. Pure.
 * @param {Object<string, any>} [values] state.varValues
 * @param {Object<string, boolean>} [filterActive] state.filterActive
 * @returns {Object<string, boolean>}
 */
export function effectiveFilterActive(values = {}, filterActive = {}) {
  const out = {};
  for (const [name, v] of Object.entries(values)) out[name] = v != null && v !== '';
  for (const [name, a] of Object.entries(filterActive)) out[name] = !!a;
  return out;
}

/** Allocate a new tab id ('t2', 't3', ...). */
export function allocTabId(state) {
  return 't' + state.nextTabId++;
}

const rnd = () => Math.random().toString(36).slice(2, 6);
const makeId = (prefix, now) => prefix + now + rnd();
const tabsForSaved = (state, id) => state.tabs.value.filter((t) => t.savedId === id);

/** The saved query a tab is linked to (via tab.savedId), or null. */
export function savedForTab(state, tab) {
  return (tab && tab.savedId && state.savedQueries.find((q) => q.id === tab.savedId)) || null;
}

/**
 * Save the tab's SQL under `name` (+ an optional free-text `description`). If
 * the tab is already linked to a saved entry, update that entry in place;
 * otherwise create a new one (newest first) and link the tab to it. The tab's
 * name mirrors the saved name. Returns the saved entry, or null for empty
 * SQL/name.
 */
export function saveQuery(state, tab, name, description, save = saveJSON, now = Date.now()) {
  const sql = String(tab.sql || '').trim();
  const nm = String(name || '').trim();
  if (!sql || !nm) return null;
  const desc = String(description || '').trim();
  const chart = tabChart(tab);
  // Remember the current result view (Table/JSON/Chart) so a restore reopens the
  // same data representation; the transient raw view isn't persisted.
  const view = SAVED_VIEWS.has(state.resultView.value) ? state.resultView.value : undefined;
  let entry = savedForTab(state, tab);
  if (entry) {
    entry.name = nm;
    entry.sql = sql;
    if (desc) entry.description = desc; else delete entry.description;
    if (chart) entry.chart = chart; else delete entry.chart;
    if (view) entry.view = view; else delete entry.view;
  } else {
    entry = { id: makeId('s', now), name: nm, sql, favorite: false };
    if (desc) entry.description = desc;
    if (chart) entry.chart = chart;
    if (view) entry.view = view;
    state.savedQueries.unshift(entry);
    tab.savedId = entry.id;
  }
  tab.name = nm;
  state.libraryDirty.value = true;
  save(KEYS.saved, state.savedQueries);
  return entry;
}

/**
 * Rename a saved query, keeping any linked tab's name in sync. When
 * `description` is provided (not undefined) it is set/cleared too; pass
 * undefined to leave the existing description untouched (name-only rename).
 */
export function renameSaved(state, id, name, description, save = saveJSON) {
  const nm = String(name || '').trim();
  const entry = state.savedQueries.find((q) => q.id === id);
  if (!entry || !nm) return;
  entry.name = nm;
  if (description !== undefined) {
    const desc = String(description || '').trim(); // match saveQuery: null/non-string → '' → cleared
    if (desc) entry.description = desc; else delete entry.description;
  }
  for (const t of tabsForSaved(state, id)) t.name = nm;
  state.libraryDirty.value = true;
  save(KEYS.saved, state.savedQueries);
}

/** Toggle a saved query's favorite flag. */
export function toggleFavorite(state, id, save = saveJSON) {
  const entry = state.savedQueries.find((q) => q.id === id);
  if (!entry) return;
  entry.favorite = !entry.favorite;
  state.libraryDirty.value = true;
  save(KEYS.saved, state.savedQueries);
}

/** Saved queries with favorites first (stable within each group). */
export function sortedSaved(state) {
  return state.savedQueries
    .map((q, i) => [q, i])
    .sort((a, b) => (b[0].favorite ? 1 : 0) - (a[0].favorite ? 1 : 0) || a[1] - b[1])
    .map(([q]) => q);
}

/**
 * Filter saved queries by a free-text query (case-insensitive substring over
 * name, description and SQL). Blank query → the list returned unchanged. Pure.
 */
export function filterSaved(list, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return list;
  return list.filter((it) =>
    (it.name || '').toLowerCase().includes(q) ||
    (it.description || '').toLowerCase().includes(q) ||
    (it.sql || '').toLowerCase().includes(q));
}

/** Filter history entries by a free-text query (case-insensitive over SQL). Pure. */
export function filterHistory(list, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return list;
  return list.filter((ent) => (ent.sql || '').toLowerCase().includes(q));
}

/**
 * Merge imported queries into savedQueries (dedupe by content, update by id,
 * else add). Returns { added, updated, skipped }.
 */
export function importSaved(state, queries, save = saveJSON, genId = () => makeId('s', Date.now())) {
  const { merged, added, updated, skipped } = mergeSaved(state.savedQueries, queries, genId);
  state.savedQueries = merged;
  state.libraryDirty.value = true;
  save(KEYS.saved, state.savedQueries);
  return { added, updated, skipped };
}

/** Delete a saved query by id and clear any tab pointer to it. */
export function deleteSaved(state, id, save = saveJSON) {
  state.savedQueries = state.savedQueries.filter((q) => q.id !== id);
  for (const t of tabsForSaved(state, id)) t.savedId = null;
  state.libraryDirty.value = true;
  save(KEYS.saved, state.savedQueries);
}

// ── Library document ops ────────────────────────────────────────────────────
// The saved-query collection is a named, savable document. These ops back the
// header File menu (New / Save / Replace / Append) and the editable library
// name + unsaved-changes dot.

/** Clear tab→saved links whose entry no longer exists (after New/Replace), so a
 *  kept tab doesn't show "Saved" against a query that's gone. */
function pruneTabLinks(state) {
  const ids = new Set(state.savedQueries.map((q) => q.id));
  for (const t of state.tabs.value) if (t.savedId && !ids.has(t.savedId)) t.savedId = null;
}

/** Rename the library (blank → the default name). Marks dirty; persists name. */
export function renameLibrary(state, name, saveName = saveStr) {
  state.libraryName.value = String(name || '').trim() || DEFAULT_LIBRARY_NAME;
  state.libraryDirty.value = true;
  saveName(KEYS.libraryName, state.libraryName.value);
}

/** Start an empty, default-named library. Clears dirty; open tabs are kept
 *  (their now-dangling saved links are pruned). */
export function newLibrary(state, save = saveJSON, saveName = saveStr) {
  state.savedQueries = [];
  pruneTabLinks(state);
  state.libraryName.value = DEFAULT_LIBRARY_NAME;
  state.libraryDirty.value = false;
  save(KEYS.saved, state.savedQueries);
  saveName(KEYS.libraryName, state.libraryName.value);
}

/** Replace the library with `queries`, adopting the loaded file's base name.
 *  Unique ids are kept (lossless round-trip); missing OR duplicate ids get a fresh id.
 *  Clears dirty; open tabs are kept (dangling links pruned). */
export function replaceLibrary(state, queries, fileName, save = saveJSON, saveName = saveStr, genId = () => makeId('s', Date.now())) {
  const seen = new Set();
  state.savedQueries = queries.map((q) => {
    // Mint a fresh id for a missing OR already-seen id so every saved row has a
    // unique id. The sidebar addresses rows by id (find/filter), so a duplicate
    // id would let one delete remove several rows and rename/favorite hit the
    // wrong one. (mergeSaved-based import already collapsed dup ids; keep parity.)
    let id = q.id;
    if (!id || seen.has(id)) { do { id = genId(); } while (seen.has(id)); }
    seen.add(id);
    return {
      id, name: q.name, sql: q.sql, favorite: !!q.favorite,
      ...(q.description ? { description: q.description } : {}),
      ...(q.chart ? { chart: q.chart } : {}), ...(q.view ? { view: q.view } : {}),
    };
  });
  pruneTabLinks(state);
  const base = String(fileName || '').replace(/\.[^.]+$/, '').trim();
  state.libraryName.value = base || DEFAULT_LIBRARY_NAME;
  state.libraryDirty.value = false;
  save(KEYS.saved, state.savedQueries);
  saveName(KEYS.libraryName, state.libraryName.value);
}

/** Append `queries` into the library via the standard merge dedupe (sets dirty
 *  through importSaved). Returns { added, updated, skipped }. */
export function appendLibrary(state, queries, save = saveJSON, genId = () => makeId('s', Date.now())) {
  return importSaved(state, queries, save, genId);
}

/** Mark the library as saved to a file (clears the unsaved-changes dot). */
export function markLibrarySaved(state) {
  state.libraryDirty.value = false;
}

// Push one history entry (most-recent first, capped at 50). Internal — the
// exported recorders below supply the sql/rows/ms.
function pushHistory(state, sql, rows, ms, save, now) {
  const s = String(sql || '').trim();
  if (!s) return;
  state.history.unshift({ id: makeId('h', now), sql: s, ts: now, rows, ms });
  state.history = state.history.slice(0, 50);
  save(KEYS.history, state.history);
}

/**
 * Record a successful run in history. `sqlText` overrides the recorded SQL (used
 * when a selection — not the whole tab — was run); it defaults to `tab.sql`.
 */
export function recordHistory(state, tab, save = saveJSON, now = Date.now(), sqlText) {
  pushHistory(
    state,
    sqlText != null ? sqlText : tab.sql,
    tab.result.rawText != null ? null : tab.result.rows.length,
    Math.round(tab.result.progress.elapsed_ns / 1e6),
    save, now,
  );
}

/** Record a successful multiquery script run as one history entry (the whole
 *  script text); per-statement row counts aren't meaningful, so rows is null. */
export function recordScriptHistory(state, sql, ms, save = saveJSON, now = Date.now()) {
  pushHistory(state, sql, null, Math.round(ms), save, now);
}

/** Clear all history. */
export function clearHistory(state, save = saveJSON) {
  state.history = [];
  save(KEYS.history, state.history);
}

/** Delete one history entry by id. */
export function deleteHistory(state, id, save = saveJSON) {
  state.history = state.history.filter((h) => h.id !== id);
  save(KEYS.history, state.history);
}
