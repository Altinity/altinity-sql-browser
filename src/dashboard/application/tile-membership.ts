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

import { queryFavorite } from '../../core/saved-query.js';
import { queryDashboardRole } from '../model/workspace-semantics.js';
import { resolveLayoutPluginSync } from '../layouts/layout-registry.js';
import { regenerateGridFallback } from '../layouts/grafana-grid-layout.js';
import type { DashboardDocumentV1, SavedQueryV2 } from '../../generated/json-schema.types.js';

/** Build a brand-new, empty flow@1 Dashboard document at revision 1. The
 *  single source of truth for "what does an empty Dashboard look like" —
 *  `dashboard-authoring-session.ts`'s `createEmptyDashboard` (the "workspace
 *  has no Dashboard yet, start one" path for the authoring session) reuses
 *  this rather than duplicating the shape. Pure; the id is minted by the
 *  caller so tests stay deterministic and production stays unguessable. */
export function createEmptyDashboardDocument(id: string): DashboardDocumentV1 {
  return {
    documentVersion: 1, id, title: 'Dashboard', revision: 1,
    layout: { type: 'flow', version: 1, preset: 'full-width', items: {} },
    filters: [], tiles: [],
  };
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
 * - `dashboard` null in + star ON on a panel-role query → a fresh empty
 *   Dashboard is created (`createEmptyDashboardDocument(genDashboardId())`)
 *   and the tile is added to it (#307: a fresh workspace has no Dashboard
 *   yet, but starring a panel-role query must still be the one bridge that
 *   creates the first tile — the bug was that `null` silently swallowed the
 *   star forever, and File → Import queries had no membership sync at all;
 *   see `syncFavoriteTileMembership` below for the import-side fix).
 * - `dashboard` null in + star ON on a filter/setup-role query, or star OFF
 *   with `dashboard` null → `null` out unchanged (nothing to create or
 *   remove from).
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
 * copy; `dashboard` is never mutated. `genDashboardId` is only ever called
 * when a Dashboard must be created from nothing (defaults to `genTileId` —
 * tile and Dashboard ids share the same id space in production, `uid('ws-')`
 * off `app.genId`, so one generator covers both).
 */
export function toggleTileMembership(
  dashboard: DashboardDocumentV1 | null,
  query: SavedQueryV2,
  favorite: boolean,
  genTileId: () => string,
  genDashboardId: () => string = genTileId,
): DashboardDocumentV1 | null {
  let base = dashboard;
  if (!base) {
    if (!favorite || queryDashboardRole(query) !== 'panel') return null;
    base = createEmptyDashboardDocument(genDashboardId());
  }
  const hasTile = base.tiles.some((tile) => tile.queryId === query.id);
  let next = base;
  if (favorite) {
    if (!hasTile && queryDashboardRole(query) === 'panel') {
      next = { ...base, tiles: [...base.tiles, { id: genTileId(), queryId: query.id }] };
    }
  } else if (hasTile) {
    next = removeTilesForQuery(base, query.id);
  }
  const normalized = resolveLayoutPluginSync(next.layout).normalize(next);
  regenerateGridFallback(normalized.layout, normalized.tiles);
  return normalized;
}

/**
 * Sync Dashboard tile membership for EVERY currently-favorited panel-role
 * query at once (#307 "File → Import queries has no membership sync"):
 * additive-only — appends `{ id: genTileId(), queryId }` for each favorited
 * panel-role query with no existing tile, in `queries` order; never removes
 * a tile for an unfavorited query (unlike `toggleTileMembership`'s star-OFF
 * path, this is not a single flip — running it must never destroy tile
 * membership an existing Dashboard already declared for other reasons).
 * Creates a fresh empty Dashboard (via `createEmptyDashboardDocument`) when
 * `dashboard` is null and at least one tile needs to be added; stays `null`
 * when nothing qualifies. Idempotent — a second call with the same inputs is
 * a no-op. Ends with the same normalize + `regenerateGridFallback` tail as
 * `toggleTileMembership`, so layout stays consistent either way.
 */
export function syncFavoriteTileMembership(
  dashboard: DashboardDocumentV1 | null,
  queries: readonly SavedQueryV2[],
  genTileId: () => string,
  genDashboardId: () => string = genTileId,
): DashboardDocumentV1 | null {
  const missing = queries.filter((query) => (
    queryFavorite(query)
    && queryDashboardRole(query) === 'panel'
    && !dashboard?.tiles.some((tile) => tile.queryId === query.id)
  ));
  if (!missing.length) return dashboard;
  const base = dashboard ?? createEmptyDashboardDocument(genDashboardId());
  const next: DashboardDocumentV1 = {
    ...base,
    tiles: [...base.tiles, ...missing.map((query) => ({ id: genTileId(), queryId: query.id }))],
  };
  const normalized = resolveLayoutPluginSync(next.layout).normalize(next);
  regenerateGridFallback(normalized.layout, normalized.tiles);
  return normalized;
}
