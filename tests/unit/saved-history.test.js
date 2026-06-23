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

  it('saved: pencil → inline rename; Enter commits, Escape cancels', () => {
    const app = makeApp();
    app.state.sidePanel = 'saved';
    app.state.savedQueries = [{ id: 's1', name: 'Old', sql: '1', favorite: false }];
    renderSavedHistory(app);
    byTitle(app.dom.savedList, 'Rename').dispatchEvent(new Event('click', { bubbles: true }));
    expect(app.editingSavedId).toBe('s1');
    let input = app.dom.savedList.querySelector('.sv-edit');
    expect(input.value).toBe('Old');
    input.value = 'New';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(app.state.savedQueries[0].name).toBe('New');
    expect(app.editingSavedId).toBeNull();
    expect(app.actions.rerenderTabs).toHaveBeenCalled();
    // re-open, edit, Escape → unchanged
    byTitle(app.dom.savedList, 'Rename').dispatchEvent(new Event('click', { bubbles: true }));
    input = app.dom.savedList.querySelector('.sv-edit');
    input.value = 'XXX';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(app.editingSavedId).toBeNull();
    expect(app.state.savedQueries[0].name).toBe('New');
    // clicking the row while editing another does not load (guard) — covered by Enter path above
  });

  it('saved: Export/Import row — Export disabled when empty, enabled with queries, wired', () => {
    const app = makeApp();
    app.state.sidePanel = 'saved';
    renderSavedHistory(app);
    let exportBtn = [...app.dom.savedList.querySelectorAll('.sv-io')].find((b) => /Export/.test(b.textContent));
    expect(exportBtn.disabled).toBe(true); // empty list
    app.state.savedQueries = [{ id: 's1', name: 'A', sql: '1', favorite: false }];
    renderSavedHistory(app);
    exportBtn = [...app.dom.savedList.querySelectorAll('.sv-io')].find((b) => /Export/.test(b.textContent));
    expect(exportBtn.disabled).toBe(false);
    click(exportBtn);
    expect(app.actions.exportSaved).toHaveBeenCalled();
  });
  it('saved: Import button opens the file input; change with a file imports it', () => {
    const app = makeApp();
    app.state.sidePanel = 'saved';
    renderSavedHistory(app);
    const input = app.dom.savedList.querySelector('.saved-actions input[type="file"]');
    input.click = vi.fn();
    const importBtn = [...app.dom.savedList.querySelectorAll('.sv-io')].find((b) => /Import/.test(b.textContent));
    click(importBtn);
    expect(input.click).toHaveBeenCalled();
    // change with a file → importSavedFile(file); without → no call
    const file = { name: 'q.json' };
    Object.defineProperty(input, 'files', { configurable: true, value: [file] });
    input.dispatchEvent(new Event('change', { bubbles: true }));
    expect(app.actions.importSavedFile).toHaveBeenCalledWith(file);
    Object.defineProperty(input, 'files', { configurable: true, value: [] });
    input.dispatchEvent(new Event('change', { bubbles: true }));
    expect(app.actions.importSavedFile).toHaveBeenCalledTimes(1);
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
