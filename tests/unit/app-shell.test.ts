import { describe, expect, it, vi } from 'vitest';
import { mountAppShell } from '../../src/ui/app-shell.js';
import type { AppShellDeps } from '../../src/ui/app-shell.js';
import { startDrag } from '../../src/ui/splitters.js';
import { makeApp } from '../helpers/fake-app.js';
import { savedQuery } from '../helpers/saved-query.js';
import { LEFT_NAV_SECTIONS } from '../../src/core/left-nav-layout.js';
import type { LeftNavigationSection } from '../../src/core/left-nav-layout.js';

function mount(overrides: Partial<AppShellDeps> = {}) {
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
    ...overrides,
  });
  return { app, handle, loadSchema, loadReference, save };
}

/** Like `mount()`, but sets the left-navigation signals BEFORE mounting, so
 *  the shell's own mount-time paint (the preferred-state effect's first run)
 *  reflects them — the only way to exercise 'rail'/'drawer' presentation or
 *  an `isMobile`-from-the-start mount. */
function mountWithLeftNav(over: {
  mode?: 'wide' | 'rail'; section?: LeftNavigationSection | null; isMobile?: boolean;
} = {}, overrides: Partial<AppShellDeps> = {}) {
  const loadSchema = vi.fn(async () => {});
  const loadReference = vi.fn(async () => {});
  const app = makeApp({ catalog: { loadSchema, loadReference }, prefs: { save: vi.fn() } });
  if (over.mode !== undefined) app.state.leftNavMode.value = over.mode;
  if (over.section !== undefined) app.state.leftNavSection.value = over.section;
  if (over.isMobile !== undefined) app.state.isMobile.value = over.isMobile;
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
    ...overrides,
  });
  return { app, handle };
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
  it('the sidebar is the only container HOSTING a section — the rail is a re-presentation, not a second container', () => {
    const { app, handle } = mount();
    const sidebar = app.root.querySelector('.sidebar')!;

    expect(app.root.querySelectorAll('.sidebar')).toHaveLength(1);
    // Stated positively, so it is falsifiable TODAY rather than an assertion about
    // class names no code emits yet: every section host lives inside the one
    // sidebar, and the `.main-row` holds the rail, the sidebar, its width handle
    // and the two work-surface hosts. #487 phase 3 adds the rail as `.main-row`'s
    // FIRST child (never a second section-hosting container — see
    // `## Tests` → "left navigation presentation" below for the rail/drawer
    // presentation itself) — a host moving OUT of the sidebar, or a second
    // navigation column, has to fail this.
    const hosts = [...app.root.querySelectorAll('.nav-section-host')];
    expect(hosts).toHaveLength(4);
    expect(hosts.every((host) => sidebar.contains(host))).toBe(true);
    expect([...app.root.querySelector('.main-row')!.children].map((el) => el.className))
      .toEqual(['left-rail', 'sidebar', 'col-resize', 'query-host', 'dashboard-host']);
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

// #487 phase 3 — the composition step that makes the rail + focused drawer
// reachable: `.sidebar` is RE-PRESENTED (never moved/rebuilt) via
// `data-nav-mode`, and `applyEffectiveLeftNavigationLayout` is the sole writer
// of every attribute/hidden toggle the table in the phase's own spec names.
describe('mountAppShell left navigation presentation (#487 phase 3)', () => {
  it('wide mode: rail hidden, sidebar visible, every wide-only control visible', () => {
    const { app, handle } = mountWithLeftNav({ mode: 'wide' });
    const mainRow = app.root.querySelector('.main-row') as HTMLElement;
    const sidebar = app.root.querySelector('.sidebar') as HTMLElement;
    const rail = app.root.querySelector('.left-rail') as HTMLElement;

    expect(mainRow.dataset.navMode).toBe('wide');
    expect(sidebar.dataset.navMode).toBe('wide');
    expect(rail.hidden).toBe(true);
    expect(sidebar.hidden).toBe(false);
    expect(app.dom.upperRoleTabs!.hidden).toBe(false);
    expect(app.dom.savedTabsRow!.hidden).toBe(false);
    expect(app.dom.sideSplit!.hidden).toBe(false);
    expect((app.root.querySelector('.schema-pane') as HTMLElement).hidden).toBe(false);
    expect((app.root.querySelector('.saved-pane') as HTMLElement).hidden).toBe(false);
    expect(app.dom.leftNavTitle!.hidden).toBe(true);
    expect(sidebar.hasAttribute('aria-labelledby')).toBe(false);
    handle.dispose();
  });

  it('rail mode (no focused section): rail visible, sidebar and every wide-only control hidden', () => {
    const { app, handle } = mountWithLeftNav({ mode: 'rail', section: null });
    const mainRow = app.root.querySelector('.main-row') as HTMLElement;
    const sidebar = app.root.querySelector('.sidebar') as HTMLElement;
    const rail = app.root.querySelector('.left-rail') as HTMLElement;

    expect(mainRow.dataset.navMode).toBe('rail');
    expect(sidebar.dataset.navMode).toBe('rail');
    expect(rail.hidden).toBe(false);
    expect(sidebar.hidden).toBe(true);
    expect(app.dom.upperRoleTabs!.hidden).toBe(true);
    expect(app.dom.savedTabsRow!.hidden).toBe(true);
    expect(app.dom.sideSplit!.hidden).toBe(true);
    handle.dispose();
  });

  it('drawer mode, upper section focused: rail + sidebar visible, upper pane shown, lower pane + wide-only chrome hidden, title names the section', () => {
    const { app, handle } = mountWithLeftNav({ mode: 'rail', section: 'dashboards' });
    const mainRow = app.root.querySelector('.main-row') as HTMLElement;
    const sidebar = app.root.querySelector('.sidebar') as HTMLElement;
    const rail = app.root.querySelector('.left-rail') as HTMLElement;
    const schemaPane = app.root.querySelector('.schema-pane') as HTMLElement;
    const savedPane = app.root.querySelector('.saved-pane') as HTMLElement;

    expect(mainRow.dataset.navMode).toBe('drawer');
    expect(sidebar.dataset.navMode).toBe('drawer');
    expect(rail.hidden).toBe(false);
    expect(sidebar.hidden).toBe(false);
    expect(schemaPane.hidden).toBe(false);
    expect(savedPane.hidden).toBe(true);
    expect(app.dom.upperRoleTabs!.hidden).toBe(true);
    expect(app.dom.savedTabsRow!.hidden).toBe(true);
    expect(app.dom.sideSplit!.hidden).toBe(true);
    expect(app.dom.leftNavTitle!.hidden).toBe(false);
    expect(app.dom.leftNavTitle!.textContent).toBe('Dashboards');
    expect(sidebar.getAttribute('aria-labelledby')).toBe(app.dom.leftNavTitle!.id);
    handle.dispose();
  });

  it('drawer mode, lower section focused: lower pane shown, upper pane hidden, title names the section', () => {
    const { app, handle } = mountWithLeftNav({ mode: 'rail', section: 'history' });
    const schemaPane = app.root.querySelector('.schema-pane') as HTMLElement;
    const savedPane = app.root.querySelector('.saved-pane') as HTMLElement;

    expect(schemaPane.hidden).toBe(true);
    expect(savedPane.hidden).toBe(false);
    expect(app.dom.leftNavTitle!.textContent).toBe('History');
    handle.dispose();
  });

  it('the rail\'s four launchers exist and every aria-controls matches the real sidebar id', () => {
    const { app, handle } = mountWithLeftNav();
    const sidebar = app.root.querySelector('.sidebar') as HTMLElement;
    const buttons = [...app.root.querySelectorAll('.left-rail-btn')];

    expect(buttons).toHaveLength(4);
    expect(sidebar.id).toBeTruthy();
    for (const btn of buttons) expect(btn.getAttribute('aria-controls')).toBe(sidebar.id);
    handle.dispose();
  });

  it('mounting with state.isMobile.value = true from the start renders wide regardless of the stored leftNavMode', () => {
    const { app, handle } = mountWithLeftNav({ mode: 'rail', section: 'library', isMobile: true });
    const mainRow = app.root.querySelector('.main-row') as HTMLElement;
    const sidebar = app.root.querySelector('.sidebar') as HTMLElement;

    expect(mainRow.dataset.navMode).toBe('wide');
    expect(sidebar.dataset.navMode).toBe('wide');
    expect(sidebar.hidden).toBe(false);
    handle.dispose();
  });

  it('crossing the mobile breakpoint after mount forces the presentation back to wide', () => {
    const { app, handle } = mountWithLeftNav({ mode: 'rail', section: 'library', isMobile: false });
    const mainRow = app.root.querySelector('.main-row') as HTMLElement;

    expect(mainRow.dataset.navMode).toBe('drawer');
    app.state.isMobile.value = true;
    expect(mainRow.dataset.navMode).toBe('wide');
    handle.dispose();
  });

  it('a mode/section change re-runs the presentation function exactly once — not zero, not twice', () => {
    const { app, handle } = mountWithLeftNav({ mode: 'wide' });
    const title = app.dom.leftNavTitle!;
    // `leftNavTitle.hidden` is written by nothing in this module except the
    // presentation function's own unconditional assignment (a local closure
    // with no other exposed hook) — shadowing its accessor on the instance
    // turns "how many times did it run" into a directly countable,
    // falsifiable signal, the same "install something that counts runs"
    // technique `left-nav.test.ts`'s atomicity test uses for a batched write.
    let runs = 0;
    let hiddenValue = title.hidden;
    Object.defineProperty(title, 'hidden', {
      configurable: true,
      get: () => hiddenValue,
      set: (v: boolean) => { hiddenValue = v; runs++; },
    });

    app.state.leftNavMode.value = 'rail';

    expect(runs).toBe(1);
    handle.dispose();
  });

  it('dispose() stops the reactive effect, the rail and the separator — a later signal write no longer changes the DOM', () => {
    const { app, handle } = mountWithLeftNav({ mode: 'wide' });
    const mainRow = app.root.querySelector('.main-row') as HTMLElement;
    const rail = app.root.querySelector('.left-rail') as HTMLElement;

    handle.dispose();
    app.state.leftNavMode.value = 'rail';

    expect(mainRow.dataset.navMode).toBe('wide');
    expect(rail.hidden).toBe(true);
  });

  it('the separator repaints through the SAME presentation function during a drag (mode changes, DOM reflects it)', () => {
    const { app, handle } = mountWithLeftNav({ mode: 'wide' });
    const mainRow = app.root.querySelector('.main-row') as HTMLElement;
    const separator = app.root.querySelector('.col-resize') as HTMLElement;

    separator.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 50 })); // below the fold threshold
    window.dispatchEvent(new MouseEvent('mouseup', { clientX: 50 }));

    expect(app.state.leftNavMode.value).toBe('rail');
    expect(mainRow.dataset.navMode).toBe('rail');
    handle.dispose();
  });

  it('an injected observeElementWidth seam is called once with .main-row and its disposer is invoked on dispose()', () => {
    const observeElementWidth = vi.fn((_el: Element, _cb: (widthPx: number) => void) => vi.fn());
    const { handle } = mountWithLeftNav({ mode: 'wide' }, { observeElementWidth });

    expect(observeElementWidth).toHaveBeenCalledTimes(1);
    const [observedEl] = observeElementWidth.mock.calls[0];
    expect((observedEl as HTMLElement).className).toBe('main-row');
    const disposer = observeElementWidth.mock.results[0].value;
    expect(disposer).not.toHaveBeenCalled();

    handle.dispose();
    expect(disposer).toHaveBeenCalledTimes(1);
  });

  it('the observeElementWidth callback re-derives and re-applies the layout, and ignores a non-positive/non-finite width', () => {
    let capturedCallback: ((widthPx: number) => void) | null = null;
    const observeElementWidth = vi.fn((_el: Element, cb: (widthPx: number) => void) => {
      capturedCallback = cb;
      return vi.fn();
    });
    const { app, handle } = mountWithLeftNav({ mode: 'wide' }, { observeElementWidth });
    const mainRow = app.root.querySelector('.main-row') as HTMLElement;

    // A pre-mount mode write with no repaint trigger yet — the width observer
    // callback is what has to notice it, not a signal effect.
    app.state.leftNavMode.value = 'rail';
    expect(mainRow.dataset.navMode).toBe('rail'); // the preferred-state effect already caught this one…
    app.state.leftNavMode.value = 'wide';
    expect(mainRow.dataset.navMode).toBe('wide');

    // Defensive guards: neither call throws, and neither repaints from a
    // bogus measurement.
    expect(() => capturedCallback!(0)).not.toThrow();
    expect(() => capturedCallback!(-5)).not.toThrow();
    expect(() => capturedCallback!(NaN)).not.toThrow();
    expect(mainRow.dataset.navMode).toBe('wide');

    // A real, live width re-derives through the SAME pipeline — it does not
    // itself change the outcome here (no active drag, same preferred state),
    // but it must not throw and must actually invoke the presentation
    // function again.
    let runs = 0;
    const sidebar = app.root.querySelector('.sidebar') as HTMLElement;
    let widthValue = sidebar.style.width;
    Object.defineProperty(sidebar.style, 'width', {
      configurable: true,
      get: () => widthValue,
      set: (v: string) => { widthValue = v; runs++; },
    });
    capturedCallback!(900);
    expect(runs).toBe(1);
    handle.dispose();
  });
});

// ChatGPT second-review bug fix #2: the separator's own aria-valuenow/
// aria-valuemax/aria-valuetext must reflect the CURRENT layout even when
// something OTHER than the separator's own gesture repaints the sidebar —
// the separator's own internal ARIA effect only re-runs on a
// `leftNavMode`/`leftNavSection` signal change, never on a width-only
// change, so nothing else would tell it its own advertised width just
// went stale.
describe('mountAppShell left navigation presentation — separator ARIA staleness (#487 phase-3 review, bug 2)', () => {
  it('reflects the viewport-clamped width after the mount-time paint, not the pre-attach measurement, and stays correct after an observer-driven re-derivation', () => {
    // `mainRowWidthPx` only applies once `.main-row` is actually attached to
    // the document — mirroring the real bug: `mountLeftNavSeparator`'s own
    // internal ARIA effect runs at construction time, BEFORE `.main-row` is
    // attached (`root!.replaceChildren(...)` runs after), so its first
    // measurement sees a zero/unattached width and lands on a DIFFERENT
    // (unconstrained) value than the real, attached budget the
    // preferred-state effect derives moments later.
    let mainRowWidthPx = 800; // once "attached": budget = 800 - 7 (separator) - 480 (centre min) = 313
    // The fake-app helper's `root` is a detached `<div>` (never appended to
    // `document.body`), so happy-dom's own `isConnected` cannot stand in for
    // "measured before vs. after `.main-row` is attached" here. A call
    // counter models the same real sequence directly: the FIRST measurement
    // of `.main-row` is `mountLeftNavSeparator`'s own construction-time
    // effect, which genuinely runs before `root!.replaceChildren(...)`
    // attaches `.main-row` under `root` in the real module — so it reports 0,
    // exactly like a real unattached element would. Every later measurement
    // is the preferred-state effect (and, later, the observer), both of
    // which run after attachment, so they report the real width.
    let mainRowCallCount = 0;
    const rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function (this: HTMLElement) {
        if (!this.classList.contains('main-row')) {
          return { width: 0, top: 0, bottom: 0, left: 0, right: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
        }
        mainRowCallCount++;
        const width = mainRowCallCount === 1 ? 0 : mainRowWidthPx;
        return { width, top: 0, bottom: 0, left: 0, right: width, height: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
      });
    let capturedCallback: ((widthPx: number) => void) | null = null;
    const observeElementWidth = vi.fn((_el: Element, cb: (widthPx: number) => void) => {
      capturedCallback = cb;
      return vi.fn();
    });

    const loadSchema = vi.fn(async () => {});
    const loadReference = vi.fn(async () => {});
    const app = makeApp({ catalog: { loadSchema, loadReference }, prefs: { save: vi.fn() } });
    app.state.leftNavMode.value = 'wide';
    // Larger than the 313px the (attached) viewport currently allows —
    // exactly the "preferred wide width larger than getMaxNavigationTotalPx
    // would allow" case.
    app.state.sidebarPx = 420;
    const handle = mountAppShell({
      app, root: app.root, document, state: app.state, catalog: app.catalog,
      prefs: app.prefs, matchMedia: null, updateBanner: vi.fn(), startDrag, observeElementWidth,
    });

    const separator = app.root.querySelector('.col-resize') as HTMLElement;
    const sidebar = app.root.querySelector('.sidebar') as HTMLElement;
    // The rendered width is correctly clamped by the mount-time paint...
    expect(sidebar.style.width).toBe('313px');
    // ...and, with the fix, the separator's OWN ARIA agrees with it — not
    // the pre-attach (unconstrained, 420) measurement its own internal
    // effect happened to run with first.
    expect(separator.getAttribute('aria-valuenow')).toBe('313');
    expect(separator.getAttribute('aria-valuemax')).toBe('313');

    // The viewport grows enough to render the full 420px preference — the
    // width observer notices and re-derives.
    mainRowWidthPx = 1000; // budget = 1000 - 7 - 480 = 513, capped to LEFT_PANEL_MAX_PX (420)
    capturedCallback!(1000);

    expect(sidebar.style.width).toBe('420px');
    expect(separator.getAttribute('aria-valuenow')).toBe('420');
    expect(separator.getAttribute('aria-valuemax')).toBe('420');

    handle.dispose();
    rectSpy.mockRestore();
  });
});

// ChatGPT second-review bug fix #3: an active drag/keyboard session on the
// separator is authoritative — the `ResizeObserver`-driven callback must not
// repaint from the last COMMITTED preference while a gesture is still in
// progress (that preference is stale for as long as the gesture has not yet
// committed).
describe('mountAppShell left navigation presentation — observer vs. an active session (#487 phase-3 review, bug 3)', () => {
  it('does not repaint from the observer while a drag is active, but repaints normally once the drag ends', () => {
    let capturedCallback: ((widthPx: number) => void) | null = null;
    const observeElementWidth = vi.fn((_el: Element, cb: (widthPx: number) => void) => {
      capturedCallback = cb;
      return vi.fn();
    });
    const { app, handle } = mountWithLeftNav({ mode: 'wide' }, { observeElementWidth });
    const mainRow = app.root.querySelector('.main-row') as HTMLElement;
    const separator = app.root.querySelector('.col-resize') as HTMLElement;

    separator.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 248 }));
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 300 }));
    expect(mainRow.dataset.navMode).toBe('wide');
    const sidebarWidthDuringDrag = (app.root.querySelector('.sidebar') as HTMLElement).style.width;
    expect(sidebarWidthDuringDrag).toBe('300px'); // the drag's own last painted value

    // The observer fires mid-drag (e.g. a window resize while the mouse
    // button is still down) — it must NOT repaint from the stale committed
    // state (which would visibly snap the sidebar away from the pointer).
    capturedCallback!(900);
    expect((app.root.querySelector('.sidebar') as HTMLElement).style.width).toBe('300px');

    // Release the drag — the session ends and commits normally.
    window.dispatchEvent(new MouseEvent('mouseup', { clientX: 300 }));
    expect(app.state.leftNavMode.value).toBe('wide');
    expect(app.state.sidebarPx).toBe(300);

    // A SUBSEQUENT observer callback repaints normally again (no active
    // session left to protect).
    let runs = 0;
    const sidebar = app.root.querySelector('.sidebar') as HTMLElement;
    let widthValue = sidebar.style.width;
    Object.defineProperty(sidebar.style, 'width', {
      configurable: true,
      get: () => widthValue,
      set: (v: string) => { widthValue = v; runs++; },
    });
    capturedCallback!(900);
    expect(runs).toBe(1);

    handle.dispose();
  });
});

// #487 phase 3 step 4 — Escape closes a focused drawer and returns focus to
// the rail launcher that opened it. `saved-history.ts`'s search-box Escape
// handler (Part 1's fix) and the saved-row edit form's own Escape-to-cancel
// handlers are the ones expected to claim the key first (`defaultPrevented`);
// this handler must never act on top of one of those.
describe('mountAppShell — Escape closes the focused drawer (#487 phase 3 step 4)', () => {
  it('Escape on a descendant of .sidebar closes the drawer, consumes the key, and returns focus to the rail launcher', () => {
    const { app, handle } = mountWithLeftNav({ mode: 'rail', section: 'library' });
    document.body.appendChild(app.root); // .focus() is a no-op on a detached element
    const sidebar = app.root.querySelector('.sidebar') as HTMLElement;
    const rail = app.root.querySelector('.left-rail') as HTMLElement;
    const libraryBtn = [...rail.querySelectorAll<HTMLButtonElement>('.left-rail-btn')][LEFT_NAV_SECTIONS.indexOf('library')];
    // Dispatched on a DESCENDANT, never `sidebar` itself — proves the handler
    // relies on bubbling rather than requiring the event to land exactly on it.
    const target = app.dom.savedList!;
    expect(sidebar.contains(target)).toBe(true);

    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    target.dispatchEvent(event);

    expect(app.state.leftNavSection.value).toBeNull();
    expect(sidebar.dataset.navMode).toBe('rail');
    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(libraryBtn);

    app.root.remove();
    handle.dispose();
  });

  it('ignores a non-Escape key entirely', () => {
    const { app, handle } = mountWithLeftNav({ mode: 'rail', section: 'library' });
    const sidebar = app.root.querySelector('.sidebar') as HTMLElement;

    const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    sidebar.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(app.state.leftNavSection.value).toBe('library');
    handle.dispose();
  });

  it('does nothing when not in drawer mode — wide', () => {
    const { app, handle } = mountWithLeftNav({ mode: 'wide' });
    const sidebar = app.root.querySelector('.sidebar') as HTMLElement;

    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    sidebar.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(app.state.leftNavMode.value).toBe('wide');
    handle.dispose();
  });

  it('does nothing when not in drawer mode — bare rail (no focused section)', () => {
    const { app, handle } = mountWithLeftNav({ mode: 'rail', section: null });
    const sidebar = app.root.querySelector('.sidebar') as HTMLElement;

    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    sidebar.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(app.state.leftNavSection.value).toBeNull();
    expect(sidebar.dataset.navMode).toBe('rail');
    handle.dispose();
  });

  // The regression Part 1's fix makes reachable at all: a NON-empty search
  // filter still legitimately claims Escape for itself, and this handler must
  // respect that claim rather than also closing the drawer on the same key.
  it('respects a nested handler that already claimed Escape (a non-empty search filter) — the drawer stays open', () => {
    const loadSchema = vi.fn(async () => {});
    const loadReference = vi.fn(async () => {});
    const app = makeApp({ catalog: { loadSchema, loadReference }, prefs: { save: vi.fn() } });
    app.state.savedQueries = [savedQuery({ id: 's1', name: 'Q1', sql: 'SELECT 1' })];
    app.state.leftNavMode.value = 'rail';
    app.state.leftNavSection.value = 'library';
    const handle = mountAppShell({
      app, root: app.root, document, state: app.state, catalog: app.catalog,
      prefs: app.prefs, matchMedia: null, updateBanner: vi.fn(), startDrag,
    });
    const sidebar = app.root.querySelector('.sidebar') as HTMLElement;
    const input = app.dom.savedSearch!.querySelector<HTMLInputElement>('.sv-search-input')!;
    expect(input).not.toBeNull();
    input.value = 'zzzz';
    input.dispatchEvent(new Event('input', { bubbles: true })); // commit a genuinely non-empty filter

    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    input.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true); // the search box's own handler claimed it
    expect(app.state.leftNavSection.value).toBe('library'); // the drawer's own handler did NOT also act
    expect(sidebar.dataset.navMode).toBe('drawer');
    handle.dispose();
  });

  // The `section === null` guard is defensive against the mode/section
  // coherence invariant (`core/left-nav-layout.ts`) ever being violated — which
  // no normal interaction can reach, since every write to `leftNavMode`/
  // `leftNavSection` goes through the reducers that maintain it. Forcing the
  // violation by hand (clear the section, then hand-restore the now-stale
  // 'drawer' dataset the reactive effect just corrected) is the only way to
  // exercise this line at all, and it proves the guard: with no section to
  // toggle, the handler does nothing rather than throwing or acting on `null`.
  it('the defensive section===null guard: a hand-forced coherence violation still does nothing (never throws)', () => {
    const { app, handle } = mountWithLeftNav({ mode: 'rail', section: 'library' });
    const sidebar = app.root.querySelector('.sidebar') as HTMLElement;
    app.state.leftNavSection.value = null; // the effect immediately flips navMode back to 'rail'...
    sidebar.dataset.navMode = 'drawer'; // ...so re-force it, simulating the invariant being violated.

    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    expect(() => sidebar.dispatchEvent(event)).not.toThrow();

    expect(event.defaultPrevented).toBe(false);
    handle.dispose();
  });
});

// #487 phase 3 step 4 — converting a focused drawer to the wide sidebar (a
// resize-separator drag past the wide threshold; `End`/bare-rail-`ArrowRight`
// go through the identical `applyEffectiveLayout` callback) restores focus to
// the section's own wide-mode tab. This is a SEPARATE trigger from Escape
// (Escape only ever converts drawer -> bare rail, never all the way to wide).
describe('mountAppShell — converting to wide restores focus to the section\'s wide-mode tab (#487 phase 3 step 4)', () => {
  it('a LOWER section (History): dragging the separator past the wide threshold focuses the History tab', () => {
    const { app, handle } = mountWithLeftNav({ mode: 'rail', section: 'history' });
    document.body.appendChild(app.root);
    const separator = app.root.querySelector('.col-resize') as HTMLElement;

    separator.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 400 })); // past the wide threshold
    window.dispatchEvent(new MouseEvent('mouseup', { clientX: 400 }));

    expect(app.state.leftNavMode.value).toBe('wide');
    const historyTab = app.dom.savedTabsRow!.querySelector('[data-section="history"]');
    expect(historyTab).not.toBeNull();
    expect(document.activeElement).toBe(historyTab);

    app.root.remove();
    handle.dispose();
  });

  it('an UPPER section (Dashboards): dragging the separator past the wide threshold focuses the Dashboards tab', () => {
    const { app, handle } = mountWithLeftNav({ mode: 'rail', section: 'dashboards' });
    document.body.appendChild(app.root);
    const separator = app.root.querySelector('.col-resize') as HTMLElement;

    separator.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 400 }));
    window.dispatchEvent(new MouseEvent('mouseup', { clientX: 400 }));

    expect(app.state.leftNavMode.value).toBe('wide');
    const dashboardsTab = app.dom.upperRoleTabs!.querySelector('[data-section="dashboards"]');
    expect(dashboardsTab).not.toBeNull();
    expect(document.activeElement).toBe(dashboardsTab);

    app.root.remove();
    handle.dispose();
  });

  it('the very first presentation call (initial mount) never moves focus — nothing was previously focused', () => {
    const focusSpy = vi.spyOn(HTMLElement.prototype, 'focus');
    const { handle } = mountWithLeftNav({ mode: 'wide' });

    expect(focusSpy).not.toHaveBeenCalled();

    handle.dispose();
    focusSpy.mockRestore();
  });
});
