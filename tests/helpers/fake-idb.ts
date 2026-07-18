// A minimal, always-succeeding in-memory fake `IDBFactory` (#287 W4). Not
// under src/, so it does not count toward coverage.
//
// Real `createApp(env)`-based fixtures (app.test.ts's `env()`) inject this by
// default so `app.workspace.commit` — the seam every saved-query CRUD op now
// awaits — actually persists under happy-dom, which has no real `indexedDB`.
// Without it every commit would reject with a `workspace-persist-failed`
// diagnostic (see `indexeddb-workspace-store.ts`'s `openDb` — a missing
// factory rejects the open), so every save/rename/favorite/delete flow driven
// through the real app would silently do nothing.
//
// Mirrors `indexeddb-workspace-store.test.ts`'s own richer local `fakeFactory`
// (which adds per-call error-injection knobs this generic, always-succeeds
// fixture doesn't need) and `dashboard.test.ts`'s own local `fakeIndexedDb`
// (same shape, kept separate there since it predates this shared helper).
type Handler = (() => void) | null;

class FakeRequest {
  result: unknown;
  error: unknown = null;
  onsuccess: Handler = null;
  onerror: Handler = null;
  onupgradeneeded: Handler = null;
}

class FakeObjectStore {
  data: Map<string, unknown>;
  constructor(data: Map<string, unknown>) { this.data = data; }
  get(key: string): FakeRequest {
    const req = new FakeRequest();
    queueMicrotask(() => { req.result = this.data.get(key); req.onsuccess?.(); });
    return req;
  }
  put(value: unknown, key: string): FakeRequest { this.data.set(key, value); return new FakeRequest(); }
  delete(key: string): FakeRequest { this.data.delete(key); return new FakeRequest(); }
}

class FakeTx {
  oncomplete: Handler = null;
  onerror: Handler = null;
  onabort: Handler = null;
  db: FakeDB;
  constructor(db: FakeDB) {
    this.db = db;
    queueMicrotask(() => this.oncomplete?.());
  }
  objectStore(name: string): FakeObjectStore { return new FakeObjectStore(this.db.stores.get(name)!); }
}

class FakeDB {
  stores = new Map<string, Map<string, unknown>>();
  objectStoreNames = { contains: (n: string): boolean => this.stores.has(n) };
  createObjectStore(name: string): void { this.stores.set(name, new Map()); }
  transaction(_names: string[], _mode: string): FakeTx { return new FakeTx(this); }
}

/** A fresh always-succeeding fake `IDBFactory` — one independent in-memory
 *  database per call (construct one per test/app unless deliberately sharing
 *  across several `createApp()` calls in the same test). */
export function fakeIndexedDbFactory(): IDBFactory {
  const db = new FakeDB();
  return {
    open(_name: string, _version?: number) {
      const req = new FakeRequest();
      queueMicrotask(() => {
        req.result = db;
        req.onupgradeneeded?.();
        req.onsuccess?.();
      });
      return req as unknown as IDBOpenDBRequest;
    },
  } as unknown as IDBFactory;
}
