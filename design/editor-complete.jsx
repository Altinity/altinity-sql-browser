// editor-complete.jsx — autocomplete (#26), signature help + hover docs (#27)
// All client-side off cached reference data — never runs SQL on the keystroke
// path. Popovers are positioned by the editor via caret coordinates.

// ── completion context ──────────────────────────────────────────────────────
// What word is being typed at the caret, and is it qualified (after a dot)?
function completionContext(value, pos) {
  let s = pos;
  while (s > 0 && /[A-Za-z0-9_]/.test(value[s - 1])) s--;
  const word = value.slice(s, pos);
  const qualified = value[s - 1] === '.';
  let parent = null;
  if (qualified) {
    let p = s - 1;
    while (p > 0 && /[A-Za-z0-9_]/.test(value[p - 1])) p--;
    parent = value.slice(p, s - 1);
  }
  return { word, from: s, to: pos, qualified, parent };
}

const KIND_META = {
  keyword: { glyph: 'K', color: '#C586C0', label: 'keyword' },
  fn:      { glyph: 'ƒ', color: '#DCDCAA', label: 'function' },
  agg:     { glyph: 'Σ', color: '#E0B341', label: 'aggregate' },
  cast:    { glyph: '⇄', color: '#4FC1FF', label: 'cast' },
  table:   { glyph: '▦', color: '#FF6B35', label: 'table' },
  column:  { glyph: '▪', color: '#92E1D8', label: 'column' },
  db:      { glyph: '◈', color: '#A0A0A8', label: 'database' },
};

// Rank candidates: qualified → only that table's columns. Otherwise prefix
// matches first, then substring; columns/tables rank above keywords when the
// user has typed ≥1 char. Caps the list for a tight dropdown.
function rankCompletions(items, ctx) {
  const w = ctx.word.toLowerCase();
  if (ctx.qualified) {
    const cols = items.filter((it) => it.kind === 'column' && it.parent === ctx.parent);
    return (w ? cols.filter((c) => c.label.toLowerCase().includes(w)) : cols).slice(0, 50);
  }
  if (!w) {
    return items.filter((it) => it.kind === 'keyword' || it.kind === 'table').slice(0, 40);
  }
  const scored = [];
  for (const it of items) {
    const l = it.label.toLowerCase();
    const idx = l.indexOf(w);
    if (idx === -1) continue;
    let score = idx === 0 ? 0 : 100 + idx;              // prefix beats substring
    if (it.kind === 'column' || it.kind === 'table') score -= 10; // boost schema
    if (it.kind === 'keyword') score += 5;
    score += (l.length - w.length) * 0.1;               // prefer closer length
    scored.push({ it, score });
  }
  scored.sort((a, b) => a.score - b.score || a.it.label.localeCompare(b.it.label));
  return scored.slice(0, 50).map((s) => s.it);
}

function HiMatch({ text, q }) {
  if (!q) return text;
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i === -1) return text;
  return (
    <>{text.slice(0, i)}<span style={{ color: 'var(--accent, #FF6B35)', fontWeight: 700 }}>{text.slice(i, i + q.length)}</span>{text.slice(i + q.length)}</>
  );
}

function AutocompleteDropdown({ items, active, query, coords, onPick, accent }) {
  const listRef = React.useRef(null);
  React.useEffect(() => {
    const el = listRef.current?.children[active];
    if (el) el.scrollIntoView({ block: 'nearest' });
  }, [active]);
  if (!items.length) return null;

  // position:fixed in a body portal so the editor's overflow:hidden can't clip
  // it. Flip above the caret only when there's more room above; clamp to the
  // viewport so a short editor pane can't push it off-screen.
  const W = 350;
  const { cx, cy, lhPx, vw, vh } = coords;
  const spaceBelow = vh - (cy + lhPx);
  const spaceAbove = cy;
  const below = spaceBelow > 248 || spaceBelow >= spaceAbove;
  const maxH = Math.max(120, Math.min(248, (below ? spaceBelow : spaceAbove) - 10));
  const left = Math.max(8, Math.min(cx, vw - W - 8));
  const pos = below
    ? { top: Math.round(cy + lhPx + 2) }
    : { bottom: Math.round(vh - cy + 2) };
  const cur = items[active];

  return ReactDOM.createPortal(
    <div style={{
      position: 'fixed', left, ...pos, zIndex: 2147483600, maxHeight: maxH,
      display: 'flex', flexDirection: 'column',
      background: 'var(--bg-modal)', border: '1px solid var(--border)', borderRadius: 8,
      boxShadow: '0 12px 34px rgba(0,0,0,.4)', overflow: 'hidden', width: W,
      fontFamily: 'var(--ui)', '--accent': accent,
    }}>
      <div ref={listRef} style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 4 }}>
        {items.map((it, i) => {
          const m = KIND_META[it.kind] || KIND_META.fn;
          const on = i === active;
          return (
            <div key={it.label + i} onMouseDown={(e) => { e.preventDefault(); onPick(it); }}
              style={{
                display: 'flex', alignItems: 'center', gap: 9, padding: '5px 8px',
                borderRadius: 5, cursor: 'pointer',
                background: on ? `color-mix(in oklab, ${accent} 20%, transparent)` : 'transparent',
              }}>
              <span style={{
                width: 17, height: 17, flexShrink: 0, borderRadius: 4, fontSize: 11, fontWeight: 700,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: 'var(--bg-chip)', color: m.color, fontFamily: 'var(--mono)',
              }}>{m.glyph}</span>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 12.5, color: 'var(--fg)', flexShrink: 0 }}>
                <HiMatch text={it.label} q={query} />
              </span>
              <span style={{
                marginLeft: 'auto', fontSize: 10.5, color: 'var(--fg-faint)', fontFamily: 'var(--mono)',
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 150, textAlign: 'right',
              }}>{it.detail}</span>
            </div>
          );
        })}
      </div>
      {(cur.doc || cur.ret) && (
        <div style={{
          borderTop: '1px solid var(--border-faint)', padding: '7px 10px',
          fontSize: 11, color: 'var(--fg-mute)', lineHeight: 1.45, flexShrink: 0,
          display: 'flex', flexDirection: 'column', gap: 3, background: 'var(--bg-chip)',
        }}>
          {cur.detail && cur.kind !== 'keyword' && <span style={{ fontFamily: 'var(--mono)', color: 'var(--fg)' }}>{cur.detail}{cur.ret ? ` → ${cur.ret}` : ''}</span>}
          {cur.doc && <span>{cur.doc}</span>}
        </div>
      )}
    </div>,
    document.body,
  );
}

// ── signature help ───────────────────────────────────────────────────────────
// Walk back from caret to find an unclosed "fnName(" and which arg index we're on.
function signatureContext(value, pos) {
  let depth = 0, i = pos - 1, argIdx = 0;
  while (i >= 0) {
    const c = value[i];
    if (c === ')') depth++;
    else if (c === '(') {
      if (depth === 0) {
        let e = i;
        while (e > 0 && /[A-Za-z0-9_]/.test(value[e - 1])) e--;
        const name = value.slice(e, i);
        if (name) return { name, argIdx };
        return null;
      }
      depth--;
    } else if (c === ',' && depth === 0) argIdx++;
    else if ((c === ';' || c === '\n') && depth === 0) return null;
    i--;
  }
  return null;
}

function SignatureHelp({ sig, name, argIdx, ret, coords }) {
  if (!sig) return null;
  const { cx, cy, lhPx, vw, vh } = coords;
  // Split args to bold the active one.
  const open = sig.indexOf('(');
  const inner = sig.slice(open + 1, sig.lastIndexOf(')'));
  const args = inner.split(',');
  // Prefer above the caret; drop below if there's no room up top. Clamp left.
  const above = cy > 40;
  const left = Math.max(8, Math.min(cx, vw - 320));
  const pos = above ? { bottom: Math.round(vh - cy + 4) } : { top: Math.round(cy + lhPx + 4) };
  return ReactDOM.createPortal(
    <div style={{
      position: 'fixed', left, ...pos, zIndex: 2147483599, maxWidth: 340,
      background: 'var(--bg-modal)', border: '1px solid var(--border)', borderRadius: 7,
      boxShadow: '0 8px 24px rgba(0,0,0,.35)', padding: '7px 10px',
      fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--fg-mute)', whiteSpace: 'nowrap',
      '--accent': coords.accent,
    }}>
      <span style={{ color: 'var(--fg)' }}>{name}</span>(
      {args.map((a, i) => (
        <span key={i}>
          <span style={{ color: i === argIdx ? (coords.accent || '#FF6B35') : 'var(--fg-mute)', fontWeight: i === argIdx ? 700 : 400 }}>{a.trim()}</span>
          {i < args.length - 1 ? ', ' : ''}
        </span>
      ))})
      {ret && <span style={{ color: 'var(--fg-faint)' }}> → {ret}</span>}
    </div>,
    document.body,
  );
}

// ── hover card ────────────────────────────────────────────────────────────────
function HoverCard({ title, sig, ret, doc, x, y }) {
  return (
    <div style={{
      position: 'fixed', left: x, top: y + 16, zIndex: 60, width: 280,
      background: 'var(--bg-modal)', border: '1px solid var(--border)', borderRadius: 8,
      boxShadow: '0 12px 34px rgba(0,0,0,.4)', padding: '9px 11px',
      fontFamily: 'var(--ui)', pointerEvents: 'none',
    }}>
      <div style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--fg)', marginBottom: doc ? 5 : 0 }}>
        {sig || title}{ret ? <span style={{ color: 'var(--fg-faint)' }}> → {ret}</span> : null}
      </div>
      {doc && <div style={{ fontSize: 11.5, color: 'var(--fg-mute)', lineHeight: 1.5 }}>{doc}</div>}
    </div>
  );
}

Object.assign(window, {
  completionContext, rankCompletions, AutocompleteDropdown,
  signatureContext, SignatureHelp, HoverCard, KIND_META,
});
