// Phase 0 / issue #585, plan §14 "Same-origin, CORS, and browser harness"
// and §25 "Browser and deployment matrix" — the actual Chromium/WebKit
// coverage plan §25's table requires per row/origin: client construction,
// ordinary query, progressive first row, request-local Basic auth,
// cancellation during streaming, response headers, query ID, raw bytes, and
// a network recorder proving no external runtime import. Driven through
// `spike-server.mjs` (started by `playwright.config.js`'s `webServer`),
// which owns the real Docker ClickHouse row(s) for this run.
//
// ASB_SPIKE_BROWSER_ROWS selects which matrix.json row(s) to cover — MUST
// stay in sync with spike-server.mjs's own read of the same variable (both
// default to "current-stable-oss" alone; this sub-task's doneWhen only
// requires that one row — set the variable to a comma-separated list
// matching plan §25's full table to cover the rest).
import { test, expect } from '@playwright/test';
import { createHash, randomBytes } from 'node:crypto';
import { createServer as createHttpServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, chmod, rm, readFile as readFileAsync } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildArtifact } from '../../../build/build.mjs';

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');

const ROW_KEYS = (process.env.ASB_SPIKE_BROWSER_ROWS || 'current-stable-oss')
  .split(',').map((s) => s.trim()).filter(Boolean);

// Independently-computed expected raw bytes for browser-harness.ts's
// `rawBytes` scenario's exact literal query — never derived from either
// adapter's own output (this repo's "independent expected outcome"
// convention, plan §15).
const RAW_BYTES_EXPECTED_TEXT = '0\t0\n1\t1\n2\t2\n';
const RAW_BYTES_EXPECTED_SHA256 = createHash('sha256').update(RAW_BYTES_EXPECTED_TEXT, 'utf8').digest('hex');
const RAW_BYTES_EXPECTED_LENGTH = Buffer.byteLength(RAW_BYTES_EXPECTED_TEXT, 'utf8');

/** @type {Record<string, { crossOriginUrl: string, admin: {username:string,password:string}, fixtureUsers: Record<string, {username:string,password:string}>, role: string, serverVersion: string }>} */
let rowsInfo;

test.beforeAll(async ({ baseURL }) => {
  const resp = await fetch(`${baseURL}/__rows.json`);
  if (!resp.ok) throw new Error(`spike-server.mjs /__rows.json returned HTTP ${resp.status} — is it still booting? check /__health`);
  rowsInfo = await resp.json();
  for (const rowKey of ROW_KEYS) {
    if (!rowsInfo[rowKey]) {
      throw new Error(`spike-server.mjs did not boot row "${rowKey}" (booted: ${Object.keys(rowsInfo).join(', ') || 'none'}) — set ASB_SPIKE_BROWSER_ROWS to match on both sides`);
    }
  }
});

// Plan §14 "records browser versions" — printed to the Playwright test log
// (docs/evidence/585/environment.json's own capture of this is a later
// sub-task's job, per this plan's execution order §34.G/H).
test('records the launched browser version', async ({ page, browserName }) => {
  const version = page.context().browser()?.version() ?? 'unknown';
  // eslint-disable-next-line no-console
  console.log(`asb585 browser matrix: ${browserName} ${version}`);
  expect(version.length).toBeGreaterThan(0);
});

for (const rowKey of ROW_KEYS) {
  for (const mode of ['same-origin', 'cross-origin']) {
    test.describe(`row=${rowKey} origin=${mode}`, () => {
      /** @type {string} */
      let targetUrl;
      /** @type {string | undefined} */
      let rowHeader;
      /** @type {Set<string>} */
      let seenOrigins;
      /** @type {string} */
      let pageOrigin;

      test.beforeEach(async ({ page, baseURL }) => {
        if (mode === 'same-origin') {
          // The proxy lives at spike-server.mjs's own origin root; row
          // selection happens via the client-level http_headers default
          // browser-harness.ts wires up from `rowHeader` — see
          // spike-server.mjs's header docstring for why this is a header,
          // never a URL path segment.
          targetUrl = baseURL;
          rowHeader = rowKey;
        } else {
          // Direct cross-origin mode: the row's OWN loopback URL, a
          // different port from spike-server.mjs's own origin — genuinely
          // cross-origin by the browser's own origin model, relying purely
          // on clickhouse-containers.mjs's CORS configuration.
          targetUrl = rowsInfo[rowKey].crossOriginUrl;
          rowHeader = undefined;
        }
        seenOrigins = new Set();
        page.on('request', (req) => {
          try { seenOrigins.add(new URL(req.url()).origin); } catch { /* non-HTTP scheme (e.g. about:) — ignore */ }
        });
        await page.goto('/tests/spike/clickhouse-client/browser-harness.html');
        await page.waitForFunction(() => window.__spikeReady === true);
        pageOrigin = new URL(page.url()).origin;
        // Sanity: the two modes really do exercise different origin
        // relationships — a same-origin test whose target isn't actually
        // same-origin (or vice versa) would silently validate nothing.
        const targetOrigin = new URL(targetUrl).origin;
        if (mode === 'same-origin') expect(targetOrigin).toBe(pageOrigin);
        else expect(targetOrigin).not.toBe(pageOrigin);
      });

      test('client construction', async ({ page }) => {
        const result = await page.evaluate(
          ({ url, header }) => window.__spikeRun({ scenario: 'construct', url, rowHeader: header }),
          { url: targetUrl, header: rowHeader },
        );
        expect(result.ok, result.error).toBe(true);
      });

      test('ordinary query', async ({ page }) => {
        const auth = rowsInfo[rowKey].fixtureUsers.basicA;
        const result = await page.evaluate(
          ({ url, header, auth: a }) => window.__spikeRun({ scenario: 'ordinaryQuery', url, rowHeader: header, auth: a }),
          { url: targetUrl, header: rowHeader, auth },
        );
        expect(result.ok, result.error).toBe(true);
        expect(result.rowCount).toBe(5);
      });

      test('progressive first row', async ({ page }) => {
        const auth = rowsInfo[rowKey].fixtureUsers.basicA;
        const result = await page.evaluate(
          ({ url, header, auth: a }) => window.__spikeRun({ scenario: 'progressiveFirstRow', url, rowHeader: header, auth: a }),
          { url: targetUrl, header: rowHeader, auth },
        );
        expect(result.ok, result.error).toBe(true);
        expect(result.rowCount).toBe(6);
        expect(result.progressive, JSON.stringify(result)).toBe(true);
      });

      test('request-local Basic auth', async ({ page }) => {
        const { basicA, basicB } = rowsInfo[rowKey].fixtureUsers;
        const result = await page.evaluate(
          ({ url, header, auth, authB }) => window.__spikeRun({ scenario: 'basicAuth', url, rowHeader: header, auth, authB }),
          { url: targetUrl, header: rowHeader, auth: basicA, authB: basicB },
        );
        expect(result.ok, result.error).toBe(true);
        expect(result.matchesA).toBe(true);
        expect(result.matchesB).toBe(true);
        expect(result.defaultRejected, 'the client-level default (deliberately invalid) credential must never become authoritative').toBe(true);
      });

      test('cancellation during streaming', async ({ page }) => {
        const auth = rowsInfo[rowKey].fixtureUsers.basicA;
        const result = await page.evaluate(
          ({ url, header, auth: a }) => window.__spikeRun({ scenario: 'cancelDuringStreaming', url, rowHeader: header, auth: a }),
          { url: targetUrl, header: rowHeader, auth },
        );
        expect(result.ok, result.error).toBe(true);
        expect(result.cancelled).toBe(true);
        expect(result.rowCountAtAbort).toBeLessThan(40);
        expect(result.noLaterRows, JSON.stringify(result)).toBe(true);
      });

      test('response headers', async ({ page }) => {
        const auth = rowsInfo[rowKey].fixtureUsers.basicA;
        const result = await page.evaluate(
          ({ url, header, auth: a }) => window.__spikeRun({ scenario: 'responseHeaders', url, rowHeader: header, auth: a }),
          { url: targetUrl, header: rowHeader, auth },
        );
        expect(result.ok, result.error).toBe(true);
        expect(result.hasSummary, JSON.stringify(result.headers)).toBe(true);
        expect(result.hasQueryId, JSON.stringify(result.headers)).toBe(true);
      });

      test('query ID', async ({ page }) => {
        const auth = rowsInfo[rowKey].fixtureUsers.basicA;
        const result = await page.evaluate(
          ({ url, header, auth: a }) => window.__spikeRun({ scenario: 'queryId', url, rowHeader: header, auth: a }),
          { url: targetUrl, header: rowHeader, auth },
        );
        expect(result.ok, result.error).toBe(true);
        expect(result.matches, JSON.stringify(result)).toBe(true);
        expect(result.headerQueryId).toBe(result.callerId);
      });

      test('raw bytes', async ({ page }) => {
        const auth = rowsInfo[rowKey].fixtureUsers.basicA;
        const result = await page.evaluate(
          ({ url, header, auth: a }) => window.__spikeRun({ scenario: 'rawBytes', url, rowHeader: header, auth: a }),
          { url: targetUrl, header: rowHeader, auth },
        );
        expect(result.ok, result.error).toBe(true);
        expect(result.length).toBe(RAW_BYTES_EXPECTED_LENGTH);
        expect(result.sha256).toBe(RAW_BYTES_EXPECTED_SHA256);
      });

      test('no external runtime import', async ({ page }) => {
        // Drive one real request through the page so there is real traffic
        // to inspect, not just the static page load.
        const auth = rowsInfo[rowKey].fixtureUsers.basicA;
        await page.evaluate(
          ({ url, header, auth: a }) => window.__spikeRun({ scenario: 'ordinaryQuery', url, rowHeader: header, auth: a }),
          { url: targetUrl, header: rowHeader, auth },
        );
        const targetOrigin = new URL(targetUrl).origin;
        const allowed = new Set([pageOrigin, targetOrigin]);
        for (const origin of seenOrigins) {
          expect(allowed.has(origin), `unexpected network origin observed: ${origin} (allowed: ${[...allowed].join(', ')})`).toBe(true);
        }
        // The bundled client-web module itself is served from the page's
        // own origin (spike-server.mjs's /__clickhouse-client-web.mjs), so a
        // real request for it must appear in the recorder — proving the
        // recorder is actually observing traffic, not vacuously empty.
        expect(seenOrigins.has(pageOrigin)).toBe(true);
      });
    });
  }
}

// ── Plan §26 "CSP and self-contained artifact" ──────────────────────────────
// The candidate build (§9 "Candidate entry") already proves, at the metafile
// level, that `@clickhouse/client-web` CAN be bundled into one self-contained
// artifact (`tests/unit/client-web-spike-policy.test.js`, part of the
// normal coverage-gated `npm test` tree). What that unit test CANNOT prove —
// happy-dom enforces no CSP and makes no real network calls — is that the
// resulting artifact actually RUNS, in a real browser, under a real CSP
// header, with zero external traffic. That is this section's job, covering
// both plan §26 serving modes: "local static" (a bare directory server, no
// CSP header at all — the baseline self-containment proof) and the
// "existing... Caddy/container deployment shape" (the REAL, unmodified
// `deploy/caddy/Caddyfile` served by the cached `caddy:2.8.4-alpine` base
// image this repository's own Dockerfile also starts from — never a
// reimplemented policy, and never touching the repository's own `dist/` or
// the real deployment image).

const CANDIDATE_ENTRY = 'tests/spike/clickhouse-client/candidate-entry.ts';
const CANDIDATE_NOTICES_PATH = resolve(repoRoot, 'tests/spike/clickhouse-client/candidate-third-party-notices.md');
const PACKAGE_INPUT_RE = /^node_modules\/@clickhouse\/client-web\//;
// Deliberately empty: this check has no real IdP/ClickHouse host to allow,
// so the CSP's connect-src stays 'self'-only — plan §26 "normal CSP,
// changing only required connect-src" (here, nothing is required).
const CANDIDATE_CONNECT_SRC = '';
const CANDIDATE_CONFIG_JSON = JSON.stringify({ basic_login: true, idps: [] });

async function docker(args) {
  const { stdout } = await execFileAsync('docker', args, { maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

/** A bare, no-CSP-header, no-compression static directory server — plan
 * §26's "local static mode". Deliberately minimal: this mode's only job is
 * proving self-containment independent of any CSP enforcement. */
function serveDirectoryStatic(dir) {
  return createHttpServer(async (req, res) => {
    const url = new URL(req.url, 'http://internal/');
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === '/') pathname = '/sql.html';
    const filePath = join(dir, pathname.replace(/^\/+/, ''));
    if (resolve(filePath) !== resolve(dir) && !resolve(filePath).startsWith(resolve(dir) + '/')) { res.writeHead(403).end(); return; }
    try {
      const body = await readFileAsync(filePath);
      const type = extname(filePath) === '.json' ? 'application/json; charset=utf-8' : 'text/html; charset=utf-8';
      res.writeHead(200, { 'content-type': type }).end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
}

function listenEphemeral(server) {
  return new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolvePromise(server.address().port));
  });
}

/** Boots the cached `caddy:2.8.4-alpine` base image (the exact base this
 * repository's own Dockerfile builds from) against the REAL, unmodified
 * `deploy/caddy/Caddyfile`, bind-mounting only the candidate artifact and a
 * minimal external-reference-free `config.json` — never the repository's
 * real `dist/`, never a rewritten Caddyfile. Every bind source lives under
 * `$TMPDIR` (the caller's `candidateDir`), matching this repo's Docker
 * sandbox rule everywhere else. Waits for `/healthz` before returning. */
async function bootCandidateCaddy(candidateDir) {
  const name = `asb585-candidate-caddy-${randomBytes(4).toString('hex')}`;
  await docker([
    'run', '-d', '--name', name,
    '--label', 'com.altinity.sql-browser.spike585.candidate=1',
    '-p', '127.0.0.1::8080',
    '-v', `${join(candidateDir, 'sql.html')}:/app/sql.html:ro`,
    '-v', `${resolve(repoRoot, 'deploy/caddy/Caddyfile')}:/etc/caddy/Caddyfile:ro`,
    '-v', `${join(candidateDir, 'config.json')}:/config/config.json:ro`,
    '-e', `CONNECT_SRC=${CANDIDATE_CONNECT_SRC}`,
    'caddy:2.8.4-alpine',
  ]);
  const stop = async () => { try { await docker(['rm', '-f', name]); } catch { /* best-effort */ } };
  try {
    const portOut = await docker(['port', name, '8080/tcp']);
    const port = Number(portOut.trim().split('\n')[0].split(':').pop());
    const deadline = Date.now() + 30_000;
    for (;;) {
      try {
        const resp = await fetch(`http://127.0.0.1:${port}/healthz`);
        if (resp.ok) break;
      } catch { /* still starting */ }
      if (Date.now() > deadline) throw new Error('asb585-candidate-caddy: /healthz never became ready');
      // eslint-disable-next-line no-await-in-loop -- polling readiness, not a hot loop.
      await new Promise((r) => setTimeout(r, 300));
    }
    return { name, port, stop };
  } catch (e) {
    await stop();
    throw e;
  }
}

/** Every `securitypolicyviolation` DOM event, captured from the very first
 * script tick — more reliable across Chromium/WebKit than scraping console
 * text, and works whether or not a real CSP header is present (an
 * unenforced page fires none, which is itself a meaningful assertion for
 * the local-static mode below). */
async function withViolationRecorder(page) {
  await page.addInitScript(() => {
    window.__cspViolations = [];
    document.addEventListener('securitypolicyviolation', (e) => {
      window.__cspViolations.push({ blockedURI: e.blockedURI, violatedDirective: e.violatedDirective });
    });
  });
}

async function readViolations(page) {
  return page.evaluate(() => window.__cspViolations ?? []);
}

test.describe('candidate artifact — CSP and self-containment (plan §26)', () => {
  /** @type {string} */
  let candidateDir;
  /** @type {import('../../../build/build.mjs').BuildArtifactResult} */
  let candidateBuild;
  /** @type {{ metafile: import('esbuild').Metafile }} */
  let normalBuild;

  test.beforeAll(async () => {
    const additionalNotices = await readFileAsync(CANDIDATE_NOTICES_PATH, 'utf8');
    [candidateBuild, normalBuild] = await Promise.all([
      buildArtifact({ entryPoint: CANDIDATE_ENTRY, metafile: true, additionalNotices }),
      buildArtifact({ metafile: true }),
    ]);
    candidateDir = await mkdtemp(join(tmpdir(), 'asb585-candidate-'));
    const htmlPath = join(candidateDir, 'sql.html');
    const configPath = join(candidateDir, 'config.json');
    await writeFile(htmlPath, candidateBuild.html);
    await writeFile(configPath, CANDIDATE_CONFIG_JSON);
    // Bind-mounted read-only into a container that may run as a non-root
    // uid (this repo's own Dockerfile's uid 101) — world-readable, matching
    // that Dockerfile's own `chmod 0644` step for the exact same reason.
    await chmod(htmlPath, 0o644);
    await chmod(configPath, 0o644);
  });

  test.afterAll(async () => {
    if (candidateDir) await rm(candidateDir, { recursive: true, force: true });
  });

  test('normal build excludes @clickhouse/client-web; candidate includes it; both are one self-contained HTML file', async () => {
    const candidateInputs = Object.keys(candidateBuild.metafile.inputs);
    const normalInputs = Object.keys(normalBuild.metafile.inputs);
    expect(candidateInputs.some((p) => PACKAGE_INPUT_RE.test(p))).toBe(true);
    expect(normalInputs.some((p) => PACKAGE_INPUT_RE.test(p))).toBe(false);
    for (const html of [candidateBuild.html, normalBuild.html]) {
      expect(html).not.toMatch(/<script[^>]*\ssrc\s*=/i);
      expect(html).not.toMatch(/<link[^>]*\shref\s*=\s*["'](https?:)?\/\//i);
    }
  });

  test('local-static mode: candidate loads with zero external network requests', async ({ browser }) => {
    const server = serveDirectoryStatic(candidateDir);
    const port = await listenEphemeral(server);
    const page = await browser.newPage();
    try {
      await withViolationRecorder(page);
      const seenOrigins = new Set();
      page.on('request', (req) => { try { seenOrigins.add(new URL(req.url()).origin); } catch { /* ignore */ } });
      await page.goto(`http://127.0.0.1:${port}/`);
      await page.waitForLoadState('networkidle');
      const pageOrigin = `http://127.0.0.1:${port}`;
      for (const origin of seenOrigins) {
        expect(origin, `unexpected network origin in local-static mode: ${origin}`).toBe(pageOrigin);
      }
      // No CSP header exists in this mode, so no violation can fire — this
      // is the "the artifact itself makes no disallowed request" baseline,
      // independent of CSP enforcement.
      expect(await readViolations(page)).toEqual([]);
    } finally {
      await page.close();
      server.close();
    }
  });

  test('Caddy-shaped deployment mode: real CSP enforced, zero external requests, no unsafe-eval', async ({ browser }) => {
    const caddy = await bootCandidateCaddy(candidateDir);
    try {
      const headResp = await fetch(`http://127.0.0.1:${caddy.port}/sql`);
      const csp = headResp.headers.get('content-security-policy');
      expect(csp, 'deploy/caddy/Caddyfile must set a Content-Security-Policy header').not.toBeNull();
      expect(csp).not.toMatch(/unsafe-eval/);
      expect(csp).toContain("connect-src 'self'");

      const page = await browser.newPage();
      try {
        await withViolationRecorder(page);
        const seenOrigins = new Set();
        page.on('request', (req) => { try { seenOrigins.add(new URL(req.url()).origin); } catch { /* ignore */ } });
        await page.goto(`http://127.0.0.1:${caddy.port}/sql`);
        await page.waitForLoadState('networkidle');
        const pageOrigin = `http://127.0.0.1:${caddy.port}`;
        for (const origin of seenOrigins) {
          expect(origin, `unexpected network origin under the real Caddy CSP: ${origin}`).toBe(pageOrigin);
        }
        expect(await readViolations(page), 'the deployed CSP must not be violated by the app\'s own normal load').toEqual([]);
      } finally {
        await page.close();
      }
    } finally {
      await caddy.stop();
    }
  });
});
