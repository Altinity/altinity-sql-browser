import { test, expect } from '@playwright/test';

// #552 — compact text-only tab headers at a narrow sidebar. happy-dom cannot
// see CSS layout (the `@container sidebar (max-width: 220px)` gate lives in
// `src/styles.css`), so this is the only place the breakpoint is provable:
// dragging the real `.col-resize` handle the way the app does (mousedown on
// the handle, then a real `mousemove`/`mouseup` — `src/ui/splitters.ts`'s
// `dragValue('col', ev)` reads `ev.clientX` directly, unclamped by any rect),
// and reading the resulting `getComputedStyle` on both tab rows.
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

  test('the 180px minimum sidebar still shows compact, unclipped, non-overlapping labels', async ({ page }) => {
    await open(page);
    await dragSidebarTo(page, 100); // below the 180px floor — dragValue clamps it there
    await expect.poll(() => page.locator('.sidebar').evaluate((el) => el.getBoundingClientRect().width)).toBeCloseTo(180, 0);

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
