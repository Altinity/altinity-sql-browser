import { describe, it, expect } from 'vitest';
import { EditorState } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import { EditorView, runScopeHandlers } from '@codemirror/view';
import { searchPanelOpen } from '@codemirror/search';
import { createCodeViewer, languageExtension } from '../../src/editor/code-viewer.js';

function mounted(over = {}) {
  const doc = over.document || document;
  const parent = over.parent || doc.createElement('div');
  if (!parent.parentNode) doc.body.appendChild(parent);
  const viewer = createCodeViewer({
    parent,
    document: doc,
    text: 'one\ntwo',
    language: 'text',
    wrap: false,
    ...over,
  });
  const view = EditorView.findFromDOM(parent.querySelector('.cm-editor'));
  return { parent, viewer, view };
}

describe('read-only code viewer', () => {
  it('mounts the complete supplied text with line numbers and permits selection', () => {
    const text = 'first\nsecond\nthird';
    const { parent, viewer, view } = mounted({ text });
    expect(view.state.doc.toString()).toBe(text);
    expect(parent.querySelectorAll('.cm-lineNumbers .cm-gutterElement')).toHaveLength(4); // spacer + 3 lines
    view.dispatch({ selection: { anchor: 1, head: 7 } });
    expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe('irst\ns');
    viewer.destroy();
  });

  it('is state-read-only, has a non-editable DOM, and installs no editing key commands', () => {
    const { viewer, view } = mounted();
    expect(view.state.readOnly).toBe(true);
    expect(view.state.facet(EditorView.editable)).toBe(false);
    expect(view.contentDOM.getAttribute('contenteditable')).toBe('false');
    expect(view.contentDOM.getAttribute('tabindex')).toBe('0');
    const enter = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true });
    expect(runScopeHandlers(view, enter, 'editor')).toBe(false);
    expect(view.state.doc.toString()).toBe('one\ntwo');
    viewer.destroy();
  });

  it('installs the local Mod-f search keymap and keeps the panel inside the viewer', () => {
    const { parent, viewer, view } = mounted();
    const event = (modifier) => new KeyboardEvent('keydown', {
      key: 'f', code: 'KeyF', [modifier]: true, bubbles: true, cancelable: true,
    });
    const handled = runScopeHandlers(view, event('ctrlKey'), 'editor')
      || runScopeHandlers(view, event('metaKey'), 'editor');
    expect(handled).toBe(true);
    expect(searchPanelOpen(view.state)).toBe(true);
    expect(parent.querySelector('.cm-panel.cm-search')).not.toBeNull();
    viewer.destroy();
  });

  it('toggles wrapping through a compartment without rebuilding the view', () => {
    const { parent, viewer, view } = mounted();
    expect(view.contentDOM.classList.contains('cm-lineWrapping')).toBe(false);
    viewer.setWrap(true);
    expect(EditorView.findFromDOM(parent.querySelector('.cm-editor'))).toBe(view);
    expect(view.contentDOM.classList.contains('cm-lineWrapping')).toBe(true);
    viewer.setWrap(false);
    expect(view.contentDOM.classList.contains('cm-lineWrapping')).toBe(false);
    viewer.destroy();
  });

  it('replaces text programmatically, preserves equal text as a no-op, and focuses', () => {
    const { viewer, view } = mounted();
    viewer.setText('replacement');
    expect(view.state.doc.toString()).toBe('replacement');
    const state = view.state;
    viewer.setText('replacement');
    expect(view.state).toBe(state);
    viewer.focus();
    expect(view.hasFocus).toBe(true);
    viewer.destroy();
  });

  it('loads JSON, SQL, XML, and XML-style HTML, then reconfigures language in place', () => {
    const cases = [
      ['json', '{"ok":true}', 'JsonText'],
      ['sql', 'SELECT 1', 'Script'],
      ['xml', '<root/>', 'Document'],
      ['html', '<html/>', 'Document'],
    ];
    for (const [language, text, rootName] of cases) {
      const { parent, viewer, view } = mounted({ language, text });
      expect(syntaxTree(view.state).type.name).toBe(rootName);
      viewer.setLanguage('text');
      expect(EditorView.findFromDOM(parent.querySelector('.cm-editor'))).toBe(view);
      expect(syntaxTree(view.state).length).toBe(0);
      viewer.destroy();
    }
  });

  it('uses no language extension for text, Markdown, or an unknown fallback', () => {
    for (const language of ['text', 'markdown', 'future-mode']) {
      const state = EditorState.create({ doc: '# source', extensions: languageExtension(language) });
      expect(syntaxTree(state).length).toBe(0);
    }
  });

  it('mounts every viewer node in the supplied detached document realm', () => {
    const detached = document.implementation.createHTMLDocument('detached');
    const parent = detached.createElement('div');
    detached.body.appendChild(parent);
    const { viewer, view } = mounted({ document: detached, parent, text: '{"x":1}', language: 'json' });
    expect(view.dom.ownerDocument).toBe(detached);
    expect(view.root).toBe(detached);
    expect(parent.querySelector('.cm-editor')).toBe(view.dom);
    viewer.destroy();
  });

  it('destroy is explicit and idempotent, and later method calls are safe no-ops', () => {
    const { parent, viewer } = mounted();
    viewer.destroy();
    expect(parent.querySelector('.cm-editor')).toBeNull();
    expect(viewer.destroy()).toBeUndefined();
    expect(viewer.setText('x')).toBeUndefined();
    expect(viewer.setLanguage('json')).toBeUndefined();
    expect(viewer.setWrap(true)).toBeUndefined();
    expect(viewer.focus()).toBeUndefined();
  });
});
