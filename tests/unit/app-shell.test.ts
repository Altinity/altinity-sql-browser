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
