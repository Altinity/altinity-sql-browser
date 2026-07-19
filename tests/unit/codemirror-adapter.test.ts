import { describe, it, expect, vi } from 'vitest';
import { undoDepth, undo } from '@codemirror/commands';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import {
  createCodeMirrorEditor, completionSourceFor, applyFor,
  infoFor, hoverSourceFor, openReferenceCommand, handleDrop, insertTwoSpaces, inputGuards, syncTx,
  loadScopeColumns,
} from '../../src/editor/codemirror-adapter.js';
import type { CodeMirrorEditorApp, DropEvent, SqlCompletionContext } from '../../src/editor/codemirror-adapter.js';
import { startCompletion, completionStatus } from '@codemirror/autocomplete';
import { createState, activeTab, newTabObj } from '../../src/state.js';
import { assembleReferenceData } from '../../src/core/completions.js';
import { IDENT_MIME, SUBQUERY_MIME, COLUMN_TYPE_MIME } from '../../src/ui/dnd-mime.js';
import { openDocEntry, closeDocPane } from '../../src/ui/doc-pane.js';
import type { DocPaneApp } from '../../src/ui/doc-pane.js';
import type { DocLookup, DocSummary } from '../../src/core/doc-types.js';

// The CM6 adapter runs against the REAL CodeMirror under happy-dom — no fake
// editor. Construction, dispatch, undo, and keymaps all work headless; only
// coordinate measurement doesn't, which is why the inner sources/handlers are
// exported and invoked directly where needed.

// A minimal `app` controller stub, narrowed to what the adapter reads: fresh
// state + a fresh dom bag (mount registers editorView into it), built-in
// reference data, and NO docSummary/docEntry by default (infoFor/hoverSourceFor
// still render the LOCAL functions-table content — #313 — they just never
// upgrade it, and "Open reference" quietly no-ops without an injected
// `openDocEntry` action too). Self-contained (not tests/helpers/fake-app.js, which
// isn't one of this change's files and doesn't statically declare the
// catalog.refData/completions/docSummary/docEntry members this adapter needs)
// — mirrors spec-editor.test.ts's own minimal `makeApp` for the same
// editor/* seam. `catalog` overrides merge onto the default stub (not a
// full-object replace), same convention as tests/helpers/fake-app.ts's own
// nested `conn`/`chCtx` merges — a caller overriding just `refData` (the
// common case) doesn't have to re-supply `completions`/`docSummary` too.
type Catalog = NonNullable<CodeMirrorEditorApp['catalog']>;
const makeApp = (over: Partial<Omit<CodeMirrorEditorApp, 'catalog'>> & { catalog?: Partial<Catalog> } = {}): CodeMirrorEditorApp => {
  const { catalog: catalogOver, ...rest } = over;
  return {
    state: createState({ loadStr: (key, fallback) => fallback, loadJSON: (key, fallback) => fallback }),
    dom: {},
    catalog: {
      refData: assembleReferenceData(null),
      completions: [],
      docSummary: undefined,
      docEntry: undefined,
      ...catalogOver,
    },
    actions: { loadColumns: vi.fn() },
    ...rest,
  };
};

// A `makeApp()` with the injected `openDocEntry` action bound the same way
// app.ts binds it — to the REAL ui/doc-pane.ts `openDocEntry(app, target)` —
// so "Open reference" (hover button, F1) actually opens the persistent pane
// instead of quietly no-opping. The pane's own required fields
// (document/prefs/CodeViewer) live on the same object, mirroring the real App.
const makeDocPaneApp = (over: Parameters<typeof makeApp>[0] = {}): CodeMirrorEditorApp => {
  const app = makeApp(over);
  const paneApp = app as unknown as DocPaneApp;
  paneApp.document = document;
  paneApp.prefs = { save: vi.fn() };
  paneApp.CodeViewer = vi.fn(() => ({
    setText: vi.fn(), setLanguage: vi.fn(), setWrap: vi.fn(), focus: vi.fn(), destroy: vi.fn(),
  }));
  app.openDocEntry = (target) => openDocEntry(paneApp, target);
  return app;
};

// Mount a fresh port + view; subscribe like app.js does (#143) so tab.sqlDraft
// tracks the view.
function mounted(over: Parameters<typeof makeApp>[0] = {}) {
  const app = makeApp(over);
  const port = createCodeMirrorEditor(app);
  const changes: string[] = [];
  port.onDocChange((v) => {
    changes.push(v);
    const tab = activeTab(app.state);
    tab.sqlDraft = v;
    tab.dirtySql = true;
  });
  const host = document.createElement('div');
  document.body.appendChild(host);
  port.mount(host);
  // `!`: `mount()` above always assigns a live view synchronously.
  return { app, port, host, changes, view: app.dom.sqlEditorView! };
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
    activeTab(app.state).sqlDraft = 'SELECT 1';
    const port = createCodeMirrorEditor(app);
    const seen: string[] = [];
    port.onDocChange((v) => seen.push(v));
    const a = document.createElement('div');
    port.mount(a);
    const view = app.dom.sqlEditorView!;
    expect(a.querySelector('.cm-editor')).toBe(view.dom);
    expect(port.getValue()).toBe('SELECT 1');
    // renderApp re-run (sign-out → sign-in): new container, same live view.
    const b = document.createElement('div');
    port.mount(b);
    expect(app.dom.sqlEditorView).toBe(view);
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

  it('keeps the editable SQL surface and shared token classes after the base extraction', () => {
    const { port, view } = mounted();
    port.replaceDocument("SELECT count(*) FROM t WHERE n = 1 AND s = 'x'");
    expect(view.state.readOnly).toBe(false);
    expect(view.state.facet(EditorView.editable)).toBe(true);
    expect(view.contentDOM.getAttribute('contenteditable')).toBe('true');
    expect(view.dom.querySelector('.sql-keyword')?.textContent).toBe('SELECT');
    expect(view.dom.querySelector('.sql-string')?.textContent).toBe("'x'");
    expect(view.dom.querySelector('.cm-lineNumbers')).not.toBeNull();
    port.destroy();
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
    expect(activeTab(app.state).sqlDraft).toBe('SELECT count(*) FROM t');
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
  const addTab = (app: CodeMirrorEditorApp, id: string, sqlText: string) => {
    const t = newTabObj(id);
    t.sqlDraft = sqlText;
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
    expect(activeTab(app.state).dirtySql).toBe(true); // untouched, not re-written
  });

  it('same tab + external tab.sqlDraft change reconciles the doc WITHOUT emitting (no false dirty)', () => {
    const { port, view, app, changes } = mounted();
    activeTab(app.state).sqlDraft = 'SELECT 42';
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

  it('a restored tab reconciles an external tab.sqlDraft change silently', () => {
    const { port, app, changes } = mounted();
    addTab(app, 't2', 'two');
    app.state.activeTabId.value = 't2';
    port.syncFromState();
    app.state.activeTabId.value = 't1';
    port.syncFromState();
    // `!`: 't2' was just added above.
    app.state.tabs.value.find((t) => t.id === 't2')!.sqlDraft = 'two rewritten';
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

  it('an update mixing a user edit with a sync transaction still emits (tab.sqlDraft must not go stale)', () => {
    const { view, changes } = mounted();
    const user = view.state.update({ changes: { from: 0, to: 0, insert: 'user' } });
    const sync = user.state.update({ changes: { from: 0, to: 0, insert: 'x' }, annotations: syncTx.of(true) });
    view.update([user, sync]); // one coalesced view update, two transactions
    expect(changes).toEqual(['xuser']); // the user edit reached onDocChange
  });

  it('refreshReference() reconfigures the live view and parked states on restore', () => {
    const { port, app } = mounted();
    port.replaceDocument('select magicword from t');
    // t2's own SQL is irrelevant to this test — only used as a vehicle to
    // switch away from and back to t1 (no assertion ever reads t2's content).
    const t2 = newTabObj('t2');
    app.state.tabs.value = [...app.state.tabs.value, t2];
    app.state.activeTabId.value = 't2';
    port.syncFromState(); // t1 parked with the OLD dialect
    app.catalog!.refData = assembleReferenceData({
      keywords: ['MAGICWORD', 'SELECT', 'FROM'],
      functions: { magicfn: { kind: 'fn', sig: 'magicfn()', ret: '', desc: '' } },
      formats: ['CSV'],
    });
    port.refreshReference(); // live view reconfigured
    app.state.activeTabId.value = 't1';
    port.syncFromState(); // restore re-applies the current dialect to the parked state
    expect(port.getValue()).toBe('select magicword from t');
    const kw = app.dom.sqlEditorView!.dom.querySelectorAll('.sql-keyword');
    const texts = [...kw].map((n) => n.textContent);
    expect(texts).toContain('magicword'); // the new server keyword set took effect
  });
});

describe('completionSourceFor', () => {
  const ref = assembleReferenceData(null);
  const app = makeApp({
    catalog: {
      completions: [
        { label: 'SELECT', kind: 'keyword', insert: 'SELECT', detail: 'keyword' },
        { label: 'sum', kind: 'agg', insert: 'sum()', caretBack: 1, detail: '()' },
        { label: 'trips', kind: 'table', insert: 'trips', detail: 'table', parent: 'db1' },
        { label: 'fare', kind: 'column', insert: 'fare', parent: 'trips' },
        { label: 'odd', kind: 'mystery', insert: 'odd' },
      ],
      refData: ref,
    },
  });
  const src = completionSourceFor(app);
  const ctx = (doc: string, pos: number, explicit = false): SqlCompletionContext => ({ state: EditorState.create({ doc }), pos, explicit });

  it('returns null before the first character unless explicit', () => {
    expect(src(ctx('', 0))).toBe(null);
    expect(src(ctx('', 0, true))).not.toBe(null); // Ctrl-Space on empty → keywords+tables
  });

  it('serves the core ranking unfiltered with our from/to', () => {
    const r = src(ctx('sel', 3))!;
    expect(r.filter).toBe(false);
    expect(r.from).toBe(0);
    expect(r.to).toBe(3);
    expect(r.options[0].label).toBe('SELECT');
    expect(r.options[0].type).toBe('keyword');
    expect(r.options.find((o) => o.label === 'odd')).toBeUndefined();
  });

  it('passes the kind through as the icon type and omits missing detail', () => {
    const r = src(ctx('odd', 3))!;
    const o = r.options.find((x) => x.label === 'odd')!;
    expect(o.type).toBe('mystery'); // unknown kinds render the base '·' chip via CSS
    expect(o.detail).toBeUndefined();
  });

  it('qualified table.column completion', () => {
    const r = src(ctx('SELECT trips.f', 14))!;
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
    expect(completionSourceFor(makeApp({ catalog: { completions: undefined } }))(ctx('se', 2))).toBe(null);
  });

  it('is FROM-aware: an alias resolves to its table columns (#84)', () => {
    const scoped = makeApp({
      catalog: {
        completions: [
          { label: 'ts', kind: 'column', insert: 'ts', parent: 'events' },
          { label: 'other', kind: 'column', insert: 'other', parent: 'unrelated' },
        ],
        refData: ref,
      },
    });
    const s = completionSourceFor(scoped);
    // `e.` with `FROM events e` on the same line → events' columns, not unrelated
    const r = s(ctx('SELECT e. FROM events e', 9))!;
    expect(r.options.map((o) => o.label)).toEqual(['ts']);
  });

  it('never queries docSummary/docEntry while typing — only once the info is actually materialized (#313)', () => {
    const docSummary = vi.fn(async () => ({ status: 'unavailable' as const }));
    const docEntry = vi.fn(async () => ({ status: 'unavailable' as const }));
    const typingApp = makeApp({
      catalog: {
        completions: [
          { label: 'SELECT', kind: 'keyword', insert: 'SELECT', detail: 'keyword' },
          { label: 'sum', kind: 'agg', insert: 'sum()', caretBack: 1, detail: '()' },
        ],
        refData: ref,
        docSummary,
        docEntry,
      },
    });
    const typingSrc = completionSourceFor(typingApp);
    // Simulate a burst of keystrokes re-running the completion source.
    for (const text of ['s', 'su', 'sum', 'sum(']) typingSrc(ctx(text, text.length));
    expect(docSummary).not.toHaveBeenCalled();
    expect(docEntry).not.toHaveBeenCalled();
    // Only once CM6 actually materializes the 'sum' row's info (hover/focus)
    // does the shared summary helper ask the catalog for the rich version.
    const r = typingSrc(ctx('sum', 3))!;
    const sumOption = r.options.find((o) => o.label === 'sum')!;
    expect(docSummary).not.toHaveBeenCalled(); // building the option list itself still didn't query
    (sumOption.info as () => unknown)(); // CM6 materializing the info pane
    expect(docSummary).toHaveBeenCalledTimes(1);
    expect(docEntry).not.toHaveBeenCalled(); // docSummary alone — Open reference wasn't clicked
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
    if (typeof apply !== 'function') throw new Error('expected a function apply');
    // `null!`: this suite's own `_completion` arg is never read by applyFor's
    // returned function — see spec-editor.test.ts's identical convention.
    apply(view, null!, 0, 2);
    expect(view.state.doc.toString()).toBe('sum()');
    expect(view.state.selection.main.head).toBe(4); // between the parens
  });
});

// A `found` docSummary/docEntry fixture shared by the infoFor/hoverSourceFor
// upgrade tests below.
const describedTarget = { kind: 'function' as const, name: 'described' };
const foundSummary: DocLookup<DocSummary> = {
  status: 'found',
  value: {
    target: describedTarget, title: 'described', signature: 'described(x) -> UInt8',
    summary: 'The rich version-exact summary.', introducedIn: '24.3', aliasTo: 'other',
  },
};

describe('infoFor', () => {
  const ref = assembleReferenceData(null);
  it('keywords resolve the static doc as a DOM node (CM6 appendChild()s an info fn result)', () => {
    const app = makeApp({ catalog: { refData: ref } });
    const node = infoFor(app, { kind: 'keyword', label: 'FORMAT' })!() as Node;
    expect(node.nodeType).toBe(1); // a bare string would throw in CM6's addInfoPane
    expect(node.textContent).toMatch(/output format/);
    expect(infoFor(app, { kind: 'keyword', label: 'ZZZ' })!()).toBe(null);
    expect(infoFor(makeApp({ catalog: { refData: null } }), { kind: 'keyword', label: 'FORMAT' })!()).toBe(null);
  });
  it('a known function renders the local sig/ret/desc synchronously, then upgrades via docSummary (#313)', async () => {
    const functions = { sum: { kind: 'agg' as const, sig: 'sum(x)', ret: 'Float64', desc: 'adds things' } };
    const ref2 = assembleReferenceData({ keywords: [], functions, formats: [] });
    const docSummary = vi.fn(async () => foundSummary);
    const app = makeApp({ catalog: { refData: ref2, docSummary } });
    const node = infoFor(app, { kind: 'agg', label: 'sum' })!() as HTMLElement;
    document.body.appendChild(node); // "connected" for the async upgrade's isLive check
    expect(node.nodeType).toBe(1); // a DOM node, never a bare string
    expect(node.textContent).toContain('sum(x)');
    expect(node.textContent).toContain('→ Float64');
    expect(node.textContent).toContain('adds things');
    expect(docSummary).toHaveBeenCalledWith({ kind: 'aggregate-function', name: 'sum' });
    await Promise.resolve();
    await Promise.resolve();
    expect(node.textContent).toContain('described(x) -> UInt8'); // docSummary's richer signature won
    expect(node.textContent).toContain('The rich version-exact summary.');
    expect(node.textContent).toContain('since 24.3');
    expect(node.textContent).toContain('Alias of other');
    node.remove();
  });
  it('unknown identifier / other kinds → no info (the functions-table existence gate)', () => {
    expect(infoFor(makeApp(), { kind: 'fn', label: 'totallyUnknownName' })).toBeUndefined();
    expect(infoFor(makeApp({ catalog: { refData: null } }), { kind: 'fn', label: 'sum' })).toBeUndefined();
    expect(infoFor(makeApp(), { kind: 'table', label: 't' })).toBeUndefined();
  });
  it("Open reference button calls openDocEntry with the resolved target, when the app can open the pane", () => {
    const functions = { sum: { kind: 'agg' as const, sig: 'sum(x)', ret: '', desc: '' } };
    const ref2 = assembleReferenceData({ keywords: [], functions, formats: [] });
    const docEntry = vi.fn(async () => ({ status: 'unavailable' as const }));
    const app = makeDocPaneApp({ catalog: { refData: ref2, docEntry } });
    const node = infoFor(app, { kind: 'agg', label: 'sum' })!() as HTMLElement;
    document.body.appendChild(node);
    const btn = node.querySelector('.hover-open-ref') as HTMLButtonElement;
    expect(btn).toBeTruthy();
    expect(btn.tagName).toBe('BUTTON'); // a real, keyboard-activatable button
    btn.click();
    expect(docEntry).toHaveBeenCalledWith({ kind: 'aggregate-function', name: 'sum' });
    expect(document.querySelector('[role="complementary"]')).toBeTruthy(); // the pane opened
    node.remove();
    closeDocPane(app as unknown as DocPaneApp);
  });
  it('a column with a compacted type exposes the full declared type; an unchanged one stays quiet (#177)', () => {
    const full = "Enum8('started' = 1, 'running' = 2, 'done' = 3, 'failed' = 4)";
    const node = infoFor(makeApp(), { kind: 'column', label: 'state', detail: 'Enum8(4 values)', fullType: full })!() as Node;
    expect(node.nodeType).toBe(1); // a DOM node, as CM6's addInfoPane requires
    expect(node.textContent).toBe(full);
    // detail === fullType (nothing was hidden) → no info pane noise
    expect(infoFor(makeApp(), { kind: 'column', label: 'id', detail: 'UInt64', fullType: 'UInt64' })).toBeUndefined();
    // items without fullType (defensive) → no info
    expect(infoFor(makeApp(), { kind: 'column', label: 'id', detail: 'UInt64' })).toBeUndefined();
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
    const { view } = mounted({ catalog: { refData: ref } });
    const hover = hoverSourceFor(makeApp({ catalog: { refData: ref } }));
    view.dispatch({ changes: { from: 0, to: 0, insert: '   ' } });
    expect(hover(view, 1)).toBe(null); // whitespace
    expect(hoverSourceFor(makeApp({ catalog: { refData: null } }))(view, 1)).toBe(null);
  });

  it('unknown words get no tooltip; keywords get their static doc (multi-line offsets)', () => {
    const { view } = mounted({ catalog: { refData: ref } });
    const hover = hoverSourceFor(makeApp({ catalog: { refData: ref } }));
    // Line 3 — pins the line.from offset arithmetic (word lookup AND tooltip range)
    view.dispatch({ changes: { from: 0, to: 0, insert: '\n\nmystery PREWHERE' } });
    expect(hover(view, 4)).toBe(null);
    const tip = hover(view, 12)!;
    expect(tip.pos).toBe(10);
    expect(tip.end).toBe(18);
    expect(tip.create(view).dom.textContent).toMatch(/before reading other columns/);
  });

  it('functions show local sig → ret + description synchronously; docSummary upgrades in place (#313)', async () => {
    const docSummary = vi.fn(async () => foundSummary);
    const { view } = mounted({ catalog: { refData: ref } });
    const hover = hoverSourceFor(makeApp({ catalog: { refData: ref, docSummary } }));
    view.dispatch({ changes: { from: 0, to: 0, insert: 'described bare' } });
    const rich = hover(view, 3)!.create(view).dom;
    document.body.appendChild(rich); // "connected" so the async upgrade's isLive check passes
    expect(rich.textContent).toContain('described(x)');
    expect(rich.textContent).toContain('→ UInt8');
    expect(rich.textContent).toContain('has a doc');
    expect(docSummary).toHaveBeenCalledWith({ kind: 'function', name: 'described' });
    await Promise.resolve();
    await Promise.resolve();
    expect(rich.textContent).toContain('described(x) -> UInt8'); // upgraded signature
    expect(rich.textContent).toContain('The rich version-exact summary.');
    rich.remove();
    const lazy = hover(view, 12)!.create(view).dom;
    expect(lazy.textContent).toContain('bare()'); // sig fallback
    // no docSummary injected on THIS call → the empty desc just stays empty
    const noFetch = hoverSourceFor(makeApp({ catalog: { refData: ref } }))(view, 12)!.create(view).dom;
    expect(noFetch.querySelector('.hover-doc')!.textContent).toBe('');
  });

  it('degrades quietly (keeps the local fallback) when docSummary resolves missing/unavailable', async () => {
    const docSummary = vi.fn(async () => ({ status: 'unavailable' as const }));
    const { view } = mounted({ catalog: { refData: ref } });
    const hover = hoverSourceFor(makeApp({ catalog: { refData: ref, docSummary } }));
    view.dispatch({ changes: { from: 0, to: 0, insert: 'described' } });
    const dom = hover(view, 3)!.create(view).dom;
    await Promise.resolve();
    await Promise.resolve();
    expect(dom.textContent).toContain('described(x)'); // local content untouched
    expect(dom.textContent).toContain('has a doc');
  });

  it('a stale/detached tooltip node is never mutated once docSummary resolves late (no throw)', async () => {
    let resolveSummary!: (v: DocLookup<DocSummary>) => void;
    const docSummary = vi.fn(() => new Promise<DocLookup<DocSummary>>((res) => { resolveSummary = res; }));
    const { view } = mounted({ catalog: { refData: ref } });
    const hover = hoverSourceFor(makeApp({ catalog: { refData: ref, docSummary } }));
    view.dispatch({ changes: { from: 0, to: 0, insert: 'described' } });
    const dom = hover(view, 3)!.create(view).dom;
    // The caller (CM6) already threw this tooltip away — never attached to the doc.
    resolveSummary(foundSummary);
    await Promise.resolve();
    await Promise.resolve();
    expect(dom.textContent).toContain('described(x)'); // unmutated local content, no throw
    expect(dom.textContent).not.toContain('The rich version-exact summary.');
  });

  it('a torn-down editor view also blocks the async upgrade (view.dom.isConnected guard)', async () => {
    let resolveSummary!: (v: DocLookup<DocSummary>) => void;
    const docSummary = vi.fn(() => new Promise<DocLookup<DocSummary>>((res) => { resolveSummary = res; }));
    const { view, port } = mounted({ catalog: { refData: ref, docSummary } });
    const app = makeApp({ catalog: { refData: ref, docSummary } });
    view.dispatch({ changes: { from: 0, to: 0, insert: 'described' } });
    const hover = hoverSourceFor(app);
    const dom = hover(view, 3)!.create(view).dom;
    document.body.appendChild(dom); // dom itself stays connected…
    port.destroy(); // …but the owning editor is torn down
    resolveSummary(foundSummary);
    await Promise.resolve();
    await Promise.resolve();
    expect(dom.textContent).not.toContain('The rich version-exact summary.');
    dom.remove();
  });

  it("hover's Open reference button opens the pane with the resolved target", () => {
    const docEntry = vi.fn(async () => ({ status: 'unavailable' as const }));
    const app = makeDocPaneApp({ catalog: { refData: ref, docEntry } });
    const { view } = mounted(app);
    view.dispatch({ changes: { from: 0, to: 0, insert: 'described' } });
    const dom = hoverSourceFor(app)(view, 3)!.create(view).dom;
    document.body.appendChild(dom);
    const btn = dom.querySelector('.hover-open-ref') as HTMLButtonElement;
    btn.click();
    expect(docEntry).toHaveBeenCalledWith({ kind: 'function', name: 'described' });
    expect(document.querySelector('[role="complementary"]')).toBeTruthy();
    dom.remove();
    closeDocPane(app as unknown as DocPaneApp);
  });
});

describe('openReferenceCommand (F1, #313)', () => {
  const ref = assembleReferenceData({
    keywords: [], functions: { sum: { kind: 'agg', sig: 'sum(x)', ret: '', desc: '' } }, formats: [],
  });

  it('returns false (no target) with no refData, off-word, or an unknown identifier', () => {
    const { view } = mounted();
    view.dispatch({ changes: { from: 0, to: 0, insert: 'nope' } });
    expect(openReferenceCommand(makeApp({ catalog: { refData: null } }))(view)).toBe(false);
    expect(openReferenceCommand(makeApp({ catalog: { refData: ref } }))(view)).toBe(false); // 'nope' unknown
  });

  it('returns false inside a string/comment/quoted identifier (literal suppression)', () => {
    const { view } = mounted({ catalog: { refData: ref } });
    view.dispatch({ changes: { from: 0, to: 0, insert: "SELECT 'sum' -- sum" } });
    view.dispatch({ selection: { anchor: 10 } }); // inside the string 'sum'
    expect(openReferenceCommand(makeApp({ catalog: { refData: ref } }))(view)).toBe(false);
    view.dispatch({ selection: { anchor: 17 } }); // inside the trailing comment's 'sum'
    expect(openReferenceCommand(makeApp({ catalog: { refData: ref } }))(view)).toBe(false);
  });

  it('resolves a known function at selection.main.head, opens the pane, and returns true', () => {
    const docEntry = vi.fn(async () => ({ status: 'unavailable' as const }));
    const app = makeDocPaneApp({ catalog: { refData: ref, docEntry } });
    const { view } = mounted(app);
    view.dispatch({ changes: { from: 0, to: 0, insert: 'sum' }, selection: { anchor: 2 } });
    expect(openReferenceCommand(app)(view)).toBe(true);
    expect(docEntry).toHaveBeenCalledWith({ kind: 'aggregate-function', name: 'sum' });
    expect(document.querySelector('[role="complementary"]')).toBeTruthy();
    closeDocPane(app as unknown as DocPaneApp);
  });

  it('still returns true when a target resolves but no openDocEntry action is injected', () => {
    const { view } = mounted({ catalog: { refData: ref } });
    view.dispatch({ changes: { from: 0, to: 0, insert: 'sum' }, selection: { anchor: 2 } });
    expect(openReferenceCommand(makeApp({ catalog: { refData: ref } }))(view)).toBe(true);
  });

  it('is wired into the CM6 keymap: a real F1 keydown resolves through the same path', () => {
    const docEntry = vi.fn(async () => ({ status: 'unavailable' as const }));
    const app = makeDocPaneApp({ catalog: { refData: ref, docEntry } });
    const port = createCodeMirrorEditor(app);
    const host = document.createElement('div');
    document.body.appendChild(host);
    port.mount(host);
    const view = app.dom.sqlEditorView!;
    view.dispatch({ changes: { from: 0, to: 0, insert: 'sum' }, selection: { anchor: 2 } });
    const f1 = new KeyboardEvent('keydown', { key: 'F1', bubbles: true, cancelable: true });
    view.contentDOM.dispatchEvent(f1);
    expect(f1.defaultPrevented).toBe(true);
    expect(docEntry).toHaveBeenCalledWith({ kind: 'aggregate-function', name: 'sum' });
    closeDocPane(app as unknown as DocPaneApp);
    port.destroy();
  });
});

describe('handleDrop', () => {
  const evt = (data: Record<string, string>, coords: { clientX: number; clientY: number } = { clientX: 0, clientY: 0 }): DropEvent => ({
    dataTransfer: { getData: (t: string) => data[t] || '' },
    preventDefault: vi.fn(),
    ...coords,
  });

  /** A `posAtCoords` stub honoring CM6's real overloaded signature (its
   *  `precise: false` call form promises a non-null `number`; this suite
   *  never exercises that form, only the single-argument one that may
   *  return `null`) — simulates a pointer position, including "no position
   *  found" (`null`) for the coordinate-fallback tests. */
  function stubPosAtCoords(pos: number | null): EditorView['posAtCoords'] {
    function stub(coords: { x: number; y: number }, precise: false): number;
    function stub(coords: { x: number; y: number }): number | null;
    function stub(): number | null {
      return pos;
    }
    return stub;
  }

  it('ignores events without dataTransfer or without our MIME types', () => {
    const { view, app } = mounted();
    expect(handleDrop(app, view, { dataTransfer: null } as DropEvent)).toBe(false);
    const e = evt({ 'text/plain': 'hi' });
    expect(handleDrop(app, view, e)).toBe(false);
    expect(e.preventDefault).not.toHaveBeenCalled();
  });

  it('inserts a schema identifier at the pointer position (what dropCursor promised)', () => {
    const { view, app, changes } = mounted();
    view.dispatch({ changes: { from: 0, to: 0, insert: 'SELECT  FROM t' }, selection: { anchor: 0 } });
    view.posAtCoords = stubPosAtCoords(7); // the pointer, not the parked caret
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
    view.posAtCoords = stubPosAtCoords(null);
    expect(handleDrop(app, view, evt({ [IDENT_MIME]: 'X' }))).toBe(true);
    expect(view.state.doc.toString()).toBe('aXb');
  });

  it('inserts a column type at the pointer position, focuses the editor, and consumes the event once', () => {
    const { view, app, changes } = mounted();
    view.dispatch({ changes: { from: 0, to: 0, insert: '{operation:}' }, selection: { anchor: 0 } });
    view.posAtCoords = stubPosAtCoords(11); // between the ':' and the closing '}'
    const e = evt({ [COLUMN_TYPE_MIME]: "Enum16('Close' = -11, 'Error' = -1)" });
    expect(handleDrop(app, view, e)).toBe(true);
    expect(e.preventDefault).toHaveBeenCalledTimes(1);
    expect(view.state.doc.toString()).toBe("{operation:Enum16('Close' = -11, 'Error' = -1)}");
    expect(view.state.selection.main.head).toBe(11 + "Enum16('Close' = -11, 'Error' = -1)".length); // caret at the end of the inserted type
    expect(changes.at(-1)).toBe("{operation:Enum16('Close' = -11, 'Error' = -1)}"); // a real edit — it emits
  });

  it('falls back to the caret when a type-drop coordinate maps to no position', () => {
    const { view, app } = mounted();
    view.dispatch({ changes: { from: 0, to: 0, insert: 'ab' }, selection: { anchor: 1 } });
    view.posAtCoords = stubPosAtCoords(null);
    expect(handleDrop(app, view, evt({ [COLUMN_TYPE_MIME]: 'UInt64' }))).toBe(true);
    expect(view.state.doc.toString()).toBe('aUInt64b');
  });

  it('ignores an empty column-type payload', () => {
    const { view, app } = mounted();
    expect(handleDrop(app, view, evt({ [COLUMN_TYPE_MIME]: '' }))).toBe(false);
  });

  it('identifier precedence wins when both IDENT_MIME and COLUMN_TYPE_MIME are present', () => {
    const { view, app } = mounted();
    view.posAtCoords = stubPosAtCoords(0);
    const e = evt({ [IDENT_MIME]: 'col1', [COLUMN_TYPE_MIME]: 'UInt64' });
    expect(handleDrop(app, view, e)).toBe(true);
    expect(view.state.doc.toString()).toBe('col1');
  });

  it('drops a saved query as a subquery at the pointer position', () => {
    const { view, app } = mounted();
    view.dispatch({ changes: { from: 0, to: 0, insert: 'xx' }, selection: { anchor: 0 } });
    view.posAtCoords = stubPosAtCoords(2); // pointer maps past the caret
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
    Object.defineProperty(drop, 'dataTransfer', { value: { getData: (t: string) => (t === IDENT_MIME ? 'col1' : '') } });
    Object.defineProperty(drop, 'clientX', { value: 0 });
    Object.defineProperty(drop, 'clientY', { value: 0 });
    view.contentDOM.dispatchEvent(drop);
    expect(view.state.doc.toString()).toBe('col1');
  });

  it('falls back to the caret when the pointer maps to no position, and rejects an empty subquery', () => {
    const { view, app } = mounted();
    view.dispatch({ changes: { from: 0, to: 0, insert: 'ab' }, selection: { anchor: 1 } });
    view.posAtCoords = stubPosAtCoords(null);
    expect(handleDrop(app, view, evt({ [SUBQUERY_MIME]: 'SELECT 2' }))).toBe(true);
    expect(view.state.doc.toString()).toBe('a(\nSELECT 2\n)b');
    expect(handleDrop(app, view, evt({ [SUBQUERY_MIME]: '   ' }))).toBe(false);
  });
});

describe('reference-data lifecycle', () => {
  it('mount resolves the dialect lazily — refData assigned after the factory still paints (createApp order)', () => {
    const app = makeApp({ catalog: { refData: null } });
    const port = createCodeMirrorEditor(app); // createApp builds the port BEFORE assembling refData
    app.catalog!.refData = assembleReferenceData(null); // …then assigns the built-in fallback pre-render
    activeTab(app.state).sqlDraft = 'select 1 from t';
    const host = document.createElement('div');
    document.body.appendChild(host);
    port.mount(host);
    const kw = [...app.dom.sqlEditorView!.dom.querySelectorAll('.sql-keyword')].map((n) => n.textContent);
    expect(kw).toContain('select'); // NOT an empty dialect at first paint
  });

  it('camelCase server function names highlight (dialect words are lowercased on both sides)', () => {
    const app = makeApp({
      catalog: {
        refData: assembleReferenceData({
          keywords: ['SELECT', 'FROM'],
          functions: { toDateTime: { kind: 'fn', sig: 'toDateTime(x)', ret: '', desc: '' } },
          formats: ['CSV'],
        }),
      },
    });
    const port = createCodeMirrorEditor(app);
    activeTab(app.state).sqlDraft = 'select toDateTime(x) from t';
    const host = document.createElement('div');
    document.body.appendChild(host);
    port.mount(host);
    const fns = [...app.dom.sqlEditorView!.dom.querySelectorAll('.sql-func')].map((n) => n.textContent);
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
    const ro = new EditorView({ state: EditorState.create({ doc: "'a'", extensions: [EditorState.readOnly.of(true)] }) });
    expect(inputGuards(ro, 1, 1, '(')).toBe(false);    // readOnly
    ro.destroy();
  });

  it('hover stays quiet inside strings and comments (no phantom docs over prose)', () => {
    const ref = assembleReferenceData(null);
    const { view } = mounted({ catalog: { refData: ref } });
    view.dispatch({ changes: { from: 0, to: 0, insert: "SELECT 'count' -- count rows" } });
    const hover = hoverSourceFor(makeApp({ catalog: { refData: ref } }));
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
    const { view } = mounted({ catalog: { refData: ref } });
    view.dispatch({ changes: { from: 0, to: 0, insert: 'SELECT SUM(x)' } });
    const tip = hoverSourceFor(makeApp({ catalog: { refData: ref } }))(view, 9);
    expect(tip).not.toBe(null);
    expect(tip!.create(view).dom.textContent).toContain('sum(x)');
  });
});

describe('FROM-scope column loading (#84)', () => {
  // A schema with one FROM-able table whose columns aren't loaded yet.
  const withSchema = (over: Parameters<typeof makeApp>[0] = {}) => {
    const app = makeApp(over);
    app.state.schema.value = [{ db: 'app', tables: [{ name: 'events', columns: null }] }];
    return app;
  };
  const setDoc = (view: EditorView, text: string) => view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: text },
    selection: { anchor: text.length },
  });

  it('loadScopeColumns fetches the statement FROM tables whose columns are unloaded', async () => {
    const { app, view } = mounted();
    app.state.schema.value = [{ db: 'app', tables: [{ name: 'events', columns: null }] }];
    setDoc(view, 'SELECT x FROM events');
    const fetched = await loadScopeColumns(app, view);
    expect(fetched).toBe(true);
    expect(app.actions.loadColumns).toHaveBeenCalledWith('app', 'events');
  });

  it('loadScopeColumns is a no-op (no fetch) when nothing needs loading', async () => {
    const { app, view } = mounted();
    app.state.schema.value = [{ db: 'app', tables: [{ name: 'events', columns: [{ name: 'ts' }] }] }];
    setDoc(view, 'SELECT x FROM events');
    expect(await loadScopeColumns(app, view)).toBe(false);
    expect(app.actions.loadColumns).not.toHaveBeenCalled();
  });

  it('the debounced tick refreshes an OPEN completion once the columns arrive', async () => {
    vi.useFakeTimers();
    try {
      const app = withSchema({
        catalog: { completions: [{ label: 'ts', kind: 'column', insert: 'ts', parent: 'events' }] },
      });
      const port = createCodeMirrorEditor(app);
      const host = document.createElement('div');
      document.body.appendChild(host);
      port.mount(host);
      const view = app.dom.sqlEditorView!;
      // A user edit schedules the tick; an open completion is the refresh target.
      view.dispatch({ changes: { from: 0, to: 0, insert: 'SELECT t FROM events' }, selection: { anchor: 8 } });
      startCompletion(view);
      expect(completionStatus(view.state)).toBeTruthy(); // a completion session is live
      // Fire the tick AND flush the loadColumns promise chain → the guarded
      // refresh (view still live + completion open) re-runs the source.
      await vi.advanceTimersByTimeAsync(300);
      expect(app.actions.loadColumns).toHaveBeenCalledWith('app', 'events');
      expect(completionStatus(view.state)).toBeTruthy(); // stayed live through the refresh
      port.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('debounces the prefetch on user edits and coalesces a typing burst', async () => {
    vi.useFakeTimers();
    try {
      const { app, view } = mounted();
      app.state.schema.value = [{ db: 'app', tables: [{ name: 'events', columns: null }] }];
      // Two rapid edits: the second clears the first pending timer (coalesce).
      view.dispatch({ changes: { from: 0, to: 0, insert: 'SELECT x FROM eve' } });
      view.dispatch({ changes: { from: view.state.doc.length, to: view.state.doc.length, insert: 'nts' } });
      expect(app.actions.loadColumns).not.toHaveBeenCalled(); // nothing on the keystroke path
      // No completion open → the tick fetches but skips the dropdown refresh.
      await vi.advanceTimersByTimeAsync(300);
      expect(app.actions.loadColumns).toHaveBeenCalledTimes(1);
      expect(app.actions.loadColumns).toHaveBeenCalledWith('app', 'events');
    } finally {
      vi.useRealTimers();
    }
  });

  it('a pending prefetch timer is cleared on destroy (no fire after teardown)', () => {
    vi.useFakeTimers();
    try {
      const { app, port, view } = mounted();
      app.state.schema.value = [{ db: 'app', tables: [{ name: 'events', columns: null }] }];
      view.dispatch({ changes: { from: 0, to: 0, insert: 'SELECT x FROM events' } });
      port.destroy();
      vi.advanceTimersByTime(300);
      expect(app.actions.loadColumns).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
