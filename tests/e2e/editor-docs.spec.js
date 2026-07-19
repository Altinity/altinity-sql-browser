import { test, expect } from '@playwright/test';

// #313 real-browser accessibility/behavior gate: the CM6 hover/completion
// "Open reference" path, the F1 keymap command, and the persistent non-modal
// docs pane. The editor.html harness serves one canned rich entry ('sum');
// every other name resolves `missing`. Unit tests cover the same logic under
// happy-dom — this spec guards what only a real engine shows: keymap
// dispatch with real keydown semantics (F1 defaultPrevented), focus
// movement, and the pane's non-modal coexistence with a live editor.

test.describe('docs reference (#313)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/tests/e2e/editor.html');
    await page.waitForFunction(() => window.__ready === true);
    await page.click('.cm-content');
  });

  test('F1 on a known function opens the labelled complementary pane with the version-exact entry', async ({ page }) => {
    await page.keyboard.type('sum');
    await page.keyboard.press('F1');
    const pane = page.locator('[role="complementary"][aria-label="Documentation"]');
    await expect(pane).toBeVisible();
    await expect(pane.locator('.docs-name')).toHaveText('sum');
    await expect(pane.locator('.docs-signature')).toHaveText('sum(x)');
    await expect(pane.locator('.docs-badge-since')).toContainText('1.1.0');
    // Copyable example rendered through the read-only viewer.
    await expect(pane.locator('.docs-examples .docs-copy')).toBeVisible();
  });

  test('F1 with no resolvable target is left to the browser (not preventDefaulted), pane stays closed', async ({ page }) => {
    await page.evaluate(() => {
      window.__f1 = [];
      document.addEventListener('keydown', (e) => {
        if (e.key === 'F1') window.__f1.push(e.defaultPrevented);
      });
    });
    await page.keyboard.type('select '); // caret after whitespace — no word, no target
    await page.keyboard.press('F1');
    expect(await page.evaluate(() => window.__f1)).toEqual([false]);
    await expect(page.locator('[role="complementary"]')).toHaveCount(0);
  });

  test('the pane is non-modal: no backdrop, and the editor keeps accepting input while it is open', async ({ page }) => {
    await page.keyboard.type('sum');
    await page.keyboard.press('F1');
    await expect(page.locator('[role="complementary"]')).toBeVisible();
    expect(await page.locator('.cd-backdrop').count()).toBe(0);
    // Focus stays workable in the editor: keep typing.
    await page.click('.cm-content');
    await page.keyboard.type('(x)');
    const value = await page.evaluate(() => window.__app.dom.sqlEditorView.state.doc.toString());
    expect(value).toBe('sum(x)');
    await expect(page.locator('[role="complementary"]')).toBeVisible(); // still open
  });

  test('Escape inside the pane closes it and does not leak to other handlers; focus returns to the editor', async ({ page }) => {
    await page.evaluate(() => {
      window.__escapes = [];
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') window.__escapes.push(e.defaultPrevented);
      });
    });
    await page.keyboard.type('sum');
    await page.keyboard.press('F1');
    const pane = page.locator('[role="complementary"]');
    await expect(pane).toBeVisible();
    await pane.locator('.docs-close').focus();
    await page.keyboard.press('Escape');
    await expect(page.locator('[role="complementary"]')).toHaveCount(0);
    // The pane's capture-phase handler preventDefault+stopPropagation-s, so
    // the event never reaches bubble-phase document listeners at all — the
    // global Escape shortcut (cancel running query) cannot double-fire.
    expect(await page.evaluate(() => window.__escapes)).toEqual([]);
    // Focus restored to the initiating editor.
    expect(await page.evaluate(() => document.activeElement?.closest('.cm-editor') != null)).toBe(true);
  });

  test('completion info exposes a real keyboard-activatable Open reference button that opens the same pane', async ({ page }) => {
    await page.keyboard.type('sum');
    await expect(page.locator('.cm-tooltip-autocomplete li[aria-selected]')).toBeVisible();
    // The side info tooltip for the selected completion renders the shared
    // summary card with the Open reference button.
    const btn = page.locator('.cm-tooltip .hover-open-ref').first();
    await expect(btn).toBeVisible();
    expect(await btn.evaluate((el) => el.tagName)).toBe('BUTTON');
    await btn.click();
    const pane = page.locator('[role="complementary"][aria-label="Documentation"]');
    await expect(pane).toBeVisible();
    await expect(pane.locator('.docs-name')).toHaveText('sum');
  });

  test('a known function without harness docs shows the missing state, not an error', async ({ page }) => {
    await page.keyboard.type('count');
    await page.keyboard.press('F1');
    const pane = page.locator('[role="complementary"]');
    await expect(pane).toBeVisible();
    await expect(pane.locator('.docs-missing')).toBeVisible();
  });
});
