// app.jsx — main app shell

function App() {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);
  const accent = t.accent;
  const dark = t.theme === 'dark';
  const density = t.density;
  const sidebarVisible = t.sidebar;

  // Tabs
  const [tabs, setTabs] = React.useState([
    { id: 't1', name: 'Worst-delay carriers', sql: SAVED_QUERIES[0].sql, dirty: false, savedId: SAVED_QUERIES[0].id },
    { id: 't2', name: 'Untitled query', sql: 'SELECT count() FROM airline.ontime\nWHERE Year = 2023', dirty: true },
  ]);
  const [activeId, setActiveId] = React.useState('t1');
  const active = tabs.find(t => t.id === activeId) || tabs[0];

  const [result, setResult] = React.useState(RESULT_DELAYS);
  const [running, setRunning] = React.useState(false);
  const [shortcutsOpen, setShortcutsOpen] = React.useState(false);
  const [savedQueries, setSavedQueries] = React.useState(SAVED_QUERIES);
  const [saveSignal, setSaveSignal] = React.useState(0);

  const updateTabSql = (sql) => {
    setTabs(ts => ts.map(t => t.id === activeId ? { ...t, sql, dirty: true } : t));
  };
  const newTab = () => {
    const id = 't' + Date.now();
    setTabs(ts => [...ts, { id, name: 'Untitled query', sql: '', dirty: false }]);
    setActiveId(id);
  };
  const closeTab = (id) => {
    setTabs(ts => {
      const i = ts.findIndex(t => t.id === id);
      const next = ts.filter(t => t.id !== id);
      if (id === activeId) setActiveId(next[Math.max(0, i - 1)].id);
      return next;
    });
  };
  const loadQuery = (q) => {
    const id = 't' + Date.now();
    setTabs(ts => [...ts, { id, name: q.name, sql: q.sql, dirty: false, savedId: q.id }]);
    setActiveId(id);
  };
  const insertColumn = (col) => {
    setTabs(ts => ts.map(t => t.id === activeId ? { ...t, sql: t.sql + col, dirty: true } : t));
  };
  const formatCurrent = () => {
    setTabs(ts => ts.map(t => t.id === activeId ? { ...t, sql: formatSql(t.sql), dirty: true } : t));
  };
  const saveCurrentQuery = (name) => {
    const sql = active.sql;
    const existingId = active.savedId && savedQueries.some(q => q.id === active.savedId) ? active.savedId : null;
    const id = existingId || ('s' + Date.now());
    setSavedQueries(qs => existingId
      ? qs.map(q => q.id === id ? { ...q, name, sql } : q)
      : [{ id, name, sql, starred: false }, ...qs]);
    setTabs(ts => ts.map(t => t.id === activeId ? { ...t, name, dirty: false, savedId: id } : t));
  };
  const renameSaved = (id, name) => {
    setSavedQueries(qs => qs.map(q => q.id === id ? { ...q, name } : q));
    setTabs(ts => ts.map(t => t.savedId === id ? { ...t, name } : t));
  };
  const deleteSaved = (id) => {
    setSavedQueries(qs => qs.filter(q => q.id !== id));
    setTabs(ts => ts.map(t => t.savedId === id ? { ...t, savedId: undefined, dirty: true } : t));
  };
  const toggleStar = (id) => {
    setSavedQueries(qs => qs.map(q => q.id === id ? { ...q, starred: !q.starred } : q));
  };
  const importQueries = (incoming) => {
    let added = 0, updated = 0, skipped = 0;
    setSavedQueries(qs => {
      const next = [...qs];
      const byId = new Map(next.map((q, i) => [q.id, i]));
      for (const q of incoming) {
        const existingIdx = q.id != null ? byId.get(q.id) : undefined;
        if (existingIdx == null) {
          // new query — keep its id if free, else mint one
          const id = (q.id != null && !byId.has(q.id)) ? q.id : ('s' + Date.now() + Math.random().toString(36).slice(2, 6));
          const rec = { id, name: q.name, sql: q.sql, starred: !!q.starred };
          byId.set(id, next.length); next.push(rec); added++;
        } else {
          const cur = next[existingIdx];
          if (cur.sql === q.sql && cur.name === q.name) { skipped++; }
          else {
            // collision with differing content → keep both (import gets a new id)
            const id = 's' + Date.now() + Math.random().toString(36).slice(2, 6);
            next.push({ id, name: q.name + ' (imported)', sql: q.sql, starred: !!q.starred });
            added++;
          }
        }
      }
      return next;
    });
    return { added, updated, skipped };
  };
  const [progress, setProgress] = React.useState(null);
  const runTimers = React.useRef([]);
  const clearRunTimers = () => { runTimers.current.forEach(clearTimeout); runTimers.current = []; };

  const runQuery = () => {
    clearRunTimers();
    setRunning(true);
    const final = pickResult(active.sql);
    // Simulate ClickHouse streaming: partial rows arrive while rows/bytes-read
    // counters climb toward an estimated total (X-ClickHouse-Progress). Showing
    // partial data beats a blocking spinner. Replace with real streamed parse.
    const TOTAL = 64_100_000;
    const allRows = final.rows;
    const steps = [0.12, 0.3, 0.52, 0.71, 0.88, 1];
    // Demo timing only — "Slow query" tweak stretches it so streaming is easy
    // to observe. No production meaning.
    const stepMs = t.slowQuery ? 1500 : 280;
    const fmt = (n) => n >= 1e6 ? (n/1e6).toFixed(1)+'M' : n >= 1e3 ? (n/1e3).toFixed(0)+'K' : String(n);
    setResult({ ...final, rows: [], partial: true,
      meta: { rows: 0, ms: 0, scanned: '0 B', scannedRows: '0' } });
    setProgress({ read: 0, total: TOTAL, bytes: '0 B' });
    steps.forEach((frac, i) => {
      runTimers.current.push(setTimeout(() => {
        const nRows = Math.round(allRows.length * frac);
        const read = Math.round(TOTAL * frac);
        const bytes = (frac * 2.41).toFixed(2) + ' GB';
        setProgress({ read, total: TOTAL, bytes });
        setResult({ ...final, rows: allRows.slice(0, nRows), partial: frac < 1,
          meta: { rows: nRows, ms: Math.round(stepMs * (i + 1)), scanned: bytes, scannedRows: fmt(read) } });
      }, stepMs * (i + 1)));
    });
    runTimers.current.push(setTimeout(() => {
      setResult(final);
      setRunning(false);
      setProgress(null);
    }, stepMs * (steps.length + 1)));
  };
  const cancelQuery = () => {
    clearRunTimers();
    setRunning(false);
    setProgress(null);
    // Keep whatever streamed in, but mark it cancelled (partial + a flag the
    // results pane surfaces). Production: also issue KILL QUERY.
    setResult(r => r ? { ...r, partial: false, cancelled: true } : r);
  };

  React.useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault(); runQuery();
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 't') {
        e.preventDefault(); newTab();
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault(); setSaveSignal(s => s + 1);
      }
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'F' || e.key === 'f')) {
        e.preventDefault(); formatCurrent();
      }
      if (e.key === '?' && !['INPUT','TEXTAREA'].includes(e.target.tagName)) {
        setShortcutsOpen(o => !o);
      }
      if (e.key === 'Escape' && running) {
        e.preventDefault(); cancelQuery();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });

  // Editor / results split
  const [editorPct, setEditorPct] = React.useState(45);
  const splitRef = React.useRef(null);
  const onSplitDrag = (e) => {
    e.preventDefault();
    const onMove = (ev) => {
      const r = splitRef.current.getBoundingClientRect();
      const pct = ((ev.clientY - r.top) / r.height) * 100;
      setEditorPct(Math.max(15, Math.min(85, pct)));
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const [sidebarPx, setSidebarPx] = React.useState(248);
  const onSidebarDrag = (e) => {
    e.preventDefault();
    const onMove = (ev) => setSidebarPx(Math.max(180, Math.min(420, ev.clientX)));
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  return (
    <div data-theme={dark ? 'dark' : 'light'} data-density={density} style={{
      '--accent': accent,
      width: '100%',
      height: '100vh',
      display: 'flex',
      flexDirection: 'column',
      background: 'var(--bg)',
      color: 'var(--fg)',
      fontFamily: 'var(--ui)',
      overflow: 'hidden',
    }}>
      <AppHeader accent={accent} onShortcuts={() => setShortcutsOpen(true)} />

      <div style={{ flex: 1, display: 'flex', minHeight: 0, overflow: 'hidden' }}>
        {/* Sidebar */}
        {sidebarVisible && (
          <>
            <div style={{
              width: sidebarPx,
              flexShrink: 0,
              display: 'flex',
              flexDirection: 'column',
              background: 'var(--bg-side)',
              borderRight: '1px solid var(--border)',
              minHeight: 0,
            }}>
              <div style={{ flex: 1.4, overflow: 'hidden', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
                <SchemaTree accent={accent} onInsertColumn={insertColumn} />
              </div>
              <div style={{
                height: 6, background: 'var(--border)', cursor: 'row-resize',
                flexShrink: 0,
              }} />
              <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
                <SavedHistoryPanel accent={accent} onLoadQuery={loadQuery}
                  savedQueries={savedQueries}
                  onRename={renameSaved} onDelete={deleteSaved} onToggleStar={toggleStar}
                  onImport={importQueries} />
              </div>
            </div>
            <div
              onMouseDown={onSidebarDrag}
              style={{ width: 4, cursor: 'col-resize', background: 'transparent', marginLeft: -2, zIndex: 1 }}
            />
          </>
        )}

        {/* Main column */}
        <div ref={splitRef} style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0 }}>
          <QueryTabs
            tabs={tabs}
            activeId={activeId}
            onSelect={setActiveId}
            onClose={closeTab}
            onNew={newTab}
            accent={accent}
          />
          <EditorToolbar
            accent={accent}
            onRun={runQuery}
            running={running}
            onFormat={formatCurrent}
            onShare={() => {}}
            onSave={saveCurrentQuery}
            currentName={active.name}
            isSaved={!!active.savedId && !active.dirty}
            saveSignal={saveSignal}
          />
          <div style={{ height: `${editorPct}%`, minHeight: 0, overflow: 'hidden' }}>
            <SqlEditor
              value={active.sql}
              onChange={updateTabSql}
              accent={accent}
              fontSize={density === 'compact' ? 12.5 : 13}
              density={density}
            />
          </div>
          <div
            onMouseDown={onSplitDrag}
            style={{
              height: 4,
              background: 'var(--border)',
              cursor: 'row-resize',
              flexShrink: 0,
              position: 'relative',
            }}
          >
            <div style={{
              position: 'absolute', top: 1, bottom: 1, left: '50%', transform: 'translateX(-50%)',
              width: 28, background: 'var(--fg-faint)', opacity: .4, borderRadius: 1,
            }} />
          </div>
          <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
            <ResultsPane result={result} accent={accent} density={density}
              running={running} progress={progress} onCancel={cancelQuery} />
          </div>
        </div>
      </div>

      <ShortcutsModal open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />

      <TweaksPanel title="Tweaks">
        <TweakSection label="Theme">
          <TweakRadio label="Mode" value={t.theme}
            options={['dark', 'light']}
            onChange={(v) => setTweak('theme', v)} />
          <TweakColor label="Accent" value={t.accent}
            onChange={(v) => setTweak('accent', v)} />
          <div style={{ display: 'flex', gap: 6, padding: '2px 0' }}>
            {['#FF6B35', '#F0A500', '#FFC700', '#3B82F6', '#10B981', '#EC4899'].map(c => (
              <button
                key={c}
                onClick={() => setTweak('accent', c)}
                style={{
                  flex: 1, height: 22, border: 'none',
                  background: c, borderRadius: 4, cursor: 'pointer',
                  outline: t.accent === c ? '2px solid rgba(0,0,0,.5)' : 'none',
                  outlineOffset: 1,
                }}
                title={c}
              />
            ))}
          </div>
        </TweakSection>
        <TweakSection label="Layout">
          <TweakRadio label="Density" value={t.density}
            options={['compact', 'comfortable']}
            onChange={(v) => setTweak('density', v)} />
          <TweakToggle label="Sidebar" value={t.sidebar}
            onChange={(v) => setTweak('sidebar', v)} />
        </TweakSection>
        <TweakSection label="Demo">
          <TweakToggle label="Slow query (~9s)" value={t.slowQuery}
            onChange={(v) => setTweak('slowQuery', v)} />
        </TweakSection>
      </TweaksPanel>
    </div>
  );
}

Object.assign(window, { App });
