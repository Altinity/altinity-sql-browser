// Issue #630 Phase 6 — the sole SQL Browser authenticated-request authority:
// credential acquisition, epoch fencing, one-refresh retry, and
// connect/offline/sign-out lifecycle classification, composed directly around
// the package's `createClickHouseHttpClient(...).request()` and its response
// consumers (`consumeJsonResponse`/`consumeTextResponse`/
// `consumeProgressResponse`). This module is the moved trust-boundary logic
// that used to live as `authedFetch`/`transportFor(ctx)` inside
// `src/net/ch-client.ts` — mechanically unchanged behavior, new owner and new
// file (see that file's own module doc for the ownership-history trail).
//
// `AuthenticatedRequestCtx` is a NARROW base seam: it owns only the fields
// this module actually reads (credentials, epoch, lifecycle callbacks). SQL
// Browser's own product `ChCtx` (`ch-client.ts`) extends it with
// `dataLakeCatalogSettingUnsupported`, a product-operation latch this module
// has no business knowing about — keeping this file the auth authority
// without also becoming the product-client context.
//
// Scope discipline mirrors the package's own (client.ts's header comment):
// this module still does not call `client.queryJson`/`queryText`/
// `queryProgress` — those convenience methods build a request from an
// ALREADY-RESOLVED Authorization and give this layer no chance to inspect
// the settled `Response` before deciding whether a refresh/retry is
// authorized. Instead, `authenticatedRequest` performs the trust-boundary
// loop itself around the low-level `client.request()`, and the three thin
// wrappers below (`authenticatedJson`/`authenticatedText`/
// `authenticatedProgress`) each compose it with exactly one matching package
// response consumer — mirroring `client.ts`'s own queryJson/queryText/
// queryProgress shape one layer up, over an authenticated `Response` instead
// of a directly-resolved one.

import {
  createClickHouseHttpClient, chUrl, parseExceptionText,
  consumeJsonResponse, consumeTextResponse, consumeProgressResponse,
} from '@altinity/clickhouse-http';
import type { ClickHouseHttpRequest, StreamCallbacks } from '@altinity/clickhouse-http';
import { isAuthExpiredBody, authDeniedMessage } from '../core/stream.js';

/** The narrow side-effect seam this module needs: credential acquisition,
 *  refresh, sign-out, and the epoch/lifecycle hooks that let a superseded
 *  (stale) request's late settlement leave the replacement session's state
 *  untouched. `authHeader`/`authConfirmed`/`currentEpoch`/
 *  `onTransportConnected`/`onTransportOffline` are optional, preserving the
 *  smaller seam existing callers that omit them already use — a client that
 *  supplies no epoch hook is backward-compatible: every request is current. */
export interface AuthenticatedRequestCtx {
  fetch: typeof fetch;
  origin: string;
  getToken(): Promise<string | null>;
  refresh(): Promise<boolean>;
  onSignedOut(detail?: string, expectedEpoch?: number): void;
  /** Picks the Authorization scheme (Bearer vs Basic); defaults to Bearer
   * inside `authenticatedRequest` when absent. */
  authHeader?: (token: string) => string;
  authConfirmed?: boolean;
  /** Identifies the active credential/session generation. A request captures
   * this before its first await so stale work cannot affect its replacement. */
  currentEpoch?: () => number;
  /** Receives a current request's successful HTTP 2xx transport settlement. */
  onTransportConnected?: () => void;
  /** Receives a current non-abort rejection from the injected fetch seam. */
  onTransportOffline?: (error?: unknown) => void;
}

/** One ClickHouse HTTP request with NO caller-supplied `authorization` — this
 *  module resolves the complete Authorization header for THIS request (and
 *  its at-most-one retry) itself, per attempt. Structurally prevents an
 *  ordinary caller from supplying or caching a value this module must
 *  recompute. */
export type AuthenticatedClickHouseRequest = Omit<ClickHouseHttpRequest, 'authorization'>;

// A client that supplied no epoch hook remains backward-compatible: every
// request is current. When it did supply one, no stale request may alter the
// replacement credential generation's lifecycle/auth state.
function isCurrentEpoch(ctx: AuthenticatedRequestCtx, requestEpoch: number | undefined): boolean {
  return requestEpoch === undefined || ctx.currentEpoch?.() === requestEpoch;
}

// A request that was superseded before it can start (or retry) is cancellation,
// not an authentication failure. Keep the shape callers already treat as a
// silent cancellation without coupling this network module to a DOMException
// implementation.
function staleEpochAbort(): Error {
  const error = new Error('request superseded by a newer authentication session');
  error.name = 'AbortError';
  return error;
}

/**
 * POST `request.sql` to ClickHouse with one automatic token-refresh retry.
 * Resolves to the raw Response. Throws Error('signed out') after calling
 * ctx.onSignedOut() when authentication cannot be recovered. `request` omits
 * `authorization` — this function resolves the credential for THIS request
 * (and its retry) itself; every other field is the caller's request,
 * unchanged.
 */
export async function authenticatedRequest(
  ctx: AuthenticatedRequestCtx,
  request: AuthenticatedClickHouseRequest,
): Promise<Response> {
  const requestEpoch = ctx.currentEpoch?.();
  // Centralized aliasing defense: snapshot the incoming request's
  // settings/params synchronously HERE, at entry, before the first await
  // (`ctx.getToken()`) — one mechanism for every present and future caller,
  // rather than per-call-site defensive spreads. This preserves invocation-
  // time capture (`chUrl` serializes both records into the URL string
  // synchronously, before this function's first await), so a caller that
  // retains and mutates either record while a token/refresh await is pending
  // cannot change the request this function already committed to sending —
  // on the initial attempt AND the one-refresh retry alike.
  const settings = request.settings ? { ...request.settings } : undefined;
  const params = request.params ? { ...request.params } : undefined;
  const { sql, defaultFormat, signal } = request;
  // Request-preparation failures are not transport failures. Every caller
  // resolves its credential (this function's next line) only after this
  // synchronous, discarded `chUrl` validation — so a URIError from malformed
  // settings/params (e.g. `encodeURIComponent` on a lone UTF-16 surrogate)
  // propagates as a synchronous throw with no token read, no fetch, and no
  // `onTransportOffline` call. The package's `client.request()` builds this
  // same URL again at actual send time (against the possibly-since-mutated
  // live `ctx.origin`) and resolves that failure as a REJECTED promise
  // instead, since it is async — so without this eager pre-credential
  // preflight, the identical throw would surface only after `ctx.getToken()`
  // and would be misclassified as a network failure.
  chUrl(ctx.origin, { format: defaultFormat, extra: settings, params });
  const token = await ctx.getToken();
  // getToken may have awaited a sign-in/sign-out replacement. Its credential
  // belongs to that replacement and this request must not send it.
  if (!isCurrentEpoch(ctx, requestEpoch)) throw staleEpochAbort();
  if (!token) {
    ctx.onSignedOut(undefined, requestEpoch);
    throw new Error('not signed in');
  }
  let bearer = token;
  let attempt = 0;
  // ctx.authHeader(token) lets the app pick the scheme (Bearer vs Basic);
  // default to Bearer so the seam stays optional.
  const authHeader = ctx.authHeader || ((t: string) => 'Bearer ' + t);
  // Built once per `authenticatedRequest` invocation, before the retry loop,
  // from LIVE accessors (never snapshotted values) — a live, mutable
  // `ctx.origin`/`ctx.fetch` (mutated in place on sign-in, e.g.
  // `connection-session.ts`) stays authoritative across the whole retry
  // cycle, not just the first attempt.
  const client = createClickHouseHttpClient({ fetch: () => ctx.fetch, origin: () => ctx.origin });
  for (;;) {
    let resp: Response;
    try {
      // Fence every attempt immediately before the injected side effect. A
      // retry must never send a replacement session's newly-read credential.
      // (Precision: `client.request` internally evaluates its own
      // `origin()`/`fetch()` accessors and builds the URL AFTER this fence,
      // immediately before the fetch itself — both accessors are required to
      // be plain, synchronous, side-effect-free property reads, matching the
      // package's own `ClickHouseHttpClientDeps` contract.)
      const authorization = authHeader(bearer);
      if (!isCurrentEpoch(ctx, requestEpoch)) throw staleEpochAbort();
      resp = await client.request({ sql, defaultFormat, settings, params, authorization, signal });
    } catch (e) {
      // Only a rejected fetch is a transport failure. HTTP failures are normal
      // responses and caller cancellation is deliberately invisible here.
      const aborted = signal?.aborted || (e as { name?: unknown } | null)?.name === 'AbortError';
      if (isCurrentEpoch(ctx, requestEpoch) && !aborted) ctx.onTransportOffline?.(e);
      throw e;
    }
    // The request may have crossed a sign-in/sign-out boundary while fetch was
    // pending. Its response still belongs to its caller, but cannot change the
    // new epoch's connection/auth state or start a refresh with its token.
    if (!isCurrentEpoch(ctx, requestEpoch)) return resp;
    // A 2xx confirms the credentials are good for the rest of the session.
    if (resp.ok) {
      ctx.authConfirmed = true;
      ctx.onTransportConnected?.();
    }
    let authExpired = resp.status === 401 || resp.status === 403;
    if (!authExpired && !resp.ok) {
      const peek = await resp.clone().text();
      // Reading an error body is another async boundary. If this request was
      // superseded while it was pending, its expiry marker must not start a
      // refresh against the replacement session's credentials.
      if (!isCurrentEpoch(ctx, requestEpoch)) return resp;
      if (isAuthExpiredBody(peek)) authExpired = true;
    }
    if (authExpired) {
      // Once this session has authenticated successfully, the same credentials
      // are still valid — so a later 401/403 is a *query-level* error ClickHouse
      // maps to that HTTP status (ACCESS_DENIED, or UNKNOWN_USER from e.g.
      // `SHOW CREATE USER <missing>`), not a sign-in problem. Return it so the
      // caller shows it as a normal query error instead of force-logging-out.
      if (ctx.authConfirmed) return resp;
      if (attempt === 0 && (await ctx.refresh())) {
        if (!isCurrentEpoch(ctx, requestEpoch)) throw staleEpochAbort();
        // A successful refresh always yields a fresh, usable token — the
        // refresh() contract this seam relies on.
        bearer = (await ctx.getToken())!;
        if (!isCurrentEpoch(ctx, requestEpoch)) throw staleEpochAbort();
        attempt++;
        continue;
      }
      if (!isCurrentEpoch(ctx, requestEpoch)) return resp;
      // First-contact 401/403 with a non-expired token: CH rejected the login
      // itself — an authorization/identity problem, not session expiry. Surface
      // CH's own reason so it's diagnosable.
      const reason = parseExceptionText(await resp.clone().text());
      if (!isCurrentEpoch(ctx, requestEpoch)) return resp;
      ctx.onSignedOut(authDeniedMessage(resp.status, reason), requestEpoch);
      throw new Error('signed out');
    }
    return resp;
  }
}

/** One `authenticatedRequest()` + the package's `consumeJsonResponse()`.
 *  Throws the package's `ClickHouseError` on a resolved non-2xx response;
 *  native JSON/network/abort errors propagate unchanged. */
export async function authenticatedJson<T>(
  ctx: AuthenticatedRequestCtx,
  request: AuthenticatedClickHouseRequest,
): Promise<T> {
  return consumeJsonResponse<T>(await authenticatedRequest(ctx, request));
}

/** One `authenticatedRequest()` + the package's `consumeTextResponse()`. */
export async function authenticatedText(
  ctx: AuthenticatedRequestCtx,
  request: AuthenticatedClickHouseRequest,
): Promise<string> {
  return consumeTextResponse(await authenticatedRequest(ctx, request));
}

/** One `authenticatedRequest()` + the package's `consumeProgressResponse()` —
 *  drives the authenticated response's body through the package's ONE
 *  progress-stream read loop, with the caller's original `AbortSignal`
 *  (passed into `authenticatedRequest` above, never a derived controller)
 *  still governing the whole response lifetime including body streaming. */
export async function authenticatedProgress(
  ctx: AuthenticatedRequestCtx,
  request: AuthenticatedClickHouseRequest,
  callbacks?: StreamCallbacks,
): Promise<Response> {
  return consumeProgressResponse(await authenticatedRequest(ctx, request), callbacks);
}
