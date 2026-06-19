import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  KEYS, newTabObj, createState, activeTab, allocTabId,
  findSavedBySql, toggleSaved, deleteSaved, recordHistory, clearHistory, deleteHistory,
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
    expect(newTabObj('t9')).toEqual({ id: 't9', name: 'Untitled', sql: '', dirty: false, result: null, savedId: null });
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
  it('findSavedBySql matches trimmed sql', () => {
    const s = createState(reader());
    s.savedQueries = [{ id: 's1', sql: 'SELECT 1', name: 'n' }];
    expect(findSavedBySql(s, '  SELECT 1 ')).toMatchObject({ id: 's1' });
    expect(findSavedBySql(s, 'SELECT 2')).toBeNull();
    expect(findSavedBySql(s, null)).toBeNull();
  });
  it('toggleSaved is a no-op for empty/nullish sql', () => {
    const s = createState(reader());
    const save = vi.fn();
    expect(toggleSaved(s, '   ', save)).toEqual({ saved: false, noop: true });
    expect(toggleSaved(s, null, save)).toEqual({ saved: false, noop: true });
    expect(save).not.toHaveBeenCalled();
  });
  it('toggleSaved adds then removes', () => {
    const s = createState(reader());
    const save = vi.fn();
    expect(toggleSaved(s, 'SELECT 1', save, 100)).toEqual({ saved: true });
    expect(s.savedQueries[0]).toMatchObject({ sql: 'SELECT 1', starred: true });
    expect(save).toHaveBeenLastCalledWith(KEYS.saved, s.savedQueries);
    expect(toggleSaved(s, 'SELECT 1', save, 100)).toEqual({ saved: false });
    expect(s.savedQueries).toHaveLength(0);
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
  it('toggleSaved/deleteSaved/recordHistory/clearHistory persist via storage by default', () => {
    const s = createState(reader());
    // Exercises the default saveJSON path (writes to happy-dom localStorage).
    toggleSaved(s, 'SELECT 9');
    recordHistory(s, { sql: 'SELECT 9', result: { rawText: null, rows: [], progress: { elapsed_ns: 0 } } });
    deleteSaved(s, 'nope');
    deleteHistory(s, 'nope');
    clearHistory(s);
    expect(s.history).toEqual([]);
  });
});
