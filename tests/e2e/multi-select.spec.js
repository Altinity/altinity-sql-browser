import { test, expect } from '@playwright/test';

test.describe('Multi-select Apply action states (#386)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/tests/e2e/multi-select.html');
    await page.waitForFunction(() => window.__ready === true);
  });

  for (const theme of ['dark', 'light']) {
    test(`keeps enabled, hover, disabled, focus, and pressed Apply states distinct in ${theme} theme`, async ({ page }) => {
      await page.locator('body').evaluate((el, nextTheme) => { el.dataset.theme = nextTheme; }, theme);
      await page.getByRole('button', { name: 'City filter, 0 selected' }).click();

      const apply = page.getByRole('button', { name: 'Apply' });
      const disabled = page.getByRole('button', { name: 'Disabled Apply' });
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

      await apply.focus();
      expect((await styles(apply)).outline).not.toBe('none');

      const box = await apply.boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      expect((await styles(apply)).transform).not.toBe('none');
      await page.mouse.up();
    });
  }
});
