import { describe, it, expect, vi } from 'vitest';
import type { Mock } from 'vitest';
import { signal } from '@preact/signals-core';
import { splitStatements } from '../../src/core/sql-split.js';
import { createExportService } from '../../src/application/export-service.js';
import type {
  ExportServiceDeps, ExportStateSlice, ExportHooks, ExportSink, ExportRequest, SignedOutCtx,
  FileHandleLike, DirectoryHandleLike, WritableFileStreamLike,
} from '../../src/application/export-service.js';
import { newTabObj } from '../../src/state.js';
import type { QueryTab } from '../../src/state.js';
import type { PreparedSource, PreparedStatement } from '../../src/core/param-pipeline.js';
import type { WorkbenchParameterSession } from '../../src/application/workbench-parameter-session.js';
import {
  createAuthenticatedExecutionScope,
} from '../../src/application/authenticated-execution-scope.js';
import type { AuthenticatedExecutionScope } from '../../src/application/authenticated-execution-scope.js';

// ── Small deferred/flush helpers (mirrors workbench-session.test.ts's own
// convention for scripting async picker/fetch behaviors on a test's own
// schedule). ──────────────────────────────────────────────────────────────

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
  return Object.assign(new Error('x'), { name: 'AbortError' });
}
function executionScope(epoch = 1): ReturnType<typeof createAuthenticatedExecutionScope> {
  return createAuthenticatedExecutionScope({ epoch, cancelRemote: vi.fn() });
}
function scopeWithChecks(values: boolean[]): AuthenticatedExecutionScope {
  return {
    epoch: 1,
    isOpen: () => true,
    register: () => ({ release: vi.fn(), isCurrent: () => values.shift() ?? false }),
    close: vi.fn(async () => {}),
  } as unknown as AuthenticatedExecutionScope;
}

function preparedStatement(over: Partial<PreparedStatement> = {}): PreparedStatement {
  return { sql: 'SELECT 1', args: {}, boundParams: [], ...over };
}
function preparedSource(over: Partial<PreparedSource> = {}): PreparedSource {
  return {
    id: 'tab', statements: [preparedStatement()], missing: [], invalid: [], errors: [], runnable: true, ...over,
  };
}

// ── Streaming-response / File System Access fakes (ported from
// app.test.ts's own identically-named helpers — see that file's header
// comment on why these aren't a shared tests/helpers/ module: this service's
// tests mock `exportResponse`/`runEffectText` directly rather than a `fetch` seam, so
// only the Response/file-handle SHAPES are shared, not the fetch-routing
// machinery). ──────────────────────────────────────────────────────────────

interface FakeBody { getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }>; releaseLock(): void } }
function streamBody(lines: string[]): FakeBody {
  let i = 0;
  return {
    getReader: () => ({
      read: async () => (i < lines.length ? { done: false, value: new TextEncoder().encode(lines[i++]) } : { done: true }),
      releaseLock: () => {},
    }),
  };
}
function throwingBody(message: string): FakeBody {
  return { getReader: () => ({ read: async () => { throw new Error(message); }, releaseLock: () => {} }) };
}
interface FakeExportResponse { headers: { get(name: string): string | null }; body?: FakeBody | null }
function fakeExportResponse(opts: { body?: FakeBody | null; headers?: Record<string, string> } = {}): FakeExportResponse {
  return { body: opts.body, headers: { get: (name) => (opts.headers && opts.headers[name]) ?? null } };
}
// `ExportServiceDeps.exportResponse`'s real signature returns a genuine DOM
// `Response`; a `{headers,body}`-only fake doesn't overlap enough of the real
// interface for a direct `as Response` (same "object"-parameter bridge as
// app.test.ts's own `asFetch`/`asWindow`).
const asResponse = (v: object): Response => v as Response;

// Build a ClickHouse mid-stream exception frame's raw text (issue #87):
// \r\n__exception__\r\n<tag>\r\n<message>\n<len> <tag>\r\n__exception__\r\n
function exceptionFrame(tag: string, message: string): string {
  const len = new TextEncoder().encode(message).length;
  return '\r\n__exception__\r\n' + tag + '\r\n' + message + '\n' + len + ' ' + tag + '\r\n__exception__\r\n';
}

// Issue #630 Phase 3 §11.9 — the same frame shape as `exceptionFrame` above,
// but as raw bytes rather than a string: used to prove `streamToFile`'s
// package-owned `findExceptionFrame` cutover is genuinely byte-safe (no
// caller-side latin1 conversion, no TextDecoder over the clean prefix).
function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
function exceptionFrameBytes(tag: string, message: string): Uint8Array {
  const enc = new TextEncoder();
  const msgBytes = enc.encode(message);
  return concatBytes(
    enc.encode('\r\n__exception__\r\n' + tag + '\r\n'),
    msgBytes,
    enc.encode('\n' + msgBytes.length + ' ' + tag + '\r\n__exception__\r\n'),
  );
}
// A `FakeBody` yielding exact raw byte chunks, in order — needed for the
// invalid-UTF-8 byte-boundary proof, which a string-per-chunk helper
// (`streamBody`) is structurally incapable of producing.
function streamBodyBytes(chunks: Uint8Array[]): FakeBody {
  let i = 0;
  return {
    getReader: () => ({
      read: async () => (i < chunks.length ? { done: false, value: chunks[i++] } : { done: true }),
      releaseLock: () => {},
    }),
  };
}
function writtenBytes(chunks: Uint8Array[]): Uint8Array {
  return concatBytes(...chunks);
}

interface FakeWritable { write(chunk: Uint8Array): Promise<void>; close(): Promise<void>; abort(): Promise<void> }
interface FakeFileHandle { name: string; createWritable(): Promise<FakeWritable>; move?(name: string): Promise<void> }
function fakeFileHandle(name = 'export.tsv'): { handle: FakeFileHandle; writable: FakeWritable; chunks: Uint8Array[] } {
  const chunks: Uint8Array[] = [];
  const writable: FakeWritable = {
    write: vi.fn(async (chunk: Uint8Array) => { chunks.push(Uint8Array.from(chunk)); }),
    close: vi.fn(async () => {}),
    abort: vi.fn(async () => {}),
  };
  const handle: FakeFileHandle = { name, createWritable: vi.fn(async () => writable), move: vi.fn(async () => {}) };
  return { handle, writable, chunks };
}
function writtenText(chunks: Uint8Array[]): string {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const merged = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { merged.set(c, o); o += c.length; }
  return new TextDecoder().decode(merged);
}
// A fake FileSystemDirectoryHandle: getFileHandle(name) hands back a fresh
// fakeFileHandle() and remembers it (keyed by name) for write assertions.
function fakeDirHandle(): { dir: DirectoryHandleLike; written: Map<string, ReturnType<typeof fakeFileHandle>> } {
  const written = new Map<string, ReturnType<typeof fakeFileHandle>>();
  const dir: DirectoryHandleLike = {
    getFileHandle: vi.fn(async (name: string) => {
      const f = fakeFileHandle();
      written.set(name, f);
      return f.handle as unknown as FileHandleLike;
    }),
  };
  return { dir, written };
}
const asFileHandleLike = (v: FakeFileHandle): FileHandleLike => v as unknown as FileHandleLike;
const asWritableLike = (v: FakeWritable): WritableFileStreamLike => v as unknown as WritableFileStreamLike;
void asWritableLike;

// ── Fakes for the service's own injected deps ───────────────────────────────

// #630 Phase 7 — `exportResponse`/`runEffectText` mirror
// `authenticatedResponse`/`authenticatedText`: package consumers now THROW
// instead of returning a generic `{error}` shape, so a failure fixture is
// `mockRejectedValue(new Error(...))`, never `mockResolvedValue({error})`.
function makeCh(): { exportResponse: Mock; runEffectText: Mock; cancel: Mock } {
  const exportResponse = vi.fn(async () => asResponse(fakeExportResponse({ body: streamBody([]) })));
  const runEffectText = vi.fn(async (): Promise<string> => '');
  const cancel = vi.fn(async () => {});
  return { exportResponse, runEffectText, cancel };
}

function makeState(over: Partial<ExportStateSlice> = {}): ExportStateSlice {
  return { exporting: signal(false), resultSort: { col: null, dir: 'asc' }, ...over };
}

type ExportParamsDeps = Pick<WorkbenchParameterSession, 'prepareTabSource' | 'varGateBlocked' | 'execStatementSql'>;
function makeParams(over: Partial<ExportParamsDeps> = {}): ExportParamsDeps {
  return {
    // Splits `sql` the same way `exportEntry`'s own `splitStatements` call
    // does, so `paramSrc.statements[i]` aligns with the script's own
    // per-statement array by default — a test overrides this only when it
    // cares about specific per-statement args/sql.
    prepareTabSource: vi.fn((sql: string) => preparedSource({ statements: splitStatements(sql).map((s) => preparedStatement({ sql: s })) })),
    varGateBlocked: vi.fn(() => false),
    execStatementSql: vi.fn((stmt: string) => stmt),
    ...over,
  };
}

function makeHooks(over: Partial<ExportHooks> = {}): ExportHooks {
  return {
    renderResults: vi.fn(),
    showExportProgress: vi.fn(() => ({ update: vi.fn(), remove: vi.fn() })),
    toast: vi.fn(),
    loadSchema: vi.fn(),
    ...over,
  };
}

function makeSink(over: Partial<ExportSink> = {}): ExportSink {
  return {
    pickFile: vi.fn(async () => asFileHandleLike(fakeFileHandle().handle)),
    pickDirectory: vi.fn(async () => fakeDirHandle().dir),
    ...over,
  };
}

// #630 Phase 7 — `ctx()` survives only as the narrow signed-out notifier; a
// couple of tests also read `.fetch`/`.origin` off it purely as convenient
// FIXTURE VALUES for a frozen `AuthenticatedCancellationLease`'s own
// `fetch`/`origin` fields (unrelated to transport — no export path reads
// `ctx()` for a request any more).
interface FakeCtx extends SignedOutCtx { fetch: typeof fetch; origin: string }

interface Harness {
  deps: ExportServiceDeps;
  state: ExportStateSlice;
  hooks: ExportHooks;
  sink: ExportSink;
  ch: ReturnType<typeof makeCh>;
  ctx: FakeCtx;
  tab: QueryTab;
  params: ExportParamsDeps;
}

function makeHarness(opts: {
  state?: Partial<ExportStateSlice>;
  hooks?: Partial<ExportHooks>;
  sink?: Partial<ExportSink>;
  tab?: Partial<QueryTab>;
  params?: Partial<ExportParamsDeps>;
  canExport?: () => boolean;
  canExportScript?: () => boolean;
  ensureConfig?: () => Promise<unknown>;
  getToken?: () => Promise<string | null>;
  executionScope?: () => AuthenticatedExecutionScope | null;
  sessionParamsFor?: (tab: QueryTab, sqls: string[]) => Record<string, string>;
} = {}): Harness {
  const state = makeState(opts.state);
  const hooks = makeHooks(opts.hooks);
  const sink = makeSink(opts.sink);
  const ch = makeCh();
  const tab: QueryTab = { ...newTabObj('t1'), ...opts.tab };
  const params = makeParams(opts.params);
  const ctx: FakeCtx = {
    fetch: (undefined as unknown) as typeof fetch, origin: 'https://ch.example',
    onSignedOut: vi.fn(),
  };
  const uidSeq = { n: 0 };
  const deps: ExportServiceDeps = {
    exportResponse: ch.exportResponse, runEffectText: ch.runEffectText, cancel: ch.cancel,
    ctx: () => ctx,
    executionScope: opts.executionScope || (() => null),
    ensureConfig: opts.ensureConfig || vi.fn(async () => undefined),
    getToken: opts.getToken || vi.fn(async () => 'tok'),
    now: () => { uidSeq.n += 10; return uidSeq.n; },
    wallNow: () => 1_700_000_000_000,
    uid: (prefix: string) => `${prefix}${++uidSeq.n}`,
    canExport: opts.canExport || vi.fn(() => true),
    canExportScript: opts.canExportScript || vi.fn(() => true),
    sink,
    state,
    activeTab: () => tab,
    params,
    sessionParamsFor: opts.sessionParamsFor || vi.fn(() => ({})),
    hooks,
  };
  return { deps, state, hooks, sink, ch, ctx, tab, params };
}

/** `h.ch.exportResponse`'s recorded request at call index `i` (default 0) —
 *  a small accessor so assertions read almost like the pre-Phase-7
 *  `mock.calls[i][2]` options-object shape did. */
function exportCall(h: Harness, i = 0): ExportRequest {
  return (h.ch.exportResponse as Mock).mock.calls[i][0] as ExportRequest;
}
function effectCall(h: Harness, i = 0): ExportRequest {
  return (h.ch.runEffectText as Mock).mock.calls[i][0] as ExportRequest;
}

// ── exportEntry (dispatch) ──────────────────────────────────────────────────

describe('createExportService: exportEntry (dispatch)', () => {
  it('is a no-op when the active tab is not in SQL mode', async () => {
    const h = makeHarness({ tab: { editorMode: 'spec' } });
    const service = createExportService(h.deps);
    await service.exportEntry();
    expect(h.sink.pickFile).not.toHaveBeenCalled();
    expect(h.sink.pickDirectory).not.toHaveBeenCalled();
  });

  it('is a no-op while an export is already running', async () => {
    const h = makeHarness({ state: { exporting: signal(true) } });
    const service = createExportService(h.deps);
    await service.exportEntry();
    expect(h.sink.pickFile).not.toHaveBeenCalled();
  });

  it('is blocked (no picker) when the {name:Type} gate is blocked (#134)', async () => {
    const h = makeHarness({ params: { varGateBlocked: vi.fn(() => true) } });
    const service = createExportService(h.deps);
    await service.exportEntry();
    expect(h.sink.pickFile).not.toHaveBeenCalled();
    expect(h.deps.ensureConfig).not.toHaveBeenCalled();
  });

  it('toasts "Nothing to export" for blank/whitespace-only SQL', async () => {
    const h = makeHarness({ tab: { sqlDraft: '   ' } });
    const service = createExportService(h.deps);
    await service.exportEntry();
    expect(h.hooks.toast).toHaveBeenCalledWith('Nothing to export');
    expect(h.sink.pickFile).not.toHaveBeenCalled();
  });

  it('is blocked with a toast, no picker, for a dashboard-variable tab — Export is uncapped, option SQL never is (#465 review)', async () => {
    const h = makeHarness({
      tab: {
        sqlDraft: 'SELECT a, b FROM t',
        doc: { kind: 'dashboard-variable', dashboardId: 'sales', variableName: 'zone' },
      },
    });
    const service = createExportService(h.deps);
    await service.exportEntry();
    expect(h.hooks.toast).toHaveBeenCalledWith('Export isn’t available for a Dashboard variable’s option SQL.');
    expect(h.sink.pickFile).not.toHaveBeenCalled();
    expect(h.sink.pickDirectory).not.toHaveBeenCalled();
    expect(h.deps.ensureConfig).not.toHaveBeenCalled();
  });

  it('one statement -> the single-file picker; more than one -> the directory picker', async () => {
    const h = makeHarness({ tab: { sqlDraft: 'SELECT 1' } });
    const service = createExportService(h.deps);
    await service.exportEntry();
    expect(h.sink.pickFile).toHaveBeenCalledTimes(1);
    expect(h.sink.pickDirectory).not.toHaveBeenCalled();

    h.tab.sqlDraft = 'SELECT 1;\nSELECT 2;';
    await service.exportEntry();
    expect(h.sink.pickDirectory).toHaveBeenCalledTimes(1);
  });
});

// ── exportDirect (single-file, issue #87) ───────────────────────────────────

describe('createExportService: exportDirect (issue #87)', () => {
  it('guards against non-SQL mode / already-running / canExport() false / empty input, all defensively', async () => {
    const notSql = makeHarness({ tab: { editorMode: 'spec' } });
    await createExportService(notSql.deps).exportDirect('SELECT 1', 0);
    expect(notSql.sink.pickFile).not.toHaveBeenCalled();

    const busy = makeHarness({ state: { exporting: signal(true) } });
    await createExportService(busy.deps).exportDirect('SELECT 1', 0);
    expect(busy.sink.pickFile).not.toHaveBeenCalled();

    const unavailable = makeHarness({ canExport: () => false });
    await createExportService(unavailable.deps).exportDirect('SELECT 1', 0);
    expect(unavailable.sink.pickFile).not.toHaveBeenCalled();

    const empty = makeHarness();
    await createExportService(empty.deps).exportDirect('   ', 0);
    expect(empty.hooks.toast).toHaveBeenCalledWith('Nothing to export');
    expect(empty.sink.pickFile).not.toHaveBeenCalled();
  });

  it('picker AbortError (user dismissed the dialog) is a silent no-op', async () => {
    const h = makeHarness({ sink: { pickFile: vi.fn(async () => { throw abortError(); }) } });
    await createExportService(h.deps).exportDirect('SELECT 1', 0);
    expect(h.hooks.toast).not.toHaveBeenCalled();
    expect(h.state.exporting.value).toBe(false);
  });

  it('a non-abort picker failure toasts "Save dialog failed"', async () => {
    const h = makeHarness({ sink: { pickFile: vi.fn(async () => { throw new Error('disk full'); }) } });
    await createExportService(h.deps).exportDirect('SELECT 1', 0);
    expect(h.hooks.toast).toHaveBeenCalledWith('Save dialog failed: disk full');
    expect(h.state.exporting.value).toBe(false);
  });

  it('reports a non-Error save-picker rejection', async () => {
    const h = makeHarness({ sink: { pickFile: vi.fn(async () => { throw 'picker offline'; }) } });
    await createExportService(h.deps).exportDirect('SELECT 1', 0);
    expect(h.hooks.toast).toHaveBeenCalledWith('Save dialog failed: picker offline');
  });

  it('picker opens BEFORE ensureConfig/getToken (transient-activation ordering, review F6)', async () => {
    const order: string[] = [];
    const { handle } = fakeFileHandle();
    const h = makeHarness({
      sink: { pickFile: vi.fn(async () => { order.push('pickFile'); return asFileHandleLike(handle); }) },
      ensureConfig: vi.fn(async () => { order.push('ensureConfig'); }),
      getToken: vi.fn(async () => { order.push('getToken'); return 'tok'; }),
    });
    await createExportService(h.deps).exportDirect('SELECT 1', 0);
    expect(order).toEqual(['pickFile', 'ensureConfig', 'getToken']);
  });

  it('signed out (no token): the picker still opens, but no query runs', async () => {
    const { handle } = fakeFileHandle();
    const h = makeHarness({ sink: { pickFile: vi.fn(async () => asFileHandleLike(handle)) }, getToken: vi.fn(async () => null) });
    await createExportService(h.deps).exportDirect('SELECT 1', 0);
    expect(h.sink.pickFile).toHaveBeenCalledTimes(1);
    expect(h.ctx.onSignedOut).toHaveBeenCalledTimes(1);
    expect(h.ch.exportResponse).not.toHaveBeenCalled();
    expect(h.state.exporting.value).toBe(false);
  });

  it('streams a clean result to disk (default TSV) and reports completion', async () => {
    const { handle, writable, chunks } = fakeFileHandle();
    let pickerOpts: { suggestedName: string; types: { accept: Record<string, string[]> }[] } | undefined;
    const h = makeHarness({
      sink: {
        pickFile: vi.fn(async (opts) => { pickerOpts = opts; return asFileHandleLike(handle); }),
      },
      tab: { name: 'My Query!' },
    });
    h.ch.exportResponse.mockResolvedValue(asResponse(fakeExportResponse({ body: streamBody(['a'.repeat(100)]) })));
    await createExportService(h.deps).exportDirect('SELECT 1', 0);
    expect(pickerOpts!.suggestedName).toBe('My_Query.tsv');
    expect(pickerOpts!.types[0].accept).toEqual({ 'text/tab-separated-values': ['.tsv'] });
    expect(writtenText(chunks)).toBe('a'.repeat(100));
    expect(writable.close).toHaveBeenCalledTimes(1);
    expect(writable.abort).not.toHaveBeenCalled();
    expect(h.hooks.toast).toHaveBeenCalledWith('Export complete');
    expect(h.state.exporting.value).toBe(false);
    const call = exportCall(h);
    expect(call.sql).toBe('SELECT 1\nFORMAT TabSeparatedWithNames');
    expect(call.defaultFormat).toBe('TabSeparatedWithNames');
  });

  it('honors an explicit FORMAT in the query for the picker + the request', async () => {
    const { handle } = fakeFileHandle();
    let pickerOpts: { suggestedName: string; types: { accept: Record<string, string[]> }[] } | undefined;
    const h = makeHarness({
      sink: { pickFile: vi.fn(async (opts) => { pickerOpts = opts; return asFileHandleLike(handle); }) },
      params: { execStatementSql: vi.fn((s: string) => s) },
    });
    h.ch.exportResponse.mockResolvedValue(asResponse(fakeExportResponse({ body: streamBody(['[]']) })));
    await createExportService(h.deps).exportDirect('SELECT 1 FORMAT JSON', 0);
    expect(pickerOpts!.suggestedName).toMatch(/\.json$/);
    expect(pickerOpts!.types[0].accept).toEqual({ 'application/json': ['.json'] });
    const call = exportCall(h);
    expect(call.defaultFormat).toBe('JSON');
  });

  it('query variables (#134/#173): sends the wave-captured params merged with sessionParamsFor', async () => {
    const { handle } = fakeFileHandle();
    const h = makeHarness({
      sink: { pickFile: vi.fn(async () => asFileHandleLike(handle)) },
      params: {
        prepareTabSource: vi.fn(() => preparedSource({ statements: [preparedStatement({ args: { param_database: 'default' } })] })),
      },
      sessionParamsFor: vi.fn(() => ({ session_id: 'sess-1' })),
    });
    h.ch.exportResponse.mockResolvedValue(asResponse(fakeExportResponse({ body: streamBody(['x']) })));
    await createExportService(h.deps).exportDirect('SELECT {database:String}', 42);
    expect(h.params.prepareTabSource).toHaveBeenCalledWith('SELECT {database:String}\nFORMAT TabSeparatedWithNames', 42);
    const call = exportCall(h);
    // `params` now also carries the wave's own `query_id` (#630 Phase 7 —
    // this service builds the whole request object itself); `toMatchObject`
    // ignores that extra key rather than pinning its exact generated value.
    expect(call.params).toMatchObject({ session_id: 'sess-1', param_database: 'default' });
  });

  // #630 Phase 7 §23 — "non-2xx never starts streaming": `exportResponse`
  // mirrors `authenticatedResponse`'s package classification, so a non-2xx
  // status is a REJECTION this service receives before it ever holds a
  // `Response` to stream from — `streamToFile`/the writable/the reader are
  // never reached.
  it('a pre-header (non-OK) export failure toasts "Export failed" without ever opening the writable — non-2xx never starts streaming', async () => {
    const { handle } = fakeFileHandle();
    const h = makeHarness({ sink: { pickFile: vi.fn(async () => asFileHandleLike(handle)) } });
    h.ch.exportResponse.mockRejectedValue(new Error('DB::Exception: nope'));
    await createExportService(h.deps).exportDirect('SELECT 1', 0);
    expect(h.hooks.toast).toHaveBeenCalledWith('Export failed: DB::Exception: nope');
    expect(handle.createWritable).not.toHaveBeenCalled();
    expect(h.state.exporting.value).toBe(false);
  });

  // #630 Phase 7 §12.3/§23 — the successful raw-export path must never call
  // `.text()`/`.json()` on the successful `Response`: it stays untouched
  // until `streamToFile`'s own `body.getReader()`. A `.text()` that would
  // throw if ever invoked proves the byte-stream path really does bypass it.
  it('a successful Response whose .text() throws still succeeds — the successful body is never read for classification', async () => {
    const { handle, writable, chunks } = fakeFileHandle();
    const h = makeHarness({ sink: { pickFile: vi.fn(async () => asFileHandleLike(handle)) } });
    const resp = {
      ...fakeExportResponse({ body: streamBody(['clean data']) }),
      text: () => { throw new Error('must not be called on a successful export response'); },
    };
    h.ch.exportResponse.mockResolvedValue(asResponse(resp));
    await createExportService(h.deps).exportDirect('SELECT 1', 0);
    expect(writtenText(chunks)).toBe('clean data');
    expect(writable.close).toHaveBeenCalledTimes(1);
    expect(h.hooks.toast).toHaveBeenCalledWith('Export complete');
  });

  it('reports a non-Error export rejection', async () => {
    const { handle } = fakeFileHandle();
    const h = makeHarness({ sink: { pickFile: vi.fn(async () => asFileHandleLike(handle)) } });
    h.ch.exportResponse.mockRejectedValue('transport unavailable');
    await createExportService(h.deps).exportDirect('SELECT 1', 0);
    expect(h.hooks.toast).toHaveBeenCalledWith('Export failed: transport unavailable');
  });

  it('suppresses the "Export failed" toast when the underlying error is "signed out"', async () => {
    const { handle } = fakeFileHandle();
    const h = makeHarness({ sink: { pickFile: vi.fn(async () => asFileHandleLike(handle)) } });
    h.ch.exportResponse.mockRejectedValue(new Error('signed out'));
    await createExportService(h.deps).exportDirect('SELECT 1', 0);
    expect(h.hooks.toast).not.toHaveBeenCalled();
    expect(h.state.exporting.value).toBe(false);
  });

  it('holds back the trailing 32 KiB and streams the rest incrementally (no full buffering)', async () => {
    const { handle, writable, chunks } = fakeFileHandle();
    const big = 'a'.repeat(40960); // > HOLDBACK (32 KiB) in a single chunk
    const h = makeHarness({ sink: { pickFile: vi.fn(async () => asFileHandleLike(handle)) } });
    h.ch.exportResponse.mockResolvedValue(asResponse(fakeExportResponse({ body: streamBody([big]) })));
    await createExportService(h.deps).exportDirect('SELECT 1', 0);
    // mid-loop commit (8192 = 40960 - 32768 HOLDBACK) then the EOF flush of the held-back tail.
    expect((writable.write as Mock).mock.calls.map((c) => (c[0] as Uint8Array).length)).toEqual([8192, 32768]);
    expect(writtenText(chunks)).toBe(big);
    expect(writable.close).toHaveBeenCalledTimes(1);
  });

  it('excises a mid-stream exception frame — only clean bytes reach the file; reports "incomplete"', async () => {
    const TAG = 'abcdef0123456789';
    const { handle, writable, chunks } = fakeFileHandle();
    const clean = 'x'.repeat(40);
    const frame = exceptionFrame(TAG, 'DB::Exception: Memory limit (total) exceeded');
    const h = makeHarness({ sink: { pickFile: vi.fn(async () => asFileHandleLike(handle)) } });
    h.ch.exportResponse.mockResolvedValue(asResponse(fakeExportResponse({ body: streamBody([clean, frame]), headers: { 'X-ClickHouse-Exception-Tag': TAG } })));
    await createExportService(h.deps).exportDirect('SELECT 1', 0);
    expect(writtenText(chunks)).toBe(clean);
    expect(writable.close).toHaveBeenCalledTimes(1);
    expect(writable.abort).not.toHaveBeenCalled();
    expect(h.hooks.toast).toHaveBeenCalledWith('Export incomplete — server error mid-stream: DB::Exception: Memory limit (total) exceeded');
  });

  // Issue #630 Phase 3 §11.9 — the real production `streamToFile` byte
  // cutover: `findExceptionFrame` (package-owned) now takes the raw held
  // bytes directly, with no caller-side latin1 conversion. Arbitrary invalid
  // UTF-8 bytes in the clean prefix must reach the file byte-identical, and
  // the trailing tagged frame's bytes must never be written.
  it('excises a mid-stream exception frame after an invalid-UTF-8 clean prefix — the clean bytes are written byte-identical, never decoded', async () => {
    const TAG = 'abcdef0123456789';
    const { handle, writable, chunks } = fakeFileHandle();
    const enc = new TextEncoder();
    const cleanBytes = concatBytes(
      enc.encode('col1\tcol2\n'),
      new Uint8Array([0xff, 0xfe, 0x00]), // invalid UTF-8 on their own
      enc.encode('\teuro=€\n'), // a valid multibyte UTF-8 sequence alongside them
    );
    const frameBytes = exceptionFrameBytes(TAG, 'DB::Exception: Memory limit (total) exceeded');
    const h = makeHarness({ sink: { pickFile: vi.fn(async () => asFileHandleLike(handle)) } });
    h.ch.exportResponse.mockResolvedValue(asResponse(fakeExportResponse({
      body: streamBodyBytes([cleanBytes, frameBytes]),
      headers: { 'X-ClickHouse-Exception-Tag': TAG },
    })));
    await createExportService(h.deps).exportDirect('SELECT 1', 0);
    expect(writtenBytes(chunks)).toEqual(cleanBytes);
    expect(writable.close).toHaveBeenCalledTimes(1);
    expect(writable.abort).not.toHaveBeenCalled();
    expect(h.hooks.toast).toHaveBeenCalledWith('Export incomplete — server error mid-stream: DB::Exception: Memory limit (total) exceeded');
  });

  // Issue #630 Phase 3 §11.9 — a clean payload that merely CONTAINS
  // marker-looking ordinary bytes (the literal `__exception__` text, e.g. a
  // `system.query_log.exception` column value) but carries no real frame
  // (no `X-ClickHouse-Exception-Tag` header, so the legacy no-tag path
  // applies and finds no `Code: N. DB::Exception:` suffix either) must be
  // written completely — `findExceptionFrame` returning null must not
  // truncate anything.
  it('writes a clean payload containing marker-looking ordinary bytes completely when findExceptionFrame finds no real frame', async () => {
    const { handle, writable, chunks } = fakeFileHandle();
    const data = 'note\t__exception__ mentioned in this row, not a real frame\n';
    const h = makeHarness({ sink: { pickFile: vi.fn(async () => asFileHandleLike(handle)) } });
    h.ch.exportResponse.mockResolvedValue(asResponse(fakeExportResponse({ body: streamBody([data]) })));
    await createExportService(h.deps).exportDirect('SELECT 1', 0);
    expect(writtenText(chunks)).toBe(data);
    expect(writable.close).toHaveBeenCalledTimes(1);
    expect(h.hooks.toast).toHaveBeenCalledWith('Export complete');
  });

  it('a stream read failure mid-export closes (not aborts) the writable and renames it .partial', async () => {
    const { handle, writable } = fakeFileHandle('My_Query.tsv');
    let reads = 0;
    const body: FakeBody = {
      getReader: () => ({
        read: async () => {
          reads += 1;
          if (reads === 1) return { done: false, value: new TextEncoder().encode('partial') };
          throw new Error('network drop');
        },
        releaseLock: () => {},
      }),
    };
    const h = makeHarness({ sink: { pickFile: vi.fn(async () => asFileHandleLike(handle)) } });
    h.ch.exportResponse.mockResolvedValue(asResponse(fakeExportResponse({ body })));
    await createExportService(h.deps).exportDirect('SELECT 1', 0);
    expect(writable.abort).not.toHaveBeenCalled();
    expect(writable.close).toHaveBeenCalledTimes(1);
    expect(handle.move).toHaveBeenCalledWith('My_Query.tsv.partial');
    expect(h.hooks.toast).toHaveBeenCalledWith('Export failed: network drop');
    expect(h.state.exporting.value).toBe(false);
  });

  it('handles cancellation observed between stream reads and a failing cleanup close', async () => {
    const { handle, writable } = fakeFileHandle('cancel.tsv');
    (writable.close as Mock).mockRejectedValue(new Error('close failed'));
    let service: ReturnType<typeof createExportService>;
    const body: FakeBody = {
      getReader: () => ({
        read: async () => {
          service.cancelExport();
          return { done: false, value: new TextEncoder().encode('late') };
        },
        releaseLock: vi.fn(),
      }),
    };
    const h = makeHarness({ sink: { pickFile: vi.fn(async () => asFileHandleLike(handle)) } });
    h.ch.exportResponse.mockResolvedValue(asResponse(fakeExportResponse({ body })));
    service = createExportService(h.deps);
    await service.exportDirect('SELECT 1', 0);
    expect(writable.close).toHaveBeenCalled();
    expect(handle.move).toHaveBeenCalledWith('cancel.tsv.partial');
    expect(h.hooks.toast).not.toHaveBeenCalled();
  });

  it('falls back to leaving the plain (non-renamed) file when the handle has no move()', async () => {
    const { handle, writable } = fakeFileHandle();
    delete handle.move;
    const h = makeHarness({ sink: { pickFile: vi.fn(async () => asFileHandleLike(handle)) } });
    h.ch.exportResponse.mockResolvedValue(asResponse(fakeExportResponse({ body: throwingBody('network drop') })));
    await createExportService(h.deps).exportDirect('SELECT 1', 0);
    expect(writable.abort).not.toHaveBeenCalled();
    expect(writable.close).toHaveBeenCalledTimes(1);
    expect(h.hooks.toast).toHaveBeenCalledWith('Export failed: network drop');
  });

  it('a failed move() (e.g. name collision) is swallowed — the plain file is still recoverable', async () => {
    const { handle, writable } = fakeFileHandle();
    handle.move = vi.fn(async () => { throw new Error('collision'); });
    const h = makeHarness({ sink: { pickFile: vi.fn(async () => asFileHandleLike(handle)) } });
    h.ch.exportResponse.mockResolvedValue(asResponse(fakeExportResponse({ body: throwingBody('network drop') })));
    await createExportService(h.deps).exportDirect('SELECT 1', 0);
    expect(writable.abort).not.toHaveBeenCalled();
    expect(handle.move).toHaveBeenCalledTimes(1);
    expect(h.hooks.toast).toHaveBeenCalledWith('Export failed: network drop');
  });

  it('exporting.value is true for the duration of the run; cancelExport aborts the signal + issues its own owner-scoped KILL QUERY', async () => {
    const { handle } = fakeFileHandle();
    const pending = deferred<Response>();
    const h = makeHarness({ sink: { pickFile: vi.fn(async () => asFileHandleLike(handle)) } });
    h.ch.exportResponse.mockImplementation(async () => pending.promise);
    const service = createExportService(h.deps);
    const run = service.exportDirect('SELECT 1', 0);
    await flush();
    expect(h.state.exporting.value).toBe(true);
    const signalArg = exportCall(h).signal as AbortSignal;
    expect(signalArg.aborted).toBe(false);

    service.cancelExport();
    expect(signalArg.aborted).toBe(true);
    pending.reject(abortError());
    await run;

    expect(h.state.exporting.value).toBe(false);
    expect(h.hooks.toast).not.toHaveBeenCalled(); // AbortError → silent
    // No executionScope supplied by this harness (defaults to `() => null`),
    // so the owner epoch captured at wave start is null.
    expect(h.ch.cancel).toHaveBeenCalledWith(null, expect.stringMatching(/^export-/));
  });

  // #630 Phase 7 §9.3/9.5/§23 "owner-epoch cancel matrix" — cancelExport
  // must pass the operation-owner epoch (the scope's `.epoch` at wave
  // start), never a hardcoded/omitted value, and local abort must happen
  // BEFORE the remote cancel call.
  it('cancelExport passes the wave-start execution scope epoch to deps.cancel, local abort before remote kill', async () => {
    const { handle } = fakeFileHandle();
    const pending = deferred<Response>();
    const order: string[] = [];
    const h = makeHarness({
      executionScope: () => scopeWithChecks(Array(20).fill(true)),
      sink: { pickFile: vi.fn(async () => asFileHandleLike(handle)) },
    });
    (h.ch.cancel as Mock).mockImplementation(async () => { order.push('remote'); });
    h.ch.exportResponse.mockImplementation(async () => pending.promise);
    const service = createExportService(h.deps);
    const run = service.exportDirect('SELECT 1', 0);
    await flush();
    const signalArg = exportCall(h).signal as AbortSignal;
    signalArg.addEventListener('abort', () => order.push('local-abort'));
    service.cancelExport();
    pending.reject(abortError());
    await run;
    // `scopeWithChecks`'s fixed epoch is 1 (see its own definition below).
    expect(h.ch.cancel).toHaveBeenCalledWith(1, expect.stringMatching(/^export-/));
    expect(order).toEqual(['local-abort', 'remote']);
  });

  it('a second click while the picker is still open is blocked (exporting flips true before the picker await)', async () => {
    const pending = deferred<FileHandleLike>();
    const h = makeHarness({ sink: { pickFile: vi.fn(() => pending.promise) } });
    const service = createExportService(h.deps);
    const first = service.exportDirect('SELECT 1', 0);
    await flush();
    expect(h.state.exporting.value).toBe(true);
    await service.exportDirect('SELECT 1', 0); // second click: blocked by the re-entrance guard
    expect(h.sink.pickFile).toHaveBeenCalledTimes(1);
    pending.reject(abortError());
    await first;
    expect(h.state.exporting.value).toBe(false);
  });

  it('shows + tears down the progress banner around the streamed request', async () => {
    const { handle } = fakeFileHandle();
    const progress = { update: vi.fn(), remove: vi.fn() };
    const h = makeHarness({
      sink: { pickFile: vi.fn(async () => asFileHandleLike(handle)) },
      hooks: { showExportProgress: vi.fn(() => progress) },
    });
    h.ch.exportResponse.mockResolvedValue(asResponse(fakeExportResponse({ body: streamBody(['a'.repeat(50)]) })));
    await createExportService(h.deps).exportDirect('SELECT 1', 0);
    expect(h.hooks.showExportProgress).toHaveBeenCalledTimes(1);
    expect(progress.update).toHaveBeenCalled();
    expect(progress.remove).toHaveBeenCalledTimes(1);
  });
});

describe('createExportService: authenticated execution scope', () => {
  it('fences each direct-export continuation independently when its epoch has closed', async () => {
    // The explicit sequences model a loss at: entry, picker settlement,
    // configuration settlement, token settlement, progress construction, and
    // request settlement.  None may move work into a replacement scope.
    const runs = [
      [false], [true, false], [true, true, false],
      [true, true, true, false], [true, true, true, true, false],
      [true, true, true, true, true, false],
    ];
    for (const checks of runs) {
      const { handle } = fakeFileHandle();
      const h = makeHarness({
        executionScope: () => scopeWithChecks([...checks]),
        sink: { pickFile: vi.fn(async () => asFileHandleLike(handle)) },
      });
      await createExportService(h.deps).exportDirect('SELECT 1', 0);
      expect(h.state.exporting.value).toBe(false);
    }
  });

  it('fences script-export preflight and its internal loop at each epoch boundary', async () => {
    const runs = [
      [false], [true, false], [true, true, false], [true, true, true, false],
      [true, true, true, true, false], [true, true, true, true, true, false],
      [true, true, true, true, true, true, false],
      [true, true, true, true, true, true, true, false],
      [true, true, true, true, true, true, true, true, false],
      [true, true, true, true, true, true, true, true, true, false],
    ];
    for (const checks of runs) {
      const { dir } = fakeDirHandle();
      const h = makeHarness({
        executionScope: () => scopeWithChecks([...checks]),
        sink: { pickDirectory: vi.fn(async () => dir) },
        tab: { sqlDraft: 'SELECT 1; SELECT 2' },
      });
      await createExportService(h.deps).exportEntry();
      expect(h.state.exporting.value).toBe(false);
    }
  });

  it('suppresses stale picker failures and a stale signed-out callback', async () => {
    const pickerFailure = makeHarness({
      executionScope: () => scopeWithChecks([true, false]),
      sink: { pickFile: vi.fn(async () => { throw new Error('late picker'); }) },
    });
    await createExportService(pickerFailure.deps).exportDirect('SELECT 1', 0);
    expect(pickerFailure.hooks.toast).not.toHaveBeenCalled();

    const tokenLoss = makeHarness({
      executionScope: () => scopeWithChecks([true, true, true, false]),
      getToken: async () => null,
    });
    await createExportService(tokenLoss.deps).exportDirect('SELECT 1', 0);
    expect(tokenLoss.ctx.onSignedOut).not.toHaveBeenCalled();
  });

  it('fences stale direct-export progress and final completion independently', async () => {
    const many = 'x'.repeat(33 * 1024);
    const progress = makeHarness({ executionScope: () => scopeWithChecks([true, true, true, true, true, true, false, true]) });
    progress.ch.exportResponse.mockResolvedValue(asResponse(fakeExportResponse({ body: streamBody([many]) })));
    await createExportService(progress.deps).exportDirect('SELECT 1', 0);
    expect(progress.hooks.toast).not.toHaveBeenCalled();

    const final = makeHarness({ executionScope: () => scopeWithChecks([true, true, true, true, true, true, true, false]) });
    final.ch.exportResponse.mockResolvedValue(asResponse(fakeExportResponse({ body: streamBody([many]) })));
    await createExportService(final.deps).exportDirect('SELECT 1', 0);
    expect(final.hooks.toast).not.toHaveBeenCalled();
  });

  it('suppresses stale script picker and per-statement settlements', async () => {
    const pickerFailure = makeHarness({
      executionScope: () => scopeWithChecks([true, false]),
      tab: { sqlDraft: 'SELECT 1; SELECT 2' },
      sink: { pickDirectory: vi.fn(async () => { throw new Error('late picker'); }) },
    });
    await createExportService(pickerFailure.deps).exportEntry();
    expect(pickerFailure.hooks.toast).not.toHaveBeenCalled();

    const afterEffect = makeHarness({
      executionScope: () => scopeWithChecks([true, true, true, true, true, true, true, true, false]),
      tab: { sqlDraft: 'CREATE TABLE t (x Int8); SELECT 1' },
    });
    await createExportService(afterEffect.deps).exportEntry();
    expect(afterEffect.hooks.renderResults).toHaveBeenCalled();

    const failedEffect = makeHarness({
      executionScope: () => scopeWithChecks([true, true, true, true, true, true, true, true, false]),
      tab: { sqlDraft: 'CREATE TABLE t (x Int8); SELECT 1' },
    });
    failedEffect.ch.runEffectText.mockRejectedValue(new Error('late failure'));
    await createExportService(failedEffect.deps).exportEntry();
    expect(failedEffect.hooks.renderResults).toHaveBeenCalled();
  });

  it('stops effect-script settlement and final bookkeeping when its owning scope closes', async () => {
    const afterTransport = deferred<string>();
    const transportScope = executionScope();
    const transport = makeHarness({
      executionScope: () => transportScope,
      tab: { sqlDraft: 'CREATE TABLE t (x Int8); SELECT 1' },
    });
    transport.ch.runEffectText.mockImplementation(() => afterTransport.promise);
    const pending = createExportService(transport.deps).exportEntry();
    await flush();
    transportScope.close();
    afterTransport.resolve('');
    await pending;
    expect(transport.hooks.loadSchema).not.toHaveBeenCalled();

    const failedTransport = deferred<string>();
    const failedScope = executionScope();
    const failed = makeHarness({
      executionScope: () => failedScope,
      tab: { sqlDraft: 'CREATE TABLE t (x Int8); SELECT 1' },
    });
    failed.ch.runEffectText.mockImplementation(() => failedTransport.promise);
    const failedPending = createExportService(failed.deps).exportEntry();
    await flush();
    failedScope.close();
    failedTransport.reject(new Error('late failure'));
    await failedPending;

    const finalScope = executionScope();
    let renders = 0;
    const final = makeHarness({
      executionScope: () => finalScope,
      tab: { sqlDraft: 'SELECT 1; SELECT 2' },
      hooks: { renderResults: vi.fn(() => { renders += 1; if (renders === 5) finalScope.close(); }) },
    });
    await createExportService(final.deps).exportEntry();
    expect(final.state.exporting.value).toBe(false);
  });

  it('retains a partial file when cancellation races exactly with end-of-stream', async () => {
    const scope = executionScope();
    let reads = 0;
    const body: FakeBody = {
      getReader: () => ({
        read: async () => {
          reads += 1;
          if (reads === 1) return { done: false, value: new TextEncoder().encode('tail') };
          scope.close();
          return { done: true };
        },
        releaseLock: () => {},
      }),
    };
    const { handle, writable } = fakeFileHandle();
    const h = makeHarness({
      executionScope: () => scope,
      sink: { pickFile: vi.fn(async () => asFileHandleLike(handle)) },
    });
    h.ch.exportResponse.mockResolvedValue(asResponse(fakeExportResponse({ body })));
    await createExportService(h.deps).exportDirect('SELECT 1', 0);
    expect(writable.close).toHaveBeenCalled();
  });

  it('stops a direct export during the picker preflight; its late resolution cannot configure, authenticate, or toast', async () => {
    const picker = deferred<FileHandleLike>();
    const scope = executionScope();
    const h = makeHarness({ executionScope: () => scope, sink: { pickFile: vi.fn(() => picker.promise) } });
    const run = createExportService(h.deps).exportDirect('SELECT 1', 0);
    await flush();
    expect(h.state.exporting.value).toBe(true);

    scope.close();
    expect(h.state.exporting.value).toBe(false);
    picker.resolve(asFileHandleLike(fakeFileHandle().handle));
    await run;

    expect(h.deps.ensureConfig).not.toHaveBeenCalled();
    expect(h.deps.getToken).not.toHaveBeenCalled();
    expect(h.ch.exportResponse).not.toHaveBeenCalled();
    expect(h.hooks.toast).not.toHaveBeenCalled();
  });

  it('closes a direct request with its captured query id and fences its late success/progress settlement', async () => {
    const cancelRemote = vi.fn();
    const scope = createAuthenticatedExecutionScope({ epoch: 1, cancelRemote });
    const pending = deferred<Response>();
    const progress = { update: vi.fn(), remove: vi.fn() };
    const { handle } = fakeFileHandle();
    const h = makeHarness({
      executionScope: () => scope,
      sink: { pickFile: vi.fn(async () => asFileHandleLike(handle)) },
      hooks: { showExportProgress: vi.fn(() => progress) },
    });
    h.ch.exportResponse.mockImplementation(async () => pending.promise);
    const run = createExportService(h.deps).exportDirect('SELECT 1', 0);
    await flush();
    const queryId = exportCall(h).params!.query_id as string;

    scope.close({ epoch: 1, origin: 'https://ch.example', authorization: 'Bearer old', fetch: h.ctx.fetch });
    expect(h.state.exporting.value).toBe(false);
    expect(progress.remove).toHaveBeenCalledTimes(1);
    expect(cancelRemote).toHaveBeenCalledWith(expect.objectContaining({ authorization: 'Bearer old' }), queryId);
    pending.resolve(asResponse(fakeExportResponse({ body: streamBody(['late']) })));
    await run;

    expect(progress.update).not.toHaveBeenCalled();
    expect(h.hooks.toast).not.toHaveBeenCalled();
  });

  it('fences a direct export that loses auth while its writable is still opening', async () => {
    const scope = executionScope();
    const writableDeferred = deferred<FakeWritable>();
    const { writable } = fakeFileHandle();
    const handle: FakeFileHandle = {
      name: 'late.tsv',
      createWritable: vi.fn(() => writableDeferred.promise),
    };
    const h = makeHarness({
      executionScope: () => scope,
      sink: { pickFile: vi.fn(async () => asFileHandleLike(handle)) },
    });
    h.ch.exportResponse.mockResolvedValue(asResponse(fakeExportResponse({ body: streamBody(['late']) })));
    const run = createExportService(h.deps).exportDirect('SELECT 1', 0);
    await flush();
    scope.close();
    writableDeferred.resolve(writable);
    await run;

    expect(writable.write).not.toHaveBeenCalled();
    expect(h.hooks.toast).not.toHaveBeenCalled();
    expect(h.state.exporting.value).toBe(false);
  });

  it('allows a replacement scope to start a fresh export after a lost picker wave settles', async () => {
    const picker = deferred<FileHandleLike>();
    let scope = executionScope();
    const h = makeHarness({ executionScope: () => scope, sink: { pickFile: vi.fn(() => picker.promise) } });
    const service = createExportService(h.deps);
    const oldRun = service.exportDirect('SELECT 1', 0);
    await flush();
    scope.close();
    scope = executionScope(2);
    picker.resolve(asFileHandleLike(fakeFileHandle().handle));
    await oldRun;

    const { handle } = fakeFileHandle();
    (h.sink.pickFile as Mock).mockResolvedValueOnce(asFileHandleLike(handle));
    await service.exportDirect('SELECT 2', 0);
    expect(h.ch.exportResponse).toHaveBeenCalledTimes(1);
    expect(exportCall(h).sql).toContain('SELECT 2');
    expect(h.state.exporting.value).toBe(false);
  });

  it('aborts a script row with the current query id and cannot paint its late completion', async () => {
    const cancelRemote = vi.fn();
    const scope = createAuthenticatedExecutionScope({ epoch: 1, cancelRemote });
    const pending = deferred<Response>();
    const { dir } = fakeDirHandle();
    const h = makeHarness({
      executionScope: () => scope,
      tab: { sqlDraft: 'SELECT 1; SELECT 2' },
      sink: { pickDirectory: vi.fn(async () => dir) },
    });
    h.ch.exportResponse.mockImplementation(async () => pending.promise);
    const run = createExportService(h.deps).exportEntry();
    await flush();
    const queryId = exportCall(h).params!.query_id as string;
    const rendersBeforeClose = (h.hooks.renderResults as Mock).mock.calls.length;

    scope.close({ epoch: 1, origin: 'https://ch.example', authorization: 'Bearer old', fetch: h.ctx.fetch });
    expect(h.state.exporting.value).toBe(false);
    expect(cancelRemote).toHaveBeenCalledWith(expect.anything(), queryId);
    pending.resolve(asResponse(fakeExportResponse({ body: streamBody(['late']) })));
    await run;

    expect((h.hooks.renderResults as Mock).mock.calls.length).toBe(rendersBeforeClose);
    expect(h.ch.exportResponse).toHaveBeenCalledTimes(1);
  });

  it('stops a script export in preflight and never lets the late directory picker start transport', async () => {
    const directory = deferred<DirectoryHandleLike>();
    const scope = executionScope();
    const h = makeHarness({
      executionScope: () => scope,
      tab: { sqlDraft: 'SELECT 1; SELECT 2' },
      sink: { pickDirectory: vi.fn(() => directory.promise) },
    });
    const run = createExportService(h.deps).exportEntry();
    await flush();
    scope.close();
    expect(h.state.exporting.value).toBe(false);
    directory.resolve(fakeDirHandle().dir);
    await run;

    expect(h.deps.ensureConfig).not.toHaveBeenCalled();
    expect(h.ch.exportResponse).not.toHaveBeenCalled();
    expect(h.ch.runEffectText).not.toHaveBeenCalled();
    expect(h.hooks.renderResults).not.toHaveBeenCalled();
  });
});

// ── exportScriptEntry / exportScript (issue #99) ────────────────────────────

describe('createExportService: exportScriptEntry / exportScript (issue #99)', () => {
  it('canExportScript() gates the directory picker; a script with no result-producing statements toasts instead', async () => {
    const unavailable = makeHarness({ canExportScript: () => false, tab: { sqlDraft: 'SELECT 1;\nSELECT 2;' } });
    await createExportService(unavailable.deps).exportEntry();
    expect(unavailable.hooks.toast).toHaveBeenCalledWith('Script export requires Chrome/Edge directory access over HTTPS');
    expect(unavailable.sink.pickDirectory).not.toHaveBeenCalled();
    expect(unavailable.state.exporting.value).toBe(false);

    const noRows = makeHarness({ tab: { sqlDraft: 'CREATE TABLE t (a Int8);\nINSERT INTO t VALUES (1);' } });
    await createExportService(noRows.deps).exportEntry();
    expect(noRows.sink.pickDirectory).not.toHaveBeenCalled();
    expect(noRows.hooks.toast).toHaveBeenCalledWith('Nothing to export — script has no result-producing statements.');
  });

  it('dismissing the directory picker (AbortError) is a silent no-op', async () => {
    const h = makeHarness({ sink: { pickDirectory: vi.fn(async () => { throw abortError(); }) }, tab: { sqlDraft: 'SELECT 1;\nSELECT 2;' } });
    await createExportService(h.deps).exportEntry();
    expect(h.hooks.toast).not.toHaveBeenCalled();
    expect(h.state.exporting.value).toBe(false);
  });

  it('a non-abort directory-picker failure toasts "Folder dialog failed"', async () => {
    const h = makeHarness({ sink: { pickDirectory: vi.fn(async () => { throw new Error('denied'); }) }, tab: { sqlDraft: 'SELECT 1;\nSELECT 2;' } });
    await createExportService(h.deps).exportEntry();
    expect(h.hooks.toast).toHaveBeenCalledWith('Folder dialog failed: denied');
  });

  it('reports a non-Error directory-picker rejection', async () => {
    const h = makeHarness({
      sink: { pickDirectory: vi.fn(async () => { throw 'folder offline'; }) },
      tab: { sqlDraft: 'SELECT 1; SELECT 2' },
    });
    await createExportService(h.deps).exportEntry();
    expect(h.hooks.toast).toHaveBeenCalledWith('Folder dialog failed: folder offline');
  });

  it('the directory picker opens BEFORE ensureConfig/getToken; a signed-out tab never runs the script', async () => {
    const { dir } = fakeDirHandle();
    const order: string[] = [];
    const h = makeHarness({
      sink: { pickDirectory: vi.fn(async () => { order.push('pickDirectory'); return dir; }) },
      ensureConfig: vi.fn(async () => { order.push('ensureConfig'); }),
      getToken: vi.fn(async () => { order.push('getToken'); return null; }),
      tab: { sqlDraft: 'SELECT 1;\nSELECT 2;' },
    });
    await createExportService(h.deps).exportEntry();
    expect(order).toEqual(['pickDirectory', 'ensureConfig', 'getToken']);
    expect(h.ctx.onSignedOut).toHaveBeenCalledTimes(1);
    expect((dir.getFileHandle as Mock)).not.toHaveBeenCalled();
    expect(h.state.exporting.value).toBe(false);
  });

  it('a second click while the directory picker is still open is blocked', async () => {
    const pending = deferred<DirectoryHandleLike>();
    const h = makeHarness({ sink: { pickDirectory: vi.fn(() => pending.promise) }, tab: { sqlDraft: 'SELECT 1;\nSELECT 2;' } });
    const service = createExportService(h.deps);
    const first = service.exportEntry();
    await flush();
    expect(h.state.exporting.value).toBe(true);
    await service.exportEntry();
    expect(h.sink.pickDirectory).toHaveBeenCalledTimes(1);
    pending.reject(abortError());
    await first;
    expect(h.state.exporting.value).toBe(false);
  });

  it('repaints script progress on the elapsed-time interval', async () => {
    vi.useFakeTimers();
    try {
      const { dir } = fakeDirHandle();
      const pending = deferred<Response>();
      const h = makeHarness({
        sink: { pickDirectory: vi.fn(async () => dir) },
        tab: { sqlDraft: 'SELECT 1; SELECT 2' },
      });
      h.ch.exportResponse.mockImplementationOnce(async () => pending.promise);
      const run = createExportService(h.deps).exportEntry();
      await vi.advanceTimersByTimeAsync(200);
      expect(h.hooks.renderResults).toHaveBeenCalled();
      pending.reject(new Error('stop'));
      await run;
    } finally {
      vi.useRealTimers();
    }
  });

  it('runs statements sequentially in one shared session; effect statements log ok with no file, rows stream to their own file', async () => {
    const { dir, written } = fakeDirHandle();
    const SCRIPT = 'CREATE TEMPORARY TABLE t (a Int8);\nINSERT INTO t VALUES (1);\nSELECT * FROM t';
    const h = makeHarness({
      sink: { pickDirectory: vi.fn(async () => dir) },
      tab: { sqlDraft: SCRIPT },
      params: {
        prepareTabSource: vi.fn(() => preparedSource({
          statements: [
            preparedStatement({ sql: 'CREATE TEMPORARY TABLE t (a Int8)' }),
            preparedStatement({ sql: 'INSERT INTO t VALUES (1)' }),
            preparedStatement({ sql: 'SELECT * FROM t' }),
          ],
        })),
        execStatementSql: vi.fn((s: string) => s),
      },
      sessionParamsFor: vi.fn(() => ({ session_id: 'sess-xyz' })),
    });
    h.ch.exportResponse.mockResolvedValue(asResponse(fakeExportResponse({ body: streamBody(['1\n']) })));
    await createExportService(h.deps).exportEntry();

    // Effect statements (non-'rows') go through runEffectText, whole-body
    // TabSeparatedWithNamesAndTypes text, wait_end_of_query=1 + CORS (#630
    // Phase 7 §13).
    expect(h.ch.runEffectText).toHaveBeenCalledTimes(2);
    expect(effectCall(h, 0).sql).toBe('CREATE TEMPORARY TABLE t (a Int8)');
    expect(effectCall(h, 0).defaultFormat).toBe('TabSeparatedWithNamesAndTypes');
    expect(effectCall(h, 0).settings).toEqual({ wait_end_of_query: 1, add_http_cors_header: 1 });
    expect(effectCall(h, 1).sql).toBe('INSERT INTO t VALUES (1)');
    [effectCall(h, 0), effectCall(h, 1)].forEach((c) => expect(c.params).toMatchObject({ session_id: 'sess-xyz' }));
    // Row-returning statement streams via exportResponse, one file.
    expect(h.ch.exportResponse).toHaveBeenCalledTimes(1);
    expect((dir.getFileHandle as Mock)).toHaveBeenCalledTimes(1);
    const [name] = (dir.getFileHandle as Mock).mock.calls[0];
    expect(name).toBe('003-t.tsv');
    expect(written.get('003-t.tsv')!.writable.close).toHaveBeenCalledTimes(1);
    expect(h.state.exporting.value).toBe(false);
  });

  it('row-returning statements get distinct, deterministic file names', async () => {
    const { dir } = fakeDirHandle();
    const h = makeHarness({
      sink: { pickDirectory: vi.fn(async () => dir) },
      tab: { sqlDraft: 'SELECT 1;\nSELECT 2;' },
    });
    h.ch.exportResponse
      .mockResolvedValueOnce(asResponse(fakeExportResponse({ body: streamBody(['a']) })))
      .mockResolvedValueOnce(asResponse(fakeExportResponse({ body: streamBody(['b']) })));
    await createExportService(h.deps).exportEntry();
    const names = (dir.getFileHandle as Mock).mock.calls.map((c) => c[0]);
    expect(names).toEqual(['001-select-1.tsv', '002-select-2.tsv']);
  });

  it('respects an explicit trailing FORMAT per statement', async () => {
    const { dir } = fakeDirHandle();
    const h = makeHarness({
      sink: { pickDirectory: vi.fn(async () => dir) },
      tab: { sqlDraft: 'SELECT 1 FORMAT JSON;\nSELECT 2;' },
      params: { execStatementSql: vi.fn((s: string) => s) },
    });
    h.ch.exportResponse
      .mockResolvedValueOnce(asResponse(fakeExportResponse({ body: streamBody(['[]']) })))
      .mockResolvedValueOnce(asResponse(fakeExportResponse({ body: streamBody(['x']) })));
    await createExportService(h.deps).exportEntry();
    const names = (dir.getFileHandle as Mock).mock.calls.map((c) => c[0]);
    expect(names).toEqual(['001-select-1-format-json.json', '002-select-2.tsv']);
  });

  it('a non-row statement error marks it failed with no file and stops the script; the rest are skipped', async () => {
    const { dir } = fakeDirHandle();
    const h = makeHarness({
      sink: { pickDirectory: vi.fn(async () => dir) },
      tab: { sqlDraft: 'CREATE TABLE bad;\nSELECT 1;' },
    });
    h.ch.runEffectText.mockRejectedValue(new Error('DB::Exception: table exists'));
    await createExportService(h.deps).exportEntry();
    expect((dir.getFileHandle as Mock)).not.toHaveBeenCalled();
    expect(h.hooks.loadSchema).not.toHaveBeenCalled();
  });

  it('a pre-header (non-OK) export failure marks the row failed and stops; the rest are skipped', async () => {
    const { dir } = fakeDirHandle();
    const h = makeHarness({
      sink: { pickDirectory: vi.fn(async () => dir) },
      tab: { sqlDraft: 'SELECT 1;\nSELECT 2;' },
    });
    h.ch.exportResponse.mockRejectedValue(new Error('DB::Exception: nope'));
    await createExportService(h.deps).exportEntry();
    expect(h.ch.exportResponse).toHaveBeenCalledTimes(1); // stopped before statement 2
  });

  it('a mid-stream exception marks the row failed/incomplete and stops the script', async () => {
    const TAG = 'abcdef0123456789';
    const { dir } = fakeDirHandle();
    const clean = 'x'.repeat(10);
    const frame = exceptionFrame(TAG, 'DB::Exception: Memory limit (total) exceeded');
    const h = makeHarness({
      sink: { pickDirectory: vi.fn(async () => dir) },
      tab: { sqlDraft: 'SELECT 1;\nSELECT 2;' },
    });
    h.ch.exportResponse.mockResolvedValue(asResponse(fakeExportResponse({ body: streamBody([clean, frame]), headers: { 'X-ClickHouse-Exception-Tag': TAG } })));
    await createExportService(h.deps).exportEntry();
    expect(h.ch.exportResponse).toHaveBeenCalledTimes(1); // stopped before statement 2
  });

  it('never retries — a transient SESSION_IS_LOCKED failure is reported like any other error', async () => {
    const { dir } = fakeDirHandle();
    const h = makeHarness({
      sink: { pickDirectory: vi.fn(async () => dir) },
      tab: { sqlDraft: 'INSERT INTO t VALUES (1);\nSELECT 1;' },
    });
    h.ch.runEffectText.mockRejectedValue(new Error('Code: 373. DB::Exception: SESSION_IS_LOCKED'));
    await createExportService(h.deps).exportEntry();
    expect(h.ch.runEffectText).toHaveBeenCalledTimes(1); // no retry
    expect(h.ch.exportResponse).not.toHaveBeenCalled(); // stopped before the SELECT
  });

  it('cancelExportScript aborts the active row, marks it cancelled, skips the rest, kills the active query, keeps completed files', async () => {
    const { dir, written } = fakeDirHandle();
    const pending = deferred<Response>();
    const h = makeHarness({
      sink: { pickDirectory: vi.fn(async () => dir) },
      tab: { sqlDraft: 'SELECT 1;\nSELECT 2;\nSELECT 3;' },
    });
    h.ch.exportResponse
      .mockResolvedValueOnce(asResponse(fakeExportResponse({ body: streamBody(['a']) })))
      .mockImplementationOnce(async () => pending.promise);
    const service = createExportService(h.deps);
    const run = service.exportEntry();
    await flush();
    await flush(); // let stmt1 finish and stmt2's request kick off

    service.cancelExportScript();
    pending.reject(abortError());
    await run;

    expect(written.get('001-select-1.tsv')!.writable.close).toHaveBeenCalledTimes(1); // completed file kept
    expect(h.ch.cancel).toHaveBeenCalledWith(null, expect.stringMatching(/^export-/));
    expect(h.state.exporting.value).toBe(false);
  });

  // #630 Phase 7 §9.3/9.5/§23 "owner-epoch cancel matrix" — the script-export
  // path's own owner epoch (captured once, at wave start) reaches
  // cancelExportScript's remote kill, exactly like cancelExport's.
  it('cancelExportScript passes the wave-start execution scope epoch to deps.cancel', async () => {
    const { dir } = fakeDirHandle();
    const pending = deferred<Response>();
    const h = makeHarness({
      executionScope: () => scopeWithChecks(Array(30).fill(true)),
      sink: { pickDirectory: vi.fn(async () => dir) },
      tab: { sqlDraft: 'SELECT 1;\nSELECT 2;' },
    });
    h.ch.exportResponse.mockImplementation(async () => pending.promise);
    const service = createExportService(h.deps);
    const run = service.exportEntry();
    await flush();
    service.cancelExportScript();
    pending.reject(abortError());
    await run;
    // `scopeWithChecks`'s fixed epoch is 1 (see its own definition above).
    expect(h.ch.cancel).toHaveBeenCalledWith(1, expect.stringMatching(/^export-/));
  });

  it('a cancel that arrives just after a statement completed cleanly still skips the remaining statements', async () => {
    const { dir } = fakeDirHandle();
    const pending = deferred<string>();
    const h = makeHarness({
      sink: { pickDirectory: vi.fn(async () => dir) },
      tab: { sqlDraft: 'CREATE TABLE t (a Int8);\nSELECT 1;' },
    });
    h.ch.runEffectText.mockImplementationOnce(async () => pending.promise);
    const service = createExportService(h.deps);
    const run = service.exportEntry();
    await flush();
    service.cancelExportScript(); // cancel arrives while stmt1 is still in flight...
    pending.resolve(''); // ...but the request completes cleanly anyway
    await run;
    expect(h.ch.exportResponse).not.toHaveBeenCalled(); // stmt2 was skipped, not run
  });

  it('refreshes the schema when an effect statement that actually ran is schema-mutating', async () => {
    const { dir } = fakeDirHandle();
    const h = makeHarness({
      sink: { pickDirectory: vi.fn(async () => dir) },
      tab: { sqlDraft: 'CREATE TABLE t (a Int8);\nSELECT 1;' },
    });
    h.ch.exportResponse.mockResolvedValue(asResponse(fakeExportResponse({ body: streamBody(['x']) })));
    await createExportService(h.deps).exportEntry();
    expect(h.hooks.loadSchema).toHaveBeenCalledTimes(1);
  });

  it('does not refresh the schema when no statement that ran was schema-mutating', async () => {
    const { dir } = fakeDirHandle();
    const h = makeHarness({
      sink: { pickDirectory: vi.fn(async () => dir) },
      tab: { sqlDraft: 'SELECT 1;\nSELECT 2;' },
    });
    h.ch.exportResponse
      .mockResolvedValueOnce(asResponse(fakeExportResponse({ body: streamBody(['x']) })))
      .mockResolvedValueOnce(asResponse(fakeExportResponse({ body: streamBody(['y']) })));
    await createExportService(h.deps).exportEntry();
    expect(h.hooks.loadSchema).not.toHaveBeenCalled();
  });

  it('repaints via hooks.renderResults on the interval tick + per statement', async () => {
    const { dir } = fakeDirHandle();
    const h = makeHarness({
      sink: { pickDirectory: vi.fn(async () => dir) },
      tab: { sqlDraft: 'SELECT 1;\nSELECT 2;' },
    });
    h.ch.exportResponse
      .mockResolvedValueOnce(asResponse(fakeExportResponse({ body: streamBody(['x']) })))
      .mockResolvedValueOnce(asResponse(fakeExportResponse({ body: streamBody(['y']) })));
    await createExportService(h.deps).exportEntry();
    expect((h.hooks.renderResults as Mock).mock.calls.length).toBeGreaterThan(0);
  });
});
