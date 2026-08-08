// Issue #630 Phase 8 (plan §14) — the deterministic ISOLATED-PACKAGE proof:
// build the package, pack it with real `npm pack`, install the tarball into
// a fixture OUTSIDE this repository, import it as ESM, and compile a
// TypeScript consumer against its declarations — proving resolution never
// falls back into this repository's source (A17's own definition of done).
// Run via `npm run test:pack` (which builds first). Every step below is a
// REAL runnable check, not prose: this file is what
// `docs/clickhouse-http-repository-extraction.md` documents as "tested".
//
// No root build/**, root tsconfig, root tests, or root source import — this
// script is entirely package-local, exactly as a mechanically extracted copy
// of packages/clickhouse-http/ would need it to be (#639).

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, rm, writeFile, readdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, sep } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, '..');
const distDir = join(packageRoot, 'dist');

const failures = [];
function assert(condition, message) {
  if (!condition) failures.push(message);
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

// Recursively list every file under `dir`, relative to `dir`, forward-slash
// separated — used both for the extracted tarball inventory and the
// installed-package containment check.
async function listFilesRelative(dir) {
  const out = [];
  async function walk(sub) {
    for (const entry of await readdir(join(dir, sub), { withFileTypes: true })) {
      const rel = sub ? `${sub}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(rel);
      else out.push(rel.split(sep).join('/'));
    }
  }
  await walk('');
  return out;
}

// ── §14.1 — build prerequisites ─────────────────────────────────────────────

function checkBuildPrerequisites() {
  for (const required of ['dist/index.js', 'dist/index.d.ts', 'README.md', 'LICENSE']) {
    assert(existsSync(join(packageRoot, required)), `build prerequisite missing: ${required}`);
  }
  const pkg = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
  assert(pkg.main === './dist/index.js', `package.json main must target dist, got ${pkg.main}`);
  assert(pkg.types === './dist/index.d.ts', `package.json types must target dist, got ${pkg.types}`);
  const exp = pkg.exports?.['.'];
  assert(exp && exp.types === './dist/index.d.ts', 'exports["."].types must target dist/index.d.ts');
  assert(exp && exp.import === './dist/index.js', 'exports["."].import must target dist/index.js');
  assert(exp && exp.default === './dist/index.js', 'exports["."].default must target dist/index.js');
  assert(Object.keys(pkg.exports ?? {}).length === 1, 'package.json exports must expose exactly one entry, "."');
}

// ── §14.2 — real npm pack ────────────────────────────────────────────────────

async function runNpmPack(packDestination) {
  const output = execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', packDestination], {
    cwd: packageRoot,
    encoding: 'utf8',
  });
  const [entry] = JSON.parse(output);
  return join(packDestination, entry.filename);
}

// ── §14.3 — tarball inventory ────────────────────────────────────────────────

async function extractTarball(tarballPath, extractDir) {
  await mkdir(extractDir, { recursive: true });
  execFileSync('tar', ['-xzf', tarballPath, '-C', extractDir]);
  // npm packs everything under a top-level "package/" directory.
  return join(extractDir, 'package');
}

async function checkTarballInventory(packageDir) {
  const files = await listFilesRelative(packageDir);

  for (const required of ['package.json', 'README.md', 'LICENSE', 'dist/index.js', 'dist/index.d.ts']) {
    assert(files.includes(required), `tarball missing required file: ${required}`);
  }

  const forbiddenPrefixes = ['src/', 'test/', 'coverage/'];
  const forbiddenExact = ['build.mjs'];
  for (const file of files) {
    if (forbiddenExact.includes(file)) failures.push(`tarball must not contain: ${file}`);
    if (forbiddenPrefixes.some((p) => file.startsWith(p))) failures.push(`tarball must not contain: ${file}`);
    if (/^tsconfig.*\.json$/.test(file)) failures.push(`tarball must not contain: ${file}`);
    if (/^vitest\.config\./.test(file)) failures.push(`tarball must not contain: ${file}`);
    if (file.startsWith('dist/')) {
      assert(/\.(js|d\.ts)$/.test(file), `tarball dist/** payload must be only .js/.d.ts, found: ${file}`);
    } else {
      assert(['package.json', 'README.md', 'LICENSE'].includes(file), `unexpected tarball top-level file: ${file}`);
    }
  }
  // No SQL Browser src/** and no parent/workspace path can appear — the
  // extracted directory tree itself proves this: every listed path is
  // relative to the tarball's own package/ root, so an escape would need a
  // literal path SEGMENT naming it, which the prefix checks above already
  // cover for src/ specifically; nothing here can spell a parent path at
  // all, since tar extraction cannot produce a `../` entry name.

  const pkg = await readJson(join(packageDir, 'package.json'));
  assert(Object.keys(pkg.exports ?? {}).length === 1 && pkg.exports['.'], 'packed manifest must expose only "."');
  assert(Object.keys(pkg.dependencies ?? {}).length === 0, 'packed manifest must carry no runtime dependency map');
  assert(pkg.main === './dist/index.js', 'packed manifest main must target dist/index.js');
  assert(pkg.types === './dist/index.d.ts', 'packed manifest types must target dist/index.d.ts');
}

// ── §14.4 — isolated install ─────────────────────────────────────────────────

async function installIsolated(fixtureDir, tarballPath) {
  await mkdir(fixtureDir, { recursive: true });
  await writeFile(join(fixtureDir, 'package.json'), JSON.stringify({ private: true, type: 'module' }, null, 2));
  execFileSync('npm', [
    'install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--no-package-lock', '--no-save',
    tarballPath,
  ], {
    cwd: fixtureDir,
    env: { ...process.env, NODE_PATH: '' },
  });
  const installedDir = join(fixtureDir, 'node_modules/@altinity/clickhouse-http');
  assert(existsSync(installedDir), 'installed package directory missing');
  const installedFiles = existsSync(installedDir) ? await listFilesRelative(installedDir) : [];
  assert(
    !installedFiles.some((f) => f.startsWith('src/') || f === 'src'),
    'installed package must contain no src/',
  );
  return installedDir;
}

// ── §14.5 — ESM proof ────────────────────────────────────────────────────────

async function writeConsumerEsm(fixtureDir) {
  await writeFile(join(fixtureDir, 'consumer.mjs'), `
import { chUrl, createClickHouseHttpClient, parseClickHouseType } from '@altinity/clickhouse-http';
if (typeof chUrl !== 'function') throw new Error('chUrl did not import as a function');
if (typeof createClickHouseHttpClient !== 'function') throw new Error('createClickHouseHttpClient did not import as a function');
if (typeof parseClickHouseType !== 'function') throw new Error('parseClickHouseType did not import as a function');
const resolved = import.meta.resolve('@altinity/clickhouse-http');
console.log('RESOLVED:' + resolved);
console.log('OK');
`.trimStart());
}

async function runConsumerEsm(fixtureDir) {
  const output = execFileSync(process.execPath, ['consumer.mjs'], { cwd: fixtureDir, encoding: 'utf8' });
  assert(output.includes('OK'), `consumer.mjs did not report OK, got: ${output}`);
  const resolvedLine = output.split('\n').find((l) => l.startsWith('RESOLVED:'));
  const resolvedPath = resolvedLine ? resolvedLine.slice('RESOLVED:'.length).trim() : '';
  const resolvedFsPath = resolvedPath.startsWith('file://') ? fileURLToPath(resolvedPath) : resolvedPath;
  const expected = join(fixtureDir, 'node_modules/@altinity/clickhouse-http/dist/index.js');
  assert(resolvedFsPath === expected, `import.meta.resolve must terminate at ${expected}, got ${resolvedFsPath}`);
  assert(!resolvedFsPath.includes(`${sep}src${sep}`), 'runtime resolution must never reach package src/**');
  assert(!resolvedFsPath.startsWith(packageRoot), 'runtime resolution must never reach this repository at all');
}

// ── §14.6 — TypeScript declaration proof ────────────────────────────────────

async function writeConsumerTs(fixtureDir) {
  await writeFile(join(fixtureDir, 'consumer.ts'), `
import { chUrl, createClickHouseHttpClient, parseClickHouseType } from '@altinity/clickhouse-http';
import type { ClickHouseHttpClient, TypeNode } from '@altinity/clickhouse-http';
export function useIt(client: ClickHouseHttpClient, node: TypeNode): string {
  void client;
  void node;
  return chUrl('https://example') + typeof createClickHouseHttpClient + typeof parseClickHouseType;
}
`.trimStart());
  await writeFile(join(fixtureDir, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      noEmit: true,
      lib: ['ES2022', 'DOM', 'DOM.Iterable'],
      strict: true,
      skipLibCheck: false,
    },
    include: ['consumer.ts'],
  }, null, 2));
}

function resolveTscBinary() {
  const require = createRequire(import.meta.url);
  const typescriptPkgJson = require.resolve('typescript/package.json');
  return join(dirname(typescriptPkgJson), 'bin/tsc');
}

async function runConsumerTs(fixtureDir) {
  const tscBin = resolveTscBinary();
  let output;
  let threw = false;
  try {
    output = execFileSync(process.execPath, [tscBin, '-p', 'tsconfig.json', '--traceResolution'], {
      cwd: fixtureDir,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (e) {
    threw = true;
    output = `${e.stdout ?? ''}${e.stderr ?? ''}`;
  }
  assert(!threw, `tsc failed to compile the isolated consumer:\n${output.slice(-4000)}`);

  const expectedDts = join(fixtureDir, 'node_modules/@altinity/clickhouse-http/dist/index.d.ts');
  const lines = output.split('\n');
  const moduleLines = lines.filter((l) => l.includes('@altinity/clickhouse-http'));
  assert(moduleLines.length > 0, 'expected --traceResolution output to mention @altinity/clickhouse-http at all');

  const resolvedLines = moduleLines.filter((l) => /Resolution for module/.test(l) || l.includes("'") && l.includes('.d.ts'));
  const foundExpected = lines.some((l) => l.includes(expectedDts));
  assert(foundExpected, `--traceResolution must terminate at ${expectedDts}`);

  const forbiddenPackageSrc = join(packageRoot, 'src');
  const forbiddenRepoSrc = resolve(packageRoot, '../../src');
  assert(
    !lines.some((l) => l.includes(forbiddenPackageSrc) && l.includes('@altinity/clickhouse-http')),
    'type resolution must never reach packages/clickhouse-http/src/**',
  );
  assert(
    !lines.some((l) => l.includes(forbiddenRepoSrc) && l.includes('@altinity/clickhouse-http')),
    'type resolution must never reach the SQL Browser repository src/**',
  );
  void resolvedLines; // retained for future stricter assertions if needed
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  checkBuildPrerequisites();

  const packDestination = await mkdtemp(join(tmpdir(), 'asb-clickhouse-http-pack-'));
  const extractDir = await mkdtemp(join(tmpdir(), 'asb-clickhouse-http-extract-'));
  const fixtureDir = await mkdtemp(join(tmpdir(), 'asb-clickhouse-http-consumer-'));

  try {
    const tarballPath = await runNpmPack(packDestination);
    const extractedPackageDir = await extractTarball(tarballPath, extractDir);
    await checkTarballInventory(extractedPackageDir);

    await installIsolated(fixtureDir, tarballPath);
    await writeConsumerEsm(fixtureDir);
    await runConsumerEsm(fixtureDir);
    await writeConsumerTs(fixtureDir);
    await runConsumerTs(fixtureDir);
  } finally {
    await rm(packDestination, { recursive: true, force: true });
    await rm(extractDir, { recursive: true, force: true });
    await rm(fixtureDir, { recursive: true, force: true });
  }

  if (failures.length) {
    console.error('isolated-package: FAIL');
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log('isolated-package: OK — packed, installed outside the workspace, imported as ESM, and typechecked with no source fallback.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
