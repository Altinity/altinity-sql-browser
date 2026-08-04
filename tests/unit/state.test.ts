import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  KEYS, DEFAULT_LIBRARY_NAME, newTabObj, createState, activeTab, allocTabId, effectiveFilterActive,
  createSavedQuery, commitSavedQuery, savedForTab, renameSaved, toggleFavorite,
  sortedSaved, filterSaved, filterHistory, deleteSaved, recordHistory,
  recordScriptHistory, clearHistory, deleteHistory, tabPanel, setTabSpecDraft, patchSpecDraft, tabDirty,
  detachWorkspaceBoundTabs, reconcileTabsWithSavedQueries, adoptSavedIntoTab, reconcileLinkedTabsToLatest,
  variableDoc, findVariableTab,
} from '../../src/state.js';
import type {
  StateReader, HistoryResultSnapshot, HistoryEntry, QueryTab, SpecValidationService, AppState, SavedEntryResult,
} from '../../src/state.js';
import { queryToken } from '../../src/workspace/workspace-sync.js';
import { queryDescription, queryFavorite, queryName, queryPanel, queryView } from '../../src/core/saved-query.js';
import { savedQuery as savedQueryUntyped } from '../helpers/saved-query.js';
import type {
  DashboardDocumentV2, SavedQueryV2, StoredWorkspaceV5,
} from '../../src/generated/json-schema.types.js';
import { fakeMutateWorkspace } from '../helpers/fake-app.js';
import type { WorkspaceDiagnostic } from '../../src/dashboard/model/workspace-diagnostics.js';
import { upgradeDashboardLayout } from '../../src/dashboard/model/dashboard-document.js';

afterEach(() => vi.unstubAllGlobals());

function memStore(initial: Record<string, string> = {}) {
  const m = new Map(Object.entries(initial));
  return { getItem: (k: string) => (m.has(k) ? m.get(k) : null), setItem: (k: string, v: unknown) => m.set(k, String(v)) };
}

const reader = (over: Record<string, unknown> = {}): StateReader => ({
  loadStr: (k, dflt) => (k in over ? (over[k] as string) : dflt),
  loadJSON: (k, dflt) => (k in over ? over[k] : dflt),
});

// #287 W4 / #343: the saved-query CRUD ops now build their candidate over the
// LATEST committed workspace inside `app.mutateWorkspace` (here the
// `fakeMutateWorkspace` fake), whose repository validates a non-empty workspace
// id — every test below that exercises them builds its state through this
// helper (instead of bare `createState(reader())`) so the candidate always has
// one.
function savedTestState(over: Record<string, unknown> = {}): AppState {
  const s = createState(reader(over));
  s.workspaceId = 'w1';
  return s;
}

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
      // #457: every tab declares WHICH document it edits; a fresh one is a query.
      id: 't9', doc: { kind: 'query' }, name: 'Untitled', sqlDraft: '', specVersion: 1,
      specText: '{\n  "name": "Untitled",\n  "favorite": false\n}',
      specParsed: { name: 'Untitled', favorite: false }, specDiagnostics: [],
      editorMode: 'sql', dirtySql: false, dirtySpec: false,
      result: null, lastSuccessfulResultColumns: [], savedId: null,
    });
    expect(tabDirty(newTabObj('t1'))).toBe(false);
    expect(tabDirty({ dirtySpec: true })).toBe(true);
  });
});

// #457 — a tab is not always a query. These two are the ONLY way the rest of the
// app asks "which document is this?" and "is this variable already open?".
describe('variableDoc / findVariableTab', () => {
  const varTab = (id: string, dashboardId: string, variableName: string): QueryTab => {
    const tab = newTabObj(id);
    tab.doc = { kind: 'dashboard-variable', dashboardId, variableName };
    return tab;
  };

  it('narrows a variable tab to its binding and answers null for a query tab', () => {
    expect(variableDoc(varTab('t1', 'sales', 'zone')))
      .toEqual({ kind: 'dashboard-variable', dashboardId: 'sales', variableName: 'zone' });
    expect(variableDoc(newTabObj('t2'))).toBeNull();
  });

  it('treats a tab with no doc at all as an ordinary query tab', () => {
    // `doc` is required on `QueryTab` and always set by `newTabObj`, but a
    // hand-built fixture can still assert its way to a `QueryTab` without one —
    // and reading `tab.doc.kind` straight would throw on those instead.
    expect(variableDoc({ } as QueryTab)).toBeNull();
    expect(variableDoc(null)).toBeNull();
    expect(variableDoc(undefined)).toBeNull();
  });

  it('finds the open tab for an exact (dashboardId, variableName) pair', () => {
    const tabs = [newTabObj('t1'), varTab('t2', 'sales', 'zone')];
    expect(findVariableTab(tabs, 'sales', 'zone')!.id).toBe('t2');
  });

  it('scopes identity to the Dashboard: the same NAME elsewhere is a different document', () => {
    const tabs = [varTab('t1', 'sales', 'zone'), varTab('t2', 'ops', 'zone')];
    expect(findVariableTab(tabs, 'sales', 'zone')!.id).toBe('t1');
    expect(findVariableTab(tabs, 'ops', 'zone')!.id).toBe('t2');
    expect(findVariableTab(tabs, 'exec', 'zone')).toBeUndefined();
  });

  it('matches the variable name exactly, never case-insensitively or by prefix', () => {
    const tabs = [varTab('t1', 'sales', 'zone')];
    expect(findVariableTab(tabs, 'sales', 'Zone')).toBeUndefined();
    expect(findVariableTab(tabs, 'sales', 'zon')).toBeUndefined();
  });

  it('answers undefined when no variable tab is open at all', () => {
    expect(findVariableTab([newTabObj('t1')], 'sales', 'zone')).toBeUndefined();
  });
});

// #459: every `KEYS` value is a PERSISTED localStorage key, so its literal
// string is a compatibility contract with data already on users' machines —
// not an implementation detail that may follow a source-level rename. Every
// other test reaches these keys through the `KEYS` constant, which means a
// rename of the string itself would leave the whole suite green while silently
// orphaning real stored data. This test is the one place that pins the strings,
// so changing one has to be a deliberate edit here plus a migration.
//
// `dashFilters` is the reason this exists: #459 renamed the Dashboard's
// filter terminology to "variable" everywhere EXCEPT this key, whose value must
// stay `asb:dashFilters` or every saved Dashboard variable value is discarded on
// the next load. `filterActive` is the second documented exception — it names
// the Workbench's optional-block activation, not a Dashboard variable.
describe('KEYS — persisted localStorage key names (#459)', () => {
  it('pins every persisted key string, including the two documented "filter" exceptions', () => {
    expect(KEYS).toEqual({
      theme: 'asb:theme',
      sidebarPx: 'asb:sidebarPx',
      editorPct: 'asb:editorPct',
      sideSplitPct: 'asb:sideSplitPct',
      rightInspectorPx: 'asb:rightInspectorPx',
      cellDrawerPx: 'asb:cellDrawerPx',
      docPanePx: 'asb:docPanePx',
      sidePanel: 'asb:sidePanel',
      saved: 'asb:saved',
      history: 'asb:history',
      libraryName: 'asb:libraryName',
      resultRowLimit: 'asb:resultRowLimit',
      varValues: 'asb:varValues',
      filterActive: 'asb:filterActive',
      varRecent: 'asb:varRecent',
      varRecentDisabled: 'asb:varRecentDisabled',
      dashFilters: 'asb:dashFilters',
    });
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
    expect(s.rightInspectorPx).toBe(480); // #586 — no legacy pref present, so the hardcoded default wins
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
      [KEYS.rightInspectorPx]: '100', // clamps up to the 320 floor
      [KEYS.sidePanel]: 'history',
      [KEYS.saved]: [{ id: 's1', sql: 'x', name: 'n', starred: true }],
      [KEYS.history]: [{ id: 'h1', sql: 'y', ts: 1, rows: 1, ms: 2 }],
      [KEYS.libraryName]: 'My team queries',
      [KEYS.varValues]: { d: 'stale' },
      [KEYS.filterActive]: { d: false },
      [KEYS.varRecent]: { version: 1, nextSeq: 3, byName: { d: [{ value: 'x', seq: 2 }] } },
      [KEYS.varRecentDisabled]: true,
    }));
    expect(s.theme).toBe('light');
    expect(s.libraryName.value).toBe('My team queries');
    expect(s.sidebarPx).toBe(420);
    expect(s.editorPct).toBe(15);
    expect(s.sideSplitPct).toBe(85);
    expect(s.rightInspectorPx).toBe(320);
    expect(s.sidePanel.value).toBe('history');
    expect(s.savedQueries).toHaveLength(1);
    expect(s.history).toHaveLength(1);
    expect(s.varValues).toEqual({ d: 'stale' });
    expect(s.filterActive).toEqual({ d: false }); // restored alongside varValues (#165)
    expect(s.varRecent).toEqual({ version: 1, nextSeq: 3, byName: { d: [{ value: 'x', seq: 2 }] } });
    expect(s.varRecentDisabled).toBe(true);
  });
  // #587: `sidePanel`'s load-boundary decode. Before this phase `state.ts`
  // read the raw stored string with no validation at all, so an unrecognized
  // value silently reached History's `renderSavedHistory` branch (fall-
  // through of an `=== 'saved'` comparison) with NEITHER tab visually active
  // — the bridge below closes that gap.
  describe('sidePanel — fail-closed load-boundary decode (#587)', () => {
    it('defaults to "saved" (Library) when nothing is persisted', () => {
      expect(createState(reader()).sidePanel.value).toBe('saved');
    });
    it('round-trips the two recognized persisted values', () => {
      expect(createState(reader({ [KEYS.sidePanel]: 'saved' })).sidePanel.value).toBe('saved');
      expect(createState(reader({ [KEYS.sidePanel]: 'history' })).sidePanel.value).toBe('history');
    });
    it('fails closed to "saved" for garbage, INCLUDING the registry\'s own id "library"', () => {
      for (const bad of ['library', 'nope', '', 'History']) {
        expect(createState(reader({ [KEYS.sidePanel]: bad })).sidePanel.value).toBe('saved');
      }
    });
  });
  // #591: the five remaining persisted-domain reads left after #587/#586
  // (varValues, filterActive, varRecent, varRecentDisabled, history) now
  // decode through core/state-codec.ts rather than trusting an `as` cast.
  // These prove the WIRING (createState calls the decoder for each field) —
  // the decoders' own behavior is unit-tested directly in
  // tests/unit/state-codec.test.ts.
  describe('createState — fail-closed persisted-domain decodes (#591)', () => {
    it('varValues fails closed on a bad top level, and drops malformed entries', () => {
      expect(createState(reader({ [KEYS.varValues]: 'oops' })).varValues).toEqual({});
      expect(createState(reader({ [KEYS.varValues]: { a: 'x', b: 42 } })).varValues).toEqual({ a: 'x' });
    });

    it('filterActive fails closed on a bad top level', () => {
      expect(createState(reader({ [KEYS.filterActive]: ['a'] })).filterActive).toEqual({});
    });

    it('varRecent fails closed on a bad top level, and drops malformed per-name entries', () => {
      expect(createState(reader({ [KEYS.varRecent]: { version: 99 } })).varRecent)
        .toEqual({ version: 1, nextSeq: 1, byName: {} });
      const s = createState(reader({
        [KEYS.varRecent]: {
          version: 1, nextSeq: 4,
          byName: { good: [{ value: 'a', seq: 1 }, { value: 2, seq: 2 }], bad: 'not-an-array' },
        },
      }));
      expect(s.varRecent).toEqual({ version: 1, nextSeq: 4, byName: { good: [{ value: 'a', seq: 1 }] } });
    });

    it('varRecentDisabled fails closed to false for a non-boolean stored value', () => {
      expect(createState(reader({ [KEYS.varRecentDisabled]: 'yes' })).varRecentDisabled).toBe(false);
    });

    it('history fails closed on a bad top level, and keeps only well-formed entries', () => {
      expect(createState(reader({ [KEYS.history]: { not: 'array' } })).history).toEqual([]);
      const s = createState(reader({
        [KEYS.history]: [
          { id: 'h1', sql: 'x', ts: 1, rows: 1, ms: 2 },
          { id: 'bad-missing-sql', ts: 1, rows: 1, ms: 2 },
          { id: 'h2', sql: 'y', ts: 2, rows: null, ms: 3 },
        ],
      }));
      expect(s.history).toEqual([
        { id: 'h1', sql: 'x', ts: 1, rows: 1, ms: 2 },
        { id: 'h2', sql: 'y', ts: 2, rows: null, ms: 3 },
      ]);
    });
  });
  // #586 — rightInspectorPx collapses cellDrawerPx/docPanePx into one
  // preference; a browser that already had either legacy value must keep it
  // across the upgrade rather than silently reset to the default.
  describe('rightInspectorPx compat read order (#586)', () => {
    it('a real rightInspectorPx wins outright, even alongside stale legacy keys', () => {
      const s = createState(reader({
        [KEYS.rightInspectorPx]: '500',
        [KEYS.docPanePx]: '420',
        [KEYS.cellDrawerPx]: '560',
      }));
      expect(s.rightInspectorPx).toBe(500);
    });
    it('falls back to docPanePx when rightInspectorPx is absent, ignoring cellDrawerPx', () => {
      const s = createState(reader({
        [KEYS.docPanePx]: '420',
        [KEYS.cellDrawerPx]: '560',
      }));
      expect(s.rightInspectorPx).toBe(420);
    });
    it('falls back to cellDrawerPx when neither rightInspectorPx nor docPanePx is present', () => {
      const s = createState(reader({ [KEYS.cellDrawerPx]: '560' }));
      expect(s.rightInspectorPx).toBe(560);
    });
    it('falls back to the 480 default when nothing is persisted at all', () => {
      expect(createState(reader()).rightInspectorPx).toBe(480);
    });

    // #586 finding 4: the old `||`-chained read short-circuited on ANY
    // non-empty string, so a malformed canonical value both blocked a
    // perfectly valid legacy fallback AND survived as `NaN` through `clamp`
    // (rendering a literal "NaNpx" width). Each candidate must now be
    // validated independently.
    it('a malformed canonical rightInspectorPx is skipped in favor of a valid docPanePx fallback', () => {
      const s = createState(reader({
        [KEYS.rightInspectorPx]: 'bad',
        [KEYS.docPanePx]: '420',
        [KEYS.cellDrawerPx]: '560',
      }));
      expect(s.rightInspectorPx).toBe(420);
      expect(Number.isNaN(s.rightInspectorPx)).toBe(false);
    });

    it('a malformed canonical AND docPanePx both skipped in favor of a valid cellDrawerPx', () => {
      const s = createState(reader({
        [KEYS.rightInspectorPx]: 'bad',
        [KEYS.docPanePx]: 'also-bad',
        [KEYS.cellDrawerPx]: '560',
      }));
      expect(s.rightInspectorPx).toBe(560);
    });

    it('every candidate malformed falls back to the 480 default, never NaN', () => {
      const s = createState(reader({
        [KEYS.rightInspectorPx]: 'bad',
        [KEYS.docPanePx]: 'also-bad',
        [KEYS.cellDrawerPx]: 'still-bad',
      }));
      expect(s.rightInspectorPx).toBe(480);
    });

    it('a whitespace-only canonical value is treated as absent, not as a real (NaN) value', () => {
      const s = createState(reader({
        [KEYS.rightInspectorPx]: '   ',
        [KEYS.docPanePx]: '420',
      }));
      expect(s.rightInspectorPx).toBe(420);
    });

    it('an out-of-range but numeric value is still "valid" — parsed, then clamped by the outer bound, not rejected', () => {
      const s = createState(reader({ [KEYS.rightInspectorPx]: '-50' }));
      expect(s.rightInspectorPx).toBe(320); // clamp(-50, 320, Infinity)
    });

    it('a leading-whitespace numeric value still parses (parseInt tolerates it, matching every other numeric pref read in this file)', () => {
      const s = createState(reader({ [KEYS.rightInspectorPx]: '  650' }));
      expect(s.rightInspectorPx).toBe(650);
    });

    // #591 (inherited from #586): `firstValidPx` used bare `parseInt` +
    // `Number.isFinite`, which silently accepts a non-numeric tail
    // (`parseInt` stops at the first invalid character rather than
    // rejecting the whole string). Each lenient form below must now be
    // REJECTED — only a complete trimmed, optionally-signed decimal integer
    // is a valid candidate.
    it('rejects each lenient parseInt form, falling through to a valid docPanePx', () => {
      for (const lenient of ['420px', '1e3', '0x10', '12abc']) {
        const s = createState(reader({
          [KEYS.rightInspectorPx]: lenient,
          [KEYS.docPanePx]: '420',
        }));
        expect(s.rightInspectorPx).toBe(420);
      }
    });

    it('a corrupt-lenient canonical value falls through to a valid docPanePx', () => {
      const s = createState(reader({
        [KEYS.rightInspectorPx]: '1e3',
        [KEYS.docPanePx]: '420',
      }));
      expect(s.rightInspectorPx).toBe(420);
    });

    it('a corrupt canonical AND a corrupt docPanePx both fall through to a valid cellDrawerPx', () => {
      const s = createState(reader({
        [KEYS.rightInspectorPx]: '0x10',
        [KEYS.docPanePx]: '0x10',
        [KEYS.cellDrawerPx]: '560',
      }));
      expect(s.rightInspectorPx).toBe(560);
    });

    it('all three lenient-corrupt candidates fall back to the 480 default, never NaN', () => {
      const s = createState(reader({
        [KEYS.rightInspectorPx]: '420px',
        [KEYS.docPanePx]: '1e3',
        [KEYS.cellDrawerPx]: '0x10',
      }));
      expect(s.rightInspectorPx).toBe(480);
      expect(Number.isNaN(s.rightInspectorPx)).toBe(false);
    });

    // #591 finding 2: a complete digit string still overflows `parseInt`'s
    // floating-point accumulation (`parseInt('9'.repeat(400), 10)` ===
    // Infinity), so the regex alone isn't enough — an overflowing candidate
    // must be rejected the same as a syntactically invalid one, not accepted
    // as a literal Infinity that then wrongly beats a valid legacy fallback.
    it('an overflowing canonical value is rejected in favor of a valid docPanePx fallback', () => {
      const s = createState(reader({
        [KEYS.rightInspectorPx]: '9'.repeat(400),
        [KEYS.docPanePx]: '420',
      }));
      expect(s.rightInspectorPx).toBe(420);
      expect(Number.isFinite(s.rightInspectorPx)).toBe(true);
    });

    it('all three candidates overflowing/invalid falls through to the 480 default, never Infinity', () => {
      const s = createState(reader({
        [KEYS.rightInspectorPx]: '9'.repeat(400),
        [KEYS.docPanePx]: 'also-bad',
        [KEYS.cellDrawerPx]: '9'.repeat(400),
      }));
      expect(s.rightInspectorPx).toBe(480);
      expect(Number.isFinite(s.rightInspectorPx)).toBe(true);
    });

    it('a negative-overflow candidate is rejected the same way, falling through to a valid fallback', () => {
      const s = createState(reader({
        [KEYS.rightInspectorPx]: `-${'9'.repeat(400)}`,
        [KEYS.docPanePx]: '420',
      }));
      expect(s.rightInspectorPx).toBe(420);
      expect(Number.isFinite(s.rightInspectorPx)).toBe(true);
    });
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
    const mutate = fakeMutateWorkspace(s);
    s.tabs.value[0].sqlDraft = '';
    expect(await createSavedQuery(s, s.tabs.value[0], 'name', '', mutate)).toEqual({ ok: false, entry: null });
    s.tabs.value[0].sqlDraft = 'SELECT 1';
    expect(await createSavedQuery(s, s.tabs.value[0], '  ', '', mutate)).toEqual({ ok: false, entry: null });
    expect(mutate.commit).not.toHaveBeenCalled();
  });

  it('createSavedQuery rejects an already-linked tab and semantic validation errors', async () => {
    const s = savedTestState();
    const tab = s.tabs.value[0];
    tab.sqlDraft = 'SELECT 1';
    s.savedQueries = [savedQuery({ id: 's1', name: 'Existing', sql: 'SELECT 1' })];
    tab.savedId = 's1';
    const mutate = fakeMutateWorkspace(s);
    expect(await createSavedQuery(s, tab, 'Duplicate', '', mutate)).toEqual({ ok: false, entry: null });
    tab.savedId = null;
    const validationService: SpecValidationService = {
      validate: () => [{ code: 'blocked', severity: 'error', message: 'blocked' }],
    };
    expect(await createSavedQuery(s, tab, 'Blocked', '', mutate, 1, validationService)).toEqual({ ok: false, entry: null });
    expect(mutate.commit).not.toHaveBeenCalled();
  });

  it('commitSavedQuery rejects a missing link or Spec before mutation', async () => {
    const s = savedTestState();
    const tab = s.tabs.value[0];
    const mutate = fakeMutateWorkspace(s);
    expect(await commitSavedQuery(s, tab, tab.specParsed, mutate)).toEqual({ ok: false, entry: null });
    tab.savedId = 's1';
    expect(await commitSavedQuery(s, tab, null, mutate)).toEqual({ ok: false, entry: null });
    expect(mutate.commit).not.toHaveBeenCalled();
  });
  it('creates an unsaved query, then atomically commits linked SQL + authoritative Spec', async () => {
    const s = savedTestState();
    const mutate = fakeMutateWorkspace(s);
    const tab = s.tabs.value[0];
    tab.sqlDraft = 'SELECT 1';
    // This Save path is guaranteed `ok: true` here (linked-tab creation with a
    // non-empty name and sql, asserted just below) — same invariant state.ts
    // itself documents at its own `!` sites, now via `okEntry`'s explicit throw.
    const e1 = okEntry(await createSavedQuery(s, tab, 'My query', '', mutate, 100));
    expect(e1).toEqual(expect.objectContaining({ sql: 'SELECT 1', specVersion: 1 }));
    expect(e1.spec).toMatchObject({ name: 'My query', favorite: false });
    expect(tab.savedId).toBe(e1.id);
    expect(tab.name).toBe('My query');
    // #343: create records the tab's in-sync baseline token against the committed query.
    expect(tab.lastCommittedQueryToken).toBe(queryToken(e1));
    expect(s.savedQueries).toHaveLength(1);
    expect(mutate.commit).toHaveBeenCalledTimes(1);
    // Linked Save bypasses popover fields and commits the two drafts directly.
    tab.sqlDraft = 'SELECT 2';
    tab.specParsed!.name = 'My query v2';
    tab.dirtySql = true; tab.dirtySpec = true;
    const e2 = okEntry(await commitSavedQuery(s, tab, tab.specParsed, mutate));
    expect(e2.id).toBe(e1.id);
    expect(s.savedQueries).toHaveLength(1);
    expect(s.savedQueries[0].sql).toBe('SELECT 2');
    expect(queryName(s.savedQueries[0])).toBe('My query v2');
    expect(tab.name).toBe('My query v2');
    expect(tabDirty(tab)).toBe(false);
    // #343: the linked save refreshed the in-sync baseline token to the new commit.
    expect(tab.lastCommittedQueryToken).toBe(queryToken(s.savedQueries[0]));
  });
  it('rejects an edit that invalidates a Panel on a non-current Dashboard and changes no state', async () => {
    const s = savedTestState();
    const owned = savedQuery({
      id: 'owned', sql: 'SELECT 1', name: 'Panel query', dashboard: { role: 'panel' },
    });
    const current: DashboardDocumentV2 = {
      documentVersion: 2, id: 'current', title: 'Current', revision: 1,
      layout: { type: 'flow', version: 1, preset: 'report', items: {} },
      tiles: [],
    };
    const other: DashboardDocumentV2 = {
      documentVersion: 2, id: 'other', title: 'Other', revision: 2,
      layout: { type: 'flow', version: 1, preset: 'report', items: { t1: {} } },
      tiles: [{ id: 't1', queryId: 'owned' }],
    };
    s.savedQueries = [owned];
    s.dashboard = current;
    const tab = s.tabs.value[0];
    tab.savedId = 'owned';
    tab.sqlDraft = owned.sql;
    setTabSpecDraft(tab, owned.spec, { dirty: true });
    const latest: StoredWorkspaceV5 = {
      storageVersion: 5, id: 'w1', key: 'workspace', name: s.libraryName.value,
      queries: s.savedQueries, dashboards: [current, other],
    };
    const workspaceBefore = JSON.stringify(latest);
    const stateBefore = JSON.stringify({ queries: s.savedQueries, dashboard: s.dashboard });
    const tabBefore = JSON.stringify(tab);
    const mutate = fakeMutateWorkspace(s, { loadById: async () => latest });
    const setupRole = { ...owned.spec, dashboard: { role: 'setup' as const } };

    const result = await commitSavedQuery(s, tab, setupRole, mutate);

    expect(result).toMatchObject({
      ok: false,
      entry: null,
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: 'dashboard-setup-reference' }),
      ]),
    });
    expect(mutate.commit).toHaveBeenCalledTimes(1);
    const rejectedCandidate = mutate.commit.mock.calls[0][0] as StoredWorkspaceV5;
    expect(rejectedCandidate.dashboards).toEqual([current, other]);
    expect(JSON.stringify(latest)).toBe(workspaceBefore);
    expect(JSON.stringify({ queries: s.savedQueries, dashboard: s.dashboard })).toBe(stateBefore);
    expect(JSON.stringify(tab)).toBe(tabBefore);
  });
  it('materializes timeRanges on create and only on SQL-dirty linked saves while the property is absent', async () => {
    const s = savedTestState();
    const mutate = fakeMutateWorkspace(s);
    const tab = s.tabs.value[0];
    tab.sqlDraft = 'SELECT {From:DateTime}, {TO:DateTime64(3)}';

    const created = okEntry(await createSavedQuery(s, tab, 'Timed', '', mutate, 100));
    expect(created.spec.timeRanges).toEqual([{ from: 'From', to: 'TO' }]);

    // Explicit metadata is authoritative, including the empty opt-out.
    tab.sqlDraft = 'SELECT {start:Date}, {end:Date32}';
    tab.specParsed = { ...tab.specParsed!, timeRanges: [] };
    tab.dirtySql = true;
    const optedOut = okEntry(await commitSavedQuery(s, tab, tab.specParsed, mutate));
    expect(optedOut.spec.timeRanges).toEqual([]);

    // A Spec-only save/view of SQL that happens to contain a recognized pair
    // must not author metadata as a side effect.
    tab.specParsed = { name: 'Timed', favorite: false };
    tab.dirtySql = false;
    tab.dirtySpec = true;
    const specOnly = okEntry(await commitSavedQuery(s, tab, tab.specParsed, mutate));
    expect(Object.hasOwn(specOnly.spec, 'timeRanges')).toBe(false);

    tab.dirtySql = true;
    const sqlUpdated = okEntry(await commitSavedQuery(s, tab, tab.specParsed, mutate));
    expect(sqlUpdated.spec.timeRanges).toEqual([{ from: 'start', to: 'end' }]);
  });
  it('commits ambiguous authoring without guessing and returns the warning', async () => {
    const s = savedTestState();
    const mutate = fakeMutateWorkspace(s);
    const tab = s.tabs.value[0];
    tab.sqlDraft = 'SELECT {from:DateTime}, {to:DateTime}, {start:DateTime}, {end:DateTime}';

    const result = await createSavedQuery(s, tab, 'Ambiguous', '', mutate, 100);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(Object.hasOwn(result.entry.spec, 'timeRanges')).toBe(false);
    expect(result.diagnostics).toEqual([expect.objectContaining({
      path: ['timeRanges'], severity: 'warning', code: 'time-range-inference-ambiguous',
    })]);
    expect(mutate.commit).toHaveBeenCalledTimes(1);
  });
  it('returns the ambiguity warning on a SQL-dirty linked commit without materializing metadata', async () => {
    const s = savedTestState();
    const mutate = fakeMutateWorkspace(s);
    const tab = s.tabs.value[0];
    tab.sqlDraft = 'SELECT 1';
    okEntry(await createSavedQuery(s, tab, 'Ambiguous update', '', mutate, 100));
    tab.sqlDraft = 'SELECT {from:DateTime}, {to:DateTime}, {start:DateTime}, {end:DateTime}';
    tab.specParsed = { name: 'Ambiguous update', favorite: false };
    tab.dirtySql = true;
    const result = await commitSavedQuery(s, tab, tab.specParsed, mutate);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(Object.hasOwn(result.entry.spec, 'timeRanges')).toBe(false);
    expect(result.diagnostics?.[0]).toMatchObject({ code: 'time-range-inference-ambiguous' });
  });
  it('creation stores a description and linked commits normalize/clear it', async () => {
    const s = savedTestState();
    const mutate = fakeMutateWorkspace(s);
    const tab = s.tabs.value[0];
    tab.sqlDraft = 'SELECT 1';
    const e = okEntry(await createSavedQuery(s, tab, 'Q', '  what it does  ', mutate, 100)); // trimmed
    expect(queryDescription(e)).toBe('what it does');
    tab.specParsed!.description = ' changed ';
    await commitSavedQuery(s, tab, tab.specParsed, mutate);
    expect(queryDescription(s.savedQueries[0])).toBe('changed');
    tab.specParsed!.description = '   ';
    await commitSavedQuery(s, tab, tab.specParsed, mutate);
    expect('description' in s.savedQueries[0].spec).toBe(false);
    // create with no description arg → no description field
    const t2 = newTabObj('t2'); t2.sqlDraft = 'SELECT 2'; s.tabs.value.push(t2);
    const e2 = okEntry(await createSavedQuery(s, t2, 'Q2', undefined, mutate, 400));
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
  it('reconciles only tab links missing from a committed saved-query collection', () => {
    const s = savedTestState();
    s.savedQueries = [savedQuery({ id: 'keep' })];
    const kept = s.tabs.value[0];
    kept.savedId = 'keep';
    kept.editorMode = 'spec';
    const dangling = newTabObj('t2');
    dangling.savedId = 'gone';
    dangling.editorMode = 'spec';
    const unsaved = newTabObj('t3');
    s.tabs.value = [kept, dangling, unsaved];
    reconcileTabsWithSavedQueries(s);
    expect(kept).toMatchObject({ savedId: 'keep', editorMode: 'spec' });
    expect(dangling).toMatchObject({ savedId: null, editorMode: 'sql' });
    expect(unsaved).toMatchObject({ savedId: null, editorMode: 'sql' });
  });
  it('detaches every workspace-bound tab without changing its drafts or dirty state', () => {
    const s = savedTestState();
    const linked = s.tabs.value[0];
    linked.savedId = 'same-id';
    linked.editorMode = 'spec';
    linked.sqlDraft = "SELECT 'A'";
    linked.specText = '{"name":"A"}';
    linked.dirtySql = true;
    linked.dirtySpec = true;
    linked.lastCommittedQueryToken = 'workspace-a-token';
    linked.externalState = 'conflict';
    const unsaved = newTabObj('t2');
    s.tabs.value = [linked, unsaved];

    detachWorkspaceBoundTabs(s);

    expect(linked).toMatchObject({
      savedId: null,
      editorMode: 'sql',
      sqlDraft: "SELECT 'A'",
      specText: '{"name":"A"}',
      dirtySql: true,
      dirtySpec: true,
      externalState: null,
    });
    expect(linked.lastCommittedQueryToken).toBeUndefined();
    expect(unsaved).toMatchObject({ savedId: null, editorMode: 'sql' });
  });
  // #457: a variable tab is workspace-bound through a DASHBOARD id, and has
  // `savedId === null` by design — so the `savedId` loop above never reaches it.
  // Dashboard ids are unique within a workspace, not globally (importing the same
  // workspace JSON twice preserves them), so a variable tab that survived a
  // workspace switch could commit option SQL into a Dashboard the user never
  // opened. Demoting it to a plain query tab makes that unaddressable.
  it('demotes a variable tab to a plain query tab, keeping its draft', () => {
    const s = savedTestState();
    const variable = newTabObj('t1');
    variable.doc = { kind: 'dashboard-variable', dashboardId: 'sales', variableName: 'zone' };
    variable.name = 'Variable: zone';
    variable.sqlDraft = 'SELECT z, z FROM zones';
    variable.dirtySql = true;
    s.tabs.value = [variable];

    detachWorkspaceBoundTabs(s);

    expect(variable.doc).toEqual({ kind: 'query' });
    expect(variableDoc(variable)).toBeNull();
    expect(variable.name).toBe('Untitled');
    // The user's work is not the thing at risk — the stale BINDING is.
    expect(variable).toMatchObject({ sqlDraft: 'SELECT z, z FROM zones', dirtySql: true });
  });
  it('leaves an ordinary query tab\'s document kind alone', () => {
    const s = savedTestState();
    const plain = newTabObj('t1');
    plain.name = 'Report';
    s.tabs.value = [plain];

    detachWorkspaceBoundTabs(s);

    expect(plain.doc).toEqual({ kind: 'query' });
    expect(plain.name).toBe('Report');
  });
  it('renameSaved updates the entry + any linked tab name', async () => {
    const s = savedTestState();
    s.savedQueries = [savedQuery({ id: 's1', sql: 'x', name: 'old' })];
    s.tabs.value[0].savedId = 's1';
    const mutate = fakeMutateWorkspace(s);
    await renameSaved(s, 's1', '  new  ', undefined, mutate);
    expect(queryName(s.savedQueries[0])).toBe('new');
    expect(s.tabs.value[0].name).toBe('new');
    await renameSaved(s, 's1', '   ', undefined, mutate); // blank ignored
    expect(queryName(s.savedQueries[0])).toBe('new');
    await renameSaved(s, 'missing', 'x', undefined, mutate); // unknown id ignored
    expect(mutate.commit).toHaveBeenCalledTimes(1);
  });
  it('renameSaved sets/clears description when given, leaves it untouched when undefined', async () => {
    const s = savedTestState();
    s.savedQueries = [savedQuery({ id: 's1', sql: 'x', name: 'A' })];
    const mutate = fakeMutateWorkspace(s);
    await renameSaved(s, 's1', 'A', '  a note  ', mutate); // set (trimmed)
    expect(queryDescription(s.savedQueries[0])).toBe('a note');
    await renameSaved(s, 's1', 'A', undefined, mutate); // name-only → description kept
    expect(queryDescription(s.savedQueries[0])).toBe('a note');
    await renameSaved(s, 's1', 'A', '', mutate); // explicit empty → cleared
    expect('description' in s.savedQueries[0].spec).toBe(false);
    await renameSaved(s, 's1', 'A', '  re  ', mutate); // re-set
    expect(queryDescription(s.savedQueries[0])).toBe('re');
    await renameSaved(s, 's1', 'A', null, mutate); // null (not undefined) → cleared, not stored as 'null' (#4 review)
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
    const mutate = fakeMutateWorkspace(s);
    await renameSaved(s, 's1', 'New', 'Description', mutate);
    await toggleFavorite(s, 's1', mutate);
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
    expect(mutate.commit).toHaveBeenCalledTimes(2);
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
    const mutate = fakeMutateWorkspace(s);
    await toggleFavorite(s, 'c', mutate);
    expect(queryFavorite(s.savedQueries.find((q) => q.id === 'c'))).toBe(true);
    await toggleFavorite(s, 'missing', mutate); // no-op
    expect(sortedSaved(s).map((q) => q.id)).toEqual(['c', 'a', 'b']);
    expect(mutate.commit).toHaveBeenCalledTimes(1);
  });
  // #299: the Workbench star also drives Dashboard tile membership, atomically
  // with the favorite flip — only panel-role queries become tiles (mirrors
  // legacy-migration.ts's buildLegacyMigrationCandidate), star OFF removes
  // every matching tile and scrubs those tile ids from filter targets, and a
  // null `state.dashboard` means favorite-flip-only (no Dashboard to touch).
  // #427 SEVERED the favourite<->membership coupling #299 introduced. A star is a
  // Library/workbench preference now; Dashboard membership is an explicit
  // reference to a query the member OWNS. These tests pin the inverse contract:
  // a star writes `spec.favorite` and touches nothing else.
  describe('toggleFavorite is a preference only (#427)', () => {
    const blankDashboard = (): DashboardDocumentV2 => ({
      documentVersion: 2, id: 'dash', title: 'D', revision: 1,
      layout: { type: 'flow', version: 1, preset: 'report', items: {} },
      tiles: [],
    });
    const hidden = (): DashboardDocumentV2 => ({
      documentVersion: 2, id: 'hidden', title: 'Hidden', revision: 5,
      layout: { type: 'flow', version: 1, preset: 'report', items: { 'h-t1': {} } },
      tiles: [{ id: 'h-t1', queryId: 'owned' }],
    });

    it('flips the flag and appends NO tile, on a panel-role query', async () => {
      const s = savedTestState();
      s.savedQueries = [savedQuery({ id: 'p1', sql: 'SELECT 1', dashboard: { role: 'panel' } })];
      s.dashboard = blankDashboard();
      const mutate = fakeMutateWorkspace(s);
      const result = await toggleFavorite(s, 'p1', mutate);
      expect(result).toMatchObject({ ok: true });
      expect(queryFavorite(s.savedQueries[0])).toBe(true);
      expect(s.dashboard!.tiles).toEqual([]);
      expect(mutate.commit).toHaveBeenCalledTimes(1);
    });

    it('never mints a Dashboard for a workspace that has none', async () => {
      const s = savedTestState();
      s.savedQueries = [savedQuery({ id: 'p1', sql: 'SELECT 1', dashboard: { role: 'panel' } })];
      expect(s.dashboard).toBeNull();
      const mutate = fakeMutateWorkspace(s);
      await toggleFavorite(s, 'p1', mutate);
      const candidate = mutate.commit.mock.calls[0][0] as StoredWorkspaceV5;
      expect(candidate.dashboards).toEqual([]);
      expect(queryFavorite(s.savedQueries[0])).toBe(true);
    });

    it('unstarring removes no tile, and leaves every Dashboard byte-identical', async () => {
      const s = savedTestState();
      s.savedQueries = [
        savedQuery({ id: 'p1', sql: 'SELECT 1', dashboard: { role: 'panel' }, favorite: true }),
        savedQuery({ id: 'owned', sql: 'SELECT 2', dashboard: { role: 'panel' } }),
      ];
      s.dashboard = blankDashboard();
      const committed: StoredWorkspaceV5 = {
        storageVersion: 5, id: 'w1', key: 'workspace', name: s.libraryName.value,
        queries: s.savedQueries, dashboards: [blankDashboard(), hidden()],
      };
      // fake-app.ts's `loadById` is still typed against the legacy StoredWorkspaceV5
      // shape (#447 pending there — out of this change's scope); the real
      // repository the default `commit` delegates to validates the true V5/document-v2
      // candidate this test needs.
      const mutate = fakeMutateWorkspace(s, { loadById: async () => committed as unknown as StoredWorkspaceV5 });
      await toggleFavorite(s, 'p1', mutate);
      const candidate = mutate.commit.mock.calls[0][0] as StoredWorkspaceV5;
      expect(queryFavorite(candidate.queries[0])).toBe(false);
      // Both Dashboards come through untouched, revisions included — including
      // the one holding a dedicated OWNED copy of another query.
      expect(candidate.dashboards).toEqual([blankDashboard(), hidden()]);
    });

    it('cannot reach a Dashboard-owned copy: only the starred query changes', async () => {
      const s = savedTestState();
      s.savedQueries = [
        savedQuery({ id: 'p1', sql: 'SELECT 1', dashboard: { role: 'panel' } }),
        savedQuery({ id: 'owned', sql: 'SELECT 2', dashboard: { role: 'panel' } }),
      ];
      const committed: StoredWorkspaceV5 = {
        storageVersion: 5, id: 'w1', key: 'workspace', name: s.libraryName.value,
        queries: s.savedQueries, dashboards: [hidden()],
      };
      const mutate = fakeMutateWorkspace(s, { loadById: async () => committed as unknown as StoredWorkspaceV5 });
      await toggleFavorite(s, 'p1', mutate);
      const candidate = mutate.commit.mock.calls[0][0] as StoredWorkspaceV5;
      expect(queryFavorite(candidate.queries[0])).toBe(true);
      expect(candidate.queries[1]).toEqual(s.savedQueries[1]);
      expect(candidate.dashboards).toEqual([hidden()]);
    });


    it('preserves every Dashboard through a rename', async () => {
      const s = savedTestState();
      s.savedQueries = [savedQuery({ id: 'p1', sql: 'SELECT 1', dashboard: { role: 'panel' } })];
      const committed: StoredWorkspaceV5 = {
        storageVersion: 5, id: 'w1', key: 'workspace', name: s.libraryName.value,
        queries: s.savedQueries, dashboards: [blankDashboard(), hidden()],
      };
      const mutate = fakeMutateWorkspace(s, { loadById: async () => committed as unknown as StoredWorkspaceV5 });
      await renameSaved(s, 'p1', 'Renamed', undefined, mutate);
      const renamed = mutate.commit.mock.calls[0][0] as StoredWorkspaceV5;
      expect(renamed.dashboards.map((d) => d.id)).toEqual(['dash', 'hidden']);
      expect(renamed.dashboards[1]).toEqual(hidden());
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
    const mutate = fakeMutateWorkspace(s);
    expect(await renameSaved(s, 's1', 'Overwrite', undefined, mutate)).toMatchObject({ ok: false, invalidTab: tab });
    expect(await toggleFavorite(s, 's1', mutate)).toMatchObject({ ok: false, invalidTab: tab });
    expect(queryName(s.savedQueries[0])).toBe('Original');
    expect(queryFavorite(s.savedQueries[0])).toBe(false);
    expect(mutate.commit).not.toHaveBeenCalled();
  });
  it('external writers validate the persisted entry and every linked draft before mutating', async () => {
    const s = savedTestState();
    const tab = s.tabs.value[0];
    s.savedQueries = [savedQuery({ id: 's1', name: 'Original', favorite: false, sql: 'SELECT 1' })];
    tab.savedId = 's1';
    setTabSpecDraft(tab, { ...s.savedQueries[0].spec, draftOnly: true }, { dirty: true });
    const mutate = fakeMutateWorkspace(s);
    const entryBlocked: SpecValidationService = {
      validate: () => [{ path: ['favorite'], severity: 'error', code: 'blocked', message: 'blocked' }],
    };
    expect(await toggleFavorite(s, 's1', mutate, entryBlocked)).toMatchObject({ ok: false, invalidTab: null });
    expect(queryFavorite(s.savedQueries[0])).toBe(false);

    const draftBlocked: SpecValidationService = {
      validate: (spec) => (spec as { draftOnly?: unknown }).draftOnly
        ? [{ path: ['draftOnly'], severity: 'error', code: 'blocked-draft', message: 'blocked draft' }]
        : [],
    };
    expect(await toggleFavorite(s, 's1', mutate, draftBlocked)).toMatchObject({ ok: false, invalidTab: tab });
    expect(queryFavorite(s.savedQueries[0])).toBe(false);
    expect(tab.specParsed!.favorite).toBe(false);
    expect(mutate.commit).not.toHaveBeenCalled();
  });
  it('renameSaved/toggleFavorite abort (never recreate) a query deleted in another tab (#343)', async () => {
    const s = savedTestState();
    const tab = s.tabs.value[0];
    s.savedQueries = [savedQuery({ id: 's1', name: 'Local', sql: 'SELECT 1' })];
    tab.savedId = 's1';
    // Another tab already committed a workspace where s1 is gone — the mutation
    // resolves the target against THAT latest, not the stale local projection.
    const latest: StoredWorkspaceV5 = { storageVersion: 5, id: 'w1', key: 'sql_library', name: 'SQL Library', queries: [], dashboards: [] };
    const mutate = fakeMutateWorkspace(s, { loadById: async () => latest });
    expect(await renameSaved(s, 's1', 'New', undefined, mutate)).toEqual({ ok: false, invalidTab: null, entry: null, deletedExternally: true });
    expect(await toggleFavorite(s, 's1', mutate)).toEqual({ ok: false, invalidTab: null, entry: null, deletedExternally: true });
    expect(mutate.commit).not.toHaveBeenCalled(); // never recreated
    expect(s.savedQueries.map((q) => q.id)).toEqual(['s1']); // local projection untouched (refresh is #343 step 4/5)
  });
  it('commitSavedQuery flags an externally-deleted target with deletedExternally (#343 review)', async () => {
    const s = savedTestState();
    const tab = s.tabs.value[0];
    s.savedQueries = [savedQuery({ id: 's1', name: 'Local', sql: 'SELECT 1' })];
    tab.savedId = 's1';
    tab.sqlDraft = 'SELECT my draft';
    setTabSpecDraft(tab, { name: 'Local', favorite: false });
    const latest: StoredWorkspaceV5 = { storageVersion: 5, id: 'w1', key: 'sql_library', name: 'SQL Library', queries: [], dashboards: [] };
    const mutate = fakeMutateWorkspace(s, { loadById: async () => latest });
    const result = await commitSavedQuery(s, tab, tab.specParsed, mutate);
    expect(result).toEqual({ ok: false, entry: null, deletedExternally: true });
    expect(mutate.commit).not.toHaveBeenCalled(); // aborted — never recreated
    expect(tab.savedId).toBe('s1'); // the CALLER refreshes the association (app.ts)
  });
  it('a metadata patch does NOT advance the baseline token of a tab lagging latest (#343 review blocker)', async () => {
    const s = savedTestState();
    const tab = s.tabs.value[0];
    const oldQ = savedQuery({ id: 's1', name: 'Local', sql: 'SELECT 1' });
    s.savedQueries = [oldQ];
    tab.savedId = 's1';
    tab.sqlDraft = 'SELECT my stale draft';
    tab.dirtySql = true;
    setTabSpecDraft(tab, { name: 'Local', favorite: false });
    tab.lastCommittedQueryToken = queryToken(oldQ); // in sync with the OLD version
    // Another tab already committed a changed s1; this tab has NOT refreshed yet
    // (missed poke) — no conflict flagged so far.
    const externalQ = savedQuery({ id: 's1', name: 'Local', sql: 'SELECT 999 /* external */' });
    const latest: StoredWorkspaceV5 = { storageVersion: 5, id: 'w1', key: 'sql_library', name: 'SQL Library', queries: [externalQ], dashboards: [] };
    const mutate = fakeMutateWorkspace(s, { loadById: async () => latest });
    // The user renames from the Library — the patch folds into LATEST (keeps the
    // external SQL) but must not stamp the newest token onto this stale tab.
    const result = await renameSaved(s, 's1', 'Renamed here', undefined, mutate);
    expect(result?.ok).toBe(true);
    expect(s.savedQueries[0].sql).toBe('SELECT 999 /* external */'); // external change preserved
    expect(tab.lastCommittedQueryToken).toBe(queryToken(oldQ)); // baseline unchanged
    // …so the next refresh still classifies this dirty tab as CONFLICT.
    const summary = reconcileLinkedTabsToLatest(s, { storageVersion: 5, id: 'w1', key: 'sql_library', name: 'SQL Library', queries: s.savedQueries, dashboards: [] });
    expect(summary.conflicts).toBe(1);
    expect(tab.externalState).toBe('conflict');
  });
  it('a metadata patch immediately adopts committed truth into a CLEAN lagging tab (#343 review blocker 2)', async () => {
    const s = savedTestState();
    const tab = s.tabs.value[0];
    const oldQ = savedQuery({ id: 's1', name: 'Local', sql: 'SELECT 1' });
    s.savedQueries = [oldQ];
    tab.savedId = 's1';
    tab.sqlDraft = 'SELECT 1'; // clean: draft mirrors the OLD committed version
    tab.dirtySql = false;
    setTabSpecDraft(tab, { name: 'Local', favorite: false });
    tab.lastCommittedQueryToken = queryToken(oldQ);
    // Another tab changed s1's SQL; this tab missed the poke and did NOT refresh.
    const externalQ = savedQuery({ id: 's1', name: 'Local', sql: 'SELECT 999 /* external */' });
    const latest: StoredWorkspaceV5 = { storageVersion: 5, id: 'w1', key: 'sql_library', name: 'SQL Library', queries: [externalQ], dashboards: [] };
    const mutate = fakeMutateWorkspace(s, { loadById: async () => latest });
    const result = await renameSaved(s, 's1', 'Renamed here', undefined, mutate);
    expect(result?.ok).toBe(true);
    // The tab adopted the COMPLETE committed entry NOW (external SQL + this
    // rename) — it cannot wait for a refresh, because this very commit made the
    // workspace token current and the next refresh will no-op.
    expect(tab.sqlDraft).toBe('SELECT 999 /* external */');
    expect(tab.name).toBe('Renamed here');
    expect(tab.dirtySql).toBe(false);
    expect(tab.dirtySpec).toBe(false);
    expect(tab.externalState ?? null).toBeNull();
    expect(tab.lastCommittedQueryToken).toBe(queryToken(s.savedQueries[0])); // == committed token
  });
  it('a rejected aggregate commit mutates nothing and surfaces diagnostics (#287 W4 strict commit)', async () => {
    const s = savedTestState();
    const tab = s.tabs.value[0];
    tab.sqlDraft = 'SELECT 1';
    const diagnostics = [{ path: ['id'], severity: 'error' as const, code: 'test-fail', message: 'boom' }];
    const failingCommit = vi.fn(async () => ({ ok: false as const, diagnostics }));
    const mutate = fakeMutateWorkspace(s, { commit: failingCommit });
    const result = await createSavedQuery(s, tab, 'Q', '', mutate, 100);
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
    const failingCommit = async (): Promise<{ ok: false; diagnostics: WorkspaceDiagnostic[] }> => ({ ok: false, diagnostics });
    const mutate = fakeMutateWorkspace(s, { commit: failingCommit });

    const renamed = await renameSaved(s, 's1', 'New name', undefined, mutate);
    expect(renamed).toEqual({ ok: false, invalidTab: null, entry: null, diagnostics: expect.any(Array) });
    expect(queryName(s.savedQueries[0])).toBe('Original');

    const favorited = await toggleFavorite(s, 's1', mutate);
    expect(favorited).toMatchObject({ ok: false, invalidTab: null, entry: null });
    expect(queryFavorite(s.savedQueries[0])).toBe(false);

    const deleted = await deleteSaved(s, 's1', mutate);
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
  it('patchSpecDraft leaves the tab untouched when semantic validation blocks the patch', () => {
    const tab = newTabObj('t1');
    const validationService: SpecValidationService = {
      validate: () => [{ code: 'blocked', severity: 'error', message: 'blocked' }],
    };
    const before = tab.specText;
    expect(patchSpecDraft(tab, { name: 'Rejected' }, { validationService })).toMatchObject({
      ok: false, invalidTab: tab, diagnostics: [{ code: 'blocked' }],
    });
    expect(tab.specText).toBe(before);
  });
  it('an invalid linked Spec makes atomic Save persist nothing and retain both dirty flags', async () => {
    const s = savedTestState();
    const tab = s.tabs.value[0];
    s.savedQueries = [savedQuery({ id: 's1', name: 'Q', sql: 'SELECT 1' })];
    tab.savedId = 's1'; tab.sqlDraft = 'SELECT 2'; tab.dirtySql = true; tab.dirtySpec = true;
    const mutate = fakeMutateWorkspace(s);
    expect(await commitSavedQuery(s, tab, { name: '  ', extension: true }, mutate)).toEqual({ ok: false, entry: null });
    expect(s.savedQueries[0].sql).toBe('SELECT 1');
    expect(tabDirty(tab)).toBe(true);
    expect(mutate.commit).not.toHaveBeenCalled();
  });
  it("linked Save keeps the existing empty-SQL guard except for text panels", async () => {
    const s = savedTestState();
    const tab = s.tabs.value[0];
    s.savedQueries = [savedQuery({ id: 's1', name: 'Q', sql: 'SELECT 1' })];
    tab.savedId = 's1'; tab.sqlDraft = ''; tab.dirtySql = true;
    const mutate = fakeMutateWorkspace(s);
    expect(await commitSavedQuery(s, tab, { name: 'Q', favorite: false }, mutate)).toEqual({ ok: false, entry: null });
    expect(s.savedQueries[0].sql).toBe('SELECT 1');
    expect(mutate.commit).not.toHaveBeenCalled();
    const textSpec = { name: 'Q', favorite: false, panel: { cfg: { type: 'text', content: 'note' } } };
    expect((await commitSavedQuery(s, tab, textSpec, mutate)).ok).toBe(true);
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
    const mutate = fakeMutateWorkspace(s);
    const tab = s.tabs.value[0];
    tab.sqlDraft = 'SELECT a, b';
    tab.specParsed!.panel = {
      cfg: { type: 'pie', x: 0, y: [1], series: null }, key: 'a:String|b:UInt64',
      fieldConfig: { defaults: { color: 'red' } },
    };
    const e1 = okEntry(await createSavedQuery(s, tab, 'Chartd', '', mutate, 100));
    expect(queryPanel(e1)).toEqual(tab.specParsed!.panel);
    expect(queryPanel(e1)).not.toBe(tab.specParsed!.panel);
    expect('chart' in e1).toBe(false);
    // re-save with a different cfg; future panel siblings remain.
    tab.specParsed!.panel!.cfg = { type: 'line', x: 0, y: [1], series: null };
    await commitSavedQuery(s, tab, tab.specParsed, mutate);
    expect(queryPanel(s.savedQueries[0])!.cfg!.type).toBe('line');
    expect(queryPanel(s.savedQueries[0])!.fieldConfig!.defaults!.color).toBe('red');
    tab.specParsed!.panel!.cfg = { type: 'logs' };
    await commitSavedQuery(s, tab, tab.specParsed, mutate);
    expect(queryPanel(s.savedQueries[0])!.cfg).toEqual({ type: 'logs' });
    // re-save after the whole panel is cleared.
    delete tab.specParsed!.panel;
    await commitSavedQuery(s, tab, tab.specParsed, mutate);
    expect(queryPanel(s.savedQueries[0])).toBeUndefined();
  });
  it("createSavedQuery allows sql:'' for a text panel only (#166 per-type save guard)", async () => {
    const s = savedTestState();
    const mutate = fakeMutateWorkspace(s);
    const tab = s.tabs.value[0];
    tab.sqlDraft = '';
    expect(await createSavedQuery(s, tab, 'NoSql', '', mutate, 100)).toEqual({ ok: false, entry: null }); // no panel → still blocked
    tab.specParsed!.panel = { cfg: { type: 'table' } };
    expect(await createSavedQuery(s, tab, 'NoSql', '', mutate, 150)).toEqual({ ok: false, entry: null }); // non-text panel → blocked
    tab.specParsed!.panel = { cfg: { type: 'text', content: '# hello' } };
    const e = okEntry(await createSavedQuery(s, tab, 'Note', '', mutate, 200));
    expect(e).not.toBeNull();
    expect(e.sql).toBe('');
    expect(queryPanel(e)!.cfg).toEqual({ type: 'text', content: '# hello' });
    // `chart` is the pre-#166 legacy field this entry must never carry; it
    // has no place in the canonical SavedQueryV2 shape (a strict interface,
    // not an index-signature bag), hence the local intersection cast.
    expect((e as SavedQueryV2 & { chart?: unknown }).chart).toBeUndefined();
  });
  it('creation and linked commits capture the current persistable result view', async () => {
    const s = savedTestState();
    const mutate = fakeMutateWorkspace(s);
    const tab = s.tabs.value[0];
    tab.sqlDraft = 'SELECT 1';
    s.resultView.value = 'panel';
    const e = okEntry(await createSavedQuery(s, tab, 'V', '', mutate, 100));
    expect(queryView(e)).toBe('panel');
    s.resultView.value = 'json';
    await commitSavedQuery(s, tab, tab.specParsed, mutate);
    expect(queryView(s.savedQueries[0])).toBe('json');
  });
  it('deleteSaved removes an ordinary zero-owner Library query and reconciles its linked tab', async () => {
    const s = savedTestState();
    const queries = [
      savedQuery({ id: 's1', sql: 'x', name: 'Library query' }),
      savedQuery({ id: 'owned', sql: 'SELECT 1', name: 'Panel query', dashboard: { role: 'panel' } }),
    ];
    const current: DashboardDocumentV2 = {
      documentVersion: 2, id: 'current', title: 'Current', revision: 1,
      layout: { type: 'flow', version: 1, preset: 'report', items: {} },
      tiles: [],
    };
    const other: DashboardDocumentV2 = {
      documentVersion: 2, id: 'other', title: 'Other', revision: 2,
      layout: { type: 'flow', version: 1, preset: 'report', items: { t1: {} } },
      tiles: [{ id: 't1', queryId: 'owned' }],
    };
    s.savedQueries = queries;
    s.dashboard = current;
    s.tabs.value[0].savedId = 's1';
    const latest: StoredWorkspaceV5 = {
      storageVersion: 5, id: 'w1', key: 'workspace', name: s.libraryName.value,
      queries, dashboards: [current, other],
    };
    const mutate = fakeMutateWorkspace(s, { loadById: async () => latest });
    const result = await deleteSaved(s, 's1', mutate);
    expect(result).toEqual({ ok: true });
    expect(s.savedQueries.map((query) => query.id)).toEqual(['owned']);
    const candidate = mutate.commit.mock.calls[0][0] as StoredWorkspaceV5;
    expect(candidate.dashboards).toEqual([current, other]);
    expect(s.dashboard).toEqual(upgradeDashboardLayout(current));
    expect(s.tabs.value[0].savedId).toBeNull();
    expect(s.tabs.value[0].editorMode).toBe('sql');
  });

  it('deleteSaved rejects a query owned only on a non-current Dashboard and changes no state', async () => {
    const s = savedTestState();
    const queries = [
      savedQuery({ id: 'lib', sql: 'SELECT 0', name: 'Library query' }),
      savedQuery({ id: 'owned', sql: 'SELECT 1', name: 'Panel query', dashboard: { role: 'panel' } }),
    ];
    const current: DashboardDocumentV2 = {
      documentVersion: 2, id: 'current', title: 'Current', revision: 1,
      layout: { type: 'flow', version: 1, preset: 'report', items: {} },
      tiles: [],
    };
    const other: DashboardDocumentV2 = {
      documentVersion: 2, id: 'other', title: 'Other', revision: 2,
      layout: { type: 'flow', version: 1, preset: 'report', items: { t1: {} } },
      tiles: [{ id: 't1', queryId: 'owned' }],
    };
    s.savedQueries = queries;
    s.dashboard = current;
    const latest: StoredWorkspaceV5 = {
      storageVersion: 5, id: 'w1', key: 'workspace', name: s.libraryName.value,
      queries, dashboards: [current, other],
    };
    const workspaceBefore = JSON.stringify(latest);
    const stateBefore = JSON.stringify({ queries: s.savedQueries, dashboard: s.dashboard });
    const mutate = fakeMutateWorkspace(s, { loadById: async () => latest });
    const result = await deleteSaved(s, 'owned', mutate);
    expect(result).toMatchObject({
      ok: false,
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: 'dashboard-tile-query-missing' }),
      ]),
    });
    const rejectedCandidate = mutate.commit.mock.calls[0][0] as StoredWorkspaceV5;
    expect(rejectedCandidate.dashboards).toEqual([current, other]);
    expect(JSON.stringify(latest)).toBe(workspaceBefore);
    expect(JSON.stringify({ queries: s.savedQueries, dashboard: s.dashboard })).toBe(stateBefore);
  });

  it('deleteSaved maps the defensive aborted mutation arm to empty diagnostics', async () => {
    const s = savedTestState();
    const mutate = vi.fn(async () => ({ ok: false as const, aborted: true as const }));
    expect(await deleteSaved(s, 'missing', mutate)).toEqual({ ok: false, diagnostics: [] });
  });

  it('reconcileTabsWithSavedQueries clears the in-sync baseline token on detach (#343)', () => {
    const s = savedTestState();
    s.savedQueries = [];
    const t = newTabObj('t1');
    t.savedId = 'gone';
    t.lastCommittedQueryToken = 'stale-token';
    s.tabs.value = [t];
    reconcileTabsWithSavedQueries(s);
    expect(t.savedId).toBeNull();
    expect(t.lastCommittedQueryToken).toBeUndefined();
  });
});

// #343: per-tab linked-query reconcile — adopt/conflict/detach/orphan over the
// latest committed workspace, plus the in-sync baseline token maintenance the
// classifier relies on.
describe('linked-tab reconcile (#343)', () => {
  const q = (id: string, sql: string, name = id): SavedQueryV2 => ({
    id, sql, specVersion: 1, spec: { name, favorite: false },
  } as SavedQueryV2);
  const ws = (queries: SavedQueryV2[]): StoredWorkspaceV5 => ({
    storageVersion: 5, id: 'w1', key: 'team', name: 'Team', queries, dashboards: [],
  });
  /** A tab linked to `query` and currently in sync with it. */
  const linkedTab = (id: string, query: SavedQueryV2): QueryTab => {
    const t = newTabObj(id);
    t.savedId = query.id;
    t.name = query.spec.name as string;
    t.sqlDraft = query.sql;
    setTabSpecDraft(t, { ...query.spec });
    t.lastCommittedQueryToken = queryToken(query);
    return t;
  };

  it('adoptSavedIntoTab replaces content, stays linked, clears dirty + flag, updates token', () => {
    const query = q('q1', 'SELECT 2', 'Renamed');
    const t = newTabObj('t1');
    t.savedId = 'q1';
    t.sqlDraft = 'SELECT 1';
    t.dirtySql = true;
    t.externalState = 'conflict';
    adoptSavedIntoTab(t, query);
    expect(t.sqlDraft).toBe('SELECT 2');
    expect(t.name).toBe('Renamed');
    expect(t.savedId).toBe('q1'); // stays linked
    expect(t.dirtySql).toBe(false);
    expect(t.dirtySpec).toBe(false);
    expect(t.externalState).toBeNull();
    expect(t.lastCommittedQueryToken).toBe(queryToken(query));
  });

  it('a CLEAN linked tab whose query changed externally ADOPTS without becoming dirty', () => {
    const s = savedTestState();
    const t = linkedTab('t1', q('q1', 'SELECT 1'));
    s.tabs.value = [t];
    const latest = ws([q('q1', 'SELECT 1 -- edited elsewhere')]);
    const summary = reconcileLinkedTabsToLatest(s, latest);
    expect(summary).toEqual({ changed: true, conflicts: 0 });
    expect(t.sqlDraft).toBe('SELECT 1 -- edited elsewhere');
    expect(t.savedId).toBe('q1');
    expect(t.dirtySql).toBe(false);
    expect(t.externalState).toBeNull();
  });

  it('a DIRTY linked tab whose query changed externally preserves its draft and enters conflict', () => {
    const s = savedTestState();
    const t = linkedTab('t1', q('q1', 'SELECT 1'));
    t.sqlDraft = 'SELECT my draft';
    t.dirtySql = true;
    s.tabs.value = [t];
    const summary = reconcileLinkedTabsToLatest(s, ws([q('q1', 'SELECT external edit')]));
    expect(summary).toEqual({ changed: true, conflicts: 1 });
    expect(t.sqlDraft).toBe('SELECT my draft'); // draft preserved exactly
    expect(t.dirtySql).toBe(true);
    expect(t.savedId).toBe('q1'); // stays linked
    expect(t.externalState).toBe('conflict');
  });

  it('re-running over an already-conflict tab keeps it conflict without reporting a change', () => {
    const s = savedTestState();
    const t = linkedTab('t1', q('q1', 'SELECT 1'));
    t.sqlDraft = 'draft';
    t.dirtySql = true;
    t.externalState = 'conflict';
    s.tabs.value = [t];
    const summary = reconcileLinkedTabsToLatest(s, ws([q('q1', 'SELECT external')]));
    expect(summary.conflicts).toBe(1);
    expect(summary.changed).toBe(false);
    expect(t.externalState).toBe('conflict');
  });

  it('a CLEAN linked tab whose query was DELETED externally detaches (SQL mode, unlinked)', () => {
    const s = savedTestState();
    const t = linkedTab('t1', q('q1', 'SELECT 1'));
    t.editorMode = 'spec';
    s.tabs.value = [t];
    const summary = reconcileLinkedTabsToLatest(s, ws([]));
    expect(summary).toEqual({ changed: true, conflicts: 0 });
    expect(t.savedId).toBeNull();
    expect(t.editorMode).toBe('sql');
    expect(t.lastCommittedQueryToken).toBeUndefined();
    expect(t.externalState).toBeNull();
  });

  it('a DIRTY linked tab whose query was DELETED externally becomes an unsaved draft flagged deleted', () => {
    const s = savedTestState();
    const t = linkedTab('t1', q('q1', 'SELECT 1'));
    t.sqlDraft = 'SELECT still editing';
    t.dirtySql = true;
    s.tabs.value = [t];
    const summary = reconcileLinkedTabsToLatest(s, ws([]));
    expect(summary).toEqual({ changed: true, conflicts: 0 });
    expect(t.savedId).toBeNull(); // no implicit recreate — it's now unsaved
    expect(t.sqlDraft).toBe('SELECT still editing'); // draft intact
    expect(t.lastCommittedQueryToken).toBeUndefined();
    expect(t.externalState).toBe('deleted');
  });

  it('an unsaved tab and an unchanged linked tab are no-ops', () => {
    const s = savedTestState();
    const unsaved = newTabObj('t1'); // savedId null
    const query = q('q1', 'SELECT 1');
    const inSync = linkedTab('t2', query);
    s.tabs.value = [unsaved, inSync];
    const summary = reconcileLinkedTabsToLatest(s, ws([query]));
    expect(summary).toEqual({ changed: false, conflicts: 0 });
    expect(unsaved.savedId).toBeNull();
    expect(inSync.savedId).toBe('q1');
    expect(inSync.externalState).toBeUndefined();
  });

  it('a noop NEVER auto-clears an existing conflict — explicit resolution only (#343 review blocker)', () => {
    const s = savedTestState();
    const query = q('q1', 'SELECT 1');
    const t = linkedTab('t1', query);
    // Flagged earlier; the persisted token now matches this tab's baseline
    // again (e.g. a metadata patch advanced both). Token equality cannot prove
    // the divergence disappeared, so the flag must survive until the user
    // picks Reload-saved-version or Keep-my-draft.
    t.sqlDraft = 'SELECT stale draft';
    t.dirtySql = true;
    t.externalState = 'conflict';
    s.tabs.value = [t];
    const summary = reconcileLinkedTabsToLatest(s, ws([query]));
    expect(summary).toEqual({ changed: false, conflicts: 1 });
    expect(t.externalState).toBe('conflict');
    expect(t.savedId).toBe('q1');
  });

  it('a noop does NOT clear the deleted-elsewhere flag on an orphaned (unlinked) tab', () => {
    const s = savedTestState();
    const t = newTabObj('t1'); // orphaned earlier: savedId already null
    t.sqlDraft = 'SELECT still editing';
    t.dirtySql = true;
    t.externalState = 'deleted';
    s.tabs.value = [t];
    const summary = reconcileLinkedTabsToLatest(s, ws([]));
    expect(summary).toEqual({ changed: false, conflicts: 0 });
    expect(t.externalState).toBe('deleted'); // badge stays until the user acts
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
    const mutate = fakeMutateWorkspace(s);
    s.tabs.value[0].sqlDraft = 'SELECT 9';
    const e = okEntry(await createSavedQuery(s, s.tabs.value[0], 'nine', undefined, mutate));
    await renameSaved(s, e.id, 'nine!', undefined, mutate);
    await toggleFavorite(s, e.id, mutate);
    await deleteSaved(s, 'nope', mutate);
    expect(mutate.commit).toHaveBeenCalledTimes(4);
    expect(s.savedQueries.some((q) => q.id === e.id)).toBe(true);
  });
});
