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
import { applyCommand } from '../../src/dashboard/application/dashboard-commands.js';
import { createQueryResolver } from '../../src/dashboard/application/dashboard-query-resolver.js';
import { resolveLayoutPluginSync } from '../../src/dashboard/layouts/layout-registry.js';
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

// #332: happy-dom's `getBoundingClientRect` always returns an all-zero rect,
// but `wireTileDrag` (ui/dashboard.ts) captures each tile's rect at drag-start
// and hit-tests the pointer against those captured rects (pure containment,
// core/tile-reorder.ts) — so a pointer-drag test must stub real geometry
// first. Card `i` occupies a distinct, non-overlapping box:
// x:[i*200, i*200+150], y:[0,50].
function stubTileRects(cards: HTMLElement[]): void {
  cards.forEach((card, i) => {
    const rect = {
      left: i * 200, right: i * 200 + 150, top: 0, bottom: 50, width: 150, height: 50, x: i * 200, y: 0,
      toJSON: () => ({}),
    } as DOMRect;
    card.getBoundingClientRect = () => rect;
  });
}
/** The center point of `stubTileRects`'s rect for card index `i` — always
 *  inside that card's rect and outside every other stubbed card's rect. */
const tileCenter = (i: number): { x: number; y: number } => ({ x: i * 200 + 75, y: 25 });
/** A point outside every `stubTileRects`-stubbed card's rect. */
const OUTSIDE_ALL_TILES = { x: -500, y: -500 };

/** Drive one Command/Ctrl-drag pointer gesture: pointerdown on `cards[fromIdx]`
 *  (with the modifier held), one pointermove to `to` (past the move
 *  threshold — real drags never stop mid-move in these fixtures), then
 *  pointerup at `to`. Returns the pointerdown event so a caller can assert
 *  `defaultPrevented`. `cards` must already be rect-stubbed via
 *  `stubTileRects`. */
function pointerDragTo(
  cards: HTMLElement[], fromIdx: number, to: { x: number; y: number },
  opts: { ctrlKey?: boolean; metaKey?: boolean } = { metaKey: true },
): PointerEvent {
  const from = tileCenter(fromIdx);
  const down = new PointerEvent('pointerdown', {
    bubbles: true, cancelable: true, button: 0, clientX: from.x, clientY: from.y,
    metaKey: !!opts.metaKey, ctrlKey: !!opts.ctrlKey,
  });
  cards[fromIdx].dispatchEvent(down);
  window.dispatchEvent(new PointerEvent('pointermove', { clientX: to.x, clientY: to.y }));
  window.dispatchEvent(new PointerEvent('pointerup', { clientX: to.x, clientY: to.y }));
  return down;
}
/** The common case: a full modifier-drag from card `fromIdx` to card `toIdx`
 *  (both already rect-stubbed), landing squarely inside the target's rect.
 *  Used by the FLOW-engine path (point hit-test). */
function dragTile(cards: HTMLElement[], fromIdx: number, toIdx: number, opts: { ctrlKey?: boolean } = {}): void {
  pointerDragTo(cards, fromIdx, tileCenter(toIdx), opts.ctrlKey ? { ctrlKey: true } : { metaKey: true });
}

/** Drive one grafana-grid live-reflow drag. Starts from the tile's GRIP with no
 *  modifier (or the body with ⌘ when `viaGrip:false`), crosses the threshold to
 *  capture home rects, then re-stubs the dragged card's `getBoundingClientRect`
 *  to `overlapIdx`'s home rect so the pure overlap resolver commits to that slot
 *  (happy-dom ignores the follow `transform`, so the floating rect must be
 *  simulated). `overlapIdx: null` leaves the dragged card over its own home →
 *  snap back. Returns the pointerdown event. `cards` must be `stubTileRects`-ed. */
function gridDrag(
  cards: HTMLElement[], fromIdx: number, overlapIdx: number | null, opts: { viaGrip?: boolean } = { viaGrip: true },
): PointerEvent {
  const from = tileCenter(fromIdx);
  const viaGrip = opts.viaGrip !== false;
  const startEl = viaGrip ? qs(cards[fromIdx], '.dash-gg-grip') : cards[fromIdx];
  const down = new PointerEvent('pointerdown', {
    bubbles: true, cancelable: true, button: 0, clientX: from.x, clientY: from.y, metaKey: !viaGrip,
  });
  startEl.dispatchEvent(down);
  // Cross the threshold — beginMove captures every tile's HOME rect here.
  window.dispatchEvent(new PointerEvent('pointermove', { clientX: from.x + 10, clientY: from.y }));
  // Simulate the floating tile now sitting over `overlapIdx`'s slot (or its own).
  const landRect = cards[overlapIdx ?? fromIdx].getBoundingClientRect();
  cards[fromIdx].getBoundingClientRect = () => ({ ...landRect, toJSON: () => ({}) }) as DOMRect;
  const to = tileCenter(overlapIdx ?? fromIdx);
  window.dispatchEvent(new PointerEvent('pointermove', { clientX: to.x, clientY: to.y }));
  window.dispatchEvent(new PointerEvent('pointerup', { clientX: to.x, clientY: to.y }));
  return down;
}

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
    // Switch to report — one column (full-width was removed, #321).
    pickLayout(app.root, 'report');
    expect(layoutSelect(app.root).value).toBe('report');
    expect((qsa(app.root, '.dash-row')[0].style as CSSStyleDeclaration).gridTemplateColumns).toContain('repeat(1');
    expect(commit).toHaveBeenCalled();
  });

  it('defaults the preset to report when the layout omits it (full-width removed, #321)', async () => {
    const { app } = dashApp({
      workspace: wsWith({
        queries: [q('q1', 'SELECT k, v FROM a')],
        tiles: [{ id: 't1', queryId: 'q1' }],
        layout: { type: 'flow', version: 1 } as unknown as Record<string, unknown>,
      }),
    });
    await render(app);
    expect(layoutSelect(app.root).value).toBe('report');
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

describe('renderDashboard — reorder (Command/Ctrl pointer-drag) + sort (#153/#280/#332)', () => {
  const twoTiles = () => wsWith({
    queries: [q('q1', 'SELECT k, v FROM a'), q('q2', 'SELECT k, v FROM b')],
    tiles: [{ id: 't1', queryId: 'q1' }, { id: 't2', queryId: 'q2' }],
    layout: { type: 'flow', version: 1, preset: 'report', items: {} },
  });
  const order = (app: TestApp): string[] => qsa(app.root, '.dash-tile .dash-tile-name').map((n) => n.textContent || '');

  it('has no in-tile move / span / height chrome (owner override — drag only)', async () => {
    const { app } = dashApp({ workspace: twoTiles() });
    await render(app);
    expect(qsa(app.root, '.dash-tile-move').length).toBe(0);
    expect(qsa(app.root, '.dash-tile-span').length).toBe(0);
    expect(qsa(app.root, '.dash-tile-height').length).toBe(0);
  });

  it('a plain pointerdown (no modifier) does not arm a reorder and does not preventDefault (text selection works)', async () => {
    const { app, commit } = dashApp({ workspace: twoTiles() });
    await render(app);
    const cards = qsa(app.root, '.dash-tile');
    stubTileRects(cards);
    const down = pointerDragTo(cards, 0, tileCenter(1), {});
    expect(down.defaultPrevented).toBe(false);
    expect(order(app)).toEqual(['q1', 'q2']);
    expect(commit).not.toHaveBeenCalled();
    expect(qs(app.root, '.dash-grid')?.classList.contains('dash-reordering')).toBe(false);
    expect(cards[0].classList.contains('dash-moving')).toBe(false);
  });

  it('⌘-drag (metaKey) completes a move and persists the new order', async () => {
    const { app, commit } = dashApp({ workspace: twoTiles() });
    await render(app);
    expect(order(app)).toEqual(['q1', 'q2']);
    const cards = qsa(app.root, '.dash-tile');
    stubTileRects(cards);
    const down = pointerDragTo(cards, 1, tileCenter(0), { metaKey: true });
    expect(down.defaultPrevented).toBe(true);
    expect(order(app)).toEqual(['q2', 'q1']); // move-tile applied
    expect(commit).toHaveBeenCalled(); // new order persisted
  });

  it('Ctrl-drag (ctrlKey) completes a move and persists the new order', async () => {
    const { app, commit } = dashApp({ workspace: twoTiles() });
    await render(app);
    const cards = qsa(app.root, '.dash-tile');
    stubTileRects(cards);
    dragTile(cards, 1, 0, { ctrlKey: true });
    expect(order(app)).toEqual(['q2', 'q1']);
    expect(commit).toHaveBeenCalled();
  });

  it('a modifier pointerdown+pointerup that never crosses the move threshold does not reorder', async () => {
    const { app, commit } = dashApp({ workspace: twoTiles() });
    await render(app);
    const cards = qsa(app.root, '.dash-tile');
    stubTileRects(cards);
    const start = tileCenter(0);
    cards[0].dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true, cancelable: true, button: 0, clientX: start.x, clientY: start.y, metaKey: true,
    }));
    // 2px < the 4px threshold (core/tile-reorder.ts) — never arms a move.
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: start.x + 2, clientY: start.y }));
    window.dispatchEvent(new PointerEvent('pointerup', { clientX: start.x + 2, clientY: start.y }));
    expect(order(app)).toEqual(['q1', 'q2']);
    expect(commit).not.toHaveBeenCalled();
    expect(cards[0].classList.contains('dash-moving')).toBe(false);
    expect(qs(app.root, '.dash-grid')?.classList.contains('dash-reordering')).toBe(false);
  });

  it('a completed move dispatches move-tile exactly once', async () => {
    const { app, commit } = dashApp({ workspace: twoTiles() });
    await render(app);
    const cards = qsa(app.root, '.dash-tile');
    stubTileRects(cards);
    dragTile(cards, 1, 0);
    expect(order(app)).toEqual(['q2', 'q1']);
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it('pointercancel mid-move cancels: no order change, grid/card classes cleaned up', async () => {
    const { app, commit } = dashApp({ workspace: twoTiles() });
    await render(app);
    const cards = qsa(app.root, '.dash-tile');
    stubTileRects(cards);
    const start = tileCenter(0);
    cards[0].dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true, cancelable: true, button: 0, clientX: start.x, clientY: start.y, metaKey: true,
    }));
    const to = tileCenter(1);
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: to.x, clientY: to.y }));
    expect(cards[0].classList.contains('dash-moving')).toBe(true);
    expect(qs(app.root, '.dash-grid')?.classList.contains('dash-reordering')).toBe(true);
    window.dispatchEvent(new PointerEvent('pointercancel'));
    expect(order(app)).toEqual(['q1', 'q2']);
    expect(commit).not.toHaveBeenCalled();
    expect(cards[0].classList.contains('dash-moving')).toBe(false);
    expect(qs(app.root, '.dash-grid')?.classList.contains('dash-reordering')).toBe(false);
  });

  it('window blur mid-move cancels: no order change, grid/card classes cleaned up', async () => {
    const { app, commit } = dashApp({ workspace: twoTiles() });
    await render(app);
    const cards = qsa(app.root, '.dash-tile');
    stubTileRects(cards);
    const start = tileCenter(0);
    cards[0].dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true, cancelable: true, button: 0, clientX: start.x, clientY: start.y, metaKey: true,
    }));
    const to = tileCenter(1);
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: to.x, clientY: to.y }));
    window.dispatchEvent(new Event('blur'));
    expect(order(app)).toEqual(['q1', 'q2']);
    expect(commit).not.toHaveBeenCalled();
    expect(cards[0].classList.contains('dash-moving')).toBe(false);
    expect(qs(app.root, '.dash-grid')?.classList.contains('dash-reordering')).toBe(false);
  });

  it('Escape mid-move cancels: no order change, grid/card classes cleaned up', async () => {
    const { app, commit } = dashApp({ workspace: twoTiles() });
    await render(app);
    const cards = qsa(app.root, '.dash-tile');
    stubTileRects(cards);
    const start = tileCenter(0);
    cards[0].dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true, cancelable: true, button: 0, clientX: start.x, clientY: start.y, metaKey: true,
    }));
    const to = tileCenter(1);
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: to.x, clientY: to.y }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(order(app)).toEqual(['q1', 'q2']);
    expect(commit).not.toHaveBeenCalled();
    expect(cards[0].classList.contains('dash-moving')).toBe(false);
    expect(qs(app.root, '.dash-grid')?.classList.contains('dash-reordering')).toBe(false);
  });

  it('a click synthesized after a completed same-tile move is suppressed — no cell-detail drawer opens', async () => {
    const { app } = dashApp({
      responder: () => ({ columns: [{ name: 'k', type: 'String' }, { name: 'v', type: 'String' }], rows: [['x', '1']] }),
      workspace: wsWith({
        queries: [q('q1', 'SELECT k, v FROM a', { panel: { cfg: { type: 'table' } } }), q('q2', 'SELECT k, v FROM b')],
        tiles: [{ id: 't1', queryId: 'q1' }, { id: 't2', queryId: 'q2' }],
        layout: { type: 'flow', version: 1, preset: 'report', items: {} },
      }),
    });
    await render(app);
    const cards = qsa(app.root, '.dash-tile');
    stubTileRects(cards);
    // openCellDetail appends the drawer to the tile's document.body, NOT inside
    // app.root — assert against `document` (an app.root query is always empty).
    const cell = (): Element | null => qs(cards[0], '.res-table tbody td.cell');
    // Positive control: a plain cell click (no drag) DOES open the shared drawer.
    cell()?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(qsa(document, '.cd-backdrop').length).toBe(1);
    qs(document, '.cd-backdrop').remove();
    // A ⌘-drag that leaves and returns to the origin tile is a completed move
    // that releases on its OWN card — the browser synthesizes a real click on
    // that card, which the capture-phase guard must swallow.
    const start = tileCenter(0);
    cards[0].dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true, cancelable: true, button: 0, clientX: start.x, clientY: start.y, metaKey: true,
    }));
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: tileCenter(1).x, clientY: tileCenter(1).y }));
    window.dispatchEvent(new PointerEvent('pointerup', { clientX: start.x, clientY: start.y }));
    cell()?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(qsa(document, '.cd-backdrop').length).toBe(0);
  });

  it('a second pointerdown while a drag is already armed is ignored (#332)', async () => {
    const { app, commit } = dashApp({
      responder: () => ({ columns: [{ name: 'k', type: 'String' }], rows: [['x']] }),
      workspace: wsWith({
        queries: [q('q1', 'SELECT k FROM a'), q('q2', 'SELECT k FROM b')],
        tiles: [{ id: 't1', queryId: 'q1' }, { id: 't2', queryId: 'q2' }],
      }),
    });
    await render(app);
    const cards = qsa(app.root, '.dash-tile');
    stubTileRects(cards);
    // Arm a drag on card 0 and cross the threshold (gesture now active).
    const s0 = tileCenter(0);
    cards[0].dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true, cancelable: true, button: 0, clientX: s0.x, clientY: s0.y, metaKey: true,
    }));
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: tileCenter(1).x, clientY: tileCenter(1).y }));
    // A concurrent modifier pointerdown on card 1 must be IGNORED — not armed,
    // so it is not preventDefault'd and starts no second gesture.
    const down2 = new PointerEvent('pointerdown', {
      bubbles: true, cancelable: true, button: 0, clientX: tileCenter(1).x, clientY: tileCenter(1).y, metaKey: true,
    });
    cards[1].dispatchEvent(down2);
    expect(down2.defaultPrevented).toBe(false);
    // The first gesture still completes normally: exactly one move committed.
    window.dispatchEvent(new PointerEvent('pointerup', { clientX: tileCenter(1).x, clientY: tileCenter(1).y }));
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it('a flow-engine KPI tile (detached card) is skipped from drop hit-testing (#332)', async () => {
    const { app, commit } = dashApp({
      responder: () => ({ columns: [{ name: 'k', type: 'String' }], rows: [['x']] }),
      workspace: wsWith({
        queries: [
          q('k1', 'SELECT 1 AS value', { panel: { cfg: { type: 'kpi' } } }),
          q('q1', 'SELECT k FROM a', { panel: { cfg: { type: 'table' } } }),
          q('q2', 'SELECT k FROM b', { panel: { cfg: { type: 'table' } } }),
        ],
        tiles: [{ id: 't0', queryId: 'k1' }, { id: 't1', queryId: 'q1' }, { id: 't2', queryId: 'q2' }],
        layout: { type: 'flow', version: 1, preset: 'columns-2', items: {} },
      }),
    });
    await render(app);
    // The KPI tile renders inside the band; only the two table tiles are
    // attached `.dash-tile` cards. The KPI tile's detached card must be skipped
    // when capturing rects (its {0,0,0,0} rect would otherwise be a phantom
    // drop target) — the drag between the two real tiles still works.
    const cards = qsa(app.root, '.dash-tile');
    expect(cards.length).toBe(2);
    stubTileRects(cards);
    dragTile(cards, 0, 1);
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it('read-only dashboard: ⌘-drag does not move and no drag listeners are wired', async () => {
    const detached = twoTiles();
    const { app, commit } = modeApp({
      workspace: null, detached, openSource: { kind: 'current-workspace', workspaceId: 'w', dashboardId: 'd' },
    });
    await render(app);
    const cards = qsa(app.root, '.dash-tile');
    expect(qs(app.root, '.dash-tile .dash-gg-grip')).toBeNull(); // no reorder affordance built at all
    stubTileRects(cards);
    dragTile(cards, 1, 0);
    expect(order(app)).toEqual(['q1', 'q2']); // unchanged — no listener installed
    expect(commit).not.toHaveBeenCalled();
    expect(qs(app.root, '.dash-grid')?.classList.contains('dash-reordering')).toBe(false);
  });

  it('mid-move the hovered tile gets .dash-drop-target; the dragged tile itself never does; a release outside every rect does not move', async () => {
    const { app, commit } = dashApp({
      workspace: wsWith({
        queries: [q('q1', 'SELECT k, v FROM a'), q('q2', 'SELECT k, v FROM b'), q('q3', 'SELECT k, v FROM c')],
        tiles: [{ id: 't1', queryId: 'q1' }, { id: 't2', queryId: 'q2' }, { id: 't3', queryId: 'q3' }],
        layout: { type: 'flow', version: 1, preset: 'report', items: {} },
      }),
    });
    await render(app);
    const cards = qsa(app.root, '.dash-tile');
    stubTileRects(cards);
    const start = tileCenter(0);
    cards[0].dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true, cancelable: true, button: 0, clientX: start.x, clientY: start.y, metaKey: true,
    }));
    // Cross the threshold hovering the dragged tile's OWN rect — no drop-target anywhere.
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: start.x + 10, clientY: start.y }));
    expect(qsa(app.root, '.dash-drop-target').length).toBe(0);
    // Move over card index 2 — it (and only it) gets the indicator.
    const t2 = tileCenter(2);
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: t2.x, clientY: t2.y }));
    expect(cards[2].classList.contains('dash-drop-target')).toBe(true);
    expect(qsa(app.root, '.dash-drop-target').length).toBe(1);
    // Release outside every stubbed rect — hit-test null, no move.
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: OUTSIDE_ALL_TILES.x, clientY: OUTSIDE_ALL_TILES.y }));
    expect(qsa(app.root, '.dash-drop-target').length).toBe(0);
    window.dispatchEvent(new PointerEvent('pointerup', { clientX: OUTSIDE_ALL_TILES.x, clientY: OUTSIDE_ALL_TILES.y }));
    expect(order(app)).toEqual(['q1', 'q2', 'q3']);
    expect(commit).not.toHaveBeenCalled();
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

describe('renderDashboard — modkey cursor cue (#332)', () => {
  const oneTile = () => wsWith({
    queries: [q('q1', 'SELECT k, v FROM a')],
    tiles: [{ id: 't1', queryId: 'q1' }],
    layout: { type: 'flow', version: 1, preset: 'report', items: {} },
  });

  it('keydown with metaKey adds .dash-grid.modkey; keyup with no modifier removes it', async () => {
    const { app } = dashApp({ workspace: oneTile() });
    await render(app);
    const grid = qs(app.root, '.dash-grid');
    expect(grid.classList.contains('modkey')).toBe(false);
    window.dispatchEvent(new KeyboardEvent('keydown', { metaKey: true }));
    expect(grid.classList.contains('modkey')).toBe(true);
    window.dispatchEvent(new KeyboardEvent('keyup', {}));
    expect(grid.classList.contains('modkey')).toBe(false);
  });

  it('window blur removes the modkey cue', async () => {
    const { app } = dashApp({ workspace: oneTile() });
    await render(app);
    const grid = qs(app.root, '.dash-grid');
    window.dispatchEvent(new KeyboardEvent('keydown', { ctrlKey: true }));
    expect(grid.classList.contains('modkey')).toBe(true);
    window.dispatchEvent(new Event('blur'));
    expect(grid.classList.contains('modkey')).toBe(false);
  });

  it('a read-only dashboard never installs the modkey listeners', async () => {
    const detached = oneTile();
    const { app } = modeApp({
      workspace: null, detached, openSource: { kind: 'current-workspace', workspaceId: 'w', dashboardId: 'd' },
    });
    await render(app);
    const grid = qs(app.root, '.dash-grid');
    window.dispatchEvent(new KeyboardEvent('keydown', { metaKey: true }));
    expect(grid.classList.contains('modkey')).toBe(false);
  });
});

describe('renderDashboard — shared cell-detail drawer (#332)', () => {
  it('clicking a table cell opens the shared drawer with exact name/type/value (edit mode)', async () => {
    const { app } = dashApp({
      responder: () => ({ columns: [{ name: 'k', type: 'String' }, { name: 'v', type: 'UInt64' }], rows: [['hello', 42]] }),
      workspace: wsWith({
        queries: [q('q1', 'SELECT k, v FROM a', { panel: { cfg: { type: 'table' } } })],
        tiles: [{ id: 't1', queryId: 'q1' }],
      }),
    });
    await render(app);
    qs(app.root, '.res-table tbody td.cell')?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    const backdrop = qs(document, '.cd-backdrop');
    expect(backdrop).not.toBeNull();
    const panel = qs(backdrop, '.cd-panel');
    expect(panel).not.toBeNull();
    expect(qs(panel, '.cd-name')?.textContent).toBe('k');
    expect(qs(panel, '.cd-type')?.textContent).toBe('String');
    expect(panel.textContent).toContain('hello');
    backdrop.remove();
  });

  it('clicking a table cell opens the shared drawer in read-only dashboard mode too', async () => {
    const detached = wsWith({
      id: 'd',
      queries: [q('q1', 'SELECT k, v FROM a', { panel: { cfg: { type: 'table' } } })],
      tiles: [{ id: 't1', queryId: 'q1' }],
    });
    const { app } = modeApp({
      workspace: null, detached, responder: () => ({ columns: [{ name: 'k', type: 'String' }, { name: 'v', type: 'UInt64' }], rows: [['hello', 42]] }),
      openSource: { kind: 'current-workspace', workspaceId: 'w', dashboardId: 'd' },
    });
    await render(app);
    qs(app.root, '.res-table tbody td.cell')?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    const backdrop = qs(document, '.cd-backdrop');
    expect(backdrop).not.toBeNull();
    expect(qs(backdrop, '.cd-name')?.textContent).toBe('k');
    expect(qs(backdrop, '.cd-type')?.textContent).toBe('String');
    backdrop.remove();
  });

  it('Escape closes the drawer; a backdrop click closes it; close-then-open leaves exactly one .cd-backdrop', async () => {
    const { app } = dashApp({
      responder: () => ({ columns: [{ name: 'k', type: 'String' }, { name: 'v', type: 'UInt64' }], rows: [['a', 1], ['b', 2]] }),
      workspace: wsWith({
        queries: [q('q1', 'SELECT k, v FROM a', { panel: { cfg: { type: 'table' } } })],
        tiles: [{ id: 't1', queryId: 'q1' }],
      }),
    });
    await render(app);
    const cells = qsa(app.root, '.res-table tbody td.cell');
    cells[0].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(qsa(document, '.cd-backdrop').length).toBe(1);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(qsa(document, '.cd-backdrop').length).toBe(0);
    // Re-open, then dismiss via a backdrop click.
    cells[0].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    let backdrop = qs(document, '.cd-backdrop');
    expect(backdrop).not.toBeNull();
    backdrop.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    backdrop.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(qsa(document, '.cd-backdrop').length).toBe(0);
    // Open a second time — the shared backdrop-dismiss lifecycle leaves
    // exactly one, not a stacked pair.
    cells[0].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    backdrop = qs(document, '.cd-backdrop');
    expect(qsa(document, '.cd-backdrop').length).toBe(1);
    backdrop.remove();
  });
});

describe('renderDashboard — logs tile cell-detail + drag interplay (#332)', () => {
  const longExtra = 'x'.repeat(120);
  const logsWs = () => wsWith({
    queries: [q('q1', "SELECT event_time, message, level, extra_field FROM a", { panel: { cfg: { type: 'logs' } } }), q('q2', 'SELECT k, v FROM b')],
    tiles: [{ id: 't1', queryId: 'q1' }, { id: 't2', queryId: 'q2' }],
    layout: { type: 'flow', version: 1, preset: 'report', items: {} },
  });
  const logsResponder: ExecResponder = (sql) => (sql.includes('event_time')
    ? {
      columns: [
        { name: 'event_time', type: 'DateTime' }, { name: 'message', type: 'String' },
        { name: 'level', type: 'String' }, { name: 'extra_field', type: 'String' },
      ],
      rows: [['2026-01-01 00:00:00', 'boom', 'error', longExtra]],
    }
    : {});

  it('clicking .log-time/.log-msg/.log-extra opens the drawer with the source column name/type and the RAW untruncated value', async () => {
    const { app } = dashApp({ responder: logsResponder, workspace: logsWs() });
    await render(app);
    expect(qs(app.root, '.dash-logs')).not.toBeNull();

    const timeCell = qs<HTMLElement>(app.root, '.log-time.log-cell');
    timeCell.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    let backdrop = qs(document, '.cd-backdrop');
    expect(qs(backdrop, '.cd-name')?.textContent).toBe('event_time');
    expect(qs(backdrop, '.cd-type')?.textContent).toBe('DateTime');
    backdrop.remove();

    const msgCell = qs<HTMLElement>(app.root, '.log-msg.log-cell');
    msgCell.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    backdrop = qs(document, '.cd-backdrop');
    expect(qs(backdrop, '.cd-name')?.textContent).toBe('message');
    expect(backdrop.textContent).toContain('boom');
    backdrop.remove();

    const extraCell = qs<HTMLElement>(app.root, '.log-extra.log-cell');
    extraCell.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    backdrop = qs(document, '.cd-backdrop');
    expect(qs(backdrop, '.cd-name')?.textContent).toBe('extra_field');
    // The RAW (untruncated) value is shown — the field's own display is
    // truncated to 80 chars (core/logs.ts), so raw !== display for a >80-char value.
    expect(extraCell.textContent).not.toBe(longExtra); // display was truncated
    expect(backdrop.textContent).toContain(longExtra); // drawer shows the raw value
    backdrop.remove();
  });

  it('Enter and Space on a .log-cell also open the drawer', async () => {
    const { app } = dashApp({ responder: logsResponder, workspace: logsWs() });
    await render(app);
    const msgCell = qs<HTMLElement>(app.root, '.log-msg.log-cell');
    msgCell.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect(qsa(document, '.cd-backdrop').length).toBe(1);
    qs(document, '.cd-backdrop').remove();
    msgCell.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }));
    expect(qsa(document, '.cd-backdrop').length).toBe(1);
    qs(document, '.cd-backdrop').remove();
  });

  it('a ⌘-drag starting on a logs tile moves the tile and does not open a drawer', async () => {
    const { app, commit } = dashApp({ responder: logsResponder, workspace: logsWs() });
    await render(app);
    const cards = qsa(app.root, '.dash-tile');
    stubTileRects(cards);
    dragTile(cards, 0, 1); // logs tile (index 0) moves past the plain q2 tile
    expect(qsa(app.root, '.dash-tile .dash-tile-name').map((n) => n.textContent)).toEqual(['q2', 'q1']);
    expect(commit).toHaveBeenCalled();
    expect(qsa(document, '.cd-backdrop').length).toBe(0);
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
    const band = qs(app.root, '.dash-kpi-band');
    expect(band).not.toBeNull();
    const stream = qs<HTMLElement>(band, '.dash-kpi-stream');
    expect(stream).not.toBeNull();
    // The stream's DIRECT children must be `.dash-kpi-member` hosts (the
    // class the CSS `display: contents` pass-through rule actually targets)
    // — one per KPI tile, in canonical `dashboard.tiles[]` order — so the
    // renderer and stylesheet agree on the same class and the cards join
    // the flex-wrap row instead of stacking.
    const members = Array.from(stream.children) as HTMLElement[];
    expect(members.length).toBe(2);
    for (const member of members) expect(member.classList.contains('dash-kpi-member')).toBe(true);
    expect(members.map((m) => m.dataset.tile)).toEqual(['t1', 't2']);
    for (const member of members) expect(member.getAttribute('data-tile')).toBeTruthy();
    expect(qsa(app.root, '.dash-kpi-stream .kpi-card').length).toBe(2);
    for (const member of members) expect(qsa(member, '.kpi-card').length).toBe(1);
  });

  it('shows a KPI member state card for an errored or unfilled KPI source — error is role=alert, unfilled is role=status, both name their tile (#316)', async () => {
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
    const cards = qsa<HTMLElement>(app.root, '.dash-kpi-state-card');
    const errorCard = cards.find((c) => c.textContent === 'kpi down');
    const unfilledCard = cards.find((c) => /Enter a value/.test(c.textContent || ''));
    expect(errorCard?.getAttribute('role')).toBe('alert'); // a genuine query failure
    expect(errorCard?.getAttribute('aria-label')).toBe('k1: kpi down');
    expect(unfilledCard?.getAttribute('role')).toBe('status'); // blocked on a parameter, not a failure
    expect(unfilledCard?.getAttribute('aria-label')).toContain('k2:');
  });

  it('shows the KPI zero-data state card (role=status, not alert) when a KPI source returns no rows (#316)', async () => {
    const { app } = dashApp({
      responder: () => ({ columns: [{ name: 'value', type: 'UInt64' }], rows: [] }),
      workspace: wsWith({ queries: [q('k1', 'SELECT value', { panel: { cfg: { type: 'kpi' } } })], tiles: [{ id: 't1', queryId: 'k1' }] }),
    });
    await render(app);
    const card = qs<HTMLElement>(app.root, '.dash-kpi-state-card');
    expect(card).not.toBeNull();
    expect(card.getAttribute('role')).toBe('status'); // zero rows is expected, not a failure
    expect(card.getAttribute('aria-label')).toBe('k1: No data');
  });

  it('shows the KPI loading state card with role=status while a query is in flight (#316)', async () => {
    let resolveResponder!: (value: ExecResp) => void;
    const pending = new Promise<ExecResp>((resolve) => { resolveResponder = resolve; });
    const { app } = dashApp({
      responder: () => pending,
      workspace: wsWith({ queries: [q('k1', 'SELECT value', { panel: { cfg: { type: 'kpi' } } })], tiles: [{ id: 't1', queryId: 'k1' }] }),
    });
    const rendering = render(app);
    // Flush the microtasks up to (but not past) the in-flight `executeRead`
    // await — the session sets status 'loading' and publishes synchronously
    // before awaiting the responder (dashboard-viewer-session.ts `runTile`).
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    const card = qs<HTMLElement>(app.root, '.dash-kpi-state-card');
    expect(card).not.toBeNull();
    expect(card.textContent).toBe('Loading…');
    expect(card.getAttribute('role')).toBe('status');
    expect(card.getAttribute('aria-label')).toBe('k1: Loading…');
    resolveResponder({ columns: [{ name: 'value', type: 'UInt64' }], rows: [[1]] });
    await rendering;
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

  it('renders tiles through a single rowless grid host with span + a direct px height, no row wrappers', async () => {
    const { app } = dashApp({ workspace: twoTilesGrid() });
    await render(app);
    expect(qs(app.root, '.dash-gg-grid')).not.toBeNull();
    expect(qsa(app.root, '.dash-row').length).toBe(0); // rowless — no per-row wrappers, no KPI band
    const cards = qsa(app.root, '.dash-gg-tile');
    expect(cards.length).toBe(2);
    expect((cards[0].style as CSSStyleDeclaration).gridColumn).toBe('span 4');
    // t1's legacy 'compact' height alias canonicalizes to 1 row unit → 120px
    // (#291 height-units follow-up: px = 32 + 88*units).
    expect((cards[0].style as CSSStyleDeclaration).height).toBe('120px');
    // No persisted placement for t2 → the grid default (span 6, height 2 → 208px).
    expect((cards[1].style as CSSStyleDeclaration).gridColumn).toBe('span 6');
    expect((cards[1].style as CSSStyleDeclaration).height).toBe('208px');
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

  // #329: a Dashboard tile that is 'ready' but carries NO result meta — a Text
  // panel renders static content and never executes a query, so `ts.meta` stays
  // null. `paintPanel` used to pass it to `tileFooter` via a false
  // `as NonNullable` cast, throwing `Cannot read properties of null (reading
  // 'rows')` — and because that ran inside `reconcileGrafanaGrid`'s per-tile
  // loop BEFORE the host gains `dash-gg-grid`, one such tile aborted the whole
  // Grid Tiles render (blank grid). #321 made Grid Tiles the default, so this
  // pre-existing crash sat on the primary path.
  it('renders a metaless (Text) tile in grafana-grid without crashing — footer is simply empty (#329)', async () => {
    const { app } = dashApp({
      responder: (sql) => (sql.includes('data')
        ? { columns: [{ name: 'k', type: 'String' }, { name: 'v', type: 'UInt64' }], rows: [['a', 1]] }
        : {}),
      workspace: wsWith({
        queries: [
          q('tq', "SELECT 'hello' AS body", { panel: { cfg: { type: 'text' } } }),
          q('dq', 'SELECT k, v FROM data', { panel: { cfg: { type: 'table' } } }),
        ],
        tiles: [{ id: 't1', queryId: 'tq' }, { id: 't2', queryId: 'dq' }],
        layout: { type: 'grafana-grid', version: 1, items: {} },
      }),
    });
    await render(app);
    // The grid actually rendered (pre-fix it threw and left 0 tiles / no host).
    expect(qs(app.root, '.dash-gg-grid')).not.toBeNull();
    const cards = qsa(app.root, '.dash-gg-tile');
    expect(cards.length).toBe(2);
    // The metaless (Text) tile has an EMPTY, DOM-hidden footer (#331 — no
    // reserved empty footer line); the data tile has the rows·ms·bytes
    // footer, visible.
    const foots = cards.map((c) => qs<HTMLElement>(c, '.dash-tile-foot'));
    const footTexts = foots.map((f) => (f ? f.textContent || '' : ''));
    expect(footTexts.some((t) => t === '')).toBe(true);
    expect(footTexts.some((t) => t.includes('rows'))).toBe(true);
    const metalessFoot = foots[footTexts.findIndex((t) => t === '')] as HTMLElement;
    const dataFoot = foots[footTexts.findIndex((t) => t.includes('rows'))] as HTMLElement;
    expect(metalessFoot.hidden).toBe(true);
    expect(dataFoot.hidden).toBe(false);
    // #331: the panel root (.md-view for Text) is a direct child of
    // .dash-tile-body so the CSS containment `>` selector applies to it.
    const metalessCard = cards[footTexts.findIndex((t) => t === '')];
    const dataCard = cards[footTexts.findIndex((t) => t.includes('rows'))];
    const metalessBody = qs<HTMLElement>(metalessCard, '.dash-tile-body');
    expect(metalessBody.children.length).toBe(1);
    expect(metalessBody.children[0]!.classList.contains('md-view')).toBe(true);
    const dataBody = qs<HTMLElement>(dataCard, '.dash-tile-body');
    expect(dataBody.children.length).toBe(1);
    expect(dataBody.children[0]!.classList.contains('res-table-wrap')).toBe(true);
  });

  it('renders a metaless (Text) tile in a flow layout without crashing (#329 — shared paintPanel path)', async () => {
    const { app } = dashApp({
      responder: () => ({}),
      workspace: wsWith({
        queries: [q('tq', "SELECT 'hello' AS body", { panel: { cfg: { type: 'text' } } })],
        tiles: [{ id: 't1', queryId: 'tq' }],
        layout: { type: 'flow', version: 1, preset: 'report', items: {} },
      }),
    });
    await render(app);
    // Flow rendered its rows structure and the tile's footer is empty (no
    // meta) and DOM-hidden (#331 — no reserved empty footer line).
    const foot = qs<HTMLElement>(app.root, '.dash-tile-foot');
    expect(foot).not.toBeNull();
    expect(foot.textContent).toBe('');
    expect(foot.hidden).toBe(true);
    // The panel root (.md-view for Text) is a direct child of .dash-tile-body.
    const body = qs<HTMLElement>(app.root, '.dash-tile-body');
    expect(body.children.length).toBe(1);
    expect(body.children[0]!.classList.contains('md-view')).toBe(true);
  });

  it('flips .dash-tile-foot.hidden both ways on republish (query-backed <-> metaless, #331)', async () => {
    const ws = wsWith({
      queries: [q('tq', "SELECT 'hello' AS body", { panel: { cfg: { type: 'text' } } })],
      tiles: [{ id: 't1', queryId: 'tq' }],
      layout: { type: 'flow', version: 1, preset: 'report', items: {} },
    });
    const { app } = dashApp({ workspace: ws, responder: () => ({}) });
    await render(app);
    const foot = qs<HTMLElement>(app.root, '.dash-tile-foot');
    expect(foot.hidden).toBe(true); // metaless Text tile — no meta, footer hidden

    // Republish the same tile as a query-backed table query (a real Spec
    // change recreates session + tile DOM — dashApp's loadDashboardWorkspace
    // reads `ws` by reference, so mutating it in place and re-rendering
    // exercises exactly that path) — meta is now present.
    ws.queries[0] = q('tq', 'SELECT 1 AS v', { panel: { cfg: { type: 'table' } } });
    await render(app);
    const footAfter = qs<HTMLElement>(app.root, '.dash-tile-foot');
    expect(footAfter.hidden).toBe(false);
    expect(footAfter.childNodes.length).toBeGreaterThan(0);

    // And back to metaless — the footer hides again (both directions).
    ws.queries[0] = q('tq', "SELECT 'hello' AS body", { panel: { cfg: { type: 'text' } } });
    await render(app);
    const footBack = qs<HTMLElement>(app.root, '.dash-tile-foot');
    expect(footBack.hidden).toBe(true);
  });

  // #316: the tile shell for a grafana-grid KPI tile — edit mode keeps the
  // full editing chrome except the footer (which the generic KPI path never
  // populates); view mode strips every visible frame, leaving only the KPI
  // cards/state card, behind a still-placed, still-named wrapper.
  const kpiGridWs = () => wsWith({
    queries: [q('k1', 'SELECT 1 AS value', { panel: { cfg: { type: 'kpi' } } })],
    tiles: [{ id: 't1', queryId: 'k1' }],
    layout: { type: 'grafana-grid', version: 1, items: { t1: { span: 4, height: 3 } } },
  });
  const kpiResponder: ExecResponder = () => ({ columns: [{ name: 'value', type: 'UInt64' }], rows: [[42]] });

  it('edit mode: a KPI grid tile keeps its header and edit controls but hides the footer (#316)', async () => {
    const { app } = dashApp({ responder: kpiResponder, workspace: kpiGridWs() });
    await render(app);
    const card = qs<HTMLElement>(app.root, '.dash-gg-tile');
    expect(card.classList.contains('is-kpi')).toBe(true);
    expect(card.classList.contains('is-view')).toBe(false); // edit mode — not the view-mode modifier
    expect(qs(card, '.dash-tile-head')).not.toBeNull(); // header retained
    expect(qs(card, '.dash-tile-name')?.textContent).toBe('k1');
    expect(qs(card, '.dash-gg-grip')).not.toBeNull(); // drag retained
    expect(qs(card, '.dash-gg-del')).not.toBeNull(); // remove retained
    expect(qs(card, '.dash-gg-resize')).not.toBeNull(); // resize retained
    const foot = qs<HTMLElement>(card, '.dash-tile-foot');
    expect(foot.hidden).toBe(true); // suppressed at the DOM level, not just visually
    expect(foot.childNodes.length).toBe(0);
  });

  it('a non-KPI grid tile keeps its footer visible and populated (#316 — the KPI-only fix leaves ordinary tiles alone)', async () => {
    const { app } = dashApp({ workspace: twoTilesGrid() }); // q1/q2 — ordinary (non-KPI) queries
    await render(app);
    for (const card of qsa<HTMLElement>(app.root, '.dash-gg-tile')) {
      const foot = qs<HTMLElement>(card, '.dash-tile-foot');
      expect(foot.hidden).toBe(false);
      expect(foot.childNodes.length).toBeGreaterThan(0);
    }
  });

  it('view mode: a KPI grid tile is frameless (.is-view) — header/edit controls hidden, role=group names it by title, placement survives (#316)', async () => {
    const detached = kpiGridWs();
    const { app } = modeApp({
      workspace: null, detached, responder: kpiResponder,
      openSource: { kind: 'current-workspace', workspaceId: 'w', dashboardId: 'd' },
    });
    await render(app);
    const card = qs<HTMLElement>(app.root, '.dash-gg-tile');
    expect(card.classList.contains('is-kpi')).toBe(true);
    expect(card.classList.contains('is-view')).toBe(true);
    // No drag/remove/resize affordances in view mode.
    expect(qs(card, '.dash-gg-grip')).toBeNull();
    expect(qs(card, '.dash-gg-del')).toBeNull();
    expect(qs(card, '.dash-gg-resize')).toBeNull();
    // The hidden query title survives as the wrapper's accessible group name.
    expect(card.getAttribute('role')).toBe('group');
    expect(card.getAttribute('aria-label')).toBe('k1');
    // The footer stays suppressed exactly as in edit mode.
    expect(qs<HTMLElement>(card, '.dash-tile-foot').hidden).toBe(true);
    // The wrapper still owns the CSS-grid placement (span + authored height).
    expect((card.style as CSSStyleDeclaration).gridColumn).toBe('span 4');
    expect((card.style as CSSStyleDeclaration).height).not.toBe('');
    // The KPI card itself is still rendered inside the frameless wrapper.
    expect(qs(card, '.kpi-card')).not.toBeNull();
  });

  it('switching a tile from KPI to non-KPI (engine republish) leaves no stale hidden footer or group role behind (#316)', async () => {
    const { app } = dashApp({
      responder: (sql) => (sql.includes('value') ? { columns: [{ name: 'value', type: 'UInt64' }], rows: [[42]] } : {}),
      workspace: wsWith({
        queries: [q('k1', 'SELECT 1 AS value', { panel: { cfg: { type: 'kpi' } } })],
        tiles: [{ id: 't1', queryId: 'k1' }],
        layout: { type: 'grafana-grid', version: 1, items: { t1: { span: 4 } } },
      }),
    });
    await render(app);
    let card = qs<HTMLElement>(app.root, '.dash-gg-tile');
    expect(card.classList.contains('is-kpi')).toBe(true);
    expect(qs<HTMLElement>(card, '.dash-tile-foot').hidden).toBe(true);
    expect(card.getAttribute('role')).toBe('group');
    // Round-trip through flow and back to grid (#291's own cached-card-reuse
    // path) — a plain re-render exercises the same reconcile functions a
    // panel-type flip would, without needing a live Spec-editor change.
    pickLayout(app.root, 'report');
    pickLayout(app.root, 'grafana-grid');
    card = qs<HTMLElement>(app.root, '.dash-gg-tile');
    expect(card.classList.contains('is-kpi')).toBe(true);
    expect(qs<HTMLElement>(card, '.dash-tile-foot').hidden).toBe(true);
    expect(card.getAttribute('role')).toBe('group');
  });

  it('reflects the active engine in the 5-option editable layout select and switches engines via change-layout', async () => {
    const { app, commit } = dashApp({
      workspace: wsWith({
        queries: [q('q1', 'SELECT k, v FROM a')],
        tiles: [{ id: 't1', queryId: 'q1' }],
        layout: { type: 'flow', version: 1, preset: 'columns-2', items: {} },
      }),
    });
    await render(app);
    const select = layoutSelect(app.root);
    // #321: 'full-width' removed; 'Grid Tiles'/'Full view' are the two new
    // grafana-grid-related entries (Full view is a transient render-mode
    // override, never an engine of its own).
    expect([...select.options].map((o) => o.value)).toEqual(
      ['grafana-grid', 'full', 'report', 'columns-2', 'columns-3'],
    );
    expect([...select.options].map((o) => o.textContent)).toEqual(
      ['Grid Tiles', 'Full view', 'Report', '2 columns', '3 columns'],
    );
    expect(select.getAttribute('aria-label')).toBe('Dashboard style');
    expect(select.value).toBe('columns-2');
    // Picking "Grid Tiles" sends change-layout {type:'grafana-grid',version:1}.
    pickLayout(app.root, 'grafana-grid');
    expect(layoutSelect(app.root).value).toBe('grafana-grid');
    expect(qs(app.root, '.dash-gg-grid')).not.toBeNull();
    expect(commit).toHaveBeenCalled();
    // Picking a flow preset while grid is active restores the regenerated
    // flow@1 fallback (bare {type:'flow',version:1,preset} — grid carries no
    // flow items/preset shape to spread).
    pickLayout(app.root, 'report');
    expect(layoutSelect(app.root).value).toBe('report');
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
        layout: { type: 'flow', version: 1, preset: 'report', items: {} },
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
    const card = qsa<HTMLElement>(app.root, '.dash-gg-tile')[0]; // t1, starts span 4 / height unit 1 (120px), colStart 0
    const handle = qs<HTMLElement>(card, '.dash-gg-resize');
    handle.dispatchEvent(new PointerEvent('pointerdown', { clientX: 0, clientY: 0 }));
    expect(card.classList.contains('dash-gg-resizing')).toBe(true);
    // #291 review F3: the tile is PINNED to its rendered colStart (0 here) for
    // the drag's duration — an explicit `${colStart+1} / span N`, not bare
    // `span N` — so growing the span mid-drag can never make it self-wrap via
    // the browser's own auto-placement.
    expect((card.style as CSSStyleDeclaration).gridColumn).toBe('1 / span 4');
    // clientX=600 → round((600+8)/100.67) = 6 columns; clientY=280 →
    // round((280-32)/88) = 3 row units → 296px (#291 height-units follow-up) —
    // both differ from the starting 4 / 1-unit (120px).
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: 600, clientY: 280 }));
    expect((card.style as CSSStyleDeclaration).gridColumn).toBe('1 / span 6');
    expect((card.style as CSSStyleDeclaration).height).toBe('296px');
    expect(commit).not.toHaveBeenCalled(); // no command dispatched until pointerup
    window.dispatchEvent(new PointerEvent('pointerup'));
    expect(card.classList.contains('dash-gg-resizing')).toBe(false);
    expect(commit).toHaveBeenCalledTimes(1); // exactly one update-placement dispatch
    // The committed placement survives reconciliation (re-derived from state,
    // reverting to the ordinary un-pinned `span N` the normal reconciler writes).
    const after = qsa<HTMLElement>(app.root, '.dash-gg-tile')[0];
    expect((after.style as CSSStyleDeclaration).gridColumn).toBe('span 6');
    expect((after.style as CSSStyleDeclaration).height).toBe('296px');
  });

  it('a mid-row tile dragged wider is clamped to the columns remaining at its pinned start, never past the grid edge (#291 review F3)', async () => {
    const { app, commit } = dashApp({ workspace: twoTilesGrid() });
    await render(app);
    const gridEl = qs(app.root, '.dash-gg-grid');
    Object.defineProperty(gridEl, 'clientWidth', { value: 1200, configurable: true });
    // t2: no persisted placement → grid default span 6/medium, colStart 4
    // (right after t1's span 4) — NOT the row's first tile.
    const card = qsa<HTMLElement>(app.root, '.dash-gg-tile')[1];
    const handle = qs<HTMLElement>(card, '.dash-gg-resize');
    handle.dispatchEvent(new PointerEvent('pointerdown', { clientX: 0, clientY: 0 }));
    expect((card.style as CSSStyleDeclaration).gridColumn).toBe('5 / span 6'); // pinned at colStart 4
    // A huge rightward drag would naively request span 12 (the full grid) —
    // clamped instead to 12-4=8, the columns actually free at this start, so
    // the tile never demands phantom implicit tracks past the grid edge.
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: 100000, clientY: 0 }));
    expect((card.style as CSSStyleDeclaration).gridColumn).toBe('5 / span 8');
    window.dispatchEvent(new PointerEvent('pointerup'));
    expect(commit).toHaveBeenCalledTimes(1);
    // The persisted span survives reconciliation clamped too (not 12) —
    // reverting to the ordinary un-pinned `span N` the ready reconciler writes.
    const after = qsa<HTMLElement>(app.root, '.dash-gg-tile')[1];
    expect((after.style as CSSStyleDeclaration).gridColumn).toBe('span 8');
  });

  it('a resize pointerdown is a no-op while flow (not grid) is active', async () => {
    const { app, commit } = dashApp({
      workspace: wsWith({
        queries: [q('q1', 'SELECT k, v FROM a')], tiles: [{ id: 't1', queryId: 'q1' }],
        layout: { type: 'flow', version: 1, preset: 'report', items: {} },
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
        layout: { type: 'flow', version: 1, preset: 'report', items: {} },
      }),
    });
    await render(app);
    // No throw, and flow's own row structure is untouched by a resize.
    const rowsBefore = qsa(app.root, '.dash-row').length;
    expect(() => window.dispatchEvent(new Event('resize'))).not.toThrow();
    expect(qsa(app.root, '.dash-row').length).toBe(rowsBefore);
  });

  // #291 review F4: `renderDashboard` can run more than once on the SAME
  // window (`app.reloadDashboardRoute()` re-invokes it after an
  // import-commit while already on /dashboard) — a stale first-render
  // listener must not keep reacting to resize events after a second render.
  it('a second renderDashboard call removes the prior call\'s resize listener — only the latest render reacts', async () => {
    const { app: app1 } = dashApp({ workspace: twoTilesGrid() });
    await render(app1);
    const grid1 = qs(app1.root, '.dash-gg-grid');
    expect((grid1.style as CSSStyleDeclaration).gridTemplateColumns).toContain('repeat(12');
    // A width that WOULD reflow this grid to 2 columns if its own listener
    // were still (incorrectly) attached after the second render below.
    Object.defineProperty(grid1, 'clientWidth', { value: 300, configurable: true });

    const { app: app2 } = dashApp({ workspace: twoTilesGrid() });
    await render(app2); // simulates app.reloadDashboardRoute() re-rendering on the same window
    const grid2 = qs(app2.root, '.dash-gg-grid');
    Object.defineProperty(grid2, 'clientWidth', { value: 600, configurable: true }); // >=470,<720 → 4 columns

    window.dispatchEvent(new Event('resize'));
    await Promise.resolve(); await Promise.resolve();

    // The LATEST render reacts normally...
    expect((qs(app2.root, '.dash-gg-grid').style as CSSStyleDeclaration).gridTemplateColumns).toContain('repeat(4');
    // ...but the FIRST render's grid is untouched — its listener was removed
    // at the start of the second `renderDashboard` call, so it never saw
    // this resize event (it would otherwise have reflowed to 2 columns).
    expect((qs(app1.root, '.dash-gg-grid').style as CSSStyleDeclaration).gridTemplateColumns).toContain('repeat(12');
  });
});

// #332 redesign: grafana-grid tile reorder is a LIVE-REFLOW drag — grip-drag
// with no modifier (or ⌘/Ctrl body-drag), the dragged tile lifts and follows,
// siblings reflow, and the move commits only on ≥2/3 overlap else snaps back.
describe('renderDashboard — grafana-grid live-reflow drag (#332)', () => {
  const gridWs = () => wsWith({
    queries: [q('q1', 'SELECT k FROM a'), q('q2', 'SELECT k FROM b'), q('q3', 'SELECT k FROM c')],
    tiles: [{ id: 't1', queryId: 'q1' }, { id: 't2', queryId: 'q2' }, { id: 't3', queryId: 'q3' }],
    layout: { type: 'grafana-grid', version: 1, items: {} },
  });
  const order = (app: TestApp): string[] => qsa(app.root, '.dash-gg-tile .dash-tile-name').map((n) => n.textContent || '');

  it('grip-drag with NO modifier lifts the tile (placeholder + .dash-floating) and commits on ≥2/3 overlap', async () => {
    const { app, commit } = dashApp({ workspace: gridWs() });
    await render(app);
    const cards = qsa<HTMLElement>(app.root, '.dash-gg-tile');
    expect(order(app)).toEqual(['q1', 'q2', 'q3']);
    stubTileRects(cards);
    // Manually drive so we can assert the mid-gesture float/placeholder state.
    const grip = qs(cards[2], '.dash-gg-grip');
    const from = tileCenter(2);
    const down = new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, clientX: from.x, clientY: from.y });
    grip.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true); // grip drag arms even with no modifier
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: from.x + 10, clientY: from.y }));
    // Mid-drag: the dragged card floats and a same-size placeholder holds its slot.
    expect(cards[2].classList.contains('dash-floating')).toBe(true);
    expect(cards[2].style.position).toBe('fixed');
    expect(qsa(app.root, '.dash-tile-placeholder').length).toBe(1);
    // Simulate the floating tile now overlapping tile 0's slot ≥2/3 and release.
    const land = cards[0].getBoundingClientRect();
    cards[2].getBoundingClientRect = () => ({ ...land, toJSON: () => ({}) }) as DOMRect;
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: tileCenter(0).x, clientY: tileCenter(0).y }));
    window.dispatchEvent(new PointerEvent('pointerup', { clientX: tileCenter(0).x, clientY: tileCenter(0).y }));
    expect(order(app)).toEqual(['q3', 'q1', 'q2']); // t3 moved to index 0
    expect(commit).toHaveBeenCalled();
    // Restore ran: no placeholder left, floating styles cleared.
    expect(qsa(app.root, '.dash-tile-placeholder').length).toBe(0);
    expect(qsa(app.root, '.dash-tile.dash-floating').length).toBe(0);
  });

  it('forward drag: the placeholder preview lands at the SAME slot the commit does (no off-by-one)', async () => {
    // 4 tiles; drag t1 (index 0) forward onto t3's slot (index 2). The dragged
    // tile "takes" t3's slot, so both the live gap and the committed order must
    // place it at final index 2 → [t2, t3, t1, t4] (regression: the placeholder
    // used to preview one slot earlier than the commit landed).
    const { app, commit } = dashApp({
      workspace: wsWith({
        queries: [q('q1', 'SELECT 1'), q('q2', 'SELECT 2'), q('q3', 'SELECT 3'), q('q4', 'SELECT 4')],
        tiles: [{ id: 't1', queryId: 'q1' }, { id: 't2', queryId: 'q2' }, { id: 't3', queryId: 'q3' }, { id: 't4', queryId: 'q4' }],
        layout: { type: 'grafana-grid', version: 1, items: {} },
      }),
    });
    await render(app);
    const cards = qsa<HTMLElement>(app.root, '.dash-gg-tile');
    stubTileRects(cards);
    const grip = qs(cards[0], '.dash-gg-grip');
    const from = tileCenter(0);
    grip.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, clientX: from.x, clientY: from.y }));
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: from.x + 10, clientY: from.y }));
    // Float t1 over t3's home slot (index 2).
    const land = cards[2].getBoundingClientRect();
    cards[0].getBoundingClientRect = () => ({ ...land, toJSON: () => ({}) }) as DOMRect;
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: tileCenter(2).x, clientY: tileCenter(2).y }));
    // Mid-drag: among the grid children, the placeholder sits AFTER t3 (index 2
    // of the non-floating flow), i.e. between t3 and t4 — matching the commit.
    const flowSeq = [...qs(app.root, '.dash-grid').children]
      .filter((c) => c.classList.contains('dash-tile-placeholder')
        || (c.classList.contains('dash-gg-tile') && (c as HTMLElement).style.position !== 'fixed'))
      .map((c) => c.classList.contains('dash-tile-placeholder') ? '[gap]' : qs(c, '.dash-tile-name')?.textContent);
    expect(flowSeq).toEqual(['q2', 'q3', '[gap]', 'q4']);
    window.dispatchEvent(new PointerEvent('pointerup', { clientX: tileCenter(2).x, clientY: tileCenter(2).y }));
    expect(order(app)).toEqual(['q2', 'q3', 'q1', 'q4']); // commit matches the previewed gap
    expect(commit).toHaveBeenCalled();
  });

  it('⌘-drag on the tile body also arms the grafana-grid reflow drag', async () => {
    const { app, commit } = dashApp({ workspace: gridWs() });
    await render(app);
    const cards = qsa<HTMLElement>(app.root, '.dash-gg-tile');
    stubTileRects(cards);
    gridDrag(cards, 0, 2, { viaGrip: false }); // ⌘ + body
    expect(order(app)).toEqual(['q2', 'q3', 'q1']);
    expect(commit).toHaveBeenCalled();
  });

  it('a plain body drag (no grip, no modifier) never reorders a grafana-grid tile', async () => {
    const { app, commit } = dashApp({ workspace: gridWs() });
    await render(app);
    const cards = qsa<HTMLElement>(app.root, '.dash-gg-tile');
    stubTileRects(cards);
    const from = tileCenter(2);
    const down = new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, clientX: from.x, clientY: from.y });
    cards[2].dispatchEvent(down); // body, no modifier
    expect(down.defaultPrevented).toBe(false);
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: from.x + 30, clientY: from.y }));
    expect(qsa(app.root, '.dash-tile-placeholder').length).toBe(0);
    window.dispatchEvent(new PointerEvent('pointerup', { clientX: from.x + 30, clientY: from.y }));
    expect(order(app)).toEqual(['q1', 'q2', 'q3']);
    expect(commit).not.toHaveBeenCalled();
  });

  it('<2/3 overlap → snap back: no move dispatched AND placeholder/float styles restored', async () => {
    const { app, commit } = dashApp({ workspace: gridWs() });
    await render(app);
    const cards = qsa<HTMLElement>(app.root, '.dash-gg-tile');
    stubTileRects(cards);
    // overlapIdx null → the dragged card stays over its own home slot → snap back.
    gridDrag(cards, 2, null);
    expect(order(app)).toEqual(['q1', 'q2', 'q3']);
    expect(commit).not.toHaveBeenCalled();
    expect(qsa(app.root, '.dash-tile-placeholder').length).toBe(0);
    expect(cards[2].classList.contains('dash-floating')).toBe(false);
    expect(cards[2].style.position).toBe('');
    expect(cards[2].style.transform).toBe('');
  });

  it('Escape mid-drag cancels: no move, placeholder + float styles restored', async () => {
    const { app, commit } = dashApp({ workspace: gridWs() });
    await render(app);
    const cards = qsa<HTMLElement>(app.root, '.dash-gg-tile');
    stubTileRects(cards);
    const grip = qs(cards[2], '.dash-gg-grip');
    const from = tileCenter(2);
    grip.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, clientX: from.x, clientY: from.y }));
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: from.x + 10, clientY: from.y }));
    expect(qsa(app.root, '.dash-tile-placeholder').length).toBe(1);
    app.document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(qsa(app.root, '.dash-tile-placeholder').length).toBe(0);
    expect(cards[2].classList.contains('dash-floating')).toBe(false);
    expect(commit).not.toHaveBeenCalled();
    expect(order(app)).toEqual(['q1', 'q2', 'q3']);
  });

  it('honors prefers-reduced-motion (no FLIP transition on the reflow), still reorders', async () => {
    const { app, commit } = dashApp({ workspace: gridWs() });
    await render(app);
    const win = app.document.defaultView as unknown as { matchMedia: (q: string) => { matches: boolean } };
    const realMatchMedia = win.matchMedia;
    win.matchMedia = (query: string) => ({ matches: /prefers-reduced-motion/.test(query) } as MediaQueryList);
    try {
      const cards = qsa<HTMLElement>(app.root, '.dash-gg-tile');
      stubTileRects(cards);
      gridDrag(cards, 2, 0);
      expect(order(app)).toEqual(['q3', 'q1', 'q2']);
      expect(commit).toHaveBeenCalled();
    } finally {
      win.matchMedia = realMatchMedia;
    }
  });
});

// #321 "Full view": a TRANSIENT grafana-grid render-mode override — every
// tile renders full width, never persisted, never a commit.
describe('renderDashboard — Full view (#321)', () => {
  // A valid flow@1 fallback is required for the grid->flow direction of
  // change-layout (dashboard-commands.ts) — unlike the sibling grafana-grid
  // describe block above, this one exercises grid<->flow round-trips.
  const twoTilesGrid = () => wsWith({
    queries: [q('q1', 'SELECT k, v FROM a'), q('q2', 'SELECT k, v FROM b')],
    tiles: [{ id: 't1', queryId: 'q1' }, { id: 't2', queryId: 'q2' }],
    layout: {
      type: 'grafana-grid', version: 1, items: { t1: { span: 4, height: 'compact' } },
      fallback: { type: 'flow', version: 1, preset: 'columns-2', items: {} },
    },
  });

  it('selecting Full view makes every tile span the full column count without committing; Grid Tiles restores authored spans', async () => {
    const { app, commit } = dashApp({ workspace: twoTilesGrid() });
    await render(app);
    const gridEl = qs<HTMLElement>(app.root, '.dash-gg-grid');
    expect((gridEl.style as CSSStyleDeclaration).gridTemplateColumns).toContain('repeat(12');
    pickLayout(app.root, 'full');
    expect(layoutSelect(app.root).value).toBe('full');
    for (const card of qsa<HTMLElement>(app.root, '.dash-gg-tile')) {
      expect((card.style as CSSStyleDeclaration).gridColumn).toBe('span 12');
    }
    expect(commit).not.toHaveBeenCalled();
    expect(qs(app.root, '.dash-gg-grid')?.classList.contains('is-full')).toBe(true);
    // Grid Tiles restores the exact authored spans — still no commit.
    pickLayout(app.root, 'grafana-grid');
    expect(layoutSelect(app.root).value).toBe('grafana-grid');
    const cards = qsa<HTMLElement>(app.root, '.dash-gg-tile');
    expect((cards[0].style as CSSStyleDeclaration).gridColumn).toBe('span 4');
    expect((cards[1].style as CSSStyleDeclaration).gridColumn).toBe('span 6'); // grid default
    expect(commit).not.toHaveBeenCalled();
    expect(qs(app.root, '.dash-gg-grid')?.classList.contains('is-full')).toBe(false);
  });

  it('delete still dispatches remove-tile and persists while Full view is active', async () => {
    const { app, commit } = dashApp({ workspace: twoTilesGrid() });
    await render(app);
    pickLayout(app.root, 'full');
    expect(layoutSelect(app.root).value).toBe('full');
    // Delete still dispatches remove-tile and persists.
    qs<HTMLButtonElement>(app.root, '.dash-gg-del').click();
    expect(qsa(app.root, '.dash-gg-tile').length).toBe(1);
    expect(commit).toHaveBeenCalled();
    // Full view survives the commit-driven republish.
    expect(layoutSelect(app.root).value).toBe('full');
    expect((qsa<HTMLElement>(app.root, '.dash-gg-tile')[0].style as CSSStyleDeclaration).gridColumn).toBe('span 12');
  });

  it('reorder (drag) still dispatches move-tile and persists while Full view is active', async () => {
    const { app, commit } = dashApp({ workspace: twoTilesGrid() });
    await render(app);
    pickLayout(app.root, 'full');
    expect(layoutSelect(app.root).value).toBe('full');
    const nameOf = (el: Element): string | null => qs(el, '.dash-tile-name')?.getAttribute('title') ?? null;
    const before = qsa<HTMLElement>(app.root, '.dash-gg-tile').map(nameOf);
    expect(before).toEqual(['q1', 'q2']);
    const cards = qsa<HTMLElement>(app.root, '.dash-gg-tile');
    // grafana-grid uses the live-reflow drag (#332 redesign): grip-drag with no
    // modifier, dragged tile lifted over the target slot (≥2/3 overlap commits).
    stubTileRects(cards);
    gridDrag(cards, 1, 0);
    const after = qsa<HTMLElement>(app.root, '.dash-gg-tile').map(nameOf);
    expect(after).toEqual(['q2', 'q1']); // move-tile applied — persisted order
    expect(commit).toHaveBeenCalled();
    // Full view survives the commit-driven republish; every tile still full width.
    expect(layoutSelect(app.root).value).toBe('full');
    for (const card of qsa<HTMLElement>(app.root, '.dash-gg-tile')) {
      expect((card.style as CSSStyleDeclaration).gridColumn).toBe('span 12');
    }
  });

  it('adding a tile (add-query) seeds the grafana-grid default placement (span 6 / height 2), which renders full-width while Full view is active', async () => {
    // #321 SHOULD-FIX: dashboard.ts itself never dispatches `add-query` (no
    // add affordance lives in this render module — that command comes from
    // the Library/Spec-editor "add to dashboard" path); this drives the SAME
    // command path `runCommand` uses (`applyCommand` + `createQueryResolver`
    // + `resolveLayoutPluginSync`, dashboard.ts:576-593) to build a workspace
    // as-if a tile had just been added, then renders it to assert the
    // resulting placement.
    const q3 = q('q3', 'SELECT k, v FROM c');
    const base = twoTilesGrid();
    const queries = [...base.queries, q3];
    const added = applyCommand(
      base.dashboard as unknown as Parameters<typeof applyCommand>[0],
      { type: 'add-query', queryId: 'q3' },
      { resolver: createQueryResolver(queries), genTileId: () => 't3', plugin: resolveLayoutPluginSync(base.dashboard.layout) },
    );
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    const normalized = resolveLayoutPluginSync(added.dashboard.layout).normalize(added.dashboard);
    const workspace = { ...base, queries, dashboard: normalized };

    const { app, commit } = dashApp({ workspace: workspace as unknown as ReturnType<typeof wsWith> });
    await render(app);
    pickLayout(app.root, 'full');
    const addedCard = qsa<HTMLElement>(app.root, '.dash-gg-tile')
      .find((card) => qs(card, '.dash-tile-name')?.getAttribute('title') === 'q3')!;
    expect(addedCard).toBeTruthy();
    expect((addedCard.style as CSSStyleDeclaration).gridColumn).toBe('span 12'); // full-width override
    expect(commit).not.toHaveBeenCalled(); // Full view itself never persists

    // Switch back to Grid Tiles: the PERSISTED default placement — span 6,
    // height 2 (208px = 32 + 88*2) — is exactly what add-query seeded, not
    // the transient full-width render.
    pickLayout(app.root, 'grafana-grid');
    const restoredCard = qsa<HTMLElement>(app.root, '.dash-gg-tile')
      .find((card) => qs(card, '.dash-tile-name')?.getAttribute('title') === 'q3')!;
    expect((restoredCard.style as CSSStyleDeclaration).gridColumn).toBe('span 6');
    expect((restoredCard.style as CSSStyleDeclaration).height).toBe('208px');
  });

  it('a resize gesture in Full view is vertical-only: dispatches update-placement with the UNCHANGED persisted span', async () => {
    const { app, commit } = dashApp({ workspace: twoTilesGrid() });
    await render(app);
    const gridEl = qs<HTMLElement>(app.root, '.dash-gg-grid');
    Object.defineProperty(gridEl, 'clientWidth', { value: 1200, configurable: true });
    pickLayout(app.root, 'full');
    const card = qsa<HTMLElement>(app.root, '.dash-gg-tile')[0]; // t1, authored span 4
    expect((card.style as CSSStyleDeclaration).gridColumn).toBe('span 12'); // full-width override
    const handle = qs<HTMLElement>(card, '.dash-gg-resize');
    expect(handle.title).toBe('Resize tile height');
    expect(handle.getAttribute('aria-label')).toBe('Resize tile height');
    handle.dispatchEvent(new PointerEvent('pointerdown', { clientX: 0, clientY: 0 }));
    // Horizontal movement has no effect — gridColumn is never re-pinned to a
    // sub-span (the card stays full width) even with a large clientX delta.
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: 100000, clientY: 280 }));
    expect((card.style as CSSStyleDeclaration).gridColumn).toBe('span 12');
    expect((card.style as CSSStyleDeclaration).height).toBe('296px'); // height still snaps (3 row units)
    window.dispatchEvent(new PointerEvent('pointerup'));
    expect(commit).toHaveBeenCalledTimes(1);
    // The persisted (authored) span — 4, NOT the full-width 12 — survives.
    const after = qsa<HTMLElement>(app.root, '.dash-gg-tile')[0];
    expect((after.style as CSSStyleDeclaration).gridColumn).toBe('span 12'); // still rendered full width
    // Switching back to Grid Tiles proves the PERSISTED span was 4, not 12.
    pickLayout(app.root, 'grafana-grid');
    expect((qsa<HTMLElement>(app.root, '.dash-gg-tile')[0].style as CSSStyleDeclaration).gridColumn).toBe('span 4');
  });

  it('a resize handle reads "Resize" (two-dimensional) in tiles mode', async () => {
    const { app } = dashApp({ workspace: twoTilesGrid() });
    await render(app);
    const handle = qs<HTMLElement>(app.root, '.dash-gg-resize');
    expect(handle.title).toBe('Resize');
    expect(handle.getAttribute('aria-label')).toBe('Resize');
  });

  it('read-only view: the reduced selector only calls session.setGridRenderMode — never a command', async () => {
    const detached = twoTilesGrid();
    const { app, commit } = modeApp({
      workspace: null, detached, openSource: { kind: 'current-workspace', workspaceId: 'w', dashboardId: 'd' },
    });
    await render(app);
    const select = layoutSelect(app.root);
    expect([...select.options].map((o) => o.value)).toEqual(['grafana-grid', 'full']);
    pickLayout(app.root, 'full');
    expect(layoutSelect(app.root).value).toBe('full');
    for (const card of qsa<HTMLElement>(app.root, '.dash-gg-tile')) {
      expect((card.style as CSSStyleDeclaration).gridColumn).toBe('span 12');
    }
    expect(commit).not.toHaveBeenCalled();
    pickLayout(app.root, 'grafana-grid');
    expect(layoutSelect(app.root).value).toBe('grafana-grid');
    expect(commit).not.toHaveBeenCalled();
  });

  it('selecting Full view from a flow preset performs exactly ONE persisted conversion, then stays runtime-only', async () => {
    const { app, commit } = dashApp({
      workspace: wsWith({
        queries: [q('q1', 'SELECT k, v FROM a')], tiles: [{ id: 't1', queryId: 'q1' }],
        layout: { type: 'flow', version: 1, preset: 'columns-2', items: {} },
      }),
    });
    await render(app);
    expect(commit).not.toHaveBeenCalled();
    pickLayout(app.root, 'full');
    expect(layoutSelect(app.root).value).toBe('full');
    expect(commit).toHaveBeenCalledTimes(1); // the ONE flow->grid conversion
    expect(qs(app.root, '.dash-gg-grid')).not.toBeNull();
    expect((qs<HTMLElement>(app.root, '.dash-gg-tile').style as CSSStyleDeclaration).gridColumn).toBe('span 12');
  });

  it('selecting a flow preset from Full view clears the override and persists the selected flow layout', async () => {
    const { app, commit } = dashApp({ workspace: twoTilesGrid() });
    await render(app);
    pickLayout(app.root, 'full');
    expect(commit).not.toHaveBeenCalled();
    pickLayout(app.root, 'columns-2');
    expect(layoutSelect(app.root).value).toBe('columns-2');
    expect(commit).toHaveBeenCalledTimes(1); // the grid->flow conversion
    expect(qs(app.root, '.dash-gg-grid')).toBeNull();
    expect(qsa(app.root, '.dash-row').length).toBeGreaterThan(0);
  });

  it('a fresh render (new viewer session) always starts in Grid Tiles mode', async () => {
    const { app } = dashApp({ workspace: twoTilesGrid() });
    await render(app);
    expect(layoutSelect(app.root).value).toBe('grafana-grid');
    expect((qsa<HTMLElement>(app.root, '.dash-gg-tile')[0].style as CSSStyleDeclaration).gridColumn).toBe('span 4');
  });

  it('no is-wide class is ever present on the grid host, in any mode', async () => {
    const { app } = dashApp({ workspace: twoTilesGrid() });
    await render(app);
    expect(qs(app.root, '.dash-grid')?.classList.contains('is-wide')).toBe(false);
    pickLayout(app.root, 'full');
    expect(qs(app.root, '.dash-grid')?.classList.contains('is-wide')).toBe(false);
    pickLayout(app.root, 'grafana-grid');
    expect(qs(app.root, '.dash-grid')?.classList.contains('is-wide')).toBe(false);
    pickLayout(app.root, 'columns-2');
    expect(qs(app.root, '.dash-grid')?.classList.contains('is-wide')).toBe(false);
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
    pickLayout(app.root, 'report');
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
      dashboard: { documentVersion: 1, id: 'd', title: 'D', revision: 1, layout: { type: 'flow', version: 1, preset: 'report', items: {} }, filters: [], tiles: [{ id: 't1', queryId: '1' }] },
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
// #331: item labels are read via `.fm-label` (not the full `.dash-fm-item`
// textContent, which now also carries an icon + optional `.fm-meta`).
const menuItems = (): string[] =>
  qsa(document, '.dash-file-menu .fm-label').map((b) => b.textContent || '');
const menuSections = (): string[] =>
  qsa(document, '.dash-file-menu .fm-section').map((b) => b.textContent || '');

describe('renderDashboard — open-source modes (#288)', () => {
  afterEach(() => { qsa(document, '.dash-file-menu, .fm-overlay').forEach((n) => n.remove()); });

  it('current-workspace: both ids match the primary store → editable (reorder grip present, layout switcher)', async () => {
    const ws = wsWith({ id: 'd', queries: [q('q1', 'SELECT 1')], tiles: [{ id: 't1', queryId: 'q1' }] });
    const { app } = modeApp({ workspace: ws, openSource: { kind: 'current-workspace', workspaceId: 'w', dashboardId: 'd' } });
    await render(app);
    expect(qs(app.root, '.dash-notfound')).toBeNull();
    expect(qsa(app.root, '.dash-tile').length).toBe(1);
    // Command/Ctrl-drag reorder affordance (#332) is edit-mode-only.
    expect(qs(app.root, '.dash-tile .dash-gg-grip')).not.toBeNull();
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

  it('current-workspace: id resolves only in the detached store → read-only view (no drag, no layout selector for a flow doc, #321)', async () => {
    // `wsWith`'s default layout is flow@1 — this is the pre-#321 shape any
    // existing shared doc has. The reduced read-only selector is a
    // grafana-grid-only render-mode toggle; for a read-only FLOW doc there is
    // no engine switch possible read-only, so the selector must be HIDDEN
    // entirely (not shown with a dead 'Full view' option over a flow layout).
    const detached = wsWith({ id: 'd', queries: [q('q1', 'SELECT 1')], tiles: [{ id: 't1', queryId: 'q1' }] });
    const { app } = modeApp({ workspace: null, detached, openSource: { kind: 'current-workspace', workspaceId: 'w', dashboardId: 'd' } });
    await render(app);
    expect(qs(app.root, '.dash-notfound')).toBeNull();
    expect(qsa(app.root, '.dash-tile').length).toBe(1);
    // No reorder grip in a read-only view (#332 — no drag wiring either).
    expect(qs(app.root, '.dash-tile .dash-gg-grip')).toBeNull();
    expect(layoutSelect(app.root)).toBeNull();
  });

  it('current-workspace: read-only + grafana-grid doc → the reduced Grid Tiles / Full view selector IS shown and functional (#321)', async () => {
    const detached = wsWith({
      id: 'd', queries: [q('q1', 'SELECT 1')], tiles: [{ id: 't1', queryId: 'q1' }],
      layout: { type: 'grafana-grid', version: 1, items: {} },
    });
    const { app, commit } = modeApp({ workspace: null, detached, openSource: { kind: 'current-workspace', workspaceId: 'w', dashboardId: 'd' } });
    await render(app);
    expect(qs(app.root, '.dash-notfound')).toBeNull();
    // #321: read-only still shows the REDUCED Grid Tiles / Full view selector
    // (a runtime-only render-mode toggle, never persistence) — the flow
    // presets and the flow<->grid engine switch stay edit-mode-only.
    const select = layoutSelect(app.root);
    expect(select).not.toBeNull();
    expect([...select.options].map((o) => o.value)).toEqual(['grafana-grid', 'full']);
    pickLayout(app.root, 'full');
    expect(layoutSelect(app.root).value).toBe('full');
    expect(commit).not.toHaveBeenCalled();
  });

  it('session-bundle: consumes the one-time handoff into a read-only view', async () => {
    const detached = wsWith({ id: 'd', queries: [q('q1', 'SELECT 1')], tiles: [{ id: 't1', queryId: 'q1' }] });
    const consume = vi.fn(async () => detached as never);
    const { app } = modeApp({ openSource: { kind: 'session-bundle', token: 'tok', dashboardId: 'd' }, consume });
    await render(app);
    expect(consume).toHaveBeenCalledOnce();
    expect(qs(app.root, '.dash-notfound')).toBeNull();
    expect(qs(app.root, '.dash-tile .dash-gg-grip')).toBeNull();
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
    expect(qs(app.root, '.dash-tile .dash-gg-grip')).not.toBeNull();
  });
});

describe('renderDashboard — Dashboard header File menu (#302)', () => {
  afterEach(() => { qsa(document, '.dash-file-menu, .fm-overlay').forEach((n) => n.remove()); });

  const editApp = () => modeApp({
    workspace: wsWith({ id: 'd', queries: [q('q1', 'SELECT 1')], tiles: [{ id: 't1', queryId: 'q1' }] }),
    openSource: { kind: 'current-workspace', workspaceId: 'w', dashboardId: 'd' },
  });

  it('the trigger uses the shared downward-chevron treatment, never a right-pointing arrow', async () => {
    const { app } = editApp();
    await render(app);
    const btn = qs<HTMLButtonElement>(app.root, '.dash-file-btn');
    const path = qs<SVGPathElement>(btn, 'svg path').getAttribute('d');
    // Icon.chevDown()'s path — distinct from Icon.arrow()'s right-pointing
    // 'M2 6h7.5M7 3.5L9.5 6 7 8.5' (icons.ts), which the old trigger used and
    // wrongly suggested navigation rather than a dropdown.
    expect(path).toBe('M2 3l3 3 3-3');
    expect(path).not.toBe('M2 6h7.5M7 3.5L9.5 6 7 8.5');
  });

  it('edit mode: opens Export / Import / Open-for-viewing (with sections + Export\'s .json meta), each wired to its action; re-click + Escape close', async () => {
    const { app } = editApp();
    app.actions = { ...app.actions, exportDashboard: vi.fn(), importDashboard: vi.fn(), openDashboardForViewing: vi.fn() };
    await render(app);
    const btn = qs<HTMLButtonElement>(app.root, '.dash-file-btn');
    openFileMenuBtn(app.root);
    expect(btn.getAttribute('aria-expanded')).toBe('true');
    expect(menuSections()).toEqual(['Export', 'Import', 'Open']);
    expect(menuItems()).toEqual(['Export Dashboard…', 'Import Dashboard…', 'Open for viewing…']);
    expect(qs(document, '.dash-file-menu .fm-meta').textContent).toBe('.json');
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
    expect(menuSections()).toEqual(['Export']);
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
