import { defineConfig, type Plugin } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

// ADR-0002 mixed-tree resolver shim. TypeScript, esbuild, and Node all resolve
// an explicit `./x.js` specifier to `x.ts` when only the `.ts` file exists —
// which is what keeps importers untouched as modules convert leaf-up. Vite's
// resolver, however, only tries the `.js`→`.ts` swap when the *importer* is
// itself a TS file (`isFromTsImporter`), so a still-unconverted `.js` module or
// test importing a converted `.ts` module fails to resolve under vitest alone.
// This plugin fills exactly that gap: relative `.js` specifier, target `.js`
// missing, sibling `.ts` present → resolve to the `.ts` file. No effect on the
// production build (esbuild already does this natively).
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
// with plain stubs. We hold the whole tree at 100/100/100/100.
export default defineConfig({
  root: repoRoot,
  plugins: [jsToTsInMixedTree],
  test: {
    environment: 'happy-dom',
    include: ['tests/unit/**/*.test.js'],
    setupFiles: ['tests/setup.js'],
    // Run workers as threads, not child processes. Vitest 2.x defaults to
    // `pool: 'forks'`, which fans out to (cpus-1) child *node processes* via
    // tinypool; on normal exit those should be reaped, but a detached swarm can
    // survive a run and pile up across runs until it pins the machine. Threads
    // live inside the single vitest process, so they die with the parent and
    // can never become orphaned OS processes. The suite is pure ES modules +
    // happy-dom (no native deps), so threads are safe. Cap parallelism so one
    // run can't peg every core.
    pool: 'threads',
    poolOptions: { threads: { maxThreads: 4, minThreads: 1 } },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      reportsDirectory: resolve(repoRoot, 'coverage'),
      include: ['src/**/*.{js,ts}'],
      // Type-only seam interface files (ADR-0002 phase 0 / #262) have no
      // executable statements — nothing to cover, like src/generated/.
      exclude: ['src/generated/*.js', 'src/**/*.types.ts'],
      // Every src file must hit 100% on its own (perFile) — no global
      // aggregate hiding a weak module. Code is written to avoid
      // unreachable defensive branches so 100/100/100/100 is genuine.
      // Per-file (no global aggregate hiding a weak module). The pure/network/
      // state/DOM and render layers are written to hit 100/100/100/100. The
      // ui/app.js controller is the browser glue — a few branches/functions are
      // only exercised by the real autostart path (excluded from tests), so it
      // is held at a 90%+ floor for now rather than padding tests artificially.
      // Per-file floors. The pure/network/state/DOM and render layers sit at
      // 100; the ui/app.js controller glue brings the floor down (a few of its
      // branches/functions are only hit by the real browser autostart path,
      // which tests exclude). statements/lines stay at 100; functions ≥95;
      // branches ≥90 (v8's branch counter is strict and platform-sensitive).
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
