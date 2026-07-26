// Saved-query mutations must preserve workspace validity (#280 "Saved-query
// mutations must preserve workspace validity"). Deleting a query, changing its
// Dashboard role, deleting a selected variant, or changing a base panel's
// type/structure can all invalidate Dashboard references. This pure planner
// constructs and validates a COMPLETE candidate workspace for any such mutation
// and rejects an invalidating one unless the caller supplies an atomic repair
// that produces a valid candidate. The repair + mutation apply to ONE candidate
// workspace, which the caller then commits atomically through the Phase-2
// repository. Cancelling a mutation is simply not committing the plan.
//
// Every listed mutation reduces to deleting a query or replacing one query with
// a new version (role/variant/panel edits are all a replace), so the mutation
// surface is two kinds. Repairs mirror the #280 examples, minus the filter one
// #447 removed: remove the affected tiles, switch tiles to another variant, or
// remap references to another query.

import { cloneJson } from '../../core/saved-query.js';
import { canonicalEqual, DASHBOARD_DOCUMENT_SHAPE } from '../model/canonical-json.js';
import type { JsonSchemaValidationService } from '../../core/json-schema-validation.js';
import type { SpecSchemaService } from '../../core/spec-schema.js';
import type { WorkspaceDiagnostic } from '../model/workspace-diagnostics.js';
import { resolveDashboardPresentations } from '../model/presentation-resolver.js';
import { resolveLayoutPluginSync } from '../layouts/layout-registry.js';
import { regenerateGridFallback } from '../layouts/grafana-grid-layout.js';
import { validateStoredWorkspaceDocument } from '../../workspace/stored-workspace.js';
import type {
  DashboardDocumentV2, SavedQueryV2, StoredWorkspaceV5,
} from '../../generated/json-schema.types.js';

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

export type SavedQueryMutation =
  | { type: 'delete-query'; queryId: string }
  | { type: 'replace-query'; queryId: string; query: SavedQueryV2 };

export type SavedQueryRepairKind =
  | 'remove-affected-tiles'
  | 'switch-variant' | 'remap-query';

export type SavedQueryRepair =
  | { type: 'remove-affected-tiles' }
  | { type: 'switch-variant'; tileVariants: Record<string, string> }
  | { type: 'remap-query'; to: string };

/** The plan for one saved-query mutation. On success `candidate` is the valid
 *  candidate workspace to commit atomically. On failure `diagnostics` explains
 *  what the mutation would break and `repairs` lists the atomic repairs a UI
 *  can offer. */
export interface SavedQueryMutationPlan {
  ok: boolean;
  candidate: StoredWorkspaceV5 | null;
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

/** Drop every tile that renders the affected query.
 *
 * There is no companion filter repair any more. A curated filter could be broken
 * by a query mutation in two ways — it referenced the query as its option source,
 * or it explicitly targeted a tile that was about to disappear — so the repair
 * menu offered removing the affected filters as well. A variable is inferred from
 * the panel SQL that declares it and targets nothing, so removing the tiles is
 * the whole repair: any variable that existed only because of those queries stops
 * being inferred, and its stored option SQL (if any) becomes a visible orphan the
 * user can keep or delete. */
function removeAffectedTiles(dashboard: DashboardDocumentV2, affectedId: string): DashboardDocumentV2 {
  const tiles = dashboard.tiles.filter((tile) => !(isObject(tile) && tile.queryId === affectedId));
  return { ...dashboard, tiles };
}

function switchVariants(
  dashboard: DashboardDocumentV2, affectedId: string, tileVariants: Record<string, string>,
): DashboardDocumentV2 {
  const tiles = dashboard.tiles.map((tile) => {
    if (!isObject(tile) || tile.queryId !== affectedId || typeof tile.id !== 'string') return tile;
    const variant = tileVariants[tile.id];
    if (variant === undefined) return tile;
    return { ...tile, presentation: { ...(isObject(tile.presentation) ? tile.presentation : {}), variant } };
  });
  return { ...dashboard, tiles };
}

function remapQuery(dashboard: DashboardDocumentV2, affectedId: string, to: string): DashboardDocumentV2 {
  const tiles = dashboard.tiles.map((tile) =>
    (isObject(tile) && tile.queryId === affectedId ? { ...tile, queryId: to } : tile));
  return { ...dashboard, tiles };
}

function applyRepair(dashboard: DashboardDocumentV2, affectedId: string, repair: SavedQueryRepair): DashboardDocumentV2 {
  switch (repair.type) {
    case 'remove-affected-tiles': return removeAffectedTiles(dashboard, affectedId);
    case 'switch-variant': return switchVariants(dashboard, affectedId, repair.tileVariants);
    default: return remapQuery(dashboard, affectedId, repair.to);
  }
}

/** The repairs applicable to a set of diagnostics. A `tiles`-scoped diagnostic
 *  offers tile removal, a variant switch, or a remap; there is no other member
 *  collection left to repair, because a variable is inferred rather than stored
 *  and so cannot itself hold a reference a mutation could break. */
export function suggestRepairs(diagnostics: readonly WorkspaceDiagnostic[]): SavedQueryRepairKind[] {
  const repairs = new Set<SavedQueryRepairKind>();
  for (const diagnostic of diagnostics) {
    if (diagnostic.path.includes('tiles')) {
      repairs.add('remove-affected-tiles');
      repairs.add('switch-variant');
      repairs.add('remap-query');
    }
  }
  return [...repairs];
}

function validateWorkspace(
  candidate: StoredWorkspaceV5, options: SavedQueryMutationOptions,
): WorkspaceDiagnostic[] {
  const codecOptions = options.validationService ? { validationService: options.validationService } : {};
  const structural = validateStoredWorkspaceDocument(candidate, codecOptions);
  if (structural.length) return structural;
  // #424: presentation resolution runs for EVERY Dashboard, each at its own
  // indexed path, so a candidate can never be committed with one Dashboard
  // repaired and another left holding a dangling or incompatible reference.
  return candidate.dashboards.flatMap((dashboard, index) => resolveDashboardPresentations({
    dashboard, queries: candidate.queries,
    schemaService: options.schemaService, path: ['dashboards', index],
  }));
}

/** Apply the repair to ONE Dashboard, then normalize it only if the repair
 *  actually changed it (#424): a Dashboard the mutation does not touch must
 *  come out canonically identical and keep its revision, so it is never
 *  re-normalized or fallback-regenerated as a side effect of another
 *  Dashboard's repair. */
function repairedDashboard(
  dashboard: DashboardDocumentV2, affectedId: string, repair: SavedQueryRepair | undefined,
): DashboardDocumentV2 {
  const clone = cloneJson(dashboard);
  if (!repair) return clone;
  const repaired = applyRepair(clone, affectedId, repair);
  if (canonicalEqual(repaired, clone, DASHBOARD_DOCUMENT_SHAPE)) return clone;
  // Normalize through the ACTIVE layout engine's own plugin (#291: flow@1 or
  // grafana-grid@1, resolved from the document's own `layout.type`) rather
  // than a hardcoded flow plugin, then regenerate the flow@1 fallback when
  // grafana-grid@1 is active (a repair can add/remove tiles, exactly like the
  // authoring commands do) — a no-op under flow@1.
  const normalized = resolveLayoutPluginSync(repaired.layout).normalize(repaired);
  regenerateGridFallback(normalized.layout, normalized.tiles);
  return normalized;
}

/** Plan one saved-query mutation against a workspace, optionally applying an
 *  atomic repair. Returns a valid candidate to commit, or the diagnostics and
 *  available repairs when the mutation would invalidate the workspace.
 *
 *  #424: EVERY Dashboard in the workspace is part of the one atomic candidate.
 *  References are inspected and validated across the whole collection — the
 *  current UI may only offer repairs for what it can show, but the planner
 *  still detects a break in a Dashboard the UI never renders, so a mutation
 *  can never silently corrupt hidden data.
 *
 *  Note for the caller that eventually wires this up (it has no production
 *  caller yet): ONE `repair` is applied to EVERY Dashboard. That is right for
 *  `remap-query` (a query id is workspace-global) but blunt for the
 *  tile-scoped repairs — `switch-variant` keys off `tileVariants[tile.id]`,
 *  and tile ids are Dashboard-LOCAL, so a coincidental id collision would
 *  rewrite an unrelated Dashboard's tile. A per-Dashboard repair map is the
 *  natural extension once a UI can actually address more than one Dashboard. */
export function planSavedQueryMutation(
  workspace: StoredWorkspaceV5, mutation: SavedQueryMutation,
  repair?: SavedQueryRepair, options: SavedQueryMutationOptions = {},
): SavedQueryMutationPlan {
  const queries = applyQueryMutation(workspace.queries, mutation);
  const dashboards = workspace.dashboards.map(
    (dashboard) => repairedDashboard(dashboard, mutation.queryId, repair),
  );
  const candidate: StoredWorkspaceV5 = {
    storageVersion: 5, id: workspace.id, key: workspace.key, name: workspace.name,
    queries: cloneJson(queries), dashboards,
  };
  const diagnostics = validateWorkspace(candidate, options);
  if (diagnostics.length === 0) return { ok: true, candidate, diagnostics: [], repairs: [] };
  return { ok: false, candidate: null, diagnostics, repairs: suggestRepairs(diagnostics) };
}
