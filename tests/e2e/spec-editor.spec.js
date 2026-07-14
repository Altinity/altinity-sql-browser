import { test, expect } from '@playwright/test';

const platformModifier = (page) => page.evaluate(() => /Mac/.test(navigator.platform) ? 'Meta' : 'Control');

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
    await page.keyboard.press(`${await platformModifier(page)}+f`);
    await expect(spec.locator('.cm-panel.cm-search')).toBeVisible();
    await page.keyboard.press('Escape');

    const foldMarker = spec.locator('.cm-foldGutter [title="Fold line"]').first();
    await foldMarker.click();
    await expect(spec.locator('.cm-foldPlaceholder')).toBeVisible();

    await page.evaluate(() => window.__specPort.revealOffset(window.__specPort.getValue().length));
    await spec.locator('.cm-content').click();
    await page.keyboard.type(' ');
    expect(await page.evaluate(() => window.__specPort.getValue())).toBe(json + ' ');
    await page.keyboard.press(`${await platformModifier(page)}+z`);
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

  test('uses native schema completion for typing, keyboard acceptance, branch keys, and escape', async ({ page }) => {
    const spec = page.locator('#spec-host');
    const popup = spec.locator('.cm-tooltip-autocomplete');
    await page.evaluate(() => {
      window.__specPort.replaceDocument('{\n  "');
      window.__specPort.revealOffset(5);
    });
    await page.keyboard.type('pa');
    await expect(popup).toBeVisible();
    await expect(popup.locator('li')).toHaveCount(1);
    await expect(popup.locator('li').first()).toContainText('panel');
    await page.waitForTimeout(100); // CM ignores acceptance during its short interaction guard.
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => window.__specPort.getValue())).toBe('{\n  "panel": {}');
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => window.__specPort.getValue())).toBe('{\n  "panel": {  }');

    const variant = '{"panel":{"cfg":{"type":""}}}';
    await page.evaluate((text) => {
      window.__specPort.replaceDocument(text);
      window.__specPort.revealOffset(text.indexOf('""') + 1);
    }, variant);
    await page.keyboard.type('l');
    await expect(popup).toBeVisible();
    await expect(popup).toContainText('line');
    await expect(popup).toContainText('logs');
    await page.waitForTimeout(100);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('Enter');
    expect(await page.evaluate(() => window.__specPort.getValue()))
      .toBe('{"panel":{"cfg":{"type":"line"}}}');

    const branch = '{"panel":{"cfg":{"type":"line",""}}}';
    await page.evaluate((text) => {
      window.__specPort.replaceDocument(text);
      window.__specPort.revealOffset(text.lastIndexOf('""') + 1);
    }, branch);
    await page.keyboard.press('Control+Space');
    await expect(popup).toBeVisible();
    await expect(popup).toContainText('x');
    await expect(popup).toContainText('y');
    await expect(popup).toContainText('series');
    await expect(popup).not.toContainText('time');
    await page.waitForTimeout(100);
    await page.keyboard.press('Escape');
    await expect(popup).toBeHidden();
  });

  test('keeps completion popup and documentation readable in both themes', async ({ page }) => {
    const spec = page.locator('#spec-host');
    const popup = spec.locator('.cm-tooltip-autocomplete');
    const themes = [
      ['dark', { background: 'rgb(26, 26, 32)', foreground: 'rgb(230, 230, 232)', border: 'rgb(31, 31, 38)' }],
      ['light', { background: 'rgb(255, 255, 255)', foreground: 'rgb(26, 26, 31)', border: 'rgb(229, 227, 222)' }],
    ];
    for (const [theme, expected] of themes) {
      await page.evaluate(({ theme: nextTheme }) => {
        document.body.dataset.theme = nextTheme;
        window.__specPort.replaceDocument('{"fa"}');
        window.__specPort.revealOffset(4);
      }, { theme });
      await page.keyboard.press('Control+Space');
      await expect(popup).toBeVisible();
      await expect(popup.locator('.cm-completionInfo')).toBeVisible();
      const styles = await popup.evaluate((node) => {
        const popupStyle = getComputedStyle(node);
        const selectedStyle = getComputedStyle(node.querySelector('li[aria-selected]'));
        const infoStyle = getComputedStyle(node.querySelector('.cm-completionInfo'));
        return {
          background: popupStyle.backgroundColor,
          foreground: selectedStyle.color,
          border: popupStyle.borderTopColor,
          infoBackground: infoStyle.backgroundColor,
        };
      });
      expect(styles).toEqual({ ...expected, infoBackground: expected.background });
      await page.keyboard.press('Escape');
      await expect(popup).toBeHidden();
    }
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
});
