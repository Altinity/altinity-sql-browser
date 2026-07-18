// Concrete IndexedDB adapter behind the injected `HandoffStore` seam (#288
// Dashboard view-mode handoff). Structured exactly like
// `indexeddb-workspace-store.ts` (lazy cached `openDb`, `requestResult`,
// `transactionDone`, cache dropped on a failed open) but backed by its OWN
// dedicated database — never the `asb-workspace` DB — since a handoff token
// is a short-lived, one-time-consumed record with its own lifecycle, unlike
// the workspace aggregate's single-record replace-whole-thing semantics.
//
// The `IDBFactory` is injected the same way as the workspace store, so tests
// drive this with a minimal in-memory fake factory instead of a real browser
// database.

import type { HandoffRecord, HandoffStore } from './handoff-store.types.js';

export interface IndexedDbHandoffStoreOptions {
  /** IndexedDB database name. */
  dbName?: string;
  /** Object-store name inside the database. */
  storeName?: string;
}

const DEFAULTS = {
  dbName: 'asb-dashboard-handoff',
  storeName: 'handoff',
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

/** Build a `HandoffStore` backed by IndexedDB. The database is opened lazily
 *  on first use (and the open promise cached), so constructing the store with
 *  a not-yet-available factory never throws — the failure surfaces only when
 *  an operation actually runs, where the caller catches it. */
export function createIndexedDbHandoffStore(
  factory: IDBFactory | undefined, options: IndexedDbHandoffStoreOptions = {},
): HandoffStore {
  const dbName = options.dbName ?? DEFAULTS.dbName;
  const storeName = options.storeName ?? DEFAULTS.storeName;
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
    // Cache only a SUCCESSFUL open — a rejected open must not poison the
    // store for the page's lifetime; drop the cached promise on failure so a
    // same-session retry can reopen.
    dbPromise = pending;
    pending.catch(() => { if (dbPromise === pending) dbPromise = null; });
    return pending;
  }

  async function put(token: string, record: HandoffRecord): Promise<void> {
    const db = await openDb();
    const tx = db.transaction([storeName], 'readwrite');
    // growth note: `put` deliberately does not sweep expired records (no
    // cursor scan here). A handoff token is single-use and short-lived by
    // construction — the only paths that remove a record are `take`
    // (consumed) or the browser evicting the whole origin's IndexedDB under
    // storage pressure. Unconsumed-token growth is therefore bounded by how
    // often a view-mode link is generated and then abandoned before ever
    // being opened, not by ordinary app traffic — acceptable for this leaf,
    // minimal adapter (kept 100%-coverable rather than adding an unexercised
    // sweep branch).
    tx.objectStore(storeName).put(record, token);
    await transactionDone(tx);
  }

  async function take(token: string, nowMs: number): Promise<HandoffRecord | null> {
    const db = await openDb();
    const tx = db.transaction([storeName], 'readwrite');
    const store = tx.objectStore(storeName);
    // Issue BOTH the get and the delete synchronously while the transaction is
    // still active — NEVER `await` between them. Awaiting a request mid-txn lets
    // the transaction auto-commit (it goes inactive when control yields with no
    // pending request), so the paired `delete` would throw
    // `TransactionInactiveError` in a real browser. Awaiting the get's result
    // *after* both requests are queued is safe — the pending delete keeps the
    // transaction alive — and a get-request error still rejects here.
    const getReq = store.get(token);
    store.delete(token);
    const record = await requestResult<HandoffRecord | undefined>(getReq);
    await transactionDone(tx);
    return record && record.expiresAt > nowMs ? record : null;
  }

  return { put, take };
}
