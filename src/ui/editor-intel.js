// Editor intelligence (#27): signature help + hover docs, both driven off the
// in-memory reference data loaded once per connection (#25) — never a query on
// the keystroke path. Signature help follows the caret inside a function call;
// hover docs come from the textarea's mousemove (the only layer with pointer
// events — .sql-pre / the overlay are pointer-events:none).
//
// host = {
//   textarea,
//   getFunctions(),         // () => { name: {sig, ret, kind} }
//   getKeywordDocs(),       // () => { KEYWORD: doc }
//   fetchDoc(name),         // () => Promise<string> — lazy, cached hover doc for a function
//   caretAnchor(),          // () => {x, y, lineHeight} in screen px (shared with #26)
//   offsetAt(cx, cy),       // map mouse client coords → text offset (or null)
//   clientToLocal(cx, cy),  // map mouse client coords → the popover's local CSS px (zoom)
//   appendPopover(el),
//   suppressed(),           // () => true to stay hidden (find / autocomplete open)
// }

const HOVER_DWELL_MS = 350;

import { h } from './dom.js';
import { signatureContext, wordAt } from '../core/completions.js';

export function createIntel(host) {
  const ta = host.textarea;
  let sigEl = null;          // signature popover
  let hoverEl = null;        // hover card
  let hoverTimer = null;

  const hideSig = () => { if (sigEl) { sigEl.remove(); sigEl = null; } };
  const hideHover = () => { if (hoverEl) { hoverEl.remove(); hoverEl = null; } };
  const hide = () => { hideSig(); hideHover(); };

  // ── signature help (caret-driven) ──────────────────────────────────────────
  const refreshSignature = () => {
    if (host.suppressed() || ta.selectionStart !== ta.selectionEnd) { hideSig(); return; }
    const ctx = signatureContext(ta.value, ta.selectionStart);
    const meta = ctx && host.getFunctions()[ctx.name];
    if (!meta) { hideSig(); return; }
    const sig = meta.sig; // always "name(…)" — the loader guarantees a () fallback
    const inner = sig.slice(sig.indexOf('(') + 1, sig.lastIndexOf(')'));
    const args = inner.split(',');
    const parts = [h('span', { class: 'sig-name' }, ctx.name), '('];
    args.forEach((a, i) => {
      parts.push(h('span', { class: i === ctx.argIdx ? 'sig-arg on' : 'sig-arg' }, a.trim()));
      if (i < args.length - 1) parts.push(', ');
    });
    parts.push(')');
    if (meta.ret) parts.push(h('span', { class: 'sig-ret' }, ' → ' + meta.ret));
    if (!sigEl) { sigEl = h('div', { class: 'sig-help' }); host.appendPopover(sigEl); }
    sigEl.replaceChildren(...parts);
    const anchor = host.caretAnchor();
    sigEl.style.left = Math.round(anchor.x) + 'px';
    sigEl.style.top = Math.round(Math.max(4, anchor.y - anchor.lineHeight - 6)) + 'px'; // above the caret
  };

  // ── hover docs (mouse-driven, dwell; doc text fetched lazily + cached) ──────
  let hoverToken = 0; // bumped each dwell so a late doc fetch for a stale word is ignored
  const onMouseMove = (e) => {
    clearTimeout(hoverTimer);
    if (host.suppressed()) { hideHover(); return; }
    const cx = e.clientX;
    const cy = e.clientY;
    hoverTimer = setTimeout(() => {
      const pos = host.offsetAt(cx, cy);
      const w = pos == null ? null : wordAt(ta.value, pos);
      if (!w) { hideHover(); return; }
      const token = ++hoverToken;
      const fn = host.getFunctions()[w.word];
      const kw = host.getKeywordDocs()[w.word.toUpperCase()];
      if (fn) {
        // Show the signature immediately; the description is fetched on demand
        // (a separate query, cached per entity) and filled in when it arrives —
        // unless the pointer has since moved to another token.
        renderHover({ sig: fn.sig, ret: fn.ret, doc: '', x: cx, y: cy });
        Promise.resolve(host.fetchDoc(w.word)).then((doc) => {
          if (doc && token === hoverToken && hoverEl) renderHover({ sig: fn.sig, ret: fn.ret, doc, x: cx, y: cy });
        });
      } else if (kw) {
        renderHover({ sig: w.word.toUpperCase(), doc: kw, x: cx, y: cy });
      } else {
        hideHover();
      }
    }, HOVER_DWELL_MS);
  };
  const onMouseLeave = () => { clearTimeout(hoverTimer); hideHover(); };

  function renderHover({ sig, ret, doc, x, y }) {
    if (!hoverEl) { hoverEl = h('div', { class: 'hover-card' }); host.appendPopover(hoverEl); }
    hoverEl.replaceChildren(...[
      h('div', { class: 'hover-sig' }, sig, ret ? h('span', { class: 'hover-ret' }, ' → ' + ret) : null),
      doc ? h('div', { class: 'hover-doc' }, doc) : null,
    ].filter(Boolean));
    const loc = host.clientToLocal(x, y);
    hoverEl.style.left = Math.round(loc.x) + 'px';
    hoverEl.style.top = Math.round(loc.y + 16) + 'px';
  }

  // Esc dismisses the signature popover (only when it's showing, so a running
  // query's Esc-to-cancel still works otherwise).
  const handleKeydown = (e) => {
    if (e.key === 'Escape' && sigEl) { e.preventDefault(); hideSig(); return true; }
    return false;
  };

  return { refreshSignature, onMouseMove, onMouseLeave, handleKeydown, hide };
}
