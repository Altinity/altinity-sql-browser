// The injected persistence seam for the multi-workspace repository (#406).
// Persisted workspace content is an opaque canonical JSON string. Store-owned
// metadata stays outside that JSON so opening a workspace does not dirty its
// portable aggregate.

export interface WorkspaceStoreRecord {
  readonly id: string;
  /** Canonical lowercase workspace key; callers validate before persistence. */
  readonly key: string;
  readonly text: string;
  readonly lastOpenedAt: number | null;
}

export type WorkspaceStoreCreateResult =
  | { readonly status: 'created' }
  | { readonly status: 'duplicate-id' }
  | { readonly status: 'duplicate-key' };

export type WorkspaceStoreReplaceResult =
  | { readonly status: 'replaced' }
  | { readonly status: 'not-found' }
  | { readonly status: 'immutable-key' };

export type WorkspaceStoreMarkOpenedResult =
  | { readonly status: 'opened' }
  | { readonly status: 'not-found' };

export interface WorkspaceStore {
  list(): Promise<WorkspaceStoreRecord[]>;
  readById(id: string): Promise<WorkspaceStoreRecord | null>;
  readByKey(key: string): Promise<WorkspaceStoreRecord | null>;

  /** Atomically add a workspace. Both `id` and canonical `key` are unique. */
  create(record: WorkspaceStoreRecord): Promise<WorkspaceStoreCreateResult>;

  /** Replace content only when `id` exists and its key is unchanged. The
   * store preserves its current `lastOpenedAt` metadata atomically. */
  replace(record: WorkspaceStoreRecord): Promise<WorkspaceStoreReplaceResult>;

  /** Delete exactly one workspace. Resolves false when `id` did not exist. */
  delete(id: string): Promise<boolean>;

  getLastUsedKey(): Promise<string | null>;

  /** Atomically stamp the workspace and make it the last-used preference. */
  markOpened(key: string, timestamp: number): Promise<WorkspaceStoreMarkOpenedResult>;

  clearLastUsedKey(): Promise<void>;
}
