import { describe, it, expect } from 'vitest';
import {
  copyLibraryQueryToPanel, copyLibraryQuerySqlToVariable,
} from '../../src/dashboard/application/library-assignment.js';
import { savedQuery } from '../helpers/saved-query.js';
import type { DashboardDocumentV2, StoredWorkspaceV5 } from '../../src/generated/json-schema.types.js';

const dash = (id: string, over: Partial<DashboardDocumentV2> = {}): DashboardDocumentV2 => ({
  documentVersion: 2,
  id,
  title: id.toUpperCase(),
  revision: 1,
  layout: { type: 'flow', version: 1, preset: 'report', items: {} },
  tiles: [],
  ...over,
});

const ws = (over: Partial<StoredWorkspaceV5> = {}): StoredWorkspaceV5 => ({
  storageVersion: 5, id: 'w1', key: 'workspace', name: 'W',
  queries: [], dashboards: [], ...over,
});

/** A Library query: present in `queries`, referenced by no tile. */
const lib = savedQuery({
  id: 'q-lib', sql: 'SELECT country FROM t', name: 'Countries',
  description: 'the source', favorite: true,
});

const panelInput = {
  workspaceId: 'w1', sourceQueryId: 'q-lib', dashboardId: 'd1',
  newQueryId: 'q-new', newTileId: 't-new',
};

describe('copyLibraryQueryToPanel', () => {
  const base = () => ws({ queries: [lib], dashboards: [dash('d1')] });

  it('appends one owned clone and exactly one tile referencing it', () => {
    const result = copyLibraryQueryToPanel({ latest: base(), ...panelInput });
    if (!result.ok) throw new Error('expected ok, got ' + result.reason);

    expect(result.data).toEqual({ queryId: 'q-new', tileId: 't-new' });
    expect(result.workspace.queries.map((q) => q.id)).toEqual(['q-lib', 'q-new']);
    const tiles = result.workspace.dashboards[0].tiles;
    expect(tiles).toHaveLength(1);
    expect(tiles[0].id).toBe('t-new');
    expect(tiles[0].queryId).toBe('q-new');
  });

  it('writes no redundant tile title/description override (#428 step 9)', () => {
    const result = copyLibraryQueryToPanel({ latest: base(), ...panelInput });
    if (!result.ok) throw new Error('expected ok');
    // Exactly the two identity keys — anything else is state that would then
    // have to be kept in sync with the query it duplicates.
    expect(Object.keys(result.workspace.dashboards[0].tiles[0]).sort()).toEqual(['id', 'queryId']);
  });

  it('leaves the source untouched and still in the Library, favourite included', () => {
    const latest = base();
    const before = structuredClone(latest.queries[0]);
    const result = copyLibraryQueryToPanel({ latest, ...panelInput });
    if (!result.ok) throw new Error('expected ok');

    expect(result.workspace.queries[0]).toEqual(before);
    expect(result.workspace.queries[0].spec.favorite).toBe(true);
    // …and the input document was not mutated in place either.
    expect(latest.queries).toHaveLength(1);
    expect(latest.dashboards[0].tiles).toHaveLength(0);
  });

  it('preserves SQL, spec version, name, description and extension fields on the clone', () => {
    const rich = savedQuery({
      id: 'q-lib', sql: 'SELECT 1', name: 'Rich', description: 'desc',
      view: { mode: 'chart' } as never,
      dashboard: { sizeHints: { minWidth: 6 } } as never,
      extension: { keep: 'me' },
    });
    const result = copyLibraryQueryToPanel({
      latest: ws({ queries: [rich], dashboards: [dash('d1')] }), ...panelInput,
    });
    if (!result.ok) throw new Error('expected ok');

    const clone = result.workspace.queries[1];
    expect(clone.sql).toBe('SELECT 1');
    expect(clone.specVersion).toBe(rich.specVersion);
    expect(clone.spec.name).toBe('Rich');
    expect(clone.spec.description).toBe('desc');
    expect(clone.spec.view).toEqual({ mode: 'chart' });
    expect(clone.spec.extension).toEqual({ keep: 'me' });
  });

  it('gives the clone a new id and the panel role, and drops the favourite', () => {
    const result = copyLibraryQueryToPanel({ latest: base(), ...panelInput });
    if (!result.ok) throw new Error('expected ok');

    const clone = result.workspace.queries[1];
    expect(clone.id).toBe('q-new');
    expect(clone.spec.dashboard?.role).toBe('panel');
    // A favourite is a Library preference; a copy absent from the Library
    // could not express one (#427).
    expect(clone.spec.favorite).toBeUndefined();
  });

  it('seeds the new tile\'s placement from the source query\'s own size hints', () => {
    // This is why the transform goes through `applyCommand` rather than pushing
    // a tile: only the canonical add path reads `spec.dashboard.sizeHints`.
    const hinted = savedQuery({
      id: 'q-lib', sql: 'SELECT 1',
      dashboard: { sizeHints: { preferred: 'wide' } } as never,
    });
    const result = copyLibraryQueryToPanel({
      latest: ws({ queries: [hinted], dashboards: [dash('d1')] }), ...panelInput,
    });
    if (!result.ok) throw new Error('expected ok');

    const items = result.workspace.dashboards[0].layout.items as Record<string, unknown>;
    expect(items['t-new']).toEqual({ span: 3, height: 'medium' });
  });

  it('leaves a flow tile unplaced when the source expresses no size preference', () => {
    // flow@1's "no opinion" is a bare `undefined`, unlike grafana-grid@1, which
    // always writes its own default. Neither is a missing placement bug.
    const result = copyLibraryQueryToPanel({ latest: base(), ...panelInput });
    if (!result.ok) throw new Error('expected ok');
    expect(result.workspace.dashboards[0].layout.items).toEqual({});
  });

  it('regenerates the grafana-grid flow fallback', () => {
    const grid = dash('d1', {
      layout: { type: 'grafana-grid', version: 1, items: {} } as never,
    });
    const result = copyLibraryQueryToPanel({
      latest: ws({ queries: [lib], dashboards: [grid] }), ...panelInput,
    });
    if (!result.ok) throw new Error('expected ok');

    const layout = result.workspace.dashboards[0].layout as unknown as {
      items: Record<string, unknown>; fallback?: { items?: Record<string, unknown> };
    };
    expect(layout.items['t-new']).toBeDefined();
    expect(layout.fallback?.items?.['t-new']).toBeDefined();
  });

  it('increments the target Dashboard revision exactly once', () => {
    const result = copyLibraryQueryToPanel({
      latest: ws({ queries: [lib], dashboards: [dash('d1', { revision: 7 })] }), ...panelInput,
    });
    if (!result.ok) throw new Error('expected ok');
    expect(result.workspace.dashboards[0].revision).toBe(8);
  });

  it('leaves every non-target Dashboard byte-identical', () => {
    const other = dash('d2', { revision: 3, tiles: [{ id: 't-o', queryId: 'q-o' }] });
    const latest = ws({
      queries: [lib, savedQuery({ id: 'q-o' })],
      dashboards: [dash('d1'), other],
    });
    const result = copyLibraryQueryToPanel({ latest, ...panelInput });
    if (!result.ok) throw new Error('expected ok');

    expect(result.workspace.dashboards[1]).toEqual(other);
  });

  it('creates an independent copy on every repeated drop of the same source', () => {
    const first = copyLibraryQueryToPanel({ latest: base(), ...panelInput });
    if (!first.ok) throw new Error('expected ok');
    const second = copyLibraryQueryToPanel({
      latest: first.workspace, ...panelInput, newQueryId: 'q-new2', newTileId: 't-new2',
    });
    if (!second.ok) throw new Error('expected ok');

    expect(second.workspace.queries.map((q) => q.id)).toEqual(['q-lib', 'q-new', 'q-new2']);
    expect(second.workspace.dashboards[0].tiles.map((t) => t.queryId)).toEqual(['q-new', 'q-new2']);
    // Two panels, two documents — not one query shared by two tiles.
    expect(second.workspace.dashboards[0].tiles[0].queryId)
      .not.toBe(second.workspace.dashboards[0].tiles[1].queryId);
    expect(second.workspace.dashboards[0].revision).toBe(3);
  });

  it('aborts when the active workspace is not the one the drag started in', () => {
    const result = copyLibraryQueryToPanel({ latest: base(), ...panelInput, workspaceId: 'other' });
    expect(result).toEqual({ ok: false, reason: 'workspace-mismatch' });
  });

  it('aborts when the source query was deleted mid-drag', () => {
    const result = copyLibraryQueryToPanel({
      latest: ws({ dashboards: [dash('d1')] }), ...panelInput,
    });
    expect(result).toEqual({ ok: false, reason: 'source-missing' });
  });

  it('aborts when the source became Dashboard-owned mid-drag', () => {
    const owned = ws({
      queries: [lib],
      dashboards: [dash('d1'), dash('d2', { tiles: [{ id: 't-x', queryId: 'q-lib' }] })],
    });
    expect(copyLibraryQueryToPanel({ latest: owned, ...panelInput }))
      .toEqual({ ok: false, reason: 'source-not-library' });
  });

  it('aborts when the target Dashboard disappeared', () => {
    const result = copyLibraryQueryToPanel({
      latest: ws({ queries: [lib], dashboards: [dash('other')] }), ...panelInput,
    });
    expect(result).toEqual({ ok: false, reason: 'dashboard-missing' });
  });

  it('aborts on a duplicate target id rather than picking one', () => {
    const result = copyLibraryQueryToPanel({
      latest: ws({ queries: [lib], dashboards: [dash('d1'), dash('d1')] }), ...panelInput,
    });
    expect(result).toEqual({ ok: false, reason: 'dashboard-ambiguous' });
  });

  it('aborts when the minted query id is already taken', () => {
    const taken = ws({ queries: [lib, savedQuery({ id: 'q-new' })], dashboards: [dash('d1')] });
    expect(copyLibraryQueryToPanel({ latest: taken, ...panelInput }))
      .toEqual({ ok: false, reason: 'id-collision' });
  });

  it('aborts when the minted tile id is already taken on the target Dashboard', () => {
    const taken = ws({
      queries: [lib, savedQuery({ id: 'q-x' })],
      dashboards: [dash('d1', { tiles: [{ id: 't-new', queryId: 'q-x' }] })],
    });
    expect(copyLibraryQueryToPanel({ latest: taken, ...panelInput }))
      .toEqual({ ok: false, reason: 'id-collision' });
  });

  it('rebases over a workspace that changed since the drag started', () => {
    // #428/#343: a same-workspace change during the drag is NOT a reason to
    // cancel — the operation re-applies over whatever is committed now.
    const moved = ws({
      queries: [lib, savedQuery({ id: 'q-later' })],
      dashboards: [dash('d1', { revision: 9, tiles: [] }), dash('d-new')],
    });
    const result = copyLibraryQueryToPanel({ latest: moved, ...panelInput });
    if (!result.ok) throw new Error('expected ok');
    expect(result.workspace.dashboards[0].revision).toBe(10);
    expect(result.workspace.queries.map((q) => q.id)).toEqual(['q-lib', 'q-later', 'q-new']);
    expect(result.workspace.dashboards[1]).toEqual(dash('d-new'));
  });
});

describe('copyLibraryQuerySqlToVariable', () => {
  const declaring = savedQuery({ id: 'q-panel', sql: 'SELECT * FROM t WHERE c = {country:String}' });
  const variableInput = {
    workspaceId: 'w1', sourceQueryId: 'q-lib', dashboardId: 'd1', variableName: 'country',
  };
  const base = () => ws({
    queries: [lib, declaring],
    dashboards: [dash('d1', { tiles: [{ id: 't1', queryId: 'q-panel' }] })],
  });

  it('copies the source SQL into the exact inferred variable, with its type', () => {
    const result = copyLibraryQuerySqlToVariable({ latest: base(), ...variableInput });
    if (!result.ok) throw new Error('expected ok, got ' + result.reason);

    expect(result.data).toEqual({ sql: 'SELECT country FROM t' });
    expect(result.workspace.dashboards[0].variableConfigs).toEqual({
      country: { sql: 'SELECT country FROM t', lastKnownType: 'String' },
    });
  });

  it('creates no query, tile, owner or role', () => {
    const latest = base();
    const result = copyLibraryQuerySqlToVariable({ latest, ...variableInput });
    if (!result.ok) throw new Error('expected ok');

    expect(result.workspace.queries).toEqual(latest.queries);
    expect(result.workspace.dashboards[0].tiles).toEqual([{ id: 't1', queryId: 'q-panel' }]);
  });

  it('leaves the Library source unchanged — this is a copy, not a link', () => {
    const latest = base();
    const before = structuredClone(latest.queries[0]);
    const result = copyLibraryQuerySqlToVariable({ latest, ...variableInput });
    if (!result.ok) throw new Error('expected ok');
    expect(result.workspace.queries[0]).toEqual(before);
  });

  it('increments the target Dashboard revision exactly once', () => {
    const latest = ws({
      queries: [lib, declaring],
      dashboards: [dash('d1', { revision: 4, tiles: [{ id: 't1', queryId: 'q-panel' }] })],
    });
    const result = copyLibraryQuerySqlToVariable({ latest, ...variableInput });
    if (!result.ok) throw new Error('expected ok');
    expect(result.workspace.dashboards[0].revision).toBe(5);
  });

  it('preserves case-sensitive variable identity', () => {
    const cased = ws({
      queries: [lib, savedQuery({ id: 'q-panel', sql: 'SELECT {Country:String}, {country:UInt8}' })],
      dashboards: [dash('d1', { tiles: [{ id: 't1', queryId: 'q-panel' }] })],
    });
    const result = copyLibraryQuerySqlToVariable({ latest: cased, ...variableInput });
    if (!result.ok) throw new Error('expected ok');

    // Only the lower-case one was written, and it took ITS type.
    expect(result.workspace.dashboards[0].variableConfigs).toEqual({
      country: { sql: 'SELECT country FROM t', lastKnownType: 'UInt8' },
    });
  });

  it('overwrites an existing configuration for the same variable', () => {
    const configured = ws({
      queries: [lib, declaring],
      dashboards: [dash('d1', {
        tiles: [{ id: 't1', queryId: 'q-panel' }],
        variableConfigs: { country: { sql: 'SELECT old' } },
      })],
    });
    const result = copyLibraryQuerySqlToVariable({ latest: configured, ...variableInput });
    if (!result.ok) throw new Error('expected ok');
    expect(result.workspace.dashboards[0].variableConfigs?.country.sql).toBe('SELECT country FROM t');
  });

  it('stores parameterised option SQL for correction rather than refusing it', () => {
    // Locally invalid SQL is diagnosed by the existing option rules, not here —
    // storing it is what lets the user open the tab and fix it.
    const parameterised = savedQuery({ id: 'q-lib', sql: 'SELECT x FROM t WHERE y = {other:String}' });
    const latest = ws({
      queries: [parameterised, declaring],
      dashboards: [dash('d1', { tiles: [{ id: 't1', queryId: 'q-panel' }] })],
    });
    const result = copyLibraryQuerySqlToVariable({ latest, ...variableInput });
    if (!result.ok) throw new Error('expected ok');
    expect(result.workspace.dashboards[0].variableConfigs?.country.sql)
      .toBe('SELECT x FROM t WHERE y = {other:String}');
  });

  it('records no lastKnownType for a conflicted variable, which still accepts SQL', () => {
    const conflicted = ws({
      queries: [
        lib,
        savedQuery({ id: 'q-a', sql: 'SELECT {country:String}' }),
        savedQuery({ id: 'q-b', sql: 'SELECT {country:UInt8}' }),
      ],
      dashboards: [dash('d1', {
        tiles: [{ id: 't1', queryId: 'q-a' }, { id: 't2', queryId: 'q-b' }],
      })],
    });
    const result = copyLibraryQuerySqlToVariable({ latest: conflicted, ...variableInput });
    if (!result.ok) throw new Error('expected ok');
    expect(result.workspace.dashboards[0].variableConfigs)
      .toEqual({ country: { sql: 'SELECT country FROM t' } });
  });

  it('refuses a blank source rather than treating the drop as a deletion', () => {
    const blank = ws({
      queries: [savedQuery({ id: 'q-lib', sql: '   \n\t ' }), declaring],
      dashboards: [dash('d1', {
        tiles: [{ id: 't1', queryId: 'q-panel' }],
        variableConfigs: { country: { sql: 'SELECT keep' } },
      })],
    });
    const result = copyLibraryQuerySqlToVariable({ latest: blank, ...variableInput });
    expect(result).toEqual({ ok: false, reason: 'blank-sql' });
  });

  it('aborts for an orphaned variable — a configuration no panel declares', () => {
    const orphan = ws({
      queries: [lib],
      dashboards: [dash('d1', { variableConfigs: { country: { sql: 'SELECT old' } } })],
    });
    expect(copyLibraryQuerySqlToVariable({ latest: orphan, ...variableInput }))
      .toEqual({ ok: false, reason: 'variable-not-inferred' });
  });

  it('aborts when the variable stopped being inferred mid-drag', () => {
    const gone = ws({
      queries: [lib, savedQuery({ id: 'q-panel', sql: 'SELECT 1' })],
      dashboards: [dash('d1', { tiles: [{ id: 't1', queryId: 'q-panel' }] })],
    });
    expect(copyLibraryQuerySqlToVariable({ latest: gone, ...variableInput }))
      .toEqual({ ok: false, reason: 'variable-not-inferred' });
  });

  it('shares the source guards with the panel path', () => {
    expect(copyLibraryQuerySqlToVariable({ latest: base(), ...variableInput, workspaceId: 'x' }))
      .toEqual({ ok: false, reason: 'workspace-mismatch' });
    expect(copyLibraryQuerySqlToVariable({
      latest: ws({ queries: [declaring], dashboards: [dash('d1')] }), ...variableInput,
    })).toEqual({ ok: false, reason: 'source-missing' });
    expect(copyLibraryQuerySqlToVariable({
      latest: ws({
        queries: [lib, declaring],
        dashboards: [
          dash('d1', { tiles: [{ id: 't1', queryId: 'q-panel' }] }),
          dash('d2', { tiles: [{ id: 't2', queryId: 'q-lib' }] }),
        ],
      }),
      ...variableInput,
    })).toEqual({ ok: false, reason: 'source-not-library' });
  });

  it('reports the DASHBOARD, not the blank source, when both are wrong', () => {
    // Ordering matters for the message: telling a user to go and clear option
    // SQL on a Dashboard that no longer exists is worse than saying nothing.
    const blankAndGone = ws({
      queries: [savedQuery({ id: 'q-lib', sql: '  ' })],
      dashboards: [dash('other')],
    });
    expect(copyLibraryQuerySqlToVariable({ latest: blankAndGone, ...variableInput }))
      .toEqual({ ok: false, reason: 'dashboard-missing' });
  });

  it('reports the VARIABLE, not the blank source, when the variable is gone', () => {
    const blankAndOrphan = ws({
      queries: [savedQuery({ id: 'q-lib', sql: '  ' })],
      dashboards: [dash('d1')],
    });
    expect(copyLibraryQuerySqlToVariable({ latest: blankAndOrphan, ...variableInput }))
      .toEqual({ ok: false, reason: 'variable-not-inferred' });
  });

  it('aborts for a missing or ambiguous target Dashboard', () => {
    expect(copyLibraryQuerySqlToVariable({
      latest: ws({ queries: [lib], dashboards: [dash('other')] }), ...variableInput,
    })).toEqual({ ok: false, reason: 'dashboard-missing' });
    expect(copyLibraryQuerySqlToVariable({
      latest: ws({ queries: [lib], dashboards: [dash('d1'), dash('d1')] }), ...variableInput,
    })).toEqual({ ok: false, reason: 'dashboard-ambiguous' });
  });
});
