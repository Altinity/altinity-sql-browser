// Application state: a plain object plus pure operations over it. Persistence
// is injected as a `save(key, value)` function (defaulting to storage.js), so
// every operation is unit-testable with a spy and no real localStorage.

import { clamp } from './core/format.js';
import { mergeSaved } from './core/saved-io.js';
import { cloneChartCfg } from './core/chart-data.js';
import { loadJSON, saveJSON, loadStr } from './core/storage.js';

/** A tab's chart state as a persistable payload `{ cfg, key }`, or null. */
export function tabChart(tab) {
  return tab && tab.chartCfg ? { cfg: cloneChartCfg(tab.chartCfg), key: tab.chartKey ?? null } : null;
}

/** Result views a saved query can remember (the raw TSV/JSON view is transient). */
export const SAVED_VIEWS = new Set(['table', 'json', 'chart']);

export const KEYS = {
  theme: 'asb:theme',
  sidebarPx: 'asb:sidebarPx',
  editorPct: 'asb:editorPct',
  sideSplitPct: 'asb:sideSplitPct',
  format: 'asb:format',
  sidePanel: 'asb:sidePanel',
  saved: 'asb:saved',
  history: 'asb:history',
};

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
    theme: read.loadStr(KEYS.theme, 'dark'),
    density: 'comfortable',
    sidebarPx: clamp(parseInt(read.loadStr(KEYS.sidebarPx, '248'), 10), 180, 420),
    editorPct: num(KEYS.editorPct, 45, 15, 85),
    sideSplitPct: num(KEYS.sideSplitPct, 58, 25, 85),
    tabs: [newTabObj('t1')],
    activeTabId: 't1',
    schema: null,
    schemaError: null,
    schemaFilter: '',
    expandedTables: new Set(),
    serverVersion: null,
    running: false,
    abortController: null,
    resultView: 'table',
    resultSort: { col: null, dir: 'asc' },
    outputFormat: read.loadStr(KEYS.format, 'Table'),
    sidePanel: read.loadStr(KEYS.sidePanel, 'saved'),
    savedQueries: read.loadJSON(KEYS.saved, []),
    history: read.loadJSON(KEYS.history, []),
    shortcutsOpen: false,
  };
}

/** The currently-active tab object (falls back to the first tab). */
export function activeTab(state) {
  return state.tabs.find((t) => t.id === state.activeTabId) || state.tabs[0];
}

/** Allocate a new tab id ('t2', 't3', ...). */
export function allocTabId(state) {
  return 't' + state.nextTabId++;
}

const rnd = () => Math.random().toString(36).slice(2, 6);
const makeId = (prefix, now) => prefix + now + rnd();
const tabsForSaved = (state, id) => state.tabs.filter((t) => t.savedId === id);

/** The saved query a tab is linked to (via tab.savedId), or null. */
export function savedForTab(state, tab) {
  return (tab && tab.savedId && state.savedQueries.find((q) => q.id === tab.savedId)) || null;
}

/**
 * Save the tab's SQL under `name`. If the tab is already linked to a saved
 * entry, update that entry in place; otherwise create a new one (newest first)
 * and link the tab to it. The tab's name mirrors the saved name. Returns the
 * saved entry, or null for empty SQL/name.
 */
export function saveQuery(state, tab, name, save = saveJSON, now = Date.now()) {
  const sql = String(tab.sql || '').trim();
  const nm = String(name || '').trim();
  if (!sql || !nm) return null;
  const chart = tabChart(tab);
  // Remember the current result view (Table/JSON/Chart) so a restore reopens the
  // same data representation; the transient raw view isn't persisted.
  const view = SAVED_VIEWS.has(state.resultView) ? state.resultView : undefined;
  let entry = savedForTab(state, tab);
  if (entry) {
    entry.name = nm;
    entry.sql = sql;
    if (chart) entry.chart = chart; else delete entry.chart;
    if (view) entry.view = view; else delete entry.view;
  } else {
    entry = { id: makeId('s', now), name: nm, sql, favorite: false };
    if (chart) entry.chart = chart;
    if (view) entry.view = view;
    state.savedQueries.unshift(entry);
    tab.savedId = entry.id;
  }
  tab.name = nm;
  save(KEYS.saved, state.savedQueries);
  return entry;
}

/** Rename a saved query, keeping any linked tab's name in sync. */
export function renameSaved(state, id, name, save = saveJSON) {
  const nm = String(name || '').trim();
  const entry = state.savedQueries.find((q) => q.id === id);
  if (!entry || !nm) return;
  entry.name = nm;
  for (const t of tabsForSaved(state, id)) t.name = nm;
  save(KEYS.saved, state.savedQueries);
}

/** Toggle a saved query's favorite flag. */
export function toggleFavorite(state, id, save = saveJSON) {
  const entry = state.savedQueries.find((q) => q.id === id);
  if (!entry) return;
  entry.favorite = !entry.favorite;
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
 * Merge imported queries into savedQueries (dedupe by content, update by id,
 * else add). Returns { added, updated, skipped }.
 */
export function importSaved(state, queries, save = saveJSON, genId = () => makeId('s', Date.now())) {
  const { merged, added, updated, skipped } = mergeSaved(state.savedQueries, queries, genId);
  state.savedQueries = merged;
  save(KEYS.saved, state.savedQueries);
  return { added, updated, skipped };
}

/** Delete a saved query by id and clear any tab pointer to it. */
export function deleteSaved(state, id, save = saveJSON) {
  state.savedQueries = state.savedQueries.filter((q) => q.id !== id);
  for (const t of tabsForSaved(state, id)) t.savedId = null;
  save(KEYS.saved, state.savedQueries);
}

/** Record a successful run in history (most-recent first, capped at 50). */
export function recordHistory(state, tab, save = saveJSON, now = Date.now()) {
  const sql = String(tab.sql || '').trim();
  if (!sql) return;
  state.history.unshift({
    id: makeId('h', now),
    sql,
    ts: now,
    rows: tab.result.rawText != null ? null : tab.result.rows.length,
    ms: Math.round(tab.result.progress.elapsed_ns / 1e6),
  });
  state.history = state.history.slice(0, 50);
  save(KEYS.history, state.history);
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
