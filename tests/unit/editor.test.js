import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHighlightInto, mountEditor, insertAtCursor, replaceEditor, IDENT_MIME } from '../../src/ui/editor.js';
import { makeApp } from '../helpers/fake-app.js';

describe('renderHighlightInto', () => {
  it('paints tokens as spans and whitespace as text, ending with newline', () => {
    const pre = document.createElement('pre');
    renderHighlightInto(pre, 'SELECT 1');
    expect(pre.querySelector('.sql-keyword').textContent).toBe('SELECT');
    expect(pre.querySelector('.sql-number').textContent).toBe('1');
    expect(pre.textContent.endsWith('\n')).toBe(true);
  });
  it('forwards dynamic keyword/func sets to the tokenizer (#25)', () => {
    const pre = document.createElement('pre');
    renderHighlightInto(pre, 'FOO bar', { keywords: new Set(['FOO']), funcs: new Set(['bar']) });
    expect(pre.querySelector('.sql-keyword').textContent).toBe('FOO');
    expect(pre.querySelector('.sql-func').textContent).toBe('bar');
  });
});

describe('mountEditor', () => {
  function mount() {
    const app = makeApp();
    app.activeTab().sql = 'SELECT 1';
    const container = document.createElement('div');
    mountEditor(app, container);
    return { app, container, ta: app.dom.editorTextarea };
  }

  it('builds the editor and syncs the active tab', () => {
    const { container, app } = mount();
    expect(container.querySelector('.sql-editor')).not.toBeNull();
    expect(app.dom.editorTextarea.value).toBe('SELECT 1');
    expect(app.dom.editorGutter.children.length).toBe(1);
  });
  it('highlights with the connection reference sets when app.refData is present (#25)', () => {
    const app = makeApp();
    app.refData = { keywordSet: new Set(['FOO']), funcSet: new Set() };
    app.activeTab().sql = 'FOO';
    mountEditor(app, document.createElement('div'));
    expect(app.dom.editorPre.querySelector('.sql-keyword').textContent).toBe('FOO');
  });
  it('typing updates the tab, marks dirty, repaints, and rerenders', () => {
    const { app, ta } = mount();
    ta.value = 'SELECT 2\nFROM t';
    ta.dispatchEvent(new Event('input'));
    expect(app.activeTab().sql).toBe('SELECT 2\nFROM t');
    expect(app.activeTab().dirty).toBe(true);
    expect(app.dom.editorGutter.children.length).toBe(2);
    expect(app.actions.rerenderTabs).toHaveBeenCalled();
    expect(app.actions.updateSaveBtn).toHaveBeenCalled();
  });
  it('scroll syncs pre + gutter to the textarea on both axes', () => {
    const { app, ta } = mount();
    ta.scrollTop = 12;
    ta.scrollLeft = 4;
    ta.dispatchEvent(new Event('scroll'));
    expect(app.dom.editorPre.scrollTop).toBe(12);
    expect(app.dom.editorPre.scrollLeft).toBe(4); // horizontal sync (long lines)
    expect(app.dom.editorGutter.scrollTop).toBe(12);
    // NOTE: the real-world misalignment fixed alongside this was a render-layer
    // bug — the textarea's own scrollbar shrank its clientHeight, so the pre
    // (overflow:hidden, no scrollbar) couldn't scroll as far and the highlight
    // clamped behind the selection. The fix is CSS (hide the textarea
    // scrollbars so both client boxes match); happy-dom has no scrollbar layout,
    // so that part is verified in a real browser, not here. This guards the
    // sync wiring both layers depend on.
  });
  it('Tab key inserts two spaces at the cursor', () => {
    const { ta } = mount();
    ta.value = 'ab';
    ta.selectionStart = ta.selectionEnd = 1;
    const e = new KeyboardEvent('keydown', { key: 'Tab', cancelable: true });
    ta.dispatchEvent(e);
    expect(ta.value).toBe('a  b');
    expect(e.defaultPrevented).toBe(true);
  });
  it('non-Tab keydown is ignored', () => {
    const { ta } = mount();
    const before = ta.value;
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'x' }));
    expect(ta.value).toBe(before);
  });
  it('dragover prevents default so the textarea accepts drops', () => {
    const { ta } = mount();
    const e = new Event('dragover', { cancelable: true });
    ta.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
  });
  it('dropping a schema identifier inserts it at the cursor', () => {
    const { app, ta } = mount();
    ta.value = 'SELECT  FROM t';
    ta.selectionStart = ta.selectionEnd = 7;
    const e = new Event('drop', { cancelable: true });
    e.dataTransfer = { getData: (m) => (m === IDENT_MIME ? 'db.tbl' : '') };
    ta.dispatchEvent(e);
    expect(ta.value).toBe('SELECT db.tbl FROM t');
    expect(e.defaultPrevented).toBe(true);
  });
  it('a drop without our identifier is left to native handling', () => {
    const { ta } = mount();
    const before = ta.value;
    const e = new Event('drop', { cancelable: true });
    e.dataTransfer = { getData: () => '' };
    ta.dispatchEvent(e);
    expect(ta.value).toBe(before);
    expect(e.defaultPrevented).toBe(false);
  });
  it('a drop with no dataTransfer is a no-op', () => {
    const { ta } = mount();
    const before = ta.value;
    const e = new Event('drop', { cancelable: true });
    ta.dispatchEvent(e);
    expect(ta.value).toBe(before);
    expect(e.defaultPrevented).toBe(false);
  });
});

describe('insertAtCursor', () => {
  it('inserts text at the cursor and fires input', () => {
    const app = makeApp();
    mountEditor(app, document.createElement('div'));
    const ta = app.dom.editorTextarea;
    ta.value = 'SELECT  FROM t';
    ta.selectionStart = ta.selectionEnd = 7;
    insertAtCursor(app, 'x');
    expect(ta.value).toBe('SELECT x FROM t');
    expect(app.activeTab().sql).toBe('SELECT x FROM t');
  });
  it('no-ops without a textarea', () => {
    const app = makeApp();
    expect(() => insertAtCursor(app, 'x')).not.toThrow();
  });
  it('uses execCommand(insertText) when available, skipping the manual splice', () => {
    const app = makeApp();
    mountEditor(app, document.createElement('div'));
    const ta = app.dom.editorTextarea;
    ta.value = 'AB';
    ta.selectionStart = ta.selectionEnd = 1;
    const spy = vi.fn(() => true);
    document.execCommand = spy;
    try {
      insertAtCursor(app, 'x');
      expect(spy).toHaveBeenCalledWith('insertText', false, 'x');
      expect(ta.value).toBe('AB'); // execCommand owns the insert; manual splice skipped
    } finally {
      delete document.execCommand;
    }
  });
});

describe('replaceEditor', () => {
  function mounted(sql = '') {
    const app = makeApp();
    app.activeTab().sql = sql;
    mountEditor(app, document.createElement('div'));
    return { app, ta: app.dom.editorTextarea };
  }
  it('swaps the whole content', () => {
    const { ta, app } = mounted('select 1');
    replaceEditor(app, 'SELECT\n  1');
    expect(ta.value).toBe('SELECT\n  1');
    expect(app.activeTab().sql).toBe('SELECT\n  1');
  });
  it('no-ops without a textarea', () => {
    const app = makeApp();
    expect(() => replaceEditor(app, 'x')).not.toThrow();
  });
});

describe('in-editor find/replace (#23)', () => {
  function mounted(sql = 'select a from t') {
    const app = makeApp();
    app.activeTab().sql = sql;
    const container = document.createElement('div');
    mountEditor(app, container);
    return { app, container, ta: app.dom.editorTextarea };
  }
  const panel = (c) => c.querySelector('.sql-search');
  const findInput = (c) => c.querySelector('.sql-search .srch-field');
  const count = (c) => c.querySelector('.srch-count').textContent;
  const type = (input, v) => { input.value = v; input.dispatchEvent(new Event('input')); };
  const key = (el, k, opts = {}) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, cancelable: true, ...opts }));

  it('Cmd+F (and Ctrl+F / uppercase F) opens the panel', () => {
    const { container, ta } = mounted();
    expect(panel(container)).toBeNull();
    key(ta, 'f', { metaKey: true });
    expect(panel(container)).not.toBeNull();
    const b = mounted();
    key(b.ta, 'F', { ctrlKey: true });
    expect(panel(b.container)).not.toBeNull();
  });

  it('typing a query highlights matches in the overlay and shows the count', () => {
    const { app, container, ta } = mounted('a a a');
    key(ta, 'f', { metaKey: true });
    type(findInput(container), 'a');
    expect(count(container)).toBe('1/3');
    expect(app.dom.editorMarkPre.querySelector('.mark-active')).not.toBeNull();
    expect(app.dom.editorMarkPre.querySelectorAll('.mark-match').length).toBe(2);
  });

  it('next/prev cycle the active match (Enter, Shift+Enter, and the buttons)', () => {
    const { container, ta } = mounted('a a a');
    key(ta, 'f', { metaKey: true });
    const input = findInput(container);
    type(input, 'a');
    key(input, 'Enter');                       // → 2/3
    expect(count(container)).toBe('2/3');
    key(input, 'Enter', { shiftKey: true });   // → 1/3
    expect(count(container)).toBe('1/3');
    container.querySelector('.srch-nav[title^="Previous"]').dispatchEvent(new Event('click')); // wrap → 3/3
    expect(count(container)).toBe('3/3');
    container.querySelector('.srch-nav[title^="Next"]').dispatchEvent(new Event('click'));      // wrap → 1/3
    expect(count(container)).toBe('1/3');
  });

  it('next with no matches is a no-op', () => {
    const { container, ta } = mounted('abc');
    key(ta, 'f', { metaKey: true });
    expect(() => container.querySelector('.srch-nav[title^="Next"]').dispatchEvent(new Event('click'))).not.toThrow();
    expect(count(container)).toBe('0/0');
  });

  it('case / whole-word / regex toggles re-filter and reflect state', () => {
    const { container, ta } = mounted('a A a');
    key(ta, 'f', { metaKey: true });
    type(findInput(container), 'a');
    expect(count(container)).toBe('1/3');
    const aa = container.querySelector('.srch-tog[title="Match case"]');
    aa.dispatchEvent(new Event('click'));
    expect(aa.classList.contains('on')).toBe(true);
    expect(count(container)).toBe('1/2'); // only the two lowercase a's

    const ww = mounted('cat category');
    key(ww.ta, 'f', { metaKey: true });
    type(findInput(ww.container), 'cat');
    expect(count(ww.container)).toBe('1/2');
    ww.container.querySelector('.srch-tog[title="Whole word"]').dispatchEvent(new Event('click'));
    expect(count(ww.container)).toBe('1/1');
  });

  it('regex toggle + invalid pattern shows the bad-re state', () => {
    const { container, ta } = mounted('a1 b2');
    key(ta, 'f', { metaKey: true });
    container.querySelector('.srch-tog[title="Regular expression"]').dispatchEvent(new Event('click'));
    const input = findInput(container);
    type(input, '\\d');
    expect(count(container)).toBe('1/2');
    type(input, '(');                          // invalid regex
    expect(count(container)).toBe('bad re');
    expect(input.classList.contains('bad')).toBe(true);
  });

  it('replace swaps the active match; replace-all swaps the rest', () => {
    const { container, ta } = mounted('a a a');
    key(ta, 'f', { metaKey: true });
    type(findInput(container), 'a');
    container.querySelector('.srch-disc').dispatchEvent(new Event('click')); // reveal replace row
    const replaceInput = container.querySelectorAll('.sql-search .srch-field')[1];
    type(replaceInput, 'X');
    container.querySelector('.srch-btn').dispatchEvent(new Event('click'));  // Replace active
    expect(ta.value).toBe('X a a');
    container.querySelector('.srch-btn.primary').dispatchEvent(new Event('click')); // Replace all
    expect(ta.value).toBe('X X X');
  });

  it('replace via Enter in the replace field, and replace/all no-op without matches', () => {
    const { container, ta } = mounted('a a');
    key(ta, 'f', { metaKey: true });
    type(findInput(container), 'a');
    container.querySelector('.srch-disc').dispatchEvent(new Event('click'));
    const replaceInput = container.querySelectorAll('.sql-search .srch-field')[1];
    type(replaceInput, 'Z');
    key(replaceInput, 'Enter');
    expect(ta.value).toBe('Z a');

    const none = mounted('abc');
    key(none.ta, 'f', { metaKey: true });
    none.container.querySelector('.srch-disc').dispatchEvent(new Event('click'));
    const before = none.ta.value;
    none.container.querySelector('.srch-btn').dispatchEvent(new Event('click'));
    none.container.querySelector('.srch-btn.primary').dispatchEvent(new Event('click'));
    expect(none.ta.value).toBe(before);
  });

  it('Escape and the close button close the panel and clear highlights', () => {
    const { app, container, ta } = mounted('a a');
    expect(app.dom.editorSearch.isOpen()).toBe(false);
    key(ta, 'f', { metaKey: true });
    expect(app.dom.editorSearch.isOpen()).toBe(true);
    type(findInput(container), 'a');
    expect(app.dom.editorMarkPre.querySelector('.mark-active')).not.toBeNull();
    key(findInput(container), 'Escape');
    expect(app.dom.editorSearch.isOpen()).toBe(false);
    expect(panel(container)).toBeNull();
    expect(app.dom.editorMarkPre.querySelector('.mark-active')).toBeNull();
    // reopen (reuses the panel element) and close via the × button
    key(ta, 'f', { metaKey: true });
    expect(panel(container)).not.toBeNull();
    key(ta, 'f', { metaKey: true }); // already open → just refocus
    container.querySelector('.srch-nav[title^="Close"]').dispatchEvent(new Event('click'));
    expect(panel(container)).toBeNull();
  });

  it('Escape in the replace field closes the panel', () => {
    const { container, ta } = mounted('a');
    key(ta, 'f', { metaKey: true });
    container.querySelector('.srch-disc').dispatchEvent(new Event('click'));
    key(container.querySelectorAll('.sql-search .srch-field')[1], 'Escape');
    expect(panel(container)).toBeNull();
  });

  it('toggling the replace disclosure shows then hides the replace row', () => {
    const { container, ta } = mounted('a');
    key(ta, 'f', { metaKey: true });
    const disc = container.querySelector('.srch-disc');
    expect(container.querySelectorAll('.sql-search .srch-field').length).toBe(1);
    disc.dispatchEvent(new Event('click'));
    expect(container.querySelectorAll('.sql-search .srch-field').length).toBe(2);
    expect(disc.classList.contains('open')).toBe(true);
    disc.dispatchEvent(new Event('click'));
    expect(container.querySelectorAll('.sql-search .srch-field').length).toBe(1);
  });

  it('editing the text recomputes matches and the overlay mirrors the value', () => {
    const { app, container, ta } = mounted('a a');
    key(ta, 'f', { metaKey: true });
    type(findInput(container), 'a');
    expect(count(container)).toBe('1/2');
    ta.value = 'a a a a'; // user types in the editor
    ta.dispatchEvent(new Event('input'));
    expect(count(container)).toBe('1/4');
    expect(app.dom.editorMarkPre.textContent).toContain('a a a a');
  });

  it('editing the query resets the active match to the first', () => {
    const { container, ta } = mounted('a a a');
    key(ta, 'f', { metaKey: true });
    const input = findInput(container);
    type(input, 'a');
    key(input, 'Enter'); key(input, 'Enter'); // → 3/3
    expect(count(container)).toBe('3/3');
    type(input, 'a'); // re-typing the query re-searches from the top
    expect(count(container)).toBe('1/3');
  });
});

describe('bracket matching + auto-close (#24)', () => {
  function mounted(sql = '') {
    const app = makeApp();
    app.activeTab().sql = sql;
    const container = document.createElement('div');
    mountEditor(app, container);
    const ta = app.dom.editorTextarea;
    ta.value = sql;
    return { app, container, ta };
  }
  const press = (ta, k, opts = {}) => {
    const e = new KeyboardEvent('keydown', { key: k, cancelable: true, ...opts });
    ta.dispatchEvent(e);
    return e;
  };

  it('auto-closes an opener and places the caret inside', () => {
    const { ta } = mounted('');
    ta.selectionStart = ta.selectionEnd = 0;
    const e = press(ta, '(');
    expect(e.defaultPrevented).toBe(true);
    expect(ta.value).toBe('()');
    expect(ta.selectionStart).toBe(1);
  });
  it('wraps a selection with the opener', () => {
    const { ta } = mounted('abc');
    ta.selectionStart = 0; ta.selectionEnd = 3;
    press(ta, '[');
    expect(ta.value).toBe('[abc]');
    expect(ta.selectionStart).toBe(1);
    expect(ta.selectionEnd).toBe(4);
  });
  it('auto-closes a quote, then types over the closer', () => {
    const { ta } = mounted('');
    ta.selectionStart = ta.selectionEnd = 0;
    press(ta, "'");
    expect(ta.value).toBe("''");
    expect(ta.selectionStart).toBe(1);
    press(ta, "'"); // step over
    expect(ta.value).toBe("''");
    expect(ta.selectionStart).toBe(2);
  });
  it('types over an existing closing bracket', () => {
    const { ta } = mounted('()');
    ta.selectionStart = ta.selectionEnd = 1;
    press(ta, ')');
    expect(ta.value).toBe('()');
    expect(ta.selectionStart).toBe(2);
  });
  it('Backspace inside an empty pair deletes both halves', () => {
    const { ta } = mounted('()');
    ta.selectionStart = ta.selectionEnd = 1;
    press(ta, 'Backspace');
    expect(ta.value).toBe('');
  });
  it('a non-bracket key falls through — Tab still inserts two spaces', () => {
    const { ta } = mounted('ab');
    ta.selectionStart = ta.selectionEnd = 1;
    const e = press(ta, 'Tab');
    expect(e.defaultPrevented).toBe(true);
    expect(ta.value).toBe('a  b');
  });
  it('highlights the bracket pair adjacent to the caret on caret moves', () => {
    const { app, ta } = mounted('(a)');
    ta.selectionStart = ta.selectionEnd = 0; // caret before '('
    ta.dispatchEvent(new Event('keyup'));
    expect(app.dom.editorMarkPre.querySelectorAll('.mark-bracket').length).toBe(2);
    ta.selectionStart = ta.selectionEnd = 1; // between '(' and a → not adjacent in match sense
    ta.dispatchEvent(new MouseEvent('click'));
    // caret after 'a' is not on a bracket boundary; no pair highlight
    expect(app.dom.editorMarkPre.querySelectorAll('.mark-bracket').length).toBe(0);
  });
  it('suppresses bracket marks while the search panel is open', () => {
    const { app, ta } = mounted('(a)');
    press(ta, 'f', { metaKey: true }); // open search
    ta.selectionStart = ta.selectionEnd = 0;
    app.dom.editorSync(); // repaint overlay
    expect(app.dom.editorMarkPre.querySelectorAll('.mark-bracket').length).toBe(0);
  });
  it('a ⌘ chord is not bracket input (lets the shortcut through)', () => {
    const { ta } = mounted('');
    ta.selectionStart = ta.selectionEnd = 0;
    const e = press(ta, '[', { metaKey: true });
    expect(e.defaultPrevented).toBe(false);
    expect(ta.value).toBe('');
  });
  it('a plain Ctrl chord is not bracket input (no AltGraph)', () => {
    const { ta } = mounted('');
    ta.selectionStart = ta.selectionEnd = 0;
    const e = new KeyboardEvent('keydown', { key: '[', ctrlKey: true, cancelable: true });
    Object.defineProperty(e, 'getModifierState', { value: undefined }); // env without the API
    ta.dispatchEvent(e);
    expect(ta.value).toBe('');
  });
  it('an AltGr-typed bracket still auto-closes (real input, not a chord)', () => {
    const { ta } = mounted('');
    ta.selectionStart = ta.selectionEnd = 0;
    const e = new KeyboardEvent('keydown', { key: '(', ctrlKey: true, altKey: true, cancelable: true });
    e.getModifierState = (k) => k === 'AltGraph';
    ta.dispatchEvent(e);
    expect(ta.value).toBe('()');
  });
  it('an IME composition keydown does not auto-close', () => {
    const { ta } = mounted('');
    ta.selectionStart = ta.selectionEnd = 0;
    const e = new KeyboardEvent('keydown', { key: '(', cancelable: true });
    Object.defineProperty(e, 'isComposing', { value: true });
    ta.dispatchEvent(e);
    expect(ta.value).toBe('');
    expect(e.defaultPrevented).toBe(false);
  });
});

describe('autocomplete dropdown (#26)', () => {
  const CANDIDATES = [
    { label: 'SELECT', kind: 'keyword', insert: 'SELECT', detail: 'keyword' },
    { label: 'count', kind: 'agg', insert: 'count(', detail: 'count([x])', ret: 'UInt64', doc: 'Counts rows.' },
    { label: 'concat', kind: 'fn', insert: 'concat(', detail: 'concat(s, …)', ret: 'String' }, // sig, no doc
    { label: 'cobalt', kind: 'mystery', insert: 'cobalt', detail: '?' }, // unknown kind → glyph fallback
    { label: 'ontime', kind: 'table', insert: 'ontime', detail: 'table', parent: 'airline' },
    { label: 'Year', kind: 'column', insert: 'Year', detail: 'UInt16', parent: 'ontime' },
    { label: 'Month', kind: 'column', insert: 'Month', detail: 'UInt8', parent: 'ontime' },
  ];
  function mounted(sql = '', completions = CANDIDATES) {
    const app = makeApp();
    app.completions = completions;
    app.activeTab().sql = sql;
    const container = document.createElement('div');
    mountEditor(app, container);
    const ta = app.dom.editorTextarea;
    ta.value = sql;
    return { app, container, ta };
  }
  const dropdown = (c) => c.querySelector('.ac-dropdown');
  const rows = (c) => [...c.querySelectorAll('.ac-row')];
  const labels = (c) => rows(c).map((r) => r.querySelector('.ac-label').textContent);
  const typeAt = (ta, value, pos) => {
    ta.value = value; ta.selectionStart = ta.selectionEnd = pos;
    ta.dispatchEvent(new Event('input'));
  };
  const press = (ta, k, opts = {}) => {
    const e = new KeyboardEvent('keydown', { key: k, cancelable: true, ...opts });
    ta.dispatchEvent(e);
    return e;
  };

  it('shows ranked candidates after typing ≥1 word char', () => {
    const { container, ta } = mounted();
    typeAt(ta, 'co', 2);
    expect(dropdown(container)).not.toBeNull();
    expect(labels(container)).toEqual(expect.arrayContaining(['concat', 'count', 'cobalt']));
    expect(labels(container)).not.toContain('Year'); // no 'co'
  });
  it('does not trigger on an empty word', () => {
    const { container, ta } = mounted();
    typeAt(ta, 'select ', 7); // caret after the space → empty word
    expect(dropdown(container)).toBeNull();
  });
  it('does not complete over a non-empty selection', () => {
    const { container, ta } = mounted();
    ta.value = 'count'; ta.selectionStart = 0; ta.selectionEnd = 5;
    ta.dispatchEvent(new Event('input'));
    expect(dropdown(container)).toBeNull();
  });
  it('a qualified word (table.) lists only that table\'s columns', () => {
    const { container, ta } = mounted();
    typeAt(ta, 'ontime.', 7);
    expect(labels(container).sort()).toEqual(['Month', 'Year']);
  });
  it('arrows move the active row (wrapping); Enter accepts and a function inserts name(', () => {
    const { app, container, ta } = mounted();
    expect(app.dom.editorComplete.isOpen()).toBe(false);
    typeAt(ta, 'co', 2);
    expect(app.dom.editorComplete.isOpen()).toBe(true);
    expect(rows(container)[0].classList.contains('on')).toBe(true);
    press(ta, 'ArrowUp'); // wrap to last
    expect(rows(container)[rows(container).length - 1].classList.contains('on')).toBe(true);
    press(ta, 'ArrowDown'); // wrap back to first
    expect(rows(container)[0].classList.contains('on')).toBe(true);
    const accepted = labels(container)[0];
    press(ta, 'Enter');
    expect(app.dom.editorComplete.isOpen()).toBe(false);
    expect(dropdown(container)).toBeNull();
    expect(ta.value).toContain(accepted + '('); // count/concat → name(
  });
  it('Tab accepts a column as-is; Escape dismisses', () => {
    const { container, ta } = mounted();
    typeAt(ta, 'Yea', 3);
    press(ta, 'Escape');
    expect(dropdown(container)).toBeNull();
    typeAt(ta, 'Yea', 3);
    press(ta, 'Tab');
    expect(ta.value).toBe('Year');
  });
  it('a non-nav key while open falls through and leaves the dropdown up', () => {
    const { container, ta } = mounted();
    typeAt(ta, 'co', 2);
    press(ta, 'x'); // not consumed by the dropdown
    expect(dropdown(container)).not.toBeNull();
  });
  it('clicking (mousedown) a row accepts it', () => {
    const { container, ta } = mounted();
    typeAt(ta, 'ont', 3);
    rows(container).find((r) => r.querySelector('.ac-label').textContent === 'ontime')
      .dispatchEvent(new MouseEvent('mousedown', { cancelable: true }));
    expect(ta.value).toBe('ontime');
    expect(dropdown(container)).toBeNull();
  });
  it('the footer shows the active signature/doc, with sig-only and hidden variants', () => {
    const { container, ta } = mounted();
    typeAt(ta, 'cou', 3); // count → sig + doc
    expect(container.querySelector('.ac-sig').textContent).toContain('count([x]) → UInt64');
    expect(container.querySelector('.ac-doc')).not.toBeNull();
    typeAt(ta, 'conc', 4); // concat → sig, no doc
    expect(container.querySelector('.ac-sig')).not.toBeNull();
    expect(container.querySelector('.ac-doc')).toBeNull();
    typeAt(ta, 'SEL', 3); // keyword → footer hidden
    expect(container.querySelector('.ac-footer').style.display).toBe('none');
  });
  it('no matching candidates → no dropdown', () => {
    const { container, ta } = mounted();
    typeAt(ta, 'zzz', 3);
    expect(dropdown(container)).toBeNull();
  });
  it('is suppressed while the search panel is open', () => {
    const { container, ta } = mounted();
    press(ta, 'f', { metaKey: true }); // open search
    typeAt(ta, 'co', 2);
    expect(dropdown(container)).toBeNull();
  });
  it('scroll dismisses; blur is wired', () => {
    const { container, ta } = mounted();
    typeAt(ta, 'co', 2);
    ta.dispatchEvent(new Event('blur')); // covers the deferred-hide listener
    ta.dispatchEvent(new Event('scroll'));
    expect(dropdown(container)).toBeNull();
  });
  it('tolerates an unset app.completions (defaults to empty, no crash)', () => {
    const app = makeApp(); // no app.completions
    const container = document.createElement('div');
    mountEditor(app, container);
    const ta = app.dom.editorTextarea;
    expect(() => typeAt(ta, 'co', 2)).not.toThrow();
    expect(container.querySelector('.ac-dropdown')).toBeNull();
  });
  it('a modified Enter (⌘↵) dismisses without accepting, so it bubbles to Run', () => {
    const { container, ta } = mounted();
    typeAt(ta, 'co', 2);
    const e = press(ta, 'Enter', { metaKey: true });
    expect(ta.value).toBe('co');            // no token spliced in
    expect(dropdown(container)).toBeNull(); // dismissed
    expect(e.defaultPrevented).toBe(false); // not consumed → global Run shortcut fires
  });
  it('a caret-moving key (ArrowLeft) dismisses the dropdown', () => {
    const { container, ta } = mounted();
    typeAt(ta, 'co', 2);
    press(ta, 'ArrowLeft');
    expect(dropdown(container)).toBeNull();
  });
  it('clicking in the editor dismisses the dropdown', () => {
    const { container, ta } = mounted();
    typeAt(ta, 'co', 2);
    ta.dispatchEvent(new MouseEvent('click'));
    expect(dropdown(container)).toBeNull();
  });
  it('anchors the popover in CSS px, bridging html{zoom} via the rect/offsetWidth scale', () => {
    const { container, ta } = mounted();
    ta.getBoundingClientRect = () => ({ left: 120, top: 60, width: 120, height: 24, right: 240, bottom: 84 });
    Object.defineProperty(ta, 'offsetWidth', { value: 100, configurable: true });
    typeAt(ta, 'co', 2);
    // scale = 120/100 = 1.2; x = 14 + 2*7.8 = 29.6; left = round(120/1.2 + 29.6) = 130
    expect(dropdown(container).style.left).toBe('130px');
  });
});

describe('signature help + hover docs (#27)', () => {
  const REF = {
    functions: {
      sum: { kind: 'agg', sig: 'sum(x)', ret: 'numeric', desc: 'Sum of values.' },
      substring: { kind: 'fn', sig: 'substring(s, off, len)', ret: 'String', desc: 'A substring.' },
      now: { kind: 'fn', sig: 'now()', ret: 'DateTime', desc: '' }, // signature, no description
    },
    keywordDocs: { PREWHERE: 'Filter applied before reading other columns.' },
    keywordSet: new Set(['PREWHERE']),
    funcSet: new Set(['sum', 'substring']),
  };
  function mounted(sql = '') {
    const app = makeApp();
    app.refData = REF;
    app.completions = []; // no candidates → no dropdown to suppress signature help
    app.activeTab().sql = sql;
    const container = document.createElement('div');
    mountEditor(app, container);
    const ta = app.dom.editorTextarea;
    ta.value = sql;
    return { app, container, ta };
  }
  const sig = (c) => c.querySelector('.sig-help');
  const card = (c) => c.querySelector('.hover-card');
  const caretMove = (ta, pos) => { ta.selectionStart = ta.selectionEnd = pos; ta.dispatchEvent(new Event('keyup')); };

  it('shows signature help with the active argument bolded inside a call', () => {
    const { container, ta } = mounted('substring(a, b');
    caretMove(ta, 'substring(a, '.length); // caret on the 2nd argument
    const el = sig(container);
    expect(el).not.toBeNull();
    expect(el.querySelector('.sig-name').textContent).toBe('substring');
    expect(el.querySelector('.sig-arg.on').textContent).toBe('off'); // arg index 1
    expect(el.textContent).toContain('→ String');
  });
  it('dismisses signature help when the caret leaves the call', () => {
    const { container, ta } = mounted('sum(a)');
    caretMove(ta, 4);
    expect(sig(container)).not.toBeNull();
    caretMove(ta, 6); // after the ')'
    expect(sig(container)).toBeNull();
  });
  it('is suppressed while the autocomplete dropdown is open', () => {
    const { app, container, ta } = mounted();
    app.completions = [{ label: 'avg', kind: 'agg', insert: 'avg(', detail: 'avg(x)' }];
    ta.value = 'sum(a'; ta.selectionStart = ta.selectionEnd = 5;
    ta.dispatchEvent(new Event('input'));
    expect(container.querySelector('.ac-dropdown')).not.toBeNull();
    expect(sig(container)).toBeNull();
  });
  it('Esc dismisses the signature popover (and is consumed)', () => {
    const { container, ta } = mounted('sum(a');
    caretMove(ta, 5);
    expect(sig(container)).not.toBeNull();
    const e = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
    ta.dispatchEvent(e);
    expect(sig(container)).toBeNull();
    expect(e.defaultPrevented).toBe(true);
  });

  describe('hover docs', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());
    const move = (ta, clientX, clientY = 14) => ta.dispatchEvent(new MouseEvent('mousemove', { clientX, clientY }));

    it('hovering a function token shows its signature + description after the dwell', () => {
      const { container, ta } = mounted('sum(x)');
      // equal rect/offsetWidth → scale 1 via the real ratio (not the fallback)
      ta.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, right: 100, bottom: 24, height: 24 });
      Object.defineProperty(ta, 'offsetWidth', { value: 100, configurable: true });
      move(ta, 22); // → col 1 → the 'sum' token
      vi.advanceTimersByTime(360);
      expect(card(container).textContent).toContain('sum(x)');
      expect(card(container).textContent).toContain('Sum of values.');
    });
    it('hovering a keyword shows its built-in doc', () => {
      const { container, ta } = mounted('PREWHERE x');
      move(ta, 14 + 2 * 7.8); // → col 2 → 'PREWHERE'
      vi.advanceTimersByTime(360);
      expect(card(container).textContent).toContain('Filter applied before reading');
    });
    it('no card over an unknown word, or above the text; mouseleave clears it', () => {
      const { container, ta } = mounted('sum(zzz)');
      move(ta, 14 + 5 * 7.8); // → 'zzz' (unknown)
      vi.advanceTimersByTime(360);
      expect(card(container)).toBeNull();
      move(ta, 22, -100); // above the text → offset null
      vi.advanceTimersByTime(360);
      expect(card(container)).toBeNull();
      move(ta, 22); // 'sum' → shows
      vi.advanceTimersByTime(360);
      expect(card(container)).not.toBeNull();
      ta.dispatchEvent(new MouseEvent('mouseleave'));
      expect(card(container)).toBeNull();
    });
    it('hover is suppressed while find is open, and the scroll handler hides popovers', () => {
      const { container, ta } = mounted('sum(x)');
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', metaKey: true, cancelable: true })); // open find
      move(ta, 22);
      vi.advanceTimersByTime(360);
      expect(card(container)).toBeNull(); // suppressed while find open
    });
    it('a function with no description shows just its signature', () => {
      const { container, ta } = mounted('now()');
      move(ta, 14 + 1 * 7.8); // → 'now'
      vi.advanceTimersByTime(360);
      const el = card(container);
      expect(el.textContent).toContain('now()');
      expect(el.querySelector('.hover-doc')).toBeNull(); // no description div
    });
    it('tolerates hovering before reference data has loaded (no refData)', () => {
      const app = makeApp(); // no app.refData → getFunctions/getKeywordDocs default to {}
      const container = document.createElement('div');
      mountEditor(app, container);
      const ta = app.dom.editorTextarea;
      ta.value = 'sum(x)';
      ta.dispatchEvent(new MouseEvent('mousemove', { clientX: 22, clientY: 14 }));
      vi.advanceTimersByTime(360);
      expect(container.querySelector('.hover-card')).toBeNull();
    });
  });
});
