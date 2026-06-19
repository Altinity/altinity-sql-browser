// The bottom sidebar pane: a Saved / History switcher and the two lists.

import { h } from './dom.js';
import { Icon } from './icons.js';
import { timeAgo } from '../core/format.js';
import { deleteSaved, deleteHistory, clearHistory } from '../state.js';

export function renderSavedHistory(app) {
  const tabsRow = app.dom.savedTabsRow;
  const list = app.dom.savedList;
  if (!tabsRow || !list) return;
  const state = app.state;

  tabsRow.replaceChildren(
    h('button', {
      class: 'side-tab' + (state.sidePanel === 'saved' ? ' active' : ''),
      onclick: () => { state.sidePanel = 'saved'; app.savePref('sidePanel', 'saved'); renderSavedHistory(app); },
    }, Icon.star(state.sidePanel === 'saved'), h('span', null, 'Saved')),
    h('button', {
      class: 'side-tab' + (state.sidePanel === 'history' ? ' active' : ''),
      onclick: () => { state.sidePanel = 'history'; app.savePref('sidePanel', 'history'); renderSavedHistory(app); },
    }, Icon.history(), h('span', null, 'History')),
  );

  list.replaceChildren();
  if (state.sidePanel === 'saved') return renderSaved(app, list);
  return renderHistory(app, list);
}

function renderSaved(app, list) {
  const state = app.state;
  if (state.savedQueries.length === 0) {
    list.appendChild(h('div', { class: 'saved-empty' },
      'No saved queries yet.', h('br'), 'Click ', Icon.star(true), ' next to Run to save.'));
    return;
  }
  for (const q of state.savedQueries) {
    list.appendChild(h('div', { class: 'saved-row', onclick: () => app.actions.loadIntoNewTab(q.name, q.sql) },
      h('div', { class: 'top' },
        h('span', { class: 'star' }, Icon.star(true)),
        h('span', { class: 'name' }, q.name),
        h('button', {
          class: 'del', title: 'Delete',
          onclick: (e) => { e.stopPropagation(); deleteSaved(state, q.id, app.saveJSON); app.actions.updateStar(); renderSavedHistory(app); },
        }, Icon.close())),
      h('div', { class: 'preview' }, q.sql.split('\n')[0])));
  }
}

function renderHistory(app, list) {
  const state = app.state;
  if (state.history.length === 0) {
    list.appendChild(h('div', { class: 'saved-empty' }, 'No history yet.'));
    return;
  }
  list.appendChild(h('div', { class: 'list-head' },
    h('button', {
      class: 'clear-btn', title: 'Clear all history',
      onclick: () => { clearHistory(state, app.saveJSON); renderSavedHistory(app); },
    }, 'Clear history')));
  for (const ent of state.history) {
    list.appendChild(h('div', { class: 'history-row', onclick: () => app.actions.loadIntoNewTab('From history', ent.sql) },
      h('button', {
        class: 'del', title: 'Delete',
        onclick: (e) => { e.stopPropagation(); deleteHistory(state, ent.id, app.saveJSON); renderSavedHistory(app); },
      }, Icon.close()),
      h('div', { class: 'sql' }, ent.sql),
      h('div', { class: 'meta' },
        h('span', null, timeAgo(ent.ts)),
        ent.rows != null ? h('span', null, ent.rows + ' rows') : null,
        h('span', null, ent.ms + ' ms'))));
  }
}
