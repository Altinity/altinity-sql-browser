import { test, expect } from '@playwright/test';

// #487 phase 3 — the compact icon rail and its docked focused drawer, proved
// against REAL COMPUTED STYLE (`getComputedStyle(el).display`), never just the
// `.hidden` DOM property or `getBoundingClientRect()` alone. That distinction is
// the entire point of this file: `applyEffectiveLeftNavigationLayout`
// (`src/ui/app-shell.ts`) sets `.hidden` on the drawer's non-focused pane and
// tab rows, but `.side-pane`/`.side-tabs` carried a `display: flex` CSS rule
// with no `[hidden]` override — so the hide/show logic did NOTHING in a real
// browser despite every happy-dom unit test passing. That CSS bug is now fixed
// (`.side-pane[hidden]`/`.side-tabs[hidden] { display: none; }` in
// `src/styles.css`), but only a real browser can catch a regression of this
// shape, which is this file's whole job.
//
// Reuses `dashboard-tree.html` (#426/#487's fixture): it already mounts the
// real `mountAppShell` with the rail, sidebar, both tab rows and the section
// registry live, seeded with a Dashboard + Library query + History. It now also
// exposes `window.__app` for reading `state.leftNavMode`/`leftNavSection`
// directly when a test wants internal-consistency confirmation alongside the
// computed-style checks.

const open = async (page, width = 1280, height = 800) => {
  await page.setViewportSize({ width, height });
  await page.goto('/tests/e2e/dashboard-tree.html');
  await page.waitForFunction(() => window.__ready === true);
};

/** Drag `.col-resize` to `targetX` the way a real user does — mirrors
 *  `sidebar-tabs-narrow.spec.js`'s own helper. Grabs the handle at its own
 *  LEFT EDGE (a zero grip offset, `#487 phase-3 review, blocker 1`): the
 *  separator's own `advanceTo` corrects for wherever inside the handle the
 *  pointer actually grabbed, so a grab anywhere else would report a total
 *  offset by up to the handle's own width — grabbing at the edge is what
 *  keeps this helper's contract exact. `left-nav-separator.ts`'s `advanceTo`
 *  reads `ev.clientX` minus that grip offset (the shell-left offset is 0
 *  today per `core/left-nav-layout.ts`'s own note), so the resulting
 *  navigation TOTAL width IS `targetX`. */
const dragSeparatorTo = async (page, targetX) => {
  const handle = page.locator('.col-resize');
  const box = await handle.boundingBox();
  await page.mouse.move(box.x, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(targetX, box.y + box.height / 2, { steps: 5 });
  await page.mouse.up();
};

// The rail launchers' `aria-label`s (`nav-sections.ts`'s `NAV_SECTION_META`,
// #487's own "Rail state" table) — deliberately different strings from each
// button's `title` tooltip (asserted directly in the first test below).
const RAIL_LABEL = {
  databases: 'Open Databases navigation',
  dashboards: 'Open Dashboards navigation',
  library: 'Open Library navigation',
  history: 'Open query History',
};

const railButton = (page, section) => page.locator(`.left-rail-btn[aria-label="${RAIL_LABEL[section]}"]`);

/** The presentation table `applyEffectiveLeftNavigationLayout` writes, read back
 *  as REAL computed style wherever a display toggle is involved — never the
 *  `.hidden` DOM property alone. */
const navGeometry = () => ({
  navMode: document.querySelector('.main-row').dataset.navMode,
  railDisplay: getComputedStyle(document.querySelector('.left-rail')).display,
  sidebarDisplay: getComputedStyle(document.querySelector('.sidebar')).display,
  schemaPaneDisplay: getComputedStyle(document.querySelector('.schema-pane')).display,
  savedPaneDisplay: getComputedStyle(document.querySelector('.saved-pane')).display,
  upperTabsDisplay: getComputedStyle(document.querySelector('.upper-role-tabs')).display,
  savedTabsDisplay: getComputedStyle(document.querySelector('.saved-pane > .side-tabs')).display,
});

test.describe('left navigation rail + focused drawer (#487 phase 3)', () => {
  test('dragging below the fold threshold folds the sidebar into a 4-icon rail', async ({ page }) => {
    await open(page);
    await dragSeparatorTo(page, 50); // comfortably under LEFT_FOLD_THRESHOLD_PX (140)

    const geometry = await page.evaluate(navGeometry);
    expect(geometry.navMode).toBe('rail');
    expect(geometry.sidebarDisplay).toBe('none');
    expect(geometry.railDisplay).not.toBe('none');

    const buttons = await page.evaluate(() => [...document.querySelectorAll('.left-rail-btn')].map((b) => ({
      title: b.getAttribute('title'),
      ariaLabel: b.getAttribute('aria-label'),
      display: getComputedStyle(b).display,
    })));
    expect(buttons).toHaveLength(4);
    for (const button of buttons) {
      expect(button.display).not.toBe('none');
      expect(button.title).toBeTruthy();
      expect(button.ariaLabel).toBeTruthy();
      // Deliberately distinct strings (#487's own design), not one value doing
      // double duty — see `left-rail.ts`'s header comment.
      expect(button.ariaLabel).not.toBe(button.title);
    }
  });

  test('clicking a rail launcher opens a docked focused drawer that pushes the work surface', async ({ page }) => {
    await open(page);
    await dragSeparatorTo(page, 50);
    const bareRailQueryLeft = await page.locator('.query-host').evaluate((el) => el.getBoundingClientRect().left);

    await railButton(page, 'databases').click();
    await expect.poll(() => page.evaluate(() => document.querySelector('.main-row').dataset.navMode)).toBe('drawer');

    const after = await page.evaluate(() => ({
      navMode: document.querySelector('.main-row').dataset.navMode,
      railDisplay: getComputedStyle(document.querySelector('.left-rail')).display,
      sidebarDisplay: getComputedStyle(document.querySelector('.sidebar')).display,
      schemaPaneDisplay: getComputedStyle(document.querySelector('.schema-pane')).display,
      savedPaneDisplay: getComputedStyle(document.querySelector('.saved-pane')).display,
      upperTabsDisplay: getComputedStyle(document.querySelector('.upper-role-tabs')).display,
      savedTabsDisplay: getComputedStyle(document.querySelector('.saved-pane > .side-tabs')).display,
      databasesHostDisplay: getComputedStyle(document.querySelector('.nav-section-host[data-section="databases"]')).display,
      dashboardsHostDisplay: getComputedStyle(document.querySelector('.nav-section-host[data-section="dashboards"]')).display,
      queryHostLeft: document.querySelector('.query-host').getBoundingClientRect().left,
      ariaLabelledby: document.querySelector('.sidebar').getAttribute('aria-labelledby'),
      titleText: document.querySelector('.left-nav-title').textContent,
    }));

    expect(after.navMode).toBe('drawer');
    // The rail stays visible ALONGSIDE the drawer (#487 requires every rail
    // icon to stay reachable while a drawer is open).
    expect(after.railDisplay).not.toBe('none');
    expect(after.sidebarDisplay).not.toBe('none');
    // The direct regression test for the confirmed CSS-cascade bug: exactly the
    // drawer's OWN section's pane/host render, the OTHER pane and BOTH
    // wide-mode tab-switcher rows genuinely do not (`display: none`) — not
    // merely `hidden` as a DOM property.
    expect(after.schemaPaneDisplay).not.toBe('none');
    expect(after.savedPaneDisplay).toBe('none');
    expect(after.databasesHostDisplay).not.toBe('none');
    expect(after.dashboardsHostDisplay).toBe('none');
    expect(after.upperTabsDisplay).toBe('none');
    expect(after.savedTabsDisplay).toBe('none');
    expect(after.ariaLabelledby).toBe('left-nav-title');
    expect(after.titleText).toBe('Databases');
    // A docked drawer PUSHES the centre surface (participates in normal flow)
    // rather than floating over it: the query host's own left edge shifts right
    // by roughly the drawer's width once it opens.
    expect(after.queryHostLeft).toBeGreaterThan(bareRailQueryLeft + 100);
  });

  test('clicking a different rail launcher switches the drawer content in place, never both panes at once', async ({ page }) => {
    await open(page);
    await dragSeparatorTo(page, 50);
    await railButton(page, 'databases').click();
    await expect.poll(() => page.evaluate(() => document.querySelector('.main-row').dataset.navMode)).toBe('drawer');

    // Switch to a LOWER-pane section: this is what actually proves a pane-level
    // transition (Databases → Dashboards stays inside the same 'upper' pane and
    // would not exercise this), with no frame where both panes are visible.
    await railButton(page, 'library').click();

    const state = await page.evaluate(() => ({
      navMode: document.querySelector('.main-row').dataset.navMode,
      schemaPaneDisplay: getComputedStyle(document.querySelector('.schema-pane')).display,
      savedPaneDisplay: getComputedStyle(document.querySelector('.saved-pane')).display,
      libraryHostDisplay: getComputedStyle(document.querySelector('.nav-section-host[data-section="library"]')).display,
      historyHostDisplay: getComputedStyle(document.querySelector('.nav-section-host[data-section="history"]')).display,
      titleText: document.querySelector('.left-nav-title').textContent,
    }));
    expect(state.navMode).toBe('drawer');
    // The previously-shown PANE (schema-pane, holding Databases) is hidden and
    // the new one (saved-pane, holding Library) is visible — checked together
    // so there is no frame where both (or neither) render. (The Databases HOST
    // itself keeps its own prior visibility once its ancestor pane is hidden —
    // that is not a bug, it mirrors `dashboard-tree.spec.js`'s "a hidden role
    // host contributes NO layout" case: an invisible ancestor is what matters,
    // not also flipping every now-unreachable descendant's own display.)
    expect(state.schemaPaneDisplay).toBe('none');
    expect(state.savedPaneDisplay).not.toBe('none');
    // Within the now-visible lower pane, its own sibling exclusivity still
    // holds: Library shows, History does not.
    expect(state.libraryHostDisplay).not.toBe('none');
    expect(state.historyHostDisplay).toBe('none');
    expect(state.titleText).toBe('Library');
  });

  test('clicking the already-open section\'s rail icon closes the drawer, returning to the bare rail', async ({ page }) => {
    await open(page);
    await dragSeparatorTo(page, 50);
    const databasesBtn = railButton(page, 'databases');
    await databasesBtn.click();
    await expect.poll(() => page.evaluate(() => document.querySelector('.main-row').dataset.navMode)).toBe('drawer');

    await databasesBtn.click();

    const after = await page.evaluate(() => ({
      navMode: document.querySelector('.main-row').dataset.navMode,
      sidebarDisplay: getComputedStyle(document.querySelector('.sidebar')).display,
      railDisplay: getComputedStyle(document.querySelector('.left-rail')).display,
    }));
    expect(after.navMode).toBe('rail');
    expect(after.sidebarDisplay).toBe('none');
    expect(after.railDisplay).not.toBe('none');
    // `left-rail.ts`'s click handler now calls `button.focus()` explicitly
    // (fixed after this real-browser pass first surfaced the gap — WebKit does
    // not focus a clicked `<button>` natively, unlike Chromium/Firefox, so this
    // assertion used to only hold by browser-default accident on two of three
    // engines). No longer scoped away from WebKit.
    await expect(databasesBtn).toBeFocused();
  });

  // The search box is EMPTY when Escape is pressed — `saved-history.ts` only
  // claims Escape (via `preventDefault`) when its own filter is non-empty, so
  // this also proves the empty-search fix still lets Escape bubble to the
  // drawer's own handler (`app-shell.ts`'s `sidebar` keydown listener).
  test('Escape closes the focused drawer and returns focus to the rail icon', async ({ page }) => {
    await open(page);
    await dragSeparatorTo(page, 50);
    const libraryBtn = railButton(page, 'library');
    await libraryBtn.click();
    await expect.poll(() => page.evaluate(() => document.querySelector('.main-row').dataset.navMode)).toBe('drawer');

    const search = page.locator('.nav-section-host[data-section="library"] .sv-search-input');
    await search.click();
    await expect(search).toHaveValue('');
    await page.keyboard.press('Escape');

    const after = await page.evaluate(() => ({
      navMode: document.querySelector('.main-row').dataset.navMode,
      sidebarDisplay: getComputedStyle(document.querySelector('.sidebar')).display,
      railDisplay: getComputedStyle(document.querySelector('.left-rail')).display,
    }));
    expect(after.navMode).toBe('rail');
    expect(after.sidebarDisplay).toBe('none');
    expect(after.railDisplay).not.toBe('none');
    await expect(libraryBtn).toBeFocused();
  });

  test('dragging back past the wide threshold restores the two-pane sidebar and focuses the matching wide-mode tab', async ({ page }) => {
    await open(page);
    await dragSeparatorTo(page, 50);
    await railButton(page, 'library').click();
    await expect.poll(() => page.evaluate(() => document.querySelector('.main-row').dataset.navMode)).toBe('drawer');

    // An open drawer sits BESIDE the rail, so its own panel width is the total
    // minus LEFT_RAIL_PX (48); restoring wide needs that minus-rail figure past
    // LEFT_WIDE_THRESHOLD_PX (260) — 400 clears both with room to spare.
    await dragSeparatorTo(page, 400);

    const after = await page.evaluate(navGeometry);
    expect(after.navMode).toBe('wide');
    expect(after.railDisplay).toBe('none');
    expect(after.sidebarDisplay).not.toBe('none');
    expect(after.schemaPaneDisplay).not.toBe('none');
    expect(after.savedPaneDisplay).not.toBe('none');
    expect(after.upperTabsDisplay).not.toBe('none');
    expect(after.savedTabsDisplay).not.toBe('none');

    // Focus lands on the WIDE-mode tab for whichever section's drawer was open
    // (library), never left on a now-hidden drawer descendant.
    const active = await page.evaluate(() => ({
      section: document.activeElement.dataset.section,
      inSavedTabs: document.activeElement.closest('.saved-pane > .side-tabs') !== null,
    }));
    expect(active).toEqual({ section: 'library', inSavedTabs: true });
  });

  // #487 phase-3 review, second pass, major issue — a WIDE sidebar (never a
  // focused drawer) folding straight to bare rail had no restoration at all:
  // `focusedSection` is null throughout 'wide' by construction, so the
  // rail-restore branch's old `priorFocusedSection !== null` guard could
  // never fire coming out of wide. `app-shell.test.ts` unit-tests the
  // DOM-lookup fix directly (happy-dom has no CSS, so it cannot demonstrate
  // the failure this fixes, but it CAN prove the restoration logic itself is
  // correct once focus data is available at commit time).
  //
  // Deliberately NOT e2e-tested via a real mouse drag here: the resize
  // separator's live-drag repaint (`left-nav-separator.ts`) hides the
  // sidebar/rail on an INTERMEDIATE `mousemove` frame, well before the final
  // `mouseup` commit — and confirmed against a real browser, a focused
  // descendant is dropped to `<body>` on THAT earlier frame, before any
  // commit-time JS (this fix, or the PRE-EXISTING drawer -> rail restoration
  // from major issue 4) ever runs. This is a genuine gap in the whole
  // mechanism, not a regression from this fix — tracked separately (see the
  // linked follow-up issue) rather than papered over with a passing-by-luck
  // e2e assertion.

  test('the separator keys (Home/End) fold and restore, with internally consistent ARIA', async ({ page }) => {
    await open(page);
    const separator = page.locator('.col-resize');
    await separator.focus();

    const readAria = () => page.evaluate(() => {
      const el = document.querySelector('.col-resize');
      return {
        min: Number(el.getAttribute('aria-valuemin')),
        max: Number(el.getAttribute('aria-valuemax')),
        now: Number(el.getAttribute('aria-valuenow')),
        text: el.getAttribute('aria-valuetext'),
      };
    });
    const assertRangeCoherent = (aria) => {
      expect(aria.min).toBeLessThanOrEqual(aria.now);
      expect(aria.now).toBeLessThanOrEqual(aria.max);
    };

    const before = await readAria();
    assertRangeCoherent(before);

    await page.keyboard.press('Home');
    const folded = await page.evaluate(navGeometry);
    expect(folded.navMode).toBe('rail');
    expect(folded.sidebarDisplay).toBe('none');
    expect(folded.railDisplay).not.toBe('none');
    const foldedAria = await readAria();
    assertRangeCoherent(foldedAria);
    expect(foldedAria.text).not.toBe(before.text);

    await page.keyboard.press('End');
    const restored = await page.evaluate(navGeometry);
    expect(restored.navMode).toBe('wide');
    expect(restored.sidebarDisplay).not.toBe('none');
    expect(restored.railDisplay).toBe('none');
    const restoredAria = await readAria();
    assertRangeCoherent(restoredAria);
    expect(restoredAria.text).not.toBe(foldedAria.text);
  });

  // Belt-and-braces note: this only proves the JS-projected path
  // (`effectiveLeftNavigationLayout` forcing 'wide' whenever `state.isMobile` is
  // true) actually works at a real mobile viewport, REGARDLESS of whichever
  // `leftNavMode` preference the page loaded with (seeded here via localStorage
  // before navigation, mirroring how `state.ts` reads `asb:leftNavMode`). The
  // separate pure-CSS fallback in `styles.css` (`.left-rail { display: none
  // !important; }` inside the mobile `@media` block, for when `matchMedia` is
  // unavailable) cannot be exercised here: a real Playwright browser always has
  // `matchMedia`, so that fallback path is unverifiable at this level and was
  // reasoned about statically instead.
  test('the rail never renders at a mobile viewport, regardless of the loaded leftNavMode preference', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('asb:leftNavMode', 'rail'));
    await open(page, 500, 800); // below MOBILE_BREAKPOINT_PX (768)

    const geometry = await page.evaluate(() => ({
      railDisplay: getComputedStyle(document.querySelector('.left-rail')).display,
      navMode: document.querySelector('.main-row').dataset.navMode,
      isMobile: window.__app.state.isMobile.value,
    }));
    expect(geometry.isMobile).toBe(true);
    expect(geometry.railDisplay).toBe('none');
    // The projection forces 'wide' at this viewport even though the stored
    // preference was 'rail' — proving the mobile override, not merely that the
    // preference happened to already be 'wide'.
    expect(geometry.navMode).toBe('wide');
  });
});

// #487 phase-3 review, second pass, major issue — entering mobile Editor/
// Results hides `.sidebar` via CSS alone (`.main-row[data-mobile-view=
// "editor"/"results"] .sidebar { display: none }` in styles.css),
// independently of `data-nav-mode` (mobile forces 'wide' regardless of which
// mobile view is showing). `app-shell.test.ts` unit-tests the rescue logic
// directly (isMobile crossing, a bottom-nav tap while already mobile, and
// `showHost('dashboard')`).
//
// Deliberately NOT e2e-tested here: a real-browser probe (Chromium, under
// this suite's normal 3-worker parallelism) found the rescue's own explicit
// `.focus()` call itself gets raced and reverted roughly half the time by
// the browser's OWN async layout recompute for the newly-matching mobile
// media query (`.left-rail` disappearing, `.sidebar` jumping to `width:
// 100%` on "tables", or to `display: none` on "editor"/"results", is a large
// discontinuous reflow) — Firefox and WebKit did not reproduce this under
// the same load. A `requestAnimationFrame`-deferred focus call cut the
// failure rate but did not eliminate it. This is a genuine, deeper
// engine-timing gap, not a regression from this fix and not something a
// flaky-but-usually-green e2e assertion should paper over — tracked in the
// same follow-up as the drag-timing issue above.

// #487 phase-3 review, blocker 1 — a click-and-release with no genuine
// movement must preserve the stored preference untouched, even when the
// separator happens to be RENDERED somewhere other than that preference (a
// narrow viewport clamping a maximal stored width). Proved end-to-end in a
// real browser: `page.mouse.down()`/`up()` with no intervening `move()` at
// all, at the exact pixel the (clamped) handle currently renders at.
test.describe('left navigation separator — click-without-drag (#487 phase-3 review, blocker 1)', () => {
  test('a viewport-clamped 420px preference survives a click-and-release on the clamped handle, unchanged', async ({ page }) => {
    // Narrow from the START (budget = 800 - 7 - 480 = 313) — this fixture
    // wires no live-resize `observeElementWidth` seam, so the clamp has to
    // come from the drag's OWN session, not a later viewport-resize repaint.
    await open(page, 800, 800);
    await dragSeparatorTo(page, 420); // a raw proposal well past what 313 can render

    // The drag's own commit already proves the core "restore-while-clamped"
    // contract: the RENDERED width is the viewport-clamped 313, but the
    // PERSISTED preference is the full, honest 420.
    expect(await page.locator('.sidebar').evaluate((el) => el.style.width)).toBe('313px');
    expect(await page.evaluate(() => window.__app.state.sidebarPx)).toBe(420);
    expect(await page.evaluate(() => localStorage.getItem('asb:sidebarPx'))).toBe('420');

    // Click-and-release the separator with NO intervening mousemove at all,
    // at the exact pixel the clamped handle renders at right now.
    const handle = page.locator('.col-resize');
    const box = await handle.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.up();

    // The honest 420px preference must survive — not silently downgraded to
    // the 313px pixel the clamped handle happened to be rendered at.
    expect(await page.evaluate(() => window.__app.state.sidebarPx)).toBe(420);
    expect(await page.evaluate(() => localStorage.getItem('asb:sidebarPx'))).toBe('420');

    // Confirmed decoupled from any live-repaint mechanics: a fresh load at
    // full width reads the SAME persisted preference back.
    await open(page, 1280, 800);
    expect(await page.locator('.sidebar').evaluate((el) => el.style.width)).toBe('420px');
  });

  test('clicking the left, centre, and right portions of the 7px handle all preserve an unclamped preference identically', async ({ page }) => {
    await open(page);
    await dragSeparatorTo(page, 300);

    const handle = page.locator('.col-resize');
    for (const fraction of [0, 0.5, 1]) { // left edge, centre, right edge
      const box = await handle.boundingBox();
      const x = box.x + box.width * fraction;
      await page.mouse.move(x, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.up();
      // eslint-disable-next-line no-await-in-loop
      expect(await page.evaluate(() => window.__app.state.sidebarPx)).toBe(300);
    }
  });
});
