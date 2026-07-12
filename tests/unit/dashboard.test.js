import { describe, it, expect, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import {
  isDashboardRoute, configBase,
  normalizeDashLayout, normalizeDashCols, DASH_TILE_ROW_CAP, DASH_TILE_BYTE_CAP, DASH_TABLE_DISPLAY_CAP,
  activeDashboardView, dashboardViewSelection,
} from '../../src/core/dashboard.js';
import { CHART_ROW_CAPS } from '../../src/core/chart-data.js';
import {
  AUTH_SS_KEYS, AUTH_REQUEST, AUTH_GRANT,
  snapshotAuth, restoreAuth, hasAuth, isAuthRequest, isAuthGrant,
} from '../../src/core/auth-handoff.js';
import { renderDashboard } from '../../src/ui/dashboard.js';
import { applyStreamLine } from '../../src/core/stream.js';
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

// (dashboardTileSql + parseJsonResult were retired in #193 — the tiles stream
// through the shared app.runReadInto seam, so SQL prep is now just the shared
// materialization (#165) and the client row bound is newResult's trim + `capped`
// flag. The tile↔seam wiring is covered under `renderDashboard` below.)

describe('DASH_TILE_ROW_CAP', () => {
  // The invariant the constant's docstring states, enforced: a fetch cap below
  // any chart display cap would silently truncate dashboard charts relative to
  // the workbench. Bumping CHART_ROW_CAPS must be a deliberate two-file edit.
  it('covers every chart display cap (no silent chart starvation)', () => {
    expect(DASH_TILE_ROW_CAP).toBeGreaterThanOrEqual(Math.max(...Object.values(CHART_ROW_CAPS)));
  });
});

describe('normalizeDashLayout', () => {
  it('passes through known modes (incl. wide, #184), defaults everything else to arrange', () => {
    expect(normalizeDashLayout('arrange')).toBe('arrange');
    expect(normalizeDashLayout('report')).toBe('report');
    expect(normalizeDashLayout('wide')).toBe('wide');
    expect(normalizeDashLayout('grid')).toBe('arrange');
    expect(normalizeDashLayout(undefined)).toBe('arrange');
  });
});

describe('activeDashboardView (#184)', () => {
  it('maps wide/report straight through and splits arrange by column count', () => {
    expect(activeDashboardView({ dashLayout: 'wide', dashCols: 3 })).toBe('wide');
    expect(activeDashboardView({ dashLayout: 'report', dashCols: 3 })).toBe('report');
    expect(activeDashboardView({ dashLayout: 'arrange', dashCols: 2 })).toBe('columns-2');
    expect(activeDashboardView({ dashLayout: 'arrange', dashCols: 3 })).toBe('columns-3');
  });
});

describe('dashboardViewSelection (#184)', () => {
  it('is the inverse of activeDashboardView, omitting dashCols for the single-column views', () => {
    expect(dashboardViewSelection('wide')).toEqual({ dashLayout: 'wide' });
    expect(dashboardViewSelection('report')).toEqual({ dashLayout: 'report' });
    expect(dashboardViewSelection('columns-2')).toEqual({ dashLayout: 'arrange', dashCols: 2 });
    expect(dashboardViewSelection('columns-3')).toEqual({ dashLayout: 'arrange', dashCols: 3 });
    expect(dashboardViewSelection('nonsense')).toEqual({ dashLayout: 'arrange', dashCols: 3 });
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

// Bridge the legacy tile-outcome fixtures onto the streaming `app.runReadInto`
// seam (#193): `spy(sql, param_* args)` returns the logical tile outcome
// ({columns, rows, meta} | {error, cancelled}); `streamInto` folds it into the
// caller-owned result exactly as ClickHouse's JSONStrings…Progress stream would
// (columns, rows, progress bytes, and the `capped` flag from meta.truncated),
// then fires onChunk once. Keeping the spy's (sql, params) signature lets the
// existing call-count/arg assertions ride unchanged — only the param_* subset
// reaches the spy (the seam's readonly:2 / max_result_bytes / rowLimit are
// asserted separately, on the runReadInto opts). Returns the runReadInto mock.
function streamInto(spy) {
  return vi.fn(async (result, opts = {}) => {
    const params = opts.params || {};
    const paramArgs = Object.fromEntries(Object.entries(params).filter(([k]) => k.startsWith('param_')));
    const out = await spy(opts.sql, paramArgs);
    if (out.error != null) { result.error = out.error; return result; }
    if (out.cancelled) { result.cancelled = true; return result; }
    result.columns = out.columns || [];
    result.rows = (out.rows || []).slice();
    result.progress = { ...result.progress, rows: result.rows.length, bytes: (out.meta && out.meta.bytes) || 0 };
    result.capped = !!(out.meta && out.meta.truncated);
    if (opts.onChunk) opts.onChunk();
    return result;
  });
}

// Build a dashboard app whose tiles run through the seam via `streamInto`. The
// `runTile` spy is exposed as `app.tileSpy` for the few call-count assertions
// that referenced the old `app.runTile`.
function dashApp(favorites, runTile) {
  const app = makeApp({ runReadInto: streamInto(runTile) });
  app.tileSpy = runTile;
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

  it('the footer always shows rows · ms · bytes on the streaming seam (#193: wall-clock ms + progress bytes)', async () => {
    // Unlike the old FORMAT-JSON path (which omitted stats CH did not report),
    // the streaming seam always has a wall-clock ms and a progress byte count
    // (0 when none streamed), so the footer row is unconditional — three spans.
    const app = dashApp([{ id: '1', name: 'Q', sql: 'q', favorite: true }],
      vi.fn(async () => chartResult({ rows: 2, bytes: 0 })));
    await renderDashboard(app);
    const foot = app.root.querySelector('.dash-tile-foot');
    expect(foot.children.length).toBe(3);
    expect(foot.textContent).toContain('0 ms');
    expect(foot.textContent).toContain('scanned');
  });

  it('a fetch-truncated tile gets the honest "first N rows fetched" footer note (#149 D9)', async () => {
    const app = dashApp([{ id: '1', name: 'Q', sql: 'q', favorite: true }],
      vi.fn(async () => chartResult({ rows: 5000, ms: 5, bytes: 100, truncated: true })));
    await renderDashboard(app);
    expect(app.root.querySelector('.dash-tile-foot').textContent)
      .toContain('first ' + DASH_TILE_ROW_CAP.toLocaleString() + ' rows fetched — sorting/charts cover this prefix only');
  });

  it('has a theme toggle wired to app.toggleTheme', async () => {
    const toggleTheme = vi.fn();
    const app = makeApp({ runReadInto: streamInto(vi.fn(async () => chartResult())), toggleTheme });
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
      runReadInto: streamInto(vi.fn(async () => chartResult())),
      ensureFreshToken: vi.fn(async () => false),
      chCtx: { onSignedOut },
    });
    app.state.savedQueries = [
      { id: '1', name: 'Q', sql: 'q', favorite: true },
      { id: '2', name: 'R', sql: 'r', favorite: true },
    ];
    await renderDashboard(app);
    expect(onSignedOut).toHaveBeenCalledTimes(1); // one redirect, not one per tile
    expect(app.runReadInto).not.toHaveBeenCalled();
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

  // ── #184: one four-way layout switcher (Full width | Report | 2/3 columns) ───
  const oneFav = () => dashApp([{ id: '1', name: 'Q', sql: 'q', favorite: true }], vi.fn(async () => chartResult()));
  const seg = (root, label) =>
    [...root.querySelectorAll('.dash-seg-layout .dash-seg-btn')].find((b) => b.textContent === label);
  const layoutBtns = (root) => [...root.querySelectorAll('.dash-seg-layout .dash-seg-btn')];

  it('renders exactly four layout buttons, an accessible group label, and no separate Columns control', async () => {
    const app = oneFav();
    await renderDashboard(app);
    expect(layoutBtns(app.root).map((b) => b.textContent))
      .toEqual(['Full width', 'Report', '2 columns', '3 columns']);
    expect(app.root.querySelector('.dash-seg-layout').getAttribute('aria-label')).toBe('Dashboard layout');
    // The old right-aligned Columns control is gone entirely.
    expect(app.root.querySelector('.dash-cols-wrap')).toBeNull();
    expect(app.root.querySelector('.dash-seg-cols')).toBeNull();
    expect([...app.root.querySelectorAll('.dash-seg-label')].map((s) => s.textContent)).toEqual(['Layout']);
  });

  it('exactly one button is active/aria-pressed at a time', async () => {
    const app = oneFav();
    await renderDashboard(app);
    const pressed = () => layoutBtns(app.root).filter((b) => b.getAttribute('aria-pressed') === 'true');
    expect(pressed().map((b) => b.textContent)).toEqual(['3 columns']); // default arrange + 3 cols
    seg(app.root, 'Full width').dispatchEvent(new Event('click', { bubbles: true }));
    expect(pressed().map((b) => b.textContent)).toEqual(['Full width']);
    expect(layoutBtns(app.root).filter((b) => b.classList.contains('is-active'))).toHaveLength(1);
  });

  it('activates 2 columns / 3 columns from the persisted arrange + dashCols state', async () => {
    const app2 = oneFav();
    app2.state.dashLayout = 'arrange';
    app2.state.dashCols = 2;
    await renderDashboard(app2);
    expect(seg(app2.root, '2 columns').getAttribute('aria-pressed')).toBe('true');

    const app3 = oneFav();
    app3.state.dashLayout = 'arrange';
    app3.state.dashCols = 3;
    await renderDashboard(app3);
    expect(seg(app3.root, '3 columns').getAttribute('aria-pressed')).toBe('true');
  });

  it('reflects a persisted wide/report layout on first render', async () => {
    const appW = oneFav();
    appW.state.dashLayout = 'wide';
    await renderDashboard(appW);
    expect(appW.root.querySelector('.dash-grid').classList.contains('is-wide')).toBe(true);
    expect(seg(appW.root, 'Full width').getAttribute('aria-pressed')).toBe('true');

    const appR = oneFav();
    appR.state.dashLayout = 'report';
    await renderDashboard(appR);
    expect(appR.root.querySelector('.dash-grid').classList.contains('is-report')).toBe(true);
    expect(seg(appR.root, 'Report').getAttribute('aria-pressed')).toBe('true');
  });

  it('Full width stores dashLayout=wide and toggles is-wide (only that key persists)', async () => {
    const app = oneFav();
    await renderDashboard(app);
    seg(app.root, 'Full width').dispatchEvent(new Event('click', { bubbles: true }));
    const grid = app.root.querySelector('.dash-grid');
    expect(grid.classList.contains('is-wide')).toBe(true);
    expect(grid.classList.contains('is-report')).toBe(false);
    expect(app.state.dashLayout).toBe('wide');
    expect(app.savePref).toHaveBeenCalledWith('dashLayout', 'wide');
    expect(app.savePref).not.toHaveBeenCalledWith('dashCols', expect.anything());
  });

  it('Report stores dashLayout=report and toggles is-report', async () => {
    const app = oneFav();
    await renderDashboard(app);
    seg(app.root, 'Report').dispatchEvent(new Event('click', { bubbles: true }));
    const grid = app.root.querySelector('.dash-grid');
    expect(grid.classList.contains('is-report')).toBe(true);
    expect(app.state.dashLayout).toBe('report');
    expect(app.savePref).toHaveBeenCalledWith('dashLayout', 'report');
  });

  it('2 columns stores dashLayout=arrange + dashCols=2 (persisting both when both change)', async () => {
    const app = oneFav();
    app.state.dashLayout = 'wide'; // start off-arrange so both keys change
    await renderDashboard(app);
    seg(app.root, '2 columns').dispatchEvent(new Event('click', { bubbles: true }));
    const grid = app.root.querySelector('.dash-grid');
    expect(grid.classList.contains('is-wide')).toBe(false);
    expect(grid.style.getPropertyValue('--dash-cols')).toBe('2');
    expect(app.state.dashLayout).toBe('arrange');
    expect(app.state.dashCols).toBe(2);
    expect(app.savePref).toHaveBeenCalledWith('dashLayout', 'arrange');
    expect(app.savePref).toHaveBeenCalledWith('dashCols', 2);
  });

  it('3 columns stores dashLayout=arrange + dashCols=3', async () => {
    const app = oneFav();
    app.state.dashLayout = 'wide';
    app.state.dashCols = 2; // start at 2 so the dashCols save path runs
    await renderDashboard(app);
    seg(app.root, '3 columns').dispatchEvent(new Event('click', { bubbles: true }));
    expect(app.state.dashLayout).toBe('arrange');
    expect(app.state.dashCols).toBe(3);
    expect(app.savePref).toHaveBeenCalledWith('dashLayout', 'arrange');
    expect(app.savePref).toHaveBeenCalledWith('dashCols', 3);
  });

  it('picking the same column count keeps dashLayout untouched (only dashCols persists)', async () => {
    const app = oneFav(); // default arrange + 3
    await renderDashboard(app);
    seg(app.root, '2 columns').dispatchEvent(new Event('click', { bubbles: true }));
    expect(app.savePref).toHaveBeenCalledWith('dashCols', 2);
    expect(app.savePref).not.toHaveBeenCalledWith('dashLayout', expect.anything());
  });

  it('clicking the already-active view is a no-op (no persist)', async () => {
    const app = oneFav(); // default arrange + 3 → "3 columns" active
    await renderDashboard(app);
    seg(app.root, '3 columns').dispatchEvent(new Event('click', { bubbles: true }));
    expect(app.savePref).not.toHaveBeenCalled();
  });

  it('changing layout never re-runs tile queries', async () => {
    const app = oneFav();
    await renderDashboard(app);
    expect(app.runReadInto).toHaveBeenCalledTimes(1); // the initial render
    seg(app.root, 'Full width').dispatchEvent(new Event('click', { bubbles: true }));
    seg(app.root, 'Report').dispatchEvent(new Event('click', { bubbles: true }));
    seg(app.root, '2 columns').dispatchEvent(new Event('click', { bubbles: true }));
    expect(app.runReadInto).toHaveBeenCalledTimes(1); // presentation-only — no refetch
  });
});

// ── #193: tiles on the shared streaming app.runReadInto seam ─────────────────
describe('renderDashboard — streaming seam (#193)', () => {
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  const yearInput = (root) => root.querySelector('.var-field input[aria-label="year"]');
  const commit = (input, value) => {
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  };
  const paramFav = (id, table = id) => ({ id, name: id, sql: `SELECT * FROM ${table} WHERE y = {year:UInt16}`, favorite: true });

  it('streams read-only with the row-cap split, readonly/byte caps, param args, and a signal (req 1/3)', async () => {
    const app = dashApp([{ id: '1', name: 'Q', sql: 'SELECT {year:UInt16} AS n', favorite: true }],
      vi.fn(async () => chartResult()));
    app.state.varValues = { year: '2024' };
    await renderDashboard(app);
    expect(app.runReadInto).toHaveBeenCalledTimes(1);
    const [result, opts] = app.runReadInto.mock.calls[0];
    expect(opts.format).toBe('Table');
    expect(opts.rowLimit).toBe(DASH_TILE_ROW_CAP + 1); // server max_result_rows = CAP + 1 (sentinel)
    expect(result.rowLimit).toBe(DASH_TILE_ROW_CAP); // client-side trim = CAP
    expect(opts.params).toMatchObject({ readonly: 2, max_result_bytes: DASH_TILE_BYTE_CAP, param_year: '2024' });
    expect(opts.signal).toBeTruthy(); // an AbortController signal → real per-tile cancellation
  });

  it('exactly-CAP is not truncated; CAP+1 is trimmed AND flagged (req 1, via the real applyStreamLine)', async () => {
    // Stream N single-column rows through the REAL accumulator so the client cap
    // (newResult('Table', CAP)) trims + flags exactly as production would.
    const streamN = (n) => vi.fn(async (result, opts) => {
      applyStreamLine({ meta: [{ name: 'n', type: 'UInt64' }] }, result);
      for (let i = 0; i < n; i++) applyStreamLine({ row: { n: i } }, result);
      applyStreamLine({ progress: { read_rows: n, read_bytes: 10 } }, result);
      opts.onChunk();
      return result;
    });
    const fav = [{ id: '1', name: 'Q', sql: 'q', favorite: true, panel: { cfg: { type: 'table' } } }];

    const exact = makeApp({ runReadInto: streamN(DASH_TILE_ROW_CAP) });
    exact.state.savedQueries = fav;
    await renderDashboard(exact);
    expect(exact.root.querySelector('.dash-tile-foot').textContent).not.toContain('rows fetched');

    const over = makeApp({ runReadInto: streamN(DASH_TILE_ROW_CAP + 1) });
    over.state.savedQueries = fav;
    await renderDashboard(over);
    const foot = over.root.querySelector('.dash-tile-foot').textContent;
    expect(foot).toContain('first ' + DASH_TILE_ROW_CAP.toLocaleString() + ' rows fetched');
    expect(foot).toContain(DASH_TILE_ROW_CAP.toLocaleString() + ' rows'); // rows SHOWN = trimmed CAP, not CAP+1
  });

  it('updates only the loading placeholder as rows stream — never classifies mid-stream (req 4)', async () => {
    const runReadInto = vi.fn((result, opts) => {
      applyStreamLine({ meta: [{ name: 'k', type: 'String' }, { name: 'v', type: 'UInt64' }] }, result);
      applyStreamLine({ row: { k: 'a', v: '1' } }, result);
      applyStreamLine({ progress: { read_rows: 1420, read_bytes: 10 } }, result);
      opts.onChunk(); // mid-stream repaint
      return new Promise(() => {}); // never settles — stay in the loading state
    });
    const app = makeApp({ runReadInto });
    app.state.savedQueries = [{ id: '1', name: 'Q', sql: 'q', favorite: true }];
    renderDashboard(app);
    await flush();
    const load = app.root.querySelector('.dash-tile-load');
    expect(load).not.toBeNull();
    expect(load.textContent).toBe('Loading… 1.4K rows'); // progress row count (formatRows compact), placeholder only
    expect(app.root.querySelector('.dash-tile canvas')).toBeNull(); // NOT classified/charted yet
    expect(app.root.querySelector('.dash-tile-foot').textContent).toBe(''); // no footer mid-stream
  });

  it('rejects an explicit FORMAT clause with a clear error and issues no request (req 5)', async () => {
    const spy = vi.fn(async () => chartResult());
    const app = dashApp([{ id: '1', name: 'Q', sql: 'SELECT 1 FORMAT JSON', favorite: true }], spy);
    await renderDashboard(app);
    expect(app.root.querySelector('.dash-tile-error').textContent)
      .toContain('Remove the explicit FORMAT clause');
    expect(app.runReadInto).not.toHaveBeenCalled(); // never mis-parsed as a structured stream
  });

  it('full Refresh performs exactly one token preflight before fanning out (req 2)', async () => {
    const app = dashApp([
      { id: '1', name: 'A', sql: 'a', favorite: true },
      { id: '2', name: 'B', sql: 'b', favorite: true },
    ], vi.fn(async () => chartResult()));
    await renderDashboard(app);
    expect(app.ensureFreshToken).toHaveBeenCalledTimes(1); // once for the whole wave, not per tile
  });

  it('an affected-filter wave preflights once; a failed preflight issues no requests and signs out (req 2)', async () => {
    const app = dashApp([paramFav('1', 't')], vi.fn(async () => chartResult()));
    app.state.varValues = { year: '1' };
    await renderDashboard(app);
    expect(app.ensureFreshToken).toHaveBeenCalledTimes(1); // the initial refresh
    app.runReadInto.mockClear();
    app.ensureFreshToken.mockResolvedValue(false); // session lost before the affected wave
    commit(yearInput(app.root), '2');
    await flush();
    expect(app.ensureFreshToken).toHaveBeenCalledTimes(2); // one preflight for the affected wave
    expect(app.chCtx.onSignedOut).toHaveBeenCalledTimes(1);
    expect(app.runReadInto).not.toHaveBeenCalled(); // failed preflight → no tile requests
  });

  it('a newer wave aborts the previous slot request at wave creation (generation reserved up front, req 3/5)', async () => {
    const signals = [];
    const resolvers = [];
    const runReadInto = vi.fn((result, opts) => {
      signals.push(opts.signal);
      return new Promise((res) => resolvers.push(() => { result.columns = [{ name: 'k', type: 'String' }]; result.rows = [['a']]; res(result); }));
    });
    const app = makeApp({ runReadInto });
    app.state.savedQueries = [paramFav('1', 't')];
    app.state.varValues = { year: '1' };
    const rendered = renderDashboard(app);
    await flush();
    expect(signals).toHaveLength(1);
    resolvers.splice(0).forEach((r) => r());
    await rendered;
    const input = yearInput(app.root);
    commit(input, '11'); // wave A
    await flush();
    expect(signals).toHaveLength(2);
    commit(input, '22'); // wave B — created before A's request settled
    await flush();
    expect(signals).toHaveLength(3);
    expect(signals[1].aborted).toBe(true); // A superseded at B's CREATION, before A resolved
    expect(signals[2].aborted).toBe(false);
    resolvers.splice(0).forEach((r) => r()); // drain (both A and B) — no throw
    await flush();
  });

  it('a queued Refresh worker superseded by a newer wave discards itself without issuing (req 3/5/7)', async () => {
    const calls = [];
    const resolvers = [];
    const runReadInto = vi.fn((result, opts) => {
      calls.push(opts.params.param_year);
      return new Promise((res) => resolvers.push(() => { result.columns = [{ name: 'k', type: 'String' }]; result.rows = [['a']]; res(result); }));
    });
    const app = makeApp({ runReadInto });
    app.state.savedQueries = Array.from({ length: 8 }, (_, i) => paramFav(String(i), 't' + i));
    app.state.varValues = { year: '1' };
    const rendered = renderDashboard(app); // wave A (full Refresh)
    await flush();
    expect(calls.filter((v) => v === '1')).toHaveLength(6); // TILE_CONCURRENCY: 6 in flight, 2 queued
    // Wave B (a filter change) supersedes every slot at CREATION — before A's
    // queued workers ever reach tiles 6 & 7.
    commit(yearInput(app.root), '2');
    await flush();
    expect(calls.filter((v) => v === '2')).toHaveLength(6); // B fans out its own 6
    // Drain everything; A's two queued workers dequeue AFTER B superseded them,
    // see the stale generation, and discard WITHOUT issuing a year=1 request.
    while (resolvers.length) { resolvers.splice(0).forEach((r) => r()); await flush(); }
    await rendered;
    expect(calls.filter((v) => v === '1')).toHaveLength(6); // A never issued the 2 queued
    expect(calls.filter((v) => v === '2')).toHaveLength(8); // B issued all 8
  });

  it('an affected wave is bounded to the same 6-way pool as full Refresh (req 7)', async () => {
    const resolvers = [];
    const runReadInto = vi.fn((result, opts) => new Promise((res) => resolvers.push(() => { result.columns = [{ name: 'k', type: 'String' }]; result.rows = [['a']]; res(result); })));
    const app = makeApp({ runReadInto });
    app.state.savedQueries = Array.from({ length: 8 }, (_, i) => paramFav(String(i), 't' + i));
    app.state.varValues = { year: '1' };
    const rendered = renderDashboard(app);
    await flush();
    expect(resolvers).toHaveLength(6); // initial full refresh caps at 6
    while (resolvers.length) { resolvers.splice(0).forEach((r) => r()); await flush(); }
    await rendered;
    const before = runReadInto.mock.calls.length; // 8
    commit(yearInput(app.root), '2');
    await flush();
    expect(runReadInto.mock.calls.length - before).toBe(6); // the affected wave also caps at 6 concurrent
    // …but every affected tile shows the loading placeholder up front (not just
    // the 6 in flight) — no queued tile lingers on stale content while waiting.
    expect(app.root.querySelectorAll('.dash-tile-load')).toHaveLength(8);
    while (resolvers.length) { resolvers.splice(0).forEach((r) => r()); await flush(); }
  });

  it('a stale (superseded) response neither renders nor records recents (req 6)', async () => {
    const resolvers = [];
    const runReadInto = vi.fn((result, opts) => new Promise((res) => resolvers.push((out) => {
      Object.assign(result, out);
      res(result);
    })));
    const app = makeApp({ runReadInto });
    app.state.savedQueries = [paramFav('1', 't')];
    app.state.varValues = { year: '1' };
    const rendered = renderDashboard(app);
    await flush();
    // ≥2 rows so the tile renders a table (a 1-row unconfigured result is a KPI skip).
    resolvers.splice(0).forEach((r) => r({ columns: [{ name: 'k', type: 'String' }], rows: [['a'], ['a2']] }));
    await rendered;
    app.recordBoundParams.mockClear();
    const input = yearInput(app.root);
    commit(input, '11'); // wave A (superseded below)
    await flush();
    commit(input, '22'); // wave B supersedes A
    await flush();
    // B resolves first (current), then the stale A resolves late.
    resolvers[1]({ columns: [{ name: 'k', type: 'String' }], rows: [['B'], ['B2']] });
    await flush();
    resolvers[0]({ columns: [{ name: 'k', type: 'String' }], rows: [['A-stale'], ['A2']] });
    await flush();
    expect(app.root.querySelector('.dash-tile').textContent).toContain('B'); // B rendered
    expect(app.root.querySelector('.dash-tile').textContent).not.toContain('A-stale');
    expect(app.recordBoundParams).toHaveBeenCalledTimes(1); // only B recorded; the stale A did not
  });

  it('never touches workbench run state — tiles own their own results (req: isolation)', async () => {
    const app = dashApp([{ id: '1', name: 'Q', sql: 'q', favorite: true }], vi.fn(async () => chartResult()));
    await renderDashboard(app);
    expect(app.state.running.value).toBe(false); // dashboard tiles never flip the workbench run signal
    expect(app.activeTab().result).toBeFalsy(); // no active-tab result written
  });
});

// ── D3: global filter bar ────────────────────────────────────────────────────
// ── #166: panel tiles — table/logs/text, partition before execution ─────────
describe('renderDashboard — panel tiles (#166, absorbs #164 D9)', () => {
  const tableResult = (meta = { rows: 2, ms: 5, bytes: 100, truncated: false }) => ({
    columns: [{ name: 'a', type: 'String' }, { name: 'b', type: 'String' }],
    rows: [['x', 'y2'], ['z', 'y1']], meta,
  });
  const logsResult = () => ({
    columns: [
      { name: 'event_time', type: 'DateTime' },
      { name: 'level', type: 'String' },
      { name: 'message', type: 'String' },
    ],
    rows: [['2026-01-01 00:00:00', 'Error', 'boom'], ['2026-01-01 00:00:01', 'Info', 'ok']],
    meta: { rows: 2, ms: 5, bytes: 100, truncated: false },
  });
  const emptyResult = () => ({
    columns: [{ name: 'a', type: 'String' }], rows: [],
    meta: { rows: 0, ms: 1, bytes: 10, truncated: false },
  });
  const oneFav = (runTile, over = {}) =>
    dashApp([{ id: '1', name: 'T', sql: 't', favorite: true, ...over }], runTile);
  const firstCell = (root) => root.querySelector('.res-table tbody tr .cell');

  it('renders a non-chartable favorite as a grid table tile (not skipped), with footer stats', async () => {
    const app = oneFav(vi.fn(async () => tableResult()));
    await renderDashboard(app);
    const tile = app.root.querySelector('.dash-tile');
    expect(tile.style.display).not.toBe('none');
    expect(tile.querySelector('.res-table-wrap')).not.toBeNull();
    expect(tile.querySelector('canvas')).toBeNull();
    expect(app.root.querySelector('.dash-skip').style.display).toBe('none'); // a table tile is not a skip
    expect(app.root.querySelector('.dash-tile-foot').textContent).toContain('2 rows');
  });

  it('an explicit table panel renders a plain grid even for a chartable favorite', async () => {
    const app = oneFav(vi.fn(async () => chartResult()), { panel: { cfg: { type: 'table' } } });
    await renderDashboard(app);
    expect(app.root.querySelector('.dash-tile .res-table-wrap')).not.toBeNull();
    expect(app.root.querySelector('.dash-tile canvas')).toBeNull();
  });

  it('an explicit chart panel with a stale key still renders (rederived note, not a fallback)', async () => {
    const app = oneFav(vi.fn(async () => chartResult()),
      { panel: { cfg: { type: 'pie', x: 0, y: [1], series: null }, key: 'STALE' } });
    await renderDashboard(app);
    expect(app.root.querySelector('.dash-tile canvas')).not.toBeNull();
    expect(app.root.querySelector('.panel-note').textContent).toContain('re-detected');
  });

  it('a header click sorts locally — no re-query — and a cell click is a harmless no-op', async () => {
    const runTile = vi.fn(async () => tableResult());
    const app = oneFav(runTile);
    await renderDashboard(app);
    expect(firstCell(app.root).textContent).toBe('x'); // query order (unsorted)
    const thB = app.root.querySelectorAll('.res-table th')[2]; // [0] is '#'
    thB.dispatchEvent(new Event('click', { bubbles: true }));
    expect(firstCell(app.root).textContent).toBe('z'); // ascending by b: y1 first
    expect(app.root.querySelector('.res-table .h-sort')).not.toBeNull();
    app.root.querySelectorAll('.res-table th')[2]
      .dispatchEvent(new Event('click', { bubbles: true })); // re-rendered th → desc
    expect(firstCell(app.root).textContent).toBe('x');
    expect(() => firstCell(app.root).dispatchEvent(new Event('click', { bubbles: true }))).not.toThrow();
    expect(runTile).toHaveBeenCalledTimes(1); // sort + cell clicks never re-ran the query
  });

  it('sort survives a Refresh with the same schema; grid state resets when the schema changes', async () => {
    const runTile = vi.fn(async () => tableResult());
    const app = oneFav(runTile);
    await renderDashboard(app);
    app.root.querySelectorAll('.res-table th')[2].dispatchEvent(new Event('click', { bubbles: true }));
    expect(firstCell(app.root).textContent).toBe('z');
    await app.root.querySelector('.dash-btn').onclick();
    expect(firstCell(app.root).textContent).toBe('z'); // sort kept across the re-run
    expect(app.root.querySelector('.res-table .h-sort')).not.toBeNull();
    runTile.mockImplementation(async () => ({
      columns: [{ name: 'c', type: 'String' }, { name: 'd', type: 'String' }],
      rows: [['m', 'n'], ['o', 'p']], meta: { rows: 2, ms: 1, bytes: 10, truncated: false },
    }));
    await app.root.querySelector('.dash-btn').onclick();
    expect(app.root.querySelector('.res-table .h-sort')).toBeNull(); // fresh sort state
  });

  it('a log-shaped favorite renders the logs view with per-level row classes', async () => {
    const app = oneFav(vi.fn(async () => logsResult()));
    await renderDashboard(app);
    const logs = app.root.querySelector('.dash-tile .dash-logs');
    expect(logs).not.toBeNull();
    expect(app.root.querySelector('.res-table-wrap')).toBeNull(); // logs mode, not the grid
    expect(logs.querySelectorAll('.log-row')).toHaveLength(2);
    expect(logs.querySelector('.log-row.log-error .log-msg').textContent).toBe('boom');
  });

  it('an explicit logs panel names roles by column name', async () => {
    const app = oneFav(vi.fn(async () => ({
      columns: [{ name: 'ts', type: 'DateTime' }, { name: 'note', type: 'String' }],
      rows: [['2026-01-01 00:00:00', 'hello']],
      meta: { rows: 1, ms: 1, bytes: 10, truncated: false },
    })), { panel: { cfg: { type: 'logs', msg: 'note' } } });
    await renderDashboard(app);
    expect(app.root.querySelector('.dash-logs .log-msg').textContent).toBe('hello');
  });

  it('a text favorite renders immediately with ZERO queries (partition before execution)', async () => {
    const runTile = vi.fn(async () => chartResult());
    const app = dashApp([
      { id: '1', name: 'Note', sql: '', favorite: true, panel: { cfg: { type: 'text', content: '# Team KPIs\n\nsee **docs**' } } },
      { id: '2', name: 'C', sql: 'chart', favorite: true },
    ], runTile);
    await renderDashboard(app);
    expect(runTile).toHaveBeenCalledTimes(1); // only the chart favorite ran SQL
    expect(runTile).not.toHaveBeenCalledWith('', expect.anything());
    const md = app.root.querySelector('.dash-tile .md-view');
    expect(md.querySelector('h1').textContent).toBe('Team KPIs');
    expect(md.querySelector('strong').textContent).toBe('docs');
    expect(app.root.querySelector('.dash-skip').style.display).toBe('none'); // text is shown, not skipped
  });

  it('ignores attached text-panel SQL during filter analysis and targeted reruns', async () => {
    const runTile = vi.fn(async () => chartResult());
    const app = dashApp([
      { id: '1', name: 'Note', sql: 'SELECT {region:String}', favorite: true,
        panel: { cfg: { type: 'text', content: 'static' } } },
      { id: '2', name: 'Chart', sql: 'SELECT {year:UInt16}', favorite: true },
    ], runTile);
    app.state.varValues = { year: '2024', region: 'us' };
    await renderDashboard(app);
    expect(runTile).toHaveBeenCalledTimes(1);
    expect(app.root.querySelector('.dash-filters').textContent).not.toContain('region');
    const year = [...app.root.querySelectorAll('.var-field')]
      .find((el) => el.textContent.includes('year')).querySelector('input');
    year.value = '2025';
    year.dispatchEvent(new Event('input', { bubbles: true }));
    year.dispatchEvent(new Event('change', { bubbles: true }));
    await Promise.resolve();
    expect(runTile.mock.calls.every((call) => !String(call[0]).includes('region'))).toBe(true);
  });

  it('explicit zero-row panels stay visible with a "0 rows" state; unconfigured empties skip', async () => {
    const runTile = vi.fn(async () => emptyResult());
    const app = dashApp([
      { id: '1', name: 'E1', sql: 'a', favorite: true, panel: { cfg: { type: 'table' } } },
      { id: '2', name: 'E2', sql: 'b', favorite: true },
    ], runTile);
    await renderDashboard(app);
    const tiles = [...app.root.querySelectorAll('.dash-tile')];
    expect(tiles[0].style.display).not.toBe('none');
    expect(tiles[0].querySelector('.dash-tile-empty').textContent).toBe('0 rows');
    expect(tiles[1].style.display).toBe('none'); // unconfigured empty → still a skip
    expect(app.root.querySelector('.dash-skip').textContent).toBe('1 not shown');
  });

  it('an unknown panel type (newer build) falls back via autoPanel with a diagnostic', async () => {
    const app = oneFav(vi.fn(async () => chartResult()), { panel: { cfg: { type: 'gauge', max: 9 } } });
    await renderDashboard(app);
    expect(app.root.querySelector('.panel-note.is-fallback').textContent).toContain('gauge');
    expect(app.root.querySelector('.dash-tile canvas')).not.toBeNull(); // fell back to the auto chart
  });

  it('an explicit single-row table panel renders (only unconfigured single rows are KPI-skipped)', async () => {
    const app = oneFav(vi.fn(async () => kpiResult()), { panel: { cfg: { type: 'table' } } });
    await renderDashboard(app);
    expect(app.root.querySelector('.dash-tile').style.display).not.toBe('none');
    expect(app.root.querySelectorAll('.res-table tbody tr')).toHaveLength(1);
  });

  it('a tile that flips table → skip on Refresh clears its old grid DOM', async () => {
    const runTile = vi.fn(async () => tableResult());
    const app = oneFav(runTile);
    await renderDashboard(app);
    expect(app.root.querySelector('.res-table-wrap')).not.toBeNull();
    runTile.mockImplementation(async () => kpiResult()); // next refresh becomes a skip (KPI)
    await app.root.querySelector('.dash-btn').onclick();
    expect(app.root.querySelector('.dash-tile').style.display).toBe('none');
    expect(app.root.querySelector('.res-table-wrap')).toBeNull(); // stale grid DOM cleared, not just hidden
  });

  it('grid/logs tiles cap displayed rows at DASH_TABLE_DISPLAY_CAP with the in-body footer', async () => {
    const rows = Array.from({ length: DASH_TABLE_DISPLAY_CAP + 5 }, (_, i) => [String(i), 'y']);
    const app = oneFav(vi.fn(async () => ({
      columns: [{ name: 'a', type: 'String' }, { name: 'b', type: 'String' }],
      rows, meta: { rows: rows.length, ms: 1, bytes: 10, truncated: false },
    })));
    await renderDashboard(app);
    expect(app.root.querySelectorAll('.res-table tbody tr')).toHaveLength(DASH_TABLE_DISPLAY_CAP);
    expect(app.root.textContent).toContain('+ 5 more rows truncated for display');
  });
});

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
    // never reach the seam at all, short-circuiting this race).
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
      const app = makeApp({ runReadInto: streamInto(runTile), wallNow: vi.fn(() => 1751200000000) });
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

// ── app.js: dashboard render + auth handoff wiring ───────────────────────────
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
    body: opts.body,
    headers: { get: () => null },
  };
}
// A streaming response body (JSONStringsEachRowWithProgress lines), for the
// tile/run() path that reads resp.body.getReader() rather than resp.json().
function streamBody(lines) {
  let i = 0;
  return {
    getReader: () => ({
      read: async () => (i < lines.length ? { done: false, value: new TextEncoder().encode(lines[i++]) } : { done: true }),
      releaseLock: () => {},
    }),
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
  it('renders the favorites dashboard into the root — streaming the tile through the real seam (#193)', async () => {
    // End-to-end through createApp's real app.runReadInto → ch.runQuery → the
    // streaming JSONStringsEachRowWithProgress reader (not resp.json()), the
    // same transport run() and the detached view use.
    const fetch = makeFetch([[(u, sql) => /mychart/.test(sql || ''), resp({
      body: streamBody([
        '{"meta":[{"name":"k","type":"String"},{"name":"v","type":"UInt64"}]}\n',
        '{"row":{"k":"a","v":"1"}}\n',
        '{"row":{"k":"b","v":"2"}}\n',
      ]),
    })]]);
    const app = createApp(appEnv({ fetch }));
    app.state.savedQueries = [{ id: '1', name: 'Q', sql: 'SELECT k, v FROM mychart', favorite: true }];
    await app.renderDashboard();
    expect(app.root.querySelector('.dash-tile canvas')).not.toBeNull();
    // The read-only tile guard (readonly=2) + the row-cap sentinel reach the wire.
    expect(fetch.mock.calls.some((c) => /readonly=2/.test(c[0]))).toBe(true);
    expect(fetch.mock.calls.some((c) => /max_result_rows=5001/.test(c[0]))).toBe(true);
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
