// Presentation shared by the editable SQL EditorPort and read-only code
// viewers (#213). Keep this module free of SQL/editor behavior: dialects,
// completion, hover, history, input guards, tab parking, and app state belong
// to their adapters.

import { Compartment } from '@codemirror/state';
import { EditorView, drawSelection, keymap, lineNumbers } from '@codemirror/view';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { search, searchKeymap } from '@codemirror/search';
import { tags } from '@lezer/highlight';

// Map CodeMirror language tokens onto the existing stylesheet classes. The
// editable SQL editor keeps its established classes; JSON/XML reuse the same
// theme without injecting a second palette into the single-file artifact.
export const codeHighlightStyle = HighlightStyle.define([
  { tag: tags.keyword, class: 'sql-keyword' },
  { tag: tags.standard(tags.name), class: 'sql-func' },
  { tag: tags.string, class: 'sql-string' },
  { tag: tags.special(tags.string), class: 'sql-ident' },
  { tag: [tags.propertyName, tags.attributeName], class: 'sql-ident' },
  { tag: tags.tagName, class: 'sql-func' },
  { tag: tags.number, class: 'sql-number' },
  { tag: tags.bool, class: 'sql-keyword' },
  { tag: tags.null, class: 'sql-keyword' },
  { tag: tags.comment, class: 'sql-comment' },
  { tag: [tags.operator, tags.angleBracket], class: 'sql-op' },
]);

export function codePresentationExtensions() {
  return [
    lineNumbers(),
    drawSelection(),
    syntaxHighlighting(codeHighlightStyle),
    search({ top: true }),
  ];
}

export const codeSearchKeymap = keymap.of(searchKeymap);

export function createWrapCompartment(enabled = false) {
  const compartment = new Compartment();
  const value = (wrap) => (wrap ? EditorView.lineWrapping : []);
  return {
    extension: compartment.of(value(enabled)),
    reconfigure: (wrap) => compartment.reconfigure(value(wrap)),
  };
}
