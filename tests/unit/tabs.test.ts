import { describe, it, expect, vi } from 'vitest';
import {
  renderTabs, selectTab, newTab, closeTab, loadIntoNewTab, openVariableTab, reconcileVariableTab,
} from '../../src/ui/tabs.js';
import { tabPanel, variableDoc } from '../../src/state.js';
import type { QueryTab } from '../../src/state.js';
import { makeApp } from '../helpers/fake-app.js';
import { savedQuery } from '../helpers/saved-query.js';
import type { SavedQueryFixture } from '../helpers/saved-query.js';

const qs = <T extends Element = Element>(root: ParentNode, selector: string): T => root.querySelector(selector) as T;

// `loadIntoNewTab`'s own `QueryOrName` (tabs.ts) is `string | Record<string,
// unknown>` — looser than `savedQuery`'s real `SavedQueryV2` return (no index
// signature), so this suite's fixtures still go through a thin wrapper.
// Widening the PARAMETER to `object` first (same convention as app.test.ts's
// `asWindow`/`asClipboard`) makes the cast a genuine single-level one, not an
// `unknown` bridge.
const asRecord = (v: object): Record<string, unknown> => v as Record<string, unknown>;
const sq = (over: SavedQueryFixture): Record<string, unknown> => asRecord(savedQuery(over));

describe('renderTabs', () => {
  it('no-ops without a mount point', () => {
    const app = makeApp();
    // A partial-dom fixture for the no-mount-point guard: `dom.qtabsInner` is
    // narrowed to nullable only for this one assignment (its real type,
    // AppDom.qtabsInner, is optional — a real app can omit it too).
    (app.dom as { qtabsInner: HTMLElement | null }).qtabsInner = null;
    expect(() => renderTabs(app)).not.toThrow();
  });
  it('marks the active tab, shows dirty dot, and a close button only with >1 tab', () => {
    const app = makeApp();
    app.state.tabs.value = [
      { id: 't1', name: 'A', dirtySql: true, dirtySpec: false } as QueryTab,
      { id: 't2', name: 'B', dirtySql: false, dirtySpec: false } as QueryTab,
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
  it('shows an external-change badge for conflict and deleted tabs (#343)', () => {
    const app = makeApp();
    app.state.tabs.value = [
      { id: 't1', name: 'A', dirtySql: true, dirtySpec: false, externalState: 'conflict' } as QueryTab,
      { id: 't2', name: 'B', dirtySql: true, dirtySpec: false, externalState: 'deleted' } as QueryTab,
      { id: 't3', name: 'C', dirtySql: false, dirtySpec: false } as QueryTab,
    ];
    renderTabs(app);
    const tabs = app.dom.qtabsInner.querySelectorAll('.qtab');
    const b1 = tabs[0].querySelector('.qtab-external') as HTMLElement;
    expect(b1.classList.contains('conflict')).toBe(true);
    expect(b1.title).toContain('changed in another tab');
    const b2 = tabs[1].querySelector('.qtab-external') as HTMLElement;
    expect(b2.classList.contains('deleted')).toBe(true);
    expect(b2.title).toContain('deleted in another tab');
    expect(tabs[2].querySelector('.qtab-external')).toBeNull(); // normal tab: no badge
  });
  it('clicking a tab selects it; clicking close closes it', () => {
    const app = makeApp();
    app.state.tabs.value = [{ id: 't1', name: 'A' } as QueryTab, { id: 't2', name: 'B' } as QueryTab];
    renderTabs(app);
    const second = app.dom.qtabsInner.querySelectorAll('.qtab')[1];
    second.dispatchEvent(new Event('click'));
    expect(app.state.activeTabId.value).toBe('t2');
    const close = qs<HTMLElement>(app.dom.qtabsInner.querySelectorAll('.qtab')[0], '.close');
    close.dispatchEvent(new Event('click', { bubbles: true }));
    expect(app.state.tabs.value.map((t) => t.id)).toEqual(['t2']);
  });
  // #447 deleted the Filter tab badge case: `filter` is no longer a
  // saved-query role, so no tab can carry one.
});

// tabs.js is now pure state-mutation over the tab signals; the repaint on a tab
// change (renderTabs + editorSync + results + Save button) is the createApp()
// effect's job and is covered in app.test.js — not here.
describe('selectTab', () => {
  it('switches the active tab', () => {
    const app = makeApp();
    app.state.tabs.value = [...app.state.tabs.value, { id: 't2', name: 'B' } as QueryTab];
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
    loadIntoNewTab(app, sq({ id: 's1', name: 'Saved', sql: 'SELECT 1' }));
    expect(app.activeTab()).toMatchObject({ name: 'Saved', sqlDraft: 'SELECT 1', savedId: 's1', editorMode: 'sql' });
    expect(tabPanel(app.activeTab())).toBeNull();
    expect(app.sqlEditor.focus).toHaveBeenCalled();
  });
  it('loadIntoNewTab restores a chart payload (cfg cloned, key set)', () => {
    const app = makeApp();
    const chart = { cfg: { type: 'pie', x: 0, y: [1], series: null }, key: 'a:String|b:UInt64' };
    loadIntoNewTab(app, sq({ id: 's1', name: 'Saved', sql: 'SELECT 1', panel: chart }));
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
  it('loadIntoNewTab of an id-less query object stays unlinked with no baseline token (#343)', () => {
    const app = makeApp();
    loadIntoNewTab(app, { name: 'NoId', sql: 'SELECT x' });
    expect(app.activeTab().savedId).toBeNull();
    expect(app.activeTab().lastCommittedQueryToken).toBeUndefined();
  });
  it('activates an already-open savedId without replacing either draft', () => {
    const app = makeApp();
    const query = sq({ id: 's1', name: 'Saved', sql: 'SELECT committed' });
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
    app.state.tabs.value = [{ id: 't1', name: 'A' } as QueryTab, { id: 't2', name: 'B' } as QueryTab];
    app.state.activeTabId.value = 't1';
    closeTab(app, 't2');
    expect(app.state.tabs.value.map((t) => t.id)).toEqual(['t1']);
    expect(app.state.activeTabId.value).toBe('t1');
  });
  it('closing the active tab re-selects the previous neighbour', () => {
    const app = makeApp();
    app.state.tabs.value = [{ id: 't1', name: 'A' } as QueryTab, { id: 't2', name: 'B' } as QueryTab, { id: 't3', name: 'C' } as QueryTab];
    app.state.activeTabId.value = 't2';
    closeTab(app, 't2');
    expect(app.state.activeTabId.value).toBe('t1');
  });
});

// #457 — the variable document, opened into the SAME tab strip and the SAME
// editor a query uses. What matters here is identity and non-destructiveness:
// a variable is addressed by (dashboardId, variableName) and nothing else, and
// opening one must never disturb work already open.
describe('openVariableTab', () => {
  const bind = (dashboardId: string, variableName: string) => ({ dashboardId, variableName });

  it('opens a new tab titled for the variable, on its committed SQL', () => {
    const app = makeApp();
    app.sqlEditor.focus = vi.fn(); // tabs.ts focuses through the port (#143)
    const tab = openVariableTab(app, bind('sales', 'zone'), 'SELECT z, z FROM zones');

    expect(tab.name).toBe('Variable: zone');
    expect(tab.sqlDraft).toBe('SELECT z, z FROM zones');
    expect(variableDoc(tab))
      .toEqual({ kind: 'dashboard-variable', dashboardId: 'sales', variableName: 'zone' });
    expect(app.state.activeTabId.value).toBe(tab.id);
    expect(app.sqlEditor.focus).toHaveBeenCalled();
  });

  it('is NOT a saved query: no savedId, and the Library is left exactly as it was', () => {
    const app = makeApp();
    // Seeded, so "the Library did not change" is a real assertion rather than one
    // that holds trivially on a fresh fixture.
    app.state.savedQueries = [sq({ id: 's1', name: 'Existing', sql: 'SELECT 1' })] as never;
    const before = app.state.savedQueries;

    const tab = openVariableTab(app, bind('sales', 'zone'), 'Z');

    expect(tab.savedId).toBeNull();
    expect(app.state.savedQueries).toBe(before);
    expect(app.state.savedQueries.map((q) => q.id)).toEqual(['s1']);
  });

  it('opens blank for a variable with no stored configuration, and is not dirty', () => {
    const app = makeApp();
    const tab = openVariableTab(app, bind('sales', 'fresh'), '');

    expect(tab.sqlDraft).toBe('');
    // Committed truth just loaded — the user has not typed anything yet.
    expect(tab.dirtySql).toBe(false);
    expect(tab.dirtySpec).toBe(false);
  });

  it('carries the tab name into the Spec draft, so nothing reads it as Untitled', () => {
    // Same treatment `loadIntoNewTab` gives an unsaved document — a share link or
    // a result-source header then says what this document actually is.
    const app = makeApp();
    const tab = openVariableTab(app, bind('sales', 'zone'), 'Z');

    expect((tab.specParsed as { name?: string }).name).toBe('Variable: zone');
  });

  it('re-opening the SAME variable selects the existing tab instead of duplicating it', () => {
    const app = makeApp();
    app.sqlEditor.focus = vi.fn();
    const first = openVariableTab(app, bind('sales', 'zone'), 'Z');
    // A local edit the user has not saved yet must survive the re-open.
    first.sqlDraft = 'SELECT edited';
    first.dirtySql = true;
    app.state.activeTabId.value = 't1';

    const again = openVariableTab(app, bind('sales', 'zone'), 'Z');

    expect(again).toBe(first);
    expect(again.sqlDraft).toBe('SELECT edited');
    expect(again.dirtySql).toBe(true);
    expect(app.state.tabs.value.filter((t) => variableDoc(t) !== null)).toHaveLength(1);
    expect(app.state.activeTabId.value).toBe(first.id);
    expect(app.sqlEditor.focus).toHaveBeenCalled();
  });

  it('re-opening a CLEAN tab adopts committed truth, so a stale document is never kept', () => {
    // Nothing reconciles a variable tab against a configuration changed elsewhere
    // (no `savedId`, so #343's classifier skips it), and the tree's trash can
    // delete the very configuration an open tab is showing. Re-clicking the row
    // used to return a tab still displaying SQL that no longer exists, labelled
    // "Saved", one Save away from recreating it.
    const app = makeApp();
    const first = openVariableTab(app, bind('sales', 'zone'), 'SELECT old');
    expect(first.dirtySql).toBe(false);

    const again = openVariableTab(app, bind('sales', 'zone'), '');

    expect(again).toBe(first);
    expect(again.sqlDraft).toBe('');
    expect(app.state.tabs.value.filter((t) => variableDoc(t) !== null)).toHaveLength(1);
  });

  it('re-opening a DIRTY tab never overwrites the draft — it is the only copy', () => {
    const app = makeApp();
    const first = openVariableTab(app, bind('sales', 'zone'), 'SELECT old');
    first.sqlDraft = 'SELECT mine';
    first.dirtySql = true;

    const again = openVariableTab(app, bind('sales', 'zone'), 'SELECT changed elsewhere');

    expect(again.sqlDraft).toBe('SELECT mine');
    expect(again.dirtySql).toBe(true);
  });

  it('re-opening a clean tab whose SQL is UNCHANGED leaves it entirely alone', () => {
    const app = makeApp();
    const first = openVariableTab(app, bind('sales', 'zone'), 'SELECT same');
    const before = app.state.tabs.value;

    const again = openVariableTab(app, bind('sales', 'zone'), 'SELECT same');

    expect(again).toBe(first);
    expect(again.sqlDraft).toBe('SELECT same');
    // No pointless list-identity churn when there is nothing to adopt.
    expect(app.state.tabs.value).toBe(before);
  });

  it('gives the same variable NAME in two Dashboards two distinct tabs', () => {
    const app = makeApp();
    const sales = openVariableTab(app, bind('sales', 'zone'), 'SELECT sales');
    const ops = openVariableTab(app, bind('ops', 'zone'), 'SELECT ops');

    expect(ops.id).not.toBe(sales.id);
    expect(sales.sqlDraft).toBe('SELECT sales');
    expect(ops.sqlDraft).toBe('SELECT ops');
    expect(app.state.tabs.value.filter((t) => variableDoc(t) !== null)).toHaveLength(2);
  });

  it('preserves every already-open tab and its unsaved draft', () => {
    const app = makeApp();
    const existing = app.state.tabs.value[0];
    existing.sqlDraft = 'SELECT untouched';
    existing.dirtySql = true;

    openVariableTab(app, bind('sales', 'zone'), 'Z');

    expect(app.state.tabs.value).toHaveLength(2);
    expect(app.state.tabs.value[0]).toBe(existing);
    expect(existing.sqlDraft).toBe('SELECT untouched');
    expect(existing.dirtySql).toBe(true);
  });

  it('paints its title in the strip like any other tab', () => {
    const app = makeApp();
    openVariableTab(app, bind('sales', 'zone'), 'Z');
    renderTabs(app);

    expect([...app.dom.qtabsInner!.querySelectorAll('.qtab .name')].map((n) => n.textContent))
      .toEqual(['Untitled', 'Variable: zone']);
  });
});

describe('reconcileVariableTab (#428)', () => {
  /** An open, clean variable tab on `sql`, with a second tab active. */
  const withVariableTab = (sql: string) => {
    const app = makeApp();
    app.sqlEditor.focus = vi.fn();
    const tab = openVariableTab(app, { dashboardId: 'sales', variableName: 'zone' }, sql);
    // Park the selection somewhere else so "did it navigate?" is observable.
    newTab(app);
    const otherId = app.state.activeTabId.value;
    app.sqlEditor.focus = vi.fn();
    return { app, tab, otherId };
  };

  it('adopts newly committed SQL without selecting the tab or focusing the editor', () => {
    const { app, tab, otherId } = withVariableTab('SELECT old');

    expect(reconcileVariableTab(app, 'sales', 'zone', 'SELECT new')).toBe(true);
    expect(tab.sqlDraft).toBe('SELECT new');
    // #428: a successful drop must not switch to the Query surface.
    expect(app.state.activeTabId.value).toBe(otherId);
    expect(app.sqlEditor.focus).not.toHaveBeenCalled();
  });

  it('pokes the tabs signal, or the editor keeps painting the stale document', () => {
    const { app } = withVariableTab('SELECT old');
    const before = app.state.tabs.value;

    reconcileVariableTab(app, 'sales', 'zone', 'SELECT new');
    expect(app.state.tabs.value).not.toBe(before);
    expect(app.state.tabs.value).toHaveLength(before.length);
  });

  it('leaves a DIRTY tab alone — the draft is the user\'s only copy', () => {
    const { app, tab } = withVariableTab('SELECT old');
    tab.dirtySql = true;

    expect(reconcileVariableTab(app, 'sales', 'zone', 'SELECT new')).toBe(false);
    expect(tab.sqlDraft).toBe('SELECT old');
  });

  it('does nothing when the committed SQL already matches', () => {
    const { app } = withVariableTab('SELECT same');
    const before = app.state.tabs.value;

    expect(reconcileVariableTab(app, 'sales', 'zone', 'SELECT same')).toBe(false);
    expect(app.state.tabs.value).toBe(before);
  });

  it('does nothing when no tab edits that variable', () => {
    const { app } = withVariableTab('SELECT old');

    expect(reconcileVariableTab(app, 'sales', 'other', 'SELECT new')).toBe(false);
    // The same NAME under a different Dashboard is a different document.
    expect(reconcileVariableTab(app, 'ops', 'zone', 'SELECT new')).toBe(false);
  });
});
