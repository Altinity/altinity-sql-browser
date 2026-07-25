import { test, expect } from '@playwright/test';

test('Workbench star → Dashboard delete → Workbench reload keeps membership consistent', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto('/tests/e2e/dashboard-membership.html');
  await page.waitForTimeout(250);
  expect(pageErrors).toEqual([]);
  await page.waitForFunction(() => window.__ready === true);

  await page.locator('.sv-star[title="Favorite"]').click();
  await page.waitForFunction(async () => (await window.__workspace()).queries[0].spec.favorite === true);
  let workspace = await page.evaluate(() => window.__workspace());
  expect(workspace.queries[0].spec.favorite).toBe(true);
  expect(workspace.dashboards[0].tiles).toHaveLength(1);

  await page.getByRole('button', { name: 'Open Dashboard' }).click();
  expect(pageErrors).toEqual([]);
  await expect(page.locator('.dash-tile-body')).toContainText('1');
  await page.getByRole('button', { name: 'Remove Revenue from the dashboard' }).click();
  await page.waitForFunction(async () => (await window.__workspace()).queries[0].spec.favorite === false);
  workspace = await page.evaluate(() => window.__workspace());
  expect(workspace.queries[0].spec.favorite).toBe(false);
  expect(workspace.dashboards[0].tiles).toEqual([]);
  expect(workspace.dashboards[0].revision).toBe(2);

  await page.reload();
  await page.waitForFunction(() => window.__ready === true);
  await expect(page.locator('.sv-star[title="Favorite"]')).toBeVisible();
  await expect(page.locator('.sv-star')).not.toHaveClass(/\bon\b/);
});
