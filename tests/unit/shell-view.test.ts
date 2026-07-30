// #577 state S2 (Preact treatment) — this file re-expresses the PRESENTATION
// TABLE the deleted `app-shell.test.ts` (S1 control) pinned against
// `ui/app-shell.ts`'s hand-written `applyEffectiveLeftNavigationLayout`, this
// time against `ui/shell/shell-view.ts`'s rendered tree. It deliberately
// asserts real DOM (classes, `hidden`, `dataset`, `style`, ARIA) rather than
// component props or shape — "the rendered tree, not implementation shape" —
// so the file stays valid evidence even if `shell-view.ts`'s internal
// component boundaries are refactored later.
//
// THE ONE BEHAVIOURAL DELTA FROM S0/S1, EVERYWHERE IN THIS FILE: a signal
// write no longer repaints synchronously. `shell-layout.ts`'s `layout`/
// `navMode` are `computed`s, and Preact schedules the actual DOM diff on a
// microtask — confirmed empirically against this exact module (a bare
// `setTimeout(resolve, 0)` after a signal write is sufficient for the DOM to
// catch up; no test below needed more than one). The vanilla arm painted
// every one of these synchronously; every test that follows a signal write
// with an assertion awaits `flush()` first. Tests that only read the
// MOUNT-TIME presentation (state set BEFORE `mountAppShell` runs) stay
// synchronous on purpose: Preact's first `render()` call is synchronous
// (`ui/shell/adopt.ts`'s own doc comment), so the very first paint needs no
// flush — only a change AFTER mount does.
import { describe, expect, it, vi } from 'vitest';
import { mountAppShell } from '../../src/ui/shell/shell-host.js';
import type { AppShellDeps } from '../../src/ui/shell/shell-host.js';
import { startDrag } from '../../src/ui/splitters.js';
import { makeApp } from '../helpers/fake-app.js';
import { LEFT_NAV_SECTIONS } from '../../src/core/left-nav-layout.js';
import type { LeftNavigationSection } from '../../src/core/left-nav-layout.js';

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** Mirrors the deleted suite's own `mount()` — a fresh `makeApp()` plus a real
 *  `mountAppShell` call, with every injected seam defaulted the same way. */
function mount(overrides: Partial<AppShellDeps> = {}) {
  const loadSchema = vi.fn(async () => {});
  const loadReference = vi.fn(async () => {});
  const app = makeApp({ catalog: { loadSchema, loadReference }, prefs: { save: vi.fn() } });
  const handle = mountAppShell({
    app, root: app.root, document, state: app.state, catalog: app.catalog,
    prefs: app.prefs, matchMedia: null, updateBanner: vi.fn(), startDrag,
    ...overrides,
  });
  return { app, handle };
}

/** Mirrors the deleted suite's own `mountWithLeftNav()`: the left-navigation
 *  signals are set BEFORE `mountAppShell` runs, so the shell's own mount-time
 *  paint (the `layout`/`navMode` computeds' first read) already reflects them
 *  — the only way to exercise a 'rail'/'drawer' or `isMobile`-from-the-start
 *  presentation without an extra flush. */
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
    app, root: app.root, document, state: app.state, catalog: app.catalog,
    prefs: app.prefs, matchMedia: null, updateBanner: vi.fn(), startDrag,
    ...overrides,
  });
  return { app, handle };
}

/** Every mounted section host, keyed by its `data-section` — identical idiom
 *  to the deleted suite's own helper, since `nav-sections.ts`'s registry (an
 *  adopted, non-Preact-owned subtree) is untouched by the S1->S2 rewrite. */
const hosts = (root: ParentNode): Record<string, HTMLElement> => Object.fromEntries(
  [...root.querySelectorAll<HTMLElement>('.nav-section-host')].map((h) => [h.dataset.section!, h]),
);

describe('Shell presentation table — wide mode', () => {
  it('rail hidden, sidebar shown at its wide width, every wide-only control visible, drawer title hidden, no aria-labelledby', () => {
    const { app, handle } = mountWithLeftNav({ mode: 'wide' });
    const mainRow = app.root.querySelector('.main-row') as HTMLElement;
    const sidebar = app.root.querySelector('.sidebar') as HTMLElement;
    const rail = app.root.querySelector('.left-rail') as HTMLElement;

    expect(mainRow.dataset.navMode).toBe('wide');
    expect(sidebar.dataset.navMode).toBe('wide');
    expect(rail.hidden).toBe(true);
    expect(sidebar.hidden).toBe(false);
    // 248 is LEFT_WIDE_DEFAULT_PX — unclamped, since no `observeElementWidth`
    // seam was injected (maxNavTotalPx stays +Infinity).
    expect(sidebar.style.width).toBe('248px');
    expect(app.dom.upperRoleTabs!.hidden).toBe(false);
    expect(app.dom.savedTabsRow!.hidden).toBe(false);
    expect(app.dom.sideSplit!.hidden).toBe(false);
    expect((app.root.querySelector('.schema-pane') as HTMLElement).hidden).toBe(false);
    expect((app.root.querySelector('.saved-pane') as HTMLElement).hidden).toBe(false);
    expect(app.dom.leftNavTitle!.hidden).toBe(true);
    expect(app.dom.leftNavTitle!.textContent).toBe('');
    expect(sidebar.hasAttribute('aria-labelledby')).toBe(false);
    handle.dispose();
  });
});

describe('Shell presentation table — rail mode (no focused section)', () => {
  it('rail shown, sidebar and every wide-only control hidden', () => {
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
});

describe('Shell presentation table — drawer mode, an UPPER section focused', () => {
  it('rail + sidebar visible, upper pane shown and FILLING THE COLUMN, lower pane + wide-only chrome hidden, title names the section', () => {
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
    // 240 is LEFT_DRAWER_DEFAULT_PX — unclamped, same reasoning as the wide case.
    expect(sidebar.style.width).toBe('240px');
    expect(schemaPane.hidden).toBe(false);
    expect(savedPane.hidden).toBe(true);
    expect(app.dom.upperRoleTabs!.hidden).toBe(true);
    expect(app.dom.savedTabsRow!.hidden).toBe(true);
    expect(app.dom.sideSplit!.hidden).toBe(true);
    expect(app.dom.leftNavTitle!.hidden).toBe(false);
    expect(app.dom.leftNavTitle!.textContent).toBe('Dashboards');
    expect(sidebar.getAttribute('aria-labelledby')).toBe(app.dom.leftNavTitle!.id);
    // The one-pane-fills-the-column height override: with `savedPane` hidden,
    // `schemaPane`'s ordinary percentage height (`state.sideSplitPct`) would
    // otherwise leave the bottom of the drawer empty.
    // happy-dom expands the `flex: '1'` shorthand and then applies the
    // explicit `flexShrink: '0'` override on top of it (both are set in
    // `Sidebar`'s own `upperStyle`) — `'1 0 0%'` is that combination, not a
    // literal echo of the shorthand string.
    expect(schemaPane.style.flex).toBe('1 0 0%');
    expect(schemaPane.style.height).toBe('auto');
    handle.dispose();
  });
});

describe('Shell presentation table — drawer mode, a LOWER section focused', () => {
  it('lower pane shown, upper pane hidden, title names the section, and the upper pane does NOT get the fills-the-column override (it is not the one showing)', () => {
    const { app, handle } = mountWithLeftNav({ mode: 'rail', section: 'history' });
    const schemaPane = app.root.querySelector('.schema-pane') as HTMLElement;
    const savedPane = app.root.querySelector('.saved-pane') as HTMLElement;

    expect(schemaPane.hidden).toBe(true);
    expect(savedPane.hidden).toBe(false);
    expect(app.dom.leftNavTitle!.textContent).toBe('History');
    // The hidden upper pane keeps its ordinary wide-mode height (58 is
    // `state.sideSplitPct`'s default) rather than picking up the override
    // meant for a drawer that is actually showing IT.
    expect(schemaPane.style.flex).toBe('');
    expect(schemaPane.style.height).toBe('58%');
    handle.dispose();
  });
});

describe('Shell presentation table — node identity across a mode round trip', () => {
  // The single most important assertion in this file: `.sidebar` is
  // RE-PRESENTED, never rebuilt, and the four section hosts phase 2 built stay
  // at their exact DOM identity across every mode change. A vDOM is exactly
  // the kind of thing that could silently violate this (a keyed re-render
  // that happens to produce an equivalent-looking but DIFFERENT element) — an
  // `.toEqual` on class/attributes would not catch that, only `.toBe` on the
  // actual node references does.
  it('re-presents .sidebar and its four nav-section-host elements — never rebuilds them — across wide -> drawer -> rail -> wide', async () => {
    const { app, handle } = mountWithLeftNav({ mode: 'wide' });
    const sidebar = app.root.querySelector('.sidebar');
    const initialHosts = hosts(app.root);
    expect(Object.keys(initialHosts).sort()).toEqual(['dashboards', 'databases', 'history', 'library']);

    const assertSameIdentity = (): void => {
      expect(app.root.querySelector('.sidebar')).toBe(sidebar);
      const now = hosts(app.root);
      for (const section of Object.keys(initialHosts)) expect(now[section]).toBe(initialHosts[section]);
    };

    // wide -> drawer
    app.state.leftNavMode.value = 'rail';
    app.state.leftNavSection.value = 'library';
    await flush();
    expect((app.root.querySelector('.sidebar') as HTMLElement).dataset.navMode).toBe('drawer');
    assertSameIdentity();

    // drawer -> bare rail
    app.state.leftNavSection.value = null;
    await flush();
    expect((app.root.querySelector('.sidebar') as HTMLElement).dataset.navMode).toBe('rail');
    assertSameIdentity();

    // rail -> wide
    app.state.leftNavMode.value = 'wide';
    await flush();
    expect((app.root.querySelector('.sidebar') as HTMLElement).dataset.navMode).toBe('wide');
    assertSameIdentity();

    handle.dispose();
  });
});

describe('Shell presentation table — the rail\'s four launchers', () => {
  it('each points aria-controls at the sidebar\'s real id and contains its own icon', () => {
    const { app, handle } = mountWithLeftNav({ mode: 'rail', section: null });
    const sidebar = app.root.querySelector('.sidebar') as HTMLElement;
    const buttons = [...app.root.querySelectorAll<HTMLButtonElement>('.left-rail-btn')];

    expect(buttons).toHaveLength(4);
    expect(sidebar.id).toBeTruthy();
    for (const btn of buttons) {
      expect(btn.getAttribute('aria-controls')).toBe(sidebar.id);
      // Each launcher's own icon — `ui/icons.ts` always mints an <svg>.
      expect(btn.querySelector('svg')).not.toBeNull();
    }
    handle.dispose();
  });

  it('aria-expanded tracks the currently focused section, at mount and after it changes', async () => {
    const { app, handle } = mountWithLeftNav({ mode: 'rail', section: 'library' });
    const buttonFor = (section: LeftNavigationSection): HTMLButtonElement =>
      [...app.root.querySelectorAll<HTMLButtonElement>('.left-rail-btn')][LEFT_NAV_SECTIONS.indexOf(section)];

    for (const section of LEFT_NAV_SECTIONS) {
      expect(buttonFor(section).getAttribute('aria-expanded')).toBe(section === 'library' ? 'true' : 'false');
    }

    app.state.leftNavSection.value = 'history';
    await flush();

    for (const section of LEFT_NAV_SECTIONS) {
      expect(buttonFor(section).getAttribute('aria-expanded')).toBe(section === 'history' ? 'true' : 'false');
    }
    handle.dispose();
  });
});

describe('Shell presentation table — .main-row and .mobile-nav are SIBLINGS', () => {
  // The mobile CSS selects the nav's active state through
  // `.main-row[data-mobile-view="…"] ~ .mobile-nav` — a general sibling
  // combinator, so the two need only share a parent with `.main-row` coming
  // first in document order, NOT be immediately adjacent. A wrapper element
  // introduced around either one would break that selector (and every mobile
  // active state) silently, because the two would no longer share a parent at
  // all — exactly what this test would catch and a `.nextElementSibling`
  // check would not (the `sr-only` status region legitimately sits between
  // them, see `Shell`'s own render order).
  it('share the same parent, with .main-row preceding .mobile-nav in document order', () => {
    const { app, handle } = mount();
    const mainRow = app.root.querySelector('.main-row') as HTMLElement;
    const mobileNav = app.root.querySelector('.mobile-nav') as HTMLElement;

    expect(mainRow.parentElement).not.toBeNull();
    expect(mainRow.parentElement).toBe(mobileNav.parentElement);
    const siblings = [...mainRow.parentElement!.children];
    expect(siblings.indexOf(mainRow)).toBeLessThan(siblings.indexOf(mobileNav));
    handle.dispose();
  });
});
