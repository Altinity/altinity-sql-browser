// Phase 0 / issue #585, plan §14 "Same-origin, CORS, and browser harness" and
// §25 "Browser and deployment matrix". This is the SECOND (and only other)
// module in this repository that imports `@clickhouse/client-web` — this
// time from a REAL browser engine (Chromium/WebKit via Playwright), not
// Node. `official-adapter.ts` already proves the vendor client's behavior
// under Node for the deterministic/live harness; this file proves the SAME
// production decisions (plan §16's exec()+bridge Table path, the vendor
// client's own per-call `auth` override, `query_id`, response headers)
// survive UNMODIFIED inside a real browser — it is deliberately narrower
// than the Node harness, not a second parity surface (plan §25's per-row
// browser coverage: client construction, ordinary query, progressive first
// row, request-local Basic auth, cancellation during streaming, response
// headers, query ID, raw bytes).
//
// Reuses, rather than reimplements, two already-proven pure pieces that work
// identically under Node and in a real browser (no DOM, no Node builtins):
//   * progress-bridge.ts's bridgeNdjsonProgress — the EXACT narrow bridge
//     official-adapter.ts's Table path uses;
//   * normalize.ts's IncrementalSha256 — Web Crypto SHA-256.
//
// browser.spec.js drives this module's single exported entry point,
// `runScenario`, through `page.evaluate` — every argument and return value
// crosses the Playwright/browser boundary as plain JSON, so no live object
// (client, stream, AbortController) ever needs to survive that boundary.
// This file is served to the browser by `spike-server.mjs`, which type-
// strips it exactly like `build/e2e-serve.mjs` does for the normal e2e
// suite — the browser never executes TypeScript syntax.
//
// `@clickhouse/client-web` itself is resolved through `browser-harness.html`'s
// import map, which points at `spike-server.mjs`'s own esbuild-bundled ESM
// wrapper around the VERIFIED installed 1.23.1 entry (see that file's header
// for why a bare `import` of the installed CJS `dist/index.js` cannot work
// directly in a browser, and why the routing scheme below uses a header,
// never a URL path segment).

import { createClient, ClickHouseError, isProgressRow, isRow, type ClickHouseClient } from '@clickhouse/client-web';
import { bridgeNdjsonProgress } from './progress-bridge.js';
import { IncrementalSha256 } from './normalize.js';
import type { StreamLine } from '../../../src/core/stream.js';

export interface SpikeAuth { username: string; password: string }

export type ScenarioName =
  | 'construct'
  | 'ordinaryQuery'
  | 'progressiveFirstRow'
  | 'basicAuth'
  | 'cancelDuringStreaming'
  | 'responseHeaders'
  | 'queryId'
  | 'rawBytes';

export interface ScenarioRequest {
  scenario: ScenarioName;
  url: string;
  auth?: SpikeAuth;
  authB?: SpikeAuth;
  /** Same-origin mode only: the matrix-row key spike-server.mjs's proxy
   *  should route this client's requests to (see spike-server.mjs's header
   *  docstring for why this is a request header, never a URL path segment).
   *  Omitted entirely in cross-origin mode, where `url` already points
   *  directly at the row's own ClickHouse endpoint. MUST stay byte-identical
   *  to spike-server.mjs's own `ROW_HEADER` constant — cross-referenced by
   *  comment rather than a shared import, matching this repository's
   *  existing .mjs/.ts fixture cross-reference precedent
   *  (clickhouse-containers.mjs/auth-fixtures.ts). */
  rowHeader?: string;
}

const ROW_HEADER_NAME = 'x-asb-spike-row';

export interface ScenarioResult {
  ok: boolean;
  error?: string;
  [key: string]: unknown;
}

/** One client per `url`, reused across every scenario call for that page
 * (the plan's "one official client per connection config" invariant, held
 * here too — `runScenario` never constructs a second client for a `url` it
 * has already seen). The client-level default credential is deliberately
 * invalid, matching `official-adapter.ts`'s `createOfficialConnection` — a
 * request that omits `auth` must fail, proving the default never becomes
 * authoritative. */
const clients = new Map<string, ClickHouseClient>();

function clientFor(url: string, rowHeader?: string): ClickHouseClient {
  const cacheKey = `${url}::${rowHeader ?? ''}`;
  let client = clients.get(cacheKey);
  if (!client) {
    client = createClient({
      url,
      username: 'asb-spike-default-invalid',
      password: 'asb-spike-default-invalid',
      ...(rowHeader ? { http_headers: { [ROW_HEADER_NAME]: rowHeader } } : {}),
    });
    clients.set(cacheKey, client);
  }
  return client;
}

function flattenHeaders(h: Record<string, string | string[] | undefined> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!h) return out;
  for (const [k, v] of Object.entries(h)) {
    if (v === undefined) continue;
    out[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : v;
  }
  return out;
}

// DISCOVERED WHILE BUILDING THIS HARNESS (real cross-origin WebKit run
// against ClickHouse 26.6.2.160, verified independently with `curl`): this
// is a genuine CLICKHOUSE-SERVER-SIDE behavior, not a browser or vendor-
// client bug. `Accept-Encoding: gzip, deflate` (or `identity`) both cause
// ClickHouse's HTTP handler to flush each block as it completes — but
// `Accept-Encoding: ...br` (Brotli) makes ClickHouse withhold the ENTIRE
// response, including `X-ClickHouse-Summary`'s header value itself, until
// the query fully completes (`curl -D -` on the SAME query showed a
// PARTIAL summary — read_rows:1 — for gzip/deflate/identity, but the FULL
// final summary for `br` before a single body byte arrived). Real browsers
// differ in whether their default `fetch()` `Accept-Encoding` includes
// `br` (this is why the SAME query streamed progressively for Chromium's
// cross-origin request but not WebKit's, despite identical SQL/server, and
// why the SAME-ORIGIN proxy path never hits this at all — spike-server.mjs
// forces `identity` on its own upstream leg for exactly this class of
// reason, see that file's header docstring). `enable_http_compression`
// must disable it via the CLIENT'S `clickhouse_settings` (a URL query
// parameter the HTTP handler reads before parsing the query) — embedding
// it in the SQL's own `SETTINGS` clause does NOT work (verified: still
// buffered), because compression is an HTTP-handler-level decision made
// before the query settings clause is even parsed. Applied only to the two
// scenarios below that measure timing/incremental delivery — every other
// scenario is compression-encoding-agnostic by construction.
const NO_HTTP_COMPRESSION = { enable_http_compression: 0 } as const;

async function drain(stream: ReadableStream<Uint8Array>): Promise<void> {
  const reader = stream.getReader();
  for (;;) {
    const { done } = await reader.read();
    if (done) break;
  }
}

/** `.query({format:'JSONEachRowWithProgress'})` + `.stream()` — the one
 * publicly-supported progress format (plan §16), matching
 * `official-adapter.ts`'s KPI branch exactly (same `isRow`/`isProgressRow`
 * imports, same wrapped-document shape). Used for every scenario here that
 * only needs "does an ordinary query round-trip", not the narrow Table
 * exec()+bridge path (that is `progressiveFirstRow`/`cancelDuringStreaming`
 * below, on purpose — proving BOTH decided paths work in a real browser). */
async function runJsonQuery(
  client: ClickHouseClient,
  sql: string,
  opts: { auth?: SpikeAuth; queryId?: string } = {},
): Promise<{ rows: unknown[][]; queryId: string; headers: Record<string, string> }> {
  const rs = await client.query({
    query: sql,
    format: 'JSONEachRowWithProgress',
    ...(opts.auth ? { auth: opts.auth } : {}),
    ...(opts.queryId ? { query_id: opts.queryId } : {}),
  });
  const headers = flattenHeaders(rs.response_headers);
  const rows: unknown[][] = [];
  const stream = rs.stream<Record<string, unknown>>();
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    for (const wrapped of value) {
      const row = wrapped.json();
      if (isRow(row)) rows.push(Object.values(row.row as Record<string, unknown>));
      else if (isProgressRow(row)) { /* observed, not needed by these scenarios */ }
    }
  }
  return { rows, queryId: rs.query_id, headers };
}

async function construct(url: string, rowHeader?: string): Promise<ScenarioResult> {
  clientFor(url, rowHeader);
  return { ok: true };
}

async function ordinaryQuery(client: ClickHouseClient, auth?: SpikeAuth): Promise<ScenarioResult> {
  const { rows } = await runJsonQuery(client, 'SELECT number FROM system.numbers LIMIT 5', { auth });
  return { ok: true, rows, rowCount: rows.length };
}

/** Plan §16's chosen Table path (exec() + the narrow NDJSON bridge) run
 * against a query that flushes one row per block with a real delay between
 * blocks — the same shape `live-parity.test.ts`'s real-server timing gate
 * uses, proving first-row publication precedes completion by a real margin
 * in an ACTUAL browser engine, not merely under Node. */
async function progressiveFirstRow(client: ClickHouseClient, auth?: SpikeAuth): Promise<ScenarioResult> {
  const sql = 'SELECT sleepEachRow(0.2) FROM numbers(6) SETTINGS max_block_size = 1\nFORMAT JSONStringsEachRowWithProgress';
  const t0 = Date.now();
  const res = await client.exec({ query: sql, clickhouse_settings: NO_HTTP_COMPRESSION, ...(auth ? { auth } : {}) });
  let firstRowAtMs: number | null = null;
  let rowCount = 0;
  await bridgeNdjsonProgress(res.stream, (line: StreamLine) => {
    if (line.row) {
      rowCount += 1;
      if (firstRowAtMs === null) firstRowAtMs = Date.now() - t0;
    }
  });
  const completedAtMs = Date.now() - t0;
  return {
    ok: true,
    firstRowAtMs,
    completedAtMs,
    rowCount,
    // The hard gate itself (plan §19): first row must precede completion by
    // a real margin, never merely equal it (which would mean full buffering).
    progressive: firstRowAtMs !== null && completedAtMs - firstRowAtMs >= 200,
  };
}

/** Plan §21 "Per-request auth": one client, alternating per-request
 * credentials, proving the client-level default (deliberately invalid) is
 * never authoritative and each request is scoped to only its own override. */
async function basicAuth(client: ClickHouseClient, authA?: SpikeAuth, authB?: SpikeAuth): Promise<ScenarioResult> {
  if (!authA || !authB) return { ok: false, error: 'basicAuth scenario requires both auth and authB' };
  const currentUser = async (auth?: SpikeAuth) => {
    const { rows } = await runJsonQuery(client, 'SELECT currentUser() AS u', { auth });
    return rows[0]?.[0] ?? null;
  };
  const userA = await currentUser(authA);
  const userB = await currentUser(authB);
  let defaultRejected = false;
  try {
    await currentUser(undefined);
  } catch {
    defaultRejected = true;
  }
  return {
    ok: true,
    userA,
    userB,
    defaultRejected,
    matchesA: userA === authA.username,
    matchesB: userB === authB.username,
  };
}

/** Plan §22 "Cancellation": abort partway through a real streamed Table
 * response and prove no row is published after the abort. */
async function cancelDuringStreaming(client: ClickHouseClient, auth?: SpikeAuth): Promise<ScenarioResult> {
  const controller = new AbortController();
  const sql = 'SELECT sleepEachRow(0.15) FROM numbers(40) SETTINGS max_block_size = 1\nFORMAT JSONStringsEachRowWithProgress';
  const res = await client.exec({ query: sql, abort_signal: controller.signal, clickhouse_settings: NO_HTTP_COMPRESSION, ...(auth ? { auth } : {}) });
  let rowCount = 0;
  let cancelled = false;
  try {
    await bridgeNdjsonProgress(res.stream, (line: StreamLine) => {
      if (line.row) {
        rowCount += 1;
        if (rowCount === 3) controller.abort();
      }
    });
  } catch (e) {
    cancelled = (e instanceof Error && e.name === 'AbortError') || controller.signal.aborted;
  }
  const rowCountAtAbort = rowCount;
  // Give any late/leaked chunk a real chance to arrive before asserting none did.
  await new Promise((resolve) => setTimeout(resolve, 400));
  const rowCountAfterWait = rowCount;
  return {
    ok: true,
    cancelled: cancelled || controller.signal.aborted,
    rowCountAtAbort,
    rowCountAfterWait,
    noLaterRows: rowCountAfterWait === rowCountAtAbort,
  };
}

/** Plan §18 "response headers" / "X-ClickHouse-Summary" — the exact headers
 * `clickhouse-containers.mjs`'s CORS config explicitly exposes. */
async function responseHeaders(client: ClickHouseClient, auth?: SpikeAuth): Promise<ScenarioResult> {
  const res = await client.exec({ query: 'SELECT 1', ...(auth ? { auth } : {}) });
  const headers = flattenHeaders(res.response_headers);
  await drain(res.stream);
  return {
    ok: true,
    headers,
    hasSummary: 'x-clickhouse-summary' in headers,
    hasQueryId: 'x-clickhouse-query-id' in headers,
  };
}

/** Plan §18 "query ID" — caller allocates the ID before execution; it must
 * be preserved verbatim, both on the vendor result and the response header. */
async function queryIdScenario(client: ClickHouseClient, auth?: SpikeAuth): Promise<ScenarioResult> {
  const callerId = crypto.randomUUID();
  const res = await client.exec({ query: 'SELECT 1', query_id: callerId, ...(auth ? { auth } : {}) });
  const headers = flattenHeaders(res.response_headers);
  await drain(res.stream);
  return {
    ok: true,
    callerId,
    queryId: res.query_id,
    headerQueryId: headers['x-clickhouse-query-id'] ?? null,
    matches: res.query_id === callerId,
  };
}

/** Plan §24 "Raw and export byte proof" — a deliberately deterministic,
 * server-version-independent literal (never `.text()`/`TextDecoder`, exactly
 * `official-adapter.ts`'s raw path: `IncrementalSha256` over the raw
 * `Uint8Array` chunks straight off `exec()`'s `.stream`). */
async function rawBytes(client: ClickHouseClient, auth?: SpikeAuth): Promise<ScenarioResult> {
  // `toString()` of a small non-negative integer is its plain decimal
  // representation on every ClickHouse version — deliberately avoiding any
  // formatting function (e.g. hex()) whose exact digit-padding behavior
  // this harness has not independently verified against a real server.
  // browser.spec.js computes the SAME expected literal independently.
  const sql = 'SELECT number, toString(number) FROM system.numbers LIMIT 3\nFORMAT TSV';
  const res = await client.exec({ query: sql, ...(auth ? { auth } : {}) });
  const hash = new IncrementalSha256();
  const reader = res.stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    hash.update(value);
  }
  return { ok: true, sha256: await hash.digestHex(), length: hash.totalBytes };
}

export async function runScenario(request: ScenarioRequest): Promise<ScenarioResult> {
  try {
    if (request.scenario === 'construct') return await construct(request.url, request.rowHeader);
    const client = clientFor(request.url, request.rowHeader);
    switch (request.scenario) {
      case 'ordinaryQuery': return await ordinaryQuery(client, request.auth);
      case 'progressiveFirstRow': return await progressiveFirstRow(client, request.auth);
      case 'basicAuth': return await basicAuth(client, request.auth, request.authB);
      case 'cancelDuringStreaming': return await cancelDuringStreaming(client, request.auth);
      case 'responseHeaders': return await responseHeaders(client, request.auth);
      case 'queryId': return await queryIdScenario(client, request.auth);
      case 'rawBytes': return await rawBytes(client, request.auth);
      default: return { ok: false, error: `unknown scenario: ${String(request.scenario)}` };
    }
  } catch (e) {
    const message = e instanceof ClickHouseError ? `ClickHouseError: ${e.message}` : e instanceof Error ? e.message : String(e);
    return { ok: false, error: message };
  }
}

declare global {
  interface Window {
    __spikeRun?: typeof runScenario;
    __spikeReady?: boolean;
  }
}
