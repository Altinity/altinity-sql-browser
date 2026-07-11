import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  KEYS, DEFAULT_LIBRARY_NAME, newTabObj, createState, activeTab, allocTabId, effectiveFilterActive,
  saveQuery, savedForTab, renameSaved, toggleFavorite, sortedSaved, filterSaved, filterHistory, importSaved,
  deleteSaved, recordHistory, recordScriptHistory, clearHistory, deleteHistory, tabChart,
  renameLibrary, newLibrary, replaceLibrary, appendLibrary, markLibrarySaved,
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
    expect(s.theme).toBe('light');
    expect(s.sidebarPx).toBe(248);
    expect(s.editorPct).toBe(45);
    expect(s.sideSplitPct).toBe(58);
    expect(s.cellDrawerPx).toBe(560);
    expect(s.tabs.value).toHaveLength(1);
    expect(s.savedQueries).toEqual([]);
    expect(s.schema.value).toBe(null);
    expect(s.schemaError.value).toBe(null);
    expect(s.schemaFilter.value).toBe('');
    expect(s.expanded.value).toBeInstanceOf(Set);
    expect(s.expanded.value.size).toBe(0);
    expect(s.libraryName.value).toBe(DEFAULT_LIBRARY_NAME);
    expect(s.libraryDirty.value).toBe(false);
    expect(s.dashLayout).toBe('arrange');
    expect(s.dashCols).toBe(3);
    expect(s.varValues).toEqual({});
    expect(s.filterActive).toEqual({}); // #165: own key, defaults empty
    expect(s.varRecent).toEqual({ version: 1, nextSeq: 1, byName: {} }); // #171: own key, defaults empty
    expect(s.varRecentDisabled).toBe(false);
  });
  it('reads + clamps persisted prefs', () => {
    const s = createState(reader({
      [KEYS.theme]: 'light',
      [KEYS.sidebarPx]: '9999', // clamps to 420
      [KEYS.editorPct]: '5', // clamps to 15
      [KEYS.sideSplitPct]: '99', // clamps to 85
      [KEYS.cellDrawerPx]: '100', // clamps up to the 320 floor
      [KEYS.sidePanel]: 'history',
      [KEYS.saved]: [{ id: 's1', sql: 'x', name: 'n', starred: true }],
      [KEYS.history]: [{ id: 'h1', sql: 'y', ts: 1, rows: 1, ms: 2 }],
      [KEYS.libraryName]: 'My team queries',
      [KEYS.dashLayout]: 'report',
      [KEYS.dashCols]: '2',
      [KEYS.varValues]: { d: 'stale' },
      [KEYS.filterActive]: { d: false },
      [KEYS.varRecent]: { version: 1, nextSeq: 3, byName: { d: [{ value: 'x', seq: 2 }] } },
      [KEYS.varRecentDisabled]: true,
    }));
    expect(s.theme).toBe('light');
    expect(s.libraryName.value).toBe('My team queries');
    expect(s.dashLayout).toBe('report');
    expect(s.dashCols).toBe(2);
    expect(s.sidebarPx).toBe(420);
    expect(s.editorPct).toBe(15);
    expect(s.sideSplitPct).toBe(85);
    expect(s.cellDrawerPx).toBe(320);
    expect(s.sidePanel.value).toBe('history');
    expect(s.savedQueries).toHaveLength(1);
    expect(s.history).toHaveLength(1);
    expect(s.varValues).toEqual({ d: 'stale' });
    expect(s.filterActive).toEqual({ d: false }); // restored alongside varValues (#165)
    expect(s.varRecent).toEqual({ version: 1, nextSeq: 3, byName: { d: [{ value: 'x', seq: 2 }] } });
    expect(s.varRecentDisabled).toBe(true);
  });
  it('defaults the reader to storage helpers', () => {
    vi.stubGlobal('localStorage', memStore({ [KEYS.theme]: 'light' }));
    const s = createState();
    expect(s.tabs.value[0].id).toBe('t1');
    expect(s.theme).toBe('light');
  });
});

describe('effectiveFilterActive (#165)', () => {
  it('an explicit filterActive entry wins over the stored value', () => {
    expect(effectiveFilterActive({ d: 'stale' }, { d: false })).toEqual({ d: false });
    expect(effectiveFilterActive({ d: '' }, { d: true })).toEqual({ d: true }); // active empty string
    expect(effectiveFilterActive({ d: 'x' }, { d: 1 })).toEqual({ d: true }); // coerced to boolean
  });
  it('a param with no entry derives activation from value non-emptiness (pre-#165 persistence)', () => {
    expect(effectiveFilterActive({ a: 'x', b: '', c: null }, {})).toEqual({ a: true, b: false, c: false });
  });
  it('first load: no values, no entries — empty map, nothing throws', () => {
    expect(effectiveFilterActive()).toEqual({});
    expect(effectiveFilterActive({}, { d: true })).toEqual({ d: true });
  });
});

describe('activeTab / allocTabId', () => {
  it('returns the active tab, falling back to the first', () => {
    const s = createState(reader());
    expect(activeTab(s).id).toBe('t1');
    s.activeTabId.value = 'gone';
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
    s.tabs.value[0].sql = '';
    expect(saveQuery(s, s.tabs.value[0], 'name', '', save)).toBeNull();
    s.tabs.value[0].sql = 'SELECT 1';
    expect(saveQuery(s, s.tabs.value[0], '  ', '', save)).toBeNull();
    expect(save).not.toHaveBeenCalled();
  });
  it('saveQuery creates + links the tab, then updates in place on re-save', () => {
    const s = createState(reader());
    const save = vi.fn();
    const tab = s.tabs.value[0];
    tab.sql = 'SELECT 1';
    const e1 = saveQuery(s, tab, 'My query', '', save, 100);
    expect(e1).toMatchObject({ name: 'My query', sql: 'SELECT 1', favorite: false });
    expect(tab.savedId).toBe(e1.id);
    expect(tab.name).toBe('My query');
    expect(s.savedQueries).toHaveLength(1);
    expect(save).toHaveBeenLastCalledWith(KEYS.saved, s.savedQueries);
    // re-save the linked tab → updates the same entry in place
    tab.sql = 'SELECT 2';
    const e2 = saveQuery(s, tab, 'My query v2', '', save, 200);
    expect(e2.id).toBe(e1.id);
    expect(s.savedQueries).toHaveLength(1);
    expect(s.savedQueries[0]).toMatchObject({ name: 'My query v2', sql: 'SELECT 2' });
    expect(tab.name).toBe('My query v2');
  });
  it('saveQuery stores/updates/clears an optional description', () => {
    const s = createState(reader());
    const save = vi.fn();
    const tab = s.tabs.value[0];
    tab.sql = 'SELECT 1';
    const e = saveQuery(s, tab, 'Q', '  what it does  ', save, 100); // trimmed
    expect(e.description).toBe('what it does');
    saveQuery(s, tab, 'Q', 'changed', save, 200); // update in place
    expect(s.savedQueries[0].description).toBe('changed');
    saveQuery(s, tab, 'Q', '   ', save, 300); // blank → dropped
    expect('description' in s.savedQueries[0]).toBe(false);
    // create with no description arg → no description field
    const t2 = newTabObj('t2'); t2.sql = 'SELECT 2'; s.tabs.value.push(t2);
    const e2 = saveQuery(s, t2, 'Q2', undefined, save, 400);
    expect('description' in e2).toBe(false);
  });
  it('savedForTab resolves the linked entry (or null)', () => {
    const s = createState(reader());
    s.savedQueries = [{ id: 's1', sql: 'x', name: 'n', favorite: false }];
    s.tabs.value[0].savedId = 's1';
    expect(savedForTab(s, s.tabs.value[0])).toMatchObject({ id: 's1' });
    s.tabs.value[0].savedId = 'gone';
    expect(savedForTab(s, s.tabs.value[0])).toBeNull();
    expect(savedForTab(s, { savedId: null })).toBeNull();
  });
  it('renameSaved updates the entry + any linked tab name', () => {
    const s = createState(reader());
    s.savedQueries = [{ id: 's1', sql: 'x', name: 'old', favorite: false }];
    s.tabs.value[0].savedId = 's1';
    const save = vi.fn();
    renameSaved(s, 's1', '  new  ', undefined, save);
    expect(s.savedQueries[0].name).toBe('new');
    expect(s.tabs.value[0].name).toBe('new');
    renameSaved(s, 's1', '   ', undefined, save); // blank ignored
    expect(s.savedQueries[0].name).toBe('new');
    renameSaved(s, 'missing', 'x', undefined, save); // unknown id ignored
    expect(save).toHaveBeenCalledTimes(1);
  });
  it('renameSaved sets/clears description when given, leaves it untouched when undefined', () => {
    const s = createState(reader());
    s.savedQueries = [{ id: 's1', sql: 'x', name: 'A', favorite: false }];
    const save = vi.fn();
    renameSaved(s, 's1', 'A', '  a note  ', save); // set (trimmed)
    expect(s.savedQueries[0].description).toBe('a note');
    renameSaved(s, 's1', 'A', undefined, save); // name-only → description kept
    expect(s.savedQueries[0].description).toBe('a note');
    renameSaved(s, 's1', 'A', '', save); // explicit empty → cleared
    expect('description' in s.savedQueries[0]).toBe(false);
    renameSaved(s, 's1', 'A', '  re  ', save); // re-set
    expect(s.savedQueries[0].description).toBe('re');
    renameSaved(s, 's1', 'A', null, save); // null (not undefined) → cleared, not stored as 'null' (#4 review)
    expect('description' in s.savedQueries[0]).toBe(false);
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
  it('filterSaved matches name/description/sql case-insensitively; blank → unchanged', () => {
    const list = [
      { id: 'a', name: 'Carrier delays', sql: 'SELECT carrier', description: 'worst delays' },
      { id: 'b', name: 'Airports', sql: 'SELECT origin FROM flights' },
      { id: 'c', name: 'Cancellations', sql: 'SELECT month' },
    ];
    expect(filterSaved(list, '').map((q) => q.id)).toEqual(['a', 'b', 'c']);
    expect(filterSaved(list, '   ')).toBe(list); // blank → same reference, no copy
    expect(filterSaved(list, 'CARRIER').map((q) => q.id)).toEqual(['a']); // name + sql
    expect(filterSaved(list, 'delays').map((q) => q.id)).toEqual(['a']); // description
    expect(filterSaved(list, 'origin').map((q) => q.id)).toEqual(['b']); // sql
    expect(filterSaved(list, 'zzz')).toEqual([]);
  });
  it('filterSaved tolerates entries missing fields', () => {
    const list = [{ id: 'x' }, { id: 'y', name: 'Yo' }];
    expect(filterSaved(list, 'yo').map((q) => q.id)).toEqual(['y']);
  });
  it('filterHistory matches sql case-insensitively; blank → unchanged', () => {
    const list = [{ id: 'h1', sql: 'SELECT 1' }, { id: 'h2', sql: 'INSERT INTO t' }, { id: 'h3' }];
    expect(filterHistory(list, '')).toBe(list);
    expect(filterHistory(list, 'insert').map((h) => h.id)).toEqual(['h2']);
    expect(filterHistory(list, 'zzz')).toEqual([]);
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
    const tab = s.tabs.value[0];
    tab.sql = 'SELECT a, b';
    tab.chartCfg = { type: 'pie', x: 0, y: [1], series: null };
    tab.chartKey = 'a:String|b:UInt64';
    const e1 = saveQuery(s, tab, 'Chartd', '', save, 100);
    expect(e1.chart).toEqual({ cfg: tab.chartCfg, key: tab.chartKey });
    expect(e1.chart.cfg).not.toBe(tab.chartCfg); // cloned into the entry
    // re-save with a different chart → entry.chart updates in place
    tab.chartCfg = { type: 'line', x: 0, y: [1], series: null };
    saveQuery(s, tab, 'Chartd', '', save, 200);
    expect(s.savedQueries[0].chart.cfg.type).toBe('line');
    // re-save after the chart is cleared → entry.chart is dropped
    tab.chartCfg = null;
    saveQuery(s, tab, 'Chartd', '', save, 300);
    expect(s.savedQueries[0].chart).toBeUndefined();
  });
  it('saveQuery persists the result view (Table/JSON/Chart), updates it, and ignores the transient raw view', () => {
    const s = createState(reader());
    const save = vi.fn();
    const tab = s.tabs.value[0];
    tab.sql = 'SELECT 1';
    s.resultView.value = 'chart';
    const e = saveQuery(s, tab, 'V', '', save, 100);
    expect(e.view).toBe('chart');
    // re-save under a different view → updates
    s.resultView.value = 'json';
    saveQuery(s, tab, 'V', '', save, 200);
    expect(s.savedQueries[0].view).toBe('json');
    // raw view (TSV/JSON output) is not a saved view → dropped
    s.resultView.value = 'raw';
    saveQuery(s, tab, 'V', '', save, 300);
    expect(s.savedQueries[0].view).toBeUndefined();
  });
  it('deleteSaved removes + clears tab pointers', () => {
    const s = createState(reader());
    s.savedQueries = [{ id: 's1', sql: 'x', name: 'n' }];
    s.tabs.value[0].savedId = 's1';
    const save = vi.fn();
    deleteSaved(s, 's1', save);
    expect(s.savedQueries).toHaveLength(0);
    expect(s.tabs.value[0].savedId).toBeNull();
    expect(save).toHaveBeenCalledWith(KEYS.saved, []);
  });
});

describe('library document', () => {
  it('dirty flag: saved-query mutations set it; markLibrarySaved clears it', () => {
    const s = createState(reader());
    const tab = s.tabs.value[0]; tab.sql = 'SELECT 1';
    expect(s.libraryDirty.value).toBe(false);
    saveQuery(s, tab, 'Q', '', vi.fn());
    expect(s.libraryDirty.value).toBe(true);
    markLibrarySaved(s);
    expect(s.libraryDirty.value).toBe(false);
    toggleFavorite(s, tab.savedId, vi.fn());            // favorite the just-saved entry
    expect(s.libraryDirty.value).toBe(true);
    markLibrarySaved(s);
    renameSaved(s, tab.savedId, 'Q2', undefined, vi.fn());
    expect(s.libraryDirty.value).toBe(true);
    markLibrarySaved(s);
    deleteSaved(s, tab.savedId, vi.fn());
    expect(s.libraryDirty.value).toBe(true);
    markLibrarySaved(s);
    importSaved(s, [{ name: 'I', sql: 'i' }], vi.fn(), () => 'gi');
    expect(s.libraryDirty.value).toBe(true);
  });

  it('renameLibrary trims + persists + marks dirty; blank falls back to the default', () => {
    const s = createState(reader());
    const saveName = vi.fn();
    renameLibrary(s, '  My queries  ', saveName);
    expect(s.libraryName.value).toBe('My queries');
    expect(s.libraryDirty.value).toBe(true);
    expect(saveName).toHaveBeenCalledWith(KEYS.libraryName, 'My queries');
    renameLibrary(s, '   ', saveName);
    expect(s.libraryName.value).toBe(DEFAULT_LIBRARY_NAME);
  });

  it('newLibrary clears queries + name, clears dirty, prunes dangling tab links', () => {
    const s = createState(reader());
    s.savedQueries = [{ id: 's1', name: 'A', sql: '1', favorite: false }];
    s.libraryName.value = 'Old'; s.libraryDirty.value = true;
    s.tabs.value[0].savedId = 's1';                            // dangling after clear → pruned
    s.tabs.value.push(newTabObj('t2'));                        // no savedId → skipped by prune
    const save = vi.fn(), saveName = vi.fn();
    newLibrary(s, save, saveName);
    expect(s.savedQueries).toEqual([]);
    expect(s.libraryName.value).toBe(DEFAULT_LIBRARY_NAME);
    expect(s.libraryDirty.value).toBe(false);
    expect(s.tabs.value[0].savedId).toBeNull();
    expect(save).toHaveBeenCalledWith(KEYS.saved, []);
    expect(saveName).toHaveBeenCalledWith(KEYS.libraryName, DEFAULT_LIBRARY_NAME);
  });

  it('replaceLibrary keeps ids (mints for id-less), carries metadata, adopts the base name, clears dirty, prunes links', () => {
    const s = createState(reader());
    s.savedQueries = [{ id: 'old', name: 'X', sql: 'x', favorite: false }];
    s.tabs.value[0].savedId = 'old';                           // becomes dangling → pruned
    s.libraryDirty.value = true;
    const chart = { cfg: { type: 'bar' }, key: 'k' };
    const incoming = [
      { id: 'keep', name: 'A', sql: '1', favorite: true, description: 'd', chart, view: 'json' },
      { name: 'B', sql: '2', favorite: false },          // id-less → genId
    ];
    let n = 0;
    const save = vi.fn(), saveName = vi.fn();
    replaceLibrary(s, incoming, 'My Library.json', save, saveName, () => 'g' + (++n));
    expect(s.savedQueries.map((q) => q.id)).toEqual(['keep', 'g1']);
    expect(s.savedQueries[0]).toMatchObject({ name: 'A', sql: '1', favorite: true, description: 'd', chart, view: 'json' });
    expect(s.libraryName.value).toBe('My Library');            // extension stripped
    expect(s.libraryDirty.value).toBe(false);
    expect(s.tabs.value[0].savedId).toBeNull();
    expect(save).toHaveBeenCalledWith(KEYS.saved, s.savedQueries);
    expect(saveName).toHaveBeenCalledWith(KEYS.libraryName, 'My Library');
  });

  it('replaceLibrary mints fresh ids for duplicate incoming ids, keeping every id unique', () => {
    const s = createState(reader());
    const incoming = [
      { id: 'dup', name: 'A', sql: '1' },
      { id: 'dup', name: 'B', sql: '2' }, // same id → must be reassigned
      { id: 'uniq', name: 'C', sql: '3' },
      { name: 'D', sql: '4' },            // id-less → minted
    ];
    // first mint collides with an already-seen id → the retry loop must skip it
    let n = 0;
    const genId = () => { n += 1; return n === 1 ? 'dup' : 'g' + n; };
    replaceLibrary(s, incoming, 'lib.json', vi.fn(), vi.fn(), genId);
    const ids = s.savedQueries.map((q) => q.id);
    expect(ids[0]).toBe('dup');                       // first occurrence keeps its id
    expect(ids[2]).toBe('uniq');                      // unique id preserved
    expect(ids).toHaveLength(4);
    expect(new Set(ids).size).toBe(4);               // all unique (no duplicate 'dup')
  });

  it('replaceLibrary with no usable file name falls back to the default', () => {
    const s = createState(reader());
    replaceLibrary(s, [{ name: 'A', sql: '1' }], '.json', vi.fn(), vi.fn(), () => 'g');
    expect(s.libraryName.value).toBe(DEFAULT_LIBRARY_NAME);
  });

  it('appendLibrary merges via importSaved (dedupe), returns counts, sets dirty', () => {
    const s = createState(reader());
    s.savedQueries = [{ id: 's1', name: 'A', sql: '1', favorite: false }];
    const r = appendLibrary(s, [
      { id: 's1', name: 'A', sql: '1' },                 // content dup → skip
      { name: 'B', sql: '2' },                           // add
    ], vi.fn(), () => 'gb');
    expect(r).toEqual({ added: 1, updated: 0, skipped: 1 });
    expect(s.savedQueries.map((q) => q.name)).toEqual(['A', 'B']);
    expect(s.libraryDirty.value).toBe(true);
  });

  it('library ops default their persistence seams (real storage helpers)', () => {
    vi.stubGlobal('localStorage', memStore());
    const s = createState(reader());
    s.tabs.value[0].sql = 'SELECT 1';
    const e = saveQuery(s, s.tabs.value[0], 'Q'); // default save/now/description
    renameLibrary(s, 'Lib');                // default saveName
    replaceLibrary(s, [{ id: e.id, name: 'Q', sql: 'SELECT 1' }], 'f.json'); // default seams
    newLibrary(s);                          // default seams
    appendLibrary(s, [{ name: 'Z', sql: 'z' }]); // default seam
    expect(s.savedQueries.some((q) => q.name === 'Z')).toBe(true);
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
  it('recordHistory records sqlText override (selection run) over tab.sql', () => {
    const s = createState(reader());
    recordHistory(s, tab(), vi.fn(), 1000, 'SELECT just_this');
    expect(s.history[0]).toMatchObject({ sql: 'SELECT just_this', rows: 2 });
  });
  it('recordScriptHistory records the whole script with null rows', () => {
    const s = createState(reader());
    const save = vi.fn();
    recordScriptHistory(s, 'CREATE x; INSERT y; SELECT z', 12.6, save, 2000);
    expect(s.history[0]).toMatchObject({ sql: 'CREATE x; INSERT y; SELECT z', ts: 2000, rows: null, ms: 13 });
    expect(save).toHaveBeenCalledWith(KEYS.history, s.history);
  });
  it('recordScriptHistory skips empty script text', () => {
    const s = createState(reader());
    recordScriptHistory(s, '   ', 5, vi.fn());
    expect(s.history).toHaveLength(0);
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
    s.tabs.value[0].sql = 'SELECT 9';
    const e = saveQuery(s, s.tabs.value[0], 'nine');
    renameSaved(s, e.id, 'nine!');
    toggleFavorite(s, e.id);
    recordHistory(s, { sql: 'SELECT 9', result: { rawText: null, rows: [], progress: { elapsed_ns: 0 } } });
    deleteSaved(s, 'nope');
    deleteHistory(s, 'nope');
    clearHistory(s);
    expect(s.history).toEqual([]);
  });
});
