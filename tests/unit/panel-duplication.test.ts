import { describe, it, expect } from 'vitest';
import { duplicateDashboardPanel } from '../../src/dashboard/application/panel-duplication.js';
import { buildQueryOwnershipIndex } from '../../src/dashboard/model/query-ownership.js';
import { savedQuery } from '../helpers/saved-query.js';
import type { DashboardDocumentV2, StoredWorkspaceV5 } from '../../src/generated/json-schema.types.js';

const dash = (over: Partial<DashboardDocumentV2> = {}): DashboardDocumentV2 => ({
  documentVersion: 2,
  id: 'd1',
  title: 'D1',
  revision: 4,
  layout: { type: 'flow', version: 1, preset: 'columns-3', items: { t1: { span: 2, height: 'large' } } },
  tiles: [{ id: 't1', queryId: 'q-own' }],
  ...over,
});

const owned = savedQuery({
  id: 'q-own', sql: 'SELECT country, hits FROM t', name: 'Countries',
  description: 'the panel', dashboard: { role: 'panel' },
});

const ws = (over: Partial<StoredWorkspaceV5> = {}): StoredWorkspaceV5 => ({
  storageVersion: 5, id: 'w1', key: 'workspace', name: 'W',
  queries: [owned], dashboards: [dash()], ...over,
});

const input = { dashboardId: 'd1', tileId: 't1', newQueryId: 'q-copy', newTileId: 't-copy' };

const okResult = (latest: StoredWorkspaceV5, over: Partial<typeof input> = {}) => {
  const result = duplicateDashboardPanel({ latest, ...input, ...over });
  if (!result.ok) throw new Error('expected ok, got ' + result.reason);
  return result;
};

describe('duplicateDashboardPanel (#535)', () => {
  it('inserts the copy immediately AFTER the source, not at the end', () => {
    const latest = ws({
      queries: [owned, savedQuery({ id: 'q2', sql: 'SELECT 2', dashboard: { role: 'panel' } })],
      dashboards: [dash({ tiles: [{ id: 't1', queryId: 'q-own' }, { id: 't2', queryId: 'q2' }] })],
    });
    const result = okResult(latest);
    expect(result.workspace.dashboards[0].tiles.map((tile) => tile.id)).toEqual(['t1', 't-copy', 't2']);
    expect(result.data).toEqual({ queryId: 'q-copy', tileId: 't-copy' });
  });

  // The whole point of the ownership rule: a duplicate that reused the source's
  // queryId would be an INVALID workspace, not a second panel.
  it('mints a dedicated owned clone so each tile still owns exactly one query', () => {
    const result = okResult(ws());
    expect(result.workspace.queries.map((query) => query.id)).toEqual(['q-own', 'q-copy']);
    const { ownersByQueryId } = buildQueryOwnershipIndex(result.workspace);
    expect(ownersByQueryId.get('q-own')).toEqual([{ kind: 'panel', dashboardId: 'd1', tileId: 't1' }]);
    expect(ownersByQueryId.get('q-copy')).toEqual([{ kind: 'panel', dashboardId: 'd1', tileId: 't-copy' }]);
  });

  it('copies the SQL, the name and the description onto the clone', () => {
    const clone = okResult(ws()).workspace.queries[1];
    expect(clone.sql).toBe('SELECT country, hits FROM t');
    // The NAME is copied verbatim: two identically-named panels are exactly what
    // "duplicate" asks for, and nothing validates saved-query name uniqueness.
    expect(clone.spec.name).toBe('Countries');
    expect(clone.spec.description).toBe('the panel');
  });

  it('copies the source tile\'s own placement, not the query\'s size hints', () => {
    // `add-query-instance` would seed from `spec.dashboard.sizeHints`. A duplicate
    // must match what the user is looking at — the size they last dragged.
    const result = okResult(ws());
    const items = result.workspace.dashboards[0].layout.items!;
    expect(items['t-copy']).toEqual({ span: 2, height: 'large' });
    expect(items['t1']).toEqual({ span: 2, height: 'large' });
  });

  it('copies a grid placement through the grid engine, and regenerates the flow fallback', () => {
    const latest = ws({
      dashboards: [dash({
        layout: {
          type: 'grafana-grid', version: 1, items: { t1: { span: 8, height: 5 } },
          fallback: { type: 'flow', version: 1, preset: 'columns-2', items: { t1: { span: 2, height: 'medium' } } },
        },
      })],
    });
    const layout = okResult(latest).workspace.dashboards[0].layout;
    expect(layout.items!['t-copy']).toEqual({ span: 8, height: 5 });
    // `duplicate-tile` is in GRID_FALLBACK_COMMANDS, so the flow mirror gains the
    // tile too rather than going stale the moment the engine is switched back.
    expect((layout.fallback as { items: Record<string, unknown> }).items['t-copy']).toBeDefined();
  });

  it('carries the tile\'s presentation, title and description overrides', () => {
    const source = {
      id: 't1', queryId: 'q-own', title: 'Q3 revenue', description: 'local note',
      presentation: { variant: 'wide', override: { cfg: { type: 'bar', x: 0, y: [1] } } },
    };
    const withVariants = savedQuery({
      id: 'q-own', sql: 'SELECT 1',
      dashboard: { role: 'panel', variants: { wide: { cfg: { type: 'bar', x: 0, y: [1] } } } },
    });
    const latest = ws({ queries: [withVariants], dashboards: [dash({ tiles: [source] })] });
    const copy = okResult(latest).workspace.dashboards[0].tiles[1];
    expect(copy).toEqual({ ...source, id: 't-copy', queryId: 'q-copy' });
    // A deep copy, not a shared reference — editing one tile's override must not
    // reach into the other's.
    expect(copy.presentation).not.toBe(source.presentation);
  });

  it('leaves the input workspace untouched and bumps only the target revision', () => {
    const latest = ws({ dashboards: [dash(), dash({ id: 'd2', revision: 9, tiles: [] })] });
    const result = okResult(latest);
    expect(result.workspace.dashboards[0].revision).toBe(5);
    expect(result.workspace.dashboards[1].revision).toBe(9);
    expect(latest.dashboards[0].tiles).toHaveLength(1);
    expect(latest.queries).toHaveLength(1);
  });

  describe('refusals', () => {
    it('refuses a Dashboard that is missing or ambiguous', () => {
      expect(duplicateDashboardPanel({ latest: ws(), ...input, dashboardId: 'gone' }))
        .toEqual({ ok: false, reason: 'dashboard-missing' });
      const twice = ws({ dashboards: [dash(), dash()] });
      expect(duplicateDashboardPanel({ latest: twice, ...input }))
        .toEqual({ ok: false, reason: 'dashboard-ambiguous' });
    });

    it('refuses a tile that is no longer on the Dashboard', () => {
      expect(duplicateDashboardPanel({ latest: ws(), ...input, tileId: 'gone' }))
        .toEqual({ ok: false, reason: 'tile-missing' });
    });

    // A tile in this state already renders its own missing-query error; there is
    // nothing to copy, and inventing an empty query would be worse than refusing.
    it('refuses when the tile\'s own query is absent from the collection', () => {
      expect(duplicateDashboardPanel({ latest: ws({ queries: [] }), ...input }))
        .toEqual({ ok: false, reason: 'source-missing' });
    });

    it('refuses a minted id that is already taken, in either scope', () => {
      expect(duplicateDashboardPanel({ latest: ws(), ...input, newQueryId: 'q-own' }))
        .toEqual({ ok: false, reason: 'id-collision' });
      expect(duplicateDashboardPanel({ latest: ws(), ...input, newTileId: 't1' }))
        .toEqual({ ok: false, reason: 'id-collision' });
    });
  });
});
