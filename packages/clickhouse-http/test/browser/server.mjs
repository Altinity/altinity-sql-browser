// Issue #630 Phase 8 (plan §15) — a tiny, dependency-free static file server
// for this package's OWN Chromium/WebKit regression harness. It serves
// exactly two things, both real files on disk (never a bundler, never an
// import map, never source): this directory's `harness.html`, and the
// package's generated `dist/**` (built by `npm run build` — `test:browser`'s
// own npm script runs that first) — proving the harness genuinely loads the
// BUILT public barrel a real external consumer would get, at `/dist/index.js`.
//
// Usage: `node server.mjs <port>` (playwright.config.js passes the port).

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, extname, join, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, '..', '..');
const distDir = join(packageRoot, 'dist');

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

function contentTypeFor(path) {
  return CONTENT_TYPES[extname(path)] ?? 'application/octet-stream';
}

async function resolveFile(pathname) {
  if (pathname === '/' || pathname === '/harness.html') {
    return join(here, 'harness.html');
  }
  if (pathname.startsWith('/dist/')) {
    return join(distDir, pathname.slice('/dist/'.length));
  }
  return null;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const filePath = await resolveFile(url.pathname);
  if (!filePath) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found: ' + url.pathname);
    return;
  }
  try {
    const body = await readFile(filePath);
    res.writeHead(200, { 'content-type': contentTypeFor(filePath) });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found: ' + url.pathname);
  }
});

const port = Number(process.argv[2]) || 0;
server.listen(port, '127.0.0.1', () => {
  const { port: boundPort } = server.address();
  console.log(`@altinity/clickhouse-http browser harness server listening on http://127.0.0.1:${boundPort}`);
});
