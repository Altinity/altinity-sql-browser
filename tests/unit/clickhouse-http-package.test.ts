import { describe, expect, it, vi } from 'vitest';
import { chUrl, createClickHouseHttpClient } from '@altinity/clickhouse-http';
import { createHttpTransport } from '../../src/net/clickhouse-http-transport.js';
import { runTransportContractSuite } from './clickhouse-transport-contract.js';

// Issue #630 Phase 2 — direct spec for the new @altinity/clickhouse-http
// package, consumed exclusively through its public package name (contract
// A4) — never a relative/deep import into its own src/**. The package units
// under test (`chUrl`, `createClickHouseHttpClient`) come from the package's
// public export; the shared contract-suite factory and the SQL Browser
// compatibility adapter are separately imported test/production
// infrastructure, which does not itself violate A4 (see the Phase 2 plan
// §11's "package-test import wording" note).

// Register the exact same Phase-1 contract suite directly against the
// package's own request() — not the compatibility adapter — so every
// existing request invariant (native Response identity, exactly-one-Fetch,
// exact SQL, opaque Authorization, live origin/fetch, abort behavior, raw
// invalid UTF-8, …) is proven against the package implementation itself.
// The suite's one stream-mechanics case is fulfilled by the root-local
// `createHttpTransport().streamLines` (streamLines stays out of the package
// until Phase 3) — this does not exercise "streamLines migrated early",
// just reuses the untouched adapter for the one case the low-level package
// client structurally has no equivalent for.
runTransportContractSuite('@altinity/clickhouse-http request()', (deps) => {
  const client = createClickHouseHttpClient(deps);
  const legacy = createHttpTransport(deps);
  return {
    send: (request) => client.request(request),
    streamLines: legacy.streamLines,
  };
});

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
  // Moved (not copied — the describe block below no longer exists in
  // tests/unit/clickhouse-http-transport.test.ts) to this package spec by
  // #630 Phase 2, since chUrl() itself moved here.

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

function deps(fetchImpl: (url: string, init: RequestInit) => Response | Promise<Response>, origin = 'https://ch.example') {
  const fetchMock = vi.fn(fetchImpl);
  return { fetchMock, deps: { fetch: () => fetchMock as unknown as typeof fetch, origin: () => origin } };
}

describe('createClickHouseHttpClient().request — exact request shape (direct package client)', () => {
  it('builds the exact literal URL from origin/format/settings/params, POSTs the SQL body, and sends the complete Authorization header', async () => {
    const { fetchMock, deps: d } = deps(() => new Response('ok'));
    const client = createClickHouseHttpClient(d);
    await client.request({
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

  it('threads the exact original AbortSignal object through to fetch, unchanged', async () => {
    const controller = new AbortController();
    const { fetchMock, deps: d } = deps(() => new Response('ok'));
    const client = createClickHouseHttpClient(d);
    await client.request({ sql: 'x', defaultFormat: 'JSON', authorization: 'Bearer t', signal: controller.signal });
    expect((fetchMock.mock.calls[0][1] as RequestInit).signal).toBe(controller.signal);
  });

  // Issue #630 Phase 2 — pins the reviewed promise-settlement shape directly
  // against the package's own request(): a synchronous serializer failure
  // (chUrl throwing URIError on an unencodable value) must surface as a
  // REJECTED promise, never a synchronous throw out of request() — matching
  // today's async send() adapter behavior across the extraction.
  it('rejects the returned promise with URIError on malformed URL data, without throwing synchronously and without invoking fetch', async () => {
    const { fetchMock, deps: d } = deps(() => new Response('ok'));
    const client = createClickHouseHttpClient(d);
    let result!: Promise<Response>;
    expect(() => {
      result = client.request({
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
