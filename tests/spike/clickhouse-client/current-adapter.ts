// Phase 0 / issue #585 — the "current-side adapter" (plan §7): a thin
// SPIKE-OWNED wrapper around the REAL production functions from
// `src/net/authenticated-clickhouse-request.ts` (and `ch-client.ts`'s own
// zero-logic re-exports of package protocol helpers). It does not reimplement
// request construction, streaming, or error classification — it only
// translates the test-owned `SpikeRequest`/`SpikeOutcome` vocabulary at the
// boundary, exactly as the plan requires ("Do not reimplement current
// behavior in a test helper and compare that replica with the official
// client").
//
// Issue #630 Phase 7 (plan §19/§2.4, Checkpoint 2C's spike portion) — this
// file no longer depends on `ch-client.ts`'s generic, now-retiring
// `runQuery`/`exportQuery`/mutable-context `killQuery` or its `ChCtx` type:
// it drives the SAME production request path those functions themselves now
// delegate to — `authenticated-clickhouse-request.ts`'s `authenticatedProgress`
// (Table/KPI streaming), `authenticatedText` (TSV/explicit-format whole-body
// reads), and `authenticatedResponse` (the raw/export path) — plus the
// package's own stateless `createClickHouseHttpClient(...).killQuery(...)`
// for best-effort cancellation. The Table/KPI/TSV/explicit-format mapping and
// the non-2xx/in-band-exception classification below are this file's OWN
// mirror of that mapping (the same one `QueryExecutionService`
// (`src/application/query-execution-service.ts`) now owns for production —
// see its module doc), not a reimplementation of the transport itself.
// `applyStreamLine`/`newResult` stay SQL-Browser-owned result policy,
// imported from `src/core/stream.js` unchanged.
import {
  chUrl, parseExceptionText,
} from '../../../src/net/ch-client.js';
import {
  authenticatedResponse, authenticatedProgress, authenticatedText,
} from '../../../src/net/authenticated-clickhouse-request.js';
import type { AuthenticatedRequestCtx } from '../../../src/net/authenticated-clickhouse-request.js';
import { createClickHouseHttpClient } from '@altinity/clickhouse-http';
import { applyStreamLine, newResult } from '../../../src/core/stream.js';
import type { AdapterRunResult, SpikeCredential, SpikeRequest, SpikeOutcome } from './types.js';
import { emptyOutcome, IncrementalSha256 } from './normalize.js';

/** Build the `Authorization` header for a `SpikeCredential` — the harness's
 * own request-local credential concept, translated into exactly the header
 * production's authenticated request path would send for that credential
 * kind (`authenticated-clickhouse-request.ts`'s `authenticatedRequest`,
 * since #630 Phase 6; formerly `ch-client.ts`'s `authedFetch`, unchanged in
 * shape). */
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
      // the JWT used as the Basic password) — see authenticated-clickhouse-
      // request.ts's `authHeader` seam.
      return 'Basic ' + btoa(`${credential.username}:${credential.jwt}`);
    case 'invalid':
    default:
      return 'Basic ' + btoa('invalid:invalid');
  }
}

/** Optional hooks `makeCurrentCtx` wires onto the real production
 * `AuthenticatedRequestCtx`'s own epoch/lifecycle seam (plan §21's "stale
 * before request" / "stale during refresh" / "stale response" cases need
 * REAL `authenticated-clickhouse-request.ts` epoch fencing exercised through
 * its real production request path, `authenticatedRequest` — not a harness
 * reimplementation of it). Every field
 * is optional and defaults to the pre-existing no-op behavior, so no
 * existing call site needs to change. */
export interface CurrentCtxHooks {
  currentEpoch?: () => number;
  onSignedOut?: (detail?: string, expectedEpoch?: number) => void;
  onTransportConnected?: () => void;
  onTransportOffline?: (error?: unknown) => void;
  /** Overrides the default no-op `refresh()` — a test drives this to return
   *  `true` after simulating a token refresh (plan's "refresh then retry"),
   *  optionally delaying/mutating shared state first (plan's "stale during
   *  refresh"). */
  refresh?: () => Promise<boolean>;
  /** Overrides the default constant-token `getToken()` — lets a test observe
   *  how many times a token was actually read (e.g. to prove a stale-epoch
   *  refresh's resolved token is never re-read for the delegate fetch). */
  getToken?: () => Promise<string | null>;
  /** Fires the instant a delegate fetch RESOLVES — before `runCurrent`'s own
   *  `lastResponse` capture and before production's own post-fetch epoch
   *  check runs (`authenticated-clickhouse-request.ts`'s `authenticatedRequest`)
   *  (plan §21 "stale response"). A test flips a shared epoch
   *  variable here to deterministically land the flip in that exact window,
   *  with no timing race. */
  onFetchResponse?: (resp: Response) => void;
}

/** Build an `AuthenticatedRequestCtx` bound to one `SpikeRequest`'s
 * credential and origin, using the real production `fetch` seam contract.
 * `onFetch` is called once per underlying fetch invocation
 * (constructor/fetch-count invariants); `onResponse` observes each settled
 * `Response` (status/headers) — pure instrumentation at the already-injected
 * fetch boundary, not a second request path: production's authenticated
 * response consumers don't surface headers to their caller, so this is how
 * the harness reads them without reimplementing that request/parsing logic.
 * `hooks` (optional) wires the real epoch/lifecycle seam (`CurrentCtxHooks`,
 * above) — omitted entirely preserves the exact previous behavior (no epoch
 * hook, `refresh()` always resolves false, `onSignedOut` a no-op). */
export function makeCurrentCtx(
  request: SpikeRequest,
  baseUrl: string,
  realFetch: typeof fetch,
  onFetch?: () => void,
  onResponse?: (resp: Response) => void,
  initialAuthConfirmed?: boolean,
  hooks?: CurrentCtxHooks,
): AuthenticatedRequestCtx {
  const authHeader = credentialAuthHeader(request.credential);
  return {
    origin: baseUrl,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      onFetch?.();
      const resp = await realFetch(input, init);
      onResponse?.(resp);
      return resp;
    }) as typeof fetch,
    getToken: hooks?.getToken || (async () => authHeader.replace(/^(Bearer|Basic) /, '')),
    refresh: hooks?.refresh || (async () => false),
    onSignedOut: hooks?.onSignedOut || (() => {}),
    authHeader: () => authHeader,
    authConfirmed: initialAuthConfirmed,
    currentEpoch: hooks?.currentEpoch,
    onTransportConnected: hooks?.onTransportConnected,
    onTransportOffline: hooks?.onTransportOffline,
  };
}

/** Format one native-query-parameter VALUE exactly as installed 1.23.1's own
 * `formatQueryParams` would (`dist/common/data_formatter/format_query_params.js`):
 * a top-level scalar is stringified as-is (no quoting); an array wraps each
 * element in single quotes and joins with `,` inside `[...]` (the vendor
 * library's `isInArrayOrTuple: true, wrapStringInQuotes: true` branch).
 * Restricted, on purpose, to exactly the shapes this spike's fixtures use
 * (digit-string / number scalars and arrays of them — no escaping of
 * tab/newline/quote/backslash, which the real vendor formatter also handles
 * but no spike fixture exercises) — production's authenticated request path
 * has no array-value concept at all, so the CURRENT adapter must pre-format
 * an array-valued native parameter into the exact wire string itself before
 * handing it to the request's plain `Record<string, string|number>` params
 * bag; the OFFICIAL adapter instead hands the array straight to
 * `query_params` and lets the vendor library's own formatter do this. A
 * match between the two proves this hand-written mirror is correct — see
 * the "URL parameters" scenario in `parity.test.ts`. */
export function formatNativeParamValue(value: string | number | (string | number)[]): string {
  if (Array.isArray(value)) {
    return `[${value.map((v) => `'${v}'`).join(',')}]`;
  }
  return String(value);
}

/** Fold a `SpikeRequest`'s settings/native-params/role/session into the flat
 * `Record<string, string|number>` bag the production authenticated request
 * path accepts — settings ride as bare keys (matching the official
 * adapter's `clickhouse_settings`); native params are prefixed `param_`
 * here (the CURRENT side's own responsibility — see `formatNativeParamValue`'s
 * docstring for why the official side instead delegates this to the vendor
 * library); `role`/`sessionId` become the same `role`/`session_id` bare keys
 * the official client's own `toSearchParams` emits (array-valued `role` is
 * deliberately unsupported here — the params bag cannot repeat a key, so
 * every spike scenario exercising `role` uses a single string). */
function nativeParamsForCurrent(request: SpikeRequest): Record<string, string | number> {
  const out: Record<string, string | number> = { ...(request.settings || {}) };
  for (const [k, v] of Object.entries(request.params || {})) {
    out[`param_${k}`] = formatNativeParamValue(v);
  }
  if (typeof request.role === 'string') out.role = request.role;
  if (request.sessionId) out.session_id = request.sessionId;
  return out;
}

/** Run one `SpikeRequest` through the real production authenticated request
 * functions — `authenticatedResponse` for the raw/export path,
 * `authenticatedProgress`/`authenticatedText` for the rows path (mirroring
 * the SAME Table/KPI/TSV/explicit-format mapping `QueryExecutionService` now
 * owns in production, #630 Phase 7 §6.1-6.4) — folding the result into the
 * normalized `SpikeOutcome` vocabulary. `hooks` (optional) wires the real
 * epoch/lifecycle seam — see `CurrentCtxHooks`. */
export async function runCurrent(
  request: SpikeRequest,
  baseUrl: string,
  realFetch: typeof fetch,
  initialAuthConfirmed?: boolean,
  hooks?: CurrentCtxHooks,
): Promise<AdapterRunResult> {
  let fetchCalls = 0;
  let lastResponse: Response | null = null;
  const ctx = makeCurrentCtx(
    request, baseUrl, realFetch,
    () => { fetchCalls += 1; },
    (resp) => { lastResponse = resp; hooks?.onFetchResponse?.(resp); },
    initialAuthConfirmed,
    hooks,
  );
  const outcome: SpikeOutcome = emptyOutcome();
  const t0 = Date.now();

  if (request.consume === 'raw') {
    try {
      const resp = await authenticatedResponse(ctx, {
        sql: request.sql,
        defaultFormat: (request.format === 'Table' || request.format === 'KPI' ? undefined : request.format) || 'TabSeparatedWithNames',
        params: { ...(request.queryId ? { query_id: request.queryId } : {}), ...nativeParamsForCurrent(request) },
        signal: request.signal,
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
  // Same format/settings mapping production's `QueryExecutionService` owns
  // (#630 Phase 7 §6.1-6.4): Table/KPI stream the progress-bearing JSON wire
  // formats with no `wait_end_of_query`; TSV/explicit formats read the whole
  // body as text with `wait_end_of_query=1`. This spike never exercises a
  // positive row cap (`runCurrent` always passes an uncapped read), so no
  // `max_result_rows`/`result_overflow_mode` is added here.
  const fmt = request.format || 'Table';
  const isStreaming = fmt === 'Table' || fmt === 'KPI';
  const defaultFormat = isStreaming
    ? (fmt === 'KPI' ? 'JSONEachRowWithProgress' : 'JSONStringsEachRowWithProgress')
    : fmt === 'TSV' ? 'TabSeparatedWithNamesAndTypes' : fmt;
  const settings: Record<string, string | number> = {
    ...(isStreaming ? {} : { wait_end_of_query: 1 }),
    add_http_cors_header: 1,
  };
  const params = { ...(request.queryId ? { query_id: request.queryId } : {}), ...nativeParamsForCurrent(request) };
  try {
    if (isStreaming) {
      await authenticatedProgress(ctx, { sql: request.sql, defaultFormat, settings, params, signal: request.signal }, {
        onLine: (line) => {
          applyStreamLine(line, result);
          if (line.row && !firstRow) { firstRow = true; outcome.firstRowAtMs = Date.now() - t0; }
          if (line.exception) outcome.chMessage = line.exception;
        },
      });
      outcome.completedAtMs = Date.now() - t0;
    } else {
      const raw = await authenticatedText(ctx, { sql: request.sql, defaultFormat, settings, params, signal: request.signal });
      outcome.completedAtMs = Date.now() - t0;
      outcome.rawByteCount = new TextEncoder().encode(raw).byteLength;
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

/** Best-effort server cancellation (plan §22 "Server cancellation") through
 * the package's stateless `createClickHouseHttpClient(...).killQuery(...)` —
 * #630 Phase 7 §19: no longer routes through `ch-client.ts`'s retiring
 * mutable-context `killQuery`. Resolves the CURRENT Authorization from `ctx`
 * itself (the same `getToken()`/`authHeader()` seam `makeCurrentCtx` wires
 * up) and issues exactly one `KILL QUERY ... ASYNC`, swallowing every
 * failure — matching the retired function's own best-effort contract. A
 * missing token (never signed in) is a no-op, same as a missing `queryId`. */
export async function currentKillQuery(ctx: AuthenticatedRequestCtx, queryId: string | null | undefined): Promise<void> {
  if (!queryId) return;
  try {
    const token = await ctx.getToken();
    if (!token) return;
    const authHeader = ctx.authHeader || ((t: string) => 'Bearer ' + t);
    const client = createClickHouseHttpClient({ fetch: () => ctx.fetch, origin: () => ctx.origin });
    await client.killQuery({ queryId, authorization: authHeader(token) });
  } catch { /* best-effort */ }
}

/** Re-exported so scenario/harness code has one place to build the
 * production-shaped URL for direct fetch comparisons (fault-server request
 * inspection etc.) without importing `ch-client.ts` a second time. */
export { chUrl };
