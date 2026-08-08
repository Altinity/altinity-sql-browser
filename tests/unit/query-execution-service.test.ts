import { describe, it, expect, vi } from 'vitest';
import {
  createQueryExecutionService,
} from '../../src/application/query-execution-service.js';
import type {
  QueryExecutionDeps, QueryExecutionRequest, QueryProgressCallbacks, ScriptStatement,
} from '../../src/application/query-execution-service.js';
import { newResult } from '../../src/core/stream.js';
import { SELECT_ROW_CAP } from '../../src/core/script-result.js';
import type { ScriptEntry } from '../../src/core/script-result.js';

// ── Fakes ────────────────────────────────────────────────────────────────────

/** One recorded `runProgress` call. */
interface ProgressCall { request: QueryExecutionRequest; callbacks: QueryProgressCallbacks }
/** One recorded `runText` call. */
interface TextCall { request: QueryExecutionRequest }

/** A scripted behavior for one queued `runProgress` call: may pulse
 * `callbacks.onLine`/`callbacks.onChunk` first (simulating a stream), then
 * either resolves (clean stream completion) or throws — the same shape the
 * real production `runProgress` (backed by `authenticatedProgress`) drives
 * its callers with. */
type ProgressBehavior = (callbacks: QueryProgressCallbacks) => void | Promise<void>;
/** A scripted behavior for one queued `runText` call: resolves with the raw
 * text body, or throws (matching the new "package consumers throw" contract
 * — #630 Phase 7 §6.5). */
type TextBehavior = () => string | Promise<string>;

function abortError(): Error {
  const e = new Error('aborted');
  e.name = 'AbortError';
  return e;
}

/** A queued fake matching `QueryExecutionDeps['runProgress']` exactly: each
 * call consumes the next queued behavior (throwing if the queue runs dry).
 * Records every call for assertions. */
function fakeRunProgress(behaviors: ProgressBehavior[]): { fn: QueryExecutionDeps['runProgress']; calls: ProgressCall[] } {
  const calls: ProgressCall[] = [];
  let i = 0;
  const fn = vi.fn(async (request: QueryExecutionRequest, callbacks: QueryProgressCallbacks): Promise<void> => {
    calls.push({ request, callbacks });
    const behavior = behaviors[i];
    i += 1;
    if (!behavior) throw new Error('unscripted runProgress call: ' + request.sql);
    await behavior(callbacks);
  });
  return { fn, calls };
}

/** A queued fake matching `QueryExecutionDeps['runText']` exactly. */
function fakeRunText(behaviors: TextBehavior[]): { fn: QueryExecutionDeps['runText']; calls: TextCall[] } {
  const calls: TextCall[] = [];
  let i = 0;
  const fn = vi.fn(async (request: QueryExecutionRequest): Promise<string> => {
    calls.push({ request });
    const behavior = behaviors[i];
    i += 1;
    if (!behavior) throw new Error('unscripted runText call: ' + request.sql);
    return behavior();
  });
  return { fn, calls };
}

function fakeCancel(): { fn: QueryExecutionDeps['cancel']; calls: { ownerEpoch: number | null | undefined; queryId: string | null | undefined }[] } {
  const calls: { ownerEpoch: number | null | undefined; queryId: string | null | undefined }[] = [];
  const fn = vi.fn(async (ownerEpoch: number | null | undefined, queryId: string | null | undefined): Promise<void> => {
    calls.push({ ownerEpoch, queryId });
  });
  return { fn, calls };
}

/** A deterministic uid sequence: 'q-1', 'q-2', … — matches the shape of
 * app.ts's real `uid('q')` (prefix + a counter) closely enough for assertions
 * on "fresh id per attempt" without depending on crypto.randomUUID. */
function makeUid(): (prefix: string) => string {
  let n = 0;
  return (prefix: string) => { n += 1; return `${prefix}-${n}`; };
}

/** A deterministic perf clock: each call advances by 10 — since the service
 * calls `now()` exactly twice per statement (s0, then the final ms read),
 * every entry's `ms` is predictably 10. */
function makeNow(): () => number {
  let t = 0;
  return () => { t += 10; return t; };
}

function makeDeps(over: Partial<QueryExecutionDeps> = {}): QueryExecutionDeps {
  return {
    runProgress: fakeRunProgress([]).fn,
    runText: fakeRunText([]).fn,
    cancel: fakeCancel().fn,
    now: makeNow(),
    uid: makeUid(),
    retryMs: 7,
    sleep: vi.fn(async () => {}),
    ...over,
  };
}

// ── executeRead ──────────────────────────────────────────────────────────────

describe('executeRead', () => {
  it('folds streamed lines into the result via applyStreamLine (Table -> progress)', async () => {
    const { fn, calls } = fakeRunProgress([
      (cbs) => {
        cbs.onLine!({ meta: [{ name: 'x', type: 'Int32' }] });
        cbs.onLine!({ row: { x: 1 } });
      },
    ]);
    const svc = createQueryExecutionService(makeDeps({ runProgress: fn }));
    const result = newResult('Table');
    const out = await svc.executeRead(result, { sql: 'SELECT 1' });
    expect(out.columns).toEqual([{ name: 'x', type: 'Int32' }]);
    expect(out.rows).toEqual([[1]]);
    expect(calls[0].request.sql).toBe('SELECT 1');
  });

  it('maps Table to JSONStringsEachRowWithProgress with CORS, no wait_end_of_query, no cap at rowLimit 0', async () => {
    const { fn, calls } = fakeRunProgress([() => {}]);
    const svc = createQueryExecutionService(makeDeps({ runProgress: fn }));
    await svc.executeRead(newResult('Table'), { sql: 'SELECT 1' });
    expect(calls[0].request.defaultFormat).toBe('JSONStringsEachRowWithProgress');
    expect(calls[0].request.settings).toEqual({ add_http_cors_header: 1 });
  });

  it('maps KPI to JSONEachRowWithProgress with CORS, no wait_end_of_query', async () => {
    const { fn, calls } = fakeRunProgress([() => {}]);
    const svc = createQueryExecutionService(makeDeps({ runProgress: fn }));
    await svc.executeRead(newResult('KPI'), { sql: 'SELECT 1', format: 'KPI' });
    expect(calls[0].request.defaultFormat).toBe('JSONEachRowWithProgress');
    expect(calls[0].request.settings).toEqual({ add_http_cors_header: 1 });
  });

  it('a positive rowLimit adds max_result_rows/result_overflow_mode to Table settings', async () => {
    const { fn, calls } = fakeRunProgress([() => {}]);
    const svc = createQueryExecutionService(makeDeps({ runProgress: fn }));
    await svc.executeRead(newResult('Table'), { sql: 'SELECT 1', rowLimit: 100 });
    expect(calls[0].request.settings).toEqual({ add_http_cors_header: 1, max_result_rows: 100, result_overflow_mode: 'break' });
  });

  it('a positive rowLimit adds the SAME cap to KPI settings', async () => {
    const { fn, calls } = fakeRunProgress([() => {}]);
    const svc = createQueryExecutionService(makeDeps({ runProgress: fn }));
    await svc.executeRead(newResult('KPI'), { sql: 'SELECT 1', format: 'KPI', rowLimit: 100 });
    expect(calls[0].request.settings).toEqual({ add_http_cors_header: 1, max_result_rows: 100, result_overflow_mode: 'break' });
  });

  it('maps TSV to TabSeparatedWithNamesAndTypes via runText, with wait_end_of_query=1 + CORS', async () => {
    const { fn, calls } = fakeRunText([() => 'abcde']);
    const svc = createQueryExecutionService(makeDeps({ runText: fn }));
    const result = newResult('TSV');
    const out = await svc.executeRead(result, { sql: 'SHOW TABLES', format: 'TSV' });
    expect(calls[0].request.defaultFormat).toBe('TabSeparatedWithNamesAndTypes');
    expect(calls[0].request.settings).toEqual({ wait_end_of_query: 1, add_http_cors_header: 1 });
    expect(out.rawText).toBe('abcde');
    expect(out.progress.bytes).toBe(5);
  });

  it('a positive rowLimit on TSV keeps the cap in the SAME settings object as wait_end_of_query/CORS', async () => {
    const { fn, calls } = fakeRunText([() => '']);
    const svc = createQueryExecutionService(makeDeps({ runText: fn }));
    await svc.executeRead(newResult('TSV'), { sql: 'SHOW TABLES', format: 'TSV', rowLimit: 250 });
    expect(calls[0].request.settings).toEqual({
      wait_end_of_query: 1, add_http_cors_header: 1, max_result_rows: 250, result_overflow_mode: 'break',
    });
  });

  // #630 Phase 7 §23 — the dedicated explicit-FORMAT regression: a
  // regression that retains the row cap ONLY in the Table/KPI branches must
  // fail this exact case.
  it('an explicit-FORMAT CSV SELECT with a positive row limit: exact caller format, wait_end_of_query, CORS, and the cap — all in settings', async () => {
    const { fn, calls } = fakeRunText([() => '']);
    const svc = createQueryExecutionService(makeDeps({ runText: fn }));
    await svc.executeRead(newResult('CSV'), { sql: 'SELECT 1 FORMAT CSV', format: 'CSV', rowLimit: 500 });
    expect(calls[0].request.defaultFormat).toBe('CSV');
    expect(calls[0].request.settings).toEqual({
      wait_end_of_query: 1,
      add_http_cors_header: 1,
      max_result_rows: 500,
      result_overflow_mode: 'break',
    });
  });

  it('an explicit/raw format with rowLimit 0 (EXPLAIN/PIPELINE/ESTIMATE) stays uncapped', async () => {
    const { fn, calls } = fakeRunText([() => '']);
    const svc = createQueryExecutionService(makeDeps({ runText: fn }));
    await svc.executeRead(newResult('Table'), { sql: 'EXPLAIN SELECT 1', format: 'Table exempted via rowLimit', rowLimit: 0 });
    expect(calls[0].request.settings).toEqual({ wait_end_of_query: 1, add_http_cors_header: 1 });
  });

  it('sets result.error from a thrown error (package consumers throw, not {error})', async () => {
    const { fn } = fakeRunText([() => { throw new Error('boom'); }]);
    const svc = createQueryExecutionService(makeDeps({ runText: fn }));
    const result = newResult('TSV');
    const out = await svc.executeRead(result, { sql: 'SELECT 1', format: 'TSV' });
    expect(out.error).toBe('boom');
  });

  it('sets rawText + progress.bytes from the resolved raw text', async () => {
    const { fn } = fakeRunText([() => 'abcde']);
    const svc = createQueryExecutionService(makeDeps({ runText: fn }));
    const result = newResult('TSV');
    const out = await svc.executeRead(result, { sql: 'SHOW TABLES', format: 'TSV' });
    expect(out.rawText).toBe('abcde');
    expect(out.progress.bytes).toBe(5);
  });

  it('passes explicit format/rowLimit/params/queryId/signal through', async () => {
    const { fn, calls } = fakeRunText([() => '']);
    const svc = createQueryExecutionService(makeDeps({ runText: fn }));
    const controller = new AbortController();
    await svc.executeRead(newResult('JSON'), {
      sql: 'SELECT 1',
      format: 'JSON',
      rowLimit: 50,
      params: { param_x: 'y' },
      queryId: 'q-explicit',
      signal: controller.signal,
    });
    expect(calls[0].request.defaultFormat).toBe('JSON');
    expect(calls[0].request.settings).toMatchObject({ max_result_rows: 50, result_overflow_mode: 'break' });
    expect(calls[0].request.params).toEqual({ query_id: 'q-explicit', param_x: 'y' });
    expect(calls[0].request.signal).toBe(controller.signal);
  });

  it('forwards an onChunk pulse with no arguments', async () => {
    const { fn, calls } = fakeRunProgress([
      (cbs) => { cbs.onChunk!(); },
    ]);
    const svc = createQueryExecutionService(makeDeps({ runProgress: fn }));
    const onChunk = vi.fn();
    await svc.executeRead(newResult('Table'), { sql: 'SELECT 1', onChunk });
    expect(onChunk).toHaveBeenCalledTimes(1);
    expect(onChunk).toHaveBeenCalledWith();
    expect(typeof calls[0].callbacks.onChunk).toBe('function');
  });

  it('passes no onChunk wrapper when the request omits one', async () => {
    const { fn, calls } = fakeRunProgress([() => {}]);
    const svc = createQueryExecutionService(makeDeps({ runProgress: fn }));
    await svc.executeRead(newResult('Table'), { sql: 'SELECT 1' });
    expect(calls[0].callbacks.onChunk).toBeUndefined();
  });

  it('does not call the transport or mutate a result when the caller epoch is already stale', async () => {
    const { fn } = fakeRunText([() => { throw new Error('must not run'); }]);
    const svc = createQueryExecutionService(makeDeps({ runText: fn }));
    const result = newResult('TSV');
    await svc.executeRead(result, { sql: 'SELECT 1', format: 'TSV', isCurrent: () => false });
    expect(fn).not.toHaveBeenCalled();
    expect(result.error).toBeNull();
  });

  it('fences late stream chunks and settlement after the caller epoch closes', async () => {
    let current = true;
    const onChunk = vi.fn();
    const { fn } = fakeRunProgress([
      (cbs) => {
        cbs.onLine!({ meta: [{ name: 'x', type: 'Int32' }] });
        cbs.onLine!({ row: { x: 1 } });
        current = false;
        cbs.onLine!({ row: { x: 2 } });
        cbs.onChunk!();
        throw new Error('late error');
      },
    ]);
    const svc = createQueryExecutionService(makeDeps({ runProgress: fn }));
    const result = newResult('Table');
    await svc.executeRead(result, { sql: 'SELECT 1', isCurrent: () => current, onChunk });
    expect(result.rows).toEqual([[1]]);
    expect(result.error).toBeNull();
    expect(onChunk).not.toHaveBeenCalled();
  });

  it('fences a successful raw/text settlement after the caller epoch closes — no rawText/bytes publication', async () => {
    let current = true;
    const { fn } = fakeRunText([() => { current = false; return 'late body'; }]);
    const svc = createQueryExecutionService(makeDeps({ runText: fn }));
    const result = newResult('TSV');
    const out = await svc.executeRead(result, { sql: 'SHOW TABLES', format: 'TSV', isCurrent: () => current });
    expect(out.rawText).toBeNull();
    expect(out.progress.bytes).toBe(0);
  });

  it('marks cancelled (not error) and keeps partial rows on AbortError', async () => {
    const { fn } = fakeRunProgress([
      (cbs) => {
        cbs.onLine!({ meta: [{ name: 'x', type: 'Int32' }] });
        cbs.onLine!({ row: { x: 1 } });
        throw abortError();
      },
    ]);
    const svc = createQueryExecutionService(makeDeps({ runProgress: fn }));
    const result = newResult('Table');
    const out = await svc.executeRead(result, { sql: 'SELECT 1' });
    expect(out.cancelled).toBe(true);
    expect(out.error).toBeNull();
    expect(out.rows).toEqual([[1]]);
  });

  it("sets error to 'Network error' on a TypeError", async () => {
    const { fn } = fakeRunProgress([() => { throw new TypeError('fetch failed'); }]);
    const svc = createQueryExecutionService(makeDeps({ runProgress: fn }));
    const out = await svc.executeRead(newResult('Table'), { sql: 'SELECT 1' });
    expect(out.error).toBe('Network error');
  });

  it('sets error to the message string on a generic Error (including a package ClickHouseError-shaped one — its `.message` is already the safe text)', async () => {
    const { fn } = fakeRunProgress([() => { const e = new Error('weird failure'); e.name = 'ClickHouseError'; throw e; }]);
    const svc = createQueryExecutionService(makeDeps({ runProgress: fn }));
    const out = await svc.executeRead(newResult('Table'), { sql: 'SELECT 1' });
    expect(out.error).toBe('weird failure');
  });

  it('sets error via String(e) on a non-Error throw', async () => {
    const { fn } = fakeRunProgress([() => { throw 'boom'; }]);
    const svc = createQueryExecutionService(makeDeps({ runProgress: fn }));
    const out = await svc.executeRead(newResult('Table'), { sql: 'SELECT 1' });
    expect(out.error).toBe('boom');
  });

  it('returns the same result reference it was given', async () => {
    const { fn } = fakeRunText([() => '']);
    const svc = createQueryExecutionService(makeDeps({ runText: fn }));
    const result = newResult('TSV');
    const out = await svc.executeRead(result, { sql: 'SELECT 1', format: 'TSV' });
    expect(out).toBe(result);
  });
});

// ── executeScript ────────────────────────────────────────────────────────────

const selectStmt = (params: Record<string, string | number> = {}): ScriptStatement => ({
  sql: 'SELECT 1', execSql: 'SELECT 1 /* exec */', params,
});
const ddlStmt = (params: Record<string, string | number> = {}): ScriptStatement => ({
  sql: 'CREATE TABLE t (x Int32) ENGINE=Memory', execSql: 'CREATE TABLE t (x Int32) ENGINE=Memory /* exec */', params,
});

describe('executeScript', () => {
  it('fences late errors and callback publication after an authenticated epoch closes', async () => {
    let current = true;
    const rejected = fakeRunProgress([() => { current = false; throw new Error('late'); }]);
    const service = createQueryExecutionService(makeDeps({ runProgress: rejected.fn }));
    await expect(service.executeRead(newResult('Table'), { sql: 'SELECT 1', isCurrent: () => current }))
      .resolves.toMatchObject({ error: null });

    // The entry is local bookkeeping, but its callback is a UI publication and
    // must be fenced independently for both error and success entries.
    for (const outcome of [() => { throw new Error('bad'); }, () => ''] as TextBehavior[]) {
      let checks = 0;
      const transport = fakeRunText([outcome]);
      const onStatementResult = vi.fn();
      const scoped = createQueryExecutionService(makeDeps({ runText: transport.fn }));
      const result = await scoped.executeScript({
        statements: [ddlStmt()],
        isCurrent: () => (++checks < 5),
        onStatementStart: vi.fn(),
        onStatementResult,
      });
      expect(result.entries).toHaveLength(1);
      expect(onStatementResult).not.toHaveBeenCalled();
    }
  });

  it('stringifies a non-Error script transport failure', async () => {
    const { fn } = fakeRunText([() => { throw 'opaque transport failure'; }]);
    const svc = createQueryExecutionService(makeDeps({ runText: fn }));
    const { entries } = await svc.executeScript({ statements: [ddlStmt()], onStatementStart: vi.fn(), onStatementResult: vi.fn() });
    expect(entries).toEqual([expect.objectContaining({ status: 'error', error: 'opaque transport failure' })]);
  });

  it('treats every lifecycle fence as a local abort, without publishing an entry or acquiring a replacement context', async () => {
    // These four placements deliberately exercise the distinct fences around a
    // script attempt: before the loop, after minting its id, after transport,
    // and after a retry.  They are separate auth-loss interleavings in the UI.
    const before = createQueryExecutionService(makeDeps({
      runText: fakeRunText([]).fn,
    }));
    await expect(before.executeScript({ statements: [ddlStmt()], isCurrent: () => false, onStatementStart: vi.fn(), onStatementResult: vi.fn() }))
      .resolves.toEqual({ entries: [], aborted: true });

    let checks = 0;
    const afterId = createQueryExecutionService(makeDeps({
      runText: fakeRunText([]).fn,
    }));
    await expect(afterId.executeScript({
      statements: [ddlStmt()],
      isCurrent: () => (++checks < 2),
      onStatementStart: vi.fn(), onStatementResult: vi.fn(),
    })).resolves.toEqual({ entries: [], aborted: true });

    let postTransport = true;
    const transport = fakeRunText([() => { postTransport = false; return ''; }]);
    const afterTransport = createQueryExecutionService(makeDeps({ runText: transport.fn }));
    await expect(afterTransport.executeScript({
      statements: [ddlStmt()], isCurrent: () => postTransport,
      onStatementStart: vi.fn(), onStatementResult: vi.fn(),
    })).resolves.toEqual({ entries: [], aborted: true });

    let retryTransportCalls = 0;
    const retryTransport = fakeRunText([
      () => { throw new Error('SESSION_IS_LOCKED'); },
      () => { retryTransportCalls += 1; return ''; },
    ]);
    let retryChecks = 0;
    const afterRetry = createQueryExecutionService(makeDeps({
      runText: retryTransport.fn,
      sleep: async () => {},
    }));
    await expect(afterRetry.executeScript({
      statements: [ddlStmt()],
      // loop / after-id / after-transport / after-sleep all pass; the fence
      // immediately after the retry transport rejects its late result.
      isCurrent: () => (++retryChecks <= 6),
      onStatementStart: vi.fn(), onStatementResult: vi.fn(),
    })).resolves.toEqual({ entries: [], aborted: true });
    expect(retryTransportCalls).toBe(1);
  });

  it('does not enter transport when the scope closes between publishing the id and the attempt', async () => {
    let checks = 0;
    const run = fakeRunText([]);
    const svc = createQueryExecutionService(makeDeps({ runText: run.fn }));
    await expect(svc.executeScript({
      statements: [ddlStmt()],
      // loop and id fence pass; attemptStatement itself observes the close.
      isCurrent: () => (++checks < 3),
      onStatementStart: vi.fn(), onStatementResult: vi.fn(),
    })).resolves.toEqual({ entries: [], aborted: true });
    expect(run.calls).toHaveLength(0);
  });

  it('runs one runText call per statement, wire text vs authored sql, in order', async () => {
    const { fn, calls } = fakeRunText([
      () => JSON.stringify({ meta: [{ name: 'x', type: 'Int32' }], data: [[1]] }),
      () => '',
    ]);
    const svc = createQueryExecutionService(makeDeps({ runText: fn }));
    const onStatementStart = vi.fn();
    const onStatementResult = vi.fn();
    const { entries, aborted } = await svc.executeScript({
      statements: [selectStmt({ session_id: 's1' }), ddlStmt({ session_id: 's1' })],
      onStatementStart,
      onStatementResult,
    });
    expect(aborted).toBe(false);
    expect(calls[0].request.sql).toBe('SELECT 1 /* exec */');
    expect(calls[1].request.sql).toBe('CREATE TABLE t (x Int32) ENGINE=Memory /* exec */');
    expect(entries[0].sql).toBe('SELECT 1');
    expect(entries[1].sql).toBe('CREATE TABLE t (x Int32) ENGINE=Memory');
  });

  it('parses a rows entry via parseSelectResult, over-fetching the cap only for row-returning statements; both settings stay the same regardless of row-returning-ness', async () => {
    const { fn, calls } = fakeRunText([
      () => JSON.stringify({ meta: [{ name: 'x', type: 'Int32' }], data: [[1], [2]] }),
      () => '',
    ]);
    const svc = createQueryExecutionService(makeDeps({ runText: fn }));
    const { entries } = await svc.executeScript({
      statements: [selectStmt({ session_id: 's1' }), ddlStmt({ session_id: 's1' })],
      onStatementStart: vi.fn(),
      onStatementResult: vi.fn(),
    });
    expect(calls[0].request.defaultFormat).toBe('JSONCompact');
    expect(calls[0].request.params).toEqual({
      query_id: calls[0].request.params!.query_id, session_id: 's1', max_result_rows: SELECT_ROW_CAP + 1, result_overflow_mode: 'break',
    });
    expect(calls[0].request.settings).toEqual({ wait_end_of_query: 1, add_http_cors_header: 1 });
    expect(calls[1].request.defaultFormat).toBe('TabSeparatedWithNamesAndTypes');
    expect(calls[1].request.params).toEqual({ query_id: calls[1].request.params!.query_id, session_id: 's1' });
    expect(calls[1].request.settings).toEqual({ wait_end_of_query: 1, add_http_cors_header: 1 });
    const rowsEntry = entries[0];
    expect(rowsEntry.status).toBe('rows');
    if (rowsEntry.status === 'rows') {
      expect(rowsEntry.columns).toEqual([{ name: 'x', type: 'Int32' }]);
      expect(rowsEntry.rows).toEqual([[1], [2]]);
      expect(rowsEntry.truncated).toBe(false);
      expect(rowsEntry.preview).toBe('1');
    }
    expect(entries[1].status).toBe('ok');
  });

  // #630 Phase 7 §2.3/§8/§23 — script over-fetch cap placement/precedence:
  // a caller-supplied `max_result_rows`/`result_overflow_mode` in
  // `stmt.params` must be OVERRIDDEN by the service's own cap, the cap must
  // live in `params` (never `settings`), and it must never be duplicated
  // into `settings` either.
  it('script cap wins a params collision and never appears in settings (row-returning statement)', async () => {
    const { fn, calls } = fakeRunText([() => JSON.stringify({ meta: [], data: [] })]);
    const svc = createQueryExecutionService(makeDeps({ runText: fn }));
    await svc.executeScript({
      statements: [selectStmt({ max_result_rows: 5, result_overflow_mode: 'throw' })],
      onStatementStart: vi.fn(),
      onStatementResult: vi.fn(),
    });
    expect(calls[0].request.params!.max_result_rows).toBe(SELECT_ROW_CAP + 1);
    expect(calls[0].request.params!.result_overflow_mode).toBe('break');
    expect(calls[0].request.settings).not.toHaveProperty('max_result_rows');
    expect(calls[0].request.settings).not.toHaveProperty('result_overflow_mode');
  });

  it('a non-row-returning statement never receives the script cap in params or settings, even with conflicting caller params', async () => {
    const { fn, calls } = fakeRunText([() => '']);
    const svc = createQueryExecutionService(makeDeps({ runText: fn }));
    await svc.executeScript({
      statements: [ddlStmt({ max_result_rows: 5, result_overflow_mode: 'throw' })],
      onStatementStart: vi.fn(),
      onStatementResult: vi.fn(),
    });
    expect(calls[0].request.params).toEqual({ query_id: calls[0].request.params!.query_id, max_result_rows: 5, result_overflow_mode: 'throw' });
    expect(calls[0].request.settings).not.toHaveProperty('max_result_rows');
  });

  it('publishes a fresh query_id per attempt, synchronously before each await, on the retry path', async () => {
    const order: string[] = [];
    const { fn } = fakeRunText([
      () => { throw new Error('SESSION_IS_LOCKED: locked'); },
      () => '',
    ]);
    const svc = createQueryExecutionService(makeDeps({ runText: fn }));
    const onStatementStart = vi.fn((_i: number, info: { queryId: string; attempt: 1 | 2 }) => {
      order.push('start:' + info.attempt + ':' + info.queryId);
    });
    await svc.executeScript({
      statements: [ddlStmt()],
      onStatementStart,
      onStatementResult: vi.fn(),
    });
    expect(onStatementStart).toHaveBeenCalledTimes(2);
    const first = onStatementStart.mock.calls[0][1];
    const second = onStatementStart.mock.calls[1][1];
    expect(first.attempt).toBe(1);
    expect(second.attempt).toBe(2);
    expect(first.queryId).not.toBe(second.queryId);
  });

  it('retries a SESSION_IS_LOCKED failure for ANY statement (including non-row-returning)', async () => {
    const { fn, calls } = fakeRunText([
      () => { throw new Error('Code: 373. DB::Exception: SESSION_IS_LOCKED'); },
      () => '',
    ]);
    const deps = makeDeps({ runText: fn });
    const svc = createQueryExecutionService(deps);
    const { entries } = await svc.executeScript({
      statements: [ddlStmt()],
      onStatementStart: vi.fn(),
      onStatementResult: vi.fn(),
    });
    expect(calls).toHaveLength(2);
    expect(deps.sleep).toHaveBeenCalledWith(7);
    expect(entries[0].status).toBe('ok');
  });

  it('does not let a delayed retry acquire a replacement auth context', async () => {
    let current = true;
    const { fn, calls } = fakeRunText([
      () => { throw new Error('SESSION_IS_LOCKED: locked'); },
      () => '',
    ]);
    const sleep = vi.fn(async () => { current = false; });
    const onStatementStart = vi.fn();
    const svc = createQueryExecutionService(makeDeps({ runText: fn, sleep }));
    const result = await svc.executeScript({
      statements: [ddlStmt()],
      isCurrent: () => current,
      onStatementStart,
      onStatementResult: vi.fn(),
    });
    expect(result).toEqual({ entries: [], aborted: true });
    expect(calls).toHaveLength(1);
    expect(onStatementStart).toHaveBeenCalledTimes(1);
  });

  it('retries a transient (TypeError) failure only for a row-returning statement', async () => {
    const { fn, calls } = fakeRunText([
      () => { throw new TypeError('reset'); },
      () => JSON.stringify({ meta: [], data: [] }),
    ]);
    const svc = createQueryExecutionService(makeDeps({ runText: fn }));
    const { entries } = await svc.executeScript({
      statements: [selectStmt()],
      onStatementStart: vi.fn(),
      onStatementResult: vi.fn(),
    });
    expect(calls).toHaveLength(2);
    expect(entries[0].status).toBe('rows');
  });

  it('does NOT retry a transient failure for a non-row-returning statement, and reports the exact message', async () => {
    const { fn, calls } = fakeRunText([
      () => { throw new TypeError('reset'); },
    ]);
    const svc = createQueryExecutionService(makeDeps({ runText: fn }));
    const { entries } = await svc.executeScript({
      statements: [ddlStmt()],
      onStatementStart: vi.fn(),
      onStatementResult: vi.fn(),
    });
    expect(calls).toHaveLength(1);
    expect(entries[0].status).toBe('error');
    if (entries[0].status === 'error') {
      expect(entries[0].error).toBe('Network error — the statement may have executed; re-run it manually if needed.');
    }
  });

  it('classifies a thrown non-TypeError Error as a non-transient error (no retry)', async () => {
    const { fn, calls } = fakeRunText([
      () => { throw new Error('kaboom'); },
    ]);
    const svc = createQueryExecutionService(makeDeps({ runText: fn }));
    const { entries } = await svc.executeScript({
      statements: [selectStmt()],
      onStatementStart: vi.fn(),
      onStatementResult: vi.fn(),
    });
    expect(calls).toHaveLength(1);
    expect(entries[0].status).toBe('error');
    if (entries[0].status === 'error') expect(entries[0].error).toBe('kaboom');
  });

  it('does not retry a genuine (non-transient, non-locked) query error', async () => {
    const { fn, calls } = fakeRunText([
      () => { throw new Error('Code: 62. DB::Exception: Syntax error'); },
    ]);
    const svc = createQueryExecutionService(makeDeps({ runText: fn }));
    const { entries } = await svc.executeScript({
      statements: [selectStmt()],
      onStatementStart: vi.fn(),
      onStatementResult: vi.fn(),
    });
    expect(calls).toHaveLength(1);
    expect(entries[0].status).toBe('error');
    if (entries[0].status === 'error') expect(entries[0].error).toBe('Code: 62. DB::Exception: Syntax error');
  });

  it('stops on the first failure — later statements are never sent', async () => {
    const { fn, calls } = fakeRunText([
      () => { throw new Error('Code: 62. DB::Exception: Syntax error'); },
    ]);
    const svc = createQueryExecutionService(makeDeps({ runText: fn }));
    const { entries } = await svc.executeScript({
      statements: [ddlStmt(), selectStmt()],
      onStatementStart: vi.fn(),
      onStatementResult: vi.fn(),
    });
    expect(calls).toHaveLength(1);
    expect(entries).toHaveLength(1);
    expect(entries[0].status).toBe('error');
  });

  it('aborts mid-script: {aborted:true}, no entry for the aborted statement, earlier entries kept', async () => {
    const { fn, calls } = fakeRunText([
      () => '',
      () => { throw abortError(); },
    ]);
    const svc = createQueryExecutionService(makeDeps({ runText: fn }));
    const { entries, aborted } = await svc.executeScript({
      statements: [ddlStmt(), selectStmt()],
      onStatementStart: vi.fn(),
      onStatementResult: vi.fn(),
    });
    expect(calls).toHaveLength(2);
    expect(aborted).toBe(true);
    expect(entries).toHaveLength(1);
    expect(entries[0].status).toBe('ok');
  });

  it('computes ms from the injected clock', async () => {
    const { fn } = fakeRunText([() => '']);
    const svc = createQueryExecutionService(makeDeps({ runText: fn }));
    const { entries } = await svc.executeScript({
      statements: [ddlStmt()],
      onStatementStart: vi.fn(),
      onStatementResult: vi.fn(),
    });
    expect(entries[0].ms).toBe(10);
  });

  it('fires onStatementResult once per pushed entry, with the correct index', async () => {
    const { fn } = fakeRunText([
      () => '',
      () => JSON.stringify({ meta: [], data: [] }),
    ]);
    const svc = createQueryExecutionService(makeDeps({ runText: fn }));
    const seen: { index: number; entry: ScriptEntry }[] = [];
    await svc.executeScript({
      statements: [ddlStmt(), selectStmt()],
      onStatementStart: vi.fn(),
      onStatementResult: (index, entry) => seen.push({ index, entry }),
    });
    expect(seen).toHaveLength(2);
    expect(seen[0].index).toBe(0);
    expect(seen[1].index).toBe(1);
    expect(seen[0].entry.status).toBe('ok');
    expect(seen[1].entry.status).toBe('rows');
  });
});

// ── kill ─────────────────────────────────────────────────────────────────────

describe('kill', () => {
  it('delegates to deps.cancel with the owner epoch and the queryId', async () => {
    const cancelled = fakeCancel();
    const deps = makeDeps({ cancel: cancelled.fn });
    const svc = createQueryExecutionService(deps);
    await svc.kill(3, 'q-123');
    expect(cancelled.calls).toHaveLength(1);
    expect(cancelled.calls[0].ownerEpoch).toBe(3);
    expect(cancelled.calls[0].queryId).toBe('q-123');
  });

  it('passes a null/undefined owner epoch or query id straight through — the fence lives in deps.cancel', async () => {
    const cancelled = fakeCancel();
    const deps = makeDeps({ cancel: cancelled.fn });
    const svc = createQueryExecutionService(deps);
    await svc.kill(null, null);
    expect(cancelled.calls[0]).toEqual({ ownerEpoch: null, queryId: null });
  });
});
