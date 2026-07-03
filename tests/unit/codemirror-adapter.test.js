import { describe, it, expect, vi } from 'vitest';
import { undoDepth, undo } from '@codemirror/commands';
import { EditorState } from '@codemirror/state';
import {
  createCodeMirrorEditor, langExtensionFor, completionSourceFor, applyFor,
  infoFor, hoverSourceFor, handleDrop, insertTwoSpaces, inputGuards, syncTx,
} from '../../src/editor/codemirror-adapter.js';
import { activeTab, newTabObj } from '../../src/state.js';
import { assembleReferenceData } from '../../src/core/completions.js';
import { IDENT_MIME, SUBQUERY_MIME } from '../../src/ui/dnd-mime.js';
import { makeApp as baseApp } from '../helpers/fake-app.js';

// The CM6 adapter runs against the REAL CodeMirror under happy-dom — no fake
// editor. Construction, dispatch, undo, and keymaps all work headless; only
// coordinate measurement doesn't, which is why the inner sources/handlers are
// exported and invoked directly where needed.

// The shared fake-app, narrowed to what the adapter reads: a fresh dom bag
// (mount registers editorView into it), reference data, and NO entityDoc by
// default (infoFor treats a missing loader as "no info").
const makeApp = (over = {}) => baseApp({
  dom: {},
  refData: assembleReferenceData(null),
  completions: [],
  entityDoc: undefined,
  ...over,
});

// Mount a fresh port + view; subscribe like app.js does (#143) so tab.sql
// tracks the view.
function mounted(over = {}) {
  const app = makeApp(over);
  const port = createCodeMirrorEditor(app);
  const changes = [];
  port.onDocChange((v) => {
    changes.push(v);
    const tab = activeTab(app.state);
    tab.sql = v;
    tab.dirty = true;
  });
  const host = document.createElement('div');
  document.body.appendChild(host);
  port.mount(host);
  return { app, port, host, changes, view: app.dom.editorView };
}

describe('EditorPort surface (pre-mount tolerance)', () => {
  it('every method no-ops / returns the empty shape before mount()', () => {
    const port = createCodeMirrorEditor(makeApp());
    expect(port.getValue()).toBe('');
    expect(port.getSelection()).toEqual({ start: 0, end: 0, text: '' });
    expect(port.hasFocus()).toBe(false);
    expect(port.focus()).toBeUndefined();
    expect(port.insertAtCursor('x')).toBeUndefined();
    expect(port.replaceDocument('y')).toBeUndefined();
    expect(port.revealOffset(3)).toBeUndefined();
    expect(port.syncFromState()).toBeUndefined();
    expect(port.refreshReference()).toBeUndefined(); // updates the pending lang ext, no view
    expect(port.destroy()).toBeUndefined();
  });
});

describe('mount / re-mount / destroy', () => {
  it('mounts a CM6 view showing the active tab and reparents on re-mount (same view, subscriptions intact)', () => {
    const app = makeApp();
    activeTab(app.state).sql = 'SELECT 1';
    const port = createCodeMirrorEditor(app);
    const seen = [];
    port.onDocChange((v) => seen.push(v));
    const a = document.createElement('div');
    port.mount(a);
    const view = app.dom.editorView;
    expect(a.querySelector('.cm-editor')).toBe(view.dom);
    expect(port.getValue()).toBe('SELECT 1');
    // renderApp re-run (sign-out → sign-in): new container, same live view.
    const b = document.createElement('div');
    port.mount(b);
    expect(app.dom.editorView).toBe(view);
    expect(b.querySelector('.cm-editor')).toBe(view.dom);
    expect(a.querySelector('.cm-editor')).toBe(null);
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    port.insertAtCursor('!');
    expect(seen).toEqual(['SELECT 1!']); // the pre-re-mount subscription still fires
  });

  it('destroy() is terminal: drops subscriptions and the view', () => {
    const { port, changes } = mounted();
    port.destroy();
    expect(port.getValue()).toBe('');
    expect(port.hasFocus()).toBe(false);
    port.insertAtCursor('x'); // no view — silent no-op, no emit
    expect(changes).toEqual([]);
    expect(port.destroy()).toBeUndefined(); // idempotent
  });
});

describe('document edits through the port', () => {
  it('insertAtCursor replaces the selection, moves the caret after the text, and emits', () => {
    const { port, view, app, changes } = mounted();
    port.replaceDocument('SELECT  FROM t');
    view.dispatch({ selection: { anchor: 7 } });
    port.insertAtCursor('count(*)');
    expect(port.getValue()).toBe('SELECT count(*) FROM t');
    expect(view.state.selection.main.head).toBe(15);
    expect(changes.at(-1)).toBe('SELECT count(*) FROM t');
    expect(activeTab(app.state).sql).toBe('SELECT count(*) FROM t');
  });

  it('replaceDocument replaces the whole doc with the caret at the end, preserving undo', () => {
    const { port, view } = mounted();
    port.replaceDocument('one');
    port.replaceDocument('two');
    expect(port.getValue()).toBe('two');
    expect(view.state.selection.main.head).toBe(3);
    undo(view);
    expect(port.getValue()).toBe('one'); // history survived the full replace
  });

  it('replaceDocument with identical text is a strict no-op (idempotent Format re-run)', () => {
    const { port, view, changes } = mounted();
    port.replaceDocument('SELECT\n    1\n');
    const depth = undoDepth(view.state);
    const emitted = changes.length;
    port.replaceDocument('SELECT\n    1\n');
    port.replaceDocument('SELECT\n    1\n');
    expect(port.getValue()).toBe('SELECT\n    1\n'); // never doubled
    expect(undoDepth(view.state)).toBe(depth);       // no phantom undo entries
    expect(changes.length).toBe(emitted);            // no phantom emits
  });

  it('getSelection reflects the CM selection; revealOffset clamps and moves the caret', () => {
    const { port, view } = mounted();
    port.replaceDocument('SELECT 1 FROM t');
    view.dispatch({ selection: { anchor: 0, head: 6 } });
    expect(port.getSelection()).toEqual({ start: 0, end: 6, text: 'SELECT' });
    port.revealOffset(9999);
    expect(view.state.selection.main.head).toBe(15); // clamped to doc length
    port.revealOffset(-5);
    expect(view.state.selection.main.head).toBe(0);
  });

  it('replaceDocument refocuses the editor so ⌘Z works right after a toolbar Format', async () => {
    const { port, view } = mounted();
    port.replaceDocument('SELECT 1');
    await Promise.resolve(); // the focus is microtask-deferred (happy-dom selectionchange re-entrancy)
    expect(document.activeElement).toBe(view.contentDOM);
    port.destroy();
    port.replaceDocument('x'); // and the deferred focus is view-guarded — no zombie focus after destroy
    await Promise.resolve();
  });

  it('hasFocus tracks the view focus state', () => {
    const { port, view } = mounted();
    expect(port.hasFocus()).toBe(view.hasFocus);
    port.focus();
    expect(port.hasFocus()).toBe(view.hasFocus);
  });
});

describe('global-chord bubbling (the ⌘↵ acceptance rule)', () => {
  it('plain Enter is handled by CM6; Mod-Enter bubbles out unprevented', () => {
    const { view } = mounted();
    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    view.contentDOM.dispatchEvent(enter);
    expect(enter.defaultPrevented).toBe(true); // newline — CM6 owns it
    const run = new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true });
    view.contentDOM.dispatchEvent(run);
    expect(run.defaultPrevented).toBe(false); // insertBlankLine stripped — reaches the document handler
  });

  it('Tab inserts two literal spaces (no completion open)', () => {
    const { port, view } = mounted();
    port.replaceDocument('a');
    view.dispatch({ selection: { anchor: 1 } });
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    view.contentDOM.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(true);
    expect(port.getValue()).toBe('a  ');
    expect(insertTwoSpaces(view)).toBe(true); // direct: always claims the key
  });
});

describe('per-tab EditorState (syncFromState)', () => {
  const addTab = (app, id, sqlText) => {
    const t = newTabObj(id);
    t.sql = sqlText;
    app.state.tabs.value = [...app.state.tabs.value, t];
    return t;
  };

  it('same tab + equal doc is a no-op that preserves the selection', () => {
    const { port, view, app, changes } = mounted();
    port.replaceDocument('SELECT 1');
    view.dispatch({ selection: { anchor: 3 } });
    const emitted = changes.length;
    port.syncFromState(); // the effect also fires on unrelated tab-list changes
    expect(view.state.selection.main.head).toBe(3);
    expect(changes.length).toBe(emitted);
    expect(activeTab(app.state).dirty).toBe(true); // untouched, not re-written
  });

  it('same tab + external tab.sql change reconciles the doc WITHOUT emitting (no false dirty)', () => {
    const { port, view, app, changes } = mounted();
    activeTab(app.state).sql = 'SELECT 42';
    port.syncFromState();
    expect(port.getValue()).toBe('SELECT 42');
    expect(changes).toEqual([]); // annotation-guarded — a sync is not a user edit
    undo(view);
    expect(port.getValue()).toBe('SELECT 42'); // the reconcile never entered the undo history
  });

  it('tab switches park and restore per-tab undo history', () => {
    const { port, view, app } = mounted();
    port.replaceDocument('tab one');
    addTab(app, 't2', 'tab two');
    app.state.activeTabId.value = 't2';
    port.syncFromState();
    expect(port.getValue()).toBe('tab two');
    expect(undoDepth(view.state)).toBe(0); // fresh tab, fresh history
    port.replaceDocument('tab two edited');
    app.state.activeTabId.value = 't1';
    port.syncFromState();
    expect(port.getValue()).toBe('tab one');
    undo(view);
    expect(port.getValue()).toBe(''); // t1's own history — the replace undone
    app.state.activeTabId.value = 't2';
    port.syncFromState();
    expect(port.getValue()).toBe('tab two edited'); // t2 state restored intact
    undo(view);
    expect(port.getValue()).toBe('tab two');
  });

  it('a restored tab reconciles an external tab.sql change silently', () => {
    const { port, app, changes } = mounted();
    addTab(app, 't2', 'two');
    app.state.activeTabId.value = 't2';
    port.syncFromState();
    app.state.activeTabId.value = 't1';
    port.syncFromState();
    app.state.tabs.value.find((t) => t.id === 't2').sql = 'two rewritten';
    const emitted = changes.length;
    app.state.activeTabId.value = 't2';
    port.syncFromState();
    expect(port.getValue()).toBe('two rewritten');
    expect(changes.length).toBe(emitted);
  });

  it('closing the shown tab drops its state instead of parking it', () => {
    const { port, app } = mounted();
    addTab(app, 't2', 'doomed');
    app.state.activeTabId.value = 't2';
    port.syncFromState();
    // close t2 while it is shown; t1 becomes active
    app.state.tabs.value = app.state.tabs.value.filter((t) => t.id !== 't2');
    app.state.activeTabId.value = 't1';
    port.syncFromState();
    expect(port.getValue()).toBe('');
    // re-open an unrelated tab with the recycled id — it must start fresh
    addTab(app, 't2', 'fresh');
    app.state.activeTabId.value = 't2';
    port.syncFromState();
    expect(port.getValue()).toBe('fresh');
  });

  it("a restored tab's parked selection is collapsed (no invisible run/export target)", () => {
    const { port, view, app } = mounted();
    port.replaceDocument('SELECT 1; SELECT 2');
    view.dispatch({ selection: { anchor: 10, head: 18 } }); // select 'SELECT 2'
    addTab(app, 't2', 'two');
    app.state.activeTabId.value = 't2';
    port.syncFromState();
    app.state.activeTabId.value = 't1';
    port.syncFromState();
    expect(port.getSelection()).toEqual({ start: 18, end: 18, text: '' }); // caret kept, range gone
  });

  it('an update mixing a user edit with a sync transaction still emits (tab.sql must not go stale)', () => {
    const { view, changes } = mounted();
    const user = view.state.update({ changes: { from: 0, to: 0, insert: 'user' } });
    const sync = user.state.update({ changes: { from: 0, to: 0, insert: 'x' }, annotations: syncTx.of(true) });
    view.update([user, sync]); // one coalesced view update, two transactions
    expect(changes).toEqual(['xuser']); // the user edit reached onDocChange
  });

  it('refreshReference() reconfigures the live view and parked states on restore', () => {
    const { port, app } = mounted();
    port.replaceDocument('select magicword from t');
    const t2 = newTabObj('t2');
    t2.sql = 'select 2';
    app.state.tabs.value = [...app.state.tabs.value, t2];
    app.state.activeTabId.value = 't2';
    port.syncFromState(); // t1 parked with the OLD dialect
    app.refData = assembleReferenceData({
      keywords: ['MAGICWORD', 'SELECT', 'FROM'],
      functions: { magicfn: { kind: 'fn', sig: 'magicfn()', ret: '', desc: '' } },
      formats: ['CSV'],
    });
    port.refreshReference(); // live view reconfigured
    app.state.activeTabId.value = 't1';
    port.syncFromState(); // restore re-applies the current dialect to the parked state
    expect(port.getValue()).toBe('select magicword from t');
    const kw = app.dom.editorView.dom.querySelectorAll('.sql-keyword');
    const texts = [...kw].map((n) => n.textContent);
    expect(texts).toContain('magicword'); // the new server keyword set took effect
  });
});

describe('langExtensionFor', () => {
  it('builds an empty-set dialect when refData is absent', () => {
    const ext = langExtensionFor({ refData: null });
    expect(Array.isArray(ext)).toBe(true);
    const st = EditorState.create({ doc: 'x', extensions: ext });
    expect(st.languageDataAt('closeBrackets', 0)[0]).toEqual({ brackets: ['(', '[', "'", '"', '`'] }); // quotes pair (editor-brackets.js parity)
  });
});

describe('completionSourceFor', () => {
  const ref = assembleReferenceData(null);
  const app = makeApp({
    completions: [
      { label: 'SELECT', kind: 'keyword', insert: 'SELECT', detail: 'keyword' },
      { label: 'sum', kind: 'agg', insert: 'sum()', caretBack: 1, detail: '()' },
      { label: 'trips', kind: 'table', insert: 'trips', detail: 'table', parent: 'db1' },
      { label: 'fare', kind: 'column', insert: 'fare', parent: 'trips' },
      { label: 'odd', kind: 'mystery', insert: 'odd' },
    ],
    refData: ref,
  });
  const src = completionSourceFor(app);
  const ctx = (doc, pos, explicit = false) => ({ state: EditorState.create({ doc }), pos, explicit });

  it('returns null before the first character unless explicit', () => {
    expect(src(ctx('', 0))).toBe(null);
    expect(src(ctx('', 0, true))).not.toBe(null); // Ctrl-Space on empty → keywords+tables
  });

  it('serves the core ranking unfiltered with our from/to', () => {
    const r = src(ctx('sel', 3));
    expect(r.filter).toBe(false);
    expect(r.from).toBe(0);
    expect(r.to).toBe(3);
    expect(r.options[0].label).toBe('SELECT');
    expect(r.options[0].type).toBe('keyword');
    expect(r.options.find((o) => o.label === 'odd')).toBeUndefined();
  });

  it('passes the kind through as the icon type and omits missing detail', () => {
    const r = src(ctx('odd', 3));
    const o = r.options.find((x) => x.label === 'odd');
    expect(o.type).toBe('mystery'); // unknown kinds render the base '·' chip via CSS
    expect(o.detail).toBeUndefined();
  });

  it('qualified table.column completion', () => {
    const r = src(ctx('SELECT trips.f', 14));
    expect(r.options.map((o) => o.label)).toEqual(['fare']);
  });

  it('an escaped backtick before the caret does not fake a closed identifier (no spurious popup)', () => {
    // Slicing AT the caret made the open `a\`b token end in a backtick, so it
    // read as CLOSED → word '' → a spurious keyword/table popup whose accept
    // would splice INSIDE the identifier. Slicing to line end keeps the
    // open-identifier word ('a\\`' — matches nothing) and stays silent.
    expect(src(ctx('SELECT `a\\`b` FROM trips', 11, true))).toBe(null);
  });

  it('returns null when nothing matches', () => {
    expect(src(ctx('zzzznope', 8))).toBe(null);
    expect(completionSourceFor(makeApp({ completions: undefined }))(ctx('se', 2))).toBe(null);
  });
});

describe('applyFor', () => {
  it('label-identical inserts use the default apply; differing inserts are strings', () => {
    expect(applyFor({ label: 'SELECT', insert: 'SELECT' })).toBeUndefined();
    expect(applyFor({ label: 'weird name', insert: '`weird name`' })).toBe('`weird name`');
  });

  it('caretBack items dispatch an edit that lands the caret between the parens', () => {
    const { view } = mounted();
    view.dispatch({ changes: { from: 0, to: 0, insert: 'su' }, selection: { anchor: 2 } });
    const apply = applyFor({ label: 'sum', insert: 'sum()', caretBack: 1 });
    apply(view, null, 0, 2);
    expect(view.state.doc.toString()).toBe('sum()');
    expect(view.state.selection.main.head).toBe(4); // between the parens
  });
});

describe('infoFor', () => {
  const ref = assembleReferenceData(null);
  it('keywords resolve the static doc as a DOM node (CM6 appendChild()s an info fn result)', () => {
    const app = makeApp({ refData: ref });
    const node = infoFor(app, { kind: 'keyword', label: 'FORMAT' })();
    expect(node.nodeType).toBe(1); // a bare string would throw in CM6's addInfoPane
    expect(node.textContent).toMatch(/output format/);
    expect(infoFor(app, { kind: 'keyword', label: 'ZZZ' })()).toBe(null);
    expect(infoFor(makeApp({ refData: null }), { kind: 'keyword', label: 'FORMAT' })()).toBe(null);
  });
  it('functions fetch lazily through app.entityDoc; empty doc → null', async () => {
    const app = makeApp({ entityDoc: vi.fn(async (n) => (n === 'sum' ? 'adds things' : '')) });
    const node = await infoFor(app, { kind: 'agg', label: 'sum' })();
    expect(node.nodeType).toBe(1);
    expect(node.textContent).toBe('adds things');
    await expect(infoFor(app, { kind: 'fn', label: 'nope' })()).resolves.toBe(null);
  });
  it('no entityDoc / other kinds → no info', () => {
    expect(infoFor(makeApp(), { kind: 'fn', label: 'sum' })).toBeUndefined();
    expect(infoFor(makeApp(), { kind: 'table', label: 't' })).toBeUndefined();
  });
});

describe('hoverSourceFor', () => {
  const ref = assembleReferenceData({
    keywords: ['PREWHERE'],
    functions: {
      described: { kind: 'fn', sig: 'described(x)', ret: 'UInt8', desc: 'has a doc' },
      bare: { kind: 'fn', sig: '', ret: '', desc: '' },
    },
    formats: ['CSV'],
  });

  it('returns null off-word or without refData', () => {
    const { view } = mounted({ refData: ref });
    const hover = hoverSourceFor({ refData: ref });
    view.dispatch({ changes: { from: 0, to: 0, insert: '   ' } });
    expect(hover(view, 1)).toBe(null); // whitespace
    expect(hoverSourceFor({ refData: null })(view, 1)).toBe(null);
  });

  it('unknown words get no tooltip; keywords get their static doc (multi-line offsets)', () => {
    const { view } = mounted({ refData: ref });
    const hover = hoverSourceFor({ refData: ref });
    // Line 3 — pins the line.from offset arithmetic (word lookup AND tooltip range)
    view.dispatch({ changes: { from: 0, to: 0, insert: '\n\nmystery PREWHERE' } });
    expect(hover(view, 4)).toBe(null);
    const tip = hover(view, 12);
    expect(tip.pos).toBe(10);
    expect(tip.end).toBe(18);
    expect(tip.create().dom.textContent).toMatch(/before reading other columns/);
  });

  it('functions show sig → ret + description; missing desc fetches via entityDoc', async () => {
    const entityDoc = vi.fn(async () => 'fetched doc');
    const { view } = mounted({ refData: ref });
    const hover = hoverSourceFor({ refData: ref, entityDoc });
    view.dispatch({ changes: { from: 0, to: 0, insert: 'described bare' } });
    const rich = hover(view, 3).create().dom;
    expect(rich.textContent).toContain('described(x)');
    expect(rich.textContent).toContain('→ UInt8');
    expect(rich.textContent).toContain('has a doc');
    expect(entityDoc).not.toHaveBeenCalled(); // desc already known — no fetch
    const lazy = hover(view, 12).create().dom;
    expect(lazy.textContent).toContain('bare()'); // sig fallback
    await Promise.resolve();
    expect(lazy.querySelector('.hover-doc').textContent).toBe('fetched doc');
    // no entityDoc injected → the empty desc just stays empty
    const noFetch = hoverSourceFor({ refData: ref })(view, 12).create().dom;
    expect(noFetch.querySelector('.hover-doc').textContent).toBe('');
  });
});

describe('handleDrop', () => {
  const evt = (data, coords = { clientX: 0, clientY: 0 }) => ({
    dataTransfer: { getData: (t) => data[t] || '' },
    preventDefault: vi.fn(),
    ...coords,
  });

  it('ignores events without dataTransfer or without our MIME types', () => {
    const { view, app } = mounted();
    expect(handleDrop(app, view, { dataTransfer: null })).toBe(false);
    const e = evt({ 'text/plain': 'hi' });
    expect(handleDrop(app, view, e)).toBe(false);
    expect(e.preventDefault).not.toHaveBeenCalled();
  });

  it('inserts a schema identifier at the pointer position (what dropCursor promised)', () => {
    const { view, app, changes } = mounted();
    view.dispatch({ changes: { from: 0, to: 0, insert: 'SELECT  FROM t' }, selection: { anchor: 0 } });
    view.posAtCoords = () => 7; // the pointer, not the parked caret
    const e = evt({ [IDENT_MIME]: 'fare' });
    expect(handleDrop(app, view, e)).toBe(true);
    expect(e.preventDefault).toHaveBeenCalled();
    expect(view.state.doc.toString()).toBe('SELECT fare FROM t');
    expect(view.state.selection.main.head).toBe(11); // caret after the dropped text
    expect(changes.at(-1)).toBe('SELECT fare FROM t'); // drop is a real edit — it emits
  });

  it('falls back to the caret when the identifier drop point maps to no position', () => {
    const { view, app } = mounted();
    view.dispatch({ changes: { from: 0, to: 0, insert: 'ab' }, selection: { anchor: 1 } });
    view.posAtCoords = () => null;
    expect(handleDrop(app, view, evt({ [IDENT_MIME]: 'X' }))).toBe(true);
    expect(view.state.doc.toString()).toBe('aXb');
  });

  it('drops a saved query as a subquery at the pointer position', () => {
    const { view, app } = mounted();
    view.dispatch({ changes: { from: 0, to: 0, insert: 'xx' }, selection: { anchor: 0 } });
    view.posAtCoords = () => 2; // pointer maps past the caret
    const e = evt({ [SUBQUERY_MIME]: 'SELECT 1' });
    expect(handleDrop(app, view, e)).toBe(true);
    expect(view.state.doc.toString()).toBe('xx(\nSELECT 1\n)');
    expect(view.state.selection.main.head).toBe(view.state.doc.length);
  });

  it('is wired into the view: real dragover/drop events route through the handlers', () => {
    const { view } = mounted();
    const over = new Event('dragover', { bubbles: true, cancelable: true });
    view.contentDOM.dispatchEvent(over);
    expect(over.defaultPrevented).toBe(true); // dragover accepts the drop target
    const drop = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(drop, 'dataTransfer', { value: { getData: (t) => (t === IDENT_MIME ? 'col1' : '') } });
    Object.defineProperty(drop, 'clientX', { value: 0 });
    Object.defineProperty(drop, 'clientY', { value: 0 });
    view.contentDOM.dispatchEvent(drop);
    expect(view.state.doc.toString()).toBe('col1');
  });

  it('falls back to the caret when the pointer maps to no position, and rejects an empty subquery', () => {
    const { view, app } = mounted();
    view.dispatch({ changes: { from: 0, to: 0, insert: 'ab' }, selection: { anchor: 1 } });
    view.posAtCoords = () => null;
    expect(handleDrop(app, view, evt({ [SUBQUERY_MIME]: 'SELECT 2' }))).toBe(true);
    expect(view.state.doc.toString()).toBe('a(\nSELECT 2\n)b');
    expect(handleDrop(app, view, evt({ [SUBQUERY_MIME]: '   ' }))).toBe(false);
  });
});

describe('reference-data lifecycle', () => {
  it('mount resolves the dialect lazily — refData assigned after the factory still paints (createApp order)', () => {
    const app = makeApp({ refData: null });
    const port = createCodeMirrorEditor(app); // createApp builds the port BEFORE assembling refData
    app.refData = assembleReferenceData(null); // …then assigns the built-in fallback pre-render
    activeTab(app.state).sql = 'select 1 from t';
    const host = document.createElement('div');
    document.body.appendChild(host);
    port.mount(host);
    const kw = [...app.dom.editorView.dom.querySelectorAll('.sql-keyword')].map((n) => n.textContent);
    expect(kw).toContain('select'); // NOT an empty dialect at first paint
  });

  it('camelCase server function names highlight (dialect words are lowercased on both sides)', () => {
    const app = makeApp({
      refData: assembleReferenceData({
        keywords: ['SELECT', 'FROM'],
        functions: { toDateTime: { kind: 'fn', sig: 'toDateTime(x)', ret: '', desc: '' } },
        formats: ['CSV'],
      }),
    });
    const port = createCodeMirrorEditor(app);
    activeTab(app.state).sql = 'select toDateTime(x) from t';
    const host = document.createElement('div');
    document.body.appendChild(host);
    port.mount(host);
    const fns = [...app.dom.editorView.dom.querySelectorAll('.sql-func')].map((n) => n.textContent);
    expect(fns).toContain('toDateTime'); // lang-sql looks words up lowercased
  });
});

describe('input guards (the old editor-brackets.js role)', () => {
  it('types a bare bracket inside strings/comments and defers elsewhere', () => {
    const { view } = mounted();
    view.dispatch({ changes: { from: 0, to: 0, insert: "SELECT 'a b' -- note" } });
    view.dispatch({ selection: { anchor: 10 } }); // inside the string
    expect(inputGuards(view, 10, 10, '(')).toBe(true);
    expect(view.state.doc.toString()).toBe("SELECT 'a (b' -- note"); // bare ( — no stray )
    const end = view.state.doc.length;
    view.dispatch({ selection: { anchor: end } }); // inside the trailing comment
    expect(inputGuards(view, end, end, '[')).toBe(true);
    expect(view.state.doc.toString().endsWith('note[')).toBe(true);
    view.dispatch({ selection: { anchor: 6 } }); // plain code → closeBrackets' turn
    expect(inputGuards(view, 6, 6, '(')).toBe(false);
    expect(inputGuards(view, 6, 6, 'x')).toBe(false); // not a pairing char at all
  });

  it('quotes stay quiet inside comments and backtick identifiers, and replace a selection inside a string', () => {
    const { view } = mounted();
    view.dispatch({ changes: { from: 0, to: 0, insert: '-- rock ' } });
    view.dispatch({ selection: { anchor: 8 } });
    expect(inputGuards(view, 8, 8, "'")).toBe(true); // no '' pair in the comment
    expect(view.state.doc.toString()).toBe("-- rock '");
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "SELECT 'hello world'" }, selection: { anchor: 14, head: 19 } }); // 'world' selected
    expect(inputGuards(view, 14, 19, "'")).toBe(true); // replaced, not wrapped
    expect(view.state.doc.toString()).toBe("SELECT 'hello ''");
    // in plain code a quote defers to closeBrackets (pairing/wrapping is its job)
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: 'abc' }, selection: { anchor: 0 } });
    expect(inputGuards(view, 0, 0, "'")).toBe(false);
  });

  it('steps over a pre-existing closer or quote (not just pairs CM6 inserted itself)', () => {
    const { view } = mounted();
    view.dispatch({ changes: { from: 0, to: 0, insert: "f(x)'s'" } });
    view.dispatch({ selection: { anchor: 3 } }); // before the )
    expect(inputGuards(view, 3, 3, ')')).toBe(true);
    expect(view.state.doc.toString()).toBe("f(x)'s'"); // nothing inserted…
    expect(view.state.selection.main.head).toBe(4);    // …caret stepped over
    view.dispatch({ selection: { anchor: 6 } }); // before the closing quote
    expect(inputGuards(view, 6, 6, "'")).toBe(true);
    expect(view.state.doc.toString()).toBe("f(x)'s'");
    expect(view.state.selection.main.head).toBe(7);
  });

  it('bails out like closeBrackets does: multi-char input, readOnly, or a range that is not the selection', () => {
    const { view } = mounted();
    view.dispatch({ changes: { from: 0, to: 0, insert: "'ab'" }, selection: { anchor: 2 } });
    expect(inputGuards(view, 2, 2, '((')).toBe(false); // multi-char
    expect(inputGuards(view, 1, 1, '(')).toBe(false);  // range ≠ selection (browser-generated correction)
    const ro = new (view.constructor)({ state: EditorState.create({ doc: "'a'", extensions: [EditorState.readOnly.of(true)] }) });
    expect(inputGuards(ro, 1, 1, '(')).toBe(false);    // readOnly
    ro.destroy();
  });

  it('hover stays quiet inside strings and comments (no phantom docs over prose)', () => {
    const ref = assembleReferenceData(null);
    const { view } = mounted({ refData: ref });
    view.dispatch({ changes: { from: 0, to: 0, insert: "SELECT 'count' -- count rows" } });
    const hover = hoverSourceFor({ refData: ref });
    expect(hover(view, 10)).toBe(null); // 'count' inside the string
    expect(hover(view, 20)).toBe(null); // 'count' inside the comment
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: 'SELECT count(x)' } });
    expect(hover(view, 9)).not.toBe(null); // the real call still documents
  });

  it('hover resolves function names case-insensitively (SQL calls are case-insensitive)', () => {
    const ref = assembleReferenceData({
      keywords: ['SELECT'],
      functions: { sum: { kind: 'agg', sig: 'sum(x)', ret: '', desc: 'adds' } },
      formats: ['CSV'],
    });
    const { view } = mounted({ refData: ref });
    view.dispatch({ changes: { from: 0, to: 0, insert: 'SELECT SUM(x)' } });
    const tip = hoverSourceFor({ refData: ref })(view, 9);
    expect(tip).not.toBe(null);
    expect(tip.create().dom.textContent).toContain('sum(x)');
  });
});
