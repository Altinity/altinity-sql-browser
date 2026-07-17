import { describe, expect, it } from 'vitest';
import {
  planSavedQueryMutation, suggestRepairs,
} from '../../src/dashboard/application/saved-query-mutation.js';
import { jsonSchemaValidationService } from '../../src/core/library-codec.js';
import { querySpecSchemaService } from '../../src/core/spec-schema.js';
import type { SavedQueryV2, StoredWorkspaceV1 } from '../../src/generated/json-schema.types.js';
import type { WorkspaceDiagnostic } from '../../src/dashboard/model/workspace-diagnostics.js';

const panelQuery = (id: string, sql: string, dashboard?: Record<string, unknown>): SavedQueryV2 => ({
  id, sql, specVersion: 1,
  spec: { name: id, panel: { cfg: { type: 'bar', x: 0, y: [1] } }, ...(dashboard ? { dashboard } : {}) },
} as SavedQueryV2);
const filterQuery = (id: string): SavedQueryV2 => ({
  id, sql: "SELECT ['a','b'] AS country", specVersion: 1, spec: { name: id, dashboard: { role: 'filter' } },
} as SavedQueryV2);

// A valid base workspace: a panel tile p1 (declares `country`), a filter flt
// sourced from f1 targeting that tile, and a spare panel p2 (also declaring
// `country`, so a remap onto it stays valid).
const baseWorkspace = (): StoredWorkspaceV1 => ({
  storageVersion: 1, id: 'ws', name: 'WS',
  queries: [
    panelQuery('p1', 'SELECT a,b WHERE c={country:String}'),
    panelQuery('p2', 'SELECT a,b WHERE c={country:String}'),
    filterQuery('f1'),
  ],
  dashboard: {
    documentVersion: 1, id: 'dash', title: 'D', revision: 1,
    layout: { type: 'flow', version: 1, preset: 'full-width', items: { t1: {} } },
    filters: [{ id: 'flt', parameter: 'country', sourceQueryId: 'f1', targets: ['t1'] }],
    tiles: [{ id: 't1', queryId: 'p1' }],
  },
} as StoredWorkspaceV1);

const codes = (d: WorkspaceDiagnostic[]): string[] => d.map((x) => x.code);

describe('planSavedQueryMutation — rejection without repair', () => {
  it('accepts an equivalent replacement that keeps the workspace valid', () => {
    const plan = planSavedQueryMutation(baseWorkspace(),
      { type: 'replace-query', queryId: 'p1', query: panelQuery('p1', 'SELECT a,b WHERE c={country:String}') });
    expect(plan.ok).toBe(true);
    expect(plan.candidate).not.toBeNull();
    expect(plan.repairs).toEqual([]);
  });

  it('rejects deleting a referenced query and offers tile repairs', () => {
    const plan = planSavedQueryMutation(baseWorkspace(), { type: 'delete-query', queryId: 'p1' });
    expect(plan.ok).toBe(false);
    expect(codes(plan.diagnostics)).toContain('dashboard-tile-query-missing');
    expect(plan.repairs).toEqual(expect.arrayContaining(['remove-affected-tiles', 'switch-variant', 'remap-query']));
  });

  it('rejects a role change that makes a tile incompatible', () => {
    const plan = planSavedQueryMutation(baseWorkspace(),
      { type: 'replace-query', queryId: 'p1', query: filterQuery('p1') });
    expect(plan.ok).toBe(false);
    expect(codes(plan.diagnostics)).toContain('dashboard-tile-role-incompatible');
  });

  it('rejects a filter source whose role changes', () => {
    const plan = planSavedQueryMutation(baseWorkspace(),
      { type: 'replace-query', queryId: 'f1', query: panelQuery('f1', 'SELECT 1') });
    expect(plan.ok).toBe(false);
    expect(codes(plan.diagnostics)).toContain('filter-source-role');
    expect(plan.repairs).toContain('remove-affected-filters');
  });
});

describe('planSavedQueryMutation — atomic repair', () => {
  it('removes affected tiles (and prunes their placements and filter targets)', () => {
    const plan = planSavedQueryMutation(baseWorkspace(),
      { type: 'delete-query', queryId: 'p1' }, { type: 'remove-affected-tiles' });
    expect(plan.ok).toBe(true);
    const dashboard = plan.candidate!.dashboard!;
    expect(dashboard.tiles).toEqual([]);
    expect(dashboard.layout.items).toEqual({}); // orphan placement pruned
    expect(dashboard.filters[0].targets).toEqual([]); // target reference pruned
  });

  it('removes affected filters when a parameter change invalidates a target', () => {
    // p1 no longer declares `country`; the filter targeting its tile breaks.
    const plan = planSavedQueryMutation(baseWorkspace(),
      { type: 'replace-query', queryId: 'p1', query: panelQuery('p1', 'SELECT a,b') });
    expect(plan.ok).toBe(false);
    expect(codes(plan.diagnostics)).toContain('filter-parameter-undeclared');

    const repaired = planSavedQueryMutation(baseWorkspace(),
      { type: 'replace-query', queryId: 'p1', query: panelQuery('p1', 'SELECT a,b') },
      { type: 'remove-affected-filters' });
    expect(repaired.ok).toBe(true);
    expect(repaired.candidate!.dashboard!.filters).toEqual([]);
  });

  it('switches an affected tile to another valid variant', () => {
    const workspace: StoredWorkspaceV1 = {
      storageVersion: 1, id: 'ws', name: 'WS',
      queries: [panelQuery('p1', 'SELECT a,b', { variants: { alt: {}, other: {} } })],
      dashboard: {
        documentVersion: 1, id: 'dash', title: 'D', revision: 1,
        layout: { type: 'flow', version: 1, preset: 'full-width', items: { t1: {} } },
        filters: [], tiles: [{ id: 't1', queryId: 'p1', presentation: { variant: 'alt' } }],
      },
    } as StoredWorkspaceV1;
    const deletesAlt = { type: 'replace-query' as const, queryId: 'p1', query: panelQuery('p1', 'SELECT a,b', { variants: { other: {} } }) };

    const rejected = planSavedQueryMutation(workspace, deletesAlt);
    expect(rejected.ok).toBe(false);
    expect(codes(rejected.diagnostics)).toContain('dashboard-variant-missing');

    const repaired = planSavedQueryMutation(workspace, deletesAlt, { type: 'switch-variant', tileVariants: { t1: 'other' } });
    expect(repaired.ok).toBe(true);
  });

  it('remaps references to another query (delete + remap as one candidate)', () => {
    const plan = planSavedQueryMutation(baseWorkspace(),
      { type: 'delete-query', queryId: 'p1' }, { type: 'remap-query', to: 'p2' });
    expect(plan.ok).toBe(true);
    const dashboard = plan.candidate!.dashboard!;
    expect(dashboard.tiles[0].queryId).toBe('p2');
  });

  it('supports remove-affected (tiles and filters together)', () => {
    const plan = planSavedQueryMutation(baseWorkspace(),
      { type: 'delete-query', queryId: 'p1' }, { type: 'remove-affected' },
      { validationService: jsonSchemaValidationService, schemaService: querySpecSchemaService });
    expect(plan.ok).toBe(true);
    const dashboard = plan.candidate!.dashboard!;
    expect(dashboard.tiles).toEqual([]);
    // The filter is sourced from f1 (not p1), so it survives with its now-empty
    // target list — remove-affected removed the affected tile and its target ref.
    expect(dashboard.filters[0].targets).toEqual([]);
  });
});

describe('planSavedQueryMutation — repairs skip unaffected and target-less entries', () => {
  const multiTile = (): StoredWorkspaceV1 => ({
    storageVersion: 1, id: 'ws', name: 'WS',
    queries: [panelQuery('p1', 'SELECT a,b', { variants: { alt: {}, other: {} } }), panelQuery('p2', 'SELECT a,b')],
    dashboard: {
      documentVersion: 1, id: 'dash', title: 'D', revision: 1,
      layout: { type: 'flow', version: 1, preset: 'full-width', items: { t1: {}, t2: {}, t3: {} } },
      filters: [{ id: 'flt', parameter: 'x' }], // no source, no targets
      tiles: [
        { id: 't1', queryId: 'p1', presentation: { variant: 'alt' } },
        { id: 't2', queryId: 'p2' }, // unaffected by p1 mutations
        { id: 't3', queryId: 'p1' }, // affected, but no variant mapping in the repair
      ],
    },
  } as StoredWorkspaceV1);

  it('removes only affected tiles and leaves a target-less filter intact', () => {
    const plan = planSavedQueryMutation(multiTile(), { type: 'delete-query', queryId: 'p1' }, { type: 'remove-affected-tiles' });
    expect(plan.ok).toBe(true);
    const dashboard = plan.candidate!.dashboard!;
    expect(dashboard.tiles.map((t) => t.id)).toEqual(['t2']);
    expect(dashboard.filters).toHaveLength(1);
  });

  it('switches only the mapped affected tile and skips unaffected ones', () => {
    const dropsAlt = { type: 'replace-query' as const, queryId: 'p1', query: panelQuery('p1', 'SELECT a,b', { variants: { other: {} } }) };
    const plan = planSavedQueryMutation(multiTile(), dropsAlt, { type: 'switch-variant', tileVariants: { t1: 'other' } });
    expect(plan.ok).toBe(true);
  });

  it('remaps only affected tiles and leaves a source-less filter intact', () => {
    const workspace: StoredWorkspaceV1 = {
      storageVersion: 1, id: 'ws', name: 'WS',
      queries: [panelQuery('p1', 'SELECT a,b'), panelQuery('p2', 'SELECT a,b')],
      dashboard: {
        documentVersion: 1, id: 'dash', title: 'D', revision: 1,
        layout: { type: 'flow', version: 1, preset: 'full-width', items: { t1: {}, t2: {} } },
        filters: [{ id: 'flt', parameter: 'x' }], // no source
        tiles: [{ id: 't1', queryId: 'p1' }, { id: 't2', queryId: 'p2' }],
      },
    } as StoredWorkspaceV1;
    const plan = planSavedQueryMutation(workspace, { type: 'delete-query', queryId: 'p1' }, { type: 'remap-query', to: 'p2' });
    expect(plan.ok).toBe(true);
    const dashboard = plan.candidate!.dashboard!;
    expect(dashboard.tiles.map((t) => t.queryId)).toEqual(['p2', 'p2']);
  });

  it('tolerates malformed tiles and filters while applying a repair', () => {
    const malformed = {
      storageVersion: 1, id: 'ws', name: 'WS', queries: [panelQuery('p1', 'SELECT a,b')],
      dashboard: {
        documentVersion: 1, id: 'dash', title: 'D', revision: 1,
        layout: { type: 'flow', version: 1, preset: 'full-width', items: {} },
        filters: ['bad', { id: 'flt', parameter: 'x' }], tiles: ['bad', { id: 't1', queryId: 'p1' }],
      },
    } as unknown as StoredWorkspaceV1;
    const plan = planSavedQueryMutation(malformed, { type: 'delete-query', queryId: 'p1' }, { type: 'remove-affected' });
    // The malformed entries make the candidate invalid, but the repair helpers
    // ran over them without throwing.
    expect(plan.ok).toBe(false);
  });
});

describe('planSavedQueryMutation — no dashboard, and suggestRepairs', () => {
  it('always accepts a mutation when the workspace has no dashboard', () => {
    const workspace = { ...baseWorkspace(), dashboard: null } as StoredWorkspaceV1;
    const plan = planSavedQueryMutation(workspace, { type: 'delete-query', queryId: 'p1' });
    expect(plan.ok).toBe(true);
    expect(plan.candidate!.dashboard).toBeNull();
  });

  it('maps diagnostic scopes to repair kinds', () => {
    const repairs = suggestRepairs([
      { path: [], severity: 'error', code: 'x', message: '' },
      { path: ['dashboard', 'filters', 0], severity: 'error', code: 'y', message: '' },
      { path: ['dashboard', 'tiles', 0], severity: 'error', code: 'z', message: '' },
    ]);
    expect(repairs).toEqual(['remove-affected-filters', 'remove-affected-tiles', 'switch-variant', 'remap-query']);
  });
});
