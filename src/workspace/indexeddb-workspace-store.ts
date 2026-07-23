import type {
  WorkspaceStore,
  WorkspaceStoreCreateResult,
  WorkspaceStoreMarkOpenedResult,
  WorkspaceStoreRecord,
  WorkspaceStoreReplaceResult,
} from './workspace-store.types.js';

export interface IndexedDbWorkspaceStoreOptions {
  dbName?: string;
  workspaceStoreName?: string;
  preferenceStoreName?: string;
  keyIndexName?: string;
}

const DEFAULTS = {
  dbName: 'asb-workspaces-v2',
  workspaceStoreName: 'workspaces',
  preferenceStoreName: 'preferences',
  keyIndexName: 'by-key',
} as const;
const LAST_USED_KEY = 'last-used-key';

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

function isConstraintError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'ConstraintError';
}

export function createIndexedDbWorkspaceStore(
  factory: IDBFactory | undefined,
  options: IndexedDbWorkspaceStoreOptions = {},
): WorkspaceStore {
  const dbName = options.dbName ?? DEFAULTS.dbName;
  const workspaceStoreName = options.workspaceStoreName ?? DEFAULTS.workspaceStoreName;
  const preferenceStoreName = options.preferenceStoreName ?? DEFAULTS.preferenceStoreName;
  const keyIndexName = options.keyIndexName ?? DEFAULTS.keyIndexName;
  let dbPromise: Promise<IDBDatabase> | null = null;

  function openDb(): Promise<IDBDatabase> {
    if (dbPromise) return dbPromise;
    const pending = new Promise<IDBDatabase>((resolve, reject) => {
      if (!factory) {
        reject(new Error('IndexedDB is unavailable'));
        return;
      }
      const request = factory.open(dbName, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        db.createObjectStore(workspaceStoreName, { keyPath: 'id' })
          .createIndex(keyIndexName, 'key', { unique: true });
        db.createObjectStore(preferenceStoreName);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'));
      request.onblocked = () => reject(new Error('IndexedDB open blocked'));
    });
    dbPromise = pending;
    pending.catch(() => { dbPromise = null; });
    return pending;
  }

  async function list(): Promise<WorkspaceStoreRecord[]> {
    const db = await openDb();
    const tx = db.transaction([workspaceStoreName], 'readonly');
    return requestResult(
      tx.objectStore(workspaceStoreName).getAll() as IDBRequest<WorkspaceStoreRecord[]>,
    );
  }

  async function readById(id: string): Promise<WorkspaceStoreRecord | null> {
    const db = await openDb();
    const tx = db.transaction([workspaceStoreName], 'readonly');
    const value = await requestResult(
      tx.objectStore(workspaceStoreName).get(id) as IDBRequest<WorkspaceStoreRecord | undefined>,
    );
    return value ?? null;
  }

  async function readByKey(key: string): Promise<WorkspaceStoreRecord | null> {
    const db = await openDb();
    const tx = db.transaction([workspaceStoreName], 'readonly');
    const value = await requestResult(
      tx.objectStore(workspaceStoreName).index(keyIndexName).get(key) as
        IDBRequest<WorkspaceStoreRecord | undefined>,
    );
    return value ?? null;
  }

  async function create(record: WorkspaceStoreRecord): Promise<WorkspaceStoreCreateResult> {
    const db = await openDb();
    const tx = db.transaction([workspaceStoreName], 'readwrite');
    const done = transactionDone(tx);
    try {
      await requestResult(tx.objectStore(workspaceStoreName).add(record));
      await done;
      return { status: 'created' };
    } catch (error) {
      await done.catch(() => undefined);
      if (!isConstraintError(error)) throw error;
      // The unique index and keyPath performed the atomic enforcement. These
      // post-failure reads only turn its ConstraintError into a useful outcome.
      if (await readById(record.id)) return { status: 'duplicate-id' };
      if (await readByKey(record.key)) return { status: 'duplicate-key' };
      throw error;
    }
  }

  async function replace(record: WorkspaceStoreRecord): Promise<WorkspaceStoreReplaceResult> {
    const db = await openDb();
    const tx = db.transaction([workspaceStoreName], 'readwrite');
    const done = transactionDone(tx);
    const objectStore = tx.objectStore(workspaceStoreName);
    const existing = await requestResult(
      objectStore.get(record.id) as IDBRequest<WorkspaceStoreRecord | undefined>,
    );
    if (!existing) {
      await done;
      return { status: 'not-found' };
    }
    if (existing.key !== record.key) {
      await done;
      return { status: 'immutable-key' };
    }
    objectStore.put({ ...record, lastOpenedAt: existing.lastOpenedAt });
    await done;
    return { status: 'replaced' };
  }

  async function deleteWorkspace(id: string): Promise<boolean> {
    const db = await openDb();
    const tx = db.transaction([workspaceStoreName, preferenceStoreName], 'readwrite');
    const done = transactionDone(tx);
    const workspaceStore = tx.objectStore(workspaceStoreName);
    const preferenceStore = tx.objectStore(preferenceStoreName);
    const existing = await requestResult(
      workspaceStore.get(id) as IDBRequest<WorkspaceStoreRecord | undefined>,
    );
    if (!existing) {
      await done;
      return false;
    }
    workspaceStore.delete(id);
    const lastUsed = await requestResult(preferenceStore.get(LAST_USED_KEY));
    if (lastUsed === existing.key) preferenceStore.delete(LAST_USED_KEY);
    await done;
    return true;
  }

  async function getLastUsedKey(): Promise<string | null> {
    const db = await openDb();
    const tx = db.transaction([preferenceStoreName], 'readonly');
    const value = await requestResult(tx.objectStore(preferenceStoreName).get(LAST_USED_KEY));
    return typeof value === 'string' ? value : null;
  }

  async function markOpened(
    key: string,
    timestamp: number,
  ): Promise<WorkspaceStoreMarkOpenedResult> {
    const db = await openDb();
    const tx = db.transaction([workspaceStoreName, preferenceStoreName], 'readwrite');
    const done = transactionDone(tx);
    const workspaceStore = tx.objectStore(workspaceStoreName);
    const existing = await requestResult(
      workspaceStore.index(keyIndexName).get(key) as
        IDBRequest<WorkspaceStoreRecord | undefined>,
    );
    if (!existing) {
      await done;
      return { status: 'not-found' };
    }
    workspaceStore.put({ ...existing, lastOpenedAt: timestamp });
    tx.objectStore(preferenceStoreName).put(key, LAST_USED_KEY);
    await done;
    return { status: 'opened' };
  }

  async function clearLastUsedKey(): Promise<void> {
    const db = await openDb();
    const tx = db.transaction([preferenceStoreName], 'readwrite');
    tx.objectStore(preferenceStoreName).delete(LAST_USED_KEY);
    await transactionDone(tx);
  }

  return {
    list,
    readById,
    readByKey,
    create,
    replace,
    delete: deleteWorkspace,
    getLastUsedKey,
    markOpened,
    clearLastUsedKey,
  };
}
