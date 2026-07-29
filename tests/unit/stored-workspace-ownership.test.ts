import { describe, expect, it } from 'vitest';
import {
  assignDedicatedOwnership, deriveOwnedQueryId, dropCuratedFilters, migrateStoredWorkspaceV3ToV5,
  OWNED_QUERY_ID_PREFIX,
} from '../../src/workspace/stored-workspace-ownership.js';
import { buildQueryOwnershipIndex } from '../../src/dashboard/model/query-ownership.js';
import type {
  DashboardDocumentV1, DashboardDocumentV2, QuerySpecV1, SavedQueryV2, StoredWorkspaceV3,
} from '../../src/generated/json-schema.types.js';

const query = (id: string, spec: Partial<QuerySpecV1> = {}): SavedQueryV2 => ({
  id, sql: `SELECT ${id}`, specVersion: 1, spec: { name: id.toUpperCase(), ...spec } as QuerySpecV1,
});

/** Legacy Dashboard document v1 (curated filters) — the shape a stored V3
 *  record (and the pre-#447 half of the migration pipeline) still carries. */
const dashV1 = (id: string, over: Partial<DashboardDocumentV1> = {}): DashboardDocumentV1 => ({
  documentVersion: 1, id, title: id.toUpperCase(), revision: 1,
  layout: { type: 'flow', version: 1, preset: 'report', items: {} },
  filters: [], tiles: [], ...over,
} as DashboardDocumentV1);

const v3 = (
  queries: readonly SavedQueryV2[], dashboards: readonly DashboardDocumentV1[],
): StoredWorkspaceV3 => ({
  storageVersion: 3, id: 'w1', key: 'workspace', name: 'W',
  queries: queries as SavedQueryV2[], dashboards: dashboards as DashboardDocumentV1[],
});

const ownedIds = (workspace: { queries: readonly SavedQueryV2[] }): string[] =>
  workspace.queries.map((q) => q.id).filter((id) => id.startsWith(OWNED_QUERY_ID_PREFIX));

describe('deriveOwnedQueryId', () => {
  const member = { sourceQueryId: 'p1', dashboardId: 'exec', memberId: 't1' };

  it('is a pure function of the member, stable across calls', () => {
    const first = deriveOwnedQueryId(member, new Set());
    expect(first).toBe(deriveOwnedQueryId({ ...member }, new Set()));
    expect(first.startsWith(OWNED_QUERY_ID_PREFIX)).toBe(true);
    // Bounded length: a query id is capped at 256 chars, which a composite of
    // three ids would not respect.
    expect(first.length).toBeLessThan(24);
  });

  it('changes when ANY part of the member changes', () => {
    const ids = new Set([
      deriveOwnedQueryId(member, new Set()),
      deriveOwnedQueryId({ ...member, sourceQueryId: 'p2' }, new Set()),
      deriveOwnedQueryId({ ...member, dashboardId: 'sales' }, new Set()),
      deriveOwnedQueryId({ ...member, memberId: 't2' }, new Set()),
    ]);
    expect(ids.size).toBe(4);
  });

  it('cannot be forged by an id containing the separator', () => {
    // Length-prefixed composition: `a|b` and `a` + `|b` are different tuples.
    expect(deriveOwnedQueryId({ ...member, sourceQueryId: 'p1|exec' }, new Set()))
      .not.toBe(deriveOwnedQueryId({ ...member, sourceQueryId: 'p1', dashboardId: '|exec' }, new Set()));
  });

  it('escalates deterministically against ids already taken', () => {
    const base = deriveOwnedQueryId(member, new Set());
    expect(deriveOwnedQueryId(member, new Set([base]))).toBe(`${base}-2`);
    expect(deriveOwnedQueryId(member, new Set([base, `${base}-2`]))).toBe(`${base}-3`);
    // Deterministic: the same taken set always yields the same escalation.
    expect(deriveOwnedQueryId(member, new Set([base, `${base}-2`]))).toBe(`${base}-3`);
  });
});

describe('dropCuratedFilters', () => {
  it('removes filters and bumps documentVersion to 2, preserving everything else', () => {
    const dashboard = dashV1('d1', {
      title: 'Analytics', revision: 4, description: 'kept',
      tiles: [{ id: 't1', queryId: 'p1' }],
      layout: {
        type: 'grafana-grid', version: 2, preset: 'report', items: {},
        fallback: {
          type: 'flow', version: 1, preset: 'report',
          items: { t1: { span: 1, height: 'large' } },
        },
      },
      filters: [{ id: 'flt', parameter: 'country' }],
    });
    const result = dropCuratedFilters(dashboard);
    expect(result).toEqual({
      documentVersion: 2, id: 'd1', title: 'Analytics', revision: 4, description: 'kept',
      layout: {
        type: 'grafana-grid', version: 2, preset: 'report', items: {},
        fallback: {
          type: 'flow', version: 1, preset: 'report',
          items: { t1: { span: 1, height: 'large' } },
        },
      },
      tiles: [{ id: 't1', queryId: 'p1' }],
    });
    expect(result).not.toHaveProperty('filters');
  });

  it('never mutates its input', () => {
    const dashboard = dashV1('d1', { filters: [{ id: 'flt', parameter: 'p' }] });
    const before = JSON.parse(JSON.stringify(dashboard));
    dropCuratedFilters(dashboard);
    expect(dashboard).toEqual(before);
  });

  it('drops filters even when there are none to drop', () => {
    const dashboard = dashV1('d1', { filters: [] });
    expect(dropCuratedFilters(dashboard)).toEqual({
      documentVersion: 2, id: 'd1', title: 'D1', revision: 1,
      layout: {
        type: 'grafana-grid', version: 2, preset: 'report', items: {},
        fallback: { type: 'flow', version: 1, preset: 'report', items: {} },
      },
      tiles: [],
    });
  });
});

describe('migrateStoredWorkspaceV3ToV5', () => {
  it('gives one dedicated copy to every member and keeps every original in the Library', () => {
    // The pre-#427 shape the favourite star produced: one Library query, tiled.
    const migrated = migrateStoredWorkspaceV3ToV5(v3(
      [query('p1', { favorite: true })],
      [dashV1('d1', { tiles: [{ id: 't1', queryId: 'p1' }] })],
    ));
    expect(migrated.storageVersion).toBe(5);
    expect(migrated.queries).toHaveLength(2);
    // The original is untouched, favourite included — it is a Library
    // preference now, and it belongs to the source, not the copy.
    expect(migrated.queries[0]).toEqual(query('p1', { favorite: true }));
    const clone = migrated.queries[1];
    expect(clone.id).toBe(migrated.dashboards[0].tiles[0].queryId);
    expect(clone.sql).toBe('SELECT p1');
    expect(clone.spec.dashboard).toEqual({ role: 'panel' });
    expect(Object.hasOwn(clone.spec, 'favorite')).toBe(false);

    const index = buildQueryOwnershipIndex(migrated);
    expect([...index.libraryQueryIds]).toEqual(['p1']);
    expect([...index.dashboardOwnedQueryIds]).toEqual([clone.id]);
  });

  it('clones EVERY owner, even when each query already has exactly one', () => {
    // The real shape of `examples/iceberg-catalog-dashboard.json`: every query
    // referenced by exactly one tile. A "skip when there is only one owner"
    // shortcut would leave this workspace with an EMPTY Library.
    const migrated = migrateStoredWorkspaceV3ToV5(v3(
      [query('a'), query('b')],
      [dashV1('d1', { tiles: [{ id: 't1', queryId: 'a' }, { id: 't2', queryId: 'b' }] })],
    ));
    expect(migrated.queries).toHaveLength(4);
    expect([...buildQueryOwnershipIndex(migrated).libraryQueryIds]).toEqual(['a', 'b']);
    expect(ownedIds(migrated)).toHaveLength(2);
  });

  it('splits a query shared by two Dashboards into two independent copies', () => {
    const migrated = migrateStoredWorkspaceV3ToV5(v3(
      [query('p1')],
      [
        dashV1('exec', { tiles: [{ id: 'exec-t', queryId: 'p1' }] }),
        dashV1('sales', { tiles: [{ id: 'sales-t', queryId: 'p1' }] }),
      ],
    ));
    const [exec, sales] = migrated.dashboards;
    expect(exec.tiles[0].queryId).not.toBe(sales.tiles[0].queryId);
    expect(migrated.queries).toHaveLength(3);
    for (const owners of buildQueryOwnershipIndex(migrated).ownersByQueryId.values()) {
      expect(owners).toHaveLength(1);
    }
  });

  it('preserves SQL, spec version, presentation, variants and unknown fields on the copy', () => {
    const source = query('rich', {
      description: 'kept',
      view: 'panel',
      panel: { cfg: { type: 'timeseries' } },
      dashboard: { role: 'panel', variants: { small: { view: 'table' } } },
      futureThing: { nested: [1, 2] },
    } as unknown as Partial<QuerySpecV1>);
    const migrated = migrateStoredWorkspaceV3ToV5(v3(
      [source], [dashV1('d1', { tiles: [{ id: 't1', queryId: 'rich' }] })],
    ));
    const clone = migrated.queries[1];
    expect(clone.sql).toBe('SELECT rich');
    expect(clone.specVersion).toBe(1);
    expect(clone.spec.description).toBe('kept');
    expect(clone.spec.view).toBe('panel');
    expect(clone.spec.panel).toEqual({ cfg: { type: 'timeseries' } });
    expect(clone.spec.dashboard).toEqual({ role: 'panel', variants: { small: { view: 'table' } } });
    expect((clone.spec as Record<string, unknown>).futureThing).toEqual({ nested: [1, 2] });
  });

  it('preserves member ids, order, layout and revisions, drops filters, and never mutates its input', () => {
    const source = v3(
      [query('a'), query('b')],
      [
        dashV1('second', {
          revision: 9,
          tiles: [{ id: 't-b', queryId: 'b' }],
          layout: { type: 'flow', version: 1, preset: 'columns-2', items: { 't-b': {} } },
        }),
        dashV1('first', {
          revision: 4,
          tiles: [{ id: 't-a', queryId: 'a' }],
          filters: [{ id: 'flt', parameter: 'p' }],
        }),
      ],
    );
    const before = JSON.parse(JSON.stringify(source));
    const migrated = migrateStoredWorkspaceV3ToV5(source);
    // Dashboard order and identity, member ids and revisions survive; layouts
    // normalize to the canonical authored-style engine.
    expect(migrated.dashboards.map((d) => d.id)).toEqual(['second', 'first']);
    expect(migrated.dashboards.map((d) => d.revision)).toEqual([9, 4]);
    expect(migrated.dashboards[0].tiles[0].id).toBe('t-b');
    expect(migrated.dashboards[0].layout).toEqual({
      type: 'grafana-grid', version: 2, preset: 'grid',
      items: { 't-b': { grid: { span: 4, height: 2 } } },
      fallback: {
        type: 'flow', version: 1, preset: 'columns-2',
        items: { 't-b': { span: 1, height: 'medium' } },
      },
    });
    // #447: filters are gone and every Dashboard is document v2.
    expect(migrated.dashboards[1]).not.toHaveProperty('filters');
    expect(migrated.dashboards.map((d) => d.documentVersion)).toEqual([2, 2]);
    // Workspace identity too.
    expect(migrated.id).toBe('w1');
    expect(migrated.key).toBe('workspace');
    expect(migrated.name).toBe('W');
    expect(source).toEqual(before);
  });

  it('is idempotent: a second pass over its own output clones nothing', () => {
    const once = migrateStoredWorkspaceV3ToV5(v3(
      [query('p1'), query('lib')],
      [dashV1('d1', { tiles: [{ id: 't1', queryId: 'p1' }] })],
    ));
    // By CONTENT, not merely by version: re-running the transform recognizes the
    // copies it minted as already dedicated.
    const again = assignDedicatedOwnership({ queries: once.queries, dashboards: once.dashboards });
    expect(again.clonedCount).toBe(0);
    expect(again.queries).toEqual(once.queries);
    expect(again.dashboards).toEqual(once.dashboards);
  });

  it('leaves a DANGLING tile reference alone rather than inventing a query for it', () => {
    const migrated = migrateStoredWorkspaceV3ToV5(v3(
      [], [dashV1('d1', { tiles: [{ id: 't1', queryId: 'gone' }] })],
    ));
    expect(migrated.queries).toEqual([]);
    expect(migrated.dashboards[0].tiles[0].queryId).toBe('gone');
  });

  it('refuses to clone a SETUP-role source, leaving the reference to be diagnosed', () => {
    // #427 rejects setup owners. Cloning one into a panel role would hide the
    // error behind an invented member.
    const migrated = migrateStoredWorkspaceV3ToV5(v3(
      [query('s1', { dashboard: { role: 'setup' } })],
      [dashV1('d1', { tiles: [{ id: 't1', queryId: 's1' }] })],
    ));
    expect(migrated.queries).toHaveLength(1);
    expect(migrated.dashboards[0].tiles[0].queryId).toBe('s1');
  });

  it('escalates a derived id that collides with a query already in the collection', () => {
    const collision = deriveOwnedQueryId(
      { sourceQueryId: 'p1', dashboardId: 'd1', memberId: 't1' }, new Set(),
    );
    const migrated = migrateStoredWorkspaceV3ToV5(v3(
      // A query already sitting on the id the derivation would pick.
      [query('p1'), query(collision)],
      [dashV1('d1', { tiles: [{ id: 't1', queryId: 'p1' }] })],
    ));
    expect(migrated.dashboards[0].tiles[0].queryId).toBe(`${collision}-2`);
    // Deterministic, so a second decode of the same record agrees.
    expect(migrateStoredWorkspaceV3ToV5(v3(
      [query('p1'), query(collision)],
      [dashV1('d1', { tiles: [{ id: 't1', queryId: 'p1' }] })],
    ))).toEqual(migrated);
  });

  it('recognizes a copy IT minted, by id marker, without cloning again', () => {
    // The marker (not content) is what makes recognition local and idempotent.
    const source = query('lib');
    const ownedId = deriveOwnedQueryId(
      { sourceQueryId: 'lib', dashboardId: 'd1', memberId: 't1' }, new Set(),
    );
    const existingCopy = {
      ...source, id: ownedId, spec: { ...source.spec, dashboard: { role: 'panel' } },
    } as SavedQueryV2;
    const migrated = migrateStoredWorkspaceV3ToV5(v3(
      [source, existingCopy],
      [dashV1('d1', { tiles: [{ id: 't1', queryId: ownedId }] })],
    ));
    expect(migrated.queries).toHaveLength(2);
    expect(migrated.dashboards[0].tiles[0].queryId).toBe(ownedId);
  });

  it('does NOT adopt an unmarked duplicate of a Library query', () => {
    // A user who saved the same query twice and tiled one copy must keep BOTH in
    // the Library: content identity is not evidence that a query is a copy.
    const source = query('dup-a');
    const twin = { ...source, id: 'dup-b' } as SavedQueryV2;
    const migrated = migrateStoredWorkspaceV3ToV5(v3(
      [source, twin], [dashV1('d1', { tiles: [{ id: 't1', queryId: 'dup-b' }] })],
    ));
    expect(migrated.queries).toHaveLength(3);
    expect([...buildQueryOwnershipIndex(migrated).libraryQueryIds]).toEqual(['dup-a', 'dup-b']);
    expect(migrated.dashboards[0].tiles[0].queryId).not.toBe('dup-b');
  });

  it('does NOT treat a copy as dedicated when it belongs to a different member', () => {
    const source = query('lib');
    const copy = {
      ...source, id: `${OWNED_QUERY_ID_PREFIX}cafebabe`, spec: { ...source.spec, dashboard: { role: 'panel' } },
    } as SavedQueryV2;
    // Marked, but referenced by TWO tiles — two panel owners is never a dedicated
    // copy, so both references must be re-homed.
    const migrated = migrateStoredWorkspaceV3ToV5(v3(
      [source, copy],
      [dashV1('d1', { tiles: [{ id: 't1', queryId: copy.id }, { id: 't2', queryId: copy.id }] })],
    ));
    expect(migrated.queries).toHaveLength(4);
    const [t1, t2] = migrated.dashboards[0].tiles;
    expect(t1.queryId).not.toBe(t2.queryId);
    expect(t1.queryId).not.toBe(copy.id);
  });

  it('migrates an empty workspace to an empty V5 workspace', () => {
    expect(migrateStoredWorkspaceV3ToV5(v3([], []))).toEqual({
      storageVersion: 5, id: 'w1', key: 'workspace', name: 'W', queries: [], dashboards: [],
    });
  });
});

describe('assignDedicatedOwnership — scope', () => {
  // assignDedicatedOwnership runs AFTER curated filters are dropped, so it only
  // ever walks document v2 Dashboards (#447).
  const dashV2 = (id: string, over: Partial<DashboardDocumentV2> = {}): DashboardDocumentV2 => ({
    documentVersion: 2, id, title: id.toUpperCase(), revision: 1,
    layout: { type: 'flow', version: 1, preset: 'report', items: {} },
    tiles: [], ...over,
  } as DashboardDocumentV2);

  const workspace = () => ({
    queries: [query('p1'), query('p2')],
    dashboards: [
      dashV2('target', { tiles: [{ id: 't1', queryId: 'p1' }] }),
      dashV2('other', { revision: 12, tiles: [{ id: 't2', queryId: 'p2' }] }),
    ],
  });

  it('rewrites only the Dashboards in scope, leaving the rest canonically identical', () => {
    const input = workspace();
    const untouched = JSON.parse(JSON.stringify(input.dashboards[1]));
    const result = assignDedicatedOwnership({ ...input, scope: new Set(['target']) });
    expect(result.clonedCount).toBe(1);
    expect(result.dashboards[0].tiles[0].queryId).not.toBe('p1');
    expect(result.dashboards[1]).toEqual(untouched);
    expect(result.dashboards[1].revision).toBe(12);
  });

  it('still READS ownership across every Dashboard, in or out of scope', () => {
    // `p2` is owned by the out-of-scope Dashboard. An in-scope member pointing at
    // it must still get its own copy rather than adopting a query that is
    // already owned elsewhere.
    const input = {
      queries: [query('p2')],
      dashboards: [
        dashV2('target', { tiles: [{ id: 't1', queryId: 'p2' }] }),
        dashV2('other', { tiles: [{ id: 't2', queryId: 'p2' }] }),
      ],
    };
    const result = assignDedicatedOwnership({ ...input, scope: new Set(['target']) });
    expect(result.dashboards[0].tiles[0].queryId).not.toBe('p2');
    expect(result.dashboards[1].tiles[0].queryId).toBe('p2');
  });

  it('an empty scope changes nothing at all', () => {
    const result = assignDedicatedOwnership({ ...workspace(), scope: new Set() });
    expect(result.clonedCount).toBe(0);
    expect(result.dashboards).toEqual(workspace().dashboards);
    expect(result.queries).toEqual(workspace().queries);
  });
});
