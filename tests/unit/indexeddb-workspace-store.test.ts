import { describe, expect, it } from 'vitest';
import { createIndexedDbWorkspaceStore } from '../../src/workspace/indexeddb-workspace-store.js';
import type { WorkspaceStoreRecord } from '../../src/workspace/workspace-store.types.js';

type Handler = (() => void) | null;

interface FakeConfig {
  failOpen?: boolean;
  blockOpen?: boolean;
  openError?: unknown;
  failRequest?: string;
  requestError?: unknown;
  silentRequestError?: boolean;
  failReadwriteTx?: 'error' | 'abort';
  txError?: unknown;
  silentTxError?: boolean;
}

class FakeRequest {
  result: unknown;
  error: unknown = null;
  onsuccess: Handler = null;
  onerror: Handler = null;
  onupgradeneeded: Handler = null;
  onblocked: Handler = null;
}

interface FakeStoreData {
  keyPath: string | null;
  values: Map<IDBValidKey, unknown>;
  indexes: Map<string, { keyPath: string; unique: boolean }>;
}

class FakeTransaction {
  error: DOMException | Error | null = null;
  oncomplete: Handler = null;
  onerror: Handler = null;
  onabort: Handler = null;
  private pending = 0;
  private settled = false;
  private completionQueued = false;
  private readonly snapshots = new Map<string, Map<IDBValidKey, unknown>>();
  private readonly db: FakeDatabase;
  private readonly names: string[];
  private readonly mode: IDBTransactionMode;
  private readonly config: FakeConfig;

  constructor(
    db: FakeDatabase,
    names: string[],
    mode: IDBTransactionMode,
    config: FakeConfig,
  ) {
    this.db = db;
    this.names = names;
    this.mode = mode;
    this.config = config;
    for (const name of names) {
      this.snapshots.set(name, new Map(db.stores.get(name)?.values));
    }
    this.queueCompletion();
  }

  objectStore(name: string): FakeObjectStore {
    if (!this.names.includes(name)) throw new Error(`Store ${name} is outside transaction`);
    return new FakeObjectStore(this, this.db.stores.get(name)!);
  }

  request(operation: string, action: () => unknown): FakeRequest {
    const request = new FakeRequest();
    this.pending += 1;
    queueMicrotask(() => {
      if (this.settled) return;
      try {
        if (this.config.failRequest === operation) {
          const failure = this.config.requestError ?? new Error(`${operation} failed`);
          if (this.config.silentRequestError) {
            request.error = null;
            request.onerror?.();
            this.abort(failure);
            return;
          }
          throw failure;
        }
        request.result = action();
        request.onsuccess?.();
      } catch (error) {
        request.error = error;
        request.onerror?.();
        this.abort(error);
      } finally {
        this.pending -= 1;
        this.queueCompletion();
      }
    });
    return request;
  }

  private queueCompletion(): void {
    if (this.completionQueued || this.settled) return;
    this.completionQueued = true;
    // IDB transactions remain active through promise microtasks scheduled by
    // request event handlers, and complete at the next event-loop boundary.
    setTimeout(() => {
      this.completionQueued = false;
      if (this.settled || this.pending !== 0) return;
      if (this.mode === 'readwrite' && this.config.failReadwriteTx) {
        const fallback = this.config.failReadwriteTx === 'abort'
          ? new Error('forced transaction abort')
          : new Error('forced transaction error');
        this.abort(this.config.txError ?? fallback, this.config.failReadwriteTx);
        return;
      }
      this.settled = true;
      this.oncomplete?.();
    }, 0);
  }

  private abort(error: unknown, event: 'abort' | 'error' = 'abort'): void {
    if (this.settled) return;
    this.settled = true;
    this.error = this.config.silentTxError
      ? null
      : error instanceof Error || error instanceof DOMException
        ? error
        : new Error('fake transaction failed');
    for (const [name, snapshot] of this.snapshots) {
      this.db.stores.get(name)!.values = new Map(snapshot);
    }
    queueMicrotask(() => {
      if (event === 'error') this.onerror?.();
      else this.onabort?.();
    });
  }
}

class FakeIndex {
  private readonly tx: FakeTransaction;
  private readonly data: FakeStoreData;
  private readonly keyPath: string;

  constructor(
    tx: FakeTransaction,
    data: FakeStoreData,
    keyPath: string,
  ) {
    this.tx = tx;
    this.data = data;
    this.keyPath = keyPath;
  }

  get(key: IDBValidKey): FakeRequest {
    return this.tx.request('index.get', () => (
      [...this.data.values.values()].find((value) => (
        (value as Record<string, unknown>)[this.keyPath] === key
      ))
    ));
  }
}

class FakeObjectStore {
  private readonly tx: FakeTransaction;
  private readonly data: FakeStoreData;

  constructor(
    tx: FakeTransaction,
    data: FakeStoreData,
  ) {
    this.tx = tx;
    this.data = data;
  }

  get(key: IDBValidKey): FakeRequest {
    return this.tx.request('get', () => this.data.values.get(key));
  }

  getAll(): FakeRequest {
    return this.tx.request('getAll', () => [...this.data.values.values()]);
  }

  add(value: unknown, explicitKey?: IDBValidKey): FakeRequest {
    return this.tx.request('add', () => {
      const key = this.resolveKey(value, explicitKey);
      if (this.data.values.has(key)) throw new DOMException('Duplicate id', 'ConstraintError');
      this.assertUniqueIndexes(value);
      this.data.values.set(key, value);
      return key;
    });
  }

  put(value: unknown, explicitKey?: IDBValidKey): FakeRequest {
    return this.tx.request('put', () => {
      const key = this.resolveKey(value, explicitKey);
      this.assertUniqueIndexes(value, key);
      this.data.values.set(key, value);
      return key;
    });
  }

  delete(key: IDBValidKey): FakeRequest {
    return this.tx.request('delete', () => {
      this.data.values.delete(key);
      return undefined;
    });
  }

  index(name: string): FakeIndex {
    const index = this.data.indexes.get(name);
    if (!index) throw new Error(`Missing index ${name}`);
    return new FakeIndex(this.tx, this.data, index.keyPath);
  }

  private resolveKey(value: unknown, explicitKey?: IDBValidKey): IDBValidKey {
    if (explicitKey !== undefined) return explicitKey;
    if (!this.data.keyPath) throw new Error('An explicit key is required');
    return (value as Record<string, IDBValidKey>)[this.data.keyPath];
  }

  private assertUniqueIndexes(value: unknown, replacingKey?: IDBValidKey): void {
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
  private readonly data: FakeStoreData;
  constructor(data: FakeStoreData) { this.data = data; }
  createIndex(name: string, keyPath: string, options?: IDBIndexParameters): FakeUpgradeObjectStore {
    this.data.indexes.set(name, { keyPath, unique: options?.unique ?? false });
    return this;
  }
}

class FakeDatabase {
  stores = new Map<string, FakeStoreData>();
  objectStoreNames = { contains: (name: string) => this.stores.has(name) };
  private readonly config: FakeConfig;

  constructor(config: FakeConfig) { this.config = config; }

  createObjectStore(name: string, options?: IDBObjectStoreParameters): FakeUpgradeObjectStore {
    const data: FakeStoreData = {
      keyPath: typeof options?.keyPath === 'string' ? options.keyPath : null,
      values: new Map(),
      indexes: new Map(),
    };
    this.stores.set(name, data);
    return new FakeUpgradeObjectStore(data);
  }

  transaction(names: string[], mode: IDBTransactionMode): FakeTransaction {
    return new FakeTransaction(this, names, mode, this.config);
  }
}

class FakeFactory {
  readonly config: FakeConfig;
  readonly databases = new Map<string, FakeDatabase>();
  openCount = 0;
  lastVersion: number | undefined;

  constructor(config: FakeConfig = {}) {
    this.config = config;
  }

  open(name: string, version?: number): IDBOpenDBRequest {
    this.openCount += 1;
    this.lastVersion = version;
    const request = new FakeRequest();
    queueMicrotask(() => {
      if (this.config.blockOpen) {
        request.onblocked?.();
        return;
      }
      if (this.config.failOpen) {
        request.error = this.config.openError ?? null;
        request.onerror?.();
        return;
      }
      let db = this.databases.get(name);
      const needsUpgrade = !db;
      if (!db) {
        db = new FakeDatabase(this.config);
        this.databases.set(name, db);
      }
      request.result = db;
      if (needsUpgrade) request.onupgradeneeded?.();
      request.onsuccess?.();
    });
    return request as unknown as IDBOpenDBRequest;
  }
}

const record = (
  id: string,
  key: string,
  text = `{"id":"${id}"}`,
  lastOpenedAt: number | null = null,
): WorkspaceStoreRecord => ({ id, key, text, lastOpenedAt });

describe('createIndexedDbWorkspaceStore', () => {
  it('creates independent records, lists them, and reopens the same database', async () => {
    const factory = new FakeFactory();
    const first = createIndexedDbWorkspaceStore(factory as unknown as IDBFactory);
    expect(await first.list()).toEqual([]);
    expect(await first.create(record('id-1', 'alpha'))).toEqual({ status: 'created' });
    expect(await first.create(record('id-2', 'beta'))).toEqual({ status: 'created' });
    expect(await first.list()).toEqual([record('id-1', 'alpha'), record('id-2', 'beta')]);
    expect(factory.openCount).toBe(1);

    const reopened = createIndexedDbWorkspaceStore(factory as unknown as IDBFactory);
    expect(await reopened.list()).toHaveLength(2);
    expect(factory.openCount).toBe(2);
    expect(factory.lastVersion).toBe(1);
  });

  it('looks up records independently by id and canonical key', async () => {
    const store = createIndexedDbWorkspaceStore(new FakeFactory() as unknown as IDBFactory);
    await store.create(record('id-1', 'alpha'));
    expect(await store.readById('id-1')).toEqual(record('id-1', 'alpha'));
    expect(await store.readByKey('alpha')).toEqual(record('id-1', 'alpha'));
    expect(await store.readById('missing')).toBeNull();
    expect(await store.readByKey('missing')).toBeNull();
  });

  it('reports duplicate ids and duplicate keys from atomic add constraints', async () => {
    const store = createIndexedDbWorkspaceStore(new FakeFactory() as unknown as IDBFactory);
    await store.create(record('id-1', 'alpha'));
    expect(await store.create(record('id-1', 'beta'))).toEqual({ status: 'duplicate-id' });
    expect(await store.create(record('id-2', 'alpha'))).toEqual({ status: 'duplicate-key' });
    expect(await store.list()).toEqual([record('id-1', 'alpha')]);
  });

  it('rejects an unexplained constraint and a non-constraint DOM failure', async () => {
    const constraintFactory = new FakeFactory({
      failRequest: 'add',
      requestError: new DOMException('unexpected constraint', 'ConstraintError'),
    });
    const constrained = createIndexedDbWorkspaceStore(constraintFactory as unknown as IDBFactory);
    await expect(constrained.create(record('id-1', 'alpha')))
      .rejects.toThrow('unexpected constraint');

    const abortFactory = new FakeFactory({
      failRequest: 'add',
      requestError: new DOMException('quota-ish', 'AbortError'),
    });
    const aborted = createIndexedDbWorkspaceStore(abortFactory as unknown as IDBFactory);
    await expect(aborted.create(record('id-1', 'alpha'))).rejects.toThrow('quota-ish');
  });

  it('replaces only an existing record with its immutable key', async () => {
    const store = createIndexedDbWorkspaceStore(new FakeFactory() as unknown as IDBFactory);
    await store.create(record('id-1', 'alpha', undefined, 7));
    expect(await store.replace(record('missing', 'alpha', 'new'))).toEqual({ status: 'not-found' });
    expect(await store.replace(record('id-1', 'renamed', 'new'))).toEqual({ status: 'immutable-key' });
    expect(await store.replace(record('id-1', 'alpha', 'new', 9))).toEqual({ status: 'replaced' });
    expect(await store.readById('id-1')).toEqual(record('id-1', 'alpha', 'new', 7));
  });

  it('deletes exactly one id, is idempotent, and clears only a matching preference', async () => {
    const store = createIndexedDbWorkspaceStore(new FakeFactory() as unknown as IDBFactory);
    await store.create(record('id-1', 'alpha'));
    await store.create(record('id-2', 'beta'));
    await store.markOpened('alpha', 1);
    expect(await store.delete('id-2')).toBe(true);
    expect(await store.getLastUsedKey()).toBe('alpha');
    expect(await store.delete('missing')).toBe(false);
    expect(await store.delete('id-1')).toBe(true);
    expect(await store.getLastUsedKey()).toBeNull();
    expect(await store.list()).toEqual([]);
  });

  it('marks an existing workspace opened and manages the last-used preference', async () => {
    const store = createIndexedDbWorkspaceStore(new FakeFactory() as unknown as IDBFactory);
    await store.create(record('id-1', 'alpha'));
    expect(await store.markOpened('missing', 4)).toEqual({ status: 'not-found' });
    expect(await store.getLastUsedKey()).toBeNull();
    expect(await store.markOpened('alpha', 123)).toEqual({ status: 'opened' });
    expect(await store.readByKey('alpha')).toEqual(record('id-1', 'alpha', undefined, 123));
    expect(await store.getLastUsedKey()).toBe('alpha');
    await store.clearLastUsedKey();
    expect(await store.getLastUsedKey()).toBeNull();
  });

  it('rolls back record and preference changes when a transaction fails', async () => {
    const factory = new FakeFactory();
    const store = createIndexedDbWorkspaceStore(factory as unknown as IDBFactory);
    await store.create(record('id-1', 'alpha'));
    await store.markOpened('alpha', 10);

    factory.config.failReadwriteTx = 'abort';
    factory.config.txError = new Error('disk full');
    await expect(store.delete('id-1')).rejects.toThrow('disk full');
    factory.config.failReadwriteTx = undefined;
    expect(await store.readById('id-1')).toEqual(record('id-1', 'alpha', undefined, 10));
    expect(await store.getLastUsedKey()).toBe('alpha');
  });

  it('rejects environmental request and transaction failures with fallback errors', async () => {
    const requestFactory = new FakeFactory({ failRequest: 'get' });
    const requestStore = createIndexedDbWorkspaceStore(requestFactory as unknown as IDBFactory);
    await expect(requestStore.readById('x')).rejects.toThrow('get failed');

    const silentRequestFactory = new FakeFactory({
      failRequest: 'get',
      silentRequestError: true,
    });
    const silentRequestStore = createIndexedDbWorkspaceStore(
      silentRequestFactory as unknown as IDBFactory,
    );
    await expect(silentRequestStore.readById('x')).rejects.toThrow('IndexedDB request failed');

    const txFactory = new FakeFactory({
      failReadwriteTx: 'error',
      silentTxError: true,
    });
    const txStore = createIndexedDbWorkspaceStore(txFactory as unknown as IDBFactory);
    await expect(txStore.clearLastUsedKey()).rejects.toThrow('IndexedDB transaction failed');

    txFactory.config.failReadwriteTx = 'abort';
    await expect(txStore.clearLastUsedKey()).rejects.toThrow('IndexedDB transaction aborted');
  });

  it('rejects unavailable/open failures and retries after failed or blocked opens', async () => {
    const unavailable = createIndexedDbWorkspaceStore(undefined);
    await expect(unavailable.list()).rejects.toThrow('IndexedDB is unavailable');

    const factory = new FakeFactory({ failOpen: true, openError: new Error('open boom') });
    const store = createIndexedDbWorkspaceStore(factory as unknown as IDBFactory);
    await expect(store.list()).rejects.toThrow('open boom');
    factory.config.failOpen = false;
    expect(await store.list()).toEqual([]);

    const blockedFactory = new FakeFactory({ blockOpen: true });
    const blocked = createIndexedDbWorkspaceStore(blockedFactory as unknown as IDBFactory);
    await expect(blocked.list()).rejects.toThrow('IndexedDB open blocked');
    blockedFactory.config.blockOpen = false;
    expect(await blocked.list()).toEqual([]);
    expect(blockedFactory.openCount).toBe(2);
  });

  it('uses fallback errors and honors custom database/store/index names', async () => {
    const silentOpen = createIndexedDbWorkspaceStore(
      new FakeFactory({ failOpen: true }) as unknown as IDBFactory,
    );
    await expect(silentOpen.list()).rejects.toThrow('IndexedDB open failed');

    const factory = new FakeFactory();
    const store = createIndexedDbWorkspaceStore(factory as unknown as IDBFactory, {
      dbName: 'custom-db',
      workspaceStoreName: 'custom-workspaces',
      preferenceStoreName: 'custom-preferences',
      keyIndexName: 'custom-key-index',
    });
    await store.create(record('id-1', 'alpha'));
    expect(await store.readByKey('alpha')).toEqual(record('id-1', 'alpha'));
    expect(factory.databases.has('custom-db')).toBe(true);
  });
});
