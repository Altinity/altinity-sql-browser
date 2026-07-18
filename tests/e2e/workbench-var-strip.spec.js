import { test, expect } from '@playwright/test';

// The Workbench `{name:Type}` variable strip (#134/#248 precedent) already
// implements the never-wrap/horizontally-scrolling interaction contract #294
// generalizes to Dashboard filters. happy-dom cannot compute CSS layout
// (wrapping/overflow are invisible to the unit suite), so this real-browser
// harness pins the contract directly against `.var-strip`.
async function openAt(page, width, height = 700) {
  await page.setViewportSize({ width, height });
  await page.goto('/tests/e2e/workbench-var-strip.html');
  await page.waitForFunction(() => window.__ready === true);
}

test.describe('Workbench var-strip overflow', () => {
  test('stays on one row and scrolls horizontally instead of wrapping', async ({ page }) => {
    await openAt(page, 900);
    const strip = page.locator('.var-strip');
    const layout = await strip.evaluate((node) => ({
      flexWrap: getComputedStyle(node).flexWrap,
      overflowX: getComputedStyle(node).overflowX,
      clientWidth: node.clientWidth,
      scrollWidth: node.scrollWidth,
      fieldTops: [...node.querySelectorAll('.var-field')].map((field) => field.getBoundingClientRect().top),
      fieldWidths: [...node.querySelectorAll('.var-field')].map((field) => field.getBoundingClientRect().width),
      pageOverflow: document.documentElement.scrollWidth - innerWidth,
    }));
    expect(layout.flexWrap).toBe('nowrap');
    expect(layout.overflowX).toBe('auto');
    expect(layout.scrollWidth).toBeGreaterThan(layout.clientWidth);
    expect(Math.max(...layout.fieldTops) - Math.min(...layout.fieldTops)).toBeLessThan(2);
    expect(Math.min(...layout.fieldWidths)).toBeGreaterThan(150);
    expect(layout.pageOverflow).toBeLessThanOrEqual(0);
  });

  test('reaches the final field by scroll and by keyboard focus', async ({ page }) => {
    await openAt(page, 900);
    const strip = page.locator('.var-strip');

    await strip.evaluate((node) => { node.scrollLeft = node.scrollWidth; });
    expect(await strip.evaluate((node) => node.scrollLeft)).toBeGreaterThan(0);
    await strip.evaluate((node) => { node.scrollLeft = 0; });

    const lastInput = page.locator('.var-strip .var-field').last().locator('input');
    await lastInput.focus();
    await expect(lastInput).toBeInViewport();
  });
});
