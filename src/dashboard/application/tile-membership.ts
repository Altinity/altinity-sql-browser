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
import { resolveLayoutPluginSync } from '../layouts/layout-registry.js';
import { regenerateGridFallback } from '../layouts/grafana-grid-layout.js';
import { createEmptyDashboard } from './empty-dashboard.js';
import type { DashboardDocumentV1, SavedQueryV2 } from '../../generated/json-schema.types.js';

export interface TileRemovalResult {
  dashboard: DashboardDocumentV1;
  queries: SavedQueryV2[];
  queryId: string;
}

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

/** The Workbench star is canonical tile membership for panel-role queries.
 * Filter/setup favorites retain their independent compatibility semantics. */
export function queryMembershipFavorite(
  dashboard: DashboardDocumentV1 | null,
  query: SavedQueryV2,
): boolean {
  if (queryDashboardRole(query) !== 'panel') return query.spec.favorite === true;
  return !!dashboard?.tiles.some((tile) => tile.queryId === query.id);
}

/** Remove ONE Dashboard tile and synchronize the affected panel query's
 * compatibility favorite flag with its post-delete membership. Filter target
 * cleanup, layout normalization and grid fallback regeneration are part of
 * the same pure transform; revision ownership remains with the commit caller. */
export function removeTileMembership(
  dashboard: DashboardDocumentV1,
  queries: SavedQueryV2[],
  tileId: string,
): TileRemovalResult | null {
  const removedTile = dashboard.tiles.find((tile) => tile.id === tileId);
  if (!removedTile) return null;
  const tiles = dashboard.tiles.filter((tile) => tile.id !== tileId);
  const filters = dashboard.filters.map((filter) => (
    filter.targets
      ? { ...filter, targets: filter.targets.filter((target) => target !== tileId) }
      : filter
  ));
  const next = { ...dashboard, tiles, filters };
  const normalized = resolveLayoutPluginSync(next.layout).normalize(next);
  regenerateGridFallback(normalized.layout, normalized.tiles);
  const member = normalized.tiles.some((tile) => tile.queryId === removedTile.queryId);
  const nextQueries = queries.map((query) => (
    query.id === removedTile.queryId && queryDashboardRole(query) === 'panel'
      ? { ...query, spec: { ...query.spec, favorite: member } }
      : query
  ));
  return { dashboard: normalized, queries: nextQueries, queryId: removedTile.queryId };
}

/**
 * Reflect a Workbench favorite flip onto Dashboard tile membership (#299).
 *
 * - Star ON + panel-role query + no existing tile referencing it → append one
 *   tile `{ id: genId(), queryId: query.id }`.
 * - Star ON + a tile already references it → unchanged (idempotent).
 * - Star ON + filter/setup-role query → unchanged (favorite flip only; never
 *   becomes a tile, matching `buildLegacyMigrationCandidate`).
 * - Star OFF → remove EVERY tile referencing the query and scrub those tile
 *   ids from every filter's `targets`.
 * - Star ON + panel-role query + `dashboard:null` → mint the canonical empty
 *   Dashboard and append the first tile in the same transform.
 * - Star OFF or a non-panel role + `dashboard:null` → `null` (nothing to add).
 *
 * The result is always run through the ACTIVE layout engine's own
 * `normalize` (#291: flow@1 or grafana-grid@1, resolved from the document's
 * OWN `layout.type` via `resolveLayoutPluginSync` rather than a hardcoded
 * flow plugin) — a new tile gets its engine's default placement lazily
 * (nothing to add up front), and a removed tile's placement item, if any, is
 * dropped. When grafana-grid@1 is active, the flow@1 `fallback` is then
 * regenerated too (#291 "every grid mutation regenerates the flow@1
 * fallback"; a no-op under flow@1) — this membership change adds/removes a
 * tile just like the authoring commands do. The result is always a fresh
 * copy; `dashboard` is never mutated.
 */
export function toggleTileMembership(
  dashboard: DashboardDocumentV1 | null,
  query: SavedQueryV2,
  favorite: boolean,
  genId: () => string,
): DashboardDocumentV1 | null {
  if (!dashboard) {
    if (!favorite || queryDashboardRole(query) !== 'panel') return null;
    dashboard = createEmptyDashboard(genId());
  }
  const hasTile = dashboard.tiles.some((tile) => tile.queryId === query.id);
  let next = dashboard;
  if (favorite) {
    if (!hasTile && queryDashboardRole(query) === 'panel') {
      next = { ...dashboard, tiles: [...dashboard.tiles, { id: genId(), queryId: query.id }] };
    }
  } else if (hasTile) {
    next = removeTilesForQuery(dashboard, query.id);
  }
  const normalized = resolveLayoutPluginSync(next.layout).normalize(next);
  regenerateGridFallback(normalized.layout, normalized.tiles);
  return normalized;
}
