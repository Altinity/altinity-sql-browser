import { describe, expect, it } from 'vitest';
import {
  CURRENT_STORAGE_VERSION, DEFAULT_WORKSPACE_NAME,
  createNewWorkspace, generateWorkspaceId, importQueries,
  renameWorkspace, replaceWorkspaceContents,
} from '../../src/workspace/workspace-operations.js';
import type {
  DashboardDocumentV1, SavedQueryV2, StoredWorkspaceV4,
} from '../../src/generated/json-schema.types.js';

const query = (id: string): SavedQueryV2 => ({
  id, sql: 'SELECT 1', specVersion: 1, spec: { name: id, favorite: false },
});
const dashboard = (id: string): DashboardDocumentV1 => ({
  documentVersion: 1, id, title: id.toUpperCase(), revision: 1,
  layout: { type: 'flow', version: 1, preset: 'report', items: {} }, filters: [], tiles: [],
});
const base = (): StoredWorkspaceV4 => ({
  storageVersion: 4,
  id: 'id-1',
  key: 'stable_key',
  name: 'Display name',
  queries: [query('q1')],
  dashboards: [dashboard('d1')],
});

describe('workspace operations', () => {
  it('creates an empty V4 workspace from the injected ID, key, and name', () => {
    const genId = () => 'opaque-id';
    expect(createNewWorkspace(genId, 'clickhouse_ops', 'ClickHouse Ops')).toEqual({
      storageVersion: CURRENT_STORAGE_VERSION,
      id: 'opaque-id',
      key: 'clickhouse_ops',
      name: 'ClickHouse Ops',
      queries: [],
      dashboards: [],
    });
    expect(CURRENT_STORAGE_VERSION).toBe(4);
    expect(generateWorkspaceId(genId)).toBe('opaque-id');
  });

  it('uses the default display name for missing, blank, or non-string names', () => {
    expect(createNewWorkspace(() => 'a', 'a').name).toBe(DEFAULT_WORKSPACE_NAME);
    expect(createNewWorkspace(() => 'b', 'b', '  ').name).toBe(DEFAULT_WORKSPACE_NAME);
    expect(createNewWorkspace(() => 'c', 'c', 12).name).toBe(DEFAULT_WORKSPACE_NAME);
  });

  it('renames only the mutable display name', () => {
    const workspace = base();
    const renamed = renameWorkspace(workspace, 'Renamed');
    expect(renamed).toEqual({ ...workspace, name: 'Renamed' });
    expect(renamed.id).toBe(workspace.id);
    expect(renamed.key).toBe(workspace.key);
    expect(renamed.queries).toBe(workspace.queries);
    expect(renameWorkspace(workspace, '').name).toBe(DEFAULT_WORKSPACE_NAME);
  });

  it('imports queries without changing identity or any Dashboard', () => {
    const workspace = { ...base(), dashboards: [dashboard('d1'), dashboard('d2')] };
    const incoming = [query('q2')];
    const result = importQueries(workspace, incoming);
    expect(result.queries).toEqual(incoming);
    expect(result.queries).not.toBe(incoming);
    expect(result.id).toBe(workspace.id);
    expect(result.key).toBe(workspace.key);
    // #424: EVERY Dashboard survives a query-only import, byte-identical.
    expect(result.dashboards).toEqual(workspace.dashboards);
    expect(result.dashboards).not.toBe(workspace.dashboards);
    expect(result.dashboards[1]).toBe(workspace.dashboards[1]);
  });

  it('replaces portable contents while preserving local identity', () => {
    const workspace = base();
    const incoming = [query('q2')];
    const replacement = [dashboard('imported-a'), dashboard('imported-b')];
    const result = replaceWorkspaceContents(workspace, {
      queries: incoming,
      dashboards: replacement,
    });
    expect(result.queries).toEqual(incoming);
    expect(result.queries).not.toBe(incoming);
    // #424: the incoming collection — and its ORDER — becomes the workspace's.
    expect(result.dashboards.map((d) => d.id)).toEqual(['imported-a', 'imported-b']);
    expect(result.dashboards).not.toBe(replacement);
    expect(replaceWorkspaceContents(workspace, { queries: incoming, dashboards: [] }).dashboards)
      .toEqual([]);
    expect(result.id).toBe(workspace.id);
    expect(result.key).toBe(workspace.key);
    expect(result.name).toBe(workspace.name);
  });
});
