import { describe, expect, it } from 'vitest';
import {
  assignDedicatedOwnership, deriveOwnedQueryId, migrateStoredWorkspaceV3ToV4,
  OWNED_QUERY_ID_PREFIX,
} from '../../src/workspace/stored-workspace-ownership.js';
import { buildQueryOwnershipIndex } from '../../src/dashboard/model/query-ownership.js';
import { queryContentKey } from '../../src/core/saved-query.js';
import type {
  DashboardDocumentV1, QuerySpecV1, SavedQueryV2, StoredWorkspaceV3,
} from '../../src/generated/json-schema.types.js';

const query = (id: string, spec: Partial<QuerySpecV1> = {}): SavedQueryV2 => ({
  id, sql: `SELECT ${id}`, specVersion: 1, spec: { name: id.toUpperCase(), ...spec } as QuerySpecV1,
});

const dash = (id: string, over: Partial<DashboardDocumentV1> = {}): DashboardDocumentV1 => ({
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
  const member = {
    sourceQueryId: 'p1', dashboardId: 'exec', role: 'panel' as const, memberId: 't1',
  };

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
      deriveOwnedQueryId({ ...member, role: 'filter' }, new Set()),
      deriveOwnedQueryId({ ...member, memberId: 't2' }, new Set()),
    ]);
    expect(ids.size).toBe(5);
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

describe('migrateStoredWorkspaceV3ToV4', () => {
  it('gives one dedicated copy to every member and keeps every original in the Library', () => {
    // The pre-#427 shape the favourite star produced: one Library query, tiled.
    const migrated = migrateStoredWorkspaceV3ToV4(v3(
      [query('p1', { favorite: true })],
      [dash('d1', { tiles: [{ id: 't1', queryId: 'p1' }] })],
    ));
    expect(migrated.storageVersion).toBe(4);
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
    const migrated = migrateStoredWorkspaceV3ToV4(v3(
      [query('a'), query('b')],
      [dash('d1', { tiles: [{ id: 't1', queryId: 'a' }, { id: 't2', queryId: 'b' }] })],
    ));
    expect(migrated.queries).toHaveLength(4);
    expect([...buildQueryOwnershipIndex(migrated).libraryQueryIds]).toEqual(['a', 'b']);
    expect(ownedIds(migrated)).toHaveLength(2);
  });

  it('splits a query shared by two Dashboards into two independent copies', () => {
    const migrated = migrateStoredWorkspaceV3ToV4(v3(
      [query('p1')],
      [
        dash('exec', { tiles: [{ id: 'exec-t', queryId: 'p1' }] }),
        dash('sales', { tiles: [{ id: 'sales-t', queryId: 'p1' }] }),
      ],
    ));
    const [exec, sales] = migrated.dashboards;
    expect(exec.tiles[0].queryId).not.toBe(sales.tiles[0].queryId);
    expect(migrated.queries).toHaveLength(3);
    for (const owners of buildQueryOwnershipIndex(migrated).ownersByQueryId.values()) {
      expect(owners).toHaveLength(1);
    }
  });

  it('splits a panel and a curated filter that shared one query, giving each its ROLE', () => {
    const migrated = migrateStoredWorkspaceV3ToV4(v3(
      [query('shared')],
      [dash('d1', {
        tiles: [{ id: 't1', queryId: 'shared' }],
        filters: [{ id: 'f1', parameter: 'p', sourceQueryId: 'shared' }],
      })],
    ));
    const [dashboard] = migrated.dashboards;
    const panelCopy = migrated.queries.find((q) => q.id === dashboard.tiles[0].queryId)!;
    const filterCopy = migrated.queries.find((q) => q.id === dashboard.filters[0].sourceQueryId)!;
    expect(panelCopy.spec.dashboard).toEqual({ role: 'panel' });
    expect(filterCopy.spec.dashboard).toEqual({ role: 'filter' });
    expect(panelCopy.id).not.toBe(filterCopy.id);
  });

  it('preserves SQL, spec version, presentation, variants and unknown fields on the copy', () => {
    const source = query('rich', {
      description: 'kept',
      view: 'panel',
      panel: { cfg: { type: 'timeseries' } },
      dashboard: { role: 'panel', variants: { small: { view: 'table' } } },
      futureThing: { nested: [1, 2] },
    } as unknown as Partial<QuerySpecV1>);
    const migrated = migrateStoredWorkspaceV3ToV4(v3(
      [source], [dash('d1', { tiles: [{ id: 't1', queryId: 'rich' }] })],
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

  it('preserves member ids, order, layout and revisions, and never mutates its input', () => {
    const source = v3(
      [query('a'), query('b')],
      [
        dash('second', {
          revision: 9,
          tiles: [{ id: 't-b', queryId: 'b' }],
          layout: { type: 'flow', version: 1, preset: 'columns-2', items: { 't-b': {} } },
        }),
        dash('first', {
          revision: 4,
          tiles: [{ id: 't-a', queryId: 'a' }],
          filters: [{ id: 'flt', parameter: 'p' }],
        }),
      ],
    );
    const before = JSON.parse(JSON.stringify(source));
    const migrated = migrateStoredWorkspaceV3ToV4(source);
    // Dashboard order and identity, member ids, layout and revisions: untouched.
    expect(migrated.dashboards.map((d) => d.id)).toEqual(['second', 'first']);
    expect(migrated.dashboards.map((d) => d.revision)).toEqual([9, 4]);
    expect(migrated.dashboards[0].tiles[0].id).toBe('t-b');
    expect(migrated.dashboards[0].layout).toEqual(before.dashboards[0].layout);
    expect(migrated.dashboards[1].filters).toEqual([{ id: 'flt', parameter: 'p' }]);
    // Workspace identity too.
    expect(migrated.id).toBe('w1');
    expect(migrated.key).toBe('workspace');
    expect(migrated.name).toBe('W');
    expect(source).toEqual(before);
  });

  it('is idempotent: a second pass over its own output clones nothing', () => {
    const once = migrateStoredWorkspaceV3ToV4(v3(
      [query('p1'), query('f1', { dashboard: { role: 'filter' } })],
      [dash('d1', {
        tiles: [{ id: 't1', queryId: 'p1' }],
        filters: [{ id: 'flt', parameter: 'p', sourceQueryId: 'f1' }],
      })],
    ));
    // By CONTENT, not merely by version: re-running the transform recognizes the
    // copies it minted as already dedicated.
    const again = assignDedicatedOwnership({ queries: once.queries, dashboards: once.dashboards });
    expect(again.clonedCount).toBe(0);
    expect(again.queries).toEqual(once.queries);
    expect(again.dashboards).toEqual(once.dashboards);
  });

  it('leaves a plain filter alone — it owns nothing', () => {
    const migrated = migrateStoredWorkspaceV3ToV4(v3(
      [query('p1')],
      [dash('d1', {
        filters: [{ id: 'from', parameter: 'from' }, { id: 'to', parameter: 'to' }],
      })],
    ));
    expect(migrated.queries).toHaveLength(1);
    expect(migrated.dashboards[0].filters).toEqual([
      { id: 'from', parameter: 'from' }, { id: 'to', parameter: 'to' },
    ]);
  });

  // #427 requires a fixture for EVERY source-less filter shape the app supports
  // today, before the migration is finalized. These are the real ones, taken from
  // the shipped bundles: 4 From/To pairs, a free-text `search`, and 2 `catalog`
  // selectors across `clickhouse-operations`, `ontime-charts`, `shop-charts`,
  // `iceberg-dba-dashboard` and `iceberg-catalog-dashboard` — 11 in all. None has
  // an option list, so none has a lossless source query to derive, and #427
  // forbids inventing SQL or dropping the filter. They migrate untouched.
  it('migrates every shipped source-less filter shape without inventing a source', () => {
    const shapes = [
      // A From/To time-range pair — `core/time-range.ts` only pairs filters with
      // NO source, so a curated one could never form a range.
      { id: 'ops-from', parameter: 'from' },
      { id: 'ops-to', parameter: 'to' },
      // A free-text search box.
      { id: 'ops-search', parameter: 'search' },
      // A scalar selector with a default and an active flag.
      { id: 'filter-catalog', parameter: 'catalog', defaultValue: 'main', defaultActive: true },
      // A labelled one with explicit targets.
      { id: 'shop-from', parameter: 'from', label: 'From', targets: ['t1'] },
    ];
    const migrated = migrateStoredWorkspaceV3ToV4(v3(
      [query('p1')],
      [dash('d1', { tiles: [{ id: 't1', queryId: 'p1' }], filters: shapes })],
    ));
    // Every filter comes through byte-identical, and only the TILE was cloned.
    expect(migrated.dashboards[0].filters).toEqual(shapes);
    expect(migrated.queries).toHaveLength(2);
    expect(ownedIds(migrated)).toHaveLength(1);
  });

  it('leaves a DANGLING reference alone rather than inventing a query for it', () => {
    const migrated = migrateStoredWorkspaceV3ToV4(v3(
      [], [dash('d1', {
        tiles: [{ id: 't1', queryId: 'gone' }],
        filters: [{ id: 'f1', parameter: 'p', sourceQueryId: 'also-gone' }],
      })],
    ));
    expect(migrated.queries).toEqual([]);
    expect(migrated.dashboards[0].tiles[0].queryId).toBe('gone');
    expect(migrated.dashboards[0].filters[0].sourceQueryId).toBe('also-gone');
  });

  it('refuses to clone a SETUP-role source, leaving the reference to be diagnosed', () => {
    // #427 rejects setup owners. Cloning one into a panel role would hide the
    // error behind an invented member.
    const migrated = migrateStoredWorkspaceV3ToV4(v3(
      [query('s1', { dashboard: { role: 'setup' } })],
      [dash('d1', { tiles: [{ id: 't1', queryId: 's1' }] })],
    ));
    expect(migrated.queries).toHaveLength(1);
    expect(migrated.dashboards[0].tiles[0].queryId).toBe('s1');
  });

  it('coerces a role-mismatched source to the OWNER role on the copy', () => {
    // A filter-role query behind a tile is invalid today, so such a workspace
    // cannot be opened at all. The copy takes the owner's role, which repairs it
    // while the original keeps its own role in the Library.
    const migrated = migrateStoredWorkspaceV3ToV4(v3(
      [query('f1', { dashboard: { role: 'filter' } })],
      [dash('d1', { tiles: [{ id: 't1', queryId: 'f1' }] })],
    ));
    expect(migrated.queries[0].spec.dashboard).toEqual({ role: 'filter' });
    expect(migrated.queries[1].spec.dashboard).toEqual({ role: 'panel' });
  });

  it('escalates a derived id that collides with a query already in the collection', () => {
    const collision = deriveOwnedQueryId(
      { sourceQueryId: 'p1', dashboardId: 'd1', role: 'panel', memberId: 't1' }, new Set(),
    );
    const migrated = migrateStoredWorkspaceV3ToV4(v3(
      // A query already sitting on the id the derivation would pick.
      [query('p1'), query(collision)],
      [dash('d1', { tiles: [{ id: 't1', queryId: 'p1' }] })],
    ));
    expect(migrated.dashboards[0].tiles[0].queryId).toBe(`${collision}-2`);
    // Deterministic, so a second decode of the same record agrees.
    expect(migrateStoredWorkspaceV3ToV4(v3(
      [query('p1'), query(collision)],
      [dash('d1', { tiles: [{ id: 't1', queryId: 'p1' }] })],
    ))).toEqual(migrated);
  });

  it('recognizes content-identical dedicated copies without cloning again', () => {
    // A hand-authored V3 document that already follows the dedicated pattern: a
    // Library source plus one copy per member, content-identical modulo id.
    const source = query('lib');
    const existingCopy = {
      ...source, id: 'already-owned', spec: { ...source.spec, dashboard: { role: 'panel' } },
    } as SavedQueryV2;
    expect(queryContentKey(existingCopy)).not.toBe(queryContentKey(source));
    const migrated = migrateStoredWorkspaceV3ToV4(v3(
      [source, existingCopy],
      [dash('d1', { tiles: [{ id: 't1', queryId: 'already-owned' }] })],
    ));
    expect(migrated.queries).toHaveLength(2);
    expect(migrated.dashboards[0].tiles[0].queryId).toBe('already-owned');
  });

  it('does NOT treat a copy as dedicated when it belongs to a different member', () => {
    const source = query('lib');
    const copy = {
      ...source, id: 'copy', spec: { ...source.spec, dashboard: { role: 'panel' } },
    } as SavedQueryV2;
    // `copy` is referenced by TWO tiles, so it has two owners — not a dedicated
    // copy of anything, and both references must be re-homed.
    const migrated = migrateStoredWorkspaceV3ToV4(v3(
      [source, copy],
      [dash('d1', { tiles: [{ id: 't1', queryId: 'copy' }, { id: 't2', queryId: 'copy' }] })],
    ));
    expect(migrated.queries).toHaveLength(4);
    const [t1, t2] = migrated.dashboards[0].tiles;
    expect(t1.queryId).not.toBe(t2.queryId);
    expect(t1.queryId).not.toBe('copy');
  });

  it('does not treat a copy as dedicated when the member role differs', () => {
    // The copy carries role `panel`, but the member referencing it is a FILTER,
    // so it is not what a dedicated copy for that member would look like.
    const source = query('lib', { dashboard: { role: 'filter' } });
    const copy = {
      ...source, id: 'copy', spec: { ...source.spec, dashboard: { role: 'panel' } },
    } as SavedQueryV2;
    const migrated = migrateStoredWorkspaceV3ToV4(v3(
      [source, copy],
      [dash('d1', { filters: [{ id: 'f1', parameter: 'p', sourceQueryId: 'copy' }] })],
    ));
    expect(migrated.queries).toHaveLength(3);
    expect(migrated.dashboards[0].filters[0].sourceQueryId).not.toBe('copy');
  });

  it('migrates an empty workspace to an empty V4 workspace', () => {
    expect(migrateStoredWorkspaceV3ToV4(v3([], []))).toEqual({
      storageVersion: 4, id: 'w1', key: 'workspace', name: 'W', queries: [], dashboards: [],
    });
  });
});

describe('assignDedicatedOwnership — scope', () => {
  const workspace = () => ({
    queries: [query('p1'), query('p2')],
    dashboards: [
      dash('target', { tiles: [{ id: 't1', queryId: 'p1' }] }),
      dash('other', { revision: 12, tiles: [{ id: 't2', queryId: 'p2' }] }),
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
        dash('target', { tiles: [{ id: 't1', queryId: 'p2' }] }),
        dash('other', { tiles: [{ id: 't2', queryId: 'p2' }] }),
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
