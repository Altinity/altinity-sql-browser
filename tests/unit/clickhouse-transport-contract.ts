// Issue #585 Phase 1 — reusable `ClickHouseTransport` contract-test-suite
// FACTORY. Deliberately NOT itself a `.test.ts` spec: vitest's `include` glob
// (`tests/vitest.config.ts`) is `tests/unit/**/*.test.{js,ts}`, so this file
// is never discovered directly — a real spec imports and calls
// `runTransportContractSuite(name, makeTransport)` to register it against one
// concrete implementation.
//
// Phase 1 registers this suite against `createHttpTransport` ONLY
// (`clickhouse-http-transport.test.ts`), because no official implementation
// exists yet and Phases 2-4 do not proceed without a new decision
// (docs/ADR-0005-clickhouse-web-client.md is Rejected). A future Phase 2
// transport would import this same factory and re-run it unchanged against
// its own `makeTransport` — "structurally ready", not implementation-neutral:
// today's contract is current-HTTP-specific (native `Response` return,
// complete pre-resolved `authorization` header — Adaptations A3/A6), so this
// suite proves today's ONE implementation satisfies the contract, not that
// the contract already generalizes to a hypothetical second one.

import { describe, expect, it, vi } from 'vitest';
import type { ClickHouseTransport, TransportDeps, TransportRequest } from '../../src/net/clickhouse-transport.types.js';

type FetchImpl = (url: string, init: RequestInit) => Response | Promise<Response>;
type HeadersRecord = Record<string, string>;

/** A concrete `ClickHouseTransport` implementation under test, built from a
 *  `TransportDeps` this factory constructs and controls (so cases can flip
 *  `setOrigin` mid-test — Adaptation A5 / sabotage case 2 — and inspect every
 *  call the implementation made to the stub fetch). */
export type MakeTransport = (deps: TransportDeps) => ClickHouseTransport;

function baseRequest(overrides: Partial<TransportRequest> = {}): TransportRequest {
  return {
    sql: 'SELECT 1',
    defaultFormat: 'JSON',
    authorization: 'Bearer tok',
    ...overrides,
  };
}

export function runTransportContractSuite(name: string, makeTransport: MakeTransport): void {
  describe(`ClickHouseTransport contract — ${name}`, () => {
    function harness(fetchImpl: FetchImpl) {
      const fetchMock = vi.fn(fetchImpl);
      let origin = 'https://ch.example';
      const transport = makeTransport({
        fetch: () => fetchMock as unknown as typeof fetch,
        origin: () => origin,
      });
      return { transport, fetchMock, setOrigin: (o: string) => { origin = o; } };
    }

    it('serializes default_format, settings, params, and the complete Authorization header into one POST whose body is the SQL byte-identical', async () => {
      const { transport, fetchMock } = harness(() => new Response('ok'));
      await transport.send(baseRequest({
        sql: 'SELECT 1 FORMAT CSV', // an authored FORMAT clause — never appended to again
        defaultFormat: 'JSONCompact',
        settings: { wait_end_of_query: 1 },
        params: { param_id: '5', query_id: 'q1', session_id: 's1', role: 'analyst' },
        authorization: 'Bearer secret-token',
      }));
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toContain('default_format=JSONCompact');
      expect(url).toContain('enable_http_compression=1');
      expect(url).toContain('wait_end_of_query=1');
      expect(url).toContain('param_id=5');
      expect(url).toContain('query_id=q1');
      expect(url).toContain('session_id=s1');
      expect(url).toContain('role=analyst');
      expect(init.method).toBe('POST');
      expect(init.body).toBe('SELECT 1 FORMAT CSV');
      expect((init.headers as HeadersRecord).Authorization).toBe('Bearer secret-token');
    });

    it('omits settings/params from the URL when absent (no client-level defaults)', async () => {
      const { transport, fetchMock } = harness(() => new Response('ok'));
      await transport.send(baseRequest());
      const url = fetchMock.mock.calls[0][0] as string;
      expect(url).toBe('https://ch.example?default_format=JSON&enable_http_compression=1');
    });

    it('carries each send\'s own authorization value with no state cached between sends', async () => {
      const { transport, fetchMock } = harness(() => new Response('ok'));
      await transport.send(baseRequest({ authorization: 'Bearer first' }));
      await transport.send(baseRequest({ authorization: 'Bearer second' }));
      expect((fetchMock.mock.calls[0][1] as RequestInit).headers as unknown as HeadersRecord).toEqual({ Authorization: 'Bearer first' });
      expect((fetchMock.mock.calls[1][1] as RequestInit).headers as unknown as HeadersRecord).toEqual({ Authorization: 'Bearer second' });
    });

    it('invokes the stub fetch exactly once per send — no internal retry or header caching — on a 2xx response', async () => {
      const { transport, fetchMock } = harness(() => new Response('ok', { status: 200 }));
      await transport.send(baseRequest());
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('invokes the stub fetch exactly once per send on a non-2xx response too', async () => {
      const { transport, fetchMock } = harness(() => new Response('denied', { status: 403 }));
      await transport.send(baseRequest());
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('resolves (never throws) on a non-2xx response, with the body reaching the caller byte-identical', async () => {
      const { transport } = harness(() => new Response('{"exception":"Code: 60. DB::Exception: table not found"}', { status: 500 }));
      const resp = await transport.send(baseRequest());
      expect(resp.status).toBe(500);
      expect(await resp.text()).toBe('{"exception":"Code: 60. DB::Exception: table not found"}');
    });

    it('rejects with the network/abort failure rather than resolving, for an aborted signal', async () => {
      const controller = new AbortController();
      controller.abort();
      const { transport } = harness((_url, init) => {
        if ((init.signal as AbortSignal | undefined)?.aborted) {
          const err = Object.assign(new Error('aborted'), { name: 'AbortError' });
          return Promise.reject(err);
        }
        return Promise.resolve(new Response('ok'));
      });
      await expect(transport.send(baseRequest({ signal: controller.signal }))).rejects.toMatchObject({ name: 'AbortError' });
    });

    it('surfaces a mid-stream abort from streamLines rather than swallowing it', async () => {
      const { transport } = harness(() => new Response('ok'));
      const abortError = Object.assign(new Error('aborted'), { name: 'AbortError' });
      const stream = new ReadableStream<Uint8Array>({
        start(controller) { controller.error(abortError); },
      });
      await expect(transport.streamLines(stream, {})).rejects.toBe(abortError);
    });

    it('preserves response status and arbitrary headers, including X-ClickHouse-Summary', async () => {
      const { transport } = harness(() => new Response('ok', {
        status: 200,
        headers: { 'X-ClickHouse-Summary': '{"read_rows":"1"}' },
      }));
      const resp = await transport.send(baseRequest());
      expect(resp.status).toBe(200);
      expect(resp.headers.get('X-ClickHouse-Summary')).toBe('{"read_rows":"1"}');
    });

    it('never consumes the response body inside send — bodyUsed stays false and the raw bytes are still readable', async () => {
      const bytes = new TextEncoder().encode('raw-bytes');
      const stream = new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(bytes); controller.close(); },
      });
      const { transport } = harness(() => new Response(stream, { status: 200 }));
      const resp = await transport.send(baseRequest());
      expect(resp.bodyUsed).toBe(false);
      const reader = resp.body!.getReader();
      const { value } = await reader.read();
      expect(value).toEqual(bytes);
    });

    it('reads deps.origin() live per request instead of snapshotting it at construction time (Adaptation A5)', async () => {
      const { transport, fetchMock, setOrigin } = harness(() => new Response('ok'));
      await transport.send(baseRequest());
      setOrigin('https://new-cluster.example');
      await transport.send(baseRequest());
      expect(fetchMock.mock.calls[0][0]).toContain('https://ch.example');
      expect(fetchMock.mock.calls[1][0]).toContain('https://new-cluster.example');
    });
  });
}
