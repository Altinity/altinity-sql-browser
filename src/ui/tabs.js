// Query tab strip + tab lifecycle (select / new / close). The lifecycle
// operations are pure over state; `renderTabs` paints the strip.

import { h } from './dom.js';
import { Icon } from './icons.js';
import { activeTab, allocTabId, newTabObj } from '../state.js';
import { cloneChartCfg } from '../core/chart-data.js';

/** Paint the tab strip into app.dom.qtabsInner. */
export function renderTabs(app) {
  const host = app.dom.qtabsInner;
  if (!host) return;
  host.replaceChildren(...app.state.tabs.map((t) => {
    const isActive = t.id === app.state.activeTabId;
    return h('div', { class: 'qtab' + (isActive ? ' active' : ''), onclick: () => selectTab(app, t.id) },
      h('span', { class: 'name' }, t.name),
      t.dirty ? h('span', { class: 'dirty' }) : null,
      app.state.tabs.length > 1
        ? h('button', {
            class: 'close',
            onclick: (e) => { e.stopPropagation(); closeTab(app, t.id); },
          }, Icon.close())
        : null,
    );
  }));
}

function refresh(app) {
  renderTabs(app);
  if (app.dom.editorSync) app.dom.editorSync();
  app.actions.rerenderResults();
  app.actions.updateSaveBtn();
}

/** Switch the active tab (no-op if already active). */
export function selectTab(app, id) {
  if (id === app.state.activeTabId) return;
  app.state.activeTabId = id;
  refresh(app);
}

/** Open a new blank tab and focus the editor. */
export function newTab(app) {
  const id = allocTabId(app.state);
  app.state.tabs.push(newTabObj(id));
  app.state.activeTabId = id;
  refresh(app);
  if (app.dom.editorTextarea) app.dom.editorTextarea.focus();
}

/**
 * Open a tab pre-seeded with `name`/`sql` (used by saved/history). `savedId`
 * links it to a saved query so the Save button reads "Saved" (restoring a saved
 * query); omit it for history entries, which aren't saved. `chart` is the saved
 * chart config `{ cfg, key }`, cloned onto the tab. (The result view is a global
 * setting restored via `run({ view })` by the caller, since `run` resets it.)
 */
export function loadIntoNewTab(app, name, sql, savedId = null, chart = null) {
  const id = allocTabId(app.state);
  const tab = newTabObj(id);
  tab.name = name || 'Untitled';
  tab.sql = sql;
  tab.savedId = savedId;
  if (chart && chart.cfg) {
    tab.chartCfg = cloneChartCfg(chart.cfg);
    tab.chartKey = chart.key ?? null;
  }
  app.state.tabs.push(tab);
  app.state.activeTabId = id;
  refresh(app);
  if (app.dom.editorTextarea) app.dom.editorTextarea.focus();
}

/** Close a tab (never the last one), re-selecting a neighbour if needed. */
export function closeTab(app, id) {
  if (app.state.tabs.length <= 1) return;
  const idx = app.state.tabs.findIndex((t) => t.id === id);
  app.state.tabs.splice(idx, 1);
  if (id === app.state.activeTabId) {
    app.state.activeTabId = app.state.tabs[Math.max(0, idx - 1)].id;
  }
  refresh(app);
}

export { activeTab };
