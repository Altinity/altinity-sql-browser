// Issue #630 Phase 2 — the low-level package client: request construction +
// one injected Fetch invocation. Moved (behaviorally unchanged) from
// `createHttpTransport`'s `send()` in `src/net/clickhouse-http-transport.ts`,
// which now delegates here through this package's public export instead of
// building the URL / calling `deps.fetch()` itself.
//
// Scope discipline (Phase 2 plan §7): no retries, no response-status
// inspection, no body access, no Authorization parsing/storage, no
// controller/signal bridging. `request()` resolves to the exact native
// `Response` Fetch returns — never a clone or wrapper — and every accessor
// is read live, per request, never snapshotted at construction time.
//
// Issue #630 Phase 4 — adds convenience query methods (`queryJson`/
// `queryText`/`queryProgress`) composed around the unchanged `request()`
// above, plus a stateless `killQuery`. Every convenience method has the
// same visible two-step shape: one `client.request(...)` call, then one
// matching `response.ts` consumer — no retry, no second Fetch, no SQL
// Browser Table/KPI/TSV mode knowledge (a literal `defaultFormat` string is
// opaque wire data to this package). `killQuery` requires the caller's own
// `authorization` and performs no credential lookup, refresh, epoch,
// lifecycle callback, retry, or query registry of its own — see the
// private `quoteKillQueryId` below for its intentionally narrow, Phase-4-
// only string-literal quoting.

import { chUrl } from './url.js';
import { consumeJsonResponse, consumeTextResponse, consumeProgressResponse } from './response.js';
import type { StreamCallbacks } from './progress-stream.js';

/** Accessor-shaped dependencies: both must be read live, per request — a
 * live, mutable `origin`/`fetch` (e.g. the SQL Browser's `ChCtx`, mutated in
 * place on sign-in) must always be observed at its CURRENT value, never a
 * value pinned at construction time. */
export interface ClickHouseHttpClientDeps {
  fetch(): typeof fetch;
  origin(): string;
}

/** One ClickHouse HTTP request, fully specified. No client-level defaults:
 * `authorization` is the complete header value (scheme + credential),
 * resolved by the caller for THIS request. */
export interface ClickHouseHttpRequest {
  /** Opaque SQL text — never parsed, rewritten, or appended to. */
  sql: string;
  /** Exact ClickHouse format name sent as `default_format`. */
  defaultFormat: string;
  /** HTTP query-string settings. */
  settings?: Record<string, string | number>;
  /** Query-string params riding alongside (native `param_*`, `query_id`,
   * `session_id`, `role`, …). */
  params?: Record<string, string | number>;
  /** Complete Authorization header value. Never optional, never defaulted. */
  authorization: string;
  signal?: AbortSignal;
}

/** `queryJson`'s request shape: identical to `ClickHouseHttpRequest` except
 *  `defaultFormat` is OPTIONAL — omitting it (leaving it `undefined`) means
 *  "default to JSON"; an explicit value, including `''`, is passed through
 *  unchanged into the composed `ClickHouseHttpRequest` (`queryJson` defaults
 *  with `??`, never `||`). This guarantee ends at `request()`'s own
 *  boundary: `chUrl` (package-owned, Phase 1/2) separately falls back on ANY
 *  falsy `format` — including `''` — to its own default when it serializes
 *  the final URL, so a `''` value still reaches the wire as `chUrl`'s
 *  default, not as `''`. */
export type ClickHouseJsonRequest = Omit<ClickHouseHttpRequest, 'defaultFormat'> & {
  defaultFormat?: string;
};

/** `killQuery`'s request shape: every `ClickHouseHttpRequest` field except
 *  `sql` (killQuery builds its own `KILL QUERY` SQL) and `defaultFormat`
 *  (fixed to `'JSON'`), plus the target `queryId` to quote into that SQL's
 *  `WHERE query_id = ...` predicate. `queryId` is never automatically
 *  written into `params.query_id` — an explicit `params.query_id` (the HTTP
 *  request's own query id) and `queryId` (the SQL target) are deliberately
 *  independent values. */
export type ClickHouseKillQueryRequest = Omit<ClickHouseHttpRequest, 'sql' | 'defaultFormat'> & {
  queryId: string;
};

export interface ClickHouseHttpClient {
  /** POST one query; resolves with the NATIVE fetch `Response` (never a
   * clone/wrapper) at HTTP settlement — HTTP error statuses resolve; only
   * network I/O failure / abort rejects the returned promise natively.
   * Exactly one Fetch invocation per call; no retry.
   *
   * `request` is `async` on purpose even though its body has no `await`
   * before the network call: a synchronous serializer failure (`chUrl`
   * throwing `URIError` on an unencodable value) must surface as a REJECTED
   * promise, matching the compatibility adapter's existing async `send()`
   * settlement shape — never a synchronous throw out of this function. */
  request(request: ClickHouseHttpRequest): Promise<Response>;

  /** One `request()` + `consumeJsonResponse()`. `defaultFormat` defaults to
   *  `'JSON'` only when omitted (`undefined`) — an explicit format,
   *  including `''`, is preserved into the `ClickHouseHttpRequest` this
   *  method composes and passes to `request()`. It is NOT a wire-level
   *  guarantee: `chUrl` still applies its own falsy fallback when it builds
   *  the final URL, so an explicit `''` reaches ClickHouse as `chUrl`'s
   *  default format, never as `''`. Throws `ClickHouseError` on a resolved
   *  non-2xx response; native network/abort/body errors propagate
   *  unchanged. */
  queryJson<T>(request: ClickHouseJsonRequest): Promise<T>;

  /** One `request()` + `consumeTextResponse()`. `defaultFormat` is required
   *  — this method applies no default and no SQL Browser mode mapping. */
  queryText(request: ClickHouseHttpRequest): Promise<string>;

  /** One `request()` + `consumeProgressResponse()`. `defaultFormat` is
   *  required, exactly as `queryText`. Resolves with the same `Response`
   *  after its stream has been fully consumed through `streamLines`. */
  queryProgress(request: ClickHouseHttpRequest, callbacks?: StreamCallbacks): Promise<Response>;

  /** Stateless wire-level `KILL QUERY ... ASYNC`, built from exactly one
   *  `queryText()` call (one `request()` + one `consumeTextResponse()`).
   *  Requires the caller's own `authorization`; performs no credential
   *  lookup, refresh, epoch handling, lifecycle callback, retry, or query
   *  registry — every invocation is independent. */
  killQuery(request: ClickHouseKillQueryRequest): Promise<void>;
}

// Issue #630 Phase 4 — the intentionally narrow, PRIVATE Phase-4 stopgap for
// quoting `queryId` into a `KILL QUERY` string literal. Reproduces ONLY
// `src/core/format.ts`'s `sqlString()` escaping convention (backslash
// doubled first, then single quote doubled) — not exported, and
// deliberately not generalized into identifier/type-expression quoting:
// Phase 5 replaces this with the package's own shared public string-literal
// API.
function quoteKillQueryId(queryId: string): string {
  return "'" + queryId.replace(/\\/g, '\\\\').replace(/'/g, "''") + "'";
}

export function createClickHouseHttpClient(deps: ClickHouseHttpClientDeps): ClickHouseHttpClient {
  // A lexical `client` object (not `this`) so every convenience method below
  // calls `client.request(...)` regardless of how it is later destructured
  // or rebound by a caller.
  const client: ClickHouseHttpClient = {
    async request(request: ClickHouseHttpRequest): Promise<Response> {
      const url = chUrl(deps.origin(), {
        format: request.defaultFormat,
        extra: request.settings,
        params: request.params,
      });
      return deps.fetch()(url, {
        method: 'POST',
        body: request.sql,
        headers: { Authorization: request.authorization },
        signal: request.signal,
      });
    },

    async queryJson<T>(request: ClickHouseJsonRequest): Promise<T> {
      const response = await client.request({
        ...request,
        defaultFormat: request.defaultFormat ?? 'JSON',
      });
      return consumeJsonResponse<T>(response);
    },

    async queryText(request: ClickHouseHttpRequest): Promise<string> {
      const response = await client.request(request);
      return consumeTextResponse(response);
    },

    async queryProgress(request: ClickHouseHttpRequest, callbacks?: StreamCallbacks): Promise<Response> {
      const response = await client.request(request);
      return consumeProgressResponse(response, callbacks);
    },

    async killQuery({ queryId, ...request }: ClickHouseKillQueryRequest): Promise<void> {
      await client.queryText({
        ...request,
        sql: `KILL QUERY WHERE query_id = ${quoteKillQueryId(queryId)} ASYNC`,
        defaultFormat: 'JSON',
      });
    },
  };
  return client;
}
