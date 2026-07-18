// Saved-query mutations must preserve workspace validity (#280 "Saved-query
// mutations must preserve workspace validity"). Deleting a query, changing its
// Dashboard role, changing a filter source's role, deleting a selected
// variant, changing parameter declarations used by filters, or changing a base
// panel's type/structure can all invalidate Dashboard references. This pure
// planner constructs and validates a COMPLETE candidate workspace for any such
// mutation and rejects an invalidating one unless the caller supplies an atomic
// repair that produces a valid candidate. The repair + mutation apply to ONE
// candidate workspace, which the caller then commits atomically through the
// Phase-2 repository. Cancelling a mutation is simply not committing the plan.
//
// Every listed mutation reduces to deleting a query or replacing one query with
// a new version (role/variant/parameter/panel edits are all a replace), so the
// mutation surface is two kinds. Repairs mirror the #280 examples: remove the
// affected tiles, remove the affected filter definitions, switch tiles to
// another variant, or remap references to another query.

import { cloneJson } from '../../core/saved-query.js';
import type { JsonSchemaValidationService } from '../../core/json-schema-validation.js';
import type { SpecSchemaService } from '../../core/spec-schema.js';
import type { WorkspaceDiagnostic } from '../model/workspace-diagnostics.js';
import { resolveDashboardPresentations } from '../model/presentation-resolver.js';
import { resolveLayoutPluginSync } from '../layouts/layout-registry.js';
import { regenerateGridFallback } from '../layouts/grafana-grid-layout.js';
import { validateStoredWorkspaceDocument } from '../../workspace/stored-workspace.js';
import type {
  DashboardDocumentV1, SavedQueryV2, StoredWorkspaceV1,
} from '../../generated/json-schema.types.js';

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

export type SavedQueryMutation =
  | { type: 'delete-query'; queryId: string }
  | { type: 'replace-query'; queryId: string; query: SavedQueryV2 };

export type SavedQueryRepairKind =
  | 'remove-affected-tiles' | 'remove-affected-filters' | 'remove-affected'
  | 'switch-variant' | 'remap-query';

export type SavedQueryRepair =
  | { type: 'remove-affected-tiles' }
  | { type: 'remove-affected-filters' }
  | { type: 'remove-affected' }
  | { type: 'switch-variant'; tileVariants: Record<string, string> }
  | { type: 'remap-query'; to: string };

/** The plan for one saved-query mutation. On success `candidate` is the valid
 *  candidate workspace to commit atomically. On failure `diagnostics` explains
 *  what the mutation would break and `repairs` lists the atomic repairs a UI
 *  can offer. */
export interface SavedQueryMutationPlan {
  ok: boolean;
  candidate: StoredWorkspaceV1 | null;
  diagnostics: WorkspaceDiagnostic[];
  repairs: SavedQueryRepairKind[];
}

export interface SavedQueryMutationOptions {
  validationService?: JsonSchemaValidationService;
  schemaService?: SpecSchemaService;
}

function applyQueryMutation(queries: readonly SavedQueryV2[], mutation: SavedQueryMutation): SavedQueryV2[] {
  if (mutation.type === 'delete-query') {
    return queries.filter((query) => !(isObject(query) && query.id === mutation.queryId));
  }
  return queries.map((query) => (isObject(query) && query.id === mutation.queryId ? mutation.query : query));
}

/** Tile IDs whose tile references the affected query. */
function affectedTileIds(dashboard: DashboardDocumentV1, affectedId: string): Set<string> {
  const ids = new Set<string>();
  for (const tile of dashboard.tiles) {
    if (isObject(tile) && tile.queryId === affectedId && typeof tile.id === 'string') ids.add(tile.id);
  }
  return ids;
}

function removeAffectedTiles(dashboard: DashboardDocumentV1, affectedId: string): DashboardDocumentV1 {
  const removed = affectedTileIds(dashboard, affectedId);
  const tiles = dashboard.tiles.filter((tile) => !(isObject(tile) && tile.queryId === affectedId));
  const filters = dashboard.filters.map((filter) => {
    if (!isObject(filter) || !Array.isArray(filter.targets)) return filter;
    return { ...filter, targets: filter.targets.filter((target) => !removed.has(target as string)) };
  });
  return { ...dashboard, tiles, filters };
}

function removeAffectedFilters(dashboard: DashboardDocumentV1, affectedId: string): DashboardDocumentV1 {
  const targeted = affectedTileIds(dashboard, affectedId);
  const filters = dashboard.filters.filter((filter) => {
    if (!isObject(filter)) return true;
    if (filter.sourceQueryId === affectedId) return false;
    if (Array.isArray(filter.targets) && filter.targets.some((target) => targeted.has(target as string))) return false;
    return true;
  });
  return { ...dashboard, filters };
}

function switchVariants(
  dashboard: DashboardDocumentV1, affectedId: string, tileVariants: Record<string, string>,
): DashboardDocumentV1 {
  const tiles = dashboard.tiles.map((tile) => {
    if (!isObject(tile) || tile.queryId !== affectedId || typeof tile.id !== 'string') return tile;
    const variant = tileVariants[tile.id];
    if (variant === undefined) return tile;
    return { ...tile, presentation: { ...(isObject(tile.presentation) ? tile.presentation : {}), variant } };
  });
  return { ...dashboard, tiles };
}

function remapQuery(dashboard: DashboardDocumentV1, affectedId: string, to: string): DashboardDocumentV1 {
  const tiles = dashboard.tiles.map((tile) =>
    (isObject(tile) && tile.queryId === affectedId ? { ...tile, queryId: to } : tile));
  const filters = dashboard.filters.map((filter) =>
    (isObject(filter) && filter.sourceQueryId === affectedId ? { ...filter, sourceQueryId: to } : filter));
  return { ...dashboard, tiles, filters };
}

function applyRepair(dashboard: DashboardDocumentV1, affectedId: string, repair: SavedQueryRepair): DashboardDocumentV1 {
  switch (repair.type) {
    case 'remove-affected-tiles': return removeAffectedTiles(dashboard, affectedId);
    case 'remove-affected-filters': return removeAffectedFilters(dashboard, affectedId);
    case 'remove-affected': return removeAffectedFilters(removeAffectedTiles(dashboard, affectedId), affectedId);
    case 'switch-variant': return switchVariants(dashboard, affectedId, repair.tileVariants);
    default: return remapQuery(dashboard, affectedId, repair.to);
  }
}

/** The repairs applicable to a set of diagnostics: a `filters`-scoped
 *  diagnostic offers filter removal; a `tiles`-scoped one offers tile removal,
 *  a variant switch, or a remap. */
export function suggestRepairs(diagnostics: readonly WorkspaceDiagnostic[]): SavedQueryRepairKind[] {
  const repairs = new Set<SavedQueryRepairKind>();
  for (const diagnostic of diagnostics) {
    if (diagnostic.path.includes('filters')) repairs.add('remove-affected-filters');
    else if (diagnostic.path.includes('tiles')) {
      repairs.add('remove-affected-tiles');
      repairs.add('switch-variant');
      repairs.add('remap-query');
    }
  }
  return [...repairs];
}

function validateWorkspace(
  candidate: StoredWorkspaceV1, options: SavedQueryMutationOptions,
): WorkspaceDiagnostic[] {
  const codecOptions = options.validationService ? { validationService: options.validationService } : {};
  const structural = validateStoredWorkspaceDocument(candidate, codecOptions);
  if (structural.length) return structural;
  if (candidate.dashboard === null) return [];
  return resolveDashboardPresentations({
    dashboard: candidate.dashboard, queries: candidate.queries,
    schemaService: options.schemaService, path: ['dashboard'],
  });
}

/** Plan one saved-query mutation against a workspace, optionally applying an
 *  atomic repair. Returns a valid candidate to commit, or the diagnostics and
 *  available repairs when the mutation would invalidate the workspace. */
export function planSavedQueryMutation(
  workspace: StoredWorkspaceV1, mutation: SavedQueryMutation,
  repair?: SavedQueryRepair, options: SavedQueryMutationOptions = {},
): SavedQueryMutationPlan {
  const queries = applyQueryMutation(workspace.queries, mutation);
  let dashboard: DashboardDocumentV1 | null = workspace.dashboard ? cloneJson(workspace.dashboard) : null;
  if (dashboard && repair) dashboard = applyRepair(dashboard, mutation.queryId, repair);
  // Normalize through the ACTIVE layout engine's own plugin (#291: flow@1 or
  // grafana-grid@1, resolved from the document's own `layout.type`) rather
  // than a hardcoded flow plugin, then regenerate the flow@1 fallback when
  // grafana-grid@1 is active (a repair can add/remove tiles, exactly like the
  // authoring commands do) — a no-op under flow@1.
  if (dashboard) {
    dashboard = resolveLayoutPluginSync(dashboard.layout).normalize(dashboard);
    regenerateGridFallback(dashboard.layout, dashboard.tiles.map((tile) => ({ id: tile.id })));
  }
  const candidate: StoredWorkspaceV1 = {
    storageVersion: 1, id: workspace.id, name: workspace.name,
    queries: cloneJson(queries), dashboard,
  };
  const diagnostics = validateWorkspace(candidate, options);
  if (diagnostics.length === 0) return { ok: true, candidate, diagnostics: [], repairs: [] };
  return { ok: false, candidate: null, diagnostics, repairs: suggestRepairs(diagnostics) };
}
