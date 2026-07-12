import { describe, it, expect } from 'vitest';
import { renderMarkdown, renderResolvedPanel, PANEL_TYPES, PANEL_PICKER_OPTIONS } from '../../src/ui/panels.js';
import { renderResults } from '../../src/ui/results.js';
import { parseMarkdown } from '../../src/core/markdown-lite.js';
import { resolvePanel } from '../../src/core/panel-cfg.js';
import { newResult } from '../../src/core/stream.js';
import { makeApp } from '../helpers/fake-app.js';

const md = (text) => renderMarkdown(parseMarkdown(text));

function chartResult() {
  const r = newResult('Table');
  r.columns = [{ name: 'carrier', type: 'String' }, { name: 'flights', type: 'UInt64' }];
  r.rows = [['B6', '10'], ['AA', '20']];
  r.progress = { rows: 2, bytes: 100, elapsed_ns: 5e6 };
  return r;
}
function logsResult() {
  const r = newResult('Table');
  r.columns = [
    { name: 'event_time', type: 'DateTime' },
    { name: 'level', type: 'String' },
    { name: 'message', type: 'String' },
  ];
  r.rows = [['2026-01-01 00:00:00', 'Error', 'boom']];
  r.progress = { rows: 1, bytes: 10, elapsed_ns: 1e6 };
  return r;
}
// A result with a time column by convention but no message-shaped column at
// all — a saved `{type:'logs'}` cannot resolve Message, so resolvePanel falls
// back (#192's rescue scenario).
function noMessageResult() {
  const r = newResult('Table');
  r.columns = [
    { name: 'event_time', type: 'DateTime' },
    { name: 'operation', type: 'String' },
    { name: 'component', type: 'String' },
  ];
  r.rows = [['2026-01-01 00:00:00', 'op', 'comp']];
  r.progress = { rows: 1, bytes: 10, elapsed_ns: 1e6 };
  return r;
}
// Neither Time nor Message resolves by convention — findTimeColumn matches by
// TYPE (not name), so no column here may be DateTime-shaped.
function noTimeNoMessageResult() {
  const r = newResult('Table');
  r.columns = [
    { name: 'ts', type: 'String' },
    { name: 'operation', type: 'String' },
    { name: 'component', type: 'String' },
  ];
  r.rows = [['2026-01-01 00:00:00', 'op', 'comp']];
  r.progress = { rows: 1, bytes: 10, elapsed_ns: 1e6 };
  return r;
}
const selectRole = (app, index, value) => {
  const sel = [...region(app).querySelectorAll('.panel-config .chart-config select')][index];
  sel.value = value;
  sel.dispatchEvent(new Event('change', { bubbles: true }));
};

function panelApp(result, panelCfg = null, over = {}) {
  const app = makeApp();
  app.activeTab().result = result;
  app.activeTab().panelCfg = panelCfg;
  app.state.resultView.value = 'panel';
  for (const [k, v] of Object.entries(over)) {
    const cur = app.state[k];
    if (cur && typeof cur === 'object' && 'value' in cur) cur.value = v;
    else app.state[k] = v;
  }
  return app;
}
const region = (app) => app.dom.resultsRegion;
const pickType = (app, type) => {
  const sel = region(app).querySelector('.result-panel-select');
  sel.value = type;
  sel.dispatchEvent(new Event('change', { bubbles: true }));
};

// ── renderMarkdown (AST → DOM, injection-inert by construction) ──────────────
describe('renderMarkdown', () => {
  it('renders every block/inline construct as real elements', () => {
    const el = md('# T\n\npara **b** *i* `c`\n\n- item\n\n1. one\n\n[d](https://x.example/)');
    expect(el.querySelector('h1').textContent).toBe('T');
    expect(el.querySelector('p strong').textContent).toBe('b');
    expect(el.querySelector('p em').textContent).toBe('i');
    expect(el.querySelector('p code').textContent).toBe('c');
    expect(el.querySelector('ul li').textContent).toBe('item');
    expect(el.querySelector('ol li').textContent).toBe('one');
    const a = el.querySelector('a');
    expect(a.getAttribute('href')).toBe('https://x.example/');
    expect(a.getAttribute('target')).toBe('_blank');
    expect(a.getAttribute('rel')).toBe('noopener noreferrer');
  });
  it('raw HTML and unsafe links stay inert (text nodes, no elements)', () => {
    const el = md('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[x](javascript:alert1)');
    expect(el.querySelector('script')).toBeNull();
    expect(el.querySelector('img')).toBeNull();
    expect(el.querySelector('a')).toBeNull();
    expect(el.textContent).toContain('<script>alert(1)</script>'); // literal text
  });
});

// ── the Panel drawer tab (through renderResults) ─────────────────────────────
describe('Panel drawer tab', () => {
  it('renders the panel picker in the toolbar without Table + an auto chart preview', () => {
    const app = panelApp(chartResult());
    renderResults(app);
    const sel = region(app).querySelector('.result-panel-select');
    expect([...sel.options].map((o) => o.value)).toEqual(['', ...PANEL_PICKER_OPTIONS.map((o) => o.value)]);
    expect([...sel.options].map((o) => o.value)).not.toContain('table');
    expect(sel.value).toBe('hbar'); // autoPanel's pick for a categorical result
    expect(region(app).querySelectorAll('.result-view-tab')).toHaveLength(2); // Table + JSON; no fixed Panel button
    expect(region(app).querySelector('.panel-config')).toBeNull(); // no separate picker row
    expect(region(app).querySelector('.chart-view canvas')).not.toBeNull();
    expect(app.activeTab().panelCfg).toBeNull(); // #166 dirty pin: derived cfg never persisted
    expect(app.activeTab().dirty).toBe(false);
  });
  it('picking a type writes tab.panelCfg + marks the tab dirty (like a SQL edit); no SQL runs', () => {
    const app = panelApp(chartResult());
    renderResults(app);
    pickType(app, 'pie');
    expect(app.activeTab().panelCfg).toMatchObject({ type: 'pie' });
    expect(app.activeTab().dirty).toBe(true);
    expect(app.actions.rerenderTabs).toHaveBeenCalled();
    expect(app.updateSaveBtn).toHaveBeenCalled();
    expect(app.actions.run).not.toHaveBeenCalled(); // previews never execute SQL
    expect(region(app).querySelector('.chart-view')).not.toBeNull();
  });
  it('the toolbar selector activates Panel view from the ordinary Table view', () => {
    const app = panelApp(chartResult());
    app.state.resultView.value = 'table';
    renderResults(app);
    pickType(app, 'pie');
    expect(app.state.resultView.value).toBe('panel');
    expect(app.activeTab().panelCfg).toMatchObject({ type: 'pie', x: 0, y: [1] });
    expect(region(app).querySelector('.chart-view canvas')).not.toBeNull();
  });
  it("the chart arm's field controls (X/Y) write back through onCfgChange + dirty; no Type select duplicate", () => {
    const app = panelApp(chartResult(), { type: 'bar', x: 0, y: [1], series: null });
    app.activeTab().panelKey = 'carrier:String|flights:UInt64';
    renderResults(app);
    const labels = [...region(app).querySelectorAll('.chart-field-label')].map((s) => s.textContent);
    expect(labels).not.toContain('Type'); // the panel picker owns type (typeControl:false)
    const xSel = [...region(app).querySelectorAll('.chart-field')]
      .find((f) => f.querySelector('.chart-field-label').textContent === 'X').querySelector('select');
    xSel.value = '1';
    xSel.dispatchEvent(new Event('change', { bubbles: true }));
    expect(app.activeTab().panelCfg.x).toBe(1);
    expect(app.activeTab().panelKey).toBe('carrier:String|flights:UInt64');
    expect(app.activeTab().dirty).toBe(true);
  });
  it('adopting an auto-derived chart records the current schema key', () => {
    const app = panelApp(chartResult());
    renderResults(app);
    pickType(app, 'hbar');
    expect(app.activeTab().panelKey).toBe('carrier:String|flights:UInt64');
  });
  it('logs: role selects override by name; a bad shape shows the pick-columns hint', () => {
    const app = panelApp(logsResult(), { type: 'logs' });
    renderResults(app);
    expect(region(app).querySelectorAll('.dash-logs .log-row')).toHaveLength(1);
    const roleSels = [...region(app).querySelectorAll('.panel-config .chart-config select')];
    expect(roleSels).toHaveLength(3); // Time / Message / Level
    roleSels[1].value = 'level'; // point Message at the level column (silly but explicit)
    roleSels[1].dispatchEvent(new Event('change', { bubbles: true }));
    expect(app.activeTab().panelCfg.msg).toBe('level');
    // a logs panel over a result with no time column → hint, not a crash
    const bad = panelApp(chartResult(), { type: 'logs' });
    renderResults(bad);
    expect(region(bad).textContent).toContain('no time + message columns'); // impossible → fallback diagnostic
  });
  it('rescue (#192): a saved Logs panel that falls back still shows Logs controls, and Message repair resolves it', () => {
    const app = panelApp(noMessageResult(), { type: 'logs' });
    renderResults(app);
    // Fallback diagnostic + fallback Table preview are both visible...
    expect(region(app).textContent).toContain('no time + message columns');
    expect(region(app).querySelector('.res-table')).not.toBeNull();
    // ...alongside the three Logs role selectors (the rescue path), fed the
    // saved cfg — not the fallback (Table) cfg.
    const roleSels = [...region(app).querySelectorAll('.panel-config .chart-config select')];
    expect(roleSels).toHaveLength(3);

    selectRole(app, 1, 'component'); // Message → component
    expect(app.activeTab().panelCfg).toEqual({ type: 'logs', msg: 'component' });
    expect(app.activeTab().dirty).toBe(true);
    expect(app.actions.run).not.toHaveBeenCalled();
    // The repair resolves the shape: Logs renders, the fallback note is gone.
    expect(region(app).querySelector('.panel-note.is-fallback')).toBeNull();
    expect(region(app).querySelector('.dash-logs .log-row')).not.toBeNull();
    expect(region(app).querySelector('.res-table')).toBeNull();
  });
  it('rescue (#192): two-step repair keeps controls visible until both roles resolve', () => {
    const app = panelApp(noTimeNoMessageResult(), { type: 'logs' });
    renderResults(app);
    expect([...region(app).querySelectorAll('.panel-config .chart-config select')]).toHaveLength(3);

    selectRole(app, 0, 'ts'); // Time → ts (Message still unresolved)
    expect(app.activeTab().panelCfg).toEqual({ type: 'logs', time: 'ts' });
    expect(region(app).querySelector('.panel-note.is-fallback')).not.toBeNull(); // still falling back
    expect([...region(app).querySelectorAll('.panel-config .chart-config select')]).toHaveLength(3); // still visible

    selectRole(app, 1, 'component'); // Message → component completes the shape
    expect(app.activeTab().panelCfg).toEqual({ type: 'logs', time: 'ts', msg: 'component' });
    expect(app.actions.run).not.toHaveBeenCalled();
    expect(region(app).querySelector('.panel-note.is-fallback')).toBeNull();
    expect(region(app).querySelector('.dash-logs .log-row')).not.toBeNull();
  });
  it('rescue (#192) does not engage for a table panel type: no false controls leak in', () => {
    const app = panelApp(noMessageResult(), { type: 'table' });
    renderResults(app);
    // Not a saved Logs panel → no rescue; Table has no controls at all.
    expect(region(app).querySelector('.panel-config')).toBeNull();
  });
  it('an unknown saved panel type still falls back safely, without a rescue path', () => {
    const app = panelApp(noMessageResult(), { type: 'gauge' });
    expect(() => renderResults(app)).not.toThrow();
    expect(region(app).textContent).toContain('Unknown panel type');
    expect(region(app).querySelector('.panel-config')).toBeNull();
  });
  it('text: renders from cfg.content with NO result; textarea edits update cfg + preview', () => {
    const app = panelApp(null, { type: 'text', content: '# Hello' });
    renderResults(app);
    expect(region(app).querySelector('.md-view h1').textContent).toBe('Hello');
    const ta = region(app).querySelector('.panel-text-input');
    ta.value = '# Bye';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    expect(app.activeTab().panelCfg.content).toBe('# Bye');
    expect(region(app).querySelector('.md-view h1').textContent).toBe('Bye');
    expect(app.activeTab().dirty).toBe(true);
  });
  it('query-backed types show the empty-preview hint before any Run (and while running)', () => {
    const app = panelApp(null);
    renderResults(app);
    expect(region(app).textContent).toContain('Run the query');
    const running = panelApp(chartResult(), { type: 'bar', x: 0, y: [1], series: null }, { running: true });
    renderResults(running);
    // streamed rows exist but the run is live → the panel hint, not a half chart
    expect(region(running).textContent).toContain('renders when the query completes');
  });
  it('an explicit table panel uses the ordinary Table workbench view', () => {
    const r = chartResult();
    r.rows = [];
    const app = panelApp(r, { type: 'table' });
    renderResults(app);
    expect(app.state.resultView.value).toBe('table');
    expect(region(app).querySelector('.result-view-tab.active').textContent).toBe('Table');
    expect(region(app).textContent).toContain('Query returned 0 rows');
  });
  it('a migrated table panel uses the ordinary table sort state', () => {
    const app = panelApp(chartResult(), { type: 'table' });
    renderResults(app);
    const th = region(app).querySelectorAll('.res-table th')[1]; // first data column
    th.dispatchEvent(new Event('click', { bubbles: true }));
    const firstCell = region(app).querySelector('.res-table tbody tr .cell');
    expect(firstCell.textContent).toBe('AA'); // sorted asc by carrier
    expect(app.state.resultSort).toEqual({ col: 0, dir: 'asc' });
  });
});

// ── renderResolvedPanel notes + fallback ─────────────────────────────────────
describe('renderResolvedPanel', () => {
  it('wraps a fallback resolution with its diagnostic note', () => {
    const app = makeApp();
    const r = chartResult();
    const resolved = resolvePanel({ cfg: { type: 'gauge' } }, r.columns); // unknown type
    const { node } = renderResolvedPanel(app, resolved, r, {
      surface: 'workbench', state: {}, rerender: () => {}, readonly: true, onCell: () => {},
    });
    expect(node.querySelector('.panel-note.is-fallback').textContent).toContain('gauge');
    expect(node.querySelector('canvas')).not.toBeNull(); // autoPanel fallback rendered below
  });
  it('a rederived resolution gets the roles-re-detected hint (no fallback style)', () => {
    const app = makeApp();
    const r = logsResult();
    const resolved = resolvePanel({ cfg: { type: 'logs', msg: 'renamed_away' } }, r.columns);
    const { node } = renderResolvedPanel(app, resolved, r, {
      surface: 'workbench', state: {}, rerender: () => {}, readonly: true, onCell: () => {},
    });
    const note = node.querySelector('.panel-note');
    expect(note.textContent).toContain('re-detected');
    expect(note.classList.contains('is-fallback')).toBe(false);
    expect(node.querySelector('.dash-logs')).not.toBeNull();
  });
  it('the logs arm renders the pick-columns hint when even re-derive found no shape', () => {
    const app = makeApp();
    const r = chartResult();
    const out = PANEL_TYPES.logs.renderPanel({ app, result: r, cfg: { type: 'logs' }, cap: 10 });
    expect(out.node.textContent).toContain('No time + message columns');
  });
  it("the chart arm's destroy tears down its instance exactly once", () => {
    const app = makeApp();
    const r = chartResult();
    let inst = null;
    const out = PANEL_TYPES.bar.renderPanel({
      app, result: r, cfg: { type: 'bar', x: 0, y: [1], series: null },
      surface: 'dashboard', rerender: () => {}, readonly: true, setChart: (c) => { inst = c; },
    });
    expect(inst).not.toBeNull();
    expect(inst.destroyed).toBe(false);
    out.destroy();
    expect(inst.destroyed).toBe(true);
    expect(() => out.destroy()).not.toThrow(); // idempotent
  });
});
