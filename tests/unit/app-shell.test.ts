import { describe, expect, it, vi } from 'vitest';
import { mountAppShell } from '../../src/ui/app-shell.js';
import { startDrag } from '../../src/ui/splitters.js';
import { showInInspector, releaseInspector } from '../../src/ui/inspector-host.js';
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

  // #586 finding 2a: the initial width is now DOCK-AWARE, not just clamped to
  // [320, 92vw] — under happy-dom `window.innerWidth` is 1024 and `makeApp`'s
  // default `sidebarPx` is 248, so `reservedPx` = 248 + 2*7 (HANDLE_PX) = 262
  // and the ceiling is `min(1024*0.92=942.08, 1024-262-320=442)` = 442. Both
  // the default preference (480) and a deliberately oversized one (5000)
  // exceed that ceiling, so BOTH clamp to the same 442 — proof the dock-aware
  // bound (not 92vw) is the one actually applied.
  it('sets the initial width from the persisted rightInspectorPx pref, dock-aware clamped (window.innerWidth = 1024, sidebarPx = 248 under happy-dom)', () => {
    const { app, handle } = mount();
    expect(app.state.rightInspectorPx).toBe(480); // the raw preference is untouched...
    expect(app.dom.inspectorHost!.style.width).toBe('442px'); // ...only the DISPLAYED width is clamped
    handle.dispose();

    const wide = makeApp({ catalog: { loadSchema: vi.fn(async () => {}), loadReference: vi.fn(async () => {}) } });
    wide.state.rightInspectorPx = 5000;
    const wideHandle = mountAppShell({
      app: wide, root: wide.root, document, state: wide.state, catalog: wide.catalog,
      prefs: wide.prefs, matchMedia: null, updateBanner: vi.fn(), startDrag,
    });
    expect(wide.dom.inspectorHost!.style.width).toBe('442px');
    expect(wide.state.rightInspectorPx).toBe(5000); // still not mutated by the display clamp
    wideHandle.dispose();
  });

  it('dragging inspectorResize resizes inspectorHost live and persists rightInspectorPx on mouseup', () => {
    const { app, handle } = mount();
    const resize = app.dom.inspectorResize!;
    resize.dispatchEvent(new MouseEvent('mousedown', { clientX: 700, bubbles: true }));
    // 1024-650=374 — comfortably inside the dock-aware ceiling (442, see
    // above), so this exercises a plain unclamped drag.
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 650 }));
    expect(app.dom.inspectorHost!.style.width).toBe('374px');
    window.dispatchEvent(new MouseEvent('mouseup', {}));
    expect(app.state.rightInspectorPx).toBe(374);
    expect(app.prefs.save).toHaveBeenCalledWith('rightInspectorPx', 374);
    handle.dispose();
  });

  // #586 finding 2a: dragging the handle far enough left to claim (nearly)
  // the whole row must not starve `.query-host`/`.dashboard-host` — the
  // dock-aware ceiling (442, see above) binds well short of the old flat
  // 92vw cap (942.08px).
  it('dragging inspectorResize past the dock-aware ceiling clamps live, protecting the centre surface', () => {
    const { app, handle } = mount();
    const resize = app.dom.inspectorResize!;
    resize.dispatchEvent(new MouseEvent('mousedown', { clientX: 700, bubbles: true }));
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: -500 })); // 1024-(-500)=1524, way over
    expect(app.dom.inspectorHost!.style.width).toBe('442px');
    window.dispatchEvent(new MouseEvent('mouseup', {}));
    expect(app.state.rightInspectorPx).toBe(442);
    handle.dispose();
  });

  // #586 finding 1: `startDrag`'s returned cancel handle used to be discarded
  // (`doStartDrag(e, 'rightInspector', dragCtx)` with no assignment) — a
  // surface closing mid-drag left the `window` mousemove/mouseup listeners
  // live, so further movement kept mutating a now-hidden host and the
  // eventual mouseup persisted an abandoned width. `releaseInspector` is the
  // single choke point every real close path (Escape, sign-out, a surface
  // switch, a fresh occupant replacing this one) funnels through.
  describe('mid-drag cancellation on inspector fold (#586 finding 1)', () => {
    it('releaseInspector cancels a still-active drag: no further style/state mutation, no persisted width', () => {
      const { app, handle } = mount();
      showInInspector(app, document.createElement('div'), vi.fn());
      const startPx = app.state.rightInspectorPx; // 480 — the raw preference, pre-drag
      const resize = app.dom.inspectorResize!;
      resize.dispatchEvent(new MouseEvent('mousedown', { clientX: 700, bubbles: true }));
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 650 })); // mid-drag, no mouseup yet
      expect(app.state.rightInspectorPx).toBe(374); // actively dragging (see above)
      expect(resize.classList.contains('dragging')).toBe(true);

      // The surface closes while the mouse button is still down.
      releaseInspector(app);
      expect(app.state.rightInspectorPx).toBe(startPx); // reverted, not the abandoned drag value
      expect(resize.classList.contains('dragging')).toBe(false);
      const widthAfterCancel = app.dom.inspectorHost!.style.width;

      // A stray mousemove/mouseup after the cancel must not resurrect the
      // drag or persist anything.
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 100 }));
      window.dispatchEvent(new MouseEvent('mouseup', {}));
      expect(app.dom.inspectorHost!.style.width).toBe(widthAfterCancel);
      expect(app.state.rightInspectorPx).toBe(startPx);
      expect(app.prefs.save).not.toHaveBeenCalledWith('rightInspectorPx', expect.anything());
      handle.dispose();
    });

    it('a drag that ends normally (mouseup, no close in between) is unaffected by the cancellation wiring', () => {
      const { app, handle } = mount();
      const resize = app.dom.inspectorResize!;
      resize.dispatchEvent(new MouseEvent('mousedown', { clientX: 700, bubbles: true }));
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 650 }));
      window.dispatchEvent(new MouseEvent('mouseup', {}));
      expect(app.state.rightInspectorPx).toBe(374);
      expect(app.prefs.save).toHaveBeenCalledWith('rightInspectorPx', 374);
      // releaseInspector after a normal end-of-drag must not revert anything
      // — there is no active drag left to cancel.
      releaseInspector(app);
      expect(app.state.rightInspectorPx).toBe(374);
      handle.dispose();
    });

    it('handle.dispose() cancels a still-active drag too (a shell teardown, not just a fold)', () => {
      const { app, handle } = mount();
      const startPx = app.state.rightInspectorPx;
      const resize = app.dom.inspectorResize!;
      resize.dispatchEvent(new MouseEvent('mousedown', { clientX: 700, bubbles: true }));
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 650 }));
      expect(app.state.rightInspectorPx).toBe(374);

      handle.dispose();
      expect(app.state.rightInspectorPx).toBe(startPx);

      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 100 }));
      window.dispatchEvent(new MouseEvent('mouseup', {}));
      expect(app.state.rightInspectorPx).toBe(startPx);
      expect(app.prefs.save).not.toHaveBeenCalled();
    });
  });

  // #586 finding 2b: the persisted width used to be clamped ONLY once, at
  // shell construction — folding and re-opening (or a viewport change while
  // open) never re-applied it, so a stale width could outlive the layout it
  // was computed for.
  describe('re-clamp on unfold and viewport resize (#586 finding 2b)', () => {
    it('showInInspector reclamps against the CURRENT sidebarPx before revealing, not the stale mount-time value', () => {
      const { app, handle } = mount();
      expect(app.dom.inspectorHost!.style.width).toBe('442px'); // mount-time value (see above)
      releaseInspector(app); // fold it (starts folded anyway; harmless no-op-ish here)
      // Widen the sidebar AFTER mount, as if the user dragged it wider while
      // the inspector stayed folded.
      app.state.sidebarPx = 350;
      expect(showInInspector(app, document.createElement('div'), vi.fn())).toBe(true);
      // reserved = 350 + 14 = 364; ceiling = min(942.08, 1024-364-320=340) = 340
      expect(app.dom.inspectorHost!.style.width).toBe('340px');
      handle.dispose();
    });

    it('a live window resize re-clamps the OPEN inspector width without mutating the persisted preference', () => {
      const { app, handle } = mount();
      showInInspector(app, document.createElement('div'), vi.fn());
      expect(app.dom.inspectorHost!.style.width).toBe('442px');
      const preferenceBefore = app.state.rightInspectorPx;

      const vw = vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(700);
      try {
        window.dispatchEvent(new Event('resize'));
        // reserved unchanged (248+14=262); ceiling = min(700*0.92=644, 700-262-320=118)
        // — below the shared 320 floor, so clamp's floor wins.
        expect(app.dom.inspectorHost!.style.width).toBe('320px');
        expect(app.state.rightInspectorPx).toBe(preferenceBefore); // untouched
      } finally {
        vw.mockRestore();
      }
      handle.dispose();
    });

    it('a window resize while FOLDED does not throw, and the next unfold reflects the new viewport', () => {
      const { app, handle } = mount();
      expect(app.dom.inspectorHost!.hidden).toBe(true);
      const vw = vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(700);
      try {
        expect(() => window.dispatchEvent(new Event('resize'))).not.toThrow();
        showInInspector(app, document.createElement('div'), vi.fn());
        expect(app.dom.inspectorHost!.style.width).toBe('320px'); // per the ceiling computed above
      } finally {
        vw.mockRestore();
      }
      handle.dispose();
    });
  });
});
