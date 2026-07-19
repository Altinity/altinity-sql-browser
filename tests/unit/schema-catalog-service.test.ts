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
