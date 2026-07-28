import { describe, expect, it } from 'vitest';
import { createPanelCandidate } from '../../src/dashboard/application/panel-creation.js';
import { libraryQueries } from '../../src/dashboard/model/query-ownership.js';
import { PORTABLE_LIMITS } from '../../src/dashboard/model/portable-limits.js';
import { savedQuery } from '../helpers/saved-query.js';
import type { DashboardDocumentV2, StoredWorkspaceV5 } from '../../src/generated/json-schema.types.js';

const dash = (id: string, over: Partial<DashboardDocumentV2> = {}): DashboardDocumentV2 => ({
  documentVersion: 2, id, title: id.toUpperCase(), revision: 1,
  layout: { type: 'flow', version: 1, preset: 'report', items: {} },
  tiles: [], ...over,
});

const ws = (over: Partial<StoredWorkspaceV5> = {}): StoredWorkspaceV5 => ({
  storageVersion: 5, id: 'w', key: 'workspace', name: 'Workspace',
  queries: [], dashboards: [dash('d1')], ...over,
});

const input = {
  dashboardId: 'd1', queryId: 'q-new', tileId: 't-new',
  name: '  Revenue  ', description: '  Daily revenue  ',
};

describe('createPanelCandidate', () => {
  it('atomically appends one blank panel-role query and one identity-only tile', () => {
    const result = createPanelCandidate({ latest: ws(), ...input });
    if (!result.ok) throw new Error(result.reason);

    expect(result.data).toEqual({ queryId: 'q-new', tileId: 't-new' });
    expect(result.workspace.queries).toEqual([{
      id: 'q-new',
      sql: '',
      specVersion: 1,
      spec: {
        name: 'Revenue',
        description: 'Daily revenue',
        dashboard: { role: 'panel' },
      },
    }]);
    expect(result.workspace.dashboards[0].tiles).toEqual([{ id: 't-new', queryId: 'q-new' }]);
    expect(Object.keys(result.workspace.dashboards[0].tiles[0]).sort()).toEqual(['id', 'queryId']);
    expect(result.workspace.queries[0].spec.favorite).toBeUndefined();
  });

  it('omits an empty optional description and is Dashboard-owned immediately', () => {
    const result = createPanelCandidate({
      latest: ws(), ...input, description: '   ',
    });
    if (!result.ok) throw new Error(result.reason);

    expect(result.workspace.queries[0].spec.description).toBeUndefined();
    expect(libraryQueries(result.workspace)).toEqual([]);
  });

  it('uses the canonical add path for flow placement and normalization', () => {
    const result = createPanelCandidate({ latest: ws(), ...input });
    if (!result.ok) throw new Error(result.reason);
    expect(result.workspace.dashboards[0].layout.items).toEqual({});
  });

  it('uses the canonical add path for grid placement and flow-fallback regeneration', () => {
    const latest = ws({
      dashboards: [dash('d1', {
        layout: {
          type: 'grafana-grid', version: 1, items: {},
          fallback: { type: 'flow', version: 1, preset: 'report', items: {} },
        },
      })],
    });
    const result = createPanelCandidate({ latest, ...input });
    if (!result.ok) throw new Error(result.reason);
    const layout = result.workspace.dashboards[0].layout as {
      items: Record<string, unknown>;
      fallback: { items: Record<string, unknown> };
    };
    expect(layout.items['t-new']).toBeDefined();
    expect(layout.fallback.items['t-new']).toBeDefined();
  });

  it('increments only the target revision and preserves unrelated content', () => {
    const existing = savedQuery({ id: 'q-old', sql: 'SELECT 1', name: 'Existing', favorite: true });
    const other = dash('d2', {
      revision: 9,
      tiles: [{ id: 't-old', queryId: 'q-old' }],
      variableConfigs: { region: { sql: 'SELECT region' } },
    });
    const latest = ws({
      queries: [existing],
      dashboards: [dash('d1', { revision: 4 }), other],
    });
    const result = createPanelCandidate({ latest, ...input });
    if (!result.ok) throw new Error(result.reason);

    expect(result.workspace.dashboards[0].revision).toBe(5);
    expect(result.workspace.dashboards[1]).toBe(other);
    expect(result.workspace.queries[0]).toBe(existing);
    expect(result.workspace.dashboards[1]).toEqual(other);
    expect(result.workspace.queries[0]).toEqual(existing);
  });

  it.each([
    ['missing Dashboard', ws({ dashboards: [] }), 'dashboard-missing'],
    ['ambiguous Dashboard', ws({ dashboards: [dash('d1'), dash('d1')] }), 'dashboard-ambiguous'],
    ['query-id collision', ws({ queries: [savedQuery({ id: 'q-new' })] }), 'id-collision'],
    ['tile-id collision', ws({ dashboards: [dash('d1', { tiles: [{ id: 't-new', queryId: 'old' }] })] }), 'id-collision'],
  ] as const)('rejects a %s without mutating the input', (_label, latest, reason) => {
    const before = structuredClone(latest);
    expect(createPanelCandidate({ latest, ...input })).toEqual({ ok: false, reason });
    expect(latest).toEqual(before);
  });

  it('re-checks the 100-tile limit against the latest Dashboard', () => {
    const tiles = Array.from({ length: PORTABLE_LIMITS.maxTilesPerDashboard }, (_, i) => ({
      id: 't' + i, queryId: 'q' + i,
    }));
    expect(createPanelCandidate({
      latest: ws({ dashboards: [dash('d1', { tiles })] }), ...input,
    })).toEqual({ ok: false, reason: 'tile-limit' });
  });

  it('rejects a blank trimmed name', () => {
    expect(createPanelCandidate({
      latest: ws(), ...input, name: '  ',
    })).toEqual({ ok: false, reason: 'blank-name' });
  });
});
