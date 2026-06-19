// Application state: a plain object plus pure operations over it. Persistence
// is injected as a `save(key, value)` function (defaulting to storage.js), so
// every operation is unit-testable with a spy and no real localStorage.

import { clamp, inferQueryName } from './core/format.js';
import { loadJSON, saveJSON, loadStr } from './core/storage.js';

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

/** A blank query tab. */
export function newTabObj(id) {
  return { id, name: 'Untitled', sql: '', dirty: false, result: null, savedId: null };
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

/** Find a saved query whose SQL matches (trimmed). */
export function findSavedBySql(state, sql) {
  const s = String(sql || '').trim();
  return state.savedQueries.find((q) => q.sql.trim() === s) || null;
}

/**
 * Toggle the active SQL in/out of saved queries. Returns { saved } reflecting
 * the new state, or { saved: false, noop: true } for empty SQL.
 */
export function toggleSaved(state, sql, save = saveJSON, now = Date.now()) {
  const s = String(sql || '').trim();
  if (!s) return { saved: false, noop: true };
  const existing = findSavedBySql(state, s);
  if (existing) {
    state.savedQueries = state.savedQueries.filter((q) => q.id !== existing.id);
    save(KEYS.saved, state.savedQueries);
    return { saved: false };
  }
  state.savedQueries.unshift({ id: 's' + now + rnd(), name: inferQueryName(s), sql: s, starred: true });
  save(KEYS.saved, state.savedQueries);
  return { saved: true };
}

/** Delete a saved query by id and clear any tab pointer to it. */
export function deleteSaved(state, id, save = saveJSON) {
  state.savedQueries = state.savedQueries.filter((q) => q.id !== id);
  for (const t of state.tabs) if (t.savedId === id) t.savedId = null;
  save(KEYS.saved, state.savedQueries);
}

/** Record a successful run in history (most-recent first, capped at 50). */
export function recordHistory(state, tab, save = saveJSON, now = Date.now()) {
  const sql = String(tab.sql || '').trim();
  if (!sql) return;
  state.history.unshift({
    id: 'h' + now + rnd(),
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
