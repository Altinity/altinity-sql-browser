// #588 W2 (phase 4, decompose the `createApp` composition root): the Save
// cluster — `updateSaveBtn` (the Save button's state projection),
// `saveActiveQuery` (the Save action's document-kind dispatch), the
// linked-query commit/create/conflict paths it dispatches to, and their
// shared toast/popover choreography — extracted verbatim out of app.ts into
// its own controller.
//
// #457's kind-dispatch-first ordering (I-15 in the phase 4 invariant map)
// travels with the code UNCHANGED in both `updateSaveBtn` and
// `saveActiveQuery`: each checks the document KIND (`variableDoc(tab)`)
// before anything conflict/Spec-related, in the same order, so the button's
// visible state never describes an action Save itself would not take. Do
// NOT reconcile the two checks into one shared helper — the plan's own
// worked example treats this duplication as a deliberately preserved
// invariant, not an opportunity to simplify.
//
// Two deliberate deviations from the phase 4 plan's literal `SaveControllerDeps`
// draft (see this phase's own worker report):
//  - `specBlocked` ADDED: `updateSaveBtn`'s non-variable branch calls the SAME
//    `specBlocked` predicate `workbench-shell.ts` reads off `App.specBlocked`
//    (app.ts keeps owning that one definition — this controller must not
//    re-declare its own copy, which would let the two drift).
//  - `specEditor(): SpecEditorPort` DROPPED: the plan draft listed it, but no
//    moved statement ever calls it — every specEditor touch in the original
//    code was `app.specEditor.syncFromState()`, already covered by the
//    separate `syncSpecEditorFromState()` hook below. Keeping an unread thunk
//    would leave its composition-root wiring permanently uncovered (breaks
//    the 100% statement/line floor on app.ts) for no behavioral reason.

import { h } from '../dom.js';
import { Icon } from '../icons.js';
import {
  savedForTab, tabPanel, tabSaveDirty, variableDoc, adoptSavedIntoTab,
} from '../../state.js';
import type { AppState, QueryTab, WorkspaceMutationOutcome } from '../../state.js';
import type { SavedQueryV2, StoredWorkspaceV5 } from '../../generated/json-schema.types.js';
import type { SavedQueryService } from '../../application/saved-query-service.js';
import type { QueryDocumentSession } from '../../application/query-document-session.js';
import type { createAnchoredPopovers } from '../popover.js';
import { normalizeVariableSql } from '../../core/dashboard-variables.js';
import { dashboardVariables } from '../../application/dashboard-tree-model.js';
import type { VariableConfigAbort } from '../../application/dashboard-variable-config.js';
import { isQuerylessPanel } from '../../core/panel-cfg.js';
import { inferQueryName } from '../../core/format.js';
import { flashToast } from '../toast.js';
import { buildConflictChooser } from '../conflict-resolution.js';
import { batch } from '@preact/signals-core';

/** The narrow `app`-shaped seam `createSaveController` reads. Frozen per the
 *  phase 4 plan except `specBlocked` (see this module's header comment). */
export interface SaveControllerDeps {
  document: Document;
  state: AppState;
  activeTab(): QueryTab;
  saved: Pick<SavedQueryService, 'commit' | 'create'>;
  queryDoc: Pick<QueryDocumentSession, 'evaluateSpecDraft' | 'revalidateSpecDrafts' | 'revealFirstSpecError'>;
  currentWorkspace(): StoredWorkspaceV5 | null;
  captureSurfaceGeneration(): number;
  refreshCurrentSurfaceAfterStale(generation: number, committed?: boolean): boolean;
  syncBeforeUnload(): void;
  refreshWorkspaceFromStore(): Promise<void>;
  commitVariableConfig(
    dashboardId: string, variableName: string, cfg: { sql: string; lastKnownType?: string } | null,
  ): unknown;
  // `HTMLButtonElement`, not the plan draft's `HTMLElement` — `updateSaveBtn`
  // reads `.disabled`, which only form-control element types declare;
  // `AppDom.saveBtn` itself is already typed `HTMLButtonElement | undefined`
  // (app.types.ts).
  saveBtn(): HTMLButtonElement | undefined;
  savePopoverOpen(): boolean;
  anchoredPopover: ReturnType<typeof createAnchoredPopovers>['open'];
  rerenderTabs(): void;
  updateEditorModeUi(): void;
  renderSavedHistory(): void;
  renderResults(): void;
  syncSpecEditorFromState(): void;
  /** #457's shared kind-dispatch-first Spec-blocking predicate. app.ts owns
   *  the ONE definition (also read by `workbench-shell.ts` off
   *  `App.specBlocked`) — this controller must not re-declare its own. */
  specBlocked(tab: QueryTab): boolean;
}

export interface SaveController {
  updateSaveBtn(): void;
  saveActiveQuery(): Promise<SavedQueryV2 | null | undefined>;
  openConflictChooser(): void;
  openSavePopover(): void;
}

/** Build the Save cluster's controller bound to `deps`. Trivial constructor —
 *  no validation; `createApp` supplies the real `app`-backed thunks, unit
 *  tests supply fakes directly. */
export function createSaveController(deps: SaveControllerDeps): SaveController {
  function updateSaveBtn(): void {
    const saveBtn = deps.saveBtn();
    if (!saveBtn) return;
    const tab = deps.activeTab();
    // #457: the DOCUMENT KIND is checked first, exactly as `saveActiveQuery`
    // checks it — a variable tab has no saved query behind it, so "saved" is
    // simply "not dirty", no Spec can block it, and the conflict state below
    // (a linked-saved-query concept) cannot apply to it. Ordering the two the
    // same way in both places is what stops the button ever describing an
    // action the Save action would not take.
    if (variableDoc(tab) !== null) {
      const stored = !tabSaveDirty(tab);
      saveBtn.classList.remove('conflict');
      saveBtn.classList.toggle('saved', stored);
      saveBtn.replaceChildren(Icon.bookmark(), h('span', null, stored ? 'Saved' : 'Save'));
      saveBtn.disabled = false;
      saveBtn.title = stored
        ? 'Saved — edit to re-save (⌘S)'
        : 'Save this variable’s option SQL (⌘S)';
      return;
    }
    // #343: a tab whose linked saved query changed in another tab must not be
    // silently re-saved. The Save button becomes "Resolve conflict" and opens
    // the two-action chooser instead of committing.
    if (tab.externalState === 'conflict') {
      saveBtn.classList.remove('saved');
      saveBtn.classList.add('conflict');
      saveBtn.replaceChildren(Icon.bookmark(), h('span', null, 'Resolve conflict'));
      saveBtn.disabled = false;
      saveBtn.title = 'This query changed in another tab — choose how to resolve it';
      return;
    }
    saveBtn.classList.remove('conflict');
    const entry = savedForTab(deps.state, tab);
    const clean = !!entry && !tab.dirtySql && !tab.dirtySpec;
    const blocked = !!entry && deps.specBlocked(tab);
    saveBtn.classList.toggle('saved', clean);
    saveBtn.replaceChildren(Icon.bookmark(), h('span', null, clean ? 'Saved' : 'Save'));
    saveBtn.disabled = blocked;
    saveBtn.title = blocked
      ? 'Fix blocking Spec errors before saving'
      : clean ? 'Saved — edit to re-save (⌘S)' : 'Save query (⌘S)';
  }

  /** A warning-bearing save still succeeded. Preserve that confirmation and
   * keep the actionable inference guidance visible long enough to read. */
  function flashSaved(diagnostics?: ReadonlyArray<{ message: string }>): void {
    const warning = diagnostics?.[0]?.message;
    flashToast(warning ? `Saved — ${warning}` : 'Saved', {
      document: deps.document,
      ...(warning ? { duration: 6000 } : {}),
    });
  }

  async function commitLinkedQuery(): Promise<SavedQueryV2 | null> {
    const surfaceGeneration = deps.captureSurfaceGeneration();
    const tab = deps.activeTab();
    const evaluated = deps.queryDoc.evaluateSpecDraft(tab, tab.specText, { dirty: tab.dirtySpec });
    // #343: `saved.commit` now runs its candidate-building transform through
    // `app.mutateWorkspace`, which already enters the tab-local write queue and
    // reads the latest committed aggregate at dequeue — no outer `serializeWrite`
    // wrapper needed (it would only double-queue).
    const result = await deps.saved.commit(tab, evaluated);
    // #466/#501-review: `saved.commit` already cleared `dirtySql`/`dirtySpec`
    // on a real commit (`commitSavedQuery`, state.ts) — BEFORE the staleness
    // bracket below, which can return early on a navigation that began
    // mid-write. `rerenderTabs()` (which re-syncs this too) only runs past
    // that bracket, so without this the guard stays installed for a tab that
    // is, by now, genuinely clean and durably written.
    if (result.ok) deps.syncBeforeUnload();
    if (!deps.refreshCurrentSurfaceAfterStale(surfaceGeneration, result.ok)) {
      return result.ok ? result.entry : null;
    }
    if (!result.ok) {
      // 'rejected' (commit's own defensive re-check inside the service, OR the
      // aggregate strictly rejecting the whole-workspace commit — #287 W4)
      // stays a silent no-op for the tab/editor state (nothing was mutated),
      // but a real commit rejection still surfaces its first diagnostic.
      if (result.reason === 'invalid-spec') {
        deps.queryDoc.revealFirstSpecError(tab);
        flashToast('Fix Spec errors before saving', { document: deps.document });
      } else if (result.reason === 'empty') {
        flashToast('Nothing to save', { document: deps.document });
      } else if (result.reason === 'deleted') {
        // #343: the linked query vanished from the latest workspace (deleted in
        // another tab) and the save aborted without recreating it. Refresh the
        // tab association now — the reconcile turns this tab into an unsaved
        // draft (dirty) or detaches it (clean) — instead of leaving a ghost
        // link waiting for the next focus/visibility event.
        flashToast('This query was deleted in another tab — your draft is kept as an unsaved query', { document: deps.document });
        void deps.refreshWorkspaceFromStore();
      } else if (result.diagnostics?.length) {
        flashToast('Save failed: ' + result.diagnostics[0].message, { document: deps.document });
      }
      return null;
    }
    deps.queryDoc.revalidateSpecDrafts();
    deps.syncSpecEditorFromState();
    updateSaveBtn();
    deps.rerenderTabs();
    deps.renderSavedHistory();
    deps.renderResults();
    deps.updateEditorModeUi();
    flashSaved(result.diagnostics);
    return result.entry;
  }

  /**
   * #457 — Save on a `dashboard-variable` tab. The ONE write it performs is
   * `dashboard.variableConfigs[variableName]`: no `SavedQueryV2` is created or
   * touched, and the document is never added to the Library, History, favourites
   * or Panels.
   *
   * The trim rule is the pure service's, never re-implemented here: blank (or
   * whitespace-only) SQL REMOVES the configuration and returns the variable to
   * direct input, rather than storing an empty string that would later read as
   * configured-but-broken.
   */
  async function saveVariableTab(
    tab: QueryTab, binding: { dashboardId: string; variableName: string },
  ): Promise<null> {
    const surfaceGeneration = deps.captureSurfaceGeneration();
    const sql = normalizeVariableSql(tab.sqlDraft);
    // `lastKnownType` is what lets a configuration still display a type once its
    // last declaring panel disappears. Recorded from whatever type is agreed NOW
    // (a live declaration always wins over it), and read from the same projection
    // the tab was opened through, at save time rather than at open time.
    const type = dashboardVariables(deps.currentWorkspace(), binding.dashboardId)
      .find((candidate) => candidate.name === binding.variableName)?.type ?? null;
    const outcome = await deps.commitVariableConfig(binding.dashboardId, binding.variableName, sql === null
      ? null
      : { sql, ...(type === null ? {} : { lastKnownType: type }) }) as WorkspaceMutationOutcome<VariableConfigAbort>;
    // TAB-side state is applied on a real commit REGARDLESS of staleness, and
    // before the bracket — the write is durable, so the tab must stop claiming
    // unsaved work whether or not this caller still owns the renderer. The linked
    // saved-query path has the same shape: `commitSavedQuery` clears `dirtySql`
    // inside the service (state.ts), and only the DOM cascade after it sits behind
    // `commitLinkedQuery`'s bracket. Gating the flag too left a committed tab
    // permanently dirty whenever the user navigated mid-write — a dirty dot and a
    // "Save" button for content already on disk, with nothing able to clear them.
    if (outcome.ok) {
      tab.dirtySql = false;
      // `dirtySpec` is not part of a variable document (see `tabSaveDirty`), but
      // the result toolbar's panel-type picker can still set it. Clearing it here
      // keeps a saved variable tab from carrying a flag nothing else ever resets.
      tab.dirtySpec = false;
      // #466/#501-review: re-sync the `beforeunload` guard for THIS tab-side
      // clear too — `rerenderTabs()` below the staleness bracket also does it,
      // but that bracket can return early on a navigation that began mid-write.
      deps.syncBeforeUnload();
    }
    // Same staleness bracket every other async save uses: a navigation that began
    // mid-write must not be REPAINTED or TOASTED over.
    if (!deps.refreshCurrentSurfaceAfterStale(surfaceGeneration, outcome.ok)) return null;
    if (outcome.ok) {
      deps.rerenderTabs();
      updateSaveBtn();
      flashToast(sql === null ? 'Option SQL removed' : 'Saved', { document: deps.document });
      return null;
    }
    // `aborted` covers more than one thing, and only ONE of them is this
    // transform's own refusal (`data === 'declined'` — the Dashboard is gone or
    // its id is ambiguous, and nothing was written). The others are the primitive
    // deciding the route moved on, and at least one of those keeps a durable
    // write — so they say nothing rather than claim a failure that may not be one.
    // Either way the draft stays dirty: it is the only copy of the user's edit.
    if (outcome.aborted) {
      if (outcome.data === 'declined') {
        flashToast('This dashboard is no longer available — nothing was saved', { document: deps.document });
      }
      return null;
    }
    flashToast('Save failed: ' + outcome.diagnostics[0].message, { document: deps.document });
    return null;
  }

  async function saveActiveQuery(): Promise<SavedQueryV2 | null | undefined> {
    const tab = deps.activeTab();
    // #457: Save dispatches on the DOCUMENT KIND first. A variable tab is not a
    // saved query and must never reach the linked-save or Save-as-new paths.
    const variable = variableDoc(tab);
    if (variable !== null) return saveVariableTab(tab, variable);
    // #343: while a linked tab is in conflict, Save opens the resolution chooser
    // rather than silently overwriting the externally changed query. A
    // 'deleted'-flagged orphan has `savedId === null` already, so it falls
    // through to the normal Save-as-new popover (never an implicit recreate).
    if (tab.externalState === 'conflict') { openConflictChooser(); return undefined; }
    if (savedForTab(deps.state, tab)) return commitLinkedQuery();
    openSavePopover();
    return undefined;
  }

  // #343 §8: discard the active tab's local draft and adopt the latest committed
  // version of its linked query — the "Reload saved version" conflict
  // resolution. The committed query is already projected on `state.savedQueries`
  // (a refresh ran to detect the conflict), so this reads it from there.
  function reloadSavedVersion(): void {
    const tab = deps.activeTab();
    const entry = savedForTab(deps.state, tab);
    if (!entry) {
      // Deleted between opening the chooser and resolving — nothing to reload;
      // refresh so the reconcile gives this tab its deleted-elsewhere treatment
      // instead of leaving the stale conflict state in place (#343 review).
      void deps.refreshWorkspaceFromStore();
      return;
    }
    adoptSavedIntoTab(tab, entry);
    batch(() => { deps.state.tabs.value = [...deps.state.tabs.value]; }); // re-run the tab effect → editor + strip resync
    updateSaveBtn();
    deps.rerenderTabs();
    deps.renderSavedHistory();
    flashToast('Reloaded the version saved in the other tab', { document: deps.document });
  }

  // #343 §8: the two-action conflict chooser, anchored under the Save button.
  // "Reload saved version" fires immediately; "Keep my draft" confirms, then
  // commits the full draft over the latest query via the normal linked-save path
  // (`commitLinkedQuery` → `mutateWorkspace`), preserving unrelated workspace
  // changes and clearing the conflict on success.
  function openConflictChooser(): void {
    if (deps.savePopoverOpen()) return;
    const tab = deps.activeTab();
    let close: () => void;
    const chooser = buildConflictChooser({
      queryName: tab.name,
      onReloadSaved: () => { close(); reloadSavedVersion(); },
      onKeepDraft: () => { close(); void commitLinkedQuery(); },
    });
    ({ close } = deps.anchoredPopover(chooser, deps.saveBtn()!, 'savePopover'));
  }

  // Creation-only Name/Description popover. Once linked, the textual Spec is
  // authoritative and Save bypasses this UI entirely.
  function openSavePopover(): void {
    const tab = deps.activeTab();
    // A queryless panel (text, #166) is authored entirely in its cfg, so it
    // saves with empty SQL — the same per-type relaxation saveQuery applies.
    if (!String(tab.sqlDraft || '').trim() && !isQuerylessPanel(tabPanel(tab))) {
      flashToast('Nothing to save', { document: deps.document });
      return;
    }
    if (deps.savePopoverOpen()) return;
    const prefill = tab.name && tab.name !== 'Untitled' ? tab.name : inferQueryName(tab.sqlDraft);
    const input = h('input', { class: 'sp-input', value: prefill });
    const descInput = h('textarea', { class: 'sp-desc', rows: '3', placeholder: 'What this query does — included in Markdown export' });
    let close: () => void;
    const commit = async (): Promise<void> => {
      if (!input.value.trim()) return;
      const surfaceGeneration = deps.captureSurfaceGeneration();
      // #343: `saved.create` runs its transform through `app.mutateWorkspace`,
      // which already serializes + reads the latest committed aggregate — no
      // outer `serializeWrite` wrapper needed.
      const result = await deps.saved.create(tab, input.value, descInput.value);
      // #466/#501-review: `saved.create` already cleared `dirtySql`/`dirtySpec`
      // on success (`createSavedQuery`, state.ts) — before the staleness
      // bracket, which can return early on a navigation that began mid-write.
      if (result.ok) deps.syncBeforeUnload();
      if (!deps.refreshCurrentSurfaceAfterStale(surfaceGeneration, result.ok)) return;
      if (!result.ok) {
        if (result.diagnostics?.length) flashToast('Save failed: ' + result.diagnostics[0].message, { document: deps.document });
        return;
      }
      close();
      deps.queryDoc.revalidateSpecDrafts();
      deps.syncSpecEditorFromState();
      updateSaveBtn();
      deps.updateEditorModeUi();
      deps.rerenderTabs();
      deps.renderSavedHistory();
      flashSaved(result.diagnostics);
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } });
    // In the multiline description, plain Enter inserts a newline; ⌘/Ctrl+Enter commits.
    descInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); commit(); } });
    const pop = h('div', { class: 'save-popover' },
      h('div', { class: 'sp-label' }, 'Save query as'),
      input,
      h('div', { class: 'sp-label' }, 'Description', h('span', { class: 'sp-opt' }, ' — optional')),
      descInput,
      h('div', { class: 'sp-actions' },
        h('button', { class: 'sp-cancel', onclick: () => close() }, 'Cancel'),
        h('button', { class: 'sp-save', onclick: commit }, 'Save')));
    ({ close } = deps.anchoredPopover(pop, deps.saveBtn()!, 'savePopover'));
    setTimeout(() => { input.focus(); input.select(); });
  }

  return { updateSaveBtn, saveActiveQuery, openConflictChooser, openSavePopover };
}
