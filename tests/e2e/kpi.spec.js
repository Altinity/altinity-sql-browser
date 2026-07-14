import { test, expect } from '@playwright/test';

test.describe('KPI panel', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/tests/e2e/kpi.html');
    await page.waitForFunction(() => window.__ready === true);
  });

  test('renders equivalent accessible cards on workbench and dashboard surfaces', async ({ page }) => {
    for (const surface of ['#workbench', '#dashboard']) {
      await expect(page.locator(`${surface} .kpi-card`)).toHaveCount(2);
      await expect(page.locator(`${surface} .kpi-label`).nth(0)).toHaveText('Active users');
      await expect(page.locator(`${surface} .kpi-value`).nth(0)).toHaveText('13K');
      await expect(page.locator(`${surface} .kpi-value`).nth(1)).toHaveText('99.95%');
      await expect(page.locator(`${surface} .kpi-delta`)).toHaveText('↑ 0.08 pp');
      await expect(page.locator(`${surface} .kpi-grid`)).toHaveAttribute('aria-label', 'Key performance indicators');
    }
  });

  test('uses bounded horizontal cards and natural Report tile height', async ({ page }) => {
    const boxes = await page.locator('#dashboard .kpi-card').evaluateAll((nodes) =>
      nodes.map((node) => node.getBoundingClientRect()));
    expect(Math.abs(boxes[1].top - boxes[0].top)).toBeLessThan(1);
    expect(boxes[1].left).toBeGreaterThan(boxes[0].right);
    expect(boxes[0].width).toBeGreaterThanOrEqual(220);
    expect(boxes[0].width).toBeLessThanOrEqual(280);
    expect(Math.abs(boxes[1].height - boxes[0].height)).toBeLessThan(1);
    expect(await page.locator('#dashboard .dash-tile').evaluate((node) => node.getBoundingClientRect().height)).toBeLessThan(300);
  });

  test('wraps to one card per row on a narrow mobile viewport', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    const boxes = await page.locator('#workbench .kpi-card').evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect()));
    expect(boxes[1].top).toBeGreaterThan(boxes[0].bottom);
    expect(boxes[0].width).toBeGreaterThan(250);
  });

  test('shows visible no-data and row-count diagnostics', async ({ page }) => {
    await page.evaluate(() => window.__renderDiagnostic(0));
    await expect(page.locator('#workbench [role="status"]')).toHaveText('No data');
    await page.evaluate(() => window.__renderDiagnostic(2));
    await expect(page.locator('#workbench [role="alert"]')).toHaveText('Expected 1 row, got 2');
  });
});
