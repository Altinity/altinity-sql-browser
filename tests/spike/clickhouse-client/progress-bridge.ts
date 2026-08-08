// Phase 0 / issue #585 — the "narrow progress bridge" plan §16 allows only if
// `exec()` is the chosen path for `JSONStringsEachRowWithProgress` (proven
// NOT publicly supported by `query()` in installed 1.23.1 — see
// `format-type-probe.ts`). This bridge does EXACTLY what plan §16 permits and
// nothing more:
//   * incrementally decode this one newline-delimited UTF-8 JSON format;
//   * retain an incomplete line between chunks;
//   * parse complete JSON records;
//   * emit `StreamLine` values (the canonical progress-line wire type,
//     `@altinity/clickhouse-http`'s own — #630 Phase 3);
//   * surface in-band exceptions;
//   * reproduce current malformed/truncated handling.
// It must NOT perform result normalization, parse arbitrary formats, consume
// exports, or become a second general client — it is reused verbatim by the
// official-side Table adapter, and its physical/transformed line counts are
// measured separately (plan §16 "Bridge size") for the ADR's deletion
// estimate.
//
// Issue #630 Phase 3 — this bridge used to reuse `core/stream.ts`'s own
// `splitBuffer` (the exact buffering rule `ch-client.ts`'s `runQuery`
// streaming branch applied inline) so its line-splitting was provably the
// SAME behavior, not an independent reimplementation. `splitBuffer` moved
// into the package's own `streamLines` loop as an inlined implementation
// detail (no longer a separately exported/testable primitive — see that
// module's doc comment), and this archived #585 spike harness is loaded
// directly into a real browser via `browser-harness.ts`/`spike-server.mjs`'s
// raw-ESM serving, so it deliberately does NOT reach for the package's
// runtime export either (that would need its own browser import-map entry
// for a rejected-decision spike with no production consumer). The
// split/retain-remainder logic below is therefore spike-owned and
// self-contained — byte-for-byte the same rule the production loop uses, just
// duplicated here on purpose per the Phase 3 plan's own instruction (§13): do
// not preserve `src/core/splitBuffer` or add a second production stream
// helper merely to keep this archived harness importing it.

import type { StreamLine } from '@altinity/clickhouse-http';

export interface BridgeStats {
  /** Physical bytes read off the stream (compressed-agnostic — post fetch
   *  decompression, matching what `ch-client.ts`'s `runQuery` sees too). */
  bytesRead: number;
  chunkCount: number;
  malformedLines: number;
}

/**
 * Decode a `ReadableStream<Uint8Array>` of `JSONStringsEachRowWithProgress`
 * (or the plain numeric `JSONEachRowWithProgress`, for the KPI control) body
 * bytes, calling `onLine` for each complete parsed record as soon as its line
 * is complete — never buffering the whole body (the plan's progressive-first-
 * row hard gate). Malformed lines are skipped (matching `runQuery`'s
 * `try { JSON.parse } catch { continue }`); a non-empty trailing partial line
 * is attempted once at stream end (matching `runQuery`'s trailing-buffer
 * handling), and silently dropped if it still fails to parse.
 */
export async function bridgeNdjsonProgress(
  stream: ReadableStream<Uint8Array>,
  onLine: (line: StreamLine) => void,
): Promise<BridgeStats> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const stats: BridgeStats = { bytesRead: 0, chunkCount: 0, malformedLines: 0 };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    stats.bytesRead += value.byteLength;
    stats.chunkCount += 1;
    buffer += decoder.decode(value, { stream: true });
    // Spike-owned split/retain-remainder (see the module doc above for why
    // this duplicates, rather than imports, the production splitting rule).
    const lines = buffer.split('\n');
    buffer = lines[lines.length - 1];
    for (const line of lines.slice(0, -1)) {
      if (!line) continue;
      try {
        onLine(JSON.parse(line) as StreamLine);
      } catch {
        stats.malformedLines += 1;
      }
    }
  }
  if (buffer.trim()) {
    try {
      onLine(JSON.parse(buffer) as StreamLine);
    } catch {
      // trailing partial line — matches ch-client.ts's runQuery exactly
      stats.malformedLines += 1;
    }
  }
  return stats;
}
