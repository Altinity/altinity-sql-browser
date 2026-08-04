import { describe, it, expect, vi } from 'vitest';
import { effect } from '@preact/signals-core';
import { renderSavedHistory, libraryPanelDef, historyPanelDef } from '../../src/ui/saved-history.js';
import { buildSidePanelRegistry, renderSidePanelTabs } from '../../src/ui/side-panel-registry.js';
import type { SidePanelRegistry, SidePanelId } from '../../src/ui/side-panel-registry.js';
import { lowerIdForKey, sidePanelKeyFor } from '../../src/core/side-panels.js';
import type { LowerPanelId } from '../../src/core/side-panels.js';
import { LIBRARY_QUERY_MIME, SUBQUERY_MIME } from '../../src/ui/dnd-mime.js';
import { queryDescription, queryFavorite, queryName } from '../../src/core/saved-query.js';
import { makeApp as makeAppReal } from '../helpers/fake-app.js';
import type { MakeAppOverrides } from '../helpers/fake-app.js';
import { savedQuery } from '../helpers/saved-query.js';
import type { SavedQueryFixture } from '../helpers/saved-query.js';
import { setTabSpecDraft, toggleFavorite, deleteSaved, recordHistory } from '../../src/state.js';
import type { App } from '../../src/ui/app.types.js';
import type { AppShellHandle } from '../../src/ui/app-shell.js';
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

const lowerTabsRows = new WeakMap<App, HTMLElement>();

/**
 * #587: `fake-app.ts`'s `makeApp()` no longer builds `dom.savedList`/
 * `savedSearch`/`savedTabsRow` — those fields are GONE from `AppDom`. This
 * wraps the real `makeApp` to also build a real Library/History registry
 * (mirroring app-shell.ts's own construction) and wire it to `app.shell`, so
 * every EXISTING call site in this file (`makeApp()`/`makeApp({...})`) keeps
 * working with no other change. The tab row + its ONE reactive effect are
 * the SAME shape as app-shell.ts's own lower-pane effect (persist + set the
 * signal on select; repaint the row + the active panel on any change) —
 * built once and cached per `app` (`lowerTabsRows`), so a test's plain
 * `app.state.sidePanel.value = 'history'` (unchanged throughout this file)
 * keeps both the tab row and the registry's active panel in sync with no
 * per-test call, and clicking a tab persists exactly like production.
 */
function mountSidePanels(app: App): SidePanelRegistry {
  const registry = buildSidePanelRegistry([libraryPanelDef(app), historyPanelDef(app)]);
  const row = document.createElement('div');
  lowerTabsRows.set(app, row);
  const selectLowerPanel = (id: SidePanelId): void => {
    const key = sidePanelKeyFor(id as LowerPanelId);
    app.prefs.save('sidePanel', key);
    app.state.sidePanel.value = key;
  };
  const refreshLowerPane = (): void => {
    const activeId = lowerIdForKey(app.state.sidePanel.value);
    renderSidePanelTabs(row, registry.entries, activeId, selectLowerPanel);
    registry.showPanel(activeId);
  };
  effect(refreshLowerPane);
  // `Pick`-shaped: nothing in this file reads any OTHER `AppShellHandle`
  // member through `app.shell`. `refreshActiveSidePanels` is overridden the
  // SAME way app-shell.ts's real one is — it must also repaint the Library
  // tab's live count, not just the active body (a star/delete/rename doesn't
  // bump any signal the effect above depends on).
  app.shell = { sidePanels: { ...registry, refreshActiveSidePanels: refreshLowerPane } } as unknown as AppShellHandle;
  return registry;
}

function makeApp<O extends MakeAppOverrides = Record<string, never>>(over: O = {} as O) {
  const app = makeAppReal(over);
  mountSidePanels(app);
  return app;
}

/** The ACTIVE lower panel's persistent host — the registry's own replacement
 *  for the deleted `app.dom.savedList`/`savedSearch`/`savedTabsRow` fields. */
const activeHost = (app: App): HTMLElement =>
  app.shell!.sidePanels.entry(lowerIdForKey(app.state.sidePanel.value)).host;
const savedList = (app: App): HTMLElement => qs(activeHost(app), '.saved-list');
const savedSearch = (app: App): HTMLElement => qs(activeHost(app), '.saved-search');
/** The tab row is no longer built by `saved-history.ts` at all (#587
 *  deliverable 3) — it is app-shell.ts's own generic renderer now, cached
 *  per `app` by `mountSidePanels` above. */
const savedTabsRow = (app: App): HTMLElement => lowerTabsRows.get(app)!;

describe('renderSavedHistory', () => {
  // #587 R2.5: the compatibility export is a safe no-op both BEFORE any shell
  // has mounted and AFTER one has been disposed — `app.recordHistory` and the
  // workbench's clean-run hook are wired at controller-construction time,
  // well before `mountAppShell` ever runs, and must never throw against that.
  it('is a safe no-op before any shell has mounted', () => {
    // `makeAppReal` (not this file's own `makeApp` wrapper, which always
    // mounts one) — the genuinely-unmounted state `appDefaults.shell: null`
    // describes.
    const app = makeAppReal();
    expect(app.shell).toBeNull();
    expect(() => renderSavedHistory(app)).not.toThrow();
  });

  it('is a safe no-op after the shell has been disposed', () => {
    const app = makeApp();
    app.shell = null; // mirrors app.ts's own `disposeShell`
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
    app.workspaceSession.refreshWorkspaceFromStore = refresh;
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
    app.workspaceSession.refreshWorkspaceFromStore = refresh;
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
    expect(savedList(app).textContent).toContain('No history yet.');
  });

  it('history: lists rows (with + without row count) and loads on click', () => {
    const app = makeApp();
    app.state.sidePanel.value = 'history';
    app.state.history = [
      { id: 'h1', sql: 'SELECT 1', ts: Date.now(), rows: 3, ms: 4 },
      { id: 'h2', sql: 'INSERT …', ts: Date.now(), rows: null, ms: 1 },
    ];
    renderSavedHistory(app);
    const rows = qsa(savedList(app), '.history-row');
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
    click(qs(savedList(app), '.history-row'));
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
    click(qs(savedList(app), '.history-row .del'));
    expect(app.state.history.map((e: HistoryEntry) => e.id)).toEqual(['h2']);
    expect(app.actions.loadIntoNewTab).not.toHaveBeenCalled();
    expect(qsa(savedList(app), '.history-row')).toHaveLength(1);
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

  // #587: the "missing search mount" guard this test exercised is GONE
  // structurally, not just untested — each panel's search box is a plain
  // closure variable built once in `mount(host)` (`saved-history.ts`'s
  // `mountLowerPanel`), never looked up through an optional `app.dom.*`
  // field, so there is no longer a code path where it could be absent.

  it('collapses the search box when the active list is empty', () => {
    const app = makeApp();
    app.state.sidePanel.value = 'saved';
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
    expect(input(app).placeholder).toBe('Search history…');
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
    expect(app.state.libraryFilter).toBe('');
    expect(names(app)).toHaveLength(3);
    type(app, 'busiest');
    expect(names(app)).toEqual(['Busiest airports']);
    input(app).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(app.state.libraryFilter).toBe('');
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
    const i = qs<HTMLInputElement>(savedSearch(app), '.sv-search-input');
    i.value = 'insert'; i.dispatchEvent(new Event('input', { bubbles: true }));
    expect(qsa(savedList(app), '.history-row')).toHaveLength(1);
    expect(savedList(app).textContent).toContain('INSERT INTO t');
    i.value = 'nope'; i.dispatchEvent(new Event('input', { bubbles: true }));
    expect(savedList(app).textContent).toContain('No history matches');
  });

  it('clears the filter when switching tabs', () => {
    const app = savedApp();
    type(app, 'delay');
    expect(app.state.libraryFilter).toBe('delay');
    click(qsa(savedTabsRow(app), '.side-tab')[1]); // → History
    expect(app.state.libraryFilter).toBe('');
  });

  // #587 review finding 1: the ABOVE test only proves Library → History,
  // where the OUTGOING panel (Library) happens to be visited first by a
  // single-pass loop over `entries` (registered library-then-history,
  // app-shell.ts). This is the missing mirror — History → Library, where the
  // TARGET (Library) is visited first — and it must clear the filter and
  // render unfiltered regardless of which side of the switch is which.
  it('clears the filter when switching tabs (History → Library — order-independent of registration order)', () => {
    const app = makeApp();
    setSaved(app, [
      { id: 's1', name: 'Carrier delays', sql: 'SELECT carrier FROM flights', favorite: false },
      { id: 's2', name: 'Busiest airports', sql: 'SELECT origin, count() FROM flights', favorite: false },
    ]);
    app.state.sidePanel.value = 'history';
    app.state.history = [{ id: 'h1', sql: 'SELECT 1', ts: Date.now(), rows: 1, ms: 1 }];
    renderSavedHistory(app);
    const historyInput = qs<HTMLInputElement>(savedSearch(app), '.sv-search-input');
    historyInput.value = 'select';
    historyInput.dispatchEvent(new Event('input', { bubbles: true }));
    expect(app.state.libraryFilter).toBe('select');

    click(qsa(savedTabsRow(app), '.side-tab')[0]); // → Library (registered FIRST)
    expect(app.state.libraryFilter).toBe('');
    const libraryInput = qs<HTMLInputElement>(savedSearch(app), '.sv-search-input');
    expect(libraryInput.value).toBe('');
    // Unfiltered: both library queries show, and NOT the stale-filter empty
    // state (`No library queries match "select"`) the bug produced.
    expect(names(app)).toHaveLength(2);
    expect(savedList(app).textContent).not.toContain('No library queries match');
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
    const row = qs(savedList(app), '.history-row');
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
    const setData = dragStart(qs(savedList(app), '.history-row'));

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

// #587: the ownership guard persistent hosts require, PLUS a few pre-existing
// branches this file's own restructuring exposed as needing their own direct
// case (they were previously reached incidentally through paths this phase
// changed the shape of).
describe('#587: persistent-host ownership guard + branch coverage', () => {
  // Sabotage-checked (see the phase report): deleting the `if (!ownsTheList())
  // return;` guard from either listener in `mountLowerPanel` turns this red.
  it('a stale HIDDEN panel\'s search input cannot rewrite the shared filter or repaint the active list', () => {
    const app = makeApp();
    app.state.history = [{ id: 'h1', sql: 'SELECT 1', ts: Date.now(), rows: 1, ms: 1 }];
    setSaved(app, [{ id: 's1', name: 'Alpha', sql: '1' }]);
    // Activate History (builds + renders its own search input with a real
    // `ownsTheList` listener), then switch back to Library — History's host
    // is now hidden, but its input/listeners persist (#587 AC6: never rebuilt).
    app.state.sidePanel.value = 'history';
    app.state.sidePanel.value = 'saved';
    renderSavedHistory(app);
    const historyHost = app.shell!.sidePanels.entry('history').host;
    expect(historyHost.hidden).toBe(true);
    const historyInput = qs<HTMLInputElement>(historyHost, '.sv-search-input');
    // A real browser never delivers an event to a `hidden` subtree — this is
    // the one way (a dispatched event, exactly what this test does) it could
    // still be reached.
    historyInput.value = 'zzz';
    historyInput.dispatchEvent(new Event('input', { bubbles: true }));
    expect(app.state.libraryFilter).toBe('');
    expect(qsa(savedList(app), '.saved-row .name').map((n) => n.textContent)).toEqual(['Alpha']);
    // The SAME guard covers `setFilter` (Escape / the × clear button), not
    // just the plain `input` listener above — both wire through it.
    historyInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(app.state.libraryFilter).toBe('');
    expect(historyInput.value).toBe('zzz'); // never cleared — the guard returned first
  });

  it('the search input ignores every key except Escape', () => {
    const app = makeApp();
    app.state.sidePanel.value = 'saved';
    setSaved(app, [{ id: 's1', name: 'Alpha', sql: '1' }]);
    renderSavedHistory(app);
    const searchInput = qs<HTMLInputElement>(savedSearch(app), '.sv-search-input');
    searchInput.value = 'al';
    searchInput.dispatchEvent(new Event('input', { bubbles: true }));
    expect(app.state.libraryFilter).toBe('al');
    searchInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    expect(app.state.libraryFilter).toBe('al'); // untouched — only Escape clears
  });

  it('the rename form\'s Name/Description fields ignore keys other than Enter/Escape (or a Cmd/Ctrl+Enter for Description)', () => {
    const app = makeApp();
    app.state.sidePanel.value = 'saved';
    setSaved(app, [{ id: 's1', name: 'Old', sql: '1' }]);
    renderSavedHistory(app);
    byTitle(savedList(app), 'Edit name & description').dispatchEvent(new Event('click', { bubbles: true }));
    const nameInput = qs<HTMLInputElement>(savedList(app), '.sv-edit-name');
    const descInput = qs<HTMLTextAreaElement>(savedList(app), '.sv-edit-desc');
    nameInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    descInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    // Neither key committed or cancelled — the form is still open.
    expect(app.state.editingSavedId.value).toBe('s1');
    expect(queryName(app.state.savedQueries[0])).toBe('Old');
  });

  const emptyDiagnosticsCommit = () => vi.fn(async () => ({ ok: false as const, diagnostics: [] }));

  it('star surfaces no toast when the rejected commit carries no diagnostics', async () => {
    const commit = emptyDiagnosticsCommit();
    const app = makeApp({ workspace: { commit } });
    app.state.sidePanel.value = 'saved';
    setSaved(app, [{ id: 's1', name: 'A', sql: '1', favorite: false }]);
    renderSavedHistory(app);
    click(qs(savedList(app), '.sv-star'));
    await flush();
    expect(queryFavorite(app.state.savedQueries[0])).toBe(false);
    expect(document.querySelector('.share-toast')).toBeNull();
  });

  it('delete surfaces no toast when the rejected commit carries no diagnostics', async () => {
    const commit = emptyDiagnosticsCommit();
    const app = makeApp({ workspace: { commit } });
    app.state.sidePanel.value = 'saved';
    setSaved(app, [{ id: 's1', name: 'A', sql: '1' }]);
    renderSavedHistory(app);
    byTitle(qs(savedList(app), '.saved-row'), 'Delete').dispatchEvent(new Event('click', { bubbles: true }));
    await flush();
    expect(app.state.savedQueries).toHaveLength(1); // not deleted
    expect(document.querySelector('.share-toast')).toBeNull();
  });
});

// #587 review finding 3: `side-panel-registry.test.ts`'s own "activation
// freshness" tests only ever exercise injected FAKE panels — they prove the
// registry mechanism, but never touch the real `libraryPanelDef`/
// `historyPanelDef` this file builds, or the real `notifyRunComplete` wiring.
// A persistent hidden host showing stale DOM is exactly the bug #587 R2.6
// exists to prevent, so these two prove it against the real panels, asserting
// on RENDERED DOM (never `app.state.*`).
describe('activation freshness — real Library/History panels (#587 R2.6)', () => {
  it('history entries recorded while History is hidden are present in the DOM the moment History is activated', () => {
    const app = makeApp();
    app.state.sidePanel.value = 'saved'; // Library active, History's host hidden
    renderSavedHistory(app);
    expect(savedList(app).textContent).not.toContain('SELECT 42');

    // The real recording path (`state.ts`'s own `recordHistory`, exactly what
    // a clean run calls through `app.recordHistory`) — never a direct
    // `app.state.history` splice. Two calls (not one): `recordHistory`
    // reassigns `state.history` to a freshly sliced array each time, so a
    // SECOND call is what actually exposes a mount-time-captured stale
    // reference to the array — a single call can look correct by accident
    // (the first `unshift` still lands on whatever array object was live at
    // that moment, before it gets copied).
    recordHistory(
      app.state,
      { sqlDraft: 'SELECT 42', result: { rawText: null, rows: [{ x: 1 }], progress: { elapsed_ns: 5_000_000 } } },
      app.saveJSON,
    );
    recordHistory(
      app.state,
      { sqlDraft: 'SELECT 43', result: { rawText: null, rows: [{ x: 1 }], progress: { elapsed_ns: 5_000_000 } } },
      app.saveJSON,
    );

    app.state.sidePanel.value = 'history'; // activate History
    expect(qsa(savedList(app), '.history-row')).toHaveLength(2);
    expect(savedList(app).textContent).toContain('SELECT 42');
    expect(savedList(app).textContent).toContain('SELECT 43');
  });

  it('a Library mutation made while Library is hidden is present in the DOM the moment Library is activated', async () => {
    const app = makeApp();
    setSaved(app, [{ id: 's1', name: 'Q1', sql: 'SELECT 1', favorite: false }]);
    app.state.sidePanel.value = 'history'; // History active, Library's host hidden
    renderSavedHistory(app);

    // The real mutation path (`state.ts`'s own `toggleFavorite`, through
    // `app.mutateWorkspace` — exactly what the star button's onclick calls),
    // never a direct `app.state.savedQueries` mutation.
    await toggleFavorite(app.state, 's1', app.mutateWorkspace, app.specValidators);

    app.state.sidePanel.value = 'saved'; // activate Library
    expect(qs(savedList(app), '.sv-star').classList.contains('on')).toBe(true);
  });
});
