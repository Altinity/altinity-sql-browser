// Issue #585 Phase 1 — the current custom ClickHouse HTTP transport,
// re-seated behind the `ClickHouseTransport` contract (`clickhouse-transport.types.ts`).
// Issue #630 Phase 2 — this file is now a temporary COMPATIBILITY ADAPTER:
// `chUrl`/`ChUrlOpts`, the URL construction, and the direct injected
// `fetch()` invocation moved to `@altinity/clickhouse-http` (mechanically,
// behaviorally unchanged — see that package's `url.ts`/`client.ts`). `send()`
// below delegates to the package's `request()` instead of building the
// request itself. `streamLines()` (the progress-bearing JSON-lines read
// loop) stays local until Phase 3 — stream decoding is explicitly deferred.
//
// Ownership boundary: this file may depend only on `src/core` and the
// `@altinity/clickhouse-http` public package export — never on
// `ch-client.ts`, `oauth.ts`, `oauth-config.ts`, `src/application/`, or
// `src/ui/`. `build/check-boundaries.mjs` enforces this mechanically.

import { createClickHouseHttpClient } from '@altinity/clickhouse-http';
import type { ClickHouseTransport, StreamCallbacks, TransportDeps, TransportRequest } from './clickhouse-transport.types.js';
import type { StreamLine } from '../core/stream.js';

/** Drives the progress-bearing JSON-lines read loop: decode, line split,
 * `JSON.parse` per line, trailing-buffer flush, malformed-line skip —
 * byte-for-byte the loop formerly inlined in `runQuery`. `onLine` fires per
 * parsed object, `onChunk` once per network chunk. A single `TextDecoder`
 * used with `{ stream: true }` for the whole body (not per-chunk) so a
 * multi-byte UTF-8 character split across two byte chunks still decodes
 * correctly. */
async function streamLines(body: ReadableStream<Uint8Array>, cbs: StreamCallbacks): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines[lines.length - 1];
    for (const line of lines.slice(0, -1)) {
      if (!line) continue;
      let json: StreamLine;
      try {
        json = JSON.parse(line);
      } catch {
        continue;
      }
      cbs.onLine && cbs.onLine(json);
    }
    cbs.onChunk && cbs.onChunk();
  }
  if (buffer.trim()) {
    try {
      cbs.onLine && cbs.onLine(JSON.parse(buffer));
    } catch {
      /* trailing partial line */
    }
  }
}

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
    streamLines,
  };
}
