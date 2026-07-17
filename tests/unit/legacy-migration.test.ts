import { describe, expect, it } from 'vitest';
import {
  buildLegacyMigrationCandidate, legacyLayoutToFlowPreset, migrateLegacyWorkspaceIfNeeded,
} from '../../src/workspace/legacy-migration.js';
import type { LegacyWorkspaceInput } from '../../src/workspace/legacy-migration.js';
import { createWorkspaceRepository } from '../../src/workspace/workspace-repository.js';
import type { WorkspaceStore } from '../../src/workspace/workspace-store.types.js';
import { validateStoredWorkspaceDocument } from '../../src/workspace/stored-workspace.js';
import type { SavedQueryV2 } from '../../src/generated/json-schema.types.js';

function memStore(initial: string | null = null) {
  let value = initial;
  const store: WorkspaceStore & { readonly value: string | null } = {
    read: async () => value,
    write: async (t: string) => { value = t; },
    clear: async () => { value = null; },
    get value() { return value; },
  };
  return store;
}
const counter = () => { let n = 0; return () => `id-${++n}`; };

const query = (id: string, over: { favorite?: boolean; role?: string } = {}): SavedQueryV2 => ({
  id, sql: 'SELECT 1', specVersion: 1,
  spec: {
    name: id,
    ...(over.favorite === undefined ? {} : { favorite: over.favorite }),
    panel: { cfg: { type: 'bar', x: 0, y: [1] } },
    ...(over.role === undefined ? {} : { dashboard: { role: over.role as 'panel' | 'filter' | 'setup' } }),
  },
});
const legacy = (over: Partial<LegacyWorkspaceInput> = {}): LegacyWorkspaceInput => ({
  name: 'My Library', queries: [], dashLayout: 'arrange', dashCols: 3, ...over,
});

describe('legacyLayoutToFlowPreset', () => {
  it('maps every legacy layout preference to a normative flow@1 preset', () => {
    expect(legacyLayoutToFlowPreset('wide', 3)).toBe('full-width');
    expect(legacyLayoutToFlowPreset('report', 3)).toBe('report');
    expect(legacyLayoutToFlowPreset('arrange', 2)).toBe('columns-2');
    expect(legacyLayoutToFlowPreset('arrange', 3)).toBe('columns-3');
  });
});

describe('buildLegacyMigrationCandidate', () => {
  it('builds a valid aggregate: queries preserved, Dashboard tiles from PANEL favorites in catalog order', () => {
    const candidate = buildLegacyMigrationCandidate(legacy({
      dashLayout: 'wide',
      queries: [
        query('fav1', { favorite: true }),
        query('plain'),
        query('fav2', { favorite: true }),
      ],
    }), counter());
    expect(validateStoredWorkspaceDocument(candidate)).toEqual([]);
    expect(candidate.storageVersion).toBe(1);
    expect(candidate.id).toBe('id-1');
    expect(candidate.name).toBe('My Library');
    expect(candidate.queries.map((q) => q.id)).toEqual(['fav1', 'plain', 'fav2']);
    const dash = candidate.dashboard!;
    expect(dash.id).toBe('id-2');
    expect(dash.title).toBe('My Library');
    expect(dash.revision).toBe(1);
    expect(dash.layout).toEqual({ type: 'flow', version: 1, preset: 'full-width', items: {} });
    // Only the two favorites became tiles, in catalog order, each with a fresh ID.
    expect(dash.tiles).toEqual([
      { id: 'id-3', queryId: 'fav1' },
      { id: 'id-4', queryId: 'fav2' },
    ]);
  });

  it('never turns a favorited filter/setup-role query into a tile', () => {
    const candidate = buildLegacyMigrationCandidate(legacy({
      queries: [
        query('panelFav', { favorite: true }),
        query('filterFav', { favorite: true, role: 'filter' }),
        query('setupFav', { favorite: true, role: 'setup' }),
      ],
    }), counter());
    expect(candidate.dashboard!.tiles.map((t) => t.queryId)).toEqual(['panelFav']);
    // The non-panel favorites stay in the query collection.
    expect(candidate.queries.map((q) => q.id)).toEqual(['panelFav', 'filterFav', 'setupFav']);
  });

  it('creates an empty Dashboard (preserving the layout preference) when there are no favorites', () => {
    const candidate = buildLegacyMigrationCandidate(legacy({
      dashLayout: 'arrange', dashCols: 2, queries: [query('a')],
    }), counter());
    expect(candidate.dashboard!.tiles).toEqual([]);
    expect(candidate.dashboard!.layout.preset).toBe('columns-2');
  });

  it('falls back to the default workspace name for a blank Library name', () => {
    const candidate = buildLegacyMigrationCandidate(legacy({ name: '   ' }), counter());
    expect(candidate.name).toBe('SQL Library');
    expect(candidate.dashboard!.title).toBe('SQL Library');
  });
});

describe('migrateLegacyWorkspaceIfNeeded', () => {
  const run = (store: WorkspaceStore, over: Partial<LegacyWorkspaceInput> = {}) => {
    const repository = createWorkspaceRepository({ store });
    return migrateLegacyWorkspaceIfNeeded({ store, repository, legacy: legacy(over), genId: counter() });
  };

  it('skips when an aggregate record already exists (marker = record existence)', async () => {
    const store = memStore('{"storageVersion":1,"already":"here"}');
    const outcome = await run(store, { queries: [query('f', { favorite: true })] });
    expect(outcome).toEqual({ migrated: false, reason: 'aggregate-exists' });
    // Existing record untouched — not overwritten by a re-migration.
    expect(store.value).toBe('{"storageVersion":1,"already":"here"}');
  });

  it('runs once when no aggregate exists, persisting one atomic aggregate', async () => {
    const store = memStore(null);
    const outcome = await run(store, { queries: [query('f', { favorite: true })] });
    expect(outcome.migrated).toBe(true);
    if (!outcome.migrated) throw new Error('unreachable');
    expect(outcome.result.workspace.dashboard!.tiles.map((t) => t.queryId)).toEqual(['f']);
    expect(outcome.result.dashboardRevision).toBe(1);
    expect(store.value).not.toBeNull();

    // Idempotent: a second run finds the record and skips.
    const again = await migrateLegacyWorkspaceIfNeeded({
      store, repository: createWorkspaceRepository({ store }),
      legacy: legacy(), genId: counter(),
    });
    expect(again).toEqual({ migrated: false, reason: 'aggregate-exists' });
  });

  it('fails with diagnostics and leaves the store untouched when the candidate is invalid', async () => {
    const store = memStore(null);
    // Two queries with the same ID make the whole-workspace validation fail.
    const outcome = await run(store, {
      queries: [query('dup', { favorite: true }), query('dup', { favorite: true })],
    });
    expect(outcome.migrated).toBe(false);
    if (outcome.migrated || outcome.reason !== 'commit-failed') throw new Error('expected commit-failed');
    expect(outcome.diagnostics.some((d) => d.code === 'workspace-duplicate-query-id')).toBe(true);
    expect(store.value).toBeNull(); // legacy keys/store untouched — safe to retry
  });
});
