// Thin CodeMirror/app adapter for pure Spec completion.

import { analyzeParameterizedSources, fieldControls } from '../core/param-pipeline.js';
import { completeSpec } from '../core/spec-completion.js';
import { activeTab } from '../state.js';
import { specJsonContext } from './spec-json-context.js';

const columnsFor = (context) => context?.tab?.lastSuccessfulResultColumns || [];

/** App-state-backed dynamic sources. They only read already-cached data. */
export function createSpecCompletionSources() {
  return {
    resultColumns({ context }) {
      return columnsFor(context).map((column) => ({
        label: column.name, value: column.name, kind: 'column', detail: column.type,
        documentation: column.type ? `${column.name} · ${column.type}` : column.name,
      }));
    },
    resultColumnIndexes({ context }) {
      return columnsFor(context).map((column, index) => ({
        label: String(index), value: index, kind: 'column-index',
        detail: `${column.name}${column.type ? ` · ${column.type}` : ''}`,
        documentation: column.type ? `${column.name} · ${column.type}` : column.name,
      }));
    },
    queryParameters({ context }) {
      const tab = context?.tab;
      if (!tab) return [];
      const analysis = analyzeParameterizedSources([{
        id: tab.id || 'active', sql: tab.sqlDraft || '', bindPolicy: 'row-returning',
      }]);
      return fieldControls(analysis).map((field) => {
        const { name, type: declaredType, optional } = field;
        return {
          label: name, value: name, kind: 'parameter',
          detail: `${declaredType}${optional ? ' · optional' : ''}`,
          documentation: declaredType ? `${name} · ${declaredType}${optional ? ' · optional' : ''}` : name,
        };
      });
    },
  };
}

function nextSignificant(state, pos) {
  let at = pos;
  while (at < state.doc.length && /\s/.test(state.sliceDoc(at, at + 1))) at++;
  return state.sliceDoc(at, at + 1);
}

function propertyApply(cursor, descriptor) {
  return (view, _completion, from, to) => {
    if (cursor.editingExistingProperty) {
      view.dispatch({
        changes: { from, to, insert: JSON.stringify(descriptor.name) },
        userEvent: 'input.complete', scrollIntoView: true,
      });
      return;
    }
    const property = `${JSON.stringify(descriptor.name)}: ${descriptor.value}`;
    if (cursor.containerKind === 'root-empty') {
      const insert = `{\n  ${property}\n}`;
      const valueEnd = insert.indexOf(descriptor.value) + descriptor.value.length;
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert },
        selection: { anchor: valueEnd - descriptor.caretBack },
        userEvent: 'input.complete', scrollIntoView: true,
      });
      return;
    }
    const suffix = !['', '}', ','].includes(nextSignificant(view.state, to)) ? ',' : '';
    const insert = property + suffix;
    view.dispatch({
      changes: { from, to, insert },
      selection: { anchor: from + property.length - descriptor.caretBack },
      userEvent: 'input.complete', scrollIntoView: true,
    });
  };
}

function objectSnippetApply(descriptor) {
  return (view) => {
    const { from, to } = descriptor.range;
    const baseIndent = view.state.doc.lineAt(from).text.match(/^\s*/)?.[0] || '';
    const lines = JSON.stringify(descriptor.value, null, 2).split('\n');
    const insert = lines.map((line, index) => (index ? baseIndent + line : line)).join('\n');
    view.dispatch({
      changes: { from, to, insert }, selection: { anchor: from + insert.length },
      userEvent: 'input.complete', scrollIntoView: true,
    });
  };
}

function applyFor(cursor, item) {
  if (item.apply?.type === 'property') return propertyApply(cursor, item.apply);
  if (item.apply?.type === 'object-snippet') return objectSnippetApply(item.apply);
  return item.insert;
}

function infoFor(app, item) {
  if (!item.documentation) return undefined;
  return () => {
    const node = (app.document || document).createElement('div');
    node.className = 'spec-completion-info';
    node.textContent = item.documentation;
    return node;
  };
}

/** Stable CM CompletionSource; current tab/result/SQL are read per invocation. */
export function specCompletionSourceFor(app) {
  return (cmContext) => {
    const cursor = specJsonContext(cmContext.state, cmContext.pos);
    if (cursor.positionKind === 'none') return null;
    const schemaService = app.specValidators?.schemaService || app.specValidators;
    if (!schemaService || typeof schemaService.schemaAtPath !== 'function') return null;
    const context = { ...cursor, tab: activeTab(app.state) };
    const items = completeSpec({
      schemaService,
      rootValue: cursor.rootValue,
      path: cursor.path,
      positionKind: cursor.positionKind,
      partial: cursor.partial,
      existingKeys: cursor.existingKeys,
      existingItems: cursor.existingItems,
      explicit: cmContext.explicit,
      dynamicSources: app.specCompletionSources,
      context,
    });
    if (!items.length) return null;
    return {
      from: cursor.from,
      to: cursor.to,
      filter: false,
      options: items.map((item) => ({
        label: item.label,
        detail: item.detail || undefined,
        type: item.kind,
        deprecated: item.deprecated || undefined,
        apply: applyFor(cursor, item),
        info: infoFor(app, item),
      })),
    };
  };
}
