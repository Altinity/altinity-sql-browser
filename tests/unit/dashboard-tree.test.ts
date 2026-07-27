import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  renderDashboardTree, cancelDashboardTreeClicks, beginLibraryDrag, endLibraryDrag,
} from '../../src/ui/dashboard-tree.js';
import { LIBRARY_QUERY_MIME } from '../../src/ui/dnd-mime.js';
import type { DashboardTreeApp } from '../../src/ui/dashboard-tree.js';
import { buildSidebarUpper } from '../../src/ui/sidebar-upper.js';
import { Icon } from '../../src/ui/icons.js';
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
      // `data` rides through BOTH outcomes, exactly as the real primitive
      // threads it: #494's panel-metadata write reads back the entry it
      // committed, and a delete reads back the refusal reason.
      if (candidate === null) return { ok: false, aborted: true, data: input?.data };
      // A real commit PROJECTS what it wrote before it resolves — which is how
      // a deleted row actually leaves the tree. Without this the fixture's
      // projection never changes, and every post-delete assertion would be
      // made against rows the write was supposed to have removed.
      app.currentWorkspace = candidate as never;
      // …and REPAINTS from it (production: `applyCommittedWorkspace` →
      // `invalidateDashboardTree` → the app-shell effect), so anything reading
      // the painted rows after a commit sees what the write actually left.
      renderDashboardTree(app);
      return { ok: true, workspace: candidate, dashboardRevision: null, data: input!.data };
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
/** #429/#472: the row's disclosure BUTTON — one of its three independent targets. */
const chevron = (list: HTMLElement, rowKey: string): HTMLButtonElement =>
  rowFor(list, rowKey).querySelector<HTMLButtonElement>('.dash-tree-chev')!;
/** #494: one of the row's trailing DIRECT controls, addressed the way a user
 *  finds it — by its accessible name, not by a per-operation class. */
const actionBtn = (list: HTMLElement, rowKey: string, label: string): HTMLButtonElement | null =>
  rowFor(list, rowKey).querySelector<HTMLButtonElement>('.dash-tree-act[aria-label="' + label + '"]');
/** Every trailing control on a row, in paint order, by accessible name. */
const actionNames = (list: HTMLElement, rowKey: string): string[] =>
  [...rowFor(list, rowKey).querySelectorAll<HTMLButtonElement>('.dash-tree-act')]
    .map((button) => button.getAttribute('aria-label')!);
const click = (el: Element, over: MouseEventInit = {}): void => {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, ...over }));
};
const key = (list: HTMLElement, k: string, over: KeyboardEventInit = {}): void => {
  list.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...over }));
};

// Fake timers never outlive the test that installed them. `main` fixed one
// leak of this kind in passing (#501): a single `vi.useFakeTimers()` with no
// restore left every LATER test on fake timers, and a real `setTimeout`-based
// await then hung to the 5s timeout. A blanket restore closes the class rather
// than the one instance — it is a no-op when timers are already real.
afterEach(() => { vi.useRealTimers(); });

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
    // #429/#472: the disclosure BUTTON roves with its row, so the tree stays one
    // composite tab stop — Tab walks the focused row's targets and then leaves,
    // instead of offering a stop per chevron for the whole collection.
    const tabbableChevrons = [...list.querySelectorAll<HTMLElement>('.dash-tree-chev')]
      .filter((chev) => chev.getAttribute('tabindex') === '0');
    expect(tabbableChevrons).toHaveLength(1);
    expect(tabbableChevrons[0].closest('.dash-tree-row')!.getAttribute('data-key')).toBe('w1:sales');
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
    // #447 forbade the `…` overflow menu on a variable row; #494 removed it
    // from every other row too, so no production row renders one at all.
    expect(list.querySelectorAll('.dash-tree-menu-btn')).toHaveLength(0);
    // An ACTIVE variable has nothing of its own to delete — only an orphaned
    // configuration does.
    expect(actionNames(list, 'w1:sales:variable:country')).toEqual([]);
    // A panel row exposes its two direct operations instead of a menu.
    expect(actionNames(list, 'w1:sales:tile:t1'))
      .toEqual(['Edit Revenue', 'Remove Revenue from dashboard']);
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

  // #429/#472 — the row's primary target NAVIGATES now. It used to expand, deferred
  // behind the double-click window; expansion belongs to the chevron alone.
  it('a Dashboard row click opens View by stable id, with NO delay', () => {
    const { app, list } = treeApp();
    renderDashboardTree(app);
    click(rowFor(list, 'w1:sales'));
    // Before `settle()`: there is no double-click action left to wait out.
    expect(app.openDashboard).toHaveBeenCalledExactlyOnceWith({ dashboardId: 'sales', mode: 'view' });
    settle();
    expect(app.openDashboard).toHaveBeenCalledTimes(1);
  });

  it('a Dashboard row click leaves expansion EXACTLY as it was, open or closed', () => {
    const { app, list } = treeApp();
    renderDashboardTree(app);
    click(rowFor(list, 'w1:sales'));
    settle();
    expect(readTreeUi(app.state.dashboardTreeUi, 'w1').expandedDashboardIds.has('sales')).toBe(false);

    // And the same on an EXPANDED row — opening must not collapse it either.
    setUi(app, (ui) => toggleDashboardExpanded(ui, 'sales'));
    renderDashboardTree(app);
    click(rowFor(list, 'w1:sales'));
    settle();
    expect(readTreeUi(app.state.dashboardTreeUi, 'w1').expandedDashboardIds.has('sales')).toBe(true);
  });

  // The row dispatches the SAME idempotent command twice rather than a second,
  // different action; `app.openDashboard` is what collapses a repeat into a no-op
  // (proved against the real controller in `app.test.ts` — a repeated open pushes no
  // second history entry). Suppressing it here as well would duplicate that guard in
  // a layer that cannot see the route.
  it('a Dashboard double-click repeats one command and never a second action', () => {
    const { app, list } = treeApp();
    renderDashboardTree(app);
    click(rowFor(list, 'w1:sales'));
    click(rowFor(list, 'w1:sales'));
    settle();
    const calls = (app.openDashboard as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toEqual([
      [{ dashboardId: 'sales', mode: 'view' }],
      [{ dashboardId: 'sales', mode: 'view' }],
    ]);
    // No focus navigation, no mode change, and still no expansion write.
    expect(readTreeUi(app.state.dashboardTreeUi, 'w1').expandedDashboardIds.has('sales')).toBe(false);
    expect(app.openSavedQuery).not.toHaveBeenCalled();
  });

  it('a Dashboard Shift-click opens Edit, and only Edit', () => {
    const { app, list } = treeApp();
    renderDashboardTree(app);
    click(rowFor(list, 'w1:sales'), { shiftKey: true });
    expect(app.openDashboard).toHaveBeenCalledExactlyOnceWith({ dashboardId: 'sales', mode: 'edit' });
    settle();
    expect(app.openDashboard).toHaveBeenCalledTimes(1);
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

  it('a chevron click expands, then collapses, and NEVER navigates', () => {
    const { app, list } = treeApp();
    renderDashboardTree(app);
    click(chevron(list, 'w1:sales'));
    expect(readTreeUi(app.state.dashboardTreeUi, 'w1').expandedDashboardIds.has('sales')).toBe(true);
    click(chevron(list, 'w1:sales'));
    expect(readTreeUi(app.state.dashboardTreeUi, 'w1').expandedDashboardIds.has('sales')).toBe(false);
    settle();
    // The one thing the chevron must never do, now that the row itself opens.
    expect(app.openDashboard).not.toHaveBeenCalled();
    expect(app.openSavedQuery).not.toHaveBeenCalled();
  });

  // #426's rule, retained through the split: a control on one row cancels no OTHER
  // row's pending operation. (Its own row has none to cancel any more — only a panel
  // row is arbitrated, and a panel row has no chevron.)
  it('a chevron click leaves another row\'s pending action alone', () => {
    const { app, list } = treeApp();
    openAll(app, 'sales');
    renderDashboardTree(app);
    click(rowFor(list, 'w1:sales:tile:t1'));
    click(chevron(list, 'w1:sales:group:panels'));
    settle();
    expect(readTreeUi(app.state.dashboardTreeUi, 'w1').expandedGroups.has(groupStateKey('sales', 'panels')))
      .toBe(false); // toggled CLOSED, since `openAll` had opened it
    expect(app.openSavedQuery).toHaveBeenCalledExactlyOnceWith('q1');
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

  it('an action click cancels its OWN row\'s pending single but no other row\'s', () => {
    const { app, list } = treeApp();
    openAll(app, 'sales');
    renderDashboardTree(app);
    // Pending single belongs to the PANEL row...
    click(rowFor(list, 'w1:sales:tile:t1'));
    // ...and the control clicked here belongs to a DIFFERENT row.
    click(actionBtn(list, 'w1:sales:tile:t-broken', 'Edit Untitled panel')!);
    settle();
    // #426: "action-menu/button clicks … cancel no unrelated row operation".
    expect(app.openSavedQuery).toHaveBeenCalledExactlyOnceWith('q1');
  });

  it('uses action glyphs distinct from the row\'s disclosure chevron', () => {
    const { app, list } = treeApp();
    renderDashboardTree(app);
    const row = rowFor(list, 'w1:sales');
    // #426 requires the two not be confusable; an expanded row would otherwise
    // carry two identical chevrons at opposite ends.
    const chevronPaths = row.querySelector('.chev')!.innerHTML;
    for (const act of row.querySelectorAll('.dash-tree-act')) {
      expect(act.innerHTML).not.toBe(chevronPaths);
    }
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

// #429/#472 — the Dashboard row is THREE independent targets. The chevron half of
// that contract: it is a real control with its own name, state and keyboard, and it
// does nothing but expand.
describe('renderDashboardTree — the disclosure control (#472)', () => {
  const pressKey = (el: Element, k: string): boolean =>
    !el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));

  it('is a button that announces its state and what it will do, collapsed and expanded', () => {
    const { app, list } = treeApp();
    renderDashboardTree(app);
    const collapsed = chevron(list, 'w1:sales');
    expect(collapsed.tagName).toBe('BUTTON');
    expect(collapsed.type).toBe('button');
    expect(collapsed.getAttribute('aria-expanded')).toBe('false');
    expect(collapsed.getAttribute('aria-label')).toBe('Expand Sales');

    setUi(app, (ui) => toggleDashboardExpanded(ui, 'sales'));
    renderDashboardTree(app);
    const expanded = chevron(list, 'w1:sales');
    expect(expanded.getAttribute('aria-expanded')).toBe('true');
    // The verb flips: a screen-reader user must hear what activating it DOES, not
    // merely that the row is open.
    expect(expanded.getAttribute('aria-label')).toBe('Collapse Sales');
    // The treeitem keeps its own `aria-expanded`, and the two agree by construction.
    expect(rowFor(list, 'w1:sales').getAttribute('aria-expanded')).toBe('true');
    // Group rows are disclosure controls on the same footing.
    expect(chevron(list, 'w1:sales:group:panels').getAttribute('aria-label')).toBe('Expand Panels');
  });

  it('names the CURRENT Dashboard\'s control the same way — the row being open changes nothing', () => {
    const surface: MainSurfaceState = {
      kind: 'dashboard', dashboardId: 'sales', mode: 'view',
      currentMember: null, pendingFocus: null, pendingScrollTop: null,
    };
    const { app, list } = treeApp({ mainSurface: surface });
    renderDashboardTree(app);
    expect(rowFor(list, 'w1:sales').classList.contains('is-current')).toBe(true);
    expect(chevron(list, 'w1:sales').getAttribute('aria-label')).toBe('Expand Sales');
    click(chevron(list, 'w1:sales'));
    expect(readTreeUi(app.state.dashboardTreeUi, 'w1').expandedDashboardIds.has('sales')).toBe(true);
    expect(app.openDashboard).not.toHaveBeenCalled();
    // The fourth corner of the matrix the issue asks for — EXPANDED and CURRENT — so
    // neither state can quietly break the other's announcement.
    expect(chevron(list, 'w1:sales').getAttribute('aria-expanded')).toBe('true');
    expect(chevron(list, 'w1:sales').getAttribute('aria-label')).toBe('Collapse Sales');
    expect(rowFor(list, 'w1:sales').classList.contains('is-current')).toBe(true);
    click(chevron(list, 'w1:sales'));
    expect(readTreeUi(app.state.dashboardTreeUi, 'w1').expandedDashboardIds.has('sales')).toBe(false);
    expect(app.openDashboard).not.toHaveBeenCalled();
  });

  it('Enter and Space toggle expansion and open NOTHING', () => {
    const { app, list } = treeApp();
    renderDashboardTree(app);
    // The trap this guards: the tree's key handler lives on the LIST, and its Enter
    // runs the row's primary action — which is now "open this Dashboard". A chevron
    // that let the key bubble would navigate instead of expanding.
    expect(pressKey(chevron(list, 'w1:sales'), 'Enter')).toBe(true);
    expect(readTreeUi(app.state.dashboardTreeUi, 'w1').expandedDashboardIds.has('sales')).toBe(true);
    expect(app.openDashboard).not.toHaveBeenCalled();

    expect(pressKey(chevron(list, 'w1:sales'), ' ')).toBe(true);
    expect(readTreeUi(app.state.dashboardTreeUi, 'w1').expandedDashboardIds.has('sales')).toBe(false);
    expect(app.openDashboard).not.toHaveBeenCalled();
  });

  it('ignores every other key, leaving them to the tree', () => {
    const { app, list } = treeApp();
    renderDashboardTree(app);
    // ArrowDown must still reach the list handler and move the keyboard row.
    chevron(list, 'w1:sales').dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }),
    );
    expect(readTreeUi(app.state.dashboardTreeUi, 'w1').keyboardRowKey).toBe('w1:ops');
    expect(readTreeUi(app.state.dashboardTreeUi, 'w1').expandedDashboardIds.size).toBe(0);
  });

  it('keeps focus on itself across the repaint its own toggle causes', () => {
    const { app, list } = treeApp();
    renderDashboardTree(app);
    chevron(list, 'w1:sales').focus();
    pressKey(chevron(list, 'w1:sales'), 'Enter');
    // `commitUi` rebuilt every row, so this is the NEW button. Landing on the row
    // instead would mean the next Enter navigates rather than collapsing.
    expect(document.activeElement).toBe(chevron(list, 'w1:sales'));
    expect(chevron(list, 'w1:sales').getAttribute('aria-label')).toBe('Collapse Sales');
    // ...and pressing again really does collapse, which is the point of staying put.
    pressKey(document.activeElement!, 'Enter');
    expect(readTreeUi(app.state.dashboardTreeUi, 'w1').expandedDashboardIds.has('sales')).toBe(false);
    expect(app.openDashboard).not.toHaveBeenCalled();
  });

  it('moves the keyboard owner to its own row, so Tab and the arrow keys continue there', () => {
    const { app, list } = treeApp();
    renderDashboardTree(app);
    click(chevron(list, 'w1:ops'));
    expect(readTreeUi(app.state.dashboardTreeUi, 'w1').keyboardRowKey).toBe('w1:ops');
    expect(rowFor(list, 'w1:ops').getAttribute('tabindex')).toBe('0');
    expect(chevron(list, 'w1:ops').getAttribute('tabindex')).toBe('0');
    expect(chevron(list, 'w1:sales').getAttribute('tabindex')).toBe('-1');
  });

  it('rows that cannot expand keep the plain spacer span, with no name and no state', () => {
    const { app, list } = treeApp();
    openAll(app, 'sales');
    renderDashboardTree(app);
    const leaf = rowFor(list, 'w1:sales:tile:t1').querySelector('.chev')!;
    expect(leaf.tagName).toBe('SPAN');
    expect(leaf.hasAttribute('aria-label')).toBe(false);
    expect(leaf.hasAttribute('aria-expanded')).toBe(false);
    expect(leaf.innerHTML).toBe('');
  });

  // Measured in real Chromium before this was added: a `treeitem` names itself from
  // its CONTENTS, so the chevron's own label was folded into the row's — the row
  // announced "Expand Sales revenue Sales revenue 2", and "Collapse … Actions for
  // Sales revenue" once focus revealed the `⋯`. #472 wants the three targets
  // announced SEPARATELY, so the row states its own name.
  it('names itself without swallowing its buttons\' labels', () => {
    const { app, list } = treeApp();
    openAll(app, 'sales');
    renderDashboardTree(app);
    const name = (rowKey: string): string => rowFor(list, rowKey).getAttribute('aria-label')!;
    // Dashboard row: its name plus the panel count it shows, and nothing else.
    expect(name('w1:sales')).toBe('Sales 2');
    expect(name('w1:sales')).not.toContain('Expand');
    expect(name('w1:sales')).not.toContain('Actions for');
    // Group row: the count is announced, the disclosure verb is not.
    expect(name('w1:sales:group:variables')).toBe('Variables 2');
    // Everything that was announced before still is: the status WORD, the type meta
    // and the marker's severity label.
    expect(name('w1:sales:variable:region')).toBe('region unused String Unused');
    expect(name('w1:sales:variable:country')).toBe('country String');
    expect(name('w1:sales:tile:t-broken')).toBe('Untitled panel Broken reference');
    // The chevron and every trailing control keep their own, distinct names
    // (`openAll` expanded this row, so its verb is Collapse).
    expect(chevron(list, 'w1:sales').getAttribute('aria-label')).toBe('Collapse Sales');
    expect(actionNames(list, 'w1:sales')).toEqual(['Edit dashboard Sales', 'Delete dashboard Sales']);
    // …and none of those four names leaks into the row's own (#494 adds three
    // more labelled buttons per row than #472 measured this against).
    for (const label of ['Edit dashboard', 'Delete dashboard', 'Collapse']) {
      expect(name('w1:sales')).not.toContain(label);
    }
    expect(name('w1:sales:tile:t1')).toBe('Revenue');
    expect(name('w1:sales:variable:region')).not.toContain('Delete the stored option SQL');
  });

  it('is isolated from the trailing actions, which expand and navigate neither', () => {
    vi.useFakeTimers();
    const { app, list } = treeApp();
    renderDashboardTree(app);
    const row = rowFor(list, 'w1:sales');
    click(actionBtn(list, 'w1:sales', 'Delete dashboard Sales')!);
    vi.advanceTimersByTime(400);
    expect(readTreeUi(app.state.dashboardTreeUi, 'w1').expandedDashboardIds.size).toBe(0);
    expect(app.openDashboard).not.toHaveBeenCalled();
    // #472's three targets became four (#494): chevron, row, pencil, trash.
    expect(row.querySelectorAll('.dash-tree-chev')).toHaveLength(1);
    expect(row.querySelectorAll('.dash-tree-act')).toHaveLength(2);
    vi.useRealTimers();
  });
});

/**
 * #494 — the trailing DIRECT controls that replaced the `⋯` overflow menu on
 * Dashboard and Panel rows.
 *
 * The menu's own coverage moved here rather than being deleted: what it used to
 * prove (a row's whole vocabulary is reachable, an unavailable operation is
 * rendered-but-inert, activating one never runs the row's gesture) is exactly
 * what the buttons must prove now. What is GONE is the indirection — no row
 * renders a menu button at all any more, and the commands the menu mirrored
 * (`single`/`double`/`shift`) are untouched.
 */
describe('renderDashboardTree — direct row actions (#494)', () => {
  const open = () => {
    const fixture = treeApp();
    openAll(fixture.app, 'sales');
    renderDashboardTree(fixture.app);
    return fixture;
  };
  it('renders no overflow menu on ANY row, and no menu markup at all', () => {
    const { list } = open();
    expect(list.querySelectorAll('.dash-tree-menu-btn')).toHaveLength(0);
    expect(document.querySelectorAll('.dash-tree-menu')).toHaveLength(0);
    expect(list.querySelectorAll('[aria-label^="Actions for"]')).toHaveLength(0);
  });

  it('gives the Dashboard row a pencil and a trash, in that order', () => {
    const { list } = open();
    // Destructive rightmost — never where the pointer lands by habit.
    expect(actionNames(list, 'w1:sales')).toEqual(['Edit dashboard Sales', 'Delete dashboard Sales']);
  });

  it('gives a Panel row a pencil and a trash that name the panel', () => {
    const { list } = open();
    expect(actionNames(list, 'w1:sales:tile:t1'))
      .toEqual(['Edit Revenue', 'Remove Revenue from dashboard']);
  });

  it('gives group rows none', () => {
    const { list } = open();
    expect(actionNames(list, 'w1:sales:group:panels')).toEqual([]);
    expect(actionNames(list, 'w1:sales:group:variables')).toEqual([]);
  });

  it('makes every control a real, individually named button with a tooltip', () => {
    const { list } = open();
    for (const button of rowFor(list, 'w1:sales:tile:t1').querySelectorAll<HTMLButtonElement>('.dash-tree-act')) {
      expect(button.tagName).toBe('BUTTON');
      expect(button.type).toBe('button');
      // `not.toBe('')` would also pass on a MISSING attribute; these are the
      // exact strings the model composed.
      expect(button.getAttribute('aria-label')).toMatch(/^(Edit|Remove) Revenue/);
      expect(button.getAttribute('title')).toBe(
        button.dataset.act === 'edit-panel' ? 'Edit name & description' : 'Remove panel',
      );
      expect(button.getAttribute('aria-expanded')).toBe('false');
    }
    expect(actionBtn(list, 'w1:sales:tile:t1', 'Edit Revenue')!.getAttribute('aria-haspopup'))
      .toBe('dialog');
    expect(actionBtn(list, 'w1:sales:tile:t1', 'Remove Revenue from dashboard')!
      .getAttribute('aria-haspopup')).toBe('menu');
  });

  it('marks the destructive one so it can be styled apart from the pencil', () => {
    const { list } = open();
    expect(actionBtn(list, 'w1:sales', 'Edit dashboard Sales')!.classList.contains('dash-tree-act-danger'))
      .toBe(false);
    expect(actionBtn(list, 'w1:sales', 'Delete dashboard Sales')!.classList.contains('dash-tree-act-danger'))
      .toBe(true);
  });

  it('keeps a delete looking and announcing like a delete even when it is unavailable', () => {
    // #494: a row's vocabulary must not change with availability. The
    // confirmation is what an unavailable action loses, not its identity.
    const { list } = open();
    const trash = actionBtn(list, 'w1:sales:tile:t-broken', 'Remove Untitled panel from dashboard')!;
    expect(trash.classList.contains('dash-tree-act-danger')).toBe(true);
    expect(trash.getAttribute('aria-haspopup')).toBe('menu');
  });

  it('paints the pencil glyph on edit and the trash glyph on delete', () => {
    const { list } = open();
    // Swapping the two icons would otherwise pass every other assertion here.
    expect(actionBtn(list, 'w1:sales', 'Edit dashboard Sales')!.innerHTML)
      .toBe(Icon.pencil().outerHTML);
    expect(actionBtn(list, 'w1:sales', 'Delete dashboard Sales')!.innerHTML)
      .toBe(Icon.trash().outerHTML);
  });

  // A panel whose query cannot be proven to be its own: the controls stay, so
  // the row's vocabulary does not silently shrink, but they are inert and say
  // why. `t-broken` references a query this workspace does not carry.
  it('renders an unprovable panel\'s controls disabled rather than hiding them', () => {
    const { app, list } = open();
    const names = actionNames(list, 'w1:sales:tile:t-broken');
    expect(names).toEqual(['Edit Untitled panel', 'Remove Untitled panel from dashboard']);
    const pencil = actionBtn(list, 'w1:sales:tile:t-broken', 'Edit Untitled panel')!;
    // `aria-disabled`, not the native attribute — a natively disabled button is
    // dropped from the accessibility tree, so the reason would never be heard.
    expect(pencil.disabled).toBe(false);
    expect(pencil.getAttribute('aria-disabled')).toBe('true');
    expect(pencil.getAttribute('title')).toContain('not in this workspace');
    click(pencil);
    expect(document.querySelector('.fm-dialog-card')).toBeNull();
    expect(app.openSavedQuery).not.toHaveBeenCalled();
  });

  it('does nothing at all when an unavailable trash is activated', async () => {
    const { list, committed } = open();
    click(actionBtn(list, 'w1:sales:tile:t-broken', 'Remove Untitled panel from dashboard')!);
    await Promise.resolve();
    expect(document.querySelector('.dash-tree-confirm')).toBeNull();
    expect(committed).toEqual([]);
  });

  it('cancels its OWN row\'s pending single — the click that armed it must not fire behind the dialog', () => {
    vi.useFakeTimers();
    const { app, list } = open();
    // Arm a pending `open-query` on the panel row (a panel row arbitrates,
    // because it has a double-click action)…
    click(rowFor(list, 'w1:sales:tile:t1'));
    // …then press THAT SAME row's own control inside the ~300ms window.
    click(actionBtn(list, 'w1:sales:tile:t1', 'Edit Revenue')!);
    vi.advanceTimersByTime(400);
    // Without the `cancelFor`, the deferred single fires a third of a second
    // later and navigates the surface out from under the dialog just opened.
    expect(app.openSavedQuery).not.toHaveBeenCalled();
    expect(document.querySelectorAll('.fm-dialog-card')).toHaveLength(1);
    vi.useRealTimers();
  });

  it('an action never expands, never navigates, and cancels no other row\'s pending click', () => {
    vi.useFakeTimers();
    const { app, list } = open();
    click(rowFor(list, 'w1:sales:tile:t1'));            // a pending single on ANOTHER row
    click(actionBtn(list, 'w1:sales', 'Edit dashboard Sales')!);
    vi.advanceTimersByTime(400);
    expect(app.openDashboard).not.toHaveBeenCalled();
    expect(app.openSavedQuery).toHaveBeenCalledExactlyOnceWith('q1');
    vi.useRealTimers();
  });
});

/** #494 — removing one panel: the tile AND its dedicated owned query, once. */
describe('renderDashboardTree — panel trash (#494)', () => {
  const open = () => {
    const fixture = treeApp();
    openAll(fixture.app, 'sales');
    renderDashboardTree(fixture.app);
    return fixture;
  };
  const trash = (list: HTMLElement): HTMLButtonElement =>
    actionBtn(list, 'w1:sales:tile:t1', 'Remove Revenue from dashboard')!;
  const list0 = (app: DashboardTreeApp): HTMLElement => app.dom.dashboardTreeList!;
  const confirmItems = (): HTMLElement[] =>
    [...document.querySelectorAll<HTMLElement>('.dash-tree-confirm .fm-item')];
  const settle = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 0); });

  it('CONFIRMS first, naming both the panel and the Dashboard, and the query copy it takes with it', async () => {
    const { list, committed } = open();
    click(trash(list));
    expect(document.querySelector('.dash-tree-confirm .fm-section')!.textContent)
      .toBe('Remove panel “Revenue” from “Sales”? This also deletes its dedicated query copy.');
    expect(confirmItems().map((item) => item.textContent)).toEqual(['Remove panel', 'Cancel']);
    await settle();
    expect(committed).toEqual([]);
  });

  it('commits nothing when the confirmation is refused', async () => {
    const { list, committed } = open();
    click(trash(list));
    click(confirmItems()[1]);
    await settle();
    expect(committed).toEqual([]);
  });

  it('removes the tile and exactly its owned query, in one commit', async () => {
    const { list, committed } = open();
    click(trash(list));
    click(confirmItems()[0]);
    await settle();
    expect(committed).toHaveLength(1);
    const dashboard = committed[0]!.dashboards[0];
    expect(dashboard.tiles.map((tile) => tile.id)).toEqual(['t-broken']);
    expect(committed[0]!.queries).toEqual([]);
    // The other Dashboard is untouched, and the orphaned variable config
    // survives — #494's non-goals forbid deleting one as a side effect.
    expect(committed[0]!.dashboards[1]).toEqual(workspace().dashboards![1]);
    expect(dashboard.variableConfigs!.region).toBeDefined();
  });

  it('hands the command the query id the confirmation named, not just the tile', async () => {
    // The transform re-proves that the tile still points at THIS query; a
    // target without it would delete whatever the tile references by then.
    const mutateWorkspace = vi.fn(async (transform: (latest: unknown) => unknown) => {
      transform(workspace());
      return { ok: false, aborted: true, data: 'tile-missing' };
    }) as unknown as App['mutateWorkspace'];
    const { app } = treeApp({ mutateWorkspace });
    openAll(app, 'sales');
    renderDashboardTree(app);
    // A tile re-pointed at another query between paint and dequeue is refused
    // rather than silently deleting the new one.
    const retargeted = workspace();
    retargeted.dashboards![0]!.tiles = [{ id: 't1', queryId: 'q-other' }];
    (mutateWorkspace as unknown as { mockImplementation: (fn: unknown) => void })
      .mockImplementation(async (transform: (latest: unknown) => { data?: unknown }) => {
        const input = transform(retargeted);
        return { ok: false, aborted: true, data: input?.data };
      });
    click(trash(list0(app)));
    click(confirmItems()[0]);
    await settle();
    expect(document.querySelector('.share-toast')!.textContent)
      .toBe('That panel now shows a different query, so nothing was deleted.');
  });

  it('reports a refused delete and commits nothing', async () => {
    const mutateWorkspace = vi.fn(async () => (
      { ok: false, aborted: true, data: 'tile-missing' }
    )) as unknown as App['mutateWorkspace'];
    const { app } = treeApp({ mutateWorkspace });
    openAll(app, 'sales');
    renderDashboardTree(app);
    click(trash(app.dom.dashboardTreeList!));
    click(confirmItems()[0]);
    await settle();
    expect(document.querySelector('.share-toast')!.textContent)
      .toBe('That panel is no longer part of this dashboard.');
  });

  it('moves keyboard focus to the NEXT panel row when there is one', async () => {
    const { app, list } = open();
    click(trash(list));
    click(confirmItems()[0]);
    await settle();
    // `t1` is gone; the next sibling panel row takes the keyboard.
    expect(readTreeUi(app.state.dashboardTreeUi, 'w1').keyboardRowKey).toBe('w1:sales:tile:t-broken');
  });

  it('falls back to the PREVIOUS panel row when the deleted one was last', async () => {
    const fixture = treeApp();
    // Make the healthy panel the LAST row of the group, so there is no next.
    const dashboards = (fixture.app.currentWorkspace as unknown as TreeWorkspace).dashboards!;
    dashboards[0]!.tiles = [{ id: 't-broken', queryId: 'q-gone' }, { id: 't1', queryId: 'q1' }];
    openAll(fixture.app, 'sales');
    renderDashboardTree(fixture.app);
    click(actionBtn(fixture.list, 'w1:sales:tile:t1', 'Remove Revenue from dashboard')!);
    click(confirmItems()[0]);
    await settle();
    expect(readTreeUi(fixture.app.state.dashboardTreeUi, 'w1').keyboardRowKey)
      .toBe('w1:sales:tile:t-broken');
  });

  it('lands on the search box when the delete empties the FILTERED tree', async () => {
    // A search matching only this panel takes its group and its Dashboard off
    // screen with it, so the successor chosen before the write (the Panels
    // group) does not exist afterwards — and `focusRow` on a missing key is a
    // silent no-op that would strand the keyboard on `<body>`.
    const fixture = treeApp();
    const dashboards = (fixture.app.currentWorkspace as unknown as TreeWorkspace).dashboards!;
    dashboards[0]!.tiles = [{ id: 't1', queryId: 'q1' }];
    setUi(fixture.app, (ui) => setTreeSearch(ui, 'Revenue'));
    openAll(fixture.app, 'sales');
    renderDashboardTree(fixture.app);
    expect(rows(fixture.list).length).toBeGreaterThan(0);
    click(actionBtn(fixture.list, 'w1:sales:tile:t1', 'Remove Revenue from dashboard')!);
    click(confirmItems()[0]);
    await settle();
    expect(rows(fixture.list)).toHaveLength(0);
    expect(document.activeElement).toBe(fixture.app.dom.dashboardSearchInput);
  });

  it('falls back to the Panels GROUP when the deleted row was the only panel', async () => {
    const fixture = treeApp();
    const dashboards = (fixture.app.currentWorkspace as unknown as TreeWorkspace).dashboards!;
    dashboards[0]!.tiles = [{ id: 't1', queryId: 'q1' }];
    openAll(fixture.app, 'sales');
    renderDashboardTree(fixture.app);
    click(actionBtn(fixture.list, 'w1:sales:tile:t1', 'Remove Revenue from dashboard')!);
    click(confirmItems()[0]);
    await settle();
    // Never nowhere: the group that contained it keeps the keyboard, so the
    // arrow keys still have an origin and the focus ring stays visible.
    expect(readTreeUi(fixture.app.state.dashboardTreeUi, 'w1').keyboardRowKey)
      .toBe('w1:sales:group:panels');
  });
});

/**
 * #494 — the Panel row's pencil, which edits the tile's dedicated OWNED QUERY.
 *
 * The Dashboard pencil above edits a document; this one edits the query the
 * tile owns, because that is where a panel's displayed name and description
 * actually live. Everything else about the two is deliberately identical: the
 * same shell, the same awaited-outcome contract, the same hover-reveal
 * `aria-expanded` treatment.
 */
describe('renderDashboardTree — panel metadata pencil (#494)', () => {
  const open = () => {
    const fixture = treeApp();
    // `state.savedQueries` is what `renameSaved` resolves the target against
    // before it queues anything.
    fixture.app.state.savedQueries = [
      query('q1', 'Revenue', 'SELECT * FROM rev WHERE c = {country:String}'),
    ];
    openAll(fixture.app, 'sales');
    renderDashboardTree(fixture.app);
    return fixture;
  };
  const pencil = (list: HTMLElement): HTMLButtonElement =>
    actionBtn(list, 'w1:sales:tile:t1', 'Edit Revenue')!;
  const nameInput = (): HTMLInputElement =>
    document.querySelector<HTMLInputElement>('#panel-metadata-name')!;
  const descInput = (): HTMLTextAreaElement =>
    document.querySelector<HTMLTextAreaElement>('#panel-metadata-description')!;
  const save = (): HTMLButtonElement => document.querySelector<HTMLButtonElement>('.fm-dialog-confirm')!;
  const settle = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 0); });

  it('prefills from the OWNED QUERY, not from the row label', () => {
    const { list } = open();
    click(pencil(list));
    expect(document.querySelector('.fm-dialog-title')!.textContent).toBe('Edit panel');
    expect(nameInput().value).toBe('Revenue');
    expect(descInput().value).toBe('');
    // No standing caveat: this tile carries no imported title override.
    expect(document.querySelector('.fm-dialog-note')).toBeNull();
  });

  it('warns when an imported tile title outranks the query name being edited', () => {
    const { app, list } = treeApp();
    const dashboards = (app.currentWorkspace as unknown as TreeWorkspace).dashboards!;
    dashboards[0]!.tiles = [{ id: 't1', queryId: 'q1', title: 'Imported heading' }];
    app.state.savedQueries = [query('q1', 'Revenue')];
    openAll(app, 'sales');
    renderDashboardTree(app);
    // The row shows the OVERRIDE, so the pencil is named after it…
    click(actionBtn(app.dom.dashboardTreeList!, 'w1:sales:tile:t1', 'Edit Imported heading')!);
    // …while the field it edits is still the query's own name.
    expect(nameInput().value).toBe('Revenue');
    expect(document.querySelector('.fm-dialog-note')!.textContent)
      .toBe('This tile was imported with its own title, which keeps priority over the query name here.');
    expect(list).toBeDefined();
  });

  // The viewer resolves a tile's body text as `tile.description || query
  // description`, exactly as it resolves the heading — so an imported
  // DESCRIPTION masks the field being edited just as a title does, and used to
  // do it silently.
  it.each<[string, { title?: string; description?: string }, string]>([
    ['description only', { description: 'Imported blurb' },
      'This tile was imported with its own description, which keeps priority over the query description here.'],
    ['both', { title: 'Imported heading', description: 'Imported blurb' },
      'This tile was imported with its own title and description, which keeps priority over these fields here.'],
  ])('warns about an imported %s override', (_name, over, expected) => {
    const { app } = treeApp();
    const dashboards = (app.currentWorkspace as unknown as TreeWorkspace).dashboards!;
    dashboards[0]!.tiles = [{ id: 't1', queryId: 'q1', ...over }];
    app.state.savedQueries = [query('q1', 'Revenue')];
    openAll(app, 'sales');
    renderDashboardTree(app);
    const label = 'Edit ' + (over.title ?? 'Revenue');
    click(actionBtn(app.dom.dashboardTreeList!, 'w1:sales:tile:t1', label)!);
    expect(document.querySelector('.fm-dialog-note')!.textContent).toBe(expected);
  });

  it('commits name and description onto the owned query and closes', async () => {
    const { list, committed } = open();
    click(pencil(list));
    nameInput().value = 'Revenue by region';
    nameInput().dispatchEvent(new Event('input', { bubbles: true }));
    descInput().value = 'Monthly';
    save().click();
    await settle();
    expect(document.querySelector('.fm-dialog-card')).toBeNull();
    expect(committed).toHaveLength(1);
    const written = committed[0]!.queries[0];
    expect(written.spec.name).toBe('Revenue by region');
    expect(written.spec.description).toBe('Monthly');
    // The SQL, the id and the Dashboard document are untouched — a
    // metadata-only edit must not move a Dashboard revision.
    expect(written.id).toBe('q1');
    expect(written.sql).toBe('SELECT * FROM rev WHERE c = {country:String}');
    expect(committed[0]!.dashboards).toEqual(workspace().dashboards);
  });

  it('keeps the dialog open and reports when the tile no longer owns the query', async () => {
    const { app, list } = open();
    // The commit re-resolves ownership at DEQUEUE time: by then this tile is
    // gone, so nothing is written and the typed values survive.
    app.mutateWorkspace = (async (transform) => {
      const latest = workspace() as unknown as StoredWorkspaceV5;
      latest.dashboards[0].tiles = [];
      // The transform is still RUN, so its dequeue-time guard is exercised;
      // it refuses, and the outcome is the abort that refusal produces.
      await transform(latest);
      return { ok: false, aborted: true };
    }) as App['mutateWorkspace'];
    click(pencil(list));
    nameInput().value = 'Kept';
    nameInput().dispatchEvent(new Event('input', { bubbles: true }));
    save().click();
    await settle();
    expect(document.querySelector('.fm-dialog-card')).not.toBeNull();
    expect(nameInput().value).toBe('Kept');
    expect(document.querySelector('.fm-dialog-error')!.textContent)
      .toBe('That panel is no longer part of this dashboard.');
  });

  it('lands focus on the ROW when a successful commit repainted the trigger away', async () => {
    // #495 review 2 made the dialog close only after the write answers — and
    // that write repaints the tree, detaching the button the dialog captured.
    // `focus()` on a detached node is a silent no-op, which used to strand the
    // keyboard on `<body>`.
    const fixture = treeApp();
    fixture.app.state.savedQueries = [query('q1', 'Revenue')];
    // The fixture's `mutateWorkspace` projects and repaints before it
    // resolves, exactly as a real commit does — which is what detaches the
    // button this dialog captured.
    openAll(fixture.app, 'sales');
    renderDashboardTree(fixture.app);
    const trigger = actionBtn(fixture.list, 'w1:sales:tile:t1', 'Edit Revenue')!;
    click(trigger);
    nameInput().value = 'Renamed';
    nameInput().dispatchEvent(new Event('input', { bubbles: true }));
    save().click();
    await settle();
    expect(trigger.isConnected).toBe(false);
    expect(document.activeElement).toBe(rowFor(fixture.list, 'w1:sales:tile:t1'));
  });

  it('keeps the trigger revealed for the dialog\'s whole lifetime', () => {
    const { list } = open();
    const trigger = pencil(list);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    click(document.querySelector<HTMLButtonElement>('.fm-dialog-cancel')!);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(trigger);
  });

  it('stays aria-expanded "true" across repeated activation, and returns focus visibly on close', () => {
    // Same race as the Dashboard pencil: the replacement dialog's own
    // `openDialogShell` force-closes the one this same trigger already
    // opened, running that dialog's `onClose` — which resets THIS trigger's
    // `aria-expanded` to "false" — before the replacement's own "true" is set.
    const { list } = open();
    const trigger = pencil(list);
    click(trigger);
    click(trigger);
    click(trigger);
    expect(document.querySelectorAll('.fm-dialog-card')).toHaveLength(1);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    click(document.querySelector<HTMLButtonElement>('.fm-dialog-cancel')!);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(trigger);
  });

  it('Cancel commits nothing', async () => {
    const { list, committed } = open();
    click(pencil(list));
    nameInput().value = 'Not saved';
    nameInput().dispatchEvent(new Event('input', { bubbles: true }));
    click(document.querySelector<HTMLButtonElement>('.fm-dialog-cancel')!);
    await settle();
    expect(committed).toEqual([]);
  });

  it('sends the user to the tab when a linked draft\'s Spec JSON will not parse', async () => {
    const { app, list, committed } = open();
    // The same patch has to apply to the persisted entry AND to every linked
    // draft; an unparseable draft blocks both, and only the tab can fix it.
    const tab = app.state.tabs.value[0];
    tab.savedId = 'q1';
    tab.specText = '{"name":';
    tab.specParsed = null;
    tab.specDiagnostics = [{ severity: 'error', code: 'invalid-json', message: 'invalid JSON' }];
    click(pencil(list));
    nameInput().value = 'Revenue by region';
    nameInput().dispatchEvent(new Event('input', { bubbles: true }));
    save().click();
    await settle();
    expect(committed).toEqual([]);
    expect(document.querySelector('.fm-dialog-error')!.textContent)
      .toBe('This panel’s query has invalid Spec JSON in an open tab. Fix it there first.');
  });

  it('shows the aggregate\'s own diagnostic when the commit is rejected', async () => {
    const mutateWorkspace = vi.fn(async () => ({
      ok: false,
      diagnostics: [{ path: [], severity: 'error', code: 'x', message: 'Storage is full' }],
    })) as unknown as App['mutateWorkspace'];
    const { app } = treeApp({ mutateWorkspace });
    app.state.savedQueries = [query('q1', 'Revenue')];
    openAll(app, 'sales');
    renderDashboardTree(app);
    click(pencil(app.dom.dashboardTreeList!));
    nameInput().value = 'Revenue by region';
    nameInput().dispatchEvent(new Event('input', { bubbles: true }));
    save().click();
    await settle();
    expect(document.querySelector('.fm-dialog-error')!.textContent).toBe('Storage is full');
  });
});

/** #494 — removing a whole Dashboard, with the queries its panels own. */
describe('renderDashboardTree — Dashboard trash (#494)', () => {
  const confirmItems = (): HTMLElement[] =>
    [...document.querySelectorAll<HTMLElement>('.dash-tree-confirm .fm-item')];
  const settle = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 0); });
  const open = () => {
    const fixture = treeApp();
    renderDashboardTree(fixture.app);
    return fixture;
  };
  const trash = (list: HTMLElement): HTMLButtonElement =>
    actionBtn(list, 'w1:sales', 'Delete dashboard Sales')!;

  it('CONFIRMS, naming the Dashboard and the cascade', async () => {
    const { list, committed } = open();
    click(trash(list));
    expect(document.querySelector('.dash-tree-confirm .fm-section')!.textContent)
      .toBe('Delete dashboard “Sales”? This also deletes every query its panels own.');
    expect(confirmItems().map((item) => item.textContent)).toEqual(['Delete dashboard', 'Cancel']);
    await settle();
    expect(committed).toEqual([]);
  });

  it('removes the document and the queries its panels own, keeping every other Dashboard', async () => {
    const { list, committed } = open();
    click(trash(list));
    click(confirmItems()[0]);
    await settle();
    expect(committed).toHaveLength(1);
    expect(committed[0]!.dashboards.map((dashboard) => dashboard.id)).toEqual(['ops']);
    // `q1` was owned by `sales`'s panel tile, so it goes with the document.
    expect(committed[0]!.queries).toEqual([]);
  });

  it('does not navigate, expand, or delete anything when refused', async () => {
    const { app, list, committed } = open();
    click(trash(list));
    click(confirmItems()[1]);
    await settle();
    expect(committed).toEqual([]);
    expect(app.openDashboard).not.toHaveBeenCalled();
    expect(readTreeUi(app.state.dashboardTreeUi, 'w1').expandedDashboardIds.size).toBe(0);
  });

  it('moves keyboard focus to the next Dashboard row, and to the search box when none is left', async () => {
    const { app, list } = open();
    click(trash(list));
    click(confirmItems()[0]);
    await settle();
    // The confirmation's own menu closed by removing the item that was just
    // activated, and the trigger went with the row — so without an explicit
    // placement here, focus would be on `<body>`.
    expect(readTreeUi(app.state.dashboardTreeUi, 'w1').keyboardRowKey).toBe('w1:ops');

    // …and when the LAST Dashboard goes, there is no row to stand on at all.
    const only = treeApp();
    (only.app.currentWorkspace as unknown as TreeWorkspace).dashboards = [
      { id: 'sales', title: 'Sales', tiles: [] },
    ];
    renderDashboardTree(only.app);
    click(actionBtn(only.list, 'w1:sales', 'Delete dashboard Sales')!);
    click(confirmItems()[0]);
    await settle();
    expect(document.activeElement).toBe(only.app.dom.dashboardSearchInput);
  });

  it('a destructive confirmation lands on Cancel, not on the destructive item', () => {
    vi.useFakeTimers();
    const { list } = open();
    click(trash(list));
    // `openMenu` autofocuses its first focusable row by default; a
    // confirmation exists to interpose a deliberate act, so an Enter pressed
    // out of momentum must not delete a Dashboard.
    vi.advanceTimersByTime(10);
    expect(document.activeElement!.textContent).toBe('Cancel');
    vi.useRealTimers();
  });

  it('reports a rejected commit', async () => {
    const mutateWorkspace = vi.fn(async () => ({
      ok: false,
      diagnostics: [{ path: [], severity: 'error', code: 'x', message: 'Storage is full' }],
    })) as unknown as App['mutateWorkspace'];
    const { app } = treeApp({ mutateWorkspace });
    renderDashboardTree(app);
    click(trash(app.dom.dashboardTreeList!));
    click(confirmItems()[0]);
    await settle();
    expect(document.querySelector('.share-toast')!.textContent).toBe('✕ Storage is full');
  });
});

describe('renderDashboardTree — deleting an orphaned variable (#447)', () => {
  /** #494 folded this control into the shared action cluster; it is still the
   *  only one addressed by THIS name, and still the only one always visible. */
  const trash = (list: HTMLElement, rowKey: string): HTMLButtonElement | null =>
    rowFor(list, rowKey)
      .querySelector<HTMLButtonElement>('.dash-tree-act[aria-label^="Delete the stored option SQL"]');
  const confirmItems = (): HTMLElement[] =>
    [...document.querySelectorAll<HTMLElement>('.dash-tree-confirm .fm-item')];
  const open = () => {
    const fixture = treeApp();
    openAll(fixture.app, 'sales');
    renderDashboardTree(fixture.app);
    return fixture;
  };

  it('renders the stored-option-SQL trash on an ORPHAN row only', () => {
    const { list } = open();
    const button = trash(list, 'w1:sales:variable:region')!;
    expect(button).not.toBeNull();
    // #447's control stays ALWAYS visible, unlike #494's hover-revealed
    // cluster: it is the only way to remove SQL nothing references any more.
    expect(button.classList.contains('dash-tree-act-static')).toBe(true);
    // Never on an active variable or a group. Panel and Dashboard rows have a
    // trash of their OWN now (#494) — it deletes a different thing, and says so.
    expect(trash(list, 'w1:sales:variable:country')).toBeNull();
    expect(trash(list, 'w1:sales:tile:t1')).toBeNull();
    expect(trash(list, 'w1:sales:group:variables')).toBeNull();
    expect(trash(list, 'w1:sales')).toBeNull();
    expect(actionNames(list, 'w1:sales:variable:region'))
      .toEqual(['Delete the stored option SQL for region']);
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

  // #501 — the destructive row is listed FIRST (openMenu otherwise autofocuses
  // whichever row is listed first), so a keyboard user pressing Enter right
  // after opening this must land on Cancel, not on the row that deletes the
  // stored SQL.
  it('focuses Cancel by default, not the destructive action', async () => {
    const { list } = open();
    click(trash(list, 'w1:sales:variable:region')!);
    await new Promise((r) => setTimeout(r)); // openMenu's own deferred autofocus
    expect(document.activeElement).toBe(confirmItems()[1]);
    expect(document.activeElement!.textContent).toBe('Cancel');
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
    // The trash button bypasses row activation entirely.
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

describe('renderDashboardTree — Dashboard metadata pencil (#429 phase 3)', () => {
  const pencil = (list: HTMLElement, rowKey: string): HTMLButtonElement | null =>
    rowFor(list, rowKey)
      .querySelector<HTMLButtonElement>('.dash-tree-act[aria-label^="Edit dashboard"]');
  const dialogTitleInput = (): HTMLInputElement =>
    document.querySelector<HTMLInputElement>('#dash-rename-name')!;
  const dialogDescInput = (): HTMLTextAreaElement =>
    document.querySelector<HTMLTextAreaElement>('#dash-rename-description')!;
  const dialogSave = (): HTMLButtonElement => document.querySelector<HTMLButtonElement>('.fm-dialog-confirm')!;
  /** Let the awaited commit chain (`mutateWorkspace` → the reprojection poke →
   *  the dialog's own resolution) run to completion. */
  const settle = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 0); });

  it('renders the pencil on every Dashboard row', () => {
    const { app, list } = treeApp();
    renderDashboardTree(app);
    expect(pencil(list, 'w1:sales')).not.toBeNull();
    expect(pencil(list, 'w1:ops')).not.toBeNull();
  });

  it('renders no pencil on group, variable or panel rows', () => {
    const { app, list } = treeApp();
    openAll(app, 'sales');
    renderDashboardTree(app);
    expect(pencil(list, 'w1:sales:group:panels')).toBeNull();
    expect(pencil(list, 'w1:sales:variable:country')).toBeNull();
    expect(pencil(list, 'w1:sales:tile:t1')).toBeNull();
  });

  it('labels the trigger with the Dashboard\'s name', () => {
    const { app, list } = treeApp();
    renderDashboardTree(app);
    const button = pencil(list, 'w1:sales')!;
    expect(button.getAttribute('aria-label')).toBe('Edit dashboard Sales');
    expect(button.type).toBe('button');
  });

  it('opens a dialog prefilled from the current title and description, never navigating or expanding', () => {
    vi.useFakeTimers();
    const { app, list } = treeApp();
    renderDashboardTree(app);
    click(pencil(list, 'w1:sales')!);
    vi.advanceTimersByTime(400);
    expect(document.querySelector('.fm-dialog-title')!.textContent).toBe('Edit dashboard');
    expect(dialogTitleInput().value).toBe('Sales');
    expect(dialogDescInput().value).toBe('');
    expect(app.openDashboard).not.toHaveBeenCalled();
    expect(readTreeUi(app.state.dashboardTreeUi, 'w1').expandedDashboardIds.size).toBe(0);
    vi.useRealTimers();
  });

  it('prefills an existing description', () => {
    const { app, list } = treeApp();
    (app.currentWorkspace as unknown as TreeWorkspace).dashboards![0]!.description = 'Quarterly figures';
    renderDashboardTree(app);
    click(pencil(list, 'w1:sales')!);
    expect(dialogDescInput().value).toBe('Quarterly figures');
  });

  it('commits the edited title and description, and closes once the commit lands', async () => {
    const { app, list, committed } = treeApp();
    renderDashboardTree(app);
    click(pencil(list, 'w1:sales')!);
    dialogTitleInput().value = 'Sales revenue';
    dialogTitleInput().dispatchEvent(new Event('input', { bubbles: true }));
    dialogDescInput().value = 'Quarterly figures';
    dialogSave().click();
    // #495 review 2: the card stays up until the write ANSWERS — it used to be
    // torn down first, which is how a rejected commit lost the typed values
    // with nothing said.
    expect(document.querySelector('.fm-dialog-card')).not.toBeNull();
    expect(dialogSave().disabled).toBe(true);
    await settle();
    expect(document.querySelector('.fm-dialog-card')).toBeNull();
    expect(committed).toHaveLength(1);
    expect(committed[0]!.dashboards[0].title).toBe('Sales revenue');
    expect(committed[0]!.dashboards[0].description).toBe('Quarterly figures');
    // The OTHER Dashboard and every query are untouched.
    expect(committed[0]!.dashboards[1]).toEqual(workspace().dashboards![1]);
    expect(committed[0]!.queries).toEqual(workspace().queries);
  });

  it('disables Save on a blank title, and Enter in the title field commits nothing while blank', async () => {
    const { app, list, committed } = treeApp();
    renderDashboardTree(app);
    click(pencil(list, 'w1:sales')!);
    dialogTitleInput().value = '   ';
    dialogTitleInput().dispatchEvent(new Event('input', { bubbles: true }));
    expect(dialogSave().disabled).toBe(true);
    dialogTitleInput().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await Promise.resolve();
    expect(committed).toEqual([]);
    expect(document.querySelector('.fm-dialog-card')).not.toBeNull();
  });

  it('Cancel commits nothing', async () => {
    const { app, list, committed } = treeApp();
    renderDashboardTree(app);
    click(pencil(list, 'w1:sales')!);
    dialogTitleInput().value = 'Should not be saved';
    dialogTitleInput().dispatchEvent(new Event('input', { bubbles: true }));
    click(document.querySelector<HTMLButtonElement>('.fm-dialog-cancel')!);
    await Promise.resolve();
    expect(committed).toEqual([]);
    expect(document.querySelector('.fm-dialog-card')).toBeNull();
  });

  it('returns focus to the pencil trigger on close', () => {
    const { app, list } = treeApp();
    renderDashboardTree(app);
    const trigger = pencil(list, 'w1:sales')!;
    click(trigger);
    click(document.querySelector<HTMLButtonElement>('.fm-dialog-cancel')!);
    expect(document.activeElement).toBe(trigger);
  });

  // Real-browser-only bug this pins at the unit level too: the trigger is
  // `display: none` except on hover/`:focus-within`, and by the time the
  // dialog closes the pointer has typically moved onto the dialog's own
  // controls, so it needs its own signal to stay visible/focusable for the
  // dialog's WHOLE lifetime — matching `buildMenuButton`'s
  // `[aria-expanded="true"]` convention, not just hover/focus-within.
  it('marks the trigger aria-expanded for the dialog\'s whole lifetime, false again once it closes', () => {
    const { app, list } = treeApp();
    renderDashboardTree(app);
    const trigger = pencil(list, 'w1:sales')!;
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(trigger.getAttribute('aria-haspopup')).toBe('dialog');
    click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    click(document.querySelector<HTMLButtonElement>('.fm-dialog-cancel')!);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });

  // ── #495 review 2: every unsuccessful outcome is HANDLED ─────────────────
  // The dialog used to close before starting the mutation and then discard the
  // promise, so each of these presented as "the dialog vanished" while the
  // typed values went with it.

  /** Mount the pencil dialog over a `mutateWorkspace` that answers `outcome`. */
  const dialogOver = (outcome: unknown) => {
    const mutateWorkspace = vi.fn(async () => outcome) as unknown as App['mutateWorkspace'];
    const { app, list } = treeApp({ mutateWorkspace });
    renderDashboardTree(app);
    click(pencil(list, 'w1:sales')!);
    dialogTitleInput().value = 'Sales revenue';
    dialogTitleInput().dispatchEvent(new Event('input', { bubbles: true }));
    dialogDescInput().value = 'Quarterly figures';
    return { app, list };
  };
  const dialogError = (): HTMLElement | null => document.querySelector<HTMLElement>('.fm-dialog-error');

  it('keeps the dialog, the typed values and a targeted diagnostic when the Dashboard no longer resolves', async () => {
    dialogOver({ ok: false, aborted: true, data: 'declined' });
    dialogSave().click();
    await settle();
    expect(document.querySelector('.fm-dialog-card')).not.toBeNull();
    expect(dialogTitleInput().value).toBe('Sales revenue');
    expect(dialogDescInput().value).toBe('Quarterly figures');
    expect(dialogError()!.hidden).toBe(false);
    expect(dialogError()!.textContent).toBe('That dashboard is no longer part of this workspace.');
    // Recoverable from: the controls come back, so Cancel is reachable and a
    // second Save is possible.
    expect(dialogSave().disabled).toBe(false);
  });

  it('reports the aggregate\'s own diagnostic when the commit is rejected', async () => {
    dialogOver({ ok: false, diagnostics: [{ path: [], severity: 'error', code: 'x', message: 'Storage is full' }] });
    dialogSave().click();
    await settle();
    expect(document.querySelector('.fm-dialog-card')).not.toBeNull();
    expect(dialogError()!.textContent).toBe('Storage is full');
  });

  it('falls back to one sentence when a rejection carries no diagnostic', async () => {
    dialogOver({ ok: false, diagnostics: [] });
    dialogSave().click();
    await settle();
    expect(dialogError()!.textContent).toBe('Could not save this dashboard.');
  });

  it('cannot submit the same rename twice while the first write is in flight', async () => {
    const { app } = dialogOver({ ok: true, workspace: workspace(), dashboardRevision: null });
    dialogSave().click();
    // Both the button and the Enter shortcut are refused until it answers.
    dialogSave().click();
    dialogTitleInput().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await settle();
    expect(app.mutateWorkspace).toHaveBeenCalledTimes(1);
  });

  it('repeated activation opens exactly ONE dialog', () => {
    // #494: "repeated activation cannot open duplicate dialogs". A keyboard
    // autorepeat fires again while focus is still on the trigger, before the
    // dialog's own deferred focus move — and two shells would mean two modal
    // keyboard owners and a duplicate of every field id.
    const { list } = treeApp();
    renderDashboardTree(treeApp().app);
    const { app } = treeApp();
    renderDashboardTree(app);
    const trigger = actionBtn(app.dom.dashboardTreeList!, 'w1:sales', 'Edit dashboard Sales')!;
    click(trigger);
    click(trigger);
    click(trigger);
    expect(document.querySelectorAll('.fm-dialog-card')).toHaveLength(1);
    expect(document.querySelectorAll('#dash-rename-name')).toHaveLength(1);
    expect(list).toBeDefined();
  });

  it('stays aria-expanded "true" across repeated activation, and returns focus visibly on close', () => {
    // Regression for the force-close/set-attribute race: the REPLACEMENT
    // dialog's own `openDialogShell` call force-closes whatever the first
    // click opened, which runs the first dialog's `onClose` — resetting THIS
    // SAME trigger's `aria-expanded` to "false". If that reset ran after this
    // click's own "true", the trigger would be left "false" (and later
    // effectively unfocusable/hidden by the hover-reveal CSS) for the entire
    // time the replacement dialog is open.
    const { app, list } = treeApp();
    renderDashboardTree(app);
    const trigger = actionBtn(list, 'w1:sales', 'Edit dashboard Sales')!;
    click(trigger);
    click(trigger);
    click(trigger);
    expect(document.querySelectorAll('.fm-dialog-card')).toHaveLength(1);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    click(document.querySelector<HTMLButtonElement>('.fm-dialog-cancel')!);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(trigger);
  });

  it('still restores focus when the row the dialog belonged to is gone', async () => {
    // Another tab deletes the Dashboard while its rename dialog is open. The
    // trigger AND its row are detached by the time the user cancels.
    const { app, list } = treeApp();
    renderDashboardTree(app);
    click(actionBtn(list, 'w1:sales', 'Edit dashboard Sales')!);
    (app.currentWorkspace as unknown as TreeWorkspace).dashboards = [];
    renderDashboardTree(app);
    click(document.querySelector<HTMLButtonElement>('.fm-dialog-cancel')!);
    await settle();
    expect(document.activeElement).toBe(app.dom.dashboardSearchInput);
  });

  it('does not also run the row\'s own navigation, and cancels only its own row\'s pending click', () => {
    vi.useFakeTimers();
    const { app, list } = treeApp();
    openAll(app, 'sales');
    renderDashboardTree(app);
    // A pending single belongs to the PANEL row...
    click(rowFor(list, 'w1:sales:tile:t1'));
    // ...and the pencil clicked here belongs to a DIFFERENT row.
    click(pencil(list, 'w1:ops')!);
    vi.advanceTimersByTime(400);
    expect(app.openDashboard).not.toHaveBeenCalled();
    expect(app.openSavedQuery).toHaveBeenCalledExactlyOnceWith('q1');
    vi.useRealTimers();
  });
});

/**
 * #495 review 1 — every nested action control owns its own activation keys.
 *
 * The tree's `keydown` handler is on the LIST, and its Enter arm calls
 * `preventDefault()` and runs the FOCUSED ROW's command. Before this, Enter on
 * the pencil opened the Dashboard instead of the dialog (and the
 * `preventDefault()` could suppress the button's own activation on the way
 * out), which the `⋯` and the orphan-variable trash shared.
 *
 * Two independent layers are asserted here: each button stops Enter/Space from
 * propagating, AND the list handler ignores an Enter that originated on a
 * button — either alone would fix the bug, and a later control that forgets
 * the first is still covered by the second.
 */
describe('renderDashboardTree — nested action buttons own their activation keys (#495)', () => {
  /** Dispatch a real bubbling keydown, and report whether anything called
   *  `preventDefault()` — the signal that the tree handler claimed the key. */
  const press = (el: Element, k: string): boolean =>
    !el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));

  it('Enter on the Dashboard pencil opens the dialog and does NOT open the Dashboard', () => {
    const { app, list } = treeApp();
    renderDashboardTree(app);
    const trigger = actionBtn(list, 'w1:sales', 'Edit dashboard Sales')!;
    // The browser's own key-to-click synthesis is what opens the dialog; what
    // matters here is that nothing prevented it and the row did not act.
    expect(press(trigger, 'Enter')).toBe(false);
    expect(app.openDashboard).not.toHaveBeenCalled();
    // ...and the click the browser then synthesizes opens exactly one dialog.
    click(trigger);
    expect(document.querySelectorAll('.fm-dialog-card')).toHaveLength(1);
    expect(app.openDashboard).not.toHaveBeenCalled();
  });

  it('Space on the Dashboard pencil neither navigates nor is swallowed', () => {
    const { app, list } = treeApp();
    renderDashboardTree(app);
    const trigger = actionBtn(list, 'w1:sales', 'Edit dashboard Sales')!;
    expect(press(trigger, ' ')).toBe(false);
    expect(app.openDashboard).not.toHaveBeenCalled();
  });

  it('Enter on the Dashboard trash does not run the row\'s primary action', () => {
    const { app, list } = treeApp();
    renderDashboardTree(app);
    const trigger = actionBtn(list, 'w1:sales', 'Delete dashboard Sales')!;
    expect(press(trigger, 'Enter')).toBe(false);
    expect(app.openDashboard).not.toHaveBeenCalled();
  });

  it('Enter on an orphaned variable\'s trash does not open its option-SQL tab', () => {
    const { app, list } = treeApp();
    openAll(app, 'sales');
    renderDashboardTree(app);
    const trigger = actionBtn(list, 'w1:sales:variable:region',
      'Delete the stored option SQL for region')!;
    expect(press(trigger, 'Enter')).toBe(false);
    expect(app.openVariableTab).not.toHaveBeenCalled();
  });

  it('the list handler itself refuses an Enter that came from a button, even one that let it bubble', () => {
    const { app, list } = treeApp();
    renderDashboardTree(app);
    // A control with NO `isolateActivationKeys` of its own: the second layer.
    const naive = document.createElement('button');
    rowFor(list, 'w1:sales').appendChild(naive);
    expect(press(naive, 'Enter')).toBe(false);
    expect(app.openDashboard).not.toHaveBeenCalled();
    // The row itself still activates on Enter — the guard is about the target,
    // not about Enter.
    expect(press(rowFor(list, 'w1:sales'), 'Enter')).toBe(true);
    expect(app.openDashboard).toHaveBeenCalledExactlyOnceWith({ dashboardId: 'sales', mode: 'view' });
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

  // #429/#472: on a Dashboard row Enter now OPENS (it used to expand), matching the
  // primary click — and expansion is reachable independently, by Right/Left or by the
  // disclosure button. Both operations, neither hidden behind the other.
  it('Enter opens View, Shift+Enter opens Edit, and neither touches expansion', () => {
    const { app, list } = treeApp();
    renderDashboardTree(app);
    key(list, 'Enter');
    expect(app.openDashboard).toHaveBeenCalledExactlyOnceWith({ dashboardId: 'sales', mode: 'view' });
    key(list, 'Enter', { shiftKey: true });
    expect(app.openDashboard).toHaveBeenLastCalledWith({ dashboardId: 'sales', mode: 'edit' });
    expect(readTreeUi(app.state.dashboardTreeUi, 'w1').expandedDashboardIds.size).toBe(0);
    // ...and the keyboard can still expand the hierarchy, independently.
    key(list, 'ArrowRight');
    expect(readTreeUi(app.state.dashboardTreeUi, 'w1').expandedDashboardIds.has('sales')).toBe(true);
    expect(app.openDashboard).toHaveBeenCalledTimes(2);
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

  it('a search-forced row cannot be toggled — but its name still opens it', () => {
    vi.useFakeTimers();
    const { app, list } = treeApp();
    setUi(app, (ui) => setTreeSearch(ui, 'revenue'));
    renderDashboardTree(app);
    const dashboardRow = rowFor(list, 'w1:sales');
    // No BUTTON at all, rather than a control that lies about what it can do: the
    // row genuinely is open (`aria-expanded`), the search owns that, and clicking
    // must not write the user's own expansion set.
    const spacer = dashboardRow.querySelector('.chev')!;
    expect(spacer.tagName).toBe('SPAN');
    expect(spacer.hasAttribute('aria-label')).toBe(false);
    expect(dashboardRow.getAttribute('aria-expanded')).toBe('true');
    // The forced GROUP row offers no action to run at all.
    click(rowFor(list, 'w1:sales:group:panels'));
    vi.advanceTimersByTime(400);
    expect(readTreeUi(app.state.dashboardTreeUi, 'w1').expandedDashboardIds.size).toBe(0);
    expect(readTreeUi(app.state.dashboardTreeUi, 'w1').expandedGroups.size).toBe(0);
    expect(app.openDashboard).not.toHaveBeenCalled();

    // #429/#472: the row's own press is NAVIGATION now, and navigation was never
    // what the search forced — so a forced row opens like any other, where before it
    // was a dead click. With no button in the chevron slot, that spacer is ordinary
    // primary row content and the press bubbles to the row, as it does from the icon.
    click(spacer);
    expect(app.openDashboard).toHaveBeenCalledExactlyOnceWith({ dashboardId: 'sales', mode: 'view' });
    expect(readTreeUi(app.state.dashboardTreeUi, 'w1').expandedDashboardIds.size).toBe(0);

    setUi(app, (ui) => setTreeSearch(ui, ''));
    renderDashboardTree(app);
    expect(labels(list)).toEqual(['Sales', 'Ops']);
    vi.useRealTimers();
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
  const dropApp = (over: Partial<DashboardTreeApp> & { duringCommit?: () => void } = {}) => {
    const { duringCommit, ...appOver } = over;
    const base = treeApp(appOver);
    const { app } = base;
    const ws = app.currentWorkspace as unknown as StoredWorkspaceV5;
    ws.storageVersion = 5; ws.key = 'w'; ws.name = 'W';
    ws.queries = [...ws.queries, query('q-lib', 'Countries', 'SELECT c, c FROM countries')];
    const committed: StoredWorkspaceV5[] = [];
    if (!('mutateWorkspace' in appOver)) {
      app.mutateWorkspace = (async (transform) => {
        const input = await transform(app.currentWorkspace as StoredWorkspaceV5);
        const candidate = input === null ? null : input.candidate;
        if (candidate === null) {
          return { ok: false, aborted: true, data: input === null ? undefined : input.data };
        }
        committed.push(candidate);
        app.currentWorkspace = candidate as never;
        // The real primitive awaits persistence HERE, after the transform has
        // returned — past every gate the transform could apply.
        if (duringCommit) duringCommit();
        await Promise.resolve();
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
      // The tree revealed and selected it, without opening the DASHBOARD…
      expect(labels(list)).toContain('Countries');
      expect(readTreeUi(app.state.dashboardTreeUi, 'w1').keyboardRowKey)
        .toBe('w1:sales:tile:' + added.id);
      expect(app.openDashboard).not.toHaveBeenCalled();
      // …and the new panel's OWNED COPY opens in the editor, not the Library
      // original: editing the original would not touch the panel.
      expect(app.openSavedQuery).toHaveBeenCalledWith(added.queryId);
      expect(added.queryId).not.toBe('q-lib');
      expect(list.classList.contains('dash-dragging')).toBe(false);
    });

    it('puts the tree position ON the new panel row, scrolled into view', async () => {
      // Not just `tabindex="0"`: `renderDashboardTree` restores focus only when
      // the tree already held it, and after a mouse drop it does not — so the row
      // is focused explicitly or it is the arrow-key origin while off-screen.
      const { app, list, committed } = dropApp();
      renderDashboardTree(app);
      const elsewhere = document.createElement('button');
      document.body.appendChild(elsewhere);
      elsewhere.focus();

      rowFor(list, 'w1:sales').dispatchEvent(dragEvent('drop'));
      await flush();

      const sales = committed[0].dashboards.find((d) => d.id === 'sales');
      expect(sales).toBeDefined();
      const newRow = rowFor(list, 'w1:sales:tile:' + sales!.tiles[2].id);
      expect(newRow.getAttribute('tabindex')).toBe('0');
      expect(document.activeElement).toBe(newRow);
      expect(document.activeElement).not.toBe(elsewhere);
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

    // #428 opens the assigned COPY, never the Dashboard. Its original form armed a
    // deferred row click first, to prove the drop cancelled it; #429/#472 removed
    // that hazard at the source (a Dashboard row is no longer arbitrated), so what
    // is left to hold is that a drop navigates nowhere on its own — not even after
    // the old double-click window would have elapsed.
    it('does not navigate to the Dashboard, then or 350ms later', async () => {
      const { app, list } = dropApp();
      renderDashboardTree(app);
      rowFor(list, 'w1:sales').dispatchEvent(dragEvent('drop'));
      await flush();
      await new Promise((resolve) => setTimeout(resolve, 350));
      expect(app.openDashboard).not.toHaveBeenCalled();
      expect(app.openSavedQuery).toHaveBeenCalledTimes(1);
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

    it('adopts the committed SQL into a CLEAN open variable tab, and opens it', async () => {
      const { app, list } = dropApp();
      const tab = {
        id: 'vt', doc: { kind: 'dashboard-variable', dashboardId: 'sales', variableName: 'country' },
        dirtySql: false, sqlDraft: 'SELECT stale',
      };
      app.state.tabs.value = [...app.state.tabs.value, tab as never];

      await dropOnCountry(app, list);

      expect(tab.sqlDraft).toBe('SELECT c, c FROM countries');
      // Owner decision: the assigned option SQL opens for editing.
      expect(app.openVariableTab).toHaveBeenCalledWith('sales', 'country');
    });

    it('opens the variable tab even when none was open', async () => {
      const { app, list } = dropApp();
      await dropOnCountry(app, list);
      expect(app.openVariableTab).toHaveBeenCalledWith('sales', 'country');
    });

    it('says so — and offers a way out — when the tab turns dirty during the commit', async () => {
      // The in-transform gate cannot close the persistence window. Reporting a
      // clean success here is what would leave the next Save silently reverting
      // the assignment, so the toast persists (an action suppresses auto-dismiss)
      // and carries the one-click resolution.
      const tab = {
        id: 'vt', doc: { kind: 'dashboard-variable', dashboardId: 'sales', variableName: 'country' },
        dirtySql: false, sqlDraft: 'SELECT mine',
      };
      const { app, list, committed } = dropApp({
        duringCommit: () => { tab.dirtySql = true; },
      });
      app.state.tabs.value = [...app.state.tabs.value, tab as never];

      await dropOnCountry(app, list);

      // The write landed…
      expect(committed[0].dashboards.find((d) => d.id === 'sales')!.variableConfigs!.country.sql)
        .toBe('SELECT c, c FROM countries');
      // …the draft is untouched, and NOT silently adopted…
      expect(tab.sqlDraft).toBe('SELECT mine');
      // …the user is told, and the tab is opened so they can see both.
      const toast = document.querySelector('.share-toast')!;
      expect(toast.textContent).toContain('unsaved changes that differ');
      expect(app.openVariableTab).toHaveBeenCalledWith('sales', 'country');

      // The escape hatch actually resolves it.
      const action = toast.querySelector('button')!;
      expect(action.textContent).toBe('Discard draft');
      action.dispatchEvent(new Event('click', { bubbles: true }));
      expect(tab.sqlDraft).toBe('SELECT c, c FROM countries');
      expect(tab.dirtySql).toBe(false);
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
