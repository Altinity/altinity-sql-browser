import { describe, expect, it, vi } from 'vitest';
import { chUrl, createHttpTransport } from '../../src/net/clickhouse-http-transport.js';
import type { StreamLine } from '../../src/core/stream.js';
import { runTransportContractSuite } from './clickhouse-transport-contract.js';

// Issue #585 Phase 1 — direct spec for the moved current-HTTP transport
// implementation. Registers the shared contract suite once (this is the
// ONLY implementation Phase 1 registers — see the suite factory's header
// comment), then covers the mechanics the shared suite deliberately leaves
// implementation-specific: `chUrl`'s exact URL shape and the moved
// progress-line stream loop, including two edge cases a manual move can
// silently alter (a split multi-byte UTF-8 character across byte chunks,
// and per-chunk onLine-before-onChunk ordering).

runTransportContractSuite('createHttpTransport', createHttpTransport);

function deps(fetchImpl: (url: string, init: RequestInit) => Response | Promise<Response>, origin = 'https://ch.example') {
  const fetchMock = vi.fn(fetchImpl);
  return { fetchMock, deps: { fetch: () => fetchMock as unknown as typeof fetch, origin: () => origin } };
}

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

describe('chUrl', () => {
  it('uses default format and compression', () => {
    expect(chUrl('https://o')).toBe('https://o?default_format=JSONStringsEachRowWithProgress&enable_http_compression=1');
  });
  it('applies format, extra and params', () => {
    const url = chUrl('https://o', { format: 'JSON', extra: { wait_end_of_query: 1 }, params: { x: 'a b' } });
    expect(url).toContain('default_format=JSON');
    expect(url).toContain('wait_end_of_query=1');
    expect(url).toContain('x=a%20b');
  });

  // #630 Phase 1 — exact-literal zero/empty/reserved-value matrix (none of
  // these are derived through chUrl() itself; each expected string is an
  // independently authored literal, per the plan's failure/gap policy).

  it('serializes a numeric zero setting/param literally as 0, never omitted', () => {
    expect(chUrl('https://o', { extra: { max_result_rows: 0 } }))
      .toBe('https://o?default_format=JSONStringsEachRowWithProgress&enable_http_compression=1&max_result_rows=0');
    expect(chUrl('https://o', { params: { query_id: 0 } }))
      .toBe('https://o?default_format=JSONStringsEachRowWithProgress&enable_http_compression=1&query_id=0');
  });

  it('serializes an empty-string setting/param as a bare trailing "="', () => {
    expect(chUrl('https://o', { extra: { session_id: '' } }))
      .toBe('https://o?default_format=JSONStringsEachRowWithProgress&enable_http_compression=1&session_id=');
    expect(chUrl('https://o', { params: { query_id: '' } }))
      .toBe('https://o?default_format=JSONStringsEachRowWithProgress&enable_http_compression=1&query_id=');
  });

  it('percent-encodes spaces and reserved URL characters (& = ? # / %) in a setting/param value', () => {
    const url = chUrl('https://o', { extra: { a: 'x y' }, params: { b: 'a&b=c?d#e/f%g' } });
    expect(url).toBe(
      'https://o?default_format=JSONStringsEachRowWithProgress&enable_http_compression=1'
      + '&a=x%20y&b=a%26b%3Dc%3Fd%23e%2Ff%25g',
    );
  });

  it('serializes extra (settings) before params, each in its own object\'s key insertion order', () => {
    const url = chUrl('https://o', {
      extra: { z_setting: 1, a_setting: 2 },
      params: { z_param: 3, a_param: 4 },
    });
    expect(url).toBe(
      'https://o?default_format=JSONStringsEachRowWithProgress&enable_http_compression=1'
      + '&z_setting=1&a_setting=2&z_param=3&a_param=4',
    );
  });

  it('always orders default_format before enable_http_compression, even with an explicit format override', () => {
    expect(chUrl('https://o', { format: 'TabSeparated' }))
      .toBe('https://o?default_format=TabSeparated&enable_http_compression=1');
  });
});

describe('createHttpTransport().send — exact request shape', () => {
  it('builds the exact literal URL from origin/format/settings/params, POSTs the SQL body, and sends the complete Authorization header', async () => {
    const { fetchMock, deps: d } = deps(() => new Response('ok'));
    const transport = createHttpTransport(d);
    await transport.send({
      sql: 'SELECT 1',
      defaultFormat: 'JSONCompact',
      settings: { wait_end_of_query: 1 },
      params: { param_id: '5', query_id: 'q1', session_id: 's1', role: 'analyst' },
      authorization: 'Bearer tok',
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'https://ch.example?default_format=JSONCompact&enable_http_compression=1'
      + '&wait_end_of_query=1&param_id=5&query_id=q1&session_id=s1&role=analyst',
    );
    expect(init.method).toBe('POST');
    expect(init.body).toBe('SELECT 1');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
  });

  it('threads the abort signal through to fetch', async () => {
    const controller = new AbortController();
    const { fetchMock, deps: d } = deps(() => new Response('ok'));
    const transport = createHttpTransport(d);
    await transport.send({ sql: 'x', defaultFormat: 'JSON', authorization: 'Bearer t', signal: controller.signal });
    expect((fetchMock.mock.calls[0][1] as RequestInit).signal).toBe(controller.signal);
  });
});

describe('createHttpTransport().streamLines — moved progress-line loop mechanics', () => {
  it('reassembles a line split across multiple chunks', async () => {
    const { deps: d } = deps(() => new Response('ok'));
    const lines: StreamLine[] = [];
    const stream = stringStream(['{"row":{"a"', ':"1"}}\n']);
    await createHttpTransport(d).streamLines(stream, { onLine: (l) => lines.push(l) });
    expect(lines).toEqual([{ row: { a: '1' } }]);
  });

  it('skips empty lines between JSON objects', async () => {
    const { deps: d } = deps(() => new Response('ok'));
    const lines: StreamLine[] = [];
    const stream = stringStream(['\n\n{"row":{"a":"1"}}\n\n']);
    await createHttpTransport(d).streamLines(stream, { onLine: (l) => lines.push(l) });
    expect(lines).toEqual([{ row: { a: '1' } }]);
  });

  it('skips a malformed JSON line without throwing', async () => {
    const { deps: d } = deps(() => new Response('ok'));
    const lines: StreamLine[] = [];
    const stream = stringStream(['not json\n', '{"row":{"a":"1"}}\n']);
    await createHttpTransport(d).streamLines(stream, { onLine: (l) => lines.push(l) });
    expect(lines).toEqual([{ row: { a: '1' } }]);
  });

  it('flushes a valid trailing partial line (no terminating newline)', async () => {
    const { deps: d } = deps(() => new Response('ok'));
    const lines: StreamLine[] = [];
    const stream = stringStream(['{"row":{"a":"1"}}']);
    await createHttpTransport(d).streamLines(stream, { onLine: (l) => lines.push(l) });
    expect(lines).toEqual([{ row: { a: '1' } }]);
  });

  it('discards a malformed trailing partial line without throwing', async () => {
    const { deps: d } = deps(() => new Response('ok'));
    const lines: StreamLine[] = [];
    const stream = stringStream(['{bad trailing']);
    await expect(createHttpTransport(d).streamLines(stream, { onLine: (l) => lines.push(l) })).resolves.toBeUndefined();
    expect(lines).toEqual([]);
  });

  it('delivers an in-band exception line via onLine (hard invariant 10 feed-through)', async () => {
    const { deps: d } = deps(() => new Response('ok'));
    const lines: StreamLine[] = [];
    const stream = stringStream(['{"exception":"DB::Exception: boom"}\n']);
    await createHttpTransport(d).streamLines(stream, { onLine: (l) => lines.push(l) });
    expect(lines).toEqual([{ exception: 'DB::Exception: boom' }]);
  });

  it('calls onChunk once per network read', async () => {
    const { deps: d } = deps(() => new Response('ok'));
    let chunkCalls = 0;
    const stream = stringStream(['{"row":{}}\n', '{"row":{}}\n', '{"row":{}}\n']);
    await createHttpTransport(d).streamLines(stream, { onChunk: () => { chunkCalls++; } });
    expect(chunkCalls).toBe(3);
  });

  it('fires every onLine callback produced from a chunk before that chunk\'s onChunk (call-order)', async () => {
    const { deps: d } = deps(() => new Response('ok'));
    const order: string[] = [];
    const stream = stringStream(['{"row":{"a":"1"}}\n{"row":{"a":"2"}}\n']);
    await createHttpTransport(d).streamLines(stream, {
      onLine: () => order.push('line'),
      onChunk: () => order.push('chunk'),
    });
    expect(order).toEqual(['line', 'line', 'chunk']);
  });

  it('tolerates entirely missing onLine/onChunk callbacks', async () => {
    const { deps: d } = deps(() => new Response('ok'));
    const stream = stringStream(['{"row":{}}\n', '{"row":{}}']);
    await expect(createHttpTransport(d).streamLines(stream, {})).resolves.toBeUndefined();
  });

  it('decodes a multi-byte UTF-8 character split across two byte chunks correctly (single TextDecoder with {stream:true})', async () => {
    const { deps: d } = deps(() => new Response('ok'));
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
    await createHttpTransport(d).streamLines(byteStream([chunk1, chunk2]), { onLine: (l) => lines.push(l) });
    expect((lines[0].row as Record<string, unknown>).a).toBe('€');
  });
});
