// Dashboard query OWNERSHIP (#427). Every Dashboard panel or curated filter
// owns a dedicated saved-query copy; a query no Dashboard member references is a
// Library query. This module is the one definition of that partition.
//
// Ownership is DERIVED, never stored: the only inputs are
// `dashboards[].tiles[].queryId` and `dashboards[].filters[].sourceQueryId`.
// #427 forbids reverse ownership fields on `SavedQueryV2`/`QuerySpecV1`, because
// a stored back-pointer is a second source of truth that can disagree with the
// references it mirrors — and the references are what execution actually reads.
//
// Rules:
//   zero owners      -> Library query
//   exactly one      -> Dashboard-owned query
//   more than one    -> invalid after migration (`ownerOfQuery` refuses to pick)
//
// A reference to an id that no query in the collection carries is still an
// OWNER here — this module reports what the document says. Missing references
// stay a separate cross-resource diagnostic (`dashboard-tile-query-missing` /
// `filter-source-missing` in `workspace-semantics.ts`), so a dangling id
// deliberately lands in `ownersByQueryId` while joining NEITHER the Library nor
// the owned partition: both of those describe queries that exist.
//
// Pure — no DOM, no persistence, no signals, no injected services.

import { cloneJson, patchQueryDashboard, patchQuerySpec } from '../../core/saved-query.js';
import type { SavedQueryV2 } from '../../generated/json-schema.types.js';

/** Which Dashboard member owns a query, addressed the way #430 requires:
 *  by Dashboard id plus the member's own Dashboard-local id, never by query id
 *  and never by array position. */
export type DashboardQueryOwner =
  | { kind: 'panel'; dashboardId: string; tileId: string }
  | { kind: 'filter'; dashboardId: string; filterId: string };

/** The Dashboard role a clone is minted for. `setup`-role queries can never be
 *  Dashboard members (#427), so it is not a valid owner role. */
export type DashboardOwnerRole = 'panel' | 'filter';

export interface QueryOwnershipIndex {
  /** Every referenced query id -> its owners, in document order. Includes ids
   *  no query carries (see the module header). */
  ownersByQueryId: Map<string, DashboardQueryOwner[]>;
  /** Ids of queries that EXIST and have zero owners. */
  libraryQueryIds: Set<string>;
  /** Ids of queries that EXIST and have at least one owner. */
  dashboardOwnedQueryIds: Set<string>;
}

// ── Input shapes ────────────────────────────────────────────────────────────
// Structural, so both `StoredWorkspaceV4` and any later stored-workspace
// version satisfy them without this module tracking the storage version. The
// codec validates structure before any semantic layer runs, so these are the
// narrowest shapes ownership actually reads — not a loosened re-declaration of
// the whole document.

export interface OwnershipTile {
  id: string;
  queryId: string;
}

export interface OwnershipFilter {
  id: string;
  /** Absent on a plain filter (a free-text/date control with no option list),
   *  which owns nothing. Only a CURATED filter has a source query. */
  sourceQueryId?: string;
}

export interface OwnershipDashboard {
  id: string;
  tiles: readonly OwnershipTile[];
  filters: readonly OwnershipFilter[];
}

export interface OwnershipWorkspace {
  queries: readonly SavedQueryV2[];
  dashboards: readonly OwnershipDashboard[];
}

/** Thrown by `ownerOfQuery` for a query with more than one owner. #427 requires
 *  diagnosing that state rather than silently selecting one owner: picking would
 *  hand a caller an arbitrary Dashboard to mutate. Validation reports the same
 *  state as `dashboard-query-multiple-owners`; callers that may hold an
 *  unvalidated workspace use `ownersOfQuery` instead of catching this. */
export class MultipleOwnersError extends Error {
  readonly queryId: string;
  readonly owners: readonly DashboardQueryOwner[];

  constructor(queryId: string, owners: readonly DashboardQueryOwner[]) {
    super(`Query ${JSON.stringify(queryId)} has ${owners.length} Dashboard owners; exactly one is required`);
    this.name = 'MultipleOwnersError';
    this.queryId = queryId;
    this.owners = owners;
  }
}

/**
 * Index the whole workspace's ownership in one pass.
 *
 * Owner order is the document's own: Dashboards in collection order, and within
 * each Dashboard its FILTERS before its TILES. That is the same order #427's
 * migration walks members in, so `owners[0]` is the same member both here and
 * there — which is what lets validation report "every owner after the first"
 * deterministically.
 */
export function buildQueryOwnershipIndex(workspace: OwnershipWorkspace): QueryOwnershipIndex {
  const ownersByQueryId = new Map<string, DashboardQueryOwner[]>();
  const own = (queryId: string, owner: DashboardQueryOwner): void => {
    const owners = ownersByQueryId.get(queryId);
    if (owners) owners.push(owner);
    else ownersByQueryId.set(queryId, [owner]);
  };
  for (const dashboard of workspace.dashboards) {
    for (const filter of dashboard.filters) {
      // A plain filter has no source query and therefore owns nothing.
      if (filter.sourceQueryId === undefined) continue;
      own(filter.sourceQueryId, { kind: 'filter', dashboardId: dashboard.id, filterId: filter.id });
    }
    for (const tile of dashboard.tiles) {
      own(tile.queryId, { kind: 'panel', dashboardId: dashboard.id, tileId: tile.id });
    }
  }
  const libraryQueryIds = new Set<string>();
  const dashboardOwnedQueryIds = new Set<string>();
  for (const query of workspace.queries) {
    if (ownersByQueryId.has(query.id)) dashboardOwnedQueryIds.add(query.id);
    else libraryQueryIds.add(query.id);
  }
  return { ownersByQueryId, libraryQueryIds, dashboardOwnedQueryIds };
}

/** The Library projection: queries no Dashboard member references, in their
 *  original `workspace.queries[]` relative order. The lower sidebar renders
 *  exactly this (#427); owned copies stay serialized and stay openable by id,
 *  they are simply not Library entries. */
export function libraryQueries(workspace: OwnershipWorkspace): SavedQueryV2[] {
  const { libraryQueryIds } = buildQueryOwnershipIndex(workspace);
  return workspace.queries.filter((query) => libraryQueryIds.has(query.id));
}

/** Every owner of `queryId`, in document order — empty for a Library query.
 *  The non-throwing companion to `ownerOfQuery`, and what validation uses. */
export function ownersOfQuery(
  workspace: OwnershipWorkspace, queryId: string,
): DashboardQueryOwner[] {
  return buildQueryOwnershipIndex(workspace).ownersByQueryId.get(queryId) ?? [];
}

/** The single owner of `queryId`, or `null` when it is a Library query.
 *  Throws `MultipleOwnersError` when the workspace is in the invalid
 *  more-than-one-owner state rather than choosing one (#427). Exported for
 *  #428/#429, whose assignment and delete paths act on a validated workspace
 *  where the throw is unreachable; anything that may hold an unvalidated
 *  workspace should call `ownersOfQuery`. */
export function ownerOfQuery(
  workspace: OwnershipWorkspace, queryId: string,
): DashboardQueryOwner | null {
  const owners = ownersOfQuery(workspace, queryId);
  if (owners.length === 0) return null;
  if (owners.length > 1) throw new MultipleOwnersError(queryId, owners);
  return owners[0];
}

/**
 * Mint the dedicated copy one Dashboard member owns.
 *
 * Everything the source carries is preserved — SQL, spec version, name,
 * description, panel/presentation data, variants, size hints, time ranges and
 * unknown Spec fields — with exactly two deliberate differences:
 *
 *  - `spec.dashboard.role` is set to the owner's role, because a panel owner
 *    requires role `panel` and a filter owner role `filter`; sibling
 *    `spec.dashboard` fields are retained.
 *  - `spec.favorite` is REMOVED. After #427 a favourite is a Library
 *    preference with no membership meaning, so carrying one onto a copy that is
 *    absent from the Library would express nothing at all.
 *
 * `id` is supplied by the caller — this module never derives ids, so the
 * migration owns collision-safety across existing and newly minted ids.
 */
export function cloneQueryForDashboardOwner(input: {
  source: SavedQueryV2;
  newId: string;
  role: DashboardOwnerRole;
}): SavedQueryV2 {
  const roled = patchQueryDashboard(input.source, { role: input.role });
  const cleared = patchQuerySpec(roled, { favorite: undefined });
  return {
    ...cloneJson(input.source),
    id: input.newId,
    // `patchQuerySpec` rewrites `specVersion` to the version it writes; the
    // clone must carry the SOURCE's, so a future migration sees one document
    // version per query rather than a copy silently ahead of its original.
    specVersion: input.source.specVersion,
    spec: cleared.spec,
  };
}
