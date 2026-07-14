import { describe, expect, it, vi } from 'vitest';
import { EditorState } from '@codemirror/state';
import { json } from '@codemirror/lang-json';
import { foldCode } from '@codemirror/language';
import { undo, undoDepth } from '@codemirror/commands';
import { openSearchPanel } from '@codemirror/search';
import { createState, activeTab, newTabObj, setTabSpecDraft } from '../../src/state.js';
import { createQuerySpecValidationService } from '../../src/core/spec-schema.js';
import {
  createNoopSpecEditor, createSpecEditor, jsonPathRanges,
} from '../../src/editor/spec-editor.js';
import {
  createSpecCompletionSources, specCompletionSourceFor,
} from '../../src/editor/spec-completion-adapter.js';

const makeApp = () => ({
  state: createState({ loadStr: (key, fallback) => fallback, loadJSON: (key, fallback) => fallback }),
  dom: {}, document,
  specValidators: createQuerySpecValidationService(),
  specCompletionSources: createSpecCompletionSources(),
});

function mounted() {
  const app = makeApp();
  const port = createSpecEditor(app);
  const changes = [];
  port.onDocChange((text) => {
    changes.push(text);
    const tab = activeTab(app.state);
    tab.specText = text;
  });
  const host = document.createElement('div');
  document.body.appendChild(host);
  port.mount(host);
  return { app, port, host, view: app.dom.specEditorView, changes };
}

describe('Spec path source ranges', () => {
  it('maps object keys with dots and array indexes to value nodes', () => {
    const state = EditorState.create({
      doc: '{"a.b":[{"kind":"x"}],"plain":true}', extensions: [json()],
    });
    const ranges = jsonPathRanges(state);
    const text = state.doc.toString();
    const slice = (path) => {
      const range = ranges.get(JSON.stringify(path));
      return text.slice(range.from, range.to);
    };
    expect(slice([])).toBe(text);
    expect(slice(['a.b'])).toBe('[{"kind":"x"}]');
    expect(slice(['a.b', 0])).toBe('{"kind":"x"}');
    expect(slice(['a.b', 0, 'kind'])).toBe('"x"');
    expect(slice(['plain'])).toBe('true');
  });

  it('uses the last duplicate key, matching JSON.parse', () => {
    const state = EditorState.create({ doc: '{"x":1,"x":2}', extensions: [json()] });
    const range = jsonPathRanges(state).get('["x"]');
    expect(state.doc.sliceString(range.from, range.to)).toBe('2');
  });
});

describe('Spec editor adapter', () => {
  it('provides a complete safe no-op adapter', () => {
    const port = createNoopSpecEditor();
    const callback = vi.fn();
    expect(port.mount(document.createElement('div'))).toBeUndefined();
    expect(port.focus()).toBeUndefined();
    expect(port.requestMeasure()).toBeUndefined();
    expect(port.hasFocus()).toBe(false);
    expect(port.getValue()).toBe('');
    expect(port.getSelection()).toEqual({ start: 0, end: 0, text: '' });
    expect(port.insertAtCursor('x')).toBeUndefined();
    expect(port.replaceDocument('x')).toBeUndefined();
    expect(port.revealOffset(1)).toBeUndefined();
    expect(port.revealDiagnostic()).toBeUndefined();
    expect(port.setDiagnostics([])).toBeUndefined();
    expect(port.syncFromState()).toBeUndefined();
    expect(port.refreshReference()).toBeUndefined();
    const unsubscribe = port.onDocChange(callback);
    expect(unsubscribe()).toBeUndefined();
    expect(port.destroy()).toBeUndefined();
    expect(callback).not.toHaveBeenCalled();
  });

  it('tolerates every view-dependent operation before mount and after destroy', () => {
    const port = createSpecEditor(makeApp());
    expect(port.getValue()).toBe('');
    expect(port.getSelection()).toEqual({ start: 0, end: 0, text: '' });
    expect(port.hasFocus()).toBe(false);
    expect(port.focus()).toBeUndefined();
    expect(port.requestMeasure()).toBeUndefined();
    expect(port.insertAtCursor('x')).toBeUndefined();
    expect(port.replaceDocument('x')).toBeUndefined();
    expect(port.revealOffset(2)).toBeUndefined();
    expect(port.revealDiagnostic()).toBeUndefined();
    expect(port.syncFromState()).toBeUndefined();
    expect(port.destroy()).toBeUndefined();
  });

  it('mounts JSON with line numbers, reparents, and retains subscriptions', () => {
    const app = makeApp();
    setTabSpecDraft(activeTab(app.state), { name: 'Q', favorite: false });
    const port = createSpecEditor(app);
    const seen = [];
    port.onDocChange((text) => seen.push(text));
    const first = document.createElement('div');
    port.mount(first);
    const view = app.dom.specEditorView;
    expect(port.getValue()).toContain('"name": "Q"');
    expect(first.querySelector('.cm-lineNumbers')).not.toBeNull();
    const second = document.createElement('div');
    port.mount(second);
    expect(second.querySelector('.cm-editor')).toBe(view.dom);
    port.replaceDocument('{"name":"New"}');
    expect(seen).toEqual(['{"name":"New"}']);
  });

  it('supports selection insertion, focus, replacement, and clamped reveal', async () => {
    const { port, view, changes } = mounted();
    port.replaceDocument('{"name":"Q"}');
    view.dispatch({ selection: { anchor: 8, head: 11 } });
    port.insertAtCursor('"New"');
    expect(port.getValue()).toBe('{"name":"New"}');
    expect(port.getSelection()).toEqual({ start: 13, end: 13, text: '' });
    port.revealOffset(999);
    await Promise.resolve();
    expect(view.state.selection.main.head).toBe(view.state.doc.length);
    expect(port.hasFocus()).toBe(true);
    expect(changes.at(-1)).toBe('{"name":"New"}');
  });

  it('Format-style replacement remains undoable', () => {
    const { port, view } = mounted();
    port.replaceDocument('{"name":"Q"}');
    expect(undoDepth(view.state)).toBe(1);
    expect(undo(view)).toBe(true);
  });

  it('parks independent per-tab documents and undo histories', () => {
    const { app, port, view } = mounted();
    port.replaceDocument('{"name":"One"}');
    const second = newTabObj('t2');
    setTabSpecDraft(second, { name: 'Two' });
    app.state.tabs.value = [...app.state.tabs.value, second];
    app.state.activeTabId.value = 't2';
    port.syncFromState();
    port.replaceDocument('{"name":"Two edited"}');
    app.state.activeTabId.value = 't1';
    port.syncFromState();
    expect(port.getValue()).toContain('One');
    expect(undo(view)).toBe(true);
    app.state.activeTabId.value = 't2';
    port.syncFromState();
    expect(port.getValue()).toContain('Two edited');
    expect(undo(view)).toBe(true);
    expect(port.getValue()).toContain('Two');
  });

  it('prunes parked editor state when a tab closes', () => {
    const { app, port, view } = mounted();
    const second = newTabObj('t2');
    setTabSpecDraft(second, { name: 'Two' });
    app.state.tabs.value = [...app.state.tabs.value, second];
    app.state.activeTabId.value = 't2';
    port.syncFromState();
    port.replaceDocument('{"name":"Stale history"}');
    app.state.activeTabId.value = 't1';
    port.syncFromState();
    app.state.tabs.value = [app.state.tabs.value[0]];
    port.syncFromState();

    const replacement = newTabObj('t2');
    setTabSpecDraft(replacement, { name: 'Fresh' });
    app.state.tabs.value = [...app.state.tabs.value, replacement];
    app.state.activeTabId.value = 't2';
    port.syncFromState();
    expect(port.getValue()).toContain('Fresh');
    expect(undo(view)).toBe(false);
  });

  it('reconciles an external clean draft without emitting or entering history', () => {
    const { app, port, view, changes } = mounted();
    setTabSpecDraft(activeTab(app.state), { name: 'External' });
    port.syncFromState();
    expect(port.getValue()).toContain('External');
    expect(changes).toEqual([]);
    expect(undo(view)).toBe(false);
  });

  it('marks semantic/parse diagnostics, falls back to ancestors, and navigates', () => {
    const { port, view, host } = mounted();
    port.replaceDocument('{"panel":{"cfg":7}}');
    port.setDiagnostics([
      { path: ['panel', 'cfg', 'type'], severity: 'error', code: 'bad-type', message: 'Bad type' },
      { path: [], severity: 'warning', code: 'root-warning', message: 'Root warning' },
    ]);
    expect(host.querySelectorAll('.spec-diagnostic')).toHaveLength(2);
    expect(host.querySelector('[data-code="bad-type"]').textContent).toBe('7');
    port.revealDiagnostic(0);
    expect(view.state.selection.main.head).toBe(port.getValue().indexOf('7'));
    port.revealDiagnostic(99);
    port.setDiagnostics([{ path: [], severity: 'error', code: 'empty', message: 'Empty', offset: 99 }]);
    expect(host.querySelectorAll('.spec-diagnostic')).toHaveLength(1);
  });

  it('exposes local search and JSON folding', () => {
    const { view, host, port } = mounted();
    port.replaceDocument('{\n  "nested": {\n    "value": 1\n  }\n}');
    expect(openSearchPanel(view)).toBe(true);
    expect(host.querySelector('.cm-search')).not.toBeNull();
    view.dispatch({ selection: { anchor: 1 } });
    expect(foldCode(view)).toBe(true);
  });

  it('destroy drops the view and subscribers', () => {
    const { port, changes } = mounted();
    port.destroy();
    expect(port.getValue()).toBe('');
    expect(port.hasFocus()).toBe(false);
    port.replaceDocument('{}');
    expect(changes).toEqual([]);
  });

  it('builds schema completions from current app state and applies a property in one edit', () => {
    const { app, port, view, changes } = mounted();
    port.replaceDocument('{\n  "pa"\n}');
    changes.length = 0;
    const pos = port.getValue().indexOf('pa') + 2;
    const result = specCompletionSourceFor(app)({ state: view.state, pos, explicit: true });
    const panel = result.options.find((option) => option.label === 'panel');
    expect(panel.detail).toContain('object');
    expect(panel.info().textContent).toContain('Panel configuration');
    panel.apply(view, panel, result.from, result.to);
    expect(port.getValue()).toBe('{\n  "panel": {}\n}');
    expect(changes).toEqual(['{\n  "panel": {}\n}']);
    expect(undo(view)).toBe(true);
    expect(port.getValue()).toBe('{\n  "pa"\n}');
  });

  it('replaces only an existing key name and inserts a valid root property from an empty document', () => {
    const { app, port, view } = mounted();
    const source = specCompletionSourceFor(app);
    port.replaceDocument('{"pa":{}}');
    let result = source({ state: view.state, pos: 4, explicit: true });
    let panel = result.options.find((option) => option.label === 'panel');
    panel.apply(view, panel, result.from, result.to);
    expect(port.getValue()).toBe('{"panel":{}}');

    port.replaceDocument('{"pa": }');
    result = source({ state: view.state, pos: 4, explicit: true });
    panel = result.options.find((option) => option.label === 'panel');
    panel.apply(view, panel, result.from, result.to);
    expect(port.getValue()).toBe('{"panel": }');

    port.replaceDocument('');
    result = source({ state: view.state, pos: 0, explicit: true });
    const favorite = result.options.find((option) => option.label === 'favorite');
    favorite.apply(view, favorite, result.from, result.to);
    expect(port.getValue()).toBe('{\n  "favorite": false\n}');

    port.replaceDocument('{}');
    view.dispatch({ selection: { anchor: 1 } });
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    view.contentDOM.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(true);
    expect(port.getValue()).toBe('{  }');
  });

  it('applies finite values plainly and schema snippets as safe whole-object edits', () => {
    const { app, port, view } = mounted();
    const source = specCompletionSourceFor(app);
    const text = '{"panel":{"cfg":{"type":"l"}}}';
    port.replaceDocument(text);
    const pos = text.indexOf('"l"') + 2;
    const result = source({ state: view.state, pos, explicit: true });
    expect(result.options.find((option) => option.label === 'line').apply).toBe('"line"');
    const snippet = result.options.find((option) => option.label === 'Line chart skeleton');
    snippet.apply(view, snippet, result.from, result.to);
    expect(port.getValue()).toBe([
      '{"panel":{"cfg":{',
      '  "type": "line",',
      '  "x": 0,',
      '  "y": [',
      '    1',
      '  ],',
      '  "series": null',
      '}}}',
    ].join('\n'));
  });

  it('keeps the completion source quiet outside valid schema contexts', () => {
    const app = makeApp();
    const state = EditorState.create({ doc: '{} trailing', extensions: [json()] });
    expect(specCompletionSourceFor(app)({ state, pos: state.doc.length, explicit: true })).toBeNull();
    expect(specCompletionSourceFor({ ...app, specValidators: {} })({
      state: EditorState.create({ doc: '{}', extensions: [json()] }), pos: 1, explicit: true,
    })).toBeNull();
    const noMatch = EditorState.create({ doc: '{"view":"zzz"}', extensions: [json()] });
    expect(specCompletionSourceFor(app)({ state: noMatch, pos: 12, explicit: true })).toBeNull();
  });

  it('reads result columns/indexes and query parameters only from cached active-tab data', () => {
    const app = makeApp();
    const tab = activeTab(app.state);
    tab.lastSuccessfulResultColumns = [
      { name: 'event_time', type: 'DateTime' }, { name: 'requests', type: 'UInt64' },
    ];
    tab.result = { columns: [{ name: 'partial', type: 'String' }] };
    tab.sqlDraft = 'SELECT {year:UInt16} /*[ AND x = {origin:String} ]*/';
    const sources = createSpecCompletionSources();
    expect(sources.resultColumns({ context: { tab } })).toEqual([
      expect.objectContaining({ label: 'event_time', value: 'event_time', detail: 'DateTime' }),
      expect.objectContaining({ label: 'requests', value: 'requests', detail: 'UInt64' }),
    ]);
    expect(sources.resultColumnIndexes({ context: { tab } })).toEqual([
      expect.objectContaining({ label: '0', value: 0, detail: 'event_time · DateTime' }),
      expect.objectContaining({ label: '1', value: 1, detail: 'requests · UInt64' }),
    ]);
    expect(sources.queryParameters({ context: { tab } })).toEqual([
      expect.objectContaining({ label: 'year', detail: 'UInt16' }),
      expect.objectContaining({ label: 'origin', detail: 'String · optional' }),
    ]);
    expect(sources.resultColumns({ context: {} })).toEqual([]);
    expect(sources.queryParameters({ context: {} })).toEqual([]);
    expect(createSpecCompletionSources().resultColumns({ context: { tab: { lastSuccessfulResultColumns: [{ name: 'x' }] } } })[0])
      .toMatchObject({ documentation: 'x' });
    expect(createSpecCompletionSources().resultColumnIndexes({ context: { tab: { lastSuccessfulResultColumns: [{ name: 'x' }] } } })[0])
      .toMatchObject({ detail: 'x', documentation: 'x' });
    expect(createSpecCompletionSources().queryParameters({ context: { tab: { sqlDraft: '' } } })).toEqual([]);
    expect(createSpecCompletionSources().queryParameters({ context: { tab: {
      sqlDraft: 'CREATE VIEW v AS SELECT {ddl_only:String}, {mixed:String}; SELECT {mixed:UInt8}',
    } } })).toEqual([
      expect.objectContaining({ label: 'mixed', detail: 'UInt8' }),
    ]);
  });
});
