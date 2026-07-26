import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderDashboardTree, cancelDashboardTreeClicks } from '../../src/ui/dashboard-tree.js';
import type { DashboardTreeApp } from '../../src/ui/dashboard-tree.js';
import { buildSidebarUpper } from '../../src/ui/sidebar-upper.js';
import { makeApp } from '../helpers/fake-app.js';
import {
  EMPTY_TREE_UI, groupStateKey, readTreeUi, setTreeSearch, toggleDashboardExpanded,
  toggleGroupExpanded,
} from '../../src/core/dashboard-tree-ui-state.js';
import type { MainSurfaceState } from '../../src/application/main-surface.js';
import type { TreeWorkspace } from '../../src/application/dashboard-tree-model.js';
import type { SavedQueryV2 } from '../../src/generated/json-schema.types.js';

type FakeApp = ReturnType<typeof makeApp>;

const query = (id: string, name: string): SavedQueryV2 => ({
  id, sql: 'SELECT 1', specVersion: 1, spec: { specVersion: 1, name },
});

/** The standard fixture: two Dashboards, one with a filter and two panels, one of
 *  which has a broken query reference. */
const workspace = (): TreeWorkspace => ({
  id: 'w1',
  queries: [query('q1', 'Revenue'), query('q-src', 'Zones')],
  dashboards: [
    {
      id: 'sales', title: 'Sales',
      filters: [
        { id: 'f-src', parameter: 'zone', sourceQueryId: 'q-src' },
        { id: 'f-bare', parameter: 'region' },
      ],
      tiles: [{ id: 't1', queryId: 'q1' }, { id: 't-broken', queryId: 'q-gone' }],
    },
    { id: 'ops', title: 'Ops', filters: [], tiles: [] },
  ],
});

/**
 * Mount a real tree into a real `role="tree"` container, using the module that
 * builds it in production — so the container's ARIA and the search box are the
 * shipped ones, not a test-local approximation.
 */
const treeApp = (over: Partial<DashboardTreeApp> = {}) => {
  const app = makeApp({ document }) as FakeApp & DashboardTreeApp;
  app.currentWorkspace = workspace() as never;
  app.mainSurface = { kind: 'query' };
  app.openDashboard = vi.fn();
  app.openSavedQuery = vi.fn();
  Object.assign(app, over);
  const upper = buildSidebarUpper(app, []);
  document.body.appendChild(upper.dashboardsHost);
  upper.dashboardsHost.hidden = false;
  return { app, upper, list: app.dom.dashboardTreeList! };
};

const setUi = (app: DashboardTreeApp, mutate: (ui: typeof EMPTY_TREE_UI) => typeof EMPTY_TREE_UI): void => {
  app.state.dashboardTreeUi.set('w1', mutate(readTreeUi(app.state.dashboardTreeUi, 'w1')));
};
const openAll = (app: DashboardTreeApp, id: string): void => setUi(app, (ui) =>
  toggleGroupExpanded(toggleGroupExpanded(toggleDashboardExpanded(ui, id), id, 'filters'), id, 'panels'));

const rows = (list: HTMLElement): HTMLElement[] => [...list.querySelectorAll<HTMLElement>('.dash-tree-row')];
const rowFor = (list: HTMLElement, key: string): HTMLElement =>
  list.querySelector<HTMLElement>('[data-key="' + key.replace(/"/g, '\\"') + '"]')!;
const labels = (list: HTMLElement): string[] =>
  rows(list).map((row) => row.querySelector('.label')!.textContent!);
const click = (el: Element, over: MouseEventInit = {}): void => {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, ...over }));
};
const key = (list: HTMLElement, k: string, over: KeyboardEventInit = {}): void => {
  list.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...over }));
};

beforeEach(() => { document.body.innerHTML = ''; });

describe('renderDashboardTree — structure and ARIA', () => {
  it('renders a role=tree container with treeitem rows carrying aria-level', () => {
    const { app, list } = treeApp();
    openAll(app, 'sales');
    renderDashboardTree(app);
    expect(list.getAttribute('role')).toBe('tree');
    expect(list.getAttribute('aria-label')).toBe('Dashboards');
    const dashboard = rowFor(list, 'w1:sales');
    expect(dashboard.getAttribute('role')).toBe('treeitem');
    expect(dashboard.getAttribute('aria-level')).toBe('1');
    expect(rowFor(list, 'w1:sales:group:panels').getAttribute('aria-level')).toBe('2');
    expect(rowFor(list, 'w1:sales:tile:t1').getAttribute('aria-level')).toBe('3');
  });

  it('sets aria-expanded only on expandable rows', () => {
    const { app, list } = treeApp();
    openAll(app, 'sales');
    renderDashboardTree(app);
    expect(rowFor(list, 'w1:sales').getAttribute('aria-expanded')).toBe('true');
    expect(rowFor(list, 'w1:ops').getAttribute('aria-expanded')).toBe('false');
    // A member row is a leaf — aria-expanded on it would be a lie.
    expect(rowFor(list, 'w1:sales:tile:t1').hasAttribute('aria-expanded')).toBe(false);
  });

  it('keeps exactly ONE row in the Tab order (roving tabindex)', () => {
    const { app, list } = treeApp();
    openAll(app, 'sales');
    renderDashboardTree(app);
    const tabbable = rows(list).filter((row) => row.getAttribute('tabindex') === '0');
    expect(tabbable).toHaveLength(1);
    expect(tabbable[0].dataset.key).toBe('w1:sales');
    expect(rows(list).filter((row) => row.getAttribute('tabindex') === '-1'))
      .toHaveLength(rows(list).length - 1);
  });

  it('indents by level', () => {
    const { app, list } = treeApp();
    openAll(app, 'sales');
    renderDashboardTree(app);
    expect(rowFor(list, 'w1:sales').style.paddingLeft).toBe('10px');
    expect(rowFor(list, 'w1:sales:group:panels').style.paddingLeft).toBe('24px');
    expect(rowFor(list, 'w1:sales:tile:t1').style.paddingLeft).toBe('38px');
  });

  it('shows the empty-collection message, and the no-match message separately', () => {
    const { app, list } = treeApp({ currentWorkspace: { id: 'w1', dashboards: [], queries: [] } });
    renderDashboardTree(app);
    expect(list.textContent).toContain('No dashboards in this workspace.');
    const populated = treeApp();
    setUi(populated.app, (ui) => setTreeSearch(ui, 'nothing here'));
    renderDashboardTree(populated.app);
    expect(populated.list.textContent).toContain('No matching dashboards, filters, or panels.');
  });

  it('no-ops when the list is not mounted', () => {
    const app = makeApp({ document }) as FakeApp & DashboardTreeApp;
    app.currentWorkspace = workspace() as never;
    expect(() => renderDashboardTree(app)).not.toThrow();
  });

  it('renders the invalid panel with a warning marker and a diagnostic tooltip', () => {
    const { app, list } = treeApp();
    openAll(app, 'sales');
    renderDashboardTree(app);
    const broken = rowFor(list, 'w1:sales:tile:t-broken');
    expect(broken.classList.contains('is-invalid')).toBe(true);
    expect(broken.querySelector('.dash-tree-warn')!.getAttribute('aria-label')).toBe('Broken reference');
    expect(broken.getAttribute('title')).toContain('cannot be opened');
    // A source-LESS filter is transitional, not broken — no marker at all.
    const bare = rowFor(list, 'w1:sales:filter:f-bare');
    expect(bare.classList.contains('is-invalid')).toBe(false);
    expect(bare.querySelector('.dash-tree-warn')).toBeNull();
  });

  it('marks the current Dashboard and member distinctly from keyboard focus', () => {
    const surface: MainSurfaceState = {
      kind: 'dashboard', dashboardId: 'sales', mode: 'edit',
      currentMember: { kind: 'tile', id: 't1' }, pendingFocus: null,
    };
    const { app, list } = treeApp({ mainSurface: surface });
    openAll(app, 'sales');
    renderDashboardTree(app);
    expect(rowFor(list, 'w1:sales').classList.contains('is-current')).toBe(true);
    expect(rowFor(list, 'w1:sales:tile:t1').classList.contains('is-current')).toBe(true);
    expect(rowFor(list, 'w1:sales:tile:t1').getAttribute('aria-current')).toBe('true');
    expect(rowFor(list, 'w1:sales:tile:t-broken').classList.contains('is-current')).toBe(false);
    expect(rowFor(list, 'w1:ops').classList.contains('is-current')).toBe(false);
  });
});

describe('renderDashboardTree — mouse gestures', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  const settle = (): void => { vi.advanceTimersByTime(400); };

  it('a Dashboard row click toggles expansion ONCE, after the double-click window', () => {
    const { app, list } = treeApp();
    renderDashboardTree(app);
    click(rowFor(list, 'w1:sales'));
    // Deferred: the double-click action must be able to cancel it.
    expect(readTreeUi(app.state.dashboardTreeUi, 'w1').expandedDashboardIds.has('sales')).toBe(false);
    settle();
    expect(readTreeUi(app.state.dashboardTreeUi, 'w1').expandedDashboardIds.has('sales')).toBe(true);
    expect(app.openDashboard).not.toHaveBeenCalled();
  });

  it('a Dashboard double-click opens View once and leaves expansion EXACTLY as it was', () => {
    const { app, list } = treeApp();
    renderDashboardTree(app);
    click(rowFor(list, 'w1:sales'));
    click(rowFor(list, 'w1:sales'));
    settle();
    expect(app.openDashboard).toHaveBeenCalledExactlyOnceWith({ dashboardId: 'sales', mode: 'view' });
    // The scheduled expansion was cancelled, not merely re-toggled.
    expect(readTreeUi(app.state.dashboardTreeUi, 'w1').expandedDashboardIds.has('sales')).toBe(false);
  });

  it('a Dashboard Shift-click opens Edit immediately, cancelling a pending single', () => {
    const { app, list } = treeApp();
    renderDashboardTree(app);
    click(rowFor(list, 'w1:sales'));
    click(rowFor(list, 'w1:sales'), { shiftKey: true });
    expect(app.openDashboard).toHaveBeenCalledExactlyOnceWith({ dashboardId: 'sales', mode: 'edit' });
    settle();
    expect(readTreeUi(app.state.dashboardTreeUi, 'w1').expandedDashboardIds.has('sales')).toBe(false);
  });

  it('a panel click opens the query only AFTER the single-click window', () => {
    const { app, list } = treeApp();
    openAll(app, 'sales');
    renderDashboardTree(app);
    click(rowFor(list, 'w1:sales:tile:t1'));
    // The whole point: a query must not open on the first of two clicks.
    expect(app.openSavedQuery).not.toHaveBeenCalled();
    settle();
    expect(app.openSavedQuery).toHaveBeenCalledExactlyOnceWith('q1');
  });

  it('a panel double-click CANCELS the query-open and focuses the tile in View', () => {
    const { app, list } = treeApp();
    openAll(app, 'sales');
    renderDashboardTree(app);
    const row = rowFor(list, 'w1:sales:tile:t1');
    click(row);
    click(row);
    settle();
    expect(app.openSavedQuery).not.toHaveBeenCalled();
    expect(app.openDashboard).toHaveBeenCalledExactlyOnceWith({
      dashboardId: 'sales', mode: 'view', focus: { kind: 'tile', id: 't1' },
    });
  });

  it('a panel Shift-click cancels the pending query-open and focuses the tile in Edit', () => {
    const { app, list } = treeApp();
    openAll(app, 'sales');
    renderDashboardTree(app);
    const row = rowFor(list, 'w1:sales:tile:t1');
    click(row);
    click(row, { shiftKey: true });
    settle();
    expect(app.openSavedQuery).not.toHaveBeenCalled();
    expect(app.openDashboard).toHaveBeenCalledExactlyOnceWith({
      dashboardId: 'sales', mode: 'edit', focus: { kind: 'tile', id: 't1' },
    });
  });

  it('a source-backed filter row opens its SOURCE query; a source-less one opens nothing', () => {
    const { app, list } = treeApp();
    openAll(app, 'sales');
    renderDashboardTree(app);
    click(rowFor(list, 'w1:sales:filter:f-src'));
    settle();
    expect(app.openSavedQuery).toHaveBeenCalledExactlyOnceWith('q-src');

    click(rowFor(list, 'w1:sales:filter:f-bare'));
    settle();
    // Still exactly one call — query-open is unavailable, not silently retargeted.
    expect(app.openSavedQuery).toHaveBeenCalledOnce();
  });

  it('a source-less filter still answers double-click and Shift-click', () => {
    const { app, list } = treeApp();
    openAll(app, 'sales');
    renderDashboardTree(app);
    const row = rowFor(list, 'w1:sales:filter:f-bare');
    click(row);
    click(row);
    settle();
    expect(app.openDashboard).toHaveBeenCalledExactlyOnceWith({
      dashboardId: 'sales', mode: 'view', focus: { kind: 'filter', id: 'f-bare' },
    });
  });

  it('an unresolved panel row cannot open a query but still navigates', () => {
    const { app, list } = treeApp();
    openAll(app, 'sales');
    renderDashboardTree(app);
    const row = rowFor(list, 'w1:sales:tile:t-broken');
    click(row);
    settle();
    expect(app.openSavedQuery).not.toHaveBeenCalled();
    click(row);
    click(row);
    settle();
    expect(app.openDashboard).toHaveBeenCalledExactlyOnceWith({
      dashboardId: 'sales', mode: 'view', focus: { kind: 'tile', id: 't-broken' },
    });
  });

  it('a GROUP row toggles immediately — it has no competing gesture to wait for', () => {
    const { app, list } = treeApp();
    setUi(app, (ui) => toggleDashboardExpanded(ui, 'sales'));
    renderDashboardTree(app);
    click(rowFor(list, 'w1:sales:group:panels'));
    expect(readTreeUi(app.state.dashboardTreeUi, 'w1').expandedGroups.has(groupStateKey('sales', 'panels'))).toBe(true);
    expect(app.openDashboard).not.toHaveBeenCalled();
  });

  it('a chevron click expands immediately and does NOT run the row action', () => {
    const { app, list } = treeApp();
    renderDashboardTree(app);
    click(rowFor(list, 'w1:sales').querySelector('.chev')!);
    // Instant, because the chevron is the deliberate no-delay path.
    expect(readTreeUi(app.state.dashboardTreeUi, 'w1').expandedDashboardIds.has('sales')).toBe(true);
    settle();
    expect(app.openDashboard).not.toHaveBeenCalled();
  });

  it('a chevron click cancels a pending single from a prior row click', () => {
    const { app, list } = treeApp();
    renderDashboardTree(app);
    click(rowFor(list, 'w1:sales'));
    click(rowFor(list, 'w1:sales').querySelector('.chev')!);
    settle();
    // Expanded exactly once — by the chevron, not also by the abandoned single.
    expect(readTreeUi(app.state.dashboardTreeUi, 'w1').expandedDashboardIds.has('sales')).toBe(true);
  });

  it('cancelDashboardTreeClicks drops a deferred action (role or workspace change)', () => {
    const { app, list } = treeApp();
    openAll(app, 'sales');
    renderDashboardTree(app);
    click(rowFor(list, 'w1:sales:tile:t1'));
    cancelDashboardTreeClicks(app);
    settle();
    expect(app.openSavedQuery).not.toHaveBeenCalled();
  });

  it('an action-menu click cancels its OWN row\'s pending single but no other row\'s', () => {
    const { app, list } = treeApp();
    openAll(app, 'sales');
    renderDashboardTree(app);
    // Pending single belongs to the PANEL row...
    click(rowFor(list, 'w1:sales:tile:t1'));
    // ...and the menu button clicked here belongs to a DIFFERENT row.
    click(rowFor(list, 'w1:sales:tile:t-broken').querySelector('.dash-tree-menu-btn')!);
    settle();
    // #426: "action-menu/button clicks … cancel no unrelated row operation".
    expect(app.openSavedQuery).toHaveBeenCalledExactlyOnceWith('q1');
  });

  it('uses a menu glyph distinct from the row\'s disclosure chevron', () => {
    const { app, list } = treeApp();
    renderDashboardTree(app);
    const row = rowFor(list, 'w1:sales');
    // #426 requires the two not be confusable; an expanded row would otherwise
    // carry two identical chevrons at opposite ends.
    const chevronPaths = row.querySelector('.chev')!.innerHTML;
    const menuPaths = row.querySelector('.dash-tree-menu-btn')!.innerHTML;
    expect(menuPaths).not.toBe(chevronPaths);
    expect(menuPaths).toContain('circle');
  });

  it('moves the roving tabindex in the DOM immediately on click, not 300ms later', () => {
    const { app, list } = treeApp();
    renderDashboardTree(app);
    click(rowFor(list, 'w1:ops'));
    // Before the deferred single repaints, the visible Tab owner and the state must
    // already agree — otherwise Shift-Tab lands on one row while the arrow keys
    // move relative to another.
    expect(rowFor(list, 'w1:ops').getAttribute('tabindex')).toBe('0');
    expect(rowFor(list, 'w1:sales').getAttribute('tabindex')).toBe('-1');
    settle();
  });

  it('cancelDashboardTreeClicks is safe before any click has been arbitrated', () => {
    const { app } = treeApp();
    expect(() => cancelDashboardTreeClicks(app)).not.toThrow();
  });

  it('clicking a row moves the keyboard owner to it', () => {
    const { app, list } = treeApp();
    renderDashboardTree(app);
    click(rowFor(list, 'w1:ops'));
    settle();
    expect(readTreeUi(app.state.dashboardTreeUi, 'w1').keyboardRowKey).toBe('w1:ops');
  });
});

describe('renderDashboardTree — action menu', () => {
  const menuButton = (list: HTMLElement, rowKey: string): HTMLButtonElement =>
    rowFor(list, rowKey).querySelector<HTMLButtonElement>('.dash-tree-menu-btn')!;
  const menuLabels = (): string[] =>
    [...document.querySelectorAll('.dash-tree-menu .fm-label')].map((n) => n.textContent!);

  it('exposes the Dashboard row\'s View/Edit alternatives', () => {
    const { app, list } = treeApp();
    renderDashboardTree(app);
    click(menuButton(list, 'w1:sales'));
    expect(menuLabels()).toEqual(['Open in View', 'Open in Edit']);
  });

  it('exposes a panel row\'s three operations and runs the chosen one', () => {
    const { app, list } = treeApp();
    openAll(app, 'sales');
    renderDashboardTree(app);
    click(menuButton(list, 'w1:sales:tile:t1'));
    expect(menuLabels()).toEqual([
      'Open query',
      'Open Dashboard in View and focus panel',
      'Open Dashboard in Edit and focus panel',
    ]);
    const edit = [...document.querySelectorAll<HTMLElement>('.dash-tree-menu .fm-item')]
      .find((item) => item.textContent!.includes('Edit'))!;
    click(edit);
    expect(app.openDashboard).toHaveBeenCalledWith({
      dashboardId: 'sales', mode: 'edit', focus: { kind: 'tile', id: 't1' },
    });
  });

  it('renders an unavailable operation as disabled rather than hiding it', () => {
    const { app, list } = treeApp();
    openAll(app, 'sales');
    renderDashboardTree(app);
    click(menuButton(list, 'w1:sales:filter:f-bare'));
    expect(menuLabels()[0]).toBe('Open source query');
    const disabled = document.querySelector<HTMLButtonElement>('.dash-tree-menu .is-disabled')!;
    expect(disabled.textContent).toContain('Open source query');
    // Disabled SEMANTICALLY, not merely greyed out: assistive technology would
    // otherwise announce an enabled action, and keyboard activation would silently
    // do nothing.
    // #452: `aria-disabled`, not the native attribute — a natively disabled
    // button is dropped from the accessibility tree, so the row would never be
    // announced. It stays reachable and inert instead.
    expect(disabled.disabled).toBe(false);
    expect(disabled.getAttribute('aria-disabled')).toBe('true');
    // Clicking it does nothing at all.
    click(disabled);
    expect(app.openSavedQuery).not.toHaveBeenCalled();
  });

  it('labels the trigger accessibly and never runs the row\'s own gesture', () => {
    vi.useFakeTimers();
    const { app, list } = treeApp();
    renderDashboardTree(app);
    const trigger = menuButton(list, 'w1:sales');
    expect(trigger.getAttribute('aria-label')).toBe('Actions for Sales');
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
    click(trigger);
    vi.advanceTimersByTime(400);
    expect(app.openDashboard).not.toHaveBeenCalled();
    expect(readTreeUi(app.state.dashboardTreeUi, 'w1').expandedDashboardIds.has('sales')).toBe(false);
  });

  it('gives a group row no menu button at all', () => {
    const { app, list } = treeApp();
    setUi(app, (ui) => toggleDashboardExpanded(ui, 'sales'));
    renderDashboardTree(app);
    expect(rowFor(list, 'w1:sales:group:panels').querySelector('.dash-tree-menu-btn')).toBeNull();
  });
});

describe('renderDashboardTree — keyboard', () => {
  it('Down/Up traverse the VISIBLE rows and stop at the ends', () => {
    const { app, list } = treeApp();
    renderDashboardTree(app);
    key(list, 'ArrowUp'); // already at the first row
    expect(readTreeUi(app.state.dashboardTreeUi, 'w1').keyboardRowKey).toBe('w1:sales');
    key(list, 'ArrowDown');
    expect(readTreeUi(app.state.dashboardTreeUi, 'w1').keyboardRowKey).toBe('w1:ops');
    key(list, 'ArrowDown'); // already at the last row
    expect(readTreeUi(app.state.dashboardTreeUi, 'w1').keyboardRowKey).toBe('w1:ops');
    key(list, 'ArrowUp');
    expect(readTreeUi(app.state.dashboardTreeUi, 'w1').keyboardRowKey).toBe('w1:sales');
  });

  it('Home/End jump to the first and last visible rows', () => {
    const { app, list } = treeApp();
    openAll(app, 'sales');
    renderDashboardTree(app);
    key(list, 'End');
    expect(readTreeUi(app.state.dashboardTreeUi, 'w1').keyboardRowKey).toBe('w1:ops');
    key(list, 'Home');
    expect(readTreeUi(app.state.dashboardTreeUi, 'w1').keyboardRowKey).toBe('w1:sales');
  });

  it('Right expands a closed row, then steps into its first child', () => {
    const { app, list } = treeApp();
    renderDashboardTree(app);
    key(list, 'ArrowRight');
    expect(readTreeUi(app.state.dashboardTreeUi, 'w1').expandedDashboardIds.has('sales')).toBe(true);
    // Still on the Dashboard row — expanding is the whole action.
    expect(readTreeUi(app.state.dashboardTreeUi, 'w1').keyboardRowKey).toBe('w1:sales');
    key(list, 'ArrowRight');
    expect(readTreeUi(app.state.dashboardTreeUi, 'w1').keyboardRowKey).toBe('w1:sales:group:filters');
  });

  it('Right on an expanded LEAF-less group with no children does nothing', () => {
    const { app, list } = treeApp();
    setUi(app, (ui) => toggleGroupExpanded(toggleDashboardExpanded(ui, 'ops'), 'ops', 'filters'));
    renderDashboardTree(app);
    key(list, 'End'); // the last row: Ops' Panels group
    const before = readTreeUi(app.state.dashboardTreeUi, 'w1').keyboardRowKey;
    key(list, 'ArrowRight'); // expands it (it is empty)
    key(list, 'ArrowRight'); // no children to step into
    expect(readTreeUi(app.state.dashboardTreeUi, 'w1').keyboardRowKey).toBe(before);
  });

  it('Left collapses an open row, then steps out to its parent', () => {
    const { app, list } = treeApp();
    openAll(app, 'sales');
    renderDashboardTree(app);
    key(list, 'ArrowDown'); // Filters group
    key(list, 'ArrowDown'); // first filter
    expect(readTreeUi(app.state.dashboardTreeUi, 'w1').keyboardRowKey).toBe('w1:sales:filter:f-src');
    key(list, 'ArrowLeft'); // a leaf: step out to the group
    expect(readTreeUi(app.state.dashboardTreeUi, 'w1').keyboardRowKey).toBe('w1:sales:group:filters');
    key(list, 'ArrowLeft'); // an open group: collapse it
    expect(readTreeUi(app.state.dashboardTreeUi, 'w1').expandedGroups.has(groupStateKey('sales', 'filters'))).toBe(false);
    key(list, 'ArrowLeft'); // now closed: step out to the Dashboard
    expect(readTreeUi(app.state.dashboardTreeUi, 'w1').keyboardRowKey).toBe('w1:sales');
  });

  it('Left on a top-level collapsed row has no parent to move to', () => {
    const { app, list } = treeApp();
    renderDashboardTree(app);
    key(list, 'ArrowLeft');
    expect(readTreeUi(app.state.dashboardTreeUi, 'w1').keyboardRowKey).toBe('w1:sales');
  });

  it('Enter performs the primary action and Shift+Enter the Edit action', () => {
    const { app, list } = treeApp();
    openAll(app, 'sales');
    renderDashboardTree(app);
    // On a Dashboard row, Enter is the primary action: expansion.
    key(list, 'Enter');
    expect(readTreeUi(app.state.dashboardTreeUi, 'w1').expandedDashboardIds.has('sales')).toBe(false);
    key(list, 'Enter', { shiftKey: true });
    expect(app.openDashboard).toHaveBeenCalledExactlyOnceWith({ dashboardId: 'sales', mode: 'edit' });
  });

  it('Enter on a panel row opens its query with no double-click delay', () => {
    const { app, list } = treeApp();
    openAll(app, 'sales');
    renderDashboardTree(app);
    key(list, 'End');
    key(list, 'ArrowUp'); // the broken tile
    key(list, 'ArrowUp'); // t1
    expect(readTreeUi(app.state.dashboardTreeUi, 'w1').keyboardRowKey).toBe('w1:sales:tile:t1');
    key(list, 'Enter');
    expect(app.openSavedQuery).toHaveBeenCalledExactlyOnceWith('q1');
  });

  it('Enter on a row whose primary action is unavailable does nothing', () => {
    const { app, list } = treeApp();
    openAll(app, 'sales');
    renderDashboardTree(app);
    key(list, 'ArrowDown'); // Filters
    key(list, 'ArrowDown'); // f-src
    key(list, 'ArrowDown'); // f-bare — source-less
    expect(readTreeUi(app.state.dashboardTreeUi, 'w1').keyboardRowKey).toBe('w1:sales:filter:f-bare');
    key(list, 'Enter');
    expect(app.openSavedQuery).not.toHaveBeenCalled();
  });

  it('Shift+Enter on a group row does nothing — it has no Edit action', () => {
    const { app, list } = treeApp();
    setUi(app, (ui) => toggleDashboardExpanded(ui, 'sales'));
    renderDashboardTree(app);
    key(list, 'ArrowDown'); // Filters group
    key(list, 'Enter', { shiftKey: true });
    expect(app.openDashboard).not.toHaveBeenCalled();
  });

  it('ignores keys it does not own', () => {
    const { app, list } = treeApp();
    renderDashboardTree(app);
    key(list, 'a');
    expect(readTreeUi(app.state.dashboardTreeUi, 'w1').keyboardRowKey).toBe('w1:sales');
  });

  it('installs NO key handler for an empty tree, so keys are inert', () => {
    const empty = treeApp({ currentWorkspace: { id: 'w1', dashboards: [], queries: [] } });
    renderDashboardTree(empty.app);
    // That absence is why `handleTreeKeydown` needs no empty-rows guard.
    expect(empty.list.onkeydown).toBeNull();
    expect(() => key(empty.list, 'ArrowDown')).not.toThrow();
  });

  it('moves DOM focus with the roving tabindex', () => {
    const { app, list } = treeApp();
    renderDashboardTree(app);
    rowFor(list, 'w1:sales').focus();
    key(list, 'ArrowDown');
    expect(document.activeElement).toBe(rowFor(list, 'w1:ops'));
    expect(rowFor(list, 'w1:ops').getAttribute('tabindex')).toBe('0');
  });
});

describe('renderDashboardTree — focus and scroll across repaints', () => {
  it('restores focus after a repaint ONLY when the tree already had it', () => {
    const { app, list } = treeApp();
    renderDashboardTree(app);
    rowFor(list, 'w1:sales').focus();
    renderDashboardTree(app);
    expect(document.activeElement).toBe(rowFor(list, 'w1:sales'));

    // A background repaint (an external workspace commit) must NOT steal focus
    // from whatever the user is actually typing in.
    const elsewhere = document.createElement('input');
    document.body.appendChild(elsewhere);
    elsewhere.focus();
    renderDashboardTree(app);
    expect(document.activeElement).toBe(elsewhere);
  });

  it('records scroll position without repainting, and restores it on the next paint', () => {
    const { app, list } = treeApp();
    renderDashboardTree(app);
    const painted = rows(list)[0];
    list.scrollTop = 0; // happy-dom has no layout, so drive the value directly
    Object.defineProperty(list, 'scrollTop', { value: 137, writable: true, configurable: true });
    list.dispatchEvent(new Event('scroll'));
    expect(readTreeUi(app.state.dashboardTreeUi, 'w1').scrollTop).toBe(137);
    // Recording a scroll must not rebuild the rows — that is why the state is not
    // a signal.
    expect(rows(list)[0]).toBe(painted);
  });

  it('keeps the keyboard owner on a row that is still rendered after a collapse', () => {
    const { app, list } = treeApp();
    openAll(app, 'sales');
    renderDashboardTree(app);
    key(list, 'ArrowDown');
    key(list, 'ArrowDown'); // a filter row, three levels deep
    expect(readTreeUi(app.state.dashboardTreeUi, 'w1').keyboardRowKey).toBe('w1:sales:filter:f-src');
    // Collapsing the Dashboard takes that row out of the visible set; the owner
    // must fall back to something real or the tree becomes keyboard-unreachable.
    setUi(app, (ui) => toggleDashboardExpanded(ui, 'sales'));
    renderDashboardTree(app);
    expect(readTreeUi(app.state.dashboardTreeUi, 'w1').keyboardRowKey).toBe('w1:sales');
    expect(rows(list).filter((row) => row.getAttribute('tabindex') === '0')).toHaveLength(1);
  });
});

describe('renderDashboardTree — read-only guarantees', () => {
  it('executes NO query and creates no viewer session when rendering or searching', () => {
    const { app, list } = treeApp();
    // #426: "no SQL is executed by rendering or searching the Dashboard tree" and
    // "no hidden Dashboard viewer/session is created by rendering the tree".
    const executeRead = vi.fn();
    app.exec = { ...app.exec, executeRead } as typeof app.exec;
    const renderDashboard = vi.fn();
    app.renderDashboard = renderDashboard;
    openAll(app, 'sales');
    renderDashboardTree(app);
    setUi(app, (ui) => setTreeSearch(ui, 'revenue'));
    renderDashboardTree(app);
    expect(labels(list)).toContain('Revenue');
    expect(executeRead).not.toHaveBeenCalled();
    expect(renderDashboard).not.toHaveBeenCalled();
  });

  it('never mutates the workspace aggregate', () => {
    const { app } = treeApp();
    const before = JSON.stringify(app.currentWorkspace);
    openAll(app, 'sales');
    renderDashboardTree(app);
    setUi(app, (ui) => setTreeSearch(ui, 'zone'));
    renderDashboardTree(app);
    expect(JSON.stringify(app.currentWorkspace)).toBe(before);
  });
});

describe('renderDashboardTree — search', () => {
  it('narrows to matches, exposes ancestors, and restores state when cleared', () => {
    const { app, list } = treeApp();
    setUi(app, (ui) => setTreeSearch(ui, 'revenue'));
    renderDashboardTree(app);
    expect(labels(list)).toEqual(['Sales', 'Filters', 'Panels', 'Revenue']);
    setUi(app, (ui) => setTreeSearch(ui, ''));
    renderDashboardTree(app);
    // Back to exactly the collapsed collection — search never wrote expansion.
    expect(labels(list)).toEqual(['Sales', 'Ops']);
  });

  it('marks the matching row without marking the ancestors it exposed', () => {
    const { app, list } = treeApp();
    setUi(app, (ui) => setTreeSearch(ui, 'revenue'));
    renderDashboardTree(app);
    expect(rowFor(list, 'w1:sales:tile:t1').classList.contains('match')).toBe(true);
    expect(rowFor(list, 'w1:sales').classList.contains('match')).toBe(false);
  });

  it('a search-forced row cannot be toggled, by chevron or by click', () => {
    vi.useFakeTimers();
    const { app, list } = treeApp();
    setUi(app, (ui) => setTreeSearch(ui, 'revenue'));
    renderDashboardTree(app);
    const dashboardRow = rowFor(list, 'w1:sales');
    // No chevron handler at all, rather than an affordance that lies.
    expect(dashboardRow.querySelector('.chev')!.getAttribute('onclick')).toBeNull();
    click(dashboardRow.querySelector('.chev')!);
    click(dashboardRow);
    vi.advanceTimersByTime(400);
    // Nothing was written, so clearing the search restores the untouched state.
    expect(readTreeUi(app.state.dashboardTreeUi, 'w1').expandedDashboardIds.size).toBe(0);
    setUi(app, (ui) => setTreeSearch(ui, ''));
    renderDashboardTree(app);
    expect(labels(list)).toEqual(['Sales', 'Ops']);
  });

  it('Left/Right cannot collapse a search-forced row either', () => {
    const { app, list } = treeApp();
    setUi(app, (ui) => setTreeSearch(ui, 'revenue'));
    renderDashboardTree(app);
    key(list, 'ArrowLeft');
    expect(readTreeUi(app.state.dashboardTreeUi, 'w1').expandedDashboardIds.size).toBe(0);
    // Right on a forced-open row steps INTO it instead of expanding it.
    key(list, 'ArrowRight');
    expect(readTreeUi(app.state.dashboardTreeUi, 'w1').keyboardRowKey).toBe('w1:sales:group:filters');
  });

  it('typing in the search box repaints the rows but keeps the input mounted', () => {
    const { app, list } = treeApp();
    renderDashboardTree(app);
    const input = app.dom.dashboardSearchInput!;
    input.value = 'revenue';
    input.dispatchEvent(new Event('input'));
    expect(labels(list)).toContain('Revenue');
    // The caret survives because the input lives OUTSIDE the repainted row list.
    expect(app.dom.dashboardSearchInput).toBe(input);
    expect(input.isConnected).toBe(true);
  });

  // The input is built once, OUTSIDE the repainted list, so it does not follow a
  // workspace switch on its own — the tree would filter by the new workspace's
  // search text while the box still displayed the old one.
  it('syncs the search box to the workspace whose tree is being rendered', () => {
    const { app } = treeApp();
    const input = app.dom.dashboardSearchInput!;
    input.value = 'revenue';
    input.dispatchEvent(new Event('input'));
    expect(readTreeUi(app.state.dashboardTreeUi, 'w1').searchText).toBe('revenue');

    app.currentWorkspace = { ...workspace(), id: 'w2' } as never;
    renderDashboardTree(app);
    // A workspace with no search of its own shows an EMPTY box, matching its tree.
    expect(input.value).toBe('');

    app.currentWorkspace = workspace() as never;
    renderDashboardTree(app);
    // ...and coming back restores both together.
    expect(input.value).toBe('revenue');
    expect(labels(app.dom.dashboardTreeList!)).toContain('Revenue');
  });

  it('does not touch the search box when it already agrees, so the caret survives', () => {
    const { app } = treeApp();
    const input = app.dom.dashboardSearchInput!;
    input.value = 'revenue';
    input.dispatchEvent(new Event('input'));
    let writes = 0;
    const raw = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!;
    Object.defineProperty(input, 'value', {
      configurable: true,
      get: () => raw.get!.call(input),
      set: (v) => { writes += 1; raw.set!.call(input, v); },
    });
    renderDashboardTree(app);
    expect(writes).toBe(0);
  });

  it('typing cancels a pending single-click from before the search', () => {
    vi.useFakeTimers();
    const { app, list } = treeApp();
    openAll(app, 'sales');
    renderDashboardTree(app);
    click(rowFor(list, 'w1:sales:tile:t1'));
    const input = app.dom.dashboardSearchInput!;
    input.value = 'ops';
    input.dispatchEvent(new Event('input'));
    vi.advanceTimersByTime(400);
    expect(app.openSavedQuery).not.toHaveBeenCalled();
  });
});
