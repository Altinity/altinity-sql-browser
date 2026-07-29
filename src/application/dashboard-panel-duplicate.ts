// The `mutateWorkspace` plumbing around #535's panel duplication.
//
// Split along the same boundary every other Dashboard write in this repo holds:
// the pure transform is `dashboard/application/panel-duplication.ts` (beside the
// tile/layout code it composes), and the async, serialized,
// read-latest-at-dequeue commit is here — modeled on
// `library-assignment-service.ts`, whose panel path is the same two-resource
// write (a dedicated owned query clone plus a tile).
//
// Deliberately NOT the Dashboard route's own optimistic `runCommand` queue, for a
// worse reason than "it would flicker":
//
//   - `session.syncDocument` REORDERS existing tile runtimes and drops any id it
//     has no runtime for; it never creates one. An optimistically published
//     duplicate would therefore not render at all — no card, no tile count — not
//     even as a missing-query error.
//   - The self-heal is defeated too. `settleCommand`'s membership-restore detector
//     compares the rebased document against the tile ids of the document last
//     handed to `syncSessionDocument`, and the optimistic publish already recorded
//     the new id — so it sees nothing to restore and no rebuild is scheduled. The
//     panel would stay invisible until some unrelated event rebuilt the route.
//
// `queriesChanged: true` here rebuilds the route from committed truth instead,
// which is the same settlement a Library drop already uses to make a brand-new
// panel appear. The cost is honest and worth knowing: that rebuild re-runs EVERY
// tile's query, so duplicating one panel refetches the page.
//
// Typed against structural deps rather than the `App` contract:
// `src/application/**` must never import `src/ui/**` (build/check-boundaries.mjs).

import { duplicateDashboardPanel } from '../dashboard/application/panel-duplication.js';
import type { PanelDuplicationAbort } from '../dashboard/application/panel-duplication.js';
import type {
  MutateWorkspace, WorkspaceExternallyChangedInfo, WorkspaceMutationOutcome,
} from '../state.js';

/** Why the transform declined, threaded back through `mutateWorkspace`'s `data`
 *  channel: the pure transform's refusals verbatim, plus the primitive's own
 *  "nothing is loaded" case. */
export type PanelDuplicateAbort = PanelDuplicationAbort | 'no-workspace';

export interface PanelDuplicateData {
  status: 'ok';
  queryId: string;
  tileId: string;
}

export type PanelDuplicateOutcome =
  WorkspaceMutationOutcome<PanelDuplicateData | { status: 'declined'; reason: PanelDuplicateAbort }>;

export interface PanelDuplicateDeps {
  /** The serialized, read-latest-at-dequeue write primitive every workspace
   *  producer commits through. */
  mutateWorkspace: MutateWorkspace;
  /** "Re-read the committed workspace": this write adds both a query and a tile,
   *  so the rendered Dashboard has to rebuild its viewer session rather than
   *  merely re-read a document. */
  onWorkspaceExternallyChanged(info: WorkspaceExternallyChangedInfo): void;
  /** The injected `crypto.randomUUID` seam. */
  genId(): string;
}

/** One panel, addressed by the ids the tile carried — never by label or index. */
export interface PanelDuplicateTarget {
  dashboardId: string;
  tileId: string;
}

/**
 * Duplicate one panel.
 *
 * Both ids are minted OUTSIDE the transform, once per call rather than once per
 * dequeue: a retry of the same press must not silently become two panels.
 */
export async function commitPanelDuplication(
  deps: PanelDuplicateDeps, target: PanelDuplicateTarget,
): Promise<PanelDuplicateOutcome> {
  const newQueryId = deps.genId();
  const newTileId = deps.genId();
  const outcome = await deps.mutateWorkspace<PanelDuplicateData | { status: 'declined'; reason: PanelDuplicateAbort }>((latest) => {
    if (latest === null) return { candidate: null, data: { status: 'declined', reason: 'no-workspace' } };
    const result = duplicateDashboardPanel({ latest, ...target, newQueryId, newTileId });
    if (!result.ok) return { candidate: null, data: { status: 'declined', reason: result.reason } };
    return { candidate: result.workspace, data: { status: 'ok', ...result.data } };
  });
  if (outcome.ok) {
    deps.onWorkspaceExternallyChanged({ workspace: outcome.workspace, queriesChanged: true });
  }
  return outcome;
}

const DECLINE_MESSAGES: Record<PanelDuplicateAbort, string> = {
  'no-workspace': 'Could not duplicate this panel — no workspace is loaded',
  'dashboard-missing': 'That dashboard is no longer part of this workspace.',
  'dashboard-ambiguous': 'This workspace has two resources with the same id, so nothing was duplicated.',
  'tile-missing': 'That panel is no longer part of this dashboard.',
  'source-missing': 'That panel’s query is no longer part of this workspace.',
  'id-collision': 'Could not duplicate this panel — please try again',
};

/**
 * What to tell the user about a duplication — `null` when it succeeded and the
 * new tile appearing is its own report.
 *
 * The missing-resource wording matches `dashboardDeleteMessage`, so every
 * Dashboard control speaks with one voice about resources that vanished under it.
 */
export function panelDuplicateMessage(outcome: PanelDuplicateOutcome): string | null {
  if (outcome.ok) return null;
  if (!outcome.aborted) {
    return '✕ ' + (outcome.diagnostics[0]?.message || 'Could not save workspace');
  }
  const data = outcome.data;
  if (!data || data.status !== 'declined') return null;
  return DECLINE_MESSAGES[data.reason];
}
