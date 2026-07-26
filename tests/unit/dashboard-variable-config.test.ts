// #457 — the async half of committing one variable's option SQL. The pure
// transform it wraps is covered in `workspace-dashboards.test.ts`
// (`withVariableConfig`); what is tested here is the plumbing: that committed
// truth is read at dequeue time, that each distinct failure stays distinguishable
// to the caller, and that a rendered Dashboard is poked only on a real commit.

import { describe, expect, it, vi } from 'vitest';
import { commitVariableConfig } from '../../src/application/dashboard-variable-config.js';
import type { VariableConfigDeps } from '../../src/application/dashboard-variable-config.js';
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
 * `latest` (committed truth at dequeue time, NOT a caller snapshot), records the
 * candidate, and maps a null candidate to an abort that carries the transform's
 * own `data` — which is precisely the channel this module uses to say "I
 * declined" as opposed to "the app navigated".
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

// The poke mock is built as a standalone const with its real signature before it
// ever enters an object literal: inlining `vi.fn()` into a literal typed against
// `VariableConfigDeps` collapses its inferred call signature and the assignment
// stops type-checking (a fake-app lesson this repo has already paid for once).
const pokeMock = () => vi.fn<(info: WorkspaceExternallyChangedInfo) => void>();

const deps = (latest: StoredWorkspaceV5 | null) => {
  const { mutateWorkspace, committed } = fakeMutate(latest);
  const onWorkspaceExternallyChanged = pokeMock();
  const bag: VariableConfigDeps = { mutateWorkspace, onWorkspaceExternallyChanged };
  return { ...bag, committed, onWorkspaceExternallyChanged };
};

describe('commitVariableConfig', () => {
  it('commits the configuration into the addressed Dashboard', async () => {
    const app = deps(ws([dash('sales'), dash('ops')]));
    const outcome = await commitVariableConfig(app, 'sales', 'zone', { sql: 'SELECT z, z FROM zones' });

    expect(outcome.ok).toBe(true);
    expect(app.committed[0]!.dashboards[0].variableConfigs).toEqual({
      zone: { sql: 'SELECT z, z FROM zones' },
    });
    expect(app.committed[0]!.dashboards[1].variableConfigs).toBeUndefined();
  });

  it('removes the configuration for a null config', async () => {
    const app = deps(ws([dash('sales', { variableConfigs: { zone: { sql: 'Z' } } })]));
    const outcome = await commitVariableConfig(app, 'sales', 'zone', null);

    expect(outcome.ok).toBe(true);
    expect('variableConfigs' in app.committed[0]!.dashboards[0]).toBe(false);
  });

  it('asks a rendered Dashboard to re-read committed truth after a real commit', async () => {
    // A viewer session reads `variableConfigs` ONCE, at construction, so without
    // this poke the on-screen controls keep running the previous configuration.
    const app = deps(ws([dash('sales')]));
    await commitVariableConfig(app, 'sales', 'zone', { sql: 'Z' });

    // The COMMITTED workspace is reported, and `queriesChanged: false` is a fact:
    // this write cannot add, remove or edit a query.
    expect(app.onWorkspaceExternallyChanged).toHaveBeenCalledExactlyOnceWith({
      workspace: app.committed[0], queriesChanged: false,
    });
  });

  it('commits nothing, and declines explicitly, when there is no workspace at all', async () => {
    const app = deps(null);
    const outcome = await commitVariableConfig(app, 'sales', 'zone', { sql: 'Z' });

    expect(outcome).toEqual({ ok: false, aborted: true, data: 'declined' });
    expect(app.committed).toEqual([null]);
    expect(app.onWorkspaceExternallyChanged).not.toHaveBeenCalled();
  });

  it('commits nothing, and declines explicitly, when the Dashboard is gone', async () => {
    const app = deps(ws([dash('ops')]));
    const outcome = await commitVariableConfig(app, 'sales', 'zone', { sql: 'Z' });

    expect(outcome).toEqual({ ok: false, aborted: true, data: 'declined' });
    expect(app.committed).toEqual([null]);
    expect(app.onWorkspaceExternallyChanged).not.toHaveBeenCalled();
  });

  it('commits nothing, and declines explicitly, for an AMBIGUOUS Dashboard id', async () => {
    // Overwriting one of two identical ids by an arbitrary pick is unrecoverable,
    // so a duplicate-id workspace is refused rather than "repaired".
    const app = deps(ws([dash('dup'), dash('dup')]));
    const outcome = await commitVariableConfig(app, 'dup', 'zone', { sql: 'Z' });

    expect(outcome).toEqual({ ok: false, aborted: true, data: 'declined' });
    expect(app.onWorkspaceExternallyChanged).not.toHaveBeenCalled();
  });

  it('leaves an abort it did NOT cause distinguishable from its own refusal', async () => {
    // The primitive aborts on its own account too — the route moved on mid-write,
    // and at least one of those paths KEEPS a durable write. Such an outcome
    // carries no `data`, which is how a caller tells the two apart instead of
    // reporting a failure that may not be one.
    const app: VariableConfigDeps = {
      mutateWorkspace: (async () => ({ ok: false, aborted: true })) as MutateWorkspace,
      onWorkspaceExternallyChanged: pokeMock(),
    };
    const outcome = await commitVariableConfig(app, 'sales', 'zone', { sql: 'Z' });

    expect(outcome).toEqual({ ok: false, aborted: true });
    expect(outcome.ok === false && outcome.aborted && outcome.data).toBeUndefined();
    expect(app.onWorkspaceExternallyChanged).not.toHaveBeenCalled();
  });

  it('passes a commit rejection through with its diagnostics', async () => {
    const app: VariableConfigDeps = {
      mutateWorkspace: (async () => ({
        ok: false,
        diagnostics: [{ path: ['queries'], severity: 'error', code: 'x', message: 'rejected' }],
      })) as MutateWorkspace,
      onWorkspaceExternallyChanged: pokeMock(),
    };
    const outcome = await commitVariableConfig(app, 'sales', 'zone', { sql: 'Z' });

    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && !outcome.aborted && outcome.diagnostics[0].message).toBe('rejected');
    expect(app.onWorkspaceExternallyChanged).not.toHaveBeenCalled();
  });
});
