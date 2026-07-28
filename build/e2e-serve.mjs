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
const oauthRecoveryRoot = '/tests/e2e/oauth-document-recovery';
const oauthRecoveryPage = `${oauthRecoveryRoot}/index.html`;
const oauthRecoveryConfig = `${oauthRecoveryRoot}/config.json`;
const oauthRecoveryOidc = `${oauthRecoveryRoot}/oidc`;
const oauthRecoveryCh = `${oauthRecoveryRoot}/ch`;
const oauthRecoveryClient = 'fixture-client';
const oauthRecoveryCode = 'fixture-code';
const maxFixtureBodyBytes = 64 * 1024;

function json(res, value, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify(value));
}

function fixtureToken() {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none' })}.${encode({
    email: 'recovery@example.test', exp: Math.floor(Date.now() / 1000) + 3600,
  })}.sig`;
}

async function requestBody(req, limit = maxFixtureBodyBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function read(path) {
  try { return await readFile(path); } catch { return null; }
}

async function stripTypes(source) {
  const { code } = await transform(source.toString('utf8'), { loader: 'ts' });
  return Buffer.from(code, 'utf8');
}

createServer(async (req, res) => {
  const origin = `http://127.0.0.1:${port}`;
  const url = new URL(req.url, origin);
  const pathname = decodeURIComponent(url.pathname);
  // Isolated real-browser OAuth recovery fixture (#512 Phase 3). These are
  // deliberately server routes rather than Playwright interception so the app
  // follows its normal config discovery, authorization redirect, token exchange
  // and ClickHouse 401 paths across real documents.
  if (pathname === oauthRecoveryConfig && req.method === 'GET') {
    json(res, {
      idps: [{ id: 'fixture', label: 'Fixture SSO', issuer: `${origin}${oauthRecoveryOidc}`, client_id: oauthRecoveryClient }],
      basic_login: false,
    });
    return;
  }
  if (pathname === `${oauthRecoveryOidc}/.well-known/openid-configuration` && req.method === 'GET') {
    json(res, {
      authorization_endpoint: `${origin}${oauthRecoveryOidc}/authorize`,
      token_endpoint: `${origin}${oauthRecoveryOidc}/token`,
    });
    return;
  }
  if (pathname === `${oauthRecoveryOidc}/authorize` && req.method === 'GET') {
    const redirectUri = url.searchParams.get('redirect_uri');
    const state = url.searchParams.get('state');
    if (
      redirectUri !== origin + oauthRecoveryPage
      || url.searchParams.get('client_id') !== oauthRecoveryClient
      || url.searchParams.get('response_type') !== 'code'
      || url.searchParams.get('code_challenge_method') !== 'S256'
      || !url.searchParams.get('code_challenge')
      || !state
    ) {
      res.writeHead(400).end('invalid authorize request');
      return;
    }
    const callback = new URL(origin + oauthRecoveryPage);
    callback.searchParams.set('code', oauthRecoveryCode);
    callback.searchParams.set('state', state);
    res.writeHead(302, { location: callback.href }).end();
    return;
  }
  if (pathname === `${oauthRecoveryOidc}/token` && req.method === 'POST') {
    const body = await requestBody(req);
    if (body === null) {
      res.writeHead(413).end('request body too large');
      return;
    }
    const form = new URLSearchParams(body);
    if (
      form.get('grant_type') !== 'authorization_code'
      || form.get('code') !== oauthRecoveryCode
      || form.get('redirect_uri') !== origin + oauthRecoveryPage
      || form.get('client_id') !== oauthRecoveryClient
      || !form.get('code_verifier')
    ) {
      res.writeHead(400).end('invalid token request');
      return;
    }
    json(res, { id_token: fixtureToken() });
    return;
  }
  if (req.method === 'POST' && pathname === oauthRecoveryCh) {
    const body = await requestBody(req);
    if (body === null) {
      res.writeHead(413).end('request body too large');
      return;
    }
    if (body.includes('E2E_FORCE_AUTH_LOSS')) {
      res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' }).end('Code: 516. Authentication failed');
      return;
    }
    // Catalog/version reads are real application traffic but must not consume
    // the fixture's deliberate first-contact 401.
    json(res, { data: [{ v: '25.1.0', u: 1 }] });
    return;
  }
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
}).listen(port, '127.0.0.1', () => {
  console.log(`e2e harness serving ${root} on http://127.0.0.1:${port}`);
});
