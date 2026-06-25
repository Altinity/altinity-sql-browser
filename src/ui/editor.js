// The SQL editor: a textarea overlaid on a syntax-highlighted <pre>, with a
// line-number gutter. Highlighting reuses the pure tokenizer in core.

import { h, zoomScale } from './dom.js';
import { tokenize, maskFromTokens } from '../core/sql-highlight.js';
import { buildMarkSegments } from '../core/editor-marks.js';
import { matchBracketAt, bracketEdit } from '../core/editor-brackets.js';
import { caretXY, caretLineCol, offsetFromXY } from '../core/editor-geometry.js';
import { toSubquery } from '../core/format.js';
import { createSearch } from './editor-search.js';
import { createComplete } from './editor-complete.js';
import { createIntel } from './editor-intel.js';
import { activeTab } from '../state.js';

// Editor layout metrics (kept in lockstep with .sql-editor in styles.css):
// integer line-height so the textarea and overlay <pre>s lay out identically.
const LINE_HEIGHT_PX = 22;
const PAD_Y = 12;
const PAD_X = 14;
// Width of one monospace glyph at the editor's 13px font — a constant (the font
// is fixed) used only to anchor the autocomplete popover near the caret (#26).
const CHAR_WIDTH_PX = 7.8;

// dataTransfer MIME used when dragging a schema identifier onto the editor.
// A dedicated type (not text/plain) scopes the drop handler to schema-tree
// drags, leaving native text drag-within-the-textarea untouched.
export const IDENT_MIME = 'application/x-asb-identifier';

// dataTransfer MIME for dragging a whole saved/history query onto the editor; the
// drop wraps it as a `( … )` subquery at the drop position (see the drop handler).
export const SUBQUERY_MIME = 'application/x-asb-subquery';

// dataTransfer MIME for dragging a database/table from the schema tree onto the
// results pane → render its lineage graph. Payload is JSON `{kind, db, table?}`.
export const SCHEMA_GRAPH_MIME = 'application/x-asb-schema-graph';

/**
 * Paint tokenized SQL into `preEl` (whitespace as text, tokens as spans).
 * `opts` (optional) forwards dynamic keyword/function sets to the tokenizer so
 * highlighting tracks the connected server's `system.keywords`/`functions`
 * (#25); omitted → the tokenizer's built-in sets.
 */
export function renderHighlightInto(preEl, sql, opts) {
  renderTokensInto(preEl, tokenize(sql, opts));
}

// Paint an already-tokenized stream into `preEl`. Split out so the editor's
// keystroke path can tokenize ONCE and feed both the highlighter and the
// literal mask, instead of tokenizing the buffer twice per keystroke (#5 review).
export function renderTokensInto(preEl, tokens) {
  preEl.replaceChildren();
  for (const [t, v] of tokens) {
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

  // Tokenize the buffer ONCE per (text, reference-data) change and reuse the
  // token list for BOTH the syntax highlighter and the literal mask, instead of
  // tokenizing twice per keystroke (#5 review). Re-tokenize when app.refData
  // changes too (server keyword/func sets arrive after connect), else the
  // re-highlight would use stale tokens. String/comment classification is
  // opt-independent, so the highlighter's token list is valid for the mask.
  let tokVal = null;
  let tokRef = null;
  let tokList = [];
  let maskOut = '';
  const recompute = () => {
    const ref = app.refData;
    if (ta.value === tokVal && ref === tokRef) return;
    tokVal = ta.value;
    tokRef = ref;
    tokList = tokenize(ta.value, ref ? { keywords: ref.keywordSet, funcs: ref.funcSet } : undefined);
    maskOut = maskFromTokens(tokList);
  };
  const paintTokens = (sql) => {
    recompute(); // sql === ta.value at every call site (sync sets ta.value first)
    renderTokensInto(pre, tokList);
    gutter.replaceChildren(...gutterLines(sql));
  };
  // The text with string/comment/backtick-ident chars masked to NUL. Bracket
  // matching, signature help, and the auto-close decision run on this so
  // literals' brackets/quotes/commas don't pair or count (#2 review).
  const masked = () => { recompute(); return maskOut; };
  // All highlight sources, aggregated for the overlay: search matches (#23) or,
  // when search is closed and the caret is collapsed, the bracket pair adjacent
  // to the caret (#24).
  const computeMarks = () => {
    const marks = search.marks();
    if (!search.isOpen() && ta.selectionStart === ta.selectionEnd) {
      const bp = matchBracketAt(masked(), ta.selectionStart);
      if (bp) {
        marks.push({ start: bp[0], end: bp[0] + 1, cls: 'bracket' });
        marks.push({ start: bp[1], end: bp[1] + 1, cls: 'bracket' });
      }
    }
    return marks;
  };
  const paintMarks = () => {
    const marks = computeMarks();
    // Common case (no search, caret not on a bracket): keep the keystroke path
    // cheap — clear the overlay once and skip rebuilding a full-document node.
    if (!marks.length) {
      if (markPre.firstChild) markPre.replaceChildren();
      return;
    }
    markPre.replaceChildren();
    for (const seg of buildMarkSegments(ta.value, marks)) {
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
  // `caretBack` pulls the caret left from the end of the inserted text — used by
  // function completion to land it between the just-inserted `()`.
  const replaceRange = (start, end, text, caretBack = 0) => {
    ta.focus();
    ta.selectionStart = start;
    ta.selectionEnd = end;
    applyEdit(ta, text);
    if (caretBack) ta.selectionStart = ta.selectionEnd = start + text.length - caretBack;
  };
  // Apply a structural bracket edit (#24) while PRESERVING the native undo stack.
  // A direct `ta.value = …` assignment wipes ⌘Z, so instead express the edit as a
  // single execCommand over the changed range (insertText, or delete for an
  // empty-pair Backspace) — the same undo-friendly path applyEdit uses — derived
  // by diffing the old/new value. Type-over (no value change) is a pure caret
  // move. Then place the structural caret and re-sync the caret-driven UI
  // (execCommand fired 'input' at the post-edit caret; a type-over fires none).
  const applyBracketEdit = (edit) => {
    const before = ta.value;
    if (before !== edit.value) {
      const { from, to, ins } = bracketDiff(before, edit.value);
      ta.focus();
      ta.selectionStart = from;
      ta.selectionEnd = to;
      try {
        if (ins) ta.ownerDocument.execCommand('insertText', false, ins);
        else ta.ownerDocument.execCommand('delete', false);
      } catch { /* unsupported */ }
      // Same Firefox guard as applyEdit: execCommand can report success without
      // touching the <textarea>, so fall back on the *value*, not the return.
      if (ta.value === before) { ta.value = edit.value; ta.dispatchEvent(new Event('input')); }
    }
    ta.selectionStart = edit.selStart;
    ta.selectionEnd = edit.selEnd;
    paintMarks();
    intel.refreshSignature();
  };

  const search = createSearch({
    area, textarea: ta, padY: PAD_Y, lineHeightPx: LINE_HEIGHT_PX,
    replaceRange, syncScroll, repaintMarks: paintMarks,
  });

  // Screen-space caret position for the autocomplete popover.
  const caretAnchor = () => {
    const { x, y } = caretXY(ta.value, ta.selectionStart, {
      charWidth: CHAR_WIDTH_PX, lhPx: LINE_HEIGHT_PX, padX: PAD_X, padY: PAD_Y,
      scrollTop: ta.scrollTop, scrollLeft: ta.scrollLeft,
    });
    const rect = ta.getBoundingClientRect();
    // getBoundingClientRect is in post-zoom px while x/y are CSS px; bridge the
    // html{zoom} gap via the shared zoomScale helper (also used by results.js).
    const scale = zoomScale(ta);
    return { x: rect.left / scale + x, y: rect.top / scale + y, lineHeight: LINE_HEIGHT_PX };
  };
  const complete = createComplete({
    textarea: ta,
    getCompletions: () => app.completions || [],
    replaceRange,
    caretAnchor,
    appendPopover: (el) => area.appendChild(el),
    suppressed: () => search.isOpen(),
    fetchDoc: (name) => app.entityDoc(name), // lazy + cached function description (#27)
    getKeywordDocs: () => (app.refData ? app.refData.keywordDocs : {}),
  });

  // Map a mouse position to a text offset for hover docs (#27). Mirrors
  // caretAnchor's html{zoom} handling, inverted.
  const offsetAt = (clientX, clientY) => {
    const rect = ta.getBoundingClientRect();
    const scale = zoomScale(ta);
    const relX = (clientX - rect.left) / scale - PAD_X + ta.scrollLeft;
    const relY = (clientY - rect.top) / scale - PAD_Y + ta.scrollTop;
    return offsetFromXY(ta.value, relX, relY, { charWidth: CHAR_WIDTH_PX, lhPx: LINE_HEIGHT_PX });
  };
  // Client (post-zoom) coords → the popover's local CSS px. The popovers are
  // fixed children of the html{zoom} tree, so their left/top are scaled on
  // paint; divide by the same scale offsetAt/caretAnchor use so the hover card
  // lands on the cursor (#27).
  const clientToLocal = (clientX, clientY) => {
    const scale = zoomScale(ta);
    return { x: clientX / scale, y: clientY / scale };
  };
  const intel = createIntel({
    textarea: ta,
    maskedValue: masked, // string/comment-masked text for signatureContext (#2 review)
    getFunctions: () => (app.refData ? app.refData.functions : {}),
    getKeywordDocs: () => (app.refData ? app.refData.keywordDocs : {}),
    fetchDoc: (name) => app.entityDoc(name),
    caretAnchor,
    offsetAt,
    clientToLocal,
    appendPopover: (el) => area.appendChild(el),
    suppressed: () => search.isOpen() || complete.isOpen(),
  });

  const sync = () => {
    // A tab switch reassigns ta.value; dismiss the autocomplete dropdown and the
    // signature popover so their tracked offsets can't act on the new tab's text.
    complete.hide();
    intel.hide();
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
    complete.refresh(); // re-evaluate autocomplete at the new caret (#26)
    intel.refreshSignature(); // and signature help (#27)
    app.actions.rerenderTabs();
    app.actions.updateSaveBtn();
  });
  ta.addEventListener('scroll', () => { syncScroll(); intel.hide(); });
  ta.addEventListener('mousemove', (e) => intel.onMouseMove(e));
  ta.addEventListener('mouseleave', () => intel.onMouseLeave());
  ta.addEventListener('keydown', (e) => {
    // Autocomplete nav (↑/↓/Enter/Tab/Esc while the dropdown is open) wins first.
    if (complete.handleKeydown(e)) return;
    if (intel.handleKeydown(e)) return; // Esc dismisses signature help
    // (handled below: command-chord / IME guard, then brackets, then Tab)
    // A command chord (⌘/Ctrl) or an IME composition isn't bracket/Tab input —
    // leave it for the global shortcuts (run/format) or the IME. AltGr (Ctrl+Alt
    // on some EU layouts) *does* type real brackets, so don't treat it as a chord.
    const altGraph = typeof e.getModifierState === 'function' && e.getModifierState('AltGraph');
    if (e.isComposing || e.metaKey || (e.ctrlKey && !altGraph)) return;
    // Bracket auto-close / wrap / type-over / pair-delete (#24) takes priority;
    // a non-bracket key returns null and falls through to the Tab handler.
    // Suppress auto-pairing inside a string/comment (the char before the caret is
    // masked to NUL) so e.g. typing `(` in 'O(' doesn't insert a stray `)`.
    const s = ta.selectionStart;
    const inLiteral = s > 0 && masked()[s - 1] === '\0';
    const edit = bracketEdit(ta.value, s, ta.selectionEnd, e.key, inLiteral);
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
  // Caret moves don't fire 'input' — repaint the overlay so the bracket-pair
  // highlight (#24) tracks the caret. A mouse click also moves the caret, which
  // makes any open completion's tracked word range stale, so dismiss it there.
  const onCaretMove = () => { paintMarks(); intel.refreshSignature(); };
  // keyup only handles caret-only moves; a printable key already repainted via
  // 'input', and selection changes fire 'select' — so don't repaint twice here.
  const CARET_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']);
  ta.addEventListener('keyup', (e) => { if (CARET_KEYS.has(e.key)) onCaretMove(); });
  ta.addEventListener('click', () => { complete.hide(); paintMarks(); intel.refreshSignature(); });
  ta.addEventListener('select', onCaretMove);
  // Accept schema identifiers dragged from the tree; insert at the cursor.
  ta.addEventListener('dragover', (e) => e.preventDefault());
  ta.addEventListener('drop', (e) => {
    const dt = e.dataTransfer;
    if (!dt) return;
    // Schema identifier → insert verbatim at the caret (existing behavior).
    const ident = dt.getData(IDENT_MIME);
    if (ident) { e.preventDefault(); insertAtCursor(app, ident); return; }
    // A saved/history query → wrap as a subquery and drop it at the cursor's
    // landing point in the text (falling back to the caret when the drop is past
    // the text, e.g. the blank area below the last line).
    const sub = dt.getData(SUBQUERY_MIME);
    if (sub) {
      const text = toSubquery(sub);
      if (!text) return;
      e.preventDefault();
      const off = offsetAt(e.clientX, e.clientY);
      if (Number.isFinite(off)) replaceRange(off, off, text);
      else insertAtCursor(app, text);
    }
    // otherwise: not our drag — leave native behavior alone.
  });

  app.dom.editorTextarea = ta;
  app.dom.editorPre = pre;
  app.dom.editorMarkPre = markPre;
  app.dom.editorGutter = gutter;
  app.dom.editorSearch = search;
  app.dom.editorComplete = complete;
  app.dom.editorIntel = intel;
  app.dom.editorSync = sync;
  // Move the caret to a character offset and scroll its line into view — used to
  // jump to a format/parse error position (#format-error).
  app.dom.editorRevealCaret = (pos) => {
    const p = Math.max(0, Math.min(pos | 0, ta.value.length));
    ta.focus();
    ta.selectionStart = ta.selectionEnd = p;
    complete.hide();
    const top = PAD_Y + caretLineCol(ta.value, p).line * LINE_HEIGHT_PX;
    if (top < ta.scrollTop) ta.scrollTop = Math.max(0, top - LINE_HEIGHT_PX);
    else if (top + LINE_HEIGHT_PX > ta.scrollTop + ta.clientHeight) ta.scrollTop = top + LINE_HEIGHT_PX - ta.clientHeight;
    syncScroll();
    paintMarks();
  };
  sync();
}

/**
 * Replace the textarea's current selection with `text`. Prefers
 * execCommand('insertText') so the edit joins the native undo stack (⌘Z / ⌘⇧Z),
 * then falls back to a manual splice + 'input' dispatch. The fallback triggers
 * whenever execCommand didn't actually change the value — it's absent (happy-dom)
 * OR a no-op: Firefox returns `true` from execCommand('insertText') on a
 * <textarea> yet inserts nothing, which is why a schema double-click did nothing
 * and left the caret stranded. Checking the value (not execCommand's return)
 * makes the insert land and keeps the caret + 'input'-driven highlight in sync.
 */
function applyEdit(ta, text) {
  ta.focus();
  const before = ta.value;
  try { ta.ownerDocument.execCommand('insertText', false, text); } catch { /* unsupported */ }
  if (ta.value !== before) return; // the edit landed via execCommand
  const { selectionStart: s, selectionEnd: e } = ta;
  ta.value = ta.value.slice(0, s) + text + ta.value.slice(e);
  ta.selectionStart = ta.selectionEnd = s + text.length;
  ta.dispatchEvent(new Event('input'));
}

// Minimal prefix/suffix diff: the replaced range in `a` and the inserted text
// that turns it into `b`. Lets applyBracketEdit apply a bracket edit as one
// execCommand over a range (undo-preserving) instead of a `.value =` assignment.
function bracketDiff(a, b) {
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  return { from: p, to: a.length - s, ins: b.slice(p, b.length - s) };
}

/** Insert `text` at the textarea cursor (undoable). */
export function insertAtCursor(app, text) {
  const ta = app.dom.editorTextarea;
  if (!ta) return;
  applyEdit(ta, text);
}

/**
 * Replace the whole editor content with `text` (undoable). Targets the value
 * directly rather than trusting "did the value change?": when `text` already
 * equals the content (an idempotent Format re-run), execCommand('insertText') is
 * a legitimate no-op that ALSO collapses the selection to the end — so a
 * change-detection fallback would splice at the caret and *append*. We instead
 * no-op when already on target, and only fall back when execCommand failed to
 * reach it.
 */
export function replaceEditor(app, text) {
  const ta = app.dom.editorTextarea;
  if (!ta) return;
  if (ta.value === text) return; // already the target — nothing to do (no append)
  ta.focus();
  ta.select();
  try { ta.ownerDocument.execCommand('insertText', false, text); } catch { /* unsupported */ }
  if (ta.value === text) return; // execCommand reached the target (joins the undo stack)
  // Fallback (execCommand absent or a no-op): force the full replacement. Undo
  // isn't preserved here, but the content is always correct — never appended.
  ta.value = text;
  ta.selectionStart = ta.selectionEnd = text.length;
  ta.dispatchEvent(new Event('input'));
}
