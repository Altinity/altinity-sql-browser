// The `mutateWorkspace` plumbing around #494's two atomic deletes.
//
// Split along the same boundary every other Dashboard write in this repo
// holds: the pure transforms are `dashboard/application/dashboard-removal.ts`
// (beside the tile/layout code they compose), and the async, serialized,
// read-latest-at-dequeue commit is here — modeled on
// `dashboard-variable-config.ts` and `dashboard-title.ts`, which is what makes
// three different destructive tree controls behave identically under
// concurrency.
//
// The transform runs INSIDE the queue, so the target is re-resolved and its
// ownership re-proven against committed truth rather than against whatever the
// tree was painting when the confirmation opened. A row can be several seconds
// stale by the time a user reads a confirmation and answers it.
//
// Typed against structural deps rather than the `App` contract:
// `src/application/**` must never import `src/ui/**`
// (build/check-boundaries.mjs).

import {
  removeDashboardDocument, removeDashboardPanel,
} from '../dashboard/application/dashboard-removal.js';
import type { PanelRemovalRefusal } from '../dashboard/application/dashboard-removal.js';
import type {
  MutateWorkspace, WorkspaceExternallyChangedInfo, WorkspaceMutationOutcome,
} from '../state.js';

/** Why the transform declined, threaded back through `mutateWorkspace`'s
 *  `data` channel. `no-workspace` is the primitive's own "nothing is loaded"
 *  case; every other value is the pure transform's refusal, verbatim. */
export type DashboardDeleteAbort = PanelRemovalRefusal | 'dashboard-missing' | 'no-workspace';

export type DashboardDeleteOutcome = WorkspaceMutationOutcome<DashboardDeleteAbort>;

export interface DashboardDeleteDeps {
  mutateWorkspace: MutateWorkspace;
  /** Re-read committed truth: a rendered Dashboard holds its document from
   *  construction, and a deleted panel (or Dashboard) must not stay on screen
   *  after its removal commits. */
  onWorkspaceExternallyChanged(info: WorkspaceExternallyChangedInfo): void;
}

/** One tile, addressed by the ids the row carried — never by label or index. */
export interface PanelDeleteTarget {
  dashboardId: string;
  tileId: string;
  /** The owned query the confirmation named. Carried all the way into the
   *  transform so the delete can refuse a tile that was re-pointed at a
   *  DIFFERENT query while the confirmation was open. */
  queryId: string;
}

/**
 * Remove one panel tile and its dedicated owned query, atomically.
 *
 * `queriesChanged: true` is a fact, not a default: this write deletes a query,
 * so a rendered Dashboard has to rebuild its viewer session rather than merely
 * re-read a document.
 */
export async function commitPanelRemoval(
  deps: DashboardDeleteDeps, target: PanelDeleteTarget,
): Promise<DashboardDeleteOutcome> {
  const outcome = await deps.mutateWorkspace<DashboardDeleteAbort>((latest) => {
    if (latest === null) return { candidate: null, data: 'no-workspace' };
    const result = removeDashboardPanel({ workspace: latest, ...target });
    return result.status === 'refused'
      ? { candidate: null, data: result.reason }
      : { candidate: result.workspace };
  });
  if (outcome.ok) {
    deps.onWorkspaceExternallyChanged({ workspace: outcome.workspace, queriesChanged: true });
  }
  return outcome;
}

/** Remove one whole Dashboard document and the queries its panels own. */
export async function commitDashboardRemoval(
  deps: DashboardDeleteDeps, dashboardId: string,
): Promise<DashboardDeleteOutcome> {
  const outcome = await deps.mutateWorkspace<DashboardDeleteAbort>((latest) => {
    if (latest === null) return { candidate: null, data: 'no-workspace' };
    const result = removeDashboardDocument({ workspace: latest, dashboardId });
    return result.status === 'refused'
      ? { candidate: null, data: result.reason }
      : { candidate: result.workspace };
  });
  if (outcome.ok) {
    deps.onWorkspaceExternallyChanged({ workspace: outcome.workspace, queriesChanged: true });
  }
  return outcome;
}

/**
 * What to tell the user about a delete — `null` when it succeeded and the
 * disappearing row is its own report.
 *
 * Every refusal gets a sentence that says what the DATA did, because none of
 * them is something the user did wrong and all of them mean "nothing was
 * deleted". The missing-resource wording matches the one #429 phase 1 settled
 * for `openSavedQuery`, so the tree speaks with one voice about resources that
 * vanished under it.
 */
export function dashboardDeleteMessage(outcome: DashboardDeleteOutcome): string | null {
  if (outcome.ok) return null;
  if (!outcome.aborted) {
    return '✕ ' + (outcome.diagnostics[0]?.message || 'Could not save workspace');
  }
  switch (outcome.data) {
    case 'dashboard-missing':
      return 'That dashboard is no longer part of this workspace.';
    case 'tile-missing':
      return 'That panel is no longer part of this dashboard.';
    case 'ownership-unproven':
      return 'This panel’s query is shared, missing or not a panel query, so nothing was deleted.';
    case 'tile-retargeted':
      return 'That panel now shows a different query, so nothing was deleted.';
    case 'tile-duplicate':
      return 'This workspace has two resources with the same id, so nothing was deleted.';
    case 'dashboard-duplicate':
      return 'This workspace has two dashboards with the same id, so nothing was deleted.';
    // `no-workspace` — nothing is loaded, so nothing was lost and there is
    // nothing the user can act on.
    default:
      return null;
  }
}
