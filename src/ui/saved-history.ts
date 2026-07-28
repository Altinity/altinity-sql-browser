// The bottom sidebar pane: a Saved / History switcher, a search box, and the
// two lists. Saved items support favorite (star), inline rename (pencil) and
// delete (trash). The search filters the active list (name/description/sql for
// Library, sql for History); it re-renders only the list so typing keeps focus.

import { h } from './dom.js';
import { Icon } from './icons.js';
import { timeAgo } from '../core/format.js';
import { LIBRARY_QUERY_MIME, SUBQUERY_MIME } from './dnd-mime.js';
import { encodeLibraryQueryPayload } from '../core/library-drag.js';
import { beginLibraryDrag, endLibraryDrag } from './dashboard-tree.js';
import {
  sortedSaved, filterSaved, filterHistory, renameSaved, toggleFavorite, deleteSaved,
  deleteHistory, invalidSpecTabForSaved, SAVED_VIEWS,
} from '../state.js';
import type { AppState, HistoryEntry } from '../state.js';
import { flashToast } from './toast.js';
import { isAutoRunnable } from '../core/sql-split.js';
import { isQuerylessPanel } from '../core/panel-cfg.js';
import { queryDescription, queryFavorite, queryName, queryPanel, queryView } from '../core/saved-query.js';
import { libraryQueries } from '../dashboard/model/query-ownership.js';
import { openLibraryAssignMenu } from './library-assign-menu.js';
import type { App } from './app.types.js';
import type { SavedQueryV2 } from '../generated/json-schema.types.js';

/** The `resultView` signal's value union (state.ts) — `launchView`/`'panel'`
 *  below are proven members of it (SAVED_VIEWS membership, or the queryless
 *  branch that only ever assigns 'panel'), never an arbitrary string. */
type ResultView = AppState['resultView']['value'];

// Make a Library/History row draggable; dropping it on the editor inserts the
// query wrapped as a `( … )` subquery (see the editor's drop handler).
const dragProps = (sql: string): { draggable: string; ondragstart: (e: DragEvent) => void } => ({
  draggable: 'true',
  ondragstart: (e: DragEvent) => e.dataTransfer!.setData(SUBQUERY_MIME, sql),
});

/**
 * A LIBRARY row's drag: the same subquery payload as above, PLUS the stable
 * identity Dashboard destinations read (#428). One gesture, two independent
 * payloads, two readers that never see each other's (`ui/dnd-mime.ts`).
 *
 * The subquery payload is written FIRST and identically to `dragProps`, so the
 * shipped editor drop (PR #40) is bit-for-bit unaffected by the addition.
 *
 * `dragstart`/`dragend` also bracket the Dashboard tree's eligible-target
 * highlight. That is a class on the tree's own list element rather than app
 * state, so starting a drag repaints nothing — a repaint mid-drag would
 * `replaceChildren()` the row under the pointer and strand the drop bookkeeping.
 *
 * There is deliberately no "suppress the row's click while dragging" flag: a
 * native HTML5 drag emits no `click`, so such a guard would be a branch no test
 * could reach. `saved-history.test.ts` proves the absence instead.
 */
const libraryDragProps = (app: App, query: SavedQueryV2): {
  draggable: string;
  ondragstart: (e: DragEvent) => void;
  ondragend: () => void;
} => ({
  draggable: 'true',
  ondragstart: (e: DragEvent) => {
    e.dataTransfer!.setData(SUBQUERY_MIME, query.sql);
    const workspaceId = app.currentWorkspace?.id;
    // No aggregate committed yet (a fresh boot, or a degraded route) means there
    // is no Dashboard to assign to and no workspace id to scope the identity by,
    // so the row drags as text only.
    if (workspaceId !== undefined) {
      e.dataTransfer!.setData(LIBRARY_QUERY_MIME, encodeLibraryQueryPayload({
        kind: 'library-query', workspaceId, queryId: query.id,
      }));
      beginLibraryDrag(app);
    }
  },
  // Fires for a completed drop AND for every cancellation — including Escape,
  // which the browser swallows during a drag rather than delivering as a
  // keydown. One handler is therefore the whole teardown.
  ondragend: () => endLibraryDrag(app),
});

/**
 * The LIBRARY projection (#427): the saved queries no Dashboard member
 * references, in `workspace.queries[]` order.
 *
 * Read from `app.currentWorkspace`, which carries the WHOLE Dashboard
 * collection — `state.dashboard` is only the single compatibility document, and
 * a query owned by any other Dashboard must not show up here either. With no
 * workspace aggregate yet (a fresh boot, or a degraded route), every saved query
 * is a Library query: there are no Dashboards to own one.
 *
 * Owned copies stay serialized and stay openable by id from #426's Dashboard
 * tree — `app.openSavedQuery` resolves against the full `state.savedQueries`,
 * never this projection.
 */
function libraryEntries(app: App): SavedQueryV2[] {
  const workspace = app.currentWorkspace;
  if (!workspace) return app.state.savedQueries;
  const libraryIds = new Set(
    libraryQueries({ queries: app.state.savedQueries, dashboards: workspace.dashboards })
      .map((query) => query.id),
  );
  return app.state.savedQueries.filter((query) => libraryIds.has(query.id));
}

export function renderSavedHistory(app: App): void {
  const tabsRow = app.dom.savedTabsRow;
  const list = app.dom.savedList;
  if (!tabsRow || !list) return;
  const state = app.state;
  // #427: the count is the LIBRARY count, not every stored query — the owned
  // copies are reachable through the Dashboard tree, not through this list.
  const count = libraryEntries(app).length;

  // Switching panes clears the search so each tab starts unfiltered. Clear the
  // (plain) filter first, then set the sidePanel signal — its render effect runs
  // synchronously on assignment and must see the cleared filter. No manual
  // re-render call: the effect in createApp() repaints.
  const switchTo = (panel: string): void => {
    state.libraryFilter = '';
    app.prefs.save('sidePanel', panel);
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
function renderList(app: App): void {
  // `!`: every caller (renderSavedHistory, renderSearch below) only reaches
  // this after confirming `app.dom.savedList` is mounted.
  const list = app.dom.savedList!;
  list.replaceChildren();
  if (app.state.sidePanel.value === 'saved') renderSaved(app, list);
  else renderHistory(app, list);
}

/**
 * Render the search box into `app.dom.savedSearch` (built once per full render;
 * a tab with no items shows nothing). Its `input` handler mutates
 * `state.libraryFilter` and re-renders only the list, so it stays focused.
 */
function renderSearch(app: App): void {
  const box = app.dom.savedSearch;
  if (!box) return;
  const state = app.state;
  // Gated on the LIBRARY count (#427): a workspace whose every query is owned
  // has an empty list, so a search box over it would filter nothing.
  const hasItems = state.sidePanel.value === 'saved'
    ? libraryEntries(app).length > 0
    : state.history.length > 0;
  box.replaceChildren();
  if (!hasItems) return;

  const input = h('input', {
    class: 'sv-search-input', type: 'text',
    placeholder: state.sidePanel.value === 'saved' ? 'Search library queries…' : 'Search history…',
    value: state.libraryFilter,
  });
  const clear = h('button', { class: 'sv-search-clear', title: 'Clear' }, Icon.close());
  const syncClear = (): void => { clear.style.display = input.value ? '' : 'none'; };
  const setFilter = (v: string): void => { input.value = v; state.libraryFilter = v; syncClear(); renderList(app); };

  input.addEventListener('input', () => { state.libraryFilter = input.value; syncClear(); renderList(app); });
  input.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); setFilter(''); } });
  clear.addEventListener('click', () => { setFilter(''); input.focus(); });
  syncClear();

  box.append(h('span', { class: 'sv-search-icon' }, Icon.search()), input, clear);
}

function renderSaved(app: App, list: HTMLElement): void {
  const state = app.state;
  const surfaceGeneration = app.captureSurfaceGeneration();
  const library = libraryEntries(app);
  // Gated on the LIBRARY count too, so the empty state is reachable in a
  // workspace that HAS queries but has given every one of them to a Dashboard.
  if (library.length === 0) {
    list.appendChild(h('div', { class: 'saved-empty' },
      'No library queries yet.', h('br'), 'Click ', Icon.bookmark(), ' Save next to Run.'));
    return;
  }
  // Favourites first, then `workspace.queries[]` order — the projection filters,
  // it never reorders (#427).
  const items = filterSaved(sortedSaved({ ...state, savedQueries: library }), state.libraryFilter);
  if (items.length === 0) {
    list.appendChild(h('div', { class: 'saved-empty' }, 'No library queries match “' + state.libraryFilter.trim() + '”.'));
    return;
  }
  for (const q of items) {
    if (app.state.editingSavedId.value === q.id) { list.appendChild(savedEditForm(app, q)); continue; }
    const favorite = queryFavorite(q);
    const name = queryName(q);
    const description = queryDescription(q);
    const panel = queryPanel(q);
    // #447 removed the role-owned transient launch preview (#244): the Filter
    // role was its only owner, so a Library launch now simply restores the
    // query's own persisted view.
    const launchView = queryView(q);
    const star = h('button', {
      class: 'sv-star' + (favorite ? ' on' : ''), title: favorite ? 'Unfavorite' : 'Favorite',
      onclick: async (e: Event) => {
        e.stopPropagation();
        // #427/#434: no gate any more. The star writes `spec.favorite` and
        // nothing else — it cannot create a Dashboard, add or remove a tile, or
        // touch an owned copy — so there is no longer a wrong Dashboard for it
        // to land on. `toggleFavorite` still runs through `app.mutateWorkspace`
        // (serializes + reads latest at dequeue) — no `serializeWrite` wrapper.
        const result = await toggleFavorite(state, q.id, app.mutateWorkspace, app.specValidators);
        if (!app.refreshCurrentSurfaceAfterStale(surfaceGeneration, result?.ok === true)) return;
        if (result && result.invalidTab) app.activateInvalidSpecDraft(result.invalidTab);
        else if (result && result.ok) {
          app.queryDoc.revalidateSpecDrafts();
          app.specEditor.syncFromState();
          // #343: the patch may have just flagged a lagging dirty tab as
          // conflict OR adopted committed truth into a lagging clean tab —
          // re-fire the tab effect (editor doc resync for the active tab) and
          // reflect it on the Save button / tab badge immediately.
          app.state.tabs.value = [...app.state.tabs.value];
          app.updateSaveBtn();
          app.actions.rerenderTabs();
        } else if (result && !result.ok && result.deletedExternally) {
          // #343 review: the query vanished from the latest workspace — refresh
          // now so this dead Library row (and any linked tab) reconciles instead
          // of lingering until the next activation.
          flashToast('This query was deleted in another tab', { document: app.document });
          void app.refreshWorkspaceFromStore();
        } else if (result && !result.ok && result.diagnostics?.length) {
          flashToast('Couldn’t update favorite: ' + result.diagnostics[0].message, { document: app.document });
        }
        renderSavedHistory(app);
      },
    }, Icon.star(favorite));

    // Run-less view restore (#166): an entry that can't auto-run (empty SQL —
    // a text panel — or a DDL script) still restores its remembered drawer
    // view, so clicking a text panel actually shows the panel instead of
    // nothing. `run({view})` handles the auto-runnable path as before.
    const open = (): void => {
      app.actions.loadIntoNewTab({ ...q });
      if (isAutoRunnable(q.sql)) app.actions.run({ view: launchView });
      // `as`: SAVED_VIEWS.has(launchView) is exactly the runtime proof that
      // launchView is one of the resultView signal's known members here.
      else if (SAVED_VIEWS.has(launchView ?? '')) app.state.resultView.value = launchView as ResultView;
      // A queryless panel without a remembered view (hand-authored/imported
      // file) still needs the Panel drawer open, or clicking it shows nothing.
      else if (isQuerylessPanel(panel)) app.state.resultView.value = 'panel';
    };
    const row = h('div', { class: 'saved-row', ...libraryDragProps(app, q), onclick: open },
      h('div', { class: 'top' },
        star,
        h('span', { class: 'name' }, name),
        h('button', {
          class: 'sv-act sv-assign', title: 'Add to dashboard…', 'aria-label': 'Add to dashboard…',
          onclick: (e: Event) => {
            e.stopPropagation();
            openLibraryAssignMenu(app, q, e.currentTarget as HTMLElement);
          },
        }, Icon.plus()),
        h('button', {
          class: 'sv-act', title: 'Edit name & description',
          onclick: (e: Event) => {
            e.stopPropagation();
            const invalidTab = invalidSpecTabForSaved(state, q.id);
            if (invalidTab) app.activateInvalidSpecDraft(invalidTab);
            else app.state.editingSavedId.value = q.id;
            renderSavedHistory(app);
          },
        }, Icon.pencil()),
        h('button', {
          class: 'sv-act', title: 'Delete',
          onclick: async (e: Event) => {
            e.stopPropagation();
            // #343: delete over the LATEST workspace via `app.mutateWorkspace`.
            const result = await deleteSaved(state, q.id, app.mutateWorkspace);
            if (!app.refreshCurrentSurfaceAfterStale(surfaceGeneration, result.ok)) return;
            if (result.ok) {
              app.updateSaveBtn();
              app.updateEditorModeUi?.();
            } else if (result.diagnostics.length) {
              flashToast('Couldn’t delete: ' + result.diagnostics[0].message, { document: app.document });
            }
            renderSavedHistory(app);
          },
        }, Icon.trash())),
      description ? h('div', { class: 'desc' }, description) : null,
      h('div', { class: 'preview' }, q.sql.split('\n')[0]));
    list.appendChild(row);
  }
}

/**
 * The expanded "edit name & description" form shown in place of a saved row
 * while `app.state.editingSavedId.value === q.id`. The Name field commits on Enter, the
 * Description field on ⌘/Ctrl+Enter (plain Enter inserts a newline); Escape or
 * Cancel reverts. Clicks inside the form don't load the query. A `done` guard
 * keeps the re-render teardown from double-firing the commit.
 */
function savedEditForm(app: App, q: SavedQueryV2): HTMLDivElement {
  const state = app.state;
  const surfaceGeneration = app.captureSurfaceGeneration();
  const nameInput = h('input', { class: 'sv-edit-name', value: queryName(q), placeholder: 'Query name' });
  const descInput = h('textarea', { class: 'sv-edit-desc', rows: '3', placeholder: 'What this query does (shown in Markdown export)' });
  descInput.value = queryDescription(q);
  let done = false;
  const finish = async (commit: boolean): Promise<void> => {
    if (done) return;
    done = true;
    if (commit && nameInput.value.trim()) {
      // #343: rename/description over the LATEST workspace via `app.mutateWorkspace`.
      const result = await renameSaved(state, q.id, nameInput.value, descInput.value, app.mutateWorkspace, app.specValidators);
      if (!app.refreshCurrentSurfaceAfterStale(surfaceGeneration, result?.ok === true)) {
        app.state.editingSavedId.value = null;
        return;
      }
      if (result && result.invalidTab) app.activateInvalidSpecDraft(result.invalidTab);
      else if (result && !result.ok && result.deletedExternally) {
        // #343 review: target vanished — refresh so the dead row reconciles.
        flashToast('This query was deleted in another tab', { document: app.document });
        void app.refreshWorkspaceFromStore();
      } else if (result && !result.ok && result.diagnostics?.length) {
        flashToast('Couldn’t rename: ' + result.diagnostics[0].message, { document: app.document });
      } else {
        app.queryDoc.revalidateSpecDrafts();
        app.specEditor.syncFromState();
        // #343: a lagging tab may have just been conflict-flagged (dirty) or
        // adopted committed truth (clean) — resync editor + button + badges.
        app.state.tabs.value = [...app.state.tabs.value];
        app.updateSaveBtn();
        app.actions.rerenderTabs();
      }
    }
    app.state.editingSavedId.value = null;
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
  return h('div', { class: 'saved-edit', onclick: (e: Event) => e.stopPropagation() },
    h('div', { class: 'sv-field' }, 'Name'),
    nameInput,
    h('div', { class: 'sv-field' }, 'Description'),
    descInput,
    h('div', { class: 'sv-edit-actions' },
      h('button', { class: 'sv-edit-cancel', onclick: () => finish(false) }, 'Cancel'),
      h('button', { class: 'sv-edit-save', onclick: () => finish(true) }, 'Save')));
}

function renderHistory(app: App, list: HTMLElement): void {
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
  for (const ent of items as HistoryEntry[]) {
    list.appendChild(h('div', { class: 'history-row', ...dragProps(ent.sql), onclick: () => { app.actions.loadIntoNewTab('From history', ent.sql); if (isAutoRunnable(ent.sql)) app.actions.run(); } },
      h('button', {
        class: 'sv-act del', title: 'Delete',
        onclick: (e: Event) => { e.stopPropagation(); deleteHistory(state, ent.id, app.saveJSON); renderSavedHistory(app); },
      }, Icon.trash()),
      h('div', { class: 'sql' }, ent.sql),
      h('div', { class: 'meta' },
        h('span', null, timeAgo(ent.ts)),
        ent.rows != null ? h('span', null, ent.rows + ' rows') : null,
        h('span', null, ent.ms + ' ms'))));
  }
}
