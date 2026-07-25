import { describe, expect, it } from 'vitest';
import {
  CURRENT_STORED_WORKSPACE_VERSION, LEGACY_STORED_WORKSPACE_VERSIONS,
  STORED_WORKSPACE_V2_SCHEMA_ID, STORED_WORKSPACE_V3_SCHEMA_ID, STORED_WORKSPACE_V4_SCHEMA_ID,
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
  storageVersion: 4, id: 'w1', key: 'workspace', name: 'W', queries: [], dashboards: [], ...over,
});
/** A record persisted before #424 — the shape the codec must still read. */
const legacy = (over: Record<string, unknown> = {}) => ({
  storageVersion: 2, id: 'w1', key: 'workspace', name: 'W', queries: [], dashboard: null, ...over,
});
/** A record persisted before #427: a Dashboard collection whose members may
 *  still SHARE a Library query. Also still readable. */
const legacyV3 = (over: Record<string, unknown> = {}) => ({
  storageVersion: 3, id: 'w1', key: 'workspace', name: 'W', queries: [], dashboards: [], ...over,
});

describe('validateStoredWorkspaceDocument', () => {
  it('accepts empty, query-only, one-Dashboard, and many-Dashboard workspaces', () => {
    expect(validateStoredWorkspaceDocument(workspace())).toEqual([]);
    expect(validateStoredWorkspaceDocument(workspace({ queries: [panelQuery('p1')] }))).toEqual([]);
    expect(validateStoredWorkspaceDocument(workspace({
      queries: [panelQuery('p1')], dashboards: [tiled('d1', 't1', 'p1')],
    }))).toEqual([]);
    // #427: each member owns its OWN dedicated copy, so two Dashboards showing
    // the same thing hold two queries.
    expect(validateStoredWorkspaceDocument(workspace({
      queries: [panelQuery('p1'), panelQuery('p2')],
      dashboards: [tiled('exec', 'exec-p1', 'p1'), tiled('sales', 'sales-p1', 'p2')],
    }))).toEqual([]);
  });

  // #427 — the ownership invariant. Reported at every owner AFTER the first, so
  // the diagnostics name the references that have to change.
  it('rejects every shape of query sharing, at each owner after the first', () => {
    const twoDashboards = validateStoredWorkspaceDocument(workspace({
      queries: [panelQuery('p1')],
      dashboards: [tiled('exec', 'exec-p1', 'p1'), tiled('sales', 'sales-p1', 'p1')],
    }));
    expect(codes(twoDashboards)).toEqual(['dashboard-query-multiple-owners']);
    expect(find(twoDashboards, 'dashboard-query-multiple-owners').path)
      .toEqual(['dashboards', 1, 'tiles', 0, 'queryId']);
    expect(find(twoDashboards, 'dashboard-query-multiple-owners').resource).toBe('sales');
    expect(find(twoDashboards, 'dashboard-query-multiple-owners').message)
      .toContain('owned by 2 Dashboard members');

    // Two tiles inside ONE Dashboard.
    const twoTiles = validateStoredWorkspaceDocument(workspace({
      queries: [panelQuery('p1')],
      dashboards: [dashboardDoc({
        tiles: [{ id: 't1', queryId: 'p1' }, { id: 't2', queryId: 'p1' }],
        layout: { type: 'flow', version: 1, preset: 'report', items: { t1: {}, t2: {} } },
      })],
    }));
    expect(find(twoTiles, 'dashboard-query-multiple-owners').path)
      .toEqual(['dashboards', 0, 'tiles', 1, 'queryId']);

    // A filter and a tile sharing one query. The filter is walked first, so the
    // TILE is the owner after the first — and the pre-existing, more precise
    // `filter-source-is-tile` still fires too.
    const filterAndTile = validateStoredWorkspaceDocument(workspace({
      queries: [panelQuery('p1')],
      dashboards: [dashboardDoc({
        tiles: [{ id: 't1', queryId: 'p1' }],
        layout: { type: 'flow', version: 1, preset: 'report', items: { t1: {} } },
        filters: [{ id: 'flt', parameter: 'p', sourceQueryId: 'p1' }],
      })],
    }));
    expect(find(filterAndTile, 'dashboard-query-multiple-owners').path)
      .toEqual(['dashboards', 0, 'tiles', 0, 'queryId']);
    expect(has(filterAndTile, 'filter-source-is-tile')).toBe(true);

    // …and the other way round: when a TILE is the first owner, the later
    // FILTER is the one reported, at its own `sourceQueryId` path.
    const tileThenFilter = validateStoredWorkspaceDocument(workspace({
      queries: [{
        id: 'q', sql: "SELECT ['a'] AS p", specVersion: 1,
        spec: { name: 'Q', dashboard: { role: 'filter' } },
      }],
      dashboards: [
        dashboardDoc({
          id: 'first', tiles: [{ id: 't1', queryId: 'q' }],
          layout: { type: 'flow', version: 1, preset: 'report', items: { t1: {} } },
        }),
        dashboardDoc({ id: 'second', filters: [{ id: 'flt', parameter: 'p', sourceQueryId: 'q' }] }),
      ],
    }));
    expect(find(tileThenFilter, 'dashboard-query-multiple-owners').path)
      .toEqual(['dashboards', 1, 'filters', 0, 'sourceQueryId']);
    expect(find(tileThenFilter, 'dashboard-query-multiple-owners').message)
      .toContain('filter "flt"');
  });

  it('accepts a plain filter, which owns nothing, and a zero-owner Library query', () => {
    // A date or free-text control has no option list and therefore no source
    // query; a favourited Library query with no reference is still just a
    // Library query.
    expect(validateStoredWorkspaceDocument(workspace({
      queries: [{
        id: 'lib', sql: 'SELECT 1', specVersion: 1,
        spec: { name: 'lib', favorite: true, dashboard: { role: 'filter' } },
      }],
      dashboards: [dashboardDoc({ filters: [{ id: 'from', parameter: 'from' }] })],
    }))).toEqual([]);
  });

  it('fails closed on identity problems, and is strict about the V4 version', () => {
    expect(codes(validateStoredWorkspaceDocument(null))).toEqual(['workspace-invalid-root']);
    expect(codes(validateStoredWorkspaceDocument({}))).toEqual(['workspace-version-missing']);
    expect(codes(validateStoredWorkspaceDocument({ storageVersion: 1.5 }))).toEqual(['workspace-version-invalid']);
    expect(codes(validateStoredWorkspaceDocument({ storageVersion: 5 }))).toEqual(['workspace-version-unsupported']);
    // A legacy document is not a valid CANDIDATE — only the decoder reads V2/V3.
    expect(codes(validateStoredWorkspaceDocument(legacy()))).toEqual(['workspace-version-unsupported']);
    expect(codes(validateStoredWorkspaceDocument(legacyV3()))).toEqual(['workspace-version-unsupported']);
  });

  it('reports structural schema errors, e.g. the required dashboards array', () => {
    const d = validateStoredWorkspaceDocument({
      storageVersion: 4, id: 'w', key: 'workspace', name: 'W', queries: [],
    });
    expect(has(d, 'schema-required')).toBe(true);
    // The retired singular field is rejected outright, never silently ignored.
    expect(codes(validateStoredWorkspaceDocument(workspace({ dashboard: null }))))
      .toContain('schema-unknown-property');
  });

  it('fails closed on unknown query and dashboard versions, suppressing schema noise', () => {
    const d = validateStoredWorkspaceDocument(workspace({
      queries: [{ id: 'q', sql: 'x', specVersion: 9, spec: {} }],
      dashboards: [dashboardDoc(), dashboardDoc({ id: 'd2', documentVersion: 4 })],
    }));
    expect(has(d, 'spec-version-unsupported')).toBe(true);
    expect(find(d, 'dashboard-version-unsupported').path).toEqual(['dashboards', 1, 'documentVersion']);
    // Only the OFFENDING member's schema noise is suppressed: give the valid
    // sibling a structural error of its own and it must still be reported.
    const sibling = validateStoredWorkspaceDocument(workspace({
      dashboards: [dashboardDoc({ title: 42 }), dashboardDoc({ id: 'd2', documentVersion: 4 })],
    }));
    expect(find(sibling, 'dashboard-version-unsupported').path).toEqual(['dashboards', 1, 'documentVersion']);
    expect(sibling.some((x) => x.path[0] === 'dashboards' && x.path[1] === 0)).toBe(true);
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
      queries: [panelQuery('p1'), panelQuery('p2')],
      dashboards: [tiled('d1', 'shared', 'p1'), tiled('d2', 'shared', 'p2')],
    }))).toEqual([]);
    expect(has(validateStoredWorkspaceDocument(workspace({
      queries: [panelQuery('p1')],
      dashboards: [dashboardDoc({ tiles: [{ id: 't1', queryId: 'p1' }, { id: 't1', queryId: 'p1' }] })],
    })), 'dashboard-duplicate-tile-id')).toBe(true);
  });

  it('scopes filter targets and layout placements to their OWN Dashboard', () => {
    // `t1` exists only in the first Dashboard; the second may not reach it,
    // through a filter target or through a layout placement key.
    const crossFilter = validateStoredWorkspaceDocument(workspace({
      queries: [panelQuery('p1'), panelQuery('p2')],
      dashboards: [
        tiled('d1', 't1', 'p1'),
        dashboardDoc({
          id: 'd2', tiles: [{ id: 't2', queryId: 'p2' }],
          layout: { type: 'flow', version: 1, preset: 'report', items: { t2: {} } },
          filters: [{ id: 'flt', parameter: 'country', targets: ['t1'] }],
        }),
      ],
    }));
    expect(find(crossFilter, 'filter-target-missing').path)
      .toEqual(['dashboards', 1, 'filters', 0, 'targets', 0]);

    const crossLayout = validateStoredWorkspaceDocument(workspace({
      queries: [panelQuery('p1'), panelQuery('p2')],
      dashboards: [
        tiled('d1', 't1', 'p1'),
        dashboardDoc({
          id: 'd2', tiles: [{ id: 't2', queryId: 'p2' }],
          layout: { type: 'flow', version: 1, preset: 'report', items: { t1: {} } },
        }),
      ],
    }));
    expect(find(crossLayout, 'layout-orphan-placement').path)
      .toEqual(['dashboards', 1, 'layout', 'items', 't1']);
  });

  it('enforces the per-Dashboard limits independently, at each Dashboard\'s own index', () => {
    const permissive = { validate: () => [], getSchema: () => undefined };
    const tooManyFilters = Array.from({ length: 33 }, (_, i) => ({ id: `f${i}`, parameter: 'p' }));
    const d = validateStoredWorkspaceDocument(workspace({
      dashboards: [dashboardDoc(), dashboardDoc({ id: 'd2', filters: tooManyFilters })],
    }), { validationService: permissive });
    expect(find(d, 'limit-filter-count').path).toEqual(['dashboards', 1, 'filters']);
    // The query-collection limit stays workspace-scoped, applied once.
    expect(has(d, 'limit-query-count')).toBe(false);
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
    // A deep clone on BOTH collections: mutating the result never reaches the
    // caller's document.
    migrated.dashboards[0].title = 'changed';
    migrated.queries[0].spec.name = 'changed';
    expect(dashboard.title).toBe('Analytics');
    expect(query.spec.name).toBe('Revenue');
    // Deterministic: migrating the same input again yields the same value.
    expect(migrateStoredWorkspaceV2ToV3(source as unknown as StoredWorkspaceV2).dashboards)
      .toEqual([dashboard]);
  });

  it('preserves query order and never reorders the catalog', () => {
    const order = ['zeta', 'alpha', 'mid'].map((id) => (
      { id, sql: 'SELECT 1', specVersion: 1, spec: { name: id } }
    ));
    const migrated = migrateStoredWorkspaceV2ToV3(
      legacy({ queries: order }) as unknown as StoredWorkspaceV2,
    );
    expect(migrated.queries.map((q) => q.id)).toEqual(['zeta', 'alpha', 'mid']);
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
  it('parses, validates, and returns the canonical V4 value', () => {
    const result = decodeStoredWorkspaceJson(JSON.stringify(workspace()));
    expect(result.ok).toBe(true);
    expect(result.ok && result.value.storageVersion).toBe(CURRENT_STORED_WORKSPACE_VERSION);
  });

  it('reads a persisted V2 record through the whole V2 -> V3 -> V4 chain', () => {
    const dashboard = { ...tiled('d1', 't1', 'p1'), revision: 7 };
    const decoded = decodeStoredWorkspaceJson(JSON.stringify(
      legacy({ queries: [panelQuery('p1')], dashboard }),
    ));
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.value.storageVersion).toBe(CURRENT_STORED_WORKSPACE_VERSION);
    // #427: the tile now owns a dedicated copy, the original stays in the
    // Library, and the Dashboard's identity and revision are untouched.
    expect(decoded.value.dashboards[0].id).toBe('d1');
    expect(decoded.value.dashboards[0].revision).toBe(7);
    expect(decoded.value.dashboards[0].tiles[0].id).toBe('t1');
    expect(decoded.value.dashboards[0].tiles[0].queryId).not.toBe('p1');
    expect(decoded.value.queries.map((q) => q.id)[0]).toBe('p1');
    expect(decoded.value.queries).toHaveLength(2);
    // Re-decoding the migrated document is a pure read: byte-identical, no
    // second transformation, no second clone.
    const again = decodeStoredWorkspaceJson(JSON.stringify(decoded.value));
    expect(again.ok && again.value).toEqual(decoded.value);
    expect([...LEGACY_STORED_WORKSPACE_VERSIONS]).toEqual([2, 3]);
  });

  it('reads a persisted V3 record and gives every member a dedicated copy', () => {
    // The pre-#427 shape the star used to produce: ONE Library query, referenced
    // by tiles in two Dashboards.
    const decoded = decodeStoredWorkspaceJson(JSON.stringify(legacyV3({
      queries: [panelQuery('p1')],
      dashboards: [tiled('exec', 'exec-t', 'p1'), tiled('sales', 'sales-t', 'p1')],
    })));
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.value.storageVersion).toBe(4);
    // The original survives as the Library source; each tile points at its own copy.
    expect(decoded.value.queries).toHaveLength(3);
    expect(decoded.value.queries[0].id).toBe('p1');
    const [exec, sales] = decoded.value.dashboards;
    expect(exec.tiles[0].queryId).not.toBe(sales.tiles[0].queryId);
    expect(exec.tiles[0].queryId).not.toBe('p1');
    // Member ids and order are preserved, so #426's tree state stays valid.
    expect(exec.id).toBe('exec');
    expect(exec.tiles[0].id).toBe('exec-t');
    // Deterministic: the same bytes decode to the same document every time, which
    // is what keeps `workspaceToken` stable across tabs and refreshes.
    expect(decodeStoredWorkspaceJson(JSON.stringify(legacyV3({
      queries: [panelQuery('p1')],
      dashboards: [tiled('exec', 'exec-t', 'p1'), tiled('sales', 'sales-t', 'p1')],
    })))).toEqual(decoded);
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
    const invalid = decodeStoredWorkspaceJson(JSON.stringify({ storageVersion: 5 }));
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
    // Reference schema ids stay exported: v4 for writes, v3/v2 for legacy reads.
    expect(STORED_WORKSPACE_V4_SCHEMA_ID).toContain('stored-workspace-v4');
    expect(STORED_WORKSPACE_V3_SCHEMA_ID).toContain('stored-workspace-v3');
    expect(STORED_WORKSPACE_V2_SCHEMA_ID).toContain('stored-workspace-v2');
  });

  it('never writes a legacy document', () => {
    const result = encodeStoredWorkspaceJson(legacy());
    expect(!result.ok && result.diagnostics[0].code).toBe('workspace-version-unsupported');
  });

  it('rejects an invalid workspace before encoding', () => {
    const result = encodeStoredWorkspaceJson({ storageVersion: 5 });
    expect(!result.ok && result.diagnostics[0].code).toBe('workspace-version-unsupported');
  });

  it('rejects an encoded workspace larger than the decoded-JSON byte cap', () => {
    // An arbitrary extension field (query-spec is open) inflates each spec to
    // just under the 1 MiB per-spec cap; twenty-one sum past the 20 MiB document
    // cap (#427 doubled it, so the migration cannot lock a workspace read-only).
    const chunk = 'x'.repeat(1_000_000);
    const queries = Array.from({ length: 21 }, (_, i) => ({
      id: `q${i}`, sql: 'SELECT 1', specVersion: 1, spec: { name: `q${i}`, ext: chunk },
    }));
    const result = encodeStoredWorkspaceJson(workspace({ queries }));
    expect(!result.ok && result.diagnostics[0].code).toBe('limit-json-bytes');
  });
});
