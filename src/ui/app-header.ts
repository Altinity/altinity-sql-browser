import { h } from './dom.js';
import { Icon } from './icons.js';
import { shortVersion, userShortName } from '../core/format.js';
import { libraryControls } from './file-menu.js';
import type { App } from './app.types.js';

export interface AppHeaderOptions {
  /** Dashboard owns a resource-scoped File menu; Workbench uses the default
   * workspace File menu supplied by `libraryControls`. */
  dashboardFileButton?: HTMLButtonElement;
}

function routeButton(
  label: string, active: boolean, onClick: () => void,
): HTMLButtonElement {
  return h('button', {
    class: `editor-mode-btn${active ? ' active' : ''}`,
    'aria-pressed': active ? 'true' : 'false',
    disabled: active,
    onclick: active ? undefined : onClick,
  }, label);
}

function surfaceSwitch(app: App): HTMLElement {
  const key = app.currentWorkspace?.key ?? app.state.workspaceKey;
  const dashboard = app.sqlRoute.surface === 'dashboard';
  return h('div', {
    class: 'editor-mode-switch app-surface-switch',
    role: 'group', 'aria-label': 'Application surface',
  },
  routeButton('SQL Browser', !dashboard, () => {
    void app.navigateSqlRoute({ surface: 'workspace', workspaceKey: key }, 'push');
  }),
  routeButton('Dashboard', dashboard, () => {
    void app.navigateSqlRoute({ surface: 'dashboard', workspaceKey: key, mode: 'edit' }, 'push');
  }));
}

function dashboardModeSwitch(app: App): HTMLElement {
  const route = app.sqlRoute as Extract<App['sqlRoute'], { surface: 'dashboard' }>;
  const key = app.currentWorkspace?.key ?? route.workspaceKey;
  return h('div', {
    class: 'editor-mode-switch dashboard-mode-switch',
    role: 'group', 'aria-label': 'Dashboard mode',
  },
  routeButton('View', route.mode === 'view', () => {
    void app.navigateSqlRoute({ surface: 'dashboard', workspaceKey: key, mode: 'view' }, 'replace');
  }),
  routeButton('Edit', route.mode === 'edit', () => {
    void app.navigateSqlRoute({ surface: 'dashboard', workspaceKey: key, mode: 'edit' }, 'replace');
  }));
}

/** The one application header used by both Workbench and Dashboard. */
export function buildAppHeader(app: App, options: AppHeaderOptions = {}): HTMLElement {
  const version = app.state.serverVersion;
  app.dom.connStatus = h('div', {
    class: `conn-status${version ? '' : ' dim'}`,
    title: version ? `ClickHouse ${version}` : '',
  }, h('span', { class: 'ver' }, version ? `ClickHouse ${shortVersion(version)}` : 'Connecting…'));
  app.dom.themeBtn = h('button', {
    class: 'hd-btn', title: 'Toggle theme', onclick: () => app.toggleTheme(),
  }, app.state.theme === 'dark' ? Icon.sun() : Icon.moon());
  app.dom.userBtn = h('button', {
    class: 'hd-btn user-btn', title: app.conn.email(), onclick: () => app.actions.openUserMenu(),
  }, h('span', { class: 'user-short' }, userShortName(app.conn.email())), Icon.chevDown());

  const dashboard = app.sqlRoute.surface === 'dashboard';
  const workspaceControls = libraryControls(app, dashboard
    ? {
        fileButton: options.dashboardFileButton,
        afterWorkspace: dashboardModeSwitch(app),
        workspaceTitleReadOnly:
          (app.sqlRoute as Extract<App['sqlRoute'], { surface: 'dashboard' }>).mode === 'view',
      }
    : {});

  return h('div', { class: 'app-header' },
    h('div', { class: 'logo-mark' }, Icon.brand()),
    h('div', { class: 'logo-name' }, 'Altinity®'),
    surfaceSwitch(app),
    h('div', { class: 'env-chip' }, app.conn.host()),
    h('div', { class: 'hd-divider' }),
    ...workspaceControls,
    h('div', { style: { flex: '1' } }),
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
    app.dom.userBtn);
}
