// Package-local runtime-JS build for @altinity/clickhouse-http (#630 Phase
// 8, plan §4.1/§7). Produces unbundled, browser-first ESM: every module under
// src/**/*.ts compiles independently (bundle: false) into dist/**/*.js,
// mirroring the source tree exactly (outbase: src, outdir: dist) — root
// esbuild (build/build.mjs) remains the ONE place that bundles/tree-shakes
// the final SQL Browser artifact; this script's job is only to make the
// package's own public surface independently resolvable as real files on
// disk, the shape an extracted/published package would ship.
//
// TypeScript declaration emission is a SEPARATE step (package.json's "build"
// script runs `tsc -p ./tsconfig.build.json` right after this), so this file
// never touches .d.ts output — see tsconfig.build.json.
//
// No root build/**, root tsconfig, root tests, or root source import: this
// script is entirely package-local, exactly as a mechanically extracted copy
// of packages/clickhouse-http/ would need it to be (#639).

import { build } from 'esbuild';
import { readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = resolve(here, 'src');
const outDir = resolve(here, 'dist');

// Enumerate every source module explicitly (bundle: false requires one entry
// point per module — esbuild does not itself recurse a whole directory as a
// single "compile everything" input) rather than relying on any implicit
// discovery.
async function collectSourceFiles(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) out.push(...await collectSourceFiles(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

async function main() {
  await rm(outDir, { recursive: true, force: true });

  const entryPoints = await collectSourceFiles(srcDir);
  if (entryPoints.length === 0) {
    throw new Error('@altinity/clickhouse-http build: no source files found under src/**');
  }

  await build({
    entryPoints,
    bundle: false,
    platform: 'browser',
    format: 'esm',
    target: 'es2020',
    outbase: srcDir,
    outdir: outDir,
    minify: false,
    logLevel: 'info',
  });

  const indexOutput = resolve(outDir, 'index.js');
  if (!existsSync(indexOutput)) {
    throw new Error(`@altinity/clickhouse-http build: expected ${indexOutput} to exist after build`);
  }
  console.log(`@altinity/clickhouse-http: built ${entryPoints.length} module(s) -> dist/`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
