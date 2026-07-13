import { test, expect } from '@playwright/test';

test.describe('read-only CodeMirror viewer', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/tests/e2e/editor.html');
    await page.waitForFunction(() => window.__ready === true);
  });

  test('mounts in a detached document, searches, wraps, and tears down', async ({ page }) => {
    await page.evaluate(() => window.__mountViewer({
      text: '{"first":1}\n{"second":2}', language: 'json', wrap: false,
    }));
    const frame = page.frames().find((candidate) => candidate !== page.mainFrame());
    const editor = frame.locator('.cm-editor');
    await expect(editor).toBeVisible();
    await expect(frame.locator('.cm-content')).toHaveAttribute('contenteditable', 'false');
    await expect(frame.locator('.cm-content')).toHaveAttribute('tabindex', '0');
    await expect(frame.locator('.cm-lineNumbers')).toBeVisible();
    expect(await page.evaluate(() => {
      const doc = window.__viewerFrame.contentDocument;
      const root = doc.querySelector('.cm-editor');
      return root.ownerDocument === doc
        && [...root.querySelectorAll('*')].every((node) => node.ownerDocument === doc);
    })).toBe(true);

    await page.evaluate(() => {
      window.__viewer.setWrap(true);
      window.__viewer.focus();
    });
    await expect(frame.locator('.cm-content')).toHaveClass(/cm-lineWrapping/);
    await page.keyboard.type('cannot edit');
    await expect(frame.locator('.cm-content')).toHaveText('{"first":1}{"second":2}');
    const modifier = await page.evaluate(() => /Mac/.test(navigator.platform) ? 'Meta' : 'Control');
    await page.keyboard.press(`${modifier}+f`);
    await expect(frame.locator('.cm-panel.cm-search')).toBeVisible();

    await page.evaluate(() => {
      window.__viewer.destroy();
      window.__viewer.destroy();
    });
    await expect(editor).toHaveCount(0);
  });
});
