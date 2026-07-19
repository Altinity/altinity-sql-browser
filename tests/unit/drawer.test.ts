import { describe, it, expect, vi } from 'vitest';
import { buildDrawerChrome, attachDrawerResize } from '../../src/ui/drawer.js';
import type { DrawerResizeApp } from '../../src/ui/drawer.js';

const qs = <T extends Element = HTMLElement>(root: ParentNode, selector: string): T => root.querySelector(selector) as T;

// A minimal fixture satisfying DrawerResizeApp — only the two members
// attachDrawerResize actually reads/writes.
function makeResizeApp(cellDrawerPx = 560): DrawerResizeApp {
  return { state: { cellDrawerPx }, prefs: { save: vi.fn() } };
}

describe('buildDrawerChrome', () => {
  it('builds the default (.cd-*) scaffold: panel > head > (title, close button)', () => {
    const onClose = vi.fn();
    const { panel, head } = buildDrawerChrome(document, {
      title: [document.createTextNode('col'), document.createTextNode('String')],
      onClose,
    });
    expect(panel.tagName).toBe('DIV');
    expect(panel.className).toBe('cd-panel');
    expect(panel.children).toHaveLength(1);
    expect(panel.firstElementChild).toBe(head);
    expect(head.className).toBe('cd-head');
    const title = qs(head, '.cd-title');
    expect(title).not.toBeNull();
    expect(title.textContent).toBe('colString');
    const closeBtn = qs<HTMLButtonElement>(head, '.cd-close');
    expect(closeBtn).not.toBeNull();
    expect(closeBtn.getAttribute('title')).toBe('Close (Esc)');
    // head is [title, close] in that order.
    expect(head.children[0]).toBe(title);
    expect(head.children[1]).toBe(closeBtn);
    closeBtn.dispatchEvent(new Event('click', { bubbles: true }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('skips null/false title children, matching h()`s child-skipping (an absent optional type span)', () => {
    const { head } = buildDrawerChrome(document, {
      title: [document.createTextNode('name'), null, false],
      onClose: vi.fn(),
    });
    const title = qs(head, '.cd-title');
    expect(title.childNodes).toHaveLength(1);
    expect(title.textContent).toBe('name');
  });

  it('uses a caller-supplied classPrefix instead of the default cd-* classes', () => {
    const { panel, head } = buildDrawerChrome(document, {
      classPrefix: 'docs',
      title: [document.createTextNode('Docs')],
      onClose: vi.fn(),
    });
    expect(panel.className).toBe('docs-panel');
    expect(head.className).toBe('docs-head');
    expect(qs(head, '.docs-title')).not.toBeNull();
    expect(qs(head, '.docs-close')).not.toBeNull();
    // No leftover .cd-* classes anywhere in the custom-prefixed scaffold.
    expect(panel.querySelector('.cd-head, .cd-title, .cd-close')).toBeNull();
  });

  it('builds into a targetDoc other than the ambient document', () => {
    const childDoc = document.implementation.createHTMLDocument('child');
    const { panel, head } = buildDrawerChrome(childDoc, { title: ['x'], onClose: vi.fn() });
    expect(panel.ownerDocument).toBe(childDoc);
    expect(head.ownerDocument).toBe(childDoc);
  });
});

describe('attachDrawerResize', () => {
  it('sets the initial panel width from the persisted cellDrawerPx pref and appends a resize handle', () => {
    const app = makeResizeApp(640);
    const panel = document.createElement('div');
    document.body.appendChild(panel);
    attachDrawerResize(app, panel, document);
    expect(panel.style.width).toBe('640px');
    expect(qs(panel, '.cd-resize-h')).not.toBeNull();
    panel.remove();
  });

  it('clamps the initial width to [320, 92vw] (window.innerWidth = 1024 under happy-dom)', () => {
    const narrow = document.createElement('div');
    attachDrawerResize(makeResizeApp(100), narrow, document);
    expect(narrow.style.width).toBe('320px');

    const wide = document.createElement('div');
    attachDrawerResize(makeResizeApp(5000), wide, document);
    expect(wide.style.width).toBe(1024 * 0.92 + 'px');
  });

  it('dragging the handle resizes the panel live and persists the width on mouseup', () => {
    const app = makeResizeApp();
    const panel = document.createElement('div');
    document.body.appendChild(panel);
    attachDrawerResize(app, panel, document);
    const handle = qs(panel, '.cd-resize-h');
    handle.dispatchEvent(new MouseEvent('mousedown', { clientX: 700, bubbles: true }));
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 500 })); // 1024-500
    expect(panel.style.width).toBe('524px');
    window.dispatchEvent(new MouseEvent('mouseup', {}));
    expect(app.state.cellDrawerPx).toBe(524);
    expect(app.prefs.save).toHaveBeenCalledWith('cellDrawerPx', 524);
    panel.remove();
  });

  it('clamps mid-drag width to [320, 92vw]', () => {
    const app = makeResizeApp();
    const panel = document.createElement('div');
    document.body.appendChild(panel);
    attachDrawerResize(app, panel, document);
    const handle = qs(panel, '.cd-resize-h');
    handle.dispatchEvent(new MouseEvent('mousedown', { clientX: 700, bubbles: true }));
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 2000 })); // 1024-2000 < 0 → floor
    expect(panel.style.width).toBe('320px');
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: -2000 })); // way over → 92vw cap
    expect(panel.style.width).toBe(1024 * 0.92 + 'px');
    window.dispatchEvent(new MouseEvent('mouseup', {}));
    panel.remove();
  });

  it('the returned cancel() mid-drag reverts the width, does not persist, and tears down its window listeners (a later mouseup/mousemove is inert)', () => {
    const app = makeResizeApp(560);
    const panel = document.createElement('div');
    document.body.appendChild(panel);
    const cancelDrag = attachDrawerResize(app, panel, document);
    const handle = qs(panel, '.cd-resize-h');
    handle.dispatchEvent(new MouseEvent('mousedown', { clientX: 700, bubbles: true }));
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 500 })); // mid-drag, no mouseup yet
    expect(app.state.cellDrawerPx).toBe(524);

    cancelDrag(); // e.g. a caller's close() firing while the mouse button is still down
    expect(app.state.cellDrawerPx).toBe(560); // reverted — the abandoned drag never committed
    expect(app.prefs.save).not.toHaveBeenCalled();

    // Torn down, not just left to resolve later: a stray mousemove/mouseup
    // must not resurrect or persist the cancelled drag.
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 100 }));
    window.dispatchEvent(new MouseEvent('mouseup', {}));
    expect(app.state.cellDrawerPx).toBe(560);
    expect(app.prefs.save).not.toHaveBeenCalled();
    panel.remove();
  });

  it('cancel() is a no-op when no drag is in progress', () => {
    const app = makeResizeApp(560);
    const panel = document.createElement('div');
    const cancelDrag = attachDrawerResize(app, panel, document);
    expect(() => cancelDrag()).not.toThrow();
    expect(() => cancelDrag()).not.toThrow(); // idempotent
    expect(app.state.cellDrawerPx).toBe(560);
    expect(app.prefs.save).not.toHaveBeenCalled();
  });

  it('falls back to the ambient window when doc.defaultView is null (a detached document not yet attached to a browsing context)', () => {
    const detachedDoc = document.implementation.createHTMLDocument('detached');
    expect(detachedDoc.defaultView).toBeNull();
    const app = makeResizeApp(9999); // clamps against the ambient window's innerWidth (1024)
    const panel = detachedDoc.createElement('div');
    attachDrawerResize(app, panel, detachedDoc);
    expect(panel.style.width).toBe(1024 * 0.92 + 'px');
  });
});
