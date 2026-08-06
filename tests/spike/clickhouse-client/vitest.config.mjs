// Phase 0 / issue #585 — dedicated Vitest config for the ClickHouse-web-client
// parity/precision spike (`docs/ADR-0005-clickhouse-web-client.md`).
//
// Deliberately separate from `tests/vitest.config.ts` (plan §8 "Spike Vitest
// configuration"): the normal config's `include` only discovers
// `tests/unit/**/*.test.{js,ts}`, so `npm test` never picks up this suite —
// the spike is not part of the coverage-gated unit tree and must not be. A
// bare `npx vitest run` from the repo root would not reliably pick up either
// config's `environment`/`include`, so every spike script names this file
// explicitly via `--config` (`npm run test:client-spike`).
//
// - `environment: 'node'` — the spike drives real `fetch`/Docker/Playwright
//   processes, not DOM rendering (unlike the happy-dom unit suite).
// - No `coverage` block — this is validation/evidence infrastructure, not
//   part of the per-file 100/95/90/100 coverage gate CLAUDE.md hard rule 1
//   applies to `src/**`.
// - `singleThread: true` (Vitest 4 top-level option, `poolOptions.threads.*`
//   having been flattened) — deterministic network coordination against the
//   fault server and any live ClickHouse container; parallel workers would
//   race port allocation and container lifecycle.
import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');

export default defineConfig({
  root: repoRoot,
  test: {
    environment: 'node',
    include: ['tests/spike/clickhouse-client/**/*.test.ts'],
    // Explicitly exclude the normal unit tree and this file's own directory's
    // non-test helpers — belt-and-suspenders alongside the `include` glob.
    exclude: ['tests/unit/**', 'node_modules/**'],
    globals: false,
    pool: 'threads',
    singleThread: true,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
