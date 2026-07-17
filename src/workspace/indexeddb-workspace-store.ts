// Concrete IndexedDB adapter behind the injected `WorkspaceStore` seam (#280
// Phase 2 / issue #284). This is the one place a real IndexedDB is touched;
// the repository/migration logic never sees it. The pinned Phase-2 decision:
// persist the StoredWorkspaceV1 aggregate as a SINGLE record and replace it
// atomically via ONE readwrite transaction (IndexedDB was chosen over a single
// localStorage key because a 10 MiB `maxDecodedJsonBytes` aggregate exceeds the
// ~5 MB localStorage origin quota, and because Phase 6's cross-tab token
// handoff needs IndexedDB anyway).
//
// The `IDBFactory` is injected (createApp resolves `env.indexedDB` /
// `win.indexedDB`), so tests drive this with a minimal in-memory fake factory
// instead of a real browser database — the same seam pattern as fetch/crypto.

import type { WorkspaceStore } from './workspace-store.types.js';

export interface IndexedDbWorkspaceStoreOptions {
  /** IndexedDB database name. */
  dbName?: string;
  /** Object-store name inside the database. */
  storeName?: string;
  /** Fixed key of the single aggregate record. */
  recordKey?: string;
}

const DEFAULTS = {
  dbName: 'asb-workspace',
  storeName: 'workspace',
  recordKey: 'current',
} as const;

// Promisify one IDBRequest.
function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

// Resolve when a readwrite transaction durably completes (the atomicity point).
function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

/** Build a `WorkspaceStore` backed by IndexedDB. The database is opened lazily
 *  on first use (and the open promise cached), so constructing the store with a
 *  not-yet-available factory never throws — the failure surfaces only when an
 *  operation actually runs, where the repository catches it. */
export function createIndexedDbWorkspaceStore(
  factory: IDBFactory | undefined, options: IndexedDbWorkspaceStoreOptions = {},
): WorkspaceStore {
  const dbName = options.dbName ?? DEFAULTS.dbName;
  const storeName = options.storeName ?? DEFAULTS.storeName;
  const recordKey = options.recordKey ?? DEFAULTS.recordKey;
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
        if (!db.objectStoreNames.contains(storeName)) db.createObjectStore(storeName);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'));
      // Dormant at version 1 (no upgrade can block a fresh open), but an
      // unhandled `blocked` event would hang the open forever — reject so the
      // no-cache-on-failure path below reopens on the next call.
      request.onblocked = () => reject(new Error('IndexedDB open blocked'));
    });
    // Cache only a SUCCESSFUL open. A rejected open must not poison the store
    // for the page's lifetime (one createApp() builds one long-lived store):
    // drop the cached promise on failure so a same-session retry can reopen,
    // matching the repository's "failed write leaves a draft to retry" contract.
    dbPromise = pending;
    pending.catch(() => { if (dbPromise === pending) dbPromise = null; });
    return pending;
  }

  async function read(): Promise<string | null> {
    const db = await openDb();
    const tx = db.transaction([storeName], 'readonly');
    const value = await requestResult(tx.objectStore(storeName).get(recordKey));
    return typeof value === 'string' ? value : null;
  }

  async function write(text: string): Promise<void> {
    const db = await openDb();
    const tx = db.transaction([storeName], 'readwrite');
    tx.objectStore(storeName).put(text, recordKey);
    await transactionDone(tx);
  }

  async function clear(): Promise<void> {
    const db = await openDb();
    const tx = db.transaction([storeName], 'readwrite');
    tx.objectStore(storeName).delete(recordKey);
    await transactionDone(tx);
  }

  return { read, write, clear };
}
