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
    loadEntityDoc: vi.fn(async () => ''),
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
  it('assembles reference data, clears docCache, rebuilds completions, and refreshes the editor', async () => {
    const state = makeState();
    const hooks = makeHooks();
    const loadEntityDoc = vi.fn(async () => 'doc-1');
    const deps = makeDeps({
      state,
      hooks,
      loadEntityDoc,
      loadReferenceData: fakeLoadReferenceData({ keywords: ['ZAP'], functions: {}, formats: [] }),
    });
    const svc = createSchemaCatalogService(deps);

    await svc.entityDoc('count'); // warm the hover-doc cache
    expect(loadEntityDoc).toHaveBeenCalledTimes(1);

    await svc.loadReference();
    expect(svc.refData.keywords).toContain('ZAP');
    expect(svc.completions.some((c) => c.kind === 'keyword' && c.label === 'ZAP')).toBe(true);
    expect(hooks.refreshEditorReference).toHaveBeenCalledTimes(1);

    await svc.entityDoc('count'); // cache was cleared by loadReference → refetches
    expect(loadEntityDoc).toHaveBeenCalledTimes(2);
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

// ── entityDoc ────────────────────────────────────────────────────────────────

describe('entityDoc', () => {
  it('caches a resolved doc and dedupes concurrent in-flight calls for the same name', async () => {
    const loadEntityDoc = vi.fn(async () => 'the doc');
    const deps = makeDeps({ loadEntityDoc });
    const svc = createSchemaCatalogService(deps);

    const [a, b] = await Promise.all([svc.entityDoc('count'), svc.entityDoc('count')]);
    expect(a).toBe('the doc');
    expect(b).toBe('the doc');
    expect(loadEntityDoc).toHaveBeenCalledTimes(1); // deduped, not fetched twice

    expect(await svc.entityDoc('count')).toBe('the doc'); // served from cache
    expect(loadEntityDoc).toHaveBeenCalledTimes(1);
    // `docCache` itself is a live, read-only exposed accessor (`app.catalog.docCache`
    // in production, #276 Phase 5 — no more `app.docCache` mirror) — the resolved
    // doc really lands in the SAME map `entityDoc` consults, not a private copy.
    expect(svc.docCache.get('count')).toBe('the doc');
  });

  it('drops a failed fetch (null) rather than caching it, and retries on the next call', async () => {
    const loadEntityDoc = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce('now works');
    const deps = makeDeps({ loadEntityDoc: loadEntityDoc as unknown as SchemaCatalogDeps['loadEntityDoc'] });
    const svc = createSchemaCatalogService(deps);

    expect(await svc.entityDoc('count')).toBeNull();
    expect(await svc.entityDoc('count')).toBe('now works'); // retried, not served from a cached error
    expect(loadEntityDoc).toHaveBeenCalledTimes(2);
  });
});

// ── invalidate ───────────────────────────────────────────────────────────────

describe('invalidate', () => {
  it('clears the reference/completions/hover-doc caches back to the built-in fallback', async () => {
    const loadEntityDoc = vi.fn(async () => 'doc');
    const deps = makeDeps({
      loadEntityDoc,
      loadReferenceData: fakeLoadReferenceData({ keywords: ['ZAP'] }),
    });
    const svc = createSchemaCatalogService(deps);

    await svc.loadReference();
    await svc.entityDoc('count');
    expect(loadEntityDoc).toHaveBeenCalledTimes(1);
    expect(svc.refData.keywords).toContain('ZAP');

    svc.invalidate();

    expect(svc.refData).toEqual(assembleReferenceData(null));
    expect(svc.completions.some((c) => c.label === 'ZAP')).toBe(false);

    await svc.entityDoc('count'); // docCache was cleared by invalidate → refetches
    expect(loadEntityDoc).toHaveBeenCalledTimes(2);
  });
});
