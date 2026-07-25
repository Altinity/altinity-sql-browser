import { describe, expect, it } from 'vitest';
import {
  CURRENT_STORED_WORKSPACE_VERSION, LEGACY_STORED_WORKSPACE_VERSION,
  STORED_WORKSPACE_V2_SCHEMA_ID, STORED_WORKSPACE_V3_SCHEMA_ID,
  decodeStoredWorkspaceJson, encodeStoredWorkspaceJson, migrateStoredWorkspaceV2ToV3,
  validateStoredWorkspaceDocument,
} from '../../src/workspace/stored-workspace.js';
import type { WorkspaceDiagnostic } from '../../src/dashboard/model/workspace-diagnostics.js';
import type { StoredWorkspaceV2 } from '../../src/generated/json-schema.types.js';

const codes = (d: WorkspaceDiagnostic[]): string[] => d.map((x) => x.code);
const has = (d: WorkspaceDiagnostic[], code: string): boolean => d.some((x) => x.code === code);
const find = (d: WorkspaceDiagnostic[], code: string): WorkspaceDiagnostic =>
  d.find((x) => x.code === code)!;

const panelQuery = (id: string) => ({ id, sql: 'SELECT 1', specVersion: 1, spec: { name: id, panel: { cfg: { type: 'bar', x: 0, y: [1] } } } });
const dashboardDoc = (over: Record<string, unknown> = {}) => ({
  documentVersion: 1, id: 'd1', title: 'D', revision: 1,
  layout: { type: 'flow', version: 1, preset: 'report', items: {} }, filters: [], tiles: [], ...over,
});
const tiled = (id: string, tileId: string, queryId: string) => dashboardDoc({
  id,
  tiles: [{ id: tileId, queryId }],
  layout: { type: 'flow', version: 1, preset: 'report', items: { [tileId]: {} } },
});
const workspace = (over: Record<string, unknown> = {}) => ({
  storageVersion: 3, id: 'w1', key: 'workspace', name: 'W', queries: [], dashboards: [], ...over,
});
/** A record persisted before #424 — the shape the codec must still read. */
const legacy = (over: Record<string, unknown> = {}) => ({
  storageVersion: 2, id: 'w1', key: 'workspace', name: 'W', queries: [], dashboard: null, ...over,
});

describe('validateStoredWorkspaceDocument', () => {
  it('accepts empty, query-only, one-Dashboard, and many-Dashboard workspaces', () => {
    expect(validateStoredWorkspaceDocument(workspace())).toEqual([]);
    expect(validateStoredWorkspaceDocument(workspace({ queries: [panelQuery('p1')] }))).toEqual([]);
    expect(validateStoredWorkspaceDocument(workspace({
      queries: [panelQuery('p1')], dashboards: [tiled('d1', 't1', 'p1')],
    }))).toEqual([]);
    // The SAME query backing tiles in two Dashboards is the point of the
    // collection: the query is stored once and referenced twice.
    expect(validateStoredWorkspaceDocument(workspace({
      queries: [panelQuery('p1')],
      dashboards: [tiled('exec', 'exec-p1', 'p1'), tiled('sales', 'sales-p1', 'p1')],
    }))).toEqual([]);
  });

  it('fails closed on identity problems, and is strict about the V3 version', () => {
    expect(codes(validateStoredWorkspaceDocument(null))).toEqual(['workspace-invalid-root']);
    expect(codes(validateStoredWorkspaceDocument({}))).toEqual(['workspace-version-missing']);
    expect(codes(validateStoredWorkspaceDocument({ storageVersion: 1.5 }))).toEqual(['workspace-version-invalid']);
    expect(codes(validateStoredWorkspaceDocument({ storageVersion: 4 }))).toEqual(['workspace-version-unsupported']);
    // A legacy document is not a valid CANDIDATE — only the decoder reads V2.
    expect(codes(validateStoredWorkspaceDocument(legacy()))).toEqual(['workspace-version-unsupported']);
  });

  it('reports structural schema errors, e.g. the required dashboards array', () => {
    const d = validateStoredWorkspaceDocument({
      storageVersion: 3, id: 'w', key: 'workspace', name: 'W', queries: [],
    });
    expect(has(d, 'schema-required')).toBe(true);
    // The retired singular field is rejected outright, never silently ignored.
    expect(validateStoredWorkspaceDocument(workspace({ dashboard: null })).length).toBeGreaterThan(0);
  });

  it('fails closed on unknown query and dashboard versions, suppressing schema noise', () => {
    const d = validateStoredWorkspaceDocument(workspace({
      queries: [{ id: 'q', sql: 'x', specVersion: 9, spec: {} }],
      dashboards: [dashboardDoc(), dashboardDoc({ id: 'd2', documentVersion: 4 })],
    }));
    expect(has(d, 'spec-version-unsupported')).toBe(true);
    expect(find(d, 'dashboard-version-unsupported').path).toEqual(['dashboards', 1, 'documentVersion']);
    // Only the offending member's schema noise is suppressed — the valid
    // sibling is still fully validated.
    expect(has(d, 'schema-const')).toBe(false);
  });

  it('runs whole-workspace cross-resource semantics over every Dashboard', () => {
    expect(has(validateStoredWorkspaceDocument(
      workspace({ queries: [panelQuery('dup'), panelQuery('dup')] }),
    ), 'workspace-duplicate-query-id')).toBe(true);

    // A break in the SECOND Dashboard is diagnosed at its own indexed path.
    const bad = validateStoredWorkspaceDocument(workspace({
      queries: [panelQuery('p1')],
      dashboards: [tiled('d1', 't1', 'p1'), tiled('d2', 't1', 'gone')],
    }));
    expect(find(bad, 'dashboard-tile-query-missing').path).toEqual(['dashboards', 1, 'tiles', 0, 'queryId']);

    // Dashboard ids are unique per workspace…
    const dup = validateStoredWorkspaceDocument(workspace({
      dashboards: [dashboardDoc(), dashboardDoc()],
    }));
    expect(find(dup, 'workspace-duplicate-dashboard-id').path).toEqual(['dashboards', 1, 'id']);

    // …while tile ids stay Dashboard-LOCAL: the same tile id in two different
    // Dashboards is fine, a repeat inside one Dashboard is not.
    expect(validateStoredWorkspaceDocument(workspace({
      queries: [panelQuery('p1')],
      dashboards: [tiled('d1', 'shared', 'p1'), tiled('d2', 'shared', 'p1')],
    }))).toEqual([]);
    expect(has(validateStoredWorkspaceDocument(workspace({
      queries: [panelQuery('p1')],
      dashboards: [dashboardDoc({ tiles: [{ id: 't1', queryId: 'p1' }, { id: 't1', queryId: 'p1' }] })],
    })), 'dashboard-duplicate-tile-id')).toBe(true);
  });

  it('bounds the Dashboard collection at the shared portable capacity', () => {
    const many = Array.from({ length: 33 }, (_, i) => dashboardDoc({ id: `d${i}` }));
    // Structural first: the schema's own `maxItems` rejects an over-capacity
    // collection, so the aggregate never reaches the semantic pass.
    expect(has(validateStoredWorkspaceDocument(workspace({ dashboards: many })), 'schema-array-size'))
      .toBe(true);
    // The runtime re-check is aligned with it and still fires for a caller that
    // bypasses structural validation (the #280 "re-check the security-relevant
    // limits after parsing" rule).
    const permissive = { validate: () => [], getSchema: () => undefined };
    expect(has(
      validateStoredWorkspaceDocument(workspace({ dashboards: many }), { validationService: permissive }),
      'limit-dashboard-count',
    )).toBe(true);
    // 32 is the shared portable-bundle capacity, not a second one.
    expect(validateStoredWorkspaceDocument(workspace({ dashboards: many.slice(0, 32) }))).toEqual([]);
  });
});

describe('migrateStoredWorkspaceV2ToV3', () => {
  it('lifts a null Dashboard to an empty collection', () => {
    expect(migrateStoredWorkspaceV2ToV3(legacy() as unknown as StoredWorkspaceV2)).toEqual({
      storageVersion: 3, id: 'w1', key: 'workspace', name: 'W', queries: [], dashboards: [],
    });
  });

  it('preserves ids, revisions, unknown fields, and favorites exactly', () => {
    const dashboard = {
      ...tiled('dashboard-main', 'revenue-tile', 'revenue-query'),
      revision: 4, title: 'Analytics', futureField: { kept: true },
    };
    const query = {
      id: 'revenue-query', sql: 'SELECT 1', specVersion: 1,
      spec: { name: 'Revenue', favorite: true, panel: { cfg: { type: 'line', x: 0, y: [1] } } },
    };
    const source = legacy({ queries: [query], dashboard });
    const migrated = migrateStoredWorkspaceV2ToV3(source as unknown as StoredWorkspaceV2);
    expect(migrated.dashboards).toEqual([dashboard]);
    expect(migrated.dashboards[0].revision).toBe(4);
    expect(migrated.queries).toEqual([query]);
    expect(migrated.queries[0].spec.favorite).toBe(true);
    // A deep clone: mutating the result never reaches the caller's document.
    migrated.dashboards[0].title = 'changed';
    expect(dashboard.title).toBe('Analytics');
    // Deterministic: migrating the same input again yields the same value.
    expect(migrateStoredWorkspaceV2ToV3(source as unknown as StoredWorkspaceV2).dashboards)
      .toEqual([dashboard]);
  });

  it('never derives tiles from favorite flags in either direction', () => {
    const favorited = { id: 'p1', sql: 'SELECT 1', specVersion: 1, spec: { name: 'P', favorite: true } };
    // A favorited panel with no Dashboard stays tile-less…
    expect(migrateStoredWorkspaceV2ToV3(
      legacy({ queries: [favorited] }) as unknown as StoredWorkspaceV2,
    ).dashboards).toEqual([]);
    // …and an unfavorited query keeps its existing tile.
    const unfavorited = { id: 'p1', sql: 'SELECT 1', specVersion: 1, spec: { name: 'P', favorite: false } };
    const migrated = migrateStoredWorkspaceV2ToV3(legacy({
      queries: [unfavorited], dashboard: tiled('d1', 't1', 'p1'),
    }) as unknown as StoredWorkspaceV2);
    expect(migrated.dashboards[0].tiles).toEqual([{ id: 't1', queryId: 'p1' }]);
  });
});

describe('decodeStoredWorkspaceJson', () => {
  it('parses, validates, and returns the canonical V3 value', () => {
    const result = decodeStoredWorkspaceJson(JSON.stringify(workspace()));
    expect(result.ok).toBe(true);
    expect(result.ok && result.value.storageVersion).toBe(CURRENT_STORED_WORKSPACE_VERSION);
  });

  it('reads a persisted V2 record and returns it migrated, without re-migrating V3', () => {
    const dashboard = { ...tiled('d1', 't1', 'p1'), revision: 7 };
    const decoded = decodeStoredWorkspaceJson(JSON.stringify(
      legacy({ queries: [panelQuery('p1')], dashboard }),
    ));
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.value.storageVersion).toBe(CURRENT_STORED_WORKSPACE_VERSION);
    expect(decoded.value.dashboards).toEqual([dashboard]);
    // Re-decoding the migrated document is a pure read: identical value, same
    // revision, no second transformation.
    const again = decodeStoredWorkspaceJson(JSON.stringify(decoded.value));
    expect(again.ok && again.value).toEqual(decoded.value);
    expect(LEGACY_STORED_WORKSPACE_VERSION).toBe(2);
  });

  it("reports a legacy record's own structural problems at its own paths", () => {
    const bad = decodeStoredWorkspaceJson(JSON.stringify(
      legacy({ dashboard: dashboardDoc({ documentVersion: 4 }) }),
    ));
    expect(!bad.ok && find(bad.diagnostics, 'dashboard-version-unsupported').path)
      .toEqual(['dashboard', 'documentVersion']);
  });

  it('rejects a legacy record whose migrated form would be invalid, committing nothing', () => {
    // Structurally fine as V2 (cross-resource rules are not schema rules), so
    // only the post-migration V3 semantic pass can catch the dangling tile.
    const broken = decodeStoredWorkspaceJson(JSON.stringify(
      legacy({ dashboard: tiled('d1', 't1', 'gone') }),
    ));
    expect(!broken.ok && find(broken.diagnostics, 'dashboard-tile-query-missing').path)
      .toEqual(['dashboards', 0, 'tiles', 0, 'queryId']);
  });

  it('propagates codec-guard failures and fails closed on unknown versions', () => {
    expect(decodeStoredWorkspaceJson('{bad').ok).toBe(false);
    const invalid = decodeStoredWorkspaceJson(JSON.stringify({ storageVersion: 4 }));
    expect(!invalid.ok && invalid.diagnostics[0].code).toBe('workspace-version-unsupported');
    expect(!invalid.ok && invalid.diagnostics).toHaveLength(1);
  });
});

describe('encodeStoredWorkspaceJson', () => {
  it('validates and canonically encodes with deterministic key order', () => {
    const result = encodeStoredWorkspaceJson(workspace({ queries: [panelQuery('p1')] }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.indexOf('"storageVersion"')).toBeLessThan(result.value.indexOf('"id"'));
    expect(result.value.indexOf('"queries"')).toBeLessThan(result.value.indexOf('"dashboards"'));
    // Reference schema ids stay exported: v3 for writes, v2 for legacy reads.
    expect(STORED_WORKSPACE_V3_SCHEMA_ID).toContain('stored-workspace-v3');
    expect(STORED_WORKSPACE_V2_SCHEMA_ID).toContain('stored-workspace-v2');
  });

  it('never writes a legacy document', () => {
    const result = encodeStoredWorkspaceJson(legacy());
    expect(!result.ok && result.diagnostics[0].code).toBe('workspace-version-unsupported');
  });

  it('rejects an invalid workspace before encoding', () => {
    const result = encodeStoredWorkspaceJson({ storageVersion: 4 });
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
