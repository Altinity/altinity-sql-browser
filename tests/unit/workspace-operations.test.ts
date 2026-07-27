import { describe, expect, it } from 'vitest';
import {
  CURRENT_STORAGE_VERSION, DEFAULT_WORKSPACE_NAME,
  appendDashboard, createNewWorkspace, generateWorkspaceId, importQueries,
  renameWorkspace, replaceWorkspaceContents,
} from '../../src/workspace/workspace-operations.js';
import type {
  DashboardDocumentV2, SavedQueryV2, StoredWorkspaceV5,
} from '../../src/generated/json-schema.types.js';

const query = (id: string): SavedQueryV2 => ({
  id, sql: 'SELECT 1', specVersion: 1, spec: { name: id, favorite: false },
});
const dashboard = (id: string): DashboardDocumentV2 => ({
  documentVersion: 2, id, title: id.toUpperCase(), revision: 1,
  layout: { type: 'flow', version: 1, preset: 'report', items: {} }, tiles: [],
});
const base = (): StoredWorkspaceV5 => ({
  storageVersion: 5,
  id: 'id-1',
  key: 'stable_key',
  name: 'Display name',
  queries: [query('q1')],
  dashboards: [dashboard('d1')],
});

describe('workspace operations', () => {
  it('creates an empty V5 workspace from the injected ID, key, and name', () => {
    const genId = () => 'opaque-id';
    expect(createNewWorkspace(genId, 'clickhouse_ops', 'ClickHouse Ops')).toEqual({
      storageVersion: CURRENT_STORAGE_VERSION,
      id: 'opaque-id',
      key: 'clickhouse_ops',
      name: 'ClickHouse Ops',
      queries: [],
      dashboards: [],
    });
    expect(CURRENT_STORAGE_VERSION).toBe(5);
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

  // #463 — the additive Dashboard write behind New dashboard and Import
  // dashboard.
  it('appends a Dashboard last, preserving every existing entry and its order', () => {
    const workspace = { ...base(), dashboards: [dashboard('d1'), dashboard('d2')] };
    const added = dashboard('d3');
    const result = appendDashboard(workspace, added);
    expect(result.dashboards.map((d) => d.id)).toEqual(['d1', 'd2', 'd3']);
    expect(result.dashboards[2]).toBe(added);
    // Existing entries are carried through by reference — byte-for-byte, with
    // no clone that could quietly normalize one.
    expect(result.dashboards[0]).toBe(workspace.dashboards[0]);
    expect(result.dashboards[1]).toBe(workspace.dashboards[1]);
    expect(result.queries).toBe(workspace.queries);
    expect(result.id).toBe(workspace.id);
    expect(result.key).toBe(workspace.key);
    expect(result.name).toBe(workspace.name);
    // Never mutates the input.
    expect(workspace.dashboards).toHaveLength(2);
    expect(result.dashboards).not.toBe(workspace.dashboards);
  });

  it('appends into an empty collection as the sole Dashboard', () => {
    const workspace = { ...base(), dashboards: [] };
    expect(appendDashboard(workspace, dashboard('first')).dashboards.map((d) => d.id))
      .toEqual(['first']);
  });

  // Duplicate TITLES are allowed — identity is the id — so two Dashboards named
  // the same must both survive the append.
  it('appends a Dashboard whose title duplicates an existing one', () => {
    const twin = { ...dashboard('d2'), title: 'D1' };
    const result = appendDashboard(base(), twin);
    expect(result.dashboards.map((d) => d.title)).toEqual(['D1', 'D1']);
    expect(result.dashboards.map((d) => d.id)).toEqual(['d1', 'd2']);
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
