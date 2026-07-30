import { describe, it, expect, vi } from 'vitest';
import { renderSavedHistory, renderLibrarySection, renderHistorySection } from '../../src/ui/saved-history.js';
import { LIBRARY_QUERY_MIME, SUBQUERY_MIME } from '../../src/ui/dnd-mime.js';
import { queryDescription, queryFavorite, queryName } from '../../src/core/saved-query.js';
import { makeApp } from '../helpers/fake-app.js';
import { NAV_SECTION_META } from '../../src/ui/nav-sections.js';
import { s as svgEl } from '../../src/ui/dom.js';
import { savedQuery } from '../helpers/saved-query.js';
import type { SavedQueryFixture } from '../helpers/saved-query.js';
import { setTabSpecDraft, toggleFavorite, deleteSaved } from '../../src/state.js';
import type { App } from '../../src/ui/app.types.js';
import type { HistoryEntry } from '../../src/state.js';

const click = (el: Element) => el.dispatchEvent(new Event('click', { bubbles: true }));
// #287 W4: toggleFavorite/renameSaved/deleteSaved's onclick handlers are now
// async (they await the aggregate commit before mutating state/re-rendering)
// — a macrotask flush lets every pending microtask (the commit promise chain)
// settle before a test's post-click assertions run.
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const setSaved = (app: App, queries: SavedQueryFixture[]) => {
  app.state.savedQueries = queries.map((q) => savedQuery(q));
};
const dragStart = (el: Element) => {
  const setData = vi.fn();
  const e = Object.assign(new Event('dragstart', { bubbles: true }), { dataTransfer: { setData } });
  el.dispatchEvent(e);
  return setData;
};
const qs = <T extends Element = HTMLElement>(root: ParentNode, selector: string): T =>
  root.querySelector(selector) as T;
const qsa = <T extends Element = HTMLElement>(root: ParentNode, selector: string): T[] =>
  [...root.querySelectorAll(selector)] as T[];
const byTitle = (root: ParentNode, t: string): HTMLElement =>
  qsa(root, '.sv-act').find((b) => b.title === t) as HTMLElement;
/** `app.dom.*` mounts are always present (`makeApp()`'s own dom stubs), or
 *  are deliberately cleared in a no-mount test — those tests never read
 *  through this helper. */
const savedList = (app: App): HTMLElement => app.dom.savedList!;
const savedTabsRow = (app: App): HTMLElement => app.dom.savedTabsRow!;
const savedSearch = (app: App): HTMLElement => app.dom.savedSearch!;
// #487 phase 2: the History section renders into its OWN persistent pair, so every
// History assertion below names those elements explicitly. Reading through an
// "active section" helper instead would pass even if the renderer painted History
// rows into the Library's list — which is the one thing this split has to prevent.
const historyList = (app: App): HTMLElement => app.dom.historyList!;
const historySearch = (app: App): HTMLElement => app.dom.historySearch!;

describe('renderSavedHistory', () => {
  it('no-ops without mounts', () => {
    const app = makeApp();
    // `as`: fake-app's `dom.savedTabsRow` is a real HTMLElement in the fixture
    // literal (never absent in practice) — this test exercises the defensive
    // "no mount point" guard renderSavedHistory itself keeps.
    (app.dom as { savedTabsRow: HTMLElement | undefined }).savedTabsRow = undefined;
    expect(() => renderSavedHistory(app)).not.toThrow();
  });

  it('saved: empty state', () => {
    const app = makeApp();
    app.state.sidePanel.value = 'saved';
    renderSavedHistory(app);
    expect(savedList(app).textContent).toContain('No library queries yet.');
  });

  it('saved: lists rows, loads on click, deletes via trash + refreshes Save button', async () => {
    const app = makeApp();
    app.state.sidePanel.value = 'saved';
    const panel = { cfg: { type: 'pie', x: 0, y: [1], series: null }, key: 'k' };
    setSaved(app, [{ id: 's1', name: 'Q1', sql: 'SELECT 1\n-- more', favorite: false, panel, view: 'panel' }]);
    app.activeTab().savedId = 's1';
    app.activeTab().editorMode = 'spec';
    renderSavedHistory(app);
    const row = qs(savedList(app), '.saved-row');
    expect(qs(row, '.preview').textContent).toBe('SELECT 1');
    click(row);
    // links the tab + restores the chart, then runs in the saved view so results show immediately
    expect(app.actions.loadIntoNewTab).toHaveBeenCalledWith(app.state.savedQueries[0]);
    expect(app.actions.run).toHaveBeenCalledWith({ view: 'panel' });
    byTitle(row, 'Delete').dispatchEvent(new Event('click', { bubbles: true }));
    await flush();
    expect(app.state.savedQueries).toHaveLength(0);
    expect(app.updateSaveBtn).toHaveBeenCalled();
    expect(app.updateEditorModeUi).toHaveBeenCalled();
    expect(app.activeTab().editorMode).toBe('sql');
  });

  it('saved: exposes Add to dashboard before Edit without opening the query row', () => {
    const app = makeApp();
    app.state.sidePanel.value = 'saved';
    setSaved(app, [{ id: 's1', name: 'Q1', sql: 'SELECT 1' }]);
    renderSavedHistory(app);
    const row = qs(savedList(app), '.saved-row');
    const actions = qsa<HTMLButtonElement>(row, '.sv-act');

    expect(actions.map((button) => button.title)).toEqual([
      'Add to dashboard…', 'Edit name & description', 'Delete',
    ]);
    expect(actions[0].classList.contains('sv-assign')).toBe(true);
    expect(actions[0].getAttribute('aria-label')).toBe('Add to dashboard…');
    click(actions[0]);
    expect(app.actions.loadIntoNewTab).not.toHaveBeenCalled();
    expect(document.querySelector('.library-assign-menu')?.textContent)
      .toContain('Create or open a dashboard');
  });

  it('stale saved-query mutations finish durably without settling into the obsolete Workbench renderer', async () => {
    const app = makeApp();
    app.state.sidePanel.value = 'saved';
    setSaved(app, [
      { id: 'star', name: 'Star', sql: 'SELECT 1', favorite: false },
      { id: 'delete', name: 'Delete', sql: 'SELECT 2', favorite: false },
      { id: 'rename', name: 'Rename', sql: 'SELECT 3', favorite: false },
    ]);
    app.refreshCurrentSurfaceAfterStale = vi.fn(() => false);
    renderSavedHistory(app);
    const rows = qsa(savedList(app), '.saved-row');

    click(qs(rows[0], '.sv-star'));
    await flush();
    click(byTitle(rows[1], 'Delete'));
    await flush();
    click(byTitle(rows[2], 'Edit name & description'));
    const input = qs<HTMLInputElement>(savedList(app), '.sv-edit-name');
    input.value = 'Renamed';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flush();

    expect(app.refreshCurrentSurfaceAfterStale).toHaveBeenCalledTimes(3);
    expect(queryFavorite(app.state.savedQueries.find((q) => q.id === 'star'))).toBe(true);
    expect(app.state.savedQueries.some((q) => q.id === 'delete')).toBe(false);
    expect(queryName(app.state.savedQueries.find((q) => q.id === 'rename'))).toBe('Renamed');
    expect(app.state.editingSavedId.value).toBeNull();
    expect(app.updateSaveBtn).not.toHaveBeenCalled();
    expect(app.actions.rerenderTabs).not.toHaveBeenCalled();
  });

  it('saved: an effectful query loads into the editor but does NOT auto-run', () => {
    const app = makeApp();
    app.state.sidePanel.value = 'saved';
    setSaved(app, [{ id: 's1', name: 'Setup', sql: 'CREATE TABLE t (a Int8)', favorite: false }]);
    renderSavedHistory(app);
    click(qs(savedList(app), '.saved-row'));
    expect(app.actions.loadIntoNewTab).toHaveBeenCalledWith(app.state.savedQueries[0]);
    expect(app.actions.run).not.toHaveBeenCalled();
  });

  it('saved: a queryless panel with no remembered view still opens the Panel drawer', () => {
    const app = makeApp();
    app.state.sidePanel.value = 'saved';
    app.state.resultView.value = 'table';
    setSaved(app, [{ id: 's1', name: 'Text', sql: '', panel: { cfg: { type: 'text', content: 'Hello' } } }]);
    renderSavedHistory(app);
    click(qs(savedList(app), '.saved-row'));
    expect(app.actions.run).not.toHaveBeenCalled();
    expect(app.state.resultView.value).toBe('panel');
  });

  // #447 coverage restoration (worker 3): the non-auto-runnable-WITH-a-remembered-
  // view arm of `open()` used to be reached only by the deleted #244 case (a
  // Filter-role entry with DDL SQL). It is still live #166 behaviour for any
  // effectful/queryless entry carrying a persisted table/json/panel view, so it
  // keeps a case of its own rather than losing its only exercise.
  it('saved: an effectful query with a remembered view restores that view without running', () => {
    const app = makeApp();
    app.state.sidePanel.value = 'saved';
    app.state.resultView.value = 'table';
    setSaved(app, [{ id: 's1', name: 'Setup', sql: 'CREATE TABLE t (a Int8)', favorite: false, view: 'json' }]);
    renderSavedHistory(app);
    click(qs(savedList(app), '.saved-row'));
    expect(app.actions.run).not.toHaveBeenCalled();
    expect(app.state.resultView.value).toBe('json');
  });

  // #447 deleted four Library-launch cases whose subject was the Filter role:
  // the `.query-role-badge` "open the role in Spec" badge, and the three #244
  // "a Filter-role query always launches into the Filter preview" cases (role
  // beats the current view / a dormant persisted view / a non-auto-runnable
  // entry). There is no `filter` role and no Filter result view left.

  it('saved: live count + star toggles favorite and re-sorts favorites first', async () => {
    const app = makeApp();
    app.state.sidePanel.value = 'saved';
    setSaved(app, [
      { id: 'a', name: 'A', sql: '1', favorite: false },
      { id: 'b', name: 'B', sql: '2', favorite: false },
    ]);
    renderSavedHistory(app);
    expect(qs(savedTabsRow(app), '.side-count').textContent).toContain('2');
    const names = () => qsa(savedList(app), '.saved-row .name').map((n) => n.textContent);
    expect(names()).toEqual(['A', 'B']);
    const stars = qsa(savedList(app), '.sv-star');
    stars[1].dispatchEvent(new Event('click', { bubbles: true })); // favorite B
    await flush();
    expect(queryFavorite(app.state.savedQueries.find((q) => q.id === 'b'))).toBe(true);
    expect(names()).toEqual(['B', 'A']);
    expect(app.queryDoc.revalidateSpecDrafts).toHaveBeenCalled();
  });

  // #427: the star is a Library preference. It reads `spec.favorite` directly,
  // sorts favourites first, and adds no tile to anything.
  it('saved: stars read spec.favorite, sort favourites first, and touch no Dashboard', async () => {
    const app = makeApp();
    app.state.sidePanel.value = 'saved';
    setSaved(app, [
      { id: 'a', name: 'Starred', sql: '1', favorite: true },
      { id: 'b', name: 'Plain', sql: '2', favorite: false },
    ]);
    app.state.dashboard = {
      documentVersion: 2, id: 'd', title: 'D', revision: 1,
      layout: { type: 'flow', version: 1, preset: 'report', items: {} },
      tiles: [],
    };
    renderSavedHistory(app);
    const rows = qsa(savedList(app), '.saved-row');
    expect(rows.map((row) => qs(row, '.name').textContent)).toEqual(['Starred', 'Plain']);
    expect(qs(rows[0], '.sv-star').classList.contains('on')).toBe(true);
    expect(qs(rows[1], '.sv-star').classList.contains('on')).toBe(false);

    click(qs(rows[1], '.sv-star'));
    await flush();
    expect(queryFavorite(app.state.savedQueries.find((query) => query.id === 'b'))).toBe(true);
    // No tile was minted for it — a star cannot change Dashboard membership.
    expect(app.state.dashboard.tiles).toEqual([]);
  });

  // #427: the LIBRARY projection. A query some Dashboard member owns is not a
  // Library entry — it stays serialized, and #426's tree is how it is reached.
  it('saved: hides queries owned by a non-current Dashboard, including their trash controls', () => {
    const app = makeApp();
    app.state.sidePanel.value = 'saved';
    setSaved(app, [
      { id: 'lib', name: 'Library one', sql: '1' },
      { id: 'owned-panel', name: 'Owned panel', sql: '2' },
    ]);
    app.currentWorkspace = {
      storageVersion: 5, id: 'w', key: 'w', name: 'W',
      queries: app.state.savedQueries,
      dashboards: [
        {
          documentVersion: 2, id: 'current', title: 'Current', revision: 1,
          layout: { type: 'flow', version: 1, preset: 'report', items: {} },
          tiles: [],
        },
        {
          documentVersion: 2, id: 'other', title: 'Other', revision: 1,
          layout: { type: 'flow', version: 1, preset: 'report', items: { t1: {} } },
          tiles: [{ id: 't1', queryId: 'owned-panel' }],
        },
      ],
    };
    renderSavedHistory(app);
    const rows = qsa(savedList(app), '.saved-row');
    expect(rows.map((row) => qs(row, '.name').textContent)).toEqual(['Library one']);
    expect(qsa(savedList(app), '.sv-act').filter((button) => button.title === 'Delete')).toHaveLength(1);
    expect(qs(savedTabsRow(app), '.side-count').textContent).toBe('· 1');
    // Every stored query is still there — the list is a projection, not a filter
    // on the workspace.
    expect(app.state.savedQueries).toHaveLength(2);
  });

  it('saved: shows the empty state when every query is owned, not a search box', () => {
    const app = makeApp();
    app.state.sidePanel.value = 'saved';
    setSaved(app, [{ id: 'owned', name: 'Owned', sql: '1' }]);
    app.currentWorkspace = {
      storageVersion: 5, id: 'w', key: 'w', name: 'W',
      queries: app.state.savedQueries,
      dashboards: [{
        documentVersion: 2, id: 'd', title: 'D', revision: 1,
        layout: { type: 'flow', version: 1, preset: 'report', items: { t1: {} } },
        tiles: [{ id: 't1', queryId: 'owned' }],
      }],
    };
    renderSavedHistory(app);
    expect(savedList(app).textContent).toContain('No library queries yet.');
    expect(savedSearch(app).querySelector('.sv-search-input')).toBeNull();
  });

  // #427/#434: the #425 star gate is RETIRED. It existed only because the star
  // wrote the compatibility Dashboard's tiles, so starring while another
  // Dashboard was on screen edited the wrong one. A star writes `spec.favorite`
  // and nothing else now, so there is no wrong Dashboard to protect.
  it('saved: stars while a non-first Dashboard is selected, with no refusal', async () => {
    const app = makeApp();
    app.state.sidePanel.value = 'saved';
    setSaved(app, [{ id: 'a', name: 'A', sql: '1', favorite: false }]);
    const dashboard = (id: string) => ({
      documentVersion: 2 as const, id, title: id, revision: 1,
      layout: { type: 'flow' as const, version: 1 as const, preset: 'report' as const, items: {} },
      tiles: [],
    });
    app.currentWorkspace = {
      storageVersion: 5, id: 'w', key: 'w', name: 'W',
      queries: app.state.savedQueries, dashboards: [dashboard('first'), dashboard('second')],
    };
    app.mainSurface = {
      kind: 'dashboard', dashboardId: 'second', mode: 'edit',
      currentMember: null, pendingFocus: null, pendingScrollTop: null,
    };
    renderSavedHistory(app);
    click(qs(savedList(app), '.sv-star'));
    await flush();
    expect(queryFavorite(app.state.savedQueries[0])).toBe(true);
    expect(document.querySelector('.share-toast')).toBeNull();
    // Neither Dashboard gained a tile.
    expect(app.currentWorkspace.dashboards.flatMap((d) => d.tiles)).toEqual([]);
  });

  it('saved: favorite merges into a linked dirty valid Spec draft', async () => {
    const app = makeApp();
    app.state.sidePanel.value = 'saved';
    setSaved(app, [{ id: 's1', name: 'A', sql: '1', favorite: false }]);
    const tab = app.activeTab();
    tab.savedId = 's1';
    setTabSpecDraft(tab, { name: 'Draft', favorite: false, future: { keep: true } }, { dirty: true });
    renderSavedHistory(app);
    click(qs(savedList(app), '.sv-star'));
    await flush();
    expect(queryFavorite(app.state.savedQueries[0])).toBe(true);
    expect(tab.specParsed).toMatchObject({ name: 'Draft', favorite: true, future: { keep: true } });
    expect(tab.dirtySpec).toBe(true);
  });

  it('saved: pencil focuses an invalid linked Spec draft instead of opening', () => {
    const app = makeApp();
    app.state.sidePanel.value = 'saved';
    setSaved(app, [{ id: 's1', name: 'A', sql: '1', favorite: false }]);
    const tab = app.activeTab();
    tab.savedId = 's1';
    tab.specParsed = null;
    tab.specText = '{"name":';
    tab.specDiagnostics = [{ code: 'invalid-json', message: 'invalid JSON' }];
    tab.dirtySpec = true;
    renderSavedHistory(app);
    click(byTitle(savedList(app), 'Edit name & description'));
    expect(app.state.editingSavedId.value).toBeNull();
    expect(app.activateInvalidSpecDraft).toHaveBeenCalledWith(tab);
  });

  it('saved: favorite blocks on invalid JSON without persistence', async () => {
    const app = makeApp();
    app.state.sidePanel.value = 'saved';
    setSaved(app, [{ id: 's1', name: 'A', sql: '1', favorite: false }]);
    const tab = app.activeTab();
    tab.savedId = 's1';
    tab.specParsed = null;
    tab.specText = '{';
    tab.specDiagnostics = [{ code: 'invalid-json', message: 'invalid JSON' }];
    tab.dirtySpec = true;
    renderSavedHistory(app);
    click(qs(savedList(app), '.sv-star'));
    await flush();
    expect(queryFavorite(app.state.savedQueries[0])).toBe(false);
    expect(app.activateInvalidSpecDraft).toHaveBeenCalledWith(tab);
  });

  const failingCommit = () => vi.fn(async () => ({
    ok: false as const,
    diagnostics: [{ path: [], severity: 'error' as const, code: 'test-fail', message: 'boom' }],
  }));

  it('#287 W4: star surfaces a toast (and mutates nothing) when the aggregate commit is rejected', async () => {
    const commit = failingCommit();
    const app = makeApp({ workspace: { commit } });
    app.state.sidePanel.value = 'saved';
    setSaved(app, [{ id: 's1', name: 'A', sql: '1', favorite: false }]);
    renderSavedHistory(app);
    click(qs(savedList(app), '.sv-star'));
    await flush();
    expect(queryFavorite(app.state.savedQueries[0])).toBe(false);
    expect(qs(document, '.share-toast').textContent).toBe('Couldn’t update favorite: boom');
  });

  it('#343: star on a query deleted in another tab toasts and refreshes the workspace', async () => {
    const app = makeApp();
    // The latest committed workspace no longer contains s1 — the patch aborts.
    app.mutateWorkspace = (async (transform: Parameters<App['mutateWorkspace']>[0]) => {
      const input = await transform({ storageVersion: 5, id: 'w1', key: 'l', name: 'L', queries: [], dashboards: [] });
      expect(input).toBeNull(); // the planner found no target and aborted
      return { ok: false as const, aborted: true as const, data: undefined };
    }) as App['mutateWorkspace'];
    const refresh = vi.fn(async () => {});
    app.refreshWorkspaceFromStore = refresh;
    app.state.sidePanel.value = 'saved';
    setSaved(app, [{ id: 's1', name: 'A', sql: '1', favorite: false }]);
    renderSavedHistory(app);
    click(qs(savedList(app), '.sv-star'));
    await flush();
    expect(queryFavorite(app.state.savedQueries[0])).toBe(false); // never recreated/toggled
    expect(qs(document, '.share-toast').textContent).toBe('This query was deleted in another tab');
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('#343: rename on a query deleted in another tab toasts and refreshes the workspace', async () => {
    const app = makeApp();
    app.mutateWorkspace = (async (transform: Parameters<App['mutateWorkspace']>[0]) => {
      const input = await transform({ storageVersion: 5, id: 'w1', key: 'l', name: 'L', queries: [], dashboards: [] });
      expect(input).toBeNull();
      return { ok: false as const, aborted: true as const, data: undefined };
    }) as App['mutateWorkspace'];
    const refresh = vi.fn(async () => {});
    app.refreshWorkspaceFromStore = refresh;
    app.state.sidePanel.value = 'saved';
    setSaved(app, [{ id: 's1', name: 'Old', sql: '1', favorite: false }]);
    renderSavedHistory(app);
    byTitle(savedList(app), 'Edit name & description').dispatchEvent(new Event('click', { bubbles: true }));
    const nameInput = qs<HTMLInputElement>(savedList(app), '.sv-edit-name');
    nameInput.value = 'New';
    nameInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flush();
    expect(queryName(app.state.savedQueries[0])).toBe('Old'); // untouched
    expect(qs(document, '.share-toast').textContent).toBe('This query was deleted in another tab');
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('#287 W4: delete surfaces a toast (and mutates nothing) when the aggregate commit is rejected', async () => {
    const commit = failingCommit();
    const app = makeApp({ workspace: { commit } });
    app.state.sidePanel.value = 'saved';
    setSaved(app, [{ id: 's1', name: 'A', sql: '1', favorite: false }]);
    app.activeTab().savedId = 's1';
    renderSavedHistory(app);
    byTitle(qs(savedList(app), '.saved-row'), 'Delete').dispatchEvent(new Event('click', { bubbles: true }));
    await flush();
    expect(app.state.savedQueries).toHaveLength(1);
    expect(app.activeTab().savedId).toBe('s1');
    expect(app.updateSaveBtn).not.toHaveBeenCalled();
    expect(qs(document, '.share-toast').textContent).toBe('Couldn’t delete: boom');
  });

  it('#287 W4: rename surfaces a toast (and mutates nothing) when the aggregate commit is rejected', async () => {
    const commit = failingCommit();
    const app = makeApp({ workspace: { commit } });
    app.state.sidePanel.value = 'saved';
    setSaved(app, [{ id: 's1', name: 'Old', sql: '1', favorite: false }]);
    renderSavedHistory(app);
    byTitle(savedList(app), 'Edit name & description').dispatchEvent(new Event('click', { bubbles: true }));
    qs<HTMLInputElement>(savedList(app), '.sv-edit-name').value = 'New';
    qs<HTMLInputElement>(savedList(app), '.sv-edit-name')
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flush();
    expect(queryName(app.state.savedQueries[0])).toBe('Old');
    expect(qs(document, '.share-toast').textContent).toBe('Couldn’t rename: boom');
  });

  it('saved: pencil opens the edit form; Name(Enter)+Description commit via renameSaved; double-fire is guarded', async () => {
    const app = makeApp();
    app.state.sidePanel.value = 'saved';
    setSaved(app, [{ id: 's1', name: 'Old', sql: '1', favorite: false }]);
    renderSavedHistory(app);
    byTitle(savedList(app), 'Edit name & description').dispatchEvent(new Event('click', { bubbles: true }));
    expect(app.state.editingSavedId.value).toBe('s1');
    const nameInput = qs<HTMLInputElement>(savedList(app), '.sv-edit-name');
    const descInput = qs<HTMLTextAreaElement>(savedList(app), '.sv-edit-desc');
    expect(nameInput.value).toBe('Old');
    expect(descInput.value).toBe(''); // no description yet
    nameInput.value = 'New';
    descInput.value = 'a description';
    nameInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flush();
    expect(app.state.savedQueries[0].spec).toMatchObject({ name: 'New', description: 'a description' });
    expect(app.state.editingSavedId.value).toBeNull();
    expect(app.actions.rerenderTabs).toHaveBeenCalled();
    expect(app.queryDoc.revalidateSpecDrafts).toHaveBeenCalled();
    // a second commit on the now-detached field is a no-op (the `done` guard)
    nameInput.value = 'AGAIN';
    nameInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flush();
    expect(queryName(app.state.savedQueries[0])).toBe('New');
    // re-open and press Escape on the name field → cancels without saving
    byTitle(savedList(app), 'Edit name & description').dispatchEvent(new Event('click', { bubbles: true }));
    const reName = qs<HTMLInputElement>(savedList(app), '.sv-edit-name');
    reName.value = 'XYZ';
    reName.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(app.state.editingSavedId.value).toBeNull();
    expect(queryName(app.state.savedQueries[0])).toBe('New');
  });

  it('saved: rename focuses a linked Spec draft that became invalid after the form opened', async () => {
    const app = makeApp();
    app.state.sidePanel.value = 'saved';
    setSaved(app, [{ id: 's1', name: 'Old', sql: '1' }]);
    const tab = app.activeTab();
    tab.savedId = 's1';
    renderSavedHistory(app);
    click(byTitle(savedList(app), 'Edit name & description'));
    const name = qs<HTMLInputElement>(savedList(app), '.sv-edit-name');
    tab.specParsed = null;
    tab.specText = '{';
    tab.specDiagnostics = [{ code: 'invalid-json', message: 'invalid JSON' }];
    tab.dirtySpec = true;
    name.value = 'New';
    name.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flush();
    expect(app.activateInvalidSpecDraft).toHaveBeenCalledWith(tab);
    expect(queryName(app.state.savedQueries[0])).toBe('Old');
  });
  it('saved: edit form — description prefilled; ⌘/Ctrl+Enter + Save commit, Escape/Cancel + empty name revert', async () => {
    const app = makeApp();
    app.state.sidePanel.value = 'saved';
    setSaved(app, [{ id: 's1', name: 'Old', sql: '1', favorite: false, description: 'd0' }]);
    renderSavedHistory(app);
    const open = () => byTitle(savedList(app), 'Edit name & description').dispatchEvent(new Event('click', { bubbles: true }));
    // ⌘Enter on the description commits (and prefills the existing description)
    open();
    let descInput = qs<HTMLTextAreaElement>(savedList(app), '.sv-edit-desc');
    expect(descInput.value).toBe('d0');
    descInput.value = 'd1';
    descInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true }));
    await flush();
    expect(queryDescription(app.state.savedQueries[0])).toBe('d1');
    // Ctrl+Enter also commits
    open();
    descInput = qs<HTMLTextAreaElement>(savedList(app), '.sv-edit-desc');
    descInput.value = 'd2';
    descInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
    await flush();
    expect(queryDescription(app.state.savedQueries[0])).toBe('d2');
    // Escape on the description cancels without saving
    open();
    descInput = qs<HTMLTextAreaElement>(savedList(app), '.sv-edit-desc');
    descInput.value = 'nope';
    descInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(queryDescription(app.state.savedQueries[0])).toBe('d2');
    expect(app.state.editingSavedId.value).toBeNull();
    // Save button with a blank name does not rename (commit guard)
    open();
    qs<HTMLInputElement>(savedList(app), '.sv-edit-name').value = '   ';
    qs(savedList(app), '.sv-edit-save').dispatchEvent(new Event('click', { bubbles: true }));
    expect(queryName(app.state.savedQueries[0])).toBe('Old');
    expect(app.state.editingSavedId.value).toBeNull();
    // Cancel button reverts an edited name
    open();
    qs<HTMLInputElement>(savedList(app), '.sv-edit-name').value = 'ZZZ';
    qs(savedList(app), '.sv-edit-cancel').dispatchEvent(new Event('click', { bubbles: true }));
    expect(queryName(app.state.savedQueries[0])).toBe('Old');
  });
  it('saved: renders a 2-line description preview when present, omits it otherwise', () => {
    const app = makeApp();
    app.state.sidePanel.value = 'saved';
    setSaved(app, [
      { id: 's1', name: 'A', sql: '1', favorite: false, description: 'explains A' },
      { id: 's2', name: 'B', sql: '2', favorite: false },
    ]);
    renderSavedHistory(app);
    const rows = qsa(savedList(app), '.saved-row');
    expect(qs(rows[0], '.desc').textContent).toBe('explains A');
    expect(rows[1].querySelector('.desc')).toBeNull();
  });

  it('saved: the tab is labelled "Library" with a live count and no Export/Import row', () => {
    const app = makeApp();
    app.state.sidePanel.value = 'saved';
    setSaved(app, [{ id: 's1', name: 'A', sql: '1', favorite: false }]);
    renderSavedHistory(app);
    const savedTab = qsa(savedTabsRow(app), '.side-tab')[0];
    expect(savedTab.textContent).toContain('Library');
    expect(savedTab.textContent).not.toContain('Queries');
    expect(savedTab.textContent).not.toContain('Saved');
    expect(qs(savedTab, '.side-count').textContent).toContain('1');
    // the old bottom Export/Import row is gone (moved to the header File menu)
    expect(savedList(app).querySelector('.saved-actions')).toBeNull();
    expect(savedList(app).querySelector('.sv-io')).toBeNull();
  });
  it('history: empty state', () => {
    const app = makeApp();
    app.state.sidePanel.value = 'history';
    renderSavedHistory(app);
    expect(historyList(app).textContent).toContain('No history yet.');
  });

  it('history: lists rows (with + without row count) and loads on click', () => {
    const app = makeApp();
    app.state.sidePanel.value = 'history';
    app.state.history = [
      { id: 'h1', sql: 'SELECT 1', ts: Date.now(), rows: 3, ms: 4 },
      { id: 'h2', sql: 'INSERT …', ts: Date.now(), rows: null, ms: 1 },
    ];
    renderSavedHistory(app);
    const rows = qsa(historyList(app), '.history-row');
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain('3 rows');
    expect(rows[1].textContent).not.toContain('rows');
    click(rows[0]);
    expect(app.actions.loadIntoNewTab).toHaveBeenCalledWith('From history', 'SELECT 1');
    expect(app.actions.run).toHaveBeenCalled(); // re-runs on restore
  });

  it('history: an effectful entry loads into the editor but does NOT auto-run', () => {
    const app = makeApp();
    app.state.sidePanel.value = 'history';
    app.state.history = [{ id: 'h1', sql: 'DROP TABLE t', ts: Date.now(), rows: null, ms: 1 }];
    renderSavedHistory(app);
    click(qs(historyList(app), '.history-row'));
    expect(app.actions.loadIntoNewTab).toHaveBeenCalledWith('From history', 'DROP TABLE t');
    expect(app.actions.run).not.toHaveBeenCalled();
  });

  it('history: per-row delete removes just that entry without loading it', () => {
    const app = makeApp();
    app.state.sidePanel.value = 'history';
    app.state.history = [
      { id: 'h1', sql: 'SELECT 1', ts: Date.now(), rows: 3, ms: 4 },
      { id: 'h2', sql: 'SELECT 2', ts: Date.now(), rows: 1, ms: 2 },
    ];
    renderSavedHistory(app);
    click(qs(historyList(app), '.history-row .del'));
    expect(app.state.history.map((e: HistoryEntry) => e.id)).toEqual(['h2']);
    expect(app.actions.loadIntoNewTab).not.toHaveBeenCalled();
    expect(qsa(historyList(app), '.history-row')).toHaveLength(1);
  });

  it('resolves an out-of-union sidePanel the SAME way the shell exposes it', () => {
    // `state.ts` decodes `asb:sidePanel` at load, so this value cannot come from
    // storage — but the signal is settable by any module, and the two readers must
    // not be able to disagree. `app-shell.ts`'s exposure effect resolves anything
    // that is not 'history' to the Library host.
    //
    // #487 phase 3: content rendering no longer depends on this decoding at all
    // — both sections always render their own content regardless of which is
    // exposed. What this decoding still controls is only the tab row's "active"
    // class / `aria-pressed`, asserted here.
    const app = makeApp();
    (app.state.sidePanel as { value: string }).value = 'queries';
    setSaved(app, [{ id: 's1', name: 'Q1', sql: 'SELECT 1' }]);
    renderSavedHistory(app);

    expect(qsa(savedList(app), '.saved-row')).toHaveLength(1);
    const tabs = qsa<HTMLButtonElement>(savedTabsRow(app), '.side-tab');
    expect(tabs[0].classList.contains('active')).toBe(true);
    expect(tabs[0].getAttribute('aria-pressed')).toBe('true');
    expect(tabs[1].classList.contains('active')).toBe(false);
    expect(tabs[1].getAttribute('aria-pressed')).toBe('false');
  });

  it('takes the lower tabs\' labels and icons FROM the registry', () => {
    // The mirror of `sidebar-upper.test.ts`'s equivalent. Asserting the rendered
    // text is 'Library' cannot distinguish reading NAV_SECTION_META from
    // hard-coding the same string next to it — so override the registry and
    // require the tab row to follow. Phase 3's rail is the third consumer of
    // these same labels; a second copy here is how the presentations drift.
    const app = makeApp();
    app.state.sidePanel.value = 'saved';
    const meta = NAV_SECTION_META.history as { label: string; icon: () => SVGElement };
    const label = meta.label;
    const icon = meta.icon;
    try {
      meta.label = 'Recent runs';
      meta.icon = () => svgEl('svg', { 'data-registry-icon': 'yes' });
      renderSavedHistory(app);
      const tabs = qsa(savedTabsRow(app), '.side-tab');
      expect(tabs[1].textContent).toBe('Recent runs');
      expect(tabs[1].querySelector('[data-registry-icon="yes"]')).not.toBeNull();
    } finally {
      meta.label = label;
      meta.icon = icon;
    }
  });

  it('a retained search box whose section is no longer exposed still writes only its OWN section (#487 phase 3)', () => {
    // #487 phase 2: the inactive section's host keeps its DOM, so its search input
    // and listeners OUTLIVE the switch away from it. #487 phase 3 gives each
    // section its own filter slot (`state.lowerNavigationFilters`), so a "stale"
    // Library input firing while History is exposed can only ever write Library's
    // own filter and repaint Library's own (hidden) list — never History's.
    const app = makeApp();
    app.state.sidePanel.value = 'saved';
    setSaved(app, [{ id: 's1', name: 'Carrier delays', sql: 'SELECT 1' }]);
    renderSavedHistory(app);
    const staleInput = qs<HTMLInputElement>(savedSearch(app), '.sv-search-input');

    app.state.sidePanel.value = 'history';
    app.state.history = [{ id: 'h1', sql: 'SELECT 1', ts: Date.now(), rows: 1, ms: 1 }];
    renderSavedHistory(app);
    expect(qsa(historyList(app), '.history-row')).toHaveLength(1);

    staleInput.value = 'zzzz';
    staleInput.dispatchEvent(new Event('input', { bubbles: true }));

    // Library's OWN filter took the input; History's own filter and rendered
    // content are untouched — no cross-section rewrite, no "No history matches
    // “zzzz”".
    expect(app.state.lowerNavigationFilters.library).toBe('zzzz');
    expect(app.state.lowerNavigationFilters.history).toBe('');
    expect(qsa(historyList(app), '.history-row')).toHaveLength(1);
    expect(historyList(app).textContent).not.toContain('zzzz');
    expect(savedList(app).textContent).toContain('No library queries match');
    expect(savedList(app).textContent).toContain('zzzz');

    // Escape on the stale input clears LIBRARY's own filter, still without
    // touching History.
    staleInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(app.state.lowerNavigationFilters.library).toBe('');
    expect(qsa(historyList(app), '.history-row')).toHaveLength(1);
  });

  it('switching panels persists the choice', () => {
    const app = makeApp();
    app.state.sidePanel.value = 'saved';
    renderSavedHistory(app);
    const [savedBtn, histBtn] = qsa(savedTabsRow(app), '.side-tab');
    click(histBtn);
    expect(app.state.sidePanel.value).toBe('history');
    expect(app.prefs.save).toHaveBeenCalledWith('sidePanel', 'history');
    click(savedBtn);
    expect(app.state.sidePanel.value).toBe('saved');
    expect(app.prefs.save).toHaveBeenCalledWith('sidePanel', 'saved');
  });

  // #572: the lower switcher's tabs had neither attribute, unlike the upper
  // switcher's (`sidebar-upper.ts`), which already has both.
  it('renders the lower tabs as real buttons with correct aria-pressed (#572)', () => {
    const app = makeApp();
    app.state.sidePanel.value = 'saved';
    renderSavedHistory(app);
    const [libraryTab, historyTab] = qsa<HTMLButtonElement>(savedTabsRow(app), '.side-tab');
    expect(libraryTab.type).toBe('button');
    expect(libraryTab.getAttribute('aria-pressed')).toBe('true');
    expect(historyTab.type).toBe('button');
    expect(historyTab.getAttribute('aria-pressed')).toBe('false');
    // #487 phase 3 step 4: the wide-mode restore-focus path
    // (`app-shell.ts`'s `applyEffectiveLeftNavigationLayout`) finds a tab by
    // `data-section` at the moment of the transition.
    expect(libraryTab.dataset.section).toBe('library');
    expect(historyTab.dataset.section).toBe('history');

    click(historyTab);
    renderSavedHistory(app);
    const [libraryTab2, historyTab2] = qsa<HTMLButtonElement>(savedTabsRow(app), '.side-tab');
    expect(libraryTab2.getAttribute('aria-pressed')).toBe('false');
    expect(historyTab2.getAttribute('aria-pressed')).toBe('true');
  });
});

describe('renderLibrarySection / renderHistorySection (#487 phase 3: independent of exposure)', () => {
  // Direct regression test for the "first switch to a section shows empty" bug:
  // before this phase, a section's content only ever painted while it was the
  // ACTIVE section, so the section that was not active when the pane first
  // mounted had never been painted.
  it('renderHistorySection paints History\'s own host even while Library is the exposed section', () => {
    const app = makeApp();
    app.state.sidePanel.value = 'saved'; // Library is exposed, not History
    app.state.history = [{ id: 'h1', sql: 'SELECT 1', ts: Date.now(), rows: 1, ms: 1 }];
    renderHistorySection(app);
    expect(qsa(historyList(app), '.history-row')).toHaveLength(1);
  });

  it('renderLibrarySection paints Library\'s own host even while History is the exposed section', () => {
    const app = makeApp();
    app.state.sidePanel.value = 'history'; // History is exposed, not Library
    setSaved(app, [{ id: 's1', name: 'Q1', sql: 'SELECT 1' }]);
    renderLibrarySection(app);
    expect(qsa(savedList(app), '.saved-row')).toHaveLength(1);
  });

  // Direct regression test for the "the section that wasn't active when its own
  // data changed goes stale" bug, and its mirror.
  it('a History-only mutation does not touch Library\'s DOM', () => {
    const app = makeApp();
    app.state.sidePanel.value = 'saved';
    setSaved(app, [{ id: 's1', name: 'Q1', sql: 'SELECT 1' }]);
    renderSavedHistory(app);
    const before = savedList(app).innerHTML;

    app.state.history = [{ id: 'h1', sql: 'SELECT 1', ts: Date.now(), rows: 1, ms: 1 }];
    renderHistorySection(app);

    expect(savedList(app).innerHTML).toBe(before);
    expect(qsa(historyList(app), '.history-row')).toHaveLength(1);
  });

  it('a Library-only mutation does not touch History\'s DOM', () => {
    const app = makeApp();
    app.state.sidePanel.value = 'history';
    app.state.history = [{ id: 'h1', sql: 'SELECT 1', ts: Date.now(), rows: 1, ms: 1 }];
    renderSavedHistory(app);
    const before = historyList(app).innerHTML;

    setSaved(app, [{ id: 's1', name: 'Q1', sql: 'SELECT 1' }]);
    renderLibrarySection(app);

    expect(historyList(app).innerHTML).toBe(before);
    expect(qsa(savedList(app), '.saved-row')).toHaveLength(1);
  });
});

describe('renderSavedHistory — search/filter', () => {
  const savedApp = () => {
    const app = makeApp();
    app.state.sidePanel.value = 'saved';
    setSaved(app, [
      { id: 's1', name: 'Carrier delays', sql: 'SELECT carrier FROM flights', favorite: false, description: 'worst delays' },
      { id: 's2', name: 'Busiest airports', sql: 'SELECT origin, count() FROM flights', favorite: false },
      { id: 's3', name: 'Monthly cancellations', sql: 'SELECT month, sum(cancelled)', favorite: false },
    ]);
    renderSavedHistory(app);
    return app;
  };
  const input = (app: App): HTMLInputElement => qs<HTMLInputElement>(savedSearch(app), '.sv-search-input');
  const names = (app: App): (string | null)[] => qsa(savedList(app), '.saved-row .name').map((n) => n.textContent);
  const type = (app: App, v: string): void => { const i = input(app); i.value = v; i.dispatchEvent(new Event('input', { bubbles: true })); };

  it('tolerates a missing search mount', () => {
    const app = savedApp();
    // `as`: same "defensive no-mount guard" convention as above.
    (app.dom as { savedSearch: HTMLElement | undefined }).savedSearch = undefined;
    expect(() => renderSavedHistory(app)).not.toThrow();
  });

  it('collapses the search box when the active list becomes empty', () => {
    // Populate the box FIRST, then empty the list and re-render. Asserting
    // `children.length === 0` on a freshly built fixture element proves nothing —
    // `makeApp()` creates `savedSearch` empty, so that assertion held even if
    // `renderSearch` never touched this element at all (which, since the two lower
    // sections own separate boxes, is now a reachable bug rather than a hypothetical).
    const app = savedApp();
    expect(savedSearch(app).querySelector('.sv-search-input')).not.toBeNull();

    app.state.savedQueries = [];
    renderSavedHistory(app);
    expect(savedSearch(app).children.length).toBe(0); // :empty → hidden via CSS
    expect(savedSearch(app).querySelector('.sv-search-input')).toBeNull();
  });

  it('shows the box with a per-tab placeholder when items exist', () => {
    const app = savedApp();
    expect(input(app).placeholder).toBe('Search library queries…');
    app.state.sidePanel.value = 'history';
    app.state.history = [{ id: 'h1', sql: 'SELECT 1', ts: Date.now(), rows: 1, ms: 1 }];
    renderSavedHistory(app);
    expect(qs<HTMLInputElement>(historySearch(app), '.sv-search-input').placeholder)
      .toBe('Search history…');
  });

  it('filters saved by name / description / sql, case-insensitively, reusing the input node', () => {
    const app = savedApp();
    const before = input(app);
    type(app, 'delay'); // s1 name "Carrier delays" + description "worst delays"
    expect(names(app)).toEqual(['Carrier delays']);
    expect(input(app)).toBe(before); // list-only re-render keeps the input (focus-preserving)
    type(app, 'origin'); // s2 sql only
    expect(names(app)).toEqual(['Busiest airports']);
    type(app, 'CARRIER'); // case-insensitive
    expect(names(app)).toEqual(['Carrier delays']);
  });

  it('shows a no-match message and clears via the × button and Escape', () => {
    const app = savedApp();
    type(app, 'zzzz');
    expect(savedList(app).textContent).toContain('No library queries match');
    expect(savedList(app).textContent).toContain('zzzz');
    click(qs(savedSearch(app), '.sv-search-clear'));
    expect(app.state.lowerNavigationFilters.library).toBe('');
    expect(names(app)).toHaveLength(3);
    type(app, 'busiest');
    expect(names(app)).toEqual(['Busiest airports']);
    input(app).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(app.state.lowerNavigationFilters.library).toBe('');
    expect(names(app)).toHaveLength(3);
  });

  // #487 phase 3 step 4: an EMPTY search box must not swallow Escape, or the
  // focused drawer's own Escape-to-close handler (`app-shell.ts`) can never be
  // reached while focus sits in an untouched search input. This is what makes
  // the fix reachable: against the OLD code (Escape always clears + always
  // `preventDefault()`s), this assertion on `defaultPrevented` fails.
  it('does NOT swallow Escape on an already-EMPTY search box (so it can bubble to the drawer)', () => {
    const app = savedApp();
    const box = input(app);
    expect(box.value).toBe(''); // genuinely empty — not merely "looks empty"

    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    box.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(app.state.lowerNavigationFilters.library).toBe('');
    expect(names(app)).toHaveLength(3);
  });

  it('filters history by sql with its own no-match message', () => {
    const app = makeApp();
    app.state.sidePanel.value = 'history';
    app.state.history = [
      { id: 'h1', sql: 'SELECT 1', ts: Date.now(), rows: 1, ms: 1 },
      { id: 'h2', sql: 'INSERT INTO t', ts: Date.now(), rows: null, ms: 1 },
    ];
    renderSavedHistory(app);
    const i = qs<HTMLInputElement>(historySearch(app), '.sv-search-input');
    i.value = 'insert'; i.dispatchEvent(new Event('input', { bubbles: true }));
    expect(qsa(historyList(app), '.history-row')).toHaveLength(1);
    expect(historyList(app).textContent).toContain('INSERT INTO t');
    i.value = 'nope'; i.dispatchEvent(new Event('input', { bubbles: true }));
    expect(historyList(app).textContent).toContain('No history matches');
  });

  // #487 phase 3: the OPPOSITE of the old behavior — switching used to clear
  // the (single, shared) filter; now each section keeps its own, preserved
  // across every switch. Sabotage-checked: reintroducing a clear on `switchTo`
  // (or gating either section's render behind `activeSection`) makes this fail.
  it('preserves each section\'s own filter text across every switch', () => {
    const app = savedApp();
    type(app, 'delay');
    expect(app.state.lowerNavigationFilters.library).toBe('delay');

    click(qsa(savedTabsRow(app), '.side-tab')[1]); // → History
    expect(app.state.sidePanel.value).toBe('history');
    expect(app.state.lowerNavigationFilters.library).toBe('delay'); // NOT cleared
    expect(app.state.lowerNavigationFilters.history).toBe('');

    // Give History its OWN, independent filter text.
    app.state.history = [
      { id: 'h1', sql: 'SELECT 1', ts: Date.now(), rows: 1, ms: 1 },
      { id: 'h2', sql: 'INSERT INTO t', ts: Date.now(), rows: null, ms: 1 },
    ];
    renderSavedHistory(app);
    const historyInput = qs<HTMLInputElement>(historySearch(app), '.sv-search-input');
    historyInput.value = 'insert';
    historyInput.dispatchEvent(new Event('input', { bubbles: true }));
    expect(app.state.lowerNavigationFilters.history).toBe('insert');

    click(qsa(savedTabsRow(app), '.side-tab')[0]); // → Library
    expect(app.state.sidePanel.value).toBe('saved');
    expect(app.state.lowerNavigationFilters.library).toBe('delay'); // still preserved
    expect(app.state.lowerNavigationFilters.history).toBe('insert'); // still preserved

    // Re-render (as the real app-shell repaint effects would) and confirm the
    // preserved text is actually what's shown, not just stored.
    renderSavedHistory(app);
    expect(input(app).value).toBe('delay');
    expect(names(app)).toEqual(['Carrier delays']);

    click(qsa(savedTabsRow(app), '.side-tab')[1]); // → History again
    renderSavedHistory(app);
    expect(qs<HTMLInputElement>(historySearch(app), '.sv-search-input').value).toBe('insert');
    expect(qsa(historyList(app), '.history-row')).toHaveLength(1);
    expect(historyList(app).textContent).toContain('INSERT INTO t');
  });
});

describe('drag a row into the editor', () => {
  it('a saved row is draggable and carries its SQL as a subquery payload', () => {
    const app = makeApp();
    app.state.sidePanel.value = 'saved';
    setSaved(app, [{ id: 's1', name: 'Q1', sql: 'SELECT 1\n-- more', favorite: false }]);
    renderSavedHistory(app);
    const row = qs(savedList(app), '.saved-row');
    expect(row.getAttribute('draggable')).toBe('true');
    const setData = dragStart(row);
    expect(setData).toHaveBeenCalledWith(SUBQUERY_MIME, 'SELECT 1\n-- more');
  });
  it('a history row is draggable and carries its SQL as a subquery payload', () => {
    const app = makeApp();
    app.state.sidePanel.value = 'history';
    app.state.history = [{ id: 'h1', sql: 'SELECT 2', ts: Date.now(), rows: 1, ms: 1 }];
    renderSavedHistory(app);
    const row = qs(historyList(app), '.history-row');
    expect(row.getAttribute('draggable')).toBe('true');
    const setData = dragStart(row);
    expect(setData).toHaveBeenCalledWith(SUBQUERY_MIME, 'SELECT 2');
  });
});

describe('drag a Library row onto a Dashboard (#428)', () => {
  /** An app whose Library holds `s1` and whose tree list exists to be classed. */
  const libraryApp = (over: { workspace?: boolean } = {}) => {
    const app = makeApp();
    app.state.sidePanel.value = 'saved';
    setSaved(app, [{ id: 's1', name: 'Q1', sql: 'SELECT 1', favorite: false }]);
    if (over.workspace !== false) {
      app.currentWorkspace = {
        storageVersion: 5, id: 'w1', key: 'w', name: 'W',
        queries: app.state.savedQueries,
        dashboards: [],
      } as never;
    }
    const list = app.document.createElement('div');
    list.className = 'schema-list dash-tree-list';
    (app.dom as { dashboardTreeList: HTMLElement }).dashboardTreeList = list;
    renderSavedHistory(app);
    return { app, list, row: qs(savedList(app), '.saved-row') };
  };

  it('publishes BOTH payloads — the editor takes SQL, Dashboards take identity', () => {
    const { row } = libraryApp();
    const setData = dragStart(row);

    expect(setData).toHaveBeenCalledWith(SUBQUERY_MIME, 'SELECT 1');
    expect(setData).toHaveBeenCalledWith(
      LIBRARY_QUERY_MIME,
      JSON.stringify({ kind: 'library-query', workspaceId: 'w1', queryId: 's1' }),
    );
    expect(setData).toHaveBeenCalledTimes(2);
  });

  it('never puts SQL or a saved query into the identity payload', () => {
    const { row } = libraryApp();
    const setData = dragStart(row);
    const identity = setData.mock.calls.find((call) => call[0] === LIBRARY_QUERY_MIME)![1];

    expect(JSON.parse(identity)).toEqual({ kind: 'library-query', workspaceId: 'w1', queryId: 's1' });
    expect(identity).not.toContain('SELECT');
  });

  it('a History row publishes ONLY the subquery payload — it has no stable identity', () => {
    const app = makeApp();
    app.state.sidePanel.value = 'history';
    app.state.history = [{ id: 'h1', sql: 'SELECT 2', ts: Date.now(), rows: 1, ms: 1 }];
    renderSavedHistory(app);
    const setData = dragStart(qs(historyList(app), '.history-row'));

    expect(setData).toHaveBeenCalledTimes(1);
    expect(setData).toHaveBeenCalledWith(SUBQUERY_MIME, 'SELECT 2');
  });

  it('drags as text only when no workspace aggregate is committed yet', () => {
    // Nothing to assign to, and no workspace id to scope the identity by.
    const { app, list, row } = libraryApp({ workspace: false });
    app.currentWorkspace = null;
    renderSavedHistory(app);
    const setData = dragStart(qs(savedList(app), '.saved-row'));

    expect(setData).toHaveBeenCalledTimes(1);
    expect(setData).toHaveBeenCalledWith(SUBQUERY_MIME, 'SELECT 1');
    expect(list.classList.contains('dash-dragging')).toBe(false);
    expect(row).toBeTruthy();
  });

  it('reveals the tree\'s eligible targets while dragging, and clears on dragend', () => {
    const { list, row } = libraryApp();

    dragStart(row);
    expect(list.classList.contains('dash-dragging')).toBe(true);

    row.dispatchEvent(new Event('dragend', { bubbles: true }));
    expect(list.classList.contains('dash-dragging')).toBe(false);
  });

  it('starting a drag does not open the query', () => {
    // A native HTML5 drag emits no `click`, which is why there is no
    // suppression flag in the source — a branch no test could reach.
    const { app, row } = libraryApp();
    const loadIntoNewTab = vi.fn();
    (app.actions as { loadIntoNewTab: unknown }).loadIntoNewTab = loadIntoNewTab;

    dragStart(row);
    row.dispatchEvent(new Event('dragend', { bubbles: true }));
    expect(loadIntoNewTab).not.toHaveBeenCalled();
  });

  it('leaves star, rename and delete WORKING on a draggable row', async () => {
    // `draggable="true"` on the row must not swallow a child button's click.
    const { app, row } = libraryApp();
    expect(row.getAttribute('draggable')).toBe('true');

    click(qs(row, '.sv-star'));
    await flush();
    expect(queryFavorite(app.state.savedQueries[0])).toBe(true);
    // The row's own open action never fired.
    expect(app.actions.loadIntoNewTab).not.toHaveBeenCalled();
  });

  it('rename and delete still reach their handlers through a draggable row', async () => {
    const { app } = libraryApp();
    click(byTitle(qs(savedList(app), '.saved-row'), 'Edit name & description'));
    expect(app.state.editingSavedId.value).toBe('s1');
    expect(app.actions.loadIntoNewTab).not.toHaveBeenCalled();

    app.state.editingSavedId.value = null;
    renderSavedHistory(app);
    click(byTitle(qs(savedList(app), '.saved-row'), 'Delete'));
    await flush();
    expect(app.state.savedQueries).toHaveLength(0);
  });
});

describe('concurrent saved-query writes (#287 review fix)', () => {
  it('serializes overlapping ops so a delete is not resurrected by a stale toggle', async () => {
    const app = makeApp();
    setSaved(app, [
      { id: 'q1', name: 'Q1', sql: 'SELECT 1', favorite: false },
      { id: 'q2', name: 'Q2', sql: 'SELECT 2' },
    ]);
    // Fire a favorite-toggle on q1 and a delete on q2 in the same tick. #343:
    // both run their candidate-building transform through app.mutateWorkspace,
    // which serializes on one queue and reads the latest committed workspace at
    // dequeue — so the delete can't resurrect q2 from a stale [q1,q2] snapshot.
    const pToggle = toggleFavorite(app.state, 'q1', app.mutateWorkspace, app.specValidators);
    const pDelete = deleteSaved(app.state, 'q2', app.mutateWorkspace);
    await Promise.all([pToggle, pDelete]);
    expect(app.state.savedQueries.map((q) => q.id)).toEqual(['q1']); // q2 stays deleted
    expect(queryFavorite(app.state.savedQueries[0])).toBe(true);      // q1 toggle applied
  });
});
