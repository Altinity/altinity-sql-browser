// sql-editor.jsx — syntax-highlighted SQL editor (textarea over <pre>)
// Enhancements (issues #23–#27), all built on the textarea surface:
//   #23 find/replace  #24 bracket match+auto-close  #25 dynamic-keyword API
//   #26 autocomplete   #27 signature help + hover docs
// Reference data, search UI, and completion UI live in editor-data.jsx,
// editor-search.jsx, editor-complete.jsx.

// ── default token sets (tokenizer also accepts dynamic ones, see #25) ────────
const SQL_KEYWORDS = new Set([
  'SELECT','FROM','WHERE','AND','OR','NOT','IN','BETWEEN','LIKE','IS','NULL',
  'GROUP','BY','ORDER','HAVING','LIMIT','OFFSET','AS','ON','JOIN','INNER',
  'LEFT','RIGHT','OUTER','FULL','CROSS','UNION','ALL','DISTINCT','CASE','WHEN',
  'THEN','ELSE','END','WITH','INSERT','INTO','VALUES','UPDATE','SET','DELETE',
  'CREATE','TABLE','VIEW','INDEX','DROP','ALTER','SHOW','DESCRIBE','DESC','ASC',
  'EXPLAIN','USE','SETTINGS','FORMAT','ARRAY','TUPLE','MAP','PREWHERE','FINAL',
  'SAMPLE','TOP','ANTI','SEMI','ANY','ASOF','GLOBAL','LOCAL','ILIKE','USING',
]);
const SQL_FUNCS = new Set([
  'count','sum','avg','min','max','round','floor','ceil','abs','length',
  'lower','upper','substring','concat','toString','toDate','toDateTime',
  'toStartOfMonth','toStartOfWeek','toStartOfDay','toStartOfHour','now',
  'today','yesterday','formatDateTime','if','multiIf','coalesce','isNull',
  'isNotNull','quantile','quantiles','uniq','uniqExact','any','anyLast',
  'groupArray','groupUniqArray','arrayJoin','arrayMap','arrayFilter',
  'splitByChar','toUInt32','toInt64','toFloat64','toUInt8','greatest','least',
]);

// #25: backward-compatible optional second arg. Existing callers (formatter,
// highlighter) pass nothing and get the built-in sets.
function tokenize(sql, opts = {}) {
  const keywords = opts.keywords || SQL_KEYWORDS;
  const funcs = opts.funcs || SQL_FUNCS;
  const out = [];
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    if (c === '-' && sql[i + 1] === '-') {
      let j = i; while (j < n && sql[j] !== '\n') j++;
      out.push({ t: 'comment', v: sql.slice(i, j), i }); i = j; continue;
    }
    if (c === '/' && sql[i + 1] === '*') {
      let j = i + 2; while (j < n - 1 && !(sql[j] === '*' && sql[j + 1] === '/')) j++;
      j = Math.min(n, j + 2);
      out.push({ t: 'comment', v: sql.slice(i, j), i }); i = j; continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < n && sql[j] !== c) { if (sql[j] === '\\') j++; j++; }
      j = Math.min(n, j + 1);
      out.push({ t: c === '`' ? 'ident' : 'string', v: sql.slice(i, j), i }); i = j; continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i;
      while (j < n && /[0-9.eE+\-]/.test(sql[j])) {
        if ((sql[j] === '+' || sql[j] === '-') && !/[eE]/.test(sql[j - 1])) break;
        j++;
      }
      out.push({ t: 'number', v: sql.slice(i, j), i }); i = j; continue;
    }
    if (/[a-zA-Z_]/.test(c)) {
      let j = i;
      while (j < n && /[a-zA-Z0-9_]/.test(sql[j])) j++;
      const word = sql.slice(i, j);
      const upper = word.toUpperCase();
      let type = 'ident';
      if (keywords.has(upper)) type = 'keyword';
      else if (funcs.has(word)) type = 'func';
      out.push({ t: type, v: word, i }); i = j; continue;
    }
    if (/[=<>!+\-*/%(),.;]/.test(c)) { out.push({ t: 'op', v: c, i }); i++; continue; }
    let j = i;
    while (j < n && /\s/.test(sql[j])) j++;
    if (j > i) { out.push({ t: 'ws', v: sql.slice(i, j), i }); i = j; continue; }
    out.push({ t: 'other', v: c, i }); i++;
  }
  return out;
}
const highlightSql = (sql, opts) => tokenize(sql, opts);

function SqlHighlighter({ sql }) {
  const tokens = React.useMemo(() => tokenize(sql), [sql]);
  return (
    <>
      {tokens.map((tk, i) => tk.t === 'ws' ? tk.v : <span key={i} className={`sql-${tk.t}`}>{tk.v}</span>)}
      {'\n'}
    </>
  );
}

// ── caret/position geometry (monospace fast-path; whitespace:pre, no wrap) ────
let _measCanvas;
function charWidthFor(px) {
  _measCanvas = _measCanvas || document.createElement('canvas');
  const ctx = _measCanvas.getContext('2d');
  ctx.font = `${px}px "JetBrains Mono","SF Mono",ui-monospace,monospace`;
  return ctx.measureText('0').width;
}
function caretXY(value, pos, ta, fontSize, lhPx, padX, padY) {
  const before = value.slice(0, pos);
  const line = before.split('\n').length - 1;
  const col = pos - (before.lastIndexOf('\n') + 1);
  const cw = charWidthFor(fontSize);
  return { x: padX + col * cw - (ta ? ta.scrollLeft : 0), y: padY + line * lhPx - (ta ? ta.scrollTop : 0) };
}
function posFromXY(value, clientX, clientY, rect, ta, fontSize, lhPx, padX, padY) {
  const x = clientX - rect.left + ta.scrollLeft - padX;
  const y = clientY - rect.top + ta.scrollTop - padY;
  const line = Math.floor(y / lhPx);
  const lines = value.split('\n');
  if (line < 0 || line >= lines.length) return null;
  const col = Math.round(x / charWidthFor(fontSize));
  let pos = 0;
  for (let k = 0; k < line; k++) pos += lines[k].length + 1;
  return pos + Math.max(0, Math.min(col, lines[line].length));
}
function wordAt(value, pos) {
  if (pos == null) return null;
  let s = pos, e = pos;
  while (s > 0 && /[A-Za-z0-9_]/.test(value[s - 1])) s--;
  while (e < value.length && /[A-Za-z0-9_]/.test(value[e])) e++;
  if (s === e) return null;
  return { word: value.slice(s, e), from: s, to: e };
}

// ── bracket matching (#24) ───────────────────────────────────────────────────
const OPEN = { '(': ')', '[': ']', '{': '}' };
const CLOSE = { ')': '(', ']': '[', '}': '{' };
function matchBracketAt(value, caret) {
  const tryFrom = (idx, dir) => {
    const ch = value[idx];
    if (dir === 1 && OPEN[ch]) {
      let depth = 0;
      for (let k = idx; k < value.length; k++) {
        if (value[k] === ch) depth++;
        else if (value[k] === OPEN[ch]) { depth--; if (depth === 0) return [idx, k]; }
      }
    } else if (dir === -1 && CLOSE[ch]) {
      let depth = 0;
      for (let k = idx; k >= 0; k--) {
        if (value[k] === ch) depth++;
        else if (value[k] === CLOSE[ch]) { depth--; if (depth === 0) return [k, idx]; }
      }
    }
    return null;
  };
  return tryFrom(caret, 1) || (caret > 0 ? tryFrom(caret - 1, -1) : null);
}

// ── transparent overlay: only mark backgrounds, never the token render path ──
function MarkOverlay({ value, marks, accent }) {
  if (!marks.length) return null;
  const bgFor = (cls) =>
    cls === 'active' ? `color-mix(in oklab, ${accent} 62%, transparent)`
    : cls === 'match' ? `color-mix(in oklab, ${accent} 26%, transparent)`
    : `color-mix(in oklab, ${accent} 34%, transparent)`; // bracket
  const pts = new Set([0, value.length]);
  marks.forEach((m) => { pts.add(m.start); pts.add(m.end); });
  const sorted = [...pts].filter((p) => p >= 0 && p <= value.length).sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i], b = sorted[i + 1];
    if (a === b) continue;
    const seg = value.slice(a, b);
    const cover = marks.filter((m) => m.start <= a && m.end >= b);
    if (cover.length) {
      const cls = cover.some((m) => m.cls === 'active') ? 'active'
        : cover.some((m) => m.cls === 'match') ? 'match' : cover[0].cls;
      out.push(<span key={i} style={{ background: bgFor(cls), borderRadius: 2 }}>{seg}</span>);
    } else out.push(seg);
  }
  out.push('\n');
  return out;
}

function SqlEditor({ value, onChange, accent = '#FF6B35', fontSize = 13, density = 'comfortable' }) {
  const taRef = React.useRef(null);
  const preRef = React.useRef(null);
  const overlayRef = React.useRef(null);
  const lineRef = React.useRef(null);
  const wrapRef = React.useRef(null);
  const pendingSel = React.useRef(null);

  const [caret, setCaret] = React.useState(0);
  const [selEnd, setSelEnd] = React.useState(0);

  // completion / search / popover state
  const completions = React.useMemo(() => buildCompletions(window.SCHEMA), []);
  const [ac, setAc] = React.useState(null);        // {items, active, ctx}
  const [searchOpen, setSearchOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const [replace, setReplace] = React.useState('');
  const [sopts, setSopts] = React.useState({ caseSensitive: false, wholeWord: false, regex: false });
  const [showReplace, setShowReplace] = React.useState(false);
  const [activeMatch, setActiveMatch] = React.useState(0);
  const [hover, setHover] = React.useState(null);
  const searchInputRef = React.useRef(null);
  const hoverTimer = React.useRef(null);

  const lineHeight = density === 'compact' ? 1.5 : 1.7;
  const padY = density === 'compact' ? 8 : 12;
  const padX = 14;
  const lhPx = fontSize * lineHeight;
  const lines = value.split('\n');

  React.useLayoutEffect(() => {
    if (pendingSel.current != null && taRef.current) {
      const [s, e] = pendingSel.current;
      taRef.current.selectionStart = s;
      taRef.current.selectionEnd = e;
      pendingSel.current = null;
      setCaret(s); setSelEnd(e);
    }
  });

  const apply = (newVal, s, e = s) => { pendingSel.current = [s, e]; onChange(newVal); };

  const syncCaret = () => {
    const ta = taRef.current; if (!ta) return;
    setCaret(ta.selectionStart); setSelEnd(ta.selectionEnd);
  };

  const onScroll = () => {
    const ta = taRef.current;
    if (preRef.current) { preRef.current.scrollTop = ta.scrollTop; preRef.current.scrollLeft = ta.scrollLeft; }
    if (overlayRef.current) { overlayRef.current.scrollTop = ta.scrollTop; overlayRef.current.scrollLeft = ta.scrollLeft; }
    if (lineRef.current) lineRef.current.scrollTop = ta.scrollTop;
    setAc(null);
  };

  // ── autocomplete trigger ───────────────────────────────────────────────────
  const refreshComplete = (val, pos) => {
    const ctx = completionContext(val, pos);
    if (!ctx.qualified && ctx.word.length < 1) { setAc(null); return; }
    const items = rankCompletions(completions, ctx);
    if (!items.length) { setAc(null); return; }
    setAc({ items, active: 0, ctx });
  };

  const acceptCompletion = (it) => {
    if (!ac) return;
    const { from, to } = ac.ctx;
    const ins = it.insert;
    const newVal = value.slice(0, from) + ins + value.slice(to);
    const caretPos = from + ins.length;
    apply(newVal, caretPos);
    setAc(null);
  };

  // ── key handling: tab, brackets, autoclose, autocomplete nav, cmd+f ──────────
  const onKeyDown = (e) => {
    const ta = e.target;
    const s = ta.selectionStart, en = ta.selectionEnd;

    // Cmd/Ctrl+F — registered on the textarea so the browser's native find
    // doesn't intercept first (resolved design decision).
    if ((e.metaKey || e.ctrlKey) && (e.key === 'f' || e.key === 'F')) {
      e.preventDefault();
      setSearchOpen(true);
      requestAnimationFrame(() => searchInputRef.current?.focus());
      return;
    }

    // autocomplete navigation
    if (ac) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setAc({ ...ac, active: (ac.active + 1) % ac.items.length }); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setAc({ ...ac, active: (ac.active - 1 + ac.items.length) % ac.items.length }); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); acceptCompletion(ac.items[ac.active]); return; }
      if (e.key === 'Escape') { e.preventDefault(); setAc(null); return; }
    }

    if (e.key === 'Tab') {
      e.preventDefault();
      apply(value.slice(0, s) + '  ' + value.slice(en), s + 2);
      return;
    }

    // auto-close pairs + wrap selection (#24)
    if (OPEN[e.key]) {
      e.preventDefault();
      const close = OPEN[e.key];
      if (s !== en) { // wrap
        apply(value.slice(0, s) + e.key + value.slice(s, en) + close + value.slice(en), s + 1, en + 1);
      } else {
        apply(value.slice(0, s) + e.key + close + value.slice(en), s + 1);
      }
      return;
    }
    if ((e.key === "'" || e.key === '"' || e.key === '`')) {
      const q = e.key;
      if (s !== en) { e.preventDefault(); apply(value.slice(0, s) + q + value.slice(s, en) + q + value.slice(en), s + 1, en + 1); return; }
      if (value[s] === q) { e.preventDefault(); apply(value, s + 1); return; } // type over
      e.preventDefault(); apply(value.slice(0, s) + q + q + value.slice(en), s + 1); return;
    }
    if (CLOSE[e.key] && value[s] === e.key && s === en) { // type over closer
      e.preventDefault(); apply(value, s + 1); return;
    }
    if (e.key === 'Backspace' && s === en && s > 0) {
      const prev = value[s - 1], next = value[s];
      if ((OPEN[prev] && next === OPEN[prev]) || ((prev === "'" || prev === '"' || prev === '`') && next === prev)) {
        e.preventDefault(); apply(value.slice(0, s - 1) + value.slice(s + 1), s - 1); return;
      }
    }
  };

  const onChangeRaw = (e) => {
    const val = e.target.value;
    const pos = e.target.selectionStart;
    onChange(val);
    setCaret(pos); setSelEnd(pos);
    refreshComplete(val, pos);
  };

  // ── search ───────────────────────────────────────────────────────────────
  const matches = React.useMemo(
    () => (searchOpen && query ? findMatches(value, query, sopts) : []),
    [searchOpen, query, value, sopts]);
  React.useEffect(() => { setActiveMatch((a) => matches.length ? Math.min(a, matches.length - 1) : 0); }, [matches.length]);

  const scrollToMatch = (m) => {
    const ta = taRef.current; if (!ta || !m) return;
    const line = value.slice(0, m.start).split('\n').length - 1;
    const top = line * lhPx;
    if (top < ta.scrollTop + padY || top > ta.scrollTop + ta.clientHeight - lhPx - padY) {
      ta.scrollTop = Math.max(0, top - ta.clientHeight / 2);
      onScroll();
    }
  };
  const gotoMatch = (idx) => { const i = (idx + matches.length) % matches.length; setActiveMatch(i); scrollToMatch(matches[i]); };
  const doReplace = () => {
    const m = matches[activeMatch]; if (!m) return;
    apply(value.slice(0, m.start) + replace + value.slice(m.end), m.start + replace.length);
    requestAnimationFrame(() => searchInputRef.current?.focus());
  };
  const doReplaceAll = () => {
    if (!matches.length) return;
    let out = '', last = 0;
    for (const m of matches) { out += value.slice(last, m.start) + replace; last = m.end; }
    out += value.slice(last);
    apply(out, Math.min(caret, out.length));
  };
  const closeSearch = () => { setSearchOpen(false); requestAnimationFrame(() => taRef.current?.focus()); };

  // ── marks (search + bracket pair) ──────────────────────────────────────────
  const marks = React.useMemo(() => {
    const ms = [];
    if (searchOpen) matches.forEach((m, i) => ms.push({ start: m.start, end: m.end, cls: i === activeMatch ? 'active' : 'match' }));
    if (!searchOpen && caret === selEnd) {
      const bp = matchBracketAt(value, caret);
      if (bp) { ms.push({ start: bp[0], end: bp[0] + 1, cls: 'bracket' }); ms.push({ start: bp[1], end: bp[1] + 1, cls: 'bracket' }); }
    }
    return ms;
  }, [searchOpen, matches, activeMatch, value, caret, selEnd]);

  // ── signature help (#27) ────────────────────────────────────────────────────
  const sig = React.useMemo(() => {
    if (ac || caret !== selEnd) return null;
    const sc = signatureContext(value, caret);
    if (!sc) return null;
    const meta = REF_FUNCTIONS[sc.name];
    if (!meta) return null;
    return { ...sc, sig: meta.sig, ret: meta.ret };
  }, [value, caret, selEnd, ac]);

  // ── hover docs (#27) ────────────────────────────────────────────────────────
  const onMouseMove = (e) => {
    clearTimeout(hoverTimer.current);
    const ta = taRef.current; if (!ta) { return; }
    const cx = e.clientX, cy = e.clientY;
    hoverTimer.current = setTimeout(() => {
      const rect = ta.getBoundingClientRect();
      const pos = posFromXY(value, cx, cy, rect, ta, fontSize, lhPx, padX, padY);
      const w = wordAt(value, pos);
      if (!w) { setHover(null); return; }
      const fn = REF_FUNCTIONS[w.word];
      const kw = REF_KEYWORD_DOCS[w.word.toUpperCase()];
      if (fn) setHover({ x: cx, y: cy, sig: fn.sig, ret: fn.ret, doc: fn.desc });
      else if (kw) setHover({ x: cx, y: cy, title: w.word.toUpperCase(), doc: kw });
      else setHover(null);
    }, 350);
  };
  const onMouseLeave = () => { clearTimeout(hoverTimer.current); setHover(null); };

  const sharedText = {
    margin: 0, padding: `${padY}px ${padX}px`, fontFamily: 'inherit', fontSize: 'inherit',
    lineHeight: 'inherit', whiteSpace: 'pre', border: 'none', position: 'absolute', inset: 0,
  };
  const caretCoords = caretXY(value, caret, taRef.current, fontSize, lhPx, padX, padY);
  // Screen-space caret position for body-portaled popovers (so the editor's
  // overflow:hidden can't clip them). Falls back to 0,0 before first mount.
  const taRect = taRef.current ? taRef.current.getBoundingClientRect() : null;
  const popCoords = {
    cx: (taRect ? taRect.left : 0) + caretCoords.x,
    cy: (taRect ? taRect.top : 0) + caretCoords.y,
    lhPx,
    vw: typeof window !== 'undefined' ? window.innerWidth : 1280,
    vh: typeof window !== 'undefined' ? window.innerHeight : 800,
    accent,
  };

  return (
    <div className="sql-editor" style={{
      position: 'relative', display: 'flex', width: '100%', height: '100%',
      fontFamily: '"JetBrains Mono","SF Mono",ui-monospace,monospace',
      fontSize, lineHeight, background: 'var(--bg-editor)', color: 'var(--fg)', overflow: 'hidden',
      '--accent': accent,
    }}>
      <div ref={lineRef} className="sql-gutter" style={{
        flexShrink: 0, width: 44, padding: `${padY}px 8px ${padY}px 0`, textAlign: 'right',
        color: 'var(--fg-faint)', userSelect: 'none', background: 'var(--bg-gutter)',
        borderRight: '1px solid var(--border)', overflow: 'hidden', fontVariantNumeric: 'tabular-nums',
      }}>
        {lines.map((_, i) => <div key={i} style={{ height: `${lineHeight}em` }}>{i + 1}</div>)}
      </div>

      <div ref={wrapRef} style={{ position: 'relative', flex: 1, overflow: 'hidden' }}
        onMouseMove={onMouseMove} onMouseLeave={onMouseLeave}>
        {/* mark overlay (below tokens; transparent text, only backgrounds show) */}
        <pre ref={overlayRef} aria-hidden="true" style={{ ...sharedText, color: 'transparent', overflow: 'hidden', pointerEvents: 'none' }}>
          <MarkOverlay value={value} marks={marks} accent={accent} />
        </pre>
        {/* token highlight */}
        <pre ref={preRef} aria-hidden="true" style={{ ...sharedText, color: 'inherit', overflow: 'hidden', pointerEvents: 'none' }}>
          <SqlHighlighter sql={value} />
        </pre>
        <textarea
          ref={taRef}
          value={value}
          onChange={onChangeRaw}
          onScroll={onScroll}
          onKeyDown={onKeyDown}
          onSelect={syncCaret}
          onKeyUp={syncCaret}
          onClick={() => { syncCaret(); setAc(null); }}
          onBlur={() => setTimeout(() => setAc(null), 120)}
          spellCheck={false}
          style={{
            ...sharedText, background: 'transparent', color: 'transparent', caretColor: accent,
            outline: 'none', resize: 'none', overflow: 'auto', tabSize: 2, zIndex: 2,
          }}
        />

        {searchOpen && (
          <SearchPanel
            accent={accent} query={query} setQuery={setQuery} replace={replace} setReplace={setReplace}
            opts={sopts} setOpts={setSopts} matchCount={matches.length} activeIndex={activeMatch}
            showReplace={showReplace} setShowReplace={setShowReplace}
            onNext={() => gotoMatch(activeMatch + 1)} onPrev={() => gotoMatch(activeMatch - 1)}
            onReplace={doReplace} onReplaceAll={doReplaceAll} onClose={closeSearch} inputRef={searchInputRef}
          />
        )}

        {ac && (
          <AutocompleteDropdown
            items={ac.items} active={ac.active} query={ac.ctx.word} accent={accent}
            coords={popCoords}
            onPick={acceptCompletion}
          />
        )}

        {sig && (
          <SignatureHelp sig={sig.sig} name={sig.name} argIdx={sig.argIdx} ret={sig.ret}
            coords={popCoords} />
        )}
      </div>

      {hover && <HoverCard {...hover} />}
    </div>
  );
}

// ── FORMATTER (unchanged) ─────────────────────────────────────────────────────
const FMT_NEWLINE_KW = new Set([
  'SELECT','FROM','WHERE','PREWHERE','GROUP','ORDER','HAVING','LIMIT','UNION',
  'SETTINGS','FORMAT','WITH','JOIN','LEFT','RIGHT','INNER','OUTER','FULL',
  'CROSS','ON','INSERT','VALUES','UPDATE','SET','DELETE','ARRAY',
]);
const FMT_JOIN_PREFIX = new Set(['LEFT','RIGHT','INNER','OUTER','FULL','CROSS','ANY','ALL','ASOF','SEMI','ANTI','GLOBAL']);
function fmtNeedSpace(prev, cur) {
  if (!prev) return false;
  const pv = prev.v, cv = cur.v;
  if (cv === ',' || cv === ')' || cv === ';') return false;
  if (pv === '(') return false;
  if (pv === '.' || cv === '.') return false;
  if (cv === '(') return prev.t === 'keyword';
  return true;
}
function formatSql(sql) {
  if (!sql || !sql.trim()) return sql;
  const toks = tokenize(sql).filter((t) => t.t !== 'ws' && t.v !== '');
  let out = '', depth = 0, prev = null;
  for (const tk of toks) {
    let v = tk.v;
    const uv = v.toUpperCase();
    if (tk.t === 'keyword') v = uv;
    if (v === '(') depth++;
    let newline = false;
    if (tk.t === 'keyword' && depth === 0 && FMT_NEWLINE_KW.has(uv)) {
      const prevUv = prev && prev.t === 'keyword' ? prev.v.toUpperCase() : null;
      if (uv === 'BY') newline = false;
      else if (uv === 'JOIN' && prevUv && FMT_JOIN_PREFIX.has(prevUv)) newline = false;
      else if (uv === 'SET' && prevUv === 'OFFSET') newline = false;
      else newline = true;
    }
    if (out === '') out = v;
    else if (newline) out += '\n' + v;
    else out += (fmtNeedSpace(prev, tk) ? ' ' : '') + v;
    if (v === ')') depth = Math.max(0, depth - 1);
    prev = tk;
  }
  return out;
}

Object.assign(window, { SqlEditor, highlightSql, tokenize, formatSql });
