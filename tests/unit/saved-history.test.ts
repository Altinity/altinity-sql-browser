import { describe, it, expect, vi } from 'vitest';
import { renderSavedHistory } from '../../src/ui/saved-history.js';
import { SUBQUERY_MIME } from '../../src/ui/dnd-mime.js';
import { queryDescription, queryFavorite, queryName } from '../../src/core/saved-query.js';
import { makeApp } from '../helpers/fake-app.js';
import { savedQuery } from '../helpers/saved-query.js';
import type { SavedQueryFixture } from '../helpers/saved-query.js';
import { setTabSpecDraft, toggleFavorite, deleteSaved } from '../../src/state.js';
import type { App } from '../../src/ui/app.types.js';
import type { AppState, HistoryEntry } from '../../src/state.js';

type ResultView = AppState['resultView']['value'];

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
    expect(savedList(app).textContent).toContain('No saved queries yet.');
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

  it('saved: an effectful query loads into the editor but does NOT auto-run', () => {
    const app = makeApp();
    app.state.sidePanel.value = 'saved';
    setSaved(app, [{ id: 's1', name: 'Setup', sql: 'CREATE TABLE t (a Int8)', favorite: false }]);
    renderSavedHistory(app);
    click(qs(savedList(app), '.saved-row'));
    expect(app.actions.loadIntoNewTab).toHaveBeenCalledWith(app.state.savedQueries[0]);
    expect(app.actions.run).not.toHaveBeenCalled();
  });

  it('saved: opens a Filter badge directly in Spec at the role', () => {
    const app = makeApp();
    app.state.sidePanel.value = 'saved';
    setSaved(app, [{ id: 'f', name: 'Options', sql: 'SELECT 1', dashboard: { role: 'filter' } }]);
    const loaded = app.activeTab();
    app.specEditor.revealOffset = vi.fn();
    loaded.specText = '{"dashboard":{"role":"filter"}}';
    (app.actions.loadIntoNewTab as ReturnType<typeof vi.fn>).mockReturnValue(loaded);
    renderSavedHistory(app);
    click(qs(savedList(app), '.query-role-badge'));
    expect(app.actions.loadIntoNewTab).toHaveBeenCalledWith(app.state.savedQueries[0]);
    expect(app.actions.setEditorMode).toHaveBeenCalledWith('spec');
    expect(app.specEditor.revealOffset).toHaveBeenCalledWith(loaded.specText.indexOf('"role"'));
    expect(app.actions.run).not.toHaveBeenCalled();
  });

  it.each(['table', 'json', 'panel'] as ResultView[])(
    'saved: a Filter-role query always launches into the Filter preview, independent of the current result view (was %s) (#244)',
    (previousView) => {
      const app = makeApp();
      app.state.sidePanel.value = 'saved';
      app.state.resultView.value = previousView;
      setSaved(app, [{ id: 'f', name: 'Options', sql: 'SELECT 1', dashboard: { role: 'filter' } }]);
      renderSavedHistory(app);
      click(qs(savedList(app), '.saved-row'));
      expect(app.actions.run).toHaveBeenCalledWith({ view: 'filter' });
    },
  );

  it('saved: Filter role takes precedence over a dormant persisted spec.view and Panel config, without touching either (#244)', () => {
    const app = makeApp();
    app.state.sidePanel.value = 'saved';
    setSaved(app, [
      { id: 'f1', name: 'No persisted view', sql: 'SELECT 1', dashboard: { role: 'filter' } },
      {
        id: 'f2', name: 'Dormant Panel view', sql: 'SELECT 1',
        dashboard: { role: 'filter' }, view: 'panel', panel: { cfg: { type: 'kpi' } },
      },
    ]);
    renderSavedHistory(app);
    const rows = qsa(savedList(app), '.saved-row');
    click(rows[0]);
    expect(app.actions.run).toHaveBeenLastCalledWith({ view: 'filter' });
    click(rows[1]);
    expect(app.actions.run).toHaveBeenLastCalledWith({ view: 'filter' }); // role wins, not 'panel'
    // launch never mutates the saved entry — dormant view/panel survive untouched
    const dormant = app.state.savedQueries.find((q) => q.id === 'f2')!;
    expect(dormant.spec.view).toBe('panel');
    expect(dormant.spec.panel).toEqual({ cfg: { type: 'kpi' } });
    expect(dormant.spec.dashboard).toEqual({ role: 'filter' }); // no spec.view:'filter' persisted
    expect(app.saveJSON).not.toHaveBeenCalled();
  });

  it('saved: a Filter-role query that cannot auto-run still opens the Filter drawer instead of a dormant Panel view or nothing (#244)', () => {
    // A Filter-role entry with empty/DDL/multi-statement SQL can't auto-run
    // (isAutoRunnable is false) — e.g. one hand-authored, imported, or loaded
    // from localStorage without the SQL-shape validation the Spec editor
    // enforces. The role must still win the launch view: `SAVED_VIEWS`
    // deliberately excludes 'filter' (it's never persisted), so this only
    // opens correctly if the role bypasses that persisted-view check.
    const app = makeApp();
    app.state.sidePanel.value = 'saved';
    app.state.resultView.value = 'table';
    setSaved(app, [
      { id: 'f1', name: 'Empty Filter', sql: '', dashboard: { role: 'filter' } },
      {
        id: 'f2', name: 'DDL Filter with dormant Panel', sql: 'CREATE TABLE t (a Int8)',
        dashboard: { role: 'filter' }, view: 'panel', panel: { cfg: { type: 'kpi' } },
      },
    ]);
    renderSavedHistory(app);
    const rows = qsa(savedList(app), '.saved-row');
    click(rows[0]);
    expect(app.actions.run).not.toHaveBeenCalled(); // not auto-runnable
    expect(app.state.resultView.value).toBe('filter');
    app.state.resultView.value = 'table'; // reset before the second row
    click(rows[1]);
    expect(app.actions.run).not.toHaveBeenCalled();
    expect(app.state.resultView.value).toBe('filter'); // role wins, not the dormant 'panel'
  });

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

  it('saved: the tab is labelled "Queries" with a live count and no Export/Import row', () => {
    const app = makeApp();
    app.state.sidePanel.value = 'saved';
    setSaved(app, [{ id: 's1', name: 'A', sql: '1', favorite: false }]);
    renderSavedHistory(app);
    const savedTab = qsa(savedTabsRow(app), '.side-tab')[0];
    expect(savedTab.textContent).toContain('Queries');
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

  it('tolerates a missing search mount', () => {
    const app = savedApp();
    // `as`: same "defensive no-mount guard" convention as above.
    (app.dom as { savedSearch: HTMLElement | undefined }).savedSearch = undefined;
    expect(() => renderSavedHistory(app)).not.toThrow();
  });

  it('collapses the search box when the active list is empty', () => {
    const app = makeApp();
    app.state.sidePanel.value = 'saved';
    renderSavedHistory(app);
    expect(savedSearch(app).children.length).toBe(0); // :empty → hidden via CSS
    expect(savedSearch(app).querySelector('.sv-search-input')).toBeNull();
  });

  it('shows the box with a per-tab placeholder when items exist', () => {
    const app = savedApp();
    expect(input(app).placeholder).toBe('Search saved queries…');
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
    expect(savedList(app).textContent).toContain('No queries match');
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
    const pToggle = toggleFavorite(app.state, 'q1', app.mutateWorkspace, app.genId, app.specValidators);
    const pDelete = deleteSaved(app.state, 'q2', app.mutateWorkspace);
    await Promise.all([pToggle, pDelete]);
    expect(app.state.savedQueries.map((q) => q.id)).toEqual(['q1']); // q2 stays deleted
    expect(queryFavorite(app.state.savedQueries[0])).toBe(true);      // q1 toggle applied
  });
});
