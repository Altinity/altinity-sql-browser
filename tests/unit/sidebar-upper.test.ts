import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildSidebarUpper, databasesPanelDef, dashboardsPanelDef } from '../../src/ui/sidebar-upper.js';
import type { SidebarUpperApp } from '../../src/ui/sidebar-upper.js';
import { buildSidePanelRegistry, renderSidePanelTabs } from '../../src/ui/side-panel-registry.js';
import type { SidePanelId, UpperPanelId } from '../../src/core/side-panels.js';
import { renderDashboardTree } from '../../src/ui/dashboard-tree.js';
import { makeApp } from '../helpers/fake-app.js';
import { h } from '../../src/ui/dom.js';
import { readTreeUi, setTreeSearch } from '../../src/core/dashboard-tree-ui-state.js';
import type { TreeWorkspace } from '../../src/application/dashboard-tree-model.js';

type FakeApp = ReturnType<typeof makeApp>;

const workspace = (dashboardIds: string[] = ['sales', 'ops']): TreeWorkspace => ({
  id: 'w1',
  queries: [],
  dashboards: dashboardIds.map((id) => ({ id, title: id, filters: [], tiles: [] })),
});

/**
 * Mount the upper pane the way `app-shell.ts` does: `buildSidebarUpper` builds
 * the two bodies (Databases content is built by the caller and handed in, so
 * this module never owns schema behaviour), then a registry over just those
 * two panels stands in for the real four-panel one — `onSelect` below mimics
 * app-shell.ts's own reactive effect (`state.upperRole.value = id`, then
 * `registry.showPanel`/re-render), since this file exercises
 * `sidebar-upper.ts`'s contribution to the registry in isolation, not the
 * full effect wiring.
 */
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
  const registry = buildSidePanelRegistry([
    databasesPanelDef(app, upper.databasesHost),
    dashboardsPanelDef(app, upper.dashboardsHost),
  ]);
  const tabsRow = h('div', { class: 'side-tabs upper-role-tabs' });
  const pane = h('div', { class: 'side-pane schema-pane' },
    tabsRow, upper.databasesHost, upper.dashboardsHost);
  document.body.appendChild(pane);
  const render = (): void => renderSidePanelTabs(tabsRow, registry.entries, app.state.upperRole.value, (id: SidePanelId) => {
    app.state.upperRole.value = id as UpperPanelId;
    registry.showPanel(id);
    render();
  });
  render();
  return { app, upper, registry, pane, tabsRow, render };
};

const tabs = (tabsRow: HTMLElement): HTMLButtonElement[] =>
  [...tabsRow.querySelectorAll<HTMLButtonElement>('.side-tab')];
const tabText = (tabsRow: HTMLElement): string[] => tabs(tabsRow).map((t) => t.textContent!);

beforeEach(() => { document.body.innerHTML = ''; });

describe('side-panel registry — upper pane tab row (#587)', () => {
  it('renders Databases and Dashboards with their counts', () => {
    const { app, tabsRow, render } = mount();
    app.state.schema.value = [{ db: 'a' }, { db: 'b' }, { db: 'c' }];
    render();
    expect(tabText(tabsRow)).toEqual(['Databases· 3', 'Dashboards· 2']);
  });

  it('omits the Databases count while the schema is loading or failed', () => {
    const { app, tabsRow, render } = mount();
    // `null` schema is the loading state — a confident "· 0" would be a lie.
    app.state.schema.value = null;
    render();
    expect(tabText(tabsRow)[0]).toBe('Databases');
    app.state.schema.value = [{ db: 'a' }];
    app.state.schemaError.value = 'denied';
    render();
    expect(tabText(tabsRow)[0]).toBe('Databases');
  });

  it('shows a zero Dashboards count for an empty collection, and none for no workspace', () => {
    const { app, tabsRow, render } = mount({ currentWorkspace: workspace([]) });
    render();
    expect(tabText(tabsRow)[1]).toBe('Dashboards· 0');
    // #590: the public setter no longer accepts `null` (a transitional null
    // publication is a named departure operation owned by `app.ts`'s
    // surface-retirement coordinator, not part of the general writable
    // port) — this fixture bypasses that the same way `mount()` above
    // bypasses the `TreeWorkspace`/`StoredWorkspaceV5` mismatch, via `as
    // never`, to drive the fake through a transition no production
    // `DashboardTreeApp`-typed caller performs directly.
    app.currentWorkspace = null as never;
    render();
    expect(tabText(tabsRow)[1]).toBe('Dashboards· 0');
  });

  it('defaults to Databases and marks the active tab', () => {
    const { app, tabsRow } = mount();
    expect(app.state.upperRole.value).toBe('databases');
    expect(tabs(tabsRow)[0].classList.contains('active')).toBe(true);
    expect(tabs(tabsRow)[0].getAttribute('aria-pressed')).toBe('true');
    expect(tabs(tabsRow)[1].classList.contains('active')).toBe(false);
    expect(tabs(tabsRow)[1].getAttribute('aria-pressed')).toBe('false');
  });

  it('clicking a tab selects that role', () => {
    const { app, tabsRow } = mount();
    tabs(tabsRow)[1].click();
    expect(app.state.upperRole.value).toBe('dashboards');
    expect(tabs(tabsRow)[1].classList.contains('active')).toBe(true);
    tabs(tabsRow)[0].click();
    expect(app.state.upperRole.value).toBe('databases');
  });

  it('switching role cancels a pending tree single-click', () => {
    vi.useFakeTimers();
    const { app, tabsRow, registry } = mount();
    registry.showPanel('dashboards');
    renderDashboardTree(app);
    const dashboardRow = app.dom.dashboardTreeList!.querySelector('.dash-tree-row')!;
    dashboardRow.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    tabs(tabsRow)[0].click();
    vi.advanceTimersByTime(400);
    // The deferred expansion belonged to a tree the user has navigated away from.
    expect(readTreeUi(app.state.dashboardTreeUi, 'w1').expandedDashboardIds.size).toBe(0);
  });
});

describe('buildSidebarUpper — persistent hosts', () => {
  it('exposes exactly one host at a time', () => {
    const { app, upper, registry } = mount();
    expect(upper.databasesHost.hidden).toBe(false);
    expect(upper.dashboardsHost.hidden).toBe(true);
    registry.showPanel('dashboards');
    expect(upper.databasesHost.hidden).toBe(true);
    expect(upper.dashboardsHost.hidden).toBe(false);
    registry.showPanel('databases');
    expect(upper.databasesHost.hidden).toBe(false);
    expect(app.dom.schemaList!.isConnected).toBe(true);
  });

  it('NEVER rebuilds the schema host — so its search text, focus and scroll survive', () => {
    const { app, upper, registry } = mount();
    const input = app.dom.schemaSearchInput!;
    const list = app.dom.schemaList!;
    input.value = 'system.parts';
    input.focus();
    list.appendChild(h('div', { class: 'tree-row' }, 'a lazily loaded column'));

    registry.showPanel('dashboards');
    registry.showPanel('databases');

    // The very same element objects, with their content intact — preservation by
    // construction, not by save/restore logic.
    expect(app.dom.schemaSearchInput).toBe(input);
    expect(app.dom.schemaList).toBe(list);
    expect(input.value).toBe('system.parts');
    expect(list.textContent).toContain('a lazily loaded column');
    expect(input.isConnected).toBe(true);
  });

  it('keeps each role\'s search state independent', () => {
    const { app, registry } = mount();
    app.dom.schemaSearchInput!.value = 'parts';
    registry.showPanel('dashboards');
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
    const { app, registry } = mount();
    const before = app.currentWorkspace;
    registry.showPanel('dashboards');
    app.state.upperRole.value = 'dashboards';
    const input = app.dom.dashboardSearchInput!;
    input.value = 'ops';
    input.dispatchEvent(new Event('input'));
    expect(app.currentWorkspace).toBe(before);
    // Tree UI state is session-only, keyed by workspace id — never in the aggregate.
    expect(readTreeUi(app.state.dashboardTreeUi, 'w1').searchText).toBe('ops');
  });

  it('scopes tree state per workspace id', () => {
    const { app, registry } = mount();
    registry.showPanel('dashboards');
    app.state.dashboardTreeUi.set('w1', setTreeSearch(readTreeUi(app.state.dashboardTreeUi, 'w1'), 'sales'));
    app.currentWorkspace = { ...workspace(), id: 'w2' } as never;
    renderDashboardTree(app);
    // A different workspace starts clean, and w1's state is still there for a
    // return trip.
    expect(readTreeUi(app.state.dashboardTreeUi, 'w2').searchText).toBe('');
    expect(readTreeUi(app.state.dashboardTreeUi, 'w1').searchText).toBe('sales');
  });
});
