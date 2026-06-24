import { describe, it, expect, vi } from 'vitest';
import { renderSavedHistory } from '../../src/ui/saved-history.js';
import { makeApp } from '../helpers/fake-app.js';

const click = (el) => el.dispatchEvent(new Event('click', { bubbles: true }));

describe('renderSavedHistory', () => {
  it('no-ops without mounts', () => {
    const app = makeApp();
    app.dom.savedTabsRow = null;
    expect(() => renderSavedHistory(app)).not.toThrow();
  });

  it('saved: empty state', () => {
    const app = makeApp();
    app.state.sidePanel = 'saved';
    renderSavedHistory(app);
    expect(app.dom.savedList.textContent).toContain('No saved queries yet.');
  });

  const byTitle = (root, t) => [...root.querySelectorAll('.sv-act')].find((b) => b.title === t);

  it('saved: lists rows, loads on click, deletes via trash + refreshes Save button', () => {
    const app = makeApp();
    app.state.sidePanel = 'saved';
    const chart = { cfg: { type: 'pie', x: 0, y: [1], series: null }, key: 'k' };
    app.state.savedQueries = [{ id: 's1', name: 'Q1', sql: 'SELECT 1\n-- more', favorite: false, chart, view: 'chart' }];
    renderSavedHistory(app);
    const row = app.dom.savedList.querySelector('.saved-row');
    expect(row.querySelector('.preview').textContent).toBe('SELECT 1');
    click(row);
    // links the tab + restores the chart, then runs in the saved view so results show immediately
    expect(app.actions.loadIntoNewTab).toHaveBeenCalledWith('Q1', 'SELECT 1\n-- more', 's1', chart);
    expect(app.actions.run).toHaveBeenCalledWith({ view: 'chart' });
    byTitle(row, 'Delete').dispatchEvent(new Event('click', { bubbles: true }));
    expect(app.state.savedQueries).toHaveLength(0);
    expect(app.updateSaveBtn).toHaveBeenCalled();
  });

  it('saved: live count + star toggles favorite and re-sorts favorites first', () => {
    const app = makeApp();
    app.state.sidePanel = 'saved';
    app.state.savedQueries = [
      { id: 'a', name: 'A', sql: '1', favorite: false },
      { id: 'b', name: 'B', sql: '2', favorite: false },
    ];
    renderSavedHistory(app);
    expect(app.dom.savedTabsRow.querySelector('.side-count').textContent).toContain('2');
    const names = () => [...app.dom.savedList.querySelectorAll('.saved-row .name')].map((n) => n.textContent);
    expect(names()).toEqual(['A', 'B']);
    const stars = app.dom.savedList.querySelectorAll('.sv-star');
    stars[1].dispatchEvent(new Event('click', { bubbles: true })); // favorite B
    expect(app.state.savedQueries.find((q) => q.id === 'b').favorite).toBe(true);
    expect(names()).toEqual(['B', 'A']);
  });

  it('saved: pencil opens the edit form; Name(Enter)+Description commit via renameSaved; double-fire is guarded', () => {
    const app = makeApp();
    app.state.sidePanel = 'saved';
    app.state.savedQueries = [{ id: 's1', name: 'Old', sql: '1', favorite: false }];
    renderSavedHistory(app);
    byTitle(app.dom.savedList, 'Edit name & description').dispatchEvent(new Event('click', { bubbles: true }));
    expect(app.editingSavedId).toBe('s1');
    const nameInput = app.dom.savedList.querySelector('.sv-edit-name');
    const descInput = app.dom.savedList.querySelector('.sv-edit-desc');
    expect(nameInput.value).toBe('Old');
    expect(descInput.value).toBe(''); // no description yet
    nameInput.value = 'New';
    descInput.value = 'a description';
    nameInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(app.state.savedQueries[0]).toMatchObject({ name: 'New', description: 'a description' });
    expect(app.editingSavedId).toBeNull();
    expect(app.actions.rerenderTabs).toHaveBeenCalled();
    // a second commit on the now-detached field is a no-op (the `done` guard)
    nameInput.value = 'AGAIN';
    nameInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(app.state.savedQueries[0].name).toBe('New');
    // re-open and press Escape on the name field → cancels without saving
    byTitle(app.dom.savedList, 'Edit name & description').dispatchEvent(new Event('click', { bubbles: true }));
    const reName = app.dom.savedList.querySelector('.sv-edit-name');
    reName.value = 'XYZ';
    reName.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(app.editingSavedId).toBeNull();
    expect(app.state.savedQueries[0].name).toBe('New');
  });
  it('saved: edit form — description prefilled; ⌘/Ctrl+Enter + Save commit, Escape/Cancel + empty name revert', () => {
    const app = makeApp();
    app.state.sidePanel = 'saved';
    app.state.savedQueries = [{ id: 's1', name: 'Old', sql: '1', favorite: false, description: 'd0' }];
    renderSavedHistory(app);
    const open = () => byTitle(app.dom.savedList, 'Edit name & description').dispatchEvent(new Event('click', { bubbles: true }));
    // ⌘Enter on the description commits (and prefills the existing description)
    open();
    let descInput = app.dom.savedList.querySelector('.sv-edit-desc');
    expect(descInput.value).toBe('d0');
    descInput.value = 'd1';
    descInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true }));
    expect(app.state.savedQueries[0].description).toBe('d1');
    // Ctrl+Enter also commits
    open();
    descInput = app.dom.savedList.querySelector('.sv-edit-desc');
    descInput.value = 'd2';
    descInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
    expect(app.state.savedQueries[0].description).toBe('d2');
    // Escape on the description cancels without saving
    open();
    descInput = app.dom.savedList.querySelector('.sv-edit-desc');
    descInput.value = 'nope';
    descInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(app.state.savedQueries[0].description).toBe('d2');
    expect(app.editingSavedId).toBeNull();
    // Save button with a blank name does not rename (commit guard)
    open();
    app.dom.savedList.querySelector('.sv-edit-name').value = '   ';
    app.dom.savedList.querySelector('.sv-edit-save').dispatchEvent(new Event('click', { bubbles: true }));
    expect(app.state.savedQueries[0].name).toBe('Old');
    expect(app.editingSavedId).toBeNull();
    // Cancel button reverts an edited name
    open();
    app.dom.savedList.querySelector('.sv-edit-name').value = 'ZZZ';
    app.dom.savedList.querySelector('.sv-edit-cancel').dispatchEvent(new Event('click', { bubbles: true }));
    expect(app.state.savedQueries[0].name).toBe('Old');
  });
  it('saved: renders a 2-line description preview when present, omits it otherwise', () => {
    const app = makeApp();
    app.state.sidePanel = 'saved';
    app.state.savedQueries = [
      { id: 's1', name: 'A', sql: '1', favorite: false, description: 'explains A' },
      { id: 's2', name: 'B', sql: '2', favorite: false },
    ];
    renderSavedHistory(app);
    const rows = app.dom.savedList.querySelectorAll('.saved-row');
    expect(rows[0].querySelector('.desc').textContent).toBe('explains A');
    expect(rows[1].querySelector('.desc')).toBeNull();
  });

  it('saved: the tab is labelled "Library" with a live count and no Export/Import row', () => {
    const app = makeApp();
    app.state.sidePanel = 'saved';
    app.state.savedQueries = [{ id: 's1', name: 'A', sql: '1', favorite: false }];
    renderSavedHistory(app);
    const savedTab = app.dom.savedTabsRow.querySelectorAll('.side-tab')[0];
    expect(savedTab.textContent).toContain('Library');
    expect(savedTab.textContent).not.toContain('Saved');
    expect(savedTab.querySelector('.side-count').textContent).toContain('1');
    // the old bottom Export/Import row is gone (moved to the header File menu)
    expect(app.dom.savedList.querySelector('.saved-actions')).toBeNull();
    expect(app.dom.savedList.querySelector('.sv-io')).toBeNull();
  });
  it('history: empty state', () => {
    const app = makeApp();
    app.state.sidePanel = 'history';
    renderSavedHistory(app);
    expect(app.dom.savedList.textContent).toContain('No history yet.');
  });

  it('history: lists rows (with + without row count) and loads on click', () => {
    const app = makeApp();
    app.state.sidePanel = 'history';
    app.state.history = [
      { id: 'h1', sql: 'SELECT 1', ts: Date.now(), rows: 3, ms: 4 },
      { id: 'h2', sql: 'INSERT …', ts: Date.now(), rows: null, ms: 1 },
    ];
    renderSavedHistory(app);
    const rows = app.dom.savedList.querySelectorAll('.history-row');
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain('3 rows');
    expect(rows[1].textContent).not.toContain('rows');
    click(rows[0]);
    expect(app.actions.loadIntoNewTab).toHaveBeenCalledWith('From history', 'SELECT 1');
    expect(app.actions.run).toHaveBeenCalled(); // re-runs on restore
  });

  it('history: per-row delete removes just that entry without loading it', () => {
    const app = makeApp();
    app.state.sidePanel = 'history';
    app.state.history = [
      { id: 'h1', sql: 'SELECT 1', ts: Date.now(), rows: 3, ms: 4 },
      { id: 'h2', sql: 'SELECT 2', ts: Date.now(), rows: 1, ms: 2 },
    ];
    renderSavedHistory(app);
    click(app.dom.savedList.querySelector('.history-row .del'));
    expect(app.state.history.map((e) => e.id)).toEqual(['h2']);
    expect(app.actions.loadIntoNewTab).not.toHaveBeenCalled();
    expect(app.dom.savedList.querySelectorAll('.history-row')).toHaveLength(1);
  });

  it('switching panels persists the choice', () => {
    const app = makeApp();
    app.state.sidePanel = 'saved';
    renderSavedHistory(app);
    const [savedBtn, histBtn] = app.dom.savedTabsRow.querySelectorAll('.side-tab');
    click(histBtn);
    expect(app.state.sidePanel).toBe('history');
    expect(app.savePref).toHaveBeenCalledWith('sidePanel', 'history');
    click(savedBtn);
    expect(app.state.sidePanel).toBe('saved');
    expect(app.savePref).toHaveBeenCalledWith('sidePanel', 'saved');
  });
});
