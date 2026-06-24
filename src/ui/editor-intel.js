// Editor intelligence (#27): signature help + hover docs, both driven off the
// in-memory reference data loaded once per connection (#25) — never a query on
// the keystroke path. Signature help follows the caret inside a function call;
// hover docs come from the textarea's mousemove (the only layer with pointer
// events — .sql-pre / the overlay are pointer-events:none).
//
// host = {
//   textarea,
//   maskedValue(),          // () => the text with string/comment chars masked (#2)
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

  // Functions are keyed by the server's canonical name (usually lowercase: count,
  // substring; a few uppercase: CAST). SQL is case-insensitive for function calls,
  // so resolve the typed word against exact/lower/upper — matching autocomplete,
  // which lower-cases both sides (#27). Returns { name: canonical, meta } or null.
  const lookupFn = (word) => {
    const fns = host.getFunctions();
    if (fns[word]) return { name: word, meta: fns[word] };
    const lo = word.toLowerCase();
    if (fns[lo]) return { name: lo, meta: fns[lo] };
    const up = word.toUpperCase();
    if (fns[up]) return { name: up, meta: fns[up] };
    return null;
  };

  // ── signature help (caret-driven) ──────────────────────────────────────────
  const refreshSignature = () => {
    if (host.suppressed() || ta.selectionStart !== ta.selectionEnd) { hideSig(); return; }
    // Scan the string/comment-masked text so a comma inside a literal isn't
    // counted as an argument separator (#2 review). Function names are code, so
    // ctx.name is intact in the mask.
    const ctx = signatureContext(host.maskedValue(), ta.selectionStart);
    const found = ctx && lookupFn(ctx.name);
    if (!found) { hideSig(); return; }
    const meta = found.meta;
    const sig = meta.sig; // always "name(…)" — the loader guarantees a () fallback
    // Strip the optional-param brackets ClickHouse syntax uses (`name(a, b[, c])`)
    // before splitting on commas, so the parts align with signatureContext's
    // depth-0 comma count and the active-arg highlight lands right (#2 review).
    const inner = sig.slice(sig.indexOf('(') + 1, sig.lastIndexOf(')')).replace(/[[\]]/g, '');
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
      // Resolve the hovered word from the string/comment-masked text (literal
      // chars are NUL), so hovering a word inside a string or comment shows no
      // phantom doc card — consistent with signature help (#1 review).
      const w = pos == null ? null : wordAt(host.maskedValue(), pos);
      if (!w) { hideHover(); return; }
      const token = ++hoverToken;
      const found = lookupFn(w.word);
      const kw = host.getKeywordDocs()[w.word.toUpperCase()];
      if (found) {
        // Show the signature immediately; the description is fetched on demand by
        // the canonical name (a separate query, cached per entity) and filled in
        // when it arrives — unless the pointer has since moved to another token.
        const meta = found.meta;
        renderHover({ sig: meta.sig, ret: meta.ret, doc: '', x: cx, y: cy });
        Promise.resolve(host.fetchDoc(found.name)).then((doc) => {
          if (doc && token === hoverToken && hoverEl) renderHover({ sig: meta.sig, ret: meta.ret, doc, x: cx, y: cy });
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
