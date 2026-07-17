// Thin CodeMirror/app adapter for pure Spec completion.

import type { EditorState } from '@codemirror/state';
import type { Completion, CompletionResult } from '@codemirror/autocomplete';
import type { EditorView } from '@codemirror/view';
import { analyzeParameterizedSources, fieldControls } from '../core/param-pipeline.js';
import { completeSpec } from '../core/spec-completion.js';
import type {
  CompletionApply, CompletionItem, DynamicItem, DynamicSources, SchemaService,
} from '../core/spec-completion.js';
import { activeTab } from '../state.js';
import type { AppState } from '../state.js';
import { specJsonContext } from './spec-json-context.js';
import type { SpecJsonContext } from './spec-json-context.js';

/** One result column as `app.js` actually snapshots it into
 *  `tab.lastSuccessfulResultColumns` (a spread of the run result's column
 *  descriptors) — the shape this adapter and its dynamic sources read.
 *  NOTE: `state.ts`'s own `QueryTab.lastSuccessfulResultColumns` field is
 *  declared `string[]`, which does not match that runtime assignment; this
 *  adapter keeps its own accurate local view rather than importing (and
 *  propagating) that mismatched declaration — flagged out of scope for this
 *  leaf conversion, since `state.ts` isn't one of its files. */
interface ResultColumn {
  name: string;
  type?: string;
}

/** The structural subset of a `QueryTab` this adapter's dynamic sources read
 *  from the cursor `context` (opaque everywhere else — see
 *  `core/spec-completion.js`'s `DynamicProvider`). */
interface CompletionTab {
  id?: string;
  sqlDraft?: string;
  lastSuccessfulResultColumns?: ResultColumn[];
}

interface AdapterContext {
  tab?: CompletionTab | null;
}

const tabFrom = (context: unknown): CompletionTab | null | undefined => (context as AdapterContext | undefined)?.tab;

const columnsFor = (context: unknown): ResultColumn[] => tabFrom(context)?.lastSuccessfulResultColumns || [];

/**
 * App-state-backed dynamic sources. They only read already-cached data.
 * Each source's own parameter type only names `context` — the one field it
 * actually reads — rather than `DynamicProvider`'s complete args shape; a
 * function accepting fewer required parameters is assignable wherever the
 * complete shape is provided (real completion calls always supply it), and
 * this narrower shape is also what call sites that only care about a source's
 * own contract (like this module's tests) can call directly.
 */
export function createSpecCompletionSources(): {
  resultColumns(args: { context: unknown }): DynamicItem[];
  resultColumnIndexes(args: { context: unknown }): DynamicItem[];
  queryParameters(args: { context: unknown }): DynamicItem[];
} {
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
      const tab = tabFrom(context);
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

function nextSignificant(state: EditorState, pos: number): string {
  let at = pos;
  while (at < state.doc.length && /\s/.test(state.sliceDoc(at, at + 1))) at++;
  return state.sliceDoc(at, at + 1);
}

function propertyApply(
  cursor: SpecJsonContext,
  descriptor: Extract<CompletionApply, { type: 'property' }>,
): (view: EditorView, _completion: Completion, from: number, to: number) => void {
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

function objectSnippetApply(
  descriptor: Extract<CompletionApply, { type: 'object-snippet' }>,
): (view: EditorView) => void {
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

function applyFor(cursor: SpecJsonContext, item: CompletionItem): Completion['apply'] {
  if (item.apply?.type === 'property') return propertyApply(cursor, item.apply);
  if (item.apply?.type === 'object-snippet') return objectSnippetApply(item.apply);
  return item.insert;
}

function infoFor(app: SpecCompletionApp, item: CompletionItem): (() => Node) | undefined {
  const documentation = item.documentation;
  if (!documentation) return undefined;
  return () => {
    const node = (app.document || document).createElement('div');
    node.className = 'spec-completion-info';
    node.textContent = documentation;
    return node;
  };
}

/** The subset of `app.specValidators` this adapter reads: either the schema
 *  service directly, or a registry wrapping it in `.schemaService`
 *  (`core/spec-draft.js`'s untyped registry factory — see
 *  `createSpecValidatorRegistry`). Only `schemaAtPath` gates use here;
 *  `completeSpec` itself no-ops without it. */
interface SpecValidatorsLike {
  schemaService?: SchemaService;
  schemaAtPath?: SchemaService['schemaAtPath'];
  propertiesAtPath?: SchemaService['propertiesAtPath'];
  variantsAtPath?: SchemaService['variantsAtPath'];
}

/** The subset of the injected `app` controller this adapter reads. */
export interface SpecCompletionApp {
  state: AppState;
  document?: Document;
  specCompletionSources?: DynamicSources;
  specValidators?: SpecValidatorsLike | null;
}

/** One completion option this adapter hands to CM6, plus the extra
 *  `deprecated` tag `completeSpec` computes (not part of CM6's own
 *  `Completion` shape, but carried through unchanged from the pre-TS
 *  behavior). */
interface SpecCompletion extends Completion {
  deprecated?: boolean;
}

/**
 * The subset of CM6's `CompletionContext` this source reads — `state`, `pos`,
 * `explicit` — rather than the full class (which also demands
 * `tokenBefore`/`matchBefore`/`aborted`/`addEventListener`). The real class
 * satisfies this shape, so the returned function is still assignable
 * wherever a real `CompletionSource` is expected (`autocompletion({ override
 * })` — see spec-editor.js); tests can also call it directly with a plain
 * `{ state, pos, explicit }` object, as `CompletionContext`'s own docs
 * recommend for test code.
 */
export interface SpecCompletionContext {
  state: EditorState;
  pos: number;
  explicit: boolean;
}

/** Stable CM CompletionSource; current tab/result/SQL are read per invocation. */
export function specCompletionSourceFor(app: SpecCompletionApp): (cmContext: SpecCompletionContext) => CompletionResult | null {
  return (cmContext) => {
    const cursor = specJsonContext(cmContext.state, cmContext.pos);
    if (cursor.positionKind === 'none') return null;
    const validators = app.specValidators;
    const schemaService = validators?.schemaService || validators;
    if (!schemaService || typeof schemaService.schemaAtPath !== 'function') return null;
    const context = { ...cursor, tab: activeTab(app.state) };
    const items = completeSpec({
      // `as`: the runtime check above only confirms `schemaAtPath` exists;
      // `SpecValidatorsLike` intentionally keeps the other SchemaService
      // members optional since either shape of `app.specValidators` may
      // supply them (both real services always do).
      schemaService: schemaService as SchemaService,
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
      options: items.map((item): SpecCompletion => ({
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
