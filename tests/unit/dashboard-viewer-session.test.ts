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
    expect(session.state.value.filters[0].status).toBe('source-error');
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
    expect(session.state.value.filters[0].status).toBe('source-error');
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

// #359: the filter-source runtime split — N filter DEFINITIONS sharing one
// `sourceQueryId` share exactly ONE `FilterSourceRuntime`, so the source SQL
// executes once per wave no matter how many parameters it feeds. Before this
// fix, `runFilterWave` ran the shared source once PER DEFINITION and keyed
// each provider by the definition id, so `mergeDashboardFilterHelpers`
// rejected every helper as a duplicate provider and every field went empty.
describe('shared filter-source runtime (#359)', () => {
  const sharedDoc = (filters: DashboardFilterDefinitionV1[], tiles: DashboardTileV1[] = []) => doc({ tiles, filters });

  it('runs a source shared by two definitions exactly once; both fields populate', async () => {
    const { exec, calls } = makeExec((sql) => (sql.includes('shared')
      ? { columns: [{ name: 'p1', type: 'Array(String)' }, { name: 'p2', type: 'Array(String)' }], rows: [[['V1', 'V2'], ['W1']]] }
      : { columns: [{ name: 'n' }], rows: [[1]] }));
    const document = sharedDoc(
      [{ id: 'f1', parameter: 'p1', sourceQueryId: 'src' }, { id: 'f2', parameter: 'p2', sourceQueryId: 'src' }],
      [tile('ta', 'qa'), tile('tb', 'qb')],
    );
    const session = createDashboardViewerSession(makeDeps({
      document, exec,
      queries: [
        query('qa', 'SELECT {p1:String} AS n'), query('qb', 'SELECT {p2:String} AS n'),
        query('src', "SELECT ['V1','V2'] AS p1, ['W1'] AS p2 /* shared */", { dashboard: { role: 'filter' } }),
      ],
    }));
    await session.start();
    expect(calls.filter((c) => c.sql.includes('shared')).length).toBe(1); // ONE execution, not two.
    const f1 = session.state.value.filters.find((f) => f.id === 'f1')!;
    const f2 = session.state.value.filters.find((f) => f.id === 'f2')!;
    expect(f1).toMatchObject({ status: 'ready', options: [{ value: 'V1', label: 'V1' }, { value: 'V2', label: 'V2' }] });
    expect(f2).toMatchObject({ status: 'ready', options: [{ value: 'W1', label: 'W1' }] });
  });

  it('keys the merge by the SOURCE query id, not the definition id — two distinct sources sharing a helper name still collide, no winner', async () => {
    const { exec } = makeExec((sql) => {
      if (sql.includes('srcA')) return { columns: [{ name: 'dup', type: 'Array(String)' }], rows: [[['A1']]] };
      if (sql.includes('srcB')) return { columns: [{ name: 'dup', type: 'Array(String)' }], rows: [[['B1']]] };
      return { columns: [{ name: 'n' }], rows: [[1]] };
    });
    const document = sharedDoc(
      [{ id: 'f1', parameter: 'dup', sourceQueryId: 'srcA' }, { id: 'f2', parameter: 'dup', sourceQueryId: 'srcB' }],
      [tile('t', 'qt')],
    );
    const session = createDashboardViewerSession(makeDeps({
      document, exec,
      queries: [
        query('qt', 'SELECT {dup:String} AS n'),
        query('srcA', "SELECT ['A1'] AS dup /* srcA */", { dashboard: { role: 'filter' } }),
        query('srcB', "SELECT ['B1'] AS dup /* srcB */", { dashboard: { role: 'filter' } }),
      ],
    }));
    await session.start();
    expect(session.state.value.filters.every((f) => f.status === 'helper-error')).toBe(true);
    // The diagnostic message names the SOURCE ids ('srcA'/'srcB'), never the
    // filter definition ids ('f1'/'f2') — proves provider identity is keyed
    // by the source query id (the #359 bug), not the definition id.
    const dupDiag = session.state.value.filterDiagnostics.find((d) => d.code === 'filter-duplicate-provider');
    expect(dupDiag?.message).toContain('srcA');
    expect(dupDiag?.message).toContain('srcB');
    expect(dupDiag?.message).not.toContain('f1');
    expect(dupDiag?.message).not.toContain('f2');
  });

  it('clears options on a subsequent source failure — no stale retention', async () => {
    let fail = false;
    const { exec } = makeExec((sql) => (sql.includes('source')
      ? (fail ? { error: 'source down' } : { columns: [{ name: 'p', type: 'Array(String)' }], rows: [[['V']]] })
      : { columns: [{ name: 'n' }], rows: [[1]] }));
    const document = sharedDoc([{ id: 'f1', parameter: 'p', sourceQueryId: 'src' }], [tile('t', 'qt')]);
    const session = createDashboardViewerSession(makeDeps({
      document, exec,
      queries: [query('qt', 'SELECT {p:String} AS n'), query('src', 'SELECT 1 /* source */', { dashboard: { role: 'filter' } })],
    }));
    await session.start();
    expect(session.state.value.filters[0]).toMatchObject({ status: 'ready', options: [{ value: 'V', label: 'V' }] });
    fail = true;
    await session.refresh();
    expect(session.state.value.filters[0].status).toBe('source-error');
    expect(session.state.value.filters[0].options).toBeNull();
  });

  it('marks a source that returns a row but no valid helper column as source-error (malformed result) and surfaces the diagnostic', async () => {
    // The query succeeds (one row) but the column is a plain scalar, not an
    // Array/Map — readFilterOptions yields zero helpers, so the SOURCE status
    // is the terminal `error` (not a transport failure), every consumer is
    // `source-error`, options are cleared, and the merge publishes the
    // `filter-no-valid-helpers` diagnostic.
    const { exec } = makeExec((sql) => (sql.includes('source')
      ? { columns: [{ name: 'p', type: 'String' }], rows: [['x']] }
      : { columns: [{ name: 'n' }], rows: [[1]] }));
    const document = sharedDoc([{ id: 'f1', parameter: 'p', sourceQueryId: 'src' }], [tile('t', 'qt')]);
    const session = createDashboardViewerSession(makeDeps({
      document, exec,
      queries: [query('qt', 'SELECT {p:String} AS n'), query('src', "SELECT 'x' AS p /* source */", { dashboard: { role: 'filter' } })],
    }));
    await session.start();
    expect(session.state.value.filters[0].status).toBe('source-error');
    expect(session.state.value.filters[0].options).toBeNull();
    expect(session.state.value.filterDiagnostics.some((d) => d.code === 'filter-no-valid-helpers')).toBe(true);
  });

  it('bumps optionsRev only when the option-value CONTENT changes; a same-content republish leaves it untouched', async () => {
    let values = ['V1'];
    const { exec } = makeExec((sql) => (sql.includes('source')
      ? { columns: [{ name: 'p', type: 'Array(String)' }], rows: [[values]] }
      : { columns: [{ name: 'n' }], rows: [[1]] }));
    const document = sharedDoc([{ id: 'f1', parameter: 'p', sourceQueryId: 'src' }], [tile('t', 'qt')]);
    const session = createDashboardViewerSession(makeDeps({
      document, exec,
      queries: [query('qt', 'SELECT {p:String} AS n'), query('src', 'SELECT 1 /* source */', { dashboard: { role: 'filter' } })],
    }));
    await session.start();
    const rev0 = session.state.value.filters[0].optionsRev;
    expect(rev0).toBeGreaterThan(0); // null -> non-empty bumped
    await session.refresh(); // identical content republished
    expect(session.state.value.filters[0].optionsRev).toBe(rev0); // no bump
    values = ['V2']; // different content
    await session.refresh();
    expect(session.state.value.filters[0].optionsRev).toBe(rev0 + 1);
    expect(session.state.value.filters[0].options).toEqual([{ value: 'V2', label: 'V2' }]);
  });

  it("reconciles a removed active option (active=false, value kept) synchronously BEFORE the same refresh's affected-tile wave", async () => {
    let values = ['V', 'W'];
    const { exec, calls } = makeExec((sql) => (sql.includes('source')
      ? { columns: [{ name: 'p', type: 'Array(String)' }], rows: [[values]] }
      : { columns: [{ name: 'n' }], rows: [[1]] }));
    const document = sharedDoc(
      [
        { id: 'f1', parameter: 'p', sourceQueryId: 'src', defaultActive: true, defaultValue: 'V' },
        // A second, PLAIN filter (no source) — exercises the reconcile loop's
        // non-matching branch (its own parameter is never in `merged.changed`).
        { id: 'f2', parameter: 'other', defaultActive: false, defaultValue: '' },
      ],
      [tile('t', 'qt')],
    );
    const session = createDashboardViewerSession(makeDeps({
      document, exec,
      queries: [query('qt', 'SELECT {p:String} AS n'), query('src', 'SELECT 1 /* source */', { dashboard: { role: 'filter' } })],
    }));
    await session.start();
    expect(session.state.value.filters[0].active).toBe(true);
    const before = calls.length;
    values = ['W']; // 'V' no longer offered
    await session.refresh();
    expect(session.state.value.filters[0].active).toBe(false);
    expect(session.state.value.filters[0].value).toBe('V'); // value retained
    // The reconciliation applied BEFORE this SAME refresh's affected wave ran
    // — the tile never sees a stale param_p binding (the plan-review PRECONDITION).
    expect(calls.slice(before).some((c) => 'param_p' in c.params)).toBe(false);
  });

  it('a superseded shared-source wave publishes NOTHING — never clobbers the fresher wave (stale-gen guard)', async () => {
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let call = 0;
    const { exec } = makeExec((sql) => {
      if (!sql.includes('source')) return { columns: [{ name: 'n' }], rows: [[1]] };
      call += 1;
      return call === 1
        ? gate.then(() => ({ columns: [{ name: 'p', type: 'Array(String)' }], rows: [[['STALE']]] }))
        : { columns: [{ name: 'p', type: 'Array(String)' }], rows: [[['FRESH']]] };
    });
    const document = sharedDoc(
      [{ id: 'f1', parameter: 'p', sourceQueryId: 'src', defaultActive: true, defaultValue: 'FRESH' }], [tile('t', 'qt')],
    );
    const session = createDashboardViewerSession(makeDeps({
      document, exec,
      queries: [query('qt', 'SELECT {p:String} AS n'), query('src', 'SELECT 1 /* source */', { dashboard: { role: 'filter' } })],
    }));
    // Record EVERY published options snapshot for f1 across the overlap.
    const optionsSeen: (unknown[] | null)[] = [];
    const unsubscribe = session.state.subscribe((s) => optionsSeen.push(s.filters[0].options));
    const first = session.start();
    await flush();
    const second = session.refresh(); // supersedes the pending first source run
    releaseFirst();
    await Promise.all([first, second]);
    unsubscribe();
    const fresh = [{ value: 'FRESH', label: 'FRESH' }];
    expect(session.state.value.filters[0].options).toEqual(fresh);
    // The STALE run's data never reaches state (its provider was discarded),
    // AND — the #359 guard — once the fresher wave published FRESH options no
    // later publish from the superseded wave ever reverts them to null: without
    // the guard the stale wave's applyFilterProviders would blank every
    // consumer to missing-helper/null over the correct FRESH state.
    expect(optionsSeen).not.toContainEqual([{ value: 'STALE', label: 'STALE' }]);
    const firstFreshAt = optionsSeen.findIndex((o) => JSON.stringify(o) === JSON.stringify(fresh));
    expect(firstFreshAt).toBeGreaterThanOrEqual(0);
    expect(optionsSeen.slice(firstFreshAt).every((o) => JSON.stringify(o) === JSON.stringify(fresh))).toBe(true);
  });

  it('destroy cancels a shared in-flight source exactly once, even with two consumers', async () => {
    const abortSpy = vi.spyOn(AbortController.prototype, 'abort');
    const { exec } = makeExec((sql) => (sql.includes('source') ? new Promise(() => {}) : { columns: [{ name: 'n' }], rows: [[1]] }));
    const document = sharedDoc(
      [{ id: 'f1', parameter: 'p1', sourceQueryId: 'src' }, { id: 'f2', parameter: 'p2', sourceQueryId: 'src' }],
      // #189: a real consumer per parameter — otherwise both definitions
      // have zero executable consumers and the strict fallback strips them
      // from `src`'s consumers before it ever runs (this test's whole
      // subject).
      [tile('ta', 'qa'), tile('tb', 'qb')],
    );
    const session = createDashboardViewerSession(makeDeps({
      document, exec,
      queries: [
        query('qa', 'SELECT {p1:String} AS n'), query('qb', 'SELECT {p2:String} AS n'),
        query('src', "SELECT ['V'] AS p1, ['W'] AS p2 /* source */", { dashboard: { role: 'filter' } }),
      ],
    }));
    // Intentionally not awaited: the source responder never resolves, so
    // `start()` never settles either — only `destroy()`'s abort matters here.
    void session.start();
    await flush();
    session.destroy();
    expect(abortSpy).toHaveBeenCalledTimes(1);
    abortSpy.mockRestore();
  });

  it('publishes filterDiagnostics with severity, not duplicated per shared-source consumer', async () => {
    const { exec } = makeExec((sql) => (sql.includes('source') ? { error: 'source down' } : { columns: [{ name: 'n' }], rows: [[1]] }));
    const document = sharedDoc(
      [{ id: 'f1', parameter: 'p1', sourceQueryId: 'src' }, { id: 'f2', parameter: 'p2', sourceQueryId: 'src' }],
      // #189: a real consumer per parameter keeps `src` alive (see the
      // "destroy cancels..." test above for why).
      [tile('ta', 'qa'), tile('tb', 'qb')],
    );
    const session = createDashboardViewerSession(makeDeps({
      document, exec,
      queries: [
        query('qa', 'SELECT {p1:String} AS n'), query('qb', 'SELECT {p2:String} AS n'),
        query('src', 'SELECT 1 /* source */', { dashboard: { role: 'filter' } }),
      ],
    }));
    await session.start();
    const diags = session.state.value.filterDiagnostics;
    const failures = diags.filter((d) => d.code === 'filter-query-failed');
    expect(failures.length).toBe(1); // ONE execution → ONE diagnostic, not one per consumer.
    expect(failures[0].severity).toBe('error');
  });

  it('preserves warning severity for an unused-helper diagnostic', async () => {
    const { exec } = makeExec((sql) => (sql.includes('source')
      ? { columns: [{ name: 'z', type: 'Array(String)' }], rows: [[['V']]] }
      : { columns: [{ name: 'n' }], rows: [[1]] }));
    // No tile/filter parameter named 'z' — the source's helper column has no
    // consumer. #189: 'f1' (parameter 'unrelated') has no consumer either
    // and falls back on its own (stripped from `src`'s consumers) — a
    // SEPARATE filter 'f2' sharing the same source with a real consumer
    // ('p1') keeps `src` running so 'z' still surfaces as unused.
    const document = sharedDoc(
      [
        { id: 'f1', parameter: 'unrelated', sourceQueryId: 'src' },
        { id: 'f2', parameter: 'p1', sourceQueryId: 'src' },
      ],
      [tile('t', 'qt'), tile('t2', 'q2')],
    );
    const session = createDashboardViewerSession(makeDeps({
      document, exec,
      queries: [
        query('qt', 'SELECT 1 AS n'), query('q2', 'SELECT {p1:String} AS n'),
        query('src', 'SELECT 1 /* source */', { dashboard: { role: 'filter' } }),
      ],
    }));
    await session.start();
    const warn = session.state.value.filterDiagnostics.find((d) => d.code === 'filter-helper-unused');
    expect(warn?.severity).toBe('warning');
  });

  it('marks a consumer missing-helper when the shared source omits its column; a sibling with a returned column stays ready', async () => {
    const { exec } = makeExec((sql) => (sql.includes('source')
      ? { columns: [{ name: 'p1', type: 'Array(String)' }], rows: [[['V']]] } // only p1, no p2
      : { columns: [{ name: 'n' }], rows: [[1]] }));
    const document = sharedDoc(
      [{ id: 'f1', parameter: 'p1', sourceQueryId: 'src' }, { id: 'f2', parameter: 'p2', sourceQueryId: 'src' }],
      [tile('ta', 'qa'), tile('tb', 'qb')],
    );
    const session = createDashboardViewerSession(makeDeps({
      document, exec,
      queries: [
        query('qa', 'SELECT {p1:String} AS n'), query('qb', 'SELECT {p2:String} AS n'),
        query('src', "SELECT ['V'] AS p1 /* source */", { dashboard: { role: 'filter' } }),
      ],
    }));
    await session.start();
    const f1 = session.state.value.filters.find((f) => f.id === 'f1')!;
    const f2 = session.state.value.filters.find((f) => f.id === 'f2')!;
    expect(f1.status).toBe('ready');
    expect(f2.status).toBe('missing-helper');
    expect(f2.options).toBeNull();
    // The missing helper is no longer SILENT: a warning diagnostic naming the
    // source and the absent column is published so the UI (which renders
    // filterDiagnostics, not per-filter status) can explain the empty control.
    const missing = session.state.value.filterDiagnostics.find((d) => d.code === 'filter-helper-missing');
    expect(missing).toMatchObject({ severity: 'warning', sourceId: 'src', helperName: 'p2' });
    expect(missing!.message).toContain('p2');
    // The healthy sibling (p1) does NOT get a missing-helper diagnostic.
    expect(session.state.value.filterDiagnostics.some((d) => d.code === 'filter-helper-missing' && d.helperName === 'p1')).toBe(false);
  });

  it('marks a filter source-error when its sourceQueryId does not resolve to any query — visible, not silently skipped', async () => {
    const { exec, calls } = makeExec(() => ({ columns: [{ name: 'n' }], rows: [[1]] }));
    const document = sharedDoc([{ id: 'f1', parameter: 'p', sourceQueryId: 'ghost-src' }], [tile('t', 'qt')]);
    const session = createDashboardViewerSession(makeDeps({
      document, exec, queries: [query('qt', 'SELECT {p:String} AS n')],
    }));
    await session.start();
    expect(session.state.value.filters[0].status).toBe('source-error');
    expect(session.state.value.filterDiagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'filter-source-missing', sourceId: 'ghost-src' })]),
    );
    expect(calls.some((c) => c.sql.includes('ghost'))).toBe(false); // never executes
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

// #321 "Full view": setGridRenderMode is a TRANSIENT runtime override — never
// a document mutation, never a commit (there is nothing to commit against;
// the session has no `workspace.commit` seam at all), never a revision bump.
describe('setGridRenderMode / Full view (#321)', () => {
  const gridDoc = (over: Partial<DashboardDocumentV1> = {}) => doc({
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

// #360: a shared Filter source may now declare its OWN `{name:Type}` params,
// fed by ROOT Dashboard filters (no `sourceQueryId`) rather than the source's
// consumers. `analyzeFilterSource`/`prepareFilterSource` (src/core/
// filter-execution.ts) classify each source `'runnable'` | `'waiting'` |
// `'error'` against the wave's COMMITTED root values before any request is
// sent, and committing a root filter's value selectively reruns only the
// sources that actually depend on it — folded into the SAME affected-panel
// wave as the committed parameter(s).
describe('parameterized Filter sources (#360)', () => {
  it('a source depending on an inactive/blank root param is waiting — no execution, waitingFor published, its consumer marked stale', async () => {
    const { exec, calls } = makeExec((sql) => (sql.includes('depsrc')
      ? { columns: [{ name: 'region', type: 'Array(String)' }], rows: [[['east', 'west']]] }
      : { columns: [{ name: 'n' }], rows: [[1]] }));
    const document = doc({
      // #189: 'tr'/'qr' is a real executable consumer of 'region' (a scalar
      // declaration) — otherwise `resolveFilterSelection` sees zero
      // consumers and the strict fallback strips 'f-region' from `src`'s
      // consumers before the wave below ever runs it.
      tiles: [tile('t', 'qt'), tile('tr', 'qr')],
      filters: [
        { id: 'from-root', parameter: 'from', defaultActive: false, defaultValue: '' },
        { id: 'f-region', parameter: 'region', sourceQueryId: 'src' },
      ],
    });
    const session = createDashboardViewerSession(makeDeps({
      document, exec,
      queries: [
        query('qt', 'SELECT 1 AS n'), query('qr', 'SELECT {region:String} AS n'),
        query('src', "SELECT ['east','west'] AS region FROM t WHERE ts >= {from:String} /* depsrc */", { dashboard: { role: 'filter' } }),
      ],
    }));
    await session.start();
    expect(calls.some((c) => c.sql.includes('depsrc'))).toBe(false);
    const f = session.state.value.filters.find((flt) => flt.id === 'f-region')!;
    expect(f.status).toBe('waiting');
    expect(f.waitingFor).toEqual(['from']);
    expect(f.options).toBeNull();
    expect(f.stale).toBe(true);
  });

  it('a runnable dependent source executes bound to the committed root-param values; the curated field applies', async () => {
    const { exec, calls } = makeExec((sql) => (sql.includes('depsrc')
      ? { columns: [{ name: 'region', type: 'Array(String)' }], rows: [[['east']]] }
      : { columns: [{ name: 'n' }], rows: [[1]] }));
    const document = doc({
      tiles: [tile('t', 'qt')],
      filters: [
        { id: 'from-root', parameter: 'from', defaultActive: true, defaultValue: '2024-01-01' },
        { id: 'to-root', parameter: 'to', defaultActive: true, defaultValue: '2024-02-01' },
        { id: 'f-region', parameter: 'region', sourceQueryId: 'src' },
      ],
    });
    const session = createDashboardViewerSession(makeDeps({
      document, exec,
      queries: [
        query('qt', 'SELECT {region:String} AS n'),
        query('src', "SELECT ['east'] AS region FROM t WHERE ts >= {from:String} AND ts < {to:String} /* depsrc */", { dashboard: { role: 'filter' } }),
      ],
    }));
    await session.start();
    const srcCall = calls.find((c) => c.sql.includes('depsrc'));
    expect(srcCall).toBeDefined();
    expect(srcCall!.params.param_from).toBe('2024-01-01');
    expect(srcCall!.params.param_to).toBe('2024-02-01');
    const f = session.state.value.filters.find((flt) => flt.id === 'f-region')!;
    expect(f.status).toBe('ready');
    expect(f.stale).toBe(false);
  });

  it('an invalid committed root value gates the dependent source to source-error, no execution', async () => {
    const { exec, calls } = makeExec(() => ({ columns: [{ name: 'n' }], rows: [[1]] }));
    const document = doc({
      tiles: [tile('t', 'qt')],
      filters: [
        { id: 'n-root', parameter: 'n', defaultActive: true, defaultValue: 'not-a-number' },
        { id: 'f-region', parameter: 'region', sourceQueryId: 'src' },
      ],
    });
    const session = createDashboardViewerSession(makeDeps({
      document, exec,
      queries: [
        query('qt', 'SELECT {region:String} AS n2'),
        query('src', "SELECT ['east'] AS region FROM t WHERE code = {n:UInt16} /* depsrc */", { dashboard: { role: 'filter' } }),
      ],
    }));
    await session.start();
    expect(calls.some((c) => c.sql.includes('depsrc'))).toBe(false);
    const f = session.state.value.filters.find((flt) => flt.id === 'f-region')!;
    expect(f.status).toBe('source-error');
  });

  it('a source declaring a dependency on ANOTHER source-backed parameter never executes and reports the cascading diagnostic', async () => {
    const { exec, calls } = makeExec((sql) => {
      if (sql.includes('srcA')) return { columns: [{ name: 'catA', type: 'Array(String)' }], rows: [[['x']]] };
      if (sql.includes('srcB')) return { columns: [{ name: 'catB', type: 'Array(String)' }], rows: [[['y']]] };
      return { columns: [{ name: 'n' }], rows: [[1]] };
    });
    const document = doc({
      tiles: [tile('t', 'qt')],
      filters: [
        { id: 'fa', parameter: 'catA', sourceQueryId: 'srcA' },
        { id: 'fb', parameter: 'catB', sourceQueryId: 'srcB' },
      ],
    });
    const session = createDashboardViewerSession(makeDeps({
      document, exec,
      queries: [
        query('qt', 'SELECT {catB:String} AS n'),
        query('srcA', "SELECT ['x'] AS catA /* srcA */", { dashboard: { role: 'filter' } }),
        query('srcB', "SELECT ['y'] AS catB FROM t WHERE cat = {catA:String} /* srcB */", { dashboard: { role: 'filter' } }),
      ],
    }));
    await session.start();
    expect(calls.some((c) => c.sql.includes('srcB'))).toBe(false);
    const fb = session.state.value.filters.find((flt) => flt.id === 'fb')!;
    expect(fb.status).toBe('source-error');
    const cascadeDiag = session.state.value.filterDiagnostics.find((d) => d.code === 'filter-source-cascading');
    expect(cascadeDiag?.message).toContain('Cascading');
  });

  it('selective rerun: committing a dependency reruns ONLY the sources that depend on it', async () => {
    const { exec, calls } = makeExec((sql) => {
      if (sql.includes('srcFrom')) return { columns: [{ name: 'dep1', type: 'Array(String)' }], rows: [[['a']]] };
      if (sql.includes('srcCat')) return { columns: [{ name: 'dep2', type: 'Array(String)' }], rows: [[['b']]] };
      return { columns: [{ name: 'n' }], rows: [[1]] };
    });
    const document = doc({
      // #189: real consumers for 'dep1'/'dep2' — otherwise both source-backed
      // filters have zero executable consumers and the strict fallback
      // strips them from their sources' consumers before this test's wave
      // ever runs either source.
      tiles: [tile('t', 'qt'), tile('t1', 'qd1'), tile('t2', 'qd2')],
      filters: [
        { id: 'from-root', parameter: 'from', defaultActive: true, defaultValue: 'v0' },
        { id: 'cat-root', parameter: 'category', defaultActive: true, defaultValue: 'X' },
        { id: 'f-dep1', parameter: 'dep1', sourceQueryId: 'srcFrom' },
        { id: 'f-dep2', parameter: 'dep2', sourceQueryId: 'srcCat' },
      ],
    });
    const session = createDashboardViewerSession(makeDeps({
      document, exec,
      queries: [
        query('qt', 'SELECT 1 AS n'),
        query('qd1', 'SELECT {dep1:String} AS n'), query('qd2', 'SELECT {dep2:String} AS n'),
        query('srcFrom', "SELECT ['a'] AS dep1 FROM t WHERE ts >= {from:String} /* srcFrom */", { dashboard: { role: 'filter' } }),
        query('srcCat', "SELECT ['b'] AS dep2 FROM t WHERE cat = {category:String} /* srcCat */", { dashboard: { role: 'filter' } }),
      ],
    }));
    await session.start();
    const base = calls.length;
    await session.setFilter('from-root', 'v1');
    const added = calls.slice(base);
    expect(added.some((c) => c.sql.includes('srcFrom'))).toBe(true);
    expect(added.some((c) => c.sql.includes('srcCat'))).toBe(false);
  });

  it("clears (not just marks stale) the affected consumer's options during a selective rerun's loading window — no stale-current options rendered before repopulating", async () => {
    let releaseSecond!: () => void;
    const gate = new Promise<void>((resolve) => { releaseSecond = resolve; });
    let call = 0;
    const { exec } = makeExec((sql) => {
      if (!sql.includes('srcFrom')) return { columns: [{ name: 'n' }], rows: [[1]] };
      call += 1;
      return call === 1
        ? { columns: [{ name: 'dep1', type: 'Array(String)' }], rows: [[['a1']]] } // construction
        : gate.then(() => ({ columns: [{ name: 'dep1', type: 'Array(String)' }], rows: [[['a2']]] })); // selective rerun
    });
    const document = doc({
      tiles: [tile('t', 'qt')],
      filters: [
        { id: 'from-root', parameter: 'from', defaultActive: true, defaultValue: 'v0' },
        { id: 'f-dep1', parameter: 'dep1', sourceQueryId: 'srcFrom' },
      ],
    });
    const session = createDashboardViewerSession(makeDeps({
      document, exec,
      queries: [
        query('qt', 'SELECT {dep1:String} AS n'),
        query('srcFrom', "SELECT ['a'] AS dep1 FROM t WHERE ts >= {from:String} /* srcFrom */", { dashboard: { role: 'filter' } }),
      ],
    }));
    await session.start();
    const initial = session.state.value.filters.find((flt) => flt.id === 'f-dep1')!;
    expect(initial.status).toBe('ready');
    expect(initial.options).toEqual([{ value: 'a1', label: 'a1' }]);

    const wave = session.setFilter('from-root', 'v1'); // commit a dependency change -> selective rerun
    await flush(); // let the rerun reach its (gated) executeRead
    const midFlight = session.state.value.filters.find((flt) => flt.id === 'f-dep1')!;
    expect(midFlight.status).toBe('loading');
    expect(midFlight.stale).toBe(true);
    // The OLD options ('a1') must NOT still render as current while a
    // committed dependency change is loading a fresh answer — cleared, not
    // left stale-current, per the issue's error/stale-result acceptance.
    expect(midFlight.options).toBeNull();

    releaseSecond();
    await wave;
    const settled = session.state.value.filters.find((flt) => flt.id === 'f-dep1')!;
    expect(settled.status).toBe('ready');
    expect(settled.stale).toBe(false);
    expect(settled.options).toEqual([{ value: 'a2', label: 'a2' }]); // repopulated once the wave settles
  });

  it("a reconciliation deactivation from the selective source rerun runs its dependent panel in the SAME wave as the changed root param", async () => {
    let fromValue = 'v0';
    const { exec, calls } = makeExec((sql) => {
      if (sql.includes('regsrc')) {
        return fromValue === 'v0'
          ? { columns: [{ name: 'region', type: 'Array(String)' }], rows: [[['R1', 'R2']]] }
          : { columns: [{ name: 'region', type: 'Array(String)' }], rows: [[['R2']]] };
      }
      return { columns: [{ name: 'n' }], rows: [[1]] };
    });
    const document = doc({
      tiles: [tile('t-region', 'q-region')],
      filters: [
        { id: 'from-root', parameter: 'from', defaultActive: true, defaultValue: 'v0' },
        { id: 'f-region', parameter: 'region', sourceQueryId: 'regsrc', defaultActive: true, defaultValue: 'R1' },
      ],
    });
    const session = createDashboardViewerSession(makeDeps({
      document, exec,
      queries: [
        query('q-region', 'SELECT {region:String} AS n'),
        query('regsrc', "SELECT ['R1','R2'] AS region FROM t WHERE ts >= {from:String} /* regsrc */", { dashboard: { role: 'filter' } }),
      ],
    }));
    await session.start();
    expect(session.state.value.tiles[0].status).toBe('ready'); // bound to R1 initially
    fromValue = 'v1'; // regsrc will now only offer R2 once rerun
    const before = calls.length;
    await session.setFilter('from-root', 'v1');
    // The region tile's own rerun never bound the now-stale 'R1' — the
    // reconciliation (region deactivated) applied BEFORE this SAME wave's
    // affected-panel run, not in some later, separate wave.
    expect(calls.slice(before).some((c) => c.params.param_region === 'R1')).toBe(false);
    expect(session.state.value.tiles[0].status).toBe('unfilled');
    expect(session.state.value.filters.find((flt) => flt.id === 'f-region')!.active).toBe(false);
    expect(session.state.value.filters.find((flt) => flt.id === 'f-region')!.value).toBe('R1'); // value retained
  });

  it('clearAllFilters resets every dependency-bearing root param in ONE selective wave — both dependent sources transition together', async () => {
    const { exec, calls } = makeExec((sql) => {
      if (sql.includes('srcFrom')) return { columns: [{ name: 'dep1', type: 'Array(String)' }], rows: [[['a']]] };
      if (sql.includes('srcCat')) return { columns: [{ name: 'dep2', type: 'Array(String)' }], rows: [[['b']]] };
      return { columns: [{ name: 'n' }], rows: [[1]] };
    });
    const document = doc({
      tiles: [tile('t', 'qt')],
      filters: [
        // Defaults are BLANK/inactive — the reset target `clearAllFilters`
        // restores. Both roots are activated below via `setFilter` first, so
        // the clear genuinely changes them (a default already equal to the
        // active value would make `clearAllFilters` a no-op).
        { id: 'from-root', parameter: 'from', defaultActive: false, defaultValue: '' },
        { id: 'cat-root', parameter: 'category', defaultActive: false, defaultValue: '' },
        { id: 'f-dep1', parameter: 'dep1', sourceQueryId: 'srcFrom' },
        { id: 'f-dep2', parameter: 'dep2', sourceQueryId: 'srcCat' },
      ],
    });
    const session = createDashboardViewerSession(makeDeps({
      document, exec,
      queries: [
        query('qt', 'SELECT {dep1:String} AS a, {dep2:String} AS b'),
        query('srcFrom', "SELECT ['a'] AS dep1 FROM t WHERE ts >= {from:String} /* srcFrom */", { dashboard: { role: 'filter' } }),
        query('srcCat', "SELECT ['b'] AS dep2 FROM t WHERE cat = {category:String} /* srcCat */", { dashboard: { role: 'filter' } }),
      ],
    }));
    await session.start();
    expect(session.state.value.filters.find((flt) => flt.id === 'f-dep1')!.status).toBe('waiting');
    expect(session.state.value.filters.find((flt) => flt.id === 'f-dep2')!.status).toBe('waiting');
    await session.setFilter('from-root', 'v0');
    await session.setFilter('cat-root', 'X');
    expect(session.state.value.filters.find((flt) => flt.id === 'f-dep1')!.status).toBe('ready');
    expect(session.state.value.filters.find((flt) => flt.id === 'f-dep2')!.status).toBe('ready');
    const base = calls.length;
    await session.clearAllFilters();
    // Neither source executed again — both roots reset to blank/inactive, so
    // both correctly gate to 'waiting' rather than firing a stale request —
    // but BOTH transitioned together, in this ONE clearAllFilters commit.
    expect(calls.slice(base).some((c) => c.sql.includes('srcFrom') || c.sql.includes('srcCat'))).toBe(false);
    expect(session.state.value.filters.find((flt) => flt.id === 'f-dep1')!.status).toBe('waiting');
    expect(session.state.value.filters.find((flt) => flt.id === 'f-dep2')!.status).toBe('waiting');
  });

  it("overlapping selective waves: a settling wave for one source does not flip a different, still-in-flight source's consumer to a settled state (BLOCKER-1)", async () => {
    let releaseA!: () => void;
    const gateA = new Promise<void>((resolve) => { releaseA = resolve; });
    let srcFromCalls = 0;
    const { exec } = makeExec((sql) => {
      if (sql.includes('srcFrom')) {
        srcFromCalls += 1;
        return srcFromCalls === 1
          ? { columns: [{ name: 'dep1', type: 'Array(String)' }], rows: [[['a1']]] }
          : gateA.then(() => ({ columns: [{ name: 'dep1', type: 'Array(String)' }], rows: [[['a2']]] }));
      }
      if (sql.includes('srcRegion')) return { columns: [{ name: 'dep2', type: 'Array(String)' }], rows: [[['b']]] };
      return { columns: [{ name: 'n' }], rows: [[1]] };
    });
    const document = doc({
      tiles: [tile('t', 'qt')],
      filters: [
        { id: 'from-root', parameter: 'from', defaultActive: true, defaultValue: 'v0' },
        { id: 'region-root', parameter: 'region', defaultActive: true, defaultValue: 'r0' },
        { id: 'f-dep1', parameter: 'dep1', sourceQueryId: 'srcFrom' },
        { id: 'f-dep2', parameter: 'dep2', sourceQueryId: 'srcRegion' },
      ],
    });
    const session = createDashboardViewerSession(makeDeps({
      document, exec,
      queries: [
        query('qt', 'SELECT {dep1:String} AS a, {dep2:String} AS b'),
        query('srcFrom', "SELECT ['a'] AS dep1 FROM t WHERE ts >= {from:String} /* srcFrom */", { dashboard: { role: 'filter' } }),
        query('srcRegion', "SELECT ['b'] AS dep2 FROM t WHERE r = {region:String} /* srcRegion */", { dashboard: { role: 'filter' } }),
      ],
    }));
    await session.start();
    expect(session.state.value.filters.find((flt) => flt.id === 'f-dep1')!.status).toBe('ready');
    expect(session.state.value.filters.find((flt) => flt.id === 'f-dep2')!.status).toBe('ready');

    const waveA = session.setFilter('from-root', 'v1'); // rerun srcFrom — gated (2nd call)
    await flush();
    expect(session.state.value.filters.find((flt) => flt.id === 'f-dep1')!.status).toBe('loading');

    const waveB = session.setFilter('region-root', 'r1'); // unrelated: rerun srcRegion only, resolves immediately
    await waveB;
    // BLOCKER-1: B's settling wave must NOT have flipped A's (still in-flight)
    // consumer to a settled state from A's stale provider.
    expect(session.state.value.filters.find((flt) => flt.id === 'f-dep1')!.status).toBe('loading');
    expect(session.state.value.filters.find((flt) => flt.id === 'f-dep2')!.status).toBe('ready');

    releaseA();
    await waveA;
    const f1 = session.state.value.filters.find((flt) => flt.id === 'f-dep1')!;
    expect(f1.status).toBe('ready');
    expect(f1.options).toEqual([{ value: 'a2', label: 'a2' }]);
  });

  it('a superseded SELECTIVE-wave source response never publishes (stale-gen guard holds for runFilterSourceWave too)', async () => {
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let call = 0;
    const { exec } = makeExec((sql) => {
      if (!sql.includes('srcFrom')) return { columns: [{ name: 'n' }], rows: [[1]] };
      call += 1;
      if (call === 1) return { columns: [{ name: 'dep1', type: 'Array(String)' }], rows: [[['init']]] };
      return call === 2
        ? gate.then(() => ({ columns: [{ name: 'dep1', type: 'Array(String)' }], rows: [[['STALE']]] }))
        : { columns: [{ name: 'dep1', type: 'Array(String)' }], rows: [[['FRESH']]] };
    });
    const document = doc({
      tiles: [tile('t', 'qt')],
      filters: [
        { id: 'from-root', parameter: 'from', defaultActive: true, defaultValue: 'v0' },
        { id: 'f-dep1', parameter: 'dep1', sourceQueryId: 'srcFrom' },
      ],
    });
    const session = createDashboardViewerSession(makeDeps({
      document, exec,
      queries: [
        query('qt', 'SELECT {dep1:String} AS n'),
        query('srcFrom', "SELECT ['x'] AS dep1 FROM t WHERE ts >= {from:String} /* srcFrom */", { dashboard: { role: 'filter' } }),
      ],
    }));
    await session.start();
    const first = session.setFilter('from-root', 'v1'); // call #2 — gated
    await flush();
    const second = session.setFilter('from-root', 'v2'); // supersedes; call #3 resolves immediately
    releaseFirst();
    await Promise.all([first, second]);
    const f = session.state.value.filters.find((flt) => flt.id === 'f-dep1')!;
    expect(f.options).toEqual([{ value: 'FRESH', label: 'FRESH' }]);
  });

  it('preflights before executing an affected Filter source — a stale token blocks the request rather than firing it', async () => {
    const { exec, calls } = makeExec((sql) => (sql.includes('srcFrom')
      ? { columns: [{ name: 'dep1', type: 'Array(String)' }], rows: [[['a']]] }
      : { columns: [{ name: 'n' }], rows: [[1]] }));
    const document = doc({
      tiles: [tile('t', 'qt')],
      filters: [
        { id: 'from-root', parameter: 'from', defaultActive: false, defaultValue: '' },
        { id: 'f-dep1', parameter: 'dep1', sourceQueryId: 'srcFrom' },
      ],
    });
    let tokenOk = true;
    const onAuthFailed = vi.fn();
    const ensureFreshToken = vi.fn(async () => tokenOk);
    const session = createDashboardViewerSession(makeDeps({
      document, exec, onAuthFailed,
      connection: { ensureFreshToken },
      queries: [
        query('qt', 'SELECT {dep1:String} AS n'),
        query('srcFrom', "SELECT ['a'] AS dep1 FROM t WHERE ts >= {from:String} /* srcFrom */", { dashboard: { role: 'filter' } }),
      ],
    }));
    await session.start(); // construction wave, token fresh — srcFrom stays 'waiting' ('from' is blank)
    expect(session.state.value.filters.find((flt) => flt.id === 'f-dep1')!.status).toBe('waiting');
    const base = calls.length;
    tokenOk = false; // token now stale
    ensureFreshToken.mockClear();
    onAuthFailed.mockClear();
    // Committing 'from' makes srcFrom affected (it depends on 'from'), so
    // commitAndRerun enters its affected path (runFilterSourceWave THEN
    // runAffectedWave) — which must preflight exactly ONCE for the whole
    // commit (a stale token must not double-fire `ensureFreshToken`/
    // `onAuthFailed` — one wave passing `preflighted: true` into the other),
    // and BEFORE issuing any executeRead.
    await expect(session.setFilter('from-root', 'v1')).resolves.toBeUndefined();
    expect(calls.slice(base).some((c) => c.sql.includes('srcFrom'))).toBe(false);
    expect(ensureFreshToken).toHaveBeenCalledTimes(1);
    expect(onAuthFailed).toHaveBeenCalledTimes(1);
    // No rerun happened at all — status is untouched.
    expect(session.state.value.filters.find((flt) => flt.id === 'f-dep1')!.status).toBe('waiting');
  });

  it('clearFilter on a dependency root re-gates its dependent source to waiting — the retained (but now inactive) value is blanked, not stale-executed', async () => {
    const { exec, calls } = makeExec((sql) => (sql.includes('srcFrom')
      ? { columns: [{ name: 'dep1', type: 'Array(String)' }], rows: [[['a']]] }
      : { columns: [{ name: 'n' }], rows: [[1]] }));
    const document = doc({
      tiles: [tile('t', 'qt')],
      filters: [
        { id: 'from-root', parameter: 'from', defaultActive: true, defaultValue: 'v0' },
        { id: 'f-dep1', parameter: 'dep1', sourceQueryId: 'srcFrom' },
      ],
    });
    const session = createDashboardViewerSession(makeDeps({
      document, exec,
      queries: [
        query('qt', 'SELECT {dep1:String} AS n'),
        query('srcFrom', "SELECT ['a'] AS dep1 FROM t WHERE ts >= {from:String} /* srcFrom */", { dashboard: { role: 'filter' } }),
      ],
    }));
    await session.start();
    expect(session.state.value.filters.find((flt) => flt.id === 'f-dep1')!.status).toBe('ready');
    const base = calls.length;
    // clearFilter deactivates 'from' but RETAINS its value ('v0', non-empty) —
    // committedRootValues() must still blank it for an inactive root, so the
    // dependent source correctly re-gates to 'waiting' instead of executing
    // against a stale/retained-but-no-longer-committed value.
    await session.clearFilter('from-root');
    expect(session.state.value.filters.find((flt) => flt.id === 'from-root')!.value).toBe('v0'); // retained
    expect(session.state.value.filters.find((flt) => flt.id === 'from-root')!.active).toBe(false);
    expect(calls.slice(base).some((c) => c.sql.includes('srcFrom'))).toBe(false); // no stale execution
    const f = session.state.value.filters.find((flt) => flt.id === 'f-dep1')!;
    expect(f.status).toBe('waiting');
    expect(f.options).toBeNull();
  });

  it('resolves two DIFFERENT sources\' relative-time dependency against ONE waveMs per wave (no per-source clock read)', async () => {
    const { exec, calls } = makeExec((sql) => {
      if (sql.includes('src1')) return { columns: [{ name: 'dep1', type: 'Array(String)' }], rows: [[['a']]] };
      if (sql.includes('src2')) return { columns: [{ name: 'dep2', type: 'Array(String)' }], rows: [[['b']]] };
      return { columns: [{ name: 'n' }], rows: [[1]] };
    });
    const document = doc({
      // #189: real consumers for 'dep1'/'dep2' — see the "selective rerun"
      // test above for why this is required now.
      tiles: [tile('t', 'qt'), tile('t1', 'qd1'), tile('t2', 'qd2')],
      filters: [
        { id: 't-root', parameter: 't', defaultActive: true, defaultValue: '-1h' },
        { id: 'f-dep1', parameter: 'dep1', sourceQueryId: 'src1' },
        { id: 'f-dep2', parameter: 'dep2', sourceQueryId: 'src2' },
      ],
    });
    let n = 0;
    const wallNow = vi.fn(() => { n += 1000; return n; });
    const session = createDashboardViewerSession(makeDeps({
      document, exec, wallNow,
      queries: [
        query('qt', 'SELECT 1 AS n'),
        query('qd1', 'SELECT {dep1:String} AS n'), query('qd2', 'SELECT {dep2:String} AS n'),
        query('src1', "SELECT ['a'] AS dep1 FROM t WHERE ts >= {t:DateTime} /* src1 */", { dashboard: { role: 'filter' } }),
        query('src2', "SELECT ['b'] AS dep2 FROM t WHERE ts >= {t:DateTime} /* src2 */", { dashboard: { role: 'filter' } }),
      ],
    }));
    await session.start();
    const call1 = calls.find((c) => c.sql.includes('src1'))!;
    const call2 = calls.find((c) => c.sql.includes('src2'))!;
    expect(call1.params.param_t).toBe(call2.params.param_t); // one shared clock reading for the whole wave
  });

  // The historical embedded-NUL-byte bug in `optionsSignature`'s `null` arm
  // (fixed in this same change) is verified by direct byte inspection during
  // implementation, not by an in-suite file read: a clean Node `fs` read from
  // a strict `.ts` test needs its own ambient module declaration (see the
  // `tests/types/node-crypto.d.ts` precedent -- `declare module` must live in
  // its own import/export-free file), which is a new file outside this
  // worker's two-file scope. The `null`-signature branch itself is already
  // exercised end-to-end above (every `waiting`/`source-error` transition
  // clears `options` to `null` via `setConsumerOptions`, and the `ready`
  // transitions set it back to a real array).
});

// Maintainer review of #360 (findings 1, 2, 4, 6): a commit's affected path
// (source wave THEN panel wave) must not launch its own panel wave once its
// source wave turns out to have been superseded or the session was
// destroyed — previously `runFilterSourceWave`/`applyFilterProviders`
// returned a bare `[]` for BOTH "applied, nothing flipped" and "discarded,
// stale plan", so a stale commit still ran `runAffectedWave` afterward. The
// fix relies ENTIRELY on `SourceWaveResult` (`applyFilterProviders`'s own
// per-source generation check) plus the `destroyed` flag — no separate
// "commit generation" counter: an earlier version of this fix added one,
// bumped on every `commitAndRerun` call including the no-affected-source
// fast path, which made two commits affecting completely unrelated,
// non-overlapping sources spuriously supersede one another (see the
// "unrelated overlapping commits" test below, added after that review round).
describe('superseded/destroyed selective-wave guard (#360 review findings 1/2)', () => {
  // A root filter ('from') feeds a shared Filter source ('src') that a
  // second, source-backed filter ('f-dep') consumes; a tile binds 'from'
  // directly so a fired panel wave for it is unambiguous and distinguishable
  // by COUNT (both a buggy stale wave and the correct settling wave would
  // bind the SAME, already-current 'from' value by the time either runs, so
  // only call-count — not the bound param — can tell them apart).
  const depDoc = () => doc({
    tiles: [tile('t', 'qt')],
    filters: [
      { id: 'from-root', parameter: 'from', defaultActive: true, defaultValue: 'v0' },
      { id: 'f-dep', parameter: 'dep', sourceQueryId: 'src', defaultActive: false, defaultValue: '' },
    ],
  });
  // #189: 't'/'qt' also declares 'dep' (inside an optional block, so it stays
  // inactive/unfilled without ever forcing a value) — otherwise 'f-dep' has
  // zero executable consumers and the strict fallback strips it from `src`'s
  // consumers before any of this describe block's waves ever run it. The
  // block never activates in these tests, so the tile's EXECUTED sql (and
  // every call-count assertion below) is unaffected — only the STRUCTURAL
  // analysis `resolveFilterSelection` reads sees the declaration.
  const depQueries = () => [
    query('qt', 'SELECT {from:String} AS n /*[ AND {dep:String} = {dep:String} ]*/'),
    query('src', "SELECT ['x'] AS dep FROM t WHERE ts >= {from:String} /* source */", { dashboard: { role: 'filter' } }),
  ];
  const tileCallCount = (calls: { sql: string }[]) => calls.filter((c) => !c.sql.includes('source')).length;

  it('finding 1: a commit superseded by a newer overlapping commit issues no panel requests of its own — only the fresher commit runs panels', async () => {
    let releaseA!: () => void;
    const gateA = new Promise<void>((resolve) => { releaseA = resolve; });
    let sourceCalls = 0;
    const { exec, calls } = makeExec((sql) => {
      if (!sql.includes('source')) return { columns: [{ name: 'n' }], rows: [[1]] };
      sourceCalls += 1;
      return sourceCalls === 2
        ? gateA.then(() => ({ columns: [{ name: 'dep', type: 'Array(String)' }], rows: [[['stale']]] }))
        : { columns: [{ name: 'dep', type: 'Array(String)' }], rows: [[['fresh']]] };
    });
    const session = createDashboardViewerSession(makeDeps({ document: depDoc(), exec, queries: depQueries() }));
    await session.start();
    const before = tileCallCount(calls);

    const waveA = session.setFilter('from-root', 'v1'); // source wave A starts; its executeRead is call #2, gated
    await flush();
    const waveB = session.setFilter('from-root', 'v2'); // supersedes A's source generation before A settles
    await waveB; // B's own source wave (call #3) resolves immediately and runs B's panel wave
    releaseA();
    await waveA; // A's held call finally resolves, but discovers its plan is stale

    // Only ONE panel request fired for the tile — B's. A's superseded commit
    // never launched its own `runAffectedWave` (the pre-fix bug: it would
    // have, since a stale `[]` was indistinguishable from an applied `[]`).
    expect(tileCallCount(calls) - before).toBe(1);
    expect(sourceCalls).toBe(3);
  });

  it('finding 1 (isolated): a source wave superseded by a concurrent full refresh() (not another commit) still skips the panel wave', async () => {
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
    let sourceCalls = 0;
    const { exec, calls } = makeExec((sql) => {
      if (!sql.includes('source')) return { columns: [{ name: 'n' }], rows: [[1]] };
      sourceCalls += 1;
      return sourceCalls === 2
        ? gate.then(() => ({ columns: [{ name: 'dep', type: 'Array(String)' }], rows: [[['stale']]] }))
        : { columns: [{ name: 'dep', type: 'Array(String)' }], rows: [[['fresh']]] };
    });
    const session = createDashboardViewerSession(makeDeps({ document: depDoc(), exec, queries: depQueries() }));
    await session.start();
    const before = tileCallCount(calls);

    const commit = session.setFilter('from-root', 'v1'); // selective source wave starts; gated (call #2)
    await flush();
    const refreshP = session.refresh(); // a full refresh — bumps EVERY source's generation, including this one's
    await refreshP;
    releaseGate();
    await commit;

    // `refresh()` legitimately fires the tile once (it is not source-targeted,
    // so it runs unaffected/parallel); the selective commit must NOT have
    // fired an additional, now-stale panel request of its own — its own
    // source plan is stale the instant `refresh()`'s `runFilterWave` reserves
    // a fresh generation on the SAME source, so `applyFilterProviders`
    // returns `{status:'superseded'}` regardless of anything commit-specific.
    expect(tileCallCount(calls) - before).toBe(1);
  });

  it('unrelated overlapping commits (different, non-dependent sources/params) each still run their own panel wave — neither supersedes the other', async () => {
    // Reproduces the bug the maintainer review caught in a `commitGeneration`
    // counter this fix does NOT use: 'region' feeds source 'src' (curating
    // 'city', targeting tile t1); 'status' is a wholly unrelated PLAIN filter
    // (no source at all) feeding tile t2 directly. Committing 'status' while
    // 'region''s source wave is still in flight must not stop 'region''s own
    // commit from running t1's panel wave once its (genuinely unraced,
    // `'applied'`) source wave settles.
    let releaseSrc!: () => void;
    const gate = new Promise<void>((resolve) => { releaseSrc = resolve; });
    let sourceCalls = 0;
    const { exec, calls } = makeExec((sql) => {
      if (!sql.includes('source')) return { columns: [{ name: 'n' }], rows: [[1]] };
      sourceCalls += 1;
      return sourceCalls === 2
        ? gate.then(() => ({ columns: [{ name: 'city', type: 'Array(String)' }], rows: [[['x1']]] }))
        : { columns: [{ name: 'city', type: 'Array(String)' }], rows: [[['x0']]] };
    });
    const document = doc({
      tiles: [tile('t1', 'q1'), tile('t2', 'q2')],
      filters: [
        { id: 'region-root', parameter: 'region', defaultActive: true, defaultValue: 'v0' },
        { id: 'f-city', parameter: 'city', sourceQueryId: 'src', defaultActive: false, defaultValue: '' },
        { id: 'status-root', parameter: 'status', defaultActive: true, defaultValue: 's0' },
      ],
    });
    const session = createDashboardViewerSession(makeDeps({
      document, exec,
      queries: [
        // #189: 'city' is declared inside an optional block (never activated
        // in this test, so t1's EXECUTED sql/call-count is unaffected) —
        // otherwise 'f-city' has zero executable consumers and the strict
        // fallback strips it from `src`'s consumers before it ever runs,
        // which would hollow out this test's whole "unrelated overlapping
        // commits" scenario (the source never running at all would still
        // pass the assertions below, but for the wrong reason).
        query('q1', 'SELECT {region:String} AS n /*[ AND {city:String} = {city:String} ]*/'),
        query('q2', 'SELECT {status:String} AS n'),
        query('src', "SELECT ['x'] AS city FROM t WHERE ts >= {region:String} /* source */", { dashboard: { role: 'filter' } }),
      ],
    }));
    // The 'src' source SQL ALSO contains the substring '{region:String}' (it
    // depends on 'region' too), so t1's own calls must be distinguished from
    // 'src''s by excluding anything tagged `/* source */`.
    const t1Calls = () => calls.filter((c) => !c.sql.includes('source') && c.sql.includes('{region:String}')).length;
    const t2Calls = () => calls.filter((c) => c.sql.includes('{status:String}')).length;
    await session.start(); // sourceCalls -> 1 (immediate); t1 and t2 each ran once.
    const t1Before = t1Calls();
    const t2Before = t2Calls();

    const commitRegion = session.setFilter('region-root', 'v1'); // affected path; src's exec is call #2, gated
    await flush();
    const commitStatus = session.setFilter('status-root', 's1'); // unrelated: no affected source, fast path
    await commitStatus; // resolves immediately — fires t2, never touches 'src'

    releaseSrc();
    await commitRegion; // src settles normally (never superseded) — must still run t1's panel wave

    expect(t2Calls() - t2Before).toBe(1);
    // The regression: t1 must ALSO have rerun. A `commitGeneration` counter
    // bumped by the unrelated 'status' commit would have made 'region''s
    // commit see a generation mismatch and skip this even though its own
    // source data was fresh and correctly `'applied'`.
    expect(t1Calls() - t1Before).toBe(1);
  });

  it("a full refresh()'s Filter wave superseded by a concurrent selective commit skips refresh's OWN affected-panel wave; the selective commit's runAffectedWave still runs it", async () => {
    // Tile 't' references the ROOT parameter 'region' directly (so the later
    // selective commit's own `runAffectedWave(['region'])` can target it
    // without depending on reconciliation), and the source-backed filter
    // 'f-city' explicitly `targets` it (so `refresh()`'s OWN
    // `affectedByFilterWave` classification puts 't' in its "affected"
    // bucket — waiting for the filter wave — rather than "unaffected").
    let releaseRefreshExec!: () => void;
    const gateRefresh = new Promise<void>((resolve) => { releaseRefreshExec = resolve; });
    let releaseCommitExec!: () => void;
    const gateCommit = new Promise<void>((resolve) => { releaseCommitExec = resolve; });
    let sourceCalls = 0;
    const { exec, calls } = makeExec((sql) => {
      if (!sql.includes('source')) return { columns: [{ name: 'n' }], rows: [[1]] };
      sourceCalls += 1;
      return sourceCalls === 1
        ? gateRefresh.then(() => ({ columns: [{ name: 'city', type: 'Array(String)' }], rows: [[['stale']]] }))
        : gateCommit.then(() => ({ columns: [{ name: 'city', type: 'Array(String)' }], rows: [[['fresh']]] }));
    });
    const document = doc({
      tiles: [tile('t', 'qt')],
      filters: [
        { id: 'region-root', parameter: 'region', defaultActive: true, defaultValue: 'v0' },
        { id: 'f-city', parameter: 'city', sourceQueryId: 'src', targets: ['t'] },
      ],
    });
    const session = createDashboardViewerSession(makeDeps({
      document, exec,
      queries: [
        // #189: 'f-city' explicitly `targets: ['t']`, so 't' must actually
        // declare {city:...} for the target to resolve — declared inside an
        // optional block (never activated, so 't''s executed sql/call-count
        // stays unaffected) — otherwise `resolveFilterSelection` reports
        // `filter-selection-target-missing-declaration` and the strict
        // fallback strips 'f-city' from `src`'s consumers before it ever runs.
        query('qt', 'SELECT {region:String} AS n /*[ AND {city:String} = {city:String} ]*/'),
        query('src', "SELECT ['x'] AS city FROM t WHERE ts >= {region:String} /* source */", { dashboard: { role: 'filter' } }),
      ],
    }));
    const tileCalls = () => calls.filter((c) => !c.sql.includes('source')).length;

    const refreshP = session.start(); // refresh()'s filter wave starts; its source exec is call #1, gated
    await flush();
    const commit = session.setFilter('region-root', 'v1'); // supersedes 'src'; its OWN source exec is call #2, ALSO gated
    await flush();
    expect(tileCalls()).toBe(0); // neither wave has reached its affected-panel phase yet

    releaseRefreshExec(); // refresh's held call resolves — but 'src' has since moved on; its plan is stale
    await refreshP;
    // The regression: refresh's OWN affected-panel wave must NOT have fired —
    // its Filter wave settled `{status:'superseded'}`, and (pre-fix) this
    // discarded result was ignored, so refresh ran its affected tile with
    // pre-commit/pre-merge values while the selective commit was still loading.
    expect(tileCalls()).toBe(0);

    releaseCommitExec(); // the selective commit's OWN call settles normally (not superseded)
    await commit;
    // Only the selective commit's own `runAffectedWave` (after it settled and
    // reconciled) ran the affected tile — exactly once.
    expect(tileCalls()).toBe(1);
  });

  it('finding 2: destroy() during an in-flight selective source wave prevents its panel wave from ever firing', async () => {
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
    let sourceCalls = 0;
    const { exec, calls } = makeExec((sql) => {
      if (!sql.includes('source')) return { columns: [{ name: 'n' }], rows: [[1]] };
      sourceCalls += 1;
      return sourceCalls === 2
        ? gate.then(() => ({ columns: [{ name: 'dep', type: 'Array(String)' }], rows: [[['x']]] }))
        : { columns: [{ name: 'dep', type: 'Array(String)' }], rows: [[['x']]] };
    });
    const session = createDashboardViewerSession(makeDeps({ document: depDoc(), exec, queries: depQueries() }));
    await session.start();
    const before = tileCallCount(calls);

    const wave = session.setFilter('from-root', 'v1'); // selective source wave starts; gated
    await flush();
    session.destroy();
    releaseGate();
    await wave;

    expect(tileCallCount(calls)).toBe(before); // no panel request fired after destroy
  });
});

describe('published sourceId on ViewerFilterState (#360 review finding 4)', () => {
  it('a source-backed filter publishes sourceId equal to its sourceQueryId; a plain filter leaves it undefined', () => {
    const document = doc({
      // #189: 'ts'/'qs' is a real executable consumer of 'srcp' — otherwise
      // `resolveFilterSelection` sees zero consumers and the strict
      // fallback strips 'f-src' from `src`'s consumers (and clears
      // `state.sourceId`) at construction, which is exactly the topology
      // this test asserts.
      tiles: [tile('t', 'qt'), tile('ts', 'qs')],
      filters: [
        { id: 'f-plain', parameter: 'plain', defaultActive: false, defaultValue: '' },
        { id: 'f-src', parameter: 'srcp', sourceQueryId: 'src' },
      ],
    });
    const session = createDashboardViewerSession(makeDeps({
      document,
      queries: [
        query('qt', 'SELECT 1 AS n'), query('qs', 'SELECT {srcp:String} AS n'),
        query('src', "SELECT ['x'] AS srcp /* source */", { dashboard: { role: 'filter' } }),
      ],
    }));
    const plain = session.state.value.filters.find((f) => f.id === 'f-plain')!;
    const sourced = session.state.value.filters.find((f) => f.id === 'f-src')!;
    expect(plain.sourceId).toBeUndefined();
    expect(sourced.sourceId).toBe('src');
  });
});

// #189: searchable multiselect filters — the runtime wiring atop the already-
// landed pure `resolveFilterSelection`/`sameSelection`/`reconcileSelection`
// (core/filter-selection.ts). `resolveFilterSelection`'s own contract is
// strict (its return type's doc comment): the curated helper is exposed IFF
// `diagnostics` is empty. There is no benign carve-out — issue #189's
// fallback list is explicit that "targets that do not declare the
// parameter" and "target-less or non-executable configurations where no
// consumer contract can be resolved" (`filter-selection-no-consumers`,
// `filter-selection-target-not-executable`,
// `filter-selection-target-missing-declaration`) must fall back exactly like
// a genuine type conflict: no `selection` contract, no `sourceId`, the
// filter dropped from its source's `consumers` (so the helper never
// executes), a persistent diagnostic, and every unrelated filter/panel
// unaffected.
describe('searchable multiselect filter contract (#189)', () => {
  const byId = (session: ReturnType<typeof createDashboardViewerSession>, id: string) =>
    session.state.value.filters.find((f) => f.id === id)!;

  it('infers single from a scalar consumer and multiple from an Array(T) consumer', () => {
    const document = doc({
      tiles: [tile('t1', 'q1'), tile('t2', 'q2')],
      filters: [
        { id: 'fScalar', parameter: 'ps', sourceQueryId: 'srcS' },
        { id: 'fArray', parameter: 'pa', sourceQueryId: 'srcA' },
      ],
    });
    const session = createDashboardViewerSession(makeDeps({
      document,
      queries: [
        query('q1', 'SELECT {ps:String} AS n'),
        query('q2', 'SELECT 1 AS n WHERE x IN {pa:Array(String)}'),
        query('srcS', "SELECT ['x'] AS ps /* srcS */", { dashboard: { role: 'filter' } }),
        query('srcA', "SELECT ['y'] AS pa /* srcA */", { dashboard: { role: 'filter' } }),
      ],
    }));
    expect(byId(session, 'fScalar').selection).toEqual({ mode: 'single', array: false });
    expect(byId(session, 'fScalar').sourceId).toBe('srcS');
    expect(byId(session, 'fArray').selection).toEqual({ mode: 'multiple', array: true });
    expect(byId(session, 'fArray').sourceId).toBe('srcA');
  });

  it('an explicit selection.mode "single" against an Array(T) consumer stays single (array:true)', () => {
    const document = doc({
      tiles: [tile('t1', 'q1')],
      filters: [{ id: 'f1', parameter: 'pa', sourceQueryId: 'src', selection: { mode: 'single' } }],
    });
    const session = createDashboardViewerSession(makeDeps({
      document,
      queries: [
        query('q1', 'SELECT 1 AS n WHERE x IN {pa:Array(String)}'),
        query('src', "SELECT ['y'] AS pa /* src */", { dashboard: { role: 'filter' } }),
      ],
    }));
    expect(byId(session, 'f1').selection).toEqual({ mode: 'single', array: true });
    expect(byId(session, 'f1').sourceId).toBe('src');
  });

  it('an unknown selection.mode string is a HARD conflict: falls back to the string input, source never executes (zero consumers)', async () => {
    const { exec, calls } = makeExec(() => ({ columns: [{ name: 'n' }], rows: [[1]] }));
    const document = doc({
      tiles: [tile('t1', 'q1')],
      // `mode: 'bogus'` is deliberately outside the generated literal union —
      // `resolveFilterSelection` narrows defensively at runtime (its own doc
      // comment), so this exercises that defensive path, cast past the
      // schema-derived compile-time type the same way filter-selection.test.ts
      // does via its own wider `FilterSelectionFilterDef.selection.mode: string`.
      filters: [{ id: 'f1', parameter: 'ps', sourceQueryId: 'src', selection: { mode: 'bogus' as 'single' } }],
    });
    const session = createDashboardViewerSession(makeDeps({
      document, exec,
      queries: [
        query('q1', 'SELECT {ps:String} AS n'),
        query('src', "SELECT ['x'] AS ps /* source */", { dashboard: { role: 'filter' } }),
      ],
    }));
    expect(byId(session, 'f1').sourceId).toBeUndefined();
    expect(byId(session, 'f1').selection).toBeUndefined();
    const diag = session.state.value.filterDiagnostics.find((d) => d.code === 'filter-selection-unknown-mode');
    expect(diag).toMatchObject({ severity: 'error' });
    await session.start();
    // The source has ZERO consumers left (its only filter fell back) — it
    // must never execute at all.
    expect(calls.some((c) => c.sql.includes('source'))).toBe(false);
    // The diagnostic survives the wave's own reset (it is a construction-time
    // constant, never touched by `executeFilterSourcePlan`'s per-wave reset).
    expect(session.state.value.filterDiagnostics.some((d) => d.code === 'filter-selection-unknown-mode')).toBe(true);
    await session.refresh();
    expect(session.state.value.filterDiagnostics.some((d) => d.code === 'filter-selection-unknown-mode')).toBe(true);
  });

  it('selection.mode "multiple" against a scalar consumer is a HARD conflict for BOTH filters sharing a source — the source never runs (zero-consumer-source)', async () => {
    const { exec, calls } = makeExec((sql) => (sql.includes('source')
      ? { columns: [{ name: 'p1', type: 'Array(String)' }, { name: 'p2', type: 'Array(String)' }], rows: [[['a'], ['b']]] }
      : { columns: [{ name: 'n' }], rows: [[1]] }));
    const document = doc({
      tiles: [tile('t1', 'q1'), tile('t2', 'q2')],
      filters: [
        { id: 'f1', parameter: 'p1', sourceQueryId: 'src', selection: { mode: 'multiple' } },
        { id: 'f2', parameter: 'p2', sourceQueryId: 'src', selection: { mode: 'multiple' } },
      ],
    });
    const session = createDashboardViewerSession(makeDeps({
      document, exec,
      queries: [
        query('q1', 'SELECT {p1:String} AS n'), // scalar consumer
        query('q2', 'SELECT {p2:String} AS n'), // scalar consumer
        query('src', "SELECT ['a'] AS p1, ['b'] AS p2 /* source */", { dashboard: { role: 'filter' } }),
      ],
    }));
    expect(byId(session, 'f1').sourceId).toBeUndefined();
    expect(byId(session, 'f2').sourceId).toBeUndefined();
    const diags = session.state.value.filterDiagnostics.filter((d) => d.code === 'filter-selection-mode-requires-array');
    expect(diags.length).toBe(2);
    expect(diags.some((d) => d.message.includes('f1'))).toBe(true);
    expect(diags.some((d) => d.message.includes('f2'))).toBe(true);
    await session.start();
    expect(calls.some((c) => c.sql.includes('source'))).toBe(false);
  });

  it('a filter with no wired consumer falls back to the plain string input (#189): no sourceId/selection, source never executes, diagnostic persists across a refresh', async () => {
    const { exec, calls } = makeExec((sql) => (sql.includes('source')
      ? { columns: [{ name: 'unused', type: 'Array(String)' }], rows: [[['x']]] }
      : { columns: [{ name: 'n' }], rows: [[1]] }));
    const document = doc({
      tiles: [tile('t', 'qt')],
      filters: [{ id: 'f1', parameter: 'unused', sourceQueryId: 'src' }],
    });
    const session = createDashboardViewerSession(makeDeps({
      document, exec,
      queries: [query('qt', 'SELECT 1 AS n'), query('src', 'SELECT 1 /* source */', { dashboard: { role: 'filter' } })],
    }));
    expect(byId(session, 'f1').sourceId).toBeUndefined();
    expect(byId(session, 'f1').selection).toBeUndefined();
    const diag = session.state.value.filterDiagnostics.find((d) => d.code === 'filter-selection-no-consumers');
    expect(diag).toMatchObject({ severity: 'error' });
    await session.start();
    // Zero consumers left on `src` — it must never execute at all.
    expect(calls.some((c) => c.sql.includes('source'))).toBe(false);
    // The diagnostic survives the wave's own reset (a construction-time
    // constant, never touched by `executeFilterSourcePlan`'s per-wave reset).
    expect(session.state.value.filterDiagnostics.some((d) => d.code === 'filter-selection-no-consumers')).toBe(true);
    await session.refresh();
    expect(session.state.value.filterDiagnostics.some((d) => d.code === 'filter-selection-no-consumers')).toBe(true);
  });

  it('an explicit target that does not declare the parameter falls back to the plain string input (#189): no sourceId/selection, source never executes', async () => {
    const { exec, calls } = makeExec((sql) => (sql.includes('source')
      ? { columns: [{ name: 'p', type: 'Array(String)' }], rows: [[['x']]] }
      : { columns: [{ name: 'n' }], rows: [[1]] }));
    const document = doc({
      tiles: [tile('t1', 'q1')],
      filters: [{ id: 'f1', parameter: 'p', sourceQueryId: 'src', targets: ['t1'] }],
    });
    const session = createDashboardViewerSession(makeDeps({
      document, exec,
      queries: [
        query('q1', 'SELECT 1 AS n'), // 't1' does NOT declare {p:...}
        query('src', "SELECT ['x'] AS p /* source */", { dashboard: { role: 'filter' } }),
      ],
    }));
    expect(byId(session, 'f1').sourceId).toBeUndefined();
    expect(byId(session, 'f1').selection).toBeUndefined();
    const diag = session.state.value.filterDiagnostics.find((d) => d.code === 'filter-selection-target-missing-declaration');
    expect(diag).toMatchObject({ severity: 'error' });
    await session.start();
    expect(calls.some((c) => c.sql.includes('source'))).toBe(false); // zero-consumer source never executes
  });

  it('a fallback filter (no wired consumer) leaves unrelated filters and panels fully functional', async () => {
    const { exec, calls } = makeExec((sql) => (sql.includes('source')
      ? { columns: [{ name: 'unused', type: 'Array(String)' }], rows: [[['x']]] }
      : { columns: [{ name: 'n' }], rows: [[1]] }));
    const document = doc({
      tiles: [tile('t1', 'q1'), tile('t2', 'q2')],
      filters: [
        { id: 'f-bad', parameter: 'unused', sourceQueryId: 'src' }, // no wired consumer — falls back
        { id: 'f-ok', parameter: 'ok', defaultActive: true, defaultValue: 'v0' }, // plain, unrelated
      ],
    });
    const session = createDashboardViewerSession(makeDeps({
      document, exec,
      queries: [
        query('q1', 'SELECT 1 AS n'),
        query('q2', 'SELECT {ok:String} AS n'),
        query('src', 'SELECT 1 /* source */', { dashboard: { role: 'filter' } }),
      ],
    }));
    await session.start();
    expect(calls.some((c) => c.sql.includes('source'))).toBe(false); // f-bad's source never ran
    // The unrelated, healthy filter's own tile ran normally and can still be
    // committed to rerun its own affected panel.
    expect(session.state.value.tiles.find((t) => t.tileId === 't2')!.status).toBe('ready');
    const before = calls.length;
    await session.setFilter('f-ok', 'v1');
    expect(calls.slice(before).some((c) => c.sql.includes('{ok:String}'))).toBe(true);
  });

  it('committing an array value reaches the pipeline as a real array; an empty array behaves like a missing value; a defensive copy is stored', async () => {
    const { exec, calls } = makeExec((sql) => (sql.includes('source')
      ? { columns: [{ name: 'region', type: 'Array(String)' }], rows: [[['east', 'west']]] }
      : { columns: [{ name: 'n' }], rows: [[1]] }));
    const document = doc({
      tiles: [tile('t', 'qt')],
      filters: [{ id: 'f-region', parameter: 'region', sourceQueryId: 'src' }],
    });
    const session = createDashboardViewerSession(makeDeps({
      document, exec,
      queries: [
        query('qt', 'SELECT 1 AS n WHERE x IN {region:Array(String)}'),
        query('src', "SELECT ['east','west'] AS region /* source */", { dashboard: { role: 'filter' } }),
      ],
    }));
    await session.start();
    const arr = ['east', 'west'];
    const base = calls.length;
    await session.setFilter('f-region', arr);
    arr.push('MUTATED'); // the session must never alias the caller's own array
    expect(byId(session, 'f-region').value).toEqual(['east', 'west']);
    expect(byId(session, 'f-region').active).toBe(true);
    const boundCall = calls.slice(base).find((c) => 'param_region' in c.params);
    expect(boundCall).toBeDefined();
    expect(boundCall!.params.param_region).toBe("['east','west']"); // a REAL array serialized, never a stringified value
    // An active EMPTY array behaves like '' (missing) for execution purposes.
    await session.setFilter('f-region', []);
    expect(byId(session, 'f-region').active).toBe(false);
    expect(byId(session, 'f-region').value).toEqual([]);
    const afterEmpty = calls.slice(base);
    expect(afterEmpty.some((c) => 'param_region' in c.params && Array.isArray(undefined))).toBe(false);
  });

  it('targeted wave: explicit targets rerun only their target tiles; two filters sharing one parameter union their targets', async () => {
    const { exec, calls } = makeExec(() => ({ columns: [{ name: 'n' }], rows: [[1]] }));
    const document = doc({
      tiles: [tile('a', 'qa'), tile('b', 'qb'), tile('c', 'qc')],
      filters: [
        { id: 'f1', parameter: 'shared', targets: ['a'], defaultActive: false, defaultValue: '' },
        { id: 'f2', parameter: 'shared', targets: ['b'], defaultActive: false, defaultValue: '' },
      ],
    });
    const session = createDashboardViewerSession(makeDeps({
      document, exec,
      queries: [
        query('qa', 'SELECT {shared:String} AS n'),
        query('qb', 'SELECT {shared:String} AS n'),
        query('qc', 'SELECT {shared:String} AS n'),
      ],
    }));
    await session.start();
    const base = calls.length;
    // `rawValues()`/`activeMap()` key by PARAMETER (pre-existing, #189-
    // unrelated behavior): with two filter definitions sharing one parameter,
    // the LAST one in filter order supplies the actually-bound value — commit
    // through 'f2' (the later definition) so the tile sees a real, active
    // value rather than the other definition's still-inactive default.
    await session.setFilter('f2', 'X');
    const added = calls.slice(base);
    // Both 'a' (f1's own target) and 'b' (f2's target — SAME parameter, union)
    // rerun; 'c' declares {shared} too but is targeted by NEITHER filter.
    expect(added.length).toBe(2);
  });

  it('option-refresh reconciliation via a selective (#360) rerun: intersection narrows + joins the SAME wave, a pure reorder fires none, an empty intersection deactivates and keeps the dormant array', async () => {
    // A ROOT dependency ('from') the shared source depends on (#360) drives a
    // SELECTIVE rerun (`runFilterSourceWave` → `runAffectedWave`), which gates
    // its affected-panel wave on `merged.changed`/`flipped` — unlike a full
    // `session.refresh()`, which unconditionally reruns every #235 "affected"
    // tile regardless of whether reconciliation actually changed anything.
    // This is the same harness shape as the existing #360
    // "reconciliation deactivation ... runs in the SAME wave" test above.
    let options = ['east', 'west', 'south'];
    const { exec, calls } = makeExec((sql) => (sql.includes('source')
      ? { columns: [{ name: 'region', type: 'Array(String)' }], rows: [[options]] }
      : { columns: [{ name: 'n' }], rows: [[1]] }));
    const document = doc({
      tiles: [tile('t', 'qt')],
      filters: [
        { id: 'from-root', parameter: 'from', defaultActive: true, defaultValue: 'v0' },
        { id: 'f-region', parameter: 'region', sourceQueryId: 'src', defaultActive: true, defaultValue: ['east', 'west'] },
      ],
    });
    const session = createDashboardViewerSession(makeDeps({
      document, exec,
      queries: [
        query('qt', 'SELECT 1 AS n WHERE x IN {region:Array(String)}'),
        query('src', "SELECT ['e'] AS region FROM t WHERE ts >= {from:String} /* source */", { dashboard: { role: 'filter' } }),
      ],
    }));
    await session.start();
    expect(byId(session, 'f-region').value).toEqual(['east', 'west']);

    // Pure reorder/label refresh (same SET, new order) — value canonicalizes
    // to the fresh order but is NOT a change (no additional tile request).
    options = ['west', 'east', 'south'];
    let base = calls.length;
    await session.setFilter('from-root', 'v1');
    expect(byId(session, 'f-region').value).toEqual(['west', 'east']);
    expect(byId(session, 'f-region').active).toBe(true);
    expect(calls.slice(base).some((c) => 'param_region' in c.params)).toBe(false);

    // 'east' is dropped from the fresh options — narrows to survivors, stays
    // active, and DOES join the affected-panel wave.
    options = ['west', 'south'];
    base = calls.length;
    await session.setFilter('from-root', 'v2');
    expect(byId(session, 'f-region').value).toEqual(['west']);
    expect(byId(session, 'f-region').active).toBe(true);
    expect(calls.slice(base).some((c) => c.params.param_region === "['west']")).toBe(true);

    // Every surviving value is now gone too — deactivates but KEEPS the
    // dormant committed array untouched (reactivation restores it).
    options = ['north'];
    await session.setFilter('from-root', 'v3');
    expect(byId(session, 'f-region').active).toBe(false);
    expect(byId(session, 'f-region').value).toEqual(['west']);
  });

  it('clearAllFilters compares an array value/default STRUCTURALLY (sameSelection) — a no-op reset issues no wave, a real change issues exactly one', async () => {
    const { exec, calls } = makeExec(() => ({ columns: [{ name: 'n' }], rows: [[1]] }));
    const document = doc({
      tiles: [tile('t', 'qt')],
      filters: [{ id: 'f1', parameter: 'p', defaultActive: true, defaultValue: ['a', 'b'] }],
    });
    const session = createDashboardViewerSession(makeDeps({
      document, exec, queries: [query('qt', 'SELECT 1 AS n WHERE x IN {p:Array(String)}')],
    }));
    await session.start();
    // A fresh session's state.value is ALREADY a (copied) equal-content array
    // to the default — a reference-based `!==` check would spuriously see
    // this as "changed" on every call; `sameSelection` must not.
    const base = calls.length;
    await session.clearAllFilters();
    expect(calls.length).toBe(base); // no-op: nothing actually changed
    expect(byId(session, 'f1').value).toEqual(['a', 'b']);

    await session.setFilter('f1', ['a']);
    const base2 = calls.length;
    await session.clearAllFilters();
    expect(calls.length).toBeGreaterThan(base2); // a genuine change fires exactly one wave
    expect(byId(session, 'f1').value).toEqual(['a', 'b']);
    expect(byId(session, 'f1').active).toBe(true);
  });

  it('initialFilters seeds an array value from the widened per-dashboard store, defensively copied', () => {
    const document = doc({
      filters: [{ id: 'f1', parameter: 'p', defaultValue: '', defaultActive: false }],
    });
    const seedArray = ['x', 'y'];
    const session = createDashboardViewerSession(makeDeps({
      document, initialFilters: { f1: { value: seedArray, active: true } },
    }));
    seedArray.push('MUTATED');
    expect(byId(session, 'f1').value).toEqual(['x', 'y']);
    expect(byId(session, 'f1').active).toBe(true);
  });

  // Review finding (major): `resolveFilterSelection` only agrees over a
  // filter's own resolved TARGETS + dependent sources — but the per-wave
  // merge (`mergeDashboardFilterHelpers`) rejects a curated field on the
  // DASHBOARD-WIDE `control.conflict` (`fieldControls(analysis)`, every
  // tile, unscoped). Without the construction-time dashboard-wide gate, a
  // filter whose OWN targets agree could still publish a `selection`
  // contract and keep its source consumer, only for every wave's merge to
  // permanently reject it as `filter-target-type-conflict` — a stuck
  // hybrid (published contract + dead curated field), never falling back.
  it('a dashboard-wide type conflict OUTSIDE the filter\'s own targets still forces a full fallback (#189 review finding, major): no sourceId/selection published, a persistent dashboard-wide diagnostic, the source never executes, and no helper-error hybrid ever appears', async () => {
    const { exec, calls } = makeExec((sql) => (sql.includes('source')
      ? { columns: [{ name: 'region', type: 'Array(String)' }], rows: [[['a', 'b']]] }
      : { columns: [{ name: 'n' }], rows: [[1]] }));
    const document = doc({
      tiles: [tile('t1', 'q1'), tile('t2', 'q2')],
      // Explicit `targets: ['t1']` — 't1' alone agrees with the source on
      // Array(String), so `resolveFilterSelection`'s OWN (target-scoped)
      // agreement check would succeed on its own.
      filters: [{ id: 'f1', parameter: 'region', sourceQueryId: 'src', targets: ['t1'] }],
    });
    const session = createDashboardViewerSession(makeDeps({
      document, exec,
      queries: [
        query('q1', 'SELECT 1 AS n WHERE x IN {region:Array(String)}'), // f1's own target — agrees
        // NOT one of f1's targets, but its scalar declaration of the SAME
        // parameter still counts for the dashboard-wide `fieldControls`
        // conflict the shared merge layer gates on.
        query('q2', 'SELECT 1 AS n WHERE y = {region:String}'),
        query('src', "SELECT ['a','b'] AS region /* source */", { dashboard: { role: 'filter' } }),
      ],
    }));
    expect(byId(session, 'f1').sourceId).toBeUndefined();
    expect(byId(session, 'f1').selection).toBeUndefined();
    const diag = session.state.value.filterDiagnostics.find((d) => d.code === 'filter-selection-dashboard-type-conflict');
    expect(diag).toMatchObject({ severity: 'error', filterId: 'f1', parameter: 'region' });
    expect(diag!.message).toContain('region');
    expect(diag!.message.toLowerCase()).toContain('dashboard-wide');
    expect(diag!.types).toEqual(expect.arrayContaining([expect.any(String), expect.any(String)]));
    await session.start();
    // 'src' is left with zero consumers (its only filter fell back) — it
    // must never execute at all.
    expect(calls.some((c) => c.sql.includes('source'))).toBe(false);
    // No stuck hybrid: 'f1' is no longer a consumer of any source, so its
    // status never enters the filter-wave consumer-derivation loop — it
    // stays 'idle', never 'helper-error'.
    expect(byId(session, 'f1').status).toBe('idle');
    // The diagnostic is a construction-time constant — it survives a refresh.
    await session.refresh();
    expect(byId(session, 'f1').status).toBe('idle');
    expect(session.state.value.filterDiagnostics.some((d) => d.code === 'filter-selection-dashboard-type-conflict')).toBe(true);
  });

  // Review finding (minor): `affectedByFilterWave` was built from the
  // structural `filter.def.sourceQueryId` BEFORE the #189 resolution loop
  // that can strip `filter.state.sourceId` — so a fallen-back filter's
  // (would-be) target tile was needlessly classified "affected" and deferred
  // behind the filter wave, even though the fallback filter no longer feeds
  // any source at all.
  it('#235 wave-deferral gate reflects the POST-resolution state (#189 review finding, minor): a fallen-back filter defers nothing — its own (would-be) target tile runs in the FIRST (unaffected) batch, not after the whole filter wave', async () => {
    let releaseSource2: (() => void) | undefined;
    const source2Gate = new Promise<void>((resolve) => { releaseSource2 = resolve; });
    const { exec, calls } = makeExec(async (sql) => {
      if (sql.includes('source2')) {
        await source2Gate; // a real, observable delay for the filter wave
        return { columns: [{ name: 'other', type: 'String' }], rows: [['y']] };
      }
      return { columns: [{ name: 'n' }], rows: [[1]] };
    });
    const document = doc({
      tiles: [tile('t1', 'q1'), tile('t2', 'q2')],
      filters: [
        // Falls back at construction (unrecognized `selection.mode` — a HARD
        // conflict, #189): `state.sourceId` is stripped, and 'src1' — left
        // with zero consumers — is deleted entirely.
        {
          id: 'f1', parameter: 'ps', sourceQueryId: 'src1', selection: { mode: 'bogus' as 'single' },
          defaultActive: true, defaultValue: 'X',
        },
        // A genuinely healthy, source-backed filter, unrelated to 't1' — its
        // source is deliberately slow (gated) so the filter wave takes real
        // time, giving the two classifications ("affected" or not) a real
        // window in which to differ.
        { id: 'f2', parameter: 'other', sourceQueryId: 'src2' },
      ],
    });
    const session = createDashboardViewerSession(makeDeps({
      document, exec,
      queries: [
        query('q1', 'SELECT {ps:String} AS n'), // 't1' — f1's own (would-be) target
        query('q2', 'SELECT {other:String} AS n'), // 't2' — f2's real target
        query('src1', "SELECT ['x'] AS ps /* source1 */", { dashboard: { role: 'filter' } }),
        query('src2', "SELECT ['y'] AS other /* source2 */", { dashboard: { role: 'filter' } }),
      ],
    }));
    expect(byId(session, 'f1').sourceId).toBeUndefined(); // fell back
    expect(byId(session, 'f2').sourceId).toBe('src2'); // healthy, real consumer

    const done = session.start();
    await flush();
    // 't1' already ran — it was never affected by any filter wave (f1 fell
    // back and dropped its consumer-ship entirely), so it fired in the FIRST
    // (unaffected) batch, well before 'src2' — the only remaining source —
    // ever settles.
    expect(calls.some((c) => c.sql.includes('{ps:String}'))).toBe(true);
    expect(session.state.value.tiles.find((t) => t.tileId === 't1')!.status).toBe('ready');
    // 't2' — f2's real target — correctly still waits on the (gated) filter
    // wave: it has not been touched yet (still its initial idle state).
    expect(session.state.value.tiles.find((t) => t.tileId === 't2')!.status).toBe('idle');
    releaseSource2!();
    await done;
    // 't2' has now run (the affected-panel wave, once the filter wave
    // settled) — 'other' never got a committed value from the curated
    // options (nothing selected one), so it lands on 'unfilled' rather than
    // 'ready'; either way it is no longer 'idle'.
    expect(session.state.value.tiles.find((t) => t.tileId === 't2')!.status).toBe('unfilled');
  });
});
