import { describe, expect, it } from 'vitest';
import { removeDashboardDocument, removeDashboardPanel } from '../../src/dashboard/application/dashboard-removal.js';
import type {
  DashboardDocumentV2, SavedQueryV2, StoredWorkspaceV5,
} from '../../src/generated/json-schema.types.js';

const panelQuery = (id: string): SavedQueryV2 => ({
  id, sql: 'SELECT 1', specVersion: 1, spec: { name: id, dashboard: { role: 'panel' } },
} as SavedQueryV2);

const dashboard = (over: Partial<DashboardDocumentV2> = {}): DashboardDocumentV2 => ({
  documentVersion: 2, id: 'dash', title: 'D', revision: 1,
  layout: { type: 'flow', version: 1, preset: 'report', items: {} },
  tiles: [], ...over,
} as DashboardDocumentV2);

const workspace = (over: Partial<StoredWorkspaceV5> = {}): StoredWorkspaceV5 => ({
  storageVersion: 5, id: 'ws1', key: 'ws1', name: 'W',
  queries: [], dashboards: [], ...over,
} as StoredWorkspaceV5);

// Deep snapshot so a refusal test can prove the input was never touched,
// independent of which nested object identity the transform happens to reuse.
const snapshot = (input: StoredWorkspaceV5): unknown => JSON.parse(JSON.stringify(input));

describe('removeDashboardPanel (#429, #494)', () => {
  it('removes the tile and its dedicated query, bumps revision by one, leaves everything else alone', () => {
    const input = workspace({
      queries: [panelQuery('p1'), panelQuery('p2'), panelQuery('other-p')],
      dashboards: [
        dashboard({
          id: 'dash', revision: 3,
          tiles: [{ id: 't1', queryId: 'p1' }, { id: 't2', queryId: 'p2' }],
          layout: { type: 'flow', version: 1, preset: 'report', items: { t1: {}, t2: {} } },
          // An entry with no matching panel declaration is already an orphaned
          // configuration by #457's own rule — asserting it survives the
          // delete proves #494's non-goal (no side-effect cleanup here), not
          // that this transform infers anything about it.
          variableConfigs: { orphanVar: { sql: 'SELECT 1' } },
        }),
        dashboard({ id: 'dash2', revision: 5, tiles: [{ id: 'tx', queryId: 'other-p' }] }),
      ],
    });
    const before = snapshot(input);

    const result = removeDashboardPanel({ workspace: input, dashboardId: 'dash', tileId: 't1', queryId: 'p1' });
    if (result.status !== 'ok') throw new Error(`expected ok, got ${result.status}`);

    expect(result.queryId).toBe('p1');
    const changed = result.workspace.dashboards.find((candidate) => candidate.id === 'dash')!;
    expect(changed.tiles).toEqual([{ id: 't2', queryId: 'p2' }]);
    expect(changed.revision).toBe(4);
    expect(changed.variableConfigs).toEqual({ orphanVar: { sql: 'SELECT 1' } });

    expect(result.workspace.queries.map((query) => query.id)).toEqual(['p2', 'other-p']);
    expect(result.workspace.dashboards.map((candidate) => candidate.id)).toEqual(['dash', 'dash2']);
    // The other Dashboard is byte-identical — same reference even, since this
    // transform never rebuilds an entry it did not target.
    expect(result.workspace.dashboards[1]).toBe(input.dashboards[1]);

    expect(snapshot(input)).toEqual(before);
  });

  it('normalizes grafana-grid primary and fallback placements after the removal', () => {
    const input = workspace({
      queries: [panelQuery('p1'), panelQuery('p2')],
      dashboards: [dashboard({
        tiles: [{ id: 't1', queryId: 'p1' }, { id: 't2', queryId: 'p2' }],
        layout: {
          type: 'grafana-grid', version: 1,
          items: { t1: { colStart: 0, span: 6, height: 2 }, t2: { colStart: 6, span: 6, height: 3 } },
          fallback: {
            type: 'flow', version: 1, preset: 'columns-2',
            items: { t1: { span: 2, height: 'medium' }, t2: { span: 2, height: 'large' } },
          },
        },
      })],
    });

    const result = removeDashboardPanel({ workspace: input, dashboardId: 'dash', tileId: 't1', queryId: 'p1' });
    if (result.status !== 'ok') throw new Error(`expected ok, got ${result.status}`);

    const layout = result.workspace.dashboards[0].layout as {
      items: Record<string, unknown>; fallback: { items: Record<string, unknown> };
    };
    expect(layout.items).toEqual({ t2: { colStart: 6, span: 6, height: 3 } });
    expect(layout.fallback.items).toEqual({ t2: { span: 2, height: 'large' } });
  });

  it('refuses dashboard-missing and commits nothing', () => {
    const input = workspace({ dashboards: [dashboard()] });
    const before = snapshot(input);
    expect(removeDashboardPanel({ workspace: input, dashboardId: 'nope', tileId: 't1', queryId: 'p1' }))
      .toEqual({ status: 'refused', reason: 'dashboard-missing' });
    expect(snapshot(input)).toEqual(before);
  });

  it('refuses dashboard-duplicate and commits nothing', () => {
    const input = workspace({
      dashboards: [dashboard({ id: 'dup', tiles: [{ id: 't1', queryId: 'p1' }] }), dashboard({ id: 'dup' })],
      queries: [panelQuery('p1')],
    });
    const before = snapshot(input);
    expect(removeDashboardPanel({ workspace: input, dashboardId: 'dup', tileId: 't1', queryId: 'p1' }))
      .toEqual({ status: 'refused', reason: 'dashboard-duplicate' });
    expect(snapshot(input)).toEqual(before);
  });

  it('refuses tile-missing and commits nothing', () => {
    const input = workspace({
      dashboards: [dashboard({ tiles: [{ id: 't1', queryId: 'p1' }] })],
      queries: [panelQuery('p1')],
    });
    const before = snapshot(input);
    expect(removeDashboardPanel({ workspace: input, dashboardId: 'dash', tileId: 'missing', queryId: 'p1' }))
      .toEqual({ status: 'refused', reason: 'tile-missing' });
    expect(snapshot(input)).toEqual(before);
  });

  it('refuses ownership-unproven when the queryId names no query in the collection', () => {
    const input = workspace({
      dashboards: [dashboard({ tiles: [{ id: 't1', queryId: 'ghost' }] })],
      queries: [],
    });
    const before = snapshot(input);
    expect(removeDashboardPanel({ workspace: input, dashboardId: 'dash', tileId: 't1', queryId: 'ghost' }))
      .toEqual({ status: 'refused', reason: 'ownership-unproven' });
    expect(snapshot(input)).toEqual(before);
  });

  it('refuses ownership-unproven when two tiles of the SAME Dashboard reference the query', () => {
    const input = workspace({
      dashboards: [dashboard({
        tiles: [{ id: 't1', queryId: 'p1' }, { id: 't2', queryId: 'p1' }],
      })],
      queries: [panelQuery('p1')],
    });
    const before = snapshot(input);
    expect(removeDashboardPanel({ workspace: input, dashboardId: 'dash', tileId: 't1', queryId: 'p1' }))
      .toEqual({ status: 'refused', reason: 'ownership-unproven' });
    expect(snapshot(input)).toEqual(before);
  });

  it('refuses ownership-unproven when the query is also owned by a DIFFERENT Dashboard\'s tile', () => {
    const input = workspace({
      dashboards: [
        dashboard({ id: 'dash', tiles: [{ id: 't1', queryId: 'p1' }] }),
        dashboard({ id: 'dash2', tiles: [{ id: 't9', queryId: 'p1' }] }),
      ],
      queries: [panelQuery('p1')],
    });
    const before = snapshot(input);
    expect(removeDashboardPanel({ workspace: input, dashboardId: 'dash', tileId: 't1', queryId: 'p1' }))
      .toEqual({ status: 'refused', reason: 'ownership-unproven' });
    expect(snapshot(input)).toEqual(before);
  });
});

/**
 * #494 review round 2 — the identity the CONFIRMATION named must still be the
 * identity being destroyed.
 *
 * The transform used to resolve the tile and then delete "whatever query it
 * points at now", by `filter`, which meant three ways to destroy the wrong
 * thing. All three inputs below are states the codec forbids (a duplicate id
 * or a Setup-role reference cannot be loaded OR committed) except the FIRST,
 * which is two perfectly valid states with a re-point in between — so this
 * transform must not be the thing that assumes it is safe.
 */
describe('removeDashboardPanel — the captured identity is re-proven (#494)', () => {
  it('refuses a tile that was re-pointed at a DIFFERENT query while the confirmation was open', () => {
    const input = workspace({
      queries: [panelQuery('p1'), panelQuery('p2')],
      dashboards: [dashboard({ tiles: [{ id: 't1', queryId: 'p2' }] })],
    });
    const before = snapshot(input);
    // The user confirmed removing the panel backed by `p1`.
    expect(removeDashboardPanel({ workspace: input, dashboardId: 'dash', tileId: 't1', queryId: 'p1' }))
      .toEqual({ status: 'refused', reason: 'tile-retargeted' });
    expect(snapshot(input)).toEqual(before);
  });

  it('refuses an ambiguous TILE id rather than removing both tiles', () => {
    // The removal is a `filter` by id: resolving "the first match" and then
    // filtering would take the other tile out too, and orphan its query.
    const input = workspace({
      queries: [panelQuery('p1'), panelQuery('p2')],
      dashboards: [dashboard({ tiles: [{ id: 't1', queryId: 'p1' }, { id: 't1', queryId: 'p2' }] })],
    });
    const before = snapshot(input);
    expect(removeDashboardPanel({ workspace: input, dashboardId: 'dash', tileId: 't1', queryId: 'p1' }))
      .toEqual({ status: 'refused', reason: 'tile-duplicate' });
    expect(snapshot(input)).toEqual(before);
  });

  it('refuses an ambiguous QUERY id rather than deleting every document carrying it', () => {
    const input = workspace({
      queries: [panelQuery('p1'), panelQuery('p1')],
      dashboards: [dashboard({ tiles: [{ id: 't1', queryId: 'p1' }] })],
    });
    const before = snapshot(input);
    expect(removeDashboardPanel({ workspace: input, dashboardId: 'dash', tileId: 't1', queryId: 'p1' }))
      .toEqual({ status: 'refused', reason: 'tile-duplicate' });
    expect(snapshot(input)).toEqual(before);
  });

  it('refuses a tile referencing a query that is not a PANEL query', () => {
    // `dashboard-setup-reference` is malformed data. Deleting through it would
    // "repair" the workspace by destroying the evidence — fail closed.
    const setup = { ...panelQuery('s1'), spec: { name: 's1', dashboard: { role: 'setup' } } } as typeof input.queries[number];
    const input = workspace({
      queries: [setup],
      dashboards: [dashboard({ tiles: [{ id: 't1', queryId: 's1' }] })],
    });
    const before = snapshot(input);
    expect(removeDashboardPanel({ workspace: input, dashboardId: 'dash', tileId: 't1', queryId: 's1' }))
      .toEqual({ status: 'refused', reason: 'ownership-unproven' });
    expect(snapshot(input)).toEqual(before);
  });
});

describe('removeDashboardDocument (#429, #494)', () => {
  it('deletes the document and recursively the queries only it owns, keeping a Library query and a shared query', () => {
    const input = workspace({
      queries: [
        panelQuery('p1'), panelQuery('p2'), panelQuery('dup'), panelQuery('shared'), panelQuery('lib1'),
      ],
      dashboards: [
        dashboard({
          id: 'dash',
          tiles: [
            { id: 't1', queryId: 'p1' },
            { id: 't2', queryId: 'p2' },
            { id: 't3', queryId: 'dup' },
            { id: 't4', queryId: 'dup' },
            { id: 't5', queryId: 'shared' },
          ],
        }),
        dashboard({ id: 'dash2', tiles: [{ id: 't9', queryId: 'shared' }] }),
      ],
    });
    const before = snapshot(input);

    const result = removeDashboardDocument({ workspace: input, dashboardId: 'dash' });
    if (result.status !== 'ok') throw new Error(`expected ok, got ${result.status}`);

    // Tile order, deduplicated: t3 and t4 both name 'dup' but it is reported
    // (and removed) exactly once. 'shared' is kept — dash2's own tile still
    // references it, so it is not this Dashboard's alone to remove.
    expect(result.removedQueryIds).toEqual(['p1', 'p2', 'dup']);

    expect(result.workspace.dashboards.map((candidate) => candidate.id)).toEqual(['dash2']);
    expect(result.workspace.queries.map((query) => query.id)).toEqual(['shared', 'lib1']);
    // dash2 and its tile are untouched by a document delete that targeted 'dash'.
    expect(result.workspace.dashboards[0]).toBe(input.dashboards[1]);

    expect(snapshot(input)).toEqual(before);
  });

  it('skips a tile whose queryId names no query in the collection, removing nothing for it', () => {
    const input = workspace({
      dashboards: [dashboard({ tiles: [{ id: 't1', queryId: 'ghost' }] })],
      queries: [],
    });
    const result = removeDashboardDocument({ workspace: input, dashboardId: 'dash' });
    if (result.status !== 'ok') throw new Error(`expected ok, got ${result.status}`);
    expect(result.removedQueryIds).toEqual([]);
    expect(result.workspace.dashboards).toEqual([]);
  });

  it('refuses dashboard-missing and commits nothing', () => {
    const input = workspace({ dashboards: [dashboard()] });
    const before = snapshot(input);
    expect(removeDashboardDocument({ workspace: input, dashboardId: 'nope' }))
      .toEqual({ status: 'refused', reason: 'dashboard-missing' });
    expect(snapshot(input)).toEqual(before);
  });

  it('refuses dashboard-duplicate and commits nothing', () => {
    const input = workspace({ dashboards: [dashboard({ id: 'dup' }), dashboard({ id: 'dup' })] });
    const before = snapshot(input);
    expect(removeDashboardDocument({ workspace: input, dashboardId: 'dup' }))
      .toEqual({ status: 'refused', reason: 'dashboard-duplicate' });
    expect(snapshot(input)).toEqual(before);
  });
});

describe('removeDashboardDocument — ambiguous ids (#494)', () => {
  it('keeps a query id carried by two documents rather than deleting both', () => {
    const input = workspace({
      queries: [panelQuery('p1'), panelQuery('p1'), panelQuery('lib')],
      dashboards: [dashboard({ tiles: [{ id: 't1', queryId: 'p1' }] })],
    });
    const result = removeDashboardDocument({ workspace: input, dashboardId: 'dash' });
    if (result.status !== 'ok') throw new Error(`expected ok, got ${result.status}`);
    // The Dashboard goes; the ambiguous pair stays. An orphaned copy is
    // recoverable, a destroyed one is not.
    expect(result.workspace.dashboards).toEqual([]);
    expect(result.removedQueryIds).toEqual([]);
    expect(result.workspace.queries.map((query) => query.id)).toEqual(['p1', 'p1', 'lib']);
  });
});
