import { describe, expect, it } from 'vitest';
import {
  createDashboardAuthoringSession,
} from '../../src/dashboard/application/dashboard-authoring-session.js';
import { createWorkspaceRepository } from '../../src/workspace/workspace-repository.js';
import { jsonSchemaValidationService } from '../../src/core/library-codec.js';
import { querySpecSchemaService } from '../../src/core/spec-schema.js';
import { PORTABLE_LIMITS } from '../../src/dashboard/model/portable-limits.js';
import type { StoredWorkspaceV1 } from '../../src/generated/json-schema.types.js';

const panelQuery = (id: string) => ({
  id, sql: 'SELECT a,b', specVersion: 1 as const,
  spec: { name: id, panel: { cfg: { type: 'bar', x: 0, y: [1] } } },
});
const filterQuery = (id: string) => ({
  id, sql: "SELECT ['a','b'] AS c", specVersion: 1 as const, spec: { name: id, dashboard: { role: 'filter' } },
});

const emptyDash = () => ({
  documentVersion: 1 as const, id: 'dash', title: 'D', revision: 1,
  layout: { type: 'flow', version: 1, preset: 'report', items: {} }, filters: [], tiles: [],
});

const workspaceFixture = (over: Partial<StoredWorkspaceV1> = {}): StoredWorkspaceV1 => ({
  storageVersion: 1, id: 'ws', name: 'WS',
  queries: [panelQuery('q1'), panelQuery('q2')], dashboard: emptyDash(), ...over,
} as StoredWorkspaceV1);

const makeStore = () => {
  let text: string | null = null;
  let failWrite = false;
  return {
    store: {
      read: async () => text,
      write: async (t: string) => { if (failWrite) throw new Error('disk full'); text = t; },
      clear: async () => { text = null; },
    },
    setFailWrite: (v: boolean) => { failWrite = v; },
  };
};

interface SessionOpts {
  workspace?: StoredWorkspaceV1;
  nowISO?: () => string;
  withServices?: boolean;
}
const makeSession = (opts: SessionOpts = {}) => {
  const backing = makeStore();
  const repository = createWorkspaceRepository({ store: backing.store });
  let n = 0;
  const session = createDashboardAuthoringSession({
    workspace: opts.workspace ?? workspaceFixture(),
    repository, genId: () => `g${++n}`, nowISO: opts.nowISO,
    ...(opts.withServices ? { validationService: jsonSchemaValidationService, schemaService: querySpecSchemaService } : {}),
  });
  return { session, ...backing };
};

describe('DashboardAuthoringSession — atomic commands', () => {
  it('replaces the draft and increments draftVersion once on success', async () => {
    const { session } = makeSession();
    const result = await session.execute({ type: 'add-query', queryId: 'q1' });
    expect(result.ok).toBe(true);
    if (result.ok) expect((result.value as { tileId: string }).tileId).toBe('g1');
    expect(result.draftVersion).toBe(1);
    expect(session.state.value.draftVersion).toBe(1);
    expect(session.state.value.dirty).toBe(true);
    expect(session.state.value.document.tiles).toHaveLength(1);
    expect(session.state.value.diagnostics).toEqual([]);
  });

  it('leaves the draft byte-for-byte unchanged on a failed command', async () => {
    const { session } = makeSession();
    const before = JSON.stringify(session.state.value.document);
    const result = await session.execute({ type: 'add-query', queryId: 'gone' });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(session.state.value.document)).toBe(before);
    expect(session.state.value.draftVersion).toBe(0);
    expect(session.state.value.diagnostics.length).toBeGreaterThan(0);
    if (!result.ok) expect(result.draftVersion).toBe(0);
  });

  it('rejects a stale expectedDraftVersion without mutating the draft', async () => {
    const { session } = makeSession();
    await session.execute({ type: 'add-query', queryId: 'q1' });
    const stale = await session.execute({ type: 'add-query', queryId: 'q2' }, { expectedDraftVersion: 0 });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.diagnostics[0].code).toBe('dashboard-command-stale');
    expect(session.state.value.draftVersion).toBe(1);
    expect(session.state.value.document.tiles).toHaveLength(1);
  });

  it('does not clamp an out-of-range move index and fails a duplicate default instance', async () => {
    const { session } = makeSession();
    await session.execute({ type: 'add-query', queryId: 'q1' });
    await session.execute({ type: 'add-query', queryId: 'q2' });
    const badMove = await session.execute({ type: 'move-tile', tileId: 'g1', toIndex: 9 });
    expect(badMove.ok).toBe(false);
    if (!badMove.ok) expect(badMove.diagnostics[0].code).toBe('dashboard-command-index-out-of-range');

    const dup = await session.execute({ type: 'add-query', queryId: 'q1' });
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.diagnostics[0].code).toBe('dashboard-command-duplicate-instance');
  });

  it('runs presentation resolution as part of validation (override deletes a required field)', async () => {
    const { session } = makeSession({ withServices: true });
    const added = await session.execute({ type: 'add-query', queryId: 'q1' });
    expect(added.ok).toBe(true);
    const before = JSON.stringify(session.state.value.document);
    const bad = await session.execute({
      type: 'update-tile', tileId: 'g1', patch: { presentation: { override: { cfg: { x: null } } } },
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.diagnostics.some((d) => d.code === 'schema-required')).toBe(true);
    expect(JSON.stringify(session.state.value.document)).toBe(before);
  });

  // These prove the atomic guarantee for the DELEGATED-validation failure
  // class — failures raised by validateStoredWorkspaceDocument (structural /
  // role / reference / limit), i.e. the stage between applyCommand and
  // presentation resolution.
  it('rejects add-query on an incompatible-role query without mutating the draft', async () => {
    const { session } = makeSession({ workspace: workspaceFixture({ queries: [panelQuery('q1'), filterQuery('f1')] as never }) });
    const before = JSON.stringify(session.state.value.document);
    const result = await session.execute({ type: 'add-query', queryId: 'f1' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostics.some((d) => d.code === 'dashboard-tile-role-incompatible')).toBe(true);
    expect(JSON.stringify(session.state.value.document)).toBe(before);
    expect(session.state.value.draftVersion).toBe(0);
  });

  it('rejects exceeding the tile limit without mutating the draft', async () => {
    const full = Array.from({ length: PORTABLE_LIMITS.maxTilesPerDashboard }, (_, i) => ({ id: `t${i}`, queryId: 'q1' }));
    const { session } = makeSession({ workspace: workspaceFixture({ dashboard: { ...emptyDash(), tiles: full } as never }) });
    const before = JSON.stringify(session.state.value.document);
    const result = await session.execute({ type: 'add-query-instance', queryId: 'q1' });
    expect(result.ok).toBe(false);
    // The tile-count bound is enforced first by the schema's maxItems
    // (schema-array-size); the semantic limit-tile-count re-check backs it up.
    if (!result.ok) {
      expect(result.diagnostics.some((d) => d.code === 'schema-array-size' || d.code === 'limit-tile-count')).toBe(true);
    }
    expect(JSON.stringify(session.state.value.document)).toBe(before);
    expect(session.state.value.draftVersion).toBe(0);
  });

  it('rejects add-query-instance with an undeclared variant name without mutating the draft', async () => {
    const { session } = makeSession();
    const before = JSON.stringify(session.state.value.document);
    const result = await session.execute({ type: 'add-query-instance', queryId: 'q1', variant: 'nope' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostics.some((d) => d.code === 'dashboard-variant-missing')).toBe(true);
    expect(JSON.stringify(session.state.value.document)).toBe(before);
    expect(session.state.value.draftVersion).toBe(0);
  });

  it('fails a change-layout the plugin cannot load, leaving the previous layout intact', async () => {
    const { session } = makeSession();
    const result = await session.execute({ type: 'change-layout', layout: { type: 'grid', version: 9 } as never });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostics[0].code).toBe('dashboard-layout-load-failed');
    expect(session.state.value.document.layout.type).toBe('flow');
  });
});

describe('DashboardAuthoringSession — revision semantics and commit', () => {
  it('increments the persisted revision once per successful commit, batching several draft changes', async () => {
    const { session } = makeSession();
    // The loaded dashboard is at revision 1, so the first new commit is 2.
    await session.execute({ type: 'add-query', queryId: 'q1' });
    const c1 = await session.commit();
    expect(c1.ok && c1.dashboardRevision).toBe(2);
    expect(session.state.value.dirty).toBe(false);

    await session.execute({ type: 'add-query', queryId: 'q2' });
    await session.execute({ type: 'move-tile', tileId: 'g1', toIndex: 1 });
    const c2 = await session.commit();
    expect(c2.ok && c2.dashboardRevision).toBe(3);
  });

  it('leaves the draft dirty and the revision unchanged when persistence fails, and supports retry', async () => {
    const backing = makeStore();
    const repository = createWorkspaceRepository({ store: backing.store });
    let n = 0;
    const session = createDashboardAuthoringSession({ workspace: workspaceFixture(), repository, genId: () => `g${++n}` });
    await session.execute({ type: 'add-query', queryId: 'q1' });
    backing.setFailWrite(true);
    const failed = await session.commit();
    expect(failed.ok).toBe(false);
    expect(session.state.value.dirty).toBe(true);
    backing.setFailWrite(false);
    const retry = await session.commit();
    expect(retry.ok && retry.dashboardRevision).toBe(2); // the failed attempt did not consume a revision
  });

  it('starts an empty grafana-grid Dashboard (revision 1) with a columns-2 flow fallback when the workspace has none', async () => {
    const { session } = makeSession({ workspace: workspaceFixture({ dashboard: null }) });
    expect(session.state.value.document.id).toBe('g1');
    expect(session.state.value.document.revision).toBe(1);
    expect(session.state.value.document.layout).toEqual({
      type: 'grafana-grid', version: 1, items: {},
      fallback: { type: 'flow', version: 1, preset: 'columns-2', items: {} },
    });
    await session.execute({ type: 'add-query', queryId: 'q1' });
    const committed = await session.commit();
    expect(committed.ok && committed.dashboardRevision).toBe(1);
  });
});

describe('DashboardAuthoringSession — membership, export, lifecycle', () => {
  it('toggles membership through typed commands and dual-writes spec.favorite', async () => {
    const { session } = makeSession();
    await session.toggleMembership('q1');
    expect(session.state.value.document.tiles).toHaveLength(1);
    const on = await session.commit();
    const favOn = on.ok && on.workspace.queries.find((q) => q.id === 'q1');
    expect(favOn && favOn.spec.favorite).toBe(true);

    await session.toggleMembership('q1');
    expect(session.state.value.document.tiles).toHaveLength(0);
    const off = await session.commit();
    const favOff = off.ok && off.workspace.queries.find((q) => q.id === 'q1');
    expect(favOff && favOff.spec.favorite).toBe(false);
  });

  it('raw remove-tile cleans targets and mirrors membership for final and remaining instances', async () => {
    const query = {
      ...panelQuery('q1'), sql: 'SELECT {x:String} AS a, 1 AS b',
      spec: { ...panelQuery('q1').spec, favorite: true },
    };
    const workspace = workspaceFixture({
      queries: [query],
      dashboard: {
        ...emptyDash(),
        tiles: [{ id: 't1', queryId: 'q1' }, { id: 't2', queryId: 'q1' }],
        filters: [{ id: 'f1', parameter: 'x', targets: ['t1', 't2'] }],
      },
    } as StoredWorkspaceV1);
    const { session } = makeSession({ workspace });
    expect((await session.execute({ type: 'remove-tile', tileId: 't1' })).ok).toBe(true);
    let committed = await session.commit();
    expect(committed.ok && committed.workspace.queries[0].spec.favorite).toBe(true);
    expect(committed.ok && committed.workspace.dashboard!.filters[0].targets).toEqual(['t2']);
    expect(committed.ok && committed.dashboardRevision).toBe(2);

    expect((await session.execute({ type: 'remove-tile', tileId: 't2' })).ok).toBe(true);
    committed = await session.commit();
    expect(committed.ok && committed.workspace.queries[0].spec.favorite).toBe(false);
    expect(committed.ok && committed.workspace.dashboard!.filters[0].targets).toEqual([]);
    expect(committed.ok && committed.dashboardRevision).toBe(3);
  });

  it('a membership validation failure leaves both the Dashboard and favorite mirror unchanged', async () => {
    const query = {
      ...panelQuery('q1'), sql: 'SELECT {country:String} AS a, 1 AS b',
      spec: { ...panelQuery('q1').spec, favorite: true },
    };
    const workspace = workspaceFixture({
      queries: [query, filterQuery('source')],
      dashboard: {
        ...emptyDash(), tiles: [{ id: 't1', queryId: 'q1' }],
        filters: [{ id: 'flt', parameter: 'country', sourceQueryId: 'source', targets: ['t1'] }],
      },
    } as StoredWorkspaceV1);
    const { session } = makeSession({ workspace });
    const before = JSON.stringify(session.state.value.document);
    const result = await session.execute({ type: 'remove-tile', tileId: 't1' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostics.some((d) => d.code === 'filter-selection-no-consumers')).toBe(true);
    expect(JSON.stringify(session.state.value.document)).toBe(before);
    expect(session.state.value.draftVersion).toBe(0);
    expect(session.createPortableBundle().queries.find((q) => q.id === 'q1')?.spec.favorite).toBe(true);
  });

  it('builds a portable bundle of only the dependency queries and never increments revision', async () => {
    const fixed = makeSession({ nowISO: () => '2020-01-01T00:00:00Z' });
    await fixed.session.execute({ type: 'add-query', queryId: 'q1' });
    const bundle = fixed.session.createPortableBundle();
    expect(bundle.format).toBe('altinity-sql-browser/portable-bundle');
    expect(bundle.exportedAt).toBe('2020-01-01T00:00:00Z');
    expect(bundle.queries.map((q) => q.id)).toEqual(['q1']);
    expect(bundle.dashboards).toHaveLength(1);
    // Export did not bump the committed revision: the next commit is 2 (one
    // past the loaded revision 1), not 3.
    const committed = await fixed.session.commit();
    expect(committed.ok && committed.dashboardRevision).toBe(2);

    // Default nowISO produces a real ISO timestamp.
    const dflt = makeSession();
    expect(() => new Date(dflt.session.createPortableBundle().exportedAt).toISOString()).not.toThrow();
  });

  it('tracks the selected tile and rejects work after destroy', async () => {
    const { session } = makeSession();
    session.setSelectedTile('t1');
    expect(session.state.value.selectedTileId).toBe('t1');
    session.setSelectedTile(null);
    expect(session.state.value.selectedTileId).toBeNull();

    session.destroy();
    const execAfter = await session.execute({ type: 'add-query', queryId: 'q1' });
    expect(execAfter.ok).toBe(false);
    if (!execAfter.ok) expect(execAfter.diagnostics[0].code).toBe('dashboard-session-destroyed');
    const commitAfter = await session.commit();
    expect(commitAfter.ok).toBe(false);
    if (!commitAfter.ok) expect(commitAfter.diagnostics[0].code).toBe('dashboard-session-destroyed');
  });
});
