import { describe, expect, it } from 'vitest';
import { streamLines } from '../../src/index.js';
import type { StreamLine } from '../../src/index.js';

// Issue #630 Phase 3 — direct spec for the package's progress-stream read
// loop, consumed exclusively through the package's public export (contract
// A4). Moved (not duplicated) from the former
// `createHttpTransport().streamLines` describe block in
// `tests/unit/clickhouse-http-transport.test.ts` — that file no longer has a
// stream member to test; this is the ONE production stream implementation
// (§11.3's "tested once, directly against package streamLines()").

// A stream that yields exactly the given byte chunks, in order — needed for
// the UTF-8-split case, which a whole-string-per-chunk helper is structurally
// incapable of producing.
function byteStream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(chunks[i++]);
      else controller.close();
    },
  });
}

function stringStream(chunks: string[]): ReadableStream<Uint8Array> {
  return byteStream(chunks.map((c) => new TextEncoder().encode(c)));
}

describe('streamLines — progress-bearing JSON-lines read loop', () => {
  it('reassembles a line split across multiple chunks', async () => {
    const lines: StreamLine[] = [];
    const stream = stringStream(['{"row":{"a"', ':"1"}}\n']);
    await streamLines(stream, { onLine: (l) => lines.push(l) });
    expect(lines).toEqual([{ row: { a: '1' } }]);
  });

  it('emits multiple complete JSON lines delivered in a single chunk', async () => {
    const lines: StreamLine[] = [];
    const stream = stringStream(['{"row":{"a":"1"}}\n{"row":{"a":"2"}}\n{"row":{"a":"3"}}\n']);
    await streamLines(stream, { onLine: (l) => lines.push(l) });
    expect(lines).toEqual([{ row: { a: '1' } }, { row: { a: '2' } }, { row: { a: '3' } }]);
  });

  it('emits complete lines plus a trailing partial line together in one chunk', async () => {
    const lines: StreamLine[] = [];
    const stream = stringStream(['{"row":{"a":"1"}}\n{"row":{"a":"2"}}\n{"row":{"a":"3"}}']);
    await streamLines(stream, { onLine: (l) => lines.push(l) });
    expect(lines).toEqual([{ row: { a: '1' } }, { row: { a: '2' } }, { row: { a: '3' } }]);
  });

  it('skips empty lines between JSON objects', async () => {
    const lines: StreamLine[] = [];
    const stream = stringStream(['\n\n{"row":{"a":"1"}}\n\n']);
    await streamLines(stream, { onLine: (l) => lines.push(l) });
    expect(lines).toEqual([{ row: { a: '1' } }]);
  });

  it('skips a malformed complete line while a later valid line still emits', async () => {
    const lines: StreamLine[] = [];
    const stream = stringStream(['not json\n', '{"row":{"a":"1"}}\n']);
    await streamLines(stream, { onLine: (l) => lines.push(l) });
    expect(lines).toEqual([{ row: { a: '1' } }]);
  });

  it('flushes a valid trailing partial line (no terminating newline)', async () => {
    const lines: StreamLine[] = [];
    const stream = stringStream(['{"row":{"a":"1"}}']);
    await streamLines(stream, { onLine: (l) => lines.push(l) });
    expect(lines).toEqual([{ row: { a: '1' } }]);
  });

  it('discards a malformed trailing partial line without throwing', async () => {
    const lines: StreamLine[] = [];
    const stream = stringStream(['{bad trailing']);
    await expect(streamLines(stream, { onLine: (l) => lines.push(l) })).resolves.toBeUndefined();
    expect(lines).toEqual([]);
  });

  it('delivers an in-band exception line via onLine as an ordinary StreamLine', async () => {
    const lines: StreamLine[] = [];
    const stream = stringStream(['{"exception":"DB::Exception: boom"}\n']);
    await streamLines(stream, { onLine: (l) => lines.push(l) });
    expect(lines).toEqual([{ exception: 'DB::Exception: boom' }]);
  });

  it('decodes a multi-byte UTF-8 character split across two byte chunks correctly (single TextDecoder with {stream:true})', async () => {
    const line = '{"row":{"a":"€"}}\n'; // '€' — 3 UTF-8 bytes: 0xE2 0x82 0xAC
    const fullBytes = new TextEncoder().encode(line);
    let euroIdx = -1;
    for (let i = 0; i < fullBytes.length - 2; i++) {
      if (fullBytes[i] === 0xe2 && fullBytes[i + 1] === 0x82 && fullBytes[i + 2] === 0xac) { euroIdx = i; break; }
    }
    expect(euroIdx).toBeGreaterThan(-1);
    const splitAt = euroIdx + 1; // split INSIDE the euro sign's 3-byte sequence
    const chunk1 = fullBytes.slice(0, splitAt);
    const chunk2 = fullBytes.slice(splitAt);
    const lines: StreamLine[] = [];
    await streamLines(byteStream([chunk1, chunk2]), { onLine: (l) => lines.push(l) });
    expect((lines[0].row as Record<string, unknown>).a).toBe('€');
  });

  it('tolerates entirely missing onLine/onChunk callbacks', async () => {
    const stream = stringStream(['{"row":{}}\n', '{"row":{}}']);
    await expect(streamLines(stream, {})).resolves.toBeUndefined();
  });

  it('calls onChunk exactly once per reader byte chunk', async () => {
    let chunkCalls = 0;
    const stream = stringStream(['{"row":{}}\n', '{"row":{}}\n', '{"row":{}}\n']);
    await streamLines(stream, { onChunk: () => { chunkCalls++; } });
    expect(chunkCalls).toBe(3);
  });

  it('fires every onLine callback produced from a chunk before that chunk\'s onChunk (call-order)', async () => {
    const order: string[] = [];
    const stream = stringStream(['{"row":{"a":"1"}}\n{"row":{"a":"2"}}\n']);
    await streamLines(stream, {
      onLine: () => order.push('line'),
      onChunk: () => order.push('chunk'),
    });
    expect(order).toEqual(['line', 'line', 'chunk']);
  });

  it('a chunk containing only an incomplete line still receives its own onChunk', async () => {
    const order: string[] = [];
    const stream = stringStream(['{"partial']);
    await streamLines(stream, {
      onLine: () => order.push('line'),
      onChunk: () => order.push('chunk'),
    });
    expect(order).toEqual(['chunk']); // no onLine — the partial line is only resolved at EOF
  });

  it('a final parsed trailing remainder does not manufacture another onChunk', async () => {
    let chunkCalls = 0;
    const lines: StreamLine[] = [];
    const stream = stringStream(['{"row":{"a":"1"}}']); // no trailing newline — flushed only at EOF
    await streamLines(stream, { onLine: (l) => lines.push(l), onChunk: () => { chunkCalls++; } });
    expect(lines).toEqual([{ row: { a: '1' } }]);
    expect(chunkCalls).toBe(1); // the one real reader chunk, not a second one for the EOF flush
  });

  it('rejects with the exact same rejection object identity a reader failure produced', async () => {
    const abortError = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.error(abortError); },
    });
    await expect(streamLines(stream, {})).rejects.toBe(abortError);
  });

  it('after an earlier successful chunk, a later reader failure produces no synthetic line/chunk callbacks beyond what already happened', async () => {
    const failure = Object.assign(new Error('network drop'), { name: 'TypeError' });
    const lines: StreamLine[] = [];
    let chunkCalls = 0;
    let i = 0;
    const goodChunks = [new TextEncoder().encode('{"row":{"a":"1"}}\n')];
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (i < goodChunks.length) { controller.enqueue(goodChunks[i++]); return; }
        controller.error(failure);
      },
    });
    await expect(streamLines(stream, {
      onLine: (l) => lines.push(l),
      onChunk: () => { chunkCalls++; },
    })).rejects.toBe(failure);
    expect(lines).toEqual([{ row: { a: '1' } }]);
    expect(chunkCalls).toBe(1); // exactly the one successful chunk before the rejection — no synthetic extra
  });
});
