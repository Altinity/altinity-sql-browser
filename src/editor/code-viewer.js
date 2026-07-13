// A small, reusable read-only CodeMirror surface (#213). It deliberately has
// no EditorPort behavior: no app subscriptions, history, completion, hover,
// schema loading, drag/drop insertion, or editable key commands.

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

const LANGUAGES = {
  text: () => [],
  json,
  sql,
  xml,
  html: xml,
  markdown: () => [],
};

export function languageExtension(language = 'text') {
  const factory = LANGUAGES[language] || LANGUAGES.text;
  return factory();
}

export function createCodeViewer({
  parent,
  document: targetDocument = parent && parent.ownerDocument,
  text = '',
  language = 'text',
  wrap = false,
}) {
  const languageCompartment = new Compartment();
  const wrapping = createWrapCompartment(wrap);
  let view = new EditorView({
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
        languageCompartment.of(languageExtension(language)),
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
}
