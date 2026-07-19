import { describe, it, expect, vi } from 'vitest';
import type { Mock } from 'vitest';
import { signal } from '@preact/signals-core';
import { sqlString } from '../../src/core/format.js';
import { splitStatements } from '../../src/core/sql-split.js';
import { createExportService } from '../../src/application/export-service.js';
import type {
  ExportServiceDeps, ExportStateSlice, ExportHooks, ExportSink,
  FileHandleLike, DirectoryHandleLike, WritableFileStreamLike,
} from '../../src/application/export-service.js';
import { newTabObj } from '../../src/state.js';
import type { QueryTab } from '../../src/state.js';
import type { ChCtx, RunQueryResult } from '../../src/net/ch-client.js';
import type { PreparedSource, PreparedStatement } from '../../src/core/param-pipeline.js';
import type { WorkbenchParameterSession } from '../../src/application/workbench-parameter-session.js';

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
// tests mock `exportQuery`/`runQuery` directly rather than a `fetch` seam, so
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
// `ExportServiceDeps.exportQuery`'s real signature returns a genuine DOM
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

function makeCh(): { exportQuery: Mock; runQuery: Mock; killQuery: Mock } {
  const exportQuery = vi.fn(async () => asResponse(fakeExportResponse({ body: streamBody([]) })));
  const runQuery = vi.fn(async (): Promise<RunQueryResult> => ({}));
  const killQuery = vi.fn(async () => {});
  return { exportQuery, runQuery, killQuery };
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
    revokeResultImage: vi.fn(),
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

interface Harness {
  deps: ExportServiceDeps;
  state: ExportStateSlice;
  hooks: ExportHooks;
  sink: ExportSink;
  ch: ReturnType<typeof makeCh>;
  ctx: ChCtx;
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
  sessionParamsFor?: (tab: QueryTab, sqls: string[]) => Record<string, string>;
} = {}): Harness {
  const state = makeState(opts.state);
  const hooks = makeHooks(opts.hooks);
  const sink = makeSink(opts.sink);
  const ch = makeCh();
  const tab: QueryTab = { ...newTabObj('t1'), ...opts.tab };
  const params = makeParams(opts.params);
  const ctx: ChCtx = {
    fetch: (undefined as unknown) as typeof fetch, origin: 'https://ch.example',
    getToken: async () => null, refresh: async () => false, onSignedOut: vi.fn(),
  };
  const uidSeq = { n: 0 };
  const deps: ExportServiceDeps = {
    exportQuery: ch.exportQuery, runQuery: ch.runQuery, killQuery: ch.killQuery,
    ctx: () => ctx,
    ensureConfig: opts.ensureConfig || vi.fn(async () => undefined),
    getToken: opts.getToken || vi.fn(async () => 'tok'),
    sqlString,
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
    expect(h.ch.exportQuery).not.toHaveBeenCalled();
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
    h.ch.exportQuery.mockResolvedValue(asResponse(fakeExportResponse({ body: streamBody(['a'.repeat(100)]) })));
    await createExportService(h.deps).exportDirect('SELECT 1', 0);
    expect(pickerOpts!.suggestedName).toBe('My_Query.tsv');
    expect(pickerOpts!.types[0].accept).toEqual({ 'text/tab-separated-values': ['.tsv'] });
    expect(writtenText(chunks)).toBe('a'.repeat(100));
    expect(writable.close).toHaveBeenCalledTimes(1);
    expect(writable.abort).not.toHaveBeenCalled();
    expect(h.hooks.toast).toHaveBeenCalledWith('Export complete');
    expect(h.state.exporting.value).toBe(false);
    const call = h.ch.exportQuery.mock.calls[0];
    expect(call[1]).toBe('SELECT 1\nFORMAT TabSeparatedWithNames');
    expect(call[2].format).toBe('TabSeparatedWithNames');
  });

  it('honors an explicit FORMAT in the query for the picker + the request', async () => {
    const { handle } = fakeFileHandle();
    let pickerOpts: { suggestedName: string; types: { accept: Record<string, string[]> }[] } | undefined;
    const h = makeHarness({
      sink: { pickFile: vi.fn(async (opts) => { pickerOpts = opts; return asFileHandleLike(handle); }) },
      params: { execStatementSql: vi.fn((s: string) => s) },
    });
    h.ch.exportQuery.mockResolvedValue(asResponse(fakeExportResponse({ body: streamBody(['[]']) })));
    await createExportService(h.deps).exportDirect('SELECT 1 FORMAT JSON', 0);
    expect(pickerOpts!.suggestedName).toMatch(/\.json$/);
    expect(pickerOpts!.types[0].accept).toEqual({ 'application/json': ['.json'] });
    const call = h.ch.exportQuery.mock.calls[0];
    expect(call[2].format).toBe('JSON');
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
    h.ch.exportQuery.mockResolvedValue(asResponse(fakeExportResponse({ body: streamBody(['x']) })));
    await createExportService(h.deps).exportDirect('SELECT {database:String}', 42);
    expect(h.params.prepareTabSource).toHaveBeenCalledWith('SELECT {database:String}\nFORMAT TabSeparatedWithNames', 42);
    const call = h.ch.exportQuery.mock.calls[0];
    expect(call[2].params).toEqual({ session_id: 'sess-1', param_database: 'default' });
  });

  it('a pre-header (non-OK) export failure toasts "Export failed" without ever opening the writable', async () => {
    const { handle } = fakeFileHandle();
    const h = makeHarness({ sink: { pickFile: vi.fn(async () => asFileHandleLike(handle)) } });
    h.ch.exportQuery.mockRejectedValue(new Error('DB::Exception: nope'));
    await createExportService(h.deps).exportDirect('SELECT 1', 0);
    expect(h.hooks.toast).toHaveBeenCalledWith('Export failed: DB::Exception: nope');
    expect(handle.createWritable).not.toHaveBeenCalled();
    expect(h.state.exporting.value).toBe(false);
  });

  it('suppresses the "Export failed" toast when the underlying error is "signed out"', async () => {
    const { handle } = fakeFileHandle();
    const h = makeHarness({ sink: { pickFile: vi.fn(async () => asFileHandleLike(handle)) } });
    h.ch.exportQuery.mockRejectedValue(new Error('signed out'));
    await createExportService(h.deps).exportDirect('SELECT 1', 0);
    expect(h.hooks.toast).not.toHaveBeenCalled();
    expect(h.state.exporting.value).toBe(false);
  });

  it('holds back the trailing 32 KiB and streams the rest incrementally (no full buffering)', async () => {
    const { handle, writable, chunks } = fakeFileHandle();
    const big = 'a'.repeat(40960); // > HOLDBACK (32 KiB) in a single chunk
    const h = makeHarness({ sink: { pickFile: vi.fn(async () => asFileHandleLike(handle)) } });
    h.ch.exportQuery.mockResolvedValue(asResponse(fakeExportResponse({ body: streamBody([big]) })));
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
    h.ch.exportQuery.mockResolvedValue(asResponse(fakeExportResponse({ body: streamBody([clean, frame]), headers: { 'X-ClickHouse-Exception-Tag': TAG } })));
    await createExportService(h.deps).exportDirect('SELECT 1', 0);
    expect(writtenText(chunks)).toBe(clean);
    expect(writable.close).toHaveBeenCalledTimes(1);
    expect(writable.abort).not.toHaveBeenCalled();
    expect(h.hooks.toast).toHaveBeenCalledWith('Export incomplete — server error mid-stream: DB::Exception: Memory limit (total) exceeded');
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
    h.ch.exportQuery.mockResolvedValue(asResponse(fakeExportResponse({ body })));
    await createExportService(h.deps).exportDirect('SELECT 1', 0);
    expect(writable.abort).not.toHaveBeenCalled();
    expect(writable.close).toHaveBeenCalledTimes(1);
    expect(handle.move).toHaveBeenCalledWith('My_Query.tsv.partial');
    expect(h.hooks.toast).toHaveBeenCalledWith('Export failed: network drop');
    expect(h.state.exporting.value).toBe(false);
  });

  it('falls back to leaving the plain (non-renamed) file when the handle has no move()', async () => {
    const { handle, writable } = fakeFileHandle();
    delete handle.move;
    const h = makeHarness({ sink: { pickFile: vi.fn(async () => asFileHandleLike(handle)) } });
    h.ch.exportQuery.mockResolvedValue(asResponse(fakeExportResponse({ body: throwingBody('network drop') })));
    await createExportService(h.deps).exportDirect('SELECT 1', 0);
    expect(writable.abort).not.toHaveBeenCalled();
    expect(writable.close).toHaveBeenCalledTimes(1);
    expect(h.hooks.toast).toHaveBeenCalledWith('Export failed: network drop');
  });

  it('a failed move() (e.g. name collision) is swallowed — the plain file is still recoverable', async () => {
    const { handle, writable } = fakeFileHandle();
    handle.move = vi.fn(async () => { throw new Error('collision'); });
    const h = makeHarness({ sink: { pickFile: vi.fn(async () => asFileHandleLike(handle)) } });
    h.ch.exportQuery.mockResolvedValue(asResponse(fakeExportResponse({ body: throwingBody('network drop') })));
    await createExportService(h.deps).exportDirect('SELECT 1', 0);
    expect(writable.abort).not.toHaveBeenCalled();
    expect(handle.move).toHaveBeenCalledTimes(1);
    expect(h.hooks.toast).toHaveBeenCalledWith('Export failed: network drop');
  });

  it('exporting.value is true for the duration of the run; cancelExport aborts the signal + issues its own KILL QUERY', async () => {
    const { handle } = fakeFileHandle();
    const pending = deferred<Response>();
    const h = makeHarness({ sink: { pickFile: vi.fn(async () => asFileHandleLike(handle)) } });
    h.ch.exportQuery.mockImplementation(async () => pending.promise);
    const service = createExportService(h.deps);
    const run = service.exportDirect('SELECT 1', 0);
    await flush();
    expect(h.state.exporting.value).toBe(true);
    const signalArg = h.ch.exportQuery.mock.calls[0][2].signal as AbortSignal;
    expect(signalArg.aborted).toBe(false);

    service.cancelExport();
    expect(signalArg.aborted).toBe(true);
    pending.reject(abortError());
    await run;

    expect(h.state.exporting.value).toBe(false);
    expect(h.hooks.toast).not.toHaveBeenCalled(); // AbortError → silent
    expect(h.ch.killQuery).toHaveBeenCalledWith(h.ctx, expect.stringMatching(/^export-/), sqlString);
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
    h.ch.exportQuery.mockResolvedValue(asResponse(fakeExportResponse({ body: streamBody(['a'.repeat(50)]) })));
    await createExportService(h.deps).exportDirect('SELECT 1', 0);
    expect(h.hooks.showExportProgress).toHaveBeenCalledTimes(1);
    expect(progress.update).toHaveBeenCalled();
    expect(progress.remove).toHaveBeenCalledTimes(1);
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

  // #318: exportScript() overwrites `tab.result` wholesale with its own
  // scriptExport log (`Object.assign(tab, { result: scriptExportResult })`) —
  // the same class of replacement workbench-session.ts's run()/runScript()
  // and tabs.ts's closeTab already guard with `hooks.revokeResultImage`, so a
  // tab that was showing a FORMAT PNG image result must free that image's
  // blob URL before the log replaces it, not leak it.
  it('revokes a previously-displayed image result\'s URL before overwriting tab.result with the script-export log', async () => {
    const { dir } = fakeDirHandle();
    const oldImageResult = { columns: [], rows: [], error: null, rawText: null, image: { kind: 'image' as const } };
    const h = makeHarness({
      sink: { pickDirectory: vi.fn(async () => dir) },
      tab: { sqlDraft: 'SELECT 1;\nSELECT 2;', result: oldImageResult },
    });
    await createExportService(h.deps).exportEntry();
    expect(h.hooks.revokeResultImage).toHaveBeenCalledWith(oldImageResult);
    // The call happens BEFORE the replacement — never with the already-replaced log.
    expect(h.tab.result).not.toBe(oldImageResult);
    expect(h.tab.result).toHaveProperty('scriptExport');
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
    h.ch.exportQuery.mockResolvedValue(asResponse(fakeExportResponse({ body: streamBody(['1\n']) })));
    await createExportService(h.deps).exportEntry();

    // Effect statements (non-'rows') go through runQuery with format TSV.
    expect(h.ch.runQuery).toHaveBeenCalledTimes(2);
    const runCalls = h.ch.runQuery.mock.calls;
    expect(runCalls[0][1]).toBe('CREATE TEMPORARY TABLE t (a Int8)');
    expect(runCalls[1][1]).toBe('INSERT INTO t VALUES (1)');
    runCalls.forEach((c) => expect(c[2].params).toMatchObject({ session_id: 'sess-xyz' }));
    // Row-returning statement streams via exportQuery, one file.
    expect(h.ch.exportQuery).toHaveBeenCalledTimes(1);
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
    h.ch.exportQuery
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
    h.ch.exportQuery
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
    h.ch.runQuery.mockResolvedValue({ error: 'DB::Exception: table exists' });
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
    h.ch.exportQuery.mockRejectedValue(new Error('DB::Exception: nope'));
    await createExportService(h.deps).exportEntry();
    expect(h.ch.exportQuery).toHaveBeenCalledTimes(1); // stopped before statement 2
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
    h.ch.exportQuery.mockResolvedValue(asResponse(fakeExportResponse({ body: streamBody([clean, frame]), headers: { 'X-ClickHouse-Exception-Tag': TAG } })));
    await createExportService(h.deps).exportEntry();
    expect(h.ch.exportQuery).toHaveBeenCalledTimes(1); // stopped before statement 2
  });

  it('never retries — a transient SESSION_IS_LOCKED failure is reported like any other error', async () => {
    const { dir } = fakeDirHandle();
    const h = makeHarness({
      sink: { pickDirectory: vi.fn(async () => dir) },
      tab: { sqlDraft: 'INSERT INTO t VALUES (1);\nSELECT 1;' },
    });
    h.ch.runQuery.mockResolvedValue({ error: 'Code: 373. DB::Exception: SESSION_IS_LOCKED' });
    await createExportService(h.deps).exportEntry();
    expect(h.ch.runQuery).toHaveBeenCalledTimes(1); // no retry
    expect(h.ch.exportQuery).not.toHaveBeenCalled(); // stopped before the SELECT
  });

  it('cancelExportScript aborts the active row, marks it cancelled, skips the rest, kills the active query, keeps completed files', async () => {
    const { dir, written } = fakeDirHandle();
    const pending = deferred<Response>();
    const h = makeHarness({
      sink: { pickDirectory: vi.fn(async () => dir) },
      tab: { sqlDraft: 'SELECT 1;\nSELECT 2;\nSELECT 3;' },
    });
    h.ch.exportQuery
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
    expect(h.ch.killQuery).toHaveBeenCalledWith(h.ctx, expect.stringMatching(/^export-/), sqlString);
    expect(h.state.exporting.value).toBe(false);
  });

  it('a cancel that arrives just after a statement completed cleanly still skips the remaining statements', async () => {
    const { dir } = fakeDirHandle();
    const pending = deferred<RunQueryResult>();
    const h = makeHarness({
      sink: { pickDirectory: vi.fn(async () => dir) },
      tab: { sqlDraft: 'CREATE TABLE t (a Int8);\nSELECT 1;' },
    });
    h.ch.runQuery.mockImplementationOnce(async () => pending.promise);
    const service = createExportService(h.deps);
    const run = service.exportEntry();
    await flush();
    service.cancelExportScript(); // cancel arrives while stmt1 is still in flight...
    pending.resolve({}); // ...but the request completes cleanly anyway
    await run;
    expect(h.ch.exportQuery).not.toHaveBeenCalled(); // stmt2 was skipped, not run
  });

  it('refreshes the schema when an effect statement that actually ran is schema-mutating', async () => {
    const { dir } = fakeDirHandle();
    const h = makeHarness({
      sink: { pickDirectory: vi.fn(async () => dir) },
      tab: { sqlDraft: 'CREATE TABLE t (a Int8);\nSELECT 1;' },
    });
    h.ch.exportQuery.mockResolvedValue(asResponse(fakeExportResponse({ body: streamBody(['x']) })));
    await createExportService(h.deps).exportEntry();
    expect(h.hooks.loadSchema).toHaveBeenCalledTimes(1);
  });

  it('does not refresh the schema when no statement that ran was schema-mutating', async () => {
    const { dir } = fakeDirHandle();
    const h = makeHarness({
      sink: { pickDirectory: vi.fn(async () => dir) },
      tab: { sqlDraft: 'SELECT 1;\nSELECT 2;' },
    });
    h.ch.exportQuery
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
    h.ch.exportQuery
      .mockResolvedValueOnce(asResponse(fakeExportResponse({ body: streamBody(['x']) })))
      .mockResolvedValueOnce(asResponse(fakeExportResponse({ body: streamBody(['y']) })));
    await createExportService(h.deps).exportEntry();
    expect((h.hooks.renderResults as Mock).mock.calls.length).toBeGreaterThan(0);
  });
});
