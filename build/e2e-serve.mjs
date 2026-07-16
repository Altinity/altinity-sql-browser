// Static file server for the Playwright e2e harness — the python3 http.server
// it replaces, plus the ADR-0002 mixed-tree rule every other tool already
// applies (tsc, esbuild, vitest's resolveId shim): an explicit `./x.js`
// specifier resolves to `x.ts` when only the `.ts` file exists. The fixture
// pages under tests/e2e/ import raw `/src/**/*.js` modules with no bundler in
// front, so as modules convert leaf-up the harness must (a) fall back from a
// missing `.js` to its `.ts` sibling and (b) type-strip it — browsers do not
// execute TypeScript syntax. esbuild (already the build's only tool, hard
// rule 4) does the stripping in-process; dev/CI-only, nothing here ships.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { transform } from 'esbuild';

const root = resolve(process.cwd());
const port = Number(process.argv[2] || 5599);
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.map': 'application/json; charset=utf-8',
};

async function read(path) {
  try { return await readFile(path); } catch { return null; }
}

async function stripTypes(source) {
  const { code } = await transform(source.toString('utf8'), { loader: 'ts' });
  return Buffer.from(code, 'utf8');
}

createServer(async (req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, `http://127.0.0.1:${port}`).pathname);
  const path = resolve(join(root, pathname));
  if (path !== root && !path.startsWith(root + sep)) {
    res.writeHead(403).end();
    return;
  }
  let body = await read(path);
  let type = MIME[extname(path)] || 'application/octet-stream';
  if (body === null && path.endsWith('.js')) {
    // Mixed-tree fallback: the module converted; serve its type-stripped .ts.
    const ts = await read(`${path.slice(0, -3)}.ts`);
    if (ts !== null) body = await stripTypes(ts);
  } else if (body !== null && path.endsWith('.ts')) {
    // A fixture importing a .ts path directly still gets executable JS.
    body = await stripTypes(body);
    type = MIME['.js'];
  }
  if (body === null) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { 'content-type': type }).end(body);
}).listen(port, () => {
  console.log(`e2e harness serving ${root} on http://127.0.0.1:${port}`);
});
