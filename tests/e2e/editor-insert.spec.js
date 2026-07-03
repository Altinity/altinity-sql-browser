import { test, expect } from '@playwright/test';

// Regression guard for the schema double-click → editor insertion path,
// running against the CM6 adapter (#21). The execCommand fragility these
// originally guarded died with the textarea, but the behaviors are port
// acceptance: value, caret, and highlight must all land, including from a
// real dblclick gesture on an outside element (the reported Firefox bug's
// shape) and a real drag-drop with browser geometry (posAtCoords). These run
// on all engines (see playwright.config.js).

// Serialized into page.evaluate calls — reads the editor through the CM6 view.
const readEditor = () => {
  const view = window.__app.dom.editorView;
  return {
    value: view.state.doc.toString(),
    caret: view.state.selection.main.head,
    content: view.dom.querySelector('.cm-content').textContent,
  };
};

test.describe('editor insertion (schema double-click path)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/tests/e2e/editor.html');
    await page.waitForFunction(() => window.__ready === true);
  });

  test('insertAtCursor splices at the caret and leaves the caret after the text', async ({ page }) => {
    await page.evaluate(() => {
      window.__setSql('SELECT  FROM t');
      window.__app.dom.editorView.dispatch({ selection: { anchor: 7 } }); // caret at the 2nd space
      window.__insertAtCursor('count(*)');           // what a column/db double-click does
    });
    const r = await page.evaluate(readEditor);
    expect(r.value).toBe('SELECT count(*) FROM t');
    expect(r.caret).toBe(15);                        // 7 + 'count(*)'.length(8)
    expect(r.content).toContain('count(*)');         // the rendered doc stayed in sync
  });

  test('replaceEditor replaces the whole buffer and puts the caret at the end', async ({ page }) => {
    await page.evaluate(() => {
      window.__setSql('old query that should go away');
      window.__replaceEditor('SELECT * FROM t LIMIT 100'); // what a table double-click does
    });
    const r = await page.evaluate(readEditor);
    expect(r.value).toBe('SELECT * FROM t LIMIT 100');
    expect(r.caret).toBe('SELECT * FROM t LIMIT 100'.length);
    expect(r.content).toContain('LIMIT');
  });

  test('replaceEditor with identical text never appends (repeated Format regression)', async ({ page }) => {
    await page.evaluate(() => {
      window.__setSql('SELECT 1');
      window.__replaceEditor('SELECT\n    1\n');  // first format
      window.__replaceEditor('SELECT\n    1\n');  // idempotent re-format
      window.__replaceEditor('SELECT\n    1\n');  // and again
    });
    const r = await page.evaluate(readEditor);
    expect(r.value).toBe('SELECT\n    1\n'); // not doubled/tripled
  });

  test('a real double-click on an outside element replaces the editor (the reported bug)', async ({ page }) => {
    // A stand-in for a schema row: a separate element whose dblclick runs
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
    const r = await page.evaluate(readEditor);
    expect(r.value).toBe('SELECT * FROM mytable LIMIT 100');
    expect(r.caret).toBe('SELECT * FROM mytable LIMIT 100'.length);
  });

  test('dropping a saved/history query inserts it as a ( … ) subquery (real DnD geometry)', async ({ page }) => {
    // Real DragEvent + DataTransfer over the editor — exercises posAtCoords
    // geometry happy-dom can't compute. Drops a query carrying a trailing
    // FORMAT, which must be stripped, wrapped in parens, and spliced at the
    // drop point.
    const value = await page.evaluate(() => {
      const view = window.__app.dom.editorView;
      window.__setSql('SELECT * FROM t');
      const rect = view.contentDOM.getBoundingClientRect();
      const dt = new DataTransfer();
      dt.setData('application/x-asb-subquery', 'SELECT 99 FORMAT JSON');
      view.contentDOM.dispatchEvent(new DragEvent('drop', {
        bubbles: true, cancelable: true, dataTransfer: dt,
        clientX: rect.left + 60, clientY: rect.top + 10,
      }));
      return view.state.doc.toString();
    });
    expect(value).toContain('(\nSELECT 99\n)'); // wrapped subquery, trailing FORMAT stripped
    expect(value).not.toContain('FORMAT');
    expect(value).toContain('FROM t');          // original text preserved around it
  });
});
