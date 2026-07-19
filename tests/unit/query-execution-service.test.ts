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
import { sqlString } from '../../src/core/format.js';

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

  it('sets result.image + progress.bytes from a valid out.binary PNG (#307)', async () => {
    // Minimal well-formed PNG: signature + IHDR (length 13, type IHDR, 10x20).
    const bytes = new Uint8Array(29);
    bytes.set([137, 80, 78, 71, 13, 10, 26, 10], 0);
    const view = new DataView(bytes.buffer);
    view.setUint32(8, 13, false);
    bytes.set([73, 72, 68, 82], 12); // 'IHDR'
    view.setUint32(16, 10, false);
    view.setUint32(20, 20, false);
    const { fn } = fakeRunQuery([() => ({ binary: { bytes, contentType: 'image/png' } })]);
    const svc = createQueryExecutionService(makeDeps({ runQuery: fn }));
    const out = await svc.executeRead(newResult('PNG'), { sql: 'SELECT plot(1) FORMAT PNG', format: 'PNG' });
    expect(out.image).toEqual({
      kind: 'image', format: 'PNG', mimeType: 'image/png', bytes, width: 10, height: 20,
    });
    expect(out.progress.bytes).toBe(29);
    expect(out.rawText).toBeNull();
    expect(out.error).toBeNull();
  });

  it('sets result.error (and drops the bytes) when out.binary fails PNG validation', async () => {
    const badBytes = new Uint8Array([1, 2, 3]); // too short, bad signature
    const { fn } = fakeRunQuery([() => ({ binary: { bytes: badBytes, contentType: 'image/png' } })]);
    const svc = createQueryExecutionService(makeDeps({ runQuery: fn }));
    const out = await svc.executeRead(newResult('PNG'), { sql: 'x', format: 'PNG' });
    expect(out.image).toBeNull();
    expect(out.error).toMatch(/^Invalid PNG result: /);
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
