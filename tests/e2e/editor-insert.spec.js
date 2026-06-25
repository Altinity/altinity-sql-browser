import { test, expect } from '@playwright/test';

// Regression guard for the schema double-click → editor insertion path, which
// funnels through applyEdit()'s document.execCommand('insertText', …) in
// editor.js. That API is Firefox-fragile on <textarea>, and users reported that
// in Firefox double-clicking a schema table did nothing and left the editor
// caret in a mess. These run on both engines (see playwright.config.js).
//
// Each case checks the textarea VALUE *and* the caret (selectionStart) — a
// silent execCommand no-op shows up as a wrong value; a botched caret shows up
// as a wrong selectionStart (the "cursor mess").

test.describe('editor insertion (schema double-click path)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/tests/e2e/editor.html');
    await page.waitForFunction(() => window.__ready === true);
  });

  test('insertAtCursor splices at the caret and leaves the caret after the text', async ({ page }) => {
    const r = await page.evaluate(() => {
      window.__setSql('SELECT  FROM t');           // caret target = index 7 (the 2nd space)
      const ta = window.__app.dom.editorTextarea;
      ta.focus();
      ta.selectionStart = ta.selectionEnd = 7;
      window.__insertAtCursor('count(*)');         // what a column/db double-click does
      return { value: ta.value, caret: ta.selectionStart, pre: window.__app.dom.editorPre.textContent };
    });
    expect(r.value).toBe('SELECT count(*) FROM t');
    expect(r.caret).toBe(15);                      // 7 + 'count(*)'.length(8)
    expect(r.pre).toContain('count(*)');           // highlight overlay stayed in sync
  });

  test('replaceEditor replaces the whole buffer and puts the caret at the end', async ({ page }) => {
    const r = await page.evaluate(() => {
      window.__setSql('old query that should go away');
      const ta = window.__app.dom.editorTextarea;
      window.__replaceEditor('SELECT * FROM t LIMIT 100');   // what a table double-click does
      return { value: ta.value, caret: ta.selectionStart, pre: window.__app.dom.editorPre.textContent };
    });
    expect(r.value).toBe('SELECT * FROM t LIMIT 100');
    expect(r.caret).toBe('SELECT * FROM t LIMIT 100'.length);
    expect(r.pre).toContain('LIMIT');
  });

  test('replaceEditor with identical text never appends (repeated Format regression)', async ({ page }) => {
    // The Format bug: re-formatting already-formatted SQL calls replaceEditor with
    // text identical to the content. execCommand('insertText') then no-ops AND
    // collapses the selection to the end, so the old change-detection fallback
    // spliced at the caret and appended a second copy each click.
    const r = await page.evaluate(() => {
      const ta = window.__app.dom.editorTextarea;
      window.__setSql('SELECT 1');
      window.__replaceEditor('SELECT\n    1\n');  // first format
      window.__replaceEditor('SELECT\n    1\n');  // idempotent re-format
      window.__replaceEditor('SELECT\n    1\n');  // and again
      return { value: ta.value };
    });
    expect(r.value).toBe('SELECT\n    1\n'); // not doubled/tripled
  });

  test('a real double-click on an outside element replaces the editor (the reported bug)', async ({ page }) => {
    // Mount a stand-in for a schema row: a separate element whose dblclick runs
    // replaceEditor synchronously — same gesture/selection context as the app,
    // where a double-click first selects the row's own text.
    await page.evaluate(() => {
      window.__setSql('previous query');
      const row = document.createElement('div');
      row.id = 'fake-schema-row';
      row.textContent = 'mytable';
      row.style.cssText = 'padding:20px;font-size:16px;user-select:text;';
      row.ondblclick = () => window.__replaceEditor('SELECT * FROM mytable LIMIT 100');
      document.body.appendChild(row);
    });
    await page.dblclick('#fake-schema-row');
    const r = await page.evaluate(() => {
      const ta = window.__app.dom.editorTextarea;
      return { value: ta.value, caret: ta.selectionStart };
    });
    expect(r.value).toBe('SELECT * FROM mytable LIMIT 100');
    expect(r.caret).toBe('SELECT * FROM mytable LIMIT 100'.length);
  });

  test('dropping a saved/history query inserts it as a ( … ) subquery (real DnD geometry)', async ({ page }) => {
    // Real DragEvent + DataTransfer over the textarea — exercises the offsetFromXY
    // geometry happy-dom can't compute. Drops a query carrying a trailing FORMAT,
    // which must be stripped, wrapped in parens, and spliced at the drop point.
    const value = await page.evaluate(() => {
      const ta = window.__app.dom.editorTextarea;
      window.__setSql('SELECT * FROM t');
      const rect = ta.getBoundingClientRect();
      const dt = new DataTransfer();
      dt.setData('application/x-asb-subquery', 'SELECT 99 FORMAT JSON');
      ta.dispatchEvent(new DragEvent('drop', {
        bubbles: true, cancelable: true, dataTransfer: dt,
        clientX: rect.left + 60, clientY: rect.top + 10,
      }));
      return ta.value;
    });
    expect(value).toContain('(\nSELECT 99\n)'); // wrapped subquery, trailing FORMAT stripped
    expect(value).not.toContain('FORMAT');
    expect(value).toContain('FROM t');          // original text preserved around it
  });
});
