// Issue #585 Phase 1 — the current custom ClickHouse HTTP transport,
// re-seated behind the `ClickHouseTransport` contract (`clickhouse-transport.types.ts`).
// This is a pure move: `chUrl` (+ its `ChUrlOpts` parameter type) and the
// progress-line stream-read loop are relocated here verbatim from
// `ch-client.ts`, which re-imports/re-exports both so every existing importer
// keeps resolving. No behavior change; no product SQL; no auth/lifecycle
// policy (that stays app-side in `ch-client.ts`'s `authedFetch`).
//
// Ownership boundary: this file may depend only on `src/core` — never on
// `ch-client.ts`, `oauth.ts`, `oauth-config.ts`, `src/application/`, or
// `src/ui/`. `build/check-boundaries.mjs` enforces this mechanically.

import type { ClickHouseTransport, StreamCallbacks, TransportDeps, TransportRequest } from './clickhouse-transport.types.js';
import type { StreamLine } from '../core/stream.js';

/** `chUrl`'s query-string options. */
export interface ChUrlOpts {
  format?: string;
  extra?: Record<string, string | number>;
  params?: Record<string, string | number>;
}

/** Build a ClickHouse HTTP URL with query-string options. Pure. */
export function chUrl(origin: string, opts: ChUrlOpts = {}): string {
  const format = opts.format || 'JSONStringsEachRowWithProgress';
  let url = origin + '?default_format=' + format + '&enable_http_compression=1';
  for (const [k, v] of Object.entries(opts.extra || {})) {
    url += '&' + k + '=' + encodeURIComponent(v);
  }
  for (const [k, v] of Object.entries(opts.params || {})) {
    url += '&' + k + '=' + encodeURIComponent(v);
  }
  return url;
}

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
  return {
    async send(request: TransportRequest): Promise<Response> {
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
    streamLines,
  };
}
