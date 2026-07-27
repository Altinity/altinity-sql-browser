// #494 — the async `mutateWorkspace` plumbing around the two atomic deletes.
// The pure transforms (`removeDashboardPanel`/`removeDashboardDocument`) are
// covered in `dashboard-removal.test.ts`; what is tested here is the
// plumbing: committed truth is read at DEQUEUE time (never a pre-queue
// snapshot), every refusal reason is threaded through `mutateWorkspace`'s
// `data` channel untouched, a rendered surface is poked only on a real
// commit, and `dashboardDeleteMessage` reports each outcome in one voice.
// Modeled directly on `dashboard-title.test.ts`.

import { describe, expect, it, vi } from 'vitest';
import {
  commitDashboardRemoval, commitPanelRemoval, dashboardDeleteMessage,
} from '../../src/application/dashboard-delete.js';
import type {
  DashboardDeleteAbort, DashboardDeleteDeps, DashboardDeleteOutcome,
} from '../../src/application/dashboard-delete.js';
import { removeDashboardDocument, removeDashboardPanel } from '../../src/dashboard/application/dashboard-removal.js';
import type {
  DashboardDocumentV2, SavedQueryV2, StoredWorkspaceV5,
} from '../../src/generated/json-schema.types.js';
import type { MutateWorkspace, WorkspaceExternallyChangedInfo } from '../../src/state.js';
import type { WorkspaceDiagnostic } from '../../src/dashboard/model/workspace-diagnostics.js';

const panelQuery = (id: string): SavedQueryV2 => ({
  id, sql: 'SELECT 1', specVersion: 1, spec: { name: id, dashboard: { role: 'panel' } },
} as SavedQueryV2);

const dash = (over: Partial<DashboardDocumentV2> = {}): DashboardDocumentV2 => ({
  documentVersion: 2, id: 'dash', title: 'D', revision: 1,
  layout: { type: 'flow', version: 1, preset: 'report', items: {} },
  tiles: [], ...over,
} as DashboardDocumentV2);

const ws = (over: Partial<StoredWorkspaceV5> = {}): StoredWorkspaceV5 => ({
  storageVersion: 5, id: 'ws1', key: 'ws1', name: 'W', queries: [], dashboards: [], ...over,
} as StoredWorkspaceV5);

/**
 * A `mutateWorkspace` that behaves like the real one: it hands the transform
 * `latest` (committed truth at dequeue time, NOT a caller snapshot), records
 * every candidate it was asked to commit, and maps a null candidate to an
 * abort that carries the transform's own `data` channel through untouched.
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
// literal: inlining `vi.fn()` into a literal typed against `DashboardDeleteDeps`
// collapses its inferred call signature and the assignment stops type-checking
// (same footgun `dashboard-title.test.ts` avoids the same way).
const pokeMock = () => vi.fn<(info: WorkspaceExternallyChangedInfo) => void>();

const deps = (latest: StoredWorkspaceV5 | null) => {
  const { mutateWorkspace, committed } = fakeMutate(latest);
  const onWorkspaceExternallyChanged = pokeMock();
  const bag: DashboardDeleteDeps = { mutateWorkspace, onWorkspaceExternallyChanged };
  return { ...bag, committed, onWorkspaceExternallyChanged };
};

describe('commitPanelRemoval', () => {
  it('commits exactly the pure transform\'s candidate and reports queriesChanged: true (a query really was deleted)', async () => {
    const latest = ws({
      queries: [panelQuery('p1'), panelQuery('p2')],
      dashboards: [dash({
        tiles: [{ id: 't1', queryId: 'p1' }, { id: 't2', queryId: 'p2' }], revision: 3,
        layout: { type: 'flow', version: 1, preset: 'report', items: { t1: {}, t2: {} } },
      })],
    });
    const expected = removeDashboardPanel({ workspace: latest, dashboardId: 'dash', tileId: 't1', queryId: 'p1' });
    if (expected.status !== 'ok') throw new Error(`expected ok, got ${expected.status}`);

    const app = deps(latest);
    const outcome = await commitPanelRemoval(app, { dashboardId: 'dash', tileId: 't1', queryId: 'p1' });
    if (!outcome.ok) throw new Error(`expected ok, got aborted/rejected`);

    // The wrapper never reimplements the transform — it hands `mutateWorkspace`
    // exactly what `removeDashboardPanel` itself produced from the same input.
    expect(app.committed[0]).toEqual(expected.workspace);
    expect(outcome.workspace).toEqual(expected.workspace);
    // `queriesChanged: true` is a fact, not a default: this write deleted p1.
    expect(app.onWorkspaceExternallyChanged).toHaveBeenCalledExactlyOnceWith({
      workspace: outcome.workspace, queriesChanged: true,
    });
  });

  it('builds the candidate from DEQUEUE-TIME truth, never a snapshot the caller could have seen earlier', async () => {
    // A decoy shape the caller might plausibly have painted its row from —
    // this object is never handed to `mutateWorkspace` at all, so nothing
    // about its structure may appear in the outcome.
    const staleBelief = ws({
      queries: [panelQuery('p1')],
      dashboards: [dash({ tiles: [{ id: 't1', queryId: 'p1' }], revision: 1 })],
    });
    void staleBelief;
    // What the queue actually reads at dequeue time: a third tile has joined
    // since, and the revision has moved on from anything a pre-queue snapshot
    // could have shown.
    const dequeueLatest = ws({
      queries: [panelQuery('p1'), panelQuery('p3')],
      dashboards: [dash({
        tiles: [{ id: 't1', queryId: 'p1' }, { id: 't3', queryId: 'p3' }], revision: 7,
        layout: { type: 'flow', version: 1, preset: 'report', items: { t1: {}, t3: {} } },
      })],
    });
    const app = deps(dequeueLatest);
    const outcome = await commitPanelRemoval(app, { dashboardId: 'dash', tileId: 't1', queryId: 'p1' });
    if (!outcome.ok) throw new Error(`expected ok, got aborted/rejected`);

    // t3/p3 — wholly absent from `staleBelief` — survives, and the revision
    // advanced from the DEQUEUE value (7), never from the stale one (1).
    const changed = outcome.workspace.dashboards[0];
    expect(changed.tiles).toEqual([{ id: 't3', queryId: 'p3' }]);
    expect(changed.revision).toBe(8);
    expect(outcome.workspace.queries.map((q) => q.id)).toEqual(['p3']);
  });

  it('aborts with no-workspace, threaded through data, and commits nothing when nothing is loaded', async () => {
    const app = deps(null);
    const outcome = await commitPanelRemoval(app, { dashboardId: 'dash', tileId: 't1', queryId: 'p1' });

    expect(outcome).toEqual({ ok: false, aborted: true, data: 'no-workspace' });
    expect(app.committed).toEqual([null]);
    expect(app.onWorkspaceExternallyChanged).not.toHaveBeenCalled();
  });

  it('aborts dashboard-missing, threaded through data, and commits nothing', async () => {
    const latest = ws({ dashboards: [dash({ id: 'ops' })] });
    const app = deps(latest);
    const outcome = await commitPanelRemoval(app, { dashboardId: 'dash', tileId: 't1', queryId: 'p1' });

    expect(outcome).toEqual({ ok: false, aborted: true, data: 'dashboard-missing' });
    expect(app.committed).toEqual([null]);
    expect(app.onWorkspaceExternallyChanged).not.toHaveBeenCalled();
  });

  it('aborts dashboard-duplicate, threaded through data, and commits nothing', async () => {
    const latest = ws({
      dashboards: [dash({ id: 'dup', tiles: [{ id: 't1', queryId: 'p1' }] }), dash({ id: 'dup' })],
      queries: [panelQuery('p1')],
    });
    const app = deps(latest);
    const outcome = await commitPanelRemoval(app, { dashboardId: 'dup', tileId: 't1', queryId: 'p1' });

    expect(outcome).toEqual({ ok: false, aborted: true, data: 'dashboard-duplicate' });
    expect(app.committed).toEqual([null]);
    expect(app.onWorkspaceExternallyChanged).not.toHaveBeenCalled();
  });

  it('aborts tile-missing, threaded through data, and commits nothing', async () => {
    const latest = ws({ dashboards: [dash({ tiles: [{ id: 't1', queryId: 'p1' }] })], queries: [panelQuery('p1')] });
    const app = deps(latest);
    const outcome = await commitPanelRemoval(app, { dashboardId: 'dash', tileId: 'ghost', queryId: 'p1' });

    expect(outcome).toEqual({ ok: false, aborted: true, data: 'tile-missing' });
    expect(app.committed).toEqual([null]);
    expect(app.onWorkspaceExternallyChanged).not.toHaveBeenCalled();
  });

  it('aborts ownership-unproven, threaded through data, and commits nothing', async () => {
    const latest = ws({ dashboards: [dash({ tiles: [{ id: 't1', queryId: 'ghost' }] })], queries: [] });
    const app = deps(latest);
    const outcome = await commitPanelRemoval(app, { dashboardId: 'dash', tileId: 't1', queryId: 'ghost' });

    expect(outcome).toEqual({ ok: false, aborted: true, data: 'ownership-unproven' });
    expect(app.committed).toEqual([null]);
    expect(app.onWorkspaceExternallyChanged).not.toHaveBeenCalled();
  });
});

describe('commitDashboardRemoval', () => {
  it('commits exactly the pure transform\'s candidate and reports queriesChanged: true (queries really were deleted)', async () => {
    const latest = ws({
      queries: [panelQuery('p1'), panelQuery('p2'), panelQuery('shared')],
      dashboards: [
        dash({
          id: 'dash',
          tiles: [{ id: 't1', queryId: 'p1' }, { id: 't2', queryId: 'p2' }, { id: 't3', queryId: 'shared' }],
        }),
        dash({ id: 'dash2', tiles: [{ id: 't9', queryId: 'shared' }] }),
      ],
    });
    const expected = removeDashboardDocument({ workspace: latest, dashboardId: 'dash' });
    if (expected.status !== 'ok') throw new Error(`expected ok, got ${expected.status}`);

    const app = deps(latest);
    const outcome = await commitDashboardRemoval(app, 'dash');
    if (!outcome.ok) throw new Error(`expected ok, got aborted/rejected`);

    expect(app.committed[0]).toEqual(expected.workspace);
    expect(outcome.workspace).toEqual(expected.workspace);
    expect(app.onWorkspaceExternallyChanged).toHaveBeenCalledExactlyOnceWith({
      workspace: outcome.workspace, queriesChanged: true,
    });
  });

  it('builds the candidate from DEQUEUE-TIME truth, never a snapshot the caller could have seen earlier', async () => {
    // Decoy: as far as the caller could tell, 'dash' owned p1 alone and no
    // other Dashboard existed. Never handed to `mutateWorkspace`.
    const staleBelief = ws({
      queries: [panelQuery('p1')],
      dashboards: [dash({ id: 'dash', tiles: [{ id: 't1', queryId: 'p1' }] })],
    });
    void staleBelief;
    // Dequeue-time truth: a second tile on 'dash' now shares a query with a
    // Dashboard the stale belief never knew existed — that query must survive.
    const dequeueLatest = ws({
      queries: [panelQuery('p1'), panelQuery('shared')],
      dashboards: [
        dash({ id: 'dash', tiles: [{ id: 't1', queryId: 'p1' }, { id: 't2', queryId: 'shared' }] }),
        dash({ id: 'dash2', tiles: [{ id: 't9', queryId: 'shared' }] }),
      ],
    });
    const app = deps(dequeueLatest);
    const outcome = await commitDashboardRemoval(app, 'dash');
    if (!outcome.ok) throw new Error(`expected ok, got aborted/rejected`);

    expect(outcome.workspace.dashboards.map((d) => d.id)).toEqual(['dash2']);
    // 'shared' — a reference the stale belief never carried — survives because
    // dash2's own tile (read at dequeue time) still owns it.
    expect(outcome.workspace.queries.map((q) => q.id)).toEqual(['shared']);
  });

  it('aborts with no-workspace, threaded through data, and commits nothing when nothing is loaded', async () => {
    const app = deps(null);
    const outcome = await commitDashboardRemoval(app, 'dash');

    expect(outcome).toEqual({ ok: false, aborted: true, data: 'no-workspace' });
    expect(app.committed).toEqual([null]);
    expect(app.onWorkspaceExternallyChanged).not.toHaveBeenCalled();
  });

  it('aborts dashboard-missing, threaded through data, and commits nothing', async () => {
    const latest = ws({ dashboards: [dash({ id: 'ops' })] });
    const app = deps(latest);
    const outcome = await commitDashboardRemoval(app, 'dash');

    expect(outcome).toEqual({ ok: false, aborted: true, data: 'dashboard-missing' });
    expect(app.committed).toEqual([null]);
    expect(app.onWorkspaceExternallyChanged).not.toHaveBeenCalled();
  });

  it('aborts dashboard-duplicate, threaded through data, and commits nothing', async () => {
    const latest = ws({ dashboards: [dash({ id: 'dup' }), dash({ id: 'dup' })] });
    const app = deps(latest);
    const outcome = await commitDashboardRemoval(app, 'dup');

    expect(outcome).toEqual({ ok: false, aborted: true, data: 'dashboard-duplicate' });
    expect(app.committed).toEqual([null]);
    expect(app.onWorkspaceExternallyChanged).not.toHaveBeenCalled();
  });
});

describe('dashboardDeleteMessage', () => {
  const ok = (): DashboardDeleteOutcome => ({
    ok: true, workspace: ws(), dashboardRevision: null,
  });
  const aborted = (data: DashboardDeleteAbort): DashboardDeleteOutcome => ({ ok: false, aborted: true, data });
  const rejected = (diagnostics: WorkspaceDiagnostic[]): DashboardDeleteOutcome => (
    { ok: false, aborted: false, diagnostics }
  );

  it('reports nothing on success — the disappearing row is its own report', () => {
    expect(dashboardDeleteMessage(ok())).toBeNull();
  });

  it('reports nothing for no-workspace — nothing was lost, nothing to act on', () => {
    expect(dashboardDeleteMessage(aborted('no-workspace'))).toBeNull();
  });

  it('reports the dashboard-missing sentence', () => {
    expect(dashboardDeleteMessage(aborted('dashboard-missing')))
      .toBe('That dashboard is no longer part of this workspace.');
  });

  it('reports the tile-missing sentence', () => {
    expect(dashboardDeleteMessage(aborted('tile-missing')))
      .toBe('That panel is no longer part of this dashboard.');
  });

  it('reports the ownership-unproven sentence', () => {
    expect(dashboardDeleteMessage(aborted('ownership-unproven')))
      .toBe('This panel’s query is shared, missing or not a panel query, so nothing was deleted.');
  });

  it('reports the dashboard-duplicate sentence', () => {
    expect(dashboardDeleteMessage(aborted('dashboard-duplicate')))
      .toBe('This workspace has two dashboards with the same id, so nothing was deleted.');
  });

  it('every one of the four distinct refusal sentences is actually distinct', () => {
    const sentences = new Set([
      dashboardDeleteMessage(aborted('dashboard-missing')),
      dashboardDeleteMessage(aborted('tile-missing')),
      dashboardDeleteMessage(aborted('ownership-unproven')),
      dashboardDeleteMessage(aborted('dashboard-duplicate')),
    ]);
    expect(sentences.size).toBe(4);
  });

  it('reports "✕ " + the first diagnostic for a rejected commit', () => {
    const diagnostics: WorkspaceDiagnostic[] = [
      { path: ['dashboards', 0], severity: 'error', code: 'x', message: 'Persisting the workspace failed' },
    ];
    expect(dashboardDeleteMessage(rejected(diagnostics))).toBe('✕ Persisting the workspace failed');
  });

  it('falls back to a generic sentence when a rejection carries no diagnostics', () => {
    expect(dashboardDeleteMessage(rejected([]))).toBe('✕ Could not save workspace');
  });

  it('names the two identity refusals distinctly', () => {
    // Both mean "nothing was deleted", but they are different situations: one
    // is a panel that changed under the user, the other a workspace whose ids
    // are ambiguous and must never be written through a guess.
    expect(dashboardDeleteMessage({ ok: false, aborted: true, data: 'tile-retargeted' }))
      .toBe('That panel now shows a different query, so nothing was deleted.');
    expect(dashboardDeleteMessage({ ok: false, aborted: true, data: 'tile-duplicate' }))
      .toBe('This workspace has two resources with the same id, so nothing was deleted.');
  });
});
