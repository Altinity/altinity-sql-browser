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
// `role="treeitem"`, `aria-level`, a chevron that is its own click target, and a
// trailing action menu — enough divergence that sharing would mean parameterising
// that helper into something neither caller reads clearly.

import { h } from './dom.js';
import { Icon } from './icons.js';
import { openMenu } from './menu.js';
import { createClickArbiter, type ClickArbiter } from '../core/tree-click-arbiter.js';
import {
  UNUSED_VARIABLE_STATUS, deriveDashboardTree,
  type DashboardTreeCommand, type DashboardTreeInvalid, type DashboardTreeRow, type TreeWorkspace,
} from '../application/dashboard-tree-model.js';
import { commitVariableConfig } from '../application/dashboard-variable-config.js';
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
  document?: Document;
  /** The window whose timers back the click arbiter; defaults to the row's own. */
  window?: Pick<Window, 'setTimeout' | 'clearTimeout'>;
  /** Module-private mutable state stashed per app instance (so tests stay
   *  isolated), matching `ui/schema.ts`'s `_schemaClick` precedent. */
  _dashTreeArbiter?: ClickArbiter | null;
}

/** Indent per level, on top of `.tree-row`'s own 10px padding. */
const INDENT_PX = 14;
const OPEN_ROTATE = 'rotate(0deg)';
const CLOSED_ROTATE = 'rotate(-90deg)';

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
}

const readUi = (app: DashboardTreeApp): DashboardTreeUiState =>
  readTreeUi(app.state.dashboardTreeUi, app.currentWorkspace?.id ?? '');

/** Store new UI state and repaint. Every mutation goes through here, so the tree
 *  can never be left showing state it does not hold. */
function commitUi(app: DashboardTreeApp, next: DashboardTreeUiState): void {
  app.state.dashboardTreeUi.set(app.currentWorkspace?.id ?? '', next);
  renderDashboardTree(app);
}

/** Expand/collapse the row, whichever kind it is. */
function toggleRow(app: DashboardTreeApp, row: DashboardTreeRow): void {
  const ui = readUi(app);
  commitUi(app, row.group === null
    ? toggleDashboardExpanded(ui, row.dashboardId)
    : toggleGroupExpanded(ui, row.dashboardId, row.group));
}

/**
 * The ONE command dispatcher. Four exhaustive branches with no null guards: the
 * model resolves every argument, so there is nothing here to defend against.
 */
function runCommand(app: DashboardTreeApp, row: DashboardTreeRow, command: DashboardTreeCommand): void {
  if (command.kind === 'toggle') { toggleRow(app, row); return; }
  if (command.kind === 'open-query') { app.openSavedQuery(command.queryId); return; }
  if (command.kind === 'open-variable') {
    app.openVariableTab(command.dashboardId, command.name);
    return;
  }
  app.openDashboard(command.request);
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
  const chevron = h('span', {
    class: 'chev',
    style: row.expandable ? { transform: row.expanded ? OPEN_ROTATE : CLOSED_ROTATE } : null,
    // The chevron is the deliberate INSTANT path for expansion: a Dashboard row's
    // own click has to wait out the double-click window, so this gives the user a
    // way to expand with no delay at all. A row a search is holding open is NOT
    // toggleable, so it gets no handler rather than an affordance that lies.
    ...(row.toggleable ? {
      onclick: (event: MouseEvent) => {
        event.stopPropagation();
        // Only this row's own pending single — a click here must not disturb one
        // already scheduled on a different row.
        app._dashTreeArbiter?.cancelFor(row.key);
        toggleRow(app, row);
      },
    } : {}),
  }, row.expandable ? Icon.chevDown() : null);

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
    role: 'treeitem',
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
    row.deletable ? buildDeleteButton(app, doc, row) : null,
    row.menu.length === 0 ? null : buildMenuButton(app, doc, row));

  return rowEl;
}

/** Route one primary press through the arbiter — except a row with NO double and
 *  NO Shift gesture (a group row, whose single action is expansion; a variable
 *  row, whose single action opens its tab), which has nothing to arbitrate
 *  against and would only feel slow if its action waited out the double-click
 *  window. */
function pressRow(app: DashboardTreeApp, row: DashboardTreeRow, shift: boolean): void {
  if (row.double === null && row.shift === null) {
    app._dashTreeArbiter?.cancelFor(row.key);
    if (row.single !== null) runCommand(app, row, row.single);
    return;
  }
  // Every row that reaches the arbiter has BOTH a double and a Shift action — the
  // early return above took every row that has neither — so only `single` (which a
  // search-forced Dashboard row, or a panel with an unresolved query, withholds)
  // still needs a null check here.
  arbiterFor(app).press(row.key, {
    single: row.single === null ? null : () => runCommand(app, row, row.single!),
    double: () => runCommand(app, row, row.double!),
    immediate: shift ? () => runCommand(app, row, row.shift!) : null,
  });
}

/**
 * #447 — the trailing trash affordance, rendered for an ORPHANED variable only.
 *
 * Deleting drops stored SQL nothing else holds, so it CONFIRMS first. The
 * confirmation is `openMenu` (ui/menu.ts) anchored on the trash button itself —
 * the same primitive this row's own action menu uses, so no new dialog is
 * invented: it gives the destructive action a real `<button role="menuitem">`, an
 * explicit Cancel, Escape/outside-click dismissal, and focus restored to the
 * trigger. (`file-menu.ts`'s `openConfirm` is module-private to that file, and
 * `window.confirm` is browser chrome this stylesheet cannot reach.)
 *
 * Like the menu button, it stops propagation and calls `cancelFor` rather than
 * going through the arbiter: clicking trash must NOT also open the variable's
 * tab, and it must cancel no OTHER row's pending click.
 */
function buildDeleteButton(app: DashboardTreeApp, doc: Document, row: DashboardTreeRow): HTMLElement {
  // `row.label` IS the variable's exact name by construction — the model sets a
  // variable row's label to its name precisely because that name is the variable's
  // whole identity (see `dashboard-tree-model.ts`). Reading it here needs no null
  // check, unlike `row.member`, which is nullable for the row kinds that have none.
  const trigger: HTMLButtonElement = h('button', {
    class: 'dash-tree-del-btn', type: 'button',
    'aria-haspopup': 'menu', 'aria-expanded': 'false',
    'aria-label': 'Delete the stored option SQL for ' + row.label,
    title: 'Delete stored option SQL',
    onclick: (event: MouseEvent) => {
      event.stopPropagation();
      app._dashTreeArbiter?.cancelFor(row.key);
      openMenu({
        document: doc,
        trigger,
        menuClass: 'dash-tree-confirm',
        rows: [
          {
            kind: 'section',
            label: 'Delete the stored option SQL for “' + row.label + '”? The SQL is lost.',
          },
          {
            kind: 'item',
            label: 'Delete option SQL',
            extraClass: 'dash-tree-confirm-go',
            // Removes ONLY this key from `variableConfigs` (both `sql` and
            // `lastKnownType` go with it). No panel query is touched — a
            // variable's name and type live in the panel SQL, not here.
            // Fire-and-forget: the delete has no per-row UI to settle against —
            // a successful commit reprojects the workspace and repaints the tree
            // on its own, and an aborted one leaves nothing to undo.
            onClick: () => { void commitVariableConfig(app, row.dashboardId, row.label, null); },
          },
          { kind: 'item', label: 'Cancel', extraClass: 'dash-tree-confirm-cancel', onClick: () => {} },
        ],
      });
    },
  }, Icon.trash());
  return trigger;
}

/** The keyboard-reachable equivalent of the double-click and Shift-click gestures,
 *  which a pointer-only affordance would otherwise hide. */
function buildMenuButton(app: DashboardTreeApp, doc: Document, row: DashboardTreeRow): HTMLElement {
  const trigger: HTMLButtonElement = h('button', {
    class: 'dash-tree-menu-btn', type: 'button',
    'aria-haspopup': 'menu', 'aria-expanded': 'false',
    'aria-label': 'Actions for ' + row.label,
    title: 'Actions',
    onclick: (event: MouseEvent) => {
      // Never the row's own gesture, and never a pending single of its own — but
      // #426 is explicit that this must cancel no UNRELATED row operation.
      event.stopPropagation();
      app._dashTreeArbiter?.cancelFor(row.key);
      openMenu({
        document: doc,
        trigger,
        menuClass: 'dash-tree-menu',
        rows: row.menu.map((item) => ({
          kind: 'item' as const,
          label: item.label,
          // An unavailable operation still RENDERS, so the row's vocabulary stays
          // discoverable — but disabled semantically, not merely greyed out.
          ...(item.command === null
            ? { extraClass: 'is-disabled', disabled: true, onClick: () => {} }
            : { onClick: () => runCommand(app, row, item.command!) }),
        })),
      });
    },
  }, Icon.more());
  return trigger;
}

// A positive guard, not an early `return`: `clampKeyboardRow` has already made the
// owner a rendered row by the time anything calls this with a non-empty tree, so a
// bailout statement here would be unreachable — and the coverage config forbids
// exactly that.
const focusRow = (list: HTMLElement, key: string | null): void => {
  if (key !== null) list.querySelector<HTMLElement>('[data-key="' + CSS.escape(key) + '"]')?.focus();
};

/** Put `tabindex="0"` on exactly one row, without rebuilding anything. */
function syncRovingTabindex(list: HTMLElement | null, key: string): void {
  for (const node of list?.querySelectorAll<HTMLElement>('.dash-tree-row') ?? []) {
    node.setAttribute('tabindex', node.dataset.key === key ? '0' : '-1');
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
