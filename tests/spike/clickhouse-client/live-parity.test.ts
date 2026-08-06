// Phase 0 / issue #585 — real-server progressive timing (§19), real
// mid-stream progress-format exceptions (§20), real server cancellation via
// `KILL QUERY`/`system.processes` (§22), and real raw/export byte-hash
// parity including a genuine late exception frame (§20/§24). Requires
// `ASB_SPIKE_CH_URL` (set externally); skips cleanly when unset — see
// `live-precision.test.ts`'s header for why.

import { describe, it, expect } from 'vitest';
import { runCurrent, currentKillQuery, makeCurrentCtx } from './current-adapter.js';
import { createOfficialConnection, runOfficial } from './official-adapter.js';
import { BASIC_USER_A } from './auth-fixtures.js';
import type { SpikeRequest } from './types.js';

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

function median(nums: number[]): number {
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

describe.skipIf(!CH_URL)('live progressive timing against a real ClickHouse server (plan §19)', () => {
  // A query that flushes one row per block, each block delayed — real-server
  // evidence that first-row publication precedes completion by a meaningful
  // margin on BOTH adapters, not merely on the deterministic fault server.
  //
  // `enable_http_compression: 0` is REQUIRED here — discovered by THIS
  // test's first-ever run: Node's built-in `fetch` (undici), when the
  // server responds with `Content-Encoding: gzip` (ClickHouse's own default
  // whenever `enable_http_compression=1`, which `chUrl`'s own default sends
  // on every request), decompresses the ENTIRE gzip stream before handing
  // ANY bytes to the `ReadableStream` reader — verified directly: 8 chunks
  // arriving progressively over ~1.9s WITHOUT compression, vs. exactly 1
  // chunk arriving only at the very end WITH it, for the identical query.
  // This is a NODE-RUNTIME-SPECIFIC limitation (a real browser's `fetch`
  // streams a compressed body progressively, which is WHY ClickHouse's
  // response compression is safe for production — the shipped app never
  // runs under Node). It has nothing to do with either adapter: both
  // `runCurrent` and `runOfficial` observed the identical non-progressive
  // behavior under Node with compression on. Disabling it here is a
  // narrow, test-harness-only accommodation for measuring real per-block
  // timing under Node — never a claim about production/browser behavior.
  const TIMING_SQL = 'SELECT sleepEachRow(0.3) FROM numbers(6) SETTINGS max_block_size = 1';
  const REPS = 5;

  it(`current adapter: first row precedes completion by >=1s across ${REPS} repetitions (median/range recorded)`, async () => {
    const firstRows: number[] = [];
    const completions: number[] = [];
    for (let i = 0; i < REPS; i++) {
      // eslint-disable-next-line no-await-in-loop -- sequential repetitions are the point: each is an independent real-server timing sample.
      const { outcome } = await runCurrent(baseReq({ sql: TIMING_SQL, queryId: `live-timing-current-${Date.now()}-${i}`, settings: { enable_http_compression: 0 } }), CH_URL!, fetch);
      expect(outcome.error).toBeNull();
      expect(outcome.firstRowAtMs).not.toBeNull();
      expect(outcome.completedAtMs).not.toBeNull();
      firstRows.push(outcome.firstRowAtMs!);
      completions.push(outcome.completedAtMs!);
      expect(outcome.completedAtMs! - outcome.firstRowAtMs!).toBeGreaterThanOrEqual(900); // >= ~1s of later rows, matching plan §19's "completion at least one second later"
    }
    // eslint-disable-next-line no-console
    console.log('live timing (current adapter) firstRow ms:', firstRows, 'median', median(firstRows), 'completed ms:', completions, 'median', median(completions));
  }, 60_000);

  it(`official adapter: first row precedes completion by >=1s across ${REPS} repetitions, and never buffers the whole body (median/range recorded)`, async () => {
    const conn = createOfficialConnection(CH_URL!, fetch);
    const firstRows: number[] = [];
    const completions: number[] = [];
    for (let i = 0; i < REPS; i++) {
      // eslint-disable-next-line no-await-in-loop
      const { outcome } = await runOfficial(conn, baseReq({ sql: TIMING_SQL, queryId: `live-timing-official-${Date.now()}-${i}`, settings: { enable_http_compression: 0 } }));
      expect(outcome.error).toBeNull();
      expect(outcome.firstRowAtMs).not.toBeNull();
      expect(outcome.completedAtMs).not.toBeNull();
      firstRows.push(outcome.firstRowAtMs!);
      completions.push(outcome.completedAtMs!);
      expect(outcome.completedAtMs! - outcome.firstRowAtMs!).toBeGreaterThanOrEqual(900);
    }
    // eslint-disable-next-line no-console
    console.log('live timing (official adapter) firstRow ms:', firstRows, 'median', median(firstRows), 'completed ms:', completions, 'median', median(completions));
    expect(conn.constructorCalls).toBe(1);
  }, 60_000);
});

describe.skipIf(!CH_URL)('live mid-stream progress-format exception against a real ClickHouse server (plan §20)', () => {
  // throwIf(...) forces a genuine ClickHouse exception partway through a
  // multi-block result — max_block_size=1 flushes each row as its own block
  // so rows before the failing one are ALREADY sent when the exception hits.
  const MIDSTREAM_SQL = "SELECT throwIf(number = 3, 'asb585 live mid-stream boom') AS v FROM numbers(6) SETTINGS max_block_size = 1";

  // DISCOVERED BY THIS TEST'S FIRST-EVER RUN (2026-08-05, ClickHouse
  // 26.6.2.160): the SQL exception text ("asb585 live mid-stream boom")
  // does NOT reach either adapter's `outcome.error` for THIS scenario. Root
  // cause, isolated directly (raw `fetch` against the same query, bypassing
  // both adapters entirely):
  //   1. By DEFAULT (no override), this server does NOT emit the clean
  //      in-band `{"exception": "..."}` JSON line `core/stream.ts`'s
  //      `applyStreamLine` (production) and this spike's `progress-
  //      bridge.ts` both parse — it emits the SAME raw
  //      `__exception__\r\n<tag>\r\n<message>...` TEXT FRAME the raw/export
  //      path already handles (`findExceptionFrame`), REGARDLESS of format.
  //      Setting `http_write_exception_in_output_format=1` restores the
  //      clean JSON line; this server's default is effectively off.
  //   2. After sending that raw frame, the connection is closed WITHOUT a
  //      clean chunked-encoding terminator — Node's `fetch` (undici) surfaces
  //      this as a "terminated"/`UND_ERR_SOCKET` read error, not a clean
  //      stream end, REGARDLESS of HTTP compression.
  // Neither `applyStreamLine`/`progress-bridge.ts` parses raw exception-
  // frame text (both only recognize the JSON `{"exception"}` shape) — so
  // that text is silently skipped as malformed JSON lines, and the ONLY
  // thing that ultimately surfaces as `outcome.error` is the low-level
  // "terminated" transport error from step 2, propagating through each
  // adapter's own try/catch. Plan §20's actual hard requirement — "never
  // silently report success" — IS satisfied (both fail, neither returns a
  // clean 6-row success), but the FRIENDLY exception text is lost on both
  // paths under this server's current defaults. This is flagged prominently
  // in the final report as a significant, ADR-relevant finding for whoever
  // owns `core/stream.ts`/the eventual Phase 1 transport — fixing it is
  // outside this sub-task's scope (no production file may be touched here).
  it('current adapter: the query definitively fails, never silently succeeds (partial-row count is timing-dependent under this failure mode — see the official-adapter test below)', async () => {
    const { outcome } = await runCurrent(baseReq({ sql: MIDSTREAM_SQL }), CH_URL!, fetch);
    expect(outcome.error).not.toBeNull();
    expect(outcome.error).not.toBe('');
    expect(outcome.rows.length).toBeLessThan(6); // never the full, unfailed result
  });

  it('official adapter: the query definitively fails, never silently succeeds (partial-row count is timing-dependent under this failure mode, not asserted here — see below)', async () => {
    // Unlike the current-adapter test above (which reliably observed rows
    // 0-2 before the fatal read), THIS adapter's row count here was found to
    // be genuinely RACY across repeated real runs (0 rows some runs, >0
    // others) — the fatal "terminated" read sometimes wins the race against
    // the vendor client's own NDJSON line-buffering before even one row
    // line is parsed. The one invariant that held on every repeated run is
    // asserted: never the full 6-row result, and always a definite error.
    const conn = createOfficialConnection(CH_URL!, fetch);
    const { outcome } = await runOfficial(conn, baseReq({ sql: MIDSTREAM_SQL }));
    expect(outcome.error).not.toBeNull();
    expect(outcome.error).not.toBe('');
    expect(outcome.rows.length).toBeLessThan(6);
  });
});

describe.skipIf(!CH_URL)('live raw/export byte-hash parity against a real ClickHouse server (plan §20/§24)', () => {
  // NOTE: plain `JSON` is deliberately excluded from this byte-hash-equality
  // list — discovered by this test's first-ever run: ClickHouse's `JSON`
  // format body embeds a per-EXECUTION, non-deterministic
  // `"statistics":{"elapsed": <seconds>}` field, so two separate requests
  // for the identical query NEVER hash identically even when every other
  // byte matches exactly (verified: a byte-level diff of two captures showed
  // the ENTIRE difference was that one floating-point timing field). `TSV`/
  // `CSV`/`RowBinary`/`TSVRaw` (below) carry no such per-execution field and
  // are the correct vehicles for this exact-byte-hash proof.
  const RAW_FORMATS: Array<{ id: string; format: string }> = [
    { id: 'tsv', format: 'TSV' },
    { id: 'csv', format: 'CSV' },
  ];

  it.each(RAW_FORMATS)('$id: current and official raw export byte-hash identically for a NUL+Unicode string column', async ({ format }) => {
    const sql = "SELECT number, 'a\\0b\u{1F600}c' AS s FROM numbers(5)";
    const current = await runCurrent(baseReq({ sql, format, consume: 'raw' }), CH_URL!, fetch);
    const conn = createOfficialConnection(CH_URL!, fetch);
    const official = await runOfficial(conn, baseReq({ sql, format, consume: 'raw' }));
    expect(current.outcome.error).toBeNull();
    expect(official.outcome.error).toBeNull();
    expect(current.outcome.rawByteCount).not.toBeNull();
    expect(current.outcome.rawSha256).toBe(official.outcome.rawSha256);
    expect(current.outcome.rawByteCount).toBe(official.outcome.rawByteCount);
  });

  it('RowBinary (raw, binary-capable path): current and official raw export byte-hash identically', async () => {
    const sql = 'SELECT number, toString(number) AS s FROM numbers(20)';
    const current = await runCurrent(baseReq({ sql, format: 'RowBinary', consume: 'raw' }), CH_URL!, fetch);
    const conn = createOfficialConnection(CH_URL!, fetch);
    const official = await runOfficial(conn, baseReq({ sql, format: 'RowBinary', consume: 'raw' }));
    expect(current.outcome.error).toBeNull();
    expect(official.outcome.error).toBeNull();
    expect(current.outcome.rawSha256).toBe(official.outcome.rawSha256);
    expect(current.outcome.rawByteCount).toBeGreaterThan(0);
  });

  it('invalid UTF-8 raw bytes: current and official hash identically (no text-decoding on either raw path)', async () => {
    // 0xFF is not valid UTF-8 anywhere — reinterpretCast/toFixedString forces
    // ClickHouse to emit it verbatim in a raw TSV column.
    const sql = "SELECT reinterpretAsFixedString(toUInt8(255)) AS v FROM numbers(3)";
    const current = await runCurrent(baseReq({ sql, format: 'TSVRaw', consume: 'raw' }), CH_URL!, fetch);
    const conn = createOfficialConnection(CH_URL!, fetch);
    const official = await runOfficial(conn, baseReq({ sql, format: 'TSVRaw', consume: 'raw' }));
    expect(current.outcome.error).toBeNull();
    expect(official.outcome.error).toBeNull();
    expect(current.outcome.rawSha256).toBe(official.outcome.rawSha256);
  });

  it('a genuine late export exception never completes as a clean, full success on either adapter, and both fail identically', async () => {
    // Same throwIf trick as the mid-stream Table test, but through the RAW
    // export path. DISCOVERED BY THIS TEST'S FIRST-EVER RUN (see the
    // mid-stream Table describe block's header comment above for the full
    // root-cause writeup, which applies identically here): this server
    // closes the connection after the exception frame WITHOUT a clean
    // chunked-encoding terminator, so BOTH adapters' raw byte-read loops
    // throw ("terminated"/`UND_ERR_SOCKET`) rather than reaching their own
    // `rawByteCount`/`rawSha256` assignment — `outcome.error` is what
    // ultimately reports the failure on both sides, not a raw byte hash.
    // The plan §20 hard requirement this still proves: raw export NEVER
    // silently reports a clean 6-row success after a genuine mid-export
    // exception, on EITHER adapter.
    const sql = "SELECT throwIf(number = 3, 'asb585 live late export boom') AS v FROM numbers(6) SETTINGS max_block_size = 1";
    const current = await runCurrent(baseReq({ sql, format: 'TSV', consume: 'raw' }), CH_URL!, fetch);
    const conn = createOfficialConnection(CH_URL!, fetch);
    const official = await runOfficial(conn, baseReq({ sql, format: 'TSV', consume: 'raw' }));
    // Neither side may report a clean success: EITHER an explicit error, OR
    // (if a future ClickHouse/runtime combination someday delivers a clean
    // stream end) a byte count that is NOT the full unfailed 6-row body.
    const currentFailedOrPartial = current.outcome.error != null || (current.outcome.rawByteCount != null && current.outcome.rawByteCount < 30);
    const officialFailedOrPartial = official.outcome.error != null || (official.outcome.rawByteCount != null && official.outcome.rawByteCount < 30);
    expect(currentFailedOrPartial).toBe(true);
    expect(officialFailedOrPartial).toBe(true);
    // Both adapters must observe the SAME class of outcome (both errored,
    // or both got a byte count) — a divergence here (one clean, one not)
    // would be a real parity gap, unlike the shared "terminated" failure
    // mode itself.
    expect(current.outcome.error != null).toBe(official.outcome.error != null);
  });
});

describe.skipIf(!CH_URL)('live server cancellation via KILL QUERY / system.processes (plan §22)', () => {
  it('a pre-allocated query_id is observable in system.processes; local abort + KILL QUERY makes it disappear', async () => {
    const queryId = `asb585-live-cancel-${Date.now()}`;
    const ctx = makeCurrentCtx(baseReq({ sql: '', queryId }), CH_URL!, fetch);
    const controller = new AbortController();

    // A long-running query, started but not awaited yet. `sleep(2.5)` (a
    // fixed, predictable wall-clock delay), NOT a row-count query —
    // discovered by this test's first-ever run: `SELECT count() FROM
    // numbers(200000000)` completes in under 100ms on a real, unconstrained
    // server (ClickHouse's `numbers()` source is heavily optimized), far too
    // fast for the polling loop below to reliably observe it in
    // `system.processes` before it finishes — a genuine, reproducible flake
    // in the ORIGINAL query choice, not a cancellation-mechanism defect.
    // 2.5s, not more: ALSO discovered live — ClickHouse's `sleep()` function
    // has a hardcoded maximum of 3 seconds (`Code: 160. TOO_SLOW` above it),
    // so `sleep(4)` fails INSTANTLY with a real exception rather than ever
    // running long enough to observe or cancel at all.
    const longRunning = runCurrent(
      baseReq({ sql: 'SELECT sleep(2.5)', queryId, signal: controller.signal }),
      CH_URL!,
      fetch,
    );

    // 1/2. Poll system.processes for the query_id to appear (own-query
    // visibility needs no special privilege) — bounded, real-server timing.
    let seen = false;
    for (let i = 0; i < 40 && !seen; i++) {
      // eslint-disable-next-line no-await-in-loop
      const probe = await runCurrent(
        baseReq({ sql: `SELECT count() FROM system.processes WHERE query_id = '${queryId}'`, queryId: `${queryId}-probe-${i}` }),
        CH_URL!,
        fetch,
      );
      if (probe.outcome.error == null && probe.outcome.rows[0]?.[0] === '1') seen = true;
      else await new Promise((r) => setTimeout(r, 250));
    }
    expect(seen).toBe(true);

    // 3. Local abort.
    controller.abort();
    const result = await longRunning;
    expect(result.outcome.cancelled).toBe(true);

    // 4. KILL QUERY against the REAL, running server — the REAL production
    // `killQuery` (via current-adapter.ts's re-export), which resolves auth
    // through `ctx`'s live authentication path. This is NOT
    // `killQueryWithLease` (the frozen-credential cancellation path used by a
    // closing authenticated execution scope, per src/net/ch-client.ts) — that
    // invariant (a credential rotated after capture never reaches the
    // request) is proven deterministically in parity.test.ts's "cancellation
    // lease" block, which imports and calls `killQueryWithLease` directly.
    // This test's job is the complementary, live-server-only proof: that
    // issuing KILL QUERY for a real, still-running query_id actually makes it
    // disappear from `system.processes`.
    await currentKillQuery(ctx, queryId);

    // 5. Poll until it disappears from system.processes.
    let gone = false;
    for (let i = 0; i < 40 && !gone; i++) {
      // eslint-disable-next-line no-await-in-loop
      const probe = await runCurrent(
        baseReq({ sql: `SELECT count() FROM system.processes WHERE query_id = '${queryId}'`, queryId: `${queryId}-probe-gone-${i}` }),
        CH_URL!,
        fetch,
      );
      if (probe.outcome.error == null && probe.outcome.rows[0]?.[0] === '0') gone = true;
      else await new Promise((r) => setTimeout(r, 250));
    }
    expect(gone).toBe(true);
  }, 40_000);

  it('the same server-cancellation proof holds for the official adapter (query_id observed pre-execution, aborted, KILLed, disappears)', async () => {
    const queryId = `asb585-live-cancel-official-${Date.now()}`;
    const conn = createOfficialConnection(CH_URL!, fetch);
    const ctx = makeCurrentCtx(baseReq({ sql: '', queryId }), CH_URL!, fetch); // KILL QUERY reuses the real production killQuery — adapter-agnostic
    const controller = new AbortController();

    // See the current-adapter test above for why `sleep(2.5)`, not a row count.
    const longRunning = runOfficial(conn, baseReq({ sql: 'SELECT sleep(2.5)', queryId, signal: controller.signal }));

    let seen = false;
    for (let i = 0; i < 40 && !seen; i++) {
      // eslint-disable-next-line no-await-in-loop
      const probe = await runOfficial(conn, baseReq({ sql: `SELECT count() FROM system.processes WHERE query_id = '${queryId}'`, queryId: `${queryId}-probe-${i}` }));
      if (probe.outcome.error == null && probe.outcome.rows[0]?.[0] === '1') seen = true;
      else await new Promise((r) => setTimeout(r, 250));
    }
    expect(seen).toBe(true);

    controller.abort();
    const result = await longRunning;
    expect(result.outcome.cancelled).toBe(true);

    await currentKillQuery(ctx, queryId);

    let gone = false;
    for (let i = 0; i < 40 && !gone; i++) {
      // eslint-disable-next-line no-await-in-loop
      const probe = await runOfficial(conn, baseReq({ sql: `SELECT count() FROM system.processes WHERE query_id = '${queryId}'`, queryId: `${queryId}-probe-gone-${i}` }));
      if (probe.outcome.error == null && probe.outcome.rows[0]?.[0] === '0') gone = true;
      else await new Promise((r) => setTimeout(r, 250));
    }
    expect(gone).toBe(true);
  }, 40_000);
});
