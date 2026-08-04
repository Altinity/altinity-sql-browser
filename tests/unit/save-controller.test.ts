// #588 W2 — `createSaveController` (src/ui/workbench/save-controller.ts), the
// Save cluster (`updateSaveBtn`/`saveActiveQuery` + the linked commit/create/
// conflict-chooser paths they dispatch to) extracted verbatim from app.ts.
// Unit-tested directly against a fake `SaveControllerDeps` — no `createApp`,
// no full `App`. app.test.ts's own `actions.save`/`updateSaveBtn` suites
// remain the end-to-end composition safety net proving `createApp`'s real
// wiring reaches this controller (`app.updateSaveBtn`/`actions.save` stay
// flat delegates); this file is the controller's own unit surface, including
// the #457 kind-dispatch-first ordering (I-15) as a SABOTAGE-verified test in
// both `updateSaveBtn` and `saveActiveQuery`.
import { describe, it, expect, vi } from 'vitest';
import { createSaveController } from '../../src/ui/workbench/save-controller.js';
import type { SaveControllerDeps } from '../../src/ui/workbench/save-controller.js';
import { createAnchoredPopovers } from '../../src/ui/popover.js';
import type { AnchoredPopoverRefKey } from '../../src/ui/popover.js';
import { createState, newTabObj } from '../../src/state.js';
import type { QueryTab, AppState } from '../../src/state.js';
import { savedQuery } from '../helpers/saved-query.js';
import type { SavedQueryV2, StoredWorkspaceV5 } from '../../src/generated/json-schema.types.js';
import type { CommitLinkedResult, CreateSavedResult } from '../../src/application/saved-query-service.js';

const qs = <T extends Element = HTMLElement>(root: ParentNode | null, selector: string): T =>
  root!.querySelector(selector) as T;
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const reader = (over: Record<string, unknown> = {}) => ({
  loadStr: (k: string, dflt: string) => (k in over ? (over[k] as string) : dflt),
  loadJSON: (k: string, dflt: unknown) => (k in over ? over[k] : dflt),
});

// A workspace whose Dashboard `d` declares one {country:String} variable
// through query `q1`'s tile — enough for `dashboardVariables` (imported
// directly by save-controller.ts) to resolve a real `type` for the
// `lastKnownType` branch in `saveVariableTab`.
const variableWorkspace: StoredWorkspaceV5 = {
  id: 'w1',
  dashboards: [{ id: 'd', title: 'D', tiles: [{ id: 't1', queryId: 'q1' }] }] as StoredWorkspaceV5['dashboards'],
  queries: [{ id: 'q1', sql: 'SELECT 1 WHERE c = {country:String}', specVersion: 1, spec: { specVersion: 1, name: 'Q1' } }],
} as unknown as StoredWorkspaceV5;

function makeDeps(over: {
  tab?: QueryTab;
  savedQueries?: SavedQueryV2[];
  currentWorkspace?: StoredWorkspaceV5 | null;
  specBlocked?: (tab: QueryTab) => boolean;
  refreshCurrentSurfaceAfterStale?: (generation: number, committed?: boolean) => boolean;
  commit?: (tab: QueryTab, evaluated: { parsed: unknown; diagnostics: unknown[] }) => Promise<CommitLinkedResult>;
  create?: (tab: QueryTab, name: unknown, description: unknown) => Promise<CreateSavedResult>;
  commitVariableConfig?: (dashboardId: string, variableName: string, cfg: unknown) => unknown;
} = {}): {
  deps: SaveControllerDeps;
  tab: QueryTab;
  state: AppState;
  saveBtn: HTMLButtonElement;
  refs: Partial<Record<AnchoredPopoverRefKey, HTMLElement>>;
  spies: {
    rerenderTabs: ReturnType<typeof vi.fn>;
    updateEditorModeUi: ReturnType<typeof vi.fn>;
    renderSavedHistory: ReturnType<typeof vi.fn>;
    renderResults: ReturnType<typeof vi.fn>;
    syncSpecEditorFromState: ReturnType<typeof vi.fn>;
    syncBeforeUnload: ReturnType<typeof vi.fn>;
    refreshWorkspaceFromStore: ReturnType<typeof vi.fn>;
    revealFirstSpecError: ReturnType<typeof vi.fn>;
    revalidateSpecDrafts: ReturnType<typeof vi.fn>;
  };
} {
  const tab = over.tab ?? newTabObj('t1');
  const state = createState(reader());
  state.workspaceId = 'w1';
  state.savedQueries = over.savedQueries ?? [];
  state.tabs.value = [tab];
  state.activeTabId.value = tab.id;

  const refs: Partial<Record<AnchoredPopoverRefKey, HTMLElement>> = {};
  const popovers = createAnchoredPopovers({
    document,
    acquireKeyboardOwner: () => () => {},
    isMobile: () => false,
    viewportWidth: () => 1024,
    getRef: (key) => refs[key],
    setRef: (key, node) => { refs[key] = node; },
  });
  const saveBtn = document.body.appendChild(document.createElement('button'));

  const spies = {
    rerenderTabs: vi.fn(),
    updateEditorModeUi: vi.fn(),
    renderSavedHistory: vi.fn(),
    renderResults: vi.fn(),
    syncSpecEditorFromState: vi.fn(),
    syncBeforeUnload: vi.fn(),
    refreshWorkspaceFromStore: vi.fn(async () => {}),
    revealFirstSpecError: vi.fn(),
    revalidateSpecDrafts: vi.fn(),
  };

  const deps: SaveControllerDeps = {
    document,
    state,
    activeTab: () => tab,
    saved: {
      commit: over.commit ?? (async () => ({ ok: true, entry: savedQuery({ id: 's1' }) })),
      create: over.create ?? (async () => ({ ok: true, entry: savedQuery({ id: 's1' }) })),
    },
    queryDoc: {
      evaluateSpecDraft: () => ({ parsed: {}, diagnostics: [] }),
      revalidateSpecDrafts: spies.revalidateSpecDrafts,
      revealFirstSpecError: spies.revealFirstSpecError,
    },
    currentWorkspace: () => (over.currentWorkspace === undefined ? null : over.currentWorkspace),
    captureSurfaceGeneration: () => 0,
    refreshCurrentSurfaceAfterStale: over.refreshCurrentSurfaceAfterStale ?? (() => true),
    syncBeforeUnload: spies.syncBeforeUnload,
    refreshWorkspaceFromStore: spies.refreshWorkspaceFromStore,
    commitVariableConfig: over.commitVariableConfig ?? (async () => ({ ok: true, workspace: {} as StoredWorkspaceV5, dashboardRevision: null })),
    saveBtn: () => saveBtn,
    savePopoverOpen: () => !!refs.savePopover,
    anchoredPopover: popovers.open,
    rerenderTabs: spies.rerenderTabs,
    updateEditorModeUi: spies.updateEditorModeUi,
    renderSavedHistory: spies.renderSavedHistory,
    renderResults: spies.renderResults,
    syncSpecEditorFromState: spies.syncSpecEditorFromState,
    specBlocked: over.specBlocked ?? (() => false),
  };
  return { deps, tab, state, saveBtn, refs, spies };
}

describe('createSaveController — updateSaveBtn', () => {
  it('no-ops when there is no save button', () => {
    const { deps, saveBtn } = makeDeps();
    saveBtn.remove();
    const ctl = createSaveController({ ...deps, saveBtn: () => undefined });
    expect(() => ctl.updateSaveBtn()).not.toThrow();
  });

  it('a variable tab reads Saved/Save off dirtySql alone, ignoring specBlocked', () => {
    const tab: QueryTab = { ...newTabObj('v1'), doc: { kind: 'dashboard-variable', dashboardId: 'd', variableName: 'country' } };
    const { deps, saveBtn } = makeDeps({ tab, specBlocked: () => true });
    const ctl = createSaveController(deps);
    tab.dirtySql = false;
    ctl.updateSaveBtn();
    expect(saveBtn.classList.contains('saved')).toBe(true);
    expect(saveBtn.disabled).toBe(false); // never blocked, even though specBlocked() → true
    expect(saveBtn.title).toContain('Saved');
    tab.dirtySql = true;
    ctl.updateSaveBtn();
    expect(saveBtn.classList.contains('saved')).toBe(false);
    expect(saveBtn.textContent).toContain('Save');
  });

  it('a conflicted tab reads "Resolve conflict" regardless of the saved/entry state', () => {
    const { deps, saveBtn, tab } = makeDeps();
    tab.externalState = 'conflict';
    createSaveController(deps).updateSaveBtn();
    expect(saveBtn.textContent).toContain('Resolve conflict');
    expect(saveBtn.classList.contains('conflict')).toBe(true);
  });

  it('an unsaved, unlinked tab is never "blocked" even when specBlocked() would say so', () => {
    const { deps, saveBtn } = makeDeps({ specBlocked: () => true });
    createSaveController(deps).updateSaveBtn();
    expect(saveBtn.classList.contains('saved')).toBe(false);
    expect(saveBtn.disabled).toBe(false); // no linked entry ⇒ `blocked` short-circuits false
    expect(saveBtn.title).toBe('Save query (⌘S)');
  });

  it('a clean linked tab reads "Saved", disabled only when specBlocked() blocks it', () => {
    const entry = savedQuery({ id: 's1' });
    const { deps, saveBtn, tab } = makeDeps({ savedQueries: [entry], specBlocked: () => false });
    tab.savedId = 's1'; tab.dirtySql = false; tab.dirtySpec = false;
    createSaveController(deps).updateSaveBtn();
    expect(saveBtn.classList.contains('saved')).toBe(true);
    expect(saveBtn.disabled).toBe(false);
    expect(saveBtn.title).toBe('Saved — edit to re-save (⌘S)');
  });

  it('a clean linked tab with a blocking Spec is disabled with the blocking title', () => {
    const entry = savedQuery({ id: 's1' });
    const { deps, saveBtn, tab } = makeDeps({ savedQueries: [entry], specBlocked: () => true });
    tab.savedId = 's1'; tab.dirtySql = false; tab.dirtySpec = false;
    createSaveController(deps).updateSaveBtn();
    expect(saveBtn.disabled).toBe(true);
    expect(saveBtn.title).toBe('Fix blocking Spec errors before saving');
  });

  it('a dirty linked tab reads "Save", not "Saved"', () => {
    const entry = savedQuery({ id: 's1' });
    const { deps, saveBtn, tab } = makeDeps({ savedQueries: [entry] });
    tab.savedId = 's1'; tab.dirtySql = true;
    createSaveController(deps).updateSaveBtn();
    expect(saveBtn.classList.contains('saved')).toBe(false);
    expect(saveBtn.title).toBe('Save query (⌘S)');
  });

  // I-15 sabotage: `updateSaveBtn` must check the document KIND (`variableDoc`)
  // BEFORE the conflict/Spec-blocked checks below it — reordering would let a
  // variable tab (which can never be linked/conflicted) fall through into the
  // linked-query branch instead of returning early from the variable branch.
  it('I-15 sabotage: the kind check must run before the conflict/blocked checks (a variable tab never reaches them)', () => {
    const tab: QueryTab = { ...newTabObj('v1'), doc: { kind: 'dashboard-variable', dashboardId: 'd', variableName: 'country' } };
    tab.externalState = 'conflict'; // would read "Resolve conflict" if the kind check were skipped/reordered
    const { deps, saveBtn } = makeDeps({ tab });
    createSaveController(deps).updateSaveBtn();
    expect(saveBtn.classList.contains('conflict')).toBe(false);
    expect(saveBtn.textContent).not.toContain('Resolve conflict');
  });
});

describe('createSaveController — saveActiveQuery dispatch', () => {
  it('a variable tab routes to the variable-config write, never the saved-query paths', async () => {
    const tab: QueryTab = { ...newTabObj('v1'), doc: { kind: 'dashboard-variable', dashboardId: 'd', variableName: 'country' } };
    tab.sqlDraft = 'SELECT 1';
    const commitVariableConfig = vi.fn(async () => ({ ok: true, workspace: {} as StoredWorkspaceV5, dashboardRevision: null }));
    const commit = vi.fn(async () => ({ ok: true, entry: savedQuery({ id: 's1' }) }) as CommitLinkedResult);
    const { deps } = makeDeps({ tab, commitVariableConfig, commit });
    const result = await createSaveController(deps).saveActiveQuery();
    expect(result).toBeNull();
    expect(commitVariableConfig).toHaveBeenCalledWith('d', 'country', { sql: 'SELECT 1' });
    expect(commit).not.toHaveBeenCalled();
  });

  it('a conflicted tab opens the chooser and resolves undefined, without touching commit', async () => {
    const commit = vi.fn(async () => ({ ok: true, entry: savedQuery({ id: 's1' }) }) as CommitLinkedResult);
    const { deps, tab } = makeDeps({ commit });
    tab.externalState = 'conflict';
    const result = await createSaveController(deps).saveActiveQuery();
    expect(result).toBeUndefined();
    expect(qs(document, '.conflict-chooser')).not.toBeNull();
    expect(commit).not.toHaveBeenCalled();
  });

  it('a second call while the chooser is open is a no-op (savePopoverOpen() guard)', async () => {
    const { deps, tab } = makeDeps();
    tab.externalState = 'conflict';
    const ctl = createSaveController(deps);
    await ctl.saveActiveQuery();
    await ctl.saveActiveQuery();
    expect([...document.querySelectorAll('.conflict-chooser')]).toHaveLength(1);
  });

  it('a linked tab commits through the update-in-place path', async () => {
    const entry = savedQuery({ id: 's1' });
    const commit = vi.fn(async () => ({ ok: true, entry }) as CommitLinkedResult);
    const create = vi.fn(async () => ({ ok: true, entry }) as CreateSavedResult);
    const { deps, tab } = makeDeps({ savedQueries: [entry], commit, create });
    tab.savedId = 's1';
    const result = await createSaveController(deps).saveActiveQuery();
    expect(result).toBe(entry);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(create).not.toHaveBeenCalled();
  });

  it('an unlinked tab opens the create popover and resolves undefined', async () => {
    const { deps, tab } = makeDeps();
    tab.sqlDraft = 'SELECT 1';
    const result = await createSaveController(deps).saveActiveQuery();
    expect(result).toBeUndefined();
    expect(qs(document, '.save-popover')).not.toBeNull();
  });

  // I-15 sabotage: `saveActiveQuery` must check the document KIND first too —
  // otherwise a variable tab whose binding happens to look "conflicted" or
  // "linked" (neither of which a variable doc can ever legitimately be) could
  // fall through into the wrong path.
  it('I-15 sabotage: the kind check runs before the conflict/linked dispatch', async () => {
    const tab: QueryTab = {
      ...newTabObj('v1'), doc: { kind: 'dashboard-variable', dashboardId: 'd', variableName: 'country' },
      sqlDraft: 'SELECT 1',
    };
    tab.externalState = 'conflict';
    const commitVariableConfig = vi.fn(async () => ({ ok: true, workspace: {} as StoredWorkspaceV5, dashboardRevision: null }));
    const { deps } = makeDeps({ tab, commitVariableConfig });
    await createSaveController(deps).saveActiveQuery();
    expect(commitVariableConfig).toHaveBeenCalled(); // reached the variable path, not the conflict chooser
    expect(qs(document, '.conflict-chooser')).toBeNull();
  });
});

describe('createSaveController — commitLinkedQuery (via saveActiveQuery on a linked tab)', () => {
  const linked = (over: Parameters<typeof makeDeps>[0] = {}) => {
    const entry = savedQuery({ id: 's1' });
    const m = makeDeps({ savedQueries: [entry], ...over });
    m.tab.savedId = 's1';
    return { ...m, entry };
  };

  it('on success, repaints and returns the entry', async () => {
    const entry = savedQuery({ id: 's1' });
    const commit = vi.fn(async () => ({ ok: true, entry }) as CommitLinkedResult);
    const { deps, spies } = linked({ commit });
    const result = await createSaveController(deps).saveActiveQuery();
    expect(result).toBe(entry);
    expect(spies.rerenderTabs).toHaveBeenCalled();
    expect(spies.renderSavedHistory).toHaveBeenCalled();
    expect(spies.renderResults).toHaveBeenCalled();
    expect(spies.updateEditorModeUi).toHaveBeenCalled();
    expect(spies.syncSpecEditorFromState).toHaveBeenCalled();
    expect(spies.revalidateSpecDrafts).toHaveBeenCalled();
    expect(spies.syncBeforeUnload).toHaveBeenCalled();
    expect(qs(document, '.share-toast').textContent).toBe('Saved');
  });

  it('a warning-bearing success keeps the confirmation and surfaces the warning', async () => {
    const entry = savedQuery({ id: 's1' });
    const commit = vi.fn(async () => ({ ok: true, entry, diagnostics: [{ message: 'heads up' }] }) as CommitLinkedResult);
    const { deps } = linked({ commit });
    await createSaveController(deps).saveActiveQuery();
    expect(qs(document, '.share-toast').textContent).toBe('Saved — heads up');
  });

  it('a stale navigation (refreshCurrentSurfaceAfterStale → false) on a success still returns the entry but skips the repaint', async () => {
    const entry = savedQuery({ id: 's1' });
    const commit = vi.fn(async () => ({ ok: true, entry }) as CommitLinkedResult);
    const { deps, spies } = linked({ commit, refreshCurrentSurfaceAfterStale: () => false });
    const result = await createSaveController(deps).saveActiveQuery();
    expect(result).toBe(entry);
    expect(spies.rerenderTabs).not.toHaveBeenCalled();
  });

  it('a stale navigation on a failure returns null without any toast', async () => {
    const commit = vi.fn(async () => ({ ok: false, reason: 'empty' }) as CommitLinkedResult);
    const { deps } = linked({ commit, refreshCurrentSurfaceAfterStale: () => false });
    const result = await createSaveController(deps).saveActiveQuery();
    expect(result).toBeNull();
    expect(document.querySelector('.share-toast')).toBeNull();
  });

  it("reason 'invalid-spec' reveals the first Spec error and toasts", async () => {
    const commit = vi.fn(async () => ({ ok: false, reason: 'invalid-spec' }) as CommitLinkedResult);
    const { deps, spies } = linked({ commit });
    const result = await createSaveController(deps).saveActiveQuery();
    expect(result).toBeNull();
    expect(spies.revealFirstSpecError).toHaveBeenCalled();
    expect(qs(document, '.share-toast').textContent).toBe('Fix Spec errors before saving');
  });

  it("reason 'empty' toasts Nothing to save", async () => {
    const commit = vi.fn(async () => ({ ok: false, reason: 'empty' }) as CommitLinkedResult);
    const { deps } = linked({ commit });
    await createSaveController(deps).saveActiveQuery();
    expect(qs(document, '.share-toast').textContent).toBe('Nothing to save');
  });

  it("reason 'deleted' toasts and triggers a workspace refresh", async () => {
    const commit = vi.fn(async () => ({ ok: false, reason: 'deleted' }) as CommitLinkedResult);
    const { deps, spies } = linked({ commit });
    await createSaveController(deps).saveActiveQuery();
    expect(qs(document, '.share-toast').textContent).toContain('deleted in another tab');
    expect(spies.refreshWorkspaceFromStore).toHaveBeenCalled();
  });

  it("reason 'rejected' with diagnostics toasts the first message", async () => {
    const commit = vi.fn(async () => ({
      ok: false, reason: 'rejected', diagnostics: [{ path: [], severity: 'error', code: 'x', message: 'nope' }],
    }) as CommitLinkedResult);
    const { deps } = linked({ commit });
    await createSaveController(deps).saveActiveQuery();
    expect(qs(document, '.share-toast').textContent).toBe('Save failed: nope');
  });

  it("reason 'rejected' without diagnostics stays silent", async () => {
    const commit = vi.fn(async () => ({ ok: false, reason: 'rejected' }) as CommitLinkedResult);
    const { deps } = linked({ commit });
    const result = await createSaveController(deps).saveActiveQuery();
    expect(result).toBeNull();
    expect(document.querySelector('.share-toast')).toBeNull();
  });
});

describe('createSaveController — saveVariableTab (via saveActiveQuery on a variable tab)', () => {
  const variableTab = (sqlDraft = 'SELECT 1'): QueryTab => ({
    ...newTabObj('v1'), doc: { kind: 'dashboard-variable', dashboardId: 'd', variableName: 'country' }, sqlDraft,
  });

  it('on success, clears dirty flags, repaints, and toasts "Saved"', async () => {
    const tab = variableTab();
    const commitVariableConfig = vi.fn(async () => ({ ok: true, workspace: {} as StoredWorkspaceV5, dashboardRevision: null }));
    const { deps, spies } = makeDeps({ tab, commitVariableConfig });
    tab.dirtySql = true; tab.dirtySpec = true;
    const result = await createSaveController(deps).saveActiveQuery();
    expect(result).toBeNull();
    expect(tab.dirtySql).toBe(false);
    expect(tab.dirtySpec).toBe(false);
    expect(spies.syncBeforeUnload).toHaveBeenCalled();
    expect(spies.rerenderTabs).toHaveBeenCalled();
    expect(qs(document, '.share-toast').textContent).toBe('Saved');
  });

  it('resolves lastKnownType from the current workspace when the write clears the SQL', async () => {
    const tab = variableTab('   '); // blank ⇒ trim rule removes the config
    const commitVariableConfig = vi.fn(async () => ({ ok: true, workspace: {} as StoredWorkspaceV5, dashboardRevision: null }));
    const { deps } = makeDeps({ tab, commitVariableConfig, currentWorkspace: variableWorkspace });
    await createSaveController(deps).saveActiveQuery();
    expect(commitVariableConfig).toHaveBeenCalledWith('d', 'country', null);
    expect(qs(document, '.share-toast').textContent).toBe('Option SQL removed');
  });

  it('carries lastKnownType through when the current workspace still declares the variable', async () => {
    const tab = variableTab('SELECT {country:String}');
    const commitVariableConfig = vi.fn(async () => ({ ok: true, workspace: {} as StoredWorkspaceV5, dashboardRevision: null }));
    const { deps } = makeDeps({ tab, commitVariableConfig, currentWorkspace: variableWorkspace });
    await createSaveController(deps).saveActiveQuery();
    expect(commitVariableConfig).toHaveBeenCalledWith('d', 'country', expect.objectContaining({ lastKnownType: 'String' }));
  });

  it('a stale navigation on success returns null without repainting', async () => {
    const tab = variableTab();
    const commitVariableConfig = vi.fn(async () => ({ ok: true, workspace: {} as StoredWorkspaceV5, dashboardRevision: null }));
    const { deps, spies } = makeDeps({ tab, commitVariableConfig, refreshCurrentSurfaceAfterStale: () => false });
    const result = await createSaveController(deps).saveActiveQuery();
    expect(result).toBeNull();
    expect(spies.rerenderTabs).not.toHaveBeenCalled();
  });

  it('a declined abort (Dashboard gone) toasts explicitly', async () => {
    const tab = variableTab();
    const commitVariableConfig = vi.fn(async () => ({ ok: false, aborted: true, data: 'declined' }));
    const { deps } = makeDeps({ tab, commitVariableConfig });
    const result = await createSaveController(deps).saveActiveQuery();
    expect(result).toBeNull();
    expect(qs(document, '.share-toast').textContent).toContain('no longer available');
  });

  it('a route-moved-on abort (no data) stays silent', async () => {
    const tab = variableTab();
    const commitVariableConfig = vi.fn(async () => ({ ok: false, aborted: true }));
    const { deps } = makeDeps({ tab, commitVariableConfig });
    const result = await createSaveController(deps).saveActiveQuery();
    expect(result).toBeNull();
    expect(document.querySelector('.share-toast')).toBeNull();
  });

  it('a rejected commit toasts the first diagnostic', async () => {
    const tab = variableTab();
    const commitVariableConfig = vi.fn(async () => ({
      ok: false, diagnostics: [{ path: [], severity: 'error', code: 'x', message: 'busted' }],
    }));
    const { deps } = makeDeps({ tab, commitVariableConfig });
    await createSaveController(deps).saveActiveQuery();
    expect(qs(document, '.share-toast').textContent).toBe('Save failed: busted');
  });
});

describe('createSaveController — reloadSavedVersion (via the conflict chooser)', () => {
  it('"Reload saved version" discards the draft and adopts the committed entry', async () => {
    const entry = savedQuery({ id: 's1', name: 'External name', sql: 'SELECT external' });
    const { deps, tab, spies } = makeDeps({ savedQueries: [entry] });
    tab.savedId = 's1'; tab.externalState = 'conflict'; tab.sqlDraft = 'local draft'; tab.dirtySql = true;
    await createSaveController(deps).saveActiveQuery(); // opens the chooser
    qs(document, '.conflict-chooser .cf-reload').dispatchEvent(new Event('click', { bubbles: true }));
    expect(tab.dirtySql).toBe(false);
    expect(tab.name).toBe('External name');
    expect(tab.externalState ?? null).toBeNull();
    expect(spies.rerenderTabs).toHaveBeenCalled();
    expect(spies.renderSavedHistory).toHaveBeenCalled();
    expect(qs(document, '.share-toast').textContent).toContain('Reloaded the version saved in the other tab');
  });

  it('a vanished linked query (deleted mid-chooser) refreshes instead of reloading', async () => {
    const entry = savedQuery({ id: 's1' });
    const { deps, tab, state, spies } = makeDeps({ savedQueries: [entry] });
    tab.savedId = 's1'; tab.externalState = 'conflict';
    await createSaveController(deps).saveActiveQuery();
    state.savedQueries = []; // vanished between chooser open and resolve
    qs(document, '.conflict-chooser .cf-reload').dispatchEvent(new Event('click', { bubbles: true }));
    expect(spies.refreshWorkspaceFromStore).toHaveBeenCalled();
  });

  it('"Keep my draft" requires the confirm step, then commits over the latest query', async () => {
    const entry = savedQuery({ id: 's1' });
    const commit = vi.fn(async () => ({ ok: true, entry }) as CommitLinkedResult);
    const { deps, tab } = makeDeps({ savedQueries: [entry], commit });
    tab.savedId = 's1'; tab.externalState = 'conflict';
    await createSaveController(deps).saveActiveQuery();
    qs(document, '.conflict-chooser .cf-keep').dispatchEvent(new Event('click', { bubbles: true }));
    expect(qs(document, '.conflict-chooser .cf-overwrite')).not.toBeNull();
    qs(document, '.conflict-chooser .cf-overwrite').dispatchEvent(new Event('click', { bubbles: true }));
    await flush();
    expect(commit).toHaveBeenCalledTimes(1);
  });
});

describe('createSaveController — openSavePopover', () => {
  it('no-ops with a toast on empty SQL for an ordinary (non-queryless) panel', () => {
    const { deps, tab } = makeDeps();
    tab.sqlDraft = '   ';
    createSaveController(deps).openSavePopover();
    expect(document.querySelector('.save-popover')).toBeNull();
    expect(qs(document, '.share-toast').textContent).toBe('Nothing to save');
  });

  it('a second open while already open is a no-op', () => {
    const { deps, tab } = makeDeps();
    tab.sqlDraft = 'SELECT 1';
    const ctl = createSaveController(deps);
    ctl.openSavePopover();
    ctl.openSavePopover();
    expect(document.querySelectorAll('.save-popover')).toHaveLength(1);
  });

  it('prefills the name from the tab, commits on Save, and repaints', async () => {
    const entry = savedQuery({ id: 's1' });
    const create = vi.fn(async () => ({ ok: true, entry }) as CreateSavedResult);
    const { deps, tab, spies } = makeDeps({ create });
    tab.sqlDraft = 'SELECT 42';
    createSaveController(deps).openSavePopover();
    const pop = qs(document, '.save-popover');
    expect(qs<HTMLInputElement>(pop, '.sp-input').value).toBe('SELECT 42'); // inferred name
    qs<HTMLInputElement>(pop, '.sp-input').value = 'My fave';
    qs(pop, '.sp-save').dispatchEvent(new Event('click'));
    await flush();
    expect(create).toHaveBeenCalledWith(tab, 'My fave', '');
    expect(spies.syncBeforeUnload).toHaveBeenCalled();
    expect(spies.rerenderTabs).toHaveBeenCalled();
    expect(spies.renderSavedHistory).toHaveBeenCalled();
    expect(document.querySelector('.save-popover')).toBeNull(); // closed
    expect(qs(document, '.share-toast').textContent).toBe('Saved');
  });

  it('Cancel closes without committing', () => {
    const create = vi.fn(async () => ({ ok: true, entry: savedQuery({ id: 's1' }) }) as CreateSavedResult);
    const { deps, tab } = makeDeps({ create });
    tab.sqlDraft = 'SELECT 1';
    createSaveController(deps).openSavePopover();
    qs(document, '.save-popover .sp-cancel').dispatchEvent(new Event('click'));
    expect(document.querySelector('.save-popover')).toBeNull();
    expect(create).not.toHaveBeenCalled();
  });

  it('Enter in the name field commits; a blank name is a no-op', async () => {
    const create = vi.fn(async () => ({ ok: true, entry: savedQuery({ id: 's1' }) }) as CreateSavedResult);
    const { deps, tab } = makeDeps({ create });
    tab.sqlDraft = 'SELECT 1';
    createSaveController(deps).openSavePopover();
    const input = qs<HTMLInputElement>(document, '.save-popover .sp-input');
    input.value = '   ';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await flush();
    expect(create).not.toHaveBeenCalled();
    input.value = 'Real name';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await flush();
    expect(create).toHaveBeenCalledWith(tab, 'Real name', '');
  });

  it('plain Enter in the description is a newline (no commit); ⌘/Ctrl+Enter commits', async () => {
    const create = vi.fn(async () => ({ ok: true, entry: savedQuery({ id: 's1' }) }) as CreateSavedResult);
    const { deps, tab } = makeDeps({ create });
    tab.sqlDraft = 'SELECT 1';
    createSaveController(deps).openSavePopover();
    const description = qs<HTMLTextAreaElement>(document, '.save-popover .sp-desc');
    description.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await flush();
    expect(create).not.toHaveBeenCalled();
    description.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }));
    await flush();
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('a failed create with diagnostics toasts and leaves the popover open', async () => {
    const create = vi.fn(async () => ({ ok: false, diagnostics: [{ path: [], severity: 'error', code: 'x', message: 'bad name' }] }) as CreateSavedResult);
    const { deps, tab } = makeDeps({ create });
    tab.sqlDraft = 'SELECT 1';
    createSaveController(deps).openSavePopover();
    qs<HTMLInputElement>(document, '.save-popover .sp-input').value = 'x';
    qs(document, '.save-popover .sp-save').dispatchEvent(new Event('click'));
    await flush();
    expect(qs(document, '.share-toast').textContent).toBe('Save failed: bad name');
    expect(document.querySelector('.save-popover')).not.toBeNull(); // stays open
  });

  it('a failed create without diagnostics stays silent', async () => {
    const create = vi.fn(async () => ({ ok: false }) as CreateSavedResult);
    const { deps, tab } = makeDeps({ create });
    tab.sqlDraft = 'SELECT 1';
    createSaveController(deps).openSavePopover();
    qs<HTMLInputElement>(document, '.save-popover .sp-input').value = 'x';
    qs(document, '.save-popover .sp-save').dispatchEvent(new Event('click'));
    await flush();
    expect(document.querySelector('.share-toast')).toBeNull();
  });

  it('a stale navigation during create returns without repainting or closing', async () => {
    const create = vi.fn(async () => ({ ok: true, entry: savedQuery({ id: 's1' }) }) as CreateSavedResult);
    const { deps, tab, spies } = makeDeps({ create, refreshCurrentSurfaceAfterStale: () => false });
    tab.sqlDraft = 'SELECT 1';
    createSaveController(deps).openSavePopover();
    qs<HTMLInputElement>(document, '.save-popover .sp-input').value = 'x';
    qs(document, '.save-popover .sp-save').dispatchEvent(new Event('click'));
    await flush();
    expect(spies.rerenderTabs).not.toHaveBeenCalled();
    expect(document.querySelector('.save-popover')).not.toBeNull(); // never closed — the bracket returned first
  });

  it('a queryless panel with blank SQL still opens (the per-type relaxation)', () => {
    const tab = { ...newTabObj('p1'), specParsed: { name: 'Untitled', favorite: false, panel: { cfg: { type: 'text' } } } } as QueryTab;
    tab.sqlDraft = '';
    const { deps } = makeDeps({ tab });
    createSaveController(deps).openSavePopover();
    expect(document.querySelector('.save-popover')).not.toBeNull();
  });
});
