import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  renderDashboardTree, cancelDashboardTreeClicks, beginLibraryDrag, endLibraryDrag,
} from '../../src/ui/dashboard-tree.js';
import { LIBRARY_QUERY_MIME } from '../../src/ui/dnd-mime.js';
import type { DashboardTreeApp } from '../../src/ui/dashboard-tree.js';
import { buildSidebarUpper } from '../../src/ui/sidebar-upper.js';
import { makeApp } from '../helpers/fake-app.js';
import {
  EMPTY_TREE_UI, groupStateKey, readTreeUi, setTreeSearch, toggleDashboardExpanded,
  toggleGroupExpanded,
} from '../../src/core/dashboard-tree-ui-state.js';
import type { MainSurfaceState } from '../../src/application/main-surface.js';
import type { TreeWorkspace } from '../../src/application/dashboard-tree-model.js';
import type { App } from '../../src/ui/app.types.js';
import type { SavedQueryV2, StoredWorkspaceV5 } from '../../src/generated/json-schema.types.js';

type FakeApp = ReturnType<typeof makeApp>;

const query = (id: string, name: string, sql = 'SELECT 1'): SavedQueryV2 => ({
  id, sql, specVersion: 1, spec: { specVersion: 1, name },
});

/**
 * The standard fixture: two Dashboards. `sales` has two panels (one with a broken
 * query reference) plus two variables — `country`, inferred from the working
 * panel's `{country:String}` and configured with option SQL, and `region`, an
 * ORPHANED configuration no panel declares any more.
 */
const workspace = (): TreeWorkspace => ({
  id: 'w1',
  queries: [query('q1', 'Revenue', 'SELECT * FROM rev WHERE c = {country:String}')],
  dashboards: [
    {
      id: 'sales', title: 'Sales',
      tiles: [{ id: 't1', queryId: 'q1' }, { id: 't-broken', queryId: 'q-gone' }],
      variableConfigs: {
        country: { sql: 'SELECT c, c FROM countries' },
        region: { sql: 'SELECT r, r FROM regions', lastKnownType: 'String' },
      },
    },
    { id: 'ops', title: 'Ops', tiles: [] },
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
  // #457: the tree ROUTES a variable row now — it no longer mounts an editor of
  // its own — so what a click must produce is exactly this call.
  app.openVariableTab = vi.fn();
  Object.assign(app, over);
  // #447: the tree's one write (deleting an orphaned variable's option SQL) goes
  // through `mutateWorkspace`. The fixture's version reads the SAME workspace the
  // rows were derived from as committed truth, and records the candidate.
  const committed: (StoredWorkspaceV5 | null)[] = [];
  if (!('mutateWorkspace' in over)) {
    app.mutateWorkspace = (async (transform) => {
      const input = await transform(app.currentWorkspace as StoredWorkspaceV5);
      const candidate = input === null ? null : input.candidate;
      committed.push(candidate);
      if (candidate === null) return { ok: false, aborted: true };
      return { ok: true, workspace: candidate, dashboardRevision: null };
    }) as App['mutateWorkspace'];
  }
  const upper = buildSidebarUpper(app, []);
  document.body.appendChild(upper.dashboardsHost);
  upper.dashboardsHost.hidden = false;
  return { app, upper, committed, list: app.dom.dashboardTreeList! };
};

const setUi = (app: DashboardTreeApp, mutate: (ui: typeof EMPTY_TREE_UI) => typeof EMPTY_TREE_UI): void => {
  app.state.dashboardTreeUi.set('w1', mutate(readTreeUi(app.state.dashboardTreeUi, 'w1')));
};
const openAll = (app: DashboardTreeApp, id: string): void => setUi(app, (ui) =>
  toggleGroupExpanded(toggleGroupExpanded(toggleDashboardExpanded(ui, id), id, 'variables'), id, 'panels'));

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

beforeEach(() => {
  // #457: no per-document teardown any more. The variable DRAWER registered itself
  // per document and leaked into the next case if left open; a variable row now
  // just calls `app.openVariableTab`, which this fixture records.
  document.body.innerHTML = '';
});

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
    expect(populated.list.textContent).toContain('No matching dashboards, variables, or panels.');
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
    // A healthy variable carries no marker at all.
    const healthy = rowFor(list, 'w1:sales:variable:country');
    expect(healthy.classList.contains('is-invalid')).toBe(false);
    expect(healthy.classList.contains('is-warning')).toBe(false);
    expect(healthy.querySelector('.dash-tree-warn')).toBeNull();
    expect(healthy.hasAttribute('title')).toBe(false);
  });

  it('renders a variable row with its name, its type and no menu', () => {
    const { app, list } = treeApp();
    openAll(app, 'sales');
    renderDashboardTree(app);
    const variable = rowFor(list, 'w1:sales:variable:country');
    expect(variable.querySelector('.label')!.textContent).toBe('country');
    expect(variable.querySelector('.meta')!.textContent).toBe('String');
    // #447 explicitly forbids the `…` overflow menu on a variable row.
    expect(variable.querySelector('.dash-tree-menu-btn')).toBeNull();
    // Panel rows keep theirs.
    expect(rowFor(list, 'w1:sales:tile:t1').querySelector('.dash-tree-menu-btn')).not.toBeNull();
  });

  it('labels the Variables group with the brace glyph and a count', () => {
    const { app, list } = treeApp();
    openAll(app, 'sales');
    renderDashboardTree(app);
    const groups = rows(list).filter((row) => row.classList.contains('dash-tree-group'));
    expect(groups.map((row) => row.querySelector('.label')!.textContent)).toEqual(['Variables', 'Panels']);
    // Two variables: the inferred `country` plus the orphaned `region` config.
    expect(rowFor(list, 'w1:sales:group:variables').querySelector('.dash-tree-count')!.textContent).toBe('· 2');
    // The two groups must not be confusable at a glance.
    expect(rowFor(list, 'w1:sales:group:variables').querySelector('.icon')!.innerHTML)
      .not.toBe(rowFor(list, 'w1:sales:group:panels').querySelector('.icon')!.innerHTML);
  });

  // #447: colour is NEVER the only signal, and the two annotated states must not
  // be announced identically.
  it('distinguishes a conflict (error) from an unused variable (warning) by class, glyph, WORD and label', () => {
    const conflicted = treeApp({
      currentWorkspace: {
        id: 'w1',
        queries: [
          query('q1', 'A', 'SELECT 1 WHERE c = {customer_id:String}'),
          query('q2', 'B', 'SELECT 1 WHERE c = {customer_id:UInt64}'),
        ],
        dashboards: [{
          id: 'sales', title: 'Sales',
          tiles: [{ id: 't1', queryId: 'q1' }, { id: 't2', queryId: 'q2' }],
        }],
      } as never,
    });
    openAll(conflicted.app, 'sales');
    renderDashboardTree(conflicted.app);
    const conflict = rowFor(conflicted.list, 'w1:sales:variable:customer_id');
    expect(conflict.classList.contains('is-invalid')).toBe(true);
    expect(conflict.classList.contains('is-warning')).toBe(false);
    expect(conflict.querySelector('.dash-tree-warn')!.getAttribute('aria-label')).toBe('Type conflict');
    expect(conflict.querySelector('.dash-tree-warn-mild')).toBeNull();
    expect(conflict.querySelector('.dash-tree-status')).toBeNull();
    expect(conflict.getAttribute('title')).toContain('incompatible types');
    expect(conflict.querySelector('.meta')!.textContent).toBe('String | UInt64');

    const { app, list } = treeApp();
    openAll(app, 'sales');
    renderDashboardTree(app);
    const unused = rowFor(list, 'w1:sales:variable:region');
    expect(unused.classList.contains('is-warning')).toBe(true);
    expect(unused.classList.contains('is-invalid')).toBe(false);
    // A DIFFERENT accessible label, a different glyph, and the word in text.
    const marker = unused.querySelector('.dash-tree-warn')!;
    expect(marker.getAttribute('aria-label')).toBe('Unused');
    expect(marker.getAttribute('role')).toBe('img');
    expect(marker.classList.contains('dash-tree-warn-mild')).toBe(true);
    expect(marker.innerHTML).not.toBe(conflict.querySelector('.dash-tree-warn')!.innerHTML);
    expect(unused.querySelector('.dash-tree-status')!.textContent).toBe('unused');
    expect(unused.getAttribute('title')).toContain('not referenced by any Dashboard panel');
  });

  it('marks the current Dashboard and member distinctly from keyboard focus', () => {
    const surface: MainSurfaceState = {
      kind: 'dashboard', dashboardId: 'sales', mode: 'edit',
      currentMember: { kind: 'tile', id: 't1' }, pendingFocus: null, pendingScrollTop: null,
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

  // #447/#457: a variable row opens its own tab, IMMEDIATELY — it has no double or
  // Shift gesture to arbitrate against, so waiting out the double-click window
  // would only make the tree feel slow.
  it('a variable row click opens its variable tab with no delay, and opens no query', () => {
    const { app, list } = treeApp();
    openAll(app, 'sales');
    renderDashboardTree(app);
    click(rowFor(list, 'w1:sales:variable:country'));
    // Before `settle()`: the row must NOT wait out the double-click window.
    expect(app.openVariableTab).toHaveBeenCalledExactlyOnceWith('sales', 'country');
    settle();
    expect(app.openVariableTab).toHaveBeenCalledTimes(1);
    expect(app.openSavedQuery).not.toHaveBeenCalled();
    expect(app.openDashboard).not.toHaveBeenCalled();
  });

  it('an ORPHANED variable row still opens its tab', () => {
    const { app, list } = treeApp();
    openAll(app, 'sales');
    renderDashboardTree(app);
    click(rowFor(list, 'w1:sales:variable:region'));
    expect(app.openVariableTab).toHaveBeenCalledExactlyOnceWith('sales', 'region');
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
    click(menuButton(list, 'w1:sales:tile:t-broken'));
    expect(menuLabels()[0]).toBe('Open query');
    const disabled = document.querySelector<HTMLButtonElement>('.dash-tree-menu .is-disabled')!;
    expect(disabled.textContent).toContain('Open query');
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

describe('renderDashboardTree — deleting an orphaned variable (#447)', () => {
  const trash = (list: HTMLElement, rowKey: string): HTMLButtonElement | null =>
    rowFor(list, rowKey).querySelector<HTMLButtonElement>('.dash-tree-del-btn');
  const confirmItems = (): HTMLElement[] =>
    [...document.querySelectorAll<HTMLElement>('.dash-tree-confirm .fm-item')];
  const open = () => {
    const fixture = treeApp();
    openAll(fixture.app, 'sales');
    renderDashboardTree(fixture.app);
    return fixture;
  };

  it('renders the trash affordance on an ORPHAN row only', () => {
    const { list } = open();
    expect(trash(list, 'w1:sales:variable:region')).not.toBeNull();
    // Never on an active variable, a panel, a group or the Dashboard row.
    expect(trash(list, 'w1:sales:variable:country')).toBeNull();
    expect(trash(list, 'w1:sales:tile:t1')).toBeNull();
    expect(trash(list, 'w1:sales:group:variables')).toBeNull();
    expect(trash(list, 'w1:sales')).toBeNull();
  });

  it('names what it deletes, for the keyboard and for assistive technology', () => {
    const { list } = open();
    const button = trash(list, 'w1:sales:variable:region')!;
    expect(button.getAttribute('aria-label')).toBe('Delete the stored option SQL for region');
    expect(button.type).toBe('button');
  });

  it('CONFIRMS before deleting, and deletes nothing until the confirmation is taken', async () => {
    const { list, committed } = open();
    click(trash(list, 'w1:sales:variable:region')!);
    // A confirmation, not a deletion: the consequence is stated, and both taking
    // and refusing it are explicit, keyboard-reachable buttons.
    expect(document.querySelector('.dash-tree-confirm')).not.toBeNull();
    expect(document.querySelector('.dash-tree-confirm .fm-section')!.textContent)
      .toContain('The SQL is lost');
    expect(confirmItems().map((item) => item.textContent))
      .toEqual(['Delete option SQL', 'Cancel']);
    await Promise.resolve();
    expect(committed).toEqual([]);
  });

  it('deletes nothing when the confirmation is refused', async () => {
    const { list, committed } = open();
    click(trash(list, 'w1:sales:variable:region')!);
    click(confirmItems()[1]);
    await Promise.resolve(); await Promise.resolve();
    expect(committed).toEqual([]);
    expect(document.querySelector('.dash-tree-confirm')).toBeNull();
  });

  it('removes ONLY that variableConfigs entry, leaving panel queries and other configs alone', async () => {
    const { list, committed } = open();
    click(trash(list, 'w1:sales:variable:region')!);
    click(confirmItems()[0]);
    await Promise.resolve(); await Promise.resolve();
    const dashboard = committed[0]!.dashboards[0];
    // `region` is gone — both its sql and its lastKnownType — and nothing else moved.
    expect(dashboard.variableConfigs).toEqual({ country: { sql: 'SELECT c, c FROM countries' } });
    expect(dashboard.tiles).toEqual(workspace().dashboards![0].tiles);
    expect(committed[0]!.queries).toEqual(workspace().queries);
    expect(committed[0]!.dashboards[1]).toEqual(workspace().dashboards![1]);
  });

  it('does NOT also open the variable tab', () => {
    vi.useFakeTimers();
    const { app, list } = open();
    click(trash(list, 'w1:sales:variable:region')!);
    vi.advanceTimersByTime(400);
    // The trash button bypasses row activation entirely (like the action menu).
    expect(app.openVariableTab).not.toHaveBeenCalled();
    click(confirmItems()[0]);
    vi.advanceTimersByTime(400);
    expect(app.openVariableTab).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('cancels its OWN row\'s pending click but no other row\'s', () => {
    vi.useFakeTimers();
    const { app, list } = open();
    // A pending single belongs to the PANEL row...
    click(rowFor(list, 'w1:sales:tile:t1'));
    // ...and the trash button clicked here belongs to a DIFFERENT row.
    click(trash(list, 'w1:sales:variable:region')!);
    vi.advanceTimersByTime(400);
    expect(app.openSavedQuery).toHaveBeenCalledExactlyOnceWith('q1');
    vi.useRealTimers();
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
    expect(readTreeUi(app.state.dashboardTreeUi, 'w1').keyboardRowKey).toBe('w1:sales:group:variables');
  });

  it('Right on an expanded LEAF-less group with no children does nothing', () => {
    const { app, list } = treeApp();
    setUi(app, (ui) => toggleGroupExpanded(toggleDashboardExpanded(ui, 'ops'), 'ops', 'variables'));
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
    key(list, 'ArrowDown'); // Variables group
    key(list, 'ArrowDown'); // first variable
    expect(readTreeUi(app.state.dashboardTreeUi, 'w1').keyboardRowKey).toBe('w1:sales:variable:country');
    key(list, 'ArrowLeft'); // a leaf: step out to the group
    expect(readTreeUi(app.state.dashboardTreeUi, 'w1').keyboardRowKey).toBe('w1:sales:group:variables');
    key(list, 'ArrowLeft'); // an open group: collapse it
    expect(readTreeUi(app.state.dashboardTreeUi, 'w1').expandedGroups.has(groupStateKey('sales', 'variables'))).toBe(false);
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
    key(list, 'End'); // Ops
    key(list, 'ArrowUp'); // the broken tile — its query cannot be opened
    expect(readTreeUi(app.state.dashboardTreeUi, 'w1').keyboardRowKey).toBe('w1:sales:tile:t-broken');
    key(list, 'Enter');
    expect(app.openSavedQuery).not.toHaveBeenCalled();
  });

  // #447/#457: a variable row's primary action is its own tab, and Enter is the
  // keyboard equivalent — the row has no `…` menu to reach it through.
  it('Enter on a variable row opens its variable tab', () => {
    const { app, list } = treeApp();
    openAll(app, 'sales');
    renderDashboardTree(app);
    key(list, 'ArrowDown'); // Variables group
    key(list, 'ArrowDown'); // country
    expect(readTreeUi(app.state.dashboardTreeUi, 'w1').keyboardRowKey).toBe('w1:sales:variable:country');
    key(list, 'Enter');
    expect(app.openVariableTab).toHaveBeenCalledExactlyOnceWith('sales', 'country');
    // Shift+Enter has no Edit action to run on a variable row.
    key(list, 'Enter', { shiftKey: true });
    expect(app.openDashboard).not.toHaveBeenCalled();
  });

  it('Shift+Enter on a group row does nothing — it has no Edit action', () => {
    const { app, list } = treeApp();
    setUi(app, (ui) => toggleDashboardExpanded(ui, 'sales'));
    renderDashboardTree(app);
    key(list, 'ArrowDown'); // Variables group
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
    key(list, 'ArrowDown'); // a variable row, three levels deep
    expect(readTreeUi(app.state.dashboardTreeUi, 'w1').keyboardRowKey).toBe('w1:sales:variable:country');
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
    expect(labels(list)).toEqual(['Sales', 'Variables', 'Panels', 'Revenue']);
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
    // The forced GROUP row likewise offers no action to run at all — a group whose
    // expansion the search owns must not write the user's own expansion set.
    click(rowFor(list, 'w1:sales:group:panels'));
    vi.advanceTimersByTime(400);
    // Nothing was written, so clearing the search restores the untouched state.
    expect(readTreeUi(app.state.dashboardTreeUi, 'w1').expandedDashboardIds.size).toBe(0);
    expect(readTreeUi(app.state.dashboardTreeUi, 'w1').expandedGroups.size).toBe(0);
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
    expect(readTreeUi(app.state.dashboardTreeUi, 'w1').keyboardRowKey).toBe('w1:sales:group:variables');
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

describe('Library-query drop targets (#428)', () => {
  const PAYLOAD = JSON.stringify({ kind: 'library-query', workspaceId: 'w1', queryId: 'q-lib' });

  /** A drag event carrying whatever MIME types the case needs. `types` is all a
   *  real `dragover` can read; `getData` only answers on `drop`. */
  const dragEvent = (type: string, over: {
    types?: string[]; data?: Record<string, string>; relatedTarget?: EventTarget | null;
  } = {}): Event => {
    const types = over.types ?? [LIBRARY_QUERY_MIME];
    const data = over.data ?? { [LIBRARY_QUERY_MIME]: PAYLOAD };
    return Object.assign(new Event(type, { bubbles: true, cancelable: true }), {
      dataTransfer: { types, getData: (t: string) => data[t] ?? '', dropEffect: 'none' },
      relatedTarget: over.relatedTarget ?? null,
    });
  };

  /**
   * The tree fixture plus a Library query to drag, and a `mutateWorkspace` that
   * PROJECTS its commit back onto `app.currentWorkspace` — as the real primitive
   * does — so post-commit reads (the variable reconcile) see committed truth.
   */
  const dropApp = (over: Partial<DashboardTreeApp> = {}) => {
    const base = treeApp(over);
    const { app } = base;
    const ws = app.currentWorkspace as unknown as StoredWorkspaceV5;
    ws.storageVersion = 5; ws.key = 'w'; ws.name = 'W';
    ws.queries = [...ws.queries, query('q-lib', 'Countries', 'SELECT c, c FROM countries')];
    const committed: StoredWorkspaceV5[] = [];
    if (!('mutateWorkspace' in over)) {
      app.mutateWorkspace = (async (transform) => {
        const input = await transform(app.currentWorkspace as StoredWorkspaceV5);
        const candidate = input === null ? null : input.candidate;
        if (candidate === null) {
          return { ok: false, aborted: true, data: input === null ? undefined : input.data };
        }
        committed.push(candidate);
        app.currentWorkspace = candidate as never;
        return { ok: true, workspace: candidate, dashboardRevision: null, data: input!.data };
      }) as App['mutateWorkspace'];
    }
    return { ...base, committed };
  };

  const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

  describe('eligibility is static markup', () => {
    it('marks the Dashboard row, the Panels group and an INFERRED variable row', () => {
      const { app, list } = dropApp();
      openAll(app, 'sales');
      renderDashboardTree(app);

      expect(rowFor(list, 'w1:sales').dataset.droptarget).toBe('panel');
      expect(rowFor(list, 'w1:sales:group:panels').dataset.droptarget).toBe('panel');
      expect(rowFor(list, 'w1:sales:variable:country').dataset.droptarget).toBe('variable');
    });

    it('leaves the Variables group, an ORPHAN variable and a panel row unmarked', () => {
      const { app, list } = dropApp();
      openAll(app, 'sales');
      renderDashboardTree(app);

      // The Variables group does not identify WHICH variable would receive the SQL.
      expect(rowFor(list, 'w1:sales:group:variables').dataset.droptarget).toBeUndefined();
      // `region` is configured but no panel declares it any more.
      expect(rowFor(list, 'w1:sales:variable:region').dataset.droptarget).toBeUndefined();
      expect(rowFor(list, 'w1:sales:tile:t1').dataset.droptarget).toBeUndefined();
    });

    it('is present whether or not a drag is in flight — revealing it costs no repaint', () => {
      const { app, list } = dropApp();
      renderDashboardTree(app);
      expect(rowFor(list, 'w1:sales').dataset.droptarget).toBe('panel');
      expect(list.classList.contains('dash-dragging')).toBe(false);
      const before = rowFor(list, 'w1:sales');

      beginLibraryDrag(app);
      expect(list.classList.contains('dash-dragging')).toBe(true);
      endLibraryDrag(app);
      expect(list.classList.contains('dash-dragging')).toBe(false);
      // The SAME nodes throughout: a repaint here would `replaceChildren()` the
      // row under the pointer and strand the drop mid-drag.
      expect(rowFor(list, 'w1:sales')).toBe(before);
    });
  });

  describe('hover feedback', () => {
    it('accepts the drag on an eligible row and marks it active', () => {
      const { app, list } = dropApp();
      renderDashboardTree(app);
      const row = rowFor(list, 'w1:sales');

      const event = dragEvent('dragover');
      row.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
      expect(row.classList.contains('dash-drop-target')).toBe(true);
    });

    it('marks only ONE row at a time', () => {
      const { app, list } = dropApp();
      renderDashboardTree(app);

      rowFor(list, 'w1:sales').dispatchEvent(dragEvent('dragenter'));
      rowFor(list, 'w1:ops').dispatchEvent(dragEvent('dragenter'));

      expect(rowFor(list, 'w1:sales').classList.contains('dash-drop-target')).toBe(false);
      expect(rowFor(list, 'w1:ops').classList.contains('dash-drop-target')).toBe(true);
    });

    it('does NOT accept a drag carrying no library payload', () => {
      const { app, list } = dropApp();
      renderDashboardTree(app);
      const row = rowFor(list, 'w1:sales');

      const event = dragEvent('dragover', { types: ['text/plain'] });
      row.dispatchEvent(event);
      // Falls through to native behaviour rather than looking droppable.
      expect(event.defaultPrevented).toBe(false);
      expect(row.classList.contains('dash-drop-target')).toBe(false);
    });

    it('does NOT accept a drag on an ineligible row', () => {
      const { app, list } = dropApp();
      openAll(app, 'sales');
      renderDashboardTree(app);
      const group = rowFor(list, 'w1:sales:group:variables');

      const event = dragEvent('dragover');
      group.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
      expect(group.classList.contains('dash-drop-target')).toBe(false);
    });

    it('keeps the mark while the pointer crosses onto one of the row\'s own children', () => {
      const { app, list } = dropApp();
      renderDashboardTree(app);
      const row = rowFor(list, 'w1:sales');
      row.dispatchEvent(dragEvent('dragenter'));

      row.dispatchEvent(dragEvent('dragleave', { relatedTarget: row.querySelector('.label') }));
      expect(row.classList.contains('dash-drop-target')).toBe(true);
    });

    it('clears the mark when the pointer genuinely leaves the row', () => {
      const { app, list } = dropApp();
      renderDashboardTree(app);
      const row = rowFor(list, 'w1:sales');
      row.dispatchEvent(dragEvent('dragenter'));

      row.dispatchEvent(dragEvent('dragleave', { relatedTarget: list }));
      expect(row.classList.contains('dash-drop-target')).toBe(false);
    });

    it('ignores a dragleave belonging to a row that is not the active target', () => {
      const { app, list } = dropApp();
      renderDashboardTree(app);
      rowFor(list, 'w1:sales').dispatchEvent(dragEvent('dragenter'));

      rowFor(list, 'w1:ops').dispatchEvent(dragEvent('dragleave', { relatedTarget: list }));
      expect(rowFor(list, 'w1:sales').classList.contains('dash-drop-target')).toBe(true);
    });

    it('re-applies the active mark after a repaint replaced the row', () => {
      const { app, list } = dropApp();
      renderDashboardTree(app);
      rowFor(list, 'w1:sales').dispatchEvent(dragEvent('dragenter'));

      renderDashboardTree(app);
      expect(rowFor(list, 'w1:sales').classList.contains('dash-drop-target')).toBe(true);
    });

    it('is inert when the tree has no mount point', () => {
      // `endLibraryDrag` is called from the Library row's `dragend`, which can
      // fire while the Dashboards role has never been built.
      const { app } = dropApp();
      (app.dom as { dashboardTreeList: HTMLElement | null }).dashboardTreeList = null;
      expect(() => { beginLibraryDrag(app); endLibraryDrag(app); }).not.toThrow();
    });

    it('dragend clears every visual trace', () => {
      const { app, list } = dropApp();
      renderDashboardTree(app);
      beginLibraryDrag(app);
      rowFor(list, 'w1:sales').dispatchEvent(dragEvent('dragenter'));

      endLibraryDrag(app);
      expect(list.querySelector('.dash-drop-target')).toBeNull();
      expect(list.classList.contains('dash-dragging')).toBe(false);
    });
  });

  describe('hover auto-expand', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it('opens a collapsed Dashboard AND both its groups, without navigating', () => {
      const { app, list } = dropApp();
      renderDashboardTree(app);
      expect(labels(list)).toEqual(['Sales', 'Ops']);

      rowFor(list, 'w1:sales').dispatchEvent(dragEvent('dragover'));
      vi.advanceTimersByTime(600);

      // Variables rows are only reachable once BOTH the Dashboard and the
      // Variables group are open.
      expect(labels(list)).toContain('country');
      expect(labels(list)).toContain('Revenue');
      expect(app.openDashboard).not.toHaveBeenCalled();
      expect(app.openSavedQuery).not.toHaveBeenCalled();
    });

    it('opens the Variables GROUP on hover even though it rejects drops', () => {
      // Otherwise a variable row could never be reached by dragging at all.
      const { app, list } = dropApp();
      setUi(app, (ui) => toggleDashboardExpanded(ui, 'sales'));
      renderDashboardTree(app);
      expect(labels(list)).not.toContain('country');

      rowFor(list, 'w1:sales:group:variables').dispatchEvent(dragEvent('dragover'));
      vi.advanceTimersByTime(600);
      expect(labels(list)).toContain('country');
    });

    it('does not expand before the delay elapses', () => {
      const { app, list } = dropApp();
      renderDashboardTree(app);

      rowFor(list, 'w1:sales').dispatchEvent(dragEvent('dragover'));
      vi.advanceTimersByTime(300);
      expect(labels(list)).toEqual(['Sales', 'Ops']);
    });

    it('cancels the timer when the pointer leaves', () => {
      const { app, list } = dropApp();
      renderDashboardTree(app);
      const row = rowFor(list, 'w1:sales');

      row.dispatchEvent(dragEvent('dragover'));
      row.dispatchEvent(dragEvent('dragleave', { relatedTarget: list }));
      vi.advanceTimersByTime(600);
      expect(labels(list)).toEqual(['Sales', 'Ops']);
    });

    it('arms exactly ONE timer however many dragover events arrive', () => {
      // `dragover` repeats every ~350ms while the pointer rests, so re-arming
      // per event would both leak timers and push the expansion out forever.
      const setTimeoutSpy = vi.fn((fn: () => void, ms: number) => globalThis.setTimeout(fn, ms));
      const { app, list } = dropApp({
        window: { setTimeout: setTimeoutSpy, clearTimeout: globalThis.clearTimeout } as never,
      });
      renderDashboardTree(app);
      const row = rowFor(list, 'w1:sales');

      row.dispatchEvent(dragEvent('dragover'));
      row.dispatchEvent(dragEvent('dragover'));
      row.dispatchEvent(dragEvent('dragover'));
      expect(setTimeoutSpy).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(600);
      expect(labels(list)).toContain('country');
    });

    it('moving between rows hands the timer over without losing a tick', () => {
      // Per the HTML drag model `dragenter` on the NEW target fires BEFORE
      // `dragleave` on the old one. Without a hand-over, `ops` would fail to arm
      // (sales' timer still pending) and sales' departure would then cancel
      // everything, leaving nobody counting down until the next dragover tick.
      const { app, list } = dropApp();
      renderDashboardTree(app);
      const sales = rowFor(list, 'w1:sales');
      const ops = rowFor(list, 'w1:ops');

      sales.dispatchEvent(dragEvent('dragover'));
      // Pointer moves sales -> ops: enter first, then leave.
      ops.dispatchEvent(dragEvent('dragenter'));
      sales.dispatchEvent(dragEvent('dragleave', { relatedTarget: ops }));

      vi.advanceTimersByTime(600);
      // `ops` — the row the pointer is actually on — expanded, and `sales` did not.
      expect(rowFor(list, 'w1:ops:group:panels')).toBeTruthy();
      expect(labels(list)).not.toContain('country');
    });

    it('the row the pointer LEFT does not cancel the timer that took over', () => {
      const { app, list } = dropApp();
      renderDashboardTree(app);
      const ops = rowFor(list, 'w1:ops');

      rowFor(list, 'w1:sales').dispatchEvent(dragEvent('dragover'));
      ops.dispatchEvent(dragEvent('dragenter'));
      // A late `dragleave` from the old row must not disarm the new one.
      rowFor(list, 'w1:sales').dispatchEvent(dragEvent('dragleave', { relatedTarget: list }));

      vi.advanceTimersByTime(600);
      expect(rowFor(list, 'w1:ops:group:variables')).toBeTruthy();
    });

    it('finds nothing to do when the row opened by other means while it waited', () => {
      // The chevron is the instant expansion path and does not cancel a pending
      // hover timer. When that timer finally fires, the state it wanted is
      // already in place — it must return rather than repaint under the drag.
      const { app, list } = dropApp();
      setUi(app, (ui) => toggleDashboardExpanded(ui, 'sales'));
      renderDashboardTree(app);

      rowFor(list, 'w1:sales:group:variables').dispatchEvent(dragEvent('dragover'));
      click(rowFor(list, 'w1:sales:group:variables').querySelector('.chev')!);
      expect(labels(list)).toContain('country');

      const opened = rowFor(list, 'w1:sales:group:variables');
      vi.advanceTimersByTime(600);
      // Same node: the timer found the state already correct and returned.
      expect(rowFor(list, 'w1:sales:group:variables')).toBe(opened);
    });

    it('is a no-op on an already-expanded row, so a rested pointer never repaints', () => {
      const { app, list } = dropApp();
      openAll(app, 'sales');
      renderDashboardTree(app);
      const before = rowFor(list, 'w1:sales');

      before.dispatchEvent(dragEvent('dragover'));
      vi.advanceTimersByTime(600);
      // Same node — no repaint happened.
      expect(rowFor(list, 'w1:sales')).toBe(before);
    });

    it('a workspace switch or dispose cancels a pending expand', () => {
      // `cancelDashboardTreeClicks` is the tree's existing "this deferred state
      // must not outlive what it belonged to" hook. Without the hover timer on
      // it, a timer armed before a workspace refresh fires afterwards and writes
      // expansion for a Dashboard the refresh just pruned — resurrecting exactly
      // the state `applyCommittedWorkspace` removed.
      const { app, list } = dropApp();
      renderDashboardTree(app);
      rowFor(list, 'w1:sales').dispatchEvent(dragEvent('dragover'));

      cancelDashboardTreeClicks(app);
      vi.advanceTimersByTime(600);

      expect(labels(list)).toEqual(['Sales', 'Ops']);
      expect(readTreeUi(app.state.dashboardTreeUi, 'w1').expandedDashboardIds.has('sales'))
        .toBe(false);
    });

    it('a new drag clears the previous drag\'s state, in case dragend never fired', () => {
      // A background `renderSavedHistory` can replace the source row mid-drag,
      // and a removed source does not reliably deliver `dragend`.
      const { app, list } = dropApp();
      renderDashboardTree(app);
      rowFor(list, 'w1:sales').dispatchEvent(dragEvent('dragenter'));
      expect(list.querySelector('.dash-drop-target')).not.toBeNull();

      beginLibraryDrag(app);
      expect(list.querySelector('.dash-drop-target')).toBeNull();
      vi.advanceTimersByTime(600);
      expect(labels(list)).toEqual(['Sales', 'Ops']);
    });

    it('dragend cancels a pending expand', () => {
      const { app, list } = dropApp();
      renderDashboardTree(app);

      rowFor(list, 'w1:sales').dispatchEvent(dragEvent('dragover'));
      endLibraryDrag(app);
      vi.advanceTimersByTime(600);
      expect(labels(list)).toEqual(['Sales', 'Ops']);
    });
  });

  describe('panel assignment', () => {
    it('drops onto a Dashboard row: one clone, one tile, and the new row selected', async () => {
      const { app, list, committed } = dropApp();
      renderDashboardTree(app);
      beginLibraryDrag(app);

      const event = dragEvent('drop');
      rowFor(list, 'w1:sales').dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
      await flush();

      const dashboard = committed[0].dashboards.find((d) => d.id === 'sales')!;
      expect(dashboard.tiles).toHaveLength(3);
      const added = dashboard.tiles[2];
      expect(committed[0].queries.some((q) => q.id === added.queryId)).toBe(true);
      // The tree revealed and selected it, without opening the Dashboard.
      expect(labels(list)).toContain('Countries');
      expect(readTreeUi(app.state.dashboardTreeUi, 'w1').keyboardRowKey)
        .toBe('w1:sales:tile:' + added.id);
      expect(app.openDashboard).not.toHaveBeenCalled();
      expect(list.classList.contains('dash-dragging')).toBe(false);
    });

    it('moves the roving keyboard row to the new panel but does NOT steal focus', async () => {
      // A mouse drop leaves focus on the drag source. The tree makes the new row
      // the arrow-key/Tab origin without yanking focus out of the gesture.
      const { app, list, committed } = dropApp();
      renderDashboardTree(app);
      const elsewhere = document.createElement('button');
      document.body.appendChild(elsewhere);
      elsewhere.focus();

      rowFor(list, 'w1:sales').dispatchEvent(dragEvent('drop'));
      await flush();

      const added = committed[0].dashboards.find((d) => d.id === 'sales').tiles[2];
      const newRow = rowFor(list, 'w1:sales:tile:' + added.id);
      expect(newRow.getAttribute('tabindex')).toBe('0');
      expect(document.activeElement).toBe(elsewhere);
    });

    it('drops onto the Panels group with the same result', async () => {
      const { app, list, committed } = dropApp();
      openAll(app, 'ops');
      renderDashboardTree(app);

      rowFor(list, 'w1:ops:group:panels').dispatchEvent(dragEvent('drop'));
      await flush();

      expect(committed[0].dashboards.find((d) => d.id === 'ops')!.tiles).toHaveLength(1);
    });

    it('repeated drops create independent copies', async () => {
      const { app, list, committed } = dropApp();
      renderDashboardTree(app);

      rowFor(list, 'w1:sales').dispatchEvent(dragEvent('drop'));
      await flush();
      rowFor(list, 'w1:sales').dispatchEvent(dragEvent('drop'));
      await flush();

      const tiles = committed[1].dashboards.find((d) => d.id === 'sales')!.tiles;
      expect(tiles).toHaveLength(4);
      expect(tiles[2].queryId).not.toBe(tiles[3].queryId);
      expect(tiles[2].id).not.toBe(tiles[3].id);
    });

    it('cancels a pending row click so the drop does not also navigate', async () => {
      const { app, list } = dropApp();
      renderDashboardTree(app);
      const row = rowFor(list, 'w1:sales');
      // A deferred single-click waiting out the double-click window.
      click(row);

      row.dispatchEvent(dragEvent('drop'));
      await flush();
      await new Promise((resolve) => setTimeout(resolve, 350));
      expect(app.openDashboard).not.toHaveBeenCalled();
    });

    it('reports a declined assignment and commits nothing', async () => {
      const { app, list, committed } = dropApp();
      renderDashboardTree(app);

      // A payload naming a query this workspace does not have.
      rowFor(list, 'w1:sales').dispatchEvent(dragEvent('drop', {
        data: {
          [LIBRARY_QUERY_MIME]: JSON.stringify({
            kind: 'library-query', workspaceId: 'w1', queryId: 'nope',
          }),
        },
      }));
      await flush();

      expect(committed).toHaveLength(0);
      expect(document.querySelector('.share-toast')!.textContent).toContain('deleted');
    });
  });

  describe('variable assignment', () => {
    const dropOnCountry = async (app: DashboardTreeApp, list: HTMLElement) => {
      openAll(app, 'sales');
      renderDashboardTree(app);
      rowFor(list, 'w1:sales:variable:country').dispatchEvent(dragEvent('drop'));
      await flush();
    };

    it('copies the SQL into the exact variable and selects its row', async () => {
      const { app, list, committed } = dropApp();
      await dropOnCountry(app, list);

      const dashboard = committed[0].dashboards.find((d) => d.id === 'sales')!;
      expect(dashboard.variableConfigs!.country)
        .toEqual({ sql: 'SELECT c, c FROM countries', lastKnownType: 'String' });
      // No query, no tile.
      expect(dashboard.tiles).toHaveLength(2);
      expect(committed[0].queries).toHaveLength(2);
      expect(readTreeUi(app.state.dashboardTreeUi, 'w1').keyboardRowKey)
        .toBe('w1:sales:variable:country');
    });

    it('adopts the SQL into a CLEAN open variable tab without leaving the surface', async () => {
      const { app, list } = dropApp();
      const tab = {
        id: 'vt', doc: { kind: 'dashboard-variable', dashboardId: 'sales', variableName: 'country' },
        dirtySql: false, sqlDraft: 'SELECT stale',
      };
      app.state.tabs.value = [...app.state.tabs.value, tab as never];
      const activeBefore = app.state.activeTabId.value;

      await dropOnCountry(app, list);

      expect(tab.sqlDraft).toBe('SELECT c, c FROM countries');
      expect(app.state.activeTabId.value).toBe(activeBefore);
      expect(app.openVariableTab).not.toHaveBeenCalled();
    });

    it('refuses to overwrite a DIRTY variable tab, and focuses it instead', async () => {
      const { app, list, committed } = dropApp();
      const tab = {
        id: 'vt', doc: { kind: 'dashboard-variable', dashboardId: 'sales', variableName: 'country' },
        dirtySql: true, sqlDraft: 'SELECT mine',
      };
      app.state.tabs.value = [...app.state.tabs.value, tab as never];

      await dropOnCountry(app, list);

      expect(committed).toHaveLength(0);
      expect(tab.sqlDraft).toBe('SELECT mine');
      expect(app.openVariableTab).toHaveBeenCalledWith('sales', 'country');
      expect(document.querySelector('.share-toast')!.textContent).toContain('unsaved changes');
    });

    it('refuses a blank source rather than deleting the configuration', async () => {
      const { app, list, committed } = dropApp();
      const ws = app.currentWorkspace as unknown as StoredWorkspaceV5;
      ws.queries = ws.queries.map((q) => (q.id === 'q-lib' ? { ...q, sql: '   ' } : q));

      await dropOnCountry(app, list);

      expect(committed).toHaveLength(0);
      expect(document.querySelector('.share-toast')!.textContent).toContain('clear it in the variable tab');
    });
  });

  describe('payload handling', () => {
    it('ignores a drop carrying no library payload', async () => {
      const { app, list, committed } = dropApp();
      renderDashboardTree(app);

      const event = dragEvent('drop', { types: ['text/plain'] });
      rowFor(list, 'w1:sales').dispatchEvent(event);
      await flush();

      expect(event.defaultPrevented).toBe(false);
      expect(committed).toHaveLength(0);
    });

    it('ignores an unparseable payload without committing or throwing', async () => {
      const { app, list, committed } = dropApp();
      renderDashboardTree(app);

      rowFor(list, 'w1:sales').dispatchEvent(dragEvent('drop', {
        data: { [LIBRARY_QUERY_MIME]: 'not json' },
      }));
      await flush();
      expect(committed).toHaveLength(0);
    });

    it('an ineligible row does not handle a drop at all', async () => {
      const { app, list, committed } = dropApp();
      openAll(app, 'sales');
      renderDashboardTree(app);

      const event = dragEvent('drop');
      rowFor(list, 'w1:sales:tile:t1').dispatchEvent(event);
      await flush();
      expect(event.defaultPrevented).toBe(false);
      expect(committed).toHaveLength(0);
    });
  });
});
