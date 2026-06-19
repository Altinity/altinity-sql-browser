import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

// One vitest config for the whole runtime. Root is the repo root so the
// coverage `include` globs can name `src/**/*.js` directly.
//
// Coverage philosophy: per-file thresholds, no global
// aggregate, so one weak file can't hide a regression in another. Every
// module under src/ is pure-or-DOM and individually testable under happy-dom;
// the fetch/crypto/storage seams are injected, never imported, so they mock
// with plain stubs. We hold the whole tree at 100/100/100/100.
export default defineConfig({
  root: repoRoot,
  test: {
    environment: 'happy-dom',
    include: ['tests/unit/**/*.test.js'],
    setupFiles: ['tests/setup.js'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      reportsDirectory: resolve(repoRoot, 'coverage'),
      include: ['src/**/*.js'],
      // Every src file must hit 100% on its own (perFile) — no global
      // aggregate hiding a weak module. Code is written to avoid
      // unreachable defensive branches so 100/100/100/100 is genuine.
      thresholds: {
        perFile: true,
        '100': true,
      },
    },
  },
});
