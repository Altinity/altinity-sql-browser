// The bottom sidebar pane: a Library / History switcher and, per section, its own
// search box and list. Saved items support favorite (star), inline rename (pencil)
// and delete (trash). The search filters a section's own list (name/description/sql
// for Library, sql for History); it re-renders only the list so typing keeps focus.
//
// #487 phase 2 split the two sections' DOM: each renders into its own persistent
// search/list pair (`ui/nav-sections.ts` builds them and hosts them), where before
// both shared one pair that a section switch repainted.
//
// #487 phase 3 finishes the split: BOTH sections now render their own content
// unconditionally, independently of which one is exposed — mirroring the upper
// pane's `renderSchema`/`renderDashboardTree`, which have always painted on their
// own data triggers regardless of `state.upperRole`. Exposure (which host is
// visible) is a wholly separate concern, owned by `app-shell.ts`'s registry
// effect. This fixes two real bugs the old "paint only the active section" design
// had: the section that wasn't active at mount never got its first paint (blank
// until the first switch), and the section that wasn't active when its own data
// changed (e.g. a query runs and gets recorded to History while Library is shown)
// went stale until the next unrelated repaint. Each section also now keeps its
// OWN filter text (`state.lowerNavigationFilters`) rather than sharing one string,
// so switching between them no longer clears anything.

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
import { NAV_SECTION_META, sectionForSidePanelKey, sidePanelKeyFor } from './nav-sections.js';
import type { LowerNavigationSection } from './nav-sections.js';
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

/**
 * The active section, in the registry's vocabulary — used ONLY to decide the tab
 * row's "active" class/`aria-pressed` state. It no longer decides which section's
 * content renders (#487 phase 3: both sections always render their own, regardless
 * of which is exposed). `state.ts` also decodes the stored value at load.
 */
const activeSection = (app: App): LowerNavigationSection =>
  sectionForSidePanelKey(app.state.sidePanel.value);

/** A given section's OWN search box and list hosts. Deliberately keyed by an
 *  explicit `section` parameter rather than "whichever is active" (#487 phase 3)
 *  — each section's render functions always target their own hosts. */
const elsFor = (app: App, section: LowerNavigationSection): { search: HTMLElement | undefined; list: HTMLElement | undefined } =>
  section === 'library'
    ? { search: app.dom.savedSearch, list: app.dom.savedList }
    : { search: app.dom.historySearch, list: app.dom.historyList };

/** Read a section's own search filter text (#487 phase 3 — each lower-navigation
 *  section keeps its own, so switching between them preserves both instead of
 *  clearing one shared string). Exported for later phase-3 steps. */
export function filterFor(state: AppState, section: LowerNavigationSection): string {
  return state.lowerNavigationFilters[section];
}

/** Write a section's own search filter text. See `filterFor`. */
export function setFilterFor(state: AppState, section: LowerNavigationSection, value: string): void {
  state.lowerNavigationFilters[section] = value;
}

/**
 * The tab row only: the Library/History switcher plus the Library count badge.
 * #487 phase 2: the tab row speaks the registry's SECTION vocabulary and derives
 * the persisted value once, through the one mapping — rather than repeating the
 * `'library' means 'saved'` knowledge here.
 *
 * #487 phase 3: switching sections no longer clears anything — each section keeps
 * its own filter text (`state.lowerNavigationFilters`), preserved across every
 * switch. `switchTo` now only persists the choice and sets which section is
 * exposed.
 */
export function renderLowerTabs(app: App): void {
  const tabsRow = app.dom.savedTabsRow;
  if (!tabsRow) return;
  const state = app.state;
  // #427: the count is the LIBRARY count, not every stored query — the owned
  // copies are reachable through the Dashboard tree, not through this list.
  const count = libraryEntries(app).length;

  const switchTo = (section: LowerNavigationSection): void => {
    const panel = sidePanelKeyFor(section);
    app.prefs.save('sidePanel', panel);
    state.sidePanel.value = panel;
  };
  const active = activeSection(app);
  const tab = (section: LowerNavigationSection, extra: Node | null): HTMLButtonElement => {
    const meta = NAV_SECTION_META[section];
    return h('button', {
      class: 'side-tab' + (active === section ? ' active' : ''),
      type: 'button',
      'data-section': section,
      'aria-pressed': active === section ? 'true' : 'false',
      onclick: () => switchTo(section),
    }, meta.icon(), h('span', null, meta.label), extra);
  };

  tabsRow.replaceChildren(
    tab('library', count ? h('span', { class: 'side-count' }, '· ' + count) : null),
    tab('history', null),
  );
}

/** Render a given section's own list into a given host — favorites/rename/delete
 *  for Library, delete for History (`renderSaved`/`renderHistory` below), reading
 *  that section's OWN filter. Independent of which section is exposed. */
function renderSectionList(app: App, section: LowerNavigationSection, list: HTMLElement): void {
  list.replaceChildren();
  if (section === 'library') renderSaved(app, list);
  else renderHistory(app, list);
}

/**
 * Render the search box into a given section's OWN search host (built once per
 * full render; a section with no items shows nothing). Its `input` handler
 * mutates that section's own filter slot and re-renders only that section's own
 * list, so it stays focused.
 *
 * #487 phase 3 removed the old "does this input still own the active list"
 * guard: with one shared `libraryFilter` string, a stale/hidden input's events
 * could corrupt the OTHER section's filter and repaint the wrong list. With
 * per-section storage that is structurally impossible — a hidden Library input
 * can only ever write Library's own filter and repaint Library's own list,
 * which is correct regardless of whether Library is currently exposed.
 */
function renderSectionSearch(app: App, section: LowerNavigationSection, box: HTMLElement): void {
  const state = app.state;
  // Gated on the LIBRARY count (#427): a workspace whose every query is owned
  // has an empty list, so a search box over it would filter nothing.
  const isLibrary = section === 'library';
  const hasItems = isLibrary
    ? libraryEntries(app).length > 0
    : state.history.length > 0;
  box.replaceChildren();
  if (!hasItems) return;

  const input = h('input', {
    class: 'sv-search-input', type: 'text',
    placeholder: isLibrary ? 'Search library queries…' : 'Search history…',
    value: filterFor(state, section),
  });
  const clear = h('button', { class: 'sv-search-clear', title: 'Clear' }, Icon.close());
  const syncClear = (): void => { clear.style.display = input.value ? '' : 'none'; };
  const list = elsFor(app, section).list;
  const setFilter = (v: string): void => {
    input.value = v;
    setFilterFor(state, section, v);
    syncClear();
    if (list) renderSectionList(app, section, list);
  };

  input.addEventListener('input', () => {
    setFilterFor(state, section, input.value);
    syncClear();
    if (list) renderSectionList(app, section, list);
  });
  // #487 phase 3 step 4: an EMPTY search box does not claim Escape — leaving it
  // unclaimed (no `preventDefault()`) lets the key bubble up to the focused
  // drawer's own Escape handler (`app-shell.ts`) so Escape can close the drawer
  // even while this input is focused. A non-empty box still clears itself
  // first, exactly as before — a genuinely active filter is this input's own
  // business to consume.
  input.addEventListener('keydown', (e) => { if (e.key === 'Escape' && input.value !== '') { e.preventDefault(); setFilter(''); } });
  clear.addEventListener('click', () => { setFilter(''); input.focus(); });
  syncClear();

  box.append(h('span', { class: 'sv-search-icon' }, Icon.search()), input, clear);
}

/** Library's own search + list, into Library's own hosts — unconditionally,
 *  regardless of whether Library is currently exposed (#487 phase 3). */
export function renderLibrarySection(app: App): void {
  const { search, list } = elsFor(app, 'library');
  if (search) renderSectionSearch(app, 'library', search);
  if (list) renderSectionList(app, 'library', list);
}

/** History's own search + list, into History's own hosts — unconditionally,
 *  regardless of whether History is currently exposed (#487 phase 3). */
export function renderHistorySection(app: App): void {
  const { search, list } = elsFor(app, 'history');
  if (search) renderSectionSearch(app, 'history', search);
  if (list) renderSectionList(app, 'history', list);
}

/**
 * The facade: repaint the tab row and BOTH sections' own content, always (#487
 * phase 3 — mirrors the upper pane, where `renderSchema`/`renderDashboardTree`
 * each paint on their own triggers regardless of `state.upperRole`). Existing
 * internal call sites (favorite toggle, inline edit commit, row delete,
 * history-row delete) keep calling this facade unchanged — repainting all three
 * on those broader events is simple, safe, and cheap enough for these small
 * lists.
 */
export function renderSavedHistory(app: App): void {
  renderLowerTabs(app);
  renderLibrarySection(app);
  renderHistorySection(app);
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
  const libraryFilter = filterFor(state, 'library');
  const items = filterSaved(sortedSaved({ ...state, savedQueries: library }), libraryFilter);
  if (items.length === 0) {
    list.appendChild(h('div', { class: 'saved-empty' }, 'No library queries match “' + libraryFilter.trim() + '”.'));
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
  const historyFilter = filterFor(state, 'history');
  const items = filterHistory(state.history, historyFilter);
  if (items.length === 0) {
    list.appendChild(h('div', { class: 'saved-empty' }, 'No history matches “' + historyFilter.trim() + '”.'));
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
