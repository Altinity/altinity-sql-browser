import { describe, expect, it, vi } from 'vitest';
import { chUrl, createClickHouseHttpClient, ClickHouseError } from '@altinity/clickhouse-http';
import type { StreamLine } from '@altinity/clickhouse-http';
import { runTransportContractSuite } from './clickhouse-transport-contract.js';

// Issue #630 Phase 2 — direct spec for the new @altinity/clickhouse-http
// package, consumed exclusively through its public package name (contract
// A4) — never a relative/deep import into its own src/**. The package units
// under test (`chUrl`, `createClickHouseHttpClient`) come from the package's
// public export; the shared contract-suite factory is separately imported
// test infrastructure, which does not itself violate A4 (see the Phase 2
// plan §11's "package-test import wording" note).

// Register the exact same Phase-1 contract suite directly against the
// package's own request() — not the compatibility adapter — so every
// existing request invariant (native Response identity, exactly-one-Fetch,
// exact SQL, opaque Authorization, live origin/fetch, abort behavior, raw
// invalid UTF-8, …) is proven against the package implementation itself.
//
// Issue #630 Phase 3 — the suite is now REQUEST/SEND-ONLY (its one
// stream-mechanics case moved out — see `clickhouse-transport-contract.ts`'s
// header comment), so this registration no longer needs to construct the
// SQL Browser compatibility adapter (`createHttpTransport`) at all merely to
// borrow its `streamLines` for that case — it registers the package's
// `request()` directly with nothing else attached.
runTransportContractSuite('@altinity/clickhouse-http request()', (deps) => {
  const client = createClickHouseHttpClient(deps);
  return {
    send: (request) => client.request(request),
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

// Issue #630 Phase 4 — convenience query APIs (queryJson/queryText/
// queryProgress) and stateless killQuery, direct spec against the package's
// own client (contract A8/A9). Every convenience method must be exactly one
// `client.request()` plus one matching `response.ts` consumer — proven below
// via Fetch-call counts and native-error passthrough. Keeping the existing
// Phase-1 contract registration above green is the primary proof that the
// low-level request() boundary did not change underneath these additions.

describe('createClickHouseHttpClient().queryJson', () => {
  it('omitted defaultFormat becomes exactly JSON', async () => {
    const { fetchMock, deps: d } = deps(() => new Response('{"a":1}'));
    const client = createClickHouseHttpClient(d);
    await client.queryJson({ sql: 'SELECT 1', authorization: 'Bearer t' });
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('default_format=JSON');
  });

  it('an explicit defaultFormat is preserved', async () => {
    const { fetchMock, deps: d } = deps(() => new Response('{"a":1}'));
    const client = createClickHouseHttpClient(d);
    await client.queryJson({ sql: 'SELECT 1', authorization: 'Bearer t', defaultFormat: 'JSONCompact' });
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('default_format=JSONCompact');
  });

  it('an explicit empty-string defaultFormat is preserved — defaulting uses ?? (omission), never || (falsy)', async () => {
    // Asserts what `queryJson` itself passes to `request()`, not the final
    // URL: `chUrl` (Phase 1/2, out of this phase's scope) separately falls
    // back on ANY falsy `format` — including `''` — to its own default, so
    // the URL alone can't distinguish "queryJson defaulted" from "chUrl
    // defaulted". Spying on `client.request` observes the exact
    // `ClickHouseHttpRequest` object queryJson composed, before chUrl ever
    // sees it.
    const { deps: d } = deps(() => new Response('{"a":1}'));
    const client = createClickHouseHttpClient(d);
    const requestSpy = vi.spyOn(client, 'request');
    await client.queryJson({ sql: 'SELECT 1', authorization: 'Bearer t', defaultFormat: '' });
    expect(requestSpy.mock.calls[0][0].defaultFormat).toBe('');
  });

  it('exact SQL/settings/params/Authorization/signal reach the one Fetch; the response is consumed once as JSON', async () => {
    const controller = new AbortController();
    const { fetchMock, deps: d } = deps(() => new Response(JSON.stringify({ rows: 3 })));
    const client = createClickHouseHttpClient(d);
    const result = await client.queryJson<{ rows: number }>({
      sql: 'SELECT 3',
      authorization: 'Bearer exact-token',
      settings: { wait_end_of_query: 1 },
      params: { query_id: 'q1' },
      signal: controller.signal,
    });
    expect(result).toEqual({ rows: 3 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.body).toBe('SELECT 3');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer exact-token');
    expect(url).toContain('wait_end_of_query=1');
    expect(url).toContain('query_id=q1');
    expect(init.signal).toBe(controller.signal);
  });

  it('Fetch count stays exactly one on success and on a non-2xx response (which throws ClickHouseError)', async () => {
    const { fetchMock, deps: d } = deps(() => new Response('Code: 999. DB::Exception: boom', { status: 500 }));
    const client = createClickHouseHttpClient(d);
    await expect(client.queryJson({ sql: 'SELECT 1', authorization: 'Bearer t' })).rejects.toBeInstanceOf(ClickHouseError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('createClickHouseHttpClient().queryText', () => {
  it('forwards the exact caller format/fields, returns the exact text, with one Fetch', async () => {
    const { fetchMock, deps: d } = deps(() => new Response('exact-text-result'));
    const client = createClickHouseHttpClient(d);
    const text = await client.queryText({ sql: 'SELECT 1', defaultFormat: 'TabSeparated', authorization: 'Bearer t' });
    expect(text).toBe('exact-text-result');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('default_format=TabSeparated');
    expect(init.body).toBe('SELECT 1');
  });
});

describe('createClickHouseHttpClient().queryProgress', () => {
  it('sends the explicit wire format, delivers stream data to callbacks, and returns the exact Fetch Response, with one Fetch', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"row":{"a":"1"}}\n'));
        controller.close();
      },
    });
    let fetchResponse!: Response;
    const { fetchMock, deps: d } = deps(() => {
      fetchResponse = new Response(stream, { status: 200 });
      return fetchResponse;
    });
    const client = createClickHouseHttpClient(d);
    const lines: StreamLine[] = [];
    const result = await client.queryProgress(
      { sql: 'SELECT 1', defaultFormat: 'JSONStringsEachRowWithProgress', authorization: 'Bearer t' },
      { onLine: (l) => lines.push(l) },
    );
    expect(result).toBe(fetchResponse);
    expect(lines).toEqual([{ row: { a: '1' } }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('default_format=JSONStringsEachRowWithProgress');
  });
});

// Compile-time-only proof (never executed at runtime — `check:types`/
// `tsc --noEmit` is the actual gate for this block): `queryText`/
// `queryProgress` require `defaultFormat`; `queryJson` permits its omission.
// Referenced by nothing else and never called, so it is dead code by design
// — its only job is to fail `check:types` if either requirement regresses.
function _typeOnlyDefaultFormatRequirednessProbe(client: ReturnType<typeof createClickHouseHttpClient>) {
  void client.queryJson({ sql: 'x', authorization: 'a' }); // OK — defaultFormat omitted
  // @ts-expect-error — queryText requires defaultFormat, unlike queryJson.
  void client.queryText({ sql: 'x', authorization: 'a' });
  // @ts-expect-error — queryProgress requires defaultFormat, unlike queryJson.
  void client.queryProgress({ sql: 'x', authorization: 'a' });
}
void _typeOnlyDefaultFormatRequirednessProbe;

describe('convenience methods have no SQL Browser view-mode policy', () => {
  it('treats "Table" and "KPI" as opaque literal wire formats reaching default_format unchanged', async () => {
    const { fetchMock, deps: d } = deps(() => new Response('{}'));
    const client = createClickHouseHttpClient(d);
    await client.queryJson({ sql: 'SELECT 1', authorization: 'Bearer t', defaultFormat: 'Table' });
    await client.queryText({ sql: 'SELECT 1', authorization: 'Bearer t', defaultFormat: 'KPI' });
    const [url1] = fetchMock.mock.calls[0] as [string, RequestInit];
    const [url2] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url1).toContain('default_format=Table');
    expect(url2).toContain('default_format=KPI');
  });
});

describe('convenience methods propagate native Fetch rejection unchanged', () => {
  it('queryJson rejects with the exact original rejection object; one Fetch', async () => {
    const sentinel = Object.assign(new Error('network down'), { name: 'TypeError' });
    const { fetchMock, deps: d } = deps(() => { throw sentinel; });
    const client = createClickHouseHttpClient(d);
    await expect(client.queryJson({ sql: 'SELECT 1', authorization: 'Bearer t' })).rejects.toBe(sentinel);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('queryText rejects with the exact original AbortError; one Fetch', async () => {
    const sentinel = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const { fetchMock, deps: d } = deps(() => { throw sentinel; });
    const client = createClickHouseHttpClient(d);
    await expect(client.queryText({ sql: 'SELECT 1', defaultFormat: 'JSON', authorization: 'Bearer t' })).rejects.toBe(sentinel);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('queryProgress rejects with the exact original rejection object; one Fetch', async () => {
    const sentinel = Object.assign(new Error('network down'), { name: 'TypeError' });
    const { fetchMock, deps: d } = deps(() => { throw sentinel; });
    const client = createClickHouseHttpClient(d);
    await expect(client.queryProgress({ sql: 'SELECT 1', defaultFormat: 'JSON', authorization: 'Bearer t' })).rejects.toBe(sentinel);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// Issue #630 Phase 4 — stateless package-owned KILL QUERY (contract A9).
// Every expected SQL literal below is independently authored, never
// generated with `quoteKillQueryId` (the production helper under test).
describe('createClickHouseHttpClient().killQuery — quoting', () => {
  const cases: Array<{ label: string; queryId: string; expectedLiteral: string }> = [
    { label: 'an ordinary id', queryId: 'abc123', expectedLiteral: "'abc123'" },
    { label: 'an id with an embedded single quote', queryId: "a'b", expectedLiteral: "'a''b'" },
    { label: 'an id with an embedded backslash', queryId: 'a\\b', expectedLiteral: "'a\\\\b'" },
    { label: 'an id with both a quote and a backslash', queryId: "a'\\b", expectedLiteral: "'a''\\\\b'" },
    { label: 'an empty id', queryId: '', expectedLiteral: "''" },
  ];

  for (const { label, queryId, expectedLiteral } of cases) {
    it(`quotes ${label} and emits an ASYNC KILL QUERY body ending in ASYNC`, async () => {
      const { fetchMock, deps: d } = deps(() => new Response('ok'));
      const client = createClickHouseHttpClient(d);
      await client.killQuery({ queryId, authorization: 'Bearer t' });
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(init.body).toBe(`KILL QUERY WHERE query_id = ${expectedLiteral} ASYNC`);
    });
  }
});

describe('createClickHouseHttpClient().killQuery — request construction', () => {
  it('issues exactly one POST Fetch with default_format=JSON, preserving Authorization/signal/settings/params unchanged', async () => {
    const controller = new AbortController();
    const { fetchMock, deps: d } = deps(() => new Response('ok'));
    const client = createClickHouseHttpClient(d);
    await client.killQuery({
      queryId: 'q-target',
      authorization: 'Bearer custom-token',
      signal: controller.signal,
      settings: { max_execution_time: 5 },
      params: { session_id: 's1' },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe('POST');
    expect(url).toContain('default_format=JSON');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer custom-token');
    expect(init.signal).toBe(controller.signal);
    expect(url).toContain('max_execution_time=5');
    expect(url).toContain('session_id=s1');
  });
});

describe('createClickHouseHttpClient().killQuery — target vs. HTTP query-id isolation', () => {
  it('keeps the SQL target queryId and params.query_id distinct', async () => {
    const { fetchMock, deps: d } = deps(() => new Response('ok'));
    const client = createClickHouseHttpClient(d);
    await client.killQuery({
      queryId: 'target-id',
      authorization: 'Bearer t',
      params: { query_id: 'kill-request-id' },
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.body).toBe("KILL QUERY WHERE query_id = 'target-id' ASYNC");
    expect(url).toContain('query_id=kill-request-id');
    expect(url).not.toContain('query_id=target-id');
  });
});

describe('createClickHouseHttpClient().killQuery — failure behavior', () => {
  it('a 500 response throws ClickHouseError with one Fetch', async () => {
    const { fetchMock, deps: d } = deps(() => new Response('Code: 999. DB::Exception: boom', { status: 500 }));
    const client = createClickHouseHttpClient(d);
    await expect(client.killQuery({ queryId: 'q', authorization: 'Bearer t' })).rejects.toBeInstanceOf(ClickHouseError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a 404 response throws ClickHouseError with one Fetch', async () => {
    const { fetchMock, deps: d } = deps(() => new Response('Code: 60. DB::Exception: missing', { status: 404 }));
    const client = createClickHouseHttpClient(d);
    await expect(client.killQuery({ queryId: 'q', authorization: 'Bearer t' })).rejects.toBeInstanceOf(ClickHouseError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a network rejection propagates by exact original identity, with no retry', async () => {
    const sentinel = Object.assign(new Error('network down'), { name: 'TypeError' });
    const { fetchMock, deps: d } = deps(() => { throw sentinel; });
    const client = createClickHouseHttpClient(d);
    await expect(client.killQuery({ queryId: 'q', authorization: 'Bearer t' })).rejects.toBe(sentinel);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('an abort rejection propagates by exact original identity, with no retry', async () => {
    const sentinel = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const { fetchMock, deps: d } = deps(() => { throw sentinel; });
    const client = createClickHouseHttpClient(d);
    await expect(client.killQuery({ queryId: 'q', authorization: 'Bearer t' })).rejects.toBe(sentinel);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a successful response whose body fails while draining propagates by exact original identity, with no swallowing', async () => {
    const sentinel = new Error('sentinel drain failure');
    const { fetchMock, deps: d } = deps(() => {
      const response = new Response('ok');
      Object.defineProperty(response, 'text', { value: () => Promise.reject(sentinel) });
      return response;
    });
    const client = createClickHouseHttpClient(d);
    await expect(client.killQuery({ queryId: 'q', authorization: 'Bearer t' })).rejects.toBe(sentinel);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('createClickHouseHttpClient().killQuery — statelessness (sequential + concurrent isolation)', () => {
  it('sequential calls with different query IDs/Authorization/params never leak values across invocations', async () => {
    const { fetchMock, deps: d } = deps(() => new Response('ok'));
    const client = createClickHouseHttpClient(d);
    await client.killQuery({ queryId: 'first', authorization: 'Bearer first-token', params: { query_id: 'req-1' } });
    await client.killQuery({ queryId: 'second', authorization: 'Bearer second-token', params: { query_id: 'req-2' } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url1, init1] = fetchMock.mock.calls[0] as [string, RequestInit];
    const [url2, init2] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(init1.body).toBe("KILL QUERY WHERE query_id = 'first' ASYNC");
    expect((init1.headers as Record<string, string>).Authorization).toBe('Bearer first-token');
    expect(url1).toContain('query_id=req-1');
    expect(init2.body).toBe("KILL QUERY WHERE query_id = 'second' ASYNC");
    expect((init2.headers as Record<string, string>).Authorization).toBe('Bearer second-token');
    expect(url2).toContain('query_id=req-2');
  });

  it('interleaved concurrent calls on one client never mix values across invocations', async () => {
    const { fetchMock, deps: d } = deps(() => new Response('ok'));
    const client = createClickHouseHttpClient(d);
    await Promise.all([
      client.killQuery({ queryId: 'concurrent-a', authorization: 'Bearer token-a', params: { query_id: 'req-a' } }),
      client.killQuery({ queryId: 'concurrent-b', authorization: 'Bearer token-b', params: { query_id: 'req-b' } }),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const calls = fetchMock.mock.calls as unknown as [string, RequestInit][];
    const forA = calls.find(([, init]) => (init.headers as Record<string, string>).Authorization === 'Bearer token-a')!;
    const forB = calls.find(([, init]) => (init.headers as Record<string, string>).Authorization === 'Bearer token-b')!;
    expect(forA[1].body).toBe("KILL QUERY WHERE query_id = 'concurrent-a' ASYNC");
    expect(forA[0]).toContain('query_id=req-a');
    expect(forB[1].body).toBe("KILL QUERY WHERE query_id = 'concurrent-b' ASYNC");
    expect(forB[0]).toContain('query_id=req-b');
  });
});
