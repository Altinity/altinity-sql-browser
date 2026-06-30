import { describe, it, expect, vi, beforeEach } from 'vitest';
import { openShortcuts, handleKeydown } from '../../src/ui/shortcuts.js';
import { makeApp } from '../helpers/fake-app.js';

beforeEach(() => { document.body.innerHTML = ''; });

describe('openShortcuts', () => {
  it('opens a modal and is idempotent while open', () => {
    const app = makeApp({ document });
    const r = openShortcuts(app);
    expect(app.state.shortcutsOpen).toBe(true);
    expect(document.querySelector('.modal-backdrop')).not.toBeNull();
    expect(openShortcuts(app)).toBeNull(); // already open
    r.close();
    expect(app.state.shortcutsOpen).toBe(false);
    expect(document.querySelector('.modal-backdrop')).toBeNull();
  });
  it('closes on Escape and ignores other keys', () => {
    const app = makeApp({ document });
    openShortcuts(app);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
    expect(app.state.shortcutsOpen).toBe(true);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(app.state.shortcutsOpen).toBe(false);
  });
  it('closes when the backdrop is clicked', () => {
    const app = makeApp({ document });
    openShortcuts(app);
    document.querySelector('.modal-backdrop').dispatchEvent(new Event('click'));
    expect(app.state.shortcutsOpen).toBe(false);
  });
  it('card click does not close (stopPropagation)', () => {
    const app = makeApp({ document });
    openShortcuts(app);
    const card = document.querySelector('.modal-card');
    card.dispatchEvent(new Event('click', { bubbles: true }));
    expect(app.state.shortcutsOpen).toBe(true);
  });
  it('defaults document to global', () => {
    const app = makeApp();
    delete app.document;
    openShortcuts(app);
    expect(document.querySelector('.modal-card')).not.toBeNull();
  });
  it('lists keyboard shortcuts plus a schema-tree gestures section', () => {
    const app = makeApp({ document });
    openShortcuts(app);
    const text = document.querySelector('.modal-card').textContent;
    expect(text).toContain('Format query');
    expect(document.querySelector('.modal-card .section-label')).not.toBeNull();
    expect(text).toContain('Double-click');
    expect(text).toContain('Shift-click');
  });
});

describe('handleKeydown', () => {
  const ev = (over) => ({ preventDefault: vi.fn(), key: '', metaKey: false, ctrlKey: false, shiftKey: false, target: {}, ...over });

  it('⌘Enter runs (even when signed out)', () => {
    const app = makeApp({ isSignedIn: () => false });
    expect(handleKeydown(ev({ metaKey: true, key: 'Enter' }), app)).toBe('run');
    expect(app.actions.run).toHaveBeenCalled();
  });
  it('Escape cancels a running query, and is a no-op otherwise', () => {
    const app = makeApp();
    app.state.running.value = false;
    expect(handleKeydown(ev({ key: 'Escape' }), app)).toBeNull();
    expect(app.actions.cancel).not.toHaveBeenCalled();
    app.state.running.value = true;
    expect(handleKeydown(ev({ key: 'Escape' }), app)).toBe('cancel');
    expect(app.actions.cancel).toHaveBeenCalled();
  });
  it('⌘T / ⌘W are no longer intercepted (browser keeps them)', () => {
    const app = makeApp();
    expect(handleKeydown(ev({ metaKey: true, key: 't' }), app)).toBeNull();
    expect(handleKeydown(ev({ metaKey: true, key: 'w' }), app)).toBeNull();
    expect(app.actions.newTab).not.toHaveBeenCalled();
    expect(app.actions.closeTab).not.toHaveBeenCalled();
  });
  it('⌘⇧↵ formats the query; gated by sign-in', () => {
    const app = makeApp();
    const e = ev({ metaKey: true, shiftKey: true, key: 'Enter' });
    expect(handleKeydown(e, app)).toBe('formatQuery');
    expect(app.actions.formatQuery).toHaveBeenCalled();
    expect(app.actions.run).not.toHaveBeenCalled();
    expect(e.preventDefault).toHaveBeenCalled();
    const out = makeApp({ isSignedIn: () => false });
    expect(handleKeydown(ev({ metaKey: true, shiftKey: true, key: 'Enter' }), out)).toBeNull();
  });
  it('⌘⇧S shares; ⌘S toggles saved', () => {
    const app = makeApp();
    expect(handleKeydown(ev({ metaKey: true, shiftKey: true, key: 'S' }), app)).toBe('share');
    expect(handleKeydown(ev({ metaKey: true, key: 's' }), app)).toBe('save');
    const out = makeApp({ isSignedIn: () => false });
    expect(handleKeydown(ev({ metaKey: true, shiftKey: true, key: 's' }), out)).toBeNull();
    expect(handleKeydown(ev({ metaKey: true, key: 's' }), out)).toBeNull();
  });
  it('? opens shortcuts unless typing in a field', () => {
    const app = makeApp();
    expect(handleKeydown(ev({ key: '?' }), app)).toBe('shortcuts');
    expect(handleKeydown(ev({ key: '?', target: { tagName: 'INPUT' } }), app)).toBeNull();
    expect(handleKeydown(ev({ key: '?', target: { isContentEditable: true } }), app)).toBeNull();
    const out = makeApp({ isSignedIn: () => false });
    expect(handleKeydown(ev({ key: '?' }), out)).toBeNull();
  });
  it('returns null for unhandled keys', () => {
    const app = makeApp();
    expect(handleKeydown(ev({ key: 'x' }), app)).toBeNull();
    expect(handleKeydown(ev({ key: '?', target: null }), makeApp())).toBe('shortcuts');
  });

  it('⌘A selects a raw result pane even when it is not focused (macOS body target)', () => {
    const app = makeApp();
    const box = document.createElement('div');
    box.className = 'raw-text-view';
    box.textContent = 'a\tb\nc\td';
    document.body.appendChild(box);
    // target is <body> (pane not focused — the macOS WebKit case), pane on screen
    const e = ev({ metaKey: true, key: 'a', target: document.body });
    expect(handleKeydown(e, app)).toBe('selectAll');
    expect(e.preventDefault).toHaveBeenCalled();
    expect(box.ownerDocument.defaultView.getSelection().toString()).toBe('a\tb\nc\td');
  });

  it('⌘A selects the cell-detail drawer text (and wins over the pane behind it)', () => {
    const app = makeApp();
    const pane = document.createElement('div');
    pane.className = 'raw-text-view';
    pane.textContent = 'pane text';
    document.body.appendChild(pane);
    const pre = document.createElement('pre');
    pre.className = 'cd-pre';
    pre.textContent = '{"version":1}';
    document.body.appendChild(pre);
    const e = ev({ metaKey: true, key: 'a', target: document.body });
    expect(handleKeydown(e, app)).toBe('selectAll');
    expect(pre.ownerDocument.defaultView.getSelection().toString()).toBe('{"version":1}');
  });

  it('⌘A while editing keeps the native select-all (editor / inputs)', () => {
    const app = makeApp();
    document.body.appendChild(document.createElement('div')).className = 'raw-text-view';
    const ta = document.createElement('textarea');
    const e = ev({ metaKey: true, key: 'A', target: ta });
    expect(handleKeydown(e, app)).toBeNull();
    expect(e.preventDefault).not.toHaveBeenCalled();
    expect(handleKeydown(ev({ metaKey: true, key: 'a', target: { tagName: 'INPUT' } }), app)).toBeNull();
    expect(handleKeydown(ev({ metaKey: true, key: 'a', target: { isContentEditable: true } }), app)).toBeNull();
  });

  it('⌘A with no raw pane on screen falls through to native select-all', () => {
    const app = makeApp();
    expect(handleKeydown(ev({ metaKey: true, key: 'a', target: null }), app)).toBeNull();
  });
});
