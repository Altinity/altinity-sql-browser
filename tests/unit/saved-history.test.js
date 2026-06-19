import { describe, it, expect } from 'vitest';
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

  it('saved: lists rows, loads on click, deletes on close', () => {
    const app = makeApp();
    app.state.sidePanel = 'saved';
    app.state.savedQueries = [{ id: 's1', name: 'Q1', sql: 'SELECT 1\n-- more' }];
    renderSavedHistory(app);
    const row = app.dom.savedList.querySelector('.saved-row');
    expect(row.querySelector('.preview').textContent).toBe('SELECT 1');
    click(row);
    expect(app.actions.loadIntoNewTab).toHaveBeenCalledWith('Q1', 'SELECT 1\n-- more');
    const del = row.querySelector('.del');
    del.dispatchEvent(new Event('click', { bubbles: true }));
    expect(app.state.savedQueries).toHaveLength(0);
    expect(app.actions.updateStar).toHaveBeenCalled();
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

  it('history: clear button empties all history', () => {
    const app = makeApp();
    app.state.sidePanel = 'history';
    app.state.history = [{ id: 'h1', sql: 'SELECT 1', ts: Date.now(), rows: 3, ms: 4 }];
    renderSavedHistory(app);
    click(app.dom.savedList.querySelector('.clear-btn'));
    expect(app.state.history).toEqual([]);
    expect(app.saveJSON).toHaveBeenCalled();
    expect(app.dom.savedList.textContent).toContain('No history yet.');
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
