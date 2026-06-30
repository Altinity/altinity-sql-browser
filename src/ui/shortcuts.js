// Keyboard-shortcuts modal + the global key handler.

import { h } from './dom.js';

const SHORTCUTS = [
  ['Run query', '⌘↵'],
  ['Format query', '⌘⇧↵'],
  ['Save query', '⌘S'],
  ['Share query', '⌘⇧S'],
  ['Undo', '⌘Z'],
  ['Redo', '⌘⇧Z'],
  ['Show this dialog', '?'],
  ['Close dialog', 'Esc'],
];

// Mouse gestures on the schema tree (db / table / column). Kept terse — the
// per-row tooltips carry the detail; this just signals the gestures exist.
const GESTURES = [
  ['Expand / collapse', 'Click'],
  ['Insert into editor', 'Double-click'],
  ['Insert DDL / col::type', 'Shift-click'],
];

/** Open the shortcuts modal. Idempotent while open (tracked on state). */
export function openShortcuts(app) {
  const doc = app.document || document;
  if (app.state.shortcutsOpen) return null;
  app.state.shortcutsOpen = true;
  const close = () => {
    app.state.shortcutsOpen = false;
    backdrop.remove();
    doc.removeEventListener('keydown', escHandler);
  };
  const escHandler = (e) => {
    if (e.key === 'Escape') close();
  };
  doc.addEventListener('keydown', escHandler);
  const rowOf = ([label, key]) =>
    h('div', { class: 'row' }, h('span', { class: 'label' }, label), h('kbd', null, key));
  const card = h('div', { class: 'modal-card', onclick: (e) => e.stopPropagation() },
    h('h2', null, 'Keyboard shortcuts'),
    ...SHORTCUTS.map(rowOf),
    h('div', { class: 'section-label' }, 'Schema tree — database · table · column'),
    ...GESTURES.map(rowOf),
    h('div', { class: 'close-row' }, h('button', { class: 'close-btn', onclick: close }, 'Close')),
  );
  const backdrop = h('div', { class: 'modal-backdrop', onclick: close }, card);
  doc.body.appendChild(backdrop);
  return { backdrop, close };
}

/**
 * Handle a global keydown. Returns the action name it dispatched (or null).
 * `app` provides state + the action callbacks; `signedIn` gates editing keys.
 */
export function handleKeydown(e, app) {
  const mod = e.metaKey || e.ctrlKey;
  const signedIn = app.isSignedIn();
  // Esc cancels an in-flight query (aborts the stream + KILL QUERY).
  if (e.key === 'Escape' && app.state.running.value) {
    e.preventDefault();
    app.actions.cancel();
    return 'cancel';
  }
  if (mod && e.key === 'Enter') {
    // ⌘/Ctrl+Shift+Enter = format (gated by sign-in); ⌘/Ctrl+Enter = run.
    if (e.shiftKey) {
      if (!signedIn) return null;
      e.preventDefault();
      app.actions.formatQuery();
      return 'formatQuery';
    }
    e.preventDefault();
    app.actions.run();
    return 'run';
  }
  if (mod && e.shiftKey && e.key.toLowerCase() === 's') {
    if (!signedIn) return null;
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
    box.ownerDocument.defaultView.getSelection().selectAllChildren(box);
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
