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
    // Example fences render through the read-only viewer (no Copy buttons —
    // owner decision at the #320 gate).
    await expect(pane.locator('.docs-examples .cm-editor, .docs-examples pre').first()).toBeVisible();
    expect(await pane.locator('.docs-md-copy, .docs-copy').count()).toBe(0);
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

  test('Escape closes the pane from ANYWHERE — focus still in the editor (#60 live finding)', async ({ page }) => {
    // Set the doc PROGRAMMATICALLY: CM6 only auto-opens completion on
    // user-typed input, and its popup materializes ~100ms after a keystroke —
    // an isVisible() guard races it (the popup then swallows the Escape:
    // completion → pane → query is the designed layering). No typing, no
    // popup, so the single Escape below is deterministically the pane's.
    await page.evaluate(() => {
      const view = window.__app.dom.sqlEditorView;
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: 'sum' }, selection: { anchor: 3 } });
    });
    await page.keyboard.press('F1');
    const pane = page.locator('[role="complementary"]');
    await expect(pane).toBeVisible();
    expect(await page.locator('.cm-tooltip-autocomplete').count()).toBe(0); // no popup in play
    // Focus never left the editor — Escape must close the pane regardless
    // (the global shortcut layer, not the pane's focus-inside handler).
    await page.keyboard.press('Escape');
    await expect(page.locator('[role="complementary"]')).toHaveCount(0);
  });

  test('Escape with focus inside the pane closes it without leaking to other handlers; focus returns to the editor', async ({ page }) => {
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

  test('completion info exposes the "(reference — F1)" link that opens the same pane', async ({ page }) => {
    await page.keyboard.type('sum');
    await expect(page.locator('.cm-tooltip-autocomplete li[aria-selected]')).toBeVisible();
    // The side info tooltip for the selected completion renders the shared
    // summary card with the reference link on the badges row.
    const btn = page.locator('.cm-tooltip .hover-open-ref').first();
    await expect(btn).toBeVisible();
    expect(await btn.evaluate((el) => el.tagName)).toBe('A');
    await expect(btn).toHaveText('reference');
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

  // #315 — F1's NO-STRONG-TARGET contract change: an unresolved bare word
  // (not whitespace/punctuation — those still leave F1 to the browser, see
  // "F1 with no resolvable target" above) now opens name-only disambiguation
  // instead of doing nothing. The harness's `docDisambiguate` always resolves
  // `missing` (no multi-kind fixture data), so this shows the SAME quiet
  // missing state the structured path uses — a real accessibility/keydown
  // gate that the fallback path actually opens the pane at all.
  test('F1 on an unresolved bare word now opens disambiguation, which shows the missing state', async ({ page }) => {
    await page.evaluate(() => {
      window.__f1 = [];
      document.addEventListener('keydown', (e) => {
        if (e.key === 'F1') window.__f1.push(e.defaultPrevented);
      });
    });
    await page.keyboard.type('mysteryWord');
    await page.keyboard.press('F1');
    expect(await page.evaluate(() => window.__f1)).toEqual([true]);
    const pane = page.locator('[role="complementary"]');
    await expect(pane).toBeVisible();
    await expect(pane.locator('.docs-missing')).toBeVisible();
  });

  // ── Phase 2 (#314): strong-context F1 routing + related navigation ────────

  test('F1 on a FORMAT-clause name opens format docs with capability facts', async ({ page }) => {
    await page.keyboard.type('SELECT 1 FORMAT JSONEachRow');
    await page.keyboard.press('ArrowLeft'); // caret inside the format name
    await page.keyboard.press('F1');
    const pane = page.locator('[role="complementary"]');
    await expect(pane).toBeVisible();
    await expect(pane.locator('.docs-name')).toHaveText('JSONEachRow');
    await expect(pane.locator('.docs-badge-kind')).toContainText('format');
  });

  test('F1 on ENGINE = <name> opens table-engine docs; related navigation works with Back', async ({ page }) => {
    await page.keyboard.type('CREATE TABLE t (id UInt64) ENGINE = MergeTree');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('F1');
    const pane = page.locator('[role="complementary"]');
    await expect(pane.locator('.docs-name')).toHaveText('MergeTree');
    // Related entry navigates in place; ReplacingMergeTree has no fixture,
    // so the pane shows the quiet missing state.
    await pane.getByRole('button', { name: 'ReplacingMergeTree' }).click();
    await expect(pane.locator('.docs-missing')).toBeVisible();
    // …and Back returns to the previous entry.
    await pane.getByRole('button', { name: 'Back' }).click();
    await expect(pane.locator('.docs-name')).toHaveText('MergeTree');
  });

  test('F1 on a column-definition type opens data-type docs', async ({ page }) => {
    await page.keyboard.type('CREATE TABLE t (id UInt64) ENGINE = MergeTree');
    // Move the caret onto 'UInt64' (inside the column list).
    await page.evaluate(() => {
      const view = window.__app.dom.sqlEditorView;
      const pos = view.state.doc.toString().indexOf('UInt64') + 3;
      view.dispatch({ selection: { anchor: pos } });
    });
    await page.keyboard.press('F1');
    const pane = page.locator('[role="complementary"]');
    await expect(pane.locator('.docs-name')).toHaveText('UInt64');
    await expect(pane.locator('.docs-badge-kind')).toContainText('data type');
  });
});
