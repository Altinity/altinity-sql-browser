import { describe, expect, it } from 'vitest';
import { removeTileMembership } from '../../src/dashboard/application/tile-membership.js';
import type { DashboardDocumentV2, SavedQueryV2 } from '../../src/generated/json-schema.types.js';

const panelQuery = (id: string): SavedQueryV2 => ({
  id, sql: 'SELECT 1', specVersion: 1, spec: { name: id, dashboard: { role: 'panel' } },
} as SavedQueryV2);
const setupQuery = (id: string): SavedQueryV2 => ({
  id, sql: "SELECT ['a'] AS x", specVersion: 1, spec: { name: id, dashboard: { role: 'setup' } },
} as SavedQueryV2);

const dashboard = (over: Partial<DashboardDocumentV2> = {}): DashboardDocumentV2 => ({
  documentVersion: 2, id: 'dash', title: 'D', revision: 1,
  layout: { type: 'flow', version: 1, preset: 'report', items: {} },
  tiles: [], ...over,
} as DashboardDocumentV2);

// #427 retired the favourite<->membership coupling this module used to own:
// `toggleTileMembership` (star -> tile) and `queryMembershipFavorite`
// (tile -> star) are gone, and one-tile removal no longer writes `spec.favorite`
// back onto the query. #447 additionally removed curated filters, so there is
// no longer any per-member reference (a filter `targets` list) to scrub
// alongside the tile — what remains is the Dashboard's own removal transform.
describe('one-tile removal (#370, #427, #447)', () => {
  it('removes the tile, leaving the query alone', () => {
    const query = { ...panelQuery('p1'), spec: { ...panelQuery('p1').spec, favorite: true } };
    const input = dashboard({
      tiles: [{ id: 't1', queryId: 'p1' }, { id: 't2', queryId: 'p2' }],
      layout: { type: 'flow', version: 1, preset: 'report', items: { t1: {}, t2: {} } },
    });
    const result = removeTileMembership(input, [query, panelQuery('p2')], 't1')!;
    expect(result.dashboard.tiles).toEqual([{ id: 't2', queryId: 'p2' }]);
    // The query collection comes through UNCHANGED: a favourite is a Library
    // preference from #427 on, so taking a tile off a Dashboard has nothing to
    // synchronize. Deleting the owned query too is #429's atomic trash action.
    expect(result.queries[0]).toBe(query);
    expect(result.queries[0].spec.favorite).toBe(true);
    expect(result.queryId).toBe('p1');
    expect(input.tiles).toHaveLength(2);
  });

  it('returns null for a missing tile', () => {
    expect(removeTileMembership(dashboard(), [panelQuery('p1')], 'missing')).toBeNull();
  });

  it('leaves a non-panel-role query untouched as well', () => {
    const setup = { ...setupQuery('f1'), spec: { ...setupQuery('f1').spec, favorite: true } };
    const result = removeTileMembership(
      dashboard({ tiles: [{ id: 't1', queryId: 'f1' }] }), [setup], 't1',
    )!;
    expect(result.queries[0]).toBe(setup);
  });

  it('normalizes grafana-grid primary and fallback placements after one-tile removal', () => {
    const input = dashboard({
      tiles: [{ id: 't1', queryId: 'p1' }, { id: 't2', queryId: 'p2' }],
      layout: {
        type: 'grafana-grid', version: 1,
        items: { t1: { colStart: 0, span: 6, height: 2 }, t2: { colStart: 6, span: 6, height: 3 } },
        fallback: {
          type: 'flow', version: 1, preset: 'columns-2',
          items: { t1: { span: 2, height: 'medium' }, t2: { span: 2, height: 'large' } },
        },
      },
    });
    const result = removeTileMembership(input, [panelQuery('p1'), panelQuery('p2')], 't1')!;
    expect((result.dashboard.layout as { items: Record<string, unknown> }).items).toEqual({
      t2: { colStart: 6, span: 6, height: 3 },
    });
    expect((result.dashboard.layout as { fallback: { items: Record<string, unknown> } }).fallback.items).toEqual({
      t2: { span: 2, height: 'large' },
    });
  });
});
