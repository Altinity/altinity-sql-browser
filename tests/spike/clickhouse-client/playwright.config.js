// Phase 0 / issue #585, plan §14 "Playwright configuration" and §25
// "Browser and deployment matrix". A DEDICATED Playwright config scoped to
// this directory's `browser.spec.js` only — the normal repository e2e
// config (`playwright.config.js` at the repo root, `npm run test:e2e`) is
// left completely untouched; this file is reached only via
// `npm run test:client-spike:browser` (`playwright test --config
// tests/spike/clickhouse-client/playwright.config.js`).
//
// Chromium and WebKit only — Firefox is EXPLICITLY excluded (plan §14:
// "Firefox is not a local acceptance signal in this environment and must
// not be claimed" — this sandbox's `unshare(CLONE_NEWPID)` fails with EPERM
// for Playwright's Firefox launcher, a known, already-documented local
// limitation of the normal e2e suite too; never add a `firefox` project
// here as a "convenience" — an environment where it happens to launch would
// silently start claiming a signal this plan explicitly disclaims).
//
// `webServer` boots `spike-server.mjs`, which owns the real Docker
// ClickHouse row(s) for the run (`ASB_SPIKE_BROWSER_ROWS`, default
// "current-stable-oss") via `clickhouse-containers.mjs`'s `startRow` — see
// spike-server.mjs's own header for why row selection is a request header,
// not a URL path segment. `timeout` is generous because a cold Docker pull
// in this sandbox has been observed to take up to ~2 minutes
// (`clickhouse-containers.mjs`'s own `waitForReady` default budget) before
// spike-server.mjs's `/__health` route starts answering 200.
import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');

// Single source of truth for the port: spike-server.mjs's own
// `DEFAULT_PORT` (cross-file comment, not a shared runtime import — a
// `.js` Playwright config cannot statically import spike-server.mjs's ESM
// export without spawning it, which would defeat the point of `webServer`
// spawning it as a separate process).
const PORT = Number(process.env.ASB_SPIKE_SERVER_PORT || 5680);
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: '.',
  testMatch: '**/browser.spec.js',
  timeout: 120_000,
  webServer: {
    command: 'node tests/spike/clickhouse-client/spike-server.mjs',
    // Playwright's default webServer `cwd` is this config FILE's own
    // directory, not the repository root — since this config lives under
    // tests/spike/clickhouse-client/ (unlike the repo-root e2e config this
    // one deliberately never touches), that default would double the
    // repo-relative command path above. Set explicitly rather than relying
    // on `npm run` always being invoked from repoRoot.
    cwd: repoRoot,
    url: `${BASE_URL}/__health`,
    // Deliberately ALWAYS false, unlike the repo-root e2e config's
    // `!process.env.CI` — this webServer owns a real, ephemeral Docker
    // ClickHouse container (spike-server.mjs's own `bootRows`/`shutdown`).
    // "Reusing" a previous run's server would mean reusing its container's
    // now-stale fixture credentials (`/__rows.json`).
    reuseExistingServer: false,
    timeout: 240_000,
    // WITHOUT this, Playwright's default webServer teardown is an
    // UNCONDITIONAL `SIGKILL` to the whole process group the instant the
    // run ends (verified by reading `playwright-core`'s own
    // `launchProcess()`/`gracefullyClose()`: `attemptToGracefullyClose()`
    // throws when `gracefulShutdown` is unset, and the catch falls straight
    // to `process.kill(-pid, "SIGKILL")`) — SIGKILL cannot be caught by any
    // handler, so spike-server.mjs's own `SIGTERM`/`SIGINT` cleanup (which
    // stops the real Docker container) would never run at all, leaking a
    // live container on every single run regardless of how that handler is
    // written. `timeout` here is generous because `docker rm -f` on a
    // running container has been observed to take a few real seconds under
    // this sandbox's amd64-emulated Docker runtime.
    gracefulShutdown: { signal: 'SIGTERM', timeout: 30_000 },
  },
  // Isolated Docker-contention flakes verified live in this sandbox (4
  // emulated ClickHouse containers booting simultaneously; whichever row
  // boots last, under peak load) must be retried and recorded as flaky, not
  // reported as a hard browser-matrix gate failure (issue #585 Phase 0
  // rejection root-cause fix) — `run-matrix.mjs`'s `collectBrowserFailureDetail`/
  // `classifyBrowserMatrixCell` still surface every retry as a distinct
  // 'flaky' cell with full detail, so this is a corroborated pass, never a
  // silently laundered one. `trace: 'retain-on-failure'` keeps a debuggable
  // trace for whichever attempt(s) do fail, without paying trace overhead on
  // a clean pass.
  retries: 2,
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
    { name: 'webkit', use: { browserName: 'webkit' } },
  ],
});
