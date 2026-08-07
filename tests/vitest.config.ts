import { defineConfig, type Plugin } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

// ADR-0002 mixed-tree resolver shim, nearly retired (#267). TypeScript,
// esbuild, and Node all resolve an explicit `./x.js` specifier to `x.ts` when
// only the `.ts` file exists; Vite only does that swap when the IMPORTER is
// itself TS. Every runtime module and almost every unit test is TypeScript
// now — the shim survives solely for the two node-tooling specs that stay .js
// (schema-build.test.js, spec-examples.test.js: typing them needs @types/node,
// a deliberate global-types decision deferred to a follow-up) and imports of
// src/*.ts from them. Delete this plugin when those two convert.
const jsToTsInMixedTree: Plugin = {
  name: 'adr-0002-js-to-ts-mixed-tree',
  enforce: 'pre',
  resolveId(source, importer) {
    if (!importer || !/^\.\.?\//.test(source) || !source.endsWith('.js')) return null;
    const target = resolve(dirname(importer), source);
    if (existsSync(target)) return null;
    const ts = target.slice(0, -3) + '.ts';
    return existsSync(ts) ? ts : null;
  },
};

// One vitest config for the whole runtime. Root is the repo root so the
// coverage `include` globs can name `src/**/*.js` directly.
//
// Coverage philosophy: per-file thresholds, no global
// aggregate, so one weak file can't hide a regression in another. Every
// module under src/ is pure-or-DOM and individually testable under happy-dom;
// the fetch/crypto/storage seams are injected, never imported, so they mock
// with plain stubs. Per-file floors are 100 statements/lines, 95 functions,
// and 90 branches; most modules maintain 100/100/100/100 in practice.
export default defineConfig({
  root: repoRoot,
  plugins: [jsToTsInMixedTree],
  test: {
    environment: 'happy-dom',
    include: ['tests/unit/**/*.test.{js,ts}'],
    setupFiles: ['tests/setup.ts'],
    // Run workers as threads, not child processes. The `forks` pool fans out
    // to child *node processes* via
    // tinypool; on normal exit those should be reaped, but a detached swarm can
    // survive a run and pile up across runs until it pins the machine. Threads
    // live inside the single vitest process, so they die with the parent and
    // can never become orphaned OS processes. The suite is pure ES modules +
    // happy-dom (no native deps), so threads are safe. Cap parallelism so one
    // run can't peg every core.
    pool: 'threads',
    maxWorkers: 4,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      reportsDirectory: resolve(repoRoot, 'coverage'),
      include: ['src/**/*.{js,ts}', 'packages/clickhouse-http/src/**/*.ts'],
      // Type-only seam interface files (ADR-0002 phase 0 / #262) have no
      // executable statements — nothing to cover, like src/generated/.
      exclude: ['src/generated/*.js', 'src/**/*.types.ts'],
      // Per-file (no global aggregate hiding a weak module). The pure/network/
      // state/DOM and render layers generally maintain 100/100/100/100; the
      // enforced floors below are deliberately explicit for the whole tree.
      // Per-file floors: statements/lines stay at 100; functions ≥95; branches
      // ≥90 (v8's branch counter is strict and platform-sensitive). Most
      // modules exceed these floors, while browser-glue branches/functions are
      // not padded for the autostart path tests intentionally exclude.
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
