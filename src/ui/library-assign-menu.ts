// Keyboard-accessible Library → Dashboard assignment (#483).
//
// This module owns only the chooser. The write semantics stay in
// application/library-assignment-service.ts, which is also what the Dashboard
// tree's drag/drop path calls. The first menu selects a Dashboard; openMenu
// closes it before its callback runs, so the callback can safely open the
// confirmation stage on the same trigger without stacking or racing menus.

import { assignLibraryQueryToPanel, libraryAssignmentMessage } from '../application/library-assignment-service.js';
import { h } from './dom.js';
import { Icon } from './icons.js';
import { openMenu, type MenuHandle, type MenuRow } from './menu.js';
import { flashToast } from './toast.js';
import type { LibraryQueryDragPayload } from '../core/library-drag.js';
import { shortIdFragments } from '../core/file-menu-model.js';
import { queryName } from '../core/saved-query.js';
import { UNTITLED_DASHBOARD } from '../application/dashboard-tree-model.js';
import { revealAssignedPanel } from './dashboard-tree.js';
import type { SavedQueryV2 } from '../generated/json-schema.types.js';
import type { App } from './app.types.js';

const keyboardOwnerChannel = (
  app: Pick<App, 'acquireKeyboardOwner'>,
): ((owner: App['keyboardOwner']) => void) => {
  let release: (() => void) | null = null;
  return (owner) => {
    release?.();
    release = owner ? app.acquireKeyboardOwner(owner.kind) : null;
  };
};

const dashboardCounts = (app: App): Map<string, number> => {
  const counts = new Map<string, number>();
  for (const dashboard of app.currentWorkspace?.dashboards ?? []) {
    counts.set(dashboard.id, (counts.get(dashboard.id) ?? 0) + 1);
  }
  return counts;
};

async function assign(
  app: App, payload: LibraryQueryDragPayload, dashboardId: string,
): Promise<void> {
  const surfaceGeneration = app.captureSurfaceGeneration();
  let currentAtNotification: boolean | null = null;
  const outcome = await assignLibraryQueryToPanel({
    mutateWorkspace: app.mutateWorkspace,
    // Resolve the live renderer hook after the durable write. A surface
    // transition replaces this property while persistence is in flight. Record
    // staleness BEFORE the hook rebuilds a live Dashboard (which can itself
    // advance the renderer generation).
    onWorkspaceExternallyChanged: (info) => {
      currentAtNotification = app.isSurfaceGenerationCurrent(surfaceGeneration);
      app.onWorkspaceExternallyChanged(info);
    },
    genId: app.genId,
  }, payload, dashboardId);
  // The durable write and live-renderer notification stand, but a slow command
  // must not navigate or toast over a surface the user chose afterwards.
  if (!(currentAtNotification ?? app.isSurfaceGenerationCurrent(surfaceGeneration))) return;
  if (outcome.ok && outcome.data?.status === 'ok') {
    // Match the drag path's post-command behavior: reveal/select the new Panel
    // in the Dashboard tree, then work on its independent owned copy — never
    // the Library source.
    revealAssignedPanel(app, dashboardId, outcome.data.tileId);
    app.openSavedQuery(outcome.data.queryId);
  }
  const message = libraryAssignmentMessage(outcome);
  if (message !== null) flashToast(message, { document: app.document });
}

function openConfirmation(
  app: App, query: SavedQueryV2, dashboardId: string, dashboardTitle: string,
  trigger: HTMLElement, payload: LibraryQueryDragPayload,
): MenuHandle {
  const name = queryName(query);
  return openMenu({
    document: app.document,
    trigger,
    menuClass: 'library-assign-menu',
    ariaLabel: `Confirm adding ${name} to ${dashboardTitle}`,
    onKeyboardOwnerChange: keyboardOwnerChannel(app),
    rows: [
      {
        kind: 'custom',
        node: h('div', { class: 'library-assign-copy' },
          'Add “', h('b', null, name), '” to “', h('b', null, dashboardTitle),
          '” as a new panel. The panel gets an independent copy you can edit.'),
      },
      {
        kind: 'item', label: 'Add', icon: Icon.plus(),
        extraClass: 'library-assign-add',
        onClick: () => { void assign(app, payload, dashboardId); },
      },
      {
        kind: 'item', label: 'Cancel', extraClass: 'library-assign-cancel',
        autofocus: true, onClick: () => trigger.focus(),
      },
    ],
  });
}

/** Open the Dashboard chooser for one rendered Library query row. */
export function openLibraryAssignMenu(
  app: App, query: SavedQueryV2, trigger: HTMLElement,
): MenuHandle {
  const workspace = app.currentWorkspace;
  const name = queryName(query);
  const payload: LibraryQueryDragPayload = {
    kind: 'library-query',
    workspaceId: workspace?.id ?? '',
    queryId: query.id,
  };
  const counts = dashboardCounts(app);
  const dashboards = workspace?.dashboards ?? [];
  const fragments = shortIdFragments(dashboards.map((dashboard) => dashboard.id));
  const occurrences = new Map<string, number>();
  const rows: MenuRow[] = [
    { kind: 'section', label: 'Add query to dashboard' },
    ...dashboards.map((dashboard, index): MenuRow => {
      const title = dashboard.title.trim() || UNTITLED_DASHBOARD;
      const count = counts.get(dashboard.id) ?? 0;
      const ambiguous = count > 1;
      const occurrence = (occurrences.get(dashboard.id) ?? 0) + 1;
      occurrences.set(dashboard.id, occurrence);
      const tileCount = dashboard.tiles.length;
      const meta = `${tileCount} ${tileCount === 1 ? 'tile' : 'tiles'} · ${fragments[index]}`
        + (ambiguous ? ` · duplicate ${occurrence}/${count}` : '');
      return {
        kind: 'item',
        label: title,
        meta,
        trailing: Icon.chev(),
        disabled: ambiguous,
        reason: ambiguous ? 'Two dashboards share this id' : null,
        onClick: () => openConfirmation(
          app, query, dashboard.id, title, trigger, payload,
        ),
      };
    }),
  ];
  if (dashboards.length === 0) {
    rows.push({
      kind: 'custom',
      node: h('div', { class: 'library-assign-copy' },
        'Create or open a dashboard before adding this query as a panel.'),
    });
    rows.push({
      kind: 'item', label: 'Cancel', extraClass: 'library-assign-cancel',
      autofocus: true, onClick: () => trigger.focus(),
    });
  }
  return openMenu({
    document: app.document,
    trigger,
    menuClass: 'library-assign-menu',
    ariaLabel: `Choose a dashboard for ${name}`,
    onKeyboardOwnerChange: keyboardOwnerChannel(app),
    rows,
  });
}
