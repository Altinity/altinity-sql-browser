import { h } from './dom.js';
import { Icon } from './icons.js';
import { shortVersion, userShortName } from '../core/format.js';
import { buildWorkspaceTitle, libraryControls } from './file-menu.js';
import type { App } from './app.types.js';

export interface AppHeaderOptions {
  /** Surface-scoped File menu. Workbench uses its workspace/query menu. */
  fileButton?: HTMLButtonElement;
  /** Dashboard View is the only read-only workspace-title presentation. */
  workspaceTitleEditable?: boolean;
}

export function routeButton(
  label: string, active: boolean, onClick: () => void,
): HTMLButtonElement {
  return h('button', {
    class: `editor-mode-btn${active ? ' active' : ''}`,
    'aria-label': label,
    'aria-pressed': active ? 'true' : 'false',
    disabled: active,
    onclick: active ? undefined : onClick,
    title: label,
  }, h('span', { class: 'surface-label' }, label));
}

function surfaceSwitch(app: App): HTMLElement {
  const dashboard = app.sqlRoute.surface === 'dashboard';
  // The header stays mounted when File → New workspace swaps the active
  // aggregate. Resolve at click time so its route never retains the workspace
  // key from the header's original render.
  const workspaceKey = (): string => app.currentWorkspace?.key ?? app.state.workspaceKey;
  return h('div', {
    class: 'editor-mode-switch app-surface-switch',
    role: 'group', 'aria-label': 'Application surface',
  },
  routeButton('SQL Browser', !dashboard, () => {
    void app.navigateSqlRoute({ surface: 'workspace', workspaceKey: workspaceKey() }, 'push');
  }),
  routeButton('Dashboard', dashboard, () => {
    void app.navigateSqlRoute({ surface: 'dashboard', workspaceKey: workspaceKey(), mode: 'edit' }, 'push');
  }));
}

/** The one application header used by both Workbench and Dashboard. */
export function buildAppHeader(app: App, options: AppHeaderOptions = {}): HTMLElement {
  app.dom.themeBtn = h('button', {
    class: 'hd-btn', title: 'Toggle theme', onclick: () => app.toggleTheme(),
  }, app.state.theme === 'dark' ? Icon.sun() : Icon.moon());

  const version = app.state.serverVersion;
  app.dom.connStatus = h('div', {
    class: `conn-status connection-chip${version ? '' : ' dim'}`,
    title: version ? `${app.conn.host()} · ClickHouse ${version}` : app.conn.host(),
  }, h('span', { class: 'connection-host' }, app.conn.host()),
  h('span', { class: 'connection-sep', 'aria-hidden': 'true' }, '·'),
  h('span', { class: 'ver' }, version ? `CH ${shortVersion(version)}` : 'Connecting…'));
  app.dom.userBtn = h('button', {
    class: 'hd-btn user-btn', title: app.conn.email(), onclick: () => app.actions.openUserMenu(),
  }, h('span', { class: 'user-short' }, userShortName(app.conn.email())), Icon.chevDown());
  const workspaceControls = options.fileButton
    ? [options.fileButton, buildWorkspaceTitle(app, options.workspaceTitleEditable !== false)]
    : libraryControls(app);
  app.dom.fileBtn = workspaceControls[0];
  return h('div', {
    class: `app-header${app.sqlRoute.surface === 'dashboard' ? ' dashboard-app-header' : ''}`,
  },
    h('div', { class: 'header-brand-zone' },
      h('div', { class: 'logo-mark' }, Icon.brand()),
      h('div', { class: 'logo-name' }, 'Altinity®'),
      surfaceSwitch(app)),
    h('div', { class: 'header-context-zone' }, ...workspaceControls),
    h('div', { class: 'header-utility-zone' },
    app.dom.connStatus,
    h('a', {
      class: 'hd-btn hd-hide-mobile',
      href: 'https://github.com/Altinity/altinity-sql-browser/tree/main/examples',
      target: '_blank', rel: 'noopener noreferrer', title: 'View examples',
    }, Icon.github()),
    h('button', {
      class: 'hd-btn hd-hide-mobile',
      title: 'Keyboard shortcuts (?)', onclick: () => app.actions.openShortcuts(),
    }, Icon.shortcuts()),
    app.dom.themeBtn,
    app.dom.userBtn));
}
