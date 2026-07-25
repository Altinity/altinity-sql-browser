// The V3 -> V4 Dashboard query OWNERSHIP migration (#427), and the shared
// normalization the import planner runs on incoming Dashboards.
//
// #427's final model gives every panel tile and every curated filter its own
// dedicated saved-query copy. A V3 record predates that: the Workbench star made
// a LIBRARY query a Dashboard member, so one query is routinely referenced by a
// tile, by several tiles, or by a filter and a tile at once. This module mints
// the dedicated copies and redirects each member reference to its own.
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
// the same bytes produces the same document.
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
  type DashboardOwnerRole,
} from '../dashboard/model/query-ownership.js';
import { queryDashboardRole } from '../dashboard/model/workspace-semantics.js';
import type {
  DashboardDocumentV1, SavedQueryV2, StoredWorkspaceV3, StoredWorkspaceV4,
} from '../generated/json-schema.types.js';

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
  sourceQueryId: string, dashboardId: string, role: DashboardOwnerRole, memberId: string,
): string => `${sourceQueryId.length}:${sourceQueryId}|${dashboardId.length}:${dashboardId}|${role}|${memberId.length}:${memberId}`;

/**
 * The id of the copy one member owns — a pure function of the member itself
 * (source query + Dashboard + role + member id), all of which the migration
 * preserves, so the derivation is stable across decodes, tabs and builds.
 *
 * `taken` carries both the ids the workspace already holds and the ids minted
 * earlier in the same pass, so escalation is deterministic given the fixed
 * document walk order (Dashboards in order, filters before tiles).
 */
export function deriveOwnedQueryId(input: {
  sourceQueryId: string;
  dashboardId: string;
  role: DashboardOwnerRole;
  memberId: string;
}, taken: ReadonlySet<string>): string {
  const base = OWNED_QUERY_ID_PREFIX
    + fnv1a32Hex(memberTuple(input.sourceQueryId, input.dashboardId, input.role, input.memberId));
  if (!taken.has(base)) return base;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export interface DedicatedOwnershipInput {
  queries: readonly SavedQueryV2[];
  dashboards: readonly DashboardDocumentV1[];
  /** Dashboard ids to normalize. Omitted means all of them — what the migration
   *  wants. The import planner passes only the Dashboards it is bringing in, so
   *  a Dashboard the import never named comes out canonically identical. */
  scope?: ReadonlySet<string>;
}

export interface DedicatedOwnershipResult {
  queries: SavedQueryV2[];
  dashboards: DashboardDocumentV1[];
  /** How many dedicated copies were minted. Zero means the input already
   *  satisfied the invariant, which is what makes a second pass observably a
   *  no-op rather than merely an equal-looking one. */
  clonedCount: number;
}

/**
 * Give every panel tile and curated filter in scope its own dedicated query
 * copy, appending the copies to `queries` and redirecting only those member
 * references.
 *
 * Preserved exactly: every original query (and its favourite), Dashboard, tile,
 * filter and layout ids and order, Dashboard revisions, tile presentation and
 * overrides. Ownership is read across ALL Dashboards even when `scope` narrows
 * what is rewritten, so a query owned by an out-of-scope Dashboard is never
 * treated as a free Library source.
 *
 * Three references are deliberately left alone:
 *
 *  - a reference to a query id the collection does not carry — a dangling
 *    reference stays the separate `dashboard-tile-query-missing` /
 *    `filter-source-missing` diagnostic it already is, rather than being
 *    silently repaired or dropped;
 *  - a `setup`-role source — #427 rejects setup owners, so cloning it into a
 *    panel or filter role would hide the error behind an invented member;
 *  - a query that IS already the dedicated copy of a Library source (see
 *    `alreadyDedicated`).
 *
 * A plain filter (no `sourceQueryId`) owns nothing and is untouched.
 */
export function assignDedicatedOwnership(input: DedicatedOwnershipInput): DedicatedOwnershipResult {
  const queries = input.queries.map((query) => cloneJson(query));
  const dashboards = input.dashboards.map((dashboard) => cloneJson(dashboard));
  const byId = new Map(queries.map((query) => [query.id, query]));
  const taken = new Set(queries.map((query) => query.id));
  const index = buildQueryOwnershipIndex({ queries, dashboards });

  // What a dedicated copy of each LIBRARY query would look like, keyed by ROLE
  // plus content. A member query matching its own role's key is already that
  // copy — the only deterministic way to recognize "this V3 content already uses
  // one dedicated non-Library copy per member" (#427). It also makes the whole
  // transform content-idempotent: re-running it on its own output clones
  // nothing, because every copy it minted matches the key of its own preserved
  // source.
  //
  // The ROLE is part of the key deliberately. A copy shaped like a panel-role
  // clone, sitting behind a curated FILTER, is not that filter's dedicated copy:
  // accepting it would leave a role-mismatched reference the workspace cannot
  // even open (`filter-source-role`), when re-homing it repairs the document.
  const dedicatedKey = (role: DashboardOwnerRole, query: SavedQueryV2): string =>
    `${role}:${queryContentKey(query)}`;
  const dedicatedKeys = new Set<string>();
  for (const query of queries) {
    if (!index.libraryQueryIds.has(query.id)) continue;
    for (const role of ['panel', 'filter'] as const) {
      dedicatedKeys.add(dedicatedKey(
        role, cloneQueryForDashboardOwner({ source: query, newId: query.id, role }),
      ));
    }
  }
  /** True when `source` IS already the dedicated copy the calling member owns.
   *
   *  The caller is itself one of `source`'s owners — the index is built from the
   *  same documents being walked — so `!` is sound, and "exactly one owner"
   *  already means "owned by this member and no one else". The only remaining
   *  question is whether the query is shaped like the copy this member's ROLE
   *  would get. */
  const alreadyDedicated = (source: SavedQueryV2, role: DashboardOwnerRole): boolean =>
    index.ownersByQueryId.get(source.id)!.length === 1
    && dedicatedKeys.has(dedicatedKey(role, source));

  let clonedCount = 0;
  /** Mint the copy for one member and return its id, or `null` to leave the
   *  reference exactly as it is. */
  const dedicate = (
    sourceQueryId: string, dashboardId: string, role: DashboardOwnerRole, memberId: string,
  ): string | null => {
    const source = byId.get(sourceQueryId);
    if (source === undefined) return null;
    if (queryDashboardRole(source) === 'setup') return null;
    if (alreadyDedicated(source, role)) return null;
    const newId = deriveOwnedQueryId({ sourceQueryId, dashboardId, role, memberId }, taken);
    taken.add(newId);
    const clone = cloneQueryForDashboardOwner({ source, newId, role });
    queries.push(clone);
    byId.set(newId, clone);
    clonedCount += 1;
    return newId;
  };

  for (const dashboard of dashboards) {
    if (input.scope !== undefined && !input.scope.has(dashboard.id)) continue;
    // Filters before tiles — the order `buildQueryOwnershipIndex` reports owners
    // in, so a derived id depends only on its own member and not on how many
    // members happened to be walked first.
    for (const filter of dashboard.filters) {
      if (filter.sourceQueryId === undefined) continue;
      const owned = dedicate(filter.sourceQueryId, dashboard.id, 'filter', filter.id);
      if (owned !== null) filter.sourceQueryId = owned;
    }
    for (const tile of dashboard.tiles) {
      const owned = dedicate(tile.queryId, dashboard.id, 'panel', tile.id);
      if (owned !== null) tile.queryId = owned;
    }
  }
  return { queries, dashboards, clonedCount };
}

/**
 * The one pure, deterministic V3 → V4 migration.
 *
 * Every Dashboard member gains a dedicated query copy; every original query
 * stays exactly where it was in `queries[]`, keeping its favourite (which is a
 * Library preference from #427 on, with no membership meaning). Workspace
 * identity, Dashboard order, member ids and Dashboard revisions are untouched:
 * #430 requires member ids to survive so the #426 tree's session state stays
 * valid across the migration.
 *
 * Idempotent twice over — by version, because a V4 record never re-enters this
 * function, and by content, because `assignDedicatedOwnership` recognizes the
 * copies it minted as already dedicated.
 */
export function migrateStoredWorkspaceV3ToV4(workspace: StoredWorkspaceV3): StoredWorkspaceV4 {
  const { queries, dashboards } = assignDedicatedOwnership({
    queries: workspace.queries, dashboards: workspace.dashboards,
  });
  return {
    storageVersion: 4,
    id: workspace.id,
    key: workspace.key,
    name: workspace.name,
    queries,
    dashboards,
  };
}
