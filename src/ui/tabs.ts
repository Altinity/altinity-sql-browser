// Query tab strip + tab lifecycle (select / new / close). The lifecycle
// operations are pure over state; `renderTabs` paints the strip.

import { h } from './dom.js';
import { Icon } from './icons.js';
import {
  activeTab, allocTabId, findVariableTab, newTabObj, setTabSpecDraft, tabSaveDirty,
} from '../state.js';
import { cloneJson, queryName, upgradeSavedQuery } from '../core/saved-query.js';
import { queryToken } from '../workspace/workspace-sync.js';
import { batch } from '@preact/signals-core';
import type { AppDom } from './app.types.js';
import type { AppState, QueryTab } from '../state.js';
import type { SavedQueryV2 } from '../generated/json-schema.types.js';
import type { EditorPort } from '../editor/editor-port.types.js';

/** The narrow slice of the real `app` controller this module reads — not the
 *  full ~50-member `App` contract (app.types.ts). `state` is the real
 *  `AppState` (not a `Pick`): `newTab`/`loadIntoNewTab` thread it straight
 *  into `allocTabId`/`activeTab` (state.ts), which require the whole shape.
 *  A real `App` satisfies this directly, and so does
 *  tests/helpers/fake-app.js's minimal `makeApp()` fixture — no cast needed
 *  on either side. */
export interface TabsApp {
  dom: Pick<AppDom, 'qtabsInner'>;
  state: AppState;
  /** #447 narrowed this: `actions.setEditorMode` + `specEditor.revealOffset`
   *  were read ONLY by the removed Filter-role badge. */
  sqlEditor: Pick<EditorPort, 'focus'>;
}

// #447 removed `filterRoleBadge` (and its `FilterRoleTarget`): it was the shared
// "Filter" role badge painted next to a tab name here and next to a Library row
// in saved-history.ts, and the only role it ever announced was the Filter role
// the option-provider model owned. `role`'s schema enum is `["panel","setup"]`
// now, and neither of those gets a badge, so nothing renders it.

/** Paint the tab strip into app.dom.qtabsInner. */
export function renderTabs(app: TabsApp): void {
  const host = app.dom.qtabsInner;
  if (!host) return;
  host.replaceChildren(...app.state.tabs.value.map((t) => {
    const isActive = t.id === app.state.activeTabId.value;
    return h('div', { class: 'qtab' + (isActive ? ' active' : ''), onclick: () => selectTab(app, t.id) },
      h('span', { class: 'name' }, t.name),
      // #343: a visible marker when this tab's linked saved query changed
      // ('conflict') or was deleted ('deleted') in another browser tab.
      t.externalState
        ? h('span', {
            class: 'qtab-external ' + t.externalState,
            title: t.externalState === 'conflict'
              ? 'This query changed in another tab — resolve the conflict to save'
              : 'This query was deleted in another tab — Save will create a new one',
          }, t.externalState === 'conflict' ? '!' : '⌫')
        : null,
      // #457: `tabSaveDirty`, not `tabDirty` — the dot and the Save button must
      // read the SAME predicate, and a variable tab's Spec is never saved.
      tabSaveDirty(t) ? h('span', { class: 'dirty' }) : null,
      app.state.tabs.value.length > 1
        ? h('button', {
            class: 'close',
            onclick: (e: Event) => { e.stopPropagation(); closeTab(app, t.id); },
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
export function selectTab(app: TabsApp, id: string): void {
  if (id === app.state.activeTabId.value) return;
  app.state.activeTabId.value = id;
}

/** Open a new blank tab and focus the editor. */
export function newTab(app: TabsApp): void {
  const id = allocTabId(app.state);
  batch(() => {
    app.state.tabs.value = [...app.state.tabs.value, newTabObj(id)];
    app.state.activeTabId.value = id;
  });
  app.sqlEditor.focus();
}

/** A saved query's canonical object, or enough of one to resume it (`id`
 *  links back to a currently-open tab) — the shape `loadIntoNewTab` accepts
 *  for its "open a saved query" overload; matches `ActionsRegistry.
 *  loadIntoNewTab`'s existing `string | Json` contract (app.types.ts). */
export type QueryOrName = string | Record<string, unknown>;

/**
 * Open a saved query (pass its canonical object) or an unsaved/history document
 * (pass name + sql). Saved tabs clone the COMPLETE Spec, so later panel edits,
 * sharing, and Save retain extensions rather than reconstructing known fields.
 */
export function loadIntoNewTab(app: TabsApp, queryOrName: QueryOrName, sql = ''): QueryTab {
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
    // #343: record the opened query's token as this tab's in-sync baseline so the
    // linked-tab classifier can later tell whether it changed in another tab.
    if (tab.savedId) tab.lastCommittedQueryToken = queryToken(query as unknown as SavedQueryV2);
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

/** The tab-strip title for a variable document. Prefixed rather than bare so a
 *  variable named like a query ("revenue") is never mistaken for one. Deliberately
 *  module-private: the title is this module's business, and a second producer of it
 *  is exactly the drift #457 removed. */
const variableTabName = (variableName: string): string => 'Variable: ' + variableName;

/**
 * Point an already-open, CLEAN variable tab at newly committed option SQL —
 * without selecting it, focusing the editor, or leaving the current surface
 * (#428).
 *
 * `openVariableTab` performs the same adoption, but it is an OPEN action: it also
 * sets `activeTabId`, focuses the editor, and (through `app.openVariableTab`)
 * calls `showQuerySurface()`. That is right when the user asked for the tab and
 * wrong after a drag-assignment, which #428 requires not to "automatically switch
 * to the Query surface". Hence a second, narrower entry point rather than a flag.
 *
 * Returns `false` — changing nothing — when no such tab is open, or when it holds
 * an unsaved draft. A dirty draft is the user's only copy and is never
 * overwritten; the caller rejects the assignment outright before reaching here,
 * and this is the second, independent guard on the same rule.
 */
export function reconcileVariableTab(
  // Narrower than `TabsApp` on purpose: this touches only the tabs signal, so
  // the Dashboard tree can call it without pretending to own the tab strip's DOM
  // or the editor port.
  app: Pick<TabsApp, 'state'>, dashboardId: string, variableName: string, sql: string,
): boolean {
  const existing = findVariableTab(app.state.tabs.value, dashboardId, variableName);
  if (!existing || existing.dirtySql || existing.sqlDraft === sql) return false;
  existing.sqlDraft = sql;
  // The editor syncs off the tabs signal and mutating `sqlDraft` in place is
  // invisible to it, so the list identity has to be poked — but ONLY that.
  // Touching `activeTabId` here is what would navigate.
  app.state.tabs.value = [...app.state.tabs.value];
  return true;
}

/**
 * Throw away a variable tab's unsaved draft and adopt `sql` instead — the
 * explicit, user-invoked counterpart to `reconcileVariableTab`, which refuses a
 * dirty tab (#428).
 *
 * The only caller is the "Discard draft" action on the toast shown when an
 * assignment commits while the user is typing in that variable's tab: the write
 * is durable, the draft is untouched, and the two disagree. Nothing calls this
 * automatically — discarding someone's typing is a choice they have to make.
 */
export function discardVariableDraft(
  app: Pick<TabsApp, 'state'>, dashboardId: string, variableName: string, sql: string,
): boolean {
  const existing = findVariableTab(app.state.tabs.value, dashboardId, variableName);
  if (!existing) return false;
  existing.sqlDraft = sql;
  existing.dirtySql = false;
  app.state.tabs.value = [...app.state.tabs.value];
  return true;
}

/**
 * Open — or re-select — the tab that edits ONE Dashboard variable's option SQL
 * (#457).
 *
 * Identity is the exact `(dashboardId, variableName)` pair, so re-opening the
 * same variable selects the tab it already has instead of stacking duplicates,
 * while the same variable name under a different Dashboard is a different
 * document and gets its own tab. Every other open tab and unsaved draft is left
 * exactly as it was — this appends, it never replaces.
 *
 * `sql` is committed truth at open time (`''` for a variable with no stored
 * configuration yet); the tab is NOT dirty until the user types. `savedId` stays
 * `null`: a variable is not a saved query, and Save writes `variableConfigs`.
 */
export function openVariableTab(
  app: TabsApp, binding: { dashboardId: string; variableName: string }, sql: string,
): QueryTab {
  const existing = findVariableTab(app.state.tabs.value, binding.dashboardId, binding.variableName);
  if (existing) {
    // A CLEAN tab re-reads committed truth. Nothing reconciles a variable tab
    // against a configuration changed elsewhere — it has no `savedId`, so the
    // linked-tab classifier (#343) skips it entirely — and the tree's own trash
    // affordance can delete the very configuration an open tab is showing. Without
    // this, re-clicking the row returned a tab still displaying SQL that no longer
    // exists, labelled "Saved", one ⌘S away from recreating it. An edited tab is
    // never overwritten: the draft is the user's only copy.
    if (!existing.dirtySql && existing.sqlDraft !== sql) {
      existing.sqlDraft = sql;
      // The editor syncs off the tabs signal, and selecting an ALREADY-active tab
      // changes nothing on its own — so the list identity has to be poked or the
      // editor keeps painting the stale document.
      batch(() => {
        app.state.tabs.value = [...app.state.tabs.value];
        app.state.activeTabId.value = existing.id;
      });
      app.sqlEditor.focus();
      return existing;
    }
    app.state.activeTabId.value = existing.id;
    app.sqlEditor.focus();
    return existing;
  }
  const tab = newTabObj(allocTabId(app.state));
  tab.doc = { kind: 'dashboard-variable', ...binding };
  tab.name = variableTabName(binding.variableName);
  tab.sqlDraft = sql;
  // Same treatment `loadIntoNewTab` gives an unsaved document: the Spec draft
  // carries the tab's real name, so anything reading the Spec for a title (a
  // share link, the result-source header) says what this document is rather than
  // "Untitled".
  setTabSpecDraft(tab, { ...tab.specParsed, name: tab.name });
  batch(() => {
    app.state.tabs.value = [...app.state.tabs.value, tab];
    app.state.activeTabId.value = tab.id;
  });
  app.sqlEditor.focus();
  return tab;
}

/** Close a tab (never the last one), re-selecting a neighbour if needed. */
export function closeTab(app: TabsApp, id: string): void {
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
