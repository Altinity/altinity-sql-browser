// components.jsx — schema browser, results pane, header, history/saved

// ─── ICONS ────────────────────────────────────────────────────────────
const Icon = {
  chev: (props) => <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" {...props}><path d="M3 2l3 3-3 3"/></svg>,
  chevDown: (props) => <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" {...props}><path d="M2 3l3 3 3-3"/></svg>,
  database: (props) => <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" {...props}><ellipse cx="7" cy="3" rx="5" ry="1.6"/><path d="M2 3v8c0 .9 2.2 1.6 5 1.6s5-.7 5-1.6V3M2 7c0 .9 2.2 1.6 5 1.6s5-.7 5-1.6"/></svg>,
  table: (props) => <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" {...props}><rect x="2" y="2.5" width="10" height="9" rx="1"/><path d="M2 5.5h10M2 8.5h10M5.5 5.5v6"/></svg>,
  col: (props) => <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4" {...props}><rect x="2" y="2" width="8" height="8" rx="1"/><path d="M2 5h8M2 8h8"/></svg>,
  play: (props) => <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" {...props}><path d="M3 2l7 4-7 4z"/></svg>,
  star: (filled, props={}) => <svg width="12" height="12" viewBox="0 0 12 12" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" {...props}><path d="M6 1.5l1.4 2.9 3.1.4-2.3 2.2.6 3.1L6 8.6l-2.8 1.5.6-3.1-2.3-2.2 3.1-.4z"/></svg>,
  plus: (props) => <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" {...props}><path d="M6 2v8M2 6h8"/></svg>,
  close: (props) => <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" {...props}><path d="M2 2l6 6M8 2l-6 6"/></svg>,
  search: (props) => <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" {...props}><circle cx="5" cy="5" r="3"/><path d="M7.5 7.5L10 10"/></svg>,
  history: (props) => <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" {...props}><path d="M2.5 5.5a3.5 3.5 0 1 1 1 2.5"/><path d="M2 3v2.5h2.5"/><path d="M6 3.5V6l1.5 1"/></svg>,
  download: (props) => <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" {...props}><path d="M6 1.5v6.5M3 5.5L6 8l3-2.5M2 10h8"/></svg>,
  share: (props) => <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" {...props}><circle cx="9" cy="3" r="1.5"/><circle cx="3" cy="6" r="1.5"/><circle cx="9" cy="9" r="1.5"/><path d="M4.3 5.3l3.4-1.6M4.3 6.7l3.4 1.6"/></svg>,
  copy: (props) => <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4" {...props}><rect x="3.5" y="3.5" width="6.5" height="7" rx="1"/><path d="M2 8.5V2.5a1 1 0 0 1 1-1h6"/></svg>,
  table2: (props) => <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4" {...props}><rect x="1.5" y="2" width="9" height="8" rx=".5"/><path d="M1.5 4.5h9M1.5 7h9M4.5 4.5v5"/></svg>,
  chart: (props) => <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" {...props}><path d="M2 10V7M5 10V4M8 10V6M11 10V2"/></svg>,
  json: (props) => <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" {...props}><path d="M4 1.5C2.5 1.5 2.5 3 2.5 4S2.5 5 1.5 6c1 1 1 2 1 2s0 1.5 1.5 1.5M8 1.5c1.5 0 1.5 1.5 1.5 2.5s0 1 1 2c-1 1-1 2-1 2s0 1.5-1.5 1.5"/></svg>,
  sortAsc: (props) => <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" {...props}><path d="M5 8V2M2.5 4.5L5 2l2.5 2.5"/></svg>,
  sortDesc: (props) => <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" {...props}><path d="M5 2v6M2.5 5.5L5 8l2.5-2.5"/></svg>,
  filter: (props) => <svg width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" {...props}><path d="M1.5 2h8L6.5 6v3l-2 1V6z"/></svg>,
  shortcuts: (props) => <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" {...props}><rect x="1.5" y="3" width="9" height="6" rx="1"/><path d="M3.5 5h.01M6 5h.01M8.5 5h.01M3.5 7h5"/></svg>,
  clock: (props) => <svg width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" {...props}><circle cx="5.5" cy="5.5" r="4"/><path d="M5.5 3.5V5.5L7 6.5"/></svg>,
  rows: (props) => <svg width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="currentColor" strokeWidth="1.4" {...props}><rect x="1.5" y="2" width="8" height="7" rx=".5"/><path d="M1.5 4.5h8M1.5 7h8"/></svg>,
  bytes: (props) => <svg width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" {...props}><path d="M2 8.5V3.5L5.5 6 9 3.5v5"/></svg>,
  bookmark: (props) => <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" {...props}><path d="M3 1.5h6v9L6 8.5 3 10.5z"/></svg>,
  pencil: (props) => <svg width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" {...props}><path d="M7.5 1.8l1.7 1.7L4 8.7l-2.2.5.5-2.2z"/></svg>,
  trash: (props) => <svg width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" {...props}><path d="M2 3h7M4 3V1.8h3V3M3 3l.4 6.2h4.2L8 3"/></svg>,
  check: (props) => <svg width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" {...props}><path d="M2 5.5L4.3 8 9 3"/></svg>,
  upload: (props) => <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" {...props}><path d="M6 8.5V2M3 4.5L6 2l3 2.5M2 10h8"/></svg>,
  logout: (props) => <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" {...props}><path d="M5 11H2.5A.5.5 0 0 1 2 10.5v-8A.5.5 0 0 1 2.5 2H5M8.5 9L11 6.5 8.5 4M11 6.5H5"/></svg>,
  spinner: ({ size = 13, ...props } = {}) => <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" {...props}><path d="M8 1.5a6.5 6.5 0 1 0 6.5 6.5" opacity="0.9"/><path d="M8 1.5a6.5 6.5 0 0 1 6.5 6.5" opacity="0.2"/></svg>,
  github: (props) => <svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor" {...props}><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>,
};

// ─── HEADER ───────────────────────────────────────────────────────────
function AppHeader({ accent, onShortcuts }) {
  const USER = { name: 'Demo User', email: 'demo@antalya.altinity.cloud', initials: 'DM', role: 'Read-only · demo' };
  const [menuOpen, setMenuOpen] = React.useState(false);
  const [confirmOut, setConfirmOut] = React.useState(false);
  return (
    <div className="app-header" style={{
      height: 44,
      display: 'flex',
      alignItems: 'center',
      padding: '0 14px',
      background: 'var(--bg-header)',
      borderBottom: '1px solid var(--border)',
      gap: 14,
      flexShrink: 0,
    }}>
      {/* Logo */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{
          width: 22, height: 22, borderRadius: 5,
          background: `linear-gradient(135deg, ${accent}, color-mix(in oklab, ${accent} 70%, #000))`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: 'white', fontWeight: 700, fontSize: 12,
        }}>A</div>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--fg)' }}>Altinity Play</div>
        <div style={{ fontSize: 11, color: 'var(--fg-faint)', padding: '2px 6px',
          background: 'var(--bg-chip)', borderRadius: 4, fontFamily: 'var(--mono)' }}>
          antalya.demo
        </div>
      </div>

      <div style={{ flex: 1 }} />

      {/* Connection status */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: 'var(--fg-mute)', whiteSpace: 'nowrap', flexShrink: 0 }}>
        <div style={{ width: 7, height: 7, borderRadius: 4, background: '#22c55e', boxShadow: '0 0 6px #22c55e', flexShrink: 0 }} />
        <span style={{ fontFamily: 'var(--mono)' }}>ClickHouse 26.3.10</span>
      </div>

      <a className="hd-btn" href="https://github.com/Altinity/ClickHouse" target="_blank" rel="noopener noreferrer" title="View on GitHub">
        <Icon.github />
      </a>

      <button className="hd-btn" onClick={onShortcuts} title="Keyboard shortcuts (?)">
        <Icon.shortcuts />
      </button>

      {/* User menu */}
      <div style={{ position: 'relative' }}>
        <button
          onClick={() => setMenuOpen(o => !o)}
          title={USER.email}
          style={{
            display: 'flex', alignItems: 'center', gap: 6, height: 30, padding: '0 4px',
            border: 'none', background: 'transparent', cursor: 'pointer', borderRadius: 6,
          }}
          onMouseEnter={(e) => e.currentTarget.style.background = 'var(--bg-hover)'}
          onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
        >
          <span style={{ width: 24, height: 24, borderRadius: 12, background: 'var(--bg-chip)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 10.5, fontWeight: 600, color: 'var(--fg-mute)' }}>{USER.initials}</span>
          <span style={{ color: 'var(--fg-faint)', display: 'flex' }}><Icon.chevDown /></span>
        </button>

        {menuOpen && (
          <>
            <div onClick={() => setMenuOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 40 }} />
            <div style={{
              position: 'absolute', top: 'calc(100% + 6px)', right: 0, zIndex: 41,
              width: 230, background: 'var(--bg-modal)', border: '1px solid var(--border)',
              borderRadius: 9, boxShadow: '0 12px 36px rgba(0,0,0,.35)', overflow: 'hidden',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 13px', borderBottom: '1px solid var(--border-faint)' }}>
                <span style={{ width: 32, height: 32, borderRadius: 16, background: accent,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 12, fontWeight: 700, color: '#fff', flexShrink: 0 }}>{USER.initials}</span>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--fg)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{USER.name}</div>
                  <div style={{ fontSize: 11, color: 'var(--fg-faint)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{USER.email}</div>
                </div>
              </div>
              <div style={{ padding: '6px 13px', fontSize: 10.5, color: 'var(--fg-faint)', borderBottom: '1px solid var(--border-faint)', fontFamily: 'var(--mono)' }}>
                {USER.role}
              </div>
              <div style={{ padding: 5 }}>
                <button
                  onClick={() => { setMenuOpen(false); setConfirmOut(true); }}
                  style={{
                    width: '100%', display: 'flex', alignItems: 'center', gap: 8,
                    padding: '8px 9px', border: 'none', background: 'transparent',
                    color: '#ef4444', fontSize: 12, fontWeight: 500, fontFamily: 'inherit',
                    cursor: 'pointer', borderRadius: 6, textAlign: 'left', whiteSpace: 'nowrap',
                  }}
                  onMouseEnter={(e) => e.currentTarget.style.background = 'color-mix(in oklab, #ef4444 12%, transparent)'}
                  onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                ><Icon.logout /> Log out</button>
              </div>
            </div>
          </>
        )}
      </div>

      {confirmOut && (
        <div onClick={() => setConfirmOut(false)} style={{
          position: 'fixed', inset: 0, zIndex: 120,
          background: 'rgba(0,0,0,.5)', backdropFilter: 'blur(4px)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <div onClick={e => e.stopPropagation()} style={{
            width: 340, background: 'var(--bg-modal)', borderRadius: 11,
            border: '1px solid var(--border)', boxShadow: '0 20px 60px rgba(0,0,0,.45)',
            padding: '20px 22px',
          }}>
            <div style={{ fontSize: 14.5, fontWeight: 600, color: 'var(--fg)', marginBottom: 6 }}>Log out?</div>
            <div style={{ fontSize: 12.5, color: 'var(--fg-mute)', lineHeight: 1.5, marginBottom: 18 }}>
              You'll be signed out of <span style={{ color: 'var(--fg)' }}>{USER.email}</span>. Unsaved query tabs stay in this browser; saved queries are kept.
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button onClick={() => setConfirmOut(false)} style={{
                height: 30, padding: '0 14px', border: '1px solid var(--border)', borderRadius: 6,
                background: 'transparent', color: 'var(--fg)', fontSize: 12, fontWeight: 500,
                fontFamily: 'inherit', cursor: 'pointer',
              }}>Cancel</button>
              <button onClick={() => setConfirmOut(false)} style={{
                height: 30, padding: '0 14px', border: 'none', borderRadius: 6,
                background: '#ef4444', color: '#fff', fontSize: 12, fontWeight: 600,
                fontFamily: 'inherit', cursor: 'pointer', whiteSpace: 'nowrap',
              }}>Log out</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── SCHEMA TREE ──────────────────────────────────────────────────────
function SchemaTree({ accent, onInsertColumn }) {
  const [tree, setTree] = React.useState(SCHEMA);
  const [expandedTables, setExpandedTables] = React.useState(new Set(['ontime']));
  const [filter, setFilter] = React.useState('');

  const toggleDb = (name) => {
    setTree(t => t.map(db => db.name === name ? { ...db, expanded: !db.expanded } : db));
  };
  const toggleTable = (name) => {
    setExpandedTables(s => {
      const n = new Set(s);
      if (n.has(name)) n.delete(name); else n.add(name);
      return n;
    });
  };

  const matches = (s) => !filter || s.toLowerCase().includes(filter.toLowerCase());

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{
        padding: '8px 10px',
        borderBottom: '1px solid var(--border)',
        display: 'flex', alignItems: 'center', gap: 6,
      }}>
        <div style={{ flex: 1, position: 'relative' }}>
          <span style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', color: 'var(--fg-faint)' }}>
            <Icon.search />
          </span>
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Search tables, columns…"
            style={{
              width: '100%',
              height: 26,
              padding: '0 8px 0 26px',
              background: 'var(--bg-input)',
              border: '1px solid var(--border)',
              borderRadius: 5,
              color: 'var(--fg)',
              fontSize: 11.5,
              outline: 'none',
              fontFamily: 'inherit',
            }}
          />
        </div>
      </div>
      <div style={{ flex: 1, overflow: 'auto', padding: '4px 0' }}>
        {tree.map(db => (
          <div key={db.name}>
            <TreeRow
              indent={0}
              icon={<Icon.database style={{ color: 'var(--fg-mute)' }} />}
              chevron={db.expanded ? <Icon.chevDown /> : <Icon.chev />}
              onClick={() => toggleDb(db.name)}
              label={db.name}
              meta={`${db.children.length}`}
              bold
            />
            {db.expanded && db.children.map(tb => {
              const tkey = `${db.name}.${tb.name}`;
              const open = expandedTables.has(tb.name);
              const tableMatch = matches(tb.name);
              const cols = tb.columns || [];
              const visibleCols = cols.filter(c => matches(c.name));
              if (filter && !tableMatch && visibleCols.length === 0) return null;
              return (
                <div key={tkey}>
                  <TreeRow
                    indent={1}
                    icon={<Icon.table style={{ color: accent }} />}
                    chevron={cols.length ? (open ? <Icon.chevDown /> : <Icon.chev />) : null}
                    onClick={() => cols.length && toggleTable(tb.name)}
                    label={tb.name}
                    meta={tb.rows}
                    highlight={filter && tableMatch}
                  />
                  {(open || (filter && visibleCols.length > 0)) && visibleCols.map(c => (
                    <TreeRow
                      key={c.name}
                      indent={2}
                      icon={<Icon.col style={{ color: 'var(--fg-faint)' }} />}
                      label={c.name}
                      meta={c.type}
                      mono
                      onClick={() => onInsertColumn?.(c.name)}
                      highlight={filter && matches(c.name)}
                      small
                    />
                  ))}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

function TreeRow({ indent, icon, chevron, label, meta, bold, mono, highlight, onClick, small }) {
  const [hover, setHover] = React.useState(false);
  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        height: small ? 22 : 24,
        padding: `0 10px 0 ${10 + indent * 14}px`,
        cursor: 'pointer',
        background: hover ? 'var(--bg-hover)' : (highlight ? 'var(--bg-highlight)' : 'transparent'),
        fontSize: small ? 11 : 12,
        color: bold ? 'var(--fg)' : 'var(--fg-mute)',
        fontWeight: bold ? 600 : 400,
        fontFamily: mono ? 'var(--mono)' : 'inherit',
        userSelect: 'none',
      }}
    >
      <span style={{ width: 10, color: 'var(--fg-faint)', display: 'flex' }}>
        {chevron}
      </span>
      <span style={{ display: 'flex', alignItems: 'center' }}>{icon}</span>
      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
      {meta && <span style={{ fontSize: 10, color: 'var(--fg-faint)', fontFamily: 'var(--mono)', flexShrink: 0 }}>{meta}</span>}
    </div>
  );
}

// ─── SAVED QUERIES + HISTORY ──────────────────────────────────────────
function SavedHistoryPanel({ accent, onLoadQuery, savedQueries, onRename, onDelete, onToggleStar, onImport }) {
  const [tab, setTab] = React.useState('saved');
  const [toast, setToast] = React.useState(null);
  const fileRef = React.useRef(null);
  const list = savedQueries || SAVED_QUERIES;

  const flash = (msg) => { setToast(msg); setTimeout(() => setToast(null), 3200); };

  const exportJson = () => {
    const envelope = {
      format: 'altinity-sql-browser/saved-queries',
      version: 1,
      exportedAt: new Date().toISOString(),
      queries: list.map(q => ({
        id: q.id, name: q.name, sql: q.sql, starred: !!q.starred,
        createdAt: q.createdAt || null, updatedAt: q.updatedAt || null,
      })),
    };
    const blob = new Blob([JSON.stringify(envelope, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `sql-browser-queries-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    flash(`Exported ${list.length} ${list.length === 1 ? 'query' : 'queries'}`);
  };

  const importJson = (e) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-importing same file
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        if (data?.format !== 'altinity-sql-browser/saved-queries' || !Array.isArray(data.queries)) {
          flash('✕ Not a valid saved-queries file'); return;
        }
        if (typeof data.version === 'number' && data.version > 1) {
          flash('✕ File is from a newer version'); return;
        }
        const clean = data.queries
          .filter(q => q && typeof q.sql === 'string' && typeof q.name === 'string')
          .slice(0, 1000);
        if (!clean.length) { flash('✕ No valid queries in file'); return; }
        const summary = onImport?.(clean);
        if (summary) flash(`Added ${summary.added} · updated ${summary.updated} · skipped ${summary.skipped}`);
      } catch {
        flash('✕ Could not parse JSON');
      }
    };
    reader.readAsText(file);
  };

  const ioBtn = {
    flex: 1, height: 24, border: '1px solid var(--border)', borderRadius: 5,
    background: 'transparent', color: 'var(--fg-mute)', fontSize: 11,
    fontFamily: 'inherit', cursor: 'pointer', display: 'flex',
    alignItems: 'center', justifyContent: 'center', gap: 5,
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ display: 'flex', borderBottom: '1px solid var(--border)' }}>
        {['saved', 'history'].map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{
              flex: 1,
              height: 30,
              border: 'none',
              background: 'transparent',
              color: tab === t ? 'var(--fg)' : 'var(--fg-mute)',
              fontSize: 11.5,
              fontWeight: 500,
              fontFamily: 'inherit',
              cursor: 'pointer',
              borderBottom: tab === t ? `2px solid ${accent}` : '2px solid transparent',
              textTransform: 'capitalize',
            }}
          >{t === 'saved' ? `★ Saved${list.length ? ` · ${list.length}` : ''}` : '⏱ History'}</button>
        ))}
      </div>
      {tab === 'saved' && (
        <input ref={fileRef} type="file" accept="application/json,.json" onChange={importJson} style={{ display: 'none' }} />
      )}
      <div style={{ flex: 1, overflow: 'auto' }}>
        {tab === 'saved' && list.length === 0 && (
          <div style={{ padding: '20px 14px', fontSize: 11.5, color: 'var(--fg-faint)', lineHeight: 1.5, textAlign: 'center' }}>
            No saved queries yet.<br />Write a query and hit <span style={{ color: 'var(--fg-mute)' }}>Save</span>, or <span style={{ color: 'var(--fg-mute)' }}>Import</span> a file.
          </div>
        )}
        {tab === 'saved' && list.map(q => (
          <SavedItem key={q.id} q={q} accent={accent}
            onLoad={() => onLoadQuery(q)}
            onRename={onRename} onDelete={onDelete} onToggleStar={onToggleStar} />
        ))}
        {tab === 'history' && HISTORY.map(h => (
          <HistoryItem key={h.id} h={h} accent={accent} onLoad={() => onLoadQuery({ name: 'From history', sql: h.sql })} />
        ))}
      </div>
      {tab === 'saved' && toast && (
        <div style={{
          padding: '6px 10px', fontSize: 10.5, color: 'var(--fg-mute)',
          background: 'var(--bg-chip)', borderTop: '1px solid var(--border-faint)',
          fontFamily: 'var(--mono)',
        }}>{toast}</div>
      )}
      {tab === 'saved' && (
        <div style={{ display: 'flex', gap: 6, padding: '6px 10px', borderTop: '1px solid var(--border)', flexShrink: 0 }}>
          <button style={ioBtn} onClick={exportJson} disabled={!list.length}
            title="Download all saved queries as JSON"
            onMouseEnter={(e) => { if (list.length) { e.currentTarget.style.background = 'var(--bg-hover)'; e.currentTarget.style.color = 'var(--fg)'; } }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--fg-mute)'; }}
          ><Icon.download /> Export</button>
          <button style={ioBtn} onClick={() => fileRef.current?.click()}
            title="Import saved queries from a JSON file"
            onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-hover)'; e.currentTarget.style.color = 'var(--fg)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--fg-mute)'; }}
          ><Icon.upload /> Import</button>
        </div>
      )}
    </div>
  );
}

function SavedItem({ q, accent, onLoad, onRename, onDelete, onToggleStar }) {
  const [hover, setHover] = React.useState(false);
  const [editing, setEditing] = React.useState(false);
  const [name, setName] = React.useState(q.name);
  const inputRef = React.useRef(null);
  React.useEffect(() => { setName(q.name); }, [q.name]);

  const startEdit = (e) => {
    e.stopPropagation();
    setEditing(true);
    requestAnimationFrame(() => { inputRef.current?.focus(); inputRef.current?.select(); });
  };
  const commit = () => {
    setEditing(false);
    const n = name.trim();
    if (n && n !== q.name) onRename?.(q.id, n); else setName(q.name);
  };

  const actionBtn = {
    width: 20, height: 20, borderRadius: 4, border: 'none', padding: 0,
    background: 'transparent', color: 'var(--fg-faint)', cursor: 'pointer',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  };

  return (
    <div
      onClick={() => !editing && onLoad()}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        padding: '8px 10px',
        cursor: editing ? 'default' : 'pointer',
        background: hover ? 'var(--bg-hover)' : 'transparent',
        borderBottom: '1px solid var(--border-faint)',
        position: 'relative',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
        <span
          onClick={(e) => { e.stopPropagation(); onToggleStar?.(q.id); }}
          style={{ color: q.starred ? accent : 'var(--fg-faint)', display: 'flex', cursor: 'pointer', flexShrink: 0 }}
          title={q.starred ? 'Unstar' : 'Star'}
        >
          {Icon.star(q.starred)}
        </span>
        {editing ? (
          <input
            ref={inputRef}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); commit(); }
              if (e.key === 'Escape') { setName(q.name); setEditing(false); }
            }}
            style={{
              flex: 1, minWidth: 0, height: 20, padding: '0 5px',
              background: 'var(--bg-input)', border: `1px solid ${accent}`,
              borderRadius: 4, color: 'var(--fg)', fontSize: 12, fontWeight: 500,
              outline: 'none', fontFamily: 'inherit',
            }}
          />
        ) : (
          <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--fg)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {q.name}
          </span>
        )}
        {hover && !editing && (
          <div style={{ display: 'flex', gap: 1, flexShrink: 0 }}>
            <button style={actionBtn} title="Rename"
              onClick={startEdit}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-chip)'; e.currentTarget.style.color = 'var(--fg)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--fg-faint)'; }}
            ><Icon.pencil /></button>
            <button style={actionBtn} title="Delete"
              onClick={(e) => { e.stopPropagation(); onDelete?.(q.id); }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-chip)'; e.currentTarget.style.color = '#ef4444'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--fg-faint)'; }}
            ><Icon.trash /></button>
          </div>
        )}
      </div>
      <div style={{
        fontSize: 10.5,
        fontFamily: 'var(--mono)',
        color: 'var(--fg-faint)',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        paddingLeft: 18,
      }}>
        {q.sql.split('\n')[0]}
      </div>
    </div>
  );
}

function HistoryItem({ h, accent, onLoad }) {
  const [hover, setHover] = React.useState(false);
  return (
    <div
      onClick={onLoad}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        padding: '8px 10px',
        cursor: 'pointer',
        background: hover ? 'var(--bg-hover)' : 'transparent',
        borderBottom: '1px solid var(--border-faint)',
      }}
    >
      <div style={{
        fontSize: 11,
        fontFamily: 'var(--mono)',
        color: 'var(--fg)',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        marginBottom: 3,
      }}>
        {h.sql}
      </div>
      <div style={{ display: 'flex', gap: 10, fontSize: 10, color: 'var(--fg-faint)', fontFamily: 'var(--mono)' }}>
        <span>{h.when}</span>
        <span>{h.rows} rows</span>
        <span>{h.ms} ms</span>
      </div>
    </div>
  );
}

// ─── QUERY TABS ───────────────────────────────────────────────────────
function QueryTabs({ tabs, activeId, onSelect, onClose, onNew, accent }) {
  return (
    <div className="qtabs" style={{
      display: 'flex',
      alignItems: 'center',
      height: 34,
      background: 'var(--bg-tabs)',
      borderBottom: '1px solid var(--border)',
      flexShrink: 0,
      overflow: 'hidden',
    }}>
      <div style={{ display: 'flex', flex: 1, overflow: 'auto', height: '100%' }}>
        {tabs.map(t => {
          const active = t.id === activeId;
          return (
            <div
              key={t.id}
              onClick={() => onSelect(t.id)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '0 8px 0 12px',
                height: '100%',
                background: active ? 'var(--bg-editor)' : 'transparent',
                borderRight: '1px solid var(--border)',
                cursor: 'pointer',
                fontSize: 11.5,
                color: active ? 'var(--fg)' : 'var(--fg-mute)',
                fontWeight: active ? 500 : 400,
                position: 'relative',
                whiteSpace: 'nowrap',
                minWidth: 100,
              }}
            >
              {active && <div style={{
                position: 'absolute', top: 0, left: 0, right: 0, height: 2, background: accent
              }} />}
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.name}</span>
              {t.dirty && <span style={{
                width: 5, height: 5, borderRadius: 3, background: 'var(--fg-mute)'
              }} />}
              {tabs.length > 1 && (
                <button
                  onClick={(e) => { e.stopPropagation(); onClose(t.id); }}
                  style={{
                    width: 16, height: 16, borderRadius: 3, padding: 0,
                    border: 'none', background: 'transparent', color: 'var(--fg-faint)',
                    cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-hover)'; e.currentTarget.style.color = 'var(--fg)'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--fg-faint)'; }}
                ><Icon.close /></button>
              )}
            </div>
          );
        })}
      </div>
      <button
        onClick={onNew}
        style={{
          width: 32, height: '100%', border: 'none', background: 'transparent',
          color: 'var(--fg-mute)', cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          borderLeft: '1px solid var(--border)',
        }}
        onMouseEnter={(e) => e.currentTarget.style.color = 'var(--fg)'}
        onMouseLeave={(e) => e.currentTarget.style.color = 'var(--fg-mute)'}
        title="New query (⌘T)"
      ><Icon.plus /></button>
    </div>
  );
}

// ─── EDITOR TOOLBAR ───────────────────────────────────────────────────
function EditorToolbar({ accent, onRun, running, onFormat, onShare, onSave, currentName, isSaved, saveSignal }) {
  const [saveOpen, setSaveOpen] = React.useState(false);
  const [name, setName] = React.useState(currentName || '');
  const inputRef = React.useRef(null);

  const openSave = () => {
    setName(currentName && currentName !== 'Untitled query' ? currentName : '');
    setSaveOpen(true);
    requestAnimationFrame(() => inputRef.current?.focus());
  };
  const commit = () => {
    const n = name.trim();
    if (n) { onSave(n); setSaveOpen(false); }
  };

  // ⌘S from the app raises saveSignal — open the popover (skip initial mount).
  const firstSignal = React.useRef(true);
  React.useEffect(() => {
    if (firstSignal.current) { firstSignal.current = false; return; }
    openSave();
  }, [saveSignal]);

  return (
    <div style={{
      height: 38,
      display: 'flex',
      alignItems: 'center',
      padding: '0 10px',
      gap: 8,
      background: 'var(--bg-toolbar)',
      borderBottom: '1px solid var(--border)',
      flexShrink: 0,
      position: 'relative',
    }}>
      <button
        onClick={onRun}
        disabled={running}
        style={{
          height: 26,
          padding: '0 10px 0 8px',
          background: accent,
          color: 'white',
          border: 'none',
          borderRadius: 5,
          fontSize: 11.5,
          fontWeight: 600,
          cursor: running ? 'wait' : 'pointer',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          fontFamily: 'inherit',
          opacity: running ? 0.7 : 1,
          flexShrink: 0,
        }}
      >
        <Icon.play /> {running ? 'Running…' : 'Run'} <kbd style={{
          fontSize: 9.5, opacity: .8, padding: '1px 4px', background: 'rgba(0,0,0,.2)',
          borderRadius: 3, marginLeft: 4, fontFamily: 'var(--mono)'
        }}>⌘↵</kbd>
      </button>

      <button className="tb-btn" onClick={onFormat} title="Format SQL (⌘⇧F)">
        <span style={{ fontFamily: 'var(--mono)', fontSize: 11.5 }}>{ '{ }' }</span> Format
      </button>

      {/* Save + popover */}
      <div style={{ position: 'relative' }}>
        <button className="tb-btn" onClick={() => saveOpen ? setSaveOpen(false) : openSave()}
          style={isSaved ? { color: accent } : undefined} title="Save query (⌘S)">
          <Icon.bookmark /> {isSaved ? 'Saved' : 'Save'}
        </button>
        {saveOpen && (
          <>
            <div onClick={() => setSaveOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 30 }} />
            <div style={{
              position: 'absolute', top: 'calc(100% + 6px)', left: 0, zIndex: 31,
              width: 260, padding: 12, background: 'var(--bg-modal)',
              border: '1px solid var(--border)', borderRadius: 9,
              boxShadow: '0 12px 36px rgba(0,0,0,.35)',
            }}>
              <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: '.05em', textTransform: 'uppercase',
                color: 'var(--fg-faint)', marginBottom: 7 }}>Save query as</div>
              <input
                ref={inputRef}
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { e.preventDefault(); commit(); }
                  if (e.key === 'Escape') setSaveOpen(false);
                }}
                placeholder="e.g. Worst-delay carriers"
                style={{
                  width: '100%', height: 30, padding: '0 9px', boxSizing: 'border-box',
                  background: 'var(--bg-input)', border: '1px solid var(--border)',
                  borderRadius: 6, color: 'var(--fg)', fontSize: 12, outline: 'none',
                  fontFamily: 'inherit',
                }}
              />
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6, marginTop: 10 }}>
                <button className="tb-btn" onClick={() => setSaveOpen(false)}>Cancel</button>
                <button
                  onClick={commit}
                  disabled={!name.trim()}
                  style={{
                    height: 26, padding: '0 12px', border: 'none', borderRadius: 5,
                    background: accent, color: 'white', fontSize: 11.5, fontWeight: 600,
                    fontFamily: 'inherit', cursor: name.trim() ? 'pointer' : 'not-allowed',
                    opacity: name.trim() ? 1 : 0.5,
                  }}
                >Save</button>
              </div>
            </div>
          </>
        )}
      </div>

      <div style={{ flex: 1 }} />

      <button className="tb-btn" onClick={onShare}>
        <Icon.share /> Share
      </button>

      <select className="tb-select">
        <option>Format: TSV</option>
        <option>Format: CSV</option>
        <option>Format: JSON</option>
        <option>Format: Pretty</option>
      </select>
    </div>
  );
}

// ─── RESULTS ──────────────────────────────────────────────────────────
function ResultsPane({ result, accent, density, running, progress, onCancel }) {
  const [view, setView] = React.useState('table');
  const [sort, setSort] = React.useState({ col: null, dir: 'asc' });

  const sorted = React.useMemo(() => {
    if (!result || sort.col == null) return result?.rows;
    const idx = sort.col;
    const r = [...result.rows].sort((a, b) => {
      const av = a[idx], bv = b[idx];
      if (typeof av === 'number') return sort.dir === 'asc' ? av - bv : bv - av;
      return sort.dir === 'asc'
        ? String(av).localeCompare(String(bv))
        : String(bv).localeCompare(String(av));
    });
    return r;
  }, [result, sort]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {/* Results toolbar */}
      <div style={{
        height: 36,
        display: 'flex',
        alignItems: 'center',
        padding: '0 10px',
        gap: 10,
        background: 'var(--bg-toolbar)',
        borderBottom: '1px solid var(--border)',
        flexShrink: 0,
      }}>
        <div style={{ display: 'flex', background: 'var(--bg-chip)', borderRadius: 5, padding: 2 }}>
          {[
            { id: 'table', label: 'Table', icon: <Icon.table2 /> },
            { id: 'chart', label: 'Chart', icon: <Icon.chart /> },
            { id: 'json', label: 'JSON', icon: <Icon.json /> },
          ].map(v => (
            <button
              key={v.id}
              onClick={() => setView(v.id)}
              style={{
                height: 22,
                padding: '0 10px',
                border: 'none',
                background: view === v.id ? 'var(--bg-editor)' : 'transparent',
                color: view === v.id ? 'var(--fg)' : 'var(--fg-mute)',
                fontSize: 11,
                fontWeight: view === v.id ? 500 : 400,
                cursor: 'pointer',
                borderRadius: 4,
                display: 'flex',
                alignItems: 'center',
                gap: 5,
                fontFamily: 'inherit',
                boxShadow: view === v.id ? '0 1px 2px rgba(0,0,0,.15)' : 'none',
              }}
            >{v.icon}{v.label}</button>
          ))}
        </div>

        <div style={{ flex: 1 }} />

        {running ? (
          <>
            <LiveRunStats progress={progress} accent={accent} />
            <button className="tb-btn" onClick={onCancel} title="Cancel query (Esc)"
              style={{ color: 'var(--fg-mute)' }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'color-mix(in oklab, #ef4444 14%, transparent)'; e.currentTarget.style.color = '#ef4444'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--fg-mute)'; }}
            ><Icon.close /> Cancel <kbd style={{
              fontSize: 9.5, opacity: .7, padding: '1px 4px', background: 'var(--bg-chip)',
              borderRadius: 3, fontFamily: 'var(--mono)', marginLeft: 2 }}>Esc</kbd></button>
          </>
        ) : result ? (
          <>
            {result.cancelled && (
              <span style={{ fontSize: 10.5, color: '#ef4444', fontFamily: 'var(--mono)',
                padding: '2px 7px', borderRadius: 4, background: 'color-mix(in oklab, #ef4444 12%, transparent)' }}>
                Cancelled · partial
              </span>
            )}
            <Stat icon={<Icon.clock />} value={`${result.meta.ms} ms`} />
            <Stat icon={<Icon.rows />} value={`${result.meta.rows} rows`} />
            <Stat icon={<Icon.bytes />} value={result.meta.scanned} sub={`${result.meta.scannedRows} scanned`} />
            <button className="tb-btn"><Icon.copy /> Copy</button>
            <button className="tb-btn"><Icon.download /> Export</button>
          </>
        ) : null}
      </div>

      <div style={{ flex: 1, overflow: 'hidden', minHeight: 0, position: 'relative' }}>
        {/* Streaming progress strip atop the partial table */}
        {running && (
          <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 2, zIndex: 2,
            background: 'var(--bg-chip)', overflow: 'hidden' }}>
            {progress && progress.total ? (
              <div style={{ height: '100%', width: `${Math.min(100, (progress.read / progress.total) * 100)}%`,
                background: accent, transition: 'width .3s linear' }} />
            ) : (
              <div className="runsweep" style={{ height: '100%', width: '40%', background: accent }} />
            )}
          </div>
        )}
        {!result && !running && <EmptyResults />}
        {!result && running && <EmptyResults streaming />}
        {result && view === 'table' && (
          <ResultsTable result={result} sorted={sorted} sort={sort} setSort={setSort} accent={accent} density={density} streaming={running} />
        )}
        {result && view === 'chart' && <ResultsChart result={result} sorted={sorted} accent={accent} />}
        {result && view === 'json' && <ResultsJson result={result} sorted={sorted} accent={accent} />}
      </div>
    </div>
  );
}

// Live ms/rows/bytes counters shown in the toolbar while a query streams.
// ms ticks smoothly off a local clock; rows/bytes come from `progress`.
function LiveRunStats({ progress, accent }) {
  const [ms, setMs] = React.useState(0);
  React.useEffect(() => {
    const t0 = performance.now();
    const id = setInterval(() => setMs(performance.now() - t0), 50);
    return () => clearInterval(id);
  }, []);
  const fmt = (n) => n >= 1e9 ? (n/1e9).toFixed(2)+'B' : n >= 1e6 ? (n/1e6).toFixed(1)+'M' : n >= 1e3 ? (n/1e3).toFixed(0)+'K' : String(n);
  const liveStat = {
    display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: accent,
    fontFamily: 'var(--mono)', padding: '0 8px', borderRight: '1px solid var(--border-faint)',
  };
  return (
    <>
      <div style={liveStat}><span className="spin" style={{ display: 'flex' }}><Icon.spinner /></span><span>{ms.toFixed(0)} ms</span></div>
      {progress && <div style={liveStat}><Icon.rows /><span>{fmt(progress.read)} rows</span></div>}
      {progress && <div style={liveStat}><Icon.bytes /><span>{progress.bytes}</span></div>}
    </>
  );
}

function Stat({ icon, value, sub }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 5,
      fontSize: 11, color: 'var(--fg-mute)', fontFamily: 'var(--mono)',
      padding: '0 8px', borderRight: '1px solid var(--border-faint)',
    }} title={sub}>
      <span style={{ color: 'var(--fg-faint)' }}>{icon}</span>
      <span style={{ color: 'var(--fg)' }}>{value}</span>
    </div>
  );
}

function EmptyResults({ streaming }) {
  return (
    <div style={{
      height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center',
      flexDirection: 'column', gap: 6, color: 'var(--fg-faint)', fontSize: 12,
      background: 'var(--bg-table)',
    }}>
      <div style={{
        width: 36, height: 36, borderRadius: 18, background: 'var(--bg-chip)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>{streaming ? <span className="spin" style={{ display: 'flex' }}><Icon.spinner /></span> : <Icon.play style={{ opacity: .5 }} />}</div>
      {streaming ? <div>Starting query…</div> : (
        <div>Press <kbd style={{
          padding: '1px 5px', background: 'var(--bg-chip)', borderRadius: 3,
          fontFamily: 'var(--mono)', fontSize: 10.5,
        }}>⌘↵</kbd> to run query</div>
      )}
    </div>
  );
}

function ResultsTable({ result, sorted, sort, setSort, accent, density }) {
  const cellPad = density === 'compact' ? '4px 10px' : '7px 12px';
  return (
    <div style={{ height: '100%', overflow: 'auto', background: 'var(--bg-table)' }}>
      <table style={{
        borderCollapse: 'collapse',
        fontFamily: 'var(--mono)',
        fontSize: 11.5,
        width: 'max-content',
        minWidth: '100%',
      }}>
        <thead style={{ position: 'sticky', top: 0, zIndex: 1 }}>
          <tr>
            <th style={{
              ...thStyle, width: 36, textAlign: 'center', color: 'var(--fg-faint)',
              padding: cellPad,
            }}>#</th>
            {result.columns.map((c, i) => {
              const isSort = sort.col === i;
              return (
                <th
                  key={c.name}
                  title={c.type}
                  onClick={() => setSort({ col: i, dir: isSort && sort.dir === 'asc' ? 'desc' : 'asc' })}
                  style={{
                    ...thStyle,
                    cursor: 'pointer',
                    padding: cellPad,
                    minWidth: 140,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                    <span style={{ color: 'var(--fg)' }}>{c.name}</span>
                    <span style={{ flex: 1 }} />
                    {isSort && <span style={{ color: accent }}>
                      {sort.dir === 'asc' ? <Icon.sortAsc /> : <Icon.sortDesc />}
                    </span>}
                  </div>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row, ri) => (
            <tr key={ri} className="row" style={{ }}>
              <td style={{ ...tdStyle, padding: cellPad, color: 'var(--fg-faint)', textAlign: 'center', userSelect: 'none' }}>
                {ri + 1}
              </td>
              {row.map((v, ci) => {
                const col = result.columns[ci];
                const empty = v === null || v === undefined || v === '';
                return (
                  <td key={ci} style={{
                    ...tdStyle,
                    padding: cellPad,
                    textAlign: empty ? 'center' : (typeof v === 'number' ? 'right' : 'left'),
                    color: empty ? 'var(--fg-faint)' : (typeof v === 'number' ? 'var(--num)' : 'var(--fg)'),
                  }}>
                    {empty ? (
                      <span style={{ opacity: .55 }} title="NULL">—</span>
                    ) : ci === 0 && CARRIER_NAMES[v] ? (
                      <span><span style={{ color: 'var(--fg)' }}>{v}</span>
                        <span style={{ color: 'var(--fg-faint)', marginLeft: 6, fontFamily: 'inherit' }}>{CARRIER_NAMES[v]}</span></span>
                    ) : (
                      typeof v === 'number' ? v.toFixed(2) : String(v)
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const thStyle = {
  position: 'sticky', top: 0,
  background: 'var(--bg-th)',
  borderBottom: '1px solid var(--border)',
  borderRight: '1px solid var(--border-faint)',
  textAlign: 'left',
  fontWeight: 500,
  fontSize: 11,
  color: 'var(--fg-mute)',
  whiteSpace: 'nowrap',
  userSelect: 'none',
};
const tdStyle = {
  borderBottom: '1px solid var(--border-faint)',
  borderRight: '1px solid var(--border-faint)',
  whiteSpace: 'nowrap',
};

// ─── CHART HELPERS ────────────────────────────────────────────────────
const CHART_NUM = /^(U?Int|Float|Decimal)/;
const CHART_TIME = /^(Date|DateTime)/;
const CHART_ORDINAL = /^(year|quarter|month|week|day|hour|dayofweek|minute)/i;
const chartStrip = (t) => {
  let p = t;
  let m;
  while ((m = /^(Nullable|LowCardinality)\((.*)\)$/.exec(p))) p = m[2];
  return p;
};
function chartRole(col) {
  const t = chartStrip(col.type);
  if (CHART_TIME.test(t)) return 'time';
  if (CHART_NUM.test(t)) return CHART_ORDINAL.test(col.name) ? 'ordinal' : 'measure';
  return 'category';
}
// Good-enough default — the config bar lets the user override the 10% it
// gets wrong, so this stays a ~10-line heuristic, not a rule engine.
function autoChart(columns) {
  const roles = columns.map((c, i) => ({ i, role: chartRole(c) }));
  const measures = roles.filter((r) => r.role === 'measure').map((r) => r.i);
  const x = (roles.find((r) => r.role === 'time')
    || roles.find((r) => r.role === 'ordinal')
    || roles.find((r) => r.role === 'category')
    || roles[0]);
  if (!measures.length || !x) return null;
  const type = x.role === 'time' ? 'line' : x.role === 'category' ? 'hbar' : 'bar';
  return { type, x: x.i, y: measures, series: null };
}
const CHART_PALETTE = (accent) => [accent, '#22C55E', '#E0B341', '#EC4899', '#14B8A6', '#A78BFA', '#F97316'];

function useSize() {
  const ref = React.useRef(null);
  const [size, setSize] = React.useState({ w: 600, h: 300 });
  React.useEffect(() => {
    if (!ref.current || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((es) => {
      const r = es[0].contentRect;
      setSize({ w: Math.max(120, r.width), h: Math.max(120, r.height) });
    });
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, size];
}

function ChartSelect({ label, value, options, onChange, multi }) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <span style={{ fontSize: 10.5, color: 'var(--fg-faint)', textTransform: 'uppercase', letterSpacing: '.05em' }}>{label}</span>
      <select className="tb-select" value={multi ? undefined : value}
        onChange={(e) => onChange(e.target.value)} style={{ height: 24, maxWidth: 170 }}>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </label>
  );
}

function ResultsChart({ result, sorted, accent }) {
  const cols = result.columns;
  const auto = React.useMemo(() => autoChart(cols), [cols]);
  const [cfg, setCfg] = React.useState(auto);
  // Re-derive defaults when the result schema changes (different query).
  const schemaKey = cols.map((c) => c.name + c.type).join('|');
  React.useEffect(() => { setCfg(autoChart(cols)); }, [schemaKey]);
  const [chartRef, size] = useSize();

  if (!cfg) {
    return (
      <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center',
        flexDirection: 'column', gap: 8, color: 'var(--fg-faint)', fontSize: 12, background: 'var(--bg-table)', textAlign: 'center', padding: 24 }}>
        <Icon.chart style={{ opacity: .5 }} />
        <div>These results aren't chartable.<br />Add a numeric column to plot them.</div>
      </div>
    );
  }

  const set = (patch) => setCfg((c) => ({ ...c, ...patch }));
  const numericIdx = cols.map((c, i) => ({ c, i })).filter(({ c }) => chartRole(c) === 'measure' || chartRole(c) === 'ordinal').map(({ i }) => i);
  const catIdx = cols.map((c, i) => ({ c, i })).filter(({ c }) => chartRole(c) !== 'measure').map(({ i }) => i);
  const colOpts = cols.map((c, i) => ({ value: String(i), label: c.name }));
  const yOpts = numericIdx.map((i) => ({ value: String(i), label: cols[i].name }));
  const seriesOpts = [{ value: '', label: 'None' }, ...catIdx.filter((i) => i !== cfg.x).map((i) => ({ value: String(i), label: cols[i].name }))];

  const types = [
    { value: 'hbar', label: 'Bar' },
    { value: 'bar', label: 'Column' },
    { value: 'line', label: 'Line' },
    { value: 'area', label: 'Area' },
    { value: 'pie', label: 'Pie' },
  ];

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: 'var(--bg-table)', minHeight: 0 }}>
      {/* Config bar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '7px 14px', flexWrap: 'wrap',
        borderBottom: '1px solid var(--border-faint)', flexShrink: 0 }}>
        <ChartSelect label="Type" value={cfg.type} options={types} onChange={(v) => set({ type: v })} />
        <ChartSelect label="X" value={String(cfg.x)} options={colOpts} onChange={(v) => set({ x: +v })} />
        <ChartSelect label="Y" value={String(cfg.y[0])} options={yOpts} onChange={(v) => set({ y: [+v] })} />
        {cfg.type !== 'pie' && yOpts.length > 1 && (
          <button className="tb-btn" onClick={() => set({ y: cfg.y.length === yOpts.length ? [cfg.y[0]] : yOpts.map((o) => +o.value) })}
            title="Toggle plotting all numeric columns as series">
            {cfg.y.length > 1 ? 'Single series' : 'All measures'}
          </button>
        )}
        {cfg.type !== 'pie' && seriesOpts.length > 1 && (
          <ChartSelect label="Series" value={String(cfg.series ?? '')} options={seriesOpts} onChange={(v) => set({ series: v === '' ? null : +v })} />
        )}
      </div>
      {/* Plot */}
      <div ref={chartRef} style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        <ChartCanvas result={result} sorted={sorted} cfg={cfg} accent={accent} w={size.w} h={size.h} />
      </div>
    </div>
  );
}

function ChartCanvas({ result, sorted, cfg, accent, w, h }) {
  const cols = result.columns;
  const palette = CHART_PALETTE(accent);
  const fmtNum = (n) => typeof n !== 'number' ? n : Math.abs(n) >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : Math.abs(n) >= 1e3 ? (n / 1e3).toLocaleString() : (Number.isInteger(n) ? n : n.toFixed(2));
  const xLabel = (v) => {
    const s = String(v);
    return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 7) : (CARRIER_NAMES[v] ? v : s);
  };

  // Build series: either group-by a category column, or one series per Y measure.
  let series; // [{name, color, points:[{x, y}]}]
  const xs = sorted.map((r) => r[cfg.x]);
  if (cfg.series != null) {
    const yi = cfg.y[0];
    const groups = {};
    const order = [];
    sorted.forEach((r) => {
      const k = String(r[cfg.series]);
      if (!(k in groups)) { groups[k] = {}; order.push(k); }
      groups[k][String(r[cfg.x])] = r[yi];
    });
    const xCats = [...new Set(xs.map(String))];
    series = order.map((k, i) => ({ name: k, color: palette[i % palette.length],
      points: xCats.map((xc) => ({ x: xc, y: groups[k][xc] ?? 0 })) }));
  } else {
    series = cfg.y.map((yi, i) => ({ name: cols[yi].name, color: palette[i % palette.length],
      points: sorted.map((r) => ({ x: r[cfg.x], y: r[yi] })) }));
  }

  const PAD = { l: 52, r: 16, t: 16, b: 38 };

  // Horizontal bars — best for ranked categorical data (the original design).
  // Rendered as HTML rows so labels read naturally; supports grouped series.
  if (cfg.type === 'hbar') {
    const hmax = Math.max(0, ...series.flatMap((s) => s.points.map((p) => p.y))) || 1;
    const cats = series[0]?.points.map((p) => p.x) ?? [];
    const single = series.length === 1;
    return (
      <div style={{ height: h, overflow: 'auto', padding: '14px 16px' }}>
        {!single && (
          <div style={{ display: 'flex', gap: 16, marginBottom: 12, paddingLeft: 124 }}>
            {series.map((s, i) => (
              <span key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--fg-mute)', fontFamily: 'var(--mono)' }}>
                <span style={{ width: 9, height: 9, borderRadius: 2, background: s.color }} />{s.name}
              </span>
            ))}
          </div>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: single ? 6 : 10 }}>
          {cats.map((cat, ri) => (
            <div key={ri} style={{ display: 'flex', alignItems: 'center', gap: 12, fontSize: 11.5 }}>
              <div style={{ width: 112, flexShrink: 0, textAlign: 'right', fontFamily: 'var(--mono)', color: 'var(--fg-mute)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                <span style={{ color: 'var(--fg)' }}>{xLabel(cat)}</span>
                {CARRIER_NAMES[cat] && <span style={{ marginLeft: 6, color: 'var(--fg-faint)' }}>{CARRIER_NAMES[cat]}</span>}
              </div>
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                {series.map((s, si) => {
                  const val = s.points[ri]?.y ?? 0;
                  const pct = Math.max(0, (val / hmax) * 100);
                  return (
                    <div key={si} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <div style={{ flex: 1, height: single ? 18 : 11, background: 'var(--bg-chip)', borderRadius: 2, position: 'relative', overflow: 'hidden' }}>
                        <div style={{ position: 'absolute', inset: '0 auto 0 0', width: `${pct}%`,
                          background: single
                            ? `linear-gradient(90deg, ${s.color}, color-mix(in oklab, ${s.color} 65%, transparent))`
                            : s.color,
                          borderRadius: 2, transition: 'width .4s cubic-bezier(.2,.7,.3,1)' }} />
                      </div>
                      <div style={{ width: 64, flexShrink: 0, textAlign: 'right', fontFamily: 'var(--mono)', color: 'var(--num)' }}>{fmtNum(val)}</div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  const iw = Math.max(10, w - PAD.l - PAD.r);
  const ih = Math.max(10, h - PAD.t - PAD.b);
  const allY = series.flatMap((s) => s.points.map((p) => p.y));
  const maxY = Math.max(0, ...allY);
  const minY = Math.min(0, ...allY);
  const yToPx = (v) => PAD.t + ih - ((v - minY) / (maxY - minY || 1)) * ih;
  const cats = series[0]?.points.map((p) => p.x) ?? [];
  const n = cats.length;

  // Y gridlines (4)
  const ticks = 4;
  const gridY = Array.from({ length: ticks + 1 }, (_, i) => minY + (i / ticks) * (maxY - minY));

  const axisColor = 'var(--border)';
  const labelColor = 'var(--fg-faint)';
  const fontMono = 'var(--mono)';

  if (cfg.type === 'pie') {
    const pts = series[0]?.points ?? [];
    const total = pts.reduce((a, p) => a + Math.max(0, p.y), 0) || 1;
    const cx = w / 2, cy = h / 2, rad = Math.max(20, Math.min(w, h) / 2 - 60);
    let a0 = -Math.PI / 2;
    const arcs = pts.map((p, i) => {
      const frac = Math.max(0, p.y) / total;
      const a1 = a0 + frac * Math.PI * 2;
      const large = a1 - a0 > Math.PI ? 1 : 0;
      const x0 = cx + rad * Math.cos(a0), y0 = cy + rad * Math.sin(a0);
      const x1 = cx + rad * Math.cos(a1), y1 = cy + rad * Math.sin(a1);
      const d = `M${cx},${cy} L${x0},${y0} A${rad},${rad} 0 ${large} 1 ${x1},${y1} Z`;
      a0 = a1;
      return { d, color: palette[i % palette.length], label: xLabel(p.x), pct: (frac * 100).toFixed(0) };
    });
    return (
      <svg width={w} height={h} style={{ display: 'block' }}>
        {arcs.map((a, i) => <path key={i} d={a.d} fill={a.color} stroke="var(--bg-table)" strokeWidth="1.5" />)}
        {/* legend */}
        {arcs.map((a, i) => (
          <g key={'l' + i} transform={`translate(${w - 130}, ${PAD.t + i * 18})`}>
            <rect width="9" height="9" rx="2" fill={a.color} />
            <text x="14" y="8.5" fontSize="11" fill="var(--fg-mute)" fontFamily={fontMono}>{a.label} · {a.pct}%</text>
          </g>
        ))}
      </svg>
    );
  }

  return (
    <svg width={w} height={h} style={{ display: 'block' }}>
      {/* gridlines + y labels */}
      {gridY.map((gv, i) => (
        <g key={i}>
          <line x1={PAD.l} y1={yToPx(gv)} x2={w - PAD.r} y2={yToPx(gv)} stroke={axisColor} strokeWidth="1" strokeOpacity={i === 0 ? 1 : 0.5} />
          <text x={PAD.l - 8} y={yToPx(gv) + 3.5} textAnchor="end" fontSize="10" fill={labelColor} fontFamily={fontMono}>{fmtNum(gv)}</text>
        </g>
      ))}
      {/* x labels */}
      {cats.map((c, i) => {
        const step = iw / n;
        const cxp = PAD.l + step * (i + 0.5);
        if (n > 14 && i % Math.ceil(n / 12) !== 0) return null;
        return <text key={i} x={cxp} y={h - PAD.b + 14} textAnchor="middle" fontSize="10" fill={labelColor} fontFamily={fontMono}>{xLabel(c)}</text>;
      })}

      {/* bars */}
      {cfg.type === 'bar' && series.map((s, si) => {
        const step = iw / n;
        const bw = (step * 0.7) / series.length;
        return s.points.map((p, i) => {
          const x = PAD.l + step * (i + 0.5) - (bw * series.length) / 2 + si * bw;
          const y = yToPx(p.y), y0 = yToPx(0);
          return <rect key={si + '-' + i} x={x} y={Math.min(y, y0)} width={Math.max(1, bw - 1)} height={Math.abs(y0 - y)} fill={s.color} rx="1.5">
            <title>{xLabel(p.x)}: {fmtNum(p.y)}</title>
          </rect>;
        });
      })}

      {/* line / area */}
      {(cfg.type === 'line' || cfg.type === 'area') && series.map((s, si) => {
        const step = iw / n;
        const px = (i) => PAD.l + step * (i + 0.5);
        const path = s.points.map((p, i) => `${i === 0 ? 'M' : 'L'}${px(i)},${yToPx(p.y)}`).join(' ');
        const areaPath = `${path} L${px(s.points.length - 1)},${yToPx(0)} L${px(0)},${yToPx(0)} Z`;
        return (
          <g key={si}>
            {cfg.type === 'area' && <path d={areaPath} fill={s.color} fillOpacity="0.14" />}
            <path d={path} fill="none" stroke={s.color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
            {s.points.map((p, i) => <circle key={i} cx={px(i)} cy={yToPx(p.y)} r="2.5" fill={s.color}><title>{xLabel(p.x)}: {fmtNum(p.y)}</title></circle>)}
          </g>
        );
      })}

      {/* legend (multi-series) */}
      {series.length > 1 && series.map((s, i) => (
        <g key={'lg' + i} transform={`translate(${PAD.l + i * 120}, ${PAD.t - 4})`}>
          <rect width="9" height="9" rx="2" fill={s.color} />
          <text x="14" y="8.5" fontSize="10.5" fill="var(--fg-mute)" fontFamily={fontMono}>{s.name}</text>
        </g>
      ))}
    </svg>
  );
}

function ResultsJson({ result, sorted }) {
  const json = sorted.map(row => {
    const obj = {};
    result.columns.forEach((c, i) => obj[c.name] = row[i]);
    return obj;
  });
  return (
    <pre style={{
      margin: 0, height: '100%', overflow: 'auto', padding: '14px 16px',
      fontFamily: 'var(--mono)', fontSize: 11.5, color: 'var(--fg)',
      background: 'var(--bg-table)',
    }}>
      <code>{JSON.stringify(json, null, 2)}</code>
    </pre>
  );
}

// ─── SHORTCUTS DRAWER ─────────────────────────────────────────────────
function ShortcutsModal({ open, onClose }) {
  if (!open) return null;
  const groups = [
    { title: 'Editor', items: [
      ['Run query', '⌘ ↵'],
      ['Save query', '⌘ S'],
      ['Format SQL', '⌘ ⇧ F'],
      ['New tab', '⌘ T'],
      ['Close tab', '⌘ W'],
      ['Comment line', '⌘ /'],
    ]},
    { title: 'Navigation', items: [
      ['Toggle sidebar', '⌘ B'],
      ['Focus editor', '⌘ E'],
      ['Search schema', '⌘ K'],
      ['Show shortcuts', '?'],
    ]},
    { title: 'Results', items: [
      ['Copy as TSV', '⌘ ⇧ C'],
      ['Export CSV', '⌘ ⇧ E'],
      ['Switch to chart', '⌘ 2'],
    ]},
  ];
  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, zIndex: 100,
      background: 'rgba(0,0,0,.5)', backdropFilter: 'blur(4px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        width: 480, background: 'var(--bg-modal)', borderRadius: 10,
        border: '1px solid var(--border)', boxShadow: '0 20px 60px rgba(0,0,0,.4)',
        padding: '18px 22px',
      }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--fg)', marginBottom: 14 }}>
          Keyboard shortcuts
        </div>
        {groups.map(g => (
          <div key={g.title} style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: '.06em', textTransform: 'uppercase',
              color: 'var(--fg-faint)', marginBottom: 6 }}>{g.title}</div>
            {g.items.map(([label, key]) => (
              <div key={label} style={{
                display: 'flex', justifyContent: 'space-between',
                padding: '5px 0', fontSize: 12, color: 'var(--fg-mute)',
              }}>
                <span>{label}</span>
                <kbd style={{
                  fontFamily: 'var(--mono)', fontSize: 10.5,
                  padding: '2px 7px', background: 'var(--bg-chip)', borderRadius: 4,
                  color: 'var(--fg)',
                }}>{key}</kbd>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

Object.assign(window, {
  AppHeader, SchemaTree, SavedHistoryPanel, QueryTabs, EditorToolbar, ResultsPane,
  ShortcutsModal, Icon,
});
