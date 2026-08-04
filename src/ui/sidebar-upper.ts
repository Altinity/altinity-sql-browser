// The UPPER sidebar pane's two panels (#426, registry-driven since #587):
// Databases and Dashboards, over two PERSISTENT hosts, exactly one exposed at
// a time by `side-panel-registry.ts`'s generic `showPanel`.
//
// The two hosts are built once and never rebuilt — switching panels only
// flips `hidden` (the registry's job now, not this module's). That is what
// preserves, by construction rather than by restoration logic: the schema
// search text and its input focus, schema expansion and lazily-loaded
// columns, schema scroll position, and the Dashboard tree's own
// search/expansion/scroll. It also means the upper pane's height, the
// splitter and the sidebar width are untouched — they belong to the
// `.side-pane` this mounts inside, which nothing here replaces.
//
// #587: this module used to also own the upper tab row's vocabulary and
// paint it directly (`renderUpperRoleTabs`, `NAV`-style `UpperRole` literals).
// Both are gone — `databasesPanelDef`/`dashboardsPanelDef` below hand the
// SAME label/icon/accessibleLabel/count facts to `side-panel-registry.ts`'s
// generic tab row instead, so the upper and lower rows can never again
// disagree about how a panel presents itself. This module keeps building the
// two panel BODIES (the schema search+list host, the Dashboard search+tree
// host) — the part no registry should take over.

import { h } from './dom.js';
import { Icon } from './icons.js';
import { renderDashboardTree, cancelDashboardTreeClicks, type DashboardTreeApp } from './dashboard-tree.js';
import { readTreeUi, setTreeSearch } from '../core/dashboard-tree-ui-state.js';
import type { AppState } from '../state.js';
import type { AppDom } from './app.types.js';
import type { MountedSidePanel, SidePanelDef } from './side-panel-registry.js';

/** The slice of `app` this module reads. A real `App` satisfies it directly. */
export interface SidebarUpperApp extends DashboardTreeApp {
  dom: Pick<AppDom, 'dashboardTreeList' | 'schemaSearchInput' | 'schemaList' | 'dashboardSearchInput'>;
  state: AppState;
}

export interface SidebarUpperHandle {
  /** The Databases host — the existing schema search + tree, moved wholesale. */
  databasesHost: HTMLElement;
  /** The Dashboards host — Dashboard search + hierarchy tree. */
  dashboardsHost: HTMLElement;
}

/**
 * Build the upper pane's two hosts. The caller supplies the already-built
 * Databases content (the schema search box and list, which `app-shell.ts`
 * still owns and which several other modules reach through `app.dom`), so
 * this module adds the Dashboards body WITHOUT taking ownership of, or
 * changing, any schema behaviour.
 */
export function buildSidebarUpper(
  app: SidebarUpperApp, databasesContent: readonly Node[],
): SidebarUpperHandle {
  const state = app.state;

  const databasesHost = h('div', { class: 'upper-role-host', 'data-role': 'databases' }, ...databasesContent);

  // Built ONCE and never inside the repainted row list, so typing keeps the caret
  // (the same reason `saved-history.ts` builds its search box outside `renderList`).
  app.dom.dashboardSearchInput = h('input', {
    type: 'text', placeholder: 'Search dashboards, variables, panels…',
    'aria-label': 'Search dashboards, variables, panels',
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
  // `hidden` is NOT set here — the registry normalizes every panel's initial
  // visibility from the manifest's pane order at construction (#587).
  const dashboardsHost = h('div', { class: 'upper-role-host', 'data-role': 'dashboards' },
    h('div', { class: 'schema-search' },
      h('div', { class: 'search-wrap' }, Icon.search(), app.dom.dashboardSearchInput)),
    app.dom.dashboardTreeList);

  return { databasesHost, dashboardsHost };
}

/** The Databases tab's live count — omitted while the schema is still
 *  loading or failed (a confident "· 0" during a load would be a lie),
 *  exactly as `renderUpperRoleTabs` used to compute it. */
function databasesCount(app: SidebarUpperApp): Node | null {
  const schema = app.state.schema.value;
  const count = app.state.schemaError.value || schema === null ? null : schema.length;
  return count === null ? null : h('span', { class: 'side-count' }, '· ' + count);
}

/** The Dashboards tab's live count — always shown, including zero, exactly
 *  as `renderUpperRoleTabs` used to compute it. */
function dashboardsCount(app: SidebarUpperApp): Node {
  const count = app.currentWorkspace?.dashboards?.length ?? 0;
  return h('span', { class: 'side-count' }, '· ' + count);
}

/** The registry's Databases entry. Content already lives in `host` (this
 *  module's own `databasesHost`, built above) — nothing to mount. */
export function databasesPanelDef(app: SidebarUpperApp, host: HTMLElement): SidePanelDef {
  return {
    id: 'databases', pane: 'upper', label: 'Databases', icon: Icon.database,
    accessibleLabel: 'Open Databases navigation',
    tabAdornment: () => databasesCount(app),
    host,
    mount: (): MountedSidePanel => ({ render: () => {}, dispose: () => {} }),
  };
}

/** The registry's Dashboards entry. `render` repaints the tree (cheap and
 *  idempotent — safe to call on every activation per #587 R2.6); `deactivate`
 *  cancels a pending deferred single-click on the tree the user is leaving
 *  (the same guard the old inline `onclick` handler ran before switching). */
export function dashboardsPanelDef(app: SidebarUpperApp, host: HTMLElement): SidePanelDef {
  return {
    id: 'dashboards', pane: 'upper', label: 'Dashboards', icon: Icon.dashboard,
    accessibleLabel: 'Open Dashboards navigation',
    tabAdornment: () => dashboardsCount(app),
    host,
    mount: (): MountedSidePanel => ({
      render: () => renderDashboardTree(app),
      deactivate: () => cancelDashboardTreeClicks(app),
      dispose: () => {},
    }),
  };
}
