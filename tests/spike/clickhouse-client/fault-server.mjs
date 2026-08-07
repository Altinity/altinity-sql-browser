// Phase 0 / issue #585, plan §15 "Deterministic protocol-fault server".
//
// A tiny, dependency-free Node `http` server exposing named fixture routes,
// each with a fully deterministic byte sequence and timing — so the parity
// harness can prove exact adapter behavior (progressive first row, mid-stream
// exception detection, malformed/truncated handling, auth retry, raw byte
// exactness) WITHOUT depending on real ClickHouse timing or scheduling.
// Every fixture's expected outcome is declared independently in
// `scenarios.ts`/`precision-corpus.ts` next to the fixture name — this file
// only produces bytes, it never asserts.
//
// Kept as plain `.mjs` (not `.ts`) per plan §8: Node orchestration/
// configuration files stay untyped so the spike doesn't force an unrelated
// repository-wide `@types/node` decision.

import { createServer } from 'node:http';

const EXCEPTION_MARKER = '__exception__';

// #630 Phase 1 — see the 'post-header-abort-hold' fixture below. Exported so
// the e2e spec's own post-hold "assert no later callbacks" wait can size
// itself relative to this value instead of an independent magic number.
export const POST_HEADER_ABORT_HOLD_MS = 3000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// A ClickHouse-since-24.11-shaped mid-stream exception trailer: the
// `X-ClickHouse-Exception-Tag` header value, framed exactly as
// `core/stream.ts`'s `findExceptionFrame` expects.
function taggedExceptionTrailer(tag, message) {
  const body = Buffer.from(message, 'utf8').toString('latin1');
  return `\r\n${EXCEPTION_MARKER}\r\n${tag}\r\n${body}\n${body.length} ${tag}\r\n${EXCEPTION_MARKER}\r\n`;
}

function legacyExceptionTrailer(code, message) {
  return `\nCode: ${code}. DB::Exception: ${message}\n`;
}

function ndjson(obj) {
  return JSON.stringify(obj) + '\n';
}

// Attempt counters for the 401-then-success fixture, keyed by query_id.
const attemptCounts = new Map();

/** Start the fault server on an ephemeral loopback port. `opts.cors` (#630
 * Phase 1, default off — every pre-existing caller keeps today's behavior)
 * additionally: answers CORS preflight for POST + Authorization, logs the
 * OPTIONS request too, and stamps `Access-Control-Allow-Origin` on every
 * actual response — required because the new root e2e transport spec loads
 * this server cross-origin from the Playwright-served page. Returns
 * `{ server, port, baseUrl, requestsLog, close() }`. `requestsLog` accumulates
 * `{ method, url, headers }` for every request the request-inspection
 * scenarios assert against — `authorization` is recorded only as a redacted
 * boolean-shape summary (scheme + presence), never the raw header value
 * (plan §12 "avoid logging authorization values" / CLAUDE.md's credential
 * hygiene rule). */
export function startFaultServer(opts = {}) {
  const { cors = false } = opts;
  const requestsLog = [];

  const server = createServer(async (req, res) => {
    // #630 Phase 1: a client that aborts a cross-origin request (the native
    // cancellation scenarios) tears down the underlying TCP connection while
    // a fixture below is still `await sleep(...)`-ing between writes. The
    // next `res.write()`/`res.end()` on that torn-down socket would otherwise
    // surface as an uncaught 'error' event and crash this whole shared test
    // server (used by every fixture, not just the new ones) — swallow it.
    res.on('error', () => {});
    if (cors) {
      // Node's ServerResponse#writeHead always returns `this`; no call site
      // below chains off its return value, so wrapping it to inject the
      // header is transparent to every existing fixture branch. Node's real
      // signature is `writeHead(status[, statusMessage][, headers])` — every
      // call site in this file today uses the 2-arg `(status, headers)`
      // form, but handle the 3-arg form too so a future fixture that passes
      // a `statusMessage` can't have it silently mistaken for `headers`.
      const nativeWriteHead = res.writeHead.bind(res);
      res.writeHead = (status, ...rest) => {
        if (rest.length >= 2) {
          const [statusMessage, headers] = rest;
          return nativeWriteHead(status, statusMessage, { 'access-control-allow-origin': '*', ...(headers || {}) });
        }
        const [headers] = rest;
        return nativeWriteHead(status, { 'access-control-allow-origin': '*', ...(headers || {}) });
      };
    }
    const url = new URL(req.url, 'http://localhost');
    // A cross-origin POST carrying an Authorization header is never a
    // CORS-simple request, so the browser sends a preflight OPTIONS first —
    // to the exact same URL (including query string), so `query_id` is still
    // present on it. Answer it before any fixture dispatch: preflight has no
    // fixture behavior of its own.
    if (cors && req.method === 'OPTIONS') {
      requestsLog.push({
        method: 'OPTIONS',
        pathname: url.pathname,
        params: Object.fromEntries(url.searchParams.entries()),
        headers: {},
        body: '',
      });
      res.writeHead(204, {
        'access-control-allow-methods': 'POST, OPTIONS',
        'access-control-allow-headers': 'Authorization, Content-Type',
      });
      res.end();
      return;
    }
    // Both adapters always POST to the connection URL's root path (verified
    // empirically: the official client folds any URL path segment into a
    // ClickHouse `database` query param instead of preserving it as the HTTP
    // request path — see docs/evidence/585/critical-questions.md). Routing by
    // URL path is therefore not viable for a SHARED fixture server used by
    // both adapters; instead the caller encodes the fixture name as a
    // `<fixture>__<unique-suffix>` `query_id`, which both adapters pass
    // through verbatim in the query string (`ch-client.ts`'s own
    // `params.query_id`; the official client's `query_id` param) — a
    // deliberately free-form, caller-chosen string on both sides, not a
    // protocol-interpreted value.
    const queryId = url.searchParams.get('query_id') || '';
    const fixture = queryId.split('__')[0] || '';
    // #630 Phase 1: byte-safe capture. `body += chunk` (the prior version)
    // performs an implicit per-Buffer UTF-8 decode, so a multi-byte character
    // split across two TCP chunks corrupts independently of anything the
    // transport under test does — too weak for an exact-SQL server-observed
    // proof. Collect raw Buffers and decode once, after every byte has
    // arrived.
    const bodyChunks = [];
    for await (const chunk of req) bodyChunks.push(chunk);
    const body = Buffer.concat(bodyChunks).toString('utf8');

    const auth = req.headers.authorization;
    requestsLog.push({
      method: req.method,
      pathname: url.pathname,
      params: Object.fromEntries(url.searchParams.entries()),
      headers: {
        ...Object.fromEntries(Object.entries(req.headers).filter(([k]) => k.toLowerCase() !== 'authorization')),
        authorizationScheme: auth ? auth.split(' ')[0] : null,
        authorizationPresent: !!auth,
      },
      body,
    });

    switch (fixture) {
      case 'ordinary-query': {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write(ndjson({ meta: [{ name: 'n', type: 'String' }] }));
        res.write(ndjson({ row: { n: '1' } }));
        res.write(ndjson({ row: { n: '2' } }));
        res.write(ndjson({ progress: { read_rows: '2', read_bytes: '2', total_rows_to_read: '2', elapsed_ns: '1000' } }));
        res.end();
        return;
      }
      case 'empty-stream': {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write(ndjson({ meta: [{ name: 'n', type: 'String' }] }));
        res.end();
        return;
      }
      case 'delayed-headers-scheduled-rows': {
        // Progressive-timing hard gate (plan §19): headers now, first row
        // after ~120ms, more rows/progress after ~250ms, completion >=1s later.
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write(ndjson({ meta: [{ name: 'n', type: 'UInt64' }] }));
        await sleep(120);
        res.write(ndjson({ row: { n: '18446744073709551615' } })); // UInt64 max, as a string
        await sleep(130);
        res.write(ndjson({ progress: { read_rows: '1', read_bytes: '8', total_rows_to_read: '2', elapsed_ns: '250000000' } }));
        res.write(ndjson({ row: { n: '2' } }));
        await sleep(1000);
        res.end();
        return;
      }
      case 'malformed-line': {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write(ndjson({ meta: [{ name: 'n', type: 'String' }] }));
        res.write('{"row": this is not valid json}\n');
        res.write(ndjson({ row: { n: 'after-malformed' } }));
        res.end();
        return;
      }
      case 'truncated-trailing-line': {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write(ndjson({ meta: [{ name: 'n', type: 'String' }] }));
        res.write(ndjson({ row: { n: 'ok' } }));
        res.write('{"row": {"n": "cut-off'); // no trailing newline, never completes the JSON
        res.end();
        return;
      }
      case 'pre-header-rejection': {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('Code: 60. DB::Exception: Table default.missing does not exist. (UNKNOWN_TABLE)');
        return;
      }
      case 'post-header-connection-reset': {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write(ndjson({ meta: [{ name: 'n', type: 'String' }] }));
        res.write(ndjson({ row: { n: 'before-reset' } }));
        // Simulate a mid-stream connection reset (used by the retry-safety
        // scenarios: read may retry once, INSERT/DDL must not).
        req.socket.destroy();
        return;
      }
      case 'ch-non-2xx-shaped': {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end('Code: 999. DB::Exception: synthetic non-2xx failure. (SYNTHETIC)');
        return;
      }
      case '401-then-success': {
        const attempt = (attemptCounts.get(fixture) || 0) + 1;
        attemptCounts.set(fixture, attempt);
        if (attempt === 1) {
          res.writeHead(401, { 'content-type': 'text/plain' });
          res.end('Code: 516. DB::Exception: Authentication failed (first attempt). (AUTHENTICATION_FAILED)');
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write(ndjson({ meta: [{ name: 'n', type: 'String' }] }));
        res.write(ndjson({ row: { n: 'ok-after-refresh' } }));
        res.end();
        return;
      }
      case 'repeated-401': {
        res.writeHead(401, { 'content-type': 'text/plain' });
        res.end('Code: 516. DB::Exception: Authentication failed (always). (AUTHENTICATION_FAILED)');
        return;
      }
      case 'forbidden-403': {
        res.writeHead(403, { 'content-type': 'text/plain' });
        res.end('Code: 497. DB::Exception: Not enough privileges. (ACCESS_DENIED)');
        return;
      }
      case 'session-is-locked': {
        // ClickHouse rejects SESSION_IS_LOCKED before any streaming starts —
        // a non-2xx response with the plain exception text, same shape as
        // any other pre-header rejection (`pre-header-rejection` above).
        const attempt = (attemptCounts.get(fixture) || 0) + 1;
        attemptCounts.set(fixture, attempt);
        if (attempt === 1) {
          res.writeHead(500, { 'content-type': 'text/plain' });
          res.end('Code: 373. DB::Exception: Session is locked by a concurrent client. (SESSION_IS_LOCKED)');
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(ndjson({ meta: [{ name: 'n', type: 'String' }] }) + ndjson({ row: { n: 'ok-after-lock' } }));
        return;
      }
      case 'controlled-headers-and-summary': {
        const summary = JSON.stringify({ read_rows: '1', read_bytes: '1', written_rows: '0', written_bytes: '0', total_rows_to_read: '1', result_rows: '1', result_bytes: '1', elapsed_ns: '1' });
        res.writeHead(200, {
          'content-type': 'application/json',
          'x-clickhouse-summary': summary,
          'x-clickhouse-query-id': queryId || 'fault-server-generated-id',
          'x-clickhouse-format': 'JSONStringsEachRowWithProgress',
          'x-custom-exposed-header': 'exposed-value',
        });
        res.write(ndjson({ meta: [{ name: 'n', type: 'String' }] }));
        res.write(ndjson({ row: { n: '1' } }));
        res.end();
        return;
      }
      case 'progress-format-mid-stream-exception': {
        // The IN-BAND JSON exception line (plan §20 "Progress-format error"):
        // flush >=1 row, then an `{"exception": "..."}` line, no more rows —
        // exactly what `core/stream.ts`'s `applyStreamLine` already handles
        // for the Table/KPI streaming formats.
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write(ndjson({ meta: [{ name: 'n', type: 'String' }] }));
        res.write(ndjson({ row: { n: 'partial-before-exception' } }));
        res.write(ndjson({ exception: 'Code: 241. DB::Exception: Memory limit exceeded (in-band, mid-stream).' }));
        res.end();
        return;
      }
      case 'raw-tagged-late-exception': {
        // The RAW/export late-exception frame (plan §20 "Late raw/export
        // exception", ClickHouse >=24.11 shape) — a plain TSV body with the
        // tagged trailer appended. Neither adapter is expected to *detect*
        // this (that's `core/stream.ts`'s `findExceptionFrame`, an
        // application-level concern); this fixture instead proves neither
        // adapter's raw byte path corrupts/strips/decodes it (plan §24). The
        // tag is a FIXED 16-hex-char literal (not `randomBytes` per request):
        // the current- and official-adapter each make their OWN separate
        // HTTP request to this fixture, and the byte-hash comparison must
        // compare two responses that are bit-for-bit identical by
        // construction — a fresh random tag per request would make the two
        // adapters' bytes differ for a reason having nothing to do with
        // adapter behavior.
        const tag = 'a1b2c3d4e5f60718'; // 16 hex chars, matching prod's 16-byte tag shape
        res.writeHead(200, { 'content-type': 'text/tab-separated-values', 'x-clickhouse-exception-tag': tag });
        res.write('col1\n');
        res.write('partial-before-exception\n');
        res.write(taggedExceptionTrailer(tag, 'Code: 241. DB::Exception: Memory limit exceeded (tagged, mid-stream).'));
        res.end();
        return;
      }
      case 'raw-legacy-untagged-exception': {
        res.writeHead(200, { 'content-type': 'text/tab-separated-values' });
        res.write('col1\n');
        res.write('partial-before-legacy-exception\n');
        res.write(legacyExceptionTrailer(241, 'Memory limit exceeded (legacy, mid-stream).'));
        res.end();
        return;
      }
      case 'raw-exception-like-text-then-more-data': {
        // A false-positive probe: real exported data containing text that
        // LOOKS like an exception marker, followed by MORE real data — must
        // never be misidentified as a failure (plan §20).
        res.writeHead(200, { 'content-type': 'text/tab-separated-values' });
        res.write('col1\tcol2\n');
        res.write('a row whose comment column literally says\tCode: 999. DB::Exception: not real\n');
        res.write('another real row after the false positive\tstill fine\n');
        res.end();
        return;
      }
      case 'invalid-utf8-raw': {
        res.writeHead(200, { 'content-type': 'text/tab-separated-values' });
        // 0xFF/0xFE are never valid standalone UTF-8 lead bytes — a
        // TextDecoder would either throw or replace them, corrupting the raw
        // export's exact bytes (plan §24's "ASCII-only equality is
        // insufficient" / "no .text()/TextDecoder on the raw path").
        res.end(Buffer.from([0x61, 0x62, 0xff, 0xfe, 0x63, 0x00, 0x0a, 0x64]));
        return;
      }
      case 'kpi-progress': {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write(ndjson({ progress: { read_rows: '0', read_bytes: '0', total_rows_to_read: '1', elapsed_ns: '0' } }));
        res.write(ndjson({ row: { v: 42 } }));
        res.write(ndjson({ progress: { read_rows: '1', read_bytes: '8', total_rows_to_read: '1', elapsed_ns: '1000' } }));
        res.end();
        return;
      }
      case 'post-header-abort-hold': {
        // #630 Phase 1's native post-header cancellation-lifetime fixture
        // (plan "Detailed browser scenarios" 5-7): headers plus one complete
        // NDJSON row arrive in the same immediate write, so a real
        // `reader.read()` for it resolves right away — then the NEXT chunk is
        // held for POST_HEADER_ABORT_HOLD_MS, comfortably longer than
        // Chromium/WebKit scheduling jitter, so the test can guarantee a real
        // native second `read()` is genuinely pending when the original
        // signal is aborted. The existing ~120ms gap in
        // 'delayed-headers-scheduled-rows' is unnecessarily tight for that.
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write(ndjson({ row: { n: 'first' } }));
        await sleep(POST_HEADER_ABORT_HOLD_MS);
        res.write(ndjson({ row: { n: 'after-hold' } }));
        res.end();
        return;
      }
      case 'slow-headers': {
        // Headers themselves are delayed (plan §18 "cancel awaiting headers";
        // §21 "timeout") — unlike 'delayed-headers-scheduled-rows', where
        // headers arrive immediately and only ROWS are delayed. A caller-side
        // abort fired before this resolves proves "cancellation without
        // offline/auth mutation"; the official client's own connection-level
        // `request_timeout` (which only guards up to headers — see
        // `web_connection.js`'s `request()`, `clearTimeout` right after
        // `fetchFn` resolves) fires here too, distinctly from an AbortError.
        await sleep(2000);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write(ndjson({ meta: [{ name: 'n', type: 'String' }] }));
        res.write(ndjson({ row: { n: 'too-late' } }));
        res.end();
        return;
      }
      case 'read-reset-then-success': {
        // Plan §23 "Connection resets": "read may retry once" — attempt 1
        // resets mid-stream (after headers+one row, matching
        // 'post-header-connection-reset''s shape); attempt 2 completes
        // normally. Distinct fixture name from 'post-header-connection-reset'
        // (which always resets, every attempt) because that one instead
        // proves the ambiguous-write NO-retry case, where a second attempt
        // must never happen.
        const attempt = (attemptCounts.get(fixture) || 0) + 1;
        attemptCounts.set(fixture, attempt);
        if (attempt === 1) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.write(ndjson({ meta: [{ name: 'n', type: 'String' }] }));
          res.write(ndjson({ row: { n: 'before-reset' } }));
          req.socket.destroy();
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write(ndjson({ meta: [{ name: 'n', type: 'String' }] }));
        res.write(ndjson({ row: { n: 'ok-after-retry' } }));
        res.end();
        return;
      }
      case 'totals-extremes': {
        // Plan §18 "totals/extremes": neither adapter's `StreamLine` folding
        // recognizes `{totals}`/`{extremes}`/`{rows_before_limit_at_least}`
        // lines today (`core/stream.ts`'s `applyStreamLine` only matches
        // meta/row/progress/exception) — this fixture proves BOTH adapters
        // tolerate them as a silent no-op (never misparsed as a row, never an
        // error) rather than asserting the harness itself understands them
        // (a documented current-behavior gap, not adopted new parsing).
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write(ndjson({ meta: [{ name: 'n', type: 'String' }] }));
        res.write(ndjson({ row: { n: '1' } }));
        res.write(ndjson({ row: { n: '2' } }));
        res.write(ndjson({ totals: { n: '3' } }));
        res.write(ndjson({ extremes: { min: { n: '1' }, max: { n: '2' } } }));
        res.write(ndjson({ rows_before_limit_at_least: 2 }));
        res.write(ndjson({ progress: { read_rows: '2', read_bytes: '2', total_rows_to_read: '2', elapsed_ns: '1000' } }));
        res.end();
        return;
      }
      case 'raw-tsv-fixed': {
        res.writeHead(200, { 'content-type': 'text/tab-separated-values' });
        res.end('a\tb\n1\tx\n2\ty\n');
        return;
      }
      case 'raw-csv-fixed': {
        res.writeHead(200, { 'content-type': 'text/csv' });
        res.end('"a","b"\n"1","x"\n"2","y"\n');
        return;
      }
      case 'raw-json-fixed': {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"meta":[{"name":"a","type":"String"}],"data":[{"a":"1"},{"a":"2"}]}\n');
        return;
      }
      case 'no-output': {
        // Plan §18 "no-output command": an INSERT/DDL-shaped response — 200,
        // no body at all (matching a real ClickHouse `command()`/no-output
        // acknowledgement) — proves `command()` drains/discards without
        // hanging and issues exactly one request.
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end();
        return;
      }
      default: {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('unknown fixture: ' + fixture);
      }
    }
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        server,
        port,
        baseUrl: `http://127.0.0.1:${port}`,
        requestsLog,
        resetAttemptCounts: () => attemptCounts.clear(),
        close: () => new Promise((res2) => server.close(() => res2())),
      });
    });
  });
}

/**
 * Bind an ephemeral loopback server, read back its assigned port, then close
 * it immediately — the returned `baseUrl` therefore reliably rejects any
 * connection attempt (ECONNREFUSED) without needing real network access,
 * for the "offline rejection is classified distinctly from an HTTP query
 * error" scenario (plan §18/§21). Kept in this `.mjs` file (not
 * `parity.test.ts`) so no spike `.ts` file needs a `node:http` import —
 * matching every other Node-only usage in this spike (`@types/node` stays
 * an unrelated, un-taken repository-wide decision, per plan §8).
 */
export function closedLoopbackUrl() {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(`http://127.0.0.1:${port}`));
    });
  });
}
