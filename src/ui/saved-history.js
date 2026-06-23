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
    const editing = app.editingSavedId === q.id;
    const star = h('button', {
      class: 'sv-star' + (q.favorite ? ' on' : ''), title: q.favorite ? 'Unfavorite' : 'Favorite',
      onclick: (e) => { e.stopPropagation(); toggleFavorite(state, q.id, app.saveJSON); renderSavedHistory(app); },
    }, Icon.star(q.favorite));

    let nameEl;
    if (editing) {
      const input = h('input', { class: 'sv-edit', value: q.name });
      let done = false;
      // `commit` (Enter/blur) renames; `!commit` (Escape) cancels. The guard
      // stops the blur fired by the re-render teardown from undoing a cancel.
      const finish = (commit) => {
        if (done) return;
        done = true;
        if (commit && input.value.trim()) { renameSaved(state, q.id, input.value, app.saveJSON); app.actions.rerenderTabs(); }
        app.editingSavedId = null;
        renderSavedHistory(app);
      };
      input.addEventListener('click', (e) => e.stopPropagation());
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); finish(true); }
        else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
      });
      input.addEventListener('blur', () => finish(true));
      nameEl = input;
      setTimeout(() => { input.focus(); input.select(); });
    } else {
      nameEl = h('span', { class: 'name' }, q.name);
    }

    const row = h('div', { class: 'saved-row', onclick: () => { if (!editing) { app.actions.loadIntoNewTab(q.name, q.sql, q.id, q.chart); app.actions.run({ view: q.view }); } } },
      h('div', { class: 'top' },
        star,
        nameEl,
        editing ? null : h('button', {
          class: 'sv-act', title: 'Rename',
          onclick: (e) => { e.stopPropagation(); app.editingSavedId = q.id; renderSavedHistory(app); },
        }, Icon.pencil()),
        editing ? null : h('button', {
          class: 'sv-act', title: 'Delete',
          onclick: (e) => { e.stopPropagation(); deleteSaved(state, q.id, app.saveJSON); app.updateSaveBtn(); renderSavedHistory(app); },
        }, Icon.trash())),
      h('div', { class: 'preview' }, q.sql.split('\n')[0]));
    list.appendChild(row);
  }
  list.appendChild(savedActions(app));
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
