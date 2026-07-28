// The async application command around the pure blank-Panel candidate (#515).
// IDs are minted exactly once per Add attempt, then the target and all limits
// are re-resolved inside `mutateWorkspace` against committed dequeue-time truth.

import { createPanelCandidate } from '../dashboard/application/panel-creation.js';
import type { PanelCreationAbort } from '../dashboard/application/panel-creation.js';
import type {
  MutateWorkspace, WorkspaceExternallyChangedInfo, WorkspaceMutationOutcome,
} from '../state.js';

export type PanelCreationData = { status: 'ok'; queryId: string; tileId: string };
export type PanelCreationDeclined = { status: 'declined'; reason: PanelCreationAbort };
export type PanelCreationOutcome =
  WorkspaceMutationOutcome<PanelCreationData | PanelCreationDeclined>;

export interface PanelCreationDeps {
  mutateWorkspace: MutateWorkspace;
  onWorkspaceExternallyChanged(info: WorkspaceExternallyChangedInfo): void;
  genId(): string;
}

const declined = (
  reason: PanelCreationAbort,
): { candidate: null; data: PanelCreationDeclined } => ({
  candidate: null,
  data: { status: 'declined', reason },
});

export async function createDashboardPanel(
  deps: PanelCreationDeps,
  dashboardId: string,
  name: string,
  description: string,
): Promise<PanelCreationOutcome> {
  const queryId = deps.genId();
  const tileId = deps.genId();
  const outcome = await deps.mutateWorkspace<PanelCreationData | PanelCreationDeclined>((latest) => {
    if (latest === null) return declined('dashboard-missing');
    const result = createPanelCandidate({
      latest, dashboardId, queryId, tileId, name, description,
    });
    if (!result.ok) return declined(result.reason);
    return { candidate: result.workspace, data: { status: 'ok', ...result.data } };
  });
  if (outcome.ok) {
    deps.onWorkspaceExternallyChanged({ workspace: outcome.workspace, queriesChanged: true });
  }
  return outcome;
}

const DECLINE_MESSAGES: Record<PanelCreationAbort, string> = {
  'dashboard-missing': 'That dashboard is no longer part of this workspace.',
  'dashboard-ambiguous': 'That dashboard is ambiguous and cannot be changed.',
  'tile-limit': 'That dashboard already has the maximum of 100 panels.',
  'id-collision': 'Could not create this panel because an id already exists. Please try again.',
  'blank-name': 'Enter a panel name.',
};

/** A dialog diagnostic, or `null` only for a committed creation. */
export function panelCreationMessage(outcome: PanelCreationOutcome): string | null {
  if (outcome.ok) return null;
  if (!outcome.aborted) {
    return outcome.diagnostics[0]?.message || 'Could not save this panel.';
  }
  const data = outcome.data;
  return data?.status === 'declined' ? DECLINE_MESSAGES[data.reason] : 'Could not save this panel.';
}
