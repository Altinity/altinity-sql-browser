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
import type { App } from '../../src/ui/app.types.js';
import { closeVariableEditor } from '../../src/ui/variable-editor.js';
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
  // A variable editor a test opened is registered per document, so close it before
  // the DOM is cleared or it leaks into the next case.
  closeVariableEditor({
    document, currentWorkspace: null,
    mutateWorkspace: (async () => ({ ok: false, aborted: true })) as App['mutateWorkspace'],
  });
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

  // #447: a variable row opens its own editor, IMMEDIATELY — it has no double or
  // Shift gesture to arbitrate against, so waiting out the double-click window
  // would only make the tree feel slow.
  it('a variable row click opens its option-SQL editor with no delay, and opens no query', () => {
    const { app, list } = treeApp();
    openAll(app, 'sales');
    renderDashboardTree(app);
    click(rowFor(list, 'w1:sales:variable:country'));
    expect(document.querySelector('.varedit-panel')).not.toBeNull();
    expect(document.querySelector('.varedit-title-name')!.textContent).toBe('country');
    // The stored option SQL is what opens, not the declaring panel's query.
    expect(document.querySelector<HTMLTextAreaElement>('.varedit-input')!.value)
      .toBe('SELECT c, c FROM countries');
    settle();
    expect(app.openSavedQuery).not.toHaveBeenCalled();
    expect(app.openDashboard).not.toHaveBeenCalled();
  });

  it('an ORPHANED variable row still opens its editor', () => {
    const { app, list } = treeApp();
    openAll(app, 'sales');
    renderDashboardTree(app);
    click(rowFor(list, 'w1:sales:variable:region'));
    expect(document.querySelector('.varedit-title-name')!.textContent).toBe('region');
    expect(document.querySelector<HTMLTextAreaElement>('.varedit-input')!.value).toBe('SELECT r, r FROM regions');
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
    expect(disabled.disabled).toBe(true);
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

  it('does NOT also open the variable editor', () => {
    vi.useFakeTimers();
    const { list } = open();
    click(trash(list, 'w1:sales:variable:region')!);
    vi.advanceTimersByTime(400);
    // The trash button bypasses row activation entirely (like the action menu).
    expect(document.querySelector('.varedit-panel')).toBeNull();
    click(confirmItems()[0]);
    vi.advanceTimersByTime(400);
    expect(document.querySelector('.varedit-panel')).toBeNull();
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

  // #447: a variable row's primary action is its own editor, and Enter is the
  // keyboard equivalent — the row has no `…` menu to reach it through.
  it('Enter on a variable row opens its option-SQL editor', () => {
    const { app, list } = treeApp();
    openAll(app, 'sales');
    renderDashboardTree(app);
    key(list, 'ArrowDown'); // Variables group
    key(list, 'ArrowDown'); // country
    expect(readTreeUi(app.state.dashboardTreeUi, 'w1').keyboardRowKey).toBe('w1:sales:variable:country');
    key(list, 'Enter');
    expect(document.querySelector('.varedit-title-name')!.textContent).toBe('country');
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
