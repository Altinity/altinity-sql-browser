// The migrations that carry a legacy stored workspace to V5 — the Dashboard
// query OWNERSHIP migration (#427) and the curated-filter removal (#447) — plus
// the shared normalization the import planner runs on incoming Dashboards.
//
// The ownership model gives every panel tile its own dedicated saved-query copy.
// A V3 record predates that: the Workbench star made a LIBRARY query a Dashboard
// member, so one query is routinely referenced by several tiles. This module
// mints the dedicated copies and redirects each member reference to its own.
//
// Ordering matters, and is why there is no V3 -> V4 step any more. A V3 record's
// Dashboards are document v1 and carry curated `filters`, some of which
// reference option-source queries. Filters are dropped FIRST, so
// `assignDedicatedOwnership` only ever walks document v2 — tiles, and nothing
// else. Doing it the other way round would mint dedicated copies for filter
// sources and then immediately orphan them.
//
// Two properties matter more than anything else here.
//
// **Clone ids are DERIVED, never generated.** An `id` from `crypto.randomUUID`
// would make the migration non-deterministic, and the migration runs inside
// `decodeStoredWorkspaceJson` — a pure read that `WorkspaceRepository.list()`
// performs on every record without writing anything. Random ids there would mean
// two decodes of one byte-identical stored record disagree, so
// `workspaceToken()`/`queryToken()` (both computed from the ENCODED document)
// would differ on every refresh: `ui/app.ts`'s "nothing changed" fast path would
// never fire, and every window focus would detach the user's open owned-query tab
// and rebuild the Dashboard session, re-running every tile query. Two tabs would
// mint two different id sets and fight. Deriving the id from the member the copy
// belongs to removes the whole class of problem: every decode, in every tab, of
// the same bytes produces the same document. The derivation still writes the
// literal `panel` role into its tuple, unchanged from #427, so every copy an
// existing V4 record already holds stays reproducible byte for byte.
//
// **Every owner reference is cloned, and every original is preserved.** #427:
// "preserve every original saved query as a standalone Library source and create
// a dedicated clone for every Dashboard member." Skipping the clone when a query
// happens to have only one owner would empty the Library for real shipped
// content — `examples/iceberg-catalog-dashboard.json` has ten queries, each
// referenced by exactly one tile, so a one-owner shortcut would leave it with no
// Library queries at all. The single exception (below) is content-identity, not
// reference counting.
//
// Pure — no DOM, no persistence, no clock, no injected id generator.

import { cloneJson, queryContentKey } from '../core/saved-query.js';
import {
  buildQueryOwnershipIndex, cloneQueryForDashboardOwner,
} from '../dashboard/model/query-ownership.js';
import { queryDashboardRole } from '../dashboard/model/workspace-semantics.js';
import { dropCuratedFilters } from '../dashboard/model/dashboard-document.js';
import type {
  DashboardDocumentV2, SavedQueryV2,
  StoredWorkspaceV3, StoredWorkspaceV4, StoredWorkspaceV5,
} from '../generated/json-schema.types.js';

// Re-exported so the stored-workspace migration chain stays one import for
// callers and tests, while the transform itself lives in the Dashboard model
// layer both containers depend on.
export { dropCuratedFilters };

/** Prefix every derived owned-copy id carries, so an id minted by this migration
 *  is recognizable in a stored record and in a diagnostic. */
export const OWNED_QUERY_ID_PREFIX = 'q-own-';

/** FNV-1a (32-bit), fixed-width lowercase hex. A non-cryptographic hash is the
 *  right tool: this needs determinism across builds and tabs, not secrecy, and
 *  `crypto.subtle` is async and injected — neither belongs in a pure codec. */
function fnv1a32Hex(input: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    // 16777619, as shifts, so the product stays inside 32 bits.
    hash = (hash + (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24)) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** Length-prefixed composition, so no id containing the separator can forge
 *  another member's tuple. Correctness would survive an ambiguous separator —
 *  collisions escalate deterministically below — but an unambiguous one means a
 *  collision can only ever be a genuine hash collision. */
const memberTuple = (
  sourceQueryId: string, dashboardId: string, memberId: string,
): string => `${sourceQueryId.length}:${sourceQueryId}|${dashboardId.length}:${dashboardId}|panel|${memberId.length}:${memberId}`;

/**
 * The id of the copy one tile owns — a pure function of the member itself
 * (source query + Dashboard + tile id), all of which the migration preserves, so
 * the derivation is stable across decodes, tabs and builds.
 *
 * The tuple keeps #427's literal `panel` segment even though a tile is now the
 * only kind of owner, so every id an existing V4 record holds still derives to
 * the same value and re-importing an exported Dashboard keeps recognizing its
 * copies instead of minting a second set.
 *
 * `taken` carries both the ids the workspace already holds and the ids minted
 * earlier in the same pass, so escalation is deterministic given the fixed
 * document walk order (Dashboards in order, tiles in tile order).
 */
export function deriveOwnedQueryId(input: {
  sourceQueryId: string;
  dashboardId: string;
  memberId: string;
}, taken: ReadonlySet<string>): string {
  const base = OWNED_QUERY_ID_PREFIX
    + fnv1a32Hex(memberTuple(input.sourceQueryId, input.dashboardId, input.memberId));
  if (!taken.has(base)) return base;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export interface DedicatedOwnershipInput {
  queries: readonly SavedQueryV2[];
  dashboards: readonly DashboardDocumentV2[];
  /** Dashboard ids to normalize. Omitted means all of them — what the migration
   *  wants. The import planner passes only the Dashboards it is bringing in, so
   *  a Dashboard the import never named comes out canonically identical. */
  scope?: ReadonlySet<string>;
}

export interface DedicatedOwnershipResult {
  queries: SavedQueryV2[];
  dashboards: DashboardDocumentV2[];
  /** How many dedicated copies were minted. Zero means the input already
   *  satisfied the invariant, which is what makes a second pass observably a
   *  no-op rather than merely an equal-looking one. */
  clonedCount: number;
}

/**
 * Give every panel tile in scope its own dedicated query copy, appending the
 * copies to `queries` and redirecting only those tile references.
 *
 * Preserved exactly: every original query (and its favourite), Dashboard, tile
 * and layout ids and order, Dashboard revisions, tile presentation and
 * overrides, and any `variableConfigs`. Ownership is read across ALL Dashboards
 * even when `scope` narrows what is rewritten, so a query owned by an
 * out-of-scope Dashboard is never treated as a free Library source.
 *
 * Three references are deliberately left alone:
 *
 *  - a reference to a query id the collection does not carry — a dangling
 *    reference stays the separate `dashboard-tile-query-missing` diagnostic it
 *    already is, rather than being silently repaired or dropped;
 *  - a `setup`-role source — #427 rejects setup owners, so cloning it into a
 *    panel role would hide the error behind an invented member;
 *  - a query that IS already the dedicated copy of a Library source (see
 *    `alreadyDedicated`).
 */
export function assignDedicatedOwnership(input: DedicatedOwnershipInput): DedicatedOwnershipResult {
  const queries = input.queries.map((query) => cloneJson(query));
  const dashboards = input.dashboards.map((dashboard) => cloneJson(dashboard));
  const byId = new Map(queries.map((query) => [query.id, query]));
  const taken = new Set(queries.map((query) => query.id));
  const index = buildQueryOwnershipIndex({ queries, dashboards });

  /** Is `query` already the dedicated copy a tile would get?
   *
   *  Recognized by the migration's own id MARKER plus a fixed-point check — the
   *  clone transform only sets `spec.dashboard.role` and drops `spec.favorite`, so
   *  a copy already in that shape is unchanged by re-cloning. Two earlier designs
   *  were wrong:
   *
   *   - matching on CONTENT alone adopted an unrelated query: a user who saved the
   *     same query twice and tiled one copy would have that copy silently
   *     reclassified as the tile's dedicated copy and DISAPPEAR from the Library,
   *     with the outcome depending on whether a duplicate happened to exist;
   *   - requiring a content-matching LIBRARY twin in the same document broke the
   *     single-Dashboard export round trip: `buildDashboardExportBundle` ships only
   *     the dependency closure (the copies, never their Library sources), so on
   *     re-import every member was cloned again and the imported copies were left
   *     behind as junk Library entries with identical names.
   *
   *  The marker is safe to trust: every other id comes from `crypto.randomUUID`
   *  via the repository generator, which cannot produce this prefix. */
  const alreadyDedicated = (source: SavedQueryV2): boolean => {
    if (!source.id.startsWith(OWNED_QUERY_ID_PREFIX)) return false;
    // The caller is itself an owner, so the entry always exists (`!` is sound).
    const owners = index.ownersByQueryId.get(source.id)!;
    // Shared is unconditionally invalid now that a tile is the only owner kind
    // (#447), so a copy with a second owner is not a dedicated copy of anything.
    if (owners.length > 1) return false;
    return queryContentKey(source)
      === queryContentKey(cloneQueryForDashboardOwner({ source, newId: source.id }));
  };

  let clonedCount = 0;

  /** Mint the copy for one tile and return its id, or `null` to leave the
   *  reference exactly as it is. */
  const dedicate = (
    sourceQueryId: string, dashboardId: string, memberId: string,
  ): string | null => {
    const source = byId.get(sourceQueryId);
    if (source === undefined) return null;
    if (queryDashboardRole(source) === 'setup') return null;
    if (alreadyDedicated(source)) return null;
    const newId = deriveOwnedQueryId({ sourceQueryId, dashboardId, memberId }, taken);
    taken.add(newId);
    const clone = cloneQueryForDashboardOwner({ source, newId });
    queries.push(clone);
    byId.set(newId, clone);
    clonedCount += 1;
    return newId;
  };

  for (const dashboard of dashboards) {
    if (input.scope !== undefined && !input.scope.has(dashboard.id)) continue;
    for (const tile of dashboard.tiles) {
      const owned = dedicate(tile.queryId, dashboard.id, tile.id);
      if (owned !== null) tile.queryId = owned;
    }
  }
  return { queries, dashboards, clonedCount };
}

/**
 * The one pure, deterministic V3 → V5 migration.
 *
 * Curated filters are dropped first, then every remaining Dashboard member — a
 * panel tile — gains a dedicated query copy. Every original query stays exactly
 * where it was in `queries[]`, keeping its favourite (which is a Library
 * preference from #427 on, with no membership meaning). Workspace identity,
 * Dashboard order, member ids and Dashboard revisions are untouched.
 *
 * There is deliberately no V3 → V4 step: V4's shape is a strictly intermediate
 * one that only ever existed to hold filter-owned copies, so minting those and
 * then orphaning them would add work and churn ids for no gain.
 *
 * Idempotent twice over — by version, because a V5 record never re-enters this
 * function, and by content, because `assignDedicatedOwnership` recognizes the
 * copies it minted as already dedicated.
 */
export function migrateStoredWorkspaceV3ToV5(workspace: StoredWorkspaceV3): StoredWorkspaceV5 {
  const { queries, dashboards } = assignDedicatedOwnership({
    queries: workspace.queries,
    dashboards: workspace.dashboards.map(dropCuratedFilters),
  });
  return {
    storageVersion: 5,
    id: workspace.id,
    key: workspace.key,
    name: workspace.name,
    queries,
    dashboards,
  };
}

/**
 * The one pure, deterministic V4 → V5 migration.
 *
 * Only the curated filters go. A V4 record has already been through the
 * ownership migration, so every tile reference is already a dedicated copy and
 * nothing is re-derived — which also means no id changes and no re-cloning.
 *
 * The copies that filters owned are deliberately KEPT. Losing their last owner
 * makes them Library queries, exactly as removing any other Dashboard member
 * does (#427 documents that hand-off), so no SQL the user may have edited on a
 * copy is destroyed; the queries simply reappear in the Library beside the
 * originals they were cloned from, where they can be deleted by hand.
 */
export function migrateStoredWorkspaceV4ToV5(workspace: StoredWorkspaceV4): StoredWorkspaceV5 {
  return {
    storageVersion: 5,
    id: workspace.id,
    key: workspace.key,
    name: workspace.name,
    queries: cloneJson(workspace.queries),
    dashboards: workspace.dashboards.map(dropCuratedFilters),
  };
}
