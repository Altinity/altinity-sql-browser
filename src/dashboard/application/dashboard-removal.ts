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
import { queryDashboardRole } from '../model/workspace-semantics.js';
import type { DashboardDocumentV2, StoredWorkspaceV5 } from '../../generated/json-schema.types.js';

/** Why a single-panel delete refused, as a value rather than a thrown error —
 *  every one of these is an ordinary concurrent-state or data-integrity
 *  outcome, never a bug, and the UI phrases each differently. */
export type PanelRemovalRefusal =
  | 'dashboard-missing'
  | 'dashboard-duplicate'
  | 'tile-missing'
  /** Two tiles carry this id, or two query documents do. An ambiguous id is
   *  never resolved by picking one: `tiles.filter(id !== target)` would take
   *  BOTH tiles out, and the query filter would drop both documents. */
  | 'tile-duplicate'
  /** The tile no longer references the query the caller captured — it was
   *  re-pointed while the confirmation was open. The caller confirmed removing
   *  a specific panel's specific query copy; this is a different one now. */
  | 'tile-retargeted'
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
  /** The query the CALLER resolved when it built the confirmation. Re-checked
   *  against the tile's own reference below rather than trusted: it is what
   *  the user was told would be deleted. */
  queryId: string;
}): PanelRemovalResult {
  const { workspace, dashboardId, tileId, queryId } = input;

  const lookup = findDashboardStrict(workspace, dashboardId);
  if (lookup.status !== 'ok') {
    return { status: 'refused', reason: lookup.status === 'missing' ? 'dashboard-missing' : 'dashboard-duplicate' };
  }
  const dashboard = lookup.dashboard;

  // Exactly one match, the same rule `findDashboardStrict` applies one level
  // up. The removal below is a `filter` by id, so an ambiguous id would take
  // out every match — which is precisely why this refuses instead.
  const tiles = dashboard.tiles.filter((candidate) => candidate.id === tileId);
  if (tiles.length === 0) return { status: 'refused', reason: 'tile-missing' };
  if (tiles.length > 1) return { status: 'refused', reason: 'tile-duplicate' };
  const tile = tiles[0];

  // The tile still has to reference the query the caller confirmed. Both the
  // before and after states of a re-pointed tile are perfectly valid, so
  // nothing else in this transform would notice.
  if (tile.queryId !== queryId) return { status: 'refused', reason: 'tile-retargeted' };

  const matching = workspace.queries.filter((query) => query.id === queryId);
  if (matching.length > 1) return { status: 'refused', reason: 'tile-duplicate' };
  const owners = ownersOfQuery(workspace, queryId);
  // Owned by exactly this tile, and a PANEL query — the role the tile
  // contract requires. A Setup- or other-role reference is malformed data
  // (`dashboard-setup-reference` / `dashboard-tile-role-incompatible`), and
  // deleting it here would silently "repair" the workspace by destroying the
  // evidence, which #494's fail-closed rule forbids.
  if (matching.length === 0 || owners.length !== 1
    || queryDashboardRole(matching[0]) !== 'panel') {
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

/**
 * Why `removeDashboardPanel` would refuse this target right now, or `null` when
 * it would go through.
 *
 * A DRY RUN of the transform itself rather than a second derivation of its
 * rules. A caller that LISTS "Remove tile" before it is pressed has to know
 * whether the operation is available — #494's rule is that a control must not
 * open a confirmation only to refuse at the end of it — and the only way to
 * answer that without drift is to ask the transform. Discarding a candidate
 * workspace is cheap next to a wrong answer: the transform is pure and builds
 * its ownership index over the same collections a re-derivation would have to
 * walk anyway.
 *
 * The refusal is still re-proven inside `mutateWorkspace` at commit time
 * (`commitPanelRemoval`) against committed truth. This is the availability
 * question, never the authorization one.
 */
export function panelRemovalRefusal(
  input: Parameters<typeof removeDashboardPanel>[0],
): PanelRemovalRefusal | null {
  const result = removeDashboardPanel(input);
  return result.status === 'refused' ? result.reason : null;
}

export type DashboardRemovalResult =
  | { status: 'ok'; workspace: StoredWorkspaceV5; removedQueryIds: readonly string[] }
  | { status: 'refused'; reason: 'dashboard-missing' | 'dashboard-duplicate' };

/**
 * Remove ONE whole Dashboard document and, recursively, the queries its own
 * tiles own — the document-level counterpart to `removeDashboardPanel` above.
 *
 * A tile's `queryId` joins the delete set only when ALL of these hold: exactly
 * one query document carries it, every owner `ownersOfQuery` reports for it
 * belongs to THIS Dashboard, and it is a PANEL query. The second half is what protects the
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
    // An id carried by two query documents is ambiguous: the removal is a
    // filter, so deleting "it" would delete both. Keep them, and let the
    // Dashboard go without them — an orphaned copy is recoverable, a
    // destroyed one is not.
    const documents = workspace.queries.filter((query) => query.id === queryId);
    if (documents.length > 1) continue;
    // Same rule the single-panel delete applies: only a PANEL query is a
    // dedicated copy this Dashboard may take with it. A tile referencing a
    // Setup- or other-role query is malformed data, and destroying that query
    // as a side effect of removing the Dashboard would be the cascade #494's
    // fail-closed rule forbids — it survives as a Library query instead.
    if (queryDashboardRole(documents[0]) !== 'panel') continue;

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
