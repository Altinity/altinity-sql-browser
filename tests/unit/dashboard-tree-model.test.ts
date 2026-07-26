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
    expect(only.deletable).toBe(false);
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
    // Never deletable: there is no stored configuration behind a conflict.
    expect(rows[0].deletable).toBe(false);
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
    expect(orphan.deletable).toBe(true);
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
    expect(broken.menu.map((item) => item.command === null)).toEqual([true, false, false]);
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
    expect(row(tree.rows, 'w1:ops').single).toBeNull();
    // It is genuinely open, so aria-expanded still reports that.
    expect(row(tree.rows, 'w1:ops').expanded).toBe(true);
    // The forced group likewise; the unforced one stays toggleable.
    expect(row(tree.rows, 'w1:ops:group:panels').toggleable).toBe(false);
    expect(row(tree.rows, 'w1:ops:group:variables').toggleable).toBe(true);
  });

  it('keeps View/Edit navigation on a forced-open Dashboard row', () => {
    const dash = row(search('latency').rows, 'w1:ops');
    // Only the toggle is withheld — the row is still a navigation target.
    expect(dash.double).toMatchObject({ kind: 'open-dashboard' });
    expect(dash.shift).toMatchObject({ kind: 'open-dashboard' });
    expect(dash.menu).toHaveLength(2);
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

  it('gives a Dashboard row toggle / View / Edit, with NO focus target', () => {
    const dash = row(tree().rows, 'w1:d');
    expect(dash.single).toEqual({ kind: 'toggle' });
    expect(dash.double).toEqual({ kind: 'open-dashboard', request: { dashboardId: 'd', mode: 'view' } });
    expect(dash.shift).toEqual({ kind: 'open-dashboard', request: { dashboardId: 'd', mode: 'edit' } });
    expect(dash.menu.map((item) => item.label)).toEqual(['Open in View', 'Open in Edit']);
    expect(dash.menu.every((item) => item.command !== null)).toBe(true);
  });

  it('gives a group row ONLY a toggle — no double, no Shift, no menu', () => {
    const group = row(tree().rows, 'w1:d:group:panels');
    expect(group.single).toEqual({ kind: 'toggle' });
    expect(group.double).toBeNull();
    expect(group.shift).toBeNull();
    expect(group.menu).toEqual([]);
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
    expect(panel.menu.map((item) => item.label)).toEqual([
      'Open query',
      'Open Dashboard in View and focus panel',
      'Open Dashboard in Edit and focus panel',
    ]);
  });

  // #447: a variable row activates its own editor and offers NOTHING else — no
  // `…` menu (the issue forbids it), and no hidden double/Shift gesture a menu
  // would have to expose.
  it('gives a variable row open-variable and no menu, double or Shift action', () => {
    const variable = row(tree().rows, 'w1:d:variable:region');
    expect(variable.single).toEqual({ kind: 'open-variable', dashboardId: 'd', name: 'region' });
    expect(variable.double).toBeNull();
    expect(variable.shift).toBeNull();
    expect(variable.menu).toEqual([]);
    expect(variable.queryId).toBeNull();
    expect(variable.member).toEqual({ kind: 'variable', id: 'region' });
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
