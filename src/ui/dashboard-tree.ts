// The Dashboard hierarchy tree's DOM, ARIA, gestures and keyboard (#426).
// Renders into `app.dom.dashboardTreeList`.
//
// Every structural decision — order, labels, counts, expansion, search matching,
// invalid annotations, current-resource marking, and each row's COMMAND SET —
// belongs to `application/dashboard-tree-model.ts`. This module renders that flat
// row list 1:1 and dispatches the commands it is handed; it never re-derives
// structure and never reaches into the Dashboard renderer's DOM (navigation goes
// through `app.openDashboard` / `app.openSavedQuery` only).
//
// #447: the second level is Variables (inferred), not curated Filters, and a
// variable row carries two things a member row never had — a status word plus a
// severity-specific marker, and (for an orphaned configuration only) a trailing
// trash button that confirms before it deletes. Both of those still come from the
// model's row: the only judgement made here is how to PAINT them.
//
// Row CSS reuses the schema tree's `.tree-row` grammar (chevron · icon · label ·
// meta) deliberately: DESIGN.md asks for one tree vocabulary, and the two trees
// then stay visually identical for free. The MARKUP is built here rather than
// shared with `ui/schema.ts`'s private `treeRow` helper, because these rows need
// `role="treeitem"`, `aria-level`, a chevron that is its own disclosure BUTTON, and
// a trailing action menu — enough divergence that sharing would mean parameterising
// that helper into something neither caller reads clearly.
//
// #429/#472: a Dashboard row is THREE independent targets — the disclosure button
// expands, the primary row content opens View (Shift opens Edit), and the trailing
// control acts without doing either. The delayed single/double arbitration that
// #426 needed there is gone, because expansion and navigation no longer compete for
// one gesture; a PANEL row still arbitrates, its gestures being unchanged.

import { h } from './dom.js';
import { Icon } from './icons.js';
import { openMenu } from './menu.js';
import { flashToast } from './toast.js';
import { LIBRARY_QUERY_MIME } from './dnd-mime.js';
import { discardVariableDraft, reconcileVariableTab } from './tabs.js';
import { createClickArbiter, type ClickArbiter } from '../core/tree-click-arbiter.js';
import {
  UNUSED_VARIABLE_STATUS, deriveDashboardTree, tileRowKey,
  type DashboardTreeAction, type DashboardTreeActionKind, type DashboardTreeActionTarget,
  type DashboardTreeCommand, type DashboardTreeInvalid, type DashboardTreeRow, type TreeWorkspace,
} from '../application/dashboard-tree-model.js';
import { commitVariableConfig } from '../application/dashboard-variable-config.js';
import type { VariableConfigOutcome } from '../application/dashboard-variable-config.js';
import { commitDashboardRename } from '../application/dashboard-title.js';
import type { DashboardRenameOutcome } from '../application/dashboard-title.js';
import {
  commitDashboardRemoval, commitPanelRemoval, dashboardDeleteMessage,
} from '../application/dashboard-delete.js';
import type { DashboardDeleteOutcome } from '../application/dashboard-delete.js';
import { commitPanelQueryMetadata } from '../application/dashboard-panel-metadata.js';
import type {
  PanelMetadataDeps, PanelMetadataOutcome,
} from '../application/dashboard-panel-metadata.js';
import { closeOpenDialogShell, openMetadataDialog } from './dialog-shell.js';
import {
  assignLibraryQuerySqlToVariable, assignLibraryQueryToPanel, libraryAssignmentMessage,
} from '../application/library-assignment-service.js';
import type { LibraryAssignmentDeps } from '../application/library-assignment-service.js';
import { decodeLibraryQueryPayload, type LibraryDropTarget } from '../core/library-drag.js';
import {
  clampKeyboardRow, readTreeUi, setDashboardExpanded, setGroupExpanded, setKeyboardRow,
  setTreeScroll, toggleDashboardExpanded, toggleGroupExpanded,
  type DashboardTreeUiState,
} from '../core/dashboard-tree-ui-state.js';
import type { AppState } from '../state.js';
import type { App, AppDom } from './app.types.js';
import type { MainSurfaceState, OpenDashboardRequest } from '../application/main-surface.js';

/** The narrow slice of the real `app` controller this module reads — not the full
 *  `App` contract. A real `App` satisfies it directly, and so does the unit
 *  fixture (same convention as `ui/schema.ts`'s `SchemaApp`). */
export interface DashboardTreeApp {
  dom: Pick<AppDom, 'dashboardTreeList' | 'dashboardSearchInput'>;
  state: AppState;
  /** Read-only: the tree is a projection of the COMMITTED aggregate. */
  currentWorkspace: TreeWorkspace | null;
  mainSurface: MainSurfaceState;
  openDashboard(request: OpenDashboardRequest): void;
  openSavedQuery(queryId: string): void;
  /** #457: open (or re-select) the main-editor tab that edits one variable's
   *  option SQL. Replaced the drawer this tree used to mount — the tree now only
   *  routes, exactly as it does for a saved query. */
  openVariableTab(dashboardId: string, variableName: string): void;
  /** #447: the ONE write this otherwise read-only tree performs — deleting an
   *  orphaned variable's stored option SQL, through the same
   *  read-latest-at-dequeue primitive every other producer commits with. */
  mutateWorkspace: App['mutateWorkspace'];
  /** #447 phase 2: asks a rendered Dashboard to rebuild from committed truth
   *  after that delete, since a viewer session reads `variableConfigs` only at
   *  construction. Declared here because the delete commits through
   *  `commitVariableConfig`, which reports its commit — the tree never calls it
   *  directly. `app.ts` always binds it (a no-op outside the Dashboard surface). */
  onWorkspaceExternallyChanged: App['onWorkspaceExternallyChanged'];
  /** #428: mints the ids a panel assignment needs, through the same injected
   *  `crypto.randomUUID` seam every other producer uses. */
  genId: App['genId'];
  /** #429 phase 3: the modal keyboard-owner stack the Dashboard-row rename
   *  pencil's dialog acquires — the same seam every other body-mounted
   *  overlay (File menu's dialogs, the shortcuts sheet) uses. */
  acquireKeyboardOwner: App['acquireKeyboardOwner'];
  /** #494: the Spec validation service a panel-metadata write runs the patched
   *  entry AND every linked draft through, inside the commit transform — the
   *  same injected seam the Library row's pencil passes to `renameSaved`. */
  specValidators: App['specValidators'];
  document?: Document;
  /** The window whose timers back the click arbiter; defaults to the row's own. */
  window?: Pick<Window, 'setTimeout' | 'clearTimeout'>;
  /** Module-private mutable state stashed per app instance (so tests stay
   *  isolated), matching `ui/schema.ts`'s `_schemaClick` precedent. */
  _dashTreeArbiter?: ClickArbiter | null;
  /** #428: the row key currently under a Library drag, so the active-target
   *  class survives the repaint an auto-expand causes. */
  _dashTreeDropKey?: string | null;
  /** #428: the pending hover auto-expand, with the row that armed it — so one
   *  row's departure cannot cancel another row's timer. */
  _dashTreeHover?: { key: string; handle: number } | null;
  /** #494: the rows this app last PAINTED. A panel delete has to decide where
   *  keyboard focus goes next (next sibling → previous → the Panels group),
   *  and "next" means next on screen — a search can be filtering siblings out,
   *  and focus must never land on a row the user cannot see. */
  _dashTreeRows?: readonly DashboardTreeRow[];
}

/** Indent per level, on top of `.tree-row`'s own 10px padding. */
const INDENT_PX = 14;
const OPEN_ROTATE = 'rotate(0deg)';
const CLOSED_ROTATE = 'rotate(-90deg)';
/** #429/#472: the disclosure BUTTON, on top of the shared `.chev` box the schema
 *  tree also paints. Named once — the roving tabindex sync selects on it. */
const CHEVRON_CLASS = 'dash-tree-chev';

/** #447: `Icon.braces()` for the Variables group AND for a variable row — a
 *  variable IS a `{name:Type}` placeholder, so the brace glyph names it exactly,
 *  and it reads distinctly from Panels' stacked `Icon.layers()`. (The old
 *  `Icon.eye()` filter glyph described a *selection* control, which a variable is
 *  not; no new icon file was added.) */
const rowIcon = (row: DashboardTreeRow): SVGElement => {
  if (row.kind === 'dashboard') return Icon.dashboard();
  if (row.kind === 'group') return row.group === 'variables' ? Icon.braces() : Icon.layers();
  return row.kind === 'panel' ? Icon.chart() : Icon.braces();
};

/**
 * The accessible name of a row's status marker. The three states get THREE
 * different labels, because a screen-reader user has to be able to tell a
 * missing query from a type conflict from an unused configuration — colour and a
 * shared "warning" label would collapse all three into one. `title` (the row's
 * own diagnostic) then carries the detail.
 */
const STATUS_LABELS: Record<Exclude<DashboardTreeInvalid, null>, string> = {
  'unresolved-query': 'Broken reference',
  'variable-conflict': 'Type conflict',
  'variable-unused': 'Unused',
};

/**
 * The row's OWN announcement, stated explicitly rather than left to name-from-content.
 *
 * A `treeitem` takes its accessible name from its contents — and since #429/#472 those
 * contents include a LABELLED BUTTON. Measured in Chromium
 * (`Accessibility.getPartialAXTree`, not assumed): a screen reader arrowing onto the row
 * announced *"Expand Sales revenue Sales revenue 2"*, and *"Collapse Sales revenue Sales
 * revenue 2 Actions for Sales revenue"* once focus revealed the `⋯`. The chevron's and
 * the menu's names were being swallowed into the row's, which is the opposite of #472's
 * "three independent targets, each … separately announced". An explicit name stops the
 * content walk at the row.
 *
 * Composed from the MODEL's strings, in the order the row paints them — name, count,
 * status word, trailing meta, marker label — so it cannot drift from what is on screen,
 * and nothing that was announced before is lost. The `title` diagnostic is unaffected:
 * it was never the name (content won), and it stays the tooltip and the description.
 */
const rowAccessibleName = (row: DashboardTreeRow): string => [
  row.label,
  row.count === null ? '' : String(row.count),
  row.invalid === 'variable-unused' ? UNUSED_VARIABLE_STATUS : '',
  row.meta,
  row.invalid === null ? '' : STATUS_LABELS[row.invalid],
].filter((part) => part !== '').join(' ');

/**
 * Keep Enter/Space on a nested action button from ALSO reaching the tree's own
 * keyboard handler (#495 review 1).
 *
 * The tree's `keydown` listener lives on the LIST, and its Enter arm calls
 * `preventDefault()` and runs the focused ROW's primary command. A button
 * inside that row is a descendant, so without this its Enter bubbled up and
 * did two wrong things at once: it ran the row's action (for a Dashboard row,
 * navigating away), and the `preventDefault()` suppressed the browser's own
 * key-to-click synthesis, so the button's actual job might never happen.
 *
 * Propagation is stopped but the default is NOT prevented, which is the whole
 * point: native activation still fires — exactly once, on keydown for Enter
 * and on keyup for Space — so each control keeps standard button semantics
 * instead of re-implementing them. The chevron is the one exception and wires
 * its own handler: it must also `preventDefault()`, because it toggles
 * directly and would otherwise be re-toggled by the synthesized click.
 *
 * `handleTreeKeydown` independently ignores anything that did not originate on
 * a row. Two layers, deliberately: this one keeps each button self-contained,
 * that one holds even for a control that forgets to install this.
 */
const isolateActivationKeys = (event: KeyboardEvent): void => {
  if (event.key === 'Enter' || event.key === ' ') event.stopPropagation();
};

/** One arbiter per app instance, surviving the repaints that replace every row. */
function arbiterFor(app: DashboardTreeApp): ClickArbiter {
  if (!app._dashTreeArbiter) {
    const win = app.window ?? globalThis;
    app._dashTreeArbiter = createClickArbiter({
      setTimeout: (fn, ms) => win.setTimeout(fn, ms) as unknown as number,
      clearTimeout: (handle) => win.clearTimeout(handle),
    });
  }
  return app._dashTreeArbiter;
}

/** Drop a deferred single-click action. Called when the tree is disposed and when
 *  the workspace or sidebar role changes — a pending "open this query" must never
 *  fire against a tree the user has navigated away from. */
export function cancelDashboardTreeClicks(app: DashboardTreeApp): void {
  app._dashTreeArbiter?.cancel();
  // #428: a pending hover auto-expand is deferred tree state on exactly the same
  // footing, and must not outlive the workspace/role it was armed against.
  endLibraryDrag(app);
}

// ── #428: Library-query drop targets ────────────────────────────────────────
// Which rows accept a drop is the MODEL's decision (`row.dropTarget`); this
// section owns only the gestures — hover feedback, bounded auto-expand, and
// dispatching the two application commands.
//
// Feedback deliberately avoids app state and therefore avoids repaints. A
// repaint calls `list.replaceChildren()`, which during a drag destroys the row
// under the pointer: `dragleave` never fires for a removed node, and Firefox
// stops delivering `dragover` until the pointer moves again. So eligibility is
// STATIC markup (`data-droptarget`, emitted every paint whether or not a drag is
// happening) switched on by one class on the list, and the active target is a
// class re-applied from `app._dashTreeDropKey` after any paint.

/** Class on the tree list while a Library drag is in flight; CSS uses it to
 *  reveal the eligible rows that are already marked in the markup. */
const DRAGGING_CLASS = 'dash-dragging';
/** Class on the one row the pointer is currently over. */
const DROP_TARGET_CLASS = 'dash-drop-target';
/** How long the pointer must rest on a collapsed row before it opens. Long
 *  enough not to fire while crossing rows on the way somewhere else, short
 *  enough not to feel stuck. */
const HOVER_EXPAND_MS = 600;

const treeWindow = (app: DashboardTreeApp): Pick<Window, 'setTimeout' | 'clearTimeout'> =>
  app.window ?? globalThis;

/**
 * Drop a pending hover expansion. `key` scopes it to one row's own timer, the
 * way `ClickArbiter.cancelFor` does — and for the same reason: per the HTML drag
 * model `dragenter` on the NEW target fires before `dragleave` on the old one, so
 * an unscoped cancel would let row B arm its timer and then have row A's
 * departure immediately cancel it, costing a whole `dragover` tick before B
 * re-arms. Omit `key` to cancel whatever is pending.
 */
function cancelHoverExpand(app: DashboardTreeApp, key?: string): void {
  const pending = app._dashTreeHover;
  if (!pending || (key !== undefined && pending.key !== key)) return;
  treeWindow(app).clearTimeout(pending.handle);
  app._dashTreeHover = null;
}

/** Paint the active-target class on exactly one row, clearing any previous one.
 *  Re-run after every paint, since the class lives on a node the paint replaced. */
function paintDropTarget(app: DashboardTreeApp): void {
  const list = app.dom.dashboardTreeList;
  if (!list) return;
  for (const marked of list.querySelectorAll('.' + DROP_TARGET_CLASS)) {
    marked.classList.remove(DROP_TARGET_CLASS);
  }
  const key = app._dashTreeDropKey;
  if (key == null) return;
  list.querySelector('[data-key="' + CSS.escape(key) + '"]')?.classList.add(DROP_TARGET_CLASS);
}

/** A Library row started dragging: reveal every eligible destination (#428).
 *  Clears first, because `dragend` is not guaranteed — a source row removed
 *  mid-drag by a background `renderSavedHistory` repaint can swallow it, which
 *  would otherwise leave the previous drag's state painted here forever. */
export function beginLibraryDrag(app: DashboardTreeApp): void {
  endLibraryDrag(app);
  app.dom.dashboardTreeList?.classList.add(DRAGGING_CLASS);
}

/**
 * Drop every trace of an assignment drag: the eligible-target reveal, the active
 * row mark, and any pending hover expansion.
 *
 * Called from the Library row's `dragend` — which covers a drop, a cancel, and
 * Escape, since the browser consumes keydown during a native drag and delivers
 * `dragend` instead — and from `cancelDashboardTreeClicks`, which is the tree's
 * existing "this state must not outlive the thing it belonged to" hook (workspace
 * switch, sidebar role change, dispose).
 *
 * That second caller is not belt-and-braces. A pending hover timer holds a row
 * captured before the change: firing it after a workspace refresh would write
 * expansion for a Dashboard the refresh had just pruned, resurrecting exactly the
 * state `applyCommittedWorkspace` removed — the same class of bug the click
 * arbiter is cancelled there to prevent.
 */
export function endLibraryDrag(app: DashboardTreeApp): void {
  cancelHoverExpand(app);
  app._dashTreeDropKey = null;
  app.dom.dashboardTreeList?.classList.remove(DRAGGING_CLASS);
  paintDropTarget(app);
}

/** Whether this drag is one we accept. Only `types` is readable during
 *  `dragover` — the payload itself stays sealed until `drop` — so eligibility
 *  can never depend on the payload's contents. */
const carriesLibraryQuery = (event: DragEvent): boolean =>
  !!event.dataTransfer && [...event.dataTransfer.types].includes(LIBRARY_QUERY_MIME);

const readUi = (app: DashboardTreeApp): DashboardTreeUiState =>
  readTreeUi(app.state.dashboardTreeUi, app.currentWorkspace?.id ?? '');

/** Store new UI state and repaint. Every mutation goes through here, so the tree
 *  can never be left showing state it does not hold. */
function commitUi(app: DashboardTreeApp, next: DashboardTreeUiState): void {
  app.state.dashboardTreeUi.set(app.currentWorkspace?.id ?? '', next);
  renderDashboardTree(app);
}

/**
 * Expand/collapse a GROUP row — the only kind that still reaches here, and the only
 * kind whose primary action is expansion at all. #429/#472 gave the Dashboard row's
 * press to navigation, so the model emits `{ kind: 'toggle' }` for a group row and
 * nothing else; a Dashboard row is expanded from its chevron
 * (`toggleFromChevron`) or the arrow keys (`expand`), never through a command. That
 * is why `row.group` is asserted rather than branched on — a Dashboard arm here
 * would be unreachable.
 */
function toggleGroupRow(app: DashboardTreeApp, row: DashboardTreeRow): void {
  commitUi(app, toggleGroupExpanded(readUi(app), row.dashboardId, row.group!));
}

/**
 * Toggle from the disclosure control (#429/#472), which owes two things a bare
 * `toggleRow` does not.
 *
 * The keyboard owner MOVES to this row — the same reason the row's own click moves
 * it: the user just operated this row, so Tab and the arrow keys must continue from
 * here rather than from wherever they were. It also makes the chevron's own
 * `tabindex` 0, which is what keeps focus restoration below on a control that is
 * still in the Tab order.
 *
 * And focus returns to the CHEVRON, because `commitUi` repaints through
 * `replaceChildren` and the button that was just activated is gone. Landing on the
 * row instead would mean one Space expands and the next Enter *navigates* — which is
 * exactly the "toggles expansion only" contract broken by a focus side effect.
 * Both writes go in one `commitUi`, so this is a single repaint.
 *
 * It deliberately does NOT cancel this row's pending single the way #426's chevron
 * did. Only a row with a `double` is ever arbitrated, and since the split that means
 * a PANEL row — which has no chevron. So there is nothing left for this key to
 * cancel, and a `cancelFor` here would be a guard against a hazard the split
 * removed. Another row's pending action is untouched either way, as #426 requires.
 */
function toggleFromChevron(app: DashboardTreeApp, row: DashboardTreeRow): void {
  const ui = setKeyboardRow(readUi(app), row.key);
  commitUi(app, row.group === null
    ? toggleDashboardExpanded(ui, row.dashboardId)
    : toggleGroupExpanded(ui, row.dashboardId, row.group));
  focusChevron(app.dom.dashboardTreeList!, row.key);
}

/**
 * Open a collapsed row the pointer has rested on, so its members become
 * reachable without dropping first (#428).
 *
 * A Dashboard row opens BOTH of its groups as well as itself. Expansion is
 * deliberately not gated on eligibility: the Variables group is not a valid drop
 * target (it does not identify which variable), yet a variable row only exists
 * once that group is open — so gating would make variable rows unreachable by
 * drag, which is exactly what the issue's "so Panels and Variables rows become
 * reachable" rules out.
 *
 * UI state only: no navigation, no workspace write. `setDashboardExpanded` and
 * `setGroupExpanded` return the same object when already in the wanted state, so
 * the identity check keeps a rested pointer from repainting on every `dragover`.
 */
function hoverExpand(app: DashboardTreeApp, row: DashboardTreeRow): void {
  const ui = readUi(app);
  const next = row.group === null
    ? setGroupExpanded(
      setGroupExpanded(setDashboardExpanded(ui, row.dashboardId, true), row.dashboardId, 'variables', true),
      row.dashboardId, 'panels', true,
    )
    : setGroupExpanded(ui, row.dashboardId, row.group, true);
  if (next === ui) return;
  commitUi(app, next);
  // `commitUi` repainted, so the row the pointer is over is a new node.
  paintDropTarget(app);
}

/**
 * The ONE command dispatcher. Four exhaustive branches with no null guards: the
 * model resolves every argument, so there is nothing here to defend against.
 */
function runCommand(app: DashboardTreeApp, row: DashboardTreeRow, command: DashboardTreeCommand): void {
  if (command.kind === 'toggle') { toggleGroupRow(app, row); return; }
  if (command.kind === 'open-query') { app.openSavedQuery(command.queryId); return; }
  if (command.kind === 'open-variable') {
    app.openVariableTab(command.dashboardId, command.name);
    return;
  }
  app.openDashboard(command.request);
}

/**
 * Land the tree on what a committed assignment just created: expand down to it,
 * make it the keyboard row, and scroll/focus it.
 *
 * The row is focused rather than merely given `tabindex="0"`, because
 * `renderDashboardTree` restores focus only when the tree ALREADY held it — after
 * a mouse drop it does not, so without this the new row would be the arrow-key
 * origin while being invisible and off-screen. The caller opens the assigned
 * document straight afterwards, which moves focus on to the editor; what this
 * leaves behind is the row scrolled into view and armed as the tree's position.
 *
 * It deliberately does NOT set `row.current`: that follows `mainSurface`, so
 * marking it would mean opening the Dashboard, which #428 rules out.
 */
function revealAssigned(app: DashboardTreeApp, dashboardId: string, rowKey: string, group: 'panels' | 'variables'): void {
  const ui = readUi(app);
  commitUi(app, setKeyboardRow(
    setGroupExpanded(setDashboardExpanded(ui, dashboardId, true), dashboardId, group, true),
    rowKey,
  ));
  const list = app.dom.dashboardTreeList;
  if (list) focusRow(list, rowKey);
}

/**
 * Reveal the Dashboard tree at one newly-created panel. Assignment callers use
 * this shared settlement so drag/drop and the Library chooser both switch the
 * upper sidebar role, expand the same ancestors, and arm the same keyboard row.
 */
export function revealAssignedPanel(
  app: DashboardTreeApp, dashboardId: string, tileId: string,
): void {
  app.state.upperRole.value = 'dashboards';
  revealAssigned(app, dashboardId,
    tileRowKey(app.currentWorkspace?.id ?? '', dashboardId, tileId), 'panels');
}

/**
 * Run one accepted drop. The tree never writes a workspace document itself: it
 * decodes, dispatches to the application command, and then reports.
 */
async function dispatchDrop(
  app: DashboardTreeApp, row: DashboardTreeRow, target: LibraryDropTarget, raw: string,
): Promise<void> {
  const payload = decodeLibraryQueryPayload(raw);
  if (payload === null) return;
  const doc = app.document ?? app.dom.dashboardTreeList?.ownerDocument;
  const deps: LibraryAssignmentDeps = {
    mutateWorkspace: app.mutateWorkspace,
    onWorkspaceExternallyChanged: app.onWorkspaceExternallyChanged,
    genId: app.genId,
    // A function, not a snapshot: the dirty-draft gate re-reads the tabs INSIDE
    // the transform, after the write queue and the store round-trip.
    readTabs: () => app.state.tabs.value,
  };

  if (target.kind === 'panel') {
    const outcome = await assignLibraryQueryToPanel(deps, payload, target.dashboardId);
    if (outcome.ok && outcome.data && outcome.data.status === 'ok') {
      revealAssignedPanel(app, target.dashboardId, outcome.data.tileId);
      // Owner decision (2026-07-27), replacing #428's "do not automatically
      // open": the point of dropping a query onto a Dashboard is to work on the
      // panel you just made, so its OWNED COPY opens in the editor. The copy, not
      // the Library original — editing the original would not touch the panel.
      // The Dashboard itself is still not opened, and nothing is executed.
      app.openSavedQuery(outcome.data.queryId);
    }
    const message = libraryAssignmentMessage(outcome);
    if (message !== null && doc) flashToast(message, { document: doc });
    return;
  }

  const outcome = await assignLibraryQuerySqlToVariable(
    deps, payload, target.dashboardId, target.variableName,
  );
  if (outcome.ok && outcome.data && outcome.data.status === 'ok') {
    const { sql, draftDiverged } = outcome.data;
    revealAssigned(app, target.dashboardId, row.key, 'variables');
    // Adopt the SQL the commit actually wrote — reported by the command, never
    // re-derived from the projection.
    if (!draftDiverged) reconcileVariableTab(app, target.dashboardId, target.variableName, sql);
    // Owner decision (2026-07-27): open the variable's own tab, so the assigned
    // option SQL is there to edit and run.
    app.openVariableTab(target.dashboardId, target.variableName);
    if (draftDiverged && doc) {
      // The in-transform gate passed and the user then typed while the commit was
      // in flight (see the service's own note — no check can close that window).
      // The write is durable and the draft is untouched, and they disagree. Saying
      // nothing would leave the next Save silently reverting the assignment, so
      // this toast persists until acted on and offers the one-click resolution.
      flashToast('Assigned, but this tab has unsaved changes that differ. Saving it will replace the assigned SQL.', {
        document: doc,
        action: {
          label: 'Discard draft',
          onClick: () => discardVariableDraft(app, target.dashboardId, target.variableName, sql),
        },
      });
    }
    return;
  }
  if (outcome.data && outcome.data.status === 'declined'
    && outcome.data.reason === 'variable-tab-dirty') {
    // The one rejection that names a place to go: focus the draft we refused to
    // overwrite, so the user can save or discard it and try again.
    app.openVariableTab(target.dashboardId, target.variableName);
  }
  const message = libraryAssignmentMessage(outcome);
  if (message !== null && doc) flashToast(message, { document: doc });
}

/** Every drag handler one row needs, or nothing at all for a row that rejects
 *  assignment — an ineligible row installs no listeners and never calls
 *  `preventDefault`, so the drag falls through to native behaviour instead of
 *  looking droppable and silently doing nothing. */
function dropProps(app: DashboardTreeApp, row: DashboardTreeRow): Record<string, unknown> {
  const target = row.dropTarget;
  // A collapsed row still hover-expands even when it rejects drops (the
  // Variables group is the case that matters), so the two are wired separately.
  const expandable = row.expandable && !row.expanded;
  if (target === null && !expandable) return {};

  const armHover = (): void => {
    if (!expandable) return;
    // Already counting down for THIS row: `dragover` repeats every ~350ms while
    // the pointer rests, and re-arming per event would push the expansion out
    // forever.
    if (app._dashTreeHover?.key === row.key) return;
    // Counting down for a DIFFERENT row: take over. Per the HTML drag model
    // `dragenter` here fires before the old row's `dragleave`, so leaving the old
    // timer in place would make this row wait a whole extra `dragover` tick.
    cancelHoverExpand(app);
    app._dashTreeHover = {
      key: row.key,
      handle: treeWindow(app).setTimeout(() => {
        app._dashTreeHover = null;
        hoverExpand(app, row);
      }, HOVER_EXPAND_MS) as unknown as number,
    };
  };

  const over = (event: DragEvent): void => {
    if (!carriesLibraryQuery(event)) return;
    armHover();
    if (target === null) return;
    // Accepting the drop. Without this the browser rejects it and no `drop`
    // event is delivered at all.
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    if (app._dashTreeDropKey === row.key) return;
    app._dashTreeDropKey = row.key;
    paintDropTarget(app);
  };

  return {
    ondragenter: over,
    ondragover: over,
    ondragleave: (event: DragEvent) => {
      // The row has eight child spans and drag events bubble, so a bare
      // `dragleave` fires every time the pointer crosses onto one of them.
      const to = event.relatedTarget;
      const rowEl = event.currentTarget as HTMLElement;
      if (to instanceof Node && rowEl.contains(to)) return;
      cancelHoverExpand(app, row.key);
      if (app._dashTreeDropKey !== row.key) return;
      app._dashTreeDropKey = null;
      paintDropTarget(app);
    },
    // Installed ONLY on a row that accepts: a row whose `dragover` never called
    // `preventDefault` is never sent a `drop` by the browser, so a handler with
    // an "am I a target?" guard inside it would carry a branch nothing but a
    // synthesized event could reach.
    ...(target === null ? {} : {
      ondrop: (event: DragEvent) => {
        if (!carriesLibraryQuery(event)) return;
        event.preventDefault();
        // The drop is handled here and nowhere else. #428 also cancelled this row's
        // deferred single-click, because the arbiter could be holding an "open this
        // dashboard" that would fire ~300ms after the drop and navigate away from
        // the tree; #429/#472 removed that hazard at the source. Only a row with a
        // double-click action is arbitrated at all, which now means a PANEL row —
        // and a panel row accepts no drop, so there is no pending action left here
        // to cancel.
        event.stopPropagation();
        const raw = event.dataTransfer!.getData(LIBRARY_QUERY_MIME);
        endLibraryDrag(app);
        void dispatchDrop(app, row, target, raw);
      },
    }),
  };
}

export function renderDashboardTree(app: DashboardTreeApp): void {
  const list = app.dom.dashboardTreeList;
  if (!list) return;
  const doc = app.document ?? list.ownerDocument;

  // The search box is built ONCE and outside this list (so typing keeps the caret),
  // which means it does not follow a workspace switch on its own: the tree would
  // filter by the new workspace's search text while the input still displayed the
  // old one — or show a stale filter with a blank box on the way back. Guarded on
  // inequality so the ordinary repaint never touches the caret.
  const search = app.dom.dashboardSearchInput;
  if (search && search.value !== readUi(app).searchText) search.value = readUi(app).searchText;

  const tree = deriveDashboardTree({
    workspace: app.currentWorkspace, surface: app.mainSurface, ui: readUi(app),
  });
  // A row can leave the visible set without anything being removed — a collapsed
  // ancestor, or a search that filtered it out — so the roving tabindex owner is
  // re-validated against what is actually rendered, on every paint.
  const ui = clampKeyboardRow(readUi(app), tree.rows.map((row) => row.key));
  app.state.dashboardTreeUi.set(app.currentWorkspace?.id ?? '', ui);

  // Restore focus after the rebuild ONLY if the tree already had it. A background
  // workspace refresh repaints too, and must not steal focus from the editor.
  const keptFocus = list.contains(doc.activeElement);

  list.replaceChildren();
  app._dashTreeRows = tree.rows;
  if (tree.rows.length === 0) {
    list.appendChild(h('div', { class: 'schema-empty' }, tree.empty === 'no-dashboards'
      ? 'No dashboards in this workspace.'
      : 'No matching dashboards, variables, or panels.'));
    return;
  }

  for (const row of tree.rows) {
    list.appendChild(buildRow(app, doc, row, ui));
  }

  list.scrollTop = ui.scrollTop;
  if (keptFocus) focusRow(list, ui.keyboardRowKey);
  // #428: the active drop target is a class on a node this paint just replaced,
  // so it has to be re-applied. A no-op unless a drag is in flight.
  paintDropTarget(app);

  // Assigned (not added) every paint, so this is idempotent across repaints.
  list.onkeydown = (event: KeyboardEvent) => handleTreeKeydown(app, tree.rows, event);
  list.onscroll = () => {
    // Non-reactive by design: recording the scroll position must not repaint.
    app.state.dashboardTreeUi.set(
      app.currentWorkspace?.id ?? '', setTreeScroll(readUi(app), list.scrollTop),
    );
  };
}

function buildRow(
  app: DashboardTreeApp, doc: Document, row: DashboardTreeRow, ui: DashboardTreeUiState,
): HTMLElement {
  const chevron = buildChevron(app, row, ui);

  const label = h('span', { class: 'label' }, row.label);
  const count = row.count === null
    ? null
    : h('span', { class: 'side-count dash-tree-count' }, '· ' + row.count);
  // #447: the WORD, not only a colour — an unused (orphaned) variable says so in
  // text, right after its name.
  const status = row.invalid === 'variable-unused'
    ? h('span', { class: 'dash-tree-status' }, UNUSED_VARIABLE_STATUS)
    : null;
  // Warning severity gets its OWN glyph as well as its own label and class: two
  // states that differ only in hue are one state to most readers.
  const marker = row.invalid === null
    ? null
    : h('span', {
      class: row.severity === 'warning' ? 'dash-tree-warn dash-tree-warn-mild' : 'dash-tree-warn',
      role: 'img',
      'aria-label': STATUS_LABELS[row.invalid],
    }, row.severity === 'warning' ? Icon.eyeOff() : Icon.shield());

  const rowEl = h('div', {
    class: 'tree-row dash-tree-row'
      + (row.kind === 'dashboard' ? ' bold' : '')
      + (row.kind === 'group' ? ' dash-tree-group' : '')
      + (row.matched ? ' match' : '')
      + (row.current ? ' is-current' : '')
      + (row.severity === 'error' ? ' is-invalid' : '')
      + (row.severity === 'warning' ? ' is-warning' : ''),
    'data-key': row.key,
    // #428: eligibility is STATIC markup, present whether or not a drag is in
    // flight, so revealing it costs one class on the list instead of a repaint
    // that would destroy the row under the pointer mid-drag.
    ...(row.dropTarget === null ? {} : { 'data-droptarget': row.dropTarget.kind }),
    ...dropProps(app, row),
    role: 'treeitem',
    // Explicit, so the chevron's and the `⋯`'s own names stay THEIRS (see
    // `rowAccessibleName`) rather than being folded into this row's.
    'aria-label': rowAccessibleName(row),
    'aria-level': String(row.level),
    ...(row.expandable ? { 'aria-expanded': row.expanded ? 'true' : 'false' } : {}),
    // Roving tabindex: exactly one row is in the Tab order.
    tabindex: row.key === ui.keyboardRowKey ? '0' : '-1',
    style: { paddingLeft: (10 + (row.level - 1) * INDENT_PX) + 'px' },
    // Doubles as the tooltip and the accessible description for a broken row.
    ...(row.diagnostic === null ? {} : { title: row.diagnostic }),
    ...(row.current ? { 'aria-current': 'true' } : {}),
    onclick: (event: MouseEvent) => {
      // The keyboard owner follows the pointer, so Tab lands where the user last
      // clicked rather than back at the top of the tree. The DOM is synced in the
      // same breath: a member row's repaint is a deferred ~300ms away, and until it
      // lands the visible focus ring and the arrow-key origin would disagree.
      app.state.dashboardTreeUi.set(
        app.currentWorkspace?.id ?? '', setKeyboardRow(readUi(app), row.key),
      );
      syncRovingTabindex(rowEl.parentElement, row.key);
      pressRow(app, row, event.shiftKey);
    },
  }, chevron, h('span', { class: 'icon' }, rowIcon(row)), label, count, status,
    h('span', { class: 'meta' }, row.meta), marker,
    // #494: the trailing DIRECT controls, in the model's own order — edit
    // before delete, destructive rightmost. There is no `⋯` any more.
    row.actions.map((act) => buildActionButton(app, doc, row, act)));

  return rowEl;
}

/**
 * The disclosure control — #429/#472 promoted it from a click handler on a span to
 * a real `<button>`, because it is now one of the row's THREE independent targets
 * rather than a shortcut past the row's own delayed toggle. That buys it an
 * accessible name of its own (*Expand Executive* / *Collapse Executive*), its own
 * `aria-expanded`, its own focus ring, and native Enter/Space semantics.
 *
 * The row keeps `aria-expanded` too, and deliberately: the `treeitem` is what a
 * screen reader announces while walking the tree, and this is what it announces
 * when the button itself has focus. They are painted from the same `row.expanded`,
 * so they cannot disagree.
 *
 * A row a search is holding open is NOT toggleable, so it stays a plain span — no
 * affordance, no button, no accessible name that lies about what it can do
 * (retained from #426). Non-expandable rows keep the same span as the layout
 * spacer they have always been.
 */
function buildChevron(
  app: DashboardTreeApp, row: DashboardTreeRow, ui: DashboardTreeUiState,
): HTMLElement {
  // The rotation goes on the GLYPH, never on the control. Hit-testing and
  // `getBoundingClientRect` both use the TRANSFORMED box, and this control is a
  // 10×24 button (it stretches to the row's height so a 10px glyph is still worth
  // aiming at) — rotating that by 90° would turn its clickable band into 24 wide by
  // 10 tall, spilling 7px each side and swallowing clicks meant for the row icon
  // beside it. The schema tree's chevron gets away with rotating its own box only
  // because it is a 10×10 square, which rotation leaves unchanged. Asserted in a
  // real browser (`tests/e2e/dashboard-tree.spec.js`) — happy-dom has no layout.
  const glyph = row.expandable ? Icon.chevDown() : null;
  if (glyph !== null) glyph.style.transform = row.expanded ? OPEN_ROTATE : CLOSED_ROTATE;
  if (!row.toggleable) return h('span', { class: 'chev' }, glyph);
  return h('button', {
    class: 'chev ' + CHEVRON_CLASS,
    type: 'button',
    'aria-expanded': row.expanded ? 'true' : 'false',
    'aria-label': (row.expanded ? 'Collapse ' : 'Expand ') + row.label,
    // Roving with its own row, exactly like the row element: the tree is ONE
    // composite tab stop, so Tab walks the focused row's three targets and then
    // leaves — it never offers a stop per chevron for the whole collection.
    tabindex: row.key === ui.keyboardRowKey ? '0' : '-1',
    onclick: (event: MouseEvent) => {
      // Expansion ONLY: without this the press would bubble to the row, which now
      // opens the Dashboard.
      event.stopPropagation();
      toggleFromChevron(app, row);
    },
    onkeydown: (event: KeyboardEvent) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      // Keeps the browser from ALSO synthesising a click from this key (which would
      // toggle straight back) and, for Space, from scrolling the sidebar.
      event.preventDefault();
      // The tree's key handler lives on the LIST and its Enter opens the row's
      // primary action — the Dashboard. Expansion must be all this key does.
      event.stopPropagation();
      toggleFromChevron(app, row);
    },
  }, glyph);
}

/**
 * Route one primary press. The arbiter — and with it the ~300ms wait — is for rows
 * that have a DOUBLE-click action to arbitrate against, which since #429/#472 means
 * a panel row only.
 *
 * Everything else acts at once: a group row (expansion), a variable row (its option
 * SQL), and now a Dashboard row, whose expansion moved to the chevron so its
 * primary press can open the Dashboard with no delay. A Shift press on such a row
 * runs its Shift action directly — for a Dashboard that is Edit mode; for a row
 * with none, Shift is simply ignored and the primary action runs, as before.
 */
function pressRow(app: DashboardTreeApp, row: DashboardTreeRow, shift: boolean): void {
  if (row.double === null) {
    app._dashTreeArbiter?.cancelFor(row.key);
    const command = shift && row.shift !== null ? row.shift : row.single;
    if (command !== null) runCommand(app, row, command);
    return;
  }
  // Every row that reaches the arbiter has BOTH a double and a Shift action — the
  // early return above took the only kinds that lack one — so only `single` (which
  // a panel with an unresolved query withholds) still needs a null check here.
  arbiterFor(app).press(row.key, {
    single: row.single === null ? null : () => runCommand(app, row, row.single!),
    double: () => runCommand(app, row, row.double!),
    immediate: shift ? () => runCommand(app, row, row.shift!) : null,
  });
}

/**
 * #494 — one trailing direct control, built from the model's resolved action.
 *
 * Every Dashboard/Panel operation is its own real `<button>` now: the `⋯`
 * overflow menu is gone from both, so nothing a row can do is hidden behind a
 * second press. The orphaned-variable trash (#447) came along, because it was
 * already exactly this shape and keeping it separate would have meant two ways
 * of saying "a trailing control".
 *
 * Availability is the MODEL's answer, never re-derived here (#494 forbids
 * reading capability off DOM classes): an unavailable action still renders, so
 * a Panel row's vocabulary does not silently shrink when its data is
 * malformed, but it announces `aria-disabled` and does nothing when pressed.
 * `aria-disabled` rather than `disabled` on purpose — the control stays
 * focusable, so a keyboard user can reach it and hear WHY.
 */
function buildActionButton(
  app: DashboardTreeApp, doc: Document, row: DashboardTreeRow, act: DashboardTreeAction,
): HTMLElement {
  // From the KIND, never from `act.confirm`: an UNAVAILABLE delete still has
  // to look and announce like a delete (#494 — a row's vocabulary must not
  // change with availability), and its `confirm` is null precisely because it
  // will never be asked.
  const destructive = act.kind !== 'edit-dashboard' && act.kind !== 'edit-panel';
  const trigger: HTMLButtonElement = h('button', {
    class: 'dash-tree-act'
      + (destructive ? ' dash-tree-act-danger' : '')
      // #447's control was always visible, and stays so: on a variable row the
      // trash IS the affordance that says an orphaned configuration can be
      // dropped, and #494 asks for that one to be preserved rather than
      // rebuilt. The Dashboard/Panel controls are revealed on hover and
      // `:focus-within`, matching the Library Query row.
      + (act.kind === 'delete-variable-config' ? ' dash-tree-act-static' : ''),
    type: 'button',
    'aria-haspopup': destructive ? 'menu' : 'dialog',
    'aria-expanded': 'false',
    'aria-label': act.label,
    title: act.tooltip,
    'data-act': act.kind,
    ...(act.unavailable === null ? {} : { 'aria-disabled': 'true' }),
    onkeydown: isolateActivationKeys,
    onclick: (event: MouseEvent) => {
      // Never the row's own gesture, and never a pending single of its own —
      // but #426 is explicit that this must cancel no UNRELATED row operation.
      event.stopPropagation();
      app._dashTreeArbiter?.cancelFor(row.key);
      runAction(app, doc, row, act, trigger);
    },
  }, act.kind === 'edit-dashboard' || act.kind === 'edit-panel' ? Icon.pencil() : Icon.trash());
  return trigger;
}

/**
 * Where a dialog opened from a row control hands focus back.
 *
 * The trigger while it is still on screen — the Cancel/Escape paths, where
 * nothing repainted. But a SUCCESSFUL commit repaints the tree before the
 * dialog closes (the write projects synchronously, and the tree's effect
 * rebuilds every row), which detaches that button; `renderDashboardTree`'s own
 * restore deliberately declines to help, because focus was inside the
 * body-mounted dialog rather than in the list. So the fallback is the ROW,
 * re-resolved by key: it is what the freshly painted control belongs to, and
 * unlike the rebuilt control it is not hidden behind hover/`:focus-within`.
 */
const returnFocusAfterDialog = (
  app: DashboardTreeApp, trigger: HTMLButtonElement, rowKey: string,
) => (): HTMLElement | null => {
  if (trigger.isConnected) return trigger;
  const list = app.dom.dashboardTreeList;
  const byKey = (key: string | null): HTMLElement | null => (key === null
    ? null
    : list?.querySelector<HTMLElement>('[data-key="' + CSS.escape(key) + '"]') ?? null);
  // The row the dialog belonged to, if it survived; else the tree's current
  // roving row — the resource can have been deleted from another tab while
  // this dialog was open, which is exactly when a stale dialog is closed;
  // else the search box, the one control the tree always has.
  return byKey(rowKey)
    ?? byKey(readUi(app).keyboardRowKey)
    ?? app.dom.dashboardSearchInput
    ?? null;
};

/** The confirm menu's own go-ahead label, per action. Short and specific: the
 *  question above it already named the resource, and "OK" next to a sentence
 *  full of names is where a destructive click gets made by accident. */
const CONFIRM_LABELS: Record<DashboardTreeActionKind, string> = {
  'edit-dashboard': '',
  'edit-panel': '',
  'delete-dashboard': 'Delete dashboard',
  'delete-panel': 'Remove panel',
  'delete-variable-config': 'Delete option SQL',
};

/**
 * Run one trailing control.
 *
 * An unavailable action does nothing at all — the model already said why, and
 * the button carries that reason as its tooltip and `aria-disabled` state.
 * Destructive actions never run straight from the press: they open the
 * confirmation this repo already uses for the same job (`openMenu`, anchored
 * on the trigger), which gives them a real `role="menuitem"`, an explicit
 * Cancel, Escape/outside-click dismissal and focus restored to the trigger.
 */
function runAction(
  app: DashboardTreeApp, doc: Document, row: DashboardTreeRow, act: DashboardTreeAction,
  trigger: HTMLButtonElement,
): void {
  const target = act.target;
  if (target === null) return;
  if (act.kind === 'edit-dashboard') { openDashboardMetadataDialog(app, doc, trigger, row); return; }
  if (act.kind === 'edit-panel') {
    openPanelMetadataDialog(app, doc, trigger, row, target as PanelActionTarget);
    return;
  }
  confirmDestructive(doc, trigger, act, () => runDestructive(app, doc, row, act, target));
}

/** The `panel` arm of `DashboardTreeActionTarget`, which the two panel actions
 *  are the only carriers of. Narrowed once here rather than with a guard at
 *  each use: the model pairs kind and target by construction. */
type PanelActionTarget = Extract<DashboardTreeActionTarget, { kind: 'panel' }>;

/** Ask before destroying something, anchored on the control that asked. */
function confirmDestructive(
  doc: Document, trigger: HTMLButtonElement, act: DashboardTreeAction, go: () => void,
): void {
  openMenu({
    document: doc,
    trigger,
    menuClass: 'dash-tree-confirm',
    rows: [
      { kind: 'section', label: act.confirm! },
      {
        kind: 'item',
        label: CONFIRM_LABELS[act.kind],
        extraClass: 'dash-tree-confirm-go',
        onClick: go,
      },
      // #501: the destructive row is listed FIRST (this app's visual
      // convention — the action reads top, Cancel second), but `openMenu`
      // autofocuses whichever row asks for it. A keyboard user who opens a
      // confirmation and presses Enter out of momentum must land on Cancel.
      {
        kind: 'item', label: 'Cancel', extraClass: 'dash-tree-confirm-cancel', autofocus: true,
        onClick: () => {},
      },
    ],
  });
}

/**
 * Dispatch a confirmed destructive action.
 *
 * All three are fire-and-forget for the same reason: a successful commit
 * reprojects the workspace and repaints the tree (and any rendered Dashboard)
 * on its own, and a refused one leaves nothing here to undo. What they do NOT
 * share is what happens to keyboard focus afterwards — removing the row the
 * user is standing on is the one case with somewhere specific to go.
 */
function runDestructive(
  app: DashboardTreeApp, doc: Document, row: DashboardTreeRow, act: DashboardTreeAction,
  target: DashboardTreeActionTarget,
): void {
  if (target.kind === 'variable-config') {
    void reportVariableConfigRemoval(
      doc, commitVariableConfig(app, target.dashboardId, target.name, null),
    );
    return;
  }
  // Decided BEFORE the commit, against the rows currently painted: once the
  // write lands, the row this focus decision is relative to no longer exists.
  const successor = focusSuccessorKey(app, row);
  if (act.kind === 'delete-dashboard') {
    void reportRemoval(app, doc, commitDashboardRemoval(app, target.dashboardId), successor);
    return;
  }
  const panel = target as PanelActionTarget;
  void reportRemoval(app, doc, commitPanelRemoval(app, {
    dashboardId: panel.dashboardId, tileId: panel.tileId, queryId: panel.queryId,
  }), successor);
}

/**
 * The Dashboard document's own title/description dialog, on the shared
 * two-field `openMetadataDialog` (`dialog-shell.ts` — the panel pencil below
 * is its second consumer, which is what moved it out of this module).
 *
 * Every unsuccessful outcome keeps the dialog open with the typed text intact
 * and reports inside it (#495 review 2). The first version closed the card
 * before starting the mutation and discarded the promise, so a Dashboard
 * deleted in another tab, a duplicate id, a validation rejection or a storage
 * failure all read as "the dialog just disappeared" — and took the user's
 * edits with it.
 */
function openDashboardMetadataDialog(
  app: DashboardTreeApp, doc: Document, trigger: HTMLButtonElement, row: DashboardTreeRow,
): void {
  // Kept visible for the dialog's whole lifetime, exactly like `buildMenuButton`'s
  // `[aria-expanded="true"]` CSS hook — by the time the dialog closes, the pointer
  // has typically moved onto the dialog's own controls, so neither `:hover` nor
  // `:focus-within` still holds on the row, and a `display: none` trigger cannot
  // receive the focus this dialog returns to it (only e2e catches this; happy-dom
  // enforces no CSS layout at all).
  //
  // Force-closed FIRST: `openMetadataDialog` → `openDialogShell` closes any
  // already-open dialog for us, and on a rapid second activation of THIS same
  // trigger that closing dialog's own `onClose` resets `aria-expanded` back to
  // `"false"` — clobbering the `"true"` below if it ran after. Closing here,
  // before setting the attribute, means that reset lands first and is
  // superseded rather than the other way round.
  closeOpenDialogShell();
  trigger.setAttribute('aria-expanded', 'true');
  const current = app.currentWorkspace?.dashboards?.find((d) => d.id === row.dashboardId);
  openMetadataDialog({ document: doc, acquireKeyboardOwner: app.acquireKeyboardOwner }, {
    title: 'Edit dashboard',
    nameLabel: 'Dashboard title',
    descriptionLabel: 'Dashboard description',
    name: current?.title ?? row.label,
    description: current?.description ?? '',
    confirmLabel: 'Save',
    idPrefix: 'dash-rename',
    returnFocusTo: returnFocusAfterDialog(app, trigger, row.key),
    onClose: () => trigger.setAttribute('aria-expanded', 'false'),
    onConfirm: async ({ name, description }) =>
      renameMessage(await commitDashboardRename(app, row.dashboardId, name, description)),
  });
}

/** What a Dashboard rename attempt has to say for itself — `null` when it
 *  committed and the dialog should close.
 *
 *  The two failures are deliberately different sentences: `declined` is the
 *  transform refusing because the Dashboard no longer resolves (deleted or
 *  duplicated while the dialog was open), which no retry can fix, and a
 *  rejection carries the aggregate's own validation/persistence diagnostic,
 *  which is about the values just entered. The missing-resource wording
 *  matches the one #429 phase 1 settled for `openSavedQuery`. */
const renameMessage = (outcome: DashboardRenameOutcome): string | null => {
  if (outcome.ok) return null;
  if (outcome.aborted) return 'That dashboard is no longer part of this workspace.';
  return outcome.diagnostics[0]?.message || 'Could not save this dashboard.';
};

/**
 * The panel pencil's dialog (#494): the same two fields, the same shell and
 * the same awaited-outcome contract as the Dashboard pencil above — but
 * editing the tile's dedicated OWNED QUERY, which is where a panel's displayed
 * name and description actually live.
 *
 * Prefilled from the committed query, never from the row's label: the label is
 * a resolved DISPLAY string, and for an imported tile that carries a local
 * `title` override it is the override rather than the query's own name. Typing
 * over it would silently rewrite the query to match a title it does not own.
 * When such an override exists the dialog says so instead, because the commit
 * genuinely will not change what the tile renders.
 */
function openPanelMetadataDialog(
  app: DashboardTreeApp, doc: Document, trigger: HTMLButtonElement, row: DashboardTreeRow,
  target: PanelActionTarget,
): void {
  // Same hover-reveal trap as the Dashboard pencil: the trigger is
  // `display: none` unless the row is hovered or holds focus, and `focus()` on
  // a `display: none` element is a silent no-op in a real browser.
  //
  // Force-closed FIRST — see the matching comment in
  // `openDashboardMetadataDialog`: on a rapid re-activation of this same
  // trigger, the previous dialog's `onClose` resets `aria-expanded` to
  // `"false"`, and that has to happen before this sets it `"true"`, not after.
  closeOpenDialogShell();
  trigger.setAttribute('aria-expanded', 'true');
  const query = app.currentWorkspace?.queries?.find((entry) => entry.id === target.queryId);
  const tile = app.currentWorkspace?.dashboards
    ?.find((dashboard) => dashboard.id === target.dashboardId)
    ?.tiles?.find((entry) => entry.id === target.tileId);
  // BOTH overrides mask, and independently: the viewer resolves a tile's
  // heading as `tile.title || query name` and its body text as
  // `tile.description || query description`
  // (`dashboard-viewer-session.ts`). An imported tile carrying only a
  // description would otherwise let the user edit a query description that
  // the rendered tile goes on ignoring, with nothing said.
  const maskedName = (tile?.title ?? '').trim() !== '';
  const maskedDescription = (tile?.description ?? '').trim() !== '';
  openMetadataDialog({ document: doc, acquireKeyboardOwner: app.acquireKeyboardOwner }, {
    title: 'Edit panel',
    nameLabel: 'Query name',
    descriptionLabel: 'Query description',
    name: query?.spec?.name ?? '',
    description: query?.spec?.description ?? '',
    confirmLabel: 'Save',
    idPrefix: 'panel-metadata',
    note: overrideNote(maskedName, maskedDescription),
    returnFocusTo: returnFocusAfterDialog(app, trigger, row.key),
    onClose: () => trigger.setAttribute('aria-expanded', 'false'),
    onConfirm: async ({ name, description }) => panelMetadataMessage(
      await commitPanelQueryMetadata(panelMetadataDeps(app), target, name, description),
    ),
  });
}

/** What to warn about when an imported tile carries its own title and/or
 *  description: those keep display precedence over the query fields this
 *  dialog edits, so the commit will not change what the tile renders. `null`
 *  when neither is overridden — the ordinary case. */
const overrideNote = (maskedName: boolean, maskedDescription: boolean): string | null => {
  if (!maskedName && !maskedDescription) return null;
  const masked = maskedName && maskedDescription ? 'title and description'
    : (maskedName ? 'title' : 'description');
  const fields = maskedName && maskedDescription ? 'these fields'
    : (maskedName ? 'the query name' : 'the query description');
  return 'This tile was imported with its own ' + masked
    + ', which keeps priority over ' + fields + ' here.';
};

/** The tree's slice of `PanelMetadataDeps`. `refreshCommittedSurfaces` is the
 *  same poke every other tree write sends — a rendered Dashboard reads its
 *  document at construction, so a renamed tile would otherwise keep its old
 *  heading until something unrelated repainted it. */
const panelMetadataDeps = (app: DashboardTreeApp): PanelMetadataDeps => ({
  state: app.state,
  mutateWorkspace: app.mutateWorkspace,
  specValidators: app.specValidators,
  refreshCommittedSurfaces: () => app.onWorkspaceExternallyChanged(
    { workspace: null, queriesChanged: true },
  ),
});

/** What a panel-metadata attempt has to say — `null` closes the dialog. */
const panelMetadataMessage = (outcome: PanelMetadataOutcome): string | null => {
  if (outcome.status === 'ok') return null;
  if (outcome.status === 'stale') return 'That panel is no longer part of this dashboard.';
  if (outcome.status === 'invalid-draft') {
    // The same patch has to apply to the entry AND to every linked draft; an
    // unparseable Spec draft blocks both, and the tab is the only place it can
    // be fixed.
    return 'This panel’s query has invalid Spec JSON in an open tab. Fix it there first.';
  }
  return outcome.message;
};

/**
 * Report a delete, and — for a panel — put keyboard focus somewhere sensible.
 *
 * The successor is chosen BEFORE the write (the row it is relative to is gone
 * afterwards) but only APPLIED on success, so a refused delete leaves the tree
 * exactly as it was, focus included.
 */
async function reportRemoval(
  app: DashboardTreeApp, doc: Document,
  pending: Promise<DashboardDeleteOutcome>, successorKey: string | null,
): Promise<void> {
  const outcome = await pending;
  const message = dashboardDeleteMessage(outcome);
  if (message !== null) flashToast(message, { document: doc });
  if (!outcome.ok) return;
  // Focus is NOT optional here. The confirmation's own menu closes by removing
  // the item that was just activated, without restoring the trigger — and the
  // trigger is on its way out with the row anyway — so at this moment DOM focus
  // is on `<body>`. `renderDashboardTree`'s own restore is deliberately
  // conditional on the tree ALREADY holding focus, so it will not step in.
  // Without this, deleting from the keyboard drops the user at the top of the
  // page with no ring anywhere.
  //
  // The successor was chosen against the rows painted BEFORE the write, and the
  // repaint can have dropped it too — a search matching only the deleted panel
  // takes its group and Dashboard off screen with it. So the pre-commit choice
  // is a preference, re-checked against what is actually rendered now, and the
  // search box is the landing spot when the tree has nothing left to offer.
  const painted = app._dashTreeRows ?? [];
  const landing = painted.find((row) => row.key === successorKey)
    ?? painted[0];
  if (landing !== undefined) { moveTo(app, landing.key); return; }
  app.dom.dashboardSearchInput?.focus();
}

/** What an orphaned-variable delete has to say — `null` on a real commit,
 *  mirroring `dashboardDeleteMessage`'s own shape. `commitVariableConfig`'s
 *  ONE abort reason (`'declined'`) covers both a Dashboard deleted
 *  concurrently and one that became a duplicate id after this row was
 *  painted available — `withVariableConfig`/`replaceDashboard` collapse both
 *  into the same "no single entry to write" refusal, so there is no narrower
 *  reason to report than the Dashboard-missing wording #429 phase 1 already
 *  settled. */
const variableConfigMessage = (outcome: VariableConfigOutcome): string | null => {
  if (outcome.ok) return null;
  if (!outcome.aborted) return '✕ ' + (outcome.diagnostics[0]?.message || 'Could not save workspace');
  return outcome.data === 'declined' ? 'That dashboard is no longer part of this workspace.' : null;
};

/**
 * Report an orphaned-variable delete — the variable-config counterpart to
 * `reportRemoval` above, minus the successor-focus step neither this row's
 * own row nor its siblings need: deleting stored option SQL never removes a
 * row, so there is nowhere for focus to need to go.
 *
 * Awaiting and reporting this (rather than firing it and discarding the
 * result, as the pre-#501-review-5 code did) is what surfaces a concurrent
 * Dashboard deletion or a storage rejection instead of leaving the
 * confirmation close over a write that silently did nothing.
 */
async function reportVariableConfigRemoval(
  doc: Document, pending: Promise<VariableConfigOutcome>,
): Promise<void> {
  const message = variableConfigMessage(await pending);
  if (message !== null) flashToast(message, { document: doc });
}

/**
 * Where keyboard focus goes when a Panel row is deleted: the next Panel row,
 * else the previous one, else the Panels group that contained it (#494).
 *
 * Resolved from the CURRENTLY PAINTED rows rather than from the model, because
 * "next" means next on screen — a search may be filtering siblings out, and
 * focus must not jump to a row the user cannot see. A row whose parent group
 * is collapsed is not painted at all, so the parent key is the floor.
 */
function focusSuccessorKey(app: DashboardTreeApp, row: DashboardTreeRow): string | null {
  const painted = app._dashTreeRows ?? [];
  const index = painted.findIndex((candidate) => candidate.key === row.key);
  const sibling = (candidate: DashboardTreeRow): boolean => candidate.parentKey === row.parentKey;
  const after = painted.slice(index + 1).find(sibling);
  if (after !== undefined) return after.key;
  const before = painted.slice(0, index).reverse().find(sibling);
  // A panel row always has a parent group to fall back to; a DASHBOARD row is
  // top-level, so when it was the last one there is no row left at all — the
  // tree paints its empty state, and the caller sends focus elsewhere.
  return before?.key ?? row.parentKey;
}

// A positive guard, not an early `return`: `clampKeyboardRow` has already made the
// owner a rendered row by the time anything calls this with a non-empty tree, so a
// bailout statement here would be unreachable — and the coverage config forbids
// exactly that.
const focusRow = (list: HTMLElement, key: string | null): void => {
  if (key !== null) list.querySelector<HTMLElement>('[data-key="' + CSS.escape(key) + '"]')?.focus();
};

/** Focus one row's disclosure button. Asserted rather than guarded, and for the same
 *  reason as `focusRow` above: the only caller is that button's own activation, and
 *  toggling changes neither whether the row is rendered nor whether it is
 *  `toggleable` (which depends on the search alone) — so the button it rebuilt is
 *  always there, and a bailout branch here would be unreachable. */
const focusChevron = (list: HTMLElement, key: string): void => {
  list.querySelector<HTMLElement>(
    '[data-key="' + CSS.escape(key) + '"] .' + CHEVRON_CLASS,
  )!.focus();
};

/** Put `tabindex="0"` on exactly one row, without rebuilding anything. */
function syncRovingTabindex(list: HTMLElement | null, key: string): void {
  for (const node of list?.querySelectorAll<HTMLElement>('.dash-tree-row') ?? []) {
    const value = node.dataset.key === key ? '0' : '-1';
    node.setAttribute('tabindex', value);
    // #429/#472: the disclosure button roves WITH its row, so the immediate sync
    // has to move it too — otherwise the row the user just left keeps a chevron in
    // the Tab order until the next paint, and the tree briefly offers four targets.
    for (const chev of node.querySelectorAll<HTMLElement>('.' + CHEVRON_CLASS)) {
      chev.setAttribute('tabindex', value);
    }
  }
}

/** Move the roving tabindex to `key` and give it DOM focus. */
function moveTo(app: DashboardTreeApp, key: string): void {
  commitUi(app, setKeyboardRow(readUi(app), key));
  const list = app.dom.dashboardTreeList!;
  focusRow(list, key);
}

function handleTreeKeydown(
  app: DashboardTreeApp, rows: readonly DashboardTreeRow[], event: KeyboardEvent,
): void {
  // No empty-tree guard: `renderDashboardTree` returns before installing this
  // handler when there are no rows, so it can only ever run against a painted
  // tree. `clampKeyboardRow` ran during that paint, so the roving-tabindex owner
  // is always one of `rows` by the time any key arrives.
  // #495 review 1: this handler speaks for the ROW. A key pressed while one of
  // the row's nested action buttons has focus belongs to that button — running
  // the row's command as well would open a Dashboard the user was only trying
  // to rename, and the `preventDefault()` below would swallow the button's own
  // activation on the way. Every such control also stops propagation
  // (`isolateActivationKeys`); this is the guard that does not depend on each
  // of them remembering to.
  // Scoped to Enter: the arrow keys, Home and End still work while a nested
  // control has focus, because the chevron and the action buttons rove WITH
  // their row and are part of the same composite tab stop — walking the tree
  // from them is correct. It is only ACTIVATION that belongs to whichever
  // target has focus. (The target is always an element inside the list this
  // handler is assigned to, so there is no null case to defend against.)
  if (event.key === 'Enter' && (event.target as Element).closest('button') !== null) return;
  const ui = readUi(app);
  const index = rows.findIndex((row) => row.key === ui.keyboardRowKey);
  const row = rows[index];

  switch (event.key) {
    case 'ArrowDown':
      event.preventDefault();
      if (index < rows.length - 1) moveTo(app, rows[index + 1].key);
      return;
    case 'ArrowUp':
      event.preventDefault();
      if (index > 0) moveTo(app, rows[index - 1].key);
      return;
    case 'Home':
      event.preventDefault();
      moveTo(app, rows[0].key);
      return;
    case 'End':
      event.preventDefault();
      moveTo(app, rows[rows.length - 1].key);
      return;
    case 'ArrowRight': {
      event.preventDefault();
      // Expand a closed row; on an already-open one (or one a search is holding
      // open, which cannot be collapsed), step into its first child.
      if (row.toggleable && !row.expanded) { expand(app, row, true); return; }
      const child = rows[index + 1];
      if (child !== undefined && child.parentKey === row.key) moveTo(app, child.key);
      return;
    }
    case 'ArrowLeft': {
      event.preventDefault();
      // Collapse an open row; otherwise step out to its parent.
      if (row.toggleable && row.expanded) { expand(app, row, false); return; }
      if (row.parentKey !== null) moveTo(app, row.parentKey);
      return;
    }
    case 'Enter':
      event.preventDefault();
      // Enter is unambiguous, so it needs no arbitration — Shift+Enter is the
      // Edit action, matching Shift-click.
      if (event.shiftKey) { if (row.shift !== null) runCommand(app, row, row.shift); return; }
      if (row.single !== null) runCommand(app, row, row.single);
      return;
    default:
      return;
  }
}

function expand(app: DashboardTreeApp, row: DashboardTreeRow, expanded: boolean): void {
  const ui = readUi(app);
  commitUi(app, row.group === null
    ? setDashboardExpanded(ui, row.dashboardId, expanded)
    : setGroupExpanded(ui, row.dashboardId, row.group, expanded));
  focusRow(app.dom.dashboardTreeList!, row.key);
}
