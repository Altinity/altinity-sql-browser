import { describe, it, expect, vi } from 'vitest';
import {
  createQueryExecutionService,
} from '../../src/application/query-execution-service.js';
import type {
  QueryExecutionDeps, ScriptStatement,
} from '../../src/application/query-execution-service.js';
import type { ChCtx, RunQueryOptions, RunQueryResult, runQuery, killQuery } from '../../src/net/ch-client.js';
import { newResult } from '../../src/core/stream.js';
import { SELECT_ROW_CAP } from '../../src/core/script-result.js';
import type { ScriptEntry } from '../../src/core/script-result.js';
// Issue #630 Phase 5 — sqlString now has one implementation, owned by the
// package; format.js no longer declares it.
import { sqlString } from '@altinity/clickhouse-http';

// ── Fakes ────────────────────────────────────────────────────────────────────

/** One recorded `runQuery` call. */
interface RunQueryCall { ctx: ChCtx; sql: string; opts: RunQueryOptions }

/** A scripted behavior for one queued `runQuery` call: resolves/rejects, and
 * may pulse `opts.onLine`/`opts.onChunk` first (simulating a stream) — the
 * same shape the real `net/ch-client.js::runQuery` drives its callers with. */
type Behavior = (opts: RunQueryOptions) => RunQueryResult | Promise<RunQueryResult>;

function abortError(): Error {
  const e = new Error('aborted');
  e.name = 'AbortError';
  return e;
}

/** A queued fake matching `typeof runQuery` exactly: each call consumes the
 * next queued behavior (throwing if the queue runs dry, so an unscripted call
 * fails loudly rather than hanging). Records every call for assertions. */
function fakeRunQuery(behaviors: Behavior[]): { fn: typeof runQuery; calls: RunQueryCall[] } {
  const calls: RunQueryCall[] = [];
  let i = 0;
  const fn = vi.fn(async (ctx: ChCtx, sql: string, opts: RunQueryOptions = {}): Promise<RunQueryResult> => {
    calls.push({ ctx, sql, opts });
    const behavior = behaviors[i];
    i += 1;
    if (!behavior) throw new Error('unscripted runQuery call: ' + sql);
    return behavior(opts);
  });
  return { fn, calls };
}

function fakeKillQuery(): { fn: typeof killQuery; calls: { ctx: ChCtx; queryId: string | null | undefined; sqlString: (s: unknown) => string }[] } {
  const calls: { ctx: ChCtx; queryId: string | null | undefined; sqlString: (s: unknown) => string }[] = [];
  const fn = vi.fn(async (ctx: ChCtx, queryId: string | null | undefined, sqlStringFn: (s: unknown) => string): Promise<void> => {
    calls.push({ ctx, queryId, sqlString: sqlStringFn });
  });
  return { fn, calls };
}

const fakeCtx: ChCtx = {
  fetch: (() => Promise.reject(new Error('not used'))) as unknown as typeof fetch,
  origin: 'https://ch.local',
  getToken: async () => 'tok',
  refresh: async () => false,
  onSignedOut: () => {},
};

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
    runQuery: fakeRunQuery([]).fn,
    killQuery: fakeKillQuery().fn,
    ctx: () => fakeCtx,
    now: makeNow(),
    uid: makeUid(),
    retryMs: 7,
    sleep: vi.fn(async () => {}),
    sqlString,
    ...over,
  };
}

// ── executeRead ──────────────────────────────────────────────────────────────

describe('executeRead', () => {
  it('folds streamed lines into the result via applyStreamLine', async () => {
    const { fn, calls } = fakeRunQuery([
      (opts) => {
        opts.onLine!({ meta: [{ name: 'x', type: 'Int32' }] });
        opts.onLine!({ row: { x: 1 } });
        return { streamed: true };
      },
    ]);
    const svc = createQueryExecutionService(makeDeps({ runQuery: fn }));
    const result = newResult('Table');
    const out = await svc.executeRead(result, { sql: 'SELECT 1' });
    expect(out.columns).toEqual([{ name: 'x', type: 'Int32' }]);
    expect(out.rows).toEqual([[1]]);
    expect(calls[0].sql).toBe('SELECT 1');
  });

  // Issue #630 Phase 3 §11.8 — proves the package callback-order contract
  // (every onLine for a chunk, THEN that chunk's onChunk) still produces the
  // same visible row/progress state before the caller's own repaint hook
  // fires — the real-time UI/result compatibility invariant this move must
  // not disturb. `fakeRunQuery`'s behavior pulses onLine/onChunk synchronously
  // in exactly the order the real production `runQuery` (via the package's
  // `streamLines`) drives them.
  it('reflects every line mutation from a chunk in the caller-owned result BEFORE that chunk\'s onChunk repaint fires', async () => {
    const result = newResult('Table');
    const onChunk = vi.fn(() => {
      // At the moment onChunk fires, the result must already carry both the
      // meta and the row line dispatched earlier in this same chunk.
      expect(result.columns).toEqual([{ name: 'x', type: 'Int32' }]);
      expect(result.rows).toEqual([[1]]);
    });
    const { fn } = fakeRunQuery([
      (opts) => {
        opts.onLine!({ meta: [{ name: 'x', type: 'Int32' }] });
        opts.onLine!({ row: { x: 1 } });
        opts.onChunk!();
        return { streamed: true };
      },
    ]);
    const svc = createQueryExecutionService(makeDeps({ runQuery: fn }));
    await svc.executeRead(result, { sql: 'SELECT 1', onChunk });
    expect(onChunk).toHaveBeenCalledTimes(1);
  });

  it('sets result.error from out.error', async () => {
    const { fn } = fakeRunQuery([() => ({ error: 'boom' })]);
    const svc = createQueryExecutionService(makeDeps({ runQuery: fn }));
    const result = newResult('Table');
    const out = await svc.executeRead(result, { sql: 'SELECT 1' });
    expect(out.error).toBe('boom');
  });

  it('sets rawText + progress.bytes from out.raw', async () => {
    const { fn } = fakeRunQuery([() => ({ raw: 'abcde' })]);
    const svc = createQueryExecutionService(makeDeps({ runQuery: fn }));
    const result = newResult('TSV');
    const out = await svc.executeRead(result, { sql: 'SHOW TABLES' });
    expect(out.rawText).toBe('abcde');
    expect(out.progress.bytes).toBe(5);
  });

  it('defaults format to Table and rowLimit to 0 in the runQuery opts', async () => {
    const { fn, calls } = fakeRunQuery([() => ({ raw: '' })]);
    const svc = createQueryExecutionService(makeDeps({ runQuery: fn }));
    await svc.executeRead(newResult('Table'), { sql: 'SELECT 1' });
    expect(calls[0].opts.format).toBe('Table');
    expect(calls[0].opts.resultRowLimit).toBe(0);
  });

  it('passes explicit format/rowLimit/params/queryId/signal through', async () => {
    const { fn, calls } = fakeRunQuery([() => ({ raw: '' })]);
    const svc = createQueryExecutionService(makeDeps({ runQuery: fn }));
    const controller = new AbortController();
    await svc.executeRead(newResult('JSON'), {
      sql: 'SELECT 1',
      format: 'JSON',
      rowLimit: 50,
      params: { param_x: 'y' },
      queryId: 'q-explicit',
      signal: controller.signal,
    });
    expect(calls[0].opts.format).toBe('JSON');
    expect(calls[0].opts.resultRowLimit).toBe(50);
    expect(calls[0].opts.params).toEqual({ param_x: 'y' });
    expect(calls[0].opts.queryId).toBe('q-explicit');
    expect(calls[0].opts.signal).toBe(controller.signal);
  });

  it('forwards an onChunk pulse with no arguments', async () => {
    const { fn, calls } = fakeRunQuery([
      (opts) => { opts.onChunk!(); return { raw: '' }; },
    ]);
    const svc = createQueryExecutionService(makeDeps({ runQuery: fn }));
    const onChunk = vi.fn();
    await svc.executeRead(newResult('TSV'), { sql: 'SELECT 1', onChunk });
    expect(onChunk).toHaveBeenCalledTimes(1);
    expect(onChunk).toHaveBeenCalledWith();
    expect(typeof calls[0].opts.onChunk).toBe('function');
  });

  it('passes no onChunk wrapper when the request omits one', async () => {
    const { fn, calls } = fakeRunQuery([() => ({ raw: '' })]);
    const svc = createQueryExecutionService(makeDeps({ runQuery: fn }));
    await svc.executeRead(newResult('TSV'), { sql: 'SELECT 1' });
    expect(calls[0].opts.onChunk).toBeUndefined();
  });

  it('does not acquire auth or mutate a result when the caller epoch is already stale', async () => {
    const { fn } = fakeRunQuery([() => ({ error: 'must not run' })]);
    const ctx = vi.fn(() => fakeCtx);
    const svc = createQueryExecutionService(makeDeps({ runQuery: fn, ctx }));
    const result = newResult('Table');
    await svc.executeRead(result, { sql: 'SELECT 1', isCurrent: () => false });
    expect(ctx).not.toHaveBeenCalled();
    expect(fn).not.toHaveBeenCalled();
    expect(result.error).toBeNull();
  });

  it('fences late stream chunks and settlement after the caller epoch closes', async () => {
    let current = true;
    const onChunk = vi.fn();
    const { fn } = fakeRunQuery([
      (opts) => {
        opts.onLine!({ meta: [{ name: 'x', type: 'Int32' }] });
        opts.onLine!({ row: { x: 1 } });
        current = false;
        opts.onLine!({ row: { x: 2 } });
        opts.onChunk!();
        return { error: 'late error' };
      },
    ]);
    const svc = createQueryExecutionService(makeDeps({ runQuery: fn }));
    const result = newResult('Table');
    await svc.executeRead(result, { sql: 'SELECT 1', isCurrent: () => current, onChunk });
    expect(result.rows).toEqual([[1]]);
    expect(result.error).toBeNull();
    expect(onChunk).not.toHaveBeenCalled();
  });

  it('marks cancelled (not error) and keeps partial rows on AbortError', async () => {
    const { fn } = fakeRunQuery([
      (opts) => {
        opts.onLine!({ meta: [{ name: 'x', type: 'Int32' }] });
        opts.onLine!({ row: { x: 1 } });
        throw abortError();
      },
    ]);
    const svc = createQueryExecutionService(makeDeps({ runQuery: fn }));
    const result = newResult('Table');
    const out = await svc.executeRead(result, { sql: 'SELECT 1' });
    expect(out.cancelled).toBe(true);
    expect(out.error).toBeNull();
    expect(out.rows).toEqual([[1]]);
  });

  it("sets error to 'Network error' on a TypeError", async () => {
    const { fn } = fakeRunQuery([() => { throw new TypeError('fetch failed'); }]);
    const svc = createQueryExecutionService(makeDeps({ runQuery: fn }));
    const out = await svc.executeRead(newResult('Table'), { sql: 'SELECT 1' });
    expect(out.error).toBe('Network error');
  });

  it('sets error to the message string on a generic Error', async () => {
    const { fn } = fakeRunQuery([() => { throw new Error('weird failure'); }]);
    const svc = createQueryExecutionService(makeDeps({ runQuery: fn }));
    const out = await svc.executeRead(newResult('Table'), { sql: 'SELECT 1' });
    expect(out.error).toBe('weird failure');
  });

  it('sets error via String(e) on a non-Error throw', async () => {
    const { fn } = fakeRunQuery([() => { throw 'boom'; }]);
    const svc = createQueryExecutionService(makeDeps({ runQuery: fn }));
    const out = await svc.executeRead(newResult('Table'), { sql: 'SELECT 1' });
    expect(out.error).toBe('boom');
  });

  it('returns the same result reference it was given', async () => {
    const { fn } = fakeRunQuery([() => ({ raw: '' })]);
    const svc = createQueryExecutionService(makeDeps({ runQuery: fn }));
    const result = newResult('TSV');
    const out = await svc.executeRead(result, { sql: 'SELECT 1' });
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
    const rejected = fakeRunQuery([() => { current = false; throw new Error('late'); }]);
    const service = createQueryExecutionService(makeDeps({ runQuery: rejected.fn }));
    await expect(service.executeRead(newResult('Table'), { sql: 'SELECT 1', isCurrent: () => current }))
      .resolves.toMatchObject({ error: null });

    // The entry is local bookkeeping, but its callback is a UI publication and
    // must be fenced independently for both error and success entries.
    for (const outcome of [{ error: 'bad' } as RunQueryResult, { raw: '' } as RunQueryResult]) {
      let checks = 0;
      const transport = fakeRunQuery([() => outcome]);
      const onStatementResult = vi.fn();
      const scoped = createQueryExecutionService(makeDeps({ runQuery: transport.fn }));
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
    const { fn } = fakeRunQuery([() => { throw 'opaque transport failure'; }]);
    const svc = createQueryExecutionService(makeDeps({ runQuery: fn }));
    const { entries } = await svc.executeScript({ statements: [ddlStmt()], onStatementStart: vi.fn(), onStatementResult: vi.fn() });
    expect(entries).toEqual([expect.objectContaining({ status: 'error', error: 'opaque transport failure' })]);
  });

  it('treats every lifecycle fence as a local abort, without publishing an entry or acquiring a replacement context', async () => {
    // These four placements deliberately exercise the distinct fences around a
    // script attempt: before the loop, after minting its id, after transport,
    // and after a retry.  They are separate auth-loss interleavings in the UI.
    const before = createQueryExecutionService(makeDeps({
      runQuery: fakeRunQuery([]).fn,
    }));
    await expect(before.executeScript({ statements: [ddlStmt()], isCurrent: () => false, onStatementStart: vi.fn(), onStatementResult: vi.fn() }))
      .resolves.toEqual({ entries: [], aborted: true });

    let checks = 0;
    const afterId = createQueryExecutionService(makeDeps({
      runQuery: fakeRunQuery([]).fn,
    }));
    await expect(afterId.executeScript({
      statements: [ddlStmt()],
      isCurrent: () => (++checks < 2),
      onStatementStart: vi.fn(), onStatementResult: vi.fn(),
    })).resolves.toEqual({ entries: [], aborted: true });

    let postTransport = true;
    const transport = fakeRunQuery([() => { postTransport = false; return { raw: '' }; }]);
    const afterTransport = createQueryExecutionService(makeDeps({ runQuery: transport.fn }));
    await expect(afterTransport.executeScript({
      statements: [ddlStmt()], isCurrent: () => postTransport,
      onStatementStart: vi.fn(), onStatementResult: vi.fn(),
    })).resolves.toEqual({ entries: [], aborted: true });

    let retryTransportCalls = 0;
    const retryTransport = fakeRunQuery([
      () => ({ error: 'SESSION_IS_LOCKED' }),
      () => { retryTransportCalls += 1; return { raw: '' }; },
    ]);
    let retryChecks = 0;
    const afterRetry = createQueryExecutionService(makeDeps({
      runQuery: retryTransport.fn,
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
    const run = fakeRunQuery([]);
    const svc = createQueryExecutionService(makeDeps({ runQuery: run.fn }));
    await expect(svc.executeScript({
      statements: [ddlStmt()],
      // loop and id fence pass; attemptStatement itself observes the close.
      isCurrent: () => (++checks < 3),
      onStatementStart: vi.fn(), onStatementResult: vi.fn(),
    })).resolves.toEqual({ entries: [], aborted: true });
    expect(run.calls).toHaveLength(0);
  });

  it('runs one runQuery per statement, wire text vs authored sql, in order', async () => {
    const { fn, calls } = fakeRunQuery([
      () => ({ raw: JSON.stringify({ meta: [{ name: 'x', type: 'Int32' }], data: [[1]] }) }),
      () => ({ raw: '' }),
    ]);
    const svc = createQueryExecutionService(makeDeps({ runQuery: fn }));
    const onStatementStart = vi.fn();
    const onStatementResult = vi.fn();
    const { entries, aborted } = await svc.executeScript({
      statements: [selectStmt({ session_id: 's1' }), ddlStmt({ session_id: 's1' })],
      onStatementStart,
      onStatementResult,
    });
    expect(aborted).toBe(false);
    expect(calls[0].sql).toBe('SELECT 1 /* exec */');
    expect(calls[1].sql).toBe('CREATE TABLE t (x Int32) ENGINE=Memory /* exec */');
    expect(entries[0].sql).toBe('SELECT 1');
    expect(entries[1].sql).toBe('CREATE TABLE t (x Int32) ENGINE=Memory');
  });

  it('parses a rows entry via parseSelectResult, over-fetching the cap only for row-returning statements', async () => {
    const { fn, calls } = fakeRunQuery([
      () => ({ raw: JSON.stringify({ meta: [{ name: 'x', type: 'Int32' }], data: [[1], [2]] }) }),
      () => ({ raw: '' }),
    ]);
    const svc = createQueryExecutionService(makeDeps({ runQuery: fn }));
    const { entries } = await svc.executeScript({
      statements: [selectStmt({ session_id: 's1' }), ddlStmt({ session_id: 's1' })],
      onStatementStart: vi.fn(),
      onStatementResult: vi.fn(),
    });
    expect(calls[0].opts.format).toBe('JSONCompact');
    expect(calls[0].opts.params).toEqual({
      session_id: 's1', max_result_rows: SELECT_ROW_CAP + 1, result_overflow_mode: 'break',
    });
    expect(calls[1].opts.format).toBe('TSV');
    expect(calls[1].opts.params).toEqual({ session_id: 's1' });
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

  it('publishes a fresh query_id per attempt, synchronously before each await, on the retry path', async () => {
    const order: string[] = [];
    const { fn } = fakeRunQuery([
      (opts) => { order.push('run:' + opts.queryId); return { error: 'SESSION_IS_LOCKED: locked' }; },
      (opts) => { order.push('run:' + opts.queryId); return { raw: '' }; },
    ]);
    const onStatementStart = vi.fn((_i: number, info: { queryId: string; attempt: 1 | 2 }) => {
      order.push('start:' + info.attempt + ':' + info.queryId);
    });
    const svc = createQueryExecutionService(makeDeps({ runQuery: fn }));
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
    expect(order).toEqual([
      'start:1:' + first.queryId,
      'run:' + first.queryId,
      'start:2:' + second.queryId,
      'run:' + second.queryId,
    ]);
  });

  it('retries a SESSION_IS_LOCKED failure for ANY statement (including non-row-returning)', async () => {
    const { fn, calls } = fakeRunQuery([
      () => ({ error: 'Code: 373. DB::Exception: SESSION_IS_LOCKED' }),
      () => ({ raw: '' }),
    ]);
    const deps = makeDeps({ runQuery: fn });
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
    const { fn, calls } = fakeRunQuery([
      () => ({ error: 'SESSION_IS_LOCKED: locked' }),
      () => ({ raw: '' }),
    ]);
    const ctx = vi.fn(() => fakeCtx);
    const sleep = vi.fn(async () => { current = false; });
    const onStatementStart = vi.fn();
    const svc = createQueryExecutionService(makeDeps({ runQuery: fn, ctx, sleep }));
    const result = await svc.executeScript({
      statements: [ddlStmt()],
      isCurrent: () => current,
      onStatementStart,
      onStatementResult: vi.fn(),
    });
    expect(result).toEqual({ entries: [], aborted: true });
    expect(calls).toHaveLength(1);
    expect(ctx).toHaveBeenCalledTimes(1);
    expect(onStatementStart).toHaveBeenCalledTimes(1);
  });

  it('retries a transient (TypeError) failure only for a row-returning statement', async () => {
    const { fn, calls } = fakeRunQuery([
      () => { throw new TypeError('reset'); },
      () => ({ raw: JSON.stringify({ meta: [], data: [] }) }),
    ]);
    const svc = createQueryExecutionService(makeDeps({ runQuery: fn }));
    const { entries } = await svc.executeScript({
      statements: [selectStmt()],
      onStatementStart: vi.fn(),
      onStatementResult: vi.fn(),
    });
    expect(calls).toHaveLength(2);
    expect(entries[0].status).toBe('rows');
  });

  it('does NOT retry a transient failure for a non-row-returning statement, and reports the exact message', async () => {
    const { fn, calls } = fakeRunQuery([
      () => { throw new TypeError('reset'); },
    ]);
    const svc = createQueryExecutionService(makeDeps({ runQuery: fn }));
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
    const { fn, calls } = fakeRunQuery([
      () => { throw new Error('kaboom'); },
    ]);
    const svc = createQueryExecutionService(makeDeps({ runQuery: fn }));
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
    const { fn, calls } = fakeRunQuery([
      () => ({ error: 'Code: 62. DB::Exception: Syntax error' }),
    ]);
    const svc = createQueryExecutionService(makeDeps({ runQuery: fn }));
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
    const { fn, calls } = fakeRunQuery([
      () => ({ error: 'Code: 62. DB::Exception: Syntax error' }),
    ]);
    const svc = createQueryExecutionService(makeDeps({ runQuery: fn }));
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
    const { fn, calls } = fakeRunQuery([
      () => ({ raw: '' }),
      () => { throw abortError(); },
    ]);
    const svc = createQueryExecutionService(makeDeps({ runQuery: fn }));
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
    const { fn } = fakeRunQuery([() => ({ raw: '' })]);
    const svc = createQueryExecutionService(makeDeps({ runQuery: fn }));
    const { entries } = await svc.executeScript({
      statements: [ddlStmt()],
      onStatementStart: vi.fn(),
      onStatementResult: vi.fn(),
    });
    expect(entries[0].ms).toBe(10);
  });

  it('fires onStatementResult once per pushed entry, with the correct index', async () => {
    const { fn } = fakeRunQuery([
      () => ({ raw: '' }),
      () => ({ raw: JSON.stringify({ meta: [], data: [] }) }),
    ]);
    const svc = createQueryExecutionService(makeDeps({ runQuery: fn }));
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
  it('delegates to deps.killQuery with ctx(), the queryId, and sqlString', async () => {
    const killed = fakeKillQuery();
    const deps = makeDeps({ killQuery: killed.fn });
    const svc = createQueryExecutionService(deps);
    await svc.kill('q-123');
    expect(killed.calls).toHaveLength(1);
    expect(killed.calls[0].ctx).toBe(fakeCtx);
    expect(killed.calls[0].queryId).toBe('q-123');
    expect(killed.calls[0].sqlString).toBe(sqlString);
  });
});
