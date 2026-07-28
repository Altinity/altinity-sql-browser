import { describe, expect, it, vi } from 'vitest';
import {
  createDashboardPanel, panelCreationMessage,
} from '../../src/application/panel-creation-service.js';
import type { MutateWorkspace, WorkspaceExternallyChangedInfo } from '../../src/state.js';
import type { DashboardDocumentV2, StoredWorkspaceV5 } from '../../src/generated/json-schema.types.js';

const dash = (id: string): DashboardDocumentV2 => ({
  documentVersion: 2, id, title: id, revision: 1,
  layout: { type: 'flow', version: 1, preset: 'report', items: {} },
  tiles: [],
});
const ws = (): StoredWorkspaceV5 => ({
  storageVersion: 5, id: 'w', key: 'w', name: 'W', queries: [], dashboards: [dash('d1')],
});

const deps = (
  latest: StoredWorkspaceV5 | null,
  beforeTransform?: () => void,
) => {
  let current = latest;
  const candidates: (StoredWorkspaceV5 | null)[] = [];
  const mutateWorkspace = (async (transform) => {
    beforeTransform?.();
    const transformed = await transform(current);
    const candidate = transformed?.candidate ?? null;
    candidates.push(candidate);
    if (candidate === null) {
      return { ok: false, aborted: true, data: transformed?.data };
    }
    current = candidate;
    return {
      ok: true, workspace: candidate, dashboardRevision: null, data: transformed!.data,
    };
  }) as MutateWorkspace;
  let seq = 0;
  const genId = vi.fn(() => 'id-' + ++seq);
  const onWorkspaceExternallyChanged =
    vi.fn<(info: WorkspaceExternallyChangedInfo) => void>();
  return { mutateWorkspace, genId, onWorkspaceExternallyChanged, candidates };
};

describe('createDashboardPanel', () => {
  it('mints both ids once, commits, reports them, and refreshes query projections', async () => {
    const app = deps(ws());
    const outcome = await createDashboardPanel(app, 'd1', 'Panel', 'Description');

    expect(app.genId).toHaveBeenCalledTimes(2);
    expect(outcome).toMatchObject({
      ok: true, data: { status: 'ok', queryId: 'id-1', tileId: 'id-2' },
    });
    if (!outcome.ok) throw new Error('expected ok');
    expect(app.onWorkspaceExternallyChanged).toHaveBeenCalledWith({
      workspace: outcome.workspace, queriesChanged: true,
    });
  });

  it('re-reads the target at dequeue time and leaves no orphan on a stale target', async () => {
    const latest = ws();
    const app = deps(latest, () => { latest.dashboards = []; });
    const outcome = await createDashboardPanel(app, 'd1', 'Panel', '');

    expect(outcome).toMatchObject({
      ok: false, aborted: true,
      data: { status: 'declined', reason: 'dashboard-missing' },
    });
    expect(app.candidates).toEqual([null]);
    expect(app.onWorkspaceExternallyChanged).not.toHaveBeenCalled();
  });

  it('declines when no workspace is committed', async () => {
    const outcome = await createDashboardPanel(deps(null), 'd1', 'Panel', '');
    expect(outcome).toMatchObject({
      data: { status: 'declined', reason: 'dashboard-missing' },
    });
  });
});

describe('panelCreationMessage', () => {
  it('returns null on success and maps every declined reason', () => {
    const success = {
      ok: true, workspace: ws(), dashboardRevision: null,
      data: { status: 'ok', queryId: 'q', tileId: 't' },
    } as const;
    expect(panelCreationMessage(success)).toBeNull();

    const reasons = {
      'dashboard-missing': 'That dashboard is no longer part of this workspace.',
      'dashboard-ambiguous': 'That dashboard is ambiguous and cannot be changed.',
      'tile-limit': 'That dashboard already has the maximum of 100 panels.',
      'id-collision': 'Could not create this panel because an id already exists. Please try again.',
      'blank-name': 'Enter a panel name.',
    } as const;
    for (const [reason, message] of Object.entries(reasons)) {
      expect(panelCreationMessage({
        ok: false, aborted: true,
        data: { status: 'declined', reason },
      } as never)).toBe(message);
    }
  });

  it('surfaces validation/persistence diagnostics and handles an unclassified abort', () => {
    expect(panelCreationMessage({
      ok: false, aborted: false, diagnostics: [{ message: 'Rejected value' }],
    } as never)).toBe('Rejected value');
    expect(panelCreationMessage({
      ok: false, aborted: false, diagnostics: [],
    } as never)).toBe('Could not save this panel.');
    expect(panelCreationMessage({
      ok: false, aborted: true,
    } as never)).toBe('Could not save this panel.');
  });
});
