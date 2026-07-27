// #429 phase 3 — the async half of committing a Dashboard rename. The pure
// transform it wraps is covered in `workspace-dashboards.test.ts`
// (`renameDashboard`); what is tested here is the plumbing: that committed
// truth is read at dequeue time, that each distinct failure stays
// distinguishable to the caller, and that a rendered surface is poked only on
// a real commit. Modeled directly on `dashboard-variable-config.test.ts`.

import { describe, expect, it, vi } from 'vitest';
import { commitDashboardRename } from '../../src/application/dashboard-title.js';
import type { DashboardRenameDeps } from '../../src/application/dashboard-title.js';
import type {
  DashboardDocumentV2, StoredWorkspaceV5,
} from '../../src/generated/json-schema.types.js';
import type { MutateWorkspace, WorkspaceExternallyChangedInfo } from '../../src/state.js';

const dash = (id: string, over: Partial<DashboardDocumentV2> = {}): DashboardDocumentV2 => ({
  documentVersion: 2, id, title: id.toUpperCase(), revision: 1,
  layout: { type: 'flow', version: 1, preset: 'report', items: {} },
  tiles: [], ...over,
});
const ws = (dashboards: DashboardDocumentV2[]): StoredWorkspaceV5 => ({
  storageVersion: 5, id: 'w1', key: 'workspace', name: 'W', queries: [], dashboards,
});

/**
 * A `mutateWorkspace` that behaves like the real one: it hands the transform
 * `latest` (committed truth at dequeue time, NOT a caller snapshot), records
 * the candidate, and maps a null candidate to an abort that carries the
 * transform's own `data` channel.
 */
const fakeMutate = (latest: StoredWorkspaceV5 | null) => {
  const committed: (StoredWorkspaceV5 | null)[] = [];
  const mutateWorkspace = (async (transform) => {
    const input = await transform(latest);
    const candidate = input === null ? null : input.candidate;
    committed.push(candidate);
    if (candidate === null) {
      return { ok: false, aborted: true, data: input === null ? undefined : input.data };
    }
    return { ok: true, workspace: candidate, dashboardRevision: null, data: input!.data };
  }) as MutateWorkspace;
  return { mutateWorkspace, committed };
};

// A standalone const with its real signature before it ever enters an object
// literal: inlining `vi.fn()` into a literal typed against `DashboardRenameDeps`
// collapses its inferred call signature and the assignment stops type-checking.
const pokeMock = () => vi.fn<(info: WorkspaceExternallyChangedInfo) => void>();

const deps = (latest: StoredWorkspaceV5 | null) => {
  const { mutateWorkspace, committed } = fakeMutate(latest);
  const onWorkspaceExternallyChanged = pokeMock();
  const bag: DashboardRenameDeps = { mutateWorkspace, onWorkspaceExternallyChanged };
  return { ...bag, committed, onWorkspaceExternallyChanged };
};

describe('commitDashboardRename', () => {
  it('commits the new title into the addressed Dashboard', async () => {
    const workspace = ws([dash('sales'), dash('ops')]);
    const app = deps(workspace);
    const outcome = await commitDashboardRename(app, 'sales', 'Sales revenue');

    expect(outcome.ok).toBe(true);
    expect(app.committed[0]!.dashboards[0].title).toBe('Sales revenue');
    expect(app.committed[0]!.dashboards[1]).toBe(workspace.dashboards[1]);
  });

  it('commits a description alongside the title', async () => {
    const app = deps(ws([dash('sales')]));
    const outcome = await commitDashboardRename(app, 'sales', 'Sales', 'Quarterly revenue');

    expect(outcome.ok).toBe(true);
    expect(app.committed[0]!.dashboards[0].description).toBe('Quarterly revenue');
  });

  it('asks a rendered surface to re-read committed truth after a real commit', async () => {
    const app = deps(ws([dash('sales')]));
    await commitDashboardRename(app, 'sales', 'Sales revenue');

    // `queriesChanged: false` is a fact: this write cannot add, remove or edit
    // a query.
    expect(app.onWorkspaceExternallyChanged).toHaveBeenCalledExactlyOnceWith({
      workspace: app.committed[0], queriesChanged: false,
    });
  });

  it('commits nothing, and declines explicitly, when there is no workspace at all', async () => {
    const app = deps(null);
    const outcome = await commitDashboardRename(app, 'sales', 'Sales revenue');

    expect(outcome).toEqual({ ok: false, aborted: true, data: 'declined' });
    expect(app.committed).toEqual([null]);
    expect(app.onWorkspaceExternallyChanged).not.toHaveBeenCalled();
  });

  it('commits nothing, and declines explicitly, when the Dashboard is gone', async () => {
    const app = deps(ws([dash('ops')]));
    const outcome = await commitDashboardRename(app, 'sales', 'Sales revenue');

    expect(outcome).toEqual({ ok: false, aborted: true, data: 'declined' });
    expect(app.committed).toEqual([null]);
    expect(app.onWorkspaceExternallyChanged).not.toHaveBeenCalled();
  });

  it('commits nothing, and declines explicitly, for an AMBIGUOUS Dashboard id', async () => {
    const app = deps(ws([dash('dup'), dash('dup')]));
    const outcome = await commitDashboardRename(app, 'dup', 'Sales revenue');

    expect(outcome).toEqual({ ok: false, aborted: true, data: 'declined' });
    expect(app.onWorkspaceExternallyChanged).not.toHaveBeenCalled();
  });

  it('commits nothing, and declines explicitly, for a whitespace-only title', async () => {
    const app = deps(ws([dash('sales')]));
    const outcome = await commitDashboardRename(app, 'sales', '   ');

    expect(outcome).toEqual({ ok: false, aborted: true, data: 'declined' });
    expect(app.committed).toEqual([null]);
    expect(app.onWorkspaceExternallyChanged).not.toHaveBeenCalled();
  });

  it('leaves an abort it did NOT cause distinguishable from its own refusal', async () => {
    const app: DashboardRenameDeps = {
      mutateWorkspace: (async () => ({ ok: false, aborted: true })) as MutateWorkspace,
      onWorkspaceExternallyChanged: pokeMock(),
    };
    const outcome = await commitDashboardRename(app, 'sales', 'Sales revenue');

    expect(outcome).toEqual({ ok: false, aborted: true });
    expect(outcome.ok === false && outcome.aborted && outcome.data).toBeUndefined();
    expect(app.onWorkspaceExternallyChanged).not.toHaveBeenCalled();
  });

  it('passes a commit rejection through with its diagnostics', async () => {
    const app: DashboardRenameDeps = {
      mutateWorkspace: (async () => ({
        ok: false,
        diagnostics: [{ path: ['dashboards', 0, 'title'], severity: 'error', code: 'x', message: 'rejected' }],
      })) as MutateWorkspace,
      onWorkspaceExternallyChanged: pokeMock(),
    };
    const outcome = await commitDashboardRename(app, 'sales', 'Sales revenue');

    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && !outcome.aborted && outcome.diagnostics[0].message).toBe('rejected');
    expect(app.onWorkspaceExternallyChanged).not.toHaveBeenCalled();
  });
});
