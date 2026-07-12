import { describe, it, expect, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import {
  isDashboardRoute, configBase, dashboardTileSql, parseJsonResult, classifyTile,
  normalizeDashLayout, normalizeDashCols,
} from '../../src/core/dashboard.js';
import {
  AUTH_SS_KEYS, AUTH_REQUEST, AUTH_GRANT,
  snapshotAuth, restoreAuth, hasAuth, isAuthRequest, isAuthGrant,
} from '../../src/core/auth-handoff.js';
import { renderDashboard } from '../../src/ui/dashboard.js';
import { emptyRecentMap, recordRecent } from '../../src/core/recent-values.js';
import { makeApp, FakeChart } from '../helpers/fake-app.js';
import { createApp } from '../../src/ui/app.js';
import { createCodeMirrorEditor } from '../../src/editor/codemirror-adapter.js';

// ── core/dashboard.js ───────────────────────────────────────────────────────
describe('isDashboardRoute', () => {
  it('matches the dashboard path (with or without a trailing slash), nothing else', () => {
    expect(isDashboardRoute('/sql/dashboard')).toBe(true);
    expect(isDashboardRoute('/sql/dashboard/')).toBe(true);
    expect(isDashboardRoute('/tools/sql/dashboard')).toBe(true); // mount-agnostic (matches configBase)
    expect(isDashboardRoute('/sql')).toBe(false);
    expect(isDashboardRoute('/sql/config.json')).toBe(false);
    expect(isDashboardRoute(undefined)).toBe(false);
  });
});

describe('configBase', () => {
  it('strips a trailing /dashboard so config resolves from the SPA base', () => {
    expect(configBase('/sql/dashboard')).toBe('/sql');
    expect(configBase('/sql/dashboard/')).toBe('/sql');
    expect(configBase('/sql')).toBe('/sql');
    expect(configBase(undefined)).toBe('');
  });
});

describe('dashboardTileSql', () => {
  it('strips a trailing ; and appends FORMAT JSON', () => {
    expect(dashboardTileSql('SELECT 1;')).toBe('SELECT 1\nFORMAT JSON');
    expect(dashboardTileSql('SELECT 1')).toBe('SELECT 1\nFORMAT JSON');
  });
  it('leaves an explicit FORMAT clause intact (no double FORMAT)', () => {
    expect(dashboardTileSql('SELECT 1 FORMAT CSV')).toBe('SELECT 1 FORMAT CSV');
    expect(dashboardTileSql('SELECT 1 FORMAT JSON;')).toBe('SELECT 1 FORMAT JSON');
    // FORMAT followed by SETTINGS (either-order clause) must still count as trailing.
    expect(dashboardTileSql('SELECT 1 FORMAT JSON SETTINGS max_threads=1'))
      .toBe('SELECT 1 FORMAT JSON SETTINGS max_threads=1');
  });
  it('peels a trailing comment so an existing FORMAT is not doubled', () => {
    expect(dashboardTileSql('SELECT 1 FORMAT JSON -- daily')).toBe('SELECT 1 FORMAT JSON');
    expect(dashboardTileSql('SELECT 1 /* note */')).toBe('SELECT 1\nFORMAT JSON');
  });
  it('is defensive about empty/absent SQL (empty in → empty out)', () => {
    expect(dashboardTileSql('')).toBe('');
    expect(dashboardTileSql(undefined)).toBe('');
  });
});

describe('parseJsonResult', () => {
  it('transforms a full FORMAT JSON response into columns + array rows + meta', () => {
    const out = parseJsonResult({
      meta: [{ name: 'k', type: 'String' }, { name: 'v', type: 'UInt64' }],
      data: [{ k: 'a', v: 1 }, { k: 'b', v: 2 }],
      rows: 2,
      statistics: { elapsed: 0.012, bytes_read: 2048 },
    });
    expect(out.columns.map((c) => c.name)).toEqual(['k', 'v']);
    expect(out.rows).toEqual([['a', 1], ['b', 2]]);
    expect(out.meta).toEqual({ rows: 2, ms: 12, bytes: 2048 });
  });
  it('is defensive about a bare response (no meta/data/statistics/rows)', () => {
    const out = parseJsonResult({});
    expect(out.columns).toEqual([]);
    expect(out.rows).toEqual([]);
    expect(out.meta).toEqual({ rows: 0, ms: null, bytes: null });
  });
});

describe('classifyTile', () => {
  const cols = [{ name: 'k', type: 'String' }, { name: 'v', type: 'UInt64' }];
  it('skips an empty result', () => {
    expect(classifyTile(cols, [], undefined)).toEqual({ kind: 'skip', reason: 'empty' });
  });
  it('skips a single-row result (a KPI — rendered in D2)', () => {
    expect(classifyTile(cols, [['a', 1]], undefined)).toEqual({ kind: 'skip', reason: 'kpi' });
  });
  it('skips a multi-row result with nothing chartable', () => {
    const strCols = [{ name: 'a', type: 'String' }, { name: 'b', type: 'String' }];
    expect(classifyTile(strCols, [['x', 'y'], ['z', 'w']], undefined)).toEqual({ kind: 'skip', reason: 'nonChartable' });
  });
  it('charts a multi-row result via autoChart when there is no saved config', () => {
    const out = classifyTile(cols, [['a', 1], ['b', 2]], undefined);
    expect(out.kind).toBe('chart');
    expect(out.cfg).toMatchObject({ type: 'hbar', x: 0, y: [1] });
  });
  it('honours a valid saved chart config (cloned, not aliased)', () => {
    const saved = { cfg: { type: 'line', x: 0, y: [1], series: null } };
    const out = classifyTile(cols, [['a', 1], ['b', 2]], saved);
    expect(out.kind).toBe('chart');
    expect(out.cfg).toEqual({ type: 'line', x: 0, y: [1], series: null });
    expect(out.cfg).not.toBe(saved.cfg);
  });
  it('falls back to autoChart when the saved config does not fit the columns', () => {
    const saved = { cfg: { type: 'bar', x: 99, y: [1], series: null } };
    const out = classifyTile(cols, [['a', 1], ['b', 2]], saved);
    expect(out.kind).toBe('chart');
    expect(out.cfg.x).toBe(0); // re-derived a safe default
  });
});

describe('normalizeDashLayout', () => {
  it('passes through known modes, defaults everything else to arrange', () => {
    expect(normalizeDashLayout('arrange')).toBe('arrange');
    expect(normalizeDashLayout('report')).toBe('report');
    expect(normalizeDashLayout('grid')).toBe('arrange');
    expect(normalizeDashLayout(undefined)).toBe('arrange');
  });
});

describe('normalizeDashCols', () => {
  it('passes through 2/3, defaults everything else to 3', () => {
    expect(normalizeDashCols(2)).toBe(2);
    expect(normalizeDashCols(3)).toBe(3);
    expect(normalizeDashCols(4)).toBe(3);
    expect(normalizeDashCols(NaN)).toBe(3);
  });
});

// (dashboardParams moved into the parameter pipeline in #165 — the filter bar's
// field discovery is now `fieldControls(analysis)`, tested with the pipeline in
// param-pipeline.test.js and end-to-end in the filter-bar suite below.)

// ── core/auth-handoff.js ─────────────────────────────────────────────────────
function memSession(initial = {}) {
  const m = new Map(Object.entries(initial));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), _map: m };
}

describe('auth-handoff snapshot/restore', () => {
  it('snapshots only the present auth keys', () => {
    const ss = memSession({ oauth_id_token: 't', oauth_idp: 'g', unrelated: 'x' });
    expect(snapshotAuth(ss)).toEqual({ oauth_id_token: 't', oauth_idp: 'g' });
  });
  it('restores present keys and ignores absent ones (and a null snapshot)', () => {
    const ss = memSession();
    restoreAuth(ss, { oauth_id_token: 't', ch_basic_auth: 'b' });
    expect(ss.getItem('oauth_id_token')).toBe('t');
    expect(ss.getItem('ch_basic_auth')).toBe('b');
    expect(ss.getItem('oauth_idp')).toBeNull();
    expect(() => restoreAuth(ss, null)).not.toThrow();
  });
  it('AUTH_SS_KEYS covers both OAuth and basic sessions', () => {
    expect(AUTH_SS_KEYS).toContain('oauth_id_token');
    expect(AUTH_SS_KEYS).toContain('ch_basic_auth');
  });
  it('hasAuth is true only with a token or basic creds', () => {
    expect(hasAuth({ oauth_id_token: 't' })).toBe(true);
    expect(hasAuth({ ch_basic_auth: 'b' })).toBe(true);
    expect(hasAuth({})).toBe(false);
    expect(hasAuth(null)).toBe(false);
  });
});

describe('auth-handoff message predicates', () => {
  const src = {};
  const ok = (type) => ({ origin: 'https://o', source: src, data: { type } });
  it('isAuthRequest accepts a matching request only', () => {
    expect(isAuthRequest(ok(AUTH_REQUEST), 'https://o', src)).toBe(true);
    expect(isAuthRequest(null, 'https://o', src)).toBe(false);
    expect(isAuthRequest({ ...ok(AUTH_REQUEST), origin: 'https://evil' }, 'https://o', src)).toBe(false);
    expect(isAuthRequest({ ...ok(AUTH_REQUEST), source: {} }, 'https://o', src)).toBe(false);
    expect(isAuthRequest({ origin: 'https://o', source: src }, 'https://o', src)).toBe(false); // no data
    expect(isAuthRequest(ok('other'), 'https://o', src)).toBe(false);
  });
  it('isAuthGrant accepts a matching grant only', () => {
    expect(isAuthGrant(ok(AUTH_GRANT), 'https://o', src)).toBe(true);
    expect(isAuthGrant(null, 'https://o', src)).toBe(false);
    expect(isAuthGrant({ ...ok(AUTH_GRANT), origin: 'https://evil' }, 'https://o', src)).toBe(false);
    expect(isAuthGrant({ ...ok(AUTH_GRANT), source: {} }, 'https://o', src)).toBe(false);
    expect(isAuthGrant({ origin: 'https://o', source: src }, 'https://o', src)).toBe(false);
    expect(isAuthGrant(ok('other'), 'https://o', src)).toBe(false);
  });
});

// ── ui/dashboard.js ──────────────────────────────────────────────────────────
const chartResult = (meta = { rows: 2, ms: 5, bytes: 100 }) => ({
  columns: [{ name: 'k', type: 'String' }, { name: 'v', type: 'UInt64' }],
  rows: [['a', 1], ['b', 2]], meta,
});
const kpiResult = () => ({ columns: [{ name: 'value', type: 'UInt64' }], rows: [[42]], meta: { rows: 1, ms: 1, bytes: 10 } });

function dashApp(favorites, runTile) {
  const app = makeApp({ runTile });
  app.state.savedQueries = favorites;
  return app;
}

describe('renderDashboard', () => {
  it('renders a header + a chart tile per chartable favorite', async () => {
    const favorites = [
      { id: '1', name: 'Chart A', sql: 'chartA', favorite: true },
      { id: '2', name: 'Chart B', sql: 'chartB', favorite: true },
    ];
    const app = dashApp(favorites, vi.fn(async () => chartResult()));
    await renderDashboard(app);
    expect(app.root.querySelector('.dash-header')).not.toBeNull();
    expect(app.root.querySelector('.dash-back')).not.toBeNull();
    expect(app.root.querySelector('.dash-fav').textContent).toContain('2 favorites');
    expect(app.root.querySelectorAll('.dash-tile').length).toBe(2);
    expect(app.root.querySelector('.dash-tile canvas')).not.toBeNull();
    expect(app.root.querySelector('.dash-tile-foot').textContent).toContain('rows');
  });

  it('renders the saved description as a tile subtitle when present, omits it otherwise', async () => {
    const favorites = [
      { id: '1', name: 'With desc', sql: 'a', favorite: true, description: 'Daily totals by category' },
      { id: '2', name: 'No desc', sql: 'b', favorite: true },
    ];
    const app = dashApp(favorites, vi.fn(async () => chartResult()));
    await renderDashboard(app);
    const descs = [...app.root.querySelectorAll('.dash-tile-desc')];
    expect(descs).toHaveLength(1);
    expect(descs[0].textContent).toBe('Daily totals by category');
    expect(descs[0].getAttribute('title')).toBe('Daily totals by category');
  });

  it('uses the singular chip label with exactly one favorite', async () => {
    const app = dashApp([{ id: '1', name: 'Q', sql: 'q', favorite: true }], vi.fn(async () => chartResult()));
    await renderDashboard(app);
    expect(app.root.querySelector('.dash-fav').textContent).toContain('1 favorite');
  });

  it('skips single-row (KPI) favorites and notes how many are not shown', async () => {
    const favorites = [
      { id: '1', name: 'Chart', sql: 'chart', favorite: true },
      { id: '2', name: 'Kpi', sql: 'kpi', favorite: true },
    ];
    const runTile = vi.fn(async (sql) => (sql === 'kpi' ? kpiResult() : chartResult()));
    const app = dashApp(favorites, runTile);
    await renderDashboard(app);
    // Stable per-favorite slots (#149 D3): a skipped tile's card stays in the
    // DOM (its identity is preserved for a later filter re-run) but hidden.
    const tiles = [...app.root.querySelectorAll('.dash-tile')];
    expect(tiles.length).toBe(2);
    expect(tiles.filter((t) => t.style.display !== 'none')).toHaveLength(1);
    const note = app.root.querySelector('.dash-skip');
    expect(note.style.display).toBe('');
    expect(note.textContent).toBe('1 not shown');
  });

  it('shows a per-tile error when the query fails', async () => {
    const app = dashApp([{ id: '1', name: 'Bad', sql: 'boom', favorite: true }], vi.fn(async () => ({ error: 'Cannot execute' })));
    await renderDashboard(app);
    expect(app.root.querySelector('.dash-tile-error').textContent).toBe('Cannot execute');
    expect(app.root.querySelector('.dash-skip').style.display).toBe('none'); // an error is not a skip
  });

  it('omits ms/bytes from the footer when CH did not report them', async () => {
    const app = dashApp([{ id: '1', name: 'Q', sql: 'q', favorite: true }],
      vi.fn(async () => chartResult({ rows: 2, ms: null, bytes: null })));
    await renderDashboard(app);
    expect(app.root.querySelector('.dash-tile-foot').children.length).toBe(1);
  });

  it('has a theme toggle wired to app.toggleTheme', async () => {
    const toggleTheme = vi.fn();
    const app = makeApp({ runTile: vi.fn(async () => chartResult()), toggleTheme });
    app.state.theme = 'dark'; // exercise the dark-theme icon branch
    app.state.savedQueries = [{ id: '1', name: 'Q', sql: 'q', favorite: true }];
    await renderDashboard(app);
    const btn = app.root.querySelector('.dash-icobtn');
    expect(btn).toBeTruthy();
    btn.dispatchEvent(new Event('click', { bubbles: true }));
    expect(toggleTheme).toHaveBeenCalled();
  });

  it('redirects to login once (no tiles) when the session cannot be refreshed', async () => {
    const onSignedOut = vi.fn();
    const app = makeApp({
      runTile: vi.fn(async () => chartResult()),
      ensureFreshToken: vi.fn(async () => false),
      chCtx: { onSignedOut },
    });
    app.state.savedQueries = [
      { id: '1', name: 'Q', sql: 'q', favorite: true },
      { id: '2', name: 'R', sql: 'r', favorite: true },
    ];
    await renderDashboard(app);
    expect(onSignedOut).toHaveBeenCalledTimes(1); // one redirect, not one per tile
    expect(app.runTile).not.toHaveBeenCalled();
    expect(app.root.querySelectorAll('.dash-tile').length).toBe(0);
  });

  it('tears down the previous tiles Chart.js instances on Refresh (no leak)', async () => {
    const charts = [];
    const app = dashApp([{ id: '1', name: 'Q', sql: 'q', favorite: true }], vi.fn(async () => chartResult()));
    const Base = app.Chart;
    app.Chart = class extends Base { constructor(...a) { super(...a); charts.push(this); } };
    await renderDashboard(app);
    expect(charts).toHaveLength(1);
    await app.root.querySelector('.dash-btn').onclick();
    expect(charts).toHaveLength(2);
    expect(charts[0].destroyed).toBe(true); // prior instance destroyed, not orphaned
  });

  it('a tile that flips chart -> skip on Refresh clears its old chart DOM (no dead canvas lingers)', async () => {
    const runTile = vi.fn(async () => chartResult());
    const app = dashApp([{ id: '1', name: 'Q', sql: 'q', favorite: true }], runTile);
    await renderDashboard(app);
    expect(app.root.querySelector('.dash-tile canvas')).not.toBeNull();
    runTile.mockImplementation(async () => kpiResult()); // next refresh becomes a skip (KPI)
    await app.root.querySelector('.dash-btn').onclick();
    expect(app.root.querySelector('.dash-tile').style.display).toBe('none');
    expect(app.root.querySelector('.dash-tile canvas')).toBeNull(); // stale chart DOM cleared, not just hidden
  });

  it('Refresh marks every tile loading immediately (no stale content lingers beyond the concurrency window)', async () => {
    const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
    const favorites = Array.from({ length: 8 }, (_, i) => ({ id: String(i), name: 'Q' + i, sql: 'q' + i, favorite: true }));
    const runTile = vi.fn(async () => chartResult());
    const app = dashApp(favorites, runTile);
    await renderDashboard(app);
    expect(app.root.querySelectorAll('.dash-tile canvas').length).toBe(8);

    const resolvers = [];
    runTile.mockImplementation(() => new Promise((resolve) => resolvers.push(resolve)));
    const refreshed = app.root.querySelector('.dash-btn').onclick();
    await flush();
    // All 8 tiles show "Loading…" up front, even though TILE_CONCURRENCY (6)
    // means only 6 queries are actually in flight — none show the prior chart.
    expect(app.root.querySelectorAll('.dash-tile-load').length).toBe(8);
    expect(app.root.querySelectorAll('.dash-tile canvas').length).toBe(0);
    // TILE_CONCURRENCY (6) means only 6 of the 8 queries are in flight yet;
    // resolving them frees pool slots for the remaining 2 — drain in rounds.
    for (let round = 0; round < 4; round++) {
      resolvers.splice(0).forEach((r) => r(chartResult()));
      await flush();
    }
    await refreshed;
    expect(app.root.querySelectorAll('.dash-tile canvas').length).toBe(8);
  });

  it('shows an empty state when there are no favorites', async () => {
    const app = dashApp([], vi.fn());
    await renderDashboard(app);
    expect(app.root.querySelector('.dash-empty').style.display).toBe('');
    expect(app.root.querySelectorAll('.dash-tile').length).toBe(0);
  });

  it('Refresh re-runs every tile', async () => {
    const runTile = vi.fn(async () => chartResult());
    const app = dashApp([{ id: '1', name: 'Q', sql: 'q', favorite: true }], runTile);
    await renderDashboard(app);
    expect(runTile).toHaveBeenCalledTimes(1);
    await app.root.querySelector('.dash-btn').onclick();
    expect(runTile).toHaveBeenCalledTimes(2);
  });

  it('renders read-only tiles with no interactive chart-config bar (D1)', async () => {
    const app = dashApp([{ id: '1', name: 'Q', sql: 'q', favorite: true }], vi.fn(async () => chartResult()));
    await renderDashboard(app);
    expect(app.root.querySelector('.dash-tile canvas')).not.toBeNull();
    expect(app.root.querySelector('.dash-tile .chart-config')).toBeNull(); // controls omitted, not hidden
    expect(app.root.querySelector('.dash-tile .chart-select')).toBeNull();
  });

  // ── D2: layout toolbar (Arrange/Report + column count) ──────────────────────
  const oneFav = () => dashApp([{ id: '1', name: 'Q', sql: 'q', favorite: true }], vi.fn(async () => chartResult()));
  const seg = (root, cls, label) =>
    [...root.querySelectorAll('.' + cls + ' .dash-seg-btn')].find((b) => b.textContent === label);

  it('defaults to Arrange (3 columns), grid not in report mode, column control shown', async () => {
    const app = oneFav();
    await renderDashboard(app);
    const grid = app.root.querySelector('.dash-grid');
    expect(grid.classList.contains('is-report')).toBe(false);
    expect(grid.style.getPropertyValue('--dash-cols')).toBe('3');
    expect(seg(app.root, 'dash-seg-layout', 'Arrange').classList.contains('is-active')).toBe(true);
    expect(seg(app.root, 'dash-seg-layout', 'Report').classList.contains('is-active')).toBe(false);
    expect(app.root.querySelector('.dash-cols-wrap').style.display).toBe('');
    expect(seg(app.root, 'dash-seg-cols', '3').getAttribute('aria-pressed')).toBe('true');
  });

  it('switching to Report reshapes the grid, hides the column control, and persists', async () => {
    const app = oneFav();
    await renderDashboard(app);
    seg(app.root, 'dash-seg-layout', 'Report').dispatchEvent(new Event('click', { bubbles: true }));
    const grid = app.root.querySelector('.dash-grid');
    expect(grid.classList.contains('is-report')).toBe(true);
    expect(seg(app.root, 'dash-seg-layout', 'Report').classList.contains('is-active')).toBe(true);
    expect(app.root.querySelector('.dash-cols-wrap').style.display).toBe('none');
    expect(app.savePref).toHaveBeenCalledWith('dashLayout', 'report');
    // …and back to Arrange restores the grid + column control.
    seg(app.root, 'dash-seg-layout', 'Arrange').dispatchEvent(new Event('click', { bubbles: true }));
    expect(grid.classList.contains('is-report')).toBe(false);
    expect(app.root.querySelector('.dash-cols-wrap').style.display).toBe('');
  });

  it('the column-count control switches 2/3 and persists', async () => {
    const app = oneFav();
    await renderDashboard(app);
    seg(app.root, 'dash-seg-cols', '2').dispatchEvent(new Event('click', { bubbles: true }));
    const grid = app.root.querySelector('.dash-grid');
    expect(grid.style.getPropertyValue('--dash-cols')).toBe('2');
    expect(seg(app.root, 'dash-seg-cols', '2').classList.contains('is-active')).toBe(true);
    expect(app.savePref).toHaveBeenCalledWith('dashCols', 2);
  });

  it('clicking the already-active layout or column is a no-op (no persist)', async () => {
    const app = oneFav();
    await renderDashboard(app);
    seg(app.root, 'dash-seg-layout', 'Arrange').dispatchEvent(new Event('click', { bubbles: true }));
    seg(app.root, 'dash-seg-cols', '3').dispatchEvent(new Event('click', { bubbles: true }));
    expect(app.savePref).not.toHaveBeenCalled();
  });

  it('reflects the persisted layout (Report) and column count (2) on first render', async () => {
    const app = oneFav();
    app.state.dashLayout = 'report';
    app.state.dashCols = 2;
    await renderDashboard(app);
    const grid = app.root.querySelector('.dash-grid');
    expect(grid.classList.contains('is-report')).toBe(true);
    expect(grid.style.getPropertyValue('--dash-cols')).toBe('2');
    expect(app.root.querySelector('.dash-cols-wrap').style.display).toBe('none');
    expect(seg(app.root, 'dash-seg-cols', '2').classList.contains('is-active')).toBe(true);
  });
});

// ── D3: global filter bar ────────────────────────────────────────────────────
describe('renderDashboard — global filter bar (#149 D3)', () => {
  const paramFav = (id, sql) => ({ id, name: id, sql, favorite: true });
  const setInput = (el, value) => {
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const pressEnter = (el) => el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  // A macrotask tick — flushes every pending microtask (including chained
  // awaits across runSlotTile/runPool), unlike a single `await Promise.resolve()`.
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  const fieldInput = (root, name) => root.querySelector('.var-field input[aria-label="' + name + '"]');

  it('shows no filter row when no favorite has a {name:Type} param', async () => {
    const app = dashApp([{ id: '1', name: 'Q', sql: 'SELECT 1', favorite: true }], vi.fn(async () => chartResult()));
    await renderDashboard(app);
    const filters = app.root.querySelector('.dash-filters');
    expect(filters.style.display).toBe('none');
    expect(filters.querySelectorAll('.var-field').length).toBe(0);
  });

  it('a param declared with conflicting types across two favorites renders a plain input with a visible warning (#173 acceptance, review F1)', async () => {
    const favorites = [
      paramFav('1', 'SELECT * FROM t WHERE i = {id:UInt64}'),
      paramFav('2', 'SELECT * FROM u WHERE i = {id:String}'),
    ];
    const app = dashApp(favorites, vi.fn(async () => chartResult()));
    app.state.varValues = { id: '7' };
    await renderDashboard(app);
    const input = fieldInput(app.root, 'id');
    expect(input.classList.contains('is-conflict')).toBe(true); // visible warning, distinct from is-invalid
    expect(input.title).toContain('Conflicting type declarations: UInt64 vs String');
  });

  it('a conflicted Enum-declared filter degrades to a plain input — the member dropdown is disabled (review F1)', async () => {
    const favorites = [
      paramFav('1', "SELECT * FROM t WHERE s = {s:Enum8('a' = 1, 'b' = 2)}"),
      paramFav('2', 'SELECT * FROM u WHERE s = {s:String}'),
    ];
    const app = dashApp(favorites, vi.fn(async () => chartResult()));
    await renderDashboard(app);
    const input = fieldInput(app.root, 's');
    input.dispatchEvent(new Event('focus', { bubbles: true }));
    expect(app.root.querySelectorAll('[role="option"]')).toHaveLength(0); // no member dropdown
    expect(input.classList.contains('is-conflict')).toBe(true);
    // A non-conflicted enum filter keeps its dropdown (control degradation is per-field).
    const app2 = dashApp([paramFav('1', "SELECT * FROM t WHERE s = {s:Enum8('a' = 1, 'b' = 2)}")], vi.fn(async () => chartResult()));
    await renderDashboard(app2);
    const input2 = fieldInput(app2.root, 's');
    input2.dispatchEvent(new Event('focus', { bubbles: true }));
    expect([...app2.root.querySelectorAll('[role="option"]')].map((o) => o.textContent)).toEqual(['a', 'b']);
  });

  it('renders one field per param detected across favorites, first-appearance order', async () => {
    const favorites = [
      paramFav('1', 'SELECT * FROM t WHERE y = {year:UInt16}'),
      paramFav('2', 'SELECT * FROM u WHERE r = {region:String}'),
    ];
    const app = dashApp(favorites, vi.fn(async () => chartResult()));
    app.state.varValues = { year: '2024', region: 'us' };
    await renderDashboard(app);
    const filters = app.root.querySelector('.dash-filters');
    expect(filters.style.display).not.toBe('none');
    expect([...filters.querySelectorAll('.var-name')].map((n) => n.textContent)).toEqual(['year', 'region']);
    expect(fieldInput(app.root, 'year').value).toBe('2024');
  });

  it('typing debounces before the affected tile(s) re-run; an unaffected tile is untouched', async () => {
    vi.useFakeTimers();
    try {
      const favorites = [
        paramFav('1', 'SELECT * FROM t WHERE y = {year:UInt16}'),
        paramFav('2', 'SELECT * FROM u WHERE y = {year:UInt16}'),
        paramFav('3', 'SELECT * FROM v WHERE r = {region:String}'),
      ];
      const runTile = vi.fn(async () => chartResult());
      const app = dashApp(favorites, runTile);
      app.state.varValues = { year: '2023', region: 'us' };
      await renderDashboard(app);
      expect(runTile).toHaveBeenCalledTimes(3);

      setInput(fieldInput(app.root, 'year'), '2024');
      expect(runTile).toHaveBeenCalledTimes(3); // debounced — no re-run yet
      await vi.advanceTimersByTimeAsync(499);
      expect(runTile).toHaveBeenCalledTimes(3);
      await vi.advanceTimersByTimeAsync(1);
      expect(runTile).toHaveBeenCalledTimes(5); // only the 2 'year' tiles re-ran
      expect(runTile.mock.calls.filter((c) => c[0] === favorites[2].sql)).toHaveLength(1); // region tile untouched
      expect(app.state.varValues.year).toBe('2024'); // shared with the workbench's varValues
      expect(app.saveVarValues).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('Enter fires the re-run immediately, bypassing the debounce', async () => {
    const favorites = [paramFav('1', 'SELECT * FROM t WHERE y = {year:UInt16}')];
    const runTile = vi.fn(async () => chartResult());
    const app = dashApp(favorites, runTile);
    app.state.varValues = { year: '2023' };
    await renderDashboard(app);
    expect(runTile).toHaveBeenCalledTimes(1);
    const input = fieldInput(app.root, 'year');
    setInput(input, '2024');
    pressEnter(input);
    await flush();
    expect(runTile).toHaveBeenCalledTimes(2);
  });

  it('Enter/blur with no pending edit is a no-op (nothing to commit)', async () => {
    const favorites = [paramFav('1', 'SELECT * FROM t WHERE y = {year:UInt16}')];
    const runTile = vi.fn(async () => chartResult());
    const app = dashApp(favorites, runTile);
    app.state.varValues = { year: '2023' };
    await renderDashboard(app);
    expect(runTile).toHaveBeenCalledTimes(1);
    const input = fieldInput(app.root, 'year');
    pressEnter(input); // no prior 'input' event — no pending debounce to fire
    input.dispatchEvent(new Event('blur', { bubbles: true }));
    await flush();
    expect(runTile).toHaveBeenCalledTimes(1);
  });

  it('editing a filter before the dashboard has ever run a tile is a no-op', async () => {
    const favorites = [paramFav('1', 'SELECT * FROM t WHERE y = {year:UInt16}')];
    const runTile = vi.fn(async () => chartResult());
    const app = dashApp(favorites, runTile);
    app.state.varValues = { year: '2023' };
    app.ensureFreshToken = vi.fn(async () => false); // session can't be refreshed — no slots built
    await renderDashboard(app);
    expect(runTile).not.toHaveBeenCalled();
    const input = fieldInput(app.root, 'year');
    setInput(input, '2024');
    pressEnter(input);
    await flush();
    expect(runTile).not.toHaveBeenCalled(); // still a no-op — nothing to update
  });

  it('blur fires the re-run immediately, bypassing the debounce', async () => {
    const favorites = [paramFav('1', 'SELECT * FROM t WHERE y = {year:UInt16}')];
    const runTile = vi.fn(async () => chartResult());
    const app = dashApp(favorites, runTile);
    app.state.varValues = { year: '2023' };
    await renderDashboard(app);
    expect(runTile).toHaveBeenCalledTimes(1);
    const input = fieldInput(app.root, 'year');
    setInput(input, '2024');
    input.dispatchEvent(new Event('blur', { bubbles: true }));
    await flush();
    expect(runTile).toHaveBeenCalledTimes(2);
  });

  it('a tile with an unfilled param shows a placeholder and never calls runTile; filling it runs the tile', async () => {
    const favorites = [paramFav('1', 'SELECT * FROM t WHERE y = {year:UInt16}')];
    const runTile = vi.fn(async () => chartResult());
    const app = dashApp(favorites, runTile); // no varValues set — 'year' unfilled
    await renderDashboard(app);
    expect(runTile).not.toHaveBeenCalled();
    const placeholder = app.root.querySelector('.dash-tile-unfilled');
    expect(placeholder.textContent).toBe('Enter a value for: year');
    // An unfilled tile is not counted in the "N not shown" note.
    expect(app.root.querySelector('.dash-skip').style.display).toBe('none');

    const input = fieldInput(app.root, 'year');
    setInput(input, '2024');
    pressEnter(input);
    await flush();
    expect(runTile).toHaveBeenCalledTimes(1);
    expect(app.root.querySelector('.dash-tile canvas')).not.toBeNull();
    expect(app.root.querySelector('.dash-tile-unfilled')).toBeNull();
  });

  it('per-source gating (#173): a value that cannot serialize errors only its own tile', async () => {
    const favorites = [
      paramFav('1', 'SELECT * FROM t WHERE db = {db:String}'),
      { id: '2', name: 'Good', sql: 'SELECT k, v FROM good', favorite: true },
    ];
    const runTile = vi.fn(async () => chartResult());
    const app = dashApp(favorites, runTile);
    app.state.varValues = { db: ['not', 'scalar'] }; // array value, scalar declaration → structural
    await renderDashboard(app);
    // the broken tile never fetched, the sibling did — one bad source blocks nothing else
    expect(runTile).toHaveBeenCalledTimes(1);
    expect(runTile.mock.calls[0][0]).toBe('SELECT k, v FROM good');
    expect(app.root.querySelector('.dash-tile-error').textContent).toContain('array value');
    expect(app.root.querySelector('.dash-tile canvas')).not.toBeNull();
  });

  it('tiles fetch with the wave\'s prepared args (#173), not by re-deriving per tile', async () => {
    const favorites = [paramFav('1', 'SELECT * FROM t WHERE y = {year:UInt16}')];
    const runTile = vi.fn(async () => chartResult());
    const app = dashApp(favorites, runTile);
    app.state.varValues = { year: '2024' };
    await renderDashboard(app);
    expect(runTile).toHaveBeenCalledWith('SELECT * FROM t WHERE y = {year:UInt16}', { param_year: '2024' });
  });

  it('discards a stale response when a newer edit\'s response arrives first (last edit wins)', async () => {
    const favorites = [paramFav('1', 'SELECT * FROM t WHERE y = {year:UInt16}')];
    const resolvers = [];
    const runTile = vi.fn(() => new Promise((resolve) => resolvers.push(resolve)));
    const app = dashApp(favorites, runTile);
    app.state.varValues = { year: '2023' };
    const rendered = renderDashboard(app);
    await flush();
    expect(resolvers).toHaveLength(1);
    resolvers[0](chartResult());
    await rendered;

    // Distinct but still UInt16-valid values (#170: an invalid value would
    // never reach app.runTile at all, short-circuiting this race).
    const input = fieldInput(app.root, 'year');
    setInput(input, '11');
    pressEnter(input);
    await flush();
    expect(resolvers).toHaveLength(2);
    setInput(input, '22');
    pressEnter(input);
    await flush();
    expect(resolvers).toHaveLength(3);

    // The newer edit ('B') resolves first; the superseded ('A') resolves after.
    resolvers[2]({ error: 'B wins' });
    await flush();
    resolvers[1]({ error: 'A is stale — must be discarded' });
    await flush();

    expect(app.root.querySelector('.dash-tile-error').textContent).toBe('B wins');
  });

  // ── #170: typed client-side validation ──────────────────────────────────────
  it('#170: an invalid value shows the inline error and gates the tile like an unfilled one', async () => {
    const favorites = [paramFav('1', 'SELECT * FROM t WHERE y = {year:UInt16}')];
    const runTile = vi.fn(async () => chartResult());
    const app = dashApp(favorites, runTile);
    app.state.varValues = { year: '2023' };
    await renderDashboard(app);
    expect(runTile).toHaveBeenCalledTimes(1);
    const input = fieldInput(app.root, 'year');
    setInput(input, 'abc');
    pressEnter(input);
    await flush();
    expect(runTile).toHaveBeenCalledTimes(1); // never re-fetched with the bad value
    expect(input.classList.contains('is-invalid')).toBe(true);
    expect(app.root.querySelector('.dash-tile-unfilled').textContent).toBe('Enter a value for: year');
  });
  it("#170: a plausible mid-typing prefix stays neutral while typing, hardens on blur", () => {
    const favorites = [paramFav('1', 'SELECT * FROM t WHERE y = {year:Int32}')];
    const runTile = vi.fn(async () => chartResult());
    const app = dashApp(favorites, runTile);
    app.state.varValues = { year: '5' };
    return renderDashboard(app).then(async () => {
      const input = fieldInput(app.root, 'year');
      setInput(input, '-');
      expect(input.classList.contains('is-invalid')).toBe(false); // neutral — could still become '-5'
      input.dispatchEvent(new Event('blur', { bubbles: true }));
      await flush();
      expect(input.classList.contains('is-invalid')).toBe(true); // blur hardens it
    });
  });
  it('#170: correcting an invalid value clears the affordance and re-runs the tile', async () => {
    const favorites = [paramFav('1', 'SELECT * FROM t WHERE y = {year:UInt16}')];
    const runTile = vi.fn(async () => chartResult());
    const app = dashApp(favorites, runTile);
    app.state.varValues = { year: '2023' };
    await renderDashboard(app);
    const input = fieldInput(app.root, 'year');
    setInput(input, 'abc');
    pressEnter(input);
    await flush();
    expect(app.root.querySelector('.dash-tile-unfilled')).not.toBeNull();
    setInput(input, '2025');
    pressEnter(input);
    await flush();
    expect(input.classList.contains('is-invalid')).toBe(false);
    expect(app.root.querySelector('.dash-tile-unfilled')).toBeNull();
    expect(runTile).toHaveBeenCalledTimes(2); // initial + the corrected re-run
  });

  // ── #165: optional blocks on the dashboard ────────────────────────────────
  const optFav = (id) => paramFav(id, 'SELECT * FROM t WHERE 1 /*[ AND d = {d:String} ]*/');

  it('#165: a block-only param is listed in the filter bar with the optional affordance', async () => {
    const app = dashApp([optFav('1')], vi.fn(async () => chartResult()));
    await renderDashboard(app);
    const field = app.root.querySelector('.dash-filters .var-field');
    expect(field.classList.contains('is-optional')).toBe(true);
    expect(field.querySelector('.var-name').textContent).toBe('d');
    expect(fieldInput(app.root, 'd').title).toContain('optional');
  });

  it('#165: a blank optional filter deactivates the predicate instead of blocking — the tile runs materialized', async () => {
    const runTile = vi.fn(async () => chartResult());
    const app = dashApp([optFav('1')], runTile); // no value, no activation
    await renderDashboard(app);
    expect(app.root.querySelector('.dash-tile-unfilled')).toBeNull(); // NOT gated
    expect(runTile).toHaveBeenCalledTimes(1);
    const [sql, args] = runTile.mock.calls[0];
    expect(sql).toBe('SELECT * FROM t WHERE 1 '); // block omitted from the wire text
    expect(args).toEqual({}); // param_d never sent
  });

  it('#165: typing a value activates the block — the affected tile re-runs with the predicate + arg', async () => {
    const runTile = vi.fn(async () => chartResult());
    const app = dashApp([optFav('1')], runTile);
    await renderDashboard(app);
    const input = fieldInput(app.root, 'd');
    setInput(input, 'abc');
    expect(app.state.filterActive.d).toBe(true); // text control syncs activation
    expect(app.saveFilterActive).toHaveBeenCalled();
    pressEnter(input);
    await flush();
    expect(runTile).toHaveBeenCalledTimes(2);
    const [sql, args] = runTile.mock.calls[1];
    expect(sql).toBe('SELECT * FROM t WHERE 1  AND d = {d:String} ');
    expect(args).toEqual({ param_d: 'abc' });
    // …and blanking it flips activation off and re-runs without the predicate.
    setInput(input, '');
    expect(app.state.filterActive.d).toBe(false);
    pressEnter(input);
    await flush();
    expect(runTile).toHaveBeenCalledTimes(3);
    expect(runTile.mock.calls[2]).toEqual(['SELECT * FROM t WHERE 1 ', {}]);
  });

  it('#165: a required (non-block) param still blocks the tile with the placeholder', async () => {
    const favorites = [paramFav('1', 'SELECT * FROM t WHERE y = {y:UInt16} /*[ AND d = {d:String} ]*/')];
    const runTile = vi.fn(async () => chartResult());
    const app = dashApp(favorites, runTile);
    await renderDashboard(app);
    expect(runTile).not.toHaveBeenCalled();
    expect(app.root.querySelector('.dash-tile-unfilled').textContent).toBe('Enter a value for: y');
    // the required field carries no optional affordance
    expect(fieldInput(app.root, 'y').closest('.var-field').classList.contains('is-optional')).toBe(false);
  });

  it('#165: a stale persisted value with activation off keeps the block omitted', async () => {
    const runTile = vi.fn(async () => chartResult());
    const app = dashApp([optFav('1')], runTile);
    app.state.varValues = { d: 'stale' };
    app.state.filterActive = { d: false };
    await renderDashboard(app);
    expect(runTile.mock.calls[0]).toEqual(['SELECT * FROM t WHERE 1 ', {}]);
  });

  it('#165: a block-free favorite keeps its exact bytes on the wire', async () => {
    const runTile = vi.fn(async () => chartResult());
    const sql = 'SELECT * FROM t WHERE y = {year:UInt16};'; // trailing ; kept verbatim
    const app = dashApp([paramFav('1', sql)], runTile);
    app.state.varValues = { year: '2024' };
    await renderDashboard(app);
    expect(runTile).toHaveBeenCalledWith(sql, { param_year: '2024' });
  });

  describe('#169 relative time', () => {
    it('a date-like param gets the preset+preview combobox; a non-date param gets the #171 recents-only combobox (no preview)', async () => {
      const favorites = [paramFav('1', 'SELECT * FROM t WHERE d >= {from:DateTime} AND r = {region:String}')];
      const app = dashApp(favorites, vi.fn(async () => chartResult()));
      app.state.varValues = { from: '-1h', region: 'us' };
      await renderDashboard(app);
      const fromInput = fieldInput(app.root, 'from');
      const regionInput = fieldInput(app.root, 'region');
      expect(fromInput.getAttribute('role')).toBe('combobox');
      expect(regionInput.getAttribute('role')).toBe('combobox'); // #171: every field is a combobox now
      expect(fromInput.closest('.var-field').querySelector('.var-combo-preview')).not.toBeNull();
      expect(regionInput.closest('.var-field').querySelector('.var-combo-preview')).toBeNull();
    });
    it('picking a preset inserts the expression, persists it, and commits IMMEDIATELY — bypassing the debounce', async () => {
      vi.useFakeTimers();
      try {
        const favorites = [paramFav('1', 'SELECT * FROM t WHERE d >= {from:DateTime}')];
        const runTile = vi.fn(async () => chartResult());
        const app = dashApp(favorites, runTile);
        app.state.varValues = { from: 'now' };
        await renderDashboard(app);
        expect(runTile).toHaveBeenCalledTimes(1);
        const input = fieldInput(app.root, 'from');
        input.dispatchEvent(new Event('focus', { bubbles: true }));
        // The field already holds 'now' (the current value), so opening on
        // focus filters to presets matching it — the first match is 'now/d'.
        const opt = app.root.querySelector('[role="option"]');
        opt.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
        expect(input.value).toBe('now/d');
        expect(app.state.varValues.from).toBe('now/d');
        await vi.advanceTimersByTimeAsync(0); // let the immediate commit's microtasks settle — no 500ms wait needed
        expect(runTile).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });
    it('an invalid (near-miss) expression shows the tile placeholder and never calls runTile', async () => {
      const favorites = [paramFav('1', 'SELECT * FROM t WHERE d >= {from:DateTime}')];
      const runTile = vi.fn(async () => chartResult());
      const app = dashApp(favorites, runTile);
      app.state.varValues = { from: 'now' };
      await renderDashboard(app);
      expect(runTile).toHaveBeenCalledTimes(1);
      const input = fieldInput(app.root, 'from');
      setInput(input, 'now/q');
      input.dispatchEvent(new Event('blur', { bubbles: true }));
      await flush();
      expect(runTile).toHaveBeenCalledTimes(1); // no new run — the invalid value never bound
      expect(app.root.querySelector('.dash-tile-unfilled')).not.toBeNull();
      expect(input.classList.contains('is-invalid')).toBe(true);
    });
    it('Enter with the list closed hardens/gates via the same keydown path as a plain filter field', async () => {
      const favorites = [paramFav('1', 'SELECT * FROM t WHERE d >= {from:DateTime}')];
      const runTile = vi.fn(async () => chartResult());
      const app = dashApp(favorites, runTile);
      app.state.varValues = { from: 'now' };
      await renderDashboard(app);
      const input = fieldInput(app.root, 'from');
      setInput(input, 'now/q');
      pressEnter(input);
      await flush();
      expect(input.classList.contains('is-invalid')).toBe(true);
      expect(runTile).toHaveBeenCalledTimes(1); // never re-ran with the invalid value
    });
    it('Enter with an active preset option commits it via keydown instead of hardening the prior text', async () => {
      vi.useFakeTimers();
      try {
        const favorites = [paramFav('1', 'SELECT * FROM t WHERE d >= {from:DateTime}')];
        const runTile = vi.fn(async () => chartResult());
        const app = dashApp(favorites, runTile);
        app.state.varValues = { from: 'now' };
        await renderDashboard(app);
        const input = fieldInput(app.root, 'from');
        // app.root isn't attached to `document` in this test harness, so a
        // real input.focus() can't land — dispatch the synthetic event
        // combo's own 'focus' listener reacts to, same as this file's other
        // combobox tests.
        input.dispatchEvent(new Event('focus', { bubbles: true }));
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        expect(input.value).toBe('now/d'); // filtered to 'now'-matching presets; first match
        expect(input.getAttribute('aria-expanded')).toBe('false');
        await vi.advanceTimersByTimeAsync(0);
        expect(runTile).toHaveBeenCalledTimes(2); // committed immediately, bypassing the debounce
      } finally {
        vi.useRealTimers();
      }
    });
    it('a Refresh resolves one wallNow across every tile; a later Refresh with an advanced clock moves the window', async () => {
      const favorites = [
        paramFav('1', 'SELECT * FROM t WHERE d >= {from:DateTime}'),
        paramFav('2', 'SELECT * FROM u WHERE d >= {from:DateTime}'),
      ];
      const runTile = vi.fn(async () => chartResult());
      const app = makeApp({ runTile, wallNow: vi.fn(() => 1751200000000) });
      app.state.savedQueries = favorites;
      app.state.varValues = { from: '-1h' };
      await renderDashboard(app);
      const expected1 = String(Math.round((1751200000000 - 3600000) / 1000));
      expect(runTile.mock.calls[0][1]).toEqual({ param_from: expected1 });
      expect(runTile.mock.calls[1][1]).toEqual({ param_from: expected1 }); // same instant, both tiles
      app.wallNow = () => 1751200000000 + 3600000; // advance the clock, then Refresh
      const refreshBtn = app.root.querySelector('.dash-btn');
      refreshBtn.click();
      await flush();
      const expected2 = String(Math.round(1751200000000 / 1000));
      expect(runTile.mock.calls[2][1]).toEqual({ param_from: expected2 });
      expect(runTile.mock.calls[3][1]).toEqual({ param_from: expected2 });
    });
    it('the stored expression persists and restores — not the resolved value', async () => {
      const favorites = [paramFav('1', 'SELECT * FROM t WHERE d >= {from:DateTime}')];
      const app = dashApp(favorites, vi.fn(async () => chartResult()));
      app.state.varValues = { from: '-1h' };
      await renderDashboard(app);
      expect(fieldInput(app.root, 'from').value).toBe('-1h');
      expect(app.saveVarValues).not.toHaveBeenCalled(); // nothing edited yet — just restored
    });
  });

  // #172 v1 — the Dashboard only ever gets the declared-type dropdown (the
  // declaration travels with the tile SQL); v2's schema-cache inference is
  // workbench-only (no schema cache here).
  describe('#172 enum variables (v1, from the tile SQL declaration)', () => {
    const ENUM_TYPE = "Enum8('active' = 1, 'deleted' = 2, 'banned' = 3)";
    it('renders a dropdown of the declared members', async () => {
      const favorites = [paramFav('1', `SELECT * FROM t WHERE status = {status:${ENUM_TYPE}}`)];
      const app = dashApp(favorites, vi.fn(async () => chartResult()));
      await renderDashboard(app);
      const input = fieldInput(app.root, 'status');
      input.dispatchEvent(new Event('focus', { bubbles: true }));
      const opts = [...app.root.querySelectorAll('[role="option"]')].map((o) => o.textContent);
      expect(opts).toEqual(['active', 'deleted', 'banned']);
    });
    it('gates a non-member value inline (blocking, since the declared type is a real Enum)', async () => {
      const favorites = [paramFav('1', `SELECT * FROM t WHERE status = {status:${ENUM_TYPE}}`)];
      const runTile = vi.fn(async () => chartResult());
      const app = dashApp(favorites, runTile);
      await renderDashboard(app);
      const input = fieldInput(app.root, 'status');
      setInput(input, 'nope');
      input.dispatchEvent(new Event('blur', { bubbles: true }));
      await flush();
      expect(input.classList.contains('is-invalid')).toBe(true);
      expect(app.root.querySelector('.dash-tile-unfilled')).not.toBeNull();
    });
    it('a bare numeric code matching a declared code is accepted (live-server fact)', async () => {
      const favorites = [paramFav('1', `SELECT * FROM t WHERE status = {status:${ENUM_TYPE}}`)];
      const runTile = vi.fn(async () => chartResult());
      const app = dashApp(favorites, runTile);
      await renderDashboard(app);
      const input = fieldInput(app.root, 'status');
      setInput(input, '2');
      pressEnter(input);
      await flush();
      expect(input.classList.contains('is-invalid')).toBe(false);
      expect(runTile).toHaveBeenLastCalledWith(expect.any(String), { param_status: '2' });
    });
    it('a non-enum String param keeps the plain recents combobox (no v2 here — no schema cache on the Dashboard)', async () => {
      const favorites = [paramFav('1', 'SELECT * FROM t WHERE r = {region:String}')];
      const app = dashApp(favorites, vi.fn(async () => chartResult()));
      await renderDashboard(app);
      const input = fieldInput(app.root, 'region');
      input.dispatchEvent(new Event('focus', { bubbles: true }));
      expect(app.root.querySelectorAll('[role="option"]')).toHaveLength(0); // no recents recorded, no enum values
    });
  });
});

// ── D3 + #171: recent-value recording + the recents dropdown ────────────────
describe('renderDashboard — recent values (#171)', () => {
  const paramFav = (id, sql) => ({ id, name: id, sql, favorite: true });
  const fieldInput = (root, name) => root.querySelector('.var-field input[aria-label="' + name + '"]');

  it('records the wave\'s boundParams on a successful tile completion', async () => {
    const favorites = [paramFav('1', 'SELECT * FROM t WHERE y = {year:UInt16}')];
    const runTile = vi.fn(async () => chartResult());
    const app = dashApp(favorites, runTile);
    app.state.varValues = { year: '2024' };
    await renderDashboard(app);
    expect(app.recordBoundParams).toHaveBeenCalledTimes(1);
    expect(app.recordBoundParams.mock.calls[0][0]).toEqual([
      expect.objectContaining({ name: 'year', rawValue: '2024' }),
    ]);
  });

  it('never records on a failed tile', async () => {
    const favorites = [paramFav('1', 'SELECT * FROM t WHERE y = {year:UInt16}')];
    const runTile = vi.fn(async () => ({ error: 'boom' }));
    const app = dashApp(favorites, runTile);
    app.state.varValues = { year: '2024' };
    await renderDashboard(app);
    expect(app.recordBoundParams).not.toHaveBeenCalled();
  });

  it('an omitted-optional-block param is never in the recorded boundParams', async () => {
    const favorites = [paramFav('1', 'SELECT * FROM t WHERE 1 /*[ AND d = {d:String} ]*/')];
    const runTile = vi.fn(async () => chartResult());
    const app = dashApp(favorites, runTile);
    await renderDashboard(app); // d blank → block inactive → not bound at all
    expect(app.recordBoundParams).toHaveBeenCalledTimes(1);
    expect(app.recordBoundParams.mock.calls[0][0]).toEqual([]);
  });

  it('a non-date field shows recorded recents on focus, newest-first, filtered as you type', async () => {
    const favorites = [paramFav('1', 'SELECT * FROM t WHERE r = {region:String}')];
    const app = dashApp(favorites, vi.fn(async () => chartResult()));
    let map = emptyRecentMap();
    map = recordRecent(map, 'region', 'us');
    map = recordRecent(map, 'region', 'eu');
    app.state.varRecent = map;
    await renderDashboard(app);
    const input = fieldInput(app.root, 'region');
    input.dispatchEvent(new Event('focus', { bubbles: true }));
    expect([...app.root.querySelectorAll('[role="option"]')].map((o) => o.textContent)).toEqual(['eu', 'us']);
    input.value = 'us';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect([...app.root.querySelectorAll('[role="option"]')].map((o) => o.textContent)).toEqual(['us']);
  });

  it('clicking a recent inserts it; "Clear recent" calls app.clearVarRecent(name)', async () => {
    const favorites = [paramFav('1', 'SELECT * FROM t WHERE r = {region:String}')];
    const app = dashApp(favorites, vi.fn(async () => chartResult()));
    app.state.varRecent = recordRecent(emptyRecentMap(), 'region', 'us');
    await renderDashboard(app);
    const input = fieldInput(app.root, 'region');
    input.dispatchEvent(new Event('focus', { bubbles: true }));
    const opt = app.root.querySelector('[role="option"]');
    opt.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    expect(input.value).toBe('us');
    input.dispatchEvent(new Event('focus', { bubbles: true }));
    const clearBtn = app.root.querySelector('button.var-combo-clear');
    clearBtn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    expect(app.clearVarRecent).toHaveBeenCalledWith('region');
  });

  it('a date-like field composes ONE dropdown: Recent first, then Presets (user decision, phase-7 feedback)', async () => {
    const favorites = [paramFav('1', 'SELECT * FROM t WHERE d >= {from:DateTime}')];
    const app = dashApp(favorites, vi.fn(async () => chartResult()));
    app.state.varRecent = recordRecent(emptyRecentMap(), 'from', '-3h'); // not a built-in preset
    await renderDashboard(app);
    const input = fieldInput(app.root, 'from');
    input.dispatchEvent(new Event('focus', { bubbles: true }));
    const groups = [...app.root.querySelectorAll('.combo-group')].map((g) => g.textContent);
    expect(groups).toEqual(['Recent', 'Presets']);
    expect([...app.root.querySelectorAll('[role="option"]')].map((o) => o.textContent)).toContain('-3h');
  });
});

// ── app.js: runTile + auth handoff wiring ────────────────────────────────────
function jwt(payload) {
  const b = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b({ alg: 'RS256' })}.${b(payload)}.sig`;
}
const validToken = jwt({ email: 'me@example.com', exp: Math.floor(Date.now() / 1000) + 3600 });

function resp(opts) {
  return {
    ok: opts.ok ?? true, status: opts.status ?? 200,
    json: async () => opts.json, text: async () => opts.text ?? JSON.stringify(opts.json),
    clone() { return this; },
    headers: { get: () => null },
  };
}
function makeFetch(routes) {
  return vi.fn(async (url, init) => {
    const sql = init && init.body;
    for (const [test, r] of routes) if (test(url, sql)) return typeof r === 'function' ? r() : r;
    return resp({ json: { data: [] } });
  });
}
function appEnv(over = {}) {
  const root = document.createElement('div');
  document.body.appendChild(root);
  return {
    root, document, window,
    location: { host: 'ch.example', origin: 'https://ch.example', pathname: '/sql', search: '', hash: '', href: 'https://ch.example/sql' },
    sessionStorage: memSession({ oauth_id_token: validToken }),
    crypto: webcrypto, Editor: createCodeMirrorEditor, Chart: FakeChart,
    fetch: makeFetch([]), now: () => 0, retryMs: 0, handoffMs: 10, handoffListenMs: 10,
    navigator: { clipboard: { writeText: vi.fn(async () => {}) } },
    ...over,
  };
}
const msg = (data, source, origin = 'https://ch.example') => {
  const e = new Event('message');
  e.data = data; e.origin = origin; e.source = source;
  return e;
};

describe('app.runTile', () => {
  it('returns the parsed result on success', async () => {
    const app = createApp(appEnv({
      fetch: makeFetch([[(u, sql) => /SELECT k/.test(sql || ''),
        resp({ json: { meta: [{ name: 'k', type: 'String' }, { name: 'v', type: 'UInt64' }], data: [{ k: 'a', v: 1 }], statistics: { elapsed: 0.01, bytes_read: 2048 } } })]]),
    }));
    const r = await app.runTile('SELECT k, v FROM t');
    expect(r.columns.map((c) => c.name)).toEqual(['k', 'v']);
    expect(r.rows).toEqual([['a', 1]]);
    expect(r.meta).toMatchObject({ ms: 10, bytes: 2048 });
  });
  it('reports the CH error message on a rejected query', async () => {
    const app = createApp(appEnv({
      fetch: makeFetch([[(u, sql) => /SELECT/.test(sql || ''), resp({ ok: false, status: 500, text: 'Cannot execute query in readonly mode' })]]),
    }));
    expect((await app.runTile('SELECT 1')).error).toMatch(/readonly/);
  });
  it('substitutes state.varValues as param_<name> args (#149 D3)', async () => {
    const fetch = makeFetch([[(u, sql) => /SELECT/.test(sql || ''),
      resp({ json: { meta: [{ name: 'n', type: 'UInt64' }], data: [{ n: 1 }] } })]]);
    const app = createApp(appEnv({ fetch }));
    app.state.varValues.year = '2024';
    await app.runTile('SELECT {year:UInt16} AS n');
    const queryCall = fetch.mock.calls.find((c) => c[1] && c[1].method === 'POST');
    expect(queryCall[0]).toContain('param_year=2024');
  });
  it('prepares per-statement, so a multi-statement favorite still binds its params (#155)', async () => {
    // paramArgs over the whole blob saw the leading SET and skipped substitution
    // entirely; the pipeline splits first, so param_year rides along.
    const fetch = makeFetch([[(u, sql) => /SELECT/.test(sql || ''),
      resp({ json: { meta: [{ name: 'n', type: 'UInt64' }], data: [{ n: 1 }] } })]]);
    const app = createApp(appEnv({ fetch }));
    app.state.varValues.year = '2024';
    await app.runTile('SET x = 1; SELECT {year:UInt16} AS n');
    const queryCall = fetch.mock.calls.find((c) => c[1] && c[1].method === 'POST');
    expect(queryCall[0]).toContain('param_year=2024');
  });
  it('explicit prepared args win over self-preparation (the dashboard wave passes them)', async () => {
    const fetch = makeFetch([[(u, sql) => /SELECT/.test(sql || ''),
      resp({ json: { meta: [{ name: 'n', type: 'UInt64' }], data: [{ n: 1 }] } })]]);
    const app = createApp(appEnv({ fetch }));
    app.state.varValues.year = '1999'; // must NOT be read — the caller's batch is authoritative
    await app.runTile('SELECT {year:UInt16} AS n', { param_year: '2024' });
    const queryCall = fetch.mock.calls.find((c) => c[1] && c[1].method === 'POST');
    expect(queryCall[0]).toContain('param_year=2024');
    expect(queryCall[0]).not.toContain('param_year=1999');
  });
  it('errors (without driving sign-out) when there is no token', async () => {
    const app = createApp(appEnv({ sessionStorage: memSession({}) }));
    expect(await app.runTile('SELECT 1')).toEqual({ error: 'Not signed in' });
  });
});

describe('app config base on the dashboard route', () => {
  it('resolves config.json from /sql, not /sql/dashboard', async () => {
    const fetch = makeFetch([]);
    const app = createApp(appEnv({
      fetch,
      location: { host: 'ch.example', origin: 'https://ch.example', pathname: '/sql/dashboard', search: '', hash: '', href: 'https://ch.example/sql/dashboard' },
    }));
    await app.ensureConfig();
    const urls = fetch.mock.calls.map((c) => c[0]);
    expect(urls.some((u) => /\/sql\/config\.json$/.test(u))).toBe(true);
    expect(urls.some((u) => /dashboard\/config\.json/.test(u))).toBe(false);
  });
});

describe('app.renderDashboard', () => {
  it('renders the favorites dashboard into the root', async () => {
    const app = createApp(appEnv({
      fetch: makeFetch([[(u, sql) => /mychart/.test(sql || ''),
        resp({ json: { meta: [{ name: 'k', type: 'String' }, { name: 'v', type: 'UInt64' }], data: [{ k: 'a', v: 1 }, { k: 'b', v: 2 }] } })]]),
    }));
    app.state.savedQueries = [{ id: '1', name: 'Q', sql: 'SELECT k, v FROM mychart', favorite: true }];
    await app.renderDashboard();
    expect(app.root.querySelector('.dash-tile canvas')).not.toBeNull();
  });
});

describe('app auth handoff', () => {
  it('openDashboard opens a tab and grants credentials when the child asks', () => {
    const child = { postMessage: vi.fn() };
    const app = createApp(appEnv({ openWindow: vi.fn(() => child) }));
    app.openDashboard();
    window.dispatchEvent(msg({ type: 'nope' }, child)); // ignored (wrong type)
    window.dispatchEvent(msg({ type: AUTH_REQUEST }, child));
    expect(child.postMessage).toHaveBeenCalledTimes(1);
    const [payload, origin] = child.postMessage.mock.calls[0];
    expect(payload.type).toBe(AUTH_GRANT);
    expect(payload.creds.oauth_id_token).toBe(validToken);
    expect(origin).toBe('https://ch.example');
  });
  it('openDashboard tolerates a blocked popup (null window)', () => {
    const app = createApp(appEnv({ openWindow: () => null }));
    expect(() => app.openDashboard()).not.toThrow();
  });
  it('openDashboard does not grant when the opener holds no credentials', () => {
    const child = { postMessage: vi.fn() };
    const app = createApp(appEnv({ sessionStorage: memSession({}), openWindow: () => child }));
    app.openDashboard();
    window.dispatchEvent(msg({ type: AUTH_REQUEST }, child));
    expect(child.postMessage).not.toHaveBeenCalled();
  });
  it('receiveAuthHandoff resolves false with no opener', async () => {
    const app = createApp(appEnv());
    await expect(app.receiveAuthHandoff({})).resolves.toBe(false);
  });
  it('applies an OAuth grant and re-seeds in-memory auth fields', async () => {
    const ss = memSession({});
    const app = createApp(appEnv({ sessionStorage: ss }));
    const opener = { postMessage: vi.fn() };
    const newTok = jwt({ email: 'x@y.com', exp: Math.floor(Date.now() / 1000) + 3600 });
    const p = app.receiveAuthHandoff({ opener });
    expect(opener.postMessage).toHaveBeenCalledWith({ type: AUTH_REQUEST }, 'https://ch.example');
    window.dispatchEvent(msg({ type: 'other' }, opener)); // ignored
    window.dispatchEvent(msg({ type: AUTH_GRANT, creds: { oauth_id_token: newTok, oauth_refresh_token: 'r', oauth_idp: 'g', oauth_origin: 'https://cluster' } }, opener));
    await expect(p).resolves.toBe(true);
    expect(app.token).toBe(newTok);
    expect(app.idpId).toBe('g');
    expect(app.chCtx.origin).toBe('https://cluster');
    expect(ss.getItem('oauth_id_token')).toBe(newTok);
  });
  it('applies a basic-auth grant', async () => {
    const ss = memSession({});
    const app = createApp(appEnv({ sessionStorage: ss }));
    const opener = { postMessage: vi.fn() };
    const p = app.receiveAuthHandoff({ opener });
    window.dispatchEvent(msg({ type: AUTH_GRANT, creds: { ch_basic_auth: 'YmFzZQ==', ch_basic_user: 'u', ch_basic_origin: 'https://c2' } }, opener));
    await expect(p).resolves.toBe(true);
    expect(app.authMode).toBe('basic');
    expect(app.chCtx.origin).toBe('https://c2');
    expect(ss.getItem('ch_basic_auth')).toBe('YmFzZQ==');
  });
  it('ignores an empty grant and applies a later valid one', async () => {
    const ss = memSession({});
    const app = createApp(appEnv({ sessionStorage: ss }));
    const opener = { postMessage: vi.fn() };
    const p = app.receiveAuthHandoff({ opener });
    window.dispatchEvent(msg({ type: AUTH_GRANT, creds: {} }, opener)); // empty — ignored, keeps waiting
    const newTok = jwt({ email: 'z@z.com', exp: Math.floor(Date.now() / 1000) + 3600 });
    window.dispatchEvent(msg({ type: AUTH_GRANT, creds: { oauth_id_token: newTok } }, opener));
    await expect(p).resolves.toBe(true);
    expect(app.token).toBe(newTok);
  });
  it('resolves false when the request times out', async () => {
    const app = createApp(appEnv({ handoffMs: 5 }));
    await expect(app.receiveAuthHandoff({ opener: { postMessage: vi.fn() } })).resolves.toBe(false);
  });
});
