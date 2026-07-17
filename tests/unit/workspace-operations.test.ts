import { describe, expect, it } from 'vitest';
import {
  CURRENT_STORAGE_VERSION, DEFAULT_WORKSPACE_NAME,
  createNewWorkspace, generateWorkspaceId, importQueries,
  renameWorkspace, replaceWorkspaceContents,
} from '../../src/workspace/workspace-operations.js';
import type { SavedQueryV2, StoredWorkspaceV1 } from '../../src/generated/json-schema.types.js';

const query = (id: string, favorite = false): SavedQueryV2 => ({
  id, sql: 'SELECT 1', specVersion: 1, spec: { name: id, favorite },
});
const dashboard = (): NonNullable<StoredWorkspaceV1['dashboard']> => ({
  documentVersion: 1, id: 'd1', title: 'Dash', revision: 3,
  layout: { type: 'flow', version: 1, preset: 'report', items: {} }, filters: [], tiles: [],
});
const base = (over: Partial<StoredWorkspaceV1> = {}): StoredWorkspaceV1 => ({
  storageVersion: 1, id: 'w1', name: 'Workspace', queries: [query('a')], dashboard: dashboard(), ...over,
});

// A deterministic counter ID generator for the tests.
const counter = () => {
  let n = 0;
  return () => `id-${++n}`;
};

describe('generateWorkspaceId', () => {
  it('mints a fresh ID on every call — two same-named imports get distinct IDs', () => {
    const genId = counter();
    const first = createNewWorkspace(genId, 'Sales');
    const second = createNewWorkspace(genId, 'Sales');
    expect(first.id).not.toBe(second.id);
    expect(generateWorkspaceId(genId)).toBe('id-3');
  });
});

describe('renameWorkspace', () => {
  it('changes only the workspace name and never renames the Dashboard', () => {
    const ws = base();
    const renamed = renameWorkspace(ws, 'New name');
    expect(renamed.name).toBe('New name');
    expect(renamed.dashboard).toBe(ws.dashboard); // same Dashboard, title unchanged
    expect(renamed.dashboard?.title).toBe('Dash');
    expect(renamed.queries).toEqual(ws.queries);
  });

  it('falls back to the default name for a blank/non-string name', () => {
    expect(renameWorkspace(base(), '   ').name).toBe(DEFAULT_WORKSPACE_NAME);
    expect(renameWorkspace(base(), 42 as unknown).name).toBe(DEFAULT_WORKSPACE_NAME);
  });
});

describe('createNewWorkspace', () => {
  it('builds a fresh empty workspace with a new ID, no queries, and no Dashboard', () => {
    const ws = createNewWorkspace(counter(), 'Fresh');
    expect(ws).toEqual({
      storageVersion: CURRENT_STORAGE_VERSION, id: 'id-1', name: 'Fresh', queries: [], dashboard: null,
    });
  });

  it('defaults the name when omitted', () => {
    expect(createNewWorkspace(counter()).name).toBe(DEFAULT_WORKSPACE_NAME);
  });
});

describe('importQueries', () => {
  it('replaces the query collection only and leaves the Dashboard byte-for-byte unchanged', () => {
    const ws = base();
    const incoming = [query('x', true), query('y', true)];
    const next = importQueries(ws, incoming);
    expect(next.queries.map((q) => q.id)).toEqual(['x', 'y']);
    // imported favorite flags do NOT add tiles — the Dashboard is untouched.
    expect(next.dashboard).toBe(ws.dashboard);
    expect(next.dashboard?.tiles).toEqual([]);
    expect(next.id).toBe('w1');
    // A fresh array (input not aliased).
    expect(next.queries).not.toBe(incoming);
  });
});

describe('replaceWorkspaceContents', () => {
  it('replaces queries and Dashboard atomically while preserving identity', () => {
    const ws = base();
    const newDash = { ...dashboard(), id: 'd2', title: 'Imported' };
    const next = replaceWorkspaceContents(ws, { queries: [query('z')], dashboard: newDash });
    expect(next.id).toBe('w1'); // identity preserved
    expect(next.name).toBe('Workspace');
    expect(next.queries.map((q) => q.id)).toEqual(['z']);
    expect(next.dashboard).toEqual(newDash);
  });

  it('can clear the Dashboard as part of an atomic replacement', () => {
    expect(replaceWorkspaceContents(base(), { queries: [], dashboard: null }).dashboard).toBeNull();
  });
});
