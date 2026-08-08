import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { startFaultServer, POST_HEADER_ABORT_HOLD_MS } from '../../packages/clickhouse-http/test/browser/fault-server.mjs';

// Issue #630 Phase 8 — split out of the former
// `tests/e2e/clickhouse-http-transport.spec.js` (issue #630 Phases 1/6/7):
// this spec keeps ONLY the SQL Browser authentication-policy variants of the
// post-header cancellation family — the package-native scenarios themselves
// moved to `packages/clickhouse-http/test/browser/regression.spec.js`, the
// package's own regression suite. This spec owns the fault server's
// Node-side lifecycle: the root Playwright config only starts
// build/e2e-serve.mjs (the static/raw-ESM host on :5599) — it knows nothing
// about this ephemeral fixture server. It imports the package-owned
// `fault-server.mjs` fixture directly (plan §15 — a legitimate root
// consumer while the workspace exists; #639's extraction handoff lists this
// import path as one to update when the workspace is removed).
//
// Firefox cannot launch locally (repo-wide constraint); Chromium and WebKit
// are this suite's real acceptance signal.

test.describe('#630 Phase 8 — authenticated ClickHouse request cancellation semantics', () => {
  test.skip(
    ({ browserName }) => browserName === 'firefox',
    'authenticated-request acceptance is explicitly Chromium/WebKit',
  );

  /** @type {Awaited<ReturnType<typeof startFaultServer>>} */
  let fault;

  test.beforeAll(async () => {
    fault = await startFaultServer({ cors: true });
  });

  test.afterAll(async () => {
    // Playwright still runs a describe's afterAll even when every test in it
    // was test.skip()-ed (Firefox here) — but in that case beforeAll never
    // ran, so `fault` is still undefined. Guard rather than let a skipped
    // Firefox run fail on an unrelated hook error.
    await fault?.close();
  });

  test.beforeEach(async ({ page }) => {
    await page.goto('/tests/e2e/authenticated-clickhouse-request.html');
    await page.waitForFunction(() => window.__ready === true);
  });

  // Unique per test/project so log-filtering assertions never depend on
  // global log emptiness or ordering relative to any other test.
  function qid(fixture, projectName) {
    return `${fixture}__${projectName}-${randomUUID()}`;
  }

  test('Scenario 5 — native post-header body lifetime through authenticatedRequest()', async ({ page }, testInfo) => {
    const queryId = qid('post-header-abort-hold', testInfo.project.name);
    const start = await page.evaluate(
      ({ baseUrl, queryId }) => window.__scenario5AuthStart(baseUrl, queryId),
      { baseUrl: fault.baseUrl, queryId },
    );
    expect(start.identity).toBe(true);
    expect(start.bodyUsedBeforeRead).toBe(false);
    expect(start.firstDone).toBe(false);
    expect(start.firstText).toContain('first');
    expect(start.count).toBe(1);
    expect(start.authorization).toBe('Bearer auth-e2e-test-token');

    const after = await page.evaluate(() => window.__scenario5AuthAbortAndReadNext());
    expect(after.rejectedName).toBe('AbortError');
    // The already-settled authenticatedRequest() Response is untouched by
    // the later abort — no already-errored synthetic stream, no status/ok
    // mutation, and abort must never report offline.
    expect(after.sendResponseStatus).toBe(200);
    expect(after.sendResponseOk).toBe(true);
  });

  test('Scenario 6 — package streamLines() through authenticatedRequest() emits no callbacks after observable cancellation', async ({ page }, testInfo) => {
    test.setTimeout(30_000);
    const queryId = qid('post-header-abort-hold', testInfo.project.name);
    const result = await page.evaluate(
      ({ baseUrl, queryId, holdMs }) => window.__scenario6Auth(baseUrl, queryId, holdMs),
      { baseUrl: fault.baseUrl, queryId, holdMs: POST_HEADER_ABORT_HOLD_MS },
    );
    expect(result.rejectedName).toBe('AbortError');
    expect(result.chunksAtRejection).toBeGreaterThanOrEqual(1);
    expect(result.linesAfterWait).toBe(result.linesAtRejection);
    expect(result.chunksAfterWait).toBe(result.chunksAtRejection);
    expect(result.offlineCallsAfterAbort).toBe(0);
  });

  test('Scenario 7 — cancellation of one concurrent authenticated request cannot affect another sharing the same ctx', async ({ page }, testInfo) => {
    test.setTimeout(30_000);
    const queryIdA = qid('post-header-abort-hold', testInfo.project.name);
    const queryIdB = qid('post-header-abort-hold', testInfo.project.name);
    const result = await page.evaluate(
      ({ baseUrl, queryIdA, queryIdB, holdMs }) => window.__scenario7Auth(baseUrl, queryIdA, queryIdB, holdMs),
      { baseUrl: fault.baseUrl, queryIdA, queryIdB, holdMs: POST_HEADER_ABORT_HOLD_MS },
    );
    expect(result.aRejectedName).toBe('AbortError');
    expect(result.bFirstHeldDone).toBe(false);
    expect(result.bFirstHeldText).toContain('after-hold');
    expect(result.bCompletedCleanly).toBe(true);
  });

  test('Scenario 8 — abort after full body completion through authenticatedRequest() has no effect', async ({ page }, testInfo) => {
    const queryId = qid('ordinary-query', testInfo.project.name);
    const result = await page.evaluate(
      ({ baseUrl, queryId }) => window.__scenario8Auth(baseUrl, queryId),
      { baseUrl: fault.baseUrl, queryId },
    );
    expect(result.linesBefore).toBeGreaterThan(0);
    expect(result.abortThrew).toBe(false);
    expect(result.linesAfter).toBe(result.linesBefore);
    expect(result.chunksAfter).toBe(result.chunksBefore);
  });

  test('Scenario 9 — authenticatedProgress() emits no callbacks after observable cancellation, one Fetch', async ({ page }, testInfo) => {
    test.setTimeout(30_000);
    const queryId = qid('post-header-abort-hold', testInfo.project.name);
    const result = await page.evaluate(
      ({ baseUrl, queryId, holdMs }) => window.__scenario9Auth(baseUrl, queryId, holdMs),
      { baseUrl: fault.baseUrl, queryId, holdMs: POST_HEADER_ABORT_HOLD_MS },
    );
    expect(result.rejectedName).toBe('AbortError');
    expect(result.chunksAtRejection).toBeGreaterThanOrEqual(1);
    expect(result.countAtRejection).toBe(1);
    // One real Fetch throughout — no retry, before or after the wait.
    expect(result.countAfterWait).toBe(1);
    expect(result.linesAfterWait).toBe(result.linesAtRejection);
    expect(result.chunksAfterWait).toBe(result.chunksAtRejection);
    expect(result.authorization).toBe('Bearer auth-e2e-test-token');
  });
});
