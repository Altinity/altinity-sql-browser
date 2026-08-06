// Issue #585 Phase 1 — the narrow SQL Browser ClickHouse-transport contract.
// Type-only (ADR-0002 phase-0 convention for seam contracts, hence the
// `.types.ts` suffix rather than the issue's suggested `clickhouse-transport.ts`
// — "exact names may follow repository conventions" per the issue). Puts the
// CURRENT custom HTTP implementation behind a contract a future official
// transport (Phase 2, gated on a new decision — ADR-0005 is Rejected) could
// also satisfy, without moving any product SQL or auth/lifecycle policy here.
//
// Ownership boundary: this file (and its implementation,
// `clickhouse-http-transport.ts`) may depend only on `src/core` (the narrow
// `StreamLine` type) — never on `ch-client.ts`, `oauth.ts`, `oauth-config.ts`,
// `src/application/`, or `src/ui/`, even type-only. `build/check-boundaries.mjs`
// enforces this mechanically (twin `RULES` entries for this file and the
// implementation file).

import type { StreamLine } from '../core/stream.js';

/** What the transport is allowed to see of the environment. Deliberately
 * excludes tokens, refresh, epochs, lifecycle callbacks: a transport
 * implementation is compile-time incapable of ACQUIRING credentials or
 * signaling lifecycle. (It still receives the resolved Authorization header
 * per request — Adaptation A6 — so single-send/no-retry/no-caching discipline
 * is contract- and test-enforced, not compiler-enforced.) Accessors, not
 * snapshots — the live chCtx's origin is mutated in place on sign-in and the
 * transport must observe the current value per request.
 *
 * REQUIRED-PURE: both accessors must be synchronous, side-effect-free plain
 * property reads (production: `() => ctx.fetch` / `() => ctx.origin`). This
 * matters because `send` evaluates them AFTER `authedFetch`'s final epoch
 * fence and before the fetch itself; the type system cannot express purity,
 * so — exactly like A6's single-send discipline — this rule is enforced by
 * this doc comment and review, not by the compiler or the existing epoch
 * race test (whose proof stops at the `send` invocation boundary). */
export interface TransportDeps {
  fetch(): typeof fetch;
  origin(): string;
}

/** One ClickHouse HTTP request, fully specified. No client-level defaults
 * exist: `authorization` is the complete header value (scheme + credential),
 * resolved by the caller (SQL Browser auth policy) for THIS request. */
export interface TransportRequest {
  /** Opaque SQL text. The transport never parses, rewrites, or appends to it
   * (hard invariant 16: an authored FORMAT clause always wins over
   * `defaultFormat` server-side, exactly as today). */
  sql: string;
  /** Exact ClickHouse format name sent as `default_format`. */
  defaultFormat: string;
  /** HTTP query-string settings (wait_end_of_query, max_result_rows,
   * result_overflow_mode, add_http_cors_header, readonly, …) — the caller's
   * policy decides which; the transport only serializes. */
  settings?: Record<string, string | number>;
  /** Query-string params riding alongside: native `param_*` parameters,
   * `query_id`, `session_id`, `role` — today's exact wire vocabulary,
   * unchanged (Adaptation A2). */
  params?: Record<string, string | number>;
  /** Complete Authorization header value. Never optional, never defaulted. */
  authorization: string;
  signal?: AbortSignal;
}

// No TransportResponse type in Phase 1 (Adaptation A3): `send` resolves with
// the NATIVE fetch `Response`. A structural subset would be assignable only in
// the direction Response -> subset, so authedFetch/exportQuery could not keep
// their `Promise<Response>` signatures without an unsafe cast. Native Response
// gives raw bytes (`body`, hard invariant 17) and `clone()` for authedFetch's
// non-destructive error-body peek for free.

/** Callbacks driving `streamLines`' progress-bearing JSON-lines read loop. */
export interface StreamCallbacks {
  onLine?: (line: StreamLine) => void;
  onChunk?: () => void;
}

/** The SQL Browser transport contract. In Phase 1 exactly one implementation
 * exists (`createHttpTransport`, `clickhouse-http-transport.ts`); a Phase 2
 * official-client implementation (does not proceed without a new decision)
 * would satisfy the same contract. */
export interface ClickHouseTransport {
  /** POST one query; resolves at HTTP settlement (headers received) with the
   * NATIVE fetch `Response` — Phase 1 defines no adapter-owned response type
   * (Adaptation A3), which is what preserves `authedFetch`/`exportQuery`'s
   * `Promise<Response>` signatures and `export-service.ts`'s
   * `streamToFile(resp: Response, …)` consumer without casts. Exactly one
   * fetch invocation (contract-suite-asserted, incl. on non-2xx — A6); no
   * retry, no token read, no lifecycle callback, no error classification, no
   * body consumption. HTTP error statuses resolve (they are responses); only
   * network I/O failure / abort rejects. */
  send(request: TransportRequest): Promise<Response>;
  /** Supported-stream mechanics for the progress-bearing JSON-lines formats:
   * drives the read loop (decode, line split, JSON.parse, trailing-buffer
   * flush, malformed-line skip), invoking onLine per parsed object and
   * onChunk per network chunk — byte-for-byte the loop currently inlined in
   * runQuery. Consuming a body is a caller decision made AFTER policy has
   * classified the settled response. */
  streamLines(body: ReadableStream<Uint8Array>, cbs: StreamCallbacks): Promise<void>;
}
