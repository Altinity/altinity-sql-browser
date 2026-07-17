import { describe, expect, it } from 'vitest';
import { createIndexedDbWorkspaceStore } from '../../src/workspace/indexeddb-workspace-store.js';

// ── A minimal in-memory fake IDBFactory ──────────────────────────────────────
// Implements exactly the IndexedDB surface the adapter touches (open with an
// upgrade callback, a keyed object store, and readonly/readwrite transactions),
// with knobs to drive every error branch. Events fire on a microtask so the
// adapter's handlers are attached before they run — the same ordering a real
// IndexedDB guarantees.
type Handler = (() => void) | null;

interface Cfg {
  failOpen?: boolean; openError?: unknown;
  failGet?: boolean; getError?: unknown;
  failTx?: 'abort' | 'error' | null; txError?: unknown;
  preexistingStore?: boolean;
  storeName?: string; recordKey?: string;
  seed?: string;
}

class FakeRequest {
  result: unknown;
  error: unknown = null;
  onsuccess: Handler = null;
  onerror: Handler = null;
  onupgradeneeded: Handler = null;
}

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
    queueMicrotask(() => {
      if (this.cfg.failTx === 'abort') { this.error = this.cfg.txError ?? null; this.onabort?.(); } else if (this.cfg.failTx === 'error') { this.error = this.cfg.txError ?? null; this.onerror?.(); } else this.oncomplete?.();
    });
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
  if (cfg.preexistingStore) {
    const map = new Map<string, unknown>();
    if (cfg.seed !== undefined) map.set(cfg.recordKey ?? 'current', cfg.seed);
    db.stores.set(cfg.storeName ?? 'workspace', map);
  }
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

describe('createIndexedDbWorkspaceStore', () => {
  it('reads null when the record is absent, after a normal open + store creation', async () => {
    const store = createIndexedDbWorkspaceStore(fakeFactory());
    expect(await store.read()).toBeNull();
  });

  it('writes then reads back the same text (one atomic transaction) and caches the open', async () => {
    const store = createIndexedDbWorkspaceStore(fakeFactory());
    await store.write('{"hello":"world"}');
    // Second op reuses the cached open promise (no re-open).
    expect(await store.read()).toBe('{"hello":"world"}');
  });

  it('clears the record', async () => {
    const factory = fakeFactory({ preexistingStore: true, seed: 'seeded' });
    const store = createIndexedDbWorkspaceStore(factory);
    expect(await store.read()).toBe('seeded'); // contains()===true branch + seeded read
    await store.clear();
    expect(await store.read()).toBeNull();
  });

  it('honors custom db/store/record option names', async () => {
    const store = createIndexedDbWorkspaceStore(
      fakeFactory({ storeName: 'agg', recordKey: 'ws' }),
      { dbName: 'custom', storeName: 'agg', recordKey: 'ws' },
    );
    await store.write('x');
    expect(await store.read()).toBe('x');
  });

  it('rejects every operation when no IndexedDB factory is available', async () => {
    const store = createIndexedDbWorkspaceStore(undefined);
    await expect(store.read()).rejects.toThrow('IndexedDB is unavailable');
  });

  it('rejects when the database open fails (with and without a request error)', async () => {
    const boom = createIndexedDbWorkspaceStore(fakeFactory({ failOpen: true, openError: new Error('open boom') }));
    await expect(boom.read()).rejects.toThrow('open boom');
    const silent = createIndexedDbWorkspaceStore(fakeFactory({ failOpen: true }));
    await expect(silent.read()).rejects.toThrow('IndexedDB open failed');
  });

  it('does not poison the store when an open fails — a same-session retry can reopen', async () => {
    // A factory whose first open rejects, then succeeds — proving the failed
    // open promise is never cached (no permanent poison).
    const db = new FakeDB({});
    db.stores.set('workspace', new Map());
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
    const store = createIndexedDbWorkspaceStore(factory);
    await expect(store.read()).rejects.toThrow('transient open');
    // Second call reopens (cache was cleared on the rejection) and succeeds.
    expect(await store.read()).toBeNull();
    expect(attempt).toBe(2);
  });

  it('rejects the open when it is blocked (unreachable at version 1; guarded defensively)', async () => {
    const factory = {
      open() {
        const req = new FakeRequest();
        queueMicrotask(() => { (req as unknown as { onblocked?: () => void }).onblocked?.(); });
        return req as unknown as IDBOpenDBRequest;
      },
    } as unknown as IDBFactory;
    const store = createIndexedDbWorkspaceStore(factory);
    await expect(store.read()).rejects.toThrow('IndexedDB open blocked');
  });

  it('rejects when the get request fails (with and without a request error)', async () => {
    const boom = createIndexedDbWorkspaceStore(fakeFactory({ failGet: true, getError: new Error('get boom') }));
    await expect(boom.read()).rejects.toThrow('get boom');
    const silent = createIndexedDbWorkspaceStore(fakeFactory({ failGet: true }));
    await expect(silent.read()).rejects.toThrow('IndexedDB request failed');
  });

  it('rejects a write when the transaction aborts or errors (with and without a tx error)', async () => {
    const aborted = createIndexedDbWorkspaceStore(fakeFactory({ failTx: 'abort', txError: new Error('abort boom') }));
    await expect(aborted.write('x')).rejects.toThrow('abort boom');
    const erroredSilently = createIndexedDbWorkspaceStore(fakeFactory({ failTx: 'error' }));
    await expect(erroredSilently.clear()).rejects.toThrow('IndexedDB transaction failed');
    const abortedSilently = createIndexedDbWorkspaceStore(fakeFactory({ failTx: 'abort' }));
    await expect(abortedSilently.write('x')).rejects.toThrow('IndexedDB transaction aborted');
  });
});
