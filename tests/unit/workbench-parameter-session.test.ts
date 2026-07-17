import { describe, it, expect, vi } from 'vitest';
import { createWorkbenchParameterSession } from '../../src/application/workbench-parameter-session.js';
import type {
  WorkbenchParameterSessionDeps, WorkbenchParameterSessionHooks,
} from '../../src/application/workbench-parameter-session.js';
import { newTabObj, KEYS } from '../../src/state.js';
import type { QueryTab, SaveJSON } from '../../src/state.js';
import { emptyRecentMap, recordRecent } from '../../src/core/recent-values.js';
import type { RecentMap } from '../../src/core/recent-values.js';
import type { SchemaDb } from '../../src/core/from-scope.js';
import type { PreparedFieldState, FieldControl } from '../../src/core/param-pipeline.js';

// WorkbenchParameterSession (#276 Phase 4B1) — the `{name:Type}` query-
// variable POLICY extracted from app.ts, unit-tested directly against fake
// deps/hooks (no App, no DOM). app.test.ts's own var-strip/export/persistence
// suites are the end-to-end safety net for the app.ts wiring; these tests are
// the session's own unit surface.

// ── Fakes ────────────────────────────────────────────────────────────────────

function makeHooks(): WorkbenchParameterSessionHooks & {
  onGateBlocked: ReturnType<typeof vi.fn>;
  saveVarRecent: ReturnType<typeof vi.fn>;
} {
  return { onGateBlocked: vi.fn(), saveVarRecent: vi.fn() };
}

/** Mutable backing store for the accessor closures below — mirrors a real
 *  `AppState` slice closely enough to exercise the live-state contract (a
 *  write through `state.varValues` is observed on the NEXT accessor read,
 *  never a snapshot). Exposed alongside `deps` so a test can both drive state
 *  changes and assert on them without going through the session. */
function makeState(): {
  varValues: Record<string, string>;
  filterActive: Record<string, boolean>;
  varRecent: RecentMap;
  varRecentDisabled: boolean;
  schema: SchemaDb[] | null;
} {
  return {
    varValues: {}, filterActive: {}, varRecent: emptyRecentMap(), varRecentDisabled: false, schema: null,
  };
}

function makeDeps(over: {
  state?: ReturnType<typeof makeState>;
  tab?: QueryTab;
  wallNow?: () => number;
  saveJSON?: ReturnType<typeof vi.fn>;
  hooks?: ReturnType<typeof makeHooks>;
} = {}): {
  deps: WorkbenchParameterSessionDeps;
  state: ReturnType<typeof makeState>;
  tab: QueryTab;
  saveJSON: ReturnType<typeof vi.fn>;
  hooks: ReturnType<typeof makeHooks>;
} {
  const state = over.state || makeState();
  // `'tab' in over` (not `over.tab || …`) — a test deliberately passing
  // `tab: null` (the no-active-tab defensive case) must NOT fall back to a
  // fresh tab, which `null || newTabObj(...)` would silently do.
  const tab = 'tab' in over ? over.tab! : newTabObj('t1');
  const saveJSON = over.saveJSON || vi.fn();
  const hooks = over.hooks || makeHooks();
  const wallNow = over.wallNow || (() => 1700000000000);
  const deps: WorkbenchParameterSessionDeps = {
    varValues: () => state.varValues,
    filterActive: () => state.filterActive,
    varRecent: () => state.varRecent,
    setVarRecent: (map) => { state.varRecent = map; },
    varRecentDisabled: () => state.varRecentDisabled,
    schema: () => state.schema,
    activeTab: () => tab,
    wallNow,
    saveJSON: saveJSON as unknown as SaveJSON,
    hooks,
  };
  return { deps, state, tab, saveJSON, hooks };
}

// ── tabAnalysis / prepareAnalyzedBatch / prepareTabBatch / prepareTabSource ──

describe('tabAnalysis / prepare*', () => {
  it('tabAnalysis analyzes the SQL as the single "tab" source (row-returning bind policy)', () => {
    const { deps } = makeDeps();
    const session = createWorkbenchParameterSession(deps);
    const analysis = session.tabAnalysis('SELECT {year:UInt16}');
    expect(analysis.sources).toHaveLength(1);
    expect(analysis.sources[0].id).toBe('tab');
    expect(Object.keys(analysis.fields)).toEqual(['year']);
  });

  it('prepareAnalyzedBatch prepares against the live varValues + #165 activation map', () => {
    const { deps, state } = makeDeps();
    const session = createWorkbenchParameterSession(deps);
    state.varValues.year = '2024';
    const analysis = session.tabAnalysis('SELECT {year:UInt16}');
    const batch = session.prepareAnalyzedBatch(analysis, 1700000000000);
    expect(batch.sources[0].statements[0].args).toEqual({ param_year: '2024' });
    expect(batch.fields.year.state).toBe('ok');
  });

  it('prepareTabBatch / prepareTabSource compose tabAnalysis + prepareAnalyzedBatch for a raw SQL string', () => {
    const { deps, state } = makeDeps();
    const session = createWorkbenchParameterSession(deps);
    state.varValues.year = '2024';
    const batch = session.prepareTabBatch('SELECT {year:UInt16}', 1700000000000);
    expect(batch.sources[0].statements[0].args).toEqual({ param_year: '2024' });
    const src = session.prepareTabSource('SELECT {year:UInt16}', 1700000000000);
    expect(src.id).toBe(batch.sources[0].id); // prepareTabSource === prepareTabBatch(...).sources[0]
    expect(src.statements[0].args).toEqual({ param_year: '2024' });
  });

  it('reads live state, not a snapshot: a value written after construction is seen on the next prepare', () => {
    const { deps, state } = makeDeps();
    const session = createWorkbenchParameterSession(deps);
    expect(session.prepareTabSource('SELECT {year:UInt16}', 1700000000000).missing).toEqual(['year']);
    state.varValues.year = '2024'; // filter-bar.ts/dashboard.ts/results.ts write app.state.varValues directly
    expect(session.prepareTabSource('SELECT {year:UInt16}', 1700000000000).missing).toEqual([]);
  });

  it('#165 activation: an explicit filterActive entry overrides the derived-from-value default', () => {
    const { deps, state } = makeDeps();
    const session = createWorkbenchParameterSession(deps);
    const sql = 'SELECT 1 /*[ AND a = {a:String} ]*/';
    state.varValues.a = 'x';
    state.filterActive.a = false; // explicit inactive wins over "has a value"
    const src = session.prepareTabSource(sql, 1700000000000);
    expect(src.statements[0].sql).toBe('SELECT 1 ');
  });
});

// ── execStatementSql ─────────────────────────────────────────────────────────

describe('execStatementSql', () => {
  it('materializes only active optional blocks for a row-returning statement (#165)', () => {
    const { deps, state } = makeDeps();
    const session = createWorkbenchParameterSession(deps);
    const sql = 'SELECT 1 /*[ AND a = {a:String} ]*/';
    expect(session.execStatementSql(sql)).toBe('SELECT 1 '); // inactive by default (blank value)
    state.varValues.a = 'x';
    expect(session.execStatementSql(sql)).toBe('SELECT 1  AND a = {a:String} ');
  });

  it('passes a non-row-returning statement through verbatim (#134 bind gate)', () => {
    const { deps } = makeDeps();
    const session = createWorkbenchParameterSession(deps);
    const ddl = 'CREATE TABLE t (a String) ENGINE=Memory';
    expect(session.execStatementSql(ddl)).toBe(ddl);
  });
});

// ── varGateBlocked ───────────────────────────────────────────────────────────

describe('varGateBlocked', () => {
  it('is false when there is no active tab (defensive)', () => {
    const { deps, hooks } = makeDeps({ tab: null as unknown as QueryTab });
    const session = createWorkbenchParameterSession(deps);
    expect(session.varGateBlocked(1700000000000)).toBe(false);
    expect(hooks.onGateBlocked).not.toHaveBeenCalled();
  });

  it('blocks + toasts "Enter a value for: …" for missing/invalid variables', () => {
    const tab = newTabObj('t1');
    tab.sqlDraft = 'SELECT {year:UInt16}';
    const { deps, hooks } = makeDeps({ tab });
    const session = createWorkbenchParameterSession(deps);
    expect(session.varGateBlocked(1700000000000)).toBe(true);
    expect(hooks.onGateBlocked).toHaveBeenCalledWith('Enter a value for: year');
  });

  it('blocks + toasts the first structural/serialization error when missing/invalid are empty', () => {
    const tab = newTabObj('t1');
    tab.sqlDraft = 'SELECT {db:String}';
    const { deps, state, hooks } = makeDeps({ tab });
    // An Array value against a scalar String declaration is a structural
    // serialization error (param-pipeline.ts), not missing/invalid — a real
    // shape share-linked/curated values can take even though `varValues`'s
    // static type says string.
    (state.varValues as unknown as Record<string, unknown>).db = ['not', 'scalar'];
    const session = createWorkbenchParameterSession(deps);
    expect(session.varGateBlocked(1700000000000)).toBe(true);
    expect(hooks.onGateBlocked).toHaveBeenCalledTimes(1);
    expect(hooks.onGateBlocked.mock.calls[0][0]).toContain('{db}');
  });

  it('is false (no toast) when every variable resolves cleanly', () => {
    const tab = newTabObj('t1');
    tab.sqlDraft = 'SELECT {year:UInt16}';
    const { deps, state, hooks } = makeDeps({ tab });
    state.varValues.year = '2024';
    const session = createWorkbenchParameterSession(deps);
    expect(session.varGateBlocked(1700000000000)).toBe(false);
    expect(hooks.onGateBlocked).not.toHaveBeenCalled();
  });

  it('defaults wallNowMs to deps.wallNow() when omitted', () => {
    const tab = newTabObj('t1');
    tab.sqlDraft = 'SELECT {d:DateTime}';
    const wallNow = vi.fn(() => 1700000000000);
    const { deps, state } = makeDeps({ tab, wallNow });
    state.varValues.d = 'now-1h';
    const session = createWorkbenchParameterSession(deps);
    session.varGateBlocked(); // no explicit wave clock
    expect(wallNow).toHaveBeenCalled();
  });
});

// ── hardenVar / inputGate ────────────────────────────────────────────────────

describe('hardenVar / inputGate', () => {
  it('hardenVar adds a name on an invalid field verdict, clears it otherwise', () => {
    const { deps } = makeDeps();
    const session = createWorkbenchParameterSession(deps);
    const invalid: PreparedFieldState = { state: 'invalid', reason: 'nope' };
    const ok: PreparedFieldState = { state: 'ok' };
    session.hardenVar('year', invalid);
    expect(session.hardenedVars.has('year')).toBe(true);
    session.hardenVar('year', ok);
    expect(session.hardenedVars.has('year')).toBe(false);
    // No field at all (e.g. the name dropped out of the batch) also clears.
    session.hardenVar('year', invalid);
    session.hardenVar('year', undefined);
    expect(session.hardenedVars.has('year')).toBe(false);
  });

  it('inputGate folds in a hardened name still present in the batch (and not already invalid)', () => {
    const { deps } = makeDeps();
    const session = createWorkbenchParameterSession(deps);
    session.hardenedVars.add('year');
    const analysis = session.tabAnalysis('SELECT {year:UInt16}');
    const gate = session.inputGate(analysis);
    expect(gate.invalid).toContain('year'); // 'input' mode alone wouldn't flag a blank value as invalid
  });

  it('inputGate never double-lists a hardened name the lenient recompute already marked invalid', () => {
    const { deps, state } = makeDeps();
    state.varValues.year = '999999'; // out of UInt16 range — invalid even in lenient 'input' mode
    const session = createWorkbenchParameterSession(deps);
    session.hardenedVars.add('year');
    const analysis = session.tabAnalysis('SELECT {year:UInt16}');
    const gate = session.inputGate(analysis);
    expect(gate.invalid).toEqual(['year']); // not ['year','year']
  });

  it('inputGate drops a hardened name that is not part of THIS batch (a different tab\'s field)', () => {
    const { deps } = makeDeps();
    const session = createWorkbenchParameterSession(deps);
    session.hardenedVars.add('other'); // never appears in this analysis
    const analysis = session.tabAnalysis('SELECT {year:UInt16}');
    const gate = session.inputGate(analysis);
    expect(gate.invalid).not.toContain('other');
  });
});

// ── inferredEnumOptions (#172 v2) ────────────────────────────────────────────

describe('inferredEnumOptions', () => {
  const ENUM_STATUS = "Enum8('active' = 1, 'deleted' = 2)";
  const fc = (over: Partial<FieldControl> = {}): FieldControl => ({ name: 's', type: 'String', optional: false, ...over });

  it('returns null for a non-String declared type', () => {
    const { deps } = makeDeps();
    const session = createWorkbenchParameterSession(deps);
    expect(session.inferredEnumOptions(fc({ type: 'UInt16' }), 'SELECT {s:UInt16}', {})).toBeNull();
  });

  it('returns null when the param has no resolved comparison column', () => {
    const { deps } = makeDeps();
    const session = createWorkbenchParameterSession(deps);
    expect(session.inferredEnumOptions(fc(), 'SELECT {s:String}', {})).toBeNull();
  });

  it('returns null when the compared column type cannot be resolved (schema not loaded / ambiguous)', () => {
    const { deps } = makeDeps();
    const session = createWorkbenchParameterSession(deps);
    const sql = 'SELECT * FROM events WHERE status = {s:String}';
    expect(session.inferredEnumOptions(fc(), sql, { s: { qualifier: null, column: 'status', pos: sql.indexOf('{s') } })).toBeNull();
  });

  it('resolves the compared column\'s Enum members against the live schema cache', () => {
    const { deps, state } = makeDeps();
    state.schema = [{ db: 'app', tables: [{ name: 'events', columns: [{ name: 'status', type: ENUM_STATUS }] }] }];
    const session = createWorkbenchParameterSession(deps);
    const sql = 'SELECT * FROM events WHERE status = {s:String}';
    const comparisonColumns = { s: { qualifier: null, column: 'status', pos: sql.indexOf('{s') } };
    expect(session.inferredEnumOptions(fc(), sql, comparisonColumns)).toEqual(['active', 'deleted']);
  });

  it('is value-transparent for LowCardinality(String) (#238)', () => {
    const { deps, state } = makeDeps();
    state.schema = [{ db: 'app', tables: [{ name: 'events', columns: [{ name: 'status', type: ENUM_STATUS }] }] }];
    const session = createWorkbenchParameterSession(deps);
    const sql = 'SELECT * FROM events WHERE status = {s:LowCardinality(String)}';
    const comparisonColumns = { s: { qualifier: null, column: 'status', pos: sql.indexOf('{s') } };
    expect(session.inferredEnumOptions(fc({ type: 'LowCardinality(String)' }), sql, comparisonColumns)).toEqual(['active', 'deleted']);
  });

  it('returns null when the resolved column type has no Enum members', () => {
    const { deps, state } = makeDeps();
    state.schema = [{ db: 'app', tables: [{ name: 'events', columns: [{ name: 'status', type: 'String' }] }] }];
    const session = createWorkbenchParameterSession(deps);
    const sql = 'SELECT * FROM events WHERE status = {s:String}';
    const comparisonColumns = { s: { qualifier: null, column: 'status', pos: sql.indexOf('{s') } };
    expect(session.inferredEnumOptions(fc(), sql, comparisonColumns)).toBeNull();
  });
});

// ── hardenedVars aliasing ────────────────────────────────────────────────────

describe('hardenedVars', () => {
  it('is a single Set instance, mutated in place by hardenVar (the app.params.hardenedVars read invariant)', () => {
    const { deps } = makeDeps();
    const session = createWorkbenchParameterSession(deps);
    const ref = session.hardenedVars;
    session.hardenVar('year', { state: 'invalid' });
    expect(ref.has('year')).toBe(true); // the SAME Set a caller aliased earlier observes the mutation
    expect(session.hardenedVars).toBe(ref); // never reassigned
  });
});

// ── persistence wrappers ─────────────────────────────────────────────────────

describe('saveVarValues / saveFilterActive / saveVarRecent / saveVarRecentDisabled', () => {
  it('each persists its own field under its own KEYS entry', () => {
    const { deps, state, saveJSON } = makeDeps();
    const session = createWorkbenchParameterSession(deps);
    state.varValues.a = '1';
    state.filterActive.a = true;
    state.varRecent = recordRecent(emptyRecentMap(), 'a', '1');
    state.varRecentDisabled = true;

    session.saveVarValues();
    expect(saveJSON).toHaveBeenCalledWith(KEYS.varValues, state.varValues);
    session.saveFilterActive();
    expect(saveJSON).toHaveBeenCalledWith(KEYS.filterActive, state.filterActive);
    session.saveVarRecent();
    expect(saveJSON).toHaveBeenCalledWith(KEYS.varRecent, state.varRecent);
    session.saveVarRecentDisabled();
    expect(saveJSON).toHaveBeenCalledWith(KEYS.varRecentDisabled, true);
  });
});

// ── recordBoundParams / clearVarRecent / clearAllVarRecent (#171) ──────────

describe('recordBoundParams', () => {
  it('is a no-op (no state write, no persist hook) while history recording is disabled', () => {
    const { deps, state, hooks } = makeDeps();
    state.varRecentDisabled = true;
    const before = state.varRecent;
    const session = createWorkbenchParameterSession(deps);
    session.recordBoundParams([{ name: 'a', rawValue: '1' }]);
    expect(state.varRecent).toBe(before);
    expect(hooks.saveVarRecent).not.toHaveBeenCalled();
  });

  it('is a no-op for an empty/absent boundParams list', () => {
    const { deps, state, hooks } = makeDeps();
    const before = state.varRecent;
    const session = createWorkbenchParameterSession(deps);
    session.recordBoundParams([]);
    session.recordBoundParams(null as unknown as Array<{ name: string; rawValue: unknown }>);
    expect(state.varRecent).toBe(before);
    expect(hooks.saveVarRecent).not.toHaveBeenCalled();
  });

  it('skips an Array-valued rawValue (#172 not-yet-built enum controls) and records only string values', () => {
    const { deps, state, hooks } = makeDeps();
    const session = createWorkbenchParameterSession(deps);
    session.recordBoundParams([
      { name: 'arr', rawValue: ['x', 'y'] },
      { name: 'a', rawValue: '1' },
    ]);
    expect(state.varRecent.byName.arr).toBeUndefined();
    expect(state.varRecent.byName.a).toBeDefined();
    expect(hooks.saveVarRecent).toHaveBeenCalledTimes(1);
  });

  it('is a no-op (no persist hook) when nothing actually changed (an Array-only batch)', () => {
    const { deps, state, hooks } = makeDeps();
    const before = state.varRecent;
    const session = createWorkbenchParameterSession(deps);
    session.recordBoundParams([{ name: 'arr', rawValue: ['x'] }]);
    expect(state.varRecent).toBe(before);
    expect(hooks.saveVarRecent).not.toHaveBeenCalled();
  });
});

describe('clearVarRecent', () => {
  it('is a no-op (no persist hook) for a name with no recorded history', () => {
    const { deps, state, hooks } = makeDeps();
    state.varRecent = recordRecent(emptyRecentMap(), 'a', '1');
    const before = state.varRecent;
    const session = createWorkbenchParameterSession(deps);
    session.clearVarRecent('nope');
    expect(state.varRecent).toBe(before);
    expect(hooks.saveVarRecent).not.toHaveBeenCalled();
  });

  it('clears the name\'s history and persists via the hook (routed through the reassignable app seam)', () => {
    const { deps, state, hooks } = makeDeps();
    state.varRecent = recordRecent(emptyRecentMap(), 'a', '1');
    const session = createWorkbenchParameterSession(deps);
    session.clearVarRecent('a');
    expect(state.varRecent.byName.a).toBeUndefined();
    expect(hooks.saveVarRecent).toHaveBeenCalledTimes(1);
  });
});

describe('clearAllVarRecent', () => {
  it('resets every name\'s history and always persists', () => {
    const { deps, state, hooks } = makeDeps();
    state.varRecent = recordRecent(recordRecent(emptyRecentMap(), 'a', '1'), 'b', '2');
    const session = createWorkbenchParameterSession(deps);
    session.clearAllVarRecent();
    expect(state.varRecent).toEqual(emptyRecentMap());
    expect(hooks.saveVarRecent).toHaveBeenCalledTimes(1);
  });
});
