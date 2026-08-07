// Issue #585 Phase 1 — the narrow SQL Browser ClickHouse-transport contract.
// Type-only (ADR-0002 phase-0 convention for seam contracts, hence the
// `.types.ts` suffix rather than the issue's suggested `clickhouse-transport.ts`
// — "exact names may follow repository conventions" per the issue). Puts the
// CURRENT custom HTTP implementation behind a contract a future official
// transport (gated on a new decision — ADR-0005 is Rejected) could also
// satisfy, without moving any product SQL or auth/lifecycle policy here.
//
// Issue #630 Phase 2 — `TransportDeps`/`TransportRequest` are now ALIASES of
// the low-level request/dependency types owned by `@altinity/clickhouse-http`
// (see that package's `client.ts`), not separate shapes: the package is the
// single source of truth for the low-level request boundary. `ClickHouseTransport`
// itself stays here — Phase 2 still has the SQL-Browser-local `streamLines`
// method, deferred to Phase 3.
//
// Ownership boundary: this file (and its implementation,
// `clickhouse-http-transport.ts`) may depend only on `src/core` (the narrow
// `StreamLine` type) and the `@altinity/clickhouse-http` public package export
// — never on `ch-client.ts`, `oauth.ts`, `oauth-config.ts`, `src/application/`,
// or `src/ui/`, even type-only. `build/check-boundaries.mjs` enforces this
// mechanically (twin `RULES` entries for this file and the implementation file).

import type { ClickHouseHttpClientDeps, ClickHouseHttpRequest } from '@altinity/clickhouse-http';
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
export type TransportDeps = ClickHouseHttpClientDeps;

/** One ClickHouse HTTP request, fully specified. No client-level defaults
 * exist: `authorization` is the complete header value (scheme + credential),
 * resolved by the caller (SQL Browser auth policy) for THIS request.
 *
 * Field-level docs (moved to `@altinity/clickhouse-http`'s `client.ts`):
 * `sql` is opaque (never parsed/rewritten/appended to — hard invariant 16:
 * an authored FORMAT clause always wins over `defaultFormat` server-side);
 * `settings`/`params` are today's exact wire vocabulary, unchanged
 * (Adaptation A2); `authorization` is never optional or defaulted. */
export type TransportRequest = ClickHouseHttpRequest;

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
   * body consumption. HTTP error statuses resolve normally (they are
   * responses); network I/O failure / abort rejects the returned promise
   * natively. Since #630 Phase 2, `send` is implemented by delegating to
   * `@altinity/clickhouse-http`'s async `request()`, which itself builds the
   * request URL — so a REQUEST-PREPARATION failure (e.g. a `URIError` from
   * malformed `settings`/`params`) also surfaces as a rejected promise here,
   * not a synchronous throw. The transport performs no error classification
   * or wrapping of either failure kind — that policy distinction is made by
   * the caller (`ch-client.ts`'s `authedFetch`), not here. */
  send(request: TransportRequest): Promise<Response>;
  /** Supported-stream mechanics for the progress-bearing JSON-lines formats:
   * drives the read loop (decode, line split, JSON.parse, trailing-buffer
   * flush, malformed-line skip), invoking onLine per parsed object and
   * onChunk per network chunk — byte-for-byte the loop currently inlined in
   * runQuery. Consuming a body is a caller decision made AFTER policy has
   * classified the settled response. */
  streamLines(body: ReadableStream<Uint8Array>, cbs: StreamCallbacks): Promise<void>;
}
