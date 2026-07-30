import { test, expect } from '@playwright/test';

// #552 — compact text-only tab headers at a narrow sidebar. happy-dom cannot
// see CSS layout (the `@container sidebar (max-width: 220px)` gate lives in
// `src/styles.css`), so this is the only place the breakpoint is provable:
// dragging the real `.col-resize` handle the way the app does (mousedown on
// the handle, then a real `mousemove`/`mouseup` — `left-nav-separator.ts`'s
// `advanceTo` reads `ev.clientX` directly, unclamped by any rect), and
// reading the resulting `getComputedStyle` on both tab rows.
//
// #487 phase 3 added a SECOND, lower threshold below the 180px floor this
// file originally tested: `LEFT_FOLD_THRESHOLD_PX` (140, `core/
// left-nav-layout.ts`). Dragging past 180 down to 140 is a dead zone — the
// wide sidebar holds at its 180px floor, exactly as before phase 3 — but
// dragging BELOW 140 now folds the sidebar into the compact icon rail instead
// of clamping. That means a drag to `clientX=100` (this file's original
// "180px minimum" target) no longer holds at 180 — it folds. This file's own
// tests below cover both: the dead-zone floor-hold at a retargeted coordinate
// inside `[140, 180)`, and the new fold transition itself. The rail + focused
// drawer's OWN geometry (icons, drawer content, drawer-pushes-the-work-surface)
// is covered separately in `left-nav-fold.spec.js`, not here — this file stays
// scoped to the wide sidebar's own tab-header compaction (#552/#553).
//
// Reuses `dashboard-tree.html` (#426's fixture): it already mounts the real
// `mountAppShell` with both tab rows live — the upper role tabs (Databases ·2
// / Dashboards ·3, from its stub schema + seeded workspace) and the lower
// Library/History switcher (its seed leaves one Library query, `q-lib`).

const open = async (page) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/tests/e2e/dashboard-tree.html');
  await page.waitForFunction(() => window.__ready === true);
};

/** Drag `.col-resize` to `targetX` the way a real user does: press on the
 *  handle, move the pointer, release. `dragValue`'s 'col' branch reads only
 *  `ev.clientX`, so the resulting sidebar width IS `targetX`. */
const dragSidebarTo = async (page, targetX) => {
  const handle = page.locator('.col-resize');
  const box = await handle.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(targetX, box.y + box.height / 2, { steps: 5 });
  await page.mouse.up();
};

const tabsGeometry = () => {
  const rows = [...document.querySelectorAll('.side-tabs')];
  return rows.map((row) => ({
    row: row.className,
    width: row.getBoundingClientRect().width,
    rowScrollWidth: row.scrollWidth,
    rowClientWidth: row.clientWidth,
    tabs: [...row.querySelectorAll('.side-tab')].map((tab) => {
      const label = tab.querySelector('span');
      const icon = tab.querySelector('svg');
      const count = tab.querySelector('.side-count');
      return {
        text: label.textContent,
        iconDisplay: icon ? getComputedStyle(icon).display : 'none',
        countDisplay: count ? getComputedStyle(count).display : 'none',
        labelClipped: label.scrollWidth > label.clientWidth,
        tabRect: tab.getBoundingClientRect(),
        labelRect: label.getBoundingClientRect(),
      };
    }),
  }));
};

test.describe('sidebar tab headers at narrow widths (#552)', () => {
  test('the wide (default) sidebar keeps icons and counts on both tab rows', async ({ page }) => {
    await open(page);
    const [upper, lower] = await page.evaluate(tabsGeometry);
    for (const row of [upper, lower]) {
      expect(row.tabs.length).toBeGreaterThan(0);
      for (const tab of row.tabs) {
        expect(tab.iconDisplay).not.toBe('none');
      }
    }
    // Databases carries a count from the stub schema; Library carries one from
    // the seed's sole unowned query — both are the "not yet compacted" signal.
    expect(upper.tabs.find((t) => t.text === 'Databases').countDisplay).not.toBe('none');
    expect(lower.tabs.find((t) => t.text === 'Library').countDisplay).not.toBe('none');
  });

  test('dragging the sidebar to <=220px switches both rows to text-only labels, with no overflow, clipping or overlap', async ({ page }) => {
    await open(page);
    await dragSidebarTo(page, 200);
    await expect.poll(() => page.locator('.sidebar').evaluate((el) => el.getBoundingClientRect().width)).toBeLessThanOrEqual(220);

    const [upper, lower] = await page.evaluate(tabsGeometry);
    for (const row of [upper, lower]) {
      // No horizontal overflow within the tab row itself.
      expect(row.rowScrollWidth).toBeLessThanOrEqual(row.rowClientWidth + 1);
      let prevRight = -Infinity;
      for (const tab of row.tabs) {
        expect(tab.iconDisplay).toBe('none');
        expect(tab.countDisplay).toBe('none');
        expect(tab.labelClipped).toBe(false);
        // The label fits inside its own tab's box (no bleed past the button).
        expect(tab.labelRect.left).toBeGreaterThanOrEqual(tab.tabRect.left - 0.5);
        expect(tab.labelRect.right).toBeLessThanOrEqual(tab.tabRect.right + 0.5);
        // Tabs are laid out left-to-right with no horizontal overlap.
        expect(tab.tabRect.left).toBeGreaterThanOrEqual(prevRight - 0.5);
        prevRight = tab.tabRect.right;
      }
    }
    // The four labels stay readable and clickable.
    await expect(page.locator('.upper-role-tabs .side-tab', { hasText: 'Databases' })).toBeVisible();
    await expect(page.locator('.upper-role-tabs .side-tab', { hasText: 'Dashboards' })).toBeVisible();
    await expect(page.locator('.saved-pane > .side-tabs .side-tab', { hasText: 'Library' })).toBeVisible();
    await expect(page.locator('.saved-pane > .side-tabs .side-tab', { hasText: 'History' })).toBeVisible();
    await page.locator('.saved-pane > .side-tabs .side-tab', { hasText: 'History' }).click();
    await expect(page.locator('.saved-pane > .side-tabs .side-tab', { hasText: 'History' })).toHaveClass(/active/);
  });

  // #487 phase 3: `clientX=160` sits inside the dead zone `[LEFT_FOLD_THRESHOLD_PX
  // (140), LEFT_PANEL_MIN_PX (180))` — the wide sidebar still holds at its 180px
  // floor rather than folding (phase 1's documented dead-zone behavior). This is
  // the retargeted version of this file's original "drag to 100" test: 100 is now
  // BELOW the fold threshold and folds instead (see the new test below), so this
  // one confirms the real drag pixel-for-pixel still produces the pre-#487 floor
  // outcome at a coordinate that remains inside the wide band.
  test('the 180px minimum sidebar still shows compact, unclipped, non-overlapping labels (dead zone, no fold)', async ({ page }) => {
    await open(page);
    await dragSidebarTo(page, 160); // inside [140, 180) — holds at the floor, does not fold
    await expect.poll(() => page.locator('.sidebar').evaluate((el) => el.getBoundingClientRect().width)).toBeCloseTo(180, 0);
    // Confirms the drag stayed in 'wide' mode rather than folding: the sidebar is
    // still the one presenting (not `hidden`), and the rail never appears.
    await expect(page.locator('.sidebar')).not.toBeHidden();
    await expect(page.locator('.left-rail')).toBeHidden();
    expect(await page.evaluate(() => document.querySelector('.main-row').dataset.navMode)).toBe('wide');

    const [upper, lower] = await page.evaluate(tabsGeometry);
    for (const row of [upper, lower]) {
      expect(row.rowScrollWidth).toBeLessThanOrEqual(row.rowClientWidth + 1);
      let prevRight = -Infinity;
      for (const tab of row.tabs) {
        expect(tab.iconDisplay).toBe('none');
        expect(tab.countDisplay).toBe('none');
        expect(tab.labelClipped).toBe(false);
        expect(tab.tabRect.left).toBeGreaterThanOrEqual(prevRight - 0.5);
        prevRight = tab.tabRect.right;
      }
    }
  });

  // #487 phase 3: dragging BELOW the fold threshold (140) is a real mode
  // transition, not a clamp — the sidebar folds into the compact rail entirely.
  // The #552/#553 tab-compaction machinery this file otherwise tests is moot once
  // folded: both tab rows are not merely compacted, they are not rendered at all
  // (`display: none`, not just the `.hidden` DOM property — the exact CSS-cascade
  // gap a confirmed #487 phase 3 bug lived in, so this checks computed style).
  test('dragging below the fold threshold folds the sidebar into the compact rail', async ({ page }) => {
    await open(page);
    await dragSidebarTo(page, 50); // comfortably under LEFT_FOLD_THRESHOLD_PX (140)

    const geometry = await page.evaluate(() => ({
      navMode: document.querySelector('.main-row').dataset.navMode,
      sidebarNavMode: document.querySelector('.sidebar').dataset.navMode,
      sidebarDisplay: getComputedStyle(document.querySelector('.sidebar')).display,
      railDisplay: getComputedStyle(document.querySelector('.left-rail')).display,
      tabRowDisplays: [...document.querySelectorAll('.side-tabs')].map((row) => getComputedStyle(row).display),
    }));
    expect(geometry.navMode).toBe('rail');
    expect(geometry.sidebarNavMode).toBe('rail');
    expect(geometry.sidebarDisplay).toBe('none');
    expect(geometry.railDisplay).not.toBe('none');
    expect(geometry.tabRowDisplays).toHaveLength(2);
    for (const display of geometry.tabRowDisplays) expect(display).toBe('none');
  });

  test('widening the sidebar back past 220px restores the full tab presentation', async ({ page }) => {
    await open(page);
    await dragSidebarTo(page, 200);
    await expect.poll(() => page.locator('.sidebar').evaluate((el) => el.getBoundingClientRect().width)).toBeLessThanOrEqual(220);

    await dragSidebarTo(page, 300);
    await expect.poll(() => page.locator('.sidebar').evaluate((el) => el.getBoundingClientRect().width)).toBeGreaterThan(220);

    const [upper, lower] = await page.evaluate(tabsGeometry);
    for (const row of [upper, lower]) {
      for (const tab of row.tabs) {
        expect(tab.iconDisplay).not.toBe('none');
      }
    }
    expect(upper.tabs.find((t) => t.text === 'Databases').countDisplay).not.toBe('none');
    expect(lower.tabs.find((t) => t.text === 'Library').countDisplay).not.toBe('none');
  });
});
