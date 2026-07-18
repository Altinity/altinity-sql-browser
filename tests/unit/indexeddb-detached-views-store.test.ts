import { describe, expect, it } from 'vitest';
import { createIndexedDbDetachedViewsStore } from '../../src/workspace/indexeddb-detached-views-store.js';
import type { StoredWorkspaceV1 } from '../../src/generated/json-schema.types.js';

// ── A minimal in-memory fake IDBFactory ──────────────────────────────────────
// Extends the shape established in `indexeddb-workspace-store.test.ts` with
// cursor support (`openCursor`), which this adapter's retention-prune step
// needs and the original fake did not provide. Kept local to this test file.
type Handler = (() => void) | null;

interface Cfg {
  failOpen?: boolean; openError?: unknown;
  failGet?: boolean; getError?: unknown;
  failTx?: 'abort' | 'error' | null; txError?: unknown;
  failCursor?: boolean; cursorError?: unknown;
  preexistingStore?: boolean;
  storeName?: string;
}

class FakeRequest {
  result: unknown;
  error: unknown = null;
  onsuccess: Handler = null;
  onerror: Handler = null;
  onupgradeneeded: Handler = null;
}

class FakeCursorRequest extends FakeRequest {}

class FakeObjectStore {
  data: Map<string, unknown>;
  cfg: Cfg;
  constructor(data: Map<string, unknown>, cfg: Cfg) { this.data = data; this.cfg = cfg; }

  get(key: string): FakeRequest {
    const req = new FakeRequest();
    queueMicrotask(() => {
      if (this.cfg.failGet) { req.error = this.cfg.getError ?? null; req.onerror?.(); } else {
        req.result = this.data.get(key);
        req.onsuccess?.();
      }
    });
    return req;
  }

  put(value: unknown, key: string): FakeRequest { this.data.set(key, value); return new FakeRequest(); }
  delete(key: string): FakeRequest { this.data.delete(key); return new FakeRequest(); }

  openCursor(): FakeCursorRequest {
    const req = new FakeCursorRequest();
    const entries = Array.from(this.data.entries());
    let index = 0;
    const step = () => {
      queueMicrotask(() => {
        if (this.cfg.failCursor) { req.error = this.cfg.cursorError ?? null; req.onerror?.(); return; }
        if (index < entries.length) {
          const [key, value] = entries[index];
          req.result = { key, value, continue: () => { index += 1; step(); } };
        } else {
          req.result = null;
        }
        req.onsuccess?.();
      });
    };
    step();
    return req;
  }
}

class FakeTx {
  error: unknown = null;
  oncomplete: Handler = null;
  onerror: Handler = null;
  onabort: Handler = null;
  db: FakeDB;
  cfg: Cfg;
  constructor(db: FakeDB, cfg: Cfg) {
    this.db = db;
    this.cfg = cfg;
    // Fire completion on a macrotask, not a microtask: `put` issues an awaited
    // cursor walk before attaching `transactionDone`'s `oncomplete`, so a
    // microtask-scheduled completion would fire into a null handler and hang.
    // A macrotask lands after the microtask queue (cursor iteration + deletes)
    // fully drains — mirroring a real transaction completing after its pending
    // requests settle.
    setTimeout(() => {
      if (this.cfg.failTx === 'abort') { this.error = this.cfg.txError ?? null; this.onabort?.(); } else if (this.cfg.failTx === 'error') { this.error = this.cfg.txError ?? null; this.onerror?.(); } else this.oncomplete?.();
    }, 0);
  }
  objectStore(name: string): FakeObjectStore { return new FakeObjectStore(this.db.stores.get(name)!, this.cfg); }
}

class FakeDB {
  stores = new Map<string, Map<string, unknown>>();
  objectStoreNames = { contains: (n: string) => this.stores.has(n) };
  cfg: Cfg;
  constructor(cfg: Cfg) { this.cfg = cfg; }
  createObjectStore(name: string): void { this.stores.set(name, new Map()); }
  transaction(_names: string[], _mode: string): FakeTx { return new FakeTx(this, this.cfg); }
}

function fakeFactory(cfg: Cfg = {}): IDBFactory {
  const db = new FakeDB(cfg);
  if (cfg.preexistingStore) db.stores.set(cfg.storeName ?? 'views', new Map());
  return {
    open(_name: string, _version?: number) {
      const req = new FakeRequest();
      queueMicrotask(() => {
        if (cfg.failOpen) { req.error = cfg.openError ?? null; req.onerror?.(); return; }
        req.result = db;
        req.onupgradeneeded?.();
        req.onsuccess?.();
      });
      return req as unknown as IDBOpenDBRequest;
    },
  } as unknown as IDBFactory;
}

function workspace(id: string): StoredWorkspaceV1 {
  return { storageVersion: 1, id, name: `Workspace ${id}`, queries: [], dashboard: null };
}

describe('createIndexedDbDetachedViewsStore', () => {
  it('round-trips a workspace through put/get, keyed by workspace.id', async () => {
    const store = createIndexedDbDetachedViewsStore(fakeFactory());
    await store.put({ workspace: workspace('w1'), savedAt: 1000 });
    expect(await store.get('w1')).toEqual(workspace('w1'));
  });

  it('returns null for a missing id', async () => {
    const store = createIndexedDbDetachedViewsStore(fakeFactory());
    expect(await store.get('missing')).toBeNull();
  });

  it('prunes to the newest maxRecords by savedAt within the same transaction', async () => {
    const store = createIndexedDbDetachedViewsStore(fakeFactory(), { maxRecords: 2 });
    await store.put({ workspace: workspace('a'), savedAt: 1 });
    await store.put({ workspace: workspace('b'), savedAt: 3 });
    // Adding a third record over the cap of 2 must evict the oldest ('a').
    await store.put({ workspace: workspace('c'), savedAt: 2 });
    expect(await store.get('a')).toBeNull();
    expect(await store.get('b')).toEqual(workspace('b'));
    expect(await store.get('c')).toEqual(workspace('c'));
  });

  it('does not prune when at or under the cap', async () => {
    const store = createIndexedDbDetachedViewsStore(fakeFactory(), { maxRecords: 5 });
    await store.put({ workspace: workspace('a'), savedAt: 1 });
    await store.put({ workspace: workspace('b'), savedAt: 2 });
    expect(await store.get('a')).toEqual(workspace('a'));
    expect(await store.get('b')).toEqual(workspace('b'));
  });

  it('honors custom db/store option names and reuses a preexisting store', async () => {
    const store = createIndexedDbDetachedViewsStore(
      fakeFactory({ storeName: 'custom', preexistingStore: true }),
      { dbName: 'custom-db', storeName: 'custom' },
    );
    await store.put({ workspace: workspace('z'), savedAt: 5 });
    expect(await store.get('z')).toEqual(workspace('z'));
  });

  it('rejects every operation when no IndexedDB factory is available', async () => {
    const store = createIndexedDbDetachedViewsStore(undefined);
    await expect(store.get('x')).rejects.toThrow('IndexedDB is unavailable');
    await expect(store.put({ workspace: workspace('x'), savedAt: 1 })).rejects.toThrow('IndexedDB is unavailable');
  });

  it('rejects when the database open fails (with and without a request error)', async () => {
    const boom = createIndexedDbDetachedViewsStore(fakeFactory({ failOpen: true, openError: new Error('open boom') }));
    await expect(boom.get('x')).rejects.toThrow('open boom');
    const silent = createIndexedDbDetachedViewsStore(fakeFactory({ failOpen: true }));
    await expect(silent.get('x')).rejects.toThrow('IndexedDB open failed');
  });

  it('does not poison the store when an open fails — a same-session retry can reopen', async () => {
    const db = new FakeDB({});
    db.stores.set('views', new Map());
    let attempt = 0;
    const factory = {
      open() {
        const req = new FakeRequest();
        const failThis = attempt++ === 0;
        queueMicrotask(() => {
          if (failThis) { req.error = new Error('transient open'); req.onerror?.(); return; }
          req.result = db;
          req.onsuccess?.();
        });
        return req as unknown as IDBOpenDBRequest;
      },
    } as unknown as IDBFactory;
    const store = createIndexedDbDetachedViewsStore(factory);
    await expect(store.get('x')).rejects.toThrow('transient open');
    expect(await store.get('x')).toBeNull();
    expect(attempt).toBe(2);
  });

  it('rejects the open when it is blocked', async () => {
    const factory = {
      open() {
        const req = new FakeRequest();
        queueMicrotask(() => { (req as unknown as { onblocked?: () => void }).onblocked?.(); });
        return req as unknown as IDBOpenDBRequest;
      },
    } as unknown as IDBFactory;
    const store = createIndexedDbDetachedViewsStore(factory);
    await expect(store.get('x')).rejects.toThrow('IndexedDB open blocked');
  });

  it('rejects when the get request fails (with and without a request error)', async () => {
    const boom = createIndexedDbDetachedViewsStore(fakeFactory({ failGet: true, getError: new Error('get boom') }));
    await expect(boom.get('x')).rejects.toThrow('get boom');
    const silent = createIndexedDbDetachedViewsStore(fakeFactory({ failGet: true }));
    await expect(silent.get('x')).rejects.toThrow('IndexedDB request failed');
  });

  it('rejects a put when the pruning cursor read fails (with and without a request error)', async () => {
    const boom = createIndexedDbDetachedViewsStore(fakeFactory({ failCursor: true, cursorError: new Error('cursor boom') }));
    await expect(boom.put({ workspace: workspace('x'), savedAt: 1 })).rejects.toThrow('cursor boom');
    const silent = createIndexedDbDetachedViewsStore(fakeFactory({ failCursor: true }));
    await expect(silent.put({ workspace: workspace('y'), savedAt: 1 })).rejects.toThrow('IndexedDB request failed');
  });

  it('rejects a put when the transaction aborts or errors (with and without a tx error)', async () => {
    const aborted = createIndexedDbDetachedViewsStore(fakeFactory({ failTx: 'abort', txError: new Error('abort boom') }));
    await expect(aborted.put({ workspace: workspace('x'), savedAt: 1 })).rejects.toThrow('abort boom');
    const erroredSilently = createIndexedDbDetachedViewsStore(fakeFactory({ failTx: 'error' }));
    await expect(erroredSilently.put({ workspace: workspace('y'), savedAt: 1 })).rejects.toThrow('IndexedDB transaction failed');
    const abortedSilently = createIndexedDbDetachedViewsStore(fakeFactory({ failTx: 'abort' }));
    await expect(abortedSilently.put({ workspace: workspace('z'), savedAt: 1 })).rejects.toThrow('IndexedDB transaction aborted');
  });
});
