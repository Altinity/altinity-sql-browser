// editor-search.jsx — in-editor find/replace (#23)
// Pure match-finder + the floating panel UI. Highlights are drawn by the
// editor's transparent overlay <pre> (see sql-editor.jsx), per the resolved
// design: a second color:transparent <pre> carrying only mark spans, never
// splitting the token render path.

function findMatches(value, query, opts = {}) {
  if (!query) return [];
  const { caseSensitive = false, regex = false, wholeWord = false } = opts;
  const matches = [];
  try {
    let re;
    if (regex) {
      re = new RegExp(query, caseSensitive ? 'g' : 'gi');
    } else {
      let pat = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (wholeWord) pat = `\\b${pat}\\b`;
      re = new RegExp(pat, caseSensitive ? 'g' : 'gi');
    }
    let m;
    let guard = 0;
    while ((m = re.exec(value)) !== null) {
      if (m.index === re.lastIndex) re.lastIndex++; // zero-width guard
      matches.push({ start: m.index, end: m.index + m[0].length });
      if (++guard > 10000) break;
    }
  } catch (e) {
    return []; // invalid regex → no matches (panel shows the error state)
  }
  return matches;
}

function validRegex(query, regex) {
  if (!regex || !query) return true;
  try { new RegExp(query); return true; } catch { return false; }
}

function SearchPanel({
  accent, query, setQuery, replace, setReplace, opts, setOpts,
  matchCount, activeIndex, showReplace, setShowReplace,
  onNext, onPrev, onReplace, onReplaceAll, onClose, inputRef,
}) {
  const badQuery = !validRegex(query, opts.regex);
  const tog = (k) => setOpts({ ...opts, [k]: !opts[k] });

  const toggleBtn = (active, label, title, onClick) => (
    <button title={title} onClick={onClick} style={{
      width: 24, height: 22, border: 'none', borderRadius: 4, cursor: 'pointer',
      fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 600,
      background: active ? accent : 'var(--bg-chip)',
      color: active ? '#fff' : 'var(--fg-mute)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>{label}</button>
  );

  const iconBtn = (children, title, onClick, disabled) => (
    <button title={title} onClick={onClick} disabled={disabled} style={{
      width: 24, height: 22, border: 'none', borderRadius: 4,
      cursor: disabled ? 'default' : 'pointer',
      background: 'transparent', color: 'var(--fg-mute)', opacity: disabled ? .4 : 1,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}
      onMouseEnter={(e) => { if (!disabled) e.currentTarget.style.background = 'var(--bg-hover)'; }}
      onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
    >{children}</button>
  );

  const fieldWrap = { display: 'flex', alignItems: 'center', gap: 4 };
  const field = {
    width: 190, height: 26, padding: '0 8px', background: 'var(--bg-input)',
    border: `1px solid ${badQuery ? '#ef4444' : 'var(--border)'}`, borderRadius: 6,
    color: 'var(--fg)', fontSize: 12, fontFamily: 'var(--mono)', outline: 'none',
  };

  return (
    <div style={{
      position: 'absolute', top: 8, right: 14, zIndex: 20,
      display: 'flex', gap: 8, alignItems: 'flex-start',
      background: 'var(--bg-modal)', border: '1px solid var(--border)',
      borderRadius: 9, boxShadow: '0 10px 30px rgba(0,0,0,.32)', padding: 8,
    }}>
      {/* expand replace toggle */}
      <button title={showReplace ? 'Hide replace' : 'Show replace'}
        onClick={() => setShowReplace(!showReplace)} style={{
          width: 18, alignSelf: 'stretch', border: 'none', background: 'transparent',
          color: 'var(--fg-faint)', cursor: 'pointer', borderRadius: 4,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
        <span style={{ display: 'flex', transform: showReplace ? 'none' : 'rotate(-90deg)', transition: 'transform .15s' }}>
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M2 3.5L5 6.5l3-3"/></svg>
        </span>
      </button>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {/* find row */}
        <div style={fieldWrap}>
          <input ref={inputRef} value={query} onChange={(e) => setQuery(e.target.value)}
            placeholder="Find" style={field} spellCheck={false}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); e.shiftKey ? onPrev() : onNext(); }
              if (e.key === 'Escape') { e.preventDefault(); onClose(); }
            }} />
          <span style={{
            minWidth: 52, textAlign: 'center', fontSize: 11, fontFamily: 'var(--mono)',
            color: badQuery ? '#ef4444' : 'var(--fg-faint)',
          }}>
            {badQuery ? 'bad re' : matchCount ? `${activeIndex + 1}/${matchCount}` : '0/0'}
          </span>
          {iconBtn(<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M8 2L4 6l4 4"/></svg>, 'Previous (⇧⏎)', onPrev, !matchCount)}
          {iconBtn(<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M4 2l4 4-4 4"/></svg>, 'Next (⏎)', onNext, !matchCount)}
          <div style={{ display: 'flex', gap: 2, marginLeft: 2 }}>
            {toggleBtn(opts.caseSensitive, 'Aa', 'Match case', () => tog('caseSensitive'))}
            {toggleBtn(opts.wholeWord, 'W', 'Whole word', () => tog('wholeWord'))}
            {toggleBtn(opts.regex, '.*', 'Regular expression', () => tog('regex'))}
          </div>
          {iconBtn(<svg width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"><path d="M2 2l7 7M9 2l-7 7"/></svg>, 'Close (Esc)', onClose)}
        </div>

        {/* replace row */}
        {showReplace && (
          <div style={fieldWrap}>
            <input value={replace} onChange={(e) => setReplace(e.target.value)}
              placeholder="Replace" style={field} spellCheck={false}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); onReplace(); } if (e.key === 'Escape') onClose(); }} />
            <button onClick={onReplace} disabled={!matchCount} title="Replace (⏎)" style={{
              height: 22, padding: '0 8px', border: 'none', borderRadius: 4,
              background: 'var(--bg-chip)', color: matchCount ? 'var(--fg)' : 'var(--fg-faint)',
              fontSize: 11, fontWeight: 500, cursor: matchCount ? 'pointer' : 'default', fontFamily: 'inherit',
            }}>Replace</button>
            <button onClick={onReplaceAll} disabled={!matchCount} title="Replace all" style={{
              height: 22, padding: '0 8px', border: 'none', borderRadius: 4,
              background: matchCount ? accent : 'var(--bg-chip)',
              color: matchCount ? '#fff' : 'var(--fg-faint)',
              fontSize: 11, fontWeight: 600, cursor: matchCount ? 'pointer' : 'default', fontFamily: 'inherit',
            }}>All</button>
          </div>
        )}
      </div>
    </div>
  );
}

Object.assign(window, { findMatches, validRegex, SearchPanel });
