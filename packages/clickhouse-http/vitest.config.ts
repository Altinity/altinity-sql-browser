import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

// Package-local unit/coverage ownership (#630 Phase 8, plan §8): the package
// is its own coverage root now, exercising the public barrel (src/index.ts)
// the same way an external consumer would, rather than deep-importing
// private modules. Same per-file thresholds as the root suite so the package
// carries the repository's normal coverage discipline into an eventual
// extraction (#639) unchanged.
export default defineConfig({
  root: here,
  test: {
    environment: 'node',
    include: ['test/unit/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      reportsDirectory: resolve(here, 'coverage'),
      include: ['src/**/*.ts'],
      thresholds: {
        perFile: true,
        statements: 100,
        functions: 95,
        branches: 90,
        lines: 100,
      },
    },
  },
});
