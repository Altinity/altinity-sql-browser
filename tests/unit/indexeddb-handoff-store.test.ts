import { describe, expect, it } from 'vitest';
import { createIndexedDbHandoffStore } from '../../src/workspace/indexeddb-handoff-store.js';
import type { HandoffRecord } from '../../src/workspace/handoff-store.types.js';

// ── A minimal in-memory fake IDBFactory ──────────────────────────────────────
// Same shape as `tests/unit/indexeddb-workspace-store.test.ts`'s fake (open
// with an upgrade callback, a keyed object store, readonly/readwrite
// transactions, knobs to drive every error branch) — reused here rather than
// invented from scratch.
//
// One deliberate difference: the transaction's completion event fires via a
// macrotask (`setTimeout`) instead of a microtask. `take()` issues the `get`
// and `delete` synchronously (never awaiting between them — a real transaction
// would auto-commit at the await and the paired delete would throw), then
// awaits the `get`'s *result* before attaching `transactionDone`'s `oncomplete`
// handler. That await is a microtask hop, so a microtask-scheduled completion
// event (as in the workspace-store fake, whose ops are purely synchronous
// between open and `transactionDone`) would fire and find no listener attached
// yet. A macrotask always runs after the microtask queue fully drains, so it
// reliably lands after any number of chained awaits — mirroring how a real
// IndexedDB transaction stays alive across microtask continuations while
// requests are pending.
type Handler = (() => void) | null;

interface Cfg {
  failOpen?: boolean; openError?: unknown;
  failGet?: boolean; getError?: unknown;
  failTx?: 'abort' | 'error' | null; txError?: unknown;
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

class FakeObjectStore {
  data: Map<string, unknown>;
  cfg: Cfg;
  constructor(data: Map<string, unknown>, cfg: Cfg) { this.data = data; this.cfg = cfg; }
  get(key: string): FakeRequest {
    const req = new FakeRequest();
    // Snapshot the value at request time (like a real IndexedDB request, which
    // is enqueued and processed in order): `take` issues `get` then `delete`
    // synchronously, so a lazily-read value would see the post-delete state.
    const snapshot = this.data.get(key);
    queueMicrotask(() => {
      if (this.cfg.failGet) { req.error = this.cfg.getError ?? null; req.onerror?.(); } else {
        req.result = snapshot;
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
  if (cfg.preexistingStore) db.stores.set(cfg.storeName ?? 'handoff', new Map());
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

function record(overrides: Partial<HandoffRecord> = {}): HandoffRecord {
  return {
    text: '{"bundle":true}',
    dashboardId: 'dash-1',
    detachedWorkspaceId: 'ws-detached-1',
    expiresAt: Date.now() + 60_000,
    ...overrides,
  };
}

describe('createIndexedDbHandoffStore', () => {
  it('put then take returns the record, and a second take returns null (one-time consumption)', async () => {
    const store = createIndexedDbHandoffStore(fakeFactory());
    const rec = record();
    await store.put('tok-1', rec);
    expect(await store.take('tok-1', Date.now())).toEqual(rec);
    // The record was deleted by the first take — a second take (same token
    // reusing the cached open) returns null.
    expect(await store.take('tok-1', Date.now())).toBeNull();
  });

  it('returns null for an expired record and deletes it (a subsequent take is also null)', async () => {
    const store = createIndexedDbHandoffStore(fakeFactory());
    const rec = record({ expiresAt: 1_000 });
    await store.put('tok-2', rec);
    expect(await store.take('tok-2', 2_000)).toBeNull();
    expect(await store.take('tok-2', 2_000)).toBeNull();
  });

  it('returns null for a missing token', async () => {
    const store = createIndexedDbHandoffStore(fakeFactory());
    expect(await store.take('never-put', Date.now())).toBeNull();
  });

  it('rejects put and take when no IndexedDB factory is available', async () => {
    const store = createIndexedDbHandoffStore(undefined);
    await expect(store.put('tok', record())).rejects.toThrow('IndexedDB is unavailable');
    await expect(store.take('tok', Date.now())).rejects.toThrow('IndexedDB is unavailable');
  });

  it('rejects when the database open fails (with and without a request error)', async () => {
    const boom = createIndexedDbHandoffStore(fakeFactory({ failOpen: true, openError: new Error('open boom') }));
    await expect(boom.put('tok', record())).rejects.toThrow('open boom');
    const silent = createIndexedDbHandoffStore(fakeFactory({ failOpen: true }));
    await expect(silent.take('tok', Date.now())).rejects.toThrow('IndexedDB open failed');
  });

  it('rejects when the open is blocked', async () => {
    const factory = {
      open() {
        const req = new FakeRequest();
        queueMicrotask(() => { (req as unknown as { onblocked?: () => void }).onblocked?.(); });
        return req as unknown as IDBOpenDBRequest;
      },
    } as unknown as IDBFactory;
    const store = createIndexedDbHandoffStore(factory);
    await expect(store.take('tok', Date.now())).rejects.toThrow('IndexedDB open blocked');
  });

  it('does not poison the store when an open fails — a same-session retry can reopen', async () => {
    const db = new FakeDB({});
    db.stores.set('handoff', new Map());
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
    const store = createIndexedDbHandoffStore(factory);
    await expect(store.take('tok', Date.now())).rejects.toThrow('transient open');
    expect(await store.take('tok', Date.now())).toBeNull();
    expect(attempt).toBe(2);
  });

  it('rejects when the get request fails (with and without a request error)', async () => {
    const boom = createIndexedDbHandoffStore(fakeFactory({ failGet: true, getError: new Error('get boom') }));
    await expect(boom.take('tok', Date.now())).rejects.toThrow('get boom');
    const silent = createIndexedDbHandoffStore(fakeFactory({ failGet: true }));
    await expect(silent.take('tok', Date.now())).rejects.toThrow('IndexedDB request failed');
  });

  it('rejects put/take when the transaction aborts or errors (with and without a tx error)', async () => {
    const aborted = createIndexedDbHandoffStore(fakeFactory({ failTx: 'abort', txError: new Error('abort boom') }));
    await expect(aborted.put('tok', record())).rejects.toThrow('abort boom');
    const erroredSilently = createIndexedDbHandoffStore(fakeFactory({ failTx: 'error' }));
    await expect(erroredSilently.take('tok', Date.now())).rejects.toThrow('IndexedDB transaction failed');
    const abortedSilently = createIndexedDbHandoffStore(fakeFactory({ failTx: 'abort' }));
    await expect(abortedSilently.put('tok', record())).rejects.toThrow('IndexedDB transaction aborted');
  });

  it('honors custom db/store option names and a pre-existing store (contains()===true branch)', async () => {
    const store = createIndexedDbHandoffStore(
      fakeFactory({ storeName: 'agg', preexistingStore: true }),
      { dbName: 'custom-handoff', storeName: 'agg' },
    );
    const rec = record();
    await store.put('tok-x', rec);
    expect(await store.take('tok-x', Date.now())).toEqual(rec);
  });
});
