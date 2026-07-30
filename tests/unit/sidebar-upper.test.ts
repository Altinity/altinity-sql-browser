import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildSidebarUpper, renderUpperRoleTabs } from '../../src/ui/sidebar-upper.js';
import type { SidebarUpperApp } from '../../src/ui/sidebar-upper.js';
import { renderDashboardTree } from '../../src/ui/dashboard-tree.js';
import { makeApp } from '../helpers/fake-app.js';
import { h, s } from '../../src/ui/dom.js';
import { NAV_SECTION_META } from '../../src/ui/nav-sections.js';
import { readTreeUi, setTreeSearch } from '../../src/core/dashboard-tree-ui-state.js';
import type { TreeWorkspace } from '../../src/application/dashboard-tree-model.js';

type FakeApp = ReturnType<typeof makeApp>;

const workspace = (dashboardIds: string[] = ['sales', 'ops']): TreeWorkspace => ({
  id: 'w1',
  queries: [],
  dashboards: dashboardIds.map((id) => ({ id, title: id, filters: [], tiles: [] })),
});

/** Mount the upper pane the way `app-shell.ts` does: the Databases content is
 *  built by the caller and handed in, so this module never owns schema behaviour. */
const mount = (over: Partial<SidebarUpperApp> = {}) => {
  const app = makeApp({ document }) as FakeApp & SidebarUpperApp;
  app.currentWorkspace = workspace() as never;
  app.mainSurface = { kind: 'query' };
  app.openDashboard = vi.fn();
  app.openSavedQuery = vi.fn();
  Object.assign(app, over);
  app.dom.schemaSearchInput = h('input', { type: 'text' });
  app.dom.schemaList = h('div', { class: 'schema-list' });
  const schemaSearch = h('div', { class: 'schema-search' }, app.dom.schemaSearchInput);
  const upper = buildSidebarUpper(app, [schemaSearch, app.dom.schemaList]);
  const pane = h('div', { class: 'side-pane schema-pane' },
    app.dom.upperRoleTabs!, upper.databasesHost, upper.dashboardsHost);
  document.body.appendChild(pane);
  renderUpperRoleTabs(app);
  return { app, upper, pane };
};

const tabs = (app: SidebarUpperApp): HTMLButtonElement[] =>
  [...app.dom.upperRoleTabs!.querySelectorAll<HTMLButtonElement>('.side-tab')];
const tabText = (app: SidebarUpperApp): string[] => tabs(app).map((t) => t.textContent!);

beforeEach(() => { document.body.innerHTML = ''; });

describe('buildSidebarUpper — role tabs', () => {
  it('renders Databases and Dashboards with their counts', () => {
    const { app } = mount();
    app.state.schema.value = [{ db: 'a' }, { db: 'b' }, { db: 'c' }];
    renderUpperRoleTabs(app);
    expect(tabText(app)).toEqual(['Databases· 3', 'Dashboards· 2']);
  });

  it('takes both labels and both icons FROM the registry, not from a local copy', () => {
    // Asserting the rendered text equals 'Databases' cannot distinguish reading
    // `NAV_SECTION_META` from hard-coding the same string — and hard-coding it is
    // exactly the drift #487 phase 2 exists to prevent, since phase 3's rail
    // presents these same two sections. So override the registry and require the
    // tab row to follow it.
    const { app } = mount();
    const meta = NAV_SECTION_META.databases as { label: string; icon: () => SVGElement };
    const label = meta.label;
    const icon = meta.icon;
    try {
      meta.label = 'Explore';
      meta.icon = () => s('svg', { 'data-registry-icon': 'yes' });
      renderUpperRoleTabs(app);
      // No count: `mount()` leaves the schema unloaded, which omits it.
      expect(tabText(app)[0]).toBe('Explore');
      expect(tabs(app)[0].querySelector('[data-registry-icon="yes"]')).not.toBeNull();
    } finally {
      meta.label = label;
      meta.icon = icon;
    }
  });

  it('omits the Databases count while the schema is loading or failed', () => {
    const { app } = mount();
    // `null` schema is the loading state — a confident "· 0" would be a lie.
    app.state.schema.value = null;
    renderUpperRoleTabs(app);
    expect(tabText(app)[0]).toBe('Databases');
    app.state.schema.value = [{ db: 'a' }];
    app.state.schemaError.value = 'denied';
    renderUpperRoleTabs(app);
    expect(tabText(app)[0]).toBe('Databases');
  });

  it('shows a zero Dashboards count for an empty collection, and none for no workspace', () => {
    const { app } = mount({ currentWorkspace: workspace([]) });
    renderUpperRoleTabs(app);
    expect(tabText(app)[1]).toBe('Dashboards· 0');
    app.currentWorkspace = null;
    renderUpperRoleTabs(app);
    expect(tabText(app)[1]).toBe('Dashboards· 0');
  });

  it('defaults to Databases and marks the active tab', () => {
    const { app } = mount();
    expect(app.state.upperRole.value).toBe('databases');
    expect(tabs(app)[0].classList.contains('active')).toBe(true);
    expect(tabs(app)[0].getAttribute('aria-pressed')).toBe('true');
    expect(tabs(app)[1].classList.contains('active')).toBe(false);
    expect(tabs(app)[1].getAttribute('aria-pressed')).toBe('false');
  });

  // #487 phase 3 step 4: the wide-mode restore-focus path
  // (`app-shell.ts`'s `applyEffectiveLeftNavigationLayout`) finds a tab by
  // `data-section` at the moment of the transition — each button must carry
  // its own section name.
  it('carries its own section as data-section (#487 phase 3 step 4)', () => {
    const { app } = mount();
    expect(tabs(app)[0].dataset.section).toBe('databases');
    expect(tabs(app)[1].dataset.section).toBe('dashboards');
  });

  it('clicking a tab selects that role', () => {
    const { app } = mount();
    tabs(app)[1].click();
    expect(app.state.upperRole.value).toBe('dashboards');
    renderUpperRoleTabs(app);
    expect(tabs(app)[1].classList.contains('active')).toBe(true);
    tabs(app)[0].click();
    expect(app.state.upperRole.value).toBe('databases');
  });

  it('switching role cancels a pending tree single-click', () => {
    vi.useFakeTimers();
    const { app, upper } = mount();
    upper.showRole('dashboards');
    renderDashboardTree(app);
    const dashboardRow = app.dom.dashboardTreeList!.querySelector('.dash-tree-row')!;
    dashboardRow.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    tabs(app)[0].click();
    vi.advanceTimersByTime(400);
    // The deferred expansion belonged to a tree the user has navigated away from.
    expect(readTreeUi(app.state.dashboardTreeUi, 'w1').expandedDashboardIds.size).toBe(0);
  });

  it('no-ops when the tab row is not mounted', () => {
    const app = makeApp({ document }) as FakeApp & SidebarUpperApp;
    expect(() => renderUpperRoleTabs(app)).not.toThrow();
  });
});

describe('buildSidebarUpper — persistent hosts', () => {
  it('marks both hosts with the shared section-host contract (#487 phase 2)', () => {
    const { upper } = mount();
    // One class and one attribute vocabulary for all four navigation sections, so
    // phase 3's focused drawer can host any of them with no per-section layout
    // rule — and so `ui/nav-sections.ts` can address these two the same way it
    // addresses the lower pane's.
    for (const host of [upper.databasesHost, upper.dashboardsHost]) {
      expect(host.classList.contains('nav-section-host')).toBe(true);
    }
    expect(upper.databasesHost.dataset.section).toBe('databases');
    expect(upper.dashboardsHost.dataset.section).toBe('dashboards');
  });

  it('exposes exactly one host at a time', () => {
    const { app, upper } = mount();
    expect(upper.databasesHost.hidden).toBe(false);
    expect(upper.dashboardsHost.hidden).toBe(true);
    upper.showRole('dashboards');
    expect(upper.databasesHost.hidden).toBe(true);
    expect(upper.dashboardsHost.hidden).toBe(false);
    upper.showRole('databases');
    expect(upper.databasesHost.hidden).toBe(false);
    expect(app.dom.schemaList!.isConnected).toBe(true);
  });

  it('NEVER rebuilds the schema host — so its search text, focus and scroll survive', () => {
    const { app, upper } = mount();
    const input = app.dom.schemaSearchInput!;
    const list = app.dom.schemaList!;
    input.value = 'system.parts';
    input.focus();
    list.appendChild(h('div', { class: 'tree-row' }, 'a lazily loaded column'));

    upper.showRole('dashboards');
    upper.showRole('databases');

    // The very same element objects, with their content intact — preservation by
    // construction, not by save/restore logic.
    expect(app.dom.schemaSearchInput).toBe(input);
    expect(app.dom.schemaList).toBe(list);
    expect(input.value).toBe('system.parts');
    expect(list.textContent).toContain('a lazily loaded column');
    expect(input.isConnected).toBe(true);
  });

  it('keeps each role\'s search state independent', () => {
    const { app, upper } = mount();
    app.dom.schemaSearchInput!.value = 'parts';
    upper.showRole('dashboards');
    const treeSearch = app.dom.dashboardSearchInput!;
    treeSearch.value = 'sales';
    treeSearch.dispatchEvent(new Event('input'));
    expect(readTreeUi(app.state.dashboardTreeUi, 'w1').searchText).toBe('sales');
    // The schema filter is untouched by the Dashboard search, and vice versa.
    expect(app.dom.schemaSearchInput!.value).toBe('parts');
    expect(app.state.schemaFilter.value).toBe('');
  });

  it('gives the Dashboard tree its own labelled search box, outside the row list', () => {
    const { app } = mount();
    const input = app.dom.dashboardSearchInput!;
    expect(input.placeholder).toBe('Search dashboards, variables, panels…');
    expect(input.getAttribute('aria-label')).toBe('Search dashboards, variables, panels');
    // Outside the repainted list, which is what keeps the caret while typing.
    expect(app.dom.dashboardTreeList!.contains(input)).toBe(false);
  });

  it('writes no workspace state when switching roles or searching', () => {
    const { app, upper } = mount();
    const before = app.currentWorkspace;
    upper.showRole('dashboards');
    app.state.upperRole.value = 'dashboards';
    const input = app.dom.dashboardSearchInput!;
    input.value = 'ops';
    input.dispatchEvent(new Event('input'));
    expect(app.currentWorkspace).toBe(before);
    // Tree UI state is session-only, keyed by workspace id — never in the aggregate.
    expect(readTreeUi(app.state.dashboardTreeUi, 'w1').searchText).toBe('ops');
  });

  it('scopes tree state per workspace id', () => {
    const { app, upper } = mount();
    upper.showRole('dashboards');
    app.state.dashboardTreeUi.set('w1', setTreeSearch(readTreeUi(app.state.dashboardTreeUi, 'w1'), 'sales'));
    app.currentWorkspace = { ...workspace(), id: 'w2' } as never;
    renderDashboardTree(app);
    // A different workspace starts clean, and w1's state is still there for a
    // return trip.
    expect(readTreeUi(app.state.dashboardTreeUi, 'w2').searchText).toBe('');
    expect(readTreeUi(app.state.dashboardTreeUi, 'w1').searchText).toBe('sales');
  });
});
