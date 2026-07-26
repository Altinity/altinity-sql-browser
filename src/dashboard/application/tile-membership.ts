// Dashboard tile removal (#299, #427).
//
// This module USED to wire the Workbench favorite star to Dashboard tile
// membership: starring a panel query appended a tile, unstarring removed every
// tile referencing it, and `queryMembershipFavorite` read the star's state back
// off `dashboard.tiles[]`. #427 severed that coupling. A favourite is now purely
// a Library/workbench preference, and Dashboard membership is an explicit
// reference to a query the member OWNS — so a star can no longer create a
// Dashboard, add or remove a tile or filter, select a Dashboard, or touch an
// owned copy. `toggleTileMembership` and `queryMembershipFavorite` are gone with
// it, and #434 (the #425 star gate that existed only to make the coupling less
// dangerous) is closed.
//
// What remains is the Dashboard's OWN removal path: taking a tile off the
// document. It no longer writes `spec.favorite` back onto the query, because
// there is no longer anything to keep in sync.
//
// Pure — no DOM, no persistence.

import { resolveLayoutPluginSync } from '../layouts/layout-registry.js';
import { regenerateGridFallback } from '../layouts/grafana-grid-layout.js';
import type { DashboardDocumentV2, SavedQueryV2 } from '../../generated/json-schema.types.js';

export interface TileRemovalResult {
  dashboard: DashboardDocumentV2;
  queries: SavedQueryV2[];
  queryId: string;
}

/** Remove ONE Dashboard tile. Layout normalization and grid fallback
 * regeneration are part of the same pure transform; revision ownership remains
 * with the commit caller.
 *
 * There is no longer any per-member reference to scrub alongside the tile.
 * Curated filters used to carry an explicit `targets` list naming tile ids, so
 * removing a tile had to prune every filter that pointed at it; a variable binds
 * by NAME to whichever panel queries declare it, so dropping a tile simply stops
 * that query from declaring anything and the binding disappears on its own.
 *
 * `queries` is returned unchanged — the tile's query is NOT deleted here, and
 * #427 removed the `spec.favorite` write-back this used to perform. Removing the
 * owned query too is one atomic operation, and it belongs to #429's trash
 * action, which knows it is deleting a member rather than clearing a flag. */
export function removeTileMembership(
  dashboard: DashboardDocumentV2,
  queries: SavedQueryV2[],
  tileId: string,
): TileRemovalResult | null {
  const removedTile = dashboard.tiles.find((tile) => tile.id === tileId);
  if (!removedTile) return null;
  const tiles = dashboard.tiles.filter((tile) => tile.id !== tileId);
  const next = { ...dashboard, tiles };
  const normalized = resolveLayoutPluginSync(next.layout).normalize(next);
  regenerateGridFallback(normalized.layout, normalized.tiles);
  return { dashboard: normalized, queries, queryId: removedTile.queryId };
}
