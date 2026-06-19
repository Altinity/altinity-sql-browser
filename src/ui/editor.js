// The SQL editor: a textarea overlaid on a syntax-highlighted <pre>, with a
// line-number gutter. Highlighting reuses the pure tokenizer in core.

import { h } from './dom.js';
import { tokenize } from '../core/sql-highlight.js';
import { activeTab } from '../state.js';

// dataTransfer MIME used when dragging a schema identifier onto the editor.
// A dedicated type (not text/plain) scopes the drop handler to schema-tree
// drags, leaving native text drag-within-the-textarea untouched.
export const IDENT_MIME = 'application/x-asb-identifier';

/** Paint tokenized SQL into `preEl` (whitespace as text, tokens as spans). */
export function renderHighlightInto(preEl, sql) {
  preEl.replaceChildren();
  for (const [t, v] of tokenize(sql)) {
    if (t === 'ws') {
      preEl.appendChild(document.createTextNode(v));
    } else {
      const sp = document.createElement('span');
      sp.className = 'sql-' + t;
      sp.textContent = v;
      preEl.appendChild(sp);
    }
  }
  preEl.appendChild(document.createTextNode('\n'));
}

function gutterLines(sql) {
  const count = sql.split('\n').length;
  return Array.from({ length: count }, (_, i) => h('div', null, String(i + 1)));
}

/**
 * Mount the editor into `container`. Registers app.dom.editor* refs and an
 * app.dom.editorSync() that re-reads the active tab into the view.
 */
export function mountEditor(app, container) {
  const gutter = h('div', { class: 'sql-gutter' });
  const pre = document.createElement('pre');
  pre.className = 'sql-pre';
  const ta = document.createElement('textarea');
  ta.className = 'sql-textarea';
  ta.spellcheck = false;
  const area = h('div', { class: 'sql-area' }, pre, ta);
  container.replaceChildren(h('div', { class: 'sql-editor' }, gutter, area));

  const paint = (sql) => {
    renderHighlightInto(pre, sql);
    gutter.replaceChildren(...gutterLines(sql));
  };
  const sync = () => {
    const tab = activeTab(app.state);
    ta.value = tab.sql;
    paint(tab.sql);
  };

  ta.addEventListener('input', () => {
    const tab = activeTab(app.state);
    tab.sql = ta.value;
    tab.dirty = true;
    paint(ta.value);
    app.actions.rerenderTabs();
    app.actions.updateStar();
  });
  ta.addEventListener('scroll', () => {
    pre.scrollTop = ta.scrollTop;
    pre.scrollLeft = ta.scrollLeft;
    gutter.scrollTop = ta.scrollTop;
  });
  ta.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    e.preventDefault();
    const { selectionStart: s, selectionEnd: en } = ta;
    ta.value = ta.value.slice(0, s) + '  ' + ta.value.slice(en);
    ta.selectionStart = ta.selectionEnd = s + 2;
    ta.dispatchEvent(new Event('input'));
  });
  // Accept schema identifiers dragged from the tree; insert at the cursor.
  ta.addEventListener('dragover', (e) => e.preventDefault());
  ta.addEventListener('drop', (e) => {
    const text = e.dataTransfer && e.dataTransfer.getData(IDENT_MIME);
    if (!text) return; // not our drag — leave native behavior alone
    e.preventDefault();
    insertAtCursor(app, text);
  });

  app.dom.editorTextarea = ta;
  app.dom.editorPre = pre;
  app.dom.editorGutter = gutter;
  app.dom.editorSync = sync;
  sync();
}

/** Insert `text` at the textarea cursor and fire an input event. */
export function insertAtCursor(app, text) {
  const ta = app.dom.editorTextarea;
  if (!ta) return;
  const { selectionStart: s, selectionEnd: e } = ta;
  ta.value = ta.value.slice(0, s) + text + ta.value.slice(e);
  ta.selectionStart = ta.selectionEnd = s + text.length;
  ta.focus();
  ta.dispatchEvent(new Event('input'));
}
