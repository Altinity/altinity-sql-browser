// Issue #627 — PR-review finding (pass 1): `docs/evidence/627/README.md`
// pinned its "Tested commit" to `036760a` and claimed `src/core/stream.ts`'s
// meta-less fallback "is unchanged since". That was true when written, but
// this branch's own later commit `edcb8ba` (`fix(#627): restore row-width
// invariant for zero-key rows...`) added a zero-key-row guard to the exact
// `json.row` fallback arm the evidence exercises — making the README's
// blanket claim stale/false relative to the branch's final head.
//
// This spec is the promised replay: it feeds the two RAW committed NDJSON
// captures through the REAL production path at the CURRENT head — the
// package's `streamLines()` (unmodified protocol mechanics) followed by
// `src/core/stream.ts`'s `newResult()`/`applyStreamLine()` (the #627
// result-policy fallback, now including the zero-key-row guard) — and
// asserts the result is byte-identical to the committed
// `*.normalized.json` files. Both committed captures carry only 3-key rows
// (id/precise/lexical), never a zero-key `{}` row, so the guard added in
// `edcb8ba` is provably inert against this corpus: this test is the
// evidence for that inertness claim, not just an assertion of it in prose.
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

describe('#627 evidence replay — production path at the current head (PR review pass 1)', () => {
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
