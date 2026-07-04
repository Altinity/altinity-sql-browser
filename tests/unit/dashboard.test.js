import { describe, it, expect, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import {
  isDashboardRoute, configBase, dashboardTileSql, parseJsonResult, classifyTile,
  normalizeDashLayout, normalizeDashCols, dashboardParams,
} from '../../src/core/dashboard.js';
import {
  AUTH_SS_KEYS, AUTH_REQUEST, AUTH_GRANT,
  snapshotAuth, restoreAuth, hasAuth, isAuthRequest, isAuthGrant,
} from '../../src/core/auth-handoff.js';
import { renderDashboard } from '../../src/ui/dashboard.js';
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

describe('dashboardParams', () => {
  it('unions params across favorites, unique by name, first-appearance order', () => {
    const favorites = [
      { sql: 'SELECT * FROM t WHERE y = {year:UInt16}' },
      { sql: 'SELECT * FROM u WHERE y = {year:UInt16} AND r = {region:String}' },
    ];
    expect(dashboardParams(favorites)).toEqual([
      { name: 'year', type: 'UInt16' },
      { name: 'region', type: 'String' },
    ]);
  });
  it('ignores a param that only appears in a non-row-returning statement', () => {
    const favorites = [{ sql: "CREATE VIEW v AS SELECT {x:String}" }];
    expect(dashboardParams(favorites)).toEqual([]);
  });
  it('is defensive about an empty/absent favorites list', () => {
    expect(dashboardParams([])).toEqual([]);
    expect(dashboardParams(undefined)).toEqual([]);
  });
});

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

    const input = fieldInput(app.root, 'year');
    setInput(input, 'A');
    pressEnter(input);
    await flush();
    expect(resolvers).toHaveLength(2);
    setInput(input, 'B');
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
