import { describe, expect, it } from 'vitest';
import {
  CURRENT_STORAGE_VERSION, DEFAULT_WORKSPACE_NAME,
  createNewWorkspace, generateWorkspaceId, importQueries,
  renameWorkspace, replaceWorkspaceContents,
} from '../../src/workspace/workspace-operations.js';
import type { SavedQueryV2, StoredWorkspaceV2 } from '../../src/generated/json-schema.types.js';

const query = (id: string): SavedQueryV2 => ({
  id, sql: 'SELECT 1', specVersion: 1, spec: { name: id, favorite: false },
});
const base = (): StoredWorkspaceV2 => ({
  storageVersion: 2,
  id: 'id-1',
  key: 'stable_key',
  name: 'Display name',
  queries: [query('q1')],
  dashboard: null,
});

describe('workspace operations', () => {
  it('creates an empty V2 workspace from the injected ID, key, and name', () => {
    const genId = () => 'opaque-id';
    expect(createNewWorkspace(genId, 'clickhouse_ops', 'ClickHouse Ops')).toEqual({
      storageVersion: CURRENT_STORAGE_VERSION,
      id: 'opaque-id',
      key: 'clickhouse_ops',
      name: 'ClickHouse Ops',
      queries: [],
      dashboard: null,
    });
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

  it('imports queries without changing identity or dashboard', () => {
    const workspace = base();
    const incoming = [query('q2')];
    const result = importQueries(workspace, incoming);
    expect(result.queries).toEqual(incoming);
    expect(result.queries).not.toBe(incoming);
    expect(result.id).toBe(workspace.id);
    expect(result.key).toBe(workspace.key);
    expect(result.dashboard).toBe(workspace.dashboard);
  });

  it('replaces portable contents while preserving local identity', () => {
    const workspace = base();
    const incoming = [query('q2')];
    const result = replaceWorkspaceContents(workspace, {
      queries: incoming,
      dashboard: null,
    });
    expect(result.queries).toEqual(incoming);
    expect(result.queries).not.toBe(incoming);
    expect(result.dashboard).toBeNull();
    expect(result.id).toBe(workspace.id);
    expect(result.key).toBe(workspace.key);
    expect(result.name).toBe(workspace.name);
  });
});
