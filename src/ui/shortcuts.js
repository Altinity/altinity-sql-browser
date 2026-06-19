// Keyboard-shortcuts modal + the global key handler.

import { h } from './dom.js';

const SHORTCUTS = [
  ['Run query', '⌘↵'],
  ['New tab', '⌘T'],
  ['Close tab', '⌘W'],
  ['Save / unsave query', '⌘S'],
  ['Share query', '⌘⇧S'],
  ['Show this dialog', '?'],
  ['Close dialog', 'Esc'],
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
  const card = h('div', { class: 'modal-card', onclick: (e) => e.stopPropagation() },
    h('h2', null, 'Keyboard shortcuts'),
    ...SHORTCUTS.map(([label, key]) =>
      h('div', { class: 'row' }, h('span', { class: 'label' }, label), h('kbd', null, key))),
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
  if (mod && e.key === 'Enter') {
    e.preventDefault();
    app.actions.run();
    return 'run';
  }
  if (mod && e.key.toLowerCase() === 't') {
    if (!signedIn) return null;
    e.preventDefault();
    app.actions.newTab();
    return 'newTab';
  }
  if (mod && e.key.toLowerCase() === 'w') {
    if (!signedIn || app.state.tabs.length <= 1) return null;
    e.preventDefault();
    app.actions.closeTab(app.state.activeTabId);
    return 'closeTab';
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
    app.actions.toggleSaved();
    return 'toggleSaved';
  }
  if (mod && e.key.toLowerCase() === 'a') {
    // When a raw result pane (TSV / JSON output) is on screen and the user isn't
    // typing, ⌘/Ctrl+A selects just that text so it can be copied — not the whole
    // page. Keyed off "not editing + pane present" rather than pane focus, because
    // macOS WebKit doesn't focus a tabindex <div> on click (so e.target stays
    // <body>). A focused editor/input keeps the native select-all (whole query).
    const t = e.target;
    if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.isContentEditable)) return null;
    const doc = (t && t.ownerDocument) || document;
    const box = doc.querySelector('.raw-text-view, .json-view');
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
