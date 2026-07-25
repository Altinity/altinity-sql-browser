// The UPPER sidebar pane's role switcher (#426): `Databases | Dashboards` over two
// PERSISTENT hosts, exactly one exposed.
//
// The two hosts are built once and never rebuilt — switching roles only flips
// `hidden`. That is what preserves, by construction rather than by restoration
// logic: the schema search text and its input focus, schema expansion and
// lazily-loaded columns, schema scroll position, and the Dashboard tree's own
// search/expansion/scroll. It also means the upper pane's height, the splitter and
// the sidebar width are untouched — they belong to the `.side-pane` this mounts
// inside, which nothing here replaces.
//
// The tab row reuses the lower switcher's `.side-tabs`/`.side-tab`/`.side-count`
// vocabulary verbatim, as #426 asks and DESIGN.md requires (one tab/segmented
// control language across the app).

import { h } from './dom.js';
import { Icon } from './icons.js';
import { renderDashboardTree, cancelDashboardTreeClicks, type DashboardTreeApp } from './dashboard-tree.js';
import { readTreeUi, setTreeSearch } from '../application/dashboard-tree-ui-state.js';
import type { AppState } from '../state.js';
import type { AppDom } from './app.types.js';

export type UpperRole = 'databases' | 'dashboards';

/** The slice of `app` this module reads. A real `App` satisfies it directly. */
export interface SidebarUpperApp extends DashboardTreeApp {
  dom: Pick<AppDom, 'dashboardTreeList' | 'schemaSearchInput' | 'schemaList' | 'upperRoleTabs' | 'dashboardSearchInput'>;
  state: AppState;
}

export interface SidebarUpperHandle {
  /** The Databases host — the existing schema search + tree, moved wholesale. */
  databasesHost: HTMLElement;
  /** The Dashboards host — Dashboard search + hierarchy tree. */
  dashboardsHost: HTMLElement;
  /** Expose exactly one role. */
  showRole(role: UpperRole): void;
}

/**
 * Build the upper pane's tab row and its two hosts. The caller supplies the
 * already-built Databases content (the schema search box and list, which
 * `app-shell.ts` still owns and which several other modules reach through
 * `app.dom`), so this module adds the switcher WITHOUT taking ownership of, or
 * changing, any schema behaviour.
 */
export function buildSidebarUpper(
  app: SidebarUpperApp, databasesContent: readonly Node[],
): SidebarUpperHandle {
  const state = app.state;

  app.dom.upperRoleTabs = h('div', { class: 'side-tabs upper-role-tabs' });

  const databasesHost = h('div', { class: 'upper-role-host', 'data-role': 'databases' }, ...databasesContent);

  // Built ONCE and never inside the repainted row list, so typing keeps the caret
  // (the same reason `saved-history.ts` builds its search box outside `renderList`).
  app.dom.dashboardSearchInput = h('input', {
    type: 'text', placeholder: 'Search dashboards, filters, panels…',
    'aria-label': 'Search dashboards, filters, panels',
    oninput: (event: Event) => {
      const workspaceId = app.currentWorkspace?.id ?? '';
      const next = setTreeSearch(readTreeUi(state.dashboardTreeUi, workspaceId), (event.target as HTMLInputElement).value);
      state.dashboardTreeUi.set(workspaceId, next);
      // A pending single-click action from before the search must not fire against
      // the rows it is about to replace.
      cancelDashboardTreeClicks(app);
      renderDashboardTree(app);
    },
  });
  app.dom.dashboardTreeList = h('div', {
    class: 'schema-list dash-tree-list',
    role: 'tree',
    'aria-label': 'Dashboards',
  });
  const dashboardsHost = h('div', { class: 'upper-role-host', 'data-role': 'dashboards', hidden: true },
    h('div', { class: 'schema-search' },
      h('div', { class: 'search-wrap' }, Icon.search(), app.dom.dashboardSearchInput)),
    app.dom.dashboardTreeList);

  return {
    databasesHost,
    dashboardsHost,
    showRole: (role) => {
      databasesHost.hidden = role !== 'databases';
      dashboardsHost.hidden = role !== 'dashboards';
    },
  };
}

/** Repaint the role tabs: active state plus each role's count. */
export function renderUpperRoleTabs(app: SidebarUpperApp): void {
  const row = app.dom.upperRoleTabs;
  if (!row) return;
  const state = app.state;
  const active = state.upperRole.value;

  // Omitted while the schema is still loading or failed — the lower switcher omits
  // `.side-count` when there is no count to show, and a confident "· 0" during a
  // load would be a lie.
  const schema = state.schema.value;
  const databaseCount = state.schemaError.value || schema === null ? null : schema.length;
  const dashboardCount = app.currentWorkspace?.dashboards?.length ?? 0;

  const tab = (role: UpperRole, label: string, icon: SVGElement, count: number | null): HTMLButtonElement =>
    h('button', {
      class: 'side-tab' + (active === role ? ' active' : ''),
      type: 'button',
      'aria-pressed': active === role ? 'true' : 'false',
      onclick: () => {
        // Changing role hides one tree and shows the other, so a deferred
        // single-click must not land on the tree the user just left.
        cancelDashboardTreeClicks(app);
        state.upperRole.value = role;
      },
    }, icon, h('span', null, label),
      count === null ? null : h('span', { class: 'side-count' }, '· ' + count));

  row.replaceChildren(
    tab('databases', 'Databases', Icon.database(), databaseCount),
    tab('dashboards', 'Dashboards', Icon.dashboard(), dashboardCount),
  );
}
