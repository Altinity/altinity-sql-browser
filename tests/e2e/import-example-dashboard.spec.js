import { test, expect } from '@playwright/test';

// #506 — the File-menu "Import example dashboard…" flow, in a real browser:
// happy-dom cannot drive a real IndexedDB-backed workspace commit end to end
// the way this fixture does, and the dialog's disabled/enabled Import button
// is exactly the kind of real-DOM state the unit suite already covers at the
// DOM-simulation level — this is the first genuine Playwright spec for the
// File menu (no prior e2e coverage existed for it; see #506 dev notes).

const open = async (page) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/tests/e2e/import-example-dashboard.html');
  await page.waitForFunction(() => window.__ready === true);
};

const openExampleDialog = async (page) => {
  await page.locator('.hd-file-btn').click();
  await page.locator('.file-menu .fm-item', { hasText: 'Import example dashboard…' }).click();
};

const radio = (page, name) => page.locator('.fm-dialog-card [role="radio"]', { hasText: name });

test.describe('File ▾ Import example dashboard (#506)', () => {
  test('lists the catalogue by name, Import disabled until a row is selected', async ({ page }) => {
    await open(page);
    await openExampleDialog(page);
    const dialog = page.locator('.fm-dialog-card');
    await expect(dialog).toContainText('Import example dashboard');
    await expect(page.locator('.fm-dialog-card [role="radio"]')).toHaveCount(3);
    await expect(radio(page, 'ClickHouse Operations')).toBeVisible();
    await expect(radio(page, 'Shop Charts')).toBeVisible();
    await expect(radio(page, 'OnTime Charts')).toBeVisible();
    const importBtn = page.locator('.fm-dialog-confirm');
    await expect(importBtn).toBeDisabled();
    await radio(page, 'Shop Charts').click();
    await expect(importBtn).toBeEnabled();
    await expect(radio(page, 'Shop Charts')).toHaveAttribute('aria-checked', 'true');
  });

  test('Cancel leaves the workspace unchanged', async ({ page }) => {
    await open(page);
    await openExampleDialog(page);
    await radio(page, 'Shop Charts').click();
    await page.locator('.fm-dialog-cancel').click();
    await expect(page.locator('.fm-dialog-card')).toHaveCount(0);
    const workspace = await page.evaluate(() => window.__committed());
    expect(workspace.dashboards.map((d) => d.title)).toEqual(['Existing dashboard']);
  });

  test('Escape leaves the workspace unchanged', async ({ page }) => {
    await open(page);
    await openExampleDialog(page);
    await radio(page, 'OnTime Charts').click();
    await page.keyboard.press('Escape');
    await expect(page.locator('.fm-dialog-card')).toHaveCount(0);
    const workspace = await page.evaluate(() => window.__committed());
    expect(workspace.dashboards.map((d) => d.title)).toEqual(['Existing dashboard']);
  });

  test('Import appends the selected example beside the existing Dashboard and opens it', async ({ page }) => {
    await open(page);
    await openExampleDialog(page);
    await radio(page, 'Shop Charts').click();
    await page.locator('.fm-dialog-confirm').click();
    await expect(page.locator('.fm-dialog-card')).toHaveCount(0);
    await expect(page.locator('.share-toast')).toContainText('Imported dashboard');
    const workspace = await page.evaluate(() => window.__committed());
    // The existing Dashboard survives byte-for-byte; the import appends
    // (never replaces or merges) the bundle's own Dashboard title.
    expect(workspace.dashboards.map((d) => d.title)).toEqual(['Existing dashboard', 'Shop analytics']);
    const opened = await page.evaluate(() => window.__opened);
    expect(opened).toHaveLength(1);
    expect(opened[0].mode).toBe('edit');
    expect(opened[0].dashboardId).toBe(workspace.dashboards[1].id);
  });
});
