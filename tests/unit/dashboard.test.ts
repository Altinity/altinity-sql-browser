import { describe, it, expect, vi } from 'vitest';
import {
  isDashboardRoute, configBase,
  normalizeDashLayout, normalizeDashCols, DASH_TILE_ROW_CAP, DASH_TILE_BYTE_CAP, DASH_TABLE_DISPLAY_CAP,
  activeDashboardView, dashboardViewSelection, partitionKpiBands,
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
/** `el.onclick`'s DOM-lib type takes a `MouseEvent`; every `.dash-btn`/`.dash-seg-btn`
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
const seg = (root: ParentNode | null, label: string): HTMLElement | undefined =>
  qsa(root, '.dash-seg-layout .dash-seg-btn').find((b) => b.textContent === label);

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
    expect(seg(app.root, '2 columns')?.getAttribute('aria-pressed')).toBe('true');
    const rows = qsa(app.root, '.dash-row');
    expect((rows[0].style as CSSStyleDeclaration).gridTemplateColumns).toContain('repeat(2');
    // Switch to full-width — one column.
    seg(app.root, 'Full width')!.dispatchEvent(new Event('click', { bubbles: true }));
    expect(seg(app.root, 'Full width')?.getAttribute('aria-pressed')).toBe('true');
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
    expect(seg(app.root, 'Full width')?.getAttribute('aria-pressed')).toBe('true');
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

  it('shows the N-active count when a filter is active, hidden otherwise; no visible Clear-all control at any count (#294)', async () => {
    const { app } = dashApp({
      workspace: wsWith({
        queries: [q('q1', 'SELECT k, v FROM a WHERE n = {n:UInt8}')],
        tiles: [{ id: 't1', queryId: 'q1' }],
        filters: [{ id: 'n', parameter: 'n', defaultValue: 5, defaultActive: true }],
      }),
    });
    await render(app);
    expect(qs(app.root, '.dash-filter-count')?.textContent).toBe('1 active');
    // #294 reverses #286/#293's visible Clear-all control — it never renders,
    // active count or not (`DashboardViewerSession.clearAllFilters()` stays a
    // tested application-level operation with no UI trigger).
    expect(qs(app.root, '.dash-filter-clear-all')).toBeNull();
  });

  it('separates the scrolling filter-field region from the fixed count region (#294)', async () => {
    const { app } = dashApp({
      workspace: wsWith({
        queries: [q('q1', 'SELECT k, v FROM a WHERE n = {n:UInt8}')],
        tiles: [{ id: 't1', queryId: 'q1' }],
        filters: [{ id: 'n', parameter: 'n', defaultValue: 5, defaultActive: true }],
      }),
    });
    await render(app);
    const host = qs(app.root, '.dash-filter-host');
    const scroll = qs(host, '.filter-strip-scroll');
    const count = qs(host, '.dash-filter-count-host');
    // The fields live inside the scroll viewport, the count lives outside it —
    // as separate host children, not nested one inside the other.
    expect(scroll.contains(qs(host, '.dash-filters'))).toBe(true);
    expect(scroll.contains(count)).toBe(false);
    expect(count.contains(scroll)).toBe(false);
    expect(count.querySelector('.dash-filter-count')?.textContent).toBe('1 active');
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
    expect((qs(app.root, '.dash-filter-count') as HTMLElement).style.display).toBe('none');
    expect(qs(app.root, '.dash-filter-clear-all')).toBeNull();
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
