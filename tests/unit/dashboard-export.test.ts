import { describe, expect, it } from 'vitest';
import {
  buildDashboardExportBundle, buildWorkspaceExportBundle,
} from '../../src/dashboard/model/dashboard-export.js';
import { canonicalEqual } from '../../src/dashboard/model/canonical-json.js';
import type {
  DashboardDocumentV1, SavedQueryV2, StoredWorkspaceV1,
} from '../../src/generated/json-schema.types.js';

const query = (id: string): SavedQueryV2 => ({
  id, sql: `SELECT '${id}'`, specVersion: 1, spec: { name: id },
});

const dashboard = (
  id: string, tileQueryIds: string[], filterSourceIds: string[] = [],
): DashboardDocumentV1 => ({
  documentVersion: 1, id, title: `Dashboard ${id}`, revision: 3,
  layout: { type: 'flow', version: 1, preset: 'report', items: {} },
  tiles: tileQueryIds.map((queryId, index) => ({
    id: `${id}-t${index}`, queryId, presentation: { kind: 'table' },
  } as unknown as DashboardDocumentV1['tiles'][number])),
  filters: filterSourceIds.map((sourceQueryId, index) => ({
    id: `${id}-f${index}`, parameter: `p${index}`, sourceQueryId,
  } as unknown as DashboardDocumentV1['filters'][number])),
});

describe('buildDashboardExportBundle', () => {
  it('emits the dependency closure (tiles then filter sources, each once), excluding unrelated queries', () => {
    const dash = dashboard('d1', ['q3', 'q1', 'q3'], ['q1', 'q9']);
    const queries = [query('q1'), query('q2'), query('q3'), query('q9'), query('unrelated')];
    const bundle = buildDashboardExportBundle(dash, queries, '2020-01-01T00:00:00Z');

    expect(bundle.format).toBe('altinity-sql-browser/portable-bundle');
    expect(bundle.version).toBe(1);
    expect(bundle.exportedAt).toBe('2020-01-01T00:00:00Z');
    expect(bundle.queries.map((q) => q.id)).toEqual(['q3', 'q1', 'q9']);
    expect(bundle.dashboards).toHaveLength(1);
    expect(bundle.dashboards[0]?.id).toBe('d1');
  });

  it('skips a dependency id that has no matching query', () => {
    const dash = dashboard('d1', ['q1', 'missing']);
    const queries = [query('q1')];
    const bundle = buildDashboardExportBundle(dash, queries, '2020-01-01T00:00:00Z');
    expect(bundle.queries.map((q) => q.id)).toEqual(['q1']);
  });

  it('uses the first catalog entry when duplicate query ids are supplied', () => {
    const first = query('q1');
    const duplicate = { ...query('q1'), sql: 'SELECT duplicate' };
    const bundle = buildDashboardExportBundle(
      dashboard('d1', ['q1']), [first, duplicate], '2020-01-01T00:00:00Z',
    );
    expect(bundle.queries).toEqual([first]);
  });

  it('deep-clones the dashboard and queries — mutating the result never touches the inputs', () => {
    const dash = dashboard('d1', ['q1']);
    const queries = [query('q1')];
    const bundle = buildDashboardExportBundle(dash, queries, '2020-01-01T00:00:00Z');

    expect(bundle.dashboards[0]).not.toBe(dash);
    expect(bundle.queries[0]).not.toBe(queries[0]);

    (bundle.dashboards[0] as DashboardDocumentV1).title = 'mutated';
    (bundle.dashboards[0] as DashboardDocumentV1).revision = 999;
    (bundle.queries[0] as SavedQueryV2).sql = 'DROP TABLE x';

    expect(dash.title).toBe('Dashboard d1');
    expect(dash.revision).toBe(3);
    expect(queries[0]?.sql).toBe("SELECT 'q1'");
  });

  // REGRESSION: an export must never mutate the caller's Dashboard identity
  // or persisted revision — this is the deep-clone proof the export path
  // relies on to keep `commit()`'s revision counter honest (#280/#287).
  it('REGRESSION: leaves the input dashboard revision and identity unchanged', () => {
    const dash = dashboard('d1', ['q1']);
    const originalRevision = dash.revision;
    const originalRef = dash;
    buildDashboardExportBundle(dash, [query('q1')], '2020-01-01T00:00:00Z');
    expect(dash).toBe(originalRef);
    expect(dash.revision).toBe(originalRevision);
  });
});

describe('buildWorkspaceExportBundle', () => {
  const workspaceFixture = (over: Partial<StoredWorkspaceV1> = {}): StoredWorkspaceV1 => ({
    storageVersion: 1, id: 'ws', name: 'WS',
    queries: [query('q2'), query('q1'), query('q3')],
    dashboard: dashboard('d1', ['q1']),
    ...over,
  } as StoredWorkspaceV1);

  it('emits every query in catalog order, not reordered by Dashboard tile usage', () => {
    const ws = workspaceFixture();
    const bundle = buildWorkspaceExportBundle(ws, '2020-01-01T00:00:00Z');
    expect(bundle.queries.map((q) => q.id)).toEqual(['q2', 'q1', 'q3']);
    expect(bundle.dashboards).toHaveLength(1);
    expect(bundle.dashboards[0]?.id).toBe('d1');
  });

  it('emits zero dashboards when the workspace has none', () => {
    const ws = workspaceFixture({ dashboard: null });
    const bundle = buildWorkspaceExportBundle(ws, '2020-01-01T00:00:00Z');
    expect(bundle.dashboards).toEqual([]);
    expect(bundle.queries.map((q) => q.id)).toEqual(['q2', 'q1', 'q3']);
  });

  it('sets format/version/exportedAt fields', () => {
    const bundle = buildWorkspaceExportBundle(workspaceFixture(), '2021-06-15T12:00:00Z');
    expect(bundle.format).toBe('altinity-sql-browser/portable-bundle');
    expect(bundle.version).toBe(1);
    expect(bundle.exportedAt).toBe('2021-06-15T12:00:00Z');
  });

  it('deep-clones queries and the dashboard — mutating the result never touches the input workspace', () => {
    const ws = workspaceFixture();
    const bundle = buildWorkspaceExportBundle(ws, '2020-01-01T00:00:00Z');

    expect(bundle.queries[0]).not.toBe(ws.queries[0]);
    expect(bundle.dashboards[0]).not.toBe(ws.dashboard);

    (bundle.queries[0] as SavedQueryV2).sql = 'DROP TABLE x';
    (bundle.dashboards[0] as DashboardDocumentV1).revision = 999;

    expect(ws.queries[0]?.sql).toBe("SELECT 'q2'");
    expect(ws.dashboard?.revision).toBe(3);
  });

  // REGRESSION: a full-workspace export must never mutate the caller's
  // Dashboard identity or persisted revision (#280/#287 deep-clone proof).
  it('REGRESSION: leaves the input workspace.dashboard revision and identity unchanged', () => {
    const ws = workspaceFixture();
    const originalDashboardRef = ws.dashboard;
    const originalRevision = ws.dashboard?.revision;
    buildWorkspaceExportBundle(ws, '2020-01-01T00:00:00Z');
    expect(ws.dashboard).toBe(originalDashboardRef);
    expect(ws.dashboard?.revision).toBe(originalRevision);
  });
});

// #341 canonical-consistency invariant: given ONE committed workspace and the
// SAME export timestamp, the Dashboard document and every SHARED saved-query
// resource must be canonically identical across both bundles — only unrelated
// Workbench-only queries may differ (present in the workspace bundle, absent
// from the Dashboard dependency closure).
describe('canonical consistency between the two export bundles (#341)', () => {
  const nowISO = '2020-01-01T00:00:00Z';
  // A workspace whose Dashboard depends on q1 (tile) + q2 (filter source), plus
  // an unrelated q3 that only the Workbench export carries.
  const ws: StoredWorkspaceV1 = {
    storageVersion: 1, id: 'ws', name: 'WS',
    queries: [query('q3'), query('q1'), query('q2')], // deliberately not tile order
    dashboard: dashboard('d1', ['q1'], ['q2']),
  };

  it('the Dashboard document is canonically identical in both bundles', () => {
    const dashboardBundle = buildDashboardExportBundle(ws.dashboard!, ws.queries, nowISO);
    const workspaceBundle = buildWorkspaceExportBundle(ws, nowISO);
    expect(canonicalEqual(dashboardBundle.dashboards[0], workspaceBundle.dashboards[0])).toBe(true);
  });

  it('every query in the Dashboard dependency closure is canonically identical in both bundles', () => {
    const dashboardBundle = buildDashboardExportBundle(ws.dashboard!, ws.queries, nowISO);
    const workspaceBundle = buildWorkspaceExportBundle(ws, nowISO);
    for (const dashboardQuery of dashboardBundle.queries) {
      const workspaceQuery = workspaceBundle.queries.find((q) => q.id === dashboardQuery.id);
      expect(workspaceQuery).toBeDefined();
      expect(canonicalEqual(dashboardQuery, workspaceQuery)).toBe(true);
    }
  });

  it('only unrelated Workbench-only queries differ — the extra query is absent from the Dashboard closure', () => {
    const dashboardBundle = buildDashboardExportBundle(ws.dashboard!, ws.queries, nowISO);
    const workspaceBundle = buildWorkspaceExportBundle(ws, nowISO);
    const dashIds = dashboardBundle.queries.map((q) => q.id).sort();
    const wsIds = workspaceBundle.queries.map((q) => q.id).sort();
    expect(dashIds).toEqual(['q1', 'q2']); // closure only
    expect(wsIds).toEqual(['q1', 'q2', 'q3']); // full catalog
    expect(wsIds.filter((id) => !dashIds.includes(id))).toEqual(['q3']); // the only difference
  });
});
