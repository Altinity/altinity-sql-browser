// #494 — editing one panel's dedicated owned query metadata (name/description).
// `renameSaved` (state.ts) does the actual patch and its own rules
// (trim/clear, linked-draft sync, deleted-externally) are covered by
// state.test.ts; what is tested here is what this module ADDS on top: the
// dequeue-time ownership guard (`ownedByPanel`), and the plumbing/reporting
// around `renameSaved`'s result (`commitPanelQueryMetadata`).

import { describe, expect, it, vi } from 'vitest';
import {
  commitPanelQueryMetadata, ownedByPanel,
} from '../../src/application/dashboard-panel-metadata.js';
import type {
  PanelMetadataDeps, PanelMetadataTarget,
} from '../../src/application/dashboard-panel-metadata.js';
import { createState } from '../../src/state.js';
import type { MutateWorkspace, SpecValidationService } from '../../src/state.js';
import { savedQuery } from '../helpers/saved-query.js';
import type {
  DashboardDocumentV2, SavedQueryV2, StoredWorkspaceV5,
} from '../../src/generated/json-schema.types.js';
import type { WorkspaceDiagnostic } from '../../src/dashboard/model/workspace-diagnostics.js';

const dash = (over: Partial<DashboardDocumentV2> = {}): DashboardDocumentV2 => ({
  documentVersion: 2, id: 'dash', title: 'D', revision: 1,
  layout: { type: 'flow', version: 1, preset: 'report', items: {} },
  tiles: [], ...over,
} as DashboardDocumentV2);

const ws = (dashboards: DashboardDocumentV2[], queries: SavedQueryV2[]): StoredWorkspaceV5 => ({
  storageVersion: 5, id: 'w1', key: 'w1', name: 'W', queries, dashboards,
});

describe('ownedByPanel (#494, #427 exactly-one-owner rule asked about ONE member)', () => {
  it('is true when the query exists, has exactly one owner, and that owner is this dashboard+tile', () => {
    const workspace = ws(
      [dash({ id: 'dash', tiles: [{ id: 't1', queryId: 'q1' }] })],
      [savedQuery({ id: 'q1' })],
    );
    expect(ownedByPanel(workspace, { dashboardId: 'dash', tileId: 't1', queryId: 'q1' })).toBe(true);
  });

  it('is false when the query itself is missing from the collection, even though a tile still names it', () => {
    const workspace = ws(
      [dash({ id: 'dash', tiles: [{ id: 't1', queryId: 'q1' }] })],
      [], // the dangling state the exactly-one-owner rule must never trust
    );
    expect(ownedByPanel(workspace, { dashboardId: 'dash', tileId: 't1', queryId: 'q1' })).toBe(false);
  });

  it('is false when the query has more than one owner', () => {
    const workspace = ws(
      [dash({ id: 'dash', tiles: [{ id: 't1', queryId: 'q1' }, { id: 't2', queryId: 'q1' }] })],
      [savedQuery({ id: 'q1' })],
    );
    expect(ownedByPanel(workspace, { dashboardId: 'dash', tileId: 't1', queryId: 'q1' })).toBe(false);
  });

  it('is false when the sole owner is a DIFFERENT tile of the same Dashboard', () => {
    const workspace = ws(
      [dash({ id: 'dash', tiles: [{ id: 't2', queryId: 'q1' }] })],
      [savedQuery({ id: 'q1' })],
    );
    expect(ownedByPanel(workspace, { dashboardId: 'dash', tileId: 't1', queryId: 'q1' })).toBe(false);
  });

  it('is false when the sole owner belongs to a DIFFERENT Dashboard', () => {
    const workspace = ws(
      [
        dash({ id: 'dash', tiles: [] }),
        dash({ id: 'dash2', tiles: [{ id: 't9', queryId: 'q1' }] }),
      ],
      [savedQuery({ id: 'q1' })],
    );
    expect(ownedByPanel(workspace, { dashboardId: 'dash', tileId: 't1', queryId: 'q1' })).toBe(false);
  });
});

/**
 * A `mutateWorkspace` that behaves like the real one: `latest` is committed
 * truth READ AT DEQUEUE TIME (never a value the caller captured earlier), and
 * a null candidate maps to an abort carrying the transform's own `data`.
 * Modeled on `dashboard-title.test.ts`'s own `fakeMutate`.
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

const permissiveValidators: SpecValidationService = { validate: () => [] };

/** A real `AppState` (via `createState`) with `savedQueries` seeded to the
 *  CALLER'S OWN pre-dialog view — the coarse local lookup `renameSaved` does
 *  before ever touching the queue. The queue's own `latest` (supplied
 *  separately to `fakeMutate`) is what the ownership guard actually judges
 *  against, and the two are allowed to disagree — that disagreement is the
 *  whole point of #494's guard. */
const stateWith = (savedQueries: SavedQueryV2[]) => {
  const state = createState({ loadStr: (_k, d) => d, loadJSON: (_k, d) => d });
  state.savedQueries = savedQueries;
  return state;
};

describe('commitPanelQueryMetadata', () => {
  const target: PanelMetadataTarget = { dashboardId: 'dash', tileId: 't1', queryId: 'q1' };

  it('commits ONLY spec.name/spec.description; everything else survives byte-identical, and no Dashboard is touched', async () => {
    const q1 = savedQuery({
      id: 'q1', sql: 'SELECT 1', name: 'Old name', description: 'Old description',
      dashboard: { role: 'panel' },
      panel: { cfg: { type: 'table' }, key: 'panel-key' },
      futureExtension: 'keep-me',
    });
    const q2 = savedQuery({ id: 'q2', name: 'Untouched Library entry', sql: 'SELECT 2' });
    const dashDoc = dash({ id: 'dash', revision: 5, tiles: [{ id: 't1', queryId: 'q1' }] });
    const latest = ws([dashDoc], [q1, q2]);

    const state = stateWith([q1, q2]);
    const { mutateWorkspace, committed } = fakeMutate(latest);
    const refreshCommittedSurfaces = vi.fn();
    const deps: PanelMetadataDeps = {
      state, mutateWorkspace, specValidators: permissiveValidators, refreshCommittedSurfaces,
    };

    const outcome = await commitPanelQueryMetadata(deps, target, '  New name  ', '  New description  ');
    if (outcome.status !== 'ok') throw new Error(`expected ok, got ${outcome.status}`);

    expect(outcome.entry.spec.name).toBe('New name');
    expect(outcome.entry.spec.description).toBe('New description');
    // Everything else about the query: byte-identical.
    expect(outcome.entry.id).toBe('q1');
    expect(outcome.entry.sql).toBe('SELECT 1');
    expect(outcome.entry.spec.dashboard).toEqual({ role: 'panel' });
    expect(outcome.entry.spec.panel).toEqual({ cfg: { type: 'table' }, key: 'panel-key' });
    expect(outcome.entry.spec.futureExtension).toBe('keep-me');

    // No Dashboard document is read or rewritten: same array, same reference,
    // revision never bumped.
    expect(committed[0]!.dashboards).toBe(latest.dashboards);
    expect(committed[0]!.dashboards[0].revision).toBe(5);
    // The Library query is a completely untouched reference.
    expect(committed[0]!.queries.find((q) => q.id === 'q2')).toBe(q2);

    expect(refreshCommittedSurfaces).toHaveBeenCalledTimes(1);
  });

  it('trims the name and CLEARS the description on an empty string — renameSaved\'s own rule, inherited', async () => {
    const q1 = savedQuery({ id: 'q1', name: 'Old', description: 'Old description' });
    const dashDoc = dash({ id: 'dash', tiles: [{ id: 't1', queryId: 'q1' }] });
    const latest = ws([dashDoc], [q1]);
    const state = stateWith([q1]);
    const { mutateWorkspace } = fakeMutate(latest);
    const deps: PanelMetadataDeps = {
      state, mutateWorkspace, specValidators: permissiveValidators, refreshCommittedSurfaces: vi.fn(),
    };

    const outcome = await commitPanelQueryMetadata(deps, target, '  Renamed  ', '   ');
    if (outcome.status !== 'ok') throw new Error(`expected ok, got ${outcome.status}`);

    expect(outcome.entry.spec.name).toBe('Renamed');
    expect(outcome.entry.spec.description).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(outcome.entry.spec, 'description')).toBe(false);
  });

  it('commits nothing for a blank name — the same "nothing was attempted" outcome as a missing target', async () => {
    const q1 = savedQuery({ id: 'q1', name: 'Old' });
    const latest = ws([dash({ id: 'dash', tiles: [{ id: 't1', queryId: 'q1' }] })], [q1]);
    const state = stateWith([q1]);
    const { mutateWorkspace, committed } = fakeMutate(latest);
    const deps: PanelMetadataDeps = {
      state, mutateWorkspace, specValidators: permissiveValidators, refreshCommittedSurfaces: vi.fn(),
    };

    const outcome = await commitPanelQueryMetadata(deps, target, '   ', 'irrelevant');

    expect(outcome).toEqual({ status: 'stale' });
    // `renameSaved` returns before ever touching the queue for a blank name.
    expect(committed).toEqual([]);
  });

  it('evaluates the ownership guard at DEQUEUE time: a tile re-pointed at a different query since the dialog opened aborts stale, committing nothing', async () => {
    const q1 = savedQuery({ id: 'q1', name: 'Old' });
    const q2 = savedQuery({ id: 'q2', name: 'Other' });
    // The caller's own pre-dialog view: t1 still owns q1, so its pencil dialog
    // opened believing this edit was valid.
    const state = stateWith([q1, q2]);
    // Dequeue-time truth: t1 has since been re-pointed at q2 — q1 has no
    // owner left at all, so the tile the dialog was opened for no longer
    // owns the query it was opened for.
    const dequeueLatest = ws([dash({ id: 'dash', tiles: [{ id: 't1', queryId: 'q2' }] })], [q1, q2]);
    const { mutateWorkspace, committed } = fakeMutate(dequeueLatest);
    const refreshCommittedSurfaces = vi.fn();
    const deps: PanelMetadataDeps = {
      state, mutateWorkspace, specValidators: permissiveValidators, refreshCommittedSurfaces,
    };

    const outcome = await commitPanelQueryMetadata(deps, target, 'New name', 'New description');

    expect(outcome).toEqual({ status: 'stale' });
    // The guard runs INSIDE the queued transform and refuses before any
    // candidate is built — the candidate handed to `mutateWorkspace` is null.
    expect(committed).toEqual([null]);
    expect(refreshCommittedSurfaces).not.toHaveBeenCalled();
  });

  it('reports stale (not a crash) when the query itself was deleted while the dialog was open, even though the tile still names it', async () => {
    const q1 = savedQuery({ id: 'q1', name: 'Old' });
    const state = stateWith([q1]);
    // Dequeue-time truth: q1 is gone from the collection entirely, though the
    // tile's reference to it (a dangling id) is still sitting there.
    const dequeueLatest = ws([dash({ id: 'dash', tiles: [{ id: 't1', queryId: 'q1' }] })], []);
    const { mutateWorkspace, committed } = fakeMutate(dequeueLatest);
    const deps: PanelMetadataDeps = {
      state, mutateWorkspace, specValidators: permissiveValidators, refreshCommittedSurfaces: vi.fn(),
    };

    const outcome = await commitPanelQueryMetadata(deps, target, 'New name', '');

    expect(outcome).toEqual({ status: 'stale' });
    expect(committed).toEqual([null]);
  });

  it('reports invalid-draft, committing nothing, when a linked tab holds Spec JSON that will not parse', async () => {
    const q1 = savedQuery({ id: 'q1', name: 'Old' });
    const latest = ws([dash({ id: 'dash', tiles: [{ id: 't1', queryId: 'q1' }] })], [q1]);
    const state = stateWith([q1]);
    // A tab linked to this query, but its textual Spec is not currently valid
    // JSON — `invalidSpecTabForSaved`'s own precondition (mirrors
    // state.test.ts's own invalid-tab fixture).
    const tab = state.tabs.value[0];
    tab.savedId = 'q1';
    tab.specText = '{"name":';
    tab.specParsed = null;
    tab.specDiagnostics = [{ severity: 'error', code: 'invalid-json', message: 'invalid JSON' }];
    const { mutateWorkspace, committed } = fakeMutate(latest);
    const refreshCommittedSurfaces = vi.fn();
    const deps: PanelMetadataDeps = {
      state, mutateWorkspace, specValidators: permissiveValidators, refreshCommittedSurfaces,
    };

    const outcome = await commitPanelQueryMetadata(deps, target, 'New name', '');

    expect(outcome).toEqual({ status: 'invalid-draft' });
    // The invalid-draft check runs BEFORE the queue is even touched.
    expect(committed).toEqual([]);
    expect(refreshCommittedSurfaces).not.toHaveBeenCalled();
  });

  it('reports the aggregate\'s first diagnostic on a rejected commit', async () => {
    const q1 = savedQuery({ id: 'q1', name: 'Old' });
    const state = stateWith([q1]);
    const diagnostics: WorkspaceDiagnostic[] = [
      { path: ['queries', 0, 'spec', 'name'], severity: 'error', code: 'x', message: 'Name collides' },
    ];
    const deps: PanelMetadataDeps = {
      state,
      mutateWorkspace: (async () => ({ ok: false, diagnostics })) as MutateWorkspace,
      specValidators: permissiveValidators,
      refreshCommittedSurfaces: vi.fn(),
    };

    const outcome = await commitPanelQueryMetadata(deps, target, 'New name', '');

    expect(outcome).toEqual({ status: 'rejected', message: 'Name collides' });
  });

  it('falls back to a generic message when a rejected commit carries no diagnostics', async () => {
    const q1 = savedQuery({ id: 'q1', name: 'Old' });
    const state = stateWith([q1]);
    const deps: PanelMetadataDeps = {
      state,
      mutateWorkspace: (async () => ({ ok: false, diagnostics: [] })) as MutateWorkspace,
      specValidators: permissiveValidators,
      refreshCommittedSurfaces: vi.fn(),
    };

    const outcome = await commitPanelQueryMetadata(deps, target, 'New name', '');

    expect(outcome).toEqual({ status: 'rejected', message: 'Could not save this panel.' });
  });

  it('refuses a query that is not a PANEL query, an ambiguous id, and a re-pointed tile', () => {
    const q1 = savedQuery({ id: 'q1', name: 'Q' });
    const target = { dashboardId: 'dash', tileId: 't1', queryId: 'q1' };

    // Wrong role — malformed data the semantic validator rejects; editing it
    // here would quietly write over the evidence.
    const setup = { ...q1, spec: { ...q1.spec, dashboard: { role: 'setup' } } } as typeof q1;
    expect(ownedByPanel(
      ws([dash({ id: 'dash', tiles: [{ id: 't1', queryId: 'q1' }] })], [setup]), target,
    )).toBe(false);

    // Two documents carrying the id: "which query am I editing" has no answer.
    expect(ownedByPanel(
      ws([dash({ id: 'dash', tiles: [{ id: 't1', queryId: 'q1' }] })], [q1, q1]), target,
    )).toBe(false);

    // The tile no longer points at it — the pair IS the identity.
    expect(ownedByPanel(
      ws([dash({ id: 'dash', tiles: [{ id: 't1', queryId: 'q2' }] })], [q1, savedQuery({ id: 'q2', name: 'Other' })]),
      target,
    )).toBe(false);
  });
});
