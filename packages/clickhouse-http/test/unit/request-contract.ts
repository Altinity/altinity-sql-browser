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
//
// Issue #630 Phase 3 — this suite is now REQUEST/SEND-ONLY: `ClickHouseTransport`
// no longer has a `streamLines` member (the progress-stream read loop moved
// to `@altinity/clickhouse-http`'s own `streamLines`, tested directly against
// the package in `progress-stream.test.ts`). The former
// "surfaces a mid-stream abort from streamLines rather than swallowing it"
// case moved there too (a direct package-level "reader error identity"
// proof) rather than staying here — there is intentionally only one
// production stream implementation now, so this shared suite has nothing
// left to register it against.
//
// Issue #630 Phase 7 (plan §2.1/§15) — the local `ClickHouseTransport`/
// `TransportDeps`/`TransportRequest` seam this suite used to import from
// `src/net/clickhouse-transport.types.ts` is deleted along with the rest of
// the local compatibility transport (Checkpoint 2D): that whole file is
// gone. This suite now retypes directly against the package's own PUBLIC
// request types (`ClickHouseHttpClientDeps`/`ClickHouseHttpRequest`) and a
// test-local minimal `send(request)` façade (`RequestSender`) rather than
// recreating the deleted production `ClickHouseTransport` abstraction —
// there is exactly one generic transport implementation left in the
// repository (the package's), and this suite proves it against that
// implementation's own request() (registered in
// `client.test.ts`), with nothing else left to register it
// against.

import { describe, expect, it, vi } from 'vitest';
import type { ClickHouseHttpClientDeps, ClickHouseHttpRequest } from '../../src/index.js';

type FetchImpl = (url: string, init: RequestInit) => Response | Promise<Response>;
type HeadersRecord = Record<string, string>;

/** Test-local minimal send-only façade — deliberately NOT a recreation of
 *  the deleted production `ClickHouseTransport` interface, just the single
 *  member this suite actually needs to drive an implementation under test. */
type RequestSender = {
  send(request: ClickHouseHttpRequest): Promise<Response>;
};

/** Builds a concrete `RequestSender` under test from a
 *  `ClickHouseHttpClientDeps` this factory constructs and controls (so cases
 *  can flip `setOrigin` mid-test — Adaptation A5 / sabotage case 2 — and
 *  inspect every call the implementation made to the stub fetch). */
export type MakeRequestSender = (deps: ClickHouseHttpClientDeps) => RequestSender;

function baseRequest(overrides: Partial<ClickHouseHttpRequest> = {}): ClickHouseHttpRequest {
  return {
    sql: 'SELECT 1',
    defaultFormat: 'JSON',
    authorization: 'Bearer tok',
    ...overrides,
  };
}

export function runTransportContractSuite(name: string, makeTransport: MakeRequestSender): void {
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

    it('resolves (never throws) on a non-2xx response, leaving bodyUsed === false until the caller consumes it, with the body then byte-identical', async () => {
      const fetchResponse = new Response('{"exception":"Code: 60. DB::Exception: table not found"}', { status: 500 });
      const { transport } = harness(() => fetchResponse);
      const resp = await transport.send(baseRequest());
      expect(resp.status).toBe(500);
      expect(resp.bodyUsed).toBe(false);
      expect(await resp.text()).toBe('{"exception":"Code: 60. DB::Exception: table not found"}');
    });

    it('rejects with the network/abort failure rather than resolving, for an aborted signal, having still invoked the injected fetch exactly once', async () => {
      const controller = new AbortController();
      controller.abort();
      const { transport, fetchMock } = harness((_url, init) => {
        if ((init.signal as AbortSignal | undefined)?.aborted) {
          const err = Object.assign(new Error('aborted'), { name: 'AbortError' });
          return Promise.reject(err);
        }
        return Promise.resolve(new Response('ok'));
      });
      await expect(transport.send(baseRequest({ signal: controller.signal }))).rejects.toMatchObject({ name: 'AbortError' });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('returns the exact native Response object from a 2xx Fetch — never a clone or wrapper', async () => {
      const fetchResponse = new Response('ok', { status: 200 });
      const { transport } = harness(() => fetchResponse);
      const resp = await transport.send(baseRequest());
      expect(resp).toBe(fetchResponse);
    });

    it('returns the exact native Response object from a non-2xx Fetch — never a clone or wrapper', async () => {
      const fetchResponse = new Response('denied', { status: 403 });
      const { transport } = harness(() => fetchResponse);
      const resp = await transport.send(baseRequest());
      expect(resp).toBe(fetchResponse);
    });

    it('sends an independently authored pathological SQL literal — leading/trailing whitespace, comments, tab/newline, an authored FORMAT clause, a trailing semicolon, and a non-ASCII codepoint — byte-identical as the POST body', async () => {
      const { transport, fetchMock } = harness(() => new Response('ok'));
      // Deliberately NOT derived from chUrl/the transport under test — an
      // independently authored literal, per the plan's "do not derive
      // expected SQL/URL/Auth values through the production helper under
      // test" failure/gap policy.
      const sql = '  -- leading comment\n\tSELECT \'héllo\', 1 -- trailing comment\nFORMAT CSV;  \n';
      await transport.send(baseRequest({ sql, defaultFormat: 'JSON' }));
      expect((fetchMock.mock.calls[0][1] as RequestInit).body).toBe(sql);
    });

    it('carries opaque Bearer, Basic, Digest, and a genuinely nonstandard scheme Authorization value verbatim across sequential sends — no scheme normalization, no cross-send caching', async () => {
      const { transport, fetchMock } = harness(() => new Response('ok'));
      const values = [
        'Bearer tok-1',
        'Basic dXNlcjpwYXNz',
        'Digest realm="ch", nonce="abc", response="def"',
        // A scheme name that is not in the IANA HTTP Authentication Scheme
        // Registry (unlike Bearer/Basic/Digest above) — e.g. a custom SSO
        // gateway's own token scheme. Catches an implementation that
        // special-cases a closed allowlist of known schemes while mangling
        // (rejecting, dropping, or rewriting) anything outside it: such an
        // implementation would still pass a matrix built only from
        // registered schemes.
        'XAuth opaque-value-1',
        'Bearer tok-2', // back to Bearer with a DIFFERENT value — proves no retained prior-header state
      ];
      for (const authorization of values) {
        await transport.send(baseRequest({ authorization }));
      }
      values.forEach((expected, i) => {
        expect((fetchMock.mock.calls[i][1] as RequestInit).headers as unknown as HeadersRecord).toEqual({ Authorization: expected });
      });
    });

    it('returns invalid-UTF-8 raw bytes byte-identical via arrayBuffer(), proving send() never decodes the body itself', async () => {
      const bytes = new Uint8Array([0x61, 0x62, 0xff, 0xfe, 0x63, 0x00, 0x0a, 0x64]);
      const { transport } = harness(() => new Response(bytes, { status: 200 }));
      const resp = await transport.send(baseRequest());
      expect(resp.bodyUsed).toBe(false);
      const buf = await resp.arrayBuffer();
      expect(new Uint8Array(buf)).toEqual(bytes);
    });

    it('reads deps.fetch() live per request instead of snapshotting it at construction time', async () => {
      const fetchMockA = vi.fn(() => Promise.resolve(new Response('a')));
      const fetchMockB = vi.fn(() => Promise.resolve(new Response('b')));
      let current: FetchImpl = fetchMockA as unknown as FetchImpl;
      const transport = makeTransport({
        fetch: () => current as unknown as typeof fetch,
        origin: () => 'https://ch.example',
      });
      await transport.send(baseRequest());
      current = fetchMockB as unknown as FetchImpl;
      await transport.send(baseRequest());
      expect(fetchMockA).toHaveBeenCalledTimes(1);
      expect(fetchMockB).toHaveBeenCalledTimes(1);
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
