// Phase 0 / issue #585, plan §14 "Same-origin, CORS, and browser harness" and
// §26 "CSP and self-contained artifact". A dedicated Node HTTP server for the
// Playwright browser matrix (`browser.spec.js`, `playwright.config.js`):
//
//   * a streaming, header-routed reverse proxy at `/` (same-origin mode —
//     see "ROUTING" below for why this is NOT `/__clickhouse/<row>` as a URL
//     PATH, despite that being this plan section's illustrative shape);
//   * the browser-facing static harness (`browser-harness.html` +
//     type-stripped `browser-harness.ts`, plus every spike `.ts` module it
//     transitively imports — `progress-bridge.ts`, `normalize.ts`,
//     `../../../src/core/stream.ts` — reusing `build/e2e-serve.mjs`'s exact
//     `.js` → `.ts` fallback-and-strip convention so the browser never
//     executes TypeScript syntax);
//   * a local, esbuild-bundled ESM wrapper around the VERIFIED installed
//     `@clickhouse/client-web@1.23.1` entry, resolved through Node's own
//     `node_modules` resolution (reading this package's own `package.json`
//     "exports" — never a hand-guessed path, never a CDN);
//   * `/__rows.json`, letting `browser.spec.js` (Node-side) and the harness
//     page (browser-side) learn the booted row(s)' cross-origin URL and
//     non-secret fixture credentials from one source of truth.
//
// Kept as plain `.mjs` (not `.ts`) per plan §8: Node orchestration/
// configuration files stay untyped.
//
// ROUTING (why a header, not a URL path segment): plan §14's illustrative
// shape is `/__clickhouse/<matrix-row> -> streaming reverse proxy`. That
// EXACT shape is incompatible with installed 1.23.1, verified by reading
// `node_modules/@clickhouse/client-web/dist/common/config.js`
// (`loadConfigOptionsFromURL`): any `url` passed to `createClient()` whose
// `pathname` is longer than "/" is NOT preserved as the HTTP request path —
// it is silently reinterpreted as `config.database` and re-serialized as a
// `?database=...` QUERY PARAMETER instead (`toSearchParams` in
// `dist/common/utils/url.js`). A client constructed with
// `url: ".../__clickhouse/current-stable-oss/"` would send every query
// against a nonexistent "__clickhouse/current-stable-oss" database and fail
// EVERY request — this is the exact hazard `fault-server.mjs`'s own header
// comment already documents ("routing by URL path is therefore not viable").
// This module instead keeps the client's `url` at the literal origin root
// (`http://127.0.0.1:<port>/`, pathname length 1 — never treated as a
// database) and lets the harness select a row via a client-level
// `http_headers` default (`x-asb-spike-row`), which installed 1.23.1's own
// `WebConnection#defaultHeadersWithOverride` merges into every outgoing
// request unmodified (verified in the same file — only `Authorization` is
// ever overwritten last, per `official-adapter.ts`'s own header comment).
// This header is stripped before forwarding upstream — ClickHouse itself
// never sees it — and is never logged (see `proxyToRow` below).
//
// The direct cross-origin mode needs none of this: the browser's client
// there is constructed with the row's OWN loopback URL (already exactly
// `http://127.0.0.1:<chPort>/` from `clickhouse-containers.mjs` — pathname
// length 1, no proxy involved at all), relying purely on the CORS
// configuration `clickhouse-containers.mjs` already bakes into every row.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve, sep, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { transform, build } from 'esbuild';
import { startRow } from './clickhouse-containers.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');

// Single source of truth for the port both `playwright.config.js` and
// `browser.spec.js` reference (cross-file comment, not a shared runtime
// import, matching `clickhouse-containers.mjs`/`auth-fixtures.ts`'s own
// documented .mjs/.ts cross-reference precedent — a plain `.mjs` config file
// cannot import a `.ts` module under a bare `node`/Playwright-config
// invocation).
export const DEFAULT_PORT = 5680;
const PORT = Number(process.env.ASB_SPIKE_SERVER_PORT || DEFAULT_PORT);

// Plan §25's full matrix names four local rows; the default here is
// deliberately narrow (this sub-task's doneWhen only requires
// "current-stable-oss") — set ASB_SPIKE_BROWSER_ROWS to a comma-separated
// list (matching matrix.json's row keys) to run the full local matrix.
const ROW_KEYS = (process.env.ASB_SPIKE_BROWSER_ROWS || 'current-stable-oss')
  .split(',').map((s) => s.trim()).filter(Boolean);

// MUST stay byte-identical to browser-harness.ts's own `ROW_HEADER_NAME`
// constant — cross-referenced by comment, not a shared import (see this
// file's header docstring for why: browser-harness.ts is only ever loaded
// through the browser's type-stripped fetch path, never imported by a
// plain Node `.mjs` file).
const ROW_HEADER = 'x-asb-spike-row';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

async function read(path) {
  try { return await readFile(path); } catch { return null; }
}

async function stripTypes(source) {
  const { code } = await transform(source.toString('utf8'), { loader: 'ts' });
  return Buffer.from(code, 'utf8');
}

// ── Local ESM wrapper around the installed @clickhouse/client-web ──────────
// Installed 1.23.1 ships plain CommonJS (`dist/index.js`: "use strict";
// `exports.foo = ...`) — verified by reading its own `package.json`
// ("exports": {"default": "./dist/index.js"}, no "type": "module"). A
// browser cannot `import` that file directly (no CJS interop). This bundles
// it, through esbuild (the repository's only build tool — CLAUDE.md hard
// rule 4), into one self-contained ESM file exposing exactly the named
// bindings `browser-harness.ts` imports, resolved via a NAMESPACE import
// (`import * as mod from ...`) rather than a default import — verified
// empirically while building this module: esbuild's CJS-default-import
// interop (`__toESM(mod, isNodeMode)`) only sets `.default` to the whole
// `module.exports` when `isNodeMode` is true (`platform: 'node'`); under
// `platform: 'browser'` (correct for this artifact) a default import of a
// `__esModule`-flagged CommonJS module resolves `.default` to `undefined`.
// The namespace-import form copies the CJS module's own enumerable
// properties directly onto the namespace object regardless of platform, so
// `mod.createClient` etc. are the real bindings either way. Resolution goes
// through esbuild's own `resolveDir: repoRoot`, i.e. Node's real
// `node_modules` + "exports"-map algorithm — never a hand-written path,
// never a CDN.
const CLIENT_WEB_ENTRY_SOURCE = [
  "import * as mod from '@clickhouse/client-web';",
  'export const createClient = mod.createClient;',
  'export const ClickHouseError = mod.ClickHouseError;',
  'export const isProgressRow = mod.isProgressRow;',
  'export const isRow = mod.isRow;',
].join('\n');

let clientWebBundlePromise = null;
function clientWebBundle() {
  if (!clientWebBundlePromise) {
    clientWebBundlePromise = build({
      stdin: { contents: CLIENT_WEB_ENTRY_SOURCE, resolveDir: repoRoot, sourcefile: 'client-web-browser-entry.js', loader: 'js' },
      bundle: true,
      format: 'esm',
      platform: 'browser',
      target: 'es2022',
      absWorkingDir: repoRoot,
      write: false,
    }).then((result) => result.outputFiles[0].text);
  }
  return clientWebBundlePromise;
}

// ── Row boot / registry ─────────────────────────────────────────────────────

/** rowKey -> Handle (from clickhouse-containers.mjs's startRow). */
const rows = new Map();
let ready = false;
let bootError = null;

/** Tracked so `shutdown()` can await an IN-FLIGHT boot before exiting —
 * without this, a SIGTERM that arrives while `startRow()` is between
 * `docker run` and being registered into `rows` would leak a live
 * container: `clickhouse-containers.mjs`'s own `startRow` already cleans up
 * after ITSELF on failure, but only if its promise gets to settle, which a
 * `process.exit()` called before it settles would prevent. Verified
 * empirically while building this module (an early SIGTERM during a real
 * boot left exactly this orphaned container; recorded here so the fix isn't
 * silently re-broken). */
let bootPromise = null;

async function bootRows() {
  for (const rowKey of ROW_KEYS) {
    process.stderr.write(`spike-server: booting row "${rowKey}" (this can take up to ~2 minutes on a cold Docker pull/start)...\n`);
    // eslint-disable-next-line no-await-in-loop -- rows boot sequentially; Docker cold start in this sandbox is the bottleneck, not parallelism.
    const handle = await startRow(rowKey);
    rows.set(rowKey, handle);
    process.stderr.write(`spike-server: row "${rowKey}" ready at ${handle.url} (server ${handle.serverVersion})\n`);
  }
  ready = true;
}

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  process.stderr.write(`spike-server: received ${signal}, waiting for any in-flight boot to settle before cleanup...\n`);
  if (bootPromise) await bootPromise.catch(() => {});
  process.stderr.write(`spike-server: stopping ${rows.size} row(s)...\n`);
  await Promise.all([...rows.values()].map((h) => h.stop().catch(() => {})));
  process.exit(0);
}
process.on('SIGTERM', () => { shutdown('SIGTERM'); });
process.on('SIGINT', () => { shutdown('SIGINT'); });

// ── Reverse proxy (plan §14: preserve method/body/status/headers, stream
// the response without text-decoding or buffering, never log Authorization) ──

async function proxyToRow(req, res) {
  const rowKey = req.headers[ROW_HEADER];
  const handle = rowKey ? rows.get(String(rowKey)) : undefined;
  if (!handle) {
    // Never echo back the request's own headers here — even an "unknown
    // row" error must not become an accidental credential log.
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end(`spike-server: missing or unknown "${ROW_HEADER}" header`);
    return;
  }
  const incoming = new URL(req.url, 'http://internal/');
  const target = new URL(handle.url);
  target.search = incoming.search;

  const headers = {};
  for (const [key, value] of Object.entries(req.headers)) {
    const lower = key.toLowerCase();
    // Hop-by-hop / framing headers this leg must not forward verbatim, plus
    // the routing header itself (ClickHouse has no use for it and must
    // never see it).
    if (['host', 'connection', 'content-length', 'transfer-encoding', ROW_HEADER].includes(lower)) continue;
    headers[key] = value;
  }
  // Force uncompressed upstream delivery: Node's built-in fetch (unlike a
  // real browser's) fully buffers a gzip-compressed streaming response
  // before yielding any chunk to the reader (independently discovered and
  // documented in live-parity.test.ts) — that would silently defeat this
  // proxy's whole progressive-first-row purpose. This affects only the
  // proxy's OWN outgoing fetch below, never what the browser itself
  // requests from ClickHouse directly in cross-origin mode (a real
  // browser's fetch streams compressed bodies progressively regardless).
  headers['accept-encoding'] = 'identity';

  // Buffer the (always small — SQL text/params, never a bulk INSERT in this
  // harness) request body; only the RESPONSE direction has this module's
  // no-buffering requirement (plan §14).
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = chunks.length && !['GET', 'HEAD'].includes(req.method) ? Buffer.concat(chunks) : undefined;

  let upstream;
  try {
    upstream = await fetch(target, { method: req.method, headers, body });
  } catch (err) {
    // Log the caught error's own message to stderr only (Playwright's
    // `webServer` captures this as `[WebServer]` output — issue #585
    // observability-gap fix, so a real proxy-level failure isn't as
    // unrecoverable as it used to be); never send it to the CLIENT, and
    // never log request/response headers or bodies (this proxy carries real
    // ClickHouse traffic) — a generic 502 remains the client-facing response.
    process.stderr.write(`spike-server: proxy fetch to row "${rowKey}" failed: ${err instanceof Error ? err.message : String(err)}\n`);
    res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' }).end('spike-server: upstream fetch failed');
    return;
  }

  const outHeaders = {};
  upstream.headers.forEach((value, key) => {
    if (key === 'connection' || key === 'transfer-encoding') return;
    outHeaders[key] = value;
  });
  res.writeHead(upstream.status, outHeaders);
  if (!upstream.body) { res.end(); return; }
  const reader = upstream.body.getReader();
  for (;;) {
    // eslint-disable-next-line no-await-in-loop -- this IS the streaming relay; each chunk must reach the client as it arrives, never buffered.
    const { done, value } = await reader.read();
    if (done) break;
    res.write(value);
  }
  res.end();
}

// ── Static file serving (repo root), reusing build/e2e-serve.mjs's exact
// .js -> .ts fallback-and-strip convention so the browser never sees
// TypeScript syntax. ──────────────────────────────────────────────────────

async function serveStatic(req, res, pathname) {
  const filePath = resolve(join(repoRoot, pathname));
  if (filePath !== repoRoot && !filePath.startsWith(repoRoot + sep)) { res.writeHead(403).end(); return; }
  let body = await read(filePath);
  let type = MIME[extname(filePath)] || 'application/octet-stream';
  if (body === null && filePath.endsWith('.js')) {
    const ts = await read(`${filePath.slice(0, -3)}.ts`);
    if (ts !== null) body = await stripTypes(ts);
  } else if (body !== null && filePath.endsWith('.ts')) {
    body = await stripTypes(body);
    type = MIME['.js'];
  }
  if (body === null) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'content-type': type }).end(body);
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://internal/');
    const pathname = decodeURIComponent(url.pathname);
    if (pathname === '/__health') {
      res.writeHead(ready ? 200 : (bootError ? 500 : 503), { 'content-type': 'text/plain; charset=utf-8' })
        .end(bootError ? `boot failed: ${bootError}` : (ready ? 'ready' : 'booting'));
      return;
    }
    if (pathname === '/__rows.json') {
      const info = {};
      for (const [key, handle] of rows) {
        info[key] = {
          crossOriginUrl: handle.url,
          admin: handle.admin,
          fixtureUsers: handle.fixtureUsers,
          role: handle.role,
          serverVersion: handle.serverVersion,
        };
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify(info));
      return;
    }
    if (pathname === '/__clickhouse-client-web.mjs') {
      const text = await clientWebBundle();
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' }).end(text);
      return;
    }
    // Reserved exclusively for the ClickHouse proxy — the vendor client
    // always requests the connection URL's own root pathname (see this
    // file's header docstring), so `/` can never collide with a real static
    // asset path (every asset this harness serves lives under
    // `/tests/spike/clickhouse-client/...` or `/src/...`).
    if (pathname === '/') {
      await proxyToRow(req, res);
      return;
    }
    await serveStatic(req, res, pathname);
  } catch (err) {
    // Log the caught error's own message to stderr only (Playwright's
    // `webServer` captures this as `[WebServer]` output — issue #585
    // observability-gap fix); never forward it to the CLIENT, and never log
    // request/response headers or bodies, which could embed real request
    // details from proxyToRow's own body — a generic 500 remains the
    // client-facing response.
    process.stderr.write(`spike-server: request handler error: ${err instanceof Error ? err.message : String(err)}\n`);
    if (!res.headersSent) res.writeHead(500).end('internal error');
  }
});

function isMainModule() {
  return import.meta.url === `file://${process.argv[1]}`;
}

if (isMainModule()) {
  server.listen(PORT, '127.0.0.1', () => {
    process.stderr.write(`spike-server: listening on http://127.0.0.1:${PORT} (rows: ${ROW_KEYS.join(', ')})\n`);
    bootPromise = bootRows().catch((e) => {
      bootError = e instanceof Error ? e.message : String(e);
      process.stderr.write(`spike-server: row boot failed: ${bootError}\n`);
    });
  });
}
