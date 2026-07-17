import { describe, it, expect, vi } from 'vitest';
import { signal } from '@preact/signals-core';
import { createSavedQueryService } from '../../src/application/saved-query-service.js';
import type { SavedQueryServiceDeps } from '../../src/application/saved-query-service.js';
import { newTabObj, KEYS, savedForTab } from '../../src/state.js';
import type { QueryTab, AppState, SpecValidationService, SaveJSON } from '../../src/state.js';
import type { SpecValidationDiagnostic } from '../../src/core/spec-draft.js';
import { encodeShare, decodeShare } from '../../src/core/share.js';
import { withQuerySpec } from '../../src/core/saved-query.js';
import type { SavedQueryV2 } from '../../src/generated/json-schema.types.js';

// SavedQueryService (#276 Phase 4C) — the saved-query create/commit policy,
// history recording, and share-URL building extracted from app.ts, unit-
// tested directly against fake deps (no App, no DOM, no editor port, no
// QueryDocumentSession — this service takes an already-evaluated Spec as
// input, matching the plan-review ruling that the two never call each
// other). app.test.ts's own share/save suites are the end-to-end safety net
// for the app.ts wiring (evaluate → commit/share); these tests are the
// service's own unit surface.

// ── Fakes ────────────────────────────────────────────────────────────────────

type StateSlice = Pick<AppState, 'savedQueries' | 'resultView' | 'libraryDirty' | 'history'>;

function makeState(over: Partial<StateSlice> = {}): StateSlice {
  return {
    savedQueries: over.savedQueries ?? [],
    resultView: over.resultView ?? signal<'table' | 'json' | 'panel' | 'filter'>('table'),
    libraryDirty: over.libraryDirty ?? signal(false),
    history: over.history ?? [],
  };
}

const ALWAYS_VALID: SpecValidationService = { validate: () => [] };
const ALWAYS_BLOCKING: SpecValidationService = {
  validate: () => [{ path: [], severity: 'error', code: 'blocked', message: 'blocked by fake validator' }],
};

function makeDeps(over: {
  state?: StateSlice;
  saveJSON?: ReturnType<typeof vi.fn>;
  now?: () => number;
  specValidators?: SpecValidationService;
} = {}): { deps: SavedQueryServiceDeps; state: StateSlice; saveJSON: ReturnType<typeof vi.fn> } {
  const state = over.state || makeState();
  const saveJSON = over.saveJSON || vi.fn();
  const deps: SavedQueryServiceDeps = {
    state,
    saveJSON: saveJSON as unknown as SaveJSON,
    now: over.now || (() => 1700000000000),
    specValidators: over.specValidators || ALWAYS_VALID,
  };
  return { deps, state, saveJSON };
}

const validEvaluated = (parsed: unknown = { name: 'Q', favorite: false }): { parsed: unknown; diagnostics: SpecValidationDiagnostic[] } =>
  ({ parsed, diagnostics: [] });

// ── create ───────────────────────────────────────────────────────────────────

describe('create', () => {
  it('creates and persists a new saved query from an unsaved tab', () => {
    const tab = newTabObj('t1');
    tab.sqlDraft = 'SELECT 1';
    const { deps, state, saveJSON } = makeDeps();
    const result = createSavedQueryService(deps).create(tab, 'My query', 'a desc');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.entry).toMatchObject({ sql: 'SELECT 1', spec: { name: 'My query', description: 'a desc' } });
    expect(state.savedQueries).toEqual([result.entry]);
    expect(tab.savedId).toBe(result.entry.id);
    expect(state.libraryDirty.value).toBe(true);
    expect(saveJSON).toHaveBeenCalledWith(KEYS.saved, state.savedQueries);
    expect(result.entry.id.startsWith('s1700000000000')).toBe(true); // deps.now() feeds the minted id
  });

  it('rejects (no persistence) a tab already linked to a saved query', () => {
    const tab = newTabObj('t1');
    tab.sqlDraft = 'SELECT 1';
    tab.savedId = 'already-linked';
    const { deps, state, saveJSON } = makeDeps();
    const result = createSavedQueryService(deps).create(tab, 'My query', '');
    expect(result).toEqual({ ok: false });
    expect(state.savedQueries).toEqual([]);
    expect(saveJSON).not.toHaveBeenCalled();
  });

  it('rejects (no persistence) blank SQL on a non-text-panel tab', () => {
    const tab = newTabObj('t1');
    tab.sqlDraft = '   ';
    const { deps, state, saveJSON } = makeDeps();
    const result = createSavedQueryService(deps).create(tab, 'My query', '');
    expect(result).toEqual({ ok: false });
    expect(state.savedQueries).toEqual([]);
    expect(saveJSON).not.toHaveBeenCalled();
  });

  it('rejects (no persistence) a blank name', () => {
    const tab = newTabObj('t1');
    tab.sqlDraft = 'SELECT 1';
    const { deps, state } = makeDeps();
    const result = createSavedQueryService(deps).create(tab, '   ', '');
    expect(result).toEqual({ ok: false });
    expect(state.savedQueries).toEqual([]);
  });

  it('rejects (no persistence) when the injected specValidators blocks the resulting Spec', () => {
    const tab = newTabObj('t1');
    tab.sqlDraft = 'SELECT 1';
    const { deps, state, saveJSON } = makeDeps({ specValidators: ALWAYS_BLOCKING });
    const result = createSavedQueryService(deps).create(tab, 'My query', '');
    expect(result).toEqual({ ok: false });
    expect(state.savedQueries).toEqual([]);
    expect(saveJSON).not.toHaveBeenCalled();
  });
});

// ── commit ───────────────────────────────────────────────────────────────────

describe('commit', () => {
  function linkedState(tab: QueryTab, sql = 'SELECT 1'): StateSlice {
    const entry = { id: 's1', sql, specVersion: 1, spec: { name: 'Existing', favorite: false } } as SavedQueryV2;
    tab.savedId = entry.id;
    return makeState({ savedQueries: [entry] });
  }

  it('rejects with invalid-spec when the evaluated Spec has no parsed draft', () => {
    const tab = newTabObj('t1');
    const state = linkedState(tab);
    const { deps, saveJSON } = makeDeps({ state });
    const result = createSavedQueryService(deps).commit(tab, { parsed: null, diagnostics: [] });
    expect(result).toEqual({ ok: false, reason: 'invalid-spec' });
    expect(saveJSON).not.toHaveBeenCalled();
  });

  it('rejects with invalid-spec when the evaluated Spec carries a blocking diagnostic', () => {
    const tab = newTabObj('t1');
    const state = linkedState(tab);
    const { deps, saveJSON } = makeDeps({ state });
    const evaluated = {
      parsed: { name: 'Q', favorite: false },
      diagnostics: [{ path: [], severity: 'error' as const, code: 'x', message: 'bad' }],
    };
    const result = createSavedQueryService(deps).commit(tab, evaluated);
    expect(result).toEqual({ ok: false, reason: 'invalid-spec' });
    expect(saveJSON).not.toHaveBeenCalled();
  });

  it('rejects with empty when SQL is blank on a non-queryless panel', () => {
    const tab = newTabObj('t1');
    tab.sqlDraft = '   ';
    const state = linkedState(tab, '');
    const { deps, saveJSON } = makeDeps({ state });
    const result = createSavedQueryService(deps).commit(tab, validEvaluated());
    expect(result).toEqual({ ok: false, reason: 'empty' });
    expect(saveJSON).not.toHaveBeenCalled();
  });

  it('accepts blank SQL on a queryless (text) panel', () => {
    const tab = newTabObj('t1');
    tab.sqlDraft = '';
    const state = linkedState(tab, '');
    const { deps, saveJSON, state: s } = makeDeps({ state });
    const evaluated = validEvaluated({ name: 'Q', favorite: false, panel: { cfg: { type: 'text', content: 'hi' } } });
    const result = createSavedQueryService(deps).commit(tab, evaluated);
    expect(result.ok).toBe(true);
    expect(saveJSON).toHaveBeenCalledWith(KEYS.saved, s.savedQueries);
  });

  it('rejects with rejected when commitSavedQuery itself declines (tab no longer linked)', () => {
    const tab = newTabObj('t1');
    tab.sqlDraft = 'SELECT 1';
    tab.savedId = 'does-not-exist'; // linked id absent from savedQueries → index < 0
    const { deps, saveJSON } = makeDeps();
    const result = createSavedQueryService(deps).commit(tab, validEvaluated());
    expect(result).toEqual({ ok: false, reason: 'rejected' });
    expect(saveJSON).not.toHaveBeenCalled();
  });

  it('rejects with rejected when the injected specValidators blocks the normalized Spec even though the input evaluation was clean', () => {
    const tab = newTabObj('t1');
    tab.sqlDraft = 'SELECT 1';
    const state = linkedState(tab);
    const { deps, saveJSON } = makeDeps({ state, specValidators: ALWAYS_BLOCKING });
    const result = createSavedQueryService(deps).commit(tab, validEvaluated());
    expect(result).toEqual({ ok: false, reason: 'rejected' });
    expect(saveJSON).not.toHaveBeenCalled();
  });

  it('commits and persists an update to the linked saved query', () => {
    const tab = newTabObj('t1');
    tab.sqlDraft = 'SELECT 2';
    const state = linkedState(tab);
    const { deps, saveJSON, state: s } = makeDeps({ state });
    const evaluated = validEvaluated({ name: 'Renamed', favorite: true });
    const result = createSavedQueryService(deps).commit(tab, evaluated);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.entry).toMatchObject({ id: 's1', sql: 'SELECT 2', spec: { name: 'Renamed', favorite: true } });
    expect(s.savedQueries[0]).toEqual(result.entry);
    expect(s.libraryDirty.value).toBe(true);
    expect(saveJSON).toHaveBeenCalledWith(KEYS.saved, s.savedQueries);
  });
});

// ── recordHistory ────────────────────────────────────────────────────────────

describe('recordHistory', () => {
  it('records a row-count/ms history entry from a tab.result snapshot', () => {
    const tab = newTabObj('t1');
    tab.sqlDraft = 'SELECT 1';
    tab.result = { rawText: null, rows: [{}, {}, {}], progress: { elapsed_ns: 5_000_000 } };
    const { deps, state, saveJSON } = makeDeps();
    createSavedQueryService(deps).recordHistory(tab);
    expect(state.history).toEqual([expect.objectContaining({ sql: 'SELECT 1', rows: 3, ms: 5 })]);
    expect(saveJSON).toHaveBeenCalledWith(KEYS.history, state.history);
  });

  it('records rows: null for a raw-FORMAT result', () => {
    const tab = newTabObj('t1');
    tab.sqlDraft = 'SELECT 1 FORMAT CSV';
    tab.result = { rawText: '1\n', rows: [], progress: { elapsed_ns: 1_000_000 } };
    const { deps, state } = makeDeps();
    createSavedQueryService(deps).recordHistory(tab);
    expect(state.history[0]).toMatchObject({ rows: null, ms: 1 });
  });

  it('honors an sqlText override (e.g. a run selection) instead of tab.sqlDraft', () => {
    const tab = newTabObj('t1');
    tab.sqlDraft = 'SELECT 1; SELECT 2';
    tab.result = { rawText: null, rows: [], progress: { elapsed_ns: 0 } };
    const { deps, state } = makeDeps();
    createSavedQueryService(deps).recordHistory(tab, 'SELECT 2');
    expect(state.history[0]).toMatchObject({ sql: 'SELECT 2' });
  });
});

// ── buildShareUrl ────────────────────────────────────────────────────────────

describe('buildShareUrl', () => {
  const LOC = { origin: 'https://host', pathname: '/sql', search: '?x=1' };

  it('rejects with invalid-spec when there is no parsed draft', () => {
    const tab = newTabObj('t1');
    const { deps } = makeDeps();
    const result = createSavedQueryService(deps).buildShareUrl({ tab, evaluated: { parsed: null, diagnostics: [] }, ...LOC });
    expect(result).toEqual({ ok: false, reason: 'invalid-spec' });
  });

  it('rejects with invalid-spec when a diagnostic is blocking', () => {
    const tab = newTabObj('t1');
    const { deps } = makeDeps();
    const evaluated = {
      parsed: { name: 'Q', favorite: false },
      diagnostics: [{ path: [], severity: 'error' as const, code: 'x', message: 'bad' }],
    };
    const result = createSavedQueryService(deps).buildShareUrl({ tab, evaluated, ...LOC });
    expect(result).toEqual({ ok: false, reason: 'invalid-spec' });
  });

  it('rejects with empty when SQL is blank on a non-queryless panel', () => {
    const tab = newTabObj('t1');
    tab.sqlDraft = '  ';
    const { deps } = makeDeps();
    const result = createSavedQueryService(deps).buildShareUrl({ tab, evaluated: validEvaluated(), ...LOC });
    expect(result).toEqual({ ok: false, reason: 'empty' });
  });

  it('builds the exact same fragment core/share.js would encode, for a plain sql+spec query', () => {
    const tab = newTabObj('t1');
    tab.sqlDraft = 'SELECT 1';
    tab.savedId = 's9';
    const { deps } = makeDeps();
    const evaluated = validEvaluated({ name: 'Q', favorite: true, description: 'd' });
    const result = createSavedQueryService(deps).buildShareUrl({ tab, evaluated, ...LOC });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    const expectedQuery = withQuerySpec({ id: tab.savedId, sql: tab.sqlDraft }, evaluated.parsed);
    expect(result.url).toBe(`${LOC.origin}${LOC.pathname}${LOC.search}#${encodeShare(expectedQuery)}`);
  });

  it('preserves unknown/extension Spec fields through the encoded fragment', () => {
    const tab = newTabObj('t1');
    tab.sqlDraft = 'SELECT 1';
    const { deps } = makeDeps();
    const evaluated = validEvaluated({ name: 'Q', favorite: false, 'x-custom': { nested: true } });
    const result = createSavedQueryService(deps).buildShareUrl({ tab, evaluated, ...LOC });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    const hash = result.url.slice(result.url.indexOf('#') + 1);
    const decoded = decodeShare(hash);
    expect((decoded.spec as unknown as { 'x-custom': unknown })['x-custom']).toEqual({ nested: true });
  });

  it('accepts blank SQL on a queryless (text) panel', () => {
    const tab = newTabObj('t1');
    tab.sqlDraft = '';
    const { deps } = makeDeps();
    const evaluated = validEvaluated({ name: 'Q', favorite: false, panel: { cfg: { type: 'text', content: 'hi' } } });
    const result = createSavedQueryService(deps).buildShareUrl({ tab, evaluated, ...LOC });
    expect(result.ok).toBe(true);
  });
});

// Sanity: `savedForTab` (a state.ts helper this service's sibling session also
// depends on) still resolves against the narrowed slice this service itself
// persists into — proves the two extractions share one consistent state shape.
describe('cross-check with savedForTab', () => {
  it('a committed query is resolvable via savedForTab against the same state', () => {
    const tab = newTabObj('t1');
    tab.sqlDraft = 'SELECT 1';
    const { deps, state } = makeDeps();
    const result = createSavedQueryService(deps).create(tab, 'Q', '');
    expect(result.ok).toBe(true);
    expect(savedForTab(state, tab)).toEqual(result.ok ? result.entry : null);
  });
});
