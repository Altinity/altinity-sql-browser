import { describe, expect, it } from 'vitest';
import {
  UNTITLED_DASHBOARD, UNTITLED_FILTER, UNTITLED_PANEL, deriveDashboardTree,
  type DashboardTreeRow, type TreeDashboard, type TreeWorkspace,
} from '../../src/application/dashboard-tree-model.js';
import {
  EMPTY_TREE_UI, setTreeSearch, toggleDashboardExpanded, toggleGroupExpanded,
  type DashboardTreeUiState,
} from '../../src/application/dashboard-tree-ui-state.js';
import { QUERY_SURFACE, type MainSurfaceState } from '../../src/application/main-surface.js';
import type { DashboardDocumentV1, SavedQueryV2, StoredWorkspaceV3 } from '../../src/generated/json-schema.types.js';

const query = (id: string, name?: string, description?: string): SavedQueryV2 => ({
  id, sql: 'SELECT 1', specVersion: 1,
  spec: { specVersion: 1, ...(name === undefined ? {} : { name }), ...(description === undefined ? {} : { description }) },
});

const dashboard = (over: Partial<TreeDashboard> & { id: string }): TreeDashboard => ({
  filters: [], tiles: [], ...over,
});

const ws = (over: Partial<TreeWorkspace> = {}): TreeWorkspace => ({
  id: 'w1', dashboards: [], queries: [], ...over,
});

const onDashboard = (
  dashboardId: string, currentMember: MainSurfaceState extends never ? never : { kind: 'tile' | 'filter'; id: string } | null = null,
): MainSurfaceState => ({ kind: 'dashboard', dashboardId, mode: 'edit', currentMember, pendingFocus: null });

/** Expand a Dashboard and both its groups — the usual "show me everything" state. */
const allOpen = (dashboardIds: string[]): DashboardTreeUiState => {
  let ui = EMPTY_TREE_UI;
  for (const id of dashboardIds) {
    ui = toggleDashboardExpanded(ui, id);
    ui = toggleGroupExpanded(ui, id, 'filters');
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

  it('counts PANELS only — filters are Dashboard-level controls', () => {
    const tree = derive(ws({
      dashboards: [dashboard({
        id: 'd', title: 'D',
        tiles: [{ id: 't1', queryId: 'q1' }],
        filters: [{ id: 'f1', parameter: 'a' }, { id: 'f2', parameter: 'b' }],
      })],
      queries: [query('q1', 'Q1')],
    }));
    expect(row(tree.rows, 'w1:d').meta).toBe('1');
  });

  it('keys rows by workspace + Dashboard + member id, never by index or label', () => {
    const tree = derive(ws({
      dashboards: [dashboard({
        id: 'd', title: 'D',
        filters: [{ id: 'f1', parameter: 'region' }],
        tiles: [{ id: 't1', queryId: 'q1' }],
      })],
      queries: [query('q1', 'Q1')],
    }), allOpen(['d']));
    expect(keys(tree.rows)).toEqual([
      'w1:d', 'w1:d:group:filters', 'w1:d:filter:f1', 'w1:d:group:panels', 'w1:d:tile:t1',
    ]);
  });

  it('reports an empty collection, and a null workspace, as no-dashboards', () => {
    expect(derive(ws()).empty).toBe('no-dashboards');
    expect(derive(ws()).rows).toEqual([]);
    const none = derive(null);
    expect(none.empty).toBe('no-dashboards');
    expect(none.dashboardCount).toBe(0);
  });

  it('accepts a real StoredWorkspaceV3 with no cast', () => {
    const real: StoredWorkspaceV3 = {
      storageVersion: 3, id: 'w1', key: 'ops', name: 'Ops',
      queries: [query('q1', 'Sales')],
      dashboards: [{
        documentVersion: 1, id: 'd', title: 'D', revision: 1,
        layout: { type: 'flow', version: 1, preset: 'report', items: {} },
        filters: [], tiles: [{ id: 't1', queryId: 'q1' }],
      } satisfies DashboardDocumentV1],
    };
    expect(deriveDashboardTree({ workspace: real, surface: QUERY_SURFACE, ui: EMPTY_TREE_UI })
      .rows.map((r) => r.label)).toEqual(['D']);
  });
});

describe('deriveDashboardTree — groups', () => {
  it('always renders Filters BEFORE Panels, and keeps both visible when EMPTY', () => {
    const tree = derive(ws({ dashboards: [dashboard({ id: 'd', title: 'D' })] }), toggleDashboardExpanded(EMPTY_TREE_UI, 'd'));
    const groups = tree.rows.filter((r) => r.kind === 'group');
    expect(groups.map((r) => r.label)).toEqual(['Filters', 'Panels']);
    // #428 will use them as stable drop targets, so an empty group is still a row.
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
        filters: [{ id: 'f1', parameter: 'a' }],
        tiles: [{ id: 't1', queryId: 'q1' }, { id: 't2', queryId: 'q1' }],
      })],
      queries: [query('q1', 'Q1')],
    });
    const onlyPanels = toggleGroupExpanded(toggleDashboardExpanded(EMPTY_TREE_UI, 'd'), 'd', 'panels');
    const tree = derive(workspace, onlyPanels);
    expect(row(tree.rows, 'w1:d:group:filters').count).toBe(1);
    expect(row(tree.rows, 'w1:d:group:filters').expanded).toBe(false);
    expect(row(tree.rows, 'w1:d:group:panels').count).toBe(2);
    // Only the expanded group contributes member rows.
    expect(keys(tree.rows).filter((k) => k.includes(':filter:'))).toEqual([]);
    expect(keys(tree.rows).filter((k) => k.includes(':tile:'))).toEqual(['w1:d:tile:t1', 'w1:d:tile:t2']);
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

  it('resolves a filter label: label, then source-query name, then parameter, then Untitled filter', () => {
    const tree = derive(ws({
      dashboards: [dashboard({
        id: 'd', title: 'D',
        filters: [
          { id: 'f1', parameter: 'region', label: '  Region  ' },
          { id: 'f2', parameter: 'region', sourceQueryId: 'q-src' },
          { id: 'f3', parameter: 'plain' },
          { id: 'f4' },
        ],
      })],
      queries: [query('q-src', 'Source name')],
    }), allOpen(['d']));
    expect(labels(tree.rows.filter((r) => r.kind === 'filter')))
      .toEqual(['Region', 'Source name', 'plain', UNTITLED_FILTER]);
  });
});

describe('deriveDashboardTree — transitional and invalid references', () => {
  const workspace = () => ws({
    dashboards: [dashboard({
      id: 'd', title: 'D',
      filters: [
        { id: 'f-sourceless', parameter: 'region' },
        { id: 'f-broken', parameter: 'zone', sourceQueryId: 'q-gone' },
        { id: 'f-ok', parameter: 'city', sourceQueryId: 'q1' },
      ],
      tiles: [{ id: 't-ok', queryId: 'q1' }, { id: 't-broken', queryId: 'q-gone' }],
    })],
    queries: [query('q1', 'Q1')],
  });

  it('treats an ABSENT filter source as transitional, not as a broken reference', () => {
    // Before #427 a curated filter legitimately has no sourceQueryId. The row
    // stays, query-open is simply unavailable, and there is NO diagnostic.
    const sourceless = row(derive(workspace(), allOpen(['d'])).rows, 'w1:d:filter:f-sourceless');
    expect(sourceless.invalid).toBeNull();
    expect(sourceless.diagnostic).toBeNull();
    expect(sourceless.queryId).toBeNull();
    expect(sourceless.single).toBeNull();
    expect(sourceless.menu[0].command).toBeNull();
  });

  it('renders a PRESENT-but-unresolved filter source as a diagnostic row', () => {
    const broken = row(derive(workspace(), allOpen(['d'])).rows, 'w1:d:filter:f-broken');
    expect(broken.invalid).toBe('unresolved-source');
    expect(broken.diagnostic).toContain('option-source query');
    expect(broken.single).toBeNull();
  });

  it('renders an unresolved PANEL query as a diagnostic row', () => {
    const broken = row(derive(workspace(), allOpen(['d'])).rows, 'w1:d:tile:t-broken');
    expect(broken.invalid).toBe('unresolved-query');
    expect(broken.diagnostic).toContain('cannot be opened');
    expect(broken.single).toBeNull();
    expect(broken.queryId).toBeNull();
  });

  it('keeps Dashboard View/Edit focus navigation available on every broken row', () => {
    // A broken member's diagnostics must stay reachable — only the operation that
    // needs the missing query is withheld.
    for (const key of ['w1:d:filter:f-sourceless', 'w1:d:filter:f-broken', 'w1:d:tile:t-broken']) {
      const broken = row(derive(workspace(), allOpen(['d'])).rows, key);
      expect(broken.double).toMatchObject({ kind: 'open-dashboard' });
      expect(broken.shift).toMatchObject({ kind: 'open-dashboard' });
      // Query-open is the ONLY thing withheld.
      expect(broken.menu.map((item) => item.command === null)).toEqual([true, false, false]);
    }
  });

  it('never hides the Dashboard because one reference is bad', () => {
    const tree = derive(workspace(), allOpen(['d']));
    expect(row(tree.rows, 'w1:d')).toBeDefined();
    expect(tree.rows.filter((r) => r.kind === 'filter')).toHaveLength(3);
    expect(tree.rows.filter((r) => r.kind === 'panel')).toHaveLength(2);
  });

  it('never throws on malformed data the schema would normally reject', () => {
    // Reachable while data is stale, imported, or concurrently changed. The loose
    // input shape exists exactly so these guards are testable rather than dead.
    const malformed = {
      id: 'w1',
      dashboards: [
        { id: 'no-collections' },
        { id: 'null-collections', title: 'N', filters: null, tiles: null },
        { id: 'bad-refs', title: 'B', filters: [{ id: 'f1' }], tiles: [{ id: 't1' }] },
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
    // A filter with no parameter and no source is transitional, not broken.
    expect(row(tree.rows, 'w1:bad-refs:filter:f1').invalid).toBeNull();
    expect(row(tree.rows, 'w1:bad-refs:filter:f1').label).toBe(UNTITLED_FILTER);
  });

  it('renders one row PER MEMBER when several members share one query', () => {
    // Before #427 this is normal, and rows must never be merged by query id.
    const tree = derive(ws({
      dashboards: [dashboard({
        id: 'd', title: 'D',
        tiles: [{ id: 't1', queryId: 'shared' }, { id: 't2', queryId: 'shared' }],
        filters: [{ id: 'f1', parameter: 'p', sourceQueryId: 'shared' }],
      })],
      queries: [query('shared', 'Shared')],
    }), allOpen(['d']));
    const shared = tree.rows.filter((r) => r.queryId === 'shared');
    expect(shared).toHaveLength(3);
    expect(shared.map((r) => r.key))
      .toEqual(['w1:d:filter:f1', 'w1:d:tile:t1', 'w1:d:tile:t2']);
    expect(new Set(shared.map((r) => r.label))).toEqual(new Set(['Shared']));
  });
});

describe('deriveDashboardTree — search', () => {
  const workspace = () => ws({
    dashboards: [
      dashboard({
        id: 'sales', title: 'Sales', description: 'revenue reporting',
        filters: [{ id: 'f-region', parameter: 'region_code', label: 'Region' }],
        tiles: [{ id: 't-rev', queryId: 'q-rev' }, { id: 't-cost', queryId: 'q-cost', title: 'Cost override', description: 'tile note' }],
      }),
      dashboard({
        id: 'ops', title: 'Ops',
        filters: [{ id: 'f-src', parameter: 'zone', sourceQueryId: 'q-zones' }],
        tiles: [{ id: 't-lat', queryId: 'q-lat' }],
      }),
    ],
    queries: [
      query('q-rev', 'Revenue', 'monthly totals'),
      query('q-cost', 'Cost'),
      query('q-lat', 'Latency', 'p99 by shard'),
      query('q-zones', 'Zone list'),
    ],
  });
  const search = (text: string, ui = EMPTY_TREE_UI) => derive(workspace(), setTreeSearch(ui, text));

  it('matches a Dashboard title and shows its COMPLETE hierarchy for context', () => {
    const tree = search('sales');
    expect(tree.rows.map((r) => r.key)).toEqual([
      'w1:sales', 'w1:sales:group:filters', 'w1:sales:filter:f-region',
      'w1:sales:group:panels', 'w1:sales:tile:t-rev', 'w1:sales:tile:t-cost',
    ]);
    expect(row(tree.rows, 'w1:sales').matched).toBe(true);
  });

  it('matches a Dashboard DESCRIPTION', () => {
    expect(keys(search('revenue reporting').rows)).toContain('w1:sales');
  });

  it('matches a filter label and keeps its ancestors visible', () => {
    const tree = search('region');
    expect(keys(tree.rows)).toEqual(['w1:sales', 'w1:sales:group:filters', 'w1:sales:filter:f-region', 'w1:sales:group:panels']);
    expect(row(tree.rows, 'w1:sales:filter:f-region').matched).toBe(true);
    // Ancestors are exposed but not themselves marked as matches.
    expect(row(tree.rows, 'w1:sales').matched).toBe(false);
  });

  it('matches a filter PARAMETER', () => {
    expect(keys(search('region_code').rows)).toContain('w1:sales:filter:f-region');
  });

  it('matches a resolved filter SOURCE-QUERY name', () => {
    const tree = search('zone list');
    expect(keys(tree.rows)).toContain('w1:ops:filter:f-src');
    expect(keys(tree.rows)).not.toContain('w1:sales');
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
  // only surfaced after the search cleared. `ui/schema.ts`'s second level makes its
  // forcing term conditional for exactly this reason.
  it('forces a group open only when it has a match to reveal', () => {
    const searching = setTreeSearch(EMPTY_TREE_UI, 'latency');
    const tree = derive(workspace(), searching);
    // Panels has the match → forced open. Filters has none → still closed.
    expect(row(tree.rows, 'w1:ops:group:panels').expanded).toBe(true);
    expect(row(tree.rows, 'w1:ops:group:filters').expanded).toBe(false);
  });

  it('still honours persisted expansion for a group with no matches', () => {
    let ui = toggleGroupExpanded(EMPTY_TREE_UI, 'ops', 'filters');
    ui = setTreeSearch(ui, 'latency');
    // The user had Filters open; a search that does not match it must not close it.
    expect(row(derive(workspace(), ui).rows, 'w1:ops:group:filters').expanded).toBe(true);
  });

  it('shows ONLY matching descendants when the Dashboard itself did not match', () => {
    const tree = search('latency');
    // Both group rows stay (the Dashboard is exposed), but only the match shows.
    expect(keys(tree.rows)).toEqual([
      'w1:ops', 'w1:ops:group:filters', 'w1:ops:group:panels', 'w1:ops:tile:t-lat',
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
      dashboard({ id: 'a', title: 'A', tiles: [{ id: 't1', queryId: 'q1' }], filters: [{ id: 'f1', parameter: 'p' }] }),
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
    expect(row(tree.rows, 'w1:a:filter:f1').current).toBe(false);
    // The Dashboard row stays marked too — both facts are shown at once.
    expect(row(tree.rows, 'w1:a').current).toBe(true);
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
      filters: [{ id: 'f1', parameter: 'p', sourceQueryId: 'q1' }],
      tiles: [{ id: 't1', queryId: 'q1' }],
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

  it('gives a filter row the SOURCE-query wording and a filter-focused request', () => {
    const filter = row(tree().rows, 'w1:d:filter:f1');
    expect(filter.single).toEqual({ kind: 'open-query', queryId: 'q1' });
    expect(filter.double).toEqual({
      kind: 'open-dashboard',
      request: { dashboardId: 'd', mode: 'view', focus: { kind: 'filter', id: 'f1' } },
    });
    expect(filter.menu.map((item) => item.label)).toEqual([
      'Open source query',
      'Open Dashboard in View and focus filter',
      'Open Dashboard in Edit and focus filter',
    ]);
  });

  it('marks member rows as non-expandable leaves at level 3', () => {
    for (const key of ['w1:d:filter:f1', 'w1:d:tile:t1']) {
      const member = row(tree().rows, key);
      expect(member.expandable).toBe(false);
      expect(member.expanded).toBe(false);
      expect(member.level).toBe(3);
    }
  });
});
