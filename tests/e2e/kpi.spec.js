import { test, expect } from '@playwright/test';

test.describe('KPI panel', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/tests/e2e/kpi.html');
    await page.waitForFunction(() => window.__ready === true);
  });

  test('renders equivalent accessible cards on workbench and dashboard surfaces', async ({ page }) => {
    const groupSelector = { '#workbench': '.kpi-grid', '#dashboard': '#dashboard-body' };
    for (const surface of ['#workbench', '#dashboard']) {
      await expect(page.locator(`${surface} .kpi-card`)).toHaveCount(2);
      await expect(page.locator(`${surface} .kpi-label`).nth(0)).toHaveText('Active users');
      await expect(page.locator(`${surface} .kpi-value`).nth(0)).toHaveText('13K');
      await expect(page.locator(`${surface} .kpi-value`).nth(1)).toHaveText('99.95%');
      await expect(page.locator(`${surface} .kpi-delta`)).toHaveText('↑ 0.08 pp');
      await expect(page.locator(groupSelector[surface])).toHaveAttribute('aria-label', 'Key performance indicators');
    }
  });

  test('uses controlled card widths (160–320px) in a full-width KPI band (#240)', async ({ page }) => {
    const boxes = await page.locator('#dashboard-body .kpi-card').evaluateAll((nodes) =>
      nodes.map((node) => node.getBoundingClientRect()));
    expect(Math.abs(boxes[1].top - boxes[0].top)).toBeLessThan(1); // same wrapped flex line
    expect(boxes[1].left).toBeGreaterThan(boxes[0].right);
    expect(boxes[0].width).toBeGreaterThanOrEqual(160);
    expect(boxes[0].width).toBeLessThanOrEqual(320);
    expect(Math.abs(boxes[1].height - boxes[0].height)).toBeLessThan(1); // equal height within the line
    // The band spans the Dashboard grid's full content width (grid-column: 1/-1),
    // independent of the Report/Full width/2-3 column tile layout.
    const bandWidth = await page.locator('#dashboard .dash-kpi-band').evaluate((node) => node.getBoundingClientRect().width);
    const gridWidth = await page.locator('#dashboard').evaluate((node) => node.getBoundingClientRect().width);
    expect(Math.abs(bandWidth - gridWidth)).toBeLessThan(2);
  });

  test('wraps to one card per row on a narrow mobile viewport, on both surfaces', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    for (const container of ['#workbench', '#dashboard-body']) {
      const boxes = await page.locator(`${container} .kpi-card`).evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect()));
      expect(boxes[1].top).toBeGreaterThan(boxes[0].bottom);
      expect(boxes[0].width).toBeGreaterThan(250);
    }
  });

  test('shows visible no-data and row-count diagnostics', async ({ page }) => {
    await page.evaluate(() => window.__renderDiagnostic(0));
    await expect(page.locator('#workbench [role="status"]')).toHaveText('No data');
    await page.evaluate(() => window.__renderDiagnostic(2));
    await expect(page.locator('#workbench [role="alert"]')).toHaveText('Expected 1 row, got 2');
  });
});
