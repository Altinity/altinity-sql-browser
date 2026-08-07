// Issue #630 Phase 3 — the canonical progress-bearing JSON-lines read loop
// (ClickHouse's JSONStringsEachRowWithProgress / JSONEachRowWithProgress wire
// format), moved verbatim from `src/net/clickhouse-http-transport.ts`'s
// former `streamLines()` (mechanically/behaviorally unchanged — see that
// file's Phase 2/3 comments). This is the ONE production implementation of
// the read loop (contract A6): decode, line split, JSON.parse, trailing-
// buffer flush, malformed-line skip, one `onLine` per parsed object, one
// `onChunk` per network chunk.
//
// Scope discipline (Phase 3 plan §5.2): no result normalization (no
// StreamResult/row-caps/percentages — that stays SQL-Browser-owned in
// `src/core/stream.ts`'s `applyStreamLine`), no wrapping of a reader
// rejection (the exact rejection object must escape), no package-owned
// AbortController/derived signal/cancellation registry, no fatal decoder, no
// extra flush call beyond what the original loop already performed.

/** One column header, as reported by a `{meta}` line. Left open
 *  (`[key: string]: unknown`) — this is the wire shape, not a SQL Browser
 *  result-policy type. */
export interface ProgressMetaColumn {
  name: string;
  type: string;
  [key: string]: unknown;
}

/** One line of ClickHouse's progress-bearing JSON-lines wire format. A
 *  parsed line carries at most one of `meta`/`row`/`progress`/`exception` —
 *  callers narrow the particular shape they need; this type only describes
 *  what the wire can send. */
export interface StreamLine {
  meta?: ProgressMetaColumn[];
  row?: Record<string, unknown>;
  progress?: {
    total_rows_to_read?: unknown;
    read_rows?: unknown;
    read_bytes?: unknown;
    elapsed_ns?: unknown;
  };
  exception?: string;
  [key: string]: unknown;
}

/** Callbacks driving `streamLines`' read loop. `onLine` fires synchronously,
 *  in order, for every successfully parsed complete line; `onChunk` fires
 *  exactly once per successful `reader.read()` chunk, after every `onLine`
 *  call that chunk produced. */
export interface StreamCallbacks {
  onLine?: (line: StreamLine) => void;
  onChunk?: () => void;
}

/**
 * Drive the progress-bearing JSON-lines read loop over `body`: decode, line
 * split, `JSON.parse` per line, trailing-buffer flush, malformed-line skip —
 * byte-for-byte the loop formerly inlined in `runQuery` (Phase 1) and then
 * moved to `createHttpTransport` (Phase 1/2) before this move. `onLine` fires
 * per parsed object; `onChunk` fires once per network chunk, after that
 * chunk's `onLine` calls. A single `TextDecoder` used with `{ stream: true }`
 * for the whole body (not per-chunk) so a multi-byte UTF-8 character split
 * across two byte chunks still decodes correctly.
 *
 * A reader rejection (including an aborted signal's `AbortError`) propagates
 * unmodified — this function performs no try/catch around `reader.read()`,
 * so the exact rejection object the native reader produced is what rejects
 * this promise, and the loop simply stops (no further callbacks).
 */
export async function streamLines(body: ReadableStream<Uint8Array>, cbs: StreamCallbacks): Promise<void> {
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
