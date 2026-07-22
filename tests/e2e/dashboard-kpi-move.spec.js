import { test, expect } from '@playwright/test';

async function open(page) {
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.goto('/tests/e2e/dashboard-kpi-move.html');
  await page.waitForFunction(() => window.__ready === true);
  await expect(page.locator('.dash-kpi-member')).toHaveCount(2);
}

test.describe('Dashboard flow KPI movement (#340)', () => {
  test('plain drag selects KPI text and never commits movement', async ({ page }) => {
    await open(page);
    const value = page.locator('.dash-kpi-member').first().locator('.kpi-value-number').first();
    const box = await value.boundingBox();
    await page.mouse.move(box.x + 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width - 2, box.y + box.height / 2, { steps: 5 });
    await page.mouse.up();
    expect(await page.evaluate(() => String(getSelection()).length)).toBeGreaterThan(0);
    expect(await page.evaluate(() => window.__commitCount)).toBe(0);
    expect(await page.evaluate(async () => (await window.__workspace()).dashboard.tiles.map((tile) => tile.id))).toEqual(['t1', 't2']);
  });

  test('Control-drag floats the complete KPI member and commits one move', async ({ page }) => {
    await open(page);
    const members = page.locator('.dash-kpi-member');
    await expect(page.locator('.dash-kpi-band .dash-gg-grip')).toHaveCount(0);
    await expect(members.first().locator('.kpi-card')).toHaveCount(3);
    // At the fixture's 380px surface, the first query wraps 2+1 and the second
    // query occupies the lower-right hole in the first member's union box.
    const third = await members.first().locator('.kpi-card').nth(2).boundingBox();
    const secondQuery = await members.nth(1).locator('.kpi-card').boundingBox();
    expect(Math.abs(third.y - secondQuery.y)).toBeLessThan(2);
    expect(secondQuery.x).toBeGreaterThan(third.x);
    // A normal `.dash-kpi-member` is display:contents, so the pointer starts
    // from its visible child card; the event bubbles to the member gesture host.
    const from = await members.first().locator('.kpi-card').first().boundingBox();
    const to = await members.nth(1).locator('.kpi-card').boundingBox();
    await page.keyboard.down('Control');
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(from.x + from.width / 2 + 10, from.y + from.height / 2, { steps: 2 });
    await expect(members.first()).toHaveClass(/dash-floating/);
    const floating = await members.first().evaluate((node) => ({ position: getComputedStyle(node).position, w: node.getBoundingClientRect().width, h: node.getBoundingClientRect().height }));
    expect(floating.position).toBe('fixed');
    expect(floating.w).toBeGreaterThan(0);
    expect(floating.h).toBeGreaterThan(0);
    const containment = await members.first().evaluate((node) => {
      const outer = node.getBoundingClientRect();
      return [...node.children].every((child) => {
        const box = child.getBoundingClientRect();
        return box.left >= outer.left - 1 && box.right <= outer.right + 1
          && box.top >= outer.top - 1 && box.bottom <= outer.bottom + 1;
      });
    });
    expect(containment).toBe(true);
    await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 5 });
    await page.mouse.up();
    await page.keyboard.up('Control');
    await expect.poll(() => page.evaluate(() => window.__commitCount)).toBe(1);
    expect(await page.evaluate(async () => (await window.__workspace()).dashboard.tiles.map((tile) => tile.id))).toEqual(['t2', 't1']);
  });
});
