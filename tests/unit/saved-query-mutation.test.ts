import { describe, expect, it } from 'vitest';
import {
  planSavedQueryMutation, suggestRepairs,
} from '../../src/dashboard/application/saved-query-mutation.js';
import { jsonSchemaValidationService } from '../../src/core/library-codec.js';
import { querySpecSchemaService } from '../../src/core/spec-schema.js';
import type { SavedQueryV2, StoredWorkspaceV3 } from '../../src/generated/json-schema.types.js';
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
const baseWorkspace = (): StoredWorkspaceV3 => ({
  storageVersion: 3, id: 'ws', key: 'ws', name: 'WS',
  queries: [
    panelQuery('p1', 'SELECT a,b WHERE c={country:String}'),
    panelQuery('p2', 'SELECT a,b WHERE c={country:String}'),
    filterQuery('f1'),
  ],
  dashboards: [{
      documentVersion: 1, id: 'dash', title: 'D', revision: 1,
      layout: { type: 'flow', version: 1, preset: 'report', items: { t1: {} } },
      filters: [{ id: 'flt', parameter: 'country', sourceQueryId: 'f1', targets: ['t1'] }],
      tiles: [{ id: 't1', queryId: 'p1' }],
  }],
} as StoredWorkspaceV3);

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

  it('repairs a filter-source role change by removing the affected filter', () => {
    const plan = planSavedQueryMutation(baseWorkspace(),
      { type: 'replace-query', queryId: 'f1', query: panelQuery('f1', 'SELECT 1') },
      { type: 'remove-affected-filters' });
    expect(plan.ok).toBe(true);
    expect(plan.candidate!.dashboards[0].filters).toEqual([]); // flt sourced from f1 removed
  });

  it('remaps a filter source reference onto another filter query', () => {
    const workspace: StoredWorkspaceV3 = {
      storageVersion: 3, id: 'ws', key: 'ws', name: 'WS',
      queries: [panelQuery('p1', 'SELECT a,b WHERE c={country:String}'), filterQuery('f1'), filterQuery('f2')],
      dashboards: [{
          documentVersion: 1, id: 'dash', title: 'D', revision: 1,
          layout: { type: 'flow', version: 1, preset: 'report', items: { t1: {} } },
          filters: [{ id: 'flt', parameter: 'country', sourceQueryId: 'f1', targets: ['t1'] }],
          tiles: [{ id: 't1', queryId: 'p1' }],
      }],
    } as StoredWorkspaceV3;
    const plan = planSavedQueryMutation(workspace, { type: 'delete-query', queryId: 'f1' }, { type: 'remap-query', to: 'f2' });
    expect(plan.ok).toBe(true);
    expect(plan.candidate!.dashboards[0].filters[0].sourceQueryId).toBe('f2');
  });
});

describe('planSavedQueryMutation — atomic repair', () => {
  it('removes affected tiles (and prunes their placements and filter targets)', () => {
    // A PLAIN filter (no `sourceQueryId`) here deliberately — this test is
    // about tile/target PRUNING mechanics (`removeAffectedTiles`), not
    // filter-selection contract validity (#189/#360, `workspace-semantics.ts`
    // now runs `resolveFilterSelection` for every SOURCE-BACKED filter). A
    // source-backed filter left with zero executable consumers once its only
    // tile is gone is itself a real `filter-selection-no-consumers` — exactly
    // what the app SHOULD flag — and orthogonal to what this test checks.
    const workspace = baseWorkspace();
    workspace.dashboards[0].filters = [{ id: 'flt', parameter: 'country', targets: ['t1'] }];
    const plan = planSavedQueryMutation(workspace,
      { type: 'delete-query', queryId: 'p1' }, { type: 'remove-affected-tiles' });
    expect(plan.ok).toBe(true);
    const dashboard = plan.candidate!.dashboards[0];
    expect(dashboard.tiles).toEqual([]);
    expect(dashboard.layout.items).toEqual({}); // orphan placement pruned
    expect(dashboard.filters[0].targets).toEqual([]); // target reference pruned
  });

  it('removes affected filters when a parameter change invalidates a target', () => {
    // p1 no longer declares `country`; the filter targeting its tile breaks.
    // Since `flt` is source-backed (`sourceQueryId: 'f1'`), `t1` failing to
    // declare `country` now surfaces through `resolveFilterSelection`'s own
    // (bound-aware) `filter-selection-target-missing-declaration` — which
    // subsumes the older unbound `filter-parameter-undeclared` check for a
    // source-backed filter's explicit targets (workspace-semantics.ts).
    const plan = planSavedQueryMutation(baseWorkspace(),
      { type: 'replace-query', queryId: 'p1', query: panelQuery('p1', 'SELECT a,b') });
    expect(plan.ok).toBe(false);
    expect(codes(plan.diagnostics)).toContain('filter-selection-target-missing-declaration');

    const repaired = planSavedQueryMutation(baseWorkspace(),
      { type: 'replace-query', queryId: 'p1', query: panelQuery('p1', 'SELECT a,b') },
      { type: 'remove-affected-filters' });
    expect(repaired.ok).toBe(true);
    expect(repaired.candidate!.dashboards[0].filters).toEqual([]);
  });

  it('switches an affected tile to another valid variant', () => {
    const workspace: StoredWorkspaceV3 = {
      storageVersion: 3, id: 'ws', key: 'ws', name: 'WS',
      queries: [panelQuery('p1', 'SELECT a,b', { variants: { alt: {}, other: {} } })],
      dashboards: [{
          documentVersion: 1, id: 'dash', title: 'D', revision: 1,
          layout: { type: 'flow', version: 1, preset: 'report', items: { t1: {} } },
          filters: [], tiles: [{ id: 't1', queryId: 'p1', presentation: { variant: 'alt' } }],
      }],
    } as StoredWorkspaceV3;
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
    const dashboard = plan.candidate!.dashboards[0];
    expect(dashboard.tiles[0].queryId).toBe('p2');
  });

  it('supports remove-affected (tiles and filters together)', () => {
    // A PLAIN filter here too (see the "removes affected tiles" test above
    // for why) — `removeAffectedFilters` composed after `removeAffectedTiles`
    // recomputes its "targets an affected tile" check against the
    // ALREADY-tile-pruned dashboard, so the filter survives regardless of
    // `sourceQueryId`; a source-backed filter left with zero consumers here
    // would instead (correctly) fail the new selection-contract check.
    const workspace = baseWorkspace();
    workspace.dashboards[0].filters = [{ id: 'flt', parameter: 'country', targets: ['t1'] }];
    const plan = planSavedQueryMutation(workspace,
      { type: 'delete-query', queryId: 'p1' }, { type: 'remove-affected' },
      { validationService: jsonSchemaValidationService, schemaService: querySpecSchemaService });
    expect(plan.ok).toBe(true);
    const dashboard = plan.candidate!.dashboards[0];
    expect(dashboard.tiles).toEqual([]);
    // The filter survives (not targeting p1's query directly), with its
    // now-empty target list — remove-affected removed the affected tile and
    // its target ref.
    expect(dashboard.filters[0].targets).toEqual([]);
  });
});

describe('planSavedQueryMutation — repairs skip unaffected and target-less entries', () => {
  const multiTile = (): StoredWorkspaceV3 => ({
    storageVersion: 3, id: 'ws', key: 'ws', name: 'WS',
    queries: [panelQuery('p1', 'SELECT a,b', { variants: { alt: {}, other: {} } }), panelQuery('p2', 'SELECT a,b')],
    dashboards: [{
        documentVersion: 1, id: 'dash', title: 'D', revision: 1,
        layout: { type: 'flow', version: 1, preset: 'report', items: { t1: {}, t2: {}, t3: {}, t4: {} } },
        filters: [{ id: 'flt', parameter: 'x' }], // no source, no targets
        tiles: [
          { id: 't1', queryId: 'p1', presentation: { variant: 'alt' } }, // has a presentation, gets switched
          { id: 't2', queryId: 'p2' }, // unaffected by p1 mutations
          { id: 't3', queryId: 'p1' }, // affected, no presentation, gets switched (empty-presentation branch)
          { id: 't4', queryId: 'p1' }, // affected but unmapped — left untouched
        ],
    }],
  } as StoredWorkspaceV3);

  it('removes only affected tiles and leaves a target-less filter intact', () => {
    const plan = planSavedQueryMutation(multiTile(), { type: 'delete-query', queryId: 'p1' }, { type: 'remove-affected-tiles' });
    expect(plan.ok).toBe(true);
    const dashboard = plan.candidate!.dashboards[0];
    expect(dashboard.tiles.map((t) => t.id)).toEqual(['t2']);
    expect(dashboard.filters).toHaveLength(1);
  });

  it('switches only the mapped affected tile and skips unaffected ones', () => {
    const dropsAlt = { type: 'replace-query' as const, queryId: 'p1', query: panelQuery('p1', 'SELECT a,b', { variants: { other: {} } }) };
    // t1 already has a presentation; t3 has none — switching it exercises the
    // no-existing-presentation branch. t2 is unaffected and is skipped.
    const plan = planSavedQueryMutation(multiTile(), dropsAlt, { type: 'switch-variant', tileVariants: { t1: 'other', t3: 'other' } });
    expect(plan.ok).toBe(true);
    const tiles = plan.candidate!.dashboards[0].tiles;
    expect(tiles.find((t) => t.id === 't3')!.presentation).toEqual({ variant: 'other' });
  });

  it('remaps only affected tiles and leaves a source-less filter intact', () => {
    const workspace: StoredWorkspaceV3 = {
      storageVersion: 3, id: 'ws', key: 'ws', name: 'WS',
      queries: [panelQuery('p1', 'SELECT a,b'), panelQuery('p2', 'SELECT a,b')],
      dashboards: [{
          documentVersion: 1, id: 'dash', title: 'D', revision: 1,
          layout: { type: 'flow', version: 1, preset: 'report', items: { t1: {}, t2: {} } },
          filters: [{ id: 'flt', parameter: 'x' }], // no source
          tiles: [{ id: 't1', queryId: 'p1' }, { id: 't2', queryId: 'p2' }],
      }],
    } as StoredWorkspaceV3;
    const plan = planSavedQueryMutation(workspace, { type: 'delete-query', queryId: 'p1' }, { type: 'remap-query', to: 'p2' });
    expect(plan.ok).toBe(true);
    const dashboard = plan.candidate!.dashboards[0];
    expect(dashboard.tiles.map((t) => t.queryId)).toEqual(['p2', 'p2']);
  });

  it('tolerates malformed tiles and filters while applying a repair', () => {
    const malformed = {
      storageVersion: 3, id: 'ws', key: 'ws', name: 'WS', queries: [panelQuery('p1', 'SELECT a,b')],
      dashboards: [{
          documentVersion: 1, id: 'dash', title: 'D', revision: 1,
          layout: { type: 'flow', version: 1, preset: 'report', items: {} },
          filters: ['bad', { id: 'flt', parameter: 'x' }], tiles: ['bad', { id: 't1', queryId: 'p1' }],
      }],
    } as unknown as StoredWorkspaceV3;
    const plan = planSavedQueryMutation(malformed, { type: 'delete-query', queryId: 'p1' }, { type: 'remove-affected' });
    // The malformed entries make the candidate invalid, but the repair helpers
    // ran over them without throwing.
    expect(plan.ok).toBe(false);
  });
});

describe('planSavedQueryMutation — grafana-grid@1 engine awareness (#291)', () => {
  it('normalizes through the ACTIVE grid plugin and regenerates the flow@1 fallback on a tile-removing repair', () => {
    // A PLAIN filter (no `sourceQueryId`) — this test is about grid-layout
    // normalization/fallback regeneration, not filter-selection contract
    // validity; see the "removes affected tiles" test above for why a
    // source-backed filter left with zero tiles would (correctly) now fail.
    const workspace: StoredWorkspaceV3 = {
      storageVersion: 3, id: 'ws', key: 'ws', name: 'WS',
      queries: [panelQuery('p1', 'SELECT a,b WHERE c={country:String}'), filterQuery('f1')],
      dashboards: [{
          documentVersion: 1, id: 'dash', title: 'D', revision: 1,
          layout: { type: 'grafana-grid', version: 1, items: { t1: { span: 8 } } },
          filters: [{ id: 'flt', parameter: 'country', targets: ['t1'] }],
          tiles: [{ id: 't1', queryId: 'p1' }],
      }],
    } as StoredWorkspaceV3;
    const plan = planSavedQueryMutation(workspace, { type: 'delete-query', queryId: 'p1' }, { type: 'remove-affected-tiles' });
    expect(plan.ok).toBe(true);
    const dashboard = plan.candidate!.dashboards[0];
    expect(dashboard.layout.type).toBe('grafana-grid');
    expect(dashboard.tiles).toEqual([]);
    expect(dashboard.layout.items).toEqual({}); // orphan grid placement pruned
    expect((dashboard.layout as { fallback?: unknown }).fallback).toEqual({
      type: 'flow', version: 1, preset: 'columns-2', items: {},
    });
  });
});

// #424: the planner treats EVERY Dashboard as part of the one atomic candidate.
describe('planSavedQueryMutation — the whole Dashboard collection (#424)', () => {
  const tile = (id: string, queryId: string) => ({ id, queryId });
  const dash = (id: string, over: Record<string, unknown> = {}) => ({
    documentVersion: 1, id, title: id, revision: 1,
    layout: { type: 'flow', version: 1, preset: 'report', items: {} },
    filters: [], tiles: [], ...over,
  });
  /** Two Dashboards over ONE shared query catalog — the multi-Dashboard shape
   *  V3 exists for: `p1` backs a tile in both, under Dashboard-LOCAL tile ids. */
  const shared = (): StoredWorkspaceV3 => ({
    storageVersion: 3, id: 'ws', key: 'ws', name: 'WS',
    queries: [
      panelQuery('p1', 'SELECT a,b WHERE c={country:String}'),
      panelQuery('p2', 'SELECT a,b WHERE c={country:String}'),
      filterQuery('f1'),
    ],
    dashboards: [
      dash('exec', {
        layout: { type: 'flow', version: 1, preset: 'report', items: { 'exec-p1': {} } },
        filters: [{ id: 'flt', parameter: 'country', sourceQueryId: 'f1', targets: ['exec-p1'] }],
        tiles: [tile('exec-p1', 'p1')],
      }),
      dash('sales', {
        layout: { type: 'flow', version: 1, preset: 'columns-2', items: { 'sales-p1': {} } },
        tiles: [tile('sales-p1', 'p1'), tile('sales-p2', 'p2')],
      }),
    ],
  } as StoredWorkspaceV3);

  it('reports every affected Dashboard when a shared query is deleted', () => {
    const plan = planSavedQueryMutation(shared(), { type: 'delete-query', queryId: 'p1' });
    expect(plan.ok).toBe(false);
    expect(plan.candidate).toBeNull();
    const missing = plan.diagnostics.filter((d) => d.code === 'dashboard-tile-query-missing');
    // Both Dashboards are diagnosed, each at its own indexed path — a break in
    // a Dashboard the current UI never renders can't pass silently.
    expect(missing.map((d) => d.path)).toEqual([
      ['dashboards', 0, 'tiles', 0, 'queryId'],
      ['dashboards', 1, 'tiles', 0, 'queryId'],
    ]);
  });

  it('rejects a repair that fixes one Dashboard while another stays invalid', () => {
    // `switch-variant` names a tile id that exists only in the FIRST Dashboard,
    // so the second keeps its dangling reference and the whole candidate dies.
    const plan = planSavedQueryMutation(
      shared(), { type: 'delete-query', queryId: 'p1' },
      { type: 'switch-variant', tileVariants: { 'exec-p1': 'other' } },
    );
    expect(plan.ok).toBe(false);
    expect(plan.candidate).toBeNull();
    expect(plan.diagnostics.some((d) => d.path[1] === 1)).toBe(true);
  });

  it('applies a remap across tiles AND filter sources in every Dashboard', () => {
    const plan = planSavedQueryMutation(
      shared(), { type: 'delete-query', queryId: 'p1' }, { type: 'remap-query', to: 'p2' },
    );
    expect(plan.ok).toBe(true);
    const [exec, sales] = plan.candidate!.dashboards;
    expect(exec.tiles.map((t) => t.queryId)).toEqual(['p2']);
    expect(sales.tiles.map((t) => t.queryId)).toEqual(['p2', 'p2']);

    // A filter SOURCE remap reaches every Dashboard too.
    const sourceRemap = planSavedQueryMutation(
      shared(), { type: 'delete-query', queryId: 'f1' }, { type: 'remove-affected-filters' },
    );
    expect(sourceRemap.ok).toBe(true);
    expect(sourceRemap.candidate!.dashboards[0].filters).toEqual([]);
  });

  it('leaves an untouched Dashboard canonically identical, with its revision', () => {
    const workspace = shared();
    // A grid Dashboard whose flow fallback is deliberately STALE: normalization
    // + fallback regeneration would visibly rewrite it, so if this entry came
    // out changed, the planner had normalized a Dashboard it never repaired.
    workspace.dashboards.push(dash('ops', {
      revision: 12,
      layout: {
        type: 'grafana-grid', version: 1, items: { 'ops-p2': { span: 8 } },
        fallback: { type: 'flow', version: 1, preset: 'report', items: {} },
      },
      tiles: [tile('ops-p2', 'p2')],
    }) as never);
    const untouched = JSON.parse(JSON.stringify(workspace.dashboards[2]));

    // The remap rewrites `p1` references in the first two Dashboards; the
    // third only ever referenced `p2`, so the repair is a no-op for it.
    const plan = planSavedQueryMutation(
      workspace, { type: 'delete-query', queryId: 'p1' }, { type: 'remap-query', to: 'p2' },
    );
    expect(plan.ok).toBe(true);
    expect(plan.candidate!.dashboards[2]).toEqual(untouched);
    expect(plan.candidate!.dashboards[2].revision).toBe(12);
    // Specifically: the stale flow fallback was NOT regenerated for it.
    expect((plan.candidate!.dashboards[2].layout as { fallback: { items: unknown } }).fallback.items)
      .toEqual({});
    // …while the Dashboards the repair DID touch are rewritten as before.
    expect(plan.candidate!.dashboards[0].tiles).toEqual([tile('exec-p1', 'p2')]);
    expect(plan.candidate!.dashboards[1].tiles.map((t) => t.queryId)).toEqual(['p2', 'p2']);
    // The planner never mutates its input, revisions included.
    expect(workspace.dashboards[0].tiles).toEqual([tile('exec-p1', 'p1')]);
  });

  it('carries every Dashboard through byte-identically when no repair is given', () => {
    const workspace = shared();
    const before = JSON.parse(JSON.stringify(workspace.dashboards));
    // A mutation that breaks nothing needs no repair — and must therefore
    // change no Dashboard at all.
    const plan = planSavedQueryMutation(workspace, { type: 'delete-query', queryId: 'unused' });
    expect(plan.ok).toBe(true);
    expect(plan.candidate!.dashboards).toEqual(before);
    expect(plan.candidate!.storageVersion).toBe(3);
  });

  it('rejects a candidate whose duplicate Dashboard ids make the workspace invalid', () => {
    const workspace = shared();
    workspace.dashboards.push(dash('exec') as never);
    const plan = planSavedQueryMutation(workspace, { type: 'delete-query', queryId: 'unused' });
    expect(plan.ok).toBe(false);
    expect(codes(plan.diagnostics)).toContain('workspace-duplicate-dashboard-id');
  });
});

describe('planSavedQueryMutation — no dashboard, and suggestRepairs', () => {
  it('always accepts a mutation when the workspace has no dashboard', () => {
    const workspace = { ...baseWorkspace(), dashboards: [] } as StoredWorkspaceV3;
    const plan = planSavedQueryMutation(workspace, { type: 'delete-query', queryId: 'p1' });
    expect(plan.ok).toBe(true);
    expect(plan.candidate!.dashboards).toEqual([]);
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
