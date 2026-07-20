// Legacy migration marker (#280 "Legacy migration marker", Phase 2 of #280 /
// issue #284). One-shot conversion of the pre-aggregate flat localStorage
// state into one atomic StoredWorkspaceV1:
//
//   1. read legacy values (the caller supplies them — this module is pure);
//   2. build one candidate StoredWorkspaceV1;
//   3. create the initial Dashboard from legacy favorites (`spec.favorite`);
//   4. convert the legacy layout preferences (asb:dashLayout/asb:dashCols) to a
//      valid flow@1 layout;
//   5. validate the WHOLE candidate (via the repository's commit);
//   6. persist it atomically;
//   7. treat a successful aggregate write as migration completion.
//
// The marker is aggregate RECORD EXISTENCE — migration runs only when the
// store holds no record (checked via `store.read()`), never keyed on
// loadCurrent validity, so a present-but-corrupt aggregate is never clobbered
// by a re-run. Legacy keys are NEVER deleted or modified here: Phase 2 still
// serves the favorites-driven UI off them, and #280 forbids touching them
// before the aggregate write succeeds. Removing the legacy reads (and the
// `spec.favorite` dual-write) is the documented Phase 3-5 removal path, not
// this phase.
//
// Pure over injected seams: the query-collection is decoded by the caller, the
// ID generator is injected, and persistence goes through the injected
// WorkspaceStore/WorkspaceRepository — no DOM, no storage, no crypto import.

import { queryFavorite } from '../core/saved-query.js';
import { activeDashboardView } from '../core/dashboard.js';
import { queryDashboardRole } from '../dashboard/model/workspace-semantics.js';
import { CURRENT_STORAGE_VERSION, DEFAULT_WORKSPACE_NAME } from './workspace-operations.js';
import type { WorkspaceIdGen } from './workspace-operations.js';
import type { WorkspaceStore } from './workspace-store.types.js';
import type { WorkspaceRepository, WorkspaceCommitResult } from './workspace-repository.js';
import type { WorkspaceDiagnostic } from '../dashboard/model/workspace-diagnostics.js';
import type {
  FlowPresetV1, SavedQueryV2, StoredWorkspaceV1,
} from '../generated/json-schema.types.js';

/** The flat legacy persistence the caller reads out of localStorage before
 *  migrating: the decoded saved-query collection (asb:saved), the Library name
 *  (asb:libraryName), and the two Dashboard layout preferences
 *  (asb:dashLayout/asb:dashCols). */
export interface LegacyWorkspaceInput {
  name: string;
  queries: readonly SavedQueryV2[];
  dashLayout: string;
  dashCols: number;
}

/** Map the legacy Dashboard layout preferences to a normative flow@1 preset.
 *  Reuses the existing `activeDashboardView` derivation (core/dashboard.ts) and
 *  remaps its `wide` value to the nearest valid single-column flow preset,
 *  `report` (#321: `full-width` was removed from flow@1 entirely); `report`,
 *  `columns-2`, and `columns-3` already match the flow preset names. */
export function legacyLayoutToFlowPreset(dashLayout: string, dashCols: number): FlowPresetV1 {
  const view = activeDashboardView({ dashLayout, dashCols });
  return view === 'wide' ? 'report' : view;
}

/** Build the one candidate StoredWorkspaceV1 from the legacy state (steps 2-4).
 *  The initial Dashboard's tiles are the PANEL-role favorites in catalog order:
 *  a favorited filter/setup-role query cannot be a tile by the #280 contract,
 *  so it is not turned into one (it stays in the query collection). The
 *  Dashboard is always created so the legacy layout preference is preserved
 *  even for a user with no favorites yet; it starts at revision 1. `genId` is
 *  called once for the workspace ID, once for the Dashboard ID, and once per
 *  tile. The candidate is NOT validated here — the caller validates the whole
 *  thing through `repository.commit`. */
export function buildLegacyMigrationCandidate(
  legacy: LegacyWorkspaceInput, genId: WorkspaceIdGen,
): StoredWorkspaceV1 {
  const name = legacy.name.trim() ? legacy.name : DEFAULT_WORKSPACE_NAME;
  const queries = [...legacy.queries];
  const workspaceId = genId();
  const dashboardId = genId();
  const tiles = queries
    .filter((query) => queryFavorite(query) && queryDashboardRole(query) === 'panel')
    .map((query) => ({ id: genId(), queryId: query.id }));
  return {
    storageVersion: CURRENT_STORAGE_VERSION,
    id: workspaceId,
    name,
    queries,
    dashboard: {
      documentVersion: 1,
      id: dashboardId,
      title: name,
      revision: 1,
      layout: {
        type: 'flow',
        version: 1,
        preset: legacyLayoutToFlowPreset(legacy.dashLayout, legacy.dashCols),
        items: {},
      },
      filters: [],
      tiles,
    },
  };
}

/** The outcome of `migrateLegacyWorkspaceIfNeeded`. `migrated: false` with
 *  `reason: 'aggregate-exists'` means the marker found a record and skipped;
 *  `reason: 'commit-failed'` carries the whole-candidate validation or
 *  persistence diagnostics (legacy keys were left intact). */
export type MigrationResult =
  | { migrated: true; result: Extract<WorkspaceCommitResult, { ok: true }> }
  | { migrated: false; reason: 'aggregate-exists' }
  | { migrated: false; reason: 'commit-failed'; diagnostics: WorkspaceDiagnostic[] };

export interface MigrationDeps {
  /** Checked for record existence — the migration marker. */
  store: WorkspaceStore;
  /** The repository whose atomic `commit` validates + persists the candidate. */
  repository: WorkspaceRepository;
  legacy: LegacyWorkspaceInput;
  genId: WorkspaceIdGen;
}

/** Run the one-shot migration when — and only when — no aggregate record
 *  exists yet. Idempotent: once the aggregate persists, a later call finds the
 *  record and returns `aggregate-exists` without rebuilding or rewriting. A
 *  failed commit leaves the store (and every legacy key) untouched, so a retry
 *  on the next load is safe. */
export async function migrateLegacyWorkspaceIfNeeded(deps: MigrationDeps): Promise<MigrationResult> {
  const { store, repository, legacy, genId } = deps;
  const existing = await store.read();
  if (existing !== null) return { migrated: false, reason: 'aggregate-exists' };
  const candidate = buildLegacyMigrationCandidate(legacy, genId);
  const result = await repository.commit(candidate);
  if (!result.ok) return { migrated: false, reason: 'commit-failed', diagnostics: result.diagnostics };
  return { migrated: true, result };
}
