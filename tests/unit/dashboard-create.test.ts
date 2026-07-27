// The ONE Dashboard-creation command (#481, #495 review 3).
//
// Both entry points — File ▸ New dashboard… and the empty-workspace
// placeholder — run this, so what is pinned here is the behaviour they now
// cannot disagree about: what gets appended, what is reported, and what a
// baseline-less workspace does. Their own reveal policies stay covered by
// `file-menu.test.ts` / `dashboard.test.ts`.

import { describe, it, expect, vi } from 'vitest';
import { createDashboard, dashboardCreateMessage } from '../../src/application/dashboard-create.js';
import type { DashboardCreateOutcome } from '../../src/application/dashboard-create.js';
import type { MutateWorkspace } from '../../src/state.js';
import type { StoredWorkspaceV5 } from '../../src/generated/json-schema.types.js';

const workspace = (over: Partial<StoredWorkspaceV5> = {}): StoredWorkspaceV5 => ({
  storageVersion: 5, id: 'w1', key: 'k1', name: 'Lib', queries: [], dashboards: [], ...over,
});

/** A `mutateWorkspace` that hands the transform `latest` and commits whatever
 *  candidate comes back, recording it. */
const mutateOver = (latest: StoredWorkspaceV5 | null) => {
  const committed: (StoredWorkspaceV5 | null)[] = [];
  const mutateWorkspace = (async (transform) => {
    const input = await transform(latest);
    const candidate = input === null ? null : input.candidate;
    committed.push(candidate);
    if (input === null || candidate === null) return { ok: false, aborted: true, data: input?.data };
    return { ok: true, workspace: candidate, dashboardRevision: null, data: input.data };
  }) as MutateWorkspace;
  return { committed, mutateWorkspace };
};

describe('createDashboard', () => {
  it('appends one empty Dashboard with the given name and reports its id', async () => {
    const { committed, mutateWorkspace } = mutateOver(workspace());
    const outcome = await createDashboard(
      { mutateWorkspace, genId: () => 'd-new', baseline: () => null }, 'Revenue',
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.data).toBe('d-new');
    expect(committed[0]!.dashboards).toHaveLength(1);
    expect(committed[0]!.dashboards[0].id).toBe('d-new');
    expect(committed[0]!.dashboards[0].title).toBe('Revenue');
    expect(committed[0]!.dashboards[0].tiles).toEqual([]);
  });

  it('is additive — every existing Dashboard and query is preserved in place', async () => {
    const existing = workspace({
      queries: [{ id: 'q1', sql: 'SELECT 1', specVersion: 1, spec: { specVersion: 1, name: 'Q' } }],
      dashboards: [{
        id: 'd1', title: 'First', revision: 3, tiles: [],
        layout: { kind: 'flow', order: [] },
      } as unknown as StoredWorkspaceV5['dashboards'][number]],
    });
    const { committed, mutateWorkspace } = mutateOver(existing);
    await createDashboard({ mutateWorkspace, genId: () => 'd2', baseline: () => null }, 'Second');
    expect(committed[0]!.dashboards.map((d) => d.id)).toEqual(['d1', 'd2']);
    expect(committed[0]!.dashboards[0]).toEqual(existing.dashboards[0]);
    expect(committed[0]!.queries).toEqual(existing.queries);
  });

  it('appends onto the caller BASELINE when nothing is persisted yet', async () => {
    // The very first Dashboard of a fresh workspace: `mutateWorkspace` hands
    // the transform `null`, and only the caller knows what the projected
    // envelope is.
    const { committed, mutateWorkspace } = mutateOver(null);
    const outcome = await createDashboard(
      { mutateWorkspace, genId: () => 'd1', baseline: () => workspace({ name: 'Fresh' }) }, 'First',
    );
    expect(outcome.ok).toBe(true);
    expect(committed[0]!.name).toBe('Fresh');
    expect(committed[0]!.dashboards.map((d) => d.id)).toEqual(['d1']);
  });

  it('prefers the dequeue-time aggregate over the baseline', async () => {
    // The baseline is a FALLBACK, never the base: a write that landed while
    // this one was queued must not be dropped.
    const baseline = vi.fn(() => workspace({ name: 'stale' }));
    const { committed, mutateWorkspace } = mutateOver(workspace({ name: 'latest' }));
    await createDashboard({ mutateWorkspace, genId: () => 'd1', baseline }, 'First');
    expect(committed[0]!.name).toBe('latest');
    expect(baseline).not.toHaveBeenCalled();
  });

  it('aborts, committing nothing, when there is no workspace at all', async () => {
    const { committed, mutateWorkspace } = mutateOver(null);
    const outcome = await createDashboard(
      { mutateWorkspace, genId: () => 'd1', baseline: () => null }, 'First',
    );
    expect(outcome.ok).toBe(false);
    expect(committed).toEqual([null]);
  });
});

describe('dashboardCreateMessage', () => {
  const ok: DashboardCreateOutcome = { ok: true, workspace: workspace(), dashboardRevision: null, data: 'd1' };

  it('confirms a real commit', () => {
    expect(dashboardCreateMessage(ok)).toBe('Created dashboard');
  });

  it('says nothing about an abort — nothing was committed and nothing was lost', () => {
    expect(dashboardCreateMessage({ ok: false, aborted: true })).toBeNull();
  });

  it('reports a rejection with the aggregate\'s first diagnostic', () => {
    expect(dashboardCreateMessage({
      ok: false,
      diagnostics: [
        { path: [], severity: 'error', code: 'x', message: 'Storage is full' },
        { path: [], severity: 'error', code: 'y', message: 'second' },
      ],
    })).toBe('✕ Storage is full');
  });

  it('falls back to one sentence when a rejection carries no diagnostic', () => {
    expect(dashboardCreateMessage({ ok: false, diagnostics: [] })).toBe('✕ Could not save workspace');
  });
});
