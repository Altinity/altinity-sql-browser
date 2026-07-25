import { test, expect } from '@playwright/test';

// #427 in a real browser: the Library projection and the DECOUPLED star.
// Before #427 this spec drove the opposite contract — the star minted a tile and
// removing that tile cleared the star. Both directions are gone: membership is an
// explicit reference to a query the member owns, and a favourite is a Library
// preference. happy-dom cannot see the projection wired through the real
// repository and IndexedDB, which is what this exercises.
test('the Library hides owned copies, and the star never changes membership', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto('/tests/e2e/dashboard-membership.html');
  await page.waitForTimeout(250);
  expect(pageErrors).toEqual([]);
  await page.waitForFunction(() => window.__ready === true);

  // The Dashboard-owned copy is absent from the Library, which shows exactly one
  // row — and the count agrees with it.
  await expect(page.locator('.saved-row')).toHaveCount(1);
  await expect(page.locator('.side-tab').first()).toContainText('Library');
  await expect(page.locator('.side-count')).toHaveText('· 1');

  // Starring writes the flag and adds NO tile to the Dashboard.
  await page.locator('.sv-star[title="Favorite"]').click();
  await page.waitForFunction(async () => (await window.__workspace()).queries[0].spec.favorite === true);
  let workspace = await page.evaluate(() => window.__workspace());
  expect(workspace.queries[0].spec.favorite).toBe(true);
  expect(workspace.dashboards[0].tiles).toHaveLength(1);
  expect(workspace.dashboards[0].tiles[0].queryId).toBe('q1-owned');
  expect(workspace.dashboards[0].revision).toBe(1);
  // The starred query is still a LIBRARY query — starring did not make it a member.
  await expect(page.locator('.saved-row')).toHaveCount(1);

  // Removing the tile in the Dashboard leaves the Library query's flag alone.
  await page.getByRole('button', { name: 'Open Dashboard' }).click();
  expect(pageErrors).toEqual([]);
  await expect(page.locator('.dash-tile-body')).toContainText('1');
  await page.getByRole('button', { name: 'Remove Revenue from the dashboard' }).click();
  await page.waitForFunction(async () => (await window.__workspace()).dashboards[0].tiles.length === 0);
  workspace = await page.evaluate(() => window.__workspace());
  expect(workspace.queries[0].spec.favorite).toBe(true);
  expect(workspace.dashboards[0].revision).toBe(2);

  // The formerly owned copy has no owner now, so it joins the Library — the
  // projection follows committed Dashboard content, not a stored flag.
  await page.reload();
  await page.waitForFunction(() => window.__ready === true);
  await expect(page.locator('.saved-row')).toHaveCount(2);
  await expect(page.locator('.sv-star').first()).toHaveClass(/\bon\b/);
});
