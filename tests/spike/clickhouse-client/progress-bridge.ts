// Phase 0 / issue #585 — the "narrow progress bridge" plan §16 allows only if
// `exec()` is the chosen path for `JSONStringsEachRowWithProgress` (proven
// NOT publicly supported by `query()` in installed 1.23.1 — see
// `format-type-probe.ts`). This bridge does EXACTLY what plan §16 permits and
// nothing more:
//   * incrementally decode this one newline-delimited UTF-8 JSON format;
//   * retain an incomplete line between chunks;
//   * parse complete JSON records;
//   * emit existing `StreamLine` values (core/stream.js's own type);
//   * surface in-band exceptions;
//   * reproduce current malformed/truncated handling.
// It must NOT perform result normalization, parse arbitrary formats, consume
// exports, or become a second general client — it is reused verbatim by the
// official-side Table adapter, and its physical/transformed line counts are
// measured separately (plan §16 "Bridge size") for the ADR's deletion
// estimate.
//
// It reuses `core/stream.ts`'s own `splitBuffer` — the exact buffering rule
// `ch-client.ts`'s `runQuery` streaming branch applies inline — so this is
// provably the SAME line-splitting behavior, not an independent reimplementation.

import { splitBuffer } from '../../../src/core/stream.js';
import type { StreamLine } from '../../../src/core/stream.js';

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
    const { lines, rest } = splitBuffer(buffer);
    buffer = rest;
    for (const line of lines) {
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
