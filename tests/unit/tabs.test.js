import { describe, it, expect, vi } from 'vitest';
import { renderTabs, selectTab, newTab, closeTab, loadIntoNewTab } from '../../src/ui/tabs.js';
import { makeApp } from '../helpers/fake-app.js';

describe('renderTabs', () => {
  it('no-ops without a mount point', () => {
    const app = makeApp();
    app.dom.qtabsInner = null;
    expect(() => renderTabs(app)).not.toThrow();
  });
  it('marks the active tab, shows dirty dot, and a close button only with >1 tab', () => {
    const app = makeApp();
    app.state.tabs.value = [
      { id: 't1', name: 'A', dirty: true },
      { id: 't2', name: 'B', dirty: false },
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
    app.dom.editorTextarea = { focus: vi.fn() };
    newTab(app);
    expect(app.state.tabs.value).toHaveLength(2);
    expect(app.activeTab().name).toBe('Untitled');
    expect(app.dom.editorTextarea.focus).toHaveBeenCalled();
  });
  it('loadIntoNewTab seeds name + sql, links savedId, and focuses the editor', () => {
    const app = makeApp();
    app.dom.editorTextarea = { focus: vi.fn() };
    loadIntoNewTab(app, 'Saved', 'SELECT 1', 's1');
    expect(app.activeTab()).toMatchObject({ name: 'Saved', sql: 'SELECT 1', savedId: 's1' });
    expect(app.activeTab().chartCfg).toBeNull(); // no chart payload → stays null
    expect(app.dom.editorTextarea.focus).toHaveBeenCalled();
  });
  it('loadIntoNewTab restores a chart payload (cfg cloned, key set)', () => {
    const app = makeApp();
    const chart = { cfg: { type: 'pie', x: 0, y: [1], series: null }, key: 'a:String|b:UInt64' };
    loadIntoNewTab(app, 'Saved', 'SELECT 1', 's1', chart);
    const tab = app.activeTab();
    expect(tab.chartCfg).toEqual(chart.cfg);
    expect(tab.chartCfg).not.toBe(chart.cfg); // cloned, not aliased into the saved entry
    expect(tab.chartKey).toBe(chart.key);
  });
  it('loadIntoNewTab defaults the name and leaves savedId null (history restore)', () => {
    const app = makeApp();
    loadIntoNewTab(app, '', 'SELECT 2');
    expect(app.activeTab().name).toBe('Untitled');
    expect(app.activeTab().savedId).toBeNull();
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
