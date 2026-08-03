import { describe, expect, it, vi } from 'vitest';
import { mountAppShell } from '../../src/ui/app-shell.js';
import { startDrag } from '../../src/ui/splitters.js';
import { makeApp } from '../helpers/fake-app.js';

function mount() {
  const loadSchema = vi.fn(async () => {});
  const loadReference = vi.fn(async () => {});
  const save = vi.fn();
  const app = makeApp({
    catalog: { loadSchema, loadReference },
    prefs: { save },
  });
  const handle = mountAppShell({
    app,
    root: app.root,
    document,
    state: app.state,
    catalog: app.catalog,
    prefs: app.prefs,
    matchMedia: null,
    updateBanner: vi.fn(),
    startDrag,
  });
  return { app, handle, loadSchema, loadReference };
}

describe('mountAppShell authentication host', () => {
  it('exposes one stable, hidden, labelled host immediately below the header', () => {
    const { app, handle, loadSchema, loadReference } = mount();
    const children = [...app.root.children];

    expect(children[0].classList.contains('app-header-slot')).toBe(true);
    expect(children[1]).toBe(handle.authHost);
    expect(app.dom.authHost).toBe(handle.authHost);
    expect(handle.authHost.className).toBe('auth-host');
    expect(handle.authHost.hidden).toBe(true);
    expect(handle.authHost.getAttribute('role')).toBe('region');
    expect(handle.authHost.getAttribute('aria-label')).toBe('Authentication required');
    expect(app.root.querySelectorAll('.auth-host')).toHaveLength(1);
    expect(loadSchema).toHaveBeenCalledTimes(1);
    expect(loadReference).toHaveBeenCalledTimes(1);

    handle.dispose();
  });

  it('keeps the authentication host mounted while headers and work surfaces switch', () => {
    const { app, handle } = mount();
    const host = handle.authHost;
    const controls = document.createElement('div');
    controls.className = 'login-inline';
    host.replaceChildren(controls);
    host.hidden = false;
    const header = document.createElement('header');

    handle.setHeader(header);
    handle.showHost('dashboard');
    expect(handle.authHost).toBe(host);
    expect(app.root.children[1]).toBe(host);
    expect(host.firstElementChild).toBe(controls);
    expect(host.hidden).toBe(false);
    expect(handle.queryHost.hidden).toBe(true);
    expect(handle.dashboardHost.hidden).toBe(false);

    handle.showHost('query');
    expect(app.root.children[1]).toBe(host);
    expect(host.firstElementChild).toBe(controls);
    expect(handle.queryHost.hidden).toBe(false);
    expect(handle.dashboardHost.hidden).toBe(true);

    handle.dispose();
    expect(app.root.children[1]).toBe(host);
    expect(host.firstElementChild).toBe(controls);
  });
});

// #586 — the docked right-inspector slot + its shared resize handle.
describe('mountAppShell docked right-inspector (#586)', () => {
  it('mounts inspectorHost + inspectorResize as mainRow siblings of queryHost/dashboardHost, folded by default', () => {
    const { app, handle } = mount();
    const mainRow = handle.queryHost.parentElement!;
    expect(mainRow.className).toBe('main-row');
    const kids = [...mainRow.children];
    expect(kids.indexOf(handle.queryHost)).toBeGreaterThanOrEqual(0);
    expect(kids.indexOf(handle.dashboardHost)).toBeGreaterThan(kids.indexOf(handle.queryHost));
    expect(kids.at(-1)).toBe(app.dom.inspectorHost);
    expect(kids.at(-2)).toBe(app.dom.inspectorResize);
    expect(app.dom.inspectorHost!.hidden).toBe(true);
    expect(app.dom.inspectorResize!.hidden).toBe(true);
    handle.dispose();
  });

  it('sets the initial width from the persisted rightInspectorPx pref, clamped to [320, 92vw] (window.innerWidth = 1024 under happy-dom)', () => {
    const { app, handle } = mount();
    expect(app.dom.inspectorHost!.style.width).toBe(app.state.rightInspectorPx + 'px');
    handle.dispose();

    const wide = makeApp({ catalog: { loadSchema: vi.fn(async () => {}), loadReference: vi.fn(async () => {}) } });
    wide.state.rightInspectorPx = 5000;
    const wideHandle = mountAppShell({
      app: wide, root: wide.root, document, state: wide.state, catalog: wide.catalog,
      prefs: wide.prefs, matchMedia: null, updateBanner: vi.fn(), startDrag,
    });
    expect(wide.dom.inspectorHost!.style.width).toBe(1024 * 0.92 + 'px');
    wideHandle.dispose();
  });

  it('dragging inspectorResize resizes inspectorHost live and persists rightInspectorPx on mouseup', () => {
    const { app, handle } = mount();
    const resize = app.dom.inspectorResize!;
    resize.dispatchEvent(new MouseEvent('mousedown', { clientX: 700, bubbles: true }));
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 500 })); // 1024-500
    expect(app.dom.inspectorHost!.style.width).toBe('524px');
    window.dispatchEvent(new MouseEvent('mouseup', {}));
    expect(app.state.rightInspectorPx).toBe(524);
    expect(app.prefs.save).toHaveBeenCalledWith('rightInspectorPx', 524);
    handle.dispose();
  });
});
