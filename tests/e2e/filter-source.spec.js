import { test, expect } from '@playwright/test';

test.describe('Dashboard Filter sources', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/tests/e2e/filter-source.html');
    await page.waitForFunction(() => window.__ready === true);
  });

  test('renders the workbench option preview with its helper contract', async ({ page }) => {
    const preview = page.getByRole('main', { name: 'Workbench Filter preview' });
    // A result-grid (consistent with the Table view): # · name · options · type · example.
    await expect(preview.locator('table.res-table thead th')).toHaveText(['#', 'name', 'options', 'type', 'example']);
    const cells = preview.locator('table.res-table tbody tr td.cell');
    await expect(cells.nth(0)).toHaveText('origin');
    await expect(cells.nth(1)).toHaveText('3');
    await expect(cells.nth(2)).toHaveText('Array(Tuple(value String, label String))');
    // The interactive combobox lives in the example cell — no clear × in the preview.
    await expect(preview.getByRole('combobox')).toHaveAttribute('placeholder', 'All');
    await expect(preview.getByRole('button', { name: 'Clear origin' })).toHaveCount(0);
  });

  test('searches labels and commits only an exact returned value', async ({ page }) => {
    const dashboard = page.getByRole('main', { name: 'Dashboard curated filter' });
    const input = dashboard.getByRole('combobox');
    await expect(input).toHaveAttribute('placeholder', 'All');
    await input.fill('new');
    await expect(dashboard.getByRole('option')).toHaveCount(1);
    await expect(dashboard.getByRole('option')).toHaveText('New York');
    await dashboard.getByRole('option').click();
    await expect(input).toHaveValue('New York');
    expect(await page.evaluate(() => window.__selection)).toEqual({ value: 'JFK', active: true, commits: 1 });

    await dashboard.getByRole('button', { name: 'Clear origin' }).click();
    await expect(input).toHaveValue('');
    expect(await page.evaluate(() => window.__selection)).toEqual({ value: '', active: false, commits: 2 });
  });

  test('rejects arbitrary text and supports keyboard selection', async ({ page }) => {
    const dashboard = page.getByRole('main', { name: 'Dashboard curated filter' });
    const input = dashboard.getByRole('combobox');
    await input.fill('arbitrary');
    await input.blur();
    await expect(input).toHaveValue('');
    expect(await page.evaluate(() => window.__selection.commits)).toBe(0);

    await input.fill('Atlanta');
    await input.press('Enter');
    await expect(input).toHaveValue('Atlanta');
    expect(await page.evaluate(() => window.__selection)).toEqual({ value: 'ATL', active: true, commits: 1 });
  });
});
