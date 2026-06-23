// Autocomplete dropdown (#26). Reads the in-memory completion candidates built
// once per connection (#25) and ranks them client-side — never a query on the
// keystroke path. The editor wires this in: it calls refresh() on every text
// change, delegates nav keys via handleKeydown(), and supplies the caret anchor
// + an undoable replaceRange for accepting a candidate.
//
// host = {
//   textarea,
//   getCompletions(),                 // () => candidate list (or [])
//   replaceRange(from, to, text),     // undoable edit that fires 'input'
//   caretAnchor(),                    // () => {x, y, lineHeight} in screen px
//   appendPopover(el),                // mount the dropdown
//   suppressed(),                     // () => true to stay hidden (e.g. find open)
// }

import { h } from './dom.js';
import { completionContext, rankCompletions } from '../core/completions.js';

// Kind → glyph + color for the row chip (presentation; the data is in core).
const KIND_META = {
  keyword: { glyph: 'K', color: '#C586C0' },
  fn: { glyph: 'ƒ', color: '#DCDCAA' },
  agg: { glyph: 'Σ', color: '#E0B341' },
  cast: { glyph: '⇄', color: '#4FC1FF' },
  table: { glyph: '▦', color: 'var(--accent)' },
  column: { glyph: '▪', color: '#92E1D8' },
  db: { glyph: '◈', color: '#A0A0A8' },
};

export function createComplete(host) {
  const ta = host.textarea;
  const state = { open: false, items: [], active: 0, ctx: null };
  let pop = null;          // { el, list, footer } — built lazily
  let accepting = false;   // guards the input fired by our own accept edit

  const hide = () => {
    if (!state.open) return;
    state.open = false;
    if (pop) { pop.el.remove(); pop = null; }
  };

  // Re-evaluate completion at the caret and show/hide the dropdown.
  const refresh = () => {
    if (accepting || host.suppressed() || ta.selectionStart !== ta.selectionEnd) { hide(); return; }
    const ctx = completionContext(ta.value, ta.selectionStart);
    if (!ctx.qualified && ctx.word.length < 1) { hide(); return; } // need ≥1 char or a dot
    const items = rankCompletions(host.getCompletions(), ctx);
    if (!items.length) { hide(); return; }
    state.open = true;
    state.items = items;
    state.active = 0;
    state.ctx = ctx;
    render();
  };

  const accept = (item) => {
    accepting = true; // the resulting 'input' must not re-trigger the dropdown
    host.replaceRange(state.ctx.from, state.ctx.to, item.insert);
    accepting = false;
    hide();
  };

  const move = (delta) => {
    state.active = (state.active + delta + state.items.length) % state.items.length;
    render();
  };

  const CARET_MOVERS = new Set(['ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown']);
  const handleKeydown = (e) => {
    if (!state.open) return false;
    if (e.key === 'ArrowDown') { e.preventDefault(); move(1); return true; }
    if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); return true; }
    if (e.key === 'Enter' || e.key === 'Tab') {
      // A modified Enter/Tab is a run/format/blur chord, not "accept" — dismiss
      // and let it bubble (otherwise ⌘↵ would splice a token *and* run).
      if (e.metaKey || e.ctrlKey || e.altKey) { hide(); return false; }
      e.preventDefault(); accept(state.items[state.active]); return true;
    }
    if (e.key === 'Escape') { e.preventDefault(); hide(); return true; }
    // A caret-moving key makes the tracked word range stale (refresh only runs
    // on input) — dismiss and let the caret move, so a later accept can't
    // overwrite text at the old position.
    if (CARET_MOVERS.has(e.key)) { hide(); return false; }
    return false;
  };

  function render() {
    if (!pop) {
      const list = h('div', { class: 'ac-list' });
      const footer = h('div', { class: 'ac-footer' });
      pop = { el: h('div', { class: 'ac-dropdown' }, list, footer), list, footer };
      host.appendPopover(pop.el);
    }
    const anchor = host.caretAnchor();
    pop.el.style.left = Math.round(anchor.x) + 'px';
    pop.el.style.top = Math.round(anchor.y + anchor.lineHeight) + 'px';

    pop.list.replaceChildren();
    state.items.forEach((it, i) => {
      const meta = KIND_META[it.kind] || KIND_META.fn;
      pop.list.appendChild(h('div', {
        class: 'ac-row' + (i === state.active ? ' on' : ''),
        // mousedown (not click) so we beat the textarea's blur-driven hide.
        onmousedown: (ev) => { ev.preventDefault(); accept(it); },
      },
        h('span', { class: 'ac-chip', style: { color: meta.color } }, meta.glyph),
        h('span', { class: 'ac-label' }, it.label),
        h('span', { class: 'ac-detail' }, it.detail || '')));
    });

    const cur = state.items[state.active];
    pop.footer.replaceChildren();
    const sig = cur.kind !== 'keyword' && cur.detail ? cur.detail + (cur.ret ? ' → ' + cur.ret : '') : '';
    if (sig || cur.doc) {
      if (sig) pop.footer.appendChild(h('div', { class: 'ac-sig' }, sig));
      if (cur.doc) pop.footer.appendChild(h('div', { class: 'ac-doc' }, cur.doc));
      pop.footer.style.display = '';
    } else {
      pop.footer.style.display = 'none';
    }
  }

  // Dismiss when focus leaves (deferred so a row mousedown can land) or on scroll.
  ta.addEventListener('blur', () => setTimeout(hide, 120));
  ta.addEventListener('scroll', hide);

  return { isOpen: () => state.open, refresh, hide, handleKeydown };
}
