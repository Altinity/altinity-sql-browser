import { test, expect } from '@playwright/test';

test.describe('Multi-select keyboard traversal (#439)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/tests/e2e/multi-select.html');
    await page.waitForFunction(() => window.__ready === true);
  });

  // The shared anchored-dialog focus trap must own every Tab/Shift+Tab
  // transition rather than delegate middle-of-list traversal to the browser
  // (WebKit's default "Tab highlights every item" preference is OFF, so
  // native traversal there can skip checkboxes/buttons entirely). This proves
  // the real multi-select consumer sequence in every engine, not just the
  // primitive in isolation (see popover.test.ts for the unit-level coverage).
  test('Tab traverses the real control sequence in DOM order, reaches Apply, and wraps in both directions', async ({ page }) => {
    await page.getByRole('button', { name: 'City filter, 0 selected' }).click();

    const dialog = page.getByRole('dialog', { name: 'City options' });
    await expect(dialog).toBeVisible();

    const search = page.getByPlaceholder('Search City options');
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
    const applyOutline = await apply.evaluate((el) => getComputedStyle(el).outlineStyle);
    expect(applyOutline).not.toBe('none');

    // One more Tab wraps forward to Search; Shift+Tab wraps back to Apply.
    await page.keyboard.press('Tab');
    await expect(search).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(apply).toBeFocused();
  });

  // Entering the busy state disables every row except Cancel. Disabling the
  // CURRENTLY FOCUSED row natively blurs it out of the dialog entirely (to
  // <body>) rather than to another element — the shared Tab trap is
  // dialog-scoped, so an ordinary Tab press right after would never reach it,
  // and focus could escape the modal. `reclaimFocus()` closes that gap by
  // moving focus onto Cancel (the one row the busy toggle never disables) the
  // moment the eviction happens. This must hold for every row that can be
  // legitimately focused before the loading state lands.
  test('a control disabled by the busy state is reclaimed onto Cancel, and traversal stays trapped', async ({ page }) => {
    await page.getByRole('button', { name: 'City filter, 0 selected' }).click();
    const dialog = page.getByRole('dialog', { name: 'City options' });
    await expect(dialog).toBeVisible();

    const search = page.getByPlaceholder('Search City options');
    const selectVisible = page.locator('.ms-select-all-cb');
    const optionCb = page.locator('.ms-option input[type="checkbox"]').first();
    const clear = page.getByRole('button', { name: 'Clear', exact: true });
    const cancel = page.getByRole('button', { name: 'Cancel', exact: true });
    const apply = page.getByRole('button', { name: 'Apply', exact: true });

    for (const focusTarget of [search, selectVisible, optionCb, clear, apply]) {
      // Reset to an interactive state before each focus + eviction round.
      await page.evaluate(() => window.__field.updateStatus({ status: 'ready' }));
      await focusTarget.focus();
      await expect(focusTarget).toBeFocused();

      await page.evaluate(() => window.__field.updateStatus({ status: 'loading' }));
      // Reclaimed onto Cancel — never left on the page behind the modal.
      await expect(cancel).toBeFocused();
      const inDialog = await dialog.evaluate((d) => d.contains(document.activeElement));
      expect(inDialog).toBe(true);
    }

    // While busy, every OTHER row is disabled (excluded from the eligible
    // set), so Tab/Shift+Tab from Cancel — the only eligible row — cannot
    // leave the dialog: the single-element case keeps it in place.
    await page.keyboard.press('Tab');
    await expect(cancel).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(cancel).toBeFocused();

    // Re-enabling restores ordinary traversal through the freshly recomputed
    // eligible set: from Cancel, the next declared row is Apply again.
    await page.evaluate(() => window.__field.updateStatus({ status: 'ready' }));
    await page.keyboard.press('Tab');
    await expect(apply).toBeFocused();
  });
});

test.describe('Multi-select Apply action states (#386)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/tests/e2e/multi-select.html');
    await page.waitForFunction(() => window.__ready === true);
  });

  for (const theme of ['dark', 'light']) {
    test(`keeps enabled, hover, disabled, focus, and pressed Apply states distinct in ${theme} theme`, async ({ page }) => {
      await page.locator('body').evaluate((el, nextTheme) => { el.dataset.theme = nextTheme; }, theme);
      await page.getByRole('button', { name: 'City filter, 0 selected' }).click();

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

      // Enter focus through keyboard navigation so :focus-visible is the
      // state under test; programmatic focus intentionally does not promise
      // that modality in browsers. The shared focus trap (#439) now owns
      // every transition deterministically, so a bounded loop still applies
      // only as a defensive bound — it must terminate well before 10 presses.
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
