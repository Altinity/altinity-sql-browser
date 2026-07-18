import { describe, it, expect, vi } from 'vitest';
import { signal } from '@preact/signals-core';
import { createQueryDocumentSession } from '../../src/application/query-document-session.js';
import type {
  QueryDocumentSessionDeps, QueryDocumentSessionHooks,
} from '../../src/application/query-document-session.js';
import { newTabObj, createSavedQuery } from '../../src/state.js';
import type { QueryTab, AppState } from '../../src/state.js';
import { createSpecValidatorRegistry, evaluateSpecText } from '../../src/core/spec-draft.js';
import type { QuerySpecValidationService } from '../../src/core/spec-draft.js';

// QueryDocumentSession (#276 Phase 4C) — the Spec-evaluation/document
// lifecycle extracted from app.ts, unit-tested directly against fake
// deps/hooks (no App, no DOM, no editor port). app.test.ts's own
// Spec/save/share suites are the end-to-end safety net for the app.ts wiring
// (evaluate → hooks); these tests are the session's own unit surface.

// ── Fakes ────────────────────────────────────────────────────────────────────

function makeHooks(): QueryDocumentSessionHooks & { [K in keyof QueryDocumentSessionHooks]: ReturnType<typeof vi.fn> } {
  return {
    setDiagnostics: vi.fn(),
    revealDiagnostic: vi.fn(),
    rerenderTabs: vi.fn(),
    updateSaveBtn: vi.fn(),
    updateEditorModeUi: vi.fn(),
  };
}

type StateSlice = Pick<AppState, 'tabs' | 'savedQueries'>;

function makeState(tabs: QueryTab[]): StateSlice {
  return { tabs: signal(tabs), savedQueries: [] };
}

function makeDeps(over: {
  tab?: QueryTab;
  tabs?: QueryTab[];
  state?: StateSlice;
  activeTab?: () => QueryTab;
  specValidators?: QuerySpecValidationService;
  hooks?: ReturnType<typeof makeHooks>;
} = {}): {
  deps: QueryDocumentSessionDeps;
  tab: QueryTab;
  state: StateSlice;
  hooks: ReturnType<typeof makeHooks>;
  specValidators: QuerySpecValidationService;
} {
  const tab = over.tab || newTabObj('t1');
  const state = over.state || makeState(over.tabs || [tab]);
  const activeTab = over.activeTab || (() => tab);
  const specValidators = over.specValidators || createSpecValidatorRegistry();
  const hooks = over.hooks || makeHooks();
  const deps: QueryDocumentSessionDeps = { state, activeTab, specValidators, hooks };
  return { deps, tab, state, hooks, specValidators };
}

const VALID_SPEC_TEXT = JSON.stringify({ name: 'Q', favorite: false });
const INVALID_JSON_TEXT = '{"name": ';
// A syntactically valid JSON document that fails canonical schema validation
// (wrong type for a known field) — a *blocking* diagnostic, distinct from the
// invalid-json case above.
const SCHEMA_INVALID_TEXT = JSON.stringify({ name: 123 });

// ── applySpecEvaluation ──────────────────────────────────────────────────────

describe('applySpecEvaluation', () => {
  it('parses valid Spec JSON onto the tab, defaulting dirty to true and touching no hooks', () => {
    const { deps, tab, hooks } = makeDeps();
    const result = createQueryDocumentSession(deps).applySpecEvaluation(tab, VALID_SPEC_TEXT);
    expect(result.parsed).toEqual({ name: 'Q', favorite: false });
    expect(result.diagnostics).toEqual([]);
    expect(tab.specText).toBe(VALID_SPEC_TEXT);
    expect(tab.specParsed).toEqual({ name: 'Q', favorite: false });
    expect(tab.specDiagnostics).toEqual([]);
    expect(tab.dirtySpec).toBe(true);
    expect(hooks.setDiagnostics).not.toHaveBeenCalled();
    expect(hooks.rerenderTabs).not.toHaveBeenCalled();
    expect(hooks.updateSaveBtn).not.toHaveBeenCalled();
    expect(hooks.updateEditorModeUi).not.toHaveBeenCalled();
  });

  it('honors an explicit dirty: false', () => {
    const { deps, tab } = makeDeps();
    createQueryDocumentSession(deps).applySpecEvaluation(tab, VALID_SPEC_TEXT, { dirty: false });
    expect(tab.dirtySpec).toBe(false);
  });

  it('records an invalid-json diagnostic and a null parsed draft', () => {
    const { deps, tab } = makeDeps();
    const result = createQueryDocumentSession(deps).applySpecEvaluation(tab, INVALID_JSON_TEXT);
    expect(result.parsed).toBeNull();
    expect(tab.specParsed).toBeNull();
    expect(result.diagnostics).toEqual([expect.objectContaining({ code: 'invalid-json', severity: 'error' })]);
  });

  it('records a blocking schema diagnostic for syntactically-valid-but-invalid JSON', () => {
    const { deps, tab } = makeDeps();
    const result = createQueryDocumentSession(deps).applySpecEvaluation(tab, SCHEMA_INVALID_TEXT);
    expect(result.parsed).toEqual({ name: 123 });
    expect(result.diagnostics.some((d) => d.severity === 'error')).toBe(true);
  });

  it('evaluates against sql/tab context (a Filter-role Spec depends on the linked SQL)', () => {
    const { deps, tab } = makeDeps();
    tab.sqlDraft = ''; // newTabObj's own default — a Filter-role Spec blocks on empty source SQL
    const spec = { name: 'F', favorite: false, dashboard: { role: 'filter' } };
    const result = createQueryDocumentSession(deps).applySpecEvaluation(tab, JSON.stringify(spec));
    // Same verdict `evaluateSpecText` itself would give for this SQL/spec pair
    // — proves `{sql: tab.sqlDraft, tab}` context is actually threaded through.
    const direct = evaluateSpecText(JSON.stringify(spec), deps.specValidators, { sql: tab.sqlDraft, tab });
    expect(result.diagnostics).toEqual(direct.diagnostics);
    expect(result.diagnostics.some((d) => d.code === 'filter-sql-empty')).toBe(true);
  });
});

// ── evaluateSpecDraft ────────────────────────────────────────────────────────

describe('evaluateSpecDraft', () => {
  it('repaints diagnostics + the full UI tail when the tab IS the active one', () => {
    const { deps, tab, hooks } = makeDeps();
    const session = createQueryDocumentSession(deps);
    const result = session.evaluateSpecDraft(tab, VALID_SPEC_TEXT, { dirty: false });
    expect(result.parsed).toEqual({ name: 'Q', favorite: false });
    expect(hooks.setDiagnostics).toHaveBeenCalledWith(tab.specDiagnostics);
    expect(hooks.rerenderTabs).toHaveBeenCalledTimes(1);
    expect(hooks.updateSaveBtn).toHaveBeenCalledTimes(1);
    expect(hooks.updateEditorModeUi).toHaveBeenCalledTimes(1);
    expect(tab.dirtySpec).toBe(false);
  });

  it('skips the diagnostics repaint (but still runs the rest of the tail) for a non-active tab', () => {
    const active = newTabObj('t1');
    const other = newTabObj('t2');
    const { deps, hooks } = makeDeps({ tab: active, tabs: [active, other], activeTab: () => active });
    const session = createQueryDocumentSession(deps);
    session.evaluateSpecDraft(other, VALID_SPEC_TEXT);
    expect(hooks.setDiagnostics).not.toHaveBeenCalled();
    expect(hooks.rerenderTabs).toHaveBeenCalledTimes(1);
    expect(hooks.updateSaveBtn).toHaveBeenCalledTimes(1);
    expect(hooks.updateEditorModeUi).toHaveBeenCalledTimes(1);
    expect(other.specParsed).toEqual({ name: 'Q', favorite: false });
  });
});

// ── revalidateSpecDrafts ─────────────────────────────────────────────────────

describe('revalidateSpecDrafts', () => {
  it('re-evaluates every open tab and repaints the active tab + full UI tail by default', () => {
    const active = newTabObj('t1');
    const other = newTabObj('t2');
    active.specText = VALID_SPEC_TEXT;
    other.specText = INVALID_JSON_TEXT;
    other.dirtySpec = true;
    const { deps, hooks } = makeDeps({ tab: active, tabs: [active, other], activeTab: () => active });
    createQueryDocumentSession(deps).revalidateSpecDrafts();
    expect(active.specParsed).toEqual({ name: 'Q', favorite: false });
    expect(other.specParsed).toBeNull();
    expect(other.dirtySpec).toBe(true); // preserves each tab's OWN existing dirty flag
    expect(hooks.setDiagnostics).toHaveBeenCalledWith(active.specDiagnostics);
    expect(hooks.rerenderTabs).toHaveBeenCalledTimes(1);
    expect(hooks.updateSaveBtn).toHaveBeenCalledTimes(1);
    expect(hooks.updateEditorModeUi).toHaveBeenCalledTimes(1);
  });

  it('preserves an existing dirtySpec: false while still re-evaluating', () => {
    const tab = newTabObj('t1');
    tab.specText = SCHEMA_INVALID_TEXT;
    tab.dirtySpec = false;
    const { deps } = makeDeps({ tab });
    createQueryDocumentSession(deps).revalidateSpecDrafts();
    expect(tab.specParsed).toEqual({ name: 123 });
    expect(tab.dirtySpec).toBe(false);
  });

  it('refreshUi: false re-evaluates every tab but touches no hook', () => {
    const tab = newTabObj('t1');
    tab.specText = VALID_SPEC_TEXT;
    const { deps, hooks } = makeDeps({ tab });
    createQueryDocumentSession(deps).revalidateSpecDrafts({ refreshUi: false });
    expect(tab.specParsed).toEqual({ name: 'Q', favorite: false });
    expect(hooks.setDiagnostics).not.toHaveBeenCalled();
    expect(hooks.rerenderTabs).not.toHaveBeenCalled();
    expect(hooks.updateSaveBtn).not.toHaveBeenCalled();
    expect(hooks.updateEditorModeUi).not.toHaveBeenCalled();
  });
});

// ── revealFirstSpecError ─────────────────────────────────────────────────────

describe('revealFirstSpecError', () => {
  it('reveals the first error-severity diagnostic on the active tab by default', () => {
    const tab = newTabObj('t1');
    tab.specDiagnostics = [
      { path: [], severity: 'warning', code: 'w', message: 'warn' },
      { path: ['name'], severity: 'error', code: 'e', message: 'bad' },
      { path: [], severity: 'error', code: 'e2', message: 'bad2' },
    ];
    const { deps, hooks } = makeDeps({ tab });
    createQueryDocumentSession(deps).revealFirstSpecError();
    expect(hooks.revealDiagnostic).toHaveBeenCalledWith(1);
  });

  it('reveals on an explicitly-passed tab instead of the active one', () => {
    const active = newTabObj('t1');
    const other = newTabObj('t2');
    other.specDiagnostics = [{ path: [], severity: 'error', code: 'e', message: 'bad' }];
    const { deps, hooks } = makeDeps({ tab: active, tabs: [active, other], activeTab: () => active });
    createQueryDocumentSession(deps).revealFirstSpecError(other);
    expect(hooks.revealDiagnostic).toHaveBeenCalledWith(0);
  });

  it('is a no-op when there is no error-severity diagnostic', () => {
    const tab = newTabObj('t1');
    tab.specDiagnostics = [{ path: [], severity: 'warning', code: 'w', message: 'warn' }];
    const { deps, hooks } = makeDeps({ tab });
    createQueryDocumentSession(deps).revealFirstSpecError();
    expect(hooks.revealDiagnostic).not.toHaveBeenCalled();
  });

  it('is a no-op when specDiagnostics is empty', () => {
    const tab = newTabObj('t1');
    tab.specDiagnostics = [];
    const { deps, hooks } = makeDeps({ tab });
    createQueryDocumentSession(deps).revealFirstSpecError();
    expect(hooks.revealDiagnostic).not.toHaveBeenCalled();
  });

  it('is a no-op when specDiagnostics is absent (defensive optional-chaining read)', () => {
    const tab = newTabObj('t1');
    tab.specDiagnostics = undefined as unknown as QueryTab['specDiagnostics'];
    const { deps, hooks } = makeDeps({ tab });
    createQueryDocumentSession(deps).revealFirstSpecError();
    expect(hooks.revealDiagnostic).not.toHaveBeenCalled();
  });
});

// ── registerSpecValidator ────────────────────────────────────────────────────

describe('registerSpecValidator', () => {
  it('registers a validator, revalidates every open tab, and revalidates again on unregister', () => {
    const tab = newTabObj('t1');
    // `description` is schema-typed as a plain string (no enum) — unlike
    // `view` (a closed enum), a registered validator at this path is never
    // schema-suppressed (`createSpecValidationService`'s own overlap-skip
    // only fires when the SCHEMA itself already flagged an error at the
    // same path), so this exercises the registered rule itself, not the
    // schema's.
    tab.specText = JSON.stringify({ name: 'Q', favorite: false, description: 'blocked-by-custom-rule' });
    const { deps, hooks } = makeDeps({ tab });
    const session = createQueryDocumentSession(deps);
    hooks.rerenderTabs.mockClear(); // constructor itself never revalidates

    const validate = vi.fn(({ value }: { value: unknown }) =>
      (value === 'blocked-by-custom-rule' ? [{ code: 'custom-blocked', message: 'nope' }] : []));
    const unregister = session.registerSpecValidator(['description'], validate);
    expect(validate).toHaveBeenCalled();
    expect(tab.specDiagnostics.some((d) => d.code === 'custom-blocked')).toBe(true);
    expect(hooks.rerenderTabs).toHaveBeenCalledTimes(1); // one revalidateSpecDrafts() call

    unregister();
    expect(tab.specDiagnostics.some((d) => d.code === 'custom-blocked')).toBe(false);
    expect(hooks.rerenderTabs).toHaveBeenCalledTimes(2); // revalidated again on unregister
  });
});

// ── resolveEditorMode ────────────────────────────────────────────────────────

describe('resolveEditorMode', () => {
  it('blocks entering spec mode on an unsaved (unlinked) tab, with a user-facing message', () => {
    const tab = newTabObj('t1');
    const { deps } = makeDeps({ tab });
    const gate = createQueryDocumentSession(deps).resolveEditorMode(tab, 'spec');
    expect(gate).toEqual({ ok: false, message: 'Save this query to create an editable Spec.' });
  });

  it('allows entering spec mode once the tab is linked to a saved query', async () => {
    const tab = newTabObj('t1');
    tab.sqlDraft = 'SELECT 1';
    const state = {
      tabs: signal([tab]), savedQueries: [] as AppState['savedQueries'],
      resultView: signal<'table' | 'json' | 'panel' | 'filter'>('table'), libraryDirty: signal(false),
      libraryName: signal('Lib'), workspaceId: 'w1', dashboard: null as AppState['dashboard'],
    };
    // Link the tab via the real state.ts create path — the exact invariant
    // `savedForTab` (this session's own dependency) reads. #287 W4: the
    // aggregate commit is a trivial always-succeeds echo — this test only
    // needs a real linked entry, not real persistence semantics.
    const result = await createSavedQuery(state, tab, 'My query', '', async (candidate) => ({
      ok: true, workspace: candidate, dashboardRevision: null,
    }), 0);
    expect(result.ok).toBe(true);
    const { deps } = makeDeps({ tab, state });
    const gate = createQueryDocumentSession(deps).resolveEditorMode(tab, 'spec');
    expect(gate).toEqual({ ok: true });
  });

  it('always allows sql mode', () => {
    const tab = newTabObj('t1');
    const { deps } = makeDeps({ tab });
    expect(createQueryDocumentSession(deps).resolveEditorMode(tab, 'sql')).toEqual({ ok: true });
  });

  it('rejects (silently) a mode outside sql/spec — a defensive runtime guard behind the typed signature', () => {
    const tab = newTabObj('t1');
    const { deps } = makeDeps({ tab });
    const bogus = 'bogus' as unknown as 'sql' | 'spec';
    expect(createQueryDocumentSession(deps).resolveEditorMode(tab, bogus)).toEqual({ ok: false });
  });
});
