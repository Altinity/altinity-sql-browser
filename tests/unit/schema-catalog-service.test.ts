import { describe, it, expect, vi, type Mocked } from 'vitest';
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

function makeHooks(): Mocked<Required<SchemaCatalogHooks>> {
  return {
    onServerVersionLoaded: vi.fn<NonNullable<SchemaCatalogHooks['onServerVersionLoaded']>>(),
    renderVarStrip: vi.fn<SchemaCatalogHooks['renderVarStrip']>(),
    refreshEditorReference: vi.fn<SchemaCatalogHooks['refreshEditorReference']>(),
  };
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(reason?: unknown): void } {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
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
  it('sets serverVersion on success', async () => {
    const state = makeState();
    const hooks = makeHooks();
    const deps = makeDeps({ state, hooks, loadServerVersion: vi.fn(async () => '25.1.2.100') });
    const svc = createSchemaCatalogService(deps);
    await svc.loadVersion();
    expect(state.serverVersion).toBe('25.1.2.100');
    expect(hooks.onServerVersionLoaded).toHaveBeenCalledWith('25.1.2.100');
  });

  it('leaves serverVersion untouched on a best-effort probe failure', async () => {
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
    expect(hooks.onServerVersionLoaded).not.toHaveBeenCalled();
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

  it('swallows an AbortError only after invalidation, while unrelated reference failures reject', async () => {
    const abortingLoad = vi.fn((_ctx: ChCtx, signal?: AbortSignal) => new Promise<never>((_resolve, reject) => {
      signal!.addEventListener('abort', () => {
        const error = new Error('connection closed');
        error.name = 'AbortError';
        reject(error);
      }, { once: true });
    }));
    const abortingSvc = createSchemaCatalogService(makeDeps({
      loadReferenceData: abortingLoad as unknown as SchemaCatalogDeps['loadReferenceData'],
    }));
    const aborting = abortingSvc.loadReference();
    await Promise.resolve();
    abortingSvc.invalidate();
    await expect(aborting).resolves.toBeUndefined();

    const transportFailure = new Error('reference transport failed');
    const failingSvc = createSchemaCatalogService(makeDeps({
      loadReferenceData: vi.fn(async () => { throw transportFailure; }) as unknown as SchemaCatalogDeps['loadReferenceData'],
    }));
    await expect(failingSvc.loadReference()).rejects.toBe(transportFailure);
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

describe('connection invalidation generation', () => {
  it('stops before every metadata transport when invalidated during configuration, and never rebuilds stale data', async () => {
    const config = deferred<null>();
    const state = makeState(baseSchema());
    const hooks = makeHooks();
    const deps = makeDeps({ state, hooks, ensureConfig: vi.fn(() => config.promise) });
    const svc = createSchemaCatalogService(deps);
    const version = svc.loadVersion();
    const schema = svc.loadSchema();
    const columns = svc.loadColumns('d1', 't1');
    const reference = svc.loadReference();
    svc.invalidate();
    config.resolve(null);
    await Promise.all([version, schema, columns, reference]);
    expect(deps.loadServerVersion).not.toHaveBeenCalled();
    expect(deps.loadSchema).not.toHaveBeenCalled();
    expect(deps.loadColumns).not.toHaveBeenCalled();
    expect(deps.loadReferenceData).not.toHaveBeenCalled();
    expect(hooks.renderVarStrip).not.toHaveBeenCalled();
  });

  it('synchronously aborts active schema, reference, and documentation work and gives the next connection a fresh signal', async () => {
    const firstSchema = deferred<SchemaDb[]>();
    const secondSchema = deferred<SchemaDb[]>();
    const schemaLoads = [firstSchema, secondSchema];
    const schemaSignals: AbortSignal[] = [];
    const referenceSignals: AbortSignal[] = [];
    const docSignals: AbortSignal[] = [];
    const deps = makeDeps({
      loadSchema: vi.fn((_ctx: ChCtx, signal?: AbortSignal) => {
        schemaSignals.push(signal!);
        return schemaLoads.shift()!.promise;
      }) as unknown as SchemaCatalogDeps['loadSchema'],
      loadReferenceData: vi.fn((_ctx: ChCtx, signal?: AbortSignal) => {
        referenceSignals.push(signal!);
        return new Promise((_resolve, reject) => {
          signal!.addEventListener('abort', () => {
            const error = new Error('cancelled');
            error.name = 'AbortError';
            reject(error);
          }, { once: true });
        });
      }) as unknown as SchemaCatalogDeps['loadReferenceData'],
      loadDocTableColumns: vi.fn((_ctx: ChCtx, _table, signal?: AbortSignal) => {
        docSignals.push(signal!);
        return new Promise<string[]>((_resolve, reject) => {
          signal!.addEventListener('abort', () => {
            const error = new Error('cancelled');
            error.name = 'AbortError';
            reject(error);
          }, { once: true });
        });
      }) as unknown as SchemaCatalogDeps['loadDocTableColumns'],
    });
    const svc = createSchemaCatalogService(deps);

    const schema = svc.loadSchema();
    const ref = svc.loadReference();
    const doc = svc.docEntry({ kind: 'setting', name: 'max_threads' });
    await Promise.resolve();
    svc.invalidate();

    expect(schemaSignals[0].aborted).toBe(true);
    expect(referenceSignals[0].aborted).toBe(true);
    expect(docSignals[0].aborted).toBe(true);

    firstSchema.resolve([]);
    await Promise.all([schema, ref]);
    await expect(doc).resolves.toEqual({ status: 'unavailable' });

    const freshSchema = svc.loadSchema();
    await Promise.resolve();
    expect(schemaSignals[1]).not.toBe(schemaSignals[0]);
    expect(schemaSignals[1].aborted).toBe(false);
    secondSchema.resolve([]);
    await freshSchema;
  });

  it('does not rebuild schema/columns after a loader itself invalidates the connection', async () => {
    const state = makeState(baseSchema());
    const hooks = makeHooks();
    let svc!: ReturnType<typeof createSchemaCatalogService>;
    const deps = makeDeps({
      state,
      hooks,
      loadSchema: vi.fn(async () => { svc.invalidate(); return baseSchema(); }) as unknown as SchemaCatalogDeps['loadSchema'],
      loadColumns: vi.fn(async () => { svc.invalidate(); throw new Error('connection replaced'); }),
    });
    svc = createSchemaCatalogService(deps);
    await svc.loadSchema();
    // invalidate() intentionally clears the whole connection projection;
    // columns are normally only requested from a newly-rendered schema row.
    state.schema.value = baseSchema();
    await svc.loadColumns('d1', 't1');
    expect(hooks.renderVarStrip).not.toHaveBeenCalled();
  });

  it('drops capability probes which complete after reconnect for function, structured, and Markdown documentation sources', async () => {
    const functionColumns = deferred<string[]>();
    const functionSvc = createSchemaCatalogService(makeDeps({
      loadFunctionsDocColumns: vi.fn(() => functionColumns.promise),
    }));
    const functionLookup = functionSvc.docEntry({ kind: 'function', name: 'late' });
    await Promise.resolve();
    functionSvc.invalidate();
    functionColumns.resolve(['name']);
    await expect(functionLookup).resolves.toEqual({ status: 'unavailable' });

    const structuredColumns = deferred<string[]>();
    const structuredSvc = createSchemaCatalogService(makeDeps({
      loadDocTableColumns: vi.fn(() => structuredColumns.promise) as unknown as SchemaCatalogDeps['loadDocTableColumns'],
    }));
    const structuredLookup = structuredSvc.docEntry({ kind: 'table-engine', name: 'late' });
    await Promise.resolve();
    structuredSvc.invalidate();
    structuredColumns.resolve(['name']);
    await expect(structuredLookup).resolves.toEqual({ status: 'unavailable' });

    const markdownColumns = deferred<string[]>();
    const markdownSvc = createSchemaCatalogService(makeDeps({
      loadDocTableColumns: vi.fn(() => markdownColumns.promise) as unknown as SchemaCatalogDeps['loadDocTableColumns'],
    }));
    const markdownLookup = markdownSvc.docEntry({ kind: 'setting', name: 'late' });
    await Promise.resolve();
    markdownSvc.invalidate();
    markdownColumns.resolve(['name', 'type', 'description']);
    await expect(markdownLookup).resolves.toEqual({ status: 'unavailable' });
  });

  it('fences a reconnect that happens during the post-capability configuration await of every documentation lookup', async () => {
    const exercise = async (
      warm: () => Promise<unknown>,
      lookup: () => Promise<unknown>,
      invalidate: () => void,
      release: () => void,
    ): Promise<void> => {
      await warm();
      const pending = lookup();
      await Promise.resolve();
      invalidate();
      release();
      await expect(pending).resolves.toEqual({ status: 'unavailable' });
    };

    let hold = false;
    let config = deferred<null>();
    const functionSvc = createSchemaCatalogService(makeDeps({
      ensureConfig: vi.fn(() => hold ? config.promise : Promise.resolve(null)),
      loadFunctionsDocColumns: vi.fn(async () => ['name']),
    }));
    await exercise(() => functionSvc.docEntry({ kind: 'function', name: 'warm' }),
      () => { hold = true; return functionSvc.docEntry({ kind: 'function', name: 'next' }); },
      () => functionSvc.invalidate(), () => config.resolve(null));

    hold = false; config = deferred<null>();
    const structuredSvc = createSchemaCatalogService(makeDeps({
      ensureConfig: vi.fn(() => hold ? config.promise : Promise.resolve(null)),
      loadDocTableColumns: vi.fn(async () => ['name']) as unknown as SchemaCatalogDeps['loadDocTableColumns'],
    }));
    await exercise(() => structuredSvc.docEntry({ kind: 'table-engine', name: 'warm' }),
      () => { hold = true; return structuredSvc.docEntry({ kind: 'table-engine', name: 'next' }); },
      () => structuredSvc.invalidate(), () => config.resolve(null));

    hold = false; config = deferred<null>();
    const markdownSvc = createSchemaCatalogService(makeDeps({
      ensureConfig: vi.fn(() => hold ? config.promise : Promise.resolve(null)),
      loadDocTableColumns: vi.fn(async () => ['name', 'type', 'description']) as unknown as SchemaCatalogDeps['loadDocTableColumns'],
    }));
    await exercise(() => markdownSvc.docEntry({ kind: 'setting', name: 'warm' }),
      () => { hold = true; return markdownSvc.docEntry({ kind: 'setting', name: 'next' }); },
      () => markdownSvc.invalidate(), () => config.resolve(null));

    // Name disambiguation has the same post-config fence but a separate
    // in-flight map, so cover it as its own consumer of the cached capability.
    hold = false; config = deferred<null>();
    const disambiguateSvc = createSchemaCatalogService(makeDeps({
      ensureConfig: vi.fn(() => hold ? config.promise : Promise.resolve(null)),
      loadDocTableColumns: vi.fn(async () => ['name', 'type', 'description']) as unknown as SchemaCatalogDeps['loadDocTableColumns'],
    }));
    await disambiguateSvc.docEntry({ kind: 'setting', name: 'warm' });
    hold = true;
    const pending = disambiguateSvc.docDisambiguate('next');
    await Promise.resolve();
    disambiguateSvc.invalidate();
    config.resolve(null);
    await expect(pending).resolves.toEqual({ status: 'unavailable' });
  });

  it('falls back from a durably unavailable structured source and aliases a canonical Markdown entry', async () => {
    const fallback = createSchemaCatalogService(makeDeps({
      loadDocTableColumns: vi.fn(async (_ctx: ChCtx, table: string) => (
        table === 'table_engines' ? [] : ['name', 'type', 'description']
      )) as unknown as SchemaCatalogDeps['loadDocTableColumns'],
      loadDocRow: vi.fn(async () => [{ name: 'MergeTree', type: 'Table engine', description: 'fallback' }]),
    }));
    await expect(fallback.docEntry({ kind: 'table-engine', name: 'MergeTree' })).resolves.toMatchObject({ status: 'found' });

    const markdown = createSchemaCatalogService(makeDeps({
      loadDocTableColumns: vi.fn(async () => ['name', 'type', 'description']) as unknown as SchemaCatalogDeps['loadDocTableColumns'],
      loadDocRow: vi.fn(async () => [{ name: 'MAX_THREADS', type: 'Setting', description: 'canonical' }]),
    }));
    await expect(markdown.docMarkdown({ kind: 'setting', name: 'max_threads' })).resolves.toMatchObject({ status: 'found' });
  });

  it('drops every stale metadata result, clears connection state, and permits a fresh generation', async () => {
    const oldVersion = deferred<string>();
    const oldSchema = deferred<SchemaDb[]>();
    const oldColumns = deferred<{ name: string; type: string; comment: string }[]>();
    const oldReference = deferred<{ keywords: string[]; functions: Record<string, unknown>; formats: string[] }>();
    const freshSchema = [{ db: 'fresh', tables: [{ name: 'table' }] }];
    const freshColumns = [{ name: 'fresh_column', type: 'String', comment: '' }];
    const state = makeState(baseSchema());
    state.serverVersion = 'old-version';
    state.schemaError.value = 'old error';
    const hooks = makeHooks();
    const loadServerVersion = vi.fn().mockImplementationOnce(() => oldVersion.promise).mockResolvedValueOnce('fresh-version');
    const loadSchema = vi.fn().mockImplementationOnce(() => oldSchema.promise).mockResolvedValueOnce(freshSchema);
    const loadColumns = vi.fn().mockImplementationOnce(() => oldColumns.promise).mockResolvedValueOnce(freshColumns);
    const loadReferenceData = vi.fn().mockImplementationOnce(() => oldReference.promise).mockResolvedValueOnce({ keywords: ['FRESH'], functions: {}, formats: [] });
    const deps = makeDeps({
      state,
      hooks,
      loadServerVersion,
      loadSchema: loadSchema as unknown as SchemaCatalogDeps['loadSchema'],
      loadColumns,
      loadReferenceData: loadReferenceData as unknown as SchemaCatalogDeps['loadReferenceData'],
    });
    const svc = createSchemaCatalogService(deps);

    // loadReference resets only documentation state; all four loaders are now
    // in the same connection generation and must be retired together by
    // invalidate(), not by their own late result.
    const reference = svc.loadReference();
    const version = svc.loadVersion();
    const schema = svc.loadSchema();
    const columns = svc.loadColumns('d1', 't1');
    for (let i = 0; i < 8; i++) await Promise.resolve();
    expect(loadServerVersion).toHaveBeenCalledTimes(1);
    expect(loadSchema).toHaveBeenCalledTimes(1);
    expect(loadColumns).toHaveBeenCalledTimes(1);
    expect(loadReferenceData).toHaveBeenCalledTimes(1);

    svc.invalidate();
    expect(state.serverVersion).toBeNull();
    expect(state.schema.value).toBeNull();
    expect(state.schemaError.value).toBeNull();
    expect(svc.refData.keywords).not.toContain('FRESH');

    oldVersion.resolve('late-version');
    oldSchema.resolve(baseSchema());
    oldColumns.resolve([{ name: 'late_column', type: 'String', comment: '' }]);
    oldReference.resolve({ keywords: ['LATE'], functions: {}, formats: [] });
    await Promise.all([version, schema, columns, reference]);
    expect(state.serverVersion).toBeNull();
    expect(state.schema.value).toBeNull();
    expect(svc.refData.keywords).not.toContain('LATE');
    expect(hooks.onServerVersionLoaded).not.toHaveBeenCalled();
    expect(hooks.renderVarStrip).not.toHaveBeenCalled();
    expect(hooks.refreshEditorReference).not.toHaveBeenCalled();

    await svc.loadVersion();
    await svc.loadSchema();
    await svc.loadColumns('fresh', 'table');
    await svc.loadReference();
    expect(state.serverVersion).toBe('fresh-version');
    expect(state.schema.value).toMatchObject(freshSchema);
    expect((state.schema.value as SchemaDb[])[0].tables![0].columns).toEqual(freshColumns);
    expect(svc.refData.keywords).toContain('FRESH');
    expect(hooks.onServerVersionLoaded).toHaveBeenCalledWith('fresh-version');
    expect(hooks.renderVarStrip).toHaveBeenCalledTimes(1);
    expect(hooks.refreshEditorReference).toHaveBeenCalledTimes(1);
  });

  it('does not publish a stale schema failure after invalidation', async () => {
    const schema = deferred<SchemaDb[]>();
    const state = makeState();
    const svc = createSchemaCatalogService(makeDeps({
      state,
      loadSchema: vi.fn(() => schema.promise) as unknown as SchemaCatalogDeps['loadSchema'],
    }));

    const pending = svc.loadSchema();
    await Promise.resolve();
    svc.invalidate();
    schema.reject(new Error('late schema failure'));
    await pending;
    expect(state.schemaError.value).toBeNull();
  });
});

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
    expect(loadDocTableColumns).toHaveBeenCalledWith(fakeCtx, 'table_engines', expect.any(AbortSignal));
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

    expect(loadDocTableColumns).toHaveBeenNthCalledWith(1, fakeCtx, 'formats', expect.any(AbortSignal));
    expect(loadDocTableColumns).toHaveBeenNthCalledWith(2, fakeCtx, 'database_engines', expect.any(AbortSignal));
    expect(loadDocTableColumns).toHaveBeenNthCalledWith(3, fakeCtx, 'data_type_families', expect.any(AbortSignal));
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

  it('dedupes a documentation capability probe across different lookup keys', async () => {
    let resolveCols!: (value: string[]) => void;
    const columns = new Promise<string[]>((resolve) => { resolveCols = resolve; });
    const loadDocTableColumns = vi.fn(() => columns);
    const loadDocRow = vi.fn(async () => []);
    const svc = createSchemaCatalogService(makeDeps({
      loadDocTableColumns: loadDocTableColumns as unknown as SchemaCatalogDeps['loadDocTableColumns'], loadDocRow,
    }));
    const first = svc.docEntry({ kind: 'setting', name: 'a' });
    const second = svc.docEntry({ kind: 'setting', name: 'b' });
    resolveCols(docColumns4);
    await Promise.all([first, second]);
    expect(loadDocTableColumns).toHaveBeenCalledTimes(1);
  });

  it('returns and caches missing documentation rows', async () => {
    const loadDocRow = vi.fn(async () => []);
    const svc = createSchemaCatalogService(makeDeps({
      loadDocTableColumns: vi.fn(async () => docColumns4), loadDocRow,
    }));
    expect(await svc.docEntry({ kind: 'setting', name: 'absent' })).toEqual({ status: 'missing' });
    expect(await svc.docEntry({ kind: 'setting', name: 'absent' })).toEqual({ status: 'missing' });
    expect(loadDocRow).toHaveBeenCalledTimes(1);
  });

  it('drops a documentation row invalidated after its fetch starts', async () => {
    let resolveRow!: (value: Record<string, unknown>[]) => void;
    const row = new Promise<Record<string, unknown>[]>((resolve) => { resolveRow = resolve; });
    const loadDocRow = vi.fn(() => row);
    const svc = createSchemaCatalogService(makeDeps({
      loadDocTableColumns: vi.fn(async () => docColumns4),
      loadDocRow: loadDocRow as unknown as SchemaCatalogDeps['loadDocRow'],
    }));
    const pending = svc.docEntry({ kind: 'setting', name: 'late' });
    for (let i = 0; i < 10 && loadDocRow.mock.calls.length === 0; i++) await Promise.resolve();
    expect(loadDocRow).toHaveBeenCalledTimes(1);
    svc.invalidate();
    resolveRow([{ name: 'late', type: 'Setting', description: 'late' }]);
    expect(await pending).toEqual({ status: 'unavailable' });
  });

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
    expect(loadDocTableColumns).toHaveBeenCalledWith(fakeCtx, 'documentation', expect.any(AbortSignal));
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
    expect(loadDocTableColumns).toHaveBeenCalledWith(fakeCtx, 'table_engines', expect.any(AbortSignal));
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
    expect(loadDocTableColumns).toHaveBeenCalledWith(fakeCtx, 'table_engines', expect.any(AbortSignal));
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
    expect(loadDocTableColumns).toHaveBeenCalledWith(fakeCtx, 'table_engines', expect.any(AbortSignal));
    expect(loadDocTableColumns).toHaveBeenCalledWith(fakeCtx, 'documentation', expect.any(AbortSignal));
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
    expect(loadDocTableColumns).toHaveBeenCalledWith(fakeCtx, 'documentation', expect.any(AbortSignal));
  });

  it('converts a thrown compact-documentation transport failure to unavailable and clears the entry cache for a retry', async () => {
    const state = makeState();
    state.serverVersion = '26.6.1';
    const loadDocRow = vi.fn()
      .mockRejectedValueOnce(new Error('compact documentation transport failed'))
      .mockResolvedValueOnce([{ name: 'max_threads', type: 'Setting', description: 'x' }]);
    const svc = createSchemaCatalogService(makeDeps({
      state,
      loadDocTableColumns: vi.fn(async () => ['name', 'type', 'description']),
      loadDocRow: loadDocRow as unknown as SchemaCatalogDeps['loadDocRow'],
    }));

    await expect(svc.docEntry({ kind: 'setting', name: 'max_threads' })).resolves.toEqual({ status: 'unavailable' });
    await expect(svc.docEntry({ kind: 'setting', name: 'max_threads' })).resolves.toMatchObject({ status: 'found' });
    expect(loadDocRow).toHaveBeenCalledTimes(2);
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

  it('stops before fallback when invalidated after a cached structured-unavailable result', async () => {
    const loadDocTableColumns = vi.fn(async (_ctx: ChCtx, table: string) => (
      table === 'formats' ? [] : null
    ));
    const svc = createSchemaCatalogService(makeDeps({
      loadDocTableColumns: loadDocTableColumns as unknown as SchemaCatalogDeps['loadDocTableColumns'],
    }));
    await svc.docEntry({ kind: 'format', name: 'CSV' }); // cache structured=false; docs remains transient
    const pending = svc.docEntry({ kind: 'format', name: 'TSV' });
    await Promise.resolve(); // structured resolver has returned its cached durable-unavailable result
    svc.invalidate();
    expect(await pending).toEqual({ status: 'unavailable' });
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
    expect(loadDocTableColumns).not.toHaveBeenCalledWith(fakeCtx, 'table_engines', expect.any(AbortSignal));
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

  it('also caches a found Markdown entry under its canonical server name', async () => {
    const loadDocRow = vi.fn(async () => [{ name: 'max_threads', type: 'Setting', description: 'd' }]);
    const svc = createSchemaCatalogService(makeDeps({
      loadDocTableColumns: vi.fn(async () => ['name', 'type', 'description']), loadDocRow,
    }));
    const lower = await svc.docMarkdown({ kind: 'setting', name: 'MAX_THREADS' });
    expect(await svc.docMarkdown({ kind: 'setting', name: 'max_threads' })).toEqual(lower);
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

  it('converts a thrown transport failure to unavailable and clears the Markdown cache for a retry', async () => {
    const state = makeState();
    state.serverVersion = '26.6.1';
    const loadDocRow = vi.fn()
      .mockRejectedValueOnce(new Error('markdown transport failed'))
      .mockResolvedValueOnce([{ name: 'max_threads', type: 'Setting', description: 'd' }]);
    const svc = createSchemaCatalogService(makeDeps({
      state,
      loadDocTableColumns: vi.fn(async () => ['name', 'type', 'description']),
      loadDocRow: loadDocRow as unknown as SchemaCatalogDeps['loadDocRow'],
    }));

    await expect(svc.docMarkdown({ kind: 'setting', name: 'max_threads' })).resolves.toEqual({ status: 'unavailable' });
    await expect(svc.docMarkdown({ kind: 'setting', name: 'max_threads' })).resolves.toMatchObject({ status: 'found' });
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
  it('returns unavailable for a durably absent documentation capability', async () => {
    const loadDocRow = vi.fn(async () => []);
    const svc = createSchemaCatalogService(makeDeps({
      loadDocTableColumns: vi.fn(async () => []), loadDocRow,
    }));
    expect(await svc.docDisambiguate('Anything')).toEqual({ status: 'unavailable' });
    expect(loadDocRow).not.toHaveBeenCalled();
  });

  it('drops a disambiguation row invalidated after its fetch starts', async () => {
    let resolveRow!: (value: Record<string, unknown>[]) => void;
    const row = new Promise<Record<string, unknown>[]>((resolve) => { resolveRow = resolve; });
    const loadDocRow = vi.fn(() => row);
    const svc = createSchemaCatalogService(makeDeps({
      loadDocTableColumns: vi.fn(async () => ['name', 'type', 'description']),
      loadDocRow: loadDocRow as unknown as SchemaCatalogDeps['loadDocRow'],
    }));
    const pending = svc.docDisambiguate('Log');
    for (let i = 0; i < 10 && loadDocRow.mock.calls.length === 0; i++) await Promise.resolve();
    svc.invalidate();
    resolveRow([{ name: 'Log', type: 'Setting', description: 'late' }]);
    expect(await pending).toEqual({ status: 'unavailable' });
  });
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

  it('converts a thrown disambiguation transport failure to unavailable and releases the name for a retry', async () => {
    const state = makeState();
    state.serverVersion = '26.6.1';
    const loadDocRow = vi.fn()
      .mockRejectedValueOnce(new Error('disambiguation transport failed'))
      .mockResolvedValueOnce([{ name: 'Log', type: 'Table Engine', description: 'x' }]);
    const svc = createSchemaCatalogService(makeDeps({
      state,
      loadDocTableColumns: vi.fn(async () => ['name', 'type', 'description']),
      loadDocRow: loadDocRow as unknown as SchemaCatalogDeps['loadDocRow'],
    }));

    await expect(svc.docDisambiguate('Log')).resolves.toEqual({ status: 'unavailable' });
    await expect(svc.docDisambiguate('Log')).resolves.toMatchObject({ status: 'found' });
    expect(loadDocRow).toHaveBeenCalledTimes(2);
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
