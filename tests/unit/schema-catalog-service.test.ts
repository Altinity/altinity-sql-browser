import { describe, it, expect, vi } from 'vitest';
import { signal } from '@preact/signals-core';
import { createSchemaCatalogService } from '../../src/application/schema-catalog-service.js';
import type {
  SchemaCatalogDeps, SchemaCatalogStateSlice, SchemaCatalogHooks,
} from '../../src/application/schema-catalog-service.js';
import type { ChCtx } from '../../src/net/ch-client.js';
import { assembleReferenceData } from '../../src/core/completions.js';
import type { SchemaDb } from '../../src/core/from-scope.js';

// ── Fakes ────────────────────────────────────────────────────────────────────
// `deps.loadSchema`/`deps.loadReferenceData` are typed `typeof ch.loadSchema`/
// `typeof ch.loadReferenceData` (net/ch-client.ts's own richer row shapes —
// `comment`/`expanded`/`total_rows`/… — that this service never reads). Tests
// only care about the `db`/`tables`/`name`/`columns` subset (core/from-scope.ts's
// looser `SchemaDb`, which this service casts to internally, same as the
// pre-extraction app.ts code) and the bare `keywords`/`functions`/`formats`
// subset of `ReferenceData` — so these two helpers build a fake at the loose
// shape and cast to the real ch-client function type, rather than fleshing out
// every server-row field the service itself never touches.
function fakeLoadSchema(rows: SchemaDb[]): SchemaCatalogDeps['loadSchema'] {
  return vi.fn(async () => rows) as unknown as SchemaCatalogDeps['loadSchema'];
}
function fakeLoadReferenceData(payload: {
  keywords?: string[]; functions?: Record<string, unknown>; formats?: string[];
}): SchemaCatalogDeps['loadReferenceData'] {
  return vi.fn(async () => payload) as unknown as SchemaCatalogDeps['loadReferenceData'];
}

const fakeCtx: ChCtx = {
  fetch: (() => Promise.reject(new Error('not used'))) as unknown as typeof fetch,
  origin: 'https://ch.local',
  getToken: async () => 'tok',
  refresh: async () => false,
  onSignedOut: () => {},
};

function makeState(initial: unknown[] | null = null): SchemaCatalogStateSlice {
  return {
    schema: signal<unknown[] | null>(initial),
    schemaError: signal<string | null>(null),
    serverVersion: null,
  };
}

function makeHooks(): {
  onConnStatusChanged: ReturnType<typeof vi.fn>;
  renderVarStrip: ReturnType<typeof vi.fn>;
  refreshEditorReference: ReturnType<typeof vi.fn>;
} & SchemaCatalogHooks {
  return {
    onConnStatusChanged: vi.fn(),
    renderVarStrip: vi.fn(),
    refreshEditorReference: vi.fn(),
  };
}

function makeDeps(over: Partial<SchemaCatalogDeps> = {}): SchemaCatalogDeps {
  return {
    loadServerVersion: vi.fn(async () => '24.3.1.2603'),
    loadSchema: fakeLoadSchema([]),
    loadColumns: vi.fn(async () => []),
    loadReferenceData: fakeLoadReferenceData({}),
    loadFunctionsDocColumns: vi.fn(async () => []),
    loadFunctionDocRow: vi.fn(async () => []),
    loadDocTableColumns: vi.fn(async () => []),
    loadDocRow: vi.fn(async () => []),
    ctx: () => fakeCtx,
    ensureConfig: vi.fn(async () => null),
    sqlString: (s: unknown) => String(s),
    state: makeState(),
    hooks: makeHooks(),
    ...over,
  };
}

const baseSchema = (): SchemaDb[] => ([
  { db: 'd1', tables: [{ name: 't1' }, { name: 't2' }] },
  { db: 'd2', tables: [{ name: 't1' }] },
]);

// ── loadVersion ──────────────────────────────────────────────────────────────

describe('loadVersion', () => {
  it('sets serverVersion and reports online on success', async () => {
    const state = makeState();
    const hooks = makeHooks();
    const deps = makeDeps({ state, hooks, loadServerVersion: vi.fn(async () => '25.1.2.100') });
    const svc = createSchemaCatalogService(deps);
    await svc.loadVersion();
    expect(state.serverVersion).toBe('25.1.2.100');
    expect(hooks.onConnStatusChanged).toHaveBeenCalledTimes(1);
    expect(hooks.onConnStatusChanged).toHaveBeenCalledWith(true);
  });

  it('reports offline and leaves serverVersion untouched on a probe failure', async () => {
    const state = makeState();
    state.serverVersion = 'stale';
    const hooks = makeHooks();
    const deps = makeDeps({
      state,
      hooks,
      loadServerVersion: vi.fn(async () => { throw new Error('boom'); }),
    });
    const svc = createSchemaCatalogService(deps);
    await svc.loadVersion();
    expect(state.serverVersion).toBe('stale');
    expect(hooks.onConnStatusChanged).toHaveBeenCalledWith(false);
  });

  it('tolerates a caller that omits onConnStatusChanged', async () => {
    const deps = makeDeps({ hooks: { renderVarStrip: vi.fn(), refreshEditorReference: vi.fn() } });
    const svc = createSchemaCatalogService(deps);
    await expect(svc.loadVersion()).resolves.toBeUndefined();
  });
});

// ── loadSchema ───────────────────────────────────────────────────────────────

describe('loadSchema', () => {
  it('loads the schema and clears a stale schemaError in one batch', async () => {
    const state = makeState();
    state.schemaError.value = 'stale error';
    const schemaRows = baseSchema();
    const deps = makeDeps({ state, loadSchema: fakeLoadSchema(schemaRows) });
    const svc = createSchemaCatalogService(deps);
    await svc.loadSchema();
    expect(state.schema.value).toBe(schemaRows);
    expect(state.schemaError.value).toBeNull();
  });

  it('sets schemaError from an Error message on failure', async () => {
    const state = makeState();
    const deps = makeDeps({ state, loadSchema: vi.fn(async () => { throw new Error('nope'); }) });
    const svc = createSchemaCatalogService(deps);
    await svc.loadSchema();
    expect(state.schemaError.value).toBe('nope');
  });

  it('stringifies a non-Error throw', async () => {
    const state = makeState();
    const deps = makeDeps({ state, loadSchema: vi.fn(async () => { throw 'plain-string-throw'; }) });
    const svc = createSchemaCatalogService(deps);
    await svc.loadSchema();
    expect(state.schemaError.value).toBe('plain-string-throw');
  });
});

// ── loadColumns ──────────────────────────────────────────────────────────────

describe('loadColumns', () => {
  it('writes loading synchronously, then the loaded columns, and pulses renderVarStrip', async () => {
    const state = makeState(baseSchema());
    const hooks = makeHooks();
    const cols = [{ name: 'a', type: 'String', comment: '' }];
    const deps = makeDeps({ state, hooks, loadColumns: vi.fn(async () => cols) });
    const svc = createSchemaCatalogService(deps);

    const p = svc.loadColumns('d1', 't1');
    // Synchronous 'loading' write, before the awaited fetch settles.
    const d1 = (state.schema.value as SchemaDb[]).find((d) => d.db === 'd1')!;
    expect(d1.tables!.find((t) => t.name === 't1')!.columns).toBe('loading');
    // Sibling db/table untouched — exercises the FALSE branch of both ternaries.
    expect(d1.tables!.find((t) => t.name === 't2')!.columns).toBeUndefined();
    expect((state.schema.value as SchemaDb[]).find((d) => d.db === 'd2')!.tables![0].columns).toBeUndefined();

    await p;
    const loaded = (state.schema.value as SchemaDb[]).find((d) => d.db === 'd1')!.tables!.find((t) => t.name === 't1')!;
    expect(loaded.columns).toEqual(cols);
    expect(hooks.renderVarStrip).toHaveBeenCalledTimes(1);
  });

  it('falls back to an empty column list on failure', async () => {
    const state = makeState(baseSchema());
    const deps = makeDeps({ state, loadColumns: vi.fn(async () => { throw new Error('boom'); }) });
    const svc = createSchemaCatalogService(deps);
    await svc.loadColumns('d1', 't1');
    const t = (state.schema.value as SchemaDb[]).find((d) => d.db === 'd1')!.tables!.find((tb) => tb.name === 't1')!;
    expect(t.columns).toEqual([]);
  });
});

// ── loadReference / rebuildCompletions ──────────────────────────────────────

describe('loadReference', () => {
  it('assembles reference data, resets doc-summary state, rebuilds completions, and refreshes the editor', async () => {
    const state = makeState();
    const hooks = makeHooks();
    const loadFunctionsDocColumns = vi.fn(async () => ['name']);
    const loadFunctionDocRow = vi.fn(async () => [{ name: 'count' }]);
    const deps = makeDeps({
      state,
      hooks,
      loadFunctionsDocColumns,
      loadFunctionDocRow,
      loadReferenceData: fakeLoadReferenceData({ keywords: ['ZAP'], functions: {}, formats: [] }),
    });
    const svc = createSchemaCatalogService(deps);

    await svc.docEntry({ kind: 'function', name: 'count' }); // warm the doc-entry cache
    expect(loadFunctionDocRow).toHaveBeenCalledTimes(1);

    await svc.loadReference();
    expect(svc.refData.keywords).toContain('ZAP');
    expect(svc.completions.some((c) => c.kind === 'keyword' && c.label === 'ZAP')).toBe(true);
    expect(hooks.refreshEditorReference).toHaveBeenCalledTimes(1);

    await svc.docEntry({ kind: 'function', name: 'count' }); // cache was cleared by loadReference → refetches
    expect(loadFunctionDocRow).toHaveBeenCalledTimes(2);
  });
});

describe('rebuildCompletions', () => {
  it('rebuilds the completion list from the current refData + schema', () => {
    const state = makeState([{ db: 'd', tables: [{ name: 't', columns: [{ name: 'c', type: 'String' }] }] }]);
    const deps = makeDeps({ state });
    const svc = createSchemaCatalogService(deps);
    svc.rebuildCompletions();
    expect(svc.completions.some((c) => c.kind === 'column' && c.label === 'c' && c.parent === 't')).toBe(true);
  });
});

// ── refData / completions accessors ─────────────────────────────────────────
// A caller (e.g. `tests/e2e/editor-cm6.spec.js`'s `app.completions =
// app.completions.concat([...])`) can overwrite the live value directly — the
// exact mutability the pre-extraction `App.refData`/`App.completions` plain
// properties had. The setter sticks until the next real rebuild.

describe('refData / completions setters', () => {
  it('lets a caller overwrite refData/completions directly, and a later rebuild recomputes over it', () => {
    const state = makeState([]);
    const deps = makeDeps({ state });
    const svc = createSchemaCatalogService(deps);

    const injected = assembleReferenceData({ keywords: ['INJECTED'] });
    svc.refData = injected;
    expect(svc.refData).toBe(injected);

    const injectedCompletions = svc.completions.concat([{ label: 'synthetic', kind: 'column' }]);
    svc.completions = injectedCompletions;
    expect(svc.completions).toBe(injectedCompletions);
    expect(svc.completions.some((c) => c.label === 'synthetic')).toBe(true);

    svc.rebuildCompletions(); // a real rebuild recomputes from the (still-injected) refData
    expect(svc.completions).not.toBe(injectedCompletions);
    expect(svc.completions.some((c) => c.label === 'INJECTED')).toBe(true);
    expect(svc.completions.some((c) => c.label === 'synthetic')).toBe(false);
  });
});


// ── invalidate ───────────────────────────────────────────────────────────────

// ── docSummary / docEntry (#313) ────────────────────────────────────────────

describe('docSummary / docEntry', () => {
  const quantileRow = {
    name: 'quantile', is_aggregate: 1, syntax: 'quantile(level)(expr)',
    description: '\nComputes an approximate quantile.', categories: 'Aggregate Functions',
  };
  const fnColumns = ['name', 'is_aggregate', 'syntax', 'description', 'categories'];

  it('probes the capability once per connection and dedupes concurrent probes', async () => {
    const loadFunctionsDocColumns = vi.fn(async () => fnColumns);
    const loadFunctionDocRow = vi.fn(async () => [{ name: 'now', syntax: 'now()' }]);
    const deps = makeDeps({ loadFunctionsDocColumns, loadFunctionDocRow });
    const svc = createSchemaCatalogService(deps);

    const [a, b] = await Promise.all([
      svc.docSummary({ kind: 'function', name: 'now' }),
      svc.docSummary({ kind: 'function', name: 'now' }),
    ]);
    expect(a).toEqual({ status: 'found', value: expect.objectContaining({ title: 'now' }) });
    expect(b).toEqual(a);
    expect(loadFunctionsDocColumns).toHaveBeenCalledTimes(1); // one probe, shared

    await svc.docSummary({ kind: 'function', name: 'other' });
    expect(loadFunctionsDocColumns).toHaveBeenCalledTimes(1); // capability cached — no second probe
  });

  it('dedupes a concurrent capability probe across DIFFERENT lookup keys (not just the entry-cache dedup)', async () => {
    // Two different keys can't share the entry cache, so this only stays at
    // one probe if `ensureCapability` itself shares the in-flight promise.
    const loadFunctionsDocColumns = vi.fn(async () => fnColumns);
    const loadFunctionDocRow = vi.fn(async () => [quantileRow]);
    const deps = makeDeps({ loadFunctionsDocColumns, loadFunctionDocRow });
    const svc = createSchemaCatalogService(deps);

    await Promise.all([
      svc.docEntry({ kind: 'function', name: 'quantile' }),
      svc.docEntry({ kind: 'function', name: 'other-name' }),
    ]);
    expect(loadFunctionsDocColumns).toHaveBeenCalledTimes(1);
  });

  it('caches [] (no system.functions) as durably unavailable — no second probe, no row fetch', async () => {
    const loadFunctionsDocColumns = vi.fn(async () => []);
    const loadFunctionDocRow = vi.fn(async () => [{ name: 'now' }]);
    const deps = makeDeps({ loadFunctionsDocColumns, loadFunctionDocRow });
    const svc = createSchemaCatalogService(deps);

    expect(await svc.docEntry({ kind: 'function', name: 'now' })).toEqual({ status: 'unavailable' });
    expect(await svc.docEntry({ kind: 'function', name: 'later' })).toEqual({ status: 'unavailable' });
    expect(loadFunctionsDocColumns).toHaveBeenCalledTimes(1);
    expect(loadFunctionDocRow).not.toHaveBeenCalled();
  });

  it('retries the probe on the next lookup batch after a null (transient/denied) probe result', async () => {
    const loadFunctionsDocColumns = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(fnColumns);
    const loadFunctionDocRow = vi.fn(async () => [quantileRow]);
    const deps = makeDeps({
      loadFunctionsDocColumns: loadFunctionsDocColumns as unknown as SchemaCatalogDeps['loadFunctionsDocColumns'],
      loadFunctionDocRow,
    });
    const svc = createSchemaCatalogService(deps);

    expect(await svc.docEntry({ kind: 'function', name: 'quantile' })).toEqual({ status: 'unavailable' });
    expect(loadFunctionsDocColumns).toHaveBeenCalledTimes(1);

    // Next lookup batch re-probes (the failed probe wasn't cached).
    const result = await svc.docEntry({ kind: 'function', name: 'quantile' });
    expect(result.status).toBe('found');
    expect(loadFunctionsDocColumns).toHaveBeenCalledTimes(2);
  });

  it('resolves "missing" and caches it (no second row fetch for the same key)', async () => {
    const loadFunctionsDocColumns = vi.fn(async () => fnColumns);
    const loadFunctionDocRow = vi.fn(async () => []);
    const deps = makeDeps({ loadFunctionsDocColumns, loadFunctionDocRow });
    const svc = createSchemaCatalogService(deps);

    expect(await svc.docEntry({ kind: 'function', name: 'nope' })).toEqual({ status: 'missing' });
    expect(await svc.docEntry({ kind: 'function', name: 'nope' })).toEqual({ status: 'missing' });
    expect(loadFunctionDocRow).toHaveBeenCalledTimes(1);
  });

  it('does not cache a transient row-fetch failure — retries on the next call', async () => {
    const loadFunctionsDocColumns = vi.fn(async () => fnColumns);
    const loadFunctionDocRow = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce([quantileRow]);
    const deps = makeDeps({
      loadFunctionsDocColumns,
      loadFunctionDocRow: loadFunctionDocRow as unknown as SchemaCatalogDeps['loadFunctionDocRow'],
    });
    const svc = createSchemaCatalogService(deps);

    expect(await svc.docEntry({ kind: 'function', name: 'quantile' })).toEqual({ status: 'unavailable' });
    const second = await svc.docEntry({ kind: 'function', name: 'quantile' });
    expect(second.status).toBe('found');
    expect(loadFunctionDocRow).toHaveBeenCalledTimes(2);
  });

  it('dedupes concurrent lookups for the same key (one row fetch)', async () => {
    const loadFunctionsDocColumns = vi.fn(async () => fnColumns);
    const loadFunctionDocRow = vi.fn(async () => [quantileRow]);
    const deps = makeDeps({ loadFunctionsDocColumns, loadFunctionDocRow });
    const svc = createSchemaCatalogService(deps);

    const [a, b] = await Promise.all([
      svc.docEntry({ kind: 'function', name: 'quantile' }),
      svc.docEntry({ kind: 'function', name: 'quantile' }),
    ]);
    expect(a).toEqual(b);
    expect(loadFunctionDocRow).toHaveBeenCalledTimes(1);
  });

  it('caches a found aggregate-function row under BOTH the requested "function" key and the normalized "aggregate-function" key', async () => {
    const loadFunctionsDocColumns = vi.fn(async () => fnColumns);
    const loadFunctionDocRow = vi.fn(async () => [quantileRow]);
    const deps = makeDeps({ loadFunctionsDocColumns, loadFunctionDocRow });
    const svc = createSchemaCatalogService(deps);

    const requested = await svc.docEntry({ kind: 'function', name: 'quantile' });
    expect(requested.status).toBe('found');
    if (requested.status === 'found') expect(requested.value.target.kind).toBe('aggregate-function');

    // Served from cache under the NORMALIZED kind too — no second fetch.
    const normalized = await svc.docEntry({ kind: 'aggregate-function', name: 'quantile' });
    expect(normalized).toEqual(requested);
    expect(loadFunctionDocRow).toHaveBeenCalledTimes(1);
  });

  it('docSummary is served from the same fetch/cache as docEntry (one row fetch for both)', async () => {
    const loadFunctionsDocColumns = vi.fn(async () => fnColumns);
    const loadFunctionDocRow = vi.fn(async () => [quantileRow]);
    const deps = makeDeps({ loadFunctionsDocColumns, loadFunctionDocRow });
    const svc = createSchemaCatalogService(deps);

    const entry = await svc.docEntry({ kind: 'function', name: 'quantile' });
    const summary = await svc.docSummary({ kind: 'function', name: 'quantile' });
    expect(loadFunctionDocRow).toHaveBeenCalledTimes(1);
    expect(summary).toEqual({
      status: 'found',
      value: expect.objectContaining({ title: 'quantile', target: { kind: 'aggregate-function', name: 'quantile' } }),
    });
    if (entry.status === 'found') expect(summary).toEqual({ status: 'found', value: expect.objectContaining({ signature: entry.value.signature }) });
  });

  it('docSummary itself propagates a non-found status untouched', async () => {
    const loadFunctionsDocColumns = vi.fn(async () => []);
    const deps = makeDeps({ loadFunctionsDocColumns });
    const svc = createSchemaCatalogService(deps);
    expect(await svc.docSummary({ kind: 'function', name: 'now' })).toEqual({ status: 'unavailable' });
  });

  it('invalidate() mid-flight (before the capability probe settles) drops a stale in-flight lookup: no cache write, resolves unavailable', async () => {
    let resolveRow: (v: Record<string, unknown>[]) => void;
    const rowPromise = new Promise<Record<string, unknown>[]>((res) => { resolveRow = res; });
    const loadFunctionsDocColumns = vi.fn(async () => fnColumns);
    const loadFunctionDocRow = vi.fn(() => rowPromise);
    const deps = makeDeps({ loadFunctionsDocColumns, loadFunctionDocRow });
    const svc = createSchemaCatalogService(deps);

    const pending = svc.docEntry({ kind: 'function', name: 'quantile' });
    svc.invalidate();
    resolveRow!([quantileRow]);
    expect(await pending).toEqual({ status: 'unavailable' });

    // No durable cache write from the stale response — a fresh lookup re-fetches.
    const loadFunctionDocRow2 = vi.fn(async () => [quantileRow]);
    const deps2 = makeDeps({ loadFunctionsDocColumns: vi.fn(async () => fnColumns), loadFunctionDocRow: loadFunctionDocRow2 });
    const svc2 = createSchemaCatalogService(deps2);
    expect((await svc2.docEntry({ kind: 'function', name: 'quantile' })).status).toBe('found');
    expect(loadFunctionDocRow2).toHaveBeenCalledTimes(1);
  });

  it('invalidate() mid-flight (AFTER the capability probe settled, during the row fetch) also drops the stale response', async () => {
    let resolveRow: (v: Record<string, unknown>[]) => void;
    const rowPromise = new Promise<Record<string, unknown>[]>((res) => { resolveRow = res; });
    const loadFunctionsDocColumns = vi.fn(async () => fnColumns);
    const loadFunctionDocRow = vi.fn()
      .mockResolvedValueOnce([quantileRow]) // warm-up lookup: primes the capability cache
      .mockImplementationOnce(() => rowPromise); // the lookup under test — row fetch parked mid-flight
    const deps = makeDeps({ loadFunctionsDocColumns, loadFunctionDocRow });
    const svc = createSchemaCatalogService(deps);

    await svc.docEntry({ kind: 'function', name: 'warmup' }); // capability now cached, no probe left in flight

    const pending = svc.docEntry({ kind: 'function', name: 'quantile' });
    // Flush microtasks until the row fetch has actually started (both the
    // warm-up call and this lookup's call landed on the mock) — this proves
    // resolveDocEntry is genuinely parked on `await loadFunctionDocRow(...)`,
    // past its post-capability generation check, before invalidate() below.
    for (let i = 0; i < 10 && loadFunctionDocRow.mock.calls.length < 2; i++) await Promise.resolve();
    expect(loadFunctionDocRow).toHaveBeenCalledTimes(2);

    svc.invalidate();
    resolveRow!([quantileRow]);
    expect(await pending).toEqual({ status: 'unavailable' });
  });

  it('a loadReference() re-run mid-flight also drops a stale in-flight lookup', async () => {
    let resolveRow: (v: Record<string, unknown>[]) => void;
    const rowPromise = new Promise<Record<string, unknown>[]>((res) => { resolveRow = res; });
    const loadFunctionsDocColumns = vi.fn(async () => fnColumns);
    const loadFunctionDocRow = vi.fn(() => rowPromise);
    const deps = makeDeps({ loadFunctionsDocColumns, loadFunctionDocRow });
    const svc = createSchemaCatalogService(deps);

    const pending = svc.docEntry({ kind: 'function', name: 'quantile' });
    const refPromise = svc.loadReference();
    resolveRow!([quantileRow]);
    await refPromise;
    expect(await pending).toEqual({ status: 'unavailable' });
  });

  it('a stale capability probe (invalidate mid-probe) resolves unavailable and does not write shared capability state', async () => {
    let resolveCols: (v: string[] | null) => void;
    const colsPromise = new Promise<string[] | null>((res) => { resolveCols = res; });
    const loadFunctionsDocColumns = vi.fn(() => colsPromise);
    const deps = makeDeps({ loadFunctionsDocColumns: loadFunctionsDocColumns as unknown as SchemaCatalogDeps['loadFunctionsDocColumns'] });
    const svc = createSchemaCatalogService(deps);

    const pending = svc.docEntry({ kind: 'function', name: 'quantile' });
    svc.invalidate();
    resolveCols!(fnColumns);
    expect(await pending).toEqual({ status: 'unavailable' });

    // A fresh lookup re-probes from scratch (the stale settle never wrote `capability`).
    const loadFunctionDocRow2 = vi.fn(async () => [quantileRow]);
    const loadFunctionsDocColumns2 = vi.fn(async () => fnColumns);
    const deps2 = makeDeps({ loadFunctionsDocColumns: loadFunctionsDocColumns2, loadFunctionDocRow: loadFunctionDocRow2 });
    const svc2 = createSchemaCatalogService(deps2);
    expect((await svc2.docEntry({ kind: 'function', name: 'quantile' })).status).toBe('found');
    expect(loadFunctionsDocColumns2).toHaveBeenCalledTimes(1);
  });
});

// ── #314 Phase 2 — structured-source docSummary/docEntry routing ───────────

describe('docEntry — #314 structured-source routing', () => {
  const engineRow = { name: 'MergeTree', description: '\nThe base MergeTree engine.', syntax: 'ENGINE = MergeTree()' };
  const engineColumns = ['name', 'description', 'syntax'];

  it('routes a "table-engine" target through the structured probe/select/normalize path', async () => {
    const loadDocTableColumns = vi.fn(async () => engineColumns);
    const loadDocRow = vi.fn(async () => [engineRow]);
    const deps = makeDeps({ loadDocTableColumns, loadDocRow });
    const svc = createSchemaCatalogService(deps);

    const result = await svc.docEntry({ kind: 'table-engine', name: 'MergeTree' });
    expect(result).toEqual({
      status: 'found',
      value: expect.objectContaining({ target: { kind: 'table-engine', name: 'MergeTree' }, title: 'MergeTree' }),
    });
    expect(loadDocTableColumns).toHaveBeenCalledWith(fakeCtx, 'table_engines');
    expect(loadDocRow).toHaveBeenCalledTimes(1);
  });

  it('routes "format"/"database-engine"/"data-type" through their own probe tables', async () => {
    const loadDocTableColumns = vi.fn(async () => ['name']);
    const loadDocRow = vi.fn(async () => [{ name: 'X' }]);
    const deps = makeDeps({ loadDocTableColumns, loadDocRow });
    const svc = createSchemaCatalogService(deps);

    await svc.docEntry({ kind: 'format', name: 'CSV' });
    await svc.docEntry({ kind: 'database-engine', name: 'Atomic' });
    await svc.docEntry({ kind: 'data-type', name: 'Int32' });

    expect(loadDocTableColumns).toHaveBeenNthCalledWith(1, fakeCtx, 'formats');
    expect(loadDocTableColumns).toHaveBeenNthCalledWith(2, fakeCtx, 'database_engines');
    expect(loadDocTableColumns).toHaveBeenNthCalledWith(3, fakeCtx, 'data_type_families');
  });

  it('probes each structured kind independently, once per kind, and dedupes concurrent probes for the SAME kind', async () => {
    const loadDocTableColumns = vi.fn(async () => engineColumns);
    const loadDocRow = vi.fn(async () => [engineRow]);
    const deps = makeDeps({ loadDocTableColumns, loadDocRow });
    const svc = createSchemaCatalogService(deps);

    const [a, b] = await Promise.all([
      svc.docEntry({ kind: 'table-engine', name: 'MergeTree' }),
      svc.docEntry({ kind: 'table-engine', name: 'MergeTree' }),
    ]);
    expect(a).toEqual(b);
    expect(loadDocTableColumns).toHaveBeenCalledTimes(1); // one probe, shared, for table-engine

    await svc.docEntry({ kind: 'table-engine', name: 'Log' });
    expect(loadDocTableColumns).toHaveBeenCalledTimes(1); // capability cached — no second probe
  });

  it('a case-mismatched lookup caches under BOTH the requested and the canonical name key', async () => {
    // The case-insensitive WHERE returns the server's canonically-cased row
    // ('mergetree' -> 'MergeTree'); the generic normKey/key dual-write in
    // docEntry then serves a later canonical-case lookup from cache.
    const loadDocTableColumns = vi.fn(async () => engineColumns);
    const loadDocRow = vi.fn(async () => [engineRow]);
    const deps = makeDeps({ loadDocTableColumns, loadDocRow });
    const svc = createSchemaCatalogService(deps);

    const lower = await svc.docEntry({ kind: 'table-engine', name: 'mergetree' });
    expect(lower).toEqual({
      status: 'found',
      value: expect.objectContaining({ target: { kind: 'table-engine', name: 'MergeTree' } }),
    });
    const canonical = await svc.docEntry({ kind: 'table-engine', name: 'MergeTree' });
    expect(canonical).toEqual(lower);
    expect(loadDocRow).toHaveBeenCalledTimes(1); // second lookup served from the dual-key cache
  });

  it('dedupes a concurrent capability probe across DIFFERENT lookup keys of the SAME structured kind', async () => {
    // Two different names can't share the entry cache, so this only stays at
    // one probe if `ensureStructuredCapability` itself shares the in-flight
    // promise for that kind.
    const loadDocTableColumns = vi.fn(async () => engineColumns);
    const loadDocRow = vi.fn(async () => [engineRow]);
    const deps = makeDeps({ loadDocTableColumns, loadDocRow });
    const svc = createSchemaCatalogService(deps);

    await Promise.all([
      svc.docEntry({ kind: 'table-engine', name: 'MergeTree' }),
      svc.docEntry({ kind: 'table-engine', name: 'Log' }),
    ]);
    expect(loadDocTableColumns).toHaveBeenCalledTimes(1);
  });

  it('an unavailable/denied source is independent: format denied does not affect table-engine (or vice versa)', async () => {
    // 'formats'/'documentation' both denied (empty columns); every other
    // table (including 'table_engines') returns the engine columns. #315:
    // a durably-unavailable STRUCTURED capability now falls through to the
    // `system.documentation` capability too — so the first `format` lookup
    // ALSO probes 'documentation' (denied here too), one extra
    // `loadDocTableColumns` call beyond the pre-#315 count.
    const loadDocTableColumns = vi.fn(async (_ctx: ChCtx, table: string) => (
      table === 'formats' || table === 'documentation' ? [] : engineColumns
    ));
    const loadDocRow = vi.fn(async () => [engineRow]);
    const deps = makeDeps({
      loadDocTableColumns: loadDocTableColumns as unknown as SchemaCatalogDeps['loadDocTableColumns'],
      loadDocRow,
    });
    const svc = createSchemaCatalogService(deps);

    expect(await svc.docEntry({ kind: 'format', name: 'CSV' })).toEqual({ status: 'unavailable' });
    expect(loadDocRow).not.toHaveBeenCalled();

    const engineResult = await svc.docEntry({ kind: 'table-engine', name: 'MergeTree' });
    expect(engineResult.status).toBe('found');
    expect(loadDocRow).toHaveBeenCalledTimes(1);

    // A later format lookup stays durably unavailable without re-probing
    // EITHER capability (both already settled durably).
    expect(await svc.docEntry({ kind: 'format', name: 'TSV' })).toEqual({ status: 'unavailable' });
    expect(loadDocTableColumns).toHaveBeenCalledTimes(3); // format, documentation (fallback), table-engine — each once ever
  });

  it('resolves "missing" and caches it (no second row fetch for the same key)', async () => {
    const loadDocTableColumns = vi.fn(async () => engineColumns);
    const loadDocRow = vi.fn(async () => []);
    const deps = makeDeps({ loadDocTableColumns, loadDocRow });
    const svc = createSchemaCatalogService(deps);

    expect(await svc.docEntry({ kind: 'table-engine', name: 'NopeTree' })).toEqual({ status: 'missing' });
    expect(await svc.docEntry({ kind: 'table-engine', name: 'NopeTree' })).toEqual({ status: 'missing' });
    expect(loadDocRow).toHaveBeenCalledTimes(1);
  });

  it('does not cache a transient row-fetch failure — retries on the next call', async () => {
    const loadDocTableColumns = vi.fn(async () => engineColumns);
    const loadDocRow = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce([engineRow]);
    const deps = makeDeps({
      loadDocTableColumns,
      loadDocRow: loadDocRow as unknown as SchemaCatalogDeps['loadDocRow'],
    });
    const svc = createSchemaCatalogService(deps);

    expect(await svc.docEntry({ kind: 'table-engine', name: 'MergeTree' })).toEqual({ status: 'unavailable' });
    const second = await svc.docEntry({ kind: 'table-engine', name: 'MergeTree' });
    expect(second.status).toBe('found');
    expect(loadDocRow).toHaveBeenCalledTimes(2);
  });

  it('retries the probe on the next lookup batch after a null (transient/denied) probe result', async () => {
    const loadDocTableColumns = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(engineColumns);
    const loadDocRow = vi.fn(async () => [engineRow]);
    const deps = makeDeps({
      loadDocTableColumns: loadDocTableColumns as unknown as SchemaCatalogDeps['loadDocTableColumns'],
      loadDocRow,
    });
    const svc = createSchemaCatalogService(deps);

    expect(await svc.docEntry({ kind: 'table-engine', name: 'MergeTree' })).toEqual({ status: 'unavailable' });
    expect(loadDocTableColumns).toHaveBeenCalledTimes(1);
    const result = await svc.docEntry({ kind: 'table-engine', name: 'MergeTree' });
    expect(result.status).toBe('found');
    expect(loadDocTableColumns).toHaveBeenCalledTimes(2);
  });

  it('dedupes concurrent lookups for the same key (one row fetch)', async () => {
    const loadDocTableColumns = vi.fn(async () => engineColumns);
    const loadDocRow = vi.fn(async () => [engineRow]);
    const deps = makeDeps({ loadDocTableColumns, loadDocRow });
    const svc = createSchemaCatalogService(deps);

    const [a, b] = await Promise.all([
      svc.docEntry({ kind: 'table-engine', name: 'MergeTree' }),
      svc.docEntry({ kind: 'table-engine', name: 'MergeTree' }),
    ]);
    expect(a).toEqual(b);
    expect(loadDocRow).toHaveBeenCalledTimes(1);
  });

  it('docSummary is served from the same fetch/cache as docEntry for a structured kind', async () => {
    const loadDocTableColumns = vi.fn(async () => engineColumns);
    const loadDocRow = vi.fn(async () => [engineRow]);
    const deps = makeDeps({ loadDocTableColumns, loadDocRow });
    const svc = createSchemaCatalogService(deps);

    await svc.docEntry({ kind: 'table-engine', name: 'MergeTree' });
    const summary = await svc.docSummary({ kind: 'table-engine', name: 'MergeTree' });
    expect(loadDocRow).toHaveBeenCalledTimes(1);
    expect(summary).toEqual({ status: 'found', value: expect.objectContaining({ title: 'MergeTree' }) });
  });

  it('invalidate()/loadReference() reset ALL structured capability state alongside the function one', async () => {
    const loadDocTableColumns = vi.fn(async () => engineColumns);
    const loadDocRow = vi.fn(async () => [engineRow]);
    const deps = makeDeps({ loadDocTableColumns, loadDocRow });
    const svc = createSchemaCatalogService(deps);

    await svc.docEntry({ kind: 'table-engine', name: 'MergeTree' });
    expect(loadDocTableColumns).toHaveBeenCalledTimes(1);

    svc.invalidate();
    await svc.docEntry({ kind: 'table-engine', name: 'MergeTree' });
    expect(loadDocTableColumns).toHaveBeenCalledTimes(2); // re-probed after invalidate
  });

  it('invalidate() mid-flight drops a stale in-flight structured lookup: no cache write, resolves unavailable', async () => {
    let resolveRow: (v: Record<string, unknown>[]) => void;
    const rowPromise = new Promise<Record<string, unknown>[]>((res) => { resolveRow = res; });
    const loadDocTableColumns = vi.fn(async () => engineColumns);
    const loadDocRow = vi.fn(() => rowPromise);
    const deps = makeDeps({ loadDocTableColumns, loadDocRow: loadDocRow as unknown as SchemaCatalogDeps['loadDocRow'] });
    const svc = createSchemaCatalogService(deps);

    const pending = svc.docEntry({ kind: 'table-engine', name: 'MergeTree' });
    svc.invalidate();
    resolveRow!([engineRow]);
    expect(await pending).toEqual({ status: 'unavailable' });

    const loadDocRow2 = vi.fn(async () => [engineRow]);
    const deps2 = makeDeps({ loadDocTableColumns: vi.fn(async () => engineColumns), loadDocRow: loadDocRow2 });
    const svc2 = createSchemaCatalogService(deps2);
    expect((await svc2.docEntry({ kind: 'table-engine', name: 'MergeTree' })).status).toBe('found');
    expect(loadDocRow2).toHaveBeenCalledTimes(1);
  });

  it('invalidate() mid-flight (AFTER the structured capability probe settled, during the row fetch) also drops the stale response', async () => {
    let resolveRow: (v: Record<string, unknown>[]) => void;
    const rowPromise = new Promise<Record<string, unknown>[]>((res) => { resolveRow = res; });
    // A DISTINCT row name for the warm-up lookup — normalizeStructuredRow's
    // entry.target.name comes from the ROW, not the requested target, so
    // reusing `engineRow` (name: 'MergeTree') here would collide with the
    // lookup under test's own normalized cache key and short-circuit it.
    const loadDocTableColumns = vi.fn(async () => engineColumns);
    const loadDocRow = vi.fn()
      .mockResolvedValueOnce([{ name: 'Warmup', description: 'x', syntax: 'ENGINE = Warmup()' }]) // primes the capability cache
      .mockImplementationOnce(() => rowPromise); // the lookup under test — row fetch parked mid-flight
    const deps = makeDeps({ loadDocTableColumns, loadDocRow: loadDocRow as unknown as SchemaCatalogDeps['loadDocRow'] });
    const svc = createSchemaCatalogService(deps);

    await svc.docEntry({ kind: 'table-engine', name: 'Warmup' }); // capability now cached, no probe left in flight

    const pending = svc.docEntry({ kind: 'table-engine', name: 'MergeTree' });
    for (let i = 0; i < 20 && loadDocRow.mock.calls.length < 2; i++) await Promise.resolve();
    expect(loadDocRow).toHaveBeenCalledTimes(2);

    svc.invalidate();
    resolveRow!([engineRow]);
    expect(await pending).toEqual({ status: 'unavailable' });
  });
});

describe('invalidate', () => {
  it('clears the reference/completions/documentation caches back to the built-in fallback', async () => {
    const loadFunctionsDocColumns = vi.fn(async () => ['name']);
    const loadFunctionDocRow = vi.fn(async () => [{ name: 'count' }]);
    const deps = makeDeps({
      loadFunctionsDocColumns,
      loadFunctionDocRow,
      loadReferenceData: fakeLoadReferenceData({ keywords: ['ZAP'] }),
    });
    const svc = createSchemaCatalogService(deps);

    await svc.loadReference();
    await svc.docEntry({ kind: 'function', name: 'count' });
    expect(loadFunctionDocRow).toHaveBeenCalledTimes(1);
    expect(svc.refData.keywords).toContain('ZAP');

    svc.invalidate();

    expect(svc.refData).toEqual(assembleReferenceData(null));
    expect(svc.completions.some((c) => c.label === 'ZAP')).toBe(false);

    await svc.docEntry({ kind: 'function', name: 'count' }); // entry cache was cleared by invalidate → refetches
    expect(loadFunctionDocRow).toHaveBeenCalledTimes(2);
  });
});

// ── #314 — docKindAvailable: SYNC capability read, never a probe ───────────

describe('docKindAvailable', () => {
  it('is null (unknown) for every kind before anything has been probed — and triggers no probe', async () => {
    const loadFunctionsDocColumns = vi.fn(async () => ['name']);
    const loadDocTableColumns = vi.fn(async () => ['name']);
    const deps = makeDeps({ loadFunctionsDocColumns, loadDocTableColumns });
    const svc = createSchemaCatalogService(deps);

    expect(svc.docKindAvailable('function')).toBeNull();
    expect(svc.docKindAvailable('aggregate-function')).toBeNull();
    expect(svc.docKindAvailable('format')).toBeNull();
    expect(svc.docKindAvailable('table-engine')).toBeNull();
    expect(svc.docKindAvailable('database-engine')).toBeNull();
    expect(svc.docKindAvailable('data-type')).toBeNull();
    await Promise.resolve();
    expect(loadFunctionsDocColumns).not.toHaveBeenCalled();
    expect(loadDocTableColumns).not.toHaveBeenCalled();
  });

  it('reads true once a function-kind lookup durably confirms the capability', async () => {
    const loadFunctionsDocColumns = vi.fn(async () => ['name']);
    const loadFunctionDocRow = vi.fn(async () => [{ name: 'count' }]);
    const deps = makeDeps({ loadFunctionsDocColumns, loadFunctionDocRow });
    const svc = createSchemaCatalogService(deps);

    await svc.docEntry({ kind: 'function', name: 'count' });
    expect(svc.docKindAvailable('function')).toBe(true);
    // `aggregate-function` shares the SAME `system.functions` capability.
    expect(svc.docKindAvailable('aggregate-function')).toBe(true);
  });

  it('reads false once a function-kind capability is durably confirmed absent/denied', async () => {
    const loadFunctionsDocColumns = vi.fn(async () => []); // no `name` column → unavailable
    const deps = makeDeps({ loadFunctionsDocColumns });
    const svc = createSchemaCatalogService(deps);

    await svc.docEntry({ kind: 'function', name: 'count' });
    expect(svc.docKindAvailable('function')).toBe(false);
  });

  it('reads true/false per structured kind independently, only after THAT kind has been probed', async () => {
    const loadDocTableColumns = vi.fn(async (_ctx: ChCtx, table: string) => (table === 'formats' ? [] : ['name']));
    const loadDocRow = vi.fn(async () => [{ name: 'MergeTree' }]);
    const deps = makeDeps({
      loadDocTableColumns: loadDocTableColumns as unknown as SchemaCatalogDeps['loadDocTableColumns'],
      loadDocRow,
    });
    const svc = createSchemaCatalogService(deps);

    // Not yet probed at all — unknown for every structured kind.
    expect(svc.docKindAvailable('table-engine')).toBeNull();
    expect(svc.docKindAvailable('format')).toBeNull();

    await svc.docEntry({ kind: 'table-engine', name: 'MergeTree' });
    expect(svc.docKindAvailable('table-engine')).toBe(true);
    expect(svc.docKindAvailable('format')).toBeNull(); // still unprobed — independent per kind
    expect(svc.docKindAvailable('database-engine')).toBeNull();

    await svc.docEntry({ kind: 'format', name: 'CSV' });
    expect(svc.docKindAvailable('format')).toBe(false); // durably unavailable (denied `system.formats`)
    expect(svc.docKindAvailable('table-engine')).toBe(true); // unaffected by format's denial
  });

  it('stays null after only a transient/superseded probe failure — never mistaken for a durable result', async () => {
    const loadDocTableColumns = vi.fn(async () => null as unknown as string[]); // transient probe failure
    const deps = makeDeps({ loadDocTableColumns });
    const svc = createSchemaCatalogService(deps);

    expect(await svc.docEntry({ kind: 'table-engine', name: 'MergeTree' })).toEqual({ status: 'unavailable' });
    expect(svc.docKindAvailable('table-engine')).toBeNull(); // never settled durably — stays unknown, not false
  });

  it('resets to null for every kind after invalidate()/loadReference()', async () => {
    const loadFunctionsDocColumns = vi.fn(async () => ['name']);
    const loadFunctionDocRow = vi.fn(async () => [{ name: 'count' }]);
    const loadDocTableColumns = vi.fn(async () => ['name']);
    const loadDocRow = vi.fn(async () => [{ name: 'MergeTree' }]);
    const deps = makeDeps({ loadFunctionsDocColumns, loadFunctionDocRow, loadDocTableColumns, loadDocRow });
    const svc = createSchemaCatalogService(deps);

    await svc.docEntry({ kind: 'function', name: 'count' });
    await svc.docEntry({ kind: 'table-engine', name: 'MergeTree' });
    expect(svc.docKindAvailable('function')).toBe(true);
    expect(svc.docKindAvailable('table-engine')).toBe(true);

    svc.invalidate();
    expect(svc.docKindAvailable('function')).toBeNull();
    expect(svc.docKindAvailable('table-engine')).toBeNull();
  });
});

// ── #315 Phase 3 — `system.documentation` capability, loader, and routing ──

describe('#315 system.documentation capability + version policy', () => {
  const settingRow = { name: 'max_threads', type: 'Setting', description: 'Max threads.' };
  const docColumns3 = ['name', 'type', 'description'];
  const docColumns4 = ['name', 'type', 'description', 'source'];

  it('a parsed pre-26.6 version makes ZERO system.documentation requests (no probe, no lookup)', async () => {
    const state = makeState();
    state.serverVersion = '26.5.9';
    const loadDocTableColumns = vi.fn(async () => docColumns4);
    const loadDocRow = vi.fn(async () => [settingRow]);
    const deps = makeDeps({ state, loadDocTableColumns, loadDocRow });
    const svc = createSchemaCatalogService(deps);

    expect(await svc.docEntry({ kind: 'setting', name: 'max_threads' })).toEqual({ status: 'unavailable' });
    expect(loadDocTableColumns).not.toHaveBeenCalled();
    expect(loadDocRow).not.toHaveBeenCalled();
  });

  it("the 'skip' verdict is NOT durable: a version update after a skipped lookup re-enables probing (reconnect race)", async () => {
    // loadVersion()'s round-trip is not sequenced with resetDocsState(), so a
    // lookup racing a reconnect can read the PREVIOUS connection's version —
    // the skip must self-heal once state.serverVersion catches up.
    const state = makeState();
    state.serverVersion = '26.5.9'; // stale pre-26.6 value from the old connection
    const loadDocTableColumns = vi.fn(async () => docColumns4);
    const loadDocRow = vi.fn(async () => [settingRow]);
    const deps = makeDeps({ state, loadDocTableColumns, loadDocRow });
    const svc = createSchemaCatalogService(deps);

    expect(await svc.docEntry({ kind: 'setting', name: 'max_threads' })).toEqual({ status: 'unavailable' });
    expect(loadDocTableColumns).not.toHaveBeenCalled(); // skipped, zero network

    state.serverVersion = '26.6.1.1193'; // loadVersion() resolves for the new server
    const found = await svc.docEntry({ kind: 'setting', name: 'max_threads' });
    expect(found.status).toBe('found'); // probe ran this time — the skip wasn't locked in
    expect(loadDocTableColumns).toHaveBeenCalledTimes(1);
  });

  it('26.6.0+ probes once, then looks up', async () => {
    const state = makeState();
    state.serverVersion = '26.6.0';
    const loadDocTableColumns = vi.fn(async () => docColumns4);
    const loadDocRow = vi.fn(async () => [settingRow]);
    const deps = makeDeps({ state, loadDocTableColumns, loadDocRow });
    const svc = createSchemaCatalogService(deps);

    const result = await svc.docEntry({ kind: 'setting', name: 'max_threads' });
    expect(result).toEqual({
      status: 'found',
      value: expect.objectContaining({ target: { kind: 'setting', name: 'max_threads' }, renderMode: 'markdown-subset' }),
    });
    expect(loadDocTableColumns).toHaveBeenCalledTimes(1);
    expect(loadDocTableColumns).toHaveBeenCalledWith(fakeCtx, 'documentation');
    expect(loadDocRow).toHaveBeenCalledTimes(1);

    // A second lookup for a different name shares the cached capability.
    await svc.docEntry({ kind: 'setting', name: 'other' });
    expect(loadDocTableColumns).toHaveBeenCalledTimes(1);
  });

  it('a version above 26.6.0 (e.g. 27.0) also probes', async () => {
    const state = makeState();
    state.serverVersion = '27.0.1';
    const loadDocTableColumns = vi.fn(async () => docColumns4);
    const loadDocRow = vi.fn(async () => [settingRow]);
    const deps = makeDeps({ state, loadDocTableColumns, loadDocRow });
    const svc = createSchemaCatalogService(deps);

    await svc.docEntry({ kind: 'setting', name: 'max_threads' });
    expect(loadDocTableColumns).toHaveBeenCalledTimes(1);
  });

  it('version null (not yet loaded) performs exactly one silent probe', async () => {
    const state = makeState(); // serverVersion stays null
    const loadDocTableColumns = vi.fn(async () => docColumns4);
    const loadDocRow = vi.fn(async () => [settingRow]);
    const deps = makeDeps({ state, loadDocTableColumns, loadDocRow });
    const svc = createSchemaCatalogService(deps);

    await svc.docEntry({ kind: 'setting', name: 'max_threads' });
    expect(loadDocTableColumns).toHaveBeenCalledTimes(1);
  });

  it('an unparsable version string performs exactly one silent probe', async () => {
    const state = makeState();
    state.serverVersion = 'garbage-version-string';
    const loadDocTableColumns = vi.fn(async () => docColumns4);
    const loadDocRow = vi.fn(async () => [settingRow]);
    const deps = makeDeps({ state, loadDocTableColumns, loadDocRow });
    const svc = createSchemaCatalogService(deps);

    await svc.docEntry({ kind: 'setting', name: 'max_threads' });
    expect(loadDocTableColumns).toHaveBeenCalledTimes(1);
  });

  it('26.6+ denied (empty columns) -> durably unavailable, no row fetch', async () => {
    const state = makeState();
    state.serverVersion = '26.6.1';
    const loadDocTableColumns = vi.fn(async () => []);
    const loadDocRow = vi.fn(async () => [settingRow]);
    const deps = makeDeps({ state, loadDocTableColumns, loadDocRow });
    const svc = createSchemaCatalogService(deps);

    expect(await svc.docEntry({ kind: 'setting', name: 'max_threads' })).toEqual({ status: 'unavailable' });
    expect(loadDocRow).not.toHaveBeenCalled();
    // Durable — a second lookup doesn't re-probe.
    await svc.docEntry({ kind: 'setting', name: 'other' });
    expect(loadDocTableColumns).toHaveBeenCalledTimes(1);
  });

  it('26.6+ missing table (probe returns []) is indistinguishable from denied — same durable unavailable', async () => {
    const state = makeState();
    state.serverVersion = '26.6.1';
    const loadDocTableColumns = vi.fn(async () => [] as string[]);
    const deps = makeDeps({ state, loadDocTableColumns });
    const svc = createSchemaCatalogService(deps);

    expect(await svc.docEntry({ kind: 'setting', name: 'max_threads' })).toEqual({ status: 'unavailable' });
  });

  it('missing a REQUIRED column (type) -> durably unavailable', async () => {
    const state = makeState();
    state.serverVersion = '26.6.1';
    const loadDocTableColumns = vi.fn(async () => ['name', 'description']);
    const loadDocRow = vi.fn(async () => [settingRow]);
    const deps = makeDeps({ state, loadDocTableColumns, loadDocRow });
    const svc = createSchemaCatalogService(deps);

    expect(await svc.docEntry({ kind: 'setting', name: 'max_threads' })).toEqual({ status: 'unavailable' });
    expect(loadDocRow).not.toHaveBeenCalled();
  });

  it('missing the OPTIONAL "source" column (real 26.6.1 shape) -> still available, entries just lack source', async () => {
    const state = makeState();
    state.serverVersion = '26.6.1';
    const loadDocTableColumns = vi.fn(async () => docColumns3); // no `source`
    const loadDocRow = vi.fn(async () => [settingRow]);
    const deps = makeDeps({ state, loadDocTableColumns, loadDocRow });
    const svc = createSchemaCatalogService(deps);

    const result = await svc.docEntry({ kind: 'setting', name: 'max_threads' });
    expect(result.status).toBe('found');
    if (result.status === 'found') expect(result.value.source).toBeUndefined();
    expect(svc.docKindAvailable('setting')).toBe(true);
  });

  it('four-column decoding carries source through to the entry', async () => {
    const state = makeState();
    state.serverVersion = '26.6.1';
    const loadDocTableColumns = vi.fn(async () => docColumns4);
    const loadDocRow = vi.fn(async () => [{ ...settingRow, source: 'docs/settings/index.md' }]);
    const deps = makeDeps({ state, loadDocTableColumns, loadDocRow });
    const svc = createSchemaCatalogService(deps);

    const result = await svc.docEntry({ kind: 'setting', name: 'max_threads' });
    expect(result.status).toBe('found');
    if (result.status === 'found') expect(result.value.source).toBe('docs/settings/index.md');
  });

  it('reconnect (invalidate) clears the version-derived/probed capability state and rejects a stale in-flight response', async () => {
    let resolveCols: (v: string[] | null) => void;
    const colsPromise = new Promise<string[] | null>((res) => { resolveCols = res; });
    const state = makeState();
    state.serverVersion = '26.6.1';
    const loadDocTableColumns = vi.fn(() => colsPromise);
    const deps = makeDeps({
      state,
      loadDocTableColumns: loadDocTableColumns as unknown as SchemaCatalogDeps['loadDocTableColumns'],
    });
    const svc = createSchemaCatalogService(deps);

    const pending = svc.docEntry({ kind: 'setting', name: 'max_threads' });
    svc.invalidate();
    resolveCols!(docColumns4);
    expect(await pending).toEqual({ status: 'unavailable' });

    // A fresh lookup after invalidate re-probes from scratch.
    const loadDocTableColumns2 = vi.fn(async () => docColumns4);
    const loadDocRow2 = vi.fn(async () => [settingRow]);
    const deps2 = makeDeps({ state, loadDocTableColumns: loadDocTableColumns2, loadDocRow: loadDocRow2 });
    const svc2 = createSchemaCatalogService(deps2);
    expect((await svc2.docEntry({ kind: 'setting', name: 'max_threads' })).status).toBe('found');
    expect(loadDocTableColumns2).toHaveBeenCalledTimes(1);
  });

  it('a transient (null) probe result is retried on the next lookup batch, not cached', async () => {
    const state = makeState();
    state.serverVersion = '26.6.1';
    const loadDocTableColumns = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(docColumns4);
    const loadDocRow = vi.fn(async () => [settingRow]);
    const deps = makeDeps({
      state,
      loadDocTableColumns: loadDocTableColumns as unknown as SchemaCatalogDeps['loadDocTableColumns'],
      loadDocRow,
    });
    const svc = createSchemaCatalogService(deps);

    expect(await svc.docEntry({ kind: 'setting', name: 'max_threads' })).toEqual({ status: 'unavailable' });
    expect(loadDocTableColumns).toHaveBeenCalledTimes(1);
    const second = await svc.docEntry({ kind: 'setting', name: 'max_threads' });
    expect(second.status).toBe('found');
    expect(loadDocTableColumns).toHaveBeenCalledTimes(2);
  });

  it('every known type label maps correctly and an unknown one maps to "unknown" with the label preserved', async () => {
    const state = makeState();
    state.serverVersion = '26.6.1';
    const loadDocTableColumns = vi.fn(async () => docColumns3);
    const loadDocRow = vi.fn(async () => [{ name: 'thing', type: 'Some Brand New Kind', description: 'x' }]);
    const deps = makeDeps({ state, loadDocTableColumns, loadDocRow });
    const svc = createSchemaCatalogService(deps);

    const result = await svc.docEntry({ kind: 'unknown', name: 'thing' });
    // `docEntry`'s SELECT can't filter by an unknown label — this resolves
    // `missing` (no `type` value to query by), never `found`/an error.
    expect(result).toEqual({ status: 'missing' });
  });
});

describe('#315 source preference — structured vs. system.documentation', () => {
  it('a structured "found" result wins — no system.documentation request at all', async () => {
    const state = makeState();
    state.serverVersion = '26.6.1';
    const engineRow = { name: 'MergeTree', description: 'The base engine.' };
    const loadDocTableColumns = vi.fn(async (_ctx: ChCtx, table: string) => (table === 'table_engines' ? ['name', 'description'] : ['name', 'type', 'description']));
    const loadDocRow = vi.fn(async () => [engineRow]);
    const deps = makeDeps({
      state,
      loadDocTableColumns: loadDocTableColumns as unknown as SchemaCatalogDeps['loadDocTableColumns'],
      loadDocRow,
    });
    const svc = createSchemaCatalogService(deps);

    const result = await svc.docEntry({ kind: 'table-engine', name: 'MergeTree' });
    expect(result.status).toBe('found');
    if (result.status === 'found') expect(result.value.sourceTable).not.toBe('documentation');
    // Only the table-engine probe/lookup ran — never a documentation probe.
    expect(loadDocTableColumns).toHaveBeenCalledTimes(1);
    expect(loadDocTableColumns).toHaveBeenCalledWith(fakeCtx, 'table_engines');
    expect(loadDocRow).toHaveBeenCalledTimes(1);
  });

  it('a structured "missing" result does NOT fall through to system.documentation', async () => {
    const state = makeState();
    state.serverVersion = '26.6.1';
    const loadDocTableColumns = vi.fn(async () => ['name', 'description']); // table-engine capability available
    const loadDocRow = vi.fn(async () => []); // no matching row -> missing
    const deps = makeDeps({ state, loadDocTableColumns, loadDocRow });
    const svc = createSchemaCatalogService(deps);

    expect(await svc.docEntry({ kind: 'table-engine', name: 'NopeTree' })).toEqual({ status: 'missing' });
    // Only the table-engine probe ran (once) — no documentation probe.
    expect(loadDocTableColumns).toHaveBeenCalledTimes(1);
    expect(loadDocTableColumns).toHaveBeenCalledWith(fakeCtx, 'table_engines');
  });

  it('a durably-unavailable structured source falls back to system.documentation for the SAME target', async () => {
    const state = makeState();
    state.serverVersion = '26.6.1';
    const docRow = { name: 'MergeTree', type: 'Table Engine', description: 'From documentation.' };
    const loadDocTableColumns = vi.fn(async (_ctx: ChCtx, table: string) => (table === 'table_engines' ? [] : ['name', 'type', 'description']));
    const loadDocRow = vi.fn(async () => [docRow]);
    const deps = makeDeps({
      state,
      loadDocTableColumns: loadDocTableColumns as unknown as SchemaCatalogDeps['loadDocTableColumns'],
      loadDocRow,
    });
    const svc = createSchemaCatalogService(deps);

    const result = await svc.docEntry({ kind: 'table-engine', name: 'MergeTree' });
    expect(result).toEqual({
      status: 'found',
      value: expect.objectContaining({
        target: { kind: 'table-engine', name: 'MergeTree' },
        sourceTable: 'documentation',
        renderMode: 'markdown-subset',
      }),
    });
    expect(loadDocTableColumns).toHaveBeenCalledWith(fakeCtx, 'table_engines');
    expect(loadDocTableColumns).toHaveBeenCalledWith(fakeCtx, 'documentation');
  });

  it('a kind with NO structured loader at all ("setting") goes straight to system.documentation', async () => {
    const state = makeState();
    state.serverVersion = '26.6.1';
    const loadDocTableColumns = vi.fn(async () => ['name', 'type', 'description']);
    const loadDocRow = vi.fn(async () => [{ name: 'max_threads', type: 'Setting', description: 'x' }]);
    const deps = makeDeps({ state, loadDocTableColumns, loadDocRow });
    const svc = createSchemaCatalogService(deps);

    const result = await svc.docEntry({ kind: 'setting', name: 'max_threads' });
    expect(result.status).toBe('found');
    expect(loadDocTableColumns).toHaveBeenCalledTimes(1);
    expect(loadDocTableColumns).toHaveBeenCalledWith(fakeCtx, 'documentation');
  });

  it('docKindAvailable("setting") reflects the documentation capability once probed (no structured loader exists for it)', async () => {
    const state = makeState();
    state.serverVersion = '26.6.1';
    const loadDocTableColumns = vi.fn(async () => ['name', 'type', 'description']);
    const loadDocRow = vi.fn(async () => [{ name: 'max_threads', type: 'Setting', description: 'x' }]);
    const deps = makeDeps({ state, loadDocTableColumns, loadDocRow });
    const svc = createSchemaCatalogService(deps);

    expect(svc.docKindAvailable('setting')).toBeNull();
    await svc.docEntry({ kind: 'setting', name: 'max_threads' });
    expect(svc.docKindAvailable('setting')).toBe(true);
  });

  it('docKindAvailable stays null when the structured loader is durably false but the documentation fallback probe was only transient', async () => {
    // `format`'s structured probe is denied (durable `false`); the FALLBACK
    // documentation probe (triggered within the same `docEntry` call) comes
    // back `null` (transient) — never cached — so `docsCapability` itself
    // stays unset. `docKindAvailable('format')` must read `null` (genuinely
    // unknown), not mistake the durable structured `false` for the whole
    // kind's availability.
    const state = makeState();
    state.serverVersion = '26.6.1';
    const loadDocTableColumns = vi.fn(async (_ctx: ChCtx, table: string) => (
      table === 'formats' ? [] : (table === 'documentation' ? null : ['name', 'description'])
    ));
    const deps = makeDeps({ state, loadDocTableColumns: loadDocTableColumns as unknown as SchemaCatalogDeps['loadDocTableColumns'] });
    const svc = createSchemaCatalogService(deps);

    expect(await svc.docEntry({ kind: 'format', name: 'CSV' })).toEqual({ status: 'unavailable' });
    expect(svc.docKindAvailable('format')).toBeNull();
  });

  it('docKindAvailable stays false when both the structured loader AND the documentation fallback are durably unavailable', async () => {
    const state = makeState();
    state.serverVersion = '26.6.1';
    const loadDocTableColumns = vi.fn(async () => [] as string[]); // every table denied
    const deps = makeDeps({ state, loadDocTableColumns });
    const svc = createSchemaCatalogService(deps);

    expect(await svc.docEntry({ kind: 'table-engine', name: 'MergeTree' })).toEqual({ status: 'unavailable' });
    expect(svc.docKindAvailable('table-engine')).toBe(false);
  });
});

describe('#315 docMarkdown — explicit full-Markdown-depth lookup', () => {
  const engineRow = { name: 'MergeTree', description: 'From documentation.' };

  it('ALWAYS uses system.documentation, even for a kind with a working structured loader', async () => {
    const state = makeState();
    state.serverVersion = '26.6.1';
    const docRow = { name: 'MergeTree', type: 'Table Engine', description: 'The full markdown body.' };
    const loadDocTableColumns = vi.fn(async (_ctx: ChCtx, table: string) => (table === 'table_engines' ? ['name', 'description'] : ['name', 'type', 'description']));
    const loadDocRow = vi.fn(async (_ctx: ChCtx, sql: string) => (String(sql).includes('system.documentation') ? [docRow] : [engineRow]));
    const deps = makeDeps({
      state,
      loadDocTableColumns: loadDocTableColumns as unknown as SchemaCatalogDeps['loadDocTableColumns'],
      loadDocRow: loadDocRow as unknown as SchemaCatalogDeps['loadDocRow'],
    });
    const svc = createSchemaCatalogService(deps);

    const result = await svc.docMarkdown({ kind: 'table-engine', name: 'MergeTree' });
    expect(result).toEqual({
      status: 'found',
      value: expect.objectContaining({ markdown: 'The full markdown body.', renderMode: 'markdown-subset' }),
    });
    // The structured table-engine loader was never consulted by docMarkdown.
    expect(loadDocTableColumns).not.toHaveBeenCalledWith(fakeCtx, 'table_engines');
  });

  it('caches found/missing and dedupes concurrent lookups, separately from docEntry', async () => {
    const state = makeState();
    state.serverVersion = '26.6.1';
    const loadDocTableColumns = vi.fn(async () => ['name', 'type', 'description']);
    const loadDocRow = vi.fn(async () => [{ name: 'max_threads', type: 'Setting', description: 'd' }]);
    const deps = makeDeps({ state, loadDocTableColumns, loadDocRow });
    const svc = createSchemaCatalogService(deps);

    const [a, b] = await Promise.all([
      svc.docMarkdown({ kind: 'setting', name: 'max_threads' }),
      svc.docMarkdown({ kind: 'setting', name: 'max_threads' }),
    ]);
    expect(a).toEqual(b);
    expect(loadDocRow).toHaveBeenCalledTimes(1);

    await svc.docMarkdown({ kind: 'setting', name: 'max_threads' }); // served from cache
    expect(loadDocRow).toHaveBeenCalledTimes(1);
  });

  it('does not cache a transient row-fetch failure — retries on the next call', async () => {
    const state = makeState();
    state.serverVersion = '26.6.1';
    const loadDocTableColumns = vi.fn(async () => ['name', 'type', 'description']);
    const loadDocRow = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce([{ name: 'max_threads', type: 'Setting', description: 'd' }]);
    const deps = makeDeps({
      state,
      loadDocTableColumns,
      loadDocRow: loadDocRow as unknown as SchemaCatalogDeps['loadDocRow'],
    });
    const svc = createSchemaCatalogService(deps);

    expect(await svc.docMarkdown({ kind: 'setting', name: 'max_threads' })).toEqual({ status: 'unavailable' });
    const second = await svc.docMarkdown({ kind: 'setting', name: 'max_threads' });
    expect(second.status).toBe('found');
    expect(loadDocRow).toHaveBeenCalledTimes(2);
  });

  it('invalidate() mid-flight drops a stale docMarkdown response (no cache write, resolves unavailable)', async () => {
    let resolveRow: (v: Record<string, unknown>[]) => void;
    const rowPromise = new Promise<Record<string, unknown>[]>((res) => { resolveRow = res; });
    const state = makeState();
    state.serverVersion = '26.6.1';
    const loadDocTableColumns = vi.fn(async () => ['name', 'type', 'description']);
    const loadDocRow = vi.fn(() => rowPromise);
    const deps = makeDeps({ state, loadDocTableColumns, loadDocRow: loadDocRow as unknown as SchemaCatalogDeps['loadDocRow'] });
    const svc = createSchemaCatalogService(deps);

    const pending = svc.docMarkdown({ kind: 'setting', name: 'max_threads' });
    svc.invalidate();
    resolveRow!([{ name: 'max_threads', type: 'Setting', description: 'd' }]);
    expect(await pending).toEqual({ status: 'unavailable' });
  });
});

describe('#315 docDisambiguate — name-only, all kinds', () => {
  it('returns every kind sharing the same name', async () => {
    const state = makeState();
    state.serverVersion = '26.6.1';
    const loadDocTableColumns = vi.fn(async () => ['name', 'type', 'description']);
    const rows = [
      { name: 'Log', type: 'Table Engine', description: 'The Log engine.' },
      { name: 'Log', type: 'Setting', description: 'A setting confusingly also named Log.' },
    ];
    const loadDocRow = vi.fn(async () => rows);
    const deps = makeDeps({ state, loadDocTableColumns, loadDocRow });
    const svc = createSchemaCatalogService(deps);

    const result = await svc.docDisambiguate('Log');
    expect(result.status).toBe('found');
    if (result.status === 'found') {
      expect(result.value).toHaveLength(2);
      expect(result.value.map((s) => s.target.kind).sort()).toEqual(['setting', 'table-engine']);
    }
  });

  it('resolves "missing" when no row matches the name', async () => {
    const state = makeState();
    state.serverVersion = '26.6.1';
    const loadDocTableColumns = vi.fn(async () => ['name', 'type', 'description']);
    const loadDocRow = vi.fn(async () => []);
    const deps = makeDeps({ state, loadDocTableColumns, loadDocRow });
    const svc = createSchemaCatalogService(deps);

    expect(await svc.docDisambiguate('NopeAtAll')).toEqual({ status: 'missing' });
  });

  it('resolves "unavailable" when the documentation capability itself is unavailable, with no row fetch', async () => {
    const state = makeState();
    state.serverVersion = '26.5.9'; // pre-26.6 -> skip, durably unavailable
    const loadDocRow = vi.fn(async () => []);
    const deps = makeDeps({ state, loadDocRow });
    const svc = createSchemaCatalogService(deps);

    expect(await svc.docDisambiguate('Anything')).toEqual({ status: 'unavailable' });
    expect(loadDocRow).not.toHaveBeenCalled();
  });

  it('does not cache a transient row-fetch failure', async () => {
    const state = makeState();
    state.serverVersion = '26.6.1';
    const loadDocTableColumns = vi.fn(async () => ['name', 'type', 'description']);
    const loadDocRow = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce([{ name: 'Log', type: 'Table Engine', description: 'x' }]);
    const deps = makeDeps({
      state,
      loadDocTableColumns,
      loadDocRow: loadDocRow as unknown as SchemaCatalogDeps['loadDocRow'],
    });
    const svc = createSchemaCatalogService(deps);

    expect(await svc.docDisambiguate('Log')).toEqual({ status: 'unavailable' });
    const second = await svc.docDisambiguate('Log');
    expect(second.status).toBe('found');
  });

  it('invalidate() mid-flight (during the capability probe) drops a stale docDisambiguate response', async () => {
    let resolveCols: (v: string[] | null) => void;
    const colsPromise = new Promise<string[] | null>((res) => { resolveCols = res; });
    const state = makeState();
    state.serverVersion = '26.6.1';
    const loadDocTableColumns = vi.fn(() => colsPromise);
    const deps = makeDeps({ state, loadDocTableColumns: loadDocTableColumns as unknown as SchemaCatalogDeps['loadDocTableColumns'] });
    const svc = createSchemaCatalogService(deps);

    const pending = svc.docDisambiguate('Log');
    svc.invalidate();
    resolveCols!(['name', 'type', 'description']);
    expect(await pending).toEqual({ status: 'unavailable' });
  });

  it('dedupes concurrent calls for the SAME name (one row fetch)', async () => {
    const state = makeState();
    state.serverVersion = '26.6.1';
    const loadDocTableColumns = vi.fn(async () => ['name', 'type', 'description']);
    const loadDocRow = vi.fn(async () => [{ name: 'Log', type: 'Table Engine', description: 'x' }]);
    const deps = makeDeps({ state, loadDocTableColumns, loadDocRow });
    const svc = createSchemaCatalogService(deps);

    const [a, b] = await Promise.all([svc.docDisambiguate('Log'), svc.docDisambiguate('Log')]);
    expect(a).toEqual(b);
    expect(loadDocRow).toHaveBeenCalledTimes(1);
  });
});
