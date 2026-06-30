// The bottom sidebar pane: a Saved / History switcher, a search box, and the
// two lists. Saved items support favorite (star), inline rename (pencil) and
// delete (trash). The search filters the active list (name/description/sql for
// Library, sql for History); it re-renders only the list so typing keeps focus.

import { h } from './dom.js';
import { Icon } from './icons.js';
import { timeAgo } from '../core/format.js';
import { SUBQUERY_MIME } from './editor.js';
import {
  sortedSaved, filterSaved, filterHistory, renameSaved, toggleFavorite, deleteSaved, deleteHistory,
} from '../state.js';

// Make a Library/History row draggable; dropping it on the editor inserts the
// query wrapped as a `( … )` subquery (see the editor's drop handler).
const dragProps = (sql) => ({
  draggable: 'true',
  ondragstart: (e) => e.dataTransfer.setData(SUBQUERY_MIME, sql),
});

export function renderSavedHistory(app) {
  const tabsRow = app.dom.savedTabsRow;
  const list = app.dom.savedList;
  if (!tabsRow || !list) return;
  const state = app.state;
  const count = state.savedQueries.length;

  // Switching panes clears the search so each tab starts unfiltered. Clear the
  // (plain) filter first, then set the sidePanel signal — its render effect runs
  // synchronously on assignment and must see the cleared filter. No manual
  // re-render call: the effect in createApp() repaints.
  const switchTo = (panel) => {
    state.libraryFilter = '';
    app.savePref('sidePanel', panel);
    state.sidePanel.value = panel;
  };

  tabsRow.replaceChildren(
    h('button', {
      class: 'side-tab' + (state.sidePanel.value === 'saved' ? ' active' : ''),
      onclick: () => switchTo('saved'),
    }, Icon.layers(), h('span', null, 'Library'),
      count ? h('span', { class: 'side-count' }, '· ' + count) : null),
    h('button', {
      class: 'side-tab' + (state.sidePanel.value === 'history' ? ' active' : ''),
      onclick: () => switchTo('history'),
    }, Icon.history(), h('span', null, 'History')),
  );

  renderSearch(app);
  renderList(app);
}

/** Re-render just the active list (called on every keystroke without rebuilding
 * the search input, so the caret/focus survive filtering). */
function renderList(app) {
  const list = app.dom.savedList;
  list.replaceChildren();
  if (app.state.sidePanel.value === 'saved') renderSaved(app, list);
  else renderHistory(app, list);
}

/**
 * Render the search box into `app.dom.savedSearch` (built once per full render;
 * a tab with no items shows nothing). Its `input` handler mutates
 * `state.libraryFilter` and re-renders only the list, so it stays focused.
 */
function renderSearch(app) {
  const box = app.dom.savedSearch;
  if (!box) return;
  const state = app.state;
  const hasItems = state.sidePanel.value === 'saved' ? state.savedQueries.length > 0 : state.history.length > 0;
  box.replaceChildren();
  if (!hasItems) return;

  const input = h('input', {
    class: 'sv-search-input', type: 'text',
    placeholder: state.sidePanel.value === 'saved' ? 'Search saved queries…' : 'Search history…',
    value: state.libraryFilter,
  });
  const clear = h('button', { class: 'sv-search-clear', title: 'Clear' }, Icon.close());
  const syncClear = () => { clear.style.display = input.value ? '' : 'none'; };
  const setFilter = (v) => { input.value = v; state.libraryFilter = v; syncClear(); renderList(app); };

  input.addEventListener('input', () => { state.libraryFilter = input.value; syncClear(); renderList(app); });
  input.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); setFilter(''); } });
  clear.addEventListener('click', () => { setFilter(''); input.focus(); });
  syncClear();

  box.append(h('span', { class: 'sv-search-icon' }, Icon.search()), input, clear);
}

function renderSaved(app, list) {
  const state = app.state;
  if (state.savedQueries.length === 0) {
    list.appendChild(h('div', { class: 'saved-empty' },
      'No saved queries yet.', h('br'), 'Click ', Icon.bookmark(), ' Save next to Run.'));
    return;
  }
  const items = filterSaved(sortedSaved(state), state.libraryFilter);
  if (items.length === 0) {
    list.appendChild(h('div', { class: 'saved-empty' }, 'No queries match “' + state.libraryFilter.trim() + '”.'));
    return;
  }
  for (const q of items) {
    if (app.editingSavedId === q.id) { list.appendChild(savedEditForm(app, q)); continue; }
    const star = h('button', {
      class: 'sv-star' + (q.favorite ? ' on' : ''), title: q.favorite ? 'Unfavorite' : 'Favorite',
      onclick: (e) => { e.stopPropagation(); toggleFavorite(state, q.id, app.saveJSON); renderSavedHistory(app); },
    }, Icon.star(q.favorite));

    const row = h('div', { class: 'saved-row', ...dragProps(q.sql), onclick: () => { app.actions.loadIntoNewTab(q.name, q.sql, q.id, q.chart); app.actions.run({ view: q.view }); } },
      h('div', { class: 'top' },
        star,
        h('span', { class: 'name' }, q.name),
        h('button', {
          class: 'sv-act', title: 'Edit name & description',
          onclick: (e) => { e.stopPropagation(); app.editingSavedId = q.id; renderSavedHistory(app); },
        }, Icon.pencil()),
        h('button', {
          class: 'sv-act', title: 'Delete',
          onclick: (e) => { e.stopPropagation(); deleteSaved(state, q.id, app.saveJSON); app.updateSaveBtn(); renderSavedHistory(app); },
        }, Icon.trash())),
      q.description ? h('div', { class: 'desc' }, q.description) : null,
      h('div', { class: 'preview' }, q.sql.split('\n')[0]));
    list.appendChild(row);
  }
}

/**
 * The expanded "edit name & description" form shown in place of a saved row
 * while `app.editingSavedId === q.id`. The Name field commits on Enter, the
 * Description field on ⌘/Ctrl+Enter (plain Enter inserts a newline); Escape or
 * Cancel reverts. Clicks inside the form don't load the query. A `done` guard
 * keeps the re-render teardown from double-firing the commit.
 */
function savedEditForm(app, q) {
  const state = app.state;
  const nameInput = h('input', { class: 'sv-edit-name', value: q.name, placeholder: 'Query name' });
  const descInput = h('textarea', { class: 'sv-edit-desc', rows: '3', placeholder: 'What this query does (shown in Markdown export)' });
  descInput.value = q.description || '';
  let done = false;
  const finish = (commit) => {
    if (done) return;
    done = true;
    if (commit && nameInput.value.trim()) {
      renameSaved(state, q.id, nameInput.value, descInput.value, app.saveJSON);
      app.actions.rerenderTabs();
    }
    app.editingSavedId = null;
    renderSavedHistory(app);
  };
  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
  descInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
  setTimeout(() => { nameInput.focus(); nameInput.select(); });
  return h('div', { class: 'saved-edit', onclick: (e) => e.stopPropagation() },
    h('div', { class: 'sv-field' }, 'Name'),
    nameInput,
    h('div', { class: 'sv-field' }, 'Description'),
    descInput,
    h('div', { class: 'sv-edit-actions' },
      h('button', { class: 'sv-edit-cancel', onclick: () => finish(false) }, 'Cancel'),
      h('button', { class: 'sv-edit-save', onclick: () => finish(true) }, 'Save')));
}

function renderHistory(app, list) {
  const state = app.state;
  if (state.history.length === 0) {
    list.appendChild(h('div', { class: 'saved-empty' }, 'No history yet.'));
    return;
  }
  const items = filterHistory(state.history, state.libraryFilter);
  if (items.length === 0) {
    list.appendChild(h('div', { class: 'saved-empty' }, 'No history matches “' + state.libraryFilter.trim() + '”.'));
    return;
  }
  for (const ent of items) {
    list.appendChild(h('div', { class: 'history-row', ...dragProps(ent.sql), onclick: () => { app.actions.loadIntoNewTab('From history', ent.sql); app.actions.run(); } },
      h('button', {
        class: 'sv-act del', title: 'Delete',
        onclick: (e) => { e.stopPropagation(); deleteHistory(state, ent.id, app.saveJSON); renderSavedHistory(app); },
      }, Icon.trash()),
      h('div', { class: 'sql' }, ent.sql),
      h('div', { class: 'meta' },
        h('span', null, timeAgo(ent.ts)),
        ent.rows != null ? h('span', null, ent.rows + ' rows') : null,
        h('span', null, ent.ms + ' ms'))));
  }
}
