// #428 — the async half of a Library→Dashboard assignment. The pure transforms
// it wraps are covered in `library-assignment.test.ts`; what is tested here is
// the plumbing: ids minted once per call, committed truth read at dequeue time,
// the dirty-variable-tab gate running INSIDE the transform, and each distinct
// failure staying distinguishable to the caller.

import { describe, expect, it, vi } from 'vitest';
import {
  assignLibraryQueryToPanel, assignLibraryQuerySqlToVariable, libraryAssignmentMessage,
} from '../../src/application/library-assignment-service.js';
import type {
  LibraryAssignmentDeps, PanelAssignmentOutcome,
} from '../../src/application/library-assignment-service.js';
import { savedQuery } from '../helpers/saved-query.js';
import type {
  MutateWorkspace, QueryTab, WorkspaceExternallyChangedInfo,
} from '../../src/state.js';
import type { DashboardDocumentV2, StoredWorkspaceV5 } from '../../src/generated/json-schema.types.js';

const dash = (id: string, over: Partial<DashboardDocumentV2> = {}): DashboardDocumentV2 => ({
  documentVersion: 2, id, title: id.toUpperCase(), revision: 1,
  layout: { type: 'flow', version: 1, preset: 'report', items: {} },
  tiles: [], ...over,
});

const lib = savedQuery({ id: 'q-lib', sql: 'SELECT country FROM t', name: 'Countries' });
const declaring = savedQuery({ id: 'q-panel', sql: 'SELECT {country:String}' });

const ws = (over: Partial<StoredWorkspaceV5> = {}): StoredWorkspaceV5 => ({
  storageVersion: 5, id: 'w1', key: 'workspace', name: 'W',
  queries: [lib, declaring],
  dashboards: [dash('d1', { tiles: [{ id: 't1', queryId: 'q-panel' }] })],
  ...over,
});

const payload = { kind: 'library-query' as const, workspaceId: 'w1', queryId: 'q-lib' };

/** A variable tab for `(dashboardId, variableName)`, dirty or clean. */
const varTab = (dashboardId: string, variableName: string, dirtySql: boolean): QueryTab =>
  ({ id: 'tab-1', doc: { kind: 'dashboard-variable', dashboardId, variableName }, dirtySql } as QueryTab);

const pokeMock = () => vi.fn<(info: WorkspaceExternallyChangedInfo) => void>();

/**
 * A `mutateWorkspace` that behaves like the real one: it hands the transform
 * committed truth at DEQUEUE time (not a caller snapshot) and maps a null
 * candidate to an abort carrying the transform's own `data`. `beforeTransform`
 * is the hook that reproduces the real primitive's await window — the gap
 * between the caller's decision and the transform actually running.
 */
const deps = (
  latest: StoredWorkspaceV5 | null,
  opts: { tabs?: QueryTab[]; beforeTransform?: () => void; duringCommit?: () => void } = {},
) => {
  const committed: (StoredWorkspaceV5 | null)[] = [];
  const tabs = opts.tabs ?? [];
  let nextId = 0;
  const mutateWorkspace = (async (transform) => {
    if (opts.beforeTransform) opts.beforeTransform();
    const input = await transform(latest);
    const candidate = input === null ? null : input.candidate;
    committed.push(candidate);
    if (candidate === null) {
      return { ok: false, aborted: true, data: input === null ? undefined : input.data };
    }
    // The real primitive awaits `workspace.commit(candidate)` HERE, after the
    // transform has already returned. Anything the user does in this window is
    // past every gate the transform could have applied.
    if (opts.duringCommit) opts.duringCommit();
    await Promise.resolve();
    return { ok: true, workspace: candidate, dashboardRevision: null, data: input!.data };
  }) as MutateWorkspace;
  const onWorkspaceExternallyChanged = pokeMock();
  const genId = vi.fn(() => 'gen-' + String(++nextId));
  const bag: LibraryAssignmentDeps = {
    mutateWorkspace, onWorkspaceExternallyChanged, genId, readTabs: () => tabs,
  };
  return { ...bag, committed, onWorkspaceExternallyChanged, genId, tabs };
};

describe('assignLibraryQueryToPanel', () => {
  it('commits the clone and the tile, and reports both new ids', async () => {
    const app = deps(ws());
    const outcome = await assignLibraryQueryToPanel(app, payload, 'd1');

    expect(outcome.ok).toBe(true);
    expect(outcome.data).toEqual({ status: 'ok', queryId: 'gen-1', tileId: 'gen-2' });
    expect(app.committed[0]!.dashboards[0].tiles).toEqual([
      { id: 't1', queryId: 'q-panel' }, { id: 'gen-2', queryId: 'gen-1' },
    ]);
  });

  it('mints both ids once per call, not once per dequeue', async () => {
    // A retry inside the primitive must not silently become a second panel.
    const app = deps(ws());
    await assignLibraryQueryToPanel(app, payload, 'd1');
    expect(app.genId).toHaveBeenCalledTimes(2);
  });

  it('pokes a rendered Dashboard with queriesChanged: true — a copy joins the collection', async () => {
    const app = deps(ws());
    const outcome = await assignLibraryQueryToPanel(app, payload, 'd1');
    if (!outcome.ok) throw new Error('expected ok');
    expect(app.onWorkspaceExternallyChanged).toHaveBeenCalledWith({
      workspace: outcome.workspace, queriesChanged: true,
    });
  });

  it('declines with the transform\'s own reason, committing nothing', async () => {
    const app = deps(ws({ dashboards: [dash('other')] }));
    const outcome = await assignLibraryQueryToPanel(app, payload, 'd1');

    expect(outcome).toMatchObject({
      ok: false, aborted: true, data: { status: 'declined', reason: 'dashboard-missing' },
    });
    expect(app.committed).toEqual([null]);
    expect(app.onWorkspaceExternallyChanged).not.toHaveBeenCalled();
  });

  it('declines when nothing is committed yet', async () => {
    const app = deps(null);
    const outcome = await assignLibraryQueryToPanel(app, payload, 'd1');
    expect(outcome).toMatchObject({ data: { status: 'declined', reason: 'workspace-mismatch' } });
  });
});

describe('assignLibraryQuerySqlToVariable', () => {
  it('commits the SQL into the addressed variable', async () => {
    const app = deps(ws());
    const outcome = await assignLibraryQuerySqlToVariable(app, payload, 'd1', 'country');

    expect(outcome.ok).toBe(true);
    // The command reports the SQL it committed, so the caller never has to
    // re-derive it from a projection that may not have landed yet.
    expect(outcome.data).toEqual({
      status: 'ok', sql: 'SELECT country FROM t', draftDiverged: false,
    });
    expect(app.committed[0]!.dashboards[0].variableConfigs).toEqual({
      country: { sql: 'SELECT country FROM t', lastKnownType: 'String' },
    });
  });

  it('pokes with queriesChanged: false — no query is created', async () => {
    const app = deps(ws());
    const outcome = await assignLibraryQuerySqlToVariable(app, payload, 'd1', 'country');
    if (!outcome.ok) throw new Error('expected ok');
    expect(app.onWorkspaceExternallyChanged).toHaveBeenCalledWith({
      workspace: outcome.workspace, queriesChanged: false,
    });
    expect(app.genId).not.toHaveBeenCalled();
  });

  it('commits normally when no tab is open for that variable', async () => {
    const app = deps(ws(), { tabs: [varTab('d1', 'other', true), varTab('d2', 'country', true)] });
    const outcome = await assignLibraryQuerySqlToVariable(app, payload, 'd1', 'country');
    // Neither a different variable nor the same NAME under another Dashboard is
    // this document.
    expect(outcome.ok).toBe(true);
  });

  it('commits when the matching tab is clean', async () => {
    const app = deps(ws(), { tabs: [varTab('d1', 'country', false)] });
    expect((await assignLibraryQuerySqlToVariable(app, payload, 'd1', 'country')).ok).toBe(true);
  });

  it('rejects when the matching tab is dirty, committing nothing', async () => {
    const app = deps(ws(), { tabs: [varTab('d1', 'country', true)] });
    const outcome = await assignLibraryQuerySqlToVariable(app, payload, 'd1', 'country');

    expect(outcome).toMatchObject({
      ok: false, aborted: true, data: { status: 'declined', reason: 'variable-tab-dirty' },
    });
    expect(app.committed).toEqual([null]);
  });

  it('rejects a tab that turned dirty AFTER dispatch but before the transform ran', async () => {
    // The whole reason the gate is inside the transform: `mutateWorkspace`
    // queues behind `serializeWrite` and then awaits IndexedDB, and one
    // keystroke in that window would otherwise overwrite a draft nothing else
    // would ever reconcile (a variable tab has `savedId === null`, so #343's
    // linked-tab reconciler skips it).
    const tab = varTab('d1', 'country', false);
    const app = deps(ws(), { tabs: [tab], beforeTransform: () => { tab.dirtySql = true; } });
    const outcome = await assignLibraryQuerySqlToVariable(app, payload, 'd1', 'country');

    expect(outcome).toMatchObject({ data: { status: 'declined', reason: 'variable-tab-dirty' } });
    expect(app.committed).toEqual([null]);
  });

  it('reports draftDiverged when the tab turns dirty DURING the commit', async () => {
    // The gate inside the transform cannot close this window: `mutateWorkspace`
    // awaits `workspace.commit(candidate)` after the transform returns, and a
    // slow or blocked IndexedDB transaction makes that window materially wider.
    // The write IS durable, so the honest outcome is "committed, and your draft
    // now disagrees" — not a clean success the caller reports as done.
    const tab = varTab('d1', 'country', false);
    const app = deps(ws(), { tabs: [tab], duringCommit: () => { tab.dirtySql = true; } });

    const outcome = await assignLibraryQuerySqlToVariable(app, payload, 'd1', 'country');

    expect(outcome.ok).toBe(true);
    expect(outcome.data).toEqual({
      status: 'ok', sql: 'SELECT country FROM t', draftDiverged: true,
    });
    // The assignment really did land — this is not a rollback.
    expect(app.committed[0]!.dashboards[0].variableConfigs!.country.sql)
      .toBe('SELECT country FROM t');
  });

  it('reports draftDiverged: false on the ordinary clean path', async () => {
    const app = deps(ws(), { tabs: [varTab('d1', 'country', false)] });
    const outcome = await assignLibraryQuerySqlToVariable(app, payload, 'd1', 'country');
    expect(outcome.data).toMatchObject({ draftDiverged: false });
  });

  it('declines with the transform\'s reason for a variable that is no longer inferred', async () => {
    const app = deps(ws({ dashboards: [dash('d1')] }));
    const outcome = await assignLibraryQuerySqlToVariable(app, payload, 'd1', 'country');
    expect(outcome).toMatchObject({ data: { status: 'declined', reason: 'variable-not-inferred' } });
  });

  it('declines when nothing is committed yet', async () => {
    const app = deps(null);
    const outcome = await assignLibraryQuerySqlToVariable(app, payload, 'd1', 'country');
    expect(outcome).toMatchObject({ data: { status: 'declined', reason: 'workspace-mismatch' } });
  });
});

describe('libraryAssignmentMessage', () => {
  const declineOutcome = (reason: string): PanelAssignmentOutcome =>
    ({ ok: false, aborted: true, data: { status: 'declined', reason } } as PanelAssignmentOutcome);

  it('says nothing on success', () => {
    expect(libraryAssignmentMessage({
      ok: true, workspace: ws(), dashboardRevision: null, data: { status: 'ok', queryId: 'a', tileId: 'b' },
    })).toBeNull();
  });

  it('says nothing when the route simply moved on — the user did not do that', () => {
    expect(libraryAssignmentMessage({ ok: false, aborted: true })).toBeNull();
    expect(libraryAssignmentMessage({
      ok: false, aborted: true, data: { status: 'ok', queryId: 'a', tileId: 'b' },
    })).toBeNull();
  });

  it('reports a repository rejection distinctly from a declined transform', () => {
    expect(libraryAssignmentMessage({ ok: false, diagnostics: [] }))
      .toBe('Could not save this assignment — the dashboard was rejected');
  });

  it('has one sentence for every decline reason', () => {
    const reasons = [
      'workspace-mismatch', 'source-missing', 'source-not-library', 'dashboard-missing',
      'dashboard-ambiguous', 'id-collision', 'variable-not-inferred', 'blank-sql',
      'variable-tab-dirty',
    ];
    for (const reason of reasons) {
      const message = libraryAssignmentMessage(declineOutcome(reason));
      expect(message, reason).toBeTruthy();
      expect(message, reason).not.toContain('undefined');
    }
  });

  it('tells the user how to actually remove option SQL when they drop a blank query', () => {
    expect(libraryAssignmentMessage(declineOutcome('blank-sql')))
      .toContain('clear it in the variable tab and save');
  });
});
