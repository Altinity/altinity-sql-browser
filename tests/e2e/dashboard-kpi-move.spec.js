import { test, expect } from '@playwright/test';

async function open(page) {
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.goto('/tests/e2e/dashboard-kpi-move.html');
  await page.waitForFunction(() => window.__ready === true);
  await expect(page.locator('.dash-gg-tile')).toHaveCount(2);
}

test.describe('Dashboard authored-style KPI movement (#340/#538 follow-up)', () => {
  test('plain drag selects KPI text and never commits movement', async ({ page }) => {
    await open(page);
    const value = page.locator('.dash-gg-tile').first().locator('.kpi-value-number').first();
    const box = await value.boundingBox();
    await page.mouse.move(box.x + 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width - 2, box.y + box.height / 2, { steps: 5 });
    await page.mouse.up();
    expect(await page.evaluate(() => String(getSelection()).length)).toBeGreaterThan(0);
    expect(await page.evaluate(() => window.__commitCount)).toBe(0);
    expect(await page.evaluate(async () => (await window.__workspace()).dashboards[0].tiles.map((tile) => tile.id))).toEqual(['t1', 't2']);
  });

  test('modified drag floats the complete KPI member and commits one move', async ({ page }) => {
    await open(page);
    const members = page.locator('.dash-gg-tile');
    await expect(members.locator('.dash-tile-menu')).toHaveCount(2);
    await expect(members.first().locator('.kpi-card')).toHaveCount(3);
    const from = await members.first().locator('.kpi-card').first().boundingBox();
    const to = await members.nth(1).locator('.kpi-card').boundingBox();
    // WebKit's synthetic Control pointer state is intermittent; Command is
    // the browser-native primary modifier on this macOS matrix. Unit tests
    // cover the Control alias directly.
    await page.keyboard.down('Meta');
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(from.x + from.width / 2 + 10, from.y + from.height / 2, { steps: 2 });
    await expect(members.first()).toHaveClass(/dash-floating/);
    const floating = await members.first().evaluate((node) => ({ position: getComputedStyle(node).position, w: node.getBoundingClientRect().width, h: node.getBoundingClientRect().height }));
    expect(floating.position).toBe('fixed');
    expect(floating.w).toBeGreaterThan(0);
    expect(floating.h).toBeGreaterThan(0);
    await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 5 });
    await page.mouse.up();
    await page.keyboard.up('Meta');
    await expect.poll(() => page.evaluate(() => window.__commitCount)).toBe(1);
    expect(await page.evaluate(async () => (await window.__workspace()).dashboards[0].tiles.map((tile) => tile.id))).toEqual(['t2', 't1']);
  });
});
