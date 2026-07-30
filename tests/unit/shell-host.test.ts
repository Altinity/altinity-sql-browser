// #577 state S2 (Preact treatment) — this file re-expresses the deleted
// `app-shell.test.ts` (S1 control)'s SEAM/LIFECYCLE contracts against
// `ui/shell/shell-host.ts`'s `mountAppShell`, which keeps the exact same
// public `AppShellDeps`/`AppShellHandle` seam the vanilla arm exposed (so
// `ui/app.ts`'s one call site changes only its import path — the comparison
// this evaluation wants is about rendering, not re-plumbing the app).
//
// THE ONE BEHAVIOURAL DELTA FROM S0/S1, EVERYWHERE IN THIS FILE: a signal
// write no longer repaints synchronously — Preact schedules the tree diff on
// a microtask. Confirmed empirically against this exact module: a bare
// `setTimeout(resolve, 0)` after a signal write is sufficient for the DOM to
// catch up; nothing below needed more than one `await flush()` per write.
// The vanilla arm's suite asserted every one of these synchronously; that is
// exactly the delta this evaluation measures, so every test that follows a
// signal write with a DOM assertion awaits `flush()` first — never a
// weakened assertion, never a changed expected value.
import { describe, expect, it, vi } from 'vitest';
import { mountAppShell } from '../../src/ui/shell/shell-host.js';
import type { AppShellDeps } from '../../src/ui/shell/shell-host.js';
import { startDrag } from '../../src/ui/splitters.js';
import { makeApp } from '../helpers/fake-app.js';
import { savedQuery } from '../helpers/saved-query.js';
import { LEFT_NAV_SECTIONS } from '../../src/core/left-nav-layout.js';
import type { LeftNavigationSection } from '../../src/core/left-nav-layout.js';

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** Mirrors the deleted suite's own `mount()`. Also returns the fresh
 *  `loadSchema`/`loadReference`/`save` spies `makeApp` wires in, the same
 *  four values the old helper handed back — several tests below assert call
 *  counts/args on them directly. */
function mount(overrides: Partial<AppShellDeps> = {}) {
  const loadSchema = vi.fn(async () => {});
  const loadReference = vi.fn(async () => {});
  const save = vi.fn();
  const app = makeApp({ catalog: { loadSchema, loadReference }, prefs: { save } });
  const handle = mountAppShell({
    app, root: app.root, document, state: app.state, catalog: app.catalog,
    prefs: app.prefs, matchMedia: null, updateBanner: vi.fn(), startDrag,
    ...overrides,
  });
  return { app, handle, loadSchema, loadReference, save };
}

/** Mirrors the deleted suite's own `mountWithLeftNav()`: the left-navigation
 *  signals (and, optionally, seed data the mount-time renderer effects read
 *  synchronously) are set BEFORE `mountAppShell` runs, so the mount-time
 *  paint already reflects them without needing a post-mount flush. */
function mountWithLeftNav(over: {
  mode?: 'wide' | 'rail'; section?: LeftNavigationSection | null; isMobile?: boolean;
  /** Seeded before mount — `renderLibrarySection`'s own search box is gated
   *  on a non-empty Library list (#427), so a test needing `.sv-search-input`
   *  to exist must seed this BEFORE the mount-time effect's one synchronous
   *  run, not after (a plain `state.savedQueries` assignment is not a signal
   *  write, so nothing would repaint it later either). */
  savedQueries?: ReturnType<typeof savedQuery>[];
} = {}, overrides: Partial<AppShellDeps> = {}) {
  const loadSchema = vi.fn(async () => {});
  const loadReference = vi.fn(async () => {});
  const save = vi.fn();
  const app = makeApp({ catalog: { loadSchema, loadReference }, prefs: { save } });
  if (over.mode !== undefined) app.state.leftNavMode.value = over.mode;
  if (over.section !== undefined) app.state.leftNavSection.value = over.section;
  if (over.isMobile !== undefined) app.state.isMobile.value = over.isMobile;
  if (over.savedQueries !== undefined) app.state.savedQueries = over.savedQueries;
  const handle = mountAppShell({
    app, root: app.root, document, state: app.state, catalog: app.catalog,
    prefs: app.prefs, matchMedia: null, updateBanner: vi.fn(), startDrag,
    ...overrides,
  });
  return { app, handle, save };
}

describe('mountAppShell — the AppShellHandle contract', () => {
  it('setHeader() replaces the header slot\'s content', () => {
    const { app, handle } = mount();
    const header = document.createElement('header');

    handle.setHeader(header);

    const slot = app.root.querySelector('.app-header-slot')!;
    expect(slot.firstElementChild).toBe(header);
    // A second call REPLACES, not appends.
    const header2 = document.createElement('header');
    handle.setHeader(header2);
    expect(slot.children.length).toBe(1);
    expect(slot.firstElementChild).toBe(header2);
    handle.dispose();
  });

  it('authHost/queryHost/dashboardHost are real, already-attached elements BEFORE mountAppShell returns', () => {
    // `mountAppShell` renders synchronously (Preact's first `render()` call
    // is — `adopt.ts`'s own doc comment), which is the only reason the
    // handle can hand these straight back to `ui/app.ts`'s `ensureShell` for
    // immediate use on the very next line, with no "wait for mount" step.
    const { app, handle } = mount();

    expect(handle.authHost).toBeInstanceOf(HTMLElement);
    expect(handle.queryHost).toBeInstanceOf(HTMLElement);
    expect(handle.dashboardHost).toBeInstanceOf(HTMLElement);
    expect(handle.authHost.className).toBe('auth-host');
    expect(handle.queryHost.className).toBe('query-host');
    expect(handle.dashboardHost.className).toBe('dashboard-host');
    expect(app.root.contains(handle.authHost)).toBe(true);
    expect(app.root.contains(handle.queryHost)).toBe(true);
    expect(app.root.contains(handle.dashboardHost)).toBe(true);
    handle.dispose();
  });

  it('showHost(\'dashboard\') flips both hosts\' hidden and .main-row[data-surface] SYNCHRONOUSLY — no flush needed, unlike every other write in this file', () => {
    // `showHost` is the one call site `shell-host.ts`'s own `flushSync` helper
    // exists for: a caller reveals a host and immediately acts inside it
    // (`ui/app.ts`'s `showQuerySurface` focuses the SQL editor on the very
    // next line), which a microtask-deferred render would silently break —
    // exactly the bug `flushSync`'s own doc comment describes catching in a
    // real browser while the whole unit suite stayed green. Asserting with NO
    // `await flush()` here is the point: if this ever regresses to an
    // ordinary deferred write, this test starts failing instead of merely
    // becoming slower.
    const { app, handle } = mount();
    const mainRow = app.root.querySelector('.main-row') as HTMLElement;
    expect(handle.queryHost.hidden).toBe(false);
    expect(handle.dashboardHost.hidden).toBe(true);
    expect(mainRow.dataset.surface).toBe('query');

    handle.showHost('dashboard');

    expect(handle.queryHost.hidden).toBe(true);
    expect(handle.dashboardHost.hidden).toBe(false);
    expect(mainRow.dataset.surface).toBe('dashboard');

    handle.showHost('query');

    expect(handle.queryHost.hidden).toBe(false);
    expect(handle.dashboardHost.hidden).toBe(true);
    expect(mainRow.dataset.surface).toBe('query');
    handle.dispose();
  });

  it('showHost with the SAME kind it already shows is a genuine no-op — the signal write is skipped entirely (no render is even queued)', () => {
    // `flushSync`'s own `if (queued !== null) (queued as () => void)();`
    // guards against a call that queues nothing to flush. A repeated
    // `showHost('query')` is exactly that case: `surface.value = 'query'` is
    // not a real value change (Preact-signals' own setter no-ops when the
    // new value equals the old one — same rule shell-layout.test.ts's own
    // "layout and navMode are memoised" tests pin), so Preact never even asks
    // `options.debounceRendering` to queue a render, and `flushSync` has
    // nothing to flush.
    const { handle } = mount();

    expect(() => handle.showHost('query')).not.toThrow();

    handle.dispose();
  });
});

describe('mountAppShell — app.dom population (contract, not incidental)', () => {
  it('populates every field the shell owns on app.dom', () => {
    const { app, handle } = mount();

    expect(app.dom.schemaList).toBeInstanceOf(HTMLElement);
    expect(app.dom.savedTabsRow).toBeInstanceOf(HTMLElement);
    expect(app.dom.banner).toBeInstanceOf(HTMLElement);
    expect(app.dom.mobileBadge).toBeInstanceOf(HTMLElement);
    expect(app.dom.upperRoleTabs).toBeInstanceOf(HTMLElement);
    expect(app.dom.leftRail).toBeInstanceOf(HTMLElement);
    expect(app.dom.leftNavTitle).toBeInstanceOf(HTMLElement);
    expect(app.dom.leftNavSeparator).toBeInstanceOf(HTMLElement);
    expect(app.dom.leftNavStatus).toBeInstanceOf(HTMLElement);
    expect(app.dom.mobileNav).toBeInstanceOf(HTMLElement);
    expect(app.dom.mobileSegmented).toBeInstanceOf(HTMLElement);
    expect(app.dom.sideSplit).toBeInstanceOf(HTMLElement);
    expect(app.dom.authHost).toBeInstanceOf(HTMLElement);

    // Four of these have external readers in OTHER modules (contract, not
    // incidental) — pinned against the real rendered element, not merely
    // "is truthy", so a future refactor that hands back a DIFFERENT element
    // with the same class cannot slip through.
    expect(app.dom.leftRail).toBe(app.root.querySelector('.left-rail'));
    expect(app.dom.leftNavSeparator).toBe(app.root.querySelector('.col-resize'));
    expect(app.dom.sideSplit).toBe(app.root.querySelector('.row-resize.side-split'));
    expect(app.dom.authHost).toBe(handle.authHost);
    handle.dispose();
  });
});

describe('mountAppShell — catalog bootstrap', () => {
  it('calls loadSchema and loadReference exactly once at mount', () => {
    const { loadSchema, loadReference, handle } = mount();
    expect(loadSchema).toHaveBeenCalledTimes(1);
    expect(loadReference).toHaveBeenCalledTimes(1);
    handle.dispose();
  });
});

describe('mountAppShell — rail/mobile click wiring routes through the ShellContext seams', () => {
  it('a rail click TOGGLES the section (open, then close on a second activation of the same one)', async () => {
    const { app, handle } = mountWithLeftNav({ mode: 'rail', section: null });
    const libraryBtn = [...app.root.querySelectorAll<HTMLButtonElement>('.left-rail-btn')][LEFT_NAV_SECTIONS.indexOf('library')];

    libraryBtn.click();
    await flush();
    expect(app.state.leftNavSection.value).toBe('library');

    libraryBtn.click();
    await flush();
    expect(app.state.leftNavSection.value).toBeNull();
    handle.dispose();
  });

  it('a mobile-segmented click writes state.mobileTab — both segments', () => {
    const { app, handle } = mount();
    const schemaBtn = app.dom.mobileSegmented!.querySelector<HTMLButtonElement>('[data-seg="schema"]')!;
    const libraryBtn = app.dom.mobileSegmented!.querySelector<HTMLButtonElement>('[data-seg="library"]')!;

    libraryBtn.click();
    expect(app.state.mobileTab.value).toBe('library');

    schemaBtn.click();
    expect(app.state.mobileTab.value).toBe('schema');
    handle.dispose();
  });

  it('a mobile-nav click writes state.mobileView normally when NOT on the Dashboard surface', () => {
    const { app, handle } = mount();
    const resultsBtn = app.dom.mobileNav!.querySelector<HTMLButtonElement>('[data-view="results"]')!;

    resultsBtn.click();

    expect(app.state.mobileView.value).toBe('results');
    handle.dispose();
  });

  it('a mobile-nav click routes back to the query surface FIRST when the Dashboard is showing (#471 — the bar is a route out, not a panel switcher there)', () => {
    const loadSchema = vi.fn(async () => {});
    const loadReference = vi.fn(async () => {});
    // `app.showQuerySurface` is an inert no-op on the shared fake-app fixture
    // (it never actually mutates `app.mainSurface`), so this test overrides it
    // with a spy and asserts the CALL rather than a surface-kind side effect —
    // the property under test is ordering ("before the panel write"), not
    // `showQuerySurface`'s own behavior (that belongs to app.test.ts).
    const showQuerySurface = vi.fn();
    const app = makeApp({
      catalog: { loadSchema, loadReference },
      prefs: { save: vi.fn() },
      showQuerySurface,
      mainSurface: {
        kind: 'dashboard', dashboardId: 'd1', mode: 'view',
        currentMember: null, pendingFocus: null, pendingScrollTop: null,
      },
    });
    const handle = mountAppShell({
      app, root: app.root, document, state: app.state, catalog: app.catalog,
      prefs: app.prefs, matchMedia: null, updateBanner: vi.fn(), startDrag,
    });
    const resultsBtn = app.dom.mobileNav!.querySelector<HTMLButtonElement>('[data-view="results"]')!;

    resultsBtn.click();

    expect(showQuerySurface).toHaveBeenCalledTimes(1);
    expect(app.state.mobileView.value).toBe('results');
    handle.dispose();
  });
});

describe('mountAppShell — app.preemptActiveResize', () => {
  it('is a no-op when no session is active', () => {
    const { app, handle } = mountWithLeftNav({ mode: 'wide' });
    expect(() => app.preemptActiveResize!()).not.toThrow();
    handle.dispose();
  });

  it('cancels an active separator drag (never commits it) and repaints from the still-current committed state', async () => {
    const { app, handle } = mountWithLeftNav({ mode: 'wide' });
    document.body.appendChild(app.root);
    const separator = app.root.querySelector('.col-resize') as HTMLElement;
    const mainRow = app.root.querySelector('.main-row') as HTMLElement;

    // Grabbed at the wide sidebar's own current width (248) — a zero grip
    // offset — then dragged well below the fold threshold.
    separator.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 248 }));
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 50 }));
    await flush();
    expect(mainRow.dataset.navMode).toBe('rail'); // the drag's own uncommitted paint

    app.preemptActiveResize!();
    await flush();

    // Cancelled, not committed: nothing has been written to state.leftNavMode
    // yet, so the repaint falls back to whatever WAS committed — still 'wide'.
    expect(app.state.leftNavMode.value).toBe('wide');
    expect(mainRow.dataset.navMode).toBe('wide');

    // The abandoned drag's own trailing mouseup must not resurrect it — this
    // is the semantic-command-preempts-a-live-drag property #487's review
    // exists to guarantee, exercised here through the seam directly rather
    // than through a caller (`application/left-nav.ts`'s own Escape/rail
    // click paths, both already covered above and by left-nav.test.ts).
    window.dispatchEvent(new MouseEvent('mouseup', { clientX: 50 }));
    await flush();
    expect(app.state.leftNavMode.value).toBe('wide');
    expect(mainRow.dataset.navMode).toBe('wide');

    app.root.remove();
    handle.dispose();
  });
});

describe('mountAppShell — the injected observeElementWidth seam', () => {
  it('is called once with .main-row, and its disposer is invoked on dispose()', () => {
    const observeElementWidth = vi.fn((_el: Element, _cb: (widthPx: number) => void) => vi.fn());
    const { handle, app } = mountWithLeftNav({ mode: 'wide' }, { observeElementWidth });

    expect(observeElementWidth).toHaveBeenCalledTimes(1);
    const [observedEl] = observeElementWidth.mock.calls[0];
    expect((observedEl as HTMLElement).className).toBe('main-row');
    expect(observedEl).toBe(app.root.querySelector('.main-row'));
    const disposer = observeElementWidth.mock.results[0].value;
    expect(disposer).not.toHaveBeenCalled();

    handle.dispose();
    expect(disposer).toHaveBeenCalledTimes(1);
  });

  it('the callback INVALIDATES the derivation (bumpViewportEpoch) rather than carrying a value — the LIVE .main-row measurement is what actually clamps the rendered width', async () => {
    // `measureMaxNavigationTotalPx` (shell-host.ts) reads `.main-row`'s own
    // `getBoundingClientRect().width` fresh on every call — the callback's own
    // `widthPx` argument is used ONLY as a validity guard (a detached element
    // reporting 0/NaN must not even bother invalidating). This is a deliberate
    // divergence from an earlier draft that made the budget itself a signal
    // the observer wrote (this module's own header comment): that quietly
    // stayed `Infinity` whenever no observer was injected, where the vanilla
    // arm's live measurement did not. Mirrors the deleted suite's own
    // "separator ARIA staleness" test, which had to mock `getBoundingClientRect`
    // for the identical reason: happy-dom performs no real layout.
    let capturedCallback: ((widthPx: number) => void) | null = null;
    const observeElementWidth = vi.fn((_el: Element, cb: (widthPx: number) => void) => {
      capturedCallback = cb;
      return vi.fn();
    });
    const { app, handle } = mountWithLeftNav({ mode: 'wide' }, { observeElementWidth });
    const mainRow = app.root.querySelector('.main-row') as HTMLElement;
    const sidebar = app.root.querySelector('.sidebar') as HTMLElement;
    expect(sidebar.style.width).toBe('248px'); // unconstrained (a detached/unmeasured row reports 0 width)

    expect(() => capturedCallback!(0)).not.toThrow();
    expect(() => capturedCallback!(-5)).not.toThrow();
    expect(() => capturedCallback!(NaN)).not.toThrow();
    await flush();
    expect(sidebar.style.width).toBe('248px'); // untouched by any bogus measurement

    // budget = 600 - 7 (separator) - 480 (centre min) = 113, clamped to
    // LEFT_PANEL_MIN_PX (180) — well below the 248 default, so this provably
    // clamps rather than happening to equal the unclamped width.
    const rectSpy = vi.spyOn(mainRow, 'getBoundingClientRect').mockReturnValue({
      width: 600, height: 0, top: 0, bottom: 0, left: 0, right: 600, x: 0, y: 0, toJSON: () => ({}),
    });
    capturedCallback!(600); // the argument's own numeric value no longer matters, only its validity
    await flush();
    expect(sidebar.style.width).toBe('180px');

    rectSpy.mockRestore();
    handle.dispose();
  });

  it('omitting the seam does not throw, and the shell mounts and behaves normally', () => {
    expect(() => mount()).not.toThrow();
  });
});

describe('mountAppShell — matchMedia seam', () => {
  it('matchMedia: null does not throw, and the shell mounts normally', () => {
    expect(() => mount({ matchMedia: null })).not.toThrow();
  });

  it('a media query change flips state.isMobile', () => {
    let onChange: ((e: MediaQueryListEvent) => void) | null = null;
    const mq = {
      matches: false,
      addEventListener: vi.fn((_type: string, cb: (e: MediaQueryListEvent) => void) => { onChange = cb; }),
      removeEventListener: vi.fn(),
    };
    const matchMedia = vi.fn(() => mq as unknown as MediaQueryList);
    const { app, handle } = mount({ matchMedia });

    expect(app.state.isMobile.value).toBe(false); // mq.matches at mount time
    onChange!({ matches: true } as MediaQueryListEvent);
    expect(app.state.isMobile.value).toBe(true);

    handle.dispose();
    expect(mq.removeEventListener).toHaveBeenCalledWith('change', onChange);
  });
});

describe('mountAppShell — an isMobile crossing (#487 phase-3 review, bugs 1 and 2)', () => {
  it('bug 1: clears leftNavSection on a mobile round trip', async () => {
    const { app, handle } = mountWithLeftNav({ mode: 'rail', section: 'library', isMobile: false });
    expect(app.state.leftNavSection.value).toBe('library');

    app.state.isMobile.value = true;
    await flush();
    expect(app.state.leftNavSection.value).toBeNull();

    app.state.isMobile.value = false;
    await flush();
    // A return from mobile always shows a bare rail — never a stale drawer.
    expect(app.state.leftNavSection.value).toBeNull();
    const mainRow = app.root.querySelector('.main-row') as HTMLElement;
    expect(mainRow.dataset.navMode).toBe('rail');

    handle.dispose();
  });

  it('bug 2: cancels an active separator drag mid-gesture, so its trailing mouseup cannot repaint stale desktop chrome back over the forced mobile presentation', async () => {
    const { app, handle } = mountWithLeftNav({ mode: 'rail', section: 'library', isMobile: false });
    document.body.appendChild(app.root);
    const separator = app.root.querySelector('.col-resize') as HTMLElement;
    const mainRow = app.root.querySelector('.main-row') as HTMLElement;

    separator.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 0 }));
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 400 })); // crosses past the wide threshold
    await flush();
    expect(mainRow.dataset.navMode).toBe('wide');

    app.state.isMobile.value = true; // crosses mid-drag
    await flush();
    expect(mainRow.dataset.navMode).toBe('wide'); // forced wide either way, fix or no fix

    // Without the fix, the abandoned session's very next mousemove could
    // repaint a non-wide mode right back over the forced mobile presentation.
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 20 })); // well below the fold threshold
    await flush();
    expect(mainRow.dataset.navMode).toBe('wide');
    window.dispatchEvent(new MouseEvent('mouseup', { clientX: 20 }));
    await flush();
    expect(mainRow.dataset.navMode).toBe('wide');
    // No stray commit landed either — the session was cancelled, not committed.
    expect(app.state.leftNavMode.value).toBe('rail');

    app.root.remove();
    handle.dispose();
  });
});

describe('mountAppShell — Escape inside .sidebar closes a focused drawer (#487 phase 3 step 4)', () => {
  it('closes the drawer, consumes the key, and returns focus to the rail launcher that opened it', async () => {
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
    await flush();

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

  // The regression this handler exists to respect: a NON-empty search filter
  // legitimately claims Escape for itself (`saved-history.ts`'s own handler),
  // and this handler must not ALSO close the drawer on the same keystroke.
  it('respects a nested handler that already claimed Escape (a non-empty search filter) — the drawer stays open', () => {
    // `renderLibrarySection`'s own search box only renders when the Library
    // list is non-empty (#427) — seeded BEFORE mount, so the mount-time
    // effect's one synchronous run already builds `.sv-search-input`; setting
    // `state.savedQueries` (a plain field, not a signal) AFTER mount would
    // never repaint it at all.
    const { app, handle } = mountWithLeftNav({
      mode: 'rail', section: 'library',
      savedQueries: [savedQuery({ id: 's1', name: 'Q1', sql: 'SELECT 1' })],
    });
    const sidebar = app.root.querySelector('.sidebar') as HTMLElement;
    const input = app.dom.savedSearch!.querySelector<HTMLInputElement>('.sv-search-input')!;
    expect(input).not.toBeNull();
    input.value = 'zzzz';
    input.dispatchEvent(new Event('input', { bubbles: true })); // commit a genuinely non-empty filter

    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    input.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true); // the search box's own handler claimed it
    expect(app.state.leftNavSection.value).toBe('library'); // this handler did NOT also act
    expect(sidebar.dataset.navMode).toBe('drawer');
    handle.dispose();
  });

  // The `section === null` guard is defensive against the mode/section
  // coherence invariant ever being violated by hand — no normal interaction
  // can reach it, since `layoutModel.navMode` is ITSELF derived from
  // `layoutModel.layout.focusedSection` (`navModeFor` in shell-layout.ts), so
  // `navMode.peek() === 'drawer'` already guarantees a non-null section by
  // construction. Included for the same reason the vanilla arm's own
  // equivalent guard was: proof the handler does nothing (never throws)
  // rather than acting on `null`, should that invariant ever be violated.
  it('the defensive section===null guard never throws (exercised via a direct handler dispatch, since the real derivation makes it unreachable through state alone)', () => {
    const { app, handle } = mountWithLeftNav({ mode: 'rail', section: 'library' });
    const sidebar = app.root.querySelector('.sidebar') as HTMLElement;

    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    expect(() => sidebar.dispatchEvent(event)).not.toThrow();

    app.state.leftNavSection.value = null;
    const event2 = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    expect(() => sidebar.dispatchEvent(event2)).not.toThrow();
    handle.dispose();
  });
});

describe('mountAppShell — the schema search input writes state.schemaFilter', () => {
  it('typing into the built-once search box updates the filter signal', () => {
    const { app, handle } = mount();
    const input = app.dom.schemaSearchInput!;

    input.value = 'orders';
    input.dispatchEvent(new Event('input', { bubbles: true }));

    expect(app.state.schemaFilter.value).toBe('orders');
    handle.dispose();
  });
});

describe('mountAppShell — the resize separator\'s own gesture, committed normally (mouseup with no external cancellation)', () => {
  it('repaints through the SAME derived layout during the drag, then commits: state, prefs, and the deferred dragLayout/widthRevision handoff all land', async () => {
    // This is the one sequence that reaches BOTH `applyEffectiveLayout`'s
    // deferred `queueMicrotask` branch (never taken by the cancelled-session
    // tests above, since those end with `session` already null before their
    // own trailing mouseup) AND `mountLeftNavSeparator`'s own `prefs.save`
    // wrapper — a session that runs mousedown -> mousemove -> mouseup with
    // NOTHING else touching it in between.
    const { app, handle, save } = mountWithLeftNav({ mode: 'wide' });
    const mainRow = app.root.querySelector('.main-row') as HTMLElement;
    const separator = app.root.querySelector('.col-resize') as HTMLElement;

    // Grabbed at the wide sidebar's own current width (248) — a zero grip
    // offset — then dragged to 200: inside [140, 260] (the fold/wide
    // thresholds), so the mode stays 'wide' and only the width itself moves.
    separator.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 248 }));
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 200 }));
    await flush();
    expect(mainRow.dataset.navMode).toBe('wide');
    expect((app.root.querySelector('.sidebar') as HTMLElement).style.width).toBe('200px');

    window.dispatchEvent(new MouseEvent('mouseup', { clientX: 200 }));
    await flush();

    expect(app.state.leftNavMode.value).toBe('wide');
    expect(app.state.sidebarPx).toBe(200);
    expect(save).toHaveBeenCalledWith('leftNavMode', 'wide');
    expect(save).toHaveBeenCalledWith('sidebarPx', 200);
    // The committed derivation agrees with the drag's own final paint — the
    // deferred `dragLayout -> null` / `bumpWidthRevision()` handoff produced
    // no visible change.
    expect((app.root.querySelector('.sidebar') as HTMLElement).style.width).toBe('200px');

    handle.dispose();
  });
});

describe('mountAppShell — the sideRow splitter (schema/saved vertical split)', () => {
  it('a drag on .row-resize.side-split writes sideSplitPct and persists it', async () => {
    const { app, handle, save } = mount();
    document.body.appendChild(app.root);
    const sidebar = app.root.querySelector('.sidebar') as HTMLElement;
    const splitter = app.dom.sideSplit!;
    const schemaPane = app.root.querySelector('.schema-pane') as HTMLElement;
    // `dragCtx.rectFor` measures `.sidebar`'s OWN rect — happy-dom performs no
    // real layout, so a fixed top/bottom stands in for it (mirrors the
    // deleted suite's own separator-ARIA test, which mocks the same seam for
    // the same reason).
    const rectSpy = vi.spyOn(sidebar, 'getBoundingClientRect').mockReturnValue({
      top: 0, bottom: 400, left: 0, right: 0, width: 0, height: 400, x: 0, y: 0, toJSON: () => ({}),
    });

    splitter.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientY: 100 }));
    window.dispatchEvent(new MouseEvent('mousemove', { clientY: 200 })); // (200-0)/(400-0)*100 = 50%
    await flush();
    expect(schemaPane.style.height).toBe('50%');

    window.dispatchEvent(new MouseEvent('mouseup', { clientY: 200 }));
    await flush();
    expect(save).toHaveBeenCalledWith('sideSplitPct', 50);

    rectSpy.mockRestore();
    app.root.remove();
    handle.dispose();
  });
});

describe('mountAppShell — the right inspector\'s resize handle, committed normally', () => {
  it('persists the new width through app.prefs.save on a normal mouseup', () => {
    const { app, handle, save } = mount();
    document.body.appendChild(app.root);
    const resizeHandle = app.root.querySelector('.cd-resize-h') as HTMLElement;

    resizeHandle.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 900 }));
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 700 }));
    window.dispatchEvent(new MouseEvent('mouseup', {}));

    expect(save).toHaveBeenCalledWith('inspectorPx', expect.any(Number));
    app.root.remove();
    handle.dispose();
  });
});

// The rest of this file exercises `resolveDestination`/`wideRestoreTarget`
// through the REAL shell rather than in isolation (`focus-settlement.test.ts`
// already pins the pure capture/settle contract against a fake document) —
// each case here is a distinct branch of one of those two functions, proven
// by driving the actual gesture/state change that reaches it and checking
// where focus actually lands.
describe('mountAppShell — converting a focused drawer to WIDE restores focus to the section\'s own wide-mode tab (wideRestoreTarget)', () => {
  it('a LOWER section (History): dragging the separator past the wide threshold focuses the History tab', async () => {
    const { app, handle } = mountWithLeftNav({ mode: 'rail', section: 'history' });
    document.body.appendChild(app.root);
    const separator = app.root.querySelector('.col-resize') as HTMLElement;

    separator.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 400 })); // past LEFT_WIDE_THRESHOLD_PX (260)
    window.dispatchEvent(new MouseEvent('mouseup', { clientX: 400 }));
    await flush();

    expect(app.state.leftNavMode.value).toBe('wide');
    const historyTab = app.dom.savedTabsRow!.querySelector('[data-section="history"]');
    expect(historyTab).not.toBeNull();
    expect(document.activeElement).toBe(historyTab);

    app.root.remove();
    handle.dispose();
  });

  it('an UPPER section (Dashboards): dragging the separator past the wide threshold focuses the Dashboards tab', async () => {
    const { app, handle } = mountWithLeftNav({ mode: 'rail', section: 'dashboards' });
    document.body.appendChild(app.root);
    const separator = app.root.querySelector('.col-resize') as HTMLElement;

    separator.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 400 }));
    window.dispatchEvent(new MouseEvent('mouseup', { clientX: 400 }));
    await flush();

    expect(app.state.leftNavMode.value).toBe('wide');
    const dashboardsTab = app.dom.upperRoleTabs!.querySelector('[data-section="dashboards"]');
    expect(dashboardsTab).not.toBeNull();
    expect(document.activeElement).toBe(dashboardsTab);

    app.root.remove();
    handle.dispose();
  });
});

describe('mountAppShell — folding to bare rail restores focus (resolveDestination)', () => {
  // #577 evaluation finding, FOUND BY THIS SUITE AND SINCE FIXED — kept in full
  // because the diagnosis is the evidence, and because it is one of the sharpest
  // costs the treatment arm turned up.
  //
  // The bug: a POINTER-DRAG fold to bare rail rescued nothing. `navMode` reaches
  // its final 'rail' value DURING the live gesture (the resize reducers apply the
  // fold as soon as a proposal crosses `LEFT_FOLD_THRESHOLD_PX`, not at
  // `mouseup`), which is precisely the frame where the capture effect is
  // correctly gated OFF by `isSessionActive()`. By the time the session ended,
  // the commit produced a new layout object but the SAME `navMode` STRING — and
  // a `computed` notifies on VALUE change, not reference change — so the effect
  // keyed on `navMode` never re-ran with the guard open. Nothing was ever
  // captured, and `settle` no-opped on `captured === null` before
  // `resolveDestination` could run.
  //
  // The general lesson, which belongs in the report: DERIVED STATE HAS NO EDGE.
  // The vanilla arm rescues focus inside the paint function that every trigger
  // calls, so a gesture commit is simply another call. A `computed` only tells
  // you its value changed — it cannot tell you that a GESTURE ENDED, because
  // that is not a value at all. The commit had to be re-attached by hand, in
  // `applyEffectiveLayout`'s own commit branch (capture against the
  // pre-transition DOM, flush the render synchronously, then settle).
  //
  // These two cases were originally pinned as `it.fails` rather than deleted or
  // weakened, which is exactly why the fix was provable: they flipped red the
  // moment the defect was closed.
  it('a pointer drag-fold FROM AN OPEN DRAWER with focus stuck inside it moves focus to the rail launcher (prior section known)', async () => {
    const { app, handle } = mountWithLeftNav({ mode: 'rail', section: 'library' });
    document.body.appendChild(app.root);
    const separator = app.root.querySelector('.col-resize') as HTMLElement;
    const libraryBtn = [...app.root.querySelectorAll<HTMLButtonElement>('.left-rail-btn')][LEFT_NAV_SECTIONS.indexOf('library')];
    const insideDrawer = app.dom.savedList as HTMLElement;
    insideDrawer.tabIndex = -1; // focusable, for this test only
    insideDrawer.focus();
    expect(document.activeElement).toBe(insideDrawer);

    // Grabbed at the drawer's own current total (rail + the 240px default) —
    // a zero grip offset — then folded past LEFT_FOLD_THRESHOLD_PX (140).
    separator.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 288 }));
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 50 }));
    window.dispatchEvent(new MouseEvent('mouseup', { clientX: 50 }));
    await flush();

    const mainRow = app.root.querySelector('.main-row') as HTMLElement;
    expect(mainRow.dataset.navMode).toBe('rail'); // confirms the fold actually committed
    expect(document.activeElement).toBe(libraryBtn);

    app.root.remove();
    handle.dispose();
  });

  it('a pointer drag-fold FROM WIDE with the schema search focused moves focus to the Databases rail launcher via the captured element\'s own [data-section] ancestor (no tracked prior section)', async () => {
    const { app, handle } = mountWithLeftNav({ mode: 'wide' });
    document.body.appendChild(app.root);
    const separator = app.root.querySelector('.col-resize') as HTMLElement;
    const databasesBtn = [...app.root.querySelectorAll<HTMLButtonElement>('.left-rail-btn')][LEFT_NAV_SECTIONS.indexOf('databases')];

    app.dom.schemaSearchInput!.focus();
    expect(document.activeElement).toBe(app.dom.schemaSearchInput);

    // Grabbed at the wide sidebar's own default total (248) — a zero grip offset.
    separator.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 248 }));
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 50 })); // well under the fold threshold
    window.dispatchEvent(new MouseEvent('mouseup', { clientX: 50 }));
    await flush();

    const mainRow = app.root.querySelector('.main-row') as HTMLElement;
    expect(mainRow.dataset.navMode).toBe('rail'); // wide -> rail in one step, no intermediate drawer
    expect(document.activeElement).toBe(databasesBtn);

    app.root.remove();
    handle.dispose();
  });

  // Unlike the two `it.fails` above, this one's assertion ("no rail button
  // ever gets focus") is honest but currently VACUOUS: given the defect
  // documented above, NO drag-fold-to-rail case rescues focus today, so this
  // passes regardless of whether the null-fallback guard itself is correct.
  // Kept because it becomes a real regression guard the moment the capture
  // defect above is fixed (at which point a naive fix might over-eagerly
  // focus a rail button here too).
  it('folding from WIDE with focus on the schema/saved splitter (no [data-section] ancestor) rescues nothing — the null fallback (currently vacuous; see the defect note above)', async () => {
    const { app, handle } = mountWithLeftNav({ mode: 'wide' });
    document.body.appendChild(app.root);
    const separator = app.root.querySelector('.col-resize') as HTMLElement;
    const railButtons = [...app.root.querySelectorAll<HTMLButtonElement>('.left-rail-btn')];
    const focusSpies = railButtons.map((btn) => vi.spyOn(btn, 'focus'));
    const splitter = app.dom.sideSplit as HTMLElement;
    splitter.tabIndex = -1;
    splitter.focus();
    expect(document.activeElement).toBe(splitter);

    separator.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 248 }));
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 50 }));
    window.dispatchEvent(new MouseEvent('mouseup', { clientX: 50 }));
    await flush();

    const mainRow = app.root.querySelector('.main-row') as HTMLElement;
    expect(mainRow.dataset.navMode).toBe('rail');
    expect(focusSpies.some((spy) => spy.mock.calls.length > 0)).toBe(false);

    app.root.remove();
    handle.dispose();
    focusSpies.forEach((spy) => spy.mockRestore());
  });
});

// A KEYBOARD-driven fold takes a structurally DIFFERENT path than a pointer
// drag: `left-nav-separator.ts`'s own `onKeyDown` builds and commits its
// session ENTIRELY within one synchronous keydown handler, without EVER
// setting the module-level `session` the pointer path uses (its own comment
// says so explicitly) — so `isSessionActive()` never gates the capture
// effect at all for this path, and the ONE navMode-changing write really
// does carry a fresh value change straight through to the capture effect,
// unlike the pointer-drag case documented above. This is what makes it
// possible to legitimately reach `resolveDestination`'s two `navMode ===
// 'rail'` branches at all — proof that `resolveDestination`'s OWN logic is
// correct; the defect above is specific to the pointer-session capture
// timing, not to this function. The keydown is dispatched directly on the
// separator element regardless of the DOM's actual `document.activeElement`
// — `dispatchEvent` only requires a registered listener on the target, and
// the real trigger for this path (a Tab-focused separator) is exercised by
// `left-nav-separator.test.ts` already; what matters here is only that
// `onKeyDown` runs with `session` still null.
describe('mountAppShell — a KEYBOARD fold (Home) legitimately reaches resolveDestination\'s rail branches (contrast with the pointer-drag defect above)', () => {
  it('from an OPEN DRAWER with focus captured inside it: rescues focus via the tracked prior section (line "if (prior !== null) return railButton(prior);")', async () => {
    const { app, handle } = mountWithLeftNav({ mode: 'rail', section: 'library' });
    document.body.appendChild(app.root);
    const separator = app.root.querySelector('.col-resize') as HTMLElement;
    const libraryBtn = [...app.root.querySelectorAll<HTMLButtonElement>('.left-rail-btn')][LEFT_NAV_SECTIONS.indexOf('library')];
    const insideDrawer = app.dom.savedList as HTMLElement;
    insideDrawer.tabIndex = -1;
    insideDrawer.focus();
    expect(document.activeElement).toBe(insideDrawer);

    separator.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true }));
    await flush();

    const mainRow = app.root.querySelector('.main-row') as HTMLElement;
    expect(mainRow.dataset.navMode).toBe('rail');
    expect(document.activeElement).toBe(libraryBtn);

    app.root.remove();
    handle.dispose();
  });

  it('from WIDE with focus on the schema search (no tracked prior section): rescues focus via the captured element\'s own [data-section] ancestor', async () => {
    const { app, handle } = mountWithLeftNav({ mode: 'wide' });
    document.body.appendChild(app.root);
    const separator = app.root.querySelector('.col-resize') as HTMLElement;
    const databasesBtn = [...app.root.querySelectorAll<HTMLButtonElement>('.left-rail-btn')][LEFT_NAV_SECTIONS.indexOf('databases')];
    app.dom.schemaSearchInput!.focus();
    expect(document.activeElement).toBe(app.dom.schemaSearchInput);

    separator.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true }));
    await flush();

    const mainRow = app.root.querySelector('.main-row') as HTMLElement;
    expect(mainRow.dataset.navMode).toBe('rail');
    expect(document.activeElement).toBe(databasesBtn);

    app.root.remove();
    handle.dispose();
  });

  it('from WIDE with focus on the schema/saved splitter (no [data-section] ancestor at all): rescues nothing — a REAL (non-vacuous) null-fallback case', async () => {
    const { app, handle } = mountWithLeftNav({ mode: 'wide' });
    document.body.appendChild(app.root);
    const separator = app.root.querySelector('.col-resize') as HTMLElement;
    const railButtons = [...app.root.querySelectorAll<HTMLButtonElement>('.left-rail-btn')];
    const focusSpies = railButtons.map((btn) => vi.spyOn(btn, 'focus'));
    const splitter = app.dom.sideSplit as HTMLElement;
    splitter.tabIndex = -1;
    splitter.focus();
    expect(document.activeElement).toBe(splitter);

    separator.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true }));
    await flush();

    const mainRow = app.root.querySelector('.main-row') as HTMLElement;
    expect(mainRow.dataset.navMode).toBe('rail');
    expect(focusSpies.some((spy) => spy.mock.calls.length > 0)).toBe(false);
    // Focus was captured (it was inside `.sidebar`) but never settled anywhere
    // — the browser's own focus stays exactly where the fold left it (still
    // the splitter here, since happy-dom does not itself blur a hidden node).
    expect(document.activeElement).toBe(splitter);

    app.root.remove();
    handle.dispose();
    focusSpies.forEach((spy) => spy.mockRestore());
  });
});

describe('mountAppShell — entering mobile with an open drawer moves focus off the (CSS-)hidden sidebar', () => {
  it('mobileView "editor" (the default): moves a focused drawer control to the Editor bottom-nav button', async () => {
    const { app, handle } = mountWithLeftNav({ mode: 'rail', section: 'library', isMobile: false });
    document.body.appendChild(app.root);
    const editorBtn = app.dom.mobileNav!.querySelector('[data-view="editor"]') as HTMLElement;
    const insideDrawer = app.dom.savedList as HTMLElement;
    insideDrawer.tabIndex = -1;
    insideDrawer.focus();
    expect(document.activeElement).toBe(insideDrawer);

    app.state.isMobile.value = true;
    await flush();

    expect(document.activeElement).toBe(editorBtn);

    app.root.remove();
    handle.dispose();
  });

  it('mobileView "results": moves a focused drawer control to the Results bottom-nav button', async () => {
    const { app, handle } = mountWithLeftNav({ mode: 'rail', section: 'library', isMobile: false });
    document.body.appendChild(app.root);
    app.state.mobileView.value = 'results';
    const resultsBtn = app.dom.mobileNav!.querySelector('[data-view="results"]') as HTMLElement;
    const insideDrawer = app.dom.savedList as HTMLElement;
    insideDrawer.tabIndex = -1;
    insideDrawer.focus();

    app.state.isMobile.value = true;
    await flush();

    expect(document.activeElement).toBe(resultsBtn);

    app.root.remove();
    handle.dispose();
  });

  it('mobileView "tables": does NOT move focus — that view keeps the sidebar visible', async () => {
    const { app, handle } = mountWithLeftNav({ mode: 'rail', section: 'library', isMobile: false });
    document.body.appendChild(app.root);
    app.state.mobileView.value = 'tables';
    const insideDrawer = app.dom.savedList as HTMLElement;
    insideDrawer.tabIndex = -1;
    insideDrawer.focus();

    app.state.isMobile.value = true;
    await flush();

    expect(document.activeElement).toBe(insideDrawer);

    app.root.remove();
    handle.dispose();
  });
});

describe('mountAppShell — showHost("dashboard") on mobile rescues focus off the hidden sidebar', () => {
  it('moves a focused sidebar control to the Editor bottom-nav button', () => {
    const { app, handle } = mountWithLeftNav({ mode: 'rail', section: 'library', isMobile: true });
    document.body.appendChild(app.root);
    const editorBtn = app.dom.mobileNav!.querySelector('[data-view="editor"]') as HTMLElement;
    const insideDrawer = app.dom.savedList as HTMLElement;
    insideDrawer.tabIndex = -1;
    insideDrawer.focus();
    expect(document.activeElement).toBe(insideDrawer);

    handle.showHost('dashboard'); // synchronous (flushSync) — no await needed

    expect(document.activeElement).toBe(editorBtn);

    app.root.remove();
    handle.dispose();
  });

  it('reaches the DASHBOARD-specific branch (not the editor/results one) when mobileView is "tables"', () => {
    // `resolveDestination` checks "mobile Editor/Results" BEFORE "mobile
    // Dashboard" — mobileView defaults to 'editor', so the test above
    // actually exercises the FORMER branch (it returns the same Editor
    // button either way, which is why that test alone can't tell the two
    // branches apart). Forcing mobileView to 'tables' first rules the
    // editor/results branch out, so a rescue here can only be coming from
    // the Dashboard-specific branch.
    const { app, handle } = mountWithLeftNav({ mode: 'rail', section: 'library', isMobile: true });
    document.body.appendChild(app.root);
    app.state.mobileView.value = 'tables';
    const editorBtn = app.dom.mobileNav!.querySelector('[data-view="editor"]') as HTMLElement;
    const insideDrawer = app.dom.savedList as HTMLElement;
    insideDrawer.tabIndex = -1;
    insideDrawer.focus();
    expect(document.activeElement).toBe(insideDrawer);

    handle.showHost('dashboard');

    expect(document.activeElement).toBe(editorBtn);

    app.root.remove();
    handle.dispose();
  });

  it('does nothing at desktop widths — the sidebar genuinely stays beside the Dashboard there', () => {
    const { app, handle } = mountWithLeftNav({ mode: 'rail', section: 'library', isMobile: false });
    document.body.appendChild(app.root);
    const insideDrawer = app.dom.savedList as HTMLElement;
    insideDrawer.tabIndex = -1;
    insideDrawer.focus();

    handle.showHost('dashboard');

    expect(document.activeElement).toBe(insideDrawer);

    app.root.remove();
    handle.dispose();
  });
});

describe('mountAppShell — dispose()', () => {
  it('unmounts the whole Preact tree — the root is empty afterward', () => {
    const { app, handle } = mount();
    expect(app.root.childNodes.length).toBeGreaterThan(0);

    handle.dispose();

    expect(app.root.childNodes.length).toBe(0);
  });

  it('removes the matchMedia change listener', () => {
    const removeEventListener = vi.fn();
    const mq = { matches: false, addEventListener: vi.fn(), removeEventListener };
    const matchMedia = vi.fn(() => mq as unknown as MediaQueryList);
    const { handle } = mount({ matchMedia });

    handle.dispose();

    expect(removeEventListener).toHaveBeenCalledWith('change', expect.any(Function));
  });

  it('calls the injected width-observer\'s own disposer', () => {
    const disposeWidthObserver = vi.fn();
    const observeElementWidth = vi.fn(() => disposeWidthObserver);
    const { handle } = mount({ observeElementWidth });

    handle.dispose();

    expect(disposeWidthObserver).toHaveBeenCalledTimes(1);
  });

  it('disposes the resize separator — a later gesture on the (now-detached) handle no longer changes state', () => {
    const { app, handle } = mountWithLeftNav({ mode: 'wide' });
    const separator = app.root.querySelector('.col-resize') as HTMLElement;

    handle.dispose();
    separator.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 248 }));
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 50 }));
    window.dispatchEvent(new MouseEvent('mouseup', { clientX: 50 }));

    expect(app.state.leftNavMode.value).toBe('wide');
  });

  it('disposes the right inspector — cancels a live resize so its trailing mouseup never persists a width', () => {
    const { app, handle, save } = mount();
    document.body.appendChild(app.root);
    const resizeHandle = app.root.querySelector('.cd-resize-h') as HTMLElement;

    resizeHandle.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 900 }));
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 700 }));
    handle.dispose();
    save.mockClear();
    window.dispatchEvent(new MouseEvent('mouseup', {}));

    expect(save).not.toHaveBeenCalled();
    app.root.remove();
  });

  it('stops the reactive effects — a later signal write no longer changes app.dom-owned DOM', () => {
    const { app, handle } = mountWithLeftNav({ mode: 'wide' });
    const savedTabsRow = app.dom.savedTabsRow!;
    const activeBefore = [...savedTabsRow.querySelectorAll('.side-tab')].map((t) => t.classList.contains('active'));

    handle.dispose();
    app.state.sidePanel.value = 'history';

    const activeAfter = [...savedTabsRow.querySelectorAll('.side-tab')].map((t) => t.classList.contains('active'));
    expect(activeAfter).toEqual(activeBefore);
  });
});
