// The injected persistence seam for detached VIEW-mode Dashboard snapshots
// (#288 Phase 6 handoff). A detached view is a read-only copy of a Dashboard
// materialized into its own store under a fresh workspace id — distinct from
// the shared primary `asb-workspaces-v2` collection (`WorkspaceStore`).
// Many records may accumulate over time (one per "Open for viewing…"), so
// unlike the primary store this seam is a small keyed collection with a
// retention cap, not a single aggregate record.
//
// Type-only (ADR-0002 seam contract) — no executable statements, excluded
// from the coverage gate like every other `*.types.ts`.
import type { StoredWorkspaceV2 } from '../generated/json-schema.types.js';

export interface DetachedViewRecord {
  workspace: StoredWorkspaceV2;
  savedAt: number;
}

export interface DetachedViewsStore {
  /** Persist a detached read-only workspace snapshot, keyed by
   *  `record.workspace.id`. After writing, prune the store to the newest
   *  `maxRecords` (by `savedAt`) so it cannot grow unbounded. */
  put(record: DetachedViewRecord): Promise<void>;
  /** Load one detached workspace by id, or `null` when absent. */
  get(id: string): Promise<StoredWorkspaceV2 | null>;
  /** Load one detached workspace by its canonical URL key. */
  getByKey(key: string): Promise<StoredWorkspaceV2 | null>;
}
