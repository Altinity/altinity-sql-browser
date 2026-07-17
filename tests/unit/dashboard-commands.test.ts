import { describe, expect, it } from 'vitest';
import { applyCommand } from '../../src/dashboard/application/dashboard-commands.js';
import type { ApplyCommandContext, DashboardCommand } from '../../src/dashboard/application/dashboard-commands.js';
import { createQueryResolver } from '../../src/dashboard/application/dashboard-query-resolver.js';
import { flowLayoutPlugin } from '../../src/dashboard/layouts/flow-layout.js';
import type { DashboardDocumentV1 } from '../../src/generated/json-schema.types.js';

const query = (id: string, dashboard?: Record<string, unknown>) => ({
  id, sql: 'SELECT 1', specVersion: 1, spec: { name: id, panel: { cfg: { type: 'bar', x: 0, y: [1] } }, ...(dashboard ? { dashboard } : {}) },
});

const draft = (over: Partial<DashboardDocumentV1> = {}): DashboardDocumentV1 => ({
  documentVersion: 1, id: 'd', title: 'D', revision: 1,
  layout: { type: 'flow', version: 1, preset: 'full-width', items: {} }, filters: [], tiles: [], ...over,
} as DashboardDocumentV1);

const makeCtx = (queries: unknown[]): ApplyCommandContext => {
  let n = 0;
  return { resolver: createQueryResolver(queries), genTileId: () => `tile-${++n}`, plugin: flowLayoutPlugin };
};

const run = (d: DashboardDocumentV1, command: DashboardCommand, queries: unknown[]) =>
  applyCommand(d, command, makeCtx(queries));

describe('applyCommand — add-query / add-query-instance', () => {
  it('adds a default tile and derives an initial placement from size hints', () => {
    const q = query('q', { sizeHints: { preferred: 'wide' } });
    const result = run(draft(), { type: 'add-query', queryId: 'q' }, [q]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((result.value as { tileId: string }).tileId).toBe('tile-1');
      expect(result.dashboard.tiles).toEqual([{ id: 'tile-1', queryId: 'q' }]);
      expect(result.dashboard.layout.items).toEqual({ 'tile-1': { span: 3, height: 'medium' } });
    }
  });

  it('fails for a missing query and for a duplicate default instance', () => {
    const missing = run(draft(), { type: 'add-query', queryId: 'gone' }, [query('q')]);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.diagnostics[0].code).toBe('dashboard-command-query-missing');

    const existing = draft({ tiles: [{ id: 't1', queryId: 'q' }] as never });
    const dup = run(existing, { type: 'add-query', queryId: 'q' }, [query('q')]);
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.diagnostics[0].code).toBe('dashboard-command-duplicate-instance');
  });

  it('add-query-instance allows a second instance and carries a variant, without a placement when there is no hint', () => {
    const existing = draft({ tiles: [{ id: 't1', queryId: 'q' }] as never });
    const result = run(existing, { type: 'add-query-instance', queryId: 'q', variant: 'alt' }, [query('q')]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.dashboard.tiles).toHaveLength(2);
      expect(result.dashboard.tiles[1]).toEqual({ id: 'tile-1', queryId: 'q', presentation: { variant: 'alt' } });
      expect(result.dashboard.layout.items).toEqual({});
    }
  });
});

describe('applyCommand — remove / move', () => {
  const seeded = () => draft({
    tiles: [{ id: 'a', queryId: 'q' }, { id: 'b', queryId: 'q' }, { id: 'c', queryId: 'q' }] as never,
    layout: { type: 'flow', version: 1, preset: 'full-width', items: { a: {}, b: {} } } as never,
  });

  it('removes a tile and fails for a missing one', () => {
    const result = run(seeded(), { type: 'remove-tile', tileId: 'b' }, [query('q')]);
    expect(result.ok && result.dashboard.tiles.map((t) => (t as { id: string }).id)).toEqual(['a', 'c']);
    const missing = run(seeded(), { type: 'remove-tile', tileId: 'z' }, [query('q')]);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.diagnostics[0].code).toBe('dashboard-command-tile-missing');
  });

  it('moves a tile to an index and never clamps an out-of-range index', () => {
    const moved = run(seeded(), { type: 'move-tile', tileId: 'a', toIndex: 2 }, [query('q')]);
    expect(moved.ok && moved.dashboard.tiles.map((t) => (t as { id: string }).id)).toEqual(['b', 'c', 'a']);

    for (const toIndex of [-1, 3, 1.5]) {
      const bad = run(seeded(), { type: 'move-tile', tileId: 'a', toIndex }, [query('q')]);
      expect(bad.ok).toBe(false);
      if (!bad.ok) expect(bad.diagnostics[0].code).toBe('dashboard-command-index-out-of-range');
    }
    const missing = run(seeded(), { type: 'move-tile', tileId: 'z', toIndex: 0 }, [query('q')]);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.diagnostics[0].code).toBe('dashboard-command-tile-missing');
  });
});

describe('applyCommand — update-tile', () => {
  const seeded = () => draft({ tiles: [{ id: 't1', queryId: 'q', title: 'old' }] as never });

  it('applies a merge patch and deletes members set to null', () => {
    const result = run(seeded(), { type: 'update-tile', tileId: 't1', patch: { title: 'new', description: 'd' } }, [query('q')]);
    expect(result.ok && result.dashboard.tiles[0]).toEqual({ id: 't1', queryId: 'q', title: 'new', description: 'd' });
    const cleared = run(seeded(), { type: 'update-tile', tileId: 't1', patch: { title: null } }, [query('q')]);
    expect(cleared.ok && cleared.dashboard.tiles[0]).toEqual({ id: 't1', queryId: 'q' });
  });

  const seededPres = () => draft({
    tiles: [{ id: 't1', queryId: 'q', presentation: { variant: 'alt', override: { cfg: { y: [0], series: null } } } }] as never,
  });

  it('merges presentation one level: setting variant preserves the override verbatim (nested nulls kept)', () => {
    const result = run(seededPres(), { type: 'update-tile', tileId: 't1', patch: { presentation: { variant: 'other' } } }, [query('q')]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.dashboard.tiles[0]).toEqual({
        id: 't1', queryId: 'q', presentation: { variant: 'other', override: { cfg: { y: [0], series: null } } },
      });
    }
  });

  it('clears only the override sub-field with presentation.override:null, leaving the variant', () => {
    const result = run(seededPres(), { type: 'update-tile', tileId: 't1', patch: { presentation: { override: null } } }, [query('q')]);
    expect(result.ok && result.dashboard.tiles[0]).toEqual({ id: 't1', queryId: 'q', presentation: { variant: 'alt' } });
  });

  it('clears the whole presentation field with presentation:null and replaces a non-object presentation wholesale', () => {
    const cleared = run(seededPres(), { type: 'update-tile', tileId: 't1', patch: { presentation: null } }, [query('q')]);
    expect(cleared.ok && cleared.dashboard.tiles[0]).toEqual({ id: 't1', queryId: 'q' });
    const replaced = run(seededPres(), { type: 'update-tile', tileId: 't1', patch: { presentation: ['x'] as never } }, [query('q')]);
    expect(replaced.ok && (replaced.dashboard.tiles[0] as { presentation: unknown }).presentation).toEqual(['x']);
  });

  it('fails for a missing tile, a non-object patch, or a patch touching identity', () => {
    const missing = run(seeded(), { type: 'update-tile', tileId: 'z', patch: {} }, [query('q')]);
    expect(missing.ok).toBe(false);
    const notObject = run(seeded(), { type: 'update-tile', tileId: 't1', patch: 5 as never }, [query('q')]);
    expect(notObject.ok).toBe(false);
    if (!notObject.ok) expect(notObject.diagnostics[0].code).toBe('dashboard-command-invalid-patch');
    const identity = run(seeded(), { type: 'update-tile', tileId: 't1', patch: { queryId: 'other' } }, [query('q')]);
    expect(identity.ok).toBe(false);
    if (!identity.ok) expect(identity.diagnostics[0].message).toContain('id or queryId');
  });
});

describe('applyCommand — update-placement / change-layout', () => {
  const seeded = () => draft({ tiles: [{ id: 't1', queryId: 'q' }] as never });

  it('sets a valid placement and rejects an invalid one', () => {
    const ok = run(seeded(), { type: 'update-placement', tileId: 't1', placement: { span: 2 } }, [query('q')]);
    expect(ok.ok && ok.dashboard.layout.items).toEqual({ t1: { span: 2 } });
    const bad = run(seeded(), { type: 'update-placement', tileId: 't1', placement: { span: 9 } }, [query('q')]);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.diagnostics[0].code).toBe('layout-placement-invalid-span');
    const missing = run(seeded(), { type: 'update-placement', tileId: 'z', placement: {} }, [query('q')]);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.diagnostics[0].code).toBe('dashboard-command-tile-missing');
  });

  it('installs a new layout document', () => {
    const layout = { type: 'flow', version: 1, preset: 'columns-2', items: {} } as never;
    const result = run(seeded(), { type: 'change-layout', layout }, [query('q')]);
    expect(result.ok && result.dashboard.layout.preset).toBe('columns-2');
  });
});

describe('applyCommand — isolation', () => {
  it('never mutates the input draft', () => {
    const input = draft({ tiles: [{ id: 't1', queryId: 'q' }] as never });
    const before = JSON.stringify(input);
    run(input, { type: 'remove-tile', tileId: 't1' }, [query('q')]);
    run(input, { type: 'update-tile', tileId: 't1', patch: { title: 'x' } }, [query('q')]);
    expect(JSON.stringify(input)).toBe(before);
  });
});
