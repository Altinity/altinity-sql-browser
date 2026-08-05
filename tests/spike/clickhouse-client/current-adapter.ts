// Phase 0 / issue #585 — the "current-side adapter" (plan §7): a thin
// SPIKE-OWNED wrapper around the REAL production functions from
// `src/net/ch-client.ts`. It does not reimplement request construction,
// streaming, or error classification — it only translates the test-owned
// `SpikeRequest`/`SpikeOutcome` vocabulary at the boundary, exactly as the
// plan requires ("Do not reimplement current behavior in a test helper and
// compare that replica with the official client").

import { runQuery, exportQuery, killQuery, chUrl, type ChCtx } from '../../../src/net/ch-client.js';
import { applyStreamLine, newResult, parseExceptionText } from '../../../src/core/stream.js';
import type { AdapterRunResult, SpikeCredential, SpikeRequest, SpikeOutcome } from './types.js';
import { emptyOutcome, IncrementalSha256 } from './normalize.js';

/** Build the `Authorization` header for a `SpikeCredential` — the harness's
 * own request-local credential concept, translated into exactly the header
 * `ch-client.ts`'s `authedFetch` would send for that credential kind. */
export function credentialAuthHeader(credential: SpikeCredential): string {
  // `btoa` (standard Web API, global in Node >=18 and every target browser)
  // rather than `Buffer` — see normalize.ts's `IncrementalSha256` docstring
  // for why spike `.ts` files avoid Node-only globals. Every fixture
  // username/password/JWT is ASCII (auth-fixtures.ts), so latin1 `btoa` is
  // exact here — not a general credential encoder.
  switch (credential.kind) {
    case 'basic':
      return 'Basic ' + btoa(`${credential.username}:${credential.password}`);
    case 'bearer':
      return 'Bearer ' + credential.token;
    case 'jwt-as-basic':
      // Matches the app's real JWT-as-Basic-password composition (username +
      // the JWT used as the Basic password) — see ch-client.ts's authHeader seam.
      return 'Basic ' + btoa(`${credential.username}:${credential.jwt}`);
    case 'invalid':
    default:
      return 'Basic ' + btoa('invalid:invalid');
  }
}

/** Build a `ChCtx` bound to one `SpikeRequest`'s credential and origin, using
 * the real production `fetch` seam contract. `onFetch` is called once per
 * underlying fetch invocation (constructor/fetch-count invariants);
 * `onResponse` observes each settled `Response` (status/headers) — pure
 * instrumentation at the already-injected fetch boundary, not a second
 * request path: production's `RunQueryResult` doesn't surface headers to
 * `runQuery`'s caller, so this is how the harness reads them without
 * reimplementing `runQuery`'s own request/parsing logic. */
export function makeCurrentCtx(
  request: SpikeRequest,
  baseUrl: string,
  realFetch: typeof fetch,
  onFetch?: () => void,
  onResponse?: (resp: Response) => void,
  initialAuthConfirmed?: boolean,
): ChCtx {
  const authHeader = credentialAuthHeader(request.credential);
  return {
    origin: baseUrl,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      onFetch?.();
      const resp = await realFetch(input, init);
      onResponse?.(resp);
      return resp;
    }) as typeof fetch,
    getToken: async () => authHeader.replace(/^(Bearer|Basic) /, ''),
    refresh: async () => false,
    onSignedOut: () => {},
    authHeader: () => authHeader,
    authConfirmed: initialAuthConfirmed,
  };
}

/** Run one `SpikeRequest` through the real production `runQuery`/`exportQuery`
 * functions, folding the result into the normalized `SpikeOutcome` vocabulary. */
export async function runCurrent(
  request: SpikeRequest,
  baseUrl: string,
  realFetch: typeof fetch,
  initialAuthConfirmed?: boolean,
): Promise<AdapterRunResult> {
  let fetchCalls = 0;
  let lastResponse: Response | null = null;
  const ctx = makeCurrentCtx(request, baseUrl, realFetch, () => { fetchCalls += 1; }, (resp) => { lastResponse = resp; }, initialAuthConfirmed);
  const outcome: SpikeOutcome = emptyOutcome();
  const t0 = Date.now();

  if (request.consume === 'raw') {
    try {
      const resp = await exportQuery(ctx, request.sql, {
        queryId: request.queryId,
        signal: request.signal,
        format: request.format === 'Table' || request.format === 'KPI' ? undefined : request.format,
        params: request.params,
      });
      outcome.httpStatus = resp.status;
      outcome.responseHeaders = Object.fromEntries(resp.headers.entries());
      const hash = new IncrementalSha256();
      const reader = resp.body!.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        hash.update(value);
      }
      outcome.rawByteCount = hash.totalBytes;
      outcome.rawSha256 = await hash.digestHex();
      outcome.completedAtMs = Date.now() - t0;
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') outcome.cancelled = true;
      else outcome.error = e instanceof Error ? e.message : String(e);
    }
    return { outcome, constructorCalls: 1, fetchCalls };
  }

  const result = newResult(request.format);
  result.rowLimit = 0;
  let firstRow = false;
  try {
    const out = await runQuery(ctx, request.sql, {
      format: request.format,
      queryId: request.queryId,
      signal: request.signal,
      params: { ...(request.settings || {}), ...(request.params || {}) },
      onLine: (line) => {
        applyStreamLine(line, result);
        if (line.row && !firstRow) { firstRow = true; outcome.firstRowAtMs = Date.now() - t0; }
        if (line.exception) outcome.chMessage = line.exception;
      },
    });
    outcome.completedAtMs = Date.now() - t0;
    if (out.error != null) outcome.error = out.error;
    if (out.raw != null) {
      outcome.rawByteCount = new TextEncoder().encode(out.raw).byteLength;
    }
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') outcome.cancelled = true;
    else outcome.error = e instanceof Error ? e.message : String(e);
  }
  if (lastResponse) {
    outcome.httpStatus = (lastResponse as Response).status;
    outcome.responseHeaders = Object.fromEntries((lastResponse as Response).headers.entries());
  }
  outcome.columns = result.columns.map((c) => ({ name: c.name, type: c.type }));
  outcome.rows = result.rows;
  outcome.partialRowCount = result.rows.length;
  outcome.progress = result.progress.total_rows !== undefined
    ? { rows: result.progress.rows, bytes: result.progress.bytes, totalRows: result.progress.total_rows }
    : null;
  if (result.error) {
    outcome.error = result.error;
    outcome.chMessage = parseExceptionText(result.error);
  }
  return { outcome, constructorCalls: 1, fetchCalls };
}

/** Best-effort server cancellation via the real `killQuery` (plan §22
 * "Server cancellation"). */
export async function currentKillQuery(ctx: ChCtx, queryId: string | null | undefined): Promise<void> {
  return killQuery(ctx, queryId, (s) => `'${String(s).replace(/'/g, "\\'")}'`);
}

/** Re-exported so scenario/harness code has one place to build the
 * production-shaped URL for direct fetch comparisons (fault-server request
 * inspection etc.) without importing `ch-client.ts` a second time. */
export { chUrl };
