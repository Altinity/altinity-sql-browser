// Keyboard-shortcuts modal + the global key handler.

import { h, attachBackdropClose } from './dom.js';
import type { ActionsRegistry, State, Tab } from './app.types.js';
import type { ConnectionSession } from '../application/connection-session.js';

/** The narrow slice of the real `app` controller this module reads — not
 *  the full ~50-member `App` contract (app.types.ts). A real `App` satisfies
 *  this directly, and so does tests/helpers/fake-app.js's long-standing
 *  minimal `makeApp()` fixture (this module predates ADR-0002's App
 *  contract) — no cast needed on either side. */
export interface ShortcutsApp {
  document?: Document;
  state: Pick<State, 'shortcutsOpen' | 'running'>;
  conn: Pick<ConnectionSession, 'isSignedIn'>;
  activeTab(): Pick<Tab, 'editorMode'>;
  actions: Pick<
    ActionsRegistry,
    'cancel' | 'run' | 'formatSpec' | 'formatQuery' | 'setEditorMode' | 'share' | 'save' | 'openShortcuts'
  >;
}

const SHORTCUTS: string[][] = [
  ['Run query', '⌘↵'],
  ['Format active document', '⌘⇧↵'],
  ['Save query', '⌘S'],
  ['Share query', '⌘⇧S'],
  ['SQL editor mode', '⌘⌥1'],
  ['Spec editor mode', '⌘⌥2'],
  ['Undo', '⌘Z'],
  ['Redo', '⌘⇧Z'],
  ['Show this dialog', '?'],
  ['Close dialog', 'Esc'],
];

// Mouse gestures on the schema tree (db / table / column). Kept terse — the
// per-row tooltips carry the detail; this just signals the gestures exist.
const GESTURES: string[][] = [
  ['Expand / collapse', 'Click'],
  ['Insert into editor', 'Double-click'],
  ['Insert DDL / col::type', 'Shift-click'],
];

/** Open the shortcuts modal. Idempotent while open (tracked on state). */
export function openShortcuts(app: ShortcutsApp): { backdrop: HTMLElement; close: () => void } | null {
  const doc = app.document || document;
  if (app.state.shortcutsOpen.value) return null;
  app.state.shortcutsOpen.value = true;
  const close = (): void => {
    app.state.shortcutsOpen.value = false;
    detachBackdrop();
    backdrop.remove();
    doc.removeEventListener('keydown', escHandler);
  };
  const escHandler = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') close();
  };
  doc.addEventListener('keydown', escHandler);
  const rowOf = ([label, key]: string[]): HTMLElement =>
    h('div', { class: 'row' }, h('span', { class: 'label' }, label), h('kbd', null, key));
  const card = h('div', { class: 'modal-card' },
    h('h2', null, 'Keyboard shortcuts'),
    ...SHORTCUTS.map(rowOf),
    h('div', { class: 'section-label' }, 'Schema tree — database · table · column'),
    ...GESTURES.map(rowOf),
    h('div', { class: 'close-row' }, h('button', { class: 'close-btn', onclick: close }, 'Close')),
  );
  const backdrop = h('div', { class: 'modal-backdrop' }, card);
  const detachBackdrop = attachBackdropClose(backdrop, close);
  doc.body.appendChild(backdrop);
  return { backdrop, close };
}

/** The event target shape `handleKeydown`'s ⌘A/`?` arms duck-type over — a
 *  real `Element` satisfies it directly (structurally); test fixtures pass a
 *  plain object instead of a full DOM node. */
export interface ShortcutEventTarget {
  tagName?: string;
  isContentEditable?: boolean;
  ownerDocument?: Document | null;
}

/** The minimal keydown-event shape this handler reads. A real `KeyboardEvent`
 *  (from the app's global `keydown` listener) satisfies it directly; tests
 *  build a small plain-object fixture instead of a real event. */
export interface ShortcutKeydownEvent {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  defaultPrevented?: boolean;
  preventDefault(): void;
  target?: ShortcutEventTarget | null;
}

/**
 * Handle a global keydown. Returns the action name it dispatched (or null).
 * `app` provides state + the action callbacks; `signedIn` gates editing keys.
 */
export function handleKeydown(e: ShortcutKeydownEvent, app: ShortcutsApp): string | null {
  // A key the editor already consumed (CM6 preventDefaults what it handles —
  // e.g. Esc closing the completion popup or search panel) must not ALSO
  // trigger a global action like cancelling the running query.
  if (e.defaultPrevented) return null;
  const mod = e.metaKey || e.ctrlKey;
  const signedIn = app.conn.isSignedIn();
  const editorMode = app.activeTab().editorMode || 'sql';
  // Esc cancels an in-flight query (aborts the stream + KILL QUERY).
  if (e.key === 'Escape' && app.state.running.value) {
    e.preventDefault();
    app.actions.cancel();
    return 'cancel';
  }
  if (mod && e.key === 'Enter') {
    // Format targets the active document. Plain Mod-Enter is SQL-only.
    if (e.shiftKey) {
      if (!signedIn) return null;
      e.preventDefault();
      if (editorMode === 'spec') {
        app.actions.formatSpec();
        return 'formatSpec';
      }
      app.actions.formatQuery();
      return 'formatQuery';
    }
    if (editorMode !== 'sql') return null;
    e.preventDefault();
    app.actions.run();
    return 'run';
  }
  if (mod && e.altKey && (e.key === '1' || e.key === '2')) {
    if (!signedIn) return null;
    e.preventDefault();
    const mode = e.key === '1' ? 'sql' : 'spec';
    app.actions.setEditorMode(mode);
    return mode + 'Mode';
  }
  if (mod && e.shiftKey && e.key.toLowerCase() === 's') {
    if (!signedIn || editorMode !== 'sql') return null;
    e.preventDefault();
    app.actions.share();
    return 'share';
  }
  if (mod && e.key.toLowerCase() === 's') {
    if (!signedIn) return null;
    e.preventDefault();
    app.actions.save();
    return 'save';
  }
  if (mod && e.key.toLowerCase() === 'a') {
    // When a selectable text pane is on screen and the user isn't typing,
    // ⌘/Ctrl+A selects just that text so it can be copied — not the whole page.
    // Keyed off "not editing + pane present" rather than pane focus, because
    // macOS WebKit doesn't focus a tabindex <div> on click (so e.target stays
    // <body>). A focused editor/input keeps the native select-all (whole query).
    // The cell-detail drawer (.cd-pre) is a modal overlay — when open it wins
    // over the result pane behind it, so select all of *its* text.
    const t = e.target;
    if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.isContentEditable)) return null;
    const doc = (t && t.ownerDocument) || document;
    const box = doc.querySelector('.cd-pre') || doc.querySelector('.raw-text-view, .json-view');
    if (!box) return null;
    e.preventDefault();
    box.ownerDocument.defaultView!.getSelection()!.selectAllChildren(box);
    return 'selectAll';
  }
  if (e.key === '?' && !mod) {
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return null;
    if (!signedIn) return null;
    e.preventDefault();
    app.actions.openShortcuts();
    return 'shortcuts';
  }
  return null;
}
