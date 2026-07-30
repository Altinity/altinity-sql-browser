import { describe, expect, it, vi } from 'vitest';
import { mountAppShell } from '../../src/ui/app-shell.js';
import { startDrag } from '../../src/ui/splitters.js';
import { makeApp } from '../helpers/fake-app.js';
import { savedQuery } from '../helpers/saved-query.js';

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

/** Every mounted section host, keyed by its `data-section`. */
const hosts = (root: ParentNode): Record<string, HTMLElement> => Object.fromEntries(
  [...root.querySelectorAll<HTMLElement>('.nav-section-host')].map((h) => [h.dataset.section!, h]),
);

// #487 phase 2 — `## Tests` → "Wide state" bullets 1-4. The wide sidebar is now
// composed out of the navigation section registry rather than out of hard-wired
// per-pane DOM, and this is the gate on "existing navigation behaviour is
// unchanged": the same two panes, the same switchers, the same splitters, and the
// rail that phase 3 introduces is not here yet.
describe('mountAppShell wide navigation (#487 phase 2)', () => {
  it('renders no rail — the sidebar is the only container hosting a section', () => {
    const { app, handle } = mount();
    const sidebar = app.root.querySelector('.sidebar')!;

    expect(app.root.querySelectorAll('.sidebar')).toHaveLength(1);
    // Stated positively, so it is falsifiable TODAY rather than an assertion about
    // class names no code emits yet: every section host lives inside the one
    // sidebar, and the `.main-row` holds only the sidebar, its width handle and the
    // two work-surface hosts. Phase 3 moving a host into a rail-side drawer — or
    // adding a second navigation column — has to fail this.
    const hosts = [...app.root.querySelectorAll('.nav-section-host')];
    expect(hosts).toHaveLength(4);
    expect(hosts.every((host) => sidebar.contains(host))).toBe(true);
    expect([...app.root.querySelector('.main-row')!.children].map((el) => el.className))
      .toEqual(['sidebar', 'col-resize', 'query-host', 'dashboard-host']);
    handle.dispose();
  });

  it('renders the upper and lower panes together, one exposed host each', () => {
    const { app, handle } = mount();
    const sidebar = app.root.querySelector('.sidebar')!;
    const panes = [...sidebar.querySelectorAll('.side-pane')].map((p) => p.className);

    expect(panes).toEqual(['side-pane schema-pane', 'side-pane saved-pane']);
    const host = hosts(sidebar);
    // Both panes are exposed at once — this is what makes a "one of four" exposure
    // rule wrong for the wide presentation and a per-pane rule right.
    expect(host.databases.hidden).toBe(false);
    expect(host.dashboards.hidden).toBe(true);
    expect(host.library.hidden).toBe(false);
    expect(host.history.hidden).toBe(true);
    handle.dispose();
  });

  it('keeps both switchers and both splitters', () => {
    const { app, handle } = mount();
    const sidebar = app.root.querySelector('.sidebar')!;

    // Upper role tabs (#426), lower Library/History tabs (#427 labels).
    expect(sidebar.querySelectorAll('.upper-role-tabs')).toHaveLength(1);
    expect([...sidebar.querySelectorAll('.side-tabs')]).toHaveLength(2);
    expect([...app.dom.savedTabsRow!.querySelectorAll('.side-tab')].map((t) => t.textContent))
      .toEqual(['Library', 'History']);
    // The horizontal upper/lower splitter and the vertical sidebar-width handle.
    expect(sidebar.querySelectorAll('.row-resize.side-split')).toHaveLength(1);
    expect(app.root.querySelectorAll('.col-resize')).toHaveLength(1);
    handle.dispose();
  });

  it('mounts EXACTLY ONE host per section, each holding that section\'s own elements', () => {
    const { app, handle } = mount();
    const host = hosts(app.root);

    expect(Object.keys(host).sort()).toEqual(['dashboards', 'databases', 'history', 'library']);
    expect(app.root.querySelectorAll('.nav-section-host')).toHaveLength(4);
    // The section's content is the live DOM other modules render into, reached
    // through `app.dom` exactly as before — the registry hosts it, it does not
    // copy or re-create it.
    expect(host.databases.contains(app.dom.schemaList!)).toBe(true);
    expect(host.dashboards.contains(app.dom.dashboardTreeList!)).toBe(true);
    expect(host.library.contains(app.dom.savedList!)).toBe(true);
    expect(host.history.contains(app.dom.historyList!)).toBe(true);
    // Each list belongs to exactly one host: no section renders into another's.
    expect(host.history.contains(app.dom.savedList!)).toBe(false);
    expect(host.library.contains(app.dom.historyList!)).toBe(false);
    handle.dispose();
  });

  it('switches the exposed lower host on sidePanel without rebuilding either', () => {
    // #487 phase 3: content repaint is decoupled from `sidePanel` entirely (the
    // Library-content effect keys only on `dashboardTreeRevision`, and History has
    // no reactive trigger of its own) — a plain sidePanel flip now repaints ONLY
    // the tab row (active class/count), never either section's own content, in
    // EITHER direction.
    const { app, handle } = mount();
    const host = hosts(app.root);
    const libraryList = app.dom.savedList!;
    const historyList = app.dom.historyList!;
    const libraryMarker = libraryList.appendChild(document.createElement('span'));
    const historyMarker = historyList.appendChild(document.createElement('span'));

    app.state.sidePanel.value = 'history';
    expect(host.library.hidden).toBe(true);
    expect(host.history.hidden).toBe(false);
    // A hidden host keeps its DOM, and switching TO it does not rebuild it either.
    expect(libraryList.contains(libraryMarker)).toBe(true);
    expect(historyList.contains(historyMarker)).toBe(true);

    app.state.sidePanel.value = 'saved';
    expect(host.library.hidden).toBe(false);
    expect(host.history.hidden).toBe(true);
    // The same element objects throughout — never rebuilt, only exposed or hidden.
    // That identity is what makes phase 3's mode change a MOVE of live DOM. Both
    // stay MOUNTED too: identity alone would also hold for a host that had been
    // detached from the shell and replaced by a look-alike.
    expect(app.dom.savedList).toBe(libraryList);
    expect(app.dom.historyList).toBe(historyList);
    expect(app.root.contains(libraryList)).toBe(true);
    expect(app.root.contains(historyList)).toBe(true);
    // Becoming active again STILL does not repaint either section — the
    // deliberate #487 phase 3 behavior change from "activating a pane clears and
    // rebuilds its search/list."
    expect(libraryList.contains(libraryMarker)).toBe(true);
    expect(historyList.contains(historyMarker)).toBe(true);
    handle.dispose();
  });

  // #487 phase 3: the search input node inside a section's host survives a plain
  // sidePanel flip — proof that switching never triggers a destructive rebuild of
  // either section's content (only the tab row/exposure react to it).
  it('preserves node identity of a section\'s search input across a sidePanel flip', () => {
    const { app, handle } = mount();
    app.state.savedQueries = [savedQuery({ id: 's1', name: 'Q1', sql: 'SELECT 1' })];
    app.state.dashboardTreeRevision.value++; // force one real Library content paint
    const libraryInput = app.dom.savedSearch!.querySelector('.sv-search-input');
    expect(libraryInput).not.toBeNull();

    app.state.sidePanel.value = 'history';
    app.state.sidePanel.value = 'saved';

    expect(app.dom.savedSearch!.querySelector('.sv-search-input')).toBe(libraryInput);
    handle.dispose();
  });

  it('a bare dashboardTreeRevision bump (no sidePanel change) still repaints Library', () => {
    const { app, handle } = mount();
    app.state.savedQueries = [savedQuery({ id: 's1', name: 'Q1', sql: 'SELECT 1' })];

    app.state.dashboardTreeRevision.value++;

    expect(app.dom.savedList!.querySelectorAll('.saved-row')).toHaveLength(1);
    handle.dispose();
  });

  it('a sidePanel change alone still repaints the tab row\'s active class', () => {
    const { app, handle } = mount();

    app.state.sidePanel.value = 'history';

    const tabs = [...app.dom.savedTabsRow!.querySelectorAll('.side-tab')];
    expect(tabs[0].classList.contains('active')).toBe(false);
    expect(tabs[1].classList.contains('active')).toBe(true);
    handle.dispose();
  });

  it('exposes and PAINTS the same lower section for an out-of-union sidePanel', () => {
    // The blank-pane invariant, tested against the real shell rather than the
    // renderer alone. `saved-history.test.ts` has a sibling case, but it calls
    // `renderSavedHistory` directly — so it pins only the renderer's half and would
    // still pass if this shell went back to resolving the value inline. Exposure and
    // content have to be asserted in the SAME mounted shell, because the bug is
    // precisely that the two halves can disagree: one host exposed, the other
    // painted, nothing visible.
    const { app, handle } = mount();
    const host = hosts(app.root);
    app.state.savedQueries = [savedQuery({ id: 's1', name: 'Q1', sql: 'SELECT 1' })];
    app.state.dashboardTreeRevision.value++; // force Library's own content effect to (re)paint

    (app.state.sidePanel as { value: string }).value = 'queries';

    expect(host.library.hidden).toBe(false);
    expect(host.history.hidden).toBe(true);
    expect(app.dom.savedList!.querySelectorAll('.saved-row')).toHaveLength(1);
    // #487 phase 3: History now ALSO always renders its own content — its host is
    // never truly blank, even when Library is exposed.
    expect(app.dom.historyList!.textContent).toContain('No history yet.');
    handle.dispose();
  });

  // #487 phase 3 regression test: the section that was NOT active at mount used
  // to never get its first paint at all (blank until the first switch to it).
  it('paints BOTH lower sections at mount, before either is ever switched to', () => {
    const loadSchema = vi.fn(async () => {});
    const loadReference = vi.fn(async () => {});
    const app = makeApp({ catalog: { loadSchema, loadReference }, prefs: { save: vi.fn() } });
    app.state.savedQueries = [savedQuery({ id: 's1', name: 'Q1', sql: 'SELECT 1' })];
    app.state.history = [{ id: 'h1', sql: 'SELECT 1', ts: Date.now(), rows: 1, ms: 1 }];
    // sidePanel defaults to Library ('saved') — History is never exposed here.
    const handle = mountAppShell({
      app, root: app.root, document, state: app.state, catalog: app.catalog,
      prefs: app.prefs, matchMedia: null, updateBanner: vi.fn(), startDrag,
    });

    expect(app.dom.historyList!.querySelectorAll('.history-row')).toHaveLength(1);
    handle.dispose();
  });

  it('switches the exposed upper host on upperRole', () => {
    const { app, handle } = mount();
    const host = hosts(app.root);

    app.state.upperRole.value = 'dashboards';
    expect(host.databases.hidden).toBe(true);
    expect(host.dashboards.hidden).toBe(false);

    app.state.upperRole.value = 'databases';
    expect(host.databases.hidden).toBe(false);
    expect(host.dashboards.hidden).toBe(true);
    handle.dispose();
  });
});

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
