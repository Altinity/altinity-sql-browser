import { describe, expect, it } from 'vitest';
import { createWorkspaceRepository } from '../../src/workspace/workspace-repository.js';
import { encodeStoredWorkspaceJson } from '../../src/workspace/stored-workspace.js';
import type {
  WorkspaceStore, WorkspaceStoreCreateResult, WorkspaceStoreRecord,
  WorkspaceStoreReplaceResult,
} from '../../src/workspace/workspace-store.types.js';
import type { StoredWorkspaceV4 } from '../../src/generated/json-schema.types.js';

const workspace = (over: Partial<StoredWorkspaceV4> = {}): StoredWorkspaceV4 => ({
  storageVersion: 4,
  id: 'w1',
  key: 'workspace_one',
  name: 'Workspace One',
  queries: [],
  dashboards: [],
  ...over,
});

const encode = (value: StoredWorkspaceV4): string => {
  const result = encodeStoredWorkspaceJson(value);
  if (!result.ok) throw new Error('invalid test fixture');
  return result.value;
};

function memoryStore(initial: WorkspaceStoreRecord[] = []) {
  const records = new Map(initial.map((record) => [record.id, { ...record }]));
  let lastUsedKey: string | null = null;
  let fail: string | null = null;
  let forcedCreate: WorkspaceStoreCreateResult | null = null;
  let forcedReplace: WorkspaceStoreReplaceResult | null = null;

  const store: WorkspaceStore & {
    records: Map<string, WorkspaceStoreRecord>;
    setLastUsed(key: string | null): void;
    setFail(operation: string | null): void;
    forceCreate(result: WorkspaceStoreCreateResult | null): void;
    forceReplace(result: WorkspaceStoreReplaceResult | null): void;
  } = {
    list: async () => {
      if (fail === 'list') throw 'list unavailable';
      return [...records.values()];
    },
    readById: async (id) => {
      if (fail === 'read') throw new Error('read unavailable');
      return records.get(id) ?? null;
    },
    readByKey: async (key) =>
      [...records.values()].find((record) => record.key.toLowerCase() === key.toLowerCase()) ?? null,
    create: async (record) => {
      if (fail === 'create') throw new Error('quota exceeded');
      if (forcedCreate) return forcedCreate;
      if (records.has(record.id)) return { status: 'duplicate-id' };
      if ([...records.values()].some((item) => item.key.toLowerCase() === record.key.toLowerCase())) {
        return { status: 'duplicate-key' };
      }
      records.set(record.id, { ...record });
      return { status: 'created' };
    },
    replace: async (record) => {
      if (fail === 'replace') throw 'disk full';
      if (forcedReplace) return forcedReplace;
      const existing = records.get(record.id);
      if (!existing) return { status: 'not-found' };
      if (existing.key !== record.key) return { status: 'immutable-key' };
      records.set(record.id, { ...record, lastOpenedAt: existing.lastOpenedAt });
      return { status: 'replaced' };
    },
    delete: async (id) => {
      if (fail === 'delete') throw new Error('delete unavailable');
      const existing = records.get(id);
      if (!existing) return false;
      records.delete(id);
      if (lastUsedKey === existing.key) lastUsedKey = null;
      return true;
    },
    getLastUsedKey: async () => lastUsedKey,
    markOpened: async (key, timestamp) => {
      if (fail === 'markOpened') throw new Error('preference unavailable');
      const entry = [...records.entries()].find(([, record]) => record.key === key);
      if (!entry) return { status: 'not-found' };
      records.set(entry[0], { ...entry[1], lastOpenedAt: timestamp });
      lastUsedKey = key;
      return { status: 'opened' };
    },
    clearLastUsedKey: async () => { lastUsedKey = null; },
    records,
    setLastUsed: (key) => { lastUsedKey = key; },
    setFail: (operation) => { fail = operation; },
    forceCreate: (result) => { forcedCreate = result; },
    forceReplace: (result) => { forcedReplace = result; },
  };
  return store;
}

const record = (
  value: StoredWorkspaceV4, lastOpenedAt: number | null = null,
): WorkspaceStoreRecord => ({
  id: value.id, key: value.key, text: encode(value), lastOpenedAt,
});

describe('workspace repository collection', () => {
  it('creates and independently loads multiple workspaces by ID and canonical key', async () => {
    const store = memoryStore();
    const repository = createWorkspaceRepository({ store });
    const one = workspace();
    const two = workspace({ id: 'w2', key: 'workspace_two', name: 'Two' });
    expect((await repository.create(one)).ok).toBe(true);
    expect((await repository.create(two)).ok).toBe(true);
    expect(await repository.loadById('w1')).toEqual({ status: 'ok', workspace: one });
    expect(await repository.loadByKey('WORKSPACE_TWO')).toEqual({ status: 'ok', workspace: two });
    expect(await repository.loadById('missing')).toEqual({ status: 'empty' });
    expect(await repository.loadByKey('missing')).toEqual({ status: 'empty' });
  });

  it('lists deterministic summaries and separately reports corrupt records', async () => {
    const one = workspace({ queries: [{
      id: 'q', sql: 'SELECT 1', specVersion: 1, spec: { name: 'q', favorite: false },
    }] });
    const two = workspace({ id: 'w2', key: 'a_key', name: 'A' });
    const store = memoryStore([
      record(one, 8),
      record(two),
      { id: 'broken', key: 'broken', text: 'not json', lastOpenedAt: null },
      { id: 'wrong', key: 'wrong', text: encode(workspace({ id: 'other', key: 'other' })), lastOpenedAt: null },
    ]);
    const result = await createWorkspaceRepository({ store }).list();
    expect(result.summaries).toEqual([
      { id: 'w2', key: 'a_key', name: 'A', queryCount: 0, hasDashboard: false, lastOpenedAt: null },
      {
        id: 'w1', key: 'workspace_one', name: 'Workspace One',
        queryCount: 1, hasDashboard: false, lastOpenedAt: 8,
      },
    ]);
    expect(result.corrupt.map(({ id }) => id)).toEqual(['broken', 'wrong']);
    expect(result.corrupt[1].diagnostics[0].code).toBe('workspace-record-identity-mismatch');
  });

  it('preserves corrupt as a distinct keyed load state', async () => {
    const store = memoryStore([{ id: 'bad', key: 'bad', text: '{}', lastOpenedAt: null }]);
    const loaded = await createWorkspaceRepository({ store }).loadByKey('bad');
    expect(loaded.status).toBe('corrupt');
  });

  it('validates before create and distinguishes duplicate ID, duplicate key, and persistence failure', async () => {
    const store = memoryStore();
    const repository = createWorkspaceRepository({ store });
    const invalid = workspace({ key: 'INVALID KEY' });
    expect((await repository.create(invalid)).ok).toBe(false);
    expect(store.records.size).toBe(0);

    await repository.create(workspace());
    let result = await repository.create(workspace());
    expect(!result.ok && result.diagnostics[0].code).toBe('workspace-duplicate-id');
    result = await repository.create(workspace({ id: 'w2' }));
    expect(!result.ok && result.diagnostics[0].code).toBe('workspace-duplicate-key');

    store.setFail('create');
    result = await repository.create(workspace({ id: 'w3', key: 'w3' }));
    expect(!result.ok && result.diagnostics[0].code).toBe('workspace-persist-failed');
  });

  it('commits one existing workspace without changing another or its open timestamp', async () => {
    const one = workspace();
    const two = workspace({ id: 'w2', key: 'two', name: 'Two' });
    const store = memoryStore([record(one, 11), record(two, 22)]);
    const repository = createWorkspaceRepository({ store });
    const changed = { ...one, name: 'Renamed' };
    const result = await repository.commit(changed);
    expect(result.ok && result.workspace).toEqual(changed);
    expect(result.ok && result.dashboardRevision).toBeNull();
    expect(store.records.get('w1')?.lastOpenedAt).toBe(11);
    expect(store.records.get('w2')).toEqual(record(two, 22));
  });

  it('publishes a committed Dashboard revision', async () => {
    const value = workspace({
      queries: [{
        id: 'q1', sql: 'SELECT 1', specVersion: 1,
        spec: { name: 'q1', favorite: true },
      }],
      dashboards: [{
        documentVersion: 1,
        id: 'd1',
        title: 'Dashboard',
        revision: 4,
        layout: { type: 'flow', version: 1, preset: 'report', items: {} },
        filters: [],
        tiles: [],
      }],
    });
    const repository = createWorkspaceRepository({ store: memoryStore([record(value)]) });
    const result = await repository.commit(value);
    expect(result.ok && result.dashboardRevision).toBe(4);
  });

  it('validates commits and distinguishes not found, immutable key, and persistence failures', async () => {
    const original = workspace();
    const store = memoryStore([record(original)]);
    const repository = createWorkspaceRepository({ store });

    let result = await repository.commit({ ...original, key: 'INVALID KEY' });
    expect(result.ok).toBe(false);
    expect(store.records.get('w1')?.text).toBe(encode(original));

    result = await repository.commit(workspace({ id: 'missing', key: 'missing' }));
    expect(!result.ok && result.diagnostics[0].code).toBe('workspace-not-found');
    result = await repository.commit({ ...original, key: 'changed' });
    expect(!result.ok && result.diagnostics[0].code).toBe('workspace-key-immutable');

    store.forceReplace({ status: 'not-found' });
    result = await repository.commit(original);
    expect(!result.ok && result.diagnostics[0].code).toBe('workspace-not-found');
    store.forceReplace({ status: 'immutable-key' });
    result = await repository.commit(original);
    expect(!result.ok && result.diagnostics[0].code).toBe('workspace-key-immutable');
    store.forceReplace(null);
    store.setFail('replace');
    result = await repository.commit(original);
    expect(!result.ok && result.diagnostics[0].message).toContain('disk full');
  });

  it('deletes exactly one workspace idempotently and reports failed deletes', async () => {
    const one = workspace();
    const two = workspace({ id: 'w2', key: 'two' });
    const store = memoryStore([record(one), record(two)]);
    const repository = createWorkspaceRepository({ store });
    expect(await repository.delete('w1')).toEqual({ ok: true, deleted: true });
    expect(await repository.delete('w1')).toEqual({ ok: true, deleted: false });
    expect(store.records.get('w2')).toEqual(record(two));
    store.setFail('delete');
    const failed = await repository.delete('w2');
    expect(!failed.ok && failed.diagnostics[0].code).toBe('workspace-delete-failed');
  });
});

describe('implicit workspace resolution and opened metadata', () => {
  it('first uses a valid last-used preference', async () => {
    const store = memoryStore([
      record(workspace(), 100),
      record(workspace({ id: 'w2', key: 'two' }), 1),
    ]);
    store.setLastUsed('two');
    const result = await createWorkspaceRepository({ store }).resolveImplicit();
    expect(result.status === 'ok' && result.workspace.key).toBe('two');
  });

  it('falls back from a missing or corrupt preference to newest opened, ties by key', async () => {
    const a = workspace({ id: 'a', key: 'a' });
    const b = workspace({ id: 'b', key: 'b' });
    const store = memoryStore([
      record(b, 10),
      { id: 'bad', key: 'bad', text: '{}', lastOpenedAt: 99 },
      record(a, 10),
    ]);
    store.setLastUsed('missing');
    let result = await createWorkspaceRepository({ store }).resolveImplicit();
    expect(result.status === 'ok' && result.workspace.key).toBe('a');

    store.setLastUsed('bad');
    result = await createWorkspaceRepository({ store }).resolveImplicit();
    expect(result.status === 'ok' && result.workspace.key).toBe('a');
  });

  it('uses key order when no workspace has usage metadata and stays empty when none are valid', async () => {
    const store = memoryStore([
      record(workspace({ id: 'b', key: 'b' })),
      record(workspace({ id: 'a', key: 'a' })),
    ]);
    let result = await createWorkspaceRepository({ store }).resolveImplicit();
    expect(result.status === 'ok' && result.workspace.key).toBe('a');
    store.records.clear();
    result = await createWorkspaceRepository({ store }).resolveImplicit();
    expect(result).toEqual({ status: 'empty' });
  });

  it('ranks timestamped workspaces ahead of unstamped ones in either input order', async () => {
    const a = workspace({ id: 'a', key: 'a' });
    const b = workspace({ id: 'b', key: 'b' });
    for (const records of [[record(a), record(b, 1)], [record(b, 1), record(a)]]) {
      const result = await createWorkspaceRepository({ store: memoryStore(records) }).resolveImplicit();
      expect(result.status === 'ok' && result.workspace.key).toBe('b');
    }
  });

  it('returns deterministic corrupt identity when no valid workspace exists', async () => {
    const store = memoryStore([
      { id: 'z', key: 'same', text: '{}', lastOpenedAt: 1 },
      { id: 'a', key: 'same', text: '{}', lastOpenedAt: 1 },
    ]);
    const result = await createWorkspaceRepository({ store }).resolveImplicit();
    expect(result).toMatchObject({ status: 'corrupt', id: 'a', key: 'same' });
  });

  it('marks opened using the injected time and reports not-found and persistence failure', async () => {
    const store = memoryStore([record(workspace())]);
    const repository = createWorkspaceRepository({ store, now: () => 1234 });
    expect(await repository.markOpened('WORKSPACE_ONE')).toEqual({ ok: true });
    expect(store.records.get('w1')?.lastOpenedAt).toBe(1234);
    expect(await repository.resolveImplicit()).toEqual({
      status: 'ok', workspace: workspace(),
    });
    expect(await repository.markOpened('missing')).toMatchObject({
      ok: false, diagnostics: [{ code: 'workspace-not-found' }],
    });
    store.setFail('markOpened');
    expect(await repository.markOpened('workspace_one')).toMatchObject({
      ok: false, diagnostics: [{ code: 'workspace-mark-opened-failed' }],
    });
  });

  it('propagates read failures distinctly from empty records', async () => {
    const store = memoryStore();
    store.setFail('read');
    await expect(createWorkspaceRepository({ store }).loadById('w1')).rejects.toThrow('read unavailable');
  });

  it('propagates list failures distinctly from an empty collection', async () => {
    const store = memoryStore();
    store.setFail('list');
    await expect(createWorkspaceRepository({ store }).list()).rejects.toBe('list unavailable');
  });
});

// #424: the repository's canonical aggregate is V3. A record persisted as V2
// is migrated by the codec on read; the RECORD upgrades on its next ordinary
// commit, so opening a workspace stays a pure read.
describe('workspace repository — StoredWorkspaceV4 (#424)', () => {
  const dashboard = (id: string, revision = 1) => ({
    documentVersion: 1 as const, id, title: id.toUpperCase(), revision,
    layout: { type: 'flow', version: 1, preset: 'report', items: {} },
    filters: [], tiles: [],
  });
  /** A record written before #424 — its raw text is still the V2 shape. */
  const legacyRecord = (lastOpenedAt: number | null = null): WorkspaceStoreRecord => ({
    id: 'w1',
    key: 'workspace_one',
    text: JSON.stringify({
      storageVersion: 2, id: 'w1', key: 'workspace_one', name: 'Workspace One',
      queries: [], dashboard: dashboard('legacy', 6),
    }),
    lastOpenedAt,
  });

  it('reads a persisted V2 record as V4, preserving the Dashboard and its revision', async () => {
    const store = memoryStore([legacyRecord()]);
    const repository = createWorkspaceRepository({ store });
    const loaded = await repository.loadById('w1');
    expect(loaded.status).toBe('ok');
    if (loaded.status !== 'ok') return;
    expect(loaded.workspace.storageVersion).toBe(4);
    expect(loaded.workspace.dashboards).toEqual([dashboard('legacy', 6)]);
    // A read is a pure read: the stored TEXT is untouched until a real write.
    expect(JSON.parse(store.records.get('w1')!.text).storageVersion).toBe(2);

    // …and the same record summarizes and resolves implicitly as V3 too.
    expect((await repository.list()).summaries).toEqual([
      { id: 'w1', key: 'workspace_one', name: 'Workspace One', queryCount: 0, hasDashboard: true, lastOpenedAt: null },
    ]);
    const implicit = await repository.resolveImplicit();
    expect(implicit.status === 'ok' && implicit.workspace.dashboards).toHaveLength(1);
  });

  it('rewrites a migrated record canonically as V4 on its next commit, keeping lastOpenedAt', async () => {
    const store = memoryStore([legacyRecord(1234)]);
    const repository = createWorkspaceRepository({ store });
    const loaded = await repository.loadById('w1');
    if (loaded.status !== 'ok') throw new Error('expected a readable record');

    const committed = await repository.commit(loaded.workspace);
    expect(committed.ok).toBe(true);
    const text = store.records.get('w1')!.text;
    expect(text).toContain('"storageVersion": 4');
    expect(text).toContain('"dashboards"');
    expect(text).not.toContain('"dashboard":');
    expect(text).toBe(encode(loaded.workspace));
    // Store-owned metadata survives the upgrade.
    expect(store.records.get('w1')!.lastOpenedAt).toBe(1234);
    // Re-reading the upgraded record performs no further transformation.
    const reread = await repository.loadById('w1');
    expect(reread.status === 'ok' && reread.workspace).toEqual(loaded.workspace);
  });

  it('round-trips several Dashboards and reports the compatibility revision', async () => {
    const store = memoryStore();
    const repository = createWorkspaceRepository({ store });
    const value = workspace({ dashboards: [dashboard('exec', 4), dashboard('sales', 9)] });

    const created = await repository.create(value);
    expect(created).toMatchObject({ ok: true, dashboardRevision: 4 });
    const loaded = await repository.loadById('w1');
    expect(loaded.status === 'ok' && loaded.workspace.dashboards.map((d) => d.id))
      .toEqual(['exec', 'sales']);
    expect((await repository.list()).summaries[0].hasDashboard).toBe(true);

    // Replacing ONE Dashboard by id leaves the other byte-identical…
    const edited = {
      ...value,
      dashboards: [{ ...dashboard('exec', 5), title: 'Edited' }, dashboard('sales', 9)],
    };
    const committed = await repository.commit(edited);
    expect(committed).toMatchObject({ ok: true, dashboardRevision: 5 });
    const after = await repository.loadById('w1');
    if (after.status !== 'ok') throw new Error('expected a readable record');
    expect(after.workspace.dashboards[0].title).toBe('Edited');
    expect(after.workspace.dashboards[1]).toEqual(dashboard('sales', 9));
  });

  it('preserves every Dashboard through a rename and a query-only mutation', async () => {
    const store = memoryStore();
    const repository = createWorkspaceRepository({ store });
    const dashboards = [dashboard('exec'), dashboard('sales')];
    await repository.create(workspace({ dashboards }));

    await repository.commit(workspace({ name: 'Renamed', dashboards }));
    await repository.commit(workspace({
      name: 'Renamed', dashboards,
      queries: [{ id: 'q1', sql: 'SELECT 1', specVersion: 1, spec: { name: 'Q1' } }],
    }));
    const loaded = await repository.loadById('w1');
    if (loaded.status !== 'ok') throw new Error('expected a readable record');
    expect(loaded.workspace.name).toBe('Renamed');
    expect(loaded.workspace.queries).toHaveLength(1);
    expect(loaded.workspace.dashboards).toEqual(dashboards);
  });

  it('commits nothing when a candidate\'s Dashboard collection is invalid', async () => {
    const store = memoryStore();
    const repository = createWorkspaceRepository({ store });
    const valid = workspace({ dashboards: [dashboard('exec')] });
    await repository.create(valid);

    const duplicate = await repository.commit(
      workspace({ dashboards: [dashboard('exec'), dashboard('exec', 2)] }),
    );
    expect(duplicate.ok).toBe(false);
    expect(duplicate).toMatchObject({ diagnostics: [{ code: 'workspace-duplicate-dashboard-id' }] });
    // The previously committed record is untouched.
    expect(store.records.get('w1')!.text).toBe(encode(valid));
  });

  it('reports a legacy record that cannot be migrated as corrupt, not as empty', async () => {
    const store = memoryStore([{
      id: 'w1',
      key: 'workspace_one',
      text: JSON.stringify({
        storageVersion: 2, id: 'w1', key: 'workspace_one', name: 'Workspace One',
        queries: [],
        dashboard: { ...dashboard('legacy'), tiles: [{ id: 't1', queryId: 'gone' }] },
      }),
      lastOpenedAt: null,
    }]);
    const loaded = await createWorkspaceRepository({ store }).loadById('w1');
    expect(loaded).toMatchObject({
      status: 'corrupt', id: 'w1', key: 'workspace_one',
      diagnostics: [{ code: 'dashboard-tile-query-missing' }],
    });
  });
});
