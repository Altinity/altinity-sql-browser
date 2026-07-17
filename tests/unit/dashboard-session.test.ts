import { describe, it, expect, vi } from 'vitest';
import {
  createDashboardSession, runPool, supersedeSlot, isTextFav, TILE_CONCURRENCY,
} from '../../src/ui/dashboard/dashboard-session.js';
import type {
  DashboardSessionDeps, DashboardSessionHooks, TileSlot, TileDomHooks, KpiSourceDomHooks, FavoriteSourceResult,
} from '../../src/ui/dashboard/dashboard-session.js';
import type { KpiSourceSlot, KpiBand } from '../../src/ui/dashboard-kpi-band.js';
import type { StreamResult } from '../../src/core/stream.js';
import type { ExecuteReadRequest } from '../../src/application/query-execution-service.js';
import type { Panel, SavedQueryV2 } from '../../src/generated/json-schema.types.js';
import { savedQuery } from '../helpers/saved-query.js';

// DashboardSession (#276 Phase 3b) — the extracted route-scoped tile/filter
// execution runtime, unit-tested directly against fake deps/hooks (no App,
// no real DOM beyond the minimal slot stubs below). `renderDashboard`'s own
// integration suite (tests/unit/dashboard.test.ts) is the end-to-end safety
// net for the shell wiring; these tests are the session's own unit surface —
// pool bound/order, generation/abort semantics, filter-wave orchestration,
// and destroy() teardown.

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function makeTileSlot(overrides: Partial<TileSlot> = {}): TileSlot {
  return {
    kind: 'tile',
    card: document.createElement('div'),
    body: document.createElement('div'),
    foot: document.createElement('div'),
    gen: 0,
    status: null,
    destroy: null,
    panelState: null,
    abortController: null,
    loadLabel: null,
    ...overrides,
  };
}

function makeKpiBand(): KpiBand {
  return {
    el: document.createElement('div'),
    stream: document.createElement('div'),
    warningHost: document.createElement('div'),
    sources: [],
  };
}

function makeKpiSlot(overrides: Partial<KpiSourceSlot> = {}): KpiSourceSlot {
  const band = overrides.band || makeKpiBand();
  const slot: KpiSourceSlot = {
    kind: 'kpi-source',
    host: document.createElement('div'),
    band,
    name: 'KPI',
    explicit: { cfg: { type: 'kpi' } } as Panel,
    warnings: [],
    gen: 0,
    status: null,
    abortController: null,
    loadLabel: null,
    ...overrides,
  };
  band.sources.push(slot);
  return slot;
}

function makeTileHooks(overrides: Partial<TileDomHooks> = {}): TileDomHooks {
  return {
    setUnfilled: vi.fn(),
    setLoading: vi.fn(),
    onProgress: vi.fn(),
    applyResult: vi.fn(),
    renderText: vi.fn(),
    ...overrides,
  };
}

function makeKpiHooks(overrides: Partial<KpiSourceDomHooks> = {}): KpiSourceDomHooks {
  return {
    setUnfilled: vi.fn(),
    setLoading: vi.fn(),
    onProgress: vi.fn(),
    applyResult: vi.fn(),
    refreshBandWarnings: vi.fn(),
    ...overrides,
  };
}

function makeHooks(overrides: Partial<DashboardSessionHooks> = {}): DashboardSessionHooks {
  return {
    tile: makeTileHooks(),
    kpi: makeKpiHooks(),
    ensureSlotsBuilt: vi.fn(() => []),
    renderFilterBar: vi.fn(),
    renderFilterDiagnostics: vi.fn(),
    updateSkipNote: vi.fn(),
    disposeFilterBar: vi.fn(),
    onAuthFailed: vi.fn(),
    onRunAllStart: vi.fn(),
    onRunAllSettled: vi.fn(),
    ...overrides,
  };
}

function makeDeps(overrides: Partial<DashboardSessionDeps> = {}): DashboardSessionDeps & {
  varValuesObj: Record<string, string>;
  filterActiveObj: Record<string, boolean>;
} {
  const varValuesObj: Record<string, string> = {};
  const filterActiveObj: Record<string, boolean> = {};
  const base: DashboardSessionDeps = {
    exec: { executeRead: vi.fn(async (result: StreamResult) => result) },
    ensureFreshToken: vi.fn(async () => true),
    now: vi.fn(() => 0),
    wallNow: vi.fn(() => 0),
    recordBoundParams: vi.fn(),
    varValues: () => varValuesObj,
    filterActive: () => filterActiveObj,
    filterCuratedSeed: {},
    persistFilterCurated: vi.fn(),
    persistFilterActive: vi.fn(),
    hooks: makeHooks(),
  };
  return Object.assign(base, overrides, { varValuesObj, filterActiveObj });
}

const fav = (id: string, sql: string, panel?: Panel): SavedQueryV2 =>
  savedQuery({ id, sql, favorite: true, ...(panel ? { panel } : {}) });

// A deferred `executeRead` double: each call is queued, resolved manually via
// `resolvers`, and the AbortSignal is captured so a test can assert it aborted.
function deferredExec() {
  const signals: (AbortSignal | undefined)[] = [];
  const resolvers: Array<(out?: Partial<StreamResult>) => void> = [];
  const executeRead = vi.fn((result: StreamResult, opts: ExecuteReadRequest) => {
    signals.push(opts.signal);
    return new Promise<StreamResult>((resolve) => resolvers.push((out = {}) => {
      Object.assign(result, out);
      resolve(result);
    }));
  });
  return { executeRead, signals, resolvers };
}

describe('isTextFav', () => {
  it('is false with no explicit panel, false for a non-text panel, true for an explicit text panel', () => {
    expect(isTextFav(fav('1', 'select 1'))).toBe(false);
    expect(isTextFav(fav('2', 'select 1', { cfg: { type: 'table' } }))).toBe(false);
    expect(isTextFav(fav('3', 'select 1', { cfg: { type: 'text' } }))).toBe(true);
  });
});

describe('runPool', () => {
  it('bounds concurrency and preserves append order regardless of completion order', async () => {
    const started: number[] = [];
    const resolvers: Array<() => void> = [];
    const p = runPool([0, 1, 2, 3, 4], 2, (item, i) => {
      started.push(i);
      return new Promise<number>((resolve) => resolvers.push(() => resolve(item * 10)));
    });
    await flush();
    expect(started).toEqual([0, 1]); // only 2 in flight (limit)
    // Resolve out of order — item 1 first — the RESULT array still lands by index.
    resolvers[1]();
    await flush();
    expect(started).toEqual([0, 1, 2]);
    resolvers[0]();
    await flush();
    expect(started).toEqual([0, 1, 2, 3]);
    resolvers.slice(2).forEach((r) => r());
    await flush();
    expect(started).toEqual([0, 1, 2, 3, 4]);
    resolvers[4]();
    expect(await p).toEqual([0, 10, 20, 30, 40]);
  });

  it('a limit at or above item count runs everything immediately', async () => {
    const order: number[] = [];
    const result = await runPool([1, 2, 3], 10, async (item) => { order.push(item); return item; });
    expect(result).toEqual([1, 2, 3]);
    expect(order).toEqual([1, 2, 3]);
  });
});

describe('supersedeSlot', () => {
  it('bumps the generation and is a no-op abort when idle', () => {
    const slot = { gen: 0, abortController: null };
    expect(supersedeSlot(slot)).toBe(1);
    expect(slot.abortController).toBeNull();
  });

  it('aborts a live in-flight AbortController and clears it', () => {
    const ac = new AbortController();
    const slot = { gen: 3, abortController: ac };
    expect(supersedeSlot(slot)).toBe(4);
    expect(ac.signal.aborted).toBe(true);
    expect(slot.abortController).toBeNull();
  });
});

describe('createDashboardSession — runAll wave', () => {
  it('runs the token preflight once, marks Run-all bookkeeping, and streams every tile through exec.executeRead', async () => {
    const { executeRead, resolvers } = deferredExec();
    const slots = [makeTileSlot(), makeTileSlot()];
    const hooks = makeHooks({ ensureSlotsBuilt: vi.fn(() => slots) });
    const deps = makeDeps({ exec: { executeRead }, hooks });
    const queries = [fav('1', 'SELECT 1'), fav('2', 'SELECT 2')];
    const session = createDashboardSession(deps, { panelFavorites: queries, filterFavorites: [] });
    const p = session.runAll();
    await flush();
    expect(deps.ensureFreshToken).toHaveBeenCalledTimes(1);
    expect(hooks.onRunAllStart).toHaveBeenCalledTimes(1);
    expect(hooks.ensureSlotsBuilt).toHaveBeenCalledTimes(1);
    expect(executeRead).toHaveBeenCalledTimes(2);
    // Once per tile marking it loading up front (runPlan, before the pool
    // starts) and once more per tile when its own worker actually starts
    // (runFavoriteSource) — both re-marks are harmless (same loading chrome).
    expect(hooks.tile.setLoading).toHaveBeenCalledTimes(4);
    resolvers.splice(0).forEach((r) => r({ columns: [{ name: 'k', type: 'String' }], rows: [['a']] }));
    await p;
    expect(hooks.onRunAllSettled).toHaveBeenCalledTimes(1);
  });

  it('reuses the already-built slot array on a second Refresh (ensureSlotsBuilt called once)', async () => {
    const executeRead = vi.fn(async (result: StreamResult) => { result.columns = [{ name: 'k', type: 'String' }]; result.rows = [['a']]; return result; });
    const slots = [makeTileSlot()];
    const hooks = makeHooks({ ensureSlotsBuilt: vi.fn(() => slots) });
    const deps = makeDeps({ exec: { executeRead }, hooks });
    const session = createDashboardSession(deps, { panelFavorites: [fav('1', 'SELECT 1')], filterFavorites: [] });
    await session.runAll();
    await session.runAll();
    expect(hooks.ensureSlotsBuilt).toHaveBeenCalledTimes(1);
    expect(executeRead).toHaveBeenCalledTimes(2);
    expect(hooks.onRunAllSettled).toHaveBeenCalledTimes(2);
  });

  it('renders a text favorite synchronously with zero queries', async () => {
    const executeRead = vi.fn(async (result: StreamResult) => result);
    const slot = makeTileSlot();
    const hooks = makeHooks({ ensureSlotsBuilt: vi.fn(() => [slot]) });
    const deps = makeDeps({ exec: { executeRead }, hooks });
    const q = fav('1', 'ignored', { cfg: { type: 'text' } });
    const session = createDashboardSession(deps, { panelFavorites: [q], filterFavorites: [] });
    await session.runAll();
    expect(hooks.tile.renderText).toHaveBeenCalledWith(q, slot);
    expect(executeRead).not.toHaveBeenCalled(); // a text favorite never queries
  });

  it('auth preflight failure issues no requests and fires onAuthFailed exactly once', async () => {
    const executeRead = vi.fn(async (result: StreamResult) => result);
    const hooks = makeHooks();
    const deps = makeDeps({ exec: { executeRead }, ensureFreshToken: vi.fn(async () => false), hooks });
    const session = createDashboardSession(deps, { panelFavorites: [fav('1', 'SELECT 1')], filterFavorites: [] });
    await session.runAll();
    expect(hooks.onAuthFailed).toHaveBeenCalledTimes(1);
    expect(executeRead).not.toHaveBeenCalled();
    expect(hooks.ensureSlotsBuilt).not.toHaveBeenCalled(); // never got past the preflight
  });

  it('a KPI-source favorite dispatches through the kpi hooks and refreshes its band warnings once', async () => {
    const executeRead = vi.fn(async (result: StreamResult) => {
      result.columns = [{ name: 'n', type: 'UInt64' }];
      result.rows = [['42']];
      return result;
    });
    const band = makeKpiBand();
    const explicit: Panel = { cfg: { type: 'kpi' } };
    const slot = makeKpiSlot({ band, explicit });
    const hooks = makeHooks({ ensureSlotsBuilt: vi.fn(() => [slot]) });
    const deps = makeDeps({ exec: { executeRead }, hooks });
    const q = fav('1', 'SELECT 42 AS n', explicit);
    const session = createDashboardSession(deps, { panelFavorites: [q], filterFavorites: [] });
    await session.runAll();
    expect(hooks.kpi.setLoading).toHaveBeenCalledWith(slot);
    expect(hooks.kpi.refreshBandWarnings).toHaveBeenCalledTimes(1);
    expect(hooks.kpi.refreshBandWarnings).toHaveBeenCalledWith(band);
    expect(hooks.kpi.applyResult).toHaveBeenCalledWith(explicit, slot, expect.objectContaining({
      rows: [['42']],
    }));
  });
});

describe('createDashboardSession — generation/abort semantics (#193)', () => {
  it('a newer runAffected wave aborts the previous slot request at wave creation, before it resolves', async () => {
    const { executeRead, signals, resolvers } = deferredExec();
    const slot = makeTileSlot();
    const hooks = makeHooks({ ensureSlotsBuilt: vi.fn(() => [slot]) });
    const deps = makeDeps({ exec: { executeRead }, hooks });
    deps.varValuesObj.year = '1';
    const q = fav('1', 'SELECT {year:UInt16} AS n');
    const session = createDashboardSession(deps, { panelFavorites: [q], filterFavorites: [] });
    const p0 = session.runAll();
    await flush();
    expect(signals).toHaveLength(1);
    resolvers[0]({ columns: [{ name: 'k', type: 'String' }], rows: [['a']] });
    await p0;

    deps.varValuesObj.year = '11';
    const a = session.runAffected('year'); // wave A
    await flush();
    expect(signals).toHaveLength(2);

    deps.varValuesObj.year = '22';
    const b = session.runAffected('year'); // wave B — created before A resolves, supersedes it
    await flush();
    expect(signals).toHaveLength(3);
    expect(signals[1]!.aborted).toBe(true); // A superseded at B's CREATION
    expect(signals[2]!.aborted).toBe(false);
    resolvers[1]({ columns: [{ name: 'k', type: 'String' }], rows: [['a']] });
    resolvers[2]({ columns: [{ name: 'k', type: 'String' }], rows: [['b']] });
    await Promise.all([a, b]);
  });

  it('a queued Refresh worker superseded by a newer wave discards itself without issuing a request', async () => {
    const { executeRead, resolvers } = deferredExec();
    const slots = Array.from({ length: 8 }, () => makeTileSlot());
    const hooks = makeHooks({ ensureSlotsBuilt: vi.fn(() => slots) });
    const deps = makeDeps({ exec: { executeRead }, hooks });
    deps.varValuesObj.year = '1';
    const queries = Array.from({ length: 8 }, (_, i) => fav(String(i), `SELECT {year:UInt16} AS n${i}`));
    const session = createDashboardSession(deps, { panelFavorites: queries, filterFavorites: [] });
    const p0 = session.runAll(); // wave A: fans out 6, queues 2
    await flush();
    expect(executeRead).toHaveBeenCalledTimes(TILE_CONCURRENCY);

    deps.varValuesObj.year = '2';
    const p1 = session.runAffected('year'); // wave B supersedes every slot at CREATION
    await flush();
    expect(executeRead).toHaveBeenCalledTimes(TILE_CONCURRENCY + 6); // B's own 6 in flight

    // Drain everything; A's two queued workers dequeue AFTER B superseded them
    // and discard WITHOUT ever calling executeRead for year=1.
    while (resolvers.length) {
      resolvers.splice(0).forEach((r) => r({ columns: [{ name: 'k', type: 'String' }], rows: [['x']] }));
      await flush();
    }
    await Promise.all([p0, p1]);
    expect(executeRead).toHaveBeenCalledTimes(6 + 8); // A only ever issued 6; B issued all 8
  });

  it('a stale (superseded) response neither renders nor records recents', async () => {
    const resolvers: Array<(out: Partial<StreamResult>) => void> = [];
    const executeRead = vi.fn((result: StreamResult) => new Promise<StreamResult>((resolve) => resolvers.push((out) => {
      Object.assign(result, out);
      resolve(result);
    })));
    const slot = makeTileSlot();
    const hooks = makeHooks({ ensureSlotsBuilt: vi.fn(() => [slot]) });
    const deps = makeDeps({ exec: { executeRead }, hooks });
    deps.varValuesObj.year = '1';
    const q = fav('1', 'SELECT {year:UInt16} AS n');
    const session = createDashboardSession(deps, { panelFavorites: [q], filterFavorites: [] });
    const p0 = session.runAll();
    await flush();
    resolvers[0]({ columns: [{ name: 'k', type: 'String' }], rows: [['a'], ['a2']] });
    await p0;
    (deps.recordBoundParams as ReturnType<typeof vi.fn>).mockClear();

    deps.varValuesObj.year = '11'; // wave A (superseded below)
    const a = session.runAffected('year');
    await flush();
    deps.varValuesObj.year = '22'; // wave B supersedes A
    const b = session.runAffected('year');
    await flush();
    // B resolves first (current), then the stale A resolves late.
    resolvers[2]({ columns: [{ name: 'k', type: 'String' }], rows: [['B'], ['B2']] });
    await flush();
    resolvers[1]({ columns: [{ name: 'k', type: 'String' }], rows: [['A-stale'], ['A2']] });
    await Promise.all([a, b]);
    expect(hooks.tile.applyResult).toHaveBeenCalledTimes(2); // initial run + B; never the stale A
    expect(hooks.tile.applyResult).not.toHaveBeenCalledWith(q, slot, expect.objectContaining({
      rows: [['A-stale'], ['A2']],
    }));
    expect(deps.recordBoundParams).toHaveBeenCalledTimes(1); // only B recorded
  });
});

describe('createDashboardSession — gating (#170/#173) and FORMAT rejection (#193 req 5)', () => {
  it('an empty required {name:Type} value shows the unfilled hook and issues no request', async () => {
    const executeRead = vi.fn(async (result: StreamResult) => result);
    const slot = makeTileSlot();
    const hooks = makeHooks({ ensureSlotsBuilt: vi.fn(() => [slot]) });
    const deps = makeDeps({ exec: { executeRead }, hooks });
    const q = fav('1', 'SELECT {year:UInt16} AS n');
    const session = createDashboardSession(deps, { panelFavorites: [q], filterFavorites: [] });
    await session.runAll();
    expect(hooks.tile.setUnfilled).toHaveBeenCalledWith(slot, ['year']);
    expect(executeRead).not.toHaveBeenCalled();
    expect(hooks.updateSkipNote).toHaveBeenCalled();
  });

  it('an invalid active value shows the unfilled hook (invalid names) and issues no request', async () => {
    const executeRead = vi.fn(async (result: StreamResult) => result);
    const slot = makeTileSlot();
    const hooks = makeHooks({ ensureSlotsBuilt: vi.fn(() => [slot]) });
    const deps = makeDeps({ exec: { executeRead }, hooks });
    deps.varValuesObj.year = 'not-a-number';
    deps.filterActiveObj.year = true;
    const q = fav('1', 'SELECT {year:UInt16} AS n');
    const session = createDashboardSession(deps, { panelFavorites: [q], filterFavorites: [] });
    await session.runAll();
    expect(hooks.tile.setUnfilled).toHaveBeenCalledWith(slot, ['year']);
    expect(executeRead).not.toHaveBeenCalled();
  });

  it('a per-source serialization error (structural value/declaration mismatch) shows only its own error', async () => {
    const executeRead = vi.fn(async (result: StreamResult) => result);
    const slot = makeTileSlot();
    const hooks = makeHooks({ ensureSlotsBuilt: vi.fn(() => [slot]) });
    const deps = makeDeps({ exec: { executeRead }, hooks });
    const badValues: Record<string, unknown> = { db: ['not', 'scalar'] };
    Object.assign(deps.varValuesObj, badValues as Record<string, string>);
    deps.filterActiveObj.db = true;
    const q = fav('1', 'SELECT {db:String} AS n');
    const session = createDashboardSession(deps, { panelFavorites: [q], filterFavorites: [] });
    await session.runAll();
    expect(executeRead).not.toHaveBeenCalled();
    expect(hooks.tile.applyResult).toHaveBeenCalledWith(q, slot, expect.objectContaining({
      error: expect.stringContaining('array value'),
    }));
  });

  it('rejects an explicit FORMAT clause on an ordinary tile with a clear error and issues no request', async () => {
    const executeRead = vi.fn(async (result: StreamResult) => result);
    const slot = makeTileSlot();
    const hooks = makeHooks({ ensureSlotsBuilt: vi.fn(() => [slot]) });
    const deps = makeDeps({ exec: { executeRead }, hooks });
    const q = fav('1', 'SELECT 1 FORMAT JSON');
    const session = createDashboardSession(deps, { panelFavorites: [q], filterFavorites: [] });
    await session.runAll();
    expect(executeRead).not.toHaveBeenCalled();
    expect(hooks.tile.applyResult).toHaveBeenCalledWith(q, slot, {
      error: 'Dashboard panels require structured streaming results. Remove the explicit FORMAT clause.',
    });
  });

  it('rejects an explicit FORMAT clause on a KPI source with the KPI-owned diagnostic (no checkFormat cross-check needed)', async () => {
    const executeRead = vi.fn(async (result: StreamResult) => result);
    const explicit: Panel = { cfg: { type: 'kpi' } };
    const slot = makeKpiSlot({ explicit });
    const hooks = makeHooks({ ensureSlotsBuilt: vi.fn(() => [slot]) });
    const deps = makeDeps({ exec: { executeRead }, hooks });
    const q = fav('1', 'SELECT 1 FORMAT CSV', explicit);
    const session = createDashboardSession(deps, { panelFavorites: [q], filterFavorites: [] });
    await session.runAll();
    expect(executeRead).not.toHaveBeenCalled();
    expect(hooks.kpi.applyResult).toHaveBeenCalledWith(explicit, slot, {
      error: 'KPI panel owns the result format. Remove FORMAT CSV from the SQL.',
    });
  });
});

describe('createDashboardSession — onProgress + recordBoundParams (#193 req 4, #171)', () => {
  it('pulses onProgress with the formatted row count as chunks stream, and never twice after settling', async () => {
    const executeRead = vi.fn(async (result: StreamResult, opts: ExecuteReadRequest) => {
      result.progress.rows = 1420;
      opts.onChunk?.();
      result.columns = [{ name: 'k', type: 'String' }];
      result.rows = [['a']];
      return result;
    });
    const slot = makeTileSlot();
    const hooks = makeHooks({ ensureSlotsBuilt: vi.fn(() => [slot]) });
    const deps = makeDeps({ exec: { executeRead }, hooks });
    const q = fav('1', 'SELECT 1');
    const session = createDashboardSession(deps, { panelFavorites: [q], filterFavorites: [] });
    await session.runAll();
    expect(hooks.tile.onProgress).toHaveBeenCalledWith(slot, 'Loading… 1.4K rows');
  });

  it('records bound params only on a successful (non-errored) completion', async () => {
    const ok = vi.fn(async (result: StreamResult) => { result.columns = [{ name: 'n', type: 'UInt16' }]; result.rows = [['9']]; return result; });
    const slotOk = makeTileSlot();
    const hooksOk = makeHooks({ ensureSlotsBuilt: vi.fn(() => [slotOk]) });
    const depsOk = makeDeps({ exec: { executeRead: ok }, hooks: hooksOk });
    depsOk.varValuesObj.year = '2024';
    const qOk = fav('1', 'SELECT {year:UInt16} AS n');
    await createDashboardSession(depsOk, { panelFavorites: [qOk], filterFavorites: [] }).runAll();
    expect(depsOk.recordBoundParams).toHaveBeenCalledTimes(1);
    expect(depsOk.recordBoundParams).toHaveBeenCalledWith([
      expect.objectContaining({ name: 'year', serializedValue: '2024' }),
    ]);

    const failing = vi.fn(async (result: StreamResult) => { result.error = 'boom'; return result; });
    const slotErr = makeTileSlot();
    const hooksErr = makeHooks({ ensureSlotsBuilt: vi.fn(() => [slotErr]) });
    const depsErr = makeDeps({ exec: { executeRead: failing }, hooks: hooksErr });
    const qErr = fav('1', 'SELECT 1');
    await createDashboardSession(depsErr, { panelFavorites: [qErr], filterFavorites: [] }).runAll();
    expect(depsErr.recordBoundParams).not.toHaveBeenCalled();
  });
});

describe('createDashboardSession — Filter wave, merge, and persistence (#160/#237)', () => {
  const filterFav = (id: string, sql: string): SavedQueryV2 => savedQuery({
    id, sql, favorite: true, dashboard: { role: 'filter' },
  });

  it('runs the Filter wave before Panels, persists the curated bundle, and cascades a changed field to an affected Panel', async () => {
    const executeRead = vi.fn(async (result: StreamResult, opts: ExecuteReadRequest) => {
      if (opts.sql === 'SELECT filter_options') {
        result.columns = [{ name: 'origin', type: 'Array(String)' }];
        result.rows = [[['ATL', 'JFK']]];
        return result;
      }
      result.columns = [{ name: 'k', type: 'String' }];
      result.rows = [['a']];
      return result;
    });
    const slot = makeTileSlot();
    const hooks = makeHooks({ ensureSlotsBuilt: vi.fn(() => [slot]) });
    const deps = makeDeps({ exec: { executeRead }, hooks });
    // A stale active value the fresh options no longer contain — triggers the
    // "changed" (deactivate) branch and its cascade to the affected Panel.
    deps.varValuesObj.origin = 'stale';
    deps.filterActiveObj.origin = true;
    const queries = [fav('p', 'SELECT * FROM t WHERE origin={origin:String}')];
    const filters = [filterFav('f', 'SELECT filter_options')];
    const session = createDashboardSession(deps, { panelFavorites: queries, filterFavorites: filters });
    await session.runAll();
    expect(executeRead.mock.calls.map(([, opts]) => opts.sql)).toEqual([
      'SELECT filter_options', 'SELECT * FROM t WHERE origin={origin:String}',
    ]);
    expect(deps.persistFilterCurated).toHaveBeenCalledWith(expect.objectContaining({
      origin: expect.objectContaining({ declaredType: 'String' }),
    }));
    expect(deps.persistFilterActive).toHaveBeenCalledWith(expect.objectContaining({ origin: false }));
    expect(hooks.renderFilterBar).toHaveBeenCalled();
    expect(hooks.renderFilterDiagnostics).toHaveBeenCalled();
  });

  it('does not persist filterActive when the merge changes nothing', async () => {
    const executeRead = vi.fn(async (result: StreamResult, opts: ExecuteReadRequest) => {
      if (opts.sql === 'SELECT filter_options') {
        result.columns = [{ name: 'origin', type: 'Array(String)' }];
        result.rows = [[['ATL']]];
        return result;
      }
      result.columns = [{ name: 'k', type: 'String' }];
      result.rows = [['a']];
      return result;
    });
    const slot = makeTileSlot();
    const hooks = makeHooks({ ensureSlotsBuilt: vi.fn(() => [slot]) });
    const deps = makeDeps({ exec: { executeRead }, hooks });
    deps.varValuesObj.origin = 'ATL';
    deps.filterActiveObj.origin = true;
    const queries = [fav('p', 'SELECT * FROM t WHERE origin={origin:String}')];
    const filters = [filterFav('f', 'SELECT filter_options')];
    const session = createDashboardSession(deps, { panelFavorites: queries, filterFavorites: filters });
    await session.runAll();
    expect(deps.persistFilterActive).not.toHaveBeenCalled();
  });

  it('a failed Filter query reports a diagnostic and still runs Panels', async () => {
    const executeRead = vi.fn(async (result: StreamResult, opts: ExecuteReadRequest) => {
      if (opts.sql === 'SELECT filter_options') { result.error = 'boom'; return result; }
      result.columns = [{ name: 'k', type: 'String' }];
      result.rows = [['a']];
      return result;
    });
    const slot = makeTileSlot();
    const hooks = makeHooks({ ensureSlotsBuilt: vi.fn(() => [slot]) });
    const deps = makeDeps({ exec: { executeRead }, hooks });
    const queries = [fav('p', 'SELECT {x:String}')];
    const filters = [filterFav('f', 'SELECT filter_options')];
    const session = createDashboardSession(deps, { panelFavorites: queries, filterFavorites: filters });
    await session.runAll();
    expect(hooks.renderFilterDiagnostics).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({ code: 'filter-query-failed', sourceId: 'f' }),
    ]));
  });

  it('a Filter SQL contract violation (own diagnostic) issues no request', async () => {
    const executeRead = vi.fn(async (result: StreamResult, opts: ExecuteReadRequest) => {
      result.columns = []; result.rows = []; void opts; return result;
    });
    const slot = makeTileSlot();
    const hooks = makeHooks({ ensureSlotsBuilt: vi.fn(() => [slot]) });
    const deps = makeDeps({ exec: { executeRead }, hooks });
    const queries = [fav('p', 'SELECT 1')];
    const filters = [filterFav('f', 'SELECT 1 FORMAT CSV')];
    const session = createDashboardSession(deps, { panelFavorites: queries, filterFavorites: filters });
    await session.runAll();
    expect(executeRead.mock.calls.map(([, opts]) => opts.sql)).toEqual(['SELECT 1']); // never the Filter source
  });
});

describe('createDashboardSession — retryFilter (#237)', () => {
  const filterFav = (id: string, sql: string): SavedQueryV2 => savedQuery({
    id, sql, favorite: true, dashboard: { role: 'filter' },
  });

  it('is a no-op for an unknown sourceId (no query/slot found)', async () => {
    const deps = makeDeps();
    const session = createDashboardSession(deps, { panelFavorites: [], filterFavorites: [] });
    await session.retryFilter('nonexistent');
    expect(deps.ensureFreshToken).not.toHaveBeenCalled();
  });

  it('auth preflight failure fires onAuthFailed and never re-issues the Filter request', async () => {
    const executeRead = vi.fn(async (result: StreamResult, opts: ExecuteReadRequest) => {
      if (opts.sql === 'SELECT filter_options') { result.error = 'boom'; return result; }
      result.columns = [{ name: 'k', type: 'String' }];
      result.rows = [['a']];
      return result;
    });
    const slot = makeTileSlot();
    const hooks = makeHooks({ ensureSlotsBuilt: vi.fn(() => [slot]) });
    const deps = makeDeps({ exec: { executeRead }, hooks });
    const queries = [fav('p', 'SELECT {x:String}')];
    const filters = [filterFav('f', 'SELECT filter_options')];
    const session = createDashboardSession(deps, { panelFavorites: queries, filterFavorites: filters });
    await session.runAll();
    executeRead.mockClear();
    (deps.ensureFreshToken as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    await session.retryFilter('f');
    expect(hooks.onAuthFailed).toHaveBeenCalledTimes(1);
    expect(executeRead).not.toHaveBeenCalled();
  });

  it('retries a single failed source and cascades the reconciled value to the affected Panel', async () => {
    let attempt = 0;
    const executeRead = vi.fn(async (result: StreamResult, opts: ExecuteReadRequest) => {
      if (opts.sql === 'SELECT filter_options') {
        attempt++;
        if (attempt === 1) { result.error = 'temporary'; return result; }
        result.columns = [{ name: 'x', type: 'Array(String)' }];
        result.rows = [[['new']]];
        return result;
      }
      result.columns = [{ name: 'k', type: 'String' }];
      result.rows = [['a']];
      return result;
    });
    const slot = makeTileSlot();
    const hooks = makeHooks({ ensureSlotsBuilt: vi.fn(() => [slot]) });
    const deps = makeDeps({ exec: { executeRead }, hooks });
    deps.varValuesObj.x = 'stale';
    deps.filterActiveObj.x = true;
    const queries = [fav('p', 'SELECT {x:String}')];
    const filters = [filterFav('f', 'SELECT filter_options')];
    const session = createDashboardSession(deps, { panelFavorites: queries, filterFavorites: filters });
    await session.runAll();
    expect(attempt).toBe(1);
    executeRead.mockClear();
    await session.retryFilter('f');
    expect(attempt).toBe(2);
    // The reconciled value ('stale' isn't in the new options) deactivates and
    // cascades a re-run of the affected Panel.
    expect(executeRead.mock.calls.map(([, opts]) => opts.sql)).toEqual(['SELECT filter_options', 'SELECT {x:String}']);
  });
});

describe('createDashboardSession — runAffected before any run', () => {
  it('is a no-op before slots exist (nothing has ever run)', async () => {
    const deps = makeDeps();
    const session = createDashboardSession(deps, { panelFavorites: [fav('1', 'SELECT {x:String}')], filterFavorites: [] });
    expect(await session.runAffected('x')).toBeUndefined();
    expect(deps.ensureFreshToken).not.toHaveBeenCalled();
  });

  it('a failed auth preflight fires onAuthFailed and issues no requests', async () => {
    const executeRead = vi.fn(async (result: StreamResult) => { result.columns = [{ name: 'k', type: 'String' }]; result.rows = [['a']]; return result; });
    const slot = makeTileSlot();
    const hooks = makeHooks({ ensureSlotsBuilt: vi.fn(() => [slot]) });
    const deps = makeDeps({ exec: { executeRead }, hooks });
    const q = fav('1', 'SELECT {year:UInt16} AS n');
    const session = createDashboardSession(deps, { panelFavorites: [q], filterFavorites: [] });
    await session.runAll();
    executeRead.mockClear();
    (deps.ensureFreshToken as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    expect(await session.runAffected('year')).toBeUndefined();
    expect(hooks.onAuthFailed).toHaveBeenCalledTimes(1);
    expect(executeRead).not.toHaveBeenCalled();
  });
});

describe('createDashboardSession — getFilterField / controls', () => {
  it('exposes one control per declared {name:Type} and its field state', () => {
    const deps = makeDeps();
    const q = fav('1', 'SELECT {x:String}');
    const session = createDashboardSession(deps, { panelFavorites: [q], filterFavorites: [] });
    expect(session.controls.map((c) => c.name)).toEqual(['x']);
    expect(session.getFilterField('x', 'input').state).toBe('missing');
  });
});

describe('createDashboardSession — destroy()', () => {
  it('is safe when idle (never run)', () => {
    const deps = makeDeps();
    const session = createDashboardSession(deps, { panelFavorites: [fav('1', 'SELECT {x:String}')], filterFavorites: [] });
    expect(() => session.destroy()).not.toThrow();
    expect((deps.hooks.disposeFilterBar as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
  });

  it('aborts every in-flight tile and KPI-source request, tears down the tile chart instance, and disposes the filter bar', async () => {
    const { executeRead, signals, resolvers } = deferredExec();
    const explicit: Panel = { cfg: { type: 'kpi' } };
    // One tile with a live chart to tear down, one tile with none (destroy is
    // a no-op there), and one KPI source (never carries a `destroy` field).
    const tileWithChart = makeTileSlot({ destroy: vi.fn() });
    const tileWithoutChart = makeTileSlot();
    const kpiSlot = makeKpiSlot({ explicit });
    const hooks = makeHooks({ ensureSlotsBuilt: vi.fn(() => [tileWithChart, tileWithoutChart, kpiSlot]) });
    const deps = makeDeps({ exec: { executeRead }, hooks });
    const queries = [fav('1', 'SELECT 1'), fav('2', 'SELECT 2'), fav('3', 'SELECT 3', explicit)];
    const session = createDashboardSession(deps, { panelFavorites: queries, filterFavorites: [] });
    const p = session.runAll();
    await flush();
    expect(signals).toHaveLength(3); // no Filter favorites — the filter wave resolved instantly
    const tileDestroy = tileWithChart.destroy as ReturnType<typeof vi.fn>;
    session.destroy();
    expect(signals.every((s) => s?.aborted)).toBe(true);
    expect(tileDestroy).toHaveBeenCalledTimes(1);
    expect(tileWithChart.destroy).toBeNull();
    expect(hooks.disposeFilterBar).toHaveBeenCalledTimes(1);
    // Draining the aborted requests must never fire a hook (stale generation).
    (hooks.tile.applyResult as ReturnType<typeof vi.fn>).mockClear();
    (hooks.kpi.applyResult as ReturnType<typeof vi.fn>).mockClear();
    resolvers.splice(0).forEach((r) => r({ columns: [{ name: 'k', type: 'String' }], rows: [['a']] }));
    await p.catch(() => {});
    await flush();
    expect(hooks.tile.applyResult).not.toHaveBeenCalled();
    expect(hooks.kpi.applyResult).not.toHaveBeenCalled();
  });

  it('aborts an in-flight Filter-source request', async () => {
    const { executeRead, signals, resolvers } = deferredExec();
    const hooks = makeHooks({ ensureSlotsBuilt: vi.fn(() => []) });
    const deps = makeDeps({ exec: { executeRead }, hooks });
    const filters = [savedQuery({ id: 'f', sql: 'SELECT filter_options', favorite: true, dashboard: { role: 'filter' } })];
    const session = createDashboardSession(deps, { panelFavorites: [], filterFavorites: filters });
    const p = session.runAll();
    await flush();
    expect(signals).toHaveLength(1);
    session.destroy();
    expect(signals[0]!.aborted).toBe(true);
    expect(hooks.disposeFilterBar).toHaveBeenCalledTimes(1);
    resolvers.splice(0).forEach((r) => r({ columns: [{ name: 'origin', type: 'Array(String)' }], rows: [[['ATL']]] }));
    await p.catch(() => {});
  });

  it('is safe to call again after a Filter source already completed (no live abortController left to abort)', async () => {
    const executeRead = vi.fn(async (result: StreamResult) => {
      result.columns = [{ name: 'origin', type: 'Array(String)' }];
      result.rows = [[['ATL']]];
      return result;
    });
    const hooks = makeHooks({ ensureSlotsBuilt: vi.fn(() => []) });
    const deps = makeDeps({ exec: { executeRead }, hooks });
    const filters = [savedQuery({ id: 'f', sql: 'SELECT filter_options', favorite: true, dashboard: { role: 'filter' } })];
    const session = createDashboardSession(deps, { panelFavorites: [], filterFavorites: filters });
    await session.runAll();
    expect(() => session.destroy()).not.toThrow();
  });

  it('turns every later entry point into a no-op — an orphaned debounce timer firing after teardown issues no request and no auth preflight', async () => {
    const executeRead = vi.fn(async (result: StreamResult) => result);
    const hooks = makeHooks({ ensureSlotsBuilt: vi.fn(() => [makeTileSlot()]) });
    const deps = makeDeps({ exec: { executeRead }, hooks });
    const filters = [savedQuery({ id: 'f', sql: 'SELECT filter_options', favorite: true, dashboard: { role: 'filter' } })];
    const session = createDashboardSession(deps, { panelFavorites: [fav('1', 'SELECT {x:String}')], filterFavorites: filters });
    session.destroy();
    const preflight = deps.ensureFreshToken as ReturnType<typeof vi.fn>;
    preflight.mockClear();
    executeRead.mockClear();
    await session.runAll();
    await session.runAffected('x');
    await session.retryFilter('f');
    expect(preflight).not.toHaveBeenCalled();
    expect(executeRead).not.toHaveBeenCalled();
    expect(hooks.onAuthFailed).not.toHaveBeenCalled();
  });

  it('destroy() during a pending token preflight stops the wave — no request, no generation reserved, no onAuthFailed', async () => {
    const executeRead = vi.fn(async (result: StreamResult) => result);
    let releasePreflight!: (ok: boolean) => void;
    const ensureFreshToken = vi.fn(() => new Promise<boolean>((resolve) => { releasePreflight = resolve; }));
    const hooks = makeHooks({ ensureSlotsBuilt: vi.fn(() => [makeTileSlot()]) });
    const deps = makeDeps({ exec: { executeRead }, ensureFreshToken, hooks });
    const session = createDashboardSession(deps, { panelFavorites: [fav('1', 'SELECT 1')], filterFavorites: [] });
    const p = session.runAll();
    await flush();
    expect(ensureFreshToken).toHaveBeenCalledTimes(1);
    session.destroy();
    releasePreflight(true);
    await p;
    expect(executeRead).not.toHaveBeenCalled();
    // The failure variant must not fire onAuthFailed against a torn-down session either.
    const p2 = session.runAll();
    await p2;
    expect(hooks.onAuthFailed).not.toHaveBeenCalled();
  });
});

describe('createDashboardSession — stale-generation progress guard', () => {
  it('a superseded request\'s late buffered chunk never reaches onProgress (would corrupt the newer wave\'s live label)', async () => {
    // deferredExec captures each request's onChunk so the test can emit a
    // chunk AFTER the slot was superseded — modelling ch-client's one-last-
    // buffered-chunk-after-abort window.
    const chunks: Array<() => void> = [];
    const resolvers: Array<(v: unknown) => void> = [];
    const signals: Array<AbortSignal | undefined> = [];
    const executeRead = vi.fn((result: StreamResult, opts: { signal?: AbortSignal; onChunk?: () => void }) => {
      signals.push(opts.signal);
      if (opts.onChunk) chunks.push(opts.onChunk);
      return new Promise<StreamResult>((resolve) => { resolvers.push(() => resolve(result)); });
    });
    const slot = makeTileSlot();
    const hooks = makeHooks({ ensureSlotsBuilt: vi.fn(() => [slot]) });
    const deps = makeDeps({ exec: { executeRead }, hooks });
    const session = createDashboardSession(deps, { panelFavorites: [fav('1', 'SELECT 1')], filterFavorites: [] });
    const first = session.runAll();
    await flush();
    expect(chunks).toHaveLength(1);
    // A live chunk paints progress for the current generation…
    chunks[0]!();
    expect(hooks.tile.onProgress).toHaveBeenCalledTimes(1);
    // …then a newer wave supersedes the slot; the old request's late chunk
    // must be discarded, not forwarded to the (now-reassigned) live label.
    const second = session.runAll();
    await flush();
    (hooks.tile.onProgress as ReturnType<typeof vi.fn>).mockClear();
    chunks[0]!();
    expect(hooks.tile.onProgress).not.toHaveBeenCalled();
    resolvers.splice(0).forEach((r) => r(undefined));
    await Promise.all([first.catch(() => {}), second.catch(() => {})]);
  });
});
