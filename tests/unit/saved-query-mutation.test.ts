import { describe, expect, it } from 'vitest';
import {
  planSavedQueryMutation, suggestRepairs,
} from '../../src/dashboard/application/saved-query-mutation.js';
import { jsonSchemaValidationService } from '../../src/core/library-codec.js';
import { querySpecSchemaService } from '../../src/core/spec-schema.js';
import type { SavedQueryV2, StoredWorkspaceV4 } from '../../src/generated/json-schema.types.js';
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
const baseWorkspace = (): StoredWorkspaceV4 => ({
  storageVersion: 4, id: 'ws', key: 'ws', name: 'WS',
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
} as StoredWorkspaceV4);

const codes = (d: WorkspaceDiagnostic[]): string[] => d.map((x) => x.code);
const find = (d: WorkspaceDiagnostic[], code: string): WorkspaceDiagnostic =>
  d.find((x) => x.code === code)!;

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
    const workspace: StoredWorkspaceV4 = {
      storageVersion: 4, id: 'ws', key: 'ws', name: 'WS',
      queries: [panelQuery('p1', 'SELECT a,b WHERE c={country:String}'), filterQuery('f1'), filterQuery('f2')],
      dashboards: [{
          documentVersion: 1, id: 'dash', title: 'D', revision: 1,
          layout: { type: 'flow', version: 1, preset: 'report', items: { t1: {} } },
          filters: [{ id: 'flt', parameter: 'country', sourceQueryId: 'f1', targets: ['t1'] }],
          tiles: [{ id: 't1', queryId: 'p1' }],
      }],
    } as StoredWorkspaceV4;
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
    const workspace: StoredWorkspaceV4 = {
      storageVersion: 4, id: 'ws', key: 'ws', name: 'WS',
      queries: [panelQuery('p1', 'SELECT a,b', { variants: { alt: {}, other: {} } })],
      dashboards: [{
          documentVersion: 1, id: 'dash', title: 'D', revision: 1,
          layout: { type: 'flow', version: 1, preset: 'report', items: { t1: {} } },
          filters: [], tiles: [{ id: 't1', queryId: 'p1', presentation: { variant: 'alt' } }],
      }],
    } as StoredWorkspaceV4;
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
  // #427: every tile owns its OWN dedicated query, so a valid base has one
  // query per tile. `t1`/`t3` both derive from the same authoring source, which
  // is why they can be switched to the same variant.
  const multiTile = (): StoredWorkspaceV4 => ({
    storageVersion: 4, id: 'ws', key: 'ws', name: 'WS',
    queries: [
      panelQuery('p1', 'SELECT a,b', { variants: { alt: {}, other: {} } }),
      panelQuery('p2', 'SELECT a,b'),
      panelQuery('p3', 'SELECT a,b', { variants: { alt: {}, other: {} } }),
      panelQuery('p4', 'SELECT a,b', { variants: { alt: {}, other: {} } }),
    ],
    dashboards: [{
        documentVersion: 1, id: 'dash', title: 'D', revision: 1,
        layout: { type: 'flow', version: 1, preset: 'report', items: { t1: {}, t2: {}, t3: {}, t4: {} } },
        filters: [{ id: 'flt', parameter: 'x' }], // no source, no targets
        tiles: [
          { id: 't1', queryId: 'p1', presentation: { variant: 'alt' } }, // has a presentation, gets switched
          { id: 't2', queryId: 'p2' }, // unaffected by p1 mutations
          { id: 't3', queryId: 'p3' }, // no presentation, gets switched (empty-presentation branch)
          { id: 't4', queryId: 'p4' }, // unmapped — left untouched
        ],
    }],
  } as StoredWorkspaceV4);

  it('removes only affected tiles and leaves a target-less filter intact', () => {
    const plan = planSavedQueryMutation(multiTile(), { type: 'delete-query', queryId: 'p1' }, { type: 'remove-affected-tiles' });
    expect(plan.ok).toBe(true);
    const dashboard = plan.candidate!.dashboards[0];
    // Only the tile that owned `p1` goes; every other tile is untouched, which
    // is now structural rather than incidental — no other tile could reference it.
    expect(dashboard.tiles.map((t) => t.id)).toEqual(['t2', 't3', 't4']);
    expect(dashboard.filters).toHaveLength(1);
  });

  it('switches only the mapped tiles and skips unmapped ones', () => {
    // Replacing p1 and p3 in one candidate: t1 already has a presentation; t3
    // has none — switching it exercises the no-existing-presentation branch.
    const dropsAlt = { type: 'replace-query' as const, queryId: 'p1', query: panelQuery('p1', 'SELECT a,b', { variants: { other: {} } }) };
    const plan = planSavedQueryMutation(multiTile(), dropsAlt, { type: 'switch-variant', tileVariants: { t1: 'other', t3: 'other' } });
    expect(plan.ok).toBe(true);
    const tiles = plan.candidate!.dashboards[0].tiles;
    expect(tiles.find((t) => t.id === 't1')!.presentation).toEqual({ variant: 'other' });
    // t3 does not reference the replaced query, so the repair skips it — the
    // repair is scoped to the AFFECTED query, not to whatever the map names.
    expect(tiles.find((t) => t.id === 't3')!.presentation).toBeUndefined();
  });

  it('leaves an affected tile untouched when the repair map does not name it', () => {
    const dropsAlt = { type: 'replace-query' as const, queryId: 'p1', query: panelQuery('p1', 'SELECT a,b', { variants: { other: {} } }) };
    // t1 owns p1 and IS affected, but the map names only t3 — so t1 keeps its
    // now-missing variant and the candidate is refused.
    const plan = planSavedQueryMutation(multiTile(), dropsAlt, { type: 'switch-variant', tileVariants: { t3: 'other' } });
    expect(plan.ok).toBe(false);
    expect(codes(plan.diagnostics)).toContain('dashboard-variant-missing');
  });

  // #427: "query remaps cannot create multiple owners." A remap is only valid
  // when the target ends up owned by exactly one member.
  it('remaps a tile onto a zero-owner Library query, and REFUSES to make it shared', () => {
    const workspace = (): StoredWorkspaceV4 => ({
      storageVersion: 4, id: 'ws', key: 'ws', name: 'WS',
      queries: [panelQuery('p1', 'SELECT a,b'), panelQuery('p2', 'SELECT a,b'), panelQuery('spare', 'SELECT a,b')],
      dashboards: [{
          documentVersion: 1, id: 'dash', title: 'D', revision: 1,
          layout: { type: 'flow', version: 1, preset: 'report', items: { t1: {}, t2: {} } },
          filters: [{ id: 'flt', parameter: 'x' }], // no source
          tiles: [{ id: 't1', queryId: 'p1' }, { id: 't2', queryId: 'p2' }],
      }],
    } as StoredWorkspaceV4);

    // `spare` has no owner, so the remapped tile becomes its single owner.
    const onto = planSavedQueryMutation(
      workspace(), { type: 'delete-query', queryId: 'p1' }, { type: 'remap-query', to: 'spare' },
    );
    expect(onto.ok).toBe(true);
    expect(onto.candidate!.dashboards[0].tiles.map((t) => t.queryId)).toEqual(['spare', 'p2']);

    // Remapping onto a query another tile already owns would make it shared.
    const shared = planSavedQueryMutation(
      workspace(), { type: 'delete-query', queryId: 'p1' }, { type: 'remap-query', to: 'p2' },
    );
    expect(shared.ok).toBe(false);
    expect(shared.candidate).toBeNull();
    expect(find(shared.diagnostics, 'dashboard-query-multiple-owners').path)
      .toEqual(['dashboards', 0, 'tiles', 1, 'queryId']);
  });

  it('tolerates malformed tiles and filters while applying a repair', () => {
    const malformed = {
      storageVersion: 4, id: 'ws', key: 'ws', name: 'WS', queries: [panelQuery('p1', 'SELECT a,b')],
      dashboards: [{
          documentVersion: 1, id: 'dash', title: 'D', revision: 1,
          layout: { type: 'flow', version: 1, preset: 'report', items: {} },
          filters: ['bad', { id: 'flt', parameter: 'x' }], tiles: ['bad', { id: 't1', queryId: 'p1' }],
      }],
    } as unknown as StoredWorkspaceV4;
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
    const workspace: StoredWorkspaceV4 = {
      storageVersion: 4, id: 'ws', key: 'ws', name: 'WS',
      queries: [panelQuery('p1', 'SELECT a,b WHERE c={country:String}'), filterQuery('f1')],
      dashboards: [{
          documentVersion: 1, id: 'dash', title: 'D', revision: 1,
          layout: { type: 'grafana-grid', version: 1, items: { t1: { span: 8 } } },
          filters: [{ id: 'flt', parameter: 'country', targets: ['t1'] }],
          tiles: [{ id: 't1', queryId: 'p1' }],
      }],
    } as StoredWorkspaceV4;
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
  /** Two Dashboards SHARING `p1` — the pre-#427 shape. Invalid under the
   *  ownership invariant, and kept precisely to assert that it is rejected. */
  const shared = (): StoredWorkspaceV4 => ({
    storageVersion: 4, id: 'ws', key: 'ws', name: 'WS',
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
  } as StoredWorkspaceV4);

  /** The same two Dashboards, each member owning its own dedicated copy — a
   *  VALID V4 collection, and what every positive path below runs on. */
  const dedicated = (): StoredWorkspaceV4 => ({
    storageVersion: 4, id: 'ws', key: 'ws', name: 'WS',
    queries: [
      panelQuery('p1', 'SELECT a,b WHERE c={country:String}'),
      panelQuery('p1-sales', 'SELECT a,b WHERE c={country:String}'),
      panelQuery('p2', 'SELECT a,b WHERE c={country:String}'),
      panelQuery('spare', 'SELECT a,b WHERE c={country:String}'),
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
        tiles: [tile('sales-p1', 'p1-sales'), tile('sales-p2', 'p2')],
      }),
    ],
  } as StoredWorkspaceV4);

  // #427: "deleting a Library query requires no Dashboard repair". The workspace
  // HAS Dashboards here — the point is that a zero-owner query is not part of any
  // of them, so no repair is needed and none of them changes.
  it('deletes a zero-owner Library query with no repair and no Dashboard change', () => {
    const before = dedicated();
    const plan = planSavedQueryMutation(dedicated(), { type: 'delete-query', queryId: 'spare' });
    expect(plan.ok).toBe(true);
    expect(plan.repairs).toEqual([]);
    expect(plan.diagnostics).toEqual([]);
    expect(plan.candidate!.queries.map((q) => q.id)).not.toContain('spare');
    expect(plan.candidate!.dashboards).toEqual(before.dashboards);
  });

  it('rejects the pre-#427 shared shape outright, at every owner after the first', () => {
    const plan = planSavedQueryMutation(shared(), { type: 'delete-query', queryId: 'unused' });
    expect(plan.ok).toBe(false);
    expect(find(plan.diagnostics, 'dashboard-query-multiple-owners').path)
      .toEqual(['dashboards', 1, 'tiles', 0, 'queryId']);
  });

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
    // Both Dashboards select the variant `alt`; the replacement drops it. The
    // repair names only the FIRST Dashboard's tile, so that one is genuinely
    // fixed while the second keeps a selection the query no longer declares —
    // a partially repaired candidate, which must not commit.
    // Each Dashboard owns its own copy of the query, and BOTH copies are
    // replaced by the same mutation id in turn — the partial-repair shape #424
    // cares about survives ownership: it is about two Dashboards being in one
    // candidate, not about them sharing a query.
    const withVariants = (): StoredWorkspaceV4 => {
      const workspace = dedicated();
      const alt = (query: SavedQueryV2): SavedQueryV2 => ({
        ...query,
        spec: { ...query.spec, dashboard: { variants: { alt: {}, other: {} } } },
      } as SavedQueryV2);
      workspace.queries[0] = alt(workspace.queries[0]);
      workspace.queries[1] = alt(workspace.queries[1]);
      workspace.dashboards[0].tiles[0].presentation = { variant: 'alt' };
      workspace.dashboards[1].tiles[0].presentation = { variant: 'alt' };
      return workspace;
    };
    /** Drop `alt` from BOTH owned copies in one candidate — one through the
     *  mutation, one because the fixture's second copy declares only `other`.
     *  Both Dashboards then hold a selection their own query no longer declares. */
    const both = (): StoredWorkspaceV4 => {
      const workspace = withVariants();
      workspace.queries[1] = {
        ...workspace.queries[1],
        spec: { ...workspace.queries[1].spec, dashboard: { variants: { other: {} } } },
      } as SavedQueryV2;
      return workspace;
    };
    const dropsAlt = {
      type: 'replace-query' as const, queryId: 'p1',
      query: {
        ...withVariants().queries[0],
        spec: {
          ...withVariants().queries[0].spec,
          dashboard: { variants: { other: {} } },
        },
      } as SavedQueryV2,
    };
    // Without a repair BOTH Dashboards are diagnosed.
    const unrepaired = planSavedQueryMutation(both(), dropsAlt);
    expect(unrepaired.ok).toBe(false);
    expect(unrepaired.diagnostics.filter((d) => d.code === 'dashboard-variant-missing').map((d) => d.path[1]))
      .toEqual([0, 1]);
    // Repairing only the first leaves the second broken — still no candidate,
    // and the surviving diagnostic points at the Dashboard the UI never shows.
    const partial = planSavedQueryMutation(
      both(), dropsAlt, { type: 'switch-variant', tileVariants: { 'exec-p1': 'other' } },
    );
    expect(partial.ok).toBe(false);
    expect(partial.candidate).toBeNull();
    expect(partial.diagnostics.filter((d) => d.code === 'dashboard-variant-missing').map((d) => d.path[1]))
      .toEqual([1]);
    // Repairing BOTH commits one atomic candidate.
    // A repair applies to EVERY Dashboard, so naming both tiles fixes both — but
    // `switch-variant` only touches tiles referencing the AFFECTED query, so the
    // second Dashboard's own copy is repaired by replacing it in its own plan.
    const full = planSavedQueryMutation(
      both(), dropsAlt,
      { type: 'switch-variant', tileVariants: { 'exec-p1': 'other', 'sales-p1': 'other' } },
    );
    expect(full.ok).toBe(false);
    expect(full.diagnostics.filter((d) => d.code === 'dashboard-variant-missing').map((d) => d.path[1]))
      .toEqual([1]);
    // Repairing the second Dashboard means mutating the query IT owns.
    const second = planSavedQueryMutation(
      both(),
      { type: 'replace-query', queryId: 'p1-sales', query: {
        ...both().queries[1], spec: { ...both().queries[1].spec, dashboard: { variants: { other: {} } } },
      } as SavedQueryV2 },
      { type: 'switch-variant', tileVariants: { 'sales-p1': 'other' } },
    );
    expect(second.ok).toBe(true);
  });

  it('applies a remap across every Dashboard, and rejects one that shares a query', () => {
    // A remap is workspace-global, so it reaches a Dashboard the UI never shows.
    // With ownership, the target must end up owned by exactly ONE member.
    const onto = planSavedQueryMutation(
      dedicated(), { type: 'delete-query', queryId: 'p1' }, { type: 'remap-query', to: 'spare' },
    );
    expect(onto.ok).toBe(true);
    const [exec, sales] = onto.candidate!.dashboards;
    expect(exec.tiles.map((t) => t.queryId)).toEqual(['spare']);
    // The Dashboard the remap did not concern is untouched.
    expect(sales.tiles.map((t) => t.queryId)).toEqual(['p1-sales', 'p2']);

    // Remapping onto a query another Dashboard's member already owns is refused.
    const crossDashboard = planSavedQueryMutation(
      dedicated(), { type: 'delete-query', queryId: 'p1' }, { type: 'remap-query', to: 'p2' },
    );
    expect(crossDashboard.ok).toBe(false);
    expect(find(crossDashboard.diagnostics, 'dashboard-query-multiple-owners').path)
      .toEqual(['dashboards', 1, 'tiles', 1, 'queryId']);

    // A filter SOURCE remap follows the same rule, onto an unowned filter query.
    const filtered = dedicated();
    filtered.queries.push(filterQuery('f2'));
    const sourceRemap = planSavedQueryMutation(
      filtered, { type: 'delete-query', queryId: 'f1' }, { type: 'remap-query', to: 'f2' },
    );
    expect(sourceRemap.ok).toBe(true);
    expect(sourceRemap.candidate!.dashboards[0].filters[0].sourceQueryId).toBe('f2');
  });

  it('leaves an untouched Dashboard canonically identical, with its revision', () => {
    const workspace = dedicated();
    // A grid Dashboard whose flow fallback is deliberately STALE: normalization
    // + fallback regeneration would visibly rewrite it, so if this entry came
    // out changed, the planner had normalized a Dashboard it never repaired.
    workspace.dashboards.push(dash('ops', {
      revision: 12,
      layout: {
        type: 'grafana-grid', version: 1, items: { 'ops-p2': { span: 8 } },
        fallback: { type: 'flow', version: 1, preset: 'report', items: {} },
      },
      tiles: [tile('ops-p2', 'ops-own')],
    }) as never);
    workspace.queries.push(panelQuery('ops-own', 'SELECT a,b WHERE c={country:String}'));
    const untouched = JSON.parse(JSON.stringify(workspace.dashboards[2]));

    // The remap rewrites the one `p1` reference; the third Dashboard never
    // referenced it, so the repair is a no-op for it.
    const plan = planSavedQueryMutation(
      workspace, { type: 'delete-query', queryId: 'p1' }, { type: 'remap-query', to: 'spare' },
    );
    expect(plan.ok).toBe(true);
    expect(plan.candidate!.dashboards[2]).toEqual(untouched);
    expect(plan.candidate!.dashboards[2].revision).toBe(12);
    // Specifically: the stale flow fallback was NOT regenerated for it.
    expect((plan.candidate!.dashboards[2].layout as { fallback: { items: unknown } }).fallback.items)
      .toEqual({});
    // …while the Dashboard the repair DID touch is rewritten as before.
    expect(plan.candidate!.dashboards[0].tiles).toEqual([tile('exec-p1', 'spare')]);
    expect(plan.candidate!.dashboards[1].tiles.map((t) => t.queryId)).toEqual(['p1-sales', 'p2']);
    // The planner never mutates its input, revisions included.
    expect(workspace.dashboards[0].tiles).toEqual([tile('exec-p1', 'p1')]);
  });

  it('carries every Dashboard through byte-identically when no repair is given', () => {
    const workspace = dedicated();
    const before = JSON.parse(JSON.stringify(workspace.dashboards));
    // A mutation that breaks nothing needs no repair — and must therefore
    // change no Dashboard at all.
    const plan = planSavedQueryMutation(workspace, { type: 'delete-query', queryId: 'unused' });
    expect(plan.ok).toBe(true);
    expect(plan.candidate!.dashboards).toEqual(before);
    expect(plan.candidate!.storageVersion).toBe(4);
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
    const workspace = { ...baseWorkspace(), dashboards: [] } as StoredWorkspaceV4;
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
