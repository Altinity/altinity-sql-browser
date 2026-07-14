import { test, expect } from '@playwright/test';

const indicator = (page, selector) => page.locator(selector).evaluate((el) => {
  const box = el.getBoundingClientRect();
  const line = getComputedStyle(el, '::before');
  return {
    box: { x: box.x, y: box.y, width: box.width, height: box.height },
    lineWidth: parseFloat(line.width),
    lineHeight: parseFloat(line.height),
    lineColor: line.backgroundColor,
    parentBorderLeft: parseFloat(getComputedStyle(el.parentElement).borderLeftWidth),
    cursor: getComputedStyle(el).cursor,
  };
});

test.describe('pane splitter visuals', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/tests/e2e/splitters.html');
    await page.waitForFunction(() => window.__ready === true);
  });

  test('uses a wide hit target with a centered 1px neutral line at rest', async ({ page }) => {
    const col = await indicator(page, '#col-split');
    const row = await indicator(page, '#row-split');
    const drawer = await indicator(page, '#drawer-split');
    const schema = await indicator(page, '#schema-split');

    expect(col.box.width).toBe(7);
    expect(row.box.height).toBe(7);
    expect(drawer.box.width).toBe(6);
    expect(schema.box.height).toBe(7);
    expect(col.lineWidth).toBe(1);
    expect(drawer.lineWidth).toBe(1);
    expect(drawer.parentBorderLeft).toBe(0);
    expect(row.lineHeight).toBe(1);
    expect(schema.lineHeight).toBe(1);
    expect(col.cursor).toBe('col-resize');
    expect(row.cursor).toBe('row-resize');
    expect(col.lineColor).toBe(row.lineColor);
    expect(drawer.lineColor).toBe(row.lineColor);
    expect(schema.lineColor).toBe(row.lineColor);
  });

  test('hover and dragging thicken only the indicator without shifting panes', async ({ page }) => {
    for (const [selector, dimension] of [['#col-split', 'lineWidth'], ['#row-split', 'lineHeight']]) {
      const before = await indicator(page, selector);
      await page.locator(selector).hover();
      await expect.poll(async () => (await indicator(page, selector))[dimension]).toBe(3);
      const hovered = await indicator(page, selector);
      expect(hovered.box).toEqual(before.box);
      expect(hovered.lineColor).not.toBe(before.lineColor);

      await page.locator(selector).evaluate((el) => el.classList.add('dragging'));
      await page.mouse.move(700, 500);
      await expect.poll(async () => (await indicator(page, selector))[dimension]).toBe(3);
      const dragging = await indicator(page, selector);
      expect(dragging.box).toEqual(before.box);
      expect(dragging.lineColor).toBe(hovered.lineColor);

      await page.locator(selector).evaluate((el) => el.classList.remove('dragging'));
    }
  });

  test('uses the same light-theme neutral and accent behavior', async ({ page }) => {
    await page.locator('body').evaluate((el) => el.dataset.theme = 'light');
    const resting = await indicator(page, '#col-split');
    expect(resting.lineWidth).toBe(1);
    await page.locator('#col-split').hover();
    await expect.poll(async () => (await indicator(page, '#col-split')).lineWidth).toBe(3);
    const hovered = await indicator(page, '#col-split');
    expect(hovered.lineColor).not.toBe(resting.lineColor);
  });

  test('hides pane and drawer splitters in the mobile layout', async ({ page }) => {
    await page.setViewportSize({ width: 700, height: 800 });
    for (const selector of ['#col-split', '#row-split', '#drawer-split', '#schema-split']) {
      await expect(page.locator(selector)).toBeHidden();
    }
    await expect.poll(() => page.locator('.drawer-shell').evaluate((el) => parseFloat(getComputedStyle(el).borderLeftWidth))).toBe(1);
  });
});
