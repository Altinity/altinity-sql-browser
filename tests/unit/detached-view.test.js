import { describe, it, expect, afterEach, vi } from 'vitest';
import { signal } from '@preact/signals-core';
import { openInDetachedTab } from '../../src/ui/detached-view.js';

const detachedState = () => ({ detachedView: signal(0) });

// A same-origin child window backed by a detached document (what a real
// about:blank tab exposes to the opener), with capturable pagehide/close.
const makeWin = () => {
  const childDoc = document.implementation.createHTMLDocument('');
  const ls = {};
  return {
    document: childDoc, closed: false,
    close: vi.fn(), focus: vi.fn(),
    addEventListener: (t, fn) => { ls[t] = fn; },
    fire: (t) => ls[t] && ls[t](),
  };
};

describe('openInDetachedTab — real browser tab', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    document.documentElement.removeAttribute('data-theme');
    document.documentElement.removeAttribute('data-density');
    document.documentElement.style.removeProperty('--vp-zoom');
  });

  it('mirrors CSS + theme, sets body/title, focuses the tab, and calls mount() with the child doc', () => {
    document.documentElement.setAttribute('data-theme', 'dark');
    document.documentElement.setAttribute('data-density', 'compact');
    document.documentElement.style.setProperty('--vp-zoom', '2');
    const win = makeWin();
    const app = { document, stylesText: 'body{color:red}', faviconHref: 'data:image/svg+xml;base64,AA', openWindow: () => win, state: detachedState() };
    const mount = vi.fn();
    openInDetachedTab(app, { title: 'Widget', mode: 'graph', mount });
    expect(win.document.querySelector('style').textContent).toBe('body{color:red}');
    expect(win.document.querySelector('link[rel="icon"]').getAttribute('href')).toBe('data:image/svg+xml;base64,AA');
    expect(win.document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(win.document.documentElement.getAttribute('data-density')).toBe('compact');
    expect(win.document.documentElement.style.getPropertyValue('--vp-zoom')).toBe('2');
    expect(win.document.title).toBe('Widget');
    expect(win.document.body.className).toBe('detached-tab');
    expect(win.focus).toHaveBeenCalled();
    expect(mount).toHaveBeenCalledTimes(1);
    const arg = mount.mock.calls[0][0];
    expect(arg.doc).toBe(win.document);
    expect(arg.bar.className).toBe('graph-overlay-bar');
    expect(arg.bar.querySelector('.graph-overlay-title').textContent).toBe('Widget');
    expect(typeof arg.close).toBe('function');
    expect(win.document.querySelector('.graph-overlay-close')).toBeNull(); // no JS close in a real tab
  });

  it('skips the favicon <link> entirely when the app has none', () => {
    const win = makeWin();
    openInDetachedTab({ openWindow: () => win, state: detachedState() }, { title: 'X', mode: 'graph', mount: () => {} });
    expect(win.document.querySelector('link[rel="icon"]')).toBeNull();
  });

  it('falls back to stylesText="" when the app has none', () => {
    const win = makeWin();
    openInDetachedTab({ openWindow: () => win, state: detachedState() }, { title: 'X', mode: 'graph', mount: () => {} });
    expect(win.document.querySelector('style').textContent).toBe('');
  });

  it('skips theme mirroring for unset attributes (no data-theme/data-density/--vp-zoom on the opener)', () => {
    const win = makeWin();
    openInDetachedTab({ document, openWindow: () => win, state: detachedState() }, { title: 'X', mode: 'graph', mount: () => {} });
    expect(win.document.documentElement.getAttribute('data-theme')).toBeNull();
    expect(win.document.documentElement.style.getPropertyValue('--vp-zoom')).toBe('');
  });

  it('picks the grid body class for mode:"grid" and graph for mode:"graph"', () => {
    const winA = makeWin();
    openInDetachedTab({ openWindow: () => winA, state: detachedState() }, { title: 'A', mode: 'grid', mount: () => {} });
    expect(winA.document.querySelector('.data-pane-body')).not.toBeNull();
    expect(winA.document.querySelector('.graph-overlay-canvas')).toBeNull();
    const winB = makeWin();
    openInDetachedTab({ openWindow: () => winB, state: detachedState() }, { title: 'B', mode: 'graph', mount: () => {} });
    expect(winB.document.querySelector('.graph-overlay-canvas')).not.toBeNull();
    expect(winB.document.querySelector('.data-pane-body')).toBeNull();
  });

  it('runs the teardown fn mount() returns exactly once, even across a double close()', () => {
    const win = makeWin();
    const teardown = vi.fn();
    let captured;
    openInDetachedTab({ openWindow: () => win, state: detachedState() }, {
      title: 'X', mode: 'graph', mount: ({ close }) => { captured = close; return teardown; },
    });
    captured();
    captured();
    expect(teardown).toHaveBeenCalledTimes(1);
  });

  it('tolerates mount() returning nothing (no teardown to run)', () => {
    const win = makeWin();
    let captured;
    expect(() => {
      openInDetachedTab({ openWindow: () => win, state: detachedState() }, {
        title: 'X', mode: 'graph', mount: ({ close }) => { captured = close; },
      });
      captured();
    }).not.toThrow();
  });

  it('closing the real tab (pagehide) runs teardown and decrements app.state.detachedView', () => {
    const win = makeWin();
    const app = { openWindow: () => win, state: detachedState() };
    const teardown = vi.fn();
    openInDetachedTab(app, { title: 'X', mode: 'graph', mount: () => teardown });
    expect(app.state.detachedView.value).toBe(1);
    win.fire('pagehide');
    expect(teardown).toHaveBeenCalledTimes(1);
    expect(app.state.detachedView.value).toBe(0);
  });

  it('tracks two simultaneously-open tabs independently — closing one leaves the other counted', () => {
    const winA = makeWin();
    const winB = makeWin();
    const app = { state: detachedState() };
    app.openWindow = () => winA;
    let closeA;
    openInDetachedTab(app, { title: 'A', mode: 'graph', mount: ({ close }) => { closeA = close; } });
    app.openWindow = () => winB;
    openInDetachedTab(app, { title: 'B', mode: 'graph', mount: () => {} });
    expect(app.state.detachedView.value).toBe(2);
    closeA();
    expect(app.state.detachedView.value).toBe(1);
    winB.fire('pagehide');
    expect(app.state.detachedView.value).toBe(0);
  });
});

describe('openInDetachedTab — overlay fallback', () => {
  afterEach(() => { document.body.innerHTML = ''; });

  it('mounts the overlay in the main document; mount() places closeBtn — placement is not the primitive\'s call', () => {
    const app = { document, openWindow: () => null, state: detachedState() };
    openInDetachedTab(app, {
      title: 'Widget', mode: 'graph',
      mount: ({ doc, bar, closeBtn }) => {
        expect(doc).toBe(document);
        const ownButton = document.createElement('span');
        ownButton.className = 'own-button';
        bar.append(ownButton, closeBtn); // own content first, closeBtn last — mount()'s choice
      },
    });
    const overlay = document.querySelector('.graph-overlay');
    expect(overlay).not.toBeNull();
    expect(overlay.querySelector('.graph-overlay-title').textContent).toBe('Widget');
    const barChildren = [...overlay.querySelector('.graph-overlay-bar').children];
    expect(barChildren[barChildren.length - 1].className).toBe('graph-overlay-close');
    overlay.querySelector('.graph-overlay-panel').dispatchEvent(new Event('click', { bubbles: true }));
    expect(document.body.contains(overlay)).toBe(true); // panel click doesn't close
    overlay.querySelector('.graph-overlay-close').dispatchEvent(new Event('click', { bubbles: true }));
    expect(document.body.contains(overlay)).toBe(false);
  });

  it('does not append closeBtn anywhere itself — a mount() that ignores it gets no ✕ at all', () => {
    openInDetachedTab({ document, openWindow: () => null, state: detachedState() }, {
      title: 'X', mode: 'graph', mount: () => {}, // never touches closeBtn
    });
    expect(document.querySelector('.graph-overlay-close')).toBeNull();
  });

  it('passes a real, close-wired button as closeBtn (mount() can click it directly)', () => {
    let received;
    openInDetachedTab({ document, openWindow: () => null, state: detachedState() }, {
      title: 'X', mode: 'graph', mount: ({ closeBtn }) => { received = closeBtn; },
    });
    expect(received).toBeInstanceOf(document.defaultView.HTMLButtonElement);
    expect(received.className).toBe('graph-overlay-close');
    received.dispatchEvent(new Event('click', { bubbles: true }));
    expect(document.querySelector('.graph-overlay')).toBeNull();
  });

  it('a backdrop click closes the overlay and decrements detachedView', () => {
    const app = { document, openWindow: () => null, state: detachedState() };
    openInDetachedTab(app, { title: 'X', mode: 'graph', mount: () => {} });
    expect(app.state.detachedView.value).toBe(1);
    const overlay = document.querySelector('.graph-overlay');
    overlay.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    overlay.dispatchEvent(new Event('click', { bubbles: true }));
    expect(document.querySelector('.graph-overlay')).toBeNull();
    expect(app.state.detachedView.value).toBe(0);
  });

  it('a gesture starting inside the panel and ending on the backdrop does not close it (#110)', () => {
    openInDetachedTab({ document, openWindow: () => null, state: detachedState() }, {
      title: 'X', mode: 'graph', mount: ({ body }) => { body.textContent = 'selectable content'; },
    });
    const overlay = document.querySelector('.graph-overlay');
    overlay.querySelector('.graph-overlay-canvas').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    // The browser's post-drag click targets the backdrop directly.
    overlay.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(document.body.contains(overlay)).toBe(true);
  });

  it('runs the teardown fn exactly once even when close() is called twice directly', () => {
    const teardown = vi.fn();
    let captured;
    openInDetachedTab({ document, openWindow: () => null, state: detachedState() }, {
      title: 'X', mode: 'graph', mount: ({ close }) => { captured = close; return teardown; },
    });
    captured();
    captured();
    expect(teardown).toHaveBeenCalledTimes(1);
  });

  it('the ✕ button closes the overlay; a repeat click on the same (now-detached) backdrop is a no-op', () => {
    const teardown = vi.fn();
    openInDetachedTab({ document, openWindow: () => null, state: detachedState() }, {
      title: 'X', mode: 'graph', mount: ({ bar, closeBtn }) => { bar.appendChild(closeBtn); return teardown; },
    });
    const overlay = document.querySelector('.graph-overlay');
    overlay.querySelector('.graph-overlay-close').dispatchEvent(new Event('click', { bubbles: true }));
    expect(document.body.contains(overlay)).toBe(false);
    overlay.dispatchEvent(new Event('click', { bubbles: true })); // detached — still reaches the same handler
    expect(teardown).toHaveBeenCalledTimes(1);
  });

  it('falls back to overlay when openWindow returns null, a windowless object, or throws (COOP)', () => {
    openInDetachedTab({ document, openWindow: () => null, state: detachedState() }, { title: 'X', mode: 'graph', mount: () => {} });
    expect(document.querySelector('.graph-overlay')).not.toBeNull();
    document.body.innerHTML = '';
    openInDetachedTab({ document, openWindow: () => ({ document: null }), state: detachedState() }, { title: 'X', mode: 'graph', mount: () => {} });
    expect(document.querySelector('.graph-overlay')).not.toBeNull();
    document.body.innerHTML = '';
    openInDetachedTab({ document, openWindow: () => ({ get document() { throw new Error('coop'); } }), state: detachedState() }, { title: 'X', mode: 'graph', mount: () => {} });
    expect(document.querySelector('.graph-overlay')).not.toBeNull();
  });

  it('works with no app at all: uses the global document, skips detachedView tracking, no throw', () => {
    expect(() => openInDetachedTab(null, { title: 'X', mode: 'graph', mount: () => {} })).not.toThrow();
    expect(document.querySelector('.graph-overlay')).not.toBeNull();
  });

  it('works with an app that has no state (detachedView tracking silently skipped)', () => {
    expect(() => openInDetachedTab({ document, openWindow: () => null }, { title: 'X', mode: 'graph', mount: () => {} }))
      .not.toThrow();
    expect(document.querySelector('.graph-overlay')).not.toBeNull();
  });

  it('picks the grid body class for mode:"grid" in the overlay too', () => {
    openInDetachedTab({ document, openWindow: () => null, state: detachedState() }, { title: 'X', mode: 'grid', mount: () => {} });
    expect(document.querySelector('.data-pane-body')).not.toBeNull();
    expect(document.querySelector('.graph-overlay-canvas')).toBeNull();
  });
});
