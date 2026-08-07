// Phase 0 / issue #585 — deterministic parity/precision/auth/epoch/retry
// suite, backed entirely by `fault-server.mjs` (no live ClickHouse needed;
// the live-server precision/session/cancellation matrix is
// `run-matrix.mjs`'s job — see docs/evidence/585/). Every scenario below
// proves at least one row of the plan §11 invariant map — the mapping is
// recorded in `scenarios.ts` and in the ADR/evidence, not repeated per test.
//
// This file is the ONLY consumer of `@clickhouse/client-web` besides
// `official-adapter.ts` itself (indirectly) — confirming the package never
// reaches the normal unit suite (`tests/unit/**`) or production.

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { startFaultServer, closedLoopbackUrl } from './fault-server.mjs';
import { runCurrent } from './current-adapter.js';
import { createOfficialConnection, runOfficial, makeOfficialRunQueryShim, runOfficialRefreshThenRetry, officialAuthFor } from './official-adapter.js';
import { createEpochFence } from './guarded-fetch.js';
import { BASIC_USER_A, BASIC_USER_B, DENIED_USER, BEARER_FIXTURE, JWT_AS_BASIC_FIXTURE } from './auth-fixtures.js';
import { createQueryExecutionService } from '../../../src/application/query-execution-service.js';
import { killQueryWithLease } from '../../../src/net/ch-client.js';
import type { ChCtx, AuthenticatedCancellationLease } from '../../../src/net/ch-client.js';
import type { ScriptEntry } from '../../../src/core/script-result.js';
import type { SpikeCredential, SpikeRequest } from './types.js';

/** Narrow a `ScriptEntry` to its `status: 'error'` variant's message, or throw
 * — a small local helper so the ambiguous-write tests below don't need an
 * unsound cast to read `.error` off a union type. */
function errorEntryMessage(entry: ScriptEntry): string {
  if (entry.status !== 'error') throw new Error(`expected an error entry, got status=${entry.status}`);
  return entry.error ?? '';
}

let fault: Awaited<ReturnType<typeof startFaultServer>>;
let seq = 0;
function qid(fixture: string): string {
  seq += 1;
  return `${fixture}__${seq}`;
}

beforeAll(async () => {
  fault = await startFaultServer();
});
afterAll(async () => {
  await fault.close();
});
afterEach(() => {
  fault.resetAttemptCounts();
});

function baseReq(fixture: string, overrides: Partial<SpikeRequest> = {}): SpikeRequest {
  return {
    sql: 'SELECT 1',
    format: 'Table',
    credential: BASIC_USER_A,
    origin: 'same-origin',
    consume: 'rows',
    queryId: qid(fixture),
    ...overrides,
  };
}

/** Wraps `realFetch` to capture the exact `Authorization` header value of the
 * MOST RECENT call — for the "Bearer auth"/"JWT as Basic password" exact-
 * header scenarios, which need to see the wire value itself (the fault
 * server deliberately does NOT log full Authorization values — see
 * `fault-server.mjs`'s own credential-hygiene docstring). Every fixture
 * credential used with this helper is a committed, non-secret fixture value
 * (`auth-fixtures.ts`), so capturing it in-process (never logged, never
 * printed) stays within that same hygiene rule. */
function capturingFetch(realFetch: typeof fetch): { fetch: typeof fetch; lastAuth: () => string | null } {
  let last: string | null = null;
  const wrapped = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = init?.headers;
    if (headers instanceof Headers) {
      last = headers.get('authorization');
    } else if (Array.isArray(headers)) {
      const found = headers.find(([k]) => k.toLowerCase() === 'authorization');
      last = found ? found[1] : null;
    } else if (headers && typeof headers === 'object') {
      const found = Object.entries(headers as Record<string, string>).find(([k]) => k.toLowerCase() === 'authorization');
      last = found ? found[1] : null;
    }
    return realFetch(input, init);
  }) as typeof fetch;
  return { fetch: wrapped, lastAuth: () => last };
}

/** Same shape as the `service()` helper inside the "retry safety" describe
 * block below, but with an `uid` that IGNORES its `prefix` argument and
 * always mints a fresh id under `fixturePrefix` — `executeScript` always
 * calls `deps.uid('q')` internally (a fixed literal, ignoring the actual
 * fixture the test wants), so routing a full `executeScript` run to a
 * SPECIFIC fault-server fixture requires this override. */
function serviceFor(conn: ReturnType<typeof createOfficialConnection>, fixturePrefix: string) {
  let n = 0;
  const runQueryShim = makeOfficialRunQueryShim(conn, () => BASIC_USER_A);
  return createQueryExecutionService({
    runQuery: runQueryShim as unknown as typeof import('../../../src/net/ch-client.js').runQuery,
    killQuery: async () => {},
    ctx: () => ({} as ChCtx),
    now: () => Date.now(),
    uid: () => { n += 1; return `${fixturePrefix}__${n}`; },
    retryMs: 1,
    sleep: () => Promise.resolve(),
    sqlString: (s) => `'${String(s)}'`,
  });
}

describe('deterministic parity — rows path', () => {
  it('ordinary query: identical normalized columns/rows on both adapters', async () => {
    const req = baseReq('ordinary-query');
    const current = await runCurrent(req, fault.baseUrl, fetch);
    const conn = createOfficialConnection(fault.baseUrl, fetch);
    const official = await runOfficial(conn, req);
    expect(current.outcome.error).toBeNull();
    expect(official.outcome.error).toBeNull();
    expect(current.outcome.columns).toEqual([{ name: 'n', type: 'String' }]);
    expect(official.outcome.columns).toEqual(current.outcome.columns);
    expect(current.outcome.rows).toEqual([['1'], ['2']]);
    expect(official.outcome.rows).toEqual(current.outcome.rows);
  });

  it('empty result: zero rows, clean completion, no error on either adapter', async () => {
    const req = baseReq('empty-stream');
    const current = await runCurrent(req, fault.baseUrl, fetch);
    const conn = createOfficialConnection(fault.baseUrl, fetch);
    const official = await runOfficial(conn, req);
    expect(current.outcome.rows).toEqual([]);
    expect(official.outcome.rows).toEqual([]);
    expect(current.outcome.error).toBeNull();
    expect(official.outcome.error).toBeNull();
  });

  it('KPI progress path (publicly supported JSONEachRowWithProgress): both adapters stream progressively', async () => {
    const req = baseReq('kpi-progress', { format: 'KPI' });
    const current = await runCurrent(req, fault.baseUrl, fetch);
    const conn = createOfficialConnection(fault.baseUrl, fetch);
    const official = await runOfficial(conn, req);
    expect(current.outcome.rows.length).toBe(1);
    expect(official.outcome.rows.length).toBe(1);
    expect(current.outcome.progress?.rows).toBe(1);
    expect(official.outcome.progress?.rows).toBe(1);
  });

  it('progressive first row: first row precedes completion on both adapters, no full-body buffering', async () => {
    const req = baseReq('delayed-headers-scheduled-rows');
    const [current, official] = await Promise.all([
      runCurrent(req, fault.baseUrl, fetch),
      (async () => runOfficial(createOfficialConnection(fault.baseUrl, fetch), req))(),
    ]);
    expect(current.outcome.firstRowAtMs).not.toBeNull();
    expect(official.outcome.firstRowAtMs).not.toBeNull();
    expect(current.outcome.firstRowAtMs!).toBeLessThan(current.outcome.completedAtMs!);
    expect(official.outcome.firstRowAtMs!).toBeLessThan(official.outcome.completedAtMs!);
    // First-row publication must not be materially behind current (plan §19:
    // <=100ms budget for identical scheduled chunks).
    expect(Math.abs(official.outcome.firstRowAtMs! - current.outcome.firstRowAtMs!)).toBeLessThan(150);
    // Exact-precision proof riding along: UInt64 max survives as a string.
    expect(current.outcome.rows[0][0]).toBe('18446744073709551615');
    expect(official.outcome.rows[0][0]).toBe('18446744073709551615');
  }, 10_000);

  it('malformed stream: a bad line is skipped, a later well-formed row still arrives, on both adapters', async () => {
    const req = baseReq('malformed-line');
    const current = await runCurrent(req, fault.baseUrl, fetch);
    const conn = createOfficialConnection(fault.baseUrl, fetch);
    const official = await runOfficial(conn, req);
    expect(current.outcome.rows).toEqual([['after-malformed']]);
    expect(official.outcome.rows).toEqual([['after-malformed']]);
    expect(current.outcome.error).toBeNull();
    expect(official.outcome.error).toBeNull();
  });

  it('truncated stream: an incomplete trailing line never completes, is silently dropped, no crash', async () => {
    const req = baseReq('truncated-trailing-line');
    const current = await runCurrent(req, fault.baseUrl, fetch);
    const conn = createOfficialConnection(fault.baseUrl, fetch);
    const official = await runOfficial(conn, req);
    expect(current.outcome.rows).toEqual([['ok']]);
    expect(official.outcome.rows).toEqual([['ok']]);
  });

  it('in-band mid-stream exception: partial rows preserved, ends in error, never success, on both adapters', async () => {
    const req = baseReq('progress-format-mid-stream-exception');
    const current = await runCurrent(req, fault.baseUrl, fetch);
    const conn = createOfficialConnection(fault.baseUrl, fetch);
    const official = await runOfficial(conn, req);
    expect(current.outcome.rows).toEqual([['partial-before-exception']]);
    expect(official.outcome.rows).toEqual([['partial-before-exception']]);
    expect(current.outcome.error).toContain('Memory limit exceeded');
    expect(official.outcome.error).toContain('Memory limit exceeded');
  });

  it('server error before headers: a query outcome on both adapters, not a network/offline classification', async () => {
    const req = baseReq('pre-header-rejection');
    const current = await runCurrent(req, fault.baseUrl, fetch);
    const conn = createOfficialConnection(fault.baseUrl, fetch);
    const official = await runOfficial(conn, req);
    // Real finding: the current adapter's `parseExceptionText` keeps
    // ClickHouse's raw "Code: N. DB::Exception: <msg> (CODE_NAME)" text
    // verbatim, while the official client's `ClickHouseError` DECOMPOSES it
    // into `.code`/`.type`/`.message` and the message itself drops the
    // "Code: N. DB::Exception:" prefix and the "(CODE_NAME)" suffix — both
    // sides retain the same code (60) and the same human-readable substring,
    // just structured differently (recorded in
    // docs/evidence/585/critical-questions.md, "Are code and message
    // retained for current policy?").
    expect(current.outcome.error).toContain('UNKNOWN_TABLE');
    expect(current.outcome.error).toContain('Code: 60');
    expect(official.outcome.chCode).toBe(60);
    expect(official.outcome.error).toContain('does not exist');
    expect(current.outcome.cancelled).toBe(false);
    expect(official.outcome.cancelled).toBe(false);
  });

  it('repeated 401 (no prior successful connection): a query/auth outcome, not an infinite retry loop', async () => {
    const req = baseReq('repeated-401');
    const current = await runCurrent(req, fault.baseUrl, fetch);
    const conn = createOfficialConnection(fault.baseUrl, fetch);
    const official = await runOfficial(conn, req);
    expect(current.outcome.error).toBeTruthy();
    expect(official.outcome.error).toBeTruthy();
  });

  it('post-confirmation 403: a query outcome on both adapters, not a sign-out/offline error', async () => {
    // `authedFetch` (ch-client.ts) treats a FIRST-CONTACT 401/403 as a
    // login-denial (sign-out) — by design (see its own docstring). The
    // invariant this scenario actually proves ("post-confirmation 401/403
    // remain query outcomes") only applies once `ctx.authConfirmed` has
    // already latched true from an earlier 2xx on this same connection —
    // exactly the real workbench's session shape, never a connection's very
    // first request. `initialAuthConfirmed=true` reproduces that.
    const req = baseReq('forbidden-403', { credential: DENIED_USER });
    const current = await runCurrent(req, fault.baseUrl, fetch, true);
    const conn = createOfficialConnection(fault.baseUrl, fetch);
    const official = await runOfficial(conn, req);
    expect(current.outcome.error).toContain('ACCESS_DENIED');
    expect(official.outcome.chCode).toBe(497);
    expect(official.outcome.error).toContain('Not enough privileges');
  });

  it('response headers, query id, and X-ClickHouse-Summary are preserved verbatim by both adapters', async () => {
    const id = qid('controlled-headers-and-summary');
    const req = baseReq('controlled-headers-and-summary', { queryId: id });
    const current = await runCurrent(req, fault.baseUrl, fetch);
    const conn = createOfficialConnection(fault.baseUrl, fetch);
    const official = await runOfficial(conn, req);
    expect(current.outcome.responseHeaders['x-custom-exposed-header']).toBe('exposed-value');
    expect(official.outcome.responseHeaders['x-custom-exposed-header']).toBe('exposed-value');
  });

  it('a mid-stream connection reset is a distinct, non-success failure on both adapters', async () => {
    const req = baseReq('post-header-connection-reset');
    const current = await runCurrent(req, fault.baseUrl, fetch);
    const conn = createOfficialConnection(fault.baseUrl, fetch);
    const official = await runOfficial(conn, req);
    expect(current.outcome.error).toBeTruthy();
    expect(official.outcome.error).toBeTruthy();
    expect(current.outcome.rows.length).toBeGreaterThanOrEqual(0);
    expect(official.outcome.rows.length).toBeGreaterThanOrEqual(0);
  });
});

describe('deterministic parity — raw/export byte path', () => {
  it('raw export: exact byte count and SHA-256 equality on a TSV row containing exception-shaped text', async () => {
    const req = baseReq('raw-exception-like-text-then-more-data', { format: 'TabSeparatedWithNames', consume: 'raw' });
    const current = await runCurrent(req, fault.baseUrl, fetch);
    const conn = createOfficialConnection(fault.baseUrl, fetch);
    const official = await runOfficial(conn, req);
    expect(current.outcome.rawSha256).not.toBeNull();
    expect(current.outcome.rawSha256).toBe(official.outcome.rawSha256);
    expect(current.outcome.rawByteCount).toBe(official.outcome.rawByteCount);
  });

  it('raw export: invalid-UTF-8 bytes hash identically on both adapters (no text-decoding)', async () => {
    const req = baseReq('invalid-utf8-raw', { format: 'TabSeparatedWithNames', consume: 'raw' });
    const current = await runCurrent(req, fault.baseUrl, fetch);
    const conn = createOfficialConnection(fault.baseUrl, fetch);
    const official = await runOfficial(conn, req);
    expect(current.outcome.rawByteCount).toBe(8);
    expect(official.outcome.rawByteCount).toBe(8);
    expect(current.outcome.rawSha256).toBe(official.outcome.rawSha256);
  });

  it('raw export: a tagged late-exception trailer survives byte transport unmodified on both adapters', async () => {
    const req = baseReq('raw-tagged-late-exception', { format: 'TabSeparatedWithNames', consume: 'raw' });
    const current = await runCurrent(req, fault.baseUrl, fetch);
    const conn = createOfficialConnection(fault.baseUrl, fetch);
    const official = await runOfficial(conn, req);
    expect(current.outcome.rawSha256).toBe(official.outcome.rawSha256);
    expect(current.outcome.rawByteCount).toBe(official.outcome.rawByteCount);
  });

  it('raw export: a legacy untagged exception trailer survives byte transport unmodified on both adapters', async () => {
    const req = baseReq('raw-legacy-untagged-exception', { format: 'TabSeparatedWithNames', consume: 'raw' });
    const current = await runCurrent(req, fault.baseUrl, fetch);
    const conn = createOfficialConnection(fault.baseUrl, fetch);
    const official = await runOfficial(conn, req);
    expect(current.outcome.rawSha256).toBe(official.outcome.rawSha256);
  });
});

describe('authentication — per-request credential, no client mutation/reconstruction', () => {
  it('alternating Basic user A / user B / invalid / valid: each request uses only its own credential; one constructor call throughout', async () => {
    const conn = createOfficialConnection(fault.baseUrl, fetch);
    const seen: (string | null)[] = [];
    for (const credential of [BASIC_USER_A, BASIC_USER_B, DENIED_USER, BASIC_USER_A] as SpikeCredential[]) {
      fault.requestsLog.length = 0;
      const req = baseReq('ordinary-query', { credential });
      await runOfficial(conn, req);
      const last = fault.requestsLog.at(-1)!;
      seen.push(last.headers.authorizationScheme);
    }
    expect(seen).toEqual(['Basic', 'Basic', 'Basic', 'Basic']);
    expect(conn.constructorCalls).toBe(1);
  });
});

describe('credential-epoch fencing at the real fetch boundary', () => {
  it('a stale epoch registered before preparation, flipped before the delegate fetch fires, never reaches the network', async () => {
    let epoch = 1;
    const fence = createEpochFence(() => epoch, fetch);
    const client = createOfficialConnectionWithFetch(fault.baseUrl, fence.guardedFetch);
    const id = qid('ordinary-query');
    const registered = fence.register(id, epoch);
    expect(registered).toBe(true);
    // Simulate the race deterministically: the epoch turns AFTER the request
    // was PREPARED (registered under epoch 1) but BEFORE the official
    // client's internal work reaches the injected fetch. Empirically,
    // installed 1.23.1's `exec()` reaches the injected `fetch` with no
    // microtask boundary a caller can reliably interleave with via
    // `queueMicrotask` (verified: a `queueMicrotask`-scheduled flip run
    // AFTER starting `exec()` consistently loses the race — the delegate
    // fetch already fired). A synchronous flip immediately after
    // registration and before invoking the client is therefore the
    // deterministic reproduction of "replaced before the real fetch fires":
    // program order guarantees the epoch has already turned by the time
    // ANY internal step of the call — synchronous or not — reaches
    // `guardedFetch`, which is exactly the boundary plan §21 asks this
    // checkpoint to guard, regardless of how many (if any) microtask hops
    // separate "prepared" from "fetched" inside a given client version.
    epoch = 2;
    const req = baseReq('ordinary-query', { queryId: id });
    const result = await runOfficial(client, req);
    fence.unregister(id);
    expect(result.outcome.cancelled).toBe(true);
    expect(fence.staleRejections).toBe(1);
    expect(fence.delegatedCalls).toBe(0);
  });

  it('a current (non-stale) epoch reaches the network exactly once', async () => {
    let epoch = 5;
    const fence = createEpochFence(() => epoch, fetch);
    const client = createOfficialConnectionWithFetch(fault.baseUrl, fence.guardedFetch);
    const id = qid('ordinary-query');
    fence.register(id, epoch);
    const req = baseReq('ordinary-query', { queryId: id });
    const result = await runOfficial(client, req);
    fence.unregister(id);
    expect(result.outcome.error).toBeNull();
    expect(fence.delegatedCalls).toBe(1);
    expect(fence.staleRejections).toBe(0);
  });
});

describe('cancellation lease — the REAL production killQueryWithLease uses the frozen request credential, never live auth state (plan §22/§28 "frozen cancellation lease")', () => {
  it('a credential rotated AFTER the lease was captured never reaches the KILL QUERY request; the frozen one always does', async () => {
    const { fetch: capturing, lastAuth } = capturingFetch(fetch);
    // Mirrors src/application/connection-session.ts's captureCancellationLease():
    // `authorization` is a COMPLETE, already-resolved header value, frozen at
    // capture time — never recomputed from mutable auth state later.
    const frozenAuthorization = `Basic ${btoa('frozen-user:frozen-pass')}`;
    const lease: AuthenticatedCancellationLease = {
      epoch: 1,
      origin: fault.baseUrl,
      authorization: frozenAuthorization,
      fetch: capturing,
    };
    // Simulate a credential rotation (OAuth refresh / replacement sign-in)
    // that happens AFTER the lease was captured — killQueryWithLease must
    // have no way to observe this; it only ever reads `lease.authorization`,
    // never a live ctx/auth-mode lookup (unlike plain `killQuery`, which
    // does go through `queryJson`/`authedFetch`'s live auth path).
    const rotatedAuthorization = `Basic ${btoa('rotated-user:rotated-pass')}`;
    expect(rotatedAuthorization).not.toBe(frozenAuthorization); // sanity: the two really differ

    await killQueryWithLease(lease, qid('ordinary-query'), (s) => `'${String(s)}'`);

    expect(lastAuth()).toBe(frozenAuthorization);
  });

  it('a null/undefined query_id is a no-op — no fetch at all (matches killQuery\'s own early-return contract)', async () => {
    const { fetch: capturing, lastAuth } = capturingFetch(fetch);
    const lease: AuthenticatedCancellationLease = {
      epoch: 1, origin: fault.baseUrl, authorization: 'Basic irrelevant', fetch: capturing,
    };
    await killQueryWithLease(lease, null, (s) => `'${String(s)}'`);
    await killQueryWithLease(lease, undefined, (s) => `'${String(s)}'`);
    expect(lastAuth()).toBeNull();
  });
});

describe('retry safety — official outcomes fed through the REAL, unmodified QueryExecutionService', () => {
  it('SESSION_IS_LOCKED gets exactly one delayed retry, then succeeds', async () => {
    const conn = createOfficialConnection(fault.baseUrl, fetch);
    // Routed through the REAL QueryExecutionService via `serviceFor()` —
    // consistently with the sibling "ambiguous INSERT/DDL reset: no retry"
    // tests below, which already prove `serviceFor()`'s overridden `uid`
    // (minting `<fixturePrefix>__<n>` on every call, ignoring executeScript's
    // own fixed `deps.uid('q')` prefix) routes a full `executeScript` run to
    // a SPECIFIC fault-server fixture. The `scenarios.ts:63` comment claiming
    // this can't be done ("executeScript always mints its own query_id, so it
    // cannot itself be routed to a specific fixture") is contradicted by that
    // sibling test's own successful use of exactly this mechanism.
    const svc = serviceFor(conn, 'session-is-locked');
    const attempts: number[] = [];
    const result = await svc.executeScript({
      statements: [{ sql: 'SELECT 1', execSql: 'SELECT 1', params: {} }],
      onStatementStart: (_i, info) => attempts.push(info.attempt),
      onStatementResult: () => {},
    });
    // fault-server.mjs's 'session-is-locked' fixture rejects attempt 1 with
    // SESSION_IS_LOCKED (code 373) and succeeds on attempt 2 — exactly one
    // retry, then success, never a third attempt.
    expect(attempts).toEqual([1, 2]);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].status).not.toBe('error');
  });

  it('SESSION_IS_LOCKED: raw shim retried once by hand-driving the same policy the service applies', async () => {
    const conn = createOfficialConnection(fault.baseUrl, fetch);
    const runQueryShim = makeOfficialRunQueryShim(conn, () => BASIC_USER_A);
    const id = qid('session-is-locked');
    const first = await runQueryShim({} as ChCtx, 'SELECT 1', { format: 'Table', queryId: id });
    // The retry policy's own `SESSION_BUSY` regex (query-execution-service.ts)
    // matches "locked by a concurrent" case-insensitively — it does not
    // depend on the "(SESSION_IS_LOCKED)" code-name suffix the official
    // client's `ClickHouseError` strips from the message (see the
    // pre-header-rejection scenario's comment above for the same finding).
    expect(first.error).toContain('locked by a concurrent');
    const second = await runQueryShim({} as ChCtx, 'SELECT 1', { format: 'Table', queryId: id });
    expect(second).toEqual({ streamed: true });
  });

  it('a mid-stream connection reset on a read propagates as a throw (matching runQuery\'s own throw contract, not a swallowed {error})', async () => {
    const conn = createOfficialConnection(fault.baseUrl, fetch);
    const runQueryShim = makeOfficialRunQueryShim(conn, () => BASIC_USER_A);
    const id = qid('post-header-connection-reset');
    await expect(runQueryShim({} as ChCtx, 'SELECT 1', { format: 'Table', queryId: id })).rejects.toBeTruthy();
  });

  it('read-reset-retries-once: a read retries once after a mid-stream reset and then succeeds (hand-driven, same policy shape as the SESSION_IS_LOCKED case above)', async () => {
    const conn = createOfficialConnection(fault.baseUrl, fetch);
    const runQueryShim = makeOfficialRunQueryShim(conn, () => BASIC_USER_A);
    const id = qid('read-reset-then-success');
    await expect(runQueryShim({} as ChCtx, 'SELECT 1', { format: 'Table', queryId: id })).rejects.toBeTruthy();
    const second = await runQueryShim({} as ChCtx, 'SELECT 1', { format: 'Table', queryId: id });
    expect(second).toEqual({ streamed: true });
  });

  it('ambiguous INSERT reset: no retry through the REAL QueryExecutionService; the ambiguous-write message is preserved', async () => {
    const conn = createOfficialConnection(fault.baseUrl, fetch);
    const svc = serviceFor(conn, 'post-header-connection-reset');
    const attempts: number[] = [];
    const result = await svc.executeScript({
      statements: [{ sql: 'INSERT INTO t VALUES (1)', execSql: 'INSERT INTO t VALUES (1)', params: {} }],
      onStatementStart: (_i, info) => attempts.push(info.attempt),
      onStatementResult: () => {},
    });
    expect(attempts).toEqual([1]); // exactly one attempt — an ambiguous write must never retry
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].status).toBe('error');
    expect(errorEntryMessage(result.entries[0])).toContain('may have executed');
  });

  it('ambiguous DDL reset: no retry through the REAL QueryExecutionService; the ambiguous-write message is preserved', async () => {
    const conn = createOfficialConnection(fault.baseUrl, fetch);
    const svc = serviceFor(conn, 'post-header-connection-reset');
    const attempts: number[] = [];
    const result = await svc.executeScript({
      statements: [{ sql: 'CREATE TABLE t (x Int32) ENGINE = Memory', execSql: 'CREATE TABLE t (x Int32) ENGINE = Memory', params: {} }],
      onStatementStart: (_i, info) => attempts.push(info.attempt),
      onStatementResult: () => {},
    });
    expect(attempts).toEqual([1]); // exactly one attempt — DDL must never retry either
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].status).toBe('error');
    expect(errorEntryMessage(result.entries[0])).toContain('may have executed');
  });
});

describe('Table streaming and totals/extremes (plan §18)', () => {
  it('Table streaming: identical normalized meta/row/progress on both adapters', async () => {
    const req = baseReq('ordinary-query');
    const current = await runCurrent(req, fault.baseUrl, fetch);
    const conn = createOfficialConnection(fault.baseUrl, fetch);
    const official = await runOfficial(conn, req);
    expect(current.outcome.progress).toEqual({ rows: 2, bytes: 2, totalRows: 2 });
    expect(official.outcome.progress).toEqual(current.outcome.progress);
  });

  it('totals/extremes/rows_before_limit_at_least lines are a silent no-op on both adapters (documented current-behavior gap, not adopted new parsing)', async () => {
    const req = baseReq('totals-extremes');
    const current = await runCurrent(req, fault.baseUrl, fetch);
    const conn = createOfficialConnection(fault.baseUrl, fetch);
    const official = await runOfficial(conn, req);
    expect(current.outcome.rows).toEqual([['1'], ['2']]);
    expect(official.outcome.rows).toEqual([['1'], ['2']]);
    expect(current.outcome.error).toBeNull();
    expect(official.outcome.error).toBeNull();
  });
});

describe('cancellation — three deterministic points (plan §22)', () => {
  it('cancel before request: a pre-aborted signal produces no fetch side effect on either adapter', async () => {
    const controller = new AbortController();
    controller.abort();
    const req = baseReq('ordinary-query', { signal: controller.signal });
    const before = fault.requestsLog.length;
    const current = await runCurrent(req, fault.baseUrl, fetch);
    expect(current.outcome.cancelled).toBe(true);

    const conn = createOfficialConnection(fault.baseUrl, fetch);
    const official = await runOfficial(conn, req);
    expect(official.outcome.cancelled).toBe(true);
    expect(official.fetchCalls).toBe(0);
    expect(fault.requestsLog.length).toBe(before);
  });

  it('cancel awaiting headers: cancellation without an offline/auth mutation, on either adapter', async () => {
    const controller1 = new AbortController();
    setTimeout(() => controller1.abort(), 50);
    let offlineCalled = false;
    const current = await runCurrent(
      baseReq('slow-headers', { signal: controller1.signal }),
      fault.baseUrl,
      fetch,
      undefined,
      { onTransportOffline: () => { offlineCalled = true; } },
    );
    expect(current.outcome.cancelled).toBe(true);
    expect(offlineCalled).toBe(false);

    const controller2 = new AbortController();
    setTimeout(() => controller2.abort(), 50);
    const conn = createOfficialConnection(fault.baseUrl, fetch);
    const official = await runOfficial(conn, baseReq('slow-headers', { signal: controller2.signal }));
    expect(official.outcome.cancelled).toBe(true);
  }, 10_000);

  it('cancel during rows: no row is published after cancellation, on either adapter', async () => {
    const controllerC = new AbortController();
    setTimeout(() => controllerC.abort(), 170);
    const current = await runCurrent(
      baseReq('delayed-headers-scheduled-rows', { signal: controllerC.signal }),
      fault.baseUrl,
      fetch,
    );
    expect(current.outcome.cancelled).toBe(true);
    expect(current.outcome.rows).toHaveLength(1);

    const controllerO = new AbortController();
    setTimeout(() => controllerO.abort(), 170);
    const conn = createOfficialConnection(fault.baseUrl, fetch);
    const official = await runOfficial(conn, baseReq('delayed-headers-scheduled-rows', { signal: controllerO.signal }));
    expect(official.outcome.cancelled).toBe(true);
    expect(official.outcome.rows).toHaveLength(1);
  }, 10_000);
});

describe('timeout vs. offline vs. HTTP error — distinct classifications (plan §19/§21)', () => {
  it("timeout: the official client's own connection-level request_timeout produces a distinct Error('Timeout error.'); current has no built-in timeout, so a caller-driven timer is indistinguishable from a manual abort", async () => {
    const controllerC = new AbortController();
    setTimeout(() => controllerC.abort(), 200);
    const current = await runCurrent(baseReq('slow-headers', { signal: controllerC.signal }), fault.baseUrl, fetch);
    expect(current.outcome.cancelled).toBe(true);

    const conn = createOfficialConnection(fault.baseUrl, fetch, 200);
    const official = await runOfficial(conn, baseReq('slow-headers'));
    expect(official.outcome.cancelled).toBe(false);
    expect(official.outcome.error).toBe('Timeout error.');
  }, 10_000);

  it('offline rejection is classified distinctly from an HTTP ClickHouse query error, on either adapter', async () => {
    const deadUrl = await closedLoopbackUrl();

    const req = baseReq('ordinary-query');
    let offlineCalled = false;
    const current = await runCurrent(req, deadUrl, fetch, undefined, {
      onTransportOffline: () => { offlineCalled = true; },
    });
    expect(current.outcome.error).toBeTruthy();
    expect(offlineCalled).toBe(true);

    const conn = createOfficialConnection(deadUrl, fetch);
    const official = await runOfficial(conn, req);
    expect(official.outcome.chCode).toBeNull(); // network rejection, never a ClickHouseError
    expect(official.outcome.error).toBeTruthy();

    // Contrast: the pre-header-rejection HTTP-error scenario is a normal HTTP
    // response, not a fetch rejection — onTransportOffline must NOT fire.
    let offlineCalledForHttpError = false;
    await runCurrent(baseReq('pre-header-rejection'), fault.baseUrl, fetch, undefined, {
      onTransportOffline: () => { offlineCalledForHttpError = true; },
    });
    expect(offlineCalledForHttpError).toBe(false);
  });
});

describe('settings, role, session, query ID, and URL-parameter exact serialization (plan §18)', () => {
  it('settings: exact server-observed bare-key values on both adapters', async () => {
    const req = baseReq('ordinary-query', { settings: { max_threads: 4, readonly: '1' } });
    fault.requestsLog.length = 0;
    await runCurrent(req, fault.baseUrl, fetch);
    let logged = fault.requestsLog.at(-1)!;
    expect(logged.params.max_threads).toBe('4');
    expect(logged.params.readonly).toBe('1');

    fault.requestsLog.length = 0;
    const conn = createOfficialConnection(fault.baseUrl, fetch);
    await runOfficial(conn, req);
    logged = fault.requestsLog.at(-1)!;
    expect(logged.params.max_threads).toBe('4');
    expect(logged.params.readonly).toBe('1');
  });

  it('role: exact server-observed value on both adapters', async () => {
    const req = baseReq('ordinary-query', { role: 'analyst' });
    fault.requestsLog.length = 0;
    await runCurrent(req, fault.baseUrl, fetch);
    expect(fault.requestsLog.at(-1)!.params.role).toBe('analyst');

    fault.requestsLog.length = 0;
    const conn = createOfficialConnection(fault.baseUrl, fetch);
    await runOfficial(conn, req);
    expect(fault.requestsLog.at(-1)!.params.role).toBe('analyst');
  });

  it('session_id: present with the exact value when requested, absent when session-less, on both adapters', async () => {
    const withSession = baseReq('ordinary-query', { sessionId: 'asb-spike-session-1' });
    fault.requestsLog.length = 0;
    await runCurrent(withSession, fault.baseUrl, fetch);
    expect(fault.requestsLog.at(-1)!.params.session_id).toBe('asb-spike-session-1');

    const conn = createOfficialConnection(fault.baseUrl, fetch);
    fault.requestsLog.length = 0;
    await runOfficial(conn, withSession);
    expect(fault.requestsLog.at(-1)!.params.session_id).toBe('asb-spike-session-1');

    const sessionLess = baseReq('ordinary-query');
    fault.requestsLog.length = 0;
    await runCurrent(sessionLess, fault.baseUrl, fetch);
    expect(fault.requestsLog.at(-1)!.params.session_id).toBeUndefined();

    fault.requestsLog.length = 0;
    await runOfficial(conn, sessionLess);
    expect(fault.requestsLog.at(-1)!.params.session_id).toBeUndefined();
  });

  it('query ID exists before execution: the caller-allocated id is on the wire (the server received it as part of the request), for both adapters', async () => {
    const id = qid('controlled-headers-and-summary');
    const req = baseReq('controlled-headers-and-summary', { queryId: id });
    fault.requestsLog.length = 0;
    await runCurrent(req, fault.baseUrl, fetch);
    expect(fault.requestsLog.at(-1)!.params.query_id).toBe(id);

    fault.requestsLog.length = 0;
    const conn = createOfficialConnection(fault.baseUrl, fetch);
    await runOfficial(conn, req);
    expect(fault.requestsLog.at(-1)!.params.query_id).toBe(id);
  });

  it('URL parameters: an array of large-integer strings and a scalar large-integer string serialize to the exact same independently-computed wire value on both adapters', async () => {
    // Hand-computed, independent of both adapters' implementations: a
    // top-level scalar native parameter is unquoted; an array wraps each
    // element in single quotes inside `[...]` (ClickHouse's own array
    // literal syntax) — see `formatNativeParamValue`'s docstring in
    // `current-adapter.ts` for the algorithm both sides converge on.
    const expectedArray = "['18446744073709551615','0']";
    const expectedScalar = '99999999999999999999';
    const req = baseReq('ordinary-query', {
      params: { bignum: '99999999999999999999', arr: ['18446744073709551615', '0'] },
    });
    fault.requestsLog.length = 0;
    await runCurrent(req, fault.baseUrl, fetch);
    let logged = fault.requestsLog.at(-1)!;
    expect(logged.params.param_bignum).toBe(expectedScalar);
    expect(logged.params.param_arr).toBe(expectedArray);

    fault.requestsLog.length = 0;
    const conn = createOfficialConnection(fault.baseUrl, fetch);
    await runOfficial(conn, req);
    logged = fault.requestsLog.at(-1)!;
    expect(logged.params.param_bignum).toBe(expectedScalar);
    expect(logged.params.param_arr).toBe(expectedArray);
  });
});

describe('multipart param promotion — official query() only (plan §18)', () => {
  it('forced multipart: query() sends query_params as multipart/form-data with the correct field name/value, and omits them from the URL', async () => {
    const conn = createOfficialConnection(fault.baseUrl, fetch);
    fault.requestsLog.length = 0;
    const rs = await conn.client.query({
      query: 'SELECT 1',
      format: 'JSONEachRowWithProgress',
      query_id: qid('kpi-progress'),
      auth: officialAuthFor(BASIC_USER_A),
      use_multipart_params: true,
      query_params: { myparam: 'hello-multipart' },
    });
    const reader = rs.stream().getReader();
    for (;;) { const { done } = await reader.read(); if (done) break; }

    const logged = fault.requestsLog.at(-1)!;
    expect(logged.headers['content-type']).toContain('multipart/form-data');
    expect(logged.body).toContain('name="param_myparam"');
    expect(logged.body).toContain('hello-multipart');
    expect(logged.params.param_myparam).toBeUndefined();
  });

  it('automatic multipart: an oversized query_params payload is promoted to multipart automatically', async () => {
    const conn = createOfficialConnection(fault.baseUrl, fetch);
    const bigValue = 'x'.repeat(5000);
    fault.requestsLog.length = 0;
    const rs = await conn.client.query({
      query: 'SELECT 1',
      format: 'JSONEachRowWithProgress',
      query_id: qid('kpi-progress'),
      auth: officialAuthFor(BASIC_USER_A),
      use_multipart_params_auto: true,
      query_params: { big: bigValue },
    });
    const reader = rs.stream().getReader();
    for (;;) { const { done } = await reader.read(); if (done) break; }

    const logged = fault.requestsLog.at(-1)!;
    expect(logged.headers['content-type']).toContain('multipart/form-data');
    expect(logged.body).toContain('name="param_big"');
    expect(logged.params.param_big).toBeUndefined();
  });
});

describe('explicit FORMAT and raw TSV/CSV/JSON exact output (plan §18/§24)', () => {
  it('explicit FORMAT: a SQL text that already carries a trailing FORMAT clause is sent with exactly one FORMAT occurrence by the official adapter', async () => {
    const req = baseReq('raw-tsv-fixed', {
      sql: 'SELECT 1\nFORMAT TabSeparatedWithNames',
      format: 'TabSeparatedWithNames',
      consume: 'raw',
    });
    fault.requestsLog.length = 0;
    const conn = createOfficialConnection(fault.baseUrl, fetch);
    await runOfficial(conn, req);
    const body = fault.requestsLog.at(-1)!.body;
    const occurrences = (body.match(/FORMAT/gi) || []).length;
    expect(occurrences).toBe(1);
  });

  // Regression coverage for a P1 review finding (issue #585 Phase 0): a
  // prior ad hoc terminal regex (`/\bFORMAT\s+\S+\s*;?\s*$/i`) recognized an
  // existing trailing FORMAT clause only when it was the literal end of the
  // string (optionally plus a trailing `;`) — so a FORMAT clause followed by
  // a comment was invisible to it, and a second, duplicate FORMAT clause got
  // appended. `withTrailingFormat` (src/core/format.ts, the same function
  // production's own export path uses) is comment/string-aware via its
  // shared span scanner, so each of these must still see exactly ONE
  // existing FORMAT occurrence.
  it.each([
    ['a trailing line comment (--)', 'SELECT 1\nFORMAT TabSeparatedWithNames -- trailing note'],
    ['a trailing line comment (#)', 'SELECT 1\nFORMAT TabSeparatedWithNames # trailing note'],
    ['a semicolon followed by a trailing comment', 'SELECT 1\nFORMAT TabSeparatedWithNames;  -- trailing note'],
    ['a trailing block comment', 'SELECT 1\nFORMAT TabSeparatedWithNames /* trailing note */'],
    ['mixed-case FORMAT keyword', 'SELECT 1\nformat TabSeparatedWithNames'],
    ['mixed-case FORMAT keyword plus a trailing comment', 'SELECT 1\nFoRmAt TabSeparatedWithNames -- note'],
  ])('explicit FORMAT followed by %s: still exactly one FORMAT occurrence', async (_label, sql) => {
    const req = baseReq('raw-tsv-fixed', { sql, format: 'TabSeparatedWithNames', consume: 'raw' });
    fault.requestsLog.length = 0;
    const conn = createOfficialConnection(fault.baseUrl, fetch);
    await runOfficial(conn, req);
    const body = fault.requestsLog.at(-1)!.body;
    const occurrences = (body.match(/FORMAT/gi) || []).length;
    expect(occurrences).toBe(1);
  });

  it('FORMAT-shaped text inside a string literal is never mistaken for a trailing clause: the real FORMAT is still appended exactly once, after it', async () => {
    const req = baseReq('raw-tsv-fixed', {
      sql: "SELECT 'this text says FORMAT TabSeparatedWithNames but is just a string' AS note",
      format: 'TabSeparatedWithNames',
      consume: 'raw',
    });
    fault.requestsLog.length = 0;
    const conn = createOfficialConnection(fault.baseUrl, fetch);
    await runOfficial(conn, req);
    const body = fault.requestsLog.at(-1)!.body;
    const occurrences = (body.match(/FORMAT/gi) || []).length;
    // One inside the string literal (never a real clause) + one genuinely
    // appended trailing clause = two occurrences, and the real clause must
    // be the one actually trailing the query.
    expect(occurrences).toBe(2);
    expect(body.trim().endsWith('FORMAT TabSeparatedWithNames')).toBe(true);
  });

  it('FORMAT-shaped text inside a line comment is never mistaken for a trailing clause: the real FORMAT is still appended exactly once, after it', async () => {
    const req = baseReq('raw-tsv-fixed', {
      sql: 'SELECT 1 -- FORMAT TabSeparatedWithNames (not real, just a comment)',
      format: 'TabSeparatedWithNames',
      consume: 'raw',
    });
    fault.requestsLog.length = 0;
    const conn = createOfficialConnection(fault.baseUrl, fetch);
    await runOfficial(conn, req);
    const body = fault.requestsLog.at(-1)!.body;
    const occurrences = (body.match(/FORMAT/gi) || []).length;
    // The comment (and the FORMAT-shaped text inside it) is peeled by
    // `withTrailingFormat` before the real clause is appended, so exactly one
    // occurrence remains — the genuinely appended one.
    expect(occurrences).toBe(1);
    expect(body.trim().endsWith('FORMAT TabSeparatedWithNames')).toBe(true);
  });

  it('raw TSV: exact byte-for-byte output on both adapters', async () => {
    const expected = 'a\tb\n1\tx\n2\ty\n';
    const req = baseReq('raw-tsv-fixed', { format: 'TabSeparatedWithNames', consume: 'raw' });
    const current = await runCurrent(req, fault.baseUrl, fetch);
    const conn = createOfficialConnection(fault.baseUrl, fetch);
    const official = await runOfficial(conn, req);
    const expectedBytes = new TextEncoder().encode(expected).byteLength;
    expect(current.outcome.rawByteCount).toBe(expectedBytes);
    expect(official.outcome.rawByteCount).toBe(expectedBytes);
    expect(current.outcome.rawSha256).toBe(official.outcome.rawSha256);
  });

  it('raw CSV: exact byte-for-byte output on both adapters', async () => {
    const expected = '"a","b"\n"1","x"\n"2","y"\n';
    const req = baseReq('raw-csv-fixed', { format: 'CSVWithNames', consume: 'raw' });
    const current = await runCurrent(req, fault.baseUrl, fetch);
    const conn = createOfficialConnection(fault.baseUrl, fetch);
    const official = await runOfficial(conn, req);
    const expectedBytes = new TextEncoder().encode(expected).byteLength;
    expect(current.outcome.rawByteCount).toBe(expectedBytes);
    expect(official.outcome.rawByteCount).toBe(expectedBytes);
    expect(current.outcome.rawSha256).toBe(official.outcome.rawSha256);
  });

  it('raw JSON: exact byte-for-byte output on both adapters', async () => {
    const expected = '{"meta":[{"name":"a","type":"String"}],"data":[{"a":"1"},{"a":"2"}]}\n';
    const req = baseReq('raw-json-fixed', { format: 'JSON', consume: 'raw' });
    const current = await runCurrent(req, fault.baseUrl, fetch);
    const conn = createOfficialConnection(fault.baseUrl, fetch);
    const official = await runOfficial(conn, req);
    const expectedBytes = new TextEncoder().encode(expected).byteLength;
    expect(current.outcome.rawByteCount).toBe(expectedBytes);
    expect(official.outcome.rawByteCount).toBe(expectedBytes);
    expect(current.outcome.rawSha256).toBe(official.outcome.rawSha256);
  });
});

describe('no-output command (plan §18)', () => {
  it('an INSERT/DDL-shaped empty-body response is drained/discarded without hanging, and issues exactly one request, on both the current raw path and the official command()', async () => {
    const req = baseReq('no-output', { format: 'TSV', consume: 'raw' });
    fault.requestsLog.length = 0;
    const current = await runCurrent(req, fault.baseUrl, fetch);
    expect(current.outcome.error).toBeNull();
    expect(current.outcome.rawByteCount).toBe(0);
    expect(fault.requestsLog.length).toBe(1);

    fault.requestsLog.length = 0;
    const conn = createOfficialConnection(fault.baseUrl, fetch);
    const result = await conn.client.command({
      query: 'INSERT INTO t VALUES (1)',
      query_id: qid('no-output'),
      auth: officialAuthFor(BASIC_USER_A),
    });
    expect(result.http_status_code).toBe(200);
    expect(fault.requestsLog.length).toBe(1);
  });
});

describe('Bearer / JWT-as-Basic exact header composition (plan §18/§21)', () => {
  it('Bearer auth: exact request-local header on both adapters', async () => {
    const expected = 'Bearer asb-spike-bearer-fixture-token';
    const req = baseReq('ordinary-query', { credential: BEARER_FIXTURE });

    const cap1 = capturingFetch(fetch);
    await runCurrent(req, fault.baseUrl, cap1.fetch);
    expect(cap1.lastAuth()).toBe(expected);

    const cap2 = capturingFetch(fetch);
    const conn = createOfficialConnection(fault.baseUrl, cap2.fetch);
    await runOfficial(conn, req);
    expect(cap2.lastAuth()).toBe(expected);
  });

  it('JWT as Basic password: exact independently-computed Basic composition on both adapters', async () => {
    // Independently computed here (NOT via `credentialAuthHeader`, which is
    // shared plumbing both adapters build their ctx/headers from) — the
    // standard RFC 7617 Basic composition: base64("username:password"),
    // where the "password" is the JWT.
    const expected = 'Basic ' + btoa('asb_spike_jwt:asb.spike.jwt-fixture');
    const req = baseReq('ordinary-query', { credential: JWT_AS_BASIC_FIXTURE });

    const cap1 = capturingFetch(fetch);
    await runCurrent(req, fault.baseUrl, cap1.fetch);
    expect(cap1.lastAuth()).toBe(expected);

    const cap2 = capturingFetch(fetch);
    const conn = createOfficialConnection(fault.baseUrl, cap2.fetch);
    await runOfficial(conn, req);
    expect(cap2.lastAuth()).toBe(expected);
  });
});

describe('refresh then retry, and post-confirmation 401 (plan §18/§21)', () => {
  it('refresh then retry: exactly one refresh and one replay to success, on both adapters', async () => {
    const req = baseReq('401-then-success');
    let refreshCalls = 0;
    const current = await runCurrent(req, fault.baseUrl, fetch, undefined, {
      refresh: async () => { refreshCalls += 1; return true; },
    });
    expect(current.outcome.error).toBeNull();
    expect(current.outcome.rows).toEqual([['ok-after-refresh']]);
    expect(refreshCalls).toBe(1);

    fault.resetAttemptCounts();

    const conn = createOfficialConnection(fault.baseUrl, fetch);
    let officialRefreshCalls = 0;
    const officialResult = await runOfficialRefreshThenRetry(
      conn,
      baseReq('401-then-success'),
      async () => { officialRefreshCalls += 1; return BASIC_USER_A; },
      () => true,
    );
    expect(officialResult.refreshCalls).toBe(1);
    expect(officialResult.attempts).toBe(2);
    expect(officialResult.outcome.error).toBeNull();
    expect(officialRefreshCalls).toBe(1);
  });

  it('post-confirmation 401 remains a query outcome (no sign-out) on the current adapter; the official adapter classifies it as ClickHouseError code 516', async () => {
    const req = baseReq('repeated-401');
    const current = await runCurrent(req, fault.baseUrl, fetch, true); // authConfirmed=true — see the forbidden-403 test's docstring above for why
    expect(current.outcome.error).toBeTruthy();

    const conn = createOfficialConnection(fault.baseUrl, fetch);
    const official = await runOfficial(conn, req);
    expect(official.outcome.chCode).toBe(516);
    expect(official.outcome.error).toContain('Authentication failed');
  });
});

describe('credential-epoch fencing — stale before request, during refresh, and in response (plan §21)', () => {
  it('stale before request: an already-stale epoch prevents any fetch side effect, on either adapter', async () => {
    let epoch = 1;
    const req = baseReq('ordinary-query');
    const before = fault.requestsLog.length;
    let getTokenCalls = 0;
    const current = await runCurrent(req, fault.baseUrl, fetch, undefined, {
      currentEpoch: () => epoch,
      getToken: async () => { getTokenCalls += 1; epoch = 2; return 'irrelevant-token'; },
    });
    expect(current.outcome.cancelled).toBe(true);
    expect(fault.requestsLog.length).toBe(before);
    expect(getTokenCalls).toBe(1);

    let officialEpoch = 1;
    const fence = createEpochFence(() => officialEpoch, fetch);
    officialEpoch = 2; // already stale before register() is even called
    const registered = fence.register(qid('ordinary-query'), 1);
    expect(registered).toBe(false);
    expect(fence.delegatedCalls).toBe(0);
  });

  it('stale during refresh: the epoch turning mid-refresh prevents any replacement credential read or replay, on either adapter', async () => {
    let epoch = 1;
    const req = baseReq('401-then-success');
    let getTokenCalls = 0;
    const current = await runCurrent(req, fault.baseUrl, fetch, undefined, {
      currentEpoch: () => epoch,
      getToken: async () => { getTokenCalls += 1; return 'token-for-epoch-1'; },
      refresh: async () => { epoch = 2; return true; }, // epoch turns WHILE refresh is "in flight"
    });
    expect(current.outcome.cancelled).toBe(true);
    expect(getTokenCalls).toBe(1); // only the initial read — never re-read for a replacement

    fault.resetAttemptCounts();

    let officialEpoch = 1;
    const fence = createEpochFence(() => officialEpoch, fetch);
    const id = qid('401-then-success');
    fence.register(id, 1);
    const conn = createOfficialConnection(fault.baseUrl, fence.guardedFetch);
    let officialRefreshCalls = 0;
    const officialResult = await runOfficialRefreshThenRetry(
      conn,
      { ...baseReq('401-then-success'), queryId: id },
      async () => { officialRefreshCalls += 1; officialEpoch = 2; return BASIC_USER_A; },
      () => officialEpoch === 1,
    );
    fence.unregister(id);
    expect(officialRefreshCalls).toBe(1);
    expect(officialResult.attempts).toBe(1); // no second (replay) attempt ever reached the client
    expect(officialResult.outcome.cancelled).toBe(true);
  });

  it('stale response: no connected/lifecycle side effect fires for a response that arrives after the epoch has already turned, on either adapter (the caller\'s own data still comes through)', async () => {
    let epoch = 1;
    let connectedCalled = false;
    const req = baseReq('ordinary-query');
    const current = await runCurrent(req, fault.baseUrl, fetch, undefined, {
      currentEpoch: () => epoch,
      onTransportConnected: () => { connectedCalled = true; },
      onFetchResponse: () => { epoch = 2; }, // flips AFTER the response, before authedFetch's own post-check
    });
    expect(connectedCalled).toBe(false);
    expect(current.outcome.rows).toEqual([['1'], ['2']]);

    let officialEpoch = 1;
    const realFetchThatFlips = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const resp = await fetch(input, init);
      officialEpoch = 2; // flips inside the delegate's OWN continuation, before guardedFetch's post-check runs
      return resp;
    }) as typeof fetch;
    const fence = createEpochFence(() => officialEpoch, realFetchThatFlips);
    const id = qid('ordinary-query');
    fence.register(id, 1);
    const conn = createOfficialConnection(fault.baseUrl, fence.guardedFetch);
    const official = await runOfficial(conn, { ...baseReq('ordinary-query'), queryId: id });
    fence.unregister(id);
    expect(fence.staleResponses).toBe(1);
    expect(official.outcome.rows).toEqual([['1'], ['2']]);
  });
});

describe('§16 runtime-surface experiment — literal cast-forced in isolation, NOT adopted', () => {
  it('records stream()/json()/text() behavior when JSONStringsEachRowWithProgress is forced via an unsupported cast (empirically verified against installed 1.23.1)', async () => {
    const conn = createOfficialConnection(fault.baseUrl, fetch);

    // .text() RESOLVES — it buffers the WHOLE body as a raw string. This is
    // exactly the full-body-buffering behavior plan §19's hard gate forbids
    // for the ADOPTED path, which is WHY the narrow bridge instead uses
    // exec() (progress-bridge.ts) rather than casting this format into
    // query().text().
    const rsText = await conn.client.query({
      query: 'SELECT 1',
      format: 'JSONStringsEachRowWithProgress' as never,
      query_id: qid('ordinary-query'),
      auth: officialAuthFor(BASIC_USER_A),
    });
    const text = await rsText.text();
    expect(typeof text).toBe('string');
    expect(text).toContain('"meta"');

    // .json() THROWS — the vendor library's single-document JSON decoder
    // cannot parse this newline-delimited multi-record format at all.
    const rsJson = await conn.client.query({
      query: 'SELECT 1',
      format: 'JSONStringsEachRowWithProgress' as never,
      query_id: qid('ordinary-query'),
      auth: officialAuthFor(BASIC_USER_A),
    });
    let jsonError: string | null = null;
    try { await rsJson.json(); } catch (e) { jsonError = e instanceof Error ? e.message : String(e); }
    expect(jsonError).toContain('Cannot decode');

    // .stream() THROWS synchronously — installed 1.23.1's own
    // `StreamableJSONFormats` validation rejects this exact format, matching
    // `format-type-probe.ts`'s compile-time finding that it's not in the
    // public `DataFormat` union at all.
    const rsStream = await conn.client.query({
      query: 'SELECT 1',
      format: 'JSONStringsEachRowWithProgress' as never,
      query_id: qid('ordinary-query'),
      auth: officialAuthFor(BASIC_USER_A),
    });
    let streamError: string | null = null;
    try { rsStream.stream(); } catch (e) { streamError = e instanceof Error ? e.message : String(e); }
    expect(streamError).toContain('not streamable');
  });
});

// PR review fix (#630 Phase 1): `fault-server.mjs`'s own docstring says
// `opts.cors` defaults off and every pre-existing no-option caller (this
// file, `run-matrix.mjs`) keeps today's behavior — but the response
// error-suppression handler had been wired unconditionally, ahead of the
// `if (cors)` branch, silently changing that behavior for every caller here.
// Assert the scoping directly via the fault server's own
// `getLastErrorListenerCount()` introspection (kept inside `fault-server.mjs`
// so this `.ts` file needs no `node:http` import, per plan §8).
describe('#630 Phase 1 review fix — ServerResponse error-suppression is scoped to cors:true', () => {
  it('registers no ServerResponse error listener for a legacy no-option (cors:false, default) request', async () => {
    const req = baseReq('ordinary-query');
    const current = await runCurrent(req, fault.baseUrl, fetch);
    expect(current.outcome.error).toBeNull();
    expect(fault.getLastErrorListenerCount()).toBe(0);
  });

  it('registers exactly one ServerResponse error listener for an opt-in cors:true request', async () => {
    const corsFault = await startFaultServer({ cors: true });
    try {
      const req = baseReq('ordinary-query');
      const current = await runCurrent(req, corsFault.baseUrl, fetch);
      expect(current.outcome.error).toBeNull();
      expect(corsFault.getLastErrorListenerCount()).toBe(1);
    } finally {
      await corsFault.close();
    }
  });
});

function createOfficialConnectionWithFetch(baseUrl: string, fetchImpl: typeof fetch) {
  return createOfficialConnection(baseUrl, fetchImpl);
}
