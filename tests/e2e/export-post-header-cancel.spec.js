import { test, expect } from '@playwright/test';
import { startFaultServer } from '../../packages/clickhouse-http/test/browser/fault-server.mjs';

// #630 Phase 7 (pre-PR review Finding 1) — Plan §18/Checkpoint 3 and A15's
// Definition of Done require a dedicated EXPORT-shaped real-browser fixture
// proving native post-header cancellation semantics survive through the
// ACTUAL export path (`ExportService.streamToFile()`/`exportDirect`/
// `authenticatedResponse`), not just query/progress
// (`clickhouse-http-transport.{html,spec.js}`'s Scenarios 5-9, which remain
// query-progress-only per that spec's own file-level comment). This spec owns
// the fault server's Node-side lifecycle for this fixture, exactly like
// `clickhouse-http-transport.spec.js` does for its own scenarios — the root
// Playwright config only starts the static harness host (`build/e2e-serve.mjs`
// on :5599); it knows nothing about this ephemeral server. Firefox cannot
// launch locally (repo-wide constraint, `playwright.config.js`'s own
// comment); Chromium and WebKit are this fixture's real acceptance signal,
// matching every other native-cancellation e2e spec in this repo.

test.describe('#630 Phase 7 — export post-header cancellation (real ExportService, real fetch, real AbortController)', () => {
  test.skip(
    ({ browserName }) => browserName === 'firefox',
    'native post-header cancellation acceptance is explicitly Chromium/WebKit, matching clickhouse-http-transport.spec.js',
  );

  /** @type {Awaited<ReturnType<typeof startFaultServer>>} */
  let fault;

  test.beforeAll(async () => {
    fault = await startFaultServer({ cors: true });
  });

  test.afterAll(async () => {
    await fault?.close();
  });

  test.beforeEach(async ({ page }) => {
    await page.goto('/tests/e2e/export-post-header-cancel.html');
    await page.waitForFunction(() => window.__ready === true);
  });

  test('settles headers, commits bytes past the 32 KiB hold-back, then a mid-read cancel stops the export with full cleanup and a correct owner-scoped remote KILL', async ({ page }) => {
    test.setTimeout(30_000);
    const result = await page.evaluate(
      ({ baseUrl }) => window.__exportPostHeaderCancel(baseUrl),
      { baseUrl: fault.baseUrl },
    );

    // Headers/first-chunk fidelity — exactly one direct-export request, 2xx.
    expect(result.directRequestCount).toBe(1);
    expect(result.directRequestOk).toBe(true);

    // File bytes were committed (at least one real write + progress event)
    // BEFORE the held tail was ever released — proves this is genuine
    // post-header, past-hold-back streaming, not a headers-only proof. The
    // exact number of write/progress pairs the initial ~40 KiB burst
    // produces is engine-dependent (Chromium delivers it as a single native
    // read; WebKit has been observed splitting it into a few smaller reads,
    // each individually crossing the 32 KiB hold-back on its own) — the
    // invariant this asserts is "comfortably past the hold-back, at least
    // once", not an exact read count.
    expect(result.progressCountBeforeCancel).toBeGreaterThanOrEqual(1);
    expect(result.writesBeforeCancelCount).toBe(result.progressCountBeforeCancel);
    // The fixture's first chunk is ~40 KiB, comfortably past ExportService's
    // 32 KiB hold-back — but the amount actually COMMITTED to the file is
    // (bytes received so far) minus the 32 KiB still retained in the
    // hold-back buffer, so this is a small positive number (a few KiB), not
    // itself > 32 KiB. ">0" is the real invariant: a real write happened at
    // all, proving the hold-back threshold was genuinely crossed rather than
    // this being a headers-only proof.
    expect(result.bytesBeforeCancel).toBeGreaterThan(0);
    expect(result.totalWrittenBytes).toBe(result.bytesBeforeCancel);

    // Cancel occurred during the pending second reader.read(); that read
    // aborted, and NO later write/progress occurred (the fixture's held
    // second chunk, sent ~3s later to an already-torn-down connection, never
    // reached the file).
    expect(result.progressCountFinal).toBe(result.progressCountBeforeCancel);
    expect(result.writesFinalCount).toBe(result.writesBeforeCancelCount);

    // Writer cleanup + .partial semantics — no successful final file for
    // incomplete data.
    expect(result.writerClosed).toBe(true);
    expect(result.writerAborted).toBe(false);
    expect(result.movedToPartial).toBe('export.tsv.partial');

    // Owner-scoped remote cancellation: the exact epoch/query id this export
    // registered with reached the cancel callback, and a REAL KILL QUERY
    // request (through the package's own stateless `client.killQuery(...)`,
    // the same mechanism `killQueryWithLease` calls, #630 Phase 7 §10) landed
    // on the server naming that exact query id.
    expect(result.cancelCallCount).toBe(1);
    expect(result.cancelOwnerEpoch).toBe(4242);
    expect(result.cancelQueryId).toBe(result.directQueryId);
    expect(result.cancelQueryId).toMatch(/^export-post-header-abort-hold__/);
    expect(result.killRequestCount).toBe(1);
    expect(result.killRequestSqlContainsKillQuery).toBe(true);
    expect(result.killRequestSqlContainsQueryId).toBe(true);

    // No offline/sign-out classification; no refresh attempt — cancellation
    // must never be misclassified as a connectivity/auth failure.
    expect(result.onTransportOfflineCalls).toBe(0);
    expect(result.onSignedOutCalls).toBe(0);
    expect(result.refreshCalls).toBe(0);

    // No dependency on a successful response's .text() anywhere in the raw
    // export byte-stream path.
    expect(result.textCalledOnSuccessfulResponse).toBe(false);

    // exportDirect swallows the AbortError internally (no user-facing
    // "Export failed" toast for an explicit cancel).
    expect(result.toastMessages).toEqual([]);
  });
});
