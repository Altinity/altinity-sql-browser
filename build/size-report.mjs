// Bundle-size report runner (issue #275).
//
// Builds the production artifact once (via build/build.mjs's shared buildArtifact,
// so the report measures the exact bytes users receive), measures raw/gzip/Brotli
// with deterministic compression, attributes the JS output to input modules and npm
// packages via the esbuild metafile, and emits a machine-readable JSON report, a
// human-readable Markdown report, and the raw esbuild metafile. Given a base report
// (`--base`), it appends absolute + percentage deltas.
//
// Usage: node build/size-report.mjs [options]
//   --out <dir>              report output directory, resolved against --root
//                             (default: bundle-report/)
//   --base <report.json>     a prior bundle-size-report.json to diff against,
//                             resolved against the invoking shell's cwd
//                             (deltas when present)
//   --root <dir>              the repository worktree to measure — becomes
//                             `repoRoot`/`absWorkingDir` for every esbuild
//                             invocation and the root every other
//                             repository-relative read resolves against
//                             (default: this script's own repository; issue
//                             #585 Phase 0 baseline/candidate comparison)
//   --entry <file>            entry point, absolute or relative to --root
//                             (default: <root>/src/main.ts)
//   --artifact-out <dir>      where the assembled dist/sql.html + sidecars are
//                             (re)written (default: <root>/dist)
//   --include-unminified-js  also measure an unminified JS build (same
//                             esbuild options, jsMinify:false only) — no
//                             unminified HTML is produced or shipped
//   --build-stamp <literal>  use this exact stamp instead of deriving one
//                             from --root's version/commit/dirty state —
//                             measurement-only, for stamp-normalized
//                             baseline/candidate comparisons; never the
//                             default for `npm run build`
//
// Reporting only — it never alters production loading semantics. metafile:true is
// pure metadata; the emitted bytes are identical to `npm run build` (when --root,
// --entry, and --build-stamp are all omitted). Issue #630 Phase 8 removes the
// former `--notices` option along with the rest of the #585 Phase 0 vendor
// candidate artifact's plumbing — see build/build.mjs's own note.

import { build } from 'esbuild';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { gzipSync, brotliCompressSync, constants } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { buildArtifact, buildStamp, esbuildOptions } from './build.mjs';
import { buildReport, diffReports, renderMarkdown, formatBytes } from './size-report-lib.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

// Deterministic compression settings so the same bytes always report the same
// sizes across machines and CI runs: gzip at max level, Brotli at max quality.
function sizes(text) {
  const buf = Buffer.from(text, 'utf8');
  return {
    raw: buf.length,
    gzip: gzipSync(buf, { level: 9 }).length,
    brotli: brotliCompressSync(buf, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length,
  };
}

function parseArgs(argv) {
  const args = {
    out: 'bundle-report',
    base: null,
    root: null,
    entry: null,
    artifactOut: null,
    includeUnminifiedJs: false,
    buildStamp: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--out') args.out = argv[++i];
    else if (a === '--base') args.base = argv[++i];
    else if (a === '--root') args.root = argv[++i];
    else if (a === '--entry') args.entry = argv[++i];
    else if (a === '--artifact-out') args.artifactOut = argv[++i];
    else if (a === '--include-unminified-js') args.includeUnminifiedJs = true;
    else if (a === '--build-stamp') args.buildStamp = argv[++i];
  }
  return args;
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

// The unminified-JS measurement (--include-unminified-js): the exact same
// esbuildOptions as the real build, changing only jsMinify to false, so the
// two builds differ in nothing but minification. Applies the same
// __ASB_BUILD__ stamp substitution as buildArtifact() so the measured bytes
// reflect what actually ships (minus minification), then reports raw UTF-8
// byte length only — no HTML is assembled and nothing is written to disk.
async function measureUnminifiedJs({ repoRoot, entryPoint, buildStampOverride }) {
  const result = await build(esbuildOptions({ repoRoot, entryPoint, jsMinify: false }));
  const stamp = await buildStamp({ repoRoot, override: buildStampOverride });
  const script = result.outputFiles[0].text.replaceAll('__ASB_BUILD__', stamp);
  return Buffer.byteLength(script, 'utf8');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = args.root ? resolve(process.cwd(), args.root) : root;
  const outDir = resolve(repoRoot, args.out);
  const artifactOutDir = args.artifactOut ? resolve(process.cwd(), args.artifactOut) : resolve(repoRoot, 'dist');

  const buildStampOverride = args.buildStamp === null ? undefined : args.buildStamp;

  const { html, script, styles, metafile } = await buildArtifact({
    repoRoot,
    entryPoint: args.entry ?? undefined,
    metafile: true,
    buildStampOverride,
  });

  // The JS output chunk is the one esbuild marks with an entryPoint; fall back to
  // the sole output if none is marked (keeps working under future config changes).
  const outputEntry = Object.entries(metafile.outputs).find(([, o]) => o.entryPoint)
    || Object.entries(metafile.outputs)[0];
  const outputKey = outputEntry[0];

  const unminifiedJsBytes = args.includeUnminifiedJs
    ? await measureUnminifiedJs({ repoRoot, entryPoint: args.entry ?? undefined, buildStampOverride })
    : undefined;

  const report = buildReport({
    metafile,
    outputKey,
    sizes: { artifact: sizes(html), js: sizes(script), css: sizes(styles) },
    unminifiedJsBytes,
  });

  const base = args.base ? await readJson(resolve(process.cwd(), args.base)) : null;
  const deltas = base ? diffReports(report, base) : null;

  await mkdir(outDir, { recursive: true });
  // Also (re)write the real artifact so `dist/sql.html` exists and its on-disk size
  // matches the report even when the report job runs without a separate build step.
  await mkdir(artifactOutDir, { recursive: true });
  await writeFile(resolve(artifactOutDir, 'sql.html'), html);
  await writeFile(resolve(outDir, 'esbuild-meta.json'), JSON.stringify(metafile, null, 2));
  await writeFile(resolve(outDir, 'bundle-size-report.json'), JSON.stringify(report, null, 2));
  await writeFile(resolve(outDir, 'bundle-size-report.md'), renderMarkdown(report, deltas));

  const a = report.artifact;
  console.log(`bundle-size report -> ${outDir}/`);
  console.log(`  dist/sql.html: ${formatBytes(a.raw)} raw, ${formatBytes(a.gzip)} gzip, ${formatBytes(a.brotli)} brotli`);
  console.log(`  JS: ${formatBytes(report.js.raw)} raw / ${formatBytes(report.js.gzip)} gzip`
    + `   CSS: ${formatBytes(report.css.raw)} raw / ${formatBytes(report.css.gzip)} gzip`);
  if (report.unminifiedJs) console.log(`  unminified JS: ${formatBytes(report.unminifiedJs.raw)} raw`);
  if (deltas) console.log(`  Δ artifact gzip vs base: ${formatBytes(deltas.artifact.gzip.abs)}`);
  else console.log('  (no base report — deltas omitted)');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
