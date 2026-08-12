// The committed live-capture evidence in `docs/evidence/627/*.ndjson` /
// `*.normalized.json` attests to decoder/accumulator behavior. That
// attestation has to stay bound to the code currently under test, not to
// the commit the capture happened to run against — otherwise a later
// change to `streamLines()`/`applyStreamLine()` would silently invalidate
// the committed evidence instead of failing this suite.
//
// This spec is what enforces that binding: it replays the two raw
// committed NDJSON captures through the REAL production path at whatever
// checkout runs it — the package's `streamLines()` (unmodified protocol
// mechanics) followed by `src/core/stream.ts`'s
// `newResult()`/`applyStreamLine()` (the #627 result-policy fallback,
// including its zero-key-row guard) — and requires the result to still be
// deeply/structurally equal to the committed `*.normalized.json` files
// (deep value equality on the parsed objects, not a byte-for-byte file
// comparison).
//
// The zero-key-row guard `edcb8ba` added to that fallback arm is inert for
// this corpus: both committed captures carry only 3-key rows
// (id/precise/lexical) in every `row` line, never a zero-key `{}` row, so
// the guard's `keys.length === 0` branch never fires here. The per-case
// column assertions below are the evidence for that inertness claim, not
// just an assertion of it in prose.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { streamLines } from '@altinity/clickhouse-http';
import { newResult, applyStreamLine, type StreamResult } from '../../src/core/stream.js';

// `join(dirname(...), ...)`, not `resolve` — this repo's ambient `node:path`
// shim (`tests/types/node-fs-url.d.ts`, ADR-0002's no-@types/node decision)
// declares only `dirname`/`join`.
const evidenceDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'docs', 'evidence', '627');

/** Turn a whole NDJSON string into a single-chunk byte stream — sufficient
 *  here since this replay only needs `streamLines`' line-splitting/parsing,
 *  not its chunk-boundary reassembly (already covered directly in
 *  `packages/clickhouse-http/test/unit/progress-stream.test.ts`). */
function wholeBodyStream(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  let sent = false;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!sent) {
        sent = true;
        controller.enqueue(bytes);
      } else {
        controller.close();
      }
    },
  });
}

/** Replay one raw captured NDJSON body through the real production
 *  streamLines() -> applyStreamLine() path, at the current head. */
async function replay(ndjson: string): Promise<{ metaSeen: boolean; result: StreamResult }> {
  const result = newResult('Table');
  let metaSeen = false;
  await streamLines(wholeBodyStream(ndjson), {
    onLine: (line) => {
      if (line.meta) metaSeen = true;
      applyStreamLine(line, result);
    },
  });
  return { metaSeen, result };
}

describe('#627 evidence replay — production path reproduces the committed captures', () => {
  it.each([
    ['oss-24.8.14.39', 'ClickHouse OSS 24.8.14.39'],
    ['altinity-24.8.14.10547', 'Altinity Stable 24.8.14.10547.altinitystable'],
  ])('%s (%s): replaying the committed raw capture reproduces the committed normalized output exactly', async (key) => {
    const rawNdjson = readFileSync(join(evidenceDir, `${key}.ndjson`), 'utf8');
    const expected = JSON.parse(readFileSync(join(evidenceDir, `${key}.normalized.json`), 'utf8'));

    const { metaSeen, result } = await replay(rawNdjson);

    // No `meta` line in either committed capture — the whole point of #627.
    expect(metaSeen).toBe(false);
    expect(metaSeen).toBe(expected.metaSeen);
    expect(result.columns).toEqual(expected.columns);
    expect(result.rows).toEqual(expected.rows);
    expect(result.error).toBe(expected.error);
    expect(result.capped).toBe(expected.capped);

    // The guard `edcb8ba` added (declining to establish columns/store a
    // zero-key `{}` row) never fires against this corpus: every captured
    // `row` line carries exactly the 3 keys id/precise/lexical, never zero.
    expect(result.columns).toHaveLength(3);
    expect(result.columns.map((c) => c.name)).toEqual(['id', 'precise', 'lexical']);
  });
});
