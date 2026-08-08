import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, '..', '..');

// Issue #630 Phase 8 (plan §15) — this package's own first-party Chromium/
// WebKit regression suite over the BUILT public barrel: `server.mjs` serves
// this directory's `harness.html` and the package's generated `dist/**` —
// never source, never a vendor client, never Docker/live ClickHouse. Run via
// `npm run test:browser` (which builds first) — or, from the repository
// root, `npm run test:clickhouse-http:browser`.
export default defineConfig({
  testDir: here,
  testMatch: '**/*.spec.js',
  webServer: {
    command: `node ${resolve(here, 'server.mjs')} 5601`,
    url: 'http://127.0.0.1:5601/harness.html',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
    cwd: packageRoot,
  },
  use: {
    baseURL: 'http://127.0.0.1:5601',
  },
  // No Docker, no live ClickHouse, no vendor client — deterministic local
  // Node HTTP fixtures only (fault-server.mjs). Chromium and WebKit are this
  // suite's acceptance engines, matching the issue's own requirement; no
  // Firefox project (Firefox cannot launch locally in this repository's
  // sandbox, and root CI already supplies Firefox coverage for the SQL
  // Browser suite — this package suite's own acceptance is Chromium+WebKit
  // by design, not by omission).
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
    { name: 'webkit', use: { browserName: 'webkit' } },
  ],
});
