// Wire the Workbench favorite star to Dashboard tile membership (#299).
// `StoredWorkspaceV1.dashboard.tiles[]` is canonical Dashboard membership
// (#287); toggling `spec.favorite` on a saved query must add/remove the
// matching tile IN THE SAME atomic commit as the favorite flip, or the star
// and the Dashboard silently disagree about what's on it.
//
// The role gate mirrors the migration precedent in
// `src/workspace/legacy-migration.ts`'s `buildLegacyMigrationCandidate`: only
// PANEL-role queries ever become tiles — a favorited filter/setup-role query
// stays favorited (the star's own visual state) but never gets a tile. Tile
// removal mirrors `src/dashboard/application/saved-query-mutation.ts`'s
// `removeAffectedTiles`: every tile referencing the query is dropped, and
// those tile ids are scrubbed out of every filter's `targets[]` too.
//
// Pure — no DOM, no persistence; the caller (state.ts's `toggleFavorite`)
// folds the result into the same commit candidate as the favorite patch.

import { queryDashboardRole } from '../model/workspace-semantics.js';
import { flowLayoutPlugin } from '../layouts/flow-layout.js';
import type { DashboardDocumentV1, SavedQueryV2 } from '../../generated/json-schema.types.js';

/** Remove every tile referencing `queryId`, and scrub those tile ids out of
 *  every filter's `targets` — the typed counterpart of saved-query-mutation.ts's
 *  `removeAffectedTiles` (that one operates on unknown/untyped documents). */
function removeTilesForQuery(dashboard: DashboardDocumentV1, queryId: string): DashboardDocumentV1 {
  const removed = new Set(
    dashboard.tiles.filter((tile) => tile.queryId === queryId).map((tile) => tile.id),
  );
  const tiles = dashboard.tiles.filter((tile) => tile.queryId !== queryId);
  const filters = dashboard.filters.map((filter) => (
    filter.targets
      ? { ...filter, targets: filter.targets.filter((target) => !removed.has(target)) }
      : filter
  ));
  return { ...dashboard, tiles, filters };
}

/**
 * Reflect a Workbench favorite flip onto Dashboard tile membership (#299).
 *
 * - Star ON + panel-role query + no existing tile referencing it → append one
 *   tile `{ id: genTileId(), queryId: query.id }`.
 * - Star ON + a tile already references it → unchanged (idempotent).
 * - Star ON + filter/setup-role query → unchanged (favorite flip only; never
 *   becomes a tile, matching `buildLegacyMigrationCandidate`).
 * - Star OFF → remove EVERY tile referencing the query and scrub those tile
 *   ids from every filter's `targets`.
 * - `dashboard` null in → `null` out (no Dashboard yet; favorite flip only).
 *
 * The result is always run through `flowLayoutPlugin.normalize` (a new tile
 * gets the flow default placement lazily — nothing to add up front — and a
 * removed tile's placement item, if any, is dropped) and is always a fresh
 * copy; `dashboard` is never mutated.
 */
export function toggleTileMembership(
  dashboard: DashboardDocumentV1 | null,
  query: SavedQueryV2,
  favorite: boolean,
  genTileId: () => string,
): DashboardDocumentV1 | null {
  if (!dashboard) return null;
  const hasTile = dashboard.tiles.some((tile) => tile.queryId === query.id);
  let next = dashboard;
  if (favorite) {
    if (!hasTile && queryDashboardRole(query) === 'panel') {
      next = { ...dashboard, tiles: [...dashboard.tiles, { id: genTileId(), queryId: query.id }] };
    }
  } else if (hasTile) {
    next = removeTilesForQuery(dashboard, query.id);
  }
  return flowLayoutPlugin.normalize(next);
}
