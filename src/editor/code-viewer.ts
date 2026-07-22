// A small, reusable read-only CodeMirror surface (#213). It deliberately has
// no EditorPort behavior: no app subscriptions, history, completion, hover,
// schema loading, drag/drop insertion, or editable key commands.

import type { Extension } from '@codemirror/state';
import { Compartment, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { json } from '@codemirror/lang-json';
import { sql } from '@codemirror/lang-sql';
import { xml } from '@codemirror/lang-xml';
import {
  codePresentationExtensions,
  codeSearchKeymap,
  createWrapCompartment,
} from './codemirror-base.js';
import type { CodeViewerFactory, CodeViewerHandle } from './code-viewer.types.js';

const LANGUAGES: Record<string, () => Extension> = {
  text: () => [],
  json,
  sql,
  xml,
  html: xml,
  markdown: () => [],
};

export function languageExtension(language = 'text'): Extension {
  const factory = LANGUAGES[language] || LANGUAGES.text;
  return factory();
}

export const createCodeViewer: CodeViewerFactory = ({
  parent,
  document: targetDocument = parent.ownerDocument,
  text = '',
  language = 'text',
  wrap = false,
  languageExtension: initialLanguageExtension,
}): CodeViewerHandle => {
  const languageCompartment = new Compartment();
  const wrapping = createWrapCompartment(wrap);
  let view: EditorView | null = new EditorView({
    parent,
    root: targetDocument,
    state: EditorState.create({
      doc: String(text),
      extensions: [
        EditorState.readOnly.of(true),
        EditorView.editable.of(false),
        // editable=false removes contenteditable and its implicit focusability.
        // Keep the read-only surface keyboard reachable for selection/copy and
        // the Mod-f search keymap.
        EditorView.contentAttributes.of({ tabindex: '0' }),
        ...codePresentationExtensions(),
        codeSearchKeymap,
        languageCompartment.of(initialLanguageExtension ?? languageExtension(language)),
        wrapping.extension,
      ],
    }),
  });
  // CM6 creates its wrapper through its module-realm `document`, but appending
  // to `parent` during construction makes the browser adopt it BEFORE CM6
  // initializes observers/listeners and reads `view.win`. happy-dom does not
  // implement that automatic cross-document adoption, so normalize ownership
  // afterward there; real browsers have already taken the first, critical path.
  if (view.dom.ownerDocument !== targetDocument) targetDocument.adoptNode(view.dom);
  if (view.dom.parentNode !== parent) parent.appendChild(view.dom);

  return {
    setText: (nextText) => {
      if (!view) return;
      const next = String(nextText);
      if (view.state.doc.length === next.length && view.state.doc.toString() === next) return;
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: next } });
    },
    setLanguage: (nextLanguage) => {
      if (view) view.dispatch({ effects: languageCompartment.reconfigure(languageExtension(nextLanguage)) });
    },
    setWrap: (enabled) => {
      if (view) view.dispatch({ effects: wrapping.reconfigure(!!enabled) });
    },
    focus: () => { if (view) view.focus(); },
    destroy: () => {
      if (!view) return;
      view.destroy();
      view = null;
    },
  };
};
