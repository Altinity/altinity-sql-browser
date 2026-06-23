// The SQL editor: a textarea overlaid on a syntax-highlighted <pre>, with a
// line-number gutter. Highlighting reuses the pure tokenizer in core.

import { h } from './dom.js';
import { tokenize } from '../core/sql-highlight.js';
import { buildMarkSegments } from '../core/editor-marks.js';
import { matchBracketAt, bracketEdit } from '../core/editor-brackets.js';
import { createSearch } from './editor-search.js';
import { activeTab } from '../state.js';

// Editor layout metrics (kept in lockstep with .sql-editor in styles.css):
// integer line-height so the textarea and overlay <pre>s lay out identically.
const LINE_HEIGHT_PX = 22;
const PAD_Y = 12;

// dataTransfer MIME used when dragging a schema identifier onto the editor.
// A dedicated type (not text/plain) scopes the drop handler to schema-tree
// drags, leaving native text drag-within-the-textarea untouched.
export const IDENT_MIME = 'application/x-asb-identifier';

/**
 * Paint tokenized SQL into `preEl` (whitespace as text, tokens as spans).
 * `opts` (optional) forwards dynamic keyword/function sets to the tokenizer so
 * highlighting tracks the connected server's `system.keywords`/`functions`
 * (#25); omitted → the tokenizer's built-in sets.
 */
export function renderHighlightInto(preEl, sql, opts) {
  preEl.replaceChildren();
  for (const [t, v] of tokenize(sql, opts)) {
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
  // Mark overlay: a transparent <pre> below the token <pre>, carrying only the
  // search/bracket highlight backgrounds (#23/#24) — the token render path is
  // never touched. DOM order = paint order: overlay, then tokens, then textarea.
  const markPre = document.createElement('pre');
  markPre.className = 'sql-mark-overlay';
  markPre.setAttribute('aria-hidden', 'true');
  const pre = document.createElement('pre');
  pre.className = 'sql-pre';
  const ta = document.createElement('textarea');
  ta.className = 'sql-textarea';
  ta.spellcheck = false;
  const area = h('div', { class: 'sql-area' }, markPre, pre, ta);
  container.replaceChildren(h('div', { class: 'sql-editor' }, gutter, area));

  const paintTokens = (sql) => {
    // Highlight with the connection's reference keyword/function sets when
    // they've loaded (#25); before that, the tokenizer's built-ins.
    const ref = app.refData;
    renderHighlightInto(pre, sql, ref ? { keywords: ref.keywordSet, funcs: ref.funcSet } : undefined);
    gutter.replaceChildren(...gutterLines(sql));
  };
  // All highlight sources, aggregated for the overlay: search matches (#23) or,
  // when search is closed and the caret is collapsed, the bracket pair adjacent
  // to the caret (#24).
  const computeMarks = () => {
    const marks = search.marks();
    if (!search.isOpen() && ta.selectionStart === ta.selectionEnd) {
      const bp = matchBracketAt(ta.value, ta.selectionStart);
      if (bp) {
        marks.push({ start: bp[0], end: bp[0] + 1, cls: 'bracket' });
        marks.push({ start: bp[1], end: bp[1] + 1, cls: 'bracket' });
      }
    }
    return marks;
  };
  const paintMarks = () => {
    markPre.replaceChildren();
    for (const seg of buildMarkSegments(ta.value, computeMarks())) {
      if (seg.cls) {
        const sp = document.createElement('span');
        sp.className = 'mark-' + seg.cls;
        sp.textContent = seg.text;
        markPre.appendChild(sp);
      } else {
        markPre.appendChild(document.createTextNode(seg.text));
      }
    }
    markPre.appendChild(document.createTextNode('\n'));
  };
  const syncScroll = () => {
    pre.scrollTop = ta.scrollTop;
    pre.scrollLeft = ta.scrollLeft;
    markPre.scrollTop = ta.scrollTop;
    markPre.scrollLeft = ta.scrollLeft;
    gutter.scrollTop = ta.scrollTop;
  };
  // Set the textarea selection to a range and replace it (undoable, fires input).
  const replaceRange = (start, end, text) => {
    ta.focus();
    ta.selectionStart = start;
    ta.selectionEnd = end;
    applyEdit(ta, text);
  };
  // Apply a structural bracket edit (#24). Unlike applyEdit's
  // execCommand('insertText'), these place the caret *inside* a new pair or
  // remove both halves, which needs a direct splice — a coarser undo step than
  // typing, matching the prototype's behavior. Fires input so the rest syncs.
  const applyBracketEdit = (edit) => {
    ta.value = edit.value;
    ta.selectionStart = edit.selStart;
    ta.selectionEnd = edit.selEnd;
    ta.dispatchEvent(new Event('input'));
  };

  const search = createSearch({
    area, textarea: ta, padY: PAD_Y, lineHeightPx: LINE_HEIGHT_PX,
    replaceRange, syncScroll, repaintMarks: paintMarks,
  });

  const sync = () => {
    const tab = activeTab(app.state);
    ta.value = tab.sql;
    paintTokens(tab.sql);
    search.recompute();
    paintMarks();
  };

  ta.addEventListener('input', () => {
    const tab = activeTab(app.state);
    tab.sql = ta.value;
    tab.dirty = true;
    paintTokens(ta.value);
    search.recompute(); // text changed → refresh match positions, then overlay
    paintMarks();
    app.actions.rerenderTabs();
    app.actions.updateSaveBtn();
  });
  ta.addEventListener('scroll', syncScroll);
  ta.addEventListener('keydown', (e) => {
    // Bracket auto-close / wrap / type-over / pair-delete (#24) takes priority;
    // a non-bracket key returns null and falls through to the Tab handler.
    const edit = bracketEdit(ta.value, ta.selectionStart, ta.selectionEnd, e.key);
    if (edit) {
      e.preventDefault();
      applyBracketEdit(edit);
      return;
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      applyEdit(ta, '  ');
    }
  });
  // Caret moves (arrows, click, selection) don't fire 'input' — repaint the
  // overlay so the bracket-pair highlight (#24) tracks the caret.
  const onCaretMove = () => paintMarks();
  ta.addEventListener('keyup', onCaretMove);
  ta.addEventListener('click', onCaretMove);
  ta.addEventListener('select', onCaretMove);
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
  app.dom.editorMarkPre = markPre;
  app.dom.editorGutter = gutter;
  app.dom.editorSearch = search;
  app.dom.editorSync = sync;
  sync();
}

/**
 * Replace the textarea's current selection with `text`. Uses
 * execCommand('insertText') so the edit joins the native undo stack (⌘Z / ⌘⇧Z);
 * falls back to a manual splice + 'input' dispatch where execCommand is absent
 * (older browsers, happy-dom). execCommand fires 'input' itself, so either path
 * runs the input listener that syncs tab.sql + repaints.
 */
function applyEdit(ta, text) {
  ta.focus();
  let ok = false;
  try { ok = ta.ownerDocument.execCommand('insertText', false, text); } catch { ok = false; }
  if (ok) return;
  const { selectionStart: s, selectionEnd: e } = ta;
  ta.value = ta.value.slice(0, s) + text + ta.value.slice(e);
  ta.selectionStart = ta.selectionEnd = s + text.length;
  ta.dispatchEvent(new Event('input'));
}

/** Insert `text` at the textarea cursor (undoable). */
export function insertAtCursor(app, text) {
  const ta = app.dom.editorTextarea;
  if (!ta) return;
  applyEdit(ta, text);
}

/** Replace the whole editor content with `text` (undoable). */
export function replaceEditor(app, text) {
  const ta = app.dom.editorTextarea;
  if (!ta) return;
  ta.focus();
  ta.select();
  applyEdit(ta, text);
}
