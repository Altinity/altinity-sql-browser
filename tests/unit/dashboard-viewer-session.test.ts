import { describe, expect, it, vi } from 'vitest';
import {
  createDashboardViewerSession, VIEWER_TILE_CONCURRENCY,
} from '../../src/dashboard/application/dashboard-viewer-session.js';
import type {
  DashboardViewerDeps, ViewerExecutor, ViewerReadRequest,
} from '../../src/dashboard/application/dashboard-viewer-session.js';
import type {
  DashboardDocumentV1, DashboardFilterDefinitionV1, DashboardTileV1, SavedQueryV2,
} from '../../src/generated/json-schema.types.js';

// ── Fixtures ────────────────────────────────────────────────────────────────

interface Resp {
  columns?: { name: string; type?: string }[];
  rows?: unknown[][];
  error?: string | null;
  cancelled?: boolean;
  bytes?: number;
  progressRows?: number;
}
type Responder = (sql: string, req: ViewerReadRequest) => Resp | Promise<Resp>;

function makeExec(responder: Responder = () => ({})) {
  const calls: { sql: string; params: Record<string, unknown>; format?: string }[] = [];
  const exec: ViewerExecutor = {
    async executeRead(result, req) {
      calls.push({ sql: req.sql, params: req.params ?? {}, format: req.format });
      const resp = (await responder(req.sql, req)) || {};
      if (req.onChunk) { result.progress.rows = resp.progressRows ?? 1; req.onChunk(); }
      result.columns = (resp.columns ?? [{ name: 'n' }]) as never;
      result.rows = resp.rows ?? [[1]];
      result.progress.bytes = resp.bytes ?? 10;
      result.error = resp.error ?? null;
      result.cancelled = resp.cancelled ?? false;
    },
  };
  return { exec, calls };
}

const query = (id: string, sql: string, spec: Record<string, unknown> = {}): SavedQueryV2 =>
  ({ id, sql, specVersion: 1, spec: { name: id, ...spec } } as SavedQueryV2);

const tile = (id: string, queryId: string, over: Partial<DashboardTileV1> = {}): DashboardTileV1 =>
  ({ id, queryId, ...over });

const doc = (over: Partial<DashboardDocumentV1> = {}): DashboardDocumentV1 => ({
  documentVersion: 1, id: 'd', title: 'D', revision: 1,
  layout: { type: 'flow', version: 1, preset: 'columns-2', items: {} },
  filters: [], tiles: [], ...over,
});

function makeDeps(over: Partial<DashboardViewerDeps> & Pick<DashboardViewerDeps, 'document'>): DashboardViewerDeps {
  let clock = 1000;
  return {
    queries: [],
    exec: makeExec().exec,
    connection: { ensureFreshToken: async () => true },
    now: () => (clock += 5),
    wallNow: () => 2000,
    ...over,
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

// ── Tests ─────────────────────────────────────────────────────────────────

describe('createDashboardViewerSession', () => {
  it('runs a dashboard document end-to-end with no Workbench construction', async () => {
    const { exec, calls } = makeExec((sql) => ({ columns: [{ name: 'n' }], rows: [[sql.length]] }));
    const document = doc({
      tiles: [tile('t1', 'q1'), tile('t2', 'q2')],
      layout: { type: 'flow', version: 1, preset: 'columns-2', items: { t1: { span: 2 } } },
    });
    const session = createDashboardViewerSession(makeDeps({
      document, queries: [query('q1', 'SELECT 1'), query('q2', 'SELECT 2')],
      exec, recordBoundParams: vi.fn(),
    }));
    await session.start();
    const state = session.state.value;
    expect(calls.length).toBe(2);
    expect(state.tiles.map((t) => t.status)).toEqual(['ready', 'ready']);
    expect(state.tiles[0].columns).toEqual([{ name: 'n' }]);
    expect(state.tiles[0].meta?.rows).toBe(1);
    expect(state.running).toBe(false);
    expect(state.updatedAt).not.toBeNull();
    // Flow model reflects the columns-2 preset and the stored span-2 placement.
    expect(state.layout.engine).toBe('flow');
    if (state.layout.engine !== 'flow') throw new Error('expected flow engine');
    expect(state.layout.columns).toBe(2);
    expect(state.layout.rows[0].tiles[0].span).toBe(2);
    expect(VIEWER_TILE_CONCURRENCY).toBe(6);
  });

  it('marks a tile whose query is missing as an error and reports a presentation diagnostic', async () => {
    const document = doc({ tiles: [tile('t1', 'ghost')] });
    const session = createDashboardViewerSession(makeDeps({ document, queries: [] }));
    await session.start();
    const state = session.state.value;
    expect(state.tiles[0].status).toBe('error');
    expect(state.tiles[0].error).toContain('ghost');
  });

  it('marks a tile with an invalid selected variant as an error', async () => {
    const document = doc({ tiles: [tile('t1', 'q1', { presentation: { variant: 'nope' } })] });
    const session = createDashboardViewerSession(makeDeps({
      document, queries: [query('q1', 'SELECT 1', { panel: { cfg: { type: 'kpi' } } })],
    }));
    await session.start();
    expect(session.state.value.tiles[0].status).toBe('error');
  });

  it('renders a text panel tile with no query execution', async () => {
    const { exec, calls } = makeExec();
    const document = doc({ tiles: [tile('t1', 'q1')] });
    const session = createDashboardViewerSession(makeDeps({
      document, exec, queries: [query('q1', 'SELECT 1', { panel: { cfg: { type: 'text', content: 'hi' } } })],
    }));
    await session.start();
    expect(calls.length).toBe(0);
    expect(session.state.value.tiles[0].status).toBe('ready');
    expect(session.state.value.tiles[0].isKpi).toBe(false);
  });

  it('shows an unfilled tile when a required param has no value, issuing no request', async () => {
    const { exec, calls } = makeExec();
    const document = doc({ tiles: [tile('t1', 'q1')] });
    const session = createDashboardViewerSession(makeDeps({
      document, exec, queries: [query('q1', 'SELECT {year:UInt16}')],
    }));
    await session.start();
    expect(calls.length).toBe(0);
    expect(session.state.value.tiles[0].status).toBe('unfilled');
    expect(session.state.value.tiles[0].unfilled).toEqual(['year']);
  });

  it('reports a per-source template error without issuing a request', async () => {
    const { exec, calls } = makeExec();
    const document = doc({ tiles: [tile('t1', 'q1')] });
    const session = createDashboardViewerSession(makeDeps({
      document, exec, queries: [query('q1', 'SELECT 1 /*[ AND 1 = 1 ]*/')],
    }));
    await session.start();
    expect(calls.length).toBe(0);
    expect(session.state.value.tiles[0].status).toBe('error');
    expect(session.state.value.tiles[0].error).toContain('parameter');
  });

  it('rejects an explicit FORMAT clause on an ordinary tile', async () => {
    const { exec, calls } = makeExec();
    const document = doc({ tiles: [tile('t1', 'q1')] });
    const session = createDashboardViewerSession(makeDeps({
      document, exec, queries: [query('q1', 'SELECT 1 FORMAT JSON')],
    }));
    await session.start();
    expect(calls.length).toBe(0);
    expect(session.state.value.tiles[0].error).toContain('FORMAT');
  });

  it('runs a KPI panel through the owned KPI transport and rejects a KPI FORMAT clause', async () => {
    const { exec, calls } = makeExec(() => ({ columns: [{ name: 'n' }], rows: [[7]] }));
    const kpiDoc = doc({ tiles: [tile('t1', 'q1')] });
    const session = createDashboardViewerSession(makeDeps({
      document: kpiDoc, exec, queries: [query('q1', 'SELECT 7 AS n', { panel: { cfg: { type: 'kpi' } } })],
    }));
    await session.start();
    expect(calls[0].format).toBe('KPI');
    expect(session.state.value.tiles[0].isKpi).toBe(true);

    const { exec: exec2, calls: calls2 } = makeExec();
    const badKpi = doc({ tiles: [tile('t1', 'q1')] });
    const s2 = createDashboardViewerSession(makeDeps({
      document: badKpi, exec: exec2, queries: [query('q1', 'SELECT 7 FORMAT JSON', { panel: { cfg: { type: 'kpi' } } })],
    }));
    await s2.start();
    expect(calls2.length).toBe(0);
    expect(s2.state.value.tiles[0].error).toContain('KPI');
  });

  it('runs an optional-block tile and surfaces a query error / progress', async () => {
    const seenProgress: number[] = [];
    const { exec } = makeExec((sql) => (sql.includes('boom')
      ? { error: 'ch failed' }
      : { columns: [{ name: 'n' }], rows: [[1]], progressRows: 42 }));
    const document = doc({ tiles: [tile('ok', 'q1'), tile('bad', 'q2')] });
    const session = createDashboardViewerSession(makeDeps({
      document, exec,
      queries: [query('q1', 'SELECT 1 /*[ AND {x:String} = 1 ]*/'), query('q2', 'SELECT boom')],
    }));
    session.state.subscribe((s) => { const rows = s.tiles[0].progressRows; if (rows) seenProgress.push(rows); });
    await session.start();
    expect(session.state.value.tiles[0].status).toBe('ready');
    expect(session.state.value.tiles[1].status).toBe('error');
    expect(session.state.value.tiles[1].error).toBe('ch failed');
    expect(seenProgress).toContain(42);
  });

  it('halts before any work when the token preflight fails', async () => {
    const { exec, calls } = makeExec();
    const onAuthFailed = vi.fn();
    const document = doc({ tiles: [tile('t1', 'q1')] });
    const session = createDashboardViewerSession(makeDeps({
      document, exec, queries: [query('q1', 'SELECT 1')], onAuthFailed,
      connection: { ensureFreshToken: async () => false },
    }));
    await session.start();
    expect(calls.length).toBe(0);
    expect(onAuthFailed).toHaveBeenCalledOnce();
  });
});

// #303: `initialFilters` seeds each filter's runtime value/active from a
// persisted bag (the shell's isolated per-dashboard store) instead of always
// deriving it from `def.defaultValue`/`defaultActive`. These assert on the
// session's initial `state.value.filters` BEFORE `start()` — the seed is
// applied at construction time, no query execution required.
describe('initialFilters seeding (#303)', () => {
  const seededDoc = () => doc({
    filters: [
      { id: 'f1', parameter: 'p1', defaultValue: 'D1', defaultActive: false },
      { id: 'f2', parameter: 'p2', defaultValue: 'D2', defaultActive: true },
    ],
  });
  const byId = (session: ReturnType<typeof createDashboardViewerSession>, id: string) =>
    session.state.value.filters.find((f) => f.id === id)!;

  it('starts a seeded filter with its persisted value+active, overriding the definition defaults', () => {
    const session = createDashboardViewerSession(makeDeps({
      document: seededDoc(), initialFilters: { f1: { value: 'seeded', active: true } },
    }));
    expect(byId(session, 'f1')).toMatchObject({ value: 'seeded', active: true });
  });

  it('leaves an unseeded filter (absent from the map) on its definition defaults', () => {
    const session = createDashboardViewerSession(makeDeps({
      document: seededDoc(), initialFilters: { f1: { value: 'seeded', active: true } },
    }));
    expect(byId(session, 'f2')).toMatchObject({ value: 'D2', active: true });
  });

  it('behaves identically when initialFilters is absent', () => {
    const session = createDashboardViewerSession(makeDeps({ document: seededDoc() }));
    expect(byId(session, 'f1')).toMatchObject({ value: 'D1', active: false });
    expect(byId(session, 'f2')).toMatchObject({ value: 'D2', active: true });
  });

  it('behaves identically when initialFilters is an empty map', () => {
    const session = createDashboardViewerSession(makeDeps({ document: seededDoc(), initialFilters: {} }));
    expect(byId(session, 'f1')).toMatchObject({ value: 'D1', active: false });
    expect(byId(session, 'f2')).toMatchObject({ value: 'D2', active: true });
  });

  it('falls back to the definition defaultValue when a seed entry has a nullish value', () => {
    const session = createDashboardViewerSession(makeDeps({
      document: seededDoc(), initialFilters: { f1: { value: null, active: true } },
    }));
    expect(byId(session, 'f1')).toMatchObject({ value: 'D1', active: true });
  });

  it('coerces a seeded falsy active flag to false rather than falling back to the default', () => {
    const session = createDashboardViewerSession(makeDeps({
      // f2's OWN default is active:true — the seed's explicit false must win.
      document: seededDoc(), initialFilters: { f2: { value: 'D2', active: false } },
    }));
    expect(byId(session, 'f2')).toMatchObject({ value: 'D2', active: false });
  });
});

describe('filters and the #235 execution planner', () => {
  // A dashboard with a source-backed filter targeting one tile via parameter
  // declaration, plus an unrelated tile the filter can never affect.
  const filterDef = (over: Partial<DashboardFilterDefinitionV1> = {}): DashboardFilterDefinitionV1 =>
    ({ id: 'f1', parameter: 'p', sourceQueryId: 'src', defaultActive: true, defaultValue: 'V', ...over });

  const twoTileDoc = (filters: DashboardFilterDefinitionV1[]) => doc({
    tiles: [tile('affected', 'qa'), tile('unaffected', 'qu')], filters,
  });
  const queries = () => [
    query('qa', 'SELECT {p:String} AS n'),
    query('qu', 'SELECT 1 AS n'),
    query('src', "SELECT 'V' AS p /* source */", { dashboard: { role: 'filter' } }),
  ];

  it('starts the unaffected panel before the filter wave completes; the affected panel sees first-pass values', async () => {
    let releaseFilter!: () => void;
    const filterGate = new Promise<void>((resolve) => { releaseFilter = resolve; });
    const { exec, calls } = makeExec((sql) => (sql.includes('source')
      ? filterGate.then(() => ({ columns: [{ name: 'p', type: 'Array(String)' }], rows: [[['V']]] }))
      : { columns: [{ name: 'n' }], rows: [[1]] }));
    const session = createDashboardViewerSession(makeDeps({
      document: twoTileDoc([filterDef()]), exec, queries: queries(),
    }));
    const done = session.start();
    await flush();
    const sqls = () => calls.map((c) => c.sql);
    // #235: the unaffected tile ran while the filter wave is still pending.
    expect(sqls().some((s) => s === 'SELECT 1 AS n')).toBe(true);
    expect(sqls().some((s) => s.includes('{p:String}') || s.includes('SELECT '))).toBe(true);
    expect(calls.some((c) => c.sql.includes('AS n') && 'param_p' in c.params)).toBe(false);
    releaseFilter();
    await done;
    // The affected tile ran after the filter wave with the active value bound.
    const affectedCall = calls.find((c) => 'param_p' in c.params);
    expect(affectedCall?.params.param_p).toBe('V');
    expect(session.state.value.filters[0].options).toEqual([{ value: 'V', label: 'V' }]);
    expect(session.state.value.activeFilterCount).toBe(1);
  });

  it('honours a filter definition with explicit targets', async () => {
    const { exec, calls } = makeExec((sql) => (sql.includes('source')
      ? { columns: [{ name: 'p', type: 'Array(String)' }], rows: [[['V']]] }
      : { columns: [{ name: 'n' }], rows: [[1]] }));
    const session = createDashboardViewerSession(makeDeps({
      document: twoTileDoc([filterDef({ targets: ['affected'] })]), exec, queries: queries(),
    }));
    await session.start();
    // The explicitly-targeted tile ran with the active value bound.
    expect(calls.some((c) => c.params.param_p === 'V')).toBe(true);
    expect(session.state.value.filters[0].options).toEqual([{ value: 'V', label: 'V' }]);
  });

  it('marks a filter whose source SQL is invalid as an error', async () => {
    const { exec } = makeExec(() => ({ columns: [{ name: 'n' }], rows: [[1]] }));
    const session = createDashboardViewerSession(makeDeps({
      document: doc({
        tiles: [tile('t', 'qt')],
        filters: [{ id: 'f1', parameter: 'p', sourceQueryId: 'src', defaultActive: true, defaultValue: 'V' }],
      }),
      exec,
      queries: [query('qt', 'SELECT {p:String} AS n'), query('src', '', { dashboard: { role: 'filter' } })],
    }));
    await session.start();
    expect(session.state.value.filters[0].status).toBe('error');
  });

  it('marks a filter whose source query returns a runtime error as an error', async () => {
    const { exec } = makeExec((sql) => (sql.includes('badsrc') ? { error: 'src down' } : { columns: [{ name: 'n' }], rows: [[1]] }));
    const session = createDashboardViewerSession(makeDeps({
      document: doc({
        tiles: [tile('t', 'qt')],
        filters: [{ id: 'f1', parameter: 'p', sourceQueryId: 'srcq' }],
      }),
      exec,
      queries: [
        query('qt', 'SELECT {p:String} AS n'),
        query('srcq', 'SELECT 1 AS p /* badsrc */', { dashboard: { role: 'filter' } }),
      ],
    }));
    await session.start();
    expect(session.state.value.filters[0].status).toBe('error');
  });

  it('blanks a curated-but-inactive parameter on the next wave', async () => {
    const { exec, calls } = makeExec((sql) => (sql.includes('source')
      ? { columns: [{ name: 'p', type: 'Array(String)' }], rows: [[['V', 'W']]] }
      : { columns: [{ name: 'n' }], rows: [[1]] }));
    const session = createDashboardViewerSession(makeDeps({
      document: twoTileDoc([filterDef()]), exec, queries: queries(),
    }));
    await session.start();
    expect(session.state.value.filters[0].options?.length).toBe(2);
    const base = calls.length;
    // Deactivating a curated filter blanks its value in the next prepared wave.
    await session.clearFilter('f1');
    const affectedCall = calls.slice(base).find((c) => 'param_p' in c.params);
    expect(affectedCall).toBeUndefined(); // blank → the affected tile goes unfilled, not bound
  });

  it('setFilter runs only the affected panel wave', async () => {
    const { exec, calls } = makeExec(() => ({ columns: [{ name: 'n' }], rows: [[1]] }));
    const session = createDashboardViewerSession(makeDeps({
      document: twoTileDoc([]), exec, queries: queries(),
    }));
    await session.start();
    const before = calls.length;
    await session.setFilter('missing', 'x'); // unknown filter: no-op
    expect(calls.length).toBe(before);
    // The document has no filter definition for p; create one so setFilter maps.
    const withFilter = createDashboardViewerSession(makeDeps({
      document: twoTileDoc([filterDef({ sourceQueryId: undefined })]), exec, queries: queries(),
    }));
    await withFilter.start();
    const base = calls.length;
    await withFilter.setFilter('f1', 'W');
    // Only the affected tile (declares {p}) re-ran.
    const added = calls.slice(base);
    expect(added.length).toBe(1);
    expect(added[0].params.param_p).toBe('W');
  });

  it('clearFilter deactivates without discarding the value; reactivation restores it', async () => {
    const { exec } = makeExec(() => ({ columns: [{ name: 'n' }], rows: [[1]] }));
    const session = createDashboardViewerSession(makeDeps({
      document: twoTileDoc([filterDef({ sourceQueryId: undefined })]), exec, queries: queries(),
    }));
    await session.start();
    expect(session.state.value.filters[0].active).toBe(true);
    await session.clearFilter('f1');
    expect(session.state.value.filters[0].active).toBe(false);
    expect(session.state.value.filters[0].value).toBe('V'); // value retained
    expect(session.state.value.activeFilterCount).toBe(0);
    await session.setFilter('f1', session.state.value.filters[0].value); // reactivate
    expect(session.state.value.filters[0].active).toBe(true);
    await session.clearFilter('nope'); // unknown: no-op
  });

  it('clearAllFilters coalesces every reset into one affected-panel wave', async () => {
    const { exec, calls } = makeExec(() => ({ columns: [{ name: 'n' }], rows: [[1]] }));
    const session = createDashboardViewerSession(makeDeps({
      document: doc({
        tiles: [tile('a', 'qa'), tile('b', 'qb')],
        filters: [
          { id: 'f1', parameter: 'p', defaultActive: true, defaultValue: 'V' },
          { id: 'f2', parameter: 'q', defaultActive: true, defaultValue: 'W' },
        ],
      }),
      exec,
      queries: [query('qa', 'SELECT {p:String} AS n'), query('qb', 'SELECT {q:String} AS n')],
    }));
    await session.start();
    // Move both filters off their defaults.
    await session.setFilter('f1', 'X');
    await session.setFilter('f2', 'Y');
    const base = calls.length;
    await session.clearAllFilters();
    const added = calls.slice(base);
    // One coalesced wave re-ran both affected tiles (2 tiles, not 2 waves × ...).
    expect(added.length).toBe(2);
    expect(session.state.value.filters.every((f) => f.active)).toBe(true);
    // A second clear-all with nothing changed issues no wave.
    const base2 = calls.length;
    await session.clearAllFilters();
    expect(calls.length).toBe(base2);
  });

});

describe('filter-bar bridge (controls / getFilterField / applyFilter)', () => {
  it('exposes controls + a draft-aware field state, and applyFilter sets value AND active explicitly', async () => {
    const { exec, calls } = makeExec(() => ({ columns: [{ name: 'n' }], rows: [[1]] }));
    const session = createDashboardViewerSession(makeDeps({
      document: doc({ tiles: [tile('t', 'q')], filters: [{ id: 'f', parameter: 'p', defaultActive: false, defaultValue: '' }] }),
      exec, queries: [query('q', 'SELECT {p:String} AS n')],
    }));
    await session.start();
    expect(session.controls.map((c) => c.name)).toContain('p');
    // Draft-aware #170 validation: empty required → not ok; a value → ok.
    expect(session.getFilterField('p', 'execute', { p: '' }, { p: false }).state).not.toBe('ok');
    expect(session.getFilterField('p', 'execute', { p: 'x' }, { p: true }).state).toBe('ok');
    // applyFilter(value, active=true) → the affected tile re-runs with the value bound.
    const before = calls.length;
    await session.applyFilter('f', 'x', true);
    expect(calls.slice(before).find((c) => 'param_p' in c.params)?.params.param_p).toBe('x');
    expect(session.state.value.filters[0]).toMatchObject({ value: 'x', active: true });
    // applyFilter(value, active=false) keeps the value but deactivates it.
    await session.applyFilter('f', 'x', false);
    expect(session.state.value.filters[0]).toMatchObject({ value: 'x', active: false });
    // Unknown filter id and post-destroy are no-ops.
    await session.applyFilter('nope', 'y', true);
    session.destroy();
    await session.applyFilter('f', 'z', true);
    expect(session.state.value.filters[0].value).toBe('x');
  });
});

describe('per-tile control and lifecycle', () => {
  it('refreshTile re-runs one tile; refreshTile is a no-op for text/missing/invalid tiles', async () => {
    const { exec, calls } = makeExec(() => ({ columns: [{ name: 'n' }], rows: [[1]] }));
    const document = doc({ tiles: [tile('t1', 'q1'), tile('txt', 'q2'), tile('ghost', 'gone')] });
    const session = createDashboardViewerSession(makeDeps({
      document, exec,
      queries: [query('q1', 'SELECT 1'), query('q2', 'SELECT 1', { panel: { cfg: { type: 'text', content: 'x' } } })],
    }));
    await session.start();
    const base = calls.length;
    await session.refreshTile('t1');
    expect(calls.length).toBe(base + 1);
    await session.refreshTile('txt'); // text: no-op
    await session.refreshTile('ghost'); // missing query: no-op
    await session.refreshTile('absent'); // unknown tile: no-op
    expect(calls.length).toBe(base + 1);
  });

  it('cancelTile aborts an in-flight request and resets the tile to idle', async () => {
    let releaseTile!: () => void;
    const gate = new Promise<void>((resolve) => { releaseTile = resolve; });
    const { exec } = makeExec(() => gate.then(() => ({ columns: [{ name: 'n' }], rows: [[1]] })));
    const document = doc({ tiles: [tile('t1', 'q1')] });
    const session = createDashboardViewerSession(makeDeps({ document, exec, queries: [query('q1', 'SELECT 1')] }));
    const done = session.start();
    await flush();
    expect(session.state.value.tiles[0].status).toBe('loading');
    session.cancelTile('t1');
    session.cancelTile('absent'); // unknown: no-op
    expect(session.state.value.tiles[0].status).toBe('idle');
    releaseTile();
    await done;
    // The superseded run never overwrote the cancelled state.
    expect(session.state.value.tiles[0].status).toBe('idle');
  });

  it('a superseded mid-stream run (stale generation) discards its result', async () => {
    let releaseTile!: () => void;
    const gate = new Promise<void>((resolve) => { releaseTile = resolve; });
    let call = 0;
    const { exec } = makeExec(() => {
      call += 1;
      return call === 1 ? gate.then(() => ({ columns: [{ name: 'stale' }], rows: [[9]] })) : { columns: [{ name: 'fresh' }], rows: [[1]] };
    });
    const document = doc({ tiles: [tile('t1', 'q1')] });
    const session = createDashboardViewerSession(makeDeps({ document, exec, queries: [query('q1', 'SELECT 1')] }));
    const first = session.start();
    await flush();
    const second = session.refreshTile('t1'); // supersedes the pending first run
    releaseTile();
    await Promise.all([first, second]);
    expect(session.state.value.tiles[0].columns).toEqual([{ name: 'fresh' }]);
  });

  it('destroy cancels in-flight work and turns later entry points into no-ops', async () => {
    let releaseFilter!: () => void;
    const filterGate = new Promise<void>((resolve) => { releaseFilter = resolve; });
    const { exec, calls } = makeExec((sql) => (sql.includes('source')
      ? filterGate.then(() => ({ columns: [{ name: 'p' }], rows: [['V']] }))
      : { columns: [{ name: 'n' }], rows: [[1]] }));
    const document = doc({
      tiles: [tile('affected', 'qa'), tile('unaffected', 'qu')],
      filters: [{ id: 'f1', parameter: 'p', sourceQueryId: 'src', defaultActive: true, defaultValue: 'V' }],
    });
    const session = createDashboardViewerSession(makeDeps({
      document, exec,
      queries: [
        query('qa', 'SELECT {p:String} AS n'), query('qu', 'SELECT 1 AS n'),
        query('src', "SELECT 'V' AS p /* source */", { dashboard: { role: 'filter' } }),
      ],
    }));
    const done = session.start();
    await flush();
    session.destroy();
    releaseFilter();
    await done;
    const after = calls.length;
    await session.refresh();
    await session.refreshTile('affected');
    await session.setFilter('f1', 'Z');
    await session.clearFilter('f1');
    await session.clearAllFilters();
    expect(calls.length).toBe(after); // nothing ran post-destroy
    expect(session.state.value.updatedAt).toBeNull();
  });

  it('syncDocument reorders/resizes in place without re-running tiles', async () => {
    const { exec, calls } = makeExec(() => ({ columns: [{ name: 'n' }], rows: [[1]] }));
    const document = doc({
      tiles: [tile('a', 'qa'), tile('b', 'qb')],
      layout: { type: 'flow', version: 1, preset: 'columns-2', items: {} },
    });
    const session = createDashboardViewerSession(makeDeps({
      document, exec, queries: [query('qa', 'SELECT 1'), query('qb', 'SELECT 2')],
    }));
    await session.start();
    const base = calls.length;
    expect(session.state.value.tiles.map((t) => t.tileId)).toEqual(['a', 'b']);
    // Reorder to [b, a] and give b a span of 2 — no re-execution.
    session.syncDocument({
      ...document,
      tiles: [tile('b', 'qb'), tile('a', 'qa')],
      layout: { type: 'flow', version: 1, preset: 'columns-2', items: { b: { span: 2 } } },
    });
    expect(calls.length).toBe(base);
    expect(session.state.value.tiles.map((t) => t.tileId)).toEqual(['b', 'a']);
    expect(session.state.value.tiles[0].status).toBe('ready'); // result preserved
    const syncedLayout = session.state.value.layout;
    if (syncedLayout.engine !== 'flow') throw new Error('expected flow engine');
    expect(syncedLayout.rows[0].tiles[0]).toMatchObject({ tileId: 'b', span: 2 });
    // An unknown tile id in the next document is dropped defensively.
    session.syncDocument({ ...document, tiles: [tile('a', 'qa'), tile('ghostly', 'x')] });
    expect(session.state.value.tiles.map((t) => t.tileId)).toEqual(['a']);
    session.destroy();
    session.syncDocument(document); // no-op after destroy
    expect(session.state.value.tiles.map((t) => t.tileId)).toEqual(['a']);
  });

  it('tags the flow layout view with engine:\'flow\' — bit-identical otherwise', async () => {
    const { exec } = makeExec(() => ({ columns: [{ name: 'n' }], rows: [[1]] }));
    const document = doc({
      tiles: [tile('a', 'qa')],
      layout: { type: 'flow', version: 1, preset: 'columns-3', items: { a: { span: 3 } } },
    });
    const session = createDashboardViewerSession(makeDeps({ document, exec, queries: [query('qa', 'SELECT 1')] }));
    await session.start();
    const layout = session.state.value.layout;
    expect(layout.engine).toBe('flow');
    if (layout.engine === 'flow') {
      expect(layout.preset).toBe('columns-3');
      expect(layout.columns).toBe(3);
      expect(layout.rows[0].tiles[0].span).toBe(3);
    }
  });
});

// #291: engine routing (grafana-grid@1) — buildState resolves the active
// engine synchronously (resolveLayoutPluginSync) rather than always calling
// computeFlowLayout; a grid document nests its own render model under
// `layout.grid`, discriminated by `layout.engine`.
describe('grafana-grid engine routing (#291)', () => {
  const gridDoc = (over: Partial<DashboardDocumentV1> = {}) => doc({
    tiles: [tile('a', 'qa'), tile('b', 'qb')],
    layout: { type: 'grafana-grid', version: 1, items: { a: { span: 4, height: 'compact' } } },
    ...over,
  });

  it('tags the layout view with engine:\'grafana-grid\' and nests the grid render model', async () => {
    const { exec } = makeExec(() => ({ columns: [{ name: 'n' }], rows: [[1]] }));
    const session = createDashboardViewerSession(makeDeps({
      document: gridDoc(), exec, queries: [query('qa', 'SELECT 1'), query('qb', 'SELECT 2')],
    }));
    await session.start();
    const layout = session.state.value.layout;
    expect(layout.engine).toBe('grafana-grid');
    if (layout.engine === 'grafana-grid') {
      expect(layout.grid.engine).toBe('grafana-grid');
      expect(layout.grid.tiles.map((t) => t.tileId)).toEqual(['a', 'b']);
      expect(layout.grid.tiles[0]).toMatchObject({ tileId: 'a', span: 4, height: 'compact' });
      // No persisted placement for 'b' → the grid default (span 6, medium).
      expect(layout.grid.tiles[1]).toMatchObject({ tileId: 'b', span: 6, height: 'medium' });
    }
  });

  it('clamps effective columns from the injected containerWidth seam', async () => {
    const { exec } = makeExec(() => ({ columns: [{ name: 'n' }], rows: [[1]] }));
    const session = createDashboardViewerSession(makeDeps({
      document: gridDoc(), exec, queries: [query('qa', 'SELECT 1'), query('qb', 'SELECT 2')],
      containerWidth: () => 600, // >=470, <720 → 4 effective columns
    }));
    await session.start();
    const layout = session.state.value.layout;
    if (layout.engine === 'grafana-grid') expect(layout.grid.columns).toBe(4);
    else throw new Error('expected grafana-grid engine');
  });

  it('defaults to the widest breakpoint (12 columns) when containerWidth is absent', async () => {
    const { exec } = makeExec(() => ({ columns: [{ name: 'n' }], rows: [[1]] }));
    const session = createDashboardViewerSession(makeDeps({
      document: gridDoc(), exec, queries: [query('qa', 'SELECT 1'), query('qb', 'SELECT 2')],
    }));
    await session.start();
    const layout = session.state.value.layout;
    if (layout.engine === 'grafana-grid') expect(layout.grid.columns).toBe(12);
    else throw new Error('expected grafana-grid engine');
  });

  it('places a KPI grid tile inline (no banding) and still runs its query', async () => {
    const { exec, calls } = makeExec(() => ({ columns: [{ name: 'value' }], rows: [[7]] }));
    const document = gridDoc({
      tiles: [tile('k1', 'qk')],
      layout: { type: 'grafana-grid', version: 1, items: { k1: { span: 4 } } },
    });
    const session = createDashboardViewerSession(makeDeps({
      document, exec, queries: [query('qk', 'SELECT 7 AS value', { panel: { cfg: { type: 'kpi' } } })],
    }));
    await session.start();
    expect(calls.length).toBe(1);
    const layout = session.state.value.layout;
    if (layout.engine === 'grafana-grid') {
      expect(layout.grid.tiles[0]).toMatchObject({ tileId: 'k1', isKpi: true, span: 4 });
    } else throw new Error('expected grafana-grid engine');
    expect(session.state.value.tiles[0].status).toBe('ready');
  });

  it('falls back to the flow engine for an unsupported grid version with no valid fallback (existing dashboard-layout-load-failed shape unaffected)', async () => {
    const { exec } = makeExec(() => ({ columns: [{ name: 'n' }], rows: [[1]] }));
    const document = doc({
      tiles: [tile('a', 'qa')],
      layout: { type: 'grafana-grid', version: 2, items: {} } as unknown as DashboardDocumentV1['layout'],
    });
    const session = createDashboardViewerSession(makeDeps({ document, exec, queries: [query('qa', 'SELECT 1')] }));
    await session.start();
    // An unsupported grid version with no flow@1 fallback resolves to the
    // flow plugin (resolveLayoutPluginSync's own documented fallback), which
    // renders every tile at the flow default (no persisted flow surface).
    expect(session.state.value.layout.engine).toBe('flow');
  });
});

describe('flow layout (mobile normalization)', () => {
  it('normalizes the flow layout on mobile and coerces filter values to strings', async () => {
    const { exec } = makeExec(() => ({ columns: [{ name: 'n' }], rows: [[1]] }));
    let mobile = true;
    const session = createDashboardViewerSession(makeDeps({
      document: doc({
        tiles: [tile('a', 'qa')],
        layout: { type: 'flow', version: 1, preset: 'columns-3', items: { a: { span: 3 } } },
        filters: [{ id: 'f1', parameter: 'p', defaultValue: 5 }],
      }),
      exec, queries: [query('qa', 'SELECT {p:String} AS n')], isMobile: () => mobile,
    }));
    await session.start();
    const mobileLayout = session.state.value.layout;
    if (mobileLayout.engine !== 'flow') throw new Error('expected flow engine');
    expect(mobileLayout.columns).toBe(1);
    expect(mobileLayout.rows[0].tiles[0].span).toBe(1);
    // A numeric default coerces to a string; setting null clears it.
    await session.setFilter('f1', 5);
    expect(session.state.value.filters[0].active).toBe(true);
    await session.setFilter('f1', null);
    expect(session.state.value.filters[0].active).toBe(false);
    mobile = false;
  });
});
