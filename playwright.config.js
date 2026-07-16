import { defineConfig } from '@playwright/test';

// Real-browser regression tests. happy-dom (the unit layer) has no scrollbar or
// real box layout, so render-layer bugs — e.g. the editor's highlight drifting
// behind the selection when a scrollbar shrinks the textarea's client box —
// can only be caught in a real engine. These run separately from `npm test`.
//
// Setup once per machine: `npx playwright install chromium firefox webkit`.
// Run all engines: `npm run test:e2e`. One engine: `npm run test:e2e -- --project=webkit`.
export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.spec.js',
  // Serve the repo root over HTTP so the harness can import the *actual* source
  // modules (/src/**) as native ESM — no bundling, always current. The server
  // is build/e2e-serve.mjs (not a plain static server) because the tree is
  // mixed .js/.ts under ADR-0002: an imported `./x.js` whose module converted
  // to `x.ts` must be found and type-stripped, or the fixture pages 404.
  webServer: {
    command: 'node build/e2e-serve.mjs 5599',
    url: 'http://127.0.0.1:5599/tests/e2e/editor.html',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
  use: {
    baseURL: 'http://127.0.0.1:5599',
  },
  // Render-layer + DOM-API bugs are engine-specific (e.g. Firefox's
  // execCommand('insertText') on <textarea>), so the suite runs on all three
  // engines — WebKit is the Safari proxy (see README "Supported browsers").
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
    { name: 'firefox', use: { browserName: 'firefox' } },
    { name: 'webkit', use: { browserName: 'webkit' } },
  ],
});
