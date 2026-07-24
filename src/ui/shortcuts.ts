// Surface-aware keyboard shortcuts: one catalog drives both dispatch and help.

import { h, attachBackdropClose } from './dom.js';
import type { ActionsRegistry, KeyboardOwner, State, Tab } from './app.types.js';
import type { ConnectionSession } from '../application/connection-session.js';
import type { SqlRoute } from '../core/sql-route.js';

type ShortcutSurface = 'workspace' | 'dashboard' | 'all';
type Section = 'application' | 'workspace' | 'dashboard' | 'general' | 'gestures';
type ShortcutDispatch = 'application' | 'editor';
type KeyName = 'mod-enter' | 'mod-shift-enter' | 'mod-s' | 'mod-shift-s' | 'mod-alt-1' | 'mod-alt-2' | 'mod-z' | 'mod-shift-z' | 'f1' | 'g-d' | 'g-w' | 'g-v' | 'g-e' | 'question' | 'escape';

export interface ShortcutDefinition {
  id: string;
  label: string;
  section: Section;
  surface: ShortcutSurface;
  key: KeyName;
  dispatch: ShortcutDispatch;
  sequence?: readonly [string, string];
  available?: (app: ShortcutsApp) => boolean;
  matches?: (e: ShortcutKeydownEvent, app: ShortcutsApp) => boolean;
  run?: (e: ShortcutKeydownEvent, app: ShortcutsApp) => string | null;
}

/** The single shortcut catalogue. Help never documents a command unavailable to
 * the dispatcher because both paths resolve this list against the same app. */
export const SHORTCUT_CATALOG: readonly ShortcutDefinition[] = [
  { id: 'open-dashboard', label: 'Open Dashboard', section: 'application', surface: 'workspace', key: 'g-d', dispatch: 'application', sequence: ['g', 'd'], run: (e, a) => { e.preventDefault(); void a.navigateSqlRoute?.({ surface: 'dashboard', workspaceKey: a.state.workspaceKey, mode: 'edit' }, 'push'); return 'openDashboard'; } },
  { id: 'open-workbench', label: 'Open SQL Browser', section: 'application', surface: 'dashboard', key: 'g-w', dispatch: 'application', sequence: ['g', 'w'], run: (e, a) => { e.preventDefault(); void a.navigateSqlRoute?.({ surface: 'workspace', workspaceKey: a.state.workspaceKey }, 'push'); return 'openWorkbench'; } },
  { id: 'run-query', label: 'Run query', section: 'workspace', surface: 'workspace', key: 'mod-enter', dispatch: 'application', available: (a) => a.activeTab().editorMode !== 'spec', matches: (e) => modKey(e) && e.key === 'Enter' && !e.shiftKey, run: (e, a) => { e.preventDefault(); a.actions.run(); return 'run'; } },
  { id: 'format-document', label: 'Format active document', section: 'workspace', surface: 'workspace', key: 'mod-shift-enter', dispatch: 'application', matches: (e) => modKey(e) && e.key === 'Enter' && !!e.shiftKey, run: (e, a) => { e.preventDefault(); if (a.activeTab().editorMode === 'spec') { a.actions.formatSpec(); return 'formatSpec'; } a.actions.formatQuery(); return 'formatQuery'; } },
  { id: 'save-query', label: 'Save query', section: 'workspace', surface: 'workspace', key: 'mod-s', dispatch: 'application', matches: (e) => modKey(e) && !e.shiftKey && e.key.toLowerCase() === 's', run: (e, a) => { e.preventDefault(); a.actions.save(); return 'save'; } },
  { id: 'share-query', label: 'Share query', section: 'workspace', surface: 'workspace', key: 'mod-shift-s', dispatch: 'application', available: (a) => a.activeTab().editorMode !== 'spec', matches: (e) => modKey(e) && !!e.shiftKey && e.key.toLowerCase() === 's', run: (e, a) => { e.preventDefault(); a.actions.share(); return 'share'; } },
  { id: 'sql-mode', label: 'SQL editor mode', section: 'workspace', surface: 'workspace', key: 'mod-alt-1', dispatch: 'application', matches: (e) => modKey(e) && !!e.altKey && e.key === '1', run: (e, a) => { e.preventDefault(); a.actions.setEditorMode('sql'); return 'sqlMode'; } },
  { id: 'spec-mode', label: 'Spec editor mode', section: 'workspace', surface: 'workspace', key: 'mod-alt-2', dispatch: 'application', matches: (e) => modKey(e) && !!e.altKey && e.key === '2', run: (e, a) => { e.preventDefault(); a.actions.setEditorMode('spec'); return 'specMode'; } },
  { id: 'undo', label: 'Undo', section: 'workspace', surface: 'workspace', key: 'mod-z', dispatch: 'editor' },
  { id: 'redo', label: 'Redo', section: 'workspace', surface: 'workspace', key: 'mod-shift-z', dispatch: 'editor' },
  { id: 'open-reference', label: 'Open reference for symbol', section: 'workspace', surface: 'workspace', key: 'f1', dispatch: 'editor' },
  { id: 'dashboard-refresh', label: 'Refresh all tiles', section: 'dashboard', surface: 'dashboard', key: 'mod-enter', dispatch: 'application', available: (a) => validDashboardPort(a), matches: (e) => modKey(e) && e.key === 'Enter' && !e.shiftKey, run: (e, a) => { e.preventDefault(); a.surfaceCommands!.refresh(); return 'dashboardRefresh'; } },
  { id: 'dashboard-view', label: 'View mode', section: 'dashboard', surface: 'dashboard', key: 'g-v', dispatch: 'application', sequence: ['g', 'v'], run: (e, a) => { e.preventDefault(); if (a.sqlRoute.mode === 'view') return null; void a.navigateSqlRoute?.({ surface: 'dashboard', workspaceKey: a.state.workspaceKey, mode: 'view' }, 'replace'); return 'dashboardView'; } },
  { id: 'dashboard-edit', label: 'Edit mode', section: 'dashboard', surface: 'dashboard', key: 'g-e', dispatch: 'application', sequence: ['g', 'e'], run: (e, a) => { e.preventDefault(); if (a.sqlRoute.mode === 'edit') return null; void a.navigateSqlRoute?.({ surface: 'dashboard', workspaceKey: a.state.workspaceKey, mode: 'edit' }, 'replace'); return 'dashboardEdit'; } },
  { id: 'open-help', label: 'Show this dialog', section: 'general', surface: 'all', key: 'question', dispatch: 'application', matches: (e) => e.key === '?' && !modKey(e) && !isTypingTarget(e.target), run: (e, a) => { e.preventDefault(); a.actions.openShortcuts(); return 'shortcuts'; } },
  { id: 'close-overlay', label: 'Close dialog', section: 'general', surface: 'all', key: 'escape', dispatch: 'application', matches: (e) => e.key === 'Escape', run: (e, a) => { if (a.sqlRoute.surface === 'workspace' && a.closeDocPane?.()) { e.preventDefault(); return 'close-doc-pane'; } if (a.sqlRoute.surface === 'workspace' && a.state.running.value) { e.preventDefault(); a.actions.cancel(); return 'cancel'; } return null; } },
];

const GESTURES = [
  ['Expand / collapse', 'Click'], ['Insert into editor', 'Double-click'], ['Insert DDL / col::type', 'Shift-click'],
] as const;

export interface SurfaceCommandPort {
  surface: 'dashboard';
  generation: number;
  refresh(): void;
}

/** Narrow controller contract; it deliberately avoids importing the full App. */
export interface ShortcutsApp {
  document?: Document;
  state: Pick<State, 'shortcutsOpen' | 'running' | 'workspaceKey'>;
  conn: Pick<ConnectionSession, 'isSignedIn'>;
  sqlRoute: Pick<SqlRoute, 'surface' | 'workspaceKey'> & { mode?: 'view' | 'edit' };
  workspaceRouteStatus: 'loading' | 'ready' | 'not-found' | 'error';
  surfaceCommands?: SurfaceCommandPort | null;
  keyboardOwner?: KeyboardOwner | null;
  acquireKeyboardOwner(kind: KeyboardOwner['kind']): () => void;
  captureSurfaceGeneration?: () => number;
  navigateSqlRoute?: (route: SqlRoute, method: 'push' | 'replace') => Promise<void>;
  closeDocPane?: () => boolean;
  activeTab(): Pick<Tab, 'editorMode'>;
  actions: Pick<ActionsRegistry,
    'cancel' | 'run' | 'formatSpec' | 'formatQuery' | 'setEditorMode' | 'share' | 'save' | 'openShortcuts'>;
}

function platformIsMac(doc: Document): boolean {
  return /mac/i.test(doc.defaultView?.navigator.platform || '');
}

function keyParts(key: KeyName, mac: boolean): string[] {
  const mod = mac ? '⌘' : 'Ctrl'; const alt = mac ? '⌥' : 'Alt'; const shift = mac ? '⇧' : 'Shift';
  const keys: Record<KeyName, string[]> = {
    'mod-enter': [mod, 'Enter'], 'mod-shift-enter': [mod, shift, 'Enter'], 'mod-s': [mod, 'S'],
    'mod-shift-s': [mod, shift, 'S'], 'mod-alt-1': [mod, alt, '1'], 'mod-alt-2': [mod, alt, '2'],
    'mod-z': [mod, 'Z'], 'mod-shift-z': [mod, shift, 'Z'], f1: ['F1'], 'g-d': ['G', 'then', 'D'],
    'g-w': ['G', 'then', 'W'], 'g-v': ['G', 'then', 'V'], 'g-e': ['G', 'then', 'E'], question: ['?'], escape: ['Esc'],
  };
  return keys[key];
}

function visibleDefinitions(app: ShortcutsApp): ShortcutDefinition[] {
  const surface = app.sqlRoute.surface;
  return SHORTCUT_CATALOG.filter((definition) => (
    (definition.surface === 'all' || definition.surface === surface) && (!definition.available || definition.available(app))
  ));
}

function keyCaps(parts: string[]): HTMLElement[] {
  return parts.map((part, index) => part === 'then'
    ? h('span', { class: 'shortcut-then' }, 'then')
    : h('kbd', { key: String(index) }, part));
}

const sectionNames: Record<Section, string> = {
  application: 'Application', workspace: 'SQL Browser', dashboard: 'Dashboard', general: 'General', gestures: 'Schema tree — database · table · column',
};

/** Open accessible, surface-specific help. */
export function openShortcuts(app: ShortcutsApp, onClose?: () => void): { backdrop: HTMLElement; close: () => void } | null {
  const doc = app.document || document;
  if (app.state.shortcutsOpen.value) return null;
  app.state.shortcutsOpen.value = true;
  const releaseKeyboard = app.acquireKeyboardOwner('modal');
  resetShortcutChord(app);
  let previousFocus = doc.activeElement as HTMLElement | null;
  let closed = false;
  const headingId = 'shortcuts-heading';
  const close = (): void => {
    if (closed) return;
    closed = true;
    app.state.shortcutsOpen.value = false;
    releaseKeyboard();
    resetShortcutChord(app);
    detachBackdrop(); backdrop.remove(); doc.removeEventListener('keydown', onKeydown);
    previousFocus?.focus?.(); previousFocus = null;
    onClose?.();
  };
  const onKeydown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') { event.preventDefault(); close(); return; }
    if (event.key !== 'Tab') return;
    const focusable = [...card.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')]
      .filter((element) => !element.hasAttribute('disabled'));
    if (!focusable.length) return;
    const first = focusable[0]; const last = focusable[focusable.length - 1];
    if (event.shiftKey && doc.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && doc.activeElement === last) { event.preventDefault(); first.focus(); }
  };
  const rows = visibleDefinitions(app);
  const mac = platformIsMac(doc);
  const sections: HTMLElement[] = [];
  for (const section of ['application', 'workspace', 'dashboard', 'general'] as const) {
    const entries = rows.filter((row) => row.section === section);
    if (!entries.length) continue;
    sections.push(h('section', { class: 'shortcut-section', 'aria-label': sectionNames[section] },
      h('h3', { class: 'section-label' }, sectionNames[section]),
      ...entries.map((row) => h('div', { class: 'row' }, h('span', { class: 'label' }, row.label),
        h('span', { class: 'shortcut-keys' }, ...keyCaps(keyParts(row.key, mac))))),
    ));
  }
  if (app.sqlRoute.surface === 'workspace') {
    sections.push(h('section', { class: 'shortcut-section', 'aria-label': sectionNames.gestures },
      h('h3', { class: 'section-label' }, sectionNames.gestures),
      ...GESTURES.map(([label, key]) => h('div', { class: 'row' }, h('span', { class: 'label' }, label), h('kbd', null, key))),
    ));
  }
  const closeButton = h('button', { class: 'close-btn', 'aria-label': 'Close keyboard shortcuts', onclick: close }, 'Close');
  const card = h('div', { class: 'modal-card', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': headingId },
    h('h2', { id: headingId }, 'Keyboard shortcuts'),
    h('div', { class: 'modal-card-body' }, ...sections),
    h('div', { class: 'close-row' }, closeButton),
  );
  const backdrop = h('div', { class: 'modal-backdrop' }, card);
  const detachBackdrop = attachBackdropClose(backdrop, close);
  doc.body.appendChild(backdrop);
  doc.addEventListener('keydown', onKeydown);
  closeButton.focus();
  return { backdrop, close };
}

export interface ShortcutEventTarget {
  tagName?: string; isContentEditable?: boolean; ownerDocument?: Document | null;
  getAttribute?(name: string): string | null; closest?(selector: string): Element | null;
}
export interface ShortcutKeydownEvent {
  key: string; metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean;
  defaultPrevented?: boolean; preventDefault(): void; target?: ShortcutEventTarget | null;
}

function isTypingTarget(target?: ShortcutEventTarget | null): boolean {
  if (!target) return false;
  return ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName || '') || !!target.isContentEditable
    || target.getAttribute?.('role') === 'textbox' || !!target.closest?.('.cm-editor, .cm-content, [contenteditable], [role="textbox"]');
}
function ownsKeyboard(app: ShortcutsApp): boolean { return !!app.keyboardOwner; }
function ready(app: ShortcutsApp): boolean {
  return app.workspaceRouteStatus === 'ready'
    && !!app.sqlRoute.workspaceKey && app.sqlRoute.workspaceKey === app.state.workspaceKey;
}

interface Chord { timer: ReturnType<typeof setTimeout> | null; blur: () => void; surface: 'workspace' | 'dashboard'; workspaceKey: string | null; generation: number | null; }
const chords = new WeakMap<ShortcutsApp, Chord>();
export function resetShortcutChord(app: ShortcutsApp): void {
  const chord = chords.get(app); if (!chord) return;
  if (chord.timer) clearTimeout(chord.timer);
  (app.document || document).defaultView?.removeEventListener('blur', chord.blur);
  chords.delete(app);
}
function beginChord(app: ShortcutsApp): void {
  resetShortcutChord(app);
  const chord: Chord = { timer: null, blur: () => resetShortcutChord(app), surface: app.sqlRoute.surface, workspaceKey: app.sqlRoute.workspaceKey, generation: app.captureSurfaceGeneration?.() ?? null };
  chord.timer = setTimeout(() => resetShortcutChord(app), 1500);
  chords.set(app, chord);
  const win = (app.document || document).defaultView;
  win?.addEventListener('blur', chord.blur, { once: true });
}
function consumeChord(e: ShortcutKeydownEvent, app: ShortcutsApp): string | null | undefined {
  const chord = chords.get(app); if (!chord) return undefined;
  resetShortcutChord(app);
  const stillCurrent = chord.surface === app.sqlRoute.surface && chord.workspaceKey === app.sqlRoute.workspaceKey
    && (chord.generation === null || chord.generation === app.captureSurfaceGeneration?.());
  if (!stillCurrent) return null;
  const key = e.key.toLowerCase();
  if (key === 'g') { beginChord(app); e.preventDefault(); return 'chord'; }
  const command = visibleDefinitions(app).find((definition) => definition.sequence?.[0] === 'g'
    && definition.sequence[1] === key);
  return command?.run ? command.run(e, app) : null;
}

/** Global dispatcher. Commands are gated by current route, identity and surface. */
export function handleKeydown(e: ShortcutKeydownEvent, app: ShortcutsApp): string | null {
  if (e.defaultPrevented) return null;
  if (!ready(app)) { resetShortcutChord(app); return null; }
  const mod = modKey(e);
  if (ownsKeyboard(app)) { resetShortcutChord(app); return null; }
  if (!app.conn.isSignedIn()) { resetShortcutChord(app); return null; }
  if (e.key === 'Escape') resetShortcutChord(app);
  const command = visibleDefinitions(app).find((definition) => definition.matches?.(e, app));
  if (command?.run) return command.run(e, app);
  if (mod && e.key.toLowerCase() === 'a') {
    if (isTypingTarget(e.target)) return null;
    const doc = e.target?.ownerDocument || app.document || document;
    const box = doc.querySelector('.cd-pre') || doc.querySelector('.raw-text-view, .json-view');
    if (!box) return null; e.preventDefault(); box.ownerDocument.defaultView!.getSelection()!.selectAllChildren(box); return 'selectAll';
  }
  if (!mod && !isTypingTarget(e.target)) {
    const result = consumeChord(e, app); if (result !== undefined) return result;
    if (visibleDefinitions(app).some((definition) => definition.sequence?.[0] === e.key.toLowerCase())) {
      beginChord(app); e.preventDefault(); return 'chord';
    }
  }
  return null;
}

function modKey(e: ShortcutKeydownEvent): boolean { return !!(e.metaKey || e.ctrlKey); }
function validDashboardPort(app: ShortcutsApp): boolean {
  const port = app.surfaceCommands;
  return !!port && port.surface === 'dashboard'
    && port.generation === (app.captureSurfaceGeneration?.() ?? port.generation);
}
