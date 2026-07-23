// Concrete IndexedDB adapter behind the injected `DetachedViewsStore` seam
// (#288 Phase 6 — VIEW-mode Dashboard handoff). Each detached view is a
// read-only snapshot of one Dashboard, keyed by its own fresh workspace id,
// stored in a DEDICATED database separate from the single shared primary
// `asb-workspaces-v2` collection — a detached view is not the editable primary
// workspace and must never be reachable through that store's key. Because
// "Open for viewing…" can be used repeatedly, this store is a small keyed
// collection with a retention cap (newest `maxRecords` by `savedAt`), unlike
// the primary store's single replaced record.
//
// Same adapter shape as `indexeddb-workspace-store.ts` (lazy cached `openDb`,
// `requestResult`, `transactionDone`, cache dropped on a failed open) — see
// that file for the seam-pattern rationale.

import type { DetachedViewRecord, DetachedViewsStore } from './detached-views-store.types.js';
import type { StoredWorkspaceV2 } from '../generated/json-schema.types.js';
import { normalizeWorkspaceKeyLookup } from '../core/workspace-key.js';

export interface IndexedDbDetachedViewsStoreOptions {
  /** IndexedDB database name. */
  dbName?: string;
  /** Object-store name inside the database. */
  storeName?: string;
  /** Retention cap: newest records (by `savedAt`) kept after each `put`. */
  maxRecords?: number;
}

const DEFAULTS = {
  dbName: 'asb-dashboard-views',
  storeName: 'views',
  maxRecords: 20,
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

interface StoredEntry { key: IDBValidKey; savedAt: number; }

// Prune the store to the newest `maxRecords` by `savedAt`, via one cursor walk.
// The stale deletes are issued INSIDE the cursor's terminal callback (where the
// full key+savedAt set is known and the transaction is still active) — never in
// an awaited continuation, which would let the transaction auto-commit first
// and make `delete` throw in a real browser. Records carry no index, and the
// retention cap keeps the store small enough for a full scan.
function pruneToCap(store: IDBObjectStore, maxRecords: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const entries: StoredEntry[] = [];
    const request = store.openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (cursor) {
        const record = cursor.value as DetachedViewRecord;
        entries.push({ key: cursor.key, savedAt: record.savedAt });
        cursor.continue();
        return;
      }
      if (entries.length > maxRecords) {
        const newestFirst = [...entries].sort((a, b) => b.savedAt - a.savedAt);
        for (const stale of newestFirst.slice(maxRecords)) store.delete(stale.key);
      }
      resolve();
    };
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

/** Build a `DetachedViewsStore` backed by IndexedDB. The database is opened
 *  lazily on first use (and the open promise cached), so constructing the
 *  store with a not-yet-available factory never throws — the failure
 *  surfaces only when an operation actually runs. */
export function createIndexedDbDetachedViewsStore(
  factory: IDBFactory | undefined, options: IndexedDbDetachedViewsStoreOptions = {},
): DetachedViewsStore {
  const dbName = options.dbName ?? DEFAULTS.dbName;
  const storeName = options.storeName ?? DEFAULTS.storeName;
  const maxRecords = options.maxRecords ?? DEFAULTS.maxRecords;
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
    // Cache only a SUCCESSFUL open; drop it on failure so a same-session
    // retry can reopen (matches the primary workspace store's contract).
    dbPromise = pending;
    pending.catch(() => { if (dbPromise === pending) dbPromise = null; });
    return pending;
  }

  async function put(record: DetachedViewRecord): Promise<void> {
    const db = await openDb();
    const tx = db.transaction([storeName], 'readwrite');
    const store = tx.objectStore(storeName);
    store.put(record, record.workspace.id);
    await pruneToCap(store, maxRecords);
    await transactionDone(tx);
  }

  async function get(id: string): Promise<StoredWorkspaceV2 | null> {
    const db = await openDb();
    const tx = db.transaction([storeName], 'readonly');
    const record = await requestResult<DetachedViewRecord | undefined>(tx.objectStore(storeName).get(id));
    return record ? record.workspace : null;
  }

  async function getByKey(key: string): Promise<StoredWorkspaceV2 | null> {
    const db = await openDb();
    const tx = db.transaction([storeName], 'readonly');
    const records = await requestResult<DetachedViewRecord[]>(tx.objectStore(storeName).getAll());
    const normalized = normalizeWorkspaceKeyLookup(key);
    return records.find((record) => record.workspace.key === normalized)?.workspace ?? null;
  }

  return { put, get, getByKey };
}
