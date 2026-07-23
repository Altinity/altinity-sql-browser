// Always-succeeding in-memory IndexedDB for createApp-based tests. It models
// the collection features used by the workspace, detached-view, and handoff
// adapters: database-scoped stores, key paths, unique indexes, getAll/add, and
// transactions that stay active through request-handler promise microtasks.
type Handler = (() => void) | null;

class FakeRequest {
  result: unknown;
  error: unknown = null;
  onsuccess: Handler = null;
  onerror: Handler = null;
  onupgradeneeded: Handler = null;
}

interface StoreData {
  keyPath: string | null;
  values: Map<IDBValidKey, unknown>;
  indexes: Map<string, { keyPath: string; unique: boolean }>;
}

class FakeTransaction {
  error: Error | null = null;
  oncomplete: Handler = null;
  onerror: Handler = null;
  onabort: Handler = null;
  private pending = 0;
  private completionQueued = false;
  private settled = false;
  private readonly db: FakeDB;
  private readonly names: string[];

  constructor(db: FakeDB, names: string[]) {
    this.db = db;
    this.names = names;
    this.queueCompletion();
  }

  objectStore(name: string): FakeObjectStore {
    if (!this.names.includes(name)) throw new Error(`Store ${name} is outside transaction`);
    const data = this.db.stores.get(name);
    if (!data) throw new Error(`Unknown store ${name}`);
    return new FakeObjectStore(this, data);
  }

  request(action: () => unknown): FakeRequest {
    const request = new FakeRequest();
    this.pending += 1;
    queueMicrotask(() => {
      try {
        request.result = action();
        request.onsuccess?.();
      } catch (error) {
        request.error = error;
        request.onerror?.();
        this.settled = true;
        this.error = error instanceof Error ? error : new Error(String(error));
        queueMicrotask(() => this.onabort?.());
      } finally {
        this.pending -= 1;
        this.queueCompletion();
      }
    });
    return request;
  }

  cursor(data: StoreData): FakeRequest {
    const request = new FakeRequest();
    const entries = [...data.values.entries()];
    let position = 0;
    this.pending += 1;
    const advance = (): void => {
      queueMicrotask(() => {
        const entry = entries[position++];
        if (entry) {
          request.result = {
            key: entry[0],
            value: entry[1],
            continue: advance,
          };
        } else {
          request.result = null;
          this.pending -= 1;
          this.queueCompletion();
        }
        request.onsuccess?.();
      });
    };
    advance();
    return request;
  }

  private queueCompletion(): void {
    if (this.completionQueued || this.settled) return;
    this.completionQueued = true;
    setTimeout(() => {
      this.completionQueued = false;
      if (this.pending !== 0 || this.settled) return;
      this.settled = true;
      this.oncomplete?.();
    }, 0);
  }
}

class FakeIndex {
  private readonly tx: FakeTransaction;
  private readonly data: StoreData;
  private readonly keyPath: string;

  constructor(tx: FakeTransaction, data: StoreData, keyPath: string) {
    this.tx = tx;
    this.data = data;
    this.keyPath = keyPath;
  }

  get(key: IDBValidKey): FakeRequest {
    return this.tx.request(() => (
      [...this.data.values.values()].find((value) => (
        (value as Record<string, unknown>)[this.keyPath] === key
      ))
    ));
  }
}

class FakeObjectStore {
  private readonly tx: FakeTransaction;
  private readonly data: StoreData;

  constructor(tx: FakeTransaction, data: StoreData) {
    this.tx = tx;
    this.data = data;
  }

  get(key: IDBValidKey): FakeRequest {
    return this.tx.request(() => this.data.values.get(key));
  }

  getAll(): FakeRequest {
    return this.tx.request(() => [...this.data.values.values()]);
  }

  add(value: unknown, explicitKey?: IDBValidKey): FakeRequest {
    return this.tx.request(() => {
      const key = this.resolveKey(value, explicitKey);
      if (this.data.values.has(key)) throw new DOMException('Duplicate key', 'ConstraintError');
      this.assertUnique(value);
      this.data.values.set(key, value);
      return key;
    });
  }

  put(value: unknown, explicitKey?: IDBValidKey): FakeRequest {
    return this.tx.request(() => {
      const key = this.resolveKey(value, explicitKey);
      this.assertUnique(value, key);
      this.data.values.set(key, value);
      return key;
    });
  }

  delete(key: IDBValidKey): FakeRequest {
    return this.tx.request(() => {
      this.data.values.delete(key);
      return undefined;
    });
  }

  index(name: string): FakeIndex {
    const index = this.data.indexes.get(name);
    if (!index) throw new Error(`Unknown index ${name}`);
    return new FakeIndex(this.tx, this.data, index.keyPath);
  }

  openCursor(): FakeRequest {
    return this.tx.cursor(this.data);
  }

  private resolveKey(value: unknown, explicitKey?: IDBValidKey): IDBValidKey {
    if (explicitKey !== undefined) return explicitKey;
    if (!this.data.keyPath) throw new Error('Explicit key required');
    return (value as Record<string, IDBValidKey>)[this.data.keyPath];
  }

  private assertUnique(value: unknown, replacingKey?: IDBValidKey): void {
    for (const index of this.data.indexes.values()) {
      if (!index.unique) continue;
      const indexedValue = (value as Record<string, unknown>)[index.keyPath];
      for (const [key, current] of this.data.values) {
        if (key !== replacingKey
          && (current as Record<string, unknown>)[index.keyPath] === indexedValue) {
          throw new DOMException('Duplicate index', 'ConstraintError');
        }
      }
    }
  }
}

class FakeUpgradeObjectStore {
  private readonly data: StoreData;
  constructor(data: StoreData) { this.data = data; }

  createIndex(name: string, keyPath: string, options?: IDBIndexParameters): FakeUpgradeObjectStore {
    this.data.indexes.set(name, { keyPath, unique: options?.unique ?? false });
    return this;
  }
}

class FakeDB {
  stores = new Map<string, StoreData>();
  objectStoreNames = { contains: (name: string): boolean => this.stores.has(name) };

  createObjectStore(name: string, options?: IDBObjectStoreParameters): FakeUpgradeObjectStore {
    if (this.stores.has(name)) throw new DOMException('Store exists', 'ConstraintError');
    const data: StoreData = {
      keyPath: typeof options?.keyPath === 'string' ? options.keyPath : null,
      values: new Map(),
      indexes: new Map(),
    };
    this.stores.set(name, data);
    return new FakeUpgradeObjectStore(data);
  }

  transaction(names: string[], _mode: IDBTransactionMode): FakeTransaction {
    return new FakeTransaction(this, names);
  }
}

/** A fresh fake factory. Database names remain isolated, while multiple apps
 * constructed with the same factory reopen and share each named database. */
export function fakeIndexedDbFactory(): IDBFactory {
  const databases = new Map<string, FakeDB>();
  return {
    open(name: string, _version?: number) {
      const request = new FakeRequest();
      queueMicrotask(() => {
        let db = databases.get(name);
        const needsUpgrade = !db;
        if (!db) {
          db = new FakeDB();
          databases.set(name, db);
        }
        request.result = db;
        if (needsUpgrade) request.onupgradeneeded?.();
        request.onsuccess?.();
      });
      return request as unknown as IDBOpenDBRequest;
    },
  } as unknown as IDBFactory;
}
