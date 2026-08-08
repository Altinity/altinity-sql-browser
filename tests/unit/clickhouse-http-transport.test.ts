import { describe, expect, it, vi } from 'vitest';
import { createHttpTransport } from '../../src/net/clickhouse-http-transport.js';
import { runTransportContractSuite } from './clickhouse-transport-contract.js';

// Issue #585 Phase 1 — direct spec for the moved current-HTTP transport
// implementation. Registers the shared contract suite once (this is the
// ONLY implementation Phase 1 registers — see the suite factory's header
// comment).
//
// Issue #630 Phase 2 — `chUrl`'s own exact-URL-shape suite moved (not
// duplicated) to tests/unit/clickhouse-http-package.test.ts, since `chUrl`
// itself moved to @altinity/clickhouse-http. This file keeps the
// COMPATIBILITY-ADAPTER-specific tests: `send()`'s exact request shape
// (still true through delegation) and its promise-settlement shape on a
// request-preparation failure.
//
// Issue #630 Phase 3 — the moved progress-line stream loop's own mechanics
// tests (the split-multi-byte-UTF-8/onLine-before-onChunk-ordering cases this
// file used to cover locally) moved to
// `tests/unit/clickhouse-http-progress-stream.test.ts`, directly against the
// package's own `streamLines` — this adapter no longer has a stream member
// at all.

runTransportContractSuite('createHttpTransport', createHttpTransport);

function deps(fetchImpl: (url: string, init: RequestInit) => Response | Promise<Response>, origin = 'https://ch.example') {
  const fetchMock = vi.fn(fetchImpl);
  return { fetchMock, deps: { fetch: () => fetchMock as unknown as typeof fetch, origin: () => origin } };
}

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

  // Issue #630 Phase 2 — locks in the production compatibility adapter's
  // settlement shape across the extraction: `send()` delegates to the
  // package's async `request()`, so a request-preparation failure (chUrl
  // throwing URIError on an unencodable value) must still surface as a
  // REJECTED promise here too, never a synchronous throw out of `send()`.
  it('rejects the returned promise with URIError on malformed URL data, without throwing synchronously and without invoking fetch', async () => {
    const { fetchMock, deps: d } = deps(() => new Response('ok'));
    const transport = createHttpTransport(d);
    let result!: Promise<Response>;
    expect(() => {
      result = transport.send({
        sql: 'SELECT 1',
        defaultFormat: 'JSON',
        settings: { broken: '\uD800' },
        authorization: 'Bearer x',
      });
    }).not.toThrow();
    await expect(result).rejects.toBeInstanceOf(URIError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
