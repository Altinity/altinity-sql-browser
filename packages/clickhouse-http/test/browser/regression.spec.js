import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { startFaultServer, POST_HEADER_ABORT_HOLD_MS } from './fault-server.mjs';

// Issue #630 Phase 8 — this package's own first-party Chromium/WebKit
// regression suite, ported (not merely referenced) from the SQL Browser root
// e2e suite's former `tests/e2e/clickhouse-http-transport.spec.js` (issue
// #630 Phases 1/2/3/4/7): package construction, deterministic
// request/Response fidelity, the progress/chunk cancellation family,
// concurrent-request isolation, and raw invalid-UTF-8 byte fidelity — driven
// directly against `createClickHouseHttpClient(...)`/`streamLines()` from
// the package's BUILT public barrel (`harness.html` imports `/dist/index.js`
// directly, served by this suite's own `server.mjs`), with no SQL Browser
// authentication/epoch/lifecycle composition at all. The authenticated
// variants of the post-header family (formerly Scenarios 5-9's `*Auth`
// siblings) stay a root SQL Browser integration test —
// `tests/e2e/authenticated-clickhouse-request.spec.js`.
//
// Firefox cannot launch locally in this repository's sandbox; Chromium and
// WebKit are this suite's real acceptance signal, matching the issue's own
// requirement for this package's regressions.

test.describe('@altinity/clickhouse-http — native Fetch/Response/cancellation regressions', () => {
  /** @type {Awaited<ReturnType<typeof startFaultServer>>} */
  let fault;

  test.beforeAll(async () => {
    fault = await startFaultServer({ cors: true });
  });

  test.afterAll(async () => {
    await fault?.close();
  });

  test.beforeEach(async ({ page }) => {
    await page.goto('/harness.html');
    await page.waitForFunction(() => window.__ready === true);
  });

  // Unique per test/project so log-filtering assertions never depend on
  // global log emptiness or ordering relative to any other test.
  function qid(fixture, projectName) {
    return `${fixture}__${projectName}-${randomUUID()}`;
  }

  async function waitForServerRequest(predicate, timeoutMs = 5000) {
    const start = Date.now();
    for (;;) {
      if (fault.requestsLog.some(predicate)) return;
      if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for the expected fault-server request');
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  test('Scenario 1 — request and Response fidelity', async ({ page }, testInfo) => {
    const queryId = qid('ordinary-query', testInfo.project.name);
    const result = await page.evaluate(
      ({ baseUrl, queryId }) => window.__scenario1(baseUrl, queryId),
      { baseUrl: fault.baseUrl, queryId },
    );
    expect(result.identity).toBe(true);
    expect(result.count).toBe(1);
    expect(result.sqlMatches).toBe(true);
    expect(result.authorization).toBe('Bearer test-token-abc123');
    expect(result.bodyUsedBeforeConsume).toBe(false);
    expect(result.status).toBe(200);
    expect(result.url).toContain('default_format=JSONCompact');

    // A cross-origin POST with an Authorization header triggers a CORS
    // preflight OPTIONS to the SAME URL first (logged too, body '') — filter
    // to the actual POST so this corroborates the real request body/params.
    const serverEntry = fault.requestsLog.find((e) => e.method === 'POST' && e.params && e.params.query_id === queryId);
    expect(serverEntry).toBeTruthy();
    // Server-observed corroboration is independent end-to-end evidence, not
    // the sole SQL proof — the exact transport boundary is asserted above
    // via `result.sqlMatches` (the wrapper's captured `init.body`).
    expect(serverEntry.body).toBe('  -- leading comment\n\tSELECT \'héllo\', 1 -- trailing comment\nFORMAT CSV;  \n');
    expect(serverEntry.params.wait_end_of_query).toBe('0');
    expect(serverEntry.params.empty_setting).toBe('');
    expect(serverEntry.params.space_val).toBe('a b');
    expect(serverEntry.params.reserved_val).toBe('a&b=c?d#e');
    expect(serverEntry.params.empty_param).toBe('');
  });

  test('Scenario 2 — non-2xx resolves untouched', async ({ page }, testInfo) => {
    const queryId = qid('ch-non-2xx-shaped', testInfo.project.name);
    const result = await page.evaluate(
      ({ baseUrl, queryId }) => window.__scenario2(baseUrl, queryId),
      { baseUrl: fault.baseUrl, queryId },
    );
    expect(result.identity).toBe(true);
    expect(result.count).toBe(1);
    expect(result.status).toBe(500);
    expect(result.bodyUsedBeforeConsume).toBe(false);
    expect(result.text).toBe('Code: 999. DB::Exception: synthetic non-2xx failure. (SYNTHETIC)');
  });

  test('Scenario 3 — pre-aborted request invokes Fetch once but produces no server traffic', async ({ page }, testInfo) => {
    const queryId = qid('ordinary-query', testInfo.project.name);
    const result = await page.evaluate(
      ({ baseUrl, queryId }) => window.__scenario3(baseUrl, queryId),
      { baseUrl: fault.baseUrl, queryId },
    );
    expect(result.count).toBe(1);
    expect(result.rejectedName).toBe('AbortError');
    const matching = fault.requestsLog.filter((e) => e.params && e.params.query_id === queryId);
    expect(matching.length).toBe(0); // no OPTIONS, no POST — the browser never dispatched real traffic
  });

  test('Scenario 4 — abort while awaiting headers rejects AbortError', async ({ page }, testInfo) => {
    const queryId = qid('slow-headers', testInfo.project.name);
    await page.evaluate(
      ({ baseUrl, queryId }) => window.__scenario4Start(baseUrl, queryId),
      { baseUrl: fault.baseUrl, queryId },
    );
    // Real request dispatch happened (server logged the POST) — this is what
    // distinguishes "cancelled before dispatch" (Scenario 3) from "cancelled
    // while genuinely awaiting headers".
    await waitForServerRequest((e) => e.method === 'POST' && e.params && e.params.query_id === queryId);
    const result = await page.evaluate(() => window.__scenario4AbortAndAwait());
    expect(result.count).toBe(1);
    expect(result.rejectedName).toBe('AbortError');
  });

  test('Scenario 5 — native post-header body lifetime: pending read rejects AbortError, prior resolution stands', async ({ page }, testInfo) => {
    const queryId = qid('post-header-abort-hold', testInfo.project.name);
    const start = await page.evaluate(
      ({ baseUrl, queryId }) => window.__scenario5Start(baseUrl, queryId),
      { baseUrl: fault.baseUrl, queryId },
    );
    expect(start.identity).toBe(true);
    expect(start.bodyUsedBeforeRead).toBe(false);
    expect(start.firstDone).toBe(false);
    expect(start.firstText).toContain('first');

    const after = await page.evaluate(() => window.__scenario5AbortAndReadNext());
    expect(after.rejectedName).toBe('AbortError');
    // The already-settled send() Response is untouched by the later abort —
    // no already-errored synthetic stream, no status/ok mutation.
    expect(after.sendResponseStatus).toBe(200);
    expect(after.sendResponseOk).toBe(true);
  });

  test('Scenario 6 — package streamLines() emits no callbacks after observable cancellation', async ({ page }, testInfo) => {
    test.setTimeout(30_000);
    const queryId = qid('post-header-abort-hold', testInfo.project.name);
    const result = await page.evaluate(
      ({ baseUrl, queryId, holdMs }) => window.__scenario6(baseUrl, queryId, holdMs),
      { baseUrl: fault.baseUrl, queryId, holdMs: POST_HEADER_ABORT_HOLD_MS },
    );
    expect(result.rejectedName).toBe('AbortError');
    expect(result.chunksAtRejection).toBeGreaterThanOrEqual(1);
    // Nothing changed across the wait spanning the fixture's held second
    // write — the abort truly stopped the loop, not merely delayed it.
    expect(result.linesAfterWait).toBe(result.linesAtRejection);
    expect(result.chunksAfterWait).toBe(result.chunksAtRejection);
  });

  test('Scenario 7 — cancellation of one concurrent request cannot affect another sharing the same transport', async ({ page }, testInfo) => {
    test.setTimeout(30_000);
    const queryIdA = qid('post-header-abort-hold', testInfo.project.name);
    const queryIdB = qid('post-header-abort-hold', testInfo.project.name);
    const result = await page.evaluate(
      ({ baseUrl, queryIdA, queryIdB, holdMs }) => window.__scenario7(baseUrl, queryIdA, queryIdB, holdMs),
      { baseUrl: fault.baseUrl, queryIdA, queryIdB, holdMs: POST_HEADER_ABORT_HOLD_MS },
    );
    expect(result.aRejectedName).toBe('AbortError');
    expect(result.bFirstHeldDone).toBe(false);
    expect(result.bFirstHeldText).toContain('after-hold');
    expect(result.bCompletedCleanly).toBe(true);
  });

  test('Scenario 8 — abort after full body completion has no effect', async ({ page }, testInfo) => {
    const queryId = qid('ordinary-query', testInfo.project.name);
    const result = await page.evaluate(
      ({ baseUrl, queryId }) => window.__scenario8(baseUrl, queryId),
      { baseUrl: fault.baseUrl, queryId },
    );
    expect(result.linesBefore).toBeGreaterThan(0);
    expect(result.abortThrew).toBe(false);
    expect(result.linesAfter).toBe(result.linesBefore);
    expect(result.chunksAfter).toBe(result.chunksBefore);
  });

  test('Scenario 9 — package client.queryProgress() emits no callbacks after observable cancellation, one Fetch', async ({ page }, testInfo) => {
    test.setTimeout(30_000);
    const queryId = qid('post-header-abort-hold', testInfo.project.name);
    const result = await page.evaluate(
      ({ baseUrl, queryId, holdMs }) => window.__scenario9(baseUrl, queryId, holdMs),
      { baseUrl: fault.baseUrl, queryId, holdMs: POST_HEADER_ABORT_HOLD_MS },
    );
    expect(result.rejectedName).toBe('AbortError');
    expect(result.chunksAtRejection).toBeGreaterThanOrEqual(1);
    expect(result.countAtRejection).toBe(1);
    // One real Fetch throughout — no retry, before or after the wait.
    expect(result.countAfterWait).toBe(1);
    // Nothing changed across the wait spanning the fixture's held second
    // write — the abort truly stopped the loop, not merely delayed it.
    expect(result.linesAfterWait).toBe(result.linesAtRejection);
    expect(result.chunksAfterWait).toBe(result.chunksAtRejection);
  });

  test('Extra — invalid UTF-8 raw bytes remain byte-identical at the native boundary', async ({ page }, testInfo) => {
    const queryId = qid('invalid-utf8-raw', testInfo.project.name);
    const result = await page.evaluate(
      ({ baseUrl, queryId }) => window.__scenarioInvalidUtf8(baseUrl, queryId),
      { baseUrl: fault.baseUrl, queryId },
    );
    expect(result.identity).toBe(true);
    expect(result.bodyUsedBeforeConsume).toBe(false);
    expect(result.status).toBe(200);
    expect(result.bytes).toEqual([0x61, 0x62, 0xff, 0xfe, 0x63, 0x00, 0x0a, 0x64]);
  });
});
