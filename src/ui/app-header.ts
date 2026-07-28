import { h } from './dom.js';
import { Icon } from './icons.js';
import { userShortName } from '../core/format.js';
import { connectionLifecyclePresentation } from '../core/connection-lifecycle.js';
import { libraryControls, QUERY_FILE_MENU } from './file-menu.js';
import type { FileMenuSurfaceContext } from './file-menu.js';
import type { App } from './app.types.js';

export interface AppHeaderOptions {
  /**
   * What the calling surface rendered, for the ONE shared File menu (#452).
   *
   * This is CONTEXT, never a replacement control: the header always builds the
   * same File menu, and the context only decides which of its fixed rows are
   * enabled. The predecessor of this field was `fileButton`, which let a surface
   * substitute a menu of its own — which is exactly how the File word came to
   * mean two different things in the same application.
   */
  fileMenu?: FileMenuSurfaceContext;
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

/** Paint the existing chip from the session's authoritative lifecycle. Safe
 * before the header exists so app-shell can use one reactive effect across
 * its mount/setHeader ordering. */
export function applyConnectionStatus(app: Pick<App, 'conn' | 'dom'>): void {
  const chip = app.dom.connStatus;
  if (!chip) return;
  const lifecycle = app.conn.connection.value;
  const presentation = connectionLifecyclePresentation(lifecycle);
  chip.className = presentation.className;
  chip.dataset.connectionState = lifecycle.kind;
  chip.setAttribute('aria-label', presentation.ariaLabel);
  chip.title = app.conn.host();
  chip.querySelector<HTMLElement>('.connection-host')!.textContent = app.conn.host();
  chip.querySelector<HTMLElement>('.connection-state')!.textContent = presentation.label;
  // An in-place Basic reauthentication keeps this exact header DOM mounted.
  // Refresh identity alongside the lifecycle chip so a different user/target
  // never leaves the old session's label behind.
  const userButton = app.dom.userBtn;
  if (userButton) {
    userButton.title = app.conn.email();
    const short = userButton.querySelector<HTMLElement>('.user-short');
    if (short) short.textContent = userShortName(app.conn.email());
  }
}

/** The one application header used by both Workbench and Dashboard. */
export function buildAppHeader(app: App, options: AppHeaderOptions = {}): HTMLElement {
  app.dom.themeBtn = h('button', {
    class: 'hd-btn', title: 'Toggle theme', onclick: () => app.toggleTheme(),
  }, app.state.theme === 'dark' ? Icon.sun() : Icon.moon());

  const connection = connectionLifecyclePresentation(app.conn.connection.value);
  app.dom.connStatus = h('div', {
    class: connection.className,
    'data-connection-state': app.conn.connection.value.kind,
    role: 'status',
    'aria-label': connection.ariaLabel,
    title: app.conn.host(),
  }, h('span', { class: 'connection-host' }, app.conn.host()),
  h('span', { class: 'connection-state' }, connection.label));
  app.dom.userBtn = h('button', {
    class: 'hd-btn user-btn', title: app.conn.email(), onclick: () => app.actions.openUserMenu(),
  }, h('span', { class: 'user-short' }, userShortName(app.conn.email())), Icon.chevDown());
  const workspaceControls = libraryControls(
    app, options.fileMenu ?? QUERY_FILE_MENU, options.workspaceTitleEditable !== false,
  );
  return h('div', {
    class: `app-header${app.sqlRoute.surface === 'dashboard' ? ' dashboard-app-header' : ''}`,
  },
    // #426: the brand zone is now non-interactive. Dashboard selection lives in
    // the upper-left tree, which made the old `SQL Browser | Dashboard` pair
    // redundant — and misleading, since it could only ever reach ONE Dashboard.
    // `routeButton` above survives: the Dashboard surface toolbar's View/Edit
    // control is its remaining consumer.
    h('div', { class: 'header-brand-zone' },
      h('div', { class: 'logo-mark' }, Icon.brand()),
      h('div', { class: 'logo-name' }, 'Altinity® SQL Browser')),
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
