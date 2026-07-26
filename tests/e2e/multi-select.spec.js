import { test, expect } from '@playwright/test';

// Real-browser regressions for the restored Array(T) multi-select. happy-dom has
// no :focus-visible, no computed box, and no native Tab traversal, so these two
// concerns can only be checked in a real engine.
//
// The #439 busy/`reclaimFocus` describe from the original #189 suite is gone with
// the feature it drove: this control has no per-field busy state (a variable's
// only failure is the batch's, and `setUnavailable` closes the popover outright
// rather than making it noninteractive). `popover.test.ts` still covers
// `reclaimFocus` at the primitive level for the time-range consumer.

const open = async (page) => {
  await page.getByRole('button', { name: 'city variable, 0 selected' }).click();
  await expect(page.getByRole('dialog', { name: 'city options' })).toBeVisible();
};

test.describe('Multi-select keyboard traversal', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/tests/e2e/multi-select.html');
    await page.waitForFunction(() => window.__ready === true);
  });

  // The shared anchored-dialog focus trap must own every Tab/Shift+Tab
  // transition rather than delegate middle-of-list traversal to the browser
  // (WebKit's default "Tab highlights every item" preference is OFF, so native
  // traversal there can skip checkboxes/buttons entirely). This proves the real
  // multi-select consumer sequence in every engine, not just the primitive in
  // isolation (see popover.test.ts for the unit-level coverage).
  test('Tab traverses the real control sequence in DOM order, reaches Apply, and wraps both ways', async ({ page }) => {
    await open(page);
    const dialog = page.getByRole('dialog', { name: 'city options' });

    const search = page.getByPlaceholder('Search city options');
    const selectVisible = page.locator('.ms-select-all-cb');
    const optionCb = page.locator('.ms-option input[type="checkbox"]').first();
    const clear = page.getByRole('button', { name: 'Clear', exact: true });
    const cancel = page.getByRole('button', { name: 'Cancel', exact: true });
    const apply = page.getByRole('button', { name: 'Apply', exact: true });

    // Initial focus lands on Search.
    await expect(search).toBeFocused();

    // Ordinary Tab visits every declared control, in order, ending on Apply.
    for (const next of [selectVisible, optionCb, clear, cancel, apply]) {
      await page.keyboard.press('Tab');
      await expect(next).toBeFocused();
      const inDialog = await dialog.evaluate((d) => d.contains(document.activeElement));
      expect(inDialog).toBe(true);
    }

    // Apply reached via ordinary Tab visibly matches :focus-visible.
    expect(await apply.evaluate((el) => el.matches(':focus-visible'))).toBe(true);
    expect(await apply.evaluate((el) => getComputedStyle(el).outlineStyle)).not.toBe('none');

    // One more Tab wraps forward to Search; Shift+Tab wraps back to Apply.
    await page.keyboard.press('Tab');
    await expect(search).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(apply).toBeFocused();
  });

  // Escape is a Cancel on every engine, and focus must return to the trigger
  // rather than fall through to <body> behind the dismissed modal.
  test('Escape closes as a Cancel and returns focus to the trigger', async ({ page }) => {
    await open(page);
    await page.locator('.ms-option input[type="checkbox"]').first().check();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'city options' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'city variable, 0 selected' })).toBeFocused();
    // The draft was discarded — the trigger still reads unset.
    await expect(page.locator('.ms-trigger')).toHaveText('Not set');
  });

  // A row hidden by the search filter must be genuinely unfocusable, not merely
  // visually gone — otherwise Tab lands on an invisible checkbox.
  test('a search-hidden option row is skipped by Tab', async ({ page }) => {
    await open(page);
    await page.getByPlaceholder('Search city options').fill('zzz');
    await expect(page.locator('.ms-option')).toBeHidden();
    await page.keyboard.press('Tab'); // Select visible
    await page.keyboard.press('Tab'); // would be the option row, if it were focusable
    await expect(page.getByRole('button', { name: 'Clear', exact: true })).toBeFocused();
  });
});

test.describe('Multi-select Apply action states (#386)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/tests/e2e/multi-select.html');
    await page.waitForFunction(() => window.__ready === true);
  });

  // The multiselect's Apply and the time-range popover's share one selector list
  // in styles.css; this pins that the shared rule actually resolves for the
  // `.ms-` half, in both themes.
  for (const theme of ['dark', 'light']) {
    test(`keeps enabled, hover, disabled, focus, and pressed Apply states distinct in ${theme} theme`, async ({ page }) => {
      await page.locator('body').evaluate((el, nextTheme) => { el.dataset.theme = nextTheme; }, theme);
      await open(page);

      const apply = page.getByRole('button', { name: 'Apply', exact: true });
      const disabled = page.getByRole('button', { name: 'Disabled Apply', exact: true });
      const styles = (target) => target.evaluate((el) => {
        const css = getComputedStyle(el);
        return { background: css.backgroundColor, color: css.color, outline: css.outlineStyle, transform: css.transform };
      });

      const enabled = await styles(apply);
      expect(enabled.background).not.toBe('rgba(0, 0, 0, 0)');
      await apply.hover();
      const hovered = await styles(apply);
      expect(hovered.background).not.toBe(enabled.background);
      expect(await styles(disabled)).not.toEqual(hovered);

      // Enter focus through keyboard navigation so :focus-visible is the state
      // under test; programmatic focus intentionally does not promise that
      // modality in browsers. The shared focus trap owns every transition
      // deterministically, so the bounded loop is only a defensive bound.
      for (let i = 0; i < 10 && !(await apply.evaluate((el) => el === document.activeElement)); i++) {
        await page.keyboard.press('Tab');
      }
      await expect(apply).toBeFocused();
      expect(await apply.evaluate((el) => el.matches(':focus-visible'))).toBe(true);
      expect((await styles(apply)).outline).not.toBe('none');

      const box = await apply.boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      expect((await styles(apply)).transform).not.toBe('none');
      await page.mouse.up();
    });
  }
});
