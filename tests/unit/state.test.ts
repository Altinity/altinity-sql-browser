import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  KEYS, DEFAULT_LIBRARY_NAME, newTabObj, createState, activeTab, allocTabId, effectiveFilterActive,
  createSavedQuery, commitSavedQuery, savedForTab, renameSaved, toggleFavorite,
  sortedSaved, filterSaved, filterHistory, deleteSaved, recordHistory,
  recordScriptHistory, clearHistory, deleteHistory, tabPanel, setTabSpecDraft, patchSpecDraft, tabDirty,
} from '../../src/state.js';
import type {
  StateReader, HistoryResultSnapshot, HistoryEntry, QueryTab, SpecValidationService, AppState, SavedEntryResult,
} from '../../src/state.js';
import { queryDescription, queryFavorite, queryName, queryPanel, queryView } from '../../src/core/saved-query.js';
import { savedQuery as savedQueryUntyped } from '../helpers/saved-query.js';
import type { DashboardDocumentV1, SavedQueryV2 } from '../../src/generated/json-schema.types.js';
import { fakeWorkspaceCommit } from '../helpers/fake-app.js';

afterEach(() => vi.unstubAllGlobals());

function memStore(initial: Record<string, string> = {}) {
  const m = new Map(Object.entries(initial));
  return { getItem: (k: string) => (m.has(k) ? m.get(k) : null), setItem: (k: string, v: unknown) => m.set(k, String(v)) };
}

const reader = (over: Record<string, unknown> = {}): StateReader => ({
  loadStr: (k, dflt) => (k in over ? (over[k] as string) : dflt),
  loadJSON: (k, dflt) => (k in over ? over[k] : dflt),
});

// #287 W4: the saved-query CRUD ops now commit through the StoredWorkspaceV1
// aggregate, whose schema requires a non-empty workspace id — every test
// below that exercises them builds its state through this helper (instead of
// bare `createState(reader())`) so the candidate a real `fakeWorkspaceCommit()`
// validates always has one.
function savedTestState(over: Record<string, unknown> = {}): AppState {
  const s = createState(reader(over));
  s.workspaceId = 'w1';
  return s;
}

// #299: toggleFavorite now takes an injected tile-id generator (only called
// when it actually appends a tile) — a fresh counter per call keeps ids
// distinct within a test without pulling in a real crypto/uid seam.
const genTileId = (): (() => string) => {
  let n = 0;
  return () => 'tile-' + (++n);
};

/** Unwrap a successful `SavedEntryResult`, failing loudly (not silently
 *  returning `undefined`) when a test's own setup produced a rejection —
 *  mirrors the pre-#287 sync code's `!`-asserted non-null return. */
function okEntry(r: SavedEntryResult): SavedQueryV2 {
  if (!r.ok) throw new Error('expected an ok SavedEntryResult, got: ' + JSON.stringify(r));
  return r.entry;
}

// tests/helpers/saved-query.js is plain JS with no field annotations; TS can
// only infer a parameter type for the fields carrying their own default
// value (favorite/name/spec/sql) off the outer `= {}` default, so calling it
// with the id/description/view/panel/dashboard/extension fields these tests
// pass would fail excess-property checks at each of the ~20 call sites below.
// This wrapper pins the fixture's actual (untyped, arbitrary-shaped) input
// bag and the real SavedQueryV2 it always returns, once, for readability.
const savedQuery = (args: Record<string, unknown> = {}): SavedQueryV2 =>
  savedQueryUntyped(args as Parameters<typeof savedQueryUntyped>[0]) as SavedQueryV2;

describe('newTabObj', () => {
  it('creates a blank tab', () => {
    expect(newTabObj('t9')).toEqual({
      id: 't9', name: 'Untitled', sqlDraft: '', specVersion: 1,
      specText: '{\n  "name": "Untitled",\n  "favorite": false\n}',
      specParsed: { name: 'Untitled', favorite: false }, specDiagnostics: [],
      editorMode: 'sql', dirtySql: false, dirtySpec: false,
      result: null, filterPreview: null, lastSuccessfulResultColumns: [], savedId: null,
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
    expect(s.docPanePx).toBe(420); // #313 — a sibling default, independent of cellDrawerPx
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
    // #287 W4: no aggregate loaded yet — `dashboard` starts null;
    // `loadWorkspaceOnBoot` (app.ts's async boot step) projects the real
    // aggregate onto both after this synchronous constructor. `workspaceId`
    // is minted synchronously (never blank — the stored-workspace schema
    // requires a non-empty id) so a save attempted before boot projection
    // completes still succeeds; `loadWorkspaceOnBoot` overwrites it with the
    // real committed id once resolved.
    expect(s.dashboard).toBeNull();
    expect(s.workspaceId).toMatch(/^ws-/);
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
      [KEYS.docPanePx]: '50', // clamps up to the 320 floor, independent of cellDrawerPx
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
    expect(s.docPanePx).toBe(320); // #313
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
  it('createSavedQuery is a no-op for empty SQL or empty name', async () => {
    const s = savedTestState();
    const commit = fakeWorkspaceCommit();
    s.tabs.value[0].sqlDraft = '';
    expect(await createSavedQuery(s, s.tabs.value[0], 'name', '', commit)).toEqual({ ok: false, entry: null });
    s.tabs.value[0].sqlDraft = 'SELECT 1';
    expect(await createSavedQuery(s, s.tabs.value[0], '  ', '', commit)).toEqual({ ok: false, entry: null });
    expect(commit).not.toHaveBeenCalled();
  });
  it('creates an unsaved query, then atomically commits linked SQL + authoritative Spec', async () => {
    const s = savedTestState();
    const commit = fakeWorkspaceCommit();
    const tab = s.tabs.value[0];
    tab.sqlDraft = 'SELECT 1';
    // This Save path is guaranteed `ok: true` here (linked-tab creation with a
    // non-empty name and sql, asserted just below) — same invariant state.ts
    // itself documents at its own `!` sites, now via `okEntry`'s explicit throw.
    const e1 = okEntry(await createSavedQuery(s, tab, 'My query', '', commit, 100));
    expect(e1).toEqual(expect.objectContaining({ sql: 'SELECT 1', specVersion: 1 }));
    expect(e1.spec).toMatchObject({ name: 'My query', favorite: false });
    expect(tab.savedId).toBe(e1.id);
    expect(tab.name).toBe('My query');
    expect(s.savedQueries).toHaveLength(1);
    expect(commit).toHaveBeenCalledTimes(1);
    // Linked Save bypasses popover fields and commits the two drafts directly.
    tab.sqlDraft = 'SELECT 2';
    tab.specParsed!.name = 'My query v2';
    tab.dirtySql = true; tab.dirtySpec = true;
    const e2 = okEntry(await commitSavedQuery(s, tab, tab.specParsed, commit));
    expect(e2.id).toBe(e1.id);
    expect(s.savedQueries).toHaveLength(1);
    expect(s.savedQueries[0].sql).toBe('SELECT 2');
    expect(queryName(s.savedQueries[0])).toBe('My query v2');
    expect(tab.name).toBe('My query v2');
    expect(tabDirty(tab)).toBe(false);
  });
  it('creation stores a description and linked commits normalize/clear it', async () => {
    const s = savedTestState();
    const commit = fakeWorkspaceCommit();
    const tab = s.tabs.value[0];
    tab.sqlDraft = 'SELECT 1';
    const e = okEntry(await createSavedQuery(s, tab, 'Q', '  what it does  ', commit, 100)); // trimmed
    expect(queryDescription(e)).toBe('what it does');
    tab.specParsed!.description = ' changed ';
    await commitSavedQuery(s, tab, tab.specParsed, commit);
    expect(queryDescription(s.savedQueries[0])).toBe('changed');
    tab.specParsed!.description = '   ';
    await commitSavedQuery(s, tab, tab.specParsed, commit);
    expect('description' in s.savedQueries[0].spec).toBe(false);
    // create with no description arg → no description field
    const t2 = newTabObj('t2'); t2.sqlDraft = 'SELECT 2'; s.tabs.value.push(t2);
    const e2 = okEntry(await createSavedQuery(s, t2, 'Q2', undefined, commit, 400));
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
  it('renameSaved updates the entry + any linked tab name', async () => {
    const s = savedTestState();
    s.savedQueries = [savedQuery({ id: 's1', sql: 'x', name: 'old' })];
    s.tabs.value[0].savedId = 's1';
    const commit = fakeWorkspaceCommit();
    await renameSaved(s, 's1', '  new  ', undefined, commit);
    expect(queryName(s.savedQueries[0])).toBe('new');
    expect(s.tabs.value[0].name).toBe('new');
    await renameSaved(s, 's1', '   ', undefined, commit); // blank ignored
    expect(queryName(s.savedQueries[0])).toBe('new');
    await renameSaved(s, 'missing', 'x', undefined, commit); // unknown id ignored
    expect(commit).toHaveBeenCalledTimes(1);
  });
  it('renameSaved sets/clears description when given, leaves it untouched when undefined', async () => {
    const s = savedTestState();
    s.savedQueries = [savedQuery({ id: 's1', sql: 'x', name: 'A' })];
    const commit = fakeWorkspaceCommit();
    await renameSaved(s, 's1', 'A', '  a note  ', commit); // set (trimmed)
    expect(queryDescription(s.savedQueries[0])).toBe('a note');
    await renameSaved(s, 's1', 'A', undefined, commit); // name-only → description kept
    expect(queryDescription(s.savedQueries[0])).toBe('a note');
    await renameSaved(s, 's1', 'A', '', commit); // explicit empty → cleared
    expect('description' in s.savedQueries[0].spec).toBe(false);
    await renameSaved(s, 's1', 'A', '  re  ', commit); // re-set
    expect(queryDescription(s.savedQueries[0])).toBe('re');
    await renameSaved(s, 's1', 'A', null, commit); // null (not undefined) → cleared, not stored as 'null' (#4 review)
    expect('description' in s.savedQueries[0].spec).toBe(false);
  });
  it('rename/description/favorite patches merge into valid linked drafts and persist once per action', async () => {
    const s = savedTestState();
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
    // `extension`/`draftOnly` ride the Spec's index signature (arbitrary
    // forward-compatible fields) — QuerySpecV1 types them `unknown`, so a
    // one-off local cast reads/writes the exact shape this fixture uses.
    (tab.specParsed!.extension as { localDraft?: boolean }).localDraft = true;
    tab.specParsed!.draftOnly = { value: 2 };
    setTabSpecDraft(tab, tab.specParsed!, { dirty: true });
    const second = newTabObj('t2');
    second.savedId = 's1';
    setTabSpecDraft(second, { ...original.spec, secondDraftOnly: ['keep'] });
    s.tabs.value = [tab, second];
    const commit = fakeWorkspaceCommit();
    await renameSaved(s, 's1', 'New', 'Description', commit);
    await toggleFavorite(s, 's1', commit, genTileId());
    for (const spec of [s.savedQueries[0].spec, tab.specParsed]) {
      expect(spec).toMatchObject({
        name: 'New', description: 'Description', favorite: true,
        panel: { fieldConfig: { defaults: { color: 'red' } } },
        dashboard: { role: 'panel', refresh: { interval: '30s' } },
        extension: { nested: [{ value: 1 }] },
      });
    }
    expect((tab.specParsed!.extension as { localDraft?: boolean }).localDraft).toBe(true);
    expect(tab.specParsed!.draftOnly).toEqual({ value: 2 });
    expect(tab.dirtySpec).toBe(true);
    expect(second.specParsed).toMatchObject({
      name: 'New', description: 'Description', favorite: true, secondDraftOnly: ['keep'],
    });
    expect(second.dirtySpec).toBe(false);
    expect(commit).toHaveBeenCalledTimes(2);
    expect(original.spec.name).toBe('Old');
    expect((original.spec.extension as { nested: { value: number }[] }).nested[0].value).toBe(1);
  });
  it('toggleFavorite flips the flag; sortedSaved puts favorites first (stable)', async () => {
    const s = savedTestState();
    s.savedQueries = [
      savedQuery({ id: 'a', sql: '1', name: 'A' }),
      savedQuery({ id: 'b', sql: '2', name: 'B' }),
      savedQuery({ id: 'c', sql: '3', name: 'C' }),
    ];
    const commit = fakeWorkspaceCommit();
    await toggleFavorite(s, 'c', commit, genTileId());
    expect(queryFavorite(s.savedQueries.find((q) => q.id === 'c'))).toBe(true);
    await toggleFavorite(s, 'missing', commit, genTileId()); // no-op
    expect(sortedSaved(s).map((q) => q.id)).toEqual(['c', 'a', 'b']);
    expect(commit).toHaveBeenCalledTimes(1);
  });
  // #299: the Workbench star also drives Dashboard tile membership, atomically
  // with the favorite flip — only panel-role queries become tiles (mirrors
  // legacy-migration.ts's buildLegacyMigrationCandidate), star OFF removes
  // every matching tile and scrubs those tile ids from filter targets (mirrors
  // saved-query-mutation.ts's removeAffectedTiles), and a null `state.dashboard`
  // means favorite-flip-only (no Dashboard to touch).
  describe('toggleFavorite wires Dashboard tile membership (#299)', () => {
    const blankDashboard = (): DashboardDocumentV1 => ({
      documentVersion: 1, id: 'dash', title: 'D', revision: 1,
      layout: { type: 'flow', version: 1, preset: 'report', items: {} },
      filters: [], tiles: [],
    });

    it('favorite ON on a panel-role query appends a tile in the same commit', async () => {
      const s = savedTestState();
      s.savedQueries = [savedQuery({ id: 'p1', sql: 'SELECT 1', dashboard: { role: 'panel' } })];
      s.dashboard = blankDashboard();
      const commit = fakeWorkspaceCommit();
      const result = await toggleFavorite(s, 'p1', commit, genTileId());
      expect(result).toMatchObject({ ok: true });
      expect(queryFavorite(s.savedQueries[0])).toBe(true);
      expect(s.dashboard!.tiles).toEqual([{ id: 'tile-1', queryId: 'p1' }]);
      expect(commit).toHaveBeenCalledTimes(1);
    });

    it('favorite ON is idempotent when a tile already references the query', async () => {
      const s = savedTestState();
      s.savedQueries = [savedQuery({ id: 'p1', sql: 'SELECT 1', favorite: false, dashboard: { role: 'panel' } })];
      s.dashboard = { ...blankDashboard(), tiles: [{ id: 't1', queryId: 'p1' }] };
      const commit = fakeWorkspaceCommit();
      await toggleFavorite(s, 'p1', commit, genTileId());
      expect(queryFavorite(s.savedQueries[0])).toBe(true);
      expect(s.dashboard!.tiles).toEqual([{ id: 't1', queryId: 'p1' }]); // no duplicate
    });

    it('favorite ON on a filter-role query never creates a tile', async () => {
      const s = savedTestState();
      s.savedQueries = [savedQuery({ id: 'f1', sql: "SELECT ['a','b'] AS country", dashboard: { role: 'filter' } })];
      s.dashboard = blankDashboard();
      const commit = fakeWorkspaceCommit();
      const result = await toggleFavorite(s, 'f1', commit, genTileId());
      expect(result).toMatchObject({ ok: true });
      expect(queryFavorite(s.savedQueries[0])).toBe(true);
      expect(s.dashboard!.tiles).toEqual([]);
    });

    it('favorite OFF removes every tile referencing the query and scrubs filter targets', async () => {
      const s = savedTestState();
      s.savedQueries = [
        savedQuery({ id: 'p1', sql: 'SELECT a WHERE c={country:String}', favorite: true, dashboard: { role: 'panel' } }),
        savedQuery({ id: 'f1', sql: "SELECT ['a','b'] AS country", dashboard: { role: 'filter' } }),
      ];
      s.dashboard = {
        ...blankDashboard(),
        tiles: [{ id: 't1', queryId: 'p1' }],
        filters: [{ id: 'flt', parameter: 'country', sourceQueryId: 'f1', targets: ['t1'] }],
      };
      const commit = fakeWorkspaceCommit();
      const result = await toggleFavorite(s, 'p1', commit, genTileId());
      expect(result).toMatchObject({ ok: true });
      expect(queryFavorite(s.savedQueries[0])).toBe(false);
      expect(s.dashboard!.tiles).toEqual([]);
      expect(s.dashboard!.filters[0].targets).toEqual([]);
      expect(commit).toHaveBeenCalledTimes(1);
    });

    it('a null state.dashboard means favorite flip only — no tile change, no crash', async () => {
      const s = savedTestState();
      s.savedQueries = [savedQuery({ id: 'p1', sql: 'SELECT 1', dashboard: { role: 'panel' } })];
      expect(s.dashboard).toBeNull();
      const commit = fakeWorkspaceCommit();
      const result = await toggleFavorite(s, 'p1', commit, genTileId());
      expect(result).toMatchObject({ ok: true });
      expect(queryFavorite(s.savedQueries[0])).toBe(true);
      expect(s.dashboard).toBeNull();
    });
  });
  it('invalid JSON blocks pencil/favorite persistence and identifies the affected tab', async () => {
    const s = savedTestState();
    const tab = s.tabs.value[0];
    const entry = savedQuery({ id: 's1', name: 'Original', favorite: false, sql: 'SELECT 1' });
    s.savedQueries = [entry];
    tab.savedId = 's1';
    tab.specText = '{"name":';
    tab.specParsed = null;
    tab.specDiagnostics = [{ severity: 'error', code: 'invalid-json', message: 'invalid JSON' }];
    tab.dirtySpec = true;
    const commit = fakeWorkspaceCommit();
    expect(await renameSaved(s, 's1', 'Overwrite', undefined, commit)).toMatchObject({ ok: false, invalidTab: tab });
    expect(await toggleFavorite(s, 's1', commit, genTileId())).toMatchObject({ ok: false, invalidTab: tab });
    expect(queryName(s.savedQueries[0])).toBe('Original');
    expect(queryFavorite(s.savedQueries[0])).toBe(false);
    expect(commit).not.toHaveBeenCalled();
  });
  it('external writers validate the persisted entry and every linked draft before mutating', async () => {
    const s = savedTestState();
    const tab = s.tabs.value[0];
    s.savedQueries = [savedQuery({ id: 's1', name: 'Original', favorite: false, sql: 'SELECT 1' })];
    tab.savedId = 's1';
    setTabSpecDraft(tab, { ...s.savedQueries[0].spec, draftOnly: true }, { dirty: true });
    const commit = fakeWorkspaceCommit();
    const entryBlocked: SpecValidationService = {
      validate: () => [{ path: ['favorite'], severity: 'error', code: 'blocked', message: 'blocked' }],
    };
    expect(await toggleFavorite(s, 's1', commit, genTileId(), entryBlocked)).toMatchObject({ ok: false, invalidTab: null });
    expect(queryFavorite(s.savedQueries[0])).toBe(false);

    const draftBlocked: SpecValidationService = {
      validate: (spec) => (spec as { draftOnly?: unknown }).draftOnly
        ? [{ path: ['draftOnly'], severity: 'error', code: 'blocked-draft', message: 'blocked draft' }]
        : [],
    };
    expect(await toggleFavorite(s, 's1', commit, genTileId(), draftBlocked)).toMatchObject({ ok: false, invalidTab: tab });
    expect(queryFavorite(s.savedQueries[0])).toBe(false);
    expect(tab.specParsed!.favorite).toBe(false);
    expect(commit).not.toHaveBeenCalled();
  });
  it('a rejected aggregate commit mutates nothing and surfaces diagnostics (#287 W4 strict commit)', async () => {
    const s = savedTestState();
    const tab = s.tabs.value[0];
    tab.sqlDraft = 'SELECT 1';
    const diagnostics = [{ path: ['id'], severity: 'error' as const, code: 'test-fail', message: 'boom' }];
    const failingCommit = vi.fn(async () => ({ ok: false as const, diagnostics }));
    const result = await createSavedQuery(s, tab, 'Q', '', failingCommit, 100);
    expect(result).toEqual({ ok: false, entry: null, diagnostics });
    expect(s.savedQueries).toEqual([]);
    expect(tab.savedId).toBeNull();
    expect(s.libraryDirty.value).toBe(false);
    expect(failingCommit).toHaveBeenCalledTimes(1);
  });
  it('a rejected aggregate commit leaves renameSaved/toggleFavorite/deleteSaved fully untouched', async () => {
    const s = savedTestState();
    const tab = s.tabs.value[0];
    const entry = savedQuery({ id: 's1', name: 'Original', favorite: false, sql: 'SELECT 1' });
    s.savedQueries = [entry];
    tab.savedId = 's1';
    const diagnostics = [{ path: [], severity: 'error' as const, code: 'test-fail', message: 'nope' }];
    const failingCommit = async () => ({ ok: false as const, diagnostics });

    const renamed = await renameSaved(s, 's1', 'New name', undefined, failingCommit);
    expect(renamed).toEqual({ ok: false, invalidTab: null, entry: null, diagnostics: expect.any(Array) });
    expect(queryName(s.savedQueries[0])).toBe('Original');

    const favorited = await toggleFavorite(s, 's1', failingCommit, genTileId());
    expect(favorited).toMatchObject({ ok: false, invalidTab: null, entry: null });
    expect(queryFavorite(s.savedQueries[0])).toBe(false);

    const deleted = await deleteSaved(s, 's1', failingCommit);
    expect(deleted).toEqual({ ok: false, diagnostics });
    expect(s.savedQueries).toHaveLength(1);
    expect(tab.savedId).toBe('s1');
    expect(s.libraryDirty.value).toBe(false);
  });
  it('patchSpecDraft handles object/function patches and reports a missing or invalid draft', () => {
    const tab = newTabObj('t1');
    tab.specParsed!.extension = { keep: true };
    expect(patchSpecDraft(tab, { favorite: true }, { dirty: false })).toMatchObject({ ok: true, invalidTab: null });
    expect(tab.specParsed).toMatchObject({ favorite: true, extension: { keep: true } });
    expect(tab.dirtySpec).toBe(false);
    expect(patchSpecDraft(tab, (spec) => ({ ...spec, name: 'Patched' }))).toMatchObject({ ok: true });
    expect(tab.name).toBe('Patched');
    tab.specParsed = null;
    tab.specDiagnostics = [{ code: 'invalid-json', message: 'invalid JSON' }];
    expect(patchSpecDraft(tab, { favorite: false })).toEqual({ ok: false, invalidTab: tab });
    expect(patchSpecDraft(null, {})).toEqual({ ok: false, invalidTab: null });
    tab.specText = 'null';
    tab.specDiagnostics = [{ code: 'root-object', severity: 'error', message: 'root must be an object' }];
    expect(patchSpecDraft(tab, { name: 'Recovered' })).toMatchObject({ ok: true });
    expect(tab.specParsed).toMatchObject({ name: 'Recovered' });
  });
  it('an invalid linked Spec makes atomic Save persist nothing and retain both dirty flags', async () => {
    const s = savedTestState();
    const tab = s.tabs.value[0];
    s.savedQueries = [savedQuery({ id: 's1', name: 'Q', sql: 'SELECT 1' })];
    tab.savedId = 's1'; tab.sqlDraft = 'SELECT 2'; tab.dirtySql = true; tab.dirtySpec = true;
    const commit = fakeWorkspaceCommit();
    expect(await commitSavedQuery(s, tab, { name: '  ', extension: true }, commit)).toEqual({ ok: false, entry: null });
    expect(s.savedQueries[0].sql).toBe('SELECT 1');
    expect(tabDirty(tab)).toBe(true);
    expect(commit).not.toHaveBeenCalled();
  });
  it("linked Save keeps the existing empty-SQL guard except for text panels", async () => {
    const s = savedTestState();
    const tab = s.tabs.value[0];
    s.savedQueries = [savedQuery({ id: 's1', name: 'Q', sql: 'SELECT 1' })];
    tab.savedId = 's1'; tab.sqlDraft = ''; tab.dirtySql = true;
    const commit = fakeWorkspaceCommit();
    expect(await commitSavedQuery(s, tab, { name: 'Q', favorite: false }, commit)).toEqual({ ok: false, entry: null });
    expect(s.savedQueries[0].sql).toBe('SELECT 1');
    expect(commit).not.toHaveBeenCalled();
    const textSpec = { name: 'Q', favorite: false, panel: { cfg: { type: 'text', content: 'note' } } };
    expect((await commitSavedQuery(s, tab, textSpec, commit)).ok).toBe(true);
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
    const list = [
      { id: 'h1', sql: 'SELECT 1' }, { id: 'h2', sql: 'INSERT INTO t' }, { id: 'h3' },
    ] as HistoryEntry[];
    expect(filterHistory(list, '')).toBe(list);
    expect(filterHistory(list, 'insert').map((h) => h.id)).toEqual(['h2']);
    expect(filterHistory(list, 'zzz')).toEqual([]);
  });
  it('tabPanel clones the complete tab-side panel, including future siblings', () => {
    expect(tabPanel(null)).toBeNull();
    // A truthy object with no `specParsed` at all (a bare saved-query entry,
    // not a tab) — tabPanel must tolerate it exactly like a null/undefined
    // tab rather than throwing. `Partial<QueryTab>` is genuinely comparable
    // to the fixture's actual shape (unlike an unrelated type), so a single
    // `as` documents the intentional non-tab shape without an `unknown` bridge.
    expect(tabPanel(savedQuery() as Partial<QueryTab> as Pick<QueryTab, 'specParsed'>)).toBeNull();
    const cfg = { type: 'bar', x: 0, y: [1], series: null };
    const tab = newTabObj('t1');
    setTabSpecDraft(tab, savedQuery({ panel: { cfg, key: 'k', fieldConfig: { defaults: {} } } }).spec);
    const panel = tabPanel(tab);
    expect(panel).toEqual({ cfg, key: 'k', fieldConfig: { defaults: {} } });
    expect(panel).not.toBe(tab.specParsed!.panel);
  });
  it('creation/commit persist the complete panel without a legacy mirror', async () => {
    const s = savedTestState();
    const commit = fakeWorkspaceCommit();
    const tab = s.tabs.value[0];
    tab.sqlDraft = 'SELECT a, b';
    tab.specParsed!.panel = {
      cfg: { type: 'pie', x: 0, y: [1], series: null }, key: 'a:String|b:UInt64',
      fieldConfig: { defaults: { color: 'red' } },
    };
    const e1 = okEntry(await createSavedQuery(s, tab, 'Chartd', '', commit, 100));
    expect(queryPanel(e1)).toEqual(tab.specParsed!.panel);
    expect(queryPanel(e1)).not.toBe(tab.specParsed!.panel);
    expect('chart' in e1).toBe(false);
    // re-save with a different cfg; future panel siblings remain.
    tab.specParsed!.panel!.cfg = { type: 'line', x: 0, y: [1], series: null };
    await commitSavedQuery(s, tab, tab.specParsed, commit);
    expect(queryPanel(s.savedQueries[0])!.cfg!.type).toBe('line');
    expect(queryPanel(s.savedQueries[0])!.fieldConfig!.defaults!.color).toBe('red');
    tab.specParsed!.panel!.cfg = { type: 'logs' };
    await commitSavedQuery(s, tab, tab.specParsed, commit);
    expect(queryPanel(s.savedQueries[0])!.cfg).toEqual({ type: 'logs' });
    // re-save after the whole panel is cleared.
    delete tab.specParsed!.panel;
    await commitSavedQuery(s, tab, tab.specParsed, commit);
    expect(queryPanel(s.savedQueries[0])).toBeUndefined();
  });
  it("createSavedQuery allows sql:'' for a text panel only (#166 per-type save guard)", async () => {
    const s = savedTestState();
    const commit = fakeWorkspaceCommit();
    const tab = s.tabs.value[0];
    tab.sqlDraft = '';
    expect(await createSavedQuery(s, tab, 'NoSql', '', commit, 100)).toEqual({ ok: false, entry: null }); // no panel → still blocked
    tab.specParsed!.panel = { cfg: { type: 'table' } };
    expect(await createSavedQuery(s, tab, 'NoSql', '', commit, 150)).toEqual({ ok: false, entry: null }); // non-text panel → blocked
    tab.specParsed!.panel = { cfg: { type: 'text', content: '# hello' } };
    const e = okEntry(await createSavedQuery(s, tab, 'Note', '', commit, 200));
    expect(e).not.toBeNull();
    expect(e.sql).toBe('');
    expect(queryPanel(e)!.cfg).toEqual({ type: 'text', content: '# hello' });
    // `chart` is the pre-#166 legacy field this entry must never carry; it
    // has no place in the canonical SavedQueryV2 shape (a strict interface,
    // not an index-signature bag), hence the local intersection cast.
    expect((e as SavedQueryV2 & { chart?: unknown }).chart).toBeUndefined();
  });
  it('creation captures the result view; linked Spec becomes authoritative afterward', async () => {
    const s = savedTestState();
    const commit = fakeWorkspaceCommit();
    const tab = s.tabs.value[0];
    tab.sqlDraft = 'SELECT 1';
    s.resultView.value = 'panel';
    const e = okEntry(await createSavedQuery(s, tab, 'V', '', commit, 100));
    expect(queryView(e)).toBe('panel');
    tab.specParsed!.view = 'json';
    await commitSavedQuery(s, tab, tab.specParsed, commit);
    expect(queryView(s.savedQueries[0])).toBe('json');
    // raw view (TSV/JSON output) is not a saved view → dropped
    delete tab.specParsed!.view;
    await commitSavedQuery(s, tab, tab.specParsed, commit);
    expect(queryView(s.savedQueries[0])).toBeUndefined();
  });
  it('deleteSaved removes + clears tab pointers', async () => {
    const s = savedTestState();
    s.savedQueries = [savedQuery({ id: 's1', sql: 'x', name: 'n' })];
    s.tabs.value[0].savedId = 's1';
    const commit = fakeWorkspaceCommit();
    const result = await deleteSaved(s, 's1', commit);
    expect(result).toEqual({ ok: true });
    expect(s.savedQueries).toHaveLength(0);
    expect(s.tabs.value[0].savedId).toBeNull();
    expect(s.tabs.value[0].editorMode).toBe('sql');
  });
});

describe('history', () => {
  type HistoryTab = { sqlDraft: string | null; result: HistoryResultSnapshot };
  const tab = (over: Partial<HistoryTab> = {}): HistoryTab => ({
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
    s.history = Array.from({ length: 50 }, (_, i) => ({ id: 'h' + i })) as HistoryEntry[];
    recordHistory(s, tab(), vi.fn());
    expect(s.history).toHaveLength(50);
    expect(s.history[0].sql).toBe('SELECT 1');
  });
  it('clearHistory empties + persists', () => {
    const s = createState(reader());
    s.history = [{ id: 'h1' }] as HistoryEntry[];
    const save = vi.fn();
    clearHistory(s, save);
    expect(s.history).toEqual([]);
    expect(save).toHaveBeenCalledWith(KEYS.history, []);
  });
  it('deleteHistory removes one entry + persists', () => {
    const s = createState(reader());
    s.history = [{ id: 'h1' }, { id: 'h2' }] as HistoryEntry[];
    const save = vi.fn();
    deleteHistory(s, 'h1', save);
    expect(s.history.map((h) => h.id)).toEqual(['h2']);
    expect(save).toHaveBeenCalledWith(KEYS.history, s.history);
  });
});

describe('default persistence', () => {
  it('recordHistory/clearHistory/deleteHistory persist via storage by default', () => {
    const s = createState(reader());
    // Exercises the default saveJSON path (writes to happy-dom localStorage) —
    // recordHistory/deleteHistory/clearHistory are untouched by #287 W4 (only
    // the saved-query CRUD ops moved off the flat `save` seam onto the
    // aggregate commit, which has no meaningful "real" default — see
    // the next test).
    recordHistory(s, { sqlDraft: 'SELECT 9', result: { rawText: null, rows: [], progress: { elapsed_ns: 0 } } });
    deleteHistory(s, 'nope');
    clearHistory(s);
    expect(s.history).toEqual([]);
  });
  it('createSavedQuery/renameSaved/toggleFavorite/deleteSaved always require an injected commit (#287 W4 — no flat-storage default)', async () => {
    const s = savedTestState();
    const commit = fakeWorkspaceCommit();
    s.tabs.value[0].sqlDraft = 'SELECT 9';
    const e = okEntry(await createSavedQuery(s, s.tabs.value[0], 'nine', undefined, commit));
    await renameSaved(s, e.id, 'nine!', undefined, commit);
    await toggleFavorite(s, e.id, commit, genTileId());
    await deleteSaved(s, 'nope', commit);
    expect(commit).toHaveBeenCalledTimes(4);
    expect(s.savedQueries.some((q) => q.id === e.id)).toBe(true);
  });
});
