import { describe, expect, it } from 'vitest';
import {
  CURRENT_STORED_WORKSPACE_VERSION, STORED_WORKSPACE_V2_SCHEMA_ID,
  decodeStoredWorkspaceJson, encodeStoredWorkspaceJson, validateStoredWorkspaceDocument,
} from '../../src/workspace/stored-workspace.js';
import type { WorkspaceDiagnostic } from '../../src/dashboard/model/workspace-diagnostics.js';

const codes = (d: WorkspaceDiagnostic[]): string[] => d.map((x) => x.code);
const has = (d: WorkspaceDiagnostic[], code: string): boolean => d.some((x) => x.code === code);

const panelQuery = (id: string) => ({ id, sql: 'SELECT 1', specVersion: 1, spec: { name: id, panel: { cfg: { type: 'bar', x: 0, y: [1] } } } });
const dashboardDoc = (over: Record<string, unknown> = {}) => ({
  documentVersion: 1, id: 'd1', title: 'D', revision: 1,
  layout: { type: 'flow', version: 1, preset: 'report', items: {} }, filters: [], tiles: [], ...over,
});
const workspace = (over: Record<string, unknown> = {}) => ({
  storageVersion: 2, id: 'w1', key: 'workspace', name: 'W', queries: [], dashboard: null, ...over,
});

describe('validateStoredWorkspaceDocument', () => {
  it('accepts an empty workspace, a query-only workspace, and one with a resolvable dashboard', () => {
    expect(validateStoredWorkspaceDocument(workspace())).toEqual([]);
    expect(validateStoredWorkspaceDocument(workspace({ queries: [panelQuery('p1')] }))).toEqual([]);
    const withDashboard = workspace({
      queries: [panelQuery('p1')],
      dashboard: dashboardDoc({ tiles: [{ id: 't1', queryId: 'p1' }], layout: { type: 'flow', version: 1, preset: 'report', items: { t1: {} } } }),
    });
    expect(validateStoredWorkspaceDocument(withDashboard)).toEqual([]);
  });

  it('fails closed on identity problems', () => {
    expect(codes(validateStoredWorkspaceDocument(null))).toEqual(['workspace-invalid-root']);
    expect(codes(validateStoredWorkspaceDocument({}))).toEqual(['workspace-version-missing']);
    expect(codes(validateStoredWorkspaceDocument({ storageVersion: 1.5 }))).toEqual(['workspace-version-invalid']);
    expect(codes(validateStoredWorkspaceDocument({ storageVersion: 3 }))).toEqual(['workspace-version-unsupported']);
  });

  it('reports structural schema errors, e.g. a missing required field', () => {
    const d = validateStoredWorkspaceDocument({
      storageVersion: 2, id: 'w', key: 'workspace', name: 'W', queries: [],
    });
    expect(has(d, 'schema-required')).toBe(true); // dashboard required (may be null)
  });

  it('fails closed on unknown query and dashboard versions, suppressing schema noise', () => {
    const d = validateStoredWorkspaceDocument(workspace({
      queries: [{ id: 'q', sql: 'x', specVersion: 9, spec: {} }],
      dashboard: dashboardDoc({ documentVersion: 4 }),
    }));
    expect(has(d, 'spec-version-unsupported')).toBe(true);
    expect(has(d, 'dashboard-version-unsupported')).toBe(true);
    expect(d.find((x) => x.code === 'dashboard-version-unsupported')!.path[0]).toBe('dashboard');
  });

  it('runs whole-workspace cross-resource semantics when structurally valid', () => {
    const d = validateStoredWorkspaceDocument(workspace({ queries: [panelQuery('dup'), panelQuery('dup')] }));
    expect(has(d, 'workspace-duplicate-query-id')).toBe(true);
    // Dashboard-side semantics run against the workspace queries.
    const bad = validateStoredWorkspaceDocument(workspace({
      dashboard: dashboardDoc({ tiles: [{ id: 't1', queryId: 'gone' }], layout: { type: 'flow', version: 1, preset: 'report', items: { t1: {} } } }),
    }));
    expect(has(bad, 'dashboard-tile-query-missing')).toBe(true);
  });
});

describe('decodeStoredWorkspaceJson', () => {
  it('parses, validates, and returns the typed value', () => {
    const result = decodeStoredWorkspaceJson(JSON.stringify(workspace()));
    expect(result.ok).toBe(true);
    expect(result.ok && result.value.storageVersion).toBe(CURRENT_STORED_WORKSPACE_VERSION);
  });

  it('propagates codec-guard and validation failures', () => {
    expect(decodeStoredWorkspaceJson('{bad').ok).toBe(false);
    const invalid = decodeStoredWorkspaceJson(JSON.stringify({ storageVersion: 3 }));
    expect(!invalid.ok && invalid.diagnostics[0].code).toBe('workspace-version-unsupported');
  });
});

describe('encodeStoredWorkspaceJson', () => {
  it('validates and canonically encodes with deterministic key order', () => {
    const result = encodeStoredWorkspaceJson(workspace({ queries: [panelQuery('p1')] }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.indexOf('"storageVersion"')).toBeLessThan(result.value.indexOf('"id"'));
    expect(result.value.indexOf('"queries"')).toBeLessThan(result.value.indexOf('"dashboard"'));
    // Reference schema id is exported for callers/Phase 2.
    expect(STORED_WORKSPACE_V2_SCHEMA_ID).toContain('stored-workspace-v2');
  });

  it('rejects an invalid workspace before encoding', () => {
    const result = encodeStoredWorkspaceJson({ storageVersion: 3 });
    expect(!result.ok && result.diagnostics[0].code).toBe('workspace-version-unsupported');
  });

  it('rejects an encoded workspace larger than the decoded-JSON byte cap', () => {
    // An arbitrary extension field (query-spec is open) inflates each spec to
    // just under the 1 MiB per-spec cap; eleven sum past the 10 MiB document cap.
    const chunk = 'x'.repeat(1_000_000);
    const queries = Array.from({ length: 11 }, (_, i) => ({
      id: `q${i}`, sql: 'SELECT 1', specVersion: 1, spec: { name: `q${i}`, ext: chunk },
    }));
    const result = encodeStoredWorkspaceJson(workspace({ queries }));
    expect(!result.ok && result.diagnostics[0].code).toBe('limit-json-bytes');
  });
});
