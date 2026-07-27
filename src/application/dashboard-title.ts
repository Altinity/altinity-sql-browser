// Committing ONE Dashboard's title/description rename (#429 phase 3).
//
// Split along the layer boundary this repo holds everywhere else:
//   - the PURE transform is `workspace/workspace-dashboards.ts`'s
//     `renameDashboard`, beside `findDashboard`/`replaceDashboard` and the
//     exactly-one-match rule it depends on;
//   - the async `mutateWorkspace` plumbing is here, modeled directly on
//     `dashboard-variable-config.ts`'s `commitVariableConfig` (#457's own
//     precedent for an id-addressed, workspace-level Dashboard write).
//
// This module is deliberately typed against a structural `MutateWorkspace`
// rather than the `App` contract: `src/application/**` must never import
// `src/ui/**` (build/check-boundaries.mjs), and a real `App` (or the tree's
// narrower `DashboardTreeApp`) satisfies the shape below directly.

import type {
  MutateWorkspace, WorkspaceExternallyChangedInfo, WorkspaceMutationOutcome,
} from '../state.js';
import { renameDashboard } from '../workspace/workspace-dashboards.js';

/** Why the transform itself declined, threaded back through `mutateWorkspace`'s
 *  `data` channel — the ONE abort this module can explain: the Dashboard no
 *  longer resolves (deleted/duplicate-id concurrently) or the trimmed title was
 *  blank. Every other `aborted` outcome comes from the primitive itself (the
 *  route moved, the workspace vanished). */
export type DashboardRenameAbort = 'declined';

export type DashboardRenameOutcome = WorkspaceMutationOutcome<DashboardRenameAbort>;

/** The narrow slice of the app a title/description write needs. */
export interface DashboardRenameDeps {
  /** The serialized, read-latest-at-dequeue write primitive every workspace
   *  producer commits through. */
  mutateWorkspace: MutateWorkspace;
  /** Re-read the committed workspace so a rendered Dashboard/tree picks up the
   *  new title without waiting for an unrelated repaint. */
  onWorkspaceExternallyChanged(info: WorkspaceExternallyChangedInfo): void;
}

/**
 * Rename one Dashboard's title (and, optionally, description), re-reading
 * committed truth at dequeue time and aborting — committing nothing — when the
 * workspace is gone, the Dashboard id no longer names a single entry, or the
 * trimmed title is blank.
 *
 * Only a real commit pokes `onWorkspaceExternallyChanged`: an aborted
 * transform changed nothing, so there is nothing for a rendered surface to
 * re-read.
 */
export async function commitDashboardRename(
  deps: DashboardRenameDeps,
  dashboardId: string,
  title: string,
  description?: string,
): Promise<DashboardRenameOutcome> {
  const outcome = await deps.mutateWorkspace<DashboardRenameAbort>((latest) => {
    if (latest === null) return { candidate: null, data: 'declined' };
    const candidate = renameDashboard(latest, dashboardId, title, description);
    return candidate === null ? { candidate: null, data: 'declined' } : { candidate };
  });
  // `queriesChanged: false` is a fact, not a default: this write touches
  // exactly one Dashboard's title/description/revision and can never add,
  // remove or edit a query.
  if (outcome.ok) {
    deps.onWorkspaceExternallyChanged({ workspace: outcome.workspace, queriesChanged: false });
  }
  return outcome;
}
