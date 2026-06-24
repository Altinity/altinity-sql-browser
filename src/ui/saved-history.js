// The bottom sidebar pane: a Saved / History switcher and the two lists.
// Saved items support favorite (star), inline rename (pencil) and delete (trash).

import { h } from './dom.js';
import { Icon } from './icons.js';
import { timeAgo } from '../core/format.js';
import { sortedSaved, renameSaved, toggleFavorite, deleteSaved, deleteHistory } from '../state.js';

export function renderSavedHistory(app) {
  const tabsRow = app.dom.savedTabsRow;
  const list = app.dom.savedList;
  if (!tabsRow || !list) return;
  const state = app.state;
  const count = state.savedQueries.length;

  tabsRow.replaceChildren(
    h('button', {
      class: 'side-tab' + (state.sidePanel === 'saved' ? ' active' : ''),
      onclick: () => { state.sidePanel = 'saved'; app.savePref('sidePanel', 'saved'); renderSavedHistory(app); },
    }, Icon.star(state.sidePanel === 'saved'), h('span', null, 'Saved'),
      count ? h('span', { class: 'side-count' }, '· ' + count) : null),
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
      'No saved queries yet.', h('br'), 'Click ', Icon.bookmark(), ' Save next to Run.'));
  }
  for (const q of sortedSaved(state)) {
    if (app.editingSavedId === q.id) { list.appendChild(savedEditForm(app, q)); continue; }
    const star = h('button', {
      class: 'sv-star' + (q.favorite ? ' on' : ''), title: q.favorite ? 'Unfavorite' : 'Favorite',
      onclick: (e) => { e.stopPropagation(); toggleFavorite(state, q.id, app.saveJSON); renderSavedHistory(app); },
    }, Icon.star(q.favorite));

    const row = h('div', { class: 'saved-row', onclick: () => { app.actions.loadIntoNewTab(q.name, q.sql, q.id, q.chart); app.actions.run({ view: q.view }); } },
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
  list.appendChild(savedActions(app));
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

/** Export / Import row pinned at the bottom of the Saved panel. */
function savedActions(app) {
  const empty = app.state.savedQueries.length === 0;
  const fileInput = h('input', {
    type: 'file', accept: 'application/json,.json', style: { display: 'none' },
    onchange: (e) => { const f = e.target.files && e.target.files[0]; if (f) app.actions.importSavedFile(f); e.target.value = ''; },
  });
  return h('div', { class: 'saved-actions' },
    h('button', {
      class: 'sv-io', disabled: empty ? true : null, title: 'Download all saved queries as JSON',
      onclick: () => app.actions.exportSaved(),
    }, Icon.download(), h('span', null, 'Export')),
    h('button', {
      class: 'sv-io', title: 'Import saved queries from a JSON file',
      onclick: () => fileInput.click(),
    }, Icon.upload(), h('span', null, 'Import')),
    fileInput);
}

function renderHistory(app, list) {
  const state = app.state;
  if (state.history.length === 0) {
    list.appendChild(h('div', { class: 'saved-empty' }, 'No history yet.'));
    return;
  }
  for (const ent of state.history) {
    list.appendChild(h('div', { class: 'history-row', onclick: () => { app.actions.loadIntoNewTab('From history', ent.sql); app.actions.run(); } },
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
