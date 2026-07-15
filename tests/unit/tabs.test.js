import { describe, it, expect, vi } from 'vitest';
import { renderTabs, selectTab, newTab, closeTab, loadIntoNewTab } from '../../src/ui/tabs.js';
import { tabPanel } from '../../src/state.js';
import { makeApp } from '../helpers/fake-app.js';
import { savedQuery } from '../helpers/saved-query.js';

describe('renderTabs', () => {
  it('no-ops without a mount point', () => {
    const app = makeApp();
    app.dom.qtabsInner = null;
    expect(() => renderTabs(app)).not.toThrow();
  });
  it('marks the active tab, shows dirty dot, and a close button only with >1 tab', () => {
    const app = makeApp();
    app.state.tabs.value = [
      { id: 't1', name: 'A', dirtySql: true, dirtySpec: false },
      { id: 't2', name: 'B', dirtySql: false, dirtySpec: false },
    ];
    app.state.activeTabId.value = 't1';
    renderTabs(app);
    const tabs = app.dom.qtabsInner.querySelectorAll('.qtab');
    expect(tabs).toHaveLength(2);
    expect(tabs[0].classList.contains('active')).toBe(true);
    expect(tabs[0].querySelector('.dirty')).not.toBeNull();
    expect(tabs[0].querySelector('.close')).not.toBeNull();
  });
  it('hides the close button when only one tab', () => {
    const app = makeApp();
    renderTabs(app);
    expect(app.dom.qtabsInner.querySelector('.close')).toBeNull();
  });
  it('clicking a tab selects it; clicking close closes it', () => {
    const app = makeApp();
    app.state.tabs.value = [{ id: 't1', name: 'A' }, { id: 't2', name: 'B' }];
    renderTabs(app);
    const second = app.dom.qtabsInner.querySelectorAll('.qtab')[1];
    second.dispatchEvent(new Event('click'));
    expect(app.state.activeTabId.value).toBe('t2');
    const close = app.dom.qtabsInner.querySelectorAll('.qtab')[0].querySelector('.close');
    close.dispatchEvent(new Event('click', { bubbles: true }));
    expect(app.state.tabs.value.map((t) => t.id)).toEqual(['t2']);
  });
  it('opens a Filter tab badge directly in Spec at the role', () => {
    const app = makeApp();
    const tab = app.activeTab();
    app.specEditor.revealOffset = vi.fn();
    tab.specParsed.dashboard = { role: 'filter' };
    tab.specText = '{"dashboard":{"role":"filter"}}';
    renderTabs(app);
    app.dom.qtabsInner.querySelector('.query-role-badge').dispatchEvent(new Event('click', { bubbles: true }));
    expect(app.actions.setEditorMode).toHaveBeenCalledWith('spec');
    expect(app.specEditor.revealOffset).toHaveBeenCalledWith(tab.specText.indexOf('"role"'));
  });
});

// tabs.js is now pure state-mutation over the tab signals; the repaint on a tab
// change (renderTabs + editorSync + results + Save button) is the createApp()
// effect's job and is covered in app.test.js — not here.
describe('selectTab', () => {
  it('switches the active tab', () => {
    const app = makeApp();
    app.state.tabs.value = [...app.state.tabs.value, { id: 't2', name: 'B' }];
    selectTab(app, 't2');
    expect(app.state.activeTabId.value).toBe('t2');
  });
  it('no-ops if already active (early-return guard)', () => {
    const app = makeApp();
    selectTab(app, 't1');
    expect(app.state.activeTabId.value).toBe('t1');
  });
});

describe('newTab / loadIntoNewTab', () => {
  it('newTab appends a blank tab + focuses', () => {
    const app = makeApp();
    app.sqlEditor.focus = vi.fn(); // tabs.js focuses through the port (#143)
    newTab(app);
    expect(app.state.tabs.value).toHaveLength(2);
    expect(app.activeTab().name).toBe('Untitled');
    expect(app.sqlEditor.focus).toHaveBeenCalled();
  });
  it('loadIntoNewTab seeds name + sql, links savedId, and focuses the editor', () => {
    const app = makeApp();
    app.sqlEditor.focus = vi.fn();
    loadIntoNewTab(app, savedQuery({ id: 's1', name: 'Saved', sql: 'SELECT 1' }));
    expect(app.activeTab()).toMatchObject({ name: 'Saved', sqlDraft: 'SELECT 1', savedId: 's1', editorMode: 'sql' });
    expect(tabPanel(app.activeTab())).toBeNull();
    expect(app.sqlEditor.focus).toHaveBeenCalled();
  });
  it('loadIntoNewTab restores a chart payload (cfg cloned, key set)', () => {
    const app = makeApp();
    const chart = { cfg: { type: 'pie', x: 0, y: [1], series: null }, key: 'a:String|b:UInt64' };
    loadIntoNewTab(app, savedQuery({ id: 's1', name: 'Saved', sql: 'SELECT 1', panel: chart }));
    const tab = app.activeTab();
    expect(tabPanel(tab)).toEqual(chart);
    expect(tabPanel(tab)).not.toBe(chart); // cloned, not aliased into the saved entry
  });
  it('loadIntoNewTab defaults the name and leaves savedId null (history restore)', () => {
    const app = makeApp();
    loadIntoNewTab(app, '', 'SELECT 2');
    expect(app.activeTab().name).toBe('Untitled');
    expect(app.activeTab().savedId).toBeNull();
  });
  it('activates an already-open savedId without replacing either draft', () => {
    const app = makeApp();
    const query = savedQuery({ id: 's1', name: 'Saved', sql: 'SELECT committed' });
    const first = loadIntoNewTab(app, query);
    first.sqlDraft = 'SELECT unsaved'; first.specText = '{ invalid'; first.dirtySpec = true;
    newTab(app);
    const reopened = loadIntoNewTab(app, query);
    expect(reopened).toBe(first);
    expect(app.activeTab()).toBe(first);
    expect(first.sqlDraft).toBe('SELECT unsaved');
    expect(first.specText).toBe('{ invalid');
    expect(app.state.tabs.value).toHaveLength(3);
  });
});

describe('closeTab', () => {
  it('refuses to close the last tab', () => {
    const app = makeApp();
    closeTab(app, 't1');
    expect(app.state.tabs.value).toHaveLength(1);
  });
  it('closes a non-active tab', () => {
    const app = makeApp();
    app.state.tabs.value = [{ id: 't1', name: 'A' }, { id: 't2', name: 'B' }];
    app.state.activeTabId.value = 't1';
    closeTab(app, 't2');
    expect(app.state.tabs.value.map((t) => t.id)).toEqual(['t1']);
    expect(app.state.activeTabId.value).toBe('t1');
  });
  it('closing the active tab re-selects the previous neighbour', () => {
    const app = makeApp();
    app.state.tabs.value = [{ id: 't1', name: 'A' }, { id: 't2', name: 'B' }, { id: 't3', name: 'C' }];
    app.state.activeTabId.value = 't2';
    closeTab(app, 't2');
    expect(app.state.activeTabId.value).toBe('t1');
  });
});
