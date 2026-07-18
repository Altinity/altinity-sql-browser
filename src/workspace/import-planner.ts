// Transactional PortableBundle import planner (#280 "Transactional import
// planner" / "Cross-resource semantic validation", Phase 5 of #287). Pure: no
// DOM, no storage, no crypto import — the ID generator is injected exactly
// like workspace-operations.ts's WorkspaceIdGen, so minting is deterministic
// in tests and unguessable in production.
//
// A PortableBundle import always resolves to one COMPLETE candidate
// StoredWorkspaceV1 built from the repository-level primitives in
// workspace-operations.ts, then validated in one pass through
// validateStoredWorkspaceDocument — exactly the same "build the whole
// candidate, validate once, never commit an invalid one" discipline
// saved-query-mutation.ts uses for in-place mutations. Nothing here mutates
// application state; the caller commits the returned candidate atomically
// through the Phase-2 repository, or does not commit at all.
//
// Query-identity conflicts are resolved BY ID, never by content-based dedup
// (#280): an incoming query conflicts with an existing one only when their
// `id`s match. `canonicalEqual` (over SAVED_QUERY_SHAPE) then decides whether
// that conflict can auto-resolve to "use existing" or needs a caller decision.

import { canonicalEqual, SAVED_QUERY_SHAPE } from '../dashboard/model/canonical-json.js';
import { dashboardDependencyQueryIds } from '../dashboard/model/bundle-order.js';
import { diagnostic, sortDiagnostics } from '../dashboard/model/workspace-diagnostics.js';
import type { WorkspaceDiagnostic } from '../dashboard/model/workspace-diagnostics.js';
import { cloneJson } from '../core/saved-query.js';
import {
  importQueries, replaceWorkspaceContents,
} from './workspace-operations.js';
import type { WorkspaceIdGen } from './workspace-operations.js';
import { validateStoredWorkspaceDocument } from './stored-workspace.js';
import type { WorkspaceCodecOptions } from './stored-workspace.js';
import type {
  DashboardDocumentV1, PortableBundleV1, SavedQueryV2, StoredWorkspaceV1,
} from '../generated/json-schema.types.js';

// --- Dashboard listing -------------------------------------------------------

/** One bundled Dashboard's presentation summary for an import picker. */
export interface DashboardSummary {
  id: string;
  title: string;
  tileCount: number;
  filterCount: number;
}

/** Summarize every Dashboard in a bundle, preserving `bundle.dashboards`
 *  ARRAY ORDER — array order is import-time presentation order, not a
 *  catalog to re-sort (owner decision, #280/#287). */
export function listBundleDashboards(bundle: PortableBundleV1): DashboardSummary[] {
  return bundle.dashboards.map((dashboard) => ({
    id: dashboard.id,
    title: dashboard.title,
    tileCount: dashboard.tiles.length,
    filterCount: dashboard.filters.length,
  }));
}

// --- Query conflict detection + resolution ----------------------------------

export type QueryConflictAction = 'use-existing' | 'copy' | 'replace' | 'skip';

/** One incoming query whose `id` matches an existing query's `id`.
 *  `canonicalEqual` is `canonicalEqual(existing, incoming, SAVED_QUERY_SHAPE)`. */
export interface QueryConflict {
  sourceId: string;
  existing: SavedQueryV2;
  incoming: SavedQueryV2;
  canonicalEqual: boolean;
}

/** Detect every incoming/existing query-id collision. Matches BY ID ONLY —
 *  not content-based dedup: two different ids with identical content are not
 *  a conflict here. */
export function detectQueryConflicts(
  existing: readonly SavedQueryV2[], incoming: readonly SavedQueryV2[],
): QueryConflict[] {
  const existingById = new Map(existing.map((query) => [query.id, query] as const));
  const out: QueryConflict[] = [];
  for (const query of incoming) {
    const match = existingById.get(query.id);
    if (!match) continue;
    out.push({
      sourceId: query.id,
      existing: match,
      incoming: query,
      canonicalEqual: canonicalEqual(match, query, SAVED_QUERY_SHAPE),
    });
  }
  return out;
}

export interface QueryDecision {
  sourceId: string;
  action: QueryConflictAction;
  /** Only meaningful for `action: 'copy'` — a caller-preferred fresh id.
   *  Honored when it is actually free; a taken/omitted value falls back to
   *  the injected `genId()` retry loop. */
  targetId?: string;
}

/** Auto-resolve the conflicts that are safe to resolve without asking: a
 *  conflict whose incoming content is canonically IDENTICAL to the existing
 *  query auto-resolves to 'use-existing'. A conflict whose content differs is
 *  omitted — the caller (a UI or a scripted import) must supply an explicit
 *  decision for it. */
export function autoResolveConflicts(conflicts: readonly QueryConflict[]): QueryDecision[] {
  return conflicts
    .filter((conflict) => conflict.canonicalEqual)
    .map((conflict) => ({ sourceId: conflict.sourceId, action: 'use-existing' as const, targetId: conflict.existing.id }));
}

// --- Query id mapping --------------------------------------------------------

/** Per-source-query-id resolution: `targetId: null` means the query is
 *  skipped (dropped from the candidate); otherwise `targetId` is the id the
 *  query lands under in the candidate workspace. */
export type IdMapping = Record<string, { targetId: string | null; action: QueryConflictAction }>;

const MAX_FRESH_ID_ATTEMPTS = 1000;

/**
 * Resolve every incoming query to a target id: a non-conflicting query keeps
 * its own id (recorded with action `'copy'` — it lands in the candidate
 * as-is, no rename needed). A conflicting query without a matching decision
 * defaults to `'skip'` (never silently import an undecided collision). A
 * conflicting query WITH a decision resolves per that decision:
 *   - 'use-existing' / 'replace' — same id as the conflict (ids already
 *     match by definition of "conflict");
 *   - 'skip' — `targetId: null`;
 *   - 'copy' — a caller-preferred `decision.targetId` when free, else a fresh
 *     id from `genId()`, retried (mirrors `mergeSaved`/`library-migrations`'s
 *     freshId loop) against existing ids, incoming ids, and ids already
 *     minted in this same call so two colliding copies in one import never
 *     collide with each other either.
 */
export function buildQueryIdMapping(
  incoming: readonly SavedQueryV2[], existing: readonly SavedQueryV2[],
  decisions: readonly QueryDecision[], genId: WorkspaceIdGen,
): IdMapping {
  const existingIds = new Set(existing.map((query) => query.id));
  const incomingIds = new Set(incoming.map((query) => query.id));
  const decisionBySourceId = new Map(decisions.map((decision) => [decision.sourceId, decision] as const));
  const minted = new Set<string>();
  const isTaken = (id: string): boolean => existingIds.has(id) || incomingIds.has(id) || minted.has(id);
  const freshId = (): string => {
    for (let attempt = 0; attempt < MAX_FRESH_ID_ATTEMPTS; attempt++) {
      const id = genId();
      if (id && !isTaken(id)) { minted.add(id); return id; }
    }
    throw new Error('Unable to mint a unique saved-query id for the import plan');
  };

  const mapping: IdMapping = {};
  for (const query of incoming) {
    const sourceId = query.id;
    if (!existingIds.has(sourceId)) {
      mapping[sourceId] = { targetId: sourceId, action: 'copy' };
      continue;
    }
    const decision = decisionBySourceId.get(sourceId);
    if (!decision) {
      mapping[sourceId] = { targetId: null, action: 'skip' };
      continue;
    }
    if (decision.action === 'skip') {
      mapping[sourceId] = { targetId: null, action: 'skip' };
    } else if (decision.action === 'use-existing' || decision.action === 'replace') {
      mapping[sourceId] = { targetId: sourceId, action: decision.action };
    } else {
      const requested = decision.targetId;
      let targetId: string;
      if (requested && !isTaken(requested)) { targetId = requested; minted.add(requested); } else { targetId = freshId(); }
      mapping[sourceId] = { targetId, action: 'copy' };
    }
  }
  return mapping;
}

// --- Dashboard reference rewriting -------------------------------------------

function resolveMapping(
  mapping: Map<string, string | null> | IdMapping, id: string,
): { mapped: boolean; targetId: string | null } {
  if (mapping instanceof Map) {
    return mapping.has(id) ? { mapped: true, targetId: mapping.get(id) ?? null } : { mapped: false, targetId: null };
  }
  return Object.hasOwn(mapping, id)
    ? { mapped: true, targetId: mapping[id].targetId }
    : { mapped: false, targetId: null };
}

export interface RewriteDashboardReferencesResult {
  dashboard: DashboardDocumentV1;
  invalidated: boolean;
  missingRequiredIds: string[];
}

/**
 * Bulk generalization of `saved-query-mutation.ts`'s `remapQuery`: rewrite
 * every `tile.queryId` and `filter.sourceQueryId` through `mapping`. A
 * reference that maps to `null` (skipped) or has no mapping entry at all
 * sets `invalidated: true` and collects the source id in
 * `missingRequiredIds` — the reference is left as-is (never silently
 * dropped) so the caller sees exactly what broke; `invalidated` is the
 * signal that the candidate must not be committed. Deep-clones; never
 * mutates `dashboard`.
 */
export function rewriteDashboardReferences(
  dashboard: DashboardDocumentV1, mapping: Map<string, string | null> | IdMapping,
): RewriteDashboardReferencesResult {
  const next = cloneJson(dashboard);
  const missing = new Set<string>();
  let invalidated = false;

  const remap = (id: string): string => {
    const { mapped, targetId } = resolveMapping(mapping, id);
    if (!mapped || targetId === null) {
      invalidated = true;
      missing.add(id);
      return id;
    }
    return targetId;
  };

  // `queryId` is a required string per DashboardTileV1 — no runtime guard
  // needed (structurally-invalid tiles are the schema layer's job).
  next.tiles = next.tiles.map((tile) => ({ ...tile, queryId: remap(tile.queryId) }));
  next.filters = next.filters.map((filter) => (
    typeof filter.sourceQueryId === 'string' ? { ...filter, sourceQueryId: remap(filter.sourceQueryId) } : filter
  ));

  return { dashboard: next, invalidated, missingRequiredIds: [...missing] };
}

// --- Candidate query-set assembly --------------------------------------------

/** Resolve one incoming query to its post-mapping content under `targetId`.
 *  Callers only invoke this for a 'copy'/'replace' entry, which
 *  `buildQueryIdMapping` always pairs with a non-null `targetId` — the null
 *  ('skip') and same-as-existing ('use-existing') cases are handled by the
 *  caller before this runs. */
function resolvedQueryContent(query: SavedQueryV2, targetId: string): SavedQueryV2 {
  // Always deep-clone so the committed candidate never aliases an object from
  // the caller's decoded bundle — a caller that retained and later mutated its
  // bundle would otherwise corrupt the persisted workspace (review hazard).
  return targetId === query.id ? cloneJson(query) : { ...cloneJson(query), id: targetId };
}

/** MERGE incoming queries into the existing catalog (Import queries / Import
 *  Dashboard): existing queries keep their catalog position; a 'replace'
 *  decision overwrites its entry in place; 'use-existing' is a no-op (the
 *  existing entry already stands); a 'copy' (fresh id or non-conflicting own
 *  id) is a genuinely new catalog entry, appended in bundle order. */
function mergeIncomingQueries(
  incoming: readonly SavedQueryV2[], existing: readonly SavedQueryV2[], mapping: IdMapping,
): SavedQueryV2[] {
  const replaceById = new Map<string, SavedQueryV2>();
  const additions: SavedQueryV2[] = [];
  for (const query of incoming) {
    const entry = mapping[query.id];
    if (!entry || entry.action === 'skip' || entry.action === 'use-existing') continue;
    // action is 'copy' or 'replace' — always paired with a non-null targetId.
    const content = resolvedQueryContent(query, entry.targetId as string);
    if (entry.action === 'replace') replaceById.set(content.id, content);
    else additions.push(content);
  }
  // `buildQueryIdMapping` only ever assigns a 'replace' action to a source id
  // that already exists in `existing` (it is the conflicting-id branch), so
  // every `replaceById` target is guaranteed present in `existing` — no
  // append fallback needed here.
  const merged = existing.map((query) => replaceById.get(query.id) ?? query);
  return [...merged, ...additions];
}

/** REPLACE the query catalog wholesale (Replace workspace): only queries
 *  reachable from the incoming bundle survive, in bundle order; 'use-existing'
 *  keeps the existing query's own content (still under the shared id) rather
 *  than the incoming content. */
function replaceIncomingQueries(
  incoming: readonly SavedQueryV2[], existing: readonly SavedQueryV2[], mapping: IdMapping,
): SavedQueryV2[] {
  const existingById = new Map(existing.map((query) => [query.id, query] as const));
  const out: SavedQueryV2[] = [];
  for (const query of incoming) {
    const entry = mapping[query.id];
    if (!entry || entry.action === 'skip') continue;
    if (entry.action === 'use-existing') {
      // 'use-existing' is only ever assigned for a source id already present
      // in `existing` — guaranteed found.
      out.push(existingById.get(entry.targetId as string) as SavedQueryV2);
      continue;
    }
    out.push(resolvedQueryContent(query, entry.targetId as string));
  }
  return out;
}

// --- Plans --------------------------------------------------------------------

export interface PortableBundleImportPlan {
  sourceDashboardId?: string;
  queryMappings: IdMapping;
  candidateWorkspace: StoredWorkspaceV1 | null;
  diagnostics: WorkspaceDiagnostic[];
}

function invalidPlan(
  diagnostics: WorkspaceDiagnostic[], queryMappings: IdMapping, sourceDashboardId?: string,
): PortableBundleImportPlan {
  return {
    ...(sourceDashboardId === undefined ? {} : { sourceDashboardId }),
    queryMappings, candidateWorkspace: null, diagnostics: sortDiagnostics(diagnostics),
  };
}

function validatedPlan(
  candidate: StoredWorkspaceV1, queryMappings: IdMapping, options: WorkspaceCodecOptions, sourceDashboardId?: string,
): PortableBundleImportPlan {
  const diagnostics = validateStoredWorkspaceDocument(candidate, options);
  if (diagnostics.length) return invalidPlan(diagnostics, queryMappings, sourceDashboardId);
  return {
    ...(sourceDashboardId === undefined ? {} : { sourceDashboardId }),
    queryMappings, candidateWorkspace: candidate, diagnostics: [],
  };
}

function dashboardNotFoundPlan(
  sourceDashboardId: string, queryMappings: IdMapping,
): PortableBundleImportPlan {
  return invalidPlan(
    [diagnostic(['dashboards'], 'import-dashboard-not-found',
      `Bundle contains no dashboard with id ${JSON.stringify(sourceDashboardId)}`, sourceDashboardId)],
    queryMappings, sourceDashboardId,
  );
}

function invalidatedDashboardPlan(
  sourceDashboardId: string, queryMappings: IdMapping, missingRequiredIds: readonly string[],
): PortableBundleImportPlan {
  return invalidPlan(
    [diagnostic(['dashboard'], 'dashboard-import-invalid',
      `Dashboard import is missing required saved-query dependencies: ${missingRequiredIds.join(', ')}`,
      sourceDashboardId)],
    queryMappings, sourceDashboardId,
  );
}

/** Queries-only import (Dashboard untouched): merge the bundle's queries into
 *  the workspace's query catalog per `decisions`, and validate the result. */
export function planImportQueries(
  workspace: StoredWorkspaceV1, bundle: PortableBundleV1,
  decisions: readonly QueryDecision[], genId: WorkspaceIdGen,
  options: WorkspaceCodecOptions = {},
): PortableBundleImportPlan {
  const mapping = buildQueryIdMapping(bundle.queries, workspace.queries, decisions, genId);
  const nextQueries = mergeIncomingQueries(bundle.queries, workspace.queries, mapping);
  const candidate = importQueries(workspace, nextQueries);
  return validatedPlan(candidate, mapping, options);
}

/** Import one bundled Dashboard plus its dependency closure of queries.
 *  `mode: 'copy'` mints a fresh Dashboard id (revision reset to 1); `mode:
 *  'replace'` keeps the imported Dashboard's own id and revision. A skipped
 *  or unmapped required dependency invalidates the plan (`candidateWorkspace:
 *  null`) rather than silently dropping the reference. */
export function planImportDashboard(
  workspace: StoredWorkspaceV1, bundle: PortableBundleV1, sourceDashboardId: string,
  decisions: readonly QueryDecision[], mode: 'copy' | 'replace', genId: WorkspaceIdGen,
  options: WorkspaceCodecOptions = {},
): PortableBundleImportPlan {
  const source = bundle.dashboards.find((dashboard) => dashboard.id === sourceDashboardId);
  if (!source) return dashboardNotFoundPlan(sourceDashboardId, {});

  const closureIds = new Set(dashboardDependencyQueryIds(source));
  const closureQueries = bundle.queries.filter((query) => closureIds.has(query.id));
  const mapping = buildQueryIdMapping(closureQueries, workspace.queries, decisions, genId);
  const nextQueries = mergeIncomingQueries(closureQueries, workspace.queries, mapping);

  const rewritten = rewriteDashboardReferences(source, mapping);
  if (rewritten.invalidated) {
    return invalidatedDashboardPlan(sourceDashboardId, mapping, rewritten.missingRequiredIds);
  }
  const finalDashboard: DashboardDocumentV1 = mode === 'copy'
    ? { ...rewritten.dashboard, id: genId(), revision: 1 }
    : rewritten.dashboard;

  const candidate = replaceWorkspaceContents(workspace, { queries: nextQueries, dashboard: finalDashboard });
  return validatedPlan(candidate, mapping, options, sourceDashboardId);
}

/** Replace the workspace's queries AND Dashboard atomically (preserving
 *  workspace `id`/`name`): only queries reachable from the bundle survive,
 *  and the selected Dashboard (if any) becomes the workspace's sole
 *  Dashboard, keeping its own id/revision. Omit `sourceDashboardId` to
 *  replace with a query-only workspace (Dashboard cleared to `null`). */
export function planReplaceWorkspace(
  workspace: StoredWorkspaceV1, bundle: PortableBundleV1, sourceDashboardId: string | undefined,
  decisions: readonly QueryDecision[], genId: WorkspaceIdGen,
  options: WorkspaceCodecOptions = {},
): PortableBundleImportPlan {
  const mapping = buildQueryIdMapping(bundle.queries, workspace.queries, decisions, genId);
  const nextQueries = replaceIncomingQueries(bundle.queries, workspace.queries, mapping);

  let dashboard: DashboardDocumentV1 | null = null;
  if (sourceDashboardId !== undefined) {
    const source = bundle.dashboards.find((candidate) => candidate.id === sourceDashboardId);
    if (!source) return dashboardNotFoundPlan(sourceDashboardId, mapping);
    const rewritten = rewriteDashboardReferences(source, mapping);
    if (rewritten.invalidated) {
      return invalidatedDashboardPlan(sourceDashboardId, mapping, rewritten.missingRequiredIds);
    }
    dashboard = rewritten.dashboard;
  }

  const candidate = replaceWorkspaceContents(workspace, { queries: nextQueries, dashboard });
  return validatedPlan(candidate, mapping, options, sourceDashboardId);
}
