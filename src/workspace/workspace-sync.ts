// Cross-tab workspace-consistency helpers (#343). Pure — no DOM, no globals,
// no side effects. These are the snapshot-identity tokens and the linked-tab
// classifier the mutation primitive (src/ui/app.ts) and the Workbench/Dashboard
// refresh paths use to decide, over the LATEST committed workspace, what each
// stale tab should do.
//
// Home: this lives in `src/workspace/` (not `src/core/`) deliberately. It reuses
// the canonical codecs (`encodeStoredWorkspaceJson`, `canonicalJson`) as the one
// snapshot-identity source, and the established module-graph direction is
// `workspace/ → core/` (and `workspace/ → dashboard/model/`), never the reverse:
// no module under `src/core/` imports `src/workspace/`. Putting this helper in
// `core/` would have reversed that (core → workspace → core), so it belongs
// beside the codecs it wraps. Still pure — same testability contract as core.

import { encodeStoredWorkspaceJson } from './stored-workspace.js';
import { canonicalJson, SAVED_QUERY_SHAPE } from '../dashboard/model/canonical-json.js';
import type { SavedQueryV2, StoredWorkspaceV1 } from '../generated/json-schema.types.js';

/** Snapshot-identity token for a whole workspace (or its absence). Two
 *  workspaces produce the same token iff they are canonically equal, so a tab
 *  can cheaply tell whether a reloaded record actually changed anything. `null`
 *  (no persisted workspace) tokens to `''`; a committed workspace always
 *  encodes cleanly, but a would-be-invalid one also collapses to `''` (never
 *  throws — this is an equality probe, not a validator). Not repository CAS. */
export function workspaceToken(ws: StoredWorkspaceV1 | null): string {
  if (ws === null) return '';
  const encoded = encodeStoredWorkspaceJson(ws);
  return encoded.ok ? encoded.value : '';
}

/** Canonical snapshot-identity token for ONE saved query — the per-query change
 *  probe a linked tab compares against its last-committed version. */
export function queryToken(q: SavedQueryV2): string {
  return canonicalJson(q, SAVED_QUERY_SHAPE);
}

/** Whether the two query collections differ (positional, content-sensitive):
 *  a different length, or any query whose canonical token moved. Drives the
 *  Dashboard's "a query-only external change must still rebuild the session even
 *  when the Dashboard document is byte-identical" rule (#343 §9). */
export function queriesChanged(
  prev: readonly SavedQueryV2[], latest: readonly SavedQueryV2[],
): boolean {
  if (prev.length !== latest.length) return true;
  for (let i = 0; i < prev.length; i++) {
    if (queryToken(prev[i]) !== queryToken(latest[i])) return true;
  }
  return false;
}

/** What a stale linked tab should do once the latest committed workspace is
 *  known:
 *  - `adopt`   — clean tab, its saved query still exists and changed externally;
 *  - `conflict`— dirty tab, its saved query changed externally;
 *  - `detach`  — clean tab, its saved query was deleted externally;
 *  - `orphan`  — dirty tab, its saved query was deleted externally;
 *  - `noop`    — nothing to do (unsaved tab, or the saved query is unchanged). */
export type TabReconcileAction = 'adopt' | 'conflict' | 'detach' | 'orphan' | 'noop';

/** Structural, state-free view of one tab the classifier needs — supplied by
 *  `state.ts` without this module ever importing `QueryTab`/`AppState`. A tab is
 *  "clean" when `!dirtySql && !dirtySpec`; "changed" when its saved query's
 *  latest token differs from `lastCommittedQueryToken` (the token captured the
 *  last time this tab was in sync with the committed query). */
export interface LinkedTabSnapshot {
  id: string;
  savedId: string | null;
  dirtySql: boolean;
  dirtySpec: boolean;
  lastCommittedQueryToken: string;
}

export interface TabReconcilePlan {
  tabId: string;
  action: TabReconcileAction;
  /** The latest committed query for `adopt`/`conflict`; absent otherwise. */
  query?: SavedQueryV2;
}

/** Classify every tab against the latest committed workspace (`null` = nothing
 *  persisted, so every linked query counts as deleted). Pure: returns one plan
 *  per input tab, in order, and applies no mutation. */
export function reconcileLinkedTabs(
  latest: StoredWorkspaceV1 | null, tabs: readonly LinkedTabSnapshot[],
): TabReconcilePlan[] {
  const queries = latest ? latest.queries : [];
  return tabs.map((tab) => {
    if (tab.savedId === null) return { tabId: tab.id, action: 'noop' as const };
    const clean = !tab.dirtySql && !tab.dirtySpec;
    const query = queries.find((q) => q.id === tab.savedId);
    if (!query) {
      return { tabId: tab.id, action: clean ? 'detach' as const : 'orphan' as const };
    }
    if (queryToken(query) === tab.lastCommittedQueryToken) {
      return { tabId: tab.id, action: 'noop' as const };
    }
    return { tabId: tab.id, action: clean ? 'adopt' as const : 'conflict' as const, query };
  });
}
