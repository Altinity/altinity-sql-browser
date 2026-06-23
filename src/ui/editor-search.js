// In-editor find/replace panel (#23). A floating panel over the editor, driven
// by the pure matcher in core/editor-search.js. Match highlights are drawn by
// the editor's transparent mark overlay — this module only owns the panel UI,
// the search state, and the Cmd/Ctrl+F trigger; it hands its marks to the
// editor via `host.repaintMarks()` and edits text via `host.replaceRange`.
//
// host = {
//   area,                         // .sql-area element to mount the panel into
//   textarea,                     // the editor <textarea>
//   padY, lineHeightPx,           // editor metrics for centering a match
//   replaceRange(start, end, txt),// undoable edit that fires 'input'
//   syncScroll(),                 // re-sync overlay/pre/gutter after we scroll
//   repaintMarks(),               // ask the editor to repaint the mark overlay
// }

import { h } from './dom.js';
import { Icon } from './icons.js';
import { findMatches, validRegex } from '../core/editor-search.js';

export function createSearch(host) {
  const ta = host.textarea;
  const state = {
    open: false, query: '', replace: '', showReplace: false,
    opts: { caseSensitive: false, wholeWord: false, regex: false },
    matches: [], active: 0,
  };
  let panel = null; // built lazily on first open; cleared on close

  // Re-run the matcher against the current text and clamp the active index, then
  // refresh the panel (so editing the editor updates the count). The editor
  // calls this on every text change; the overlay repaint is the caller's job.
  const recompute = () => {
    state.matches = state.open && state.query
      ? findMatches(ta.value, state.query, state.opts)
      : [];
    if (state.active >= state.matches.length) {
      state.active = state.matches.length ? state.matches.length - 1 : 0;
    }
    updatePanel();
  };

  // The marks the editor overlays: every match 'match', the active one 'active'.
  const marks = () => (state.open
    ? state.matches.map((m, i) => ({ start: m.start, end: m.end, cls: i === state.active ? 'active' : 'match' }))
    : []);

  const refresh = () => { recompute(); host.repaintMarks(); };

  const scrollToActive = () => {
    const m = state.matches[state.active]; // goto guarantees a match before calling
    const line = ta.value.slice(0, m.start).split('\n').length - 1;
    const top = line * host.lineHeightPx;
    if (top < ta.scrollTop + host.padY || top > ta.scrollTop + ta.clientHeight - host.lineHeightPx - host.padY) {
      ta.scrollTop = Math.max(0, top - ta.clientHeight / 2);
      host.syncScroll();
    }
  };

  const goto = (idx) => {
    if (!state.matches.length) return;
    state.active = (idx + state.matches.length) % state.matches.length;
    scrollToActive();
    host.repaintMarks();
    updatePanel();
  };

  const doReplace = () => {
    const m = state.matches[state.active];
    if (!m) return;
    host.replaceRange(m.start, m.end, state.replace); // fires input → editor recomputes
    panel.input.focus();
  };
  const doReplaceAll = () => {
    if (!state.matches.length) return;
    let out = '';
    let last = 0;
    for (const m of state.matches) { out += ta.value.slice(last, m.start) + state.replace; last = m.end; }
    out += ta.value.slice(last);
    host.replaceRange(0, ta.value.length, out);
    panel.input.focus();
  };

  function updatePanel() {
    if (!panel) return;
    const bad = !validRegex(state.query, state.opts.regex);
    panel.input.classList.toggle('bad', bad);
    panel.counter.classList.toggle('bad', bad);
    panel.counter.textContent = bad ? 'bad re'
      : state.matches.length ? (state.active + 1) + '/' + state.matches.length : '0/0';
    for (const k of Object.keys(panel.toggles)) panel.toggles[k].classList.toggle('on', state.opts[k]);
    panel.disc.classList.toggle('open', state.showReplace);
    const shown = panel.rows.contains(panel.replaceRow);
    if (state.showReplace && !shown) panel.rows.appendChild(panel.replaceRow);
    else if (!state.showReplace && shown) panel.replaceRow.remove();
  }

  function buildPanel() {
    const input = h('input', {
      class: 'srch-field', placeholder: 'Find', spellcheck: 'false',
      oninput: (e) => { state.query = e.target.value; refresh(); },
      onkeydown: (e) => {
        if (e.key === 'Enter') { e.preventDefault(); goto(state.active + (e.shiftKey ? -1 : 1)); }
        else if (e.key === 'Escape') { e.preventDefault(); close(); }
      },
    });
    const counter = h('span', { class: 'srch-count' });
    const navBtn = (label, title, onclick) => h('button', { class: 'srch-nav', title, onclick }, label);
    const togBtn = (key, label, title) => h('button', {
      class: 'srch-tog', title,
      onclick: () => { state.opts[key] = !state.opts[key]; refresh(); },
    }, label);
    const toggles = {
      caseSensitive: togBtn('caseSensitive', 'Aa', 'Match case'),
      wholeWord: togBtn('wholeWord', 'W', 'Whole word'),
      regex: togBtn('regex', '.*', 'Regular expression'),
    };
    const findRow = h('div', { class: 'srch-row' },
      input, counter,
      navBtn('↑', 'Previous (⇧⏎)', () => goto(state.active - 1)),
      navBtn('↓', 'Next (⏎)', () => goto(state.active + 1)),
      h('div', { class: 'srch-togs' }, toggles.caseSensitive, toggles.wholeWord, toggles.regex),
      h('button', { class: 'srch-nav', title: 'Close (Esc)', onclick: close }, Icon.close()));

    const replaceInput = h('input', {
      class: 'srch-field', placeholder: 'Replace', spellcheck: 'false',
      oninput: (e) => { state.replace = e.target.value; },
      onkeydown: (e) => {
        if (e.key === 'Enter') { e.preventDefault(); doReplace(); }
        else if (e.key === 'Escape') { e.preventDefault(); close(); }
      },
    });
    const replaceRow = h('div', { class: 'srch-row' },
      replaceInput,
      h('button', { class: 'srch-btn', title: 'Replace (⏎)', onclick: doReplace }, 'Replace'),
      h('button', { class: 'srch-btn primary', title: 'Replace all', onclick: doReplaceAll }, 'All'));

    const disc = h('button', {
      class: 'srch-disc', title: 'Toggle replace',
      onclick: () => { state.showReplace = !state.showReplace; updatePanel(); },
    }, Icon.chev());
    const rows = h('div', { class: 'srch-rows' }, findRow);
    const el = h('div', { class: 'sql-search' }, disc, rows);
    panel = { el, input, counter, toggles, disc, rows, replaceRow };
    host.area.appendChild(el);
  }

  const open = () => {
    if (!state.open) {
      state.open = true;
      if (!panel) buildPanel();
      else host.area.appendChild(panel.el);
      refresh();
    }
    panel.input.focus();
    panel.input.select();
  };

  function close() {
    if (!state.open) return;
    state.open = false;
    if (panel) panel.el.remove();
    host.repaintMarks(); // clear the highlights
    ta.focus();
  }

  // Cmd/Ctrl+F on the textarea — registered here so the browser's native find
  // can't intercept it before a global handler (resolved design decision).
  ta.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && (e.key === 'f' || e.key === 'F')) {
      e.preventDefault();
      open();
    }
  });

  return { isOpen: () => state.open, marks, recompute, open, close };
}
