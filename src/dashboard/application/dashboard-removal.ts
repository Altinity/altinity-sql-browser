// Dashboard/panel DELETE, atomically (#429/#494).
//
// #427 made Dashboard membership an explicit reference a tile OWNS: a panel
// tile's `queryId` names a dedicated copy that exists nowhere else. Deleting a
// tile or a whole Dashboard therefore has to delete the queries that copy
// represents too, or the Library would silently accumulate orphaned "owned"
// copies that are no longer reachable from anywhere and no longer Library
// entries either (#427's own partition: zero owners is what MAKES a query a
// Library query).
//
// Both transforms here PROVE ownership through the #427 index
// (`ownersOfQuery`) before deleting anything, rather than assuming a tile's
// `queryId` is safe to remove because it looks like the tile's own copy. The
// index is the one place that can tell a genuinely dedicated copy apart from
// the invalid states a workspace can still be caught in mid-edit — a second
// reference to the same id, or a reference to an id nothing carries any more.
// Guessing in either state and deleting anyway would either destroy a query
// another Dashboard still renders, or silently no-op while claiming success.
// Neither transform ever cascades past what it can prove: the single-panel
// delete refuses instead of picking an owner, and the whole-Dashboard delete
// keeps a query the invalid multi-owner state also points at from elsewhere.
//
// `dashboard.variableConfigs` is left untouched by a panel delete on purpose.
// #457 made a variable's identity and type come from the `{name:Type}`
// placeholders its panel queries declare, not from a stored object — so an
// orphaned configuration (a name no panel declares any more) is designed to
// survive and keep displaying, exactly the way a panel's last declaration
// disappearing through an ordinary SQL edit already leaves it. Deleting the
// tile is not a special case of that, and #494's own non-goals say so
// explicitly: the configuration is not a side effect to clean up here.
//
// Pure — no DOM, no persistence, no globals, never mutates its input.

import { removeTileMembership } from './tile-membership.js';
import type { TileRemovalResult } from './tile-membership.js';
import { findDashboardStrict, replaceDashboard } from '../../workspace/workspace-dashboards.js';
import { buildQueryOwnershipIndex, ownersOfQuery } from '../model/query-ownership.js';
import type { DashboardDocumentV2, StoredWorkspaceV5 } from '../../generated/json-schema.types.js';

/** Why a single-panel delete refused, as a value rather than a thrown error —
 *  every one of these is an ordinary concurrent-state or data-integrity
 *  outcome, never a bug, and the UI phrases each differently. */
export type PanelRemovalRefusal =
  | 'dashboard-missing'
  | 'dashboard-duplicate'
  | 'tile-missing'
  | 'ownership-unproven';

export type PanelRemovalResult =
  | { status: 'ok'; workspace: StoredWorkspaceV5; queryId: string }
  | { status: 'refused'; reason: PanelRemovalRefusal };

/**
 * Remove ONE Dashboard panel tile and exactly the dedicated query it owns, in
 * one atomic commit.
 *
 * Resolution is entirely id-addressed, matching `findDashboardStrict`'s own
 * rule: `dashboard-missing`/`dashboard-duplicate` refuse before anything else
 * is even looked at, because an ambiguous-id workspace must never be written
 * through a guess at which entry was meant.
 *
 * Ownership is PROVEN, not assumed: the tile's `queryId` must both name a
 * query that still exists in `workspace.queries`, and have EXACTLY ONE owner
 * in the #427 index. A dangling id, a query with no owners left after some
 * other edit, or — the invalid state #427 forbids reaching but this cannot
 * assume away — more than one owner, all refuse `ownership-unproven` rather
 * than deleting the tile alone and leaving a stray query behind, or deleting a
 * query some other tile still renders. The sole owner is never re-checked
 * against `dashboardId`/`tileId` by hand: `ownersOfQuery` is built by scanning
 * every tile of `workspace.dashboards` including this very one, so whenever it
 * reports exactly one owner for this tile's own `queryId`, that owner IS this
 * Dashboard and this tile — there is no second identity for a single-owner
 * result to disagree with.
 *
 * The tile itself is removed through `removeTileMembership`, which already
 * normalizes through the active layout plugin and regenerates the
 * grafana-grid flow fallback — neither is reimplemented here. The target
 * Dashboard's `revision` is bumped by exactly one; every other Dashboard,
 * every other query, and both collections' order are preserved exactly.
 */
export function removeDashboardPanel(input: {
  workspace: StoredWorkspaceV5;
  dashboardId: string;
  tileId: string;
}): PanelRemovalResult {
  const { workspace, dashboardId, tileId } = input;

  const lookup = findDashboardStrict(workspace, dashboardId);
  if (lookup.status !== 'ok') {
    return { status: 'refused', reason: lookup.status === 'missing' ? 'dashboard-missing' : 'dashboard-duplicate' };
  }
  const dashboard = lookup.dashboard;

  const tile = dashboard.tiles.find((candidate) => candidate.id === tileId);
  if (!tile) return { status: 'refused', reason: 'tile-missing' };

  const { queryId } = tile;
  const queryExists = workspace.queries.some((query) => query.id === queryId);
  const owners = ownersOfQuery(workspace, queryId);
  if (!queryExists || owners.length !== 1) {
    return { status: 'refused', reason: 'ownership-unproven' };
  }

  // `removeTileMembership` returns `null` only for a tile id it cannot find in
  // `dashboard.tiles` — already excluded by the `tile` lookup above, so this
  // cast reflects a genuinely unreachable branch rather than skipping a check.
  const removed = removeTileMembership(dashboard, workspace.queries, tileId) as TileRemovalResult;
  const nextDashboard: DashboardDocumentV2 = { ...removed.dashboard, revision: dashboard.revision + 1 };
  const nextQueries = workspace.queries.filter((query) => query.id !== queryId);
  const withQueries: StoredWorkspaceV5 = { ...workspace, queries: nextQueries };

  // `replaceDashboard` re-checks the exactly-one-match rule at write time, but
  // `withQueries` only changed `queries` — `dashboards` is the same reference
  // `lookup` already resolved to `ok` above, so `null` here is unreachable too.
  const next = replaceDashboard(withQueries, dashboardId, nextDashboard) as StoredWorkspaceV5;

  return { status: 'ok', workspace: next, queryId };
}

export type DashboardRemovalResult =
  | { status: 'ok'; workspace: StoredWorkspaceV5; removedQueryIds: readonly string[] }
  | { status: 'refused'; reason: 'dashboard-missing' | 'dashboard-duplicate' };

/**
 * Remove ONE whole Dashboard document and, recursively, the queries its own
 * tiles own — the document-level counterpart to `removeDashboardPanel` above.
 *
 * A tile's `queryId` joins the delete set only when BOTH hold: the query
 * still exists in `workspace.queries`, and every owner `ownersOfQuery` reports
 * for it belongs to THIS Dashboard. The second half is what protects the
 * invalid multi-owner state (a query some other Dashboard's tile also
 * references) rather than trusting that this Dashboard's own reference is the
 * only one — deleting a query another Dashboard still renders would trade one
 * data-integrity problem for a worse one. A query with no owners at all
 * (Library) never reaches this check because it is never named by one of this
 * Dashboard's own tiles in the first place. Ids repeated across this
 * Dashboard's own tiles are deduplicated, and the result is reported in tile
 * order.
 *
 * There is no revision bump: the document that carried a revision is gone.
 * Every other Dashboard, every other query, and both collections' order are
 * preserved exactly.
 */
export function removeDashboardDocument(input: {
  workspace: StoredWorkspaceV5;
  dashboardId: string;
}): DashboardRemovalResult {
  const { workspace, dashboardId } = input;

  const lookup = findDashboardStrict(workspace, dashboardId);
  if (lookup.status !== 'ok') {
    return { status: 'refused', reason: lookup.status === 'missing' ? 'dashboard-missing' : 'dashboard-duplicate' };
  }
  const dashboard = lookup.dashboard;

  // One index for the whole walk: `ownersOfQuery` rebuilds it per call, and a
  // Dashboard's tiles are exactly the ids being asked about.
  const { ownersByQueryId, dashboardOwnedQueryIds } = buildQueryOwnershipIndex(workspace);
  const removedQueryIds: string[] = [];
  const considered = new Set<string>();
  for (const tile of dashboard.tiles) {
    const { queryId } = tile;
    if (considered.has(queryId)) continue;
    considered.add(queryId);

    // `dashboardOwnedQueryIds` holds only ids that EXIST and have an owner, so
    // it answers the dangling-reference case as well.
    if (!dashboardOwnedQueryIds.has(queryId)) continue;

    // Present by construction: `dashboardOwnedQueryIds` is exactly the ids
    // `ownersByQueryId` carries an owner list for.
    const ownedOnlyHere = ownersByQueryId.get(queryId)!
      .every((owner) => owner.dashboardId === dashboardId);
    if (ownedOnlyHere) removedQueryIds.push(queryId);
  }

  const removeSet = new Set(removedQueryIds);
  const next: StoredWorkspaceV5 = {
    ...workspace,
    dashboards: workspace.dashboards.filter((candidate) => candidate.id !== dashboardId),
    queries: workspace.queries.filter((query) => !removeSet.has(query.id)),
  };

  return { status: 'ok', workspace: next, removedQueryIds };
}
