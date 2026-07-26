import { describe, expect, it, vi } from 'vitest';
import {
  createDashboardViewerSession, VIEWER_TILE_CONCURRENCY,
} from '../../src/dashboard/application/dashboard-viewer-session.js';
import type {
  DashboardLayoutView, DashboardViewerDeps, ViewerExecutor, ViewerReadRequest,
} from '../../src/dashboard/application/dashboard-viewer-session.js';
import type {
  DashboardDocumentV2, DashboardTileV1, SavedQueryV2,
} from '../../src/generated/json-schema.types.js';
import { VARIABLE_OPTION_CAP } from '../../src/core/variable-options.js';

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

// #447: a dashboard-v2 document has NO `filters` — its variables are inferred
// from the `{name:Type}` placeholders in the queries its tiles own, so every
// fixture below declares its variables in SQL rather than configuring them here.
const doc = (over: Partial<DashboardDocumentV2> = {}): DashboardDocumentV2 => ({
  documentVersion: 2, id: 'd', title: 'D', revision: 1,
  layout: { type: 'flow', version: 1, preset: 'columns-2', items: {} },
  tiles: [], ...over,
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

  // #437 review, blocker 2: the freshness control needs a WALL-CLOCK "last
  // successful update" distinct from `updatedAt` (a monotonic value that only
  // marks "a wave finished", never suitable to format as a real time) — and a
  // refresh that leaves a tile in `error` status must not silently advance it.
  it('advances lastSuccessWallMs/lastRefreshOutcome on a clean refresh, and preserves the last good time when a later refresh leaves a tile in error', async () => {
    let shouldFail = false;
    let wall = 1000;
    const { exec } = makeExec(() => (shouldFail ? { error: 'boom' } : { columns: [{ name: 'n' }], rows: [[1]] }));
    const document = doc({ tiles: [tile('t1', 'q1')] });
    const session = createDashboardViewerSession(makeDeps({
      document, exec, queries: [query('q1', 'SELECT 1')], wallNow: () => wall,
    }));
    await session.start();
    expect(session.state.value.lastRefreshOutcome).toBe('success');
    expect(session.state.value.lastSuccessWallMs).toBe(1000);

    shouldFail = true;
    wall = 2000;
    await session.refresh();
    expect(session.state.value.tiles[0].status).toBe('error');
    expect(session.state.value.lastRefreshOutcome).toBe('failure');
    // Unchanged — the wave completed (`updatedAt` moved on) but did not
    // succeed, so the LAST GOOD time must survive underneath the failure.
    expect(session.state.value.lastSuccessWallMs).toBe(1000);
    expect(session.state.value.updatedAt).not.toBeNull();

    shouldFail = false;
    wall = 3000;
    await session.refresh();
    expect(session.state.value.lastRefreshOutcome).toBe('success');
    expect(session.state.value.lastSuccessWallMs).toBe(3000);
  });

  it('marks a tile whose query is missing as an error and reports a presentation diagnostic', async () => {
    const document = doc({ tiles: [tile('t1', 'ghost')] });
    const session = createDashboardViewerSession(makeDeps({ document, queries: [] }));
    await session.start();
    const state = session.state.value;
    expect(state.tiles[0].status).toBe('error');
    expect(state.tiles[0].error).toContain('ghost');
    // A dangling tile reference contributes no declarations, so no variable.
    expect(state.variables).toEqual([]);
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

  it('keeps an explicit legacy Table view on a chartable, log-shaped, and scalar Dashboard tile', async () => {
    const { exec } = makeExec((sql) => {
      if (sql.includes('chart')) return { columns: [{ name: 'time', type: 'DateTime' }, { name: 'value', type: 'UInt64' }], rows: [['2026-01-01', 1], ['2026-01-02', 2]] };
      if (sql.includes('logs')) return { columns: [{ name: 'event_time', type: 'DateTime' }, { name: 'message', type: 'String' }], rows: [['2026-01-01', 'hello']] };
      return { columns: [{ name: 'value', type: 'UInt64' }], rows: [[1]] };
    });
    const document = doc({ tiles: [tile('chart', 'chart'), tile('logs', 'logs'), tile('scalar', 'scalar')] });
    const session = createDashboardViewerSession(makeDeps({
      document, exec,
      queries: [
        query('chart', 'SELECT chart', { view: 'table' }),
        query('logs', 'SELECT logs', { view: 'table' }),
        query('scalar', 'SELECT scalar', { view: 'table' }),
      ],
    }));
    await session.start();
    expect(session.state.value.tiles.map((entry) => entry.panel)).toEqual([
      { cfg: { type: 'table' } }, { cfg: { type: 'table' } }, { cfg: { type: 'table' } },
    ]);
    expect(session.state.value.tiles.every((entry) => !entry.isKpi)).toBe(true);
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

// #447: the Dashboard's variables are INFERRED from the `{name:Type}`
// placeholders in the queries its panel tiles own (`core/dashboard-variables.ts`
// owns the pure inference; these assert the SESSION's wiring of it): a
// variable's exact name is its `id`, its `parameter` and its `label`; only a
// type-consistent (`active`) variable gets a runtime; a conflicted or orphaned
// one is still published so the Variables subtree can render its diagnostic.
describe('inferred variables (#447)', () => {
  it('infers one variable per declared name in first-declaration order; only bindable ones get a runtime', () => {
    const document = doc({
      tiles: [tile('t1', 'q1'), tile('t2', 'q2')],
      variableConfigs: {
        region: { sql: 'SELECT DISTINCT region FROM t' },
        gone: { sql: 'SELECT 1', lastKnownType: 'String' },
      },
    });
    const session = createDashboardViewerSession(makeDeps({
      document,
      queries: [
        query('q1', 'SELECT {region:String} AS r, {top:UInt8} AS n'),
        query('q2', 'SELECT {region:String} AS r'),
      ],
    }));
    const state = session.state.value;
    // Tile order, then appearance order inside each query; orphans last, by name.
    expect(state.variables.map((v) => [v.name, v.status, v.type])).toEqual([
      ['region', 'active', 'String'], ['top', 'active', 'UInt8'], ['gone', 'orphaned', 'String'],
    ]);
    expect(state.variables[0].sql).toBe('SELECT DISTINCT region FROM t');
    expect(state.variables[1].sql).toBeNull();
    expect(state.variables[2].diagnostic).toContain('not referenced by any Dashboard panel');
    // A variable's ONLY identity is its name — no filter id, no authored label,
    // no source topology.
    //
    // #447 phase 2: `configured` distinguishes the two control kinds from the
    // FIRST publish, before any option query has run — `region` carries option
    // SQL, so it is a single-select that is still 'loading', while `top` is a
    // direct input and has nothing to load ('idle'). Both start with
    // `options: null`; only a completed batch replaces that.
    expect(state.filters).toEqual([
      { id: 'region', parameter: 'region', label: 'region', active: false, value: '', status: 'loading', configured: true, optionsError: null, options: null, optionsRev: 0, optionsTruncated: false },
      { id: 'top', parameter: 'top', label: 'top', active: false, value: '', status: 'idle', configured: false, optionsError: null, options: null, optionsRev: 0, optionsTruncated: false },
    ]);
    expect(state.resettableFilterIds).toEqual([]);
    expect(state.activeFilterCount).toBe(0);
    expect(state.filterDiagnostics).toEqual([]);
  });

  it('a conflicted variable gets no runtime and blocks ONLY the panels that declare it', async () => {
    const { exec, calls } = makeExec(() => ({ columns: [{ name: 'n' }], rows: [[1]] }));
    const document = doc({ tiles: [tile('num', 'qn'), tile('str', 'qs'), tile('free', 'qf')] });
    const session = createDashboardViewerSession(makeDeps({
      document, exec,
      queries: [
        query('qn', 'SELECT {p:UInt64} AS n'),
        query('qs', 'SELECT {p:String} AS n'),
        query('qf', 'SELECT 1 AS n'),
      ],
    }));
    await session.start();
    const state = session.state.value;
    expect(state.variables.map((v) => [v.name, v.status])).toEqual([['p', 'conflicted']]);
    expect(state.variables[0].types).toEqual(['UInt64', 'String']);
    expect(state.variables[0].type).toBeNull();
    expect(state.variables[0].diagnostic).toContain('incompatible types');
    expect(state.filters).toEqual([]); // never bindable, so never committable
    // The two panels that declare it have no value to bind; the third still runs.
    expect(state.tiles.map((t) => [t.tileId, t.status])).toEqual([
      ['num', 'unfilled'], ['str', 'unfilled'], ['free', 'ready'],
    ]);
    expect(calls.map((c) => c.sql)).toEqual(['SELECT 1 AS n']);
    // Committing it is impossible — there is no runtime to address.
    await session.setFilter('p', 'x');
    expect(calls.length).toBe(1);
  });

  it('infers a variable that only a Text panel declares — inferred and committable, but with no execution target', async () => {
    const { exec, calls } = makeExec();
    const document = doc({ tiles: [tile('note', 'qnote')] });
    const session = createDashboardViewerSession(makeDeps({
      document, exec,
      queries: [query('qnote', 'SELECT {owner:String}', { panel: { cfg: { type: 'text', content: 'hi' } } })],
    }));
    await session.start();
    expect(session.state.value.filters.map((f) => f.id)).toEqual(['owner']);
    // Text tiles contribute empty SQL to the EXECUTION analysis, so the name has
    // no field control and no target tile at all.
    expect(session.controls).toEqual([]);
    expect(calls.length).toBe(0);
    await session.setFilter('owner', 'ada');
    expect(session.state.value.filters[0]).toMatchObject({ value: 'ada', active: true });
    expect(calls.length).toBe(0); // a wave over zero targets issues nothing
  });
});

// #303: `initialFilters` seeds each variable's runtime value/active from a
// persisted bag (the shell's isolated per-dashboard store). #447 re-keyed it
// from the (now gone) filter definition id to the VARIABLE NAME. These assert on
// the session's initial `state.value.filters` BEFORE `start()` — the seed is
// applied at construction time, no query execution required.
describe('initialFilters seeding (#303)', () => {
  const seededDoc = () => doc({ tiles: [tile('t1', 'q1'), tile('t2', 'q2')] });
  const seededQueries = () => [query('q1', 'SELECT {p1:String}'), query('q2', 'SELECT {p2:String}')];
  const byId = (session: ReturnType<typeof createDashboardViewerSession>, id: string) =>
    session.state.value.filters.find((f) => f.id === id)!;

  it('starts a seeded variable with its persisted value+active', () => {
    const session = createDashboardViewerSession(makeDeps({
      document: seededDoc(), queries: seededQueries(),
      initialFilters: { p1: { value: 'seeded', active: true } },
    }));
    expect(byId(session, 'p1')).toMatchObject({ value: 'seeded', active: true });
  });

  it('leaves an unseeded variable (absent from the map) UNSET', () => {
    const session = createDashboardViewerSession(makeDeps({
      document: seededDoc(), queries: seededQueries(),
      initialFilters: { p1: { value: 'seeded', active: true } },
    }));
    expect(byId(session, 'p2')).toMatchObject({ value: '', active: false });
  });

  it('behaves identically when initialFilters is absent', () => {
    const session = createDashboardViewerSession(makeDeps({ document: seededDoc(), queries: seededQueries() }));
    expect(byId(session, 'p1')).toMatchObject({ value: '', active: false });
    expect(byId(session, 'p2')).toMatchObject({ value: '', active: false });
  });

  it('behaves identically when initialFilters is an empty map', () => {
    const session = createDashboardViewerSession(makeDeps({
      document: seededDoc(), queries: seededQueries(), initialFilters: {},
    }));
    expect(byId(session, 'p1')).toMatchObject({ value: '', active: false });
    expect(byId(session, 'p2')).toMatchObject({ value: '', active: false });
  });

  it('falls back to the UNSET value when a seed entry has a nullish value', () => {
    const session = createDashboardViewerSession(makeDeps({
      document: seededDoc(), queries: seededQueries(),
      initialFilters: { p1: { value: null, active: true } },
    }));
    expect(byId(session, 'p1')).toMatchObject({ value: '', active: true });
  });

  it("a seed's explicit active:false wins over its own non-empty value", () => {
    const session = createDashboardViewerSession(makeDeps({
      // A non-empty value would IMPLY activation via `setFilter`; the seed's
      // explicit `active` flag is authoritative and is never re-derived from it.
      document: seededDoc(), queries: seededQueries(),
      initialFilters: { p1: { value: 'V', active: false } },
    }));
    expect(byId(session, 'p1')).toMatchObject({ value: 'V', active: false });
    expect(session.state.value.activeFilterCount).toBe(0);
    // The retained value still makes it "resettable" — there is something to clear.
    expect(session.state.value.resettableFilterIds).toEqual(['p1']);
  });
});

describe('variables and the affected-panel planner', () => {
  // One variable per declaring panel, plus an unrelated tile no variable
  // can ever affect.
  const twoTileDoc = () => doc({ tiles: [tile('affected', 'qa'), tile('unaffected', 'qu')] });
  const twoTileQueries = () => [
    query('qa', 'SELECT {p:String} AS n'),
    query('qu', 'SELECT 1 AS n'),
  ];

  it('setFilter runs only the affected panel wave', async () => {
    const { exec, calls } = makeExec(() => ({ columns: [{ name: 'n' }], rows: [[1]] }));
    const session = createDashboardViewerSession(makeDeps({
      document: twoTileDoc(), exec, queries: twoTileQueries(),
    }));
    await session.start();
    // 'affected' is unfilled ({p} required, unset); only 'unaffected' ran.
    expect(calls.map((c) => c.sql)).toEqual(['SELECT 1 AS n']);
    const before = calls.length;
    await session.setFilter('missing', 'x'); // unknown variable: no-op
    expect(calls.length).toBe(before);
    await session.setFilter('p', 'W');
    // Only the tile that declares {p} re-ran.
    const added = calls.slice(before);
    expect(added.length).toBe(1);
    expect(added[0].params.param_p).toBe('W');
    expect(session.state.value.activeFilterCount).toBe(1);
  });

  it('clearFilter deactivates without discarding the value; reactivation restores it', async () => {
    const { exec } = makeExec(() => ({ columns: [{ name: 'n' }], rows: [[1]] }));
    const session = createDashboardViewerSession(makeDeps({
      document: twoTileDoc(), exec, queries: twoTileQueries(),
    }));
    await session.start();
    await session.setFilter('p', 'V');
    expect(session.state.value.filters[0].active).toBe(true);
    await session.clearFilter('p');
    expect(session.state.value.filters[0].active).toBe(false);
    expect(session.state.value.filters[0].value).toBe('V'); // value retained
    expect(session.state.value.activeFilterCount).toBe(0);
    // A retained-but-inactive value is still "resettable" — there is something
    // to clear even though nothing is bound.
    expect(session.state.value.resettableFilterIds).toEqual(['p']);
    await session.setFilter('p', session.state.value.filters[0].value); // reactivate
    expect(session.state.value.filters[0].active).toBe(true);
    await session.clearFilter('nope'); // unknown: no-op
  });

  it('clearAllFilters resets every variable to UNSET, coalesced into ONE wave', async () => {
    const { exec, calls } = makeExec(() => ({ columns: [{ name: 'n' }], rows: [[1]] }));
    // One wave == one `deps.wallNow()` read (#335's single-snapshot rule); two
    // sequential waves would take two.
    const wallReads: number[] = [];
    let wall = 1_700_000_000_000;
    const session = createDashboardViewerSession(makeDeps({
      document: doc({ tiles: [tile('a', 'qa'), tile('b', 'qb')] }),
      exec,
      wallNow: () => { wall += 1000; wallReads.push(wall); return wall; },
      queries: [query('qa', 'SELECT {p:String} AS n'), query('qb', 'SELECT {q:String} AS n')],
    }));
    await session.start();
    await session.setFilter('p', 'X');
    await session.setFilter('q', 'Y');
    expect(calls.filter((c) => 'param_p' in c.params).length).toBe(1);
    expect(calls.filter((c) => 'param_q' in c.params).length).toBe(1);
    const readsBefore = wallReads.length;

    await session.clearAllFilters();
    // Exactly ONE coalesced wave for BOTH resets.
    expect(wallReads.length - readsBefore).toBe(1);
    expect(session.state.value.filters.map((f) => [f.value, f.active]))
      .toEqual([['', false], ['', false]]);
    expect(session.state.value.resettableFilterIds).toEqual([]);
    // Both tiles were in that one wave: each re-gated to `unfilled` on its own
    // now-blank required parameter, and neither issued a request.
    expect(session.state.value.tiles.map((t) => t.status)).toEqual(['unfilled', 'unfilled']);
    expect(calls.filter((c) => 'param_p' in c.params || 'param_q' in c.params).length).toBe(2);

    // A second clear-all with nothing left to clear issues no wave at all.
    const readsAfter = wallReads.length;
    await session.clearAllFilters();
    expect(wallReads.length).toBe(readsAfter);
  });

  it('resetFilters resets only the named variables in one wave, and no-ops when unchanged or destroyed', async () => {
    const { exec, calls } = makeExec(() => ({ columns: [{ name: 'n' }], rows: [[1]] }));
    const wallReads: number[] = [];
    let wall = 1_700_000_000_000;
    const session = createDashboardViewerSession(makeDeps({
      document: doc({ tiles: [tile('a', 'qa'), tile('b', 'qb')] }),
      exec,
      wallNow: () => { wall += 1000; wallReads.push(wall); return wall; },
      queries: [query('qa', 'SELECT {from:String}'), query('qb', 'SELECT {region:String}')],
    }));
    await session.start();
    await session.setFilter('from', '-7d');
    await session.setFilter('region', 'west');
    expect(session.state.value.tiles.map((t) => t.status)).toEqual(['ready', 'ready']);
    expect(session.state.value.resettableFilterIds).toEqual(['from', 'region']);
    const readsBefore = wallReads.length;
    const callsBefore = calls.length;

    await session.resetFilters(['region', 'unknown']);
    expect(wallReads.length - readsBefore).toBe(1); // exactly ONE wave
    expect(session.state.value.filters.map((filter) => filter.value)).toEqual(['-7d', '']);
    expect(session.state.value.resettableFilterIds).toEqual(['from']);
    // Only 'region''s target tile was in that wave — it re-gated to `unfilled`
    // on its now-blank required parameter, while 'from''s tile kept its result.
    expect(session.state.value.tiles.map((t) => t.status)).toEqual(['ready', 'unfilled']);
    expect(calls.length).toBe(callsBefore); // an unset parameter issues no request

    const unchanged = wallReads.length;
    await session.resetFilters(['region']);
    expect(wallReads.length).toBe(unchanged); // nothing changed → no wave
    session.destroy();
    await session.resetFilters(['from']);
    expect(session.state.value.filters[0].value).toBe('-7d');
    session.setTileSearch('ignored');
    expect(session.state.value.tileSearch).toBe('');
  });

  it('tile search matches normalized title/description, repacks both layouts, and never executes again', async () => {
    const { exec, calls } = makeExec();
    const document = doc({
      tiles: [
        tile('a', 'qa', { title: 'Revenue   Overview' }),
        tile('b', 'qb', { description: 'Latency by region' }),
        tile('c', 'qc'),
        tile('d', 'qd', { title: '', description: '' }),
      ],
    });
    const session = createDashboardViewerSession(makeDeps({
      document, exec,
      queries: [
        query('qa', 'SELECT 1'), query('qb', 'SELECT 2'),
        query('qc', 'SELECT 3', { description: 'Capacity forecast' }),
        query('qd', 'SELECT 4', { name: 'Fallback title', description: 'Fallback description' }),
      ],
    }));
    await session.start();
    const executed = calls.length;
    session.setTileSearch('  revenue overview ');
    expect(session.state.value.tiles.map((entry) => entry.tileId)).toEqual(['a']);
    expect(session.state.value).toMatchObject({
      totalTileCount: 4, visibleTileCount: 1, tileSearch: '  revenue overview ',
    });
    expect(session.state.value.tiles[0].description).toBe('');
    if (session.state.value.layout.engine !== 'flow') throw new Error('expected flow');
    expect(session.state.value.layout.rows.flatMap((row) => row.tiles).map((entry) => entry.tileId)).toEqual(['a']);

    session.setTileSearch('capacity');
    expect(session.state.value.tiles.map((entry) => entry.tileId)).toEqual(['c']);
    expect(session.state.value.tiles[0].description).toBe('Capacity forecast');
    session.setTileSearch('fallback description');
    expect(session.state.value.tiles.map((entry) => entry.tileId)).toEqual(['d']);
    expect(session.state.value.tiles[0]).toMatchObject({
      title: 'Fallback title', description: 'Fallback description',
    });
    session.setTileSearch('capacity');
    session.syncDocument({
      ...document,
      layout: { type: 'grafana-grid', version: 1, items: { c: { span: 4, height: 2 } } },
    });
    const gridLayout = session.state.value.layout as DashboardLayoutView;
    if (gridLayout.engine !== 'grafana-grid') throw new Error('expected grid');
    expect(gridLayout.grid.tiles.map((entry) => entry.tileId)).toEqual(['c']);
    expect(calls.length).toBe(executed);

    session.setTileSearch('missing');
    expect(session.state.value.visibleTileCount).toBe(0);
    session.setTileSearch('');
    expect(session.state.value.tiles.map((entry) => entry.tileId)).toEqual(['a', 'b', 'c', 'd']);
    session.setTileSearch(''); // identical search is a no-op
  });
});

describe('filter-bar bridge (controls / getFilterField / applyFilter)', () => {
  it('exposes controls + a draft-aware field state, and applyFilter sets value AND active explicitly', async () => {
    const { exec, calls } = makeExec(() => ({ columns: [{ name: 'n' }], rows: [[1]] }));
    const session = createDashboardViewerSession(makeDeps({
      document: doc({ tiles: [tile('t', 'q')] }),
      exec, queries: [query('q', 'SELECT {p:String} AS n')],
    }));
    await session.start();
    expect(session.controls.map((c) => c.name)).toContain('p');
    // Draft-aware #170 validation: empty required → not ok; a value → ok.
    expect(session.getFilterField('p', 'execute', { p: '' }, { p: false }).state).not.toBe('ok');
    expect(session.getFilterField('p', 'execute', { p: 'x' }, { p: true }).state).toBe('ok');
    // applyFilter(value, active=true) → the affected tile re-runs with the value bound.
    const before = calls.length;
    await session.applyFilter('p', 'x', true);
    expect(calls.slice(before).find((c) => 'param_p' in c.params)?.params.param_p).toBe('x');
    expect(session.state.value.filters[0]).toMatchObject({ value: 'x', active: true });
    // applyFilter(value, active=false) keeps the value but deactivates it.
    await session.applyFilter('p', 'x', false);
    expect(session.state.value.filters[0]).toMatchObject({ value: 'x', active: false });
    // Unknown variable name and post-destroy are no-ops.
    await session.applyFilter('nope', 'y', true);
    session.destroy();
    await session.applyFilter('p', 'z', true);
    expect(session.state.value.filters[0].value).toBe('x');
  });
});

describe('per-tile control and lifecycle', () => {
  it('destroy aborts a tile request that is still in flight', async () => {
    let signal: AbortSignal | undefined;
    const { exec } = makeExec((_sql, req) => {
      signal = req.signal;
      return new Promise(() => {});
    });
    const session = createDashboardViewerSession(makeDeps({
      document: doc({ tiles: [tile('t1', 'q1')] }), exec,
      queries: [query('q1', 'SELECT 1')],
    }));
    void session.start();
    await flush();
    expect(signal?.aborted).toBe(false);
    session.destroy();
    expect(signal?.aborted).toBe(true);
  });

  it('a variable commit stops before its affected tile wave when authentication fails', async () => {
    let tokenOk = true;
    const ensureFreshToken = vi.fn(async () => tokenOk);
    const { exec, calls } = makeExec();
    const session = createDashboardViewerSession(makeDeps({
      document: doc({ tiles: [tile('t1', 'q1')] }),
      exec, connection: { ensureFreshToken },
      queries: [query('q1', 'SELECT {p:String}')],
    }));
    await session.start();
    const before = calls.length;
    tokenOk = false;
    await session.applyFilter('p', 'x', true);
    expect(calls).toHaveLength(before);
  });

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

  it('a superseded seventh queued tile worker exits before mutating state or issuing a request', async () => {
    let releaseOldWorkers!: () => void;
    const oldWorkers = new Promise<void>((resolve) => { releaseOldWorkers = resolve; });
    const tileQueries = Array.from({ length: VIEWER_TILE_CONCURRENCY + 1 }, (_, index) =>
      query(`q${index + 1}`, `SELECT ${index + 1} /* tile-${index + 1} */`));
    const { exec, calls } = makeExec((sql) => {
      const id = Number(sql.match(/tile-(\d+)/)?.[1]);
      if (id <= VIEWER_TILE_CONCURRENCY) {
        return oldWorkers.then(() => ({ columns: [{ name: `old-${id}` }], rows: [[id]] }));
      }
      return { columns: [{ name: 'fresh-7' }], rows: [[7]] };
    });
    const session = createDashboardViewerSession(makeDeps({
      document: doc({ tiles: tileQueries.map((entry, index) => tile(`t${index + 1}`, entry.id)) }),
      exec, queries: tileQueries,
    }));

    const oldWave = session.start();
    await flush();
    expect(calls).toHaveLength(VIEWER_TILE_CONCURRENCY);

    await session.refreshTile(`t${VIEWER_TILE_CONCURRENCY + 1}`);
    const fresh = session.state.value.tiles[VIEWER_TILE_CONCURRENCY];
    expect(fresh.status).toBe('ready');
    expect(fresh.columns).toEqual([{ name: 'fresh-7' }]);

    releaseOldWorkers();
    await oldWave;
    expect(calls.filter((call) => call.sql.includes(`tile-${VIEWER_TILE_CONCURRENCY + 1}`))).toHaveLength(1);
    expect(session.state.value.tiles[VIEWER_TILE_CONCURRENCY]).toMatchObject({
      status: 'ready', columns: [{ name: 'fresh-7' }], rows: [[7]],
    });
  });

  it('destroy cancels in-flight work and turns later entry points into no-ops', async () => {
    let releaseSlow!: () => void;
    const gate = new Promise<void>((resolve) => { releaseSlow = resolve; });
    const { exec, calls } = makeExec((sql) => (sql.includes('slow')
      ? gate.then(() => ({ columns: [{ name: 'n' }], rows: [[1]] }))
      : { columns: [{ name: 'n' }], rows: [[1]] }));
    const document = doc({ tiles: [tile('slow', 'qslow'), tile('fast', 'qfast')] });
    const session = createDashboardViewerSession(makeDeps({
      document, exec, initialFilters: { p: { value: 'V', active: true } },
      queries: [query('qslow', 'SELECT {p:String} AS n /* slow */'), query('qfast', 'SELECT 1 AS n')],
    }));
    const done = session.start();
    await flush();
    session.destroy();
    releaseSlow();
    await done;
    const after = calls.length;
    await session.refresh();
    await session.refreshTile('slow');
    await session.setFilter('p', 'Z');
    await session.clearFilter('p');
    await session.clearAllFilters();
    expect(calls.length).toBe(after); // nothing ran post-destroy
    expect(session.state.value.updatedAt).toBeNull();
  });

  // #437 review: a `refresh()` destroyed while its own tile wave is still in
  // flight must never record an outcome — the tile's status is left at
  // `loading` (never advanced to `ready`/`error`) by the SAME destroyed-tile-
  // generation guard `runTile` already uses, so an unguarded
  // `recordRefreshOutcome` would misread it as a clean success and wrongly
  // advance `lastSuccessWallMs` to a wave that never actually finished.
  it('a refresh destroyed mid-wave never records an outcome, leaving lastSuccessWallMs untouched', async () => {
    let execCalls = 0;
    let releaseSecond!: (value: Resp) => void;
    const gate = new Promise<Resp>((resolve) => { releaseSecond = resolve; });
    const { exec } = makeExec(() => {
      execCalls += 1;
      return execCalls === 1 ? { columns: [{ name: 'n' }], rows: [[1]] } : gate;
    });
    const document = doc({ tiles: [tile('t1', 'q1')] });
    let wall = 1000;
    const session = createDashboardViewerSession(makeDeps({
      document, exec, queries: [query('q1', 'SELECT 1')], wallNow: () => wall,
    }));
    await session.start();
    expect(session.state.value.lastSuccessWallMs).toBe(1000);

    wall = 2000;
    const refreshing = session.refresh();
    await flush();
    session.destroy();
    releaseSecond({ columns: [{ name: 'n' }], rows: [[1]] });
    await refreshing;

    // A buggy `recordRefreshOutcome` with no destroyed guard would have
    // advanced this to 2000, even though the session was torn down mid-wave.
    expect(session.state.value.lastSuccessWallMs).toBe(1000);
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
  const gridDoc = (over: Partial<DashboardDocumentV2> = {}) => doc({
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
      // 'compact' is the legacy height alias, canonicalized to row unit 1
      // (#291 height-units follow-up) by the time it reaches the render model.
      expect(layout.grid.tiles[0]).toMatchObject({ tileId: 'a', span: 4, heightUnits: 1 });
      // No persisted placement for 'b' → the grid default (span 6, height 2).
      expect(layout.grid.tiles[1]).toMatchObject({ tileId: 'b', span: 6, heightUnits: 2 });
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
      layout: { type: 'grafana-grid', version: 2, items: {} } as unknown as DashboardDocumentV2['layout'],
    });
    const session = createDashboardViewerSession(makeDeps({ document, exec, queries: [query('qa', 'SELECT 1')] }));
    await session.start();
    // An unsupported grid version with no flow@1 fallback resolves to the
    // flow plugin (resolveLayoutPluginSync's own documented fallback), which
    // renders every tile at the flow default (no persisted flow surface).
    expect(session.state.value.layout.engine).toBe('flow');
  });
});

// #321 "Full view": setGridRenderMode is a TRANSIENT runtime override — never
// a document mutation, never a commit (there is nothing to commit against;
// the session has no `workspace.commit` seam at all), never a revision bump.
describe('setGridRenderMode / Full view (#321)', () => {
  const gridDoc = (over: Partial<DashboardDocumentV2> = {}) => doc({
    tiles: [tile('a', 'qa'), tile('b', 'qb')],
    layout: { type: 'grafana-grid', version: 1, items: { a: { span: 4, height: 2 } } },
    ...over,
  });
  const gridQueries = () => [query('qa', 'SELECT 1'), query('qb', 'SELECT 2')];

  it('defaults to tiles mode; every tile keeps its authored/effective span', async () => {
    const { exec } = makeExec(() => ({ columns: [{ name: 'n' }], rows: [[1]] }));
    const session = createDashboardViewerSession(makeDeps({ document: gridDoc(), exec, queries: gridQueries() }));
    await session.start();
    const layout = session.state.value.layout;
    if (layout.engine !== 'grafana-grid') throw new Error('expected grafana-grid engine');
    expect(layout.renderMode).toBe('tiles');
    expect(layout.grid.tiles[0]).toMatchObject({ tileId: 'a', span: 4, persistedSpan: 4 });
    expect(layout.grid.tiles[1]).toMatchObject({ tileId: 'b', span: 6, persistedSpan: 6 });
  });

  it('setGridRenderMode(\'full\') republishes with every tile spanning the full column count, ' +
    'WITHOUT touching the document or committing', async () => {
    const { exec } = makeExec(() => ({ columns: [{ name: 'n' }], rows: [[1]] }));
    const document = gridDoc();
    const itemsBefore = JSON.stringify(document.layout.items);
    const session = createDashboardViewerSession(makeDeps({ document, exec, queries: gridQueries() }));
    await session.start();
    session.setGridRenderMode('full');
    const layout = session.state.value.layout;
    if (layout.engine !== 'grafana-grid') throw new Error('expected grafana-grid engine');
    expect(layout.renderMode).toBe('full');
    expect(layout.grid.tiles.every((t) => t.span === layout.grid.columns)).toBe(true);
    // persistedSpan is untouched — the authored spans still travel.
    expect(layout.grid.tiles[0].persistedSpan).toBe(4);
    expect(layout.grid.tiles[1].persistedSpan).toBe(6);
    // The caller's own document object (and its items) is bit-identical.
    expect(JSON.stringify(document.layout.items)).toBe(itemsBefore);
  });

  it('setGridRenderMode(\'tiles\') after \'full\' restores the exact authored spans', async () => {
    const { exec } = makeExec(() => ({ columns: [{ name: 'n' }], rows: [[1]] }));
    const session = createDashboardViewerSession(makeDeps({ document: gridDoc(), exec, queries: gridQueries() }));
    await session.start();
    session.setGridRenderMode('full');
    session.setGridRenderMode('tiles');
    const layout = session.state.value.layout;
    if (layout.engine !== 'grafana-grid') throw new Error('expected grafana-grid engine');
    expect(layout.renderMode).toBe('tiles');
    expect(layout.grid.tiles[0]).toMatchObject({ span: 4, persistedSpan: 4 });
    expect(layout.grid.tiles[1]).toMatchObject({ span: 6, persistedSpan: 6 });
  });

  it('survives a subsequent syncDocument (placement command) — the render-mode override is session-owned, not document-owned', async () => {
    const { exec } = makeExec(() => ({ columns: [{ name: 'n' }], rows: [[1]] }));
    const document = gridDoc();
    const session = createDashboardViewerSession(makeDeps({ document, exec, queries: gridQueries() }));
    await session.start();
    session.setGridRenderMode('full');
    // A placement-command-style syncDocument (a height change on tile 'a').
    session.syncDocument({
      ...document,
      layout: { type: 'grafana-grid', version: 1, items: { a: { span: 4, height: 5 } } },
    });
    const layout = session.state.value.layout;
    if (layout.engine !== 'grafana-grid') throw new Error('expected grafana-grid engine');
    expect(layout.renderMode).toBe('full');
    expect(layout.grid.tiles.every((t) => t.span === layout.grid.columns)).toBe(true);
    expect(layout.grid.tiles[0].heightUnits).toBe(5);
  });

  it('is a no-op after destroy', async () => {
    const { exec } = makeExec(() => ({ columns: [{ name: 'n' }], rows: [[1]] }));
    const session = createDashboardViewerSession(makeDeps({ document: gridDoc(), exec, queries: gridQueries() }));
    await session.start();
    session.destroy();
    session.setGridRenderMode('full');
    const layout = session.state.value.layout;
    if (layout.engine !== 'grafana-grid') throw new Error('expected grafana-grid engine');
    expect(layout.renderMode).toBe('tiles');
  });

  it('projects every Dashboard style without mutating or re-running the session document', async () => {
    const { exec, calls } = makeExec(() => ({ columns: [{ name: 'n' }], rows: [[1]] }));
    const document = gridDoc();
    const before = JSON.stringify(document);
    const session = createDashboardViewerSession(makeDeps({ document, exec, queries: gridQueries() }));
    await session.start();
    const executed = calls.length;

    session.setDashboardStyle('full');
    expect(session.state.value.style).toBe('full');
    expect(session.state.value.layout.engine).toBe('grafana-grid');
    session.setDashboardStyle('report');
    expect(session.state.value.style).toBe('report');
    expect(session.state.value.layout.engine).toBe('flow');
    if (session.state.value.layout.engine === 'flow') expect(session.state.value.layout.preset).toBe('report');
    session.setDashboardStyle('columns-3');
    if (session.state.value.layout.engine === 'flow') expect(session.state.value.layout.columns).toBe(3);
    session.setDashboardStyle('grafana-grid');
    expect(session.state.value.layout.engine).toBe('grafana-grid');
    expect(calls.length).toBe(executed);
    expect(JSON.stringify(document)).toBe(before);
  });

  it('projects grid styles from a flow document, preserves flow placements, and ignores duplicate/destroyed choices', async () => {
    const { exec } = makeExec(() => ({ columns: [{ name: 'n' }], rows: [[1]] }));
    const document = doc({
      tiles: [tile('a', 'qa'), tile('b', 'qb')],
      layout: { type: 'flow', version: 1, preset: 'columns-2', items: { a: { span: 2 } } },
    });
    const session = createDashboardViewerSession(makeDeps({ document, exec, queries: gridQueries() }));
    await session.start();
    session.setDashboardStyle('columns-3');
    if (session.state.value.layout.engine === 'flow') expect(session.state.value.layout.rows[0].tiles[0].span).toBe(2);
    session.setDashboardStyle('full');
    expect(session.state.value.layout.engine).toBe('grafana-grid');
    session.setDashboardStyle('full'); // duplicate selection is a no-op
    session.destroy();
    session.setDashboardStyle('report');
    expect(session.state.value.style).toBe('full');
  });
});

describe('flow layout (mobile normalization)', () => {
  it('normalizes the flow layout on mobile and coerces variable values to strings', async () => {
    const { exec, calls } = makeExec(() => ({ columns: [{ name: 'n' }], rows: [[1]] }));
    let mobile = true;
    const session = createDashboardViewerSession(makeDeps({
      document: doc({
        tiles: [tile('a', 'qa')],
        layout: { type: 'flow', version: 1, preset: 'columns-3', items: { a: { span: 3 } } },
      }),
      exec, queries: [query('qa', 'SELECT {p:String} AS n')], isMobile: () => mobile,
    }));
    await session.start();
    const mobileLayout = session.state.value.layout;
    if (mobileLayout.engine !== 'flow') throw new Error('expected flow engine');
    expect(mobileLayout.columns).toBe(1);
    expect(mobileLayout.rows[0].tiles[0].span).toBe(1);
    // A numeric value coerces to a string on the way to the pipeline; setting
    // null clears it.
    await session.setFilter('p', 5);
    expect(session.state.value.filters[0].active).toBe(true);
    expect(calls.find((c) => 'param_p' in c.params)?.params.param_p).toBe('5');
    await session.setFilter('p', null);
    expect(session.state.value.filters[0].active).toBe(false);
    mobile = false;
  });
});

describe('applyFilters batch commit (#335)', () => {
  const bothDoc = () => doc({ tiles: [tile('ta', 'qa'), tile('tb', 'qb'), tile('tboth', 'qboth')] });
  const bothQueries = () => [
    query('qa', 'SELECT {p:String} AS n'),
    query('qb', 'SELECT {q:String} AS n'),
    query('qboth', 'SELECT {p:String} AS a, {q:String} AS b'),
  ];

  it('is atomic: an unknown id among the entries mutates nothing and runs no wave', async () => {
    const { exec, calls } = makeExec(() => ({ columns: [{ name: 'n' }], rows: [[1]] }));
    const session = createDashboardViewerSession(makeDeps({ document: bothDoc(), exec, queries: bothQueries() }));
    await session.start();
    const base = calls.length;
    const snapshot = session.state.value;
    await session.applyFilters([
      { filterId: 'p', value: 'x', active: true },
      { filterId: 'nope', value: 'y', active: true },
    ]);
    expect(calls.length).toBe(base); // no wave
    expect(session.state.value).toBe(snapshot); // no publish
    expect(session.state.value.filters[0]).toMatchObject({ value: '', active: false });
    expect(session.state.value.filters[1]).toMatchObject({ value: '', active: false });
  });

  it('is atomic: a duplicate id in the call mutates nothing and runs no wave', async () => {
    const { exec, calls } = makeExec(() => ({ columns: [{ name: 'n' }], rows: [[1]] }));
    const session = createDashboardViewerSession(makeDeps({ document: bothDoc(), exec, queries: bothQueries() }));
    await session.start();
    const base = calls.length;
    const snapshot = session.state.value;
    await session.applyFilters([
      { filterId: 'p', value: 'x', active: true },
      { filterId: 'p', value: 'z', active: true },
    ]);
    expect(calls.length).toBe(base);
    expect(session.state.value).toBe(snapshot);
    expect(session.state.value.filters[0]).toMatchObject({ value: '', active: false });
  });

  it('validates the complete typed batch before mutation and reports failure', async () => {
    const { exec, calls } = makeExec(() => ({ columns: [{ name: 'n' }], rows: [[1]] }));
    const session = createDashboardViewerSession(makeDeps({
      document: doc({ tiles: [tile('t', 'q')] }),
      exec, queries: [query('q', 'SELECT {from:DateTime}, {to:DateTime}')],
    }));
    await session.start();
    const base = calls.length;
    const result = await session.applyFilters([
      { filterId: 'from', value: '1700000000', active: true },
      { filterId: 'to', value: 'now-nope', active: true },
    ]);
    expect(result).toMatchObject({ ok: false });
    expect(session.state.value.filters).toMatchObject([
      { value: '', active: false }, { value: '', active: false },
    ]);
    expect(calls).toHaveLength(base);
  });

  it('allows inactive values for a variable with no execution target, but rejects activating one', async () => {
    const { exec } = makeExec(() => ({ columns: [{ name: 'n' }], rows: [[1]] }));
    const session = createDashboardViewerSession(makeDeps({
      // The only declaration of {orphan} sits in a TEXT panel's query, which
      // contributes empty SQL to the execution analysis — the variable exists
      // and is committable, but no runnable panel can bind it.
      document: doc({ tiles: [tile('note', 'q')] }),
      exec,
      queries: [query('q', 'SELECT {orphan:String}', { panel: { cfg: { type: 'text', content: 'x' } } })],
    }));
    await session.start();
    expect(await session.applyFilters([{ filterId: 'orphan', value: 'kept', active: false }]))
      .toEqual({ ok: true, changed: true });
    expect(await session.applyFilters([{ filterId: 'orphan', value: 'bad', active: true }]))
      .toEqual({ ok: false, error: 'orphan is not a valid filter value.' });
    expect(session.state.value.filters[0]).toMatchObject({ value: 'kept', active: false });
  });

  it('hardens an incomplete value through the same scoped execution pipeline', async () => {
    const { exec } = makeExec(() => ({ columns: [{ name: 'n' }], rows: [[1]] }));
    const session = createDashboardViewerSession(makeDeps({
      document: doc({ tiles: [tile('int', 'qi')] }),
      exec, queries: [query('qi', 'SELECT {i:Int32}')],
    }));
    await session.start();
    expect(await session.applyFilters([{ filterId: 'i', value: '-', active: true }]))
      .toMatchObject({ ok: false });
    expect(session.state.value.filters[0]).toMatchObject({ value: '', active: false });
    expect(await session.applyFilters([{ filterId: 'i', value: '-3', active: true }]))
      .toEqual({ ok: true, changed: true });
  });

  it('settles an aborted loading tile when reserved work cannot pass token preflight', async () => {
    let hold = false; let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let tokenOk = true;
    const { exec } = makeExec(async () => {
      if (hold) await gate;
      return { columns: [{ name: 'n' }], rows: [[1]] };
    });
    const session = createDashboardViewerSession(makeDeps({
      document: doc({ tiles: [tile('t', 'q')] }),
      exec, connection: { ensureFreshToken: async () => tokenOk },
      initialFilters: { p: { value: '1700000000', active: true } },
      queries: [query('q', 'SELECT {p:DateTime}')],
    }));
    await session.start();
    hold = true;
    const old = session.refreshTile('t');
    await flush();
    expect(session.state.value.tiles[0].status).toBe('loading');
    tokenOk = false;
    await session.applyFilters([{ filterId: 'p', value: '1800000000', active: true }]);
    expect(session.state.value.tiles[0].status).toBe('idle');
    release(); await old;
    expect(session.state.value.tiles[0].status).toBe('idle');
  });

  it('commits both variables active and reruns the UNION of their targets in exactly one wave (a tile consuming both runs once)', async () => {
    const { exec, calls } = makeExec(() => ({ columns: [{ name: 'n' }], rows: [[1]] }));
    const session = createDashboardViewerSession(makeDeps({ document: bothDoc(), exec, queries: bothQueries() }));
    await session.start();
    const base = calls.length;
    await session.applyFilters([
      { filterId: 'p', value: 'x', active: true },
      { filterId: 'q', value: 'y', active: true },
    ]);
    // Both bounds committed + active.
    expect(session.state.value.filters[0]).toMatchObject({ value: 'x', active: true });
    expect(session.state.value.filters[1]).toMatchObject({ value: 'y', active: true });
    const added = calls.slice(base);
    // Union of p's targets {ta, tboth} and q's targets {tb, tboth} = 3 tiles,
    // each run EXACTLY once — the tile consuming BOTH names never runs twice.
    expect(added.length).toBe(3);
    const bothParamCalls = added.filter((c) => 'param_p' in c.params && 'param_q' in c.params);
    expect(bothParamCalls.length).toBe(1);
    expect(bothParamCalls[0].params).toMatchObject({ param_p: 'x', param_q: 'y' });
    expect(added.filter((c) => 'param_p' in c.params && !('param_q' in c.params)).length).toBe(1);
    expect(added.filter((c) => 'param_q' in c.params && !('param_p' in c.params)).length).toBe(1);
  });

  it('an identical-pair call (values + active equal to the committed state) publishes nothing and runs no wave', async () => {
    const { exec, calls } = makeExec(() => ({ columns: [{ name: 'n' }], rows: [[1]] }));
    const session = createDashboardViewerSession(makeDeps({ document: bothDoc(), exec, queries: bothQueries() }));
    await session.start();
    await session.applyFilters([
      { filterId: 'p', value: 'x', active: true },
      { filterId: 'q', value: 'y', active: true },
    ]);
    const base = calls.length;
    const snapshot = session.state.value;
    await session.applyFilters([
      { filterId: 'p', value: 'x', active: true },
      { filterId: 'q', value: 'y', active: true },
    ]);
    expect(calls.length).toBe(base); // no wave
    expect(session.state.value).toBe(snapshot); // no publish
  });

  it('a mixed call (one entry changed, one identical) reruns ONLY the changed variable\'s targets', async () => {
    const { exec, calls } = makeExec(() => ({ columns: [{ name: 'n' }], rows: [[1]] }));
    const session = createDashboardViewerSession(makeDeps({ document: bothDoc(), exec, queries: bothQueries() }));
    await session.start();
    await session.applyFilters([
      { filterId: 'p', value: 'x', active: true },
      { filterId: 'q', value: 'y', active: true },
    ]);
    const base = calls.length;
    await session.applyFilters([
      { filterId: 'p', value: 'x', active: true }, // identical — not in `changed`
      { filterId: 'q', value: 'z', active: true }, // changed
    ]);
    const added = calls.slice(base);
    // Only q's targets {tb, tboth} rerun; ta (p only) does NOT.
    expect(added.every((c) => 'param_q' in c.params)).toBe(true);
    expect(added.some((c) => 'param_p' in c.params && !('param_q' in c.params))).toBe(false);
    expect(added.length).toBe(2);
    expect(session.state.value.filters[1].value).toBe('z');
  });

  it('a concurrent applyFilters wave is superseded by a newer commit (stale-wave guard) — the newer value wins', async () => {
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let n = 0;
    const { exec } = makeExec(async (_sql, req) => {
      n += 1;
      const rows = [[req.params?.param_p]];
      if (n === 1) { await gate; return { columns: [{ name: 'n' }], rows }; }
      return { columns: [{ name: 'n' }], rows };
    });
    const session = createDashboardViewerSession(makeDeps({
      document: doc({ tiles: [tile('t', 'q')] }),
      exec, queries: [query('q', 'SELECT {p:String} AS n')],
    }));
    await session.start();
    const first = session.applyFilters([{ filterId: 'p', value: 'A', active: true }]);
    await flush();
    const second = session.applyFilters([{ filterId: 'p', value: 'B', active: true }]);
    releaseFirst();
    await Promise.all([first, second]);
    // The superseded 'A' run's result is discarded; the tile reflects 'B'.
    expect(session.state.value.filters[0].value).toBe('B');
    expect(session.state.value.tiles[0].rows).toEqual([['B']]);
  });

  it('is a no-op after destroy', async () => {
    const { exec, calls } = makeExec(() => ({ columns: [{ name: 'n' }], rows: [[1]] }));
    const session = createDashboardViewerSession(makeDeps({ document: bothDoc(), exec, queries: bothQueries() }));
    await session.start();
    session.destroy();
    const base = calls.length;
    expect(await session.applyFilters([{ filterId: 'p', value: 'x', active: true }]))
      .toEqual({ ok: false, error: 'Dashboard is no longer active.' });
    expect(calls.length).toBe(base);
    expect(session.state.value.filters[0].value).toBe('');
  });
});

// #335: `waveWallNowMs` — one wall-clock snapshot per execution wave, published
// on state and threaded into every relative-token resolution the wave runs,
// fixing the prior inconsistency where one refresh took several independent
// `deps.wallNow()` snapshots.
describe('waveWallNowMs single wave snapshot (#335)', () => {
  // Two relative DateTime variables on two different tiles: with per-tile clock
  // reads (the bug) they would resolve to different instants; a single snapshot
  // per wave makes them agree.
  const splitDoc = () => doc({ tiles: [tile('one', 'qOne'), tile('two', 'qTwo')] });
  const splitQueries = () => [
    query('qOne', 'SELECT {ts1:DateTime} AS s'),
    query('qTwo', 'SELECT {ts2:DateTime} AS e'),
  ];
  const splitSeed = () => ({
    ts1: { value: 'now', active: true }, ts2: { value: 'now', active: true },
  });
  const incWall = () => {
    let n = 1_700_000_000_000;
    const calls: number[] = [];
    const wallNow = () => { n += 3_600_000; calls.push(n); return n; };
    return { wallNow, calls };
  };

  it('is null before the first wave', () => {
    const { exec } = makeExec();
    const session = createDashboardViewerSession(makeDeps({
      document: splitDoc(), exec, queries: splitQueries(), initialFilters: splitSeed(),
    }));
    expect(session.state.value.waveWallNowMs).toBeNull();
  });

  it('captures ONE snapshot per refresh; both tiles\' relative tokens resolve against the same instant, published as waveWallNowMs', async () => {
    const { exec, calls } = makeExec(() => ({ columns: [{ name: 'n' }], rows: [[1]] }));
    const { wallNow, calls: wallCalls } = incWall();
    const session = createDashboardViewerSession(makeDeps({
      document: splitDoc(), exec, queries: splitQueries(), initialFilters: splitSeed(), wallNow,
    }));
    await session.start();
    // Exactly ONE wall-clock read for the whole refresh — the fix.
    expect(wallCalls.length).toBe(1);
    expect(session.state.value.waveWallNowMs).toBe(wallCalls[0]);
    const oneCall = calls.find((c) => 'param_ts1' in c.params)!;
    const twoCall = calls.find((c) => 'param_ts2' in c.params)!;
    expect(oneCall).toBeDefined();
    expect(twoCall).toBeDefined();
    // `now` in both tiles resolved to the SAME serialized instant.
    expect(oneCall.params.param_ts1).toBe(twoCall.params.param_ts2);
  });

  it('an applyFilters wave updates waveWallNowMs to its own fresh snapshot', async () => {
    const { exec } = makeExec(() => ({ columns: [{ name: 'n' }], rows: [[1]] }));
    const { wallNow } = incWall();
    const session = createDashboardViewerSession(makeDeps({
      document: splitDoc(), exec, queries: splitQueries(), initialFilters: splitSeed(), wallNow,
    }));
    await session.start();
    const afterRefresh = session.state.value.waveWallNowMs!;
    await session.applyFilters([{ filterId: 'ts1', value: '-1h', active: true }]);
    const afterApply = session.state.value.waveWallNowMs!;
    expect(afterApply).toBeGreaterThan(afterRefresh);
  });

  it('refreshTile is a wave of one: fresh snapshot published and bound into the tile', async () => {
    const { exec, calls } = makeExec(() => ({ columns: [{ name: 'n' }], rows: [[1]] }));
    const { wallNow } = incWall();
    const session = createDashboardViewerSession(makeDeps({
      document: splitDoc(), exec, queries: splitQueries(), initialFilters: splitSeed(), wallNow,
    }));
    await session.start();
    const afterStart = session.state.value.waveWallNowMs!;
    calls.length = 0;
    await session.refreshTile('one');
    const afterTile = session.state.value.waveWallNowMs!;
    expect(afterTile).toBeGreaterThan(afterStart);
    // The refreshed tile's relative token bound against the published snapshot,
    // not a second untethered clock read.
    const run = calls.find((c) => 'param_ts1' in c.params)!;
    expect(run.params.param_ts1).toBe(String(Math.floor(afterTile / 1000)));
  });

  it('a commit shares ONE snapshot across every panel its wave reruns', async () => {
    const { exec, calls } = makeExec(() => ({ columns: [{ name: 'n' }], rows: [[1]] }));
    const { wallNow, calls: wallCalls } = incWall();
    // Both tiles declare {anchor}, so one commit reruns both — against the same
    // instant, from a single `wallNow()` read.
    const session = createDashboardViewerSession(makeDeps({
      document: doc({ tiles: [tile('t1', 'q1'), tile('t2', 'q2')] }),
      exec, wallNow,
      queries: [
        query('q1', 'SELECT {anchor:DateTime} AS a'),
        query('q2', 'SELECT {anchor:DateTime} AS b'),
      ],
    }));
    await session.start();
    const base = calls.length;
    const readsBefore = wallCalls.length;
    await session.applyFilters([{ filterId: 'anchor', value: '-1h', active: true }]);
    const added = calls.slice(base);
    expect(added.length).toBe(2);
    // One wall read for the commit (plus the batch-validation read applyFilters
    // takes before mutating anything).
    expect(wallCalls.length - readsBefore).toBe(2);
    expect(added[0].params.param_anchor).toBe(added[1].params.param_anchor);
    expect(session.state.value.waveWallNowMs).toBe(wallCalls[wallCalls.length - 1]);
  });
});

// #335: the resolver seam wired into the session — `timeRangeGroups`, computed
// ONCE at construction. #447: a group's identities are VARIABLE NAMES.
describe('timeRangeGroups resolution (#335)', () => {
  it('resolves a plain scalar date-like from/to pair into one group', () => {
    const session = createDashboardViewerSession(makeDeps({
      document: doc({ tiles: [tile('t', 'q')] }),
      queries: [query('q', 'SELECT {from:DateTime} AS f, {to:DateTime} AS t2', {
        timeRanges: [{ from: 'from', to: 'to' }],
      })],
    }));
    expect(session.timeRangeGroups.length).toBe(1);
    expect(session.timeRangeGroups[0]).toMatchObject({
      fromFilterId: 'from', toFilterId: 'to', fromParameter: 'from', toParameter: 'to',
      tileIds: ['t'],
    });
  });

  it('keeps load-time inference for legacy queries while explicit timeRanges: [] opts out', () => {
    const document = doc({ tiles: [tile('absent', 'q-absent'), tile('opted-out', 'q-empty')] });
    const session = createDashboardViewerSession(makeDeps({
      document,
      queries: [
        query('q-absent', 'SELECT {from:DateTime}, {to:DateTime}'),
        query('q-empty', 'SELECT {from:DateTime}, {to:DateTime}', { timeRanges: [] }),
      ],
    }));
    expect(session.timeRangeGroups).toEqual([
      expect.objectContaining({ fromFilterId: 'from', toFilterId: 'to', tileIds: ['absent'] }),
    ]);
    expect(session.state.value.timeRangeDiagnostics).toEqual([]);
  });

  it('does not guess between multiple legacy time-range pairs for one tile', () => {
    const session = createDashboardViewerSession(makeDeps({
      document: doc({ tiles: [tile('t', 'q')] }),
      queries: [query('q', 'SELECT {from:DateTime}, {to:DateTime}, {start:DateTime}, {end:DateTime}')],
    }));
    expect(session.timeRangeGroups).toEqual([]);
    expect(session.state.value.timeRangeDiagnostics).toEqual([]);
  });

  it('aggregates every tile declaring the same resolved variable pair into one group', () => {
    const session = createDashboardViewerSession(makeDeps({
      document: doc({ tiles: [tile('a', 'qa'), tile('b', 'qb')] }),
      queries: [
        query('qa', 'SELECT {from:DateTime}, {to:DateTime}', { timeRanges: [{ from: 'from', to: 'to' }] }),
        query('qb', 'SELECT {from:DateTime}, {to:DateTime}', { timeRanges: [{ from: 'from', to: 'to' }] }),
      ],
    }));
    expect(session.timeRangeGroups).toHaveLength(1);
    expect(session.timeRangeGroups[0]).toMatchObject({
      fromFilterId: 'from', toFilterId: 'to', tileIds: ['a', 'b'],
    });
    expect(session.state.value.timeRangeDiagnostics).toEqual([]);
  });

  // The session keeps TWO separate declaration analyses on purpose: `analysis`
  // blanks text tiles (controls + execution), while `timeRangeAnalysis` includes
  // EVERY tile, so range membership spans panel families the viewer never runs.
  it('keeps a non-executing Text tile in group membership using its saved SQL contract', () => {
    const session = createDashboardViewerSession(makeDeps({
      document: doc({ tiles: [tile('chart', 'qc'), tile('text', 'qt')] }),
      queries: [
        query('qc', 'SELECT {from:DateTime}, {to:DateTime}', { timeRanges: [{ from: 'from', to: 'to' }] }),
        query('qt', 'SELECT {from:DateTime}, {to:DateTime}', {
          timeRanges: [{ from: 'from', to: 'to' }], panel: { cfg: { type: 'text', content: 'note' } },
        }),
      ],
    }));
    expect(session.timeRangeGroups[0].tileIds).toEqual(['chart', 'text']);
  });

  it('diagnoses unresolved authored metadata without partially forming a group', () => {
    const session = createDashboardViewerSession(makeDeps({
      document: doc({ tiles: [tile('t', 'q')] }),
      // The authored metadata names a parameter no panel query declares, so it
      // resolves to no Dashboard variable at all.
      queries: [query('q', 'SELECT {from:DateTime}', {
        timeRanges: [{ from: 'from', to: 'to' }],
      })],
    }));
    expect(session.timeRangeGroups).toEqual([]);
    expect(session.state.value.timeRangeDiagnostics).toEqual([
      expect.objectContaining({
        code: 'time-range-filter-unresolved', resource: 't',
        path: ['dashboard', 'tiles', 0, 'queryId'],
      }),
    ]);
  });

  it('does not group a conflicted variable — it has no agreed type to bound', () => {
    const session = createDashboardViewerSession(makeDeps({
      document: doc({ tiles: [tile('a', 'qa'), tile('b', 'qb')] }),
      queries: [
        query('qa', 'SELECT {from:DateTime}, {to:DateTime}', { timeRanges: [{ from: 'from', to: 'to' }] }),
        query('qb', 'SELECT {from:String}'),
      ],
    }));
    expect(session.timeRangeGroups).toEqual([]);
  });

  it('does not group a non-date-like pair', () => {
    const session = createDashboardViewerSession(makeDeps({
      document: doc({ tiles: [tile('t', 'q')] }),
      queries: [query('q', 'SELECT {from:String} AS f, {to:String} AS t2', {
        timeRanges: [{ from: 'from', to: 'to' }],
      })],
    }));
    expect(session.timeRangeGroups).toEqual([]);
  });

  it('is computed once at construction and not recomputed by a variable commit', async () => {
    const { exec } = makeExec(() => ({ columns: [{ name: 'n' }], rows: [[1]] }));
    const session = createDashboardViewerSession(makeDeps({
      document: doc({ tiles: [tile('t', 'q')] }),
      exec, queries: [query('q', 'SELECT {from:DateTime} AS f, {to:DateTime} AS t2', {
        timeRanges: [{ from: 'from', to: 'to' }],
      })],
    }));
    await session.start();
    const groups = session.timeRangeGroups;
    await session.applyFilters([{ filterId: 'from', value: '-1d', active: true }]);
    expect(session.timeRangeGroups).toBe(groups); // same reference — never recomputed
  });
});

// #447 phase 2: the batched option query. Every configured variable on the
// Dashboard is compiled into ONE `UNION ALL` request per refresh; its rows are
// read POSITIONALLY and partitioned back by exact variable name. The pure
// compiler/reader are covered in variable-options.test.ts — these assert the
// SESSION's wiring: when the request is issued, what it carries, what it does to
// each variable's runtime, and what a failure does.
describe('batched option execution (#447 phase 2)', () => {
  /** The rows the compiled batch would return for `[name, value, label]` triples. */
  const optionRows = (...triples: [string, string, string][]) => ({
    columns: [
      { name: '__variable_name', type: 'String' },
      { name: 'v', type: 'String' },
      { name: 'l', type: 'String' },
    ],
    rows: triples as unknown[][],
  });

  const isOptionCall = (sql: string): boolean => sql.includes('__variable_name');

  /** A session whose panel declares `country` + `city`, configured per `configs`. */
  function optionSession(
    configs: Record<string, { sql: string }>,
    responder: Responder,
    panelSql = 'SELECT 1 WHERE c = {country:String} AND t = {city:String}',
  ) {
    const { exec, calls } = makeExec(responder);
    const session = createDashboardViewerSession(makeDeps({
      document: doc({ tiles: [tile('t1', 'q1')], variableConfigs: configs }),
      exec,
      queries: [query('q1', panelSql)],
    }));
    return { session, calls, optionCalls: () => calls.filter((c) => isOptionCall(c.sql)) };
  }

  it('issues ONE request for two configured variables, in Variables order', async () => {
    const { session, optionCalls } = optionSession(
      { country: { sql: 'SELECT a, b FROM countries' }, city: { sql: 'SELECT a, b FROM cities' } },
      (sql) => (isOptionCall(sql)
        ? optionRows(['country', 'de', 'Germany'], ['city', 'ber', 'Berlin'])
        : { columns: [{ name: 'n' }], rows: [[1]] }),
    );
    await session.start();
    const calls = optionCalls();
    expect(calls).toHaveLength(1);
    const branch = (name: string, sql: string): string =>
      `SELECT '${name}' AS __variable_name,\n`
      + '       tupleElement(tuple(*), 1) AS __variable_value,\n'
      + '       tupleElement(tuple(*), 2) AS __variable_label\n'
      + `FROM (\n${sql}\n) LIMIT 1001`;
    expect(calls[0].sql).toBe(
      `${branch('country', 'SELECT a, b FROM countries')}\nUNION ALL\n${branch('city', 'SELECT a, b FROM cities')}`,
    );
    // The ordinary streaming transport: positional access is done in SQL, so no
    // special wire format is needed (and none is available before ClickHouse 25.2).
    expect(calls[0].format).toBe('Table');
    expect(calls[0].params.readonly).toBe(2);
    expect(calls[0].params.max_result_bytes).toBe(10_000_000);
  });

  it('partitions the response by exact name onto each variable, and marks them ready', async () => {
    const { session } = optionSession(
      { country: { sql: 'SELECT a, b FROM countries' }, city: { sql: 'SELECT a, b FROM cities' } },
      (sql) => (isOptionCall(sql)
        ? optionRows(['city', 'ber', 'Berlin'], ['country', 'de', 'Germany'], ['country', 'fr', 'France'])
        : { columns: [{ name: 'n' }], rows: [[1]] }),
    );
    await session.start();
    const byId = new Map(session.state.value.filters.map((f) => [f.id, f]));
    expect(byId.get('country')!.options).toEqual([
      { value: 'de', label: 'Germany' }, { value: 'fr', label: 'France' },
    ]);
    expect(byId.get('city')!.options).toEqual([{ value: 'ber', label: 'Berlin' }]);
    expect(byId.get('country')!.status).toBe('ready');
    expect(byId.get('city')!.status).toBe('ready');
    expect(session.state.value.filterDiagnostics).toEqual([]);
  });

  it('issues NO request when no variable is configured', async () => {
    const { session, optionCalls, calls } = optionSession({}, () => ({ columns: [{ name: 'n' }], rows: [[1]] }));
    await session.start();
    expect(optionCalls()).toHaveLength(0);
    // Nothing at all was sent: no options plan exists, and the panel's two
    // required variables are unset so the tile waits rather than executing.
    expect(calls).toHaveLength(0);
    expect(session.state.value.tiles[0].status).toBe('unfilled');
    for (const filter of session.state.value.filters) {
      expect(filter.configured).toBe(false);
      expect(filter.status).toBe('idle');
      expect(filter.options).toBeNull();
    }
  });

  it('issues no request for a locally-rejected variable, but still SAYS so on its control', async () => {
    // A parameterised option query never reaches the server: no cascading. It must
    // not quietly become a direct-input text box either — that is indistinguishable
    // from never having been configured, so the stored SQL would be silently
    // ignored with nothing anywhere explaining why.
    const { session, optionCalls } = optionSession(
      { country: { sql: 'SELECT a, b FROM t WHERE x = {city:String}' } },
      () => ({ columns: [{ name: 'n' }], rows: [[1]] }),
    );
    await session.start();
    expect(optionCalls()).toHaveLength(0);
    const country = session.state.value.filters.find((f) => f.id === 'country')!;
    expect(country.configured).toBe(true);
    expect(country.status).toBe('error');
    expect(country.optionsError).toBe('Variable option queries cannot reference Dashboard variables yet.');
    expect(country.options).toBeNull();
    // Per-variable, NOT a Dashboard-wide banner: no batch ran, so nothing failed
    // at batch level.
    expect(session.state.value.filterDiagnostics).toEqual([]);
  });

  it('reports every local problem with the SQL on the control at once', async () => {
    const { session } = optionSession(
      { country: { sql: 'SHOW TABLES FORMAT JSON' } },
      () => ({ columns: [{ name: 'n' }], rows: [[1]] }),
    );
    await session.start();
    const error = session.state.value.filters.find((f) => f.id === 'country')!.optionsError!;
    expect(error).toContain('must be a SELECT');
    expect(error).toContain('FORMAT');
  });

  it('keeps a locally-rejected variable OUT of a batch that other variables still run', async () => {
    const { session, optionCalls } = optionSession(
      {
        country: { sql: 'SELECT a, b FROM countries' },
        city: { sql: 'SELECT a, b FROM t; SELECT 1, 2' },
      },
      (sql) => (isOptionCall(sql)
        ? optionRows(['country', 'de', 'Germany'])
        : { columns: [{ name: 'n' }], rows: [[1]] }),
    );
    await session.start();
    // One branch only, and the healthy variable is unaffected by the broken one.
    expect(optionCalls()[0].sql).not.toContain('UNION ALL');
    const byId = new Map(session.state.value.filters.map((f) => [f.id, f]));
    expect(byId.get('country')!.status).toBe('ready');
    expect(byId.get('country')!.optionsError).toBeNull();
    expect(byId.get('city')!.status).toBe('error');
    expect(byId.get('city')!.optionsError).toContain('one statement');
  });

  it('a batch failure does not overwrite a locally-rejected variable\'s own reason', async () => {
    const { session } = optionSession(
      {
        country: { sql: 'SELECT a, b FROM countries' },
        city: { sql: 'SELECT a, b FROM t WHERE x = {country:String}' },
      },
      (sql) => (isOptionCall(sql) ? { error: 'boom' } : { columns: [{ name: 'n' }], rows: [[1]] }),
    );
    await session.start();
    const byId = new Map(session.state.value.filters.map((f) => [f.id, f]));
    expect(byId.get('country')!.optionsError).toContain('boom');
    // Replacing this with the batch message would be both vaguer and untrue: this
    // variable was never in the batch.
    expect(byId.get('city')!.optionsError).toBe('Variable option queries cannot reference Dashboard variables yet.');
  });

  it('rejects an optional block in option SQL, which could never activate', async () => {
    const { session, optionCalls } = optionSession(
      { country: { sql: 'SELECT a, b FROM t /*[ WHERE x = 1 ]*/' } },
      () => ({ columns: [{ name: 'n' }], rows: [[1]] }),
    );
    await session.start();
    expect(optionCalls()).toHaveLength(0);
    expect(session.state.value.filters.find((f) => f.id === 'country')!.optionsError)
      .toContain('optional /*[');
  });

  it('names the diagnostic path in a transport failure, not just a raw server error', async () => {
    const { session } = optionSession(
      { country: { sql: 'SELECT a, b FROM countries' } },
      (sql) => (isOptionCall(sql) ? { error: 'Code: 47.' } : { columns: [{ name: 'n' }], rows: [[1]] }),
    );
    await session.start();
    expect(session.state.value.filterDiagnostics[0].message).toContain('Test');
  });

  it('warns when a variable\'s option list was truncated at the cap', async () => {
    const rows: [string, string, string][] = [];
    for (let i = 0; i < 1005; i++) rows.push(['country', `v${i}`, `L${i}`]);
    const { session } = optionSession(
      { country: { sql: 'SELECT a, b FROM countries' } },
      (sql) => (isOptionCall(sql) ? optionRows(...rows) : { columns: [{ name: 'n' }], rows: [[1]] }),
    );
    await session.start();
    const diagnostics = session.state.value.filterDiagnostics;
    expect(diagnostics).toHaveLength(1);
    // A warning, not an error: the options it DID return are usable — the only
    // dishonest option is letting a truncated list look complete.
    expect(diagnostics[0].severity).toBe('warning');
    expect(diagnostics[0].message).toContain('country');
    expect(session.state.value.filters[0].status).toBe('ready');
    expect(session.state.value.filters[0].options).toHaveLength(1000);
  });

  it('excludes conflicted and orphaned variables from the batch', async () => {
    const { exec, calls } = makeExec((sql) => (isOptionCall(sql)
      ? optionRows(['ok', 'x', 'X'])
      : { columns: [{ name: 'n' }], rows: [[1]] }));
    const session = createDashboardViewerSession(makeDeps({
      document: doc({
        tiles: [tile('t1', 'q1'), tile('t2', 'q2')],
        variableConfigs: {
          ok: { sql: 'SELECT a, b FROM good' },
          clash: { sql: 'SELECT a, b FROM conflicted' },
          gone: { sql: 'SELECT a, b FROM orphan', lastKnownType: 'String' },
        },
      }),
      exec,
      queries: [
        query('q1', 'SELECT {ok:String} AS o, {clash:UInt64} AS c'),
        query('q2', 'SELECT {clash:String} AS c'),
      ],
    }));
    await session.start();
    const optionSql = calls.filter((c) => isOptionCall(c.sql))[0].sql;
    expect(optionSql).toContain("'ok'");
    // A conflicted name has no agreed type and an orphan has no declaration, so
    // neither can be bound into a panel — running their option SQL would be work
    // for a control that is never rendered.
    expect(optionSql).not.toContain("'clash'");
    expect(optionSql).not.toContain("'gone'");
    expect(optionSql).not.toContain('UNION ALL');
  });

  it('never auto-selects the first option — a configured variable starts unset', async () => {
    const { session } = optionSession(
      { country: { sql: 'SELECT a, b FROM countries' } },
      (sql) => (isOptionCall(sql)
        ? optionRows(['country', 'de', 'Germany'], ['country', 'fr', 'France'])
        : { columns: [{ name: 'n' }], rows: [[1]] }),
    );
    await session.start();
    const country = session.state.value.filters.find((f) => f.id === 'country')!;
    expect(country.options).toHaveLength(2);
    expect(country.value).toBe('');
    expect(country.active).toBe(false);
    expect(session.state.value.activeFilterCount).toBe(0);
  });

  it('leaves a panel WAITING while its required variable is unset, then runs it on commit', async () => {
    const { session, calls } = optionSession(
      { country: { sql: 'SELECT a, b FROM countries' } },
      (sql) => (isOptionCall(sql)
        ? optionRows(['country', 'de', 'Germany'])
        : { columns: [{ name: 'n' }], rows: [[1]] }),
      'SELECT 1 WHERE c = {country:String}',
    );
    await session.start();
    const tileState = () => session.state.value.tiles[0];
    expect(tileState().status).toBe('unfilled');
    expect(tileState().unfilled).toEqual(['country']);
    expect(calls.filter((c) => !isOptionCall(c.sql))).toHaveLength(0);
    await session.applyFilter('country', 'de', true);
    expect(tileState().status).toBe('ready');
  });

  it('does NOT re-run the batch when a value is committed', async () => {
    // Option SQL cannot reference a variable, so no selection can change what any
    // option query returns — that is what keeps this one request, not a graph.
    const { session, optionCalls } = optionSession(
      { country: { sql: 'SELECT a, b FROM countries' } },
      (sql) => (isOptionCall(sql)
        ? optionRows(['country', 'de', 'Germany'])
        : { columns: [{ name: 'n' }], rows: [[1]] }),
    );
    await session.start();
    expect(optionCalls()).toHaveLength(1);
    await session.applyFilter('country', 'de', true);
    await session.setFilter('country', 'fr');
    await session.clearFilter('country');
    await session.clearAllFilters();
    expect(optionCalls()).toHaveLength(1);
  });

  it('re-runs the batch on an explicit refresh, bumping optionsRev only on real change', async () => {
    let call = 0;
    const { session, optionCalls } = optionSession(
      { country: { sql: 'SELECT a, b FROM countries' } },
      (sql) => {
        if (!isOptionCall(sql)) return { columns: [{ name: 'n' }], rows: [[1]] };
        call++;
        // Same content twice, then DIFFERENT content of the same length — the
        // case a length-only or emptiness-only signature would miss.
        return call === 3
          ? optionRows(['country', 'es', 'Spain'])
          : optionRows(['country', 'de', 'Germany']);
      },
    );
    await session.start();
    const rev1 = session.state.value.filters[0].optionsRev;
    expect(rev1).toBe(1);
    await session.refresh();
    expect(session.state.value.filters[0].optionsRev).toBe(rev1); // unchanged content
    await session.refresh();
    expect(session.state.value.filters[0].optionsRev).toBe(rev1 + 1);
    expect(optionCalls()).toHaveLength(3);
  });

  it('reports a transport failure as a BATCH-level diagnostic and makes the controls unavailable', async () => {
    const { session } = optionSession(
      { country: { sql: 'SELECT a, b FROM countries' }, city: { sql: 'SELECT a, b FROM cities' } },
      (sql) => (isOptionCall(sql)
        ? { error: 'Code: 47. Unknown expression identifier' }
        : { columns: [{ name: 'n' }], rows: [[1]] }),
    );
    await session.start();
    const state = session.state.value;
    expect(state.filterDiagnostics).toEqual([{
      severity: 'error',
      code: 'variable-options-batch-failed',
      message: 'Variable options could not be loaded: Code: 47. Unknown expression identifier '
        + '— use Test in a variable\u2019s editor to find the option SQL at fault.',
    }]);
    // Every option-backed control goes unavailable together — there is no
    // automatic fall-back to N separate per-variable queries in this issue.
    for (const filter of state.filters) expect(filter.status).toBe('error');
    // The tiles themselves still ran: an options failure is not a tile failure.
    expect(state.tiles[0].status).not.toBe('error');
    expect(state.lastRefreshOutcome).toBe('success');
  });

  it('reports a wrong-shape response as a batch-level diagnostic naming how to narrow it', async () => {
    const { session } = optionSession(
      { country: { sql: 'SELECT a FROM countries' } },
      (sql) => (isOptionCall(sql)
        // One-column user SQL → the merged result is 2 columns, not 3.
        ? { columns: [{ name: '__variable_name', type: 'String' }, { name: 'a', type: 'String' }], rows: [['country', 'de']] }
        : { columns: [{ name: 'n' }], rows: [[1]] }),
    );
    await session.start();
    const diagnostics = session.state.value.filterDiagnostics;
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].code).toBe('variable-option-batch-shape');
    // #457: a merged UNION ALL cannot say WHICH branch is wrong, so the message
    // has to name the way to find out. It used to name the drawer's Test button;
    // that drawer is gone, and it now points at running one variable on its own.
    expect(diagnostics[0].message).toContain('run its SQL on its own');
    expect(session.state.value.filters[0].status).toBe('error');
  });

  it('keeps a committed value through a batch failure', async () => {
    // A restored selection (#303) is still bound into every panel that declares
    // the name; discarding it because a LIST failed to load would silently change
    // what the panels show.
    const { exec } = makeExec((sql) => (isOptionCall(sql)
      ? { error: 'boom' }
      : { columns: [{ name: 'n' }], rows: [[1]] }));
    const session = createDashboardViewerSession(makeDeps({
      document: doc({ tiles: [tile('t1', 'q1')], variableConfigs: { country: { sql: 'SELECT a, b FROM t' } } }),
      exec,
      queries: [query('q1', 'SELECT 1 WHERE c = {country:String}')],
      initialFilters: { country: { value: 'de', active: true } },
    }));
    await session.start();
    const country = session.state.value.filters[0];
    expect(country.value).toBe('de');
    expect(country.active).toBe(true);
    expect(country.status).toBe('error');
  });

  it('recovers on the next refresh after a failure', async () => {
    let failed = false;
    const { session } = optionSession(
      { country: { sql: 'SELECT a, b FROM countries' } },
      (sql) => {
        if (!isOptionCall(sql)) return { columns: [{ name: 'n' }], rows: [[1]] };
        if (!failed) { failed = true; return { error: 'boom' }; }
        return optionRows(['country', 'de', 'Germany']);
      },
    );
    await session.start();
    expect(session.state.value.filterDiagnostics).toHaveLength(1);
    await session.refresh();
    // Replaced wholesale, never appended to — a failure must not outlive the
    // wave that hit it.
    expect(session.state.value.filterDiagnostics).toEqual([]);
    expect(session.state.value.filters[0].status).toBe('ready');
    expect(session.state.value.filters[0].options).toEqual([{ value: 'de', label: 'Germany' }]);
  });

  it('gives a configured variable whose query returned nothing an empty list, not an error', async () => {
    const { session } = optionSession(
      { country: { sql: 'SELECT a, b FROM countries' } },
      (sql) => (isOptionCall(sql) ? optionRows() : { columns: [{ name: 'n' }], rows: [[1]] }),
    );
    await session.start();
    expect(session.state.value.filters[0].options).toEqual([]);
    expect(session.state.value.filters[0].status).toBe('ready');
    expect(session.state.value.filterDiagnostics).toEqual([]);
  });

  // An `Array(scalar T)` variable binds a SELECTION: several option rows combine
  // into one array, which `param-serialize` turns into a ClickHouse literal.
  describe('Array(scalar T) variables bind a selection', () => {
    const MULTI_SQL = 'SELECT 1 WHERE u IN {user:Array(String)}';
    /** A session whose one panel declares `user : Array(String)`. */
    const multiSession = (responder: Responder, initialFilters?: Record<string, { value: unknown; active: boolean }>) => {
      const { exec, calls } = makeExec(responder);
      const session = createDashboardViewerSession(makeDeps({
        document: doc({ tiles: [tile('t1', 'q1')], variableConfigs: { user: { sql: 'SELECT a, b FROM users' } } }),
        exec,
        queries: [query('q1', MULTI_SQL)],
        ...(initialFilters ? { initialFilters } : {}),
      }));
      return { session, calls, optionCalls: () => calls.filter((c) => isOptionCall(c.sql)) };
    };
    const usersRespond = (...triples: [string, string, string][]): Responder =>
      (sql) => (isOptionCall(sql) ? optionRows(...triples) : { columns: [{ name: 'n' }], rows: [[1]] });

    it('runs its option SQL and offers the list — it is no longer excluded as a container', async () => {
      const { session, optionCalls } = multiSession(usersRespond(['user', 'ada', 'Ada'], ['user', 'bo', 'Bo']));
      await session.start();
      expect(optionCalls()).toHaveLength(1);
      const f = session.state.value.filters[0];
      expect(f.configured).toBe(true);
      expect(f.status).toBe('ready');
      expect(f.optionsError).toBeNull();
      expect(f.options).toEqual([{ value: 'ada', label: 'Ada' }, { value: 'bo', label: 'Bo' }]);
    });

    it('binds a committed selection as a real ClickHouse array literal', async () => {
      const { session, calls } = multiSession(usersRespond(['user', 'ada', 'Ada'], ['user', 'bo', 'Bo']));
      await session.start();
      await session.applyFilter('user', ['ada', 'bo'], true);
      const tileCall = calls.filter((c) => !isOptionCall(c.sql)).at(-1)!;
      // Escaped and bracketed by the shared typed serializer — never joined.
      expect(tileCall.params?.param_user).toBe("['ada','bo']");
      expect(session.state.value.filters[0].value).toEqual(['ada', 'bo']);
      expect(session.state.value.filters[0].active).toBe(true);
    });

    it('reduces an EMPTY selection to unset rather than binding a literal []', async () => {
      // A present `[]` is a real value to `emptyValue()`, so binding it would run
      // every panel as `IN []` — nothing returned, but LOOKING filtered — where
      // an unset variable's panels must wait instead.
      const { session } = multiSession(usersRespond(['user', 'ada', 'Ada']));
      await session.start();
      await session.applyFilter('user', [], false);
      expect(session.state.value.filters[0].value).toBe('');
      expect(session.state.value.filters[0].active).toBe(false);
    });

    it('setFilter derives activation from the selection length', async () => {
      const { session } = multiSession(usersRespond(['user', 'ada', 'Ada']));
      await session.start();
      await session.setFilter('user', ['ada']);
      expect(session.state.value.filters[0].active).toBe(true);
      await session.setFilter('user', []);
      expect(session.state.value.filters[0].value).toBe('');
      expect(session.state.value.filters[0].active).toBe(false);
    });

    it('copies a committed selection, so a caller cannot mutate bound state', async () => {
      const { session } = multiSession(usersRespond(['user', 'ada', 'Ada']));
      await session.start();
      const mine = ['ada'];
      await session.applyFilter('user', mine, true);
      mine.push('bo');
      expect(session.state.value.filters[0].value).toEqual(['ada']);
    });

    it('restores a persisted selection, and derives its activation from it', async () => {
      const { session } = multiSession(
        usersRespond(['user', 'ada', 'Ada'], ['user', 'bo', 'Bo']),
        { user: { value: ['ada', 'bo'], active: true } },
      );
      await session.start();
      expect(session.state.value.filters[0].value).toEqual(['ada', 'bo']);
      expect(session.state.value.filters[0].active).toBe(true);
    });

    it('degrades a persisted SCALAR seed on a selection variable to unset', async () => {
      // The wrong shape would reach the serializer as a `structural` error and
      // block every panel declaring the name.
      const { session } = multiSession(
        usersRespond(['user', 'ada', 'Ada']),
        { user: { value: 'ada', active: true } },
      );
      await session.start();
      expect(session.state.value.filters[0].value).toBe('');
      expect(session.state.value.filters[0].active).toBe(false);
    });

    it('leaves a surviving selection completely alone when only the option ORDER changed', async () => {
      let call = 0;
      const { session, calls } = multiSession((sql) => {
        if (!isOptionCall(sql)) return { columns: [{ name: 'n' }], rows: [[1]] };
        call++;
        // Same members, new ORDER.
        return call === 1
          ? optionRows(['user', 'ada', 'Ada'], ['user', 'bo', 'Bo'])
          : optionRows(['user', 'bo', 'Bo'], ['user', 'ada', 'Ada']);
      });
      await session.start();
      await session.applyFilter('user', ['ada', 'bo'], true);
      const before = calls.filter((c) => !isOptionCall(c.sql)).length;
      await session.refresh();
      // The bound literal is UNCHANGED. Adopting the new option order would make
      // the persisted value differ from the one that produced the results on
      // screen — silently, since this path deliberately runs no wave.
      expect(session.state.value.filters[0].value).toEqual(['ada', 'bo']);
      expect(session.state.value.filters[0].active).toBe(true);
      // One refresh wave for the tile, and no EXTRA reconciliation wave.
      expect(calls.filter((c) => !isOptionCall(c.sql)).length).toBe(before + 1);
    });

    it('never prunes a selection against a list the server CUT OFF at the cap', async () => {
      // A value can simply live past row 1,000. Pruning against a truncated list
      // would delete a valid selection, re-run the panels, and persist the
      // shortened array — the single-select keeps an off-list value verbatim, and
      // a selection gets the same benefit of the doubt. The warning still fires.
      const capped = (extra: [string, string, string][]) => {
        const rows: [string, string, string][] = [];
        for (let i = 0; i < VARIABLE_OPTION_CAP + 1; i++) rows.push(['user', `u${i}`, `U${i}`]);
        return optionRows(...rows, ...extra);
      };
      const { session, calls } = multiSession(
        (sql) => (isOptionCall(sql) ? capped([]) : { columns: [{ name: 'n' }], rows: [[1]] }),
        { user: { value: ['way-past-the-cap'], active: true } },
      );
      await session.start();
      const before = calls.filter((c) => !isOptionCall(c.sql)).length;
      await session.refresh();
      expect(session.state.value.filters[0].value).toEqual(['way-past-the-cap']);
      expect(session.state.value.filters[0].active).toBe(true);
      // No reconciliation wave — nothing was decided about the selection.
      expect(calls.filter((c) => !isOptionCall(c.sql)).length).toBe(before + 1);
      // The incompleteness is reported, not hidden.
      expect(session.state.value.filterDiagnostics.map((d) => d.code))
        .toContain('variable-options-truncated');
      // And PUBLISHED per variable, so the control can apply the same rule — the
      // session's preservation is undone if the control's Apply then
      // canonicalizes the off-list value away against the same partial list.
      expect(session.state.value.filters[0].optionsTruncated).toBe(true);
    });

    it('publishes optionsTruncated false for a complete list', async () => {
      const { session } = multiSession(usersRespond(['user', 'ada', 'Ada']));
      await session.start();
      expect(session.state.value.filters[0].optionsTruncated).toBe(false);
    });

    it('drops a selected value the refresh removed, and re-runs the affected panels ONCE', async () => {
      let call = 0;
      const { session, calls } = multiSession((sql) => {
        if (!isOptionCall(sql)) return { columns: [{ name: 'n' }], rows: [[1]] };
        call++;
        return call === 1
          ? optionRows(['user', 'ada', 'Ada'], ['user', 'bo', 'Bo'])
          : optionRows(['user', 'ada', 'Ada']);
      });
      await session.start();
      await session.applyFilter('user', ['ada', 'bo'], true);
      const before = calls.filter((c) => !isOptionCall(c.sql)).length;
      await session.refresh();
      expect(session.state.value.filters[0].value).toEqual(['ada']);
      expect(session.state.value.filters[0].active).toBe(true);
      // The refresh's own wave PLUS exactly one reconciled wave.
      expect(calls.filter((c) => !isOptionCall(c.sql)).length).toBe(before + 2);
    });

    it('deactivates when EVERY selected value disappeared', async () => {
      let call = 0;
      const { session } = multiSession((sql) => {
        if (!isOptionCall(sql)) return { columns: [{ name: 'n' }], rows: [[1]] };
        call++;
        return call === 1 ? optionRows(['user', 'ada', 'Ada']) : optionRows(['user', 'zed', 'Zed']);
      });
      await session.start();
      await session.applyFilter('user', ['ada'], true);
      await session.refresh();
      expect(session.state.value.filters[0].value).toBe('');
      expect(session.state.value.filters[0].active).toBe(false);
    });

    it('never reconciles a SCALAR variable off its committed value', async () => {
      // A scalar's off-list value is shown verbatim and stays bound — an option
      // refresh does not get to silently drop what the panels are already using.
      let call = 0;
      const { session } = optionSession(
        { country: { sql: 'SELECT a, b FROM countries' } },
        (sql) => {
          if (!isOptionCall(sql)) return { columns: [{ name: 'n' }], rows: [[1]] };
          call++;
          return call === 1 ? optionRows(['country', 'de', 'Germany']) : optionRows(['country', 'fr', 'France']);
        },
      );
      await session.start();
      await session.applyFilter('country', 'de', true);
      await session.refresh();
      expect(session.state.value.filters[0].value).toBe('de');
      expect(session.state.value.filters[0].active).toBe(true);
    });
  });

  it('explains a configured variable whose TYPE has no option list', async () => {
    // A `Map`/`Tuple`/`Nested`/nested-`Array` variable someone configured anyway:
    // its SQL is fine, but nothing can render a list for it, so it is kept out of
    // the batch and its control says the configuration is deliberately not running.
    const { session, optionCalls } = optionSession(
      { tags: { sql: 'SELECT a, b FROM t' } },
      (sql) => (isOptionCall(sql) ? optionRows() : { columns: [{ name: 'n' }], rows: [[1]] }),
      'SELECT 1 WHERE m = {tags:Map(String, String)}',
    );
    await session.start();
    expect(optionCalls()).toHaveLength(0);
    const f = session.state.value.filters.find((x) => x.parameter === 'tags')!;
    expect(f.status).toBe('error');
    expect(f.optionsError).toContain('no option list');
  });

  it('does not re-run the batch for a single-tile refresh', async () => {
    const { session, optionCalls } = optionSession(
      { country: { sql: 'SELECT a, b FROM countries' } },
      (sql) => (isOptionCall(sql)
        ? optionRows(['country', 'de', 'Germany'])
        : { columns: [{ name: 'n' }], rows: [[1]] }),
    );
    await session.start();
    await session.refreshTile('t1');
    expect(optionCalls()).toHaveLength(1);
  });

  it('issues no options request at all when the session is destroyed before its preflight', async () => {
    const { session, optionCalls } = optionSession(
      { country: { sql: 'SELECT a, b FROM countries' } },
      (sql) => (isOptionCall(sql)
        ? optionRows(['country', 'de', 'Germany'])
        : { columns: [{ name: 'n' }], rows: [[1]] }),
    );
    const started = session.start();
    session.destroy(); // lands while the token preflight is still pending
    await started;
    await flush();
    expect(optionCalls()).toHaveLength(0);
    expect(session.state.value.filters[0].options).toBeNull();
  });

  it('drops an IN-FLIGHT options response that a destroy superseded', async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { session, optionCalls } = optionSession(
      { country: { sql: 'SELECT a, b FROM countries' } },
      async (sql) => {
        if (!isOptionCall(sql)) return { columns: [{ name: 'n' }], rows: [[1]] };
        await gate;
        return optionRows(['country', 'de', 'Germany']);
      },
    );
    const started = session.start();
    // Get PAST the preflight, so the request is genuinely in flight — without this
    // the destroy short-circuits `refresh()` before the batch is ever issued, and
    // the assertion below would hold for the wrong reason.
    await flush();
    expect(optionCalls()).toHaveLength(1);
    session.destroy();
    release!();
    await started;
    await flush();
    // The response arrived after teardown and was discarded.
    expect(session.state.value.filters[0].options).toBeNull();
    expect(session.state.value.filters[0].status).toBe('loading');
  });

  it('drops an in-flight options response that a LATER refresh superseded', async () => {
    let call = 0;
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { session } = optionSession(
      { country: { sql: 'SELECT a, b FROM countries' } },
      async (sql) => {
        if (!isOptionCall(sql)) return { columns: [{ name: 'n' }], rows: [[1]] };
        call++;
        if (call === 1) { await gate; return optionRows(['country', 'stale', 'Stale']); }
        return optionRows(['country', 'fresh', 'Fresh']);
      },
    );
    const first = session.start();
    await flush();
    // A second wave overtakes the first and completes.
    await session.refresh();
    expect(session.state.value.filters[0].options).toEqual([{ value: 'fresh', label: 'Fresh' }]);
    // Now let the stale one answer: it must not overwrite the newer options.
    release!();
    await first;
    await flush();
    expect(session.state.value.filters[0].options).toEqual([{ value: 'fresh', label: 'Fresh' }]);
  });
});
