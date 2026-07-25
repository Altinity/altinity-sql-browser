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
  deriveDashboardTree, type DashboardTreeCommand, type DashboardTreeRow, type TreeWorkspace,
} from '../application/dashboard-tree-model.js';
import {
  clampKeyboardRow, readTreeUi, setDashboardExpanded, setGroupExpanded, setKeyboardRow,
  setTreeScroll, toggleDashboardExpanded, toggleGroupExpanded,
  type DashboardTreeUiState,
} from '../application/dashboard-tree-ui-state.js';
import type { AppState } from '../state.js';
import type { AppDom } from './app.types.js';
import type { MainSurfaceState, OpenDashboardRequest } from '../application/main-surface.js';

/** The narrow slice of the real `app` controller this module reads — not the full
 *  `App` contract. A real `App` satisfies it directly, and so does the unit
 *  fixture (same convention as `ui/schema.ts`'s `SchemaApp`). */
export interface DashboardTreeApp {
  dom: Pick<AppDom, 'dashboardTreeList'>;
  state: AppState;
  /** Read-only: the tree is a projection of the COMMITTED aggregate. */
  currentWorkspace: TreeWorkspace | null;
  mainSurface: MainSurfaceState;
  openDashboard(request: OpenDashboardRequest): void;
  openSavedQuery(queryId: string): void;
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

const rowIcon = (row: DashboardTreeRow): SVGElement => {
  if (row.kind === 'dashboard') return Icon.dashboard();
  if (row.kind === 'group') return row.group === 'filters' ? Icon.eye() : Icon.layers();
  return row.kind === 'panel' ? Icon.chart() : Icon.eye();
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
 * The ONE command dispatcher. Three exhaustive branches with no null guards: the
 * model resolves every argument, so there is nothing here to defend against.
 */
function runCommand(app: DashboardTreeApp, row: DashboardTreeRow, command: DashboardTreeCommand): void {
  if (command.kind === 'toggle') { toggleRow(app, row); return; }
  if (command.kind === 'open-query') { app.openSavedQuery(command.queryId); return; }
  app.openDashboard(command.request);
}

export function renderDashboardTree(app: DashboardTreeApp): void {
  const list = app.dom.dashboardTreeList;
  if (!list) return;
  const doc = app.document ?? list.ownerDocument;

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
      : 'No matching dashboards, filters, or panels.'));
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
    // way to expand with no delay at all.
    ...(row.expandable ? {
      onclick: (event: MouseEvent) => {
        event.stopPropagation();
        app._dashTreeArbiter?.cancel();
        toggleRow(app, row);
      },
    } : {}),
  }, row.expandable ? Icon.chevDown() : null);

  const label = h('span', { class: 'label' }, row.label);
  const count = row.count === null
    ? null
    : h('span', { class: 'side-count dash-tree-count' }, '· ' + row.count);
  const warning = row.invalid === null
    ? null
    : h('span', { class: 'dash-tree-warn', role: 'img', 'aria-label': 'Broken reference' }, Icon.shield());

  const rowEl = h('div', {
    class: 'tree-row dash-tree-row'
      + (row.kind === 'dashboard' ? ' bold' : '')
      + (row.kind === 'group' ? ' dash-tree-group' : '')
      + (row.matched ? ' match' : '')
      + (row.current ? ' is-current' : '')
      + (row.invalid === null ? '' : ' is-invalid'),
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
      // clicked rather than back at the top of the tree.
      app.state.dashboardTreeUi.set(
        app.currentWorkspace?.id ?? '', setKeyboardRow(readUi(app), row.key),
      );
      pressRow(app, row, event.shiftKey);
    },
  }, chevron, h('span', { class: 'icon' }, rowIcon(row)), label, count,
    h('span', { class: 'meta' }, row.meta), warning,
    row.menu.length === 0 ? null : buildMenuButton(app, doc, row));

  return rowEl;
}

/** Route one primary press through the arbiter — except a group row, whose single
 *  action is expansion with no competing double or Shift gesture, so deferring it
 *  would only make the tree feel slow. */
function pressRow(app: DashboardTreeApp, row: DashboardTreeRow, shift: boolean): void {
  if (row.kind === 'group') {
    app._dashTreeArbiter?.cancel();
    toggleRow(app, row);
    return;
  }
  arbiterFor(app).press(row.key, {
    single: row.single === null ? null : () => runCommand(app, row, row.single!),
    double: row.double === null ? null : () => runCommand(app, row, row.double!),
    immediate: shift && row.shift !== null ? () => runCommand(app, row, row.shift!) : null,
  });
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
      // Never the row's own gesture, and never a pending single of its own.
      event.stopPropagation();
      app._dashTreeArbiter?.cancel();
      openMenu({
        document: doc,
        trigger,
        menuClass: 'dash-tree-menu',
        rows: row.menu.map((item) => ({
          kind: 'item' as const,
          label: item.label,
          ...(item.command === null
            ? { extraClass: 'is-disabled', onClick: () => {} }
            : { onClick: () => runCommand(app, row, item.command!) }),
        })),
      });
    },
  }, Icon.chevDown());
  return trigger;
}

// A positive guard, not an early `return`: `clampKeyboardRow` has already made the
// owner a rendered row by the time anything calls this with a non-empty tree, so a
// bailout statement here would be unreachable — and the coverage config forbids
// exactly that.
const focusRow = (list: HTMLElement, key: string | null): void => {
  if (key !== null) list.querySelector<HTMLElement>('[data-key="' + CSS.escape(key) + '"]')?.focus();
};

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
      // Expand a closed row; on an already-open one, step into its first child.
      if (row.expandable && !row.expanded) { expand(app, row, true); return; }
      const child = rows[index + 1];
      if (child !== undefined && child.parentKey === row.key) moveTo(app, child.key);
      return;
    }
    case 'ArrowLeft': {
      event.preventDefault();
      // Collapse an open row; otherwise step out to its parent.
      if (row.expandable && row.expanded) { expand(app, row, false); return; }
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
