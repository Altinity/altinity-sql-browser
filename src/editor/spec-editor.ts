// Editable JSON CodeMirror adapter for saved-query Spec drafts. It deliberately
// owns no SQL behavior: no dialect/completion/schema loading/drag-drop. The app
// injects it separately from the SQL EditorPort as `app.specEditor`.

import type { EditorState as EditorStateType, TransactionSpec } from '@codemirror/state';
import { Annotation, EditorState, StateEffect, StateField, Transaction } from '@codemirror/state';
import type { DecorationSet } from '@codemirror/view';
import { Decoration, EditorView, keymap } from '@codemirror/view';
import {
  bracketMatching, foldGutter, foldKeymap, syntaxTree,
} from '@codemirror/language';
import { history, historyKeymap, defaultKeymap } from '@codemirror/commands';
import {
  acceptCompletion, autocompletion, closeBrackets, closeBracketsKeymap,
} from '@codemirror/autocomplete';
import { json } from '@codemirror/lang-json';
import type { SyntaxNode } from '@lezer/common';
import { activeTab } from '../state.js';
import type { AppState, QueryTab } from '../state.js';
import { codePresentationExtensions, codeSearchKeymap } from './codemirror-base.js';
import { specCompletionSourceFor } from './spec-completion-adapter.js';
import type { SpecCompletionApp } from './spec-completion-adapter.js';
import type { EditorSelection } from './editor-port.types.js';
import type { SpecDiagnostic, SpecEditorPort } from './spec-editor.types.js';

const syncTx = Annotation.define<boolean>();
const setDiagnosticMarks = StateEffect.define<SpecDiagnostic[]>();

function namedChildren(node: SyntaxNode): SyntaxNode[] {
  const children: SyntaxNode[] = [];
  const cursor = node.cursor();
  if (!cursor.firstChild()) return children;
  do {
    if (!cursor.type.isAnonymous) children.push(cursor.node);
  } while (cursor.nextSibling());
  return children;
}

type JsonPathSegment = string | number;
type JsonRange = { from: number; to: number };

const pathKey = (path: JsonPathSegment[]): string => JSON.stringify(path);
const jsonValueNames = new Set(['Object', 'Array', 'String', 'Number', 'True', 'False', 'Null']);
const isJsonValue = (node: SyntaxNode): boolean => jsonValueNames.has(node.name);

/** Build exact JSON path → value-node ranges from the current Lezer tree. */
export function jsonPathRanges(state: EditorStateType): Map<string, JsonRange> {
  const ranges = new Map<string, JsonRange>();
  const doc = state.doc;
  const visit = (node: SyntaxNode, path: JsonPathSegment[]): void => {
    ranges.set(pathKey(path), { from: node.from, to: node.to });
    if (node.name === 'Object') {
      for (const property of namedChildren(node).filter((child) => child.name === 'Property')) {
        const children = namedChildren(property);
        const nameNode = children.find((child) => child.name === 'PropertyName');
        const valueNode = children.find(isJsonValue);
        if (!nameNode || !valueNode) continue;
        let key: JsonPathSegment;
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

function rangeForDiagnostic(
  state: EditorStateType,
  diagnostic: SpecDiagnostic,
  pathRanges: Map<string, JsonRange> = jsonPathRanges(state),
): JsonRange {
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

const diagnosticField = StateField.define<DecorationSet>({
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
          // `String(...)`: `MarkDecorationSpec.attributes` is typed `string`-only
          // (no `undefined`); this matches the coercion `setAttribute` itself
          // would already apply to an omitted `diagnostic.code` — no behavior
          // change from the untyped original.
          attributes: { title: diagnostic.message, 'data-code': String(diagnostic.code) },
        }).range(range.from, range.to));
      }
      marks.sort((a, b) => a.from - b.from || a.to - b.to);
      value = Decoration.set(marks, true);
    }
    return value;
  },
  provide: (field) => EditorView.decorations.from(field),
});

const fullReplace = (state: EditorStateType, text: string): TransactionSpec => ({ changes: { from: 0, to: state.doc.length, insert: text } });
const syncAnnotations = () => [syncTx.of(true), Transaction.addToHistory.of(false)];

function insertTwoSpaces(view: EditorView): boolean {
  view.dispatch(view.state.replaceSelection('  '), { userEvent: 'input', scrollIntoView: true });
  return true;
}

export function createNoopSpecEditor(): SpecEditorPort {
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

/** The injected app controller's slice this adapter reads/writes: Spec
 *  completion's own app contract (state/document/specCompletionSources/
 *  specValidators), plus the `dom.specEditorView` handoff other app code
 *  reads (e.g. `requestMeasure` callers, tests). */
export interface SpecEditorApp extends SpecCompletionApp {
  dom: { specEditorView?: EditorView };
}

/** Create the injected editable Spec JSON adapter. */
export function createSpecEditor(app: SpecEditorApp): SpecEditorPort {
  const subscribers = new Set<(text: string) => void>();
  const tabStates = new Map<string, EditorStateType>();
  let view: EditorView | null = null;
  let shownTabId: string | null = null;
  let diagnostics: SpecDiagnostic[] = [];

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
  const freshState = (text: string): EditorStateType => EditorState.create({ doc: text, extensions: extensions() });
  const applyDiagnostics = (): void => {
    if (view) view.dispatch({ effects: setDiagnosticMarks.of(diagnostics) });
  };
  const focusSoon = (): void => {
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
    getSelection: (): EditorSelection => {
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
      const liveTabIds = new Set(app.state.tabs.value.map((tab: QueryTab) => tab.id));
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
