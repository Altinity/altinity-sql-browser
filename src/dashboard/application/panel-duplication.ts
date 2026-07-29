// Duplicating one Dashboard PANEL (#535) — the pure semantic transform behind the
// tile head's duplicate action.
//
// ── Why this is a workspace transform and not just a Dashboard command ──────
// #427 makes every panel tile the SOLE owner of a dedicated saved-query copy, so
// a second tile pointing at the source's `queryId` is not a duplicate panel — it
// is an invalid workspace (`dashboard-query-multiple-owners`,
// `model/workspace-semantics.ts`). Duplicating therefore has to mint a second
// owned copy alongside the second tile, which spans `queries[]` AND
// `dashboards[]`. That is the same two-resource shape #428's Library assignment
// has, and this module is deliberately modelled on `copyLibraryQueryToPanel`.
//
// The tile work itself stays in the command layer (`duplicate-tile`), so "insert
// after the source, carrying its presentation and its size" is one tested atomic
// step rather than a hand-rolled `tiles.splice` here.
//
// ── What a duplicate is ─────────────────────────────────────────────────────
// A copy of what the user is looking at, positioned where they would expect it:
// the same SQL, the same Spec, the same panel presentation, the same size, placed
// immediately AFTER the source rather than appended at the end of the document.
// Nothing records that it is a copy — #428 forbade persisting copy lineage and
// there is no reason for a duplicate to be different.
//
// The copy keeps the source's NAME. Two identically-named panels are exactly what
// "duplicate" asks for, no name-uniqueness rule exists for saved queries, and a
// "… copy" suffix would be a permanent piece of interface debris in the one place
// the user is most likely to rename by hand anyway.
//
// Pure — no DOM, no persistence, and no ids invented here (see #428's reasoning:
// the caller mints them once per press from the injected `randomUUID` seam, so a
// re-applied command descriptor can never become a second panel).

import { applyCommand } from './dashboard-commands.js';
import type { ApplyCommandResult } from './dashboard-commands.js';
import { createQueryResolver } from './dashboard-query-resolver.js';
import { resolveLayoutPluginSync } from '../layouts/layout-registry.js';
import { cloneQueryForDashboardOwner } from '../model/query-ownership.js';
import { findDashboardStrict, replaceDashboard } from '../../workspace/workspace-dashboards.js';
import type { StoredWorkspaceV5 } from '../../generated/json-schema.types.js';

/** Why a duplication declined — every one an ordinary concurrent-state outcome
 *  the UI phrases for itself, never a thrown error. */
export type PanelDuplicationAbort =
  /** The Dashboard was deleted (or replaced by an import) while the press was in
   *  flight. */
  | 'dashboard-missing'
  /** Two Dashboards share the target id. Never "repair" that by guessing one. */
  | 'dashboard-ambiguous'
  /** The source tile is gone from the Dashboard. */
  | 'tile-missing'
  /** The tile's own query is absent from the collection. A tile in that state is
   *  already rendering its own missing-query error; there is nothing to copy. */
  | 'source-missing'
  /** A minted id is already taken. Effectively impossible with `randomUUID`, but
   *  a pure transform does not get to assume its inputs are unique. */
  | 'id-collision';

export type PanelDuplicationResult =
  | { ok: true; workspace: StoredWorkspaceV5; data: { queryId: string; tileId: string } }
  | { ok: false; reason: PanelDuplicationAbort };

const fail = (reason: PanelDuplicationAbort): PanelDuplicationResult => ({ ok: false, reason });

export interface DuplicateDashboardPanelInput {
  latest: StoredWorkspaceV5;
  dashboardId: string;
  tileId: string;
  newQueryId: string;
  newTileId: string;
}

/**
 * Duplicate one panel: a dedicated owned clone appended to `queries[]`, and a
 * copy of the tile inserted immediately after the source in that Dashboard's
 * `tiles[]`, carrying the source's placement.
 *
 * Exactly one revision bump, on the target Dashboard only.
 */
export function duplicateDashboardPanel(input: DuplicateDashboardPanelInput): PanelDuplicationResult {
  const { latest, dashboardId, tileId, newQueryId, newTileId } = input;

  const lookup = findDashboardStrict(latest, dashboardId);
  if (lookup.status !== 'ok') {
    return fail(lookup.status === 'missing' ? 'dashboard-missing' : 'dashboard-ambiguous');
  }
  const base = lookup.dashboard;

  const sourceTile = base.tiles.find((tile) => tile.id === tileId);
  if (!sourceTile) return fail('tile-missing');
  const source = latest.queries.find((query) => query.id === sourceTile.queryId);
  if (!source) return fail('source-missing');

  // Query ids are workspace-wide; tile ids are Dashboard-local (see
  // `dashboard-duplicate-tile-id` in `model/workspace-semantics.ts`, which scopes
  // its index per Dashboard), so each is checked against the scope that owns it.
  if (latest.queries.some((query) => query.id === newQueryId)) return fail('id-collision');
  if (base.tiles.some((tile) => tile.id === newTileId)) return fail('id-collision');

  // The source is ALREADY a panel-owned copy, so this re-clone is a no-op for
  // `role` and `favorite` — it is used anyway because it is the one definition of
  // "the document a Dashboard member owns", and re-deriving it here would be a
  // second one that could drift.
  const clone = cloneQueryForDashboardOwner({ source, newId: newQueryId });
  const queries = [...latest.queries, clone];

  // `applyCommand` can only fail here for a tile or query it cannot resolve, and
  // both were just resolved above — against the very collection the clone was
  // added to. That branch is therefore unreachable, so it is asserted rather than
  // handled: the coverage config forbids defensive branches no test can reach.
  const applied = applyCommand(base, { type: 'duplicate-tile', tileId, newTileId, queryId: newQueryId }, {
    resolver: createQueryResolver(queries),
    // `duplicate-tile` takes both ids from the COMMAND, so this seam is never
    // called. Retained as the pre-existing bound native the Dashboard route uses
    // for the same reason (`ctxFor`, ui/dashboard.ts) rather than a local lambda
    // no test could reach — the coverage config counts an uncalled function.
    genTileId: String.prototype.toString.bind('tile'),
    plugin: resolveLayoutPluginSync(base.layout),
  }) as Extract<ApplyCommandResult, { ok: true }>;

  // `applyCommand` seeds placement and the grid fallback but deliberately leaves
  // `normalize` to its callers, as every other call site does.
  const normalized = resolveLayoutPluginSync(applied.dashboard.layout).normalize(applied.dashboard);

  // `replaceDashboard` answers `null` for an ambiguous id — already excluded
  // above, but it is the write-side guard and re-running it costs nothing.
  const next = replaceDashboard({ ...latest, queries }, dashboardId, {
    ...normalized, revision: base.revision + 1,
  }) as StoredWorkspaceV5;

  return { ok: true, workspace: next, data: { queryId: newQueryId, tileId: newTileId } };
}
