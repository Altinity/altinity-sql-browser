// Phase 0 / issue #585, plan §23 "Sessions and retry safety" — temporary
// tables, session `SET` persistence, and a REAL `SESSION_IS_LOCKED`
// classification/retry against a real ClickHouse server. Requires
// `ASB_SPIKE_CH_URL` (set externally by `clickhouse-containers.mjs`/a future
// `run-matrix.mjs`); skips cleanly when unset — see `live-precision.test.ts`'s
// header for why this env-gate is mandatory, not optional.

import { describe, it, expect } from 'vitest';
import { ClickHouseError } from '@clickhouse/client-web';
import { runCurrent } from './current-adapter.js';
import { createOfficialConnection, runOfficial, officialAuthFor, type OfficialConnection } from './official-adapter.js';
import { bridgeNdjsonProgress } from './progress-bridge.js';
import { createQueryExecutionService } from '../../../src/application/query-execution-service.js';
import { BASIC_USER_A } from './auth-fixtures.js';
import type { ChCtx, RunQueryOptions, RunQueryResult } from '../../../src/net/ch-client.js';
import type { SpikeCredential, SpikeRequest } from './types.js';

// See live-precision.test.ts's header comment for why this reads `process`
// through an untyped `globalThis` cast rather than an ambient `.d.ts`.
function envVar(name: string): string | undefined {
  return (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[name];
}

const CH_URL = envVar('ASB_SPIKE_CH_URL');

function baseReq(overrides: Partial<SpikeRequest> = {}): SpikeRequest {
  return {
    sql: 'SELECT 1',
    format: 'Table',
    credential: BASIC_USER_A,
    origin: 'same-origin',
    consume: 'rows',
    ...overrides,
  };
}

/**
 * A SESSION-AWARE variant of `official-adapter.ts`'s own
 * `makeOfficialRunQueryShim` — that exported shim has no `session_id`
 * parameter at all (every deterministic scenario that needs one drives
 * `runOfficial` directly instead — see its own docstring), so a session-
 * carrying shim for the LIVE `SESSION_IS_LOCKED` proof below is written
 * locally rather than expanding `official-adapter.ts`'s public surface
 * outside this sub-task's declared file scope. Mirrors that function's own
 * throw/return contract EXACTLY (a ClickHouseError response classifies as
 * `{ error }`; any other rejection propagates as a throw, matching real
 * `runQuery`'s contract) so `QueryExecutionService`'s real, unmodified
 * `attemptStatement`/`SESSION_BUSY` retry logic runs unmodified against it —
 * never a reimplementation of that policy, only of the session_id plumbing
 * `makeOfficialRunQueryShim` doesn't carry.
 */
function makeSessionAwareRunQueryShim(conn: OfficialConnection, credential: SpikeCredential, sessionId: string) {
  return async function sessionAwareShim(_ctx: ChCtx, sql: string, o: RunQueryOptions = {}): Promise<RunQueryResult> {
    const auth = officialAuthFor(credential);
    const fullSql = `${sql}\nFORMAT JSONStringsEachRowWithProgress`;
    let res;
    try {
      res = await conn.client.exec({
        query: fullSql, query_id: o.queryId, session_id: sessionId, abort_signal: o.signal, auth, query_params: o.params,
      });
    } catch (e) {
      if (e instanceof ClickHouseError) return { error: e.message };
      throw e; // network-level — propagate for attemptStatement's own classification
    }
    let sawException: string | null = null;
    await bridgeNdjsonProgress(res.stream, (line) => {
      if (line.exception) sawException = line.exception;
      o.onLine?.(line);
    });
    if (sawException) return { error: sawException };
    return { streamed: true };
  };
}

/**
 * Run a statement that produces no output the caller cares about — `CREATE
 * TEMPORARY TABLE`, `INSERT ... VALUES`, `SET` — through the official
 * client's `command()`, per plan §7's own rule ("use `command()` only when
 * discarding output is intentional"). `runOfficial`'s own `SpikeRequest`
 * vocabulary has no such mode (`consume` is only `'rows' | 'raw'`, both of
 * which route through `exec()`'s Table/raw branches, EVERY one of which
 * appends a literal `FORMAT ...` clause to the SQL text — required by the
 * installed `1.23.1` `ExecParams` type itself ("Statement to execute
 * (including the FORMAT clause)"), but a hard ClickHouse SYNTAX_ERROR for
 * `SET ...`/`INSERT ... VALUES (...)`, discovered by THIS test's first-ever
 * real run — see the final report for the full write-up). This helper is
 * therefore the correct, narrow way to drive these three statement kinds
 * through the official client from a spike TEST file without expanding
 * `official-adapter.ts`'s own exported surface for a single call site.
 */
async function runOfficialCommand(conn: OfficialConnection, credential: SpikeCredential, sessionId: string | undefined, sql: string): Promise<void> {
  await conn.client.command({ query: sql, session_id: sessionId, auth: officialAuthFor(credential) });
}

/** #630 Phase 7 compile-compat bridge — NOT the real Checkpoint 2C spike
 *  retarget (plan §19: a dedicated later sub-task's job). Adapts the
 *  pre-Phase-7 `(ctx, sql, RunQueryOptions) => Promise<RunQueryResult>` shim
 *  shape `makeSessionAwareRunQueryShim` above already has to the new narrow
 *  `QueryExecutionDeps.runText` shape, preserving runtime behavior for the
 *  ONLY thing the test below routes through it — `executeScript`'s
 *  whole-body text mode. A `{error}` outcome now throws (matching the new
 *  "package consumers throw" contract). */
function runTextViaShim(
  shim: (ctx: ChCtx, sql: string, o?: RunQueryOptions) => Promise<RunQueryResult>,
): (request: { sql: string; defaultFormat: string; params?: Record<string, string | number>; signal?: AbortSignal }) => Promise<string> {
  return async (request) => {
    const { query_id, ...rest } = request.params || {};
    const out = await shim({} as ChCtx, request.sql, {
      format: request.defaultFormat,
      queryId: query_id != null ? String(query_id) : undefined,
      params: rest,
      signal: request.signal,
    });
    if (out.error != null) throw new Error(out.error);
    return out.raw ?? '';
  };
}

describe.skipIf(!CH_URL)('live sessions, temporary tables, and SESSION_IS_LOCKED against a real ClickHouse server (plan §23)', () => {
  it('temporary table: persists only inside its explicit session, absent outside it — current adapter', async () => {
    const table = `asb585_tmp_current_${Date.now()}`;
    const sessionId = `asb585-live-session-current-${Date.now()}`;

    // 1. session-less control: no such table exists at all yet.
    const control = await runCurrent(baseReq({ sql: `EXISTS TABLE ${table}` }), CH_URL!, fetch);
    expect(control.outcome.error).toBeNull();
    expect(control.outcome.rows).toEqual([['0']]);

    // 2. create it inside the explicit session.
    const create = await runCurrent(baseReq({ sql: `CREATE TEMPORARY TABLE ${table} (x Int32) ENGINE = Memory`, sessionId }), CH_URL!, fetch);
    expect(create.outcome.error).toBeNull();

    // 3. read it back in the SAME session.
    const insert = await runCurrent(baseReq({ sql: `INSERT INTO ${table} VALUES (42)`, sessionId }), CH_URL!, fetch);
    expect(insert.outcome.error).toBeNull();
    const readInside = await runCurrent(baseReq({ sql: `SELECT x FROM ${table}`, sessionId }), CH_URL!, fetch);
    expect(readInside.outcome.error).toBeNull();
    expect(readInside.outcome.rows).toEqual([['42']]);

    // 4. absent outside the session — a session-less query for the SAME
    // name must fail (temporary tables are never visible outside their
    // owning session).
    const readOutside = await runCurrent(baseReq({ sql: `SELECT x FROM ${table}` }), CH_URL!, fetch);
    expect(readOutside.outcome.error).not.toBeNull();
  });

  it('temporary table: persists only inside its explicit session, absent outside it — official adapter', async () => {
    const table = `asb585_tmp_official_${Date.now()}`;
    const sessionId = `asb585-live-session-official-${Date.now()}`;
    const conn = createOfficialConnection(CH_URL!, fetch);

    const control = await runOfficial(conn, baseReq({ sql: `EXISTS TABLE ${table}` }));
    expect(control.outcome.error).toBeNull();
    expect(control.outcome.rows).toEqual([['0']]);

    await runOfficialCommand(conn, BASIC_USER_A, sessionId, `CREATE TEMPORARY TABLE ${table} (x Int32) ENGINE = Memory`);
    await runOfficialCommand(conn, BASIC_USER_A, sessionId, `INSERT INTO ${table} VALUES (43)`);
    const readInside = await runOfficial(conn, baseReq({ sql: `SELECT x FROM ${table}`, sessionId }));
    expect(readInside.outcome.error).toBeNull();
    expect(readInside.outcome.rows).toEqual([['43']]);

    const readOutside = await runOfficial(conn, baseReq({ sql: `SELECT x FROM ${table}` }));
    expect(readOutside.outcome.error).not.toBeNull();

    expect(conn.constructorCalls).toBe(1);
  });

  it('session SET persists inside the session and reverts to the default outside it — both adapters', async () => {
    const sessionIdCurrent = `asb585-live-set-current-${Date.now()}`;
    const sessionIdOfficial = `asb585-live-set-official-${Date.now()}`;
    const conn = createOfficialConnection(CH_URL!, fetch);

    // Default max_result_rows is 0 (unlimited) on a fresh session/session-less
    // connection — SET a distinctive non-default value (5) and prove it
    // sticks inside the session, and that a session-LESS read still reports
    // the ordinary default.
    const setCurrent = await runCurrent(baseReq({ sql: 'SET max_result_rows = 5', sessionId: sessionIdCurrent }), CH_URL!, fetch);
    expect(setCurrent.outcome.error).toBeNull();
    const insideCurrent = await runCurrent(baseReq({ sql: "SELECT value FROM system.settings WHERE name = 'max_result_rows'", sessionId: sessionIdCurrent }), CH_URL!, fetch);
    expect(insideCurrent.outcome.rows).toEqual([['5']]);
    const outsideCurrent = await runCurrent(baseReq({ sql: "SELECT value FROM system.settings WHERE name = 'max_result_rows'" }), CH_URL!, fetch);
    expect(outsideCurrent.outcome.rows).toEqual([['0']]);

    await runOfficialCommand(conn, BASIC_USER_A, sessionIdOfficial, 'SET max_result_rows = 5');
    const insideOfficial = await runOfficial(conn, baseReq({ sql: "SELECT value FROM system.settings WHERE name = 'max_result_rows'", sessionId: sessionIdOfficial }));
    expect(insideOfficial.outcome.rows).toEqual([['5']]);
    const outsideOfficial = await runOfficial(conn, baseReq({ sql: "SELECT value FROM system.settings WHERE name = 'max_result_rows'" }));
    expect(outsideOfficial.outcome.rows).toEqual([['0']]);
  });

  it('SESSION_IS_LOCKED: a genuinely overlapping request in one real session is classified and retried exactly once, through the REAL QueryExecutionService', async () => {
    const sessionId = `asb585-live-lock-${Date.now()}`;
    const conn = createOfficialConnection(CH_URL!, fetch);

    // Hold the session with a slow query — ClickHouse's own session
    // machinery serializes requests sharing one session_id, rejecting a
    // SECOND concurrent request with SESSION_IS_LOCKED (code 373) for as
    // long as the first is still executing.
    const holder = runOfficial(conn, baseReq({ sql: 'SELECT sleepEachRow(0.5) FROM numbers(4)', sessionId }));
    await new Promise((r) => setTimeout(r, 300)); // let the holder's request land first

    const attempts: number[] = [];
    const svc = createQueryExecutionService({
      // Never exercised — this test only calls `executeScript`.
      runProgress: async () => { throw new Error('runProgress not exercised by this spike helper'); },
      runText: runTextViaShim(makeSessionAwareRunQueryShim(conn, BASIC_USER_A, sessionId)),
      cancel: async () => {},
      now: () => Date.now(),
      uid: (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      retryMs: 3000, // >= the holder's own ~2s runtime, so the one retry lands after it releases the lock
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    });

    const result = await svc.executeScript({
      statements: [{ sql: 'SELECT 1', execSql: 'SELECT 1', params: {} }],
      onStatementStart: (_i, info) => attempts.push(info.attempt),
      onStatementResult: () => {},
    });

    await holder; // never leave the slow holder running past the test

    expect(attempts[0]).toBe(1);
    expect(attempts.length).toBeLessThanOrEqual(2); // never a THIRD attempt
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].status).not.toBe('error'); // the one retry (if needed) must land after the lock clears
  }, 20_000);
});
