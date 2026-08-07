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

import { chUrl } from './url.js';

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
}

export function createClickHouseHttpClient(deps: ClickHouseHttpClientDeps): ClickHouseHttpClient {
  return {
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
  };
}
