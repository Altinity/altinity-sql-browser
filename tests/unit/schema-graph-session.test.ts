import { describe, it, expect, vi, type Mocked } from 'vitest';
import {
  createSchemaGraphSession, SchemaGraphAuthRequiredError,
} from '../../src/application/schema-graph-session.js';
import type {
  SchemaGraphDeps, SchemaGraphHooks, SchemaGraphTab, SchemaGraphFocus,
} from '../../src/application/schema-graph-session.js';
import type { ChCtx } from '../../src/net/ch-client.js';

// ── Small deferred + flush helpers (mirrors workbench-session.test.ts's own
// pattern: a macrotask-boundary flush is simpler/more robust than counting
// `await Promise.resolve()` calls by hand for the `ensureConfig()`/
// `getToken()` microtask chain every real call makes first). ───────────────

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

function abortError(): Error {
  const e = new Error('aborted');
  e.name = 'AbortError';
  return e;
}

// ── Fakes ────────────────────────────────────────────────────────────────────

const fakeCtx: ChCtx = {
  fetch: (() => Promise.reject(new Error('not used'))) as unknown as typeof fetch,
  origin: 'https://ch.local',
  getToken: async () => 'tok',
  refresh: async () => false,
  onSignedOut: () => {},
};

function makeTab(initial: Record<string, unknown> | null = null): SchemaGraphTab {
  return { result: initial };
}

function makeHooks(): Mocked<SchemaGraphHooks> {
  return {
    renderResults: vi.fn<SchemaGraphHooks['renderResults']>(),
    onAuthFailed: vi.fn<SchemaGraphHooks['onAuthFailed']>(),
  };
}

/** One minimal `system.tables` row — every field `buildSchemaGraph` actually
 *  requires (`database`/`name`/`engine`); everything else it reads is
 *  optional, so a test fixture never needs the full `LineageTableRow` shape
 *  (net/ch-client.ts's real loader row) — cast away at each fake's boundary,
 *  same convention as schema-catalog-service.test.ts's own `fakeLoadSchema`. */
interface FakeTableRow { database: string; name: string; engine: string; as_select?: string; create_table_query?: string }
interface FakeLineageResult { tables: FakeTableRow[]; dictionaries: unknown[] }

type LoadSchemaLineageOpts = {
  signal?: AbortSignal;
  onBase?: (base: FakeLineageResult) => void;
  onProgress?: (done: number, total: number) => void;
};

function fakeLoadSchemaLineage(
  impl: (focus: SchemaGraphFocus, opts: LoadSchemaLineageOpts) => Promise<FakeLineageResult>,
): SchemaGraphDeps['loadSchemaLineage'] {
  const fn = vi.fn((_ctx: unknown, focus: unknown, opts: unknown) => impl(focus as SchemaGraphFocus, (opts || {}) as LoadSchemaLineageOpts));
  return fn as unknown as SchemaGraphDeps['loadSchemaLineage'];
}

/** A `loadSchemaLineage` fake that never resolves on its own — only an abort
 *  of `opts.signal` settles it, with an `AbortError` rejection (mirrors real
 *  `ch.loadSchemaLineage`'s abort propagation). `onBase` still fires
 *  synchronously if provided, so a test can simulate "Phase A already drew"
 *  before cancelling. */
function hangsUntilAborted(onBaseData?: FakeLineageResult): SchemaGraphDeps['loadSchemaLineage'] {
  return fakeLoadSchemaLineage((_focus, opts) => new Promise((_resolve, reject) => {
    if (onBaseData && opts.onBase) opts.onBase(onBaseData);
    opts.signal?.addEventListener('abort', () => reject(abortError()));
  }));
}

function fakeLoadLineageTransitive(
  rows: FakeLineageResult, truncated = false,
): SchemaGraphDeps['loadLineageTransitive'] {
  return vi.fn(async () => ({ rows, truncated })) as unknown as SchemaGraphDeps['loadLineageTransitive'];
}

function fakeLoadSchemaCards(columnsByKey: Record<string, unknown[]> = {}): SchemaGraphDeps['loadSchemaCards'] {
  return vi.fn(async () => ({ columnsByKey })) as unknown as SchemaGraphDeps['loadSchemaCards'];
}

interface FakeTableDetail { columns: Array<{ name: string; type: string }>; indexes: unknown[]; partitions: unknown[]; ddl: string; comment: string }

function fakeLoadTableDetail(detail: FakeTableDetail): SchemaGraphDeps['loadTableDetail'] {
  return vi.fn(async () => detail) as unknown as SchemaGraphDeps['loadTableDetail'];
}

const emptyDetail: FakeTableDetail = { columns: [], indexes: [], partitions: [], ddl: '', comment: '' };

function makeDeps(over: Partial<SchemaGraphDeps> = {}): SchemaGraphDeps {
  return {
    ensureConfig: vi.fn(async () => null),
    getToken: vi.fn(async () => 'tok'),
    ctx: () => fakeCtx,
    loadSchemaLineage: fakeLoadSchemaLineage(async () => ({ tables: [], dictionaries: [] })),
    loadLineageTransitive: fakeLoadLineageTransitive({ tables: [], dictionaries: [] }),
    loadSchemaCards: fakeLoadSchemaCards(),
    loadTableDetail: fakeLoadTableDetail(emptyDetail),
    activeTab: () => makeTab(),
    hooks: makeHooks(),
    ...over,
  };
}

function schemaGraphOf(tab: SchemaGraphTab): {
  focus?: SchemaGraphFocus; nodes: unknown[]; edges: unknown[]; tableCount?: number;
  loading?: boolean; progress?: { done: number; total: number }; partial?: boolean; savedPositions?: Record<string, unknown>;
} {
  return (tab.result as { schemaGraph: ReturnType<typeof schemaGraphOf> }).schemaGraph;
}

// ── show() ───────────────────────────────────────────────────────────────────

describe('show()', () => {
  it('no-ops on a falsy focus, or a focus with no db', async () => {
    const hooks = makeHooks();
    const deps = makeDeps({ hooks });
    const svc = createSchemaGraphSession(deps);
    await svc.show(undefined as unknown as SchemaGraphFocus);
    await svc.show({});
    expect(hooks.renderResults).not.toHaveBeenCalled();
    expect(deps.ensureConfig).not.toHaveBeenCalled();
  });

  it('calls onAuthFailed and returns without touching the tab when signed out', async () => {
    const tab = makeTab();
    const hooks = makeHooks();
    const deps = makeDeps({ hooks, activeTab: () => tab, getToken: vi.fn(async () => null) });
    const svc = createSchemaGraphSession(deps);
    await svc.show({ db: 'd' });
    expect(hooks.onAuthFailed).toHaveBeenCalledTimes(1);
    expect(tab.result).toBeNull();
  });

  it('draws a Phase-A-only graph (no progressive callbacks) and reports tableCount', async () => {
    const tab = makeTab();
    const hooks = makeHooks();
    const deps = makeDeps({
      hooks,
      activeTab: () => tab,
      loadSchemaLineage: fakeLoadSchemaLineage(async () => ({
        tables: [{ database: 'd', name: 't', engine: 'MergeTree' }], dictionaries: [],
      })),
    });
    const svc = createSchemaGraphSession(deps);
    await svc.show({ kind: 'db', db: 'd' });
    const sg = schemaGraphOf(tab);
    expect(sg.focus).toEqual({ kind: 'db', db: 'd' });
    expect(sg.tableCount).toBe(1);
    expect(sg.loading).toBeUndefined();
    expect(hooks.renderResults).toHaveBeenCalled();
  });

  it('draws Phase A (loading, partial nodes) then merges the final Phase-B graph, reporting progress in between', async () => {
    const tab = makeTab();
    const deps = makeDeps({
      activeTab: () => tab,
      loadSchemaLineage: fakeLoadSchemaLineage(async (focus, opts) => {
        opts.onBase?.({ tables: [{ database: 'd', name: 't', engine: 'MergeTree' }], dictionaries: [] });
        opts.onProgress?.(1, 2);
        return { tables: [{ database: 'd', name: 't', engine: 'MergeTree' }, { database: 'd', name: 'v', engine: 'View', as_select: 'SELECT 1' }], dictionaries: [] };
      }),
    });
    const svc = createSchemaGraphSession(deps);
    await svc.show({ db: 'd' });
    const sg = schemaGraphOf(tab);
    expect(sg.tableCount).toBe(2); // final merge recomputes over the full table list
    expect(sg.loading).toBeUndefined();
  });

  it('a second show() before the first resolves shows the second graph only — last-triggered wins', async () => {
    const gateA = deferred<FakeLineageResult>();
    const loadSchemaLineage = fakeLoadSchemaLineage((focus) => (
      focus.db === 'a' ? gateA.promise : Promise.resolve({ tables: [{ database: 'b', name: 't', engine: 'MergeTree' }], dictionaries: [] })
    ));
    const tab = makeTab();
    const deps = makeDeps({ activeTab: () => tab, loadSchemaLineage });
    const svc = createSchemaGraphSession(deps);
    const first = svc.show({ db: 'a' });
    await flush();
    const second = svc.show({ db: 'b' });
    await second;
    expect(schemaGraphOf(tab).focus!.db).toBe('b');
    gateA.resolve({ tables: [{ database: 'a', name: 'x', engine: 'MergeTree' }], dictionaries: [] });
    await first;
    expect(schemaGraphOf(tab).focus!.db).toBe('b'); // a's stale resolution was dropped
  });

  it('a stale onBase/onProgress callback (superseded mid-fetch) is dropped', async () => {
    const gateA = deferred<FakeLineageResult>();
    let onBaseA: ((b: FakeLineageResult) => void) | undefined;
    let onProgressA: ((done: number, total: number) => void) | undefined;
    const loadSchemaLineage = fakeLoadSchemaLineage((focus, opts) => {
      if (focus.db === 'a') {
        onBaseA = opts.onBase; onProgressA = opts.onProgress;
        return gateA.promise;
      }
      return Promise.resolve({ tables: [{ database: 'b', name: 't', engine: 'MergeTree' }], dictionaries: [] });
    });
    const tab = makeTab();
    const deps = makeDeps({ activeTab: () => tab, loadSchemaLineage });
    const svc = createSchemaGraphSession(deps);
    const first = svc.show({ db: 'a' });
    await flush();
    const second = svc.show({ db: 'b' });
    await second;
    // Fire the FIRST call's now-stale progressive callbacks — must be no-ops.
    onBaseA?.({ tables: [{ database: 'a', name: 'stale', engine: 'MergeTree' }], dictionaries: [] });
    onProgressA?.(1, 1);
    expect(schemaGraphOf(tab).focus!.db).toBe('b');
    gateA.resolve({ tables: [], dictionaries: [] });
    await first;
    expect(schemaGraphOf(tab).focus!.db).toBe('b');
  });

  it('an AbortError leaves the pane alone (cancel() already settled it)', async () => {
    const tab = makeTab();
    const deps = makeDeps({ activeTab: () => tab, loadSchemaLineage: hangsUntilAborted() });
    const svc = createSchemaGraphSession(deps);
    const pending = svc.show({ db: 'd' });
    await flush();
    svc.cancel(); // aborts, no clearResult
    await pending;
    // The placeholder from show()'s own synchronous write is still there —
    // cancel() without clearResult never touches it.
    expect(schemaGraphOf(tab).loading).toBe(true);
  });

  it('a genuine (non-abort) fetch failure sets an error result', async () => {
    const tab = makeTab();
    const deps = makeDeps({
      activeTab: () => tab,
      loadSchemaLineage: fakeLoadSchemaLineage(async () => { throw new Error('boom'); }),
    });
    const svc = createSchemaGraphSession(deps);
    await svc.show({ db: 'd' });
    expect((tab.result as { error?: string }).error).toBe('boom');
  });

  it('a superseded fetch failure is dropped, not surfaced on the newer result', async () => {
    const gateA = deferred<FakeLineageResult>();
    const loadSchemaLineage = fakeLoadSchemaLineage((focus) => (
      focus.db === 'a' ? gateA.promise : Promise.resolve({ tables: [{ database: 'b', name: 't', engine: 'MergeTree' }], dictionaries: [] })
    ));
    const tab = makeTab();
    const deps = makeDeps({ activeTab: () => tab, loadSchemaLineage });
    const svc = createSchemaGraphSession(deps);
    const first = svc.show({ db: 'a' });
    await flush();
    const second = svc.show({ db: 'b' });
    await second;
    gateA.reject(new Error('stale failure'));
    await first;
    expect((tab.result as { error?: string | null }).error).toBeNull(); // newResult()'s own default — never overwritten by the stale rejection
    expect(schemaGraphOf(tab).focus!.db).toBe('b');
  });

  it('stringifies a non-Error throw', async () => {
    const tab = makeTab();
    const deps = makeDeps({
      activeTab: () => tab,
      loadSchemaLineage: fakeLoadSchemaLineage(async () => { throw 'plain-string-throw'; }),
    });
    const svc = createSchemaGraphSession(deps);
    await svc.show({ db: 'd' });
    expect((tab.result as { error?: string }).error).toBe('plain-string-throw');
  });
});

// ── cancel() ─────────────────────────────────────────────────────────────────

describe('cancel()', () => {
  it('no-ops when nothing is in flight', () => {
    const hooks = makeHooks();
    const deps = makeDeps({ hooks });
    const svc = createSchemaGraphSession(deps);
    svc.cancel();
    svc.cancel({ clearResult: true });
    expect(hooks.renderResults).not.toHaveBeenCalled();
  });

  it('with clearResult and no schemaGraph on the tab, no-ops', () => {
    const tab = makeTab({ notASchemaGraphResult: true });
    const hooks = makeHooks();
    const deps = makeDeps({ hooks, activeTab: () => tab });
    const svc = createSchemaGraphSession(deps);
    svc.cancel({ clearResult: true });
    expect(hooks.renderResults).not.toHaveBeenCalled();
    expect(tab.result).toEqual({ notASchemaGraphResult: true });
  });

  it('with clearResult but the graph already finished loading, no-ops', async () => {
    const tab = makeTab();
    const hooks = makeHooks();
    const deps = makeDeps({
      hooks,
      activeTab: () => tab,
      loadSchemaLineage: fakeLoadSchemaLineage(async () => ({ tables: [], dictionaries: [] })),
    });
    const svc = createSchemaGraphSession(deps);
    await svc.show({ db: 'd' });
    hooks.renderResults.mockClear();
    svc.cancel({ clearResult: true });
    expect(hooks.renderResults).not.toHaveBeenCalled();
  });

  it('keeps a partial Phase-A graph (marked partial, loading cleared) when nodes had already drawn', async () => {
    const tab = makeTab();
    const deps = makeDeps({
      activeTab: () => tab,
      loadSchemaLineage: hangsUntilAborted({ tables: [{ database: 'd', name: 't', engine: 'MergeTree' }], dictionaries: [] }),
    });
    const svc = createSchemaGraphSession(deps);
    const pending = svc.show({ db: 'd' });
    await flush();
    expect(schemaGraphOf(tab).nodes.length).toBeGreaterThan(0);
    svc.cancel({ clearResult: true });
    const sg = schemaGraphOf(tab);
    expect(sg.loading).toBe(false);
    expect(sg.partial).toBe(true);
    expect(sg.nodes.length).toBeGreaterThan(0);
    await pending; // the aborted fetch rejecting afterward must not resurrect loading
    expect(schemaGraphOf(tab).loading).toBe(false);
  });

  it('clears the result to null when cancelled before Phase A drew any node', async () => {
    const tab = makeTab();
    const deps = makeDeps({ activeTab: () => tab, loadSchemaLineage: hangsUntilAborted() });
    const svc = createSchemaGraphSession(deps);
    const pending = svc.show({ db: 'd' });
    await flush();
    expect(schemaGraphOf(tab).nodes).toEqual([]);
    svc.cancel({ clearResult: true });
    expect(tab.result).toBeNull();
    await pending;
    expect(tab.result).toBeNull(); // stays cleared — no stray write from the aborted fetch
  });
});

// ── expand() ─────────────────────────────────────────────────────────────────

describe('expand()', () => {
  it('throws SchemaGraphAuthRequiredError and calls onAuthFailed when signed out', async () => {
    const hooks = makeHooks();
    const deps = makeDeps({ hooks, getToken: vi.fn(async () => null) });
    const svc = createSchemaGraphSession(deps);
    await expect(svc.expand({ db: 'd' })).rejects.toBeInstanceOf(SchemaGraphAuthRequiredError);
    await expect(svc.expand({ db: 'd' })).rejects.toThrow('Sign in to view the schema graph.');
    expect(hooks.onAuthFailed).toHaveBeenCalledTimes(2);
  });

  it('resolves the rich-card dataset (nodes/edges/focus/truncated/savedPositions)', async () => {
    const deps = makeDeps({
      loadLineageTransitive: fakeLoadLineageTransitive(
        { tables: [{ database: 'd', name: 't', engine: 'MergeTree' }], dictionaries: [] }, false,
      ),
    });
    const svc = createSchemaGraphSession(deps);
    const data = await svc.expand({ kind: 'db', db: 'd' });
    expect(data.focus).toEqual({ kind: 'db', db: 'd' });
    expect(data.nodes.length).toBe(1);
    expect(data.nodes[0].card).toBeDefined();
    expect(data.truncated).toBe(false);
    expect(data.savedPositions).toEqual({});
  });

  it('truncated is true when either the transitive load or the expansion truncated', async () => {
    const deps = makeDeps({
      loadLineageTransitive: fakeLoadLineageTransitive({ tables: [], dictionaries: [] }, true),
    });
    const svc = createSchemaGraphSession(deps);
    const data = await svc.expand({ db: 'd' });
    expect(data.truncated).toBe(true);
  });

  it('reuses the same savedPositions object across repeated expands of the same result', async () => {
    const tab = makeTab();
    const deps = makeDeps({
      activeTab: () => tab,
      loadSchemaLineage: fakeLoadSchemaLineage(async () => ({
        tables: [{ database: 'd', name: 't', engine: 'MergeTree' }], dictionaries: [],
      })),
      loadLineageTransitive: fakeLoadLineageTransitive(
        { tables: [{ database: 'd', name: 't', engine: 'MergeTree' }], dictionaries: [] },
      ),
    });
    const svc = createSchemaGraphSession(deps);
    await svc.show({ db: 'd' }); // sets tab.result.schemaGraph
    const first = await svc.expand({ db: 'd' });
    expect(schemaGraphOf(tab).savedPositions).toBe(first.savedPositions);
    const second = await svc.expand({ db: 'd' });
    expect(second.savedPositions).toBe(first.savedPositions); // same map reused
  });

  it('tolerates a focus with no db (expandLineage seedDb falls back to empty string)', async () => {
    const deps = makeDeps();
    const svc = createSchemaGraphSession(deps);
    await expect(svc.expand({})).resolves.toMatchObject({ truncated: false });
  });

  it('propagates a generic fetch/build failure as-is (the shell maps it to view.fail)', async () => {
    const deps = makeDeps({
      loadLineageTransitive: vi.fn(async () => { throw new Error('lineage boom'); }) as unknown as SchemaGraphDeps['loadLineageTransitive'],
    });
    const svc = createSchemaGraphSession(deps);
    await expect(svc.expand({ db: 'd' })).rejects.toThrow('lineage boom');
  });
});

// ── loadNodeDetail() ─────────────────────────────────────────────────────────

describe('loadNodeDetail()', () => {
  it('returns null without fetching when the node is missing db or name', async () => {
    const loadTableDetail = fakeLoadTableDetail(emptyDetail);
    const deps = makeDeps({ loadTableDetail });
    const svc = createSchemaGraphSession(deps);
    expect(await svc.loadNodeDetail({ db: 'd' }, {})).toBeNull();
    expect(await svc.loadNodeDetail({ name: 't' }, {})).toBeNull();
    expect(await svc.loadNodeDetail(null as unknown as SchemaGraphFocus, {})).toBeNull();
    expect(loadTableDetail).not.toHaveBeenCalled();
  });

  it('resolves the fetched detail for a complete node', async () => {
    const detail: FakeTableDetail = { ...emptyDetail, ddl: 'CREATE TABLE d.t (...)' };
    const deps = makeDeps({ loadTableDetail: fakeLoadTableDetail(detail) });
    const svc = createSchemaGraphSession(deps);
    const result = await svc.loadNodeDetail({ db: 'd', name: 't' }, {});
    expect(result).toEqual(detail);
  });

  it('last-clicked wins: a later click on the same token supersedes an earlier, slower one', async () => {
    const gate = deferred<FakeTableDetail>();
    const loadTableDetail = vi.fn((_ctx: unknown, db: string) => (
      db === 'slow' ? gate.promise : Promise.resolve({ ...emptyDetail, comment: 'fast' })
    )) as unknown as SchemaGraphDeps['loadTableDetail'];
    const deps = makeDeps({ loadTableDetail });
    const svc = createSchemaGraphSession(deps);
    const token = {};
    const nodeSlow = { db: 'slow', name: 'events' };
    const nodeFast = { db: 'fast', name: 'mv' };
    const first = svc.loadNodeDetail(nodeSlow, token);
    const second = svc.loadNodeDetail(nodeFast, token);
    expect(await second).toEqual({ ...emptyDetail, comment: 'fast' });
    gate.resolve({ ...emptyDetail, comment: 'stale' });
    expect(await first).toBeNull(); // superseded by nodeFast on the same token
  });

  it('two different tokens (overlay surfaces) track their own last-clicked node independently', async () => {
    const deps = makeDeps({ loadTableDetail: fakeLoadTableDetail({ ...emptyDetail, comment: 'x' }) });
    const svc = createSchemaGraphSession(deps);
    const tokenA = {};
    const tokenB = {};
    const [a, b] = await Promise.all([
      svc.loadNodeDetail({ db: 'd', name: 'a' }, tokenA),
      svc.loadNodeDetail({ db: 'd', name: 'b' }, tokenB),
    ]);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
  });
});
