// Editable JSON CodeMirror adapter for saved-query Spec drafts. It deliberately
// owns no SQL behavior: no dialect/completion/schema loading/drag-drop. The app
// injects it separately from the SQL EditorPort as `app.specEditor`.

import { Annotation, EditorState, StateEffect, StateField, Transaction } from '@codemirror/state';
import { Decoration, EditorView, keymap } from '@codemirror/view';
import {
  bracketMatching, foldGutter, foldKeymap,
} from '@codemirror/language';
import { history, historyKeymap, defaultKeymap } from '@codemirror/commands';
import {
  acceptCompletion, autocompletion, closeBrackets, closeBracketsKeymap,
} from '@codemirror/autocomplete';
import { json } from '@codemirror/lang-json';
import { syntaxTree } from '@codemirror/language';
import { activeTab } from '../state.js';
import { codePresentationExtensions, codeSearchKeymap } from './codemirror-base.js';
import { specCompletionSourceFor } from './spec-completion-adapter.js';

const syncTx = Annotation.define();
const setDiagnosticMarks = StateEffect.define();

function namedChildren(node) {
  const children = [];
  const cursor = node.cursor();
  if (!cursor.firstChild()) return children;
  do {
    if (!cursor.type.isAnonymous) children.push(cursor.node);
  } while (cursor.nextSibling());
  return children;
}

const pathKey = (path) => JSON.stringify(path);
const jsonValueNames = new Set(['Object', 'Array', 'String', 'Number', 'True', 'False', 'Null']);
const isJsonValue = (node) => jsonValueNames.has(node.name);

/** Build exact JSON path → value-node ranges from the current Lezer tree. */
export function jsonPathRanges(state) {
  const ranges = new Map();
  const doc = state.doc;
  const visit = (node, path) => {
    ranges.set(pathKey(path), { from: node.from, to: node.to });
    if (node.name === 'Object') {
      for (const property of namedChildren(node).filter((child) => child.name === 'Property')) {
        const children = namedChildren(property);
        const nameNode = children.find((child) => child.name === 'PropertyName');
        const valueNode = children.find(isJsonValue);
        if (!nameNode || !valueNode) continue;
        let key;
        try { key = JSON.parse(doc.sliceString(nameNode.from, nameNode.to)); } catch { continue; }
        visit(valueNode, [...path, key]); // duplicate keys: last value wins, like JSON.parse
      }
    } else if (node.name === 'Array') {
      const values = namedChildren(node).filter(isJsonValue);
      values.forEach((child, index) => visit(child, [...path, index]));
    }
  };
  const root = namedChildren(syntaxTree(state).topNode).find(isJsonValue);
  if (root) visit(root, []);
  return ranges;
}

function rangeForDiagnostic(state, diagnostic, pathRanges = jsonPathRanges(state)) {
  if (diagnostic.offset != null) {
    const from = Math.max(0, Math.min(diagnostic.offset, state.doc.length));
    return state.doc.length === 0
      ? { from: 0, to: 0 }
      : { from: Math.min(from, state.doc.length - 1), to: Math.min(state.doc.length, from + 1) };
  }
  const path = [...(diagnostic.path || [])];
  while (path.length >= 0) {
    const range = pathRanges.get(pathKey(path));
    if (range) return range;
    if (!path.length) break;
    path.pop();
  }
  return state.doc.length ? { from: 0, to: 1 } : { from: 0, to: 0 };
}

const diagnosticField = StateField.define({
  create: () => Decoration.none,
  update(value, transaction) {
    value = value.map(transaction.changes);
    for (const effect of transaction.effects) {
      if (!effect.is(setDiagnosticMarks)) continue;
      const pathRanges = jsonPathRanges(transaction.state);
      const marks = [];
      for (const diagnostic of effect.value) {
        const range = rangeForDiagnostic(transaction.state, diagnostic, pathRanges);
        if (range.to <= range.from) continue;
        marks.push(Decoration.mark({
          class: `spec-diagnostic spec-diagnostic-${diagnostic.severity || 'error'}`,
          attributes: { title: diagnostic.message, 'data-code': diagnostic.code },
        }).range(range.from, range.to));
      }
      marks.sort((a, b) => a.from - b.from || a.to - b.to);
      value = Decoration.set(marks, true);
    }
    return value;
  },
  provide: (field) => EditorView.decorations.from(field),
});

const fullReplace = (state, text) => ({ changes: { from: 0, to: state.doc.length, insert: text } });
const syncAnnotations = () => [syncTx.of(true), Transaction.addToHistory.of(false)];

function insertTwoSpaces(view) {
  view.dispatch(view.state.replaceSelection('  '), { userEvent: 'input', scrollIntoView: true });
  return true;
}

export function createNoopSpecEditor() {
  return {
    mount() {}, destroy() {}, focus() {}, requestMeasure() {},
    hasFocus: () => false,
    getValue: () => '',
    getSelection: () => ({ start: 0, end: 0, text: '' }),
    insertAtCursor() {}, replaceDocument() {}, revealOffset() {}, syncFromState() {},
    refreshReference() {}, setDiagnostics() {}, revealDiagnostic() {},
    onDocChange: () => () => {},
  };
}

/** Create the injected editable Spec JSON adapter. */
export function createSpecEditor(app) {
  const subscribers = new Set();
  const tabStates = new Map();
  let view = null;
  let shownTabId = null;
  let diagnostics = [];

  const extensions = () => [
    ...codePresentationExtensions(),
    json(),
    history(),
    foldGutter(),
    bracketMatching(),
    closeBrackets(),
    autocompletion({ override: [specCompletionSourceFor(app)] }),
    diagnosticField,
    codeSearchKeymap,
    keymap.of([
      { key: 'Tab', run: acceptCompletion },
      { key: 'Tab', run: insertTwoSpaces },
      ...closeBracketsKeymap,
      ...foldKeymap,
      ...historyKeymap,
      ...defaultKeymap.filter((binding) => binding.key !== 'Mod-Enter' && binding.key !== 'Escape'),
    ]),
    EditorView.updateListener.of((update) => {
      if (update.docChanged && !update.transactions.every((tr) => tr.annotation(syncTx))) {
        const text = update.state.doc.toString();
        for (const callback of subscribers) callback(text);
      }
    }),
  ];
  const freshState = (text) => EditorState.create({ doc: text, extensions: extensions() });
  const applyDiagnostics = () => {
    if (view) view.dispatch({ effects: setDiagnosticMarks.of(diagnostics) });
  };
  const focusSoon = () => {
    const current = view;
    queueMicrotask(() => {
      if (view === current) current?.focus();
    });
  };

  return {
    mount(container) {
      if (!view) {
        const tab = activeTab(app.state);
        shownTabId = tab.id;
        view = new EditorView({ state: freshState(tab.specText) });
        applyDiagnostics();
      }
      app.dom.specEditorView = view;
      container.replaceChildren(view.dom);
    },
    destroy() {
      subscribers.clear();
      tabStates.clear();
      if (view) view.destroy();
      view = null;
    },
    focus: () => { if (view) view.focus(); },
    requestMeasure: () => { if (view) view.requestMeasure(); },
    hasFocus: () => !!view && view.hasFocus,
    getValue: () => (view ? view.state.doc.toString() : ''),
    getSelection: () => {
      if (!view) return { start: 0, end: 0, text: '' };
      const { from, to } = view.state.selection.main;
      return { start: from, end: to, text: view.state.sliceDoc(from, to) };
    },
    insertAtCursor(text) {
      if (!view) return;
      view.dispatch(view.state.replaceSelection(text), { userEvent: 'input.paste', scrollIntoView: true });
      focusSoon();
    },
    replaceDocument(text) {
      if (!view || view.state.doc.toString() === text) return;
      view.dispatch({ ...fullReplace(view.state, text), userEvent: 'input.replace', scrollIntoView: true });
      focusSoon();
    },
    revealOffset(pos) {
      if (!view) return;
      const offset = Math.max(0, Math.min(pos | 0, view.state.doc.length));
      view.dispatch({ selection: { anchor: offset }, scrollIntoView: true });
      focusSoon();
    },
    syncFromState() {
      if (!view) return;
      const liveTabIds = new Set(app.state.tabs.value.map((tab) => tab.id));
      for (const id of tabStates.keys()) {
        if (!liveTabIds.has(id)) tabStates.delete(id);
      }
      const tab = activeTab(app.state);
      if (shownTabId === tab.id) {
        if (view.state.doc.toString() !== tab.specText) {
          view.dispatch({ ...fullReplace(view.state, tab.specText), annotations: syncAnnotations() });
        }
        diagnostics = tab.specDiagnostics || [];
        applyDiagnostics();
        return;
      }
      if (shownTabId && liveTabIds.has(shownTabId)) tabStates.set(shownTabId, view.state);
      let next = tabStates.get(tab.id) || freshState(tab.specText);
      if (next.doc.toString() !== tab.specText) {
        next = next.update({ ...fullReplace(next, tab.specText), annotations: syncAnnotations() }).state;
      }
      shownTabId = tab.id;
      view.setState(next);
      diagnostics = tab.specDiagnostics || [];
      applyDiagnostics();
    },
    refreshReference() {},
    setDiagnostics(next) {
      diagnostics = [...(next || [])];
      applyDiagnostics();
    },
    revealDiagnostic(index = 0) {
      if (!view || !diagnostics[index]) return;
      const range = rangeForDiagnostic(view.state, diagnostics[index]);
      view.dispatch({ selection: { anchor: range.from }, scrollIntoView: true });
      focusSoon();
    },
    onDocChange(callback) {
      subscribers.add(callback);
      return () => subscribers.delete(callback);
    },
  };
}
