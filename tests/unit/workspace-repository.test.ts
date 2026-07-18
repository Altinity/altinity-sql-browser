import { describe, expect, it, vi } from 'vitest';
import {
  createWorkspaceRepository,
} from '../../src/workspace/workspace-repository.js';
import type { WorkspaceStore } from '../../src/workspace/workspace-store.types.js';
import { encodeStoredWorkspaceJson } from '../../src/workspace/stored-workspace.js';
import { jsonSchemaValidationService } from '../../src/core/library-codec.js';
import type { StoredWorkspaceV1 } from '../../src/generated/json-schema.types.js';

// ── An in-memory fake for the injected IndexedDB seam ────────────────────────
// A single-record store, exactly the WorkspaceStore contract, plus test hooks
// (the persisted text, every write, and a write-failure switch) so a commit's
// atomicity and last-write-wins behavior are directly observable.
function memStore(initial: string | null = null) {
  let value = initial;
  const writes: string[] = [];
  let failWrite = false;
  const store: WorkspaceStore & {
    readonly value: string | null; readonly writes: string[]; setFailWrite(f: boolean): void;
  } = {
    read: async () => value,
    write: async (text: string) => {
      if (failWrite) throw new Error('quota exceeded');
      writes.push(text);
      value = text;
    },
    clear: async () => { value = null; },
    get value() { return value; },
    get writes() { return writes; },
    setFailWrite(f: boolean) { failWrite = f; },
  };
  return store;
}

const panelQuery = (id: string): StoredWorkspaceV1['queries'][number] => ({
  id, sql: 'SELECT 1', specVersion: 1,
  spec: { name: id, favorite: true, panel: { cfg: { type: 'bar', x: 0, y: [1] } } },
});
const workspace = (over: Partial<StoredWorkspaceV1> = {}): StoredWorkspaceV1 => ({
  storageVersion: 1, id: 'w1', name: 'W', queries: [], dashboard: null, ...over,
});
const withDashboard = (over: Record<string, unknown> = {}): StoredWorkspaceV1 => workspace({
  queries: [panelQuery('p1')],
  dashboard: {
    documentVersion: 1, id: 'd1', title: 'D', revision: 7,
    layout: { type: 'flow', version: 1, preset: 'full-width', items: { t1: {} } },
    filters: [], tiles: [{ id: 't1', queryId: 'p1' }],
  },
  ...over,
});

describe('createWorkspaceRepository.loadCurrent', () => {
  it('returns null when no aggregate record exists', async () => {
    const repo = createWorkspaceRepository({ store: memStore(null) });
    expect(await repo.loadCurrent()).toBeNull();
  });

  it('decodes and returns a valid stored aggregate', async () => {
    const ws = withDashboard();
    const encoded = encodeStoredWorkspaceJson(ws);
    if (!encoded.ok) throw new Error('fixture should encode');
    const repo = createWorkspaceRepository({ store: memStore(encoded.value) });
    expect(await repo.loadCurrent()).toEqual(ws);
  });

  it('reads a present-but-invalid record as null (never returns a corrupt aggregate)', async () => {
    const repo = createWorkspaceRepository({ store: memStore('{"storageVersion":2}') });
    expect(await repo.loadCurrent()).toBeNull();
  });
});

describe('createWorkspaceRepository.loadCurrentResult', () => {
  it('reports empty when no aggregate record exists', async () => {
    const repo = createWorkspaceRepository({ store: memStore(null) });
    expect(await repo.loadCurrentResult()).toEqual({ status: 'empty' });
  });

  it('reports ok with the decoded workspace when a valid record is stored', async () => {
    const ws = withDashboard();
    const encoded = encodeStoredWorkspaceJson(ws);
    if (!encoded.ok) throw new Error('fixture should encode');
    const repo = createWorkspaceRepository({ store: memStore(encoded.value) });
    expect(await repo.loadCurrentResult()).toEqual({ status: 'ok', workspace: ws });
  });

  it('reports corrupt with diagnostics when a present record fails to decode/validate (never collapses to empty)', async () => {
    const repo = createWorkspaceRepository({ store: memStore('{"storageVersion":2}') });
    const result = await repo.loadCurrentResult();
    expect(result.status).toBe('corrupt');
    if (result.status !== 'corrupt') throw new Error('unreachable');
    expect(result.diagnostics.length).toBeGreaterThan(0);
    expect(result.diagnostics.some((d) => d.code === 'workspace-version-unsupported')).toBe(true);
  });

  it('reports corrupt for text that is not even valid JSON', async () => {
    const repo = createWorkspaceRepository({ store: memStore('not json{') });
    const result = await repo.loadCurrentResult();
    expect(result.status).toBe('corrupt');
    if (result.status !== 'corrupt') throw new Error('unreachable');
    expect(result.diagnostics.length).toBeGreaterThan(0);
  });
});

describe('createWorkspaceRepository.commit', () => {
  it('validates the whole candidate BEFORE writing; an invalid one is never persisted', async () => {
    const store = memStore(null);
    const repo = createWorkspaceRepository({ store });
    // A tile referencing a missing query fails whole-workspace semantics.
    const bad = workspace({
      dashboard: {
        documentVersion: 1, id: 'd', title: 'D', revision: 1,
        layout: { type: 'flow', version: 1, preset: 'full-width', items: { t1: {} } },
        filters: [], tiles: [{ id: 't1', queryId: 'gone' }],
      },
    });
    const result = await repo.commit(bad);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.diagnostics.some((d) => d.code === 'dashboard-tile-query-missing')).toBe(true);
    expect(store.value).toBeNull(); // nothing written
    expect(store.writes).toHaveLength(0);
  });

  it('atomically persists a valid candidate and publishes the committed state + revision', async () => {
    const store = memStore(null);
    const repo = createWorkspaceRepository({ store });
    const ws = withDashboard();
    const result = await repo.commit(ws);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.workspace).toEqual(ws);
    expect(result.dashboardRevision).toBe(7);
    // Persisted text is exactly the canonical encoding (one atomic write).
    const encoded = encodeStoredWorkspaceJson(ws);
    expect(encoded.ok && store.value).toBe(encoded.ok ? encoded.value : '');
    expect(store.writes).toHaveLength(1);
  });

  it('reports a null dashboardRevision when the workspace has no Dashboard', async () => {
    const repo = createWorkspaceRepository({ store: memStore(null) });
    const result = await repo.commit(workspace({ queries: [panelQuery('p1')] }));
    expect(result.ok && result.dashboardRevision).toBeNull();
  });

  it('on a failed write leaves the previously stored workspace intact and does not increment revision', async () => {
    const previous = withDashboard({ id: 'prev', name: 'Prev' });
    const encodedPrev = encodeStoredWorkspaceJson(previous);
    if (!encodedPrev.ok) throw new Error('fixture');
    const store = memStore(encodedPrev.value);
    store.setFailWrite(true);
    const repo = createWorkspaceRepository({ store });
    const result = await repo.commit(withDashboard({ id: 'next', name: 'Next', dashboard: null }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.diagnostics.map((d) => d.code)).toEqual(['workspace-persist-failed']);
    // Previous stored workspace untouched; no new write recorded.
    expect(store.value).toBe(encodedPrev.value);
    expect(store.writes).toHaveLength(0);
    // Repository never touched revision — the stored dashboard revision is still 7.
    const reloaded = await repo.loadCurrent();
    expect(reloaded?.dashboard?.revision).toBe(7);
  });

  it('stringifies a non-Error write rejection into the persist-failed diagnostic', async () => {
    const store: WorkspaceStore = {
      read: async () => null,
      // Deliberately throwing a non-Error to exercise the String(error) branch.
      write: async () => { throw 'disk full'; },
      clear: async () => {},
    };
    const repo = createWorkspaceRepository({ store });
    const result = await repo.commit(workspace());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.diagnostics[0].message).toContain('disk full');
  });

  it('honors an injected validation-service override', async () => {
    const store = memStore(null);
    const repo = createWorkspaceRepository({ store, validationService: jsonSchemaValidationService });
    const result = await repo.commit(workspace());
    expect(result.ok).toBe(true);
    expect(store.writes).toHaveLength(1);
  });
});

describe('createWorkspaceRepository.clearCurrent', () => {
  it('delegates to the store clear', async () => {
    const store = memStore('{"storageVersion":1}');
    const clear = vi.spyOn(store, 'clear');
    const repo = createWorkspaceRepository({ store });
    await repo.clearCurrent();
    expect(clear).toHaveBeenCalledTimes(1);
    expect(store.value).toBeNull();
  });
});

describe('multi-tab last-successful-commit-wins (never a partially-mixed workspace)', () => {
  it('a later commit fully replaces the earlier one — the record is one complete aggregate', async () => {
    const store = memStore(null);
    const repo = createWorkspaceRepository({ store });
    const a = withDashboard({ id: 'A', name: 'Alpha', queries: [panelQuery('qa')] });
    // Re-key the dashboard tile onto qa/qb so a "mix" would be structurally detectable.
    a.dashboard!.tiles = [{ id: 't1', queryId: 'qa' }];
    const b = withDashboard({ id: 'B', name: 'Beta', queries: [panelQuery('qb')] });
    b.dashboard!.tiles = [{ id: 't1', queryId: 'qb' }];

    await repo.commit(a);
    await repo.commit(b);

    const loaded = await repo.loadCurrent();
    expect(loaded).toEqual(b);
    // The persisted record is exactly B's canonical encoding — never a blend
    // of A's and B's fields.
    const encodedB = encodeStoredWorkspaceJson(b);
    expect(encodedB.ok && store.value).toBe(encodedB.ok ? encodedB.value : '');
    expect(loaded?.queries.map((q) => q.id)).toEqual(['qb']);
  });

  it('under interleaved (un-awaited) commits the final record is exactly one complete aggregate', async () => {
    const store = memStore(null);
    const repo = createWorkspaceRepository({ store });
    const a = workspace({ id: 'A', name: 'Alpha', queries: [panelQuery('qa')] });
    const b = workspace({ id: 'B', name: 'Beta', queries: [panelQuery('qb')] });
    await Promise.all([repo.commit(a), repo.commit(b)]);
    const loaded = await repo.loadCurrent();
    // Whichever won, it is internally consistent — the id and its query match
    // the SAME source workspace, proving no partial mix.
    expect(loaded).not.toBeNull();
    const encodedA = encodeStoredWorkspaceJson(a);
    const encodedB = encodeStoredWorkspaceJson(b);
    const winners = [encodedA, encodedB].filter((e) => e.ok).map((e) => (e.ok ? e.value : ''));
    expect(winners).toContain(store.value);
  });
});
