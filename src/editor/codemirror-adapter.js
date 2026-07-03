// The CodeMirror 6 EditorPort adapter (#21): replaces the hand-rolled
// textarea editor behind the #143 seam. CM6 owns the DOM — undo history,
// measured text, IME/touch, search panel, completion UI — while the app keeps
// talking through the same EditorPort, and the SQL knowledge stays pure in
// core (`completions.js` ranking, reference data). Injected via
// `createApp(env)` (`env.Editor`) exactly like the textarea adapter it
// replaces; app-level tests keep running on `createNoopPort`.
//
// Testing note: the adapter is unit-tested against the REAL CM6 under
// happy-dom (construct/dispatch/undo all work headless). The inner pieces —
// dialect builder, completion source, hover source, drop handler, Tab
// command — are exported for direct invocation where headless measurement
// (`coordsAtPos`/`posAtCoords`) makes event-driven coverage unreliable.

import { EditorState, Compartment, Annotation } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, drawSelection, dropCursor, hoverTooltip } from '@codemirror/view';
import { history, historyKeymap, defaultKeymap } from '@codemirror/commands';
import { bracketMatching, syntaxHighlighting, HighlightStyle } from '@codemirror/language';
import { sql, SQLDialect } from '@codemirror/lang-sql';
import { autocompletion, closeBrackets, closeBracketsKeymap, acceptCompletion } from '@codemirror/autocomplete';
import { search, searchKeymap } from '@codemirror/search';
import { tags } from '@lezer/highlight';
import { h } from '../ui/dom.js';
import { completionContext, rankCompletions, wordAt } from '../core/completions.js';
import { toSubquery } from '../core/format.js';
import { activeTab } from '../state.js';
import { IDENT_MIME, SUBQUERY_MIME } from '../ui/dnd-mime.js';

// Programmatic state syncs (tab switch, external tab.sql reconcile) must not
// reach onDocChange subscribers — the app-level subscriber writes tab.sql +
// dirty, and a tab switch dirtying the incoming tab would be a bug. User edits
// and port edits (insertAtCursor/replaceDocument/drop) DO emit, matching the
// textarea adapter's input-event semantics.
const syncTx = Annotation.define();

// Map the lang-sql token tags onto the EXISTING .sql-* stylesheet classes
// (styles.css) — token colors and light/dark theming stay in the stylesheet,
// zero duplicated color values. `class:` entries generate no CSS of their own.
const sqlClasses = HighlightStyle.define([
  { tag: tags.keyword, class: 'sql-keyword' },
  { tag: tags.standard(tags.name), class: 'sql-func' }, // dialect `builtin` = server function names
  { tag: tags.string, class: 'sql-string' },
  { tag: tags.special(tags.string), class: 'sql-ident' }, // `quoted` identifiers
  { tag: tags.number, class: 'sql-number' },
  { tag: tags.bool, class: 'sql-keyword' },
  { tag: tags.null, class: 'sql-keyword' },
  { tag: tags.comment, class: 'sql-comment' },
  { tag: tags.operator, class: 'sql-op' },
]);

// Completion kind → CM6 option `type`. Custom strings are fine — each renders
// as a .cm-completionIcon-<type> node the stylesheet gives a glyph + color,
// mirroring the old dropdown's K/ƒ/Σ/⇄/▦/▪/◈/≡ chips.
const CM_TYPE = {
  keyword: 'keyword', fn: 'fn', agg: 'agg', cast: 'cast',
  table: 'table', column: 'column', db: 'db', format: 'format',
};

/**
 * The ClickHouse-flavored SQL language extension for the current reference
 * data: server keywords/function names when loaded (#25), the built-in
 * fallback sets otherwise. Backticks and double quotes are identifier quotes
 * in ClickHouse; strings take backslash escapes. Auto-close stays limited to
 * `(` and `[` — quotes and `{` deliberately don't pair (parity with
 * core/editor-brackets.js; `{}` would fight the #134 `{name:Type}` variables).
 */
export function langExtensionFor(app) {
  const ref = app.refData;
  const dialect = SQLDialect.define({
    keywords: (ref ? ref.keywords : []).join(' ').toLowerCase(),
    builtin: Object.keys(ref ? ref.functions : {}).join(' '),
    backslashEscapes: true,
    identifierQuotes: '`"',
  });
  return [
    sql({ dialect }),
    dialect.language.data.of({ closeBrackets: { brackets: ['(', '['] } }),
  ];
}

/**
 * Completion source: CM6's UI over the pure core ranking (#26 parity v0).
 * `filter: false` keeps `rankCompletions`' order (CM6 would fuzzy-rescore and
 * dedup otherwise). Candidates come from `app.completions` at call time, so
 * schema/reference updates need no reconfigure. Never queries — `info` resolves
 * through app.entityDoc's lazy cache, and only for the row the user rests on.
 */
export function completionSourceFor(app) {
  return (ctx) => {
    const doc = ctx.state.doc.toString();
    const c = completionContext(doc, ctx.pos);
    if (!c.qualified && c.word.length < 1 && !ctx.explicit) return null;
    const items = rankCompletions(app.completions || [], c);
    if (!items.length) return null;
    return {
      from: c.from,
      to: c.to,
      filter: false,
      options: items.map((it) => ({
        label: it.label,
        detail: it.detail || undefined,
        type: CM_TYPE[it.kind] || 'fn',
        apply: applyFor(it),
        info: infoFor(app, it),
      })),
    };
  };
}

// How accepting a candidate edits the doc. Functions insert `name()` with the
// caret pulled between the parens (`caretBack`), so it needs a custom apply —
// a plain string apply would land the caret after the `)`.
export function applyFor(it) {
  if (!it.caretBack) return it.insert === it.label ? undefined : it.insert;
  return (view, _completion, from, to) => {
    view.dispatch({
      changes: { from, to, insert: it.insert },
      selection: { anchor: from + it.insert.length - it.caretBack },
      userEvent: 'input.complete',
    });
  };
}

// The active row's description: static keyword docs immediately, function
// docs lazily via app.entityDoc (cached, one query per name ever — #27).
// CM6 shows it as a side tooltip (the old dropdown used a footer). An `info`
// FUNCTION must yield a DOM node (a bare string is only legal when `info`
// itself is the string) — CM6's addInfoPane appendChild()s the result.
export function infoFor(app, it) {
  const doc = (text) => (text ? h('div', { class: 'cm-info-doc' }, text) : null);
  if (it.kind === 'keyword') {
    return () => doc(app.refData && app.refData.keywordDocs[it.label.toUpperCase()]);
  }
  if (it.kind === 'fn' || it.kind === 'agg' || it.kind === 'cast') {
    if (!app.entityDoc) return undefined;
    return () => Promise.resolve(app.entityDoc(it.label)).then(doc);
  }
  return undefined;
}

/**
 * Hover docs (#27 parity v0): keyword docs from the static set, function
 * signature + return type + lazily-fetched description. Signature help (the
 * caret-following arg highlighter) is dropped in v0 — #60 rebuilds docs
 * properly on this foundation.
 */
export function hoverSourceFor(app) {
  return (view, pos) => {
    const w = wordAt(view.state.doc.toString(), pos);
    if (!w || !app.refData) return null;
    const kwDoc = app.refData.keywordDocs[w.word.toUpperCase()];
    const fn = app.refData.functions[w.word];
    if (!kwDoc && !fn) return null;
    return {
      pos: w.from,
      end: w.to,
      create: () => {
        const dom = h('div', { class: 'hover-card hover-card-cm' });
        if (fn) {
          dom.appendChild(h('div', { class: 'hover-sig' }, fn.sig || w.word + '()',
            fn.ret ? h('span', { class: 'hover-ret' }, ' → ' + fn.ret) : null));
          const doc = h('div', { class: 'hover-doc' }, fn.desc || '');
          dom.appendChild(doc);
          if (!fn.desc && app.entityDoc) {
            Promise.resolve(app.entityDoc(w.word)).then((d) => { if (d) doc.textContent = d; });
          }
        } else {
          dom.appendChild(h('div', { class: 'hover-doc' }, kwDoc));
        }
        return { dom };
      },
    };
  };
}

/**
 * Drop handler for the app's drag sources (schema identifiers, saved/history
 * queries). Returns true when it consumed the event (so CM6's native text
 * drop can't double-insert). Exported for direct tests — happy-dom's
 * posAtCoords can't exercise the coordinate fallback via real events.
 */
export function handleDrop(app, view, e) {
  const dt = e.dataTransfer;
  if (!dt) return false;
  const ident = dt.getData(IDENT_MIME);
  if (ident) {
    e.preventDefault();
    view.dispatch(view.state.replaceSelection(ident), { userEvent: 'input.drop', scrollIntoView: true });
    view.focus();
    return true;
  }
  const sub = dt.getData(SUBQUERY_MIME);
  if (sub) {
    const text = toSubquery(sub);
    if (!text) return false;
    e.preventDefault();
    // Land at the pointer; fall back to the caret when the drop point doesn't
    // map to a text position.
    const at = view.posAtCoords({ x: e.clientX, y: e.clientY });
    const pos = at == null ? view.state.selection.main.head : at;
    view.dispatch({
      changes: { from: pos, to: pos, insert: text },
      selection: { anchor: pos + text.length },
      userEvent: 'input.drop',
      scrollIntoView: true,
    });
    view.focus();
    return true;
  }
  return false; // not our drag — leave native behavior alone
}

// Tab inserts two literal spaces (parity with the textarea editor — no indent
// magic); an open completion's Tab-accept is bound ahead of it.
export function insertTwoSpaces(view) {
  view.dispatch(view.state.replaceSelection('  '), { userEvent: 'input.type', scrollIntoView: true });
  return true;
}

/**
 * The CM6 editor behind the EditorPort seam. Port methods tolerate pre-mount
 * calls (no view yet → no-op / empty results). mount() is re-runnable: a
 * renderApp re-run (e.g. sign-out → sign-in) passes a fresh container and the
 * live view.dom is reparented into it — same view, same subscriptions, no
 * zombies. destroy() is terminal (see editor-port.js).
 * @returns {import('./editor-port.js').EditorPort}
 */
export function createCodeMirrorEditor(app) {
  const subs = new Set();
  const emit = (value) => { for (const cb of subs) cb(value); };
  const langCompartment = new Compartment();
  const tabStates = new Map(); // tabId → parked EditorState (per-tab undo)
  let langExt = langExtensionFor(app);
  let view = null;
  let shownTabId = null;

  const extensions = () => [
    lineNumbers(),
    history(),
    drawSelection(),
    dropCursor(),
    bracketMatching(),
    closeBrackets(),
    syntaxHighlighting(sqlClasses),
    langCompartment.of(langExt),
    autocompletion({ override: [completionSourceFor(app)] }),
    hoverTooltip(hoverSourceFor(app)),
    search({ top: true }),
    keymap.of([
      { key: 'Tab', run: acceptCompletion },
      { key: 'Tab', run: insertTwoSpaces },
      ...closeBracketsKeymap,
      ...searchKeymap,
      ...historyKeymap,
      // Global chords (⌘↵ run, ⌘⇧↵ format, ⌘S/⌘⇧S, Esc) live on the document
      // handler (main.js) — drop CM6's Mod-Enter (insertBlankLine) so ⌘↵
      // bubbles out unhandled instead of inserting a blank line.
      ...defaultKeymap.filter((b) => b.key !== 'Mod-Enter'),
    ]),
    EditorView.updateListener.of((u) => {
      if (u.docChanged && !u.transactions.some((tr) => tr.annotation(syncTx))) {
        emit(u.state.doc.toString());
      }
    }),
    EditorView.domEventHandlers({
      dragover: (e) => { e.preventDefault(); return false; },
      drop: (e, v) => handleDrop(app, v, e),
    }),
  ];

  const freshState = (doc) => EditorState.create({ doc, extensions: extensions() });

  return {
    mount: (container) => {
      if (!view) {
        const tab = activeTab(app.state); // state guarantees ≥1 tab
        shownTabId = tab.id;
        view = new EditorView({ state: freshState(tab.sql) });
        app.dom.editorView = view; // for e2e/debug reach-in; the app uses the port
      }
      container.replaceChildren(view.dom);
    },
    destroy: () => {
      subs.clear();
      tabStates.clear();
      if (view) view.destroy();
      view = null;
    },
    focus: () => { if (view) view.focus(); },
    hasFocus: () => !!view && view.hasFocus,
    getValue: () => (view ? view.state.doc.toString() : ''),
    getSelection: () => {
      if (!view) return { start: 0, end: 0, text: '' };
      const { from, to } = view.state.selection.main;
      return { start: from, end: to, text: view.state.sliceDoc(from, to) };
    },
    insertAtCursor: (text) => {
      if (!view) return;
      view.dispatch(view.state.replaceSelection(text), { userEvent: 'input.paste', scrollIntoView: true });
      view.focus();
    },
    replaceDocument: (text) => {
      if (!view) return;
      const cur = view.state.doc.toString();
      if (cur === text) return; // idempotent Format re-run — no edit, no undo entry
      view.dispatch({
        changes: { from: 0, to: cur.length, insert: text },
        selection: { anchor: text.length },
        userEvent: 'input.replace',
        scrollIntoView: true,
      });
    },
    revealOffset: (pos) => {
      if (!view) return;
      const p = Math.max(0, Math.min(pos | 0, view.state.doc.length));
      view.dispatch({ selection: { anchor: p }, scrollIntoView: true });
      view.focus();
    },
    syncFromState: () => {
      if (!view) return;
      const tab = activeTab(app.state);
      const ids = new Set(app.state.tabs.value.map((t) => t.id));
      for (const id of tabStates.keys()) if (!ids.has(id)) tabStates.delete(id); // closed tabs
      if (shownTabId === tab.id) {
        // Same tab (the effect also fires on unrelated tab-list changes):
        // reconcile only an external tab.sql change; equal doc = strict no-op
        // (selection/scroll/completion untouched).
        const cur = view.state.doc.toString();
        if (cur !== tab.sql) {
          view.dispatch({
            changes: { from: 0, to: cur.length, insert: tab.sql },
            annotations: syncTx.of(true),
          });
        }
        return;
      }
      if (ids.has(shownTabId)) tabStates.set(shownTabId, view.state); // park the outgoing tab (undo intact); a just-closed tab isn't kept
      let next = tabStates.get(tab.id) || null;
      if (next) {
        // A parked state may predate a refData arrival or an external tab.sql
        // write — re-apply the current language and reconcile the doc via
        // detached updates (undo history survives; no view listener fires).
        next = next.update({ effects: langCompartment.reconfigure(langExt) }).state;
        const doc = next.doc.toString();
        if (doc !== tab.sql) {
          next = next.update({ changes: { from: 0, to: doc.length, insert: tab.sql }, annotations: syncTx.of(true) }).state;
        }
      } else {
        next = freshState(tab.sql);
      }
      shownTabId = tab.id;
      view.setState(next); // setState is not a transaction — nothing emits
    },
    refreshReference: () => {
      // Server keyword/function sets arrived (#25): swap the dialect on the
      // live view. Parked tab states get it on restore (syncFromState).
      langExt = langExtensionFor(app);
      if (view) view.dispatch({ effects: langCompartment.reconfigure(langExt) });
    },
    onDocChange: (cb) => { subs.add(cb); return () => subs.delete(cb); },
  };
}
