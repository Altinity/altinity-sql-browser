import { describe, it, expect, vi, afterEach, type Mock } from 'vitest';
import {
  normalizeDashLayout, normalizeDashCols, DASH_TILE_ROW_CAP, DASH_TILE_BYTE_CAP, DASH_TABLE_DISPLAY_CAP,
  activeDashboardView, dashboardViewSelection, partitionKpiBands,
} from '../../src/core/dashboard.js';
import { KEYS } from '../../src/state.js';
import * as storage from '../../src/core/storage.js';
import { CHART_ROW_CAPS } from '../../src/core/chart-data.js';
import { renderDashboard } from '../../src/ui/dashboard.js';
import { applyCommand } from '../../src/dashboard/application/dashboard-commands.js';
import { createQueryResolver } from '../../src/dashboard/application/dashboard-query-resolver.js';
import { resolveLayoutPluginSync } from '../../src/dashboard/layouts/layout-registry.js';
import { applyStreamLine } from '../../src/core/stream.js';
import { emptyRecentMap, recordRecent } from '../../src/core/recent-values.js';
import { makeApp, FakeChart } from '../helpers/fake-app.js';
import { fakeIndexedDbFactory } from '../helpers/fake-idb.js';
import { createApp } from '../../src/ui/app.js';
import { createCodeMirrorEditor } from '../../src/editor/codemirror-adapter.js';
import { savedQuery } from '../helpers/saved-query.js';
import { queryFavorite } from '../../src/core/saved-query.js';
import type { SavedQueryFixture } from '../helpers/saved-query.js';
import type { App } from '../../src/ui/app.types.js';
import type { AppState } from '../../src/state.js';
import type { Column } from '../../src/core/panel-cfg.js';
import type { CreateAppEnv } from '../../src/env.types.js';
import type { ResolvedIdpConfig, ConfigDoc } from '../../src/net/oauth-config.js';
import type { StoredWorkspaceV2 } from '../../src/generated/json-schema.types.js';

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

// ── auth/window fixture helpers ──────────────────────────────────────────────
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

// ── ui/dashboard.js (viewer-driven render, #286 — reads dashboard.tiles[]) ────
// The favorites-derived render was replaced by a DashboardViewerSession bound
// to the persisted StoredWorkspaceV2; these tests drive renderDashboard through
// a controlled current workspace + a fake streaming `executeRead`, exactly as
// the app wires the real repository projection + exec seam.

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
  key?: string;
  tiles?: NonNullable<StoredWorkspaceV2['dashboard']>['tiles'];
  filters?: Record<string, unknown>[];
  layout?: Record<string, unknown>;
  queries?: ReturnType<typeof savedQuery>[];
  title?: string;
}
const wsWith = (over: WsOver = {}) => ({
  storageVersion: 2 as const, id: 'w', key: over.key ?? 'workspace', name: 'W',
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
  commit?: Mock<App['workspace']['commit']>;
  savedQueries?: ReturnType<typeof savedQuery>[];
} = {}) {
  const { executeRead, calls } = makeExec(opts.responder);
  // #344 review fix: `runCommand` now builds its commit candidate through
  // `app.mutateWorkspace`, which reads `app.workspace.loadById()` at
  // DEQUEUE time — the module-default `appDefaults.workspace.loadById`
  // always answers `empty`, so a bare `{ commit }` override (pre-#344's only
  // requirement) would make every `runCommand` dispatch null-abort. `current`
  // is this fixture's own tiny stateful mirror (statefulWorkspaceRepo's same
  // shape, inlined so a caller's custom `opts.commit` — simulating a failure
  // then a success, or a slow-to-resolve first call — still keeps
  // `loadById` in sync: only a genuinely OK result advances `current`,
  // exactly like the real `WorkspaceRepository`).
  let current: StoredWorkspaceV2 | null = (opts.workspace === undefined ? null : opts.workspace) as StoredWorkspaceV2 | null;
  // #341: default commit ECHOES the candidate it was given (mirrors
  // `appDefaults.workspace.commit` in fake-app.ts) — `runCommand`'s post-commit
  // projection (`applyCommittedWorkspace(result.workspace)`, `currentDoc =
  // result.workspace.dashboard`) needs a REAL committed dashboard back, not an
  // opaque `{}`, for projection assertions to be meaningful.
  const commitImpl = opts.commit ?? vi.fn(async (candidate: Parameters<App['workspace']['commit']>[0]) => ({
    ok: true as const, workspace: candidate, dashboardRevision: candidate.dashboard ? candidate.dashboard.revision : null,
  }));
  const commit = vi.fn(async (candidate: Parameters<App['workspace']['commit']>[0]) => {
    const result = await commitImpl(candidate);
    if (result.ok) current = result.workspace;
    return result;
  });
  const app = makeApp({
    exec: { executeRead },
    workspace: {
      commit,
      loadById: async (id) => (
        current?.id === id
          ? { status: 'ok' as const, workspace: current }
          : { status: 'empty' as const }
      ),
    } as Partial<App['workspace']>,
    currentWorkspace: current,
    workspaceRouteStatus: current ? 'ready' : 'not-found',
    sqlRoute: { surface: 'dashboard', workspaceKey: current?.key ?? 'workspace', mode: 'edit' },
  }) as TestApp;
  if (current) app.applyCommittedWorkspace(current);
  if (opts.savedQueries) app.state.savedQueries = opts.savedQueries as AppState['savedQueries'];
  const loadActive = async (): Promise<StoredWorkspaceV2> => {
    const loaded = await app.workspace.loadById(app.state.workspaceId);
    if (loaded.status !== 'ok') throw new Error(`Expected active workspace, got ${loaded.status}`);
    return loaded.workspace;
  };
  return { app, calls, commit, loadActive };
}

const render = (app: TestApp): Promise<void> => renderDashboard(app as unknown as Parameters<typeof renderDashboard>[0]);
// #341: `runCommand` now commits through `app.serializeWrite` (a real
// microtask-chained queue, same as saved-history.test.ts's own convention) —
// a synchronous assertion right after triggering a command can no longer
// observe `commit` having been called; a macrotask flush lets every pending
// microtask (the queue + the commit promise + its projection callback) run.
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
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
function stubTileRects(cards: HTMLElement[], offset = 0): void {
  cards.forEach((card, i) => {
    const slot = i + offset;
    const rect = {
      left: slot * 200, right: slot * 200 + 150, top: 0, bottom: 50, width: 150, height: 50, x: slot * 200, y: 0,
      toJSON: () => ({}),
    } as DOMRect;
    card.getBoundingClientRect = () => rect;
  });
}
function stubKpiMemberRects(members: HTMLElement[]): void {
  members.forEach((member, i) => {
    const left = i * 200;
    const child = qs<HTMLElement>(member, '.kpi-card, .dash-kpi-state-card');
    child.getBoundingClientRect = () => ({
      left, right: left + 150, top: 0, bottom: 50, width: 150, height: 50, x: left, y: 0,
      toJSON: () => ({}),
    }) as DOMRect;
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

  it('uses the library name when the dashboard title is empty', async () => {
    const { app } = dashApp({ workspace: wsWith({ title: '', tiles: [] }) });
    await render(app);
    expect(qs(app.root, '.dash-title')?.textContent).toBe('W');
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
    const btn = qs(app.root, '.hd-btn[title="Toggle theme"]');
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
    await flush();
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
    expect(cards[0].classList.contains('dash-floating')).toBe(false);
  });

  it('ignores non-primary presses and presses originating on tile action chrome', async () => {
    const { app, commit } = dashApp({ workspace: twoTiles() });
    await render(app);
    const card = qs<HTMLElement>(app.root, '.dash-tile');
    const right = new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 1, metaKey: true });
    card.dispatchEvent(right);
    expect(right.defaultPrevented).toBe(false);
    const action = document.createElement('button');
    action.className = 'dash-gg-del';
    card.appendChild(action);
    const actionDown = new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, metaKey: true });
    action.dispatchEvent(actionDown);
    expect(actionDown.defaultPrevented).toBe(false);
    expect(commit).not.toHaveBeenCalled();
  });

  it('forces a real box while dragging a card whose computed display is contents', async () => {
    const { app } = dashApp({ workspace: twoTiles() });
    await render(app);
    const cards = qsa<HTMLElement>(app.root, '.dash-tile');
    stubTileRects(cards);
    const original = window.getComputedStyle.bind(window);
    const styleSpy = vi.spyOn(window, 'getComputedStyle').mockImplementation((el) => {
      const style = original(el);
      return el === cards[0] ? new Proxy(style, { get: (target, key) => key === 'display' ? 'contents' : Reflect.get(target, key) }) : style;
    });
    pointerDragTo(cards, 0, tileCenter(1), { metaKey: true });
    expect(cards[0].style.display).toBe(''); // cleanup restores the pre-drag style
    styleSpy.mockRestore();
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
    await flush();
    expect(commit).toHaveBeenCalled(); // new order persisted
  });

  it('Ctrl-drag (ctrlKey) completes a move and persists the new order', async () => {
    const { app, commit } = dashApp({ workspace: twoTiles() });
    await render(app);
    const cards = qsa(app.root, '.dash-tile');
    stubTileRects(cards);
    dragTile(cards, 1, 0, { ctrlKey: true });
    expect(order(app)).toEqual(['q2', 'q1']);
    await flush();
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
    expect(cards[0].classList.contains('dash-floating')).toBe(false);
    expect(qs(app.root, '.dash-grid')?.classList.contains('dash-reordering')).toBe(false);
  });

  it('a completed move dispatches move-tile exactly once', async () => {
    const { app, commit } = dashApp({ workspace: twoTiles() });
    await render(app);
    const cards = qsa(app.root, '.dash-tile');
    stubTileRects(cards);
    dragTile(cards, 1, 0);
    expect(order(app)).toEqual(['q2', 'q1']);
    await flush();
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
    expect(cards[0].classList.contains('dash-floating')).toBe(true);
    expect(cards[0].style.position).toBe('fixed');
    expect(qs(app.root, '.dash-grid')?.classList.contains('dash-reordering')).toBe(true);
    window.dispatchEvent(new PointerEvent('pointercancel'));
    expect(order(app)).toEqual(['q1', 'q2']);
    expect(commit).not.toHaveBeenCalled();
    expect(cards[0].classList.contains('dash-floating')).toBe(false);
    expect(cards[0].style.position).toBe('');
    expect(cards[0].style.transform).toBe('');
    expect(cards[0].style.height).toBe('');
    expect(cards[0].style.display).toBe('');
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
    expect(cards[0].classList.contains('dash-floating')).toBe(false);
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
    expect(cards[0].classList.contains('dash-floating')).toBe(false);
    expect(qs(app.root, '.dash-grid')?.classList.contains('dash-reordering')).toBe(false);
  });

  it('lost pointer capture and a route rerender both cancel active movement and release gesture ownership', async () => {
    const { app, commit } = dashApp({ workspace: twoTiles() });
    await render(app);
    let cards = qsa<HTMLElement>(app.root, '.dash-tile');
    stubTileRects(cards);
    qs(app.root, '.dash-topbar').remove(); // auto-scroll target also supports no sticky chrome
    const setCapture = vi.fn();
    const releaseCapture = vi.fn();
    cards[0].setPointerCapture = setCapture;
    cards[0].hasPointerCapture = () => true;
    cards[0].releasePointerCapture = releaseCapture;
    const start = tileCenter(0);
    cards[0].dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true, cancelable: true, button: 0, pointerId: 7,
      clientX: start.x, clientY: start.y, metaKey: true,
    }));
    window.dispatchEvent(new PointerEvent('pointermove', { pointerId: 7, clientX: start.x + 10, clientY: start.y }));
    expect(setCapture).toHaveBeenCalledWith(7);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(cards[0].classList.contains('dash-floating')).toBe(true); // only Escape cancels
    cards[0].dispatchEvent(new PointerEvent('lostpointercapture', { pointerId: 7 }));
    expect(cards[0].classList.contains('dash-floating')).toBe(false);
    expect(releaseCapture).toHaveBeenCalledWith(7);

    // Arm a second gesture and rerender the route while it is active. The
    // module-level teardown hook must synchronously cancel the old listeners.
    cards = qsa<HTMLElement>(app.root, '.dash-tile');
    stubTileRects(cards);
    cards[0].dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true, cancelable: true, button: 0, pointerId: 8,
      clientX: start.x, clientY: start.y, metaKey: true,
    }));
    window.dispatchEvent(new PointerEvent('pointermove', { pointerId: 8, clientX: start.x + 10, clientY: start.y }));
    expect(cards[0].classList.contains('dash-floating')).toBe(true);
    await render(app);
    expect(cards[0].classList.contains('dash-floating')).toBe(false);
    expect(commit).not.toHaveBeenCalled();
  });

  it('the dragged tile floats (position:fixed) and its transform follows the pointer during a flow drag', async () => {
    const { app } = dashApp({ workspace: twoTiles() });
    await render(app);
    const cards = qsa(app.root, '.dash-tile');
    stubTileRects(cards);
    const start = tileCenter(0);
    cards[0].dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true, cancelable: true, button: 0, clientX: start.x, clientY: start.y, metaKey: true,
    }));
    // Cross the threshold — beginMove lifts the card to a fixed follower.
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: start.x + 10, clientY: start.y }));
    expect(cards[0].classList.contains('dash-floating')).toBe(true);
    expect(cards[0].style.position).toBe('fixed');
    // A further move updates the follower transform to the new pointer delta.
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: start.x + 37, clientY: start.y + 11 }));
    expect(cards[0].style.transform).toBe('translate(37px,11px)');
    window.dispatchEvent(new PointerEvent('pointercancel'));
    expect(cards[0].classList.contains('dash-floating')).toBe(false);
    expect(cards[0].style.transform).toBe('');
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
    await flush();
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it('a flow-engine KPI member participates in modifier movement and destination hit-testing (#340)', async () => {
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
    // The KPI tile renders through its `.dash-kpi-member`, not the detached
    // cached `.dash-tile`. Its rendered host is now the movement surface and
    // the hit-test rect for canonical ordering.
    const cards = qsa(app.root, '.dash-tile');
    expect(cards.length).toBe(2);
    const member = qs<HTMLElement>(app.root, '.dash-kpi-member');
    const surfaces = [member, ...cards];
    stubKpiMemberRects([member]);
    stubTileRects(cards, 1);
    const down = pointerDragTo(surfaces, 0, tileCenter(2), { metaKey: true });
    expect(down.defaultPrevented).toBe(true);
    await flush();
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit.mock.calls[0][0].dashboard?.tiles.map((tile) => tile.id)).toEqual(['t1', 't2', 't0']);
    expect(qsa(app.root, '.dash-kpi-member')).toHaveLength(1); // band regrouped after commit
  });

  it('read-only dashboard: ⌘-drag does not move and no drag listeners are wired', async () => {
    const detached = twoTiles();
    const { app, commit } = modeApp({
      workspace: detached, mode: 'view',
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
      workspace: detached, mode: 'view',
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
      workspace: detached, mode: 'view',
      responder: () => ({ columns: [{ name: 'k', type: 'String' }, { name: 'v', type: 'UInt64' }], rows: [['hello', 42]] }),
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
    await flush();
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
    for (const member of members) {
      expect(member.getAttribute('role')).toBe('group');
      expect(member.getAttribute('aria-label')).toMatch(/^k[12]$/);
    }
    expect(qs(app.root, '.dash-kpi-band .dash-gg-grip')).toBeNull();
  });

  it.each(['report', 'columns-2', 'columns-3'] as const)(
    'moves a KPI-band member with Command-drag in %s and commits once',
    async (preset) => {
      const { app, commit } = dashApp({
        responder: () => ({ columns: [{ name: 'value', type: 'UInt64' }], rows: [[42]] }),
        workspace: wsWith({
          queries: [
            q('k1', 'SELECT 1 AS value', { panel: { cfg: { type: 'kpi' } } }),
            q('k2', 'SELECT 2 AS value', { panel: { cfg: { type: 'kpi' } } }),
          ],
          tiles: [{ id: 't1', queryId: 'k1' }, { id: 't2', queryId: 'k2' }],
          layout: { type: 'flow', version: 1, preset, items: {} },
        }),
      });
      await render(app);
      const members = qsa<HTMLElement>(app.root, '.dash-kpi-member');
      stubKpiMemberRects(members);
      pointerDragTo(members, 1, tileCenter(0), { metaKey: true });
      await flush();
      expect(commit).toHaveBeenCalledTimes(1);
      expect(commit.mock.calls[0][0].dashboard?.tiles.map((tile) => tile.id)).toEqual(['t2', 't1']);
      expect(qsa<HTMLElement>(app.root, '.dash-kpi-member').map((member) => member.dataset.tile)).toEqual(['t2', 't1']);
    },
  );

  it('plain KPI text drag remains selection-owned and dispatches no move', async () => {
    const { app, commit } = dashApp({
      responder: () => ({ columns: [{ name: 'value', type: 'UInt64' }], rows: [[42]] }),
      workspace: wsWith({
        queries: [q('k1', 'SELECT 1 AS value', { panel: { cfg: { type: 'kpi' } } }), q('k2', 'SELECT 2 AS value', { panel: { cfg: { type: 'kpi' } } })],
        tiles: [{ id: 't1', queryId: 'k1' }, { id: 't2', queryId: 'k2' }],
      }),
    });
    await render(app);
    const members = qsa<HTMLElement>(app.root, '.dash-kpi-member');
    stubKpiMemberRects(members);
    const value = qs<HTMLElement>(members[0], '.kpi-value');
    const start = tileCenter(0);
    const down = new PointerEvent('pointerdown', {
      bubbles: true, cancelable: true, button: 0, clientX: start.x, clientY: start.y,
    });
    value.dispatchEvent(down);
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: tileCenter(1).x, clientY: tileCenter(1).y }));
    window.dispatchEvent(new PointerEvent('pointerup', { clientX: tileCenter(1).x, clientY: tileCenter(1).y }));
    expect(down.defaultPrevented).toBe(false);
    expect(commit).not.toHaveBeenCalled();
    expect(members[0].classList.contains('dash-floating')).toBe(false);
  });

  it('a moving display:contents KPI member gets a measured temporary box and cancellation restores every style', async () => {
    const { app, commit } = dashApp({
      responder: () => ({ columns: [{ name: 'value', type: 'UInt64' }], rows: [[42]] }),
      workspace: wsWith({
        queries: [q('k1', 'SELECT 1 AS value', { panel: { cfg: { type: 'kpi' } } }), q('k2', 'SELECT 2 AS value', { panel: { cfg: { type: 'kpi' } } })],
        tiles: [{ id: 't1', queryId: 'k1' }, { id: 't2', queryId: 'k2' }],
      }),
    });
    await render(app);
    const members = qsa<HTMLElement>(app.root, '.dash-kpi-member');
    stubKpiMemberRects(members);
    const original = window.getComputedStyle.bind(window);
    const styleSpy = vi.spyOn(window, 'getComputedStyle').mockImplementation((el) => {
      const style = original(el);
      return el === members[0] ? new Proxy(style, { get: (target, key) => key === 'display' ? 'contents' : Reflect.get(target, key) }) : style;
    });
    const start = tileCenter(0);
    members[0].dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true, cancelable: true, button: 0, clientX: start.x, clientY: start.y, metaKey: true,
    }));
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: start.x + 10, clientY: start.y + 5 }));
    expect(members[0].classList.contains('dash-floating')).toBe(true);
    expect(members[0].style.display).toBe('flex');
    expect(members[0].style.width).toBe('150px');
    expect(members[0].style.height).toBe('50px');
    window.dispatchEvent(new PointerEvent('pointercancel'));
    expect(members[0].classList.contains('dash-floating')).toBe(false);
    expect(members[0].getAttribute('style') ?? '').toBe('');
    expect(commit).not.toHaveBeenCalled();
    styleSpy.mockRestore();
  });

  it('hit-tests the individual cards of a wrapped multi-card KPI member, not the empty holes in their union', async () => {
    const { app, commit } = dashApp({
      responder: (sql) => sql.includes('multi')
        ? { columns: [{ name: 'a', type: 'UInt64' }, { name: 'b', type: 'UInt64' }], rows: [[1, 2]] }
        : { columns: [{ name: 'c', type: 'UInt64' }], rows: [[3]] },
      workspace: wsWith({
        queries: [
          q('k1', 'SELECT multi', { panel: { cfg: { type: 'kpi' } } }),
          q('k2', 'SELECT single', { panel: { cfg: { type: 'kpi' } } }),
        ],
        tiles: [{ id: 't1', queryId: 'k1' }, { id: 't2', queryId: 'k2' }],
      }),
    });
    await render(app);
    const [multi, single] = qsa<HTMLElement>(app.root, '.dash-kpi-member');
    const multiCards = qsa<HTMLElement>(multi, '.kpi-card');
    expect(multiCards).toHaveLength(2);
    // The union of these two wrapped cards is x:0..350/y:0..150. The single
    // tile occupies the otherwise-empty lower-right hole in that union.
    const rect = (left: number, top: number): DOMRect => ({
      left, right: left + 150, top, bottom: top + 50, width: 150, height: 50, x: left, y: top,
      toJSON: () => ({}),
    }) as DOMRect;
    multiCards[0].getBoundingClientRect = () => rect(200, 0);
    multiCards[1].getBoundingClientRect = () => rect(0, 100);
    qs<HTMLElement>(single, '.kpi-card').getBoundingClientRect = () => rect(200, 100);
    multi.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true, cancelable: true, button: 0, clientX: 275, clientY: 25, metaKey: true,
    }));
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: 275, clientY: 125 }));
    expect(single.classList.contains('dash-drop-target')).toBe(true);
    window.dispatchEvent(new PointerEvent('pointerup', { clientX: 275, clientY: 125 }));
    await flush();
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit.mock.calls[0][0].dashboard?.tiles.map((tile) => tile.id)).toEqual(['t2', 't1']);
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
    // change recreates session + tile DOM — dashApp's current workspace reads
    // `ws` by reference, so mutating it in place and re-rendering
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

  // #340: the tile shell for a grafana-grid KPI tile is frameless in both edit
  // and view modes. Edit title/delete/resize chrome remains in the DOM as an
  // overlay, but KPI movement is modifier-only and therefore has no grip.
  const kpiGridWs = () => wsWith({
    queries: [q('k1', 'SELECT 1 AS value', { panel: { cfg: { type: 'kpi' } } })],
    tiles: [{ id: 't1', queryId: 'k1' }],
    layout: { type: 'grafana-grid', version: 1, items: { t1: { span: 4, height: 3 } } },
  });
  const kpiResponder: ExecResponder = () => ({ columns: [{ name: 'value', type: 'UInt64' }], rows: [[42]] });

  it('edit mode: a KPI grid tile has overlay controls, no grip, a named structural wrapper, and no footer (#340)', async () => {
    const { app } = dashApp({ responder: kpiResponder, workspace: kpiGridWs() });
    await render(app);
    const card = qs<HTMLElement>(app.root, '.dash-gg-tile');
    expect(card.classList.contains('is-kpi')).toBe(true);
    expect(card.classList.contains('is-view')).toBe(false); // edit mode — not the view-mode modifier
    expect(qs(card, '.dash-tile-head')).not.toBeNull(); // overlay host retained
    expect(qs(card, '.dash-tile-name')?.textContent).toBe('k1');
    expect(qs(card, '.dash-gg-grip')).toBeNull(); // modifier movement only
    expect(qs(card, '.dash-gg-del')).not.toBeNull(); // remove retained
    const resize = qs<HTMLElement>(card, '.dash-gg-resize');
    expect(resize).not.toBeNull(); // resize retained
    expect(resize.tagName).toBe('BUTTON');
    expect(resize.tabIndex).toBe(0);
    expect(card.getAttribute('role')).toBe('group');
    expect(card.getAttribute('aria-label')).toBe('k1');
    expect(card.title).toBe('Command/Ctrl-drag to move');
    const foot = qs<HTMLElement>(card, '.dash-tile-foot');
    expect(foot.hidden).toBe(true); // suppressed at the DOM level, not just visually
    expect(foot.childNodes.length).toBe(0);
  });

  it('grid KPI tiles move only with a modifier body drag and commit exactly once (#340)', async () => {
    const { app, commit } = dashApp({
      responder: kpiResponder,
      workspace: wsWith({
        queries: [
          q('k1', 'SELECT 1 AS value', { panel: { cfg: { type: 'kpi' } } }),
          q('k2', 'SELECT 2 AS value', { panel: { cfg: { type: 'kpi' } } }),
        ],
        tiles: [{ id: 't1', queryId: 'k1' }, { id: 't2', queryId: 'k2' }],
        layout: { type: 'grafana-grid', version: 1, items: {} },
      }),
    });
    await render(app);
    const cards = qsa<HTMLElement>(app.root, '.dash-gg-tile');
    stubTileRects(cards);
    expect(qsa(app.root, '.dash-gg-grip')).toHaveLength(0);
    const plain = pointerDragTo(cards, 0, tileCenter(1), {});
    expect(plain.defaultPrevented).toBe(false);
    expect(commit).not.toHaveBeenCalled();
    gridDrag(cards, 0, 1, { viaGrip: false });
    await flush();
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit.mock.calls[0][0].dashboard?.tiles.map((tile) => tile.id)).toEqual(['t2', 't1']);
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
      workspace: detached, mode: 'view', responder: kpiResponder,
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
    await flush();
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
      workspace: detached, mode: 'view',
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
    await flush();
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
    const secondary = new PointerEvent('pointerdown', { button: 2, clientX: 0, clientY: 0, cancelable: true });
    handle.dispatchEvent(secondary);
    expect(secondary.defaultPrevented).toBe(false);
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
    await flush();
    expect(commit).toHaveBeenCalledTimes(1); // exactly one update-placement dispatch
    // The committed placement survives reconciliation (re-derived from state,
    // reverting to the ordinary un-pinned `span N` the normal reconciler writes).
    const after = qsa<HTMLElement>(app.root, '.dash-gg-tile')[0];
    expect((after.style as CSSStyleDeclaration).gridColumn).toBe('span 6');
    expect((after.style as CSSStyleDeclaration).height).toBe('296px');
  });

  it.each(['pointercancel', 'blur', 'Escape', 'lostpointercapture', 'rerender'] as const)(
    'a resize cancelled by %s restores placement and never commits later',
    async (reason) => {
      const { app, commit } = dashApp({ workspace: twoTilesGrid() });
      await render(app);
      const gridEl = qs(app.root, '.dash-gg-grid');
      Object.defineProperty(gridEl, 'clientWidth', { value: 1200, configurable: true });
      const card = qsa<HTMLElement>(app.root, '.dash-gg-tile')[0];
      const handle = qs<HTMLElement>(card, '.dash-gg-resize');
      const release = vi.fn();
      handle.setPointerCapture = vi.fn();
      handle.hasPointerCapture = () => true;
      handle.releasePointerCapture = release;
      handle.dispatchEvent(new PointerEvent('pointerdown', { button: 0, pointerId: 9, clientX: 0, clientY: 0 }));
      window.dispatchEvent(new PointerEvent('pointermove', { pointerId: 9, clientX: 600, clientY: 280 }));
      expect(card.classList.contains('dash-gg-resizing')).toBe(true);
      if (reason === 'pointercancel') window.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 9 }));
      else if (reason === 'blur') window.dispatchEvent(new Event('blur'));
      else if (reason === 'Escape') document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      else if (reason === 'lostpointercapture') handle.dispatchEvent(new PointerEvent('lostpointercapture', { pointerId: 9 }));
      else await render(app);
      expect(card.classList.contains('dash-gg-resizing')).toBe(false);
      expect(card.style.gridColumn).toBe('span 4');
      expect(card.style.height).toBe('120px');
      expect(release).toHaveBeenCalledWith(9);
      window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 9 }));
      await flush();
      expect(commit).not.toHaveBeenCalled();
    },
  );

  it('keyboard arrows resize a focused handle; Full view ignores horizontal arrows', async () => {
    const { app, commit } = dashApp({ workspace: twoTilesGrid() });
    await render(app);
    let handle = qs<HTMLButtonElement>(app.root, '.dash-gg-resize');
    const lastPlacement = (): { span: number; height: number } | undefined => {
      const layout = commit.mock.calls.at(-1)?.[0].dashboard?.layout as { items?: Record<string, { span: number; height: number }> } | undefined;
      return layout?.items?.t1;
    };
    const press = (key: string): KeyboardEvent => {
      const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
      handle.dispatchEvent(event);
      return event;
    };
    expect(press('Home').defaultPrevented).toBe(false);
    expect(press('ArrowRight').defaultPrevented).toBe(true);
    await flush();
    expect(lastPlacement()?.span).toBe(5);
    handle = qs<HTMLButtonElement>(app.root, '.dash-gg-resize');
    press('ArrowLeft');
    await flush();
    expect(lastPlacement()?.span).toBe(4);
    handle = qs<HTMLButtonElement>(app.root, '.dash-gg-resize');
    press('ArrowDown');
    await flush();
    expect(lastPlacement()?.height).toBe(2);
    handle = qs<HTMLButtonElement>(app.root, '.dash-gg-resize');
    press('ArrowUp');
    await flush();
    expect(lastPlacement()?.height).toBe(1);
    handle = qs<HTMLButtonElement>(app.root, '.dash-gg-resize');
    const atMinCount = commit.mock.calls.length;
    expect(press('ArrowUp').defaultPrevented).toBe(true);
    expect(commit).toHaveBeenCalledTimes(atMinCount);

    pickLayout(app.root, 'full');
    await flush();
    handle = qs<HTMLButtonElement>(app.root, '.dash-gg-resize');
    const before = commit.mock.calls.length;
    expect(press('ArrowRight').defaultPrevented).toBe(false);
    expect(commit).toHaveBeenCalledTimes(before);
    expect(press('ArrowDown').defaultPrevented).toBe(true);
    await flush();
    const fullPlacement = lastPlacement();
    expect(fullPlacement).toEqual({ span: 4, height: 2 });
  });

  it('keyboard span resize preserves authored intent under a narrow responsive clamp', async () => {
    const workspace = wsWith({
      queries: [q('q1', 'SELECT 1')], tiles: [{ id: 't1', queryId: 'q1' }],
      layout: { type: 'grafana-grid', version: 1, items: { t1: { span: 12, height: 2 } } },
    });
    const { app, commit } = dashApp({ workspace });
    await render(app);
    const gridEl = qs<HTMLElement>(app.root, '.dash-gg-grid');
    Object.defineProperty(gridEl, 'clientWidth', { value: 600, configurable: true }); // effective 4 columns
    window.dispatchEvent(new Event('resize'));
    await Promise.resolve(); await Promise.resolve();
    expect(qs<HTMLElement>(app.root, '.dash-gg-tile').style.gridColumn).toBe('span 4');
    const handle = qs<HTMLButtonElement>(app.root, '.dash-gg-resize');
    const right = new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true });
    handle.dispatchEvent(right);
    expect(right.defaultPrevented).toBe(true);
    expect(commit).not.toHaveBeenCalled(); // authored span already at the 12-column maximum
    handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }));
    await flush();
    const layout = commit.mock.calls[0][0].dashboard?.layout as unknown as { items: Record<string, { span: number }> };
    expect(layout.items.t1.span).toBe(11); // authored 12→11, never effective 4→3
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
    await flush();
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
    const key = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true });
    handle.dispatchEvent(key);
    expect(key.defaultPrevented).toBe(false);
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

describe('renderDashboard — Text (Markdown) tile preview (#332)', () => {
  const textWs = (content: string) => wsWith({
    queries: [q('tq', "SELECT '' AS body", { panel: { cfg: { type: 'text', content } } })],
    tiles: [{ id: 't1', queryId: 'tq' }],
    layout: { type: 'grafana-grid', version: 1, items: {} },
  });

  it('renders the Text tile inline through the shared doc viewer (.md-view > .docs-md)', async () => {
    const { app } = dashApp({ responder: () => ({}), workspace: textWs('# Title\n\n- one\n- two') });
    await render(app);
    const view = qs(app.root, '.dash-tile-body .md-view .docs-md');
    expect(view).not.toBeNull();
    expect(qs(view, 'h4')?.textContent).toBe('Title'); // doc viewer offsets headings
    expect(qsa(view, 'li').length).toBe(2);
  });

  it('clicking the Text tile opens the shared cell-detail drawer with the rendered Markdown', async () => {
    document.querySelectorAll('.cd-backdrop').forEach((b) => b.remove());
    const { app } = dashApp({ responder: () => ({}), workspace: textWs('# Hi\n\n- a\n- b') });
    await render(app);
    const mdView = qs<HTMLElement>(app.root, '.dash-tile-body .md-view');
    expect(mdView.getAttribute('role')).toBe('button');
    expect(mdView.getAttribute('tabindex')).toBe('0');
    mdView.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    const bd = qs(document, '.cd-backdrop');
    expect(bd).not.toBeNull();
    expect(qs(bd, '.docs-md h4')?.textContent).toBe('Hi');
    bd.remove();
  });

  it('Enter/Space open the drawer; other keys do not', async () => {
    document.querySelectorAll('.cd-backdrop').forEach((b) => b.remove());
    const { app } = dashApp({ responder: () => ({}), workspace: textWs('# K') });
    await render(app);
    const mdView = qs<HTMLElement>(app.root, '.dash-tile-body .md-view');
    mdView.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    expect(qs(document, '.cd-backdrop')).toBeNull();
    mdView.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(qs(document, '.cd-backdrop')).not.toBeNull();
    qs(document, '.cd-backdrop').remove();
    mdView.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    expect(qs(document, '.cd-backdrop')).not.toBeNull();
    qs(document, '.cd-backdrop').remove();
  });

  it('a click on an inner link, and a click while text is selected, do NOT open the drawer', async () => {
    document.querySelectorAll('.cd-backdrop').forEach((b) => b.remove());
    const { app } = dashApp({ responder: () => ({}), workspace: textWs('see [docs](https://example.com/x)') });
    await render(app);
    const mdView = qs<HTMLElement>(app.root, '.dash-tile-body .md-view');
    // Inner link click → defers to the link, no drawer.
    qs(mdView, 'a').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(qs(document, '.cd-backdrop')).toBeNull();
    // A click that ends a text selection → no drawer (selection guard).
    const realGetSel = document.getSelection.bind(document);
    document.getSelection = () => ({ isCollapsed: false, toString: () => 'selected' }) as unknown as Selection;
    try {
      mdView.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      expect(qs(document, '.cd-backdrop')).toBeNull();
    } finally {
      document.getSelection = realGetSel;
    }
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
    await flush();
    expect(commit).toHaveBeenCalled();
    // Restore ran: no placeholder left, floating styles cleared.
    expect(qsa(app.root, '.dash-tile-placeholder').length).toBe(0);
    expect(qsa(app.root, '.dash-tile.dash-floating').length).toBe(0);
  });

  it('floats the tile at its HOME left, not the placeholder-displaced left (r0 captured pre-placeholder)', async () => {
    // Real-browser regression: `grid.insertBefore(placeholder, card)` pushes the
    // card into the NEXT CSS-grid cell, so the home rect MUST be read before the
    // placeholder is inserted — else the fixed `left` is a column off and the
    // floated tile sits horizontally offset from the cursor (vertical stays
    // fine, same row). happy-dom ignores grid layout, so model the displacement:
    // the dragged card reports HOME left until a `.dash-tile-placeholder` exists.
    const { app } = dashApp({ workspace: gridWs() });
    await render(app);
    const cards = qsa<HTMLElement>(app.root, '.dash-gg-tile');
    stubTileRects(cards);
    const grid = qs<HTMLElement>(app.root, '.dash-grid');
    const HOME_LEFT = 20, DISPLACED_LEFT = 431; // displaced = one column+gap over
    cards[0].getBoundingClientRect = () => {
      const left = grid.querySelector('.dash-tile-placeholder') ? DISPLACED_LEFT : HOME_LEFT;
      return { left, right: left + 150, top: 0, bottom: 50, width: 150, height: 50, x: left, y: 0, toJSON: () => ({}) } as DOMRect;
    };
    const grip = qs(cards[0], '.dash-gg-grip');
    grip.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, clientX: HOME_LEFT + 10, clientY: 25 }));
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: HOME_LEFT + 20, clientY: 25 })); // crosses threshold → beginMove floats
    expect(cards[0].style.position).toBe('fixed');
    expect(qsa(app.root, '.dash-tile-placeholder').length).toBe(1); // placeholder IS inserted…
    expect(cards[0].style.left).toBe(HOME_LEFT + 'px'); // …but the float used the pre-placeholder home left
    window.dispatchEvent(new PointerEvent('pointerup', { clientX: HOME_LEFT + 20, clientY: 25 }));
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
    await flush();
    expect(commit).toHaveBeenCalled();
  });

  it('⌘-drag on the tile body also arms the grafana-grid reflow drag', async () => {
    const { app, commit } = dashApp({ workspace: gridWs() });
    await render(app);
    const cards = qsa<HTMLElement>(app.root, '.dash-gg-tile');
    stubTileRects(cards);
    gridDrag(cards, 0, 2, { viaGrip: false }); // ⌘ + body
    expect(order(app)).toEqual(['q2', 'q3', 'q1']);
    await flush();
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
      await flush();
      expect(commit).toHaveBeenCalled();
    } finally {
      win.matchMedia = realMatchMedia;
    }
  });
});

// #338: edge auto-scroll while a tile move is active. `wireTileDrag`
// (ui/dashboard.ts) resolves `.dash-page` at pointerdown runtime, so these
// tests stub its geometry (happy-dom returns an all-zero rect and readonly-0
// scroll metrics otherwise) BEFORE arming a drag, and install a manually
// drained fake `requestAnimationFrame`/`cancelAnimationFrame` on `window` (the
// same `win` `wireTileDrag` resolves via `doc.defaultView || window`) so the
// auto-scroll controller's frame loop never actually waits on a real paint.
/** Stubs `.dash-page`'s viewport rect and scroll metrics. `top`/`bottom` are
 *  the STUBBED `getBoundingClientRect` (the auto-scroll target's visible
 *  viewport, sans any topbar offset — the topbar's `offsetHeight` is left at
 *  happy-dom's real 0 default, so `visibleTop` here IS the page top). */
function stubScrollHost(
  page: HTMLElement,
  opts: { top?: number; bottom?: number; scrollHeight?: number; clientHeight?: number; scrollTop?: number } = {},
): void {
  const top = opts.top ?? 0;
  const bottom = opts.bottom ?? 400;
  const rect = { top, bottom, left: 0, right: 800, width: 800, height: bottom - top, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
  page.getBoundingClientRect = () => rect;
  Object.defineProperty(page, 'scrollHeight', { value: opts.scrollHeight ?? 2000, configurable: true });
  Object.defineProperty(page, 'clientHeight', { value: opts.clientHeight ?? (bottom - top), configurable: true });
  let st = opts.scrollTop ?? 0;
  Object.defineProperty(page, 'scrollTop', { get: () => st, set: (v: number) => { st = v; }, configurable: true });
}

/** Installs a manually-drained fake rAF pair on `win`, returning `flush()` (run
 *  every queued callback once — one simulated paint tick), `pending` (queue
 *  size, for single-loop assertions), and `restore()` (put the real pair back
 *  — call in a `finally`, mirroring the `matchMedia` stub/restore above). */
function fakeRaf(win: Window & typeof globalThis) {
  let queue: { id: number; cb: FrameRequestCallback }[] = [];
  let nextId = 1;
  const realRaf = win.requestAnimationFrame;
  const realCaf = win.cancelAnimationFrame;
  win.requestAnimationFrame = ((cb: FrameRequestCallback): number => {
    const id = nextId++;
    queue.push({ id, cb });
    return id;
  }) as typeof win.requestAnimationFrame;
  win.cancelAnimationFrame = ((id: number): void => {
    queue = queue.filter((q) => q.id !== id);
  }) as typeof win.cancelAnimationFrame;
  return {
    flush(): void { const run = queue; queue = []; for (const q of run) q.cb(0); },
    get pending(): number { return queue.length; },
    restore(): void { win.requestAnimationFrame = realRaf; win.cancelAnimationFrame = realCaf; },
  };
}

describe('renderDashboard — drag auto-scroll (#338)', () => {
  const gridWs = () => wsWith({
    queries: [q('q1', 'SELECT k FROM a'), q('q2', 'SELECT k FROM b'), q('q3', 'SELECT k FROM c')],
    tiles: [{ id: 't1', queryId: 'q1' }, { id: 't2', queryId: 'q2' }, { id: 't3', queryId: 'q3' }],
    layout: { type: 'grafana-grid', version: 1, items: {} },
  });
  const order = (app: TestApp): string[] => qsa(app.root, '.dash-gg-tile .dash-tile-name').map((n) => n.textContent || '');

  it('a stationary pointer near the bottom edge scrolls .dash-page down after flushing rAF frames', async () => {
    const { app, commit } = dashApp({ workspace: gridWs() });
    await render(app);
    const cards = qsa<HTMLElement>(app.root, '.dash-gg-tile');
    stubTileRects(cards);
    const page = qs<HTMLElement>(app.root, '.dash-page');
    stubScrollHost(page, { top: 0, bottom: 400 }); // room below to scroll (scrollHeight 2000 > clientHeight 400)
    const raf = fakeRaf(window);
    try {
      const grip = qs(cards[0], '.dash-gg-grip');
      const from = tileCenter(0);
      grip.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, clientX: from.x, clientY: from.y }));
      window.dispatchEvent(new PointerEvent('pointermove', { clientX: from.x + 10, clientY: from.y })); // cross threshold
      // Pointer at y=390: inside the bottom 80px edge zone of [0,400].
      window.dispatchEvent(new PointerEvent('pointermove', { clientX: from.x + 10, clientY: 390 }));
      expect(page.scrollTop).toBe(0);
      raf.flush();
      expect(page.scrollTop).toBeGreaterThan(0);
      const afterOne = page.scrollTop;
      raf.flush(); // stationary pointer keeps scrolling frame after frame
      expect(page.scrollTop).toBeGreaterThan(afterOne);
      // Release outside every stubbed tile rect so no move commits (irrelevant
      // to this assertion — just clean teardown).
      window.dispatchEvent(new PointerEvent('pointerup', { clientX: OUTSIDE_ALL_TILES.x, clientY: OUTSIDE_ALL_TILES.y }));
      expect(commit).not.toHaveBeenCalled();
    } finally {
      raf.restore();
    }
  });

  it('after scrolling down, a stationary pointer near the top edge scrolls back up', async () => {
    const { app } = dashApp({ workspace: gridWs() });
    await render(app);
    const cards = qsa<HTMLElement>(app.root, '.dash-gg-tile');
    stubTileRects(cards);
    const page = qs<HTMLElement>(app.root, '.dash-page');
    stubScrollHost(page, { top: 0, bottom: 400, scrollTop: 500 }); // already scrolled down
    const raf = fakeRaf(window);
    try {
      const grip = qs(cards[0], '.dash-gg-grip');
      const from = tileCenter(0);
      grip.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, clientX: from.x, clientY: from.y }));
      window.dispatchEvent(new PointerEvent('pointermove', { clientX: from.x + 10, clientY: from.y }));
      // Pointer at y=10: inside the top 80px edge zone.
      window.dispatchEvent(new PointerEvent('pointermove', { clientX: from.x + 10, clientY: 10 }));
      const before = page.scrollTop;
      raf.flush();
      expect(page.scrollTop).toBeLessThan(before);
      window.dispatchEvent(new PointerEvent('pointerup', { clientX: OUTSIDE_ALL_TILES.x, clientY: OUTSIDE_ALL_TILES.y }));
    } finally {
      raf.restore();
    }
  });

  it('a plain drag that never crosses the move threshold never starts auto-scroll', async () => {
    const { app } = dashApp({ workspace: gridWs() });
    await render(app);
    const cards = qsa<HTMLElement>(app.root, '.dash-gg-tile');
    stubTileRects(cards);
    const page = qs<HTMLElement>(app.root, '.dash-page');
    stubScrollHost(page, { top: 0, bottom: 400 });
    const raf = fakeRaf(window);
    try {
      const grip = qs(cards[0], '.dash-gg-grip');
      const from = tileCenter(0);
      grip.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, clientX: from.x, clientY: from.y }));
      // 2px < the 4px move threshold — never arms the drag (beginMove, which
      // creates the auto-scroll controller, never runs) — so no auto-scroll,
      // even though this point is already inside the top edge zone.
      window.dispatchEvent(new PointerEvent('pointermove', { clientX: from.x + 2, clientY: from.y }));
      expect(raf.pending).toBe(0);
      raf.flush();
      expect(page.scrollTop).toBe(0);
      window.dispatchEvent(new PointerEvent('pointerup', { clientX: from.x + 2, clientY: from.y }));
    } finally {
      raf.restore();
    }
  });

  it('destination recomputes from an auto-scroll frame alone, with no new pointermove (flow engine)', async () => {
    // Two tiles stacked vertically (custom rects, NOT stubTileRects's default
    // horizontal layout): tile A occupies y:[300,350], tile B y:[350,400] —
    // a pointer at y=345 starts inside A and, as the page auto-scrolls (the
    // pointer sitting in the BOTTOM edge zone at visibleBottom=400), the
    // captured home rects shift up under it until B is what the stationary
    // pointer now sits over — with no second pointermove.
    const { app, commit } = dashApp({
      workspace: wsWith({
        queries: [q('q1', 'SELECT k, v FROM a'), q('q2', 'SELECT k, v FROM b')],
        tiles: [{ id: 't1', queryId: 'q1' }, { id: 't2', queryId: 'q2' }],
        layout: { type: 'flow', version: 1, preset: 'report', items: {} },
      }),
    });
    await render(app);
    const cards = qsa<HTMLElement>(app.root, '.dash-tile');
    const rectFor = (top: number, bottom: number): DOMRect =>
      ({ left: 0, right: 150, top, bottom, width: 150, height: bottom - top, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;
    cards[0].getBoundingClientRect = () => rectFor(300, 350);
    cards[1].getBoundingClientRect = () => rectFor(350, 400);
    const page = qs<HTMLElement>(app.root, '.dash-page');
    stubScrollHost(page, { top: 0, bottom: 400 });
    const raf = fakeRaf(window);
    try {
      const start = { x: 75, y: 320 };
      cards[0].dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true, cancelable: true, button: 0, clientX: start.x, clientY: start.y, metaKey: true,
      }));
      // Crosses the 4px move threshold (captures home rects) AND lands the
      // pointer at y=345 — inside tile A's [300,350] rect and inside the
      // bottom edge zone ([320,400], edgePx=80).
      window.dispatchEvent(new PointerEvent('pointermove', { clientX: start.x, clientY: 345 }));
      expect(cards[0].classList.contains('dash-drop-target')).toBe(false); // the dragged tile is never its own target
      expect(cards[1].classList.contains('dash-drop-target')).toBe(false); // not (yet) over tile B
      raf.flush(); // one auto-scroll frame — no new pointermove
      expect(cards[1].classList.contains('dash-drop-target')).toBe(true); // scroll alone revealed tile B under the stationary pointer
      window.dispatchEvent(new PointerEvent('pointerup', { clientX: start.x, clientY: 345 }));
      await flush();
      expect(commit).toHaveBeenCalledTimes(1); // released over tile B → one move-tile commit
    } finally {
      raf.restore();
    }
  });

  it('exactly one move-tile command commits on release even after several auto-scroll frames', async () => {
    const { app, commit } = dashApp({ workspace: gridWs() });
    await render(app);
    const cards = qsa<HTMLElement>(app.root, '.dash-gg-tile');
    stubTileRects(cards);
    const page = qs<HTMLElement>(app.root, '.dash-page');
    stubScrollHost(page, { top: 0, bottom: 400 });
    const raf = fakeRaf(window);
    try {
      const grip = qs(cards[0], '.dash-gg-grip');
      const from = tileCenter(0);
      grip.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, clientX: from.x, clientY: from.y }));
      window.dispatchEvent(new PointerEvent('pointermove', { clientX: from.x + 10, clientY: from.y }));
      window.dispatchEvent(new PointerEvent('pointermove', { clientX: from.x + 10, clientY: 390 })); // bottom edge zone
      raf.flush();
      raf.flush();
      // Land the floating card over tile 2's CURRENT (scroll-shifted) home
      // slot — `currentRects()` shifts every captured home rect by the page's
      // accumulated scroll delta, so the dragged rect must match that shifted
      // position for the overlap resolver to commit onto it.
      const dy = page.scrollTop; // scrollTop0 was 0 at this drag's start
      const home2 = cards[2].getBoundingClientRect();
      const land = { ...home2, top: home2.top - dy, bottom: home2.bottom - dy };
      cards[0].getBoundingClientRect = () => ({ ...land, toJSON: () => ({}) }) as DOMRect;
      window.dispatchEvent(new PointerEvent('pointermove', { clientX: tileCenter(2).x, clientY: tileCenter(2).y }));
      window.dispatchEvent(new PointerEvent('pointerup', { clientX: tileCenter(2).x, clientY: tileCenter(2).y }));
      await flush();
      expect(commit).toHaveBeenCalledTimes(1);
    } finally {
      raf.restore();
    }
  });

  it('a cancelled gesture (Escape) stops the auto-scroll loop and dispatches no command', async () => {
    const { app, commit } = dashApp({ workspace: gridWs() });
    await render(app);
    const cards = qsa<HTMLElement>(app.root, '.dash-gg-tile');
    stubTileRects(cards);
    const page = qs<HTMLElement>(app.root, '.dash-page');
    stubScrollHost(page, { top: 0, bottom: 400 });
    const raf = fakeRaf(window);
    try {
      const grip = qs(cards[0], '.dash-gg-grip');
      const from = tileCenter(0);
      grip.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, clientX: from.x, clientY: from.y }));
      window.dispatchEvent(new PointerEvent('pointermove', { clientX: from.x + 10, clientY: from.y }));
      window.dispatchEvent(new PointerEvent('pointermove', { clientX: from.x + 10, clientY: 390 }));
      raf.flush();
      const scrolledTo = page.scrollTop;
      expect(scrolledTo).toBeGreaterThan(0);
      expect(raf.pending).toBe(1); // one loop still running
      app.document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      expect(raf.pending).toBe(0); // stop() cancelled the pending frame
      raf.flush(); // draining an empty queue is a no-op
      expect(page.scrollTop).toBe(scrolledTo); // no further scroll after cancel
      expect(commit).not.toHaveBeenCalled();
      expect(order(app)).toEqual(['q1', 'q2', 'q3']);
    } finally {
      raf.restore();
    }
  });

  it('read-only: no drag listeners wired, so no auto-scroll ever starts', async () => {
    const detached = gridWs();
    const { app, commit } = modeApp({
      workspace: detached, mode: 'view',
    });
    await render(app);
    const cards = qsa<HTMLElement>(app.root, '.dash-gg-tile');
    expect(qs(app.root, '.dash-gg-grip')).toBeNull(); // no grip built in read-only mode
    stubTileRects(cards);
    const page = qs<HTMLElement>(app.root, '.dash-page');
    stubScrollHost(page, { top: 0, bottom: 400 });
    const raf = fakeRaf(window);
    try {
      const from = tileCenter(0);
      cards[0].dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, clientX: from.x, clientY: from.y, metaKey: true }));
      window.dispatchEvent(new PointerEvent('pointermove', { clientX: from.x + 10, clientY: 390 }));
      expect(raf.pending).toBe(0);
      raf.flush();
      expect(page.scrollTop).toBe(0);
      window.dispatchEvent(new PointerEvent('pointerup', { clientX: from.x + 10, clientY: 390 }));
      expect(commit).not.toHaveBeenCalled();
    } finally {
      raf.restore();
    }
  });

  it('the flow engine also auto-scrolls and still reorders on release', async () => {
    const flowOrder = (app: TestApp): string[] => qsa(app.root, '.dash-tile .dash-tile-name').map((n) => n.textContent || '');
    const { app, commit } = dashApp({
      workspace: wsWith({
        queries: [q('q1', 'SELECT k, v FROM a'), q('q2', 'SELECT k, v FROM b')],
        tiles: [{ id: 't1', queryId: 'q1' }, { id: 't2', queryId: 'q2' }],
        layout: { type: 'flow', version: 1, preset: 'report', items: {} },
      }),
    });
    await render(app);
    const cards = qsa<HTMLElement>(app.root, '.dash-tile');
    stubTileRects(cards);
    const page = qs<HTMLElement>(app.root, '.dash-page');
    stubScrollHost(page, { top: 0, bottom: 400 });
    const raf = fakeRaf(window);
    try {
      const start = tileCenter(0);
      cards[0].dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true, cancelable: true, button: 0, clientX: start.x, clientY: start.y, metaKey: true,
      }));
      window.dispatchEvent(new PointerEvent('pointermove', { clientX: start.x + 10, clientY: 390 })); // crosses threshold near the bottom edge
      expect(raf.pending).toBe(1);
      raf.flush();
      expect(page.scrollTop).toBeGreaterThan(0);
      window.dispatchEvent(new PointerEvent('pointermove', { clientX: tileCenter(1).x, clientY: tileCenter(1).y }));
      window.dispatchEvent(new PointerEvent('pointerup', { clientX: tileCenter(1).x, clientY: tileCenter(1).y }));
      expect(flowOrder(app)).toEqual(['q2', 'q1']);
      await flush();
      expect(commit).toHaveBeenCalledTimes(1);
    } finally {
      raf.restore();
    }
  });

  it('the sticky topbar offsets the effective top edge (a pointer under the header scrolls up)', async () => {
    // The issue requires the effective upper interaction boundary to be the
    // first Dashboard content coordinate BELOW the sticky topbar, not the raw
    // page top. With the topbar 100px tall and the page rect starting at y=0,
    // `visibleTop` is 100, so a pointer at y=90 (over the header strip, ABOVE
    // the content) counts as above the top edge → scroll up at max. With no
    // topbar offset (the other #338 tests' degenerate case) y=90 would be dead
    // center and NOT scroll — so a change dropping the `topbar.offsetHeight`
    // term, using the wrong element, or flipping its sign fails this test.
    const { app } = dashApp({ workspace: gridWs() });
    await render(app);
    const cards = qsa<HTMLElement>(app.root, '.dash-gg-tile');
    stubTileRects(cards);
    const page = qs<HTMLElement>(app.root, '.dash-page');
    stubScrollHost(page, { top: 0, bottom: 400, scrollTop: 500 }); // room above to scroll up
    const topbar = qs<HTMLElement>(page, '.dash-topbar');
    Object.defineProperty(topbar, 'offsetHeight', { value: 100, configurable: true });
    const raf = fakeRaf(window);
    try {
      const grip = qs(cards[0], '.dash-gg-grip');
      const from = tileCenter(0);
      grip.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, clientX: from.x, clientY: from.y }));
      window.dispatchEvent(new PointerEvent('pointermove', { clientX: from.x + 10, clientY: from.y })); // cross threshold
      // y=90 is below the raw page top (0) but ABOVE visibleTop (0 + topbar 100).
      window.dispatchEvent(new PointerEvent('pointermove', { clientX: from.x + 10, clientY: 90 }));
      const before = page.scrollTop;
      raf.flush();
      expect(page.scrollTop).toBeLessThan(before); // scrolled up — proves the topbar offset shifted the edge zone
      window.dispatchEvent(new PointerEvent('pointerup', { clientX: OUTSIDE_ALL_TILES.x, clientY: OUTSIDE_ALL_TILES.y }));
    } finally {
      raf.restore();
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
    await flush();
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
    await flush();
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
    await flush();
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
      workspace: detached, mode: 'view',
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
    await flush();
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
    await flush();
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

// #189/#364 (Bug 3): a favorited `filter`-role saved query whose OUTPUT COLUMN
// name matches an implicit (undeclared) panel-tile parameter auto-binds its
// options to that parameter — `synthesizeImplicitFilters` sets `sourceQueryId`,
// so the field upgrades from a plain text box to a curated combobox WITHOUT any
// explicit `doc.filters` entry. Exactly one favorited source binds; zero or
// more than one (ambiguous) leaves the field plain.
describe('renderDashboard — auto-bind favorited filter source by column name (#364)', () => {
  // A panel tile whose only parameter is `user1: Array(String)` — the implicit
  // filter target these tests wire (or decline to wire) a source to.
  const CONSUMER = 'SELECT k, v FROM a WHERE has(user1, {user1:Array(String)})';
  const optionsResponder: ExecResponder = (sql) => (sql.includes('opts')
    ? { columns: [{ name: 'user1', type: 'Array(String)' }], rows: [[['x', 'y']]] }
    : { columns: [{ name: 'k', type: 'String' }, { name: 'v', type: 'UInt64' }], rows: [['a', 1]] });

  it('binds a favorited filter source that outputs the same column name (field becomes curated)', async () => {
    const { app } = dashApp({
      responder: optionsResponder,
      workspace: wsWith({
        queries: [
          q('q1', CONSUMER),
          q('src', 'SELECT groupArray(region) AS user1 FROM t -- opts', { dashboard: { role: 'filter' }, favorite: true }),
        ],
        tiles: [{ id: 't1', queryId: 'q1' }],
      }),
    });
    await render(app);
    const field = qs(app.root, '.dash-filter-host .var-field.is-curated');
    expect(field).not.toBeNull();
    expect(qs(field, '.var-name').textContent).toBe('user1');
  });

  it('leaves the field plain when NO favorited filter source outputs the column', async () => {
    const { app } = dashApp({
      responder: optionsResponder,
      workspace: wsWith({
        queries: [
          q('q1', CONSUMER),
          // A favorited filter source, but it outputs a DIFFERENT column.
          q('src', 'SELECT groupArray(region) AS someOther FROM t -- opts', { dashboard: { role: 'filter' }, favorite: true }),
        ],
        tiles: [{ id: 't1', queryId: 'q1' }],
      }),
    });
    await render(app);
    // The user1 field still renders, just not curated (no source attached).
    expect(qs(app.root, '.dash-filter-host .var-field .var-name').textContent).toBe('user1');
    expect(qs(app.root, '.dash-filter-host .var-field.is-curated')).toBeNull();
  });

  it('does NOT bind when two favorited filter sources output the same column (ambiguous)', async () => {
    const { app } = dashApp({
      responder: optionsResponder,
      workspace: wsWith({
        queries: [
          q('q1', CONSUMER),
          q('srcA', 'SELECT groupArray(region) AS user1 FROM a -- opts', { dashboard: { role: 'filter' }, favorite: true }),
          q('srcB', 'SELECT groupArray(region) AS user1 FROM b -- opts', { dashboard: { role: 'filter' }, favorite: true }),
        ],
        tiles: [{ id: 't1', queryId: 'q1' }],
      }),
    });
    await render(app);
    expect(qs(app.root, '.dash-filter-host .var-field .var-name').textContent).toBe('user1');
    expect(qs(app.root, '.dash-filter-host .var-field.is-curated')).toBeNull();
  });

  it('ignores a NON-favorited filter-role query that outputs the column', async () => {
    const { app } = dashApp({
      responder: optionsResponder,
      workspace: wsWith({
        queries: [
          q('q1', CONSUMER),
          q('src', 'SELECT groupArray(region) AS user1 FROM t -- opts', { dashboard: { role: 'filter' }, favorite: false }),
        ],
        tiles: [{ id: 't1', queryId: 'q1' }],
      }),
    });
    await render(app);
    expect(qs(app.root, '.dash-filter-host .var-field .var-name').textContent).toBe('user1');
    expect(qs(app.root, '.dash-filter-host .var-field.is-curated')).toBeNull();
  });
});

// #189: the searchable multiselect (an Array(...) consumer contract, default
// `selection.mode`) and the single-select-on-Array wrap (`selection.mode:
// 'single'` against the same Array contract) — both new curated shapes,
// wired end to end through the REAL session's `applyFilter` (never a bare
// callback spy), so a committed value is a genuine array all the way through
// `param-serialize.ts`'s wire format.
describe('renderDashboard — searchable multiselect + array-wrapped curated filters (#189)', () => {
  it('an Array(...) consumer contract renders a multiselect field; Apply commits an array through the real session', async () => {
    const { app, calls } = dashApp({
      responder: (sql) => (sql.includes('opts')
        ? { columns: [{ name: 'p', type: 'Array(String)' }], rows: [[['x', 'y']]] }
        : { columns: [{ name: 'k', type: 'String' }, { name: 'v', type: 'UInt64' }], rows: [['a', 1]] }),
      workspace: wsWith({
        queries: [
          q('q1', 'SELECT k, v FROM a WHERE has(p, {p:Array(String)})'),
          q('src', "SELECT ['x','y'] AS p -- opts", { dashboard: { role: 'filter' } }),
        ],
        tiles: [{ id: 't1', queryId: 'q1' }],
        filters: [{ id: 'f1', parameter: 'p', sourceQueryId: 'src' }],
      }),
    });
    await render(app);
    const field = qs(app.root, '.dash-filter-host .var-field.is-curated');
    expect(field).not.toBeNull();
    expect(qs(field, '.ms-field')).not.toBeNull(); // the multiselect control, not the scalar combobox
    const before = calls.length;
    qs<HTMLButtonElement>(field, '.ms-trigger').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const cb = qs<HTMLInputElement>(document.body, '.ms-option input[type="checkbox"]');
    cb.checked = true;
    cb.dispatchEvent(new Event('change', { bubbles: true }));
    qs(document.body, '.ms-btn-primary').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    const added = calls.slice(before).filter((c) => 'param_p' in c.params);
    expect(added.length).toBe(1); // one affected-panel wave
    expect(added[0].params.param_p).toBe("['x']"); // a real ClickHouse array literal, not a joined string
  });

  it('a single-select curated field over an Array(...) contract commits a WRAPPED [value] (never a bare scalar), through the real session', async () => {
    const { app, calls } = dashApp({
      responder: (sql) => (sql.includes('opts')
        ? { columns: [{ name: 'p', type: 'Array(String)' }], rows: [[['x', 'y']]] }
        : { columns: [{ name: 'k', type: 'String' }, { name: 'v', type: 'UInt64' }], rows: [['a', 1]] }),
      workspace: wsWith({
        queries: [
          q('q1', 'SELECT k, v FROM a WHERE has(p, {p:Array(String)})'),
          q('src', "SELECT ['x','y'] AS p -- opts", { dashboard: { role: 'filter' } }),
        ],
        tiles: [{ id: 't1', queryId: 'q1' }],
        filters: [{ id: 'f1', parameter: 'p', sourceQueryId: 'src', selection: { mode: 'single' } }],
      }),
    });
    await render(app);
    const field = qs(app.root, '.dash-filter-host .var-field.is-curated');
    expect(qs(field, '.var-combo')).not.toBeNull(); // stays the scalar combobox, not a multiselect
    const before = calls.length;
    qs<HTMLInputElement>(field, 'input').dispatchEvent(new Event('focus'));
    qs(field, '[role="option"]')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    const added = calls.slice(before).filter((c) => 'param_p' in c.params);
    expect(added.length).toBe(1);
    expect(added[0].params.param_p).toBe("['x']"); // wrapped, never the bare scalar "'x'"
  });

  // #189 review (F2): a NEW option generation while the popover is open must
  // force-close it as a silent Cancel (never a committed value from the open
  // draft), announce the closure, and move focus to the FRESH bar's trigger
  // for the same parameter — driven end to end through the real session (a
  // refresh that reruns the shared source with DIFFERENT option content).
  it('a NEW option generation while the multiselect popover is open force-closes it with no applyFilter call, announces the refresh, and focuses the new trigger', async () => {
    let srcCalls = 0;
    const { app, calls } = dashApp({
      responder: (sql) => {
        if (sql.includes('opts')) {
          srcCalls++;
          return { columns: [{ name: 'p', type: 'Array(String)' }], rows: [[srcCalls === 2 ? ['a', 'b', 'c'] : ['x', 'y']]] };
        }
        return { columns: [{ name: 'k', type: 'String' }, { name: 'v', type: 'UInt64' }], rows: [['a', 1]] };
      },
      workspace: wsWith({
        queries: [
          q('q1', 'SELECT k, v FROM a WHERE has(p, {p:Array(String)})'),
          q('src', "SELECT ['x','y'] AS p -- opts", { dashboard: { role: 'filter' } }),
        ],
        tiles: [{ id: 't1', queryId: 'q1' }],
        filters: [{ id: 'f1', parameter: 'p', sourceQueryId: 'src', defaultValue: ['x'], defaultActive: true }],
      }),
    });
    await render(app);
    // `app.root` (fake-app.ts) is a detached div by default — connect it so a
    // real `.focus()` inside it actually becomes `document.activeElement`
    // (the popover itself is already appended straight to the real
    // `document.body` by `multi-select-field.ts`, unaffected either way).
    document.body.appendChild(rootEl(app));
    const field = qs(app.root, '.dash-filter-host .var-field.is-curated');
    qs<HTMLButtonElement>(field, '.ms-trigger').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(qs(document.body, '.ms-popover')).not.toBeNull();
    // Mutate the OPEN DRAFT only — check the second option ('y') too, so the
    // draft becomes ['x','y'] — never Apply.
    const draftCb = qsa<HTMLInputElement>(document.body, '.ms-option input[type="checkbox"]')[1];
    draftCb.checked = true;
    draftCb.dispatchEvent(new Event('change', { bubbles: true }));
    const before = calls.length;
    // Refresh reruns the shared source, which returns a DIFFERENT option set
    // (same length as the #359 rebuild trigger) — a new option generation.
    await (runOnclick(qs(app.root, '.dash-refresh')) as Promise<void>);
    // The popover was force-closed as a silent Cancel — no call anywhere
    // reflects the open draft's ['x','y'] pick (the real seam that would
    // carry it, `applyFilter`, is never reached).
    const tileCalls = calls.slice(before).filter((c) => 'param_p' in c.params);
    expect(tileCalls.some((c) => c.params.param_p === "['x','y']")).toBe(false);
    expect(document.body.querySelector('.ms-popover')).toBeNull();
    expect(qs(app.root, '.dash-toolbar > .sr-only').textContent).toBe('Filter options were refreshed');
    // The committed value ['x'] (never touched by the draft) is now dormant
    // against the NEW option set — the merge deactivates it (existing
    // dormant-value self-heal behavior, unrelated to this fix) — the fresh
    // bar's trigger reads "Not set", never "2 selected" (which only a
    // committed ['x','y'] — i.e. the discarded draft — would have produced).
    const newTrigger = qs<HTMLButtonElement>(app.root, '.ms-trigger');
    expect(newTrigger.textContent).toBe('Not set');
    expect(document.activeElement).toBe(newTrigger);
    rootEl(app).remove();
  });

  // Maintainer merge-gate finding: an ORDINARY Apply — the user's own commit,
  // not an outgoing bar's popover getting force-cancelled by someone/something
  // else — must never announce "Filter options were refreshed". Driven end to
  // end through the real session: the shared source republishes the SAME
  // option content on every rerun (no genuine option-generation change), so
  // `optionsRev` never bumps and the announcement must stay silent even though
  // `session.applyFilter`'s synchronous `publish()` forces this exact
  // multiselect's own bar to rebuild out from under its own (already-closed)
  // popover.
  it('a normal Apply commits through the real session without announcing "Filter options were refreshed", and focuses the fresh trigger', async () => {
    const { app, calls } = dashApp({
      responder: (sql) => {
        if (sql.includes('opts')) {
          return { columns: [{ name: 'p', type: 'Array(String)' }], rows: [[['x', 'y']]] };
        }
        return { columns: [{ name: 'k', type: 'String' }, { name: 'v', type: 'UInt64' }], rows: [['a', 1]] };
      },
      workspace: wsWith({
        queries: [
          q('q1', 'SELECT k, v FROM a WHERE has(p, {p:Array(String)})'),
          q('src', "SELECT ['x','y'] AS p -- opts", { dashboard: { role: 'filter' } }),
        ],
        tiles: [{ id: 't1', queryId: 'q1' }],
        filters: [{ id: 'f1', parameter: 'p', sourceQueryId: 'src', defaultValue: ['x'], defaultActive: true }],
      }),
    });
    await render(app);
    document.body.appendChild(rootEl(app));
    const field = qs(app.root, '.dash-filter-host .var-field.is-curated');
    qs<HTMLButtonElement>(field, '.ms-trigger').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(qs(document.body, '.ms-popover')).not.toBeNull();
    const liveRegionBefore = qs(app.root, '.dash-toolbar > .sr-only').textContent;
    // Check the second option ('y') too, then Apply — a real value change.
    const draftCb = qsa<HTMLInputElement>(document.body, '.ms-option input[type="checkbox"]')[1];
    draftCb.checked = true;
    draftCb.dispatchEvent(new Event('change', { bubbles: true }));
    const before = calls.length;
    qs<HTMLButtonElement>(document.body, '.ms-btn-primary').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    // The popover is torn down synchronously (multi-select-field.ts's Apply
    // handler closes before calling `onApply`) — no macrotask/microtask flush
    // needed to observe it gone.
    expect(document.body.querySelector('.ms-popover')).toBeNull();
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    const tileCalls = calls.slice(before).filter((c) => 'param_p' in c.params);
    expect(tileCalls.some((c) => c.params.param_p === "['x','y']")).toBe(true); // the commit went through
    // The live region is untouched — no false "refreshed" announcement.
    expect(qs(app.root, '.dash-toolbar > .sr-only').textContent).toBe(liveRegionBefore);
    expect(qs(app.root, '.dash-toolbar > .sr-only').textContent).not.toBe('Filter options were refreshed');
    // Focus lands on the FRESH bar's trigger for the same parameter (the old
    // one, focused by `close()`, was detached by the synchronous rebuild).
    const newTrigger = qs<HTMLButtonElement>(app.root, '.ms-trigger');
    expect(document.activeElement).toBe(newTrigger);
    rootEl(app).remove();
  });
});

// #335: the compound time-range control, integrated end to end through the
// REAL session — a from/to date-like filter pair forms a `DashboardTimeRangeGroup`
// (session.timeRangeGroups), the bar renders one compound control in its "Time"
// section (suppressing the pair's two individual fields), Apply commits both
// bounds atomically via `session.applyFilters` in one wave, per-group recents
// accumulate the OUTGOING committed pairs, and the closed trigger re-resolves
// its label per wave (a live relative range) without a bar rebuild.
describe('renderDashboard — compound time-range control (#335)', () => {
  const PAIR = 'SELECT k, v FROM a WHERE ts >= {from:DateTime} AND ts < {to:DateTime}';
  const paired = (sql = PAIR) => q('q1', sql, { timeRanges: [{ from: 'from', to: 'to' }] });
  const clickEv = (): MouseEvent => new MouseEvent('click', { bubbles: true });
  const inputEv = (): Event => new Event('input', { bubbles: true });
  // Drive one full time-range Apply on the CURRENTLY-rendered trigger.
  const applyRange = async (app: TestApp, from: string, to: string): Promise<void> => {
    qs<HTMLButtonElement>(app.root, '.trf-trigger').dispatchEvent(clickEv());
    const inputs = qsa<HTMLInputElement>(document.body, '.trf-input');
    inputs[0].value = from; inputs[0].dispatchEvent(inputEv());
    inputs[1].value = to; inputs[1].dispatchEvent(inputEv());
    qs<HTMLButtonElement>(document.body, '.trf-btn-primary').dispatchEvent(clickEv());
    await flush();
  };

  it('renders one compound control for the from/to pair, suppressing the two individual fields, with Time/Filters labels', async () => {
    const { app } = dashApp({
      workspace: wsWith({
        queries: [paired(PAIR + ' AND r = {region:String}')],
        tiles: [{ id: 't1', queryId: 'q1' }],
      }),
    });
    await render(app);
    expect(qs(app.root, '.trf-trigger')).not.toBeNull();
    expect(qsa(app.root, '.dash-filter-host .flabel').map((n) => n.textContent)).toEqual(['Time', 'Filters']);
    // The pair's own two fields are gone; only the non-group field remains.
    const names = qsa(app.root, '.dash-filter-host .var-field:not(.is-time-range) .var-name').map((n) => n.textContent);
    expect(names).toEqual(['region']);
  });

  it('keeps the compound control for a legacy saved query with omitted timeRanges metadata', async () => {
    const { app } = dashApp({
      workspace: wsWith({
        queries: [q('q1', PAIR)],
        tiles: [{ id: 't1', queryId: 'q1' }],
      }),
    });
    await render(app);
    expect(qs(app.root, '.trf-trigger')).not.toBeNull();
    expect(qsa(app.root, '.dash-filter-host .var-field:not(.is-time-range) .var-name')).toEqual([]);
  });

  it('Apply commits BOTH bounds through session.applyFilters in one wave and announces the range', async () => {
    const { app, calls } = dashApp({
      workspace: wsWith({ queries: [paired()], tiles: [{ id: 't1', queryId: 'q1' }] }),
    });
    await render(app);
    document.body.appendChild(rootEl(app));
    const before = calls.length;
    await applyRange(app, '-1d', 'now');
    const added = calls.slice(before).filter((c) => 'param_from' in c.params || 'param_to' in c.params);
    expect(added.length).toBeGreaterThanOrEqual(1);
    // One atomic wave binds BOTH parameters on every affected tile call.
    expect(added.every((c) => 'param_from' in c.params && 'param_to' in c.params)).toBe(true);
    expect(qs(app.root, '.dash-toolbar > .sr-only').textContent).toBe('Time range applied: -1d → now');
    // The bar rebuilt on the committed-value change and now shows a resolved,
    // active range (not "Not set").
    expect(qs(app.root, '.trf-trigger').textContent).not.toBe('Not set');
    rootEl(app).remove();
  });

  it('does not let a slower earlier Apply overwrite the latest range announcement', async () => {
    const { app } = dashApp({
      workspace: wsWith({ queries: [paired()], tiles: [{ id: 't1', queryId: 'q1' }] }),
    });
    await render(app);
    document.body.appendChild(rootEl(app));
    const originalExecute = app.exec.executeRead as App['exec']['executeRead'];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let delayNext = true;
    const delayedExecute: App['exec']['executeRead'] = async (result, request) => {
      if (delayNext) { delayNext = false; await gate; }
      return originalExecute(result, request);
    };
    (app.exec as App['exec']).executeRead = delayedExecute;
    const startApply = (from: string, to: string): void => {
      qs<HTMLButtonElement>(app.root, '.trf-trigger').dispatchEvent(clickEv());
      const inputs = qsa<HTMLInputElement>(document.body, '.trf-input');
      inputs[0].value = from; inputs[0].dispatchEvent(inputEv());
      inputs[1].value = to; inputs[1].dispatchEvent(inputEv());
      qs<HTMLButtonElement>(document.body, '.trf-btn-primary').dispatchEvent(clickEv());
    };
    startApply('-1d', 'now');
    await flush();
    startApply('-7d', 'now');
    await flush();
    expect(qs(app.root, '.dash-toolbar > .sr-only').textContent).toBe('Time range applied: -7d → now');
    release();
    await flush();
    expect(qs(app.root, '.dash-toolbar > .sr-only').textContent).toBe('Time range applied: -7d → now');
    rootEl(app).remove();
  });

  it('pushes the OUTGOING committed pair to per-group recents on a changing re-apply, never on the first commit from unset', async () => {
    const { app } = dashApp({
      workspace: wsWith({ queries: [paired()], tiles: [{ id: 't1', queryId: 'q1' }] }),
    });
    await render(app);
    document.body.appendChild(rootEl(app));
    // First commit — the outgoing pair was unset/inactive, so nothing is pushed.
    await applyRange(app, '-1d', 'now');
    qs<HTMLButtonElement>(app.root, '.trf-trigger').dispatchEvent(clickEv());
    expect(qs(document.body, '.trf-empty')?.textContent).toContain('No recent ranges yet');
    // Cancel out (never pushes).
    qsa<HTMLButtonElement>(document.body, '.trf-btn')[0].dispatchEvent(clickEv()); // Cancel
    // Second, CHANGING commit — the outgoing active pair (-1d → now) is pushed.
    await applyRange(app, '-7d', 'now');
    qs<HTMLButtonElement>(app.root, '.trf-trigger').dispatchEvent(clickEv());
    expect(qs(document.body, '.trf-recent').textContent).toBe('-1d → now');
    rootEl(app).remove();
  });

  it('re-resolves the closed trigger label per wave WITHOUT rebuilding the bar (a relative range moves as `now` advances)', async () => {
    let clock = 1000;
    const { app } = dashApp({
      workspace: wsWith({
        queries: [paired()],
        tiles: [{ id: 't1', queryId: 'q1' }],
        filters: [
          { id: 'from', parameter: 'from', defaultValue: '-1d', defaultActive: true },
          { id: 'to', parameter: 'to', defaultValue: 'now', defaultActive: true },
        ],
      }),
    });
    app.wallNow = () => clock;
    await render(app);
    const trigger = qs<HTMLButtonElement>(app.root, '.trf-trigger');
    const before = trigger.textContent;
    expect(trigger.classList.contains('is-error')).toBe(false);
    clock = 1000 + 3 * 86_400_000; // three days later
    await (runOnclick(qs(app.root, '.dash-refresh')) as Promise<void>);
    // No rebuild — the SAME trigger node, its label re-resolved in place.
    expect(qs(app.root, '.trf-trigger')).toBe(trigger);
    expect(trigger.textContent).not.toBe(before);
    rootEl(app).remove();
  });

  it('restores focus onto the fresh time-range trigger after a commit-triggered rebuild', async () => {
    const { app } = dashApp({
      workspace: wsWith({ queries: [paired()], tiles: [{ id: 't1', queryId: 'q1' }] }),
    });
    await render(app);
    document.body.appendChild(rootEl(app));
    const oldTrigger = qs<HTMLButtonElement>(app.root, '.trf-trigger');
    oldTrigger.dispatchEvent(clickEv());
    const inputs = qsa<HTMLInputElement>(document.body, '.trf-input');
    inputs[0].value = '-1d'; inputs[0].dispatchEvent(inputEv());
    inputs[1].value = 'now'; inputs[1].dispatchEvent(inputEv());
    qs<HTMLButtonElement>(document.body, '.trf-btn-primary').dispatchEvent(clickEv());
    // The synchronous applyFilters publish rebuilt the bar, detaching the old
    // trigger — focus lands on the fresh one (never stranded at <body>).
    const newTrigger = qs<HTMLButtonElement>(app.root, '.trf-trigger');
    expect(newTrigger).not.toBe(oldTrigger);
    expect(document.activeElement).toBe(newTrigger);
    rootEl(app).remove();
  });

  it('renders and commits the time-range control in a live read-only dashboard', async () => {
    const detached = wsWith({
      id: 'd', queries: [paired()], tiles: [{ id: 't1', queryId: 'q1' }],
    });
    const { app, calls } = modeApp({
      workspace: detached, mode: 'view',
    });
    await render(app);
    document.body.appendChild(rootEl(app));
    expect(qs(app.root, '.trf-trigger')).not.toBeNull();
    const before = calls.length;
    await applyRange(app, '-1d', 'now');
    const added = calls.slice(before).filter((c) => 'param_from' in c.params && 'param_to' in c.params);
    expect(added.length).toBeGreaterThanOrEqual(1);
    rootEl(app).remove();
  });

  it('renders unresolved authored metadata as a persistent Dashboard diagnostic', async () => {
    const { app } = dashApp({
      workspace: wsWith({
        queries: [paired()], tiles: [{ id: 't1', queryId: 'q1' }],
        filters: [
          { id: 'from', parameter: 'from', targets: [] },
          { id: 'to', parameter: 'to', targets: [] },
        ],
      }),
    });
    await render(app);
    expect(qs(app.root, '.dash-config-diagnostic')?.textContent).toContain('could not resolve both parameters');
  });

  it('threads the Dashboard plugin into a temporal chart and brushing commits one absolute batch', async () => {
    let built: (FakeChart & Record<string, unknown>) | null = null;
    const scaleBase = new Date(2026, 0, 1, 0, 0, 0).getTime();
    class InteractiveChart extends FakeChart {
      ctx = {
        save: vi.fn(), restore: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(),
        fillRect: vi.fn(), strokeRect: vi.fn(), fillText: vi.fn(), measureText: vi.fn(() => ({ width: 40 })),
        strokeStyle: '', fillStyle: '', lineWidth: 0, font: '', textBaseline: '',
      };
      width = 400; height = 200;
      chartArea = { left: 20, right: 380, top: 10, bottom: 180 };
      scales = { x: {
        type: 'time', min: scaleBase, max: scaleBase + 1_000_000,
        getValueForPixel: (x: number) => scaleBase + x * 2500,
        getPixelForValue: (v: number) => (v - scaleBase) / 2500,
      } };
      options = { indexAxis: undefined };
      draw = vi.fn();
      constructor(canvas: HTMLCanvasElement, config: ConstructorParameters<typeof FakeChart>[1]) {
        super(canvas, config); built = this as FakeChart & Record<string, unknown>;
      }
    }
    const { app, calls } = dashApp({
      workspace: wsWith({
        queries: [q('q1', PAIR, {
          timeRanges: [{ from: 'from', to: 'to' }], panel: { cfg: { type: 'line', x: 0, y: [1] } },
        })],
        tiles: [{ id: 't1', queryId: 'q1' }],
        filters: [
          { id: 'from', parameter: 'from', defaultValue: '1700000000', defaultActive: true },
          { id: 'to', parameter: 'to', defaultValue: '1800000000', defaultActive: true },
        ],
      }),
      responder: () => ({
        columns: [{ name: 'ts', type: 'DateTime' }, { name: 'v', type: 'UInt64' }],
        rows: [['2026-01-01 00:00:00', 1], ['2026-01-02 00:00:00', 2]],
      }),
    });
    app.Chart = InteractiveChart;
    await render(app);
    const chart = built as unknown as InteractiveChart;
    const plugin = (chart.config as unknown as { plugins: Array<{
      afterInit(c: InteractiveChart): void; afterDatasetsDraw(c: InteractiveChart): void;
    }> }).plugins[0];
    expect(plugin).toBeTruthy();
    chart.canvas.getBoundingClientRect = () => ({
      left: 0, top: 0, right: 400, bottom: 200, width: 400, height: 200, x: 0, y: 0, toJSON: () => ({}),
    }) as DOMRect;
    plugin.afterInit(chart);
    const brushEvent = (type: string, clientX: number): Event => {
      const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX, clientY: 50 });
      for (const [key, value] of Object.entries({ pointerId: 7, pointerType: 'mouse', isPrimary: true })) {
        Object.defineProperty(event, key, { value, configurable: true });
      }
      return event;
    };
    const before = calls.length;
    chart.canvas.dispatchEvent(brushEvent('pointerdown', 100));
    window.dispatchEvent(brushEvent('pointermove', 200));
    plugin.afterDatasetsDraw(chart);
    window.dispatchEvent(brushEvent('pointerup', 200));
    for (let i = 0; i < 10 && !calls.slice(before).some((call) => 'param_from' in call.params && 'param_to' in call.params); i++) await flush();
    expect(calls.slice(before).some((call) => 'param_from' in call.params && 'param_to' in call.params)).toBe(true);
    expect(qs(app.root, '.dash-toolbar > .sr-only').textContent).toContain('Time range applied:');
    qs<HTMLButtonElement>(app.root, '.trf-trigger').dispatchEvent(clickEv());
    expect(qs(document.body, '.trf-recent').textContent)
      .toBe('2023-11-14 22:13:20 → 2027-01-15 08:00:00');
  });
});

// #359: the shared-source filter wave now publishes `optionsRev` (bumped ONLY
// when a curated source's option VALUE CONTENT changes — including a clear to
// null — never on an unchanged republish) and `filterDiagnostics` (its own
// merge diagnostics, separate from the presentation `diagnostics` above). The
// UI folds `optionsRev` into the filter-bar rebuild signature and renders
// each diagnostic's severity as its own `is-*` class.
describe('renderDashboard — filter-source runtime rebuild + diagnostics (#359)', () => {
  it('renders presentation diagnostics from the viewer state', async () => {
    const { app } = dashApp({
      workspace: wsWith({
        queries: [q('q1', 'SELECT 1', { panel: { cfg: { type: 'kpi' } } })],
        tiles: [{ id: 'bad', queryId: 'q1', presentation: { variant: 'missing' } }],
      }),
    });
    await render(app);
    expect(qs(app.root, '.dash-config-diagnostic.is-error').textContent).toContain('missing');
  });

  it('rebuilds the filter bar when curated option CONTENT changes (same length), not on an unchanged republish', async () => {
    let call = 0;
    const { app } = dashApp({
      responder: (sql) => {
        if (sql.includes('opts')) {
          call++;
          // Same content on the first two runs (initial start + one refresh);
          // different content (same length) on the third run.
          return { columns: [{ name: 'p', type: 'Array(String)' }], rows: [[call === 3 ? ['a', 'b'] : ['x', 'y']]] };
        }
        return {};
      },
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
    const barBefore = qs(app.root, '.dash-filter-host').firstElementChild;
    expect(barBefore).not.toBeNull();
    // Refresh #1: the source republishes the SAME option content — no rebuild
    // (the pre-#359 boolean-only signature would have missed this distinction
    // too, since it only ever asked "empty vs non-empty").
    await (runOnclick(qs(app.root, '.dash-refresh')) as Promise<void>);
    expect(qs(app.root, '.dash-filter-host').firstElementChild).toBe(barBefore);
    // Refresh #2: the source returns DIFFERENT content, same length — this is
    // exactly the case the old boolean-only signature missed; `optionsRev`
    // fixes it.
    await (runOnclick(qs(app.root, '.dash-refresh')) as Promise<void>);
    expect(qs(app.root, '.dash-filter-host').firstElementChild).not.toBe(barBefore);
  });

  it('renders filterDiagnostics with severity-mapped classes, alongside presentation diagnostics', async () => {
    const { app } = dashApp({
      responder: (sql) => {
        if (sql.includes('optsinfo')) return { columns: [{ name: 'pinfo', type: 'Array(String)' }], rows: [[['x', 'x']]] };
        if (sql.includes('optswarn')) {
          return {
            columns: [{ name: 'pwarn2', type: 'Array(String)' }, { name: 'pwarn', type: 'Array(String)' }],
            rows: [[['a', 'b'], ['c', 'd']]],
          };
        }
        return {};
      },
      workspace: wsWith({
        queries: [
          // #189: every source-backed filter below needs a real EXECUTABLE
          // consumer declaring its own parameter (a scalar type) — otherwise
          // `resolveFilterSelection` sees zero consumers and the strict
          // fallback strips it from its source's `consumers` before the
          // source ever runs, at construction (never a benign carve-out
          // anymore — see `dashboard-viewer-session.ts`'s
          // `resolveFilterSelection` wiring). `t1` declares all three so
          // every one of `ferr`/`fwarn`/`finfo`'s sources still executes.
          q('q1', 'SELECT k, v FROM a WHERE x = {pinfo:String} AND w = {pwarn2:String} AND z = {perr:String}'),
          // A duplicate option value ('x' twice) → an 'info' diagnostic
          // (`filter-duplicate-option`) from readFilterOptions.
          q('srcInfo', "SELECT ['x','x'] AS pinfo -- optsinfo", { dashboard: { role: 'filter' } }),
          // 'pwarn2' is the REAL, consumed filter parameter (keeps this
          // shared source alive); 'pwarn' is an extra returned column no
          // filter definition even names — a genuinely-unmatched helper
          // column (not a no-consumer filter — #189 would have stripped
          // that before the source ever ran) → a 'warning' diagnostic
          // (`filter-helper-unused`) from the merge.
          q('srcWarn', "SELECT ['a','b'] AS pwarn2, ['c','d'] AS pwarn -- optswarn", { dashboard: { role: 'filter' } }),
        ],
        tiles: [{ id: 't1', queryId: 'q1' }],
        filters: [
          // An unresolvable source query id → an 'error' diagnostic
          // (`filter-source-missing`).
          { id: 'ferr', parameter: 'perr', sourceQueryId: 'nope' },
          { id: 'fwarn', parameter: 'pwarn2', sourceQueryId: 'srcWarn' },
          { id: 'finfo', parameter: 'pinfo', sourceQueryId: 'srcInfo' },
        ],
      }),
    });
    await render(app);
    const rows = qsa(app.root, '.dash-filter-diagnostics .dash-config-diagnostic');
    const bySeverity = (cls: string) => rows.find((r) => r.classList.contains(cls));
    expect(bySeverity('is-error')?.textContent).toBe('Filter references unknown source query "nope"');
    expect(bySeverity('is-warning')?.textContent).toBe('Filter helper "pwarn" has no current Panel consumer.');
    expect(bySeverity('is-info')?.textContent).toBe('Filter helper "pinfo" contains a duplicate value.');
  });
});

// #360 plan-review BLOCKER-2 (+ maintainer-review follow-up): `rebuildFilterBar`
// used to gate a filter into the curated (rich combobox) rendering path only
// `if (f.options && f.options.length)`, then — a first fix — `if (f.status
// !== 'idle')` — so a source-backed filter with NO options yet (waiting on a
// root dependency, mid-flight, or errored, OR simply not yet run) fell OUT of
// that path entirely and rendered as a bare, unlabelled plain field with zero
// indication anything was pending. The gate is now `f.sourceId != null` —
// TOPOLOGY, set once at construction, never the transient `status` — so a
// source-backed filter is ALWAYS curated, at any status, from the very first
// (still-'idle') render onward. A plain (non-source-backed) filter has no
// `sourceId` and never touches this path.
describe('renderDashboard — curated field stays curated while its shared source is waiting (#360)', () => {
  it('a source-backed filter whose source waits on a root dependency renders the curated waiting affordance, not a bare plain field', async () => {
    const { app, calls } = dashApp({
      workspace: wsWith({
        queries: [
          q('q1', 'SELECT k, v FROM a WHERE region = {region:String}'),
          // 'src' depends on the ROOT filter 'from', which starts inactive/blank
          // below — so this source is 'waiting', never executes ("depsrc" never
          // appears in `calls`), and publishes `options: null` for 'region'.
          q('src', "SELECT ['east','west'] AS region FROM a WHERE ts >= {from:String} -- depsrc", { dashboard: { role: 'filter' } }),
        ],
        tiles: [{ id: 't1', queryId: 'q1' }],
        filters: [
          { id: 'from-root', parameter: 'from', defaultActive: false, defaultValue: '' },
          { id: 'f-region', parameter: 'region', sourceQueryId: 'src' },
        ],
      }),
    });
    await render(app);
    expect(calls.some((c) => c.sql.includes('depsrc'))).toBe(false); // still waiting — never ran
    const fields = qsa(app.root, '.dash-filter-host .var-field');
    const regionField = fields.find((f) => qs(f, '.var-name')?.textContent === 'region');
    expect(regionField).toBeDefined();
    const region = regionField as HTMLElement;
    // Stays curated (not the old silent fall-out to a bare plain field) and
    // carries the structural waiting affordance: class + disabled input +
    // literal text naming the missing root param.
    expect(region.classList.contains('is-curated')).toBe(true);
    expect(region.classList.contains('is-waiting')).toBe(true);
    const input = qs<HTMLInputElement>(region, 'input');
    expect(input.disabled).toBe(true);
    expect(region.textContent).toContain('Waiting for: from');
  });
});

// #360 maintainer-review follow-up: `rebuildFilterBar` gates curation on
// TOPOLOGY (`sourceId != null`) and updates a settled bar's STATUS in place
// (`filterBar.updateStatus`, never a rebuild) — the effect's `barSig` (a
// structural signature: id/active/value/optionsRev/sourceId) is now separate
// from its own status signature (status/stale/waitingFor). These tests pin
// that split directly: a source-backed filter is curated from its very first
// (still-'idle'/'loading') render, a pure status change never disturbs the
// bar's DOM (same `<input>` instance — proof no rebuild happened), and a
// genuinely structural change (option content) still rebuilds it.
describe('renderDashboard — filter status vs. structural rebuild split (#360 follow-up)', () => {
  it('a source-backed filter is curated and shows the pending affordance before its shared source has ever settled — never an enabled plain control', async () => {
    let resolveSrc!: (v: ExecResp) => void;
    const pendingSrc = new Promise<ExecResp>((resolve) => { resolveSrc = resolve; });
    const { app } = dashApp({
      responder: (sql) => (sql.includes('pendingsrc') ? pendingSrc : {}),
      workspace: wsWith({
        queries: [
          q('q1', 'SELECT k, v FROM a WHERE region = {region:String}'),
          q('src', "SELECT ['east','west'] AS region -- pendingsrc", { dashboard: { role: 'filter' } }),
        ],
        tiles: [{ id: 't1', queryId: 'q1' }],
        filters: [{ id: 'f-region', parameter: 'region', sourceQueryId: 'src' }],
      }),
    });
    const rendering = render(app);
    // Flush the microtasks up to (but not past) the in-flight source query's
    // own await — same technique as the KPI "Loading…" card test above: the
    // session sets status 'loading' (mirroring its still-'idle' construction-
    // time value — both read as "pending" — see `applyFieldStatus`) and
    // publishes synchronously before awaiting the responder.
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    const fields = qsa(app.root, '.dash-filter-host .var-field');
    const regionField = fields.find((f) => qs(f, '.var-name')?.textContent === 'region') as HTMLElement;
    expect(regionField).toBeDefined();
    expect(regionField.classList.contains('is-curated')).toBe(true);
    expect(regionField.classList.contains('is-stale')).toBe(true);
    const input = qs<HTMLInputElement>(regionField, 'input');
    expect(input.disabled).toBe(true);
    resolveSrc({ columns: [{ name: 'region', type: 'Array(String)' }], rows: [[['east', 'west']]] });
    await rendering;
    // Settles to 'ready' — the SAME curated field, now enabled with options.
    const settledInput = qs<HTMLInputElement>(app.root, '.dash-filter-host input');
    expect(settledInput.disabled).toBe(false);
  });

  it('a status-only refresh (unchanged options/value/active) updates the field in place — its <input> instance survives, no rebuild', async () => {
    const { app } = dashApp({
      responder: (sql) => (sql.includes('samesrc')
        ? { columns: [{ name: 'region', type: 'Array(String)' }], rows: [[['east', 'west']]] } : {}),
      workspace: wsWith({
        queries: [
          q('q1', 'SELECT k, v FROM a WHERE region = {region:String}'),
          q('src', "SELECT ['east','west'] AS region -- samesrc", { dashboard: { role: 'filter' } }),
        ],
        tiles: [{ id: 't1', queryId: 'q1' }],
        filters: [{ id: 'f-region', parameter: 'region', sourceQueryId: 'src' }],
      }),
    });
    await render(app);
    const inputBefore = qs<HTMLInputElement>(app.root, '.dash-filter-host input');
    // A refresh republishes the exact same option content — status cycles
    // loading → ready with optionsRev unchanged, so only `updateStatus` runs.
    await (runOnclick(qs(app.root, '.dash-refresh')) as Promise<void>);
    const inputAfter = qs<HTMLInputElement>(app.root, '.dash-filter-host input');
    expect(inputAfter).toBe(inputBefore);
    expect(inputAfter.disabled).toBe(false);
  });

  it('a structural change (option content changes) still rebuilds the bar — a fresh <input> instance', async () => {
    let call = 0;
    const { app } = dashApp({
      responder: (sql) => (sql.includes('changingsrc')
        ? (() => { call++; return { columns: [{ name: 'region', type: 'Array(String)' }], rows: [[call === 1 ? ['east', 'west'] : ['north', 'south']]] }; })()
        : {}),
      workspace: wsWith({
        queries: [
          q('q1', 'SELECT k, v FROM a WHERE region = {region:String}'),
          q('src', "SELECT ['east','west'] AS region -- changingsrc", { dashboard: { role: 'filter' } }),
        ],
        tiles: [{ id: 't1', queryId: 'q1' }],
        filters: [{ id: 'f-region', parameter: 'region', sourceQueryId: 'src' }],
      }),
    });
    await render(app);
    const inputBefore = qs<HTMLInputElement>(app.root, '.dash-filter-host input');
    await (runOnclick(qs(app.root, '.dash-refresh')) as Promise<void>);
    const inputAfter = qs<HTMLInputElement>(app.root, '.dash-filter-host input');
    expect(inputAfter).not.toBe(inputBefore); // optionsRev bumped — a real rebuild
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
    fetch: asFetch(makeFetch([])), now: () => 0, retryMs: 0,
    navigator: { clipboard: { writeText: clipboardWriteText } as Clipboard },
    ...over,
  };
}
/** `realApp` retypes a real `createApp(env)` object as `App` WITHOUT copying
 * it (unlike `makeApp()`'s own internal defaults-then-overrides spread):
 * createApp's *inferred* return type only reflects the initial object-literal
 * fields app.js builds (state/dom/root/…) — the ~270 other members (actions,
 * ensureConfig, chCtx, renderApp, …) are attached via
 * later property assignment inside that same untyped function, invisible to
 * declaration inference, but genuinely present on the one real object at
 * runtime. Several of those methods are closures over `app.conn` — the real
 * `ConnectionSession` (#276 Phase 2) createApp constructs and wires in place,
 * whose own internal `token`/`authMode`/… locals mutate on `setTokens` and
 * related operations — so returning a spread COPY here (as
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
const asFetch = (v: object): typeof globalThis.fetch => v as typeof globalThis.fetch;

describe('app config base on the unified route', () => {
  it('resolves config.json from /sql for Dashboard query state', async () => {
    const fetch = makeFetch([]);
    const app = realApp(appEnv({
      fetch: asFetch(fetch),
      location: {
        host: 'ch.example', origin: 'https://ch.example', pathname: '/sql',
        search: '?ws=workspace&surface=dashboard', hash: '',
        href: 'https://ch.example/sql?ws=workspace&surface=dashboard',
      } as Location,
    }));
    await app.conn.ensureConfig();
    const urls = fetch.mock.calls.map((c) => c[0]);
    expect(urls.some((u) => /\/sql\/config\.json$/.test(u))).toBe(true);
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
    // Drive the read-flip deterministically: a StoredWorkspaceV2 whose one tile
    // references the query (bypassing IndexedDB), then the real exec seam runs it.
    const query = savedQuery({ id: '1', name: 'Q', sql: 'SELECT k, v FROM mychart' });
    app.currentWorkspace = {
      storageVersion: 2, id: 'w', key: 'workspace', name: 'W', queries: [query],
      dashboard: { documentVersion: 1, id: 'd', title: 'D', revision: 1, layout: { type: 'flow', version: 1, preset: 'report', items: {} }, filters: [], tiles: [{ id: 't1', queryId: '1' }] },
    };
    app.sqlRoute = { surface: 'dashboard', workspaceKey: 'workspace', mode: 'edit' };
    await app.renderDashboard();
    expect(qs(app.root, '.dash-tile canvas')).not.toBeNull();
    // The read-only tile guard (readonly=2) + the row-cap sentinel reach the wire.
    expect(fetch.mock.calls.some((c) => /readonly=2/.test(c[0]))).toBe(true);
    expect(fetch.mock.calls.some((c) => /max_result_rows=5001/.test(c[0]))).toBe(true);
  });
});

// ── #407: live route modes + the Dashboard header File menu ─────────────────
function modeApp(opts: {
  workspace?: ReturnType<typeof wsWith> | null;
  mode?: 'edit' | 'view';
  responder?: ExecResponder;
} = {}) {
  const built = dashApp({ workspace: opts.workspace, responder: opts.responder });
  const app = built.app;
  app.sqlRoute = {
    surface: 'dashboard',
    workspaceKey: opts.workspace?.key ?? 'workspace',
    mode: opts.mode ?? 'edit',
  };
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

describe('renderDashboard — unified live modes (#407)', () => {
  afterEach(() => { qsa(document, '.dash-file-menu, .fm-overlay').forEach((n) => n.remove()); });

  it('edit mode renders the live workspace with authoring controls', async () => {
    const ws = wsWith({ id: 'd', queries: [q('q1', 'SELECT 1')], tiles: [{ id: 't1', queryId: 'q1' }] });
    const { app } = modeApp({ workspace: ws, mode: 'edit' });
    await render(app);
    expect(qsa(app.root, '.dash-tile').length).toBe(1);
    expect(qs(app.root, '.dash-tile .dash-gg-grip')).not.toBeNull();
    expect(layoutSelect(app.root)).toBeTruthy();
  });

  it('view mode renders that same live document without mutation controls', async () => {
    const ws = wsWith({
      id: 'd', queries: [q('q1', 'SELECT 1')], tiles: [{ id: 't1', queryId: 'q1' }],
      layout: { type: 'grafana-grid', version: 1, items: {} },
    });
    const { app, commit } = modeApp({ workspace: ws, mode: 'view' });
    await render(app);
    expect(qsa(app.root, '.dash-tile').length).toBe(1);
    expect(qs(app.root, '.dash-tile .dash-gg-grip')).toBeNull();
    const select = layoutSelect(app.root);
    expect(select).not.toBeNull();
    expect([...select.options].map((o) => o.value)).toEqual(['grafana-grid', 'full']);
    expect(commit).not.toHaveBeenCalled();
  });

  it('missing workspace renders not-found and executes nothing', async () => {
    const { app, calls } = modeApp({ workspace: null, mode: 'view' });
    await render(app);
    expect(qs(app.root, '.dash-notfound')).toBeTruthy();
    expect(app.root?.textContent).toContain('Workspace not found');
    expect(calls.length).toBe(0);
  });

  it('missing dashboard differs in view and edit, and Create persists only on click', async () => {
    const empty = { ...wsWith(), dashboard: null } as unknown as ReturnType<typeof wsWith>;
    const viewed = modeApp({ workspace: empty, mode: 'view' });
    await render(viewed.app);
    expect(viewed.app.root?.textContent).toContain('This workspace has no dashboard');
    expect(viewed.calls).toHaveLength(0);
    const edited = modeApp({ workspace: empty, mode: 'edit' });
    await render(edited.app);
    const create = qs<HTMLButtonElement>(edited.app.root, '.dash-create');
    expect(edited.commit).not.toHaveBeenCalled();
    create.click();
    await flush();
    expect(edited.commit).toHaveBeenCalledOnce();
    expect(edited.commit.mock.calls[0][0].dashboard).not.toBeNull();
  });

  it.each(['view', 'edit'] as const)(
    'a missing Dashboard in %s mode rerenders when another tab creates it',
    async (mode) => {
      const empty = { ...wsWith(), dashboard: null } as unknown as ReturnType<typeof wsWith>;
      const { app } = modeApp({ workspace: empty, mode });
      const rerender = vi.fn();
      app.renderDashboard = rerender;
      await render(app);
      const created = wsWith({ id: 'created-elsewhere' }) as unknown as StoredWorkspaceV2;
      app.currentWorkspace = created;
      app.onWorkspaceExternallyChanged({ workspace: created, queriesChanged: false });
      expect(rerender).toHaveBeenCalledOnce();
    },
  );

  it('Create dashboard aborts if another producer created one before the click commits', async () => {
    const empty = { ...wsWith(), dashboard: null } as unknown as ReturnType<typeof wsWith>;
    const { app, commit } = modeApp({ workspace: empty, mode: 'edit' });
    await render(app);
    const concurrentlyUpdated = wsWith({ id: 'already-created' }) as unknown as StoredWorkspaceV2;
    app.workspace.loadById = vi.fn(async () => ({
      status: 'ok' as const, workspace: concurrentlyUpdated,
    }));
    qs<HTMLButtonElement>(app.root, '.dash-create').click();
    await flush();
    expect(commit).not.toHaveBeenCalled();
  });

  it('route controls use push for surface and replace for mode', async () => {
    const { app } = modeApp({ workspace: wsWith(), mode: 'edit' });
    app.navigateSqlRoute = vi.fn(async () => {});
    await render(app);
    qsa<HTMLButtonElement>(app.root, '.app-surface-switch .editor-mode-btn')
      .find((b) => b.textContent === 'SQL Browser')!.click();
    const dashboardButton = qsa<HTMLButtonElement>(app.root, '.app-surface-switch .editor-mode-btn')
      .find((b) => b.textContent === 'Dashboard')!;
    expect(dashboardButton.disabled).toBe(true);
    dashboardButton.click();
    qsa<HTMLButtonElement>(app.root, '.dashboard-mode-switch .editor-mode-btn')
      .find((b) => b.textContent === 'View')!.click();
    qsa<HTMLButtonElement>(app.root, '.dashboard-mode-switch .editor-mode-btn')
      .find((b) => b.textContent === 'Edit')!.click();
    app.sqlRoute = { surface: 'dashboard', workspaceKey: 'workspace', mode: 'view' };
    await render(app);
    qsa<HTMLButtonElement>(app.root, '.dashboard-mode-switch .editor-mode-btn')
      .find((b) => b.textContent === 'Edit')!.click();
    expect(app.navigateSqlRoute).toHaveBeenNthCalledWith(
      1, { surface: 'workspace', workspaceKey: 'workspace' }, 'push',
    );
    expect(app.navigateSqlRoute).toHaveBeenNthCalledWith(
      2, { surface: 'dashboard', workspaceKey: 'workspace', mode: 'view' }, 'replace',
    );
    expect(app.navigateSqlRoute).toHaveBeenNthCalledWith(
      3, { surface: 'dashboard', workspaceKey: 'workspace', mode: 'edit' }, 'replace',
    );
  });

  it('uses the shared compact application header and keeps Dashboard details below it', async () => {
    const { app } = modeApp({ workspace: wsWith(), mode: 'edit' });
    app.state.serverVersion = '26.3.10.4';
    await render(app);
    const header = qs(app.root, '.app-header');
    expect(qs(header, '.logo-name').textContent).toBe('Altinity®');
    expect(qsa(header, '.app-surface-switch .editor-mode-btn').map((button) => button.textContent))
      .toEqual(['SQL Browser', 'Dashboard']);
    expect(qsa(header, '.dashboard-mode-switch .editor-mode-btn').map((button) => button.textContent))
      .toEqual(['View', 'Edit']);
    expect(qs(header, '.dash-title')).toBeNull();
    expect(qs(header, '.conn-status').textContent).toBe('ClickHouse 26.3.10');
    expect(qs(app.root, '.dash-contextbar .dash-title')).not.toBeNull();
  });

  it('an old Dashboard refresh hook is inert after the route leaves Dashboard', async () => {
    const { app } = modeApp({ workspace: wsWith(), mode: 'view' });
    await render(app);
    const page = app.root!.firstChild;
    const staleHook = app.onWorkspaceExternallyChanged;
    app.sqlRoute = { surface: 'workspace', workspaceKey: 'workspace' };
    staleHook({ workspace: app.currentWorkspace!, queriesChanged: true });
    await flush();
    expect(app.root!.firstChild).toBe(page);
  });
});

describe('renderDashboard — Dashboard header File menu (#302)', () => {
  afterEach(() => { qsa(document, '.dash-file-menu, .fm-overlay').forEach((n) => n.remove()); });

  const editApp = () => modeApp({
    workspace: wsWith({ id: 'd', queries: [q('q1', 'SELECT 1')], tiles: [{ id: 't1', queryId: 'q1' }] }),
    mode: 'edit',
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

  it('edit mode opens Export / Import with sections and supports toggle + Escape close', async () => {
    const { app } = editApp();
    app.actions = { ...app.actions, exportDashboard: vi.fn(), importDashboard: vi.fn() };
    await render(app);
    const btn = qs<HTMLButtonElement>(app.root, '.dash-file-btn');
    openFileMenuBtn(app.root);
    expect(btn.getAttribute('aria-expanded')).toBe('true');
    expect(menuSections()).toEqual(['Export', 'Import']);
    expect(menuItems()).toEqual(['Export Dashboard…', 'Import Dashboard…']);
    expect(qs(document, '.dash-file-menu .fm-meta').textContent).toBe('.json');
    // arrow-key navigation between items
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    // Escape closes + restores aria
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
    app.actions = { ...app.actions, exportDashboard: vi.fn(), importDashboard: vi.fn() };
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

  it('editable current-workspace mode includes the File button (#347)', async () => {
    const { app } = editApp();
    await render(app);
    expect(qs(app.root, '.dash-file-btn')).not.toBeNull();
  });

  it('live view mode keeps the shared File word but offers export only', async () => {
    const workspace = wsWith({ id: 'd', queries: [q('q1', 'SELECT 1')], tiles: [{ id: 't1', queryId: 'q1' }] });
    const { app } = modeApp({ workspace, mode: 'view' });
    await render(app);
    qs<HTMLButtonElement>(app.root, '.dash-file-btn').click();
    const labels = qsa(document, '.dash-file-menu .fm-label').map((el) => el.textContent);
    expect(labels).toContain('Export Dashboard…');
    expect(labels).not.toContain('Import Dashboard…');
  });

  it('live view shows the shared workspace name without exposing Rename', async () => {
    const workspace = wsWith({ id: 'd' });
    const { app } = modeApp({ workspace, mode: 'view' });
    app.state.libraryName.value = 'Operations';
    await render(app);
    expect(qs(app.root, '.lib-title').textContent).toBe('Operations');
    expect(qs(app.root, 'button.lib-name')).toBeNull();
    expect(qs(app.root, '.lib-name').getAttribute('aria-label')).toBe('Workspace: Operations');
  });

  it('an unrelated keydown while the menu is open is ignored', async () => {
    const { app } = editApp();
    await render(app);
    openFileMenuBtn(app.root);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    expect(document.querySelector('.dash-file-menu')).toBeTruthy(); // still open
  });
});

// ── runCommand — the #341 serialized write pipeline ─────────────────────────
// Every editable Dashboard command now commits through `app.serializeWrite`
// (the SAME queue saved-query mutations and file-menu commits use), projects
// the returned committed workspace onto `app.state` via
// `app.applyCommittedWorkspace`, and rolls back deterministically on failure.
describe('renderDashboard — the serialized write pipeline (#341)', () => {
  const twoTiles = () => wsWith({
    queries: [q('q1', 'SELECT 1'), q('q2', 'SELECT 1')],
    tiles: [{ id: 't1', queryId: 'q1' }, { id: 't2', queryId: 'q2' }],
    layout: { type: 'flow', version: 1, preset: 'report', items: {} },
  });
  const twoTilesGrid = () => wsWith({
    queries: [q('q1', 'SELECT 1'), q('q2', 'SELECT 1')],
    tiles: [{ id: 't1', queryId: 'q1' }, { id: 't2', queryId: 'q2' }],
    layout: { type: 'grafana-grid', version: 1, items: {} },
  });

  it('a successful move-tile projects the committed workspace onto app.state via applyCommittedWorkspace', async () => {
    const { app, commit } = dashApp({ workspace: twoTiles() });
    await render(app);
    const cards = qsa(app.root, '.dash-tile');
    stubTileRects(cards);
    dragTile(cards, 1, 0);
    await flush();
    expect(commit).toHaveBeenCalledTimes(1);
    expect(app.state.dashboard?.tiles.map((t) => t.queryId)).toEqual(['q2', 'q1']);
    expect(app.state.dashboard?.revision).toBe(2); // one successful commit past the loaded revision 1
    expect(app.state.workspaceId).toBe('w'); // the whole projection ran, not just the dashboard field
  });

  it('drops an optimistic command when the dashboard disappeared before dequeue', async () => {
    const { app, commit } = dashApp({ workspace: twoTiles() });
    await render(app);
    app.workspace.loadById = vi.fn(async () => ({
      status: 'ok' as const,
      workspace: {
        storageVersion: 2 as const, id: 'w', key: 'workspace', name: 'W', queries: [], dashboard: null,
      },
    }));
    const cards = qsa<HTMLElement>(app.root, '.dash-tile');
    stubTileRects(cards);
    dragTile(cards, 1, 0);
    await flush();
    expect(commit).not.toHaveBeenCalled();
    expect(qs(document, '.share-toast').textContent).toContain('no longer applies');
  });

  it('a successful change-layout (flow preset) projects the committed workspace, including the new revision', async () => {
    const { app, commit } = dashApp({ workspace: twoTiles() });
    await render(app);
    pickLayout(app.root, 'columns-2');
    await flush();
    expect(commit).toHaveBeenCalledTimes(1);
    expect(app.state.dashboard?.layout).toEqual({ type: 'flow', version: 1, preset: 'columns-2', items: {} });
    expect(app.state.dashboard?.revision).toBe(2);
  });

  it('a successful grid corner-resize (update-placement) projects the committed workspace', async () => {
    const { app, commit } = dashApp({ workspace: twoTilesGrid() });
    await render(app);
    const gridEl = qs(app.root, '.dash-gg-grid');
    Object.defineProperty(gridEl, 'clientWidth', { value: 1200, configurable: true });
    const card = qsa<HTMLElement>(app.root, '.dash-gg-tile')[0];
    const handle = qs<HTMLElement>(card, '.dash-gg-resize');
    handle.dispatchEvent(new PointerEvent('pointerdown', { clientX: 0, clientY: 0 }));
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: 600, clientY: 280 }));
    window.dispatchEvent(new PointerEvent('pointerup'));
    await flush();
    expect(commit).toHaveBeenCalledTimes(1);
    const layout = app.state.dashboard?.layout as { items: Record<string, { span?: number }> };
    expect(layout.items.t1?.span).toBe(6);
    expect(app.state.dashboard?.revision).toBe(2);
  });

  it('a successful remove-tile (grafana-grid delete) projects the committed workspace with the tile gone', async () => {
    const { app, commit } = dashApp({ workspace: twoTilesGrid() });
    await render(app);
    qs<HTMLButtonElement>(app.root, '.dash-gg-del').click();
    await flush();
    expect(commit).toHaveBeenCalledTimes(1);
    expect(app.state.dashboard?.tiles).toHaveLength(1);
    expect(app.state.dashboard?.tiles[0].id).toBe('t2');
    expect(app.state.dashboard?.revision).toBe(2);
  });

  it('remove-tile atomically clears the final query favorite and every explicit filter target', async () => {
    const workspace = wsWith({
      queries: [q('q1', 'SELECT {x:String}', { favorite: true }), q('q2', 'SELECT 2')],
      tiles: [{ id: 't1', queryId: 'q1' }, { id: 't2', queryId: 'q2' }],
      filters: [
        { id: 'f1', parameter: 'x', targets: ['t1', 't2'] },
        { id: 'f2', parameter: 'y', targets: ['t1'] },
      ],
      layout: { type: 'grafana-grid', version: 1, items: {} },
    });
    const { app, commit } = dashApp({ workspace });
    await render(app);
    qs<HTMLButtonElement>(app.root, '.dash-gg-del').click();
    await flush();
    const candidate = commit.mock.calls[0][0];
    expect(candidate.queries.find((query) => query.id === 'q1')?.spec.favorite).toBe(false);
    expect(candidate.dashboard?.filters.map((filter) => filter.targets)).toEqual([['t2'], []]);
    expect(candidate.dashboard?.revision).toBe(2);
  });

  it('remove-tile keeps favorite true when another tile instance references the query', async () => {
    const workspace = wsWith({
      queries: [q('q1', 'SELECT 1', { favorite: true })],
      tiles: [{ id: 't1', queryId: 'q1' }, { id: 't2', queryId: 'q1' }],
      layout: { type: 'grafana-grid', version: 1, items: {} },
    });
    const { app, commit } = dashApp({ workspace });
    await render(app);
    qs<HTMLButtonElement>(app.root, '.dash-gg-del').click();
    await flush();
    const candidate = commit.mock.calls[0][0];
    expect(candidate.dashboard?.tiles).toEqual([{ id: 't2', queryId: 'q1' }]);
    expect(candidate.queries[0].spec.favorite).toBe(true);
    expect(candidate.dashboard?.revision).toBe(2);
  });

  it('missing workspace renders a dedicated not-found state and never commits', async () => {
    const { app, commit } = dashApp({
      workspace: null, savedQueries: [q('q1', 'SELECT 1', { favorite: true })],
    });
    await render(app);
    expect(app.root.textContent).toContain('Workspace not found');
    expect(app.root.querySelector('.dash-layout-select')).toBeNull();
    expect(commit).not.toHaveBeenCalled();
  });

  it('rapid commands commit in STRICT invocation order — a slow-to-resolve first commit is never skipped or reordered by a second', async () => {
    const seen: string[] = [];
    let resolveFirst!: (v: unknown) => void;
    const commit = vi.fn((candidate: StoredWorkspaceV2) => {
      const layout = candidate.dashboard!.layout;
      seen.push(layout.type === 'flow' ? String(layout.preset) : layout.type);
      const result = { ok: true as const, workspace: candidate, dashboardRevision: candidate.dashboard!.revision };
      if (seen.length === 1) return new Promise((resolve) => { resolveFirst = resolve; }).then(() => result);
      return Promise.resolve(result);
    });
    const { app } = dashApp({ workspace: twoTiles(), commit: commit as unknown as Mock<App['workspace']['commit']> });
    await render(app);
    pickLayout(app.root, 'columns-2'); // first — deliberately slow to resolve
    pickLayout(app.root, 'columns-3'); // second — fired while the first is still pending
    // Neither op has reached `commit()` yet — `serializeWrite` + `mutateWorkspace`
    // defer even the FIRST call by a few microtask hops (`loadCurrent()`'s own
    // await, the `transform` await, the async return of `commit(...)` — all
    // plain microtask ticks, never a macrotask), so draining several here still
    // never gives the still-pending first commit a chance to resolve.
    for (let i = 0; i < 6; i++) await Promise.resolve();
    expect(seen).toEqual(['columns-2']); // only the first has reached commit() — the second is queued behind it
    resolveFirst(undefined);
    await flush();
    expect(seen).toEqual(['columns-2', 'columns-3']); // commit order == invocation order, never reordered
    // The LATER command's projection is what's left standing — the queue never
    // let the (slower-to-resolve, but earlier-invoked) first commit's
    // projection run after the second's.
    expect(app.state.dashboard?.layout.preset).toBe('columns-3');
    // #341 (review): each candidate is built INSIDE its queued op from the
    // freshest committed baseline, so revisions stay strictly monotonic across
    // rapid commits — two successful commits advance the loaded revision 1 → 3,
    // never a duplicated 2 baked from a stale synchronous closure.
    expect(app.state.dashboard?.revision).toBe(3);
  });

  it('a failed commit rolls back to the last committed dashboard, toasts, and does not wedge the queue for a later command', async () => {
    const commit = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        diagnostics: [{ path: [], severity: 'error', code: 'workspace-persist-failed', message: 'boom' }],
      })
      .mockImplementation(async (candidate: StoredWorkspaceV2) => (
        { ok: true, workspace: candidate, dashboardRevision: candidate.dashboard ? candidate.dashboard.revision : null }
      ));
    const { app } = dashApp({ workspace: twoTiles(), commit });
    await render(app);
    pickLayout(app.root, 'columns-2'); // will fail
    await flush();
    expect(commit).toHaveBeenCalledTimes(1);
    // Rolled back to the last COMMITTED truth (the originally-loaded 'report'
    // preset) — never left standing on the failed candidate.
    expect(layoutSelect(app.root).value).toBe('report');
    expect(app.state.dashboard?.layout).toEqual({ type: 'flow', version: 1, preset: 'report', items: {} });
    expect(app.state.dashboard?.revision).toBe(1); // never advanced past the loaded revision
    const toastEl = document.querySelector('.share-toast');
    expect(toastEl?.textContent).toBe('✕ boom');
    // The queue is NOT wedged — a later command still commits successfully.
    pickLayout(app.root, 'columns-3');
    await flush();
    expect(commit).toHaveBeenCalledTimes(2);
    expect(app.state.dashboard?.layout.preset).toBe('columns-3');
    expect(app.state.dashboard?.revision).toBe(2);
  });

  // #344 review fix: the exact case the pre-#344 `latestOptimistic` scheme got
  // wrong — command B's optimistic doc was built ON TOP OF command A's, so
  // when A's commit failed AFTER B had already become "latest", A's rollback
  // was skipped and B's later successful commit persisted a document that
  // structurally CONTAINED A's rejected edit. The descriptor queue + rebase
  // must make A's effect vanish from the committed workspace once A fails,
  // regardless of what B does afterward.
  it('overlapping fail-then-success: an older command that fails never survives inside a newer command\'s commit', async () => {
    let resolveA!: (v: unknown) => void;
    const commit = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => { resolveA = resolve; }))
      .mockImplementation(async (candidate: StoredWorkspaceV2) => (
        { ok: true as const, workspace: candidate, dashboardRevision: candidate.dashboard ? candidate.dashboard.revision : null }
      ));
    const { app } = dashApp({ workspace: twoTilesGrid(), commit });
    await render(app);
    const gridEl = qs(app.root, '.dash-gg-grid');
    Object.defineProperty(gridEl, 'clientWidth', { value: 1200, configurable: true });
    const [card0, card1] = qsa<HTMLElement>(app.root, '.dash-gg-tile');
    // A: resize t1's placement (update-placement) — its commit is deliberately
    // deferred. Neither this nor B ever changes tiles[] MEMBERSHIP (only a
    // per-tile placement), so the viewer session's own runtime tracking is
    // untouched by either — a resize/reorder never risks the "unknown IDs are
    // dropped" constraint a remove-then-reinstate would (`syncDocument`,
    // dashboard-viewer-session.ts).
    qs<HTMLElement>(card0, '.dash-gg-resize').dispatchEvent(new PointerEvent('pointerdown', { clientX: 0, clientY: 0 }));
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: 600, clientY: 280 }));
    window.dispatchEvent(new PointerEvent('pointerup'));
    // B: resize t2's placement — a DIFFERENT tile, dispatched BEFORE A's
    // commit resolves.
    qs<HTMLElement>(card1, '.dash-gg-resize').dispatchEvent(new PointerEvent('pointerdown', { clientX: 0, clientY: 0 }));
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: 300, clientY: 140 }));
    window.dispatchEvent(new PointerEvent('pointerup'));
    for (let i = 0; i < 6; i++) await Promise.resolve(); // let both ops reach the queue; A's commit is still pending
    resolveA({
      ok: false,
      diagnostics: [{ path: [], severity: 'error', code: 'workspace-persist-failed', message: 'boom' }],
    });
    await flush();
    const layout = app.state.dashboard?.layout as { items: Record<string, { span?: number }> };
    // A's placement change never persisted — t1 keeps no explicit placement
    // entry, exactly its pre-command state (`twoTilesGrid`'s `items: {}`).
    expect(layout.items.t1).toBeUndefined();
    // B's placement change DID persist — t2 has a real entry.
    expect(layout.items.t2?.span).toBeGreaterThan(0);
    expect(document.querySelector('.share-toast')?.textContent).toBe('✕ boom');
  });

  // #344 review fix: a mixed producer (a saved-query-style mutation, not a
  // Dashboard command) committing through the SAME shared queue while a
  // Dashboard command's own commit is pending must not be reverted by that
  // Dashboard command — its candidate is built from `app.workspace.loadCurrent()`
  // at dequeue time, never a route-local snapshot taken when the route opened.
  it('a producer other than Dashboard commands (a saved-query mutation) commits through the same queue without being clobbered', async () => {
    const { app, loadActive } = dashApp({ workspace: twoTilesGrid() });
    await render(app);
    // Simulate another producer (e.g. the saved-query drawer) mutating
    // `queries` through the shared `app.mutateWorkspace` queue.
    const extraQueryMutation = app.mutateWorkspace((latest) => {
      if (!latest) return null;
      return { candidate: { ...latest, queries: [...latest.queries, q('q3', 'SELECT 3')] } };
    });
    // Dispatch a Dashboard command while that mutation is still in flight
    // (both share the one `serializeWrite` chain, so this queues behind it).
    qs<HTMLButtonElement>(app.root, '.dash-gg-del').click(); // removes q1's tile
    await Promise.all([extraQueryMutation, flush()]);
    await flush();
    // Both edits are present: the extra query AND the tile removal.
    expect(app.state.savedQueries.map((sq) => sq.id)).toEqual(['q1', 'q2', 'q3']);
    expect(app.state.dashboard?.tiles.map((t) => t.queryId)).toEqual(['q2']);
  });

  // #344 review fix: a command that applies cleanly against its OPTIMISTIC
  // doc but no longer applies against COMMITTED truth by the time it's
  // dequeued (e.g. a concurrent commit already removed the tile it targets)
  // must null-abort — roll back its own optimistic edit, toast, and leave the
  // queue usable for the next command.
  it('a command invalidated against committed truth by the time it is dequeued rolls back and does not wedge the queue', async () => {
    const { app, loadActive } = dashApp({ workspace: twoTilesGrid() });
    await render(app);
    const gridEl = qs(app.root, '.dash-gg-grid');
    Object.defineProperty(gridEl, 'clientWidth', { value: 1200, configurable: true });
    const [card0] = qsa<HTMLElement>(app.root, '.dash-gg-tile');
    // Directly commit a workspace with t1 already removed — simulates another
    // producer (not routed through THIS route's `runCommand`) having removed
    // it moments before the command below dequeues. This never touches
    // `currentDoc`/the rendered session directly (only a later `runCommand`
    // resolution does) — the sanity check confirms it landed in the store.
    await app.mutateWorkspace((latest) => (latest ? { candidate: { ...latest, dashboard: { ...latest.dashboard!, tiles: [latest.dashboard!.tiles[1]], revision: latest.dashboard!.revision + 1 } } } : null));
    expect((await loadActive()).dashboard?.tiles.map((t) => t.id)).toEqual(['t2']);
    // Resize t1's placement through the UI — t1 is still present in this
    // route's OWN optimistic `currentDoc` (it hasn't seen the concurrent
    // removal yet), so it applies optimistically (a plain placement change,
    // never a tiles[] membership change — no risk of the viewer session
    // dropping a runtime record), but must null-abort at dequeue time once
    // `applyCommand` re-runs it against committed truth, where t1 no longer
    // exists.
    qs<HTMLElement>(card0, '.dash-gg-resize').dispatchEvent(new PointerEvent('pointerdown', { clientX: 0, clientY: 0 }));
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: 600, clientY: 280 }));
    window.dispatchEvent(new PointerEvent('pointerup'));
    await flush();
    expect(document.querySelector('.share-toast')?.textContent).toBe('Change no longer applies — undone');
    // #344 review 2: the abort rebased from the DEQUEUE-TIME committed truth
    // (the transform's observed `latest`), not the stale route cache — t1
    // (which the concurrent commit removed) is GONE from the rendered
    // Dashboard, not restored by a stale two-tile rollback.
    expect(qsa(app.root, '.dash-gg-tile')).toHaveLength(1);
    expect(app.state.dashboard?.tiles.map((t) => t.id)).toEqual(['t2']);
    // The queue is not wedged — a later, valid command (removing t2, which IS
    // still present in committed truth) still commits successfully. Committed
    // truth only ever had t2 (the external mutation above already dropped t1),
    // so removing it empties the persisted tiles list.
    qsa<HTMLButtonElement>(app.root, '.dash-gg-del')[0].click();
    await flush();
    expect((await loadActive()).dashboard?.tiles).toEqual([]);
  });

  // #350 (pulled into scope by review 2): a rebase that RESTORES membership —
  // a remove-tile whose commit failed and rolled back — cannot be applied by
  // `syncDocument` (the session already dropped the tile's runtime record and
  // never reinstates unknown ids), so the route must REBUILD from committed
  // truth: the restored tile's DOM comes back, not just `app.state`.
  it('a failed remove-tile rolls back by rebuilding the route — the removed tile is rendered again', async () => {
    const commit = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        diagnostics: [{ path: [], severity: 'error', code: 'workspace-persist-failed', message: 'boom' }],
      })
      .mockImplementation(async (candidate: StoredWorkspaceV2) => (
        { ok: true, workspace: candidate, dashboardRevision: candidate.dashboard ? candidate.dashboard.revision : null }
      ));
    const workspace = wsWith({
      queries: [q('q1', 'SELECT {x:String}', { favorite: true }), q('q2', 'SELECT 2')],
      tiles: [{ id: 't1', queryId: 'q1' }, { id: 't2', queryId: 'q2' }],
      filters: [{ id: 'f1', parameter: 'x', targets: ['t1'] }],
      layout: { type: 'grafana-grid', version: 1, items: {} },
    });
    const { app, loadActive } = dashApp({ workspace, commit });
    await render(app);
    expect(qsa(app.root, '.dash-gg-tile')).toHaveLength(2);
    qs<HTMLButtonElement>(app.root, '.dash-gg-del').click(); // remove t1 — its commit fails
    // Optimistic removal is instant.
    expect(qsa(app.root, '.dash-gg-tile')).toHaveLength(1);
    await flush();
    await flush(); // the rebuild is itself an async render pass
    expect(document.querySelector('.share-toast')?.textContent).toBe('✕ boom');
    // Rolled back: BOTH tiles are rendered again (route rebuilt from committed
    // truth), and nothing was persisted.
    expect(qsa(app.root, '.dash-gg-tile')).toHaveLength(2);
    expect(app.state.dashboard?.tiles.map((t) => t.id)).toEqual(['t1', 't2']);
    expect(app.state.dashboard?.filters[0].targets).toEqual(['t1']);
    expect(queryFavorite(app.state.savedQueries.find((query) => query.id === 'q1'))).toBe(true);
    expect((await loadActive()).dashboard?.tiles.map((t) => t.id)).toEqual(['t1', 't2']);
    // The rebuilt route is fully functional — a later command still commits.
    qsa<HTMLButtonElement>(app.root, '.dash-gg-del')[1].click();
    await flush();
    expect((await loadActive()).dashboard?.tiles.map((t) => t.id)).toEqual(['t1']);
  });

  // #344 review fix (coordinator hardening): a commit that REJECTS (the store
  // threw — blocked/quota/private-mode IndexedDB — distinct from a resolved
  // `ok:false`) must behave like a failure, not vanish into an unhandled
  // rejection: without the rejection handler the command would stay in
  // `pendingCommands` forever and corrupt every future rebase.
  it('a REJECTED commit (storage threw) rolls back, toasts, and does not wedge the queue or the pending-command bookkeeping', async () => {
    const commit = vi.fn()
      .mockRejectedValueOnce(new Error('storage blocked'))
      .mockImplementation(async (candidate: StoredWorkspaceV2) => (
        { ok: true, workspace: candidate, dashboardRevision: candidate.dashboard ? candidate.dashboard.revision : null }
      ));
    const { app } = dashApp({ workspace: twoTiles(), commit });
    await render(app);
    pickLayout(app.root, 'columns-2'); // its commit REJECTS (never resolves ok:false)
    await flush();
    expect(commit).toHaveBeenCalledTimes(1);
    // Rolled back to the last committed truth, exactly like an ok:false.
    expect(layoutSelect(app.root).value).toBe('report');
    expect(app.state.dashboard?.revision).toBe(1);
    expect(document.querySelector('.share-toast')?.textContent).toBe('✕ Could not save dashboard');
    // The descriptor was dropped from `pendingCommands` — a later command
    // rebases from clean bookkeeping and commits successfully.
    pickLayout(app.root, 'columns-3');
    await flush();
    expect(commit).toHaveBeenCalledTimes(2);
    expect(app.state.dashboard?.layout.preset).toBe('columns-3');
    expect(app.state.dashboard?.revision).toBe(2);
  });
});

// ── #343 step 6: external-workspace rebuild ─────────────────────────────────
// When another tab commits to the shared workspace, the app-level cross-tab
// refresh projects it onto `app.state` and fires `app.onWorkspaceExternally
// Changed`. An editable Dashboard route reacts by REBUILDING its viewer session
// from committed truth — a full `renderDashboard` re-read (never just
// `session.syncDocument`), because a referenced query's SQL/Spec may have moved
// while the Dashboard document stayed byte-identical. The rebuild defers behind
// any pending local command, coalesces duplicate notifications, preserves the
// persisted per-Dashboard filter seed, and never commits. A live read-only
// view ignores primary-workspace invalidation entirely.
describe('renderDashboard — external-workspace rebuild (#343 step 6)', () => {
  const twoTiles = () => wsWith({
    queries: [q('q1', 'SELECT 1'), q('q2', 'SELECT 2')],
    tiles: [{ id: 't1', queryId: 'q1' }, { id: 't2', queryId: 'q2' }],
    layout: { type: 'flow', version: 1, preset: 'report', items: {} },
  });
  const tileNames = (app: TestApp): string[] =>
    qsa(app.root, '.dash-tile .dash-tile-name').map((n) => n.textContent || '');
  const loadCalls = (fn: unknown): number => (fn as ReturnType<typeof vi.fn>).mock.calls.length;

  it('an editable route rebuilds its viewer session when the Dashboard document changed externally', async () => {
    const { app, loadActive } = dashApp({ workspace: twoTiles() });
    await render(app);
    expect(tileNames(app)).toEqual(['q1', 'q2']);
    // Another tab commits a tile removal — this advances the shared store and
    // projects onto `app.state`, but does NOT rebuild this route's session.
    await app.mutateWorkspace((latest) => {
      const d = latest!.dashboard!;
      return { candidate: { ...latest!, dashboard: {
        ...d, revision: d.revision + 1, tiles: d.tiles.filter((t) => t.id !== 't2'),
      } } };
    });
    expect(tileNames(app)).toEqual(['q1', 'q2']); // session still shows both tiles
    // The app-level refresh fires the hook after projecting the external change.
    app.onWorkspaceExternallyChanged({ workspace: await loadActive(), queriesChanged: false });
    await flush(); await flush(); // the rebuild is itself an async render pass
    expect(tileNames(app)).toEqual(['q1']); // rebuilt from committed truth
  });

  it('rebuilds on an external QUERY-ONLY change even when the Dashboard document is byte-identical', async () => {
    const { app, calls, loadActive } = dashApp({ workspace: twoTiles() });
    await render(app);
    await flush();
    // A query-only external commit: q1's SQL changes; the dashboard document is
    // left byte-identical (same revision, tiles, layout). `session.syncDocument`
    // alone would never re-run the tile — only a full rebuild does.
    await app.mutateWorkspace((latest) => ({ candidate: {
      ...latest!,
      queries: latest!.queries.map((sq) => (sq.id === 'q1' ? { ...sq, sql: 'SELECT 999' } : sq)),
    } }));
    const before = calls.length;
    app.onWorkspaceExternallyChanged({ workspace: await loadActive(), queriesChanged: true });
    await flush(); await flush();
    expect(calls.slice(before).some((c) => c.sql.includes('999'))).toBe(true); // re-executed with new SQL
  });

  it('live view rebuilds from the same workspace after external invalidation', async () => {
    const workspace = wsWith({ id: 'd', queries: [q('q1', 'SELECT 1')], tiles: [{ id: 't1', queryId: 'q1' }] });
    const { app, calls } = modeApp({ workspace, mode: 'view' });
    await render(app);
    const changed = { ...workspace, queries: [q('q1', 'SELECT 99')] } as unknown as StoredWorkspaceV2;
    app.currentWorkspace = changed;
    const before = calls.length;
    app.onWorkspaceExternallyChanged({ workspace: changed as never, queriesChanged: true });
    await flush(); await flush();
    expect(calls.slice(before).some((call) => call.sql.includes('99'))).toBe(true);
  });

  it('a stale rebuild waits until pending Dashboard command descriptors settle', async () => {
    let resolveCommit!: () => void;
    const commit = vi.fn((candidate: StoredWorkspaceV2) => new Promise((resolve) => {
      resolveCommit = () => resolve({ ok: true, workspace: candidate, dashboardRevision: candidate.dashboard!.revision });
    }));
    const { app, calls, loadActive } = dashApp({ workspace: twoTiles(), commit: commit as unknown as Mock<App['workspace']['commit']> });
    await render(app);
    const before = calls.length;
    pickLayout(app.root, 'columns-2'); // dispatch a command whose commit stays pending
    for (let i = 0; i < 4; i++) await Promise.resolve(); // reach commit() — still unresolved
    // An external change arrives WHILE the command is pending: the rebuild must
    // defer (no resolution handler from this render may survive into the rebuilt one).
    app.onWorkspaceExternallyChanged({ workspace: await loadActive(), queriesChanged: false });
    await flush();
    expect(calls).toHaveLength(before); // deferred behind the pending command
    resolveCommit();
    await flush(); await flush();
    expect(calls.length).toBeGreaterThan(before); // rebuilt once the queue drained
  });

  it('coalesces duplicate external notifications into a single rebuild', async () => {
    const { app, calls, loadActive } = dashApp({ workspace: twoTiles() });
    await render(app);
    const before = calls.length;
    const info = { workspace: await loadActive(), queriesChanged: false };
    app.onWorkspaceExternallyChanged(info);
    app.onWorkspaceExternallyChanged(info);
    app.onWorkspaceExternallyChanged(info);
    await flush(); await flush();
    expect(calls.length - before).toBe(2); // two tiles, one rebuild, not three
  });

  it('preserves the persisted per-Dashboard filter seed (KEYS.dashFilters) across the rebuild', async () => {
    const ws = wsWith({
      id: 'dfx', queries: [q('q1', 'SELECT k, v FROM a WHERE n = {n:UInt8}')],
      tiles: [{ id: 't1', queryId: 'q1' }],
      filters: [{ id: 'n', parameter: 'n', defaultValue: 5, defaultActive: true }],
    });
    // `dashboard.ts` reads the persisted filter bag through `core/storage`'s
    // `loadJSON` on EVERY render (initial + rebuild); seed just that key (the
    // test env's localStorage is a read-only proxy, so mock the reader itself).
    const realLoadJSON = storage.loadJSON;
    const spy = vi.spyOn(storage, 'loadJSON').mockImplementation((key, fallback, store) => (
      key === KEYS.dashFilters ? { dfx: { n: { value: '77', active: true } } } : realLoadJSON(key, fallback, store)
    ));
    try {
      const { app, loadActive } = dashApp({ workspace: ws });
      await render(app);
      const filterInput = (): HTMLInputElement => {
        const field = qsa(app.root, '.dash-filter-host .var-field').find((f) => qs(f, '.var-name')?.textContent === 'n')!;
        return qs<HTMLInputElement>(field, 'input');
      };
      expect(filterInput().value).toBe('77'); // seeded from the store, not the default 5
      app.onWorkspaceExternallyChanged({ workspace: await loadActive(), queriesChanged: false });
      await flush(); await flush();
      expect(filterInput().value).toBe('77'); // still seeded after the rebuild re-reads the store
    } finally {
      spy.mockRestore();
    }
  });

  it('regression: an optimistic drag still applies immediately (no rebuild on the drag path)', async () => {
    const { app, commit } = dashApp({ workspace: twoTiles() });
    await render(app);
    const cards = qsa(app.root, '.dash-tile');
    stubTileRects(cards);
    const down = pointerDragTo(cards, 1, tileCenter(0), { metaKey: true });
    expect(down.defaultPrevented).toBe(true);
    expect(tileNames(app)).toEqual(['q2', 'q1']); // reorder visible synchronously, before any commit
    await flush();
    expect(commit).toHaveBeenCalled();
  });
});
