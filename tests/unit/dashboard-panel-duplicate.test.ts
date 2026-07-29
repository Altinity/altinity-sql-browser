// #535 — the async half of a panel duplication. The pure transform it wraps is
// covered in `panel-duplication.test.ts`; what is tested here is the plumbing:
// ids minted once per call, committed truth read at dequeue time, the
// queries-changed poke that makes the copy appear, and every failure staying
// distinguishable to the caller.

import { describe, expect, it, vi } from 'vitest';
import {
  commitPanelDuplication, panelDuplicateMessage,
} from '../../src/application/dashboard-panel-duplicate.js';
import type { PanelDuplicateOutcome } from '../../src/application/dashboard-panel-duplicate.js';
import { savedQuery } from '../helpers/saved-query.js';
import type { MutateWorkspace, WorkspaceExternallyChangedInfo } from '../../src/state.js';
import type { DashboardDocumentV2, StoredWorkspaceV5 } from '../../src/generated/json-schema.types.js';

const dash = (id: string, over: Partial<DashboardDocumentV2> = {}): DashboardDocumentV2 => ({
  documentVersion: 2, id, title: id.toUpperCase(), revision: 1,
  layout: { type: 'flow', version: 1, preset: 'columns-2', items: { t1: { span: 2, height: 'medium' } } },
  tiles: [{ id: 't1', queryId: 'q-own' }], ...over,
});

const owned = savedQuery({ id: 'q-own', sql: 'SELECT 1', dashboard: { role: 'panel' } });

const ws = (over: Partial<StoredWorkspaceV5> = {}): StoredWorkspaceV5 => ({
  storageVersion: 5, id: 'w1', key: 'workspace', name: 'W',
  queries: [owned], dashboards: [dash('d1')], ...over,
});

const target = { dashboardId: 'd1', tileId: 't1' };

/**
 * A `mutateWorkspace` that behaves like the real one: it hands the transform
 * committed truth at DEQUEUE time (not a caller snapshot) and maps a null
 * candidate to an abort carrying the transform's own `data`. `rejectCommit`
 * reproduces the repository refusing the candidate outright.
 */
const deps = (
  latest: StoredWorkspaceV5 | null,
  opts: { beforeTransform?: () => void; rejectCommit?: string } = {},
) => {
  const committed: (StoredWorkspaceV5 | null)[] = [];
  let nextId = 0;
  const mutateWorkspace = (async (transform) => {
    if (opts.beforeTransform) opts.beforeTransform();
    const input = await transform(latest);
    const candidate = input === null ? null : input.candidate;
    committed.push(candidate);
    if (candidate === null) {
      return { ok: false, aborted: true, data: input === null ? undefined : input.data };
    }
    if (opts.rejectCommit !== undefined) {
      return { ok: false, aborted: false, diagnostics: [{ severity: 'error', path: [], code: 'x', message: opts.rejectCommit }] };
    }
    await Promise.resolve();
    return { ok: true, workspace: candidate, dashboardRevision: null, data: input!.data };
  }) as MutateWorkspace;
  const onWorkspaceExternallyChanged = vi.fn<(info: WorkspaceExternallyChangedInfo) => void>();
  const genId = vi.fn(() => 'gen-' + String(++nextId));
  return { mutateWorkspace, onWorkspaceExternallyChanged, genId, committed };
};

describe('commitPanelDuplication (#535)', () => {
  it('commits the clone and the copied tile, and reports both new ids', async () => {
    const app = deps(ws());
    const outcome = await commitPanelDuplication(app, target);

    expect(outcome.ok).toBe(true);
    expect(outcome.data).toEqual({ status: 'ok', queryId: 'gen-1', tileId: 'gen-2' });
    expect(app.committed[0]!.dashboards[0].tiles).toEqual([
      { id: 't1', queryId: 'q-own' }, { id: 'gen-2', queryId: 'gen-1' },
    ]);
    expect(app.committed[0]!.queries.map((query) => query.id)).toEqual(['q-own', 'gen-1']);
  });

  it('mints both ids once per call, not once per dequeue', async () => {
    // A retry inside the primitive must not silently become two panels.
    const app = deps(ws());
    await commitPanelDuplication(app, target);
    expect(app.genId).toHaveBeenCalledTimes(2);
  });

  // The rebuild this poke triggers is what makes the copy appear at all: the
  // route's own optimistic path cannot create a runtime for a tile whose query
  // the live session has never seen.
  it('pokes a rendered Dashboard with queriesChanged: true', async () => {
    const app = deps(ws());
    const outcome = await commitPanelDuplication(app, target);
    if (!outcome.ok) throw new Error('expected ok');
    expect(app.onWorkspaceExternallyChanged).toHaveBeenCalledWith({
      workspace: outcome.workspace, queriesChanged: true,
    });
  });

  it('reads committed truth at dequeue time, not what the caller was looking at', async () => {
    // The tile is removed by another producer in the primitive's await window. The
    // transform must see THAT, and refuse.
    let latest = ws();
    const app = deps(latest, {
      beforeTransform: () => { latest.dashboards[0].tiles = []; },
    });
    const outcome = await commitPanelDuplication(app, target);
    expect(outcome.ok).toBe(false);
    expect(outcome.data).toEqual({ status: 'declined', reason: 'tile-missing' });
    expect(app.committed[0]).toBeNull();
    expect(app.onWorkspaceExternallyChanged).not.toHaveBeenCalled();
  });

  it('declines with no workspace loaded, without inventing one', async () => {
    const app = deps(null);
    const outcome = await commitPanelDuplication(app, target);
    expect(outcome.data).toEqual({ status: 'declined', reason: 'no-workspace' });
  });

  it('threads a transform refusal through verbatim', async () => {
    const app = deps(ws());
    const outcome = await commitPanelDuplication(app, { dashboardId: 'gone', tileId: 't1' });
    expect(outcome.data).toEqual({ status: 'declined', reason: 'dashboard-missing' });
  });
});

describe('panelDuplicateMessage (#535)', () => {
  const declined = (reason: string): PanelDuplicateOutcome =>
    ({ ok: false, aborted: true, data: { status: 'declined', reason } } as PanelDuplicateOutcome);

  it('says nothing on success — the new tile appearing is the report', () => {
    expect(panelDuplicateMessage({ ok: true } as PanelDuplicateOutcome)).toBeNull();
  });

  it('gives every decline its own sentence, all meaning "nothing was duplicated"', () => {
    expect(panelDuplicateMessage(declined('no-workspace')))
      .toBe('Could not duplicate this panel — no workspace is loaded');
    // Matches `dashboardDeleteMessage`'s wording for the same states, so every
    // Dashboard control speaks with one voice about resources that vanished.
    expect(panelDuplicateMessage(declined('dashboard-missing')))
      .toBe('That dashboard is no longer part of this workspace.');
    expect(panelDuplicateMessage(declined('dashboard-ambiguous')))
      .toBe('This workspace has two resources with the same id, so nothing was duplicated.');
    expect(panelDuplicateMessage(declined('tile-missing')))
      .toBe('That panel is no longer part of this dashboard.');
    expect(panelDuplicateMessage(declined('source-missing')))
      .toBe('That panel’s query is no longer part of this workspace.');
    expect(panelDuplicateMessage(declined('id-collision')))
      .toBe('Could not duplicate this panel — please try again');
  });

  // A rejected CANDIDATE is not a decline: the write was attempted and the
  // aggregate refused it (a tile-count limit, a schema failure). Surface the
  // diagnostic rather than a generic decline sentence.
  it('surfaces a rejected candidate\'s own diagnostic', async () => {
    const app = deps(ws(), { rejectCommit: 'dashboard tiles exceeds the maximum' });
    const outcome = await commitPanelDuplication(app, target);
    expect(panelDuplicateMessage(outcome)).toBe('✕ dashboard tiles exceeds the maximum');
    expect(app.onWorkspaceExternallyChanged).not.toHaveBeenCalled();
  });

  it('falls back to a generic sentence when a rejection carries no diagnostics', () => {
    expect(panelDuplicateMessage({ ok: false, aborted: false, diagnostics: [] } as PanelDuplicateOutcome))
      .toBe('✕ Could not save workspace');
  });

  // An abort whose data is not a decline means the route moved on while the write
  // was in flight — not something the user did, and not something to report.
  it('says nothing about an abort with no decline attached', () => {
    expect(panelDuplicateMessage({ ok: false, aborted: true, data: undefined } as PanelDuplicateOutcome))
      .toBeNull();
  });
});
