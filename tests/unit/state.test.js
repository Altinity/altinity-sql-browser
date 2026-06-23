import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  KEYS, newTabObj, createState, activeTab, allocTabId,
  saveQuery, savedForTab, renameSaved, toggleFavorite, sortedSaved, importSaved,
  deleteSaved, recordHistory, clearHistory, deleteHistory, tabChart,
} from '../../src/state.js';

afterEach(() => vi.unstubAllGlobals());

function memStore(initial = {}) {
  const m = new Map(Object.entries(initial));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) };
}

const reader = (over = {}) => ({
  loadStr: (k, dflt) => (k in over ? over[k] : dflt),
  loadJSON: (k, dflt) => (k in over ? over[k] : dflt),
});

describe('newTabObj', () => {
  it('creates a blank tab', () => {
    expect(newTabObj('t9')).toEqual({ id: 't9', name: 'Untitled', sql: '', dirty: false, result: null, savedId: null, chartCfg: null, chartKey: null });
  });
});

describe('createState', () => {
  it('uses defaults', () => {
    const s = createState(reader());
    expect(s.theme).toBe('dark');
    expect(s.sidebarPx).toBe(248);
    expect(s.editorPct).toBe(45);
    expect(s.sideSplitPct).toBe(58);
    expect(s.outputFormat).toBe('Table');
    expect(s.tabs).toHaveLength(1);
    expect(s.savedQueries).toEqual([]);
    expect(s.expandedTables).toBeInstanceOf(Set);
  });
  it('reads + clamps persisted prefs', () => {
    const s = createState(reader({
      [KEYS.theme]: 'light',
      [KEYS.sidebarPx]: '9999', // clamps to 420
      [KEYS.editorPct]: '5', // clamps to 15
      [KEYS.sideSplitPct]: '99', // clamps to 85
      [KEYS.format]: 'JSON',
      [KEYS.sidePanel]: 'history',
      [KEYS.saved]: [{ id: 's1', sql: 'x', name: 'n', starred: true }],
      [KEYS.history]: [{ id: 'h1', sql: 'y', ts: 1, rows: 1, ms: 2 }],
    }));
    expect(s.theme).toBe('light');
    expect(s.sidebarPx).toBe(420);
    expect(s.editorPct).toBe(15);
    expect(s.sideSplitPct).toBe(85);
    expect(s.outputFormat).toBe('JSON');
    expect(s.sidePanel).toBe('history');
    expect(s.savedQueries).toHaveLength(1);
    expect(s.history).toHaveLength(1);
  });
  it('defaults the reader to storage helpers', () => {
    vi.stubGlobal('localStorage', memStore({ [KEYS.theme]: 'light' }));
    const s = createState();
    expect(s.tabs[0].id).toBe('t1');
    expect(s.theme).toBe('light');
  });
});

describe('activeTab / allocTabId', () => {
  it('returns the active tab, falling back to the first', () => {
    const s = createState(reader());
    expect(activeTab(s).id).toBe('t1');
    s.activeTabId = 'gone';
    expect(activeTab(s).id).toBe('t1');
  });
  it('allocates incrementing ids', () => {
    const s = createState(reader());
    expect(allocTabId(s)).toBe('t2');
    expect(allocTabId(s)).toBe('t3');
  });
});

describe('saved queries', () => {
  it('saveQuery is a no-op for empty SQL or empty name', () => {
    const s = createState(reader());
    const save = vi.fn();
    s.tabs[0].sql = '';
    expect(saveQuery(s, s.tabs[0], 'name', save)).toBeNull();
    s.tabs[0].sql = 'SELECT 1';
    expect(saveQuery(s, s.tabs[0], '  ', save)).toBeNull();
    expect(save).not.toHaveBeenCalled();
  });
  it('saveQuery creates + links the tab, then updates in place on re-save', () => {
    const s = createState(reader());
    const save = vi.fn();
    const tab = s.tabs[0];
    tab.sql = 'SELECT 1';
    const e1 = saveQuery(s, tab, 'My query', save, 100);
    expect(e1).toMatchObject({ name: 'My query', sql: 'SELECT 1', favorite: false });
    expect(tab.savedId).toBe(e1.id);
    expect(tab.name).toBe('My query');
    expect(s.savedQueries).toHaveLength(1);
    expect(save).toHaveBeenLastCalledWith(KEYS.saved, s.savedQueries);
    // re-save the linked tab → updates the same entry in place
    tab.sql = 'SELECT 2';
    const e2 = saveQuery(s, tab, 'My query v2', save, 200);
    expect(e2.id).toBe(e1.id);
    expect(s.savedQueries).toHaveLength(1);
    expect(s.savedQueries[0]).toMatchObject({ name: 'My query v2', sql: 'SELECT 2' });
    expect(tab.name).toBe('My query v2');
  });
  it('savedForTab resolves the linked entry (or null)', () => {
    const s = createState(reader());
    s.savedQueries = [{ id: 's1', sql: 'x', name: 'n', favorite: false }];
    s.tabs[0].savedId = 's1';
    expect(savedForTab(s, s.tabs[0])).toMatchObject({ id: 's1' });
    s.tabs[0].savedId = 'gone';
    expect(savedForTab(s, s.tabs[0])).toBeNull();
    expect(savedForTab(s, { savedId: null })).toBeNull();
  });
  it('renameSaved updates the entry + any linked tab name', () => {
    const s = createState(reader());
    s.savedQueries = [{ id: 's1', sql: 'x', name: 'old', favorite: false }];
    s.tabs[0].savedId = 's1';
    const save = vi.fn();
    renameSaved(s, 's1', '  new  ', save);
    expect(s.savedQueries[0].name).toBe('new');
    expect(s.tabs[0].name).toBe('new');
    renameSaved(s, 's1', '   ', save); // blank ignored
    expect(s.savedQueries[0].name).toBe('new');
    renameSaved(s, 'missing', 'x', save); // unknown id ignored
    expect(save).toHaveBeenCalledTimes(1);
  });
  it('toggleFavorite flips the flag; sortedSaved puts favorites first (stable)', () => {
    const s = createState(reader());
    s.savedQueries = [
      { id: 'a', sql: '1', name: 'A', favorite: false },
      { id: 'b', sql: '2', name: 'B', favorite: false },
      { id: 'c', sql: '3', name: 'C', favorite: false },
    ];
    const save = vi.fn();
    toggleFavorite(s, 'c', save);
    expect(s.savedQueries.find((q) => q.id === 'c').favorite).toBe(true);
    toggleFavorite(s, 'missing', save); // no-op
    expect(sortedSaved(s).map((q) => q.id)).toEqual(['c', 'a', 'b']);
    expect(save).toHaveBeenCalledTimes(1);
  });
  it('importSaved merges (add/skip/update), persists, and uses injected genId', () => {
    const s = createState(reader());
    s.savedQueries = [{ id: 's1', name: 'A', sql: '1', favorite: false }];
    const save = vi.fn();
    const r = importSaved(s, [
      { id: 's1', name: 'A', sql: '1' },      // skip (content dup)
      { id: 's1', name: 'A2', sql: '1b' },    // update by id
      { name: 'B', sql: '2' },                // add (genId)
    ], save, () => 'gx');
    expect(r).toEqual({ added: 1, updated: 1, skipped: 1 });
    expect(s.savedQueries.map((q) => q.name)).toEqual(['A2', 'B']);
    expect(s.savedQueries.find((q) => q.name === 'B').id).toBe('gx');
    expect(save).toHaveBeenCalledWith(KEYS.saved, s.savedQueries);
    // default save + genId (no injection) — exercises the default id generator
    importSaved(s, [{ name: 'Z', sql: 'zz' }]);
    expect(s.savedQueries.find((q) => q.name === 'Z').id).toMatch(/^s/);
  });
  it('tabChart packs a tab chart config (or null), defaulting a missing key', () => {
    expect(tabChart(null)).toBeNull();
    expect(tabChart({ chartCfg: null })).toBeNull();
    const cfg = { type: 'bar', x: 0, y: [1], series: null };
    expect(tabChart({ chartCfg: cfg, chartKey: 'k' })).toEqual({ cfg, key: 'k' });
    expect(tabChart({ chartCfg: cfg })).toEqual({ cfg, key: null }); // key ?? null
  });
  it('saveQuery persists, updates, and clears the chart config alongside the SQL', () => {
    const s = createState(reader());
    const save = vi.fn();
    const tab = s.tabs[0];
    tab.sql = 'SELECT a, b';
    tab.chartCfg = { type: 'pie', x: 0, y: [1], series: null };
    tab.chartKey = 'a:String|b:UInt64';
    const e1 = saveQuery(s, tab, 'Chartd', save, 100);
    expect(e1.chart).toEqual({ cfg: tab.chartCfg, key: tab.chartKey });
    expect(e1.chart.cfg).not.toBe(tab.chartCfg); // cloned into the entry
    // re-save with a different chart → entry.chart updates in place
    tab.chartCfg = { type: 'line', x: 0, y: [1], series: null };
    saveQuery(s, tab, 'Chartd', save, 200);
    expect(s.savedQueries[0].chart.cfg.type).toBe('line');
    // re-save after the chart is cleared → entry.chart is dropped
    tab.chartCfg = null;
    saveQuery(s, tab, 'Chartd', save, 300);
    expect(s.savedQueries[0].chart).toBeUndefined();
  });
  it('saveQuery persists the result view (Table/JSON/Chart), updates it, and ignores the transient raw view', () => {
    const s = createState(reader());
    const save = vi.fn();
    const tab = s.tabs[0];
    tab.sql = 'SELECT 1';
    s.resultView = 'chart';
    const e = saveQuery(s, tab, 'V', save, 100);
    expect(e.view).toBe('chart');
    // re-save under a different view → updates
    s.resultView = 'json';
    saveQuery(s, tab, 'V', save, 200);
    expect(s.savedQueries[0].view).toBe('json');
    // raw view (TSV/JSON output) is not a saved view → dropped
    s.resultView = 'raw';
    saveQuery(s, tab, 'V', save, 300);
    expect(s.savedQueries[0].view).toBeUndefined();
  });
  it('deleteSaved removes + clears tab pointers', () => {
    const s = createState(reader());
    s.savedQueries = [{ id: 's1', sql: 'x', name: 'n' }];
    s.tabs[0].savedId = 's1';
    const save = vi.fn();
    deleteSaved(s, 's1', save);
    expect(s.savedQueries).toHaveLength(0);
    expect(s.tabs[0].savedId).toBeNull();
    expect(save).toHaveBeenCalledWith(KEYS.saved, []);
  });
});

describe('history', () => {
  const tab = (over = {}) => ({
    sql: 'SELECT 1',
    result: { rawText: null, rows: [[1], [2]], progress: { elapsed_ns: 5e6 } },
    ...over,
  });

  it('recordHistory skips empty/nullish sql', () => {
    const s = createState(reader());
    const save = vi.fn();
    recordHistory(s, tab({ sql: '  ' }), save);
    recordHistory(s, tab({ sql: null }), save);
    expect(s.history).toHaveLength(0);
    expect(save).not.toHaveBeenCalled();
  });
  it('recordHistory stores row count + ms', () => {
    const s = createState(reader());
    const save = vi.fn();
    recordHistory(s, tab(), save, 1000);
    expect(s.history[0]).toMatchObject({ sql: 'SELECT 1', ts: 1000, rows: 2, ms: 5 });
    expect(save).toHaveBeenCalledWith(KEYS.history, s.history);
  });
  it('recordHistory stores null rows for raw results', () => {
    const s = createState(reader());
    recordHistory(s, tab({ result: { rawText: 'x', rows: [], progress: { elapsed_ns: 0 } } }), vi.fn());
    expect(s.history[0].rows).toBeNull();
  });
  it('recordHistory caps at 50 entries', () => {
    const s = createState(reader());
    s.history = Array.from({ length: 50 }, (_, i) => ({ id: 'h' + i }));
    recordHistory(s, tab(), vi.fn());
    expect(s.history).toHaveLength(50);
    expect(s.history[0].sql).toBe('SELECT 1');
  });
  it('clearHistory empties + persists', () => {
    const s = createState(reader());
    s.history = [{ id: 'h1' }];
    const save = vi.fn();
    clearHistory(s, save);
    expect(s.history).toEqual([]);
    expect(save).toHaveBeenCalledWith(KEYS.history, []);
  });
  it('deleteHistory removes one entry + persists', () => {
    const s = createState(reader());
    s.history = [{ id: 'h1' }, { id: 'h2' }];
    const save = vi.fn();
    deleteHistory(s, 'h1', save);
    expect(s.history.map((h) => h.id)).toEqual(['h2']);
    expect(save).toHaveBeenCalledWith(KEYS.history, s.history);
  });
});

describe('default persistence', () => {
  it('saveQuery/renameSaved/toggleFavorite/deleteSaved/recordHistory/clearHistory persist via storage by default', () => {
    const s = createState(reader());
    // Exercises the default saveJSON path (writes to happy-dom localStorage).
    s.tabs[0].sql = 'SELECT 9';
    const e = saveQuery(s, s.tabs[0], 'nine');
    renameSaved(s, e.id, 'nine!');
    toggleFavorite(s, e.id);
    recordHistory(s, { sql: 'SELECT 9', result: { rawText: null, rows: [], progress: { elapsed_ns: 0 } } });
    deleteSaved(s, 'nope');
    deleteHistory(s, 'nope');
    clearHistory(s);
    expect(s.history).toEqual([]);
  });
});
