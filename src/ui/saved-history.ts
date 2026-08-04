// The bottom sidebar pane's two panels — Library and History (#587: two
// registry entries, no longer a switcher this module builds itself). Saved
// items support favorite (star), inline rename (pencil) and delete (trash).
// The search filters the active list (name/description/sql for Library, sql
// for History); it re-renders only the list so typing keeps focus.
//
// #587: `libraryPanelDef`/`historyPanelDef` are what `app-shell.ts` hands to
// `buildSidePanelRegistry` — each panel gets its OWN persistent search+list
// host, built once in `mount(host)` and never rebuilt. `state.libraryFilter`
// stays ONE shared string (splitting it per panel is #487 phase 3's job, out
// of scope here) — which is exactly why `ownsTheList` exists below: with two
// PERSISTENT hosts, an event from the INACTIVE panel's leftover search input
// would rewrite the shared filter and repaint the OTHER panel's list. A real
// browser never delivers events to a `hidden` subtree, so this is a guard
// against a host a future caller (or a test) can still reach directly, not a
// redesign of the shared-filter decision.

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
// From the type-only seam file, not `./side-panel-registry.js` itself — see
// `sidebar-upper.ts`'s identical import for why (`side-panel-registry.ts`
// imports THIS module's `libraryPanelDef`/`historyPanelDef` at runtime now).
import type { MountedSidePanel, SidePanelDef } from './side-panel-registry.types.js';

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

/**
 * Compatibility seam (#587): 10 call sites across the app (5 in this file, 4
 * in `app.ts`, 1 in `file-menu.ts` — counted with `rg`, excluding this
 * definition and import lines) call this to repaint whichever lower panel is
 * active — a star/delete/rename completion, a Dashboard-membership
 * projection bump, or the tab switch itself. It now delegates to the mounted
 * shell's registry, which resolves
 * "the active lower panel" itself; a no-op before the shell mounts or after
 * it is disposed (both real states — `app.shell` starts/ends `null`), never
 * a thrown error against a controller wiring that runs before any DOM exists.
 */
export function renderSavedHistory(app: App): void {
  app.shell?.sidePanels.refreshActiveSidePanels();
}

/** The Library tab's live count (#427: the LIBRARY count, not every stored
 *  query — the owned copies are reachable through the Dashboard tree, not
 *  through this list). `null` renders no adornment, exactly like today. */
function libraryCountNode(app: App): Node | null {
  const count = libraryEntries(app).length;
  return count ? h('span', { class: 'side-count' }, '· ' + count) : null;
}

/**
 * Build ONE lower-pane panel's persistent search+list pair and its
 * `MountedSidePanel` controller. Shared by both Library and History
 * (`isLibrary` is the only branch) — the DOM shape, search wiring, and
 * ownership guard are otherwise identical.
 */
function mountLowerPanel(app: App, host: HTMLElement, isLibrary: boolean): MountedSidePanel {
  const search = h('div', { class: 'saved-search' });
  const list = h('div', { class: 'saved-list' });
  host.append(search, list);

  const hasItems = (): boolean => (isLibrary ? libraryEntries(app).length > 0 : app.state.history.length > 0);

  const renderList = (): void => {
    list.replaceChildren();
    if (isLibrary) renderSaved(app, list); else renderHistory(app, list);
  };

  // #587: with a PERSISTENT host, this panel's search input can still receive
  // a dispatched event while hidden (a real browser never delivers one to a
  // `display: none` subtree, but nothing before #587 needed to rely on that —
  // there was only ever one shared pair). `state.libraryFilter` stays ONE
  // shared string (splitting it per panel is #487 phase 3's job), so an event
  // from the INACTIVE panel's stale input must not rewrite it or repaint the
  // OTHER panel's list — `ownsTheList` is that guard, checked at the top of
  // every handler it wires below.
  const ownsTheList = (): boolean => !host.hidden;

  const renderSearchBox = (): void => {
    const state = app.state;
    search.replaceChildren();
    if (!hasItems()) return;

    const input = h('input', {
      class: 'sv-search-input', type: 'text',
      placeholder: isLibrary ? 'Search library queries…' : 'Search history…',
      value: state.libraryFilter,
    });
    const clear = h('button', { class: 'sv-search-clear', title: 'Clear' }, Icon.close());
    const syncClear = (): void => { clear.style.display = input.value ? '' : 'none'; };
    const setFilter = (v: string): void => {
      if (!ownsTheList()) return;
      input.value = v; state.libraryFilter = v; syncClear(); renderList();
    };

    input.addEventListener('input', () => {
      if (!ownsTheList()) return;
      state.libraryFilter = input.value; syncClear(); renderList();
    });
    input.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); setFilter(''); } });
    clear.addEventListener('click', () => { setFilter(''); input.focus(); });
    syncClear();

    search.append(h('span', { class: 'sv-search-icon' }, Icon.search()), input, clear);
  };

  const render = (): void => { renderSearchBox(); renderList(); };

  return {
    render,
    // Switching panes clears the search so each tab starts unfiltered —
    // matches the pre-#587 behaviour ('clears the filter when switching
    // tabs'), just triggered by the panel becoming inactive rather than by
    // the tab-row click handler itself (which no longer lives in this
    // module — see `app-shell.ts`'s generic `onSelect`).
    deactivate: () => { app.state.libraryFilter = ''; },
    // #587 AC3: only History repaints after a clean run — dispatch itself is
    // scoped to "the active lower panel" by the registry's `notifyRunComplete`,
    // so this only ever fires while History is genuinely visible.
    onRunComplete: isLibrary ? undefined : render,
    dispose: () => {},
  };
}

/** The registry's Library entry (#587 deliverable 1/3). */
export function libraryPanelDef(app: App): SidePanelDef {
  return {
    id: 'library', pane: 'lower', label: 'Library', icon: Icon.layers,
    accessibleLabel: 'Open Library navigation',
    tabAdornment: () => libraryCountNode(app),
    mount: (host) => mountLowerPanel(app, host, true),
  };
}

/** The registry's History entry (#587 deliverable 1/3). No tab adornment —
 *  History never carried a count. */
export function historyPanelDef(app: App): SidePanelDef {
  return {
    id: 'history', pane: 'lower', label: 'History', icon: Icon.history,
    accessibleLabel: 'Open query History',
    mount: (host) => mountLowerPanel(app, host, false),
  };
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
          void app.workspaceSession.refreshWorkspaceFromStore();
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
          // Explicit so WebKit includes the hover-concealed action in its
          // native Tab sequence; the preceding star is the keyboard entry.
          tabindex: '0',
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
        void app.workspaceSession.refreshWorkspaceFromStore();
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
