import { test, expect } from '@playwright/test';

// CM6 adapter behaviors that need a real engine (#21): keyboard-driven
// highlighting, the ⌘↵-never-swallowed acceptance rule, per-tab undo across
// syncFromState, and the search panel. (The old editor-alignment.spec.js
// guarded the textarea/pre scroll-sync bug class — CM6 has one scroll
// container, so that class of bug is structurally gone.)

test.describe('CM6 editor', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/tests/e2e/editor.html');
    await page.waitForFunction(() => window.__ready === true);
    await page.click('.cm-content');
  });

  test('typing paints SQL highlighting through the .sql-* classes', async ({ page }) => {
    await page.keyboard.type('select sum(x) from t -- note');
    await expect(page.locator('.cm-content .sql-keyword').first()).toHaveText('select');
    await expect(page.locator('.cm-content .sql-func').first()).toHaveText('sum');
    await expect(page.locator('.cm-content .sql-comment').first()).toHaveText('-- note');
  });

  test('typing opens completion; ⌘↵ is never swallowed by it (bubbles to the document)', async ({ page }) => {
    await page.evaluate(() => {
      window.__chords = [];
      document.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
          window.__chords.push({ prevented: e.defaultPrevented, shift: e.shiftKey });
        }
      });
    });
    await page.keyboard.type('sel');
    await expect(page.locator('.cm-tooltip-autocomplete')).toBeVisible();
    await page.keyboard.press('Control+Enter'); // the run chord, completion still open
    const chords = await page.evaluate(() => window.__chords);
    expect(chords).toEqual([{ prevented: false, shift: false }]); // reached the global handler, unprevented
    const value = await page.evaluate(() => window.__app.dom.editorView.state.doc.toString());
    expect(value).toBe('sel'); // no blank line inserted, no completion accepted
  });

  test('Enter accepts an open completion (parity with the old dropdown)', async ({ page }) => {
    await page.keyboard.type('sel');
    // wait for a *selected* option, then sit out CM6's interactionDelay —
    // an Enter within ~75ms of the list opening is deliberately ignored
    // (accidental-accept guard); automation is fast enough to hit it.
    await expect(page.locator('.cm-tooltip-autocomplete li[aria-selected]')).toBeVisible();
    await page.waitForTimeout(150);
    await page.keyboard.press('Enter');
    const value = await page.evaluate(() => window.__app.dom.editorView.state.doc.toString());
    expect(value.toUpperCase()).toBe('SELECT');
  });

  test('auto-pairing: pairs in code, steps over closers, stays quiet inside literals', async ({ page }) => {
    await page.keyboard.type('select (');   // ( pairs in code
    await page.keyboard.type(')');          // typing the closer steps over, no double
    await page.keyboard.type(" '");         // quote pairs in code
    await page.keyboard.type('a(');         // ( inside the string must NOT inject a stray )
    const value = await page.evaluate(() => window.__app.dom.editorView.state.doc.toString());
    expect(value).toBe("select () 'a('");
  });

  test('tab switches keep per-tab undo histories', async ({ page }) => {
    const doc = () => window.__app.dom.editorView.state.doc.toString();
    const switchTab = (id) => {
      window.__app.state.activeTabId.value = id;
      window.__port.syncFromState();
    };
    await page.keyboard.type('one');
    await page.evaluate(() => {
      const { state } = window.__app;
      state.tabs.value = [...state.tabs.value, { id: 't2', name: 'T2', sql: '', dirty: false, result: null, savedId: null, chartCfg: null, chartKey: null }];
      state.activeTabId.value = 't2';
      window.__port.syncFromState();
    });
    await page.click('.cm-content');
    await page.keyboard.type('two');
    // round-trip t2 → t1 → t2, THEN undo: only a parked per-tab history can
    // undo the 'two' typing here — a fresh-state impostor would leave 'two'.
    await page.evaluate(`(${switchTab.toString()})('t1')`);
    const t1 = await page.evaluate(doc);
    expect(t1).toBe('one');
    await page.evaluate(`(${switchTab.toString()})('t2')`);
    await page.click('.cm-content');
    await page.keyboard.press('Control+z');
    const t2AfterUndo = await page.evaluate(doc);
    expect(t2AfterUndo).toBe(''); // t2's history survived the round trip
    await page.evaluate(`(${switchTab.toString()})('t1')`);
    expect(await page.evaluate(doc)).toBe('one'); // t1 untouched by t2's undo
  });

  test('⌘F opens the app-styled search panel; Esc closes it', async ({ page }) => {
    await page.keyboard.press('Control+f');
    await expect(page.locator('.cm-panel.cm-search')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.cm-panel.cm-search')).toHaveCount(0);
  });
});
