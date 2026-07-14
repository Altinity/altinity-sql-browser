import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  KEYS, DEFAULT_LIBRARY_NAME, newTabObj, createState, activeTab, allocTabId, effectiveFilterActive,
  createSavedQuery, commitSavedQuery, savedForTab, renameSaved, toggleFavorite,
  sortedSaved, filterSaved, filterHistory, importSaved, deleteSaved, recordHistory,
  recordScriptHistory, clearHistory, deleteHistory, tabPanel, setTabSpecDraft, patchSpecDraft, tabDirty,
  renameLibrary, newLibrary, replaceLibrary, appendLibrary, markLibrarySaved,
} from '../../src/state.js';
import { queryDescription, queryFavorite, queryName, queryPanel, queryView } from '../../src/core/saved-query.js';
import { savedQuery } from '../helpers/saved-query.js';

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
    expect(newTabObj('t9')).toEqual({
      id: 't9', name: 'Untitled', sqlDraft: '', specVersion: 1,
      specText: '{\n  "name": "Untitled",\n  "favorite": false\n}',
      specParsed: { name: 'Untitled', favorite: false }, specDiagnostics: [],
      editorMode: 'sql', dirtySql: false, dirtySpec: false,
      result: null, lastSuccessfulResultColumns: [], savedId: null,
    });
    expect(tabDirty(newTabObj('t1'))).toBe(false);
    expect(tabDirty({ dirtySpec: true })).toBe(true);
  });
});

describe('createState', () => {
  it('upgrades persisted saved queries at the localStorage startup ingress (#166)', () => {
    const chart = { cfg: { type: 'pie', x: 0, y: [1], series: null }, key: 'k' };
    const s = createState(reader({ 'asb:saved': [
      { id: 's1', name: 'A', sql: '1', favorite: true, chart, view: 'chart' },
      { id: 's2', name: 'T', sql: '2', favorite: false, chart, view: 'table' },
    ] }));
    expect(queryPanel(s.savedQueries[0])).toEqual({ cfg: chart.cfg, key: 'k' });
    expect(queryView(s.savedQueries[0])).toBe('panel');
    // view:'table' + latent chart → lossless table panel with the roles stashed
    expect(queryPanel(s.savedQueries[1])).toEqual({ cfg: { type: 'table', chart: { ...chart.cfg, key: 'k' } } });
    expect(queryView(s.savedQueries[1])).toBe('table');
    expect('chart' in s.savedQueries[1]).toBe(false);
  });
  it('fails closed on future persisted Specs and retains diagnostics without rewriting input', () => {
    const stored = [{ id: 'future', sql: 'SELECT 1', specVersion: 9, spec: { future: true } }];
    const s = createState(reader({ [KEYS.saved]: stored }));
    expect(s.savedQueries).toEqual([]);
    expect(s.savedQueryLoadDiagnostics[0]).toMatchObject({
      path: [0, 'specVersion'], code: 'spec-version-unsupported',
    });
    expect(stored).toEqual([{ id: 'future', sql: 'SELECT 1', specVersion: 9, spec: { future: true } }]);
  });
  it('uses defaults', () => {
    const s = createState(reader());
    expect(s.theme).toBe('light');
    expect(s.sidebarPx).toBe(248);
    expect(s.editorPct).toBe(45);
    expect(s.sideSplitPct).toBe(58);
    expect(s.cellDrawerPx).toBe(560);
    expect(s.tabs.value).toHaveLength(1);
    expect(s.savedQueries).toEqual([]);
    expect(s.savedQueryLoadDiagnostics).toEqual([]);
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
  it('createSavedQuery is a no-op for empty SQL or empty name', () => {
    const s = createState(reader());
    const save = vi.fn();
    s.tabs.value[0].sqlDraft = '';
    expect(createSavedQuery(s, s.tabs.value[0], 'name', '', save)).toBeNull();
    s.tabs.value[0].sqlDraft = 'SELECT 1';
    expect(createSavedQuery(s, s.tabs.value[0], '  ', '', save)).toBeNull();
    expect(save).not.toHaveBeenCalled();
  });
  it('creates an unsaved query, then atomically commits linked SQL + authoritative Spec', () => {
    const s = createState(reader());
    const save = vi.fn();
    const tab = s.tabs.value[0];
    tab.sqlDraft = 'SELECT 1';
    const e1 = createSavedQuery(s, tab, 'My query', '', save, 100);
    expect(e1).toEqual(expect.objectContaining({ sql: 'SELECT 1', specVersion: 1 }));
    expect(e1.spec).toMatchObject({ name: 'My query', favorite: false });
    expect(tab.savedId).toBe(e1.id);
    expect(tab.name).toBe('My query');
    expect(s.savedQueries).toHaveLength(1);
    expect(save).toHaveBeenLastCalledWith(KEYS.saved, s.savedQueries);
    // Linked Save bypasses popover fields and commits the two drafts directly.
    tab.sqlDraft = 'SELECT 2';
    tab.specParsed.name = 'My query v2';
    tab.dirtySql = true; tab.dirtySpec = true;
    const e2 = commitSavedQuery(s, tab, tab.specParsed, save);
    expect(e2.id).toBe(e1.id);
    expect(s.savedQueries).toHaveLength(1);
    expect(s.savedQueries[0].sql).toBe('SELECT 2');
    expect(queryName(s.savedQueries[0])).toBe('My query v2');
    expect(tab.name).toBe('My query v2');
    expect(tabDirty(tab)).toBe(false);
  });
  it('creation stores a description and linked commits normalize/clear it', () => {
    const s = createState(reader());
    const save = vi.fn();
    const tab = s.tabs.value[0];
    tab.sqlDraft = 'SELECT 1';
    const e = createSavedQuery(s, tab, 'Q', '  what it does  ', save, 100); // trimmed
    expect(queryDescription(e)).toBe('what it does');
    tab.specParsed.description = ' changed ';
    commitSavedQuery(s, tab, tab.specParsed, save);
    expect(queryDescription(s.savedQueries[0])).toBe('changed');
    tab.specParsed.description = '   ';
    commitSavedQuery(s, tab, tab.specParsed, save);
    expect('description' in s.savedQueries[0].spec).toBe(false);
    // create with no description arg → no description field
    const t2 = newTabObj('t2'); t2.sqlDraft = 'SELECT 2'; s.tabs.value.push(t2);
    const e2 = createSavedQuery(s, t2, 'Q2', undefined, save, 400);
    expect('description' in e2.spec).toBe(false);
  });
  it('savedForTab resolves the linked entry (or null)', () => {
    const s = createState(reader());
    s.savedQueries = [savedQuery({ id: 's1', sql: 'x', name: 'n' })];
    s.tabs.value[0].savedId = 's1';
    s.tabs.value[0].editorMode = 'spec';
    expect(savedForTab(s, s.tabs.value[0])).toMatchObject({ id: 's1' });
    s.tabs.value[0].savedId = 'gone';
    expect(savedForTab(s, s.tabs.value[0])).toBeNull();
    expect(savedForTab(s, { savedId: null })).toBeNull();
  });
  it('renameSaved updates the entry + any linked tab name', () => {
    const s = createState(reader());
    s.savedQueries = [savedQuery({ id: 's1', sql: 'x', name: 'old' })];
    s.tabs.value[0].savedId = 's1';
    const save = vi.fn();
    renameSaved(s, 's1', '  new  ', undefined, save);
    expect(queryName(s.savedQueries[0])).toBe('new');
    expect(s.tabs.value[0].name).toBe('new');
    renameSaved(s, 's1', '   ', undefined, save); // blank ignored
    expect(queryName(s.savedQueries[0])).toBe('new');
    renameSaved(s, 'missing', 'x', undefined, save); // unknown id ignored
    expect(save).toHaveBeenCalledTimes(1);
  });
  it('renameSaved sets/clears description when given, leaves it untouched when undefined', () => {
    const s = createState(reader());
    s.savedQueries = [savedQuery({ id: 's1', sql: 'x', name: 'A' })];
    const save = vi.fn();
    renameSaved(s, 's1', 'A', '  a note  ', save); // set (trimmed)
    expect(queryDescription(s.savedQueries[0])).toBe('a note');
    renameSaved(s, 's1', 'A', undefined, save); // name-only → description kept
    expect(queryDescription(s.savedQueries[0])).toBe('a note');
    renameSaved(s, 's1', 'A', '', save); // explicit empty → cleared
    expect('description' in s.savedQueries[0].spec).toBe(false);
    renameSaved(s, 's1', 'A', '  re  ', save); // re-set
    expect(queryDescription(s.savedQueries[0])).toBe('re');
    renameSaved(s, 's1', 'A', null, save); // null (not undefined) → cleared, not stored as 'null' (#4 review)
    expect('description' in s.savedQueries[0].spec).toBe(false);
  });
  it('rename/description/favorite patches merge into valid linked drafts and persist once per action', () => {
    const s = createState(reader());
    const original = savedQuery({
      id: 's1', sql: 'x', name: 'Old', favorite: false,
      panel: { cfg: { type: 'table' }, fieldConfig: { defaults: { color: 'red' } } },
      dashboard: { role: 'panel', refresh: { interval: '30s' } },
      extension: { nested: [{ value: 1 }] },
    });
    s.savedQueries = [original];
    const tab = s.tabs.value[0];
    tab.savedId = 's1';
    setTabSpecDraft(tab, original.spec);
    tab.specParsed.extension.localDraft = true;
    tab.specParsed.draftOnly = { value: 2 };
    setTabSpecDraft(tab, tab.specParsed, { dirty: true });
    const second = newTabObj('t2');
    second.savedId = 's1';
    setTabSpecDraft(second, { ...original.spec, secondDraftOnly: ['keep'] });
    s.tabs.value = [tab, second];
    const save = vi.fn();
    renameSaved(s, 's1', 'New', 'Description', save);
    toggleFavorite(s, 's1', save);
    for (const spec of [s.savedQueries[0].spec, tab.specParsed]) {
      expect(spec).toMatchObject({
        name: 'New', description: 'Description', favorite: true,
        panel: { fieldConfig: { defaults: { color: 'red' } } },
        dashboard: { role: 'panel', refresh: { interval: '30s' } },
        extension: { nested: [{ value: 1 }] },
      });
    }
    expect(tab.specParsed.extension.localDraft).toBe(true);
    expect(tab.specParsed.draftOnly).toEqual({ value: 2 });
    expect(tab.dirtySpec).toBe(true);
    expect(second.specParsed).toMatchObject({
      name: 'New', description: 'Description', favorite: true, secondDraftOnly: ['keep'],
    });
    expect(second.dirtySpec).toBe(false);
    expect(save).toHaveBeenCalledTimes(2);
    expect(original.spec.name).toBe('Old');
    expect(original.spec.extension.nested[0].value).toBe(1);
  });
  it('toggleFavorite flips the flag; sortedSaved puts favorites first (stable)', () => {
    const s = createState(reader());
    s.savedQueries = [
      savedQuery({ id: 'a', sql: '1', name: 'A' }),
      savedQuery({ id: 'b', sql: '2', name: 'B' }),
      savedQuery({ id: 'c', sql: '3', name: 'C' }),
    ];
    const save = vi.fn();
    toggleFavorite(s, 'c', save);
    expect(queryFavorite(s.savedQueries.find((q) => q.id === 'c'))).toBe(true);
    toggleFavorite(s, 'missing', save); // no-op
    expect(sortedSaved(s).map((q) => q.id)).toEqual(['c', 'a', 'b']);
    expect(save).toHaveBeenCalledTimes(1);
  });
  it('invalid JSON blocks pencil/favorite persistence and identifies the affected tab', () => {
    const s = createState(reader());
    const tab = s.tabs.value[0];
    const entry = savedQuery({ id: 's1', name: 'Original', favorite: false, sql: 'SELECT 1' });
    s.savedQueries = [entry];
    tab.savedId = 's1';
    tab.specText = '{"name":';
    tab.specParsed = null;
    tab.specDiagnostics = [{ severity: 'error', code: 'invalid-json' }];
    tab.dirtySpec = true;
    const save = vi.fn();
    expect(renameSaved(s, 's1', 'Overwrite', undefined, save)).toMatchObject({ ok: false, invalidTab: tab });
    expect(toggleFavorite(s, 's1', save)).toMatchObject({ ok: false, invalidTab: tab });
    expect(queryName(s.savedQueries[0])).toBe('Original');
    expect(queryFavorite(s.savedQueries[0])).toBe(false);
    expect(save).not.toHaveBeenCalled();
  });
  it('external writers validate the persisted entry and every linked draft before mutating', () => {
    const s = createState(reader());
    const tab = s.tabs.value[0];
    s.savedQueries = [savedQuery({ id: 's1', name: 'Original', favorite: false, sql: 'SELECT 1' })];
    tab.savedId = 's1';
    setTabSpecDraft(tab, { ...s.savedQueries[0].spec, draftOnly: true }, { dirty: true });
    const save = vi.fn();
    const entryBlocked = { validate: () => [{ path: ['favorite'], severity: 'error', code: 'blocked', message: 'blocked' }] };
    expect(toggleFavorite(s, 's1', save, entryBlocked)).toMatchObject({ ok: false, invalidTab: null });
    expect(queryFavorite(s.savedQueries[0])).toBe(false);

    const draftBlocked = { validate: (spec) => spec.draftOnly
      ? [{ path: ['draftOnly'], severity: 'error', code: 'blocked-draft', message: 'blocked draft' }]
      : [] };
    expect(toggleFavorite(s, 's1', save, draftBlocked)).toMatchObject({ ok: false, invalidTab: tab });
    expect(queryFavorite(s.savedQueries[0])).toBe(false);
    expect(tab.specParsed.favorite).toBe(false);
    expect(save).not.toHaveBeenCalled();
  });
  it('patchSpecDraft handles object/function patches and reports a missing or invalid draft', () => {
    const tab = newTabObj('t1');
    tab.specParsed.extension = { keep: true };
    expect(patchSpecDraft(tab, { favorite: true }, { dirty: false })).toMatchObject({ ok: true, invalidTab: null });
    expect(tab.specParsed).toMatchObject({ favorite: true, extension: { keep: true } });
    expect(tab.dirtySpec).toBe(false);
    expect(patchSpecDraft(tab, (spec) => ({ ...spec, name: 'Patched' }))).toMatchObject({ ok: true });
    expect(tab.name).toBe('Patched');
    tab.specParsed = null;
    tab.specDiagnostics = [{ code: 'invalid-json' }];
    expect(patchSpecDraft(tab, { favorite: false })).toEqual({ ok: false, invalidTab: tab });
    expect(patchSpecDraft(null, {})).toEqual({ ok: false, invalidTab: null });
    tab.specText = 'null';
    tab.specDiagnostics = [{ code: 'root-object', severity: 'error' }];
    expect(patchSpecDraft(tab, { name: 'Recovered' })).toMatchObject({ ok: true });
    expect(tab.specParsed).toMatchObject({ name: 'Recovered' });
  });
  it('an invalid linked Spec makes atomic Save persist nothing and retain both dirty flags', () => {
    const s = createState(reader());
    const tab = s.tabs.value[0];
    s.savedQueries = [savedQuery({ id: 's1', name: 'Q', sql: 'SELECT 1' })];
    tab.savedId = 's1'; tab.sqlDraft = 'SELECT 2'; tab.dirtySql = true; tab.dirtySpec = true;
    const save = vi.fn();
    expect(commitSavedQuery(s, tab, { name: '  ', extension: true }, save)).toBeNull();
    expect(s.savedQueries[0].sql).toBe('SELECT 1');
    expect(tabDirty(tab)).toBe(true);
    expect(save).not.toHaveBeenCalled();
  });
  it("linked Save keeps the existing empty-SQL guard except for text panels", () => {
    const s = createState(reader());
    const tab = s.tabs.value[0];
    s.savedQueries = [savedQuery({ id: 's1', name: 'Q', sql: 'SELECT 1' })];
    tab.savedId = 's1'; tab.sqlDraft = ''; tab.dirtySql = true;
    const save = vi.fn();
    expect(commitSavedQuery(s, tab, { name: 'Q', favorite: false }, save)).toBeNull();
    expect(s.savedQueries[0].sql).toBe('SELECT 1');
    expect(save).not.toHaveBeenCalled();
    const textSpec = { name: 'Q', favorite: false, panel: { cfg: { type: 'text', content: 'note' } } };
    expect(commitSavedQuery(s, tab, textSpec, save)).not.toBeNull();
    expect(s.savedQueries[0].sql).toBe('');
  });
  it('filterSaved matches name/description/sql case-insensitively; blank → unchanged', () => {
    const list = [
      savedQuery({ id: 'a', name: 'Carrier delays', sql: 'SELECT carrier', description: 'worst delays' }),
      savedQuery({ id: 'b', name: 'Airports', sql: 'SELECT origin FROM flights' }),
      savedQuery({ id: 'c', name: 'Cancellations', sql: 'SELECT month' }),
    ];
    expect(filterSaved(list, '').map((q) => q.id)).toEqual(['a', 'b', 'c']);
    expect(filterSaved(list, '   ')).toBe(list); // blank → same reference, no copy
    expect(filterSaved(list, 'CARRIER').map((q) => q.id)).toEqual(['a']); // name + sql
    expect(filterSaved(list, 'delays').map((q) => q.id)).toEqual(['a']); // description
    expect(filterSaved(list, 'origin').map((q) => q.id)).toEqual(['b']); // sql
    expect(filterSaved(list, 'zzz')).toEqual([]);
  });
  it('filterSaved tolerates entries missing fields', () => {
    const list = [savedQuery({ id: 'x' }), savedQuery({ id: 'y', name: 'Yo' })];
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
    s.savedQueries = [savedQuery({ id: 's1', name: 'A', sql: '1' })];
    const save = vi.fn();
    const r = importSaved(s, [
      { id: 's1', name: 'A', sql: '1' },      // skip (content dup)
      { id: 's1', name: 'A2', sql: '1b' },    // update by id
      { name: 'B', sql: '2' },                // add (genId)
    ], save, () => 'gx');
    expect(r).toEqual({ added: 1, updated: 1, skipped: 1 });
    expect(s.savedQueries.map(queryName)).toEqual(['A2', 'B']);
    expect(s.savedQueries.find((q) => queryName(q) === 'B').id).toBe('gx');
    expect(save).toHaveBeenCalledWith(KEYS.saved, s.savedQueries);
    // default save + genId (no injection) — exercises the default id generator
    importSaved(s, [{ name: 'Z', sql: 'zz' }]);
    expect(s.savedQueries.find((q) => queryName(q) === 'Z').id).toMatch(/^s/);
  });
  it('tabPanel clones the complete tab-side panel, including future siblings', () => {
    expect(tabPanel(null)).toBeNull();
    expect(tabPanel(savedQuery())).toBeNull();
    const cfg = { type: 'bar', x: 0, y: [1], series: null };
    const tab = newTabObj('t1');
    setTabSpecDraft(tab, savedQuery({ panel: { cfg, key: 'k', fieldConfig: { defaults: {} } } }).spec);
    const panel = tabPanel(tab);
    expect(panel).toEqual({ cfg, key: 'k', fieldConfig: { defaults: {} } });
    expect(panel).not.toBe(tab.specParsed.panel);
  });
  it('creation/commit persist the complete panel without a legacy mirror', () => {
    const s = createState(reader());
    const save = vi.fn();
    const tab = s.tabs.value[0];
    tab.sqlDraft = 'SELECT a, b';
    tab.specParsed.panel = {
      cfg: { type: 'pie', x: 0, y: [1], series: null }, key: 'a:String|b:UInt64',
      fieldConfig: { defaults: { color: 'red' } },
    };
    const e1 = createSavedQuery(s, tab, 'Chartd', '', save, 100);
    expect(queryPanel(e1)).toEqual(tab.specParsed.panel);
    expect(queryPanel(e1)).not.toBe(tab.specParsed.panel);
    expect('chart' in e1).toBe(false);
    // re-save with a different cfg; future panel siblings remain.
    tab.specParsed.panel.cfg = { type: 'line', x: 0, y: [1], series: null };
    commitSavedQuery(s, tab, tab.specParsed, save);
    expect(queryPanel(s.savedQueries[0]).cfg.type).toBe('line');
    expect(queryPanel(s.savedQueries[0]).fieldConfig.defaults.color).toBe('red');
    tab.specParsed.panel.cfg = { type: 'logs' };
    commitSavedQuery(s, tab, tab.specParsed, save);
    expect(queryPanel(s.savedQueries[0]).cfg).toEqual({ type: 'logs' });
    // re-save after the whole panel is cleared.
    delete tab.specParsed.panel;
    commitSavedQuery(s, tab, tab.specParsed, save);
    expect(queryPanel(s.savedQueries[0])).toBeUndefined();
  });
  it("createSavedQuery allows sql:'' for a text panel only (#166 per-type save guard)", () => {
    const s = createState(reader());
    const save = vi.fn();
    const tab = s.tabs.value[0];
    tab.sqlDraft = '';
    expect(createSavedQuery(s, tab, 'NoSql', '', save, 100)).toBeNull(); // no panel → still blocked
    tab.specParsed.panel = { cfg: { type: 'table' } };
    expect(createSavedQuery(s, tab, 'NoSql', '', save, 150)).toBeNull(); // non-text panel → blocked
    tab.specParsed.panel = { cfg: { type: 'text', content: '# hello' } };
    const e = createSavedQuery(s, tab, 'Note', '', save, 200);
    expect(e).not.toBeNull();
    expect(e.sql).toBe('');
    expect(queryPanel(e).cfg).toEqual({ type: 'text', content: '# hello' });
    expect(e.chart).toBeUndefined();
  });
  it('creation captures the result view; linked Spec becomes authoritative afterward', () => {
    const s = createState(reader());
    const save = vi.fn();
    const tab = s.tabs.value[0];
    tab.sqlDraft = 'SELECT 1';
    s.resultView.value = 'panel';
    const e = createSavedQuery(s, tab, 'V', '', save, 100);
    expect(queryView(e)).toBe('panel');
    tab.specParsed.view = 'json';
    commitSavedQuery(s, tab, tab.specParsed, save);
    expect(queryView(s.savedQueries[0])).toBe('json');
    // raw view (TSV/JSON output) is not a saved view → dropped
    delete tab.specParsed.view;
    commitSavedQuery(s, tab, tab.specParsed, save);
    expect(queryView(s.savedQueries[0])).toBeUndefined();
  });
  it('deleteSaved removes + clears tab pointers', () => {
    const s = createState(reader());
    s.savedQueries = [savedQuery({ id: 's1', sql: 'x', name: 'n' })];
    s.tabs.value[0].savedId = 's1';
    const save = vi.fn();
    deleteSaved(s, 's1', save);
    expect(s.savedQueries).toHaveLength(0);
    expect(s.tabs.value[0].savedId).toBeNull();
    expect(s.tabs.value[0].editorMode).toBe('sql');
    expect(save).toHaveBeenCalledWith(KEYS.saved, []);
  });
});

describe('library document', () => {
  it('dirty flag: saved-query mutations set it; markLibrarySaved clears it', () => {
    const s = createState(reader());
    const tab = s.tabs.value[0]; tab.sqlDraft = 'SELECT 1';
    expect(s.libraryDirty.value).toBe(false);
    createSavedQuery(s, tab, 'Q', '', vi.fn());
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
    s.savedQueries = [savedQuery({ id: 's1', name: 'A', sql: '1' })];
    s.libraryName.value = 'Old'; s.libraryDirty.value = true;
    s.tabs.value[0].savedId = 's1';                            // dangling after clear → pruned
    s.tabs.value[0].editorMode = 'spec';
    s.tabs.value.push(newTabObj('t2'));                        // no savedId → skipped by prune
    const save = vi.fn(), saveName = vi.fn();
    newLibrary(s, save, saveName);
    expect(s.savedQueries).toEqual([]);
    expect(s.libraryName.value).toBe(DEFAULT_LIBRARY_NAME);
    expect(s.libraryDirty.value).toBe(false);
    expect(s.tabs.value[0].savedId).toBeNull();
    expect(s.tabs.value[0].editorMode).toBe('sql');
    expect(save).toHaveBeenCalledWith(KEYS.saved, []);
    expect(saveName).toHaveBeenCalledWith(KEYS.libraryName, DEFAULT_LIBRARY_NAME);
  });

  it('replaceLibrary keeps ids (mints for id-less), carries metadata, adopts the base name, clears dirty, prunes links', () => {
    const s = createState(reader());
    s.savedQueries = [savedQuery({ id: 'old', name: 'X', sql: 'x' })];
    s.tabs.value[0].savedId = 'old';                           // becomes dangling → pruned
    s.tabs.value[0].editorMode = 'spec';
    s.libraryDirty.value = true;
    const chart = { cfg: { type: 'bar', x: 0, y: [1], series: null }, key: 'k' };
    const incoming = [
      { id: 'keep', name: 'A', sql: '1', favorite: true, description: 'd', chart, view: 'json' },
      { name: 'B', sql: '2', favorite: false },          // id-less → genId
      { id: 'txt', name: 'N', sql: '', favorite: false, panel: { cfg: { type: 'text', content: 'x' } } },
    ];
    let n = 0;
    const save = vi.fn(), saveName = vi.fn();
    replaceLibrary(s, incoming, 'My Library.json', save, saveName, () => 'g' + (++n));
    expect(s.savedQueries.map((q) => q.id)).toEqual(['keep', 'g1', 'txt']);
    expect(s.savedQueries[0].sql).toBe('1');
    expect(s.savedQueries[0].spec).toEqual({
      name: 'A', favorite: true, description: 'd',
      panel: { cfg: chart.cfg, key: 'k' }, view: 'json',
    });
    expect(queryPanel(s.savedQueries[2])).toEqual({ cfg: { type: 'text', content: 'x' } });
    expect('chart' in s.savedQueries[2]).toBe(false);
    expect(s.libraryName.value).toBe('My Library');            // extension stripped
    expect(s.libraryDirty.value).toBe(false);
    expect(s.tabs.value[0].savedId).toBeNull();
    expect(s.tabs.value[0].editorMode).toBe('sql');
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

  it('Replace and Append reject invalid Specs before any Library mutation', () => {
    const s = createState(reader());
    s.savedQueries = [savedQuery({ id: 'existing', name: 'Existing', sql: 'SELECT 1' })];
    s.libraryName.value = 'Before';
    s.libraryDirty.value = false;
    const save = vi.fn(), saveName = vi.fn();
    const invalid = [savedQuery({ id: 'bad', name: 'Bad', panel: { cfg: { type: 'line', x: 0, y: [] } } })];
    expect(() => replaceLibrary(s, invalid, 'after.json', save, saveName)).toThrow('panel.cfg.y');
    expect(() => appendLibrary(s, invalid, save)).toThrow('panel.cfg.y');
    expect(s.savedQueries.map((query) => query.id)).toEqual(['existing']);
    expect(s.libraryName.value).toBe('Before');
    expect(s.libraryDirty.value).toBe(false);
    expect(save).not.toHaveBeenCalled();
    expect(saveName).not.toHaveBeenCalled();
  });

  it('appendLibrary merges via importSaved (dedupe), returns counts, sets dirty', () => {
    const s = createState(reader());
    s.savedQueries = [savedQuery({ id: 's1', name: 'A', sql: '1' })];
    const r = appendLibrary(s, [
      { id: 's1', name: 'A', sql: '1' },                 // content dup → skip
      { name: 'B', sql: '2' },                           // add
    ], vi.fn(), () => 'gb');
    expect(r).toEqual({ added: 1, updated: 0, skipped: 1 });
    expect(s.savedQueries.map(queryName)).toEqual(['A', 'B']);
    expect(s.libraryDirty.value).toBe(true);
  });

  it('library ops default their persistence seams (real storage helpers)', () => {
    vi.stubGlobal('localStorage', memStore());
    const s = createState(reader());
    s.tabs.value[0].sqlDraft = 'SELECT 1';
    const e = createSavedQuery(s, s.tabs.value[0], 'Q'); // default save/now/description
    renameLibrary(s, 'Lib');                // default saveName
    replaceLibrary(s, [{ id: e.id, name: 'Q', sql: 'SELECT 1' }], 'f.json'); // default seams
    newLibrary(s);                          // default seams
    appendLibrary(s, [{ name: 'Z', sql: 'z' }]); // default seam
    expect(s.savedQueries.some((q) => queryName(q) === 'Z')).toBe(true);
  });
});

describe('history', () => {
  const tab = (over = {}) => ({
    sqlDraft: 'SELECT 1',
    result: { rawText: null, rows: [[1], [2]], progress: { elapsed_ns: 5e6 } },
    ...over,
  });

  it('recordHistory skips empty/nullish sql', () => {
    const s = createState(reader());
    const save = vi.fn();
    recordHistory(s, tab({ sqlDraft: '  ' }), save);
    recordHistory(s, tab({ sqlDraft: null }), save);
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
  it('recordHistory records sqlText override (selection run) over tab.sqlDraft', () => {
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
  it('createSavedQuery/renameSaved/toggleFavorite/deleteSaved/recordHistory/clearHistory persist via storage by default', () => {
    const s = createState(reader());
    // Exercises the default saveJSON path (writes to happy-dom localStorage).
    s.tabs.value[0].sqlDraft = 'SELECT 9';
    const e = createSavedQuery(s, s.tabs.value[0], 'nine');
    renameSaved(s, e.id, 'nine!');
    toggleFavorite(s, e.id);
    recordHistory(s, { sqlDraft: 'SELECT 9', result: { rawText: null, rows: [], progress: { elapsed_ns: 0 } } });
    deleteSaved(s, 'nope');
    deleteHistory(s, 'nope');
    clearHistory(s);
    expect(s.history).toEqual([]);
  });
});
