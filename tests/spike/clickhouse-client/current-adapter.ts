// Phase 0 / issue #585 — the "current-side adapter" (plan §7): a thin
// SPIKE-OWNED wrapper around the REAL production functions from
// `src/net/ch-client.ts`. It does not reimplement request construction,
// streaming, or error classification — it only translates the test-owned
// `SpikeRequest`/`SpikeOutcome` vocabulary at the boundary, exactly as the
// plan requires ("Do not reimplement current behavior in a test helper and
// compare that replica with the official client").

// Issue #630 Phase 3 — `parseExceptionText` is package-owned now
// (`@altinity/clickhouse-http`); obtained here through `ch-client.ts`'s own
// zero-logic re-export (the same gateway `chUrl` already came through since
// Phase 2), in the same import declaration. `applyStreamLine`/`newResult`
// stay SQL-Browser-owned result policy, imported from `src/core/stream.js`
// unchanged.
import {
  runQuery, exportQuery, killQuery, chUrl, parseExceptionText, type ChCtx,
} from '../../../src/net/ch-client.js';
import { applyStreamLine, newResult } from '../../../src/core/stream.js';
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

/** Optional hooks `makeCurrentCtx` wires onto `ChCtx`'s own epoch/lifecycle
 * seam (plan §21's "stale before request" / "stale during refresh" /
 * "stale response" cases need REAL `ch-client.ts` epoch fencing exercised
 * through `authedFetch`, not a harness reimplementation of it). Every field
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
   *  `lastResponse` capture and before `authedFetch`'s own post-fetch epoch
   *  check runs (plan §21 "stale response"). A test flips a shared epoch
   *  variable here to deterministically land the flip in that exact window,
   *  with no timing race. */
  onFetchResponse?: (resp: Response) => void;
}

/** Build a `ChCtx` bound to one `SpikeRequest`'s credential and origin, using
 * the real production `fetch` seam contract. `onFetch` is called once per
 * underlying fetch invocation (constructor/fetch-count invariants);
 * `onResponse` observes each settled `Response` (status/headers) — pure
 * instrumentation at the already-injected fetch boundary, not a second
 * request path: production's `RunQueryResult` doesn't surface headers to
 * `runQuery`'s caller, so this is how the harness reads them without
 * reimplementing `runQuery`'s own request/parsing logic. `hooks` (optional)
 * wires the real epoch/lifecycle seam (`CurrentCtxHooks`, above) — omitted
 * entirely preserves the exact previous behavior (no epoch hook, `refresh()`
 * always resolves false, `onSignedOut` a no-op). */
export function makeCurrentCtx(
  request: SpikeRequest,
  baseUrl: string,
  realFetch: typeof fetch,
  onFetch?: () => void,
  onResponse?: (resp: Response) => void,
  initialAuthConfirmed?: boolean,
  hooks?: CurrentCtxHooks,
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
 * but no spike fixture exercises) — `ch-client.ts`'s own `params` field has
 * no array-value concept at all, so the CURRENT adapter must pre-format an
 * array-valued native parameter into the exact wire string itself before
 * handing it to `runQuery`'s plain `Record<string, string|number>` params
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
 * `Record<string, string|number>` bag `ch-client.ts`'s `runQuery`/
 * `exportQuery` accept — settings ride as bare keys (matching the official
 * adapter's `clickhouse_settings`); native params are prefixed `param_`
 * here (the CURRENT side's own responsibility — see `formatNativeParamValue`'s
 * docstring for why the official side instead delegates this to the vendor
 * library); `role`/`sessionId` become the same `role`/`session_id` bare keys
 * the official client's own `toSearchParams` emits (array-valued `role` is
 * deliberately unsupported here — `ch-client.ts`'s params bag cannot repeat a
 * key, so every spike scenario exercising `role` uses a single string). */
function nativeParamsForCurrent(request: SpikeRequest): Record<string, string | number> {
  const out: Record<string, string | number> = { ...(request.settings || {}) };
  for (const [k, v] of Object.entries(request.params || {})) {
    out[`param_${k}`] = formatNativeParamValue(v);
  }
  if (typeof request.role === 'string') out.role = request.role;
  if (request.sessionId) out.session_id = request.sessionId;
  return out;
}

/** Run one `SpikeRequest` through the real production `runQuery`/`exportQuery`
 * functions, folding the result into the normalized `SpikeOutcome` vocabulary.
 * `hooks` (optional) wires `ChCtx`'s real epoch/lifecycle seam — see
 * `CurrentCtxHooks`. */
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
      const resp = await exportQuery(ctx, request.sql, {
        queryId: request.queryId,
        signal: request.signal,
        format: request.format === 'Table' || request.format === 'KPI' ? undefined : request.format,
        params: nativeParamsForCurrent(request),
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
      params: nativeParamsForCurrent(request),
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
