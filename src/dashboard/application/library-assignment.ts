// Assigning a LIBRARY query to a Dashboard (#428). Two semantic operations over
// one latest committed `StoredWorkspaceV5`, each returning a complete candidate
// or a typed abort. Pure — no DOM, no persistence, no ids invented here.
//
// The two destinations mean genuinely different things, which is why they are
// two functions rather than one with a mode flag:
//
//   Dashboard row / Panels group -> an independent panel-owned COPY plus a tile
//   an inferred Variables row    -> the source's SQL TEXT, and nothing else
//
// Neither ever modifies the source. A Library query keeps its id, its SQL, its
// favourite state and its place in the Library after any number of assignments;
// the panel copy is a new document that diverges from that moment on, and the
// variable configuration is a detached string. #428 explicitly forbids
// persisting copy lineage, so nothing records where either came from.
//
// ── Why the ids are arguments ───────────────────────────────────────────────
// `newQueryId`/`newTileId` are supplied by the caller, from the injected
// `crypto.randomUUID` seam — NOT derived with `deriveOwnedQueryId`. Derived
// `q-own-…` ids exist so that migration and import stay deterministic and
// idempotent when they re-run over the same input; a user drag is neither, and
// `workspace/stored-workspace-ownership.ts` states the complementary rule that
// every non-migration id comes from `randomUUID`. Two drags of the same query
// onto the same Dashboard must produce two independent panels, which a
// content-derived id would actively fight.
//
// The collision check stays anyway: a pure transform must not assume its inputs
// are unique, and `id-collision` is one of the aborts #428 names.

import { applyCommand } from './dashboard-commands.js';
import type { ApplyCommandResult } from './dashboard-commands.js';
import { createQueryResolver } from './dashboard-query-resolver.js';
import { resolveLayoutPluginSync } from '../layouts/layout-registry.js';
import { cloneQueryForDashboardOwner, ownersOfQuery } from '../model/query-ownership.js';
import { inferDashboardVariables } from '../../core/dashboard-variables.js';
import { normalizeVariableSql } from '../../core/dashboard-variables.js';
import { findDashboardStrict, replaceDashboard, withVariableConfig } from '../../workspace/workspace-dashboards.js';
import type { SavedQueryV2, StoredWorkspaceV5 } from '../../generated/json-schema.types.js';

/**
 * Why an assignment declined, as a value rather than a thrown error — every one
 * of these is an ordinary concurrent-state outcome, not a bug, and the UI phrases
 * each differently. #428 requires aborting WITHOUT mutation for all of them.
 */
export type LibraryAssignmentAbort =
  /** The active workspace is not the one the drag started in. Ids are
   *  workspace-scoped, so resolving a same-looking id here would write the
   *  wrong document. */
  | 'workspace-mismatch'
  /** The source query was deleted while the drag was in flight. */
  | 'source-missing'
  /** The source became Dashboard-owned, so it is no longer a Library query and
   *  no longer an assignment source. */
  | 'source-not-library'
  /** The target Dashboard was deleted while the drag was in flight. */
  | 'dashboard-missing'
  /** Two Dashboards share the target id. Never "repair" that by guessing one. */
  | 'dashboard-ambiguous'
  /** A minted id is already taken. Effectively impossible with `randomUUID`,
   *  but the transform does not get to assume that. */
  | 'id-collision'
  /** The target variable is no longer inferred from the Dashboard's panel SQL
   *  (or never was — an orphan is not a destination). */
  | 'variable-not-inferred'
  /** The source query is blank. #428: this is NOT a deletion gesture; removing
   *  option SQL stays the variable editor's explicit blank-Save. */
  | 'blank-sql';

export type LibraryAssignmentResult<T> =
  | { ok: true; workspace: StoredWorkspaceV5; data: T }
  | { ok: false; reason: LibraryAssignmentAbort };

const fail = <T>(reason: LibraryAssignmentAbort): LibraryAssignmentResult<T> =>
  ({ ok: false, reason });

/** The four checks both operations share, in #428's own order: the workspace is
 *  the one the drag started in, and the source is still a Library query that
 *  exists. Returns the resolved source or the abort that stopped it. */
function resolveLibrarySource(
  latest: StoredWorkspaceV5, workspaceId: string, sourceQueryId: string,
): { ok: true; source: SavedQueryV2 } | { ok: false; reason: LibraryAssignmentAbort } {
  if (latest.id !== workspaceId) return { ok: false, reason: 'workspace-mismatch' };
  const source = latest.queries.find((query) => query.id === sourceQueryId);
  if (!source) return { ok: false, reason: 'source-missing' };
  // Zero Dashboard owners IS the definition of a Library query (#427). Re-read
  // from `latest`, never from what the drag believed at `dragstart`.
  if (ownersOfQuery(latest, sourceQueryId).length !== 0) {
    return { ok: false, reason: 'source-not-library' };
  }
  return { ok: true, source };
}

export interface CopyLibraryQueryToPanelInput {
  latest: StoredWorkspaceV5;
  workspaceId: string;
  sourceQueryId: string;
  dashboardId: string;
  newQueryId: string;
  newTileId: string;
}

/**
 * Copy a Library query into a Dashboard as an independent panel: one dedicated
 * owned clone appended to `workspace.queries[]`, and one tile referencing it
 * appended to that Dashboard's `tiles[]`.
 *
 * Layout goes through `applyCommand('add-query-instance')` — the app's canonical
 * ADD path — rather than a hand-rolled `tiles.push`. Only that path seeds the new
 * tile's placement from the source query's own `spec.dashboard.sizeHints`, which
 * grafana-grid@1 requires of every mutation, and it regenerates the flow@1
 * fallback centrally. `add-query-instance` (not `add-query`) is the right command
 * because #428 explicitly allows repeated drops of one source into one Dashboard.
 *
 * The tile carries `{ id, queryId }` and nothing else: a title or description
 * override equal to what the query already says is redundant state that would
 * then have to be kept in sync (#428 step 9).
 */
export function copyLibraryQueryToPanel(
  input: CopyLibraryQueryToPanelInput,
): LibraryAssignmentResult<{ queryId: string; tileId: string }> {
  const { latest, workspaceId, sourceQueryId, dashboardId, newQueryId, newTileId } = input;

  const resolved = resolveLibrarySource(latest, workspaceId, sourceQueryId);
  if (!resolved.ok) return fail(resolved.reason);

  const lookup = findDashboardStrict(latest, dashboardId);
  if (lookup.status !== 'ok') {
    return fail(lookup.status === 'missing' ? 'dashboard-missing' : 'dashboard-ambiguous');
  }
  const base = lookup.dashboard;

  // Query ids are workspace-wide; tile ids are Dashboard-local (see
  // `dashboard-duplicate-tile-id` in `model/workspace-semantics.ts`, which scopes
  // its index per Dashboard), so each is checked against the scope that owns it.
  if (latest.queries.some((query) => query.id === newQueryId)) return fail('id-collision');
  if (base.tiles.some((tile) => tile.id === newTileId)) return fail('id-collision');

  const clone = cloneQueryForDashboardOwner({ source: resolved.source, newId: newQueryId });
  const queries = [...latest.queries, clone];

  // `applyCommand` reports `ok: false` for exactly one reason on this command —
  // a `queryId` the resolver cannot find — and the resolver is built over the
  // collection the clone was just added to. That branch is therefore
  // unreachable, so it is asserted rather than handled: the coverage config
  // forbids defensive branches no test can reach.
  const applied = applyCommand(base, { type: 'add-query-instance', queryId: newQueryId }, {
    resolver: createQueryResolver(queries),
    genTileId: () => newTileId,
    plugin: resolveLayoutPluginSync(base.layout),
  }) as Extract<ApplyCommandResult, { ok: true }>;

  // `applyCommand` seeds placement and the grid fallback but deliberately leaves
  // `normalize` to its callers, as every other call site does.
  const normalized = resolveLayoutPluginSync(applied.dashboard.layout).normalize(applied.dashboard);

  // Exactly one revision bump, on the target only. `replaceDashboard` answers
  // `null` for an ambiguous id — already excluded above, but it is the write-side
  // guard and re-running it costs nothing.
  const next = replaceDashboard({ ...latest, queries }, dashboardId, {
    ...normalized, revision: base.revision + 1,
  }) as StoredWorkspaceV5;

  return { ok: true, workspace: next, data: { queryId: newQueryId, tileId: newTileId } };
}

export interface CopyLibraryQuerySqlToVariableInput {
  latest: StoredWorkspaceV5;
  workspaceId: string;
  sourceQueryId: string;
  dashboardId: string;
  variableName: string;
}

/**
 * Copy a Library query's SQL TEXT into one Dashboard variable's option-SQL
 * configuration. Nothing else happens: no clone, no tile, no owner, no role, no
 * provider mapping, no lineage. The Library query is left byte-identical, and
 * later edits to it do not reach the copied SQL — this is a copy, not a link.
 *
 * The variable must still be INFERRED from the target Dashboard's panel queries
 * at commit time, by exact case-sensitive name. `From` and `from` are two
 * different variables, and an orphaned configuration (a stored name no panel
 * declares any more) is not a destination at all.
 *
 * SQL is copied AS AUTHORED. Parameterised, cascading or otherwise locally
 * invalid option SQL is stored and then diagnosed by the existing rules in
 * `core/variable-options.ts` — storing it is what lets the user open the
 * variable's tab and fix it. Only genuinely blank SQL is refused, because
 * `withVariableConfig(…, null)` is how a configuration is DELETED and a drag must
 * never mean that.
 */
export function copyLibraryQuerySqlToVariable(
  input: CopyLibraryQuerySqlToVariableInput,
): LibraryAssignmentResult<{ sql: string }> {
  const { latest, workspaceId, sourceQueryId, dashboardId, variableName } = input;

  const resolved = resolveLibrarySource(latest, workspaceId, sourceQueryId);
  if (!resolved.ok) return fail(resolved.reason);

  const lookup = findDashboardStrict(latest, dashboardId);
  if (lookup.status !== 'ok') {
    return fail(lookup.status === 'missing' ? 'dashboard-missing' : 'dashboard-ambiguous');
  }
  const base = lookup.dashboard;

  // Re-derive from the LATEST target Dashboard rather than trusting what the tree
  // rendered: a concurrent edit can have removed the panel that declared this
  // variable, which turns the drop target into an orphan mid-drag.
  const variable = inferDashboardVariables({
    tiles: base.tiles,
    queries: latest.queries,
    variableConfigs: base.variableConfigs,
  }).find((candidate) => candidate.name === variableName);
  if (!variable || variable.status === 'orphaned') return fail('variable-not-inferred');

  // Checked LAST of the aborts, so the reason names the most specific thing that
  // is wrong. Blank-first would tell a user whose target Dashboard had just been
  // deleted to go and fix a tab on a Dashboard that no longer exists.
  const sql = normalizeVariableSql(resolved.source.sql);
  if (sql === null) return fail('blank-sql');

  // The same shape the variable tab's own Save writes (`ui/app.ts` saveVariableTab),
  // so a drop and a Save are indistinguishable in storage. `withVariableConfig`
  // owns the single revision bump.
  const next = withVariableConfig(latest, dashboardId, variableName, {
    sql,
    ...(variable.type === null ? {} : { lastKnownType: variable.type }),
  }) as StoredWorkspaceV5;

  return { ok: true, workspace: next, data: { sql } };
}
