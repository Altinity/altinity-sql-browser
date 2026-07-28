import { describe, expect, it, vi } from 'vitest';
import { signal } from '@preact/signals-core';
import {
  OAUTH_DOCUMENT_RECOVERY_KEY,
  OAUTH_DOCUMENT_RECOVERY_TTL_MS,
  OAUTH_DOCUMENT_RECOVERY_VALIDATED_CALLBACK_KEY,
  OAUTH_DOCUMENT_RECOVERY_VALIDATED_CALLBACK_VERSION,
  OAUTH_DOCUMENT_RECOVERY_VERSION,
  encodeOAuthDocumentRecovery,
  encodeOAuthDocumentRecoveryValidatedCallback,
  type OAuthDocumentRecoverySnapshot,
} from '../../src/core/oauth-document-recovery.js';
import {
  createOAuthDocumentRecoverySession,
  type OAuthDocumentRecoverySessionDeps,
  type OAuthDocumentRecoveryState,
  type OAuthDocumentRecoveryStorage,
} from '../../src/application/oauth-document-recovery-session.js';
import { newTabObj, type QueryTab, type SpecValidationService } from '../../src/state.js';
import type { SavedQueryV2, StoredWorkspaceV5 } from '../../src/generated/json-schema.types.js';

const NOW = 1_700_000_000_000;
const validators: SpecValidationService = { validate: () => [] };

function storage(initial: Record<string, string> = {}): OAuthDocumentRecoveryStorage & { values: Map<string, string> } {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
  };
}

function state(tabs: QueryTab[] = [newTabObj('t1')]): OAuthDocumentRecoveryState {
  return {
    tabs: signal(tabs), activeTabId: signal(tabs[0]?.id ?? 't1'), nextTabId: 2,
    workspaceId: 'w1', workspaceKey: 'team',
  };
}

function workspace(queries: SavedQueryV2[] = []): StoredWorkspaceV5 {
  return { storageVersion: 5, id: 'w1', key: 'team', name: 'Team', queries, dashboards: [] } as StoredWorkspaceV5;
}

function deps(over: Partial<OAuthDocumentRecoverySessionDeps> = {}): OAuthDocumentRecoverySessionDeps {
  return {
    storage: storage(), now: () => NOW, state: state(), specValidators: validators, ...over,
  };
}

function snapshot(over: Partial<OAuthDocumentRecoverySnapshot> = {}): OAuthDocumentRecoverySnapshot {
  return {
    version: OAUTH_DOCUMENT_RECOVERY_VERSION,
    createdAt: NOW,
    workspaceId: 'w1', workspaceKey: 'team', oauthState: 'state-1',
    tabs: [{
      id: 't1', doc: { kind: 'query' }, name: 'Recovered', sqlDraft: 'SELECT 1',
      specText: '{"name": ', specVersion: 1, editorMode: 'sql', dirtySql: true,
      dirtySpec: true, savedId: 'q1', lastCommittedQueryToken: 'old', externalState: 'conflict',
    }],
    activeTabId: 't1', nextTabId: 2,
    ...over,
  };
}

function saveSnapshot(store: OAuthDocumentRecoveryStorage, value = snapshot()): void {
  store.setItem(OAUTH_DOCUMENT_RECOVERY_KEY, encodeOAuthDocumentRecovery(value));
}

function saveMarker(
  store: OAuthDocumentRecoveryStorage,
  oauthState = 'state-1',
  validatedAt = NOW,
): void {
  store.setItem(
    OAUTH_DOCUMENT_RECOVERY_VALIDATED_CALLBACK_KEY,
    encodeOAuthDocumentRecoveryValidatedCallback({
      version: OAUTH_DOCUMENT_RECOVERY_VALIDATED_CALLBACK_VERSION,
      oauthState,
      validatedAt,
    }),
  );
}

const saved = (id: string, sql: string, name = id): SavedQueryV2 => (
  { id, sql, specVersion: 1, spec: { name, favorite: false } } as SavedQueryV2
);

describe('OAuthDocumentRecoverySession.prepare', () => {
  it('captures every authored tab in order when a query tab is save-dirty', () => {
    const query = newTabObj('t1');
    query.name = 'Draft'; query.sqlDraft = 'SELECT draft'; query.specText = '{bad json';
    query.dirtySql = true; query.savedId = 'q1'; query.lastCommittedQueryToken = 'token';
    query.externalState = 'deleted';
    query.result = { rows: ['not recoverable'] }; query.chSession = 'ch-session';
    query.lastSuccessfulResultColumns = [{ name: 'x', type: 'UInt8' }];
    const variable = newTabObj('t2');
    variable.doc = { kind: 'dashboard-variable', dashboardId: 'dash', variableName: 'region' };
    variable.name = 'Region'; variable.sqlDraft = 'SELECT region'; variable.specText = 'verbatim';
    variable.dirtySpec = true; variable.editorMode = 'sql';
    const s = state([query, variable]); s.activeTabId.value = 't2'; s.nextTabId = 3;
    const store = storage();

    expect(createOAuthDocumentRecoverySession(deps({ state: s, storage: store })).prepare('attempt')).toBe(true);
    const recovered = JSON.parse(store.getItem(OAUTH_DOCUMENT_RECOVERY_KEY) ?? '') as OAuthDocumentRecoverySnapshot;
    expect(recovered).toMatchObject({ oauthState: 'attempt', createdAt: NOW, activeTabId: 't2', nextTabId: 3 });
    expect(recovered.tabs).toEqual([
      expect.objectContaining({ id: 't1', sqlDraft: 'SELECT draft', specText: '{bad json', savedId: 'q1', lastCommittedQueryToken: 'token' }),
      expect.objectContaining({ id: 't2', doc: { kind: 'dashboard-variable', dashboardId: 'dash', variableName: 'region' }, dirtySpec: true }),
    ]);
    expect(recovered.tabs[0]).not.toHaveProperty('result');
    expect(recovered.tabs[0]).not.toHaveProperty('chSession');
  });

  it('does not checkpoint a variable dirty only in Spec, but retains it when another tab needs saving', () => {
    const variable = newTabObj('t2');
    variable.doc = { kind: 'dashboard-variable', dashboardId: 'dash', variableName: 'region' };
    variable.specText = 'must survive'; variable.dirtySpec = true;
    const cleanStore = storage();
    expect(createOAuthDocumentRecoverySession(deps({ state: state([variable]), storage: cleanStore })).prepare('s')).toBe(false);
    expect(cleanStore.getItem(OAUTH_DOCUMENT_RECOVERY_KEY)).toBeNull();

    const query = newTabObj('t1'); query.dirtySql = true;
    const fullStore = storage();
    const fullState = state([query, variable]); fullState.nextTabId = 3;
    expect(createOAuthDocumentRecoverySession(deps({ state: fullState, storage: fullStore })).prepare('s')).toBe(true);
    const recovered = JSON.parse(fullStore.getItem(OAUTH_DOCUMENT_RECOVERY_KEY) ?? '') as OAuthDocumentRecoverySnapshot;
    expect(recovered.tabs[1]).toMatchObject({ specText: 'must survive', dirtySpec: true });
  });

  it('does not write when the session is clean and no retained payload exists', () => {
    const store = storage();
    const setItem = vi.spyOn(store, 'setItem');
    expect(createOAuthDocumentRecoverySession(deps({ storage: store })).prepare('attempt')).toBe(false);
    expect(setItem).not.toHaveBeenCalled();
  });

  it('rebinds a valid retained payload only to the retry state and time', () => {
    const original = snapshot({ createdAt: NOW - 10, tabs: [
      { ...snapshot().tabs[0], id: 't1' },
    ] });
    const store = storage(); saveSnapshot(store, original);
    const session = createOAuthDocumentRecoverySession(deps({ storage: store, now: () => NOW + 100 }));

    expect(session.prepare('retry')).toBe(true);
    expect(JSON.parse(store.getItem(OAUTH_DOCUMENT_RECOVERY_KEY) ?? '')).toEqual({
      ...original, oauthState: 'retry', createdAt: NOW + 100,
    });
  });

  it('invalidates prior callback authority only after a fresh or rebound checkpoint write succeeds', () => {
    const dirty = newTabObj('t1'); dirty.dirtySql = true;
    const freshStore = storage(); saveMarker(freshStore, 'old');
    const fresh = createOAuthDocumentRecoverySession(deps({
      storage: freshStore,
      state: state([dirty]),
    }));
    expect(fresh.prepare('fresh')).toBe(true);
    expect(freshStore.getItem(OAUTH_DOCUMENT_RECOVERY_VALIDATED_CALLBACK_KEY)).toBeNull();

    const reboundStore = storage(); saveSnapshot(reboundStore); saveMarker(reboundStore);
    const rebound = createOAuthDocumentRecoverySession(deps({ storage: reboundStore }));
    expect(rebound.prepare('retry')).toBe(true);
    expect(reboundStore.getItem(OAUTH_DOCUMENT_RECOVERY_VALIDATED_CALLBACK_KEY)).toBeNull();

    const failedStore = storage(); saveSnapshot(failedStore); saveMarker(failedStore);
    const priorCheckpoint = failedStore.getItem(OAUTH_DOCUMENT_RECOVERY_KEY);
    failedStore.setItem = vi.fn(() => { throw new Error('storage full'); });
    const failed = createOAuthDocumentRecoverySession(deps({ storage: failedStore }));
    expect(() => failed.prepare('never-authorized')).toThrow('storage full');
    expect(failedStore.getItem(OAUTH_DOCUMENT_RECOVERY_KEY)).toBe(priorCheckpoint);
    expect(failedStore.getItem(OAUTH_DOCUMENT_RECOVERY_VALIDATED_CALLBACK_KEY)).not.toBeNull();
  });

  it('surfaces marker invalidation failure only after the rebound checkpoint is durable', () => {
    const store = storage(); saveSnapshot(store); saveMarker(store);
    const removeItem = store.removeItem;
    store.removeItem = vi.fn((key) => {
      if (key === OAUTH_DOCUMENT_RECOVERY_VALIDATED_CALLBACK_KEY) {
        throw new Error('marker cleanup failed');
      }
      removeItem(key);
    });
    const session = createOAuthDocumentRecoverySession(deps({ storage: store }));

    expect(() => session.prepare('new-state')).toThrow('marker cleanup failed');
    expect(JSON.parse(store.getItem(OAUTH_DOCUMENT_RECOVERY_KEY) ?? '')).toMatchObject({
      oauthState: 'new-state',
    });
    expect(store.getItem(OAUTH_DOCUMENT_RECOVERY_VALIDATED_CALLBACK_KEY)).not.toBeNull();
  });

  it('clears an invalid retained payload rather than rebinding it', () => {
    const store = storage({ [OAUTH_DOCUMENT_RECOVERY_KEY]: '{bad' });
    expect(createOAuthDocumentRecoverySession(deps({ storage: store })).prepare('retry')).toBe(false);
    expect(store.getItem(OAUTH_DOCUMENT_RECOVERY_KEY)).toBeNull();
  });

  it('lets a failed write throw and leaves a prior payload untouched', () => {
    const old = encodeOAuthDocumentRecovery(snapshot({ oauthState: 'old' }));
    const store = storage({ [OAUTH_DOCUMENT_RECOVERY_KEY]: old });
    store.setItem = vi.fn(() => { throw new Error('storage full'); });
    const tab = newTabObj('t1'); tab.dirtySql = true;
    const session = createOAuthDocumentRecoverySession(deps({ storage: store, state: state([tab]) }));

    expect(() => session.prepare('new')).toThrow('storage full');
    expect(store.getItem(OAUTH_DOCUMENT_RECOVERY_KEY)).toBe(old);
  });
});

describe('OAuthDocumentRecoverySession.restore', () => {
  it('keeps an absent session untouched and preserves a state-mismatched retry payload', () => {
    const s = state(); const store = storage(); const session = createOAuthDocumentRecoverySession(deps({ state: s, storage: store }));
    expect(session.restore('state-1', workspace())).toEqual({ kind: 'absent' });
    const before = s.tabs.value;
    saveSnapshot(store);
    expect(session.restore('old-state', workspace())).toEqual({ kind: 'callback-mismatch' });
    expect(store.getItem(OAUTH_DOCUMENT_RECOVERY_KEY)).not.toBeNull();
    expect(s.tabs.value).toBe(before);
  });

  it('clears invalid or workspace-mismatched payloads without publishing any state', () => {
    const s = state(); const initialTabs = s.tabs.value; const store = storage({ [OAUTH_DOCUMENT_RECOVERY_KEY]: '{bad' });
    const session = createOAuthDocumentRecoverySession(deps({ state: s, storage: store }));
    expect(session.restore('state-1', null)).toEqual({ kind: 'invalid-cleared', reason: 'malformed' });
    expect(s.tabs.value).toBe(initialTabs);
    saveSnapshot(store);
    expect(session.restore('state-1', { ...workspace(), id: 'other' })).toEqual({ kind: 'workspace-mismatch-cleared' });
    expect(store.getItem(OAUTH_DOCUMENT_RECOVERY_KEY)).toBeNull();
    expect(s.tabs.value).toBe(initialTabs);
    saveSnapshot(store);
    expect(session.restore('state-1', { ...workspace(), key: 'other' })).toEqual({ kind: 'workspace-mismatch-cleared' });
    expect(store.getItem(OAUTH_DOCUMENT_RECOVERY_KEY)).toBeNull();
  });

  it('retains a valid checkpoint and callback authority while unavailable, then retries in-session', () => {
    const checkpoint = encodeOAuthDocumentRecovery(snapshot());
    const store = storage({ [OAUTH_DOCUMENT_RECOVERY_KEY]: checkpoint });
    const s = state();
    const before = s.tabs.value;
    const session = createOAuthDocumentRecoverySession(deps({ state: s, storage: store }));

    expect(session.restore('state-1', null)).toEqual({ kind: 'workspace-unavailable-retained' });
    expect(store.getItem(OAUTH_DOCUMENT_RECOVERY_KEY)).toBe(checkpoint);
    expect(JSON.parse(
      store.getItem(OAUTH_DOCUMENT_RECOVERY_VALIDATED_CALLBACK_KEY) ?? '',
    )).toEqual({
      version: OAUTH_DOCUMENT_RECOVERY_VALIDATED_CALLBACK_VERSION,
      oauthState: 'state-1',
      validatedAt: NOW,
    });
    expect(s.tabs.value).toBe(before);

    expect(session.retryPending(workspace())).toEqual({ kind: 'restored' });
    expect(s.tabs.value).not.toBe(before);
    expect(s.tabs.value[0]).toMatchObject({ name: 'Recovered', sqlDraft: 'SELECT 1' });
    expect(store.getItem(OAUTH_DOCUMENT_RECOVERY_KEY)).toBe(checkpoint);
    expect(store.getItem(OAUTH_DOCUMENT_RECOVERY_VALIDATED_CALLBACK_KEY)).toBeNull();
  });

  it('persists unavailable callback authority best-effort while retaining same-session retry', () => {
    const checkpoint = encodeOAuthDocumentRecovery(snapshot());
    const store = storage({ [OAUTH_DOCUMENT_RECOVERY_KEY]: checkpoint });
    const setItem = store.setItem;
    store.setItem = vi.fn((key, value) => {
      if (key === OAUTH_DOCUMENT_RECOVERY_VALIDATED_CALLBACK_KEY) {
        throw new Error('marker storage unavailable');
      }
      setItem(key, value);
    });
    const s = state();
    const session = createOAuthDocumentRecoverySession(deps({ state: s, storage: store }));

    expect(session.restore('state-1', null)).toEqual({ kind: 'workspace-unavailable-retained' });
    expect(store.getItem(OAUTH_DOCUMENT_RECOVERY_VALIDATED_CALLBACK_KEY)).toBeNull();
    expect(session.retryPending(workspace())).toEqual({ kind: 'restored' });
    expect(s.tabs.value[0].sqlDraft).toBe('SELECT 1');
  });

  it('reloads pending callback authority from its marker, never from a checkpoint alone', () => {
    const checkpoint = encodeOAuthDocumentRecovery(snapshot());
    const store = storage({ [OAUTH_DOCUMENT_RECOVERY_KEY]: checkpoint });
    const first = createOAuthDocumentRecoverySession(deps({ storage: store }));
    expect(first.restore('state-1', null)).toEqual({ kind: 'workspace-unavailable-retained' });

    const reloadedState = state();
    const reloaded = createOAuthDocumentRecoverySession(deps({
      storage: store,
      state: reloadedState,
    }));
    expect(reloaded.retryPending(null)).toEqual({ kind: 'workspace-unavailable-retained' });
    expect(store.getItem(OAUTH_DOCUMENT_RECOVERY_VALIDATED_CALLBACK_KEY)).not.toBeNull();
    expect(reloaded.retryPending(workspace())).toEqual({ kind: 'restored' });
    expect(reloadedState.tabs.value[0].sqlDraft).toBe('SELECT 1');

    saveSnapshot(store);
    const noMarkerState = state();
    const noMarker = createOAuthDocumentRecoverySession(deps({
      storage: store,
      state: noMarkerState,
    }));
    const before = noMarkerState.tabs.value;
    expect(noMarker.retryPending(workspace())).toEqual({ kind: 'absent' });
    expect(noMarkerState.tabs.value).toBe(before);
    expect(store.getItem(OAUTH_DOCUMENT_RECOVERY_KEY)).not.toBeNull();
  });

  it('retires persisted authority before publication and defers safely when removal fails', () => {
    const checkpoint = encodeOAuthDocumentRecovery(snapshot());
    const store = storage({ [OAUTH_DOCUMENT_RECOVERY_KEY]: checkpoint });
    const s = state();
    const before = s.tabs.value;
    const session = createOAuthDocumentRecoverySession(deps({ storage: store, state: s }));
    expect(session.restore('state-1', null)).toEqual({ kind: 'workspace-unavailable-retained' });
    const removeItem = store.removeItem;
    store.removeItem = vi.fn((key) => {
      if (key === OAUTH_DOCUMENT_RECOVERY_VALIDATED_CALLBACK_KEY) {
        throw new Error('marker removal unavailable');
      }
      removeItem(key);
    });

    expect(session.retryPending(workspace())).toEqual({ kind: 'retry-deferred-retained' });
    expect(s.tabs.value).toBe(before);
    expect(store.getItem(OAUTH_DOCUMENT_RECOVERY_KEY)).toBe(checkpoint);
    expect(store.getItem(OAUTH_DOCUMENT_RECOVERY_VALIDATED_CALLBACK_KEY)).not.toBeNull();

    store.removeItem = removeItem;
    expect(session.retryPending(workspace())).toEqual({ kind: 'restored' });
    expect(s.tabs.value).not.toBe(before);
    expect(store.getItem(OAUTH_DOCUMENT_RECOVERY_VALIDATED_CALLBACK_KEY)).toBeNull();
  });

  it('verifies marker absence and defers when a removal reports success without retiring it', () => {
    const store = storage(); saveSnapshot(store); saveMarker(store);
    const s = state();
    const before = s.tabs.value;
    store.removeItem = vi.fn();
    const session = createOAuthDocumentRecoverySession(deps({ storage: store, state: s }));

    expect(session.retryPending(workspace())).toEqual({ kind: 'retry-deferred-retained' });
    expect(s.tabs.value).toBe(before);
    expect(store.getItem(OAUTH_DOCUMENT_RECOVERY_KEY)).not.toBeNull();
    expect(store.getItem(OAUTH_DOCUMENT_RECOVERY_VALIDATED_CALLBACK_KEY)).not.toBeNull();
  });

  it('cannot resurrect a published retry in this document or a reloaded session', () => {
    const store = storage(); saveSnapshot(store); saveMarker(store);
    const publishedState = state();
    const published = createOAuthDocumentRecoverySession(deps({
      storage: store,
      state: publishedState,
    }));

    expect(published.retryPending(workspace())).toEqual({ kind: 'restored' });
    expect(publishedState.tabs.value[0].sqlDraft).toBe('SELECT 1');
    expect(store.getItem(OAUTH_DOCUMENT_RECOVERY_VALIDATED_CALLBACK_KEY)).toBeNull();
    // Simulate shell finalization retaining the checkpoint: no consume().
    const publishedTabs = publishedState.tabs.value;
    expect(published.retryPending(workspace())).toEqual({ kind: 'absent' });
    expect(publishedState.tabs.value).toBe(publishedTabs);

    const reloadedState = state();
    const reloadedTabs = reloadedState.tabs.value;
    const reloaded = createOAuthDocumentRecoverySession(deps({
      storage: store,
      state: reloadedState,
    }));
    expect(reloaded.retryPending(workspace())).toEqual({ kind: 'absent' });
    expect(reloadedState.tabs.value).toBe(reloadedTabs);
    expect(store.getItem(OAUTH_DOCUMENT_RECOVERY_KEY)).not.toBeNull();
  });

  it('fails closed on pending-marker reads and remains retryable after storage recovers', () => {
    const store = storage(); saveSnapshot(store); saveMarker(store);
    const s = state();
    const before = s.tabs.value;
    const getItem = store.getItem;
    store.getItem = vi.fn((key) => {
      if (key === OAUTH_DOCUMENT_RECOVERY_VALIDATED_CALLBACK_KEY) {
        throw new Error('marker read unavailable');
      }
      return getItem(key);
    });
    const session = createOAuthDocumentRecoverySession(deps({ storage: store, state: s }));

    expect(session.retryPending(workspace())).toEqual({ kind: 'retry-deferred-retained' });
    expect(s.tabs.value).toBe(before);
    expect(store.values.get(OAUTH_DOCUMENT_RECOVERY_KEY)).toBeDefined();
    expect(store.values.get(OAUTH_DOCUMENT_RECOVERY_VALIDATED_CALLBACK_KEY)).toBeDefined();

    store.getItem = getItem;
    expect(session.retryPending(workspace())).toEqual({ kind: 'restored' });
    expect(s.tabs.value).not.toBe(before);
  });

  it('restores in-memory authority when its pre-publication marker read fails', () => {
    const store = storage(); saveSnapshot(store);
    const s = state();
    const before = s.tabs.value;
    const session = createOAuthDocumentRecoverySession(deps({ storage: store, state: s }));
    expect(session.restore('state-1', null)).toEqual({ kind: 'workspace-unavailable-retained' });
    const getItem = store.getItem;
    store.getItem = vi.fn((key) => {
      if (key === OAUTH_DOCUMENT_RECOVERY_VALIDATED_CALLBACK_KEY) {
        throw new Error('verification unavailable');
      }
      return getItem(key);
    });

    expect(session.retryPending(workspace())).toEqual({ kind: 'retry-deferred-retained' });
    expect(s.tabs.value).toBe(before);
    store.getItem = getItem;
    expect(session.retryPending(workspace())).toEqual({ kind: 'restored' });
  });

  it('prunes malformed or expired markers without consuming their checkpoint', () => {
    for (const marker of [
      '{bad',
      encodeOAuthDocumentRecoveryValidatedCallback({
        version: OAUTH_DOCUMENT_RECOVERY_VALIDATED_CALLBACK_VERSION,
        oauthState: 'state-1',
        validatedAt: NOW - OAUTH_DOCUMENT_RECOVERY_TTL_MS - 1,
      }),
    ]) {
      const store = storage({
        [OAUTH_DOCUMENT_RECOVERY_KEY]: encodeOAuthDocumentRecovery(snapshot()),
        [OAUTH_DOCUMENT_RECOVERY_VALIDATED_CALLBACK_KEY]: marker,
      });
      const session = createOAuthDocumentRecoverySession(deps({ storage: store }));
      expect(session.retryPending(workspace())).toEqual({ kind: 'absent' });
      expect(store.getItem(OAUTH_DOCUMENT_RECOVERY_VALIDATED_CALLBACK_KEY)).toBeNull();
      expect(store.getItem(OAUTH_DOCUMENT_RECOVERY_KEY)).not.toBeNull();
    }
  });

  it('expires same-session in-memory authority and prunes its persisted marker', () => {
    let current = NOW;
    const store = storage(); saveSnapshot(store);
    const session = createOAuthDocumentRecoverySession(deps({
      storage: store,
      now: () => current,
    }));
    expect(session.restore('state-1', null)).toEqual({ kind: 'workspace-unavailable-retained' });

    current += OAUTH_DOCUMENT_RECOVERY_TTL_MS + 1;
    expect(session.retryPending(workspace())).toEqual({ kind: 'absent' });
    expect(store.getItem(OAUTH_DOCUMENT_RECOVERY_VALIDATED_CALLBACK_KEY)).toBeNull();
    expect(store.getItem(OAUTH_DOCUMENT_RECOVERY_KEY)).not.toBeNull();
  });

  it('clears a state-mismatched marker only, and clears both records on proven workspace mismatch', () => {
    const stateMismatch = storage(); saveSnapshot(stateMismatch); saveMarker(stateMismatch, 'other');
    const staleMarker = createOAuthDocumentRecoverySession(deps({ storage: stateMismatch }));
    expect(staleMarker.retryPending(workspace())).toEqual({ kind: 'callback-mismatch' });
    expect(stateMismatch.getItem(OAUTH_DOCUMENT_RECOVERY_VALIDATED_CALLBACK_KEY)).toBeNull();
    expect(stateMismatch.getItem(OAUTH_DOCUMENT_RECOVERY_KEY)).not.toBeNull();

    const workspaceMismatch = storage(); saveSnapshot(workspaceMismatch); saveMarker(workspaceMismatch);
    const wrongWorkspace = createOAuthDocumentRecoverySession(deps({ storage: workspaceMismatch }));
    expect(wrongWorkspace.retryPending({ ...workspace(), id: 'other' }))
      .toEqual({ kind: 'workspace-mismatch-cleared' });
    expect(workspaceMismatch.getItem(OAUTH_DOCUMENT_RECOVERY_KEY)).toBeNull();
    expect(workspaceMismatch.getItem(OAUTH_DOCUMENT_RECOVERY_VALIDATED_CALLBACK_KEY)).toBeNull();
  });

  it('clears unsupported and expired payloads before any state publication', () => {
    const s = state(); const before = s.tabs.value; const store = storage();
    const session = createOAuthDocumentRecoverySession(deps({ state: s, storage: store }));
    store.setItem(OAUTH_DOCUMENT_RECOVERY_KEY, JSON.stringify({ ...snapshot(), version: 99 }));
    expect(session.restore('state-1', workspace())).toEqual({ kind: 'invalid-cleared', reason: 'unsupported' });
    expect(s.tabs.value).toBe(before);
    saveSnapshot(store, snapshot({ createdAt: NOW - (15 * 60 * 1000) - 1 }));
    expect(session.restore('state-1', workspace())).toEqual({ kind: 'invalid-cleared', reason: 'expired' });
    expect(s.tabs.value).toBe(before);
  });

  it('retains fresh validated authority when reconciliation persistently fails, then retries', () => {
    const store = storage();
    saveSnapshot(store, snapshot({ tabs: [{
      ...snapshot().tabs[0], dirtySql: false, dirtySpec: false, savedId: 'q1', lastCommittedQueryToken: 'old',
    }] }));
    const s = state(); const beforeTabs = s.tabs.value; const beforeActive = s.activeTabId.value; const beforeNext = s.nextTabId;
    let validatorAvailable = false;
    const throwingValidators: SpecValidationService = {
      validate: () => {
        if (!validatorAvailable) throw new Error('validator failed');
        return [];
      },
    };
    const session = createOAuthDocumentRecoverySession(deps({ state: s, storage: store, specValidators: throwingValidators }));
    const latest = workspace([saved('q1', 'SELECT latest')]);

    expect(session.restore('state-1', latest)).toEqual({ kind: 'retry-deferred-retained' });
    expect(s.tabs.value).toBe(beforeTabs);
    expect(s.activeTabId.value).toBe(beforeActive);
    expect(s.nextTabId).toBe(beforeNext);
    expect(store.getItem(OAUTH_DOCUMENT_RECOVERY_KEY)).not.toBeNull();
    expect(store.getItem(OAUTH_DOCUMENT_RECOVERY_VALIDATED_CALLBACK_KEY)).not.toBeNull();
    expect(session.retryPending(latest)).toEqual({ kind: 'retry-deferred-retained' });
    expect(s.tabs.value).toBe(beforeTabs);

    validatorAvailable = true;
    expect(session.retryPending(latest)).toEqual({ kind: 'restored' });
    expect(s.tabs.value).not.toBe(beforeTabs);
    expect(s.tabs.value[0].sqlDraft).toBe('SELECT latest');
    expect(store.getItem(OAUTH_DOCUMENT_RECOVERY_VALIDATED_CALLBACK_KEY)).toBeNull();
  });

  it('keeps persisted pending authority byte-for-byte when reconciliation fails before publication', () => {
    const store = storage();
    saveSnapshot(store, snapshot({ tabs: [{
      ...snapshot().tabs[0], dirtySql: false, dirtySpec: false,
      savedId: 'q1', lastCommittedQueryToken: 'old',
    }] }));
    saveMarker(store);
    const marker = store.getItem(OAUTH_DOCUMENT_RECOVERY_VALIDATED_CALLBACK_KEY);
    const s = state();
    const beforeTabs = s.tabs.value;
    let validatorAvailable = false;
    const throwingValidators: SpecValidationService = {
      validate: () => {
        if (!validatorAvailable) throw new Error('persistent validator failure');
        return [];
      },
    };
    const session = createOAuthDocumentRecoverySession(deps({
      state: s,
      storage: store,
      specValidators: throwingValidators,
    }));
    const latest = workspace([saved('q1', 'SELECT latest')]);

    expect(session.retryPending(latest)).toEqual({ kind: 'retry-deferred-retained' });
    expect(s.tabs.value).toBe(beforeTabs);
    expect(store.getItem(OAUTH_DOCUMENT_RECOVERY_KEY)).not.toBeNull();
    expect(store.getItem(OAUTH_DOCUMENT_RECOVERY_VALIDATED_CALLBACK_KEY)).toBe(marker);

    validatorAvailable = true;
    expect(session.retryPending(latest)).toEqual({ kind: 'restored' });
    expect(s.tabs.value).not.toBe(beforeTabs);
    expect(store.getItem(OAUTH_DOCUMENT_RECOVERY_VALIDATED_CALLBACK_KEY)).toBeNull();
  });

  it.each([
    ['query SQL', (tab: QueryTab) => { tab.dirtySql = true; }],
    ['query Spec', (tab: QueryTab) => { tab.dirtySpec = true; }],
    ['dashboard-variable SQL', (tab: QueryTab) => {
      tab.doc = { kind: 'dashboard-variable', dashboardId: 'd1', variableName: 'region' };
      tab.dirtySql = true;
    }],
  ])('defers a pending retry while live %s work is save-dirty', (_label, makeDirty) => {
    const store = storage(); saveSnapshot(store); saveMarker(store);
    const checkpoint = store.getItem(OAUTH_DOCUMENT_RECOVERY_KEY);
    const marker = store.getItem(OAUTH_DOCUMENT_RECOVERY_VALIDATED_CALLBACK_KEY);
    const live = newTabObj('t1');
    live.sqlDraft = 'SELECT live';
    makeDirty(live);
    const s = state([live]);
    const beforeTabs = s.tabs.value;
    const validate = vi.fn(() => []);
    const session = createOAuthDocumentRecoverySession(deps({
      storage: store,
      state: s,
      specValidators: { validate },
    }));

    expect(session.retryPending(workspace([saved('q1', 'SELECT latest')]))).toEqual({
      kind: 'retry-deferred-retained',
    });
    expect(validate).not.toHaveBeenCalled();
    expect(s.tabs.value).toBe(beforeTabs);
    expect(s.tabs.value[0].sqlDraft).toBe('SELECT live');
    expect(store.getItem(OAUTH_DOCUMENT_RECOVERY_KEY)).toBe(checkpoint);
    expect(store.getItem(OAUTH_DOCUMENT_RECOVERY_VALIDATED_CALLBACK_KEY)).toBe(marker);

    live.dirtySql = false;
    live.dirtySpec = false;
    expect(session.retryPending(workspace([saved('q1', 'SELECT latest')]))).toEqual({ kind: 'restored' });
    expect(s.tabs.value).not.toBe(beforeTabs);
    expect(store.getItem(OAUTH_DOCUMENT_RECOVERY_VALIDATED_CALLBACK_KEY)).toBeNull();
  });

  it('retains fresh callback authority when checkpoint storage access fails, then retries', () => {
    const store = storage(); saveSnapshot(store);
    const checkpoint = store.getItem(OAUTH_DOCUMENT_RECOVERY_KEY);
    const s = state();
    const beforeTabs = s.tabs.value;
    const getItem = store.getItem;
    store.getItem = vi.fn((key) => {
      if (key === OAUTH_DOCUMENT_RECOVERY_KEY) throw new Error('checkpoint read unavailable');
      return getItem(key);
    });
    const session = createOAuthDocumentRecoverySession(deps({ storage: store, state: s }));

    expect(session.restore('state-1', workspace())).toEqual({ kind: 'retry-deferred-retained' });
    expect(s.tabs.value).toBe(beforeTabs);
    expect(store.values.get(OAUTH_DOCUMENT_RECOVERY_KEY)).toBe(checkpoint);
    expect(store.values.get(OAUTH_DOCUMENT_RECOVERY_VALIDATED_CALLBACK_KEY)).toBeDefined();

    store.getItem = getItem;
    expect(session.retryPending(workspace())).toEqual({ kind: 'restored' });
    expect(s.tabs.value).not.toBe(beforeTabs);
    expect(s.tabs.value[0].sqlDraft).toBe('SELECT 1');
    expect(store.getItem(OAUTH_DOCUMENT_RECOVERY_VALIDATED_CALLBACK_KEY)).toBeNull();
  });

  it('restores ordering/navigation and authored fields while leaving execution transients at defaults', () => {
    const recovered = snapshot({
      tabs: [
        { ...snapshot().tabs[0], id: 't1', savedId: null, externalState: null },
        { id: 't2', doc: { kind: 'dashboard-variable', dashboardId: 'd1', variableName: 'zone' }, name: 'Zone', sqlDraft: 'SELECT zone', specText: '{invalid', specVersion: 1, editorMode: 'sql', dirtySql: true, dirtySpec: true, savedId: null },
      ], activeTabId: 't2', nextTabId: 3,
    });
    const store = storage(); saveSnapshot(store, recovered);
    const s = state();
    const session = createOAuthDocumentRecoverySession(deps({ state: s, storage: store }));

    expect(session.restore('state-1', workspace())).toEqual({ kind: 'restored' });
    expect(s.tabs.value.map((tab) => tab.id)).toEqual(['t1', 't2']);
    expect(s.activeTabId.value).toBe('t2'); expect(s.nextTabId).toBe(3);
    expect(s.tabs.value[1]).toMatchObject({ doc: { kind: 'dashboard-variable', dashboardId: 'd1', variableName: 'zone' }, specText: '{invalid', dirtySql: true, dirtySpec: true });
    for (const tab of s.tabs.value) {
      expect(tab.result).toBeNull();
      expect(tab.chSession).toBeUndefined();
      expect(tab.lastSuccessfulResultColumns).toEqual([]);
      expect(tab.specDiagnostics).toEqual([]);
    }
    expect(store.getItem(OAUTH_DOCUMENT_RECOVERY_KEY)).not.toBeNull();
    session.consume();
    expect(store.getItem(OAUTH_DOCUMENT_RECOVERY_KEY)).toBeNull();
    session.clear();
  });

  it('consume removes checkpoint before marker and retains authority when checkpoint removal fails', () => {
    const store = storage(); saveSnapshot(store); saveMarker(store);
    const calls: string[] = [];
    const removeItem = store.removeItem;
    store.removeItem = vi.fn((key) => {
      calls.push(key);
      if (key === OAUTH_DOCUMENT_RECOVERY_KEY) throw new Error('checkpoint removal failed');
      removeItem(key);
    });
    const session = createOAuthDocumentRecoverySession(deps({ storage: store }));

    expect(() => session.consume()).toThrow('checkpoint removal failed');
    expect(calls).toEqual([OAUTH_DOCUMENT_RECOVERY_KEY]);
    expect(store.getItem(OAUTH_DOCUMENT_RECOVERY_KEY)).not.toBeNull();
    expect(store.getItem(OAUTH_DOCUMENT_RECOVERY_VALIDATED_CALLBACK_KEY)).not.toBeNull();
  });

  it('prunes an orphan callback marker without treating it as a recoverable document', () => {
    const store = storage(); saveMarker(store);
    const session = createOAuthDocumentRecoverySession(deps({ storage: store }));

    expect(session.retryPending(workspace())).toEqual({ kind: 'absent' });
    expect(store.getItem(OAUTH_DOCUMENT_RECOVERY_VALIDATED_CALLBACK_KEY)).toBeNull();
    expect(store.getItem(OAUTH_DOCUMENT_RECOVERY_KEY)).toBeNull();
  });

  it('consume may leave only a harmless marker when its second removal fails', () => {
    const store = storage(); saveSnapshot(store); saveMarker(store);
    const removeItem = store.removeItem;
    store.removeItem = vi.fn((key) => {
      if (key === OAUTH_DOCUMENT_RECOVERY_VALIDATED_CALLBACK_KEY) {
        throw new Error('marker removal failed');
      }
      removeItem(key);
    });
    const session = createOAuthDocumentRecoverySession(deps({ storage: store }));

    expect(() => session.consume()).toThrow('marker removal failed');
    expect(store.getItem(OAUTH_DOCUMENT_RECOVERY_KEY)).toBeNull();
    expect(store.getItem(OAUTH_DOCUMENT_RECOVERY_VALIDATED_CALLBACK_KEY)).not.toBeNull();
  });

  it('clear attempts both removals and preserves the checkpoint error as primary', () => {
    const store = storage(); saveSnapshot(store); saveMarker(store);
    const calls: string[] = [];
    store.removeItem = vi.fn((key) => {
      calls.push(key);
      throw new Error(key === OAUTH_DOCUMENT_RECOVERY_KEY
        ? 'checkpoint clear failed'
        : 'marker clear failed');
    });
    const session = createOAuthDocumentRecoverySession(deps({ storage: store }));

    expect(() => session.clear()).toThrow('checkpoint clear failed');
    expect(calls).toEqual([
      OAUTH_DOCUMENT_RECOVERY_KEY,
      OAUTH_DOCUMENT_RECOVERY_VALIDATED_CALLBACK_KEY,
    ]);
  });

  it('clear reports a marker removal failure after checkpoint cleanup succeeds', () => {
    const store = storage(); saveSnapshot(store); saveMarker(store);
    const removeItem = store.removeItem;
    store.removeItem = vi.fn((key) => {
      if (key === OAUTH_DOCUMENT_RECOVERY_VALIDATED_CALLBACK_KEY) {
        throw new Error('marker clear failed');
      }
      removeItem(key);
    });
    const session = createOAuthDocumentRecoverySession(deps({ storage: store }));

    expect(() => session.clear()).toThrow('marker clear failed');
    expect(store.getItem(OAUTH_DOCUMENT_RECOVERY_KEY)).toBeNull();
    expect(store.getItem(OAUTH_DOCUMENT_RECOVERY_VALIDATED_CALLBACK_KEY)).not.toBeNull();
  });

  it('uses linked-tab reconciliation for dirty conflict/orphan and clean adopt/detach', () => {
    const cases: Array<{
      name: string; tab: OAuthDocumentRecoverySnapshot['tabs'][number]; latest: SavedQueryV2[]; check(tab: QueryTab): void;
    }> = [
      {
        name: 'dirty conflict',
        tab: { ...snapshot().tabs[0], sqlDraft: 'SELECT mine', dirtySql: true, dirtySpec: false, savedId: 'q1', lastCommittedQueryToken: 'old' },
        latest: [saved('q1', 'SELECT theirs')],
        check: (tab) => expect(tab.externalState).toBe('conflict'),
      },
      {
        name: 'dirty orphan',
        tab: { ...snapshot().tabs[0], dirtySql: true, dirtySpec: false, savedId: 'q1', lastCommittedQueryToken: 'old' },
        latest: [],
        check: (tab) => { expect(tab.savedId).toBeNull(); expect(tab.externalState).toBe('deleted'); },
      },
      {
        name: 'clean adopt',
        tab: { ...snapshot().tabs[0], dirtySql: false, dirtySpec: false, savedId: 'q1', lastCommittedQueryToken: 'old' },
        latest: [saved('q1', 'SELECT latest', 'Latest')],
        check: (tab) => { expect(tab.sqlDraft).toBe('SELECT latest'); expect(tab.dirtySql).toBe(false); },
      },
      {
        name: 'clean detach',
        tab: { ...snapshot().tabs[0], dirtySql: false, dirtySpec: false, savedId: 'q1', lastCommittedQueryToken: 'old', editorMode: 'spec' },
        latest: [],
        check: (tab) => { expect(tab.savedId).toBeNull(); expect(tab.editorMode).toBe('sql'); },
      },
    ];
    for (const item of cases) {
      const store = storage(); saveSnapshot(store, snapshot({ tabs: [item.tab] }));
      const s = state();
      expect(createOAuthDocumentRecoverySession(deps({ state: s, storage: store })).restore('state-1', workspace(item.latest))).toEqual({ kind: 'restored' });
      item.check(s.tabs.value[0]);
    }
  });
});
