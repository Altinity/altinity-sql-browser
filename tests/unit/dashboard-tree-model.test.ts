import { describe, expect, it } from 'vitest';
import {
  UNTITLED_DASHBOARD, UNTITLED_PANEL, UNUSED_VARIABLE_STATUS, dashboardVariables,
  deriveDashboardTree,
  type DashboardTreeRow, type TreeDashboard, type TreeWorkspace,
} from '../../src/application/dashboard-tree-model.js';
import {
  EMPTY_TREE_UI, setTreeSearch, toggleDashboardExpanded, toggleGroupExpanded,
  type DashboardTreeUiState,
} from '../../src/core/dashboard-tree-ui-state.js';
import { QUERY_SURFACE, type MainSurfaceState } from '../../src/application/main-surface.js';
import type { DashboardDocumentV2, SavedQueryV2, StoredWorkspaceV5 } from '../../src/generated/json-schema.types.js';

const query = (id: string, name?: string, description?: string, sql = 'SELECT 1'): SavedQueryV2 => ({
  id, sql, specVersion: 1,
  spec: { specVersion: 1, ...(name === undefined ? {} : { name }), ...(description === undefined ? {} : { description }) },
});

const dashboard = (over: Partial<TreeDashboard> & { id: string }): TreeDashboard => ({
  tiles: [], ...over,
});

const ws = (over: Partial<TreeWorkspace> = {}): TreeWorkspace => ({
  id: 'w1', dashboards: [], queries: [], ...over,
});

const onDashboard = (
  dashboardId: string, currentMember: { kind: 'tile' | 'variable'; id: string } | null = null,
): MainSurfaceState => ({
  kind: 'dashboard', dashboardId, mode: 'edit', currentMember, pendingFocus: null, pendingScrollTop: null,
});

/** Expand a Dashboard and both its groups — the usual "show me everything" state. */
const allOpen = (dashboardIds: string[]): DashboardTreeUiState => {
  let ui = EMPTY_TREE_UI;
  for (const id of dashboardIds) {
    ui = toggleDashboardExpanded(ui, id);
    ui = toggleGroupExpanded(ui, id, 'variables');
    ui = toggleGroupExpanded(ui, id, 'panels');
  }
  return ui;
};

const derive = (workspace: TreeWorkspace | null, ui = EMPTY_TREE_UI, surface = QUERY_SURFACE) =>
  deriveDashboardTree({ workspace, surface, ui });

const keys = (rows: readonly DashboardTreeRow[]): string[] => rows.map((row) => row.key);
const labels = (rows: readonly DashboardTreeRow[]): string[] => rows.map((row) => row.label);
const row = (rows: readonly DashboardTreeRow[], key: string): DashboardTreeRow =>
  rows.find((candidate) => candidate.key === key)!;
const variableRows = (rows: readonly DashboardTreeRow[]): DashboardTreeRow[] =>
  rows.filter((candidate) => candidate.kind === 'variable');

describe('deriveDashboardTree — collection and ordering', () => {
  it('renders Dashboards in array order, collapsed, with the panel count at the right', () => {
    const tree = derive(ws({
      dashboards: [
        dashboard({ id: 'b', title: 'Beta', tiles: [{ id: 't1', queryId: 'q1' }, { id: 't2', queryId: 'q1' }] }),
        dashboard({ id: 'a', title: 'Alpha' }),
      ],
      queries: [query('q1', 'Q1')],
    }));
    expect(labels(tree.rows)).toEqual(['Beta', 'Alpha']);
    expect(tree.rows.map((r) => r.meta)).toEqual(['2', '0']);
    expect(tree.rows.every((r) => r.level === 1 && r.parentKey === null && r.expandable)).toBe(true);
    expect(tree.dashboardCount).toBe(2);
  });

  it('counts PANELS only — variables are Dashboard-level controls', () => {
    const tree = derive(ws({
      dashboards: [dashboard({
        id: 'd', title: 'D',
        tiles: [{ id: 't1', queryId: 'q1' }],
        variableConfigs: { a: { sql: 'SELECT a, a' }, b: { sql: 'SELECT b, b' } },
      })],
      queries: [query('q1', 'Q1')],
    }));
    expect(row(tree.rows, 'w1:d').meta).toBe('1');
  });

  it('keys rows by workspace + Dashboard + member id, never by index or label', () => {
    const tree = derive(ws({
      dashboards: [dashboard({ id: 'd', title: 'D', tiles: [{ id: 't1', queryId: 'q1' }] })],
      queries: [query('q1', 'Q1', undefined, 'SELECT 1 WHERE r = {region:String}')],
    }), allOpen(['d']));
    expect(keys(tree.rows)).toEqual([
      'w1:d', 'w1:d:group:variables', 'w1:d:variable:region', 'w1:d:group:panels', 'w1:d:tile:t1',
    ]);
  });

  // Ids are schema-constrained only to `\S`, so a colon is LEGAL, and an imported
  // bundle preserves whatever ids it carried. Unescaped, Dashboard `a:tile:b` and
  // tile `b` of Dashboard `a` would produce the SAME row key — two rows claiming
  // tabindex="0", focus landing on the wrong one, and the click arbiter reading two
  // distinct resources as a double-click.
  it('produces distinct keys for ids that contain the key separator', () => {
    const tree = derive(ws({
      dashboards: [
        dashboard({ id: 'a', tiles: [{ id: 'b', queryId: 'q1' }] }),
        dashboard({ id: 'a:tile:b' }),
      ],
      queries: [query('q1', 'Q1')],
    }), allOpen(['a', 'a:tile:b']));
    const allKeys = keys(tree.rows);
    expect(new Set(allKeys).size).toBe(allKeys.length);
    expect(allKeys).toContain('w1:a:tile:b');       // Dashboard 'a', tile 'b'
    expect(allKeys).toContain('w1:a%3Atile%3Ab');   // Dashboard 'a:tile:b'
  });

  // A variable NAME is only constrained by the placeholder grammar, and an
  // imported bundle can carry any `variableConfigs` key at all — so the same
  // escaping the ids get applies to the name that identifies a variable row.
  it('escapes a variable NAME into its row key', () => {
    const tree = derive(ws({
      dashboards: [dashboard({ id: 'd', variableConfigs: { 'a:tile:b': { sql: 'SELECT 1, 1' } } })],
    }), allOpen(['d']));
    expect(keys(tree.rows)).toContain('w1:d:variable:a%3Atile%3Ab');
  });

  it('escapes the escape character itself, so a key cannot be forged', () => {
    const tree = derive(ws({ dashboards: [dashboard({ id: 'a%3Atile%3Ab' }), dashboard({ id: 'a:tile:b' })] }));
    const allKeys = keys(tree.rows);
    expect(new Set(allKeys).size).toBe(allKeys.length);
  });

  it('reports an empty collection, and a null workspace, as no-dashboards', () => {
    expect(derive(ws()).empty).toBe('no-dashboards');
    expect(derive(ws()).rows).toEqual([]);
    const none = derive(null);
    expect(none.empty).toBe('no-dashboards');
    expect(none.dashboardCount).toBe(0);
  });

  it('accepts a real StoredWorkspaceV5 with no cast', () => {
    const real: StoredWorkspaceV5 = {
      storageVersion: 5, id: 'w1', key: 'ops', name: 'Ops',
      queries: [query('q1', 'Sales', undefined, 'SELECT 1 WHERE c = {country:String}')],
      dashboards: [{
        documentVersion: 2, id: 'd', title: 'D', revision: 1,
        layout: { type: 'flow', version: 1, preset: 'report', items: {} },
        tiles: [{ id: 't1', queryId: 'q1' }],
        variableConfigs: { country: { sql: 'SELECT c, c FROM countries' } },
      } satisfies DashboardDocumentV2],
    };
    const tree = deriveDashboardTree({ workspace: real, surface: QUERY_SURFACE, ui: allOpen(['d']) });
    expect(tree.rows.map((r) => r.label)).toEqual(['D', 'Variables', 'country', 'Panels', 'Sales']);
  });
});

describe('deriveDashboardTree — groups', () => {
  it('always renders Variables BEFORE Panels, and keeps both visible when EMPTY', () => {
    const tree = derive(ws({ dashboards: [dashboard({ id: 'd', title: 'D' })] }), toggleDashboardExpanded(EMPTY_TREE_UI, 'd'));
    const groups = tree.rows.filter((r) => r.kind === 'group');
    expect(groups.map((r) => r.label)).toEqual(['Variables', 'Panels']);
    // #428 uses them as stable drop targets, so an empty group is still a row.
    expect(groups.map((r) => r.count)).toEqual([0, 0]);
    expect(groups.every((r) => r.level === 2 && r.parentKey === 'w1:d')).toBe(true);
  });

  it('does not render groups for a COLLAPSED Dashboard', () => {
    const tree = derive(ws({ dashboards: [dashboard({ id: 'd', title: 'D' })] }));
    expect(tree.rows).toHaveLength(1);
  });

  it('counts each group independently and expands them independently', () => {
    const workspace = ws({
      dashboards: [dashboard({
        id: 'd', title: 'D',
        tiles: [{ id: 't1', queryId: 'q1' }, { id: 't2', queryId: 'q2' }],
      })],
      queries: [
        query('q1', 'Q1', undefined, 'SELECT 1 WHERE r = {region:String}'),
        query('q2', 'Q2'),
      ],
    });
    const onlyPanels = toggleGroupExpanded(toggleDashboardExpanded(EMPTY_TREE_UI, 'd'), 'd', 'panels');
    const tree = derive(workspace, onlyPanels);
    expect(row(tree.rows, 'w1:d:group:variables').count).toBe(1);
    expect(row(tree.rows, 'w1:d:group:variables').expanded).toBe(false);
    expect(row(tree.rows, 'w1:d:group:panels').count).toBe(2);
    // Only the expanded group contributes member rows.
    expect(keys(tree.rows).filter((k) => k.includes(':variable:'))).toEqual([]);
    expect(keys(tree.rows).filter((k) => k.includes(':tile:'))).toEqual(['w1:d:tile:t1', 'w1:d:tile:t2']);
  });

  // #447: the count is distinct INFERRED names plus orphaned configuration names.
  it('counts distinct inferred names PLUS orphaned configuration names', () => {
    const tree = derive(ws({
      dashboards: [dashboard({
        id: 'd',
        tiles: [{ id: 't1', queryId: 'q1' }, { id: 't2', queryId: 'q2' }],
        // `gone` is declared by no panel — an orphan that still counts.
        variableConfigs: { country: { sql: 'SELECT c, c' }, gone: { sql: 'SELECT g, g' } },
      })],
      queries: [
        // `country` is declared TWICE and still counts once.
        query('q1', 'Q1', undefined, 'SELECT 1 WHERE c = {country:String}'),
        query('q2', 'Q2', undefined, 'SELECT 1 WHERE c = {country:String} AND y = {year:UInt16}'),
      ],
    }), allOpen(['d']));
    expect(row(tree.rows, 'w1:d:group:variables').count).toBe(3);
    expect(labels(variableRows(tree.rows))).toEqual(['country', 'year', 'gone']);
  });

  it('keeps the group count independent of the search', () => {
    const workspace = ws({
      dashboards: [dashboard({ id: 'd', title: 'D', tiles: [{ id: 't1', queryId: 'q1' }] })],
      queries: [query('q1', 'Q1', undefined, 'SELECT 1 WHERE c = {country:String} AND y = {year:UInt16}')],
    });
    const searching = setTreeSearch(EMPTY_TREE_UI, 'country');
    const tree = derive(workspace, searching);
    expect(row(tree.rows, 'w1:d:group:variables').count).toBe(2);
    expect(labels(variableRows(tree.rows))).toEqual(['country']);
  });
});

describe('deriveDashboardTree — labels', () => {
  it('falls back to Untitled dashboard for a blank title, without showing the id', () => {
    const tree = derive(ws({ dashboards: [dashboard({ id: 'dash-abc-123', title: '   ' })] }));
    expect(tree.rows[0].label).toBe(UNTITLED_DASHBOARD);
    expect(tree.rows[0].label).not.toContain('dash-abc-123');
  });

  it('resolves a panel label: tile override, then query name, then Untitled panel', () => {
    const tree = derive(ws({
      dashboards: [dashboard({
        id: 'd', title: 'D',
        tiles: [
          { id: 't1', queryId: 'q1', title: '  Override  ' },
          { id: 't2', queryId: 'q1' },
          { id: 't3', queryId: 'q-noname' },
        ],
      })],
      queries: [query('q1', 'Query name'), query('q-noname')],
    }), allOpen(['d']));
    expect(labels(tree.rows.filter((r) => r.kind === 'panel')))
      .toEqual(['Override', 'Query name', UNTITLED_PANEL]);
  });

  it('labels a variable row with its NAME and its type(s) as meta', () => {
    const tree = derive(ws({
      dashboards: [dashboard({ id: 'd', title: 'D', tiles: [{ id: 't1', queryId: 'q1' }] })],
      queries: [query('q1', 'Q1', undefined, 'SELECT 1 WHERE c = {country:String}')],
    }), allOpen(['d']));
    const variable = row(tree.rows, 'w1:d:variable:country');
    expect(variable.label).toBe('country');
    expect(variable.meta).toBe('String');
    expect(variable.level).toBe(3);
    expect(variable.parentKey).toBe('w1:d:group:variables');
    expect(variable.expandable).toBe(false);
  });
});

describe('deriveDashboardTree — variable inference', () => {
  const withSql = (...sqls: string[]): TreeWorkspace => ws({
    dashboards: [dashboard({
      id: 'd', title: 'D',
      tiles: sqls.map((_sql, index) => ({ id: 't' + index, queryId: 'q' + index })),
    })],
    queries: sqls.map((sql, index) => query('q' + index, 'Panel ' + index, undefined, sql)),
  });
  /** The variable rows of a Dashboard whose panels are exactly these queries. */
  const rowsOf = (...sqls: string[]) => variableRows(derive(withSql(...sqls), allOpen(['d'])).rows);

  it('produces ONE row showing String for a single {country:String} declaration', () => {
    const [only] = rowsOf('SELECT * FROM t WHERE c = {country:String}');
    expect(only.label).toBe('country');
    expect(only.meta).toBe('String');
    expect(only.invalid).toBeNull();
    expect(only.severity).toBeNull();
    expect(only.diagnostic).toBeNull();
    // An ACTIVE variable is inferred from the panel SQL — there is no stored
    // configuration of its own to edit or delete.
    expect(only.actions).toEqual([]);
  });

  it('still produces ONE row when several panels declare the same name and type', () => {
    const rows = rowsOf(
      'SELECT * FROM a WHERE c = {country:String}',
      'SELECT * FROM b WHERE c = {country:String}',
      'SELECT * FROM c WHERE c = {country:String}',
    );
    expect(labels(rows)).toEqual(['country']);
    expect(rows[0].meta).toBe('String');
  });

  it('treats `country` and `Country` as TWO variables — matching is case-sensitive', () => {
    const rows = rowsOf('SELECT * FROM t WHERE a = {country:String} AND b = {Country:String}');
    expect(labels(rows)).toEqual(['country', 'Country']);
  });

  it('collapses conflicting types into ONE row, marked as an ERROR, showing every type', () => {
    const rows = rowsOf(
      'SELECT * FROM a WHERE c = {customer_id:String}',
      'SELECT * FROM b WHERE c = {customer_id:UInt64}',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].label).toBe('customer_id');
    expect(rows[0].meta).toBe('String | UInt64');
    expect(rows[0].invalid).toBe('variable-conflict');
    expect(rows[0].severity).toBe('error');
    // Never has an action: there is no stored configuration behind a conflict.
    expect(rows[0].actions).toEqual([]);
  });

  it('names the conflicting panel/query usages in the hover text, the way the TREE labels them', () => {
    const workspace = ws({
      dashboards: [dashboard({
        id: 'd', title: 'D',
        tiles: [{ id: 't1', queryId: 'q1', title: 'Revenue by customer' }, { id: 't2', queryId: 'q2' }],
      })],
      queries: [
        query('q1', 'Q1', undefined, 'SELECT 1 WHERE c = {customer_id:String}'),
        query('q2', 'Named query', undefined, 'SELECT 1 WHERE c = {customer_id:UInt64}'),
      ],
    });
    const diagnostic = variableRows(derive(workspace, allOpen(['d'])).rows)[0].diagnostic!;
    // The tile title override wins for the first panel, the query name for the
    // second — exactly what the panel ROWS show, never a raw tile id.
    expect(diagnostic).toContain('Revenue by customer: {customer_id:String}');
    expect(diagnostic).toContain('Named query: {customer_id:UInt64}');
    expect(diagnostic).not.toContain('t1');
  });

  it('clears the conflict once the panel SQL agrees again', () => {
    const resolved = rowsOf(
      'SELECT * FROM a WHERE c = {customer_id:String}',
      'SELECT * FROM b WHERE c = {customer_id:String}',
    );
    expect(resolved).toHaveLength(1);
    expect(resolved[0].invalid).toBeNull();
    expect(resolved[0].severity).toBeNull();
    expect(resolved[0].meta).toBe('String');
  });

  it('turns a CONFIGURED variable whose last usage is gone into an unused WARNING row', () => {
    const tree = derive(ws({
      dashboards: [dashboard({
        id: 'd', title: 'D',
        tiles: [{ id: 't1', queryId: 'q1' }],
        variableConfigs: { region: { sql: 'SELECT r, r FROM regions', lastKnownType: 'String' } },
      })],
      // The panel no longer declares {region:String}.
      queries: [query('q1', 'Q1', undefined, 'SELECT 1')],
    }), allOpen(['d']));
    const orphan = row(tree.rows, 'w1:d:variable:region');
    expect(orphan.invalid).toBe('variable-unused');
    expect(orphan.severity).toBe('warning');
    expect(orphan.diagnostic).toContain('not referenced by any Dashboard panel');
    // The remembered type still displays, so the row is not mysteriously blank.
    expect(orphan.meta).toBe('String');
    // #494: an orphan's ONE action is the trash for its stored option SQL,
    // fully resolved and carrying the confirmation sentence.
    expect(orphan.actions).toEqual([{
      kind: 'delete-variable-config',
      label: 'Delete the stored option SQL for region',
      tooltip: 'Delete stored option SQL',
      target: { kind: 'variable-config', dashboardId: 'd', name: 'region' },
      unavailable: null,
      confirm: 'Delete the stored option SQL for “region”? The SQL is lost.',
    }]);
  });

  it('shows NO type for an orphan whose configuration never recorded one', () => {
    const tree = derive(ws({
      dashboards: [dashboard({ id: 'd', variableConfigs: { region: { sql: 'SELECT r, r' } } })],
    }), allOpen(['d']));
    expect(row(tree.rows, 'w1:d:variable:region').meta).toBe('');
  });

  it('removes the row entirely when an UNCONFIGURED variable loses its last usage', () => {
    const declared = rowsOf('SELECT * FROM t WHERE r = {region:String}');
    expect(labels(declared)).toEqual(['region']);
    // Same Dashboard, same tile, SQL without the placeholder and no stored config.
    expect(rowsOf('SELECT * FROM t')).toEqual([]);
  });

  it('reads the placeholders of a tile whose query is MISSING as no declarations at all', () => {
    const tree = derive(ws({
      dashboards: [dashboard({ id: 'd', tiles: [{ id: 't1', queryId: 'q-gone' }] })],
      queries: [],
    }), allOpen(['d']));
    expect(variableRows(tree.rows)).toEqual([]);
    expect(row(tree.rows, 'w1:d:group:variables').count).toBe(0);
  });

  it('reads a tile with NO query as no declarations at all', () => {
    const tree = derive(ws({
      dashboards: [dashboard({ id: 'd', tiles: [{ id: 't1' }] })],
    }), allOpen(['d']));
    expect(variableRows(tree.rows)).toEqual([]);
  });
});

describe('deriveDashboardTree — invalid panel references', () => {
  const workspace = () => ws({
    dashboards: [dashboard({
      id: 'd', title: 'D',
      tiles: [{ id: 't-ok', queryId: 'q1' }, { id: 't-broken', queryId: 'q-gone' }],
    })],
    queries: [query('q1', 'Q1')],
  });

  it('renders an unresolved PANEL query as a diagnostic row', () => {
    const broken = row(derive(workspace(), allOpen(['d'])).rows, 'w1:d:tile:t-broken');
    expect(broken.invalid).toBe('unresolved-query');
    expect(broken.severity).toBe('error');
    expect(broken.diagnostic).toContain('cannot be opened');
    expect(broken.single).toBeNull();
    expect(broken.queryId).toBeNull();
  });

  it('keeps Dashboard View/Edit focus navigation available on a broken panel row', () => {
    // A broken member's diagnostics must stay reachable — only the operation that
    // needs the missing query is withheld.
    const broken = row(derive(workspace(), allOpen(['d'])).rows, 'w1:d:tile:t-broken');
    expect(broken.double).toMatchObject({ kind: 'open-dashboard' });
    expect(broken.shift).toMatchObject({ kind: 'open-dashboard' });
    // #494: both direct controls still RENDER — the row's vocabulary does not
    // shrink — but neither can act on a query that is not in the workspace.
    expect(broken.actions.map((a) => a.kind)).toEqual(['edit-panel', 'delete-panel']);
    expect(broken.actions.every((a) => a.target === null)).toBe(true);
    expect(broken.actions.every((a) => a.confirm === null)).toBe(true);
    expect(broken.actions[0].unavailable).toContain('not in this workspace');
    expect(broken.actions[1].unavailable).toBe(broken.actions[0].unavailable);
  });

  it('never hides the Dashboard because one reference is bad', () => {
    const tree = derive(workspace(), allOpen(['d']));
    expect(row(tree.rows, 'w1:d')).toBeDefined();
    expect(tree.rows.filter((r) => r.kind === 'panel')).toHaveLength(2);
  });

  it('never throws on malformed data the schema would normally reject', () => {
    // Reachable while data is stale, imported, or concurrently changed. The loose
    // input shape exists exactly so these guards are testable rather than dead.
    const malformed = {
      id: 'w1',
      dashboards: [
        { id: 'no-collections' },
        { id: 'null-collections', title: 'N', tiles: null, variableConfigs: null },
        { id: 'bad-refs', title: 'B', tiles: [{ id: 't1' }] },
      ],
      queries: null,
    } satisfies TreeWorkspace;
    const tree = deriveDashboardTree({
      workspace: malformed, surface: QUERY_SURFACE, ui: allOpen(['no-collections', 'null-collections', 'bad-refs']),
    });
    expect(tree.rows.filter((r) => r.kind === 'dashboard')).toHaveLength(3);
    // Both group rows still appear for a Dashboard with no collections at all.
    expect(tree.rows.filter((r) => r.kind === 'group')).toHaveLength(6);
    expect(row(tree.rows, 'w1:bad-refs:tile:t1').invalid).toBe('unresolved-query');
    expect(variableRows(tree.rows)).toEqual([]);
  });

  it('renders one row PER PANEL when several panels share one query', () => {
    const tree = derive(ws({
      dashboards: [dashboard({
        id: 'd', title: 'D',
        tiles: [{ id: 't1', queryId: 'shared' }, { id: 't2', queryId: 'shared' }],
      })],
      queries: [query('shared', 'Shared')],
    }), allOpen(['d']));
    const shared = tree.rows.filter((r) => r.queryId === 'shared');
    expect(shared).toHaveLength(2);
    expect(shared.map((r) => r.key)).toEqual(['w1:d:tile:t1', 'w1:d:tile:t2']);
    expect(new Set(shared.map((r) => r.label))).toEqual(new Set(['Shared']));
  });
});

describe('deriveDashboardTree — search', () => {
  const workspace = () => ws({
    dashboards: [
      dashboard({
        id: 'sales', title: 'Sales', description: 'revenue reporting',
        tiles: [{ id: 't-rev', queryId: 'q-rev' }, { id: 't-cost', queryId: 'q-cost', title: 'Cost override', description: 'tile note' }],
        variableConfigs: { region_code: { sql: 'SELECT code, name FROM regions', lastKnownType: 'String' } },
      }),
      dashboard({
        id: 'ops', title: 'Ops',
        tiles: [{ id: 't-lat', queryId: 'q-lat' }],
      }),
    ],
    queries: [
      query('q-rev', 'Revenue', 'monthly totals', 'SELECT 1 WHERE r = {region_code:String}'),
      query('q-cost', 'Cost'),
      query('q-lat', 'Latency', 'p99 by shard', 'SELECT 1 WHERE z = {zone:LowCardinality(String)}'),
    ],
  });
  const search = (text: string, ui = EMPTY_TREE_UI) => derive(workspace(), setTreeSearch(ui, text));

  it('matches a Dashboard title and shows its COMPLETE hierarchy for context', () => {
    const tree = search('sales');
    expect(tree.rows.map((r) => r.key)).toEqual([
      'w1:sales', 'w1:sales:group:variables', 'w1:sales:variable:region_code',
      'w1:sales:group:panels', 'w1:sales:tile:t-rev', 'w1:sales:tile:t-cost',
    ]);
    expect(row(tree.rows, 'w1:sales').matched).toBe(true);
  });

  it('matches a Dashboard DESCRIPTION', () => {
    expect(keys(search('revenue reporting').rows)).toContain('w1:sales');
  });

  it('matches a variable NAME and keeps its ancestors visible', () => {
    const tree = search('region_code');
    expect(keys(tree.rows)).toEqual([
      'w1:sales', 'w1:sales:group:variables', 'w1:sales:variable:region_code', 'w1:sales:group:panels',
    ]);
    expect(row(tree.rows, 'w1:sales:variable:region_code').matched).toBe(true);
    // Ancestors are exposed but not themselves marked as matches.
    expect(row(tree.rows, 'w1:sales').matched).toBe(false);
  });

  it('matches a variable TYPE', () => {
    const tree = search('lowcardinality');
    expect(keys(tree.rows)).toContain('w1:ops:variable:zone');
    expect(keys(tree.rows)).not.toContain('w1:sales:variable:region_code');
  });

  it('matches a variable\'s stored option SQL', () => {
    const tree = search('from regions');
    expect(keys(tree.rows)).toContain('w1:sales:variable:region_code');
    expect(keys(tree.rows)).not.toContain('w1:ops');
  });

  it('matches a panel query name and description', () => {
    expect(keys(search('latency').rows)).toContain('w1:ops:tile:t-lat');
    expect(keys(search('p99 by shard').rows)).toContain('w1:ops:tile:t-lat');
  });

  it('matches an imported tile-local title and description', () => {
    expect(keys(search('cost override').rows)).toContain('w1:sales:tile:t-cost');
    expect(keys(search('tile note').rows)).toContain('w1:sales:tile:t-cost');
  });

  it('is case-insensitive', () => {
    expect(keys(search('LaTeNcY').rows)).toContain('w1:ops:tile:t-lat');
  });

  // A group with NO matches must keep obeying the user's own expansion: with an
  // unconditional search override its chevron could neither open (nothing to show)
  // nor stay closed once it matched, and clicking it silently wrote expansion that
  // only surfaced after the search was cleared. `ui/schema.ts`'s second level makes
  // its forcing term conditional for exactly this reason.
  it('forces a group open only when it has a match to reveal', () => {
    const searching = setTreeSearch(EMPTY_TREE_UI, 'latency');
    const tree = derive(workspace(), searching);
    // Panels has the match → forced open. Variables has none → still closed.
    expect(row(tree.rows, 'w1:ops:group:panels').expanded).toBe(true);
    expect(row(tree.rows, 'w1:ops:group:variables').expanded).toBe(false);
  });

  it('still honours persisted expansion for a group with no matches', () => {
    let ui = toggleGroupExpanded(EMPTY_TREE_UI, 'ops', 'variables');
    ui = setTreeSearch(ui, 'latency');
    // The user had Variables open; a search that does not match it must not close it.
    expect(row(derive(workspace(), ui).rows, 'w1:ops:group:variables').expanded).toBe(true);
  });

  it('shows ONLY matching descendants when the Dashboard itself did not match', () => {
    const tree = search('latency');
    // Both group rows stay (the Dashboard is exposed), but only the match shows.
    expect(keys(tree.rows)).toEqual([
      'w1:ops', 'w1:ops:group:variables', 'w1:ops:group:panels', 'w1:ops:tile:t-lat',
    ]);
  });

  it('exposes matching paths WITHOUT writing the expansion sets', () => {
    const collapsed = EMPTY_TREE_UI;
    const searching = setTreeSearch(collapsed, 'latency');
    const tree = derive(workspace(), searching);
    // Visible while searching...
    expect(keys(tree.rows)).toContain('w1:ops:tile:t-lat');
    // ...but the user's own expansion state is untouched, so clearing the search
    // restores exactly what was open before it.
    expect(searching.expandedDashboardIds).toBe(collapsed.expandedDashboardIds);
    expect(searching.expandedGroups).toBe(collapsed.expandedGroups);
    expect(keys(derive(workspace(), setTreeSearch(searching, '')).rows)).toEqual(['w1:sales', 'w1:ops']);
  });

  // #426: a search must expose paths "without mutating saved expansion state", and
  // clearing it must restore the pre-search state. A row the search is HOLDING open
  // therefore offers no toggle at all — otherwise a click on it would be invisible
  // now and surprising later, leaving a Dashboard expanded the user never expanded.
  it('offers no toggle on a row the search is forcing open', () => {
    const tree = search('latency');
    expect(row(tree.rows, 'w1:ops').toggleable).toBe(false);
    // It is genuinely open, so aria-expanded still reports that.
    expect(row(tree.rows, 'w1:ops').expanded).toBe(true);
    // The forced group likewise — and it has no action left at all, expansion being
    // the only thing a group row does. The unforced one stays toggleable.
    expect(row(tree.rows, 'w1:ops:group:panels').toggleable).toBe(false);
    expect(row(tree.rows, 'w1:ops:group:panels').single).toBeNull();
    expect(row(tree.rows, 'w1:ops:group:variables').toggleable).toBe(true);
  });

  it('keeps View/Edit navigation on a forced-open Dashboard row', () => {
    const dash = row(search('latency').rows, 'w1:ops');
    // #429/#472: only expansion is withheld. Navigation was never what the search
    // forced, and the row's primary press IS navigation now — so a forced row opens
    // like any other, where before it was a dead click.
    expect(dash.single).toMatchObject({ kind: 'open-dashboard', request: { mode: 'view' } });
    expect(dash.shift).toMatchObject({ kind: 'open-dashboard', request: { mode: 'edit' } });
    // The search forcing expansion open does not touch the row's OWN actions.
    expect(dash.actions.map((a) => a.kind)).toEqual(['edit-dashboard', 'delete-dashboard']);
  });

  it('every row is toggleable again once the search clears', () => {
    const tree = derive(workspace());
    expect(tree.rows.every((r) => r.toggleable)).toBe(true);
  });

  it('reports no-matches distinctly from an empty collection', () => {
    const tree = search('nothing matches this');
    expect(tree.rows).toEqual([]);
    expect(tree.empty).toBe('no-matches');
    // The tab count is the whole collection, never the filtered view.
    expect(tree.dashboardCount).toBe(2);
  });

  it('marks nothing as matched when no search is active', () => {
    expect(derive(workspace(), allOpen(['sales'])).rows.some((r) => r.matched)).toBe(false);
  });
});

describe('deriveDashboardTree — current resource', () => {
  const workspace = () => ws({
    dashboards: [
      dashboard({
        id: 'a', title: 'A', tiles: [{ id: 't1', queryId: 'q1' }],
        variableConfigs: { region: { sql: 'SELECT r, r' } },
      }),
      dashboard({ id: 'b', title: 'B' }),
    ],
    queries: [query('q1', 'Q1')],
  });

  it('marks the open Dashboard, and only it', () => {
    const tree = derive(workspace(), allOpen(['a']), onDashboard('a'));
    expect(row(tree.rows, 'w1:a').current).toBe(true);
    expect(row(tree.rows, 'w1:b').current).toBe(false);
  });

  it('marks nothing in Query mode', () => {
    expect(derive(workspace(), allOpen(['a'])).rows.some((r) => r.current)).toBe(false);
  });

  it('marks the current member by Dashboard-local id, per member KIND', () => {
    const tree = derive(workspace(), allOpen(['a']), onDashboard('a', { kind: 'tile', id: 't1' }));
    expect(row(tree.rows, 'w1:a:tile:t1').current).toBe(true);
    expect(row(tree.rows, 'w1:a:variable:region').current).toBe(false);
    // The Dashboard row stays marked too — both facts are shown at once.
    expect(row(tree.rows, 'w1:a').current).toBe(true);
  });

  // A variable is addressed by NAME (its only identity) — #447's
  // `DashboardFocusTarget` kind.
  it('marks the current VARIABLE by name', () => {
    const tree = derive(workspace(), allOpen(['a']), onDashboard('a', { kind: 'variable', id: 'region' }));
    expect(row(tree.rows, 'w1:a:variable:region').current).toBe(true);
    expect(row(tree.rows, 'w1:a:tile:t1').current).toBe(false);
  });

  it('never infers the current member from a QUERY id', () => {
    // 'q1' is the tile's query id; it must not resolve as a tile member id.
    const tree = derive(workspace(), allOpen(['a']), onDashboard('a', { kind: 'tile', id: 'q1' }));
    expect(tree.rows.filter((r) => r.kind === 'panel').some((r) => r.current)).toBe(false);
  });

  it('does not mark a member of a DIFFERENT Dashboard that shares its member id', () => {
    const shared = ws({
      dashboards: [
        dashboard({ id: 'a', title: 'A', tiles: [{ id: 'same', queryId: 'q1' }] }),
        dashboard({ id: 'b', title: 'B', tiles: [{ id: 'same', queryId: 'q1' }] }),
      ],
      queries: [query('q1', 'Q1')],
    });
    const tree = derive(shared, allOpen(['a', 'b']), onDashboard('b', { kind: 'tile', id: 'same' }));
    expect(row(tree.rows, 'w1:a:tile:same').current).toBe(false);
    expect(row(tree.rows, 'w1:b:tile:same').current).toBe(true);
  });
});

describe('deriveDashboardTree — command sets', () => {
  const tree = () => derive(ws({
    dashboards: [dashboard({
      id: 'd', title: 'D',
      tiles: [{ id: 't1', queryId: 'q1' }],
      variableConfigs: { region: { sql: 'SELECT r, r' } },
    })],
    queries: [query('q1', 'Q1')],
  }), allOpen(['d']));

  // #429/#472 — the Dashboard row's primary press OPENS View (it used to expand,
  // deferred behind a double-click window). `double: null` is what tells the view it
  // has nothing to arbitrate, so the press can act at once; expansion moved to the
  // chevron, which is a target of its own.
  it('gives a Dashboard row View / Edit and NO double action, with no focus target', () => {
    const dash = row(tree().rows, 'w1:d');
    expect(dash.single).toEqual({ kind: 'open-dashboard', request: { dashboardId: 'd', mode: 'view' } });
    expect(dash.double).toBeNull();
    expect(dash.shift).toEqual({ kind: 'open-dashboard', request: { dashboardId: 'd', mode: 'edit' } });
    // Both requests name the Dashboard alone: a Dashboard row focuses no member.
    expect('focus' in (dash.single as { request: object }).request).toBe(false);
    // #494 removed the `⋯` menu — *Open in Edit* was its last item, and Shift
    // (asserted above via `shift`) is still how Edit is reached. The row's
    // vocabulary is now its two direct actions, and nothing else mirrors a menu.
    expect(dash.actions.map((a) => a.kind)).toEqual(['edit-dashboard', 'delete-dashboard']);
  });

  it('gives a group row ONLY a toggle — no double, no Shift, no actions', () => {
    const group = row(tree().rows, 'w1:d:group:panels');
    expect(group.single).toEqual({ kind: 'toggle' });
    expect(group.double).toBeNull();
    expect(group.shift).toBeNull();
    expect(group.actions).toEqual([]);
  });

  it('gives a panel row query-open plus tile-focused View/Edit, addressed by TILE id', () => {
    const panel = row(tree().rows, 'w1:d:tile:t1');
    expect(panel.single).toEqual({ kind: 'open-query', queryId: 'q1' });
    // Never focused by query id — the request carries the Dashboard-local tile id.
    expect(panel.double).toEqual({
      kind: 'open-dashboard',
      request: { dashboardId: 'd', mode: 'view', focus: { kind: 'tile', id: 't1' } },
    });
    expect(panel.shift).toEqual({
      kind: 'open-dashboard',
      request: { dashboardId: 'd', mode: 'edit', focus: { kind: 'tile', id: 't1' } },
    });
    // #494 removed the `⋯` menu — Open query/View/Edit are the gestures above;
    // this healthy panel's SOLE owner is this tile, so its own edit/delete
    // controls are fully resolved rather than withheld.
    expect(panel.actions.map((a) => a.kind)).toEqual(['edit-panel', 'delete-panel']);
    expect(panel.actions.every((a) => a.target !== null)).toBe(true);
    expect(panel.actions.every((a) => a.unavailable === null)).toBe(true);
  });

  // #447: a variable row activates its own editor and offers NOTHING else — no
  // `…` menu (the issue forbids it), and no hidden double/Shift gesture a menu
  // would have to expose.
  it('gives a variable row open-variable and no double or Shift action', () => {
    const variable = row(tree().rows, 'w1:d:variable:region');
    expect(variable.single).toEqual({ kind: 'open-variable', dashboardId: 'd', name: 'region' });
    expect(variable.double).toBeNull();
    expect(variable.shift).toBeNull();
    // 'region' is declared by no panel SQL in this fixture (the tile's query is
    // plain `SELECT 1`), so it is the orphaned case — its ONE action is the
    // trash, never a menu mirroring the gestures above.
    expect(variable.actions.map((a) => a.kind)).toEqual(['delete-variable-config']);
    expect(variable.queryId).toBeNull();
    expect(variable.member).toEqual({ kind: 'variable', id: 'region' });
  });

  // #429 phase 3 / #494: editing is now expressed as an `edit-*` action rather
  // than a `renamable` boolean — a Dashboard row and a healthy Panel row both
  // carry one; a group or variable row never does (a variable's own SQL is
  // reached through its `open-variable` command, not a pencil).
  it('offers an edit action on the Dashboard row and the Panel row only', () => {
    const rows = tree().rows;
    expect(row(rows, 'w1:d').actions.some((a) => a.kind === 'edit-dashboard')).toBe(true);
    expect(row(rows, 'w1:d:group:panels').actions.some((a) => a.kind.startsWith('edit-'))).toBe(false);
    expect(row(rows, 'w1:d:group:variables').actions.some((a) => a.kind.startsWith('edit-'))).toBe(false);
    expect(row(rows, 'w1:d:tile:t1').actions.some((a) => a.kind === 'edit-panel')).toBe(true);
    expect(row(rows, 'w1:d:variable:region').actions.some((a) => a.kind.startsWith('edit-'))).toBe(false);
  });

  it('marks member rows as non-expandable leaves at level 3', () => {
    for (const key of ['w1:d:variable:region', 'w1:d:tile:t1']) {
      const member = row(tree().rows, key);
      expect(member.expandable).toBe(false);
      expect(member.expanded).toBe(false);
      expect(member.level).toBe(3);
    }
  });
});

// #494 replaced `menu` / `deletable` / `renamable` with one resolved `actions`
// list per row. These are the CONTRACT for `panelActions` and the Dashboard /
// variable action literals — every branch that decides `target: null` vs a
// resolved target is exercised here, not just the shape of the field.
describe('deriveDashboardTree — direct actions (#494)', () => {
  it('gives a healthy Panel row edit and delete, in that order, fully resolved', () => {
    const tree = derive(ws({
      dashboards: [dashboard({ id: 'd', title: 'D', tiles: [{ id: 't1', queryId: 'q1' }] })],
      queries: [query('q1', 'Q1')],
    }), allOpen(['d']));
    const panel = row(tree.rows, 'w1:d:tile:t1');
    // Accessible names identify the RESOURCE, never a bare "Edit" — a screen
    // reader hears many rows' buttons in sequence.
    expect(panel.actions).toEqual([
      {
        kind: 'edit-panel', label: 'Edit Q1', tooltip: 'Edit name & description',
        target: { kind: 'panel', dashboardId: 'd', tileId: 't1', queryId: 'q1' },
        unavailable: null, confirm: null,
      },
      {
        kind: 'delete-panel', label: 'Remove Q1 from dashboard', tooltip: 'Remove panel',
        target: { kind: 'panel', dashboardId: 'd', tileId: 't1', queryId: 'q1' },
        unavailable: null,
        confirm: 'Remove panel “Q1” from “D”? This also deletes its dedicated query copy.',
      },
    ]);
  });

  it('names the Dashboard row\'s own controls "Edit dashboard <title>" / "Delete dashboard <title>"', () => {
    const tree = derive(ws({ dashboards: [dashboard({ id: 'd', title: 'D' })] }));
    const dash = row(tree.rows, 'w1:d');
    expect(dash.actions.map((a) => a.kind)).toEqual(['edit-dashboard', 'delete-dashboard']);
    expect(dash.actions.map((a) => a.label)).toEqual(['Edit dashboard D', 'Delete dashboard D']);
    expect(dash.actions[1].confirm).toBe('Delete dashboard “D”? This also deletes every query its panels own.');
  });

  it('falls back to the row\'s own Untitled label in an action name, on both row kinds', () => {
    const tree = derive(ws({
      dashboards: [dashboard({ id: 'd', title: '   ', tiles: [{ id: 't1', queryId: 'q1' }] })],
      queries: [query('q1')],
    }), allOpen(['d']));
    const dash = row(tree.rows, 'w1:d');
    const panel = row(tree.rows, 'w1:d:tile:t1');
    // Same fallback the ROW itself displays — never a second, disagreeing default.
    expect(dash.label).toBe(UNTITLED_DASHBOARD);
    expect(panel.label).toBe(UNTITLED_PANEL);
    expect(dash.actions.map((a) => a.label)).toEqual([
      'Edit dashboard ' + UNTITLED_DASHBOARD, 'Delete dashboard ' + UNTITLED_DASHBOARD,
    ]);
    expect(panel.actions.map((a) => a.label)).toEqual([
      'Edit ' + UNTITLED_PANEL, 'Remove ' + UNTITLED_PANEL + ' from dashboard',
    ]);
    expect(panel.actions[1].confirm).toBe(
      'Remove panel “' + UNTITLED_PANEL + '” from “' + UNTITLED_DASHBOARD
      + '”? This also deletes its dedicated query copy.',
    );
  });

  // The #427 exactly-one-owner rule, checked against every shape that fails it.
  // Every case asserts the SAME shape — both panel actions withheld, the row's
  // own navigation untouched — so a future branch that forgets one arm shows up
  // as a failing case here rather than a silent regression.
  describe('the #427 exactly-one-owner rule (malformed ownership)', () => {
    const bothUnavailable = (member: DashboardTreeRow): void => {
      expect(member.actions.map((a) => a.kind)).toEqual(['edit-panel', 'delete-panel']);
      for (const a of member.actions) {
        expect(a.target).toBeNull();
        expect(a.confirm).toBeNull();
        expect(a.unavailable).not.toBeNull();
      }
    };

    it('(a) withholds both actions when the queryId names no query in the collection', () => {
      const tree = derive(ws({
        dashboards: [dashboard({ id: 'd', title: 'D', tiles: [{ id: 't1', queryId: 'q-gone' }] })],
        queries: [],
      }), allOpen(['d']));
      const panel = row(tree.rows, 'w1:d:tile:t1');
      bothUnavailable(panel);
      expect(panel.actions[0].unavailable).toContain('not in this workspace');
      // The broken reference still leaves View/Edit focus navigation reachable —
      // only the operation that needs the missing query is withheld.
      expect(panel.single).toBeNull();
      expect(panel.double).toMatchObject({ kind: 'open-dashboard' });
      expect(panel.shift).toMatchObject({ kind: 'open-dashboard' });
    });

    it('(b) withholds both actions on TWO tiles of the SAME Dashboard sharing one query', () => {
      const tree = derive(ws({
        dashboards: [dashboard({
          id: 'd', title: 'D',
          tiles: [{ id: 't1', queryId: 'q1' }, { id: 't2', queryId: 'q1' }],
        })],
        queries: [query('q1', 'Q1')],
      }), allOpen(['d']));
      const t1 = row(tree.rows, 'w1:d:tile:t1');
      const t2 = row(tree.rows, 'w1:d:tile:t2');
      bothUnavailable(t1);
      bothUnavailable(t2);
      expect(t1.actions[0].unavailable).toContain('shared with another panel');
      // The query itself resolves fine, so the row's own open-query gesture and
      // Dashboard focus navigation are both untouched.
      expect(t1.single).toEqual({ kind: 'open-query', queryId: 'q1' });
      expect(t2.single).toEqual({ kind: 'open-query', queryId: 'q1' });
      expect(t1.double).toMatchObject({ kind: 'open-dashboard' });
    });

    it('(c) withholds both actions on two tiles of DIFFERENT Dashboards sharing one query', () => {
      const tree = derive(ws({
        dashboards: [
          dashboard({ id: 'd1', title: 'D1', tiles: [{ id: 't1', queryId: 'shared' }] }),
          dashboard({ id: 'd2', title: 'D2', tiles: [{ id: 't2', queryId: 'shared' }] }),
        ],
        queries: [query('shared', 'Shared')],
      }), allOpen(['d1', 'd2']));
      const t1 = row(tree.rows, 'w1:d1:tile:t1');
      const t2 = row(tree.rows, 'w1:d2:tile:t2');
      bothUnavailable(t1);
      bothUnavailable(t2);
      expect(t1.actions[0].unavailable).toContain('shared with another panel');
      expect(t1.single).toEqual({ kind: 'open-query', queryId: 'shared' });
      expect(t2.single).toEqual({ kind: 'open-query', queryId: 'shared' });
    });

    it('(d) withholds both actions on a tile with NO queryId at all', () => {
      const tree = derive(ws({
        dashboards: [dashboard({ id: 'd', title: 'D', tiles: [{ id: 't1' }] })],
      }), allOpen(['d']));
      const panel = row(tree.rows, 'w1:d:tile:t1');
      bothUnavailable(panel);
      expect(panel.actions[0].unavailable).toContain('not in this workspace');
      expect(panel.single).toBeNull();
    });

    it('gives a missing query and a shared query DIFFERENT reasons', () => {
      const missing = derive(ws({
        dashboards: [dashboard({ id: 'd', title: 'D', tiles: [{ id: 't1', queryId: 'q-gone' }] })],
      }), allOpen(['d']));
      const shared = derive(ws({
        dashboards: [dashboard({
          id: 'd', title: 'D', tiles: [{ id: 't1', queryId: 'q1' }, { id: 't2', queryId: 'q1' }],
        })],
        queries: [query('q1', 'Q1')],
      }), allOpen(['d']));
      const missingReason = row(missing.rows, 'w1:d:tile:t1').actions[0].unavailable;
      const sharedReason = row(shared.rows, 'w1:d:tile:t1').actions[0].unavailable;
      expect(missingReason).not.toBe(sharedReason);
    });
  });

  // A different failure shape than the #427 exactly-one-owner rule above:
  // this is an ambiguous ID, not an ownership conflict — the #427 index alone
  // cannot see it (each query still has exactly one owner), which is exactly
  // why deriveDashboardTree has to check cardinality on the id itself, ahead
  // of ownership, and why `removeDashboardPanel`/`removeDashboardDocument`
  // already refuse the same shapes (`dashboard-duplicate`/`tile-duplicate`).
  describe('ambiguous Dashboard/tile identity', () => {
    it('withholds Dashboard edit/delete on TWO Dashboard documents sharing one id', () => {
      const tree = derive(ws({
        dashboards: [
          dashboard({ id: 'd', title: 'D1', tiles: [{ id: 't1', queryId: 'q1' }] }),
          dashboard({ id: 'd', title: 'D2' }),
        ],
        queries: [query('q1', 'Q1')],
      }), allOpen(['d']));
      const dupes = tree.rows.filter((r) => r.key === 'w1:d');
      expect(dupes).toHaveLength(2);
      for (const dash of dupes) {
        expect(dash.actions.map((a) => a.kind)).toEqual(['edit-dashboard', 'delete-dashboard']);
        for (const a of dash.actions) {
          expect(a.target).toBeNull();
          expect(a.confirm).toBeNull();
          expect(a.unavailable).toContain('share this id');
        }
      }
      // The ambiguity cascades to the panels underneath: which Dashboard "d"
      // even is has no answer, so its tiles cannot be resolved either.
      const panel = row(tree.rows, 'w1:d:tile:t1');
      expect(panel.actions.map((a) => a.kind)).toEqual(['edit-panel', 'delete-panel']);
      for (const a of panel.actions) {
        expect(a.target).toBeNull();
        expect(a.unavailable).toContain('share this id');
      }
    });

    it('withholds panel edit/delete on TWO tiles of the SAME Dashboard sharing one tileId, even when they reference DIFFERENT queries', () => {
      const tree = derive(ws({
        dashboards: [dashboard({
          id: 'd', title: 'D',
          tiles: [{ id: 't1', queryId: 'q1' }, { id: 't1', queryId: 'q2' }],
        })],
        queries: [query('q1', 'Q1'), query('q2', 'Q2')],
      }), allOpen(['d']));
      const dupes = tree.rows.filter((r) => r.key === 'w1:d:tile:t1');
      expect(dupes).toHaveLength(2);
      for (const panel of dupes) {
        expect(panel.actions.map((a) => a.kind)).toEqual(['edit-panel', 'delete-panel']);
        for (const a of panel.actions) {
          expect(a.target).toBeNull();
          expect(a.confirm).toBeNull();
          expect(a.unavailable).toContain('share this id');
        }
        // Each tile still resolves its OWN open-query gesture — only the
        // identity-addressed edit/delete controls are withheld.
      }
      expect(dupes[0].single).toEqual({ kind: 'open-query', queryId: 'q1' });
      expect(dupes[1].single).toEqual({ kind: 'open-query', queryId: 'q2' });
    });
  });

  it('gives no actions to a group row or an ACTIVE (non-orphaned) variable row', () => {
    const tree = derive(ws({
      dashboards: [dashboard({ id: 'd', title: 'D', tiles: [{ id: 't1', queryId: 'q1' }] })],
      queries: [query('q1', 'Q1', undefined, 'SELECT 1 WHERE c = {country:String}')],
    }), allOpen(['d']));
    expect(row(tree.rows, 'w1:d:group:panels').actions).toEqual([]);
    expect(row(tree.rows, 'w1:d:group:variables').actions).toEqual([]);
    expect(row(tree.rows, 'w1:d:variable:country').actions).toEqual([]);
  });

  it('gives an orphaned variable row exactly one action, with its confirm sentence', () => {
    const tree = derive(ws({
      dashboards: [dashboard({ id: 'd', title: 'D', variableConfigs: { region: { sql: 'SELECT r, r' } } })],
    }), allOpen(['d']));
    const orphan = row(tree.rows, 'w1:d:variable:region');
    expect(orphan.actions).toEqual([{
      kind: 'delete-variable-config',
      label: 'Delete the stored option SQL for region',
      tooltip: 'Delete stored option SQL',
      target: { kind: 'variable-config', dashboardId: 'd', name: 'region' },
      unavailable: null,
      confirm: 'Delete the stored option SQL for “region”? The SQL is lost.',
    }]);
  });
});

describe('dashboardVariables', () => {
  const workspace = ws({
    dashboards: [dashboard({
      id: 'd', tiles: [{ id: 't1', queryId: 'q1', title: 'Sales panel' }],
      variableConfigs: { gone: { sql: 'SELECT g, g' } },
    })],
    queries: [query('q1', 'Q1', undefined, 'SELECT 1 WHERE c = {country:String}')],
  });

  it('answers with the same variables, in the same order, as the tree rows', () => {
    expect(dashboardVariables(workspace, 'd').map((v) => v.name)).toEqual(
      labels(variableRows(derive(workspace, allOpen(['d'])).rows)),
    );
  });

  it('carries the stored SQL and the tree\'s own panel labels', () => {
    const [country, gone] = dashboardVariables(workspace, 'd');
    expect(country.sql).toBeNull();
    expect(country.declarations[0].tileId).toBe('t1');
    expect(gone.sql).toBe('SELECT g, g');
    expect(gone.status).toBe('orphaned');
  });

  it('answers with nothing for an unknown Dashboard id, a null workspace, or no collection', () => {
    expect(dashboardVariables(workspace, 'nope')).toEqual([]);
    expect(dashboardVariables(null, 'd')).toEqual([]);
    expect(dashboardVariables({ id: 'w1' }, 'd')).toEqual([]);
  });

  it('tolerates a workspace with a null query collection', () => {
    // Same loosened input shape the tree derivation accepts: no queries means no
    // declarations, so only the stored configuration survives — as an orphan.
    const variables = dashboardVariables({
      id: 'w1', queries: null,
      dashboards: [dashboard({ id: 'd', tiles: [{ id: 't1', queryId: 'q1' }], variableConfigs: { a: { sql: 'SELECT a, a' } } })],
    }, 'd');
    expect(variables.map((v) => [v.name, v.status])).toEqual([['a', 'orphaned']]);
  });
});

describe('the unused status word', () => {
  it('is the literal word the view renders', () => {
    // Exported so the model and the view can never disagree about the word a
    // warning row shows.
    expect(UNUSED_VARIABLE_STATUS).toBe('unused');
  });
});

describe('deriveDashboardTree — Library-query drop targets (#428)', () => {
  /** One Dashboard with a declaring panel (`country`), a conflicting second
   *  declaration, and an orphaned configuration (`region`). */
  const fixture = () => ws({
    queries: [
      query('q1', 'Revenue', undefined, 'SELECT * FROM r WHERE c = {country:String}'),
      query('q2', 'Cost', undefined, 'SELECT {country:UInt8}, {zone:String}'),
    ],
    dashboards: [dashboard({
      id: 'd1',
      tiles: [{ id: 't1', queryId: 'q1' }, { id: 't2', queryId: 'q2' }],
      variableConfigs: { region: { sql: 'SELECT r, r FROM regions' } },
    })],
  });

  const targets = (rows: readonly DashboardTreeRow[]): Record<string, unknown> =>
    Object.fromEntries(rows.map((r) => [r.key, r.dropTarget]));

  it('accepts on the Dashboard row and the Panels group — both mean the same write', () => {
    const rows = derive(fixture(), allOpen(['d1'])).rows;
    expect(row(rows, 'w1:d1').dropTarget).toEqual({ kind: 'panel', dashboardId: 'd1' });
    expect(row(rows, 'w1:d1:group:panels').dropTarget).toEqual({ kind: 'panel', dashboardId: 'd1' });
  });

  it('accepts on an inferred variable row, carrying its exact name', () => {
    const rows = derive(fixture(), allOpen(['d1'])).rows;
    expect(row(rows, 'w1:d1:variable:country').dropTarget)
      .toEqual({ kind: 'variable', dashboardId: 'd1', variableName: 'country' });
  });

  it('accepts on a CONFLICTED variable — it is inferred and names a real variable', () => {
    const rows = derive(fixture(), allOpen(['d1'])).rows;
    const conflicted = row(rows, 'w1:d1:variable:country');
    expect(conflicted.invalid).toBe('variable-conflict');
    expect(conflicted.dropTarget).not.toBeNull();
  });

  it('rejects the Variables group — it does not identify which variable', () => {
    const rows = derive(fixture(), allOpen(['d1'])).rows;
    expect(row(rows, 'w1:d1:group:variables').dropTarget).toBeNull();
  });

  it('rejects an ORPHANED variable row, which stays editable and deletable', () => {
    const rows = derive(fixture(), allOpen(['d1'])).rows;
    const orphan = row(rows, 'w1:d1:variable:region');
    expect(orphan.actions.map((a) => a.kind)).toEqual(['delete-variable-config']);
    expect(orphan.dropTarget).toBeNull();
  });

  it('rejects an individual panel row', () => {
    const rows = derive(fixture(), allOpen(['d1'])).rows;
    expect(row(rows, 'w1:d1:tile:t1').dropTarget).toBeNull();
    expect(row(rows, 'w1:d1:tile:t2').dropTarget).toBeNull();
  });

  it('resolves exactly one decision per row across the whole tree', () => {
    // The full matrix in one assertion, so a new row kind cannot slip through
    // with an accidental default.
    expect(targets(derive(fixture(), allOpen(['d1'])).rows)).toEqual({
      'w1:d1': { kind: 'panel', dashboardId: 'd1' },
      'w1:d1:group:variables': null,
      'w1:d1:variable:country': { kind: 'variable', dashboardId: 'd1', variableName: 'country' },
      'w1:d1:variable:zone': { kind: 'variable', dashboardId: 'd1', variableName: 'zone' },
      'w1:d1:variable:region': null,
      'w1:d1:group:panels': { kind: 'panel', dashboardId: 'd1' },
      'w1:d1:tile:t1': null,
      'w1:d1:tile:t2': null,
    });
  });

  it('an empty Dashboard still offers both stable panel targets', () => {
    // #426 keeps both group rows visible while a Dashboard is expanded precisely
    // so an empty Dashboard has somewhere to drop.
    const rows = derive(ws({ dashboards: [dashboard({ id: 'empty' })] }), allOpen(['empty'])).rows;
    expect(row(rows, 'w1:empty').dropTarget).toEqual({ kind: 'panel', dashboardId: 'empty' });
    expect(row(rows, 'w1:empty:group:panels').dropTarget)
      .toEqual({ kind: 'panel', dashboardId: 'empty' });
  });

  it('preserves case-sensitive variable identity in the target', () => {
    const cased = ws({
      queries: [query('q1', 'Q', undefined, 'SELECT {Country:String}')],
      dashboards: [dashboard({ id: 'd1', tiles: [{ id: 't1', queryId: 'q1' }] })],
    });
    expect(row(derive(cased, allOpen(['d1'])).rows, 'w1:d1:variable:Country').dropTarget)
      .toEqual({ kind: 'variable', dashboardId: 'd1', variableName: 'Country' });
  });

  it('withholds edit and delete from a tile whose query is not a PANEL query', () => {
    // The semantic validator calls this out (`dashboard-setup-reference` /
    // `dashboard-tile-role-incompatible`). Offering the controls anyway would
    // let a delete "repair" the workspace by destroying the evidence.
    const tree = deriveDashboardTree({
      workspace: {
        id: 'w1',
        queries: [{ id: 'q1', sql: 'SELECT 1', spec: { name: 'Setup', dashboard: { role: 'setup' } } }],
        dashboards: [{ id: 'd1', title: 'D', tiles: [{ id: 't1', queryId: 'q1' }] }],
      },
      surface: QUERY_SURFACE,
      ui: allOpen(['d1']),
    });
    const panel = tree.rows.find((row) => row.kind === 'panel')!;
    expect(panel.actions.map((action) => action.kind)).toEqual(['edit-panel', 'delete-panel']);
    for (const action of panel.actions) {
      expect(action.target).toBeNull();
      expect(action.unavailable).toBe(
        'This panel references a query that is not a panel query, so it cannot be edited or removed here.',
      );
    }
    // The row itself still navigates — only the WRITES are withheld.
    expect(panel.single).not.toBeNull();
    expect(panel.double).not.toBeNull();
  });

  it('withholds edit and delete when TWO query documents carry the panel\'s query id', () => {
    // The commit paths refuse this state, so the model must not offer a
    // control that opens a dialog only to refuse at the end of it. The
    // projection collapses duplicates into one map entry, so cardinality is
    // counted separately.
    const query = { id: 'q1', sql: 'SELECT 1', spec: { name: 'Twin' } };
    const tree = deriveDashboardTree({
      workspace: {
        id: 'w1',
        queries: [query, query],
        dashboards: [{ id: 'd1', title: 'D', tiles: [{ id: 't1', queryId: 'q1' }] }],
      },
      surface: QUERY_SURFACE,
      ui: allOpen(['d1']),
    });
    const panel = tree.rows.find((row) => row.kind === 'panel')!;
    expect(panel.actions.map((action) => action.kind)).toEqual(['edit-panel', 'delete-panel']);
    for (const action of panel.actions) {
      expect(action.target).toBeNull();
      expect(action.unavailable).toBe(
        'Two saved queries in this workspace share this panel’s query id, so it cannot be edited or removed here.',
      );
    }
  });
});
