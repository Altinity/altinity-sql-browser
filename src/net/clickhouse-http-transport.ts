// Issue #585 Phase 1 — the current custom ClickHouse HTTP transport,
// re-seated behind the `ClickHouseTransport` contract (`clickhouse-transport.types.ts`).
// Issue #630 Phase 2 — this file is now a temporary COMPATIBILITY ADAPTER:
// `chUrl`/`ChUrlOpts`, the URL construction, and the direct injected
// `fetch()` invocation moved to `@altinity/clickhouse-http` (mechanically,
// behaviorally unchanged — see that package's `url.ts`/`client.ts`). `send()`
// below delegates to the package's `request()` instead of building the
// request itself.
//
// Issue #630 Phase 3 — this file is now SEND-ONLY. `streamLines()` (the
// progress-bearing JSON-lines read loop) moved to
// `@altinity/clickhouse-http`'s own `streamLines` — `ch-client.ts`'s
// `runQuery` (itself under `src/net/**`) calls the package function
// directly instead of going through this transport seam, so this adapter no
// longer has (or forwards to) a stream member at all. There is exactly one
// production stream implementation in the repository now — the package's;
// this file does not reintroduce a second one, forwarding or otherwise.
//
// Issue #630 Phase 6 — this adapter's one remaining production caller is
// `killQueryWithLease`'s frozen-lease bypass (`ch-client.ts`); the normal
// mutable-`ChCtx` request path moved to
// `src/net/authenticated-clickhouse-request.ts`, which builds the package
// client directly rather than through this adapter.
//
// Ownership boundary: this file may depend only on `src/core` and the
// `@altinity/clickhouse-http` public package export — never on
// `ch-client.ts`, `authenticated-clickhouse-request.ts`, `oauth.ts`,
// `oauth-config.ts`, `src/application/`, or `src/ui/`. `build/check-
// boundaries.mjs` enforces this mechanically.

import { createClickHouseHttpClient } from '@altinity/clickhouse-http';
import type { ClickHouseTransport, TransportDeps, TransportRequest } from './clickhouse-transport.types.js';

/** The current custom HTTP implementation of `ClickHouseTransport`. `deps`'
 * accessors are read per-request (REQUIRED-PURE — see the contract's doc
 * comment) so a live, mutable `origin`/`fetch` (e.g. `ConnectionSession`'s
 * `chCtx`, mutated in place on sign-in) is always observed at its current
 * value, never pinned to a stale snapshot (Adaptation A5). */
export function createHttpTransport(deps: TransportDeps): ClickHouseTransport {
  const client = createClickHouseHttpClient(deps);
  return {
    // Kept `async` even though its body is a single delegating call: this
    // exactly matches today's adapter-level settlement shape (a synchronous
    // preparation error, e.g. a URIError from URL encoding, must surface as
    // a REJECTED promise here too, never a synchronous throw out of
    // `send()`), and makes the compatibility intent explicit rather than
    // relying solely on the package implementation's own async-ness.
    async send(request: TransportRequest): Promise<Response> {
      return client.request(request);
    },
  };
}
