// Query tab strip + tab lifecycle (select / new / close). The lifecycle
// operations are pure over state; `renderTabs` paints the strip.

import { h } from './dom.js';
import { Icon } from './icons.js';
import { activeTab, allocTabId, newTabObj, setTabSpecDraft, tabDirty } from '../state.js';
import { cloneJson, queryName, upgradeSavedQuery } from '../core/saved-query.js';
import { batch } from '@preact/signals-core';
import { effectiveDashboardRole } from '../core/result-choice.js';

/**
 * The "Filter" role badge shown next to a tab name (tabs.js) or a Library row
 * (saved-history.js) — the one shared button both surfaces need so the label,
 * tooltip, and click affordance can't drift between them (CLAUDE.md rule 5:
 * extract on a second consumer). `onOpen()` does whatever surface-specific
 * work gets a tab active + its spec text, then this reveals the role field.
 */
export function filterRoleBadge(app, onOpen) {
  return h('button', {
    class: 'query-role-badge', title: 'Open Filter role in Spec',
    onclick: (event) => {
      event.stopPropagation();
      const tab = onOpen();
      app.actions.setEditorMode('spec');
      app.specEditor.revealOffset(tab.specText.indexOf('"role"'));
    },
  }, 'Filter');
}

/** Paint the tab strip into app.dom.qtabsInner. */
export function renderTabs(app) {
  const host = app.dom.qtabsInner;
  if (!host) return;
  host.replaceChildren(...app.state.tabs.value.map((t) => {
    const isActive = t.id === app.state.activeTabId.value;
    return h('div', { class: 'qtab' + (isActive ? ' active' : ''), onclick: () => selectTab(app, t.id) },
      h('span', { class: 'name' }, t.name),
      effectiveDashboardRole(t.specParsed) === 'filter'
        ? filterRoleBadge(app, () => { selectTab(app, t.id); return t; })
        : null,
      tabDirty(t) ? h('span', { class: 'dirty' }) : null,
      app.state.tabs.value.length > 1
        ? h('button', {
            class: 'close',
            onclick: (e) => { e.stopPropagation(); closeTab(app, t.id); },
          }, Icon.close())
        : null,
    );
  }));
}

// No refresh() any more: an effect wired in createApp() reads `tabs`/`activeTabId`
// and repaints the strip + editor + results + Save button, so these operations
// just mutate the signals. `batch()` coalesces the two-signal updates (list +
// active) into a single repaint.

/** Switch the active tab (no-op if already active). */
export function selectTab(app, id) {
  if (id === app.state.activeTabId.value) return;
  app.state.activeTabId.value = id;
}

/** Open a new blank tab and focus the editor. */
export function newTab(app) {
  const id = allocTabId(app.state);
  batch(() => {
    app.state.tabs.value = [...app.state.tabs.value, newTabObj(id)];
    app.state.activeTabId.value = id;
  });
  app.sqlEditor.focus();
}

/**
 * Open a saved query (pass its canonical object) or an unsaved/history document
 * (pass name + sql). Saved tabs clone the COMPLETE Spec, so later panel edits,
 * sharing, and Save retain extensions rather than reconstructing known fields.
 */
export function loadIntoNewTab(app, queryOrName, sql = '') {
  if (queryOrName && typeof queryOrName === 'object' && queryOrName.id) {
    const existing = app.state.tabs.value.find((tab) => tab.savedId === queryOrName.id);
    if (existing) {
      app.state.activeTabId.value = existing.id;
      app.sqlEditor.focus();
      return existing;
    }
  }
  const id = allocTabId(app.state);
  const tab = newTabObj(id);
  if (queryOrName && typeof queryOrName === 'object') {
    const query = upgradeSavedQuery(queryOrName);
    tab.name = queryName(query);
    tab.sqlDraft = query.sql;
    tab.savedId = query.id || null;
    tab.specVersion = query.specVersion;
    setTabSpecDraft(tab, cloneJson(query.spec));
  } else {
    tab.name = queryOrName || 'Untitled';
    tab.sqlDraft = sql;
    setTabSpecDraft(tab, { ...tab.specParsed, name: tab.name });
  }
  batch(() => {
    app.state.tabs.value = [...app.state.tabs.value, tab];
    app.state.activeTabId.value = id;
  });
  app.sqlEditor.focus();
  return tab;
}

/** Close a tab (never the last one), re-selecting a neighbour if needed. */
export function closeTab(app, id) {
  if (app.state.tabs.value.length <= 1) return;
  const idx = app.state.tabs.value.findIndex((t) => t.id === id);
  batch(() => {
    app.state.tabs.value = app.state.tabs.value.filter((t) => t.id !== id);
    if (id === app.state.activeTabId.value) {
      app.state.activeTabId.value = app.state.tabs.value[Math.max(0, idx - 1)].id;
    }
  });
}

export { activeTab };
