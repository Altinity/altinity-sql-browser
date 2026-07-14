import { test, expect } from '@playwright/test';

test.describe('Spec JSON editor', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/tests/e2e/editor.html');
    await page.waitForFunction(() => window.__ready === true);
    await page.evaluate(() => window.__showSpec());
  });

  test('highlights JSON, searches locally, folds objects, and keeps undo local', async ({ page }) => {
    const json = '{\n  "name": "Query",\n  "favorite": false,\n  "panel": {\n    "cfg": { "type": "bar", "limit": 10 }\n  }\n}';
    await page.evaluate((text) => window.__specPort.replaceDocument(text), json);
    const spec = page.locator('#spec-host');
    await expect(spec.locator('.sql-ident').filter({ hasText: 'name' })).toBeVisible();
    await expect(spec.locator('.sql-keyword').filter({ hasText: 'false' })).toBeVisible();
    await expect(spec.locator('.sql-number').filter({ hasText: '10' })).toBeVisible();

    await spec.locator('.cm-content').click();
    await page.keyboard.press('Control+f');
    await expect(spec.locator('.cm-panel.cm-search')).toBeVisible();
    await page.keyboard.press('Escape');

    const foldMarker = spec.locator('.cm-foldGutter [title="Fold line"]').first();
    await foldMarker.click();
    await expect(spec.locator('.cm-foldPlaceholder')).toBeVisible();

    await page.evaluate(() => window.__specPort.revealOffset(window.__specPort.getValue().length));
    await spec.locator('.cm-content').click();
    await page.keyboard.type(' ');
    expect(await page.evaluate(() => window.__specPort.getValue())).toBe(json + ' ');
    await page.keyboard.press('Control+z');
    expect(await page.evaluate(() => window.__specPort.getValue())).toBe(json);
  });

  test('marks and navigates to a semantic diagnostic by exact JSON path', async ({ page }) => {
    const json = '{"panel":{"cfg":{"type":"unknown"}}}';
    await page.evaluate((text) => {
      window.__specPort.replaceDocument(text);
      window.__specPort.setDiagnostics([{
        path: ['panel', 'cfg', 'type'], severity: 'error',
        code: 'invalid-panel-type', message: 'Unknown panel type',
      }]);
      window.__specPort.revealDiagnostic(0);
    }, json);
    const marker = page.locator('#spec-host [data-code="invalid-panel-type"]');
    await expect(marker).toHaveText('"unknown"');
    expect(await page.evaluate(() => window.__app.dom.specEditorView.state.selection.main.head))
      .toBe(json.indexOf('"unknown"'));
  });

  test('Spec toolbar hidden controls stay visually absent in the real CSS cascade', async ({ page }) => {
    const toolbar = page.locator('#spec-toolbar-probe');
    for (const label of ['Run', 'SQL Format', 'Explain', 'Export', 'Share']) {
      await expect(toolbar.getByRole('button', { name: label, exact: true })).toBeHidden();
    }
    for (const label of ['Format', 'Save']) {
      await expect(toolbar.getByRole('button', { name: label, exact: true })).toBeVisible();
    }
    await expect(toolbar.locator('.editor-mode-switch')).toBeVisible();
  });

  test('completes schema properties and current result columns through the CodeMirror keyboard UI', async ({ page }) => {
    const spec = page.locator('#spec-host');
    await page.evaluate(() => window.__specPort.replaceDocument('{\n  "pa'));
    await page.keyboard.press('Control+Space');
    await expect(spec.locator('.cm-tooltip-autocomplete')).toContainText('panel');
    await spec.locator('.cm-tooltip-autocomplete li').filter({ hasText: 'panel' }).click();
    await expect.poll(() => page.evaluate(() => window.__specPort.getValue())).toContain('"panel": {"cfg":{"type":""}}');

    await page.evaluate(() => {
      window.__app.state.tabs.value[0].result = { columns: [{ name: 'message', type: 'String' }] };
      window.__specPort.replaceDocument('{"panel":{"cfg":{"type":"logs","msg":"');
    });
    await page.keyboard.press('Control+Space');
    await expect(spec.locator('.cm-tooltip-autocomplete')).toContainText('message');
    await spec.locator('.cm-tooltip-autocomplete li').filter({ hasText: 'message' }).click();
    await expect.poll(() => page.evaluate(() => window.__specPort.getValue())).toContain('"msg":"message"');
  });
});
