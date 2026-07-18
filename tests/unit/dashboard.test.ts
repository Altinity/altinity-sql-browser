import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  isDashboardRoute, configBase,
  normalizeDashLayout, normalizeDashCols, DASH_TILE_ROW_CAP, DASH_TILE_BYTE_CAP, DASH_TABLE_DISPLAY_CAP,
  activeDashboardView, dashboardViewSelection, partitionKpiBands,
} from '../../src/core/dashboard.js';
import { KEYS } from '../../src/state.js';
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
import { savedQuery } from '../helpers/saved-query.js';
import type { SavedQueryFixture } from '../helpers/saved-query.js';
import type { App } from '../../src/ui/app.types.js';
import type { AppState } from '../../src/state.js';
import type { Column } from '../../src/core/panel-cfg.js';
import type { CreateAppEnv } from '../../src/env.types.js';
import type { ResolvedIdpConfig, ConfigDoc } from '../../src/net/oauth-config.js';

type FakeApp = ReturnType<typeof makeApp>;

/** `makeApp()` already satisfies `App` in full; this only adds the test-only
 * `tileSpy` extra `dashApp` attaches after construction. */
type TestApp = FakeApp & { tileSpy?: unknown; Chart: typeof FakeChart };

const qs = <T extends Element = HTMLElement>(root: ParentNode | null, selector: string): T =>
  (root as ParentNode).querySelector(selector) as T;
const qsa = <T extends Element = HTMLElement>(root: ParentNode | null, selector: string): T[] =>
  [...(root as ParentNode).querySelectorAll(selector)] as T[];
/** `el.onclick`'s DOM-lib type takes a `MouseEvent`; every `.dash-btn`
 * handler this suite exercises is a real zero-arg (often async) closure `ui/dashboard.ts`
 * assigns directly — narrower than the lib's declared signature (an assignable
 * direction, not a fixture gap), so calling through it needs no argument. */
const runOnclick = (el: HTMLElement | null): unknown => ((el as HTMLElement).onclick as (() => unknown) | null)?.();
/** `app.root` is typed `Element | null` (App.root) but is always a real,
 * attached div for every fixture this file builds. */
const rootEl = (app: App): HTMLElement => app.root as HTMLElement;

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
// through the shared app.exec.executeRead seam, so SQL prep is now just the shared
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

describe('partitionKpiBands (#240)', () => {
  it('returns one tile item per favorite when none are KPI', () => {
    expect(partitionKpiBands([false, false, false])).toEqual([
      { kind: 'tile', index: 0 }, { kind: 'tile', index: 1 }, { kind: 'tile', index: 2 },
    ]);
  });
  it('returns nothing for an empty list', () => {
    expect(partitionKpiBands([])).toEqual([]);
  });
  it('merges every favorite into one band when all are KPI', () => {
    expect(partitionKpiBands([true, true, true])).toEqual([{ kind: 'kpi-band', indices: [0, 1, 2] }]);
  });
  it('groups maximal consecutive KPI runs, leaving non-KPI favorites as single tiles', () => {
    // KPI, KPI, chart, KPI, text, KPI, KPI → band(2), tile, band(1), tile, band(2)
    const flags = [true, true, false, true, false, true, true];
    expect(partitionKpiBands(flags)).toEqual([
      { kind: 'kpi-band', indices: [0, 1] },
      { kind: 'tile', index: 2 },
      { kind: 'kpi-band', indices: [3] },
      { kind: 'tile', index: 4 },
      { kind: 'kpi-band', indices: [5, 6] },
    ]);
  });
  it('handles a KPI run at the very start and end', () => {
    expect(partitionKpiBands([true, false, true])).toEqual([
      { kind: 'kpi-band', indices: [0] },
      { kind: 'tile', index: 1 },
      { kind: 'kpi-band', indices: [2] },
    ]);
  });
});

// (dashboardParams moved into the parameter pipeline in #165 — the filter bar's
// field discovery is now `fieldControls(analysis)`, tested with the pipeline in
// param-pipeline.test.js and end-to-end in the filter-bar suite below.)

// ── core/auth-handoff.js ─────────────────────────────────────────────────────
/** A minimal sessionStorage-like stub — a real `Storage` structurally
 * (length/key/clear included), so it plugs straight into `env.sessionStorage`
 * (`CreateAppEnv`) with no cast. */
interface MemSession {
  getItem(k: string): string | null;
  setItem(k: string, v: unknown): void;
  removeItem(k: string): void;
  clear(): void;
  key(index: number): string | null;
  readonly length: number;
  _map: Map<string, string>;
  [k: string]: unknown;
}
function memSession(initial: Record<string, string> = {}): MemSession {
  const m = new Map(Object.entries(initial));
  return {
    getItem: (k) => (m.has(k) ? (m.get(k) as string) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    clear: () => m.clear(),
    key: (index) => [...m.keys()][index] ?? null,
    get length() { return m.size; },
    _map: m,
  };
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
  const ok = (type: string) => ({ origin: 'https://o', source: src, data: { type } });
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

// ── ui/dashboard.js (viewer-driven render, #286 — reads dashboard.tiles[]) ────
// The favorites-derived render was replaced by a DashboardViewerSession bound
// to the persisted StoredWorkspaceV1; these tests drive renderDashboard through
// a fake `loadDashboardWorkspace` (a controlled workspace) + a fake streaming
// `executeRead`, exactly as the app wires the real repository + exec seam.

type ExecuteReadResult = Parameters<App['exec']['executeRead']>[0];
type ExecuteReadOpts = Parameters<App['exec']['executeRead']>[1];

interface ExecResp {
  columns?: Column[];
  rows?: unknown[][];
  error?: string;
  bytes?: number;
  capped?: boolean;
}
type ExecResponder = (sql: string, params: Record<string, string>) => ExecResp | Promise<ExecResp>;

function makeExec(responder: ExecResponder = () => ({})) {
  const calls: { sql: string; params: Record<string, unknown>; format?: string }[] = [];
  const executeRead = vi.fn(async (result: ExecuteReadResult, opts: ExecuteReadOpts = {} as ExecuteReadOpts) => {
    const params = (opts.params ?? {}) as Record<string, string>;
    const paramArgs = Object.fromEntries(Object.entries(params).filter(([k]) => k.startsWith('param_')));
    calls.push({ sql: opts.sql as string, params, format: opts.format as string | undefined });
    const resp = (await responder(opts.sql as string, paramArgs)) || {};
    if (opts.onChunk) { result.progress = { ...result.progress, rows: 3 }; opts.onChunk(); }
    result.columns = resp.columns ?? [{ name: 'k', type: 'String' }, { name: 'v', type: 'UInt64' }];
    result.rows = resp.rows ?? [['a', 1], ['b', 2]];
    result.progress = { ...result.progress, bytes: resp.bytes ?? 10, rows: (resp.rows ?? [[]]).length };
    result.capped = !!resp.capped;
    result.error = resp.error ?? null;
    return result;
  });
  return { executeRead, calls };
}

const q = (id: string, sql: string, extra: Partial<SavedQueryFixture> = {}): SavedQueryFixture['id'] extends never ? never : ReturnType<typeof savedQuery> =>
  savedQuery({ id, name: id, sql, ...extra });

interface WsOver {
  id?: string;
  tiles?: { id: string; queryId: string }[];
  filters?: Record<string, unknown>[];
  layout?: Record<string, unknown>;
  queries?: ReturnType<typeof savedQuery>[];
  title?: string;
}
const wsWith = (over: WsOver = {}) => ({
  storageVersion: 1 as const, id: 'w', name: 'W',
  queries: over.queries ?? [],
  dashboard: {
    documentVersion: 1 as const, id: over.id ?? 'd', title: over.title ?? 'My Dash', revision: 1,
    layout: over.layout ?? { type: 'flow', version: 1, preset: 'columns-2', items: {} },
    filters: over.filters ?? [], tiles: over.tiles ?? [],
  },
});

function dashApp(opts: {
  workspace?: ReturnType<typeof wsWith> | null;
  responder?: ExecResponder;
  commit?: ReturnType<typeof vi.fn>;
  savedQueries?: ReturnType<typeof savedQuery>[];
} = {}) {
  const { executeRead, calls } = makeExec(opts.responder);
  const commit = opts.commit ?? vi.fn(async () => ({ ok: true, workspace: {} as never, dashboardRevision: 2 }));
  const app = makeApp({
    exec: { executeRead },
    workspace: { commit },
    loadDashboardWorkspace: async () => (opts.workspace === undefined ? null : opts.workspace) as never,
  }) as TestApp;
  if (opts.savedQueries) app.state.savedQueries = opts.savedQueries as AppState['savedQueries'];
  return { app, calls, commit };
}

const render = (app: TestApp): Promise<void> => renderDashboard(app as unknown as Parameters<typeof renderDashboard>[0]);
/** The flow preset switcher (2026-07-18: a `<select class="dash-layout-select">`
 *  in the header, replacing the old `.dash-seg-layout` button group). */
const layoutSelect = (root: ParentNode | null): HTMLSelectElement => qs<HTMLSelectElement>(root, '.dash-layout-select');
const pickLayout = (root: ParentNode | null, value: string): void => {
  const select = layoutSelect(root);
  select.value = value;
  select.dispatchEvent(new Event('change', { bubbles: true }));
};

describe('renderDashboard — read-flip to dashboard.tiles (#286)', () => {
  it('renders one tile per dashboard.tiles entry — independent of spec.favorite', async () => {
    // Neither query is favorited; both are tiles. Membership is dashboard.tiles.
    const { app, calls } = dashApp({
      workspace: wsWith({
        queries: [q('q1', 'SELECT k, v FROM a', { favorite: false }), q('q2', 'SELECT k, v FROM b', { favorite: false })],
        tiles: [{ id: 't1', queryId: 'q1' }, { id: 't2', queryId: 'q2' }],
      }),
    });
    await render(app);
    expect(qsa(app.root, '.dash-tile').length).toBe(2);
    expect(qs(app.root, '.dash-fav span:last-child')?.textContent).toBe('2 tiles');
    const sqls = calls.map((c) => c.sql);
    expect(sqls).toContain('SELECT k, v FROM a');
    expect(sqls).toContain('SELECT k, v FROM b');
    expect(qs(app.root, '.dash-title')?.textContent).toBe('My Dash');
    expect(qsa(app.root, '.dash-tile canvas').length).toBeGreaterThan(0);
  });

  it('shows the empty state for a dashboard with no tiles', async () => {
    const { app } = dashApp({ workspace: wsWith({ tiles: [] }) });
    await render(app);
    expect((qs(app.root, '.dash-empty') as HTMLElement).style.display).toBe('');
    expect(qs(app.root, '.dash-fav span:last-child')?.textContent).toBe('0 tiles');
  });

  it('falls back to an empty dashboard when no workspace resolves', async () => {
    const { app } = dashApp({ workspace: null, savedQueries: [q('q1', 'SELECT 1', { favorite: true })] });
    await render(app);
    expect(qsa(app.root, '.dash-tile').length).toBe(0);
    expect((qs(app.root, '.dash-empty') as HTMLElement).style.display).toBe('');
  });

  it('renders an error tile, an unfilled tile, and a fetch-truncated footer', async () => {
    const { app } = dashApp({
      responder: (sql) => (sql.includes('boom') ? { error: 'ch down' } : { capped: true }),
      workspace: wsWith({
        queries: [q('ok', 'SELECT k, v FROM t'), q('bad', 'SELECT boom'), q('need', 'SELECT {yr:UInt16}')],
        tiles: [{ id: 't1', queryId: 'ok' }, { id: 't2', queryId: 'bad' }, { id: 't3', queryId: 'need' }],
      }),
    });
    await render(app);
    expect(qs(app.root, '.dash-tile-error')?.textContent).toBe('ch down');
    expect(qs(app.root, '.dash-tile-unfilled')?.textContent).toContain('yr');
    expect(qsa(app.root, '.dash-tile-foot span').some((s) => /rows fetched/.test(s.textContent || ''))).toBe(true);
  });

  it('has a theme toggle wired to app.toggleTheme and shows the sun icon in dark mode', async () => {
    const { app } = dashApp({ workspace: wsWith({ tiles: [] }) });
    app.state.theme = 'dark';
    await render(app);
    const btn = qs(app.root, '.dash-icobtn');
    expect(btn).not.toBeNull();
    btn.dispatchEvent(new Event('click', { bubbles: true }));
    expect(app.toggleTheme).toHaveBeenCalled();
  });

  it('Refresh re-runs the tiles and re-paints without a schema reset', async () => {
    const { app, calls } = dashApp({
      workspace: wsWith({ queries: [q('q1', 'SELECT k, v FROM a')], tiles: [{ id: 't1', queryId: 'q1' }] }),
    });
    await render(app);
    const before = calls.length;
    await (runOnclick(qs(app.root, '.dash-refresh')) as Promise<void>);
    expect(calls.length).toBeGreaterThan(before);
    expect(qsa(app.root, '.dash-tile canvas').length).toBeGreaterThan(0);
  });

  it('signs out when the token preflight fails, running no tiles', async () => {
    const { app, calls } = dashApp({
      workspace: wsWith({ queries: [q('q1', 'SELECT 1')], tiles: [{ id: 't1', queryId: 'q1' }] }),
    });
    const onSignedOut = vi.fn();
    app.conn.ensureFreshToken = vi.fn(async () => false);
    app.conn.chCtx.onSignedOut = onSignedOut;
    await render(app);
    expect(onSignedOut).toHaveBeenCalled();
    expect(calls.length).toBe(0);
  });
});

describe('renderDashboard — flow layout + preset switcher (#280)', () => {
  it('packs tiles into the preset columns and switches preset via a change-layout command', async () => {
    const { app, commit } = dashApp({
      workspace: wsWith({
        queries: [q('q1', 'SELECT k, v FROM a'), q('q2', 'SELECT k, v FROM b')],
        tiles: [{ id: 't1', queryId: 'q1' }, { id: 't2', queryId: 'q2' }],
        layout: { type: 'flow', version: 1, preset: 'columns-2', items: {} },
      }),
    });
    await render(app);
    expect(layoutSelect(app.root).value).toBe('columns-2');
    const rows = qsa(app.root, '.dash-row');
    expect((rows[0].style as CSSStyleDeclaration).gridTemplateColumns).toContain('repeat(2');
    // Switch to full-width — one column.
    pickLayout(app.root, 'full-width');
    expect(layoutSelect(app.root).value).toBe('full-width');
    expect((qsa(app.root, '.dash-row')[0].style as CSSStyleDeclaration).gridTemplateColumns).toContain('repeat(1');
    expect(commit).toHaveBeenCalled();
  });

  it('defaults the preset to full-width when the layout omits it', async () => {
    const { app } = dashApp({
      workspace: wsWith({
        queries: [q('q1', 'SELECT k, v FROM a')],
        tiles: [{ id: 't1', queryId: 'q1' }],
        layout: { type: 'flow', version: 1 } as unknown as Record<string, unknown>,
      }),
    });
    await render(app);
    expect(layoutSelect(app.root).value).toBe('full-width');
    expect((qsa(app.root, '.dash-row')[0].style as CSSStyleDeclaration).gridTemplateColumns).toContain('repeat(1');
    expect(qsa(app.root, '.dash-tile').length).toBe(1);
  });

  it('normalizes to one column on the mobile breakpoint and restores on desktop', async () => {
    const { app } = dashApp({
      workspace: wsWith({
        queries: [q('q1', 'SELECT k, v FROM a'), q('q2', 'SELECT k, v FROM b')],
        tiles: [{ id: 't1', queryId: 'q1' }, { id: 't2', queryId: 'q2' }],
        layout: { type: 'flow', version: 1, preset: 'columns-2', items: { t1: { span: 2 } } },
      }),
    });
    app.state.isMobile.value = true;
    await render(app);
    for (const row of qsa(app.root, '.dash-row')) {
      expect((row.style as CSSStyleDeclaration).gridTemplateColumns).toContain('repeat(1');
    }
    // Flip back to desktop — the effect republishes and restores 2 columns.
    app.state.isMobile.value = false;
    await Promise.resolve();
    expect((qsa(app.root, '.dash-row')[0].style as CSSStyleDeclaration).gridTemplateColumns).toContain('repeat(2');
  });
});

describe('renderDashboard — reorder (drag only) + sort (#153/#280)', () => {
  const twoTiles = () => wsWith({
    queries: [q('q1', 'SELECT k, v FROM a'), q('q2', 'SELECT k, v FROM b')],
    tiles: [{ id: 't1', queryId: 'q1' }, { id: 't2', queryId: 'q2' }],
    layout: { type: 'flow', version: 1, preset: 'full-width', items: {} },
  });
  const order = (app: TestApp): string[] => qsa(app.root, '.dash-tile .dash-tile-name').map((n) => n.textContent || '');

  it('has no in-tile move / span / height chrome (owner override — drag only)', async () => {
    const { app } = dashApp({ workspace: twoTiles() });
    await render(app);
    expect(qsa(app.root, '.dash-tile-move').length).toBe(0);
    expect(qsa(app.root, '.dash-tile-span').length).toBe(0);
    expect(qsa(app.root, '.dash-tile-height').length).toBe(0);
  });

  it('pointer drag reorders tiles and persists the new dashboard.tiles[] order', async () => {
    const { app, commit } = dashApp({ workspace: twoTiles() });
    await render(app);
    expect(order(app)).toEqual(['q1', 'q2']);
    const cards = qsa(app.root, '.dash-tile');
    cards[1].dispatchEvent(new Event('dragstart', { bubbles: true }));
    cards[0].dispatchEvent(new Event('dragover', { bubbles: true }));
    cards[0].dispatchEvent(new Event('drop', { bubbles: true }));
    expect(order(app)).toEqual(['q2', 'q1']); // move-tile applied
    expect(commit).toHaveBeenCalled(); // new order persisted
    // A drop with no active drag is a harmless no-op.
    qsa(app.root, '.dash-tile')[0].dispatchEvent(new Event('drop', { bubbles: true }));
    expect(order(app)).toEqual(['q2', 'q1']);
  });

  it('a table header click re-sorts locally without re-querying', async () => {
    const { app, calls } = dashApp({
      responder: () => ({ columns: [{ name: 'k', type: 'String' }, { name: 'v', type: 'String' }], rows: [['x', '1'], ['z', '2']] }),
      workspace: wsWith({ queries: [q('q1', 'SELECT k, v FROM a', { panel: { cfg: { type: 'table' } } })], tiles: [{ id: 't1', queryId: 'q1' }] }),
    });
    await render(app);
    const before = calls.length;
    qsa(app.root, '.res-table th')[1].dispatchEvent(new Event('click', { bubbles: true }));
    expect(calls.length).toBe(before); // local re-paint (rerender → paintForce), no re-query
    expect(qs(app.root, '.res-table .h-sort')).not.toBeNull(); // sort applied locally
    // A value-cell click is a harmless no-op (onCell).
    qs(app.root, '.res-table tbody td.cell')?.dispatchEvent(new Event('click', { bubbles: true }));
    expect(calls.length).toBe(before);
  });

  it('drives the shared rich fields: relative-time preview (wallNow) and Clear recent', async () => {
    const { app } = dashApp({
      workspace: wsWith({
        queries: [q('q1', 'SELECT k, v FROM a WHERE s = {s:String} AND d > {d:Date}')],
        tiles: [{ id: 't1', queryId: 'q1' }],
      }),
    });
    app.state.varRecent = recordRecent(emptyRecentMap(), 's', 'foo');
    await render(app);
    const fieldFor = (name: string) => qsa(app.root, '.dash-filter-host .var-field')
      .find((f) => qs(f, '.var-name')?.textContent === name)!;
    // Type a relative value into the Date field so its preview reads the shim wallNow.
    const dInput = qs<HTMLInputElement>(fieldFor('d'), 'input');
    dInput.dispatchEvent(new Event('focus'));
    dInput.value = 'now-1h';
    dInput.dispatchEvent(new Event('input', { bubbles: true }));
    // Focus the recents (String) field and Clear recent → shim clearVarRecent.
    const sField = fieldFor('s');
    qs<HTMLInputElement>(sField, 'input').dispatchEvent(new Event('focus'));
    qs(sField, '.var-combo-footer button')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    expect(app.params.clearVarRecent).toHaveBeenCalledWith('s');
  });
});

describe('renderDashboard — KPI bands (#240)', () => {
  it('groups consecutive KPI tiles into one full-width band of cards', async () => {
    const { app } = dashApp({
      responder: () => ({ columns: [{ name: 'value', type: 'UInt64' }], rows: [[42]] }),
      workspace: wsWith({
        queries: [
          q('k1', 'SELECT 1 AS value', { panel: { cfg: { type: 'kpi' } } }),
          q('k2', 'SELECT 2 AS value', { panel: { cfg: { type: 'kpi' } } }),
        ],
        tiles: [{ id: 't1', queryId: 'k1' }, { id: 't2', queryId: 'k2' }],
      }),
    });
    await render(app);
    expect(qs(app.root, '.dash-kpi-band')).not.toBeNull();
    expect(qsa(app.root, '.dash-kpi-stream .kpi-card').length).toBe(2);
  });

  it('shows a KPI member state card for an errored or unfilled KPI source', async () => {
    const { app } = dashApp({
      responder: (sql) => (sql.includes('boom') ? { error: 'kpi down' } : { columns: [{ name: 'value', type: 'UInt64' }], rows: [[1]] }),
      workspace: wsWith({
        queries: [
          q('k1', 'SELECT boom AS value', { panel: { cfg: { type: 'kpi' } } }),
          q('k2', 'SELECT {p:String} AS value', { panel: { cfg: { type: 'kpi' } } }),
        ],
        tiles: [{ id: 't1', queryId: 'k1' }, { id: 't2', queryId: 'k2' }],
      }),
    });
    await render(app);
    const cards = qsa(app.root, '.dash-kpi-state-card').map((c) => c.textContent);
    expect(cards).toContain('kpi down');
    expect(cards.some((c) => /Enter a value/.test(c || ''))).toBe(true);
  });

  it('shows the KPI zero-data state card when a KPI source returns no rows', async () => {
    const { app } = dashApp({
      responder: () => ({ columns: [{ name: 'value', type: 'UInt64' }], rows: [] }),
      workspace: wsWith({ queries: [q('k1', 'SELECT value', { panel: { cfg: { type: 'kpi' } } })], tiles: [{ id: 't1', queryId: 'k1' }] }),
    });
    await render(app);
    expect(qs(app.root, '.dash-kpi-state-card')).not.toBeNull();
  });
});

// #291: the grafana-grid@1 layout engine — a rowless single CSS grid host,
// engine switching via the 5-option layout select, and Workbench-only edit
// interactions (drag-reorder reuses flow's existing pattern verbatim, so it
// is not re-tested here — corner-drag resize + delete are the new surfaces).
describe('renderDashboard — grafana-grid engine (#291)', () => {
  const twoTilesGrid = () => wsWith({
    queries: [q('q1', 'SELECT k, v FROM a'), q('q2', 'SELECT k, v FROM b')],
    tiles: [{ id: 't1', queryId: 'q1' }, { id: 't2', queryId: 'q2' }],
    layout: { type: 'grafana-grid', version: 1, items: { t1: { span: 4, height: 'compact' } } },
  });

  it('renders tiles through a single rowless grid host with span + height classes, no row wrappers', async () => {
    const { app } = dashApp({ workspace: twoTilesGrid() });
    await render(app);
    expect(qs(app.root, '.dash-gg-grid')).not.toBeNull();
    expect(qsa(app.root, '.dash-row').length).toBe(0); // rowless — no per-row wrappers, no KPI band
    const cards = qsa(app.root, '.dash-gg-tile');
    expect(cards.length).toBe(2);
    expect((cards[0].style as CSSStyleDeclaration).gridColumn).toBe('span 4');
    expect(cards[0].classList.contains('dash-gg-h-compact')).toBe(true);
    // No persisted placement for t2 → the grid default (span 6, medium).
    expect((cards[1].style as CSSStyleDeclaration).gridColumn).toBe('span 6');
    expect(cards[1].classList.contains('dash-gg-h-medium')).toBe(true);
    expect((qs(app.root, '.dash-gg-grid').style as CSSStyleDeclaration).gridTemplateColumns).toContain('repeat(12');
  });

  it('places a KPI tile inline (no band) in grid mode, still through the shared KPI card renderer', async () => {
    const { app } = dashApp({
      responder: () => ({ columns: [{ name: 'value', type: 'UInt64' }], rows: [[42]] }),
      workspace: wsWith({
        queries: [q('k1', 'SELECT 1 AS value', { panel: { cfg: { type: 'kpi' } } })],
        tiles: [{ id: 't1', queryId: 'k1' }],
        layout: { type: 'grafana-grid', version: 1, items: { t1: { span: 4 } } },
      }),
    });
    await render(app);
    expect(qs(app.root, '.dash-kpi-band')).toBeNull();
    const card = qs(app.root, '.dash-gg-tile');
    expect(card.classList.contains('is-kpi')).toBe(true);
    expect(qs(card, '.kpi-card')).not.toBeNull();
  });

  it('reflects the active engine in the 5-option layout select and switches engines via change-layout', async () => {
    const { app, commit } = dashApp({
      workspace: wsWith({
        queries: [q('q1', 'SELECT k, v FROM a')],
        tiles: [{ id: 't1', queryId: 'q1' }],
        layout: { type: 'flow', version: 1, preset: 'columns-2', items: {} },
      }),
    });
    await render(app);
    const select = layoutSelect(app.root);
    expect([...select.options].map((o) => o.value)).toEqual(
      ['full-width', 'report', 'columns-2', 'columns-3', 'grafana-grid'],
    );
    expect(select.value).toBe('columns-2');
    // Picking "Grafana grid" sends change-layout {type:'grafana-grid',version:1}.
    pickLayout(app.root, 'grafana-grid');
    expect(layoutSelect(app.root).value).toBe('grafana-grid');
    expect(qs(app.root, '.dash-gg-grid')).not.toBeNull();
    expect(commit).toHaveBeenCalled();
    // Picking a flow preset while grid is active restores the regenerated
    // flow@1 fallback (bare {type:'flow',version:1,preset} — grid carries no
    // flow items/preset shape to spread).
    pickLayout(app.root, 'full-width');
    expect(layoutSelect(app.root).value).toBe('full-width');
    expect(qs(app.root, '.dash-gg-grid')).toBeNull(); // cleaned up, not just hidden
    expect(qsa(app.root, '.dash-row').length).toBeGreaterThan(0);
    // The cached tile card sheds its grid-only chrome, not just the host.
    expect(qs(app.root, '.dash-gg-tile')).toBeNull();
    expect(qs(app.root, '.dash-tile')).not.toBeNull();
  });

  it('preserves per-tile flow items when switching between flow presets (not an engine switch)', async () => {
    const { app } = dashApp({
      workspace: wsWith({
        queries: [q('q1', 'SELECT k, v FROM a'), q('q2', 'SELECT k, v FROM b')],
        tiles: [{ id: 't1', queryId: 'q1' }, { id: 't2', queryId: 'q2' }],
        layout: { type: 'flow', version: 1, preset: 'columns-2', items: { t1: { span: 2 } } },
      }),
    });
    await render(app);
    pickLayout(app.root, 'columns-3');
    expect(layoutSelect(app.root).value).toBe('columns-3');
    // 3-column preset with a persisted span-2 tile — still a flow row (not
    // dropped by the switch).
    expect(qsa(app.root, '.dash-row')[0].style.gridTemplateColumns).toContain('repeat(3');
  });

  it('shows grip/delete/resize affordances only in edit mode (!readOnly)', async () => {
    const { app } = dashApp({ workspace: twoTilesGrid() });
    await render(app);
    expect(qsa(app.root, '.dash-gg-grip').length).toBe(2);
    expect(qsa(app.root, '.dash-gg-del').length).toBe(2);
    expect(qsa(app.root, '.dash-gg-resize').length).toBe(2);

    const detached = twoTilesGrid();
    const { app: readonlyApp } = modeApp({
      workspace: null, detached, openSource: { kind: 'current-workspace', workspaceId: 'w', dashboardId: 'd' },
    });
    await render(readonlyApp);
    expect(qsa(readonlyApp.root, '.dash-gg-grip').length).toBe(0);
    expect(qsa(readonlyApp.root, '.dash-gg-del').length).toBe(0);
    expect(qsa(readonlyApp.root, '.dash-gg-resize').length).toBe(0);
  });

  it('delete dispatches remove-tile and drops the tile from the grid', async () => {
    const { app, commit } = dashApp({ workspace: twoTilesGrid() });
    await render(app);
    expect(qsa(app.root, '.dash-gg-tile').length).toBe(2);
    qs<HTMLButtonElement>(app.root, '.dash-gg-del').click();
    expect(qsa(app.root, '.dash-gg-tile').length).toBe(1);
    expect(commit).toHaveBeenCalled();
  });

  it('a delete click is a no-op while flow (not grid) is active', async () => {
    const { app, commit } = dashApp({
      workspace: wsWith({
        queries: [q('q1', 'SELECT k, v FROM a')], tiles: [{ id: 't1', queryId: 'q1' }],
        layout: { type: 'flow', version: 1, preset: 'full-width', items: {} },
      }),
    });
    await render(app);
    qs<HTMLButtonElement>(app.root, '.dash-gg-del').click();
    expect(commit).not.toHaveBeenCalled();
    expect(qsa(app.root, '.dash-tile').length).toBe(1);
  });

  it('corner-drag resize snaps span/height live and dispatches one update-placement on pointerup', async () => {
    const { app, commit } = dashApp({ workspace: twoTilesGrid() });
    await render(app);
    const gridEl = qs(app.root, '.dash-gg-grid');
    // 12 columns, 8px gap → colWidth = (1200 - 8*11)/12 ≈ 92.67px.
    Object.defineProperty(gridEl, 'clientWidth', { value: 1200, configurable: true });
    const card = qsa<HTMLElement>(app.root, '.dash-gg-tile')[0]; // t1, starts span 4 / compact
    const handle = qs<HTMLElement>(card, '.dash-gg-resize');
    handle.dispatchEvent(new PointerEvent('pointerdown', { clientX: 0, clientY: 0 }));
    expect(card.classList.contains('dash-gg-resizing')).toBe(true);
    // clientX=600 → round((600+8)/100.67) = 6 columns; clientY=280 → closer to
    // 296 (large) than 210 (medium) — both differ from the starting 4/compact.
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: 600, clientY: 280 }));
    expect((card.style as CSSStyleDeclaration).gridColumn).toBe('span 6');
    expect(card.classList.contains('dash-gg-h-large')).toBe(true);
    expect(commit).not.toHaveBeenCalled(); // no command dispatched until pointerup
    window.dispatchEvent(new PointerEvent('pointerup'));
    expect(card.classList.contains('dash-gg-resizing')).toBe(false);
    expect(commit).toHaveBeenCalledTimes(1); // exactly one update-placement dispatch
    // The committed placement survives reconciliation (re-derived from state).
    const after = qsa<HTMLElement>(app.root, '.dash-gg-tile')[0];
    expect((after.style as CSSStyleDeclaration).gridColumn).toBe('span 6');
    expect(after.classList.contains('dash-gg-h-large')).toBe(true);
  });

  it('a resize pointerdown is a no-op while flow (not grid) is active', async () => {
    const { app, commit } = dashApp({
      workspace: wsWith({
        queries: [q('q1', 'SELECT k, v FROM a')], tiles: [{ id: 't1', queryId: 'q1' }],
        layout: { type: 'flow', version: 1, preset: 'full-width', items: {} },
      }),
    });
    await render(app);
    const handle = qs<HTMLElement>(app.root, '.dash-gg-resize');
    handle.dispatchEvent(new PointerEvent('pointerdown', { clientX: 0, clientY: 0 }));
    expect(commit).not.toHaveBeenCalled();
  });

  it('a container resize re-clamps the effective column count', async () => {
    const { app } = dashApp({ workspace: twoTilesGrid() });
    await render(app);
    const gridEl = qs(app.root, '.dash-gg-grid');
    expect((gridEl.style as CSSStyleDeclaration).gridTemplateColumns).toContain('repeat(12');
    Object.defineProperty(gridEl, 'clientWidth', { value: 600, configurable: true }); // >=470,<720 → 4 columns
    window.dispatchEvent(new Event('resize'));
    await Promise.resolve(); await Promise.resolve();
    expect((qs(app.root, '.dash-gg-grid').style as CSSStyleDeclaration).gridTemplateColumns).toContain('repeat(4');
  });

  it('a resize while flow (not grid) is active does not force a spurious republish', async () => {
    const { app } = dashApp({
      workspace: wsWith({
        queries: [q('q1', 'SELECT k, v FROM a')], tiles: [{ id: 't1', queryId: 'q1' }],
        layout: { type: 'flow', version: 1, preset: 'full-width', items: {} },
      }),
    });
    await render(app);
    // No throw, and flow's own row structure is untouched by a resize.
    const rowsBefore = qsa(app.root, '.dash-row').length;
    expect(() => window.dispatchEvent(new Event('resize'))).not.toThrow();
    expect(qsa(app.root, '.dash-row').length).toBe(rowsBefore);
  });
});

describe('renderDashboard — shared rich filter bar over the viewer (#188)', () => {
  it('renders the shared rich field family — one var-field per declared param type', async () => {
    const { app } = dashApp({
      workspace: wsWith({
        queries: [q('q1', "SELECT k, v FROM a WHERE s = {s:String} AND e = {e:Enum('a','b')} AND d > {d:Date}")],
        tiles: [{ id: 't1', queryId: 'q1' }],
      }),
    });
    await render(app);
    const names = qsa(app.root, '.dash-filter-host .var-field .var-name').map((n) => n.textContent);
    expect(names).toEqual(expect.arrayContaining(['s', 'e', 'd']));
    // Every field is a combobox-backed input (the shared rich field builders —
    // recents / enum / relative-time), not the old bare text/select swap.
    expect(qsa(app.root, '.dash-filter-host .var-field input').length).toBeGreaterThanOrEqual(3);
  });

  it('commits a curated (source-backed) selection through the viewer in one affected-panel wave', async () => {
    const { app, calls } = dashApp({
      responder: (sql) => (sql.includes('opts')
        ? { columns: [{ name: 'p', type: 'Array(String)' }], rows: [[['x', 'y']]] }
        : { columns: [{ name: 'k', type: 'String' }, { name: 'v', type: 'UInt64' }], rows: [['a', 1]] }),
      workspace: wsWith({
        queries: [
          q('q1', 'SELECT k, v FROM a WHERE x = {p:String}'),
          q('src', "SELECT ['x','y'] AS p -- opts", { dashboard: { role: 'filter' } }),
        ],
        tiles: [{ id: 't1', queryId: 'q1' }],
        filters: [{ id: 'f1', parameter: 'p', sourceQueryId: 'src' }],
      }),
    });
    await render(app);
    // The source query's options upgraded the field to the curated combobox.
    const field = qs(app.root, '.dash-filter-host .var-field.is-curated');
    expect(field).not.toBeNull();
    const before = calls.length;
    qs<HTMLInputElement>(field, 'input').dispatchEvent(new Event('focus'));
    qs(field, '[role="option"]')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    await Promise.resolve(); await Promise.resolve();
    const added = calls.slice(before).filter((c) => 'param_p' in c.params);
    expect(added.length).toBe(1); // one affected-panel wave, tile re-run with the picked value
    expect(added[0].params.param_p).toBe('x');
  });

  it('shows no visible Clear-all control or "N active" count at any active count (#294; count removed by a 2026-07-18 owner override)', async () => {
    const { app } = dashApp({
      workspace: wsWith({
        queries: [q('q1', 'SELECT k, v FROM a WHERE n = {n:UInt8}')],
        tiles: [{ id: 't1', queryId: 'q1' }],
        filters: [{ id: 'n', parameter: 'n', defaultValue: 5, defaultActive: true }],
      }),
    });
    await render(app);
    // `DashboardViewerSession.clearAllFilters()`/`activeFilterCount` stay
    // tested application-level operations/state with no UI trigger or display.
    expect(qs(app.root, '.dash-filter-clear-all')).toBeNull();
    expect(qs(app.root, '.dash-filter-count')).toBeNull();
    expect(qs(app.root, '.dash-filter-count-host')).toBeNull();
  });

  it('the filter host IS the scrolling field viewport (#294, single-level since the count sibling was removed)', async () => {
    const { app } = dashApp({
      workspace: wsWith({
        queries: [q('q1', 'SELECT k, v FROM a WHERE n = {n:UInt8}')],
        tiles: [{ id: 't1', queryId: 'q1' }],
        filters: [{ id: 'n', parameter: 'n', defaultValue: 5, defaultActive: true }],
      }),
    });
    await render(app);
    const host = qs(app.root, '.dash-filter-host');
    expect(host.contains(qs(host, '.dash-filters'))).toBe(true);
  });

  it('renders no per-filter "required/invalid" badge (owner decision — dropped as noise)', async () => {
    const { app } = dashApp({
      workspace: wsWith({
        queries: [q('q1', 'SELECT k, v FROM a WHERE x = {p:String}')],
        tiles: [{ id: 't1', queryId: 'q1' }],
      }),
    });
    await render(app);
    expect(qs(app.root, '.dash-filter-blocking')).toBeNull();
    expect(qs(app.root, '.dash-filter-count')).toBeNull();
    expect(qs(app.root, '.dash-filter-clear-all')).toBeNull();
  });
});

// #303: the isolated per-dashboard filter store (`asb:dashFilters`) — the
// #280 viewer session used to init every filter purely from
// `def.defaultValue`/`defaultActive`, so a committed value lived only in
// memory and reset on reload. `loadJSON`/`KEYS.dashFilters` reads through the
// REAL default store (not through `app`), so these stub `globalThis.localStorage`
// directly (never touching the ambient real one — Node 25 native Web Storage
// flake, #130) — `app.saveJSON` (a `makeApp()` spy) is asserted on for writes.
describe('renderDashboard — isolated per-dashboard filter persistence (#303)', () => {
  function memStore(initial: Record<string, string> = {}) {
    const m = new Map(Object.entries(initial));
    return {
      getItem: (k: string) => (m.has(k) ? (m.get(k) as string) : null),
      setItem: (k: string, v: unknown) => { m.set(k, String(v)); },
    };
  }
  afterEach(() => vi.unstubAllGlobals());

  const filterWs = (over: WsOver = {}) => wsWith({
    queries: [q('q1', 'SELECT k, v FROM a WHERE n = {n:UInt8}')],
    tiles: [{ id: 't1', queryId: 'q1' }],
    filters: [{ id: 'n', parameter: 'n', defaultValue: 5, defaultActive: true }],
    ...over,
  });
  const nField = (app: TestApp): HTMLInputElement => qs<HTMLInputElement>(app.root, '.dash-filter-host .var-field input');

  it("seeds a filter's value/active from a stored bag for the dashboard id", async () => {
    vi.stubGlobal('localStorage', memStore({
      [KEYS.dashFilters]: JSON.stringify({ d: { n: { value: '42', active: false } } }),
    }));
    const { app } = dashApp({ workspace: filterWs() });
    await render(app);
    expect(nField(app).value).toBe('42');
  });

  it('is isolated from the Workbench asb:varValues/asb:filterActive keys (Option B, not shared)', async () => {
    vi.stubGlobal('localStorage', memStore({
      [KEYS.varValues]: JSON.stringify({ n: 'workbench-only-value' }),
      [KEYS.filterActive]: JSON.stringify({ n: false }),
    }));
    const { app } = dashApp({ workspace: filterWs() });
    await render(app);
    // The dashboard's own default (5) wins — the Workbench keys are never read.
    expect(nField(app).value).toBe('5');
  });

  it('does not write defaults back over an existing stored bag on the initial publish', async () => {
    vi.stubGlobal('localStorage', memStore({
      [KEYS.dashFilters]: JSON.stringify({ d: { n: { value: '42', active: false } } }),
    }));
    const { app } = dashApp({ workspace: filterWs() });
    await render(app);
    expect(app.saveJSON).not.toHaveBeenCalled();
  });

  it('does not persist filter defaults on the initial publish when nothing is stored yet', async () => {
    // Empty store + a filter with a non-empty default (n=5, active) — the first
    // publish merely echoes the seeded default state, so it must NOT write:
    // persisting defaults here would freeze them against a later Spec-editor
    // change to the filter's default (regression guard for the review fix).
    vi.stubGlobal('localStorage', memStore());
    const { app } = dashApp({ workspace: filterWs() });
    await render(app);
    expect(app.saveJSON).not.toHaveBeenCalled();
  });

  it('persists a committed filter change, keyed by dashboard id + filter id, isolated from the Workbench keys', async () => {
    vi.stubGlobal('localStorage', memStore());
    const { app } = dashApp({ workspace: filterWs() });
    await render(app);
    const input = nField(app);
    input.value = '7';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('blur', { bubbles: true }));
    await Promise.resolve(); await Promise.resolve();
    expect(app.saveJSON).toHaveBeenCalledWith(KEYS.dashFilters, { d: { n: { value: '7', active: true } } });
    // Never touches the Workbench's own keys.
    expect(app.saveJSON).not.toHaveBeenCalledWith(KEYS.varValues, expect.anything());
    expect(app.saveJSON).not.toHaveBeenCalledWith(KEYS.filterActive, expect.anything());
  });

  it('does not write again on a later publish that carries no filter change (e.g. a layout switch)', async () => {
    vi.stubGlobal('localStorage', memStore());
    const { app } = dashApp({
      workspace: filterWs({ layout: { type: 'flow', version: 1, preset: 'columns-2', items: {} } }),
    });
    await render(app);
    const input = nField(app);
    input.value = '7';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('blur', { bubbles: true }));
    await Promise.resolve(); await Promise.resolve();
    const saveJSON = app.saveJSON as ReturnType<typeof vi.fn>;
    const callsAfterCommit = saveJSON.mock.calls.length;
    expect(callsAfterCommit).toBeGreaterThan(0);
    // A structural republish (preset switch → syncDocument) with the SAME
    // filter value/active must not persist again (the dedicated persist
    // signature, not the bar-rebuild signature, gates the write).
    pickLayout(app.root, 'full-width');
    expect(saveJSON.mock.calls.length).toBe(callsAfterCommit);
  });
});

function jwt(payload: Record<string, unknown>): string {
  // btoa/atob (not node:crypto's Buffer — no @types/node in this project) —
  // the same base64url shape core/jwt.js's decodeJwtPayload expects.
  const b = (o: unknown) => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${b({ alg: 'RS256' })}.${b(payload)}.sig`;
}
const validToken = jwt({ email: 'me@example.com', exp: Math.floor(Date.now() / 1000) + 3600 });

/** The subset of a real `Response` app.js's fetch-consuming code reads —
 * `Response` structurally satisfies this (a genuine subtype relationship, so
 * `makeFetch`'s mock casts cleanly to `typeof fetch` below without an
 * `unknown` bridge). */
interface FakeResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
  clone(): FakeResponse;
  body?: unknown;
  headers: { get(name: string): string | null };
}
interface RespOpts { ok?: boolean; status?: number; json?: unknown; text?: string; body?: unknown }
function resp(opts: RespOpts): FakeResponse {
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
function streamBody(lines: string[]): { getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }>; releaseLock(): void } } {
  let i = 0;
  return {
    getReader: () => ({
      read: async () => (i < lines.length ? { done: false, value: new TextEncoder().encode(lines[i++]) } : { done: true }),
      releaseLock: () => {},
    }),
  };
}
type FetchRoute = [(url: string, sql?: string) => boolean, FakeResponse | (() => FakeResponse)];
function makeFetch(routes: FetchRoute[]) {
  return vi.fn(async (url: string, init?: { body?: string }) => {
    const sql = init && init.body;
    for (const [test, r] of routes) if (test(url, sql)) return typeof r === 'function' ? r() : r;
    return resp({ json: { data: [] } });
  });
}
// Widened to the plain `Clipboard.writeText` signature (not vitest's own
// `Mock<...>` wrapper type) so `{ writeText } as Clipboard` is a legal
// single-step cast — Clipboard's real `writeText` is otherwise not comparable
// to a `Mock<...>`-typed property (extra mock-only members on neither side
// overlap). Never asserted on directly in this suite.
const clipboardWriteText: (data: string) => Promise<void> = vi.fn(async () => {});
function appEnv(over: Partial<CreateAppEnv> = {}): CreateAppEnv {
  const root = document.createElement('div');
  document.body.appendChild(root);
  return {
    root, document, window,
    location: { host: 'ch.example', origin: 'https://ch.example', pathname: '/sql', search: '', hash: '', href: 'https://ch.example/sql' } as Location,
    sessionStorage: memSession({ oauth_id_token: validToken }),
    crypto: globalThis.crypto, Editor: createCodeMirrorEditor, Chart: FakeChart,
    fetch: asFetch(makeFetch([])), now: () => 0, retryMs: 0, handoffMs: 10, handoffListenMs: 10,
    navigator: { clipboard: { writeText: clipboardWriteText } as Clipboard },
    ...over,
  };
}
/** A test-only `MessageEvent`-shaped `Event` — real code (app.js) only reads
 * these three fields off the dispatched event. */
interface FakeMessageEvent extends Event { data: unknown; origin: string; source: unknown }
const msg = (data: unknown, source: unknown, origin = 'https://ch.example'): FakeMessageEvent => {
  const e = new Event('message') as FakeMessageEvent;
  e.data = data; e.origin = origin; e.source = source;
  return e;
};
/** `realApp` retypes a real `createApp(env)` object as `App` WITHOUT copying
 * it (unlike `makeApp()`'s own internal defaults-then-overrides spread):
 * createApp's *inferred* return type only reflects the initial object-literal
 * fields app.js builds (state/dom/root/…) — the ~270 other members (actions,
 * ensureConfig, chCtx, renderApp, receiveAuthHandoff, …) are attached via
 * later property assignment inside that same untyped function, invisible to
 * declaration inference, but genuinely present on the one real object at
 * runtime. Several of those methods are closures over `app.conn` — the real
 * `ConnectionSession` (#276 Phase 2) createApp constructs and wires in place,
 * whose own internal `token`/`authMode`/… locals mutate on
 * `receiveAuthHandoff`/`setTokens`/etc. — so returning a spread COPY here (as
 * `makeApp()` does for its stateless stub) would silently detach every such
 * mutation from what the test reads back — `asApp` only reinterprets the
 * type, preserving the one real reference. */
const asApp = (v: object): App => v as App;
function realApp(env: CreateAppEnv): App {
  return asApp(createApp(env));
}

// A window/fetch stub only ever needs the one member real code reads (e.g.
// `postMessage`) — never the real interface's hundred-odd other members, so
// widening the PARAMETER to `object` (assignable both ways with `Window`/
// `typeof fetch`, since every function and every plain object is an
// `object`) makes the cast inside a genuine single-level `as`, not an
// `unknown` bridge.
const asWindow = (v: object): Window => v as Window;
const asFetch = (v: object): typeof globalThis.fetch => v as typeof globalThis.fetch;

describe('app config base on the dashboard route', () => {
  it('resolves config.json from /sql, not /sql/dashboard', async () => {
    const fetch = makeFetch([]);
    const app = realApp(appEnv({
      fetch: asFetch(fetch),
      location: { host: 'ch.example', origin: 'https://ch.example', pathname: '/sql/dashboard', search: '', hash: '', href: 'https://ch.example/sql/dashboard' } as Location,
    }));
    await app.conn.ensureConfig();
    const urls = fetch.mock.calls.map((c) => c[0]);
    expect(urls.some((u) => /\/sql\/config\.json$/.test(u))).toBe(true);
    expect(urls.some((u) => /dashboard\/config\.json/.test(u))).toBe(false);
  });
});

// A minimal in-memory fake IDBFactory (mirrors indexeddb-workspace-store.test's)
// — enough for the migration + loadCurrent round-trip through the real store.
function fakeIndexedDb(): IDBFactory {
  const stores = new Map<string, Map<string, unknown>>();
  const req = (result?: unknown): Record<string, unknown> =>
    ({ result, error: null, onsuccess: null, onerror: null, onupgradeneeded: null });
  const objectStore = (name: string) => ({
    get: (key: string) => { const r = req(); queueMicrotask(() => { (r as { result: unknown }).result = stores.get(name)!.get(key); (r.onsuccess as (() => void) | null)?.(); }); return r; },
    put: (value: unknown, key: string) => { stores.get(name)!.set(key, value); return req(); },
    delete: (key: string) => { stores.get(name)!.delete(key); return req(); },
  });
  return {
    open() {
      const db = {
        objectStoreNames: { contains: (n: string) => stores.has(n) },
        createObjectStore: (n: string) => { stores.set(n, new Map()); },
        transaction: () => { const tx: Record<string, unknown> = { error: null, oncomplete: null, onerror: null, onabort: null, objectStore }; queueMicrotask(() => (tx.oncomplete as (() => void) | null)?.()); return tx; },
      };
      const r = req(db);
      queueMicrotask(() => { (r.onupgradeneeded as (() => void) | null)?.(); (r.onsuccess as (() => void) | null)?.(); });
      return r as unknown as IDBOpenDBRequest;
    },
  } as unknown as IDBFactory;
}

describe('app.loadDashboardWorkspace (read-flip source, #286)', () => {
  it('migrates the legacy favorites into an aggregate workspace, then reads it back', async () => {
    const app = realApp(appEnv({ indexedDB: fakeIndexedDb() }));
    app.state.savedQueries = [savedQuery({ id: '1', name: 'Q', sql: 'SELECT 1', favorite: true })] as AppState['savedQueries'];
    const ws = await app.loadDashboardWorkspace();
    expect(ws?.dashboard?.tiles.length).toBe(1);
    expect(ws?.dashboard?.tiles[0].queryId).toBe('1');
    // Idempotent: a second call finds the aggregate and returns it unchanged.
    const again = await app.loadDashboardWorkspace();
    expect(again?.id).toBe(ws?.id);
  });
});

describe('app.renderDashboard', () => {
  it('renders the favorites dashboard into the root — streaming the tile through the real seam (#193)', async () => {
    // End-to-end through createApp's real app.exec.executeRead → ch.runQuery → the
    // streaming JSONStringsEachRowWithProgress reader (not resp.json()), the
    // same transport run() and the detached view use.
    const fetch = makeFetch([[(u, sql) => /mychart/.test(sql || ''), resp({
      body: streamBody([
        '{"meta":[{"name":"k","type":"String"},{"name":"v","type":"UInt64"}]}\n',
        '{"row":{"k":"a","v":"1"}}\n',
        '{"row":{"k":"b","v":"2"}}\n',
      ]),
    })]]);
    const app = realApp(appEnv({ fetch: asFetch(fetch) }));
    // Drive the read-flip deterministically: a StoredWorkspaceV1 whose one tile
    // references the query (bypassing IndexedDB), then the real exec seam runs it.
    const query = savedQuery({ id: '1', name: 'Q', sql: 'SELECT k, v FROM mychart' });
    app.loadDashboardWorkspace = async () => ({
      storageVersion: 1, id: 'w', name: 'W', queries: [query],
      dashboard: { documentVersion: 1, id: 'd', title: 'D', revision: 1, layout: { type: 'flow', version: 1, preset: 'full-width', items: {} }, filters: [], tiles: [{ id: 't1', queryId: '1' }] },
    });
    await app.renderDashboard();
    expect(qs(app.root, '.dash-tile canvas')).not.toBeNull();
    // The read-only tile guard (readonly=2) + the row-cap sentinel reach the wire.
    expect(fetch.mock.calls.some((c) => /readonly=2/.test(c[0]))).toBe(true);
    expect(fetch.mock.calls.some((c) => /max_result_rows=5001/.test(c[0]))).toBe(true);
  });
});

describe('app auth handoff', () => {
  it('openDashboard opens a tab and grants credentials when the child asks', () => {
    const child = { postMessage: vi.fn() };
    const app = realApp(appEnv({ openWindow: vi.fn(() => asWindow(child)) }));
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
    const app = realApp(appEnv({ openWindow: () => null }));
    expect(() => app.openDashboard()).not.toThrow();
  });
  it('openDashboard does not grant when the opener holds no credentials', () => {
    const child = { postMessage: vi.fn() };
    const app = realApp(appEnv({ sessionStorage: memSession({}), openWindow: () => asWindow(child) }));
    app.openDashboard();
    window.dispatchEvent(msg({ type: AUTH_REQUEST }, child));
    expect(child.postMessage).not.toHaveBeenCalled();
  });
  it('receiveAuthHandoff resolves false with no opener', async () => {
    const app = realApp(appEnv());
    await expect(app.conn.receiveAuthHandoff({})).resolves.toBe(false);
  });
  it('applies an OAuth grant and re-seeds in-memory auth fields', async () => {
    const ss = memSession({});
    const app = realApp(appEnv({ sessionStorage: ss }));
    const opener = { postMessage: vi.fn() };
    const newTok = jwt({ email: 'x@y.com', exp: Math.floor(Date.now() / 1000) + 3600 });
    const p = app.conn.receiveAuthHandoff({ opener: asWindow(opener) });
    expect(opener.postMessage).toHaveBeenCalledWith({ type: AUTH_REQUEST }, 'https://ch.example');
    window.dispatchEvent(msg({ type: 'other' }, opener)); // ignored
    window.dispatchEvent(msg({ type: AUTH_GRANT, creds: { oauth_id_token: newTok, oauth_refresh_token: 'r', oauth_idp: 'g', oauth_origin: 'https://cluster' } }, opener));
    await expect(p).resolves.toBe(true);
    expect(app.conn.token()).toBe(newTok);
    expect(app.conn.idpId()).toBe('g');
    expect(app.conn.chCtx.origin).toBe('https://cluster');
    expect(ss.getItem('oauth_id_token')).toBe(newTok);
  });
  it('applies a basic-auth grant', async () => {
    const ss = memSession({});
    const app = realApp(appEnv({ sessionStorage: ss }));
    const opener = { postMessage: vi.fn() };
    const p = app.conn.receiveAuthHandoff({ opener: asWindow(opener) });
    window.dispatchEvent(msg({ type: AUTH_GRANT, creds: { ch_basic_auth: 'YmFzZQ==', ch_basic_user: 'u', ch_basic_origin: 'https://c2' } }, opener));
    await expect(p).resolves.toBe(true);
    expect(app.conn.authMode()).toBe('basic');
    expect(app.conn.chCtx.origin).toBe('https://c2');
    expect(ss.getItem('ch_basic_auth')).toBe('YmFzZQ==');
  });
  it('ignores an empty grant and applies a later valid one', async () => {
    const ss = memSession({});
    const app = realApp(appEnv({ sessionStorage: ss }));
    const opener = { postMessage: vi.fn() };
    const p = app.conn.receiveAuthHandoff({ opener: asWindow(opener) });
    window.dispatchEvent(msg({ type: AUTH_GRANT, creds: {} }, opener)); // empty — ignored, keeps waiting
    const newTok = jwt({ email: 'z@z.com', exp: Math.floor(Date.now() / 1000) + 3600 });
    window.dispatchEvent(msg({ type: AUTH_GRANT, creds: { oauth_id_token: newTok } }, opener));
    await expect(p).resolves.toBe(true);
    expect(app.conn.token()).toBe(newTok);
  });
  it('resolves false when the request times out', async () => {
    const app = realApp(appEnv({ handoffMs: 5 }));
    await expect(app.conn.receiveAuthHandoff({ opener: asWindow({ postMessage: vi.fn() }) })).resolves.toBe(false);
  });
});

// ── #288 Phase 6: open-source modes + the Dashboard header File menu ──────────
// renderDashboard now branches on `app.dashboardOpenSource`: a current-workspace
// route verifies BOTH ids against the primary (edit) or detached (view) store; a
// session-bundle route consumes the one-time handoff into a read-only view; a
// resolution failure shows not-found. See ADR-0003.

/** Build a dashApp wired for a specific open-source mode. `detached` seeds
 *  `app.detachedViews.get`; `consume` overrides `app.consumeDashboardHandoff`. */
function modeApp(opts: {
  workspace?: ReturnType<typeof wsWith> | null;
  openSource?: TestApp['dashboardOpenSource'];
  detached?: ReturnType<typeof wsWith> | null;
  consume?: ReturnType<typeof vi.fn>;
  responder?: ExecResponder;
} = {}) {
  const built = dashApp({ workspace: opts.workspace, responder: opts.responder });
  const app = built.app;
  app.dashboardOpenSource = opts.openSource ?? null;
  app.detachedViews = { get: vi.fn(async () => (opts.detached ?? null) as never), put: vi.fn(async () => {}) };
  if (opts.consume) app.consumeDashboardHandoff = opts.consume;
  return { ...built, app };
}

const openFileMenuBtn = (root: ParentNode | null): void => {
  qs<HTMLButtonElement>(root, '.dash-file-btn').click();
};
const menuItems = (): string[] =>
  qsa(document, '.dash-file-menu .dash-fm-item').map((b) => b.textContent || '');

describe('renderDashboard — open-source modes (#288)', () => {
  afterEach(() => { qsa(document, '.dash-file-menu, .fm-overlay').forEach((n) => n.remove()); });

  it('current-workspace: both ids match the primary store → editable (draggable tiles, layout switcher)', async () => {
    const ws = wsWith({ id: 'd', queries: [q('q1', 'SELECT 1')], tiles: [{ id: 't1', queryId: 'q1' }] });
    const { app } = modeApp({ workspace: ws, openSource: { kind: 'current-workspace', workspaceId: 'w', dashboardId: 'd' } });
    await render(app);
    expect(qs(app.root, '.dash-notfound')).toBeNull();
    expect(qsa(app.root, '.dash-tile').length).toBe(1);
    expect(qs<HTMLElement>(app.root, '.dash-tile').getAttribute('draggable')).toBe('true');
    expect(layoutSelect(app.root)).toBeTruthy();
    // projection: the resolved workspace is on app.state for the File menu.
    expect(app.state.dashboard?.id).toBe('d');
  });

  it('current-workspace: workspace matches but dashboard id differs → not-found, runs nothing', async () => {
    const ws = wsWith({ id: 'd' });
    const { app, calls } = modeApp({ workspace: ws, openSource: { kind: 'current-workspace', workspaceId: 'w', dashboardId: 'other' } });
    await render(app);
    expect(qs(app.root, '.dash-notfound')).toBeTruthy();
    expect(qs(app.root, '.dash-notfound-title')?.textContent).toContain('unavailable');
    expect(qsa(app.root, '.dash-tile').length).toBe(0);
    expect(calls.length).toBe(0);
  });

  it('current-workspace: id resolves only in the detached store → read-only view (no drag, no layout switcher)', async () => {
    const detached = wsWith({ id: 'd', queries: [q('q1', 'SELECT 1')], tiles: [{ id: 't1', queryId: 'q1' }] });
    const { app } = modeApp({ workspace: null, detached, openSource: { kind: 'current-workspace', workspaceId: 'w', dashboardId: 'd' } });
    await render(app);
    expect(qs(app.root, '.dash-notfound')).toBeNull();
    expect(qsa(app.root, '.dash-tile').length).toBe(1);
    expect(qs<HTMLElement>(app.root, '.dash-tile').getAttribute('draggable')).toBe('false');
    expect(layoutSelect(app.root)).toBeNull();
  });

  it('session-bundle: consumes the one-time handoff into a read-only view', async () => {
    const detached = wsWith({ id: 'd', queries: [q('q1', 'SELECT 1')], tiles: [{ id: 't1', queryId: 'q1' }] });
    const consume = vi.fn(async () => detached as never);
    const { app } = modeApp({ openSource: { kind: 'session-bundle', token: 'tok', dashboardId: 'd' }, consume });
    await render(app);
    expect(consume).toHaveBeenCalledOnce();
    expect(qs(app.root, '.dash-notfound')).toBeNull();
    expect(qs<HTMLElement>(app.root, '.dash-tile').getAttribute('draggable')).toBe('false');
  });

  it('session-bundle: a missing/expired token → not-found, runs nothing', async () => {
    const consume = vi.fn(async () => null);
    const { app, calls } = modeApp({ openSource: { kind: 'session-bundle', token: 'gone', dashboardId: 'd' }, consume });
    await render(app);
    expect(qs(app.root, '.dash-notfound')).toBeTruthy();
    expect(calls.length).toBe(0);
  });

  it('a bare /dashboard open (no open-source) stays the legacy editable current workspace', async () => {
    const ws = wsWith({ id: 'd', queries: [q('q1', 'SELECT 1')], tiles: [{ id: 't1', queryId: 'q1' }] });
    const { app } = modeApp({ workspace: ws, openSource: null });
    await render(app);
    expect(qs<HTMLElement>(app.root, '.dash-tile').getAttribute('draggable')).toBe('true');
  });
});

describe('renderDashboard — Dashboard header File menu (#302)', () => {
  afterEach(() => { qsa(document, '.dash-file-menu, .fm-overlay').forEach((n) => n.remove()); });

  const editApp = () => modeApp({
    workspace: wsWith({ id: 'd', queries: [q('q1', 'SELECT 1')], tiles: [{ id: 't1', queryId: 'q1' }] }),
    openSource: { kind: 'current-workspace', workspaceId: 'w', dashboardId: 'd' },
  });

  it('edit mode: opens Export / Import / Open-for-viewing, each wired to its action; re-click + Escape close', async () => {
    const { app } = editApp();
    app.actions = { ...app.actions, exportDashboard: vi.fn(), importDashboard: vi.fn(), openDashboardForViewing: vi.fn() };
    await render(app);
    const btn = qs<HTMLButtonElement>(app.root, '.dash-file-btn');
    openFileMenuBtn(app.root);
    expect(btn.getAttribute('aria-expanded')).toBe('true');
    expect(menuItems()).toEqual(['Export Dashboard…', 'Import Dashboard…', 'Open for viewing…']);
    // arrow-key navigation between items
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    // click "Open for viewing…"
    qsa<HTMLButtonElement>(document, '.dash-file-menu .dash-fm-item')[2].click();
    expect(app.actions.openDashboardForViewing).toHaveBeenCalledOnce();
    expect(document.querySelector('.dash-file-menu')).toBeNull(); // closed on select
    // re-open, then Escape closes + restores aria
    openFileMenuBtn(app.root);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(document.querySelector('.dash-file-menu')).toBeNull();
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    // re-open then click the toggle again closes it
    openFileMenuBtn(app.root);
    btn.click();
    expect(document.querySelector('.dash-file-menu')).toBeNull();
  });

  it('Export / Import items call their actions; overlay click closes the menu', async () => {
    const { app } = editApp();
    app.actions = { ...app.actions, exportDashboard: vi.fn(), importDashboard: vi.fn(), openDashboardForViewing: vi.fn() };
    await render(app);
    openFileMenuBtn(app.root);
    qsa<HTMLButtonElement>(document, '.dash-file-menu .dash-fm-item')[0].click();
    expect(app.actions.exportDashboard).toHaveBeenCalledOnce();
    openFileMenuBtn(app.root);
    qsa<HTMLButtonElement>(document, '.dash-file-menu .dash-fm-item')[1].click();
    expect(app.actions.importDashboard).toHaveBeenCalledOnce();
    openFileMenuBtn(app.root);
    qs<HTMLButtonElement>(document, '.fm-overlay').click();
    expect(document.querySelector('.dash-file-menu')).toBeNull();
  });

  it('view mode: the File menu offers Export only (import + re-preview are edit-context)', async () => {
    const detached = wsWith({ id: 'd', queries: [q('q1', 'SELECT 1')], tiles: [{ id: 't1', queryId: 'q1' }] });
    const { app } = modeApp({ workspace: null, detached, openSource: { kind: 'current-workspace', workspaceId: 'w', dashboardId: 'd' } });
    await render(app);
    openFileMenuBtn(app.root);
    expect(menuItems()).toEqual(['Export Dashboard…']);
  });

  it('an unrelated keydown while the menu is open is ignored', async () => {
    const { app } = editApp();
    await render(app);
    openFileMenuBtn(app.root);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    expect(document.querySelector('.dash-file-menu')).toBeTruthy(); // still open
  });
});
